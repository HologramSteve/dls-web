// Accounts and cloud project storage (web-only addition). Transport-agnostic like rooms.ts: server/api.ts maps HTTP
// requests onto it, tests drive it directly. Users, sessions and the project index live in memory and are persisted
// through an AccountStore; project contents are loaded from the store on demand.
//
// - Passwords: scrypt with a per-user salt. Sessions: random bearer tokens, only their SHA-256 is kept.
// - Projects are the save files of one project folder (the same format as rooms and project export).
import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { IsValidProjectFilePath } from "../src/collab/Protocol";
import {
	CloudNameKey,
	type CloudProject,
	type CloudProjectInfo,
	type CloudUser,
	IsValidCloudProjectName,
	MaxPasswordLength,
	MinPasswordLength,
	UsernamePattern,
} from "../src/cloud/CloudProtocol";

export interface StoredUser {
	id: string;
	username: string;
	pw: string; // "scrypt$<salt hex>$<hash hex>"
	created: number;
	projects: Record<string, CloudProjectInfo>; // by CloudNameKey
}

export interface StoredSession {
	uid: string;
	created: number;
	lastUsed: number;
}

export interface AccountData {
	users: StoredUser[];
	sessions: Record<string, StoredSession>; // by SHA-256 of the token
}

export interface AccountStore {
	load(): AccountData;
	save(data: AccountData): void;
	loadProject(uid: string, key: string): CloudProject | null;
	saveProject(uid: string, key: string, project: CloudProject): void;
	removeProject(uid: string, key: string): void;
	removeUser(uid: string): void;
}

export interface AccountLimits {
	maxUsers: number;
	maxProjectsPerUser: number;
	maxBytesPerUser: number;
	maxProjectBytes: number;
	maxFileBytes: number;
	maxFilesPerProject: number;
	sessionTtlMs: number;
	maxFailedLogins: number; // per username and per IP, within failureWindowMs
	maxRegistrations: number; // per IP, within failureWindowMs
	failureWindowMs: number;
}

export const DefaultAccountLimits: AccountLimits = {
	maxUsers: 100_000,
	maxProjectsPerUser: 200,
	maxBytesPerUser: 256 * 1024 * 1024,
	maxProjectBytes: 64 * 1024 * 1024,
	maxFileBytes: 4 * 1024 * 1024,
	maxFilesPerProject: 5000,
	sessionTtlMs: 180 * 24 * 3600 * 1000,
	maxFailedLogins: 10,
	maxRegistrations: 5,
	failureWindowMs: 15 * 60 * 1000,
};

// Result of an operation: ok, or an HTTP-like status with a message for the user
export type Result<T> = { ok: true; value: T } | { ok: false; status: number; error: string };
const Ok = <T>(value: T): Result<T> => ({ ok: true, value });
const Fail = <T = never>(status: number, error: string): Result<T> => ({ ok: false, status, error });

const ScryptParams = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function Scrypt(password: string, salt: Buffer): Promise<Buffer> {
	return new Promise((resolve, reject) => scrypt(password.normalize("NFKC"), salt, 32, ScryptParams, (err, key) => (err ? reject(err) : resolve(key))));
}

export async function HashPassword(password: string): Promise<string> {
	const salt = randomBytes(16);
	return `scrypt$${salt.toString("hex")}$${(await Scrypt(password, salt)).toString("hex")}`;
}

export async function VerifyPassword(password: string, stored: string): Promise<boolean> {
	const [kind, salt, hash] = stored.split("$");
	if (kind !== "scrypt" || !salt || !hash) return false;
	const expected = Buffer.from(hash, "hex");
	const actual = await Scrypt(password, Buffer.from(salt, "hex"));
	return actual.length === expected.length && timingSafeEqual(actual, expected);
}

const TokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

// A password check that always costs the same, for unknown usernames (no timing hint that a name exists)
const DummyHash = HashPassword("not a real password");

class FailureCounter {
	private readonly hits = new Map<string, number[]>();
	constructor(
		private readonly max: number,
		private readonly windowMs: number,
		private readonly now: () => number,
	) {}

	Blocked(key: string): boolean {
		return this.Recent(key).length >= this.max;
	}

	Add(key: string) {
		const list = this.Recent(key);
		list.push(this.now());
		this.hits.set(key, list);
		if (this.hits.size > 50_000) this.hits.clear(); // (memory bound; only throttling is lost)
	}

	Clear(key: string) {
		this.hits.delete(key);
	}

	private Recent(key: string): number[] {
		const cutoff = this.now() - this.windowMs;
		return (this.hits.get(key) ?? []).filter((t) => t > cutoff);
	}
}

export class AccountManager {
	private readonly users = new Map<string, StoredUser>(); // by id
	private readonly byName = new Map<string, StoredUser>(); // by lower-case username
	private sessions: Record<string, StoredSession> = {};
	private dirty = false;
	private readonly loginFailures: FailureCounter;
	private readonly registrations: FailureCounter;

	constructor(
		private readonly store: AccountStore | null = null,
		private readonly limits: AccountLimits = DefaultAccountLimits,
		private readonly now: () => number = Date.now,
	) {
		this.loginFailures = new FailureCounter(limits.maxFailedLogins, limits.failureWindowMs, now);
		this.registrations = new FailureCounter(limits.maxRegistrations, limits.failureWindowMs, now);
		const data = store?.load() ?? { users: [], sessions: {} };
		for (const u of data.users) {
			this.users.set(u.id, u);
			this.byName.set(u.username.toLowerCase(), u);
		}
		this.sessions = data.sessions;
		this.Sweep();
	}

	// Persist users/sessions/project index if they changed
	Flush() {
		if (!this.dirty) return;
		this.dirty = false;
		this.store?.save({ users: Array.from(this.users.values()), sessions: this.sessions });
	}

	// Remove expired sessions
	Sweep() {
		const cutoff = this.now() - this.limits.sessionTtlMs;
		for (const [k, s] of Object.entries(this.sessions)) {
			if (s.lastUsed < cutoff || !this.users.has(s.uid)) {
				delete this.sessions[k];
				this.dirty = true;
			}
		}
	}

	// ---- Accounts ----
	async Register(username: unknown, password: unknown, ip: string): Promise<Result<{ token: string; user: CloudUser }>> {
		if (typeof username !== "string" || !UsernamePattern.test(username)) return Fail(400, "Usernames are 3–24 letters, digits, '.', '_' or '-'.");
		const pwError = PasswordError(password);
		if (pwError) return Fail(400, pwError);
		if (this.registrations.Blocked(ip)) return Fail(429, "Too many new accounts from your address; try again later.");
		if (this.users.size >= this.limits.maxUsers) return Fail(503, "This server doesn't accept new accounts.");
		if (this.byName.has(username.toLowerCase())) return Fail(409, "That username is taken.");
		const pw = await HashPassword(password as string);
		if (this.byName.has(username.toLowerCase())) return Fail(409, "That username is taken."); // (taken while hashing)
		const user: StoredUser = { id: randomBytes(9).toString("base64url"), username, pw, created: this.now(), projects: {} };
		this.users.set(user.id, user);
		this.byName.set(username.toLowerCase(), user);
		this.registrations.Add(ip);
		this.dirty = true;
		return Ok({ token: this.NewSession(user), user: PublicUser(user) });
	}

	async Login(username: unknown, password: unknown, ip: string): Promise<Result<{ token: string; user: CloudUser }>> {
		if (typeof username !== "string" || typeof password !== "string" || password.length > MaxPasswordLength) return Fail(400, "Enter a username and password.");
		const nameKey = "u:" + username.toLowerCase();
		if (this.loginFailures.Blocked(nameKey) || this.loginFailures.Blocked("ip:" + ip)) return Fail(429, "Too many failed attempts; try again in a few minutes.");
		const user = this.byName.get(username.toLowerCase());
		let valid = false;
		if (user) valid = await VerifyPassword(password, user.pw);
		else await VerifyPassword(password, await DummyHash);
		if (!user || !valid) {
			this.loginFailures.Add(nameKey);
			this.loginFailures.Add("ip:" + ip);
			return Fail(401, "Wrong username or password.");
		}
		this.loginFailures.Clear(nameKey);
		return Ok({ token: this.NewSession(user), user: PublicUser(user) });
	}

	Logout(token: string) {
		const key = TokenHash(token);
		if (this.sessions[key]) {
			delete this.sessions[key];
			this.dirty = true;
		}
	}

	// The user a session token belongs to (null if invalid or expired)
	Authenticate(token: string | null | undefined): StoredUser | null {
		if (!token || token.length > 128) return null;
		const session = this.sessions[TokenHash(token)];
		if (!session) return null;
		const t = this.now();
		if (session.lastUsed < t - this.limits.sessionTtlMs) return null;
		const user = this.users.get(session.uid) ?? null;
		if (user && t - session.lastUsed > 3600 * 1000) {
			session.lastUsed = t;
			this.dirty = true;
		}
		return user;
	}

	async ChangePassword(user: StoredUser, oldPassword: unknown, newPassword: unknown, keepToken: string): Promise<Result<null>> {
		if (typeof oldPassword !== "string" || !(await VerifyPassword(oldPassword, user.pw))) return Fail(403, "The current password is wrong.");
		const pwError = PasswordError(newPassword);
		if (pwError) return Fail(400, pwError);
		user.pw = await HashPassword(newPassword as string);
		// Sign out everywhere else
		const keep = TokenHash(keepToken);
		for (const [k, s] of Object.entries(this.sessions)) if (s.uid === user.id && k !== keep) delete this.sessions[k];
		this.dirty = true;
		return Ok(null);
	}

	async DeleteAccount(user: StoredUser, password: unknown): Promise<Result<null>> {
		if (typeof password !== "string" || !(await VerifyPassword(password, user.pw))) return Fail(403, "The password is wrong.");
		this.users.delete(user.id);
		this.byName.delete(user.username.toLowerCase());
		for (const [k, s] of Object.entries(this.sessions)) if (s.uid === user.id) delete this.sessions[k];
		this.store?.removeUser(user.id);
		this.dirty = true;
		return Ok(null);
	}

	private NewSession(user: StoredUser): string {
		const token = randomBytes(32).toString("base64url");
		const t = this.now();
		this.sessions[TokenHash(token)] = { uid: user.id, created: t, lastUsed: t };
		this.dirty = true;
		return token;
	}

	// ---- Cloud projects ----
	ListProjects(user: StoredUser): CloudProjectInfo[] {
		return Object.values(user.projects).sort((a, b) => b.updated - a.updated);
	}

	GetProject(user: StoredUser, name: string): Result<CloudProject> {
		const key = CloudNameKey(name);
		if (!user.projects[key]) return Fail(404, "No such project.");
		const project = this.store?.loadProject(user.id, key) ?? null;
		if (!project) return Fail(404, "No such project.");
		return Ok({ ...project, ...user.projects[key] });
	}

	// Upload a project. `base` is the version the client last had: if the cloud has moved on since (another device
	// uploaded), the upload is refused with 409 unless `force` is set. A new project needs base 0 (or none).
	PutProject(user: StoredUser, name: unknown, files: unknown, base: unknown, force: boolean): Result<CloudProjectInfo> {
		if (!IsValidCloudProjectName(name)) return Fail(400, "Invalid project name.");
		if (files == null || typeof files !== "object" || Array.isArray(files)) return Fail(400, "Missing files.");
		const entries = Object.entries(files as Record<string, unknown>);
		if (entries.length > this.limits.maxFilesPerProject) return Fail(413, "Too many files in the project.");
		let bytes = 0;
		const clean: Record<string, string> = {};
		for (const [path, content] of entries) {
			if (!IsValidProjectFilePath(path) || typeof content !== "string") return Fail(400, "Invalid file: " + path.substring(0, 100));
			if (content.length > this.limits.maxFileBytes) return Fail(413, "File too large: " + path.substring(0, 100));
			bytes += content.length;
			clean[path] = content;
		}
		if (!("ProjectDescription.json" in clean)) return Fail(400, "Missing ProjectDescription.json.");
		if (bytes > this.limits.maxProjectBytes) return Fail(413, "The project is too large.");

		const key = CloudNameKey(name);
		const existing = user.projects[key];
		if (existing && !force && base !== existing.version) return Fail(409, "The cloud copy changed since you last synced.");
		if (!existing && Object.keys(user.projects).length >= this.limits.maxProjectsPerUser) return Fail(413, `You can store at most ${this.limits.maxProjectsPerUser} projects.`);
		let used = bytes;
		for (const [k, p] of Object.entries(user.projects)) if (k !== key) used += p.bytes;
		if (used > this.limits.maxBytesPerUser) return Fail(413, "Your cloud storage is full.");

		const info: CloudProjectInfo = { name, version: (existing?.version ?? 0) + 1, updated: Math.max(this.now(), (existing?.updated ?? 0) + 1), bytes };
		this.store?.saveProject(user.id, key, { ...info, files: clean });
		user.projects[key] = info;
		this.dirty = true;
		return Ok(info);
	}

	DeleteProject(user: StoredUser, name: string): Result<null> {
		const key = CloudNameKey(name);
		if (!user.projects[key]) return Fail(404, "No such project.");
		delete user.projects[key];
		this.store?.removeProject(user.id, key);
		this.dirty = true;
		return Ok(null);
	}
}

function PasswordError(password: unknown): string | null {
	if (typeof password !== "string" || password.length < MinPasswordLength) return `Passwords need at least ${MinPasswordLength} characters.`;
	if (password.length > MaxPasswordLength) return "That password is too long.";
	return null;
}

export const PublicUser = (u: StoredUser): CloudUser => ({ id: u.id, username: u.username });

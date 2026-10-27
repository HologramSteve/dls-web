import { describe, expect, it } from "vitest";
import type { CloudProject } from "../src/cloud/CloudProtocol";
import type { ServerMsg } from "../src/collab/Protocol";
import { type AccountData, AccountManager, type AccountStore, DefaultAccountLimits, HashPassword, VerifyPassword } from "../server/accounts";
import { HandleApi } from "../server/api";
import { FeaturesFromEnv } from "../server/config";
import { RoomManager } from "../server/rooms";

class MemoryStore implements AccountStore {
	data: AccountData = { users: [], sessions: {} };
	projects = new Map<string, CloudProject>();
	load = () => JSON.parse(JSON.stringify(this.data));
	save = (d: AccountData) => void (this.data = JSON.parse(JSON.stringify(d)));
	loadProject = (uid: string, key: string) => this.projects.get(uid + "/" + key) ?? null;
	saveProject = (uid: string, key: string, p: CloudProject) => void this.projects.set(uid + "/" + key, p);
	removeProject = (uid: string, key: string) => void this.projects.delete(uid + "/" + key);
	removeUser = (uid: string) => {
		for (const k of Array.from(this.projects.keys())) if (k.startsWith(uid + "/")) this.projects.delete(k);
	};
}

const Files = (name = "P", extra = "{}") => ({
	"ProjectDescription.json": JSON.stringify({ ProjectName: name }),
	"Chips/AND.json": extra,
});

async function SignedIn(m: AccountManager, name = "alice") {
	const r = await m.Register(name, "correct horse", "1.1.1.1");
	if (!r.ok) throw new Error(r.error);
	return { token: r.value.token, user: m.Authenticate(r.value.token)! };
}

describe("feature flags", () => {
	it("are all on by default; APP_ONLY turns everything off", () => {
		expect(FeaturesFromEnv({})).toEqual({ collab: true, accounts: true, registration: true });
		expect(FeaturesFromEnv({ APP_ONLY: "1" })).toEqual({ collab: false, accounts: false, registration: false });
		expect(FeaturesFromEnv({ APP_ONLY: "true", DISABLE_COLLAB: "0" }).collab).toBe(false);
		expect(FeaturesFromEnv({ DISABLE_COLLAB: "1" })).toEqual({ collab: false, accounts: true, registration: true });
		expect(FeaturesFromEnv({ DISABLE_ACCOUNTS: "yes" })).toEqual({ collab: true, accounts: false, registration: false });
		expect(FeaturesFromEnv({ REGISTRATION: "closed" })).toEqual({ collab: true, accounts: true, registration: false });
	});
});

describe("accounts", () => {
	it("hashes passwords with a salt", async () => {
		const a = await HashPassword("secret password");
		const b = await HashPassword("secret password");
		expect(a).not.toBe(b);
		expect(await VerifyPassword("secret password", a)).toBe(true);
		expect(await VerifyPassword("secret passwore", a)).toBe(false);
		expect(await VerifyPassword("x", "garbage")).toBe(false);
	});

	it("registers, logs in and out, and persists users and sessions", async () => {
		const store = new MemoryStore();
		const m = new AccountManager(store);
		expect((await m.Register("a", "correct horse", "ip")).ok).toBe(false); // too short
		expect((await m.Register("alice", "short", "ip")).ok).toBe(false);
		const { token, user } = await SignedIn(m);
		expect(user.username).toBe("alice");
		const dup = await m.Register("ALICE", "correct horse", "ip");
		expect(dup.ok || dup.status).toBe(409);

		const bad = await m.Login("alice", "wrong password", "ip");
		expect(bad.ok || bad.status).toBe(401);
		const unknown = await m.Login("nobody", "wrong password", "ip");
		expect(unknown.ok || unknown.status).toBe(401);
		const good = await m.Login("Alice", "correct horse", "ip");
		expect(good.ok).toBe(true);

		m.Flush();
		expect(JSON.stringify(store.data)).not.toContain(token); // only token hashes are stored
		const m2 = new AccountManager(store);
		expect(m2.Authenticate(token)?.username).toBe("alice");
		m2.Logout(token);
		expect(m2.Authenticate(token)).toBeNull();
		expect(m2.Authenticate("nonsense")).toBeNull();
	});

	it("throttles failed logins and expires sessions", async () => {
		let now = 1_000_000;
		const m = new AccountManager(null, { ...DefaultAccountLimits, maxFailedLogins: 3, sessionTtlMs: 1000 }, () => now);
		const { token } = await SignedIn(m);
		for (let i = 0; i < 3; i++) await m.Login("alice", "wrong password", "ip" + i);
		const blocked = await m.Login("alice", "correct horse", "ip9");
		expect(blocked.ok || blocked.status).toBe(429);
		now += DefaultAccountLimits.failureWindowMs + 1;
		expect(m.Authenticate(token)).toBeNull(); // (expired too)
		expect((await m.Login("alice", "correct horse", "ip9")).ok).toBe(true);
	});

	it("changes the password (signing out other sessions) and deletes the account", async () => {
		const store = new MemoryStore();
		const m = new AccountManager(store);
		const { token, user } = await SignedIn(m);
		const other = await m.Login("alice", "correct horse", "ip");
		if (!other.ok) throw new Error();
		expect((await m.ChangePassword(user, "nope", "new password!", token)).ok).toBe(false);
		expect((await m.ChangePassword(user, "correct horse", "new password!", token)).ok).toBe(true);
		expect(m.Authenticate(token)).not.toBeNull();
		expect(m.Authenticate(other.value.token)).toBeNull();
		expect((await m.Login("alice", "new password!", "ip")).ok).toBe(true);

		m.PutProject(user, "P", Files(), 0, false);
		expect((await m.DeleteAccount(user, "wrong")).ok).toBe(false);
		expect((await m.DeleteAccount(user, "new password!")).ok).toBe(true);
		expect(m.Authenticate(token)).toBeNull();
		expect(store.projects.size).toBe(0);
		expect((await m.Register("alice", "correct horse", "ip")).ok).toBe(true); // name is free again
	});
});

describe("cloud projects", () => {
	it("stores, versions, lists and deletes projects; detects conflicting uploads", async () => {
		const m = new AccountManager(new MemoryStore());
		const { user } = await SignedIn(m);
		const v1 = m.PutProject(user, "My CPU", Files("My CPU"), 0, false);
		expect(v1.ok && v1.value.version).toBe(1);
		// Device A uploads on top of v1
		const v2 = m.PutProject(user, "My CPU", Files("My CPU", '{"a":1}'), 1, false);
		expect(v2.ok && v2.value.version).toBe(2);
		// Device B still has v1: refused
		const stale = m.PutProject(user, "my cpu", Files("My CPU", '{"b":1}'), 1, false);
		expect(stale.ok || stale.status).toBe(409);
		// ... unless forced
		const forced = m.PutProject(user, "my cpu", Files("My CPU", '{"b":1}'), 1, true);
		expect(forced.ok && forced.value.version).toBe(3);

		const got = m.GetProject(user, "MY CPU");
		expect(got.ok && got.value.files["Chips/AND.json"]).toBe('{"b":1}');
		expect(m.ListProjects(user).map((p) => p.version)).toEqual([3]);

		// Another user doesn't see it
		const bob = await SignedIn(m, "bob");
		expect(m.ListProjects(bob.user)).toEqual([]);
		expect(m.GetProject(bob.user, "My CPU").ok).toBe(false);

		expect(m.DeleteProject(user, "My CPU").ok).toBe(true);
		expect(m.ListProjects(user)).toEqual([]);
		expect(m.DeleteProject(user, "My CPU").ok).toBe(false);
	});

	it("validates names, files and quotas", async () => {
		const m = new AccountManager(new MemoryStore(), { ...DefaultAccountLimits, maxProjectsPerUser: 2, maxBytesPerUser: 300 });
		const { user } = await SignedIn(m);
		for (const name of ["", "a/b", "a.b", "..", "CON", "x".repeat(65)]) expect(m.PutProject(user, name, Files(), 0, false).ok).toBe(false);
		expect(m.PutProject(user, "P", { "../evil.json": "{}" }, 0, false).ok).toBe(false);
		expect(m.PutProject(user, "P", { "Chips/AND.json": "{}" }, 0, false).ok).toBe(false); // no description
		expect(m.PutProject(user, "P", { "ProjectDescription.json": 5 }, 0, false).ok).toBe(false);
		expect(m.PutProject(user, "P", Files(), 0, false).ok).toBe(true);
		expect(m.PutProject(user, "Q", Files(), 0, false).ok).toBe(true);
		const third = m.PutProject(user, "R", Files(), 0, false);
		expect(third.ok || third.status).toBe(413);
		const big = m.PutProject(user, "P", Files("P", "x".repeat(400)), 1, false);
		expect(big.ok || big.status).toBe(413);
	});
});

describe("accounts HTTP API", () => {
	const features = FeaturesFromEnv({});
	const call = async (m: AccountManager, method: string, path: string, body?: unknown, token?: string, f = features) => {
		const headers: Record<string, string> = {};
		if (token) headers.Authorization = "Bearer " + token;
		const res = await HandleApi(new Request("http://x/api/" + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), "ip", m, f);
		return { status: res.status, body: await res.json() };
	};

	it("covers the sign-in and project round trip", async () => {
		const m = new AccountManager(new MemoryStore());
		expect((await call(m, "GET", "projects")).status).toBe(401);
		const reg = await call(m, "POST", "auth/register", { username: "alice", password: "correct horse" });
		expect(reg.status).toBe(200);
		const token = reg.body.token as string;
		expect((await call(m, "GET", "auth/me", undefined, token)).body.user.username).toBe("alice");

		const put = await call(m, "PUT", "projects/" + encodeURIComponent("My CPU"), { files: Files("My CPU") }, token);
		expect(put.body).toMatchObject({ name: "My CPU", version: 1 });
		const conflict = await call(m, "PUT", "projects/My%20CPU", { files: Files("My CPU"), base: 0 }, token);
		expect(conflict.status).toBe(409);
		expect((await call(m, "GET", "projects", undefined, token)).body.projects).toHaveLength(1);
		expect((await call(m, "GET", "projects/My%20CPU", undefined, token)).body.files).toEqual(Files("My CPU"));
		expect((await call(m, "DELETE", "projects/My%20CPU", undefined, token)).status).toBe(200);
		expect((await call(m, "GET", "projects/My%20CPU", undefined, token)).status).toBe(404);

		expect((await call(m, "POST", "auth/logout", undefined, token)).status).toBe(200);
		expect((await call(m, "GET", "auth/me", undefined, token)).status).toBe(401);
		expect((await call(m, "POST", "auth/login", { username: "alice", password: "correct horse" })).status).toBe(200);
		expect((await call(m, "POST", "auth/register", { username: "bob", password: "correct horse" }, undefined, { ...features, registration: false })).status).toBe(403);
	});
});

describe("collab identity with accounts", () => {
	it("rooms made before signing in move to the account, which is the same user in every browser", async () => {
		const accounts = new AccountManager(new MemoryStore());
		const { token, user } = await SignedIn(accounts);
		const rooms = new RoomManager();
		rooms.AccountOf = (t) => accounts.Authenticate(t)?.id ?? null;
		const Connect = (key: string, tok?: string) => {
			const received: ServerMsg[] = [];
			const conn = rooms.Connect((msg) => received.push(msg));
			rooms.Handle(conn, { t: "hello", v: 1, userKey: key.padEnd(20, "x"), name: "A", color: "#123456", token: tok });
			return { conn, received };
		};
		// Anonymous in browser 1: create a room
		const anon = Connect("browser-one");
		rooms.Handle(anon.conn, { t: "create", name: "R", files: Files() });
		const code = (anon.received.find((x) => x.t === "joined") as Extract<ServerMsg, { t: "joined" }>).room.code;
		rooms.Handle(anon.conn, { t: "leave" });
		const anonUid = anon.conn.uid;

		// Signed in, browser 1: the room is now the account's
		const signed = Connect("browser-one", token);
		expect(signed.conn.uid).not.toBe(anonUid);
		expect(rooms.rooms.get(code)!.data.owner).toBe(signed.conn.uid);
		// Signed in, browser 2: same user
		const other = Connect("browser-two", token);
		expect(other.conn.uid).toBe(signed.conn.uid);
		// Invalid token: browser identity
		const bogus = Connect("browser-two", "not-a-token");
		expect(bogus.conn.uid).not.toBe(signed.conn.uid);
		expect(user.id).toBeTruthy();
	});
});

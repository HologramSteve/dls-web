// Accounts and cloud storage of projects (web-only addition, not in the original). See docs/accounts.md.
// - Sign in / create an account on the central server (server/api.ts); the session token is kept in localStorage.
// - A local project can be linked to the cloud: every file the save system writes in it marks it changed, and it is
//   uploaded a moment later (the whole project folder, like an export). Other devices download it, or pull newer
//   versions automatically while it is not open there.
// - Versions: each upload says which cloud version it is based on. If another device uploaded in between, the upload
//   is refused and the project is in conflict until the user picks "keep mine" or "use the cloud copy".
import { Main } from "../dls/game/Main";
import { Project } from "../dls/game/Project";
import { MenuType, UIDrawer } from "../dls/graphics/ui/UIDrawer";
import { FileSystem, PathCombine } from "../dls/saveSystem/FileSystem";
import { SavePaths } from "../dls/saveSystem/SavePaths";
import { Loader } from "../dls/saveSystem/Saver";
import { IsValidProjectFilePath, ProjectFile } from "../collab/Protocol";
import { ServerHttpBase } from "../web/Features";
import { CloudNameKey, type CloudProject, type CloudProjectInfo, type CloudUser } from "./CloudProtocol";

const TokenStorage = "dls-cloud-token";
const UserStorage = "dls-cloud-user";
const LinksStorage = "dls-cloud-links:"; // + user id
const UploadDelayMs = 1500;
const RetryDelayMs = 15000;
const SyncIntervalMs = 60000;

// A local project that syncs with the cloud
interface Link {
	name: string; // local folder name (= cloud name)
	version: number; // cloud version the local copy is based on (0: never uploaded)
	dirty: boolean; // local changes not uploaded yet
}

export type ProjectSyncState = "synced" | "pending" | "uploading" | "conflict" | "cloud-only" | "local-only" | "update";

export class ApiError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

function LocalStore(): Storage | null {
	try {
		return window.localStorage;
	} catch {
		return null;
	}
}

export function CloudApiUrl(path: string): string {
	const env = (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_API_URL;
	const base = new URLSearchParams(location.search).get("api") ?? env ?? ServerHttpBase() + "/api";
	return base.replace(/\/$/, "") + "/" + path;
}

// The name of the project open in the editor (null on the main menu)
function OpenProjectName(): string | null {
	if (UIDrawer.ActiveMenu === MenuType.MainMenu || !Project.ActiveProject) return null;
	return Project.ActiveProject.description.ProjectName;
}

export function IsProjectOpen(name: string): boolean {
	const open = OpenProjectName();
	return open != null && CloudNameKey(open) === CloudNameKey(name);
}

export function LocalProjectNames(): string[] {
	return FileSystem.EnumerateDirectories(SavePaths.ProjectsPath).filter((name) => Loader.ProjectExists(name));
}

// The project's save files, relative to its folder
export function ReadProjectFiles(name: string): Record<string, string> {
	const root = SavePaths.GetProjectPath(name) + "/";
	const files: Record<string, string> = {};
	for (const path of FileSystem.GetFilesRecursive(SavePaths.GetProjectPath(name))) {
		const rel = path.substring(root.length);
		if (IsValidProjectFilePath(rel)) files[rel] = FileSystem.ReadAllText(path);
	}
	return files;
}

class CloudSession {
	user: CloudUser | null = null;
	projects: CloudProjectInfo[] = [];
	lastError = "";
	busy = false; // an account request is running (sign in, ...)
	private token: string | null = null;
	private links: Record<string, Link> = {};
	private readonly conflicts = new Set<string>();
	private readonly uploading = new Set<string>();
	private readonly changedWhileUploading = new Set<string>();
	private uploadTimer: ReturnType<typeof setTimeout> | null = null;
	private writingFiles = false;
	private readonly listeners = new Set<() => void>();
	// Called when the signed-in account changes (live collaboration reconnects as the account)
	onAccountChange: (() => void) | null = null;

	get Token(): string | null {
		return this.token;
	}

	Subscribe(fn: () => void): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	private Changed() {
		for (const fn of this.listeners) fn();
	}

	Init() {
		const ls = LocalStore();
		this.token = ls?.getItem(TokenStorage) ?? null;
		try {
			this.user = this.token ? JSON.parse(ls?.getItem(UserStorage) ?? "null") : null;
		} catch {
			this.user = null;
		}
		if (this.user) this.LoadLinks();
		FileSystem.AddChangeListener((path) => this.OnLocalFileChange(path));
		if (this.token) {
			// Check the session is still valid, then catch up
			this.Request<{ user: CloudUser }>("GET", "auth/me").then(
				(r) => {
					this.SetUser(r.user, this.token!);
					void this.SyncAll();
				},
				(e) => this.Report(e),
			);
		}
		setInterval(() => this.user && void this.SyncAll(), SyncIntervalMs);
		window.addEventListener("focus", () => this.user && void this.SyncAll());
	}

	// ---- Account ----
	async Register(username: string, password: string) {
		await this.SignIn("auth/register", username, password);
	}

	async Login(username: string, password: string) {
		await this.SignIn("auth/login", username, password);
	}

	private async SignIn(path: string, username: string, password: string) {
		this.busy = true;
		this.lastError = "";
		this.Changed();
		try {
			const r = await this.Request<{ token: string; user: CloudUser }>("POST", path, { username, password }, false);
			this.SetUser(r.user, r.token);
			this.onAccountChange?.();
			await this.SyncAll();
		} catch (e) {
			this.Report(e);
		} finally {
			this.busy = false;
			this.Changed();
		}
	}

	async Logout() {
		if (this.token) await this.Request("POST", "auth/logout").catch(() => {});
		this.ClearUser();
		this.onAccountChange?.();
	}

	async ChangePassword(oldPassword: string, newPassword: string): Promise<boolean> {
		return this.AccountAction("auth/password", { old: oldPassword, new: newPassword });
	}

	async DeleteAccount(password: string): Promise<boolean> {
		const ok = await this.AccountAction("auth/delete", { password });
		if (ok) {
			LocalStore()?.removeItem(LinksStorage + this.user?.id);
			this.ClearUser();
			this.onAccountChange?.();
		}
		return ok;
	}

	private async AccountAction(path: string, body: unknown): Promise<boolean> {
		this.lastError = "";
		try {
			await this.Request("POST", path, body);
			return true;
		} catch (e) {
			this.Report(e);
			return false;
		} finally {
			this.Changed();
		}
	}

	private SetUser(user: CloudUser, token: string) {
		const changedUser = this.user?.id !== user.id;
		this.user = user;
		this.token = token;
		const ls = LocalStore();
		ls?.setItem(TokenStorage, token);
		ls?.setItem(UserStorage, JSON.stringify(user));
		if (changedUser) {
			this.conflicts.clear();
			this.LoadLinks();
		}
		this.Changed();
	}

	private ClearUser() {
		this.user = null;
		this.token = null;
		this.projects = [];
		this.links = {};
		this.conflicts.clear();
		const ls = LocalStore();
		ls?.removeItem(TokenStorage);
		ls?.removeItem(UserStorage);
		this.Changed();
	}

	// ---- Links (per account, per browser) ----
	private LoadLinks() {
		try {
			this.links = JSON.parse(LocalStore()?.getItem(LinksStorage + this.user!.id) ?? "{}");
		} catch {
			this.links = {};
		}
	}

	private SaveLinks() {
		if (this.user) LocalStore()?.setItem(LinksStorage + this.user.id, JSON.stringify(this.links));
	}

	IsLinked(name: string): boolean {
		return this.links[CloudNameKey(name)] != null;
	}

	StateOf(name: string): ProjectSyncState {
		const key = CloudNameKey(name);
		const link = this.links[key];
		const cloud = this.projects.find((p) => CloudNameKey(p.name) === key);
		if (!link) return Loader.ProjectExists(name) ? "local-only" : "cloud-only";
		if (this.conflicts.has(key)) return "conflict";
		if (this.uploading.has(key)) return "uploading";
		if (link.dirty) return "pending";
		if (cloud && cloud.version > link.version) return "update";
		return "synced";
	}

	// ---- Local changes ----
	private OnLocalFileChange(path: string) {
		if (this.writingFiles || !this.user) return;
		const m = /^Projects\/([^/]+)\//.exec(path);
		if (!m) return;
		const key = CloudNameKey(m[1]);
		const link = this.links[key];
		if (!link) {
			if (path.endsWith("/" + ProjectFile)) this.Changed(); // (a project was created, renamed or deleted: the panel lists it)
			return;
		}
		if (this.uploading.has(key)) this.changedWhileUploading.add(key);
		if (!link.dirty) {
			link.dirty = true;
			this.SaveLinks();
			this.Changed();
		}
		this.ScheduleUpload(UploadDelayMs);
	}

	private ScheduleUpload(delay: number) {
		if (this.uploadTimer) clearTimeout(this.uploadTimer);
		this.uploadTimer = setTimeout(() => {
			this.uploadTimer = null;
			void this.UploadDirty();
		}, delay);
	}

	private async UploadDirty() {
		for (const link of Object.values(this.links)) if (link.dirty) await this.Upload(link.name);
	}

	// Start syncing a local project: it is uploaded now and after every save
	async Link(name: string) {
		if (!this.user) return;
		const key = CloudNameKey(name);
		const cloud = this.projects.find((p) => CloudNameKey(p.name) === key);
		if (cloud && !confirm(`"${cloud.name}" is already in your cloud storage. Replace it with this device's copy?`)) return;
		this.links[key] = { name, version: cloud?.version ?? 0, dirty: true };
		this.SaveLinks();
		await this.Upload(name);
	}

	// Stop syncing (both copies stay)
	Unlink(name: string) {
		const key = CloudNameKey(name);
		delete this.links[key];
		this.conflicts.delete(key);
		this.SaveLinks();
		this.Changed();
	}

	private async Upload(name: string, force = false) {
		const key = CloudNameKey(name);
		const link = this.links[key];
		if (!link || !this.user || this.uploading.has(key)) return;
		if (this.conflicts.has(key) && !force) return;
		if (!Loader.ProjectExists(link.name)) {
			// Deleted or renamed on this device: stop syncing it (the cloud copy stays)
			this.Unlink(link.name);
			return;
		}
		this.uploading.add(key);
		this.changedWhileUploading.delete(key);
		this.Changed();
		try {
			const info = await this.Request<CloudProjectInfo>("PUT", "projects/" + encodeURIComponent(link.name), { files: ReadProjectFiles(link.name), base: link.version, force });
			link.version = info.version;
			link.dirty = this.changedWhileUploading.has(key);
			this.conflicts.delete(key);
			this.SetCloudInfo(info);
			this.lastError = "";
		} catch (e) {
			if (e instanceof ApiError && e.status === 409) this.conflicts.add(key);
			else {
				this.Report(e);
				if (!(e instanceof ApiError)) this.ScheduleUpload(RetryDelayMs); // (offline: try again later)
			}
		} finally {
			this.uploading.delete(key);
			this.SaveLinks();
			this.Changed();
			if (link.dirty && !this.conflicts.has(key) && this.links[key] === link) this.ScheduleUpload(UploadDelayMs);
		}
	}

	private SetCloudInfo(info: CloudProjectInfo) {
		const key = CloudNameKey(info.name);
		this.projects = [info, ...this.projects.filter((p) => CloudNameKey(p.name) !== key)].sort((a, b) => b.updated - a.updated);
	}

	// ---- Cloud → local ----
	async Refresh() {
		if (!this.user) return;
		try {
			this.projects = (await this.Request<{ projects: CloudProjectInfo[] }>("GET", "projects")).projects;
		} catch (e) {
			this.Report(e);
		}
		this.Changed();
	}

	// Bring linked projects up to date both ways (on sign-in, focus and every minute)
	async SyncAll() {
		await this.Refresh();
		if (!this.user) return;
		for (const link of Object.values(this.links)) {
			const key = CloudNameKey(link.name);
			const cloud = this.projects.find((p) => CloudNameKey(p.name) === key);
			if (!Loader.ProjectExists(link.name)) this.Unlink(link.name);
			else if (!cloud) {
				// Deleted from the cloud (on another device): stop syncing. Never uploaded yet: upload.
				if (link.version > 0) this.Unlink(link.name);
				else await this.Upload(link.name);
			} else if (cloud.version > link.version) {
				if (link.dirty) {
					this.conflicts.add(key);
					this.Changed();
				} else if (!IsProjectOpen(link.name)) await this.Download(cloud.name, false);
			} else if (link.dirty) await this.Upload(link.name);
		}
	}

	// Download a cloud project into the local projects (replacing a local project of the same name) and link it
	async Download(name: string, ask = true): Promise<boolean> {
		if (IsProjectOpen(name)) {
			this.lastError = `Close "${name}" first (go back to the main menu).`;
			this.Changed();
			return false;
		}
		if (ask && Loader.ProjectExists(name) && !this.IsLinked(name) && !confirm(`Replace the project "${name}" on this device with the cloud copy?`)) return false;
		let project: CloudProject;
		try {
			project = await this.Request<CloudProject>("GET", "projects/" + encodeURIComponent(name));
		} catch (e) {
			this.Report(e);
			this.Changed();
			return false;
		}
		if (IsProjectOpen(name)) return false; // (opened meanwhile)
		// Keep the local folder name if it differs only in case
		const local = LocalProjectNames().find((n) => CloudNameKey(n) === CloudNameKey(project.name)) ?? project.name;
		this.writingFiles = true;
		try {
			const dir = SavePaths.GetProjectPath(local);
			FileSystem.DeleteDirectory(dir);
			for (const [rel, content] of Object.entries(project.files)) {
				if (!IsValidProjectFilePath(rel)) continue;
				FileSystem.WriteAllText(PathCombine(dir, rel), rel === ProjectFile ? WithProjectName(content, local) : content);
			}
		} finally {
			this.writingFiles = false;
		}
		const key = CloudNameKey(local);
		this.links[key] = { name: local, version: project.version, dirty: false };
		this.conflicts.delete(key);
		this.SetCloudInfo(project);
		this.SaveLinks();
		this.lastError = "";
		this.Changed();
		return true;
	}

	// Download and open (from the main menu)
	async Open(name: string) {
		if (!(await this.Download(name))) return;
		if (UIDrawer.ActiveMenu === MenuType.MainMenu) {
			const local = LocalProjectNames().find((n) => CloudNameKey(n) === CloudNameKey(name));
			if (local) Main.CreateOrLoadProject(local, "");
		}
	}

	// Conflict: keep this device's copy (overwrite the cloud) or take the cloud's (discard local changes)
	async ResolveConflict(name: string, keep: "mine" | "cloud") {
		const key = CloudNameKey(name);
		if (keep === "mine") {
			this.conflicts.delete(key);
			await this.Upload(name, true);
		} else {
			const link = this.links[key];
			if (link) link.dirty = false;
			if (!(await this.Download(name, false)) && link) link.dirty = true;
		}
	}

	async DeleteFromCloud(name: string) {
		try {
			await this.Request("DELETE", "projects/" + encodeURIComponent(name));
			this.projects = this.projects.filter((p) => CloudNameKey(p.name) !== CloudNameKey(name));
			if (this.IsLinked(name)) this.Unlink(name);
		} catch (e) {
			this.Report(e);
		}
		this.Changed();
	}

	// ---- HTTP ----
	private async Request<T>(method: string, path: string, body?: unknown, auth = true): Promise<T> {
		const headers: Record<string, string> = {};
		if (body !== undefined) headers["Content-Type"] = "application/json";
		if (auth && this.token) headers.Authorization = "Bearer " + this.token;
		let res: Response;
		try {
			res = await fetch(CloudApiUrl(path), { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
		} catch {
			throw new Error("Can't reach the server.");
		}
		let data: { error?: string } = {};
		try {
			data = await res.json();
		} catch {
			/* not JSON */
		}
		if (!res.ok) {
			if (res.status === 401 && auth && this.user) {
				// Session expired or revoked
				this.ClearUser();
				this.onAccountChange?.();
				throw new ApiError(401, "You were signed out; please sign in again.");
			}
			throw new ApiError(res.status, data.error ?? `Server error (${res.status}).`);
		}
		return data as T;
	}

	private Report(e: unknown) {
		this.lastError = (e as Error).message ?? String(e);
		this.Changed();
	}
}

// The project description stores the project's name: keep it equal to the folder name
function WithProjectName(json: string, name: string): string {
	try {
		const desc = JSON.parse(json);
		if (desc.ProjectName === name) return json;
		desc.ProjectName = name;
		return JSON.stringify(desc, null, 2);
	} catch {
		return json;
	}
}

export const Cloud = new CloudSession();

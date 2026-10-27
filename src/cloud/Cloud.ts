// Accounts and cloud storage of projects (web-only addition, not in the original). See docs/accounts.md.
// - Sign in / create an account on the central server (server/api.ts); the session token is kept in localStorage.
// - A local project can be linked to the cloud: every file the save system writes in it marks it changed, and it is
//   uploaded a moment later (the whole project folder, like an export). Other devices download it, or pull newer
//   versions automatically while it is not open there.
// - Versions: each upload says which cloud version it is based on. If another device uploaded in between, the upload
//   is refused and the project is in conflict until the user picks "keep mine" or "use the cloud copy".
// - Collaborators: an owner can share a cloud project with other users. It is downloaded into its own local folder,
//   "<name> (<owner>)". Editors sync it like their own projects; for viewers it is read-only and only downloaded.
import { Main } from "../dls/game/Main";
import { Project } from "../dls/game/Project";
import { MenuType, UIDrawer } from "../dls/graphics/ui/UIDrawer";
import { FileSystem, PathCombine } from "../dls/saveSystem/FileSystem";
import { SavePaths } from "../dls/saveSystem/SavePaths";
import { Loader } from "../dls/saveSystem/Saver";
import { CollabState } from "../collab/CollabState";
import { IsValidProjectFilePath, ProjectFile } from "../collab/Protocol";
import { ServerHttpBase } from "../web/Features";
import { CloudNameKey, type CloudProject, type CloudProjectInfo, type CloudUser, type CollaboratorRole, type ProjectList, type ProjectRole } from "./CloudProtocol";

const TokenStorage = "dls-cloud-token";
const UserStorage = "dls-cloud-user";
const LinksStorage = "dls-cloud-links:"; // + user id
const UploadDelayMs = 1500;
const RetryDelayMs = 15000;
const SyncIntervalMs = 60000;

// A local project that syncs with a cloud project
interface Link {
	name: string; // local folder name
	cloud: string; // cloud project name
	owner: string; // cloud project owner's username
	role: ProjectRole;
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
	projects: CloudProjectInfo[] = []; // own
	shared: CloudProjectInfo[] = []; // others', shared with the user
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
		// Projects shared as viewer can't be edited (same switch as a viewer in a live collaboration room)
		CollabState.CloudReadOnly = () => this.IsOpenProjectViewOnly();
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
		this.shared = [];
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
		for (const link of Object.values(this.links)) {
			// (links from before collaborators: always the user's own project, same name)
			link.cloud ??= link.name;
			link.owner ??= this.user!.username;
			link.role ??= "owner";
		}
	}

	private SaveLinks() {
		if (this.user) LocalStore()?.setItem(LinksStorage + this.user.id, JSON.stringify(this.links));
	}

	IsOwn(info: CloudProjectInfo): boolean {
		return info.role === "owner";
	}

	// Local folder of a cloud project: its name for the user's own projects, "<name> (<owner>)" for shared ones
	LocalNameFor(info: CloudProjectInfo): string {
		const link = this.LinkFor(info);
		if (link) return link.name;
		if (this.IsOwn(info)) return info.name;
		return `${info.name} (${info.owner.replace(/\./g, "_")})`;
	}

	LinkFor(info: CloudProjectInfo): Link | null {
		const owner = info.owner.toLowerCase();
		const key = CloudNameKey(info.name);
		return Object.values(this.links).find((l) => l.owner.toLowerCase() === owner && CloudNameKey(l.cloud) === key) ?? null;
	}

	private InfoFor(link: Link): CloudProjectInfo | null {
		const owner = link.owner.toLowerCase();
		const key = CloudNameKey(link.cloud);
		return [...this.projects, ...this.shared].find((p) => p.owner.toLowerCase() === owner && CloudNameKey(p.name) === key) ?? null;
	}

	IsLinked(localName: string): boolean {
		return this.links[CloudNameKey(localName)] != null;
	}

	// Sync state of a cloud project (on this device)
	StateOf(info: CloudProjectInfo): ProjectSyncState {
		const link = this.LinkFor(info);
		if (!link) return "cloud-only";
		const key = CloudNameKey(link.name);
		if (this.conflicts.has(key)) return "conflict";
		if (this.uploading.has(key)) return "uploading";
		if (link.dirty) return "pending";
		if (info.version > link.version) return "update";
		return "synced";
	}

	StateOfLocal(localName: string): ProjectSyncState {
		const link = this.links[CloudNameKey(localName)];
		const info = link ? this.InfoFor(link) : null;
		return info ? this.StateOf(info) : "local-only";
	}

	// Local projects that aren't in the cloud (nor would be replaced by downloading one of the user's own)
	LocalOnlyProjects(): string[] {
		const own = new Set(this.projects.map((p) => CloudNameKey(p.name)));
		return LocalProjectNames().filter((n) => !this.IsLinked(n) && !own.has(CloudNameKey(n)));
	}

	IsOpenProjectViewOnly(): boolean {
		const open = OpenProjectName();
		return open != null && this.user != null && this.links[CloudNameKey(open)]?.role === "viewer";
	}

	// ---- Local changes ----
	private OnLocalFileChange(path: string) {
		if (this.writingFiles || !this.user) return;
		const m = /^Projects\/([^/]+)\//.exec(path);
		if (!m) return;
		const key = CloudNameKey(m[1]);
		const link = this.links[key];
		if (!link || link.role === "viewer") {
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

	// Start syncing one of the user's local projects: it is uploaded now and after every save
	async Link(name: string) {
		if (!this.user) return;
		const key = CloudNameKey(name);
		const cloud = this.projects.find((p) => CloudNameKey(p.name) === key);
		if (cloud && !confirm(`"${cloud.name}" is already in your cloud storage. Replace it with this device's copy?`)) return;
		this.links[key] = { name, cloud: name, owner: this.user.username, role: "owner", version: cloud?.version ?? 0, dirty: true };
		this.SaveLinks();
		await this.Upload(name, cloud != null);
	}

	// Stop syncing (both copies stay)
	Unlink(localName: string) {
		const key = CloudNameKey(localName);
		delete this.links[key];
		this.conflicts.delete(key);
		this.SaveLinks();
		this.Changed();
	}

	private ProjectPath(cloudName: string, owner: string): string {
		const own = this.user != null && owner.toLowerCase() === this.user.username.toLowerCase();
		return "projects/" + encodeURIComponent(cloudName) + (own ? "" : "?owner=" + encodeURIComponent(owner));
	}

	private async Upload(localName: string, force = false) {
		const key = CloudNameKey(localName);
		const link = this.links[key];
		if (!link || !this.user || this.uploading.has(key) || link.role === "viewer") return;
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
			const files = ReadProjectFiles(link.name);
			if (link.name !== link.cloud) files[ProjectFile] = WithProjectName(files[ProjectFile], link.cloud);
			const info = await this.Request<CloudProjectInfo>("PUT", this.ProjectPath(link.cloud, link.owner), { files, base: link.version, force });
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
				else if (e.status === 403 || e.status === 404) void this.SyncAll(); // (no longer an editor: the list says what changed)
			}
		} finally {
			this.uploading.delete(key);
			this.SaveLinks();
			this.Changed();
			if (link.dirty && !this.conflicts.has(key) && this.links[key] === link) this.ScheduleUpload(UploadDelayMs);
		}
	}

	private SetCloudInfo(info: CloudProjectInfo) {
		const same = (p: CloudProjectInfo) => p.owner.toLowerCase() === info.owner.toLowerCase() && CloudNameKey(p.name) === CloudNameKey(info.name);
		const byTime = (a: CloudProjectInfo, b: CloudProjectInfo) => b.updated - a.updated;
		if (this.IsOwn(info)) this.projects = [info, ...this.projects.filter((p) => !same(p))].sort(byTime);
		else this.shared = [info, ...this.shared.filter((p) => !same(p))].sort(byTime);
	}

	// ---- Cloud → local ----
	async Refresh() {
		if (!this.user) return;
		try {
			const list = await this.Request<ProjectList>("GET", "projects");
			this.projects = list.projects;
			this.shared = list.shared;
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
			const cloud = this.InfoFor(link);
			if (cloud && cloud.role !== link.role) {
				// (the owner changed this user's role)
				link.role = cloud.role;
				if (link.role === "viewer") link.dirty = false;
				this.SaveLinks();
			}
			if (!Loader.ProjectExists(link.name)) this.Unlink(link.name);
			else if (!cloud) {
				// Deleted from the cloud, or no longer shared with the user: stop syncing (the local copy stays).
				// Never uploaded yet: upload.
				if (link.version > 0 || link.role !== "owner") this.Unlink(link.name);
				else await this.Upload(link.name);
			} else if (cloud.version > link.version) {
				if (link.dirty) {
					this.conflicts.add(key);
					this.Changed();
				} else if (!IsProjectOpen(link.name)) await this.Download(cloud, false);
			} else if (link.dirty) await this.Upload(link.name);
		}
	}

	// Download a cloud project into its local folder (replacing a local project of the same name) and link it
	async Download(info: CloudProjectInfo, ask = true): Promise<boolean> {
		const local = this.LocalNameFor(info);
		if (IsProjectOpen(local)) {
			this.lastError = `Close "${local}" first (go back to the main menu).`;
			this.Changed();
			return false;
		}
		if (ask && Loader.ProjectExists(local) && !this.IsLinked(local) && !confirm(`Replace the project "${local}" on this device with the cloud copy?`)) return false;
		let project: CloudProject;
		try {
			project = await this.Request<CloudProject>("GET", this.ProjectPath(info.name, info.owner));
		} catch (e) {
			this.Report(e);
			this.Changed();
			return false;
		}
		if (IsProjectOpen(local)) return false; // (opened meanwhile)
		// Keep the local folder name if it differs only in case
		const folder = LocalProjectNames().find((n) => CloudNameKey(n) === CloudNameKey(local)) ?? local;
		this.writingFiles = true;
		try {
			const dir = SavePaths.GetProjectPath(folder);
			FileSystem.DeleteDirectory(dir);
			for (const [rel, content] of Object.entries(project.files)) {
				if (!IsValidProjectFilePath(rel)) continue;
				FileSystem.WriteAllText(PathCombine(dir, rel), rel === ProjectFile ? WithProjectName(content, folder) : content);
			}
		} finally {
			this.writingFiles = false;
		}
		const key = CloudNameKey(folder);
		this.links[key] = { name: folder, cloud: project.name, owner: project.owner, role: project.role, version: project.version, dirty: false };
		this.conflicts.delete(key);
		this.SetCloudInfo({ ...project, files: undefined } as CloudProjectInfo);
		this.SaveLinks();
		this.lastError = "";
		this.Changed();
		return true;
	}

	// Download and open (from the main menu)
	async Open(info: CloudProjectInfo) {
		if (!(await this.Download(info))) return;
		if (UIDrawer.ActiveMenu === MenuType.MainMenu) {
			const link = this.LinkFor(info);
			if (link) Main.CreateOrLoadProject(link.name, "");
		}
	}

	// Conflict: keep this device's copy (overwrite the cloud) or take the cloud's (discard local changes)
	async ResolveConflict(info: CloudProjectInfo, keep: "mine" | "cloud") {
		const link = this.LinkFor(info);
		if (!link) return;
		const key = CloudNameKey(link.name);
		if (keep === "mine") {
			this.conflicts.delete(key);
			await this.Upload(link.name, true);
		} else {
			link.dirty = false;
			if (!(await this.Download(info, false))) link.dirty = true;
		}
	}

	async DeleteFromCloud(info: CloudProjectInfo) {
		try {
			await this.Request("DELETE", this.ProjectPath(info.name, info.owner));
			this.projects = this.projects.filter((p) => p !== info);
			const link = this.LinkFor(info);
			if (link) this.Unlink(link.name);
		} catch (e) {
			this.Report(e);
		}
		this.Changed();
	}

	// ---- Collaborators ----
	// Owner: add or change (role) or remove (null) a collaborator
	async SetCollaborator(info: CloudProjectInfo, username: string, role: CollaboratorRole | null): Promise<boolean> {
		this.lastError = "";
		try {
			const updated = await this.Request<CloudProjectInfo>("POST", "projects/" + encodeURIComponent(info.name) + "/collaborators", { username, role });
			this.SetCloudInfo(updated);
			return true;
		} catch (e) {
			this.Report(e);
			return false;
		} finally {
			this.Changed();
		}
	}

	// Collaborator: leave a shared project (the local copy stays, unsynced)
	async Leave(info: CloudProjectInfo) {
		try {
			await this.Request("POST", "projects/" + encodeURIComponent(info.name) + "/collaborators?owner=" + encodeURIComponent(info.owner), { username: this.user?.username, role: null });
			this.shared = this.shared.filter((p) => p !== info);
			const link = this.LinkFor(info);
			if (link) this.Unlink(link.name);
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

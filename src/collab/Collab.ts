// Live collaboration session (web-only addition, not in the original). See docs/collaboration.md.
// - Connects to the central server (WebSocket /ws), creates/joins rooms by code.
// - A room's project lives locally in "Projects/Room <CODE>"; every file the save system writes there is sent to the
//   room, and file changes from others are written there and applied to the open project (library + description).
// - The chip being edited is synced element by element (ChipSync + DocSyncCore); remote changes are applied only while
//   the local user is idle (not dragging, wiring, in a menu or viewing a subchip), in server order.
// - Cursors, selections and in-progress moves/wires of the others are shown by PresenceDrawer.
import { InputHelper } from "../seb/helpers/InputHelper";
import { Time } from "../seb/helpers/Platform";
import { Vector2 } from "../seb/types/Vector2";
import { NameKey } from "../dls/description/Types";
import { CameraController } from "../dls/game/CameraController";
import type { ChipLibrary } from "../dls/game/ChipLibrary";
import type { DevChipInstance } from "../dls/game/DevChipInstance";
import { SubChipInstance } from "../dls/game/elements/SubChipInstance";
import { Main } from "../dls/game/Main";
import { Project } from "../dls/game/Project";
import { MenuType, UIDrawer } from "../dls/graphics/ui/UIDrawer";
import { FileSystem, PathCombine } from "../dls/saveSystem/FileSystem";
import { SavePaths } from "../dls/saveSystem/SavePaths";
import { Loader } from "../dls/saveSystem/Saver";
import { DocFromDevChip, ReconcileDevChip } from "./ChipSync";
import { CollabState } from "./CollabState";
import {
	type ChipDoc,
	ChipNameFromPath,
	type ClientMsg,
	CompactInbox,
	type DocOp,
	DocSyncCore,
	type FileChange,
	HashDoc,
	MaxInboxLength,
	NormalizeRoomCode,
	type Presence,
	ProjectFile,
	ProtocolVersion,
	type Role,
	type RoomInfo,
	type RoomSummary,
	type ServerMsg,
} from "./Protocol";

export type Status = "offline" | "connecting" | "online";

export interface Peer {
	cid: string;
	uid: string;
	p: Presence | null;
	// smoothed cursor
	sx: number;
	sy: number;
	hasPos: boolean;
}

const UserKeyStorage = "dls-collab-userkey";
const ProfileStorage = "dls-collab-profile";
const SessionRoomStorage = "dls-collab-room";
const FlushIntervalMs = 100;
const PresenceIntervalMs = 50;
const HashIntervalMs = 4000;

const ProfileColors = ["#e6194b", "#3cb44b", "#f5c400", "#4363d8", "#f58231", "#911eb4", "#21b8c8", "#f032e6", "#7cb518", "#e07a5f"];

function Storage(kind: "local" | "session"): Storage | null {
	try {
		return kind === "local" ? window.localStorage : window.sessionStorage;
	} catch {
		return null;
	}
}

function RandomKey(): string {
	const bytes = new Uint8Array(24);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function CollabServerUrl(): string {
	const q = new URLSearchParams(location.search).get("collab");
	if (q) return q;
	const env = (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_COLLAB_URL;
	if (env) return env;
	return (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws";
}

export const RoomProjectName = (code: string) => "Room " + code;

class CollabSession {
	status: Status = "offline";
	uid = "";
	cid = "";
	name: string;
	color: string;
	readonly userKey: string;
	room: RoomInfo | null = null;
	rooms: RoomSummary[] = [];
	lastError = "";
	readonly peers = new Map<string, Peer>();
	// Session token of the signed-in account (set by the cloud session): rooms then belong to the account
	AccountToken: () => string | null = () => null;
	private readonly listeners = new Set<() => void>();

	private ws: WebSocket | null = null;
	private ready = false;
	private wantConnected = false;
	private reconnectDelay = 500;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private afterWelcome: ClientMsg[] = [];

	// ---- Room project state ----
	private dir = "";
	private projectOpened = false;
	private rejoining = false;
	private readonly inbox: ServerMsg[] = [];
	private readonly fileOut = new Map<string, string | null>();
	private suppressFileHook = false;
	private readonly sync = new DocSyncCore();
	private offlineOps: { key: string; seq: number; ops: DocOp[] }[] = [];
	private trackedDev: DevChipInstance | null = null;
	private trackedKey = "";
	private awaitingDoc = false;
	private openSent = false;
	private deletedKey: string | null = null;
	private resyncNeeded = false;
	private lastFlush = 0;
	private lastPresence = 0;
	private lastPresenceJson = "";
	private lastHash = 0;
	private pendingCamera: { key: string; x: number; y: number; frames: number } | null = null;

	constructor() {
		const ls = Storage("local");
		let key = ls?.getItem(UserKeyStorage) ?? "";
		if (key.length < 16) {
			key = RandomKey();
			ls?.setItem(UserKeyStorage, key);
		}
		this.userKey = key;
		let profile: { name?: string; color?: string } = {};
		try {
			profile = JSON.parse(ls?.getItem(ProfileStorage) ?? "{}");
		} catch {
			/* ignore */
		}
		this.name = profile.name || "Guest " + key.substring(0, 3).toUpperCase();
		this.color = profile.color || ProfileColors[parseInt(key.substring(0, 2), 16) % ProfileColors.length];
		FileSystem.AddChangeListener((path, content) => this.OnLocalFileChange(path, content));
		// In a background tab there are no frames (so no presence updates): hide our cursor for the others meanwhile
		if (typeof document !== "undefined") document.addEventListener("visibilitychange", () => document.hidden && this.SendAwayPresence());
	}

	// ---- Public API (used by the panel) ----
	get InRoom(): boolean {
		return this.room != null;
	}

	get MyRole(): Role | null {
		if (!this.room) return null;
		return this.room.members.find((m) => m.uid === this.uid)?.role ?? null;
	}

	get IsOwner(): boolean {
		return this.MyRole === "owner";
	}

	// The local user may not edit the shared project (viewer role)
	get ReadOnly(): boolean {
		return this.room != null && this.projectOpened && this.MyRole === "viewer";
	}

	Subscribe(fn: () => void): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	private Changed() {
		for (const fn of this.listeners) fn();
	}

	Connect() {
		this.wantConnected = true;
		if (this.ws) return;
		this.status = "connecting";
		this.Changed();
		let ws: WebSocket;
		try {
			ws = new WebSocket(CollabServerUrl());
		} catch (e) {
			this.lastError = "Could not connect: " + (e as Error).message;
			this.status = "offline";
			this.ScheduleReconnect();
			return;
		}
		this.ws = ws;
		ws.onopen = () => {
			this.reconnectDelay = 500;
			const token = this.AccountToken() ?? undefined;
			ws.send(JSON.stringify({ t: "hello", v: ProtocolVersion, userKey: this.userKey, name: this.name, color: this.color, token } satisfies ClientMsg));
		};
		ws.onmessage = (e) => {
			let msg: ServerMsg;
			try {
				msg = JSON.parse(String(e.data));
			} catch {
				return;
			}
			this.OnMessage(msg);
		};
		ws.onclose = () => {
			if (this.ws !== ws) return;
			this.ws = null;
			this.ready = false;
			this.status = "offline";
			this.peers.clear();
			this.Changed();
			this.ScheduleReconnect();
		};
		ws.onerror = () => {
			this.lastError = "Can't reach the collaboration server";
		};
	}

	// Say hello again (signed in or out): reconnect if connected
	Reconnect() {
		if (!this.ws) return;
		const ws = this.ws;
		this.reconnectDelay = 50;
		ws.close();
	}

	private ScheduleReconnect() {
		if (!this.wantConnected || this.reconnectTimer) return;
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			if (this.wantConnected) this.Connect();
		}, this.reconnectDelay);
		this.reconnectDelay = Math.min(10000, this.reconnectDelay * 2);
	}

	private Send(msg: ClientMsg) {
		if (this.ready && this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
		else {
			this.afterWelcome.push(msg);
			this.Connect();
		}
	}

	private SendIfReady(msg: ClientMsg): boolean {
		if (!this.ready || this.ws?.readyState !== WebSocket.OPEN) return false;
		this.ws.send(JSON.stringify(msg));
		return true;
	}

	SetProfile(name: string, color: string) {
		this.name = name.trim().substring(0, 24) || this.name;
		if (/^#[0-9a-fA-F]{6}$/.test(color)) this.color = color;
		Storage("local")?.setItem(ProfileStorage, JSON.stringify({ name: this.name, color: this.color }));
		this.SendIfReady({ t: "profile", name: this.name, color: this.color });
		this.Changed();
	}

	RefreshRooms() {
		this.Send({ t: "rooms" });
	}

	// Create a room from a local project (or an empty project if projectName is null)
	CreateRoom(roomName: string, projectName: string | null) {
		const files: Record<string, string> = {};
		if (projectName != null) {
			const root = SavePaths.GetProjectPath(projectName) + "/";
			for (const path of FileSystem.GetFilesRecursive(SavePaths.GetProjectPath(projectName))) files[path.substring(root.length)] = FileSystem.ReadAllText(path);
		}
		this.lastError = "";
		this.Send({ t: "create", name: roomName, files });
	}

	JoinRoom(code: string) {
		this.lastError = "";
		this.Send({ t: "join", code: NormalizeRoomCode(code) });
	}

	LeaveRoom() {
		this.SendIfReady({ t: "leave" });
		this.ClearRoom();
		this.Changed();
	}

	Manage(code: string, action: Extract<ClientMsg, { t: "manage" }>["action"]) {
		this.Send({ t: "manage", code, action });
	}

	// Jump to where a peer is: open their chip and centre the camera on their cursor
	Follow(cid: string) {
		const peer = this.peers.get(cid);
		const project = Project.ActiveProject;
		if (!peer?.p || !project || !this.projectOpened || UIDrawer.ActiveMenu !== MenuType.None) return;
		if (peer.p.chip !== this.trackedKey) {
			if (peer.p.chip === "") project.CreateBlankDevChip();
			else project.LoadDevChipOrCreateNewIfDoesntExist(peer.p.chipName);
		}
		// (camera state is per chip: it is set once the camera controller has switched to the chip's view)
		if (peer.p.c) this.pendingCamera = { key: peer.p.chip, x: peer.p.c[0], y: peer.p.c[1], frames: 2 };
	}

	// ---- Messages ----
	private OnMessage(msg: ServerMsg) {
		switch (msg.t) {
			case "welcome": {
				this.uid = msg.uid;
				this.cid = msg.cid;
				this.ready = true;
				this.status = "online";
				this.lastError = "";
				// Rejoin the room after a reconnect
				if (this.room) {
					this.rejoining = true;
					this.SendIfReady({ t: "join", code: this.room.code });
				}
				const queued = this.afterWelcome;
				this.afterWelcome = [];
				for (const m of queued) this.SendIfReady(m);
				break;
			}
			case "error":
				this.lastError = msg.msg;
				if (this.rejoining) {
					// Could not rejoin (room deleted, kicked, locked...)
					this.rejoining = false;
					this.ClearRoom();
				}
				break;
			case "rooms":
				this.rooms = msg.rooms;
				break;
			case "room":
				if (this.room && this.room.code === msg.room.code) this.room = msg.room;
				break;
			case "left":
				this.lastError = msg.reason === "left" ? "" : msg.reason;
				this.ClearRoom();
				break;
			case "presence": {
				if (msg.p == null) this.peers.delete(msg.cid);
				else {
					const peer = this.peers.get(msg.cid) ?? { cid: msg.cid, uid: msg.uid, p: null, sx: 0, sy: 0, hasPos: false };
					peer.p = msg.p;
					this.peers.set(msg.cid, peer);
				}
				return; // (no panel refresh needed for every cursor move)
			}
			case "joined":
				this.inbox.length = 0;
				this.inbox.push(msg);
				break;
			default:
				this.inbox.push(msg);
				if (this.inbox.length > MaxInboxLength) {
					const compacted = CompactInbox(this.inbox);
					this.inbox.splice(0, this.inbox.length, ...compacted.inbox);
					if (compacted.droppedOps) this.resyncNeeded = true;
				}
				return;
		}
		this.Changed();
	}

	private ClearRoom() {
		this.room = null;
		this.projectOpened = false;
		this.rejoining = false;
		this.inbox.length = 0;
		this.resyncNeeded = false;
		this.fileOut.clear();
		this.offlineOps = [];
		this.peers.clear();
		this.sync.Reset(null);
		this.trackedDev = null;
		this.dir = "";
		Storage("session")?.removeItem(SessionRoomStorage);
	}

	// Room the page was in before a reload (rejoined automatically)
	get RememberedRoom(): string | null {
		return Storage("session")?.getItem(SessionRoomStorage) ?? null;
	}

	// ---- Local file changes (FileSystem hook) ----
	private OnLocalFileChange(path: string, content: string | null) {
		if (this.suppressFileHook || !this.room || !this.dir) return;
		const prefix = SavePaths.GetProjectPath(this.dir) + "/";
		if (!path.startsWith(prefix)) return;
		this.fileOut.set(path.substring(prefix.length), content);
	}

	private FlushFiles() {
		if (this.fileOut.size === 0 || !this.ready) return;
		const changes: FileChange[] = Array.from(this.fileOut.entries());
		if (this.SendIfReady({ t: "files", changes })) this.fileOut.clear();
	}

	// ---- Per-frame update (called from Main.Update) ----
	Update() {
		CollabState.ReadOnly = this.ReadOnly;
		if (!this.room && this.inbox.length === 0) return;

		// Joined messages are handled even while busy (they open the project)
		if (this.inbox.length > 0 && this.inbox[0].t === "joined") this.OnJoined(this.inbox.shift() as Extract<ServerMsg, { t: "joined" }>);
		if (!this.room || !this.projectOpened) return;

		const project = Project.ActiveProject;
		// Leaving the room project (back to the main menu) leaves the room
		if (UIDrawer.ActiveMenu === MenuType.MainMenu || !project || project.description.ProjectName !== this.dir) {
			this.LeaveRoom();
			return;
		}

		this.FlushFiles();
		this.TrackEditedChip(project);

		const cam = this.pendingCamera;
		if (cam && cam.key === this.trackedKey && --cam.frames <= 0) {
			CameraController.activeView.Pos = new Vector2(cam.x, cam.y);
			this.pendingCamera = null;
		}

		const idle = this.IsIdle(project);
		const now = performance.now();
		if (idle && this.trackedDev) {
			if (this.resyncNeeded && this.ready && !this.awaitingDoc && this.sync.base) {
				// Remote ops were dropped from the compacted inbox: fetch the whole chip instead (an empty hash never matches)
				this.FlushLocalChanges();
				this.resyncNeeded = false;
				this.awaitingDoc = true;
				this.SendIfReady({ t: "hash", key: this.trackedKey, h: "" });
			}
			const hasInbox = this.inbox.length > 0;
			if (hasInbox || now - this.lastFlush > FlushIntervalMs) {
				this.lastFlush = now;
				this.FlushLocalChanges();
			}
			if (hasInbox) this.ProcessInbox(project);
			if (this.ready && !this.awaitingDoc && this.sync.base && !this.sync.HasPending && now - this.lastHash > HashIntervalMs) {
				this.lastHash = now;
				this.SendIfReady({ t: "hash", key: this.trackedKey, h: HashDoc(this.sync.base) });
			}
		}

		if (now - this.lastPresence > PresenceIntervalMs) {
			this.lastPresence = now;
			this.SendPresence(project);
		}
		this.SmoothPeers();
	}

	private IsIdle(project: Project): boolean {
		const c = project.controller;
		return UIDrawer.ActiveMenu === MenuType.None && project.chipViewStack.length === 1 && c != null && !c.IsPlacingOrMovingElementOrCreatingWire && !c.IsCreatingSelectionBox;
	}

	private TrackEditedChip(project: Project) {
		const dev = project.chipViewStack[0];
		const key = NameKey(dev.ChipName);
		if (dev !== this.trackedDev) {
			this.trackedDev = dev;
			this.trackedKey = key;
			this.sync.Reset(key);
			this.offlineOps = [];
			this.awaitingDoc = true;
			this.openSent = false;
			this.resyncNeeded = false; // (opening gets the whole doc anyway)
		} else if (key !== this.trackedKey) {
			// Same chip instance, new name: saved for the first time / renamed / saved as
			this.SendIfReady({ t: "rename", from: this.trackedKey, to: key });
			this.trackedKey = key;
			this.sync.key = key;
		}
		if (!this.openSent && this.ready) {
			this.openSent = this.SendIfReady({ t: "open", key, doc: DocFromDevChip(dev) });
			// Changes made while offline go after the open
			if (this.openSent) {
				for (const b of this.offlineOps) if (b.key === key) this.SendIfReady({ t: "ops", key: b.key, seq: b.seq, ops: b.ops });
				this.offlineOps = [];
			}
		}
	}

	private FlushLocalChanges() {
		const dev = this.trackedDev!;
		if (this.awaitingDoc || !this.sync.base) return;
		const cur = DocFromDevChip(dev);
		if (this.ReadOnly) {
			// Viewers can't edit: undo any local change
			if (ReconcileDevChip(dev, this.sync.base, Project.ActiveProject.chipLibrary)) this.SanitizeController(dev);
			return;
		}
		const batch = this.sync.CommitLocal(cur);
		if (!batch) return;
		const msg: ClientMsg = { t: "ops", key: this.trackedKey, seq: batch.seq, ops: batch.ops };
		if (!this.SendIfReady(msg)) this.offlineOps.push({ key: this.trackedKey, seq: batch.seq, ops: batch.ops });
	}

	private ProcessInbox(project: Project) {
		let reconcile = false;
		let forceReplace: Set<string> | undefined;
		while (this.inbox.length > 0) {
			const msg = this.inbox[0];
			if (msg.t === "joined") break; // (handled at the start of the next frame)
			this.inbox.shift();
			switch (msg.t) {
				case "files": {
					const result = this.ApplyRemoteFiles(project, msg.changes);
					if (result) {
						reconcile = true;
						forceReplace = forceReplace ? new Set([...forceReplace, ...result]) : result;
					}
					break;
				}
				case "doc":
					if (msg.key !== this.sync.key) break;
					this.awaitingDoc = false;
					if (msg.doc == null) this.sync.base = DocFromDevChip(this.trackedDev!);
					else {
						this.sync.OnServerDoc(msg.doc, DocFromDevChip(this.trackedDev!));
						reconcile = true;
					}
					break;
				case "ops":
					if (msg.key !== this.sync.key || this.awaitingDoc) break;
					if (this.sync.OnRemoteOps(msg.ops)) reconcile = true;
					break;
				case "ack":
					this.sync.OnAck(msg.seq);
					break;
				case "rename": {
					const lib = project.chipLibrary;
					const follow = this.sync.key === msg.from && (msg.from === "" || !lib.HasChip(msg.from));
					if ((follow || this.deletedKey === msg.from) && lib.HasChip(msg.to)) {
						this.deletedKey = null;
						project.LoadDevChipOrCreateNewIfDoesntExist(msg.to);
						this.TrackEditedChip(project);
						reconcile = false;
					}
					break;
				}
			}
			// A chip switch happened (e.g. the edited chip was deleted): continue with the new chip next frame
			if (project.chipViewStack[0] !== this.trackedDev) return;
		}
		if (reconcile && this.sync.base && !this.awaitingDoc) {
			const dev = this.trackedDev!;
			if (ReconcileDevChip(dev, this.sync.base, project.chipLibrary, forceReplace)) this.SanitizeController(dev);
		}
	}

	// Drop references to elements/wires that no longer exist from the interaction controller
	private SanitizeController(dev: DevChipInstance) {
		const c = Project.ActiveProject.controller;
		const elements = new Set(dev.Elements);
		for (let i = c.SelectedElements.length - 1; i >= 0; i--) if (!elements.has(c.SelectedElements[i])) c.SelectedElements.splice(i, 1);
		if (c.wireToEdit && !dev.Wires.includes(c.wireToEdit)) c.wireToEdit = null;
	}

	// ---- Joining ----
	private OnJoined(msg: Extract<ServerMsg, { t: "joined" }>) {
		const soft = this.rejoining && this.projectOpened && this.room?.code === msg.room.code;
		this.rejoining = false;
		this.room = msg.room;
		this.cid = msg.cid;
		this.dir = RoomProjectName(msg.room.code);
		Storage("session")?.setItem(SessionRoomStorage, msg.room.code);

		if (soft) {
			// Reconnected: bring local files up to date (keeping changes made while offline, which are sent next)
			const root = SavePaths.GetProjectPath(this.dir) + "/";
			const changes: FileChange[] = [];
			for (const path of FileSystem.GetFilesRecursive(SavePaths.GetProjectPath(this.dir))) {
				const rel = path.substring(root.length);
				if (!(rel in msg.files) && !this.fileOut.has(rel)) changes.push([rel, null]);
			}
			for (const [rel, content] of Object.entries(msg.files)) {
				if (this.fileOut.has(rel)) continue;
				const path = root + rel;
				if (!FileSystem.FileExists(path) || FileSystem.ReadAllText(path) !== content) changes.push([rel, content]);
			}
			if (changes.length > 0) this.inbox.unshift({ t: "files", changes });
			this.openSent = false; // re-open the edited chip on the new connection
			this.Changed();
			return;
		}

		// Fresh join: replace the local copy of the room project with the room's files, then open it
		this.suppressFileHook = true;
		try {
			FileSystem.DeleteDirectory(SavePaths.GetProjectPath(this.dir));
			for (const [rel, content] of Object.entries(msg.files)) FileSystem.WriteAllText(PathCombine(SavePaths.GetProjectPath(this.dir), rel), content);
		} finally {
			this.suppressFileHook = false;
		}
		this.fileOut.clear();
		this.offlineOps = [];
		this.sync.Reset(null);
		this.trackedDev = null;
		this.deletedKey = null;

		try {
			if (UIDrawer.ActiveMenu !== MenuType.MainMenu && Project.ActiveProject) Project.ActiveProject.NotifyExit();
			this.projectOpened = true; // (set first: a new empty room's project description is created and uploaded here)
			Main.CreateOrLoadProject(this.dir, "");
		} catch (e) {
			console.error("collab: failed to open room project", e);
			this.lastError = "Failed to open the room's project";
			this.LeaveRoom();
			Main.LoadMainMenu();
		}
		this.Changed();
	}

	// ---- Remote file changes ----
	// Returns the names (upper case) of changed chips used by the edited chip (whose instances must be re-created), or null
	private ApplyRemoteFiles(project: Project, changes: FileChange[]): Set<string> | null {
		const projectPath = SavePaths.GetProjectPath(this.dir);
		const changedChips = new Set<string>();
		let pdChanged = false;
		this.suppressFileHook = true;
		try {
			for (const [rel, content] of changes) {
				const path = PathCombine(projectPath, rel);
				if (content === null) FileSystem.DeleteFile(path);
				else FileSystem.WriteAllText(path, content);
				if (rel === ProjectFile) pdChanged = true;
				const chipName = ChipNameFromPath(rel);
				if (chipName != null) changedChips.add(NameKey(chipName));
			}
		} finally {
			this.suppressFileHook = false;
		}
		if (!pdChanged && changedChips.size === 0) return null;

		try {
			project.description = Loader.LoadProjectDescription(this.dir);
		} catch (e) {
			console.error("collab: invalid project description", e);
			return null;
		}
		if (changedChips.size === 0) return null;

		const library = this.LoadLibraryTolerant(project);
		if (!library) return null;
		const oldLibrary = project.chipLibrary;
		project.chipLibrary = library;

		const dev = this.trackedDev!;
		const name = dev.ChipName;
		if (name !== "" && !library.HasChip(name)) {
			// The chip being edited was deleted (or renamed: a rename message follows)
			this.deletedKey = NameKey(name);
			project.CreateBlankDevChip();
			return null;
		}
		if (name !== "") dev.NotifySaved(library.GetChipDescription(name));

		// Subchips whose definition changed must be re-created; chips that contain them indirectly need a sim rebuild
		const direct = new Set<string>();
		for (const e of dev.Elements) if (e instanceof SubChipInstance) direct.add(NameKey(e.Description.Name));
		const directChanged = new Set([...direct].filter((n) => changedChips.has(n)));
		const indirect = [...direct].some((n) => !changedChips.has(n) && (ContainsAny(library, n, changedChips) || ContainsAny(oldLibrary, n, changedChips)));
		if (indirect) dev.RebuildSimulation();
		return directChanged.size > 0 ? directChanged : null;
	}

	private LoadLibraryTolerant(project: Project): ChipLibrary | null {
		const desc = project.description;
		const chipsPath = SavePaths.GetChipsPath(this.dir);
		const filtered = { ...desc, AllCustomChipNames: desc.AllCustomChipNames.filter((n) => FileSystem.FileExists(PathCombine(chipsPath, n + ".json"))) };
		try {
			return Loader.LoadChipLibrary(filtered);
		} catch (e) {
			console.error("collab: failed to load the room's chip library", e);
			return null;
		}
	}

	// ---- Presence ----
	private SendAwayPresence() {
		if (!this.room || !this.projectOpened) return;
		const p: Presence = { chip: this.trackedKey, chipName: this.trackedDev?.ChipName ?? "", view: false, c: null, sel: [], g: [], w: [] };
		this.lastPresenceJson = "";
		this.SendIfReady({ t: "presence", p });
	}

	private SendPresence(project: Project) {
		const c = project.controller;
		const dev = project.chipViewStack[0];
		const mouse = InputHelper.MousePosWorld;
		const g: number[] = [];
		if (c && (c.IsMovingSelection || c.IsPlacingElements)) {
			for (const e of c.SelectedElements) {
				const b = e.BoundingBox;
				g.push(Round(b.Centre.x), Round(b.Centre.y), Round(b.Size.x), Round(b.Size.y));
			}
		}
		const w: number[] = [];
		if (c?.WireToPlace) {
			const wire = c.WireToPlace;
			for (let i = 0; i < wire.WirePointCount; i++) {
				const p = wire.GetWirePoint(i);
				w.push(Round(p.x), Round(p.y));
			}
		}
		const p: Presence = {
			chip: this.trackedKey,
			chipName: dev.ChipName,
			view: project.chipViewStack.length > 1 || UIDrawer.ActiveMenu === MenuType.ChipCustomization,
			c: [Round(mouse.x), Round(mouse.y)],
			sel: c ? c.SelectedElements.map((e) => e.ID) : [],
			g,
			w,
		};
		const json = JSON.stringify(p);
		if (json === this.lastPresenceJson) return;
		if (this.SendIfReady({ t: "presence", p })) this.lastPresenceJson = json;
	}

	private SmoothPeers() {
		const t = Math.min(1, Time.deltaTime * 18);
		for (const peer of this.peers.values()) {
			const c = peer.p?.c;
			if (!c) continue;
			if (!peer.hasPos) {
				peer.sx = c[0];
				peer.sy = c[1];
				peer.hasPos = true;
			} else {
				peer.sx += (c[0] - peer.sx) * t;
				peer.sy += (c[1] - peer.sy) * t;
			}
		}
	}

	// Peers to draw on top of the chip the local user is editing
	get VisiblePeers(): Peer[] {
		if (!this.room || !this.projectOpened) return [];
		const res: Peer[] = [];
		for (const peer of this.peers.values()) if (peer.p && peer.p.chip === this.trackedKey && !peer.p.view) res.push(peer);
		return res;
	}

	MemberColour(uid: string): string {
		return this.room?.members.find((m) => m.uid === uid)?.color ?? "#888888";
	}

	MemberName(uid: string): string {
		return this.room?.members.find((m) => m.uid === uid)?.name ?? "Guest";
	}

	// Debug/test hook
	get DebugState() {
		return { key: this.trackedKey, base: this.sync.base as ChipDoc | null, pending: this.sync.HasPending, awaitingDoc: this.awaitingDoc, inbox: this.inbox.length };
	}
}

function Round(v: number): number {
	return Math.round(v * 1000) / 1000;
}

// Does chip `name` contain (directly or indirectly) any of the given chips?
function ContainsAny(library: ChipLibrary, name: string, targets: Set<string>): boolean {
	const visited = new Set<string>();
	const Search = (n: string): boolean => {
		const desc = library.TryGetChipDescription(n);
		if (!desc?.SubChips) return false;
		for (const s of desc.SubChips) {
			const k = NameKey(s.Name);
			if (targets.has(k)) return true;
			if (!visited.has(k)) {
				visited.add(k);
				if (Search(k)) return true;
			}
		}
		return false;
	};
	return Search(name);
}

export const Collab = new CollabSession();

// Live collaboration room server logic (web-only addition). Transport-agnostic: server/index.ts wires it to WebSockets,
// tests drive it with fake connections. One process holds all rooms in memory and persists them through a RoomStore.
import { createHash, randomBytes } from "node:crypto";
import {
	ApplyOps,
	ChipNameFromPath,
	type ChipDoc,
	type ClientMsg,
	type DocOp,
	type FileChange,
	HashDoc,
	IsValidProjectFilePath,
	type ManageAction,
	type MemberInfo,
	NormalizeProjectDescription,
	NormalizeRoomCode,
	type Presence,
	ProjectFile,
	ProtocolVersion,
	type Role,
	RoomCodeAlphabet,
	RoomCodeLength,
	type RoomInfo,
	type RoomSummary,
	type ServerMsg,
} from "../src/collab/Protocol";

export interface StoredRoom {
	code: string;
	name: string;
	owner: string; // uid
	locked: boolean;
	defaultRole: "editor" | "viewer";
	roles: Record<string, "editor" | "viewer">; // members other than the owner
	bans: string[];
	names: Record<string, { name: string; color: string }>;
	files: Record<string, string>;
	docs: Record<string, ChipDoc>;
	created: number;
	lastActive: number;
}

export interface RoomStore {
	loadAll(): StoredRoom[];
	save(room: StoredRoom): void;
	remove(code: string): void;
}

export interface Conn {
	readonly cid: string;
	uid: string | null;
	name: string;
	color: string;
	room: Room | null;
	key: string | null; // chip being edited
	presence: Presence | null;
	send(msg: ServerMsg): void;
}

export interface Limits {
	maxRoomsPerUser: number;
	maxRoomBytes: number;
	maxFileBytes: number;
	maxFilesPerRoom: number;
	roomTtlMs: number;
}

export const DefaultLimits: Limits = {
	maxRoomsPerUser: 20,
	maxRoomBytes: 64 * 1024 * 1024,
	maxFileBytes: 4 * 1024 * 1024,
	maxFilesPerRoom: 5000,
	roomTtlMs: 30 * 24 * 3600 * 1000,
};

export class Room {
	readonly conns = new Set<Conn>();
	bytes = 0;
	constructor(readonly data: StoredRoom) {
		for (const c of Object.values(data.files)) this.bytes += c.length;
	}

	RoleOf(uid: string): Role | null {
		if (uid === this.data.owner) return "owner";
		return this.data.roles[uid] ?? null;
	}
}

const DefaultColors = ["#e6194b", "#3cb44b", "#ffe119", "#4363d8", "#f58231", "#911eb4", "#46f0f0", "#f032e6", "#bcf60c", "#fabebe"];

export function UidFromUserKey(userKey: string): string {
	return createHash("sha256").update("dls-collab:" + userKey).digest("hex").substring(0, 16);
}

const isObj = (v: unknown): v is Record<string, unknown> => v != null && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown, max: number): string | null => (typeof v === "string" && v.length <= max ? v : null);
const numArray = (v: unknown, max: number): number[] => (Array.isArray(v) ? v.slice(0, max).filter((x) => typeof x === "number" && Number.isFinite(x)) : []);

function CleanName(v: unknown, fallback: string, max = 24): string {
	const s = typeof v === "string" ? Array.from(v, (ch) => (ch.charCodeAt(0) < 32 ? "" : ch)).join("").trim().substring(0, max) : "";
	return s || fallback;
}

function IsDoc(v: unknown): v is ChipDoc {
	return isObj(v) && isObj(v.subs) && isObj(v.pins) && isObj(v.wires);
}

function IsOp(v: unknown): v is DocOp {
	if (!isObj(v)) return false;
	if (v.t !== "s" && v.t !== "p" && v.t !== "w") return false;
	if (typeof v.id !== "string" || v.id.length > 128) return false;
	if (v.v !== null && !isObj(v.v)) return false;
	if (v.t === "w" && v.v !== null) {
		const w = v.v as Record<string, unknown>;
		if (!isObj(w.src) || !isObj(w.tgt) || !Array.isArray(w.pts)) return false;
	}
	return true;
}

export class RoomManager {
	readonly rooms = new Map<string, Room>();
	// Account id of a session token, when accounts are on (server/index.ts): signed-in users are the same user in every
	// browser they sign in to
	AccountOf: ((token: string) => string | null) | null = null;
	private readonly dirty = new Set<string>();
	private nextCid = 1;

	constructor(
		private readonly store: RoomStore | null = null,
		private readonly limits: Limits = DefaultLimits,
		private readonly now: () => number = Date.now,
	) {
		if (store) for (const r of store.loadAll()) this.rooms.set(r.code, new Room(r));
		this.Sweep();
	}

	Connect(send: (msg: ServerMsg) => void): Conn {
		return { cid: "c" + this.nextCid++ + randomBytes(3).toString("hex"), uid: null, name: "Guest", color: DefaultColors[0], room: null, key: null, presence: null, send };
	}

	Disconnect(conn: Conn) {
		this.LeaveRoom(conn, null);
	}

	// Persist rooms changed since the last flush
	Flush() {
		if (!this.store) return void this.dirty.clear();
		for (const code of this.dirty) {
			const room = this.rooms.get(code);
			if (room) this.store.save(room.data);
		}
		this.dirty.clear();
	}

	// Delete rooms that have been inactive for too long
	Sweep() {
		const cutoff = this.now() - this.limits.roomTtlMs;
		for (const room of Array.from(this.rooms.values())) {
			if (room.conns.size === 0 && room.data.lastActive < cutoff) this.DeleteRoom(room, "expired");
		}
	}

	Handle(conn: Conn, raw: unknown) {
		if (!isObj(raw) || typeof raw.t !== "string") return;
		const msg = raw as ClientMsg;
		try {
			if (msg.t === "hello") return this.Hello(conn, msg);
			if (conn.uid == null) return conn.send({ t: "error", msg: "Say hello first" });
			switch (msg.t) {
				case "profile":
					return this.Profile(conn, msg.name, msg.color);
				case "rooms":
					return conn.send({ t: "rooms", rooms: this.RoomsOf(conn.uid) });
				case "create":
					return this.Create(conn, msg.name, msg.files);
				case "join":
					return this.Join(conn, msg.code);
				case "leave":
					return this.LeaveRoom(conn, "left");
				case "manage":
					return this.Manage(conn, msg.code, msg.action);
				case "files":
					return this.Files(conn, msg.changes);
				case "open":
					return this.Open(conn, msg.key, msg.doc);
				case "ops":
					return this.Ops(conn, msg.key, msg.seq, msg.ops);
				case "hash":
					return this.Hash(conn, msg.key, msg.h);
				case "rename":
					return this.Rename(conn, msg.from, msg.to);
				case "presence":
					return this.Presence(conn, msg.p);
			}
		} catch (e) {
			console.error("collab: error handling message", msg.t, e);
			conn.send({ t: "error", msg: "Server error" });
		}
	}

	// ---- Identity ----
	private Hello(conn: Conn, msg: Extract<ClientMsg, { t: "hello" }>) {
		if (msg.v !== ProtocolVersion) return conn.send({ t: "error", msg: "Version mismatch: please reload the page" });
		const key = str(msg.userKey, 128);
		if (key == null || key.length < 16) return conn.send({ t: "error", msg: "Invalid user key" });
		conn.uid = UidFromUserKey(key);
		const account = typeof msg.token === "string" && this.AccountOf ? this.AccountOf(msg.token) : null;
		if (account != null) {
			const accountUid = UidFromUserKey("account:" + account);
			this.ClaimRooms(conn.uid, accountUid);
			conn.uid = accountUid;
		}
		conn.name = CleanName(msg.name, "Guest");
		conn.color = /^#[0-9a-fA-F]{6}$/.test(String(msg.color)) ? msg.color : DefaultColors[parseInt(conn.uid.substring(0, 2), 16) % DefaultColors.length];
		conn.send({ t: "welcome", uid: conn.uid, cid: conn.cid });
	}

	// A browser user signed in to an account: their rooms (owned, memberships, bans) move to the account
	private ClaimRooms(from: string, to: string) {
		for (const room of this.rooms.values()) {
			const d = room.data;
			let changed = false;
			if (d.owner === from) {
				d.owner = to;
				delete d.roles[to];
				changed = true;
			}
			if (d.roles[from]) {
				if (d.owner !== to && !d.roles[to] && !d.bans.includes(to)) d.roles[to] = d.roles[from];
				delete d.roles[from];
				changed = true;
			}
			if (d.bans.includes(from)) {
				d.bans = d.bans.filter((u) => u !== from);
				if (d.owner !== to && !d.bans.includes(to)) d.bans.push(to);
				changed = true;
			}
			if (d.names[from]) {
				d.names[to] ??= d.names[from];
				delete d.names[from];
				changed = true;
			}
			if (changed) this.MarkDirty(room);
		}
	}

	private Profile(conn: Conn, name: unknown, color: unknown) {
		conn.name = CleanName(name, conn.name);
		if (/^#[0-9a-fA-F]{6}$/.test(String(color))) conn.color = String(color);
		const room = conn.room;
		if (room) {
			room.data.names[conn.uid!] = { name: conn.name, color: conn.color };
			this.MarkDirty(room);
			this.BroadcastRoomInfo(room);
		}
	}

	// ---- Rooms ----
	private RoomsOf(uid: string): RoomSummary[] {
		const res: RoomSummary[] = [];
		for (const room of this.rooms.values()) {
			const role = room.RoleOf(uid);
			if (role == null) continue;
			res.push({ code: room.data.code, name: room.data.name, owner: role === "owner", role, online: room.conns.size, lastActive: room.data.lastActive });
		}
		return res.sort((a, b) => b.lastActive - a.lastActive);
	}

	private NewCode(): string {
		while (true) {
			const bytes = randomBytes(RoomCodeLength);
			let code = "";
			for (let i = 0; i < RoomCodeLength; i++) code += RoomCodeAlphabet[bytes[i] % RoomCodeAlphabet.length];
			if (!this.rooms.has(code)) return code;
		}
	}

	private Create(conn: Conn, name: unknown, files: unknown) {
		const uid = conn.uid!;
		let owned = 0;
		for (const r of this.rooms.values()) if (r.data.owner === uid) owned++;
		if (owned >= this.limits.maxRoomsPerUser) return conn.send({ t: "error", msg: `You can own at most ${this.limits.maxRoomsPerUser} rooms. Delete one first.` });
		if (!isObj(files)) return conn.send({ t: "error", msg: "Invalid project" });

		const valid: Record<string, string> = {};
		let bytes = 0;
		let count = 0;
		for (const [path, content] of Object.entries(files)) {
			if (!IsValidProjectFilePath(path) || typeof content !== "string" || content.length > this.limits.maxFileBytes) continue;
			valid[path] = content;
			bytes += content.length;
			count++;
		}
		if (bytes > this.limits.maxRoomBytes || count > this.limits.maxFilesPerRoom) return conn.send({ t: "error", msg: "Project is too large for a room" });
		if (valid[ProjectFile] !== undefined) {
			const normalized = NormalizeProjectDescription(valid[ProjectFile], Object.keys(valid));
			if (normalized != null) valid[ProjectFile] = normalized;
		}

		const now = this.now();
		const data: StoredRoom = {
			code: this.NewCode(),
			name: CleanName(name, "Untitled room", 40),
			owner: uid,
			locked: false,
			defaultRole: "editor",
			roles: {},
			bans: [],
			names: { [uid]: { name: conn.name, color: conn.color } },
			files: valid,
			docs: {},
			created: now,
			lastActive: now,
		};
		const room = new Room(data);
		this.rooms.set(data.code, room);
		this.MarkDirty(room);
		this.Join(conn, data.code);
	}

	private Join(conn: Conn, codeRaw: unknown) {
		const code = NormalizeRoomCode(String(codeRaw ?? ""));
		const room = this.rooms.get(code);
		if (!room) return conn.send({ t: "error", msg: "Room not found. Check the code." });
		const uid = conn.uid!;
		if (room.data.bans.includes(uid)) return conn.send({ t: "error", msg: "You are not allowed to join this room." });
		if (room.data.locked && room.RoleOf(uid) == null) return conn.send({ t: "error", msg: "This room is locked." });

		if (conn.room) this.LeaveRoom(conn, null);
		if (room.RoleOf(uid) == null) room.data.roles[uid] = room.data.defaultRole;
		room.data.names[uid] = { name: conn.name, color: conn.color };
		room.data.lastActive = this.now();
		room.conns.add(conn);
		conn.room = room;
		conn.key = null;
		conn.presence = null;
		this.MarkDirty(room);

		conn.send({ t: "joined", room: this.Info(room), files: room.data.files, cid: conn.cid });
		for (const other of room.conns) {
			if (other !== conn && other.presence) conn.send({ t: "presence", cid: other.cid, uid: other.uid!, p: other.presence });
		}
		this.BroadcastRoomInfo(room);
	}

	private LeaveRoom(conn: Conn, reason: string | null) {
		const room = conn.room;
		if (!room) return;
		room.conns.delete(conn);
		conn.room = null;
		conn.key = null;
		conn.presence = null;
		room.data.lastActive = this.now();
		this.MarkDirty(room);
		if (reason != null) conn.send({ t: "left", reason });
		for (const other of room.conns) other.send({ t: "presence", cid: conn.cid, uid: conn.uid!, p: null });
		this.BroadcastRoomInfo(room);
	}

	private DeleteRoom(room: Room, reason: string) {
		for (const c of Array.from(room.conns)) this.LeaveRoom(c, reason);
		this.rooms.delete(room.data.code);
		this.dirty.delete(room.data.code);
		this.store?.remove(room.data.code);
	}

	private Info(room: Room): RoomInfo {
		const d = room.data;
		const online = new Map<string, number>();
		for (const c of room.conns) online.set(c.uid!, (online.get(c.uid!) ?? 0) + 1);
		const uids = [d.owner, ...Object.keys(d.roles).filter((u) => u !== d.owner)];
		const members: MemberInfo[] = uids.map((uid) => ({
			uid,
			name: d.names[uid]?.name ?? "Guest",
			color: d.names[uid]?.color ?? DefaultColors[0],
			role: room.RoleOf(uid)!,
			online: online.get(uid) ?? 0,
		}));
		return { code: d.code, name: d.name, owner: d.owner, locked: d.locked, defaultRole: d.defaultRole, members };
	}

	private BroadcastRoomInfo(room: Room) {
		const info = this.Info(room);
		for (const c of room.conns) c.send({ t: "room", room: info });
	}

	private Manage(conn: Conn, codeRaw: unknown, action: ManageAction) {
		const room = this.rooms.get(NormalizeRoomCode(String(codeRaw ?? "")));
		if (!room) return conn.send({ t: "error", msg: "Room not found" });
		if (room.data.owner !== conn.uid) return conn.send({ t: "error", msg: "Only the room owner can do that" });
		if (!isObj(action)) return;
		const d = room.data;
		const target = typeof (action as { uid?: unknown }).uid === "string" ? (action as { uid: string }).uid : "";
		const targetIsMember = target !== "" && target !== d.owner && d.roles[target] !== undefined;

		switch (action.a) {
			case "rename":
				d.name = CleanName(action.name, d.name, 40);
				break;
			case "lock":
				d.locked = !!action.locked;
				break;
			case "defaultRole":
				if (action.role !== "editor" && action.role !== "viewer") return;
				d.defaultRole = action.role;
				break;
			case "role":
				if (!targetIsMember || (action.role !== "editor" && action.role !== "viewer")) return;
				d.roles[target] = action.role;
				break;
			case "kick":
				if (target === "" || target === d.owner) return;
				delete d.roles[target];
				if (action.ban && !d.bans.includes(target)) d.bans.push(target);
				for (const c of Array.from(room.conns)) if (c.uid === target) this.LeaveRoom(c, action.ban ? "You were banned from the room" : "You were removed from the room");
				break;
			case "unban":
				d.bans = d.bans.filter((u) => u !== target);
				break;
			case "transfer":
				if (!targetIsMember) return;
				delete d.roles[target];
				d.roles[d.owner] = "editor";
				d.owner = target;
				break;
			case "delete":
				this.DeleteRoom(room, "The room was deleted by its owner");
				conn.send({ t: "rooms", rooms: this.RoomsOf(conn.uid!) });
				return;
			default:
				return;
		}
		this.MarkDirty(room);
		this.BroadcastRoomInfo(room);
		if (!room.conns.has(conn)) conn.send({ t: "rooms", rooms: this.RoomsOf(conn.uid!) });
	}

	// ---- Editing ----
	private EditableRoom(conn: Conn): Room | null {
		const room = conn.room;
		if (!room) return null;
		const role = room.RoleOf(conn.uid!);
		return role === "owner" || role === "editor" ? room : null;
	}

	private Files(conn: Conn, changes: unknown) {
		const room = conn.room;
		if (!room || !Array.isArray(changes)) return;
		const d = room.data;
		const editable = this.EditableRoom(conn) != null;
		const accepted: FileChange[] = [];
		const rejected: FileChange[] = [];

		for (const ch of changes) {
			if (!Array.isArray(ch) || typeof ch[0] !== "string") continue;
			const [path, content] = ch as [string, unknown];
			if (!IsValidProjectFilePath(path)) continue;
			const ok =
				editable &&
				(content === null ||
					(typeof content === "string" &&
						content.length <= this.limits.maxFileBytes &&
						room.bytes - (d.files[path]?.length ?? 0) + content.length <= this.limits.maxRoomBytes &&
						(d.files[path] !== undefined || Object.keys(d.files).length < this.limits.maxFilesPerRoom)));
			if (!ok) {
				rejected.push([path, d.files[path] ?? null]);
				continue;
			}
			room.bytes -= d.files[path]?.length ?? 0;
			if (content === null) {
				delete d.files[path];
				const chipName = ChipNameFromPath(path);
				if (chipName != null) delete d.docs[chipName.toUpperCase()];
			} else {
				d.files[path] = content as string;
				room.bytes += (content as string).length;
			}
			accepted.push([path, content as string | null]);
		}

		// Revert the sender's rejected changes
		if (rejected.length > 0) conn.send({ t: "files", changes: rejected });
		if (accepted.length === 0) return;

		let normalized: string | null = null;
		if (d.files[ProjectFile] !== undefined) {
			normalized = NormalizeProjectDescription(d.files[ProjectFile], Object.keys(d.files));
			if (normalized != null) {
				room.bytes += normalized.length - d.files[ProjectFile].length;
				d.files[ProjectFile] = normalized;
			}
		}
		const forOthers = normalized == null ? accepted : [...accepted.filter((c) => c[0] !== ProjectFile), [ProjectFile, normalized] as FileChange];
		for (const c of room.conns) if (c !== conn) c.send({ t: "files", changes: forOthers });
		if (normalized != null) conn.send({ t: "files", changes: [[ProjectFile, normalized]] });
		this.Touch(room);
	}

	private Open(conn: Conn, keyRaw: unknown, doc: unknown) {
		const room = conn.room;
		const key = str(keyRaw, 128);
		if (!room || key == null) return;
		conn.key = key;
		const existing = room.data.docs[key];
		if (existing) return conn.send({ t: "doc", key, doc: existing });
		if (this.EditableRoom(conn) && IsDoc(doc)) {
			room.data.docs[key] = doc;
			this.MarkDirty(room);
			return conn.send({ t: "doc", key, doc });
		}
		conn.send({ t: "doc", key, doc: null });
	}

	private Ops(conn: Conn, keyRaw: unknown, seq: unknown, opsRaw: unknown) {
		const room = conn.room;
		const key = str(keyRaw, 128);
		if (!room || key == null || !Array.isArray(opsRaw)) return;
		const doc = room.data.docs[key];
		if (typeof seq === "number") conn.send({ t: "ack", seq });
		if (!doc) return;
		if (!this.EditableRoom(conn)) return conn.send({ t: "doc", key, doc });

		const ops = opsRaw.filter(IsOp);
		const applied = ApplyOps(doc, ops);
		if (applied.length === 0) return;
		for (const c of room.conns) if (c !== conn && c.key === key) c.send({ t: "ops", key, ops: applied });
		this.Touch(room);
	}

	private Hash(conn: Conn, keyRaw: unknown, h: unknown) {
		const room = conn.room;
		const key = str(keyRaw, 128);
		if (!room || key == null) return;
		const doc = room.data.docs[key];
		// (an empty hash is an explicit request for the doc: always answered, so the client never waits forever)
		if (doc ? HashDoc(doc) !== h : h === "") conn.send({ t: "doc", key, doc: doc ?? null });
	}

	private Rename(conn: Conn, fromRaw: unknown, toRaw: unknown) {
		const room = this.EditableRoom(conn);
		const from = str(fromRaw, 128);
		const to = str(toRaw, 128);
		if (!room || from == null || to == null || from === to) return;
		const docs = room.data.docs;
		if (docs[from]) docs[to] = docs[from];
		if (from === "") delete docs[""];
		conn.key = to;
		for (const c of room.conns) if (c !== conn) c.send({ t: "rename", from, to });
		this.MarkDirty(room);
	}

	private Presence(conn: Conn, p: unknown) {
		const room = conn.room;
		if (!room || !isObj(p)) return;
		const c = Array.isArray(p.c) && p.c.length === 2 && p.c.every((v) => typeof v === "number" && Number.isFinite(v)) ? (p.c as [number, number]) : null;
		const presence: Presence = {
			chip: str(p.chip, 128) ?? "",
			chipName: str(p.chipName, 128) ?? "",
			view: !!p.view,
			c,
			sel: numArray(p.sel, 1000),
			g: numArray(p.g, 4000),
			w: numArray(p.w, 4000),
		};
		conn.presence = presence;
		for (const o of room.conns) if (o !== conn) o.send({ t: "presence", cid: conn.cid, uid: conn.uid!, p: presence });
	}

	private Touch(room: Room) {
		room.data.lastActive = this.now();
		this.MarkDirty(room);
	}

	private MarkDirty(room: Room) {
		this.dirty.add(room.data.code);
	}
}

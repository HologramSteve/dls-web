// Live collaboration (web-only addition, not in the original): protocol shared by the browser client and the room server.
// Pure data + functions only (no DOM / game imports) so that the server (server/) can import it directly.
//
// Model:
// - A room holds one project as files (paths relative to the project folder, same layout as the save format).
//   Saved state (library, project description) is synced by sending file changes.
// - The unsaved state of each chip being edited ("working doc", keyed by chip name in upper case; "" = new unsaved chip)
//   is synced element by element: subchips and dev pins by ID, wires by their source/target pin addresses.
//   The server orders all ops; clients apply ops optimistically and keep their own unacknowledged values (see DocSyncCore).

export const ProtocolVersion = 1;

export interface V2 {
	x: number;
	y: number;
}

export interface Address {
	PinID: number;
	PinOwnerID: number;
}

// SubChipDescription (JSON form)
export interface SubDoc {
	Name: string;
	ID: number;
	Label: string;
	Position: V2;
	OutputPinColourInfo: { PinColour: number; PinID: number }[] | null;
	InternalData: number[] | null;
}

// PinDescription (JSON form) + which side it is on + the player-controlled input state
export interface PinDoc {
	Name: string;
	ID: number;
	Position: V2;
	BitCount: number;
	Colour: number;
	ValueDisplayMode: number;
	input: boolean;
	state: number;
}

// WireDescription, with the connected wire referenced by key instead of index
export interface WireDoc {
	src: Address;
	tgt: Address;
	type: number;
	parent: string | null;
	seg: number;
	pts: V2[];
}

export interface ChipDoc {
	subs: Record<string, SubDoc>;
	pins: Record<string, PinDoc>;
	wires: Record<string, WireDoc>;
}

export type OpKind = "s" | "p" | "w";
export interface DocOp {
	t: OpKind;
	id: string;
	v: SubDoc | PinDoc | WireDoc | null; // null = delete
	add?: boolean; // element is new (otherwise an update is ignored if the element no longer exists)
}

export const EmptyDoc = (): ChipDoc => ({ subs: {}, pins: {}, wires: {} });

export function OpKey(op: DocOp): string {
	return op.t + ":" + op.id;
}

export function WireBaseKey(src: Address, tgt: Address): string {
	return `${src.PinOwnerID}.${src.PinID}>${tgt.PinOwnerID}.${tgt.PinID}`;
}

// Keys for a list of wires (duplicates of the same source/target get a #n suffix, in list order)
export function WireKeys(wires: { src: Address; tgt: Address }[]): string[] {
	const seen = new Map<string, number>();
	return wires.map((w) => {
		const k = WireBaseKey(w.src, w.tgt);
		const n = (seen.get(k) ?? 0) + 1;
		seen.set(k, n);
		return n === 1 ? k : `${k}#${n}`;
	});
}

function MapOf(doc: ChipDoc, t: OpKind): Record<string, unknown> {
	return t === "s" ? doc.subs : t === "p" ? doc.pins : doc.wires;
}

export function CloneDoc(doc: ChipDoc): ChipDoc {
	return JSON.parse(JSON.stringify(doc));
}

// ---- Canonical JSON + hash (identical on client and server) ----
export function CanonicalJson(v: unknown): string {
	if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
	if (Array.isArray(v)) return "[" + v.map(CanonicalJson).join(",") + "]";
	const keys = Object.keys(v as object)
		.filter((k) => (v as Record<string, unknown>)[k] !== undefined)
		.sort();
	return "{" + keys.map((k) => JSON.stringify(k) + ":" + CanonicalJson((v as Record<string, unknown>)[k])).join(",") + "}";
}

export function HashString(s: string): string {
	// FNV-1a (two lanes for 64 bits)
	let h1 = 0x811c9dc5;
	let h2 = 0x01000193 ^ s.length;
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		h1 = Math.imul(h1 ^ c, 0x01000193);
		h2 = Math.imul(h2 ^ c, 0x01000193) + (h1 >>> 7);
	}
	return (h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0");
}

export function HashDoc(doc: ChipDoc): string {
	return HashString(CanonicalJson(doc));
}

const Same = (a: unknown, b: unknown) => CanonicalJson(a) === CanonicalJson(b);

// ---- Apply ----
function ElementExists(doc: ChipDoc, ownerID: number): boolean {
	const k = String(ownerID);
	return k in doc.subs || k in doc.pins;
}

// Apply ops (server rules: updates to deleted elements are ignored, deleting an element deletes its wires,
// wires whose pins' owners don't exist are ignored). Returns the ops that took effect.
export function ApplyOps(doc: ChipDoc, ops: DocOp[]): DocOp[] {
	const applied: DocOp[] = [];
	for (const op of ops) {
		const map = MapOf(doc, op.t);
		if (op.v === null) {
			if (!(op.id in map)) continue;
			delete map[op.id];
			applied.push(op);
			if (op.t !== "w") {
				const owner = Number(op.id);
				for (const [k, w] of Object.entries(doc.wires)) {
					if (w.src.PinOwnerID === owner || w.tgt.PinOwnerID === owner) delete doc.wires[k];
				}
			}
			continue;
		}
		if (!op.add && !(op.id in map)) continue;
		if (op.t === "w") {
			const w = op.v as WireDoc;
			if (!ElementExists(doc, w.src.PinOwnerID) || !ElementExists(doc, w.tgt.PinOwnerID)) continue;
		}
		map[op.id] = op.v;
		applied.push(op);
	}
	return applied;
}

// ---- Diff: ops that turn doc a into doc b ----
export function DiffDocs(a: ChipDoc, b: ChipDoc): DocOp[] {
	const ops: DocOp[] = [];
	for (const id of Object.keys(a.wires)) if (!(id in b.wires)) ops.push({ t: "w", id, v: null });
	for (const t of ["s", "p"] as const) {
		const ma = MapOf(a, t);
		const mb = MapOf(b, t);
		for (const id of Object.keys(ma)) if (!(id in mb)) ops.push({ t, id, v: null });
		for (const [id, v] of Object.entries(mb)) {
			if (!(id in ma)) ops.push({ t, id, v: v as SubDoc | PinDoc, add: true });
			else if (!Same(ma[id], v)) ops.push({ t, id, v: v as SubDoc | PinDoc });
		}
	}
	for (const id of WireOrder(b.wires)) {
		const v = b.wires[id];
		if (!(id in a.wires)) ops.push({ t: "w", id, v, add: true });
		else if (!Same(a.wires[id], v)) ops.push({ t: "w", id, v });
	}
	return ops;
}

// Wire keys ordered so that a wire comes after the wire it connects to (stable w.r.t. the preferred order)
export function WireOrder(wires: Record<string, WireDoc>, preferred: string[] = []): string[] {
	const keys = new Set<string>();
	for (const k of preferred) if (k in wires) keys.add(k);
	for (const k of Object.keys(wires)) keys.add(k);

	const result: string[] = [];
	const state = new Map<string, number>(); // 1 = visiting, 2 = done
	const visit = (k: string) => {
		if (state.get(k)) return; // (cycles are broken arbitrarily)
		state.set(k, 1);
		const p = wires[k].parent;
		if (p != null && p in wires) visit(p);
		state.set(k, 2);
		result.push(k);
	};
	for (const k of keys) visit(k);
	return result;
}

// ---- Client-side sync state for one chip (pure, so it can be unit tested) ----
// The client keeps "base" = the server state plus its own unacknowledged changes.
// Remote updates to elements with unacknowledged local changes are skipped (the server will apply the local change after
// them, so the local value wins); remote deletes always apply.
export class DocSyncCore {
	key: string | null = null;
	base: ChipDoc | null = null;
	private readonly pending = new Map<string, number>();
	private readonly batches = new Map<number, string[]>();
	private seq = 0;

	get HasPending(): boolean {
		return this.pending.size > 0;
	}

	Reset(key: string | null) {
		this.key = key;
		this.base = null;
		this.pending.clear();
		this.batches.clear();
	}

	// Local state changed: returns the ops to send (or null if nothing changed) and updates base
	CommitLocal(cur: ChipDoc): { seq: number; ops: DocOp[] } | null {
		if (!this.base) return null;
		const ops = DiffDocs(this.base, cur);
		if (ops.length === 0) return null;
		const seq = ++this.seq;
		const keys = ops.map(OpKey);
		for (const k of keys) this.pending.set(k, (this.pending.get(k) ?? 0) + 1);
		this.batches.set(seq, keys);
		this.base = CloneDoc(cur);
		return { seq, ops };
	}

	OnAck(seq: number) {
		const keys = this.batches.get(seq);
		if (!keys) return;
		this.batches.delete(seq);
		for (const k of keys) {
			const n = (this.pending.get(k) ?? 0) - 1;
			if (n <= 0) this.pending.delete(k);
			else this.pending.set(k, n);
		}
	}

	// Ops from other clients (in server order). Returns true if base changed.
	OnRemoteOps(ops: DocOp[]): boolean {
		if (!this.base) return false;
		const toApply = ops.filter((op) => op.v === null || !this.pending.has(OpKey(op)));
		return ApplyOps(this.base, toApply).length > 0;
	}

	// Full server state (reply to open / resync), merged with the local unacknowledged changes from cur
	OnServerDoc(doc: ChipDoc, cur: ChipDoc) {
		const base = CloneDoc(doc);
		for (const k of this.pending.keys()) {
			const t = k[0] as OpKind;
			const id = k.substring(2);
			const local = MapOf(cur, t)[id];
			const map = MapOf(base, t);
			if (local === undefined) delete map[id];
			else map[id] = JSON.parse(JSON.stringify(local));
		}
		this.base = base;
	}
}

// ---- Rooms / files ----
export type Role = "owner" | "editor" | "viewer";
export const RoomCodeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const RoomCodeLength = 6;
export const ProjectFile = "ProjectDescription.json";

export function NormalizeRoomCode(code: string): string {
	return code
		.toUpperCase()
		.replace(/[^A-Z0-9]/g, "")
		.substring(0, RoomCodeLength);
}

// Paths inside the project folder that may be synced
export function IsValidProjectFilePath(rel: string): boolean {
	if (rel === ProjectFile) return true;
	const m = /^(Chips|Deleted Chips)\/([^/\\]+)\.json$/.exec(rel);
	return m != null && m[2] !== "." && m[2] !== ".." && !m[2].includes("..");
}

export function ChipNameFromPath(rel: string): string | null {
	const m = /^Chips\/([^/\\]+)\.json$/.exec(rel);
	return m ? m[1] : null;
}

// Make ProjectDescription.AllCustomChipNames match the chip files that exist (concurrent saves by different users
// can otherwise leave it listing a deleted chip, or missing a new one). Returns the new JSON, or null if unchanged/invalid.
export function NormalizeProjectDescription(json: string, files: Iterable<string>): string | null {
	let pd: any;
	try {
		pd = JSON.parse(json);
	} catch {
		return null;
	}
	if (pd == null || typeof pd !== "object") return null;
	const chipNames: string[] = [];
	for (const f of files) {
		const n = ChipNameFromPath(f);
		if (n != null) chipNames.push(n);
	}
	const byKey = new Map(chipNames.map((n) => [n.toUpperCase(), n]));
	const listed: string[] = Array.isArray(pd.AllCustomChipNames) ? pd.AllCustomChipNames.filter((n: unknown) => typeof n === "string") : [];
	const used = new Set<string>();
	const result: string[] = [];
	for (const n of listed) {
		const k = n.toUpperCase();
		const fileName = byKey.get(k);
		if (fileName !== undefined && !used.has(k)) {
			used.add(k);
			result.push(fileName);
		}
	}
	for (const n of chipNames.slice().sort()) {
		if (used.has(n.toUpperCase())) continue;
		used.add(n.toUpperCase());
		result.push(n);
	}
	if (Same(result, pd.AllCustomChipNames)) return null;
	pd.AllCustomChipNames = result;
	return JSON.stringify(pd, null, 2);
}

// ---- Presence ----
export interface Presence {
	chip: string; // chip key ("" = new chip)
	chipName: string; // display name
	view: boolean; // viewing inside a subchip (not the edited chip)
	c: [number, number] | null; // cursor (world)
	sel: number[]; // selected element IDs
	g: number[]; // ghost rects of elements being moved/placed: cx, cy, w, h, ...
	w: number[]; // points of the wire being created: x, y, ...
}

export interface MemberInfo {
	uid: string;
	name: string;
	color: string;
	role: Role;
	online: number; // number of open connections
}

export interface RoomInfo {
	code: string;
	name: string;
	owner: string;
	locked: boolean;
	defaultRole: "editor" | "viewer";
	members: MemberInfo[];
}

export interface RoomSummary {
	code: string;
	name: string;
	owner: boolean;
	role: Role;
	online: number;
	lastActive: number;
}

export type ManageAction =
	| { a: "rename"; name: string }
	| { a: "lock"; locked: boolean }
	| { a: "defaultRole"; role: "editor" | "viewer" }
	| { a: "role"; uid: string; role: "editor" | "viewer" }
	| { a: "kick"; uid: string; ban?: boolean }
	| { a: "unban"; uid: string }
	| { a: "transfer"; uid: string }
	| { a: "delete" };

export type FileChange = [path: string, content: string | null];

export type ClientMsg =
	// token: the account session (accounts/cloud storage); when valid, the user is the account instead of the browser key
	| { t: "hello"; v: number; userKey: string; name: string; color: string; token?: string }
	| { t: "profile"; name: string; color: string }
	| { t: "rooms" }
	| { t: "create"; name: string; files: Record<string, string> }
	| { t: "join"; code: string }
	| { t: "leave" }
	| { t: "manage"; code: string; action: ManageAction }
	| { t: "files"; changes: FileChange[] }
	| { t: "open"; key: string; doc: ChipDoc }
	| { t: "ops"; key: string; seq: number; ops: DocOp[] }
	| { t: "hash"; key: string; h: string }
	| { t: "rename"; from: string; to: string }
	| { t: "presence"; p: Presence };

export type ServerMsg =
	| { t: "welcome"; uid: string; cid: string }
	| { t: "error"; msg: string }
	| { t: "rooms"; rooms: RoomSummary[] }
	| { t: "joined"; room: RoomInfo; files: Record<string, string>; cid: string }
	| { t: "room"; room: RoomInfo }
	| { t: "left"; reason: string }
	| { t: "files"; changes: FileChange[] }
	| { t: "doc"; key: string; doc: ChipDoc | null }
	| { t: "ops"; key: string; ops: DocOp[] }
	| { t: "ack"; seq: number }
	| { t: "rename"; from: string; to: string }
	| { t: "presence"; cid: string; uid: string; p: Presence | null };

// ---- Client inbox compaction ----
// Messages pile up while the tab is in the background (no animation frames) or while the user is busy (remote changes
// are only applied while idle). Compacting keeps the queue small so coming back doesn't replay everything at once:
// chip ops are dropped (the caller then fetches the whole chip doc instead) and consecutive file batches are merged
// (last write per path wins). Everything else is kept in order.
export const MaxInboxLength = 64;

export function CompactInbox(inbox: ServerMsg[]): { inbox: ServerMsg[]; droppedOps: boolean } {
	const out: ServerMsg[] = [];
	let droppedOps = false;
	for (const msg of inbox) {
		if (msg.t === "ops") {
			droppedOps = true;
			continue;
		}
		const prev = out[out.length - 1];
		if (msg.t === "files" && prev?.t === "files") {
			const merged = new Map(prev.changes);
			for (const [path, content] of msg.changes) {
				merged.delete(path);
				merged.set(path, content);
			}
			out[out.length - 1] = { t: "files", changes: Array.from(merged) };
			continue;
		}
		out.push(msg);
	}
	return { inbox: out, droppedOps };
}

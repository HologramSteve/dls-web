import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	ApplyOps,
	type ChipDoc,
	CloneDoc,
	CompactInbox,
	DiffDocs,
	type DocOp,
	DocSyncCore,
	EmptyDoc,
	HashDoc,
	NormalizeProjectDescription,
	type PinDoc,
	type ServerMsg,
	type SubDoc,
	type WireDoc,
	WireOrder,
} from "../src/collab/Protocol";
import { type Conn, RoomManager } from "../server/rooms";

const sub = (id: number, x = 0, y = 0, name = "NAND"): SubDoc => ({ Name: name, ID: id, Label: "", Position: { x, y }, OutputPinColourInfo: [], InternalData: null });
const pin = (id: number, input: boolean, state = 0): PinDoc => ({ Name: "P" + id, ID: id, Position: { x: input ? -5 : 5, y: id }, BitCount: 1, Colour: 0, ValueDisplayMode: 0, input, state });
const wire = (so: number, sp: number, to: number, tp: number, parent: string | null = null): WireDoc => ({
	src: { PinOwnerID: so, PinID: sp },
	tgt: { PinOwnerID: to, PinID: tp },
	type: parent ? 1 : 0,
	parent,
	seg: parent ? 0 : -1,
	pts: [
		{ x: 0, y: 0 },
		{ x: 0, y: 0 },
	],
});

function SampleDoc(): ChipDoc {
	const d = EmptyDoc();
	d.subs["10"] = sub(10, 1, 1);
	d.subs["11"] = sub(11, 3, 1);
	d.pins["1"] = pin(1, true);
	d.pins["2"] = pin(2, false);
	d.wires["1.0>10.0"] = wire(1, 0, 10, 0);
	d.wires["10.2>11.0"] = wire(10, 2, 11, 0);
	d.wires["11.2>2.0"] = wire(11, 2, 2, 0);
	return d;
}

describe("collab protocol", () => {
	it("diff + apply turns one doc into another", () => {
		const a = SampleDoc();
		const b = SampleDoc();
		b.subs["10"].Position = { x: 7, y: 2 };
		delete b.subs["11"];
		delete b.wires["10.2>11.0"];
		delete b.wires["11.2>2.0"];
		b.subs["12"] = sub(12, 9, 9);
		b.wires["10.2>12.0"] = wire(10, 2, 12, 0);
		b.wires["10.2>12.1"] = wire(10, 2, 12, 1, "10.2>12.0");
		b.pins["1"].state = 1;

		const result = CloneDoc(a);
		ApplyOps(result, DiffDocs(a, b));
		expect(HashDoc(result)).toBe(HashDoc(b));
		expect(DiffDocs(b, b)).toEqual([]);
	});

	it("hash does not depend on key order", () => {
		const a = SampleDoc();
		const b: ChipDoc = { wires: {}, pins: {}, subs: {} };
		for (const k of Object.keys(a.subs).reverse()) b.subs[k] = a.subs[k];
		for (const k of Object.keys(a.pins).reverse()) b.pins[k] = a.pins[k];
		for (const k of Object.keys(a.wires).reverse()) b.wires[k] = a.wires[k];
		expect(HashDoc(a)).toBe(HashDoc(b));
	});

	it("server rules: deleting an element deletes its wires, updates to missing elements and dangling wires are ignored", () => {
		const d = SampleDoc();
		ApplyOps(d, [{ t: "s", id: "11", v: null }]);
		expect(Object.keys(d.wires)).toEqual(["1.0>10.0"]);
		expect(ApplyOps(d, [{ t: "s", id: "11", v: sub(11, 5, 5) }])).toEqual([]);
		expect(ApplyOps(d, [{ t: "w", id: "10.2>11.0", v: wire(10, 2, 11, 0), add: true }])).toEqual([]);
		expect(d.subs["11"]).toBeUndefined();
	});

	it("orders wires after the wire they connect to", () => {
		const wires: Record<string, WireDoc> = { child: wire(1, 0, 10, 1, "parent"), parent: wire(1, 0, 10, 0) };
		expect(WireOrder(wires)).toEqual(["parent", "child"]);
	});

	it("normalizes the project's chip list to the existing chip files", () => {
		const pd = JSON.stringify({ ProjectName: "X", AllCustomChipNames: ["AND", "GONE", "and"], StarredList: [] });
		const out = NormalizeProjectDescription(pd, ["ProjectDescription.json", "Chips/AND.json", "Chips/NEW.json", "Deleted Chips/GONE.json"]);
		expect(JSON.parse(out!).AllCustomChipNames).toEqual(["AND", "NEW"]);
		expect(NormalizeProjectDescription(out!, ["Chips/AND.json", "Chips/NEW.json"])).toBeNull();
	});
});

describe("collab inbox compaction", () => {
	it("drops ops, merges consecutive file batches and keeps the rest in order", () => {
		const inbox: ServerMsg[] = [
			{ t: "files", changes: [["Chips/A.json", "1"], ["ProjectDescription.json", "pd1"]] },
			{ t: "ops", key: "", ops: [{ t: "s", id: "1", v: null }] },
			{ t: "files", changes: [["Chips/A.json", null], ["Chips/B.json", "2"]] },
			{ t: "ack", seq: 3 },
			{ t: "files", changes: [["ProjectDescription.json", "pd2"]] },
			{ t: "rename", from: "", to: "B" },
		];
		const r = CompactInbox(inbox);
		expect(r.droppedOps).toBe(true);
		expect(r.inbox).toEqual([
			{ t: "files", changes: [["ProjectDescription.json", "pd1"], ["Chips/A.json", null], ["Chips/B.json", "2"]] },
			{ t: "ack", seq: 3 },
			{ t: "files", changes: [["ProjectDescription.json", "pd2"]] },
			{ t: "rename", from: "", to: "B" },
		]);
		expect(CompactInbox([{ t: "ack", seq: 1 }]).droppedOps).toBe(false);
	});

	it("a client that was in the background catches up with one doc after its ops were dropped", () => {
		const server = SampleDoc();
		const client = new DocSyncCore();
		client.Reset("K");
		client.base = CloneDoc(server);
		// A pending local change from before the tab was hidden
		const local = CloneDoc(server);
		local.subs["10"].Position = { x: 42, y: 42 };
		const mine = client.CommitLocal(local)!;
		// Meanwhile others make many edits; the server applies ours in between
		const inbox: ServerMsg[] = [];
		for (let i = 0; i < 200; i++) {
			const id = String(1000 + i);
			const applied = ApplyOps(server, [{ t: "s", id, v: sub(1000 + i, i, i), add: true }]);
			inbox.push({ t: "ops", key: "K", ops: applied });
			if (i === 50) {
				ApplyOps(server, mine.ops);
				inbox.push({ t: "ack", seq: mine.seq });
			}
		}
		const r = CompactInbox(inbox);
		expect(r.inbox).toEqual([{ t: "ack", seq: mine.seq }]);
		client.OnAck(mine.seq);
		client.OnServerDoc(CloneDoc(server), local);
		expect(HashDoc(client.base!)).toBe(HashDoc(server));
		expect(client.base!.subs["10"].Position).toEqual({ x: 42, y: 42 });
	});
});

// ---- Convergence: clients with DocSyncCore + the server's op ordering, with messages delivered in arbitrary interleavings ----
class SimServer {
	doc: ChipDoc;
	constructor(doc: ChipDoc) {
		this.doc = CloneDoc(doc);
	}
}

class SimClient {
	readonly core = new DocSyncCore();
	local: ChipDoc;
	readonly inbox: ServerMsg[] = [];
	constructor(doc: ChipDoc) {
		this.core.Reset("K");
		this.core.base = CloneDoc(doc);
		this.local = CloneDoc(doc);
	}
	Process() {
		while (this.inbox.length > 0) {
			const m = this.inbox.shift()!;
			if (m.t === "ack") this.core.OnAck(m.seq);
			else if (m.t === "ops") this.core.OnRemoteOps(m.ops);
			else if (m.t === "doc" && m.doc) this.core.OnServerDoc(m.doc, this.local);
		}
		// (the app reconciles the edited chip to base after processing)
		this.local = CloneDoc(this.core.base!);
	}
}

function RunScenario(seed: number) {
	let s = seed;
	const rand = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
	const server = new SimServer(SampleDoc());
	const clients = [new SimClient(SampleDoc()), new SimClient(SampleDoc()), new SimClient(SampleDoc())];
	const toServer: { from: number; seq: number; ops: DocOp[] }[] = [];
	const Deliver = () => {
		const m = toServer.shift()!;
		const applied = ApplyOps(server.doc, m.ops);
		clients[m.from].inbox.push({ t: "ack", seq: m.seq });
		if (applied.length === 0) return;
		for (let i = 0; i < clients.length; i++) if (i !== m.from) clients[i].inbox.push({ t: "ops", key: "K", ops: applied });
	};

	for (let step = 0; step < 60; step++) {
		const ci = Math.floor(rand() * clients.length);
		const c = clients[ci];
		const r = rand();
		if (r < 0.45) {
			// local edit
			const ids = Object.keys(c.local.subs);
			const kind = rand();
			if (kind < 0.4 && ids.length > 0) c.local.subs[ids[Math.floor(rand() * ids.length)]].Position = { x: Math.floor(rand() * 10), y: step };
			else if (kind < 0.6 && ids.length > 0) {
				const id = ids[Math.floor(rand() * ids.length)];
				ApplyOps(c.local, [{ t: "s", id, v: null }]);
			} else if (kind < 0.8) {
				const id = 100 + step * 10 + ci;
				c.local.subs[id] = sub(id, step, ci);
				if (rand() < 0.7) c.local.wires[`1.0>${id}.0`] = wire(1, 0, id, 0);
			} else c.local.pins["1"].state = 1 - c.local.pins["1"].state;
			const batch = c.core.CommitLocal(c.local);
			if (batch) toServer.push({ from: ci, seq: batch.seq, ops: batch.ops });
		} else if (r < 0.75 && toServer.length > 0) {
			Deliver(); // server processes the next message (in order of arrival)
		} else c.Process();
	}
	// Drain everything
	while (toServer.length > 0) Deliver();
	for (const c of clients) c.Process();
	// Hash check resync for any client that still differs (as the app does every few seconds)
	let resyncs = 0;
	for (const c of clients) {
		if (!c.core.HasPending && HashDoc(c.core.base!) !== HashDoc(server.doc)) {
			resyncs++;
			c.inbox.push({ t: "doc", key: "K", doc: CloneDoc(server.doc) });
			c.Process();
		}
	}
	return { server, clients, resyncs };
}

describe("collab convergence", () => {
	it("all clients end with the server's state after concurrent edits", () => {
		let resyncs = 0;
		for (let seed = 1; seed <= 200; seed++) {
			const r = RunScenario(seed);
			for (const c of r.clients) {
				expect(c.core.HasPending).toBe(false);
				expect(HashDoc(c.core.base!)).toBe(HashDoc(r.server.doc));
			}
			resyncs += r.resyncs;
		}
		// Ops alone should converge; the hash resync is only a safety net
		expect(resyncs).toBe(0);
	});
});

// ---- Room server ----
function Client(manager: RoomManager, key: string, name: string) {
	const received: ServerMsg[] = [];
	const conn: Conn = manager.Connect((m) => received.push(JSON.parse(JSON.stringify(m))));
	manager.Handle(conn, { t: "hello", v: 1, userKey: key.padEnd(20, "x"), name, color: "#123456" });
	const last = <T extends ServerMsg["t"]>(t: T) => [...received].reverse().find((m) => m.t === t) as Extract<ServerMsg, { t: T }> | undefined;
	return { conn, received, last, send: (m: unknown) => manager.Handle(conn, m) };
}

const ProjectFiles = () => ({
	"ProjectDescription.json": JSON.stringify({ ProjectName: "P", AllCustomChipNames: ["AND"], StarredList: [], ChipCollections: [] }),
	"Chips/AND.json": "{}",
});

describe("collab room server", () => {
	it("creates a room, joins by code and relays files, ops and presence", () => {
		const m = new RoomManager();
		const a = Client(m, "alice", "Alice");
		const b = Client(m, "bob", "Bob");
		a.send({ t: "create", name: "Test room", files: ProjectFiles() });
		const joined = a.last("joined")!;
		expect(joined.room.code).toMatch(/^[A-Z2-9]{6}$/);
		expect(joined.room.members[0].role).toBe("owner");

		b.send({ t: "join", code: joined.room.code.toLowerCase() });
		expect(b.last("joined")!.files["Chips/AND.json"]).toBe("{}");
		expect(a.last("room")!.room.members.map((x) => x.name)).toEqual(["Alice", "Bob"]);

		// Files: new chip without updating the project description -> normalized for everyone
		b.send({ t: "files", changes: [["Chips/OR.json", "{}"]] });
		const aFiles = a.last("files")!;
		expect(aFiles.changes.map((c) => c[0])).toEqual(["Chips/OR.json", "ProjectDescription.json"]);
		expect(JSON.parse(aFiles.changes[1][1]!).AllCustomChipNames).toEqual(["AND", "OR"]);
		expect(b.last("files")!.changes.map((c) => c[0])).toEqual(["ProjectDescription.json"]);

		// Docs: first opener's doc becomes the working doc; ops go to others on the same chip
		a.send({ t: "open", key: "", doc: SampleDoc() });
		b.send({ t: "open", key: "", doc: EmptyDoc() });
		expect(HashDoc(b.last("doc")!.doc!)).toBe(HashDoc(SampleDoc()));
		a.send({ t: "ops", key: "", seq: 1, ops: [{ t: "s", id: "10", v: sub(10, 5, 5) }] });
		expect(a.last("ack")!.seq).toBe(1);
		expect(b.last("ops")!.ops[0].id).toBe("10");

		a.send({ t: "presence", p: { chip: "", chipName: "", view: false, c: [1, 2], sel: [10], g: [], w: [] } });
		expect(b.last("presence")!.p!.c).toEqual([1, 2]);

		// Hash mismatch -> full doc
		b.send({ t: "hash", key: "", h: "nope" });
		expect(b.last("doc")!.doc!.subs["10"].Position).toEqual({ x: 5, y: 5 });

		// Explicit doc request for a chip without a working doc is answered too
		b.send({ t: "hash", key: "NOPE", h: "" });
		expect(b.last("doc")).toEqual({ t: "doc", key: "NOPE", doc: null });

		// Rename of a new chip moves its working doc
		a.send({ t: "rename", from: "", to: "MYCHIP" });
		expect(b.last("rename")).toEqual({ t: "rename", from: "", to: "MYCHIP" });
		expect(m.rooms.get(joined.room.code)!.data.docs.MYCHIP).toBeDefined();
	});

	it("enforces roles, locking, kicking, bans and ownership", () => {
		const m = new RoomManager();
		const a = Client(m, "alice", "Alice");
		const b = Client(m, "bob", "Bob");
		const c = Client(m, "carol", "Carol");
		a.send({ t: "create", name: "R", files: ProjectFiles() });
		const code = a.last("joined")!.room.code;
		a.send({ t: "manage", code, action: { a: "defaultRole", role: "viewer" } });
		b.send({ t: "join", code });
		expect(b.last("room")!.room.members.find((x) => x.name === "Bob")!.role).toBe("viewer");

		// Viewer edits are rejected and reverted
		b.send({ t: "files", changes: [["Chips/AND.json", "hacked"]] });
		expect(b.last("files")!.changes).toEqual([["Chips/AND.json", "{}"]]);
		a.send({ t: "open", key: "X", doc: SampleDoc() });
		b.send({ t: "open", key: "X", doc: EmptyDoc() });
		b.send({ t: "ops", key: "X", seq: 1, ops: [{ t: "s", id: "10", v: null }] });
		expect(m.rooms.get(code)!.data.docs.X.subs["10"]).toBeDefined();

		// Non-owners can't manage
		b.send({ t: "manage", code, action: { a: "lock", locked: true } });
		expect(b.last("error")!.msg).toMatch(/owner/);

		// Lock: new people can't join, members can
		a.send({ t: "manage", code, action: { a: "lock", locked: true } });
		c.send({ t: "join", code });
		expect(c.last("error")!.msg).toMatch(/locked/);
		b.send({ t: "leave" });
		b.send({ t: "join", code });
		expect(b.last("joined")).toBeDefined();

		// Promote, then transfer ownership
		a.send({ t: "manage", code, action: { a: "role", uid: b.conn.uid, role: "editor" } });
		a.send({ t: "manage", code, action: { a: "transfer", uid: b.conn.uid } });
		const info = b.last("room")!.room;
		expect(info.owner).toBe(b.conn.uid);
		expect(info.members.find((x) => x.name === "Alice")!.role).toBe("editor");

		// Ban
		b.send({ t: "manage", code, action: { a: "kick", uid: a.conn.uid, ban: true } });
		expect(a.last("left")!.reason).toMatch(/banned/);
		a.send({ t: "join", code });
		expect(a.last("error")!.msg).toMatch(/not allowed/);

		// Room list + delete
		b.send({ t: "rooms" });
		expect(b.last("rooms")!.rooms.map((r) => r.code)).toEqual([code]);
		b.send({ t: "manage", code, action: { a: "delete" } });
		expect(m.rooms.size).toBe(0);
	});

	it("persists rooms through the store and expires inactive ones", () => {
		const saved = new Map<string, unknown>();
		let now = 1000;
		const store = { loadAll: () => [...saved.values()] as any[], save: (r: any) => saved.set(r.code, JSON.parse(JSON.stringify(r))), remove: (c: string) => saved.delete(c) };
		const m1 = new RoomManager(store, undefined, () => now);
		const a = Client(m1, "alice", "Alice");
		a.send({ t: "create", name: "Persist", files: ProjectFiles() });
		m1.Flush();
		expect(saved.size).toBe(1);

		const m2 = new RoomManager(store, undefined, () => now);
		expect(m2.rooms.size).toBe(1);
		now += 31 * 24 * 3600 * 1000;
		new RoomManager(store, undefined, () => now);
		expect(saved.size).toBe(0);
	});
});

// ---- ChipSync on real chips (game objects + simulation command queue) ----
describe("collab chip sync", async () => {
	const { Serializer } = await import("../src/dls/description/Serializer");
	const { CreateAllBuiltinChipDescriptions } = await import("../src/dls/game/BuiltinChipCreator");
	const { ChipLibrary } = await import("../src/dls/game/ChipLibrary");
	const { Project } = await import("../src/dls/game/Project");
	const { DevChipInstance } = await import("../src/dls/game/DevChipInstance");
	const { SubChipInstance } = await import("../src/dls/game/elements/SubChipInstance");
	const { DevPinInstance } = await import("../src/dls/game/elements/DevPinInstance");
	const { Simulator } = await import("../src/dls/simulation/SimHost");
	const { DocFromDevChip, ReconcileDevChip } = await import("../src/collab/ChipSync");
	const { Draw } = await import("../src/seb/vis/Draw");
	const { FontType } = await import("../src/seb/vis/Anchor");
	const { ParseFont } = await import("../src/seb/vis/text/FontParser");
	const { Vector2 } = await import("../src/seb/types/Vector2");

	// Chip sizes depend on text bounds, so the fonts are needed (loaded from disk instead of fetched)
	const fontFile = (f: string) => {
		const b = readFileSync(join(__dirname, "../public/fonts", f));
		return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
	};
	Draw.SetFontData(FontType.JetbrainsMonoBold, ParseFont(fontFile("JetBrainsMonoNL-Bold.ttf")));
	Draw.SetFontData(FontType.JetbrainsMonoRegular, ParseFont(fontFile("JetBrainsMonoNL-Regular.ttf")));

	const chipsDir = join(__dirname, "../testdata/Projects/MainTest/Chips");
	const custom = readdirSync(chipsDir).map((f) => Serializer.DeserializeChipDescription(readFileSync(join(chipsDir, f), "utf8")));
	const library = new ChipLibrary(custom, CreateAllBuiltinChipDescriptions());
	const project = new Project({ ProjectName: "T", AllCustomChipNames: custom.map((c) => c.Name), StarredList: [], ChipCollections: [] } as any, library);

	const Load = (name: string) => {
		const [dev] = DevChipInstance.LoadFromDescriptionTest(Serializer.DeserializeChipDescription(Serializer.SerializeChipDescription(library.GetChipDescription(name))), library);
		dev.SetSimChip(Simulator.BuildSimChip(dev.LastSavedDescription!));
		return dev;
	};

	it("reconciles a dev chip to another client's edits", () => {
		for (const name of ["ALU-8", "demo", "WIP2", "RAM-sync", "TEST MergeSplit"]) {
			const a = Load(name);
			const b = Load(name);
			// (edits go through the project's viewed chip, as in the app)
			project.chipViewStack.length = 0;
			project.chipViewStack.push(a);
			expect(HashDoc(DocFromDevChip(a))).toBe(HashDoc(DocFromDevChip(b)));

			// Edit a: move, delete, re-create with different data, toggle an input
			const subs = a.Elements.filter((e) => e instanceof SubChipInstance) as InstanceType<typeof SubChipInstance>[];
			subs[0].Position = new Vector2(subs[0].Position.x + 1.5, subs[0].Position.y - 2);
			a.DeleteSubChip(subs[1]);
			if (a.Wires.length > 3) a.DeleteWire(a.Wires[2]);
			const input = a.GetInputPins()[0] as InstanceType<typeof DevPinInstance> | undefined;
			if (input) input.Pin.PlayerInputState = 1;
			subs[2].Label = "renamed";

			const target = DocFromDevChip(a);
			project.chipViewStack[0] = b;
			expect(ReconcileDevChip(b, target, library)).toBe(true);
			const bd = DocFromDevChip(b);
			expect(DiffDocs(bd, target), name).toEqual([]);
			expect(ReconcileDevChip(b, target, library)).toBe(false);
		}
	});
});

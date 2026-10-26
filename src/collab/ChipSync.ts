// Live collaboration (web-only addition): conversion between the chip being edited (DevChipInstance) and the synced
// ChipDoc, and reconciliation of a DevChipInstance to a target doc using the same operations the editor uses
// (AddNewSubChip, DeleteSubChip, AddNewDevPin, ...), so the simulation is updated incrementally (state is kept).
import { Vector2 } from "../seb/types/Vector2";
import type { PinDescription, SubChipDescription, WireDescription } from "../dls/description/Types";
import type { ChipLibrary } from "../dls/game/ChipLibrary";
import { DevChipInstance } from "../dls/game/DevChipInstance";
import { DevPinInstance } from "../dls/game/elements/DevPinInstance";
import { SubChipInstance } from "../dls/game/elements/SubChipInstance";
import type { WireInstance } from "../dls/game/elements/WireInstance";
import { CreatePinDescription, CreateSubChipDescription, CreateWireDescription, UpdateWireIndicesForDescriptionCreation } from "../dls/saveSystem/DescriptionCreator";
import { Simulator } from "../dls/simulation/SimHost";
import { CanonicalJson, type ChipDoc, type PinDoc, type SubDoc, type V2, type WireDoc, WireKeys, WireOrder } from "./Protocol";

// Coordinates are quantized: wire points attached to other wires are recomputed with float noise, which would
// otherwise show up as endless tiny changes / hash mismatches.
const q = (n: number) => Math.round(n * 1e6) / 1e6 + 0;
const v2 = (v: Vector2): V2 => ({ x: q(v.x), y: q(v.y) });
const toVec = (v: V2): Vector2 => new Vector2(v.x, v.y);

function SubDocOf(desc: SubChipDescription): SubDoc {
	return {
		Name: desc.Name,
		ID: desc.ID,
		Label: desc.Label,
		Position: v2(desc.Position),
		OutputPinColourInfo: desc.OutputPinColourInfo ? desc.OutputPinColourInfo.map((c) => ({ PinColour: c.PinColour, PinID: c.PinID })) : null,
		InternalData: desc.InternalData ? desc.InternalData.slice() : null,
	};
}

function PinDocOf(pin: DevPinInstance): PinDoc {
	const d = CreatePinDescription(pin);
	return {
		Name: d.Name,
		ID: d.ID,
		Position: v2(d.Position),
		BitCount: d.BitCount,
		Colour: d.Colour,
		ValueDisplayMode: d.ValueDisplayMode,
		input: pin.IsInputPin,
		state: pin.IsInputPin ? pin.Pin.PlayerInputState : 0,
	};
}

function SubDescOf(d: SubDoc): SubChipDescription {
	return {
		Name: d.Name,
		ID: d.ID,
		Label: d.Label ?? "",
		Position: toVec(d.Position),
		OutputPinColourInfo: d.OutputPinColourInfo ? d.OutputPinColourInfo.map((c) => ({ ...c })) : null,
		InternalData: d.InternalData ? d.InternalData.slice() : null,
	};
}

function PinDescOf(d: PinDoc): PinDescription {
	return { Name: d.Name, ID: d.ID, Position: toVec(d.Position), BitCount: d.BitCount, Colour: d.Colour, ValueDisplayMode: d.ValueDisplayMode };
}

function WireDocs(wires: WireInstance[]): { keys: string[]; docs: WireDoc[] } {
	const descs = wires.map(CreateWireDescription);
	const keys = WireKeys(descs.map((d) => ({ src: d.SourcePinAddress, tgt: d.TargetPinAddress })));
	const docs = descs.map((d) => ({
		src: { PinID: d.SourcePinAddress.PinID, PinOwnerID: d.SourcePinAddress.PinOwnerID },
		tgt: { PinID: d.TargetPinAddress.PinID, PinOwnerID: d.TargetPinAddress.PinOwnerID },
		type: d.ConnectionType,
		parent: d.ConnectedWireIndex >= 0 ? (keys[d.ConnectedWireIndex] ?? null) : null,
		seg: d.ConnectedWireSegmentIndex,
		pts: d.Points.map(v2),
	}));
	return { keys, docs };
}

export function DocFromDevChip(dev: DevChipInstance): ChipDoc {
	const doc: ChipDoc = { subs: {}, pins: {}, wires: {} };
	for (const e of dev.Elements) {
		if (e instanceof SubChipInstance) doc.subs[e.ID] = SubDocOf(CreateSubChipDescription(e));
		else if (e instanceof DevPinInstance) doc.pins[e.ID] = PinDocOf(e);
	}
	UpdateWireIndicesForDescriptionCreation(dev);
	const { keys, docs } = WireDocs(dev.Wires);
	for (let i = 0; i < keys.length; i++) doc.wires[keys[i]] = docs[i];
	return doc;
}

const WithoutPosition = (d: SubDoc | PinDoc) => CanonicalJson({ ...d, Position: null, state: null });

// Make the dev chip match the target doc. Returns true if anything changed.
// forceReplaceChipNames: subchips of these chips are re-created even if unchanged (their definition changed)
export function ReconcileDevChip(dev: DevChipInstance, target: ChipDoc, library: ChipLibrary, forceReplaceChipNames?: Set<string>): boolean {
	const cur = DocFromDevChip(dev);
	let changed = false;
	const byID = new Map<number, SubChipInstance | DevPinInstance>();
	for (const e of dev.Elements) if (e instanceof SubChipInstance || e instanceof DevPinInstance) byID.set(e.ID, e);

	const subsToAdd: SubDoc[] = [];
	const pinsToAdd: PinDoc[] = [];

	// ---- Subchips ----
	for (const [id, c] of Object.entries(cur.subs)) {
		const t = target.subs[id];
		const forced = forceReplaceChipNames?.has(c.Name.toUpperCase()) ?? false;
		if (!t || forced || WithoutPosition(c) !== WithoutPosition(t)) {
			dev.TryDeleteSubChipByID(Number(id));
			if (t) subsToAdd.push(t);
			changed = true;
		} else if (c.Position.x !== t.Position.x || c.Position.y !== t.Position.y) {
			byID.get(Number(id))!.Position = toVec(t.Position);
			changed = true;
		}
	}
	for (const [id, t] of Object.entries(target.subs)) if (!(id in cur.subs)) subsToAdd.push(t);

	// ---- Dev pins ----
	for (const [id, c] of Object.entries(cur.pins)) {
		const t = target.pins[id];
		if (!t || WithoutPosition(c) !== WithoutPosition(t)) {
			dev.TryDeleteDevPinByID(Number(id));
			if (t) pinsToAdd.push(t);
			changed = true;
		} else {
			const pin = byID.get(Number(id)) as DevPinInstance;
			if (c.Position.x !== t.Position.x || c.Position.y !== t.Position.y) {
				pin.Position = toVec(t.Position);
				changed = true;
			}
			if (c.state !== t.state && pin.IsInputPin) {
				pin.Pin.PlayerInputState = t.state;
				changed = true;
			}
		}
	}
	for (const [id, t] of Object.entries(target.pins)) if (!(id in cur.pins)) pinsToAdd.push(t);

	for (const t of subsToAdd) {
		const description = library.TryGetChipDescription(t.Name);
		if (!description) continue; // (chip not in library: skip, like a failed load)
		dev.AddNewSubChip(new SubChipInstance(description, SubDescOf(t)), false);
	}
	for (const t of pinsToAdd) {
		const pin = new DevPinInstance(PinDescOf(t), t.input);
		if (t.input) pin.Pin.PlayerInputState = t.state;
		dev.AddNewDevPin(pin, false);
	}

	// ---- Wires ----
	UpdateWireIndicesForDescriptionCreation(dev);
	const now = WireDocs(dev.Wires);
	const nowMap: Record<string, WireDoc> = {};
	for (let i = 0; i < now.keys.length; i++) nowMap[now.keys[i]] = now.docs[i];
	if (CanonicalJson(nowMap) !== CanonicalJson(target.wires)) {
		RebuildWires(dev, target.wires, now.keys);
		changed = true;
	}
	return changed;
}

const PairKey = (w: WireInstance) => `${w.SourcePin.Address.PinOwnerID}.${w.SourcePin.Address.PinID}>${w.TargetPin.Address.PinOwnerID}.${w.TargetPin.Address.PinID}`;

// Replace all wire instances, and only send the connections that actually changed to the simulation
function RebuildWires(dev: DevChipInstance, target: Record<string, WireDoc>, currentOrder: string[]) {
	const oldWires = dev.Wires.slice();
	dev.Wires.length = 0;

	const loaded: WireInstance[] = [];
	const indexOfKey = new Map<string, number>();
	for (const k of WireOrder(target, currentOrder)) {
		const d = target[k];
		const parentIndex = d.parent != null ? (indexOfKey.get(d.parent) ?? -1) : -1;
		const desc: WireDescription = {
			SourcePinAddress: { ...d.src },
			TargetPinAddress: { ...d.tgt },
			ConnectionType: parentIndex >= 0 ? d.type : 0,
			ConnectedWireIndex: parentIndex,
			ConnectedWireSegmentIndex: d.seg,
			Points: d.pts.map(toVec),
		};
		const [wire] = DevChipInstance.TryLoadWireFromDescription(desc, loaded.length, dev, loaded);
		if (!wire) continue;
		indexOfKey.set(k, loaded.length);
		loaded.push(wire);
	}
	dev.Wires.push(...loaded);

	// Simulation connections: multiset difference (removals first)
	const Count = (wires: WireInstance[]) => {
		const m = new Map<string, number>();
		for (const w of wires) m.set(PairKey(w), (m.get(PairKey(w)) ?? 0) + 1);
		return m;
	};
	const newCount = Count(loaded);
	for (const w of oldWires) {
		const k = PairKey(w);
		const n = newCount.get(k) ?? 0;
		if (n > 0) newCount.set(k, n - 1);
		else Simulator.RemoveConnection(dev.SimChip, w.SourcePin.Address, w.TargetPin.Address);
	}
	const oldCount = Count(oldWires);
	for (const w of loaded) {
		const k = PairKey(w);
		const n = oldCount.get(k) ?? 0;
		if (n > 0) oldCount.set(k, n - 1);
		else Simulator.AddConnection(dev.SimChip, w.SourcePin.Address, w.TargetPin.Address);
	}
}

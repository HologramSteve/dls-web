// Helpers for running the simulation core in Node tests (no worker)
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Serializer } from "../src/dls/description/Serializer";
import { CreateAllBuiltinChipDescriptions } from "../src/dls/game/BuiltinChipCreator";
import { ToSimDesc } from "../src/dls/simulation/SimHost";
import { Simulator } from "../src/dls/simulation/Simulator";
import type { SimChip } from "../src/dls/simulation/SimChip";
import { PinState } from "../src/dls/simulation/PinState";

const chipsDir = join(__dirname, "../testdata/Projects/MainTest/Chips");

export function loadTestLibrary() {
	Simulator.library.clear();
	for (const b of CreateAllBuiltinChipDescriptions()) Simulator.library.set(ToSimDesc(b));
	const descs = new Map<string, ReturnType<typeof Serializer.DeserializeChipDescription>>();
	for (const f of readdirSync(chipsDir)) {
		const d = Serializer.DeserializeChipDescription(readFileSync(join(chipsDir, f), "utf8"));
		descs.set(d.Name, d);
		Simulator.library.set(ToSimDesc(d));
	}
	return descs;
}

export function buildRoot(name: string, descs: ReturnType<typeof loadTestLibrary>) {
	const d = descs.get(name)!;
	Simulator.rootSimChip = Simulator.BuildSimChip(ToSimDesc(d));
	Simulator.needsOrderPass = true;
	return { desc: d, root: Simulator.rootSimChip as SimChip };
}

export function run(root: SimChip, inputs: number[], steps = 1) {
	const arr = new Int32Array(inputs.length * 2);
	inputs.forEach((s, i) => {
		arr[i * 2] = root.InputPins[i].ID;
		arr[i * 2 + 1] = s;
	});
	for (let i = 0; i < steps; i++) Simulator.RunSimulationStep(root, arr);
	return root.OutputPins.map((p) => PinState.GetBitStates(p.State));
}

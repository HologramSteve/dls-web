import { bench, describe } from "vitest";
import { buildRoot, loadTestLibrary, run } from "./simHelpers";

// Simulation step throughput on chips from the original's test project (flattened size in brackets).
// Each iteration runs 100 steps, so steps/s = hz * 100. Inputs change every iteration and the clock input
// (if any) toggles, so the circuit is doing real work rather than sitting in a settled state.
const StepsPerIteration = 100;

describe("simulation step throughput (100 steps per iteration)", () => {
	const descs = loadTestLibrary();
	const chips = [
		"ALU-8", // ~350 NANDs
		"PC", // ~1.2k NANDs
		"demo", // ~1.1k NANDs + displays
		"WIP2", // ~5.7k NANDs
		"RAM-sync", // ~24k NANDs, ~26.6k builtin chips, ~96k wires
	];
	for (const name of chips) {
		if (!descs.has(name)) continue;
		const { root, desc } = buildRoot(name, descs);
		const clockIndex = desc.InputPins.findIndex((p) => p.Name.toUpperCase().includes("CLOCK"));
		const ins = root.InputPins.map(() => 0);
		run(root, ins, 10);
		let t = 0;
		bench(name, () => {
			t++;
			for (let i = 0; i < ins.length; i++) ins[i] = (t * 37 + i * 11) & 0xff;
			if (clockIndex >= 0) ins[clockIndex] = t & 1;
			for (let i = 0; i < ins.length; i++) if (desc.InputPins[i].BitCount === 1) ins[i] &= 1;
			run(root, ins, StepsPerIteration);
		});
	}
});

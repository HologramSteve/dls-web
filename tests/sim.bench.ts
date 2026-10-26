import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bench, describe } from "vitest";
import { CreateAllBuiltinChipDescriptions } from "../src/dls/game/BuiltinChipCreator";
import { ToSimDesc } from "../src/dls/simulation/SimHost";
import { WasmEngine } from "../src/worker/engines";
import { buildRoot, loadTestLibrary, run } from "./simHelpers";

// Simulation step throughput on chips from the original's test project.
// Each iteration runs 100 steps, so steps/s = hz * 100. Inputs change every iteration and the clock input
// (if any) toggles, so the circuit is doing real work rather than sitting in a settled state.
// Engines: "js" = TS port of the original simulator; "wasm" = Rust engine (rust/dls-sim) as WebAssembly,
// with and without truth tables.
const StepsPerIteration = 100;
const chips = [
	"ALU-8", // ~350 NANDs
	"PC", // ~1.2k NANDs
	"demo", // ~1.1k NANDs + displays
	"WIP2", // ~5.7k NANDs
	"RAM-sync", // ~24k NANDs, ~26.6k builtin chips, ~96k wires
];

const descs = loadTestLibrary();
const simLib = [...CreateAllBuiltinChipDescriptions().map(ToSimDesc), ...Array.from(descs.values(), ToSimDesc)];
const wasmBytes = readFileSync(join(__dirname, "../src/worker/dls_sim.wasm"));

function inputPattern(desc: ReturnType<typeof loadTestLibrary> extends Map<string, infer D> ? D : never, t: number): number[] {
	const clockIndex = desc.InputPins.findIndex((p) => p.Name.toUpperCase().includes("CLOCK"));
	return desc.InputPins.map((p, i) => {
		if (i === clockIndex) return t & 1;
		const v = (t * 37 + i * 11) & 0xff;
		return p.BitCount === 1 ? v & 1 : v & ((1 << p.BitCount) - 1);
	});
}

for (const name of chips) {
	const desc = descs.get(name);
	if (!desc) continue;
	describe(name, async () => {
		// JS engine
		const { root } = buildRoot(name, descs);
		run(root, inputPattern(desc, 0), 10);
		let tj = 0;
		bench("js", () => {
			run(root, inputPattern(desc, ++tj), StepsPerIteration);
		});

		// Rust engine (WebAssembly)
		for (const tables of [false, true]) {
			const e = await WasmEngine.create(wasmBytes, { tables, seed: 7 });
			e.applyCommands([
				{ type: "LibrarySet", descs: simLib, replaceAll: true },
				{ type: "BuildRoot", desc: ToSimDesc(desc) },
			]);
			const ids = desc.InputPins.map((p) => p.ID);
			const setInputs = (t: number) => {
				const vals = inputPattern(desc, t);
				const arr = new Int32Array(ids.length * 2);
				ids.forEach((id, i) => {
					arr[i * 2] = id;
					arr[i * 2 + 1] = vals[i];
				});
				e.setInputs(arr);
			};
			setInputs(0);
			e.step(10);
			let t = 0;
			bench(tables ? "wasm + tables" : "wasm", () => {
				setInputs(++t);
				e.step(StepsPerIteration);
			});
		}
	});
}

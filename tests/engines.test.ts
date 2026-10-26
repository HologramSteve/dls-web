// Runs the same behavioural tests against every simulation engine the worker can use:
// the TS port of the original simulator, and the Rust engine compiled to WebAssembly (with/without truth tables).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ChipType } from "../src/dls/description/Types";
import { CreateAllBuiltinChipDescriptions } from "../src/dls/game/BuiltinChipCreator";
import type { SimChipDesc } from "../src/dls/simulation/SimChip";
import { ToSimDesc } from "../src/dls/simulation/SimHost";
import { JsEngine, type SimEngine, WasmEngine } from "../src/worker/engines";
import { loadTestLibrary } from "./simHelpers";

const wasmBytes = readFileSync(join(__dirname, "../src/worker/dls_sim.wasm"));

function libraryDescs(): SimChipDesc[] {
	const descs = CreateAllBuiltinChipDescriptions().map(ToSimDesc);
	for (const d of loadTestLibrary().values()) descs.push(ToSimDesc(d));
	return descs;
}

const lib = libraryDescs();
const byName = new Map(lib.map((d) => [d.Name, d]));

type Factory = () => Promise<SimEngine>;
const engines: [string, Factory][] = [
	["js", async () => new JsEngine()],
	["rust (tables)", () => WasmEngine.create(wasmBytes, { tables: true, seed: 1 })],
	["rust (no tables)", () => WasmEngine.create(wasmBytes, { tables: false, seed: 2 })],
	["rust (reference step)", () => WasmEngine.create(wasmBytes, { tables: false, fastPath: false, seed: 3 })],
];

// Root chip runner on top of the engine interface (like tests/simHelpers.run)
async function setup(make: Factory, root: SimChipDesc) {
	const e = await make();
	const err = e.applyCommands([
		{ type: "LibrarySet", descs: lib, replaceAll: true },
		{ type: "BuildRoot", desc: root },
	]);
	expect(err).toBeNull();
	e.setStepsPerClockTransition(2);
	const run = (inputs: number[], steps: number): number[] => {
		const arr = new Int32Array(inputs.length * 2);
		inputs.forEach((s, i) => {
			arr[i * 2] = root.InputPinIDs[i];
			arr[i * 2 + 1] = s;
		});
		e.setInputs(arr);
		e.step(steps);
		const snap = e.snapshotView([]);
		const states = new Map<number, number>();
		for (let i = 0; i < snap.pins.length; i += 5) if (snap.pins[i + 1] === 0) states.set(snap.pins[i], snap.pins[i + 2]);
		return root.OutputPinIDs.map((id) => (states.get(id) ?? 0) & 0xffff);
	};
	return { e, run };
}

for (const [engineName, make] of engines) {
	describe(`engine: ${engineName}`, () => {
		it("ADDER-8 and ALU-8", async () => {
			const { run } = await setup(make, byName.get("ADDER-8")!);
			for (const [a, b] of [
				[3, 4],
				[100, 27],
				[200, 100],
				[255, 1],
			])
				expect(run([a, b, 0], 40)[0]).toBe((a + b) & 255);
		});

		it("REGISTER-8 stores on clock", async () => {
			const { run } = await setup(make, byName.get("REGISTER-8")!);
			const clock = (data: number, store: number) => {
				run([data, store, 0], 40);
				run([data, store, 1], 40);
				return run([data, store, 0], 40)[0];
			};
			expect(clock(173, 1)).toBe(173);
			expect(clock(42, 0)).toBe(173);
			expect(clock(42, 1)).toBe(42);
		});

		it("PC increments, loads and resets", async () => {
			const { run } = await setup(make, byName.get("PC")!);
			const tick = (inp: number, store: number, inc: number, reset: number) => {
				run([inp, store, 0, inc, reset], 80);
				run([inp, store, 1, inc, reset], 80);
				return run([inp, store, 0, inc, reset], 80)[0];
			};
			tick(0, 0, 0, 1);
			expect(tick(0, 0, 1, 0)).toBe(1);
			expect(tick(0, 0, 1, 0)).toBe(2);
			expect(tick(50, 1, 0, 0)).toBe(50);
			expect(tick(0, 0, 1, 0)).toBe(51);
			expect(tick(0, 0, 0, 1)).toBe(0);
		});

		it("RAM-sync writes and reads back", async () => {
			const { run } = await setup(make, byName.get("RAM-sync")!);
			const write = (addr: number, data: number) => {
				run([1, 0, addr, data], 60);
				run([1, 1, addr, data], 60);
				run([0, 0, addr, data], 60);
			};
			write(3, 99);
			write(200, 7);
			write(3, 12);
			expect(run([0, 0, 3, 0], 60)[0]).toBe(12);
			expect(run([0, 0, 200, 0], 60)[0]).toBe(7);
		});

		it("ROM, display data and edits", async () => {
			// Root with an IN-8 -> ROM -> OUT-8 and an RGB display
			const root: SimChipDesc = { Name: "T", ChipType: ChipType.Custom, InputPinIDs: [1], OutputPinIDs: [2], InputPinBits: [8], OutputPinBits: [8], SubChips: [], Wires: [] };
			const { e, run } = await setup(make, root);
			const rom = new Array(256).fill(0);
			rom[7] = 0x1234;
			e.applyCommands([
				{ type: "AddSubchip", target: [], chipName: "ROM 256×16", subChipID: 10, internalData: rom },
				{ type: "AddConnection", target: [], source: { PinOwnerID: 1, PinID: 0 }, dest: { PinOwnerID: 10, PinID: 0 } },
				{ type: "AddConnection", target: [], source: { PinOwnerID: 10, PinID: 2 }, dest: { PinOwnerID: 2, PinID: 0 } },
				{ type: "AddSubchip", target: [], chipName: "RGB DISPLAY", subChipID: 20, internalData: null },
			]);
			expect(run([7], 3)[0]).toBe(0x34);
			e.applyCommands([{ type: "SetInternalState", target: [10], index: 7, value: 0x0099 }]);
			expect(run([7], 3)[0]).toBe(0x99);
			const disp = e.display([20]);
			expect(disp?.internal.length).toBe(513);
			expect(disp?.inputs.length).toBe(8);
			const snap = e.snapshotView([]);
			expect(Array.from(snap.subChipIDs).sort()).toEqual([10, 20]);
			e.applyCommands([{ type: "RemoveSubChip", target: [], id: 20 }]);
			expect(Array.from(e.snapshotView([]).subChipIDs)).toEqual([10]);
			expect(e.snapshotView([99]).valid).toBe(false);
		});

		it("KEY chip follows held keys", async () => {
			const root: SimChipDesc = { Name: "K", ChipType: ChipType.Custom, InputPinIDs: [], OutputPinIDs: [2], InputPinBits: [], OutputPinBits: [1], SubChips: [], Wires: [] };
			const { e, run } = await setup(make, root);
			e.applyCommands([
				{ type: "AddSubchip", target: [], chipName: "KEY", subChipID: 10, internalData: ["Q".charCodeAt(0)] },
				{ type: "AddConnection", target: [], source: { PinOwnerID: 10, PinID: 0 }, dest: { PinOwnerID: 2, PinID: 0 } },
			]);
			expect(run([], 3)[0]).toBe(0);
			e.setKeys("Q");
			expect(run([], 3)[0]).toBe(1);
			e.setKeys("");
			expect(run([], 3)[0]).toBe(0);
		});
	});
}

describe("rust engine matches the JS engine step by step", () => {
	for (const name of ["ALU-8", "DOUBLE DABBLE", "MUX-8", "EQUALS-8", "7-SEGMENT DRIVER", "DECODE-3"]) {
		it(name, async () => {
			const desc = byName.get(name)!;
			const js = await setup(engines[0][1], desc);
			const rust = await setup(engines[1][1], desc);
			let seed = 12345;
			const rand = () => {
				seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
				return seed >>> 8;
			};
			for (let step = 0; step < 300; step++) {
				const ins = (desc.InputPinBits ?? []).map((b) => rand() & ((1 << b) - 1));
				expect(rust.run(ins, 1)).toEqual(js.run(ins, 1));
			}
		});
	}
});

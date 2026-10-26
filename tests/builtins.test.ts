import { describe, expect, it } from "vitest";
import { ChipType } from "../src/dls/description/Types";
import { PinState } from "../src/dls/simulation/PinState";
import type { SimChip, SimChipDesc } from "../src/dls/simulation/SimChip";
import { Simulator } from "../src/dls/simulation/Simulator";
import { loadTestLibrary } from "./simHelpers";

// Wire: [sourceOwnerID, sourcePinID, targetOwnerID, targetPinID]. Dev pins use PinID 0 and their own ID as owner.
type W = [number, number, number, number];

function build(ins: number[], outs: number[], subs: { Name: string; ID: number; InternalData?: number[] }[], wires: W[]): SimChip {
	const desc: SimChipDesc = {
		Name: "TEST",
		ChipType: ChipType.Custom,
		InputPinIDs: ins,
		OutputPinIDs: outs,
		SubChips: subs.map((s) => ({ Name: s.Name, ID: s.ID, InternalData: s.InternalData ?? null })),
		Wires: wires.map(([a, b, c, d]) => ({ Source: { PinOwnerID: a, PinID: b }, Target: { PinOwnerID: c, PinID: d } })),
	};
	Simulator.rootSimChip = Simulator.BuildSimChip(desc);
	Simulator.needsOrderPass = true;
	return Simulator.rootSimChip as SimChip;
}

function step(root: SimChip, inputs: number[], steps = 4): number[] {
	const arr = new Int32Array(inputs.length * 2);
	inputs.forEach((s, i) => {
		arr[i * 2] = root.InputPins[i].ID;
		arr[i * 2 + 1] = s;
	});
	for (let i = 0; i < steps; i++) Simulator.RunSimulationStep(root, arr);
	return root.OutputPins.map((p) => p.State);
}

describe("builtin chips", () => {
	loadTestLibrary();

	it("ROM outputs the high and low byte of the addressed word", () => {
		const rom = new Array(256).fill(0);
		rom[5] = 0xab12;
		rom[255] = 0x00ff;
		const root = build([1], [2, 3], [{ Name: "ROM 256×16", ID: 10, InternalData: rom }], [
			[1, 0, 10, 0],
			[10, 1, 2, 0],
			[10, 2, 3, 0],
		]);
		expect(step(root, [5])).toEqual([0xab, 0x12]);
		expect(step(root, [255])).toEqual([0x00, 0xff]);
		expect(step(root, [0])).toEqual([0, 0]);
	});

	it("8-1BIT split and 1-8BIT merge round trip (MSB first)", () => {
		const wires: W[] = [[1, 0, 10, 0]];
		for (let i = 0; i < 8; i++) wires.push([10, 1 + i, 20, i]);
		wires.push([20, 8, 2, 0]);
		wires.push([10, 1, 3, 0]); // first split output = MSB
		const root = build([1], [2, 3], [{ Name: "8-1BIT", ID: 10 }, { Name: "1-8BIT", ID: 20 }], wires);
		for (const v of [0, 1, 0x80, 0x5a, 0xff]) {
			const [merged, msb] = step(root, [v]);
			expect(PinState.GetBitStates(merged)).toBe(v);
			expect(msb & 1).toBe(v >> 7);
		}
	});

	it("4-8BIT merge and 8-4BIT split", () => {
		const root = build([1, 2], [3, 4], [{ Name: "4-8BIT", ID: 10 }, { Name: "8-4BIT", ID: 20 }], [
			[1, 0, 10, 0],
			[2, 0, 10, 1],
			[10, 2, 20, 0],
			[20, 1, 3, 0],
			[20, 2, 4, 0],
		]);
		const [a, b] = step(root, [0x3, 0xc]);
		expect(new Set([PinState.GetBitStates(a), PinState.GetBitStates(b)])).toEqual(new Set([0x3, 0xc]));
	});

	it("3-state buffers share a line: enabled one drives, both disabled floats", () => {
		const buf = "3-STATE BUFFER";
		// inputs: A, enA, B, enB ; output: line
		const root = build([1, 2, 3, 4], [5], [{ Name: buf, ID: 10 }, { Name: buf, ID: 20 }], [
			[1, 0, 10, 0],
			[2, 0, 10, 1],
			[3, 0, 20, 0],
			[4, 0, 20, 1],
			[10, 2, 5, 0],
			[20, 2, 5, 0],
		]);
		expect(step(root, [1, 1, 0, 0])[0]).toBe(PinState.LogicHigh);
		expect(step(root, [1, 0, 0, 1])[0]).toBe(PinState.LogicLow);
		expect(PinState.GetTristateFlags(step(root, [1, 0, 1, 0])[0])).not.toBe(0);
	});

	it("PULSE emits a fixed-length pulse on the rising edge", () => {
		const root = build([1], [2], [{ Name: "PULSE", ID: 10, InternalData: [3, 0, 0] }], [
			[1, 0, 10, 0],
			[10, 1, 2, 0],
		]);
		step(root, [0], 2);
		const trace: number[] = [];
		for (let i = 0; i < 8; i++) trace.push(step(root, [1], 1)[0] & 1);
		expect(trace.reduce((a, b) => a + b, 0)).toBe(3);
		expect(trace.slice(-3)).toEqual([0, 0, 0]);
	});

	it("CLOCK toggles with stepsPerClockTransition", () => {
		const root = build([], [2], [{ Name: "CLOCK", ID: 10 }], [[10, 0, 2, 0]]);
		const prev = Simulator.stepsPerClockTransition;
		Simulator.stepsPerClockTransition = 2;
		const seen = new Set<number>();
		for (let i = 0; i < 10; i++) seen.add(step(root, [], 1)[0] & 1);
		Simulator.stepsPerClockTransition = prev;
		expect(seen).toEqual(new Set([0, 1]));
	});

	it("KEY is high only while its key is held", () => {
		const root = build([], [2], [{ Name: "KEY", ID: 10, InternalData: ["K".charCodeAt(0)] }], [[10, 0, 2, 0]]);
		Simulator.heldKeys.clear();
		expect(step(root, [])[0] & 1).toBe(0);
		Simulator.heldKeys.add("K");
		expect(step(root, [])[0] & 1).toBe(1);
		Simulator.heldKeys.clear();
		expect(step(root, [])[0] & 1).toBe(0);
	});

	it("BUS origin drives its output line (terminus is a sink)", () => {
		const root = build([1], [2], [{ Name: "BUS-8", ID: 10, InternalData: [20] }, { Name: "BUS-TERMINUS-8", ID: 20, InternalData: [10] }], [
			[1, 0, 10, 0],
			[10, 1, 20, 0],
			[10, 1, 2, 0],
		]);
		expect(PinState.GetBitStates(step(root, [0x42], 8)[0])).toBe(0x42);
	});

	it("dev.RAM-8 writes on clock and reads back", () => {
		// ADDRESS, DATA, WRITE, RESET, CLOCK -> OUT
		const root = build([1, 2, 3, 4, 5], [6], [{ Name: "dev.RAM-8", ID: 10 }], [
			[1, 0, 10, 0],
			[2, 0, 10, 1],
			[3, 0, 10, 2],
			[4, 0, 10, 3],
			[5, 0, 10, 4],
			[10, 5, 6, 0],
		]);
		step(root, [9, 77, 1, 0, 0]);
		step(root, [9, 77, 1, 0, 1]);
		step(root, [9, 0, 0, 0, 0]);
		expect(PinState.GetBitStates(step(root, [9, 0, 0, 0, 0])[0])).toBe(77);
	});
});

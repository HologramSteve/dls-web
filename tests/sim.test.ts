import { describe, expect, it } from "vitest";
import { buildRoot, loadTestLibrary, run } from "./simHelpers";

describe("simulator (original test project chips)", () => {
	const descs = loadTestLibrary();

	it("AND truth table", () => {
		const { root } = buildRoot("AND", descs);
		for (const [a, b] of [[0, 0], [0, 1], [1, 0], [1, 1]]) {
			expect(run(root, [a, b], 4)).toEqual([a & b]);
		}
	});

	it("XOR truth table", () => {
		const { root } = buildRoot("XOR", descs);
		for (const [a, b] of [[0, 0], [0, 1], [1, 0], [1, 1]]) {
			expect(run(root, [a, b], 8)).toEqual([a ^ b]);
		}
	});

	it("full ADDER", () => {
		const { root, desc } = buildRoot("ADDER", descs);
		const names = desc.OutputPins.map((p) => p.Name);
		for (let v = 0; v < 8; v++) {
			const a = v & 1, b = (v >> 1) & 1, c = (v >> 2) & 1;
			const out = run(root, [a, b, c], 12);
			const sum = a + b + c;
			expect(out[names.indexOf("SUM")]).toBe(sum & 1);
			expect(out[names.indexOf("CARRY")]).toBe(sum >> 1);
		}
	});

	it("ADDER-8 (multi-bit pins, merge/split)", () => {
		const { root } = buildRoot("ADDER-8", descs);
		for (const [a, b] of [[3, 4], [100, 27], [200, 100], [255, 1]]) {
			const out = run(root, [a, b, 0], 40);
			expect(out[0]).toBe((a + b) & 255);
		}
	});
});

import { describe, expect, it } from "vitest";
import { buildRoot, loadTestLibrary, run } from "./simHelpers";

// Behavioural tests of the original MainTest project's chips (sequential logic, memory, multi-bit buses)
describe("MainTest chips", () => {
	const descs = loadTestLibrary();

	it("every chip builds and simulates without throwing", () => {
		for (const name of descs.keys()) {
			const { root } = buildRoot(name, descs);
			expect(() => run(root, root.InputPins.map(() => 0), 20)).not.toThrow();
		}
	});

	it("D-LATCH stores while STORE is high and holds otherwise", () => {
		const { root } = buildRoot("D-LATCH", descs);
		expect(run(root, [1, 1], 10)).toEqual([1]);
		expect(run(root, [0, 0], 10)).toEqual([1]);
		expect(run(root, [0, 1], 10)).toEqual([0]);
		expect(run(root, [1, 0], 10)).toEqual([0]);
	});

	it("FLIP-FLOP captures DATA on the clock edge", () => {
		const { root } = buildRoot("FLIP-FLOP", descs);
		run(root, [1, 0], 20);
		run(root, [1, 1], 20);
		expect(run(root, [0, 1], 20)).toEqual([1]);
		expect(run(root, [0, 0], 20)).toEqual([1]);
		run(root, [0, 1], 20);
		expect(run(root, [1, 0], 20)).toEqual([0]);
	});

	it("REGISTER-8 stores a byte only when STORE is set on a clock pulse", () => {
		const { root } = buildRoot("REGISTER-8", descs);
		const clock = (data: number, store: number) => {
			run(root, [data, store, 0], 40);
			run(root, [data, store, 1], 40);
			return run(root, [data, store, 0], 40)[0];
		};
		expect(clock(173, 1)).toBe(173);
		expect(clock(42, 0)).toBe(173);
		expect(clock(42, 1)).toBe(42);
	});

	it("DECODE-3 activates exactly one output", () => {
		const { root, desc } = buildRoot("DECODE-3", descs);
		const names = desc.OutputPins.map((p) => p.Name);
		for (let v = 0; v < 8; v++) {
			const out = run(root, [(v >> 2) & 1, (v >> 1) & 1, v & 1], 20);
			expect(out.reduce((a, b) => a + b, 0)).toBe(1);
			expect(out[names.indexOf(String(v))]).toBe(1);
		}
	});

	it("MUX-8 selects between two bytes", () => {
		const { root } = buildRoot("MUX-8", descs);
		const a = run(root, [11, 200, 0], 30)[0];
		const b = run(root, [11, 200, 1], 30)[0];
		expect(new Set([a, b])).toEqual(new Set([11, 200]));
	});

	it("EQUALS-8", () => {
		const { root } = buildRoot("EQUALS-8", descs);
		expect(run(root, [77, 77], 30)).toEqual([1]);
		expect(run(root, [77, 76], 30)).toEqual([0]);
		expect(run(root, [0, 128], 30)).toEqual([0]);
	});

	it("LSHIFT-8", () => {
		const { root } = buildRoot("LSHIFT-8", descs);
		for (const v of [1, 5, 64, 129]) expect(run(root, [v], 20)[0]).toBe((v << 1) & 255);
	});

	it("DOUBLE DABBLE converts a byte to BCD", () => {
		const { root } = buildRoot("DOUBLE DABBLE", descs);
		const bcd = (v: number) => {
			const bits = [7, 6, 5, 4, 3, 2, 1, 0].map((i) => (v >> i) & 1); // A = MSB
			const out = run(root, bits, 200);
			return out.reduce((acc, b) => acc * 2 + b, 0);
		};
		for (const v of [0, 7, 42, 99, 128, 255]) {
			const digits = (Math.floor(v / 100) << 8) | (Math.floor(v / 10) % 10 << 4) | v % 10;
			expect(bcd(v)).toBe(digits);
		}
	});

	it("RAM-sync writes and reads back several addresses", () => {
		const { root } = buildRoot("RAM-sync", descs);
		const write = (addr: number, data: number) => {
			run(root, [1, 0, addr, data], 60);
			run(root, [1, 1, addr, data], 60);
			run(root, [0, 0, addr, data], 60);
		};
		const read = (addr: number) => run(root, [0, 0, addr, 0], 60)[0];
		write(3, 99);
		write(200, 7);
		write(3, 12); // overwrite
		expect(read(3)).toBe(12);
		expect(read(200)).toBe(7);
	});

	it("PC increments, loads and resets", () => {
		const { root } = buildRoot("PC", descs);
		// inputs: IN-8, STORE, CLOCK, INCREMENT, RESET
		const tick = (inp: number, store: number, inc: number, reset: number) => {
			run(root, [inp, store, 0, inc, reset], 80);
			run(root, [inp, store, 1, inc, reset], 80);
			return run(root, [inp, store, 0, inc, reset], 80)[0];
		};
		tick(0, 0, 0, 1);
		expect(tick(0, 0, 0, 0)).toBe(0);
		expect(tick(0, 0, 1, 0)).toBe(1);
		expect(tick(0, 0, 1, 0)).toBe(2);
		expect(tick(50, 1, 0, 0)).toBe(50);
		expect(tick(0, 0, 1, 0)).toBe(51);
		expect(tick(0, 0, 0, 1)).toBe(0);
	});
});

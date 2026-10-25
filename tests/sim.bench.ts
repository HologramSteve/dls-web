import { bench, describe } from "vitest";
import { buildRoot, loadTestLibrary, run } from "./simHelpers";

describe("simulation step throughput", () => {
	const descs = loadTestLibrary();
	for (const name of ["ADDER-8", "ALU-8", "CONTROL UNIT"]) {
		if (!descs.has(name)) continue;
		const { root } = buildRoot(name, descs);
		const ins = root.InputPins.map(() => 1);
		run(root, ins, 10);
		bench(`${name} x100 steps`, () => {
			run(root, ins, 100);
		});
	}
});

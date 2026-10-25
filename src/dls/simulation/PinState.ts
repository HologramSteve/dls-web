// Port of DLS.Simulation.PinState
// Pin state is stored as a 32 bit value, with format:
// Tristate flags (most significant 16 bits) | Bit states (least significant 16 bits)
// NOTE (JS): states are always kept in signed int32 representation (results of bitwise ops),
// so that equality comparisons between states are consistent.
export const PinState = {
	// Each bit has three possible states (tri-state logic):
	LogicLow: 0,
	LogicHigh: 1,
	LogicDisconnected: 2,

	// Mask for single bit value (bit state, and tristate flag)
	SingleBitMask: 1 | (1 << 16),

	// All bits disconnected (tristate flags all set, bit states zero)
	AllDisconnected: (0xffff << 16) | 0,

	GetBitStates(state: number): number {
		return state & 0xffff;
	},

	GetTristateFlags(state: number): number {
		return (state >>> 16) & 0xffff;
	},

	Make(bitStates: number, tristateFlags: number): number {
		return (bitStates & 0xffff) | ((tristateFlags & 0xffff) << 16);
	},

	GetBitTristatedValue(state: number, bitIndex: number): number {
		const bitState = ((state & 0xffff) >>> bitIndex) & 1;
		const tri = ((state >>> 16) >>> bitIndex) & 1;
		return bitState | (tri << 1); // 0 = LOW, 1 = HIGH, 2 = DISCONNECTED
	},

	FirstBitHigh(state: number): boolean {
		return (state & 1) === 1;
	},

	Get4BitFrom8BitSource(source8bit: number, firstNibble: boolean): number {
		const bits = source8bit & 0xffff;
		const tri = (source8bit >>> 16) & 0xffff;
		if (firstNibble) return PinState.Make(bits & 0b1111, tri & 0b1111);
		return PinState.Make((bits & 0b11110000) >>> 4, (tri & 0b11110000) >>> 4);
	},

	Get8BitFrom4BitSources(a: number, b: number): number {
		const bitStates = (a & 0xffff) | ((b & 0xffff) << 4);
		const triFlags = (((a >>> 16) & 0b1111) | (((b >>> 16) & 0b1111) << 4)) & 0xffff;
		return PinState.Make(bitStates, triFlags);
	},

	// Toggle a bit (clears tristate flags, since only input dev pins are allowed to be toggled)
	Toggle(state: number, bitIndex: number): number {
		const bitStates = (state & 0xffff) ^ (1 << bitIndex);
		return PinState.Make(bitStates, 0);
	},
};

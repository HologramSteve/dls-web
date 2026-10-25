// Port of the subset of UnityEngine.Mathf used by DLS.
export const Mathf = {
	Deg2Rad: Math.PI / 180,

	Clamp(v: number, min: number, max: number): number {
		return v < min ? min : v > max ? max : v;
	},

	Clamp01(v: number): number {
		return v < 0 ? 0 : v > 1 ? 1 : v;
	},

	// Clamped lerp
	Lerp(a: number, b: number, t: number): number {
		return a + (b - a) * Mathf.Clamp01(t);
	},

	InverseLerp(a: number, b: number, v: number): number {
		if (a !== b) return Mathf.Clamp01((v - a) / (b - a));
		return 0;
	},

	// Mathf.RoundToInt uses banker's rounding (round half to even)
	RoundToInt(v: number): number {
		return roundHalfEven(v);
	},

	Round(v: number): number {
		return roundHalfEven(v);
	},

	Sign(v: number): number {
		return v >= 0 ? 1 : -1;
	},

	Abs: Math.abs,
	Min: Math.min,
	Max: Math.max,
	Sqrt: Math.sqrt,
	Cos: Math.cos,
	Sin: Math.sin,
	Pow: Math.pow,
};

export function roundHalfEven(v: number): number {
	const r = Math.round(v);
	// Math.round rounds .5 towards +inf; fix up exact halves to nearest even
	if (Math.abs(v % 1) === 0.5) {
		return 2 * Math.round(v / 2);
	}
	return r;
}

// Math.Round(value, digits) (banker's rounding, as used by .NET by default)
export function roundDigits(v: number, digits: number): number {
	const m = Math.pow(10, digits);
	const scaled = v * m;
	// Use toPrecision to reduce float noise before rounding
	const s = Number(scaled.toPrecision(15));
	return roundHalfEven(s) / m;
}

// C# integer division / int cast truncates toward zero
export function truncInt(v: number): number {
	return Math.trunc(v);
}

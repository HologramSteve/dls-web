// Immutable RGBA colour (port of UnityEngine.Color semantics used by DLS).
export class Color {
	readonly r: number;
	readonly g: number;
	readonly b: number;
	readonly a: number;

	constructor(r: number, g: number, b: number, a = 1) {
		this.r = r;
		this.g = g;
		this.b = b;
		this.a = a;
	}

	static readonly white = new Color(1, 1, 1, 1);
	static readonly black = new Color(0, 0, 0, 1);
	static readonly clear = new Color(0, 0, 0, 0);
	static readonly red = new Color(1, 0, 0, 1);
	static readonly green = new Color(0, 1, 0, 1);
	static readonly blue = new Color(0, 0, 1, 1);
	static readonly magenta = new Color(1, 0, 1, 1);
	static readonly yellow = new Color(1, 0.92156863, 0.015686275, 1);
	static readonly gray = new Color(0.5, 0.5, 0.5, 1);
	static readonly grey = Color.gray;

	// Operators (note: like Unity, these apply to the alpha channel too)
	add(o: Color): Color {
		return new Color(this.r + o.r, this.g + o.g, this.b + o.b, this.a + o.a);
	}

	mul(s: number): Color {
		return new Color(this.r * s, this.g * s, this.b * s, this.a * s);
	}

	withAlpha(a: number): Color {
		return new Color(this.r, this.g, this.b, a);
	}

	equals(o: Color): boolean {
		return this.r === o.r && this.g === o.g && this.b === o.b && this.a === o.a;
	}

	static lerp(a: Color, b: Color, t: number): Color {
		t = t < 0 ? 0 : t > 1 ? 1 : t;
		return new Color(a.r + (b.r - a.r) * t, a.g + (b.g - a.g) * t, a.b + (b.b - a.b) * t, a.a + (b.a - a.a) * t);
	}

	static RGBToHSV(col: Color): [number, number, number] {
		if (col.b > col.g && col.b > col.r) return rgbToHsvHelper(4, col.b, col.r, col.g);
		if (col.g > col.r) return rgbToHsvHelper(2, col.g, col.b, col.r);
		return rgbToHsvHelper(0, col.r, col.g, col.b);
	}

	static HSVToRGB(H: number, S: number, V: number, hdr = true): Color {
		let r = 1;
		let g = 1;
		let b = 1;
		if (S === 0) {
			r = g = b = V;
		} else if (V === 0) {
			r = g = b = 0;
		} else {
			const hToFloor = H * 6;
			const temp = Math.floor(hToFloor);
			const t = hToFloor - temp;
			const var1 = V * (1 - S);
			const var2 = V * (1 - S * t);
			const var3 = V * (1 - S * (1 - t));
			switch (temp) {
				case 0:
					r = V;
					g = var3;
					b = var1;
					break;
				case 1:
					r = var2;
					g = V;
					b = var1;
					break;
				case 2:
					r = var1;
					g = V;
					b = var3;
					break;
				case 3:
					r = var1;
					g = var2;
					b = V;
					break;
				case 4:
					r = var3;
					g = var1;
					b = V;
					break;
				case 5:
					r = V;
					g = var1;
					b = var2;
					break;
				case 6:
					r = V;
					g = var3;
					b = var1;
					break;
				case -1:
					r = V;
					g = var1;
					b = var2;
					break;
			}
			if (!hdr) {
				r = Math.min(1, Math.max(0, r));
				g = Math.min(1, Math.max(0, g));
				b = Math.min(1, Math.max(0, b));
			}
		}
		return new Color(r, g, b, 1);
	}

	// ColorUtility.ToHtmlStringRGBA
	toHtmlStringRGBA(): string {
		const h = (v: number) =>
			Math.round(Math.min(1, Math.max(0, v)) * 255)
				.toString(16)
				.toUpperCase()
				.padStart(2, "0");
		return h(this.r) + h(this.g) + h(this.b) + h(this.a);
	}
}

function rgbToHsvHelper(offset: number, dominant: number, colorOne: number, colorTwo: number): [number, number, number] {
	const V = dominant;
	let H = 0;
	let S = 0;
	if (V !== 0) {
		const small = colorOne > colorTwo ? colorTwo : colorOne;
		const diff = V - small;
		if (diff !== 0) {
			S = diff / V;
			H = offset + (colorOne - colorTwo) / diff;
		} else {
			S = 0;
			H = offset + (colorOne - colorTwo);
		}
		H /= 6;
		if (H < 0) H += 1;
	}
	return [H, S, V];
}

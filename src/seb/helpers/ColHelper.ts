// Port of Seb.Helpers.ColHelper
import { Color } from "../types/Color";
import { Mathf } from "../types/Mathf";

export function WithAlpha(col: Color, a: number): Color {
	return new Color(col.r, col.g, col.b, a);
}

export function MakeCol(value: number): Color;
export function MakeCol(r: number, g: number, b: number): Color;
export function MakeCol(hex: string): Color;
export function MakeCol(a: number | string, g?: number, b?: number): Color {
	if (typeof a === "string") {
		return TryParseHexCode(a).col;
	}
	if (g === undefined) return new Color(a, a, a, 1);
	return new Color(a, g, b!, 1);
}

export function MakeCol255(r: number, g?: number, b?: number, a = 255): Color {
	if (g === undefined) return new Color(r / 255, r / 255, r / 255, 1);
	return new Color(r / 255, g / 255, b! / 255, a / 255);
}

// Parse hex code. Can be in format "RRGGBBAA" or "RRGGBB". Doesn't matter if code starts with # or not.
export function TryParseHexCode(code: string): { success: boolean; col: Color } {
	const fail = { success: false, col: Color.magenta };
	if (code.length === 0) return fail;
	if (code[0] === "#") code = code.substring(1);
	if (code.length !== 6 && code.length !== 8) return fail;
	if (!/^[0-9a-fA-F]+$/.test(code)) return fail;

	const r = parseInt(code.substring(0, 2), 16);
	const g = parseInt(code.substring(2, 4), 16);
	const b = parseInt(code.substring(4, 6), 16);
	const a = code.length === 8 ? parseInt(code.substring(6, 8), 16) : 255;
	const s = 1 / 255;
	return { success: true, col: new Color(r * s, g * s, b * s, a * s) };
}

export function Luminance(col: Color): number {
	return 0.2126 * col.r + 0.7152 * col.g + 0.0722 * col.b;
}

export function ShouldUseBlackText(backgroundCol: Color): boolean {
	return Luminance(backgroundCol) > 0.57;
}

export function GenerateRandomColour(): Color {
	const hue = Math.random();
	const sat = Mathf.Lerp(0.2, 1, Math.random());
	const val = Mathf.Lerp(0.2, 1, Math.random());
	return Color.HSVToRGB(hue, sat, val);
}

export function Saturation(col: Color): number {
	return Color.RGBToHSV(col)[1];
}

export function GetHSV(col: Color): [number, number, number] {
	return Color.RGBToHSV(col);
}

export function GetValue_HSV(col: Color): number {
	return Math.max(col.r, Math.max(col.g, col.b));
}

export function TweakHSV(col: Color, deltaH: number, deltaS: number, deltaV: number): Color {
	let [h, s, v] = Color.RGBToHSV(col);
	h = (h + deltaH + 1) % 1;
	s = Mathf.Clamp01(s + deltaS);
	v = Mathf.Clamp01(v + deltaV);
	return Color.HSVToRGB(h, s, v);
}

export function Darken(col: Color, darkenAmount: number, desaturateAmount = 0): Color {
	return TweakHSV(col, 0, -desaturateAmount, -darkenAmount);
}

export function Brighten(col: Color, brightenAmount: number, saturateAmount = 0): Color {
	return TweakHSV(col, 0, saturateAmount, brightenAmount);
}

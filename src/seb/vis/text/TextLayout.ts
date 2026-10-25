// Port of Seb.Vis.Text.Rendering.TextLayoutHelper and the layout part of TextRenderer.
import { Color } from "../../types/Color";
import { Vector2 } from "../../types/Vector2";
import { Anchor } from "../Anchor";
import type { FontData, Glyph } from "./FontData";
import { TryParseHexCode } from "../../helpers/ColHelper";

const SpaceSizeEM = 0.333;
const LineHeightEM = 1.3;

export interface LayoutSettings {
	FontSize: number;
	LineSpacing: number;
	LetterSpacing: number;
	WordSpacing: number;
}

export class BoundingBox {
	constructor(
		readonly minX: number,
		readonly minY: number,
		readonly maxX: number,
		readonly maxY: number,
	) {}

	get BoundsMin(): Vector2 {
		return new Vector2(this.minX, this.minY);
	}
	get BoundsMax(): Vector2 {
		return new Vector2(this.maxX, this.maxY);
	}
	get Centre(): Vector2 {
		return new Vector2((this.minX + this.maxX) * 0.5, (this.minY + this.maxY) * 0.5);
	}
	get Size(): Vector2 {
		return new Vector2(this.maxX - this.minX, this.maxY - this.minY);
	}
}

// Sink for glyph instances produced during layout (implemented by the text renderer)
export interface GlyphSink {
	addGlyph(glyph: Glyph, centreX: number, centreY: number, fontSize: number, col: Color): void;
}

const enum RichTag {
	None,
	ColorBlockStart,
	ColorBlockEnd,
	HalfSpace,
}

function spaceSize(font: FontData): number {
	return font.IsMonospaced ? font.MonospacedAdvanceWidth : SpaceSizeEM;
}

function isControl(c: number): boolean {
	return c < 32 || (c >= 127 && c < 160);
}

const colTagStart = "<color=#";
const colTagEnd = "</color>";
const halfSpaceTag = "<halfSpace>";

interface RichInfo {
	tag: RichTag;
	jump: number;
	col: Color;
}

const richScratch: RichInfo = { tag: RichTag.None, jump: 0, col: Color.white };

function richTextTagParse(text: string, index: number): RichInfo {
	richScratch.tag = RichTag.None;
	richScratch.jump = 0;
	if (text.charCodeAt(index) !== 60 /* < */) return richScratch;

	if (text.startsWith(colTagStart, index)) {
		const endBracketIndex = text.indexOf(">", index);
		if (endBracketIndex !== -1) {
			const code = text.substring(index + colTagStart.length, endBracketIndex);
			const res = TryParseHexCode(code);
			if (res.success) {
				richScratch.col = res.col;
				richScratch.jump = endBracketIndex - index;
				richScratch.tag = RichTag.ColorBlockStart;
				return richScratch;
			}
		}
	}

	if (text.startsWith(colTagEnd, index)) {
		richScratch.tag = RichTag.ColorBlockEnd;
		richScratch.jump = colTagEnd.length - 1;
		return richScratch;
	}

	if (text.startsWith(halfSpaceTag, index)) {
		richScratch.tag = RichTag.HalfSpace;
		richScratch.jump = halfSpaceTag.length - 1;
		return richScratch;
	}

	return richScratch;
}

// Calculates positions of all glyphs (optionally sending each to the sink).
// Returns the local bounding box of the text (i.e. not transformed by anchor or world pos)
export function CreateTextLayout(text: string, length: number, font: FontData, settings: LayoutSettings, textCol: Color, sink: GlyphSink | null, offsetX = 0, offsetY = 0): BoundingBox {
	let currCol = textCol;
	let advX = 0;
	let advY = 0;

	const boundsMinX = 0;
	let boundsMaxX = boundsMinX;
	let boundsMinY = 0;
	let boundsMaxY = 0;
	const fontSize = settings.FontSize;

	for (let i = 0; i < length; i++) {
		let nextAdvX = advX;
		let nextAdvY = advY;
		let glyph: Glyph | null = null;

		const rich = richTextTagParse(text, i);
		if (rich.tag === RichTag.None) {
			const c = text.charCodeAt(i);
			if (c === 32) {
				nextAdvX += spaceSize(font) * settings.WordSpacing;
			} else if (c === 9) {
				nextAdvX += spaceSize(font) * 4 * settings.WordSpacing;
			} else if (c === 10) {
				nextAdvY -= LineHeightEM * settings.LineSpacing;
				nextAdvX = 0;
			} else if (!isControl(c)) {
				// Handle surrogate pairs (astral characters)
				let code = c;
				if (c >= 0xd800 && c <= 0xdbff && i + 1 < length) {
					code = text.codePointAt(i) ?? c;
				}
				glyph = font.GetGlyph(code);
				nextAdvX += glyph.AdvanceWidth * settings.LetterSpacing;
			}
		} else {
			i += rich.jump;
			if (rich.tag === RichTag.ColorBlockStart) {
				currCol = rich.col;
				continue;
			} else if (rich.tag === RichTag.ColorBlockEnd) {
				currCol = textCol;
				continue;
			} else if (rich.tag === RichTag.HalfSpace) {
				nextAdvX += spaceSize(font) * settings.WordSpacing * 0.5;
			}
		}

		boundsMaxX = Math.max(boundsMaxX, nextAdvX * fontSize);

		if (glyph !== null) {
			const centreX = (advX + glyph.CentreX) * fontSize;
			const centreY = (advY + glyph.CentreY) * fontSize;
			const halfH = (glyph.SizeY * fontSize) / 2;
			boundsMinY = Math.min(boundsMinY, centreY - halfH);
			boundsMaxY = Math.max(boundsMaxY, centreY + halfH);

			if (sink !== null) sink.addGlyph(glyph, centreX + offsetX, centreY + offsetY, fontSize, currCol);
		}

		advX = nextAdvX;
		advY = nextAdvY;
	}

	return new BoundingBox(boundsMinX, boundsMinY, boundsMaxX, boundsMaxY);
}

// ---- Bounds cache (text bounds are queried extremely frequently by the immediate-mode UI) ----
const boundsCache = new Map<string, BoundingBox>();
const fontIds = new WeakMap<FontData, number>();
let nextFontId = 0;

function fontId(font: FontData): number {
	let id = fontIds.get(font);
	if (id === undefined) {
		id = nextFontId++;
		fontIds.set(font, id);
	}
	return id;
}

export function CalculateLocalBounds(text: string, font: FontData, settings: LayoutSettings, length = text.length): BoundingBox {
	const key = `${fontId(font)}|${settings.FontSize}|${settings.LineSpacing}|${settings.LetterSpacing}|${settings.WordSpacing}|${length === text.length ? text : text.substring(0, length)}`;
	let b = boundsCache.get(key);
	if (b === undefined) {
		b = CreateTextLayout(text, length, font, settings, Color.white, null);
		if (boundsCache.size > 20000) boundsCache.clear();
		boundsCache.set(key, b);
	}
	return b;
}

export function CalculateWorldOffset(local: BoundingBox, font: FontData, posX: number, posY: number, anchor: Anchor, settings: LayoutSettings): [number, number] {
	const cx = (local.minX + local.maxX) * 0.5;
	const cy = (local.minY + local.maxY) * 0.5;
	const sx = local.maxX - local.minX;
	const sy = local.maxY - local.minY;
	const hw = sx / 2;
	const hh = sy / 2;

	switch (anchor) {
		case Anchor.Centre:
			return [posX - cx, posY - cy];
		case Anchor.CentreLeft:
			return [posX - cx + hw, posY - cy];
		case Anchor.CentreRight:
			return [posX - cx - hw, posY - cy];
		case Anchor.CentreTop:
			return [posX - cx, posY - cy - hh];
		case Anchor.CentreBottom:
			return [posX - cx, posY - cy + hh];
		case Anchor.TopLeft:
			return [posX - cx + hw, posY - cy - hh];
		case Anchor.TopRight:
			return [posX - cx - hw, posY - cy - hh];
		case Anchor.BottomLeft:
			return [posX - cx + hw, posY - cy + hh];
		case Anchor.BottomRight:
			return [posX - cx - hw, posY - cy + hh];
		case Anchor.TextCentreLeft: {
			const mh = CalculateLocalBounds("M", font, settings).Size.y;
			return [posX - cx + sx / 2, posY - mh / 2];
		}
		case Anchor.TextCentreRight: {
			const mh = CalculateLocalBounds("M", font, settings).Size.y;
			return [posX - cx - sx / 2, posY - mh / 2];
		}
		case Anchor.TextFirstLineCentre: {
			const mh = CalculateLocalBounds("M", font, settings).Size.y;
			return [posX - cx, posY - mh / 2];
		}
		case Anchor.TextCentre:
			return [posX - cx, posY - cy];
		default:
			return [posX, posY];
	}
}

export function CalculateWorldBounds(text: string, font: FontData, settings: LayoutSettings, pos: Vector2, anchor: Anchor, length = text.length): BoundingBox {
	const local = CalculateLocalBounds(text, font, settings, length);
	const [ox, oy] = CalculateWorldOffset(local, font, pos.x, pos.y, anchor, settings);
	return new BoundingBox(local.minX + ox, local.minY + oy, local.maxX + ox, local.maxY + oy);
}

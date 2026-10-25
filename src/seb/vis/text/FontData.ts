// Port of Seb.Vis.Text.FontLoading.FontData + Glyph, and GlyphHelper.ProcessContours.
import type { FontPoint, GlyphRaw } from "./FontParser";

// Glyph data. All positions/sizes in Em units (independent of font size).
export class Glyph {
	AdvanceWidth = 0;
	// Bounds (em units)
	BottomLeftX = 0;
	BottomLeftY = 0;
	CentreX = 0;
	CentreY = 0;
	SizeX = 0;
	SizeY = 0;
	// Each contour is a flat array [x0,y0,x1,y1,...] forming a closed, y-monotonic quadratic bezier path
	Contours: Float32Array[] = [];
	GlyphIndex = 0;
	LeftSideBearing = 0;
	UnicodeValue = 0;

	// Index of this glyph's metadata in the shared GPU glyph data (assigned lazily by the text renderer)
	gpuMetadataIndex = -1;

	get NumContours(): number {
		return this.Contours.length;
	}
}

export class FontData {
	private readonly glyphLookup = new Map<number, Glyph>();
	readonly IsMonospaced: boolean;
	readonly MonospacedAdvanceWidth: number;
	MissingGlyph!: Glyph;
	readonly Glyphs: Glyph[];

	constructor(rawGlyphs: GlyphRaw[], unitsPerEm: number, isMono: boolean) {
		this.IsMonospaced = isMono;
		const emScale = 1 / unitsPerEm;

		this.Glyphs = rawGlyphs.map((g) => CreateFromRawGlyph(g, emScale));
		this.MonospacedAdvanceWidth = this.Glyphs[0].AdvanceWidth;

		for (const c of this.Glyphs) {
			if (!this.glyphLookup.has(c.UnicodeValue)) this.glyphLookup.set(c.UnicodeValue, c);
			if (c.GlyphIndex === 0) this.MissingGlyph = c;
		}

		if (!this.MissingGlyph) throw new Error("No missing character glyph provided!");
	}

	// Returns the glyph for the given unicode value (or the missing-glyph if not found)
	GetGlyph(unicode: number): Glyph {
		return this.glyphLookup.get(unicode) ?? this.MissingGlyph;
	}

	HasGlyph(unicode: number): boolean {
		return this.glyphLookup.has(unicode);
	}
}

function CreateFromRawGlyph(raw: GlyphRaw, emScale: number): Glyph {
	const g = new Glyph();
	g.UnicodeValue = raw.UnicodeValue;
	g.GlyphIndex = raw.GlyphIndex;
	g.AdvanceWidth = raw.AdvanceWidth * emScale;
	g.LeftSideBearing = raw.LeftSideBearing * emScale;
	g.Contours = ProcessContours(raw.ContourEndIndices, raw.Points, emScale);

	const blX = raw.MinX * emScale;
	const blY = raw.MinY * emScale;
	const trX = raw.MaxX * emScale;
	const trY = raw.MaxY * emScale;
	g.BottomLeftX = blX;
	g.BottomLeftY = blY;
	g.CentreX = (blX + trX) * 0.5;
	g.CentreY = (blY + trY) * 0.5;
	g.SizeX = trX - blX;
	g.SizeY = trY - blY;
	return g;
}

// Process raw glyph data to construct the contours.
// Output is an array of contours (each contour being an array of points forming a quadratic bezier path), in em units.
function ProcessContours(contourEndIndices: number[], points: FontPoint[], scale: number): Float32Array[] {
	const convertStraightLinesToBezier = true;
	let startPointIndex = 0;
	const contours: Float32Array[] = [];

	for (let contourIndex = 0; contourIndex < contourEndIndices.length; contourIndex++) {
		const contourEndIndex = contourEndIndices[contourIndex];
		const numPointsInContour = contourEndIndex - startPointIndex + 1;
		const contourPoints = points.slice(startPointIndex, startPointIndex + numPointsInContour);

		const reconstructed: number[] = [];

		let firstOnCurvePointIndex = 0;
		for (let i = 0; i < contourPoints.length; i++) {
			if (contourPoints[i].OnCurve) {
				firstOnCurvePointIndex = i;
				break;
			}
		}

		for (let i = 0; i < contourPoints.length; i++) {
			const curr = contourPoints[(i + firstOnCurvePointIndex) % contourPoints.length];
			const next = contourPoints[(i + firstOnCurvePointIndex + 1) % contourPoints.length];

			reconstructed.push(curr.X * scale, curr.Y * scale);
			const isConsecutiveOffCurvePoints = !curr.OnCurve && !next.OnCurve;
			const isStraightLine = curr.OnCurve && next.OnCurve;

			if (isConsecutiveOffCurvePoints || (isStraightLine && convertStraightLinesToBezier)) {
				const newX = ((curr.X + next.X) / 2.0) * scale;
				const newY = ((curr.Y + next.Y) / 2.0) * scale;
				reconstructed.push(newX, newY);
			}
		}

		if (reconstructed.length > 0) {
			reconstructed.push(reconstructed[0], reconstructed[1]);
			contours.push(new Float32Array(MakeMonotonic(reconstructed)));
		}

		startPointIndex = contourEndIndex + 1;
	}

	return contours;
}

function MakeMonotonic(original: number[]): number[] {
	const count = original.length / 2;
	const monotonic: number[] = [original[0], original[1]];

	for (let i = 0; i < count - 1; i += 2) {
		const p0x = original[i * 2];
		const p0y = original[i * 2 + 1];
		const p1x = original[(i + 1) * 2];
		const p1y = original[(i + 1) * 2 + 1];
		const p2x = original[(i + 2) * 2];
		const p2y = original[(i + 2) * 2 + 1];

		if (p1y < Math.min(p0y, p2y) || p1y > Math.max(p0y, p2y)) {
			// Split at turning point in y
			const ax = p0x - 2 * p1x + p2x;
			const ay = p0y - 2 * p1y + p2y;
			const bx = 2 * (p1x - p0x);
			const by = 2 * (p1y - p0y);

			const t = -by / (2 * ay);
			const tpx = ax * t * t + bx * t + p0x;
			const tpy = ay * t * t + by * t + p0y;

			const lambdaA = (tpy - p0y) / by;
			const p1Ax = p0x + bx * lambdaA;
			const lambdaB = (tpy - p2y) / (2 * ay + by);
			const p1Bx = p2x + (2 * ax + bx) * lambdaB;

			monotonic.push(p1Ax, tpy, tpx, tpy, p1Bx, tpy, p2x, p2y);
		} else {
			monotonic.push(p1x, p1y, p2x, p2y);
		}
	}

	return monotonic;
}

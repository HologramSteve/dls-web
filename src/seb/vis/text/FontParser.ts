// Port of Seb.Vis.Text.FontLoading.FontParser / FontReader:
// an (incomplete) parser for TrueType font files.
import { FontData } from "./FontData";

export interface FontPoint {
	X: number;
	Y: number;
	OnCurve: boolean;
}

export class GlyphRaw {
	AdvanceWidth = 0;
	ContourEndIndices: number[] = [];
	GlyphIndex = 0;
	LeftSideBearing = 0;
	MaxX = 0;
	MaxY = 0;
	MinX = 0;
	MinY = 0;
	Points: FontPoint[] = [];
	UnicodeValue = 0;
}

class FontReader {
	private readonly view: DataView;
	private pos = 0;

	constructor(bytes: ArrayBuffer) {
		this.view = new DataView(bytes);
	}

	SkipBytes(n: number) {
		this.pos += n;
	}
	Skip16BitEntries(n: number) {
		this.pos += n * 2;
	}
	GoTo(offset: number) {
		this.pos = offset;
	}
	GetLocation(): number {
		return this.pos;
	}
	ReadString(numBytes: number): string {
		let s = "";
		for (let i = 0; i < numBytes; i++) s += String.fromCharCode(this.ReadByte());
		return s;
	}
	ReadByte(): number {
		return this.view.getUint8(this.pos++);
	}
	ReadSByte(): number {
		return this.view.getInt8(this.pos++);
	}
	ReadUInt16(): number {
		const v = this.view.getUint16(this.pos, false);
		this.pos += 2;
		return v;
	}
	ReadInt16(): number {
		const v = this.view.getInt16(this.pos, false);
		this.pos += 2;
		return v;
	}
	ReadUInt32(): number {
		const v = this.view.getUint32(this.pos, false);
		this.pos += 4;
		return v;
	}
	ReadFixedPoint2Dot14(): number {
		const raw = this.ReadInt16();
		return raw / (1 << 14);
	}
}

interface TableMap {
	Cmap: number;
	Head: number;
	Maxp: number;
	Hhea: number;
	Hmtx: number;
	Loca: number;
	Glyf: number;
	Post: number;
}

export function ParseFont(bytes: ArrayBuffer): FontData {
	const reader = new FontReader(bytes);
	const tableMap = ReadTableLocations(reader);

	const unitsPerEm = GetUnitsPerEm(reader, tableMap);
	const numGlyphs = GetGlyphCount(reader, tableMap);

	const glyphs = ReadAllGlyphs(reader, tableMap, numGlyphs);
	ApplyLayoutInfo(reader, tableMap, glyphs, numGlyphs);
	const isMono = CheckIfMonospaced(reader, tableMap);

	return new FontData(glyphs, unitsPerEm, isMono);
}

function CheckIfMonospaced(reader: FontReader, tableMap: TableMap): boolean {
	reader.GoTo(tableMap.Post + 12);
	return reader.ReadUInt32() !== 0;
}

function GetBytesPerLocationEntry(reader: FontReader, tableMap: TableMap): number {
	reader.GoTo(tableMap.Head + 50);
	return reader.ReadInt16() === 0 ? 2 : 4;
}

function GetUnitsPerEm(reader: FontReader, tableMap: TableMap): number {
	reader.GoTo(tableMap.Head + 18);
	return reader.ReadUInt16();
}

function GetGlyphCount(reader: FontReader, tableMap: TableMap): number {
	reader.GoTo(tableMap.Maxp);
	reader.SkipBytes(4);
	return reader.ReadUInt16();
}

function ApplyLayoutInfo(reader: FontReader, tableMap: TableMap, glyphs: GlyphRaw[], numGlyphs: number) {
	const layoutData: [number, number][] = new Array(numGlyphs);

	reader.GoTo(tableMap.Hhea);
	reader.SkipBytes(8);
	reader.ReadInt16(); // lineGap
	reader.ReadInt16(); // advanceWidthMax
	reader.SkipBytes(22);
	const numAdvanceWidthMetrics = reader.ReadInt16();

	reader.GoTo(tableMap.Hmtx);
	let lastAdvanceWidth = 0;

	for (let i = 0; i < numAdvanceWidthMetrics; i++) {
		const advanceWidth = reader.ReadUInt16();
		const leftSideBearing = reader.ReadInt16();
		lastAdvanceWidth = advanceWidth;
		layoutData[i] = [advanceWidth, leftSideBearing];
	}

	const numRem = numGlyphs - numAdvanceWidthMetrics;
	for (let i = 0; i < numRem; i++) {
		const leftSideBearing = reader.ReadInt16();
		layoutData[numAdvanceWidthMetrics + i] = [lastAdvanceWidth, leftSideBearing];
	}

	for (const c of glyphs) {
		const d = layoutData[c.GlyphIndex];
		c.AdvanceWidth = d ? d[0] : 0;
		c.LeftSideBearing = d ? d[1] : 0;
	}
}

function ReadTableLocations(reader: FontReader): TableMap {
	const lookup = new Map<string, number>();
	reader.SkipBytes(4);
	const numTables = reader.ReadUInt16();
	reader.SkipBytes(6);

	for (let i = 0; i < numTables; i++) {
		const tag = reader.ReadString(4);
		reader.ReadUInt32(); // checksum
		const offset = reader.ReadUInt32();
		reader.ReadUInt32(); // length
		lookup.set(tag, offset);
	}

	const get = (t: string) => {
		const v = lookup.get(t);
		if (v === undefined) throw new Error("Font is missing table: " + t);
		return v;
	};

	return {
		Cmap: get("cmap"),
		Head: get("head"),
		Maxp: get("maxp"),
		Hhea: get("hhea"),
		Hmtx: get("hmtx"),
		Loca: get("loca"),
		Glyf: get("glyf"),
		Post: get("post"),
	};
}

function ReadAllGlyphs(reader: FontReader, tableMap: TableMap, numGlyphs: number): GlyphRaw[] {
	const glyphLocations = GetAllGlyphLocations(reader, numGlyphs, tableMap);
	const mappings = GetUnicodeToGlyphIndexMappings(reader, tableMap.Cmap);
	const glyphs: GlyphRaw[] = new Array(mappings.length);

	for (let i = 0; i < mappings.length; i++) {
		const mapping = mappings[i];
		const glyph = ReadGlyph(reader, glyphLocations, mapping.GlyphIndex);
		glyph.UnicodeValue = mapping.Unicode;
		glyphs[i] = glyph;
	}

	return glyphs;
}

function ReadGlyph(reader: FontReader, glyphLocations: number[], glyphIndex: number): GlyphRaw {
	const glyphLocation = glyphLocations[glyphIndex];
	reader.GoTo(glyphLocation);
	const contourCount = reader.ReadInt16();
	if (contourCount >= 0) return ReadSimpleGlyph(reader, glyphLocations, glyphIndex);
	return ReadCompoundGlyph(reader, glyphLocations, glyphIndex);
}

function FlagBitIsSet(flag: number, bitIndex: number): boolean {
	return ((flag >> bitIndex) & 1) === 1;
}

function ReadSimpleGlyph(reader: FontReader, glyphLocations: number[], glyphIndex: number): GlyphRaw {
	const OnCurve = 0;
	const IsSingleByteX = 1;
	const IsSingleByteY = 2;
	const Repeat = 3;
	const InstructionX = 4;
	const InstructionY = 5;

	reader.GoTo(glyphLocations[glyphIndex]);

	const glyph = new GlyphRaw();
	glyph.GlyphIndex = glyphIndex;

	const contourCount = reader.ReadInt16();
	if (contourCount < 0) throw new Error("Expected simple glyph, but found compound glyph instead");

	glyph.MinX = reader.ReadInt16();
	glyph.MinY = reader.ReadInt16();
	glyph.MaxX = reader.ReadInt16();
	glyph.MaxY = reader.ReadInt16();

	let numPoints = 0;
	const contourEndIndices: number[] = new Array(contourCount);
	for (let i = 0; i < contourCount; i++) {
		const contourEndIndex = reader.ReadUInt16();
		numPoints = Math.max(numPoints, contourEndIndex + 1);
		contourEndIndices[i] = contourEndIndex;
	}

	const instructionsLength = reader.ReadInt16();
	reader.SkipBytes(instructionsLength);

	const allFlags = new Uint8Array(numPoints);
	const points: FontPoint[] = new Array(numPoints);
	for (let i = 0; i < numPoints; i++) points[i] = { X: 0, Y: 0, OnCurve: false };

	for (let i = 0; i < numPoints; i++) {
		const flag = reader.ReadByte();
		allFlags[i] = flag;

		if (FlagBitIsSet(flag, Repeat)) {
			const repeatCount = reader.ReadByte();
			for (let r = 0; r < repeatCount; r++) {
				i++;
				allFlags[i] = flag;
			}
		}
	}

	const readCoords = (readingX: boolean) => {
		const singleByteFlagBit = readingX ? IsSingleByteX : IsSingleByteY;
		const instructionFlagMask = readingX ? InstructionX : InstructionY;
		let coordVal = 0;

		for (let i = 0; i < numPoints; i++) {
			const currFlag = allFlags[i];
			if (FlagBitIsSet(currFlag, singleByteFlagBit)) {
				const coordOffset = reader.ReadByte();
				const positiveOffset = FlagBitIsSet(currFlag, instructionFlagMask);
				coordVal += positiveOffset ? coordOffset : -coordOffset;
			} else if (!FlagBitIsSet(currFlag, instructionFlagMask)) {
				coordVal += reader.ReadInt16();
			}

			if (readingX) points[i].X = coordVal;
			else points[i].Y = coordVal;
			points[i].OnCurve = FlagBitIsSet(currFlag, OnCurve);
		}
	};

	readCoords(true);
	readCoords(false);
	glyph.Points = points;
	glyph.ContourEndIndices = contourEndIndices;
	return glyph;
}

function ReadCompoundGlyph(reader: FontReader, glyphLocations: number[], glyphIndex: number): GlyphRaw {
	const compoundGlyph = new GlyphRaw();
	compoundGlyph.GlyphIndex = glyphIndex;

	const glyphLocation = glyphLocations[glyphIndex];
	reader.GoTo(glyphLocation);
	reader.SkipBytes(2);

	compoundGlyph.MinX = reader.ReadInt16();
	compoundGlyph.MinY = reader.ReadInt16();
	compoundGlyph.MaxX = reader.ReadInt16();
	compoundGlyph.MaxY = reader.ReadInt16();

	const allPoints: FontPoint[] = [];
	const allContourEndIndices: number[] = [];

	while (true) {
		const [componentGlyph, hasMoreGlyphs] = ReadNextComponentGlyph(reader, glyphLocations, glyphLocation);

		for (const endIndex of componentGlyph.ContourEndIndices) {
			allContourEndIndices.push(endIndex + allPoints.length);
		}
		for (const p of componentGlyph.Points) allPoints.push(p);

		if (!hasMoreGlyphs) break;
	}

	compoundGlyph.Points = allPoints;
	compoundGlyph.ContourEndIndices = allContourEndIndices;
	return compoundGlyph;
}

function ReadNextComponentGlyph(reader: FontReader, glyphLocations: number[], glyphLocation: number): [GlyphRaw, boolean] {
	const flag = reader.ReadUInt16();
	const glyphIndex = reader.ReadUInt16();

	const componentGlyphLocation = glyphLocations[glyphIndex];
	if (componentGlyphLocation === glyphLocation) {
		const empty = new GlyphRaw();
		return [empty, false];
	}

	const argsAre2Bytes = FlagBitIsSet(flag, 0);
	const argsAreXYValues = FlagBitIsSet(flag, 1);
	const isSingleScaleValue = FlagBitIsSet(flag, 3);
	const isMoreComponentsAfterThis = FlagBitIsSet(flag, 5);
	const isXAndYScale = FlagBitIsSet(flag, 6);
	const is2x2Matrix = FlagBitIsSet(flag, 7);

	const arg1 = argsAre2Bytes ? reader.ReadInt16() : reader.ReadSByte();
	const arg2 = argsAre2Bytes ? reader.ReadInt16() : reader.ReadSByte();

	if (!argsAreXYValues) throw new Error("TODO: Args1&2 are point indices to be matched, rather than offsets");

	const offsetX = arg1;
	const offsetY = arg2;

	let iHatX = 1;
	const iHatY = 0;
	const jHatX = 0;
	let jHatY = 1;

	if (isSingleScaleValue) {
		iHatX = reader.ReadFixedPoint2Dot14();
		jHatY = iHatX;
	} else if (isXAndYScale) {
		iHatX = reader.ReadFixedPoint2Dot14();
		jHatY = reader.ReadFixedPoint2Dot14();
	} else if (is2x2Matrix) {
		throw new Error("TOOD: Implement 2x2 matrix mode in font parser");
	}

	const currentCompoundGlyphReadLocation = reader.GetLocation();
	const simpleGlyph = ReadGlyph(reader, glyphLocations, glyphIndex);
	reader.GoTo(currentCompoundGlyphReadLocation);

	for (let i = 0; i < simpleGlyph.Points.length; i++) {
		const p = simpleGlyph.Points[i];
		const x = p.X;
		const y = p.Y;
		const xPrime = iHatX * x + jHatX * y + offsetX;
		const yPrime = iHatY * x + jHatY * y + offsetY;
		simpleGlyph.Points[i] = { X: Math.trunc(xPrime), Y: Math.trunc(yPrime), OnCurve: p.OnCurve };
	}

	return [simpleGlyph, isMoreComponentsAfterThis];
}

function GetAllGlyphLocations(reader: FontReader, numGlyphs: number, tableMap: TableMap): number[] {
	const allGlyphLocations: number[] = new Array(numGlyphs);
	const bytesPerEntry = GetBytesPerLocationEntry(reader, tableMap);
	const isTwoByteEntry = bytesPerEntry === 2;

	for (let glyphIndex = 0; glyphIndex < numGlyphs; glyphIndex++) {
		reader.GoTo(tableMap.Loca + glyphIndex * bytesPerEntry);
		const glyphDataOffset = isTwoByteEntry ? reader.ReadUInt16() * 2 : reader.ReadUInt32();
		allGlyphLocations[glyphIndex] = tableMap.Glyf + glyphDataOffset;
	}

	return allGlyphLocations;
}

interface GlyphMap {
	GlyphIndex: number;
	Unicode: number;
}

function GetUnicodeToGlyphIndexMappings(reader: FontReader, cmapOffset: number): GlyphMap[] {
	const glyphPairs: GlyphMap[] = [];
	reader.GoTo(cmapOffset);

	reader.ReadUInt16(); // version
	const numSubtables = reader.ReadUInt16();

	let cmapSubtableOffset = 0;
	let selectedUnicodeVersionID = -1;

	for (let i = 0; i < numSubtables; i++) {
		const platformID = reader.ReadUInt16();
		const platformSpecificID = reader.ReadUInt16();
		const offset = reader.ReadUInt32();

		if (platformID === 0) {
			if ((platformSpecificID === 0 || platformSpecificID === 1 || platformSpecificID === 3 || platformSpecificID === 4) && platformSpecificID > selectedUnicodeVersionID) {
				cmapSubtableOffset = offset;
				selectedUnicodeVersionID = platformSpecificID;
			}
		} else if (platformID === 3 && selectedUnicodeVersionID === -1) {
			if (platformSpecificID === 1 || platformSpecificID === 10) {
				cmapSubtableOffset = offset;
			}
		}
	}

	if (cmapSubtableOffset === 0) throw new Error("Font does not contain supported character map type (TODO)");

	reader.GoTo(cmapOffset + cmapSubtableOffset);
	const format = reader.ReadUInt16();
	let hasReadMissingCharGlyph = false;

	if (format !== 12 && format !== 4) throw new Error("Font cmap format not supported (TODO): " + format);

	if (format === 4) {
		reader.ReadUInt16(); // length
		reader.ReadUInt16(); // language code
		const segCount2X = reader.ReadUInt16();
		const segCount = segCount2X / 2;
		reader.SkipBytes(6);

		const endCodes: number[] = [];
		for (let i = 0; i < segCount; i++) endCodes.push(reader.ReadUInt16());
		reader.Skip16BitEntries(1);
		const startCodes: number[] = [];
		for (let i = 0; i < segCount; i++) startCodes.push(reader.ReadUInt16());
		const idDeltas: number[] = [];
		for (let i = 0; i < segCount; i++) idDeltas.push(reader.ReadUInt16());
		const idRangeOffsets: [number, number][] = [];
		for (let i = 0; i < segCount; i++) {
			const readLoc = reader.GetLocation();
			const offset = reader.ReadUInt16();
			idRangeOffsets.push([offset, readLoc]);
		}

		for (let i = 0; i < startCodes.length; i++) {
			const endCode = endCodes[i];
			let currCode = startCodes[i];
			if (currCode === 65535) break;

			while (currCode <= endCode) {
				let glyphIndex: number;
				if (idRangeOffsets[i][0] === 0) {
					glyphIndex = (currCode + idDeltas[i]) % 65536;
				} else {
					const readerLocationOld = reader.GetLocation();
					const rangeOffsetLocation = idRangeOffsets[i][1] + idRangeOffsets[i][0];
					const glyphIndexArrayLocation = 2 * (currCode - startCodes[i]) + rangeOffsetLocation;
					reader.GoTo(glyphIndexArrayLocation);
					glyphIndex = reader.ReadUInt16();
					if (glyphIndex !== 0) glyphIndex = (glyphIndex + idDeltas[i]) % 65536;
					reader.GoTo(readerLocationOld);
				}

				glyphPairs.push({ GlyphIndex: glyphIndex, Unicode: currCode });
				hasReadMissingCharGlyph ||= glyphIndex === 0;
				currCode++;
			}
		}
	} else if (format === 12) {
		reader.SkipBytes(10);
		const numGroups = reader.ReadUInt32();
		for (let i = 0; i < numGroups; i++) {
			const startCharCode = reader.ReadUInt32();
			const endCharCode = reader.ReadUInt32();
			const startGlyphIndex = reader.ReadUInt32();
			const numChars = endCharCode - startCharCode + 1;
			for (let o = 0; o < numChars; o++) {
				const glyphIndex = startGlyphIndex + o;
				glyphPairs.push({ GlyphIndex: glyphIndex, Unicode: startCharCode + o });
				hasReadMissingCharGlyph ||= glyphIndex === 0;
			}
		}
	}

	if (!hasReadMissingCharGlyph) glyphPairs.push({ GlyphIndex: 0, Unicode: 65535 });

	return glyphPairs;
}

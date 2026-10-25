// Port of Seb.Vis.Draw (Draw.cs + DrawManager.cs): immediate-mode shape & text drawing.
// Shapes and text are collected into layers during the frame; at the end of the frame each layer is drawn
// (shapes first, then text) with instanced WebGL2 draw calls.
import { Vector2 } from "../types/Vector2";
import { Color } from "../types/Color";
import { Mathf } from "../types/Mathf";
import { Anchor, FontType } from "./Anchor";
import { FontData, Glyph } from "./text/FontData";
import { ParseFont } from "./text/FontParser";
import { BoundingBox, CalculateWorldBounds, CalculateLocalBounds, CalculateWorldOffset, CreateTextLayout, GlyphSink, LayoutSettings } from "./text/TextLayout";
import { ShapeFS, ShapeVS, TextFS, TextVS } from "./internal/Shaders";

export enum ShapeType {
	Line = 0,
	Point = 1,
	Quad = 2,
	Triangle = 3,
	SatVal = 4,
	HueQuad = 5,
	Diamond = 6,
	PointOutline = 7,
}

const FloatsPerInstance = 16;
const BytesPerInstance = FloatsPerInstance * 4;
const MaskInf = 1e30;

class LayerInfo {
	constructor(
		readonly offset: Vector2,
		readonly scale: number,
		readonly useScreenSpace: boolean,
		readonly shapeStart: number,
		readonly glyphStart: number,
	) {}
	shapeEnd = 0;
	glyphEnd = 0;
}

class InstanceBuffer {
	data = new Float32Array(FloatsPerInstance * 4096);
	count = 0;

	reserve(): number {
		if ((this.count + 1) * FloatsPerInstance > this.data.length) {
			const n = new Float32Array(this.data.length * 2);
			n.set(this.data);
			this.data = n;
		}
		return this.count++ * FloatsPerInstance;
	}
}

export class DrawID {
	constructor(readonly index: number) {}
}

export class MaskScope {
	boundsMin = Vector2.zero;
	boundsMax = Vector2.zero;

	Init(min: Vector2, max: Vector2) {
		this.boundsMin = min;
		this.boundsMax = max;
		activeMaskMinX = min.x;
		activeMaskMinY = min.y;
		activeMaskMaxX = max.x;
		activeMaskMaxY = max.y;
	}

	Dispose() {
		maskStack.pop();
		const parent = maskStack[maskStack.length - 1];
		if (parent) {
			activeMaskMinX = parent.boundsMin.x;
			activeMaskMinY = parent.boundsMin.y;
			activeMaskMaxX = parent.boundsMax.x;
			activeMaskMaxY = parent.boundsMax.y;
		} else {
			activeMaskMinX = activeMaskMinY = -MaskInf;
			activeMaskMaxX = activeMaskMaxY = MaskInf;
		}
	}
}

// ---- State ----
const shapes = new InstanceBuffer();
const glyphs = new InstanceBuffer();
const layers: LayerInfo[] = [];
const maskStack: MaskScope[] = [];
let activeMaskMinX = -MaskInf;
let activeMaskMinY = -MaskInf;
let activeMaskMaxX = MaskInf;
let activeMaskMaxY = MaskInf;
const fonts: FontData[] = [];

// Glyph GPU data (shared between all fonts)
const bezierPoints: number[] = [];
const glyphMetadata: number[] = [];
let glyphDataDirty = true;

// Camera
let camPosX = 0;
let camPosY = 0;
let camOrthoSize = 5;
let screenW = 1;
let screenH = 1;
let clearCol = Color.black;

function currentLayer(): LayerInfo {
	return layers[layers.length - 1];
}

function writeShape(type: ShapeType, ax: number, ay: number, bx: number, by: number, param: number, col: Color, cx = 0, cy = 0, maskMinX = activeMaskMinX, maskMinY = activeMaskMinY, maskMaxX = activeMaskMaxX, maskMaxY = activeMaskMaxY): number {
	if (layers.length === 0) throw new Error("Layer has not yet been started.");
	const o = shapes.reserve();
	const d = shapes.data;
	d[o] = type;
	d[o + 1] = param;
	d[o + 2] = cx;
	d[o + 3] = cy;
	d[o + 4] = ax;
	d[o + 5] = ay;
	d[o + 6] = bx;
	d[o + 7] = by;
	d[o + 8] = col.r;
	d[o + 9] = col.g;
	d[o + 10] = col.b;
	d[o + 11] = col.a;
	d[o + 12] = maskMinX;
	d[o + 13] = maskMinY;
	d[o + 14] = maskMaxX;
	d[o + 15] = maskMaxY;
	return o / FloatsPerInstance;
}

function ensureGlyphUploaded(glyph: Glyph): number {
	if (glyph.gpuMetadataIndex >= 0) return glyph.gpuMetadataIndex;
	const metadataIndex = glyphMetadata.length;
	glyph.gpuMetadataIndex = metadataIndex;
	glyphMetadata.push(bezierPoints.length / 2); // bezier data offset for this glyph
	glyphMetadata.push(glyph.NumContours);
	for (const contour of glyph.Contours) {
		const numPoints = contour.length / 2;
		glyphMetadata.push(numPoints - 1);
		for (let i = 0; i < numPoints; i++) {
			bezierPoints.push(contour[i * 2] - glyph.CentreX, contour[i * 2 + 1] - glyph.CentreY);
		}
	}
	glyphDataDirty = true;
	return metadataIndex;
}

let sinkScreenSpace = 0;
let sinkMaskMinX = 0;
let sinkMaskMinY = 0;
let sinkMaskMaxX = 0;
let sinkMaskMaxY = 0;

const glyphSink: GlyphSink = {
	addGlyph(glyph: Glyph, centreX: number, centreY: number, fontSize: number, col: Color) {
		if (glyph.NumContours === 0) return;
		const metaIndex = ensureGlyphUploaded(glyph);
		const o = glyphs.reserve();
		const d = glyphs.data;
		d[o] = centreX;
		d[o + 1] = centreY;
		d[o + 2] = glyph.SizeX;
		d[o + 3] = glyph.SizeY;
		d[o + 4] = col.r;
		d[o + 5] = col.g;
		d[o + 6] = col.b;
		d[o + 7] = col.a;
		d[o + 8] = fontSize;
		d[o + 9] = metaIndex;
		d[o + 10] = sinkScreenSpace;
		d[o + 11] = 0;
		d[o + 12] = sinkMaskMinX;
		d[o + 13] = sinkMaskMinY;
		d[o + 14] = sinkMaskMaxX;
		d[o + 15] = sinkMaskMaxY;
	},
};

function layoutSettings(fontSize: number, lineSpacing: number): LayoutSettings {
	return { FontSize: fontSize, LineSpacing: lineSpacing, LetterSpacing: 1, WordSpacing: 1 };
}

export const Draw = {
	// ---- Setup ----
	async LoadFonts(baseUrl: string): Promise<void> {
		const files: [FontType, string][] = [
			[FontType.JetbrainsMonoBold, "JetBrainsMonoNL-Bold.ttf"],
			[FontType.JetbrainsMonoRegular, "JetBrainsMonoNL-Regular.ttf"],
			[FontType.Born2bSporty, "Born2bSportyV2.ttf"],
		];
		await Promise.all(
			files.map(async ([type, file]) => {
				const res = await fetch(baseUrl + file);
				if (!res.ok) throw new Error("Failed to load font " + file);
				fonts[type] = ParseFont(await res.arrayBuffer());
			}),
		);
	},

	GetFont(font: FontType): FontData {
		return fonts[font];
	},

	SetFontData(font: FontType, data: FontData) {
		fonts[font] = data;
	},

	SetCamera(posX: number, posY: number, orthoSize: number) {
		camPosX = posX;
		camPosY = posY;
		camOrthoSize = orthoSize;
	},

	SetClearColour(col: Color) {
		clearCol = col;
	},

	// Start a new frame (clears all draw data from the previous frame)
	BeginFrame(screenWidth: number, screenHeight: number) {
		screenW = screenWidth;
		screenH = screenHeight;
		shapes.count = 0;
		glyphs.count = 0;
		layers.length = 0;
		maskStack.length = 0;
		activeMaskMinX = activeMaskMinY = -MaskInf;
		activeMaskMaxX = activeMaskMaxY = MaskInf;
	},

	// ---- Layers ----
	// Start a new layer. Within each layer, shapes are drawn first, followed by text.
	// So, if shapes need to appear on top of some text, a new layer must be started.
	StartLayer(offset: Vector2, scale: number, useScreenSpace: boolean) {
		const prev = layers[layers.length - 1];
		if (prev) {
			prev.shapeEnd = shapes.count;
			prev.glyphEnd = glyphs.count;
		}
		layers.push(new LayerInfo(offset, scale, useScreenSpace, shapes.count, glyphs.count));
	},

	StartLayerIfNotInMatching(offset: Vector2, scale: number, useScreenSpace: boolean) {
		const curr = layers[layers.length - 1];
		const createNew = !curr || !Vector2.eq(curr.offset, offset) || curr.scale !== scale || curr.useScreenSpace !== useScreenSpace;
		if (createNew) Draw.StartLayer(offset, scale, useScreenSpace);
	},

	BeginMaskScope(maskBoundsMin: Vector2, maskBoundsMax: Vector2): MaskScope {
		const scope = new MaskScope();
		maskStack.push(scope);
		scope.Init(maskBoundsMin, maskBoundsMax);
		return scope;
	},

	GetActiveMaskMinMax(): [Vector2, Vector2] {
		return [new Vector2(activeMaskMinX, activeMaskMinY), new Vector2(activeMaskMaxX, activeMaskMaxY)];
	},

	// ------ Core Draw Functions ------
	Text(font: FontType, text: string, fontSize: number, pos: Vector2, anchor: Anchor, col: Color, lineSpacing = 1, textLength = -1) {
		if (fontSize <= 0 || col.a === 0 || !text || textLength === 0) return;
		const length = textLength < 0 ? text.length : textLength;
		const layer = currentLayer();
		if (!layer) throw new Error("Layer has not yet been started.");

		const fontData = fonts[font];
		const s = layer.scale;
		const settings: LayoutSettings = { FontSize: fontSize * s, LineSpacing: lineSpacing * s, LetterSpacing: s, WordSpacing: s };
		const px = pos.x + layer.offset.x;
		const py = pos.y + layer.offset.y;

		const local = CalculateLocalBounds(text, fontData, settings, length);
		const [ox, oy] = CalculateWorldOffset(local, fontData, px, py, anchor, settings);

		sinkScreenSpace = layer.useScreenSpace ? 1 : 0;
		sinkMaskMinX = activeMaskMinX + layer.offset.x;
		sinkMaskMinY = activeMaskMinY + layer.offset.y;
		sinkMaskMaxX = activeMaskMaxX + layer.offset.x;
		sinkMaskMaxY = activeMaskMaxY + layer.offset.y;
		CreateTextLayout(text, length, fontData, settings, col, glyphSink, ox, oy);
	},

	Triangle(a: Vector2, b: Vector2, c: Vector2, col: Color) {
		if (col.a === 0) return;
		writeShape(ShapeType.Triangle, a.x, a.y, b.x, b.y, 0, col, c.x, c.y, -MaskInf, -MaskInf, MaskInf, MaskInf);
	},

	TriangleDir(centre: Vector2, dir: Vector2, height: number, scale: number, col: Color) {
		if (col.a === 0 || scale === 0 || height === 0) return;
		const perp = new Vector2(-dir.y, dir.x);
		const tip = centre.add(dir.mul(scale));
		const top = centre.sub(dir.add(perp.mul(height)).mul(scale));
		const bottom = centre.sub(dir.sub(perp.mul(height)).mul(scale));
		Draw.Triangle(tip, top, bottom, col);
	},

	Diamond(pos: Vector2, size: Vector2, col: Color) {
		if (size.x === 0 || size.y === 0 || col.a === 0) return;
		writeShape(ShapeType.Diamond, pos.x, pos.y, size.x, size.y, 0, col);
	},

	SatValQuad(centre: Vector2, size: Vector2, hue: number) {
		if (size.x === 0 || size.y === 0) return;
		writeShape(ShapeType.SatVal, centre.x, centre.y, size.x, size.y, hue, Color.clear);
	},

	HueQuad(centre: Vector2, size: Vector2) {
		if (size.x === 0 || size.y === 0) return;
		writeShape(ShapeType.HueQuad, centre.x, centre.y, size.x, size.y, 0, Color.clear);
	},

	Point(centre: Vector2, radius: number, col: Color) {
		if (radius === 0 || col.a === 0) return;
		writeShape(ShapeType.Point, centre.x, centre.y, radius, radius, 0, col);
	},

	PointOutline(centre: Vector2, radius: number, thickness: number, col: Color) {
		if (radius === 0 || thickness === 0 || col.a === 0) return;
		const radiusOuter = radius + thickness / 2;
		const radiusInner = radius - thickness / 2;
		writeShape(ShapeType.PointOutline, centre.x, centre.y, radiusOuter, radiusOuter, radiusInner / radiusOuter, col);
	},

	Ellipse(centre: Vector2, size: Vector2, col: Color) {
		if (size.x === 0 || size.y === 0 || col.a === 0) return;
		writeShape(ShapeType.Point, centre.x, centre.y, size.x, size.y, 0, col);
	},

	Quad(centre: Vector2, size: Vector2, col: Color) {
		if (size.x === 0 || size.y === 0 || col.a === 0) return;
		writeShape(ShapeType.Quad, centre.x, centre.y, size.x, size.y, 0, col);
	},

	// Fast path (avoids Vector2 allocation) for hot loops
	QuadXY(cx: number, cy: number, sx: number, sy: number, col: Color) {
		if (sx === 0 || sy === 0 || col.a === 0) return;
		writeShape(ShapeType.Quad, cx, cy, sx, sy, 0, col);
	},

	PointXY(cx: number, cy: number, radius: number, col: Color) {
		if (radius === 0 || col.a === 0) return;
		writeShape(ShapeType.Point, cx, cy, radius, radius, 0, col);
	},

	Line(a: Vector2, b: Vector2, thickness: number, col: Color, t = 1) {
		if (thickness === 0 || t === 0 || Vector2.eq(a, b) || col.a === 0) return;
		if (t < 1) b = Vector2.lerp(a, b, t);
		writeShape(ShapeType.Line, a.x, a.y, b.x, b.y, thickness, col);
	},

	LineXY(ax: number, ay: number, bx: number, by: number, thickness: number, col: Color) {
		if (thickness === 0 || col.a === 0) return;
		const dx = ax - bx;
		const dy = ay - by;
		if (dx * dx + dy * dy < 9.99999944e-11) return;
		writeShape(ShapeType.Line, ax, ay, bx, by, thickness, col);
	},

	// ------ Composite Draw Functions ------
	QuadMinMax(min: Vector2, max: Vector2, col: Color) {
		Draw.Quad(min.add(max).div(2), max.sub(min), col);
	},

	QuadOutlineMinMax(min: Vector2, max: Vector2, thickness: number, col: Color) {
		Draw.QuadOutline(min.add(max).div(2), max.sub(min), thickness, col);
	},

	QuadOutline(centre: Vector2, size: Vector2, thickness: number, col: Color) {
		const bottomLeft = centre.sub(size.div(2));
		const topRight = centre.add(size.div(2));
		const topLeft = new Vector2(bottomLeft.x, topRight.y);
		const bottomRight = new Vector2(topRight.x, bottomLeft.y);
		Draw.Line(bottomLeft, topLeft, thickness, col);
		Draw.Line(topLeft, topRight, thickness, col);
		Draw.Line(topRight, bottomRight, thickness, col);
		Draw.Line(bottomRight, bottomLeft, thickness, col);
	},

	Arrow(start: Vector2, end: Vector2, thickness: number, col: Color, t = 1, headLength = thickness * 3.5, headAngleDeg = 32) {
		const animEnd = Vector2.lerp(start, end, t);
		const dir = end.sub(start).normalized;
		const perp = new Vector2(-dir.y, dir.x);
		const headT = Mathf.InverseLerp(0.3, 1, t);
		const angle = Mathf.Deg2Rad * headAngleDeg * headT;
		const cos = Math.cos(angle);
		const sin = Math.sin(angle);
		const headDirA = dir.mul(-cos).add(perp.mul(sin));
		const headDirB = dir.mul(-cos).sub(perp.mul(sin));
		if (headAngleDeg < 90) headLength = Math.min(headLength, animEnd.sub(start).magnitude / cos);
		const headEndA = animEnd.add(headDirA.mul(headLength));
		const headEndB = animEnd.add(headDirB.mul(headLength));
		Draw.Line(start, animEnd, thickness, col);
		Draw.Line(animEnd, headEndA, thickness, col);
		Draw.Line(animEnd, headEndB, thickness, col);
		Draw.Line(headEndA, headEndB, thickness, col);
		if (headEndA.sub(headEndB).magnitude > thickness) Draw.Triangle(animEnd, headEndA, headEndB, col);
	},

	// ------ Bounds ------
	CalculateTextBoundsSize(text: string, fontSize: number, font: FontType, lineSpacing = 1, textLength = -1): Vector2 {
		const length = textLength < 0 ? text.length : textLength;
		return CalculateLocalBounds(text, fonts[font], layoutSettings(fontSize, lineSpacing), length).Size;
	},

	CalculateTextBounds(text: string, font: FontType, fontSize: number, pos: Vector2, anchor: Anchor, lineSpacing = 1): BoundingBox {
		return CalculateWorldBounds(text, fonts[font], layoutSettings(fontSize, lineSpacing), pos, anchor);
	},

	IsPointInsideActiveMask(p: Vector2): boolean {
		const mask = maskStack[maskStack.length - 1];
		if (mask) return p.x >= mask.boundsMin.x && p.x <= mask.boundsMax.x && p.y >= mask.boundsMin.y && p.y <= mask.boundsMax.y;
		return true;
	},

	// ------ Reserve and Modify Functions ------
	ReserveLine(): DrawID {
		return new DrawID(writeShape(ShapeType.Line, 0, 0, 0, 0, 0, Color.clear));
	},

	ModifyLine(id: DrawID, start: Vector2, end: Vector2, thickness: number, col: Color) {
		modifyShape(id.index, ShapeType.Line, start.x, start.y, end.x, end.y, thickness, col);
	},

	ReserveQuad(): DrawID {
		return new DrawID(writeShape(ShapeType.Quad, 0, 0, 0, 0, 0, Color.clear));
	},

	ModifyQuad(id: DrawID, centre: Vector2, size: Vector2, col: Color) {
		modifyShape(id.index, ShapeType.Quad, centre.x, centre.y, size.x, size.y, 0, col);
	},

	// ------ Rendering ------
	Init(canvas: HTMLCanvasElement): boolean {
		return renderer.init(canvas);
	},

	Render() {
		const last = layers[layers.length - 1];
		if (last) {
			last.shapeEnd = shapes.count;
			last.glyphEnd = glyphs.count;
		}
		renderer.render();
	},

	// (debug) raw instance data of shapes drawn so far this frame
	get DebugShapeData(): Float32Array {
		return shapes.data.slice(0, shapes.count * FloatsPerInstance);
	},

	get DebugGlyphData(): Float32Array {
		return glyphs.data.slice(0, glyphs.count * FloatsPerInstance);
	},

	get Stats() {
		return { shapes: shapes.count, glyphs: glyphs.count, layers: layers.length };
	},
};

function modifyShape(index: number, type: ShapeType, ax: number, ay: number, bx: number, by: number, param: number, col: Color) {
	const o = index * FloatsPerInstance;
	const d = shapes.data;
	d[o] = type;
	d[o + 1] = param;
	d[o + 4] = ax;
	d[o + 5] = ay;
	d[o + 6] = bx;
	d[o + 7] = by;
	d[o + 8] = col.r;
	d[o + 9] = col.g;
	d[o + 10] = col.b;
	d[o + 11] = col.a;
	d[o + 12] = activeMaskMinX;
	d[o + 13] = activeMaskMinY;
	d[o + 14] = activeMaskMaxX;
	d[o + 15] = activeMaskMaxY;
}

// =====================================================================================================
// WebGL2 backend
// =====================================================================================================
const DataTexWidth = 2048;

class GLRenderer {
	gl!: WebGL2RenderingContext;
	shapeProg!: WebGLProgram;
	textProg!: WebGLProgram;
	shapeVao!: WebGLVertexArrayObject;
	textVao!: WebGLVertexArrayObject;
	shapeInstBuf!: WebGLBuffer;
	textInstBuf!: WebGLBuffer;
	bezierTex!: WebGLTexture;
	metaTex!: WebGLTexture;
	shapeUniforms: Record<string, WebGLUniformLocation | null> = {};
	textUniforms: Record<string, WebGLUniformLocation | null> = {};
	shapeBufCapacity = 0;
	textBufCapacity = 0;

	init(canvas: HTMLCanvasElement): boolean {
		const gl = canvas.getContext("webgl2", { antialias: false, alpha: false, premultipliedAlpha: false, depth: false, stencil: false, preserveDrawingBuffer: false, powerPreference: "high-performance" });
		if (!gl) return false;
		this.gl = gl;

		this.shapeProg = this.createProgram(ShapeVS, ShapeFS);
		this.textProg = this.createProgram(TextVS, TextFS);
		for (const n of ["LayerOffset", "LayerScale", "useScreenSpace", "ScreenSize", "CamPos", "CamHalfSize"]) this.shapeUniforms[n] = gl.getUniformLocation(this.shapeProg, n);
		for (const n of ["ScreenSize", "CamPos", "CamHalfSize", "BezierData", "GlyphMetaData", "DataTexWidth"]) this.textUniforms[n] = gl.getUniformLocation(this.textProg, n);

		// Unit quad (triangle strip): vertex xy, uv
		const quad = new Float32Array([-0.5, 0.5, 0, 1, 0.5, 0.5, 1, 1, -0.5, -0.5, 0, 0, 0.5, -0.5, 1, 0]);
		const quadBuf = gl.createBuffer()!;
		gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
		gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);

		const setupVao = (instBuf: WebGLBuffer) => {
			const vao = gl.createVertexArray()!;
			gl.bindVertexArray(vao);
			gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
			gl.enableVertexAttribArray(0);
			gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0);
			gl.enableVertexAttribArray(1);
			gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 8);
			gl.bindBuffer(gl.ARRAY_BUFFER, instBuf);
			for (let i = 0; i < 4; i++) {
				gl.enableVertexAttribArray(2 + i);
				gl.vertexAttribDivisor(2 + i, 1);
			}
			gl.bindVertexArray(null);
			return vao;
		};

		this.shapeInstBuf = gl.createBuffer()!;
		this.textInstBuf = gl.createBuffer()!;
		this.shapeVao = setupVao(this.shapeInstBuf);
		this.textVao = setupVao(this.textInstBuf);

		const makeTex = () => {
			const t = gl.createTexture()!;
			gl.bindTexture(gl.TEXTURE_2D, t);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
			return t;
		};
		this.bezierTex = makeTex();
		this.metaTex = makeTex();

		gl.disable(gl.DEPTH_TEST);
		gl.disable(gl.CULL_FACE);
		gl.enable(gl.BLEND);
		gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
		return true;
	}

	createProgram(vsSrc: string, fsSrc: string): WebGLProgram {
		const gl = this.gl;
		const compile = (type: number, src: string) => {
			const s = gl.createShader(type)!;
			gl.shaderSource(s, src);
			gl.compileShader(s);
			if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error("Shader compile error: " + gl.getShaderInfoLog(s));
			return s;
		};
		const p = gl.createProgram()!;
		gl.attachShader(p, compile(gl.VERTEX_SHADER, vsSrc));
		gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fsSrc));
		gl.linkProgram(p);
		if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error("Program link error: " + gl.getProgramInfoLog(p));
		return p;
	}

	uploadGlyphData() {
		const gl = this.gl;
		const numPoints = bezierPoints.length / 2;
		const rowsB = Math.max(1, Math.ceil(numPoints / DataTexWidth));
		const bData = new Float32Array(rowsB * DataTexWidth * 2);
		bData.set(bezierPoints);
		gl.bindTexture(gl.TEXTURE_2D, this.bezierTex);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, DataTexWidth, rowsB, 0, gl.RG, gl.FLOAT, bData);

		const rowsM = Math.max(1, Math.ceil(glyphMetadata.length / DataTexWidth));
		const mData = new Float32Array(rowsM * DataTexWidth);
		mData.set(glyphMetadata);
		gl.bindTexture(gl.TEXTURE_2D, this.metaTex);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, DataTexWidth, rowsM, 0, gl.RED, gl.FLOAT, mData);
		glyphDataDirty = false;
	}

	bindInstanceAttribs(startInstance: number) {
		const gl = this.gl;
		const base = startInstance * BytesPerInstance;
		for (let i = 0; i < 4; i++) gl.vertexAttribPointer(2 + i, 4, gl.FLOAT, false, BytesPerInstance, base + i * 16);
	}

	uploadInstances(buf: WebGLBuffer, data: InstanceBuffer, which: "shape" | "text") {
		const gl = this.gl;
		gl.bindBuffer(gl.ARRAY_BUFFER, buf);
		const bytes = data.count * BytesPerInstance;
		const cap = which === "shape" ? this.shapeBufCapacity : this.textBufCapacity;
		if (bytes > cap) {
			const newCap = Math.max(bytes, cap * 2, 1 << 16);
			gl.bufferData(gl.ARRAY_BUFFER, newCap, gl.DYNAMIC_DRAW);
			if (which === "shape") this.shapeBufCapacity = newCap;
			else this.textBufCapacity = newCap;
		}
		if (bytes > 0) gl.bufferSubData(gl.ARRAY_BUFFER, 0, data.data, 0, data.count * FloatsPerInstance);
	}

	render() {
		const gl = this.gl;
		gl.viewport(0, 0, screenW, screenH);
		gl.clearColor(clearCol.r, clearCol.g, clearCol.b, 1);
		gl.clear(gl.COLOR_BUFFER_BIT);

		if (glyphDataDirty && glyphMetadata.length > 0) this.uploadGlyphData();

		this.uploadInstances(this.shapeInstBuf, shapes, "shape");
		this.uploadInstances(this.textInstBuf, glyphs, "text");

		const halfH = camOrthoSize;
		const halfW = camOrthoSize * (screenW / Math.max(1, screenH));

		// Shape program constants
		gl.useProgram(this.shapeProg);
		gl.uniform2f(this.shapeUniforms.ScreenSize, screenW, screenH);
		gl.uniform2f(this.shapeUniforms.CamPos, camPosX, camPosY);
		gl.uniform2f(this.shapeUniforms.CamHalfSize, halfW, halfH);

		gl.useProgram(this.textProg);
		gl.uniform2f(this.textUniforms.ScreenSize, screenW, screenH);
		gl.uniform2f(this.textUniforms.CamPos, camPosX, camPosY);
		gl.uniform2f(this.textUniforms.CamHalfSize, halfW, halfH);
		gl.uniform1i(this.textUniforms.DataTexWidth, DataTexWidth);
		gl.activeTexture(gl.TEXTURE0);
		gl.bindTexture(gl.TEXTURE_2D, this.bezierTex);
		gl.uniform1i(this.textUniforms.BezierData, 0);
		gl.activeTexture(gl.TEXTURE1);
		gl.bindTexture(gl.TEXTURE_2D, this.metaTex);
		gl.uniform1i(this.textUniforms.GlyphMetaData, 1);

		let currentProg: WebGLProgram | null = null;

		for (const layer of layers) {
			const shapeCount = layer.shapeEnd - layer.shapeStart;
			if (shapeCount > 0) {
				if (currentProg !== this.shapeProg) {
					gl.useProgram(this.shapeProg);
					gl.bindVertexArray(this.shapeVao);
					gl.bindBuffer(gl.ARRAY_BUFFER, this.shapeInstBuf);
					currentProg = this.shapeProg;
				}
				gl.uniform2f(this.shapeUniforms.LayerOffset, layer.offset.x, layer.offset.y);
				gl.uniform1f(this.shapeUniforms.LayerScale, layer.scale);
				gl.uniform1i(this.shapeUniforms.useScreenSpace, layer.useScreenSpace ? 1 : 0);
				this.bindInstanceAttribs(layer.shapeStart);
				gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, shapeCount);
			}

			const glyphCount = layer.glyphEnd - layer.glyphStart;
			if (glyphCount > 0) {
				if (currentProg !== this.textProg) {
					gl.useProgram(this.textProg);
					gl.bindVertexArray(this.textVao);
					gl.bindBuffer(gl.ARRAY_BUFFER, this.textInstBuf);
					currentProg = this.textProg;
				}
				this.bindInstanceAttribs(layer.glyphStart);
				gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, glyphCount);
			}
		}

		gl.bindVertexArray(null);
	}
}

const renderer = new GLRenderer();

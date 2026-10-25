// GLSL ES 3.0 ports of Seb.Vis "Vis/Draw" (Draw.shader + DrawCommon.hlsl) and "Seb.Vis.Text/TextShader".

// Per-instance layout (16 floats):
//  i0: type, param, c.x, c.y   (c = third triangle vertex)
//  i1: a.x, a.y, b.x, b.y
//  i2: colour rgba
//  i3: maskMin.xy, maskMax.xy
export const ShapeVS = /* glsl */ `#version 300 es
precision highp float;
precision highp int;

layout(location = 0) in vec2 aVertex;
layout(location = 1) in vec2 aUV;
layout(location = 2) in vec4 i0;
layout(location = 3) in vec4 i1;
layout(location = 4) in vec4 i2;
layout(location = 5) in vec4 i3;

uniform vec2 LayerOffset;
uniform float LayerScale;
uniform int useScreenSpace;
uniform vec2 ScreenSize;
uniform vec2 CamPos;
uniform vec2 CamHalfSize;

flat out int vShapeType;
out vec2 vUV;
out vec2 vSizeData;
out vec4 vCol;
out vec2 vWorldPos;
out vec4 vLineEndPoints;
out vec2 vPosLocal;
flat out vec4 vMaskMinMax;
flat out float vInvTexelSize;
flat out int vUseAA;

const int LINE_TYPE = 0;
const int POINT_TYPE = 1;
const int QUAD_TYPE = 2;
const int TRIANGLE_TYPE = 3;
const int SATVAL_TYPE = 4;
const int HUE_TYPE = 5;
const int DIAMOND_TYPE = 6;
const int POINT_OUTLINE_TYPE = 7;

vec2 CalculateTexelSize() {
	if (useScreenSpace == 1) return vec2(1.0);
	return (CamHalfSize * 2.0) / ScreenSize;
}

vec4 WorldToClipPos(vec2 worldPos) {
	if (useScreenSpace == 1) {
		vec2 uv = worldPos / ScreenSize;
		return vec4(uv * 2.0 - 1.0, 0.0, 1.0);
	}
	return vec4((worldPos - CamPos) / CamHalfSize, 0.0, 1.0);
}

void main() {
	int type = int(i0.x + 0.5);
	float param = i0.y;
	vec2 a = i1.xy;
	vec2 b = i1.zw;

	vShapeType = type;
	vMaskMinMax = i3;
	vCol = i2;
	vUV = aUV;
	vSizeData = vec2(0.0);
	vLineEndPoints = vec4(0.0);
	vPosLocal = vec2(0.0);
	vec2 worldVertPos = vec2(0.0);

	// currently disabling AA for screenspace quads due to it causing annoying slivers between elements
	bool useAntialiasing = (useScreenSpace == 0 || type != QUAD_TYPE);
	vUseAA = useAntialiasing ? 1 : 0;

	vec2 texelSize = CalculateTexelSize();
	vec2 aaPad = useAntialiasing ? texelSize * 2.0 : vec2(0.0);
	vInvTexelSize = 1.0 / texelSize.x;

	if (type == LINE_TYPE) {
		vec2 worldPosA = a * LayerScale + LayerOffset;
		vec2 worldPosB = b * LayerScale + LayerOffset;
		vec2 centre = (worldPosA + worldPosB) * 0.5;
		vec2 lineOffset = worldPosB - worldPosA;
		float lineSegmentLength = length(lineOffset);
		vec2 lineDir = lineSegmentLength > 0.0 ? lineOffset / lineSegmentLength : vec2(1.0, 0.0);
		vec2 linePerpDir = vec2(-lineDir.y, lineDir.x);

		float thickness = abs(param * LayerScale);
		vec2 linePadAA = aVertex * 2.0 * aaPad;
		float lineMeshLength = lineSegmentLength + thickness * 2.0;
		vec2 vertOffsetLocal = aVertex * vec2(lineMeshLength, thickness * 2.0) + linePadAA;
		vec2 vertOffsetWorld = lineDir * vertOffsetLocal.x + linePerpDir * vertOffsetLocal.y;
		worldVertPos = centre + vertOffsetWorld;

		vSizeData = vec2(lineSegmentLength, thickness);
		vLineEndPoints = vec4(worldPosA, worldPosB);
	} else if (type == POINT_TYPE || type == POINT_OUTLINE_TYPE) {
		vec2 radius = b;
		vec2 worldCentre = a * LayerScale + LayerOffset;
		vec2 size = radius * 2.0 * LayerScale;
		vec2 vertexLocal = aVertex * (size + aaPad);
		worldVertPos = worldCentre + vertexLocal;
		vPosLocal = vertexLocal;
		vSizeData = radius;
		if (type == POINT_OUTLINE_TYPE) vSizeData = vec2(param);
	} else if (type == QUAD_TYPE || type == SATVAL_TYPE || type == HUE_TYPE) {
		vec2 worldCentre = a * LayerScale + LayerOffset;
		vec2 size = b * LayerScale;
		vec2 vertexLocal = aVertex * (size + aaPad);
		worldVertPos = worldCentre + vertexLocal;
		vPosLocal = vertexLocal;
		vSizeData = b;
		if (type == SATVAL_TYPE) vCol = vec4(param);
	} else if (type == TRIANGLE_TYPE) {
		vec2 posA = a * LayerScale + LayerOffset;
		vec2 posB = b * LayerScale + LayerOffset;
		vec2 posC = i0.zw * LayerScale + LayerOffset;
		worldVertPos = mix(mix(posA, posB, aUV.y), posC, aUV.x);
	} else if (type == DIAMOND_TYPE) {
		vec2 worldCentre = a * LayerScale + LayerOffset;
		vec2 size = b * LayerScale;
		worldVertPos = worldCentre + aVertex * size;
		vSizeData = size;
	}

	vWorldPos = worldVertPos;
	gl_Position = WorldToClipPos(worldVertPos);
}
`;

export const ShapeFS = /* glsl */ `#version 300 es
precision highp float;
precision highp int;

uniform vec2 LayerOffset;
uniform float LayerScale;

flat in int vShapeType;
in vec2 vUV;
in vec2 vSizeData;
in vec4 vCol;
in vec2 vWorldPos;
in vec4 vLineEndPoints;
in vec2 vPosLocal;
flat in vec4 vMaskMinMax;
flat in float vInvTexelSize;
flat in int vUseAA;

out vec4 fragColor;

float boxSdf(vec2 p, vec2 centre, vec2 size) {
	vec2 offset = abs(p - centre) - size;
	float unsignedDst = length(max(offset, 0.0));
	float dstInsideBox = max(min(offset.x, 0.0), min(offset.y, 0.0));
	return unsignedDst + dstInsideBox;
}

vec3 hsv_to_rgb(vec3 c) {
	vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
	vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
	return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}

float CalculateAlphaFromSDF(float sdf) {
	if (vUseAA == 0) return 1.0;
	float sdf_texel = sdf * vInvTexelSize;
	return clamp(0.5 - sdf_texel, 0.0, 1.0);
}

float distanceToLineSegment(vec2 p, vec2 a1, vec2 a2) {
	vec2 lineDelta = a2 - a1;
	float sqrLineLength = dot(lineDelta, lineDelta);
	if (sqrLineLength == 0.0) return length(p - a1);
	vec2 pointDelta = p - a1;
	float t = clamp(dot(pointDelta, lineDelta) / sqrLineLength, 0.0, 1.0);
	vec2 pointOnLineSeg = a1 + lineDelta * t;
	return length(p - pointOnLineSeg);
}

vec4 lineDraw_aa2(vec2 col_dummy) {
	float pixelSize = abs(dFdx(vWorldPos.x));
	float thickness = vSizeData.y;
	float dst = distanceToLineSegment(vWorldPos, vLineEndPoints.xy, vLineEndPoints.zw);
	float alpha = 1.0 - smoothstep(0.0, pixelSize, dst - thickness);
	return vec4(vCol.rgb, vCol.a * alpha);
}

vec4 circleDraw() {
	float radius = vSizeData.x;
	float sdf = length(vPosLocal) - radius;
	float alpha = CalculateAlphaFromSDF(sdf);
	return vec4(vCol.rgb, alpha * vCol.a);
}

vec4 circleOutlineDraw() {
	float innerRadiusT = vSizeData.x;
	vec2 centreOffset = (vUV - 0.5) * 2.0;
	float dst = sqrt(dot(centreOffset, centreOffset));
	float delta = fwidth(dst);
	float alpha = max(dst - 1.0, innerRadiusT - dst);
	alpha = 1.0 - smoothstep(-delta, delta, alpha);
	return vec4(vCol.rgb, alpha * vCol.a);
}

vec4 quadDraw(vec4 col) {
	float sdf = boxSdf(vec2(0.0), vPosLocal, vSizeData / 2.0);
	float alpha = CalculateAlphaFromSDF(sdf);
	return vec4(col.rgb, alpha * col.a);
}

vec4 diamondDraw() {
	vec2 size = vSizeData;
	vec2 p = abs(vUV - 0.5) * size;
	if (size.x < size.y) {
		size = size.yx;
		p = p.yx;
	}
	p.x = size.x * 0.5 - p.x;
	float a = p.x > p.y ? 1.0 : 0.0;
	return vec4(vCol.rgb, vCol.a * a);
}

void main() {
	vec2 maskMin = vMaskMinMax.xy * LayerScale + LayerOffset;
	vec2 maskMax = vMaskMinMax.zw * LayerScale + LayerOffset;
	if (vWorldPos.x < maskMin.x || vWorldPos.x > maskMax.x || vWorldPos.y < maskMin.y || vWorldPos.y > maskMax.y) discard;

	vec4 result;
	if (vShapeType == 0) result = lineDraw_aa2(vec2(0.0));
	else if (vShapeType == 1) result = circleDraw();
	else if (vShapeType == 7) result = circleOutlineDraw();
	else if (vShapeType == 2) result = quadDraw(vCol);
	else if (vShapeType == 3) result = vCol;
	else if (vShapeType == 4) result = quadDraw(vec4(hsv_to_rgb(vec3(vCol.x, vUV.x, vUV.y)), 1.0));
	else if (vShapeType == 5) result = quadDraw(vec4(hsv_to_rgb(vec3(vUV.y, 1.0, 1.0)), 1.0));
	else if (vShapeType == 6) result = diamondDraw();
	else result = vec4(0.0, 0.0, 0.0, 1.0);

	if (result.a <= 0.0) discard;
	fragColor = vec4(result.rgb, min(result.a, 1.0));
}
`;

// Text glyph instance layout (16 floats):
//  t0: centre.x, centre.y, sizeEm.x, sizeEm.y   (centre already includes group offset)
//  t1: colour rgba
//  t2: fontSize, dataOffset, useScreenSpace, 0
//  t3: maskMin.xy, maskMax.xy
export const TextVS = /* glsl */ `#version 300 es
precision highp float;
precision highp int;

layout(location = 0) in vec2 aVertex;
layout(location = 1) in vec2 aUV;
layout(location = 2) in vec4 t0;
layout(location = 3) in vec4 t1;
layout(location = 4) in vec4 t2;
layout(location = 5) in vec4 t3;

uniform vec2 ScreenSize;
uniform vec2 CamPos;
uniform vec2 CamHalfSize;

out vec2 vPos;
out vec2 vWorldPos;
flat out int vDataOffset;
flat out vec4 vMask;
out vec4 vCol;

void main() {
	vec2 worldUnitsPerPixel = (CamHalfSize * 2.0) / ScreenSize;
	vec2 aaPad = worldUnitsPerPixel * 2.0;
	vec2 quadSize = t0.zw + aaPad;
	float fontSize = t2.x;
	vec2 worldVertPos = aVertex * quadSize * fontSize + t0.xy;

	if (t2.z > 0.5) {
		vec2 uv = worldVertPos / ScreenSize;
		gl_Position = vec4(uv * 2.0 - 1.0, 0.0, 1.0);
	} else {
		gl_Position = vec4((worldVertPos - CamPos) / CamHalfSize, 0.0, 1.0);
	}

	vPos = -quadSize / 2.0 + quadSize * aUV;
	vWorldPos = worldVertPos;
	vDataOffset = int(t2.y + 0.5);
	vMask = t3;
	vCol = t1;
}
`;

export const TextFS = /* glsl */ `#version 300 es
precision highp float;
precision highp int;

uniform highp sampler2D BezierData;   // RG32F: control points (relative to glyph centre)
uniform highp sampler2D GlyphMetaData; // R32F: [pointOffset, numContours, (numPoints-1) per contour...]
uniform int DataTexWidth;

in vec2 vPos;
in vec2 vWorldPos;
flat in int vDataOffset;
flat in vec4 vMask;
in vec4 vCol;

out vec4 fragColor;

vec2 bezierPoint(int i) {
	return texelFetch(BezierData, ivec2(i % DataTexWidth, i / DataTexWidth), 0).xy;
}

int metaData(int i) {
	return int(texelFetch(GlyphMetaData, ivec2(i % DataTexWidth, i / DataTexWidth), 0).x + 0.5);
}

vec2 CalculateQuadraticRoots(float a, float b, float c) {
	const float epsilon = 1e-5;
	vec2 roots = vec2(-99999.0);
	if (abs(a) < epsilon) {
		if (b != 0.0) roots.x = -c / b;
	} else {
		float discriminant = b * b - 4.0 * a * c;
		if (discriminant > -epsilon) {
			float s = sqrt(max(0.0, discriminant));
			roots.x = (-b + s) / (2.0 * a);
			roots.y = (-b - s) / (2.0 * a);
		}
	}
	return roots;
}

float CalculateHorizontalCoverage(vec2 pixelPos, int dataOffset, float pixelSize) {
	float coverage = 0.0;
	float invPixelSize = 1.0 / pixelSize;

	int pointOffset = metaData(dataOffset);
	int numContours = metaData(dataOffset + 1);
	dataOffset += 2;

	for (int contourIndex = 0; contourIndex < numContours; contourIndex++) {
		int numPoints = metaData(dataOffset + contourIndex);

		for (int i = 0; i < numPoints; i += 2) {
			vec2 p0 = bezierPoint(i + 0 + pointOffset) - pixelPos;
			vec2 p1 = bezierPoint(i + 1 + pointOffset) - pixelPos;
			vec2 p2 = bezierPoint(i + 2 + pointOffset) - pixelPos;

			bool isDownwardCurve = p0.y > 0.0 || p2.y < 0.0;

			if (isDownwardCurve) {
				if (p0.y < 0.0 && p2.y <= 0.0) continue;
				if (p0.y > 0.0 && p2.y >= 0.0) continue;
			} else {
				if (p0.y <= 0.0 && p2.y < 0.0) continue;
				if (p0.y >= 0.0 && p2.y > 0.0) continue;
			}

			vec2 a = p0 - 2.0 * p1 + p2;
			vec2 b = 2.0 * (p1 - p0);
			vec2 c = p0;

			const float epsilon = 1e-4;
			vec2 roots = CalculateQuadraticRoots(a.y, b.y, c.y);
			bool onSeg0 = roots.x >= -epsilon && roots.x <= 1.0 + epsilon;
			bool onSeg1 = roots.y >= -epsilon && roots.y <= 1.0 + epsilon;

			float t0 = clamp(roots.x, 0.0, 1.0);
			float t1 = clamp(roots.y, 0.0, 1.0);
			float intersect0 = a.x * t0 * t0 + b.x * t0 + c.x;
			float intersect1 = a.x * t1 * t1 + b.x * t1 + c.x;

			float sgn = isDownwardCurve ? 1.0 : -1.0;
			if (onSeg0) coverage += clamp(0.5 + intersect0 * invPixelSize, 0.0, 1.0) * sgn;
			if (onSeg1) coverage += clamp(0.5 + intersect1 * invPixelSize, 0.0, 1.0) * sgn;
		}

		pointOffset += numPoints + 1;
	}

	return clamp(coverage, 0.0, 1.0);
}

void main() {
	if (vWorldPos.x < vMask.x || vWorldPos.x > vMask.z || vWorldPos.y < vMask.y || vWorldPos.y > vMask.w) discard;

	float pixelSize = dFdx(vPos.x);
	float alphaSum = 0.0;

	for (int yOffset = -1; yOffset <= 1; yOffset++) {
		vec2 samplePos = vPos + vec2(0.0, float(yOffset)) * pixelSize / 3.0;
		alphaSum += CalculateHorizontalCoverage(samplePos, vDataOffset, pixelSize);
	}

	float alpha = vCol.a * alphaSum / 3.0;
	if (alpha <= 0.0) discard;
	fragColor = vec4(vCol.rgb, alpha);
}
`;

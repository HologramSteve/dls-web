// Port of the subset of Seb.Helpers.Maths used by DLS
import { Vector2 } from "../types/Vector2";
import { roundHalfEven } from "../types/Mathf";

const Epsilon = 1.175494351e-38;

export const Maths = {
	Lerp(a: number, b: number, t: number): number {
		return a + (b - a) * t; // unclamped
	},

	Clamp01(t: number): number {
		return t < 0 ? 0 : t > 1 ? 1 : t;
	},

	EaseQuadInOut(t: number): number {
		const c = Maths.Clamp01(t);
		return 3 * c * c - 2 * c * c * c;
	},

	EaseCubeInOut(t: number): number {
		t = Maths.Clamp01(t);
		const r = roundHalfEven(t);
		return 4 * t * t * t * (1 - r) + (1 - 4 * (1 - t) * (1 - t) * (1 - t)) * r;
	},

	Abs(v: Vector2): Vector2 {
		return new Vector2(Math.abs(v.x), Math.abs(v.y));
	},

	AbsoluteMax(a: number, b: number): number {
		return Math.abs(a) > Math.abs(b) ? a : b;
	},

	PointInBox2D(point: Vector2, boxCentre: Vector2, boxSize: Vector2): boolean {
		const ox = Math.abs(point.x - boxCentre.x);
		const oy = Math.abs(point.y - boxCentre.y);
		return ox < boxSize.x / 2 && oy < boxSize.y / 2;
	},

	BoxesOverlap(centreA: Vector2, sizeA: Vector2, centreB: Vector2, sizeB: Vector2): boolean {
		const leftA = centreA.x - sizeA.x / 2;
		const rightA = centreA.x + sizeA.x / 2;
		const topA = centreA.y + sizeA.y / 2;
		const bottomA = centreA.y - sizeA.y / 2;

		const leftB = centreB.x - sizeB.x / 2;
		const rightB = centreB.x + sizeB.x / 2;
		const topB = centreB.y + sizeB.y / 2;
		const bottomB = centreB.y - sizeB.y / 2;

		return leftA <= rightB && rightA >= leftB && topA >= bottomB && bottomA <= topB;
	},

	PointInCircle2D(point: Vector2, centre: Vector2, radius: number): boolean {
		const dx = point.x - centre.x;
		const dy = point.y - centre.y;
		return dx * dx + dy * dy <= radius * radius;
	},

	ClosestPointOnLineSegment(p: Vector2, a1: Vector2, a2: Vector2): Vector2 {
		const ldx = a2.x - a1.x;
		const ldy = a2.y - a1.y;
		const sqrLen = ldx * ldx + ldy * ldy;
		if (sqrLen === 0) return a1;
		let t = ((p.x - a1.x) * ldx + (p.y - a1.y) * ldy) / sqrLen;
		t = t < 0 ? 0 : t > 1 ? 1 : t;
		return new Vector2(a1.x + ldx * t, a1.y + ldy * t);
	},

	SqrDistanceToLineSegment(p: Vector2, a1: Vector2, a2: Vector2): number {
		const ldx = a2.x - a1.x;
		const ldy = a2.y - a1.y;
		const sqrLen = ldx * ldx + ldy * ldy;
		let cx = a1.x;
		let cy = a1.y;
		if (sqrLen !== 0) {
			let t = ((p.x - a1.x) * ldx + (p.y - a1.y) * ldy) / sqrLen;
			t = t < 0 ? 0 : t > 1 ? 1 : t;
			cx += ldx * t;
			cy += ldy * t;
		}
		const dx = p.x - cx;
		const dy = p.y - cy;
		return dx * dx + dy * dy;
	},

	ApproximatelyEqual(a: number, b: number): boolean {
		return Math.abs(a - b) < Epsilon;
	},

	// Test if two infinite 2D lines intersect (true unless parallel), and get point of intersection
	LineIntersectsLine(a1: Vector2, a2: Vector2, b1: Vector2, b2: Vector2): [boolean, Vector2] {
		const d = (a1.x - a2.x) * (b1.y - b2.y) - (a1.y - a2.y) * (b1.x - b2.x);
		if (Maths.ApproximatelyEqual(d, 0)) return [false, Vector2.zero];
		const n = (a1.x - b1.x) * (b1.y - b2.y) - (a1.y - b1.y) * (b1.x - b2.x);
		const t = n / d;
		return [true, new Vector2(a1.x + (a2.x - a1.x) * t, a1.y + (a2.y - a1.y) * t)];
	},

	TwosComplement(unsignedValue: number, numBits: number): number {
		if (numBits < 32) {
			const unsignedRange = 2 ** numBits;
			const firstNegativeValue = unsignedRange / 2;
			if (unsignedValue >= firstNegativeValue) return unsignedValue - unsignedRange;
		}
		return unsignedValue | 0;
	},
};

// Immutable 2D vector (port of UnityEngine.Vector2 semantics used by DLS).
// C# Vector2 is a value type; here every operation returns a new instance so that
// aliasing can never cause the bugs that mutable shared references would.
export class Vector2 {
	readonly x: number;
	readonly y: number;

	constructor(x = 0, y = 0) {
		this.x = x;
		this.y = y;
	}

	static readonly zero = new Vector2(0, 0);
	static readonly one = new Vector2(1, 1);
	static readonly up = new Vector2(0, 1);
	static readonly down = new Vector2(0, -1);
	static readonly left = new Vector2(-1, 0);
	static readonly right = new Vector2(1, 0);

	add(o: Vector2): Vector2 {
		return new Vector2(this.x + o.x, this.y + o.y);
	}

	sub(o: Vector2): Vector2 {
		return new Vector2(this.x - o.x, this.y - o.y);
	}

	mul(s: number): Vector2 {
		return new Vector2(this.x * s, this.y * s);
	}

	div(s: number): Vector2 {
		return new Vector2(this.x / s, this.y / s);
	}

	// Component-wise multiply
	scale(o: Vector2): Vector2 {
		return new Vector2(this.x * o.x, this.y * o.y);
	}

	divV(o: Vector2): Vector2 {
		return new Vector2(this.x / o.x, this.y / o.y);
	}

	neg(): Vector2 {
		return new Vector2(-this.x, -this.y);
	}

	withX(x: number): Vector2 {
		return new Vector2(x, this.y);
	}

	withY(y: number): Vector2 {
		return new Vector2(this.x, y);
	}

	get sqrMagnitude(): number {
		return this.x * this.x + this.y * this.y;
	}

	get magnitude(): number {
		return Math.sqrt(this.x * this.x + this.y * this.y);
	}

	get normalized(): Vector2 {
		const m = this.magnitude;
		if (m > 1e-5) return new Vector2(this.x / m, this.y / m);
		return Vector2.zero;
	}

	static dot(a: Vector2, b: Vector2): number {
		return a.x * b.x + a.y * b.y;
	}

	static distance(a: Vector2, b: Vector2): number {
		const dx = a.x - b.x;
		const dy = a.y - b.y;
		return Math.sqrt(dx * dx + dy * dy);
	}

	// Clamped lerp (matches Vector2.Lerp)
	static lerp(a: Vector2, b: Vector2, t: number): Vector2 {
		t = t < 0 ? 0 : t > 1 ? 1 : t;
		return new Vector2(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
	}

	static min(a: Vector2, b: Vector2): Vector2 {
		return new Vector2(Math.min(a.x, b.x), Math.min(a.y, b.y));
	}

	static max(a: Vector2, b: Vector2): Vector2 {
		return new Vector2(Math.max(a.x, b.x), Math.max(a.y, b.y));
	}

	// Equivalent of the C# == operator (approximate equality)
	static eq(a: Vector2, b: Vector2): boolean {
		const dx = a.x - b.x;
		const dy = a.y - b.y;
		return dx * dx + dy * dy < 9.99999944e-11;
	}

	static neq(a: Vector2, b: Vector2): boolean {
		return !Vector2.eq(a, b);
	}

	// Exact equality (C# Vector2.Equals / layer comparisons)
	static exactEq(a: Vector2, b: Vector2): boolean {
		return a.x === b.x && a.y === b.y;
	}

	toString(): string {
		return `(${this.x.toFixed(2)}, ${this.y.toFixed(2)})`;
	}
}

export function v2(x: number, y: number): Vector2 {
	return new Vector2(x, y);
}

export class Vector2Int {
	readonly x: number;
	readonly y: number;

	constructor(x: number, y: number) {
		this.x = x | 0;
		this.y = y | 0;
	}

	static readonly zero = new Vector2Int(0, 0);
	static readonly one = new Vector2Int(1, 1);
	static readonly right = new Vector2Int(1, 0);
	static readonly left = new Vector2Int(-1, 0);
	static readonly up = new Vector2Int(0, 1);
	static readonly down = new Vector2Int(0, -1);

	toVector2(): Vector2 {
		return new Vector2(this.x, this.y);
	}
}

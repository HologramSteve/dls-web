import { Vector2 } from "./Vector2";

// Port of Seb.Types.Bounds2D
export class Bounds2D {
	readonly Min: Vector2;
	readonly Max: Vector2;

	constructor(min: Vector2, max: Vector2) {
		this.Min = min;
		this.Max = max;
	}

	get Size(): Vector2 {
		return this.Max.sub(this.Min);
	}
	get Centre(): Vector2 {
		return new Vector2((this.Min.x + this.Max.x) / 2, (this.Min.y + this.Max.y) / 2);
	}
	get Width(): number {
		return this.Max.x - this.Min.x;
	}
	get Height(): number {
		return this.Max.y - this.Min.y;
	}
	get BottomLeft(): Vector2 {
		return this.Min;
	}
	get TopRight(): Vector2 {
		return this.Max;
	}
	get BottomRight(): Vector2 {
		return new Vector2(this.Max.x, this.Min.y);
	}
	get TopLeft(): Vector2 {
		return new Vector2(this.Min.x, this.Max.y);
	}
	get CentreLeft(): Vector2 {
		return new Vector2(this.Min.x, (this.Min.y + this.Max.y) / 2);
	}
	get CentreRight(): Vector2 {
		return new Vector2(this.Max.x, (this.Min.y + this.Max.y) / 2);
	}
	get CentreTop(): Vector2 {
		return new Vector2((this.Min.x + this.Max.x) / 2, this.Max.y);
	}
	get CentreBottom(): Vector2 {
		return new Vector2((this.Min.x + this.Max.x) / 2, this.Min.y);
	}
	get Left(): number {
		return this.Min.x;
	}
	get Right(): number {
		return this.Max.x;
	}
	get Top(): number {
		return this.Max.y;
	}
	get Bottom(): number {
		return this.Min.y;
	}
	get Area(): number {
		return this.Width * this.Height;
	}

	static readonly zero = new Bounds2D(Vector2.zero, Vector2.zero);

	static CreateFromCentreAndSize(centre: Vector2, size: Vector2): Bounds2D {
		const hx = size.x / 2;
		const hy = size.y / 2;
		return new Bounds2D(new Vector2(centre.x - hx, centre.y - hy), new Vector2(centre.x + hx, centre.y + hy));
	}

	static CreateFromTopLeftAndSize(topLeft: Vector2, size: Vector2): Bounds2D {
		const min = new Vector2(topLeft.x, topLeft.y - size.y);
		return new Bounds2D(min, min.add(size));
	}

	static CreateEmpty(): Bounds2D {
		return new Bounds2D(new Vector2(Number.MAX_VALUE, Number.MAX_VALUE), new Vector2(-Number.MAX_VALUE, -Number.MAX_VALUE));
	}

	static Translate(a: Bounds2D, offset: Vector2): Bounds2D {
		return new Bounds2D(a.Min.add(offset), a.Max.add(offset));
	}

	static Grow(a: Bounds2D, b: Bounds2D | Vector2 | number): Bounds2D {
		if (typeof b === "number") {
			const d = b * 0.5;
			return new Bounds2D(new Vector2(a.Min.x - d, a.Min.y - d), new Vector2(a.Max.x + d, a.Max.y + d));
		}
		if (b instanceof Vector2) {
			return new Bounds2D(Vector2.min(a.Min, b), Vector2.max(a.Max, b));
		}
		return new Bounds2D(Vector2.min(a.Min, b.Min), Vector2.max(a.Max, b.Max));
	}

	static Shrink(bounds: Bounds2D, amount: number): Bounds2D {
		const d = amount * 0.5;
		return new Bounds2D(new Vector2(bounds.Min.x + d, bounds.Min.y + d), new Vector2(bounds.Max.x - d, bounds.Max.y - d));
	}

	static SplitVertical(bounds: Bounds2D, splitT: number): [Bounds2D, Bounds2D] {
		const widthLeft = bounds.Width * splitT;
		const widthRight = bounds.Width * (1 - splitT);
		const left = Bounds2D.CreateFromTopLeftAndSize(bounds.TopLeft, new Vector2(widthLeft, bounds.Height));
		const right = Bounds2D.CreateFromTopLeftAndSize(left.TopRight, new Vector2(widthRight, bounds.Height));
		return [left, right];
	}

	EntirelyInside(parent: Bounds2D): boolean {
		return this.Min.x >= parent.Min.x && this.Max.x <= parent.Max.x && this.Min.y >= parent.Min.y && this.Max.y <= parent.Max.y;
	}

	Overlaps(other: Bounds2D): boolean {
		return !(other.Min.x > this.Max.x || other.Max.x < this.Min.x || other.Min.y > this.Max.y || other.Max.y < this.Min.y);
	}

	DstToCorner(p: Vector2): number {
		const centreOffsetX = Math.abs(this.Centre.x - p.x);
		const centreOffsetY = Math.abs(this.Centre.y - p.y);
		const edgeOffsetX = Math.abs(this.Size.x / 2 - centreOffsetX);
		const edgeOffsetY = Math.abs(this.Size.y / 2 - centreOffsetY);
		return Math.sqrt(edgeOffsetX * edgeOffsetX + edgeOffsetY * edgeOffsetY);
	}

	PointInBounds(p: Vector2): boolean {
		return p.x >= this.Min.x && p.x <= this.Max.x && p.y >= this.Min.y && p.y <= this.Max.y;
	}
}

// Port of DLS.Graphics.WireLayoutHelper and WireDrawer
import { Vector2 } from "../../seb/types/Vector2";
import { Color } from "../../seb/types/Color";
import { Maths } from "../../seb/helpers/Maths";
import { Draw } from "../../seb/vis/Draw";
import type { BitWire, WireInstance } from "../game/elements/WireInstance";

export function CreateMultiBitWireLayout(bitWires: BitWire[], wire: WireInstance, thickness: number) {
	// At 1, wires are spaced apart by their thickness. This can cause slight slivers to appear though due to antialiasing, so it helps to smoosh them together slightly
	const thicknessOffsetT = 0.925;
	const pointCount = wire.WirePointCount;

	for (const bitWire of bitWires) {
		if (bitWire.Points.length !== pointCount) bitWire.Points = new Array(pointCount).fill(Vector2.zero);
	}

	// Cache wire points (GetWirePoint can be relatively expensive)
	const centres: Vector2[] = new Array(pointCount);
	for (let i = 0; i < pointCount; i++) centres[i] = wire.GetWirePoint(i);

	let dirPrev = Vector2.zero;
	const numBits = bitWires.length;
	let offsetSign = 1;

	for (let i = 0; i < pointCount - 1; i++) {
		const wireCentreA = centres[i];
		const wireCentreB = centres[i + 1];
		const wireDir = wireCentreB.sub(wireCentreA).normalized;
		const wirePerpDir = new Vector2(-wireDir.y, wireDir.x);

		// If wire bends back past a certain threshold, swap the offset direction
		if (i > 0) offsetSign *= Flip(wireDir, dirPrev);

		for (let bitIndex = 0; bitIndex < numBits; bitIndex++) {
			const bitWire = bitWires[bitIndex];
			const bitOffsetDst = (bitIndex - (numBits - 1) / 2) * thickness * 2 * thicknessOffsetT;

			const bitWireOffset = wirePerpDir.mul(bitOffsetDst);
			const posA = i === 0 ? wireCentreA.add(bitWireOffset) : bitWire.Points[i];
			let posB = wireCentreB.add(bitWireOffset.mul(offsetSign));

			// If there is another point after this, position the wires to align with that direction
			if (i + 1 < pointCount - 1) {
				const centreNext = centres[i + 2];
				if (centreNext.sub(wireCentreB).sqrMagnitude > 0.001) {
					const dirNext = centreNext.sub(wireCentreB).normalized;
					const wireDirNext = new Vector2(-dirNext.y, dirNext.x);
					const bitWireOffsetNext = wireDirNext.mul(bitOffsetDst);
					const posNext = centreNext.add(bitWireOffsetNext.mul(offsetSign * Flip(wireDir, dirNext)));

					const [intersects, point] = Maths.LineIntersectsLine(posA, posB, posNext, posNext.add(dirNext));
					if (Math.abs(Vector2.dot(wireDir, dirNext)) < 0.995 && intersects) {
						posB = point;
					}
				}
			}

			bitWire.Points[i] = posA;
			bitWire.Points[i + 1] = posB;
		}

		dirPrev = wireDir;
	}
}

export function GetClosestPointOnWire(wire: WireInstance, desiredPos: Vector2): [Vector2, number] {
	let bestSegmentIndex = 0;
	let bestSqrDst = Number.MAX_VALUE;
	let bestPoint = Vector2.zero;

	for (let i = 0; i < wire.WirePointCount - 1; i++) {
		const segStart = wire.GetWirePoint(i);
		const segEnd = wire.GetWirePoint(i + 1);
		const pointOnSegment = Maths.ClosestPointOnLineSegment(desiredPos, segStart, segEnd);
		const sqrDst = pointOnSegment.sub(desiredPos).sqrMagnitude;
		if (sqrDst < bestSqrDst) {
			bestPoint = pointOnSegment;
			bestSqrDst = sqrDst;
			bestSegmentIndex = i;
		}
	}
	return [bestPoint, bestSegmentIndex];
}

function Flip(dirA: Vector2, dirB: Vector2): number {
	// How far back to allow wire to be angled before switching sign
	const threshold = -0.75;
	return Vector2.dot(dirA, dirB) < threshold ? -1 : 1;
}

// ---- WireDrawer ----
// Draws the wire and returns the squared distance from interactPos to the wire
export function DrawWireStraight(points: Vector2[], thickness: number, col: Color, interactPos: Vector2): number {
	let interactSqrDst = Number.MAX_VALUE;
	let inA = points[0];
	for (let i = 1; i < points.length; i++) {
		const inB = points[i];
		Draw.LineXY(inA.x, inA.y, inB.x, inB.y, thickness, col);
		const sqrDst = Maths.SqrDistanceToLineSegment(interactPos, inA, inB);
		if (sqrDst < interactSqrDst) interactSqrDst = sqrDst;
		inA = inB;
	}
	return interactSqrDst;
}

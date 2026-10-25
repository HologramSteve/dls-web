// Port of DLS.Game.GridHelper and IDGenerator
import { Vector2 } from "../../seb/types/Vector2";
import { Mathf } from "../../seb/types/Mathf";
import { GridSize } from "../graphics/DrawSettings";

export interface ISnappable {
	SnapPoint: Vector2;
	Position: Vector2;
	MoveStartPosition: Vector2;
}

export const GridHelper = {
	SnapMovingElementToGrid(element: ISnappable, offset: Vector2, allowCentreSnapX = false, allowCentreSnapY = false): Vector2 {
		const anchorOffset = element.SnapPoint.sub(element.Position);
		return GridHelper.SnapMovingElementToGridPos(element.MoveStartPosition.add(offset), anchorOffset, allowCentreSnapX, allowCentreSnapY);
	},

	SnapMovingElementToGridPos(centrePos: Vector2, anchorPosLocal: Vector2, allowCentreSnapX = false, allowCentreSnapY = false): Vector2 {
		const anchorPos = centrePos.add(anchorPosLocal);
		const anchorPosSnapped = GridHelper.SnapToGridV(anchorPos, allowCentreSnapX, allowCentreSnapY);
		return anchorPosSnapped.sub(anchorPosLocal);
	},

	SnapToGrid(v: number): number {
		const intV = Mathf.RoundToInt(v / GridSize);
		return intV * GridSize;
	},

	// Snap point to grid, with option to allow snapping to centre of grid cells (rather than just the grid lines)
	SnapToGridV(v: Vector2, allowCentreSnapX = false, allowCentreSnapY = false): Vector2 {
		const xM = allowCentreSnapX ? 2 : 1;
		const yM = allowCentreSnapY ? 2 : 1;
		return new Vector2(GridHelper.SnapToGrid(v.x * xM) / xM, GridHelper.SnapToGrid(v.y * yM) / yM);
	},

	SnapToGridForceEven(v: number): number {
		let intV = Mathf.RoundToInt(v / GridSize);
		if ((intV & 1) !== 0) intV++;
		return intV * GridSize;
	},

	ForceStraightLine(prev: Vector2, curr: Vector2): Vector2 {
		let offset = curr.sub(prev);
		if (Math.abs(offset.x) > Math.abs(offset.y)) offset = new Vector2(offset.x, 0);
		else offset = new Vector2(0, offset.y);
		return prev.add(offset);
	},
};

export const IDGenerator = {
	// Generate a random ID (greater than zero) which is guaranteed to be unique (in context of given elements)
	GenerateNewElementID(elements: { ID: number }[]): number {
		while (true) {
			const candidateID = 1 + Math.floor(Math.random() * (2147483647 - 1));
			if (elements.every((x) => x.ID !== candidateID)) return candidateID;
		}
	},
};

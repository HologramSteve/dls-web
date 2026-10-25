// Port of DLS.Game.IInteractable / IMoveable
import type { Vector2 } from "../../../seb/types/Vector2";
import type { Bounds2D } from "../../../seb/types/Bounds2D";

// Marker interface for anything the mouse can interact with
export interface IInteractable {
	readonly isInteractable: true;
}

export interface IMoveable extends IInteractable {
	readonly isMoveable: true;
	Position: Vector2;
	MoveStartPosition: Vector2;
	StraightLineReferencePoint: Vector2;
	HasReferencePointForStraightLineMovement: boolean;
	IsSelected: boolean;
	IsValidMovePos: boolean;
	readonly SnapPoint: Vector2;
	readonly SelectionBoundingBox: Bounds2D;
	readonly BoundingBox: Bounds2D;
	readonly ID: number;
	ShouldBeIncludedInSelectionBox(selectionCentre: Vector2, selectionSize: Vector2): boolean;
}

export function IsMoveable(x: unknown): x is IMoveable {
	return x != null && (x as IMoveable).isMoveable === true;
}

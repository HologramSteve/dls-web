// Port of DLS.Game.DevPinInstance (input/output pins of the chip being edited)
import { Vector2, Vector2Int } from "../../../seb/types/Vector2";
import { Bounds2D } from "../../../seb/types/Bounds2D";
import { Maths } from "../../../seb/helpers/Maths";
import { PinAddress, PinBitCount, PinDescription, PinValueDisplayMode } from "../../description/Types";
import { PinState } from "../../simulation/PinState";
import { DevPinHandleWidth, DevPinStateDisplayOutline, DevPinStateDisplayRadius, GridSize, MultiBitPinStateDisplaySquareSize, PinRadius, SelectionBoundsPadding } from "../../graphics/DrawSettings";
import type { IMoveable } from "./Interfaces";
import { PinInstance } from "./PinInstance";

export class DevPinInstance implements IMoveable {
	readonly kind = "devpin" as const;
	readonly isInteractable = true as const;
	readonly isMoveable = true as const;

	readonly BitCount: PinBitCount;
	// Size/Layout info
	readonly faceDir: Vector2;
	readonly IsInputPin: boolean;
	readonly Name: string;
	readonly Pin: PinInstance;
	readonly StateGridDimensions: Vector2Int;
	readonly StateGridSize: Vector2;
	pinValueDisplayMode: PinValueDisplayMode;

	Position: Vector2;
	MoveStartPosition = Vector2.zero;
	StraightLineReferencePoint = Vector2.zero;
	readonly ID: number;
	IsSelected = false;
	HasReferencePointForStraightLineMovement = false;
	IsValidMovePos = false;

	constructor(pinDescription: PinDescription, isInput: boolean) {
		this.Name = pinDescription.Name;
		this.ID = pinDescription.ID;
		this.IsInputPin = isInput;
		this.Position = pinDescription.Position;
		this.BitCount = pinDescription.BitCount;

		this.Pin = new PinInstance(pinDescription, PinAddress(this.ID, 0), this, isInput);
		this.pinValueDisplayMode = pinDescription.ValueDisplayMode;

		// Calculate layout info
		this.faceDir = new Vector2(this.IsInputPin ? 1 : -1, 0);
		switch (this.BitCount) {
			case PinBitCount.Bit1:
				this.StateGridDimensions = new Vector2Int(1, 1);
				break;
			case PinBitCount.Bit4:
				this.StateGridDimensions = new Vector2Int(2, 2);
				break;
			case PinBitCount.Bit8:
				this.StateGridDimensions = new Vector2Int(4, 2);
				break;
			default:
				throw new Error("Bit count not implemented");
		}
		this.StateGridSize =
			this.BitCount === PinBitCount.Bit1
				? Vector2.one.mul(DevPinStateDisplayRadius * 2 + DevPinStateDisplayOutline * 2)
				: this.StateGridDimensions.toVector2().mul(MultiBitPinStateDisplaySquareSize).add(Vector2.one.mul(DevPinStateDisplayOutline));
	}

	get HandlePosition(): Vector2 {
		return this.Position;
	}

	get StateDisplayPosition(): Vector2 {
		return this.HandlePosition.add(this.faceDir.mul(DevPinHandleWidth / 2 + this.StateGridSize.x / 2 + 0.065));
	}

	get PinPosition(): Vector2 {
		const gridDst = this.BitCount === PinBitCount.Bit1 || this.BitCount === PinBitCount.Bit4 ? 6 : 9;
		return this.HandlePosition.add(this.faceDir.mul(GridSize * gridDst));
	}

	get SelectionBoundingBox(): Bounds2D {
		return this.CreateBoundingBox(SelectionBoundsPadding);
	}

	get BoundingBox(): Bounds2D {
		return this.CreateBoundingBox(0);
	}

	get SnapPoint(): Vector2 {
		return this.Pin.GetWorldPos();
	}

	ShouldBeIncludedInSelectionBox(selectionCentre: Vector2, selectionSize: Vector2): boolean {
		const selfBounds = this.SelectionBoundingBox;
		return Maths.BoxesOverlap(selectionCentre, selectionSize, selfBounds.Centre, selfBounds.Size);
	}

	GetStateDecimalDisplayValue(): number {
		const rawValue = PinState.GetBitStates(this.Pin.State);
		let displayValue = rawValue;
		if (this.pinValueDisplayMode === PinValueDisplayMode.SignedDecimal) {
			displayValue = Maths.TwosComplement(rawValue, this.BitCount);
		}
		return displayValue;
	}

	private CreateBoundingBox(pad: number): Bounds2D {
		const x1 = this.HandlePosition.x - (this.faceDir.x * DevPinHandleWidth) / 2;
		const x2 = this.PinPosition.x + this.faceDir.x * PinRadius;
		const minX = Math.min(x1, x2);
		const maxX = Math.max(x1, x2);
		const centre = new Vector2((minX + maxX) / 2, this.HandlePosition.y);
		const size = new Vector2(maxX - minX + pad, this.BoundsHeight() + pad);
		return Bounds2D.CreateFromCentreAndSize(centre, size);
	}

	HandleBounds(): Bounds2D {
		return Bounds2D.CreateFromCentreAndSize(this.HandlePosition, this.GetHandleSize());
	}

	BoundsHeight(): number {
		return this.StateGridSize.y;
	}

	GetHandleSize(): Vector2 {
		return new Vector2(DevPinHandleWidth, this.BoundsHeight());
	}

	ToggleState(bitIndex: number) {
		this.Pin.PlayerInputState = PinState.Toggle(this.Pin.PlayerInputState, bitIndex);
	}

	PointIsInInteractionBounds(point: Vector2): boolean {
		return this.PointIsInHandleBounds(point) || this.PointIsInStateIndicatorBounds(point);
	}

	PointIsInStateIndicatorBounds(point: Vector2): boolean {
		return Maths.PointInCircle2D(point, this.StateDisplayPosition, DevPinStateDisplayRadius);
	}

	PointIsInHandleBounds(point: Vector2): boolean {
		return this.HandleBounds().PointInBounds(point);
	}
}

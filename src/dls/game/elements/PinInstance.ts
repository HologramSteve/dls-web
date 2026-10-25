// Port of DLS.Game.PinInstance
import { Vector2 } from "../../../seb/types/Vector2";
import { Color } from "../../../seb/types/Color";
import { PinAddress, PinBitCount, PinColour, PinDescription } from "../../description/Types";
import { PinState } from "../../simulation/PinState";
import { ActiveTheme, ChipOutlineWidth, GetStateColour, SubChipPinInset } from "../../graphics/DrawSettings";
import type { IInteractable, IMoveable } from "./Interfaces";
import type { DevPinInstance } from "./DevPinInstance";
import type { SubChipInstance } from "./SubChipInstance";

export class PinInstance implements IInteractable {
	readonly isInteractable = true as const;
	readonly Address: PinAddress;
	readonly bitCount: PinBitCount;
	readonly IsBusPin: boolean;
	readonly IsSourcePin: boolean;

	// Pin may be attached to a chip or a devPin as its parent
	readonly parent: IMoveable;
	State: number; // sim state
	PlayerInputState = 0; // dev input pins only
	Colour: PinColour;
	private faceRight: boolean;
	LocalPosY = 0;
	Name: string;

	constructor(desc: PinDescription, address: PinAddress, parent: IMoveable, isSourcePin: boolean, parentIsBus = false) {
		this.parent = parent;
		this.bitCount = desc.BitCount;
		this.Name = desc.Name;
		this.Address = address;
		this.IsSourcePin = isSourcePin;
		this.Colour = desc.Colour;
		this.IsBusPin = parentIsBus;
		this.faceRight = isSourcePin;
		this.State = PinState.AllDisconnected;
	}

	get ForwardDir(): Vector2 {
		return this.faceRight ? Vector2.right : Vector2.left;
	}

	GetWorldPos(): Vector2 {
		const p = this.parent as DevPinInstance | SubChipInstance;
		if (p.kind === "devpin") return p.PinPosition;
		const chipSize = p.Size;
		const chipPos = p.Position;
		const xLocal = (chipSize.x / 2 + ChipOutlineWidth / 2 - SubChipPinInset) * (this.faceRight ? 1 : -1);
		return new Vector2(chipPos.x + xLocal, chipPos.y + this.LocalPosY);
	}

	SetBusFlip(flipped: boolean) {
		this.faceRight = this.IsSourcePin !== flipped;
	}

	GetColLow(): Color {
		return ActiveTheme.StateLowCol[this.Colour];
	}

	GetColHigh(): Color {
		return ActiveTheme.StateHighCol[this.Colour];
	}

	GetStateCol(bitIndex: number, hover = false, canUsePlayerState = true): Color {
		// dev input pin uses player state (so it updates even when sim is paused)
		const pinState = this.IsSourcePin && canUsePlayerState ? this.PlayerInputState : this.State;
		const state = PinState.GetBitTristatedValue(pinState, bitIndex);
		if (state === PinState.LogicDisconnected) return ActiveTheme.StateDisconnectedCol;
		return GetStateColour(state === PinState.LogicHigh, this.Colour, hover);
	}
}

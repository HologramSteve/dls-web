// Port of DLS.SaveSystem.DescriptionCreator (WIP: chip/wire description creation is added with the game layer)
import { ChipType } from "../description/Types";
import { ChipTypeHelper } from "../description/ChipTypeHelper";

export function CreateDefaultInstanceData(type: ChipType): number[] | null {
	switch (type) {
		case ChipType.Rom_256x16:
			return new Array(256).fill(0); // ROM contents
		case ChipType.Key:
			return ["K".charCodeAt(0)]; // Key binding
		case ChipType.Pulse:
			return [50, 0, 0]; // Pulse width, ticks remaining, input state old
		case ChipType.DisplayLED:
			return [0]; // LED colour
		default:
			return ChipTypeHelper.IsBusType(type) ? [0, 0] : null;
	}
}

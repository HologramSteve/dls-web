// Port of DLS.Description.ChipTypeHelper
import { ChipType, PinBitCount } from "./Types";

const mulSymbol = "×";

const Names = new Map<ChipType, string>([
	// ---- Basic Chips ----
	[ChipType.Nand, "NAND"],
	[ChipType.Clock, "CLOCK"],
	[ChipType.Pulse, "PULSE"],
	[ChipType.TriStateBuffer, "3-STATE BUFFER"],
	// ---- Memory ----
	[ChipType.dev_Ram_8Bit, "dev.RAM-8"],
	[ChipType.Rom_256x16, `ROM 256${mulSymbol}16`],
	// ---- Split / Merge ----
	[ChipType.Split_4To1Bit, "4-1BIT"],
	[ChipType.Split_8To1Bit, "8-1BIT"],
	[ChipType.Split_8To4Bit, "8-4BIT"],
	[ChipType.Merge_4To8Bit, "4-8BIT"],
	[ChipType.Merge_1To8Bit, "1-8BIT"],
	[ChipType.Merge_1To4Bit, "1-4BIT"],
	// ---- Displays -----
	[ChipType.DisplayRGB, "RGB DISPLAY"],
	[ChipType.DisplayDot, "DOT DISPLAY"],
	[ChipType.SevenSegmentDisplay, "7-SEGMENT"],
	[ChipType.DisplayLED, "LED"],
	[ChipType.Buzzer, "BUZZER"],
	// ---- Inputs/Outputs ----
	[ChipType.In_1Bit, "IN-1"],
	[ChipType.In_4Bit, "IN-4"],
	[ChipType.In_8Bit, "IN-8"],
	[ChipType.Out_1Bit, "OUT-1"],
	[ChipType.Out_4Bit, "OUT-4"],
	[ChipType.Out_8Bit, "OUT-8"],
	[ChipType.Key, "KEY"],
	// ---- Buses ----
	[ChipType.Bus_1Bit, "BUS-1"],
	[ChipType.Bus_4Bit, "BUS-4"],
	[ChipType.Bus_8Bit, "BUS-8"],
	[ChipType.BusTerminus_1Bit, "BUS-TERMINUS-1"],
	[ChipType.BusTerminus_4Bit, "BUS-TERMINUS-4"],
	[ChipType.BusTerminus_8Bit, "BUS-TERMINUS-8"],
]);

export const ChipTypeHelper = {
	GetName(type: ChipType): string {
		const n = Names.get(type);
		if (n === undefined) throw new Error("No name for chip type " + type);
		return n;
	},

	IsBusType(type: ChipType): boolean {
		return ChipTypeHelper.IsBusOriginType(type) || ChipTypeHelper.IsBusTerminusType(type);
	},

	IsBusOriginType(type: ChipType): boolean {
		return type === ChipType.Bus_1Bit || type === ChipType.Bus_4Bit || type === ChipType.Bus_8Bit;
	},

	IsBusTerminusType(type: ChipType): boolean {
		return type === ChipType.BusTerminus_1Bit || type === ChipType.BusTerminus_4Bit || type === ChipType.BusTerminus_8Bit;
	},

	IsRomType(type: ChipType): boolean {
		return type === ChipType.Rom_256x16;
	},

	GetCorrespondingBusTerminusType(type: ChipType): ChipType {
		switch (type) {
			case ChipType.Bus_1Bit:
				return ChipType.BusTerminus_1Bit;
			case ChipType.Bus_4Bit:
				return ChipType.BusTerminus_4Bit;
			case ChipType.Bus_8Bit:
				return ChipType.BusTerminus_8Bit;
		}
		throw new Error("No corresponding bus terminus found for type: " + type);
	},

	GetPinType(isInput: boolean, numBits: PinBitCount): ChipType {
		if (isInput) {
			if (numBits === PinBitCount.Bit1) return ChipType.In_1Bit;
			if (numBits === PinBitCount.Bit4) return ChipType.In_4Bit;
			if (numBits === PinBitCount.Bit8) return ChipType.In_8Bit;
			throw new Error("No input pin type found for bitcount: " + numBits);
		}
		if (numBits === PinBitCount.Bit1) return ChipType.Out_1Bit;
		if (numBits === PinBitCount.Bit4) return ChipType.Out_4Bit;
		if (numBits === PinBitCount.Bit8) return ChipType.Out_8Bit;
		throw new Error("No output pin type found for bitcount: " + numBits);
	},

	// Returns [isInput, isOutput, numBits]
	IsInputOrOutputPin(type: ChipType): [boolean, boolean, PinBitCount] {
		switch (type) {
			case ChipType.In_1Bit:
				return [true, false, PinBitCount.Bit1];
			case ChipType.Out_1Bit:
				return [false, true, PinBitCount.Bit1];
			case ChipType.In_4Bit:
				return [true, false, PinBitCount.Bit4];
			case ChipType.Out_4Bit:
				return [false, true, PinBitCount.Bit4];
			case ChipType.In_8Bit:
				return [true, false, PinBitCount.Bit8];
			case ChipType.Out_8Bit:
				return [false, true, PinBitCount.Bit8];
			default:
				return [false, false, PinBitCount.Bit1];
		}
	},
};

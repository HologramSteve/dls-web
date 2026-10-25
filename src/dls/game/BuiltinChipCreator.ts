// Port of DLS.Game.BuiltinChipCreator and BuiltinCollectionCreator
import { Vector2 } from "../../seb/types/Vector2";
import { Color } from "../../seb/types/Color";
import { ChipCollection, ChipDescription, ChipType, DisplayDescription, NameDisplayLocation, PinBitCount, PinColour, PinDescription, PinValueDisplayMode, StarredItem } from "../description/Types";
import { ChipTypeHelper } from "../description/ChipTypeHelper";
import { ChipOutlineWidth, GridSize, SubChipPinInset } from "../graphics/DrawSettings";
import { GridHelper } from "./GridHelper";
import { MinChipHeightForPins } from "./PinLayout";

const ChipCol_SplitMerge = new Color(0.1, 0.1, 0.1);

export function CreateAllBuiltinChipDescriptions(): ChipDescription[] {
	return [
		// ---- I/O Pins ----
		CreateInputOrOutputPin(ChipType.In_1Bit),
		CreateInputOrOutputPin(ChipType.Out_1Bit),
		CreateInputOrOutputPin(ChipType.In_4Bit),
		CreateInputOrOutputPin(ChipType.Out_4Bit),
		CreateInputOrOutputPin(ChipType.In_8Bit),
		CreateInputOrOutputPin(ChipType.Out_8Bit),
		CreateInputKeyChip(),
		// ---- Basic Chips ----
		CreateNand(),
		CreateTristateBuffer(),
		CreateClock(),
		CreatePulse(),
		// ---- Memory ----
		dev_CreateRAM_8(),
		CreateROM_8(),
		// ---- Merge / Split ----
		CreateBitConversionChip(ChipType.Split_4To1Bit, PinBitCount.Bit4, PinBitCount.Bit1, 1, 4),
		CreateBitConversionChip(ChipType.Split_8To4Bit, PinBitCount.Bit8, PinBitCount.Bit4, 1, 2),
		CreateBitConversionChip(ChipType.Split_8To1Bit, PinBitCount.Bit8, PinBitCount.Bit1, 1, 8),
		CreateBitConversionChip(ChipType.Merge_1To8Bit, PinBitCount.Bit1, PinBitCount.Bit8, 8, 1),
		CreateBitConversionChip(ChipType.Merge_1To4Bit, PinBitCount.Bit1, PinBitCount.Bit4, 4, 1),
		CreateBitConversionChip(ChipType.Merge_4To8Bit, PinBitCount.Bit4, PinBitCount.Bit8, 2, 1),
		// ---- Displays ----
		CreateDisplay7Seg(),
		CreateDisplayRGB(),
		CreateDisplayDot(),
		CreateDisplayLED(),
		// ---- Bus ----
		CreateBus(PinBitCount.Bit1),
		CreateBusTerminus(PinBitCount.Bit1),
		CreateBus(PinBitCount.Bit4),
		CreateBusTerminus(PinBitCount.Bit4),
		CreateBus(PinBitCount.Bit8),
		CreateBusTerminus(PinBitCount.Bit8),
		// ---- Audio ----
		CreateBuzzer(),
	];
}

function CreateNand(): ChipDescription {
	const col = new Color(0.73, 0.26, 0.26);
	const size = new Vector2(CalculateGridSnappedWidth(GridSize * 8), GridSize * 4);
	const inputPins = [CreatePinDescription("IN B", 0), CreatePinDescription("IN A", 1)];
	const outputPins = [CreatePinDescription("OUT", 2)];
	return CreateBuiltinChipDescription(ChipType.Nand, size, col, inputPins, outputPins);
}

function CreateBuzzer(): ChipDescription {
	const col = new Color(0, 0, 0);
	const inputPins = [CreatePinDescription("PITCH", 1, PinBitCount.Bit8), CreatePinDescription("VOLUME", 0, PinBitCount.Bit4)];
	const height = MinChipHeightForPins(inputPins, null);
	const size = new Vector2(CalculateGridSnappedWidth(GridSize * 9), height);
	return CreateBuiltinChipDescription(ChipType.Buzzer, size, col, inputPins, null, null);
}

function dev_CreateRAM_8(): ChipDescription {
	const col = new Color(0.85, 0.45, 0.3);
	const inputPins = [CreatePinDescription("ADDRESS", 0, PinBitCount.Bit8), CreatePinDescription("DATA", 1, PinBitCount.Bit8), CreatePinDescription("WRITE", 2), CreatePinDescription("RESET", 3), CreatePinDescription("CLOCK", 4)];
	const outputPins = [CreatePinDescription("OUT", 5, PinBitCount.Bit8)];
	const size = new Vector2(GridSize * 10, MinChipHeightForPins(inputPins, outputPins));
	return CreateBuiltinChipDescription(ChipType.dev_Ram_8Bit, size, col, inputPins, outputPins);
}

function CreateROM_8(): ChipDescription {
	const inputPins = [CreatePinDescription("ADDRESS", 0, PinBitCount.Bit8)];
	const outputPins = [CreatePinDescription("OUT B", 1, PinBitCount.Bit8), CreatePinDescription("OUT A", 2, PinBitCount.Bit8)];
	const col = new Color(0.25, 0.35, 0.5);
	const size = new Vector2(GridSize * 12, MinChipHeightForPins(inputPins, outputPins));
	return CreateBuiltinChipDescription(ChipType.Rom_256x16, size, col, inputPins, outputPins);
}

function CreateInputKeyChip(): ChipDescription {
	const col = new Color(0.1, 0.1, 0.1);
	const size = new Vector2(GridSize, GridSize).mul(3);
	const outputPins = [CreatePinDescription("OUT", 0)];
	return CreateBuiltinChipDescription(ChipType.Key, size, col, null, outputPins, null, NameDisplayLocation.Hidden);
}

function CreateTristateBuffer(): ChipDescription {
	const col = new Color(0.1, 0.1, 0.1);
	const size = new Vector2(CalculateGridSnappedWidth(1.5), GridSize * 5);
	const inputPins = [CreatePinDescription("IN", 0), CreatePinDescription("ENABLE", 1)];
	const outputPins = [CreatePinDescription("OUT", 2)];
	return CreateBuiltinChipDescription(ChipType.TriStateBuffer, size, col, inputPins, outputPins);
}

function CreateClock(): ChipDescription {
	const size = new Vector2(GridHelper.SnapToGrid(1), GridSize * 3);
	const col = new Color(0.1, 0.1, 0.1);
	const outputPins = [CreatePinDescription("CLK", 0)];
	return CreateBuiltinChipDescription(ChipType.Clock, size, col, null, outputPins);
}

function CreatePulse(): ChipDescription {
	const size = new Vector2(GridHelper.SnapToGrid(1), GridSize * 3);
	const col = new Color(0.1, 0.1, 0.1);
	const inputPins = [CreatePinDescription("IN", 0)];
	const outputPins = [CreatePinDescription("PULSE", 1)];
	return CreateBuiltinChipDescription(ChipType.Pulse, size, col, inputPins, outputPins);
}

function CreateBitConversionChip(chipType: ChipType, bitCountIn: PinBitCount, bitCountOut: PinBitCount, numIn: number, numOut: number): ChipDescription {
	const inputPins: PinDescription[] = [];
	const outputPins: PinDescription[] = [];
	for (let i = 0; i < numIn; i++) inputPins.push(CreatePinDescription(GetPinName(i, numIn, true), i, bitCountIn));
	for (let i = 0; i < numOut; i++) outputPins.push(CreatePinDescription(GetPinName(i, numOut, false), numIn + i, bitCountOut));
	const height = MinChipHeightForPins(inputPins, outputPins);
	const size = new Vector2(GridSize * 9, height);
	return CreateBuiltinChipDescription(chipType, size, ChipCol_SplitMerge, inputPins, outputPins);
}

function GetPinName(pinIndex: number, pinCount: number, isInput: boolean): string {
	let letter = " " + String.fromCharCode("A".charCodeAt(0) + pinCount - pinIndex - 1);
	if (pinCount === 1) letter = "";
	return (isInput ? "IN" : "OUT") + letter;
}

function BuiltinDisplay(scale: number): DisplayDescription[] {
	return [{ Position: Vector2.zero, Scale: scale, SubChipID: -1 }];
}

function CreateDisplay7Seg(): ChipDescription {
	const inputPins = ["A", "B", "C", "D", "E", "F", "G", "COL"].map((n, i) => CreatePinDescription(n, i));
	const col = new Color(0.1, 0.1, 0.1);
	const height = MinChipHeightForPins(inputPins, null);
	const size = new Vector2(GridSize * 10, height);
	const displayWidth = size.x - GridSize * 2;
	return CreateBuiltinChipDescription(ChipType.SevenSegmentDisplay, size, col, inputPins, null, BuiltinDisplay(displayWidth), NameDisplayLocation.Hidden);
}

function CreateDisplayRGB(): ChipDescription {
	const height = GridSize * 21;
	const width = height;
	const displayWidth = height - GridSize * 2;
	const col = new Color(0.1, 0.1, 0.1);
	const size = new Vector2(width, height);
	const inputPins = [
		CreatePinDescription("ADDRESS", 0, PinBitCount.Bit8),
		CreatePinDescription("RED", 1, PinBitCount.Bit4),
		CreatePinDescription("GREEN", 2, PinBitCount.Bit4),
		CreatePinDescription("BLUE", 3, PinBitCount.Bit4),
		CreatePinDescription("RESET", 4),
		CreatePinDescription("WRITE", 5),
		CreatePinDescription("REFRESH", 6),
		CreatePinDescription("CLOCK", 7),
	];
	const outputPins = [CreatePinDescription("R OUT", 8, PinBitCount.Bit4), CreatePinDescription("G OUT", 9, PinBitCount.Bit4), CreatePinDescription("B OUT", 10, PinBitCount.Bit4)];
	return CreateBuiltinChipDescription(ChipType.DisplayRGB, size, col, inputPins, outputPins, BuiltinDisplay(displayWidth), NameDisplayLocation.Hidden);
}

function CreateDisplayDot(): ChipDescription {
	const inputPins = [
		CreatePinDescription("ADDRESS", 0, PinBitCount.Bit8),
		CreatePinDescription("PIXEL IN", 1),
		CreatePinDescription("RESET", 2),
		CreatePinDescription("WRITE", 3),
		CreatePinDescription("REFRESH", 4),
		CreatePinDescription("CLOCK", 5),
	];
	const outputPins = [CreatePinDescription("PIXEL OUT", 6)];
	const height = MinChipHeightForPins(inputPins, null);
	const width = height;
	const displayWidth = height - GridSize * 2;
	const col = new Color(0.1, 0.1, 0.1);
	const size = new Vector2(width, height);
	return CreateBuiltinChipDescription(ChipType.DisplayDot, size, col, inputPins, outputPins, BuiltinDisplay(displayWidth), NameDisplayLocation.Hidden);
}

// (Not a chip, but convenient to treat it as one)
export function CreateInputOrOutputPin(type: ChipType): ChipDescription {
	const [isInput, isOutput, numBits] = ChipTypeHelper.IsInputOrOutputPin(type);
	const name = isInput ? "IN" : "OUT";
	const pin = [CreatePinDescription(name, 0, numBits)];
	return CreateBuiltinChipDescription(type, Vector2.zero, Color.clear, isInput ? pin : null, isOutput ? pin : null);
}

function BusChipSize(bitCount: PinBitCount): Vector2 {
	switch (bitCount) {
		case PinBitCount.Bit1:
			return new Vector2(GridSize * 2, GridSize * 2);
		case PinBitCount.Bit4:
			return new Vector2(GridSize * 2, GridSize * 3);
		case PinBitCount.Bit8:
			return new Vector2(GridSize * 2, GridSize * 4);
	}
	throw new Error("Bus bit count not implemented");
}

function CreateBus(bitCount: PinBitCount): ChipDescription {
	const type = bitCount === PinBitCount.Bit1 ? ChipType.Bus_1Bit : bitCount === PinBitCount.Bit4 ? ChipType.Bus_4Bit : ChipType.Bus_8Bit;
	const name = ChipTypeHelper.GetName(type);
	const inputs = [CreatePinDescription(name + " (Hidden)", 0, bitCount)];
	const outputs = [CreatePinDescription(name, 1, bitCount)];
	const col = new Color(0.1, 0.1, 0.1);
	return CreateBuiltinChipDescription(type, BusChipSize(bitCount), col, inputs, outputs, null, NameDisplayLocation.Hidden);
}

function CreateDisplayLED(): ChipDescription {
	const inputPins = [CreatePinDescription("IN", 0)];
	const height = MinChipHeightForPins(inputPins, null);
	const width = height;
	const displayWidth = height - GridSize * 0.5;
	const col = new Color(0.1, 0.1, 0.1);
	const size = new Vector2(width, height);
	return CreateBuiltinChipDescription(ChipType.DisplayLED, size, col, inputPins, null, BuiltinDisplay(displayWidth), NameDisplayLocation.Hidden);
}

function CreateBusTerminus(bitCount: PinBitCount): ChipDescription {
	const type = bitCount === PinBitCount.Bit1 ? ChipType.BusTerminus_1Bit : bitCount === PinBitCount.Bit4 ? ChipType.BusTerminus_4Bit : ChipType.BusTerminus_8Bit;
	const busOrigin = CreateBus(bitCount);
	const inputs = [CreatePinDescription(busOrigin.Name, 0, bitCount)];
	return CreateBuiltinChipDescription(type, BusChipSize(bitCount), busOrigin.Colour, inputs, null, null, NameDisplayLocation.Hidden);
}

function CreateBuiltinChipDescription(type: ChipType, size: Vector2, col: Color, inputs: PinDescription[] | null, outputs: PinDescription[] | null, displays: DisplayDescription[] | null = null, nameLoc = NameDisplayLocation.Centre): ChipDescription {
	const name = ChipTypeHelper.GetName(type);
	ValidatePinIDs(inputs, outputs, name);
	return {
		Name: name,
		NameLocation: nameLoc,
		Colour: col,
		Size: new Vector2(size.x, size.y),
		InputPins: inputs ?? [],
		OutputPins: outputs ?? [],
		SubChips: [],
		Wires: [],
		Displays: displays,
		ChipType: type,
	};
}

function CreatePinDescription(name: string, id: number, bitCount = PinBitCount.Bit1): PinDescription {
	return PinDescription(name, id, Vector2.zero, bitCount, PinColour.Red, PinValueDisplayMode.Off);
}

// Calculate width such that spacing between an input and output pin on chip will align with grid
function CalculateGridSnappedWidth(desiredWidth: number): number {
	return GridHelper.SnapToGridForceEven(desiredWidth) - (ChipOutlineWidth - 2 * SubChipPinInset);
}

function ValidatePinIDs(inputs: PinDescription[] | null, outputs: PinDescription[] | null, chipName: string) {
	const ids = new Set<number>();
	for (const pins of [inputs, outputs]) {
		if (!pins) continue;
		for (const pin of pins) {
			if (ids.has(pin.ID)) throw new Error(`Pin has duplicate ID (${pin.ID}) in builtin chip: ${chipName}`);
			ids.add(pin.ID);
		}
	}
}

// ---- BuiltinCollectionCreator ----
export function GetDefaultStarredList(): StarredItem[] {
	return [StarredItem("IN/OUT", true), StarredItem(ChipTypeHelper.GetName(ChipType.Nand), false)];
}

export function CreateDefaultChipCollections(): ChipCollection[] {
	const make = (name: string, ...types: ChipType[]) => new ChipCollection(name, types.map((t) => ChipTypeHelper.GetName(t)));
	return [
		make("BASIC", ChipType.Nand, ChipType.Clock, ChipType.Pulse, ChipType.Key, ChipType.TriStateBuffer),
		make("IN/OUT", ChipType.In_1Bit, ChipType.In_4Bit, ChipType.In_8Bit, ChipType.Out_1Bit, ChipType.Out_4Bit, ChipType.Out_8Bit),
		make("MERGE/SPLIT", ChipType.Merge_1To4Bit, ChipType.Merge_1To8Bit, ChipType.Merge_4To8Bit, ChipType.Split_4To1Bit, ChipType.Split_8To4Bit, ChipType.Split_8To1Bit),
		make("BUS", ChipType.Bus_1Bit, ChipType.Bus_4Bit, ChipType.Bus_8Bit),
		make("DISPLAY", ChipType.SevenSegmentDisplay, ChipType.DisplayDot, ChipType.DisplayRGB, ChipType.DisplayLED),
		make("MEMORY", ChipType.Rom_256x16),
	];
}

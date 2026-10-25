// Port of DLS.Description types (ChipDescription, PinDescription, SubChipDescription, WireDescription, ...)
// These are plain data objects (C# structs/classes serialized to JSON). Positions are Vector2 instances and
// colours are Color instances in memory; Serializer converts to/from the JSON representation.
import { Vector2 } from "../../seb/types/Vector2";
import { Color } from "../../seb/types/Color";

export enum ChipType {
	Custom,

	// ---- Basic Chips ----
	Nand,
	TriStateBuffer,
	Clock,
	Pulse,

	// ---- Memory ----
	dev_Ram_8Bit,
	Rom_256x16,

	// ---- Displays ----
	SevenSegmentDisplay,
	DisplayRGB,
	DisplayDot,
	DisplayLED,

	// ---- Merge / Split ----
	Merge_1To4Bit,
	Merge_1To8Bit,
	Merge_4To8Bit,
	Split_4To1Bit,
	Split_8To4Bit,
	Split_8To1Bit,

	// ---- In / Out Pins ----
	In_1Bit,
	In_4Bit,
	In_8Bit,
	Out_1Bit,
	Out_4Bit,
	Out_8Bit,

	Key,

	// ---- Buses ----
	Bus_1Bit,
	BusTerminus_1Bit,
	Bus_4Bit,
	BusTerminus_4Bit,
	Bus_8Bit,
	BusTerminus_8Bit,

	// ---- Audio ----
	Buzzer,
}

export enum NameDisplayLocation {
	Centre,
	Top,
	Hidden,
}

export enum PinBitCount {
	Bit1 = 1,
	Bit4 = 4,
	Bit8 = 8,
}

export enum PinColour {
	Red,
	Orange,
	Yellow,
	Green,
	Blue,
	Violet,
	Pink,
	White,
}

export enum PinValueDisplayMode {
	Off,
	UnsignedDecimal,
	SignedDecimal,
	HEX,
}

export enum WireConnectionType {
	ToPins, // both ends of wire connect directly to a pin
	ToWireSource, // source end of wire connects to another wire (target connects to pin)
	ToWireTarget, // target end of wire connects to another wire (source connects to pin)
}

export interface PinAddress {
	PinID: number; // ID for this pin (unique within its owner, but not globally unique)
	PinOwnerID: number; // ID of the devpin or subchip to which this pin belongs (unique within its parent)
}

export function PinAddress(pinOwnerID: number, pinID: number): PinAddress {
	return { PinID: pinID, PinOwnerID: pinOwnerID };
}

export function PinAddressEquals(a: PinAddress, b: PinAddress): boolean {
	return a.PinID === b.PinID && a.PinOwnerID === b.PinOwnerID;
}

export interface PinDescription {
	Name: string;
	ID: number;
	Position: Vector2;
	BitCount: PinBitCount;
	Colour: PinColour;
	ValueDisplayMode: PinValueDisplayMode;
}

export function PinDescription(name: string, id: number, position: Vector2, bitCount: PinBitCount, colour: PinColour, valueDisplayMode: PinValueDisplayMode): PinDescription {
	return { Name: name, ID: id, Position: position, BitCount: bitCount, Colour: colour, ValueDisplayMode: valueDisplayMode };
}

export function clonePinDescription(p: PinDescription): PinDescription {
	return { ...p };
}

export interface OutputPinColourInfo {
	PinColour: PinColour;
	PinID: number;
}

export interface SubChipDescription {
	Name: string;
	ID: number; // Unique within parent chip. ID > 0
	Label: string;
	Position: Vector2;
	OutputPinColourInfo: OutputPinColourInfo[] | null;
	// Arbitrary data for specific chip types:
	// ROM: stores memory contents
	// BUS: stores id of linked bus pair (origin/terminus), and horizontal flip value (0 = no, 1 = yes)
	// KEY: stores bound key code
	// PULSE: pulse width, ticks remaining, input state old
	// LED: colour index
	// Otherwise is null
	InternalData: number[] | null;
}

export function SubChipDescription(name: string, id: number, label: string, position: Vector2, outputPinColInfo: OutputPinColourInfo[] | null, internalData: number[] | null = null): SubChipDescription {
	return { Name: name, ID: id, Label: label, Position: position, OutputPinColourInfo: outputPinColInfo, InternalData: internalData };
}

export function cloneSubChipDescription(s: SubChipDescription): SubChipDescription {
	return {
		...s,
		OutputPinColourInfo: s.OutputPinColourInfo ? s.OutputPinColourInfo.map((c) => ({ ...c })) : null,
		InternalData: s.InternalData ? s.InternalData.slice() : null,
	};
}

export interface WireDescription {
	SourcePinAddress: PinAddress;
	TargetPinAddress: PinAddress;
	ConnectionType: WireConnectionType;
	ConnectedWireIndex: number;
	ConnectedWireSegmentIndex: number;
	Points: Vector2[];
}

export interface DisplayDescription {
	// ID of the subchip that is to be displayed on the case of this chip (note: if -1, then this is a builtin chip display)
	SubChipID: number;
	Position: Vector2;
	Scale: number;
}

export interface ChipDescription {
	DLSVersion?: string;
	Name: string;
	NameLocation: NameDisplayLocation;
	ChipType: ChipType;
	Size: Vector2;
	Colour: Color;
	InputPins: PinDescription[];
	OutputPins: PinDescription[];
	SubChips: SubChipDescription[];
	Wires: WireDescription[];
	Displays: DisplayDescription[] | null;
}

export function HasDisplay(desc: ChipDescription): boolean {
	return desc.Displays != null && desc.Displays.length > 0;
}

// Chip names are compared case-insensitively (StringComparison.OrdinalIgnoreCase)
export function NameMatch(a: string, b: string): boolean {
	return a === b || a.toUpperCase() === b.toUpperCase();
}

export function NameKey(name: string): string {
	return name.toUpperCase();
}

// Case-insensitive name set (HashSet<string>(ChipDescription.NameComparer))
export class NameSet {
	private readonly set = new Set<string>();
	add(name: string): boolean {
		const k = NameKey(name);
		if (this.set.has(k)) return false;
		this.set.add(k);
		return true;
	}
	has(name: string): boolean {
		return this.set.has(NameKey(name));
	}
	clear() {
		this.set.clear();
	}
	get size() {
		return this.set.size;
	}
}

// ---- Project description ----
export interface StarredItem {
	Name: string;
	IsCollection: boolean;
}

export function StarredItem(name: string, isCollection: boolean): StarredItem {
	return { Name: name, IsCollection: isCollection };
}

export function GetStarredDisplayStringForBottomBar(item: StarredItem, open: boolean): string {
	if (item.IsCollection) return (open ? "▴<halfSpace>" : "▸<halfSpace>") + item.Name;
	return item.Name;
}

export class ChipCollection {
	readonly Chips: string[];
	IsToggledOpen = false;
	Name: string;

	constructor(name: string, chips: string[]) {
		this.Name = name;
		this.Chips = chips.slice();
	}

	// (display strings are derived from Name on demand, so nothing to cache)
	UpdateDisplayStrings() {}

	GetDisplayString(): string {
		if (this.Chips.length === 0) return "◌ " + this.Name;
		return this.IsToggledOpen ? "▼ " + this.Name : "▶ " + this.Name;
	}

	toJSON() {
		return { Chips: this.Chips, IsToggledOpen: this.IsToggledOpen, Name: this.Name };
	}
}

export interface ProjectDescription {
	ProjectName: string;
	DLSVersion_LastSaved: string;
	DLSVersion_EarliestCompatible: string;
	CreationTime: string; // ISO 8601 ("yyyy-MM-ddTHH:mm:ss.fffK")
	LastSaveTime: string;

	// Prefs
	Prefs_MainPinNamesDisplayMode: number;
	Prefs_ChipPinNamesDisplayMode: number;
	Prefs_GridDisplayMode: number;
	Prefs_Snapping: number;
	Prefs_StraightWires: number;
	Prefs_SimPaused: boolean;
	Prefs_SimTargetStepsPerSecond: number;
	Prefs_SimStepsPerClockTick: number;

	// List of all player-created chips (in order of creation -- oldest first)
	AllCustomChipNames: string[];
	StarredList: StarredItem[];
	ChipCollections: ChipCollection[];
}

export function IsStarred(desc: ProjectDescription, chipName: string, isCollection: boolean): boolean {
	for (const item of desc.StarredList) {
		if (item.IsCollection === isCollection && NameMatch(chipName, item.Name)) return true;
	}
	return false;
}

// C# ProjectDescription is a struct: copying it copies the top-level fields (lists are shared references)
export function copyProjectDescription(d: ProjectDescription): ProjectDescription {
	return { ...d };
}

export interface AppSettings {
	ResolutionX: number;
	ResolutionY: number;
	fullscreenMode: number;
	VSyncEnabled: boolean;
}

export function DefaultAppSettings(): AppSettings {
	return { ResolutionX: 1920, ResolutionY: 1080, fullscreenMode: 0, VSyncEnabled: true };
}

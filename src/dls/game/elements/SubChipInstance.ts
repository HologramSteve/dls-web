// Port of DLS.Game.SubChipInstance and DisplayInstance
import { Vector2 } from "../../../seb/types/Vector2";
import { Bounds2D } from "../../../seb/types/Bounds2D";
import { Maths } from "../../../seb/helpers/Maths";
import { Draw } from "../../../seb/vis/Draw";
import { ChipDescription, ChipType, DisplayDescription, OutputPinColourInfo, PinAddress, PinBitCount, PinDescription, SubChipDescription, HasDisplay } from "../../description/Types";
import { ChipTypeHelper } from "../../description/ChipTypeHelper";
import { ChipNameLineSpacing, ChipOutlineWidth, FontBold, FontSizeChipName, GridSize, PinHeight4Bit, PinHeight8Bit, PinRadius, SelectionBoundsPadding } from "../../graphics/DrawSettings";
import { CreateDefaultInstanceData } from "../../saveSystem/DescriptionCreator";
import { CalculateDefaultPinLayout, MinChipHeightForPins } from "../PinLayout";
import { Project } from "../Project";
import type { IMoveable } from "./Interfaces";
import { PinInstance } from "./PinInstance";

export class DisplayInstance {
	ChildDisplays: DisplayInstance[] = [];
	Desc!: DisplayDescription;
	DisplayType: ChipType = ChipType.Custom;
	LastDrawBounds = Bounds2D.zero;
}

export class SubChipInstance implements IMoveable {
	readonly kind = "subchip" as const;
	readonly isInteractable = true as const;
	readonly isMoveable = true as const;

	readonly AllPins: PinInstance[];
	readonly ChipType: ChipType;
	readonly Description: ChipDescription;
	readonly Displays: DisplayInstance[];
	readonly InitialSubChipDesc: SubChipDescription;
	readonly InputPins: PinInstance[];
	readonly InternalData: number[];
	readonly IsBus: boolean;
	readonly MinSize: Vector2;
	readonly MultiLineName: string;
	readonly OutputPins: PinInstance[];
	activationKeyString = ""; // input char for the 'key chip' type
	Label: string;

	Position: Vector2;
	MoveStartPosition = Vector2.zero;
	StraightLineReferencePoint = Vector2.zero;
	readonly ID: number;
	IsSelected = false;
	HasReferencePointForStraightLineMovement = false;
	IsValidMovePos = false;

	constructor(description: ChipDescription, subChipDesc: SubChipDescription) {
		this.InitialSubChipDesc = subChipDesc;
		this.ChipType = description.ChipType;
		this.Description = description;
		this.Position = subChipDesc.Position;
		this.ID = subChipDesc.ID;
		this.Label = subChipDesc.Label;
		this.IsBus = ChipTypeHelper.IsBusType(this.ChipType);
		this.MultiLineName = CreateMultiLineName(description.Name);
		this.MinSize = SubChipInstance.CalculateMinChipSize(description.InputPins, description.OutputPins, description.Name);

		const createPinInstances = (pinDescriptions: PinDescription[], isInputPin: boolean): PinInstance[] => {
			const pins = pinDescriptions.map((desc) => new PinInstance(desc, PinAddress(subChipDesc.ID, desc.ID), this, !isInputPin, this.IsBus));
			this.CalculatePinLayout(pins);
			return pins;
		};

		this.InputPins = createPinInstances(description.InputPins, true);
		this.OutputPins = createPinInstances(description.OutputPins, false);
		this.AllPins = [...this.InputPins, ...this.OutputPins];
		this.LoadOutputPinColours(subChipDesc.OutputPinColourInfo);

		// Displays
		this.Displays = CreateDisplayInstances(description);

		// Load internal data (or create default in case missing)
		if (subChipDesc.InternalData == null || subChipDesc.InternalData.length === 0) {
			this.InternalData = CreateDefaultInstanceData(description.ChipType) ?? [];
		} else {
			this.InternalData = subChipDesc.InternalData.slice();
			if (this.ChipType === ChipType.Key) {
				this.SetKeyChipActivationChar(String.fromCharCode(subChipDesc.InternalData[0]));
			}
			if (this.IsBus && this.InternalData.length > 1) {
				for (const pin of this.AllPins) pin.SetBusFlip(this.BusIsFlipped);
			}
		}
		if (this.ChipType === ChipType.Key && !this.activationKeyString && this.InternalData.length > 0) {
			this.activationKeyString = String.fromCharCode(this.InternalData[0]);
		}
	}

	get LinkedBusPairID(): number {
		return this.IsBus ? this.InternalData[0] : -1;
	}

	get BusIsFlipped(): boolean {
		return this.IsBus && this.InternalData.length > 1 && this.InternalData[1] === 1;
	}

	get Size(): Vector2 {
		return this.Description.Size;
	}

	get BoundingBox(): Bounds2D {
		return this.CreateBoundingBox(0);
	}

	get SelectionBoundingBox(): Bounds2D {
		return this.CreateBoundingBox(SelectionBoundsPadding);
	}

	get SnapPoint(): Vector2 {
		if (this.InputPins.length !== 0) return this.InputPins[0].GetWorldPos();
		if (this.OutputPins.length !== 0) return this.OutputPins[0].GetWorldPos();
		return this.Position;
	}

	ShouldBeIncludedInSelectionBox(selectionCentre: Vector2, selectionSize: Vector2): boolean {
		return Maths.PointInBox2D(this.Position, selectionCentre, selectionSize);
	}

	SetLinkedBusPair(busPair: SubChipInstance) {
		if (!this.IsBus) throw new Error("Can't link bus to non-bus chip");
		this.InternalData[0] = busPair.ID;
	}

	SetKeyChipActivationChar(c: string) {
		if (this.ChipType !== ChipType.Key) throw new Error("Expected KeyChip type, but instead got: " + this.ChipType);
		this.activationKeyString = c;
		this.InternalData[0] = c.charCodeAt(0);
	}

	UpdatePinLayout() {
		this.CalculatePinLayout(this.InputPins);
		this.CalculatePinLayout(this.OutputPins);
	}

	private CalculatePinLayout(pins: PinInstance[]) {
		// If only one pin, it should be placed in the centre
		if (pins.length === 1) {
			pins[0].LocalPosY = 0;
			return;
		}

		const chipTop = this.Size.y / 2;
		const startY = chipTop;
		const [chipHeight, pinGridY] = CalculateDefaultPinLayout(pins.map((p) => p.bitCount));

		// ---- First pass: layout pins without any spacing between them ----
		for (let i = 0; i < pins.length; i++) {
			pins[i].LocalPosY = startY + pinGridY[i] * GridSize;
		}

		// ---- Second pass: evenly distribute the remaining space between the pins ----
		const spaceRemaining = this.Size.y - chipHeight;
		if (spaceRemaining > 0) {
			const spacingBetweenPins = spaceRemaining / (pins.length - 1);
			for (let i = 1; i < pins.length; i++) pins[i].LocalPosY -= spacingBetweenPins * i;
		}
	}

	static MinChipHeightForPins = MinChipHeightForPins;
	static CalculateDefaultPinLayout = CalculateDefaultPinLayout;

	private CreateBoundingBox(pad: number): Bounds2D {
		let pinWidthPad = 0;
		let offsetX = 0;
		const inputsHidden = ChipTypeHelper.IsBusOriginType(this.ChipType);
		const flipX = this.BusIsFlipped ? -1 : 1;

		if (this.InputPins.length > 0 && !inputsHidden) {
			pinWidthPad += PinRadius;
			offsetX -= (PinRadius / 2) * flipX;
		}
		if (this.OutputPins.length > 0) {
			pinWidthPad += PinRadius;
			offsetX += (PinRadius / 2) * flipX;
		}

		const padFinal = new Vector2(pinWidthPad + ChipOutlineWidth + pad, ChipOutlineWidth + pad);
		return Bounds2D.CreateFromCentreAndSize(this.Position.add(Vector2.right.mul(offsetX)), this.Size.add(padFinal));
	}

	static CalculateMinChipSize(inputPins: PinDescription[], outputPins: PinDescription[], unformattedName: string): Vector2 {
		const minHeightForPins = MinChipHeightForPins(inputPins, outputPins);
		const multiLineName = CreateMultiLineName(unformattedName);
		const hasMultiLineName = multiLineName !== unformattedName;
		const minNameHeight = GridSize * (hasMultiLineName ? 4 : 3);

		// (DevSceneDrawer.CalculateChipNameBounds)
		const nameDrawBoundsSize = Draw.CalculateTextBoundsSize(multiLineName, FontSizeChipName, FontBold, ChipNameLineSpacing);

		const sizeX = Math.max(nameDrawBoundsSize.x + GridSize, PinRadius * 4);
		const sizeY = Math.max(minNameHeight, minHeightForPins);
		return new Vector2(sizeX, sizeY);
	}

	static PinHeightFromBitCount(bitCount: PinBitCount): number {
		switch (bitCount) {
			case PinBitCount.Bit1:
				return PinRadius * 2;
			case PinBitCount.Bit4:
				return PinHeight4Bit;
			case PinBitCount.Bit8:
				return PinHeight8Bit;
		}
		throw new Error("Bit count not implemented " + bitCount);
	}

	FlipBus() {
		if (!this.IsBus) throw new Error("Can't flip non-bus type");
		const isFlipped = !this.BusIsFlipped;
		this.InternalData[1] = isFlipped ? 1 : 0;
		for (const pin of this.AllPins) pin.SetBusFlip(isFlipped);
	}

	private LoadOutputPinColours(cols: OutputPinColourInfo[] | null) {
		if (cols == null) return;
		for (const pin of this.OutputPins) {
			for (const colInfo of cols) {
				if (colInfo.PinID === pin.Address.PinID) pin.Colour = colInfo.PinColour;
			}
		}
	}
}

function CreateDisplayInstances(chipDesc: ChipDescription): DisplayInstance[] {
	const list: DisplayInstance[] = [];
	if (HasDisplay(chipDesc)) {
		for (const displayDesc of chipDesc.Displays!) {
			try {
				list.push(CreateDisplayInstance(displayDesc, chipDesc));
			} catch {
				// Failed to create display (this is expected if display has been deleted by player)
			}
		}
	}
	return list;
}

function CreateDisplayInstance(displayDesc: DisplayDescription, chipDesc: ChipDescription): DisplayInstance {
	const instance = new DisplayInstance();
	instance.Desc = displayDesc;
	instance.DisplayType = chipDesc.ChipType;

	if (chipDesc.ChipType === ChipType.Custom) {
		const childDesc = GetDescriptionOfDisplayedSubChip(chipDesc, displayDesc.SubChipID);
		instance.ChildDisplays = CreateDisplayInstances(childDesc);
	}
	return instance;
}

function GetDescriptionOfDisplayedSubChip(chipDesc: ChipDescription, subchipID: number): ChipDescription {
	const library = Project.ActiveProject.chipLibrary;
	for (const subchipDesc of chipDesc.SubChips) {
		if (subchipDesc.ID === subchipID) return library.GetChipDescription(subchipDesc.Name);
	}
	throw new Error("Chip for display not found " + chipDesc.Name + " subchip id: " + subchipID);
}

// Split chip name into two lines (if contains a space character)
export function CreateMultiLineName(name: string): string {
	// If name is short, or contains no spaces, then just keep on single line
	if (name.length <= 6 || !name.includes(" ")) return name;

	let lines = [name];
	let bestSplitPenalty = Number.MAX_VALUE;

	for (let i = 0; i < name.length; i++) {
		if (name[i] === " ") {
			const lineA = name.substring(0, i).trim();
			const lineB = name.substring(i).trim();
			const splitPenalty = Math.abs(lineA.length - lineB.length);
			if (splitPenalty < bestSplitPenalty) {
				lines = [lineA, lineB];
				bestSplitPenalty = splitPenalty;
			}
		}
	}

	// Pad lines with spaces to centre justify
	let formatted = "";
	const longestLine = Math.max(...lines.map((l) => l.length));

	for (let i = 0; i < lines.length; i++) {
		let line = lines[i];
		const numPadChars = longestLine - line.length;
		const numPadLeft = Math.floor(numPadChars / 2);
		const numPadRight = numPadChars - numPadLeft;
		line = " ".repeat(numPadLeft) + line + " ".repeat(numPadRight);

		// Add half space tag to center if padding is uneven
		if (numPadLeft < numPadRight) line = "<halfSpace>" + line;

		formatted += line;
		if (i < lines.length - 1) formatted += "\n";
	}

	return formatted;
}

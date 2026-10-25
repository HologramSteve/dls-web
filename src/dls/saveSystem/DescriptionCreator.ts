// Port of DLS.SaveSystem.DescriptionCreator
import { Vector2 } from "../../seb/types/Vector2";
import { Color } from "../../seb/types/Color";
import { Mathf } from "../../seb/types/Mathf";
import { ChipDescription, ChipType, NameDisplayLocation, PinDescription, SubChipDescription, WireConnectionType, WireDescription } from "../description/Types";
import { ChipTypeHelper } from "../description/ChipTypeHelper";
import { DLSVersion } from "../game/Version";
import type { DevChipInstance } from "../game/DevChipInstance";
import type { DevPinInstance } from "../game/elements/DevPinInstance";
import { SubChipInstance } from "../game/elements/SubChipInstance";
import type { WireInstance } from "../game/elements/WireInstance";

export function CreateChipDescription(chip: DevChipInstance): ChipDescription {
	// Get previously saved customizations such as name and colour (if exist)
	const descOld = chip.LastSavedDescription;
	const hasSavedDesc = descOld != null;
	let size = hasSavedDesc ? descOld.Size : Vector2.zero;
	const col = hasSavedDesc ? descOld.Colour : RandomInitialChipColour();
	const name = hasSavedDesc ? descOld.Name : "";
	const displays = hasSavedDesc ? descOld.Displays : null;

	// Create pin and subchip descriptions
	const inputPins = OrderPins(chip.GetInputPins()).map(CreatePinDescription);
	const outputPins = OrderPins(chip.GetOutputPins()).map(CreatePinDescription);
	const subchips = chip.GetSubchips().map(CreateSubChipDescription);
	const minChipsSize = SubChipInstance.CalculateMinChipSize(inputPins, outputPins, name);
	size = Vector2.max(minChipsSize, size);

	UpdateWireIndicesForDescriptionCreation(chip);

	return {
		DLSVersion: DLSVersion.toString(),
		Name: name,
		NameLocation: hasSavedDesc ? descOld.NameLocation : NameDisplayLocation.Centre,
		Size: size,
		Colour: col,
		SubChips: subchips,
		InputPins: inputPins,
		OutputPins: outputPins,
		Wires: chip.Wires.map(CreateWireDescription),
		Displays: displays,
		ChipType: ChipType.Custom,
	};
}

// OrderByDescending(y).ThenBy(x) (stable)
function OrderPins(pins: DevPinInstance[]): DevPinInstance[] {
	return pins.slice().sort((a, b) => b.Position.y - a.Position.y || a.Position.x - b.Position.x);
}

export function CreateSubChipDescription(subChip: SubChipInstance): SubChipDescription {
	return SubChipDescription(
		subChip.Description.Name,
		subChip.ID,
		subChip.Label,
		subChip.Position,
		// Don't save colour info for bus since it changes based on received input
		subChip.IsBus ? null : subChip.OutputPins.map((p) => ({ PinColour: p.Colour, PinID: p.Address.PinID })),
		subChip.InternalData ? subChip.InternalData.slice() : null,
	);
}

export function CreateBuiltinSubChipDescriptionForPlacement(type: ChipType, name: string, id: number, position: Vector2): SubChipDescription {
	return SubChipDescription(name, id, "", position, [], CreateDefaultInstanceData(type));
}

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

export function UpdateWireIndicesForDescriptionCreation(chip: DevChipInstance) {
	for (let i = 0; i < chip.Wires.length; i++) chip.Wires[i].descriptionCreator_wireIndex = i;
}

// Note: assumed that all wire indices have been set prior to calling this function
export function CreateWireDescription(wire: WireInstance): WireDescription {
	const wirePoints: Vector2[] = new Array(wire.WirePointCount);
	for (let i = 0; i < wirePoints.length; i++) {
		// Don't need to save start/end points (just leave as zero) since they get their positions from the pins they're connected to (unless starting/ending at another wire).
		wirePoints[i] = Vector2.zero;
		if (i === 0 && !wire.SourceConnectionInfo.IsConnectedAtWire) continue;
		if (i === wirePoints.length - 1 && !wire.TargetConnectionInfo.IsConnectedAtWire) continue;
		wirePoints[i] = wire.GetWirePoint(i);
	}

	let connectionType = WireConnectionType.ToPins;
	let connectedWireIndex = -1;
	let connectedWireSegmentIndex = -1;

	const connectedWire = wire.ConnectedWire;
	if (connectedWire != null) {
		if (wire.SourceConnectionInfo.IsConnectedAtWire) {
			connectionType = WireConnectionType.ToWireSource;
			connectedWireSegmentIndex = wire.SourceConnectionInfo.wireConnectionSegmentIndex;
		} else if (wire.TargetConnectionInfo.IsConnectedAtWire) {
			connectionType = WireConnectionType.ToWireTarget;
			connectedWireSegmentIndex = wire.TargetConnectionInfo.wireConnectionSegmentIndex;
		}
		connectedWireIndex = connectedWire.descriptionCreator_wireIndex;
	}

	return {
		SourcePinAddress: { ...wire.SourcePin.Address },
		TargetPinAddress: { ...wire.TargetPin.Address },
		ConnectionType: connectionType,
		ConnectedWireIndex: connectedWireIndex,
		ConnectedWireSegmentIndex: connectedWireSegmentIndex,
		Points: wirePoints,
	};
}

export function CreatePinDescription(devPin: DevPinInstance): PinDescription {
	return PinDescription(
		devPin.Pin.Name,
		devPin.ID,
		devPin.Position,
		devPin.Pin.bitCount,
		// Don't save colour info for output pin since it changes based on received input
		devPin.IsInputPin ? devPin.Pin.Colour : 0,
		devPin.pinValueDisplayMode,
	);
}

function RandomInitialChipColour(): Color {
	const h = Math.random();
	const s = Mathf.Lerp(0.2, 1, Math.random());
	const v = Mathf.Lerp(0.2, 1, Math.random());
	return Color.HSVToRGB(h, s, v);
}

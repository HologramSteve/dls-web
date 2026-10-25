// Static pin layout helpers from DLS.Game.SubChipInstance (split into their own module to avoid import cycles)
import { PinBitCount, PinDescription } from "../description/Types";
import { GridSize } from "../graphics/DrawSettings";

// Min chip height based on input and output pins
export function MinChipHeightForPins(inputs: PinDescription[] | null, outputs: PinDescription[] | null): number {
	return Math.max(MinChipHeightForPinList(inputs), MinChipHeightForPinList(outputs));
}

export function MinChipHeightForPinList(pins: PinDescription[] | null): number {
	if (!pins || pins.length === 0) return 0;
	return CalculateDefaultPinLayout(pins.map((p) => p.BitCount))[0];
}

// Calculate minimal height of chip to fit the given pins, and calculate their y positions (in grid space)
export function CalculateDefaultPinLayout(pins: PinBitCount[]): [number, number[]] {
	let gridY = 0; // top
	const pinGridYVals: number[] = new Array(pins.length);

	for (let i = 0; i < pins.length; i++) {
		const pinGridHeight = pins[i] === PinBitCount.Bit1 ? 2 : pins[i] === PinBitCount.Bit4 ? 3 : 4;
		pinGridYVals[i] = gridY - pinGridHeight / 2;
		gridY -= pinGridHeight;
	}

	const height = Math.abs(gridY) * GridSize;
	return [height, pinGridYVals];
}

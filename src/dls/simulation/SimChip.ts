// Port of DLS.Simulation.SimPin and DLS.Simulation.SimChip (worker side)
import { ChipType } from "../description/Types";
import type { PinAddress } from "../description/Types";
import { PinState } from "./PinState";

// Minimal chip description needed to build the simulation (sent from main thread to the worker)
export interface SimChipDesc {
	Name: string;
	ChipType: ChipType;
	InputPinIDs: number[];
	OutputPinIDs: number[];
	SubChips: { Name: string; ID: number; InternalData: number[] | null }[];
	Wires: { Source: PinAddress; Target: PinAddress }[];
}

// Shared simulation globals (Simulator static state used by SimPin)
export const SimGlobals = {
	simulationFrame: 0,
	pcgRngState: 0,
};

export function RandomBool(): boolean {
	const s = (Math.imul(SimGlobals.pcgRngState, 747796405) + 2891336453) >>> 0;
	SimGlobals.pcgRngState = s;
	let result = Math.imul(((s >>> (((s >>> 28) + 4) & 31)) ^ s) >>> 0, 277803737) >>> 0;
	result = ((result >>> 22) ^ result) >>> 0;
	return result < 2147483647; // uint.MaxValue / 2 (integer division)
}

export class SimPin {
	readonly ID: number;
	readonly parentChip: SimChip;
	readonly isInput: boolean;
	State: number;

	ConnectedTargetPins: SimPin[] = [];

	// Simulation frame index on which pin last received an input
	lastUpdatedFrameIndex = 0;

	// Address of pin from where this pin last received its input
	latestSourceID = -1;
	latestSourceParentChipID = -1;

	// Number of wires that input their signal to this pin. (In the case of conflicting signals, the pin chooses randomly)
	numInputConnections = 0;
	numInputsReceivedThisFrame = 0;

	constructor(id: number, isInput: boolean, parentChip: SimChip) {
		this.parentChip = parentChip;
		this.isInput = isInput;
		this.ID = id;
		this.State = PinState.AllDisconnected;
	}

	get FirstBitHigh(): boolean {
		return (this.State & 1) === 1;
	}

	PropagateSignal() {
		const targets = this.ConnectedTargetPins;
		const length = targets.length;
		for (let i = 0; i < length; i++) {
			targets[i].ReceiveInput(this);
		}
	}

	// Called on sub-chip input pins, or chip dev-pins
	ReceiveInput(source: SimPin) {
		const frame = SimGlobals.simulationFrame;
		// If this is the first input of the frame, reset the received inputs counter to zero
		if (this.lastUpdatedFrameIndex !== frame) {
			this.lastUpdatedFrameIndex = frame;
			this.numInputsReceivedThisFrame = 0;
		}

		let set: boolean;

		if (this.numInputsReceivedThisFrame > 0) {
			// Has already received input this frame, so choose at random whether to accept conflicting input.
			// Note: for multi-bit pins, this choice is made identically for all bits, rather than individually.
			const OR = source.State | this.State;
			const AND = source.State & this.State;
			let bitsNew = (RandomBool() ? OR : AND) & 0xffff; // randomly accept or reject conflicting state

			const mask = (OR >>> 16) & 0xffff; // tristate flags
			bitsNew = ((bitsNew & ~mask) | (OR & mask)) & 0xffff; // can always accept input for tristated bits

			const tristateNew = (AND >>> 16) & 0xffff;
			const stateNew = bitsNew | (tristateNew << 16);
			set = stateNew !== this.State;
			this.State = stateNew;
		} else {
			// First input source this frame, so accept it.
			this.State = source.State;
			set = true;
		}

		if (set) {
			this.latestSourceID = source.ID;
			this.latestSourceParentChipID = source.parentChip.ID;
		}

		this.numInputsReceivedThisFrame++;

		// If this is a sub-chip input pin, and has received all of its connections, notify the sub-chip that the input is ready
		if (this.isInput && this.numInputsReceivedThisFrame === this.numInputConnections) {
			this.parentChip.numInputsReady++;
		}
	}
}

const EmptyInternal = new Uint32Array(0);

export class SimChip {
	readonly ChipType: ChipType;
	readonly ID: number;

	// Some builtin chips, such as RAM, require an internal state for memory
	// (can also be used for other arbitrary chip-specific data)
	InternalState: Uint32Array = EmptyInternal;
	readonly IsBuiltin: boolean;
	InputPins: SimPin[] = [];
	numConnectedInputs = 0;
	numInputsReady = 0;
	OutputPins: SimPin[] = [];
	SubChips: SimChip[] = [];

	constructor(desc: SimChipDesc | null, id: number, internalState: ArrayLike<number> | null, subChips: SimChip[]) {
		this.SubChips = subChips;
		this.ID = id;
		this.ChipType = desc ? desc.ChipType : ChipType.Custom;
		this.IsBuiltin = this.ChipType !== ChipType.Custom;
		if (!desc) return;

		// ---- Create pins ----
		if (desc.InputPinIDs.length > 0) this.InputPins = desc.InputPinIDs.map((pid) => new SimPin(pid, true, this));
		if (desc.OutputPinIDs.length > 0) this.OutputPins = desc.OutputPinIDs.map((pid) => new SimPin(pid, false, this));

		// ---- Initialize internal state ----
		const addressSize_8Bit = 256;

		if (this.ChipType === ChipType.DisplayRGB || this.ChipType === ChipType.DisplayDot) {
			// first 256 = display buffer, next 256 = back buffer, last = clock state (to allow edge-trigger behaviour)
			this.InternalState = new Uint32Array(addressSize_8Bit * 2 + 1);
		} else if (this.ChipType === ChipType.dev_Ram_8Bit) {
			this.InternalState = new Uint32Array(addressSize_8Bit + 1); // +1 for clock state
			// Initialize memory contents to random state
			for (let i = 0; i < this.InternalState.length - 1; i++) {
				this.InternalState[i] = (Math.random() * 0x100000000) >>> 0;
			}
		}
		// Load in serialized persistent state (rom data, etc.)
		else if (internalState && internalState.length > 0) {
			this.InternalState = new Uint32Array(internalState.length);
			this.UpdateInternalState(internalState);
		}
	}

	UpdateInternalState(source: ArrayLike<number>) {
		const n = Math.min(this.InternalState.length, source.length);
		for (let i = 0; i < n; i++) this.InternalState[i] = source[i] >>> 0;
	}

	Sim_PropagateInputs() {
		const pins = this.InputPins;
		const length = pins.length;
		for (let i = 0; i < length; i++) pins[i].PropagateSignal();
	}

	Sim_PropagateOutputs() {
		const pins = this.OutputPins;
		const length = pins.length;
		for (let i = 0; i < length; i++) pins[i].PropagateSignal();
		this.numInputsReady = 0; // Reset for next frame
	}

	Sim_IsReady(): boolean {
		return this.numInputsReady === this.numConnectedInputs;
	}

	TryGetSubChipFromID(id: number): SimChip | null {
		for (const s of this.SubChips) {
			if (s.ID === id) return s;
		}
		return null;
	}

	GetSubChipFromID(id: number): SimChip {
		const c = this.TryGetSubChipFromID(id);
		if (c) return c;
		throw new Error("Failed to find subchip with id " + id);
	}

	// Returns [pin, chip] (chip is null for dev pins of this chip)
	GetSimPinFromAddressWithChip(address: PinAddress): [SimPin, SimChip | null] {
		for (const s of this.SubChips) {
			if (s.ID === address.PinOwnerID) {
				for (const pin of s.InputPins) if (pin.ID === address.PinID) return [pin, s];
				for (const pin of s.OutputPins) if (pin.ID === address.PinID) return [pin, s];
			}
		}
		for (const pin of this.InputPins) if (pin.ID === address.PinOwnerID) return [pin, null];
		for (const pin of this.OutputPins) if (pin.ID === address.PinOwnerID) return [pin, null];
		throw new Error("Failed to find pin with address: " + address.PinID + ", " + address.PinOwnerID);
	}

	GetSimPinFromAddress(address: PinAddress): SimPin {
		return this.GetSimPinFromAddressWithChip(address)[0];
	}

	RemoveSubChip(id: number) {
		this.SubChips = this.SubChips.filter((s) => s.ID !== id);
	}

	AddPin(pin: SimPin, isInput: boolean) {
		if (isInput) this.InputPins = [...this.InputPins, pin];
		else this.OutputPins = [...this.OutputPins, pin];
	}

	RemovePin(removePinID: number) {
		this.InputPins = this.InputPins.filter((p) => p.ID !== removePinID);
		this.OutputPins = this.OutputPins.filter((p) => p.ID !== removePinID);
	}

	AddSubChip(subChip: SimChip) {
		this.SubChips = [...this.SubChips, subChip];
	}

	AddConnection(sourcePinAddress: PinAddress, targetPinAddress: PinAddress) {
		try {
			const sourcePin = this.GetSimPinFromAddress(sourcePinAddress);
			const [targetPin, targetChip] = this.GetSimPinFromAddressWithChip(targetPinAddress);

			sourcePin.ConnectedTargetPins = [...sourcePin.ConnectedTargetPins, targetPin];
			targetPin.numInputConnections++;
			if (targetPin.numInputConnections === 1 && targetChip !== null) targetChip.numConnectedInputs++;
		} catch {
			// Can fail to find pin if player has edited an existing chip to remove the pin, and then a chip is opened which uses the old version of that modified chip.
			// In that case we just ignore the failure and no connection is made.
		}
	}

	RemoveConnection(sourcePinAddress: PinAddress, targetPinAddress: PinAddress) {
		const sourcePin = this.GetSimPinFromAddress(sourcePinAddress);
		const [removeTargetPin, targetChip] = this.GetSimPinFromAddressWithChip(targetPinAddress);

		// Remove first matching connection
		const targets = sourcePin.ConnectedTargetPins;
		for (let i = 0; i < targets.length; i++) {
			if (targets[i] === removeTargetPin) {
				sourcePin.ConnectedTargetPins = targets.slice(0, i).concat(targets.slice(i + 1));

				removeTargetPin.numInputConnections -= 1;
				if (removeTargetPin.numInputConnections === 0) {
					removeTargetPin.State = PinState.AllDisconnected;
					removeTargetPin.latestSourceID = -1;
					removeTargetPin.latestSourceParentChipID = -1;
					if (targetChip !== null) removeTargetPin.parentChip.numConnectedInputs--;
				}
				break;
			}
		}
	}
}

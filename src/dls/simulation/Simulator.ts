// Port of DLS.Simulation.Simulator (runs inside the simulation Web Worker).
// The main thread never touches these objects directly; it sends modification commands (mirroring the
// original's ConcurrentQueue<SimModifyCommand>) and receives state snapshots. See worker/simWorker.ts.
import { ChipType, NameKey } from "../description/Types";
import type { PinAddress } from "../description/Types";
import { ChipTypeHelper } from "../description/ChipTypeHelper";
import { PinState } from "./PinState";
import { RandomBool, SimChip, SimChipDesc, SimGlobals, SimPin } from "./SimChip";
import { SimAudio } from "./SimAudio";

// Library of chip descriptions available to the worker
export class SimLibrary {
	private readonly map = new Map<string, SimChipDesc>();

	set(desc: SimChipDesc) {
		this.map.set(NameKey(desc.Name), desc);
	}
	remove(name: string) {
		this.map.delete(NameKey(name));
	}
	clear() {
		this.map.clear();
	}
	get(name: string): SimChipDesc {
		const d = this.map.get(NameKey(name));
		if (!d) throw new Error("Chip not found in sim library: " + name);
		return d;
	}
}

export type SimModifyCommand =
	| { type: "AddSubchip"; target: number[]; chipName: string; subChipID: number; internalData: number[] | null }
	| { type: "RemoveSubChip"; target: number[]; id: number }
	| { type: "AddConnection"; target: number[]; source: PinAddress; dest: PinAddress }
	| { type: "RemoveConnection"; target: number[]; source: PinAddress; dest: PinAddress }
	| { type: "AddPin"; target: number[]; pinID: number; isInput: boolean }
	| { type: "RemovePin"; target: number[]; pinID: number }
	// ---- Extra commands (operations that the original did by directly touching sim objects from the main thread) ----
	| { type: "BuildRoot"; desc: SimChipDesc } // Build new root sim chip from description
	| { type: "SetInternalState"; target: number[]; index: number; value: number }
	| { type: "UpdateInternalState"; target: number[]; data: number[] }
	| { type: "LibrarySet"; descs: SimChipDesc[]; replaceAll: boolean }
	| { type: "LibraryRemove"; name: string };

export const Simulator = {
	stepsPerClockTransition: 0,
	// When sim is first built, or whenever modified, it needs to run a less efficient pass in which the traversal order of the chips is determined
	needsOrderPass: true,
	// Every n frames the simulation permits some random modifications to traversal order of sequential chips (to randomize outcome of race conditions)
	canDynamicReorderThisFrame: false,

	library: new SimLibrary(),
	rootSimChip: new SimChip(null, -1, null, []) as SimChip,
	audioState: new SimAudio(),
	heldKeys: new Set<string>(),

	elapsedSecondsOld: 0,
	startTime: performance.now(),

	get simulationFrame() {
		return SimGlobals.simulationFrame;
	},

	// ---- Simulation outline ----
	// 1) Forward the initial player-controlled input states to all connected pins.
	// 2) Loop over all subchips not yet processed this frame, and process them if they are ready (i.e. all input pins have received all their inputs)
	// 3) Forward the outputs of the processed subchips to their connected pins, and repeat steps 2 & 3 until no more subchips are ready for processing.
	// 4) If all subchips have now been processed, then we're done. Otherwise (input depends on output of its parent chip) process one of the
	//    remaining unprocessed (and non-ready) subchips at random, and return to step 3.
	// inputs: flat array [devPinID, state, devPinID, state, ...]
	RunSimulationStep(rootSimChip: SimChip, inputs: Int32Array) {
		const audioState = Simulator.audioState;
		audioState.InitFrame();

		SimGlobals.pcgRngState = (Math.random() * 0x7fffffff) >>> 0;
		Simulator.canDynamicReorderThisFrame = SimGlobals.simulationFrame % 100 === 0;
		SimGlobals.simulationFrame++;

		// Step 1) Get player-controlled input states and copy values to the sim
		const rootInputs = rootSimChip.InputPins;
		for (let i = 0; i < inputs.length; i += 2) {
			const id = inputs[i];
			for (let j = 0; j < rootInputs.length; j++) {
				if (rootInputs[j].ID === id) {
					rootInputs[j].State = inputs[i + 1];
					break;
				}
			}
		}

		if (Simulator.needsOrderPass) {
			StepChipReorder(rootSimChip);
			Simulator.needsOrderPass = false;
		} else {
			StepChip(rootSimChip);
		}

		Simulator.UpdateAudioState();
	},

	UpdateInPausedState() {
		Simulator.audioState.InitFrame();
		Simulator.UpdateAudioState();
	},

	UpdateAudioState() {
		const elapsedSeconds = (performance.now() - Simulator.startTime) / 1000;
		const deltaTime = SimGlobals.simulationFrame <= 1 ? 0 : elapsedSeconds - Simulator.elapsedSecondsOld;
		Simulator.elapsedSecondsOld = elapsedSeconds;
		Simulator.audioState.NotifyAllNotesRegistered(deltaTime);
	},

	BuildSimChip(desc: SimChipDesc, subChipID = -1, internalState: number[] | null = null): SimChip {
		return BuildSimChipRecursive(desc, subChipID, internalState);
	},

	ResolveTarget(path: number[]): SimChip {
		let chip = Simulator.rootSimChip;
		for (const id of path) chip = chip.GetSubChipFromID(id);
		return chip;
	},

	ApplyModification(cmd: SimModifyCommand) {
		Simulator.needsOrderPass = true;
		switch (cmd.type) {
			case "AddSubchip": {
				const desc = Simulator.library.get(cmd.chipName);
				const newSubChip = Simulator.BuildSimChip(desc, cmd.subChipID, cmd.internalData);
				Simulator.ResolveTarget(cmd.target).AddSubChip(newSubChip);
				break;
			}
			case "RemoveSubChip":
				Simulator.ResolveTarget(cmd.target).RemoveSubChip(cmd.id);
				break;
			case "AddConnection":
				Simulator.ResolveTarget(cmd.target).AddConnection(cmd.source, cmd.dest);
				break;
			case "RemoveConnection":
				Simulator.ResolveTarget(cmd.target).RemoveConnection(cmd.source, cmd.dest);
				break;
			case "AddPin": {
				const target = Simulator.ResolveTarget(cmd.target);
				target.AddPin(new SimPin(cmd.pinID, cmd.isInput, target), cmd.isInput);
				break;
			}
			case "RemovePin":
				Simulator.ResolveTarget(cmd.target).RemovePin(cmd.pinID);
				break;
			case "BuildRoot":
				Simulator.rootSimChip = Simulator.BuildSimChip(cmd.desc);
				break;
			case "SetInternalState": {
				const chip = Simulator.ResolveTarget(cmd.target);
				if (cmd.index < chip.InternalState.length) chip.InternalState[cmd.index] = cmd.value >>> 0;
				break;
			}
			case "UpdateInternalState":
				Simulator.ResolveTarget(cmd.target).UpdateInternalState(cmd.data);
				break;
			case "LibrarySet":
				if (cmd.replaceAll) Simulator.library.clear();
				for (const d of cmd.descs) Simulator.library.set(d);
				break;
			case "LibraryRemove":
				Simulator.library.remove(cmd.name);
				break;
		}
	},

	Reset() {
		SimGlobals.simulationFrame = 0;
		Simulator.startTime = performance.now();
		Simulator.elapsedSecondsOld = 0;
	},
};

// Recursively propagate signals through this chip and its subchips
function StepChip(chip: SimChip) {
	// Propagate signal from all input dev-pins to all their connected pins
	chip.Sim_PropagateInputs();

	const subChips = chip.SubChips;
	// NOTE: subchips are assumed to have been sorted in reverse order of desired visitation
	for (let i = subChips.length - 1; i >= 0; i--) {
		let nextSubChip = subChips[i];

		// Every n frames the simulation permits some random modifications to the chip traversal order.
		// Here two chips may be swapped if they are not 'ready' (i.e. all inputs have not yet been received for this
		// frame; indicating that the input relies on the output). The purpose of this reordering is to allow some variety in
		// the outcomes of race-conditions (such as an SR latch having both inputs enabled, and then released).
		if (Simulator.canDynamicReorderThisFrame && i > 0 && !nextSubChip.Sim_IsReady() && RandomBool()) {
			const potentialSwapChip = subChips[i - 1];
			if (!ChipTypeHelper.IsBusOriginType(potentialSwapChip.ChipType)) {
				nextSubChip = potentialSwapChip;
				subChips[i - 1] = subChips[i];
				subChips[i] = potentialSwapChip;
			}
		}

		if (nextSubChip.IsBuiltin) ProcessBuiltinChip(nextSubChip);
		else StepChip(nextSubChip);

		// Step 3) Forward the outputs of the processed subchip to connected pins
		nextSubChip.Sim_PropagateOutputs();
	}
}

// Recursively propagate signals through this chip and its subchips
// In the process, reorder all subchips based on order in which they become ready for processing (have received all their inputs)
// Note: the order here is reversed, so those ready first will be at the end of the array
function StepChipReorder(chip: SimChip) {
	chip.Sim_PropagateInputs();

	const subChips = chip.SubChips;
	let numRemaining = subChips.length;

	while (numRemaining > 0) {
		const nextSubChipIndex = ChooseNextSubChip(subChips, numRemaining);
		const nextSubChip = subChips[nextSubChipIndex];

		// "Remove" the chosen subchip from remaining sub chips by moving it to the end of the array.
		subChips[nextSubChipIndex] = subChips[numRemaining - 1];
		subChips[numRemaining - 1] = nextSubChip;
		numRemaining--;

		if (nextSubChip.ChipType === ChipType.Custom) StepChipReorder(nextSubChip);
		else ProcessBuiltinChip(nextSubChip);

		nextSubChip.Sim_PropagateOutputs();
	}
}

function ChooseNextSubChip(subChips: SimChip[], num: number): number {
	let noSubChipsReady = true;
	let isNonBusChipRemaining = false;
	let nextSubChipIndex = -1;

	// Step 2) Loop over all subchips not yet processed this frame, and process them if they are ready
	for (let i = 0; i < num; i++) {
		const subChip = subChips[i];
		if (subChip.Sim_IsReady()) {
			noSubChipsReady = false;
			nextSubChipIndex = i;
			break;
		}
		isNonBusChipRemaining ||= !ChipTypeHelper.IsBusOriginType(subChip.ChipType);
	}

	// Step 4) if no sub chip is ready to be processed, pick one at random (but save buses for last)
	if (noSubChipsReady) {
		nextSubChipIndex = Math.floor(Math.random() * num);

		// If processing in random order, save buses for last (since we must know all their inputs to display correctly)
		if (isNonBusChipRemaining) {
			for (let i = 0; i < num; i++) {
				if (!ChipTypeHelper.IsBusOriginType(subChips[nextSubChipIndex].ChipType)) break;
				nextSubChipIndex = (nextSubChipIndex + 1) % num;
			}
		}
	}

	return nextSubChipIndex;
}

const SingleBitMask = PinState.SingleBitMask;

function ProcessBuiltinChip(chip: SimChip) {
	const inPins = chip.InputPins;
	const outPins = chip.OutputPins;

	switch (chip.ChipType) {
		// ---- Process Built-in chips ----
		case ChipType.Nand: {
			const nandOp = 1 ^ (inPins[0].State & inPins[1].State);
			outPins[0].State = nandOp & 1;
			break;
		}
		case ChipType.Clock: {
			const spct = Simulator.stepsPerClockTransition;
			const high = spct !== 0 && (Math.floor(SimGlobals.simulationFrame / spct) & 1) === 0;
			outPins[0].State = high ? PinState.LogicHigh : PinState.LogicLow;
			break;
		}
		case ChipType.Pulse: {
			const pulseDurationIndex = 0;
			const pulseTicksRemainingIndex = 1;
			const pulseInputOldIndex = 2;
			const internal = chip.InternalState;

			const inputState = inPins[0].State;
			const pulseInputHigh = (inputState & 1) === 1;
			let pulseTicksRemaining = internal[pulseTicksRemainingIndex];

			if (pulseTicksRemaining === 0) {
				const isRisingEdge = pulseInputHigh && internal[pulseInputOldIndex] === 0;
				if (isRisingEdge) {
					pulseTicksRemaining = internal[pulseDurationIndex];
					internal[pulseTicksRemainingIndex] = pulseTicksRemaining;
				}
			}

			let outputState: number = PinState.LogicLow;
			if (pulseTicksRemaining > 0) {
				internal[1]--;
				outputState = PinState.LogicHigh;
			} else if (PinState.GetTristateFlags(inputState) !== 0) {
				outputState = PinState.AllDisconnected;
			}

			outPins[0].State = outputState;
			internal[pulseInputOldIndex] = pulseInputHigh ? 1 : 0;
			break;
		}
		case ChipType.Split_4To1Bit: {
			const in4 = inPins[0].State;
			outPins[0].State = (in4 >>> 3) & SingleBitMask;
			outPins[1].State = (in4 >>> 2) & SingleBitMask;
			outPins[2].State = (in4 >>> 1) & SingleBitMask;
			outPins[3].State = (in4 >>> 0) & SingleBitMask;
			break;
		}
		case ChipType.Merge_1To4Bit: {
			const stateA = inPins[3].State & SingleBitMask; // lsb
			const stateB = inPins[2].State & SingleBitMask;
			const stateC = inPins[1].State & SingleBitMask;
			const stateD = inPins[0].State & SingleBitMask;
			outPins[0].State = stateA | (stateB << 1) | (stateC << 2) | (stateD << 3);
			break;
		}
		case ChipType.Merge_1To8Bit: {
			const a = inPins[7].State & SingleBitMask; // lsb
			const b = inPins[6].State & SingleBitMask;
			const c = inPins[5].State & SingleBitMask;
			const d = inPins[4].State & SingleBitMask;
			const e = inPins[3].State & SingleBitMask;
			const f = inPins[2].State & SingleBitMask;
			const g = inPins[1].State & SingleBitMask;
			const h = inPins[0].State & SingleBitMask;
			outPins[0].State = a | (b << 1) | (c << 2) | (d << 3) | (e << 4) | (f << 5) | (g << 6) | (h << 7);
			break;
		}
		case ChipType.Merge_4To8Bit: {
			outPins[0].State = PinState.Get8BitFrom4BitSources(inPins[1].State, inPins[0].State);
			break;
		}
		case ChipType.Split_8To4Bit: {
			const in8 = inPins[0].State;
			outPins[0].State = PinState.Get4BitFrom8BitSource(in8, false);
			outPins[1].State = PinState.Get4BitFrom8BitSource(in8, true);
			break;
		}
		case ChipType.Split_8To1Bit: {
			const in8 = inPins[0].State;
			outPins[0].State = (in8 >>> 7) & SingleBitMask;
			outPins[1].State = (in8 >>> 6) & SingleBitMask;
			outPins[2].State = (in8 >>> 5) & SingleBitMask;
			outPins[3].State = (in8 >>> 4) & SingleBitMask;
			outPins[4].State = (in8 >>> 3) & SingleBitMask;
			outPins[5].State = (in8 >>> 2) & SingleBitMask;
			outPins[6].State = (in8 >>> 1) & SingleBitMask;
			outPins[7].State = (in8 >>> 0) & SingleBitMask;
			break;
		}
		case ChipType.TriStateBuffer: {
			if ((inPins[1].State & 1) === 1) outPins[0].State = inPins[0].State;
			else outPins[0].State = PinState.AllDisconnected;
			break;
		}
		case ChipType.Key: {
			const isHeld = Simulator.heldKeys.has(String.fromCharCode(chip.InternalState[0]));
			outPins[0].State = isHeld ? PinState.LogicHigh : PinState.LogicLow;
			break;
		}
		case ChipType.DisplayRGB: {
			const addressSpace = 256;
			const internal = chip.InternalState;
			const addressPin = inPins[0].State;
			const redPin = inPins[1].State;
			const greenPin = inPins[2].State;
			const bluePin = inPins[3].State;
			const resetPin = inPins[4].State;
			const writePin = inPins[5].State;
			const refreshPin = inPins[6].State;
			const clockPin = inPins[7].State;

			// Detect clock rising edge
			const last = internal.length - 1;
			const clockHigh = (clockPin & 1) === 1;
			const isRisingEdge = clockHigh && internal[last] === 0;
			internal[last] = clockHigh ? 1 : 0;

			if (isRisingEdge) {
				// Clear back buffer
				if ((resetPin & 1) === 1) {
					for (let i = 0; i < addressSpace; i++) internal[i + addressSpace] = 0;
				}
				// Write to back-buffer
				else if ((writePin & 1) === 1) {
					const addressIndex = (addressPin & 0xffff) + addressSpace;
					const data = (redPin & 0xffff) | ((greenPin & 0xffff) << 4) | ((bluePin & 0xffff) << 8);
					internal[addressIndex] = data;
				}

				// Copy back-buffer to display buffer
				if ((refreshPin & 1) === 1) {
					for (let i = 0; i < addressSpace; i++) internal[i] = internal[i + addressSpace];
				}
			}

			// Output current pixel colour
			const colData = internal[addressPin & 0xffff];
			outPins[0].State = (colData >>> 0) & 0b1111; // red
			outPins[1].State = (colData >>> 4) & 0b1111; // green
			outPins[2].State = (colData >>> 8) & 0b1111; // blue
			break;
		}
		case ChipType.DisplayDot: {
			const addressSpace = 256;
			const internal = chip.InternalState;
			const addressPin = inPins[0].State;
			const pixelInputPin = inPins[1].State;
			const resetPin = inPins[2].State;
			const writePin = inPins[3].State;
			const refreshPin = inPins[4].State;
			const clockPin = inPins[5].State;

			const last = internal.length - 1;
			const clockHigh = (clockPin & 1) === 1;
			const isRisingEdge = clockHigh && internal[last] === 0;
			internal[last] = clockHigh ? 1 : 0;

			if (isRisingEdge) {
				if ((resetPin & 1) === 1) {
					for (let i = 0; i < addressSpace; i++) internal[i + addressSpace] = 0;
				} else if ((writePin & 1) === 1) {
					const addressIndex = (addressPin & 0xffff) + addressSpace;
					internal[addressIndex] = pixelInputPin & 0xffff;
				}

				if ((refreshPin & 1) === 1) {
					for (let i = 0; i < addressSpace; i++) internal[i] = internal[i + addressSpace];
				}
			}

			outPins[0].State = internal[addressPin & 0xffff] & 0xffff;
			break;
		}
		case ChipType.dev_Ram_8Bit: {
			const internal = chip.InternalState;
			const addressPin = inPins[0].State;
			const dataPin = inPins[1].State;
			const writeEnablePin = inPins[2].State;
			const resetPin = inPins[3].State;
			const clockPin = inPins[4].State;

			const last = internal.length - 1;
			const clockHigh = (clockPin & 1) === 1;
			const isRisingEdge = clockHigh && internal[last] === 0;
			internal[last] = clockHigh ? 1 : 0;

			if (isRisingEdge) {
				if ((resetPin & 1) === 1) {
					for (let i = 0; i < 256; i++) internal[i] = 0;
				} else if ((writeEnablePin & 1) === 1) {
					internal[addressPin & 0xffff] = dataPin & 0xffff;
				}
			}

			outPins[0].State = internal[addressPin & 0xffff] & 0xffff;
			break;
		}
		case ChipType.Rom_256x16: {
			const ByteMask = 0b11111111;
			const address = inPins[0].State & 0xffff;
			const data = chip.InternalState[address];
			outPins[0].State = (data >>> 8) & ByteMask;
			outPins[1].State = data & ByteMask;
			break;
		}
		case ChipType.Buzzer: {
			const freqIndex = inPins[0].State & 0xffff;
			const volumeIndex = inPins[1].State & 0xffff;
			Simulator.audioState.RegisterNote(freqIndex, volumeIndex);
			break;
		}
		// ---- Bus types ----
		default: {
			if (ChipTypeHelper.IsBusOriginType(chip.ChipType)) {
				outPins[0].State = inPins[0].State;
			}
			break;
		}
	}
}

// Recursively build full representation of chip from its description for simulation.
function BuildSimChipRecursive(chipDesc: SimChipDesc, subChipID: number, internalState: number[] | null): SimChip {
	const subchips: SimChip[] = new Array(chipDesc.SubChips.length);
	for (let i = 0; i < chipDesc.SubChips.length; i++) {
		const subchipDesc = chipDesc.SubChips[i];
		const subchipFullDesc = Simulator.library.get(subchipDesc.Name);
		subchips[i] = BuildSimChipRecursive(subchipFullDesc, subchipDesc.ID, subchipDesc.InternalData);
	}

	const simChip = new SimChip(chipDesc, subChipID, internalState, subchips);

	for (const wire of chipDesc.Wires) {
		simChip.AddConnection(wire.Source, wire.Target);
	}

	return simChip;
}

// Message protocol between the main thread (SimHost) and the simulation worker (simWorker).
import type { SimModifyCommand } from "./Simulator";

export interface FrameRequest {
	type: "frame";
	frameId: number;
	cmds: SimModifyCommand[];
	// Player input pin states: [devPinID, state, devPinID, state, ...]
	inputs: Int32Array;
	// Characters of currently held keys (for KEY chips)
	keys: string;
	// Path (subchip IDs from root) of the chip currently being viewed
	viewPath: number[];
	// Paths (from root) of sim chips whose input pin states + internal state are needed for drawing displays
	displayPaths: number[][];
	paused: boolean;
	singleSteps: number; // number of single steps requested while paused
	targetTicksPerSecond: number;
	stepsPerClockTransition: number;
}

export interface DisplayData {
	path: number[];
	inputs: Int32Array; // input pin states
	internal: Uint32Array; // internal state
}

export interface Snapshot {
	type: "snapshot";
	frameId: number;
	// Entries of 5 ints per pin of the viewed chip:
	// [ownerID, pinID, state, latestSourceID, latestSourceParentChipID]
	// Dev pins of the viewed chip use (ownerID = pin ID, pinID = 0); subchip pins use (subchip ID, pin ID).
	pins: Int32Array;
	viewChipID: number;
	// IDs of the viewed chip's subchips (so the main thread knows which ones exist in the sim)
	subChipIDs: Int32Array;
	viewPathValid: boolean;
	displays: DisplayData[];
	ticksPerSecond: number;
	simulationFrame: number;
	pausedSingleStepCounter: number;
	audio: Float64Array | null;
	error: string | null;
	// Engine actually running in the worker (web-only; "rust" can fall back to "js" if WebAssembly fails to load)
	engine: string;
}

// Sent by the worker once its engine is ready
export interface EngineReady {
	type: "engine";
	engine: "rust" | "js";
}

// First message to the worker: which simulation engine to use (see worker/engines.ts)
export interface WorkerInit {
	type: "init";
	engine: "rust" | "js";
	tables: boolean;
}

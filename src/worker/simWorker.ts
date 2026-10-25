/// <reference lib="webworker" />
// Simulation Web Worker. Equivalent of Project.SimThread in the original: owns the simulation, applies queued
// modifications, steps the simulation at the target rate, and answers frame requests with state snapshots.
import { Simulator } from "../dls/simulation/Simulator";
import type { SimChip } from "../dls/simulation/SimChip";
import type { DisplayData, FrameRequest, Snapshot } from "../dls/simulation/SimProtocol";

const SimulationPerformanceTimeWindowSec = 1.5;

let inputs = new Int32Array(0);
let paused = false;
let pendingSingleSteps = 0;
let pausedSingleStepCounter = 0;
let targetTicksPerSecond = 1000;
let lastError: string | null = null;

// Step pacing
let stepDebt = 0; // fractional steps owed
let lastLoopTime = performance.now();

// Perf counter (ticks per second over sliding window)
const tickWindow: [number, number][] = []; // [timeMs, steps]
let ticksInWindow = 0;
let simAvgTicksPerSec = 0;

function recordTicks(now: number, steps: number) {
	if (steps > 0) {
		tickWindow.push([now, steps]);
		ticksInWindow += steps;
	}
	const windowMs = SimulationPerformanceTimeWindowSec * 1000;
	while (tickWindow.length > 0 && now - tickWindow[0][0] > windowMs) {
		ticksInWindow -= tickWindow[0][1];
		tickWindow.shift();
	}
	if (tickWindow.length > 0) {
		const activeWindowMs = now - tickWindow[0][0];
		simAvgTicksPerSec = activeWindowMs > 0 ? (ticksInWindow / activeWindowMs) * 1000 : simAvgTicksPerSec;
	} else simAvgTicksPerSec = 0;
}

function applyCommands(req: FrameRequest) {
	for (const cmd of req.cmds) {
		try {
			Simulator.ApplyModification(cmd);
		} catch (e) {
			// Possible for main thread and sim to be temporarily out of sync, so just ignore failures
			lastError = String(e);
		}
	}
}

function resolvePath(path: number[]): SimChip | null {
	let chip: SimChip | null = Simulator.rootSimChip;
	for (const id of path) {
		chip = chip.TryGetSubChipFromID(id);
		if (!chip) return null;
	}
	return chip;
}

function buildSnapshot(req: FrameRequest): Snapshot {
	const view = resolvePath(req.viewPath);
	let pins = new Int32Array(0);
	let subChipIDs = new Int32Array(0);

	if (view) {
		let count = view.InputPins.length + view.OutputPins.length;
		for (const s of view.SubChips) count += s.InputPins.length + s.OutputPins.length;
		pins = new Int32Array(count * 5);
		let o = 0;
		const write = (owner: number, pinID: number, state: number, src: number, srcParent: number) => {
			pins[o++] = owner;
			pins[o++] = pinID;
			pins[o++] = state;
			pins[o++] = src;
			pins[o++] = srcParent;
		};
		for (const p of view.InputPins) write(p.ID, 0, p.State, p.latestSourceID, p.latestSourceParentChipID);
		for (const p of view.OutputPins) write(p.ID, 0, p.State, p.latestSourceID, p.latestSourceParentChipID);
		subChipIDs = new Int32Array(view.SubChips.length);
		for (let i = 0; i < view.SubChips.length; i++) {
			const s = view.SubChips[i];
			subChipIDs[i] = s.ID;
			for (const p of s.InputPins) write(s.ID, p.ID, p.State, p.latestSourceID, p.latestSourceParentChipID);
			for (const p of s.OutputPins) write(s.ID, p.ID, p.State, p.latestSourceID, p.latestSourceParentChipID);
		}
	}

	const displays: DisplayData[] = [];
	for (const path of req.displayPaths) {
		const chip = resolvePath(path);
		if (!chip) continue;
		const ins = new Int32Array(chip.InputPins.length);
		for (let i = 0; i < ins.length; i++) ins[i] = chip.InputPins[i].State;
		displays.push({ path, inputs: ins, internal: chip.InternalState.slice() });
	}

	let audio: Float64Array | null = null;
	if (Simulator.audioState.dirty) {
		Simulator.audioState.dirty = false;
		audio = Simulator.audioState.targetAmplitudesPerFreq.slice();
	}

	const snap: Snapshot = {
		type: "snapshot",
		frameId: req.frameId,
		pins,
		viewChipID: view ? view.ID : -1,
		subChipIDs,
		viewPathValid: view !== null,
		displays,
		ticksPerSecond: simAvgTicksPerSec,
		simulationFrame: Simulator.simulationFrame,
		pausedSingleStepCounter,
		audio,
		error: lastError,
	};
	lastError = null;
	return snap;
}

self.onmessage = (e: MessageEvent<FrameRequest>) => {
	const req = e.data;
	if (req.type !== "frame") return;

	applyCommands(req);
	inputs = req.inputs;
	Simulator.heldKeys = new Set(req.keys);
	paused = req.paused;
	pendingSingleSteps += req.singleSteps;
	targetTicksPerSecond = Math.max(1, req.targetTicksPerSecond);
	Simulator.stepsPerClockTransition = req.stepsPerClockTransition;

	const snap = buildSnapshot(req);
	const transfer: Transferable[] = [snap.pins.buffer, snap.subChipIDs.buffer];
	for (const d of snap.displays) transfer.push(d.inputs.buffer, d.internal.buffer);
	if (snap.audio) transfer.push(snap.audio.buffer);
	(self as unknown as Worker).postMessage(snap, transfer);
};

// ---- Stepping loop ----
// Runs in short time slices so that incoming messages are processed regularly.
const channel = new MessageChannel();
channel.port1.onmessage = () => loop();
function scheduleImmediate() {
	channel.port2.postMessage(0);
}

const SliceBudgetMs = 8;

function step() {
	try {
		Simulator.RunSimulationStep(Simulator.rootSimChip, inputs);
	} catch (e) {
		lastError = String(e);
		Simulator.needsOrderPass = true;
	}
}

function loop() {
	const now = performance.now();

	if (paused) {
		stepDebt = 0;
		lastLoopTime = now;
		let n = 0;
		while (pendingSingleSteps > 0) {
			pendingSingleSteps--;
			pausedSingleStepCounter++;
			step();
			n++;
		}
		if (n === 0) Simulator.UpdateInPausedState();
		recordTicks(now, n);
		setTimeout(loop, 10);
		return;
	}

	pausedSingleStepCounter = 0;
	pendingSingleSteps = 0;

	const elapsed = Math.min(250, now - lastLoopTime);
	lastLoopTime = now;
	stepDebt += (elapsed / 1000) * targetTicksPerSecond;
	// Don't let debt accumulate indefinitely if the sim can't keep up (would cause a burst later)
	stepDebt = Math.min(stepDebt, targetTicksPerSecond * 0.1 + 1);

	let stepsDone = 0;
	const sliceStart = now;
	while (stepDebt >= 1) {
		step();
		stepDebt -= 1;
		stepsDone++;
		if ((stepsDone & 15) === 0 && performance.now() - sliceStart > SliceBudgetMs) break;
	}
	if (performance.now() - sliceStart > SliceBudgetMs) {
		// Couldn't keep up: drop excess debt
		stepDebt = Math.min(stepDebt, 1);
	}
	recordTicks(performance.now(), stepsDone);

	if (stepDebt >= 1) {
		// Behind schedule (time slice ran out): continue immediately
		scheduleImmediate();
	} else {
		// Sleep until the next step is due. Steps are run in small batches (timer resolution is a few ms),
		// rather than busy-waiting between individual steps like the original's dedicated thread does.
		const msUntilNextStep = ((1 - stepDebt) / targetTicksPerSecond) * 1000;
		setTimeout(loop, Math.min(Math.max(msUntilNextStep, 1), 50));
	}
}

Simulator.Reset();
loop();

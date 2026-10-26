/// <reference lib="webworker" />
// Simulation Web Worker. Equivalent of Project.SimThread in the original: owns the simulation, applies queued
// modifications, steps the simulation at the target rate, and answers frame requests with state snapshots.
import type { FrameRequest, Snapshot, WorkerInit } from "../dls/simulation/SimProtocol";
import { JsEngine, type SimEngine, WasmEngine } from "./engines";
import wasmUrl from "./dls_sim.wasm?url";

const SimulationPerformanceTimeWindowSec = 1.5;

let engine: SimEngine | null = null;
// Frame requests that arrived before the engine finished loading
const pending: FrameRequest[] = [];
let paused = false;
let pendingSingleSteps = 0;
let pausedSingleStepCounter = 0;
let targetTicksPerSecond = 1000;
let lastError: string | null = null;

// Step pacing
let stepDebt = 0; // fractional steps owed
let lastLoopTime = performance.now();
// Steps per engine call, adapted so that one batch takes about BatchTargetMs
let batchSize = 1;
const BatchTargetMs = 1;

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

function buildSnapshot(e: SimEngine, req: FrameRequest): Snapshot {
	const view = e.snapshotView(req.viewPath);
	const displays = [];
	for (const path of req.displayPaths) {
		const d = e.display(path);
		if (d) displays.push(d);
	}
	const snap: Snapshot = {
		type: "snapshot",
		frameId: req.frameId,
		pins: view.pins,
		viewChipID: view.viewChipID,
		subChipIDs: view.subChipIDs,
		viewPathValid: view.valid,
		displays,
		ticksPerSecond: simAvgTicksPerSec,
		simulationFrame: e.simulationFrame,
		pausedSingleStepCounter,
		audio: e.audio(),
		error: lastError,
	};
	lastError = null;
	return snap;
}

function handleFrame(e: SimEngine, req: FrameRequest) {
	const err = e.applyCommands(req.cmds);
	if (err) lastError = err;
	e.setInputs(req.inputs);
	e.setKeys(req.keys);
	e.setViewPath(req.viewPath);
	paused = req.paused;
	pendingSingleSteps += req.singleSteps;
	targetTicksPerSecond = Math.max(1, req.targetTicksPerSecond);
	e.setStepsPerClockTransition(req.stepsPerClockTransition);

	const snap = buildSnapshot(e, req);
	const transfer: Transferable[] = [snap.pins.buffer, snap.subChipIDs.buffer];
	for (const d of snap.displays) transfer.push(d.inputs.buffer, d.internal.buffer);
	if (snap.audio) transfer.push(snap.audio.buffer);
	(self as unknown as Worker).postMessage(snap, transfer);
}

self.onmessage = (e: MessageEvent<FrameRequest | WorkerInit>) => {
	const msg = e.data;
	if (msg.type === "init") {
		init(msg);
		return;
	}
	if (msg.type !== "frame") return;
	if (engine) handleFrame(engine, msg);
	else pending.push(msg);
};

async function init(msg: WorkerInit) {
	if (msg.engine === "rust") {
		try {
			engine = await WasmEngine.create(fetch(wasmUrl), { tables: msg.tables });
		} catch (err) {
			console.error("Failed to load the Rust simulation engine; using the JS engine instead", err);
		}
	}
	if (!engine) engine = new JsEngine();
	console.info(`Simulation engine: ${engine.name}` + (engine.name === "rust" ? ` (truth tables ${msg.tables ? "on" : "off"})` : ""));
	for (const req of pending.splice(0)) handleFrame(engine, req);
	loop();
}

// ---- Stepping loop ----
// Runs in short time slices so that incoming messages are processed regularly.
const channel = new MessageChannel();
channel.port1.onmessage = () => loop();
function scheduleImmediate() {
	channel.port2.postMessage(0);
}

const SliceBudgetMs = 8;

function runSteps(e: SimEngine, n: number) {
	const err = e.step(n);
	if (err) lastError = err;
}

function loop() {
	const e = engine;
	if (!e) return;
	const now = performance.now();

	if (paused) {
		stepDebt = 0;
		lastLoopTime = now;
		let n = 0;
		while (pendingSingleSteps > 0) {
			pendingSingleSteps--;
			pausedSingleStepCounter++;
			runSteps(e, 1);
			n++;
		}
		if (n === 0) e.updatePaused();
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
		const n = Math.min(Math.floor(stepDebt), batchSize);
		const t0 = performance.now();
		runSteps(e, n);
		const dt = performance.now() - t0;
		stepDebt -= n;
		stepsDone += n;
		// Adapt batch size so that a batch takes about BatchTargetMs
		if (n === batchSize) batchSize = dt < BatchTargetMs * 0.5 ? Math.min(batchSize * 2, 1 << 16) : dt > BatchTargetMs * 2 ? Math.max(1, batchSize >> 1) : batchSize;
		if (performance.now() - sliceStart > SliceBudgetMs) break;
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

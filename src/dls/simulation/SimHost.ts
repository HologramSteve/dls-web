// Main-thread side of the simulation.
// Mirrors the static API of the original DLS.Simulation.Simulator that the game code calls (AddSubChip, AddConnection, ...):
// instead of mutating sim objects, each call queues a command that is sent to the simulation worker (like the original's
// ConcurrentQueue, which was drained by the sim thread). SimChip objects on the main thread are lightweight references
// (SimChipRef) identified by their path of subchip IDs from the root sim chip; their state comes from worker snapshots.
import type { ChipDescription, PinAddress } from "../description/Types";
import type { SimChipDesc } from "./SimChip";
import type { SimModifyCommand } from "./Simulator";
import type { DisplayData, FrameRequest, Snapshot } from "./SimProtocol";
import { PinState } from "./PinState";

export function ToSimDesc(desc: ChipDescription): SimChipDesc {
	return {
		Name: desc.Name,
		ChipType: desc.ChipType,
		InputPinIDs: desc.InputPins.map((p) => p.ID),
		OutputPinIDs: desc.OutputPins.map((p) => p.ID),
		SubChips: desc.SubChips.map((s) => ({ Name: s.Name, ID: s.ID, InternalData: s.InternalData ? s.InternalData.slice() : null })),
		Wires: desc.Wires.map((w) => ({ Source: { PinID: w.SourcePinAddress.PinID, PinOwnerID: w.SourcePinAddress.PinOwnerID }, Target: { PinID: w.TargetPinAddress.PinID, PinOwnerID: w.TargetPinAddress.PinOwnerID } })),
	};
}

function pathKey(path: number[]): string {
	return path.join("/");
}

// Pin state view (subset of SimPin used by main-thread drawing code)
export class SimPinView {
	constructor(readonly State: number) {}
	get FirstBitHigh(): boolean {
		return PinState.FirstBitHigh(this.State);
	}
}

// Display data for a sim chip (InputPins / InternalState), as received from the worker
export class SimDisplayData {
	readonly InputPins: SimPinView[];
	readonly InternalState: Uint32Array;
	constructor(data: DisplayData) {
		this.InputPins = Array.from(data.inputs, (s) => new SimPinView(s));
		this.InternalState = data.internal;
	}
}

// Main-thread reference to a chip in the simulation
export class SimChipRef {
	readonly path: number[];
	readonly ID: number;
	readonly key: string;

	constructor(path: number[], id: number) {
		this.path = path;
		this.ID = id;
		this.key = pathKey(path);
	}

	GetSubChipFromID(id: number): SimChipRef {
		return new SimChipRef([...this.path, id], id);
	}

	// Returns null if the subchip is known not to exist in the simulation (e.g. element still being placed)
	TryGetSubChipFromID(id: number): SimChipRef | null {
		if (SimHost.SubChipKnownMissing(this, id)) return null;
		return this.GetSubChipFromID(id);
	}

	// Request display data (input pin states and internal state) for this chip.
	// Returns the most recent data (or null if not yet available). Data is refreshed every frame while requested.
	GetDisplayData(): SimDisplayData | null {
		return SimHost.RequestDisplayData(this);
	}
}

class SimHostImpl {
	private worker: Worker | null = null;
	private cmds: SimModifyCommand[] = [];
	private frameId = 0;
	private outstanding = 0;
	private requestedViewPaths = new Map<number, string>();

	// Latest snapshot data
	latestSnapshot: Snapshot | null = null;
	snapshotIsNew = false;
	private snapshotViewKey = "";
	private subChipIDSet = new Set<number>();
	private displayData = new Map<string, SimDisplayData>();
	private displayRequests = new Map<string, number[]>();

	simAvgTicksPerSec = 0;
	simPausedSingleStepCounter = 0;
	simulationFrame = 0;
	audioAmplitudes: Float64Array | null = null;
	onAudio: ((amplitudes: Float64Array) => void) | null = null;

	// Pending single steps
	private singleSteps = 0;

	Start() {
		if (this.worker) return;
		this.worker = new Worker(new URL("../../worker/simWorker.ts", import.meta.url), { type: "module" });
		this.worker.onmessage = (e: MessageEvent<Snapshot>) => this.OnSnapshot(e.data);
		this.worker.onerror = (e) => console.error("Simulation worker error", e);
	}

	private OnSnapshot(snap: Snapshot) {
		this.outstanding = Math.max(0, this.outstanding - 1);
		const viewKey = this.requestedViewPaths.get(snap.frameId) ?? "";
		this.requestedViewPaths.delete(snap.frameId);
		if (snap.error) console.debug("Sim:", snap.error);

		this.simAvgTicksPerSec = snap.ticksPerSecond;
		this.simPausedSingleStepCounter = snap.pausedSingleStepCounter;
		this.simulationFrame = snap.simulationFrame;
		if (snap.audio) {
			this.audioAmplitudes = snap.audio;
			this.onAudio?.(snap.audio);
		}

		for (const d of snap.displays) this.displayData.set(pathKey(d.path), new SimDisplayData(d));

		if (!snap.viewPathValid) return;
		this.latestSnapshot = snap;
		this.snapshotViewKey = viewKey;
		this.snapshotIsNew = true;
		this.subChipIDSet = new Set(snap.subChipIDs);
	}

	// Snapshot for the given view path (null if latest snapshot was for a different view)
	GetSnapshotFor(view: SimChipRef): Snapshot | null {
		if (!this.latestSnapshot || this.snapshotViewKey !== view.key) return null;
		return this.latestSnapshot;
	}

	SubChipKnownMissing(parent: SimChipRef, id: number): boolean {
		if (!this.latestSnapshot || this.snapshotViewKey !== parent.key) return false;
		return !this.subChipIDSet.has(id);
	}

	RequestDisplayData(chip: SimChipRef): SimDisplayData | null {
		this.displayRequests.set(chip.key, chip.path);
		return this.displayData.get(chip.key) ?? null;
	}

	Enqueue(cmd: SimModifyCommand) {
		this.cmds.push(cmd);
	}

	RequestSingleStep() {
		this.singleSteps++;
	}

	// Send queued commands + current inputs to the worker, requesting a new snapshot
	SendFrame(params: { inputs: Int32Array; keys: string; view: SimChipRef; paused: boolean; targetTicksPerSecond: number; stepsPerClockTransition: number }) {
		if (!this.worker) return;
		if (this.outstanding > 2 && this.cmds.length === 0 && this.singleSteps === 0) return; // worker is busy; don't flood it

		const displayPaths = Array.from(this.displayRequests.values());
		// Forget display data that is no longer being requested
		for (const k of Array.from(this.displayData.keys())) if (!this.displayRequests.has(k)) this.displayData.delete(k);
		this.displayRequests.clear();

		const req: FrameRequest = {
			type: "frame",
			frameId: ++this.frameId,
			cmds: this.cmds,
			inputs: params.inputs,
			keys: params.keys,
			viewPath: params.view.path,
			displayPaths,
			paused: params.paused,
			singleSteps: this.singleSteps,
			targetTicksPerSecond: params.targetTicksPerSecond,
			stepsPerClockTransition: params.stepsPerClockTransition,
		};
		this.requestedViewPaths.set(req.frameId, params.view.key);
		this.cmds = [];
		this.singleSteps = 0;
		this.outstanding++;
		this.worker.postMessage(req);
	}

	ResetViewState() {
		this.latestSnapshot = null;
		this.snapshotViewKey = "";
		this.displayData.clear();
	}
}

export const SimHost = new SimHostImpl();

// ---- Static API mirroring DLS.Simulation.Simulator (main-thread side) ----
export const Simulator = {
	// Build the root simulation chip from a description (replaces the existing root)
	BuildSimChip(desc: ChipDescription): SimChipRef {
		SimHost.Enqueue({ type: "BuildRoot", desc: ToSimDesc(desc) });
		SimHost.ResetViewState();
		return new SimChipRef([], -1);
	},

	CreateEmptyRoot(): SimChipRef {
		SimHost.Enqueue({ type: "BuildRoot", desc: { Name: "", ChipType: 0, InputPinIDs: [], OutputPinIDs: [], SubChips: [], Wires: [] } });
		SimHost.ResetViewState();
		return new SimChipRef([], -1);
	},

	AddPin(simChip: SimChipRef, pinID: number, isInputPin: boolean) {
		SimHost.Enqueue({ type: "AddPin", target: simChip.path, pinID, isInput: isInputPin });
	},

	RemovePin(simChip: SimChipRef, pinID: number) {
		SimHost.Enqueue({ type: "RemovePin", target: simChip.path, pinID });
	},

	AddSubChip(simChip: SimChipRef, desc: ChipDescription, subChipID: number, subChipInternalData: number[] | null) {
		SimHost.Enqueue({ type: "AddSubchip", target: simChip.path, chipName: desc.Name, subChipID, internalData: subChipInternalData ? subChipInternalData.slice() : null });
	},

	AddConnection(simChip: SimChipRef, source: PinAddress, target: PinAddress) {
		SimHost.Enqueue({ type: "AddConnection", target: simChip.path, source: { ...source }, dest: { ...target } });
	},

	RemoveConnection(simChip: SimChipRef, source: PinAddress, target: PinAddress) {
		SimHost.Enqueue({ type: "RemoveConnection", target: simChip.path, source: { ...source }, dest: { ...target } });
	},

	RemoveSubChip(simChip: SimChipRef, id: number) {
		SimHost.Enqueue({ type: "RemoveSubChip", target: simChip.path, id });
	},

	SetInternalState(simChip: SimChipRef, index: number, value: number) {
		SimHost.Enqueue({ type: "SetInternalState", target: simChip.path, index, value });
	},

	UpdateInternalState(simChip: SimChipRef, data: number[]) {
		SimHost.Enqueue({ type: "UpdateInternalState", target: simChip.path, data: data.slice() });
	},

	SyncLibrary(descs: ChipDescription[]) {
		SimHost.Enqueue({ type: "LibrarySet", descs: descs.map(ToSimDesc), replaceAll: true });
	},
};

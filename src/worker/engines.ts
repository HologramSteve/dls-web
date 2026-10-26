// Simulation engines used by the worker (web-only addition, see docs/HANDOFF.md):
// - JsEngine: the TypeScript port of the original simulator (src/dls/simulation/Simulator.ts)
// - WasmEngine: the Rust engine (rust/dls-sim) compiled to WebAssembly. Same semantics; much faster
//   (compiled flat program + exact truth tables for combinational chips). Default.
import type { SimChip } from "../dls/simulation/SimChip";
import type { DisplayData } from "../dls/simulation/SimProtocol";
import { type SimModifyCommand, Simulator } from "../dls/simulation/Simulator";

export interface ViewSnapshot {
	pins: Int32Array;
	viewChipID: number;
	subChipIDs: Int32Array;
	valid: boolean;
}

export interface SimEngine {
	readonly name: "js" | "rust";
	/** Apply modification commands; returns the last error message (or null) */
	applyCommands(cmds: SimModifyCommand[]): string | null;
	setInputs(inputs: Int32Array): void;
	setKeys(keys: string): void;
	setStepsPerClockTransition(n: number): void;
	setViewPath(path: number[]): void;
	/** Run n simulation steps; returns an error message if a step failed */
	step(n: number): string | null;
	updatePaused(): void;
	readonly simulationFrame: number;
	snapshotView(path: number[]): ViewSnapshot;
	display(path: number[]): DisplayData | null;
	/** Audio amplitudes if they changed since the last call */
	audio(): Float64Array | null;
}

const EmptySnapshot: ViewSnapshot = { pins: new Int32Array(0), viewChipID: -1, subChipIDs: new Int32Array(0), valid: false };

// ---------------------------------------------------------------------------------------------------- JS

export class JsEngine implements SimEngine {
	readonly name = "js";
	private inputs = new Int32Array(0);

	constructor() {
		Simulator.Reset();
	}

	applyCommands(cmds: SimModifyCommand[]): string | null {
		let err: string | null = null;
		for (const cmd of cmds) {
			try {
				Simulator.ApplyModification(cmd);
			} catch (e) {
				// Possible for main thread and sim to be temporarily out of sync, so just ignore failures
				err = String(e);
			}
		}
		return err;
	}

	setInputs(inputs: Int32Array) {
		this.inputs = inputs;
	}
	setKeys(keys: string) {
		Simulator.heldKeys = new Set(keys);
	}
	setStepsPerClockTransition(n: number) {
		Simulator.stepsPerClockTransition = n;
	}
	setViewPath(_path: number[]) {}

	step(n: number): string | null {
		let err: string | null = null;
		for (let i = 0; i < n; i++) {
			try {
				Simulator.RunSimulationStep(Simulator.rootSimChip, this.inputs);
			} catch (e) {
				err = String(e);
				Simulator.needsOrderPass = true;
			}
		}
		return err;
	}

	updatePaused() {
		Simulator.UpdateInPausedState();
	}

	get simulationFrame() {
		return Simulator.simulationFrame;
	}

	private resolve(path: number[]): SimChip | null {
		let chip: SimChip | null = Simulator.rootSimChip;
		for (const id of path) {
			chip = chip.TryGetSubChipFromID(id);
			if (!chip) return null;
		}
		return chip;
	}

	snapshotView(path: number[]): ViewSnapshot {
		const view = this.resolve(path);
		if (!view) return EmptySnapshot;
		let count = view.InputPins.length + view.OutputPins.length;
		for (const s of view.SubChips) count += s.InputPins.length + s.OutputPins.length;
		const pins = new Int32Array(count * 5);
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
		const subChipIDs = new Int32Array(view.SubChips.length);
		for (let i = 0; i < view.SubChips.length; i++) {
			const s = view.SubChips[i];
			subChipIDs[i] = s.ID;
			for (const p of s.InputPins) write(s.ID, p.ID, p.State, p.latestSourceID, p.latestSourceParentChipID);
			for (const p of s.OutputPins) write(s.ID, p.ID, p.State, p.latestSourceID, p.latestSourceParentChipID);
		}
		return { pins, viewChipID: view.ID, subChipIDs, valid: true };
	}

	display(path: number[]): DisplayData | null {
		const chip = this.resolve(path);
		if (!chip) return null;
		const ins = new Int32Array(chip.InputPins.length);
		for (let i = 0; i < ins.length; i++) ins[i] = chip.InputPins[i].State;
		return { path, inputs: ins, internal: chip.InternalState.slice() };
	}

	audio(): Float64Array | null {
		if (!Simulator.audioState.dirty) return null;
		Simulator.audioState.dirty = false;
		return Simulator.audioState.targetAmplitudesPerFreq.slice();
	}
}

// ---------------------------------------------------------------------------------------------------- Rust / WebAssembly

interface DlsSimExports {
	memory: WebAssembly.Memory;
	dls_alloc(len: number): number;
	dls_free(ptr: number, len: number): void;
	dls_init(seedLo: number, seedHi: number, nowMs: number): void;
	dls_apply_commands(ptr: number, len: number): number;
	dls_error_ptr(): number;
	dls_error_len(): number;
	dls_set_inputs(ptr: number, nPairs: number): void;
	dls_set_keys(ptr: number, n: number): void;
	dls_set_steps_per_clock(n: number): void;
	dls_set_options(fastPath: number, tables: number): void;
	dls_set_view(ptr: number, n: number): void;
	dls_run(steps: number, nowMs: number): void;
	dls_update_paused(nowMs: number): void;
	dls_frame(): number;
	dls_out_ptr(): number;
	dls_snapshot_view(ptr: number, n: number): number;
	dls_display(ptr: number, n: number): number;
	dls_audio_dirty(): number;
	dls_audio_ptr(): number;
	dls_stats(): number;
}

export interface WasmEngineOptions {
	tables?: boolean;
	fastPath?: boolean;
	now?: () => number;
	seed?: number;
}

export class WasmEngine implements SimEngine {
	readonly name = "rust";
	private readonly ex: DlsSimExports;
	private readonly now: () => number;
	private scratchPtr = 0;
	private scratchLen = 0;
	private viewKey = "";

	private constructor(instance: WebAssembly.Instance, opts: WasmEngineOptions) {
		this.ex = instance.exports as unknown as DlsSimExports;
		this.now = opts.now ?? (() => performance.now());
		const seed = opts.seed ?? Math.floor(Math.random() * 0xffffffff);
		this.ex.dls_init(seed >>> 0, Math.floor(Math.random() * 0xffffffff) >>> 0, this.now());
		this.ex.dls_set_options(opts.fastPath === false ? 0 : 1, opts.tables === false ? 0 : 1);
	}

	static async create(wasm: BufferSource | Response | Promise<Response>, opts: WasmEngineOptions = {}): Promise<WasmEngine> {
		let instance: WebAssembly.Instance;
		if (wasm instanceof Response || wasm instanceof Promise) {
			const res = await wasm;
			instance = (await WebAssembly.instantiate(await res.arrayBuffer(), {})).instance;
		} else {
			instance = (await WebAssembly.instantiate(wasm, {})).instance;
		}
		return new WasmEngine(instance, opts);
	}

	/** Copy bytes into a reusable scratch buffer in wasm memory; returns its pointer */
	private scratch(bytes: Uint8Array): number {
		if (bytes.length > this.scratchLen) {
			if (this.scratchPtr) this.ex.dls_free(this.scratchPtr, this.scratchLen);
			this.scratchLen = Math.max(bytes.length, this.scratchLen * 2, 1024);
			this.scratchPtr = this.ex.dls_alloc(this.scratchLen);
		}
		new Uint8Array(this.ex.memory.buffer, this.scratchPtr, bytes.length).set(bytes);
		return this.scratchPtr;
	}

	private ints(values: ArrayLike<number>): [number, number] {
		const arr = Int32Array.from(values);
		return [this.scratch(new Uint8Array(arr.buffer)), arr.length];
	}

	private out(len: number): Int32Array {
		return new Int32Array(this.ex.memory.buffer, this.ex.dls_out_ptr(), len).slice();
	}

	applyCommands(cmds: SimModifyCommand[]): string | null {
		if (cmds.length === 0) return null;
		const bytes = new TextEncoder().encode(JSON.stringify(cmds));
		const ptr = this.scratch(bytes);
		const failed = this.ex.dls_apply_commands(ptr, bytes.length);
		if (failed === 0) return null;
		return new TextDecoder().decode(new Uint8Array(this.ex.memory.buffer, this.ex.dls_error_ptr(), this.ex.dls_error_len()).slice());
	}

	setInputs(inputs: Int32Array) {
		const ptr = this.scratch(new Uint8Array(inputs.buffer, inputs.byteOffset, inputs.byteLength));
		this.ex.dls_set_inputs(ptr, inputs.length >> 1);
	}

	setKeys(keys: string) {
		const [ptr, n] = this.ints(Array.from(keys, (c) => c.codePointAt(0) ?? 0));
		this.ex.dls_set_keys(ptr, n);
	}

	setStepsPerClockTransition(n: number) {
		this.ex.dls_set_steps_per_clock(n >>> 0);
	}

	setViewPath(path: number[]) {
		const key = path.join("/");
		if (key === this.viewKey) return;
		this.viewKey = key;
		const [ptr, n] = this.ints(path);
		this.ex.dls_set_view(ptr, n);
	}

	step(n: number): string | null {
		this.ex.dls_run(n, this.now());
		return null;
	}

	updatePaused() {
		this.ex.dls_update_paused(this.now());
	}

	get simulationFrame() {
		return this.ex.dls_frame();
	}

	snapshotView(path: number[]): ViewSnapshot {
		const [ptr, n] = this.ints(path);
		const len = this.ex.dls_snapshot_view(ptr, n);
		if (len < 0) return EmptySnapshot;
		const data = this.out(len);
		const numSub = data[1];
		return { viewChipID: data[0], subChipIDs: data.slice(2, 2 + numSub), pins: data.slice(2 + numSub), valid: true };
	}

	display(path: number[]): DisplayData | null {
		const [ptr, n] = this.ints(path);
		const len = this.ex.dls_display(ptr, n);
		if (len < 0) return null;
		const data = this.out(len);
		const numInputs = data[0];
		return { path, inputs: data.slice(1, 1 + numInputs), internal: new Uint32Array(data.buffer.slice((1 + numInputs) * 4)) };
	}

	audio(): Float64Array | null {
		if (!this.ex.dls_audio_dirty()) return null;
		return new Float64Array(this.ex.memory.buffer, this.ex.dls_audio_ptr(), 256).slice();
	}

	/** [tabled chip instances, number of tables, table bytes, program ops] */
	stats(): number[] {
		return Array.from(new Int32Array(this.ex.memory.buffer, this.ex.dls_stats(), 4));
	}
}

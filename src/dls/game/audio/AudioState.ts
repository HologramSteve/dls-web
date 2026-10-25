// Port of AudioState / AudioUnity: owns the WebAudio output. Simulated amplitudes arrive from the sim worker
// (via SimHost.onAudio) and are forwarded to an AudioWorklet which synthesizes the square waves.
import workletUrl from "./AudioWorkletProcessor.ts?worker&url";

export class AudioState {
	private ctx: AudioContext | null = null;
	private node: AudioWorkletNode | null = null;
	private starting = false;
	private pending: Float64Array | null = null;

	// Browsers only allow audio to start after a user gesture
	AttachUnlockListeners(target: EventTarget) {
		const unlock = () => {
			void this.Start();
		};
		for (const type of ["pointerdown", "keydown"]) target.addEventListener(type, unlock);
	}

	async Start() {
		if (this.ctx) {
			if (this.ctx.state === "suspended") await this.ctx.resume();
			return;
		}
		if (this.starting || typeof AudioContext === "undefined") return;
		this.starting = true;
		try {
			const ctx = new AudioContext();
			await ctx.audioWorklet.addModule(workletUrl);
			const node = new AudioWorkletNode(ctx, "dls-audio", { numberOfInputs: 0, outputChannelCount: [2] });
			node.connect(ctx.destination);
			this.ctx = ctx;
			this.node = node;
			if (this.pending) this.SetAmplitudes(this.pending);
		} catch (e) {
			console.warn("Audio unavailable", e);
		} finally {
			this.starting = false;
		}
	}

	SetAmplitudes(amplitudes: Float64Array) {
		if (!this.node) {
			this.pending = amplitudes;
			return;
		}
		this.node.port.postMessage(amplitudes);
	}
}

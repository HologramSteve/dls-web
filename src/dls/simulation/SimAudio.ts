// Port of DLS.Simulation.SimAudio (runs in the simulation worker)
import { Maths } from "../../seb/helpers/Maths";

export class SimAudio {
	static readonly freqCount = 256;

	readonly freqsAll = new Float32Array(SimAudio.freqCount);
	private readonly targetAmplitudesPerFreq_temp = new Float64Array(SimAudio.freqCount);
	readonly targetAmplitudesPerFreq = new Float64Array(SimAudio.freqCount);
	// Very crude correction factors to make different frequencies sound more equal in volume
	private readonly perceptualGainCorrection = new Float32Array(SimAudio.freqCount);

	private hasInputSinceLastInit = false;
	private isSmoothing = false;
	// True if amplitudes changed since last read by the main thread
	dirty = false;

	constructor() {
		for (let i = 0; i < this.freqsAll.length; i++) {
			this.freqsAll[i] = SimAudio.CalculateFrequency(i / 3.0);
			const freqT = i / 255;
			this.perceptualGainCorrection[i] = Maths.Lerp(2, 0.35, Maths.EaseQuadInOut(freqT));
		}
	}

	InitFrame() {
		if (!this.hasInputSinceLastInit) return;
		this.hasInputSinceLastInit = false;
		this.targetAmplitudesPerFreq_temp.fill(0);
	}

	RegisterNote(index: number, volume: number) {
		if (volume === 0) return;
		this.hasInputSinceLastInit = true;
		const amplitudeT = Math.min(volume / 15, 1);
		this.targetAmplitudesPerFreq_temp[index] += amplitudeT * this.perceptualGainCorrection[index];
	}

	NotifyAllNotesRegistered(deltaTime: number) {
		if (!this.hasInputSinceLastInit && !this.isSmoothing) return;

		const smoothSpeed = 30;
		const step = Math.min(1, deltaTime * smoothSpeed);
		this.isSmoothing = false;

		for (let i = 0; i < this.targetAmplitudesPerFreq.length; i++) {
			const curr = this.targetAmplitudesPerFreq[i];
			const target = this.targetAmplitudesPerFreq_temp[i];
			const delta = target - curr;
			let valNew = curr + delta * step;
			const error = Math.abs(valNew - target);
			if (error <= 0.0001) valNew = target;
			if (valNew !== curr) this.dirty = true;
			this.targetAmplitudesPerFreq[i] = valNew;
			this.isSmoothing ||= valNew > 0;
		}
	}

	static CalculateFrequency(numAboveA0: number): number {
		const A0Frequency = 27.5;
		return A0Frequency * Math.pow(1.059463094359, numAboveA0);
	}
}

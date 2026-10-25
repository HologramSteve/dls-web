// Port of AudioState.Sample + AudioUnity.OnAudioFilterRead, running as an AudioWorkletProcessor.
// Receives target amplitudes per frequency (Float64Array, 256 entries) from the main thread.

declare const sampleRate: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor {
	readonly port: MessagePort;
}

const freqCount = 256;
const waveIterations = 20;
const gain = 0.05;
const clipThreshold = 0.1;

function CalculateFrequency(numAboveA0: number): number {
	const A0Frequency = 27.5;
	return Math.fround(A0Frequency * Math.pow(1.059463094359, numAboveA0));
}

function SquareWave(t: number, numIterations = 20): number {
	let sum = 0;
	for (let i = 1; i <= numIterations; i++) {
		const n = 2 * i - 1;
		sum += Math.sin(n * t) / n;
	}
	return (sum * 4) / Math.PI;
}

class DLSAudioProcessor extends AudioWorkletProcessor {
	private readonly freqsAll = new Float64Array(freqCount);
	private amplitudes = new Float64Array(freqCount);
	private activeIndices: number[] = [];
	private audioTime = 0;

	constructor() {
		super();
		for (let i = 0; i < freqCount; i++) this.freqsAll[i] = CalculateFrequency(i / 3.0);
		this.port.onmessage = (e: MessageEvent<Float64Array>) => {
			this.amplitudes = e.data;
			this.activeIndices = [];
			for (let i = 0; i < freqCount; i++) if (Math.fround(this.amplitudes[i]) >= 0.001) this.activeIndices.push(i);
		};
	}

	Sample(time: number): number {
		let sum = 0;
		for (const i of this.activeIndices) {
			const phase = time * 2 * Math.PI * this.freqsAll[i];
			sum += SquareWave(phase, waveIterations) * this.amplitudes[i];
		}
		return sum;
	}

	process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
		const out = outputs[0];
		const left = out[0];
		const audioDeltaTime = 1.0 / sampleRate;
		for (let i = 0; i < left.length; i++) {
			const sampleRaw = gain * this.Sample(this.audioTime);
			// Clip
			let sample = sampleRaw;
			if (Math.abs(sampleRaw) > clipThreshold) sample = clipThreshold * Math.sign(sampleRaw);
			left[i] = sample;
			this.audioTime += audioDeltaTime;
		}
		// Copy data to other channels (if stereo)
		for (let c = 1; c < out.length; c++) out[c].set(left);
		return true;
	}
}

registerProcessor("dls-audio", DLSAudioProcessor);

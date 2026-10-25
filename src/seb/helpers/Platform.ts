// Stand-ins for UnityEngine.Time / Screen / Application.
export const Time = {
	frameCount: 0,
	time: 0, // seconds since startup (at start of current frame)
	deltaTime: 0,
	startMs: performance.now(),

	// Called once at the start of every frame
	BeginFrame(nowMs: number) {
		const t = (nowMs - Time.startMs) / 1000;
		Time.deltaTime = Time.frameCount === 0 ? 0 : Math.min(0.25, t - Time.time);
		Time.time = t;
		Time.frameCount++;
	},
};

export const Screen = {
	// Size of the drawing surface in device pixels
	width: 1,
	height: 1,
	devicePixelRatio: 1,
};

export const Application = {
	isPlaying: true,
	isEditor: false,
};

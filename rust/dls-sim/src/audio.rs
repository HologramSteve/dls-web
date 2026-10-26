//! Port of DLS.Simulation.SimAudio

pub const FREQ_COUNT: usize = 256;

pub struct SimAudio {
	temp: [f64; FREQ_COUNT],
	pub target: [f64; FREQ_COUNT],
	gain: [f32; FREQ_COUNT],
	has_input_since_last_init: bool,
	is_smoothing: bool,
	/// True if amplitudes changed since last read
	pub dirty: bool,
}

fn lerp(a: f32, b: f32, t: f32) -> f32 {
	a + (b - a) * t
}

fn ease_quad_in_out(t: f32) -> f32 {
	let c = t.clamp(0.0, 1.0);
	3.0 * c * c - 2.0 * c * c * c
}

impl Default for SimAudio {
	fn default() -> Self {
		let mut gain = [0f32; FREQ_COUNT];
		for (i, g) in gain.iter_mut().enumerate() {
			*g = lerp(2.0, 0.35, ease_quad_in_out(i as f32 / 255.0));
		}
		SimAudio { temp: [0.0; FREQ_COUNT], target: [0.0; FREQ_COUNT], gain, has_input_since_last_init: false, is_smoothing: false, dirty: false }
	}
}

impl SimAudio {
	pub fn init_frame(&mut self) {
		if !self.has_input_since_last_init {
			return;
		}
		self.has_input_since_last_init = false;
		self.temp = [0.0; FREQ_COUNT];
	}

	pub fn register_note(&mut self, index: usize, volume: u32) {
		if volume == 0 || index >= FREQ_COUNT {
			return;
		}
		self.has_input_since_last_init = true;
		let amplitude_t = (volume as f64 / 15.0).min(1.0);
		self.temp[index] += amplitude_t * self.gain[index] as f64;
	}

	pub fn notify_all_notes_registered(&mut self, delta_time: f64) {
		if !self.has_input_since_last_init && !self.is_smoothing {
			return;
		}
		let smooth_speed = 30.0;
		let step = (delta_time * smooth_speed).min(1.0);
		self.is_smoothing = false;
		for i in 0..FREQ_COUNT {
			let curr = self.target[i];
			let target = self.temp[i];
			let mut val_new = curr + (target - curr) * step;
			if (val_new - target).abs() <= 0.0001 {
				val_new = target;
			}
			if val_new != curr {
				self.dirty = true;
			}
			self.target[i] = val_new;
			self.is_smoothing |= val_new > 0.0;
		}
	}
}

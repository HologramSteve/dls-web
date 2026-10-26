//! Random number sources used by the simulator.
//! `Pcg` is the original's per-frame PCG hash (Simulator.RandomBool); `XorShift` replaces System.Random / Math.random.

/// xorshift64* generator (replacement for System.Random / Math.random)
#[derive(Clone)]
pub struct XorShift(u64);

impl XorShift {
	pub fn new(seed: u64) -> Self {
		XorShift(if seed == 0 { 0x9E37_79B9_7F4A_7C15 } else { seed })
	}

	pub fn next_u64(&mut self) -> u64 {
		let mut x = self.0;
		x ^= x >> 12;
		x ^= x << 25;
		x ^= x >> 27;
		self.0 = x;
		x.wrapping_mul(0x2545_F491_4F6C_DD1D)
	}

	pub fn next_u32(&mut self) -> u32 {
		(self.next_u64() >> 32) as u32
	}

	/// Uniform integer in [0, n)
	pub fn below(&mut self, n: usize) -> usize {
		((self.next_u64() >> 11) as f64 / (1u64 << 53) as f64 * n as f64) as usize
	}
}

/// Port of Simulator.RandomBool (PCG hash, state reseeded every frame)
#[inline]
pub fn random_bool(state: &mut u32) -> bool {
	*state = state.wrapping_mul(747796405).wrapping_add(2891336453);
	let s = *state;
	let mut result = ((s >> ((s >> 28) + 4)) ^ s).wrapping_mul(277803737);
	result = (result >> 22) ^ result;
	result < u32::MAX / 2
}

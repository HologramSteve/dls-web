//! Simulation engine: a port of DLS.Simulation (Simulator / SimChip / SimPin) with identical semantics.
//!
//! Chips and pins live in flat arenas (indices instead of object references). The hierarchical step functions
//! (`step_chip`, `step_chip_reorder`) are line-by-line ports of Simulator.StepChip / StepChipReorder and are used
//! for the order pass and for the "dynamic reorder" frames (every 100th frame). All other frames run the compiled
//! flat program (see program.rs), which performs exactly the same operations in the same order.
use crate::audio::SimAudio;
use crate::desc::{Command, FSet, Library, PinAddress, SimChipDesc};
use crate::program::Program;
use crate::rng::{random_bool, XorShift};
use crate::tables::TableCache;
use std::rc::Rc;

pub const NONE: u32 = u32::MAX;

/// ChipType values (must match the TS/C# enum)
pub mod ct {
	pub const CUSTOM: u8 = 0;
	pub const NAND: u8 = 1;
	pub const TRI_STATE_BUFFER: u8 = 2;
	pub const CLOCK: u8 = 3;
	pub const PULSE: u8 = 4;
	pub const DEV_RAM_8BIT: u8 = 5;
	pub const ROM_256X16: u8 = 6;
	pub const SEVEN_SEGMENT: u8 = 7;
	pub const DISPLAY_RGB: u8 = 8;
	pub const DISPLAY_DOT: u8 = 9;
	pub const DISPLAY_LED: u8 = 10;
	pub const MERGE_1TO4: u8 = 11;
	pub const MERGE_1TO8: u8 = 12;
	pub const MERGE_4TO8: u8 = 13;
	pub const SPLIT_4TO1: u8 = 14;
	pub const SPLIT_8TO4: u8 = 15;
	pub const SPLIT_8TO1: u8 = 16;
	pub const KEY: u8 = 23;
	pub const BUS_1: u8 = 24;
	pub const BUS_4: u8 = 26;
	pub const BUS_8: u8 = 28;
	pub const BUZZER: u8 = 30;

	pub fn is_bus_origin(t: u8) -> bool {
		t == BUS_1 || t == BUS_4 || t == BUS_8
	}
}

pub mod pin_state {
	pub const LOGIC_LOW: u32 = 0;
	pub const LOGIC_HIGH: u32 = 1;
	pub const SINGLE_BIT_MASK: u32 = 1 | (1 << 16);
	pub const ALL_DISCONNECTED: u32 = 0xffff << 16;

	#[inline]
	pub fn get4_from8(source: u32, first_nibble: bool) -> u32 {
		let bits = source & 0xffff;
		let tri = (source >> 16) & 0xffff;
		if first_nibble {
			(bits & 0b1111) | ((tri & 0b1111) << 16)
		} else {
			((bits & 0b1111_0000) >> 4) | (((tri & 0b1111_0000) >> 4) << 16)
		}
	}

	#[inline]
	pub fn get8_from4(a: u32, b: u32) -> u32 {
		let bits = ((a & 0xffff) | ((b & 0xffff) << 4)) & 0xffff;
		let tri = (((a >> 16) & 0b1111) | (((b >> 16) & 0b1111) << 4)) & 0xffff;
		bits | (tri << 16)
	}
}
use pin_state::*;

pub struct ChipInst {
	pub chip_type: u8,
	pub id: i32,
	pub parent: u32,
	pub inputs: Vec<u32>,
	pub outputs: Vec<u32>,
	/// Sorted in reverse order of visitation (as in the original)
	pub subchips: Vec<u32>,
	pub num_connected_inputs: u32,
	pub internal: Vec<u32>,
	/// Name of the description this instance was built from
	pub name: Rc<str>,
	/// Structural hash of the description this instance was built from (0 = modified since / unknown)
	pub desc_hash: u64,
}

pub struct PinInst {
	pub id: i32,
	pub parent: u32,
	pub is_input: bool,
	pub targets: Vec<u32>,
	pub num_input_connections: u32,
}

/// Per-pin hot simulation state (struct-of-arrays)
#[derive(Default)]
pub struct Hot {
	pub state: Vec<u32>,
	pub last_frame: Vec<u32>,
	pub recv: Vec<u32>,
	pub latest_id: Vec<i32>,
	pub latest_parent: Vec<i32>,
	/// Per chip: numInputsReady
	pub ready: Vec<u32>,
}

/// Per-step context needed by builtin chips
pub struct Ctx {
	pub frame: u32,
	pub pcg: u32,
	pub steps_per_clock: u32,
	pub held_keys: FSet<u32>,
	pub audio: SimAudio,
}

pub struct Engine {
	pub lib: Rc<Library>,
	pub chips: Vec<ChipInst>,
	pub pins: Vec<PinInst>,
	pub hot: Hot,
	pub ctx: Ctx,
	pub rng: XorShift,
	pub root: u32,
	pub needs_order_pass: bool,
	pub inputs: Vec<(i32, u32)>,
	// Audio timing (UpdateAudioState)
	start_time_ms: f64,
	elapsed_seconds_old: f64,
	// Fast path
	pub program: Program,
	pub program_dirty: bool,
	pub view_path: Vec<i32>,
	pub use_fast_path: bool,
	pub use_tables: bool,
	pub tables: TableCache,
	swaps: Vec<(u32, u32)>,
	/// The previous frame ran the compiled program (ready counters must be restored before a hierarchical frame)
	last_frame_fast: bool,
	/// Aliased pins (see Program::optimize) have not been written since the program last ran
	state_stale: bool,
	/// Statistics: number of dynamic-reorder swaps patched into the program / full recompiles
	pub stat_swaps: u64,
	pub stat_compiles: u64,
}

#[derive(Debug)]
pub struct SimError(pub String);

impl Engine {
	pub fn new(seed: u64) -> Engine {
		let mut e = Engine {
			lib: Rc::new(Library::default()),
			chips: Vec::new(),
			pins: Vec::new(),
			hot: Hot::default(),
			ctx: Ctx { frame: 0, pcg: 0, steps_per_clock: 0, held_keys: FSet::default(), audio: SimAudio::default() },
			rng: XorShift::new(seed),
			root: 0,
			needs_order_pass: true,
			inputs: Vec::new(),
			start_time_ms: 0.0,
			elapsed_seconds_old: 0.0,
			program: Program::default(),
			program_dirty: true,
			view_path: Vec::new(),
			use_fast_path: true,
			use_tables: true,
			tables: TableCache::default(),
			swaps: Vec::new(),
			last_frame_fast: false,
			state_stale: false,
			stat_swaps: 0,
			stat_compiles: 0,
		};
		e.reset_arena();
		e
	}

	pub fn frame(&self) -> u32 {
		self.ctx.frame
	}

	/// Simulator.Reset
	pub fn reset_time(&mut self, now_ms: f64) {
		self.ctx.frame = 0;
		self.start_time_ms = now_ms;
		self.elapsed_seconds_old = 0.0;
	}

	fn reset_arena(&mut self) {
		self.chips.clear();
		self.pins.clear();
		self.hot = Hot::default();
		// Default root: empty custom chip with ID -1 (new SimChip(null, -1, null, []))
		self.root = self.new_chip(ct::CUSTOM, -1, NONE, Rc::from(""), 0);
		self.program_dirty = true;
	}

	fn new_chip(&mut self, chip_type: u8, id: i32, parent: u32, name: Rc<str>, desc_hash: u64) -> u32 {
		let idx = self.chips.len() as u32;
		self.chips.push(ChipInst { chip_type, id, parent, inputs: Vec::new(), outputs: Vec::new(), subchips: Vec::new(), num_connected_inputs: 0, internal: Vec::new(), name, desc_hash });
		self.hot.ready.push(0);
		idx
	}

	fn new_pin(&mut self, id: i32, is_input: bool, parent: u32) -> u32 {
		let idx = self.pins.len() as u32;
		self.pins.push(PinInst { id, parent, is_input, targets: Vec::new(), num_input_connections: 0 });
		let h = &mut self.hot;
		h.state.push(ALL_DISCONNECTED);
		h.last_frame.push(0);
		h.recv.push(0);
		h.latest_id.push(-1);
		h.latest_parent.push(-1);
		idx
	}

	// ---------------------------------------------------------------- Building

	/// BuildSimChipRecursive
	pub fn build_chip(&mut self, desc: &SimChipDesc, sub_chip_id: i32, internal: Option<&[u32]>, parent: u32) -> Result<u32, SimError> {
		let hash = self.lib.desc_hash(&desc.name);
		let c = self.new_chip(desc.chip_type, sub_chip_id, parent, Rc::from(desc.name.as_str()), hash);

		let mut subchips = Vec::with_capacity(desc.sub_chips.len());
		for s in &desc.sub_chips {
			let sub_desc = self.lib.get(&s.name).ok_or_else(|| SimError(format!("Chip not found in sim library: {}", s.name)))?;
			subchips.push(self.build_chip(&sub_desc, s.id as i32, s.internal_data.as_deref(), c)?);
		}
		self.chips[c as usize].subchips = subchips;

		// ---- Create pins ----
		let ins: Vec<u32> = desc.input_ids.iter().map(|&id| self.new_pin(id as i32, true, c)).collect();
		let outs: Vec<u32> = desc.output_ids.iter().map(|&id| self.new_pin(id as i32, false, c)).collect();
		self.chips[c as usize].inputs = ins;
		self.chips[c as usize].outputs = outs;

		// ---- Initialize internal state ----
		let chip = &mut self.chips[c as usize];
		if chip.chip_type == ct::DISPLAY_RGB || chip.chip_type == ct::DISPLAY_DOT {
			// first 256 = display buffer, next 256 = back buffer, last = clock state
			chip.internal = vec![0; 256 * 2 + 1];
		} else if chip.chip_type == ct::DEV_RAM_8BIT {
			let mut v = vec![0u32; 257];
			for x in v.iter_mut().take(256) {
				*x = self.rng.next_u32();
			}
			chip.internal = v;
		} else if let Some(data) = internal {
			if !data.is_empty() {
				chip.internal = data.to_vec();
			}
		}

		// ---- Wires (lookup table instead of the linear search used in the original; same result) ----
		if !desc.wires.is_empty() {
			let mut by_id: crate::desc::FMap<i32, Vec<u32>> = crate::desc::FMap::default();
			for &s in &self.chips[c as usize].subchips {
				by_id.entry(self.chips[s as usize].id).or_default().push(s);
			}
			for w in &desc.wires {
				self.add_connection_with(c, &w.source, &w.target, Some(&by_id));
			}
		}
		Ok(c)
	}

	// ---------------------------------------------------------------- Pin lookup / connections

	/// GetSimPinFromAddressWithChip: returns (pin, owning subchip or NONE for dev pins of this chip)
	fn find_pin(&self, c: u32, addr: &PinAddress, by_id: Option<&crate::desc::FMap<i32, Vec<u32>>>) -> Option<(u32, u32)> {
		let owner = addr.owner_id as i32;
		let pin_id = addr.pin_id as i32;
		let check = |s: u32| -> Option<(u32, u32)> {
			let sc = &self.chips[s as usize];
			if sc.id != owner {
				return None;
			}
			for &p in sc.inputs.iter().chain(sc.outputs.iter()) {
				if self.pins[p as usize].id == pin_id {
					return Some((p, s));
				}
			}
			None
		};
		if let Some(map) = by_id {
			if let Some(list) = map.get(&owner) {
				for &s in list {
					if let Some(r) = check(s) {
						return Some(r);
					}
				}
			}
		} else {
			for &s in &self.chips[c as usize].subchips {
				if let Some(r) = check(s) {
					return Some(r);
				}
			}
		}
		let ch = &self.chips[c as usize];
		for &p in ch.inputs.iter().chain(ch.outputs.iter()) {
			if self.pins[p as usize].id == owner {
				return Some((p, NONE));
			}
		}
		None
	}

	fn add_connection_with(&mut self, c: u32, source: &PinAddress, target: &PinAddress, by_id: Option<&crate::desc::FMap<i32, Vec<u32>>>) {
		// Can fail to find pin if player has edited an existing chip to remove the pin (failure is ignored, as in the original)
		let Some((src, _)) = self.find_pin(c, source, by_id) else { return };
		let Some((dst, dst_chip)) = self.find_pin(c, target, by_id) else { return };
		self.pins[src as usize].targets.push(dst);
		let p = &mut self.pins[dst as usize];
		p.num_input_connections += 1;
		if p.num_input_connections == 1 && dst_chip != NONE {
			self.chips[dst_chip as usize].num_connected_inputs += 1;
		}
	}

	fn remove_connection(&mut self, c: u32, source: &PinAddress, target: &PinAddress) -> Result<(), SimError> {
		let (src, _) = self.find_pin(c, source, None).ok_or_else(|| SimError("Failed to find pin with address".into()))?;
		let (dst, dst_chip) = self.find_pin(c, target, None).ok_or_else(|| SimError("Failed to find pin with address".into()))?;
		let targets = &mut self.pins[src as usize].targets;
		if let Some(i) = targets.iter().position(|&t| t == dst) {
			targets.remove(i);
			let p = &mut self.pins[dst as usize];
			p.num_input_connections -= 1;
			if p.num_input_connections == 0 {
				let parent = p.parent;
				self.hot.state[dst as usize] = ALL_DISCONNECTED;
				self.hot.latest_id[dst as usize] = -1;
				self.hot.latest_parent[dst as usize] = -1;
				if dst_chip != NONE {
					self.chips[parent as usize].num_connected_inputs -= 1;
				}
			}
		}
		Ok(())
	}

	// ---------------------------------------------------------------- Modifications

	pub fn resolve_path(&self, path: &[i32]) -> Option<u32> {
		let mut c = self.root;
		for &id in path {
			c = *self.chips[c as usize].subchips.iter().find(|&&s| self.chips[s as usize].id == id)?;
		}
		Some(c)
	}

	fn resolve(&self, path: &[i64]) -> Result<u32, SimError> {
		let p: Vec<i32> = path.iter().map(|&x| x as i32).collect();
		self.resolve_path(&p).ok_or_else(|| SimError("Failed to find subchip with id".into()))
	}

	/// Structure of this chip changed: its truth table (if any) no longer applies, nor do those of its ancestors
	fn invalidate_structure(&mut self, mut c: u32) {
		while c != NONE {
			self.chips[c as usize].desc_hash = 0;
			c = self.chips[c as usize].parent;
		}
	}

	/// Simulator.ApplyModification
	pub fn apply(&mut self, cmd: Command) -> Result<(), SimError> {
		self.sync_state();
		self.needs_order_pass = true;
		self.program_dirty = true;
		match cmd {
			Command::AddSubchip { target, chip_name, sub_chip_id, internal_data } => {
				let desc = self.lib.get(&chip_name).ok_or_else(|| SimError(format!("Chip not found in sim library: {chip_name}")))?;
				let t = self.resolve(&target)?;
				let s = self.build_chip(&desc, sub_chip_id as i32, internal_data.as_deref(), t)?;
				self.chips[t as usize].subchips.push(s);
				self.invalidate_structure(t);
			}
			Command::RemoveSubChip { target, id } => {
				let t = self.resolve(&target)?;
				let id = id as i32;
				let chips = &self.chips;
				let subs: Vec<u32> = chips[t as usize].subchips.iter().copied().filter(|&s| chips[s as usize].id != id).collect();
				self.chips[t as usize].subchips = subs;
				self.invalidate_structure(t);
			}
			Command::AddConnection { target, source, dest } => {
				let t = self.resolve(&target)?;
				self.add_connection_with(t, &source, &dest, None);
				self.invalidate_structure(t);
			}
			Command::RemoveConnection { target, source, dest } => {
				let t = self.resolve(&target)?;
				self.invalidate_structure(t);
				self.remove_connection(t, &source, &dest)?;
			}
			Command::AddPin { target, pin_id, is_input } => {
				let t = self.resolve(&target)?;
				let p = self.new_pin(pin_id as i32, is_input, t);
				if is_input {
					self.chips[t as usize].inputs.push(p);
				} else {
					self.chips[t as usize].outputs.push(p);
				}
				self.invalidate_structure(t);
			}
			Command::RemovePin { target, pin_id } => {
				let t = self.resolve(&target)?;
				let id = pin_id as i32;
				let pins = &self.pins;
				let ch = &self.chips[t as usize];
				let ins: Vec<u32> = ch.inputs.iter().copied().filter(|&p| pins[p as usize].id != id).collect();
				let outs: Vec<u32> = ch.outputs.iter().copied().filter(|&p| pins[p as usize].id != id).collect();
				self.chips[t as usize].inputs = ins;
				self.chips[t as usize].outputs = outs;
				self.invalidate_structure(t);
			}
			Command::BuildRoot { desc } => {
				self.reset_arena();
				self.root = self.build_chip(&desc, -1, None, NONE)?;
			}
			Command::SetInternalState { target, index, value } => {
				let t = self.resolve(&target)?;
				let chip = &mut self.chips[t as usize];
				if index < chip.internal.len() {
					chip.internal[index] = (value as i64) as u32;
				}
			}
			Command::UpdateInternalState { target, data } => {
				let t = self.resolve(&target)?;
				let chip = &mut self.chips[t as usize];
				if let Some(data) = data {
					let n = chip.internal.len().min(data.len());
					chip.internal[..n].copy_from_slice(&data[..n]);
				}
			}
			Command::LibrarySet { descs, replace_all } => {
				let lib = Rc::make_mut(&mut self.lib);
				if replace_all {
					lib.clear();
				}
				for d in descs {
					lib.set(d);
				}
			}
			Command::LibraryRemove { name } => {
				Rc::make_mut(&mut self.lib).remove(&name);
			}
		}
		Ok(())
	}

	pub fn set_view_path(&mut self, path: &[i32]) {
		if self.view_path != path {
			self.view_path = path.to_vec();
			self.program_dirty = true;
		}
	}

	pub fn set_inputs(&mut self, pairs: &[(i32, u32)]) {
		self.inputs.clear();
		self.inputs.extend_from_slice(pairs);
	}

	// ---------------------------------------------------------------- Stepping

	/// Simulator.RunSimulationStep
	pub fn run_step(&mut self, now_ms: f64) {
		self.ctx.audio.init_frame();

		self.ctx.pcg = (self.rng.next_u32()) & 0x7fff_ffff;
		let can_dynamic_reorder = self.ctx.frame % 100 == 0;
		self.ctx.frame = self.ctx.frame.wrapping_add(1);

		// Step 1) Get player-controlled input states and copy values to the sim
		let root = self.root as usize;
		for i in 0..self.inputs.len() {
			let (id, st) = self.inputs[i];
			for &p in &self.chips[root].inputs {
				if self.pins[p as usize].id == id {
					self.hot.state[p as usize] = st;
					break;
				}
			}
		}

		let hierarchical = self.needs_order_pass || can_dynamic_reorder || !self.use_fast_path;
		if hierarchical && self.last_frame_fast {
			self.restore_ready_counters();
			self.sync_state();
		}
		self.last_frame_fast = !hierarchical;

		if self.needs_order_pass {
			self.step_chip_reorder(self.root);
			self.needs_order_pass = false;
			self.program_dirty = true;
		} else if can_dynamic_reorder || !self.use_fast_path {
			self.swaps.clear();
			self.step_chip(self.root, can_dynamic_reorder);
			if !self.swaps.is_empty() && !self.program_dirty {
				let swaps = std::mem::take(&mut self.swaps);
				for &(first, second) in &swaps {
					if self.program.swap_units(&self.chips, first, second) {
						self.stat_swaps += 1;
					} else {
						self.program_dirty = true;
					}
				}
				self.swaps = swaps;
				if !self.program_dirty {
					self.program.compute_late_ready(&self.chips, &self.pins);
					let root_inputs = self.chips[self.root as usize].inputs.clone();
					self.program.optimize(&self.chips, self.pins.len(), &root_inputs);
				}
			}
		} else {
			if self.program_dirty {
				self.compile();
			}
			self.run_program();
		}

		self.update_audio_state(now_ms);
	}

	/// Set numInputsReady of every chip to the value it has after a frame of the compiled program
	fn restore_ready_counters(&mut self) {
		let late = &self.program.late_ready;
		let n = late.len().min(self.hot.ready.len());
		self.hot.ready[..n].copy_from_slice(&late[..n]);
	}

	pub fn update_in_paused_state(&mut self, now_ms: f64) {
		self.ctx.audio.init_frame();
		self.update_audio_state(now_ms);
	}

	fn update_audio_state(&mut self, now_ms: f64) {
		let elapsed = (now_ms - self.start_time_ms) / 1000.0;
		let dt = if self.ctx.frame <= 1 { 0.0 } else { elapsed - self.elapsed_seconds_old };
		self.elapsed_seconds_old = elapsed;
		self.ctx.audio.notify_all_notes_registered(dt);
	}

	pub fn compile(&mut self) {
		self.sync_state();
		let mut program = std::mem::take(&mut self.program);
		program.compile(self);
		self.program = program;
		self.stat_compiles += 1;
		self.program_dirty = false;
	}

	pub fn run_program(&mut self) {
		let Engine { program, chips, pins, hot, ctx, tables, .. } = self;
		program.run(chips, pins, hot, ctx, tables);
		self.state_stale = !self.program.aliases.is_empty();
	}

	/// Bring every pin's stored state up to date. Must be called before reading `hot.state` from outside the
	/// engine (snapshots, displays, tests) after fast-path frames.
	pub fn sync_state(&mut self) {
		if self.state_stale {
			self.program.materialize(&mut self.hot.state);
			self.state_stale = false;
		}
	}

	// ---- Hierarchical (reference) step: ports of StepChip / StepChipReorder ----

	#[inline]
	fn propagate_pin(&mut self, p: u32) {
		let n = self.pins[p as usize].targets.len();
		for k in 0..n {
			let t = self.pins[p as usize].targets[k];
			receive_input::<true>(&self.pins, &self.chips, &mut self.hot, &mut self.ctx.pcg, self.ctx.frame, t, p);
		}
	}

	fn propagate_inputs(&mut self, c: u32) {
		for k in 0..self.chips[c as usize].inputs.len() {
			let p = self.chips[c as usize].inputs[k];
			self.propagate_pin(p);
		}
	}

	fn propagate_outputs(&mut self, c: u32) {
		for k in 0..self.chips[c as usize].outputs.len() {
			let p = self.chips[c as usize].outputs[k];
			self.propagate_pin(p);
		}
		self.hot.ready[c as usize] = 0;
	}

	#[inline]
	fn is_ready(&self, c: u32) -> bool {
		self.hot.ready[c as usize] == self.chips[c as usize].num_connected_inputs
	}

	fn step_chip(&mut self, c: u32, can_dynamic_reorder: bool) {
		self.propagate_inputs(c);
		let n = self.chips[c as usize].subchips.len();
		let mut i = n as isize - 1;
		while i >= 0 {
			let iu = i as usize;
			let mut next = self.chips[c as usize].subchips[iu];
			// Every n frames the simulation permits some random modifications to the chip traversal order
			if can_dynamic_reorder && i > 0 && !self.is_ready(next) && random_bool(&mut self.ctx.pcg) {
				let potential = self.chips[c as usize].subchips[iu - 1];
				if !ct::is_bus_origin(self.chips[potential as usize].chip_type) {
					let subs = &mut self.chips[c as usize].subchips;
					subs[iu - 1] = next;
					subs[iu] = potential;
					self.swaps.push((next, potential));
					next = potential;
				}
			}
			if self.chips[next as usize].chip_type != ct::CUSTOM {
				let Engine { chips, hot, ctx, .. } = self;
				process_builtin(&mut chips[next as usize], hot, ctx);
			} else {
				self.step_chip(next, can_dynamic_reorder);
			}
			self.propagate_outputs(next);
			i -= 1;
		}
	}

	fn step_chip_reorder(&mut self, c: u32) {
		self.propagate_inputs(c);
		let mut num_remaining = self.chips[c as usize].subchips.len();
		while num_remaining > 0 {
			let next_index = self.choose_next_sub_chip(c, num_remaining);
			let subs = &mut self.chips[c as usize].subchips;
			let next = subs[next_index];
			subs[next_index] = subs[num_remaining - 1];
			subs[num_remaining - 1] = next;
			num_remaining -= 1;

			if self.chips[next as usize].chip_type == ct::CUSTOM {
				self.step_chip_reorder(next);
			} else {
				let Engine { chips, hot, ctx, .. } = self;
				process_builtin(&mut chips[next as usize], hot, ctx);
			}
			self.propagate_outputs(next);
		}
	}

	fn choose_next_sub_chip(&mut self, c: u32, num: usize) -> usize {
		let mut no_sub_chips_ready = true;
		let mut is_non_bus_chip_remaining = false;
		let mut next = 0usize;
		for i in 0..num {
			let s = self.chips[c as usize].subchips[i];
			if self.is_ready(s) {
				no_sub_chips_ready = false;
				next = i;
				break;
			}
			is_non_bus_chip_remaining |= !ct::is_bus_origin(self.chips[s as usize].chip_type);
		}
		if no_sub_chips_ready {
			next = self.rng.below(num);
			// If processing in random order, save buses for last
			if is_non_bus_chip_remaining {
				for _ in 0..num {
					let s = self.chips[c as usize].subchips[next];
					if !ct::is_bus_origin(self.chips[s as usize].chip_type) {
						break;
					}
					next = (next + 1) % num;
				}
			}
		}
		next
	}
}

/// SimPin.ReceiveInput
#[inline]
pub fn receive_input<const TRACK_READY: bool>(pins: &[PinInst], chips: &[ChipInst], hot: &mut Hot, pcg: &mut u32, frame: u32, t: u32, src: u32) {
	let ti = t as usize;
	if hot.last_frame[ti] != frame {
		hot.last_frame[ti] = frame;
		hot.recv[ti] = 0;
	}
	let src_state = hot.state[src as usize];
	let set;
	if hot.recv[ti] > 0 {
		// Conflicting inputs: randomly accept or reject (for all bits at once)
		let cur = hot.state[ti];
		let or = src_state | cur;
		let and = src_state & cur;
		let mut bits_new = (if random_bool(pcg) { or } else { and }) & 0xffff;
		let mask = (or >> 16) & 0xffff; // tristate flags
		bits_new = ((bits_new & !mask) | (or & mask)) & 0xffff; // can always accept input for tristated bits
		let tristate_new = (and >> 16) & 0xffff;
		let state_new = bits_new | (tristate_new << 16);
		set = state_new != cur;
		hot.state[ti] = state_new;
	} else {
		hot.state[ti] = src_state;
		set = true;
	}
	if set {
		let sp = &pins[src as usize];
		hot.latest_id[ti] = sp.id;
		hot.latest_parent[ti] = chips[sp.parent as usize].id;
	}
	hot.recv[ti] += 1;
	let tp = &pins[ti];
	if TRACK_READY && tp.is_input && hot.recv[ti] == tp.num_input_connections {
		hot.ready[tp.parent as usize] += 1;
	}
}

/// Simulator.ProcessBuiltinChip
pub fn process_builtin(chip: &mut ChipInst, hot: &mut Hot, ctx: &mut Ctx) {
	let ins = &chip.inputs;
	let outs = &chip.outputs;
	let st = &mut hot.state;
	let i = |k: usize| ins[k] as usize;
	let o = |k: usize| outs[k] as usize;
	match chip.chip_type {
		ct::NAND => {
			st[o(0)] = (1 ^ (st[i(0)] & st[i(1)])) & 1;
		}
		ct::CLOCK => {
			let spct = ctx.steps_per_clock;
			let high = spct != 0 && ((ctx.frame / spct) & 1) == 0;
			st[o(0)] = if high { LOGIC_HIGH } else { LOGIC_LOW };
		}
		ct::PULSE => {
			let internal = &mut chip.internal;
			if internal.len() < 3 {
				return;
			}
			let input_state = st[i(0)];
			let high = (input_state & 1) == 1;
			let mut remaining = internal[1];
			if remaining == 0 {
				let rising = high && internal[2] == 0;
				if rising {
					remaining = internal[0];
					internal[1] = remaining;
				}
			}
			let mut out = LOGIC_LOW;
			if remaining > 0 {
				internal[1] = internal[1].wrapping_sub(1);
				out = LOGIC_HIGH;
			} else if (input_state >> 16) != 0 {
				out = ALL_DISCONNECTED;
			}
			st[o(0)] = out;
			internal[2] = high as u32;
		}
		ct::SPLIT_4TO1 => {
			let v = st[i(0)];
			for k in 0..4 {
				st[o(k)] = (v >> (3 - k)) & SINGLE_BIT_MASK;
			}
		}
		ct::MERGE_1TO4 => {
			let mut v = 0;
			for k in 0..4 {
				v |= (st[i(3 - k)] & SINGLE_BIT_MASK) << k;
			}
			st[o(0)] = v;
		}
		ct::MERGE_1TO8 => {
			let mut v = 0;
			for k in 0..8 {
				v |= (st[i(7 - k)] & SINGLE_BIT_MASK) << k;
			}
			st[o(0)] = v;
		}
		ct::MERGE_4TO8 => {
			st[o(0)] = get8_from4(st[i(1)], st[i(0)]);
		}
		ct::SPLIT_8TO4 => {
			let v = st[i(0)];
			st[o(0)] = get4_from8(v, false);
			st[o(1)] = get4_from8(v, true);
		}
		ct::SPLIT_8TO1 => {
			let v = st[i(0)];
			for k in 0..8 {
				st[o(k)] = (v >> (7 - k)) & SINGLE_BIT_MASK;
			}
		}
		ct::TRI_STATE_BUFFER => {
			st[o(0)] = if (st[i(1)] & 1) == 1 { st[i(0)] } else { ALL_DISCONNECTED };
		}
		ct::KEY => {
			let held = chip.internal.first().is_some_and(|c| ctx.held_keys.contains(c));
			st[o(0)] = if held { LOGIC_HIGH } else { LOGIC_LOW };
		}
		ct::DISPLAY_RGB => {
			let internal = &mut chip.internal;
			let address_space = 256usize;
			let (addr, r, g, b) = (st[i(0)], st[i(1)], st[i(2)], st[i(3)]);
			let (reset, write, refresh, clock) = (st[i(4)], st[i(5)], st[i(6)], st[i(7)]);
			let last = internal.len() - 1;
			let clock_high = (clock & 1) == 1;
			let rising = clock_high && internal[last] == 0;
			internal[last] = clock_high as u32;
			if rising {
				if (reset & 1) == 1 {
					internal[address_space..address_space * 2].fill(0);
				} else if (write & 1) == 1 {
					let idx = (addr & 0xffff) as usize + address_space;
					let data = (r & 0xffff) | ((g & 0xffff) << 4) | ((b & 0xffff) << 8);
					if idx < internal.len() {
						internal[idx] = data;
					}
				}
				if (refresh & 1) == 1 {
					internal.copy_within(address_space..address_space * 2, 0);
				}
			}
			let col = internal.get((addr & 0xffff) as usize).copied().unwrap_or(0);
			st[o(0)] = col & 0b1111;
			st[o(1)] = (col >> 4) & 0b1111;
			st[o(2)] = (col >> 8) & 0b1111;
		}
		ct::DISPLAY_DOT => {
			let internal = &mut chip.internal;
			let address_space = 256usize;
			let (addr, pixel, reset, write, refresh, clock) = (st[i(0)], st[i(1)], st[i(2)], st[i(3)], st[i(4)], st[i(5)]);
			let last = internal.len() - 1;
			let clock_high = (clock & 1) == 1;
			let rising = clock_high && internal[last] == 0;
			internal[last] = clock_high as u32;
			if rising {
				if (reset & 1) == 1 {
					internal[address_space..address_space * 2].fill(0);
				} else if (write & 1) == 1 {
					let idx = (addr & 0xffff) as usize + address_space;
					if idx < internal.len() {
						internal[idx] = pixel & 0xffff;
					}
				}
				if (refresh & 1) == 1 {
					internal.copy_within(address_space..address_space * 2, 0);
				}
			}
			st[o(0)] = internal.get((addr & 0xffff) as usize).copied().unwrap_or(0) & 0xffff;
		}
		ct::DEV_RAM_8BIT => {
			let internal = &mut chip.internal;
			let (addr, data, write, reset, clock) = (st[i(0)], st[i(1)], st[i(2)], st[i(3)], st[i(4)]);
			let last = internal.len() - 1;
			let clock_high = (clock & 1) == 1;
			let rising = clock_high && internal[last] == 0;
			internal[last] = clock_high as u32;
			let a = (addr & 0xffff) as usize;
			if rising {
				if (reset & 1) == 1 {
					internal[..256].fill(0);
				} else if (write & 1) == 1 && a < last {
					internal[a] = data & 0xffff;
				}
			}
			st[o(0)] = if a < last { internal[a] & 0xffff } else { 0 };
		}
		ct::ROM_256X16 => {
			let address = (st[i(0)] & 0xffff) as usize;
			let data = chip.internal.get(address).copied().unwrap_or(0);
			st[o(0)] = (data >> 8) & 0xff;
			st[o(1)] = data & 0xff;
		}
		ct::BUZZER => {
			let freq = (st[i(0)] & 0xffff) as usize;
			let vol = st[i(1)] & 0xffff;
			ctx.audio.register_note(freq, vol);
		}
		t => {
			if ct::is_bus_origin(t) {
				st[o(0)] = st[i(0)];
			}
		}
	}
}

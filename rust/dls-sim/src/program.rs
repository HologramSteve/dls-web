//! Compiled flat program: the hierarchical step (StepChip) unrolled into a linear list of operations.
//!
//! Executing the program performs exactly the operations StepChip would perform, in the same order:
//! propagate a chip's input pins, process its subchips in their (cached) traversal order, propagate each
//! subchip's outputs. Wires to pins with a single connection are compiled to plain copies (no conflict handling
//! is ever needed for them).
//!
//! The per-chip "inputs ready" counters (numInputsReady) are not maintained by the program: they are only read
//! by the hierarchical step on order-pass and dynamic-reorder frames. Their exact values after a program frame
//! depend only on the program order (= the number of a chip's inputs that complete after the chip was
//! processed, i.e. feedback inputs), so they are precomputed (`late_ready`) and restored before such frames.
//!
//! Units (a subchip's block + its output propagation) of siblings are contiguous, so when a dynamic-reorder frame
//! swaps two adjacent subchips, the program is patched by rotating the two units (`swap_units`).
//!
//! Custom subchips that have a truth table get a `Table` op in front of their block: if the lookup applies, the
//! outputs are written from the table and the block is skipped.
use crate::engine::{process_builtin, receive_input, ChipInst, Ctx, Engine, Hot, PinInst, NONE};
use crate::tables::{self, TableCache};

#[derive(Clone, Copy, Debug)]
pub enum Op {
	/// Wire into a pin with a single connection
	Copy { src: u32, dst: u32 },
	/// Wire into a pin with several connections (SimPin.ReceiveInput, including conflict resolution)
	Receive { src: u32, dst: u32 },
	Nand { a: u32, b: u32, out: u32 },
	Builtin { chip: u32 },
	/// Truth table lookup for a custom subchip; on success skip the next `skip` ops (the subchip's block)
	Table { inst: u32, skip: u32 },
	/// A table op that was switched off because its lookups rarely apply (inputs often tri-stated)
	Nop,
}

pub struct TableInst {
	pub table: u32,
	/// Input pins as compiled
	pub raw_inputs: Vec<u32>,
	/// Input pins read by the optimized program (aliases resolved)
	pub inputs: Vec<u32>,
	pub shifts: Vec<u32>,
	pub masks: Vec<u32>,
	pub outputs: Vec<u32>,
	pub hits: u32,
	pub misses: u32,
}

#[derive(Default)]
pub struct Program {
	/// Program as compiled (one op per wire / chip, in StepChip order); patched by `swap_units`
	pub raw: Vec<Op>,
	/// Optimized program that is executed (`optimize`): copies whose target can safely alias the source removed
	pub ops: Vec<Op>,
	/// (aliased pin, source pin): pins whose state is not written by `ops`; `materialize` fills them in
	pub aliases: Vec<(u32, u32)>,
	pub table_insts: Vec<TableInst>,
	/// Per chip: (block start, block end, unit end) — unit = block + output propagation
	ranges: Vec<(u32, u32, u32)>,
	on_view_path: Vec<bool>,
	pub tabled_chips: u32,
	/// Per chip: value of numInputsReady after a frame of this program (see module docs)
	pub late_ready: Vec<u32>,
	max_pin: u32,
}

impl Program {
	pub fn compile(&mut self, e: &mut Engine) {
		self.raw.clear();
		self.table_insts.clear();
		self.tabled_chips = 0;
		self.max_pin = 0;
		self.aliases.clear();
		self.ranges.clear();
		self.ranges.resize(e.chips.len(), (NONE, NONE, NONE));
		self.on_view_path.clear();
		self.on_view_path.resize(e.chips.len(), false);

		// Chips on the viewed path must keep all their pin states up to date (they are drawn), so they never use tables
		let mut c = e.root;
		self.on_view_path[c as usize] = true;
		for &id in &e.view_path.clone() {
			match e.chips[c as usize].subchips.iter().find(|&&s| e.chips[s as usize].id == id) {
				Some(&s) => {
					c = s;
					self.on_view_path[c as usize] = true;
				}
				None => break,
			}
		}

		let root = e.root;
		for k in 0..e.chips[root as usize].inputs.len() {
			let p = e.chips[root as usize].inputs[k];
			self.emit_pin(e, p);
		}
		for k in (0..e.chips[root as usize].subchips.len()).rev() {
			let s = e.chips[root as usize].subchips[k];
			self.emit_unit(e, s);
		}
		self.compute_late_ready(&e.chips, &e.pins);
		let root_inputs = e.chips[e.root as usize].inputs.clone();
		self.optimize(&e.chips, e.pins.len(), &root_inputs);
	}

	/// Remove wire copies whose target pin can read its source pin directly.
	///
	/// Copy `s -> d` at position P can be removed if d is written only by this copy, the source's (root) value is
	/// written exactly once per frame at position W < P, and nothing reads d in [W, P) (the only window in which
	/// d and its source differ). All readers of d must be ops that can be redirected (copies, NANDs, table
	/// lookups). Then d always equals the source whenever it is read, and at the end of every frame, so its stored
	/// state can be filled in lazily (`materialize`) before anything outside the program reads pin states.
	pub fn optimize(&mut self, chips: &[ChipInst], num_pins: usize, root_inputs: &[u32]) {
		const UNWRITTEN: i64 = i64::MAX;
		let n = num_pins;
		let mut write_count = vec![0u32; n];
		let mut write_pos = vec![UNWRITTEN; n];
		for &p in root_inputs {
			write_count[p as usize] += 1;
			write_pos[p as usize] = -1; // set from the player inputs before the program runs
		}
		// Readers: (position, redirectable)
		let mut readers: Vec<Vec<(u32, bool)>> = vec![Vec::new(); n];
		{
			let mut write = |p: u32, pos: usize| {
				write_count[p as usize] += 1;
				write_pos[p as usize] = pos as i64;
			};
			for (pos, op) in self.raw.iter().enumerate() {
				match *op {
					Op::Copy { src, dst } => {
						readers[src as usize].push((pos as u32, true));
						write(dst, pos);
					}
					Op::Receive { src, dst } => {
						readers[src as usize].push((pos as u32, false));
						write(dst, pos);
					}
					Op::Nand { a, b, out } => {
						readers[a as usize].push((pos as u32, true));
						readers[b as usize].push((pos as u32, true));
						write(out, pos);
					}
					Op::Builtin { chip } => {
						for &p in &chips[chip as usize].inputs {
							readers[p as usize].push((pos as u32, false));
						}
						for &p in &chips[chip as usize].outputs {
							write(p, pos);
						}
					}
					Op::Table { inst, .. } => {
						let ti = &self.table_insts[inst as usize];
						for &p in &ti.raw_inputs {
							readers[p as usize].push((pos as u32, true));
						}
						for &p in &ti.outputs {
							write(p, pos);
						}
					}
					Op::Nop => {}
				}
			}
		}

		// A tabled chip's output pins are written by its Table op and by copies inside its block. Both happen within
		// the block, so as a source they behave like a single write at the Table op: use that for aliasing.
		let mut source_count = write_count.clone();
		let mut source_pos = write_pos.clone();
		{
			let mut first = vec![i64::MAX; n];
			let mut last = vec![-1i64; n];
			for (pos, op) in self.raw.iter().enumerate() {
				let mut note = |p: u32| {
					first[p as usize] = first[p as usize].min(pos as i64);
					last[p as usize] = pos as i64;
				};
				match *op {
					Op::Copy { dst, .. } | Op::Receive { dst, .. } => note(dst),
					Op::Nand { out, .. } => note(out),
					Op::Builtin { chip } => chips[chip as usize].outputs.iter().for_each(|&p| note(p)),
					Op::Table { inst, .. } => self.table_insts[inst as usize].outputs.iter().for_each(|&p| note(p)),
					Op::Nop => {}
				}
			}
			for p in 0..n {
				if write_count[p] > 1 && first[p] >= 0 && first[p] != i64::MAX {
					if let Op::Table { skip, inst } = self.raw[first[p] as usize] {
						let in_outputs = self.table_insts[inst as usize].outputs.contains(&(p as u32));
						if in_outputs && last[p] <= first[p] + skip as i64 && !root_inputs.contains(&(p as u32)) {
							source_count[p] = 1;
							source_pos[p] = first[p];
						}
					}
				}
			}
		}

		let mut root: Vec<u32> = (0..n as u32).collect();
		let mut keep = vec![true; self.raw.len()];
		self.aliases.clear();
		for (pos, op) in self.raw.iter().enumerate() {
			let Op::Copy { src, dst } = *op else { continue };
			let r = root[src as usize];
			let (d, ri) = (dst as usize, r as usize);
			if write_count[d] != 1 || source_count[ri] != 1 || source_pos[ri] >= pos as i64 || d == ri {
				continue;
			}
			let w = source_pos[ri];
			let ok = readers[d].iter().all(|&(rp, redirectable)| redirectable && !((rp as i64) >= w && (rp as usize) < pos));
			if ok {
				root[d] = r;
				keep[pos] = false;
				self.aliases.push((dst, r));
			}
		}

		// Rewrite: drop removed copies, redirect reads to the root pins, fix table skips
		let mut new_index = vec![0u32; self.raw.len() + 1];
		let mut k = 0u32;
		for (i, &kp) in keep.iter().enumerate() {
			new_index[i] = k;
			k += kp as u32;
		}
		new_index[self.raw.len()] = k;
		self.ops.clear();
		for (pos, op) in self.raw.iter().enumerate() {
			if !keep[pos] {
				continue;
			}
			let rt = |p: u32| root[p as usize];
			self.ops.push(match *op {
				Op::Copy { src, dst } => Op::Copy { src: rt(src), dst },
				Op::Nand { a, b, out } => Op::Nand { a: rt(a), b: rt(b), out },
				Op::Table { inst, skip } => {
					let end = pos + 1 + skip as usize;
					Op::Table { inst, skip: new_index[end] - new_index[pos] - 1 }
				}
				o => o,
			});
		}
		for ti in &mut self.table_insts {
			ti.inputs = ti.raw_inputs.iter().map(|&p| root[p as usize]).collect();
			ti.hits = 0;
			ti.misses = 0;
		}
	}

	/// Write the state of every aliased pin (see `optimize`). Valid between frames.
	pub fn materialize(&self, state: &mut [u32]) {
		for &(d, r) in &self.aliases {
			state[d as usize] = state[r as usize];
		}
	}

	/// numInputsReady of each chip after a frame of this program: the number of its connected input pins that
	/// receive their last input after the chip's unit (its ready counter is reset at the end of its unit).
	pub fn compute_late_ready(&mut self, chips: &[ChipInst], pins: &[PinInst]) {
		let mut last = vec![NONE; pins.len()];
		let mut count = vec![0u32; pins.len()];
		for (pos, op) in self.raw.iter().enumerate() {
			if let Op::Copy { dst, .. } | Op::Receive { dst, .. } = *op {
				last[dst as usize] = pos as u32;
				count[dst as usize] += 1;
			}
		}
		self.late_ready.clear();
		self.late_ready.resize(self.ranges.len(), 0);
		for (c, r) in self.ranges.iter().enumerate() {
			if r.0 == NONE {
				continue;
			}
			let mut n = 0;
			for &p in &chips[c].inputs {
				let p = p as usize;
				let conns = pins[p].num_input_connections;
				if conns > 0 && count[p] == conns && last[p] >= r.2 {
					n += 1;
				}
			}
			self.late_ready[c] = n;
		}
	}

	fn emit_pin(&mut self, e: &mut Engine, p: u32) {
		for k in 0..e.pins[p as usize].targets.len() {
			let t = e.pins[p as usize].targets[k];
			let tp = &e.pins[t as usize];
			if tp.num_input_connections == 1 {
				// Single source: the pin always accepts the input, so 'latest source' is fixed
				e.hot.latest_id[t as usize] = e.pins[p as usize].id;
				e.hot.latest_parent[t as usize] = e.chips[e.pins[p as usize].parent as usize].id;
				self.raw.push(Op::Copy { src: p, dst: t });
				self.max_pin = self.max_pin.max(p).max(t);
			} else {
				self.raw.push(Op::Receive { src: p, dst: t });
				self.max_pin = self.max_pin.max(p).max(t);
			}
		}
	}

	fn emit_unit(&mut self, e: &mut Engine, s: u32) {
		let start = self.raw.len() as u32;
		let ch = &e.chips[s as usize];
		if ch.chip_type == crate::engine::ct::NAND && ch.inputs.len() == 2 && ch.outputs.len() == 1 {
			self.raw.push(Op::Nand { a: ch.inputs[0], b: ch.inputs[1], out: ch.outputs[0] });
		} else if ch.chip_type != crate::engine::ct::CUSTOM {
			self.raw.push(Op::Builtin { chip: s });
		} else {
			let table = if self.on_view_path[s as usize] { None } else { tables::table_for(e, s) };
			let table_pos = self.raw.len();
			if let Some(tid) = table {
				let t = &e.tables.tables[tid as usize];
				let ch = &e.chips[s as usize];
				let mut shifts = Vec::with_capacity(ch.inputs.len());
				let mut masks = Vec::with_capacity(ch.inputs.len());
				let mut shift = 0u32;
				for &b in &t.in_bits {
					shifts.push(shift);
					masks.push((1u32 << b) - 1);
					shift += b as u32;
				}
				self.table_insts.push(TableInst { table: tid, raw_inputs: ch.inputs.clone(), inputs: ch.inputs.clone(), shifts, masks, outputs: ch.outputs.clone(), hits: 0, misses: 0 });
				self.raw.push(Op::Table { inst: self.table_insts.len() as u32 - 1, skip: 0 });
				self.tabled_chips += 1;
			}
			for k in 0..e.chips[s as usize].inputs.len() {
				let p = e.chips[s as usize].inputs[k];
				self.emit_pin(e, p);
			}
			for k in (0..e.chips[s as usize].subchips.len()).rev() {
				let sub = e.chips[s as usize].subchips[k];
				self.emit_unit(e, sub);
			}
			if table.is_some() {
				let skip = (self.raw.len() - table_pos - 1) as u32;
				if let Op::Table { skip: sk, .. } = &mut self.raw[table_pos] {
					*sk = skip;
				}
			}
		}
		let end = self.raw.len() as u32;
		for k in 0..e.chips[s as usize].outputs.len() {
			let p = e.chips[s as usize].outputs[k];
			self.emit_pin(e, p);
		}
		self.ranges[s as usize] = (start, end, self.raw.len() as u32);
	}

	/// A dynamic-reorder frame swapped two adjacent subchips: `first` (previously visited first) and `second`.
	/// Returns false if the program can't be patched (caller then recompiles).
	pub fn swap_units(&mut self, chips: &[ChipInst], first: u32, second: u32) -> bool {
		let (Some(&(s1, _, o1)), Some(&(s2, _, o2))) = (self.ranges.get(first as usize), self.ranges.get(second as usize)) else { return false };
		if s1 == NONE || s2 == NONE || o1 != s2 {
			return false;
		}
		let len1 = o1 - s1;
		let len2 = o2 - s2;
		self.raw[s1 as usize..o2 as usize].rotate_left(len1 as usize);
		self.shift_subtree(chips, second, -(len1 as i64));
		self.shift_subtree(chips, first, len2 as i64);
		true
	}

	fn shift_subtree(&mut self, chips: &[ChipInst], c: u32, delta: i64) {
		if let Some(r) = self.ranges.get_mut(c as usize) {
			if r.0 != NONE {
				r.0 = (r.0 as i64 + delta) as u32;
				r.1 = (r.1 as i64 + delta) as u32;
				r.2 = (r.2 as i64 + delta) as u32;
			}
		}
		for &s in &chips[c as usize].subchips {
			self.shift_subtree(chips, s, delta);
		}
	}

	pub fn run(&mut self, chips: &mut [ChipInst], pins: &[PinInst], hot: &mut Hot, ctx: &mut Ctx, tables: &TableCache) {
		let n = self.ops.len();
		let ops = self.ops.as_mut_ptr();
		let mut pc = 0;
		// SAFETY: all pin/chip indices in the program were taken from the engine's arenas when compiling, and the
		// arenas only grow (a structural change marks the program dirty, and it is recompiled before running).
		unsafe {
			let st = hot.state.as_mut_ptr();
			debug_assert!(self.max_pin < hot.state.len() as u32 || n == 0);
			while pc < n {
				match *ops.add(pc) {
					Op::Copy { src, dst } => {
						*st.add(dst as usize) = *st.add(src as usize);
					}
					Op::Nand { a, b, out } => {
						*st.add(out as usize) = (1 ^ (*st.add(a as usize) & *st.add(b as usize))) & 1;
					}
					Op::Receive { src, dst } => {
						receive_input::<false>(pins, chips, hot, &mut ctx.pcg, ctx.frame, dst, src);
					}
					Op::Builtin { chip } => {
						process_builtin(&mut chips[chip as usize], hot, ctx);
					}
					Op::Nop => {}
					Op::Table { inst, skip } => {
						let ti = self.table_insts.get_unchecked_mut(inst as usize);
						let t = tables.tables.get_unchecked(ti.table as usize);
						let mut index = 0u32;
						let mut flags = 0u32;
						for k in 0..ti.inputs.len() {
							let s = *st.add(*ti.inputs.get_unchecked(k) as usize);
							flags |= s;
							index |= (s & *ti.masks.get_unchecked(k)) << *ti.shifts.get_unchecked(k);
						}
						if !t.flag_sensitive || (flags >> 16) == 0 {
							let base = index as usize * t.n_out;
							for (j, &o) in ti.outputs.iter().enumerate() {
								*st.add(o as usize) = *t.data.get_unchecked(base + j);
							}
							ti.hits = ti.hits.saturating_add(1);
							pc += skip as usize;
						} else {
							// Inputs tri-stated: simulate the block. Give up on the table if that's the common case.
							ti.misses += 1;
							if ti.misses >= 64 && ti.misses > ti.hits {
								*ops.add(pc) = Op::Nop;
							}
						}
					}
				}
				pc += 1;
			}
		}
	}
}

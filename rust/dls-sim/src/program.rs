//! Compiled flat program: the hierarchical step (StepChip) unrolled into a linear list of operations.
//!
//! Executing the program performs exactly the operations StepChip would perform, in the same order:
//! propagate a chip's input pins, process its subchips in their (cached) traversal order, propagate each
//! subchip's outputs and reset its ready counter. Wires to pins with a single connection are compiled to plain
//! copies (no conflict handling is ever needed for them).
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
	/// Single-connection wire into a subchip input pin (also counts towards the subchip's ready counter)
	CopyIn { src: u32, dst: u32, chip: u32 },
	/// Single-connection wire into a non-input pin (chip output pin)
	Copy { src: u32, dst: u32 },
	/// Wire into a pin with several connections (SimPin.ReceiveInput, including conflict resolution)
	Receive { src: u32, dst: u32 },
	Nand { a: u32, b: u32, out: u32 },
	Builtin { chip: u32 },
	ResetReady { chip: u32 },
	/// Truth table lookup for a custom subchip; on success skip the next `skip` ops (the subchip's block)
	Table { inst: u32, skip: u32 },
}

pub struct TableInst {
	pub table: u32,
	pub inputs: Vec<u32>,
	pub shifts: Vec<u32>,
	pub masks: Vec<u32>,
	pub outputs: Vec<u32>,
}

#[derive(Default)]
pub struct Program {
	pub ops: Vec<Op>,
	pub table_insts: Vec<TableInst>,
	/// Per chip: (block start, block end, unit end) — unit = block + output propagation
	ranges: Vec<(u32, u32, u32)>,
	on_view_path: Vec<bool>,
	pub tabled_chips: u32,
}

impl Program {
	pub fn compile(&mut self, e: &mut Engine) {
		self.ops.clear();
		self.table_insts.clear();
		self.tabled_chips = 0;
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
	}

	fn emit_pin(&mut self, e: &mut Engine, p: u32) {
		for k in 0..e.pins[p as usize].targets.len() {
			let t = e.pins[p as usize].targets[k];
			let tp = &e.pins[t as usize];
			if tp.num_input_connections == 1 {
				// Single source: the pin always accepts the input, so 'latest source' is fixed
				e.hot.latest_id[t as usize] = e.pins[p as usize].id;
				e.hot.latest_parent[t as usize] = e.chips[e.pins[p as usize].parent as usize].id;
				if tp.is_input {
					self.ops.push(Op::CopyIn { src: p, dst: t, chip: tp.parent });
				} else {
					self.ops.push(Op::Copy { src: p, dst: t });
				}
			} else {
				self.ops.push(Op::Receive { src: p, dst: t });
			}
		}
	}

	fn emit_unit(&mut self, e: &mut Engine, s: u32) {
		let start = self.ops.len() as u32;
		let ch = &e.chips[s as usize];
		if ch.chip_type == crate::engine::ct::NAND && ch.inputs.len() == 2 && ch.outputs.len() == 1 {
			self.ops.push(Op::Nand { a: ch.inputs[0], b: ch.inputs[1], out: ch.outputs[0] });
		} else if ch.chip_type != crate::engine::ct::CUSTOM {
			self.ops.push(Op::Builtin { chip: s });
		} else {
			let table = if self.on_view_path[s as usize] { None } else { tables::table_for(e, s) };
			let table_pos = self.ops.len();
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
				self.table_insts.push(TableInst { table: tid, inputs: ch.inputs.clone(), shifts, masks, outputs: ch.outputs.clone() });
				self.ops.push(Op::Table { inst: self.table_insts.len() as u32 - 1, skip: 0 });
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
				let skip = (self.ops.len() - table_pos - 1) as u32;
				if let Op::Table { skip: sk, .. } = &mut self.ops[table_pos] {
					*sk = skip;
				}
			}
		}
		let end = self.ops.len() as u32;
		for k in 0..e.chips[s as usize].outputs.len() {
			let p = e.chips[s as usize].outputs[k];
			self.emit_pin(e, p);
		}
		self.ops.push(Op::ResetReady { chip: s });
		self.ranges[s as usize] = (start, end, self.ops.len() as u32);
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
		self.ops[s1 as usize..o2 as usize].rotate_left(len1 as usize);
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

	pub fn run(&self, chips: &mut [ChipInst], pins: &[PinInst], hot: &mut Hot, ctx: &mut Ctx, tables: &TableCache) {
		let ops = &self.ops[..];
		let n = ops.len();
		let mut pc = 0;
		while pc < n {
			match ops[pc] {
				Op::CopyIn { src, dst, chip } => {
					hot.state[dst as usize] = hot.state[src as usize];
					hot.ready[chip as usize] += 1;
				}
				Op::Copy { src, dst } => {
					hot.state[dst as usize] = hot.state[src as usize];
				}
				Op::Nand { a, b, out } => {
					hot.state[out as usize] = (1 ^ (hot.state[a as usize] & hot.state[b as usize])) & 1;
				}
				Op::ResetReady { chip } => {
					hot.ready[chip as usize] = 0;
				}
				Op::Receive { src, dst } => {
					receive_input(pins, chips, hot, &mut ctx.pcg, ctx.frame, dst, src);
				}
				Op::Builtin { chip } => {
					process_builtin(&mut chips[chip as usize], hot, ctx);
				}
				Op::Table { inst, skip } => {
					let ti = &self.table_insts[inst as usize];
					let t = &tables.tables[ti.table as usize];
					let mut index = 0u32;
					let mut flags = 0u32;
					for k in 0..ti.inputs.len() {
						let s = hot.state[ti.inputs[k] as usize];
						flags |= s;
						index |= (s & ti.masks[k]) << ti.shifts[k];
					}
					if !t.flag_sensitive || (flags >> 16) == 0 {
						let base = index as usize * t.n_out;
						for (j, &o) in ti.outputs.iter().enumerate() {
							hot.state[o as usize] = t.data[base + j];
						}
						pc += skip as usize;
					}
				}
			}
			pc += 1;
		}
	}
}

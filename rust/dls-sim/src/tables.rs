//! Truth-table cache for combinational custom chips.
//!
//! A chip type gets a table when (recursively) it only contains NAND and split/merge chips, no pin inside it has
//! more than one incoming wire, and its subchips form no feedback loop. For such chips the original simulator
//! processes the internals in dependency order within a single step, so the outputs are a pure function of the
//! current input pin states: the table lookup is *exact*, not an approximation.
//!
//! The index is built from the input pins' bit states. If any path from an input to an output passes only through
//! wires and split/merge chips ("flag transparent"), tri-state flags on the inputs could reach an output; then the
//! table is only used while all input flags are clear, otherwise the chip's block is simulated normally.
use crate::desc::{FMap, FSet, Library, SimChipDesc};
use crate::engine::{ct, Engine};
use std::rc::Rc;

/// Tables are built for chips with at most this many input bits (2^16 = 65536 rows)
pub const MAX_INPUT_BITS: u32 = 16;
/// Upper bound on (rows x internal size) simulated to build one table
const MAX_BUILD_WORK: u64 = 1 << 28;
/// Upper bound on total table memory
const MAX_TOTAL_BYTES: usize = 256 << 20;

pub struct Table {
	pub n_out: usize,
	pub in_bits: Vec<u8>,
	pub data: Vec<u32>,
	pub flag_sensitive: bool,
	pub name: String,
}

#[derive(Clone, Copy)]
struct Info {
	eligible: bool,
	/// Tri-state flags on some input can reach some output
	flag_transparent: bool,
	/// Approximate number of ops to simulate one instance (flattened chips + wires)
	cost: u64,
}

#[derive(Default)]
pub struct TableCache {
	by_hash: FMap<u64, Option<u32>>,
	info: FMap<u64, Info>,
	pub tables: Vec<Table>,
	pub bytes: usize,
	pub build_ms: f64,
}

/// Returns the table to use for a custom subchip instance (building it on first use), if it is eligible.
pub fn table_for(e: &mut Engine, chip: u32) -> Option<u32> {
	if !e.use_tables {
		return None;
	}
	let ch = &e.chips[chip as usize];
	if ch.chip_type != ct::CUSTOM || ch.desc_hash == 0 {
		return None;
	}
	let hash = ch.desc_hash;
	let name = ch.name.clone();
	if e.lib.desc_hash(&name) != hash {
		return None; // instance built from an older version of the description
	}
	if let Some(&r) = e.tables.by_hash.get(&hash) {
		return r;
	}
	let r = build_table(e, &name, hash);
	e.tables.by_hash.insert(hash, r);
	r
}

fn builtin_info(t: u8) -> Info {
	match t {
		ct::NAND => Info { eligible: true, flag_transparent: false, cost: 1 },
		ct::MERGE_1TO4 | ct::MERGE_1TO8 | ct::MERGE_4TO8 | ct::SPLIT_4TO1 | ct::SPLIT_8TO4 | ct::SPLIT_8TO1 => Info { eligible: true, flag_transparent: true, cost: 1 },
		_ => Info { eligible: false, flag_transparent: true, cost: 1 },
	}
}

const INELIGIBLE: Info = Info { eligible: false, flag_transparent: true, cost: 0 };

fn desc_info(lib: &Library, cache: &mut FMap<u64, Info>, d: &SimChipDesc, depth: u32) -> Info {
	if d.chip_type != ct::CUSTOM {
		return builtin_info(d.chip_type);
	}
	let hash = lib.desc_hash(&d.name);
	if hash == 0 || depth > 64 {
		return INELIGIBLE;
	}
	if let Some(&i) = cache.get(&hash) {
		return i;
	}
	let info = compute_info(lib, cache, d, depth).unwrap_or(INELIGIBLE);
	cache.insert(hash, info);
	info
}

fn compute_info(lib: &Library, cache: &mut FMap<u64, Info>, d: &SimChipDesc, depth: u32) -> Option<Info> {
	if d.input_bits.len() != d.input_ids.len() || d.output_bits.len() != d.output_ids.len() {
		return None;
	}
	// Subchips (by ID)
	let mut subs: FMap<i64, (Rc<SimChipDesc>, Info)> = FMap::default();
	let mut cost = 1u64;
	for s in &d.sub_chips {
		let sd = lib.get(&s.name)?;
		let info = desc_info(lib, cache, &sd, depth + 1);
		if !info.eligible {
			return None;
		}
		cost += info.cost;
		if subs.insert(s.id, (sd, info)).is_some() {
			return None; // duplicate subchip IDs
		}
	}
	cost += d.wires.len() as u64;

	// Pin nodes: (owner id, pin id). Dev pins use (dev pin id, 0)
	let dev_in: FSet<i64> = d.input_ids.iter().copied().collect();
	let dev_out: FSet<i64> = d.output_ids.iter().copied().collect();
	#[derive(PartialEq, Eq, Hash, Clone, Copy)]
	enum Node {
		DevIn(i64),
		DevOut(i64),
		SubIn(i64, i64),
		SubOut(i64, i64),
	}
	let classify = |owner: i64, pin: i64| -> Option<Node> {
		if let Some((sd, _)) = subs.get(&owner) {
			if sd.input_ids.contains(&pin) {
				return Some(Node::SubIn(owner, pin));
			}
			if sd.output_ids.contains(&pin) {
				return Some(Node::SubOut(owner, pin));
			}
		}
		if dev_in.contains(&owner) {
			return Some(Node::DevIn(owner));
		}
		if dev_out.contains(&owner) {
			return Some(Node::DevOut(owner));
		}
		None
	};

	let mut incoming: FMap<Node, u32> = FMap::default();
	let mut edges: FMap<Node, Vec<Node>> = FMap::default();
	let mut sub_edges: FMap<i64, Vec<i64>> = FMap::default();
	let mut indeg: FMap<i64, u32> = subs.keys().map(|&k| (k, 0)).collect();
	for w in &d.wires {
		let src = classify(w.source.owner_id, w.source.pin_id)?;
		let dst = classify(w.target.owner_id, w.target.pin_id)?;
		// Only well-formed wires: (dev input | subchip output) -> (subchip input | dev output)
		if !matches!(src, Node::DevIn(_) | Node::SubOut(..)) || !matches!(dst, Node::SubIn(..) | Node::DevOut(_)) {
			return None;
		}
		let n = incoming.entry(dst).or_insert(0);
		*n += 1;
		if *n > 1 {
			return None; // conflicting sources are resolved randomly: not a pure function
		}
		edges.entry(src).or_default().push(dst);
		if let (Node::SubOut(a, _), Node::SubIn(b, _)) = (src, dst) {
			sub_edges.entry(a).or_default().push(b);
			*indeg.get_mut(&b)? += 1;
		}
	}

	// Acyclic (Kahn)
	let mut queue: Vec<i64> = indeg.iter().filter(|(_, &v)| v == 0).map(|(&k, _)| k).collect();
	let mut visited = 0;
	while let Some(a) = queue.pop() {
		visited += 1;
		if let Some(list) = sub_edges.get(&a) {
			for &b in list {
				let v = indeg.get_mut(&b)?;
				*v -= 1;
				if *v == 0 {
					queue.push(b);
				}
			}
		}
	}
	if visited != subs.len() {
		return None; // feedback loop (latch etc.)
	}

	// Flag transparency: can an input's tri-state flags reach an output through wires / transparent subchips?
	let mut stack: Vec<Node> = d.input_ids.iter().map(|&id| Node::DevIn(id)).collect();
	let mut seen: FSet<Node> = stack.iter().copied().collect();
	let mut transparent = false;
	while let Some(n) = stack.pop() {
		let mut next: Vec<Node> = edges.get(&n).cloned().unwrap_or_default();
		if let Node::SubIn(owner, _) = n {
			let (sd, info) = &subs[&owner];
			if info.flag_transparent {
				next.extend(sd.output_ids.iter().map(|&p| Node::SubOut(owner, p)));
			}
		}
		for m in next {
			if let Node::DevOut(_) = m {
				transparent = true;
			}
			if seen.insert(m) {
				stack.push(m);
			}
		}
	}

	Some(Info { eligible: true, flag_transparent: transparent, cost })
}

fn build_table(e: &mut Engine, name: &str, hash: u64) -> Option<u32> {
	let desc = e.lib.get(name)?;
	let info = desc_info(&e.lib, &mut e.tables.info, &desc, 0);
	if !info.eligible {
		return None;
	}
	let bits: u32 = desc.input_bits.iter().map(|&b| b as u32).sum();
	if bits > MAX_INPUT_BITS {
		return None;
	}
	// Only worth it if simulating the internals costs more than a lookup
	let io = (desc.input_ids.len() + desc.output_ids.len()) as u64;
	if info.cost < 2 * io + 8 {
		return None;
	}
	let rows = 1u64 << bits;
	if rows * info.cost > MAX_BUILD_WORK {
		return None;
	}
	let n_out = desc.output_ids.len();
	let bytes = rows as usize * n_out * 4;
	if e.tables.bytes + bytes > MAX_TOTAL_BYTES {
		return None;
	}

	let t0 = now_ms();
	// Simulate the chip on its own for every input combination (nested chips use their own tables)
	let mut tmp = Engine::new(e.rng.next_u64());
	tmp.lib = e.lib.clone();
	tmp.use_tables = e.use_tables;
	tmp.tables = std::mem::take(&mut e.tables);
	let result = (|| {
		tmp.apply(crate::desc::Command::BuildRoot { desc: (*desc).clone() }).ok()?;
		let root = tmp.root as usize;
		let inputs = tmp.chips[root].inputs.clone();
		let outputs = tmp.chips[root].outputs.clone();
		if inputs.len() != desc.input_bits.len() || outputs.len() != n_out {
			return None;
		}
		let mut data = vec![0u32; rows as usize * n_out];
		for row in 0..rows as u32 {
			let mut shift = 0;
			for (k, &p) in inputs.iter().enumerate() {
				let b = desc.input_bits[k] as u32;
				tmp.hot.state[p as usize] = (row >> shift) & ((1u32 << b) - 1);
				shift += b;
			}
			tmp.run_step(0.0);
			tmp.sync_state();
			for (j, &o) in outputs.iter().enumerate() {
				data[row as usize * n_out + j] = tmp.hot.state[o as usize];
			}
		}
		Some(data)
	})();
	e.tables = std::mem::take(&mut tmp.tables);
	let data = result?;
	e.tables.bytes += bytes;
	e.tables.build_ms += now_ms() - t0;
	let _ = hash;
	e.tables.tables.push(Table { n_out, in_bits: desc.input_bits.clone(), data, flag_sensitive: info.flag_transparent, name: name.to_string() });
	Some(e.tables.tables.len() as u32 - 1)
}

#[cfg(not(target_arch = "wasm32"))]
fn now_ms() -> f64 {
	use std::time::{SystemTime, UNIX_EPOCH};
	SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs_f64() * 1000.0).unwrap_or(0.0)
}

#[cfg(target_arch = "wasm32")]
fn now_ms() -> f64 {
	0.0
}

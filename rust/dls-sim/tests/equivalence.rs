//! Equivalence tests: the compiled fast path (with and without truth tables) must behave exactly like the
//! reference hierarchical step (a direct port of Simulator.StepChip) on the original's test project chips.
use dls_sim::desc::{Command, SimChipDesc};
use dls_sim::rng::XorShift;
use dls_sim::Engine;

fn library() -> Vec<SimChipDesc> {
	let text = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/testdata/maintest_lib.json")).unwrap();
	serde_json::from_str(&text).unwrap()
}

fn engine(lib: &[SimChipDesc], root: &str, seed: u64, fast: bool, tables: bool) -> Engine {
	let mut e = Engine::new(seed);
	e.use_fast_path = fast;
	e.use_tables = tables;
	e.ctx.steps_per_clock = 3;
	e.apply(Command::LibrarySet { descs: lib.to_vec(), replace_all: true }).unwrap();
	let desc = lib.iter().find(|d| d.name == root).unwrap().clone();
	e.apply(Command::BuildRoot { desc }).unwrap();
	e
}

fn random_inputs(desc: &SimChipDesc, rng: &mut XorShift) -> Vec<(i32, u32)> {
	desc.input_ids.iter().zip(&desc.input_bits).map(|(&id, &b)| (id as i32, rng.next_u32() & ((1u32 << b) - 1))).collect()
}

fn root_outputs(e: &mut Engine) -> Vec<u32> {
	e.sync_state();
	e.chips[e.root as usize].outputs.iter().map(|&p| e.hot.state[p as usize]).collect()
}

#[test]
fn fast_path_matches_reference_bit_for_bit() {
	let lib = library();
	let customs: Vec<&SimChipDesc> = lib.iter().filter(|d| d.chip_type == 0).collect();
	let mut total_swaps = 0;
	for d in customs {
		let mut a = engine(&lib, &d.name, 7, false, false);
		let mut b = engine(&lib, &d.name, 7, true, false);
		let mut rng = XorShift::new(99);
		for step in 0..400 {
			if step % 7 == 0 {
				let ins = random_inputs(d, &mut rng);
				a.set_inputs(&ins);
				b.set_inputs(&ins);
			}
			// Edit the circuit now and then (remove + re-add a wire): forces an order pass, which reads the ready
			// counters that the fast path reconstructs instead of tracking
			if step % 150 == 149 {
				if let Some(w) = d.wires.first() {
					for e in [&mut a, &mut b] {
						e.apply(Command::RemoveConnection { target: vec![], source: w.source, dest: w.target }).unwrap();
						e.apply(Command::AddConnection { target: vec![], source: w.source, dest: w.target }).unwrap();
					}
				}
			}
			a.run_step(0.0);
			b.run_step(0.0);
			b.sync_state();
			assert_eq!(a.hot.state, b.hot.state, "{}: pin states differ at step {step}", d.name);
			// Ready counters are only maintained on hierarchical frames by the fast engine
			if b.frame() % 100 == 1 {
				assert_eq!(a.hot.ready, b.hot.ready, "{}: ready counters differ at step {step}", d.name);
			}
			if step % 50 == 0 {
				assert_eq!(a.hot.latest_id.len(), b.hot.latest_id.len());
			}
		}
		for (x, y) in a.chips.iter().zip(&b.chips) {
			assert_eq!(x.internal, y.internal, "{}: internal state differs", d.name);
			assert_eq!(x.subchips, y.subchips, "{}: traversal order differs", d.name);
		}
		total_swaps += b.stat_swaps;
	}
	println!("dynamic reorder swaps patched into programs: {total_swaps}");
}

#[test]
fn truth_tables_give_identical_outputs_on_combinational_chips() {
	let lib = library();
	for name in ["XOR", "ADDER", "ADDER-4", "ADDER-8", "ALU-8", "ALU", "DECODE-3", "MUX-8", "EQUALS-8", "LSHIFT-8", "DOUBLE DABBLE", "DABBLE", "7-SEGMENT DRIVER", "AND-8", "OR-8", "NOT-8"] {
		let Some(d) = lib.iter().find(|d| d.name == name) else { continue };
		let mut a = engine(&lib, name, 1, false, false);
		let mut b = engine(&lib, name, 2, true, true);
		let mut rng = XorShift::new(5);
		for step in 0..600 {
			let ins = random_inputs(d, &mut rng);
			a.set_inputs(&ins);
			b.set_inputs(&ins);
			a.run_step(0.0);
			b.run_step(0.0);
			assert_eq!(root_outputs(&mut a), root_outputs(&mut b), "{name}: outputs differ at step {step}");
		}
		println!("{name}: {} tabled instances, tables: {:?}", b.program.tabled_chips, b.tables.tables.iter().map(|t| format!("{}({}b)", t.name, t.in_bits.iter().map(|&x| x as u32).sum::<u32>())).collect::<Vec<_>>());
	}
}

/// Behavioural tests mirroring tests/chips.test.ts, with tables enabled
fn run(e: &mut Engine, d: &SimChipDesc, vals: &[u32], steps: u32) -> Vec<u32> {
	let ins: Vec<(i32, u32)> = d.input_ids.iter().zip(vals).map(|(&id, &v)| (id as i32, v)).collect();
	e.set_inputs(&ins);
	for _ in 0..steps {
		e.run_step(0.0);
	}
	root_outputs(e).iter().map(|s| s & 0xffff).collect()
}

#[test]
fn sequential_chips_with_tables() {
	let lib = library();
	let get = |n: &str| lib.iter().find(|d| d.name == n).unwrap().clone();

	let d = get("REGISTER-8");
	let mut e = engine(&lib, "REGISTER-8", 3, true, true);
	let clock = |e: &mut Engine, data: u32, store: u32| {
		run(e, &d, &[data, store, 0], 40);
		run(e, &d, &[data, store, 1], 40);
		run(e, &d, &[data, store, 0], 40)[0]
	};
	assert_eq!(clock(&mut e, 173, 1), 173);
	assert_eq!(clock(&mut e, 42, 0), 173);
	assert_eq!(clock(&mut e, 42, 1), 42);

	let d = get("PC");
	let mut e = engine(&lib, "PC", 4, true, true);
	let tick = |e: &mut Engine, inp: u32, store: u32, inc: u32, reset: u32| {
		run(e, &d, &[inp, store, 0, inc, reset], 80);
		run(e, &d, &[inp, store, 1, inc, reset], 80);
		run(e, &d, &[inp, store, 0, inc, reset], 80)[0]
	};
	tick(&mut e, 0, 0, 0, 1);
	assert_eq!(tick(&mut e, 0, 0, 0, 0), 0);
	assert_eq!(tick(&mut e, 0, 0, 1, 0), 1);
	assert_eq!(tick(&mut e, 0, 0, 1, 0), 2);
	assert_eq!(tick(&mut e, 50, 1, 0, 0), 50);
	assert_eq!(tick(&mut e, 0, 0, 1, 0), 51);
	assert_eq!(tick(&mut e, 0, 0, 0, 1), 0);

	let d = get("RAM-sync");
	let mut e = engine(&lib, "RAM-sync", 5, true, true);
	let write = |e: &mut Engine, addr: u32, data: u32| {
		run(e, &d, &[1, 0, addr, data], 60);
		run(e, &d, &[1, 1, addr, data], 60);
		run(e, &d, &[0, 0, addr, data], 60);
	};
	write(&mut e, 3, 99);
	write(&mut e, 200, 7);
	write(&mut e, 3, 12);
	assert_eq!(run(&mut e, &d, &[0, 0, 3, 0], 60)[0], 12);
	assert_eq!(run(&mut e, &d, &[0, 0, 200, 0], 60)[0], 7);
}

#[test]
fn swap_patching_matches_recompile() {
	let lib = library();
	for (name, tables) in [("RAM-sync", false), ("ALU-8", true), ("PC", true)] {
		let mut e = engine(&lib, name, 11, true, tables);
		for _ in 0..3 {
			e.run_step(0.0);
		}
		assert!(!e.program_dirty);
		let mut rng = XorShift::new(3);
		// Apply many random adjacent swaps at all levels of the hierarchy, patching the program each time
		let candidates: Vec<u32> = (0..e.chips.len() as u32).filter(|&c| e.chips[c as usize].subchips.len() >= 2).collect();
		for _ in 0..2000 {
			let c = candidates[rng.below(candidates.len())] as usize;
			let n = e.chips[c].subchips.len();
			let i = 1 + rng.below(n - 1);
			let (first, second) = (e.chips[c].subchips[i], e.chips[c].subchips[i - 1]);
			e.chips[c].subchips.swap(i, i - 1);
			assert!(e.program.swap_units(&e.chips, first, second));
		}
		let normalized = |p: &dls_sim::program::Program| -> Vec<String> {
			p.raw
				.iter()
				.map(|op| match op {
					dls_sim::program::Op::Table { inst, skip } => {
						let ti = &p.table_insts[*inst as usize];
						format!("Table {} {:?} {:?} {skip}", ti.table, ti.raw_inputs, ti.outputs)
					}
					o => format!("{o:?}"),
				})
				.collect()
		};
		let patched = normalized(&e.program);
		let root_inputs = e.chips[e.root as usize].inputs.clone();
		e.program.optimize(&e.chips, e.pins.len(), &root_inputs);
		let patched_opt = format!("{:?} {:?}", e.program.ops.len(), e.program.aliases);
		e.compile();
		assert!(patched == normalized(&e.program), "{name}: patched program differs from recompiled");
		assert_eq!(patched_opt, format!("{:?} {:?}", e.program.ops.len(), e.program.aliases), "{name}: optimization differs");
	}
}

#[test]
#[ignore]
fn op_stats() {
	let lib = library();
	for name in ["RAM-sync", "WIP2"] {
		let mut e = engine(&lib, name, 1, true, true);
		for _ in 0..3 {
			e.run_step(0.0);
		}
		let mut counts = std::collections::BTreeMap::new();
		println!("{name}: raw ops {}, optimized ops {}, aliased pins {}", e.program.raw.len(), e.program.ops.len(), e.program.aliases.len());
		for op in &e.program.ops {
			let k = format!("{op:?}");
			let k = k.split(' ').next().unwrap().to_string();
			*counts.entry(k).or_insert(0) += 1;
		}
		let builtins: std::collections::BTreeMap<u8, usize> = e.program.ops.iter().filter_map(|op| if let dls_sim::program::Op::Builtin { chip } = op { Some(e.chips[*chip as usize].chip_type) } else { None }).fold(Default::default(), |mut m, t| { *m.entry(t).or_insert(0) += 1; m });
		println!("{name}: {} pins, {} chips, ops {:?}, builtin types {:?}", e.pins.len(), e.chips.len(), counts, builtins);
		for _ in 0..500 {
			e.run_step(0.0);
		}
		let mut per_table: std::collections::BTreeMap<String, (u64, u64, u32)> = Default::default();
		for ti in &e.program.table_insts {
			let r = per_table.entry(e.tables.tables[ti.table as usize].name.clone()).or_default();
			r.0 += ti.hits as u64;
			r.1 += ti.misses as u64;
			r.2 += 1;
		}
		println!("  table (hits, misses, instances): {per_table:?}");
	}
}

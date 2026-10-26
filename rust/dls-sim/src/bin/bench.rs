//! Native benchmark: steps/second on chips from the original's test project, in three modes:
//! reference (hierarchical step, like the TS/C# simulator), fast (compiled flat program), fast + truth tables.
//! Run: cargo run --release --bin bench [chip names...]
use dls_sim::desc::{Command, SimChipDesc};
use dls_sim::Engine;
use std::time::Instant;

fn main() {
	let text = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/testdata/maintest_lib.json")).unwrap();
	let lib: Vec<SimChipDesc> = serde_json::from_str(&text).unwrap();
	let args: Vec<String> = std::env::args().skip(1).collect();
	let names: Vec<String> = if args.is_empty() { ["ALU-8", "PC", "demo", "WIP2", "RAM-sync"].iter().map(|s| s.to_string()).collect() } else { args };

	println!("{:<10} {:>14} {:>14} {:>16} {:>14}", "chip", "reference", "fast", "fast+tables", "table build");
	for name in &names {
		let desc = lib.iter().find(|d| &d.name == name).expect("chip not found").clone();
		let mut row = Vec::new();
		let mut build_ms = 0.0;
		for (fast, tables) in [(false, false), (true, false), (true, true)] {
			let mut e = Engine::new(42);
			e.use_fast_path = fast;
			e.use_tables = tables;
			e.ctx.steps_per_clock = 250;
			e.apply(Command::LibrarySet { descs: lib.clone(), replace_all: true }).unwrap();
			e.apply(Command::BuildRoot { desc: desc.clone() }).unwrap();
			let mut t = 0u32;
			let set_inputs = |e: &mut Engine, t: u32| {
				let ins: Vec<(i32, u32)> = desc
					.input_ids
					.iter()
					.zip(&desc.input_bits)
					.enumerate()
					.map(|(i, (&id, &b))| {
						let v = (t.wrapping_mul(37) + i as u32 * 11) & 0xff;
						(id as i32, v & ((1u32 << b) - 1))
					})
					.collect();
				e.set_inputs(&ins);
			};
			// Warm up (includes order pass, compile and table building)
			let t0 = Instant::now();
			set_inputs(&mut e, 0);
			for _ in 0..3 {
				e.run_step(0.0);
			}
			if tables {
				build_ms = t0.elapsed().as_secs_f64() * 1000.0;
			}
			// Measure for ~1.5 s: 100 steps per input change (same pattern as tests/sim.bench.ts)
			let start = Instant::now();
			let mut steps = 0u64;
			while start.elapsed().as_secs_f64() < 1.5 {
				t += 1;
				set_inputs(&mut e, t);
				for _ in 0..100 {
					e.run_step(0.0);
				}
				steps += 100;
			}
			row.push(steps as f64 / start.elapsed().as_secs_f64());
		}
		println!("{:<10} {:>14.0} {:>14.0} {:>16.0} {:>11.0} ms", name, row[0], row[1], row[2], build_ms);
	}
}

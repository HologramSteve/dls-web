//! WebAssembly interface (plain C ABI, no bindings generator needed). Used by src/worker/wasmEngine.ts.
//! Data is exchanged through linear memory: JS writes input buffers allocated with `dls_alloc`, results are
//! written to an output buffer whose pointer is returned by `dls_out_ptr`.
#![allow(static_mut_refs)]
use crate::desc::Command;
use crate::engine::Engine;

static mut ENGINE: Option<Engine> = None;
static mut OUT: Vec<i32> = Vec::new();
static mut ERR: String = String::new();

fn engine() -> &'static mut Engine {
	unsafe { ENGINE.get_or_insert_with(|| Engine::new(0x1234_5678)) }
}

unsafe fn slice<'a, T>(p: *const T, n: usize) -> &'a [T] {
	if n == 0 {
		&[]
	} else {
		std::slice::from_raw_parts(p, n)
	}
}

#[no_mangle]
pub extern "C" fn dls_alloc(len: usize) -> *mut u8 {
	let mut v = Vec::<u8>::with_capacity(len.max(1));
	let p = v.as_mut_ptr();
	std::mem::forget(v);
	p
}

#[no_mangle]
pub unsafe extern "C" fn dls_free(p: *mut u8, len: usize) {
	drop(Vec::from_raw_parts(p, 0, len.max(1)));
}

#[no_mangle]
pub extern "C" fn dls_init(seed_lo: u32, seed_hi: u32, now_ms: f64) {
	unsafe {
		ENGINE = Some(Engine::new(((seed_hi as u64) << 32) | seed_lo as u64));
	}
	engine().reset_time(now_ms);
}

/// Apply a JSON array of SimModifyCommand. Returns the number of commands that failed (message: dls_error_*).
#[no_mangle]
pub unsafe extern "C" fn dls_apply_commands(p: *const u8, len: usize) -> u32 {
	let text = std::str::from_utf8(slice(p, len)).unwrap_or("[]");
	let cmds: Vec<serde_json::Value> = match serde_json::from_str(text) {
		Ok(v) => v,
		Err(e) => {
			ERR = format!("Invalid command JSON: {e}");
			return 1;
		}
	};
	let mut failed = 0;
	for v in cmds {
		let r = serde_json::from_value::<Command>(v).map_err(|e| e.to_string()).and_then(|c| engine().apply(c).map_err(|e| e.0));
		if let Err(msg) = r {
			ERR = msg;
			failed += 1;
		}
	}
	failed
}

#[no_mangle]
pub extern "C" fn dls_error_ptr() -> *const u8 {
	unsafe { ERR.as_ptr() }
}

#[no_mangle]
pub extern "C" fn dls_error_len() -> usize {
	unsafe { ERR.len() }
}

/// Player input pin states: pairs of (dev pin ID, state)
#[no_mangle]
pub unsafe extern "C" fn dls_set_inputs(p: *const i32, n_pairs: usize) {
	let s = slice(p, n_pairs * 2);
	let pairs: Vec<(i32, u32)> = s.chunks_exact(2).map(|c| (c[0], c[1] as u32)).collect();
	engine().set_inputs(&pairs);
}

/// Character codes of currently held keys
#[no_mangle]
pub unsafe extern "C" fn dls_set_keys(p: *const u32, n: usize) {
	let e = engine();
	e.ctx.held_keys.clear();
	e.ctx.held_keys.extend(slice(p, n).iter().copied());
}

#[no_mangle]
pub extern "C" fn dls_set_steps_per_clock(n: u32) {
	engine().ctx.steps_per_clock = n;
}

#[no_mangle]
pub extern "C" fn dls_set_options(fast_path: u32, tables: u32) {
	let e = engine();
	e.use_fast_path = fast_path != 0;
	if e.use_tables != (tables != 0) {
		e.use_tables = tables != 0;
		e.program_dirty = true;
	}
}

#[no_mangle]
pub unsafe extern "C" fn dls_set_view(p: *const i32, n: usize) {
	engine().set_view_path(slice(p, n));
}

#[no_mangle]
pub extern "C" fn dls_run(steps: u32, now_ms: f64) {
	let e = engine();
	for _ in 0..steps {
		e.run_step(now_ms);
	}
}

#[no_mangle]
pub extern "C" fn dls_update_paused(now_ms: f64) {
	engine().update_in_paused_state(now_ms);
}

#[no_mangle]
pub extern "C" fn dls_frame() -> u32 {
	engine().frame()
}

#[no_mangle]
pub extern "C" fn dls_out_ptr() -> *const i32 {
	unsafe { OUT.as_ptr() }
}

/// Pin states of the chip at `path` (and its subchips). Returns output length, or -1 if the path is invalid.
/// Layout: [chipID, numSubchips, subchipIDs..., then 5 ints per pin: ownerID, pinID, state, latestSourceID, latestSourceParentID]
#[no_mangle]
pub unsafe extern "C" fn dls_snapshot_view(p: *const i32, n: usize) -> i32 {
	let e = engine();
	let Some(c) = e.resolve_path(slice(p, n)) else { return -1 };
	OUT.clear();
	let ch = &e.chips[c as usize];
	OUT.push(ch.id);
	OUT.push(ch.subchips.len() as i32);
	for &s in &ch.subchips {
		OUT.push(e.chips[s as usize].id);
	}
	let h = &e.hot;
	let write = |owner: i32, pin_id: i32, pi: u32| {
		OUT.extend_from_slice(&[owner, pin_id, h.state[pi as usize] as i32, h.latest_id[pi as usize], h.latest_parent[pi as usize]]);
	};
	for &pi in ch.inputs.iter().chain(ch.outputs.iter()) {
		write(e.pins[pi as usize].id, 0, pi);
	}
	for &s in &ch.subchips {
		let sc = &e.chips[s as usize];
		for &pi in sc.inputs.iter().chain(sc.outputs.iter()) {
			write(sc.id, e.pins[pi as usize].id, pi);
		}
	}
	OUT.len() as i32
}

/// Display data of the chip at `path`: [numInputs, input states..., internal state...]. Returns length or -1.
#[no_mangle]
pub unsafe extern "C" fn dls_display(p: *const i32, n: usize) -> i32 {
	let e = engine();
	let Some(c) = e.resolve_path(slice(p, n)) else { return -1 };
	OUT.clear();
	let ch = &e.chips[c as usize];
	OUT.push(ch.inputs.len() as i32);
	for &pi in &ch.inputs {
		OUT.push(e.hot.state[pi as usize] as i32);
	}
	OUT.extend(ch.internal.iter().map(|&x| x as i32));
	OUT.len() as i32
}

/// Returns 1 if audio amplitudes changed since the last call (read them from dls_audio_ptr: 256 f64)
#[no_mangle]
pub extern "C" fn dls_audio_dirty() -> u32 {
	let a = &mut engine().ctx.audio;
	let d = a.dirty;
	a.dirty = false;
	d as u32
}

#[no_mangle]
pub extern "C" fn dls_audio_ptr() -> *const f64 {
	engine().ctx.audio.target.as_ptr()
}

/// [tabled chip instances, number of tables, table bytes, program ops]
#[no_mangle]
pub extern "C" fn dls_stats() -> *const i32 {
	let e = engine();
	unsafe {
		OUT.clear();
		OUT.extend_from_slice(&[e.program.tabled_chips as i32, e.tables.tables.len() as i32, e.tables.bytes as i32, e.program.ops.len() as i32]);
		OUT.as_ptr()
	}
}

# Rust simulation engine (`rust/dls-sim`)

A second implementation of the simulator in Rust, compiled to WebAssembly and used by the simulation worker by
default. It has the **same semantics** as the TypeScript port of the original simulator
(`src/dls/simulation/Simulator.ts`) and is 20–86× faster (see [performance.md](performance.md)).

The TypeScript simulator stays in the code base as the faithful reference port and as a fallback. Choose the engine
in the main menu SETTINGS screen, in a section marked "WEB VERSION ONLY (not in the original)": Sim engine
RUST (FAST) / JS (ORIGINAL), and Truth tables ON / OFF. Applying restarts the simulation worker. `?engine=js|rust`
and `?tables=0|1` in the page URL override the setting.

## Layout

| File | Contents |
| --- | --- |
| `src/engine.rs` | Arena-based port of `Simulator` / `SimChip` / `SimPin`: building chips, modification commands, `ReceiveInput` (incl. tri-state conflict resolution), all builtin chips, and the hierarchical `StepChip` / `StepChipReorder`, which are line-by-line ports and serve as the reference. |
| `src/program.rs` | The compiled flat program (fast path), program patching, the copy-aliasing pass. |
| `src/tables.rs` | Truth tables for combinational custom chips. |
| `src/desc.rs` | Chip descriptions and commands, in the same JSON as the TS side (`SimChipDesc`, `SimModifyCommand`). |
| `src/audio.rs`, `src/rng.rs` | `SimAudio` port; the original's PCG `RandomBool` plus an xorshift generator replacing `Math.random`. |
| `src/api.rs` | WebAssembly interface: a plain C ABI, so no bindings generator is needed. Wrapped by `WasmEngine` in `src/worker/engines.ts`. |
| `src/bin/bench.rs` | Native benchmark. |
| `tests/equivalence.rs` | Equivalence tests (see below). |
| `testdata/maintest_lib.json` | Builtin chips and the original's MainTest chips as `SimChipDesc` (regenerate with `bun scripts/dumpSimLibrary.ts`). |

Commands:

```sh
bun run build:wasm   # builds and copies the module to src/worker/dls_sim.wasm (committed, so the web build needs no Rust)
bun run test:rust    # native tests
bun run bench:rust   # native benchmark
```

Toolchain: stable Rust plus the `wasm32-unknown-unknown` target (`rustup target add wasm32-unknown-unknown`).

## How it is fast and still exact

The original simulator walks the chip tree every step:
1. It propagates a chip's input pins.
2. It processes the subchips in a cached order, recursing into custom chips.
3. It propagates each subchip's output pins.

Except on special frames, this order never changes. The Rust engine therefore compiles the walk once into a flat
list of operations and replays it.

1. **Flat program** (`program.rs`).
   - Each wire becomes one op. A wire into a pin with a single connection becomes a plain `Copy`; such a pin always
     accepts its input, so no conflict handling is needed.
   - Pins with several connections use the full `ReceiveInput`, including the random OR/AND choice for conflicts.
   - NAND gates get their own op; other builtin chips call the same code as the reference.
   - The program performs exactly the operations `StepChip` would, in the same order.

2. **Special frames use the reference step.** These are the frame after any edit (the order pass) and every 100th
   frame (the original's random "dynamic reorder" of chips that aren't ready).
   - On these frames the engine runs the hierarchical reference step.
   - If a dynamic reorder swaps two adjacent subchips, their blocks in the program are rotated instead of
     recompiling everything.

3. **Ready counters are not tracked on fast frames.**
   - `numInputsReady` is only read on special frames.
   - After a frame of the program, its value is fixed by the program order: it is the number of a chip's inputs that
     complete after the chip ran, i.e. feedback inputs. This is computed when the program is compiled (`late_ready`)
     and restored before a special frame.

4. **Copy aliasing** (`Program::optimize`).
   - A copy `s → d` is removed when:
     - `d` is written only by that copy;
     - the source's value is written once per frame at position W before the copy;
     - nothing reads `d` between W and the copy.
   - Readers of `d` then read the source directly.
   - Stored values of removed pins are filled in (`materialize`) before anything outside the program reads pin
     states: snapshots, displays, special frames and table building.
   - This removes about 65% of the ops in large circuits.

5. **Truth tables** (`tables.rs`). A custom chip type gets a table when all of these hold:
   - Recursively, it contains only NAND and split/merge chips.
   - No pin inside it has more than one incoming wire.
   - Its subchips form no loop.
   - It has at most 16 input bits.

   For such chips the original also evaluates all internals in dependency order within the chip's turn. The outputs
   are therefore a pure function of the current input pin states, and the lookup is **exact**, not a "settled
   state" approximation.

   How lookups are handled:
   - Tables are built when first needed, by simulating the chip in a temporary engine for every input combination.
     Nested chips use their own tables.
   - A `Table` op writes the outputs and skips the chip's block.
   - **Tri-state inputs.** If tri-state flags on an input could reach an output (through wires or split/merge only),
     the lookup is used only while all input flags are clear. Otherwise the block is simulated normally.
   - **Tables that rarely apply.** A table op whose inputs are usually tri-stated switches itself off.
   - **Viewed chips.** Chips on the path of the currently viewed chip never use tables, because their internal pins
     are drawn.
   - **Instance check.** An instance is only tabled if its description's structural hash still matches the library,
     and it hasn't been edited since.
   - **Cost limits.** A chip is only tabled when simulating it costs more than a lookup. There are also caps: 2²⁸
     simulated ops to build one table, and 256 MB of tables in total.

Results are bit-identical to the reference step. Only the random sources differ from the TS engine: `Math.random`
is replaced by xorshift, and the per-frame PCG seed comes from it. They are random in the original too.

## Verification

- `tests/equivalence.rs` (Rust):
  - On every chip of the original's test project, with random inputs and periodic edits, the fast path matches the
    reference step bit for bit: every pin state every step, ready counters, internal state, traversal order.
  - Tables give identical outputs on combinational chips.
  - Sequential chips work with tables on: register, program counter, RAM.
  - Patched programs equal recompiled ones after 2000 random swaps.
- `tests/engines.test.ts` (Vitest, loads the real `.wasm`): the same behavioural tests on the JS engine, Rust with
  tables, Rust without tables, and the Rust reference step. Also a step-by-step comparison of Rust with tables
  against the JS engine on ALU-8, BCD, mux, equals, 7-segment driver and decoder.
- `scripts/e2e.cjs` (browser): checks which engine the worker uses, and reports RAM-sync steps/s in the browser.

## Benchmarks

See [performance.md](performance.md) for all measurements: WebAssembly vs JS, native step by step, in-app, and how to
reproduce them. Summary, in steps per second (WebAssembly, one core):

| Circuit | JS engine | Rust | Rust + truth tables |
| --- | --- | --- | --- |
| ALU-8 (317 NANDs) | 21,783 | 439,254 | 719,394 (33×) |
| demo (1,084 NANDs) | 6,021 | 242,308 | 520,495 (86×) |
| PC (1,216 NANDs) | 5,353 | 202,621 | 350,493 (65×) |
| WIP2 (5,709 NANDs) | 705 | 34,541 | 54,089 (77×) |
| RAM-sync (23,989 NANDs) | 164 | 3,526 (21×) | 3,505 |

## Limitations / notes

- **A Rust panic can't be recovered.** The module is built with `panic = "abort"`, so a panic traps the WebAssembly
  instance, and the worker can't switch engines mid-session. Reload with `?engine=js` if that ever happens.
- **Tables are built synchronously** when a chip is first compiled, which can pause the worker briefly on load.
- **Changing semantics.** When the simulator semantics change (e.g. porting an upstream fix to `Simulator.ts`),
  apply the same change in `engine.rs`. Then rebuild the module with `bun run build:wasm` and run both test suites.

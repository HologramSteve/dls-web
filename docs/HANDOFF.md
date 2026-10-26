# Handoff / status (read first)

Web port of SebLague/Digital-Logic-Sim (Unity C#, v2.1.6): TypeScript + WebGL2 + a simulation Web Worker, no game
engine. A Rust simulation engine, compiled to WebAssembly, is the default and is 20–86× faster.

- Original source for reference: `git clone --depth 1 https://github.com/SebLague/Digital-Logic-Sim /tmp/dls`
  (scripts in `Assets/Scripts/{Seb,Simulation,Description,SaveSystem,Game,Graphics}`).
- Docs:
  - `docs/porting.md`: how the port and the Rust engine were made.
  - `docs/architecture.md`: runtime structure.
  - `docs/rust-engine.md`: engine design and why it is exact.
  - `docs/performance.md`: benchmarks.

## Current state (2026-10-26)

- **Branches:** `main` and `claude/blissful-brahmagupta-8yaivk` are identical; everything is merged. Work on the
  branch, then fast-forward `main` when asked.
- **Tooling:** Bun (`bun.lock`; `packageManager: bun@1.4.4`). CI (`.github/workflows/ci.yml`) has two jobs:
  - `check`: bun install, typecheck, lint, test, build;
  - `rust`: cargo test, then the WebAssembly build.

  Both are green on `main`.
- **Checks:** `bun run check` (55 Vitest tests), `bun run test:rust` (4 tests + 1 ignored stats test),
  `bun run e2e`, and `bun scripts/e2e-features.cjs` all pass.

### Port (phase 1): complete
All original C# files are ported: Seb lib, Description, SaveSystem, Simulation, Game, and Graphics with every menu.

Verified in headless Chromium (Playwright):
- **Projects and storage:**
  - main menu, new/open project;
  - persistence (IndexedDB);
  - import of `testdata/Projects/MainTest`;
  - zip export/import round trip;
  - project duplicate/rename/delete/open.
- **Building and simulating:**
  - placing and wiring chips, NAND truth table;
  - Ctrl+S save and using the saved chip inside another;
  - view mode, undo/redo, delete.
- **Customize:** resize handles, placing a display on a chip.
- **Library:** move, star, new collection, jump chip, delete chip (a backup goes to "Deleted Chips", as in the
  original).
- **Every display/IO builtin:**
  - ROM editor and its display modes;
  - all context actions: pulse width, LED colour, key rebind, bus flip, label;
  - an RGB display driven by the simulation.
- **Settings:** the preferences menu, and the engine switch.

### Rust engine (phase 2): complete
`rust/dls-sim`, compiled to `src/worker/dls_sim.wasm`, which is committed.
- **Exactness:** same semantics as `src/dls/simulation/Simulator.ts`. The compiled fast path is tested bit for bit
  against a reference port of `StepChip`.
- **Speed:**
  - compiled flat program;
  - "ready" counters reconstructed instead of tracked;
  - copy-aliasing pass;
  - dynamic-reorder swaps patched into the program instead of recompiling.
- **Truth tables:** exact tables for combinational chips (≤ 16 input bits; cost/size limits in `tables.rs`).
- **In the worker:** `src/worker/engines.ts` defines `SimEngine`, with `JsEngine` and `WasmEngine`. The worker
  waits for an `init` message, reports `{type:"engine"}`, and runs steps in adaptive batches.
- **Engine choice:**
  - Main menu SETTINGS, section "WEB VERSION ONLY (not in the original)". This stores
    `AppSettings.Web_SimEngine` / `Web_TruthTables`, and `SimHost.ConfigureEngine` restarts the worker.
  - URL parameters `?engine=js|rust` and `?tables=0|1` override the setting.
- **Results:** in Node/WebAssembly, ALU-8 runs 33× faster than JS and RAM-sync 21×. In the browser, RAM-sync runs
  at about 3,900 steps/s vs 235. See `docs/performance.md` and `docs/benchmarks.json`.

### Web-specific additions / deviations (keep documented here)
- **Test hook.** `src/main.ts` is UnityMain (the requestAnimationFrame loop). It exposes `window.dls` (Project,
  WorldCam, UIDrawer, IS, Main, Draw, SimHost) for browser tests.
- **Import/export.** On the main menu, "QUIT" is replaced by "IMPORT": zip(s) of projects, or hold Shift to pick a
  folder. The open-project screen has an extra "EXPORT" button. Code: `src/dls/saveSystem/ProjectTransfer.ts`.
- **Display settings.** Only fullscreen on/off is applied. The default AppSettings fullscreenMode is Windowed (3).
  Fullscreen is applied only on APPLY, because it needs a user gesture.
- **Engine settings.** The web-only engine settings are described above. The settings panel starts higher to fit
  them.
- **Simulation in a worker.** `Project.SyncWithSimulation` replaces the original's sim-thread frame sync.
  `Project.NotifyExit` replaces the worker's root with an empty chip.
- **Worker pacing.** The worker sleeps between batches instead of busy-waiting.
- **Input.** A press and release within one frame delivers the release on the next frame (`InputHelper`).
- **ROM "PASTE ALL"** uses `navigator.clipboard.readText`, falling back to the next Ctrl+V paste event.
- **Audio** uses an AudioWorklet, started on the first pointer or key press.
- **Reserved shortcuts.** Ctrl+N / Ctrl+Q / Ctrl+W can't be intercepted; use the MENU popup buttons.

### Known issues / next steps
1. **Rendering speed on real GPUs isn't verified.** In headless Chromium with software GL, rendering runs at about
   4–20 fps because the bezier text shader is expensive on a CPU. If needed: a text atlas, or skipping curves by
   bounding box.
2. **Untested interactively:**
   - preference toggles taking effect (grid, pause);
   - dot-display visuals;
   - buzzer sound on real speakers;
   - the import/export file-picker and download UI (the underlying logic is tested).
3. **Possible engine work:**
   - a dedicated exact op for latch patterns, since RAM-sync is latch-bound;
   - multi-worker simulation for very large circuits;
   - building tables asynchronously, since table building briefly blocks the worker on load (2–60 ms per circuit).
4. **Test hooks.** Remove the `window.dls` hook and the `Draw.Debug*` getters if undesired (they're harmless).

### Gotchas for the next session
- **Never edit source files while a browser test runs.** Vite reloads the page and the test fails with "project
  closed" errors. That's not an app bug.
- **Don't `pkill -f "vite …"` inside a compound command.** It matches and kills its own shell. Start the dev server
  as a separate background command (`bun run dev`).
- **Browser tests are slow.** Headless frames are slow, so waits must be at least 300 ms between input events, and
  `e2e-features.cjs` takes about 8 minutes. Context menus open upward near the bottom of the screen.
- **Changing the simulator means changing it twice.** Change `Simulator.ts` and `engine.rs` together, then
  `bun run build:wasm`, `bun run test:rust` and `bun run test`. Regenerate the Rust test fixture with
  `bun scripts/dumpSimLibrary.ts` if builtin chips change.
- **Benchmarks.** Update `docs/benchmarks.json` by hand after re-running the benchmarks, then run
  `bun scripts/perfChart.ts`.
- **Release-profile panic.** The release profile has no `panic = "abort"`; the separate `wasm` profile does. With
  abort in the release profile, cargo builds the library twice and the tests fail with serde trait errors.

## Porting conventions (important)
- **C# structs.**
  - Vector2 and Color are immutable classes: use `.add` / `.sub` / `.mul`, and `Vector2.eq` for `==`.
  - Plain-object structs must be cloned wherever C# copies then mutates. This covers PinDescription,
    SubChipDescription, DisplayDescription, ProjectDescription, AppSettings, ButtonTheme, InputFieldTheme and
    others.
  - Helpers: `clonePinDescription`, `cloneSubChipDescription`, `copyProjectDescription`, `cloneButtonTheme`,
    `{...theme}`, `ConnectionInfo.clone`.
- **`using (scope)`** becomes `const s = X.Begin...(); try { ... } finally { s.Dispose(); }`.
- **`out` / tuple returns** become TS tuples. **`ref` params** become closures or `{ v }` boxes.
- **Name comparisons** are case-insensitive: `NameMatch` / `NameKey` / `NameSet`.
- **Renamed C# overloads:**
  - Controller: `StartPlacing(desc)` / `StartPlacingByName(name)` / `StartPlacingAt(desc, pos, dup)`.
  - `CanCompleteWireConnection(pin, wire?)` / `CanCompleteWireConnectionToWire(wire)` returns `[bool, pin]`.
  - UI: `DrawPanelBounds`, `ModifyPanelBounds`, `UIToScreenSpaceBounds`, `DrawScrollViewElements`,
    `WheelSelectorIndexed`.
  - GridHelper: `SnapToGridV`, `SnapMovingElementToGridPos`.
- **`UI.Button` signature:** `UI.Button(text, theme, pos, size, enabled, fitTextX, fitTextY, anchor, leftAlign,
  textOffsetX, ignoreInputs)`.
- **Static C# classes** become exported const objects. Enums are exported separately: `MenuType`, `SaveMode`,
  `CancelConfirmResult`.
- **Element type checks** use `instanceof` (SubChipInstance / DevPinInstance / PinInstance / WireInstance) and
  `IsMoveable(x)`.
- **Sim access from the main thread** goes through `SimChipRef` (a path of subchip IDs). Displays read
  `simRef.GetDisplayData()`.
- **PinState values** are int32 in TS and u32 in Rust (same bits).

## Tooling
- `bun run check` runs typecheck + lint (Biome, warnings are errors) + tests. CI also builds, and runs the Rust job.
- Commit and push after every file group (the user's usage is limited). Update this file when the status changes.

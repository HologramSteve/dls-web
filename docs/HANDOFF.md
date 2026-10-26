# Handoff / status (read first)

Faithful port of SebLague/Digital-Logic-Sim (Unity C#, v2.1.6) to TypeScript + WebGL2 + Web Worker. No engine.
Original source for reference: `git clone --depth 1 https://github.com/SebLague/Digital-Logic-Sim /tmp/dls`
(scripts in `Assets/Scripts/{Seb,Simulation,Description,SaveSystem,Game,Graphics}`).
Architecture overview: `docs/architecture.md`. How the port was done + C#→TS mapping: `docs/porting.md`.
Rust simulation engine (WebAssembly, default in the worker): `docs/rust-engine.md`.

## Status
ALL original C# files are ported (Seb lib, Description, SaveSystem, Simulation, Game, Graphics incl. every menu).
`npm run check` (typecheck + lint + tests) is green; no tsconfig excludes remain. The app runs (`npm run dev`).

Verified in headless Chromium (Playwright): main menu, new project, open project, bottom bar + collection popup,
placing chips, wiring, toggling inputs, NAND truth table simulated correctly, persistence across reloads (IndexedDB),
Ctrl+S save of a custom chip (library + auto-star), using it inside another chip (simulates correctly), view mode,
import of `testdata/Projects/MainTest` (ALU-8 and demo with 7-seg displays render + simulate), library / prefs /
customize / context menus render like the original. KEY chip responds to held keys. AudioWorklet starts on first
click. Undo/redo (Ctrl+Z / Ctrl+Shift+Z), select+Delete, zip export->import round trip (ProjectTransfer). Production build (`vite build` + `vite preview`) runs the worker at the 1000 steps/s target.

### Rust simulation engine (added after the port)
`rust/dls-sim`: same semantics as `Simulator.ts` (verified bit-for-bit against a reference port of StepChip), compiled
flat program + exact truth tables for combinational chips; ~25-120x faster than the JS engine in the browser.
The worker uses it by default (`src/worker/engines.ts`); `?engine=js` selects the TS engine, `?tables=0` disables
tables. The built module `src/worker/dls_sim.wasm` is committed; rebuild with `npm run build:wasm` after changing the
Rust code. Tests: `npm run test:rust` + `tests/engines.test.ts`. CI runs both. Details/benchmarks: docs/rust-engine.md.

### Web-specific additions / deviations (keep documented here)
- `src/main.ts` = UnityMain (rAF loop). Exposes `window.dls` (Project, WorldCam, UIDrawer, IS, Main, Draw, SimHost)
  for browser tests.
- Main menu: "QUIT" replaced by "IMPORT" (zip(s) of projects; hold Shift to pick a folder instead). Open-project
  screen has an extra "EXPORT" button (downloads `<name>.zip` in the original folder layout).
  Code: `src/dls/saveSystem/ProjectTransfer.ts` (own minimal zip writer/reader; inflate via DecompressionStream).
- Settings menu: only fullscreen on/off is applied (resolution/vsync are browser controlled). Default AppSettings
  fullscreenMode = Windowed (3). Fullscreen is applied only when the player presses APPLY (needs user gesture).
- Sim runs in a worker (`src/worker/simWorker.ts`); Project.SyncWithSimulation replaces the sim-thread frame sync.
  The worker's engine is the Rust/WebAssembly engine by default (see above); it runs steps in adaptive batches.
  Project.NotifyExit replaces the worker's root with an empty chip (stops sim + silences audio).
- Worker pacing: sleeps between batches of steps (setTimeout) instead of busy-waiting; busy only when behind.
- Input: a mouse button or key press+release within one frame delivers the release on the next frame (InputHelper).
- ROM "PASTE ALL" uses navigator.clipboard.readText (falls back to the next Ctrl+V paste event).
- Audio: AudioWorklet (`src/dls/game/audio/`), started on first pointer/key press.
- Ctrl+N / Ctrl+Q / Ctrl+W can't be intercepted in most browsers — use the MENU popup buttons.

### Known issues / next steps
1. Performance in headless Chromium + SwiftShader (software GL) is poor (~4-20 fps) because the bezier text
   fragment shader (same algorithm as the original TextShader) is expensive on a CPU rasterizer. Expected fine on
   real GPUs but NOT yet verified on hardware. If needed: cache text into an atlas or skip curves by bbox.
2. Verified in the browser by `scripts/e2e-features.cjs`: every display/IO builtin placed, ROM editor (edit, display
   modes, confirm), context actions (pulse width, LED colour, key rebind, bus flip, label), RGB display driven by the
   sim, save + customize (resize handles, placing a display), library (move/star/new collection, jump chip, delete
   chip -> backup in "Deleted Chips" like the original), project duplicate/rename/delete/open, preferences menu.
   Still untested interactively: preference changes being applied (grid/pause toggles), dot display visuals, buzzer
   sound output on real speakers, the file picker / download UI of import/export (logic is tested).
3. Browser tests: `npm run e2e` (smoke) and `node scripts/e2e-features.cjs [shotDir]` (features), both need the dev
   server on :5173. Helpers in `scripts/e2eHelpers.cjs`. Launch flags for software GL are set there; waits >= 300ms
   between input events because headless frames are slow. Context menus open upward near the bottom of the screen.
   Unit tests: `tests/chips.test.ts` (MainTest chips incl. RAM/PC/registers), `tests/builtins.test.ts` (every builtin).
4. Remove the `window.dls` hook / Draw.Debug* getters if undesired (harmless).

## Porting conventions (important)
- C# structs: Vector2/Color are immutable classes (use .add/.sub/.mul, Vector2.eq for ==). Plain-object structs
  (PinDescription, SubChipDescription, DisplayDescription, ProjectDescription, AppSettings, ButtonTheme,
  InputFieldTheme...) must be cloned where C# copies then mutates (clonePinDescription, cloneSubChipDescription,
  copyProjectDescription, cloneButtonTheme, `{...theme}`, ConnectionInfo.clone).
- `using (scope)` -> `const s = X.Begin...(); try { ... } finally { s.Dispose(); }`.
- `out`/tuple returns -> TS tuples. `ref` params -> closures or `{ v }` boxes.
- Name comparisons case-insensitive: NameMatch/NameKey/NameSet.
- C# overloads renamed: controller StartPlacing(desc) / StartPlacingByName(name) / StartPlacingAt(desc,pos,dup);
  CanCompleteWireConnection(pin, wire?) / CanCompleteWireConnectionToWire(wire) -> [bool, pin];
  UI.DrawPanel(bounds) -> DrawPanelBounds, UI.ModifyPanel(bounds) -> ModifyPanelBounds,
  UI.UIToScreenSpace(bounds) -> UIToScreenSpaceBounds, UI.DrawScrollView(elements) -> DrawScrollViewElements,
  UI.WheelSelector(index,...) -> WheelSelectorIndexed, GridHelper.SnapToGrid(Vector2) -> SnapToGridV,
  GridHelper.SnapMovingElementToGrid(pos, offset) -> SnapMovingElementToGridPos.
- UI.Button(text, theme, pos, size, enabled, fitTextX, fitTextY, anchor, leftAlign, textOffsetX, ignoreInputs).
- Static C# classes -> exported const objects (e.g. `export const UIDrawer = {...}`), enums exported separately
  (`MenuType` in ui/UIDrawer.ts, `SaveMode` in game/Project.ts, `CancelConfirmResult` in ui/MenuHelper.ts).
- Element type checks: `instanceof SubChipInstance/DevPinInstance/PinInstance/WireInstance`, `IsMoveable(x)`.
- Sim access from the main thread: SimChipRef (path of subchip IDs). Displays: `simRef.GetDisplayData()`.
- PinState values are int32 (see PinState.ts).

## Tooling
- `npm run check` = typecheck + lint (Biome, warnings are errors) + tests. CI also runs `vite build`.
- Commit + push after every file group (user's usage is limited). Update this file when status changes.

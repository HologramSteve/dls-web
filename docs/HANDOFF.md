# Handoff / status (read first)

Faithful port of SebLague/Digital-Logic-Sim (Unity C#, v2.1.6) to TypeScript + WebGL2 + Web Worker. No engine.
Original source for reference: `git clone --depth 1 https://github.com/SebLague/Digital-Logic-Sim /tmp/dls`
(scripts in `Assets/Scripts/{Seb,Simulation,Description,SaveSystem,Game,Graphics}`).
Architecture overview: `docs/architecture.md`.

## Status
ALL original C# files are ported (Seb lib, Description, SaveSystem, Simulation, Game, Graphics incl. every menu).
`npm run check` (typecheck + lint + tests) is green; no tsconfig excludes remain. The app runs (`npm run dev`).

Verified in headless Chromium (Playwright): main menu, new project, open project, bottom bar + collection popup,
placing chips, wiring, toggling inputs, NAND truth table simulated correctly, persistence across reloads (IndexedDB).

### Web-specific additions / deviations (keep documented here)
- `src/main.ts` = UnityMain (rAF loop). Exposes `window.dls` (Project, WorldCam, UIDrawer, IS, Main, Draw, SimHost)
  for browser tests.
- Main menu: "QUIT" replaced by "IMPORT" (zip(s) of projects; hold Shift to pick a folder instead). Open-project
  screen has an extra "EXPORT" button (downloads `<name>.zip` in the original folder layout).
  Code: `src/dls/saveSystem/ProjectTransfer.ts` (own minimal zip writer/reader; inflate via DecompressionStream).
- Settings menu: only fullscreen on/off is applied (resolution/vsync are browser controlled). Default AppSettings
  fullscreenMode = Windowed (3). Fullscreen is applied only when the player presses APPLY (needs user gesture).
- Sim runs in a worker (`src/worker/simWorker.ts`); Project.SyncWithSimulation replaces the sim-thread frame sync.
  Project.NotifyExit replaces the worker's root with an empty chip (stops sim + silences audio).
- Worker pacing: sleeps between batches of steps (setTimeout) instead of busy-waiting; busy only when behind.
- Input: a mouse press+release within one frame delivers the release on the next frame (InputHelper).
- ROM "PASTE ALL" uses navigator.clipboard.readText (falls back to the next Ctrl+V paste event).
- Audio: AudioWorklet (`src/dls/game/audio/`), started on first pointer/key press.
- Ctrl+N / Ctrl+Q / Ctrl+W can't be intercepted in most browsers — use the MENU popup buttons.

### Known issues / next steps
1. Performance in headless Chromium + SwiftShader (software GL) is poor (~4-20 fps) because the bezier text
   fragment shader (same algorithm as the original TextShader) is expensive on a CPU rasterizer. Expected fine on
   real GPUs but NOT yet verified on hardware. If needed: cache text into an atlas or skip curves by bbox.
2. More browser testing of: save menu + customization (resize, displays), chip library menu, context menu
   (right-click), rename/delete/duplicate projects, ROM edit, key chips, bus chips, pulse, LED/RGB/dot displays,
   7-seg, view-mode (entering subchips), undo/redo, import/export round trip with `testdata/Projects/MainTest`.
3. Add a Playwright e2e test to the repo (scripts used so far live in the session scratchpad: launch chromium with
   `['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']`, use waits >= 400ms between input
   events because frames are slow; move the mouse before pressing so hover is registered).
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

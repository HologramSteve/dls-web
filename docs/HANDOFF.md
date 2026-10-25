# Handoff / status (read first)

Faithful port of SebLague/Digital-Logic-Sim (Unity C#, v2.1.6) to TypeScript + WebGL2 + Web Worker. No engine.
Original source for reference: `git clone --depth 1 https://github.com/SebLague/Digital-Logic-Sim /tmp/dls`
(scripts in `Assets/Scripts/{Seb,Simulation,Description,SaveSystem,Game,Graphics}`).

## Status
1. [done] Read original.
2. [done] Scaffold (Vite, TS strict, Biome lint, Vitest, CI in .github/workflows/ci.yml).
3. [done] Seb library -> `src/seb/` (types, helpers, InputHelper over DOM + WorldCam, text, Draw.ts + WebGL2 backend,
   internal/Shaders.ts = GLSL ports of Draw.shader & TextShader, ui/UI.ts + UIStates + UITheme). Visually verified.
4. [done] Description (`src/dls/description/`), SaveSystem (`src/dls/saveSystem/`: FileSystem = in-memory virtual FS
   persisted to IndexedDB; SavePaths/SaveUtils; Saver.ts also contains Loader + UpgradeHelper; DescriptionCreator.ts
   currently ONLY has CreateDefaultInstanceData), Simulation (`src/dls/simulation/`: PinState, SimChip/SimPin,
   Simulator (worker side), SimAudio, SimProtocol, SimHost (main-thread proxy, command queue, SimChipRef),
   `src/worker/simWorker.ts`). Tests pass (`tests/sim.test.ts`), bench ADDER-8 ~70k steps/s.
   Also done: graphics/DrawSettings, game/GridHelper(+IDGenerator), game/PinLayout, game/BuiltinChipCreator
   (+collections), game/ChipLibrary (auto-syncs library to worker), game/Version.
5. [in progress] Game layer. Written (not yet typechecked, dir excluded in tsconfig!):
   `src/dls/game/elements/{Interfaces,PinInstance,DevPinInstance,SubChipInstance(+DisplayInstance,CreateMultiLineName),WireInstance(+ConnectionInfo class w/ clone(), BitWire)}`,
   `src/dls/graphics/WireLayoutHelper.ts` (CreateMultiBitWireLayout, GetClosestPointOnWire, DrawWireStraight).
   DONE since: DescriptionCreator.ts (full), game/DevChipInstance.ts, game/UndoController.ts.
   !! CI is currently RED: these import ./Project which does not exist yet. Write game/Project.ts first.
   NEXT, in order (port each C# file 1:1):
   a. [done] saveSystem/DescriptionCreator.ts: add CreateChipDescription, CreateSubChipDescription,
      CreateBuiltinSubChipDescriptionForPlacement, UpdateWireIndicesForDescriptionCreation, CreateWireDescription,
      CreatePinDescription, RandomInitialChipColour (original Assets/Scripts/SaveSystem/DescriptionCreator.cs).
   b. [done] game/DevChipInstance.ts (+ UpdateStateFromSim using SimHost.GetSnapshotFor(simChipRef): snapshot.pins is
      5 ints/pin [owner,pinID,state,srcID,srcParentID]; dev pins keyed (pinID,0)), game/UndoController.ts.
   c. game/Project.ts (Project.ActiveProject static; no sim thread: each frame call SimHost.SendFrame with inputs
      [devPinID, PlayerInputState] of edit chip input pins, held keys (A-Z,0-9 only, none if ctrl/shift/alt),
      view = ViewedChip.SimChip ref; NotifyKeyChipBindingChanged etc -> Simulator.SetInternalState/UpdateInternalState),
      game/Main.ts (CreateOrLoadProject, LoadProject = new Project(desc, Loader.LoadChipLibrary(desc))),
      InteractionState, KeyboardShortcuts, CameraController (sets WorldCam + Draw.SetCamera), ChipInteractionController.
   d. graphics: WorldDrawer, DevSceneDrawer (displays: sim = SimChipRef; use sim.GetDisplayData() -> {InputPins, InternalState}
      or null), CustomizationSceneDrawer.
   e. graphics/ui: UIDrawer, MenuHelper, menus (BottomBar, ContextMenu, MainMenu, ChipLibrary, ChipSave, ChipCustomization,
      Preferences, RomEdit, Search, PinEdit, ChipLabel, PulseEdit, RebindKeyChip, UnsavedChanges, SimPaused, ViewedChipsBar).
   f. Audio: AudioWorklet porting AudioState.Sample (square wave, 20 harmonics, gain 0.05, clip 0.1), fed by
      SimHost.onAudio amplitudes.
   g. src/main.ts: replace render smoke test with bootstrap: FileSystem.init, Draw.LoadFonts('./fonts/'), Draw.Init,
      InputHelper.Attach, SimHost.Start, rAF loop: Time.BeginFrame, InputHelper.BeginFrame, Screen size = canvas*dpr,
      Draw.BeginFrame, Main.Update, Draw.Render. Main menu first (UIDrawer.MenuType.MainMenu).
   h. Remove `exclude` from tsconfig.json once elements compile.
6. TODO: browser test via Playwright, project import/export (zip/folder of original format; web replaces Quit with
   Import/Export), docs/architecture.md, update CLAUDE.md.

## Porting conventions (important)
- C# structs: Vector2/Color are immutable classes (use .add/.sub/.mul, Vector2.eq for ==). Plain-object structs
  (PinDescription, SubChipDescription, ProjectDescription, ButtonTheme...) must be cloned where C# copies then mutates
  (helpers: clonePinDescription, cloneSubChipDescription, copyProjectDescription, cloneButtonTheme, ConnectionInfo.clone).
- `using (scope)` -> `const s = X.Begin...(); try { ... } finally { s.Dispose(); }`.
- `out`/tuple returns -> TS tuples. Name comparisons case-insensitive: NameMatch/NameKey/NameSet.
- UI.Button(text, theme, pos, size, enabled, fitTextX, fitTextY, anchor, leftAlign, textOffsetX, ignoreInputs);
  C# `UI.Button(text, theme, pos, enabled, anchor)` short overload = Button(text, theme, pos, Vector2.zero, enabled, true, true, anchor).
  HorizontalButtonGroup(names, states|null, theme, pos, regionWidth, spacing, pad, anchor); sized variant = HorizontalButtonGroupSized.
  WheelSelector(id,...) vs WheelSelectorIndexed(index,...). DrawScrollView(content func) / DrawScrollViewElements.
- Draw.Text(font, text, size, pos, anchor, col, lineSpacing=1, textLength=-1). CalculateTextBoundsSize(text,size,font,lineSpacing,len).
- Element type checks: `instanceof SubChipInstance/DevPinInstance/PinInstance/WireInstance`; elements also have `kind`.
- PinState values are int32 (see PinState.ts). SimHost Simulator.* functions take SimChipRef.

## Tooling
- `npm run check` = typecheck + lint (Biome, warnings are errors) + tests. CI also runs `vite build`.
- Screenshots: node script using require('playwright') with chromium args
  ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'] against `npx vite --port 5173`.
- Commit + push after every file group (user's usage is limited). Update this file when status changes.

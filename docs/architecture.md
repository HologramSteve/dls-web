# Architecture

```
index.html ── src/main.ts (UnityMain: boot + requestAnimationFrame loop)
                │
                ├─ src/seb/            Port of Sebastian Lague's helper library
                │   ├─ types/          Vector2, Color, Bounds2D, Mathf (Unity semantics: banker's rounding etc.)
                │   ├─ helpers/        InputHelper (DOM → Unity-style per-frame input), ColHelper, Maths, Platform (Time/Screen)
                │   └─ vis/            Draw (immediate-mode shape + text renderer on WebGL2), text/ (TTF parser, layout),
                │                      ui/ (immediate-mode UI: buttons, input fields, scroll views, wheels, colour picker)
                │
                ├─ src/dls/            Port of DLS
                │   ├─ description/    Save-file data types (JSON compatible with the original), Serializer
                │   ├─ saveSystem/     Virtual FS (in-memory, persisted to IndexedDB), Saver/Loader, DescriptionCreator,
                │   │                  ProjectTransfer (web-only zip import/export)
                │   ├─ simulation/     Simulator (runs in worker), SimChip/SimPin, PinState, SimAudio,
                │   │                  SimHost (main-thread proxy: command queue + snapshots), SimProtocol
                │   ├─ game/           Main, Project, ChipLibrary, DevChipInstance, elements/, ChipInteractionController,
                │   │                  CameraController, UndoController, KeyboardShortcuts, audio/ (AudioWorklet)
                │   └─ graphics/       DrawSettings (themes), WorldDrawer, DevSceneDrawer, CustomizationSceneDrawer,
                │                      WireLayoutHelper, ui/ (UIDrawer, MenuHelper, menus/*)
                │
                ├─ src/worker/simWorker.ts   Simulation thread replacement; engines.ts: JS engine / Rust (WASM) engine
                │
                └─ rust/dls-sim/              Rust simulation engine (same semantics, compiled + truth tables), built to
                                              src/worker/dls_sim.wasm — see docs/rust-engine.md
```

## Frame loop (main thread)
`Time.BeginFrame → InputHelper.BeginFrame → Draw.BeginFrame → Main.Update → Draw.Render`

`Main.Update` (same as the original): CameraController.Update → Project.Update (input, controller, sim sync) →
InteractionState.ClearFrame → WorldDrawer.DrawWorld → UIDrawer.Draw.

## Simulation
The original runs the simulator on a dedicated thread that directly reads/writes game objects. Here:
- The worker owns the SimChip tree. The main thread never touches it; it holds `SimChipRef`s (paths of subchip IDs).
- Edits (add/remove subchip, wire, pin, internal state) are queued by `Simulator.*` on the main thread
  (`SimHost.Enqueue`) and sent with the next frame request — mirroring the original's modification queue.
- Every frame `Project.SyncWithSimulation` applies the latest snapshot to the viewed chip
  (`DevChipInstance.UpdateStateFromSim`) and posts a `FrameRequest` (input pin states, held keys, viewed chip path,
  display paths, pause/step/speed settings).
- The worker steps at the target rate in time slices and replies with a `Snapshot` (pin states of the viewed chip,
  display data, ticks/sec, audio amplitudes).
- Custom chip definitions are synced to the worker by `ChipLibrary` (`Simulator.SyncLibrary`).
- The worker runs one of two engines behind the same interface (`src/worker/engines.ts`): the Rust engine compiled
  to WebAssembly (default) or the TS port of the original simulator (`?engine=js`). The protocol is unchanged.

## Rendering
`Draw` batches instances (16 floats each) into layers; each layer draws shapes then text (2 instanced draw calls).
Shapes use an SDF-style shader (port of Draw.shader); text uses the original's bezier coverage shader with glyph
curve data stored in float textures. UI is laid out in a 100-unit-wide virtual canvas (fixed 16:9 aspect, letterboxed).

## Persistence
`FileSystem` keeps all files in memory (so the ported synchronous save/load code works unchanged) and writes through to
IndexedDB. Paths mirror the original (`Projects/<name>/ProjectDescription.json`, `Projects/<name>/Chips/*.json`).
Projects can be exported/imported as zip files in that same layout, so they move between the web and desktop versions.

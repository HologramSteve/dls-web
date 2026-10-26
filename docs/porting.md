# How the port was made

This document describes how Digital Logic Sim (Unity/C#, v2.1.6, 129 C# files under `Assets/Scripts`) was ported to
TypeScript. It is meant for anyone who maintains the port or brings in changes from newer upstream versions.

## Approach: a 1:1 faithful port, not a rewrite

The goal was the same look, behaviour and save files, so the port follows the original's structure file by file:

- Every original C# class has a TypeScript file with the same name, in a mirrored folder
  (`Assets/Scripts/Game/Project/Project.cs` → `src/dls/game/Project.ts`, `Seb/Vis/Draw.cs` → `src/seb/vis/Draw.ts`).
  Each file starts with a `// Port of <Namespace.Class>` comment.
- Method names, field names, control flow and constants are kept, including the original comments. A bug fix or
  feature from upstream can be applied by reading the C# diff and editing the same function in the same file.
- Logic is not "improved". Where behaviour had to change for the web, the change is kept small, commented with
  `Web:` or `(JS)`, and listed in `docs/HANDOFF.md`.

The work went bottom-up in dependency order, and the tree typechecked at each stage:

1. **Seb library** (`src/seb`): math types, input, the immediate-mode `Draw` renderer, text rendering and the
   immediate-mode UI (buttons, input fields, scroll views, wheel selectors, colour picker).
2. **Description + SaveSystem** (`src/dls/description`, `src/dls/saveSystem`): the save-file types, serializer,
   saver, loader and paths.
3. **Simulation** (`src/dls/simulation`): `Simulator`, `SimChip`, `SimPin`, `PinState`, `SimAudio`.
4. **Game** (`src/dls/game`): project, chip library, dev chip, elements, interaction controller, undo, camera,
   keyboard shortcuts.
5. **Graphics + menus** (`src/dls/graphics`): world and scene drawers, `UIDrawer`, and every menu.
6. **Boot** (`src/main.ts`, the equivalent of `UnityMain`): fonts, WebGL setup, input, the worker and the
   `requestAnimationFrame` loop.

## Replacing Unity

| Unity / .NET | Web replacement |
| --- | --- |
| `MonoBehaviour` `Update` loop | `requestAnimationFrame` in `src/main.ts`: `Time.BeginFrame → InputHelper.BeginFrame → Draw.BeginFrame → Main.Update → Draw.Render` |
| `UnityEngine.Input` | `src/seb/helpers/InputHelper.ts`: DOM events collected into per-frame state (`IsKeyDownThisFrame`, mouse position in pixels with y up, scroll, typed characters) |
| `Time`, `Screen`, `Application` | `src/seb/helpers/Platform.ts` |
| `Vector2`, `Color`, `Mathf`, `Bounds` | `src/seb/types/*`, with Unity semantics (e.g. `Mathf.RoundToInt` uses banker's rounding) |
| Seb's `Draw` shape shader + instanced meshes | WebGL2 instanced renderer (`src/seb/vis/internal`): 16 floats per instance, drawn by layer, shapes then text, two draw calls per layer |
| TextMeshPro-like bezier text shader | Same algorithm: TTF glyph curves are parsed at startup (`src/seb/vis/text`) and stored in float textures, then coverage is computed in the fragment shader |
| Simulation thread (`System.Threading`) | Web Worker (`src/worker/simWorker.ts`), see below |
| `System.IO` file storage | `src/dls/saveSystem/FileSystem.ts`: an in-memory virtual FS mirroring the original paths, with write-through to IndexedDB |
| Unity audio (`OnAudioFilterRead`) | AudioWorklet (`src/dls/game/audio`): the same square-wave synthesis (20 harmonics) |
| Newtonsoft JSON | `JSON` plus a `Serializer` that writes the same field names and formatting, so files stay compatible |
| Fonts (JetBrains Mono NL, Born2bSporty) | Copied from the original into `public/fonts` |

## C# to TypeScript conventions

These are the main sources of subtle bugs, so they are applied consistently:

- **Value-type structs.** `Vector2` and `Color` are immutable classes: use `a.add(b)`, `.mul(s)`, and
  `Vector2.eq(a, b)` instead of `==`. Plain-object structs such as `PinDescription`, `SubChipDescription`,
  `ProjectDescription`, themes and `ConnectionInfo` are cloned everywhere C# would copy them before mutating
  (`clonePinDescription`, `{ ...theme }` and so on).
- **`uint` / `ushort` arithmetic.** Pin states are 32-bit values: 16 bit states plus 16 tri-state flags. They are
  always kept in int32 form (results of `|`, `&`, `>>>` masked), so that equality comparisons are consistent
  (`PinState.ts`).
- **`using` scopes** (UI layout, colour and mask scopes) → `const s = X.Begin(); try { … } finally { s.Dispose(); }`.
- **`out` / `ref` parameters** → tuple returns or `{ v }` boxes.
- **Overloads** → renamed functions, for example `StartPlacing(desc)`, `StartPlacingByName(name)`, `DrawPanelBounds`
  and `SnapToGridV`. The full list is in `docs/HANDOFF.md`.
- **Static classes** → exported `const` objects. **Enums** → TS enums with the same numeric values (they are written
  to save files).
- **Case-insensitive name dictionaries** → `NameMatch` / `NameKey` / `NameSet` helpers.
- **`is` type patterns** → `instanceof` checks.

## The simulation worker

In the original, the simulator runs on its own thread and reads and writes game objects directly. The browser can't
share objects like that, so the port splits the simulator in two:

- The **worker** owns the full `SimChip` tree and runs the unmodified simulation code: the step loop, random
  reordering, tri-state conflict resolution and builtin chips.
- The **main thread** never touches sim objects. It holds `SimChipRef`s, which are paths of subchip IDs.
  `Simulator.AddSubChip` / `AddConnection` / `SetInternalState` and the other edit calls queue commands, the same way
  the original queues modifications.
- Every frame, `Project.SyncWithSimulation` sends one `FrameRequest` to the worker. It carries the queued commands,
  the player input pin states, held keys, the path of the viewed chip, the requested display chips, and the
  pause/step/speed settings.
- The worker replies with a `Snapshot`: pin states of the viewed chip, display data (RGB/dot/7-segment/LED internal
  state), measured ticks per second and audio amplitudes.
- The worker paces itself to the target steps per second. It runs batches of steps and sleeps with `setTimeout`
  between them; it only runs flat out when it is behind. It reaches the default 1000 steps/s target.

## Verification

- **Unit tests** (`tests/`, Vitest, run in CI) run the simulator in Node on the chips of the original's own test
  project (`testdata/Projects/MainTest`): gates, adders, latches, flip-flops, registers, RAM, the program
  counter and BCD conversion. A further set covers every builtin chip type (ROM, split/merge, 3-state bus conflicts,
  pulse, clock, key, bus, dev RAM, buzzer).
- **Browser tests** (`scripts/e2e.cjs`, `scripts/e2e-features.cjs`, Playwright) drive the real UI with mouse and
  keyboard events. They cover the main menu, placing and wiring chips, NAND simulation, and importing the original
  test project. They also cover the ROM editor, every context-menu action, an RGB display, the save and customize
  flow, library operations, project duplicate/rename/delete, and preferences. Screenshots were compared with the
  original's UI.
- **Save compatibility:** the original's test project imports and runs unchanged. Exported zips use the desktop
  folder layout.

## Bringing in upstream changes

1. Diff the upstream C# between versions (`git diff vX..vY -- Assets/Scripts`).
2. For each changed file, open the TS file of the same name and apply the same change, following the conventions
   above.
3. If the save format changed, update `src/dls/description` and the `Version.ts` constants.
4. Run `bun run check`, then the browser tests.

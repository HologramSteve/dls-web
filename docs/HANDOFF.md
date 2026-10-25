# Handoff / status

## Plan (tasks)
1. [done] Read original source (Unity C#).
2. [in progress] Scaffold Vite+TS project, fonts copied to public/fonts.
3. [in progress] Port Seb library: types (Vector2, Color, Mathf, Bounds2D, Scope) DONE;
   text: FontParser, FontData (+contours/monotonic), TextLayout (bounds, anchors, rich text) DONE.
   TODO: helpers (ColHelper, Maths, StringHelper, InputHelper over DOM, Time/Screen),
   Draw (WebGL2 instanced shape renderer = port of Draw.shader; bezier text shader = port of TextShader,
   glyph data in float textures), UI.cs + UIStates/Themes/LayoutHelper.
4. TODO Port Description, SaveSystem (virtual FS in memory, persisted to IndexedDB; zip/folder import/export),
   Simulation in Web Worker.
5. TODO Port Game (Project, DevChipInstance, elements, interaction, camera, undo), Graphics (scene drawers),
   all menus (ui1/2/3 in original Graphics/UI/Menus).
6. TODO Browser test (Playwright preinstalled), perf, docs, push.

## Key design decisions
- Sim runs in a Worker. Main thread holds `SimChip` *proxies* (path of subchip IDs). Simulator.AddSubChip etc.
  become queued commands posted to the worker (mirrors original ConcurrentQueue). Each frame main posts
  input pin states + held keys; worker replies with a snapshot of the viewed chip: per pin
  [ownerID, pinID, state, latestSourceID, latestSourceParentChipID] plus display data (input pin states +
  InternalState) for display subchip paths accessed last frame, plus audio amplitudes and ticks/sec.
- PinState kept as int32 in JS (tristate flags in upper 16 bits); PCG RandomBool uses Math.imul/>>>0.
- Rendering: one WebGL2 canvas; layers like SebVis (shapes then text per layer). Coordinates: Unity
  conventions (screen origin bottom-left, y up); mouse y is flipped on input.
- Web adaptations: Quit -> Import/Export project; Settings -> fullscreen toggle; Meta treated as Ctrl.

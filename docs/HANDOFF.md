# Handoff / status

## Plan (tasks)
1. [done] Read original source (Unity C#).
2. [done] Scaffold Vite+TS project, fonts copied to public/fonts.
3. [done] Port Seb library (src/seb): types, helpers (ColHelper, Maths, StringHelper, Platform=Time/Screen,
   InputHelper over DOM + WorldCam), text (FontParser, FontData, TextLayout), Draw.ts (API + WebGL2 backend),
   internal/Shaders.ts (GLSL ports of Draw.shader + TextShader), ui/ (UI.ts, UIStates, UITheme).
   Verified visually with a throwaway src/main.ts render test (shapes + bezier text render correctly).
   NOTE: src/main.ts is currently a render smoke test; replace with real app bootstrap in task 5.
4. TODO Port Description, SaveSystem (virtual FS in memory, persisted to IndexedDB; zip/folder import/export),
   Simulation in Web Worker.
5. TODO Port Game (Project, DevChipInstance, elements, interaction, camera, undo), Graphics (scene drawers),
   all menus (ui1/2/3 in original Graphics/UI/Menus).
   Screenshot helper: scratch script using require('playwright') with chromium args
   ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'] against `npx vite`.
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

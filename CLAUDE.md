# CLAUDE.md — dls-web

Web port of Sebastian Lague's **Digital Logic Sim** (Unity/C#, MIT) to the browser.
**Start every session by reading `docs/HANDOFF.md`** (current status + next steps), then `docs/architecture.md` and `docs/porting.md`.

## Rules
- This is a *faithful port*: each TS file mirrors an original C# file (same names, same logic). Do not redesign.
  Original source: `git clone --depth 1 https://github.com/SebLague/Digital-Logic-Sim` (Assets/Scripts/...).
- No game engine. TypeScript + Vite, WebGL2 rendering, simulation in a Web Worker.
- Save format must stay JSON-compatible with the original (projects can be imported/exported).
- C# structs (Vector2, Color, descriptions, ConnectionInfo, themes) are value types: in TS, Vector2/Color are
  immutable classes; plain-object structs must be cloned wherever C# would copy-then-mutate.
- After finishing each task: update `docs/HANDOFF.md`, update this file if conventions changed, commit and push
  to branch `claude/blissful-brahmagupta-8yaivk`.

- Web-only additions (zip import/export, worker pacing, input tweaks) are listed in `docs/HANDOFF.md`; keep that list current.
- Rust engine (`rust/dls-sim`, docs/rust-engine.md) must keep the exact semantics of `src/dls/simulation/Simulator.ts`:
  change both together, then `bun run build:wasm` (the .wasm is committed) and run `bun run test:rust` + `bun run test`.

## Commands
Package manager / script runner: Bun (`bun.lock`; don't add a package-lock.json).
- `bun install`, `bun run dev`, `bun run build`, `bun run typecheck`, `bun run test`, `bun run check` (all of typecheck+lint+test)
- Rust: `bun run build:wasm`, `bun run test:rust`, `bun run bench:rust` (needs stable Rust + `wasm32-unknown-unknown`)

## Layout
- `src/seb/` — port of the Seb library (types, helpers, Draw/WebGL renderer, text, immediate-mode UI)
- `src/dls/` — port of DLS (description, saveSystem, simulation, game, graphics)
- `src/worker/` — simulation Web Worker (`engines.ts`: JS engine / Rust WASM engine; `dls_sim.wasm` is a build output)
- `rust/dls-sim/` — Rust simulation engine (native tests + benchmark, WebAssembly API)
- `public/fonts/` — fonts from the original repo (JetBrains Mono NL, Born2bSporty)
- `testdata/Projects/` — original test project (for import tests)

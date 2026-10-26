# Digital Logic Sim — Web

A browser port of [Sebastian Lague's Digital Logic Sim](https://github.com/SebLague/Digital-Logic-Sim)
(v2.1.6, Unity/C#) to TypeScript. It has the same look, the same features and the same save format, and it uses
no game engine.

- Rendering: WebGL2 (instanced shapes + bezier-curve text, ported from the original shaders).
- Simulation: in a Web Worker, by a Rust engine compiled to WebAssembly. It has the same semantics as the original
  simulator, and is 25–120× faster than the straight TypeScript port thanks to a compiled flat program and exact
  truth tables for combinational chips. You can switch to the TypeScript port of the original simulator in
  SETTINGS, under "web version only".
- Storage: projects live in the browser (IndexedDB) and can be imported and exported as zip files. The zip uses the
  same folder layout and JSON as the desktop version, so projects move both ways.

## Running

```sh
npm install
npm run dev        # http://localhost:5173
npm run build      # static site in dist/ (serve with `npm run preview` or any static host)
```

A browser with WebGL2 and module workers is required (any current Chrome, Edge, Firefox or Safari).

## Using it

It works like the original: build chips from NAND gates, save them, and use them inside other chips.

The web version differs from the desktop one in a few places:

- **IMPORT** (main menu) loads project zip files. Hold Shift while clicking it to pick a project folder instead,
  for example `.../Digital Logic Sim/Projects/<name>`.
- **EXPORT** (open-project screen) downloads the selected project as `<name>.zip`.
- Browsers reserve Ctrl+N / Ctrl+Q / Ctrl+W, so use the MENU popup for new chip, quit to main menu and so on.
- Fullscreen is applied only when you press APPLY in Settings. Resolution and vsync are controlled by the browser.
- Audio from the buzzer chip starts after your first click or key press, because browsers block audio before that.

## Development

```sh
npm run build:wasm # rebuild src/worker/dls_sim.wasm from rust/dls-sim (needs Rust + wasm32-unknown-unknown target)
npm run test:rust  # Rust engine tests (native)
npm run bench:rust # Rust engine benchmark (native)
npm run check      # typecheck + lint (Biome) + unit tests — what CI runs (plus the build)
npm test           # Vitest: simulator tests against the original's test project chips + every builtin chip
npm run bench      # simulation benchmark
npm run e2e        # browser smoke test (Playwright; needs `npm run dev` running)
node scripts/e2e-features.cjs [screenshotDir]   # broader browser feature test
```

Documentation:

- [`docs/porting.md`](docs/porting.md): how the port was made, and how C# and Unity concepts map to TypeScript.
- [`docs/architecture.md`](docs/architecture.md): runtime architecture (frame loop, worker, renderer, storage).
- [`docs/rust-engine.md`](docs/rust-engine.md): the Rust simulation engine (design, exactness, benchmarks).
- [`docs/HANDOFF.md`](docs/HANDOFF.md): current status, web-specific deviations, known issues, conventions.
- [`CLAUDE.md`](CLAUDE.md): rules for AI agents working on this repo.

## License

The original Digital Logic Sim is © Sebastian Lague, MIT licensed (see `LICENSE-original-DLS`). This port, including
the fonts in `public/fonts`, is distributed under the same terms.

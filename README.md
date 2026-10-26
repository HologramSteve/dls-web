# Digital Logic Sim — Web

A browser port of [Sebastian Lague's Digital Logic Sim](https://github.com/SebLague/Digital-Logic-Sim)
(v2.1.6, Unity/C#), written in TypeScript with no game engine.
- **Same look, same features, same save format** as the desktop version: projects move between the two as zip
  files.
- **Live collaboration**: create a room, share the code, and build together with everyone's cursors and edits shown
  live, on one central server you host.
- **20–86× faster simulation** than a straight port of the original simulator, from a Rust engine compiled to
  WebAssembly. It gives identical results.

## Performance

![Speed-up over the JS engine](docs/img/performance.svg)

Steps per second on circuits from the original's own test project. All three engines are measured by the same
WebAssembly build the browser loads, on one CPU core.

| Circuit | Size | JS engine | Rust | Rust + truth tables |
| --- | --- | --- | --- | --- |
| ALU-8 | 317 NAND gates | 21,783 | 439,254 | **719,394** |
| demo (7-segment) | 1,084 NAND gates | 6,021 | 242,308 | **520,495** |
| PC (program counter) | 1,216 NAND gates | 5,353 | 202,621 | **350,493** |
| WIP2 (CPU) | 5,709 NAND gates | 705 | 34,541 | **54,089** |
| RAM-sync (256-byte RAM) | 23,989 NAND gates | 164 | **3,526** | 3,505 |

- **JS engine:** the original C# simulator ported line by line to TypeScript.
- **Rust:** the same simulation semantics, but the circuit is compiled into a flat list of operations instead of
  walking the chip tree every step. Wire copies that don't affect any result are removed.
- **Rust + truth tables (default):** additionally, chips with no memory or feedback (adders, decoders, ALU slices)
  are simulated once for every input combination and then become a single lookup. This is exact. RAM is built from
  latches, which can't be tabled.

The fast engine matches the original algorithm **bit for bit**: every pin, every step, on every chip of the test
project. Details, native numbers and how to reproduce them are in [docs/performance.md](docs/performance.md).

You can switch engines in **Settings → "Web version only"**. JS (ORIGINAL) runs the straight port.

## Running

Needs [Bun](https://bun.sh). The compiled WebAssembly is committed, so Rust is only needed to change the engine.

```sh
bun install
bun run dev          # http://localhost:5173
bun run build        # static site in dist/ — serve it with `bun run preview` or any static host
```

A browser with WebGL2 and module workers is required (any current Chrome, Edge, Firefox or Safari).

### Hosting with live collaboration

The server serves the app and the collaboration WebSocket from one process (rooms are saved in `./data`):

```sh
bun run build && bun run server     # http://localhost:8787
# or: docker build -t dls-web . && docker run -d -p 8787:8787 -v dls-data:/data dls-web
```

For development, run `bun run dev:server` next to `bun run dev`. HTTPS, reverse proxies and limits are covered in
[docs/collaboration.md](docs/collaboration.md).

To try the big test circuits: on the main menu hold **Shift** and click **IMPORT**, pick
`testdata/Projects/MainTest`, then open the "MainTest" project.

## Using it

It works like the original: build chips from NAND gates, save them, and use them inside other chips. The web version
differs in a few places:

- **IMPORT** (main menu) loads project zip files. Hold Shift to pick a project folder instead.
- **EXPORT** (open-project screen) downloads the selected project as `<name>.zip` in the desktop folder layout.
- **Settings** has a section marked "WEB VERSION ONLY (not in the original)": simulation engine (Rust or JS) and
  truth tables on/off.
- Browsers reserve Ctrl+N / Ctrl+Q / Ctrl+W, so use the MENU popup for new chip, quit to main menu and so on.
- Fullscreen is applied only when you press APPLY in Settings. Resolution and vsync are controlled by the browser.
- Projects are stored in your browser (IndexedDB), per site address.
- **Live collaboration** (button at the top right): create a room from a project, share the code or invite link,
  and edit together. The owner can lock the room, make people viewers, kick or ban them.
- Sound from the buzzer chip starts after your first click or key press, because browsers block audio until then.

## Development

```sh
bun run check        # typecheck + lint (Biome) + unit tests — what CI runs (plus the build)
bun run test         # Vitest: simulator + engine tests on the original's test project chips
bun run bench        # JS vs WebAssembly benchmark
bun run e2e          # browser smoke test (Playwright; needs `bun run dev` running)
bun scripts/e2e-features.cjs [screenshotDir]   # broader browser feature test
bun scripts/e2e-collab.cjs [url] [screenshotDir] # two-browser collaboration test (needs dev + dev:server)
bun run dev:server   # collaboration server with restart on change (Vite proxies /ws to it)

bun run build:wasm   # rebuild src/worker/dls_sim.wasm (needs Rust + the wasm32-unknown-unknown target)
bun run test:rust    # Rust engine tests (native)
bun run bench:rust   # Rust engine benchmark (native)
bun scripts/perfChart.ts   # regenerate docs/img/performance.svg from docs/benchmarks.json
```

Project layout:

| Path | Contents |
| --- | --- |
| `src/seb/` | Port of the original's helper library: math types, input, WebGL2 renderer, text, immediate-mode UI |
| `src/dls/` | Port of the game: save format, saving/loading, simulator, game logic, graphics and menus |
| `src/worker/` | Simulation Web Worker and its two engines (`engines.ts`); `dls_sim.wasm` is the compiled Rust engine |
| `src/collab/` | Live collaboration client (web-only): sync, presence, panel; `Protocol.ts` is shared with the server |
| `server/` | Central server (Bun): static app + rooms over WebSocket |
| `rust/dls-sim/` | Rust simulation engine: tests, native benchmark, WebAssembly interface |
| `tests/` | Vitest tests and benchmarks |
| `scripts/` | Browser tests (Playwright), chart and fixture generators |
| `testdata/Projects/MainTest` | The original's test project |

## Documentation

- [docs/porting.md](docs/porting.md): how the port was made. Covers C#/Unity → TypeScript/web mapping,
  conventions, the worker split, and how the Rust engine was built and verified.
- [docs/performance.md](docs/performance.md): benchmarks, where the speed comes from, correctness, reproducing.
- [docs/rust-engine.md](docs/rust-engine.md): the Rust engine's design and why it is exact.
- [docs/collaboration.md](docs/collaboration.md): live collaboration: using it, hosting the server, how sync works.
- [docs/architecture.md](docs/architecture.md): runtime architecture (frame loop, worker, renderer, storage).
- [docs/HANDOFF.md](docs/HANDOFF.md): current status, web-only deviations, known issues, conventions.
- [CLAUDE.md](CLAUDE.md): rules for AI agents working on this repo.

## License

The original Digital Logic Sim is © Sebastian Lague, MIT licensed (see `LICENSE-original-DLS`). This port, including
the fonts in `public/fonts`, is distributed under the same terms.

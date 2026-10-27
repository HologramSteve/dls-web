// Shared bits of the web-only HTML overlays (collaboration and account panels): styles, a tiny element builder, and the
// bar at the top right that holds the panels' buttons. Not part of the ported immediate-mode UI.
const css = `
@font-face { font-family: "DLS Mono"; src: url("./fonts/JetBrainsMonoNL-Regular.ttf"); }
@font-face { font-family: "DLS Mono"; font-weight: bold; src: url("./fonts/JetBrainsMonoNL-Bold.ttf"); }
.web-ui { --bg: #1d1d1f; --bg2: #2a2a2d; --bg3: #3a3a3e; --fg: #e8e8e8; --dim: #9a9a9f; --acc: #4f9dde; --bad: #e0534a; --good: #4fbf6a;
  font: 13px "DLS Mono", ui-monospace, monospace; color: var(--fg); }
.web-ui * { box-sizing: border-box; font: inherit; }
.web-ui button { background: var(--bg3); color: var(--fg); border: 0; border-radius: 4px; padding: 5px 9px; cursor: pointer; }
.web-ui button:hover { filter: brightness(1.25); }
.web-ui button.primary { background: var(--acc); color: #000; font-weight: bold; }
.web-ui button.danger { background: var(--bad); color: #000; }
.web-ui button:disabled { opacity: .45; cursor: default; filter: none; }
.web-ui input, .web-ui select { background: var(--bg); color: var(--fg); border: 1px solid var(--bg3); border-radius: 4px; padding: 5px 7px; min-width: 0; }
.web-ui input[type=color] { padding: 0 2px; width: 36px; height: 29px; }
.web-toggle { display: flex; align-items: center; gap: 7px; margin-left: auto; box-shadow: 0 2px 8px #0008; }
.web-ui .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--dim); display: inline-block; flex: none; }
.web-ui .dot.online { background: var(--good); } .web-ui .dot.connecting { background: #e0b84a; }
.web-panel { margin-top: 6px; width: min(370px, calc(100vw - 16px)); max-height: calc(100vh - 60px); overflow: auto; background: var(--bg2);
  border-radius: 6px; box-shadow: 0 4px 18px #000a; padding: 10px 12px 12px; }
.web-panel[hidden] { display: none; }
.web-panel h3 { margin: 12px 0 6px; font-weight: bold; font-size: 12px; color: var(--dim); letter-spacing: .06em; text-transform: uppercase; }
.web-panel .row { display: flex; gap: 6px; align-items: center; margin: 5px 0; }
.web-panel .row > input:not([type=color]), .web-panel .row > select { flex: 1; }
.web-panel .head { display: flex; justify-content: space-between; align-items: center; font-weight: bold; }
.web-panel .code { font-size: 26px; font-weight: bold; letter-spacing: .18em; color: var(--acc); user-select: all; }
.web-panel .item { display: flex; gap: 7px; align-items: center; padding: 6px 7px; background: var(--bg); border-radius: 4px; margin: 4px 0; flex-wrap: wrap; }
.web-panel .item .grow { flex: 1; min-width: 90px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.web-panel .muted { color: var(--dim); font-size: 12px; }
.web-panel .badge { font-size: 11px; padding: 1px 6px; border-radius: 8px; background: var(--bg3); color: var(--dim); }
.web-panel .error { color: var(--bad); margin-top: 8px; white-space: pre-wrap; }
.web-panel .actions { display: flex; gap: 4px; flex-wrap: wrap; width: 100%; padding-left: 16px; }
.web-panel .actions button, .web-panel .actions select { padding: 3px 7px; font-size: 12px; }
.web-panel label.check { display: flex; gap: 6px; align-items: center; cursor: pointer; }
#web-bar { position: fixed; top: 8px; right: 8px; z-index: 10; display: flex; gap: 6px; align-items: flex-start; }
`;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...children: (Node | string | null | false)[]): HTMLElementTagNameMap[K] {
	const el = document.createElement(tag);
	for (const [k, v] of Object.entries(props)) {
		if (k === "class") el.className = String(v);
		else if (k === "style") el.setAttribute("style", String(v));
		else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.substring(2), v as EventListener);
		else (el as unknown as Record<string, unknown>)[k] = v;
	}
	for (const c of children) if (c !== null && c !== false) el.append(c);
	return el;
}

export function Copy(text: string, button: HTMLButtonElement) {
	const done = () => {
		const old = button.textContent;
		button.textContent = "Copied";
		setTimeout(() => (button.textContent = old), 1200);
	};
	navigator.clipboard?.writeText(text).then(done, () => prompt("Copy:", text));
}

let bar: HTMLDivElement | null = null;

// Add a panel root (button + dropdown) to the bar; later panels go to the left of earlier ones
export function MountInBar(root: HTMLElement) {
	if (!bar) {
		document.head.append(h("style", { textContent: css }));
		bar = h("div", { id: "web-bar" });
		document.body.append(bar);
	}
	// Keep typing in the panels away from the game's keyboard shortcuts
	for (const type of ["keydown", "keyup", "keypress", "paste", "pointerdown", "wheel"]) root.addEventListener(type, (e) => e.stopPropagation());
	bar.prepend(root);
}

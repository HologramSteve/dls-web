// Renders docs/img/performance.svg (the README's performance chart) from docs/benchmarks.json.
// Run: bun scripts/perfChart.ts
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface WasmRow {
	circuit: string;
	nand_gates: number;
	js: number;
	rust: number;
	tables: number;
}

const root = join(__dirname, "..");
const data = JSON.parse(readFileSync(join(root, "docs/benchmarks.json"), "utf8"));
const rows: WasmRow[] = data.wasm.rows;

// Validated categorical colours (CVD-safe pair), drawn on an explicit light panel so the image reads the same in
// light and dark README themes. Values are always printed next to the bars, so colour is never the only cue.
const C = { bg: "#fbfbfa", panel: "#ffffff", border: "#e3e2de", text: "#1f1e1d", muted: "#6b6a66", grid: "#ecebe8", rust: "#d95926", tables: "#199e70" };
const font = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";

const W = 860;
const m = { top: 92, right: 70, bottom: 56, left: 190 };
const groupH = 58;
const H = m.top + m.bottom + groupH * rows.length;
const plotW = W - m.left - m.right;

const speed = rows.map((r) => ({ ...r, rustX: r.rust / r.js, tablesX: r.tables / r.js }));
const maxX = Math.ceil(Math.max(...speed.map((r) => Math.max(r.rustX, r.tablesX))) / 10) * 10;
const x = (v: number) => m.left + (v / maxX) * plotW;
const fmtX = (v: number) => (v >= 10 ? Math.round(v).toString() : v.toFixed(1)) + "×";
const fmtInt = (v: number) => v.toLocaleString("en-US");
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

const parts: string[] = [];
parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${font}">`);
parts.push(`<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="10" fill="${C.panel}" stroke="${C.border}"/>`);
parts.push(`<text x="24" y="38" font-size="20" font-weight="600" fill="${C.text}">Speed-up over the JS engine</text>`);
parts.push(`<text x="24" y="62" font-size="13" fill="${C.muted}">Simulation steps per second relative to the TypeScript port of the original simulator (= 1×). Higher is better.</text>`);

// Legend
const lx = W - m.right - 290;
parts.push(`<rect x="${lx}" y="74" width="12" height="12" rx="3" fill="${C.rust}"/><text x="${lx + 18}" y="84" font-size="13" fill="${C.text}">Rust (WebAssembly)</text>`);
parts.push(`<rect x="${lx + 150}" y="74" width="12" height="12" rx="3" fill="${C.tables}"/><text x="${lx + 168}" y="84" font-size="13" fill="${C.text}">+ truth tables</text>`);

// Grid + x axis
const step = maxX <= 50 ? 10 : 20;
for (let v = 0; v <= maxX; v += step) {
	parts.push(`<line x1="${x(v)}" y1="${m.top}" x2="${x(v)}" y2="${H - m.bottom}" stroke="${C.grid}"/>`);
	parts.push(`<text x="${x(v)}" y="${H - m.bottom + 20}" font-size="12" fill="${C.muted}" text-anchor="middle">${v}×</text>`);
}

speed.forEach((r, i) => {
	const gy = m.top + i * groupH;
	parts.push(`<text x="${m.left - 14}" y="${gy + 24}" font-size="14" font-weight="600" fill="${C.text}" text-anchor="end">${esc(r.circuit)}</text>`);
	parts.push(`<text x="${m.left - 14}" y="${gy + 42}" font-size="12" fill="${C.muted}" text-anchor="end">${fmtInt(r.nand_gates)} NAND gates</text>`);
	const bars: [number, string][] = [
		[r.rustX, C.rust],
		[r.tablesX, C.tables],
	];
	bars.forEach(([v, col], k) => {
		const by = gy + 8 + k * 21;
		parts.push(`<rect x="${m.left}" y="${by}" width="${Math.max(2, x(v) - m.left)}" height="17" rx="4" fill="${col}"/>`);
		parts.push(`<text x="${x(v) + 7}" y="${by + 13}" font-size="13" fill="${C.text}">${fmtX(v)}</text>`);
	});
});

parts.push(`<text x="24" y="${H - 16}" font-size="12" fill="${C.muted}">Same .wasm the browser runs, Node 22, one core · ${esc(data.wasm.date)} · circuits from the original's test project · data: docs/benchmarks.json</text>`);
parts.push("</svg>");

writeFileSync(join(root, "docs/img/performance.svg"), parts.join("\n") + "\n");
console.log("Wrote docs/img/performance.svg");

// Browser end-to-end smoke test (not run in CI: needs Chromium + Playwright).
// Usage: start the dev server (`npx vite --port 5173`), then `node scripts/e2e.cjs [url] [screenshotDir]`.
// Uses software GL (SwiftShader), where frames are slow, so waits between input events are generous.
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const url = process.argv[2] || "http://localhost:5173/";
const shotDir = process.argv[3] || null;
let failures = 0;
const check = (cond, msg) => {
	console.log((cond ? "PASS " : "FAIL ") + msg);
	if (!cond) failures++;
};

(async () => {
	const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
	const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
	const errors = [];
	page.on("pageerror", (e) => errors.push(e.message));
	const consoleLines = [];
	page.on("console", (m) => {
		consoleLines.push(m.text());
		if (m.type() === "error") errors.push(m.text());
	});
	await page.goto(url);
	await page.waitForFunction(() => window.dls);
	await page.waitForTimeout(1000);
	const shot = async (name) => shotDir && page.screenshot({ path: path.join(shotDir, name + ".png") });

	const wait = (ms) => page.waitForTimeout(ms);
	const click = async (x, y) => {
		await page.mouse.move(x, y);
		await wait(400);
		await page.mouse.down();
		await wait(300);
		await page.mouse.up();
		await wait(400);
	};
	const toScreen = (p) =>
		page.evaluate(([x, y]) => {
			const v = window.dls.WorldCam.WorldToScreenPoint({ x, y });
			return [v.x / devicePixelRatio, innerHeight - v.y / devicePixelRatio];
		}, p);

	// ---- Settings: switch the simulation engine (web-only setting) and back ----
	if (!url.includes("engine=")) {
		const engine = () => page.evaluate(() => window.dls.SimHost.activeEngineName);
		await click(640, 378); // SETTINGS
		await shot("00_settings");
		check((await engine()) === "rust", "settings: Rust engine running by default");
		await click(817, 430); // Sim engine >
		await click(796, 603); // APPLY
		await wait(1500);
		check((await engine()) === "js", "settings: switched to JS engine");
		await click(817, 430); // Sim engine >
		await click(796, 603); // APPLY
		await wait(1500);
		check((await engine()) === "rust", "settings: switched back to Rust engine");
		check((await page.evaluate(() => window.dls.Main.ActiveAppSettings.Web_SimEngine)) === 0, "settings: engine choice saved");
		await click(549, 603); // EXIT
	}

	// ---- New project via main menu UI ----
	await shot("01_menu");
	await click(640, 283); // NEW PROJECT
	await page.keyboard.type("E2E");
	await page.keyboard.press("Enter");
	await wait(1500);
	check(await page.evaluate(() => window.dls.Project.ActiveProject?.description.ProjectName === "E2E"), "project created from main menu");

	// ---- Place elements and wire a NAND gate ----
	const place = async (name, x, y) => {
		await page.mouse.move(x, y);
		await wait(300);
		await page.evaluate((n) => window.dls.Project.ActiveProject.controller.StartPlacingByName(n), name);
		await page.mouse.move(x + 1, y);
		await wait(400);
		await click(x, y);
	};
	await place("IN-1", 350, 240);
	await place("IN-1", 350, 360);
	await place("NAND", 640, 300);
	await place("OUT-1", 900, 300);
	const info = await page.evaluate(() =>
		window.dls.Project.ActiveProject.ViewedChip.Elements.map((e) => ({
			kind: e.kind,
			pins: (e.AllPins || [e.Pin]).map((p) => {
				const w = p.GetWorldPos();
				return [w.x, w.y, p.IsSourcePin];
			}),
			state: e.StateDisplayPosition ? [e.StateDisplayPosition.x, e.StateDisplayPosition.y] : null,
		})),
	);
	check(info.length === 4, "placed 4 elements");
	const nand = info.find((e) => e.kind === "subchip");
	const ins = info.filter((e) => e.kind === "devpin" && e.pins[0][2]);
	const out = info.find((e) => e.kind === "devpin" && !e.pins[0][2]);
	const wire = async (a, b) => {
		const sa = await toScreen(a);
		const sb = await toScreen(b);
		await click(sa[0], sa[1]);
		await page.mouse.move(sb[0], sb[1]);
		await wait(400);
		await click(sb[0], sb[1]);
	};
	await wire(ins[0].pins[0], nand.pins[0]);
	await wire(ins[1].pins[0], nand.pins[1]);
	await wire(nand.pins[2], out.pins[0]);
	check((await page.evaluate(() => window.dls.Project.ActiveProject.ViewedChip.Wires.length)) === 3, "created 3 wires");

	const outState = () => page.evaluate(() => window.dls.Project.ActiveProject.ViewedChip.GetOutputPins()[0].Pin.State & 1);
	await page.mouse.move(640, 100);
	await wait(1500);
	check((await outState()) === 1, "NAND(0,0) = 1");
	for (const i of ins) {
		const s = await toScreen(i.state);
		await click(s[0], s[1]);
	}
	await page.mouse.move(640, 100);
	await wait(1500);
	check((await outState()) === 0, "NAND(1,1) = 0");
	await shot("02_nand");

	// ---- Import the original test project and open complex chips ----
	const root = path.join(__dirname, "..", "testdata", "Projects");
	const files = [];
	const walk = (d) => {
		for (const f of fs.readdirSync(d)) {
			const p = path.join(d, f);
			if (fs.statSync(p).isDirectory()) walk(p);
			else files.push({ path: path.relative(root, p), text: fs.readFileSync(p, "utf8") });
		}
	};
	walk(root);
	const names = await page.evaluate(async (files) => (await import("/src/dls/saveSystem/ProjectTransfer.ts")).ImportProjectFiles(files), files);
	check(names.includes("MainTest"), "imported MainTest project");
	await page.evaluate(() => window.dls.Main.CreateOrLoadProject("MainTest", "ALU-8"));
	await wait(2500);
	check((await page.evaluate(() => window.dls.Project.ActiveProject.ViewedChip.Elements.length)) > 20, "ALU-8 loaded");
	await shot("03_alu8");
	await page.evaluate(() => window.dls.Project.ActiveProject.LoadDevChipOrCreateNewIfDoesntExist("demo"));
	await wait(2500);
	await shot("04_demo");

	const expectEngine = url.includes("engine=js") ? "js" : "rust";
	check(consoleLines.some((l) => l.startsWith("Simulation engine: " + expectEngine)), "simulation engine: " + expectEngine);

	// ---- Simulation speed on the largest test chip (RAM-sync, ~24k NANDs) with an unlimited target rate ----
	await page.evaluate(() => window.dls.Project.ActiveProject.LoadDevChipOrCreateNewIfDoesntExist("RAM-sync"));
	await page.evaluate(() => {
		window.dls.Project.ActiveProject.description.Prefs_SimTargetStepsPerSecond = 1000000;
	});
	await wait(6000);
	const tps = await page.evaluate(() => window.dls.SimHost.simAvgTicksPerSec);
	console.log(" RAM-sync steps/s in browser (" + expectEngine + "): " + Math.round(tps));
	check(tps > 0, "RAM-sync simulates");

	check(errors.length === 0, "no page errors" + (errors.length ? ": " + errors.join(" | ") : ""));
	await browser.close();
	console.log(failures === 0 ? "ALL PASSED" : failures + " FAILED");
	process.exit(failures === 0 ? 0 : 1);
})();

// Browser feature tests (beyond the smoke test in e2e.cjs). Needs the dev server on :5173.
// Usage: node scripts/e2e-features.cjs [screenshotDir]
const { launch } = require("./e2eHelpers.cjs");

(async () => {
	const h = await launch();
	h.shotDir = process.argv[2] || null;
	const { ev, wait, check } = h;
	await h.newProject("Features");

	// ---- Place every builtin with a display / special behaviour ----
	const names = ["ROM 256×16", "RGB DISPLAY", "DOT DISPLAY", "LED", "7-SEGMENT", "PULSE", "CLOCK", "KEY", "BUZZER", "3-STATE BUFFER", "BUS-8", "IN-8", "OUT-8"];
	const cols = 5;
	for (let i = 0; i < names.length; i++) {
		await h.place(names[i], 200 + (i % cols) * 210, 150 + Math.floor(i / cols) * 180);
		if (names[i] === "BUS-8") await h.click(200 + (i % cols) * 210, 150 + Math.floor(i / cols) * 180 + 80); // place terminus
	}
	const placed = await ev(() => window.dls.Project.ActiveProject.ViewedChip.Elements.map((e) => e.Description?.Name ?? e.kind));
	console.log(" placed:", placed.join(", "));
	for (const n of names.slice(0, -2)) check(placed.includes(n), "placed " + n);
	check(placed.filter((n) => n === "devpin").length === 2, "placed IN-8 and OUT-8");
	check(placed.includes("BUS-TERMINUS-8"), "bus terminus placed");
	await h.move(640, 690);
	await wait(1500);
	await h.shot("f01_builtins");

	// ---- ROM edit via context menu ----
	await h.click(200, 150, "right");
	await h.shot("f02_rom_context");
	await h.click(228, 189); // Edit
	await wait(800);
	check((await ev(() => window.dls.UIDrawer.ActiveMenu)) === 9, "ROM edit menu opened");
	await h.shot("f03_rom_edit");
	await h.key("Backspace");
	await h.type("1234");
	await h.key("Enter");
	await h.key("Backspace");
	await h.type("65535");
	await h.key("Enter");
	await h.click(1201, 90); // next display mode
	await wait(500);
	await h.shot("f04_rom_mode");
	await h.click(1153, 231); // CONFIRM
	await wait(600);
	const romData = await ev(() => window.dls.Project.ActiveProject.ViewedChip.GetSubchips().find((c) => c.Description.Name.startsWith("ROM")).InternalData.slice(0, 3));
	console.log(" rom data:", romData);
	check(romData[0] === 1234 && romData[1] === 65535 && romData[2] === 0, "ROM edits confirmed");

	// ---- Other context menus ----
	for (const [n, x, y] of [["in8", 409, 510]]) {
		await h.click(x, y, "right");
		await h.shot("f05_ctx_" + n);
		await h.key("Escape");
	}

	// Context menu entry i (0 = title row); gap = extra offset after a separator
	const ctx = async (x, y, i, gap = 0) => {
		await h.click(x, y, "right");
		await h.click(x + 28, y + 13 + 26 * i + gap);
	};
	const sub = (name) => ev((n) => window.dls.Project.ActiveProject.ViewedChip.GetSubchips().find((c) => c.Description.Name === n), name);
	const subData = (name) => ev((n) => Array.from(window.dls.Project.ActiveProject.ViewedChip.GetSubchips().find((c) => c.Description.Name === n).InternalData), name);

	// Pulse width
	await ctx(200, 330, 1);
	await h.shot("f06_pulse_edit");
	check((await ev(() => window.dls.UIDrawer.ActiveMenu)) === 10, "pulse edit menu opened");
	await h.key("Backspace");
	await h.key("Backspace");
	await h.type("7");
	await h.key("Enter");
	await wait(500);
	console.log(" pulse data:", await subData("PULSE"));
	check((await subData("PULSE"))[0] === 7, "pulse width set to 7");
	check((await ev(() => window.dls.UIDrawer.ActiveMenu)) === 0, "pulse menu closed");

	// LED colour (Green = 4th colour, after a separator)
	await ctx(830, 150, 6, 12);
	console.log(" led data:", await subData("LED"));
	check((await subData("LED"))[0] === 3, "LED colour set to green");

	// Key rebind
	await ctx(620, 330, 1);
	await h.shot("f07_key_rebind");
	check((await ev(() => window.dls.UIDrawer.ActiveMenu)) === 8, "rebind menu opened");
	await h.key("q");
	await h.key("Enter");
	await wait(500);
	console.log(" key data:", await subData("KEY"));
	check((await subData("KEY"))[0] === "Q".charCodeAt(0), "key rebound to Q");

	// Bus flip
	const busFlips = () => ev(() => window.dls.Project.ActiveProject.ViewedChip.GetSubchips().filter((c) => c.IsBus).map((c) => [c.Description.Name, c.BusIsFlipped, Math.round(c.Position.x * 100) / 100, Math.round(c.Position.y * 100) / 100]));
	console.log(" buses before:", JSON.stringify(await busFlips()));
	await h.click(164, 510, "right");
	await h.shot("f07b_bus_ctx");
	await h.click(192, 446); // menu opens upwards near the bottom of the screen
	await h.shot("f07c_bus_after");
	const flips = await busFlips();
	console.log(" buses after:", JSON.stringify(flips));
	check(flips.some((b) => b[1]), "bus flipped");

	// Label
	await ctx(200, 330, 2);
	await h.type("P1");
	await h.key("Enter");
	await wait(400);
	check((await ev(() => window.dls.Project.ActiveProject.ViewedChip.GetSubchips().find((c) => c.Description.Name === "PULSE").Label)) === "P1", "pulse labelled");
	await h.move(640, 600);
	await h.shot("f08_after_edits");

	// ---- RGB display driven by the simulation ----
	await h.newProject("DisplayTest");
	await h.place("RGB DISPLAY", 760, 330);
	const srcs = [["IN-8", 300, 140], ["IN-4", 300, 220], ["IN-4", 300, 290], ["IN-4", 300, 360], ["IN-1", 300, 470], ["IN-1", 300, 520], ["CLOCK", 420, 620]];
	for (const [n, x, y] of srcs) await h.place(n, x, y);
	const geo = await ev(() => {
		const els = window.dls.Project.ActiveProject.ViewedChip.Elements;
		const disp = els.find((e) => e.Description?.Name === "RGB DISPLAY");
		const pos = (p) => [p.GetWorldPos().x, p.GetWorldPos().y];
		return {
			disp: disp.InputPins.map(pos),
			srcs: els.filter((e) => e !== disp).map((e) => (e.Pin ? pos(e.Pin) : pos(e.OutputPins[0]))),
		};
	});
	check(geo.srcs.length === 7, "placed display inputs");
	// display pins: ADDRESS RED GREEN BLUE RESET WRITE REFRESH CLOCK ; sources in the same order minus RESET
	const targets = [0, 1, 2, 3, 5, 6, 7];
	for (let i = 0; i < 7; i++) {
		const a = await h.toScreen(geo.srcs[i]);
		const b = await h.toScreen(geo.disp[targets[i]]);
		await h.click(a[0], a[1]);
		await h.move(b[0], b[1]);
		await h.click(b[0], b[1]);
	}
	check((await ev(() => window.dls.Project.ActiveProject.ViewedChip.Wires.length)) === 7, "display wired");
	const setInputs = (vals) =>
		ev((vals) => {
			const ins = window.dls.Project.ActiveProject.ViewedChip.GetInputPins();
			vals.forEach((v, i) => (ins[i].Pin.PlayerInputState = v));
		}, vals);
	await setInputs([0, 15, 0, 0, 1, 0]);
	await wait(800);
	await setInputs([0, 15, 0, 0, 1, 1]);
	await wait(800);
	await setInputs([255, 0, 15, 0, 1, 1]);
	await wait(800);
	await setInputs([17, 0, 0, 15, 1, 1]);
	await wait(800);
	await setInputs([0, 0, 0, 0, 0, 0]);
	await h.move(640, 690);
	await wait(1200);
	await h.shot("f09_rgb_display");
	const pix = await ev(() => {
		const d = window.dls.Project.ActiveProject.ViewedChip.GetSubchips()[0];
		const data = window.dls.Project.ActiveProject.ViewedChip.SimChip.GetSubChipFromID(d.ID).GetDisplayData();
		return data ? [data.InternalState[0], data.InternalState[255], data.InternalState[17]] : null;
	});
	console.log(" rgb pixels:", pix);
	check(pix && pix[0] === 15 && pix[1] === 15 << 4 && pix[2] === 15 << 8, "RGB display pixels written");
	await h.finish();
})();

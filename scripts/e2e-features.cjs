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

	// ---- Save + customize ----
	await h.combo("Control", "s");
	await wait(600);
	await h.shot("f10_save_menu");
	await h.type("DISP");
	await wait(400);
	await h.shot("f11_save_named");
	await h.click(640, 361); // CUSTOMIZE
	await wait(1000);
	await h.shot("f12_customize");
	const custDesc = () =>
		ev(async () => {
			const d = (await import("/src/dls/graphics/ui/menus/ChipSaveMenu.ts")).ChipSaveMenu.ActiveCustomizeDescription;
			return { size: [d.Size.x, d.Size.y], displays: d.Displays?.length ?? 0, col: d.Colour.toString?.() };
		});
	const before = await custDesc();
	console.log(" customize desc before:", JSON.stringify(before));
	await h.drag(687, 360, 900, 360); // widen
	await h.drag(637, 459, 637, 560); // taller
	await h.shot("f13_resized");
	const resized = await custDesc();
	console.log(" after resize:", JSON.stringify(resized));
	check(resized.size[0] > before.size[0] && resized.size[1] > before.size[1], "chip resized with handles");
	await h.click(115, 420); // RGB DISPLAY: start placing
	await h.move(700, 380);
	await h.click(700, 380);
	await h.move(1100, 650);
	await h.shot("f14_display_added");
	await h.click(184, 22); // CONFIRM
	await wait(800);
	await h.shot("f15_after_confirm");
	const confirmed = await custDesc();
	console.log(" after confirm:", JSON.stringify(confirmed));
	check(confirmed.displays === 1, "display added to chip");
	check((await ev(() => window.dls.UIDrawer.ActiveMenu)) === 1, "back in save menu");
	await h.click(828, 361); // SAVE
	await wait(1000);
	const saved = await ev(() => {
		const d = window.dls.Project.ActiveProject.chipLibrary.GetChipDescription("DISP");
		return d ? { size: [d.Size.x, d.Size.y], displays: d.Displays?.length ?? 0 } : null;
	});
	console.log(" saved:", JSON.stringify(saved));
	check(saved && saved.displays === 1 && saved.size[0] === confirmed.size[0], "customized chip saved to library");

	// ---- Library menu ----
	await ev(() => window.dls.UIDrawer.SetActiveMenu(2));
	await wait(800);
	await h.shot("f16_library");
	const lib = () =>
		ev(() => {
			const d = window.dls.Project.ActiveProject.description;
			return { cols: d.ChipCollections.map((c) => c.Name + ":" + c.Chips.length), starred: d.StarredList.map((s) => s.Name) };
		});
	await h.click(1151, 124); // MOVE DOWN
	await h.click(1076, 83); // ADD TO STARRED
	let l = await lib();
	console.log(" library:", JSON.stringify(l));
	check(l.cols[0].startsWith("IN/OUT") && l.cols[1].startsWith("BASIC"), "collection moved down");
	check(l.starred.includes("BASIC"), "collection starred");
	await h.click(1076, 239); // NEW COLLECTION
	await wait(500);
	await h.shot("f17_new_collection");
	await h.type("MINE");
	await h.key("Enter");
	await wait(500);
	l = await lib();
	check(l.cols.some((c) => c.startsWith("MINE")), "new collection created");
	await h.click(560, 281); // OTHER
	await wait(400);
	await h.shot("f18_other_open");
	await h.click(551, 344); // DISP chip
	await wait(400);
	await h.shot("f19_chip_selected");
	await h.click(1151, 197); // JUMP DOWN -> moves into next collection
	l = await lib();
	console.log(" library:", JSON.stringify(l));
	check(l.cols.includes("MINE:1") && l.cols.includes("OTHER:1"), "chip jumped to next collection");
	await h.shot("f20_jumped");
	await h.click(1176, 239); // DELETE
	await wait(500);
	await h.shot("f21_delete_confirm");
	await h.click(1151, 422); // confirm DELETE
	await wait(800);
	l = await lib();
	console.log(" library:", JSON.stringify(l));
	check(!l.starred.includes("DISP") && l.cols.includes("MINE:0"), "chip deleted from library and starred");
	const after = await ev(async () => {
		const fs = (await import("/src/dls/saveSystem/FileSystem.ts")).FileSystem;
		return { exists: window.dls.Project.ActiveProject.chipLibrary.HasChip("DISP"), viewed: window.dls.Project.ActiveProject.ViewedChip.ChipName, files: fs.GetFilesRecursive("Projects/DisplayTest") };
	});
	console.log(" after delete:", JSON.stringify(after));
	check(!after.exists && !after.files.includes("Projects/DisplayTest/Chips/DISP.json") && after.files.includes("Projects/DisplayTest/Deleted Chips/DISP.json"), "chip removed from library; backup kept in Deleted Chips (as original)");
	await h.shot("f22_deleted");
	await h.click(1076, 280); // EXIT LIBRARY (panel shrinks back)
	await wait(500);
	await h.shot("f23_exit_library");

	// ---- Project management (main menu) ----
	await ev(() => window.dls.Main.LoadMainMenu());
	await wait(800);
	await h.shot("f24_main_menu");
	await h.click(640, 330); // OPEN PROJECT
	await wait(600);
	await h.shot("f25_open_project");
	const projects = () => ev(async () => (await import("/src/dls/saveSystem/FileSystem.ts")).FileSystem.EnumerateDirectories("Projects").map((p) => p.split("/").pop()).sort());
	console.log(" projects:", JSON.stringify(await projects()));
	await h.click(633, 233); // Features
	await h.click(566, 608); // DUPLICATE
	await wait(500);
	await h.shot("f26_duplicate");
	await h.combo("Control", "a");
	await h.key("Backspace");
	await h.type("Dup");
	await h.key("Enter");
	await wait(800);
	let ps = await projects();
	console.log(" projects:", JSON.stringify(ps));
	check(ps.includes("Dup") && ps.includes("Features"), "project duplicated");
	await h.shot("f27_after_duplicate");
	// Dup is selected (top of list): rename it
	await h.click(712, 608); // RENAME
	await wait(500);
	await h.combo("Control", "a");
	await h.key("Backspace");
	await h.type("Renamed");
	await h.key("Enter");
	await wait(800);
	ps = await projects();
	console.log(" projects:", JSON.stringify(ps));
	check(ps.includes("Renamed") && !ps.includes("Dup"), "project renamed");
	const renamedName = await ev(async () => JSON.parse((await import("/src/dls/saveSystem/FileSystem.ts")).FileSystem.ReadAllText("Projects/Renamed/ProjectDescription.json")).ProjectName);
	check(renamedName === "Renamed", "renamed project description updated");
	await h.shot("f28_after_rename");
	await h.click(633, 198); // select Renamed (top)
	await h.click(420, 608); // DELETE
	await wait(500);
	await h.shot("f29_delete_project");
	await h.click(770, 399); // confirm DELETE
	await wait(800);
	ps = await projects();
	console.log(" projects:", JSON.stringify(ps));
	check(!ps.includes("Renamed") && ps.includes("Features"), "project deleted");
	// Open a remaining project from the list
	await h.click(633, 233); // Features (now second row after re-sort by last-opened)
	await h.click(1005, 608); // OPEN
	await wait(1500);
	check((await ev(() => window.dls.Project.ActiveProject?.description.ProjectName)) != null, "project opened from list");

	// ---- Preferences ----
	await ev(() => window.dls.UIDrawer.SetActiveMenu(5));
	await wait(800);
	await h.shot("f30_prefs");
	await h.click(977, 219); // grid -> On
	await h.click(977, 423); // sim -> Paused
	await h.click(817, 593); // CONFIRM
	await wait(600);
	const prefs = await ev(() => {
		const d = window.dls.Project.ActiveProject.description;
		return [d.Prefs_GridDisplayMode, d.Prefs_SimPaused];
	});
	console.log(" prefs:", JSON.stringify(prefs));
	check(prefs[0] === 1 && prefs[1] === true, "preferences applied (grid on, sim paused)");
	await h.move(640, 400);
	await wait(800);
	await h.shot("f31_grid_paused");
	await h.combo("Control", " "); // Ctrl+Space resumes
	await wait(500);
	check((await ev(() => window.dls.Project.ActiveProject.description.Prefs_SimPaused)) === false, "Ctrl+Space toggles pause");
	await h.finish();
})();

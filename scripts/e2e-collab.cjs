// Live collaboration end-to-end test: two browsers in one room (run `bun run dev:server` and `bun run dev` first).
// Usage: bun scripts/e2e-collab.cjs [url] [screenshotDir]
const { launch } = require("./e2eHelpers.cjs");

(async () => {
	const base = process.argv[2] || "http://localhost:5173/";
	const shotDir = process.argv[3] || null;
	let failures = 0;
	const check = (cond, msg) => {
		console.log((cond ? "PASS " : "FAIL ") + msg);
		if (!cond) failures++;
	};
	const until = async (h, f, arg, ms = 8000) => {
		try {
			await h.page.waitForFunction(f, arg, { timeout: ms, polling: 100 });
			return true;
		} catch {
			return false;
		}
	};
	const subchips = (h) => h.ev(() => window.dls.Project.ActiveProject.ViewedChip.GetSubchips().map((c) => [c.Description.Name, Math.round(c.Position.x * 1000) / 1000, Math.round(c.Position.y * 1000) / 1000]).sort());

	// ---- A creates a room with a new empty project (through the panel) ----
	const A = await launch(base);
	A.shotDir = shotDir;
	await A.page.click("#collab-toggle");
	await A.page.selectOption("#collab-panel select[title='Project to share']", "new");
	await A.page.fill("#collab-panel input[placeholder='Room name']", "E2E room");
	await A.page.click("#collab-panel button.primary:has-text('Create')");
	check(await until(A, () => window.dls.Collab.room && window.dls.Project.ActiveProject?.description.ProjectName === "Room " + window.dls.Collab.room.code), "A created a room and opened its project");
	const code = await A.ev(() => window.dls.Collab.room.code);
	console.log(" room code:", code);
	await A.page.click("#collab-toggle"); // close panel

	// ---- B joins with an invite link ----
	const B = await launch(base + "?room=" + code);
	B.shotDir = shotDir;
	check(await until(B, (c) => window.dls.Project.ActiveProject?.description.ProjectName === "Room " + c, code), "B joined via invite link");
	check(await until(A, () => window.dls.Collab.room.members.filter((m) => m.online).length === 2), "A sees B in the member list");

	// ---- Edits sync both ways ----
	await A.place("NAND", 640, 360);
	check(await until(B, () => window.dls.Project.ActiveProject.ViewedChip.GetSubchips().some((c) => c.Description.Name === "NAND")), "B sees A's new chip");
	check(JSON.stringify(await subchips(A)) === JSON.stringify(await subchips(B)), "positions match");
	await B.place("CLOCK", 800, 250);
	check(await until(A, () => window.dls.Project.ActiveProject.ViewedChip.GetSubchips().some((c) => c.Description.Name === "CLOCK")), "A sees B's new chip");

	// Move a chip by dragging it
	await A.drag(640, 360, 500, 480);
	await A.wait(800);
	check(JSON.stringify(await subchips(A)) === JSON.stringify(await subchips(B)), "moved chip position synced");

	// ---- Presence: cursor ----
	await B.move(400, 200);
	await B.move(420, 210);
	const bWorld = await B.ev(() => {
		const p = window.dls.Collab.peers;
		return [window.dls.Collab.cid, p.size];
	});
	check(await until(A, (cid) => window.dls.Collab.peers.get(cid)?.p?.c != null, bWorld[0]), "A receives B's cursor");
	await A.shot("collab_A_presence");

	// ---- Saving: the chip appears in B's library and B follows the rename ----
	await A.combo("Control", "s");
	await A.wait(600);
	await A.type("SYNCED");
	await A.wait(300);
	await A.click(828, 361); // SAVE
	check(await until(B, () => window.dls.Project.ActiveProject.chipLibrary.HasChip("SYNCED")), "saved chip appears in B's library");
	check(await until(B, () => window.dls.Project.ActiveProject.ViewedChip.ChipName === "SYNCED"), "B follows the saved chip");

	// ---- Roles: B becomes a viewer ----
	const bUid = await B.ev(() => window.dls.Collab.uid);
	await A.ev((uid) => window.dls.Collab.Manage(window.dls.Collab.room.code, { a: "role", uid, role: "viewer" }), bUid);
	check(await until(B, () => window.dls.Collab.ReadOnly), "B is read-only after becoming a viewer");
	const before = await subchips(B);
	await B.place("KEY", 900, 500);
	await B.wait(800);
	check(JSON.stringify(await subchips(B)) === JSON.stringify(before), "viewer can't place chips");
	await A.ev((uid) => window.dls.Collab.Manage(window.dls.Collab.room.code, { a: "role", uid, role: "editor" }), bUid);
	check(await until(B, () => !window.dls.Collab.ReadOnly), "B can edit again");

	// ---- Reconnect: B's connection drops while A edits ----
	await B.ev(() => window.dls.Collab.ws.close());
	await A.place("PULSE", 300, 250);
	check(await until(B, () => window.dls.Collab.status === "online" && window.dls.Project.ActiveProject.ViewedChip.GetSubchips().some((c) => c.Description.Name === "PULSE"), undefined, 15000), "B catches up after reconnecting");
	check(JSON.stringify(await subchips(A)) === JSON.stringify(await subchips(B)), "chips match after reconnect");
	await B.shot("collab_B_final");

	for (const [n, h] of [
		["A", A],
		["B", B],
	])
		check(h.errors.length === 0, `no page errors in ${n}` + (h.errors.length ? ":\n  " + h.errors.join("\n  ") : ""));
	await A.page.context().close();
	await B.page.context().close();
	console.log(failures === 0 ? "ALL PASSED" : failures + " FAILED");
	process.exit(failures === 0 ? 0 : 1);
})();

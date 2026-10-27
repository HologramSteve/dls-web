// Accounts + cloud storage end-to-end test: two browsers, one account (run the server first: `bun run build && bun run
// server`, or `bun run dev:server` + `bun run dev`). Usage: bun scripts/e2e-cloud.cjs [url] [appOnlyUrl]
const { launch } = require("./e2eHelpers.cjs");

(async () => {
	const base = process.argv[2] || "http://localhost:5173/";
	const appOnly = process.argv[3] || null;
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
	const user = "e2e" + Date.now().toString(36);
	const pass = "e2e password";

	// ---- Browser A: create an account, make a project, upload it ----
	const A = await launch(base);
	A.page.on("dialog", (d) => d.accept());
	check(await A.page.isVisible("#cloud-toggle"), "A: account button shown");
	await A.page.click("#cloud-toggle");
	await A.page.fill("#cloud-panel input[name=username]", user);
	await A.page.fill("#cloud-panel input[name=password]", pass);
	await A.page.click("#cloud-panel button:has-text('Create account')");
	check(await until(A, (u) => window.dls.Cloud.user?.username === u, user), "A: signed up and signed in");
	await A.page.evaluate(() => {
		window.dls.Main.CreateOrLoadProject("Cloud E2E", "");
		window.dls.Project.ActiveProject.NotifyExit();
		window.dls.Main.LoadMainMenu();
	});
	await A.wait(500);
	await A.page.click("#cloud-panel .item:has-text('Cloud E2E') button:has-text('Upload')");
	check(await until(A, () => window.dls.Cloud.StateOf("Cloud E2E") === "synced"), "A: project uploaded");

	// ---- Browser B: sign in, open the project from the cloud ----
	const B = await launch(base);
	B.page.on("dialog", (d) => d.accept());
	await B.page.click("#cloud-toggle");
	await B.page.fill("#cloud-panel input[name=username]", user);
	await B.page.fill("#cloud-panel input[name=password]", pass);
	await B.page.click("#cloud-panel button:has-text('Sign in')");
	check(await until(B, () => window.dls.Cloud.projects.some((p) => p.name === "Cloud E2E")), "B: sees the cloud project");
	await B.page.click("#cloud-panel .item:has-text('Cloud E2E') button:has-text('Open')");
	check(await until(B, () => window.dls.Project.ActiveProject?.description.ProjectName === "Cloud E2E" && window.dls.UIDrawer.ActiveMenu === 0), "B: downloaded and opened it");

	// ---- B changes it (a project preference is saved), A gets the update ----
	await B.page.evaluate(() => {
		const p = window.dls.Project.ActiveProject;
		p.ToggleGridDisplay();
		p.SaveCurrentProjectDescription();
	});
	check(await until(B, () => window.dls.Cloud.StateOf("Cloud E2E") === "synced" && window.dls.Cloud.projects[0].version === 2), "B: change uploaded (version 2)");
	await A.page.evaluate(() => window.dls.Cloud.SyncAll());
	check(await until(A, () => window.dls.Cloud.StateOf("Cloud E2E") === "synced" && window.dls.Cloud.projects[0].version === 2), "A: pulled version 2");
	check((await A.page.evaluate(() => window.dls.Cloud.projects[0].version)) === 2, "A: has the new version");

	// ---- Conflict: both change without syncing ----
	await B.page.evaluate(() => {
		const p = window.dls.Project.ActiveProject;
		p.ToggleGridDisplay();
		p.SaveCurrentProjectDescription();
	});
	await A.page.evaluate(() => {
		window.dls.Main.CreateOrLoadProject("Cloud E2E", "");
		window.dls.Project.ActiveProject.ToggleGridDisplay();
		window.dls.Project.ActiveProject.SaveCurrentProjectDescription();
	});
	check(await until(A, () => window.dls.Cloud.StateOf("Cloud E2E") === "conflict" || window.dls.Cloud.StateOf("Cloud E2E") === "synced"), "A: upload finished or refused");
	check(await until(B, () => ["conflict", "synced"].includes(window.dls.Cloud.StateOf("Cloud E2E"))), "B: upload finished or refused");
	const states = [await A.page.evaluate(() => window.dls.Cloud.StateOf("Cloud E2E")), await B.page.evaluate(() => window.dls.Cloud.StateOf("Cloud E2E"))];
	check(states.includes("conflict") && states.includes("synced"), "exactly one device is in conflict: " + states.join(", "));
	const loser = states[0] === "conflict" ? A : B;
	await loser.page.evaluate(() => window.dls.Cloud.ResolveConflict("Cloud E2E", "mine"));
	check(await until(loser, () => window.dls.Cloud.StateOf("Cloud E2E") === "synced"), "conflict resolved by keeping mine");

	// ---- Sign out ----
	await A.page.click("#cloud-panel button:has-text('Sign out')");
	check(await until(A, () => window.dls.Cloud.user === null), "A: signed out");
	const errors = [...A.errors, ...B.errors].filter((e) => !e.includes("409")); // (the refused upload)
	check(errors.length === 0, "no page errors " + JSON.stringify(errors));
	await A.page.context().close();
	await B.page.context().close();

	// ---- App only: no panels ----
	if (appOnly) {
		const C = await launch(appOnly);
		check(!(await C.page.isVisible("#cloud-toggle")) && !(await C.page.isVisible("#collab-toggle")), "app only: no account or collab button");
		check(await C.page.evaluate(() => !window.dls.Features.collab && !window.dls.Features.accounts), "app only: features off");
		await C.page.context().close();
	}
	console.log(failures === 0 ? "ALL PASSED" : failures + " FAILED");
	process.exit(failures === 0 ? 0 : 1);
})();

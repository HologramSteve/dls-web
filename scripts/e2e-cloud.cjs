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
	check(await until(A, () => window.dls.Cloud.StateOfLocal("Cloud E2E") === "synced"), "A: project uploaded");

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
	check(await until(B, () => window.dls.Cloud.StateOfLocal("Cloud E2E") === "synced" && window.dls.Cloud.projects[0].version === 2), "B: change uploaded (version 2)");
	await A.page.evaluate(() => window.dls.Cloud.SyncAll());
	check(await until(A, () => window.dls.Cloud.StateOfLocal("Cloud E2E") === "synced" && window.dls.Cloud.projects[0].version === 2), "A: pulled version 2");
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
	check(await until(A, () => window.dls.Cloud.StateOfLocal("Cloud E2E") === "conflict" || window.dls.Cloud.StateOfLocal("Cloud E2E") === "synced"), "A: upload finished or refused");
	check(await until(B, () => ["conflict", "synced"].includes(window.dls.Cloud.StateOfLocal("Cloud E2E"))), "B: upload finished or refused");
	const states = [await A.page.evaluate(() => window.dls.Cloud.StateOfLocal("Cloud E2E")), await B.page.evaluate(() => window.dls.Cloud.StateOfLocal("Cloud E2E"))];
	check(states.includes("conflict") && states.includes("synced"), "exactly one device is in conflict: " + states.join(", "));
	const loser = states[0] === "conflict" ? A : B;
	await loser.page.evaluate(() => window.dls.Cloud.ResolveConflict(window.dls.Cloud.projects.find((p) => p.name === "Cloud E2E"), "mine"));
	check(await until(loser, () => window.dls.Cloud.StateOfLocal("Cloud E2E") === "synced"), "conflict resolved by keeping mine");

	// ---- Collaborators: A shares the project with a second account (C), who works on it while A is away ----
	const user2 = user + "b";
	const C = await launch(base);
	C.page.on("dialog", (d) => d.accept());
	await C.page.click("#cloud-toggle");
	await C.page.fill("#cloud-panel input[name=username]", user2);
	await C.page.fill("#cloud-panel input[name=password]", pass);
	await C.page.click("#cloud-panel button:has-text('Create account')");
	check(await until(C, (u) => window.dls.Cloud.user?.username === u, user2), "C: signed up");
	await A.page.evaluate(() => {
		if (window.dls.UIDrawer.ActiveMenu !== 7) {
			window.dls.Project.ActiveProject.NotifyExit();
			window.dls.Main.LoadMainMenu();
		}
	});
	await A.page.click("#cloud-panel .item:has-text('Cloud E2E') button:has-text('Collaborators')");
	await A.page.fill("#cloud-panel .share input", user2);
	await A.page.click("#cloud-panel .share button:has-text('Add')");
	check(await until(A, (u) => window.dls.Cloud.projects[0].collaborators?.[0]?.username === u, user2), "A: added C as an editor");
	await C.page.evaluate(() => window.dls.Cloud.SyncAll());
	check(await until(C, () => window.dls.Cloud.shared[0]?.name === "Cloud E2E"), "C: sees it under Shared with me");
	await C.page.click("#cloud-panel .item:has-text('Cloud E2E') button:has-text('Open')");
	const localName = "Cloud E2E (" + user + ")";
	check(await until(C, (n) => window.dls.Project.ActiveProject?.description.ProjectName === n && window.dls.UIDrawer.ActiveMenu === 0, localName), "C: opened it as " + localName);
	const before = await C.page.evaluate(() => window.dls.Cloud.shared[0].version);
	await C.page.evaluate(() => {
		const p = window.dls.Project.ActiveProject;
		p.ToggleGridDisplay();
		p.SaveCurrentProjectDescription();
	});
	check(await until(C, (v) => window.dls.Cloud.shared[0].version === v + 1 && window.dls.Cloud.StateOf(window.dls.Cloud.shared[0]) === "synced", before), "C: edit uploaded to A's project");
	await A.page.evaluate(() => window.dls.Cloud.SyncAll());
	check(await until(A, (u) => window.dls.Cloud.projects[0].updatedBy === u && window.dls.Cloud.StateOf(window.dls.Cloud.projects[0]) === "synced", user2), "A: pulled C's edit");
	const nameInA = await A.page.evaluate(() => JSON.parse(localStorage.getItem("dls-cloud-links:" + window.dls.Cloud.user.id))["CLOUD E2E"].name);
	check(nameInA === "Cloud E2E", "A: the local copy keeps its name");

	// Viewer: read-only
	await A.page.selectOption("#cloud-panel .share select", "viewer");
	check(await until(A, () => window.dls.Cloud.projects[0].collaborators?.[0]?.role === "viewer"), "A: made C a viewer");
	await C.page.evaluate(() => window.dls.Cloud.SyncAll());
	check(await until(C, () => window.dls.Cloud.IsOpenProjectViewOnly()), "C: the open project is read-only");
	await C.page.evaluate(() => {
		window.dls.Project.ActiveProject.NotifyExit();
		window.dls.Main.LoadMainMenu();
	});
	await C.page.click("#cloud-panel .item:has-text('Cloud E2E') button:has-text('Leave')");
	check(await until(C, () => window.dls.Cloud.shared.length === 0), "C: left the project");
	await A.page.evaluate(() => window.dls.Cloud.Refresh());
	check(await until(A, () => window.dls.Cloud.projects[0].collaborators?.length === 0), "A: C is gone from the collaborators");
	await C.page.context().close();

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

// Shared helpers for the browser end-to-end scripts (Playwright + software GL, so input waits are generous).
const path = require("node:path");
const { chromium } = require("playwright");

async function launch(url = "http://localhost:5173/", userDataDir = null) {
	const args = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"];
	const viewport = { width: 1280, height: 720 };
	let browser = null;
	let ctx;
	if (userDataDir) ctx = await chromium.launchPersistentContext(userDataDir, { args, viewport });
	else {
		browser = await chromium.launch({ args });
		ctx = await browser.newContext({ viewport });
	}
	const page = ctx.pages()[0] || (await ctx.newPage());
	const errors = [];
	page.on("pageerror", (e) => errors.push("PAGEERR " + e.message + " | " + (e.stack || "").split("\n").slice(1, 5).join(" | ")));
	page.on("console", (m) => m.type() === "error" && errors.push("console " + m.text()));
	await page.goto(url);
	await page.waitForFunction(() => window.dls);
	await page.waitForTimeout(800);
	const wait = (ms) => page.waitForTimeout(ms);
	let failures = 0;
	const h = {
		page,
		errors,
		wait,
		check(cond, msg) {
			console.log((cond ? "PASS " : "FAIL ") + msg);
			if (!cond) failures++;
		},
		get failures() {
			return failures;
		},
		async move(x, y) {
			await page.mouse.move(x, y);
			await wait(350);
		},
		async click(x, y, button = "left") {
			await page.mouse.move(x, y);
			await wait(350);
			await page.mouse.down({ button });
			await wait(250);
			await page.mouse.up({ button });
			await wait(400);
		},
		async drag(x0, y0, x1, y1) {
			await page.mouse.move(x0, y0);
			await wait(350);
			await page.mouse.down();
			await wait(300);
			for (let i = 1; i <= 4; i++) {
				await page.mouse.move(x0 + ((x1 - x0) * i) / 4, y0 + ((y1 - y0) * i) / 4);
				await wait(250);
			}
			await page.mouse.up();
			await wait(400);
		},
		async key(k, hold = 250) {
			await page.keyboard.down(k);
			await wait(hold);
			await page.keyboard.up(k);
			await wait(300);
		},
		async combo(mod, k) {
			await page.keyboard.down(mod);
			await wait(250);
			await page.keyboard.down(k);
			await wait(300);
			await page.keyboard.up(k);
			await page.keyboard.up(mod);
			await wait(300);
		},
		async type(t) {
			for (const c of t) {
				await page.keyboard.down(c);
				await wait(60);
				await page.keyboard.up(c);
				await wait(150);
			}
		},
		shotDir: null,
		async shot(n) {
			if (h.shotDir) await page.screenshot({ path: path.join(h.shotDir, n + ".png") });
		},
		toScreen: (p) =>
			page.evaluate(([x, y]) => {
				const v = window.dls.WorldCam.WorldToScreenPoint({ x, y });
				return [v.x / devicePixelRatio, innerHeight - v.y / devicePixelRatio];
			}, [p.x ?? p[0], p.y ?? p[1]]),
		ev: (f, a) => page.evaluate(f, a),
		// Place a chip by name at a screen position (selection via controller, placement via real clicks)
		async place(name, x, y) {
			await page.mouse.move(x, y);
			await wait(300);
			await page.evaluate((n) => window.dls.Project.ActiveProject.controller.StartPlacingByName(n), name);
			await page.mouse.move(x + 1, y);
			await wait(400);
			await h.click(x, y);
		},
		async newProject(name) {
			await page.evaluate((n) => window.dls.Main.CreateOrLoadProject(n, ""), name);
			await wait(1500);
		},
		async finish() {
			h.check(errors.length === 0, "no page errors" + (errors.length ? ":\n  " + errors.join("\n  ") : ""));
			await ctx.close();
			if (browser) await browser.close();
			console.log(failures === 0 ? "ALL PASSED" : failures + " FAILED");
			process.exit(failures === 0 ? 0 : 1);
		},
	};
	return h;
}

module.exports = { launch };

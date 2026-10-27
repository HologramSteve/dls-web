// Account + cloud storage panel (web-only addition): an HTML overlay next to the collaboration panel, for signing in,
// and for uploading, downloading and syncing projects. See docs/accounts.md.
import { Features } from "../web/Features";
import { h, MountInBar } from "../web/Dom";
import { Cloud, IsProjectOpen, LocalProjectNames, type ProjectSyncState } from "./Cloud";
import { CloudNameKey, MinPasswordLength } from "./CloudProtocol";

const StateText: Record<ProjectSyncState, string> = {
	synced: "synced",
	pending: "changed",
	uploading: "uploading…",
	conflict: "conflict",
	"cloud-only": "cloud only",
	"local-only": "this device only",
	update: "newer in cloud",
};

function FormatSize(bytes: number): string {
	if (bytes < 1024) return bytes + " B";
	if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + " KB";
	return (bytes / 1024 / 1024).toFixed(1) + " MB";
}

function FormatTime(ms: number): string {
	const d = new Date(ms);
	return d.toDateString() === new Date().toDateString() ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : d.toLocaleDateString();
}

export const CloudPanel = {
	Init() {
		Cloud.Init();

		const root = h("div", { id: "cloud-root", class: "web-ui" });
		const dot = h("span", { class: "dot" });
		const toggleLabel = h("span", { textContent: "Account" });
		const toggle = h("button", { id: "cloud-toggle", class: "web-toggle", title: "Account and cloud storage" }, dot, toggleLabel);
		const panel = h("div", { id: "cloud-panel", class: "web-panel", hidden: true });
		root.append(h("div", { style: "display:flex" }, toggle), panel);
		MountInBar(root);

		toggle.addEventListener("click", () => {
			panel.hidden = !panel.hidden;
			if (!panel.hidden) {
				if (Cloud.user) void Cloud.SyncAll();
				Render();
			}
		});

		// ---- Persistent inputs (not rebuilt, so typing isn't interrupted) ----
		const userInput = h("input", { placeholder: "Username", maxLength: 24, autocomplete: "username", name: "username" });
		const passInput = h("input", { type: "password", placeholder: "Password", maxLength: 256, autocomplete: "current-password", name: "password" });
		const login = () => void Cloud.Login(userInput.value.trim(), passInput.value).then(() => Cloud.user && (passInput.value = ""));
		const register = () => {
			if (passInput.value.length < MinPasswordLength) return void (errorBox.textContent = `Passwords need at least ${MinPasswordLength} characters.`);
			void Cloud.Register(userInput.value.trim(), passInput.value).then(() => Cloud.user && (passInput.value = ""));
		};
		passInput.addEventListener("keydown", (e) => e.key === "Enter" && login());
		const oldPassInput = h("input", { type: "password", placeholder: "Current password", autocomplete: "current-password" });
		const newPassInput = h("input", { type: "password", placeholder: "New password", autocomplete: "new-password" });

		const errorBox = h("div", { class: "error" });
		const content = h("div");
		panel.append(
			h("div", { class: "head" }, h("span", { textContent: "Account & cloud projects" }), h("button", { textContent: "✕", title: "Close", onclick: () => (panel.hidden = true) })),
			content,
			errorBox,
		);

		const SignedOut = () => [
			h("h3", { textContent: "Sign in" }),
			h("div", { class: "row" }, userInput),
			h("div", { class: "row" }, passInput),
			h(
				"div",
				{ class: "row" },
				h("button", { class: "primary", textContent: "Sign in", disabled: Cloud.busy, onclick: login }),
				Features.registration && h("button", { textContent: "Create account", disabled: Cloud.busy, onclick: register }),
			),
			h("div", { class: "muted", textContent: "With an account your projects are stored on this server and sync between your devices. Live collaboration rooms also follow your account." }),
		];

		const ProjectRow = (name: string, info: { version: number; updated: number; bytes: number } | null) => {
			const state = Cloud.StateOf(name);
			const buttons: (HTMLElement | false)[] = [];
			if (state === "local-only") buttons.push(h("button", { class: "primary", textContent: "Upload", title: "Store in the cloud and keep it in sync", onclick: () => void Cloud.Link(name) }));
			if (state === "cloud-only") {
				buttons.push(h("button", { class: "primary", textContent: "Open", title: "Download to this device and open it", onclick: () => void Cloud.Open(name) }));
				buttons.push(h("button", { textContent: "Download", onclick: () => void Cloud.Download(name) }));
			}
			if (state === "update") buttons.push(h("button", { textContent: "Get update", disabled: IsProjectOpen(name), title: IsProjectOpen(name) ? "Close the project first" : "", onclick: () => void Cloud.Download(name, false) }));
			if (state === "conflict") {
				buttons.push(
					h("button", { textContent: "Keep mine", title: "Overwrite the cloud copy with this device's", onclick: () => confirm(`Overwrite the cloud copy of "${name}" with this device's copy?`) && void Cloud.ResolveConflict(name, "mine") }),
					h("button", { textContent: "Use cloud", title: "Replace this device's copy with the cloud's", onclick: () => confirm(`Discard this device's changes to "${name}" and use the cloud copy?`) && void Cloud.ResolveConflict(name, "cloud") }),
				);
			}
			const linked = Cloud.IsLinked(name);
			const actions = h(
				"div",
				{ class: "actions" },
				linked && h("button", { textContent: "Stop syncing", title: "Keep both copies, but stop syncing them", onclick: () => Cloud.Unlink(name) }),
				info != null &&
					h("button", { class: "danger", textContent: "Delete from cloud", onclick: () => confirm(`Delete "${name}" from your cloud storage? Copies on your devices stay.`) && void Cloud.DeleteFromCloud(name) }),
			);
			const detail = info ? `${FormatTime(info.updated)} · ${FormatSize(info.bytes)}` : "";
			return h(
				"div",
				{ class: "item" },
				h("span", { class: "dot" + (state === "synced" ? " online" : state === "uploading" || state === "pending" ? " connecting" : ""), style: state === "conflict" ? "background:var(--bad)" : "" }),
				h("span", { class: "grow", title: name }, h("b", { textContent: name }), h("div", { class: "muted", textContent: [StateText[state], detail].filter(Boolean).join(" · ") })),
				...buttons.filter((b): b is HTMLElement => b !== false),
				(linked || info != null) && actions,
			);
		};

		const SignedIn = () => {
			const user = Cloud.user!;
			const cloudKeys = new Set(Cloud.projects.map((p) => CloudNameKey(p.name)));
			const localOnly = LocalProjectNames()
				.filter((n) => !cloudKeys.has(CloudNameKey(n)))
				.sort((a, b) => a.localeCompare(b));
			const used = Cloud.projects.reduce((sum, p) => sum + p.bytes, 0);
			const changePassword = async () => {
				if (await Cloud.ChangePassword(oldPassInput.value, newPassInput.value)) {
					oldPassInput.value = newPassInput.value = "";
					alert("Password changed. Other devices were signed out.");
				}
			};
			const deleteAccount = async () => {
				const pw = prompt(`Delete the account "${user.username}" and all its cloud projects? Projects on your devices stay.\n\nEnter your password to confirm:`);
				if (pw) await Cloud.DeleteAccount(pw);
			};
			return [
				h("div", { class: "row", style: "margin-top:8px" }, h("span", { class: "grow" }, "Signed in as ", h("b", { textContent: user.username })), h("button", { textContent: "Sign out", onclick: () => void Cloud.Logout() })),
				h("h3", {}, `Cloud projects (${FormatSize(used)}) `, h("button", { textContent: "↻", title: "Refresh", style: "padding:0 6px", onclick: () => void Cloud.SyncAll() })),
				...(Cloud.projects.length > 0 ? Cloud.projects.map((p) => ProjectRow(p.name, p)) : [h("div", { class: "muted", textContent: "Nothing stored yet: upload a project below." })]),
				h("h3", { textContent: "Only on this device" }),
				...(localOnly.length > 0 ? localOnly.map((n) => ProjectRow(n, null)) : [h("div", { class: "muted", textContent: "All your projects are in the cloud." })]),
				h("div", { class: "muted", style: "margin-top:6px", textContent: "Synced projects upload after every save, and update on your other devices when they aren't open there." }),
				h("details", {}, h("summary", { class: "muted", style: "margin-top:10px;cursor:pointer", textContent: "Account settings" }),
					h("div", { class: "row" }, oldPassInput),
					h("div", { class: "row" }, newPassInput, h("button", { textContent: "Change password", onclick: () => void changePassword() })),
					h("div", { class: "row" }, h("button", { class: "danger", textContent: "Delete account", onclick: () => void deleteAccount() })),
				),
			];
		};

		let renderedMode: string | null = null;
		const Render = () => {
			const states = Cloud.user ? Cloud.projects.map((p) => Cloud.StateOf(p.name)) : [];
			dot.className = "dot" + (!Cloud.user ? "" : states.some((s) => s === "uploading" || s === "pending") ? " connecting" : " online");
			if (states.includes("conflict")) dot.setAttribute("style", "background:var(--bad)");
			else dot.removeAttribute("style");
			toggleLabel.textContent = Cloud.user ? Cloud.user.username : "Account";
			errorBox.textContent = Cloud.lastError;
			if (panel.hidden) return;
			// Don't rebuild while the user is typing (re-rendered on blur), unless they just signed in or out
			const mode = Cloud.user ? Cloud.user.id : "";
			const focused = document.activeElement;
			if (mode === renderedMode && content.contains(focused) && (focused instanceof HTMLInputElement || focused instanceof HTMLSelectElement)) return;
			renderedMode = mode;
			content.replaceChildren(...(Cloud.user ? SignedIn() : SignedOut()));
		};

		content.addEventListener("focusout", () => setTimeout(Render));
		Cloud.Subscribe(Render);
		Render();
	},
};

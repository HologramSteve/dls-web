// Account + cloud storage panel (web-only addition): an HTML overlay next to the collaboration panel, for signing in,
// and for uploading, downloading and syncing projects. See docs/accounts.md.
import { Features } from "../web/Features";
import { h, MountInBar } from "../web/Dom";
import { Cloud, IsProjectOpen, type ProjectSyncState } from "./Cloud";
import { CloudNameKey, type CloudProjectInfo, type CollaboratorRole, MinPasswordLength } from "./CloudProtocol";

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

		// Per cloud project: the collaborator inputs (kept between renders, so typing isn't interrupted) and whether the
		// collaborator list is unfolded
		const shareInputs = new Map<string, { user: HTMLInputElement; role: HTMLSelectElement }>();
		const unfolded = new Set<string>();
		const RoleSelect = (value: CollaboratorRole, onchange?: (role: CollaboratorRole) => void) => {
			const select = h("select", { title: "Role", onchange: (e: Event) => onchange?.((e.target as HTMLSelectElement).value as CollaboratorRole) });
			select.append(h("option", { value: "editor", textContent: "can edit" }), h("option", { value: "viewer", textContent: "can view" }));
			select.value = value;
			return select;
		};

		const Collaborators = (info: CloudProjectInfo) => {
			const key = CloudNameKey(info.name);
			let inputs = shareInputs.get(key);
			if (!inputs) {
				inputs = { user: h("input", { placeholder: "Username", maxLength: 24 }), role: RoleSelect("editor") };
				shareInputs.set(key, inputs);
			}
			const { user, role } = inputs;
			const add = async () => {
				if (user.value.trim() && (await Cloud.SetCollaborator(info, user.value.trim(), role.value as CollaboratorRole))) user.value = "";
			};
			user.onkeydown = (e) => e.key === "Enter" && void add();
			const list = (info.collaborators ?? []).map((c) =>
				h(
					"div",
					{ class: "row" },
					h("span", { class: "grow", textContent: c.username }),
					RoleSelect(c.role, (r) => void Cloud.SetCollaborator(info, c.username, r)),
					h("button", { textContent: "Remove", onclick: () => void Cloud.SetCollaborator(info, c.username, null) }),
				),
			);
			return h(
				"div",
				{ class: "share" },
				...(list.length > 0 ? list : [h("div", { class: "muted", textContent: "Only you. Add people to work on it together, also while you're away." })]),
				h("div", { class: "row" }, user, role, h("button", { class: "primary", textContent: "Add", onclick: () => void add() })),
			);
		};

		const StateDot = (state: ProjectSyncState) =>
			h("span", { class: "dot" + (state === "synced" ? " online" : state === "uploading" || state === "pending" ? " connecting" : ""), style: state === "conflict" ? "background:var(--bad)" : "" });

		// A project in the cloud (own or shared with the user)
		const CloudRow = (info: CloudProjectInfo) => {
			const own = Cloud.IsOwn(info);
			const state = Cloud.StateOf(info);
			const local = Cloud.LocalNameFor(info);
			const open = IsProjectOpen(local);
			const key = CloudNameKey(info.name);
			const buttons: HTMLElement[] = [];
			if (state === "cloud-only") {
				buttons.push(h("button", { class: "primary", textContent: "Open", title: "Download to this device and open it", onclick: () => void Cloud.Open(info) }));
				buttons.push(h("button", { textContent: "Download", onclick: () => void Cloud.Download(info) }));
			}
			if (state === "update") buttons.push(h("button", { textContent: "Get update", disabled: open, title: open ? "Close the project first" : "", onclick: () => void Cloud.Download(info, false) }));
			if (state === "conflict") {
				buttons.push(
					h("button", { textContent: "Keep mine", title: "Overwrite the cloud copy with this device's", onclick: () => confirm(`Overwrite the cloud copy of "${info.name}" with this device's copy?`) && void Cloud.ResolveConflict(info, "mine") }),
					h("button", { textContent: "Use cloud", title: "Replace this device's copy with the cloud's", onclick: () => confirm(`Discard this device's changes to "${info.name}" and use the cloud copy?`) && void Cloud.ResolveConflict(info, "cloud") }),
				);
			}
			const linked = state !== "cloud-only";
			const sharedCount = info.collaborators?.length ?? 0;
			const actions = h(
				"div",
				{ class: "actions" },
				own &&
					h("button", {
						textContent: sharedCount > 0 ? `Collaborators (${sharedCount})` : "Collaborators",
						onclick: () => {
							if (unfolded.has(key)) unfolded.delete(key);
							else unfolded.add(key);
							Render();
						},
					}),
				linked && h("button", { textContent: "Stop syncing", title: "Keep both copies, but stop syncing them", onclick: () => Cloud.Unlink(local) }),
				own && h("button", { class: "danger", textContent: "Delete from cloud", onclick: () => confirm(`Delete "${info.name}" from your cloud storage${sharedCount > 0 ? " (also for its collaborators)" : ""}? Copies on devices stay.`) && void Cloud.DeleteFromCloud(info) }),
				!own && h("button", { class: "danger", textContent: "Leave", title: "Stop collaborating on this project", onclick: () => confirm(`Leave "${info.name}" by ${info.owner}? A copy stays on this device.`) && void Cloud.Leave(info) }),
			);
			const who = own ? (info.updatedBy && info.updatedBy !== Cloud.user?.username ? "saved by " + info.updatedBy : "") : `by ${info.owner} · ${info.role === "editor" ? "you can edit" : "view only"}`;
			const detail = [StateText[state], who, FormatTime(info.updated), FormatSize(info.bytes)].filter(Boolean).join(" · ");
			return h(
				"div",
				{ class: "item" },
				StateDot(state),
				h("span", { class: "grow", title: local }, h("b", { textContent: info.name }), h("div", { class: "muted", textContent: detail })),
				...buttons,
				actions,
				own && unfolded.has(key) && Collaborators(info),
			);
		};

		// A local project that isn't in the cloud
		const LocalRow = (name: string) =>
			h(
				"div",
				{ class: "item" },
				StateDot("local-only"),
				h("span", { class: "grow", title: name }, h("b", { textContent: name }), h("div", { class: "muted", textContent: StateText["local-only"] })),
				h("button", { class: "primary", textContent: "Upload", title: "Store in the cloud and keep it in sync", onclick: () => void Cloud.Link(name) }),
			);

		const SignedIn = () => {
			const user = Cloud.user!;
			const localOnly = Cloud.LocalOnlyProjects().sort((a, b) => a.localeCompare(b));
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
				...(Cloud.projects.length > 0 ? Cloud.projects.map(CloudRow) : [h("div", { class: "muted", textContent: "Nothing stored yet: upload a project below." })]),
				Cloud.shared.length > 0 && h("h3", { textContent: "Shared with me" }),
				...Cloud.shared.map(CloudRow),
				h("h3", { textContent: "Only on this device" }),
				...(localOnly.length > 0 ? localOnly.map(LocalRow) : [h("div", { class: "muted", textContent: "All your projects are in the cloud." })]),
				h("div", { class: "muted", style: "margin-top:6px", textContent: "Synced projects upload after every save, and update on your other devices (and your collaborators') when they aren't open there." }),
				h("details", {}, h("summary", { class: "muted", style: "margin-top:10px;cursor:pointer", textContent: "Account settings" }),
					h("div", { class: "row" }, oldPassInput),
					h("div", { class: "row" }, newPassInput, h("button", { textContent: "Change password", onclick: () => void changePassword() })),
					h("div", { class: "row" }, h("button", { class: "danger", textContent: "Delete account", onclick: () => void deleteAccount() })),
				),
			];
		};

		let renderedMode: string | null = null;
		const Render = () => {
			const states = Cloud.user ? [...Cloud.projects, ...Cloud.shared].map((p) => Cloud.StateOf(p)) : [];
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
			content.replaceChildren(...(Cloud.user ? SignedIn() : SignedOut()).filter((n) => n !== false));
		};

		content.addEventListener("focusout", () => setTimeout(Render));
		Cloud.Subscribe(Render);
		Render();
	},
};

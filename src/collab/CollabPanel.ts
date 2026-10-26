// Live collaboration panel (web-only addition): an HTML overlay (not part of the ported immediate-mode UI) for the
// profile, creating/joining rooms by code, the member list and room management.
import { Main } from "../dls/game/Main";
import { Project } from "../dls/game/Project";
import { MenuType, UIDrawer } from "../dls/graphics/ui/UIDrawer";
import { Loader } from "../dls/saveSystem/Saver";
import { Collab, CollabServerUrl, RoomProjectName } from "./Collab";
import { NormalizeRoomCode, RoomCodeLength } from "./Protocol";

const css = `
@font-face { font-family: "DLS Mono"; src: url("./fonts/JetBrainsMonoNL-Regular.ttf"); }
@font-face { font-family: "DLS Mono"; font-weight: bold; src: url("./fonts/JetBrainsMonoNL-Bold.ttf"); }
#collab-root { --bg: #1d1d1f; --bg2: #2a2a2d; --bg3: #3a3a3e; --fg: #e8e8e8; --dim: #9a9a9f; --acc: #4f9dde; --bad: #e0534a; --good: #4fbf6a;
  position: fixed; top: 8px; right: 8px; z-index: 10; font: 13px "DLS Mono", ui-monospace, monospace; color: var(--fg); }
#collab-root * { box-sizing: border-box; font: inherit; }
#collab-root button { background: var(--bg3); color: var(--fg); border: 0; border-radius: 4px; padding: 5px 9px; cursor: pointer; }
#collab-root button:hover { filter: brightness(1.25); }
#collab-root button.primary { background: var(--acc); color: #000; font-weight: bold; }
#collab-root button.danger { background: var(--bad); color: #000; }
#collab-root button:disabled { opacity: .45; cursor: default; filter: none; }
#collab-root input, #collab-root select { background: var(--bg); color: var(--fg); border: 1px solid var(--bg3); border-radius: 4px; padding: 5px 7px; min-width: 0; }
#collab-root input[type=color] { padding: 0 2px; width: 36px; height: 29px; }
#collab-toggle { display: flex; align-items: center; gap: 7px; margin-left: auto; box-shadow: 0 2px 8px #0008; }
#collab-root .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--dim); display: inline-block; flex: none; }
#collab-root .dot.online { background: var(--good); } #collab-root .dot.connecting { background: #e0b84a; }
#collab-panel { margin-top: 6px; width: min(370px, calc(100vw - 16px)); max-height: calc(100vh - 60px); overflow: auto; background: var(--bg2);
  border-radius: 6px; box-shadow: 0 4px 18px #000a; padding: 10px 12px 12px; }
#collab-panel[hidden] { display: none; }
#collab-panel h3 { margin: 12px 0 6px; font-weight: bold; font-size: 12px; color: var(--dim); letter-spacing: .06em; text-transform: uppercase; }
#collab-panel .row { display: flex; gap: 6px; align-items: center; margin: 5px 0; }
#collab-panel .row > input:not([type=color]), #collab-panel .row > select { flex: 1; }
#collab-panel .head { display: flex; justify-content: space-between; align-items: center; font-weight: bold; }
#collab-panel .code { font-size: 26px; font-weight: bold; letter-spacing: .18em; color: var(--acc); user-select: all; }
#collab-panel .item { display: flex; gap: 7px; align-items: center; padding: 6px 7px; background: var(--bg); border-radius: 4px; margin: 4px 0; flex-wrap: wrap; }
#collab-panel .item .grow { flex: 1; min-width: 90px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#collab-panel .muted { color: var(--dim); font-size: 12px; }
#collab-panel .badge { font-size: 11px; padding: 1px 6px; border-radius: 8px; background: var(--bg3); color: var(--dim); }
#collab-panel .error { color: var(--bad); margin-top: 8px; white-space: pre-wrap; }
#collab-panel .actions { display: flex; gap: 4px; flex-wrap: wrap; width: 100%; padding-left: 16px; }
#collab-panel .actions button, #collab-panel .actions select { padding: 3px 7px; font-size: 12px; }
#collab-panel label.check { display: flex; gap: 6px; align-items: center; cursor: pointer; }
`;

function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...children: (Node | string | null | false)[]): HTMLElementTagNameMap[K] {
	const el = document.createElement(tag);
	for (const [k, v] of Object.entries(props)) {
		if (k === "class") el.className = String(v);
		else if (k === "style") el.setAttribute("style", String(v));
		else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.substring(2), v as EventListener);
		else (el as unknown as Record<string, unknown>)[k] = v;
	}
	for (const c of children) if (c !== null && c !== false) el.append(c);
	return el;
}

function InviteLink(code: string): string {
	return location.origin + location.pathname + "?room=" + code;
}

function Copy(text: string, button: HTMLButtonElement) {
	const done = () => {
		const old = button.textContent;
		button.textContent = "Copied";
		setTimeout(() => (button.textContent = old), 1200);
	};
	navigator.clipboard?.writeText(text).then(done, () => prompt("Copy:", text));
}

function OpenProjectName(): string | null {
	if (UIDrawer.ActiveMenu === MenuType.MainMenu || !Project.ActiveProject) return null;
	return Project.ActiveProject.description.ProjectName;
}

// Joining replaces the open project: ask before discarding unsaved changes
function ConfirmLeaveCurrentProject(): boolean {
	if (Collab.InRoom) return true;
	const project = OpenProjectName() != null ? Project.ActiveProject : null;
	if (project && project.ActiveChipHasUnsavedChanges()) return confirm("The chip you are editing has unsaved changes. Discard them and continue?");
	return true;
}

export const CollabPanel = {
	Init() {
		document.head.append(h("style", { textContent: css }));
		const root = h("div", { id: "collab-root" });
		// Keep typing in the panel away from the game's keyboard shortcuts
		for (const type of ["keydown", "keyup", "keypress", "paste", "pointerdown", "wheel"]) root.addEventListener(type, (e) => e.stopPropagation());

		const dot = h("span", { class: "dot" });
		const toggleLabel = h("span", { textContent: "Collab" });
		const toggle = h("button", { id: "collab-toggle", title: "Live collaboration" }, dot, toggleLabel);
		const panel = h("div", { id: "collab-panel", hidden: true });
		root.append(h("div", { style: "display:flex" }, toggle), panel);
		document.body.append(root);

		toggle.addEventListener("click", () => {
			panel.hidden = !panel.hidden;
			if (!panel.hidden) {
				Collab.Connect();
				if (!Collab.InRoom) Collab.RefreshRooms();
				Render();
			}
		});

		// ---- Persistent inputs (not rebuilt, so typing isn't interrupted) ----
		const nameInput = h("input", { value: Collab.name, maxLength: 24, placeholder: "Your name" });
		const colorInput = h("input", { type: "color", value: Collab.color, title: "Your colour" });
		const saveProfile = () => Collab.SetProfile(nameInput.value, colorInput.value);
		nameInput.addEventListener("change", saveProfile);
		colorInput.addEventListener("change", saveProfile);

		const codeInput = h("input", { placeholder: "ROOM CODE", maxLength: RoomCodeLength + 2, style: "text-transform:uppercase;letter-spacing:.15em" });
		const join = () => {
			const code = NormalizeRoomCode(codeInput.value);
			if (code.length !== RoomCodeLength) return void (errorBox.textContent = `Room codes have ${RoomCodeLength} characters.`);
			if (ConfirmLeaveCurrentProject()) Collab.JoinRoom(code);
		};
		codeInput.addEventListener("keydown", (e) => e.key === "Enter" && join());
		const roomNameInput = h("input", { placeholder: "Room name", maxLength: 40 });
		const sourceSelect = h("select", { title: "Project to share" });
		const renameInput = h("input", { maxLength: 40, placeholder: "Room name" });

		const errorBox = h("div", { class: "error" });
		const content = h("div");
		panel.append(
			h("div", { class: "head" }, h("span", { textContent: "Live collaboration" }), h("button", { textContent: "✕", title: "Close", onclick: () => (panel.hidden = true) })),
			h("h3", { textContent: "You" }),
			h("div", { class: "row" }, nameInput, colorInput),
			content,
			errorBox,
			h("div", { class: "muted", style: "margin-top:10px", textContent: "Server: " + CollabServerUrl() }),
		);

		const FillSources = () => {
			const current = OpenProjectName();
			const old = sourceSelect.value;
			sourceSelect.textContent = "";
			if (current != null) sourceSelect.append(h("option", { value: "p:" + current, textContent: `Current project (${current})` }));
			sourceSelect.append(h("option", { value: "new", textContent: "New empty project" }));
			for (const d of Loader.LoadAllProjectDescriptions()) {
				if (d.ProjectName === current) continue;
				sourceSelect.append(h("option", { value: "p:" + d.ProjectName, textContent: "Project: " + d.ProjectName }));
			}
			if (Array.from(sourceSelect.options).some((o) => o.value === old)) sourceSelect.value = old;
		};

		const Lobby = () => {
			FillSources();
			if (!roomNameInput.value) roomNameInput.value = OpenProjectName() ?? "";
			const create = () => {
				const src = sourceSelect.value;
				const projectName = src.startsWith("p:") ? src.substring(2) : null;
				if (!ConfirmLeaveCurrentProject()) return;
				Collab.CreateRoom(roomNameInput.value || projectName || "Untitled room", projectName);
			};
			const rooms = Collab.rooms.map((r) =>
				h(
					"div",
					{ class: "item" },
					h("span", { class: "dot" + (r.online > 0 ? " online" : ""), title: `${r.online} online` }),
					h("span", { class: "grow", title: r.name }, h("b", { textContent: r.code }), " " + r.name),
					h("span", { class: "badge", textContent: r.role }),
					h("button", { textContent: "Join", onclick: () => ConfirmLeaveCurrentProject() && Collab.JoinRoom(r.code) }),
					r.owner && h("button", { class: "danger", textContent: "Delete", onclick: () => confirm(`Delete room ${r.code} (${r.name}) for everyone?`) && Collab.Manage(r.code, { a: "delete" }) }),
				),
			);
			return [
				h("h3", { textContent: "Join a room" }),
				h("div", { class: "row" }, codeInput, h("button", { class: "primary", textContent: "Join", onclick: join })),
				h("h3", { textContent: "Create a room" }),
				h("div", { class: "row" }, roomNameInput),
				h("div", { class: "row" }, sourceSelect, h("button", { class: "primary", textContent: "Create", onclick: create })),
				h("div", { class: "muted", textContent: "The project is copied to the server; everyone in the room edits it live." }),
				h("h3", {}, "Your rooms ", h("button", { textContent: "↻", title: "Refresh", style: "padding:0 6px", onclick: () => Collab.RefreshRooms() })),
				...(rooms.length > 0 ? rooms : [h("div", { class: "muted", textContent: "No rooms yet." })]),
			];
		};

		const InRoom = () => {
			const room = Collab.room!;
			const owner = Collab.IsOwner;
			const peersByUid = new Map<string, string[]>();
			for (const peer of Collab.peers.values()) {
				const list = peersByUid.get(peer.uid) ?? [];
				list.push(peer.cid);
				peersByUid.set(peer.uid, list);
			}
			const copyCode = h("button", { textContent: "Copy code", onclick: () => Copy(room.code, copyCode) });
			const copyLink = h("button", { textContent: "Copy invite link", onclick: () => Copy(InviteLink(room.code), copyLink) });

			const members = room.members
				.slice()
				.sort((a, b) => b.online - a.online)
				.map((m) => {
					const me = m.uid === Collab.uid;
					const cids = peersByUid.get(m.uid) ?? [];
					const where = cids.map((c) => Collab.peers.get(c)?.p).find((p) => p != null);
					const whereText = me ? "you" : m.online === 0 ? "offline" : where ? "on " + (where.chipName || "new chip") + (where.view ? " (viewing)" : "") : "online";
					const roleSelect = h("select", { title: "Role", onchange: (e: Event) => Collab.Manage(room.code, { a: "role", uid: m.uid, role: (e.target as HTMLSelectElement).value as "editor" | "viewer" }) });
					roleSelect.append(h("option", { value: "editor", textContent: "editor" }), h("option", { value: "viewer", textContent: "viewer" }));
					roleSelect.value = m.role;
					const manage = owner && !me && m.role !== "owner";
					return h(
						"div",
						{ class: "item" },
						h("span", { class: "dot", style: `background:${m.color};opacity:${m.online > 0 ? 1 : 0.35}` }),
						h("span", { class: "grow" }, h("b", { textContent: m.name }), h("div", { class: "muted", textContent: whereText })),
						h("span", { class: "badge", textContent: m.role }),
						!me && cids.length > 0 && h("button", { textContent: "Go to", title: "Open their chip and jump to their cursor", onclick: () => Collab.Follow(cids[0]) }),
						manage &&
							h(
								"div",
								{ class: "actions" },
								roleSelect,
								h("button", { textContent: "Make owner", onclick: () => confirm(`Make ${m.name} the owner of this room? You become an editor.`) && Collab.Manage(room.code, { a: "transfer", uid: m.uid }) }),
								h("button", { textContent: "Kick", onclick: () => Collab.Manage(room.code, { a: "kick", uid: m.uid }) }),
								h("button", { class: "danger", textContent: "Ban", onclick: () => confirm(`Ban ${m.name} from this room?`) && Collab.Manage(room.code, { a: "kick", uid: m.uid, ban: true }) }),
							),
					);
				});

			const nodes: (Node | false)[] = [
				h("h3", { textContent: "Room" }),
				h("div", { class: "row" }, h("b", { class: "grow", textContent: room.name }), h("span", { class: "badge", textContent: "you: " + (Collab.MyRole ?? "?") })),
				h("div", { class: "row" }, h("span", { class: "code", textContent: room.code })),
				h("div", { class: "row" }, copyCode, copyLink),
				Collab.MyRole === "viewer" && h("div", { class: "muted", textContent: "You are a viewer: you can watch, but not edit." }),
				h("h3", { textContent: `People (${room.members.filter((m) => m.online > 0).length} online)` }),
				...members,
			];

			if (owner) {
				if (document.activeElement !== renameInput) renameInput.value = room.name;
				const defaultRole = h("select", { onchange: (e: Event) => Collab.Manage(room.code, { a: "defaultRole", role: (e.target as HTMLSelectElement).value as "editor" | "viewer" }) });
				defaultRole.append(h("option", { value: "editor", textContent: "New people can edit" }), h("option", { value: "viewer", textContent: "New people can only view" }));
				defaultRole.value = room.defaultRole;
				const lock = h("input", { type: "checkbox", checked: room.locked, onchange: (e: Event) => Collab.Manage(room.code, { a: "lock", locked: (e.target as HTMLInputElement).checked }) });
				nodes.push(
					h("h3", { textContent: "Manage room" }),
					h("div", { class: "row" }, renameInput, h("button", { textContent: "Rename", onclick: () => Collab.Manage(room.code, { a: "rename", name: renameInput.value }) })),
					h("div", { class: "row" }, defaultRole),
					h("div", { class: "row" }, h("label", { class: "check" }, lock, "Locked (only existing members can join)")),
					h("div", { class: "row" }, h("button", { class: "danger", textContent: "Delete room", onclick: () => confirm("Delete this room for everyone? The project stays on your computer as a local copy.") && Collab.Manage(room.code, { a: "delete" }) })),
				);
			}
			nodes.push(
				h("div", { class: "row", style: "margin-top:12px" }, h("button", { textContent: "Leave room", onclick: LeaveToMainMenu })),
				h("div", { class: "muted", textContent: `A local copy is kept as the project "${RoomProjectName(room.code)}".` }),
			);
			return nodes.filter((n): n is Node => n !== false);
		};

		const Render = () => {
			dot.className = "dot " + Collab.status;
			const online = Collab.room?.members.filter((m) => m.online > 0).length ?? 0;
			toggleLabel.textContent = Collab.room ? `${Collab.room.code} · ${online} online` : "Collab";
			nameInput.disabled = colorInput.disabled = false;
			errorBox.textContent = Collab.lastError;
			if (panel.hidden) return;
			// Don't rebuild while the user is typing/choosing in the dynamic part (re-rendered on blur)
			const focused = document.activeElement;
			if (content.contains(focused) && (focused instanceof HTMLInputElement || focused instanceof HTMLSelectElement)) return;
			content.replaceChildren(...(Collab.room ? InRoom() : Lobby()));
		};

		content.addEventListener("focusout", () => setTimeout(Render));
		Collab.Subscribe(Render);
		setInterval(() => !panel.hidden && Collab.room && Render(), 1000); // ("on <chip>" info comes from presence)
		Render();

		// Invite links (?room=CODE) and rooms from before a page reload are joined automatically
		const fromUrl = new URLSearchParams(location.search).get("room");
		const code = fromUrl ? NormalizeRoomCode(fromUrl) : Collab.RememberedRoom;
		if (code && code.length === RoomCodeLength) {
			if (fromUrl) history.replaceState(null, "", location.pathname);
			Collab.JoinRoom(code);
		}
	},
};

// Leaving the room also closes its project (it stays available locally as a normal project)
function LeaveToMainMenu() {
	Collab.LeaveRoom();
	if (UIDrawer.ActiveMenu !== MenuType.MainMenu && Project.ActiveProject) {
		Project.ActiveProject.NotifyExit();
		Main.LoadMainMenu();
	}
}

// Live collaboration panel (web-only addition): an HTML overlay (not part of the ported immediate-mode UI) for the
// profile, creating/joining rooms by code, the member list and room management.
import { Main } from "../dls/game/Main";
import { Project } from "../dls/game/Project";
import { MenuType, UIDrawer } from "../dls/graphics/ui/UIDrawer";
import { Loader } from "../dls/saveSystem/Saver";
import { Collab, CollabServerUrl, RoomProjectName } from "./Collab";
import { NormalizeRoomCode, RoomCodeLength } from "./Protocol";
import { Copy, h, MountInBar } from "../web/Dom";

function InviteLink(code: string): string {
	return location.origin + location.pathname + "?room=" + code;
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
		const root = h("div", { id: "collab-root", class: "web-ui" });

		const dot = h("span", { class: "dot" });
		const toggleLabel = h("span", { textContent: "Collab" });
		const toggle = h("button", { id: "collab-toggle", class: "web-toggle", title: "Live collaboration" }, dot, toggleLabel);
		const panel = h("div", { id: "collab-panel", class: "web-panel", hidden: true });
		root.append(h("div", { style: "display:flex" }, toggle), panel);
		MountInBar(root);

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

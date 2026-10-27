# Live collaboration (web-only)

Several people edit one project together in a **room**, on one central server. Everyone sees the others' cursors,
selections, chips being dragged and wires being drawn, live. This doesn't exist in the original; it is layered on
top of the port without changing the ported game code (apart from a few documented hooks).

## Using it

1. Click the button at the top right ("Live collaboration"). Set your name and colour.
2. **Create a room.** Pick what to share: the current project, a new empty project, or any of your projects. The
   project is copied to the server. You get a 6-character code (e.g. `K7QX2M`) and an invite link
   (`https://your-server/?room=K7QX2M`).
3. **Join.** Others enter the code, or open the link. The room opens as the project "Room K7QX2M" in their browser.
4. **Edit together.** Placing, moving, deleting, wiring, labels, inputs, saving chips, renaming, deleting chips,
   collections and stars all sync. "Go to" next to a member jumps to the chip they're on and to their cursor.
5. **Leave** from the panel, or go back to the main menu. Your rooms stay listed under "Your rooms".

Owner controls (in the panel): rename the room, set the default role for new members, lock it (no new members),
change members' roles (editor / viewer), kick, ban, make someone else the owner, delete the room.
Viewers see everything live but can't change anything.

Identity is a random key kept in the browser (localStorage): the same browser is the same user, and clearing site
data makes you a new user (an owner would lose ownership of their rooms). Signed in to an account
([accounts.md](accounts.md)), you are the account instead, in every browser, and your browser's rooms move to it.

## Running the server

The server is one Bun process. It serves the built app (`dist/`) and the WebSocket at `/ws`, and stores rooms as
JSON files.

```sh
bun install && bun run build
bun run server                    # http://localhost:8787
```

Or with Docker:

```sh
docker build -t dls-web .
docker run -d -p 8787:8787 -v dls-data:/data --restart unless-stopped dls-web
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8787` | HTTP + WebSocket port |
| `DATA_DIR` | `./data` (`/data` in Docker) | Rooms are stored as `rooms/<CODE>.json` |
| `STATIC_DIR` | `./dist` | Built web app |
| `APP_ONLY` | | `1`: just the app, no collaboration or accounts. More flags in [accounts.md](accounts.md#feature-flags) |

For HTTPS, put it behind a reverse proxy that passes WebSocket upgrades. The client connects to `wss://<same
host>/ws` automatically. With Caddy, `your.domain { reverse_proxy localhost:8787 }` is enough. With nginx, use
`proxy_http_version 1.1` plus the `Upgrade` / `Connection` headers on `/ws`.

The app can also be hosted elsewhere (any static host) and pointed at the server: build with
`VITE_COLLAB_URL=wss://server/ws`, or add `?collab=wss://server/ws` to the URL.

**Development:** run `bun run dev:server` (port 8787, restarts on changes) and `bun run dev`. Vite proxies `/ws`
to the server.

**Health check:** `GET /healthz`. Rooms are written every 2 s and on shutdown (SIGINT/SIGTERM). Rooms nobody has
opened for 30 days are deleted.

**Limits** (`DefaultLimits` in `server/rooms.ts`):
- 20 rooms per owner;
- 64 MB per room, 4 MB per file, 5000 files;
- 80 MB per message.

## How it works

Files: `src/collab/` (client), `server/` (server), `tests/collab.test.ts`.

| File | Role |
| --- | --- |
| `src/collab/Protocol.ts` | Shared by client and server: message types, the chip doc format, applying/diffing ops, `DocSyncCore`, inbox compaction |
| `src/collab/Collab.ts` | Client session: connection, rooms, file sync, chip sync, presence |
| `src/collab/ChipSync.ts` | Edited chip ↔ doc conversion, and reconciling the edited chip to a doc with the editor's own operations |
| `src/collab/PresenceDrawer.ts` | Draws the others' cursors, selections, ghosts and wires |
| `src/collab/CollabPanel.ts` | The DOM panel (lobby, room, members, owner controls) |
| `server/rooms.ts` | `RoomManager`: rooms, roles, ordering, persistence (transport-independent, unit tested) |
| `server/index.ts` | Bun HTTP/WebSocket server, static files, file-based room store |

### Two levels of sync

**1. Project files.** A room *is* a project folder: `ProjectDescription.json` and `Chips/*.json`, exactly the save
format. A `FileSystem.AddChangeListener` hook catches every write the game makes under `Projects/Room <CODE>/`. Changes
are batched per frame and sent; the server stores them and relays them to everyone. Receivers write the files and
reload the project description and chip library. So anything the game saves syncs, including saving chips, renames,
deletes, collections, stars and preferences, with no per-feature code.

The server keeps `AllCustomChipNames` consistent with the chip files that actually exist, because two people saving
different chips at once would otherwise overwrite each other's lists.

**2. The chip being edited** (unsaved work on the canvas). This syncs element by element, while you edit:
- **Doc format.** The chip is a `ChipDoc` with subchips and pins keyed by ID, and wires keyed by their endpoints
  (`owner.pin>owner.pin`).
- **Sending.** Each frame, the client diffs the canvas against the last known state and sends ops: set or delete
  one element.
- **Ordering.** The server applies ops in arrival order (the single source of truth), acks them to the sender and
  relays them to the others on the same chip.
- **Conflicts.** If two people change the same element at once, the later one wins. A delete wins over a
  concurrent move. Wires attached to a deleted element are deleted with it.
- **Your own unconfirmed edits.** Ops you sent that the server hasn't acked yet are kept on top of incoming remote
  state, so your own drag never jumps back.
- **Applying remote changes.** The client applies them to the real game objects using the editor's own
  operations (`AddNewSubChip`, `DeleteSubChip`, `AddNewDevPin`, wire loading). The simulation is updated
  incrementally and keeps its state.
- **Safety net.** Every 4 s the client sends a hash of its state. On a mismatch the server sends the whole doc.
  Coordinates are rounded to 1e-6 so float noise in recomputed wire points doesn't count as a change.

Remote changes are applied only while you're idle: no menu open, not dragging, placing or wiring. They're applied
right after you let go, so the editor's state never changes under your hands.

### Presence
About 20 times a second, each client sends:
- its cursor;
- its selection;
- the outlines of what it's dragging or placing;
- the points of the wire it's drawing.

Others draw these at constant screen size, smoothed.

### Background tabs, slow clients, reconnects
- **Background tabs.** A background tab gets no animation frames, so incoming messages queue. Once the queue
  passes 64 messages it's compacted (`CompactInbox`):
  - chip ops are dropped and replaced by one request for the whole chip;
  - file batches in a row are merged, last write per file winning.

  Coming back costs one update instead of replaying everything. While the tab is in the background, your cursor
  is hidden for the others.
- **Slow clients.** If a client stops reading (a frozen tab or a bad connection), the server first drops cursor
  updates to it. If its backlog passes 128 MB, the server closes the connection.
- **Reconnects.** Clients reconnect automatically with backoff and rejoin the room:
  - files changed meanwhile are brought up to date;
  - edits made while offline are sent after rejoining;
  - the chip is fetched again.

### Roles
The server checks roles on every message and is the authority. Viewers' edits are refused, and they're sent the
real state back. On the client, `CollabState.ReadOnly` disables editing in `ChipInteractionController.HasControl`.

## Known limitations
- **Simulation is local.** Every browser runs its own simulation. Only inputs (pin states) and the circuit sync, so
  clocks and timing may be slightly out of phase between people.
- **Undo history is local.** It can refer to elements someone else changed or deleted.
- **One shared canvas for new chips.** Everyone's unsaved "new chip" canvas is the same shared one until it is
  saved under a name.
- **Remote edits wait for menus.** They aren't applied while you have a menu open; they appear when you close it.
- **No encryption at rest.** Anyone with a room code can join an unlocked room; lock it, or set the
  default role to viewer, to control that.

# Accounts and cloud storage (web-only)

With an account, projects are stored on the central server and sync between your devices. This doesn't exist in
the original; like live collaboration it sits on top of the port, in `src/cloud/` and `server/`.

## Using it

1. Click **Account** at the top right. Create an account (username + password, at least 8 characters) or sign in.
2. **Upload** a project from "Only on this device". From then on it is *synced*: every time the game saves
   something in it (saving a chip, preferences, stars, collections...), the whole project is uploaded a moment later.
3. On another device, sign in: the project is listed under "Cloud projects". **Open** downloads and opens it;
   **Download** only downloads it. Downloaded projects are synced too.
4. Synced projects that changed elsewhere are updated automatically when the panel opens, when the window gets
   focus, and every minute, unless the project is open on this device ("newer in cloud": close it, then
   **Get update**).
5. **Conflict.** If two devices change the same project without syncing in between, the second upload is refused
   and the project shows "conflict": choose **Keep mine** (overwrite the cloud copy) or **Use cloud** (discard this
   device's changes).
6. **Stop syncing** keeps both copies but no longer syncs them. **Delete from cloud** deletes the cloud copy only.
   Deleting or renaming a project on a device stops syncing it there; the cloud copy stays (upload it again under
   the new name).
7. **Collaborators.** Under one of your cloud projects, **Collaborators** lets you add other users by username,
   as **can edit** or **can view**, change their role, or remove them. The project then shows up in their panel
   under "Shared with me" (with **Open** / **Download**), in a local folder named `<project> (<owner>)`.
   - Editors work on it like on their own synced projects: their saves upload to *your* cloud copy (it counts
     against your storage), so work goes on while you are away. You get their changes like those from your other
     devices; rows say who saved last. Two people saving without syncing in between get the usual conflict.
   - Viewers get a read-only copy (the editor works like for a viewer in a live room) that updates automatically.
   - A collaborator can **Leave**; deleting the project removes it for them (their local copies stay).
   - To edit *at the same time*, use a live collaboration room (rooms keep working while the owner is away too).
8. **Account settings** (in the panel): change the password (other devices are signed out), delete the account and
   its cloud projects.

Signed in, live collaboration uses the account as your identity: your rooms are the same in every browser you sign
in to, and rooms you made in this browser before signing in move to the account.

## Hosting

The same server as live collaboration (`bun run server`, or the Docker image); see
[collaboration.md](collaboration.md) for running it. Accounts are stored in `DATA_DIR/accounts/`:
`accounts.json` (users, password hashes, session token hashes, the project index) and `projects/<user>/<hash>.json`
(one file per project).

### Feature flags

Everything is on by default. Set these environment variables to turn features off:

| Variable | Effect |
| --- | --- |
| `APP_ONLY=1` | **Just the app**: no live collaboration and no accounts / cloud storage (`/ws` and `/api` are not served, the buttons are hidden) |
| `DISABLE_COLLAB=1` | No live collaboration |
| `DISABLE_ACCOUNTS=1` | No accounts / cloud storage |
| `REGISTRATION=closed` | Existing accounts work, no new accounts can be created |

The server publishes what is on at `GET /config.json` (`{"collab":…,"accounts":…,"registration":…}`); the app reads
it on start and only shows those panels. For a static host without the server, build with `VITE_APP_ONLY=1`
(nothing is fetched and no panels are shown). Without that flag and without a `config.json`, the panels are shown,
as before.

The app can be hosted somewhere else than the server: `?collab=wss://server/ws` (or `VITE_COLLAB_URL`) points both
collaboration and the API at that server (`https://server/api`); `?api=` / `VITE_API_URL` sets the API alone. The
API allows any origin (CORS), since it uses bearer tokens, not cookies.

### Limits

`DefaultAccountLimits` in `server/accounts.ts`:
- 200 projects and 256 MB per user (shared projects count for their owner); 64 MB per project, 4 MB per file,
  5000 files; 50 collaborators per project;
- sessions expire after 180 days unused;
- 10 failed sign-ins per username or IP in 15 minutes, 5 new accounts per IP in 15 minutes. Behind a reverse proxy
  on the same machine (Caddy), the client IP comes from `X-Forwarded-For`.

## How it works

| File | Role |
| --- | --- |
| `src/cloud/CloudProtocol.ts` | Shared by client and server: types, name rules |
| `src/cloud/Cloud.ts` | Client session: sign in, links, upload / download, conflicts |
| `src/cloud/CloudPanel.ts` | The DOM panel |
| `src/web/Features.ts` | Reads `/config.json` (which panels to show) |
| `src/web/Dom.ts` | Styles, element helper and the top-right bar shared by both panels |
| `server/accounts.ts` | `AccountManager`: users, sessions, password hashing, project storage and versions (unit tested) |
| `server/api.ts` | HTTP API on top of it (standard `Request`/`Response`, unit tested) |
| `server/config.ts` | Feature flags from the environment |

- **Passwords** are hashed with scrypt (per-user salt). Sign-in returns a random token; the server keeps only its
  SHA-256. The client stores the token in localStorage and sends it as `Authorization: Bearer`.
- **API** (all JSON):

  | Request | Result |
  | --- | --- |
  | `POST /api/auth/register` `{username, password}` | `{token, user}` |
  | `POST /api/auth/login` `{username, password}` | `{token, user}` |
  | `POST /api/auth/logout` | `{}` |
  | `GET /api/auth/me` | `{user}` |
  | `POST /api/auth/password` `{old, new}` | `{}` |
  | `POST /api/auth/delete` `{password}` | `{}` |
  | `GET /api/projects` | `{projects: [...], shared: [...]}` of `{name, version, updated, bytes, owner, role, updatedBy?, collaborators?}` |
  | `GET /api/projects/<name>` | that, plus `files` |
  | `PUT /api/projects/<name>` `{files, base, force?}` | the new info, or 409 |
  | `DELETE /api/projects/<name>` | `{}` (owner only) |
  | `POST /api/projects/<name>/collaborators` `{username, role}` | the project's info; role `"editor"`, `"viewer"` or `null` (remove) |

  `GET /api/projects` returns `{projects, shared}`: your own projects (with their `collaborators`) and others'
  projects shared with you (with `owner` and your `role`). A shared project is addressed with
  `?owner=<username>` (GET, PUT, and leaving it by posting your own username with role `null`).

- **A project** is its save files relative to the project folder (`ProjectDescription.json`, `Chips/*.json`,
  `Deleted Chips/*.json`): the same format as rooms and zip export. Names compare case-insensitively.
- **Versions.** Each upload sends `base`, the cloud version this device last had. If the cloud has a different
  version, the upload is refused (409) unless `force` is set. The version goes up by one per upload.
- **Links.** Which local projects are synced, their base version and whether they have unsent changes, is kept per
  account in localStorage (`dls-cloud-links:<user id>`). `FileSystem.AddChangeListener` marks a linked project
  changed on every write; it is uploaded 1.5 s after the last change (retried every 15 s while offline).
- **Collaborators** are stored with the owner's project index (`shares`: user id → role); an in-memory index finds
  the projects shared with a user. Editors' uploads go through the same version check as the owner's. A local link
  remembers the cloud project's owner and name, and the user's role (refreshed on every sync: when the owner makes
  someone a viewer, their pending changes are dropped). `CollabState.CloudReadOnly` makes a viewer's open project
  read-only in `ChipInteractionController.HasControl`.
- **Collaboration identity.** The collab `hello` message carries the token. When it is valid, the server uses a uid
  derived from the account instead of the browser key, and moves the browser key's rooms (ownership, roles, bans)
  to it (`RoomManager.ClaimRooms`).

Tests: `tests/accounts.test.ts` (flags, accounts, throttling, projects, versions, quotas, collaborators, API, collab
identity) and `scripts/e2e-cloud.cjs` (two browsers on one account: upload, open on the other, update, conflict; a
second account as editor then viewer, leaving; and an app-only server).

## Known limitations
- Whole projects are uploaded on every change (simple and robust; fine for typical project sizes).
- Renaming a synced project stops syncing it; upload it again under the new name.
- A viewer can still use menus that save locally (e.g. the chip library); those changes are never uploaded and are
  replaced by the next update.
- Changes reach collaborators on their next sync (panel opened, window focus, or within a minute), not live.
- No password reset (there are no e-mail addresses). A forgotten password means a new account.

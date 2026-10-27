// Central server for the web version (web-only addition): serves the built app (dist/), hosts the live
// collaboration rooms over a WebSocket at /ws, and accounts + cloud projects at /api (docs/accounts.md).
// Rooms and accounts are kept in memory and persisted as JSON files in DATA_DIR.
//
//   bun run build && bun run server        (PORT=8787 DATA_DIR=./data by default)
//   APP_ONLY=1 bun run server              just the app (see server/config.ts for the feature flags)
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, normalize, resolve, sep } from "node:path";
import type { ServerWebSocket } from "bun";
import { type AccountData, AccountManager, type AccountStore, type StoredProject } from "./accounts";
import { HandleApi } from "./api";
import { FeaturesFromEnv } from "./config";
import { type Conn, RoomManager, type RoomStore, type StoredRoom } from "./rooms";

const port = Number(process.env.PORT ?? 8787);
const dataDir = resolve(process.env.DATA_DIR ?? "./data");
const staticDir = resolve(process.env.STATIC_DIR ?? "./dist");
const maxMessageBytes = 80 * 1024 * 1024;
const presenceBufferedBytes = 1024 * 1024;
const maxBufferedBytes = 128 * 1024 * 1024;
const features = FeaturesFromEnv(process.env);

function WriteAtomic(path: string, content: string) {
	writeFileSync(path + ".tmp", content);
	renameSync(path + ".tmp", path);
}

// ---- Persistence: one JSON file per room ----
class FileRoomStore implements RoomStore {
	private readonly dir = join(dataDir, "rooms");

	constructor() {
		mkdirSync(this.dir, { recursive: true });
	}

	loadAll(): StoredRoom[] {
		const rooms: StoredRoom[] = [];
		for (const f of readdirSync(this.dir)) {
			if (!f.endsWith(".json")) continue;
			try {
				rooms.push(JSON.parse(readFileSync(join(this.dir, f), "utf8")));
			} catch (e) {
				console.error("collab: could not load room", f, e);
			}
		}
		return rooms;
	}

	save(room: StoredRoom) {
		WriteAtomic(join(this.dir, room.code + ".json"), JSON.stringify(room));
	}

	remove(code: string) {
		rmSync(join(this.dir, code + ".json"), { force: true });
	}
}

// ---- Persistence: accounts.json (users, sessions, project index) + one JSON file per cloud project ----
class FileAccountStore implements AccountStore {
	private readonly dir = join(dataDir, "accounts");
	private readonly file = join(this.dir, "accounts.json");

	constructor() {
		mkdirSync(join(this.dir, "projects"), { recursive: true });
	}

	load(): AccountData {
		if (!existsSync(this.file)) return { users: [], sessions: {} };
		return JSON.parse(readFileSync(this.file, "utf8"));
	}

	save(data: AccountData) {
		WriteAtomic(this.file, JSON.stringify(data));
	}

	// (file names from a hash: project names may differ only in case, and can hold characters some file systems dislike)
	private ProjectPath(uid: string, key: string) {
		return join(this.dir, "projects", uid, createHash("sha256").update(key).digest("hex").substring(0, 32) + ".json");
	}

	loadProject(uid: string, key: string): StoredProject | null {
		const path = this.ProjectPath(uid, key);
		return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
	}

	saveProject(uid: string, key: string, project: StoredProject) {
		mkdirSync(join(this.dir, "projects", uid), { recursive: true });
		WriteAtomic(this.ProjectPath(uid, key), JSON.stringify(project));
	}

	removeProject(uid: string, key: string) {
		rmSync(this.ProjectPath(uid, key), { force: true });
	}

	removeUser(uid: string) {
		rmSync(join(this.dir, "projects", uid), { recursive: true, force: true });
	}
}

const manager = features.collab ? new RoomManager(new FileRoomStore()) : null;
const accounts = features.accounts ? new AccountManager(new FileAccountStore()) : null;
// (collab identity follows the account when a signed-in client says hello with its token)
if (manager && accounts) manager.AccountOf = (token) => accounts.Authenticate(token)?.id ?? null;
const FlushAll = () => {
	manager?.Flush();
	accounts?.Flush();
};
setInterval(FlushAll, 2000);
setInterval(() => {
	manager?.Sweep();
	accounts?.Sweep();
}, 3600 * 1000);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, () => {
		FlushAll();
		process.exit(0);
	});
}

// ---- Static files ----
async function ServeStatic(pathname: string): Promise<Response> {
	if (!existsSync(staticDir)) return new Response("App not built: run `bun run build` first.", { status: 503 });
	let rel = decodeURIComponent(pathname);
	if (rel.endsWith("/")) rel += "index.html";
	const path = normalize(join(staticDir, rel));
	if (path !== staticDir && !path.startsWith(staticDir + sep)) return new Response("Not found", { status: 404 });
	const file = Bun.file(path);
	if (await file.exists()) {
		const immutable = rel.startsWith("/assets/");
		return new Response(file, { headers: { "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache" } });
	}
	return new Response("Not found", { status: 404 });
}

interface SocketData {
	conn: Conn | null;
}

const server = Bun.serve<SocketData, never>({
	port,
	maxRequestBodySize: 96 * 1024 * 1024,
	fetch(req, srv) {
		const url = new URL(req.url);
		if (url.pathname === "/ws" && manager) {
			if (srv.upgrade(req, { data: { conn: null } })) return undefined;
			return new Response("Expected a WebSocket", { status: 400 });
		}
		if (url.pathname.startsWith("/api/") && accounts) {
			if (req.method === "OPTIONS") return WithCors(new Response(null, { status: 204 }));
			return HandleApi(req, ClientIp(req, srv.requestIP(req)?.address ?? ""), accounts, features).then(WithCors);
		}
		if (url.pathname === "/healthz") return new Response("ok");
		// Which features this server offers (the client hides the others)
		if (url.pathname === "/config.json") return WithCors(Response.json(features, { headers: { "Cache-Control": "no-store" } }));
		return ServeStatic(url.pathname);
	},
	websocket: {
		maxPayloadLength: maxMessageBytes,
		idleTimeout: 120,
		perMessageDeflate: true,
		open(ws: ServerWebSocket<SocketData>) {
			if (!manager) return void ws.close();
			ws.data.conn = manager.Connect((msg) => {
				// Backpressure (a client that stopped reading, e.g. a frozen tab): cursor updates are dropped first; if the
				// backlog keeps growing, the connection is closed and the client resyncs when it reconnects.
				const buffered = ws.getBufferedAmount();
				if (buffered > maxBufferedBytes) return void ws.close(1013, "Too far behind");
				if (msg.t === "presence" && buffered > presenceBufferedBytes) return;
				ws.send(JSON.stringify(msg));
			});
		},
		message(ws: ServerWebSocket<SocketData>, message) {
			const conn = ws.data.conn;
			if (!conn) return;
			let parsed: unknown;
			try {
				parsed = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message));
			} catch {
				return;
			}
			manager?.Handle(conn, parsed);
		},
		close(ws: ServerWebSocket<SocketData>) {
			if (ws.data.conn) manager?.Disconnect(ws.data.conn);
			ws.data.conn = null;
		},
	},
});

// The app may be hosted elsewhere (?collab=wss://this-server/ws): the API uses bearer tokens, not cookies, so any origin
// may call it
function WithCors(res: Response): Response {
	res.headers.set("Access-Control-Allow-Origin", "*");
	res.headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
	res.headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
	res.headers.set("Access-Control-Max-Age", "86400");
	return res;
}

// The client address, for login throttling. Behind a local reverse proxy (Caddy) it comes from X-Forwarded-For.
function ClientIp(req: Request, direct: string): string {
	const loopback = direct === "127.0.0.1" || direct === "::1" || direct === "::ffff:127.0.0.1";
	const forwarded = req.headers.get("x-forwarded-for");
	if (loopback && forwarded) return forwarded.split(",").pop()!.trim();
	return direct;
}

const on = Object.entries(features).filter(([, v]) => v).map(([k]) => k);
console.log(`DLS server on http://localhost:${server.port} (static: ${staticDir}, data: ${dataDir}, features: ${on.join(", ") || "app only"})`);

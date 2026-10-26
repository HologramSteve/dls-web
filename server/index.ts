// Central server for the web version (web-only addition): serves the built app (dist/) and hosts the live
// collaboration rooms over a WebSocket at /ws. Rooms are kept in memory and persisted as JSON files in DATA_DIR.
//
//   bun run build && bun run server        (PORT=8787 DATA_DIR=./data by default)
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, normalize, resolve, sep } from "node:path";
import type { ServerWebSocket } from "bun";
import { type Conn, RoomManager, type RoomStore, type StoredRoom } from "./rooms";

const port = Number(process.env.PORT ?? 8787);
const dataDir = resolve(process.env.DATA_DIR ?? "./data");
const staticDir = resolve(process.env.STATIC_DIR ?? "./dist");
const maxMessageBytes = 80 * 1024 * 1024;
const presenceBufferedBytes = 1024 * 1024;
const maxBufferedBytes = 128 * 1024 * 1024;

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
		const path = join(this.dir, room.code + ".json");
		writeFileSync(path + ".tmp", JSON.stringify(room));
		renameSync(path + ".tmp", path);
	}

	remove(code: string) {
		rmSync(join(this.dir, code + ".json"), { force: true });
	}
}

const manager = new RoomManager(new FileRoomStore());
setInterval(() => manager.Flush(), 2000);
setInterval(() => manager.Sweep(), 3600 * 1000);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, () => {
		manager.Flush();
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
	fetch(req, srv) {
		const url = new URL(req.url);
		if (url.pathname === "/ws") {
			if (srv.upgrade(req, { data: { conn: null } })) return undefined;
			return new Response("Expected a WebSocket", { status: 400 });
		}
		if (url.pathname === "/healthz") return new Response("ok");
		return ServeStatic(url.pathname);
	},
	websocket: {
		maxPayloadLength: maxMessageBytes,
		idleTimeout: 120,
		perMessageDeflate: true,
		open(ws: ServerWebSocket<SocketData>) {
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
			manager.Handle(conn, parsed);
		},
		close(ws: ServerWebSocket<SocketData>) {
			if (ws.data.conn) manager.Disconnect(ws.data.conn);
			ws.data.conn = null;
		},
	},
});

console.log(`DLS server on http://localhost:${server.port} (static: ${staticDir}, data: ${dataDir})`);

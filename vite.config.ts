import { defineConfig } from "vite";

// Relative base so the build works from any static host sub-path (e.g. GitHub Pages).
// Dev: the live collaboration WebSocket (/ws), the accounts API (/api) and /config.json are proxied to the server
// (`bun run dev:server`, port 8787).
export default defineConfig({
	base: "./",
	worker: { format: "es" },
	build: { target: "es2022", sourcemap: true },
	server: {
		proxy: {
			"/ws": { target: "ws://localhost:8787", ws: true },
			"/api": { target: "http://localhost:8787" },
			"/config.json": { target: "http://localhost:8787" },
		},
	},
	test: { include: ["tests/**/*.test.ts"], testTimeout: 60000, benchmark: { include: ["tests/**/*.bench.ts"] } },
} as any);

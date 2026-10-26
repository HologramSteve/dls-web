import { defineConfig } from "vite";

// Relative base so the build works from any static host sub-path (e.g. GitHub Pages).
export default defineConfig({
	base: "./",
	worker: { format: "es" },
	build: { target: "es2022", sourcemap: true },
	test: { include: ["tests/**/*.test.ts"], testTimeout: 60000, benchmark: { include: ["tests/**/*.bench.ts"] } },
} as any);

// Which web-only features are on (web-only addition): live collaboration, and accounts with cloud storage.
// - The server says what it offers in /config.json (server/config.ts; APP_ONLY=1 there turns everything off).
// - A build with VITE_APP_ONLY=1 has them off without asking (for static hosting without the server).
// - Without a config.json (another static host, or the Vite dev server alone) everything stays on, as before.
import type { ServerConfig } from "../cloud/CloudProtocol";

const env = (import.meta as { env?: Record<string, string | undefined> }).env ?? {};

export const Features: ServerConfig = { collab: true, accounts: true, registration: true };

// The server's http(s) base: same origin, or the one named by ?collab= / VITE_COLLAB_URL (an app hosted elsewhere)
export function ServerHttpBase(): string {
	const explicit = new URLSearchParams(location.search).get("collab") ?? env.VITE_COLLAB_URL;
	if (explicit) return explicit.replace(/^ws(s?):/, "http$1:").replace(/\/ws\/?$/, "");
	return location.origin;
}

export async function LoadFeatures(): Promise<void> {
	if (/^(1|true)$/i.test(env.VITE_APP_ONLY ?? "")) {
		Features.collab = Features.accounts = Features.registration = false;
		return;
	}
	try {
		const res = await fetch(ServerHttpBase() + "/config.json", { cache: "no-store" });
		if (!res.ok || !(res.headers.get("content-type") ?? "").includes("json")) return;
		const config = (await res.json()) as Partial<ServerConfig>;
		for (const k of ["collab", "accounts", "registration"] as const) if (typeof config[k] === "boolean") Features[k] = config[k];
	} catch {
		/* no server: keep the defaults */
	}
}

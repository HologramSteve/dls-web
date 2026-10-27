// Which web-only server features are on (web-only addition). Everything is on by default; the app itself (static files)
// is always served. The client reads the result from /config.json and hides what is off.
//
//   APP_ONLY=1            just the app: no collaboration, no accounts / cloud storage (no /ws, no /api)
//   DISABLE_COLLAB=1      no live collaboration
//   DISABLE_ACCOUNTS=1    no accounts / cloud storage
//   REGISTRATION=closed   accounts stay on, but no new accounts can be created
export interface Features {
	collab: boolean;
	accounts: boolean;
	registration: boolean;
}

const truthy = (v: string | undefined) => v != null && /^(1|true|yes|on)$/i.test(v.trim());

export function FeaturesFromEnv(env: Record<string, string | undefined>): Features {
	const appOnly = truthy(env.APP_ONLY);
	const accounts = !appOnly && !truthy(env.DISABLE_ACCOUNTS);
	return {
		collab: !appOnly && !truthy(env.DISABLE_COLLAB),
		accounts,
		registration: accounts && !/^(closed|off|0|false|no)$/i.test((env.REGISTRATION ?? "").trim()),
	};
}

// Accounts + cloud project storage (web-only addition): types and rules shared by the client (src/cloud/) and the server
// (server/accounts.ts, server/api.ts). See docs/accounts.md.

// What the server offers (GET config.json). A static host without the server has no config.json: see Features.ts.
export interface ServerConfig {
	collab: boolean;
	accounts: boolean;
	registration: boolean;
}

export interface CloudUser {
	id: string;
	username: string;
}

export interface CloudProjectInfo {
	name: string;
	version: number; // increases by one on every upload
	updated: number; // ms since epoch
	bytes: number;
}

// A project is stored as its save files, relative to the project folder ("ProjectDescription.json", "Chips/X.json")
export interface CloudProject extends CloudProjectInfo {
	files: Record<string, string>;
}

export const UsernamePattern = /^[A-Za-z0-9_.-]{3,24}$/;
export const MinPasswordLength = 8;
export const MaxPasswordLength = 256;
export const MaxProjectNameLength = 64;

// Same rules as SaveUtils.ValidFileName (project names are folder names)
const ForbiddenProjectNameChars = /[<>:"/\\|?*.]/;
const ReservedNames = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;

export function IsValidCloudProjectName(name: unknown): name is string {
	return (
		typeof name === "string" &&
		name.trim().length > 0 &&
		name.length <= MaxProjectNameLength &&
		!ForbiddenProjectNameChars.test(name) &&
		!Array.from(name).some((ch) => ch.charCodeAt(0) < 32) &&
		!ReservedNames.test(name.trim())
	);
}

// Names compare case-insensitively, as everywhere in DLS
export const CloudNameKey = (name: string) => name.toUpperCase();

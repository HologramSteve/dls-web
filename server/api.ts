// HTTP API for accounts and cloud projects (web-only addition), on top of AccountManager. Uses only the standard
// Request/Response, so tests call it directly. Auth: "Authorization: Bearer <token>" (no cookies, so no CSRF).
//
//   POST   /api/auth/register  {username, password}       -> {token, user}
//   POST   /api/auth/login     {username, password}       -> {token, user}
//   POST   /api/auth/logout                               -> {}
//   GET    /api/auth/me                                   -> {user}
//   POST   /api/auth/password  {old, new}                 -> {}   (signs out other sessions)
//   POST   /api/auth/delete    {password}                 -> {}   (deletes the account and its projects)
//   GET    /api/projects                                  -> {projects, shared}: own projects, and others' shared with you
//   GET    /api/projects/<name>                           -> CloudProject
//   PUT    /api/projects/<name> {files, base?, force?}    -> CloudProjectInfo   (409 if base is outdated)
//   DELETE /api/projects/<name>                           -> {}
//   POST   /api/projects/<name>/collaborators {username, role}  -> CloudProjectInfo   (role "editor" | "viewer" | null)
// A project shared with you is addressed with ?owner=<owner's username> (GET, PUT, and leaving it via collaborators).
import type { Features } from "./config";
import { type AccountManager, PublicUser, type Result } from "./accounts";

const MaxAuthBodyBytes = 16 * 1024;
const MaxProjectBodyBytes = 80 * 1024 * 1024;

const Json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
const ErrorResponse = (status: number, error: string) => Json({ error }, status);
const FromResult = <T>(r: Result<T>, map: (v: T) => unknown = (v) => v ?? {}) => (r.ok ? Json(map(r.value)) : ErrorResponse(r.status, r.error));

async function ReadJson(req: Request, maxBytes: number): Promise<Record<string, unknown> | Response> {
	const length = Number(req.headers.get("content-length") ?? 0);
	if (length > maxBytes) return ErrorResponse(413, "Request too large.");
	let text: string;
	try {
		text = await req.text();
	} catch {
		return ErrorResponse(400, "Could not read the request.");
	}
	if (text.length > maxBytes) return ErrorResponse(413, "Request too large.");
	try {
		const v = JSON.parse(text);
		if (v != null && typeof v === "object" && !Array.isArray(v)) return v;
	} catch {
		/* fall through */
	}
	return ErrorResponse(400, "Invalid JSON.");
}

export async function HandleApi(req: Request, ip: string, accounts: AccountManager, features: Features): Promise<Response> {
	const url = new URL(req.url);
	const path = url.pathname.replace(/^\/api\//, "");
	const method = req.method;
	const token = /^Bearer (.+)$/.exec(req.headers.get("authorization") ?? "")?.[1] ?? null;

	if (path === "auth/register" && method === "POST") {
		if (!features.registration) return ErrorResponse(403, "New accounts are disabled on this server.");
		const body = await ReadJson(req, MaxAuthBodyBytes);
		if (body instanceof Response) return body;
		return FromResult(await accounts.Register(body.username, body.password, ip));
	}
	if (path === "auth/login" && method === "POST") {
		const body = await ReadJson(req, MaxAuthBodyBytes);
		if (body instanceof Response) return body;
		return FromResult(await accounts.Login(body.username, body.password, ip));
	}

	// Everything else needs a session
	const user = accounts.Authenticate(token);
	if (!user || !token) return ErrorResponse(401, "Not signed in.");

	if (path === "auth/logout" && method === "POST") {
		accounts.Logout(token);
		return Json({});
	}
	if (path === "auth/me" && method === "GET") return Json({ user: PublicUser(user) });
	if (path === "auth/password" && method === "POST") {
		const body = await ReadJson(req, MaxAuthBodyBytes);
		if (body instanceof Response) return body;
		return FromResult(await accounts.ChangePassword(user, body.old, body.new, token));
	}
	if (path === "auth/delete" && method === "POST") {
		const body = await ReadJson(req, MaxAuthBodyBytes);
		if (body instanceof Response) return body;
		return FromResult(await accounts.DeleteAccount(user, body.password));
	}

	if (path === "projects" && method === "GET") return Json(accounts.ListProjects(user));
	const ownerName = url.searchParams.get("owner");
	const m = /^projects\/([^/]+)(\/collaborators)?$/.exec(path);
	if (m) {
		let name: string;
		try {
			name = decodeURIComponent(m[1]);
		} catch {
			return ErrorResponse(400, "Invalid project name.");
		}
		if (m[2]) {
			if (method !== "POST") return ErrorResponse(405, "Method not allowed.");
			const body = await ReadJson(req, MaxAuthBodyBytes);
			if (body instanceof Response) return body;
			return FromResult(accounts.SetCollaborator(user, name, ownerName, body.username, body.role ?? null));
		}
		if (method === "GET") return FromResult(accounts.GetProject(user, name, ownerName));
		if (method === "DELETE") {
			if (ownerName && ownerName.toLowerCase() !== user.username.toLowerCase()) return ErrorResponse(403, "Only the owner can delete a project.");
			return FromResult(accounts.DeleteProject(user, name));
		}
		if (method === "PUT") {
			const body = await ReadJson(req, MaxProjectBodyBytes);
			if (body instanceof Response) return body;
			return FromResult(accounts.PutProject(user, name, body.files, body.base ?? 0, body.force === true, ownerName));
		}
		return ErrorResponse(405, "Method not allowed.");
	}
	return ErrorResponse(404, "Not found.");
}

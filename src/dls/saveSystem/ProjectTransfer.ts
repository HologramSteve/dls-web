// Web-only: import/export projects to/from the user's disk (replaces the original's direct access to the save folder).
// A project is exported as a .zip containing "<ProjectName>/ProjectDescription.json" and "<ProjectName>/Chips/*.json",
// i.e. the same layout as the original's Projects folder, so projects can be moved between the web and desktop versions.
// Import accepts such zip files (including a zip of a whole Projects folder), or a folder picked with the directory picker.
import { FileSystem, PathCombine } from "./FileSystem";
import { SavePaths, SaveUtils } from "./SavePaths";

// ---- Minimal zip writer (stored, no compression) and reader (stored + deflate) ----

const crcTable = (() => {
	const t = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		t[n] = c >>> 0;
	}
	return t;
})();

function crc32(data: Uint8Array): number {
	let c = 0xffffffff;
	for (let i = 0; i < data.length; i++) c = crcTable[(c ^ data[i]) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

export function CreateZip(entries: { path: string; data: Uint8Array }[]): Uint8Array {
	const enc = new TextEncoder();
	const chunks: Uint8Array[] = [];
	const central: Uint8Array[] = [];
	let offset = 0;

	for (const e of entries) {
		const name = enc.encode(e.path);
		const crc = crc32(e.data);
		const local = new DataView(new ArrayBuffer(30));
		local.setUint32(0, 0x04034b50, true);
		local.setUint16(4, 20, true);
		local.setUint16(6, 0x0800, true); // UTF-8 names
		local.setUint16(8, 0, true); // stored
		local.setUint32(14, crc, true);
		local.setUint32(18, e.data.length, true);
		local.setUint32(22, e.data.length, true);
		local.setUint16(26, name.length, true);
		chunks.push(new Uint8Array(local.buffer), name, e.data);

		const cd = new DataView(new ArrayBuffer(46));
		cd.setUint32(0, 0x02014b50, true);
		cd.setUint16(4, 20, true);
		cd.setUint16(6, 20, true);
		cd.setUint16(8, 0x0800, true);
		cd.setUint32(16, crc, true);
		cd.setUint32(20, e.data.length, true);
		cd.setUint32(24, e.data.length, true);
		cd.setUint16(28, name.length, true);
		cd.setUint32(42, offset, true);
		central.push(new Uint8Array(cd.buffer), name);

		offset += 30 + name.length + e.data.length;
	}

	const cdSize = central.reduce((s, c) => s + c.length, 0);
	const end = new DataView(new ArrayBuffer(22));
	end.setUint32(0, 0x06054b50, true);
	end.setUint16(8, entries.length, true);
	end.setUint16(10, entries.length, true);
	end.setUint32(12, cdSize, true);
	end.setUint32(16, offset, true);

	const all = [...chunks, ...central, new Uint8Array(end.buffer)];
	const out = new Uint8Array(all.reduce((s, c) => s + c.length, 0));
	let p = 0;
	for (const c of all) {
		out.set(c, p);
		p += c.length;
	}
	return out;
}

async function Inflate(data: Uint8Array): Promise<Uint8Array> {
	const ds = new DecompressionStream("deflate-raw");
	const stream = new Blob([data as BlobPart]).stream().pipeThrough(ds);
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function ReadZip(buf: Uint8Array): Promise<{ path: string; data: Uint8Array }[]> {
	const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
	// Find end of central directory record
	let eocd = -1;
	for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
		if (view.getUint32(i, true) === 0x06054b50) {
			eocd = i;
			break;
		}
	}
	if (eocd < 0) throw new Error("Not a zip file");

	const count = view.getUint16(eocd + 10, true);
	let p = view.getUint32(eocd + 16, true);
	const dec = new TextDecoder();
	const res: { path: string; data: Uint8Array }[] = [];

	for (let n = 0; n < count; n++) {
		if (view.getUint32(p, true) !== 0x02014b50) throw new Error("Corrupt zip");
		const method = view.getUint16(p + 10, true);
		const compSize = view.getUint32(p + 20, true);
		const nameLen = view.getUint16(p + 28, true);
		const extraLen = view.getUint16(p + 30, true);
		const commentLen = view.getUint16(p + 32, true);
		const localOffset = view.getUint32(p + 42, true);
		const path = dec.decode(buf.subarray(p + 46, p + 46 + nameLen));
		p += 46 + nameLen + extraLen + commentLen;

		if (path.endsWith("/")) continue; // directory entry
		const lNameLen = view.getUint16(localOffset + 26, true);
		const lExtraLen = view.getUint16(localOffset + 28, true);
		const start = localOffset + 30 + lNameLen + lExtraLen;
		const raw = buf.subarray(start, start + compSize);

		if (method === 0) res.push({ path, data: raw.slice() });
		else if (method === 8) res.push({ path, data: await Inflate(raw) });
		else console.warn("Unsupported zip compression method for " + path);
	}
	return res;
}

// ---- Export ----

export function CreateProjectZip(projectName: string): Uint8Array {
	const enc = new TextEncoder();
	const root = SavePaths.GetProjectPath(projectName);
	const entries = FileSystem.GetFilesRecursive(root).map((path) => ({
		path: projectName + path.substring(root.length),
		data: enc.encode(FileSystem.ReadAllText(path)),
	}));
	return CreateZip(entries);
}

export function DownloadProject(projectName: string) {
	const zip = CreateProjectZip(projectName);
	const url = URL.createObjectURL(new Blob([zip as BlobPart], { type: "application/zip" }));
	const a = document.createElement("a");
	a.href = url;
	a.download = projectName + ".zip";
	document.body.appendChild(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// ---- Import ----

// Import files (paths relative to some root). Every "ProjectDescription.json" found marks a project folder.
// Returns names of the imported projects (renamed with a numeric suffix if a project of that name already exists).
export function ImportProjectFiles(files: { path: string; text: string }[]): string[] {
	const norm = files.map((f) => ({ path: f.path.replace(/\\/g, "/").replace(/^\/+/, ""), text: f.text }));
	const imported: string[] = [];

	for (const desc of norm) {
		const parts = desc.path.split("/");
		if (parts[parts.length - 1] !== SavePaths.ProjectFileName) continue;
		if (parts.some((p) => p === "__MACOSX")) continue;

		const folder = parts.slice(0, -1).join("/");
		let projectName = parts.length >= 2 ? parts[parts.length - 2] : "Imported Project";
		if (!SaveUtils.ValidFileName(projectName)) projectName = "Imported Project";

		// Ensure unique name
		let uniqueName = projectName;
		for (let i = 1; FileSystem.FileExists(SavePaths.GetProjectDescriptionPath(uniqueName)); i++) uniqueName = `${projectName} ${i}`;

		const prefix = folder ? folder + "/" : "";
		for (const f of norm) {
			if (!f.path.startsWith(prefix)) continue;
			const rel = f.path.substring(prefix.length);
			// Only take the project description and chip files (skip nested projects / deleted chips backups are kept too)
			if (rel === SavePaths.ProjectFileName || rel.startsWith("Chips/") || rel.startsWith("Deleted Chips/")) {
				FileSystem.WriteAllText(PathCombine(SavePaths.GetProjectPath(uniqueName), rel), f.text);
			}
		}

		// Enforce name in description = folder name (as the loader does)
		imported.push(uniqueName);
	}

	return imported;
}

// Show a file picker (zip files, or a folder) and import the chosen projects
export function PickAndImportProjects(fromFolder: boolean): Promise<string[]> {
	return new Promise((resolve) => {
		const input = document.createElement("input");
		input.type = "file";
		if (fromFolder) input.webkitdirectory = true;
		else {
			input.accept = ".zip,application/zip";
			input.multiple = true;
		}
		input.style.display = "none";
		input.onchange = async () => {
			const fileList = Array.from(input.files ?? []);
			input.remove();
			const files: { path: string; text: string }[] = [];
			const dec = new TextDecoder();
			try {
				for (const file of fileList) {
					if (file.name.toLowerCase().endsWith(".zip")) {
						for (const e of await ReadZip(new Uint8Array(await file.arrayBuffer()))) {
							if (e.path.toLowerCase().endsWith(".json")) files.push({ path: e.path, text: dec.decode(e.data) });
						}
					} else if (file.name.toLowerCase().endsWith(".json")) {
						files.push({ path: file.webkitRelativePath || file.name, text: await file.text() });
					}
				}
				resolve(ImportProjectFiles(files));
			} catch (e) {
				console.error("Import failed", e);
				resolve([]);
			}
		};
		document.body.appendChild(input);
		input.click();
	});
}

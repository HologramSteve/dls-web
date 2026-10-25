// Virtual file system standing in for System.IO in the original.
// All files live in memory (so the ported save/load code can stay synchronous, like the original),
// and every change is written through to IndexedDB in the background so that it persists between sessions.
// Paths use '/' separators and are relative to the app data root (e.g. "Projects/MyProject/Chips/AND.json").

const DB_NAME = "dls-web";
const STORE = "files";

class VirtualFileSystem {
	private files = new Map<string, string>();
	private db: IDBDatabase | null = null;
	private pending = new Map<string, string | null>(); // path -> content (null = delete)
	private flushScheduled = false;
	private flushPromise: Promise<void> = Promise.resolve();

	// Load all files from IndexedDB into memory. Safe to call when IndexedDB is unavailable (memory only).
	async init(): Promise<void> {
		if (typeof indexedDB === "undefined") return;
		try {
			this.db = await new Promise<IDBDatabase>((resolve, reject) => {
				const req = indexedDB.open(DB_NAME, 1);
				req.onupgradeneeded = () => req.result.createObjectStore(STORE);
				req.onsuccess = () => resolve(req.result);
				req.onerror = () => reject(req.error);
			});
			await new Promise<void>((resolve, reject) => {
				const tx = this.db!.transaction(STORE, "readonly");
				const store = tx.objectStore(STORE);
				const req = store.openCursor();
				req.onsuccess = () => {
					const cursor = req.result;
					if (cursor) {
						this.files.set(String(cursor.key), String(cursor.value));
						cursor.continue();
					} else resolve();
				};
				req.onerror = () => reject(req.error);
			});
		} catch (e) {
			console.warn("IndexedDB unavailable; saves will not persist.", e);
			this.db = null;
		}
	}

	private schedule(path: string, content: string | null) {
		this.pending.set(path, content);
		if (!this.flushScheduled) {
			this.flushScheduled = true;
			queueMicrotask(() => {
				this.flushScheduled = false;
				this.flushPromise = this.flushPromise.then(() => this.flush());
			});
		}
	}

	private async flush(): Promise<void> {
		if (!this.db || this.pending.size === 0) {
			this.pending.clear();
			return;
		}
		const batch = this.pending;
		this.pending = new Map();
		await new Promise<void>((resolve) => {
			const tx = this.db!.transaction(STORE, "readwrite");
			const store = tx.objectStore(STORE);
			for (const [path, content] of batch) {
				if (content === null) store.delete(path);
				else store.put(content, path);
			}
			tx.oncomplete = () => resolve();
			tx.onerror = () => {
				console.error("Failed to persist files", tx.error);
				resolve();
			};
		});
	}

	// Wait until all pending writes have been persisted
	async sync(): Promise<void> {
		await Promise.resolve();
		await this.flushPromise;
	}

	static normalize(path: string): string {
		return path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/|\/$/g, "");
	}

	FileExists(path: string): boolean {
		return this.files.has(VirtualFileSystem.normalize(path));
	}

	DirectoryExists(path: string): boolean {
		const prefix = VirtualFileSystem.normalize(path) + "/";
		for (const k of this.files.keys()) if (k.startsWith(prefix)) return true;
		return false;
	}

	ReadAllText(path: string): string {
		const p = VirtualFileSystem.normalize(path);
		const v = this.files.get(p);
		if (v === undefined) throw new Error("File not found: " + p);
		return v;
	}

	WriteAllText(path: string, content: string) {
		const p = VirtualFileSystem.normalize(path);
		this.files.set(p, content);
		this.schedule(p, content);
	}

	DeleteFile(path: string) {
		const p = VirtualFileSystem.normalize(path);
		if (this.files.delete(p)) this.schedule(p, null);
	}

	MoveFile(from: string, to: string) {
		const content = this.ReadAllText(from);
		this.DeleteFile(from);
		this.WriteAllText(to, content);
	}

	// Paths of all files inside the directory (recursively)
	GetFilesRecursive(dir: string): string[] {
		const prefix = VirtualFileSystem.normalize(dir) + "/";
		const res: string[] = [];
		for (const k of this.files.keys()) if (k.startsWith(prefix)) res.push(k);
		return res;
	}

	// Names of the immediate sub-directories of a directory
	EnumerateDirectories(dir: string): string[] {
		const prefix = VirtualFileSystem.normalize(dir) + "/";
		const set = new Set<string>();
		for (const k of this.files.keys()) {
			if (!k.startsWith(prefix)) continue;
			const rest = k.substring(prefix.length);
			const slash = rest.indexOf("/");
			if (slash > 0) set.add(rest.substring(0, slash));
		}
		return Array.from(set);
	}

	MoveDirectory(from: string, to: string) {
		const f = VirtualFileSystem.normalize(from);
		const t = VirtualFileSystem.normalize(to);
		for (const path of this.GetFilesRecursive(f)) {
			this.MoveFile(path, t + path.substring(f.length));
		}
	}

	CopyDirectory(from: string, to: string) {
		const f = VirtualFileSystem.normalize(from);
		const t = VirtualFileSystem.normalize(to);
		for (const path of this.GetFilesRecursive(f)) {
			this.WriteAllText(t + path.substring(f.length), this.ReadAllText(path));
		}
	}

	DeleteDirectory(dir: string) {
		for (const path of this.GetFilesRecursive(dir)) this.DeleteFile(path);
	}
}

export const FileSystem = new VirtualFileSystem();

export function PathCombine(...parts: string[]): string {
	return VirtualFileSystem.normalize(parts.filter((p) => p.length > 0).join("/"));
}

export function GetFileName(path: string): string {
	const p = VirtualFileSystem.normalize(path);
	return p.substring(p.lastIndexOf("/") + 1);
}

export function GetDirectoryName(path: string): string {
	const p = VirtualFileSystem.normalize(path);
	const i = p.lastIndexOf("/");
	return i < 0 ? "" : p.substring(0, i);
}

// Port of DLS.SaveSystem.SavePaths and SaveUtils (paths are inside the virtual file system)
import { FileSystem, PathCombine } from "./FileSystem";

export const SavePaths = {
	ProjectFileName: "ProjectDescription.json",
	AllData: "",
	ProjectsPath: "Projects",
	DeletedProjectsPath: "Deleted Projects",
	AppSettingsPath: "AppSettings.json",

	GetProjectPath: (projectName: string) => PathCombine("Projects", projectName),
	GetDeletedProjectPath: (projectName: string) => PathCombine("Deleted Projects", projectName),
	GetChipsPath: (projectName: string) => PathCombine("Projects", projectName, "Chips"),
	GetDeletedChipsPath: (projectName: string) => PathCombine("Projects", projectName, "Deleted Chips"),
	GetProjectDescriptionPath: (projectName: string) => PathCombine("Projects", projectName, "ProjectDescription.json"),
};

// Don't allow these characters in project/chip names as they are illegal (or behave strangely) in some operating systems.
const ForbiddenChars = new Set(["<", ">", ":", '"', "/", "\\", "|", "?", "*", "."]);

// Reserved file names on windows
const ReservedNames = ["CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9"];

export const SaveUtils = {
	// Test if file name is valid on all operating systems
	ValidFileName(name: string): boolean {
		if (!name) return false;
		return !SaveUtils.NameContainsForbiddenChar(name) && !IsReservedFileName(name);
	},

	NameContainsForbiddenChar(name: string): boolean {
		if (!name) return false;
		for (const c of name) if (ForbiddenChars.has(c)) return true;
		return false;
	},

	// Ensure file name is unique by appending a number to it if necessary
	EnsureUniqueFileName(originalPath: string): string {
		const slash = originalPath.lastIndexOf("/");
		const dir = slash >= 0 ? originalPath.substring(0, slash + 1) : "";
		const fileName = originalPath.substring(slash + 1);
		const dot = fileName.lastIndexOf(".");
		const nameNoExt = dot > 0 ? fileName.substring(0, dot) : fileName;
		const ext = dot > 0 ? fileName.substring(dot) : "";
		let uniquePath = originalPath;
		let duplicates = 0;
		while (FileSystem.FileExists(uniquePath)) {
			duplicates++;
			uniquePath = `${dir}${nameNoExt}_${duplicates}${ext}`;
		}
		return uniquePath;
	},

	// Ensure directory name is unique by appending a number the path if necessary
	EnsureUniqueDirectoryName(path: string): string {
		let uniquePath = path;
		let n = 0;
		while (FileSystem.DirectoryExists(uniquePath)) {
			n++;
			uniquePath = path + "_" + n;
		}
		return uniquePath;
	},
};

function IsReservedFileName(name: string): boolean {
	const trimmed = name.trim().toUpperCase();
	return ReservedNames.includes(trimmed);
}

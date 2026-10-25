// Port of DLS.SaveSystem.Saver, Loader and UpgradeHelper
import { AppSettings, ChipDescription, ChipType, NameMatch, NameSet, PinColour, ProjectDescription } from "../description/Types";
import { ChipTypeHelper } from "../description/ChipTypeHelper";
import { FormatDateTime, IsEquivalentJson, ParseDateTime, Serializer } from "../description/Serializer";
import { DefaultAppSettings } from "../description/Types";
import { DLSVersion, DLSVersion_EarliestCompatible, Version } from "../game/Version";
import { CreateAllBuiltinChipDescriptions } from "../game/BuiltinChipCreator";
import { ChipLibrary } from "../game/ChipLibrary";
import { CreateDefaultInstanceData } from "./DescriptionCreator";
import { FileSystem, GetDirectoryName, GetFileName, PathCombine } from "./FileSystem";
import { SavePaths, SaveUtils } from "./SavePaths";

export const Saver = {
	SaveAppSettings(settings: AppSettings) {
		WriteToFile(Serializer.SerializeAppSettings(settings), SavePaths.AppSettingsPath);
	},

	SaveProjectDescription(projectDescription: ProjectDescription) {
		projectDescription.LastSaveTime = FormatDateTime(new Date());
		projectDescription.DLSVersion_LastSaved = DLSVersion.toString();
		projectDescription.DLSVersion_EarliestCompatible = DLSVersion_EarliestCompatible.toString();
		WriteToFile(Serializer.SerializeProjectDescription(projectDescription), SavePaths.GetProjectDescriptionPath(projectDescription.ProjectName));
	},

	RenameProject(nameOld: string, nameNew: string) {
		const desc = Loader.LoadProjectDescription(nameOld);
		desc.ProjectName = nameNew;
		FileSystem.MoveDirectory(SavePaths.GetProjectPath(nameOld), SavePaths.GetProjectPath(nameNew));
		Saver.SaveProjectDescription(desc);
	},

	DuplicateProject(nameOriginal: string, nameDuplicate: string) {
		FileSystem.CopyDirectory(SavePaths.GetProjectPath(nameOriginal), SavePaths.GetProjectPath(nameDuplicate));
		const descNew = Loader.LoadProjectDescription(nameDuplicate);
		descNew.ProjectName = nameDuplicate;
		Saver.SaveProjectDescription(descNew);
	},

	SaveChip(chipDescription: ChipDescription, projectName: string) {
		WriteToFile(Saver.CreateSerializedChipDescription(chipDescription), GetChipFilePath(chipDescription.Name, projectName));
	},

	CloneChipDescription(desc: ChipDescription | null): ChipDescription | null {
		if (desc == null) return null;
		return Serializer.DeserializeChipDescription(Serializer.SerializeChipDescription(desc));
	},

	CreateSerializedChipDescription(chipDescription: ChipDescription): string {
		return Serializer.SerializeChipDescription(chipDescription);
	},

	// Delete chip save file, with option to keep backup in a DeletedChips folder.
	DeleteChip(chipName: string, projectName: string, backupInDeletedFolder = true) {
		const filePath = GetChipFilePath(chipName, projectName);
		if (!FileSystem.FileExists(filePath)) return;
		if (backupInDeletedFolder) {
			const deletedFilePath = SaveUtils.EnsureUniqueFileName(PathCombine(SavePaths.GetDeletedChipsPath(projectName), chipName + ".json"));
			FileSystem.MoveFile(filePath, deletedFilePath);
		} else {
			FileSystem.DeleteFile(filePath);
		}
	},

	DeleteProject(projectName: string, backupInDeletedFolder = true) {
		const projectPath = SavePaths.GetProjectPath(projectName);
		if (backupInDeletedFolder) {
			const deletedPath = SaveUtils.EnsureUniqueDirectoryName(PathCombine(SavePaths.DeletedProjectsPath, projectName));
			FileSystem.MoveDirectory(projectPath, deletedPath);
		} else {
			FileSystem.DeleteDirectory(projectPath);
		}
	},

	HasUnsavedChanges(lastSaved: ChipDescription, current: ChipDescription): boolean {
		const jsonA = Saver.CreateSerializedChipDescription(lastSaved);
		const jsonB = Saver.CreateSerializedChipDescription(current);
		return !IsEquivalentJson(jsonA, jsonB);
	},
};

function WriteToFile(data: string, path: string) {
	FileSystem.WriteAllText(path, data);
}

function GetChipFilePath(chipName: string, projectName: string): string {
	return PathCombine(SavePaths.GetChipsPath(projectName), chipName + ".json");
}

export const Loader = {
	LoadAppSettings(): AppSettings {
		if (FileSystem.FileExists(SavePaths.AppSettingsPath)) {
			return Serializer.DeserializeAppSettings(FileSystem.ReadAllText(SavePaths.AppSettingsPath));
		}
		return DefaultAppSettings();
	},

	ProjectExists(projectName: string): boolean {
		return FileSystem.FileExists(SavePaths.GetProjectDescriptionPath(projectName));
	},

	LoadProjectDescription(projectName: string): ProjectDescription {
		const path = SavePaths.GetProjectDescriptionPath(projectName);
		if (!FileSystem.FileExists(path)) throw new Error("No project description found at " + path);
		const desc = Serializer.DeserializeProjectDescription(FileSystem.ReadAllText(path));
		desc.ProjectName = projectName; // Enforce name = directory name
		return desc;
	},

	// Get list of saved project descriptions (ordered by last save time)
	LoadAllProjectDescriptions(): ProjectDescription[] {
		const list: ProjectDescription[] = [];
		for (const dir of FileSystem.EnumerateDirectories(SavePaths.ProjectsPath)) {
			try {
				list.push(Loader.LoadProjectDescription(GetFileName(dir)));
			} catch {
				// Ignore invalid project directory
			}
		}
		list.sort((a, b) => ParseDateTime(b.LastSaveTime) - ParseDateTime(a.LastSaveTime));
		return list;
	},

	LoadChipLibrary(projectDescription: ProjectDescription): ChipLibrary {
		const chipDirectoryPath = SavePaths.GetChipsPath(projectDescription.ProjectName);
		const loadedChips: ChipDescription[] = [];
		let builtinChips = CreateAllBuiltinChipDescriptions();
		const customChipNames = new NameSet();

		for (const chipName of projectDescription.AllCustomChipNames) {
			const chipPath = PathCombine(chipDirectoryPath, chipName + ".json");
			const chipDesc = Serializer.DeserializeChipDescription(FileSystem.ReadAllText(chipPath));
			loadedChips.push(chipDesc);
			customChipNames.add(chipDesc.Name);
		}

		// If built-in chip name conflicts with a custom chip, the built-in chip must have been added in a newer version.
		// In that case, simply exclude the built-in chip.
		builtinChips = builtinChips.filter((b) => !customChipNames.has(b.Name));

		ApplyVersionChanges(loadedChips);
		return new ChipLibrary(loadedChips, builtinChips);
	},
};

// ---- UpgradeHelper ----
function ApplyVersionChanges(customChips: ChipDescription[]) {
	const defaultVersion = new Version(2, 0, 0);
	const version_2_1_4 = new Version(2, 1, 4);

	for (const chipDesc of customChips) {
		const chipVersion = Version.TryParse(chipDesc.DLSVersion) ?? defaultVersion;
		if (chipVersion.ToInt() <= version_2_1_4.ToInt()) {
			UpdateChipPre_2_1_5(chipDesc);
			chipDesc.DLSVersion = version_2_1_4.toString();
		}
	}
}

function UpdateChipPre_2_1_5(chipDesc: ChipDescription) {
	const ledName = ChipTypeHelper.GetName(ChipType.DisplayLED);
	// ---- Inserted ORANGE as colour option at index 1, so update old indices to correct values ----
	const GetNewPinColour = (colOld: PinColour): PinColour => (colOld > 0 ? colOld + 1 : colOld);

	for (const p of chipDesc.InputPins) p.Colour = GetNewPinColour(p.Colour);

	for (const subChipDesc of chipDesc.SubChips) {
		// Ensure LED type has colour data
		if (NameMatch(subChipDesc.Name, ledName) && (subChipDesc.InternalData == null || subChipDesc.InternalData.length === 0)) {
			subChipDesc.InternalData = CreateDefaultInstanceData(ChipType.DisplayLED);
		}
		if (subChipDesc.OutputPinColourInfo == null) continue;
		for (const info of subChipDesc.OutputPinColourInfo) info.PinColour = GetNewPinColour(info.PinColour);
	}
}

export { GetDirectoryName };

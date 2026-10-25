// Port of DLS.Game.Main
import { type AppSettings, type ProjectDescription } from "../description/Types";
import { FormatDateTime } from "../description/Serializer";
import { PreferencesMenu } from "../graphics/ui/menus/PreferencesMenu";
import { MenuType, UIDrawer } from "../graphics/ui/UIDrawer";
import { WorldDrawer } from "../graphics/WorldDrawer";
import { Loader, Saver } from "../saveSystem/Saver";
import type { AudioState } from "./audio/AudioState";
import { CreateDefaultChipCollections, GetDefaultStarredList } from "./BuiltinChipCreator";
import { CameraController } from "./CameraController";
import { InteractionState } from "./InteractionState";
import { KeyboardShortcuts } from "./KeyboardShortcuts";
import { Project } from "./Project";
import { DLSVersion, DLSVersion_EarliestCompatible, LastUpdatedString } from "./Version";

// Unity FullScreenMode values (kept so AppSettings.json stays compatible)
export enum FullScreenMode {
	ExclusiveFullScreen = 0,
	FullScreenWindow = 1,
	MaximizedWindow = 2,
	Windowed = 3,
}

export const Main = {
	DLSVersion,
	DLSVersion_EarliestCompatible,
	LastUpdatedString,
	ActiveAppSettings: null as unknown as AppSettings,
	ActiveProject: null as unknown as Project,
	audioState: null as unknown as AudioState,

	Init(audioState: AudioState) {
		Main.SaveAndApplyAppSettings(Loader.LoadAppSettings());
		Main.audioState = audioState;
	},

	Update() {
		if (UIDrawer.ActiveMenu !== MenuType.MainMenu) {
			CameraController.Update();
			Main.ActiveProject.Update();

			InteractionState.ClearFrame();
			WorldDrawer.DrawWorld(Main.ActiveProject);
		}

		UIDrawer.Draw();

		HandleGlobalInput();
	},

	SaveAndApplyAppSettings(newSettings: AppSettings) {
		// Save new settings
		Main.ActiveAppSettings = newSettings;
		Saver.SaveAppSettings(newSettings);
		// Apply settings to app (web: only fullscreen vs windowed; resolution and vsync are controlled by the browser)
		ApplyFullscreen(newSettings.fullscreenMode !== FullScreenMode.Windowed);
	},

	LoadMainMenu() {
		UIDrawer.SetActiveMenu(MenuType.MainMenu);
	},

	CreateOrLoadProject(projectName: string, startupChipName = "") {
		if (Loader.ProjectExists(projectName)) Main.ActiveProject = LoadProject(projectName);
		else Main.ActiveProject = CreateProject(projectName);

		Main.ActiveProject.LoadDevChipOrCreateNewIfDoesntExist(startupChipName);
		Main.ActiveProject.StartSimulation();
		Main.ActiveProject.audioState = Main.audioState;
		UIDrawer.SetActiveMenu(MenuType.None);
	},

	// Web: there is no file browser to open; the save data lives in the browser (see project import/export instead)
	OpenSaveDataFolderInFileBrowser() {
		console.log("Save data is stored in the browser (IndexedDB). Use project export to save it to disk.");
	},
};

function CreateProject(projectName: string): Project {
	const initialDescription: ProjectDescription = {
		ProjectName: projectName,
		DLSVersion_LastSaved: DLSVersion.toString(),
		DLSVersion_EarliestCompatible: DLSVersion_EarliestCompatible.toString(),
		CreationTime: FormatDateTime(new Date()),
		LastSaveTime: FormatDateTime(new Date()),
		Prefs_MainPinNamesDisplayMode: PreferencesMenu.DisplayMode_OnHover,
		Prefs_ChipPinNamesDisplayMode: PreferencesMenu.DisplayMode_OnHover,
		Prefs_GridDisplayMode: 0,
		Prefs_Snapping: 0,
		Prefs_StraightWires: 0,
		Prefs_SimTargetStepsPerSecond: 1000,
		Prefs_SimStepsPerClockTick: 250,
		Prefs_SimPaused: false,
		AllCustomChipNames: [],
		StarredList: GetDefaultStarredList(),
		ChipCollections: CreateDefaultChipCollections(),
	};

	Saver.SaveProjectDescription(initialDescription);
	return LoadProject(projectName);
}

function LoadProject(projectName: string): Project {
	const desc = Loader.LoadProjectDescription(projectName);
	return new Project(desc, Loader.LoadChipLibrary(desc));
}

function HandleGlobalInput() {
	if (KeyboardShortcuts.OpenSaveDataFolderShortcutTriggered) Main.OpenSaveDataFolderInFileBrowser();
}

function ApplyFullscreen(fullscreen: boolean) {
	if (typeof document === "undefined") return;
	try {
		if (fullscreen && !document.fullscreenElement) void document.documentElement.requestFullscreen?.().catch(() => {});
		else if (!fullscreen && document.fullscreenElement) void document.exitFullscreen?.().catch(() => {});
	} catch {
		/* not allowed without user gesture */
	}
}

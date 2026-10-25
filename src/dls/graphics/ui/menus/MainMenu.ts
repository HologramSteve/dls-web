// Port of DLS.Graphics.MainMenu
// Web changes: "Quit" is replaced by "Import" (zip files of projects; hold Shift to pick a project folder instead),
// and the open-project screen has an extra "Export" button (downloads the project as a zip in the original folder layout).
import { MakeCol255 } from "../../../../seb/helpers/ColHelper";
import { InputHelper } from "../../../../seb/helpers/InputHelper";
import { Screen } from "../../../../seb/helpers/Platform";
import { Color } from "../../../../seb/types/Color";
import { Vector2, Vector2Int } from "../../../../seb/types/Vector2";
import { Anchor, FontType } from "../../../../seb/vis/Anchor";
import type { DrawID } from "../../../../seb/vis/Draw";
import { UI } from "../../../../seb/vis/ui/UI";
import { CalculateCentre, DefaultSpacing, HorizontalLayout, UIHandle, cloneButtonTheme } from "../../../../seb/vis/ui/UITheme";
import type { AppSettings, ProjectDescription } from "../../../description/Types";
import { KeyboardShortcuts } from "../../../game/KeyboardShortcuts";
import { FullScreenMode, Main } from "../../../game/Main";
import { DLSVersion, LastUpdatedString, Version } from "../../../game/Version";
import { DownloadProject, PickAndImportProjects } from "../../../saveSystem/ProjectTransfer";
import { Loader, Saver } from "../../../saveSystem/Saver";
import { SaveUtils } from "../../../saveSystem/SavePaths";
import { ActiveUITheme, DefaultButtonSpacing, HorizontalButtonSpacing, VerticalButtonSpacing } from "../../DrawSettings";

enum MenuScreen {
	Main,
	LoadProject,
	Settings,
	About,
}

enum PopupKind {
	None,
	DeleteConfirmation,
	NamePopup_RenameProject,
	NamePopup_DuplicateProject,
	NamePopup_NewProject,
}

const MaxProjectNameLength = 20;
const capitalize = true;

let activeMenuScreen = MenuScreen.Main;
let activePopup = PopupKind.None;
let EditedAppSettings: AppSettings;

const ID_ProjectNameInput = UIHandle("MainMenu_ProjectNameInputField");
const ID_DisplayResolutionWheel = UIHandle("MainMenu_DisplayResolutionWheel");
const ID_FullscreenWheel = UIHandle("MainMenu_FullscreenWheel");
const ID_ProjectsScrollView = UIHandle("MainMenu_ProjectsScrollView");

const SettingsWheelFullScreenOptions = ["OFF", "MAXIMIZED", "BORDERLESS", "EXCLUSIVE"];
const FullScreenModes = [FullScreenMode.Windowed, FullScreenMode.MaximizedWindow, FullScreenMode.FullScreenWindow, FullScreenMode.ExclusiveFullScreen];
const SettingsWheelVSyncOptions = ["DISABLED", "ENABLED"];

const FormatButtonString = (s: string) => (capitalize ? s.toUpperCase() : s);

const menuButtonNames = [FormatButtonString("New Project"), FormatButtonString("Open Project"), FormatButtonString("Settings"), FormatButtonString("About"), FormatButtonString("Import")];

const openProjectButtonNames = [FormatButtonString("Back"), FormatButtonString("Delete"), FormatButtonString("Duplicate"), FormatButtonString("Rename"), FormatButtonString("Export"), FormatButtonString("Open")];

const Resolutions = [new Vector2Int(960, 540), new Vector2Int(1280, 720), new Vector2Int(1920, 1080), new Vector2Int(2560, 1440)];

const ResolutionToString = (r: Vector2Int) => `${r.x} x ${r.y}`;
const ResolutionNames = Resolutions.map(ResolutionToString);
const FullScreenResolution = () => new Vector2Int(Math.round(window.screen.width * window.devicePixelRatio), Math.round(window.screen.height * window.devicePixelRatio));
const settingsButtonGroupNames = ["EXIT", "APPLY"];
const settingsButtonGroupStates = new Array<boolean>(settingsButtonGroupNames.length).fill(false);

const openProjectButtonStates = new Array<boolean>(openProjectButtonNames.length).fill(false);

let allProjectDescriptions: ProjectDescription[] = [];
let allProjectNames: string[] = [];
let projectCompatibilities: [boolean, string][] = [];

let selectedProjectIndex = -1;

const authorString = "Created by: Sebastian Lague";
const versionString = `Version: ${DLSVersion} (${LastUpdatedString})`;
const SelectedProjectName = () => allProjectDescriptions[selectedProjectIndex].ProjectName;

export const MainMenu = {
	MaxProjectNameLength,

	Draw() {
		if (KeyboardShortcuts.CancelShortcutTriggered && activePopup === PopupKind.None) BackToMain();

		UI.DrawFullscreenPanel(MakeCol255(47, 47, 53));
		const title = "DIGITAL LOGIC SIM";
		const titleFontSize = 11.5;
		const titleHeight = 24;
		const shaddowOffset = -0.33;
		const shadowCol = MakeCol255(87, 94, 230);

		UI.DrawText(title, FontType.Born2bSporty, titleFontSize, UI.Centre.add(Vector2.up.mul(titleHeight + shaddowOffset)), Anchor.CentreTop, shadowCol);
		UI.DrawText(title, FontType.Born2bSporty, titleFontSize, UI.Centre.add(Vector2.up.mul(titleHeight)), Anchor.CentreTop, Color.white);
		DrawVersionInfo();

		switch (activeMenuScreen) {
			case MenuScreen.Main:
				DrawMainScreen();
				break;
			case MenuScreen.LoadProject:
				DrawLoadProjectScreen();
				break;
			case MenuScreen.Settings:
				DrawSettingsScreen();
				break;
			case MenuScreen.About:
				DrawAboutScreen();
				break;
		}

		switch (activePopup) {
			case PopupKind.DeleteConfirmation:
				DrawDeleteProjectConfirmationPopup();
				break;
			case PopupKind.NamePopup_RenameProject:
			case PopupKind.NamePopup_DuplicateProject:
			case PopupKind.NamePopup_NewProject:
				DrawNamePopup();
				break;
		}
	},

	OnMenuOpened() {
		activeMenuScreen = MenuScreen.Main;
		activePopup = PopupKind.None;
		selectedProjectIndex = -1;
	},
};

function DrawMainScreen() {
	if (activePopup !== PopupKind.None) return;

	const theme = ActiveUITheme;
	const buttonWidth = 15;

	const buttonIndex = UI.VerticalButtonGroup(menuButtonNames, null, theme.MainMenuButtonTheme, UI.Centre.add(Vector2.up.mul(6)), new Vector2(buttonWidth, 0), false, true, 1);

	if (buttonIndex === 0 || KeyboardShortcuts.MainMenu_NewProjectShortcutTriggered) {
		// New project
		RefreshLoadedProjects();
		activePopup = PopupKind.NamePopup_NewProject;
	} else if (buttonIndex === 1 || KeyboardShortcuts.MainMenu_OpenProjectShortcutTriggered) {
		// Load project
		RefreshLoadedProjects();
		selectedProjectIndex = -1;
		activeMenuScreen = MenuScreen.LoadProject;
	} else if (buttonIndex === 2 || KeyboardShortcuts.MainMenu_SettingsShortcutTriggered) {
		// Settings (AppSettings is a struct: copy)
		EditedAppSettings = { ...Main.ActiveAppSettings };
		activeMenuScreen = MenuScreen.Settings;
		OnSettingsMenuOpened();
	} else if (buttonIndex === 3) {
		// About
		activeMenuScreen = MenuScreen.About;
	} else if (buttonIndex === 4) {
		// Import (web: replaces Quit)
		Import(InputHelper.ShiftIsHeld);
	}
}

function Import(fromFolder: boolean) {
	void PickAndImportProjects(fromFolder).then((names) => {
		if (names.length === 0) return;
		RefreshLoadedProjects();
		selectedProjectIndex = Math.max(0, allProjectDescriptions.findIndex((d) => d.ProjectName === names[0]));
		activeMenuScreen = MenuScreen.LoadProject;
		UI.GetScrollbarState(ID_ProjectsScrollView).scrollY = 0;
	});
}

function DrawLoadProjectScreen() {
	const backButtonIndex = 0;
	const deleteButtonIndex = 1;
	const duplicateButtonIndex = 2;
	const renameButtonIndex = 3;
	const exportButtonIndex = 4;
	const openButtonIndex = 5;
	const theme = ActiveUITheme;

	const pos = UI.Centre.add(new Vector2(0, -1));
	const size = new Vector2(68, 32);

	UI.DrawScrollView(ID_ProjectsScrollView, pos, size, Anchor.Centre, theme.ScrollTheme, DrawAllProjectsInScrollView);
	const buttonTheme = ActiveUITheme.MainMenuButtonTheme;

	const projectSelected = selectedProjectIndex >= 0 && selectedProjectIndex < allProjectDescriptions.length;
	const compatibleProject = projectSelected && projectCompatibilities[selectedProjectIndex][0];

	for (let i = 0; i < openProjectButtonStates.length; i++) {
		const buttonEnabled = activePopup === PopupKind.None && (compatibleProject || i === backButtonIndex || ((i === deleteButtonIndex || i === exportButtonIndex) && projectSelected));
		openProjectButtonStates[i] = buttonEnabled;
	}

	const buttonRegionPos = UI.PrevBounds.BottomLeft.add(Vector2.down.mul(VerticalButtonSpacing));
	const buttonIndex = UI.HorizontalButtonGroup(openProjectButtonNames, openProjectButtonStates, buttonTheme, buttonRegionPos, UI.PrevBounds.Width, DefaultSpacing, 0, Anchor.TopLeft);

	if (projectSelected && !compatibleProject) {
		const errorMessagePos = UI.PrevBounds.BottomLeft.add(Vector2.down.mul(DefaultButtonSpacing * 2));
		UI.DrawText(projectCompatibilities[selectedProjectIndex][1], buttonTheme.font, buttonTheme.fontSize, errorMessagePos, Anchor.TopLeft, Color.yellow);
	}

	// ---- Handle button input ----
	if (buttonIndex === backButtonIndex) BackToMain();
	else if (buttonIndex === deleteButtonIndex) activePopup = PopupKind.DeleteConfirmation;
	else if (buttonIndex === duplicateButtonIndex) activePopup = PopupKind.NamePopup_DuplicateProject;
	else if (buttonIndex === renameButtonIndex) activePopup = PopupKind.NamePopup_RenameProject;
	else if (buttonIndex === exportButtonIndex) DownloadProject(SelectedProjectName());
	else if (buttonIndex === openButtonIndex) Main.CreateOrLoadProject(SelectedProjectName(), "");
}

const ProjectNameValidator = (inputString: string) => inputString.length <= 20 && !SaveUtils.NameContainsForbiddenChar(inputString);

function DrawAllProjectsInScrollView(topLeft: Vector2, width: number, _isLayoutPass: boolean) {
	const spacing = 0;
	const enabled = activePopup === PopupKind.None;

	for (let i = 0; i < allProjectDescriptions.length; i++) {
		const desc = allProjectDescriptions[i];
		const selected = i === selectedProjectIndex;
		let buttonTheme = selected ? ActiveUITheme.ProjectSelectionButtonSelected : ActiveUITheme.ProjectSelectionButton;
		if (!projectCompatibilities[i][0]) {
			buttonTheme = cloneButtonTheme(buttonTheme);
			buttonTheme.textCols.normal = buttonTheme.textCols.normal.withAlpha(0.5);
		}

		if (UI.Button(desc.ProjectName, buttonTheme, topLeft, new Vector2(width, 0), enabled, false, true, Anchor.TopLeft)) selectedProjectIndex = i;

		topLeft = UI.PrevBounds.BottomLeft.add(Vector2.down.mul(spacing));
	}
}

function RefreshLoadedProjects() {
	allProjectDescriptions = Loader.LoadAllProjectDescriptions();
	allProjectNames = allProjectDescriptions.map((d) => d.ProjectName);
	projectCompatibilities = allProjectDescriptions.map(CanOpenProject);
}

function CanOpenProject(projectDescription: ProjectDescription): [boolean, string] {
	try {
		const earliestCompatible = Version.Parse(projectDescription.DLSVersion_EarliestCompatible);
		const currentVersion = DLSVersion;

		// In case project was made with a newer version of the sim, check if this version is able to open it
		const canOpen = currentVersion.ToInt() >= earliestCompatible.ToInt();
		const failureReason = canOpen ? "" : `This project requires version ${earliestCompatible} or later.`;
		return [canOpen, failureReason];
	} catch {
		console.log("Incompatible project: " + projectDescription.ProjectName);
		return [false, "Unrecognized project format"];
	}
}

function BackToMain() {
	UI.GetInputFieldState(ID_ProjectNameInput).ClearText();
	activeMenuScreen = MenuScreen.Main;
	activePopup = PopupKind.None;
}

function CurrentFullScreenMode(): FullScreenMode {
	return typeof document !== "undefined" && document.fullscreenElement ? FullScreenMode.FullScreenWindow : FullScreenMode.Windowed;
}

function OnSettingsMenuOpened() {
	// Automatically select whichever resolution option is closest to current window size
	const resolutionWheelState = UI.GetWheelSelectorState(ID_DisplayResolutionWheel);
	let closestMatchError = Number.MAX_SAFE_INTEGER;
	for (let i = 0; i < Resolutions.length; i++) {
		const matchError = Math.min(Math.abs(Screen.width - Resolutions[i].x), Math.abs(Screen.height - Resolutions[i].y));
		if (matchError < closestMatchError) {
			closestMatchError = matchError;
			resolutionWheelState.index = i;
		}
	}

	// Automatically set curr fullscreen mode
	const fullscreenWheelState = UI.GetWheelSelectorState(ID_FullscreenWheel);
	const mode = CurrentFullScreenMode();
	for (let i = 0; i < FullScreenModes.length; i++) {
		if (mode === FullScreenModes[i]) {
			fullscreenWheelState.index = i;
			break;
		}
	}
}

function DrawSettingsScreen() {
	const theme = ActiveUITheme;

	const regionWidth = 30;
	const labelOriginLeft = UI.Centre.x - regionWidth / 2;
	const elementOriginRight = UI.Centre.x + regionWidth / 2;
	const wheelSize = new Vector2(16, 2.5);
	let pos = new Vector2(labelOriginLeft, UI.Centre.y + 4);

	const scope = UI.BeginBoundsScope(true);
	try {
		const backgroundPanelID: DrawID = UI.ReservePanel();

		// -- Resolution --
		const resEnabled = EditedAppSettings.fullscreenMode === FullScreenMode.Windowed;
		UI.DrawText("Resolution", theme.FontRegular, theme.FontSizeRegular, pos, Anchor.CentreLeft, Color.white);
		const fullScreenResName = ResolutionToString(FullScreenResolution());
		const resNames = resEnabled ? ResolutionNames : Resolutions.map(() => fullScreenResName);
		const resIndex = UI.WheelSelector(ID_DisplayResolutionWheel, resNames, new Vector2(elementOriginRight, pos.y), wheelSize, theme.OptionsWheel, Anchor.CentreRight, true, resEnabled);
		EditedAppSettings.ResolutionX = Resolutions[resIndex].x;
		EditedAppSettings.ResolutionY = Resolutions[resIndex].y;

		// -- Full screen --
		pos = pos.add(Vector2.down.mul(4));
		UI.DrawText("Fullscreen", theme.FontRegular, theme.FontSizeRegular, pos, Anchor.CentreLeft, Color.white);
		const fullScreenSettingIndex = UI.WheelSelector(ID_FullscreenWheel, SettingsWheelFullScreenOptions, new Vector2(elementOriginRight, pos.y), wheelSize, theme.OptionsWheel, Anchor.CentreRight);
		EditedAppSettings.fullscreenMode = FullScreenModes[fullScreenSettingIndex];
		pos = pos.add(Vector2.down.mul(4));

		// -- Vsync --
		UI.DrawText("VSync", theme.FontRegular, theme.FontSizeRegular, pos, Anchor.CentreLeft, Color.white);
		const vsyncSetting = UI.WheelSelectorIndexed(EditedAppSettings.VSyncEnabled ? 1 : 0, SettingsWheelVSyncOptions, new Vector2(elementOriginRight, pos.y), wheelSize, theme.OptionsWheel, Anchor.CentreRight);
		EditedAppSettings.VSyncEnabled = vsyncSetting === 1;

		// Background panel
		UI.ModifyPanel(backgroundPanelID, UI.GetCurrentBoundsScope().Centre, UI.GetCurrentBoundsScope().Size.add(Vector2.one.mul(3)), MakeCol255(37, 37, 43));
	} finally {
		scope.Dispose();
	}

	const buttonPos = UI.PrevBounds.BottomLeft.add(Vector2.down.mul(VerticalButtonSpacing));
	settingsButtonGroupStates[0] = true;
	settingsButtonGroupStates[1] = true;

	const buttonIndex = UI.HorizontalButtonGroup(settingsButtonGroupNames, settingsButtonGroupStates, theme.MainMenuButtonTheme, buttonPos, UI.PrevBounds.Width, DefaultSpacing, 0, Anchor.TopLeft);

	if (buttonIndex === 0) BackToMain();
	else if (buttonIndex === 1) Main.SaveAndApplyAppSettings({ ...EditedAppSettings });
}

function DrawNamePopup() {
	const theme = ActiveUITheme;

	UI.StartNewLayer();
	UI.DrawFullscreenPanel(theme.MenuBackgroundOverlayCol);

	const scope = UI.BeginBoundsScope(true);
	try {
		const panelID = UI.ReservePanel();

		const inputTheme = theme.ChipNameInputField;

		const charSize = UI.CalculateTextSize("M", inputTheme.fontSize, inputTheme.font);
		const padding = new Vector2(2, 2);
		const inputFieldSize = new Vector2(charSize.x * MaxProjectNameLength, charSize.y).add(padding.mul(2));

		const state = UI.InputField(ID_ProjectNameInput, inputTheme, UI.Centre, inputFieldSize, "", Anchor.Centre, padding.x, ProjectNameValidator, true);

		const projectName = state.text;
		const validProjectName = projectName.trim().length > 0 && SaveUtils.ValidFileName(projectName);
		let projectNameAlreadyExists = false;
		for (const existingProjectName of allProjectNames) {
			projectNameAlreadyExists ||= projectName.toLocaleUpperCase() === existingProjectName.toLocaleUpperCase();
		}

		const canCreateProject = validProjectName && !projectNameAlreadyExists;

		const buttonsRegionSize = new Vector2(inputFieldSize.x, 5);
		const buttonsRegionCentre = CalculateCentre(UI.PrevBounds.BottomLeft, buttonsRegionSize, Anchor.TopLeft);
		const [cancelSize, cancelCentre] = HorizontalLayout(2, 0, buttonsRegionCentre, buttonsRegionSize);
		const [confirmSize, confirmCentre] = HorizontalLayout(2, 1, buttonsRegionCentre, buttonsRegionSize);

		const cancelButton = UI.Button("CANCEL", theme.MainMenuButtonTheme, cancelCentre, new Vector2(cancelSize.x, 0), true, false, true);
		const confirmButton = UI.Button("CONFIRM", theme.MainMenuButtonTheme, confirmCentre, new Vector2(confirmSize.x, 0), canCreateProject, false, true);

		if (cancelButton || KeyboardShortcuts.CancelShortcutTriggered) {
			state.ClearText();
			activePopup = PopupKind.None;
		}

		if (confirmButton || KeyboardShortcuts.ConfirmShortcutTriggered) {
			state.ClearText();
			const kind = activePopup;
			activePopup = PopupKind.None;
			OnNamePopupConfirmed(kind, projectName);
		}

		UI.ModifyPanel(panelID, UI.GetCurrentBoundsScope().Centre, UI.GetCurrentBoundsScope().Size.add(Vector2.one.mul(2)), MakeCol255(37, 37, 43));
	} finally {
		scope.Dispose();
	}
}

function OnNamePopupConfirmed(kind: PopupKind, name: string) {
	if (kind === PopupKind.NamePopup_RenameProject || kind === PopupKind.NamePopup_DuplicateProject) {
		if (kind === PopupKind.NamePopup_RenameProject) Saver.RenameProject(SelectedProjectName(), name);
		if (kind === PopupKind.NamePopup_DuplicateProject) Saver.DuplicateProject(SelectedProjectName(), name);

		RefreshLoadedProjects();
		selectedProjectIndex = 0; // the modified project will now be at top of list
		UI.GetScrollbarState(ID_ProjectsScrollView).scrollY = 0; // scroll to top so selection is visible
	} else if (kind === PopupKind.NamePopup_NewProject) {
		Main.CreateOrLoadProject(name);
	}
}

function DrawDeleteProjectConfirmationPopup() {
	const theme = ActiveUITheme;

	UI.StartNewLayer();
	UI.DrawFullscreenPanel(theme.MenuBackgroundOverlayCol);

	const scope = UI.BeginBoundsScope(true);
	try {
		const panelID = UI.ReservePanel();
		UI.DrawText("Are you sure you want to delete this project?", theme.FontRegular, theme.FontSizeRegular, UI.Centre, Anchor.Centre, Color.yellow);

		const buttonRegionTopLeft = UI.PrevBounds.BottomLeft.add(Vector2.down.mul(VerticalButtonSpacing));
		const buttonRegionWidth = UI.PrevBounds.Width;
		const buttonIndex = UI.HorizontalButtonGroup(["CANCEL", "DELETE"], null, theme.MainMenuButtonTheme, buttonRegionTopLeft, buttonRegionWidth, HorizontalButtonSpacing, 0, Anchor.TopLeft);
		UI.ModifyPanel(panelID, UI.GetCurrentBoundsScope().Centre, UI.GetCurrentBoundsScope().Size.add(Vector2.one.mul(2)), MakeCol255(37, 37, 43));

		if (buttonIndex === 0) {
			// Cancel
			activePopup = PopupKind.None;
		} else if (buttonIndex === 1) {
			// Delete
			Saver.DeleteProject(SelectedProjectName());
			selectedProjectIndex = -1;
			RefreshLoadedProjects();
			activePopup = PopupKind.None;
		}
	} finally {
		scope.Dispose();
	}
}

function DrawAboutScreen() {
	const theme = ActiveUITheme.MainMenuButtonTheme;

	UI.DrawText("Todo: write something helpful here...", theme.font, theme.fontSize, UI.Centre, Anchor.Centre, Color.white);
	if (UI.Button("Back", theme, UI.CentreBottom.add(Vector2.up.mul(22)), Vector2.zero, true, true, true)) BackToMain();
}

function DrawVersionInfo() {
	const theme = ActiveUITheme;
	UI.DrawPanel(UI.BottomLeft, new Vector2(UI.Width, 4), MakeCol255(37, 37, 43), Anchor.BottomLeft);

	const pad = 1;
	const col = new Color(1, 1, 1, 0.5);

	const versionPos = UI.PrevBounds.CentreLeft.add(Vector2.right.mul(pad));
	const datePos = UI.PrevBounds.CentreRight.add(Vector2.left.mul(pad));
	UI.DrawText(authorString, theme.FontRegular, theme.FontSizeRegular, versionPos, Anchor.TextCentreLeft, col);
	UI.DrawText(versionString, theme.FontRegular, theme.FontSizeRegular, datePos, Anchor.TextCentreRight, col);
}

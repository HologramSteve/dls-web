// Port of DLS.Graphics.UIDrawer
import { UI } from "../../../seb/vis/ui/UI";
import { InteractionState } from "../../game/InteractionState";
import { Project } from "../../game/Project";
import { CustomizationSceneDrawer } from "../CustomizationSceneDrawer";
import { BottomBarUI } from "./menus/BottomBarUI";
import { ChipCustomizationMenu } from "./menus/ChipCustomizationMenu";
import { ChipLabelMenu } from "./menus/ChipLabelMenu";
import { ChipLibraryMenu } from "./menus/ChipLibraryMenu";
import { ChipSaveMenu } from "./menus/ChipSaveMenu";
import { ContextMenu } from "./menus/ContextMenu";
import { MainMenu } from "./menus/MainMenu";
import { PinEditMenu } from "./menus/PinEditMenu";
import { PreferencesMenu } from "./menus/PreferencesMenu";
import { PulseEditMenu } from "./menus/PulseEditMenu";
import { RebindKeyChipMenu } from "./menus/RebindKeyChipMenu";
import { RomEditMenu } from "./menus/RomEditMenu";
import { SearchPopup } from "./menus/SearchPopup";
import { SimPausedUI } from "./menus/SimPausedUI";
import { UnsavedChangesPopup } from "./menus/UnsavedChangesPopup";
import { ViewedChipsBar } from "./menus/ViewedChipsBar";

export enum MenuType {
	None,
	ChipSave,
	ChipLibrary,
	BottomBarMenuPopup,
	ChipCustomization,
	Preferences,
	PinRename,
	MainMenu,
	RebindKeyChip,
	RomEdit,
	PulseEdit,
	UnsavedChanges,
	Search,
	ChipLabelPopup,
}

let activeMenuOld = MenuType.None;
let activeMenu = MenuType.None;

export const UIDrawer = {
	get ActiveMenu(): MenuType {
		return activeMenu;
	},

	Draw() {
		NotifyIfActiveMenuChanged();

		const scope = UI.CreateFixedAspectUIScope(16, 9, true);
		try {
			if (activeMenu === MenuType.MainMenu) DrawAppMenus();
			else DrawProjectMenus(Project.ActiveProject);
		} finally {
			scope.Dispose();
		}

		InteractionState.MouseIsOverUI = UI.IsMouseOverUIThisFrame;
	},

	InInputBlockingMenu(): boolean {
		return !(activeMenu === MenuType.None || activeMenu === MenuType.BottomBarMenuPopup || activeMenu === MenuType.ChipCustomization);
	},

	ToggleBottomPopupMenu() {
		UIDrawer.SetActiveMenu(activeMenu === MenuType.None ? MenuType.BottomBarMenuPopup : MenuType.None);
	},

	SetActiveMenu(type: MenuType) {
		activeMenu = type;
	},

	Reset() {
		UIDrawer.SetActiveMenu(MenuType.None);
		activeMenuOld = MenuType.None;
		ContextMenu.Reset();
		UI.ResetAllStates();
		BottomBarUI.Reset();
		ChipSaveMenu.Reset();
		RomEditMenu.Reset();
		ChipLibraryMenu.Reset();
		SearchPopup.Reset();
	},
};

function DrawAppMenus() {
	MainMenu.Draw();
}

function DrawProjectMenus(project: Project) {
	const menuToDraw = activeMenu; // cache state in case it changes while drawing/updating the menus

	if (menuToDraw !== MenuType.ChipCustomization) BottomBarUI.DrawUI(project);

	if (menuToDraw === MenuType.ChipSave) ChipSaveMenu.DrawMenu();
	else if (menuToDraw === MenuType.ChipLibrary) ChipLibraryMenu.DrawMenu();
	else if (menuToDraw === MenuType.ChipCustomization) ChipCustomizationMenu.DrawMenu();
	else if (menuToDraw === MenuType.Preferences) PreferencesMenu.DrawMenu(project);
	else if (menuToDraw === MenuType.PinRename) PinEditMenu.DrawMenu();
	else if (menuToDraw === MenuType.RebindKeyChip) RebindKeyChipMenu.DrawMenu();
	else if (menuToDraw === MenuType.RomEdit) RomEditMenu.DrawMenu();
	else if (menuToDraw === MenuType.UnsavedChanges) UnsavedChangesPopup.DrawMenu();
	else if (menuToDraw === MenuType.Search) SearchPopup.DrawMenu();
	else if (menuToDraw === MenuType.ChipLabelPopup) ChipLabelMenu.DrawMenu();
	else if (menuToDraw === MenuType.PulseEdit) PulseEditMenu.DrawMenu();
	else {
		const showSimPausedBanner = project.simPaused;
		if (showSimPausedBanner) SimPausedUI.DrawPausedBanner();
		if (project.chipViewStack.length > 1) ViewedChipsBar.DrawViewedChipsBanner(project, showSimPausedBanner);
	}

	ContextMenu.Update();
}

function NotifyIfActiveMenuChanged() {
	// UI Changed -- notify opened
	if (activeMenu !== activeMenuOld) {
		if (activeMenuOld === MenuType.ChipCustomization) CustomizationSceneDrawer.OnCustomizationMenuClosed();

		if (activeMenu === MenuType.ChipSave) ChipSaveMenu.OnMenuOpened();
		else if (activeMenu === MenuType.ChipLibrary) ChipLibraryMenu.OnMenuOpened();
		else if (activeMenu === MenuType.ChipCustomization) ChipCustomizationMenu.OnMenuOpened();
		else if (activeMenu === MenuType.PinRename) PinEditMenu.OnMenuOpened();
		else if (activeMenu === MenuType.Preferences) PreferencesMenu.OnMenuOpened();
		else if (activeMenu === MenuType.MainMenu) MainMenu.OnMenuOpened();
		else if (activeMenu === MenuType.RebindKeyChip) RebindKeyChipMenu.OnMenuOpened();
		else if (activeMenu === MenuType.RomEdit) RomEditMenu.OnMenuOpened();
		else if (activeMenu === MenuType.Search) SearchPopup.OnMenuOpened();
		else if (activeMenu === MenuType.ChipLabelPopup) ChipLabelMenu.OnMenuOpened();
		else if (activeMenu === MenuType.PulseEdit) PulseEditMenu.OnMenuOpened();

		if (UIDrawer.InInputBlockingMenu() && Project.ActiveProject != null && Project.ActiveProject.controller != null) {
			Project.ActiveProject.controller.CancelEverything();
		}

		activeMenuOld = activeMenu;
	}
}

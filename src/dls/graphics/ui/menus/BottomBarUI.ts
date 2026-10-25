// Port of DLS.Graphics.BottomBarUI
import { InputHelper, MouseButton } from "../../../../seb/helpers/InputHelper";
import { Maths } from "../../../../seb/helpers/Maths";
import { Time } from "../../../../seb/helpers/Platform";
import { Bounds2D } from "../../../../seb/types/Bounds2D";
import { Color } from "../../../../seb/types/Color";
import { Vector2 } from "../../../../seb/types/Vector2";
import { Anchor } from "../../../../seb/vis/Anchor";
import { Draw } from "../../../../seb/vis/Draw";
import { UI } from "../../../../seb/vis/ui/UI";
import { type ChipCollection, GetStarredDisplayStringForBottomBar, NameMatch } from "../../../description/Types";
import { KeyboardShortcuts } from "../../../game/KeyboardShortcuts";
import { Project } from "../../../game/Project";
import { ActiveUITheme } from "../../DrawSettings";
import { MenuType, UIDrawer } from "../UIDrawer";
import { ContextMenu } from "./ContextMenu";
import { UnsavedChangesPopup } from "./UnsavedChangesPopup";

const barHeight = 3;
const padY = 0.3;
const buttonSpacing = 0.25;
const buttonHeight = barHeight - padY * 2;

const shortcutTextCol = "<color=#666666ff>";

// Web: Ctrl+N / Ctrl+Q are reserved by most browsers, so the menu buttons are the reliable way to trigger these
const menuButtonNames = [
	`NEW CHIP     ${shortcutTextCol}Ctrl+N`,
	`SAVE CHIP    ${shortcutTextCol}Ctrl+S`,
	`FIND CHIP    ${shortcutTextCol}Ctrl+F`,
	`LIBRARY      ${shortcutTextCol}Ctrl+L`,
	`PREFS        ${shortcutTextCol}Ctrl+P`,
	`QUIT         ${shortcutTextCol}Ctrl+Q`,
];

const NewChipButtonIndex = 0;
const SaveChipButtonIndex = 1;
const FindChipButtonIndex = 2;
const LibraryButtonIndex = 3;
const OptionsButtonIndex = 4;
const QuitButtonIndex = 5;

// ---- State ----
let scrollX = 0;
let chipBarTotalWidthLastFrame = 0;
let isDraggingChipBar = false;
let mouseDragPrev = 0;
let closeActiveCollectionMultiModeExit = false;

let toggleMenuFrame = 0;
let collectionInteractFrame = 0;
let activeCollection: ChipCollection | null = null;
let collectionPopupBottomLeft = Vector2.zero;
let barBounds_ScreenSpace = Bounds2D.zero;

const MenuButtonsAndShortcutsEnabled = () => Project.ActiveProject.CanEditViewedChip;

export const BottomBarUI = {
	barHeight,

	DrawUI(project: Project) {
		DrawBottomBar(project);

		if (UIDrawer.ActiveMenu === MenuType.BottomBarMenuPopup) DrawPopupMenu();

		if (UIDrawer.ActiveMenu === MenuType.BottomBarMenuPopup || UIDrawer.ActiveMenu === MenuType.None) HandleKeyboardShortcuts();
	},

	Reset() {
		scrollX = 0;
		chipBarTotalWidthLastFrame = 0;
		isDraggingChipBar = false;
		activeCollection = null;
	},
};

function DrawPopupMenu() {
	const theme = ActiveUITheme.MenuPopupButtonTheme;
	const menuWidth = Draw.CalculateTextBoundsSize(menuButtonNames[0], theme.fontSize, theme.font).x + 1;
	let pos = new Vector2(buttonSpacing, barHeight + buttonSpacing);
	const size = new Vector2(menuWidth, buttonHeight);
	const panelID = UI.ReservePanel();

	const ButtonPressed = (i: number) => {
		if (i === NewChipButtonIndex) CreateNewChip();
		else if (i === SaveChipButtonIndex) OpenSaveMenu();
		else if (i === FindChipButtonIndex) OpenSearchMenu();
		else if (i === LibraryButtonIndex) OpenLibraryMenu();
		else if (i === OptionsButtonIndex) OpenPreferencesMenu();
		else if (i === QuitButtonIndex) ExitToMainMenu();
	};

	const scope = UI.BeginBoundsScope(true);
	try {
		for (let i = menuButtonNames.length - 1; i >= 0; i--) {
			const buttonEnabled = MenuButtonsAndShortcutsEnabled() || i === QuitButtonIndex || i === OptionsButtonIndex;
			const text = menuButtonNames[i];
			if (UI.Button(text, theme, pos, size, buttonEnabled, false, false, Anchor.BottomLeft)) ButtonPressed(i);

			pos = UI.PrevBounds.TopLeft;
		}

		const uiBounds = UI.GetCurrentBoundsScope();
		UI.ModifyPanel(panelID, uiBounds.Centre, uiBounds.Size.add(Vector2.one.mul(buttonSpacing * 2)), Color.white);
	} finally {
		scope.Dispose();
	}

	// Close if clicked nothing or pressed esc
	if (UIDrawer.ActiveMenu === MenuType.BottomBarMenuPopup) {
		if (InputHelper.IsAnyMouseButtonDownThisFrame_IgnoreConsumed() && Time.frameCount !== toggleMenuFrame) UIDrawer.SetActiveMenu(MenuType.None);
		if (KeyboardShortcuts.CancelShortcutTriggered) UIDrawer.SetActiveMenu(MenuType.None);
	}
}

function DrawBottomBar(project: Project) {
	const bounds_UISpace = new Bounds2D(Vector2.zero, new Vector2(UI.Width, barHeight));
	barBounds_ScreenSpace = UI.UIToScreenSpaceBounds(bounds_UISpace);

	const inOtherMenu = !(UIDrawer.ActiveMenu === MenuType.BottomBarMenuPopup || UIDrawer.ActiveMenu === MenuType.None);
	const theme = ActiveUITheme;
	// If mouse is over context menu, then ignore inputs (don't want to actually disable the buttons because the grey-out effect is distracting here)
	// Also if middle mouse is held, as may be dragging the bar so don't want to select buttons
	const ignoreInputs = ContextMenu.HasFocus() || InputHelper.IsMouseHeld(MouseButton.Middle);
	const isRightClick = InputHelper.IsMouseDownThisFrame(MouseButton.Right);
	if (closeActiveCollectionMultiModeExit && !KeyboardShortcuts.MultiModeHeld) {
		closeActiveCollectionMultiModeExit = false;
		activeCollection = null;
	}

	UI.DrawPanelBounds(bounds_UISpace, theme.StarredBarCol);

	// Menu toggle button
	const menuButtonPos = new Vector2(buttonSpacing, padY);
	const menuButtonSize = new Vector2(1.5, barHeight - padY * 2);
	const menuButtonEnabled = !inOtherMenu;

	if (UI.Button("MENU", theme.MenuButtonTheme, menuButtonPos, menuButtonSize, menuButtonEnabled, true, false, Anchor.BottomLeft, false, 0, ignoreInputs)) {
		UIDrawer.ToggleBottomPopupMenu();
		toggleMenuFrame = Time.frameCount;
	}

	// Chips
	const buttonTheme = theme.ChipButton;

	const mask = UI.CreateMaskScopeMinMax(new Vector2(UI.PrevBounds.Right + buttonSpacing, 0), new Vector2(UI.Width, barHeight));
	try {
		const chipButtonsEnabled = !inOtherMenu && project.CanEditViewedChip;

		// -- Chip bar drag/scroll input --
		if (MouseIsOverBar()) {
			const scrollSensitivity = 2;
			scrollX += Maths.AbsoluteMax(InputHelper.MouseScrollDelta.x, InputHelper.MouseScrollDelta.y) * -scrollSensitivity;
			if (InputHelper.IsMouseDownThisFrame(MouseButton.Middle)) {
				isDraggingChipBar = true;
				mouseDragPrev = UI.ScreenToUISpace(InputHelper.MousePos).x;
			}
		}

		if (isDraggingChipBar) {
			const mouseDragNew = UI.ScreenToUISpace(InputHelper.MousePos).x;
			scrollX += mouseDragNew - mouseDragPrev;
			mouseDragPrev = mouseDragNew;
			if (InputHelper.IsMouseUpThisFrame(MouseButton.Middle)) isDraggingChipBar = false;
		}

		// -- Draw --
		const chipButtonsRegionStartX = UI.PrevBounds.Right + buttonSpacing;
		const chipButtonRegionWidth = UI.Width - chipButtonsRegionStartX;

		scrollX = Math.min(Math.max(scrollX, Math.min(0, chipButtonRegionWidth - chipBarTotalWidthLastFrame)), 0);
		let buttonPosX = chipButtonsRegionStartX + scrollX;
		const firstButtonLeft = buttonPosX;

		const starredList = project.description.StarredList;
		for (let i = 0; i < starredList.length; i++) {
			const starred = starredList[i];
			const isToggledOpenCollection = activeCollection != null && NameMatch(starred.Name, activeCollection.Name);
			const buttonName = GetStarredDisplayStringForBottomBar(starred, isToggledOpenCollection);

			let textOffsetX = 0;

			const buttonPos = new Vector2(buttonPosX, padY);
			let buttonSize = new Vector2(0.5, buttonHeight);

			if (starred.IsCollection) {
				textOffsetX = -0.2;
				buttonSize = new Vector2(buttonSize.x - 0.5, buttonSize.y);
			}

			const canAdd = starred.IsCollection || project.ViewedChip.CanAddSubchip(buttonName);

			if (UI.Button(buttonName, buttonTheme, buttonPos, buttonSize, chipButtonsEnabled && canAdd, true, false, Anchor.BottomLeft, false, textOffsetX, ignoreInputs)) {
				if (starred.IsCollection) {
					const newActiveCollection = GetChipCollectionByName(starred.Name);
					// Take first item from collection without opening
					if (newActiveCollection.Chips.length > 0 && KeyboardShortcuts.TakeFirstFromCollectionModifierHeld) {
						project.controller.StartPlacingByName(newActiveCollection.Chips[0]);
						activeCollection = null;
					}
					// Open collection in popup
					else {
						collectionPopupBottomLeft = new Vector2(UI.PrevBounds.Left, barHeight);
						activeCollection = newActiveCollection === activeCollection ? null : newActiveCollection;
						collectionInteractFrame = Time.frameCount;
						closeActiveCollectionMultiModeExit = false;
					}
				} else {
					project.controller.StartPlacing(project.chipLibrary.GetChipDescription(starred.Name));
					activeCollection = null;
				}
			} else if (isRightClick && UI.MouseInsideBounds(UI.PrevBounds)) {
				ContextMenu.OpenBottomBarContextMenu(starred.Name, starred.IsCollection, false);
			}

			buttonPosX += UI.PrevBounds.Width + buttonSpacing;
		}

		// Record total width of all buttons to be used as scroll bounds for the next frame
		chipBarTotalWidthLastFrame = UI.PrevBounds.Right - firstButtonLeft + buttonSpacing;
	} finally {
		mask.Dispose();
	}

	DrawCollectionsPopup();
}

function DrawCollectionsPopup() {
	if (activeCollection == null || activeCollection.Chips.length <= 0) return;

	const theme = ActiveUITheme;
	const project = Project.ActiveProject;

	let firstButtonIndex = activeCollection.Chips.length - 1;
	let pressedIndex = -1;
	let layoutOrigin = collectionPopupBottomLeft;
	const expandLeft = layoutOrigin.x > UI.HalfWidth;
	let isFirstPartial = true;
	const openedContextMenu = { value: false };

	while (firstButtonIndex >= 0) {
		let collectionBounds = Bounds2D.zero;
		let numButtonsToDraw = 0;

		// Layout pass: calculate draw bounds (stop before going past top of screen)
		const scope = UI.BeginBoundsScope(false);
		try {
			let buttonLayoutPos = layoutOrigin;

			for (let i = firstButtonIndex; i >= 0; i--) {
				const chipName = activeCollection.Chips[i];
				UI.Button(chipName, ActiveUITheme.ChipButton, buttonLayoutPos, new Vector2(0, buttonHeight), false, true, false, Anchor.BottomLeft, false, 0);
				buttonLayoutPos = UI.PrevBounds.TopLeft.add(Vector2.up.mul(buttonSpacing));

				// Stop if approaching top of screen (we'll draw the rest of the collection starting on a new line)
				if (buttonLayoutPos.y > UI.Height - 0.1) break;

				collectionBounds = UI.GetCurrentBoundsScope();
				numButtonsToDraw++;
			}
		} finally {
			scope.Dispose();
		}

		if (expandLeft && !isFirstPartial) {
			collectionBounds = Bounds2D.Translate(collectionBounds, Vector2.left.mul(collectionBounds.Width));
		}

		// Draw the collections (or as much as fit vertically), as well as a background panel
		let panelBounds = Bounds2D.Grow(collectionBounds, buttonSpacing * 2);
		panelBounds = new Bounds2D(new Vector2(panelBounds.Min.x, barHeight), panelBounds.Max);
		UI.DrawPanelBounds(panelBounds, theme.StarredBarCol);
		const buttonIndex = DrawCollectionsPopupPartial(collectionBounds.BottomLeft, collectionBounds.Width, firstButtonIndex, numButtonsToDraw, openedContextMenu);
		if (buttonIndex !== -1) pressedIndex = buttonIndex;

		// Prepare for next part of the collection (if not all did fit on the screen)
		firstButtonIndex -= numButtonsToDraw;
		layoutOrigin = expandLeft ? panelBounds.BottomLeft : panelBounds.BottomRight;
		isFirstPartial = false;
		if (numButtonsToDraw === 0) break; // (guard against infinite loop if nothing fits)
	}

	if (!openedContextMenu.value) {
		if (pressedIndex !== -1) {
			project.controller.StartPlacing(project.chipLibrary.GetChipDescription(activeCollection.Chips[pressedIndex]));
			if (KeyboardShortcuts.MultiModeHeld) closeActiveCollectionMultiModeExit = true;
			else activeCollection = null;
		} else if (KeyboardShortcuts.CancelShortcutTriggered || (InputHelper.IsAnyMouseButtonDownThisFrame_IgnoreConsumed() && Time.frameCount !== collectionInteractFrame) || UIDrawer.ActiveMenu !== MenuType.None) {
			activeCollection = null;
		}
	}
}

function DrawCollectionsPopupPartial(bottomLeftCurr: Vector2, maxWidth: number, startIndex: number, count: number, openedContextMenu: { value: boolean }): number {
	let pressedIndex = -1;
	const endIndex = startIndex - count + 1;
	const theme = ActiveUITheme.ChipButton;
	const viewedChip = Project.ActiveProject.ViewedChip;
	const ignoreInputs = ContextMenu.HasFocus();

	// Draw pop-up buttons
	for (let i = startIndex; i >= endIndex; i--) {
		const offsetX = 0.55;
		const chipName = activeCollection!.Chips[i];
		const enabled = viewedChip.CanAddSubchip(chipName);
		if (UI.Button(chipName, theme, bottomLeftCurr, new Vector2(maxWidth, buttonHeight), enabled, false, false, Anchor.BottomLeft, true, offsetX, ignoreInputs)) {
			pressedIndex = i;
		} else if (InputHelper.IsMouseDownThisFrame(MouseButton.Right) && UI.MouseInsideBounds(UI.PrevBounds)) {
			ContextMenu.OpenBottomBarContextMenu(chipName, false, true);
			openedContextMenu.value = true;
		}

		bottomLeftCurr = UI.PrevBounds.TopLeft.add(Vector2.up.mul(buttonSpacing));
	}

	return pressedIndex;
}

function GetChipCollectionByName(name: string): ChipCollection {
	for (const c of Project.ActiveProject.description.ChipCollections) {
		if (NameMatch(c.Name, name)) return c;
	}
	throw new Error("Failed to find collection with name: " + name);
}

const MouseIsOverBar = () => InputHelper.MouseInBounds_ScreenSpace(barBounds_ScreenSpace);

function ExitToMainMenu() {
	const ExitIfTrue = (exit: boolean) => {
		if (exit) {
			Project.ActiveProject.NotifyExit();
			UIDrawer.SetActiveMenu(MenuType.MainMenu);
		}
	};

	if (Project.ActiveProject.ActiveChipHasUnsavedChanges()) UnsavedChangesPopup.OpenPopup(ExitIfTrue);
	else ExitIfTrue(true);
}

const OpenSaveMenu = () => UIDrawer.SetActiveMenu(MenuType.ChipSave);
const OpenSearchMenu = () => UIDrawer.SetActiveMenu(MenuType.Search);
const OpenLibraryMenu = () => UIDrawer.SetActiveMenu(MenuType.ChipLibrary);
const OpenPreferencesMenu = () => UIDrawer.SetActiveMenu(MenuType.Preferences);

function CreateNewChip() {
	const ConfirmNewChip = (confirm: boolean) => {
		if (confirm) Project.ActiveProject.CreateBlankDevChip();
	};

	if (Project.ActiveProject.ActiveChipHasUnsavedChanges()) UnsavedChangesPopup.OpenPopup(ConfirmNewChip);
	else ConfirmNewChip(true);
}

function HandleKeyboardShortcuts() {
	if (MenuButtonsAndShortcutsEnabled()) {
		if (KeyboardShortcuts.CreateNewChipShortcutTriggered) CreateNewChip();
		if (KeyboardShortcuts.SaveShortcutTriggered) OpenSaveMenu();
		if (KeyboardShortcuts.LibraryShortcutTriggered) OpenLibraryMenu();
	}

	if (KeyboardShortcuts.PreferencesShortcutTriggered) OpenPreferencesMenu();
	if (KeyboardShortcuts.QuitToMainMenuShortcutTriggered) ExitToMainMenu();
}

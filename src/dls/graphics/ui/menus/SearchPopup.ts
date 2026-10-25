// Port of DLS.Graphics.SearchPopup
import { InputHelper } from "../../../../seb/helpers/InputHelper";
import { Time } from "../../../../seb/helpers/Platform";
import { Bounds2D } from "../../../../seb/types/Bounds2D";
import { Vector2 } from "../../../../seb/types/Vector2";
import { Anchor } from "../../../../seb/vis/Anchor";
import { UI } from "../../../../seb/vis/ui/UI";
import { DefaultSpacing, UIHandle } from "../../../../seb/vis/ui/UITheme";
import { IsStarred } from "../../../description/Types";
import { KeyboardShortcuts } from "../../../game/KeyboardShortcuts";
import { Project } from "../../../game/Project";
import { ActiveUITheme, ButtonHeight, DefaultButtonSpacing } from "../../DrawSettings";
import { MenuHelper } from "../MenuHelper";
import { MenuType, UIDrawer } from "../UIDrawer";
import { ChipSaveMenu } from "./ChipSaveMenu";
import { UnsavedChangesPopup } from "./UnsavedChangesPopup";

const ID_SearchInput = UIHandle("SearchPopup_SearchInput");
const ID_Scrollbar = UIHandle("SearchPopup_Scrollbar");

let allChipNames: string[] = [];
let filteredChipNames: string[] = [];
let menuOpenedFrame = 0;
let isDraggingScrollbar = false;

const recentChipNames: string[] = [];

// String comparison with StringComparison.OrdinalIgnoreCase
const Upper = (s: string) => s.toUpperCase();
// List<string>.Sort() default (culture-aware) comparison
const CultureCompare = (a: string, b: string) => a.localeCompare(b, "en");

export const SearchPopup = {
	DrawMenu() {
		MenuHelper.DrawBackgroundOverlay();
		const panelID = UI.ReservePanel();

		const scope = UI.BeginBoundsScope(true);
		try {
			const inputTheme = MenuHelper.Theme.ChipNameInputField;
			let [inputFieldSize, inputFieldTextPad] = ChipSaveMenu.GetTextInputSize();
			inputFieldSize = new Vector2(inputFieldSize.x + 6, inputFieldSize.y);

			const height = UI.Height * 0.93;
			const width = inputFieldSize.x;
			let topLeft = new Vector2(UI.Centre.x - width / 2, height);

			// Draw search bar
			UI.InputField(ID_SearchInput, inputTheme, topLeft, inputFieldSize, "", Anchor.TopLeft, inputFieldTextPad, ValidateSearchInput, true);
			topLeft = UI.PrevBounds.BottomLeft.add(Vector2.down.mul(2));

			// Draw scroll view
			const scrollState = UI.DrawScrollViewElements(ID_Scrollbar, topLeft, new Vector2(width, UI.Height * 0.7), DefaultSpacing, Anchor.TopLeft, ActiveUITheme.ScrollTheme, DrawChipSearchEntry, filteredChipNames.length);
			isDraggingScrollbar = scrollState.isDragging;

			// Draw background panel
			MenuHelper.DrawReservedMenuPanel(panelID, UI.GetCurrentBoundsScope());
		} finally {
			scope.Dispose();
		}

		// ---- keyboard shortcuts ----
		if (KeyboardShortcuts.ConfirmShortcutTriggered) {
			for (const chipName of filteredChipNames) {
				// Open first openable chip on shift/control+enter
				if ((InputHelper.ShiftIsHeld || InputHelper.CtrlIsHeld) && !Project.ActiveProject.chipLibrary.IsBuiltinChip(chipName)) {
					OpenChip(chipName);
					return;
				}
				// Use first usable chip on enter
				if (Project.ActiveProject.ViewedChip.CanAddSubchip(chipName)) {
					UseChip(chipName);
					return;
				}
			}
		} else if (KeyboardShortcuts.CancelShortcutTriggered || (KeyboardShortcuts.SearchShortcutTriggered && Time.frameCount > menuOpenedFrame)) {
			UIDrawer.SetActiveMenu(MenuType.None);
		}
	},

	get isDraggingScrollbar() {
		return isDraggingScrollbar;
	},

	OnMenuOpened() {
		menuOpenedFrame = Time.frameCount;
		UI.GetInputFieldState(ID_SearchInput).ClearText();

		allChipNames = Project.ActiveProject.chipLibrary.allChips.map((c) => c.Name);
		CreateFilteredChipsList("");
	},

	AddRecentChip(chipName: string) {
		const i = recentChipNames.indexOf(chipName);
		if (i >= 0) recentChipNames.splice(i, 1);
		recentChipNames.push(chipName);
	},

	ClearRecentChips() {
		recentChipNames.length = 0;
	},

	Reset() {},
};

function DrawChipSearchEntry(topLeft: Vector2, width: number, index: number, isLayoutPass: boolean) {
	const entryBounds = Bounds2D.CreateFromTopLeftAndSize(topLeft, new Vector2(width, ButtonHeight));
	const offscreen = entryBounds.Top < 0 || entryBounds.Bottom > UI.Height;

	if (!isLayoutPass && !offscreen) {
		const chipName = filteredChipNames[index];
		const nameWidth = 22;

		// Draw chip name (drawn as non-interactive button)
		const nameTheme = ActiveUITheme.ChipLibraryChipToggleOn;
		UI.Button(chipName, nameTheme, topLeft, new Vector2(nameWidth, ButtonHeight), true, false, false, Anchor.TopLeft, true, 1, true);

		// Draw buttons
		const buttonsTopLeft = topLeft.add(Vector2.right.mul(nameWidth + DefaultButtonSpacing));
		const buttonsWidth = width - (buttonsTopLeft.x - topLeft.x);
		const canPlaceChip = Project.ActiveProject.ViewedChip.CanAddSubchip(chipName);
		const canOpenChip = !Project.ActiveProject.chipLibrary.IsBuiltinChip(chipName);

		const isStarred = IsStarred(Project.ActiveProject.description, chipName, false);
		const buttonIndex = MenuHelper.DrawButtonTriplet("USE", "OPEN", isStarred ? "UN-STAR" : "STAR", buttonsTopLeft, buttonsWidth, false, canPlaceChip, canOpenChip, true);

		if (buttonIndex === 0) UseChip(chipName);
		else if (buttonIndex === 1) OpenChip(chipName);
		else if (buttonIndex === 2) Project.ActiveProject.SetStarred(chipName, !isStarred, false);
	}

	// Override bounds so can skip drawing if offscreen or in layout pass
	UI.OverridePreviousBounds(entryBounds);
}

function CreateFilteredChipsList(searchString: string) {
	// Empty search string, so show all chips
	if (!searchString || !searchString.trim()) {
		// Remove deleted/renamed chip names from recent chips list
		for (let i = recentChipNames.length - 1; i >= 0; i--) {
			if (!Project.ActiveProject.chipLibrary.HasChip(recentChipNames[i])) recentChipNames.splice(i, 1);
		}

		// Get all chip names, with recently opened chips (or those used from the search menu) orderered first; thereafter alphabetically
		const recent = new Set(recentChipNames);
		const sortedList = Array.from(new Set(allChipNames)).filter((n) => !recent.has(n));
		sortedList.sort(CultureCompare);
		sortedList.reverse();
		sortedList.push(...recentChipNames);
		sortedList.reverse();
		filteredChipNames = sortedList;
		return;
	}

	const LenientString = (s: string) => s.replaceAll("-", "").replaceAll(" ", "");
	const ToSortedList = (set: Set<string>) => Array.from(set).sort((a, b) => a.length - b.length);

	const searchUpper = Upper(searchString);
	const searchString_Lenient = Upper(LenientString(searchString));

	// Priority 1) exact match from start of name
	const startsWith = new Set(allChipNames.filter((s) => Upper(s).startsWith(searchUpper)));
	// Priority 2) match from start of name, but more lenient by ignoring things like spaces and dashes
	const startsWith_Lenient = new Set(allChipNames.filter((s) => Upper(LenientString(s)).startsWith(searchString_Lenient) && !startsWith.has(s)));
	// Priority 3) exact match from anywhere in name
	const contains = new Set(allChipNames.filter((s) => Upper(s).includes(searchUpper) && !startsWith.has(s) && !startsWith_Lenient.has(s)));

	filteredChipNames = [...ToSortedList(startsWith), ...ToSortedList(startsWith_Lenient), ...ToSortedList(contains)];
}

function ValidateSearchInput(text: string): boolean {
	if (Time.frameCount === menuOpenedFrame) return false;
	if (!ChipSaveMenu.ValidateChipNameInput(text)) return false;

	CreateFilteredChipsList(text.trim());
	return true;
}

function UseChip(chipName: string) {
	SearchPopup.AddRecentChip(chipName);
	Project.ActiveProject.controller.StartPlacingByName(chipName);
	UIDrawer.SetActiveMenu(MenuType.None);
}

function OpenChip(chipName: string) {
	const project = Project.ActiveProject;

	const OpenChipIfConfirmed = (confirm: boolean) => {
		if (confirm) {
			project.LoadDevChipOrCreateNewIfDoesntExist(chipName);
			UIDrawer.SetActiveMenu(MenuType.None);
		}
	};

	if (project.ActiveChipHasUnsavedChanges()) UnsavedChangesPopup.OpenPopup(OpenChipIfConfirmed);
	else OpenChipIfConfirmed(true);
}

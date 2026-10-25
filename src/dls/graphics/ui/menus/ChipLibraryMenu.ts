// Port of DLS.Graphics.ChipLibraryMenu
import { MakeCol } from "../../../../seb/helpers/ColHelper";
import { InputHelper } from "../../../../seb/helpers/InputHelper";
import { Bounds2D } from "../../../../seb/types/Bounds2D";
import { Color } from "../../../../seb/types/Color";
import { Vector2 } from "../../../../seb/types/Vector2";
import { Anchor } from "../../../../seb/vis/Anchor";
import { UI } from "../../../../seb/vis/ui/UI";
import { type ButtonTheme, DefaultSpacing, type InputFieldTheme, UIHandle } from "../../../../seb/vis/ui/UITheme";
import { ChipCollection, IsStarred, NameMatch, NameSet } from "../../../description/Types";
import { KeyboardShortcuts } from "../../../game/KeyboardShortcuts";
import { Project } from "../../../game/Project";
import { ActiveUITheme, DefaultButtonSpacing, PanelUIPadding } from "../../DrawSettings";
import { MenuHelper } from "../MenuHelper";
import { MenuType, UIDrawer } from "../UIDrawer";
import { UnsavedChangesPopup } from "./UnsavedChangesPopup";

const defaultOtherChipsCollectionName = "OTHER";

const deleteMessageMaxCharsPerLine = 25;
const ID_CollectionsScrollbar = UIHandle("ChipLibrary_CollectionsScrollbar");
const ID_StarredScrollbar = UIHandle("ChipLibrary_StarredScrollbar");
const ID_NameInput = UIHandle("ChipLibrary_NameField");
const buttonNames_moveSingleStep = ["MOVE UP", "MOVE DOWN"];
const buttonNames_jump = ["JUMP UP", "JUMP DOWN"];
const buttonNames_chipAction = ["USE", "OPEN", "DELETE"];
const buttonNames_collectionRenameOrDelete = ["RENAME", "DELETE"];
const buttonName_starUnstar = [["ADD TO STARRED"], ["REMOVE FROM STARRED"]];

const interactableStates_renameDelete = [true, true];
const interactableStates_move = [true, true];
const interactableStates_starredList = [true, true, true];
const interactable_chipActionButtons = [true, true, true];

// State
let selectedCollectionIndex = 0;
let selectedChipInCollectionIndex = 0;
let selectedStarredItemIndex = 0;

let creatingNewCollection = false;
let renamingCollection = false;
let isConfirmingChipDeletion = false;
let isConfirmingCollectionDeletion = false;

let deleteConfirmMessage = "";
let deleteConfirmMessageCol = Color.white;
let isScrolling = false;
let chipToOpenName = "";
let wasOpenedThisFrame = false;

const deleteColWarningHigh = new Color(0.95, 0.35, 0.35);
const deleteColWarningMedium = new Color(1, 0.75, 0.2);

// if chip is moved to another collection, it will be auto-opened. Keep track so it can be auto-closed if chip is then moved out of that collection ('just passing through')
let lastAutoOpenedCollection: ChipCollection | null = null;

const project = () => Project.ActiveProject;
const collections = () => project().description.ChipCollections;

export const ChipLibraryMenu = {
	DrawMenu() {
		MenuHelper.DrawBackgroundOverlay();
		const panelEdgePadding = new Vector2(3.25, 2.6);

		const interPanelSpacing = 1.5;
		const menuOffsetY = 1.13;
		const starredPanelWidthT = 0.35;
		const collectionPanelWidthT = 0.37;
		const selectedPanelWidthT = 1 - (starredPanelWidthT + collectionPanelWidthT);

		const panelWidthSum = UI.Width - interPanelSpacing * 2 - panelEdgePadding.x * 2;
		const panelHeight = UI.Height - panelEdgePadding.y * 2;

		const panelATopLeft = UI.TopLeft.add(new Vector2(panelEdgePadding.x, -panelEdgePadding.y + menuOffsetY));
		const panelSizeA = new Vector2(panelWidthSum * starredPanelWidthT, panelHeight);
		const panelBTopLeft = panelATopLeft.add(Vector2.right.mul(panelSizeA.x + interPanelSpacing));
		const panelSizeB = new Vector2(panelWidthSum * collectionPanelWidthT, panelHeight);
		const panelCTopLeft = panelBTopLeft.add(Vector2.right.mul(panelSizeB.x + interPanelSpacing));
		const panelSizeC = new Vector2(panelWidthSum * selectedPanelWidthT, panelHeight);

		isScrolling = UI.GetScrollbarState(ID_CollectionsScrollbar).isDragging || UI.GetScrollbarState(ID_StarredScrollbar).isDragging;

		const popupHasFocus = creatingNewCollection || renamingCollection || isConfirmingChipDeletion || isConfirmingCollectionDeletion;

		const disabled = UI.BeginDisabledScope(popupHasFocus);
		try {
			DrawStarredPanel(panelATopLeft, panelSizeA);
			DrawCollectionsPanel(panelBTopLeft, panelSizeB);
			DrawSelectedItemPanel(panelCTopLeft, panelSizeC);
		} finally {
			disabled.Dispose();
		}

		if (KeyboardShortcuts.CancelShortcutTriggered || (KeyboardShortcuts.LibraryShortcutTriggered && !wasOpenedThisFrame)) {
			if (popupHasFocus) ResetPopupState();
			else ExitLibrary();
		}

		wasOpenedThisFrame = false;
	},

	OnMenuOpened() {
		wasOpenedThisFrame = true;

		// Ensure the mandatory "OTHER" collection exists
		if (GetDefaultCollection() == null) collections().push(new ChipCollection(defaultOtherChipsCollectionName, []));

		// Automatically add any chips not in a collection to the "other" collection
		const chipsInCollection = new NameSet();
		for (const c of collections()) for (const n of c.Chips) chipsInCollection.add(n);
		const defaultCollection = GetDefaultCollection()!;

		for (const chip of project().chipLibrary.allChips) {
			if (!chipsInCollection.has(chip.Name)) defaultCollection.Chips.push(chip.Name);
		}

		// Reset state
		ResetPopupState();

		selectedStarredItemIndex = Math.min(selectedStarredItemIndex, project().description.StarredList.length - 1);
	},

	Reset() {
		selectedStarredItemIndex = -1;
		selectedCollectionIndex = 0;
		selectedChipInCollectionIndex = -1;
		ResetPopupState();
	},
};

function ResetPopupState() {
	creatingNewCollection = false;
	renamingCollection = false;
	isConfirmingChipDeletion = false;
	isConfirmingCollectionDeletion = false;

	deleteConfirmMessage = "";
}

function DrawPanelHeader(text: string, topLeft: Vector2, width: number) {
	const textCol = MakeCol("#3CD168");
	const bgCol = MakeCol("#1D1D1D");
	MenuHelper.DrawLeftAlignTextWithBackground(text, topLeft, new Vector2(width, 2.3), Anchor.TopLeft, textCol, bgCol, true);
}

function DrawStarredPanel(topLeft: Vector2, size: Vector2) {
	const panelID = UI.ReservePanel();
	const panelBounds = Bounds2D.CreateFromTopLeftAndSize(topLeft, size);
	DrawPanelHeader("STARRED", topLeft, size.x);

	const panelBoundsMinusHeader = Bounds2D.CreateFromTopLeftAndSize(UI.PrevBounds.BottomLeft, new Vector2(size.x, size.y - UI.PrevBounds.Height));
	const panelContentBounds = Bounds2D.Shrink(panelBoundsMinusHeader, PanelUIPadding);

	UI.DrawScrollViewElements(ID_StarredScrollbar, panelContentBounds.TopLeft, panelContentBounds.Size, DefaultSpacing, Anchor.TopLeft, ActiveUITheme.ScrollTheme, DrawStarredEntry, project().description.StarredList.length);
	MenuHelper.DrawReservedMenuPanel(panelID, panelBounds, false);
}

function DrawStarredEntry(topLeft: Vector2, width: number, index: number, _isLayoutPass: boolean) {
	const starredList = project().description.StarredList;
	const starredItem = starredList[index];
	const theme = GetButtonTheme(starredItem.IsCollection, index === selectedStarredItemIndex);

	interactableStates_starredList[0] = index < starredList.length - 1; // can move down
	interactableStates_starredList[1] = index > 0; // can move up

	const entryPressed = UI.Button(starredItem.Name, theme, topLeft, new Vector2(width, 2), true, false, false, Anchor.TopLeft, true, 1, isScrolling);
	if (entryPressed) {
		selectedStarredItemIndex = index;
		selectedCollectionIndex = -1;
		selectedChipInCollectionIndex = -1;
	}
}

function DrawCollectionsPanel(topLeft: Vector2, size: Vector2) {
	const panelID = UI.ReservePanel();
	const panelBounds = Bounds2D.CreateFromTopLeftAndSize(topLeft, size);
	DrawPanelHeader("COLLECTIONS", topLeft, size.x);
	const panelBoundsMinusHeader = Bounds2D.CreateFromTopLeftAndSize(UI.PrevBounds.BottomLeft, new Vector2(size.x, size.y - UI.PrevBounds.Height));
	const panelContentBounds = Bounds2D.Shrink(panelBoundsMinusHeader, PanelUIPadding);

	UI.DrawScrollViewElements(ID_CollectionsScrollbar, panelContentBounds.TopLeft, panelContentBounds.Size, DefaultSpacing, Anchor.TopLeft, ActiveUITheme.ScrollTheme, DrawCollectionEntry, collections().length);
	MenuHelper.DrawReservedMenuPanel(panelID, panelBounds, false);
}

function DrawCollectionEntry(topLeft: Vector2, width: number, collectionIndex: number, _isLayoutPass: boolean) {
	const collection = collections()[collectionIndex];
	const label = collection.GetDisplayString();

	const collectionHighlighted = collectionIndex === selectedCollectionIndex;
	const activeCollectionTheme = GetButtonTheme(true, collectionHighlighted);

	const collectionPressed = UI.Button(label, activeCollectionTheme, topLeft, new Vector2(width, 2), true, false, false, Anchor.TopLeft, true, 1, isScrolling);
	if (collectionPressed) {
		selectedCollectionIndex = collectionIndex;
		selectedChipInCollectionIndex = -1;
		selectedStarredItemIndex = -1;
		lastAutoOpenedCollection = null;
		// If holding control, select without toggling
		if (!InputHelper.CtrlIsHeld) collection.IsToggledOpen = !collection.IsToggledOpen;
	}

	const nestedInset = 1.75;

	if (collection.IsToggledOpen) {
		for (let chipIndex = 0; chipIndex < collection.Chips.length; chipIndex++) {
			const chipName = collection.Chips[chipIndex];
			const activeChipTheme = collectionIndex === selectedCollectionIndex && chipIndex === selectedChipInCollectionIndex ? ActiveUITheme.ChipLibraryChipToggleOn : ActiveUITheme.ChipLibraryChipToggleOff;
			const chipLabelPos = new Vector2(topLeft.x + nestedInset, UI.PrevBounds.Bottom - DefaultSpacing);
			const chipPressed = UI.Button(chipName, activeChipTheme, chipLabelPos, new Vector2(width - nestedInset, 2), true, false, false, Anchor.TopLeft, true, 1, isScrolling);
			if (chipPressed) {
				const alreadySelected = selectedChipInCollectionIndex === chipIndex && collectionHighlighted;

				if (alreadySelected) selectedChipInCollectionIndex = -1;
				else {
					selectedCollectionIndex = collectionIndex;
					selectedChipInCollectionIndex = chipIndex;
				}

				selectedStarredItemIndex = -1;
				lastAutoOpenedCollection = null;
			}
		}
	}
}

function DrawSelectedItemPanel(topLeftIn: Vector2, size: Vector2) {
	let panelID = UI.ReservePanel();
	const panelContentBounds = Bounds2D.Shrink(Bounds2D.CreateFromTopLeftAndSize(topLeftIn, size), PanelUIPadding);
	const tl = { v: panelContentBounds.TopLeft }; // (ref Vector2 topLeft)
	const SectionSpacing = 3;
	const proj = project();
	const cols = collections();

	const DrawHeader = (text: string, bgCol: Color, textCol: Color, width: number, spacingBelow = DefaultButtonSpacing) => {
		MenuHelper.DrawCentredTextWithBackground(text, tl.v, new Vector2(width, 2), Anchor.TopLeft, textCol, bgCol);
		tl.v = tl.v.add(Vector2.down.mul(UI.PrevBounds.Height + spacingBelow));
	};

	const DrawHorizontalButtonGroup = (names: string[], interactionStates: boolean[] | null, width: number, verticalSpacing = DefaultButtonSpacing): number => {
		const buttonIndex = UI.HorizontalButtonGroup(names, interactionStates, ActiveUITheme.ButtonTheme, tl.v, width, DefaultButtonSpacing, 0, Anchor.TopLeft);
		tl.v = tl.v.withY(tl.v.y - (UI.PrevBounds.Height + verticalSpacing));
		return buttonIndex;
	};

	const ChipActionButtons = (selectedChipName: string, width: number) => {
		const isBuiltin = proj.chipLibrary.IsBuiltinChip(selectedChipName);
		interactable_chipActionButtons[0] = proj.ViewedChip.CanAddSubchip(selectedChipName);
		interactable_chipActionButtons[1] = !isBuiltin;
		interactable_chipActionButtons[2] = !isBuiltin;
		const chipActionIndex = DrawHorizontalButtonGroup(buttonNames_chipAction, interactable_chipActionButtons, width);

		if (chipActionIndex === 0) {
			// use
			proj.controller.StartPlacing(proj.chipLibrary.GetChipDescription(selectedChipName));
			ExitLibrary();
		} else if (chipActionIndex === 1) {
			// open
			chipToOpenName = selectedChipName;
			if (proj.ActiveChipHasUnsavedChanges()) UnsavedChangesPopup.OpenPopup(OpenChipIfConfirmed);
			else OpenChipIfConfirmed(true);
		} else if (chipActionIndex === 2) {
			// delete
			isConfirmingChipDeletion = true;
			const [msg, warn] = CreateDeleteConfirmationMessage(selectedChipName);
			deleteConfirmMessage = msg;
			deleteConfirmMessageCol = warn ? deleteColWarningHigh : deleteColWarningMedium;
		}
	};

	const MoveSelectedChipToNewCollection = (newCollectionIndex: number): ChipCollection => {
		const collectionOld = cols[selectedCollectionIndex];
		const chipName = collectionOld.Chips[selectedChipInCollectionIndex];

		collectionOld.Chips.splice(selectedChipInCollectionIndex, 1);
		// If this collection was opened automatically when the chip was moved to it previously, close it automatically now that chip is leaving it
		if (collectionOld === lastAutoOpenedCollection) {
			lastAutoOpenedCollection = null;
			collectionOld.IsToggledOpen = false;
		}

		const movingUp = newCollectionIndex < selectedCollectionIndex;
		selectedCollectionIndex = newCollectionIndex;
		const collectionNew = cols[selectedCollectionIndex];

		if (movingUp) {
			collectionNew.Chips.push(chipName);
			selectedChipInCollectionIndex = collectionNew.Chips.length - 1;
		} else {
			collectionNew.Chips.splice(0, 0, chipName);
			selectedChipInCollectionIndex = 0;
		}

		if (!collectionNew.IsToggledOpen) {
			lastAutoOpenedCollection = collectionNew;
			collectionNew.IsToggledOpen = true;
		}

		return collectionNew;
	};

	const hasCollectionSelected = selectedCollectionIndex !== -1 && selectedChipInCollectionIndex === -1;
	const hasChipSelected = selectedCollectionIndex !== -1 && selectedChipInCollectionIndex !== -1;
	const hasStarredItemSelected = selectedStarredItemIndex !== -1;
	const width = panelContentBounds.Width;

	if (hasChipSelected || hasCollectionSelected || hasStarredItemSelected) {
		const scope = UI.BeginBoundsScope(true);
		try {
			// ---- Selected Chip UI ----
			if (hasChipSelected) {
				// ---- Draw ----
				const collection = cols[selectedCollectionIndex];
				const selectedChipName = collection.Chips[selectedChipInCollectionIndex];
				const canStepUpInCollection = selectedChipInCollectionIndex > 0;
				const canStepDownInCollection = selectedChipInCollectionIndex < collection.Chips.length - 1;
				const canJumpUpACollection = selectedCollectionIndex > 0;
				const canJumpDownACollection = selectedCollectionIndex < cols.length - 1;

				const colSource = GetButtonTheme(false, true);
				const colSourceCollection = GetButtonTheme(true, true);
				DrawHeader(collection.Name, colSourceCollection.buttonCols.normal, colSourceCollection.textCols.normal, width);
				DrawHeader(selectedChipName, colSource.buttonCols.normal, colSource.textCols.normal, width);

				const isStarred = IsStarred(proj.description, selectedChipName, false);
				const toggleStarred = DrawHorizontalButtonGroup(buttonName_starUnstar[isStarred ? 1 : 0], null, width) === 0;
				// Buttons: down/up
				interactableStates_move[0] = canStepUpInCollection || canJumpUpACollection;
				interactableStates_move[1] = canStepDownInCollection || canJumpDownACollection;
				const buttonIndex_moveStep = DrawHorizontalButtonGroup(buttonNames_moveSingleStep, interactableStates_move, width);
				const buttonIndex_moveJump = DrawHorizontalButtonGroup(buttonNames_jump, interactableStates_move, width);
				ChipActionButtons(selectedChipName, width);

				const moveSingleStepDown = buttonIndex_moveStep === 1;
				const moveJumpDown = buttonIndex_moveJump === 1;
				const moveSingleStepUp = buttonIndex_moveStep === 0;
				const moveJumpUp = buttonIndex_moveJump === 0;

				// ---- Handle button inputs ----
				if (toggleStarred) proj.SetStarred(selectedChipName, !isStarred, false);

				if (moveSingleStepDown || moveJumpDown) {
					// Move chip down
					const moveWithinCurrentCollection = (moveSingleStepDown && canStepDownInCollection) || (moveJumpDown && !canJumpDownACollection);
					if (moveWithinCurrentCollection) {
						// move down in current collection
						const targetIndex = moveJumpDown ? collection.Chips.length - 1 : selectedChipInCollectionIndex + 1;
						collection.Chips.splice(selectedChipInCollectionIndex, 1);
						collection.Chips.splice(targetIndex, 0, selectedChipName);
						selectedChipInCollectionIndex = targetIndex;
					} else {
						// move down to next collection
						MoveSelectedChipToNewCollection(selectedCollectionIndex + 1);
					}
				} else if (moveSingleStepUp || moveJumpUp) {
					// Move chip up
					const moveWithinCurrentCollection = (moveSingleStepUp && canStepUpInCollection) || (moveJumpUp && !canJumpUpACollection);
					if (moveWithinCurrentCollection) {
						// move up in current collection
						const targetIndex = moveJumpUp ? 0 : selectedChipInCollectionIndex - 1;
						collection.Chips.splice(selectedChipInCollectionIndex, 1);
						collection.Chips.splice(targetIndex, 0, selectedChipName);
						selectedChipInCollectionIndex = targetIndex;
					} else {
						// move up to next collection
						MoveSelectedChipToNewCollection(selectedCollectionIndex - 1);
					}
				}
			}
			// ---- Selected Collection UI ----
			else if (hasCollectionSelected) {
				// ---- Draw ----
				const collection = cols[selectedCollectionIndex];
				const colSource = GetButtonTheme(true, true);
				DrawHeader(collection.Name, colSource.buttonCols.normal, colSource.textCols.normal, width);

				const isStarred = IsStarred(proj.description, collection.Name, true);
				const toggleStarred = DrawHorizontalButtonGroup(buttonName_starUnstar[isStarred ? 1 : 0], null, width) === 0;

				interactableStates_move[0] = selectedCollectionIndex > 0;
				interactableStates_move[1] = selectedCollectionIndex < cols.length - 1;
				const buttonIndexOrganize = DrawHorizontalButtonGroup(buttonNames_moveSingleStep, interactableStates_move, width);

				const canRenameOrDelete = !NameMatch(collection.Name, defaultOtherChipsCollectionName);
				interactableStates_renameDelete[0] = canRenameOrDelete;
				interactableStates_renameDelete[1] = canRenameOrDelete;
				const buttonIndexEditCollection = DrawHorizontalButtonGroup(buttonNames_collectionRenameOrDelete, interactableStates_renameDelete, width);

				// ---- Handle button inputs ----
				if (toggleStarred) proj.SetStarred(collection.Name, !isStarred, true);

				if (buttonIndexEditCollection === 0) {
					// Rename collection
					UI.GetInputFieldState(ID_NameInput).ClearText();
					renamingCollection = true;
				} else if (buttonIndexEditCollection === 1) {
					// Delete collection
					if (collection.Chips.length === 0) DeleteSelectedCollection();
					else {
						deleteConfirmMessage = `Are you sure you want to delete this collection? The chips inside of it will be moved to "${defaultOtherChipsCollectionName}".`;
						deleteConfirmMessage = UI.LineBreakByCharCount(deleteConfirmMessage, deleteMessageMaxCharsPerLine);
						deleteConfirmMessageCol = deleteColWarningMedium;
						isConfirmingCollectionDeletion = true;
					}
				}

				if (buttonIndexOrganize === 0) {
					// Move collection up
					const indexStart = selectedCollectionIndex;
					const indexEnd = selectedCollectionIndex - 1;
					[cols[indexStart], cols[indexEnd]] = [cols[indexEnd], cols[indexStart]];
					selectedCollectionIndex = indexEnd;
				} else if (buttonIndexOrganize === 1) {
					// Move collection down
					const indexStart = selectedCollectionIndex;
					const indexEnd = selectedCollectionIndex + 1;
					[cols[indexStart], cols[indexEnd]] = [cols[indexEnd], cols[indexStart]];
					selectedCollectionIndex = indexEnd;
				}
			} else if (hasStarredItemSelected) {
				const starredList = proj.description.StarredList;
				const starredItem = starredList[selectedStarredItemIndex];
				const colSource = GetButtonTheme(starredItem.IsCollection, true);
				DrawHeader(starredItem.Name, colSource.buttonCols.normal, colSource.textCols.normal, width);

				const removeStarred = DrawHorizontalButtonGroup(buttonName_starUnstar[1], null, width) === 0;
				// Buttons: move down/up
				interactableStates_move[0] = selectedStarredItemIndex > 0; // can move up
				interactableStates_move[1] = selectedStarredItemIndex < starredList.length - 1; // can move down
				const buttonIndexOrganize = DrawHorizontalButtonGroup(buttonNames_moveSingleStep, interactableStates_move, width);

				if (!starredItem.IsCollection) ChipActionButtons(starredItem.Name, width);

				if (buttonIndexOrganize === 0 || buttonIndexOrganize === 1) {
					// move down/up
					const fromIndex = selectedStarredItemIndex;
					const targetIndex = buttonIndexOrganize === 0 ? fromIndex - 1 : fromIndex + 1;
					[starredList[fromIndex], starredList[targetIndex]] = [starredList[targetIndex], starredList[fromIndex]];
					selectedStarredItemIndex = targetIndex;
				} else if (removeStarred) {
					proj.SetStarred(starredItem.Name, false, starredItem.IsCollection);
					selectedStarredItemIndex = Math.min(selectedStarredItemIndex, proj.description.StarredList.length - 1);
				}
			}

			tl.v = UI.GetCurrentBoundsScope().BottomLeft.add(Vector2.down.mul(SectionSpacing));
			MenuHelper.DrawReservedMenuPanel(panelID, UI.GetCurrentBoundsScope());
		} finally {
			scope.Dispose();
		}
	}

	if (!(isConfirmingChipDeletion || isConfirmingCollectionDeletion)) {
		const scope = UI.BeginBoundsScope(true);
		try {
			panelID = UI.ReservePanel();

			// New collection button
			if (!renamingCollection) {
				const createNew = UI.Button("NEW COLLECTION", ActiveUITheme.ButtonTheme, tl.v, new Vector2(width, 0), true, false, true, Anchor.TopLeft);
				if (createNew) creatingNewCollection = true;
				if (!creatingNewCollection) {
					tl.v = tl.v.add(Vector2.down.mul(UI.PrevBounds.Height + DefaultButtonSpacing * 1));
					const exit = UI.Button("EXIT LIBRARY", ActiveUITheme.ButtonTheme, tl.v, new Vector2(width, 0), true, false, true, Anchor.TopLeft);
					if (exit) ExitLibrary();
				}

				tl.v = tl.v.add(Vector2.down.mul(UI.PrevBounds.Height + DefaultButtonSpacing * 2));
			}

			// New collection / rename collection input field
			if (creatingNewCollection || renamingCollection) {
				const notDisabled = UI.BeginDisabledScope(false);
				try {
					const inputTheme: InputFieldTheme = { ...MenuHelper.Theme.ChipNameInputField };
					inputTheme.fontSize = MenuHelper.Theme.FontSizeRegular;
					const nameField = UI.InputField(ID_NameInput, inputTheme, tl.v, new Vector2(width, 2.5), "", Anchor.TopLeft, 1, ValidateCollectionNameInput, true);
					const button_cancelConfirm = MenuHelper.DrawButtonPair("CANCEL", renamingCollection ? "RENAME" : "CREATE", UI.PrevBounds.BottomLeft, width, true, true, IsValidCollectionName(nameField.text));
					if (button_cancelConfirm === 0) {
						nameField.ClearText();
						creatingNewCollection = false;
						renamingCollection = false;
					} else if (button_cancelConfirm === 1 || KeyboardShortcuts.ConfirmShortcutTriggered) {
						if (creatingNewCollection) {
							cols.push(new ChipCollection(nameField.text, []));
							selectedChipInCollectionIndex = -1;
							selectedCollectionIndex = cols.length - 1;
							selectedStarredItemIndex = -1;
						} else if (renamingCollection) {
							const nameNew = nameField.text;
							proj.RenameCollection(selectedCollectionIndex, nameNew);
						}

						nameField.ClearText();
						creatingNewCollection = false;
						renamingCollection = false;
					}
				} finally {
					notDisabled.Dispose();
				}
			}

			tl.v = UI.GetCurrentBoundsScope().BottomLeft.add(Vector2.down.mul(SectionSpacing));
			MenuHelper.DrawReservedMenuPanel(panelID, UI.GetCurrentBoundsScope());
		} finally {
			scope.Dispose();
		}
	}

	// Delete confirmation
	if (isConfirmingChipDeletion || isConfirmingCollectionDeletion) {
		const scope = UI.BeginBoundsScope(true);
		const notDisabled = UI.BeginDisabledScope(false);
		try {
			panelID = UI.ReservePanel();
			UI.DrawText(deleteConfirmMessage, ActiveUITheme.FontRegular, ActiveUITheme.FontSizeRegular, tl.v, Anchor.TopLeft, deleteConfirmMessageCol);
			tl.v = tl.v.add(Vector2.down.mul(UI.PrevBounds.Height + DefaultButtonSpacing * 3));
			const button_cancelConfirm = MenuHelper.DrawButtonPair("CANCEL", "DELETE", tl.v, width, false);

			if (button_cancelConfirm === 0) {
				// cancel delete
				ResetPopupState();
			} else if (button_cancelConfirm === 1 || KeyboardShortcuts.ConfirmShortcutTriggered) {
				// confirm delete
				if (isConfirmingChipDeletion) {
					if (selectedCollectionIndex !== -1) {
						// deleting from collection
						const collection = cols[selectedCollectionIndex];
						const chipName = collection.Chips[selectedChipInCollectionIndex];
						proj.DeleteChip(chipName);
						selectedChipInCollectionIndex = Math.min(selectedChipInCollectionIndex, collection.Chips.length - 1);
					} else {
						// deleting chip
						const chipName = proj.description.StarredList[selectedStarredItemIndex].Name;
						proj.DeleteChip(chipName);
						selectedStarredItemIndex = Math.min(selectedStarredItemIndex, proj.description.StarredList.length - 1);
					}
				} else if (isConfirmingCollectionDeletion) {
					DeleteSelectedCollection();
				}

				ResetPopupState();
			}

			MenuHelper.DrawReservedMenuPanel(panelID, UI.GetCurrentBoundsScope());
		} finally {
			notDisabled.Dispose();
			scope.Dispose();
		}
	}
}

function DeleteSelectedCollection() {
	const cols = collections();
	const defaultCollection = GetDefaultCollection()!;
	const collectionToDelete = cols[selectedCollectionIndex];

	for (const chipName of collectionToDelete.Chips) defaultCollection.Chips.push(chipName);

	project().SetStarred(collectionToDelete.Name, false, true, false);
	cols.splice(selectedCollectionIndex, 1);
	selectedCollectionIndex = Math.max(0, selectedCollectionIndex - 1);

	project().SaveCurrentProjectDescription();
}

function GetDefaultCollection(): ChipCollection | null {
	return collections().find((c) => NameMatch(c.Name, defaultOtherChipsCollectionName)) ?? null;
}

function ValidateCollectionNameInput(name: string): boolean {
	return name.length <= 24;
}

function IsValidCollectionName(name: string): boolean {
	if (!ValidateCollectionNameInput(name)) return false;
	if (!name || !name.trim()) return false;

	const cols = collections();
	for (let i = 0; i < cols.length; i++) {
		if (i === selectedCollectionIndex) continue;
		if (NameMatch(cols[i].Name, name)) return false;
	}

	return true;
}

function GetButtonTheme(isCollection: boolean, isSelected: boolean): ButtonTheme {
	if (isCollection) return isSelected ? ActiveUITheme.ChipLibraryCollectionToggleOn : ActiveUITheme.ChipLibraryCollectionToggleOff;
	return isSelected ? ActiveUITheme.ChipLibraryChipToggleOn : ActiveUITheme.ChipLibraryChipToggleOff;
}

function OpenChipIfConfirmed(confirm: boolean) {
	if (confirm) {
		project().LoadDevChipOrCreateNewIfDoesntExist(chipToOpenName);
		ExitLibrary();
	} else {
		UIDrawer.SetActiveMenu(MenuType.ChipLibrary);
	}
}

function ExitLibrary() {
	project().UpdateAndSaveProjectDescription();
	UIDrawer.SetActiveMenu(MenuType.None);
}

function CreateDeleteConfirmationMessage(chipName: string): [string, boolean] {
	const proj = project();
	const parentNames = proj.chipLibrary.GetDirectParentChips(chipName).map((c) => c.Name);
	const usedInCurrentChip = proj.ViewedChip.GetSubchips().some((s) => NameMatch(s.Description.Name, chipName));

	if (usedInCurrentChip) {
		const i = parentNames.indexOf(proj.ViewedChip.ChipName);
		if (i >= 0) parentNames.splice(i, 1);
		parentNames.splice(0, 0, "the CURRENT CHIP");
	}

	let message = "Are you sure you want to delete this chip? ";
	let warn = parentNames.length > 0;

	const lastSaved = proj.ViewedChip.LastSavedDescription;
	if (lastSaved != null && NameMatch(lastSaved.Name, chipName)) {
		message = "Are you sure you want to delete the chip that you are CURRENTLY EDITING? ";
		warn = true;
	}

	const FormatChipName = (index: number) => {
		const useQuotes = !(index === 0 && usedInCurrentChip);
		return useQuotes ? `"${parentNames[index]}"` : parentNames[index];
	};

	const CreateChipInUseWarningMessage = (): string => {
		const numUses = parentNames.length;
		const usage = "It is used by";
		if (numUses === 1) return `${usage} ${FormatChipName(0)}.`;
		if (numUses === 2) return `${usage} ${FormatChipName(0)} and ${FormatChipName(1)}.`;
		if (numUses > 2) return `${usage} ${FormatChipName(0)} and ${numUses - 1} others.`;
		return "";
	};

	if (parentNames.length === 0) message += "It is not used anywhere.";
	else message += CreateChipInUseWarningMessage();

	return [UI.LineBreakByCharCount(message, deleteMessageMaxCharsPerLine), warn];
}

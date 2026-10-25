// Port of DLS.Graphics.ChipSaveMenu
import { Color } from "../../../../seb/types/Color";
import { Vector2 } from "../../../../seb/types/Vector2";
import { Anchor } from "../../../../seb/vis/Anchor";
import { UI } from "../../../../seb/vis/ui/UI";
import { UIHandle } from "../../../../seb/vis/ui/UITheme";
import { type ChipDescription, NameMatch, SubChipDescription } from "../../../description/Types";
import { SubChipInstance } from "../../../game/elements/SubChipInstance";
import { KeyboardShortcuts } from "../../../game/KeyboardShortcuts";
import { Project, SaveMode } from "../../../game/Project";
import { CreateChipDescription } from "../../../saveSystem/DescriptionCreator";
import { Saver } from "../../../saveSystem/Saver";
import { SaveUtils } from "../../../saveSystem/SavePaths";
import { ActiveUITheme, DefaultButtonSpacing } from "../../DrawSettings";
import { MenuHelper } from "../MenuHelper";
import { MenuType, UIDrawer } from "../UIDrawer";

const MaxLengthChipName = "MY VERY LONG CHIP NAME";

const CancelButtonIndex = 0;
const CustomizeButtonIndex = 1;
const SaveButtonIndex = 2;
const SaveAsButtonIndex = 3;
const ID_ChipNameField = UIHandle("SaveMenu_ChipNameField");

let CustomizeStateBeforeEnteringCustomizeMenu: SubChipInstance | null = null;

const CancelSaveButtonNames = ["CANCEL", "CUSTOMIZE", "SAVE"];
const CancelRenameSaveButtonNames = ["CANCEL", "CUSTOMIZE", "RENAME", "SAVE AS"];
const ButtonGroupInteractStates = [true, true, true, true];

export const ChipSaveMenu = {
	MaxLengthChipName,
	ActiveCustomizeChip: null as SubChipInstance | null,

	get ActiveCustomizeDescription(): ChipDescription {
		return ChipSaveMenu.ActiveCustomizeChip!.Description;
	},

	OnMenuOpened() {
		ChipSaveMenu.ActiveCustomizeChip ??= CreateCustomizationState();
		InitUIFromDescription(ChipSaveMenu.ActiveCustomizeChip.Description);
	},

	GetTextInputSize(): [Vector2, number] {
		const textPad = 2;
		const inputTheme = ActiveUITheme.ChipNameInputField;
		const inputFieldSize = UI.CalculateTextSize(MaxLengthChipName, inputTheme.fontSize, inputTheme.font).add(new Vector2(textPad * 2, 3));
		return [inputFieldSize, textPad];
	},

	DrawMenu() {
		MenuHelper.DrawBackgroundOverlay();

		const theme = ActiveUITheme;
		const inputTheme = ActiveUITheme.ChipNameInputField;

		const scope = UI.BeginBoundsScope(true);
		try {
			const panelID = UI.ReservePanel();

			// -- Chip name input field --
			const [inputFieldSize, inputFieldTextPad] = ChipSaveMenu.GetTextInputSize();
			const inputFieldState = UI.InputField(ID_ChipNameField, inputTheme, new Vector2(50, 33), inputFieldSize, "Name", Anchor.Centre, inputFieldTextPad, ChipSaveMenu.ValidateChipNameInput, true);

			const buttonTopLeft = UI.PrevBounds.BottomLeft.add(Vector2.down.mul(DefaultButtonSpacing * 2));
			const project = Project.ActiveProject;
			const renaming = project.ChipHasBeenSavedBefore && !NameMatch(inputFieldState.text, project.ViewedChip.LastSavedDescription!.Name);

			const saveButtonEnabled = IsValidSaveName(inputFieldState.text);
			ButtonGroupInteractStates[SaveButtonIndex] = saveButtonEnabled;
			ButtonGroupInteractStates[SaveAsButtonIndex] = saveButtonEnabled;
			const buttonGroupNames = renaming ? CancelRenameSaveButtonNames : CancelSaveButtonNames;
			const buttonIndex = UI.HorizontalButtonGroup(buttonGroupNames, ButtonGroupInteractStates.slice(0, buttonGroupNames.length), theme.ButtonTheme, buttonTopLeft, UI.PrevBounds.Width, DefaultButtonSpacing, 0, Anchor.TopLeft);
			const confirmShortcut = !renaming && KeyboardShortcuts.ConfirmShortcutTriggered;

			if (buttonIndex === CancelButtonIndex || KeyboardShortcuts.CancelShortcutTriggered) Cancel();
			else if (buttonIndex === CustomizeButtonIndex) OpenCustomizationMenu();
			else if (buttonIndex === SaveButtonIndex || confirmShortcut) Save(renaming ? SaveMode.Rename : SaveMode.Normal);
			else if (buttonIndex === SaveAsButtonIndex) Save(SaveMode.SaveAs);

			const uiBounds = UI.GetCurrentBoundsScope();
			MenuHelper.DrawReservedMenuPanel(panelID, uiBounds);

			// Update customization state
			if (ChipSaveMenu.ActiveCustomizeChip != null) {
				const newName = inputFieldState.text;
				const desc = ChipSaveMenu.ActiveCustomizeDescription;
				if (desc.Name !== newName) {
					desc.Name = newName;
					const minChipSize = SubChipInstance.CalculateMinChipSize(desc.InputPins, desc.OutputPins, newName);
					desc.Size = Vector2.max(minChipSize, desc.Size);
				}
			}
		} finally {
			scope.Dispose();
		}
	},

	RevertCustomizationStateToBeforeEnteringCustomizeMenu() {
		ChipSaveMenu.ActiveCustomizeChip = CustomizeStateBeforeEnteringCustomizeMenu;
		CustomizeStateBeforeEnteringCustomizeMenu = CreatePreviewSubChipInstance(Saver.CloneChipDescription(ChipSaveMenu.ActiveCustomizeDescription)!);
	},

	ValidateChipNameInput(nameInput: string): boolean {
		return nameInput.length <= MaxLengthChipName.length && !SaveUtils.NameContainsForbiddenChar(nameInput);
	},

	Reset() {
		ChipSaveMenu.ActiveCustomizeChip = null;
		CustomizeStateBeforeEnteringCustomizeMenu = null;
	},
};

// Create a subchip instance based on the current dev chip (we need a subchip instance to be able to draw a preview of the chip in the customization menu)
// The description on this subchip holds potential customizations, such as name changes, resizing, colour etc.
function CreateCustomizationState(): SubChipInstance {
	const desc = CreateChipDescription(Project.ActiveProject.ViewedChip);
	return CreatePreviewSubChipInstance(desc);
}

function OpenCustomizationMenu() {
	ChipSaveMenu.ActiveCustomizeChip = CreatePreviewSubChipInstance(ChipSaveMenu.ActiveCustomizeDescription);
	CustomizeStateBeforeEnteringCustomizeMenu = CreatePreviewSubChipInstance(Saver.CloneChipDescription(ChipSaveMenu.ActiveCustomizeDescription)!);
	UIDrawer.SetActiveMenu(MenuType.ChipCustomization);
}

function CreatePreviewSubChipInstance(desc: ChipDescription): SubChipInstance {
	const subChipDesc = SubChipDescription(desc.Name, 0, "", Vector2.zero, []);
	return new SubChipInstance(desc, subChipDesc);
}

function IsValidSaveName(chipName: string): boolean {
	const project = Project.ActiveProject;

	const validName = chipName.trim().length > 0 && SaveUtils.ValidFileName(chipName);
	const nameAlreadyUsed = project.chipLibrary.HasChip(chipName);
	const isNameOfActiveChip = NameMatch(project.ActiveDevChipName, chipName);

	return validName && (!nameAlreadyUsed || isNameOfActiveChip);
}

function InitUIFromDescription(chipDesc: ChipDescription) {
	// Set input field to current chip name
	UI.GetInputFieldState(ID_ChipNameField).SetText(chipDesc.Name);
}

function Save(mode: SaveMode) {
	Project.ActiveProject.SaveFromDescription(ChipSaveMenu.ActiveCustomizeDescription, mode);
	CloseMenu();
}

function Cancel() {
	CloseMenu();
}

function CloseMenu() {
	ChipSaveMenu.ActiveCustomizeChip = null;
	UIDrawer.SetActiveMenu(MenuType.None);
}

// (unused in the original)
export function RandomInitialColour(): Color {
	return Color.HSVToRGB(Math.random(), 0.2 + 0.8 * Math.random(), 0.2 + 0.8 * Math.random());
}

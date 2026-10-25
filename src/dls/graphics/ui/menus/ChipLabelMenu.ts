// Port of DLS.Graphics.ChipLabelMenu
import { Vector2 } from "../../../../seb/types/Vector2";
import { Anchor } from "../../../../seb/vis/Anchor";
import { UI } from "../../../../seb/vis/ui/UI";
import { Draw } from "../../../../seb/vis/Draw";
import { UIHandle } from "../../../../seb/vis/ui/UITheme";
import type { SubChipInstance } from "../../../game/elements/SubChipInstance";
import { KeyboardShortcuts } from "../../../game/KeyboardShortcuts";
import { ActiveUITheme, DefaultButtonSpacing } from "../../DrawSettings";
import { MenuHelper } from "../MenuHelper";
import { MenuType, UIDrawer } from "../UIDrawer";
import { ContextMenu } from "./ContextMenu";

const MaxLabelLength = "MY LONG LABEL TEXT";
let subChip: SubChipInstance;
const ID_NameField = UIHandle("ChipLabelMenu_NameField");

const CancelConfirmButtonNames = ["CANCEL", "CONFIRM"];
const ButtonGroupInteractStates = [true, true];

export const ChipLabelMenu = {
	OnMenuOpened() {
		subChip = ContextMenu.interactionContext as SubChipInstance;

		const inputFieldState = UI.GetInputFieldState(ID_NameField);
		inputFieldState.SetText(subChip.Label);
		inputFieldState.SelectAll();
	},

	DrawMenu() {
		UI.DrawFullscreenPanel(ActiveUITheme.MenuBackgroundOverlayCol);
		const spacing = 0.8;

		const theme = ActiveUITheme;
		const inputTheme = ActiveUITheme.ChipNameInputField;
		const panelID = UI.ReservePanel();

		const scope = UI.BeginBoundsScope(true);
		try {
			const unpaddedSize = Draw.CalculateTextBoundsSize(MaxLabelLength, inputTheme.fontSize, inputTheme.font);
			const padX = 2.25;
			const inputFieldSize = unpaddedSize.add(new Vector2(padX, 2.25));
			const pos = UI.Centre.add(Vector2.up.mul(5));

			// Draw input field
			const inputFieldState = UI.InputField(ID_NameField, inputTheme, pos, inputFieldSize, subChip.Label, Anchor.Centre, padX / 2, ValidateNameInput, true);
			const inputFieldBounds = UI.PrevBounds;
			const newName = inputFieldState.text;

			// Draw cancel/confirm buttons
			const buttonsTopLeft = UI.PrevBounds.BottomLeft.add(Vector2.down.mul(spacing));
			const buttonIndex = UI.HorizontalButtonGroup(CancelConfirmButtonNames, ButtonGroupInteractStates, theme.ButtonTheme, buttonsTopLeft, inputFieldBounds.Width, DefaultButtonSpacing, 0, Anchor.TopLeft);

			MenuHelper.DrawReservedMenuPanel(panelID, UI.GetCurrentBoundsScope());

			// Keyboard shortcuts and UI input
			if (KeyboardShortcuts.CancelShortcutTriggered || buttonIndex === 0) Cancel();
			else if (KeyboardShortcuts.ConfirmShortcutTriggered || buttonIndex === 1) Confirm(newName);
		} finally {
			scope.Dispose();
		}
	},
};

function Confirm(newName: string) {
	subChip.Label = newName;
	UIDrawer.SetActiveMenu(MenuType.None);
}

function Cancel() {
	UIDrawer.SetActiveMenu(MenuType.None);
}

const ValidateNameInput = (name: string) => name.length <= MaxLabelLength.length;

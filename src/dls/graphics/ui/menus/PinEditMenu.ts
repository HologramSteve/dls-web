// Port of DLS.Graphics.PinEditMenu
import { Color } from "../../../../seb/types/Color";
import { Vector2 } from "../../../../seb/types/Vector2";
import { Anchor } from "../../../../seb/vis/Anchor";
import { UI } from "../../../../seb/vis/ui/UI";
import { Draw } from "../../../../seb/vis/Draw";
import { UIHandle } from "../../../../seb/vis/ui/UITheme";
import { PinBitCount, type PinValueDisplayMode } from "../../../description/Types";
import type { DevPinInstance } from "../../../game/elements/DevPinInstance";
import { KeyboardShortcuts } from "../../../game/KeyboardShortcuts";
import { ActiveUITheme, DefaultButtonSpacing, SelectorWheelHeight } from "../../DrawSettings";
import { MenuHelper } from "../MenuHelper";
import { MenuType, UIDrawer } from "../UIDrawer";

const MaxLengthPinName = "MY LONG PIN NAME";
let devPin: DevPinInstance;
const ID_NameField = UIHandle("PinEditMenu_NameField");
const ID_ValueDisplayMode = UIHandle("PinEditMenu_ValueDisplayMode");

const CancelConfirmButtonNames = ["CANCEL", "CONFIRM"];
const ButtonGroupInteractStates = [true, true];
const PinDecimalDisplayOptions = ["Off", "Unsigned", "Signed", "HEX"];

export const PinEditMenu = {
	OnMenuOpened() {
		const inputFieldState = UI.GetInputFieldState(ID_NameField);
		inputFieldState.SetText(devPin.Pin.Name);
		inputFieldState.SelectAll();

		UI.GetWheelSelectorState(ID_ValueDisplayMode).index = devPin.pinValueDisplayMode;
	},

	DrawMenu() {
		UI.DrawFullscreenPanel(ActiveUITheme.MenuBackgroundOverlayCol);
		const spacing = 0.8;

		const theme = ActiveUITheme;
		const inputTheme = ActiveUITheme.ChipNameInputField;
		const panelID = UI.ReservePanel();

		const scope = UI.BeginBoundsScope(true);
		try {
			const unpaddedSize = Draw.CalculateTextBoundsSize(MaxLengthPinName, inputTheme.fontSize, inputTheme.font);
			const padX = 2.25;
			const inputFieldSize = unpaddedSize.add(new Vector2(padX, 2.25));
			const pos = UI.Centre.add(Vector2.up.mul(5));

			// Draw input field
			const inputFieldState = UI.InputField(ID_NameField, inputTheme, pos, inputFieldSize, devPin.Pin.Name, Anchor.Centre, padX / 2, ValidatePinNameInput, true);
			const inputFieldBounds = UI.PrevBounds;
			const newName = inputFieldState.text;

			// Draw value display options
			if (devPin.BitCount !== PinBitCount.Bit1) {
				const wheelWidth = 15.2;
				const topLeftCurr = UI.PrevBounds.BottomLeft.add(Vector2.down.mul(spacing));
				MenuHelper.LabeledOptionsWheel("Decimal Display", Color.white, topLeftCurr, new Vector2(inputFieldBounds.Width, SelectorWheelHeight), ID_ValueDisplayMode, PinDecimalDisplayOptions, wheelWidth, true);
			}

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

	SetTargetPin(pin: DevPinInstance) {
		devPin = pin;
	},
};

function Confirm(newName: string) {
	devPin.Pin.Name = newName;
	if (devPin.BitCount !== PinBitCount.Bit1) {
		devPin.pinValueDisplayMode = UI.GetWheelSelectorState(ID_ValueDisplayMode).index as PinValueDisplayMode;
	}
	UIDrawer.SetActiveMenu(MenuType.None);
}

function Cancel() {
	UIDrawer.SetActiveMenu(MenuType.None);
}

const ValidatePinNameInput = (name: string) => name.length <= MaxLengthPinName.length;

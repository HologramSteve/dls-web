// Port of DLS.Graphics.PulseEditMenu
import { Color } from "../../../../seb/types/Color";
import { Vector2 } from "../../../../seb/types/Vector2";
import { Anchor } from "../../../../seb/vis/Anchor";
import { UI } from "../../../../seb/vis/ui/UI";
import { type InputFieldTheme, UIHandle } from "../../../../seb/vis/ui/UITheme";
import type { SubChipInstance } from "../../../game/elements/SubChipInstance";
import { Project } from "../../../game/Project";
import { ActiveUITheme, SelectorWheelHeight, VerticalButtonSpacing } from "../../DrawSettings";
import { CancelConfirmResult, MenuHelper } from "../MenuHelper";
import { MenuType, UIDrawer } from "../UIDrawer";
import { ContextMenu } from "./ContextMenu";

let pulseChip: SubChipInstance;
let pulseWidth = 0;

const ID_PulseWidthInput = UIHandle("PulseChipEdit_PulseWidth");

// uint.TryParse
function TryParseUInt(s: string): number | null {
	if (!/^\s*\+?\d+\s*$/.test(s)) return null;
	const v = Number(s.trim());
	return v <= 0xffffffff ? v : null;
}

export const PulseEditMenu = {
	DrawMenu() {
		MenuHelper.DrawBackgroundOverlay();
		const panelID = UI.ReservePanel();
		const theme = ActiveUITheme;

		const pos = UI.Centre.add(Vector2.up.mul(UI.HalfHeight * 0.25));

		const scope = UI.BeginBoundsScope(true);
		try {
			UI.DrawText("Pulse Width (ticks)", theme.FontBold, theme.FontSizeRegular, pos, Anchor.TextCentre, Color.white.mul(0.8));

			const inputFieldTheme: InputFieldTheme = { ...ActiveUITheme.ChipNameInputField };
			inputFieldTheme.fontSize = ActiveUITheme.FontSizeRegular;

			const size = new Vector2(5.6, SelectorWheelHeight);
			const inputPos = UI.PrevBounds.CentreBottom.add(Vector2.down.mul(VerticalButtonSpacing));
			const state = UI.InputField(ID_PulseWidthInput, inputFieldTheme, inputPos, size, "", Anchor.CentreTop, 1, PulseEditMenu.ValidatePulseWidthInput, true);
			pulseWidth = TryParseUInt(state.text) ?? 0;

			const result = MenuHelper.DrawCancelConfirmButtons(UI.GetCurrentBoundsScope().BottomLeft, UI.GetCurrentBoundsScope().Width, true);
			MenuHelper.DrawReservedMenuPanel(panelID, UI.GetCurrentBoundsScope());

			if (result === CancelConfirmResult.Cancel) {
				UIDrawer.SetActiveMenu(MenuType.None);
			} else if (result === CancelConfirmResult.Confirm) {
				Project.ActiveProject.NotifyPulseWidthChanged(pulseChip, pulseWidth);
				UIDrawer.SetActiveMenu(MenuType.None);
			}
		} finally {
			scope.Dispose();
		}
	},

	OnMenuOpened() {
		pulseChip = ContextMenu.interactionContext as SubChipInstance;
		pulseWidth = pulseChip.InternalData[0];
		UI.GetInputFieldState(ID_PulseWidthInput).SetText(pulseWidth.toString());
	},

	ValidatePulseWidthInput(s: string): boolean {
		if (s.length > 4) return false;
		if (!s) return true;
		if (s.includes(" ")) return false;
		return /^[+-]?\d+$/.test(s);
	},
};

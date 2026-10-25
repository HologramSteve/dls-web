// Port of DLS.Graphics.RebindKeyChipMenu
import { InputHelper } from "../../../../seb/helpers/InputHelper";
import { Color } from "../../../../seb/types/Color";
import { Vector2 } from "../../../../seb/types/Vector2";
import { Anchor } from "../../../../seb/vis/Anchor";
import { UI } from "../../../../seb/vis/ui/UI";
import type { SubChipInstance } from "../../../game/elements/SubChipInstance";
import { Project } from "../../../game/Project";
import { ActiveUITheme } from "../../DrawSettings";
import { CancelConfirmResult, MenuHelper } from "../MenuHelper";
import { MenuType, UIDrawer } from "../UIDrawer";
import { ContextMenu } from "./ContextMenu";

const allowedChars = "1234567890QWERTYUIOPASDFGHJKLZXCVBNM";
let keyChip: SubChipInstance;
let chosenKey = "";

export const RebindKeyChipMenu = {
	allowedChars,

	DrawMenu() {
		MenuHelper.DrawBackgroundOverlay();
		const panelID = UI.ReservePanel();
		const theme = ActiveUITheme;

		const pos = UI.Centre.add(Vector2.up.mul(UI.HalfHeight * 0.25));

		const scope = UI.BeginBoundsScope(true);
		try {
			if (InputHelper.AnyKeyOrMouseDownThisFrame && InputHelper.InputStringThisFrame) {
				const activeChar = InputHelper.InputStringThisFrame[0].toUpperCase();
				if (allowedChars.includes(activeChar)) chosenKey = activeChar;
			}

			UI.DrawText("Press a key to rebind\n (alphanumeric only)", theme.FontBold, theme.FontSizeRegular, pos, Anchor.TextCentre, Color.white.mul(0.8));

			UI.DrawPanel(UI.PrevBounds.CentreBottom.add(Vector2.down), Vector2.one.mul(3.5), new Color(0.1, 0.1, 0.1), Anchor.CentreTop);
			UI.DrawText(chosenKey, theme.FontBold, theme.FontSizeRegular * 1.5, UI.PrevBounds.Centre, Anchor.TextCentre, Color.white);

			const result = MenuHelper.DrawCancelConfirmButtons(UI.GetCurrentBoundsScope().BottomLeft, UI.GetCurrentBoundsScope().Width, true);
			MenuHelper.DrawReservedMenuPanel(panelID, UI.GetCurrentBoundsScope());

			if (result === CancelConfirmResult.Cancel) {
				UIDrawer.SetActiveMenu(MenuType.None);
			} else if (result === CancelConfirmResult.Confirm) {
				Project.ActiveProject.NotifyKeyChipBindingChanged(keyChip, chosenKey[0]);
				UIDrawer.SetActiveMenu(MenuType.None);
			}
		} finally {
			scope.Dispose();
		}
	},

	OnMenuOpened() {
		keyChip = ContextMenu.interactionContext as SubChipInstance;
		chosenKey = keyChip.activationKeyString;
	},
};

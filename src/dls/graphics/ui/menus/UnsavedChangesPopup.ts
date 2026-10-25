// Port of DLS.Graphics.UnsavedChangesPopup
import { MakeCol } from "../../../../seb/helpers/ColHelper";
import { Bounds2D } from "../../../../seb/types/Bounds2D";
import { Color } from "../../../../seb/types/Color";
import { Vector2 } from "../../../../seb/types/Vector2";
import { Anchor } from "../../../../seb/vis/Anchor";
import { UI } from "../../../../seb/vis/ui/UI";
import { ActiveUITheme } from "../../DrawSettings";
import { CancelConfirmResult, MenuHelper } from "../MenuHelper";
import { MenuType, UIDrawer } from "../UIDrawer";

let onClosedCallback: ((confirm: boolean) => void) | null = null; // false = cancel, true = continue

export const UnsavedChangesPopup = {
	DrawMenu() {
		MenuHelper.DrawBackgroundOverlay();

		const text = "The current chip has unsaved changes.\nAre you sure you want to continue?";
		const textCol = new Color(1, 0.4, 0.45);
		const textPos = UI.Centre.add(Vector2.up.mul(5));

		const scope = UI.BeginBoundsScope(true);
		try {
			const panelID = UI.ReservePanel();
			const textBGPanelID = UI.ReservePanel();
			UI.DrawText(text, ActiveUITheme.FontRegular, ActiveUITheme.FontSizeRegular, textPos, Anchor.TextCentre, textCol);
			UI.ModifyPanelBounds(textBGPanelID, Bounds2D.Grow(UI.PrevBounds, 1.5), MakeCol(0.11));

			const topLeft = UI.PrevBounds.BottomLeft.add(Vector2.down.mul(1));
			const button = MenuHelper.DrawCancelConfirmButtons(topLeft, UI.PrevBounds.Width, false);

			MenuHelper.DrawReservedMenuPanel(panelID, UI.GetCurrentBoundsScope());

			if (button === CancelConfirmResult.Cancel) {
				UIDrawer.SetActiveMenu(MenuType.None);
				onClosedCallback?.(false);
			} else if (button === CancelConfirmResult.Confirm) {
				UIDrawer.SetActiveMenu(MenuType.None);
				onClosedCallback?.(true);
			}
		} finally {
			scope.Dispose();
		}
	},

	OpenPopup(callback: (confirm: boolean) => void) {
		onClosedCallback = callback;
		UIDrawer.SetActiveMenu(MenuType.UnsavedChanges);
	},
};

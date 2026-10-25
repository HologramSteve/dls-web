// Port of DLS.Graphics.ViewedChipsBar
import { Color } from "../../../../seb/types/Color";
import { Vector2 } from "../../../../seb/types/Vector2";
import { Anchor } from "../../../../seb/vis/Anchor";
import { UI } from "../../../../seb/vis/ui/UI";
import { KeyboardShortcuts } from "../../../game/KeyboardShortcuts";
import type { Project } from "../../../game/Project";
import { ActiveUITheme, InfoBarHeight } from "../../DrawSettings";

const pad = 0.75;

export const ViewedChipsBar = {
	DrawViewedChipsBanner(project: Project, simPausedBannerIsActive: boolean) {
		let topLeft = UI.TopLeft;
		if (simPausedBannerIsActive) topLeft = topLeft.add(Vector2.down.mul(InfoBarHeight));

		UI.DrawPanel(topLeft, new Vector2(UI.Width, InfoBarHeight), ActiveUITheme.InfoBarCol, Anchor.TopLeft);

		const pos = new Vector2(pad, topLeft.y - InfoBarHeight / 2);
		UI.DrawText(project.viewedChipsString, ActiveUITheme.FontBold, ActiveUITheme.ButtonTheme.fontSize, pos, Anchor.TextCentreLeft, Color.white);

		// Back button
		const buttonSize = new Vector2(8, InfoBarHeight - pad);
		const buttonCentreRight = new Vector2(UI.Width - pad, pos.y);
		const backButtonPressed = UI.Button("Back", ActiveUITheme.ChipButton, buttonCentreRight, buttonSize, true, false, false, Anchor.CentreRight);

		if (backButtonPressed || KeyboardShortcuts.CancelShortcutTriggered) project.ReturnToPreviousViewedChip();
	},
};

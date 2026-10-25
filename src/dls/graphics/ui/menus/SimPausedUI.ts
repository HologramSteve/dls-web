// Port of DLS.Graphics.SimPausedUI
import { Color } from "../../../../seb/types/Color";
import { Vector2 } from "../../../../seb/types/Vector2";
import { Anchor } from "../../../../seb/vis/Anchor";
import { UI } from "../../../../seb/vis/ui/UI";
import { Project } from "../../../game/Project";
import { ActiveUITheme, InfoBarHeight } from "../../DrawSettings";
import { MenuHelper } from "../MenuHelper";

let stepCountPrev = 0;
let stepString = "";

export const SimPausedUI = {
	DrawPausedBanner() {
		UI.DrawPanel(UI.TopLeft, new Vector2(UI.Width, InfoBarHeight), ActiveUITheme.InfoBarCol, Anchor.TopLeft);
		const panelBounds = UI.PrevBounds;

		UI.DrawText("Simulation Paused <color=#886600ff>(press space to advance one step)", MenuHelper.Theme.FontBold, MenuHelper.Theme.FontSizeRegular, panelBounds.Centre, Anchor.TextCentre, Color.yellow);

		const counter = Project.ActiveProject.simPausedSingleStepCounter;
		if (stepCountPrev !== counter || !stepString) {
			stepCountPrev = counter;
			stepString = counter + "";
		}

		const frameLabelPos = panelBounds.CentreRight.add(Vector2.left.mul(1));
		UI.DrawText(stepString, ActiveUITheme.FontBold, ActiveUITheme.FontSizeRegular, frameLabelPos, Anchor.TextCentreRight, Color.white.mul(0.8));
	},
};

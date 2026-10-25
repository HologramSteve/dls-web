// Port of DLS.Graphics.WorldDrawer
import type { Color } from "../../seb/types/Color";
import { Vector2 } from "../../seb/types/Vector2";
import { Draw } from "../../seb/vis/Draw";
import { KeyboardShortcuts } from "../game/KeyboardShortcuts";
import { Project } from "../game/Project";
import { CustomizationSceneDrawer } from "./CustomizationSceneDrawer";
import { DevSceneDrawer } from "./DevSceneDrawer";
import { MenuType, UIDrawer } from "./ui/UIDrawer";

export const WorldDrawer = {
	DrawWorld(_project: Project) {
		Draw.StartLayer(Vector2.zero, 1, false);

		if (UIDrawer.ActiveMenu === MenuType.ChipCustomization) CustomizationSceneDrawer.DrawCustomizationScene();
		else DevSceneDrawer.DrawActiveScene();
	},

	DrawGridIfActive(col: Color) {
		const isSnapping = KeyboardShortcuts.SnapModeHeld && Project.ActiveProject.controller.IsPlacingOrMovingElementOrCreatingWire;

		if (Project.ActiveProject.ShowGrid || isSnapping) DevSceneDrawer.DrawGrid(col);
	},

	Reset() {
		CustomizationSceneDrawer.Reset();
	},
};

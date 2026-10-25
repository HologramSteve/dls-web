// Port of DLS.Graphics.MenuHelper
import { MakeCol } from "../../../seb/helpers/ColHelper";
import { Bounds2D } from "../../../seb/types/Bounds2D";
import { Color } from "../../../seb/types/Color";
import { Vector2 } from "../../../seb/types/Vector2";
import { Anchor } from "../../../seb/vis/Anchor";
import type { DrawID } from "../../../seb/vis/Draw";
import { UI } from "../../../seb/vis/ui/UI";
import type { InputFieldState } from "../../../seb/vis/ui/UIStates";
import type { InputFieldTheme, UIHandle } from "../../../seb/vis/ui/UITheme";
import { KeyboardShortcuts } from "../../game/KeyboardShortcuts";
import { ActiveUITheme, ButtonHeight, DefaultButtonSpacing, PanelUIPadding, type UIThemeDLS } from "../DrawSettings";

export enum CancelConfirmResult {
	None,
	Cancel,
	Confirm,
}

const CancelConfirmButtonNames = ["CANCEL", "CONFIRM"];
const CancelConfirmInteractableState = [true, true];

export const MenuHelper = {
	get Theme(): UIThemeDLS {
		return ActiveUITheme;
	},

	DrawLabelSectionOfLabelInputPair(topLeft: Vector2, size: Vector2, label: string, labelCol: Color, drawBackground: boolean): Vector2 {
		const pad = 1;
		if (drawBackground) UI.DrawPanel(topLeft, size, Color.red.mul(0.1), Anchor.TopLeft);
		const centreLeft = topLeft.add(Vector2.down.mul(size.y / 2));
		UI.DrawText(label, MenuHelper.Theme.FontRegular, MenuHelper.Theme.FontSizeRegular, centreLeft.add(Vector2.right.mul(pad)), Anchor.TextCentreLeft, labelCol);
		return centreLeft.add(Vector2.right.mul(size.x));
	},

	LabeledOptionsWheel(label: string, labelCol: Color, topLeft: Vector2, size: Vector2, id: UIHandle, wheelOptions: string[], wheelWidth: number, drawBackground = false): number {
		const centreRight = MenuHelper.DrawLabelSectionOfLabelInputPair(topLeft, size, label, labelCol, drawBackground);
		const wheelIndex = UI.WheelSelector(id, wheelOptions, centreRight, new Vector2(wheelWidth, size.y), MenuHelper.Theme.OptionsWheel, Anchor.CentreRight);
		UI.OverridePreviousBounds(Bounds2D.CreateFromTopLeftAndSize(topLeft, size));
		return wheelIndex;
	},

	LabeledInputField(label: string, labelCol: Color, topLeft: Vector2, size: Vector2, id: UIHandle, validation: ((s: string) => boolean) | null, inputFieldWidth: number, drawBackground = false): InputFieldState {
		const inputFieldTheme: InputFieldTheme = { ...MenuHelper.Theme.ChipNameInputField };
		inputFieldTheme.fontSize = MenuHelper.Theme.FontSizeRegular;

		const centreRight = MenuHelper.DrawLabelSectionOfLabelInputPair(topLeft, size, label, labelCol, drawBackground);
		const state = UI.InputField(id, inputFieldTheme, centreRight, new Vector2(inputFieldWidth, size.y), "", Anchor.CentreRight, 1, validation);
		UI.OverridePreviousBounds(Bounds2D.CreateFromTopLeftAndSize(topLeft, size));
		return state;
	},

	DrawText(text: string, pos: Vector2, anchor: Anchor, col: Color, bold = false) {
		const font = bold ? MenuHelper.Theme.FontBold : MenuHelper.Theme.FontRegular;
		UI.DrawText(text, font, MenuHelper.Theme.FontSizeRegular, pos, anchor, col);
	},

	DrawCentredTextWithBackground(text: string, pos: Vector2, size: Vector2, anchor: Anchor, col: Color, bgCol: Color, bold = false) {
		UI.DrawPanel(pos, size, bgCol, anchor);
		const bgBounds = UI.PrevBounds;
		MenuHelper.DrawText(text, bgBounds.Centre, Anchor.TextFirstLineCentre, col, bold);
		UI.OverridePreviousBounds(bgBounds);
	},

	DrawLeftAlignTextWithBackground(text: string, pos: Vector2, size: Vector2, anchor: Anchor, col: Color, bgCol: Color, bold = false, textPadX = 1) {
		UI.DrawPanel(pos, size, bgCol, anchor);
		const bgBounds = UI.PrevBounds;
		MenuHelper.DrawText(text, bgBounds.CentreLeft.add(Vector2.right.mul(textPadX)), Anchor.TextCentreLeft, col, bold);
		UI.OverridePreviousBounds(bgBounds);
	},

	DrawBackgroundOverlay() {
		UI.DrawFullscreenPanel(MenuHelper.Theme.MenuBackgroundOverlayCol);
	},

	DrawReservedMenuPanel(panelID: DrawID, contentBounds: Bounds2D, pad = true) {
		if (pad) contentBounds = Bounds2D.Grow(contentBounds, PanelUIPadding);
		UI.ModifyPanelBounds(panelID, contentBounds, MenuHelper.Theme.MenuPanelCol);

		const outlineCol = MakeCol(0.26);
		const outlineWidth = 0.05;

		UI.DrawLine(contentBounds.BottomLeft, contentBounds.TopLeft, outlineWidth, outlineCol);
		UI.DrawLine(contentBounds.TopLeft, contentBounds.TopRight, outlineWidth, outlineCol);
		UI.DrawLine(contentBounds.BottomRight, contentBounds.TopRight, outlineWidth, outlineCol);
		UI.DrawLine(contentBounds.BottomRight, contentBounds.BottomLeft, outlineWidth, outlineCol);
	},

	DrawButtonPair(nameA: string, nameB: string, topLeft: Vector2, width: number, addVerticalPadding: boolean, interactableA = true, interactableB = true, ignoreInputs = false): number {
		if (addVerticalPadding) topLeft = topLeft.add(Vector2.down.mul(DefaultButtonSpacing * 3));
		return UI.HorizontalButtonGroupSized([nameA, nameB], [interactableA, interactableB], MenuHelper.Theme.ButtonTheme, topLeft, new Vector2(width, ButtonHeight), DefaultButtonSpacing, 0, Anchor.TopLeft, false, ignoreInputs);
	},

	DrawButtonTriplet(nameA: string, nameB: string, nameC: string, topLeft: Vector2, width: number, addVerticalPadding: boolean, interactableA = true, interactableB = true, interactableC = true, ignoreInputs = false): number {
		if (addVerticalPadding) topLeft = topLeft.add(Vector2.down.mul(DefaultButtonSpacing * 3));
		return UI.HorizontalButtonGroupSized([nameA, nameB, nameC], [interactableA, interactableB, interactableC], MenuHelper.Theme.ButtonTheme, topLeft, new Vector2(width, ButtonHeight), DefaultButtonSpacing, 0, Anchor.TopLeft, false, ignoreInputs);
	},

	DrawCancelConfirmButtons(topLeft: Vector2, width: number, addVerticalPadding: boolean, useKeyboardShortcuts = true, canCancel = true, canConfirm = true): CancelConfirmResult {
		if (addVerticalPadding) topLeft = topLeft.add(Vector2.down.mul(DefaultButtonSpacing * 3));
		const CancelIndex = 0;
		const ConfirmIndex = 1;

		CancelConfirmInteractableState[CancelIndex] = canCancel;
		CancelConfirmInteractableState[ConfirmIndex] = canConfirm;
		let buttonIndex = UI.HorizontalButtonGroup(CancelConfirmButtonNames, CancelConfirmInteractableState, MenuHelper.Theme.ButtonTheme, topLeft, width, DefaultButtonSpacing, 0, Anchor.TopLeft);

		if (useKeyboardShortcuts) {
			if (canCancel && KeyboardShortcuts.CancelShortcutTriggered) buttonIndex = CancelIndex;
			if (canConfirm && KeyboardShortcuts.ConfirmShortcutTriggered) buttonIndex = ConfirmIndex;
		}

		if (buttonIndex === CancelIndex) return CancelConfirmResult.Cancel;
		if (buttonIndex === ConfirmIndex) return CancelConfirmResult.Confirm;
		return CancelConfirmResult.None;
	},
};

// Port of DLS.Graphics.ChipCustomizationMenu
import { Darken, TryParseHexCode } from "../../../../seb/helpers/ColHelper";
import { Color } from "../../../../seb/types/Color";
import { Vector2 } from "../../../../seb/types/Vector2";
import { Anchor } from "../../../../seb/vis/Anchor";
import { UI } from "../../../../seb/vis/ui/UI";
import { DefaultSpacing, type InputFieldTheme, UIHandle } from "../../../../seb/vis/ui/UITheme";
import { HasDisplay, type NameDisplayLocation, SubChipDescription } from "../../../description/Types";
import { SubChipInstance } from "../../../game/elements/SubChipInstance";
import { Project } from "../../../game/Project";
import { CustomizationSceneDrawer } from "../../CustomizationSceneDrawer";
import { ActiveUITheme, ButtonHeight } from "../../DrawSettings";
import { MenuHelper } from "../MenuHelper";
import { MenuType, UIDrawer } from "../UIDrawer";
import { ChipSaveMenu } from "./ChipSaveMenu";

const nameDisplayOptions = ["Name: Middle", "Name: Top", "Name: Hidden"];

// ---- State ----
let subChipsWithDisplays: SubChipInstance[] = [];
let displayLabelString = "";
let colHexCodeString = "";

const ID_DisplaysScrollView = UIHandle("CustomizeMenu_DisplaysScroll");
const ID_ColourPicker = UIHandle("CustomizeMenu_ChipCol");
const ID_ColourHexInput = UIHandle("CustomizeMenu_ChipColHexInput");
const ID_NameDisplayOptions = UIHandle("CustomizeMenu_NameDisplayOptions");

// Unity Color == (approximate)
function ColApproxEq(a: Color, b: Color): boolean {
	const dr = a.r - b.r;
	const dg = a.g - b.g;
	const db = a.b - b.b;
	const da = a.a - b.a;
	return dr * dr + dg * dg + db * db + da * da < 9.99999944e-11;
}

export const ChipCustomizationMenu = {
	OnMenuOpened() {
		const chip = Project.ActiveProject.ViewedChip;
		subChipsWithDisplays = chip
			.GetSubchips()
			.filter((c) => HasDisplay(c.Description))
			.sort((a, b) => a.Position.x - b.Position.x || a.Position.y - b.Position.y);
		CustomizationSceneDrawer.OnCustomizationMenuOpened();
		displayLabelString = `DISPLAYS (${subChipsWithDisplays.length}):`;

		InitUIFromChipDescription();
	},

	DrawMenu() {
		// Don't draw menu when placing display
		if (CustomizationSceneDrawer.IsPlacingDisplay) return;

		const width = 20;
		const pad = DefaultSpacing;
		const pw = width - pad * 2;

		const NextPos = (extraPadding = 0) => UI.PrevBounds.BottomLeft.add(Vector2.down.mul(pad + extraPadding));

		const theme = ActiveUITheme;
		UI.DrawPanel(UI.TopLeft, new Vector2(width, UI.Height), theme.MenuPanelCol, Anchor.TopLeft);

		// ---- Cancel/confirm buttons ----
		const cancelConfirmButtonIndex = MenuHelper.DrawButtonPair("CANCEL", "CONFIRM", UI.TopLeft.add(Vector2.down.mul(pad)), pw, false);

		// ---- Chip name UI ----
		const nameDisplayMode = UI.WheelSelector(ID_NameDisplayOptions, nameDisplayOptions, NextPos(), new Vector2(pw, ButtonHeight), theme.OptionsWheel, Anchor.TopLeft);
		ChipSaveMenu.ActiveCustomizeDescription.NameLocation = nameDisplayMode as NameDisplayLocation;

		// ---- Chip colour UI ----
		const newCol = UI.DrawColourPicker(ID_ColourPicker, NextPos(), pw, Anchor.TopLeft);
		const inputTheme: InputFieldTheme = { ...MenuHelper.Theme.ChipNameInputField };
		inputTheme.fontSize = MenuHelper.Theme.FontSizeRegular;

		const hexColInput = UI.InputField(ID_ColourHexInput, inputTheme, NextPos(), new Vector2(pw, ButtonHeight), "#", Anchor.TopLeft, 1, ValidateHexStringInput);

		if (!ColApproxEq(newCol, ChipSaveMenu.ActiveCustomizeDescription.Colour)) {
			ChipSaveMenu.ActiveCustomizeDescription.Colour = newCol;
			UpdateChipColHexStringFromColour(newCol);
		} else if (colHexCodeString !== hexColInput.text) {
			UpdateChipColFromHexString(hexColInput.text);
		}

		// ---- Displays UI ----
		const labelCol = Darken(theme.MenuPanelCol, 0.01);
		const labelPos = NextPos(1);
		UI.TextWithBackground(labelPos, new Vector2(pw, ButtonHeight), Anchor.TopLeft, displayLabelString, theme.FontBold, theme.FontSizeRegular, Color.white, labelCol);

		const scrollViewHeight = 20;
		const scrollViewSpacing = DefaultSpacing;
		UI.DrawScrollViewElements(ID_DisplaysScrollView, NextPos(), new Vector2(pw, scrollViewHeight), scrollViewSpacing, Anchor.TopLeft, theme.ScrollTheme, DrawDisplayScroll, subChipsWithDisplays.length);

		// Cancel
		if (cancelConfirmButtonIndex === 0) {
			RevertChanges();
			UIDrawer.SetActiveMenu(MenuType.ChipSave);
		}
		// Confirm
		else if (cancelConfirmButtonIndex === 1) {
			UpdateCustomizeDescription();
			UIDrawer.SetActiveMenu(MenuType.ChipSave);
		}
	},
};

function DrawDisplayScroll(pos: Vector2, width: number, i: number, _isLayoutPass: boolean) {
	const theme = ActiveUITheme;

	const subChip = subChipsWithDisplays[i];
	const chipDesc = subChip.Description;
	const label = subChip.Label;
	const displayName = !label || !label.trim() ? chipDesc.Name : label;

	// Don't allow adding same display multiple times
	const selected = CustomizationSceneDrawer.SelectedDisplay;
	let enabled = selected == null || subChip.ID !== selected.Desc.SubChipID; // display is removed from list when selected, so check manually here
	for (const d of ChipSaveMenu.ActiveCustomizeChip!.Displays) {
		if (d.Desc.SubChipID === subChip.ID) {
			enabled = false;
			break;
		}
	}

	// Display selected, start placement
	if (UI.Button(displayName, theme.ButtonTheme, pos, new Vector2(width, 0), enabled, false, true, Anchor.TopLeft)) {
		const subChipDesc = SubChipDescription(chipDesc.Name, subChip.ID, "", Vector2.zero, null);
		const instance = new SubChipInstance(chipDesc, subChipDesc);
		CustomizationSceneDrawer.StartPlacingDisplay(instance);
	}
}

function RevertChanges() {
	ChipSaveMenu.RevertCustomizationStateToBeforeEnteringCustomizeMenu();
	InitUIFromChipDescription();
}

function InitUIFromChipDescription() {
	// Init col picker to chip colour
	const chipColourPickerState = UI.GetColourPickerState(ID_ColourPicker);
	[chipColourPickerState.hue, chipColourPickerState.sat, chipColourPickerState.val] = Color.RGBToHSV(ChipSaveMenu.ActiveCustomizeDescription.Colour);
	UpdateChipColHexStringFromColour(chipColourPickerState.GetRGB());

	// Init name display mode
	UI.GetWheelSelectorState(ID_NameDisplayOptions).index = ChipSaveMenu.ActiveCustomizeDescription.NameLocation;
}

function UpdateCustomizeDescription() {
	const displays = ChipSaveMenu.ActiveCustomizeChip!.Displays;
	ChipSaveMenu.ActiveCustomizeDescription.Displays = displays.map((s) => s.Desc);
}

function UpdateChipColHexStringFromColour(col: Color) {
	const toByte = (v: number) => Math.trunc(v * 255) & 0xff;
	const colInt = (toByte(col.r) << 16) | (toByte(col.g) << 8) | toByte(col.b);
	colHexCodeString = "#" + colInt.toString(16).toUpperCase().padStart(6, "0");
	UI.GetInputFieldState(ID_ColourHexInput).SetText(colHexCodeString, false);
}

function UpdateChipColFromHexString(hexString: string) {
	colHexCodeString = hexString;
	hexString = hexString.replaceAll("#", "");
	hexString = hexString.padEnd(6, "0");

	const { success, col } = TryParseHexCode(hexString);
	if (success) {
		UI.GetColourPickerState(ID_ColourPicker).SetRGB(col);
		ChipSaveMenu.ActiveCustomizeDescription.Colour = col;
	}
}

function ValidateHexStringInput(text: string): boolean {
	if (!text || !text.trim()) return true;

	let numHexDigits = 0;
	for (let i = 0; i < text.length; i++) {
		if (i === 0 && text[i] === "#") continue;
		if (/[0-9a-fA-F]/.test(text[i])) numHexDigits++;
		else return false;
	}

	return numHexDigits <= 6;
}

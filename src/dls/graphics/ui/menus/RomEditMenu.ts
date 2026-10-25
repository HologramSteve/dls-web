// Port of DLS.Graphics.RomEditMenu
import { MakeCol } from "../../../../seb/helpers/ColHelper";
import { InputHelper, KeyCode } from "../../../../seb/helpers/InputHelper";
import { Maths } from "../../../../seb/helpers/Maths";
import { SplitByLine } from "../../../../seb/helpers/StringHelper";
import { Bounds2D } from "../../../../seb/types/Bounds2D";
import { Color } from "../../../../seb/types/Color";
import { Vector2 } from "../../../../seb/types/Vector2";
import { Anchor } from "../../../../seb/vis/Anchor";
import { UI } from "../../../../seb/vis/ui/UI";
import { type InputFieldTheme, UIHandle } from "../../../../seb/vis/ui/UITheme";
import type { SubChipInstance } from "../../../game/elements/SubChipInstance";
import { KeyboardShortcuts } from "../../../game/KeyboardShortcuts";
import { Project } from "../../../game/Project";
import { ActiveUITheme, SelectorWheelHeight } from "../../DrawSettings";
import { CancelConfirmResult, MenuHelper } from "../MenuHelper";
import { MenuType, UIDrawer } from "../UIDrawer";
import { ContextMenu } from "./ContextMenu";

enum DataDisplayMode {
	DecimalUnsigned,
	DecimalSigned,
	Binary,
	HEX,
}

let ActiveRomDataBitCount = 16;
let RowCount = 0;

let ID_scrollbar: UIHandle = "";
let ID_DataDisplayMode: UIHandle = "";
let focusedRowIndex = 0;
let IDS_inputRow: UIHandle[] = [];
let rowNumberStrings: string[] = [];

let romChip: SubChipInstance;

const DataDisplayOptions = ["Unsigned Decimal", "Signed Decimal", "Binary", "HEX"];
const allDisplayModes = [DataDisplayMode.DecimalUnsigned, DataDisplayMode.DecimalSigned, DataDisplayMode.Binary, DataDisplayMode.HEX];

let dataDisplayMode = DataDisplayMode.DecimalUnsigned;
let scrollViewBounds = Bounds2D.zero;

const textPad = 0.52;
const height = 2.5;

export const RomEditMenu = {
	DrawMenu() {
		MenuHelper.DrawBackgroundOverlay();

		// ---- Draw ROM contents ----
		scrollViewBounds = Bounds2D.CreateFromCentreAndSize(UI.Centre, new Vector2(UI.Width * 0.4, UI.Height * 0.8));

		const scrollTheme = ActiveUITheme.ScrollTheme;
		UI.DrawScrollViewElements(ID_scrollbar, scrollViewBounds.TopLeft, scrollViewBounds.Size, 0, Anchor.TopLeft, scrollTheme, DrawScrollEntry, RowCount);

		if (focusedRowIndex >= 0) {
			// Focus next/prev field with keyboard shortcuts
			const changeLine = KeyboardShortcuts.ConfirmShortcutTriggered || InputHelper.IsKeyDownThisFrame(KeyCode.Tab);

			if (changeLine) {
				const goPrevLine = InputHelper.ShiftIsHeld;
				const jumpToRowIndex = focusedRowIndex + (goPrevLine ? -1 : 1);

				if (jumpToRowIndex >= 0 && jumpToRowIndex < RowCount) {
					OnFieldLostFocus(focusedRowIndex);
					const nextFocusedRowIndex = focusedRowIndex + (goPrevLine ? -1 : 1);
					UI.GetInputFieldState(IDS_inputRow[nextFocusedRowIndex]).SetFocus(true);
					focusedRowIndex = nextFocusedRowIndex;
				}
			}
		}

		// --- Draw side panel with buttons ----
		const sidePanelSize = new Vector2(UI.Width * 0.2, UI.Height * 0.8);
		const sidePanelTopLeft = scrollViewBounds.TopRight.add(Vector2.right.mul(UI.Width * 0.05));
		const sidePanelID = UI.ReservePanel();

		const scope = UI.BeginBoundsScope(true);
		try {
			const buttonSpacing = 0.75;

			// Display mode
			const modeNew = UI.WheelSelector(ID_DataDisplayMode, DataDisplayOptions, sidePanelTopLeft, new Vector2(sidePanelSize.x, SelectorWheelHeight), MenuHelper.Theme.OptionsWheel, Anchor.TopLeft) as DataDisplayMode;
			let buttonTopleft = new Vector2(sidePanelTopLeft.x, UI.PrevBounds.Bottom - buttonSpacing);

			const copyPasteButtonIndex = MenuHelper.DrawButtonPair("COPY ALL", "PASTE ALL", buttonTopleft, sidePanelSize.x, false);
			buttonTopleft = UI.PrevBounds.BottomLeft.add(Vector2.down.mul(buttonSpacing));
			const clearAll = UI.Button("CLEAR ALL", MenuHelper.Theme.ButtonTheme, buttonTopleft, new Vector2(sidePanelSize.x, 0), true, false, true, Anchor.TopLeft);
			buttonTopleft = UI.PrevBounds.BottomLeft.add(Vector2.down.mul(buttonSpacing * 2));
			const result = MenuHelper.DrawCancelConfirmButtons(buttonTopleft, sidePanelSize.x, false, false);

			MenuHelper.DrawReservedMenuPanel(sidePanelID, UI.GetCurrentBoundsScope());

			// ---- Handle button inputs ----
			if (copyPasteButtonIndex === 0) CopyAll();
			else if (copyPasteButtonIndex === 1) PasteAll();
			else if (clearAll) ClearAll();

			if (result === CancelConfirmResult.Cancel || KeyboardShortcuts.CancelShortcutTriggered) {
				UIDrawer.SetActiveMenu(MenuType.None);
			} else if (result === CancelConfirmResult.Confirm) {
				SaveChangesToROM();
				UIDrawer.SetActiveMenu(MenuType.None);
			}

			if (dataDisplayMode !== modeNew) {
				ConvertDisplayData(dataDisplayMode, modeNew);
				dataDisplayMode = modeNew;
			}
		} finally {
			scope.Dispose();
		}

		// Web: Ctrl+V while not editing a row pastes all rows (the browser only exposes clipboard text via paste events)
		const pasted = InputHelper.GetClipboardContents();
		if (pendingPasteAll && pasted) {
			pendingPasteAll = false;
			ApplyPasteAll(pasted);
		}
	},

	OnMenuOpened() {
		romChip = ContextMenu.interactionContext as SubChipInstance;
		RowCount = romChip.InternalData.length;
		ActiveRomDataBitCount = 16;

		ID_DataDisplayMode = UIHandle("ROM_DataDisplayMode", romChip.ID);
		ID_scrollbar = UIHandle("ROM_EditScrollbar", romChip.ID);

		focusedRowIndex = 0;
		IDS_inputRow = new Array(RowCount);
		rowNumberStrings = new Array(RowCount);
		dataDisplayMode = UI.GetWheelSelectorState(ID_DataDisplayMode).index as DataDisplayMode;

		const lineNumberPadLength = RowCount.toString().length;

		for (let i = 0; i < IDS_inputRow.length; i++) {
			IDS_inputRow[i] = UIHandle("ROM_rowInputField", i);
			const state = UI.GetInputFieldState(IDS_inputRow[i]);

			const displayString = UIntToDisplayString(romChip.InternalData[i], dataDisplayMode, ActiveRomDataBitCount);
			state.SetText(displayString, i === focusedRowIndex);

			rowNumberStrings[i] = (i + ":").padStart(lineNumberPadLength + 1, "0");
		}
	},

	Reset() {},
};

function OnFieldLostFocus(rowIndex: number) {
	if (rowIndex < 0) return;

	const inputFieldOld = UI.GetInputFieldState(IDS_inputRow[rowIndex]);
	inputFieldOld.SetText(AutoFormatInputString(inputFieldOld.text), false);
}

function AutoFormatInputString(input: string): string {
	// Try to parse string in current format
	let [success, uintValue] = TryParseDisplayStringToUInt(input, dataDisplayMode, ActiveRomDataBitCount);
	if (!success) {
		// If failed to parse in current format, fall back to trying all possible formats
		// (for example, if player enters -1 in unsigned mode, we can recognize it as signed input and convert to unsigned automatically)
		for (const fallbackMode of allDisplayModes) {
			const [fallbackSuccess, fallbackUIntValue] = TryParseDisplayStringToUInt(input, fallbackMode, ActiveRomDataBitCount);
			if (fallbackSuccess) {
				uintValue = fallbackUIntValue;
				success = true;
				break;
			}
		}
	}

	return UIntToDisplayString(uintValue, dataDisplayMode, ActiveRomDataBitCount);
}

function CopyAll() {
	let s = "";
	for (let i = 0; i < IDS_inputRow.length; i++) s += UI.GetInputFieldState(IDS_inputRow[i]).text + "\n";
	InputHelper.CopyToClipboard(s);
}

let pendingPasteAll = false;

function PasteAll() {
	// Web: read the clipboard asynchronously (falls back to the next paste event if permission is denied)
	const clip = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
	if (clip?.readText) {
		clip.readText().then(ApplyPasteAll, () => {
			pendingPasteAll = true;
		});
	} else {
		pendingPasteAll = true;
	}
}

function ApplyPasteAll(text: string) {
	if (UIDrawer.ActiveMenu !== MenuType.RomEdit) return;
	const pasteStrings = SplitByLine(text);
	for (let i = 0; i < Math.min(IDS_inputRow.length, pasteStrings.length); i++) {
		const pasteString = AutoFormatInputString(pasteStrings[i]);
		const state = UI.GetInputFieldState(IDS_inputRow[i]);
		state.SetText(pasteString, state.focused);
	}
}

function ClearAll() {
	for (let i = 0; i < IDS_inputRow.length; i++) {
		const state = UI.GetInputFieldState(IDS_inputRow[i]);
		state.SetText("0", state.focused);
	}
}

function ConvertDisplayData(modeCurr: DataDisplayMode, modeNew: DataDisplayMode) {
	for (let i = 0; i < IDS_inputRow.length; i++) {
		const state = UI.GetInputFieldState(IDS_inputRow[i]);
		const [, uintValue] = TryParseDisplayStringToUInt(state.text, modeCurr, ActiveRomDataBitCount);
		state.SetText(UIntToDisplayString(uintValue, modeNew, ActiveRomDataBitCount), false);
	}
}

function ValidateInputString(text: string): boolean {
	if (!text) return true;
	if (text.length > 34) return false;

	for (const c of text) {
		if (c === " ") continue; //ignore white space

		// If in binary mode, only 0s or 1s allowed
		if (dataDisplayMode === DataDisplayMode.Binary && !(c === "0" || c === "1")) return false;

		if (c === "-") continue; // allow negative sign (even in unsigned field as we'll do automatic conversion)
		if (dataDisplayMode === DataDisplayMode.HEX && /[0-9a-fA-F]/.test(c)) continue;
		if (!/[0-9]/.test(c)) return false;
	}

	return true;
}

// Convert from uint to display string with given display mode
function UIntToDisplayString(raw: number, displayFormat: DataDisplayMode, bitCount: number): string {
	switch (displayFormat) {
		case DataDisplayMode.Binary:
			return (raw >>> 0).toString(2).padStart(bitCount, "0");
		case DataDisplayMode.DecimalSigned:
			return Maths.TwosComplement(raw, bitCount) + "";
		case DataDisplayMode.DecimalUnsigned:
			return raw + "";
		case DataDisplayMode.HEX:
			return (raw >>> 0).toString(16).toUpperCase().padStart(bitCount / 4, "0");
		default:
			throw new Error("Unsupported display format: " + displayFormat);
	}
}

const FormatError = () => new Error("Format");

// Convert string with given format to uint (throws like the .NET parse functions)
function DisplayStringToUInt(displayString: string, stringFormat: DataDisplayMode, bitCount: number): number {
	displayString = displayString.replaceAll(" ", "");

	switch (stringFormat) {
		case DataDisplayMode.Binary: {
			// Convert.ToUInt32(s, 2)
			if (!/^[01]{1,32}$/.test(displayString)) throw FormatError();
			return parseInt(displayString, 2) >>> 0;
		}
		case DataDisplayMode.DecimalSigned: {
			// int.Parse
			if (!/^[+-]?\d+$/.test(displayString)) throw FormatError();
			const signedValue = Number(displayString);
			if (signedValue > 2147483647 || signedValue < -2147483648) throw FormatError();
			const unsignedRange = 2 ** bitCount;
			// (uint) cast of the long result wraps
			return signedValue < 0 ? Number(BigInt.asUintN(32, BigInt(signedValue + unsignedRange))) : signedValue;
		}
		case DataDisplayMode.DecimalUnsigned: {
			// uint.Parse
			if (!/^(\+?\d+|-0+)$/.test(displayString)) throw FormatError();
			const v = Number(displayString);
			if (v > 4294967295) throw FormatError();
			return Math.abs(v);
		}
		case DataDisplayMode.HEX: {
			// Convert.ToInt32(s, 16), then cast to uint
			const s = displayString.replace(/^0[xX]/, "");
			if (!/^[0-9a-fA-F]{1,8}$/.test(s)) throw FormatError();
			return parseInt(s, 16) >>> 0;
		}
		default:
			throw new Error("Unsupported display format: " + stringFormat);
	}
}

function TryParseDisplayStringToUInt(displayString: string, stringFormat: DataDisplayMode, bitCount: number): [boolean, number] {
	try {
		let raw = DisplayStringToUInt(displayString, stringFormat, bitCount);
		const maxVal = 2 ** bitCount - 1;

		// If value is too large to fit in given bit-count, clamp the result and return failure
		// (note: maybe makes more sense to wrap the result, but I think it's more obvious to player what happened if it just clamps)
		if (raw > maxVal) {
			raw = maxVal;
			return [false, raw];
		}

		return [true, raw];
	} catch {
		return [false, 0];
	}
}

function SaveChangesToROM() {
	for (let i = 0; i < RowCount; i++) {
		const displayString = UI.GetInputFieldState(IDS_inputRow[i]).text;
		const [, newValue] = TryParseDisplayStringToUInt(displayString, dataDisplayMode, ActiveRomDataBitCount);
		romChip.InternalData[i] = newValue;
	}

	Project.ActiveProject.NotifyRomContentsEdited(romChip);
}

function DrawScrollEntry(topLeft: Vector2, width: number, index: number, isLayoutPass: boolean) {
	const panelSize = new Vector2(width, height);
	const entryBounds = Bounds2D.CreateFromTopLeftAndSize(topLeft, panelSize);

	if (entryBounds.Overlaps(scrollViewBounds) && !isLayoutPass) {
		// don't bother with draw stuff if outside of scroll view / in layout pass
		const inputFieldID = IDS_inputRow[index];
		const inputFieldState = UI.GetInputFieldState(inputFieldID);

		// Alternating colour for each row
		let col = index % 2 === 0 ? MakeCol(0.17) : MakeCol(0.13);
		// Highlight row if it has focus
		if (inputFieldState.focused) {
			if (focusedRowIndex !== index) {
				OnFieldLostFocus(focusedRowIndex);
				focusedRowIndex = index;
			}

			col = new Color(0.33, 0.55, 0.34);
		}

		const inputTheme: InputFieldTheme = { ...MenuHelper.Theme.ChipNameInputField };
		inputTheme.fontSize = MenuHelper.Theme.FontSizeRegular;
		inputTheme.bgCol = col;
		inputTheme.focusBorderCol = Color.clear;

		UI.InputField(inputFieldID, inputTheme, topLeft, panelSize, "0", Anchor.TopLeft, 5, ValidateInputString);

		// Draw line index
		const lineNumCol = inputFieldState.focused ? new Color(0.53, 0.8, 0.57) : MakeCol(0.32);
		UI.DrawText(rowNumberStrings[index], MenuHelper.Theme.FontBold, MenuHelper.Theme.FontSizeRegular, entryBounds.CentreLeft.add(Vector2.right.mul(textPad)), Anchor.TextCentreLeft, lineNumCol);
	}

	// Set bounding box of scroll list element
	UI.OverridePreviousBounds(entryBounds);
}

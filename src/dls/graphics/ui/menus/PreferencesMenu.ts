// Port of DLS.Graphics.PreferencesMenu
import { Time } from "../../../../seb/helpers/Platform";
import { Color } from "../../../../seb/types/Color";
import { Mathf } from "../../../../seb/types/Mathf";
import { Vector2 } from "../../../../seb/types/Vector2";
import { Anchor } from "../../../../seb/vis/Anchor";
import { UI } from "../../../../seb/vis/ui/UI";
import { UIHandle } from "../../../../seb/vis/ui/UITheme";
import { copyProjectDescription, type ProjectDescription } from "../../../description/Types";
import { KeyboardShortcuts } from "../../../game/KeyboardShortcuts";
import { Project } from "../../../game/Project";
import { ActiveUITheme, SelectorWheelHeight } from "../../DrawSettings";
import { CancelConfirmResult, MenuHelper } from "../MenuHelper";
import { MenuType, UIDrawer } from "../UIDrawer";

const entrySpacing = 0.5;
const menuWidth = 55;
const verticalOffset = 22;

const DisplayMode_Always = 0;
const DisplayMode_OnHover = 1;
const DisplayMode_TabToggle = 2;

const PinDisplayOptions = ["Always", "On Hover", "Tab to Toggle"];
const GridDisplayOptions = ["Off", "On"];
const SnappingOptions = ["Hold Ctrl", "If Grid Shown", "Always"];
const StraightWireOptions = ["Hold Shift", "If Grid Shown", "Always"];
const SimulationStatusOptions = ["Active", "Paused"];

const entrySize = new Vector2(menuWidth, SelectorWheelHeight);
const settingFieldSize = new Vector2(entrySize.x / 3, entrySize.y);

// ---- State ----
const ID_MainPinNames = UIHandle("PREFS_MainPinNames");
const ID_ChipPinNames = UIHandle("PREFS_ChipPinNames");
const ID_GridDisplay = UIHandle("PREFS_GridDisplay");
const ID_Snapping = UIHandle("PREFS_Snapping");
const ID_StraightWires = UIHandle("PREFS_StraightWires");
const ID_SimStatus = UIHandle("PREFS_SimStatus");
const ID_SimFrequencyField = UIHandle("PREFS_SimTickTarget");
const ID_ClockSpeedInput = UIHandle("PREFS_ClockSpeed");

const CreateShortcutString = (s: string) => UI.CreateColouredText("  " + s, new Color(1, 1, 1, 0.3));
const showGridLabel = "Show grid" + CreateShortcutString("Ctrl+G");
const simStatusLabel = "Sim Status" + CreateShortcutString("Ctrl+Space");

let simAvgTicksPerSec_delayedRefreshForUI = 0;
let lastSimAvgTicksPerSecRefreshTime = 0;
let lastSimTickRateSetTime = 0;
let originalProjectDesc: ProjectDescription;
let currentSimSpeedString = "";
let currentSimSpeedStringColour = Color.white;

// int.TryParse (returns 0 on failure)
export function TryParseInt(s: string): [boolean, number] {
	if (!/^\s*[+-]?\d+\s*$/.test(s)) return [false, 0];
	const v = Number(s.trim());
	if (v > 2147483647 || v < -2147483648) return [false, 0];
	return [true, v];
}

export const PreferencesMenu = {
	DisplayMode_Always,
	DisplayMode_OnHover,
	DisplayMode_TabToggle,
	settingFieldSize,

	DrawMenu(project: Project) {
		const theme = ActiveUITheme;
		MenuHelper.DrawBackgroundOverlay();
		const panelID = UI.ReservePanel();
		UpdateSimSpeedString(project);

		const inputTextPad = 1;
		const headerSpacing = 1.5;
		const labelCol = Color.white;
		const headerCol = new Color(0.46, 1, 0.54);
		const topLeft = UI.Centre.add(new Vector2(-menuWidth / 2, verticalOffset));
		let labelPosCurr = topLeft;

		const AddSpacing = () => {
			labelPosCurr = labelPosCurr.withY(labelPosCurr.y - (entrySize.y + entrySpacing));
		};
		const AddHeaderSpacing = () => {
			labelPosCurr = labelPosCurr.withY(labelPosCurr.y - headerSpacing);
		};
		const DrawNextWheel = (label: string, options: string[], id: UIHandle): number => {
			const index = MenuHelper.LabeledOptionsWheel(label, labelCol, labelPosCurr, entrySize, id, options, settingFieldSize.x, true);
			AddSpacing();
			return index;
		};
		const DrawHeader = (text: string) => {
			AddHeaderSpacing();
			UI.DrawText(text, theme.FontBold, theme.FontSizeRegular, labelPosCurr, Anchor.TextCentreLeft, headerCol);
			AddHeaderSpacing();
		};

		const scope = UI.BeginBoundsScope(true);
		try {
			// ---- Draw settings ----
			DrawHeader("DISPLAY:");
			const mainPinNamesMode = DrawNextWheel("Show I/O pin names", PinDisplayOptions, ID_MainPinNames);
			const chipPinNamesMode = DrawNextWheel("Show chip pin names", PinDisplayOptions, ID_ChipPinNames);
			const gridDisplayMode = DrawNextWheel(showGridLabel, GridDisplayOptions, ID_GridDisplay);
			DrawHeader("EDITING:");
			const snappingMode = DrawNextWheel("Snap to grid", SnappingOptions, ID_Snapping);
			const straightWireMode = DrawNextWheel("Straight wires", StraightWireOptions, ID_StraightWires);

			DrawHeader("SIMULATION:");
			const pauseSim = MenuHelper.LabeledOptionsWheel(simStatusLabel, labelCol, labelPosCurr, entrySize, ID_SimStatus, SimulationStatusOptions, settingFieldSize.x, true) === 1;
			AddSpacing();
			const clockSpeedInputFieldState = MenuHelper.LabeledInputField("Steps per clock tick", labelCol, labelPosCurr, entrySize, ID_ClockSpeedInput, PreferencesMenu.ValidateIntegerInput, settingFieldSize.x, true);
			AddSpacing();
			const freqState = MenuHelper.LabeledInputField("Steps per second (target)", labelCol, labelPosCurr, entrySize, ID_SimFrequencyField, PreferencesMenu.ValidateIntegerInput, settingFieldSize.x, true);
			AddSpacing();
			// Draw current simulation speed
			const tickLabelRight = MenuHelper.DrawLabelSectionOfLabelInputPair(labelPosCurr, entrySize, "Steps per second (current)", labelCol.mul(0.75), true);
			UI.DrawPanel(tickLabelRight, settingFieldSize, new Color(0.18, 0.18, 0.18), Anchor.CentreRight);
			UI.DrawText(currentSimSpeedString, theme.FontBold, theme.FontSizeRegular, tickLabelRight.add(new Vector2(inputTextPad - settingFieldSize.x, 0)), Anchor.TextCentreLeft, currentSimSpeedStringColour);

			// Draw cancel/confirm buttons
			const buttonTopLeft = new Vector2(labelPosCurr.x, UI.PrevBounds.Bottom);
			const result = MenuHelper.DrawCancelConfirmButtons(buttonTopLeft, menuWidth, true);

			// Draw menu background
			const menuBounds = UI.GetCurrentBoundsScope();
			MenuHelper.DrawReservedMenuPanel(panelID, menuBounds);

			// ---- Handle changes ----
			const [, clockSpeed] = TryParseInt(clockSpeedInputFieldState.text);

			// Parse target sim tick rate
			let [, targetSimTicksPerSecond] = TryParseInt(freqState.text);
			targetSimTicksPerSecond = Math.max(1, targetSimTicksPerSecond);
			if (project.targetTicksPerSecond !== targetSimTicksPerSecond || project.simPaused !== pauseSim) lastSimTickRateSetTime = Time.time;

			// Assign changes immediately so can see them take effect in background
			project.description.Prefs_MainPinNamesDisplayMode = mainPinNamesMode;
			project.description.Prefs_ChipPinNamesDisplayMode = chipPinNamesMode;
			project.description.Prefs_GridDisplayMode = gridDisplayMode;
			project.description.Prefs_Snapping = snappingMode;
			project.description.Prefs_StraightWires = straightWireMode;
			project.description.Prefs_SimTargetStepsPerSecond = targetSimTicksPerSecond;
			project.description.Prefs_SimStepsPerClockTick = clockSpeed;
			project.description.Prefs_SimPaused = pauseSim;

			// Cancel / Confirm
			if (result === CancelConfirmResult.Cancel) {
				// Restore original description
				project.description = originalProjectDesc;
				UIDrawer.SetActiveMenu(MenuType.None);
			} else if (result === CancelConfirmResult.Confirm) {
				// Save changes
				project.UpdateAndSaveProjectDescription(project.description);
				UIDrawer.SetActiveMenu(MenuType.None);
			}
		} finally {
			scope.Dispose();
		}
	},

	OnMenuOpened() {
		// (ProjectDescription is a struct in the original: this is a copy)
		originalProjectDesc = copyProjectDescription(Project.ActiveProject.description);

		UpdateUIFromDescription();

		simAvgTicksPerSec_delayedRefreshForUI = Project.ActiveProject.simAvgTicksPerSec;
		lastSimAvgTicksPerSecRefreshTime = -Number.MAX_VALUE;
	},

	HandleKeyboardShortcuts() {
		const inPrefsMenu = UIDrawer.ActiveMenu === MenuType.Preferences;
		let anyChange = false;

		if (KeyboardShortcuts.ToggleGridShortcutTriggered) {
			Project.ActiveProject.ToggleGridDisplay();
			anyChange = true;
		}

		if (KeyboardShortcuts.SimPauseToggleShortcutTriggered) {
			Project.ActiveProject.description.Prefs_SimPaused = !Project.ActiveProject.description.Prefs_SimPaused;
			anyChange = true;
		}

		if (anyChange) {
			if (inPrefsMenu) UpdateUIFromDescription();
			else Project.ActiveProject.SaveCurrentProjectDescription();
		}
	},

	ValidateIntegerInput(s: string): boolean {
		if (!s) return true;
		if (s.includes(" ")) return false;
		return TryParseInt(s)[0];
	},

	GetSimFrequencyErrorCol(): Color {
		let frequencyErrorCol = new Color(0.3, 0.92, 0.32);

		if (Project.ActiveProject.simPaused) {
			frequencyErrorCol = new Color(1, 1, 1, 0.35);
		} else {
			const simFreqError = Mathf.RoundToInt(Project.ActiveProject.targetTicksPerSecond - Project.ActiveProject.simAvgTicksPerSec);
			if (simFreqError > 10) frequencyErrorCol = new Color(0.95, 0.25, 0.13);
			else if (simFreqError > 5) frequencyErrorCol = new Color(1, 0.38, 0.27);
			else if (simFreqError > 2) frequencyErrorCol = new Color(1, 0.7, 0.27);
		}

		return frequencyErrorCol;
	},
};

function UpdateUIFromDescription() {
	// No need to update if not in menu
	if (UIDrawer.ActiveMenu !== MenuType.Preferences) return;

	const projDesc = Project.ActiveProject.description;

	// -- Wheels
	UI.GetWheelSelectorState(ID_MainPinNames).index = projDesc.Prefs_MainPinNamesDisplayMode;
	UI.GetWheelSelectorState(ID_ChipPinNames).index = projDesc.Prefs_ChipPinNamesDisplayMode;
	UI.GetWheelSelectorState(ID_GridDisplay).index = projDesc.Prefs_GridDisplayMode;
	UI.GetWheelSelectorState(ID_Snapping).index = projDesc.Prefs_Snapping;
	UI.GetWheelSelectorState(ID_StraightWires).index = projDesc.Prefs_StraightWires;
	UI.GetWheelSelectorState(ID_SimStatus).index = projDesc.Prefs_SimPaused ? 1 : 0;
	// -- Input fields
	UI.GetInputFieldState(ID_SimFrequencyField).SetText(projDesc.Prefs_SimTargetStepsPerSecond + "", false);
	UI.GetInputFieldState(ID_ClockSpeedInput).SetText(projDesc.Prefs_SimStepsPerClockTick + "", false);
}

function UpdateSimSpeedString(project: Project) {
	// Annoying if sim tick rate value flickers too much, so use slower refresh rate for ui
	// (but if sim target rate has been recently changed, update fast so doesn't feel laggy)
	const slowModeSimUI = Time.time - lastSimTickRateSetTime > Project.SimulationPerformanceTimeWindowSec;
	const slowModeRefreshDelay = 0.35;
	const fastModeRefreshDelay = 0.05;
	const refreshDelay = slowModeSimUI ? slowModeRefreshDelay : fastModeRefreshDelay;

	if (Time.time > lastSimAvgTicksPerSecRefreshTime + refreshDelay || Project.ActiveProject.simPaused) {
		simAvgTicksPerSec_delayedRefreshForUI = project.simAvgTicksPerSec;
		lastSimAvgTicksPerSecRefreshTime = Time.time;
		currentSimSpeedString = project.simPaused ? "0" : Math.round(simAvgTicksPerSec_delayedRefreshForUI).toFixed(0);
		currentSimSpeedStringColour = PreferencesMenu.GetSimFrequencyErrorCol();
	}
}

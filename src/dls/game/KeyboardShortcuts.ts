// Port of DLS.Game.KeyboardShortcuts
// Web note: Cmd (meta) counts as Ctrl. Browsers reserve some combos (e.g. Ctrl+N, Ctrl+Q, Ctrl+W in Chrome) and never deliver them.
import { InputHelper, KeyCode } from "../../seb/helpers/InputHelper";

const CtrlShortcutTriggered = (key: string) => InputHelper.IsKeyDownThisFrame(key) && InputHelper.CtrlIsHeld && !(InputHelper.AltIsHeld || InputHelper.ShiftIsHeld);
const CtrlShiftShortcutTriggered = (key: string) => InputHelper.IsKeyDownThisFrame(key) && InputHelper.CtrlIsHeld && InputHelper.ShiftIsHeld && !InputHelper.AltIsHeld;

export const KeyboardShortcuts = {
	// ---- Main Menu shortcuts
	get MainMenu_NewProjectShortcutTriggered() {
		return CtrlShortcutTriggered(KeyCode.N);
	},
	get MainMenu_OpenProjectShortcutTriggered() {
		return CtrlShortcutTriggered(KeyCode.O);
	},
	get MainMenu_SettingsShortcutTriggered() {
		return CtrlShortcutTriggered(KeyCode.S);
	},
	get MainMenu_QuitShortcutTriggered() {
		return CtrlShortcutTriggered(KeyCode.Q);
	},

	// ---- Bottom Bar Menu shortcuts ----
	get SaveShortcutTriggered() {
		return CtrlShortcutTriggered(KeyCode.S);
	},
	get LibraryShortcutTriggered() {
		return CtrlShortcutTriggered(KeyCode.L);
	},
	get PreferencesShortcutTriggered() {
		return CtrlShortcutTriggered(KeyCode.P);
	},
	get CreateNewChipShortcutTriggered() {
		return CtrlShortcutTriggered(KeyCode.N);
	},
	get QuitToMainMenuShortcutTriggered() {
		return CtrlShortcutTriggered(KeyCode.Q);
	},
	get SearchShortcutTriggered() {
		return CtrlShortcutTriggered(KeyCode.F);
	},

	// ---- Misc shortcuts ----
	get DuplicateShortcutTriggered() {
		return KeyboardShortcuts.MultiModeHeld && InputHelper.IsKeyDownThisFrame(KeyCode.D);
	},
	get ToggleGridShortcutTriggered() {
		return CtrlShortcutTriggered(KeyCode.G);
	},
	get ResetCameraShortcutTriggered() {
		return CtrlShortcutTriggered(KeyCode.R);
	},
	get UndoShortcutTriggered() {
		return CtrlShortcutTriggered(KeyCode.Z);
	},
	get RedoShortcutTriggered() {
		return CtrlShiftShortcutTriggered(KeyCode.Z);
	},

	// ---- Single key shortcuts ----
	get CancelShortcutTriggered() {
		return InputHelper.IsKeyDownThisFrame(KeyCode.Escape);
	},
	get ConfirmShortcutTriggered() {
		return InputHelper.IsKeyDownThisFrame(KeyCode.Return) || InputHelper.IsKeyDownThisFrame(KeyCode.KeypadEnter);
	},
	get DeleteShortcutTriggered() {
		return InputHelper.IsKeyDownThisFrame(KeyCode.Backspace) || InputHelper.IsKeyDownThisFrame(KeyCode.Delete);
	},
	get SimNextStepShortcutTriggered() {
		return InputHelper.IsKeyDownThisFrame(KeyCode.Space) && !InputHelper.CtrlIsHeld;
	},
	get SimPauseToggleShortcutTriggered() {
		return CtrlShortcutTriggered(KeyCode.Space);
	},

	// ---- Dev shortcuts ----
	get OpenSaveDataFolderShortcutTriggered() {
		return InputHelper.IsKeyDownThisFrame(KeyCode.O) && InputHelper.CtrlIsHeld && InputHelper.ShiftIsHeld && InputHelper.AltIsHeld;
	},

	// ---- Modifiers ----
	get SnapModeHeld() {
		return InputHelper.CtrlIsHeld;
	},

	// In "Multi-mode", placed chips will be duplicated once placed to allow placing again; selecting a chip will add it to the current selection; etc.
	get MultiModeHeld() {
		return InputHelper.AltIsHeld || InputHelper.ShiftIsHeld;
	},
	get StraightLineModeHeld() {
		return InputHelper.ShiftIsHeld;
	},
	get StraightLineModeTriggered() {
		return InputHelper.IsKeyDownThisFrame(KeyCode.LeftShift);
	},
	get CameraActionKeyHeld() {
		return InputHelper.AltIsHeld;
	},
	get TakeFirstFromCollectionModifierHeld() {
		return InputHelper.CtrlIsHeld || InputHelper.AltIsHeld || InputHelper.ShiftIsHeld;
	},
};

// Port of DLS.Graphics.ContextMenu
import { MakeCol } from "../../../../seb/helpers/ColHelper";
import { InputHelper, MouseButton } from "../../../../seb/helpers/InputHelper";
import { Color } from "../../../../seb/types/Color";
import { Vector2 } from "../../../../seb/types/Vector2";
import { Anchor } from "../../../../seb/vis/Anchor";
import { Draw } from "../../../../seb/vis/Draw";
import { UI } from "../../../../seb/vis/ui/UI";
import { cloneButtonTheme } from "../../../../seb/vis/ui/UITheme";
import { ChipTypeHelper } from "../../../description/ChipTypeHelper";
import { ChipType, PinColour } from "../../../description/Types";
import { DevPinInstance } from "../../../game/elements/DevPinInstance";
import { type IInteractable, IsMoveable } from "../../../game/elements/Interfaces";
import { PinInstance } from "../../../game/elements/PinInstance";
import { SubChipInstance } from "../../../game/elements/SubChipInstance";
import { WireInstance } from "../../../game/elements/WireInstance";
import { InteractionState } from "../../../game/InteractionState";
import { KeyboardShortcuts } from "../../../game/KeyboardShortcuts";
import { Project } from "../../../game/Project";
import { ActiveUITheme } from "../../DrawSettings";
import { MenuType, UIDrawer } from "../UIDrawer";
import { PinEditMenu } from "./PinEditMenu";
import { UnsavedChangesPopup } from "./UnsavedChangesPopup";

interface MenuEntry {
	readonly Text: string;
	readonly OnPress: (() => void) | null;
	readonly IsEnabled: (() => boolean) | null;
}

const MenuEntry = (text: string, onPress: (() => void) | null, isEnabled: (() => boolean) | null): MenuEntry => ({ Text: text, OnPress: onPress, IsEnabled: isEnabled });

const pad = 10;
const menuDividerString = "#--#";
let interactionContextName = "";
let bottomBarItemIsCollection = false;
let mouseOpenMenuPos = Vector2.zero;

let activeContextMenuEntries: MenuEntry[] = [];
const dividerMenuEntry = MenuEntry(menuDividerString, null, null);
let wasMouseOverMenu = false;
let contextMenuHeader = "";
let isOpen = false;
let interactionContext: IInteractable | null = null;

function Format(s: string): string {
	s = s[0].toUpperCase() + s.substring(1).toLowerCase();
	return s.padEnd(pad);
}

const pinColourValues = Object.values(PinColour).filter((v): v is PinColour => typeof v === "number");
const pinColEntries: MenuEntry[] = pinColourValues.map((col) => MenuEntry(Format(PinColour[col]), () => SetCol(col), CanSetCol));

const deleteEntry = MenuEntry(Format("DELETE"), Delete, CanDelete);
const openChipEntry = MenuEntry(Format("OPEN"), OpenChip, CanOpenChip);
const labelChipEntry = MenuEntry(Format("LABEL"), OpenChipLabelPopup, CanLabelChip);

const entries_customSubchip = [MenuEntry(Format("VIEW"), EnterViewMode, CanEnterViewMode), openChipEntry, labelChipEntry, deleteEntry];
const entries_builtinSubchip = [labelChipEntry, deleteEntry];
const entries_builtinLED = [...entries_builtinSubchip, dividerMenuEntry, ...pinColEntries];
const entries_builtinBus = [MenuEntry(Format("FLIP"), FlipBus, CanFlipBus), labelChipEntry, deleteEntry];
const entries_builtinKeySubchip = [MenuEntry(Format("REBIND"), OpenKeyBindMenu, CanEditCurrentChip), labelChipEntry, deleteEntry];
const entries_builtinRomSubchip = [MenuEntry(Format("EDIT"), OpenRomEditMenu, CanEditCurrentChip), labelChipEntry, deleteEntry];
const entries_builtinPulseChip = [MenuEntry(Format("EDIT"), OpenPulseEditMenu, CanEditCurrentChip), labelChipEntry, deleteEntry];
const entries_subChipOutput = pinColEntries;
const entries_inputDevPin = [MenuEntry(Format("EDIT"), OpenPinEditMenu, CanEditCurrentChip), MenuEntry(Format("DELETE"), Delete, CanDelete), dividerMenuEntry, ...pinColEntries];
const entries_outputDevPin = [entries_inputDevPin[0], entries_inputDevPin[1]];
const entries_wire = [MenuEntry(Format("EDIT"), EditWire, CanEditWire), MenuEntry(Format("DELETE"), Delete, CanDelete)];
const entries_bottomBarChip = [openChipEntry, MenuEntry(Format("UN-STAR"), UnstarBottomBarEntry, () => true)];
const entries_collectionPopupChip = [openChipEntry];
const entries_bottomBarCollection = [MenuEntry(Format("UN-STAR"), UnstarBottomBarEntry, () => true)];

export const ContextMenu = {
	get IsOpen(): boolean {
		return isOpen;
	},
	get interactionContext(): IInteractable | null {
		return interactionContext;
	},

	Update() {
		const inMenu = !(UIDrawer.ActiveMenu === MenuType.None || UIDrawer.ActiveMenu === MenuType.BottomBarMenuPopup || UIDrawer.ActiveMenu === MenuType.ChipCustomization);
		if (inMenu) {
			ContextMenu.CloseContextMenu();
		} else {
			HandleOpenMenuInput();

			// Draw
			if (isOpen) DrawContextMenu(activeContextMenuEntries);

			// Close menu input
			if (InputHelper.IsMouseDownThisFrame(MouseButton.Left) || KeyboardShortcuts.CancelShortcutTriggered) ContextMenu.CloseContextMenu();
		}
	},

	OpenBottomBarContextMenu(name: string, isCollection: boolean, isFromInsideCollection: boolean) {
		interactionContextName = name;
		bottomBarItemIsCollection = isCollection;
		interactionContext = null;
		SetContextMenuOpen(name);

		if (isCollection) activeContextMenuEntries = entries_bottomBarCollection;
		else activeContextMenuEntries = isFromInsideCollection ? entries_collectionPopupChip : entries_bottomBarChip;
	},

	EditWire,

	Reset() {
		ContextMenu.CloseContextMenu();
	},

	CloseContextMenu() {
		isOpen = false;
	},

	HasFocus(): boolean {
		return isOpen && wasMouseOverMenu;
	},

	UnstarBottomBarEntry,
};

function HandleOpenMenuInput() {
	// Open menu input
	if (InputHelper.IsMouseDownThisFrame(MouseButton.Right) && !KeyboardShortcuts.CameraActionKeyHeld && !InteractionState.MouseIsOverUI) {
		const inCustomizeMenu = UIDrawer.ActiveMenu === MenuType.ChipCustomization;
		const hoverElement = InteractionState.ElementUnderMouse;

		const openSubChipContextMenu = hoverElement instanceof SubChipInstance && !inCustomizeMenu;
		const openDevPinContextMenu = (hoverElement instanceof PinInstance && hoverElement.parent instanceof DevPinInstance) || hoverElement instanceof DevPinInstance;
		const openWireContextMenu = hoverElement instanceof WireInstance;
		const openSubchipOutputPinContextMenu = hoverElement instanceof PinInstance && hoverElement.parent instanceof SubChipInstance && hoverElement.IsSourcePin && !hoverElement.IsBusPin;

		if (openSubChipContextMenu || openDevPinContextMenu || openWireContextMenu || openSubchipOutputPinContextMenu) {
			interactionContextName = "";
			interactionContext = hoverElement;
			let headerName = "";

			if (openSubChipContextMenu) {
				const subChip = hoverElement as SubChipInstance;
				interactionContextName = subChip.Description.Name;

				if (subChip.ChipType === ChipType.Custom) {
					headerName = subChip.Description.Name;
					activeContextMenuEntries = entries_customSubchip;
				} else {
					// builtin type
					headerName = ChipTypeHelper.IsBusType(subChip.ChipType) ? "BUS" : subChip.Description.Name;
					if (subChip.ChipType === ChipType.Key) activeContextMenuEntries = entries_builtinKeySubchip;
					else if (ChipTypeHelper.IsRomType(subChip.ChipType)) activeContextMenuEntries = entries_builtinRomSubchip;
					else if (subChip.ChipType === ChipType.Pulse) activeContextMenuEntries = entries_builtinPulseChip;
					else if (ChipTypeHelper.IsBusType(subChip.ChipType)) activeContextMenuEntries = entries_builtinBus;
					else if (subChip.ChipType === ChipType.DisplayLED) activeContextMenuEntries = entries_builtinLED;
					else activeContextMenuEntries = entries_builtinSubchip;
				}

				Project.ActiveProject.controller.Select(subChip, false);
			} else if (openDevPinContextMenu) {
				if (interactionContext instanceof DevPinInstance) interactionContext = interactionContext.Pin;

				const activePin = interactionContext as PinInstance;
				headerName = CreatePinHeaderName(activePin.Name);
				interactionContextName = activePin.Name;
				Project.ActiveProject.controller.Select(activePin.parent, false);
				activeContextMenuEntries = activePin.IsSourcePin ? entries_inputDevPin : entries_outputDevPin;
			} else if (openWireContextMenu) {
				const wire = interactionContext as WireInstance;
				if (wire.IsBusWire) headerName = "BUS LINE";
				else headerName = CreateWireHeaderString(wire);

				activeContextMenuEntries = entries_wire;
			} else if (openSubchipOutputPinContextMenu) {
				const pinContext = interactionContext as PinInstance;
				headerName = CreatePinHeaderName(pinContext.Name);
				activeContextMenuEntries = entries_subChipOutput;
			}

			SetContextMenuOpen(headerName);
		} else {
			ContextMenu.CloseContextMenu();
		}
	}
}

function CreateWireHeaderString(wire: WireInstance): string {
	const pinName = wire.SourcePin.Name;
	if (!pinName || !pinName.trim()) return "WIRE";
	return "WIRE: " + pinName;
}

function CreatePinHeaderName(pinName: string): string {
	if (!pinName || !pinName.trim()) return "PIN";
	return "PIN: " + pinName;
}

function SetContextMenuOpen(header: string) {
	mouseOpenMenuPos = UI.ScreenToUISpace(InputHelper.MousePos);
	contextMenuHeader = header.padEnd(pad);
	isOpen = true;
}

function DrawContextMenu(menuEntries: MenuEntry[]) {
	Draw.StartLayer(Vector2.zero, 1, true);

	const textOffsetX = 0.45;
	const theme = ActiveUITheme.MenuPopupButtonTheme;
	const headerTheme = cloneButtonTheme(ActiveUITheme.MenuPopupButtonTheme);
	headerTheme.buttonCols.inactive = MakeCol(0.18);
	headerTheme.textCols.inactive = Color.white;

	let menuWidth = Draw.CalculateTextBoundsSize(menuEntries[0].Text, theme.fontSize, theme.font).x + 1;
	const menuWidthHeader = Draw.CalculateTextBoundsSize(contextMenuHeader, theme.fontSize, theme.font).x + 1;
	menuWidth = Math.max(menuWidth, menuWidthHeader);

	const panelID = UI.ReservePanel();
	const buttonSize = new Vector2(menuWidth, 2);

	let posX = mouseOpenMenuPos.x;
	let posY = mouseOpenMenuPos.y;
	if (posX + menuWidth > UI.Width) posX = UI.Width - menuWidth;

	const expandDown = posY >= UI.Height * 0.35;
	const dirY = expandDown ? -1 : 1;
	const anchor = expandDown ? Anchor.TopLeft : Anchor.BottomLeft;

	const DrawHeader = () => {
		UI.Button(contextMenuHeader, headerTheme, new Vector2(posX, posY), buttonSize, false, false, false, anchor, true, textOffsetX);
		posY += buttonSize.y * dirY;
	};

	const scope = UI.BeginBoundsScope(true);
	try {
		for (let i = 0; i < menuEntries.length; i++) {
			const index = expandDown ? i : menuEntries.length - i - 1;
			const entry = menuEntries[index];

			if (index === 0 && expandDown) DrawHeader();

			if (entry.Text === menuDividerString) {
				posY += 0.5 * dirY;
				UI.DrawPanel(new Vector2(posX, posY), new Vector2(menuWidth, 0.15), MakeCol(0.6), Anchor.CentreLeft);
				posY += 0.5 * dirY;
			} else {
				if (UI.Button(entry.Text, theme, new Vector2(posX, posY), buttonSize, entry.IsEnabled!(), false, false, anchor, true, textOffsetX)) {
					entry.OnPress!();
				}
				posY += buttonSize.y * dirY;
			}

			if (index === 0 && !expandDown) DrawHeader();
		}

		const bounds = UI.GetCurrentBoundsScope();
		const menuSize = new Vector2(menuWidth, bounds.Height);
		UI.ModifyPanel(panelID, bounds.Centre, menuSize.add(Vector2.one.mul(0.5)), MakeCol(0.91));
	} finally {
		scope.Dispose();
	}

	wasMouseOverMenu = UI.MouseInsideBounds(UI.PrevBounds);
}

function IsCustomChip(): boolean {
	return !Project.ActiveProject.chipLibrary.IsBuiltinChip(interactionContextName);
}
function CanEnterViewMode(): boolean {
	return IsCustomChip();
}
function CanLabelChip(): boolean {
	return Project.ActiveProject.CanEditViewedChip;
}
function EnterViewMode() {
	Project.ActiveProject.EnterViewMode(interactionContext as SubChipInstance);
}
function CanDelete(): boolean {
	return Project.ActiveProject.CanEditViewedChip;
}
function CanFlipBus(): boolean {
	return Project.ActiveProject.CanEditViewedChip;
}

function CanSetCol(): boolean {
	if (!Project.ActiveProject.CanEditViewedChip || UIDrawer.ActiveMenu === MenuType.ChipCustomization) return false;
	if (interactionContext instanceof PinInstance) return interactionContext.IsSourcePin;
	if (interactionContext instanceof SubChipInstance) return interactionContext.ChipType === ChipType.DisplayLED;
	return false;
}

function FlipBus() {
	(interactionContext as SubChipInstance).FlipBus();
}

function SetCol(col: PinColour) {
	if (interactionContext instanceof PinInstance) interactionContext.Colour = col;
	else if (interactionContext instanceof SubChipInstance) Project.ActiveProject.NotifyLEDColourChanged(interactionContext, col);
}

function OpenChipLabelPopup() {
	UIDrawer.SetActiveMenu(MenuType.ChipLabelPopup);
}

function EditWire() {
	Project.ActiveProject.controller.EnterWireEditMode(interactionContext as WireInstance);
}

function Delete() {
	if (IsMoveable(interactionContext)) Project.ActiveProject.controller.Delete(interactionContext);
	else if (interactionContext instanceof WireInstance) Project.ActiveProject.controller.DeleteWire(interactionContext);
	else if (interactionContext instanceof PinInstance) Project.ActiveProject.controller.Delete(interactionContext.parent);
}

function OpenKeyBindMenu() {
	UIDrawer.SetActiveMenu(MenuType.RebindKeyChip);
}
function OpenRomEditMenu() {
	UIDrawer.SetActiveMenu(MenuType.RomEdit);
}
function OpenPulseEditMenu() {
	UIDrawer.SetActiveMenu(MenuType.PulseEdit);
}
function CanEditCurrentChip(): boolean {
	return Project.ActiveProject.CanEditViewedChip;
}
function CanEditWire(): boolean {
	return CanEditCurrentChip();
}

function OpenPinEditMenu() {
	PinEditMenu.SetTargetPin((interactionContext as PinInstance).parent as DevPinInstance);
	UIDrawer.SetActiveMenu(MenuType.PinRename);
}

function OpenChip() {
	const project = Project.ActiveProject;
	const chipToOpenName = interactionContextName;

	const OpenChipIfConfirmed = (confirm: boolean) => {
		if (confirm) project.LoadDevChipOrCreateNewIfDoesntExist(chipToOpenName);
	};

	if (project.ActiveChipHasUnsavedChanges()) UnsavedChangesPopup.OpenPopup(OpenChipIfConfirmed);
	else OpenChipIfConfirmed(true);
}

function CanOpenChip(): boolean {
	return IsCustomChip() && CanEditCurrentChip();
}

function UnstarBottomBarEntry() {
	Project.ActiveProject.SetStarred(interactionContextName, false, bottomBarItemIsCollection, true);
}

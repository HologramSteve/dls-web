// Port of DLS.Graphics.CustomizationSceneDrawer
import { MakeCol, MakeCol255 } from "../../seb/helpers/ColHelper";
import { InputHelper, KeyCode, MouseButton } from "../../seb/helpers/InputHelper";
import { Maths } from "../../seb/helpers/Maths";
import type { Bounds2D } from "../../seb/types/Bounds2D";
import { Color } from "../../seb/types/Color";
import { Vector2, Vector2Int } from "../../seb/types/Vector2";
import { Draw } from "../../seb/vis/Draw";
import { PinInstance } from "../game/elements/PinInstance";
import { DisplayInstance, type SubChipInstance } from "../game/elements/SubChipInstance";
import { GridHelper } from "../game/GridHelper";
import { InteractionState } from "../game/InteractionState";
import { KeyboardShortcuts } from "../game/KeyboardShortcuts";
import { Project } from "../game/Project";
import { DevSceneDrawer } from "./DevSceneDrawer";
import { ChipOutlineWidth, GridSize } from "./DrawSettings";
import { ChipSaveMenu } from "./ui/menus/ChipSaveMenu";
import { WorldDrawer } from "./WorldDrawer";

enum DisplayInteractState {
	None,
	Moving,
	Placing,
	Scaling,
}

let selectedChipResizeDir = Vector2Int.zero;
let chipResizeMouseStartPos = Vector2.zero;
let chipResizeStartSize = Vector2.zero;

let displayInteractState = DisplayInteractState.None;
let DisplayUnderMouse: DisplayInstance | null = null;
let displayMoveMouseOffset = Vector2.zero;
let mouseDownPos = Vector2.zero;
let displayPosInitial = Vector2.zero;
let displayScaleInitial = 0;

const CustomizeChip = () => ChipSaveMenu.ActiveCustomizeChip!;

const Remove = <T>(list: T[], item: T) => {
	const i = list.indexOf(item);
	if (i >= 0) list.splice(i, 1);
};

export const CustomizationSceneDrawer = {
	SelectedDisplay: null as DisplayInstance | null,

	get IsPlacingDisplay(): boolean {
		return displayInteractState === DisplayInteractState.Placing;
	},

	DrawCustomizationScene() {
		const chip = ChipSaveMenu.ActiveCustomizeChip!;

		DevSceneDrawer.DrawSubChip(chip);
		WorldDrawer.DrawGridIfActive(MakeCol255(0, 0, 0, 100));

		Draw.StartLayer(Vector2.zero, 1, false);
		DevSceneDrawer.DrawSubchipDisplays(chip, null, true);

		const chipResizeHascontrol = HandleChipResizing(chip);
		HandleDisplaySelection(!chipResizeHascontrol);

		if (CustomizationSceneDrawer.SelectedDisplay == null) {
			if (DisplayUnderMouse != null) HandleDeleteDisplayUnderMouse();
		} else {
			if (displayInteractState === DisplayInteractState.Scaling) HandleDisplayScaling();
			else HandleDisplayMovement();
		}

		// Display highlighted pin name
		const highlightedPin = InteractionState.ElementUnderMouse;
		if (highlightedPin instanceof PinInstance) {
			Draw.StartLayer(Vector2.zero, 1, false);
			DevSceneDrawer.DrawPinLabel(highlightedPin);
		}
	},

	StartPlacingDisplay(subChipToDisplay: SubChipInstance) {
		const d = new DisplayInstance();
		d.Desc = { SubChipID: subChipToDisplay.ID, Position: Vector2.zero, Scale: 1 };
		d.ChildDisplays = subChipToDisplay.Displays;
		CustomizationSceneDrawer.SelectedDisplay = d;

		displayInteractState = DisplayInteractState.Placing;
		displayMoveMouseOffset = Vector2.zero;
	},

	OnCustomizationMenuClosed() {
		selectedChipResizeDir = Vector2Int.zero;
	},

	OnCustomizationMenuOpened() {},

	Reset() {
		CustomizationSceneDrawer.SelectedDisplay = null;
		displayInteractState = DisplayInteractState.None;
	},
};

function HandleDisplayScaling() {
	const selected = CustomizationSceneDrawer.SelectedDisplay!;
	Draw.StartLayer(Vector2.zero, 1, false);

	const scaleCol = new Color(0.4, 1, 0.2);
	let deltaScale = mouseDownPos.sub(InputHelper.MousePosWorld).magnitude;
	deltaScale *= Vector2.dot(InputHelper.MousePosWorld.sub(mouseDownPos).normalized, displayPosInitial.sub(mouseDownPos).normalized);
	const targetScale = Math.max(GridSize, displayScaleInitial - deltaScale);

	if (!Project.ActiveProject.ShouldSnapToGrid) selected.Desc.Scale = targetScale;

	const bounds = DevSceneDrawer.DrawDisplayWithBackground(selected, Vector2.zero, CustomizeChip());
	DrawDisplayBoundsIndicators(bounds, scaleCol);

	if (Project.ActiveProject.ShouldSnapToGrid) {
		const unscaledWidth = bounds.Width / selected.Desc.Scale;
		const scaledWidth = unscaledWidth * targetScale;

		const snappedWidth = GridHelper.SnapToGrid(scaledWidth);
		const snappedScale = snappedWidth / unscaledWidth;

		selected.Desc.Scale = snappedScale;
	}

	// Exit (confirm/cancel)
	const cancel = KeyboardShortcuts.CancelShortcutTriggered || InputHelper.IsMouseDownThisFrame(MouseButton.Right);

	if (cancel) {
		selected.Desc.Position = displayPosInitial;
		selected.Desc.Scale = displayScaleInitial;
		CustomizeChip().Displays.push(selected);
		CustomizationSceneDrawer.SelectedDisplay = null;
		displayInteractState = DisplayInteractState.None;
	} else {
		const confirm = InputHelper.IsMouseUpThisFrame(MouseButton.Left);

		if (confirm) {
			CustomizeChip().Displays.push(selected);
			CustomizationSceneDrawer.SelectedDisplay = null;
			displayInteractState = DisplayInteractState.None;
		}
	}
}

function HandleDisplayMovement() {
	const selected = CustomizationSceneDrawer.SelectedDisplay!;
	Draw.StartLayer(Vector2.zero, 1, false);
	const targetPos = InputHelper.MousePosWorld.add(displayMoveMouseOffset);

	if (!Project.ActiveProject.ShouldSnapToGrid) selected.Desc.Position = targetPos;

	const bounds = DevSceneDrawer.DrawDisplayWithBackground(selected, Vector2.zero, CustomizeChip());
	DrawDisplayBoundsIndicators(bounds, Color.white);

	if (Project.ActiveProject.ShouldSnapToGrid) {
		const snapPointOffset = bounds.TopLeft.sub(bounds.Centre);
		const snap = GridHelper.SnapMovingElementToGridPos(targetPos, snapPointOffset, true, true);
		selected.Desc.Position = snap;
	}

	const cancelMovement = KeyboardShortcuts.CancelShortcutTriggered || InputHelper.IsMouseDownThisFrame(MouseButton.Right);
	const del = InputHelper.IsKeyDownThisFrame(KeyCode.Backspace) || InputHelper.IsKeyDownThisFrame(KeyCode.Delete);

	if (cancelMovement || del) {
		selected.Desc.Position = displayPosInitial;
		if (!del && displayInteractState === DisplayInteractState.Moving) CustomizeChip().Displays.push(selected);
		CustomizationSceneDrawer.SelectedDisplay = null;
		displayInteractState = DisplayInteractState.None;
	} else {
		// Confirm placement
		let confirmPlacement = InputHelper.IsMouseDownThisFrame(MouseButton.Left);
		confirmPlacement ||= displayInteractState === DisplayInteractState.Moving && InputHelper.IsMouseUpThisFrame(MouseButton.Left);

		if (confirmPlacement) {
			CustomizeChip().Displays.push(selected);
			CustomizationSceneDrawer.SelectedDisplay = null;
			displayInteractState = DisplayInteractState.None;
		}
	}
}

function HandleDeleteDisplayUnderMouse() {
	const del = InputHelper.IsKeyDownThisFrame(KeyCode.Backspace) || InputHelper.IsKeyDownThisFrame(KeyCode.Delete);
	if (del) {
		Remove(CustomizeChip().Displays, DisplayUnderMouse!);
		DisplayUnderMouse = null;
	}
}

function HandleDisplaySelection(canSelect: boolean) {
	DisplayUnderMouse = null;
	if (!canSelect) return;

	const v = 0.85;
	const mouseOverIndicatorCol = new Color(v, v, v, 1);
	const mouseOverIndicatorScaleCol = new Color(1, 0.8, 0.2);

	for (const display of CustomizeChip().Displays) {
		const bounds = display.LastDrawBounds;
		const displayMinAxisSize = Math.min(bounds.Width, bounds.Height);

		if (displayInteractState === DisplayInteractState.None) {
			if (InputHelper.MouseInsideBounds_World(bounds)) {
				DisplayUnderMouse = display;

				const cornerDst = bounds.DstToCorner(InputHelper.MousePosWorld);
				const cornerDstThresholdForScaleMode = Math.min(displayMinAxisSize * 0.2, GridSize * 1.5);
				const enterScaleMode = cornerDst < cornerDstThresholdForScaleMode;

				if (enterScaleMode) DrawClosestCornerDisplayBoundsIndicator(bounds, InputHelper.MousePosWorld, mouseOverIndicatorScaleCol);
				else DrawDisplayBoundsIndicators(bounds, mouseOverIndicatorCol);

				if (InputHelper.IsMouseDownThisFrame(MouseButton.Left, true)) {
					displayInteractState = enterScaleMode ? DisplayInteractState.Scaling : DisplayInteractState.Moving;
					CustomizationSceneDrawer.SelectedDisplay = display;
					Remove(CustomizeChip().Displays, display); // remove from displays while moving (so can be drawn separately on top of everything else)
					displayMoveMouseOffset = display.Desc.Position.sub(InputHelper.MousePosWorld);
					displayPosInitial = display.Desc.Position;
					displayScaleInitial = display.Desc.Scale;
					mouseDownPos = InputHelper.MousePosWorld;
					return; // exit now that a display has been selected
				}
			}
		}
	}
}

function DrawDisplayBoundsIndicators(bounds: Bounds2D, col: Color) {
	DrawPlacementCornerIndicator(bounds.TopLeft, Vector2.right, Vector2.down, col);
	DrawPlacementCornerIndicator(bounds.TopRight, Vector2.left, Vector2.down, col);
	DrawPlacementCornerIndicator(bounds.BottomLeft, Vector2.right, Vector2.up, col);
	DrawPlacementCornerIndicator(bounds.BottomRight, Vector2.left, Vector2.up, col);
}

function DrawClosestCornerDisplayBoundsIndicator(bounds: Bounds2D, point: Vector2, col: Color) {
	const corners = [bounds.TopLeft, bounds.TopRight, bounds.BottomLeft, bounds.BottomRight];

	let cornerIndex = 0;
	for (let i = 1; i < corners.length; i++) {
		if (corners[i].sub(point).sqrMagnitude < corners[cornerIndex].sub(point).sqrMagnitude) cornerIndex = i;
	}

	const dirX = -((cornerIndex & 1) * 2 - 1);
	const dirY = cornerIndex <= 1 ? -1 : 1;
	DrawPlacementCornerIndicator(corners[cornerIndex], new Vector2(dirX, 0), new Vector2(0, dirY), col);
}

function DrawPlacementCornerIndicator(corner: Vector2, dirA: Vector2, dirB: Vector2, col: Color) {
	const pad = 0.0;
	const len = GridSize;
	const thick = 0.01;

	const origin = corner.sub(dirA.add(dirB).mul(pad));
	Draw.Line(origin, origin.add(dirA.mul(len)), thick, col);
	Draw.Line(origin, origin.add(dirB.mul(len)), thick, col);
}

function HandleChipResizing(chip: SubChipInstance): boolean {
	const pad = 0.25;
	const h = 1.1;
	const size = 0.12;
	const canInteract = displayInteractState === DisplayInteractState.None;

	const DrawScaleHandle = (edge: Vector2, dir: Vector2Int): boolean => {
		const dirVec = dir.toVector2();
		edge = edge.add(dirVec.mul(pad));
		const perp = new Vector2(-dirVec.y, dir.x);
		const a = edge.add(dirVec.mul(size));
		const b = edge.sub(dirVec.add(perp.mul(h)).mul(size));
		const c = edge.sub(dirVec.sub(perp.mul(h)).mul(size));

		const mouseOver = canInteract && Maths.TriangleContainsPoint(InputHelper.MousePosWorld, a, b, c);
		if (mouseOver && InputHelper.IsMouseDownThisFrame(MouseButton.Left)) {
			selectedChipResizeDir = dir;
			chipResizeMouseStartPos = InputHelper.MousePosWorld;
			chipResizeStartSize = chip.Size;
		}

		if (InputHelper.IsMouseUpThisFrame(MouseButton.Left)) selectedChipResizeDir = Vector2Int.zero;

		const selected = canInteract && selectedChipResizeDir.x === dir.x && selectedChipResizeDir.y === dir.y;
		let col = mouseOver ? MakeCol(0.7) : MakeCol(0.3);
		if (selected) {
			col = Color.white;
			const mouseDelta = InputHelper.MousePosWorld.sub(chipResizeMouseStartPos);
			let desiredSize = chipResizeStartSize.add(dirVec.scale(mouseDelta).mul(2));

			// Always snap chip height so that pins align with grid lines/centers
			const deltaY = GridHelper.SnapToGrid(desiredSize.y - chip.MinSize.y);
			desiredSize = desiredSize.withY(chip.MinSize.y + deltaY);
			// Snap chip width to grid lines if in snap mode
			if (Project.ActiveProject.ShouldSnapToGrid && dir.x !== 0) desiredSize = desiredSize.withX(GridHelper.SnapToGridForceEven(desiredSize.x) - ChipOutlineWidth);

			const sizeNew = Vector2.max(desiredSize, chip.MinSize);

			if (Vector2.neq(sizeNew, chip.Size)) {
				chip.Description.Size = Vector2.max(desiredSize, chip.MinSize);
				CustomizeChip().UpdatePinLayout();
			}
		}
		// Highlight opposite handle to selected handle
		else if (dir.x === -selectedChipResizeDir.x && dir.y === -selectedChipResizeDir.y) {
			col = Color.white;
		}

		Draw.Triangle(a, b, c, col);
		return mouseOver || selected;
	};

	let hascontrol = false;
	// Draw resize arrow handles on all sides of chip
	const sel = chip.SelectionBoundingBox;
	hascontrol = DrawScaleHandle(sel.CentreRight, Vector2Int.right) || hascontrol;
	hascontrol = DrawScaleHandle(sel.CentreLeft, Vector2Int.left) || hascontrol;
	hascontrol = DrawScaleHandle(sel.CentreTop, Vector2Int.up) || hascontrol;
	hascontrol = DrawScaleHandle(sel.CentreBottom, Vector2Int.down) || hascontrol;
	return hascontrol;
}

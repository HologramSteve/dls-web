// Port of DLS.Game.CameraController
import { InputHelper, MouseButton, WorldCam } from "../../seb/helpers/InputHelper";
import { Screen } from "../../seb/helpers/Platform";
import { Bounds2D } from "../../seb/types/Bounds2D";
import { Vector2 } from "../../seb/types/Vector2";
import { Draw } from "../../seb/vis/Draw";
import { UI } from "../../seb/vis/ui/UI";
import { ActiveTheme, GridSize, WireThickness } from "../graphics/DrawSettings";
import { BottomBarUI } from "../graphics/ui/menus/BottomBarUI";
import { ContextMenu } from "../graphics/ui/menus/ContextMenu";
import { MenuType, UIDrawer } from "../graphics/ui/UIDrawer";
import type { DevChipInstance } from "./DevChipInstance";
import { InteractionState } from "./InteractionState";
import { KeyboardShortcuts } from "./KeyboardShortcuts";
import { Project } from "./Project";

export const StartupOrthoSize = 5;

export class ViewState {
	OrthoSize = StartupOrthoSize;
	Pos = Vector2.zero;
}

const zoomSpeed = 1;
const zoomToMouse = true;
export const zoomRange = new Vector2(0.2, 64);
let isMovingCamera = false;
let isDragZoomingCamera = false;
let dragZoomMousePrev = Vector2.zero;
let mouseDragScreenPosOld = Vector2.zero;

let customizeView = new ViewState();
let mainMenuView = new ViewState();
let chipViewStateLookup = new Map<string, ViewState>();

const CanMove = () => UIDrawer.ActiveMenu === MenuType.None || UIDrawer.ActiveMenu === MenuType.BottomBarMenuPopup || UIDrawer.ActiveMenu === MenuType.ChipCustomization;
const CanZoom = CanMove;
const CanStartNewInput = () => !InteractionState.MouseIsOverUI;

export const CameraController = {
	StartupOrthoSize,
	zoomRange,
	activeView: new ViewState(),

	Reset() {
		chipViewStateLookup = new Map();
		customizeView = new ViewState();
		mainMenuView = new ViewState();
		CameraController.activeView = new ViewState();

		UpdateCameraState();
		Draw.SetClearColour(ActiveTheme.BackgroundCol);
	},

	Update() {
		const newActiveViewState = GetActiveViewState();
		if (CameraController.activeView !== newActiveViewState) {
			CameraController.activeView = newActiveViewState;
		} else {
			if (KeyboardShortcuts.ResetCameraShortcutTriggered) {
				chipViewStateLookup.delete(Project.ActiveProject.ViewedChip.ChipName);
			}

			const mouseScreenPos = InputHelper.MousePos;
			const mouseWorldPos = WorldCam.ScreenToWorldPoint(mouseScreenPos);

			HandlePanInput(mouseScreenPos, mouseWorldPos);
			HandleZoomInput(mouseScreenPos);
		}

		UpdateCameraState();
	},

	// Calculate view params to fit given chip into screen (or as much as possible within max zoom setting)
	GetViewForChip(viewedChip: DevChipInstance): ViewState {
		let bounds = Bounds2D.CreateEmpty();
		for (const element of viewedChip.Elements) bounds = Bounds2D.Grow(bounds, element.SelectionBoundingBox);

		for (const wire of viewedChip.Wires) {
			const wireWidth = wire.bitCount * WireThickness;
			for (let i = 1; i < wire.WirePointCount - 1; i++) {
				const a = wire.GetWirePoint(i);
				const b = wire.GetWirePoint(i + 1);
				const dir = b.sub(a).normalized;
				const perp = new Vector2(-dir.y, dir.x);
				bounds = Bounds2D.Grow(bounds, a.add(perp.mul(wireWidth / 2)));
				bounds = Bounds2D.Grow(bounds, a.sub(perp.mul(wireWidth / 2)));
			}
		}

		const view = new ViewState();
		if (Math.max(bounds.Size.x, bounds.Size.y) < GridSize) return view;

		// Set cam orthoSize to fit contents of chip on screen
		view.OrthoSize = Math.max(bounds.Height, (bounds.Width * 9) / 16) * 0.5;
		view.OrthoSize += view.OrthoSize * 0.1; // Padding
		view.OrthoSize = Math.min(Math.max(view.OrthoSize, zoomRange.x), zoomRange.y);

		// Move cam down slightly from bounds centre to account for bottom region of screen blocked by chip bar
		const uiScreenHeight = (UI.Width * 9) / 16;
		const bottomBarWorldHeight = (BottomBarUI.barHeight / uiScreenHeight) * view.OrthoSize * 2;
		view.Pos = bounds.Centre.add(Vector2.down.mul(bottomBarWorldHeight / 2));
		return view;
	},

	NotifyChipNameChanged(nameNew: string) {
		chipViewStateLookup.set(nameNew, CameraController.activeView);
	},
};

// Pan with middle-mouse drag or alt+left-mouse drag
function HandlePanInput(mouseScreenPos: Vector2, mouseWorldPos: Vector2) {
	if (CanMove()) {
		const altLeftMouseDown = KeyboardShortcuts.CameraActionKeyHeld && InputHelper.IsMouseDownThisFrame(MouseButton.Left);
		const middleMouseDown = InputHelper.IsMouseDownThisFrame(MouseButton.Middle);

		if ((altLeftMouseDown || middleMouseDown) && !isDragZoomingCamera) {
			mouseDragScreenPosOld = mouseScreenPos;
			isMovingCamera = CanStartNewInput();
			ContextMenu.CloseContextMenu();
		}

		if ((InputHelper.IsMouseHeld(MouseButton.Middle) || InputHelper.IsMouseHeld(MouseButton.Left)) && isMovingCamera) {
			const mouseWorldPosOld = WorldCam.ScreenToWorldPoint(mouseDragScreenPosOld);
			MovePosition(mouseWorldPosOld.sub(mouseWorldPos));
			mouseDragScreenPosOld = mouseScreenPos;
		}
	}

	// Release
	if (InputHelper.IsMouseUpThisFrame(MouseButton.Middle) || InputHelper.IsMouseUpThisFrame(MouseButton.Left)) {
		isMovingCamera = false;
	}
}

// Zoom with middle mouse scroll, or alt+right-mouse drag
function HandleZoomInput(mouseScreenPos: Vector2) {
	if (CanStartNewInput() && CanZoom()) {
		const mouseWorldPosAfterPanning = WorldCam.ScreenToWorldPoint(mouseScreenPos);
		const zoomPrev = CameraController.activeView.OrthoSize;
		let targetZoom = zoomPrev;

		if (isDragZoomingCamera) {
			const delta = mouseScreenPos.sub(dragZoomMousePrev);
			dragZoomMousePrev = mouseScreenPos;
			const zoomDeltaRaw = -delta.magnitude * Math.sign(Math.abs(delta.x) > Math.abs(delta.y) ? delta.x : -delta.y);
			const zoomDelta = (zoomDeltaRaw / Screen.width) * zoomSpeed * 5 * zoomPrev;
			targetZoom = zoomPrev + zoomDelta;
		}
		// Middle-mouse scroll zoom
		else if (CanMiddleMouseZoom()) {
			const deltaZoom = -InputHelper.MouseScrollDelta.y * zoomPrev * zoomSpeed * 0.1;
			targetZoom = zoomPrev + deltaZoom;
		}

		SetZoom(targetZoom);

		if (zoomPrev !== CameraController.activeView.OrthoSize) {
			ContextMenu.CloseContextMenu();

			// Adjust cam pos to centre zoom on mouse
			if (zoomToMouse && CanMove() && !isDragZoomingCamera) {
				const mouseWorldPosAfterZoom = WorldCam.ScreenToWorldPoint(mouseScreenPos);
				MovePosition(mouseWorldPosAfterPanning.sub(mouseWorldPosAfterZoom));
			}
		}

		// Alt-left mouse drag zoom
		if (InputHelper.IsMouseDownThisFrame(MouseButton.Right) && KeyboardShortcuts.CameraActionKeyHeld && !isMovingCamera) {
			isDragZoomingCamera = true;
			dragZoomMousePrev = mouseScreenPos;
		}
	}

	if (InputHelper.IsMouseUpThisFrame(MouseButton.Right)) isDragZoomingCamera = false;
}

// shift scroll reserved for adjusting spacing when placing multiple elements
function CanMiddleMouseZoom(): boolean {
	return !(InputHelper.ShiftIsHeld && Project.ActiveProject.controller.IsPlacingElements) && InputHelper.IsMouseInGameWindow();
}

function MovePosition(delta: Vector2) {
	CameraController.activeView.Pos = CameraController.activeView.Pos.add(delta);
	UpdateCameraState();
}

function SetZoom(zoom: number) {
	CameraController.activeView.OrthoSize = Math.min(Math.max(zoom, zoomRange.x), zoomRange.y);
	UpdateCameraState();
}

function UpdateCameraState() {
	const v = CameraController.activeView;
	WorldCam.posX = v.Pos.x;
	WorldCam.posY = v.Pos.y;
	WorldCam.orthographicSize = v.OrthoSize;
	Draw.SetCamera(v.Pos.x, v.Pos.y, v.OrthoSize);
	InputHelper.InvalidateWorldMouseCache();
}

function GetActiveViewState(): ViewState {
	const activeOld = CameraController.activeView;
	let activeViewNew: ViewState;

	if (UIDrawer.ActiveMenu === MenuType.ChipCustomization) {
		if (activeOld !== customizeView) customizeView = new ViewState();
		activeViewNew = customizeView;
	} else if (UIDrawer.ActiveMenu === MenuType.MainMenu) {
		activeViewNew = mainMenuView;
	} else {
		const viewedChip = Project.ActiveProject.ViewedChip;
		const viewedChipKey = viewedChip.ChipName;

		let v = chipViewStateLookup.get(viewedChipKey);
		if (v === undefined) {
			v = CameraController.GetViewForChip(viewedChip);
			chipViewStateLookup.set(viewedChipKey, v);
		}
		activeViewNew = v;
	}

	return activeViewNew;
}

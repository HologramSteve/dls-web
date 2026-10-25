// Port of DLS.Graphics.DevSceneDrawer
// Web note: subchip displays read their simulation state (input pins + internal state) via SimChipRef.GetDisplayData(),
// which the worker streams back every frame for each display that is requested while drawing.
import { Brighten, Darken, GetValue_HSV, MakeCol, Saturation, ShouldUseBlackText } from "../../seb/helpers/ColHelper";
import { InputHelper, MouseButton, WorldCam } from "../../seb/helpers/InputHelper";
import { Bounds2D } from "../../seb/types/Bounds2D";
import { Color } from "../../seb/types/Color";
import { Mathf } from "../../seb/types/Mathf";
import { Vector2 } from "../../seb/types/Vector2";
import { Anchor } from "../../seb/vis/Anchor";
import { Draw } from "../../seb/vis/Draw";
import { ChipTypeHelper } from "../description/ChipTypeHelper";
import { ChipType, NameDisplayLocation, PinBitCount, PinValueDisplayMode } from "../description/Types";
import type { ChipInteractionController } from "../game/ChipInteractionController";
import { DevPinInstance } from "../game/elements/DevPinInstance";
import type { IInteractable, IMoveable } from "../game/elements/Interfaces";
import type { PinInstance } from "../game/elements/PinInstance";
import { type DisplayInstance, SubChipInstance } from "../game/elements/SubChipInstance";
import { WireInstance } from "../game/elements/WireInstance";
import { InteractionState } from "../game/InteractionState";
import { Project } from "../game/Project";
import { PinState } from "../simulation/PinState";
import type { SimChipRef } from "../simulation/SimHost";
import {
	ActiveTheme,
	ChipNameLineSpacing,
	ChipOutlineWidth,
	DevPinStateDisplayOutline,
	DevPinStateDisplayRadius,
	FontBold,
	FontSizeChipName,
	FontSizePinLabel,
	GetStateColour,
	GridSize,
	GridThickness,
	LabelBackgroundPadding,
	MultiBitPinStateDisplaySquareSize,
	PinRadius,
	WireHighlightedThickness,
	WireThickness,
} from "./DrawSettings";
import { PreferencesMenu } from "./ui/menus/PreferencesMenu";
import { CreateMultiBitWireLayout, DrawWireStraight, GetClosestPointOnWire } from "./WireLayoutHelper";
import { WorldDrawer } from "./WorldDrawer";

const DisplayOffState = 0;
const DisplayOnState = 1;
const DisplayHighlightState = 2;

const orderedWires: WireInstance[] = [];
const WireComparison = (a: WireInstance, b: WireInstance) => a.drawOrder - b.drawOrder;

// State
let controller: ChipInteractionController;
let canEditViewedChip = false;

const IsNullOrWhiteSpace = (s: string | null | undefined) => !s || s.trim().length === 0;

export const DevSceneDrawer = {
	DisplayOffState,
	DisplayOnState,
	DisplayHighlightState,

	DrawActiveScene() {
		WorldDrawer.DrawGridIfActive(ActiveTheme.GridCol);

		controller = Project.ActiveProject.controller;
		canEditViewedChip = Project.ActiveProject.CanEditViewedChip;

		DrawWires();
		DrawWireEditPoints(controller.wireToEdit);

		// Draw dev pins and subchips (non-selected only)
		DrawMoveableElements(false);

		if (controller.IsMovingSelection) DrawAllPinNamesAndChipLabels(); // Draw labels under moving elements

		// Draw selected items on top
		Draw.StartLayer(Vector2.zero, 1, false);
		DrawMoveableElements(true);

		if (!controller.IsMovingSelection) DrawAllPinNamesAndChipLabels();

		const pinUnderMouse = InteractionState.PinUnderMouse;
		if (pinUnderMouse != null && controller.HasControl && !controller.IsMovingSelection && !controller.IsCreatingSelectionBox) {
			DrawPin(pinUnderMouse);
		}

		// Draw selection box
		if (controller.IsCreatingSelectionBox) {
			Draw.Quad(controller.SelectionBoxCentre, controller.SelectionBoxSize, ActiveTheme.SelectionBoxCol);
		}
	},

	DrawPinLabel(pin: PinInstance) {
		const text = pin.Name;
		if (IsNullOrWhiteSpace(text)) return;

		const offsetX = PinRadius + 0.05;
		const font = FontBold;

		const size = Draw.CalculateTextBoundsSize(text, FontSizePinLabel, font).add(LabelBackgroundPadding);
		const centre = pin.GetWorldPos().add(pin.ForwardDir.mul(size.x / 2 + offsetX));

		Draw.Quad(centre, size, ActiveTheme.PinLabelCol);
		Draw.Text(font, text, FontSizePinLabel, centre, Anchor.TextFirstLineCentre, Color.white);
	},

	DrawSubChipLabel(chip: SubChipInstance) {
		const text = chip.Label;
		if (IsNullOrWhiteSpace(text)) return;

		const offsetY = 0.2;
		const font = FontBold;

		const size = Draw.CalculateTextBoundsSize(text, FontSizePinLabel, font).add(LabelBackgroundPadding);
		const centre = chip.Position.add(Vector2.down.mul(chip.Size.y / 2 + offsetY));

		Draw.Quad(centre, size, ActiveTheme.PinLabelCol);
		Draw.Text(font, text, FontSizePinLabel, centre, Anchor.TextFirstLineCentre, Color.white);
	},

	DrawPinDecValue(pin: DevPinInstance) {
		if (pin.pinValueDisplayMode === PinValueDisplayMode.Off) return;

		const value = pin.GetStateDecimalDisplayValue();
		const text = pin.pinValueDisplayMode !== PinValueDisplayMode.HEX ? String(value) : (value >>> 0).toString(16).toUpperCase();

		const font = FontBold;
		const parentBounds = pin.BoundingBox;
		const offsetY = 0.225;
		const centreX = pin.StateDisplayPosition.x;
		const labelSize = new Vector2(pin.StateGridSize.x, 0.2);

		const labelCentre = new Vector2(centreX, parentBounds.Bottom + labelSize.y / 2 - offsetY);

		Draw.Quad(labelCentre, labelSize, new Color(0, 0, 0, 0.17));
		Draw.Text(font, text, FontSizePinLabel, labelCentre, Anchor.TextFirstLineCentre, Color.white);
	},

	DrawSubChip(subchip: SubChipInstance) {
		const desc = subchip.Description;
		let chipCol = desc.Colour;
		const pos = subchip.Position;
		const isKeyChip = subchip.ChipType === ChipType.Key;

		if (isKeyChip) {
			// Key changes colour when pressed down
			if (PinState.FirstBitHigh(subchip.OutputPins[0].State)) chipCol = Color.white;
		}

		const outlineCol = GetChipOutlineCol(chipCol);
		const useBlackText = ShouldUseBlackText(chipCol);

		let nameTextCol = useBlackText ? Color.black : Color.white;

		// Use low grey text col for chips with close to zero saturation (I think it maybe looks better, but not quite sure...)
		const sat = Saturation(chipCol);
		const textColLowSat = useBlackText ? Darken(chipCol, 0.5) : Brighten(chipCol, 0.25);
		nameTextCol = Color.lerp(textColLowSat, nameTextCol, Mathf.InverseLerp(0, 0.1, sat));

		// Draw pins
		for (let i = 0; i < subchip.AllPins.length; i++) {
			// Hide input pin on bus origin chips, since player connects to the bus wire instead (input pin is only used behind the scenes)
			if (i === 0 && ChipTypeHelper.IsBusOriginType(subchip.Description.ChipType)) continue;
			DrawPin(subchip.AllPins[i]);
		}

		// Draw outline and body
		Draw.Quad(pos, desc.Size.add(Vector2.one.mul(ChipOutlineWidth)), outlineCol);
		Draw.Quad(pos, desc.Size, chipCol);

		// Mouse over detection
		if (InputHelper.MouseInsideBounds_World(pos, desc.Size)) {
			// If mouse is over one of this chip's pins, then prioritize keeping the pin highlighted (so interaction is not too fiddly)
			const pinUnderMouse = InteractionState.PinUnderMouse;
			if (pinUnderMouse == null || pinUnderMouse.parent !== subchip) InteractionState.NotifyElementUnderMouse(subchip);
		}

		// Draw name
		if (isKeyChip || desc.NameLocation !== NameDisplayLocation.Hidden) {
			// Display on single line if name fits comfortably, otherwise use 'formatted' version (split across multiple lines)
			let displayName = isKeyChip ? subchip.activationKeyString : subchip.MultiLineName;
			if (Draw.CalculateTextBoundsSize(subchip.Description.Name, FontSizeChipName, FontBold).x < subchip.Size.x - PinRadius * 2.5) {
				displayName = subchip.Description.Name;
			}

			const nameCentre = desc.NameLocation === NameDisplayLocation.Centre || isKeyChip;
			const textAnchor = nameCentre ? Anchor.TextCentre : Anchor.CentreTop;
			const textPos = nameCentre ? pos : pos.add(Vector2.up.mul(subchip.Size.y / 2 - GridSize / 2));

			// Draw background band behind text if placed at top (so it doesn't look out of place..)
			if (desc.NameLocation === NameDisplayLocation.Top) {
				const bgBandCol = GetChipDisplayBorderCol(chipCol);
				const topLeft = pos.add(new Vector2(-desc.Size.x / 2, desc.Size.y / 2));
				const textBounds = Draw.CalculateTextBounds(displayName, FontBold, FontSizeChipName, textPos, textAnchor);
				const h = (topLeft.y - textBounds.Centre.y) * 2;

				const s = new Vector2(desc.Size.x, h);
				const c = topLeft.add(new Vector2(s.x, -s.y).div(2));
				Draw.Quad(c, s, bgBandCol);
			}

			Draw.Text(FontBold, displayName, FontSizeChipName, textPos, textAnchor, nameTextCol, ChipNameLineSpacing);
		}
	},

	DrawSubchipDisplays(subchip: SubChipInstance, sim: SimChipRef | null = null, outOfBoundsDisplay = false) {
		const subchipMask = Bounds2D.CreateFromCentreAndSize(subchip.Position, subchip.Size);
		const allBounds: Bounds2D[] = [];

		const mask = Draw.BeginMaskScope(subchipMask.Min, subchipMask.Max);
		try {
			// Draw displays
			for (let i = 0; i < subchip.Displays.length; i++) {
				const display = subchip.Displays[i];
				const bounds = DevSceneDrawer.DrawDisplayWithBackground(display, subchip.Position, subchip, sim);
				if (outOfBoundsDisplay) allBounds.push(bounds);
			}
		} finally {
			mask.Dispose();
		}

		if (outOfBoundsDisplay) {
			const outOfBoundsCol = new Color(1, 0, 0, 0.24);
			const maskBounds = Bounds2D.CreateFromCentreAndSize(subchip.Position, subchip.Size);

			for (const bounds of allBounds) {
				if (bounds.EntirelyInside(maskBounds)) continue;
				Draw.Quad(bounds.Centre, bounds.Size, outOfBoundsCol);
			}
		}
	},

	DrawDisplayWithBackground(display: DisplayInstance, pos: Vector2, rootChip: SubChipInstance, sim: SimChipRef | null = null): Bounds2D {
		const borderCol = GetChipDisplayBorderCol(rootChip.Description.Colour);

		const displayBorderID = Draw.ReserveQuad();
		const displayBackingID = Draw.ReserveQuad();

		const bounds = DevSceneDrawer.DrawDisplay(display, pos, 1, rootChip, sim);

		// Border colour around display
		Draw.ModifyQuad(displayBorderID, bounds.Centre, bounds.Size.add(Vector2.one.mul(0.03)), borderCol);
		// Black background behind display to fill any gaps
		Draw.ModifyQuad(displayBackingID, bounds.Centre, bounds.Size, Color.black);

		return bounds;
	},

	DrawDisplay(display: DisplayInstance, posParent: Vector2, parentScale: number, rootChip: SubChipInstance, sim: SimChipRef | null = null): Bounds2D {
		let bounds = Bounds2D.CreateEmpty();

		const posLocal = display.Desc.Position;
		const posWorld = posParent.add(posLocal.mul(parentScale));
		const scaleWorld = display.Desc.Scale * parentScale;

		if (display.DisplayType === ChipType.Custom) {
			sim = sim?.GetSubChipFromID(display.Desc.SubChipID) ?? null;

			for (const child of display.ChildDisplays) {
				const childBounds = DevSceneDrawer.DrawDisplay(child, posWorld, scaleWorld, rootChip, sim);
				bounds = Bounds2D.Grow(bounds, childBounds);
			}
		} else if (display.DisplayType === ChipType.SevenSegmentDisplay) {
			const data = sim?.GetDisplayData() ?? null;
			const simActive = data != null;
			// if this is the builtin 7Seg, highlight segments when mouse is over corresponding pin
			const hoverActive = rootChip.ChipType === ChipType.SevenSegmentDisplay;
			const pin = InteractionState.PinUnderMouse;
			const colOffset = simActive && data.InputPins[7].FirstBitHigh ? 3 : 0;

			const Seg = (i: number) => (simActive && data.InputPins[i].FirstBitHigh ? DisplayOnState : hoverActive && pin === rootChip.AllPins[i] ? DisplayHighlightState : DisplayOffState) + colOffset;
			bounds = DevSceneDrawer.DrawDisplay_SevenSegment(posWorld, scaleWorld, Seg(0), Seg(1), Seg(2), Seg(3), Seg(4), Seg(5), Seg(6));
		} else if (display.DisplayType === ChipType.DisplayRGB) {
			bounds = DevSceneDrawer.DrawDisplay_RGB(posWorld, scaleWorld, sim?.GetDisplayData()?.InternalState ?? null);
		} else if (display.DisplayType === ChipType.DisplayDot) {
			bounds = DevSceneDrawer.DrawDisplay_Dot(posWorld, scaleWorld, sim?.GetDisplayData()?.InternalState ?? null);
		} else if (display.DisplayType === ChipType.DisplayLED) {
			const data = sim?.GetDisplayData() ?? null;
			let col = Color.black;
			if (data != null) {
				const isOn = data.InputPins[0].FirstBitHigh;
				const displayColIndex = data.InternalState[0];
				col = GetStateColour(isOn, displayColIndex);
			}

			bounds = DevSceneDrawer.DrawDisplay_LED(posWorld, scaleWorld, col);
		}

		display.LastDrawBounds = bounds;
		return bounds;
	},

	CalculateChipNameBounds(name: string): Vector2 {
		return Draw.CalculateTextBoundsSize(name, FontSizeChipName, FontBold, ChipNameLineSpacing);
	},

	DrawDisplay_RGB(centre: Vector2, scale: number, internalState: Uint32Array | null): Bounds2D {
		const pixelsPerRow = 16;
		const borderFrac = 0.95;
		const pixelSizeT = 0.925;
		// Draw background
		Draw.Quad(centre, Vector2.one.mul(scale), Color.black);
		const size = scale * borderFrac;

		const useSim = internalState != null;

		const bottomLeft = centre.sub(Vector2.one.mul(size / 2));
		const pixelSize = size / pixelsPerRow;
		const pixelDrawSize = Vector2.one.mul(pixelSize * pixelSizeT);
		let col = MakeCol(0.1);
		const Unpack4BitColChannel = (raw: number) => (raw & 0b1111) / 15;

		for (let y = 0; y < 16; y++) {
			for (let x = 0; x < 16; x++) {
				if (useSim) {
					const address = y * 16 + x;
					const pixelState = internalState[address];
					col = new Color(Unpack4BitColChannel(pixelState), Unpack4BitColChannel(pixelState >>> 4), Unpack4BitColChannel(pixelState >>> 8));
				}

				const pos = new Vector2(bottomLeft.x + pixelSize / 2 + pixelSize * x, bottomLeft.y + pixelSize / 2 + pixelSize * y);
				Draw.Quad(pos, pixelDrawSize, col);
			}
		}

		return Bounds2D.CreateFromCentreAndSize(centre, Vector2.one.mul(scale));
	},

	DrawDisplay_Dot(centre: Vector2, scale: number, internalState: Uint32Array | null): Bounds2D {
		const pixelsPerRow = 16;
		const borderFrac = 0.95;
		const pixelSizeT = 0.925;
		// Draw background
		Draw.Quad(centre, Vector2.one.mul(scale), Color.black);
		const size = scale * borderFrac;

		const useSim = internalState != null;

		const bottomLeft = centre.sub(Vector2.one.mul(size / 2));
		const pixelSize = size / pixelsPerRow;
		const pixelDrawSize = Vector2.one.mul(pixelSize * pixelSizeT);

		let col = MakeCol(0.1);

		for (let y = 0; y < 16; y++) {
			for (let x = 0; x < 16; x++) {
				if (useSim) {
					const address = y * 16 + x;
					const pixelState = internalState[address];
					col = new Color(pixelState, pixelState, pixelState);
				}

				const pos = new Vector2(bottomLeft.x + pixelSize / 2 + pixelSize * x, bottomLeft.y + pixelSize / 2 + pixelSize * y);
				Draw.Point(pos, pixelDrawSize.x / 2, col);
			}
		}

		return Bounds2D.CreateFromCentreAndSize(centre, Vector2.one.mul(scale));
	},

	DrawDisplay_SevenSegment(centre: Vector2, scale: number, A: number, B: number, C: number, D: number, E: number, F: number, G: number): Bounds2D {
		const targetHeightAspect = 1.75;
		const segmentThicknessFac = 0.165;
		const segmentVerticalSpacingFac = 0.07;
		const displayInsetFac = 0.2;

		const boundsWidth = scale;
		const boundsHeight = boundsWidth * targetHeightAspect;
		const segmentThickness = scale * segmentThicknessFac;

		// Width of horizontal segments
		const segmentWidth = boundsWidth - segmentThickness - scale * displayInsetFac;
		// Distance between the centres of the bottom-most and top-most segments
		const segmentRegionHeight = boundsHeight - segmentThickness - scale * displayInsetFac;
		// Height of the vertical segments
		const segmentHeight = segmentRegionHeight / 2 - scale * segmentVerticalSpacingFac;

		const segmentSizeVertical = new Vector2(segmentThickness, segmentHeight);
		const segmentSizeHorizontal = new Vector2(segmentWidth, segmentThickness);
		const offsetX = Vector2.right.mul(segmentWidth / 2);
		const offsetY = Vector2.up.mul(segmentRegionHeight / 4);

		const cols = ActiveTheme.SevenSegCols;

		// Draw bounds
		const boundsSize = new Vector2(boundsWidth, boundsHeight);
		Draw.Quad(centre, boundsSize, Color.black);

		// Draw horizontal segments
		Draw.Diamond(centre, new Vector2(segmentWidth, segmentThickness), cols[G]); // mid
		Draw.Diamond(centre.add(Vector2.up.mul(segmentRegionHeight / 2)), segmentSizeHorizontal, cols[A]); // top
		Draw.Diamond(centre.sub(Vector2.up.mul(segmentRegionHeight / 2)), segmentSizeHorizontal, cols[D]); // bottom

		// Draw vertical segments
		Draw.Diamond(centre.sub(offsetX).add(offsetY), segmentSizeVertical, cols[F]); // left top
		Draw.Diamond(centre.sub(offsetX).sub(offsetY), segmentSizeVertical, cols[E]); // left bottom
		Draw.Diamond(centre.add(offsetX).add(offsetY), segmentSizeVertical, cols[B]); // right top
		Draw.Diamond(centre.add(offsetX).sub(offsetY), segmentSizeVertical, cols[C]); // right bottom

		return Bounds2D.CreateFromCentreAndSize(centre, boundsSize);
	},

	DrawDisplay_LED(centre: Vector2, scale: number, col: Color): Bounds2D {
		const pixelSizeT = 0.975;
		const pixelDrawSize = Vector2.one.mul(scale * pixelSizeT);

		Draw.Quad(centre, Vector2.one.mul(scale), Color.black);
		Draw.Quad(centre, pixelDrawSize, col);

		return Bounds2D.CreateFromCentreAndSize(centre, Vector2.one.mul(scale));
	},

	DrawDevPin(devPin: DevPinInstance) {
		if (devPin.BitCount === PinBitCount.Bit1) DevSceneDrawer.Draw1BitDevPin(devPin);
		else DevSceneDrawer.DrawMultiBitDevPin(devPin);
	},

	Draw1BitDevPin(devPin: DevPinInstance) {
		// Line between state display and pin
		Draw.Line(devPin.StateDisplayPosition, devPin.PinPosition, 0.03, Color.black);

		// ---- State indicator circle ----
		// Toggle state on mouse down
		const mouseOverStateIndicator = devPin.PointIsInStateIndicatorBounds(InputHelper.MousePosWorld);
		const interactingWithStateDisplay = mouseOverStateIndicator && devPin.IsInputPin && controller.CanInteractWithPinStateDisplay;
		const stateCol = devPin.Pin.GetStateCol(0, interactingWithStateDisplay, canEditViewedChip);

		// Highlight on hover and toggle on mouse down
		if (interactingWithStateDisplay) {
			InteractionState.NotifyUnspecifiedElementUnderMouse();
			if (InputHelper.IsMouseDownThisFrame(MouseButton.Left)) controller.ToggleDevPinState(devPin, 0);
		}

		Draw.Point(devPin.StateDisplayPosition, DevPinStateDisplayRadius + DevPinStateDisplayOutline, Darken(stateCol, 1.25));
		Draw.Point(devPin.StateDisplayPosition, DevPinStateDisplayRadius, stateCol);

		// Draw pin and handle
		DrawPin(devPin.Pin);
		DrawPinHandle(devPin, devPin.HandlePosition, devPin.GetHandleSize());
	},

	DrawMultiBitDevPin(devPin: DevPinInstance) {
		// Line between state display and pin
		Draw.Line(devPin.StateDisplayPosition, devPin.PinPosition, 0.03, Color.black);

		// ---- State indicator grid ----
		const stateGridDim = devPin.StateGridDimensions;

		const squareDisplayScaleT = 0.9;
		const squareDisplaySize = Vector2.one.mul(MultiBitPinStateDisplaySquareSize * squareDisplayScaleT);
		const inputGridSize = devPin.StateGridSize;
		const inputGridSizeWithoutOutline = inputGridSize.sub(Vector2.one.mul(DevPinStateDisplayOutline));
		const centre = devPin.StateDisplayPosition;

		const topLeft = new Vector2(centre.x - inputGridSizeWithoutOutline.x / 2, centre.y + inputGridSizeWithoutOutline.y / 2);
		Draw.Quad(centre, inputGridSize, Color.black);
		let currBitIndex = devPin.BitCount - 1;

		const mouseOverStateGrid = InputHelper.MouseInsideBounds_World(centre, inputGridSize);
		const isInteractable = controller.CanInteractWithPinStateDisplay && devPin.IsInputPin;

		// If mouse over state grid, register it so that player can't draw selection box here (annoying when trying to toggle states)
		// (individual toggles are tested for mouse input below, but this is a catch-all for when mouse is in gap in between)
		if (mouseOverStateGrid && isInteractable) InteractionState.NotifyUnspecifiedElementUnderMouse();

		for (let y = 0; y < stateGridDim.y; y++) {
			for (let x = 0; x < stateGridDim.x; x++) {
				const pos = new Vector2(topLeft.x + MultiBitPinStateDisplaySquareSize * (x + 0.5), topLeft.y + MultiBitPinStateDisplaySquareSize * -(y + 0.5));

				// Highlight on hover, toggle on press
				const mouseOverStateToggle = InputHelper.MouseInsideBounds_World(pos, squareDisplaySize);
				const isInteractingWithStateDisplay = mouseOverStateToggle && isInteractable;
				const stateCol = devPin.Pin.GetStateCol(currBitIndex, isInteractingWithStateDisplay, canEditViewedChip);

				if (isInteractingWithStateDisplay) {
					InteractionState.NotifyUnspecifiedElementUnderMouse();
					if (InputHelper.IsMouseDownThisFrame(MouseButton.Left)) controller.ToggleDevPinState(devPin, currBitIndex);
				}

				Draw.Quad(pos, squareDisplaySize, stateCol);
				currBitIndex--;
			}
		}

		// Draw pin and handle
		DrawPin(devPin.Pin);
		DrawPinHandle(devPin, devPin.HandlePosition, devPin.GetHandleSize());
	},

	DrawWire(wire: WireInstance) {
		if (wire.bitCount === PinBitCount.Bit1) DrawSingleBitWire(wire);
		else DrawMultiBitWire(wire);
	},

	DrawGrid(gridCol: Color) {
		const thickness = GridThickness;

		const screenHalfHeight = WorldCam.orthographicSize;
		const screenHalfWidth = WorldCam.orthographicSize * WorldCam.aspect;
		const worldCentre = new Vector2(WorldCam.posX, WorldCam.posY);

		// (int) cast truncates towards zero
		const ToGrid = (v: number, gridSize: number) => Math.trunc(v / gridSize) * gridSize;

		const left = ToGrid(-screenHalfWidth + worldCentre.x, GridSize) - GridSize;
		const right = ToGrid(screenHalfWidth + worldCentre.x, GridSize) + GridSize;
		const top = ToGrid(screenHalfHeight + worldCentre.y, GridSize) + GridSize;
		const bottom = ToGrid(-screenHalfHeight + worldCentre.y, GridSize) - GridSize;

		const skip = WorldCam.orthographicSize < 8 ? 1 : WorldCam.orthographicSize < 32 ? 4 : 16;

		for (let px = left; px < right; px += GridSize) {
			const xInt = Mathf.RoundToInt(px / GridSize);
			if (xInt % skip === 0) Draw.LineXY(px, bottom, px, top, thickness, gridCol);
		}

		for (let py = bottom; py < top; py += GridSize) {
			const yInt = Mathf.RoundToInt(py / GridSize);
			if (yInt % skip === 0) Draw.LineXY(left, py, right, py, thickness, gridCol);
		}
	},
};

function DrawWires() {
	const chip = controller.ActiveDevChip;

	// Create list of wires sorted by draw order
	orderedWires.length = 0;
	for (const w of chip.Wires) orderedWires.push(w);
	if (controller.WireToPlace != null) orderedWires.push(controller.WireToPlace);

	for (const wire of orderedWires) wire.drawOrder = WireDrawOrder(wire);

	orderedWires.sort(WireComparison);

	// Draw
	for (const wire of orderedWires) DevSceneDrawer.DrawWire(wire);
	for (const wire of controller.DuplicatedWires) DevSceneDrawer.DrawWire(wire);
}

function DrawAllPinNamesAndChipLabels() {
	const chip = Project.ActiveProject.controller.ActiveDevChip;
	Draw.StartLayer(Vector2.zero, 1, false);

	// -- Draw names of all pins (when mode is set to always). Also draw decimal displays for multi-bit pins --
	const drawAllDevPinNames = Project.ActiveProject.AlwaysDrawDevPinNames;
	const drawAllSubchipPinNames = Project.ActiveProject.AlwaysDrawSubChipPinNames;

	for (const element of chip.Elements) {
		if (element instanceof DevPinInstance) {
			if (drawAllDevPinNames) DevSceneDrawer.DrawPinLabel(element.Pin);
			if (element.BitCount !== PinBitCount.Bit1) DevSceneDrawer.DrawPinDecValue(element);
		} else if (element instanceof SubChipInstance) {
			if (drawAllSubchipPinNames) {
				for (const subChipPin of element.AllPins) DevSceneDrawer.DrawPinLabel(subChipPin);
			}

			DevSceneDrawer.DrawSubChipLabel(element);
		}
	}

	// -- Draw name of pin under mouse (when mode is set to hover) --
	const highlightedPin = InteractionState.PinUnderMouse;
	if (highlightedPin != null && controller.CanInteractWithPin) {
		let drawHighlightedPinName = false;
		drawHighlightedPinName ||= highlightedPin.parent instanceof SubChipInstance && Project.ActiveProject.description.Prefs_ChipPinNamesDisplayMode === PreferencesMenu.DisplayMode_OnHover;
		drawHighlightedPinName ||= highlightedPin.parent instanceof DevPinInstance && Project.ActiveProject.description.Prefs_MainPinNamesDisplayMode === PreferencesMenu.DisplayMode_OnHover;

		if (drawHighlightedPinName) {
			Draw.StartLayer(Vector2.zero, 1, false);
			DevSceneDrawer.DrawPinLabel(highlightedPin);
		}
	}
}

// Draw all moveable elements (either non-selected only, or selected only)
function DrawMoveableElements(drawSelectedOnly: boolean) {
	const chip = controller.ActiveDevChip;
	const elements: IMoveable[] = drawSelectedOnly ? controller.SelectedElements : chip.Elements;
	let allValidPlacement = true;

	for (const element of elements) {
		if (element.IsSelected === drawSelectedOnly) {
			if (element instanceof DevPinInstance) DevSceneDrawer.DrawDevPin(element);
			else if (element instanceof SubChipInstance) DevSceneDrawer.DrawSubChip(element);
		}

		allValidPlacement &&= element.IsValidMovePos;
	}

	// -- Draw selection boxes and subchip displays -- (start new layer to draw above chip names)
	Draw.StartLayer(Vector2.zero, 1, false);

	for (const element of elements) {
		if (element.IsSelected === drawSelectedOnly) {
			// Draw displays
			if (element instanceof SubChipInstance && element.Displays.length > 0) {
				// Get sim representation of this subchip (note: if the subchip has not yet been placed, this will be null)
				const sim = chip.SimChip.TryGetSubChipFromID(element.ID);
				DevSceneDrawer.DrawSubchipDisplays(element, sim);
			}

			if (element.IsSelected) {
				let boxCol = ActiveTheme.SelectionBoxCol;
				if (controller.IsMovingSelection) {
					if (!element.IsValidMovePos) boxCol = ActiveTheme.SelectionBoxInvalidCol;
					else if (!allValidPlacement) boxCol = ActiveTheme.SelectionBoxOtherIsInvaldCol;
					else boxCol = ActiveTheme.SelectionBoxMovingCol;
				}

				const sel = element.SelectionBoundingBox;
				Draw.Quad(sel.Centre, sel.Size, boxCol);
			}
		}
	}
}

function GetChipOutlineCol(chipCol: Color): Color {
	return GetValue_HSV(chipCol) < 0.075 ? Brighten(chipCol, 0.15) : Darken(chipCol, 0.15);
}

function GetChipDisplayBorderCol(chipCol: Color): Color {
	const a = -0.13;
	const useBlackText = ShouldUseBlackText(chipCol);
	return useBlackText ? Darken(chipCol, a) : Brighten(chipCol, a);
}

function DrawPinHandle(item: IInteractable, pos: Vector2, size: Vector2) {
	// ---- Movement handle ----
	const mouseOverHandle = InputHelper.MouseInsideBounds_World(pos, size);
	const isInteracting = mouseOverHandle && (controller.CanInteractWithPinHandle || InteractionState.ElementUnderMousePrevFrame === item);
	const handleCol = isInteracting ? ActiveTheme.DevPinHandleHighlighted : ActiveTheme.DevPinHandle;
	Draw.Quad(pos, size, handleCol);

	if (isInteracting) InteractionState.NotifyElementUnderMouse(item);
}

// Wire should be highlighted if mouse is over it or if in edit mode
function ShouldHighlightWire(wire: WireInstance): boolean {
	if (InteractionState.MouseIsOverUI) return false;
	if (wire === controller.wireToEdit) return true;

	const prev = InteractionState.ElementUnderMousePrevFrame;
	if (prev instanceof WireInstance && wire === prev) {
		if (controller.IsCreatingWire) return controller.CanCompleteWireConnectionToWire(wire)[0];
		return true;
	}

	return false;
}

const highlightDstThreshold = WireHighlightedThickness + (WireHighlightedThickness - WireThickness) * 0.8;
const sqrDstThreshold = highlightDstThreshold * highlightDstThreshold;

function DrawSingleBitWire(wire: WireInstance) {
	const highlightWire = ShouldHighlightWire(wire);
	const thickness = highlightWire ? WireHighlightedThickness : WireThickness;

	const mousePos = InputHelper.MousePosWorld;
	const canInteract = controller.CanInteractWithWire(wire);

	// Init and populate points array
	const bitWire = wire.BitWires[0];
	if (bitWire.Points.length !== wire.WirePointCount) bitWire.Points = new Array(wire.WirePointCount);
	for (let i = 0; i < wire.WirePointCount; i++) bitWire.Points[i] = wire.GetWirePoint(i);

	// Draw
	const col = wire.GetColour(0);
	const interactSqrDst = DrawWireStraight(bitWire.Points, thickness, col, mousePos);

	// Draw connection point (if connects to wire)
	if (wire.ConnectedWire != null) {
		const pts = bitWire.Points;
		const connectionPoint = wire.SourceConnectionInfo.IsConnectedAtWire ? pts[0] : pts[pts.length - 1];
		const radius = highlightWire ? 0.07 : 0.06;
		Draw.Point(connectionPoint, radius, col);
	}

	if (canInteract && interactSqrDst < sqrDstThreshold) InteractionState.NotifyElementUnderMouse(wire);
}

function DrawMultiBitWire(wire: WireInstance) {
	const thickness = ShouldHighlightWire(wire) ? WireHighlightedThickness : WireThickness;

	const mousePos = InputHelper.MousePosWorld;
	const canInteract = controller.CanInteractWithWire(wire);

	CreateMultiBitWireLayout(wire.BitWires, wire, WireThickness);

	// Draw
	for (let bitIndex = 0; bitIndex < wire.BitWires.length; bitIndex++) {
		const bitWire = wire.BitWires[bitIndex];
		const col = wire.GetColour(bitIndex);
		const sqrInteractDst = DrawWireStraight(bitWire.Points, thickness, col, mousePos);
		if (canInteract && sqrInteractDst < sqrDstThreshold) InteractionState.NotifyElementUnderMouse(wire);
	}
}

function DrawWireEditPoints(wire: WireInstance | null) {
	// Wire edit points
	if (wire == null) return;
	if (!controller.isMovingWireEditPoint) controller.wireEditPointIndex = -1;
	controller.wireEditCanInsertPoint = false;
	const canInteract = controller.CanInteractWithWire(wire);

	// Can't edit first and last point in wire (unless that point connects to another wire instead of a pin)
	const startIndex = wire.SourceConnectionInfo.IsConnectedAtWire ? 0 : 1;
	const endIndex = wire.TargetConnectionInfo.IsConnectedAtWire ? wire.WirePointCount - 1 : wire.WirePointCount - 2;

	const r = 0.07;
	const rBG = r + 0.02;

	for (let i = startIndex; i <= endIndex; i++) {
		const p = wire.GetWirePoint(i);
		// Mouse over (but ignore if already moving another point)
		let highlighted = InputHelper.MousePosWorld.sub(p).sqrMagnitude < rBG * rBG && !controller.isMovingWireEditPoint;
		// Currently moving this point (mouse may not be over due to snapping, etc)
		highlighted ||= controller.wireToEdit != null && controller.wireEditPointIndex === i;
		highlighted &&= canInteract;

		const editPointCol = highlighted ? wire.SourcePin.GetColHigh() : wire.SourcePin.GetColLow();

		Draw.Point(p, rBG, Color.white);
		Draw.Point(p, r, editPointCol);

		if (highlighted) {
			InteractionState.NotifyUnspecifiedElementUnderMouse();
			controller.wireEditPointIndex = i;
		}
	}

	// If no highlighted point, and mouse over wire, then draw insertion point
	if (controller.wireEditPointIndex === -1 && InteractionState.ElementUnderMouse === wire && canInteract) {
		const insertionPointDisplayRadius = 0.04;
		const [insertionPoint, segmentIndex] = GetClosestPointOnWire(wire, InputHelper.MousePosWorld);
		const dstFromExistingPoint = Math.min(insertionPoint.sub(wire.GetWirePoint(segmentIndex)).magnitude, insertionPoint.sub(wire.GetWirePoint(segmentIndex + 1)).magnitude);
		if (dstFromExistingPoint > rBG) {
			controller.wireEditCanInsertPoint = true;
			Draw.Point(insertionPoint, insertionPointDisplayRadius, Color.white);
		}
	}
}

function DrawPin(pin: PinInstance) {
	if (pin.bitCount === PinBitCount.Bit1) DrawSingleBitPin(pin);
	else DrawMultiBitPin(pin);
}

function DrawSingleBitPin(pin: PinInstance) {
	const pinPos = pin.GetWorldPos();
	const pinSelectionBoundsPos = pinPos.add(pin.ForwardDir.mul(0.02));
	const pinSelectionBoundsRadius = PinRadius + 0.015;

	const mouseOverPin = !InteractionState.MouseIsOverUI && InputHelper.MouseInsidePoint_World(pinSelectionBoundsPos, pinSelectionBoundsRadius);

	if (mouseOverPin) InteractionState.NotifyElementUnderMouse(pin);
	const canInteract = controller.CanInteractWithPin;

	let pinCol = mouseOverPin && canInteract ? ActiveTheme.PinHighlightCol : ActiveTheme.PinCol;
	// If hovering over pin while creating a wire, colour should indicate whether it is a valid connection
	if (mouseOverPin && canInteract && controller.IsCreatingWire && !controller.CanCompleteWireConnection(pin)) pinCol = ActiveTheme.PinInvalidCol;

	Draw.Point(pinPos, PinRadius, pinCol);
}

function DrawMultiBitPin(pin: PinInstance) {
	const pinPos = pin.GetWorldPos();
	const pinSelectionBoundsPos = pinPos.add(Vector2.right.mul((pin.IsSourcePin ? 1 : -1) * 0.02));
	const pinWidth = PinRadius * 2 * 0.95;
	const pinHeight = SubChipInstance.PinHeightFromBitCount(pin.bitCount);
	const pinSize = new Vector2(pinWidth, pinHeight);

	const mouseOverPin = !InteractionState.MouseIsOverUI && InputHelper.MouseInsideBounds_World(pinSelectionBoundsPos, pinSize);

	if (mouseOverPin) InteractionState.NotifyElementUnderMouse(pin);
	const canInteract = controller.CanInteractWithPin;

	let pinCol = mouseOverPin && canInteract ? ActiveTheme.PinHighlightCol : ActiveTheme.PinCol;
	// If hovering over pin while creating a wire, colour should indicate whether it is a valid connection
	if (mouseOverPin && canInteract && controller.IsCreatingWire && !controller.CanCompleteWireConnection(pin)) pinCol = ActiveTheme.PinInvalidCol;

	Draw.Quad(pinPos, pinSize, pinCol);
}

const IntMax = 2147483647;

function WireDrawOrder(wire: WireInstance): number {
	// Wire in placement mode should be drawn on top of all other wires
	if (!wire.IsFullyConnected) return IntMax;

	if (wire === controller.wireToEdit) return IntMax - 1;

	// Bus wires should be drawn on top of regular wires
	if (wire.IsBusWire) return IntMax - 2;

	// Draw wires carrying high signal above those carrying low signal (for single bit wires)
	const wireIsHigh = wire.bitCount === PinBitCount.Bit1 && PinState.FirstBitHigh(wire.SourcePin.State);
	const drawPriority_signalHigh = wireIsHigh ? 1000 : 0;

	// Draw multi-bit wires above single bit wires
	const drawPriority_bitCount = wire.bitCount * 1000;

	// If a wire is connected to another wire, it should be drawn beneath it
	// (mainly important for multi-bit wires, since these look strange otherwise)
	const drawPriority_childWire = -wire.ConnectedWireRecursionDepth;

	return (drawPriority_childWire + drawPriority_signalHigh + drawPriority_bitCount) * 100 + wire.spawnOrder;
}

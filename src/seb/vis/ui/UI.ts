// Port of Seb.Vis.UI.UI: immediate-mode UI. UI space is 100 units wide; height depends on aspect.
import { Vector2 } from "../../types/Vector2";
import { Color } from "../../types/Color";
import { Bounds2D } from "../../types/Bounds2D";
import { Mathf } from "../../types/Mathf";
import { Scope } from "../../types/Scope";
import { Anchor, FontType } from "../Anchor";
import { Draw, DrawID, MaskScope } from "../Draw";
import { InputHelper, KeyCode, MouseButton } from "../../helpers/InputHelper";
import { Screen, Time, Application } from "../../helpers/Platform";
import { ShouldUseBlackText } from "../../helpers/ColHelper";
import { ButtonTheme, CalculateCentre, CheckboxTheme, HorizontalLayout, InputFieldTheme, ScrollViewTheme, UIHandle, WheelSelectorTheme } from "./UITheme";
import { ButtonState, ColourPickerState, InputFieldState, ScrollBarState, SliderState, TriggerState, WheelSelectorState } from "./UIStates";

export type ScrollViewDrawContentFunc = (topLeft: Vector2, width: number, isLayoutOnly: boolean) => void;
export type ScrollViewDrawElementFunc = (topLeft: Vector2, width: number, index: number, isLayoutOnly: boolean) => void;

const MString = "M";

export class UIScope {
	aspect = 1;
	canvasBottomLeft = Vector2.zero;
	canvasSize = Vector2.one;
	drawLetterboxes = false;
	invScale = 1;
	scale = 1;
	screenSize = Vector2.one;

	Dispose() {
		if (this.drawLetterboxes) UI.DrawLetterboxes();
		uiScopes.ExitScope();
	}
}

export class BoundsScope {
	DrawUI = true;
	IsEmpty = true;
	Max = Vector2.zero;
	Min = Vector2.zero;

	Dispose() {
		boundsScopes.ExitScope();
		const parent = boundsScopes.TryGetCurrentScope();
		if (parent) parent.Grow(this.Min, this.Max);
	}

	GetBounds(): Bounds2D {
		return this.IsEmpty ? new Bounds2D(Vector2.zero, Vector2.zero) : new Bounds2D(this.Min, this.Max);
	}

	Init(draw: boolean) {
		this.Min = new Vector2(Number.MAX_VALUE, Number.MAX_VALUE);
		this.Max = new Vector2(-Number.MAX_VALUE, -Number.MAX_VALUE);
		this.IsEmpty = true;
		this.DrawUI = draw;
	}

	Grow(min: Vector2, max: Vector2) {
		this.Min = Vector2.min(min, this.Min);
		this.Max = Vector2.max(max, this.Max);
		this.IsEmpty = false;
	}
}

export class DisabledScope {
	IsDisabled = false;
	Dispose() {
		disabledScopes.ExitScope();
	}
}

const boundsScopes = new Scope<BoundsScope>(() => new BoundsScope());
const uiScopes = new Scope<UIScope>(() => new UIScope());
const disabledScopes = new Scope<DisabledScope>(() => new DisabledScope());

const inputFieldStates = new Map<UIHandle, InputFieldState>();
const buttonStates = new Map<UIHandle, ButtonState>();
const colPickerStates = new Map<UIHandle, ColourPickerState>();
const scrollbarStates = new Map<UIHandle, ScrollBarState>();
const wheelSelectorStates = new Map<UIHandle, WheelSelectorState>();
const checkBoxStates = new Map<UIHandle, boolean>();

let mouseOverUIFrameIndex = -1;
let prevBounds = new Bounds2D(Vector2.zero, Vector2.zero);

function cur(): UIScope {
	return uiScopes.CurrentScope;
}
function scale(): number {
	return cur().scale;
}
function forceInteractionDisabled(): boolean {
	return disabledScopes.IsInsideScope && disabledScopes.CurrentScope.IsDisabled;
}
function IsRendering(): boolean {
	return !boundsScopes.IsInsideScope || boundsScopes.CurrentScope.DrawUI;
}

function getOrCreate<T>(map: Map<UIHandle, T>, id: UIHandle, create: () => T): T {
	let s = map.get(id);
	if (s === undefined) {
		s = create();
		map.set(id, s);
	}
	return s;
}

function UIToScreenSpaceCS(centre: Vector2, size: Vector2): [Vector2, Vector2] {
	const s = scale();
	const bl = cur().canvasBottomLeft;
	return [new Vector2(bl.x + centre.x * s, bl.y + centre.y * s), new Vector2(size.x * s, size.y * s)];
}

function Remap01(min: number, max: number, val: number): number {
	if (max - min === 0) return 0.5;
	if (val <= min) return 0;
	if (val >= max) return 1;
	return (val - min) / (max - min);
}

function OnFinishedDrawingUIElement(centre: Vector2, size: Vector2): void {
	OnFinishedDrawingUIElementBounds(Bounds2D.CreateFromCentreAndSize(centre, size));
}

function OnFinishedDrawingUIElementBounds(bounds: Bounds2D): void {
	prevBounds = bounds;
	const active = boundsScopes.TryGetCurrentScope();
	if (active) active.Grow(bounds.Min, bounds.Max);

	if (IsRendering() && mouseOverUIFrameIndex !== Time.frameCount) {
		if (UI.MouseInsideBounds(bounds)) mouseOverUIFrameIndex = Time.frameCount;
	}
}

function isInvalidInputChar(c: string): boolean {
	const code = c.charCodeAt(0);
	if (code < 32 || (code >= 127 && code < 160)) return true; // control
	if (code >= 0xd800 && code <= 0xdfff) return true; // surrogate
	if (code >= 0xe000 && code <= 0xf8ff) return true; // private use
	if (code === 0x200b || code === 0x200c || code === 0x200d || code === 0xfeff || code === 0x00ad) return true; // format
	return false;
}

// Scroll draw state
let scrollCtxDrawElementFunc: ScrollViewDrawElementFunc | null = null;
let scrollCtxDrawCount = 0;
let scrollCtxDrawSpacing = 0;

function DrawScrollContent(topLeft: Vector2, width: number, isLayoutOnly: boolean) {
	for (let i = 0; i < scrollCtxDrawCount; i++) {
		scrollCtxDrawElementFunc!(topLeft, width, i, isLayoutOnly);
		topLeft = new Vector2(topLeft.x, prevBounds.Bottom - scrollCtxDrawSpacing);
	}
}

export const UI = {
	Width: 100,
	HalfWidth: 50,

	get Height(): number {
		return UI.Width * cur().aspect;
	},
	get HalfHeight(): number {
		return UI.Height * 0.5;
	},
	get Centre(): Vector2 {
		return new Vector2(UI.Width * 0.5, UI.Height * 0.5);
	},
	get CentreTop(): Vector2 {
		return new Vector2(UI.Width * 0.5, UI.Height);
	},
	get CentreBottom(): Vector2 {
		return new Vector2(UI.Width * 0.5, 0);
	},
	get TopLeft(): Vector2 {
		return new Vector2(0, UI.Height);
	},
	get TopRight(): Vector2 {
		return new Vector2(UI.Width, UI.Height);
	},
	get BottomLeft(): Vector2 {
		return new Vector2(0, 0);
	},
	get BottomRight(): Vector2 {
		return new Vector2(UI.Width, 0);
	},

	get PrevBounds(): Bounds2D {
		return prevBounds;
	},

	get IsMouseOverUIThisFrame(): boolean {
		return mouseOverUIFrameIndex === Time.frameCount;
	},

	//  --------------------------- UI Scope functions ---------------------------
	CreateUIScope(bottomLeft = Vector2.zero, size = new Vector2(Screen.width, Screen.height), drawLetterboxes = false): UIScope {
		const scope = uiScopes.CreateScope();
		scope.canvasBottomLeft = bottomLeft;
		scope.canvasSize = size;
		scope.screenSize = new Vector2(Screen.width, Screen.height);
		scope.scale = size.x / 100;
		scope.invScale = 1 / scope.scale;
		scope.drawLetterboxes = drawLetterboxes;
		scope.aspect = size.y / size.x;
		Draw.StartLayer(Vector2.zero, 1, true);
		return scope;
	},

	// Begin drawing UI with fixed aspect ratio. If aspect doesn't match screen aspect, letterboxes can optionally be displayed.
	CreateFixedAspectUIScope(aspectX = 16, aspectY = 9, drawLetterbox = true): UIScope {
		const w = Screen.width;
		const h = Screen.height;
		if (w * aspectY < h * aspectX) {
			const canvasWidth = w;
			const canvasHeight = (canvasWidth * aspectY) / aspectX;
			const bottomY = (h - canvasHeight) / 2;
			return UI.CreateUIScope(new Vector2(0, bottomY), new Vector2(canvasWidth, canvasHeight), drawLetterbox);
		}
		if (w * aspectY > h * aspectX) {
			const canvasHeight = h;
			const canvasWidth = (canvasHeight * aspectX) / aspectY;
			const leftX = (w - canvasWidth) / 2;
			return UI.CreateUIScope(new Vector2(leftX, 0), new Vector2(canvasWidth, canvasHeight), drawLetterbox);
		}
		return UI.CreateUIScope(Vector2.zero, new Vector2(w, h), false);
	},

	BeginDisabledScope(disabled: boolean): DisabledScope {
		const scope = disabledScopes.CreateScope();
		scope.IsDisabled = disabled;
		return scope;
	},

	StartNewLayer() {
		Draw.StartLayer(Vector2.zero, 1, true);
	},

	// Creates a scope in which the bounding box of all UI elements is tracked.
	// If draw is set to false, elements will not be rendered; only the bounds will be calculated.
	BeginBoundsScope(draw: boolean): BoundsScope {
		const scope = boundsScopes.CreateScope();
		scope.Init(draw);
		return scope;
	},

	CreateMaskScopeMinMax(maskMin: Vector2, maskMax: Vector2): MaskScope {
		let minSS = UI.UIToScreenSpace(maskMin);
		let maxSS = UI.UIToScreenSpace(maskMax);
		const [parentMin, parentMax] = Draw.GetActiveMaskMinMax();
		minSS = Vector2.max(minSS, parentMin);
		maxSS = Vector2.min(maxSS, parentMax);
		return Draw.BeginMaskScope(minSS, maxSS);
	},

	CreateMaskScope(centreOrBounds: Vector2 | Bounds2D, size?: Vector2): MaskScope {
		if (centreOrBounds instanceof Bounds2D) return UI.CreateMaskScopeMinMax(centreOrBounds.Min, centreOrBounds.Max);
		return UI.CreateMaskScopeMinMax(centreOrBounds.sub(size!.div(2)), centreOrBounds.add(size!.div(2)));
	},

	GetCurrentBoundsScope(): Bounds2D {
		return boundsScopes.CurrentScope.GetBounds();
	},

	//  --------------------------- Draw functions ---------------------------
	DrawSlider(pos: Vector2, size: Vector2, anchor: Anchor, state: SliderState) {
		const centre = CalculateCentre(pos, size, anchor);
		const [ssc, sss] = UIToScreenSpaceCS(pos, size);
		Draw.Quad(ssc, sss, Color.white);

		const handlePos = Vector2.lerp(ssc.add(Vector2.left.mul(sss.x / 2)), ssc.add(Vector2.right.mul(sss.x / 2)), state.progressT);
		const handleSize = sss.y * 1.5;
		const mouseOverHandle = InputHelper.MouseInPoint_ScreenSpace(handlePos, handleSize);
		if (InputHelper.IsMouseDownThisFrame(MouseButton.Left) && mouseOverHandle) state.handleSelected = true;
		else if (InputHelper.IsMouseUpThisFrame(MouseButton.Left)) state.handleSelected = false;

		if (state.handleSelected) {
			const minX = ssc.x - sss.x / 2;
			const maxX = ssc.x + sss.x / 2;
			state.progressT = (InputHelper.MousePos.x - minX) / (maxX - minX);
		}

		Draw.Point(handlePos, handleSize, mouseOverHandle || state.handleSelected ? Color.red : Color.yellow);
		OnFinishedDrawingUIElement(centre, size);
	},

	DrawScrollViewElements(scrollID: UIHandle, pos: Vector2, size: Vector2, spacing: number, anchor: Anchor, theme: ScrollViewTheme, drawElementFunc: ScrollViewDrawElementFunc, count: number): ScrollBarState {
		scrollCtxDrawElementFunc = drawElementFunc;
		scrollCtxDrawCount = count;
		scrollCtxDrawSpacing = spacing;
		return UI.DrawScrollView(scrollID, pos, size, anchor, theme, DrawScrollContent);
	},

	DrawScrollView(scrollID: UIHandle, pos: Vector2, size: Vector2, anchor: Anchor, theme: ScrollViewTheme, drawContentFunc: ScrollViewDrawContentFunc): ScrollBarState {
		const scrollState = UI.GetScrollbarState(scrollID);

		if (IsRendering()) {
			const padding = theme.padding;
			UI.DrawPanel(pos, size, theme.backgroundCol, anchor);
			const bounds = prevBounds;
			const scrollArea = new Bounds2D(bounds.Min.add(Vector2.one.mul(padding)), bounds.Max.sub(Vector2.one.mul(padding)).add(Vector2.left.mul(theme.scrollBarWidth)));

			const buttonTopLeft = scrollArea.TopLeft;
			let contentBounds: Bounds2D;
			const boundsScopeStateBefore = boundsScopes.IsInsideScope ? UI.GetCurrentBoundsScope() : null;

			const mask = UI.CreateMaskScopeMinMax(scrollArea.Min, scrollArea.Max);
			try {
				// Run the draw content function without actually rendering to first calculate the bounds for scrolling
				contentBounds = DrawContent(false, buttonTopLeft, drawContentFunc, scrollArea);
				const maxScrollOffsetY = Math.max(0, contentBounds.Height - scrollArea.Height);
				scrollState.scrollY = Math.max(0, Math.min(maxScrollOffsetY, scrollState.scrollY));
				DrawContent(true, buttonTopLeft.add(Vector2.up.mul(scrollState.scrollY)), drawContentFunc, scrollArea);
			} finally {
				mask.Dispose();
			}

			const scrollbarArea = new Bounds2D(bounds.BottomRight.add(Vector2.left.mul(theme.scrollBarWidth)), bounds.TopRight);
			UI.DrawScrollbar(scrollArea, scrollbarArea, contentBounds.Height, theme, scrollID);

			const b = boundsScopes.TryGetCurrentScope();
			if (b && boundsScopeStateBefore) {
				b.Min = boundsScopeStateBefore.Min;
				b.Max = boundsScopeStateBefore.Max;
			}
		}

		OnFinishedDrawingUIElement(CalculateCentre(pos, size, anchor), size);
		return scrollState;

		function DrawContent(draw: boolean, topLeft: Vector2, drawFunc: ScrollViewDrawContentFunc, scrollArea: Bounds2D): Bounds2D {
			const scope = UI.BeginBoundsScope(draw);
			try {
				drawFunc(topLeft, scrollArea.Width, !draw);
				return UI.GetCurrentBoundsScope();
			} finally {
				scope.Dispose();
			}
		}
	},

	DrawScrollbar(scrollViewArea: Bounds2D, scrollbarArea: Bounds2D, contentHeight: number, theme: ScrollViewTheme, id: UIHandle): ScrollBarState {
		const state = UI.GetScrollbarState(id);

		if (IsRendering()) {
			const [barC, barS] = UIToScreenSpaceCS(scrollbarArea.Centre, scrollbarArea.Size);
			Draw.Quad(barC, barS, theme.scrollBarColBackground);

			const scrollT = contentHeight < scrollViewArea.Height ? 0 : state.scrollY / (contentHeight - scrollViewArea.Height);
			const contentOverflow = scrollViewArea.Height >= contentHeight ? 1 : contentHeight / scrollViewArea.Height;
			const scrollBarHeight = scrollbarArea.Height / contentOverflow;

			const scrollHandleTopAtMaxScroll = scrollbarArea.Bottom + scrollBarHeight;
			const scrollHandleTop = Mathf.Lerp(scrollbarArea.Top, scrollHandleTopAtMaxScroll, scrollT);
			let scrollBarCol = contentOverflow > 1 ? theme.scrollBarColNormal : theme.scrollBarColInactive;

			const scrollbarSize = new Vector2(scrollbarArea.Width, scrollBarHeight);
			const scrollbarCentre = CalculateCentre(new Vector2(scrollbarArea.Left, scrollHandleTop), scrollbarSize, Anchor.TopLeft);
			const [sbC, sbS] = UIToScreenSpaceCS(scrollbarCentre, scrollbarSize);

			const mouseOverScrollbarArea = InputHelper.MouseInBounds_ScreenSpace(barC, barS);
			const mouseOverScrollbar = InputHelper.MouseInBounds_ScreenSpace(sbC, sbS);

			if (InputHelper.IsMouseUpThisFrame(MouseButton.Left) || InputHelper.IsKeyDownThisFrame(KeyCode.Escape)) state.isDragging = false;

			if (mouseOverScrollbarArea && contentOverflow > 1) {
				if (mouseOverScrollbar) scrollBarCol = theme.scrollBarColHover;
				if (InputHelper.IsMouseDownThisFrame(MouseButton.Left)) {
					state.isDragging = true;
					state.dragScrollOffset = mouseOverScrollbar ? InputHelper.MousePos.y - sbC.y : 0;
				}
			}

			if (state.isDragging) {
				scrollBarCol = theme.scrollBarColPressed;
				const inputPosMin = barC.y - barS.y / 2 + sbS.y / 2;
				const inputPosMax = barC.y + barS.y / 2 - sbS.y / 2;
				state.scrollY = (1 - Mathf.InverseLerp(inputPosMin, inputPosMax, InputHelper.MousePos.y - state.dragScrollOffset)) * (contentHeight - scrollViewArea.Height);
			} else if (contentOverflow > 1) {
				const scrollSensitivity = 1.8;
				const wheelScrollableBounds = Bounds2D.Grow(scrollViewArea, scrollbarArea);
				const [wc, ws] = UIToScreenSpaceCS(wheelScrollableBounds.Centre, wheelScrollableBounds.Size);
				const mouseOverScrollView = InputHelper.MouseInBounds_ScreenSpace(wc, ws);
				if (mouseOverScrollView || mouseOverScrollbarArea) state.scrollY += InputHelper.MouseScrollDelta.y * -scrollSensitivity;
			}

			Draw.Quad(sbC, sbS, scrollBarCol);
		}

		OnFinishedDrawingUIElement(scrollbarArea.Centre, scrollbarArea.Size);
		return state;
	},

	DrawText(text: string, font: FontType, fontSize: number, pos: Vector2, anchor: Anchor, col: Color) {
		if (IsRendering()) {
			Draw.Text(font, text, fontSize * scale(), UI.UIToScreenSpace(pos), anchor, col);
		}
		const bounds = Draw.CalculateTextBounds(text, font, fontSize, pos, anchor);
		OnFinishedDrawingUIElement(bounds.Centre, bounds.Size);
	},

	CalculateTextSize(text: string, fontSize: number, font: FontType): Vector2 {
		return Draw.CalculateTextBoundsSize(text, fontSize, font);
	},

	InputField(id: UIHandle, theme: InputFieldTheme, pos: Vector2, size: Vector2, defaultText: string, anchor: Anchor, textPad: number, validation: ((s: string) => boolean) | null = null, forceFocus = false): InputFieldState {
		const state = UI.GetInputFieldState(id);
		const centre = CalculateCentre(pos, size, anchor);
		const [ssc, sss] = UIToScreenSpaceCS(centre, size);
		const s = scale();

		const CharIndexBeforeMouse = (textLeft: number): number => {
			// (note: currently assumes monospaced)
			const textBoundsWidth = Draw.CalculateTextBoundsSize(state.text, theme.fontSize, theme.font).x;
			const textRight = textLeft + textBoundsWidth * s;
			const t = Mathf.InverseLerp(textLeft, textRight, InputHelper.MousePos.x);
			return Mathf.RoundToInt(t * state.text.length);
		};

		if (IsRendering()) {
			const textCentreLeft = ssc.add(Vector2.right.mul(-sss.x / 2 + textPad * s));
			Draw.Quad(ssc, sss, theme.bgCol);

			const mouseInBounds = InputHelper.MouseInBounds_ScreenSpace(ssc, sss);

			if (InputHelper.IsMouseDownThisFrame(MouseButton.Left)) {
				state.SetFocus(mouseInBounds);
				state.isMouseDownInBounds = mouseInBounds;
				if (mouseInBounds) state.SetCursorIndex(CharIndexBeforeMouse(textCentreLeft.x), InputHelper.ShiftIsHeld);
			}

			if (state.focused && InputHelper.IsMouseHeld(MouseButton.Left) && state.isMouseDownInBounds) {
				state.SetCursorIndex(CharIndexBeforeMouse(textCentreLeft.x), true);
			}

			if (forceFocus && !state.focused) state.SetFocus(true);

			if (state.focused) {
				const outlineWidth = 0.05;
				Draw.QuadOutline(ssc, sss, outlineWidth * s, theme.focusBorderCol);
				for (const c of InputHelper.InputStringThisFrame) {
					if (isInvalidInputChar(c)) continue;
					state.TryInsertText(c, validation);
				}

				// Paste from clipboard (web: text arrives through the browser's paste event)
				const pasted = InputHelper.GetClipboardContents();
				if (pasted.length > 0) state.TryInsertText(pasted, validation);

				if (state.text.length > 0) {
					if (CanTrigger(state.backspaceTrigger, KeyCode.Backspace)) {
						const charDeleteCount = InputHelper.CtrlIsHeld ? state.text.length : 1;
						for (let i = 0; i < charDeleteCount; i++) state.Delete(true, validation);
					} else if (CanTrigger(state.deleteTrigger, KeyCode.Delete)) {
						state.Delete(false, validation);
					}

					const select = InputHelper.ShiftIsHeld;
					const leftArrow = CanTrigger(state.arrowKeyTrigger, KeyCode.LeftArrow);
					const rightArrow = CanTrigger(state.arrowKeyTrigger, KeyCode.RightArrow);
					const jumpToPrevWordStart = InputHelper.CtrlIsHeld && leftArrow;
					const jumpToNextWordEnd = InputHelper.CtrlIsHeld && rightArrow;
					const jumpToStart = InputHelper.IsKeyDownThisFrame(KeyCode.UpArrow) || InputHelper.IsKeyDownThisFrame(KeyCode.PageUp) || InputHelper.IsKeyDownThisFrame(KeyCode.Home) || (jumpToPrevWordStart && InputHelper.AltIsHeld);
					const jumpToEnd = InputHelper.IsKeyDownThisFrame(KeyCode.DownArrow) || InputHelper.IsKeyDownThisFrame(KeyCode.PageDown) || InputHelper.IsKeyDownThisFrame(KeyCode.End) || (jumpToNextWordEnd && InputHelper.AltIsHeld);

					if (jumpToStart) state.SetCursorIndex(0, select);
					else if (jumpToEnd) state.SetCursorIndex(state.text.length, select);
					else if (jumpToNextWordEnd) state.SetCursorIndex(state.NextWordEndIndex(), select);
					else if (jumpToPrevWordStart) state.SetCursorIndex(state.PrevWordIndex(), select);
					else if (leftArrow) state.DecrementCursor(select);
					else if (rightArrow) state.IncrementCursor(select);

					const copyTriggered = InputHelper.CtrlIsHeld && InputHelper.IsKeyDownThisFrame(KeyCode.C);
					const cutTriggered = InputHelper.CtrlIsHeld && InputHelper.IsKeyDownThisFrame(KeyCode.X);

					if (copyTriggered || cutTriggered) {
						let copyText = state.text;
						if (state.isSelecting) copyText = state.text.substring(state.SelectionMinIndex, state.SelectionMaxIndex);
						InputHelper.CopyToClipboard(copyText);
						if (cutTriggered) {
							if (state.isSelecting) state.Delete(true, validation);
							else state.ClearText();
						}
					}

					if (InputHelper.CtrlIsHeld && InputHelper.IsKeyDownThisFrame(KeyCode.A)) state.SelectAll();
				}
			}

			// Draw text
			const mask = UI.CreateMaskScope(centre, size);
			try {
				const fontSizeSS = theme.fontSize * s;
				const showDefaultText = !state.text || !Application.isPlaying;
				const displayString = showDefaultText ? defaultText : state.text;
				const textCol = showDefaultText ? theme.defaultTextCol : theme.textCol;
				Draw.Text(theme.font, displayString, fontSizeSS, textCentreLeft, Anchor.TextCentreLeft, textCol);

				const boundsSizeUpToCaret = Draw.CalculateTextBoundsSize(displayString, theme.fontSize, theme.font, 1, state.cursorBeforeCharIndex);

				if (state.isSelecting) {
					const boundsSizeUpToSelect = Draw.CalculateTextBoundsSize(displayString, theme.fontSize, theme.font, 1, state.selectionStartIndex);
					const col = new Color(0.2, 0.6, 1, 0.5);
					let startX = textCentreLeft.x + boundsSizeUpToCaret.x * s;
					let endX = textCentreLeft.x + boundsSizeUpToSelect.x * s;
					if (startX > endX) [startX, endX] = [endX, startX];
					Draw.Quad(new Vector2((endX + startX) / 2, textCentreLeft.y), new Vector2(endX - startX, theme.fontSize * 1.2 * s), col);
				}

				const blinkDuration = 0.5;
				if (state.focused && Math.trunc((Time.time - state.lastInputTime) / blinkDuration) % 2 === 0) {
					const caretTextBoundsTest = Draw.CalculateTextBoundsSize("Mj", theme.fontSize, theme.font);
					const caretOffset = 1 * 0.075 * (state.cursorBeforeCharIndex === 0 ? -1 : 1);
					const caretPos = textCentreLeft.add(Vector2.right.mul((boundsSizeUpToCaret.x + caretOffset) * s));
					const caretSize = new Vector2(0.125 * theme.fontSize, caretTextBoundsTest.y * 1.2);
					Draw.Quad(caretPos, caretSize.mul(s), theme.textCol);
				}
			} finally {
				mask.Dispose();
			}
		}

		OnFinishedDrawingUIElement(centre, size);
		return state;

		function CanTrigger(triggerState: TriggerState, key: string): boolean {
			if (InputHelper.IsKeyDownThisFrame(key)) triggerState.lastManualTime = Time.time;
			if (InputHelper.IsKeyDownThisFrame(key) || (InputHelper.IsKeyHeld(key) && CanAutoTrigger(triggerState))) {
				triggerState.lastAutoTiggerTime = Time.time;
				return true;
			}
			return false;
		}

		function CanAutoTrigger(triggerState: TriggerState): boolean {
			const autoTriggerStartDelay = 0.5;
			const autoTriggerRepeatDelay = 0.04;
			const initialDelayOver = Time.time - triggerState.lastManualTime > autoTriggerStartDelay;
			const canRepeat = Time.time - triggerState.lastAutoTiggerTime > autoTriggerRepeatDelay;
			return initialDelayOver && canRepeat;
		}
	},

	// Reserve spot in the drawing order for a panel. Returns an ID which can be used to modify its properties later.
	ReservePanel(): DrawID {
		return Draw.ReserveQuad();
	},

	ModifyPanel(id: DrawID, pos: Vector2, size: Vector2, col: Color, anchor = Anchor.Centre) {
		const centre = CalculateCentre(pos, size, anchor);
		const [c, s] = UIToScreenSpaceCS(centre, size);
		Draw.ModifyQuad(id, c, s, col);
		OnFinishedDrawingUIElement(centre, size);
	},

	ModifyPanelBounds(id: DrawID, bounds: Bounds2D, col: Color) {
		const [c, s] = UIToScreenSpaceCS(bounds.Centre, bounds.Size);
		Draw.ModifyQuad(id, c, s, col);
		OnFinishedDrawingUIElement(bounds.Centre, bounds.Size);
	},

	DrawPanelBounds(bounds: Bounds2D, col: Color) {
		UI.DrawPanel(bounds.Centre, bounds.Size, col);
	},

	DrawFullscreenPanel(col: Color) {
		UI.DrawPanel(Vector2.zero, new Vector2(UI.Width, UI.Height), col, Anchor.BottomLeft);
	},

	DrawPanel(pos: Vector2, size: Vector2, col: Color, anchor = Anchor.Centre) {
		const centre = CalculateCentre(pos, size, anchor);
		if (IsRendering()) {
			const [c, s] = UIToScreenSpaceCS(centre, size);
			Draw.Quad(c, s, col);
		}
		OnFinishedDrawingUIElement(centre, size);
	},

	DrawLine(a: Vector2, b: Vector2, thickness: number, col: Color) {
		if (IsRendering()) Draw.Line(UI.UIToScreenSpace(a), UI.UIToScreenSpace(b), thickness * scale(), col);
	},

	DrawCircle(pos: Vector2, radius: number, col: Color, anchor = Anchor.Centre) {
		const size = Vector2.one.mul(radius);
		const centre = CalculateCentre(pos, size, anchor);
		if (IsRendering()) {
			const [c, s] = UIToScreenSpaceCS(centre, size);
			Draw.Point(c, s.x, col);
		}
		OnFinishedDrawingUIElement(centre, size);
	},

	DrawColourPicker(id: UIHandle, pos: Vector2, width: number, anchor = Anchor.Centre): Color {
		let colRgb = Color.magenta;
		const state = UI.GetColourPickerState(id);
		const centre = CalculateCentre(pos, Vector2.one.mul(width), anchor);
		const s = scale();

		const hueBarWidth = width / 10;
		const hueBarSpacing = hueBarWidth / 3;
		const satValWidth = width - (hueBarWidth + hueBarSpacing);
		const satValSize = Vector2.one.mul(satValWidth);
		const satValCentre = CalculateCentre(centre.add(new Vector2(-width, width).div(2)), satValSize, Anchor.TopLeft);
		const hueBarSize = new Vector2(hueBarWidth, satValSize.y);
		const hueCentre = CalculateCentre(centre.add(new Vector2(width, width).div(2)), hueBarSize, Anchor.TopRight);
		const elementLeft = satValCentre.add(Vector2.left.mul(satValWidth / 2));
		const elementRight = hueCentre.add(Vector2.right.mul(hueBarWidth / 2));
		const elementCentre = elementLeft.add(elementRight).div(2);
		const elementSize = new Vector2(elementRight.x - elementLeft.x, satValSize.y);

		if (IsRendering()) {
			const [hueC, hueS] = UIToScreenSpaceCS(hueCentre, hueBarSize);
			const [svC, svS] = UIToScreenSpaceCS(satValCentre, satValSize);

			Draw.SatValQuad(svC, svS, state.hue);
			Draw.HueQuad(hueC, hueS);

			const hueTopY = hueC.y + hueS.y / 2;
			const hueBottomY = hueC.y - hueS.y / 2;
			const hueHandleY = Mathf.Lerp(hueBottomY, hueTopY, state.hue);
			const hueHandlePos = new Vector2(hueC.x, hueHandleY);
			const hueHandleSize = new Vector2(hueS.x * 1.1, hueS.x * 0.5);
			Draw.Quad(hueHandlePos, hueHandleSize, Color.white);

			const mouseOverHueBounds = InputHelper.MouseInBounds_ScreenSpace(hueC, hueS);
			const mouseOverHueHandle = InputHelper.MouseInBounds_ScreenSpace(hueHandlePos, hueHandleSize);
			if (InputHelper.IsMouseDownThisFrame(MouseButton.Left) && (mouseOverHueBounds || mouseOverHueHandle)) state.hueHandleSelected = true;
			if (state.hueHandleSelected) state.hue = Remap01(hueBottomY, hueTopY, InputHelper.MousePos.y);

			const svBL = svC.sub(svS.div(2));
			const svTR = svC.add(svS.div(2));
			const satPos = Mathf.Lerp(svBL.x, svTR.x, state.sat);
			const valPos = Mathf.Lerp(svBL.y, svTR.y, state.val);
			const svHandlePos = new Vector2(satPos, valPos);
			const svHandleRadius = hueHandleSize.y * 0.5;
			const svHandleRadiusOutline = svHandleRadius + 0.2 * s;
			colRgb = state.GetRGB();
			const handleOutlineCol = ShouldUseBlackText(colRgb) ? Color.black : Color.white;
			Draw.Point(svHandlePos, svHandleRadiusOutline, handleOutlineCol);
			Draw.Point(svHandlePos, svHandleRadius, colRgb);

			const mouseOverSatValBounds = InputHelper.MouseInBounds_ScreenSpace(svC, svS);
			const mouseOverSatValHandle = InputHelper.MouseInPoint_ScreenSpace(svHandlePos, svHandleRadiusOutline);
			if (InputHelper.IsMouseDownThisFrame(MouseButton.Left) && (mouseOverSatValBounds || mouseOverSatValHandle)) state.satValHandleSelected = true;

			if (state.satValHandleSelected) {
				state.sat = Remap01(svBL.x, svTR.x, InputHelper.MousePos.x);
				state.val = Remap01(svBL.y, svTR.y, InputHelper.MousePos.y);
			}

			if (InputHelper.IsMouseUpThisFrame(MouseButton.Left)) {
				state.hueHandleSelected = false;
				state.satValHandleSelected = false;
			}
		}

		OnFinishedDrawingUIElement(elementCentre, elementSize);
		return colRgb;
	},

	TextWithBackground(pos: Vector2, size: Vector2, anchor: Anchor, text: string, font: FontType, fontSize: number, textCol: Color, backgroundCol: Color) {
		const centre = CalculateCentre(pos, size, anchor);
		if (IsRendering()) {
			UI.DrawPanel(centre, size, backgroundCol);
			UI.DrawText(text, font, fontSize, centre, Anchor.Centre, textCol);
		}
		OnFinishedDrawingUIElement(centre, size);
	},

	// Full version of C# UI.Button(text, theme, pos, size, enabled, fitTextX, fitTextY, anchor, leftAlignText, textOffsetX, ignoreInputs)
	Button(text: string, theme: ButtonTheme, pos: Vector2, size = Vector2.zero, enabled = true, fitTextX = true, fitTextY = true, anchor = Anchor.Centre, leftAlignText = false, textOffsetX = 0, ignoreInputs = false): boolean {
		enabled &&= !forceInteractionDisabled();

		// Optionally resize button to fit text (given size is treated as padding in this case; text assumed single line)
		if (fitTextX || fitTextY) {
			const minSizeX = Draw.CalculateTextBoundsSize(text, theme.fontSize, theme.font).x;
			const minSizeY = Draw.CalculateTextBoundsSize(MString, theme.fontSize, theme.font).y;
			const padX = minSizeY * theme.paddingScale.x;
			const padY = minSizeY * theme.paddingScale.y;
			size = new Vector2(fitTextX ? size.x + minSizeX + padX : size.x, fitTextY ? size.y + minSizeY + padY : size.y);
		}

		const centre = CalculateCentre(pos, size, anchor);
		const [ssc, sss] = UIToScreenSpaceCS(centre, size);
		let buttonPressedThisFrame = false;

		if (IsRendering()) {
			const s = scale();
			const fontSizeSS = theme.fontSize * s;
			const mouseInsideMask = Draw.IsPointInsideActiveMask(InputHelper.MousePos) && !ignoreInputs;
			const mouseOver = mouseInsideMask && InputHelper.MouseInBounds_ScreenSpace(ssc, sss);
			const mouseIsDown = InputHelper.IsMouseHeld(MouseButton.Left);

			if (mouseOver && enabled) buttonPressedThisFrame = InputHelper.IsMouseDownThisFrame(MouseButton.Left);

			Draw.Quad(ssc, sss, theme.buttonCols.GetCol(mouseOver, mouseIsDown, enabled));

			const textCol = theme.textCols.GetCol(mouseOver, mouseIsDown, enabled);
			if (text) {
				const textAnchor = leftAlignText ? Anchor.TextCentreLeft : Anchor.TextFirstLineCentre;
				const textPos = leftAlignText ? ssc.add(Vector2.right.mul(-sss.x / 2 + textOffsetX * s)) : ssc.add(Vector2.right.mul(textOffsetX * s));
				Draw.Text(theme.font, text, fontSizeSS, textPos, textAnchor, textCol);
			}
		}

		OnFinishedDrawingUIElement(centre, size);
		return buttonPressedThisFrame;
	},

	MouseInsideBounds(uiBounds: Bounds2D): boolean {
		const [c, s] = UIToScreenSpaceCS(uiBounds.Centre, uiBounds.Size);
		return InputHelper.MouseInBounds_ScreenSpace(c, s);
	},

	// Returns the index of the pressed button (-1 if none)
	VerticalButtonGroup(names: string[], activeStates: boolean[] | null, theme: ButtonTheme, pos: Vector2, buttonSize: Vector2, fitToTextX: boolean, fitToTextY: boolean, spacing: number): number {
		let buttonPressIndex = -1;
		for (let i = 0; i < names.length; i++) {
			const active = activeStates === null ? true : activeStates[i];
			if (UI.Button(names[i], theme, pos, buttonSize, active, fitToTextX, fitToTextY)) buttonPressIndex = i;
			pos = new Vector2(pos.x, pos.y - (prevBounds.Height + spacing));
		}
		return buttonPressIndex;
	},

	// C#: HorizontalButtonGroup(names, activeStates, theme, pos, regionWidth, spacing, pad, anchor, ignoreInputs)
	HorizontalButtonGroup(names: string[], activeStates: boolean[] | null, theme: ButtonTheme, pos: Vector2, regionWidth: number, spacing: number, pad: number, anchor: Anchor, ignoreInputs = false): number {
		return UI.HorizontalButtonGroupSized(names, activeStates, theme, pos, Vector2.right.mul(regionWidth), spacing, pad, anchor, true, ignoreInputs);
	},

	HorizontalButtonGroupSized(names: string[], activeStates: boolean[] | null, theme: ButtonTheme, pos: Vector2, size: Vector2, spacing: number, pad: number, anchor: Anchor, autoHeight = false, ignoreInputs = false): number {
		let buttonPressIndex = -1;
		pos = pos.add(Vector2.right.mul(pad));
		size = new Vector2(size.x - pad * 2, size.y);
		const centre = CalculateCentre(pos, size, anchor);
		let bounds = Bounds2D.CreateEmpty();

		const buttonAnchor = anchor === Anchor.TopLeft ? Anchor.CentreTop : anchor === Anchor.BottomLeft ? Anchor.CentreBottom : Anchor.Centre;

		for (let i = 0; i < names.length; i++) {
			const [buttonSize, buttonCentre] = HorizontalLayout(names.length, i, centre, size, spacing);
			const buttonPos = new Vector2(buttonCentre.x, pos.y);
			const active = activeStates === null || activeStates[i];
			if (UI.Button(names[i], theme, buttonPos, buttonSize, active, false, autoHeight, buttonAnchor, false, 0, ignoreInputs)) buttonPressIndex = i;
			bounds = Bounds2D.Grow(bounds, prevBounds);
		}

		OnFinishedDrawingUIElement(bounds.Centre, bounds.Size);
		return buttonPressIndex;
	},

	// A stateful version of Button, allowing for more complex behaviour like detecting if button was pressed and then later released
	Button_Stateful(id: UIHandle, text: string, theme: ButtonTheme, pos: Vector2, size: Vector2, enabled: boolean, fitTextX: boolean, fitTextY: boolean, anchor: Anchor): ButtonState {
		const state = UI.GetButtonState(id);
		if (fitTextX || fitTextY) {
			const minSizeX = Draw.CalculateTextBoundsSize(text, theme.fontSize, theme.font).x;
			const minSizeY = Draw.CalculateTextBoundsSize(MString, theme.fontSize, theme.font).y;
			const padX = minSizeY * theme.paddingScale.x;
			const padY = minSizeY * theme.paddingScale.y;
			size = new Vector2(fitTextX ? size.x + minSizeX + padX : size.x, fitTextY ? size.y + minSizeY + padY : size.y);
		}

		const centre = CalculateCentre(pos, size, anchor);
		const [ssc, sss] = UIToScreenSpaceCS(centre, size);

		if (IsRendering()) {
			const fontSizeSS = theme.fontSize * scale();
			const mouseInsideMask = Draw.IsPointInsideActiveMask(InputHelper.MousePos);
			const mouseOver = mouseInsideMask && InputHelper.MouseInBounds_ScreenSpace(ssc, sss);
			const mouseIsDown = InputHelper.IsMouseHeld(MouseButton.Left);
			if (InputHelper.IsMouseDownThisFrame(MouseButton.Left)) {
				if (mouseOver) state.NotifyPressed();
				else state.NotifyCancelled();
			}
			if (InputHelper.IsMouseUpThisFrame(MouseButton.Left)) {
				if (mouseOver && state.isDown) state.NotifyReleased();
				else state.NotifyCancelled();
			}

			Draw.Quad(ssc, sss, theme.buttonCols.GetCol(mouseOver, mouseIsDown, enabled));
			const textCol = theme.textCols.GetCol(mouseOver, mouseIsDown, enabled);
			if (text) Draw.Text(theme.font, text, fontSizeSS, ssc, Anchor.Centre, textCol);
		}

		OnFinishedDrawingUIElement(centre, size);
		return state;
	},

	DrawToggle(id: UIHandle, pos: Vector2, size: number, theme: CheckboxTheme, anchor = Anchor.Centre) {
		const boxSize = Vector2.one.mul(size);
		const centre = CalculateCentre(pos, boxSize, anchor);

		if (IsRendering()) {
			let state = getOrCreate(checkBoxStates, id, () => false);
			const [ssc, sss] = UIToScreenSpaceCS(centre, boxSize);
			if (InputHelper.MouseInBounds_ScreenSpace(ssc, sss) && InputHelper.IsMouseDownThisFrame(MouseButton.Left)) {
				state = !state;
				checkBoxStates.set(id, state);
			}

			UI.DrawPanel(centre, boxSize, Color.red);
			UI.DrawPanel(centre, boxSize, Color.white);

			if (!state) {
				const thickness = sss.y / 15;
				const crossScale = sss.y * 0.3;
				Draw.Line(ssc.sub(Vector2.one.mul(crossScale)), ssc.add(Vector2.one.mul(crossScale)), thickness, theme.tickCol);
				Draw.Line(ssc.add(new Vector2(1, -1).mul(crossScale)), ssc.add(new Vector2(-1, 1).mul(crossScale)), thickness, theme.tickCol);
			}
		}

		OnFinishedDrawingUIElement(centre, boxSize);
	},

	// Box that displays one of multiple supplied string values. Buttons on either side allow for moving between the options.
	WheelSelector(id: UIHandle, elements: string[], pos: Vector2, size: Vector2, theme: WheelSelectorTheme, anchor = Anchor.Centre, allowWrapAround = true, enabled = true): number {
		const state = getOrCreate(wheelSelectorStates, id, () => new WheelSelectorState());
		state.index = UI.WheelSelectorIndexed(state.index, elements, pos, size, theme, anchor, allowWrapAround, enabled);
		return state.index;
	},

	WheelSelectorIndexed(elementIndex: number, elements: string[], pos: Vector2, size: Vector2, theme: WheelSelectorTheme, anchor = Anchor.Centre, allowWrapAround = true, enabled = true): number {
		const centre = CalculateCentre(pos, size, anchor);

		if (IsRendering()) {
			const buttonWidth = theme.buttonTheme.fontSize * 1.5;
			const buttonSize = new Vector2(buttonWidth, size.y);
			const backgroundPanelSize = new Vector2(size.x - buttonWidth * 2, size.y);

			const panelPad = buttonWidth;
			UI.DrawPanel(pos, backgroundPanelSize.add(Vector2.right.mul(panelPad)), theme.backgroundCol, anchor);

			const mask = UI.CreateMaskScope(Bounds2D.CreateFromCentreAndSize(centre, backgroundPanelSize));
			try {
				UI.DrawText(elements[elementIndex], theme.buttonTheme.font, theme.buttonTheme.fontSize, centre, Anchor.TextFirstLineCentre, enabled ? theme.textCol : theme.inactiveTextCol);
			} finally {
				mask.Dispose();
			}

			const enabledLeft = (elementIndex > 0 || allowWrapAround) && enabled;
			const enabledRight = (elementIndex < elements.length - 1 || allowWrapAround) && enabled;
			const leftEdge = centre.sub(new Vector2(size.x / 2, 0));
			const rightEdge = centre.add(new Vector2(size.x / 2, 0));

			let delta = 0;
			if (UI.Button("<", theme.buttonTheme, leftEdge, buttonSize, enabledLeft, false, false, Anchor.CentreLeft)) delta--;
			if (UI.Button(">", theme.buttonTheme, rightEdge, buttonSize, enabledRight, false, false, Anchor.CentreRight)) delta++;

			elementIndex = (elementIndex + delta + elements.length) % elements.length;
		}

		OnFinishedDrawingUIElement(centre, size);
		return elementIndex;
	},

	DrawCanvasRegion(col: Color) {
		const c = cur();
		Draw.Quad(CalculateCentre(c.canvasBottomLeft, c.canvasSize, Anchor.BottomLeft), c.canvasSize, col);
	},

	DrawLetterboxes() {
		const c = cur();
		const canvasTopRight = c.canvasBottomLeft.add(c.canvasSize);
		const col = Color.black;
		const ss = c.screenSize;
		if (c.canvasBottomLeft.x > 0) {
			const size = new Vector2(c.canvasBottomLeft.x, ss.y);
			Draw.Quad(CalculateCentre(Vector2.zero, size, Anchor.BottomLeft), size, col);
		}
		if (canvasTopRight.x < ss.x) {
			const size = new Vector2(ss.x - canvasTopRight.x, ss.y);
			Draw.Quad(CalculateCentre(Vector2.right.mul(canvasTopRight.x), size, Anchor.BottomLeft), size, col);
		}
		if (c.canvasBottomLeft.y > 0) {
			const size = new Vector2(ss.x, c.canvasBottomLeft.y);
			Draw.Quad(CalculateCentre(Vector2.zero, size, Anchor.BottomLeft), size, col);
		}
		if (canvasTopRight.y < ss.y) {
			const size = new Vector2(ss.x, ss.y - canvasTopRight.y);
			Draw.Quad(CalculateCentre(Vector2.up.mul(canvasTopRight.y), size, Anchor.BottomLeft), size, col);
		}
	},

	//  --------------------------- Helper functions ---------------------------
	ScreenToUISpace(point: Vector2): Vector2 {
		return point.sub(cur().canvasBottomLeft).div(scale());
	},

	UIToScreenSpaceBounds(bounds: Bounds2D): Bounds2D {
		return new Bounds2D(UI.UIToScreenSpace(bounds.Min), UI.UIToScreenSpace(bounds.Max));
	},

	UIToScreenSpace(point: Vector2): Vector2 {
		const s = scale();
		const bl = cur().canvasBottomLeft;
		return new Vector2(bl.x + point.x * s, bl.y + point.y * s);
	},

	CalculateSizeToFitElements(boundsSize: number, spacing: number, numElements: number): number {
		if (numElements <= 0) return 0;
		return (boundsSize - spacing * (numElements - 1)) / numElements;
	},

	CreateColouredText(text: string, color: Color): string {
		return `<color=#${color.toHtmlStringRGBA()}>${text}</color>`;
	},

	LineBreakByCharCount(text: string, maxCharsPerLine: number): string {
		maxCharsPerLine = Math.max(1, maxCharsPerLine);
		let sb = "";
		let textLenPrev = text.length;
		while (text.length > 0) {
			const [line, rest] = GetNextLine(text, maxCharsPerLine);
			sb += line + "\n";
			text = rest;
			if (text.length === textLenPrev) throw new Error("Failed to make progress");
			textLenPrev = text.length;
		}
		return sb;
	},

	GetColourPickerState(id: UIHandle): ColourPickerState {
		return getOrCreate(colPickerStates, id, () => new ColourPickerState());
	},
	GetInputFieldState(id: UIHandle): InputFieldState {
		return getOrCreate(inputFieldStates, id, () => new InputFieldState());
	},
	GetButtonState(id: UIHandle): ButtonState {
		return getOrCreate(buttonStates, id, () => new ButtonState());
	},
	GetScrollbarState(id: UIHandle): ScrollBarState {
		return getOrCreate(scrollbarStates, id, () => new ScrollBarState());
	},
	GetWheelSelectorState(id: UIHandle): WheelSelectorState {
		return getOrCreate(wheelSelectorStates, id, () => new WheelSelectorState());
	},

	ResetAllStates() {
		inputFieldStates.clear();
		colPickerStates.clear();
		buttonStates.clear();
		scrollbarStates.clear();
		wheelSelectorStates.clear();
	},

	OverridePreviousBounds(bounds: Bounds2D) {
		OnFinishedDrawingUIElementBounds(bounds);
	},
};

// Returns [line, remainingText]
function GetNextLine(text: string, maxLineLength: number): [string, string] {
	let word = "";
	let line = "";

	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (c === " " || c === "\n" || i === text.length - 1) {
			if (c !== " " && c !== "\n") word += c;

			if (word.length > 0) {
				if (line.length + word.length <= maxLineLength) {
					line += word;
					word = "";
				} else {
					if (word.length > maxLineLength) {
						line += word;
						line = line.substring(0, maxLineLength);
					}
					break;
				}
			}

			if (c === " ") line += c;
			if (c === "\n") {
				line += " ";
				break;
			}
		} else {
			if (line.length >= maxLineLength) break;
			word += c;
		}
	}

	const rest = text.length > line.length ? text.substring(line.length) : "";
	return [line.substring(0, Math.min(line.length, maxLineLength)), rest];
}

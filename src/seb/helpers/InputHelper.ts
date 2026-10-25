// Port of Seb.Helpers.InputHelper, with a DOM-based input source replacing UnityInputSource.
// All positions use Unity conventions: screen-space origin at bottom-left, in device pixels, y up.
import { Vector2 } from "../types/Vector2";
import { Bounds2D } from "../types/Bounds2D";
import { Time, Screen, Application } from "./Platform";

export enum MouseButton {
	Left = 0,
	Right = 1,
	Middle = 2,
}

// KeyCode values are KeyboardEvent.code strings
export const KeyCode = {
	A: "KeyA", B: "KeyB", C: "KeyC", D: "KeyD", E: "KeyE", F: "KeyF", G: "KeyG", H: "KeyH", I: "KeyI",
	J: "KeyJ", K: "KeyK", L: "KeyL", M: "KeyM", N: "KeyN", O: "KeyO", P: "KeyP", Q: "KeyQ", R: "KeyR",
	S: "KeyS", T: "KeyT", U: "KeyU", V: "KeyV", W: "KeyW", X: "KeyX", Y: "KeyY", Z: "KeyZ",
	Alpha0: "Digit0", Alpha1: "Digit1", Alpha2: "Digit2", Alpha3: "Digit3", Alpha4: "Digit4",
	Alpha5: "Digit5", Alpha6: "Digit6", Alpha7: "Digit7", Alpha8: "Digit8", Alpha9: "Digit9",
	Backspace: "Backspace", Delete: "Delete", Tab: "Tab", Escape: "Escape", Return: "Enter", KeypadEnter: "NumpadEnter",
	Space: "Space", LeftArrow: "ArrowLeft", RightArrow: "ArrowRight", UpArrow: "ArrowUp", DownArrow: "ArrowDown",
	PageUp: "PageUp", PageDown: "PageDown", Home: "Home", End: "End",
	LeftShift: "ShiftLeft", RightShift: "ShiftRight", LeftControl: "ControlLeft", RightControl: "ControlRight",
	LeftAlt: "AltLeft", RightAlt: "AltRight", LeftMeta: "MetaLeft", RightMeta: "MetaRight",
	Mouse0: "Mouse0",
} as const;
export type KeyCode = (typeof KeyCode)[keyof typeof KeyCode];

// Character corresponding to a key code (as Unity's (char)KeyCode, uppercased). Only for letters/digits.
export function KeyCodeToChar(code: string): string | null {
	if (code.startsWith("Key") && code.length === 4) return code[3];
	if (code.startsWith("Digit") && code.length === 6) return code[5];
	return null;
}

class DomInputSource {
	mousePosition = Vector2.zero;
	readonly keysHeld = new Set<string>();
	keysDown = new Set<string>();
	keysUp = new Set<string>();
	readonly mouseHeld = [false, false, false];
	mouseDown = [false, false, false];
	mouseUp = [false, false, false];
	inputString = "";
	scrollDelta = Vector2.zero;
	pasteText = "";
	anyDown = false;

	// Pending (accumulated between frames, applied at frame start)
	private pKeysDown = new Set<string>();
	private pKeysUp = new Set<string>();
	private pMouseDown = [false, false, false];
	private pMouseUp = [false, false, false];
	private pInput = "";
	private pScrollX = 0;
	private pScrollY = 0;
	private pPaste = "";
	private pMouseX = 0;
	private pMouseY = 0;

	attach(canvas: HTMLCanvasElement) {
		const mapButton = (b: number) => (b === 0 ? 0 : b === 2 ? 1 : b === 1 ? 2 : -1);

		const updateMouse = (e: MouseEvent) => {
			const rect = canvas.getBoundingClientRect();
			const sx = Screen.width / Math.max(1, rect.width);
			const sy = Screen.height / Math.max(1, rect.height);
			this.pMouseX = (e.clientX - rect.left) * sx;
			this.pMouseY = Screen.height - (e.clientY - rect.top) * sy;
		};

		window.addEventListener("pointermove", (e) => updateMouse(e));
		canvas.addEventListener("pointerdown", (e) => {
			updateMouse(e);
			canvas.focus();
			const b = mapButton(e.button);
			if (b >= 0) {
				this.pMouseDown[b] = true;
				this.mouseHeld[b] = true;
			}
			try {
				canvas.setPointerCapture(e.pointerId);
			} catch {
				/* ignore */
			}
			e.preventDefault();
		});
		window.addEventListener("pointerup", (e) => {
			updateMouse(e);
			const b = mapButton(e.button);
			if (b >= 0 && this.mouseHeld[b]) {
				this.pMouseUp[b] = true;
				this.mouseHeld[b] = false;
			}
		});
		canvas.addEventListener("contextmenu", (e) => e.preventDefault());
		canvas.addEventListener(
			"wheel",
			(e) => {
				e.preventDefault();
				// Unity reports ~1 unit per wheel notch (positive = scroll up)
				let scale = 1 / 100;
				if (e.deltaMode === 1) scale = 1 / 3;
				else if (e.deltaMode === 2) scale = 1;
				let dx = -e.deltaX * scale;
				let dy = -e.deltaY * scale;
				// Shift+wheel on some platforms reports horizontal scroll: keep vertical semantics
				if (e.shiftKey && dy === 0 && dx !== 0) {
					dy = dx;
					dx = 0;
				}
				this.pScrollX += dx;
				this.pScrollY += dy;
			},
			{ passive: false },
		);

		window.addEventListener("keydown", (e) => {
			const code = e.code || e.key;
			if (!this.keysHeld.has(code)) {
				this.pKeysDown.add(code);
				this.keysHeld.add(code);
			}
			if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) this.pInput += e.key;
			if (shouldPreventDefault(e)) e.preventDefault();
		});
		window.addEventListener("keyup", (e) => {
			const code = e.code || e.key;
			this.keysHeld.delete(code);
			this.pKeysUp.add(code);
			// On macOS, keyup events for other keys are not sent while Meta is held: clear them when Meta is released
			if (code === "MetaLeft" || code === "MetaRight") {
				for (const k of Array.from(this.keysHeld)) {
					if (k.startsWith("Key") || k.startsWith("Digit")) {
						this.keysHeld.delete(k);
						this.pKeysUp.add(k);
					}
				}
			}
		});
		window.addEventListener("paste", (e) => {
			this.pPaste += e.clipboardData?.getData("text") ?? "";
		});
		window.addEventListener("blur", () => {
			for (const k of this.keysHeld) this.pKeysUp.add(k);
			this.keysHeld.clear();
			for (let i = 0; i < 3; i++) {
				if (this.mouseHeld[i]) this.pMouseUp[i] = true;
				this.mouseHeld[i] = false;
			}
		});
	}

	// Apply all events received since the last frame
	beginFrame() {
		this.keysDown = this.pKeysDown;
		this.keysUp = this.pKeysUp;
		this.pKeysDown = new Set();
		this.pKeysUp = new Set();
		this.mouseDown = this.pMouseDown;
		this.mouseUp = this.pMouseUp;
		this.pMouseDown = [false, false, false];
		this.pMouseUp = [false, false, false];
		this.inputString = this.pInput;
		this.pInput = "";
		this.scrollDelta = new Vector2(this.pScrollX, this.pScrollY);
		this.pScrollX = 0;
		this.pScrollY = 0;
		this.pasteText = this.pPaste;
		this.pPaste = "";
		this.mousePosition = new Vector2(this.pMouseX, this.pMouseY);
		this.anyDown = this.keysDown.size > 0 || this.mouseDown[0] || this.mouseDown[1] || this.mouseDown[2];
	}
}

function shouldPreventDefault(e: KeyboardEvent): boolean {
	// Let the browser handle devtools / reload / fullscreen keys
	if (e.code.startsWith("F") && e.code.length <= 3) return false;
	const mod = e.ctrlKey || e.metaKey;
	if (mod) {
		// Keep native clipboard behaviour so 'paste' events fire
		if (e.code === "KeyV" || e.code === "KeyC" || e.code === "KeyX") return false;
		if (e.shiftKey && e.code === "KeyI") return false;
		return true;
	}
	return ["Tab", "Space", "Backspace", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End", "Enter", "AltLeft", "AltRight", "Slash", "Quote"].includes(e.code);
}

const source = new DomInputSource();
let leftMouseDownConsumeFrame = -1;
let rightMouseDownConsumeFrame = -1;
let middleMouseDownConsumeFrame = -1;

// World camera transform (set by CameraController each frame)
export const WorldCam = {
	orthographicSize: 5,
	posX: 0,
	posY: 0,
	get aspect(): number {
		return Screen.width / Math.max(1, Screen.height);
	},
	ScreenToWorldPoint(p: Vector2): Vector2 {
		const halfH = WorldCam.orthographicSize;
		const halfW = halfH * WorldCam.aspect;
		return new Vector2(WorldCam.posX + (p.x / Screen.width - 0.5) * 2 * halfW, WorldCam.posY + (p.y / Screen.height - 0.5) * 2 * halfH);
	},
	WorldToScreenPoint(p: Vector2): Vector2 {
		const halfH = WorldCam.orthographicSize;
		const halfW = halfH * WorldCam.aspect;
		return new Vector2(((p.x - WorldCam.posX) / (2 * halfW) + 0.5) * Screen.width, ((p.y - WorldCam.posY) / (2 * halfH) + 0.5) * Screen.height);
	},
};

let prevWorldMousePos = Vector2.zero;
let prevWorldMouseFrame = -1;

export const InputHelper = {
	Attach(canvas: HTMLCanvasElement) {
		source.attach(canvas);
	},
	BeginFrame() {
		source.beginFrame();
	},

	get MousePos(): Vector2 {
		return source.mousePosition;
	},
	get InputStringThisFrame(): string {
		return source.inputString;
	},
	get AnyKeyOrMouseDownThisFrame(): boolean {
		return source.anyDown;
	},
	get AnyKeyOrMouseHeldThisFrame(): boolean {
		return source.keysHeld.size > 0 || source.mouseHeld[0] || source.mouseHeld[1] || source.mouseHeld[2];
	},
	get MouseScrollDelta(): Vector2 {
		return source.scrollDelta;
	},

	get MousePosWorld(): Vector2 {
		if (Time.frameCount !== prevWorldMouseFrame) {
			prevWorldMousePos = WorldCam.ScreenToWorldPoint(source.mousePosition);
			prevWorldMouseFrame = Time.frameCount;
		}
		return prevWorldMousePos;
	},

	// Must be called if the camera moves during a frame, so that the cached world mouse pos is refreshed
	InvalidateWorldMouseCache() {
		prevWorldMouseFrame = -1;
	},

	get ShiftIsHeld(): boolean {
		return source.keysHeld.has(KeyCode.LeftShift) || source.keysHeld.has(KeyCode.RightShift);
	},
	// (Cmd on macOS is treated as Ctrl)
	get CtrlIsHeld(): boolean {
		const k = source.keysHeld;
		return k.has(KeyCode.LeftControl) || k.has(KeyCode.RightControl) || k.has(KeyCode.LeftMeta) || k.has(KeyCode.RightMeta);
	},
	get AltIsHeld(): boolean {
		return source.keysHeld.has(KeyCode.LeftAlt) || source.keysHeld.has(KeyCode.RightAlt);
	},

	IsKeyDownThisFrame(key: string): boolean {
		return source.keysDown.has(key);
	},
	IsKeyUpThisFrame(key: string): boolean {
		return source.keysUp.has(key);
	},
	IsKeyHeld(key: string): boolean {
		return source.keysHeld.has(key);
	},

	IsMouseInGameWindow(): boolean {
		const m = source.mousePosition;
		return m.x >= 0 && m.y >= 0 && m.x < Screen.width && m.y < Screen.height;
	},

	MouseInBounds_ScreenSpace(centreOrBounds: Vector2 | Bounds2D, size?: Vector2): boolean {
		if (!Application.isPlaying) return false;
		if (centreOrBounds instanceof Bounds2D) return centreOrBounds.PointInBounds(source.mousePosition);
		const m = source.mousePosition;
		return Math.abs(m.x - centreOrBounds.x) < size!.x / 2 && Math.abs(m.y - centreOrBounds.y) < size!.y / 2;
	},

	MouseInPoint_ScreenSpace(centre: Vector2, radius: number): boolean {
		const m = source.mousePosition;
		const dx = m.x - centre.x;
		const dy = m.y - centre.y;
		return dx * dx + dy * dy < radius * radius;
	},

	MouseInsidePoint_World(centre: Vector2, radius: number): boolean {
		const m = InputHelper.MousePosWorld;
		const dx = m.x - centre.x;
		const dy = m.y - centre.y;
		return dx * dx + dy * dy < radius * radius;
	},

	MouseInsideBounds_World(centreOrBounds: Vector2 | Bounds2D, size?: Vector2): boolean {
		const m = InputHelper.MousePosWorld;
		if (centreOrBounds instanceof Bounds2D) return centreOrBounds.PointInBounds(m);
		return Math.abs(m.x - centreOrBounds.x) < size!.x / 2 && Math.abs(m.y - centreOrBounds.y) < size!.y / 2;
	},

	IsMouseHeld(button: MouseButton): boolean {
		return source.mouseHeld[button];
	},

	// Check if mouse button was pressed this frame. Optionally consume the event, so it will return false for other callers this frame.
	IsMouseDownThisFrame(button: MouseButton, consumeEvent = false): boolean {
		if (MouseDownEventIsConsumed(button)) return false;
		if (consumeEvent) InputHelper.ConsumeMouseButtonDownEvent(button);
		return source.mouseDown[button];
	},

	IsAnyMouseButtonDownThisFrame_IgnoreConsumed(): boolean {
		return source.mouseDown[0] || source.mouseDown[1] || source.mouseDown[2];
	},

	ConsumeMouseButtonDownEvent(button: MouseButton) {
		if (button === MouseButton.Left) leftMouseDownConsumeFrame = Time.frameCount;
		else if (button === MouseButton.Right) rightMouseDownConsumeFrame = Time.frameCount;
		else if (button === MouseButton.Middle) middleMouseDownConsumeFrame = Time.frameCount;
	},

	IsMouseUpThisFrame(button: MouseButton): boolean {
		return source.mouseUp[button];
	},

	CopyToClipboard(s: string) {
		try {
			void navigator.clipboard?.writeText(s);
		} catch {
			/* ignore */
		}
	},

	// Text pasted (via the browser's paste event) this frame
	GetClipboardContents(): string {
		return source.pasteText;
	},
};

function MouseDownEventIsConsumed(button: MouseButton): boolean {
	const last = button === MouseButton.Left ? leftMouseDownConsumeFrame : button === MouseButton.Right ? rightMouseDownConsumeFrame : middleMouseDownConsumeFrame;
	return Time.frameCount === last;
}

// Port of Seb.Vis.UI.UIStates
import { Color } from "../../types/Color";
import { Time } from "../../helpers/Platform";
import { GetHSV } from "../../helpers/ColHelper";

export class WheelSelectorState {
	index = 0;
}

export class ScrollBarState {
	dragScrollOffset = 0;
	isDragging = false;
	scrollY = 0;
}

export class SliderState {
	progressT = 0;
	handleSelected = false;
}

export class ColourPickerState {
	hue = 0;
	sat = 0;
	val = 0;
	satValHandleSelected = false;
	hueHandleSelected = false;

	GetRGB(): Color {
		return Color.HSVToRGB(this.hue, this.sat, this.val);
	}

	SetRGB(col: Color) {
		[this.hue, this.sat, this.val] = GetHSV(col);
	}
}

export class ButtonState {
	private buttonPressFrame = -1;
	private buttonReleaseFrame = -1;
	isDown = false;
	toggleState = false;

	get ButtonPressedThisFrame() {
		return this.buttonPressFrame === Time.frameCount;
	}
	get ButtonReleasedThisFrame() {
		return this.buttonReleaseFrame === Time.frameCount;
	}

	NotifyPressed() {
		this.isDown = true;
		this.buttonPressFrame = Time.frameCount;
	}
	NotifyReleased() {
		this.isDown = false;
		this.buttonReleaseFrame = Time.frameCount;
	}
	NotifyCancelled() {
		this.isDown = false;
	}
}

export class TriggerState {
	lastManualTime = 0;
	lastAutoTiggerTime = 0;
}

function isWhiteSpace(c: string): boolean {
	return /\s/.test(c);
}

export class InputFieldState {
	arrowKeyTrigger = new TriggerState();
	backspaceTrigger = new TriggerState();
	deleteTrigger = new TriggerState();
	cursorBeforeCharIndex = 0;
	isMouseDownInBounds = false;
	isSelecting = false;
	lastInputTime = 0;
	selectionStartIndex = 0;
	private _text = "";
	private _focused = false;

	get text() {
		return this._text;
	}
	get focused() {
		return this._focused;
	}

	get SelectionMinIndex() {
		return Math.min(this.selectionStartIndex, this.cursorBeforeCharIndex);
	}
	get SelectionMaxIndex() {
		return Math.max(this.selectionStartIndex, this.cursorBeforeCharIndex);
	}

	ClearText() {
		this._text = "";
		this.cursorBeforeCharIndex = 0;
		this.isSelecting = false;
	}

	SetFocus(newFocusState: boolean) {
		if (newFocusState !== this._focused) {
			this._focused = newFocusState;
			this.lastInputTime = Time.time;
			if (!newFocusState) this.isSelecting = false;
		}
	}

	Delete(deleteLeft: boolean, validation?: ((s: string) => boolean) | null) {
		if (this._text.length === 0) return;

		if (this.isSelecting) {
			this.isSelecting = false;
			const deleteStartIndex = Math.min(this.cursorBeforeCharIndex, this.selectionStartIndex);
			const deleteCount = Math.abs(this.cursorBeforeCharIndex - this.selectionStartIndex);
			const newText = this._text.substring(0, deleteStartIndex) + this._text.substring(deleteStartIndex + deleteCount);

			if (!validation || validation(newText)) {
				this._text = newText;
				if (this.cursorBeforeCharIndex > this.selectionStartIndex) this.SetCursorIndex(this.selectionStartIndex);
			}
		} else {
			if (deleteLeft && this.cursorBeforeCharIndex > 0) {
				const i = this.cursorBeforeCharIndex - 1;
				const newText = this._text.substring(0, i) + this._text.substring(i + 1);
				if (!validation || validation(newText)) {
					this._text = newText;
					this.DecrementCursor();
				}
			} else if (!deleteLeft && this.cursorBeforeCharIndex < this._text.length) {
				const i = this.cursorBeforeCharIndex;
				const newText = this._text.substring(0, i) + this._text.substring(i + 1);
				if (!validation || validation(newText)) this._text = newText;
			}
		}

		this.UpdateLastInputTime();
	}

	SelectAll() {
		this.SetCursorIndex(0);
		this.SetCursorIndex(this._text.length, true);
	}

	SetCursorIndex(i: number, select = false) {
		if (select && !this.isSelecting) {
			this.isSelecting = true;
			this.selectionStartIndex = this.cursorBeforeCharIndex;
		}

		this.cursorBeforeCharIndex = Math.max(0, Math.min(this._text.length, i));
		this.UpdateLastInputTime();

		if (this.cursorBeforeCharIndex === this.selectionStartIndex || !select) this.isSelecting = false;
	}

	UpdateLastInputTime() {
		this.lastInputTime = Time.time;
	}

	SetText(newText: string | null | undefined, focus = true) {
		this._text = newText ? newText : "";
		this.SetCursorIndex(this._text.length);
		this.SetFocus(focus);
	}

	TryInsertText(textToAdd: string, validation?: ((s: string) => boolean) | null) {
		const originalText = this._text;
		if (this.isSelecting) this.Delete(true);

		let newText = this._text;
		if (this.cursorBeforeCharIndex === this._text.length) newText += textToAdd;
		else newText = newText.substring(0, this.cursorBeforeCharIndex) + textToAdd + newText.substring(this.cursorBeforeCharIndex);

		if (!validation || validation(newText)) {
			this._text = newText;
			this.SetCursorIndex(this.cursorBeforeCharIndex + textToAdd.length);
		} else this._text = originalText;
	}

	IncrementCursor(select = false) {
		if (this.isSelecting && !select) this.SetCursorIndex(this.SelectionMaxIndex);
		else this.SetCursorIndex(this.cursorBeforeCharIndex + 1, select);
	}

	DecrementCursor(select = false) {
		if (this.isSelecting && !select) this.SetCursorIndex(this.SelectionMinIndex);
		else this.SetCursorIndex(this.cursorBeforeCharIndex - 1, select);
	}

	NextWordEndIndex(): number {
		let hasEncounteredNonSpaceChar = false;
		for (let i = this.cursorBeforeCharIndex; i < this._text.length; i++) {
			if (isWhiteSpace(this._text[i]) && hasEncounteredNonSpaceChar) return i;
			if (!isWhiteSpace(this._text[i])) hasEncounteredNonSpaceChar = true;
		}
		return this._text.length;
	}

	PrevWordIndex(): number {
		let hasEncounteredNonSpaceChar = false;
		for (let i = this.cursorBeforeCharIndex - 1; i >= 0; i--) {
			if (isWhiteSpace(this._text[i]) && hasEncounteredNonSpaceChar) return i + 1;
			if (!isWhiteSpace(this._text[i])) hasEncounteredNonSpaceChar = true;
		}
		return 0;
	}
}

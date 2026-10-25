// Port of DLS.Game.InteractionState
// Note: updated when drawing world
import type { IInteractable } from "./elements/Interfaces";
import { PinInstance } from "./elements/PinInstance";

const unspecifiedElement: IInteractable = { isInteractable: true };

export const InteractionState = {
	MouseIsOverUI: false,

	// The interactable element currently under the mouse.
	// Note: set to null prior to drawing each frame, and set during the drawing process
	ElementUnderMouse: null as IInteractable | null,
	ElementUnderMousePrevFrame: null as IInteractable | null,

	get PinUnderMouse(): PinInstance | null {
		const e = InteractionState.ElementUnderMouse;
		return e instanceof PinInstance ? e : null;
	},

	NotifyElementUnderMouse(element: IInteractable) {
		InteractionState.ElementUnderMouse = element;
	},

	// Notify that something is under the mouse, without specifying what it is.
	// Useful for interactions with sub-elements (such as the status display on an input pin) which don't have their own associated object and are handled specially
	NotifyUnspecifiedElementUnderMouse() {
		InteractionState.NotifyElementUnderMouse(unspecifiedElement);
	},

	ClearFrame() {
		InteractionState.ElementUnderMousePrevFrame = InteractionState.ElementUnderMouse;
		InteractionState.ElementUnderMouse = null;
	},

	Reset() {
		InteractionState.ElementUnderMouse = null;
		InteractionState.MouseIsOverUI = false;
	},
};

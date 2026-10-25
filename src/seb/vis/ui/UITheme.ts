// Port of Seb.Vis.UI.UITheme / UIThemeLibrary / UIHandle / UILayoutHelper
// Note: these were C# structs (value types). Use the clone helpers before mutating a copy.
import { Color } from "../../types/Color";
import { Vector2 } from "../../types/Vector2";
import { Anchor, FontType } from "../Anchor";
import { Brighten } from "../../helpers/ColHelper";

export class StateCols {
	constructor(
		public normal: Color,
		public hover: Color,
		public pressed: Color,
		public inactive: Color,
	) {}

	GetCol(isHover: boolean, isPressed: boolean, isActive: boolean): Color {
		if (!isActive) return this.inactive;
		if (isPressed && isHover) return this.pressed;
		if (isHover) return this.hover;
		return this.normal;
	}

	clone(): StateCols {
		return new StateCols(this.normal, this.hover, this.pressed, this.inactive);
	}
}

export interface ButtonTheme {
	font: FontType;
	fontSize: number;
	textCols: StateCols;
	buttonCols: StateCols;
	paddingScale: Vector2;
}

export function cloneButtonTheme(t: ButtonTheme): ButtonTheme {
	return { font: t.font, fontSize: t.fontSize, textCols: t.textCols.clone(), buttonCols: t.buttonCols.clone(), paddingScale: t.paddingScale };
}

export interface InputFieldTheme {
	font: FontType;
	fontSize: number;
	defaultTextCol: Color;
	textCol: Color;
	bgCol: Color;
	focusBorderCol: Color;
}

export interface ScrollViewTheme {
	backgroundCol: Color;
	scrollBarColBackground: Color;
	scrollBarColInactive: Color;
	scrollBarColNormal: Color;
	scrollBarColHover: Color;
	scrollBarColPressed: Color;
	padding: number;
	scrollBarWidth: number;
}

export interface CheckboxTheme {
	boxCol: Color;
	tickCol: Color;
}

export interface WheelSelectorTheme {
	buttonTheme: ButtonTheme;
	backgroundCol: Color;
	textCol: Color;
	inactiveTextCol: Color;
}

export function cloneWheelSelectorTheme(t: WheelSelectorTheme): WheelSelectorTheme {
	return { buttonTheme: cloneButtonTheme(t.buttonTheme), backgroundCol: t.backgroundCol, textCol: t.textCol, inactiveTextCol: t.inactiveTextCol };
}

export const UIThemeLibrary = {
	FontSizeSmall: 1,
	FontSizeMedium: 1.5,
	FontSizeLarge: 2,
	FontSizeVeryLarge: 3,
	FontSizeButton: 1.5,
	DefaultFont: FontType.JetbrainsMonoBold,
	FontSizeDefault: 1.5,
	PaddingScaleButton: new Vector2(1.2, 1.5),
};

function MakeCol(r: number, g: number, b: number) {
	return new Color(r / 255, g / 255, b / 255, 1);
}

const red = { Base: MakeCol(207, 101, 101), AccentBright: MakeCol(243, 168, 168), AccentDark: MakeCol(180, 90, 90), Inactive: MakeCol(160, 130, 130) };

export const RedTheme_Button: ButtonTheme = {
	font: UIThemeLibrary.DefaultFont,
	fontSize: UIThemeLibrary.FontSizeDefault,
	textCols: new StateCols(Color.white, Color.white, Color.white, Brighten(red.Inactive, 0.1)),
	buttonCols: new StateCols(red.Base, red.AccentBright, red.AccentDark, red.Inactive),
	paddingScale: UIThemeLibrary.PaddingScaleButton,
};

// UIHandle: (stringID, intID) pair. Represented as a string key for use in maps.
export type UIHandle = string;
export function UIHandle(stringID: string, intID = 0): UIHandle {
	return intID === 0 ? stringID : `${stringID}#${intID}`;
}

// ---- UILayoutHelper ----
export const DefaultSpacing = 0.5;

export function HorizontalLayout(numElements: number, elementIndex: number, centre: Vector2, size: Vector2, spacing = DefaultSpacing): [Vector2, Vector2] {
	const spaceTotal = (numElements - 1) * spacing;
	const elementWidth = (size.x - spaceTotal) / numElements;
	const posX = centre.x - size.x / 2 + elementWidth / 2 + (spacing + elementWidth) * elementIndex;
	return [new Vector2(elementWidth, size.y), new Vector2(posX, centre.y)];
}

export function HorizontalLayoutAnchored(numElements: number, elementIndex: number, pos: Vector2, size: Vector2, anchor: Anchor, spacing = DefaultSpacing): [Vector2, Vector2] {
	return HorizontalLayout(numElements, elementIndex, CalculateCentre(pos, size, anchor), size, spacing);
}

export function CalculateCentre(pos: Vector2, size: Vector2, anchor: Anchor): Vector2 {
	switch (anchor) {
		case Anchor.Centre:
			return pos;
		case Anchor.CentreLeft:
			return new Vector2(pos.x + size.x / 2, pos.y);
		case Anchor.CentreRight:
			return new Vector2(pos.x - size.x / 2, pos.y);
		case Anchor.TopLeft:
			return new Vector2(pos.x + size.x / 2, pos.y - size.y / 2);
		case Anchor.TopRight:
			return new Vector2(pos.x - size.x / 2, pos.y - size.y / 2);
		case Anchor.CentreTop:
			return new Vector2(pos.x, pos.y - size.y / 2);
		case Anchor.BottomLeft:
			return new Vector2(pos.x + size.x / 2, pos.y + size.y / 2);
		case Anchor.BottomRight:
			return new Vector2(pos.x - size.x / 2, pos.y + size.y / 2);
		case Anchor.CentreBottom:
			return new Vector2(pos.x, pos.y + size.y / 2);
		default:
			return pos;
	}
}

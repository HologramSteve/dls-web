// Port of DLS.Graphics.DrawSettings
import { Color } from "../../seb/types/Color";
import { Vector2 } from "../../seb/types/Vector2";
import { FontType } from "../../seb/vis/Anchor";
import { Brighten, Darken, MakeCol, MakeCol255 } from "../../seb/helpers/ColHelper";
import { ButtonTheme, CheckboxTheme, InputFieldTheme, ScrollViewTheme, StateCols, UIThemeLibrary, WheelSelectorTheme } from "../../seb/vis/ui/UITheme";

// ---- World draw settings ----
export const GridSize = 0.125;
export const PinHeight1Bit = 0.185;
export const PinHeight4Bit = 0.3;
export const PinHeight8Bit = 0.43;
export const PinRadius = PinHeight1Bit / 2;

export const FontBold = FontType.JetbrainsMonoBold;
export const FontRegular = FontType.JetbrainsMonoRegular;

export const FontSizeChipName = 0.25;
export const FontSizePinLabel = 0.2;

export const SubChipPinInset = 0.015;
export const SelectionBoundsPadding = 0.08;
export const ChipOutlineWidth = 0.05;
export const WireThickness = 0.025;
export const WireHighlightedThickness = WireThickness + 0.012;
export const GridThickness = 0.0035;
export const DevPinStateDisplayRadius = 0.2;
export const DevPinStateDisplayOutline = 0.0175;
export const DevPinHandleWidth = DevPinStateDisplayRadius * 0.64;
export const MultiBitPinStateDisplaySquareSize = 0.21;

// ---- UI draw settings ----
export const PanelUIPadding = 1.15 * 2;
export const SpacingUnitUI = 0.5;
export const ChipNameLineSpacing = 0.75;
export const VerticalButtonSpacing = 1;
export const HorizontalButtonSpacing = 0.5;
export const SelectorWheelHeight = 2.8;
export const ButtonHeight = 2.5;

export const DefaultButtonSpacing = SpacingUnitUI * 1;
export const InfoBarHeight = 3.5;
export const LabelBackgroundPadding = new Vector2(0.15, 0.1);

export interface ThemeDLS {
	BackgroundCol: Color;
	DevPinHandle: Color;
	DevPinHandleHighlighted: Color;
	GridCol: Color;
	PinCol: Color;
	PinHighlightCol: Color;
	PinInvalidCol: Color;
	PinLabelCol: Color;
	SelectionBoxCol: Color;
	SelectionBoxInvalidCol: Color;
	SelectionBoxMovingCol: Color;
	SelectionBoxOtherIsInvaldCol: Color;
	SevenSegCols: Color[]; // Off, On, Highlight
	StateDisconnectedCol: Color;
	StateHighCol: Color[];
	StateHoverCol: Color[];
	StateLowCol: Color[];
}

export interface UIThemeDLS {
	ButtonTheme: ButtonTheme;
	CheckBoxTheme: CheckboxTheme;
	ChipButton: ButtonTheme; // Bottom bar -> chip buttons
	ChipLibraryChipToggleOff: ButtonTheme;
	ChipLibraryChipToggleOn: ButtonTheme;
	ChipLibraryCollectionToggleOff: ButtonTheme;
	ChipLibraryCollectionToggleOn: ButtonTheme;
	ChipNameInputField: InputFieldTheme;
	FontBold: FontType;
	FontRegular: FontType;
	FontSizeRegular: number;
	InfoBarCol: Color;
	MainMenuButtonTheme: ButtonTheme; // Main menu buttons
	MenuBackgroundOverlayCol: Color;
	MenuButtonTheme: ButtonTheme; // Bottom bar -> menu button
	MenuPanelCol: Color;
	MenuPopupButtonTheme: ButtonTheme; // Bottom bar -> menu -> popup buttons theme
	OptionsWheel: WheelSelectorTheme;
	ProjectSelectionButton: ButtonTheme; // Main menu -> load project -> unselected project button
	ProjectSelectionButtonSelected: ButtonTheme; // Main menu -> load project -> selected project button
	ScrollTheme: ScrollViewTheme;
	StarredBarCol: Color;
}

function CreateTheme(): ThemeDLS {
	const whiteLow = 0.35;
	const whiteHigh = 0.9;
	const stateLow = [
		new Color(0.2, 0.1, 0.1),
		new Color(0.28, 0.15, 0.01),
		new Color(0.26, 0.2, 0.07),
		new Color(0.1, 0.2, 0.1),
		new Color(0.1, 0.14, 0.35),
		new Color(0.19, 0.12, 0.28),
		new Color(0.25, 0.1, 0.25),
		new Color(whiteLow, whiteLow, whiteLow),
	];
	const stateHigh = [
		new Color(0.95, 0.3, 0.31),
		new Color(0.92, 0.44, 0.12),
		new Color(0.98, 0.76, 0.26),
		new Color(0.25, 0.66, 0.31),
		new Color(0.2, 0.5, 1),
		new Color(0.6, 0.4, 0.98),
		new Color(0.84, 0.33, 0.9),
		new Color(whiteHigh, whiteHigh, whiteHigh),
	];
	const stateHover = stateLow.map((c) => Brighten(c, 0.075));

	return {
		SelectionBoxCol: new Color(1, 1, 1, 0.1),
		SelectionBoxMovingCol: new Color(1, 1, 1, 0.125),
		SelectionBoxInvalidCol: MakeCol255(243, 81, 75, 120),
		SelectionBoxOtherIsInvaldCol: MakeCol255(243, 150, 75, 80),
		StateLowCol: stateLow,
		StateHighCol: stateHigh,
		StateHoverCol: stateHover,
		StateDisconnectedCol: Color.black,
		DevPinHandle: MakeCol(0.31),
		DevPinHandleHighlighted: MakeCol(0.7),
		PinCol: Color.black,
		PinLabelCol: new Color(0, 0, 0, 0.7),
		PinHighlightCol: Color.white,
		PinInvalidCol: MakeCol(0.15),
		SevenSegCols: [
			new Color(0.1, 0.09, 0.09), new Color(1, 0.32, 0.28), new Color(0.19, 0.15, 0.15), // Col A: OFF, ON, HIGHLIGHT
			new Color(0.09, 0.09, 0.1), new Color(0, 0.61, 1), new Color(0.15, 0.15, 0.19), // Col B: OFF, ON, HIGHLIGHT
		],
		BackgroundCol: MakeCol255(66, 66, 69),
		GridCol: MakeCol255(49, 49, 51),
	};
}

function CreateUITheme(): UIThemeDLS {
	const fontRegular = FontRegular;
	const fontBold = FontBold;
	const fontSizeRegular = UIThemeLibrary.FontSizeMedium;

	const inactiveButtonCol = MakeCol255(62);
	const inactiveTextol = MakeCol255(125);
	const menuPanelCol = MakeCol255(41);
	const chipLibraryCollectionHighlightCol = MakeCol(0.97, 0.47, 0.47);
	const chipLibraryChipHighlightCol = MakeCol(0.32, 0.61, 0.85);
	const scrollBarCol = new Color(0.42, 0.34, 0.67);

	const MakeButtonThemeFull = (font: FontType, colNormal: Color, colHover: Color, colPress: Color, colInactive: Color, textNormal: Color, textHover: Color, textPress: Color, textInactive: Color): ButtonTheme => ({
		font,
		fontSize: fontSizeRegular,
		paddingScale: UIThemeLibrary.PaddingScaleButton,
		buttonCols: new StateCols(colNormal, colHover, colPress, colInactive),
		textCols: new StateCols(textNormal, textHover, textPress, textInactive),
	});
	const MakeButtonTheme = (font: FontType, colNormal: Color, colHover: Color, colPress: Color, textNormal: Color, textHover: Color, textPress: Color) => MakeButtonThemeFull(font, colNormal, colHover, colPress, inactiveButtonCol, textNormal, textHover, textPress, inactiveTextol);
	const MakeButtonThemeAuto = (font: FontType, colNormal: Color, textCol: Color) => {
		const colHover = Brighten(colNormal, 0.2, -0.1);
		const colPress = Darken(colNormal, 0.05, 0.05);
		return MakeButtonThemeFull(font, colNormal, colHover, colPress, inactiveButtonCol, textCol, textCol, textCol, inactiveTextol);
	};

	return {
		FontRegular: fontRegular,
		FontBold: fontBold,
		FontSizeRegular: fontSizeRegular,
		MenuPanelCol: menuPanelCol,
		MenuBackgroundOverlayCol: new Color(0, 0, 0, 0.85),
		ButtonTheme: MakeButtonTheme(fontRegular, MakeCol255(64), MakeCol255(225), Color.white, Color.white, Color.black, Color.black),
		ProjectSelectionButton: MakeButtonTheme(fontRegular, Color.clear, MakeCol255(54, 58, 135), MakeCol255(95, 102, 240), Color.white, Color.white, Color.white),
		ProjectSelectionButtonSelected: MakeButtonTheme(fontRegular, MakeCol255(87, 94, 230), MakeCol255(87, 94, 230), MakeCol255(95, 102, 240), Color.white, Color.white, Color.white),
		ChipButton: MakeButtonTheme(fontRegular, MakeCol255(48), MakeCol255(225), Color.white, Color.white, Color.black, Color.black),
		MainMenuButtonTheme: MakeButtonTheme(fontRegular, MakeCol255(73, 73, 82), MakeCol255(72, 108, 233), MakeCol255(62, 116, 154), MakeCol255(228, 244, 255), Color.white, Color.white),
		MenuButtonTheme: MakeButtonTheme(fontRegular, MakeCol255(67, 104, 149), MakeCol255(89, 159, 229), MakeCol255(117, 186, 224), MakeCol255(228, 244, 255), Color.white, Color.white),
		MenuPopupButtonTheme: MakeButtonThemeFull(fontRegular, Color.white, MakeCol255(130, 190, 245), MakeCol255(145, 215, 245), MakeCol255(200), Color.black, Color.black, Color.black, inactiveTextol),

		ChipLibraryCollectionToggleOff: MakeButtonTheme(fontRegular, MakeCol(0.066), MakeCol(0.87), chipLibraryCollectionHighlightCol, Color.white, Color.black, Color.black),
		ChipLibraryCollectionToggleOn: MakeButtonThemeAuto(fontRegular, chipLibraryCollectionHighlightCol, Color.black),
		ChipLibraryChipToggleOff: MakeButtonTheme(fontRegular, MakeCol(0.15), MakeCol(0.87), chipLibraryChipHighlightCol, Color.white, Color.black, Color.black),
		ChipLibraryChipToggleOn: MakeButtonThemeAuto(fontRegular, chipLibraryChipHighlightCol, Color.black),

		ChipNameInputField: {
			font: fontBold,
			fontSize: UIThemeLibrary.FontSizeVeryLarge,
			bgCol: MakeCol255(20),
			defaultTextCol: MakeCol255(40),
			textCol: Color.white,
			focusBorderCol: Color.black,
		},
		OptionsWheel: {
			backgroundCol: Color.white,
			buttonTheme: MakeButtonTheme(fontBold, MakeCol255(207, 101, 101), MakeCol255(243, 168, 168), MakeCol255(180, 90, 90), Color.white, Color.white, Color.white),
			textCol: Color.black,
			inactiveTextCol: MakeCol(0.7),
		},
		ScrollTheme: {
			backgroundCol: MakeCol255(30),
			padding: 1,
			scrollBarColBackground: MakeCol255(25),
			scrollBarColInactive: MakeCol("#333333"),
			scrollBarColNormal: scrollBarCol,
			scrollBarColHover: Brighten(scrollBarCol, 0.05, -0.025),
			scrollBarColPressed: Darken(scrollBarCol, 0.05, 0.025),
			scrollBarWidth: 1,
		},
		CheckBoxTheme: { boxCol: Color.white, tickCol: Color.black },
		InfoBarCol: new Color(0, 0, 0, 0.9),
		StarredBarCol: MakeCol(29 / 255),
	};
}

// ---- Themes ----
export const ActiveTheme: ThemeDLS = CreateTheme();
export const ActiveUITheme: UIThemeDLS = CreateUITheme();

// ---- Helper functions ----
export function GetStateColour(isHigh: boolean, index: number, hover = false): Color {
	index = Math.min(index, ActiveTheme.StateHighCol.length - 1); // clamp just to be safe...
	if (!isHigh && hover) return ActiveTheme.StateHoverCol[index];
	return isHigh ? ActiveTheme.StateHighCol[index] : ActiveTheme.StateLowCol[index];
}

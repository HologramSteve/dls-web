// Port of Seb.Vis.Anchor
export enum Anchor {
	Centre,
	CentreLeft,
	CentreRight,
	CentreTop,
	CentreBottom,
	TopLeft,
	TopRight,
	BottomLeft,
	BottomRight,

	// Anchor text at centre left of first line. The vertical centre of the line
	// does not depend on the actual contents of the text here, which avoids the
	// positioning changing slightly based on the heights of the particular characters used.
	TextCentreLeft,
	TextCentreRight,
	TextFirstLineCentre,
	TextCentre,
}

export enum FontType {
	JetbrainsMonoBold,
	JetbrainsMonoRegular,
	Born2bSporty,
}

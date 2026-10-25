// Port of DLS.Description.Serializer and UnsavedChangeDetector.
// JSON format is compatible with the original (Newtonsoft) save files: enums as ints, Vector2 as {x,y}
// (rounded to 5 digits), Color as {r,g,b,a} with a always 1, DateTime as "yyyy-MM-ddTHH:mm:ss.fffK".
import { Vector2 } from "../../seb/types/Vector2";
import { Color } from "../../seb/types/Color";
import { roundDigits } from "../../seb/types/Mathf";
import { AppSettings, ChipCollection, ChipDescription, DefaultAppSettings, ProjectDescription } from "./Types";

function replacer(this: unknown, _key: string, value: unknown): unknown {
	if (value instanceof Vector2) {
		return { x: roundDigits(value.x, 5), y: roundDigits(value.y, 5) };
	}
	if (value instanceof Color) {
		return { r: value.r, g: value.g, b: value.b, a: 1 };
	}
	return value;
}

function Serialize(obj: unknown): string {
	return JSON.stringify(obj, replacer, 2);
}

function toV2(o: any): Vector2 {
	if (o instanceof Vector2) return o;
	if (o == null) return Vector2.zero;
	return new Vector2(+o.x || 0, +o.y || 0);
}

function toCol(o: any): Color {
	if (o instanceof Color) return o;
	if (o == null) return Color.clear;
	return new Color(+o.r, +o.g, +o.b, o.a == null ? 1 : +o.a);
}

function hydrateChip(d: any): ChipDescription {
	const desc: ChipDescription = {
		DLSVersion: d.DLSVersion ?? undefined,
		Name: d.Name ?? "",
		NameLocation: d.NameLocation ?? 0,
		ChipType: d.ChipType ?? 0,
		Size: toV2(d.Size),
		Colour: toCol(d.Colour),
		InputPins: (d.InputPins ?? []).map(hydratePin),
		OutputPins: (d.OutputPins ?? []).map(hydratePin),
		SubChips: (d.SubChips ?? []).map((s: any) => ({
			Name: s.Name,
			ID: s.ID,
			Label: s.Label ?? "",
			Position: toV2(s.Position),
			OutputPinColourInfo: s.OutputPinColourInfo ? s.OutputPinColourInfo.map((c: any) => ({ PinColour: c.PinColour, PinID: c.PinID })) : null,
			InternalData: s.InternalData ? s.InternalData.map((v: number) => v >>> 0) : null,
		})),
		Wires: (d.Wires ?? []).map((w: any) => ({
			SourcePinAddress: { PinID: w.SourcePinAddress.PinID, PinOwnerID: w.SourcePinAddress.PinOwnerID },
			TargetPinAddress: { PinID: w.TargetPinAddress.PinID, PinOwnerID: w.TargetPinAddress.PinOwnerID },
			ConnectionType: w.ConnectionType ?? 0,
			ConnectedWireIndex: w.ConnectedWireIndex ?? -1,
			ConnectedWireSegmentIndex: w.ConnectedWireSegmentIndex ?? -1,
			Points: (w.Points ?? []).map(toV2),
		})),
		Displays: d.Displays ? d.Displays.map((x: any) => ({ SubChipID: x.SubChipID, Position: toV2(x.Position), Scale: x.Scale })) : null,
	};
	return desc;
}

function hydratePin(p: any) {
	return { Name: p.Name ?? "", ID: p.ID, Position: toV2(p.Position), BitCount: p.BitCount ?? 1, Colour: p.Colour ?? 0, ValueDisplayMode: p.ValueDisplayMode ?? 0 };
}

function hydrateProject(d: any): ProjectDescription {
	return {
		ProjectName: d.ProjectName ?? "",
		DLSVersion_LastSaved: d.DLSVersion_LastSaved ?? "2.0.0",
		DLSVersion_EarliestCompatible: d.DLSVersion_EarliestCompatible ?? "2.0.0",
		CreationTime: d.CreationTime ?? FormatDateTime(new Date()),
		LastSaveTime: d.LastSaveTime ?? FormatDateTime(new Date(0)),
		Prefs_MainPinNamesDisplayMode: d.Prefs_MainPinNamesDisplayMode ?? 0,
		Prefs_ChipPinNamesDisplayMode: d.Prefs_ChipPinNamesDisplayMode ?? 0,
		Prefs_GridDisplayMode: d.Prefs_GridDisplayMode ?? 0,
		Prefs_Snapping: d.Prefs_Snapping ?? 0,
		Prefs_StraightWires: d.Prefs_StraightWires ?? 0,
		Prefs_SimPaused: d.Prefs_SimPaused ?? false,
		Prefs_SimTargetStepsPerSecond: d.Prefs_SimTargetStepsPerSecond ?? 0,
		Prefs_SimStepsPerClockTick: d.Prefs_SimStepsPerClockTick ?? 0,
		AllCustomChipNames: d.AllCustomChipNames ?? [],
		StarredList: (d.StarredList ?? []).map((s: any) => ({ Name: s.Name, IsCollection: !!s.IsCollection })),
		ChipCollections: (d.ChipCollections ?? []).map((c: any) => {
			const col = new ChipCollection(c.Name, c.Chips ?? []);
			col.IsToggledOpen = !!c.IsToggledOpen;
			return col;
		}),
	};
}

// "yyyy-MM-ddTHH:mm:ss.fffK" in local time with offset
export function FormatDateTime(d: Date): string {
	const pad = (n: number, l = 2) => String(Math.abs(n)).padStart(l, "0");
	const off = -d.getTimezoneOffset();
	const sign = off >= 0 ? "+" : "-";
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}${sign}${pad(Math.trunc(off / 60))}:${pad(off % 60)}`;
}

export function ParseDateTime(s: string): number {
	const t = Date.parse(s);
	return Number.isNaN(t) ? 0 : t;
}

export const Serializer = {
	SerializeAppSettings(settings: AppSettings): string {
		return Serialize(settings);
	},
	SerializeChipDescription(description: ChipDescription): string {
		return Serialize(description);
	},
	SerializeProjectDescription(description: ProjectDescription): string {
		return Serialize(description);
	},

	DeserializeAppSettings(s: string): AppSettings {
		try {
			return { ...DefaultAppSettings(), ...JSON.parse(s) };
		} catch (e) {
			console.error(e);
			return DefaultAppSettings();
		}
	},
	DeserializeChipDescription(s: string): ChipDescription {
		return hydrateChip(JSON.parse(stripBom(s)));
	},
	DeserializeProjectDescription(s: string): ProjectDescription {
		return hydrateProject(JSON.parse(stripBom(s)));
	},
};

function stripBom(s: string): string {
	return s.charCodeAt(0) === 0xfeff ? s.substring(1) : s;
}

// ---- UnsavedChangeDetector ----
const Epsilon = 0.0001;

// Test if two json strings are equivalent (ignoring formatting, approximate comparison for numbers)
export function IsEquivalentJson(jsonA: string, jsonB: string): boolean {
	try {
		return IsEquivalentToken(JSON.parse(jsonA), JSON.parse(jsonB));
	} catch {
		return false;
	}
}

function IsEquivalentToken(a: unknown, b: unknown): boolean {
	if (a === null && b === null) return true;
	if (a === null || b === null || a === undefined || b === undefined) return false;
	if (typeof a !== typeof b) return false;
	if (Array.isArray(a)) {
		if (!Array.isArray(b) || a.length !== b.length) return false;
		for (let i = 0; i < a.length; i++) if (!IsEquivalentToken(a[i], b[i])) return false;
		return true;
	}
	if (typeof a === "object") {
		if (Array.isArray(b)) return false;
		const ka = Object.keys(a as object);
		const kb = Object.keys(b as object);
		if (ka.length !== kb.length) return false;
		for (const k of ka) {
			if (!Object.hasOwn(b as object, k)) return false;
			if (!IsEquivalentToken((a as any)[k], (b as any)[k])) return false;
		}
		return true;
	}
	if (typeof a === "number") return Math.abs(a - (b as number)) < Epsilon;
	return a === b;
}

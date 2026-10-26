// Live collaboration (web-only addition): draws the other users in the room on top of the chip being edited
// (cursor + name, selection outlines, elements they are moving/placing, wire they are drawing).
import { WorldCam } from "../seb/helpers/InputHelper";
import { Color } from "../seb/types/Color";
import { Vector2 } from "../seb/types/Vector2";
import { Anchor } from "../seb/vis/Anchor";
import { Draw } from "../seb/vis/Draw";
import { Project } from "../dls/game/Project";
import { FontBold } from "../dls/graphics/DrawSettings";
import { MenuType, UIDrawer } from "../dls/graphics/ui/UIDrawer";
import { Collab } from "./Collab";

const colourCache = new Map<string, Color>();

function ParseColour(hex: string): Color {
	let c = colourCache.get(hex);
	if (!c) {
		const v = /^#([0-9a-f]{6})$/i.exec(hex) ? parseInt(hex.substring(1), 16) : 0x888888;
		c = new Color(((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255, 1);
		colourCache.set(hex, c);
	}
	return c;
}

export const PresenceDrawer = {
	Draw() {
		const project = Project.ActiveProject;
		if (!project || project.chipViewStack.length !== 1 || UIDrawer.ActiveMenu === MenuType.ChipCustomization) return;
		const peers = Collab.VisiblePeers;
		if (peers.length === 0) return;

		Draw.StartLayer(Vector2.zero, 1, false);
		// Keep a constant size on screen
		const s = WorldCam.orthographicSize * 0.035;
		const dev = project.ViewedChip;

		for (const peer of peers) {
			const p = peer.p!;
			const col = ParseColour(Collab.MemberColour(peer.uid));
			const faint = col.withAlpha(0.18);

			// Selected elements
			if (p.sel.length > 0) {
				const sel = new Set(p.sel);
				for (const e of dev.Elements) {
					if (!sel.has(e.ID)) continue;
					const b = e.SelectionBoundingBox;
					Draw.QuadOutline(b.Centre, b.Size, s * 0.12, col);
				}
			}

			// Elements being moved / placed
			for (let i = 0; i + 3 < p.g.length; i += 4) {
				const centre = new Vector2(p.g[i], p.g[i + 1]);
				const size = new Vector2(p.g[i + 2], p.g[i + 3]);
				Draw.Quad(centre, size, faint);
				Draw.QuadOutline(centre, size, s * 0.1, col);
			}

			// Wire being drawn
			for (let i = 0; i + 3 < p.w.length; i += 2) {
				Draw.Line(new Vector2(p.w[i], p.w[i + 1]), new Vector2(p.w[i + 2], p.w[i + 3]), s * 0.18, col.withAlpha(0.85));
			}

			// Cursor + name tag
			if (p.c && peer.hasPos) {
				const tip = new Vector2(peer.sx, peer.sy);
				Draw.Triangle(tip, tip.add(new Vector2(0, -s * 1.15)), tip.add(new Vector2(s * 0.8, -s * 0.8)), col);
				const name = Collab.MemberName(peer.uid);
				const fontSize = s * 0.75;
				const textSize = Draw.CalculateTextBoundsSize(name, fontSize, FontBold);
				const pad = new Vector2(s * 0.25, s * 0.18);
				const labelPos = tip.add(new Vector2(s * 0.75, -s * 1.35));
				const labelSize = textSize.add(pad.mul(2));
				Draw.Quad(labelPos.add(new Vector2(labelSize.x / 2, 0)), labelSize, col);
				const lum = col.r * 0.299 + col.g * 0.587 + col.b * 0.114;
				Draw.Text(FontBold, name, fontSize, labelPos.add(new Vector2(pad.x, 0)), Anchor.TextCentreLeft, lum > 0.6 ? Color.black : Color.white);
			}
		}
	},
};

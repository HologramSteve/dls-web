import { Draw } from "./seb/vis/Draw";
import { Vector2 } from "./seb/types/Vector2";
import { Color } from "./seb/types/Color";
import { Anchor, FontType } from "./seb/vis/Anchor";
import { Screen } from "./seb/helpers/Platform";

const canvas = document.getElementById("dls") as HTMLCanvasElement;
await Draw.LoadFonts("./fonts/");
Draw.Init(canvas);
function frame() {
	const dpr = window.devicePixelRatio || 1;
	canvas.width = Math.round(canvas.clientWidth * dpr);
	canvas.height = Math.round(canvas.clientHeight * dpr);
	Screen.width = canvas.width; Screen.height = canvas.height;
	Draw.BeginFrame(canvas.width, canvas.height);
	Draw.SetClearColour(new Color(66/255, 66/255, 69/255));
	Draw.SetCamera(0, 0, 5);
	Draw.StartLayer(Vector2.zero, 1, false);
	Draw.Quad(new Vector2(-2, 0), new Vector2(1.29, 0.5), new Color(0.73, 0.26, 0.26));
	Draw.Point(new Vector2(1, 1), 0.2, new Color(0.95, 0.3, 0.31));
	Draw.Line(new Vector2(-4, -2), new Vector2(3, -1), 0.025, Color.white);
	Draw.Diamond(new Vector2(2, -2), new Vector2(1, 0.2), Color.yellow);
	Draw.Text(FontType.JetbrainsMonoBold, "NAND", 0.25, new Vector2(-2, 0), Anchor.TextCentre, Color.white);
	Draw.StartLayer(Vector2.zero, 1, true);
	Draw.Text(FontType.Born2bSporty, "DIGITAL LOGIC SIM", 120, new Vector2(canvas.width/2, canvas.height*0.8), Anchor.Centre, Color.white);
	Draw.Quad(new Vector2(100, 50), new Vector2(150, 40), new Color(0.2,0.2,0.2));
	Draw.Text(FontType.JetbrainsMonoRegular, "MENU  Ctrl+N", 24, new Vector2(100, 50), Anchor.TextFirstLineCentre, Color.white);
	Draw.Render();
	(window as any).__frames = ((window as any).__frames || 0) + 1;
}
frame();

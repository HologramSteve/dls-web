// Entry point: port of DLS.Game.UnityMain (Awake / Update), driven by requestAnimationFrame instead of the Unity player loop.
import { AudioState } from "./dls/game/audio/AudioState";
import { CameraController } from "./dls/game/CameraController";
import { InteractionState } from "./dls/game/InteractionState";
import { Main } from "./dls/game/Main";
import { Project } from "./dls/game/Project";
import { MenuType, UIDrawer } from "./dls/graphics/ui/UIDrawer";
import { WorldDrawer } from "./dls/graphics/WorldDrawer";
import { FileSystem } from "./dls/saveSystem/FileSystem";
import { SimHost } from "./dls/simulation/SimHost";
import { InputHelper, WorldCam } from "./seb/helpers/InputHelper";
import { Screen, Time } from "./seb/helpers/Platform";
import { Draw } from "./seb/vis/Draw";

const canvas = document.getElementById("dls") as HTMLCanvasElement;

async function Awake() {
	await Promise.all([FileSystem.init(), Draw.LoadFonts("./fonts/")]);
	Draw.Init(canvas);
	InputHelper.Attach(canvas);
	SimHost.Start();

	const audioState = new AudioState();
	audioState.AttachUnlockListeners(window);
	SimHost.onAudio = (amplitudes) => audioState.SetAmplitudes(amplitudes);

	ResetStatics();
	Main.Init(audioState);
	Main.LoadMainMenu();

	// Make sure saves are flushed to IndexedDB before the page goes away
	window.addEventListener("pagehide", () => void FileSystem.sync());
	window.addEventListener("beforeunload", (e) => {
		const project = Project.ActiveProject;
		if (project && UIDrawer.ActiveMenu !== MenuType.MainMenu && project.ActiveChipHasUnsavedChanges()) e.preventDefault();
	});

	// Debug/test hook (used by browser tests to locate elements)
	(window as unknown as { dls: unknown }).dls = { Project, WorldCam, UIDrawer, IS: InteractionState, Main, Draw, SimHost };

	requestAnimationFrame(Update);
}

function Update(nowMs: number) {
	requestAnimationFrame(Update);

	// Resize drawing surface to match the canvas' displayed size (in device pixels)
	const dpr = window.devicePixelRatio || 1;
	const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
	const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
	if (canvas.width !== w || canvas.height !== h) {
		canvas.width = w;
		canvas.height = h;
	}
	Screen.width = w;
	Screen.height = h;
	Screen.devicePixelRatio = dpr;

	Time.BeginFrame(nowMs);
	InputHelper.BeginFrame();
	Draw.BeginFrame(w, h);

	try {
		Main.Update();
	} catch (e) {
		console.error(e);
	}

	Draw.Render();
}

// Ensure static state starts out reset
function ResetStatics() {
	UIDrawer.Reset();
	InteractionState.Reset();
	CameraController.Reset();
	WorldDrawer.Reset();
}

void Awake();

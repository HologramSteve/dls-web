// Port of DLS.Game.Project
// Web note: the original runs the simulation on a dedicated thread that reads input pins from (and writes pin states back to)
// the game objects directly. Here the simulation runs in a Web Worker (see SimHost / simWorker): every frame the main thread
// sends the input pin states + held keys, and the worker replies with a snapshot of the viewed chip's pin states.
import { InputHelper, KeyCode } from "../../seb/helpers/InputHelper";
import { CameraController } from "./CameraController";
import { ChipDescription, NameMatch, NameSet, type ProjectDescription, StarredItem } from "../description/Types";
import { PreferencesMenu } from "../graphics/ui/menus/PreferencesMenu";
import { SearchPopup } from "../graphics/ui/menus/SearchPopup";
import { MenuType, UIDrawer } from "../graphics/ui/UIDrawer";
import { CreateChipDescription } from "../saveSystem/DescriptionCreator";
import { Saver } from "../saveSystem/Saver";
import { SimHost, Simulator, type SimChipRef } from "../simulation/SimHost";
import type { AudioState } from "./audio/AudioState";
import { ChipInteractionController } from "./ChipInteractionController";
import type { ChipLibrary } from "./ChipLibrary";
import { DevChipInstance } from "./DevChipInstance";
import type { DevPinInstance } from "./elements/DevPinInstance";
import { SubChipInstance } from "./elements/SubChipInstance";
import { KeyboardShortcuts } from "./KeyboardShortcuts";

export enum SaveMode {
	Normal,
	Rename,
	SaveAs,
}

// Keys which can be bound to key chips (SimKeyboardHelper.ValidInputKeys)
const ValidInputKeys: [string, string][] = [];
for (const c of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") ValidInputKeys.push([(KeyCode as Record<string, string>)[c], c]);
for (let i = 0; i <= 9; i++) ValidInputKeys.push([(KeyCode as Record<string, string>)[`Alpha${i}`], String(i)]);

export class Project {
	static ActiveProject: Project;
	static readonly SimulationPerformanceTimeWindowSec = 1.5;

	// (web: not readonly, live collaboration replaces it when other users change the library)
	chipLibrary: ChipLibrary;

	controller!: ChipInteractionController;
	description: ProjectDescription;

	// ---- Display state ----
	get ShowGrid(): boolean {
		return this.description.Prefs_GridDisplayMode === 1;
	}
	PinNameDisplayIsTabToggledOn = false;

	// ---- Chip view / edit state ----
	// At the bottom of the stack is the chip that currently is being edited.
	// If chips are entered in view mode, they will be placed above on the stack.
	// (stack: last element is the top)
	readonly chipViewStack: DevChipInstance[] = [];

	private get ViewedSimChip(): SimChipRef {
		return this.ViewedChip.SimChip;
	}

	// The chip currently in view. This chip may be in view-only mode.
	get ViewedChip(): DevChipInstance {
		return this.chipViewStack[this.chipViewStack.length - 1];
	}
	get CanEditViewedChip(): boolean {
		return this.chipViewStack.length === 1;
	}
	get ActiveDevChipName(): string {
		return this.ViewedChip.ChipName;
	}
	get ChipHasBeenSavedBefore(): boolean {
		return this.ViewedChip.LastSavedDescription != null;
	}

	// String representation of the viewed chips stack for display purposes
	viewedChipsString = "";

	// The chip currently being edited. (This is not necessarily the currently viewed chip)
	private editModeChip!: DevChipInstance;
	audioState: AudioState | null = null;

	// ---- Simulation settings and state ----
	advanceSingleSimStep = false;
	private inputPins: DevPinInstance[] = [];
	private simStarted = false;
	private inputBuffer = new Int32Array(0);

	get targetTicksPerSecond(): number {
		return Math.max(1, this.description.Prefs_SimTargetStepsPerSecond);
	}
	get stepsPerClockTransition(): number {
		return this.description.Prefs_SimStepsPerClockTick;
	}
	get simPaused(): boolean {
		return this.description.Prefs_SimPaused;
	}
	get simAvgTicksPerSec(): number {
		return SimHost.simAvgTicksPerSec;
	}
	get simPausedSingleStepCounter(): number {
		return SimHost.simPausedSingleStepCounter;
	}
	get rootSimChip(): SimChipRef {
		return this.editModeChip.SimChip;
	}

	constructor(description: ProjectDescription, chipLibrary: ChipLibrary) {
		Project.ActiveProject = this;
		this.description = description;
		this.chipLibrary = chipLibrary;
		SearchPopup.ClearRecentChips();
	}

	Update() {
		this.HandleProjectInput();

		if (UIDrawer.ActiveMenu === MenuType.None || UIDrawer.ActiveMenu === MenuType.BottomBarMenuPopup) {
			this.controller.Update();
		}

		const keys = UIDrawer.ActiveMenu === MenuType.None ? GetHeldKeyChars() : "";

		this.inputPins = this.editModeChip.GetInputPins();
		this.SyncWithSimulation(keys);
	}

	// Replaces the original sim thread's per-frame sync: apply latest sim snapshot to the viewed chip, then send inputs for the next frame
	private SyncWithSimulation(keys: string) {
		if (!this.simStarted) return;

		// Update graphical state from sim
		// Note: update graphical state even when paused so that subchips are automatically if viewed
		this.ViewedChip.UpdateStateFromSim(this.ViewedSimChip, !this.CanEditViewedChip);

		// Player input states (input pin states are owned by the player, so are applied directly)
		const n = this.inputPins.length;
		if (this.inputBuffer.length !== n * 2) this.inputBuffer = new Int32Array(n * 2);
		for (let i = 0; i < n; i++) {
			const input = this.inputPins[i];
			this.inputBuffer[i * 2] = input.ID;
			this.inputBuffer[i * 2 + 1] = input.Pin.PlayerInputState;
			input.Pin.State = input.Pin.PlayerInputState;
		}

		if (this.advanceSingleSimStep) {
			this.advanceSingleSimStep = false;
			SimHost.RequestSingleStep();
		}

		SimHost.SendFrame({
			inputs: this.inputBuffer.slice(),
			keys,
			view: this.ViewedSimChip,
			paused: this.simPaused,
			targetTicksPerSecond: this.targetTicksPerSecond,
			stepsPerClockTransition: this.stepsPerClockTransition,
		});
	}

	StartSimulation() {
		this.simStarted = true;
		SimHost.Start();
	}

	EnterViewMode(subchip: SubChipInstance) {
		const description = this.chipLibrary.TryGetChipDescription(subchip.Description.Name);
		if (description) {
			const simChipToView = this.ViewedChip.SimChip.GetSubChipFromID(subchip.ID);

			const [viewChip] = DevChipInstance.LoadFromDescriptionTest(description, this.chipLibrary);
			viewChip.SetSimChip(simChipToView);

			this.controller.CancelEverything();
			this.chipViewStack.push(viewChip);
			this.UpdateViewedChipsString();
		}
	}

	ReturnToPreviousViewedChip() {
		if (this.chipViewStack.length > 1) {
			this.chipViewStack.pop();
			this.controller.CancelEverything();
			this.UpdateViewedChipsString();
		}
	}

	get AlwaysDrawDevPinNames(): boolean {
		return this.AlwaysDrawPinNames(this.description.Prefs_MainPinNamesDisplayMode);
	}
	get AlwaysDrawSubChipPinNames(): boolean {
		return this.AlwaysDrawPinNames(this.description.Prefs_ChipPinNamesDisplayMode);
	}

	private AlwaysDrawPinNames(prefIndex: number): boolean {
		return prefIndex === PreferencesMenu.DisplayMode_Always || (prefIndex === PreferencesMenu.DisplayMode_TabToggle && this.PinNameDisplayIsTabToggledOn);
	}

	private HandleProjectInput() {
		if (UIDrawer.ActiveMenu === MenuType.None) {
			// Step to next simulation frame when paused
			if (this.simPaused && KeyboardShortcuts.SimNextStepShortcutTriggered) this.advanceSingleSimStep = true;

			if (InputHelper.IsKeyDownThisFrame(KeyCode.Tab)) this.PinNameDisplayIsTabToggledOn = !this.PinNameDisplayIsTabToggledOn;
		}

		PreferencesMenu.HandleKeyboardShortcuts();
	}

	private UpdateViewedChipsString() {
		// (Stack enumerates top-first in C#; SkipLast(1).Reverse() = bottom-to-top excluding the edit chip)
		const viewedChipNames = this.chipViewStack.slice(1).map((c) => c.ChipName);
		this.viewedChipsString = "Viewing: " + viewedChipNames.join(" > ");
	}

	SaveFromDescription(saveChipDescription: ChipDescription, saveMode = SaveMode.Normal) {
		// If this chip hasn't been saved before, it can't have been used anyway so no need to update anything
		// (same thing if saving a new version of it)
		if (this.ViewedChip.LastSavedDescription != null && saveMode !== SaveMode.SaveAs) {
			this.UpdateAndSaveAffectedChips(this.ViewedChip.LastSavedDescription, saveChipDescription, false);
		}

		if (saveMode === SaveMode.Rename) {
			const nameOld = this.ViewedChip.LastSavedDescription!.Name;
			Saver.DeleteChip(nameOld, this.description.ProjectName, false);
			Saver.SaveChip(saveChipDescription, this.description.ProjectName);
			this.chipLibrary.NotifyChipRenamed(saveChipDescription, nameOld);
			this.RenameStarred(saveChipDescription.Name, nameOld, false, false);
			this.EnsureChipRenamedInCollections(nameOld, saveChipDescription.Name);
			this.UpdateAndSaveProjectDescription();
		} else {
			Saver.SaveChip(saveChipDescription, this.description.ProjectName);

			this.chipLibrary.NotifyChipSaved(saveChipDescription);
			const isNewChip = !this.ChipHasBeenSavedBefore || saveMode === SaveMode.SaveAs;

			// New chips are automatically starred
			if (isNewChip) {
				this.SetStarred(saveChipDescription.Name, true, false, false);
				this.UpdateAndSaveProjectDescription();
			}
		}

		// Notify the chip itself that it has been saved
		this.ViewedChip.NotifySaved(saveChipDescription);
		SearchPopup.AddRecentChip(saveChipDescription.Name);
		CameraController.NotifyChipNameChanged(saveChipDescription.Name);
	}

	ActiveChipHasUnsavedChanges(): boolean {
		// If chip has no last saved description, then has unsaved changes if any elements have been placed inside it
		if (this.ViewedChip.LastSavedDescription == null) return this.ViewedChip.Elements.length > 0;

		return Saver.HasUnsavedChanges(this.ViewedChip.LastSavedDescription, CreateChipDescription(this.ViewedChip));
	}

	CreateBlankDevChip() {
		this.controller = new ChipInteractionController(this);
		const devChip = new DevChipInstance();
		devChip.SetSimChip(Simulator.CreateEmptyRoot());
		this.SetNewActiveDevChip(devChip);
	}

	LoadDevChipOrCreateNewIfDoesntExist(chipName: string) {
		const description = this.chipLibrary.TryGetChipDescription(chipName);
		if (description) {
			this.controller = new ChipInteractionController(this);

			const [devChip, anyElementFailedToLoad] = DevChipInstance.LoadFromDescriptionTest(description, this.chipLibrary);

			// If any element (subchip, wire) failed to load, then save the updated description right away so that we have the correct version
			if (anyElementFailedToLoad) {
				const descNew = CreateChipDescription(devChip);
				this.SetNewActiveDevChip(devChip); // needs to be set before saving
				this.SaveFromDescription(descNew);
			}

			const simChip = Simulator.BuildSimChip(devChip.LastSavedDescription!);
			devChip.SetSimChip(simChip);
			this.SetNewActiveDevChip(devChip);
		} else {
			this.CreateBlankDevChip();
		}
	}

	private SetNewActiveDevChip(devChip: DevChipInstance) {
		this.editModeChip = devChip;
		this.chipViewStack.length = 0;
		this.chipViewStack.push(devChip);
		this.viewedChipsString = "";

		if (devChip.LastSavedDescription != null) SearchPopup.AddRecentChip(devChip.LastSavedDescription.Name);
	}

	// Key chip has been bound to a different key, so simulation must be updated
	NotifyKeyChipBindingChanged(keyChip: SubChipInstance, newKey: string) {
		const simChip = this.rootSimChip.GetSubChipFromID(keyChip.ID);
		Simulator.SetInternalState(simChip, 0, newKey.charCodeAt(0));
		keyChip.SetKeyChipActivationChar(newKey);
	}

	// Chip's pulse width has been changed, so simulation must be updated
	NotifyPulseWidthChanged(chip: SubChipInstance, widthNew: number) {
		const simChip = this.rootSimChip.GetSubChipFromID(chip.ID);
		Simulator.SetInternalState(simChip, 0, widthNew);
		chip.InternalData[0] = widthNew;
	}

	// Rom has been edited, so simulation must be updated
	NotifyRomContentsEdited(romChip: SubChipInstance) {
		const simChip = this.rootSimChip.GetSubChipFromID(romChip.ID);
		Simulator.UpdateInternalState(simChip, romChip.InternalData);
	}

	NotifyLEDColourChanged(ledChip: SubChipInstance, colIndex: number) {
		const simChip = this.rootSimChip.GetSubChipFromID(ledChip.ID);
		Simulator.SetInternalState(simChip, 0, colIndex);
		ledChip.InternalData[0] = colIndex;
	}

	DeleteChip(chipToDeleteName: string) {
		// If the current chip only contains the deleted chip directly as a subchip, it will be removed from the sim and everything is fine.
		// However, if it is contained indirectly somewhere within one of the chip's subchips (or their subchips, etc), then it's a bit tricky (and
		// potentially expensive for large chips) to hunt down all references within the simulation and remove them. So, for now at least, simply
		// restart the simulation in this case (this is not ideal though, since state of latches etc will be lost)
		const simReloadRequired = this.ChipContainsSubchipIndirectly(this.ViewedChip, chipToDeleteName);

		if (this.ChipContainsSubChipDirectly(this.ViewedChip, chipToDeleteName)) {
			// if deleted chip is a subchip of the current chip, clear undo history as it may now be invalid
			// (Todo: maybe handle more gracefully...)
			this.ViewedChip.UndoController.Clear();
		}

		this.UpdateAndSaveAffectedChips(this.chipLibrary.GetChipDescription(chipToDeleteName), null, true);

		// Delete chip save file, remove from library, and update project description
		Saver.DeleteChip(chipToDeleteName, this.description.ProjectName);
		this.chipLibrary.RemoveChip(chipToDeleteName);
		this.SetStarred(chipToDeleteName, false, false, false); // ensure removed from starred list
		this.EnsureChipRemovedFromCollections(chipToDeleteName);
		this.UpdateAndSaveProjectDescription();

		// If has deleted the chip that's currently being edited, then open a blank chip
		if (NameMatch(this.ViewedChip.ChipName, chipToDeleteName)) {
			this.CreateBlankDevChip();
		} else {
			// Remove any instances of the deleted chip from the active chip
			this.ViewedChip.DeleteSubchipsByName(chipToDeleteName);
			if (simReloadRequired) this.ViewedChip.RebuildSimulation();
		}
	}

	// Test if chip's subchips (or any of their subchips, etc...) contain the target subchip
	private ChipContainsSubchipIndirectly(devChip: DevChipInstance, targetSubchip: string): boolean {
		const visited = new NameSet();

		for (const element of devChip.Elements) {
			if (element instanceof SubChipInstance && !visited.has(element.Description.Name)) {
				const subchip = element;
				visited.add(subchip.Description.Name);
				if (this.ChipContainsSubchipDirectlyOrIndirectly(this.chipLibrary.GetChipDescription(subchip.Description.Name), targetSubchip)) return true;
			}
		}

		return false;
	}

	// Test if chip (or any of its subchips, or the subchips' subchips, etc...) contain the target subchip
	private ChipContainsSubchipDirectlyOrIndirectly(descRoot: ChipDescription, targetSubchip: string): boolean {
		const visited = new NameSet();
		let found = false;

		const SearchRecursive = (desc: ChipDescription) => {
			for (const sub of desc.SubChips) {
				if (found || NameMatch(sub.Name, targetSubchip)) {
					found = true;
					return;
				}

				const subDescFull = this.chipLibrary.GetChipDescription(sub.Name);
				if (!visited.has(subDescFull.Name)) {
					// Hasn't visited before
					visited.add(subDescFull.Name);
					SearchRecursive(subDescFull);
				}
			}
		};

		SearchRecursive(descRoot);
		return found;
	}

	private ChipContainsSubChipDirectly(chip: DevChipInstance, targetName: string): boolean {
		for (const element of chip.Elements) {
			if (element instanceof SubChipInstance && NameMatch(element.Description.Name, targetName)) return true;
		}
		return false;
	}

	// Must be called prior to library being updated with the change
	// If deleting, new description can be left null
	private UpdateAndSaveAffectedChips(root_desc: ChipDescription, root_descNew: ChipDescription | null, willDelete: boolean) {
		// There a few ways in which chips other than the one currently being edited can be affected, and require resaving:
		// -- A chip is deleted from the library -> all chips that contain the deleted chip must be resaved with that chip and its connections removed
		// -- A chip is renamed -> all chips containing the renamed chip must be resaved with the new name applied
		// -- A chip is saved after removing an input/output pin -> all chips contained the edited chip must be resaved with affected connections removed

		const affectedChips = this.chipLibrary.GetDirectParentChips(root_desc.Name);
		const willRename = !willDelete && !NameMatch(root_desc.Name, root_descNew!.Name);

		const newDesc_AllDevPinIDs = new Set<number>();
		if (!willDelete) {
			for (const p of root_descNew!.InputPins) newDesc_AllDevPinIDs.add(p.ID);
			for (const p of root_descNew!.OutputPins) newDesc_AllDevPinIDs.add(p.ID);
		}

		for (const desc of affectedChips) {
			let anyChanges = willDelete || willRename;

			const [devChip, anyElementFailedToLoad] = DevChipInstance.LoadFromDescriptionTest(desc, this.chipLibrary);

			anyChanges ||= anyElementFailedToLoad;

			if (willDelete) {
				devChip.DeleteSubchipsByName(root_desc.Name);
			} else {
				// Detect deleted dev pins, and remove any connections to the corresponding subchip pins in the affected chip
				for (const p of root_desc.InputPins) {
					if (!newDesc_AllDevPinIDs.has(p.ID)) anyChanges = devChip.DeleteWiresAttachedToPinOfSubChip(p.ID) || anyChanges;
				}

				for (const p of root_desc.OutputPins) {
					if (!newDesc_AllDevPinIDs.has(p.ID)) anyChanges = devChip.DeleteWiresAttachedToPinOfSubChip(p.ID) || anyChanges;
				}
			}

			if (anyChanges) {
				const updatedDesc = CreateChipDescription(devChip);

				if (willRename) {
					for (const sub of updatedDesc.SubChips) {
						if (NameMatch(sub.Name, root_desc.Name)) sub.Name = root_descNew!.Name;
					}
				}

				Saver.SaveChip(updatedDesc, this.description.ProjectName);
				this.chipLibrary.NotifyChipSaved(updatedDesc);
			}
		}
	}

	ToggleGridDisplay() {
		this.description.Prefs_GridDisplayMode = 1 - this.description.Prefs_GridDisplayMode;
	}

	get ShouldSnapToGrid(): boolean {
		return KeyboardShortcuts.SnapModeHeld || (this.description.Prefs_Snapping === 1 && this.ShowGrid) || this.description.Prefs_Snapping === 2;
	}
	get ForceStraightWires(): boolean {
		return KeyboardShortcuts.StraightLineModeHeld || (this.description.Prefs_StraightWires === 1 && this.ShowGrid) || this.description.Prefs_StraightWires === 2;
	}

	NotifyExit() {
		this.simStarted = false;
		// (web: the sim worker keeps running, so replace its chip with an empty one to stop it (and silence any buzzers))
		const empty = Simulator.CreateEmptyRoot();
		SimHost.SendFrame({ inputs: new Int32Array(0), keys: "", view: empty, paused: true, targetTicksPerSecond: 1, stepsPerClockTransition: 1 });
	}

	UpdateAndSaveProjectDescription(editedProjectDesc?: ProjectDescription) {
		if (editedProjectDesc === undefined) {
			const newDesc = this.description;
			newDesc.AllCustomChipNames = this.chipLibrary.GetAllCustomChipNames();
			editedProjectDesc = newDesc;
		}
		this.description = editedProjectDesc;
		this.SaveCurrentProjectDescription();
	}

	SaveCurrentProjectDescription() {
		Saver.SaveProjectDescription(this.description);
	}

	RenameCollection(collectionIndex: number, nameNew: string, autoSave = true) {
		const collection = this.description.ChipCollections[collectionIndex];
		this.RenameStarred(nameNew, collection.Name, true, false);
		collection.Name = nameNew;
		collection.UpdateDisplayStrings();

		if (autoSave) this.SaveCurrentProjectDescription();
	}

	// Rename starred chip/collection (if is starred)
	RenameStarred(nameNew: string, nameOld: string, isCollection: boolean, autoSave = true) {
		const starred = this.description.StarredList;
		let modified = false;
		for (let i = 0; i < starred.length; i++) {
			if (starred[i].IsCollection === isCollection && NameMatch(starred[i].Name, nameOld)) {
				starred[i] = StarredItem(nameNew, isCollection);
				modified = true;
				break;
			}
		}

		if (autoSave && modified) this.SaveCurrentProjectDescription();
	}

	SetStarred(chipName: string, star: boolean, isCollection: boolean, autoSave = true) {
		const starred = this.description.StarredList;
		let alreadyStarred = false;
		let modified = false;

		for (let i = 0; i < starred.length; i++) {
			if (starred[i].IsCollection === isCollection && NameMatch(chipName, starred[i].Name)) {
				if (!star) {
					modified = true;
					starred.splice(i, 1);
				}

				alreadyStarred = true;
				break;
			}
		}

		if (star && !alreadyStarred) {
			modified = true;
			starred.push(StarredItem(chipName, isCollection));
		}

		if (autoSave && modified) this.SaveCurrentProjectDescription();
	}

	private EnsureChipRenamedInCollections(chipNameOld: string, chipNameNew: string) {
		for (const collection of this.description.ChipCollections) {
			for (let i = 0; i < collection.Chips.length; i++) {
				if (NameMatch(collection.Chips[i], chipNameOld)) {
					collection.Chips[i] = chipNameNew;
					return;
				}
			}
		}
	}

	private EnsureChipRemovedFromCollections(chipNameToRemove: string) {
		for (const collection of this.description.ChipCollections) {
			for (let i = 0; i < collection.Chips.length; i++) {
				if (NameMatch(collection.Chips[i], chipNameToRemove)) {
					collection.Chips.splice(i, 1);
					return;
				}
			}
		}
	}
}

// SimKeyboardHelper.RefreshInputState: characters of currently held key-chip keys (none if a modifier is held)
function GetHeldKeyChars(): string {
	if (!InputHelper.AnyKeyOrMouseHeldThisFrame) return ""; // early exit if no key held
	if (InputHelper.CtrlIsHeld || InputHelper.ShiftIsHeld || InputHelper.AltIsHeld) return ""; // don't trigger key chips if modifier is held
	let s = "";
	for (const [code, c] of ValidInputKeys) if (InputHelper.IsKeyHeld(code)) s += c;
	return s;
}

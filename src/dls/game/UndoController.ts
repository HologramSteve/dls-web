// Port of DLS.Game.UndoController
import { Vector2 } from "../../seb/types/Vector2";
import { ChipTypeHelper } from "../description/ChipTypeHelper";
import { PinDescription, SubChipDescription, WireDescription, clonePinDescription, cloneSubChipDescription } from "../description/Types";
import { CreatePinDescription, CreateSubChipDescription, CreateWireDescription, UpdateWireIndicesForDescriptionCreation } from "../saveSystem/DescriptionCreator";
import type { DevChipInstance } from "./DevChipInstance";
import { DevPinInstance } from "./elements/DevPinInstance";
import type { IMoveable } from "./elements/Interfaces";
import { SubChipInstance } from "./elements/SubChipInstance";
import type { WireInstance } from "./elements/WireInstance";
import { Project } from "./Project";

export class UndoController {
	private readonly undoHistory: UndoAction[] = [];
	private undoIndex = -1;
	private readonly devChip: DevChipInstance;

	constructor(devChip: DevChipInstance) {
		this.devChip = devChip;
	}

	Clear() {
		this.undoHistory.length = 0;
		this.undoIndex = -1;
	}

	TryUndo() {
		if (this.undoIndex === -1) return;
		const action = this.undoHistory[this.undoIndex];
		this.undoIndex--;
		this.UndoRedo(action, true);
	}

	TryRedo() {
		if (this.undoIndex === this.undoHistory.length - 1) return;
		const action = this.undoHistory[this.undoIndex + 1];
		this.undoIndex++;
		this.UndoRedo(action, false);
	}

	RecordAddWire(wire: WireInstance) {
		this.RecordAddOrDeleteWire(wire, false);
	}

	RecordDeleteWire(wire: WireInstance) {
		this.RecordAddOrDeleteWire(wire, true);
	}

	private RecordAddOrDeleteWire(wire: WireInstance, isDelete: boolean) {
		UpdateWireIndicesForDescriptionCreation(this.devChip);
		const wireIndex = wire.descriptionCreator_wireIndex;
		const wireDesc = CreateWireDescription(wire);
		const stateBeforeDelete = isDelete ? CreateFullWireState(this.devChip, new Set([wire])) : null;
		this.RecordUndoAction(new WireExistenceAction(wireDesc, wireIndex, isDelete, stateBeforeDelete));
	}

	RecordMoveElements(movedElements: IMoveable[]) {
		const action = new MoveUndoAction();
		action.subChipIDs = movedElements.map((e) => e.ID);
		action.originalPositions = movedElements.map((e) => e.MoveStartPosition);
		action.newPositions = movedElements.map((e) => e.Position);
		// Wire move offsets
		action.wireMoveOffsets = this.devChip.Wires.map((w) => w.MoveOffset);
		this.RecordUndoAction(action);
	}

	RecordDeleteElements(deletedElements: IMoveable[]) {
		const hasConnectedWires = true; // Todo: test if true so don't backup wire state unnecessarily
		this.RecordAddOrDeleteElements(deletedElements, true, hasConnectedWires);
	}

	RecordAddElements(addedElements: IMoveable[], hasWires: boolean) {
		this.RecordAddOrDeleteElements(addedElements, false, hasWires);
	}

	private RecordAddOrDeleteElements(elements: IMoveable[], isDelete: boolean, hasWires: boolean) {
		const subchips = elements.filter((e): e is SubChipInstance => e instanceof SubChipInstance);
		const devPins = elements.filter((e): e is DevPinInstance => e instanceof DevPinInstance);

		// When deleting elements, store full state of ALL wires, not just those affected by the deletion.
		let wireState: FullWireState | null = null;
		if (hasWires) {
			const wiresThatWillBeDeletedAutomatically = new Set<WireInstance>();
			for (const element of elements) this.devChip.GetWiresAttachedToElement(element.ID, wiresThatWillBeDeletedAutomatically);
			wireState = CreateFullWireState(this.devChip, wiresThatWillBeDeletedAutomatically);
		}

		const action = new ElementExistenceAction();
		action.chipNames = subchips.map((s) => s.Description.Name);
		action.subchipDescriptions = subchips.map(CreateSubChipDescription);
		action.pinDescriptions = devPins.map(CreatePinDescription);
		action.pinInInputFlags = devPins.map((p) => p.IsInputPin);
		action.wireStateBeforeDelete = wireState;
		action.isDeleteAction = isDelete;
		this.RecordUndoAction(action);
	}

	private RecordUndoAction(action: UndoAction) {
		if (this.undoIndex !== this.undoHistory.length) {
			this.undoHistory.splice(this.undoIndex + 1, this.undoHistory.length - (this.undoIndex + 1));
		}
		this.undoHistory.push(action);
		this.undoIndex = this.undoHistory.length - 1;
	}

	private UndoRedo(action: UndoAction, undo: boolean) {
		Project.ActiveProject.controller.CancelEverything();
		try {
			action.Trigger(undo, this.devChip);
		} catch (e) {
			console.debug("Undo/redo action failed.", e);
		}
	}
}

function CreateFullWireState(devChip: DevChipInstance, wiresThatWillBeDeleted: Set<WireInstance>): FullWireState {
	UpdateWireIndicesForDescriptionCreation(devChip);
	const state = new FullWireState();
	state.wireDescriptions = devChip.Wires.map(CreateWireDescription);
	state.createFlags = devChip.Wires.map((w) => wiresThatWillBeDeleted.has(w));
	return state;
}

abstract class UndoAction {
	abstract Trigger(undo: boolean, devChip: DevChipInstance): void;
}

class MoveUndoAction extends UndoAction {
	subChipIDs: number[] = [];
	originalPositions: Vector2[] = [];
	newPositions: Vector2[] = [];
	wireMoveOffsets: Vector2[] = [];

	Trigger(undo: boolean, devChip: DevChipInstance) {
		const lookup = new Map<number, IMoveable>();
		for (const e of devChip.Elements) lookup.set(e.ID, e);
		for (let i = 0; i < this.subChipIDs.length; i++) {
			const element = lookup.get(this.subChipIDs[i]);
			if (!element) throw new Error("Element not found");
			element.Position = undo ? this.originalPositions[i] : this.newPositions[i];
			Project.ActiveProject.controller.Select(element, true);
		}
		for (let i = 0; i < devChip.Wires.length; i++) {
			devChip.Wires[i].MoveOffset = this.wireMoveOffsets[i].mul(undo ? -1 : 1);
			devChip.Wires[i].ApplyMoveOffset();
		}
	}
}

class WireExistenceAction extends UndoAction {
	constructor(
		readonly wireDescription: WireDescription,
		readonly wireIndex: number,
		readonly isDeleteAction: boolean,
		readonly fullWireStateBeforeDelete: FullWireState | null,
	) {
		super();
	}

	Trigger(undo: boolean, devChip: DevChipInstance) {
		if (!this.isDeleteAction) undo = !undo;
		const addWire = undo;

		if (addWire) {
			if (this.fullWireStateBeforeDelete != null) {
				this.fullWireStateBeforeDelete.Restore(devChip);
			} else {
				const [loadedWire, failed] = LoadWire(devChip, this.wireDescription, this.wireIndex);
				if (failed) throw new Error("Failed to load wire in undo/redo action");
				devChip.AddWire(loadedWire!, false, this.wireIndex);
			}
		} else {
			devChip.DeleteWire(devChip.Wires[this.wireIndex]);
		}
	}
}

class FullWireState {
	wireDescriptions: WireDescription[] = [];
	createFlags: boolean[] = [];

	Restore(devChip: DevChipInstance) {
		for (let i = 0; i < this.wireDescriptions.length; i++) {
			const [loadedWire, failed] = LoadWire(devChip, this.wireDescriptions[i], i);
			if (failed) throw new Error("Failed to load wire in undo/redo action");
			if (this.createFlags[i]) devChip.AddWire(loadedWire!, false, i);
			else devChip.Wires[i] = loadedWire!;
		}
	}
}

class ElementExistenceAction extends UndoAction {
	chipNames: string[] = [];
	subchipDescriptions: SubChipDescription[] = [];
	pinDescriptions: PinDescription[] = [];
	pinInInputFlags: boolean[] = [];
	wireStateBeforeDelete: FullWireState | null = null;
	isDeleteAction = false;

	Trigger(undo: boolean, devChip: DevChipInstance) {
		if (!this.isDeleteAction) undo = !undo;
		const addElement = undo;

		// ---- Handle subchips ----
		for (let i = 0; i < this.chipNames.length; i++) {
			const description = Project.ActiveProject.chipLibrary.GetChipDescription(this.chipNames[i]);
			if (addElement) {
				const subchip = new SubChipInstance(description, cloneSubChipDescription(this.subchipDescriptions[i]));
				devChip.AddNewSubChip(subchip, false);
				Project.ActiveProject.controller.Select(subchip, true);
			} else if (!devChip.TryDeleteSubChipByID(this.subchipDescriptions[i].ID)) {
				// (bus pairs deleted automatically, so the other part is expected to fail)
				if (!ChipTypeHelper.IsBusType(description.ChipType)) throw new Error("Failed to delete subchip");
			}
		}

		// ---- Handle dev pins ----
		for (let i = 0; i < this.pinDescriptions.length; i++) {
			const pinDescription = this.pinDescriptions[i];
			if (addElement) {
				const devPin = new DevPinInstance(clonePinDescription(pinDescription), this.pinInInputFlags[i]);
				devChip.AddNewDevPin(devPin, false);
				Project.ActiveProject.controller.Select(devPin, true);
			} else if (!devChip.TryDeleteDevPinByID(pinDescription.ID)) {
				throw new Error("Failed to delete dev pin");
			}
		}

		if (addElement && this.wireStateBeforeDelete != null) this.wireStateBeforeDelete.Restore(devChip);
	}
}

function LoadWire(devChip: DevChipInstance, desc: WireDescription, index: number) {
	// Import lazily to avoid circular import at module-evaluation time
	return (devChip.constructor as typeof import("./DevChipInstance").DevChipInstance).TryLoadWireFromDescription(desc, index, devChip, devChip.Wires);
}

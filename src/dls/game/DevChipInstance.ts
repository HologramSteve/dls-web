// Port of DLS.Game.DevChipInstance: the chip currently being edited/viewed (elements + wires) and its link to the simulation
import { ChipDescription, NameMatch, NameSet, PinAddress, PinAddressEquals, WireConnectionType, WireDescription } from "../description/Types";
import { ChipTypeHelper } from "../description/ChipTypeHelper";
import { CreateChipDescription } from "../saveSystem/DescriptionCreator";
import { SimChipRef, SimHost, Simulator } from "../simulation/SimHost";
import type { ChipLibrary } from "./ChipLibrary";
import { DevPinInstance } from "./elements/DevPinInstance";
import type { IMoveable } from "./elements/Interfaces";
import type { PinInstance } from "./elements/PinInstance";
import { SubChipInstance } from "./elements/SubChipInstance";
import { ConnectionInfo, WireInstance } from "./elements/WireInstance";
import { Project } from "./Project";
import { UndoController } from "./UndoController";

export class DevChipInstance {
	readonly Elements: IMoveable[] = [];
	readonly Wires: WireInstance[] = [];
	readonly UndoController: UndoController;

	// Names of all the chips which contain this chip (either directly, or inside some other subchip)
	readonly AllParentChipNames = new NameSet();

	LastSavedDescription: ChipDescription | null = null;
	private inputPins_cached: DevPinInstance[] = [];
	private elementsModifiedSinceLastArrayUpdate = false;

	SimChip!: SimChipRef;
	private hasSimChip = false;

	get ChipName(): string {
		return this.LastSavedDescription == null ? "" : this.LastSavedDescription.Name;
	}

	constructor() {
		this.UndoController = new UndoController(this);
	}

	SetSimChip(simChip: SimChipRef) {
		this.hasSimChip = true;
		this.SimChip = simChip;
	}

	RebuildSimulation() {
		const desc = CreateChipDescription(this);
		this.SetSimChip(Simulator.BuildSimChip(desc));
	}

	GetInputPins(): DevPinInstance[] {
		if (this.elementsModifiedSinceLastArrayUpdate) {
			this.elementsModifiedSinceLastArrayUpdate = false;
			this.inputPins_cached = this.Elements.filter((e): e is DevPinInstance => e instanceof DevPinInstance && e.IsInputPin);
		}
		return this.inputPins_cached;
	}

	static LoadFromDescriptionTest(description: ChipDescription, library: ChipLibrary): [DevChipInstance, boolean] {
		const instance = new DevChipInstance();
		instance.LastSavedDescription = description;

		// Set any null arrays to empty so don't have to check
		description.SubChips ??= [];
		description.InputPins ??= [];
		description.OutputPins ??= [];
		description.Wires ??= [];

		let anyElementFailedToLoad = false;

		// Load subchips
		for (const subChipDescription of description.SubChips) {
			const fullDescriptionOfSubchip = library.TryGetChipDescription(subChipDescription.Name);
			if (fullDescriptionOfSubchip) {
				instance.AddNewSubChip(new SubChipInstance(fullDescriptionOfSubchip, subChipDescription), true);
			} else anyElementFailedToLoad = true;
		}

		// Load dev pins
		for (const pinDescription of description.InputPins) instance.AddNewDevPin(new DevPinInstance(pinDescription, true), true);
		for (const pinDescription of description.OutputPins) instance.AddNewDevPin(new DevPinInstance(pinDescription, false), true);

		// ---- Load wires ----
		// Wires can fail to load if associated pin was deleted from subchip. This means that wire indices stored in the save data might not line up with our loaded wires list.
		// So, keep track here of the wires with correct indices (with failed entries just being left as null)
		const loadedWiresWithOriginalIndices: (WireInstance | null)[] = new Array(description.Wires.length).fill(null);

		for (let i = 0; i < description.Wires.length; i++) {
			const [loadedWire, failed] = DevChipInstance.TryLoadWireFromDescription(description.Wires[i], i, instance, loadedWiresWithOriginalIndices);
			if (!failed) instance.AddWire(loadedWire!, true);
			loadedWiresWithOriginalIndices[i] = loadedWire;
			anyElementFailedToLoad ||= failed;
		}

		instance.RegenerateParentChipNamesHash();
		return [instance, anyElementFailedToLoad];
	}

	static TryLoadWireFromDescription(wireDescription: WireDescription, wireIndex: number, instance: DevChipInstance, allWires: (WireInstance | null)[]): [WireInstance | null, boolean] {
		let failedToLoad = false;
		let loadedWire: WireInstance | null = null;
		const connectedWire = wireDescription.ConnectedWireIndex >= 0 ? (allWires[wireDescription.ConnectedWireIndex] ?? null) : null;

		const sourcePin = instance.TryFindPin(wireDescription.SourcePinAddress);
		const targetPin = instance.TryFindPin(wireDescription.TargetPinAddress);

		if (sourcePin != null && targetPin != null) {
			let connectionType = wireDescription.ConnectionType;

			if (connectionType === WireConnectionType.ToWireSource || connectionType === WireConnectionType.ToWireTarget) {
				const wireConnectTarget = connectedWire;
				let wireConnectTargetFailedToLoad = wireConnectTarget == null;

				if (!wireConnectTargetFailedToLoad) {
					// Double check that it connects to the same pin that this wire is expecting
					let addressMismatch = false;
					addressMismatch ||= connectionType === WireConnectionType.ToWireSource && !PinAddressEquals(wireConnectTarget!.SourcePin.Address, wireDescription.SourcePinAddress);
					addressMismatch ||= connectionType === WireConnectionType.ToWireTarget && !PinAddressEquals(wireConnectTarget!.TargetPin_BusCorrected.Address, wireDescription.TargetPinAddress);
					wireConnectTargetFailedToLoad = addressMismatch;
				}

				// If wire is connected to another wire, but the other wire failed to load, then fallback to pin connection type
				if (wireConnectTargetFailedToLoad) {
					failedToLoad = true;
					connectionType = WireConnectionType.ToPins;
				}
			}

			const sourceConnection = ConnectionInfo.Create({
				pin: sourcePin,
				connectedWire: connectionType === WireConnectionType.ToWireSource ? connectedWire : null,
				wireConnectionSegmentIndex: wireDescription.ConnectedWireSegmentIndex,
			});
			const targetConnection = ConnectionInfo.Create({
				pin: targetPin,
				connectedWire: connectionType === WireConnectionType.ToWireTarget ? connectedWire : null,
				wireConnectionSegmentIndex: wireDescription.ConnectedWireSegmentIndex,
			});

			loadedWire = new WireInstance(sourceConnection, targetConnection, wireDescription.Points, wireIndex);
		} else {
			failedToLoad = true;
		}

		return [loadedWire, failedToLoad];
	}

	// Check if subchip can be added. The chip may not contain a copy of itself (either directly, or inside some other chip)
	CanAddSubchip(subchipName: string): boolean {
		if (NameMatch(this.ChipName, subchipName)) return false;
		return !this.AllParentChipNames.has(subchipName);
	}

	DeleteSubchipsByName(removeName: string) {
		const subchipsToDelete = this.Elements.filter((e): e is SubChipInstance => e instanceof SubChipInstance && NameMatch(e.Description.Name, removeName));
		for (const subchip of subchipsToDelete) this.DeleteSubChip(subchip);
	}

	NotifySaved(savedDescription: ChipDescription) {
		this.LastSavedDescription = savedDescription;
		this.RegenerateParentChipNamesHash();
	}

	AddNewSubChip(subChip: SubChipInstance, isLoading: boolean) {
		this.AddElement(subChip);
		if (!isLoading) Simulator.AddSubChip(this.SimChip, subChip.Description, subChip.ID, subChip.InternalData);
	}

	AddNewDevPin(pin: DevPinInstance, isLoadingFromFile: boolean) {
		this.AddElement(pin);
		if (!isLoadingFromFile) Simulator.AddPin(this.SimChip, pin.ID, pin.IsInputPin);
	}

	AddWire(wire: WireInstance, isLoading: boolean, insertIndex = -1) {
		if (insertIndex !== -1) this.Wires.splice(insertIndex, 0, wire);
		else this.Wires.push(wire);

		if (!isLoading) Simulator.AddConnection(this.SimChip, wire.SourcePin.Address, wire.TargetPin.Address);
	}

	private AddElement(element: IMoveable) {
		this.Elements.push(element);
		this.elementsModifiedSinceLastArrayUpdate = true;
	}

	private RemoveElement(element: IMoveable) {
		this.elementsModifiedSinceLastArrayUpdate = true;
		const i = this.Elements.indexOf(element);
		if (i >= 0) this.Elements.splice(i, 1);
		else console.assert(false, "Trying to delete element that was already deleted?");
	}

	DeleteDevPin(devPin: DevPinInstance) {
		this.DeleteWiresAttachedToPin(devPin.Pin);
		this.RemoveElement(devPin);
		Simulator.RemovePin(this.SimChip, devPin.ID);
	}

	DeleteWire(wireToDelete: WireInstance) {
		const i = this.Wires.indexOf(wireToDelete);
		if (i < 0) return; // Wire already deleted
		this.Wires.splice(i, 1);

		// Remove from simulation
		if (this.hasSimChip) Simulator.RemoveConnection(this.SimChip, wireToDelete.SourcePin.Address, wireToDelete.TargetPin.Address);

		// If deleting bus line, automatically delete all other connecting wires
		if (wireToDelete.IsBusWire) {
			const busSource = wireToDelete.SourcePin.parent as SubChipInstance;
			this.DeleteWiresAttachedToPin(busSource.InputPins[0]);
			this.DeleteWiresAttachedToPin(busSource.OutputPins[0]);
		}
		// Otherwise connecting wires should connect directly to the pin where the deleted wire used to connect
		else {
			for (const other of this.Wires) {
				if (other.ConnectedWire === wireToDelete) other.RemoveConnectionDependency();
			}
		}
	}

	private DeleteWiresAttachedToPin(pin: PinInstance) {
		for (let i = this.Wires.length - 1; i >= 0; i--) {
			const wire = this.Wires[i];
			if (!wire) continue;
			if (PinAddressEquals(wire.SourcePin.Address, pin.Address) || PinAddressEquals(wire.TargetPin.Address, pin.Address)) this.DeleteWire(wire);
		}
	}

	DeleteWiresAttachedToPinOfSubChip(pinID: number): boolean {
		let anyDeleted = false;
		for (let i = this.Wires.length - 1; i >= 0; i--) {
			const wire = this.Wires[i];
			if (!wire) continue;
			const sourceMatch = wire.SourcePin.parent instanceof SubChipInstance && wire.SourcePin.Address.PinID === pinID;
			const targetMatch = wire.TargetPin.parent instanceof SubChipInstance && wire.TargetPin.Address.PinID === pinID;
			if (sourceMatch || targetMatch) {
				this.DeleteWire(wire);
				anyDeleted = true;
			}
		}
		return anyDeleted;
	}

	GetWiresAttachedToElement(elementID: number, set: Set<WireInstance>) {
		for (const wire of this.Wires) {
			if (wire.SourcePin.Address.PinOwnerID === elementID || wire.TargetPin.Address.PinOwnerID === elementID) set.add(wire);
		}
	}

	DeleteWiresAttachedToElement(elementID: number) {
		for (let i = this.Wires.length - 1; i >= 0; i--) {
			const wire = this.Wires[i];
			if (!wire) continue;
			if (wire.SourcePin.Address.PinOwnerID === elementID || wire.TargetPin.Address.PinOwnerID === elementID) this.DeleteWire(wire);
		}
	}

	DeleteSubChip(subChip: SubChipInstance) {
		this.DeleteWiresAttachedToElement(subChip.ID);
		this.RemoveElement(subChip);
		if (this.hasSimChip) Simulator.RemoveSubChip(this.SimChip, subChip.ID);
	}

	// Delete subchip with given id (if it exists)
	TryDeleteSubChipByID(id: number): boolean {
		for (const e of this.Elements) {
			if (e instanceof SubChipInstance && e.ID === id) {
				this.DeleteSubChip(e);
				return true;
			}
		}
		return false;
	}

	// Delete devpin with given id (if it exists)
	TryDeleteDevPinByID(id: number): boolean {
		for (const e of this.Elements) {
			if (e instanceof DevPinInstance && e.ID === id) {
				this.DeleteDevPin(e);
				return true;
			}
		}
		return false;
	}

	TryGetSubChipByID(id: number): SubChipInstance | null {
		for (const e of this.Elements) {
			if (e.ID === id) return e as SubChipInstance;
		}
		return null;
	}

	// Update the currently viewed chip from the latest simulation snapshot of the corresponding sim chip.
	// Optionally don't set input pins since player controls these (at least when editing a chip, rather than viewing it)
	UpdateStateFromSim(simChip: SimChipRef, updateInputPins: boolean) {
		const snap = SimHost.GetSnapshotFor(simChip);
		if (!snap) return;

		// Build lookup: ownerID -> pinID -> entry index
		const pins = snap.pins;
		const lookup = new Map<number, Map<number, number>>();
		for (let i = 0; i < pins.length; i += 5) {
			let m = lookup.get(pins[i]);
			if (!m) {
				m = new Map();
				lookup.set(pins[i], m);
			}
			if (!m.has(pins[i + 1])) m.set(pins[i + 1], i);
		}
		const find = (address: PinAddress): number => lookup.get(address.PinOwnerID)?.get(address.PinID) ?? -1;

		const TryFindPinFromSimPinSource = (entry: number): PinInstance | null => {
			const srcID = pins[entry + 3];
			const srcParentID = pins[entry + 4];
			// Is dev pin, so here the SimPin's ID refers to the devpin
			const srcAddress = srcParentID === snap.viewChipID ? PinAddress(srcID, 0) : PinAddress(srcParentID, srcID);
			return this.TryFindPin(srcAddress);
		};

		try {
			for (const element of this.Elements) {
				if (element instanceof DevPinInstance) {
					const devPin = element;
					if (devPin.IsInputPin && !updateInputPins) continue;

					const entry = find(devPin.Pin.Address);
					if (entry < 0) continue;
					devPin.Pin.State = pins[entry + 2];

					if (devPin.IsInputPin || pins[entry + 3] === -1) continue;

					// Output pins get colour from whichever pin they last received a signal
					const colSource = TryFindPinFromSimPinSource(entry);
					if (colSource) devPin.Pin.Colour = colSource.Colour;
				} else if (element instanceof SubChipInstance) {
					const subChip = element;
					// Update the state of each output pin on the subchip to match the state of corresponding pin in the simulation
					for (const subChipOutputPin of subChip.OutputPins) {
						const entry = find(subChipOutputPin.Address);
						if (entry < 0) continue;
						subChipOutputPin.State = pins[entry + 2];

						// If is bus, copy colour from the input source
						if (ChipTypeHelper.IsBusOriginType(subChip.ChipType)) {
							const inEntry = find(subChip.InputPins[0].Address);
							if (inEntry < 0 || pins[inEntry + 3] === -1) continue;
							const colSource = TryFindPinFromSimPinSource(inEntry);
							if (colSource) subChipOutputPin.Colour = colSource.Colour;
						}
					}
				}
			}
		} catch {
			// Sim may be temporarily out of sync if player is actively editing -- just ignore
		}
	}

	TryFindPin(address: PinAddress): PinInstance | null {
		return DevChipInstance.TryFindPinIn(this.Elements, address);
	}

	static TryFindPinIn(elements: IMoveable[], address: PinAddress): PinInstance | null {
		for (const element of elements) {
			if (element.ID === address.PinOwnerID) {
				if (element instanceof SubChipInstance) {
					for (const pin of element.AllPins) {
						if (PinAddressEquals(pin.Address, address)) return pin;
					}
				} else if (element instanceof DevPinInstance) {
					if (PinAddressEquals(element.Pin.Address, address)) return element.Pin;
				}
				break;
			}
		}
		return null;
	}

	NotifyConnectedWiresPointsInserted(wire: WireInstance, insertIndex: number, insertPointT: number, numPoints: number) {
		for (const other of this.Wires) {
			if (other.ConnectedWire === wire) other.NotifyParentWirePointsInserted(insertIndex, insertPointT, numPoints);
		}
	}

	GetSubchips(): SubChipInstance[] {
		return this.Elements.filter((e): e is SubChipInstance => e instanceof SubChipInstance);
	}

	GetOutputPins(): DevPinInstance[] {
		return this.Elements.filter((e): e is DevPinInstance => e instanceof DevPinInstance && !e.IsInputPin);
	}

	private RegenerateParentChipNamesHash() {
		this.AllParentChipNames.clear();
		if (this.LastSavedDescription == null) return;
		const library = Project.ActiveProject.chipLibrary;
		const hashset = this.AllParentChipNames;
		const recursivelyAddParents = (name: string) => {
			for (const parent of library.GetDirectParentChips(name)) {
				if (hashset.add(parent.Name)) recursivelyAddParents(parent.Name);
			}
		};
		recursivelyAddParents(this.LastSavedDescription.Name);
	}
}

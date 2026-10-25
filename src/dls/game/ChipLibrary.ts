// Port of DLS.Game.ChipLibrary
import { ChipDescription, ChipType, NameKey, NameMatch, NameSet } from "../description/Types";
import { ChipTypeHelper } from "../description/ChipTypeHelper";
import { Simulator } from "../simulation/SimHost";

export class ChipLibrary {
	readonly allChips: ChipDescription[] = [];
	private readonly builtinChipNames = new NameSet();
	private readonly descriptionFromNameLookup = new Map<string, ChipDescription>();
	private readonly hiddenChips: ChipDescription[] = [];

	constructor(customChips: ChipDescription[], builtinChips: ChipDescription[]) {
		// Add built-in chips to list of all chips
		for (const chip of builtinChips) {
			// Bus terminus chip should not be shown to the user (it is created automatically upon placement of a bus start point)
			const hidden = ChipTypeHelper.IsBusTerminusType(chip.ChipType) || chip.ChipType === ChipType.dev_Ram_8Bit;
			this.AddChipToLibrary(chip, hidden);
			this.builtinChipNames.add(chip.Name);
		}

		// Add custom chips to list of all chips
		for (const chip of customChips) this.AddChipToLibrary(chip);

		this.RebuildChipDescriptionLookup();
	}

	private RebuildChipDescriptionLookup() {
		this.descriptionFromNameLookup.clear();
		for (const desc of this.allChips) this.descriptionFromNameLookup.set(NameKey(desc.Name), desc);
		for (const desc of this.hiddenChips) this.descriptionFromNameLookup.set(NameKey(desc.Name), desc);
		// Keep the simulation worker's copy of the library in sync
		Simulator.SyncLibrary([...this.allChips, ...this.hiddenChips]);
	}

	IsBuiltinChip(name: string): boolean {
		return this.builtinChipNames.has(name);
	}

	HasChip(name: string): boolean {
		return this.descriptionFromNameLookup.has(NameKey(name));
	}

	GetChipDescription(name: string): ChipDescription {
		const d = this.descriptionFromNameLookup.get(NameKey(name));
		if (!d) throw new Error("Chip not found in library: " + name);
		return d;
	}

	TryGetChipDescription(name: string): ChipDescription | undefined {
		return this.descriptionFromNameLookup.get(NameKey(name));
	}

	RemoveChip(chipName: string) {
		for (let i = this.allChips.length - 1; i >= 0; i--) {
			if (NameMatch(this.allChips[i].Name, chipName)) this.allChips.splice(i, 1);
		}
		this.RebuildChipDescriptionLookup();
	}

	NotifyChipSaved(description: ChipDescription) {
		let foundChip = false;
		for (let i = 0; i < this.allChips.length; i++) {
			if (NameMatch(this.allChips[i].Name, description.Name)) {
				this.allChips[i] = description;
				foundChip = true;
				break;
			}
		}
		if (!foundChip) this.AddChipToLibrary(description);
		this.RebuildChipDescriptionLookup();
	}

	NotifyChipRenamed(description: ChipDescription, nameOld: string) {
		for (let i = 0; i < this.allChips.length; i++) {
			if (NameMatch(this.allChips[i].Name, nameOld)) {
				this.allChips[i] = description;
				break;
			}
		}
		this.RebuildChipDescriptionLookup();
	}

	GetAllCustomChipNames(): string[] {
		return this.allChips.filter((c) => !this.IsBuiltinChip(c.Name)).map((c) => c.Name);
	}

	// Returns the descriptions of all chips that use the given chip as a direct subchip
	GetDirectParentChips(chipName: string): ChipDescription[] {
		return this.allChips.filter((other) => other.SubChips != null && other.SubChips.some((s) => NameMatch(s.Name, chipName)));
	}

	private AddChipToLibrary(description: ChipDescription, hidden = false) {
		if (hidden) this.hiddenChips.push(description);
		else this.allChips.push(description);
	}
}

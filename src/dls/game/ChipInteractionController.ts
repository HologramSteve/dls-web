// Port of DLS.Game.ChipInteractionController
import { InputHelper, MouseButton } from "../../seb/helpers/InputHelper";
import { Maths } from "../../seb/helpers/Maths";
import { Vector2 } from "../../seb/types/Vector2";
import { ChipTypeHelper } from "../description/ChipTypeHelper";
import { ChipDescription, ChipType, PinAddress, clonePinDescription } from "../description/Types";
import { GridSize } from "../graphics/DrawSettings";
import { MenuType, UIDrawer } from "../graphics/ui/UIDrawer";
import { GetClosestPointOnWire } from "../graphics/WireLayoutHelper";
import { CreateBuiltinSubChipDescriptionForPlacement, CreatePinDescription, CreateSubChipDescription } from "../saveSystem/DescriptionCreator";
import { DevChipInstance } from "./DevChipInstance";
import { DevPinInstance } from "./elements/DevPinInstance";
import { IsMoveable, type IMoveable } from "./elements/Interfaces";
import { PinInstance } from "./elements/PinInstance";
import { SubChipInstance } from "./elements/SubChipInstance";
import { ConnectionInfo, WireInstance } from "./elements/WireInstance";
import { GridHelper, IDGenerator } from "./GridHelper";
import { InteractionState } from "./InteractionState";
import { KeyboardShortcuts } from "./KeyboardShortcuts";
import type { Project } from "./Project";

enum StraightLineMoveState {
	None,
	Horizontal,
	Vertical,
}

export class ChipInteractionController {
	readonly project: Project;

	// ---- Selection and placement state ----
	readonly SelectedElements: IMoveable[] = [];
	DuplicatedWires: WireInstance[] = [];
	WireToPlace: WireInstance | null = null;
	private isPlacingNewElements = false;
	private itemPlacementCurrVerticalSpacing = 0;
	private newElementsAreDuplicatedElements = false;
	private moveElementMouseStartPos = Vector2.zero;
	private Obstacles: IMoveable[] = []; // Obstacles are the non-selected items when a group of elements is being moved
	SelectionBoxStartPos = Vector2.zero;
	private straightLineMoveState = StraightLineMoveState.None;
	private hasExittedMultiModeSincePlacementStart = false;

	// ---- Wire edit state ----
	wireToEdit: WireInstance | null = null;
	wireEditPointIndex = -1;
	wireEditCanInsertPoint = false;
	private wireEditPointOld = Vector2.zero;
	wireEditPointSelectedIndex = 0;
	isMovingWireEditPoint = false;

	IsMovingSelection = false;
	IsCreatingSelectionBox = false;

	get ActiveDevChip(): DevChipInstance {
		return this.project.ViewedChip;
	}
	get SelectionBoxCentre(): Vector2 {
		return this.SelectionBoxStartPos.add(InputHelper.MousePosWorld).div(2);
	}
	get SelectionBoxSize(): Vector2 {
		return Maths.Abs(this.SelectionBoxStartPos.sub(InputHelper.MousePosWorld));
	}

	get HasControl(): boolean {
		return !UIDrawer.InInputBlockingMenu() && this.project.CanEditViewedChip;
	}

	// Cannot interact with elements when other elements are being moved, in a menu, or drawing a selection box
	private get CanInteract(): boolean {
		return !this.IsMovingSelection && !UIDrawer.InInputBlockingMenu() && !this.IsCreatingSelectionBox && !InteractionState.MouseIsOverUI;
	}
	get IsCreatingWire(): boolean {
		return this.WireToPlace != null;
	}
	get IsPlacingElements(): boolean {
		return this.isPlacingNewElements;
	}
	get IsPlacingElementOrCreatingWire(): boolean {
		return this.isPlacingNewElements || this.IsCreatingWire;
	}
	get IsPlacingOrMovingElementOrCreatingWire(): boolean {
		return this.isPlacingNewElements || this.IsMovingSelection || this.IsCreatingWire || this.isMovingWireEditPoint;
	}
	get CanInteractWithPin(): boolean {
		return this.CanInteract;
	}
	get CanInteractWithPinStateDisplay(): boolean {
		return this.CanInteract && !this.IsCreatingWire && this.project.CanEditViewedChip;
	}
	get CanInteractWithPinHandle(): boolean {
		return this.CanInteractWithPinStateDisplay;
	}

	constructor(project: Project) {
		this.project = project;
	}

	Update() {
		this.HandleKeyboardInput();
		this.HandleMouseInput();
	}

	// Don't allow interaction with wire that's currently being placed (this would allow it to try to connect to itself for example...)
	CanInteractWithWire(wire: WireInstance): boolean {
		return this.CanInteract && wire !== this.WireToPlace;
	}

	// If we're joining this wire to an existing wire, choose the appropriate source/target pin from that wire to connect to
	CanCompleteWireConnectionToWire(wireToConnectTo: WireInstance): [boolean, PinInstance] {
		const endPin = this.WireToPlace!.FirstPin!.IsSourcePin ? wireToConnectTo.TargetPin_BusCorrected : wireToConnectTo.SourcePin;
		return [this.CanCompleteWireConnection(endPin, wireToConnectTo), endPin];
	}

	CanCompleteWireConnection(endPin: PinInstance, wireToConnectTo: WireInstance | null = null): boolean {
		if (!this.IsCreatingWire) return false;
		const wireToPlace = this.WireToPlace!;

		const startPin = wireToPlace.FirstPin!;
		const connectingFromWire = wireToPlace.FirstConnectionInfo.IsConnectedAtWire;
		const connectingToWire = wireToConnectTo != null;
		const wireConnection = wireToConnectTo ?? wireToPlace.FirstConnectionInfo.connectedWire;

		// Don't allow wire-to-wire connections (ambiguous where to get signal source from, and where to carry it to)
		if (connectingFromWire && connectingToWire) return false;

		// (Maybe temporary restriction?): Don't allow sourcePin-to-wire connections (unless the wire is a bus wire).
		// This is because if the two source pins have different states, then the wire would need to be coloured differently
		// from the connection point onwards (depending on which of the conflicting states is chosen)
		if (connectingFromWire || connectingToWire) {
			const pinConnection = connectingToWire ? startPin : endPin;
			if (pinConnection.IsSourcePin && !wireConnection!.IsBusWire) return false;
		}

		// Ensure connection is between a source and a target pin
		// (note: if connection starts or ends at a wire then it's valid regardless, since we can just pick source/target pin from that wire as needed)
		const hasSourceAndTarget = startPin.IsSourcePin !== endPin.IsSourcePin || connectingFromWire || connectingToWire;
		if (!hasSourceAndTarget || endPin.bitCount !== startPin.bitCount) return false;

		// Only allow connecting bus origin and terminus if they are linked together (i.e. were created together at same time; rather than any random pair)
		// Note: could consider lifting this restriction, but need to investigate impact on simulation...
		if (startPin.IsBusPin && endPin.IsBusPin) {
			const busA = endPin.parent as SubChipInstance;
			const busB = startPin.parent as SubChipInstance;
			return busA.LinkedBusPairID === busB.ID;
		}

		return true;
	}

	static IsSelected(element: IMoveable): boolean {
		return element.IsSelected;
	}

	Delete(element: IMoveable) {
		this.DeleteElements([element]);
	}

	private DeleteElements(elements: IMoveable[], clearSelection = true) {
		if (!this.HasControl) return;
		const elementsToDelete = elements.concat(this.GetNonIncludedLinkedBusElements(elements));
		this.ActiveDevChip.UndoController.RecordDeleteElements(elementsToDelete);

		for (const element of elementsToDelete) {
			if (element instanceof SubChipInstance) this.ActiveDevChip.DeleteSubChip(element);
			else if (element instanceof DevPinInstance) this.ActiveDevChip.DeleteDevPin(element);
		}

		if (clearSelection) this.SelectedElements.length = 0;
	}

	private DeleteSelected() {
		const elementUnderMouse = InteractionState.ElementUnderMouse;
		// Delete selected subchips/pins
		if (this.SelectedElements.length > 0) {
			this.DeleteElements(this.SelectedElements.slice());
		}
		// Delete wire under mouse
		else if (elementUnderMouse instanceof WireInstance && elementUnderMouse !== this.wireToEdit) {
			this.DeleteWire(elementUnderMouse);
		}
		// Delete wire point under mouse (in wire edit mode)
		else if (this.wireToEdit != null && this.wireEditPointIndex !== -1) {
			const isWireToWireConnectionPoint = this.wireEditPointIndex === 0 || this.wireEditPointIndex === this.wireToEdit.WirePointCount - 1;
			// Can't delete the point connecting a wire to another wire
			if (!isWireToWireConnectionPoint) {
				for (const other of this.ActiveDevChip.Wires) {
					if (other.ConnectedWire === this.wireToEdit) other.NotifyParentWirePointWillBeDeleted(this.wireEditPointIndex);
				}

				this.wireToEdit.DeleteWirePoint(this.wireEditPointIndex);
				this.wireEditPointIndex = -1;
				this.isMovingWireEditPoint = false;
			}
		}
	}

	DeleteWire(wire: WireInstance) {
		if (this.HasControl) {
			this.ActiveDevChip.UndoController.RecordDeleteWire(wire);
			this.ActiveDevChip.DeleteWire(wire);
		}
	}

	ToggleDevPinState(devPin: DevPinInstance, bitIndex: number) {
		if (this.HasControl) devPin.ToggleState(bitIndex);
	}

	private HandleKeyboardInput() {
		// Ignore shortcuts if don't have control
		if (!this.HasControl) return;

		if (KeyboardShortcuts.UndoShortcutTriggered) this.ActiveDevChip.UndoController.TryUndo();
		else if (KeyboardShortcuts.RedoShortcutTriggered) this.ActiveDevChip.UndoController.TryRedo();

		if (!KeyboardShortcuts.StraightLineModeHeld) this.straightLineMoveState = StraightLineMoveState.None;

		if (KeyboardShortcuts.SearchShortcutTriggered) {
			UIDrawer.SetActiveMenu(MenuType.Search);
		}

		if (KeyboardShortcuts.DuplicateShortcutTriggered) {
			if (this.SelectedElements.length > 0 && !this.IsPlacingOrMovingElementOrCreatingWire) {
				this.DuplicateSelectedElements();
			}
		}

		if (KeyboardShortcuts.DeleteShortcutTriggered) {
			if (this.IsCreatingWire) {
				if (!this.WireToPlace!.RemoveLastPoint()) this.CancelEverything();
			} else {
				if (this.isPlacingNewElements) this.CancelPlacingItems();
				else this.DeleteSelected();
			}
		}

		if (KeyboardShortcuts.ConfirmShortcutTriggered) this.ExitWireEditMode();

		if (KeyboardShortcuts.CancelShortcutTriggered) this.CancelEverything();
	}

	private HandleMouseInput() {
		if (this.HasControl) this.UpdatePositionsToMouse();

		// --- Mouse button input ---
		if (InputHelper.IsMouseDownThisFrame(MouseButton.Left)) this.HandleLeftMouseDown();
		if (InputHelper.IsMouseUpThisFrame(MouseButton.Left)) this.HandleLeftMouseUp();
		if (InputHelper.IsMouseDownThisFrame(MouseButton.Right)) this.HandleRightMouseDown();

		// Shift + scroll to increase vertical spacing between elements when placing multiple at a time
		// (disabled if elements were duplicated since then we want to preserve relative positions)
		if (this.isPlacingNewElements && !this.newElementsAreDuplicatedElements && InputHelper.ShiftIsHeld) {
			this.itemPlacementCurrVerticalSpacing += InputHelper.MouseScrollDelta.y * GridSize;
			this.itemPlacementCurrVerticalSpacing = Math.max(0, this.itemPlacementCurrVerticalSpacing);
		}
	}

	private GetNonIncludedLinkedBusElements(elements: IMoveable[]): IMoveable[] {
		const nonIncludedBusPairs: IMoveable[] = [];
		const elementIDs = new Set(elements.map((e) => e.ID));

		for (const element of elements) {
			if (element instanceof SubChipInstance && element.IsBus) {
				if (!elementIDs.has(element.LinkedBusPairID)) {
					const pairedBus = this.ActiveDevChip.TryGetSubChipByID(element.LinkedBusPairID);
					if (pairedBus) nonIncludedBusPairs.push(pairedBus);
				}
			}
		}

		return nonIncludedBusPairs;
	}

	// Set the correct LinkedBusPairIDs on duplicated elements (still set to original IDs at this point)
	private static LinkDuplicatedBuses(duplicatedElements: IMoveable[], originalElements: IMoveable[]) {
		const busOrigins: SubChipInstance[] = [];
		const busTerminuses: SubChipInstance[] = [];

		const lookup = new Map<number, number>();
		for (const element of originalElements) {
			if (!(element instanceof SubChipInstance)) continue;
			if (ChipTypeHelper.IsBusTerminusType(element.ChipType)) lookup.set(element.ID, element.LinkedBusPairID);
		}

		for (const element of duplicatedElements) {
			if (!(element instanceof SubChipInstance)) continue;
			if (ChipTypeHelper.IsBusTerminusType(element.ChipType)) busTerminuses.push(element);
			else if (ChipTypeHelper.IsBusOriginType(element.ChipType)) busOrigins.push(element);
		}

		for (const busOrigin of busOrigins) {
			const originalBusOriginId = lookup.get(busOrigin.LinkedBusPairID);
			if (originalBusOriginId === undefined) throw new Error("KeyNotFound: bus pair");
			for (const busTerminus of busTerminuses) {
				if (busTerminus.LinkedBusPairID === originalBusOriginId) {
					busOrigin.SetLinkedBusPair(busTerminus);
					busTerminus.SetLinkedBusPair(busOrigin);
					break;
				}
			}
		}
	}

	private DuplicateElements(elements: IMoveable[]) {
		if (elements.length === 0) return;
		const elementsToDuplicate = elements.concat(this.GetNonIncludedLinkedBusElements(elements));

		const duplicatedElements: IMoveable[] = [];
		const duplicatedElementIDFromOriginalID = new Map<number, number>();

		// Get description of each element, and start placing a copy of it
		for (const element of elementsToDuplicate) {
			const duplicatedElement = this.CreateElementFromDuplicationSource(element);
			this.StartPlacingElement(duplicatedElement, element.Position, true);
			duplicatedElement.StraightLineReferencePoint = element.Position;
			duplicatedElements.push(duplicatedElement);
			duplicatedElementIDFromOriginalID.set(element.ID, duplicatedElement.ID);
		}

		ChipInteractionController.LinkDuplicatedBuses(duplicatedElements, elementsToDuplicate);

		// ---- Duplicate wires ----
		const duplicatedWireFromOriginal = new Map<WireInstance, WireInstance>();
		this.DuplicatedWires.length = 0;

		for (const wire of this.ActiveDevChip.Wires) {
			const sourceID = duplicatedElementIDFromOriginalID.get(wire.SourcePin.Address.PinOwnerID);
			const targetID = duplicatedElementIDFromOriginalID.get(wire.TargetPin.Address.PinOwnerID);

			if (sourceID !== undefined && targetID !== undefined) {
				const duplicatedSourcePinAddress = PinAddress(sourceID, wire.SourcePin.Address.PinID);
				const duplicatedTargetPinAddress = PinAddress(targetID, wire.TargetPin.Address.PinID);

				const duplicatedSourcePin = DevChipInstance.TryFindPinIn(duplicatedElements, duplicatedSourcePinAddress);
				const duplicatedTargetPin = DevChipInstance.TryFindPinIn(duplicatedElements, duplicatedTargetPinAddress);

				if (duplicatedSourcePin == null || duplicatedTargetPin == null) console.assert(false, "Pins not found for duplicated wire!");

				let duplicatedConnectedSourceWire: WireInstance | null = null;
				let duplicatedConnectedTargetWire: WireInstance | null = null;
				if (wire.SourceConnectionInfo.connectedWire != null) duplicatedConnectedSourceWire = duplicatedWireFromOriginal.get(wire.SourceConnectionInfo.connectedWire) ?? null;
				if (wire.TargetConnectionInfo.connectedWire != null) duplicatedConnectedTargetWire = duplicatedWireFromOriginal.get(wire.TargetConnectionInfo.connectedWire) ?? null;

				const sourceConnectionInfo = ConnectionInfo.Create({
					pin: duplicatedSourcePin,
					connectedWire: duplicatedConnectedSourceWire,
					connectionPoint: wire.SourceConnectionInfo.connectionPoint,
					wireConnectionSegmentIndex: wire.SourceConnectionInfo.wireConnectionSegmentIndex,
				});

				const targetConnectionInfo = ConnectionInfo.Create({
					pin: duplicatedTargetPin,
					connectedWire: duplicatedConnectedTargetWire,
					connectionPoint: wire.TargetConnectionInfo.connectionPoint,
					wireConnectionSegmentIndex: wire.TargetConnectionInfo.wireConnectionSegmentIndex,
				});

				const wirePoints: Vector2[] = new Array(wire.WirePointCount);
				for (let i = 0; i < wirePoints.length; i++) wirePoints[i] = wire.GetWirePoint(i);

				const duplicatedWire = new WireInstance(sourceConnectionInfo, targetConnectionInfo, wirePoints, this.ActiveDevChip.Wires.length + this.DuplicatedWires.length);
				duplicatedWireFromOriginal.set(wire, duplicatedWire);
				this.DuplicatedWires.push(duplicatedWire);
			}
		}

		// Find element closest to mouse to use as origin point for duplicated elements
		const mousePos = InputHelper.MousePosWorld;
		let closestElementPos = Vector2.zero;
		let closestDst = Number.MAX_VALUE;

		for (const element of elementsToDuplicate) {
			const pos = element instanceof DevPinInstance ? element.HandlePosition : element.Position;
			const dst = Vector2.distance(pos, mousePos);
			if (dst < closestDst) {
				closestDst = dst;
				closestElementPos = pos;
			}
		}

		const offset = InputHelper.MousePosWorld.sub(closestElementPos);
		this.moveElementMouseStartPos = this.moveElementMouseStartPos.sub(offset);
	}

	private DuplicateSelectedElements() {
		this.DuplicateElements(this.SelectedElements.slice());
	}

	Select(element: IMoveable, addToCurrentSelection = true) {
		this.ExitWireEditMode();

		if (element.IsSelected) {
			// If in add mode, and element already selected, then remove it from the selection
			if (addToCurrentSelection) {
				element.IsSelected = false;
				const i = this.SelectedElements.indexOf(element);
				if (i >= 0) this.SelectedElements.splice(i, 1);
			}
		} else {
			if (!addToCurrentSelection) this.ClearSelection();

			this.SelectedElements.push(element);
			element.IsSelected = true;
			element.IsValidMovePos = true;
		}
	}

	private HandleRightMouseDown() {
		// Cancel placement by right-clicking
		if (this.IsPlacingOrMovingElementOrCreatingWire) {
			this.CancelEverything();
			InputHelper.ConsumeMouseButtonDownEvent(MouseButton.Right);
		}

		this.IsCreatingSelectionBox = false;
		this.ClearSelection();
	}

	private HandleLeftMouseDown() {
		this.SelectionBoxStartPos = InputHelper.MousePosWorld;
		this.straightLineMoveState = StraightLineMoveState.None;

		const elementUnderMouse = InteractionState.ElementUnderMouse;
		if (elementUnderMouse == null) this.ExitWireEditMode();

		if (InteractionState.MouseIsOverUI) return;

		// Confirm placement of new item
		if (this.IsPlacingElementOrCreatingWire) {
			// Place wire
			if (this.IsCreatingWire) {
				if (this.TryFinishPlacingWire()) {
					this.CancelPlacingItems();
				} else if (this.CanAddWirePoint()) {
					this.WireToPlace!.AddWirePoint(InputHelper.MousePosWorld);
				}
			}
			// Place subchip / devpin
			else {
				this.FinishPlacingNewElements();
			}
		} else {
			// Mouse down on pin: start placing wire
			if (elementUnderMouse instanceof PinInstance && this.HasControl) {
				this.StartPlacingWire(ConnectionInfo.Create({ pin: elementUnderMouse }));
			}
			// Mouse down on wire
			else if (elementUnderMouse instanceof WireInstance && this.HasControl) {
				// Insert a point on the currently edited wire
				if (elementUnderMouse === this.wireToEdit) {
					if (this.wireEditCanInsertPoint) {
						const [point, segmentIndex] = GetClosestPointOnWire(this.wireToEdit, InputHelper.MousePosWorld);
						this.wireToEdit.InsertPoint(point, segmentIndex);
						this.wireEditPointIndex = segmentIndex + 1;
					}
				}
				// Start placing a new wire from this point on the selected wire
				else {
					const connectionInfo = this.CreateWireToWireConnectionInfo(elementUnderMouse, elementUnderMouse.SourcePin);
					this.StartPlacingWire(connectionInfo);
				}
			}
			// Mouse down on selectable element: select it and prepare to start moving current selection
			else if (IsMoveable(elementUnderMouse)) {
				const addToSelection = KeyboardShortcuts.MultiModeHeld;
				this.Select(elementUnderMouse, addToSelection);
				this.StartMovingSelectedItems();
			}
			// Mouse down over nothing: clear selection
			else if (elementUnderMouse == null && !this.IsPlacingElementOrCreatingWire) {
				if (!KeyboardShortcuts.MultiModeHeld) this.ClearSelection(); // don't clear if in 'multi-mode' (to allow box selecting multiple times)
				this.IsCreatingSelectionBox = true;
			}

			if (this.wireToEdit != null && this.wireEditPointIndex !== -1) {
				this.isMovingWireEditPoint = true;
				this.wireEditPointSelectedIndex = this.wireEditPointIndex;
				this.wireEditPointOld = this.wireToEdit.GetWirePoint(this.wireEditPointIndex);
			}
		}
	}

	private CreateWireToWireConnectionInfo(wireToConnectTo: WireInstance, pin: PinInstance): ConnectionInfo {
		let mousePos = InputHelper.MousePosWorld;
		if (this.project.ShouldSnapToGrid) mousePos = GridHelper.SnapToGridV(mousePos, true, true);

		// If connecting a new wire to an existing wire, the target connection point is end pos of new wire (this is mouse pos but with snapping options applied)
		// Otherwise if creating a new wire from an existing wire, connection point is at mouse pos.
		const targetPoint = this.WireToPlace?.GetWirePoint(this.WireToPlace.WirePointCount - 1) ?? mousePos;
		// Find where target connection point is closest to the target wire.
		const [bestPoint, bestSegmentIndex] = GetClosestPointOnWire(wireToConnectTo, targetPoint);

		return ConnectionInfo.Create({
			pin,
			connectedWire: wireToConnectTo,
			wireConnectionSegmentIndex: bestSegmentIndex,
			connectionPoint: bestPoint,
		});
	}

	private StartPlacingWire(connectionInfo: ConnectionInfo) {
		this.ExitWireEditMode();
		this.ClearSelection();
		const wires = this.project.ViewedChip.Wires;
		const spawnOrder = wires.length > 0 ? wires[wires.length - 1].spawnOrder + 1 : 0;
		this.WireToPlace = new WireInstance(connectionInfo, spawnOrder);
	}

	private FinishMovingElements() {
		// -- If any elements are in invalid position, cancel the movement --
		let hasMoved = false;

		for (const element of this.SelectedElements) {
			if (!element.IsValidMovePos) {
				this.CancelMovingSelectedItems();
				return;
			}

			hasMoved ||= Vector2.neq(element.MoveStartPosition, element.Position);
		}

		if (hasMoved) this.ActiveDevChip.UndoController.RecordMoveElements(this.SelectedElements);

		// -- Apply movement --
		this.IsMovingSelection = false;

		for (const wire of this.ActiveDevChip.Wires) wire.ApplyMoveOffset();
	}

	private FinishPlacingNewElements() {
		// ---- If any elements are in invalid position, don't allow the placement ----
		for (const element of this.SelectedElements) {
			if (!element.IsValidMovePos) return;
		}

		const newlyPlacedElements = this.SelectedElements.slice();

		// ---- Add newly placed elements to the chip ----
		for (const elementToPlace of this.SelectedElements) {
			if (elementToPlace instanceof SubChipInstance) this.ActiveDevChip.AddNewSubChip(elementToPlace, false);
			else if (elementToPlace instanceof DevPinInstance) this.ActiveDevChip.AddNewDevPin(elementToPlace, false);
		}

		for (const wire of this.DuplicatedWires) {
			this.ActiveDevChip.AddWire(wire, false);
			wire.ApplyMoveOffset();
		}

		this.ActiveDevChip.UndoController.RecordAddElements(this.SelectedElements, this.DuplicatedWires.length > 0);
		this.DuplicatedWires.length = 0;
		this.OnFinishedPlacingItems();

		if (KeyboardShortcuts.MultiModeHeld) this.DuplicateElements(newlyPlacedElements);
	}

	EnterWireEditMode(wire: WireInstance) {
		if (this.wireToEdit === wire) this.ExitWireEditMode();
		else this.wireToEdit = wire;
	}

	private ExitWireEditMode() {
		if (this.wireToEdit != null && this.isMovingWireEditPoint) {
			this.wireToEdit.SetWirePoint(this.wireEditPointOld, this.wireEditPointSelectedIndex);
		}

		this.wireToEdit = null;
		this.isMovingWireEditPoint = false;
		this.wireEditPointIndex = -1;
		this.wireEditPointSelectedIndex = -1;
	}

	private HandleLeftMouseUp() {
		// Place items that are being moved
		if (!this.IsPlacingElementOrCreatingWire) {
			if (this.IsMovingSelection) this.FinishMovingElements();
		}

		// Select all selectable elements inside selection box
		if (this.IsCreatingSelectionBox) {
			if (!KeyboardShortcuts.MultiModeHeld) this.ClearSelection();
			this.IsCreatingSelectionBox = false;

			const size = this.SelectionBoxSize;
			const selectionBoxArea = Math.abs(size.x * size.y);
			if (selectionBoxArea > 0.000001) {
				const centre = this.SelectionBoxCentre;
				for (const element of this.ActiveDevChip.Elements) {
					if (element.ShouldBeIncludedInSelectionBox(centre, size)) this.Select(element);
				}
			}
		}

		if (this.IsCreatingWire) {
			if (this.TryFinishPlacingWire()) this.CancelPlacingItems();
		}

		if (this.wireToEdit != null) {
			this.wireEditPointSelectedIndex = -1;
			this.isMovingWireEditPoint = false;
		}
	}

	private UpdatePositionsToMouse() {
		const mousePos = InputHelper.MousePosWorld;
		const snapToGrid = this.project.ShouldSnapToGrid;

		if (this.IsCreatingWire) {
			this.WireToPlace!.SetLastWirePoint(mousePos);
		} else if (this.IsMovingSelection || this.isPlacingNewElements) {
			const moveOffset = mousePos.sub(this.moveElementMouseStartPos);

			for (let i = 0; i < this.SelectedElements.length; i++) {
				const element = this.SelectedElements[i];
				const isBusTerminus = element instanceof SubChipInstance && ChipTypeHelper.IsBusTerminusType(element.ChipType);
				const multiElementOffset = isBusTerminus ? Vector2.zero : Vector2.down.mul(this.itemPlacementCurrVerticalSpacing * i);

				const totalOffset = moveOffset.add(multiElementOffset);
				let targetPos = element.MoveStartPosition.add(totalOffset);

				if (snapToGrid) {
					if (i === 0) {
						targetPos = GridHelper.SnapMovingElementToGrid(element, totalOffset, false, true);
					}
					// Snap additional selected elements relative to the first one. (Snapping each element independently results in a 'jiggling' effect)
					else {
						// Get snap points prior to movement
						const prevElement = this.SelectedElements[i - 1];
						const snapPointStartA = prevElement.MoveStartPosition.add(prevElement.SnapPoint.sub(prevElement.Position));
						const snapPointStartB = element.MoveStartPosition.add(element.SnapPoint.sub(element.Position));
						// Base curr element's snap pos on prev element, adding the (snapped) difference between their initial snap points
						const placementManualOffset = isBusTerminus ? Vector2.zero : Vector2.down.mul(this.itemPlacementCurrVerticalSpacing);

						const snappedOffset = GridHelper.SnapToGridV(snapPointStartB.sub(snapPointStartA).add(placementManualOffset), false, true);
						const elementSnapPointOffset = element.SnapPoint.sub(element.Position);
						targetPos = prevElement.SnapPoint.add(snappedOffset).sub(elementSnapPointOffset);
					}
				}

				// When using shift to duplicate new element, don't use straight line mode unless pressed again
				if (this.isPlacingNewElements && !KeyboardShortcuts.MultiModeHeld) this.hasExittedMultiModeSincePlacementStart = true;

				if (KeyboardShortcuts.StraightLineModeHeld && element.HasReferencePointForStraightLineMovement && (!this.isPlacingNewElements || this.hasExittedMultiModeSincePlacementStart)) {
					let offset = targetPos.sub(element.StraightLineReferencePoint);
					const ox = Math.abs(offset.x);
					const oy = Math.abs(offset.y);
					const canChangeState = this.straightLineMoveState === StraightLineMoveState.None || this.isPlacingNewElements;
					if (Math.max(ox, oy) > 0.035 && canChangeState) {
						this.straightLineMoveState = ox > oy ? StraightLineMoveState.Horizontal : StraightLineMoveState.Vertical;
					}

					if (this.straightLineMoveState === StraightLineMoveState.Horizontal) offset = offset.withY(0);
					else if (this.straightLineMoveState === StraightLineMoveState.Vertical) offset = offset.withX(0);
					targetPos = element.StraightLineReferencePoint.add(offset);
				}

				element.Position = targetPos;

				// Test if is legal position
				let legal = true;
				const bounds = element.BoundingBox;
				for (const obstacle of this.Obstacles) {
					if (bounds.Overlaps(obstacle.BoundingBox)) {
						legal = false;
						break;
					}
				}

				element.IsValidMovePos = legal;
			}

			// Update wires when their parents are moved
			if (this.isPlacingNewElements) {
				for (const wire of this.DuplicatedWires) {
					const delA = wire.SourcePin.parent.Position.sub(wire.SourcePin.parent.MoveStartPosition);
					const delB = wire.TargetPin.parent.Position.sub(wire.TargetPin.parent.MoveStartPosition);
					// Parent chips may have been moved by slightly different amounts if snapping is enabled, so just take average
					wire.MoveOffset = delA.add(delB).div(2);
				}
			} else {
				for (const wire of this.ActiveDevChip.Wires) {
					// If both ends of the wire are being moved, then move the entire wire
					if (ChipInteractionController.IsSelected(wire.SourcePin.parent) && ChipInteractionController.IsSelected(wire.TargetPin.parent)) {
						const delA = wire.SourcePin.parent.Position.sub(wire.SourcePin.parent.MoveStartPosition);
						const delB = wire.TargetPin.parent.Position.sub(wire.TargetPin.parent.MoveStartPosition);
						// Parent chips may have been moved by slightly different amounts if snapping is enabled, so just take average
						wire.MoveOffset = delA.add(delB).div(2);
					}
				}
			}
		} else if (this.isMovingWireEditPoint) {
			this.wireToEdit!.SetWirePointWithSnapping(mousePos, this.wireEditPointSelectedIndex, this.wireEditPointOld);
		}
	}

	private StartMovingSelectedItems() {
		this.IsMovingSelection = true;
		this.moveElementMouseStartPos = InputHelper.MousePosWorld;

		for (const moveableElement of this.SelectedElements) {
			moveableElement.MoveStartPosition = moveableElement.Position;
			moveableElement.StraightLineReferencePoint = moveableElement.Position;
			moveableElement.HasReferencePointForStraightLineMovement = true;
		}

		this.Obstacles = this.ActiveDevChip.Elements.filter((e) => !e.IsSelected);
	}

	private TryFinishPlacingWire(): boolean {
		const elementUnderMouse = InteractionState.ElementUnderMouse;
		const CompleteConnection = (info: ConnectionInfo) => {
			const wire = this.WireToPlace!;
			wire.FinishPlacingWire(info);
			this.ActiveDevChip.AddWire(wire, false);
			this.ActiveDevChip.UndoController.RecordAddWire(wire);
		};

		if (elementUnderMouse instanceof PinInstance) {
			if (this.CanCompleteWireConnection(elementUnderMouse)) {
				CompleteConnection(ConnectionInfo.Create({ pin: elementUnderMouse }));
				return true;
			}
		} else if (elementUnderMouse instanceof WireInstance) {
			const [canComplete, endPin] = this.CanCompleteWireConnectionToWire(elementUnderMouse);
			if (canComplete) {
				CompleteConnection(this.CreateWireToWireConnectionInfo(elementUnderMouse, endPin));
				return true;
			}
		}

		return false;
	}

	private CanAddWirePoint(): boolean {
		const elementUnderMouse = InteractionState.ElementUnderMouse;
		// Can add wire point if mouse is not over anything else
		if (elementUnderMouse == null) return true;

		// Can add wire point if mouse is over an existing wire, but that wire comes from same pin as current wire (might want to trace over existing wire for example)
		if (elementUnderMouse instanceof WireInstance) {
			const first = this.WireToPlace!.FirstPin;
			if (elementUnderMouse.SourcePin === first || elementUnderMouse.TargetPin === first) return true;
		}

		return false;
	}

	StartPlacingByName(name: string) {
		this.StartPlacing(this.project.chipLibrary.GetChipDescription(name));
	}

	StartPlacing(chipDescription: ChipDescription) {
		this.StartPlacingAt(chipDescription, InputHelper.MousePosWorld, false);
	}

	StartPlacingAt(chipDescription: ChipDescription, position: Vector2, isDuplicating: boolean): IMoveable {
		const elementToPlace = this.CreateElementFromChipDescription(chipDescription);
		this.StartPlacingElement(elementToPlace, position, isDuplicating);
		return elementToPlace;
	}

	private StartPlacingElement(elementToPlace: IMoveable, position: Vector2, isDuplicating: boolean) {
		const busPairSpacing = GridSize * 8;
		this.newElementsAreDuplicatedElements = isDuplicating;

		if (!this.isPlacingNewElements) {
			this.CancelEverything();
			this.isPlacingNewElements = true;
			this.hasExittedMultiModeSincePlacementStart = false;
			this.StartMovingSelectedItems();
		}

		let chipType: ChipType;
		if (elementToPlace instanceof DevPinInstance) chipType = ChipTypeHelper.GetPinType(elementToPlace.IsInputPin, elementToPlace.BitCount);
		else chipType = (elementToPlace as SubChipInstance).ChipType;

		const selected = this.SelectedElements;
		const last = selected[selected.length - 1];

		// Place bus terminus to right of bus origin
		if (ChipTypeHelper.IsBusTerminusType(chipType) && !isDuplicating) {
			elementToPlace.MoveStartPosition = last.MoveStartPosition.add(Vector2.right.mul(busPairSpacing));
			elementToPlace.HasReferencePointForStraightLineMovement = false;
		}
		// If placing multiple elements simultaneously, place the new element below the previous one
		// (unless duplicating elements, in which case their relative positions should be preserved)
		else if (selected.length > 0 && !isDuplicating) {
			const spacing = (elementToPlace.SelectionBoundingBox.Size.y + last.SelectionBoundingBox.Size.y) / 2;

			let prevElementPos = last.MoveStartPosition;
			// If prev element was bus terminus, we want the midpoint between the bus origin and terminus pair
			if (last instanceof SubChipInstance && ChipTypeHelper.IsBusTerminusType(last.ChipType)) {
				prevElementPos = prevElementPos.add(selected[selected.length - 2].MoveStartPosition).div(2);
			}

			elementToPlace.MoveStartPosition = prevElementPos.add(Vector2.down.mul(spacing));
			elementToPlace.HasReferencePointForStraightLineMovement = false;
		} else {
			this.moveElementMouseStartPos = InputHelper.MousePosWorld;
			elementToPlace.MoveStartPosition = position;
			elementToPlace.StraightLineReferencePoint = position;
			elementToPlace.HasReferencePointForStraightLineMovement = isDuplicating;
		}

		this.Select(elementToPlace);

		// When placing bus, auto-place the corresponding bus terminus (unless duplicating an existing bus)
		if (ChipTypeHelper.IsBusOriginType(chipType) && !isDuplicating) {
			elementToPlace.MoveStartPosition = elementToPlace.MoveStartPosition.sub(Vector2.right.mul(busPairSpacing / 2));

			const terminusType = ChipTypeHelper.GetCorrespondingBusTerminusType(chipType);
			const terminusDescription = this.project.chipLibrary.GetChipDescription(ChipTypeHelper.GetName(terminusType));
			const terminus = this.StartPlacingAt(terminusDescription, position, false) as SubChipInstance;

			const busOrigin = elementToPlace as SubChipInstance;
			busOrigin.SetLinkedBusPair(terminus);
			terminus.SetLinkedBusPair(busOrigin);
		}
	}

	private CreateElementFromChipDescription(chipDescription: ChipDescription): IMoveable {
		let elementToPlace: IMoveable;
		const instanceID = IDGenerator.GenerateNewElementID(this.ActiveDevChip.Elements);

		// Input/output dev pins are represented as chips for convenience
		const [isInput, isOutput] = ChipTypeHelper.IsInputOrOutputPin(chipDescription.ChipType);

		if (isInput || isOutput) {
			// Dev pin (struct copy in the original)
			const pinDesc = clonePinDescription(isInput ? chipDescription.InputPins[0] : chipDescription.OutputPins[0]);
			pinDesc.ID = instanceID;
			elementToPlace = new DevPinInstance(pinDesc, isInput);
		} else {
			// SubChip
			const subChipDesc = CreateBuiltinSubChipDescriptionForPlacement(chipDescription.ChipType, chipDescription.Name, instanceID, Vector2.zero);
			elementToPlace = new SubChipInstance(chipDescription, subChipDesc);
		}

		return elementToPlace;
	}

	private CreateElementFromDuplicationSource(duplicationSource: IMoveable): IMoveable {
		let element: IMoveable;
		const instanceID = IDGenerator.GenerateNewElementID(this.ActiveDevChip.Elements);

		if (duplicationSource instanceof DevPinInstance) {
			const pinDesc = CreatePinDescription(duplicationSource);
			pinDesc.ID = instanceID;
			element = new DevPinInstance(pinDesc, duplicationSource.IsInputPin);
		} else {
			const src = duplicationSource as SubChipInstance;
			const subChipDesc = CreateSubChipDescription(src);
			subChipDesc.ID = instanceID;
			element = new SubChipInstance(src.Description, subChipDesc);
		}

		return element;
	}

	CancelEverything() {
		this.CancelMovingSelectedItems();
		this.CancelPlacingItems();
		this.ClearSelection();
		this.IsCreatingSelectionBox = false;
		this.isPlacingNewElements = false;
		this.ExitWireEditMode();
	}

	private ClearSelection() {
		for (const element of this.SelectedElements) {
			element.IsSelected = false;
			element.IsValidMovePos = true;
		}

		this.SelectedElements.length = 0;
	}

	private CancelMovingSelectedItems() {
		if (this.IsMovingSelection && this.SelectedElements.length > 0) {
			for (const moveableElement of this.SelectedElements) moveableElement.Position = moveableElement.MoveStartPosition;
			for (const wire of this.ActiveDevChip.Wires) wire.MoveOffset = Vector2.zero;
		}

		this.IsMovingSelection = false;
	}

	private OnFinishedPlacingItems() {
		this.OnFinishedOrCancelledPlacingItems();
	}

	private CancelPlacingItems() {
		// If canceling placement of bus terminus, destroy the linked bus origin
		if (this.isPlacingNewElements) {
			this.DuplicatedWires.length = 0;

			for (const element of this.SelectedElements) {
				if (element instanceof SubChipInstance && element.IsBus) this.ActiveDevChip.TryDeleteSubChipByID(element.LinkedBusPairID);
			}
		}

		this.OnFinishedOrCancelledPlacingItems();
	}

	private OnFinishedOrCancelledPlacingItems() {
		this.ClearSelection();
		this.IsMovingSelection = false;

		this.isPlacingNewElements = false;
		this.newElementsAreDuplicatedElements = false;
		this.WireToPlace = null;
		this.itemPlacementCurrVerticalSpacing = 0;
	}
}

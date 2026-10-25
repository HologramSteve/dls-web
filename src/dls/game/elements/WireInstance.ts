// Port of DLS.Game.WireInstance
import { Vector2 } from "../../../seb/types/Vector2";
import { Color } from "../../../seb/types/Color";
import { PinAddressEquals, PinBitCount } from "../../description/Types";
import { ActiveTheme } from "../../graphics/DrawSettings";
import { GetClosestPointOnWire } from "../../graphics/WireLayoutHelper";
import { GridHelper } from "../GridHelper";
import { Project } from "../Project";
import type { IInteractable } from "./Interfaces";
import type { PinInstance } from "./PinInstance";
import type { SubChipInstance } from "./SubChipInstance";

// C# struct: copied on assignment. Use clone() wherever the original copies the value.
export class ConnectionInfo {
	pin: PinInstance | null = null;
	// ---- Properties for a connection to another wire, rather than directly to a pin ----
	connectedWire: WireInstance | null = null;
	wireConnectionSegmentIndex = 0; // Index of first point on segment where this connection is made
	connectionPoint = Vector2.zero;

	static Create(init: Partial<ConnectionInfo>): ConnectionInfo {
		const c = new ConnectionInfo();
		Object.assign(c, init);
		return c;
	}

	get IsConnectedAtWire(): boolean {
		return this.connectedWire !== null;
	}

	clone(): ConnectionInfo {
		const c = new ConnectionInfo();
		c.pin = this.pin;
		c.connectedWire = this.connectedWire;
		c.wireConnectionSegmentIndex = this.wireConnectionSegmentIndex;
		c.connectionPoint = this.connectionPoint;
		return c;
	}
}

export class BitWire {
	Points: Vector2[] = [];
}

export class WireInstance implements IInteractable {
	readonly isInteractable = true as const;
	readonly bitCount: PinBitCount;

	// Wire points for multi-bit wires. Note: must be populated with points when drawing
	readonly BitWires: BitWire[];

	// The first connected pin when player is creating the wire
	readonly FirstPin: PinInstance | null = null;
	readonly spawnOrder: number;

	// Points defining shape of wire (first and last points are sourcePin and targetPin)
	private WirePoints: Vector2[] = [];

	// If this wire connects to a wire, which connects to another wire, then its recursion depth is 2. (this is used for ordering when drawing)
	ConnectedWireRecursionDepth = 0;
	descriptionCreator_wireIndex = 0;
	drawOrder = 0;

	// An offset to be applied to all wire points (this is used when a wire is being moved, but the move has not yet been confirmed)
	MoveOffset = Vector2.zero;

	// For wires that connect to/from another wire, this is the original connection point (plus move offsets)
	originalWireConnectionPoint = Vector2.zero;

	SourceConnectionInfo = new ConnectionInfo();
	TargetConnectionInfo = new ConnectionInfo();

	// Create wire from saved info: (source, target, points, spawnOrder)
	// Create incomplete wire (used when starting to place the wire): (firstConnectionInfo, spawnOrder)
	constructor(sourceOrFirst: ConnectionInfo, targetOrSpawn: ConnectionInfo | number, points?: Vector2[], spawnOrder?: number) {
		if (targetOrSpawn instanceof ConnectionInfo) {
			const sourceConnection = sourceOrFirst.clone();
			const targetConnection = targetOrSpawn.clone();
			this.bitCount = sourceConnection.pin!.bitCount;
			this.SourceConnectionInfo = sourceConnection;
			this.TargetConnectionInfo = targetConnection;

			this.WirePoints = points!.slice();
			this.originalWireConnectionPoint = sourceConnection.IsConnectedAtWire ? points![0] : points![points!.length - 1];
			this.BitWires = Array.from({ length: this.bitCount }, () => new BitWire());
			this.ConnectedWireRecursionDepth = CalculateConnectedWireRecursionDepth(this);
			this.spawnOrder = spawnOrder!;
		} else {
			const firstConnectionInfo = sourceOrFirst.clone();
			const firstPin = firstConnectionInfo.pin!;
			this.FirstPin = firstPin;

			if (firstPin.IsSourcePin) this.SourceConnectionInfo = firstConnectionInfo;
			else this.TargetConnectionInfo = firstConnectionInfo;

			this.bitCount = firstPin.bitCount;
			this.originalWireConnectionPoint = firstConnectionInfo.connectionPoint;
			this.WirePoints.push(this.GetAttachmentPoint(firstConnectionInfo));
			this.WirePoints.push(this.WirePoints[0]); // end point to be controlled by mouse during placement mode

			this.BitWires = Array.from({ length: this.bitCount }, () => new BitWire());
			this.spawnOrder = targetOrSpawn;
		}
	}

	// The pin from which this wire receives its signal
	get SourcePin(): PinInstance {
		return this.SourceConnectionInfo.pin!;
	}

	// The pin to which this wire carries its signal
	get TargetPin(): PinInstance {
		return this.TargetConnectionInfo.pin!;
	}

	get TargetPin_BusCorrected(): PinInstance {
		return GetBusCorrectedTargetPin(this);
	}

	get WirePointCount(): number {
		return this.WirePoints.length;
	}

	get IsFullyConnected(): boolean {
		return this.SourceConnectionInfo.pin != null && this.TargetConnectionInfo.pin != null;
	}

	get IsBusWire(): boolean {
		return this.IsFullyConnected && this.SourcePin.IsBusPin && this.TargetPin.IsBusPin;
	}

	get FirstConnectionInfo(): ConnectionInfo {
		return this.SourceConnectionInfo.pin == null ? this.TargetConnectionInfo : this.SourceConnectionInfo;
	}

	// If this wire was connect to/from another wire, then that wire can be accessed here (otherwise is null)
	get ConnectedWire(): WireInstance | null {
		return this.SourceConnectionInfo.connectedWire ?? this.TargetConnectionInfo.connectedWire;
	}

	// Finish placing the wire
	FinishPlacingWire(connection: ConnectionInfo) {
		connection = connection.clone();
		const endPin = connection.pin!;
		this.WirePoints[this.WirePoints.length - 1] = endPin.GetWorldPos();

		// If wire connection started out at another wire, it is not known (until now when we have the end pin) whether that
		// initial connection should be to the source or target pin of that wire (so correct if needed)
		const correctedFirstConnection = this.FirstConnectionInfo.clone();
		if (this.FirstConnectionInfo.pin!.IsSourcePin === endPin.IsSourcePin) {
			if (endPin.IsSourcePin) correctedFirstConnection.pin = GetBusCorrectedTargetPin(this.FirstConnectionInfo.connectedWire!);
			else correctedFirstConnection.pin = this.FirstConnectionInfo.connectedWire!.SourcePin;
		}

		if (endPin.IsSourcePin) {
			// If started placing wire from the target pin, flip the wire points around so always flow from source to target
			this.WirePoints.reverse();
			this.TargetConnectionInfo = correctedFirstConnection;
			this.SourceConnectionInfo = connection;
		} else {
			this.SourceConnectionInfo = correctedFirstConnection;
			this.TargetConnectionInfo = connection;
		}

		this.originalWireConnectionPoint = this.SourceConnectionInfo.IsConnectedAtWire ? this.SourceConnectionInfo.connectionPoint : this.TargetConnectionInfo.connectionPoint;
		this.ConnectedWireRecursionDepth = CalculateConnectedWireRecursionDepth(this);
	}

	private GetAttachmentPoint(connection: ConnectionInfo): Vector2 {
		if (connection.IsConnectedAtWire) {
			const cw = connection.connectedWire!;
			const posA = cw.GetWirePoint(connection.wireConnectionSegmentIndex);
			const posB = cw.GetWirePoint(connection.wireConnectionSegmentIndex + 1);
			return WireInstance.ClosestPointOnLineSegment(this.originalWireConnectionPoint.add(this.MoveOffset), posA, posB);
		}
		return connection.pin!.GetWorldPos();
	}

	GetWirePoint(i: number): Vector2 {
		if (this.IsFullyConnected) {
			// Get start/end point specially, since these can change if another chip is moved for example
			if (i === 0) return this.GetAttachmentPoint(this.SourceConnectionInfo);
			if (i === this.WirePoints.length - 1) return this.GetAttachmentPoint(this.TargetConnectionInfo);
		} else {
			// If not fully connected then end point is controlled by mouse, so we don't want to override
			if (i === 0) return this.GetAttachmentPoint(this.FirstConnectionInfo);
		}
		// Other points
		return this.WirePoints[i].add(this.MoveOffset);
	}

	ApplyMoveOffset() {
		for (let i = 0; i < this.WirePoints.length; i++) this.WirePoints[i] = this.WirePoints[i].add(this.MoveOffset);
		this.originalWireConnectionPoint = this.originalWireConnectionPoint.add(this.MoveOffset);
		this.MoveOffset = Vector2.zero;
	}

	SetWirePoint(p: Vector2, i: number) {
		const isConnectedToWireAtThisPoint = (i === 0 && this.SourceConnectionInfo.IsConnectedAtWire) || (i === this.WirePoints.length - 1 && this.TargetConnectionInfo.IsConnectedAtWire);
		if (isConnectedToWireAtThisPoint) {
			const [bestPoint, bestSegmentIndex] = GetClosestPointOnWire(this.ConnectedWire!, p);
			const connectionInfo = this.GetWireConnectionInfo();
			connectionInfo.wireConnectionSegmentIndex = bestSegmentIndex;
			connectionInfo.connectionPoint = bestPoint;
			this.originalWireConnectionPoint = bestPoint;
		}
		this.WirePoints[i] = p;
	}

	SetWirePointWithSnapping(p: Vector2, i: number, straightLineRefPoint: Vector2) {
		if (Project.ActiveProject.ShouldSnapToGrid) p = GridHelper.SnapToGridV(p, true, true);
		if (Project.ActiveProject.ForceStraightWires) p = GridHelper.ForceStraightLine(straightLineRefPoint, p);
		this.SetWirePoint(p, i);
	}

	SetLastWirePoint(p: Vector2) {
		this.SetWirePointWithSnapping(p, this.WirePoints.length - 1, this.GetWirePoint(this.WirePoints.length - 2));
	}

	AddWirePoint(p: Vector2) {
		this.WirePoints.push(p);
	}

	DeleteWirePoint(i: number) {
		this.WirePoints.splice(i, 1);
	}

	InsertPoint(p: Vector2, segmentIndex: number) {
		const insertionT = PointOnSegmentT(this.GetWirePoint(segmentIndex), this.GetWirePoint(segmentIndex + 1), p);
		Project.ActiveProject.ViewedChip.NotifyConnectedWiresPointsInserted(this, segmentIndex, insertionT, 1);
		this.WirePoints.splice(segmentIndex + 1, 0, p);
	}

	RemoveLastPoint(): boolean {
		if (this.WirePoints.length > 2) {
			this.WirePoints.pop();
			return true;
		}
		return false;
	}

	// Connection info for the end of this wire that connects to another wire (returned by reference)
	GetWireConnectionInfo(): ConnectionInfo {
		return this.SourceConnectionInfo.IsConnectedAtWire ? this.SourceConnectionInfo : this.TargetConnectionInfo;
	}

	NotifyParentWirePointsInserted(insertIndex: number, insertPointT: number, num: number) {
		const connectionInfo = this.GetWireConnectionInfo();
		if (connectionInfo.wireConnectionSegmentIndex < insertIndex) return; // connected point is before insertion point, so is unaffected

		if (connectionInfo.wireConnectionSegmentIndex === insertIndex) {
			const cw = this.ConnectedWire!;
			const segA = cw.GetWirePoint(connectionInfo.wireConnectionSegmentIndex);
			const segB = cw.GetWirePoint(connectionInfo.wireConnectionSegmentIndex + 1);
			const p = this.GetAttachmentPoint(connectionInfo);
			const selfT = PointOnSegmentT(segA, segB, p);
			if (selfT < insertPointT) return; // connected point is on same segment as inserted point, but is before it
		}

		connectionInfo.wireConnectionSegmentIndex += num;
	}

	NotifyParentWirePointWillBeDeleted(deletedPointIndex: number) {
		const connectionInfo = this.GetWireConnectionInfo();
		if (connectionInfo.wireConnectionSegmentIndex >= deletedPointIndex) connectionInfo.wireConnectionSegmentIndex -= 1;
	}

	// If this wire connects to another wire that is about to be deleted, we want to remove that dependency by
	// copying over the deleted wire's points and connection info to this wire so it can continue to exist without the deleted wire.
	RemoveConnectionDependency() {
		const dependency = this.ConnectedWire!;
		const connectToSource = this.SourceConnectionInfo.IsConnectedAtWire;

		if (connectToSource) {
			const pointsToCopy: Vector2[] = [];
			for (let i = 0; i <= this.SourceConnectionInfo.wireConnectionSegmentIndex; i++) pointsToCopy.push(dependency.GetWirePoint(i));

			this.WirePoints[0] = this.GetWirePoint(0);
			this.WirePoints.splice(0, 0, ...pointsToCopy);

			// if some other wire connects to this wire, it needs to know how many points have been inserted here
			Project.ActiveProject.ViewedChip.NotifyConnectedWiresPointsInserted(this, -1, 0, pointsToCopy.length);
			this.originalWireConnectionPoint = dependency.originalWireConnectionPoint;
			this.SourceConnectionInfo = dependency.SourceConnectionInfo.clone();
		} else {
			// Connecting to target pin via another wire is only allowed if that other wire is a bus wire.
			// If the bus wire is being deleted, all connected wires will be deleted along with it.
			if (!dependency.IsBusWire) throw new Error("Connected to target pin via non-bus wire??");
		}
	}

	GetColour(bitIndex: number): Color {
		let col = this.IsFullyConnected ? this.SourcePin.GetStateCol(bitIndex, false, false) : ActiveTheme.StateDisconnectedCol;

		if (this.bitCount !== PinBitCount.Bit1 && bitIndex % 2 === 0) {
			const alternatingWireHighlightDisconnected = Color.white.mul(0.075);
			const alternatingWireHighlightConnected = Color.white.mul(0.01);
			col = col.add(this.IsFullyConnected ? alternatingWireHighlightConnected : alternatingWireHighlightDisconnected);
		}
		return col;
	}

	static ClosestPointOnLineSegment(p: Vector2, a1: Vector2, a2: Vector2): Vector2 {
		const ldx = a2.x - a1.x;
		const ldy = a2.y - a1.y;
		const sqrLineLength = ldx * ldx + ldy * ldy;
		if (sqrLineLength === 0) return a1;
		let t = ((p.x - a1.x) * ldx + (p.y - a1.y) * ldy) / sqrLineLength;
		t = t < 0 ? 0 : t > 1 ? 1 : t;
		return new Vector2(a1.x + ldx * t, a1.y + ldy * t);
	}

	// Equality on address (helper used by the deletion code)
	ConnectsToAddress(address: { PinID: number; PinOwnerID: number }): boolean {
		return PinAddressEquals(this.SourcePin.Address, address) || PinAddressEquals(this.TargetPin.Address, address);
	}
}

// For regular wires, the "bus corrected target" is just the normal target pin, but for bus wires it is overriden to point to the input pin of the bus origin.
function GetBusCorrectedTargetPin(wire: WireInstance): PinInstance {
	return wire.IsBusWire ? (wire.SourcePin.parent as SubChipInstance).InputPins[0] : wire.TargetPin;
}

function CalculateConnectedWireRecursionDepth(wire: WireInstance, depth = 0): number {
	const cw = wire.ConnectedWire;
	if (cw === null) return depth;
	return CalculateConnectedWireRecursionDepth(cw, depth + 1);
}

function PointOnSegmentT(a: Vector2, b: Vector2, p: Vector2): number {
	return p.sub(a).magnitude / b.sub(a).magnitude;
}

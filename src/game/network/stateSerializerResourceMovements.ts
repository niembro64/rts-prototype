import {
  RESOURCE_FLOW_INBOUND,
  RESOURCE_FLOW_OUTBOUND,
  RESOURCE_KIND_ENERGY,
  RESOURCE_KIND_METAL,
  type NetworkServerSnapshotResourceMovement,
} from '@/types/network';
import type { WorldState } from '../sim/WorldState';
import type { ResourceMovement } from '../sim/resourceMovement';
import type { SnapshotVisibility } from './stateSerializerVisibility';
import {
  createFloat64WireRows,
  reserveFloat64WireRows,
  type Float64WireRows,
} from './snapshotWireRows';
import { createResourceMovementDto } from './snapshotDtoCopy';

export const RESOURCE_MOVEMENT_WIRE_STRIDE = 7;

type ResourceMovementWireSource = Float64WireRows;

const resourceMovementBuf: NetworkServerSnapshotResourceMovement[] = [];
const resourceMovementPool: NetworkServerSnapshotResourceMovement[] = [];
const resourceMovementWireSource = createFloat64WireRows();
const directResourceMovementWireSource = createFloat64WireRows();
const resourceMovementWireSources = new WeakMap<object, ResourceMovementWireSource>();

function resourceKindCode(resource: ResourceMovement['resource']): NetworkServerSnapshotResourceMovement['resource'] {
  return resource === 'energy' ? RESOURCE_KIND_ENERGY : RESOURCE_KIND_METAL;
}

function resourceDirectionCode(
  direction: ResourceMovement['direction'],
): NetworkServerSnapshotResourceMovement['direction'] {
  return direction === 'inbound' ? RESOURCE_FLOW_INBOUND : RESOURCE_FLOW_OUTBOUND;
}

function getResourceMovementDto(index: number): NetworkServerSnapshotResourceMovement {
  let dto = resourceMovementPool[index];
  if (!dto) {
    dto = createResourceMovementDto();
    resourceMovementPool[index] = dto;
  }
  return dto;
}

export function getResourceMovementWireSource(
  movements: readonly NetworkServerSnapshotResourceMovement[],
): ResourceMovementWireSource | undefined {
  return resourceMovementWireSources.get(movements);
}

/** Shared resource-movement wire-row body for the DTO and direct-sim
 *  writers. The callers pre-normalize the fields whose shapes differ
 *  (nullable sourceEntityId, string resource/direction on the sim side)
 *  into the wire scalars written here. */
function appendResourceMovementWireRowValues(
  source: ResourceMovementWireSource,
  playerId: number,
  sourceEntityId: number,
  targetEntityId: number | null,
  resource: number,
  amountPerSecond: number,
  direction: number,
): void {
  const rowIndex = reserveFloat64WireRows(source, 1, RESOURCE_MOVEMENT_WIRE_STRIDE);
  const values = source.values;
  const base = rowIndex * RESOURCE_MOVEMENT_WIRE_STRIDE;
  values[base + 0] = playerId;
  values[base + 1] = sourceEntityId;
  values[base + 2] = targetEntityId ?? 0;
  values[base + 3] = resource;
  values[base + 4] = amountPerSecond;
  values[base + 5] = direction;
  values[base + 6] = targetEntityId !== null ? 1 : 0;
}

function appendResourceMovementWireRow(
  source: ResourceMovementWireSource,
  movement: NetworkServerSnapshotResourceMovement,
): void {
  appendResourceMovementWireRowValues(
    source,
    movement.playerId,
    movement.sourceEntityId,
    movement.targetEntityId,
    movement.resource,
    movement.amountPerSecond,
    movement.direction,
  );
}

function appendDirectResourceMovementWireRow(
  source: ResourceMovementWireSource,
  movement: ResourceMovement,
): void {
  appendResourceMovementWireRowValues(
    source,
    movement.playerId,
    movement.sourceEntityId ?? 0,
    movement.targetEntityId,
    resourceKindCode(movement.resource),
    movement.amountPerSecond,
    resourceDirectionCode(movement.direction),
  );
}

function shouldSendResourceMovement(
  world: WorldState,
  visibility: SnapshotVisibility,
  movement: ResourceMovement,
): boolean {
  if (movement.sourceEntityId === null) return false;
  if (movement.amountPerSecond <= 0 || !Number.isFinite(movement.amountPerSecond)) return false;
  if (!visibility.isFiltered) return true;
  const source = world.getEntity(movement.sourceEntityId);
  return source !== undefined && visibility.isEntityVisible(source);
}

export function writeResourceMovementWireRowsDirect(
  world: WorldState,
  visibility: SnapshotVisibility,
  movementsOut: NetworkServerSnapshotResourceMovement[],
): NetworkServerSnapshotResourceMovement[] | undefined {
  movementsOut.length = 0;
  directResourceMovementWireSource.count = 0;
  resourceMovementWireSources.set(movementsOut, directResourceMovementWireSource);
  const movements = world.resourceMovements;
  for (let i = 0; i < movements.length; i++) {
    const movement = movements[i];
    if (!shouldSendResourceMovement(world, visibility, movement)) continue;
    appendDirectResourceMovementWireRow(directResourceMovementWireSource, movement);
  }
  if (directResourceMovementWireSource.count === 0) return undefined;
  movementsOut.length = directResourceMovementWireSource.count;
  return movementsOut;
}

export function serializeResourceMovements(
  world: WorldState,
  visibility: SnapshotVisibility,
): NetworkServerSnapshotResourceMovement[] | undefined {
  resourceMovementBuf.length = 0;
  resourceMovementWireSource.count = 0;
  resourceMovementWireSources.set(resourceMovementBuf, resourceMovementWireSource);
  const movements = world.resourceMovements;
  for (let i = 0; i < movements.length; i++) {
    const movement = movements[i];
    if (!shouldSendResourceMovement(world, visibility, movement)) continue;
    const sourceEntityId = movement.sourceEntityId;
    if (sourceEntityId === null) continue;

    const dto = getResourceMovementDto(resourceMovementBuf.length);
    dto.playerId = movement.playerId;
    dto.sourceEntityId = sourceEntityId;
    dto.targetEntityId = movement.targetEntityId;
    dto.resource = resourceKindCode(movement.resource);
    dto.amountPerSecond = movement.amountPerSecond;
    dto.direction = resourceDirectionCode(movement.direction);
    resourceMovementBuf.push(dto);
    appendResourceMovementWireRow(resourceMovementWireSource, dto);
  }

  return resourceMovementBuf.length > 0 ? resourceMovementBuf : undefined;
}

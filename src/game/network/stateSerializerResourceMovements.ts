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

export const RESOURCE_MOVEMENT_WIRE_STRIDE = 7;

export type ResourceMovementWireSource = Float64WireRows;

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
    dto = {
      playerId: 1,
      sourceEntityId: 0,
      targetEntityId: null,
      resource: RESOURCE_KIND_ENERGY,
      amountPerSecond: 0,
      direction: RESOURCE_FLOW_INBOUND,
    };
    resourceMovementPool[index] = dto;
  }
  return dto;
}

export function getResourceMovementWireSource(
  movements: readonly NetworkServerSnapshotResourceMovement[],
): ResourceMovementWireSource | undefined {
  return resourceMovementWireSources.get(movements);
}

function appendResourceMovementWireRow(
  source: ResourceMovementWireSource,
  movement: NetworkServerSnapshotResourceMovement,
): void {
  const rowIndex = reserveFloat64WireRows(source, 1, RESOURCE_MOVEMENT_WIRE_STRIDE);
  const values = source.values;
  const base = rowIndex * RESOURCE_MOVEMENT_WIRE_STRIDE;
  values[base + 0] = movement.playerId;
  values[base + 1] = movement.sourceEntityId;
  values[base + 2] = movement.targetEntityId ?? 0;
  values[base + 3] = movement.resource;
  values[base + 4] = movement.amountPerSecond;
  values[base + 5] = movement.direction;
  values[base + 6] = movement.targetEntityId !== null ? 1 : 0;
}

function appendDirectResourceMovementWireRow(
  source: ResourceMovementWireSource,
  movement: ResourceMovement,
): void {
  const rowIndex = reserveFloat64WireRows(source, 1, RESOURCE_MOVEMENT_WIRE_STRIDE);
  const values = source.values;
  const base = rowIndex * RESOURCE_MOVEMENT_WIRE_STRIDE;
  values[base + 0] = movement.playerId;
  values[base + 1] = movement.sourceEntityId ?? 0;
  values[base + 2] = movement.targetEntityId ?? 0;
  values[base + 3] = resourceKindCode(movement.resource);
  values[base + 4] = movement.amountPerSecond;
  values[base + 5] = resourceDirectionCode(movement.direction);
  values[base + 6] = movement.targetEntityId !== null ? 1 : 0;
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

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

const resourceMovementBuf: NetworkServerSnapshotResourceMovement[] = [];
const resourceMovementPool: NetworkServerSnapshotResourceMovement[] = [];

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

export function serializeResourceMovements(
  world: WorldState,
  visibility: SnapshotVisibility,
): NetworkServerSnapshotResourceMovement[] | undefined {
  resourceMovementBuf.length = 0;
  const movements = world.resourceMovements;
  for (let i = 0; i < movements.length; i++) {
    const movement = movements[i];
    if (movement.sourceEntityId === null) continue;
    if (movement.amountPerSecond <= 0 || !Number.isFinite(movement.amountPerSecond)) continue;
    if (visibility.isFiltered) {
      const source = world.getEntity(movement.sourceEntityId);
      if (source === undefined || !visibility.isEntityVisible(source)) continue;
    }

    const dto = getResourceMovementDto(resourceMovementBuf.length);
    dto.playerId = movement.playerId;
    dto.sourceEntityId = movement.sourceEntityId;
    dto.targetEntityId = movement.targetEntityId;
    dto.resource = resourceKindCode(movement.resource);
    dto.amountPerSecond = movement.amountPerSecond;
    dto.direction = resourceDirectionCode(movement.direction);
    resourceMovementBuf.push(dto);
  }

  return resourceMovementBuf.length > 0 ? resourceMovementBuf : undefined;
}

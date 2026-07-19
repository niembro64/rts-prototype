import { deterministicMath as DMath } from '@/game/sim/deterministicMath';
import { ENTITY_CHANGED_ACTIONS } from '@/types/network';
import type { Entity, EntityId, Transport } from './types';
import type { WorldState } from './WorldState';
import { getEntityTargetPoint } from './buildingAnchors';
import { entitySlotRegistry } from './EntitySlotRegistry';
import { holdEntity, releaseEntityHold } from './entityHolds';
import { shiftUnitAction, setUnitActions } from './unitActions';

const TRANSPORT_UNIT_BLUEPRINT_ID = 'unitTransport';

const TRANSPORT_CAPACITY = 6;
const TRANSPORT_LOAD_RANGE_PADDING = 24;
const TRANSPORT_UNLOAD_ARRIVAL_RADIUS = 15;
const TRANSPORT_UNLOAD_SPACING = 32;

type TransportActionUpdateResult = {
  unloadedUnits: Entity[];
};

export function createTransportComponentForUnitBlueprint(unitBlueprintId: string): Transport | null {
  return unitBlueprintId === TRANSPORT_UNIT_BLUEPRINT_ID
    ? { capacity: TRANSPORT_CAPACITY, loadedUnits: [] }
    : null;
}

export function isTransportUnit(entity: Entity | null | undefined): entity is Entity {
  return !!(
    entity !== null &&
    entity !== undefined &&
    entity.type === 'unit' &&
    entity.unit !== null &&
    entity.transport !== null &&
    entity.unit.hp > 0
  );
}

export function isClientTransportUnit(entity: Entity | null | undefined): entity is Entity {
  return !!(
    entity !== null &&
    entity !== undefined &&
    entity.type === 'unit' &&
    entity.unit !== null &&
    entity.unit.unitBlueprintId === TRANSPORT_UNIT_BLUEPRINT_ID &&
    entity.unit.hp > 0
  );
}

function isTransportableUnit(target: Entity | null | undefined, playerId: number): target is Entity {
  return !!(
    target !== null &&
    target !== undefined &&
    target.type === 'unit' &&
    target.unit !== null &&
    target.unit.hp > 0 &&
    target.ownership !== null &&
    target.ownership.playerId === playerId &&
    target.commander === null &&
    target.transport === null &&
    target.transported === null &&
    target.heldBy === null &&
    target.buildable === null
  );
}

export function canLoadTransport(transport: Entity | null | undefined, target: Entity | null | undefined): boolean {
  if (!isTransportUnit(transport) || transport.ownership === null) return false;
  if (!isTransportableUnit(target, transport.ownership.playerId)) return false;
  if (target.id === transport.id) return false;
  const transportComponent = transport.transport;
  return transportComponent !== null &&
    transportComponent.loadedUnits.length < transportComponent.capacity;
}

export function isTransportLoadInRange(transport: Entity, target: Entity): boolean {
  const transportRadius = transport.unit?.radius.collision ?? 0;
  const targetRadius = target.unit?.radius.collision ?? 0;
  const targetPoint = getEntityTargetPoint(target);
  const dx = targetPoint.x - transport.transform.x;
  const dy = targetPoint.y - transport.transform.y;
  const range = transportRadius + targetRadius + TRANSPORT_LOAD_RANGE_PADDING;
  return dx * dx + dy * dy <= range * range;
}

function loadUnitIntoTransport(
  world: WorldState,
  transport: Entity,
  target: Entity,
): boolean {
  if (!canLoadTransport(transport, target) || !isTransportLoadInRange(transport, target)) return false;
  if (target.unit === null || transport.transport === null) return false;

  const slotIndex = transport.transport.loadedUnits.length;
  setUnitActions(target.unit, []);
  target.unit.patrolStartIndex = null;
  target.unit.stuckTicks = 0;
  entitySlotRegistry.setUnitDriveInput(target, 0, 0, 0, 0, target.entitySlotId);
  target.selectable = { selected: false };
  target.transported = {
    transportId: transport.id,
    slotIndex,
  };
  holdEntity(transport, target, {
    kind: 'transportCargo',
    slotIndex,
    localOffsetX: 0,
    localOffsetY: 0,
    localBaseZ: 0,
    rotateWithHolder: true,
    inheritHolderRotation: true,
    inheritHolderVelocity: true,
  });

  transport.transport.loadedUnits.push(target);
  world.removeEntity(target.id);
  return true;
}

function unloadTransportCargo(
  world: WorldState,
  transport: Entity,
  targetX: number,
  targetY: number,
  targetZ?: number,
): Entity[] {
  if (!isTransportUnit(transport)) return [];
  const transportComponent = transport.transport;
  if (transportComponent === null) return [];
  const cargo = transportComponent.loadedUnits;
  if (cargo.length === 0) return [];

  const spawned: Entity[] = [];
  const count = cargo.length;
  const centerX = clamp(targetX, 0, world.mapWidth);
  const centerY = clamp(targetY, 0, world.mapHeight);
  const baseAngle = Number.isFinite(transport.transform.rotation)
    ? transport.transform.rotation
    : 0;
  const radius = Math.max(
    TRANSPORT_UNLOAD_SPACING,
    (transport.unit?.radius.collision ?? 0) + TRANSPORT_UNLOAD_SPACING,
  );
  const transportUnit = transport.unit;

  for (let i = 0; i < count; i++) {
    const passenger = cargo[i];
    const passengerUnit = passenger.unit;
    if (passengerUnit === null) continue;
    const angle = baseAngle + (Math.PI * 2 * i) / Math.max(1, count);
    const x = clamp(centerX + DMath.cos(angle) * radius, 0, world.mapWidth);
    const y = clamp(centerY + DMath.sin(angle) * radius, 0, world.mapHeight);
    const groundZ = targetZ ?? world.getGroundZ(x, y);

    passenger.transform.x = x;
    passenger.transform.y = y;
    passenger.transform.z = groundZ + passengerUnit.supportPointOffsetZ + 2;
    passenger.transform.rotation = transport.transform.rotation;
    passenger.transform.rotCos = null;
    passenger.transform.rotSin = null;
    passenger.body = null;
    passenger.selectable = { selected: false };
    passenger.transported = null;
    releaseEntityHold(passenger);
    passengerUnit.velocityX = transportUnit?.velocityX ?? 0;
    passengerUnit.velocityY = transportUnit?.velocityY ?? 0;
    passengerUnit.velocityZ = transportUnit?.velocityZ ?? 0;
    entitySlotRegistry.setUnitDriveInput(passenger, 0, 0, 0, 0, passenger.entitySlotId);
    passengerUnit.activePath = null;
    passengerUnit.stuckTicks = 0;

    world.addEntity(passenger);
    spawned.push(passenger);
  }

  cargo.length = 0;
  return spawned;
}

export function updateTransportActions(world: WorldState): TransportActionUpdateResult {
  const unloadedUnits: Entity[] = [];
  const units = world.getUnits();

  for (let i = 0; i < units.length; i++) {
    const transport = units[i];
    if (!isTransportUnit(transport) || transport.unit === null) continue;
    const action = transport.unit.actions[0];
    if (action === undefined) continue;

    if (action.type === 'loadTransport') {
      const targetId = action.targetId as EntityId | undefined;
      const target = targetId !== undefined ? world.getEntity(targetId) : undefined;
      if (target !== undefined && loadUnitIntoTransport(world, transport, target)) {
        shiftUnitAction(transport.unit);
        transport.unit.stuckTicks = 0;
        world.markSnapshotDirty(transport.id, ENTITY_CHANGED_ACTIONS);
      }
      continue;
    }

    if (action.type === 'unloadTransport') {
      const dx = action.x - transport.transform.x;
      const dy = action.y - transport.transform.y;
      if (dx * dx + dy * dy > TRANSPORT_UNLOAD_ARRIVAL_RADIUS * TRANSPORT_UNLOAD_ARRIVAL_RADIUS) {
        continue;
      }
      const spawned = unloadTransportCargo(world, transport, action.x, action.y, action.z);
      if (spawned.length === 0) continue;
      for (let j = 0; j < spawned.length; j++) unloadedUnits.push(spawned[j]);
      shiftUnitAction(transport.unit);
      transport.unit.stuckTicks = 0;
      world.markSnapshotDirty(transport.id, ENTITY_CHANGED_ACTIONS);
    }
  }

  return { unloadedUnits };
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

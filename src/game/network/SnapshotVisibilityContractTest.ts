import {
  getScanPulseWireSource,
  serializeScanPulses,
  SnapshotVisibility,
} from './stateSerializerVisibility';
import {
  getMinimapSnapshotWireSource,
  serializeMinimapSnapshotEntities,
} from './stateSerializerMinimap';
import { spatialGrid } from '../sim/SpatialGrid';
import { entitySlotRegistry } from '../sim/EntitySlotRegistry';
import { WorldState } from '../sim/WorldState';
import { stampCombatTargetingPool } from '../sim/combat/targetingInputStamping';
import type { Entity, EntityId, PlayerId } from '../sim/types';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`[snapshot visibility] ${message}`);
  }
}

function sorted(ids: readonly number[] | undefined): number[] {
  return [...(ids ?? [])].sort((a, b) => a - b);
}

function assertSameIds(actual: readonly number[] | undefined, expected: readonly number[], label: string): void {
  const a = sorted(actual);
  const e = sorted(expected);
  assertContract(
    a.length === e.length && a.every((id, index) => id === e[index]),
    `${label}: expected [${e.join(', ')}], got [${a.join(', ')}]`,
  );
}

function createUnit(
  world: WorldState,
  x: number,
  y: number,
  playerId: PlayerId,
  configure?: (entity: Entity) => void,
): Entity {
  const entity = world.createUnitFromBlueprint(x, y, playerId, 'unitJackal');
  configure?.(entity);
  world.addEntity(entity);
  spatialGrid.updateUnit(entity);
  return entity;
}

export function runSnapshotVisibilityContractTest(): void {
  spatialGrid.clear();

  const world = new WorldState(6101, 4096, 4096);
  world.playerCount = 2;
  world.fogOfWarEnabled = true;

  const observer = createUnit(world, 512, 512, 1 as PlayerId, (entity) => {
    assertContract(entity.unit !== null, 'observer must have a unit component');
    entity.unit.sensors.fullSightRadius = 1200;
    entity.unit.sensors.radarRadius = 3000;
    entity.unit.sensors.detectorRadius = 600;
  });
  const fullSightEnemy = createUnit(world, 700, 512, 2 as PlayerId);
  const radarOnlyEnemy = createUnit(world, 2500, 512, 2 as PlayerId);
  const detectedCloakedEnemy = createUnit(world, 900, 512, 2 as PlayerId, (entity) => {
    assertContract(entity.unit !== null, 'detected cloaked target must have a unit component');
    entity.unit.cloaked = true;
  });
  const hiddenCloakedEnemy = createUnit(world, 1400, 512, 2 as PlayerId, (entity) => {
    assertContract(entity.unit !== null, 'hidden cloaked target must have a unit component');
    entity.unit.cloaked = true;
  });
  const outOfRangeEnemy = createUnit(world, 3800, 3800, 2 as PlayerId);

  const legacyVisibility = SnapshotVisibility.forRecipient(world, 1 as PlayerId);
  const legacyVisible = sorted(legacyVisibility.getVisibleEntityIds());
  const legacyRadar = sorted(legacyVisibility.getRadarEntityIds());

  stampCombatTargetingPool(world);
  const nativeVisibility = SnapshotVisibility.forRecipient(world, 1 as PlayerId);
  assertSameIds(nativeVisibility.getVisibleEntityIds(), legacyVisible, 'native visible ids must match legacy source walk');
  assertSameIds(nativeVisibility.getRadarEntityIds(), legacyRadar, 'native radar ids must match legacy source walk');
  const nativeVisibleIds = nativeVisibility.getVisibleEntityIds();
  const nativeVisibleSlots = nativeVisibility.getVisibleEntitySlots();
  const nativeRadarIds = nativeVisibility.getRadarEntityIds();
  const nativeRadarSlots = nativeVisibility.getRadarEntitySlots();
  const entityViews = entitySlotRegistry.getViews();
  assertContract(
    nativeVisibleIds !== undefined &&
      nativeVisibleSlots !== undefined &&
      entityViews !== null &&
      nativeVisibleIds.length === nativeVisibleSlots.length &&
      nativeVisibleIds.every((id, index) => entityViews.entityId[nativeVisibleSlots[index]] === id),
    'native visible ids must expose aligned entity-state slots for slot-native serializers',
  );
  assertContract(
    nativeRadarIds !== undefined &&
      nativeRadarSlots !== undefined &&
      entityViews !== null &&
      nativeRadarIds.length === nativeRadarSlots.length &&
      nativeRadarIds.every((id, index) => entityViews.entityId[nativeRadarSlots[index]] === id),
    'native radar ids must expose aligned entity-state slots for direct minimap serialization',
  );
  const minimapEntities = serializeMinimapSnapshotEntities(world, nativeVisibility, 'visibility-contract');
  assertContract(
    minimapEntities !== undefined &&
      getMinimapSnapshotWireSource(minimapEntities)?.count === minimapEntities.length,
    'native minimap serialization must expose direct wire rows for every minimap entry',
  );
  const radarOnlyMinimap = minimapEntities.find((entry) => entry.id === radarOnlyEnemy.id);
  assertContract(
    radarOnlyMinimap?.radarOnly === true,
    'native minimap serialization must preserve radar-only contacts from entity-state slots',
  );

  assertContract(legacyVisible.includes(observer.id), 'owned observer must be fully visible');
  assertContract(legacyVisible.includes(fullSightEnemy.id), 'enemy inside full sight must be visible');
  assertContract(legacyVisible.includes(detectedCloakedEnemy.id), 'detected cloaked enemy must be visible');
  assertContract(!legacyVisible.includes(radarOnlyEnemy.id), 'radar-only enemy must not be fully visible');
  assertContract(!legacyVisible.includes(hiddenCloakedEnemy.id), 'undetected cloaked enemy must not be visible');
  assertContract(!legacyVisible.includes(outOfRangeEnemy.id), 'out-of-range enemy must not be visible');
  assertContract(
    legacyVisibility.canReferenceEntityId(world, fullSightEnemy.id) === true,
    'visible enemy ids must be referenceable',
  );
  assertContract(
    legacyVisibility.canReferenceEntityId(world, radarOnlyEnemy.id) === false,
    'radar-only enemy ids must not be referenceable from full-detail payloads',
  );
  assertContract(
    legacyVisibility.canReferenceEntityId(world, 999999 as EntityId) === false,
    'missing entity ids must not be referenceable',
  );

  assertContract(legacyRadar.includes(observer.id), 'owned observer must be on radar list');
  assertContract(legacyRadar.includes(fullSightEnemy.id), 'full-sight enemy must be on radar list');
  assertContract(legacyRadar.includes(radarOnlyEnemy.id), 'radar-covered enemy must be on radar list');
  assertContract(legacyRadar.includes(detectedCloakedEnemy.id), 'detected cloaked enemy must be on radar list');
  assertContract(!legacyRadar.includes(hiddenCloakedEnemy.id), 'undetected cloaked enemy must not be on radar list');
  assertContract(!legacyRadar.includes(outOfRangeEnemy.id), 'out-of-range enemy must not be on radar list');

  const pulseWorld = new WorldState(6102, 4096, 4096);
  pulseWorld.playerCount = 2;
  pulseWorld.fogOfWarEnabled = true;
  pulseWorld.scanPulses.push({
    playerId: 1 as PlayerId,
    x: 1024,
    y: 1024,
    z: 0,
    radius: 128,
    expiresAtTick: 90,
  });
  const pulseVisibility = SnapshotVisibility.forRecipient(pulseWorld, 1 as PlayerId);
  const pulses = serializeScanPulses(pulseWorld, pulseVisibility);
  const pulseWireSource = pulses !== undefined ? getScanPulseWireSource(pulses) : undefined;
  assertContract(
    pulses !== undefined &&
      pulses.length === 1 &&
      pulseWireSource !== undefined &&
      pulseWireSource.count === 1,
    'filtered scan pulses must expose cached DTOs and wire rows',
  );
  assertContract(
    pulseVisibility.isPointVisible(1040, 1040) === true,
    'scan pulse source must grant full point visibility inside the pulse radius',
  );
  assertContract(
    pulseVisibility.isPointVisible(1500, 1500) === false,
    'scan pulse source must not grant point visibility outside the pulse radius',
  );
  assertContract(
    serializeScanPulses(pulseWorld, SnapshotVisibility.forRecipient(pulseWorld, 2 as PlayerId)) === undefined,
    'filtered scan pulses must stay team-owned',
  );
}

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
import { applyBuildingBlueprintRuntime } from '../sim/buildingEntityRuntime';
import type { BuildingBlueprintId, Entity, EntityId, PlayerId } from '../sim/types';
import { WATER_LEVEL } from '../sim/Terrain';
import { getSimWasm } from '../sim-wasm/init';

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

function createOpenedStructure(
  world: WorldState,
  x: number,
  y: number,
  playerId: PlayerId,
  buildingBlueprintId: BuildingBlueprintId,
): Entity {
  const entity = world.createBuilding(x, y, 80, 80, 80, playerId);
  applyBuildingBlueprintRuntime(entity, buildingBlueprintId);
  if (entity.building !== null && entity.building.activeState !== null) {
    entity.building.activeState.open = true;
  }
  world.addEntity(entity);
  spatialGrid.addBuilding(entity);
  return entity;
}

export function runSnapshotVisibilityContractTest(): void {
  spatialGrid.clear();
  getSimWasm()?.combatTargeting.clear();

  const world = new WorldState(6101, 4096, 4096);
  world.playerCount = 2;
  world.fogOfWarEnabled = true;

  const observer = createUnit(world, 512, 512, 1 as PlayerId, (entity) => {
    assertContract(entity.unit !== null, 'observer must have a unit component');
    entity.transform.z = WATER_LEVEL + 100;
    const sensors = entity.combat!.turrets[0].config.turretRange.sensors;
    sensors.fullSight.aboveWater.aboveWater = 1200;
    sensors.fullSight.aboveWater.underwater = 0;
    sensors.contactSight.aboveWater.aboveWater = 3000;
    sensors.contactSight.aboveWater.underwater = 0;
    sensors.detectorRadius = 600;
  });
  const fullSightEnemy = createUnit(world, 700, 512, 2 as PlayerId);
  fullSightEnemy.transform.z = WATER_LEVEL + 100;
  const fullSightRejectedWaterEnemy = createUnit(world, 700, 650, 2 as PlayerId, (entity) => {
    entity.transform.z = WATER_LEVEL;
  });
  const centerOutsideFullSightEnemy = createUnit(world, 1722, 512, 2 as PlayerId, (entity) => {
    entity.transform.z = WATER_LEVEL + 100;
  });
  const radarOnlyEnemy = createUnit(world, 2500, 512, 2 as PlayerId, (entity) => {
    entity.transform.z = WATER_LEVEL + 100;
  });
  const radarRejectedWaterEnemy = createUnit(world, 2500, 700, 2 as PlayerId, (entity) => {
    entity.transform.z = WATER_LEVEL - 100;
  });
  const centerOutsideRadarEnemy = createUnit(world, 3522, 512, 2 as PlayerId, (entity) => {
    entity.transform.z = WATER_LEVEL + 100;
  });
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
  assertContract(
    !legacyVisible.includes(fullSightRejectedWaterEnemy.id),
    'above-water same-medium sight must reject an underwater center',
  );
  assertContract(
    !legacyVisible.includes(centerOutsideFullSightEnemy.id),
    'target hitbox must not extend full sight beyond the target center',
  );
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
  assertContract(
    !legacyRadar.includes(fullSightRejectedWaterEnemy.id),
    'an underwater center outside every active underwater lane must stay hidden',
  );
  assertContract(
    legacyRadar.includes(centerOutsideFullSightEnemy.id),
    'center outside full sight but inside above-water contact sight must remain a contact',
  );
  assertContract(legacyRadar.includes(radarOnlyEnemy.id), 'radar-covered enemy must be on radar list');
  assertContract(legacyRadar.includes(detectedCloakedEnemy.id), 'detected cloaked enemy must be on radar list');
  assertContract(!legacyRadar.includes(radarRejectedWaterEnemy.id), 'radar must reject an underwater target center');
  assertContract(
    !legacyRadar.includes(centerOutsideRadarEnemy.id),
    'target hitbox must not extend radar coverage beyond the target center',
  );
  assertContract(!legacyRadar.includes(hiddenCloakedEnemy.id), 'undetected cloaked enemy must not be on radar list');
  assertContract(!legacyRadar.includes(outOfRangeEnemy.id), 'out-of-range enemy must not be on radar list');

  spatialGrid.clear();
  getSimWasm()?.combatTargeting.clear();
  const mediumWorld = new WorldState(6103, 12000, 12000);
  mediumWorld.playerCount = 2;
  mediumWorld.fogOfWarEnabled = true;
  const radarBuilding = createOpenedStructure(
    mediumWorld,
    1000,
    1000,
    1 as PlayerId,
    'buildingRadar',
  );
  radarBuilding.transform.z = WATER_LEVEL + 100;
  const sonarBuilding = createOpenedStructure(
    mediumWorld,
    1000,
    7000,
    1 as PlayerId,
    'buildingSonar',
  );
  sonarBuilding.transform.z = WATER_LEVEL - 100;
  const radarAirTarget = createUnit(mediumWorld, 4000, 1000, 2 as PlayerId, (entity) => {
    entity.transform.z = WATER_LEVEL + 100;
  });
  const radarWaterTarget = createUnit(mediumWorld, 4000, 1000, 2 as PlayerId, (entity) => {
    entity.transform.z = WATER_LEVEL - 100;
  });
  const radarOutsideCenterTarget = createUnit(mediumWorld, 5210, 1000, 2 as PlayerId, (entity) => {
    entity.transform.z = WATER_LEVEL + 100;
  });
  const sonarWaterTarget = createUnit(mediumWorld, 4000, 7000, 2 as PlayerId, (entity) => {
    entity.transform.z = WATER_LEVEL - 100;
  });
  const sonarAirTarget = createUnit(mediumWorld, 4000, 7000, 2 as PlayerId, (entity) => {
    entity.transform.z = WATER_LEVEL + 100;
  });
  const sonarOutsideCenterTarget = createUnit(mediumWorld, 5210, 7000, 2 as PlayerId, (entity) => {
    entity.transform.z = WATER_LEVEL - 100;
  });
  const underwaterRadarBuilding = createOpenedStructure(
    mediumWorld,
    7000,
    1000,
    1 as PlayerId,
    'buildingRadar',
  );
  underwaterRadarBuilding.transform.z = WATER_LEVEL;
  const underwaterRadarRejectedTarget = createUnit(
    mediumWorld,
    7300,
    1000,
    2 as PlayerId,
    (entity) => {
      entity.transform.z = WATER_LEVEL + 100;
    },
  );
  const aboveWaterSonarBuilding = createOpenedStructure(
    mediumWorld,
    7000,
    7000,
    1 as PlayerId,
    'buildingSonar',
  );
  aboveWaterSonarBuilding.transform.z = WATER_LEVEL + 100;
  const aboveWaterSonarRejectedTarget = createUnit(
    mediumWorld,
    7300,
    7000,
    2 as PlayerId,
    (entity) => {
      entity.transform.z = WATER_LEVEL;
    },
  );
  const legacyMediumVisibility = SnapshotVisibility.forRecipient(mediumWorld, 1 as PlayerId);
  const legacyMediumContacts = sorted(legacyMediumVisibility.getRadarEntityIds());
  assertContract(legacyMediumContacts.includes(radarBuilding.id), 'owned radar building must remain visible');
  assertContract(legacyMediumContacts.includes(sonarBuilding.id), 'owned sonar building must remain visible');
  assertContract(legacyMediumContacts.includes(radarAirTarget.id), 'radar must locate air-medium centers');
  assertContract(!legacyMediumContacts.includes(radarWaterTarget.id), 'radar must reject water-medium centers');
  assertContract(legacyMediumContacts.includes(sonarWaterTarget.id), 'sonar must locate water-medium centers');
  assertContract(!legacyMediumContacts.includes(sonarAirTarget.id), 'sonar must reject air-medium centers');
  assertContract(
    !legacyMediumContacts.includes(underwaterRadarRejectedTarget.id),
    'an underwater radar source must not activate its above-water source row',
  );
  assertContract(
    !legacyMediumContacts.includes(aboveWaterSonarRejectedTarget.id),
    'an above-water sonar source must not activate its underwater source row',
  );
  assertContract(
    !legacyMediumContacts.includes(radarOutsideCenterTarget.id),
    'radar must not use target hitbox padding outside its radius',
  );
  assertContract(
    !legacyMediumContacts.includes(sonarOutsideCenterTarget.id),
    'sonar must not use target hitbox padding outside its radius',
  );
  stampCombatTargetingPool(mediumWorld);
  const nativeMediumVisibility = SnapshotVisibility.forRecipient(mediumWorld, 1 as PlayerId);
  assertSameIds(
    nativeMediumVisibility.getRadarEntityIds(),
    legacyMediumContacts,
    'native radar/sonar medium contacts must match the legacy source walk',
  );

  spatialGrid.clear();
  getSimWasm()?.combatTargeting.clear();
  const matrixWorld = new WorldState(6104, 12000, 12000);
  matrixWorld.playerCount = 2;
  matrixWorld.fogOfWarEnabled = true;
  const aboveSameMediumObserver = createUnit(
    matrixWorld,
    1000,
    1000,
    1 as PlayerId,
    (entity) => {
      // Sensor source medium is classified at the mounted turret origin,
      // not at the host center. Keep the whole source clearly above water.
      entity.transform.z = WATER_LEVEL + 100;
    },
  );
  const aboveSameMediumTarget = createUnit(
    matrixWorld,
    1010,
    1000,
    2 as PlayerId,
    (entity) => {
      entity.transform.z = WATER_LEVEL + 1;
    },
  );
  const aboveObserverRejectedUnderwaterTarget = createUnit(
    matrixWorld,
    1010,
    1010,
    2 as PlayerId,
    (entity) => {
      entity.transform.z = WATER_LEVEL;
    },
  );
  const underwaterSameMediumObserver = createUnit(
    matrixWorld,
    1000,
    5000,
    1 as PlayerId,
    (entity) => {
      // Keep the mounted sensor origin below the surface.
      entity.transform.z = WATER_LEVEL - 100;
    },
  );
  const underwaterSameMediumTarget = createUnit(
    matrixWorld,
    1010,
    5000,
    2 as PlayerId,
    (entity) => {
      entity.transform.z = WATER_LEVEL;
    },
  );
  const underwaterObserverRejectedAboveTarget = createUnit(
    matrixWorld,
    1010,
    5010,
    2 as PlayerId,
    (entity) => {
      entity.transform.z = WATER_LEVEL + 1;
    },
  );
  const aboveCrossMediumObserver = createUnit(
    matrixWorld,
    7000,
    1000,
    1 as PlayerId,
    (entity) => {
      assertContract(entity.unit !== null, 'cross-medium observer must be a unit');
      entity.transform.z = WATER_LEVEL + 100;
      entity.combat!.turrets[0].config.turretRange.sensors.fullSight.aboveWater.underwater = 900;
    },
  );
  const aboveCrossMediumWaterTarget = createUnit(
    matrixWorld,
    7010,
    1000,
    2 as PlayerId,
    (entity) => {
      entity.transform.z = WATER_LEVEL;
    },
  );
  const underwaterCrossMediumObserver = createUnit(
    matrixWorld,
    7000,
    5000,
    1 as PlayerId,
    (entity) => {
      assertContract(entity.unit !== null, 'cross-medium observer must be a unit');
      entity.transform.z = WATER_LEVEL - 100;
      entity.combat!.turrets[0].config.turretRange.sensors.fullSight.underwater.aboveWater = 900;
    },
  );
  const underwaterCrossMediumAboveTarget = createUnit(
    matrixWorld,
    7010,
    5000,
    2 as PlayerId,
    (entity) => {
      entity.transform.z = WATER_LEVEL + 1;
    },
  );
  const legacyMatrixVisibility = SnapshotVisibility.forRecipient(matrixWorld, 1 as PlayerId);
  const legacyMatrixVisible = sorted(legacyMatrixVisibility.getVisibleEntityIds());
  assertContract(
    legacyMatrixVisible.includes(aboveSameMediumObserver.id) &&
      legacyMatrixVisible.includes(underwaterSameMediumObserver.id) &&
      legacyMatrixVisible.includes(aboveCrossMediumObserver.id) &&
      legacyMatrixVisible.includes(underwaterCrossMediumObserver.id),
    'every owned matrix observer must remain visible',
  );
  assertContract(
    legacyMatrixVisible.includes(aboveSameMediumTarget.id) &&
      !legacyMatrixVisible.includes(aboveObserverRejectedUnderwaterTarget.id),
    'above-water source row must allow A→A and reject A→W by default',
  );
  assertContract(
    legacyMatrixVisible.includes(underwaterSameMediumTarget.id) &&
      !legacyMatrixVisible.includes(underwaterObserverRejectedAboveTarget.id),
    'underwater source row must allow W→W and reject W→A by default',
  );
  assertContract(
    legacyMatrixVisible.includes(aboveCrossMediumWaterTarget.id),
    'an authored A→W lane must reveal an underwater center',
  );
  assertContract(
    legacyMatrixVisible.includes(underwaterCrossMediumAboveTarget.id),
    'an authored W→A lane must reveal an above-water center',
  );
  stampCombatTargetingPool(matrixWorld);
  const nativeMatrixVisibility = SnapshotVisibility.forRecipient(matrixWorld, 1 as PlayerId);
  assertSameIds(
    nativeMatrixVisibility.getVisibleEntityIds(),
    legacyMatrixVisible,
    'native four-way full-sight matrix must match the legacy source walk',
  );
  spatialGrid.clear();
  getSimWasm()?.combatTargeting.clear();
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
  getSimWasm()?.combatTargeting.clear();
  spatialGrid.clear();
}

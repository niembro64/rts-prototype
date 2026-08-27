import {
  getScanPulseWireSource,
  serializeScanPulses,
  SnapshotVisibility,
} from './stateSerializerVisibility';
import {
  getMinimapSnapshotWireSource,
  serializeMinimapSnapshotEntities,
} from './stateSerializerMinimap';
import {
  serializeSprayTargets,
  writeSprayTargetWireRowsDirect,
} from './stateSerializerSpray';
import {
  serializeResourceMovements,
  writeResourceMovementWireRowsDirect,
} from './stateSerializerResourceMovements';
import { spatialGrid } from '../sim/SpatialGrid';
import { entitySlotRegistry } from '../sim/EntitySlotRegistry';
import { WorldState } from '../sim/WorldState';
import { stampCombatTargetingPool } from '../sim/combat/targetingInputStamping';
import { applyBuildingBlueprintRuntime } from '../sim/buildingEntityRuntime';
import type { BuildingBlueprintId, Entity, EntityId, PlayerId } from '../sim/types';
import type { SprayTarget } from '../sim/commanderAbilities';
import type { ResourceMovement } from '../sim/resourceMovement';
import { WATER_LEVEL, buildTerrainTileMap, setAuthoritativeTerrainTileMap } from '../sim/Terrain';
import { getAuthoritativeTerrainTileMap } from '../sim/terrain/terrainState';
import {
  getEntityFullVisionRadius,
  getEntityRadarRadius,
} from '../sim/sensorCoverage';
import { getSimWasm } from '../sim-wasm/init';
import { createProjectileConfigFromShot } from '../sim/projectileConfigs';
import { CONTACT_MEDIUM_AIR } from './contactMedium';
import { quantizeMinimapPosition } from './snapshotQuantization';
import {
  packMinimapEntitiesForWire,
  unpackMinimapEntitiesFromWire,
} from './snapshotMinimapWirePack';

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

/** The contract compares a JS source walk against the native observation
 *  slab, and both must read the SAME terrain. The boot harness runs every
 *  contract in one page beside the live demo battle, whose terrain install
 *  (JS tile map + WASM mesh) can be mid-flight or restored through the
 *  version-equal fast path that skips the WASM upload — so the two sides
 *  drift and a radar contact that clears terrain on one side hits it on the
 *  other. Own the terrain for the test's duration and restore it through a
 *  full re-install afterwards. */
export function runSnapshotVisibilityContractTest(): void {
  const previousMap = getAuthoritativeTerrainTileMap();
  setAuthoritativeTerrainTileMap(buildTerrainTileMap(4096, 4096));
  try {
    runSnapshotVisibilityContractTestBody();
  } finally {
    // Null first: a same-version restore would swap the JS map without
    // re-uploading the WASM mesh, leaving exactly the drift this guards.
    setAuthoritativeTerrainTileMap(null);
    if (previousMap !== null) setAuthoritativeTerrainTileMap(previousMap);
    spatialGrid.clear();
  }
}

function runSnapshotVisibilityContractTestBody(): void {
  spatialGrid.clear();
  getSimWasm()?.combatTargeting.clear();

  const world = new WorldState(6101, 4096, 4096);
  world.playerCount = 2;
  world.fogOfWarEnabled = true;

  const observer = createUnit(world, 512, 512, 1 as PlayerId, (entity) => {
    assertContract(entity.unit !== null, 'observer must have a unit component');
    entity.transform.z = WATER_LEVEL + 100;
    const sensors = entity.combat!.turrets[0].config.targeting.observation.sensors;
    sensors.fullSight.aboveWater.aboveWater = 1200;
    sensors.fullSight.aboveWater.underwater = 0;
    sensors.contactSight.aboveWater.aboveWater = 3000;
    sensors.contactSight.aboveWater.underwater = 0;
    sensors.detectorRadius = 600;
  });
  const fullSightEnemy = createUnit(world, 700, 512, 2 as PlayerId);
  fullSightEnemy.transform.z = WATER_LEVEL + 100;
  const fullSightStraddlingWaterEnemy = createUnit(world, 700, 650, 2 as PlayerId, (entity) => {
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
  const detectedCloakedStraddlingEnemy = createUnit(
    world,
    900,
    650,
    2 as PlayerId,
    (entity) => {
      assertContract(
        entity.unit !== null,
        'detected cloaked straddling target must have a unit component',
      );
      entity.unit.cloaked = true;
      entity.transform.z = WATER_LEVEL;
    },
  );
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

  // Emissions on the contact tier. An enemy shot inside radar coverage but
  // outside sight is the anonymous contact dot; one inside sight rides the
  // projectile channel and is no minimap row; our own shot is never a
  // contact wherever it flies; one outside every lane is nothing.
  const shotConfig = createProjectileConfigFromShot('shotPlasmaLight');
  const spawnShot = (x: number, y: number, ownerId: PlayerId, source: Entity): Entity => {
    const shot = world.createProjectile(x, y, 0, 0, ownerId, source.id, shotConfig);
    shot.transform.z = WATER_LEVEL + 100;
    world.addEntity(shot);
    return shot;
  };
  const radarOnlyShot = spawnShot(2500, 600, 2 as PlayerId, radarOnlyEnemy);
  const sightedShot = spawnShot(700, 600, 2 as PlayerId, fullSightEnemy);
  const ownShot = spawnShot(2500, 640, 1 as PlayerId, observer);
  const hiddenShot = spawnShot(3800, 3700, 2 as PlayerId, outOfRangeEnemy);
  stampCombatTargetingPool(world);
  const emissionVisibility = SnapshotVisibility.forRecipient(world, 1 as PlayerId);
  const emissionMinimap = serializeMinimapSnapshotEntities(
    world,
    emissionVisibility,
    'visibility-contract-emissions',
  );
  assertContract(emissionMinimap !== undefined, 'emission fixture must serialize minimap rows');
  const shotContact = emissionMinimap.find((entry) => entry.id === radarOnlyShot.id);
  assertContract(
    shotContact !== undefined &&
      shotContact.radarOnly === true &&
      shotContact.type === 'shot' &&
      shotContact.playerId === 0 &&
      shotContact.contactMediumMask === CONTACT_MEDIUM_AIR &&
      shotContact.contactZ === quantizeMinimapPosition(WATER_LEVEL + 100),
    'an enemy shot under radar but outside sight must be an anonymous shot contact',
  );
  assertContract(
    emissionMinimap.every(
      (entry) => entry.id !== sightedShot.id && entry.id !== ownShot.id && entry.id !== hiddenShot.id,
    ),
    'seen, own, and unsensed shots must never become minimap contacts',
  );
  assertContract(
    getMinimapSnapshotWireSource(emissionMinimap)?.count === emissionMinimap.length,
    'emission contacts must expose direct wire rows like every other minimap entry',
  );
  const packedEmissions = packMinimapEntitiesForWire(emissionMinimap);
  assertContract(packedEmissions !== undefined, 'emission minimap rows must pack for the wire');
  const unpackedShot = unpackMinimapEntitiesFromWire(packedEmissions)
    ?.find((entry) => entry.id === radarOnlyShot.id);
  assertContract(
    unpackedShot?.type === 'shot' &&
      unpackedShot.radarOnly === true &&
      unpackedShot.contactMediumMask === CONTACT_MEDIUM_AIR,
    'the shot contact must survive the packed minimap wire round trip as a shot',
  );

  const spray = (
    source: Entity,
    target: Entity,
    sourcePlayerId: PlayerId,
  ): SprayTarget => ({
    source: {
      id: source.id,
      pos: { x: source.transform.x, y: source.transform.y },
      z: source.transform.z,
      playerId: sourcePlayerId,
    },
    target: {
      id: target.id,
      pos: { x: target.transform.x, y: target.transform.y },
      z: target.transform.z,
      radius: target.unit?.radius.hitbox ?? 1,
    },
    type: 'build',
    intensity: 1,
    channel: 0,
    flow: 'direct',
    flowRadius: 0,
  });
  const enemySprayAcrossFog = spray(fullSightEnemy, radarOnlyEnemy, 2 as PlayerId);
  assertContract(
    serializeSprayTargets(
      [enemySprayAcrossFog],
      nativeVisibility,
      'visibility-hidden-spray-contract',
    ) === undefined,
    'a visible enemy spray endpoint must not disclose its hidden endpoint',
  );
  const directHiddenSprays: never[] = [];
  assertContract(
    writeSprayTargetWireRowsDirect(
      [enemySprayAcrossFog],
      nativeVisibility,
      directHiddenSprays,
    ) === undefined,
    'direct spray rows must enforce the same both-endpoints-visible boundary',
  );
  assertContract(
    serializeSprayTargets(
      [spray(fullSightEnemy, detectedCloakedEnemy, 2 as PlayerId)],
      nativeVisibility,
      'visibility-visible-spray-contract',
    )?.length === 1,
    'an enemy spray remains visible when full sight covers both endpoints',
  );
  assertContract(
    serializeSprayTargets(
      [spray(observer, radarOnlyEnemy, 1 as PlayerId)],
      nativeVisibility,
      'visibility-team-spray-contract',
    )?.length === 1,
    'a team-owned spray remains readable as private team action state',
  );

  const resourceMovement = (
    source: Entity,
    target: Entity,
    playerId: PlayerId,
  ): ResourceMovement => ({
    playerId,
    sourceEntityId: source.id,
    targetEntityId: target.id,
    resource: 'energy',
    amount: 1,
    amountPerSecond: 20,
    direction: 'outbound',
    stockpileDelta: -1,
    reason: 'construction',
  });
  world.resourceMovements.push(
    resourceMovement(fullSightEnemy, radarOnlyEnemy, 2 as PlayerId),
  );
  assertContract(
    serializeResourceMovements(world, nativeVisibility) === undefined,
    'a visible enemy resource source must not disclose a hidden target id',
  );
  const directHiddenResourceMovements: never[] = [];
  assertContract(
    writeResourceMovementWireRowsDirect(
      world,
      nativeVisibility,
      directHiddenResourceMovements,
    ) === undefined,
    'direct resource rows must enforce the same hidden-target reference boundary',
  );
  world.resourceMovements[0] = resourceMovement(
    fullSightEnemy,
    detectedCloakedEnemy,
    2 as PlayerId,
  );
  assertContract(
    serializeResourceMovements(world, nativeVisibility)?.length === 1,
    'enemy resource movement remains visible when full sight covers both endpoints',
  );
  world.resourceMovements[0] = resourceMovement(observer, radarOnlyEnemy, 1 as PlayerId);
  assertContract(
    serializeResourceMovements(world, nativeVisibility)?.length === 1,
    'team-owned resource movement remains readable as private team action state',
  );
  world.resourceMovements.length = 0;

  assertContract(legacyVisible.includes(observer.id), 'owned observer must be fully visible');
  assertContract(legacyVisible.includes(fullSightEnemy.id), 'enemy inside full sight must be visible');
  assertContract(
    legacyVisible.includes(fullSightStraddlingWaterEnemy.id),
    'above-water sight must reveal an entity with any above-water volume',
  );
  assertContract(
    !legacyVisible.includes(centerOutsideFullSightEnemy.id),
    'target hitbox must not extend full sight beyond the target center',
  );
  assertContract(legacyVisible.includes(detectedCloakedEnemy.id), 'detected cloaked enemy must be visible');
  assertContract(
    legacyVisible.includes(detectedCloakedStraddlingEnemy.id),
    'an above-water detector must reveal a cloaked entity with any above-water volume',
  );
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
    legacyRadar.includes(fullSightStraddlingWaterEnemy.id),
    'an entity straddling the waterline must participate in the above-water contact lane',
  );
  assertContract(
    legacyRadar.includes(centerOutsideFullSightEnemy.id),
    'center outside full sight but inside above-water contact sight must remain a contact',
  );
  assertContract(legacyRadar.includes(radarOnlyEnemy.id), 'radar-covered enemy must be on radar list');
  assertContract(legacyRadar.includes(detectedCloakedEnemy.id), 'detected cloaked enemy must be on radar list');
  assertContract(
    legacyRadar.includes(detectedCloakedStraddlingEnemy.id),
    'a detected cloaked entity with any above-water volume must be on the contact list',
  );
  assertContract(!legacyRadar.includes(radarRejectedWaterEnemy.id), 'radar must reject an underwater target center');
  assertContract(
    !legacyRadar.includes(centerOutsideRadarEnemy.id),
    'target hitbox must not extend radar coverage beyond the target center',
  );
  assertContract(!legacyRadar.includes(hiddenCloakedEnemy.id), 'undetected cloaked enemy must not be on radar list');
  assertContract(!legacyRadar.includes(outOfRangeEnemy.id), 'out-of-range enemy must not be on radar list');

  spatialGrid.clear();
  getSimWasm()?.combatTargeting.clear();
  const activeStateWorld = new WorldState(6105, 6000, 6000);
  activeStateWorld.playerCount = 2;
  activeStateWorld.fogOfWarEnabled = true;
  const closedRadar = createOpenedStructure(
    activeStateWorld,
    1000,
    1000,
    1 as PlayerId,
    'buildingRadar',
  );
  closedRadar.transform.z = WATER_LEVEL + 100;
  assertContract(
    closedRadar.building !== null && closedRadar.building.activeState !== null,
    'radar fixture must expose the shared powered active state',
  );
  closedRadar.building.activeState.open = false;
  const radarSensor = closedRadar.combat?.utilityMounts.find(
    (mount) => mount.kind === 'sensor',
  );
  assertContract(
    radarSensor?.kind === 'sensor',
    'radar fixture must hydrate its lightweight sensor mount',
  );
  radarSensor.sensors.fullSight.aboveWater.aboveWater = 500;
  radarSensor.sensors.contactSight.aboveWater.aboveWater = 1800;
  const closedFullSightEnemy = createUnit(
    activeStateWorld,
    1250,
    1000,
    2 as PlayerId,
  );
  const closedRadarAnnulusEnemy = createUnit(
    activeStateWorld,
    2200,
    1000,
    2 as PlayerId,
  );
  assertContract(
    getEntityFullVisionRadius(closedRadar, 'aboveWater') === 500,
    'closed completed building must retain passive full sight',
  );
  assertContract(
    getEntityRadarRadius(closedRadar) === 0,
    'closed completed building must disable powered radar contact',
  );
  const closedLegacyVisibility = SnapshotVisibility.forRecipient(
    activeStateWorld,
    1 as PlayerId,
  );
  const closedLegacyVisible = sorted(closedLegacyVisibility.getVisibleEntityIds());
  const closedLegacyContacts = sorted(closedLegacyVisibility.getRadarEntityIds());
  assertContract(
    closedLegacyVisible.includes(closedFullSightEnemy.id),
    'closed building passive sight must still reveal nearby enemies',
  );
  assertContract(
    !closedLegacyContacts.includes(closedRadarAnnulusEnemy.id),
    'closed building must not provide its powered radar annulus',
  );
  stampCombatTargetingPool(activeStateWorld);
  const closedNativeVisibility = SnapshotVisibility.forRecipient(
    activeStateWorld,
    1 as PlayerId,
  );
  assertSameIds(
    closedNativeVisibility.getVisibleEntityIds(),
    closedLegacyVisible,
    'native closed-building sight must match the source walk',
  );
  assertSameIds(
    closedNativeVisibility.getRadarEntityIds(),
    closedLegacyContacts,
    'native closed-building contacts must match the source walk',
  );

  getSimWasm()?.combatTargeting.clear();
  closedRadar.building.activeState.open = true;
  const openLegacyVisibility = SnapshotVisibility.forRecipient(
    activeStateWorld,
    1 as PlayerId,
  );
  const openLegacyContacts = sorted(openLegacyVisibility.getRadarEntityIds());
  assertContract(
    openLegacyContacts.includes(closedRadarAnnulusEnemy.id),
    'opening a sensor building must restore its powered radar annulus',
  );
  stampCombatTargetingPool(activeStateWorld);
  const openNativeVisibility = SnapshotVisibility.forRecipient(
    activeStateWorld,
    1 as PlayerId,
  );
  assertSameIds(
    openNativeVisibility.getRadarEntityIds(),
    openLegacyContacts,
    'native reopened-building contacts must match the source walk',
  );

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
  const radarStraddlingBuilding = createOpenedStructure(
    mediumWorld,
    4000,
    1100,
    2 as PlayerId,
    'buildingSonar',
  );
  radarStraddlingBuilding.transform.z = WATER_LEVEL;
  const radarOutsideCenterTarget = createUnit(mediumWorld, 5210, 1000, 2 as PlayerId, (entity) => {
    entity.transform.z = WATER_LEVEL + 100;
  });
  const sonarWaterTarget = createUnit(mediumWorld, 4000, 7000, 2 as PlayerId, (entity) => {
    entity.transform.z = WATER_LEVEL - 100;
  });
  const sonarAirTarget = createUnit(mediumWorld, 4000, 7000, 2 as PlayerId, (entity) => {
    entity.transform.z = WATER_LEVEL + 100;
  });
  const sonarStraddlingBuilding = createOpenedStructure(
    mediumWorld,
    4000,
    7100,
    2 as PlayerId,
    'buildingSonar',
  );
  sonarStraddlingBuilding.transform.z = WATER_LEVEL;
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
  // The radar's sensor eye sits at the top of its 150-unit mast (mount z
  // 145) — sink the building deep enough that the DISH is underwater, not
  // merely the foundation, or the mast pokes above the surface and
  // legitimately radiates on the above-water row.
  underwaterRadarBuilding.transform.z = WATER_LEVEL - 250;
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
  assertContract(
    legacyMediumContacts.includes(radarStraddlingBuilding.id),
    'radar must reveal the above-water fraction of a waterline building',
  );
  assertContract(legacyMediumContacts.includes(sonarWaterTarget.id), 'sonar must locate water-medium centers');
  assertContract(!legacyMediumContacts.includes(sonarAirTarget.id), 'sonar must reject air-medium centers');
  assertContract(
    legacyMediumContacts.includes(sonarStraddlingBuilding.id),
    'sonar must reveal the underwater fraction of a waterline building',
  );
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
      entity.transform.z = WATER_LEVEL + 100;
    },
  );
  const aboveObserverUnderwaterTarget = createUnit(
    matrixWorld,
    1010,
    1010,
    2 as PlayerId,
    (entity) => {
      entity.transform.z = WATER_LEVEL - 100;
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
      // Author the underwater source row HERE rather than leaning on the
      // roster's default. Dry units do not carry one — a tank cannot see
      // from a medium it cannot enter. This test is about the matrix's
      // source-row semantics, so it supplies its own sensor rather than
      // depending on what some blueprint happens to be tuned to. Full sight
      // crosses the waterline (sensorWaterlineSightContractTest), so the row
      // authors the same radius for both target media.
      const sensors = entity.combat!.turrets[0].config.targeting.observation.sensors;
      sensors.fullSight.underwater.underwater = 1200;
      sensors.fullSight.underwater.aboveWater = 1200;
      sensors.contactSight.underwater.underwater = 1200;
    },
  );
  const underwaterSameMediumTarget = createUnit(
    matrixWorld,
    1010,
    5000,
    2 as PlayerId,
    (entity) => {
      entity.transform.z = WATER_LEVEL - 100;
    },
  );
  const underwaterObserverAboveTarget = createUnit(
    matrixWorld,
    1010,
    5010,
    2 as PlayerId,
    (entity) => {
      entity.transform.z = WATER_LEVEL + 100;
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
      entity.combat!.turrets[0].config.targeting.observation.sensors.fullSight.aboveWater.underwater = 900;
    },
  );
  const aboveCrossMediumWaterTarget = createUnit(
    matrixWorld,
    7010,
    1000,
    2 as PlayerId,
    (entity) => {
      entity.transform.z = WATER_LEVEL - 100;
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
      entity.combat!.turrets[0].config.targeting.observation.sensors.fullSight.underwater.aboveWater = 900;
    },
  );
  const underwaterCrossMediumAboveTarget = createUnit(
    matrixWorld,
    7010,
    5000,
    2 as PlayerId,
    (entity) => {
      entity.transform.z = WATER_LEVEL + 100;
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
  // Full sight crosses the waterline: a source row reaches both target media
  // to the same radius, so the same-medium and cross-medium neighbours of a
  // default (blueprint) above-water observer are both seen, and likewise
  // for an authored underwater row.
  assertContract(
    legacyMatrixVisible.includes(aboveSameMediumTarget.id) &&
      legacyMatrixVisible.includes(aboveObserverUnderwaterTarget.id),
    'above-water source row must allow both A→A and A→W by default (full sight crosses the waterline)',
  );
  assertContract(
    legacyMatrixVisible.includes(underwaterSameMediumTarget.id) &&
      legacyMatrixVisible.includes(underwaterObserverAboveTarget.id),
    'underwater source row must allow both W→W and W→A (full sight crosses the waterline)',
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
  // ── STEALTH AND JAMMING SUPPRESS THE BLIP, NEVER THE EYEBALL ─────────────
  //
  // Both exist to deny CONTACT, and the one thing that must stay true of both
  // is that neither grants invisibility: a stealthed unit inside a jamming
  // field, standing in an enemy's line of sight, is seen normally. That
  // asymmetry is what keeps them a scouting problem instead of a win button,
  // and it is the assertion most likely to be quietly broken by a future
  // refactor that "simplifies" the two suppressors into the visibility path.
  const denialWorld = new WorldState(6107, 8192, 8192);
  denialWorld.playerCount = 2;
  denialWorld.fogOfWarEnabled = true;

  createUnit(denialWorld, 1000, 1000, 1 as PlayerId, (entity) => {
    entity.transform.z = WATER_LEVEL + 100;
    const sensors = entity.combat!.turrets[0].config.targeting.observation.sensors;
    // Radar reaching far, sight reaching barely — so "seen" and "contacted"
    // are separable at different ranges.
    sensors.fullSight.aboveWater.aboveWater = 400;
    sensors.contactSight.aboveWater.aboveWater = 5000;
  });

  const plainTarget = createUnit(denialWorld, 3000, 1000, 2 as PlayerId, (entity) => {
    entity.transform.z = WATER_LEVEL + 100;
  });
  const stealthInSightTarget = createUnit(denialWorld, 1200, 1000, 2 as PlayerId, (entity) => {
    entity.transform.z = WATER_LEVEL + 100;
  });
  const jammedTarget = createUnit(denialWorld, 4200, 1000, 2 as PlayerId, (entity) => {
    entity.transform.z = WATER_LEVEL + 100;
  });
  // The jammer protects its OWN side and sits with the unit it is covering.
  createUnit(denialWorld, 4200, 1000, 2 as PlayerId, (entity) => {
    entity.transform.z = WATER_LEVEL + 100;
    entity.combat!.turrets[0].config.targeting.observation.sensors.radarJamRadius = 800;
  });

  const denialVisibility = SnapshotVisibility.forRecipient(denialWorld, 1 as PlayerId);
  const denialContacts = sorted(denialVisibility.getRadarEntityIds());
  const denialVisible = sorted(denialVisibility.getVisibleEntityIds());

  assertContract(
    denialContacts.includes(plainTarget.id),
    'an ordinary unit inside radar range must produce a contact',
  );
  assertContract(
    !denialContacts.includes(jammedTarget.id),
    'a unit standing inside its own side\'s radar jammer must produce no contact',
  );
  assertContract(
    denialVisible.includes(stealthInSightTarget.id),
    'a unit inside direct sight must be seen whatever the contact layer says — '
      + 'stealth and jamming deny the blip, never the eyeball',
  );

  getSimWasm()?.combatTargeting.clear();
  spatialGrid.clear();
}

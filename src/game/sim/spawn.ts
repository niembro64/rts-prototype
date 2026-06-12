import type { WorldState } from './WorldState';
import type { Entity, PlayerId, BuildingBlueprintId, FactoryDefaultWaypoint } from './types';
import type { ConstructionSystem } from './construction';
import { economyManager } from './economy';
import { aimTurretsToward } from './turretInit';
import { setUnitFacingYaw } from './unitOrientation';
import { getBuildingConfig } from './buildConfigs';
import { BUILD_GRID_CELL_SIZE } from './buildGrid';
import { BUILDABLE_UNIT_BLUEPRINT_IDS } from './blueprints';
import { DEMO_CONFIG } from '../../demoConfig';
import type { WaypointType } from '../../types/commandTypes';
import {
  REAL_BATTLE_FACTORY_WAYPOINT_DISTANCE,
  REAL_BATTLE_FACTORY_WAYPOINT_TYPE,
} from '../../config';
import { isWaterAt } from './Terrain';
import {
  buildingBlueprintHasActiveState,
  initializeBuildingActiveState,
} from './buildingActiveState';
import { applyCompletedBuildingEffects } from './buildingCompletion';
import { applyBuildingBlueprintRuntime } from './buildingEntityRuntime';
import {
  getLayoutPlayerCount,
  getPlayerBaseAngle,
  getPlayerBuildArcAngle,
  normalizePlayerIds,
} from './playerLayout';
import {
  makeMapOvalMetrics,
  mapOvalAngleAt,
  mapOvalPointAt,
  type MapOvalMetrics,
} from './mapOval';
import { angleDeltaAbs } from '../math';

export { FIRST_PLAYER_ANGLE, getPlayerBaseAngle } from './playerLayout';

type InitialBaseMode = 'demo' | 'real';

type InitialFactoryWaypointConfig = {
  fightType: WaypointType;
  fightDistance: number;
  addDemoCenterPatrolLoop: boolean;
};

function getInitialFactoryWaypointConfig(mode: InitialBaseMode): InitialFactoryWaypointConfig {
  if (mode === 'real') {
    return {
      fightType: REAL_BATTLE_FACTORY_WAYPOINT_TYPE,
      fightDistance: REAL_BATTLE_FACTORY_WAYPOINT_DISTANCE,
      addDemoCenterPatrolLoop: false,
    };
  }
  return {
    fightType: 'fight',
    fightDistance: DEMO_CONFIG.factoryFightWaypointDistance,
    addDemoCenterPatrolLoop: true,
  };
}

/**
 * Compute a factory's default waypoint along the factory -> map-center axis.
 * `distance` controls how far: 0.5 = halfway to center, 1.0 = center, 1.5 = past center.
 */
export function computeFactoryWaypoint(
  factoryX: number, factoryY: number,
  mapWidth: number, mapHeight: number,
  distance: number,
): { x: number; y: number } {
  const cx = mapWidth / 2;
  const cy = mapHeight / 2;
  return {
    x: factoryX + (cx - factoryX) * distance,
    y: factoryY + (cy - factoryY) * distance,
  };
}

function computeFactoryDefaultWaypoints(
  factoryX: number,
  factoryY: number,
  mapWidth: number,
  mapHeight: number,
  config: InitialFactoryWaypointConfig,
): readonly FactoryDefaultWaypoint[] {
  const fight = computeFactoryWaypoint(
    factoryX,
    factoryY,
    mapWidth,
    mapHeight,
    config.fightDistance,
  );
  if (!config.addDemoCenterPatrolLoop) {
    return [{ x: fight.x, y: fight.y, z: null, type: config.fightType }];
  }

  const oval = makeMapOvalMetrics(mapWidth, mapHeight);
  const angle = mapOvalAngleAt(mapWidth, mapHeight, factoryX, factoryY);
  const patrolRadius = DEMO_CONFIG.centerSpawnRadius * oval.minDim;
  const near = mapOvalPointAt(oval, angle, patrolRadius);
  const far = mapOvalPointAt(oval, angle + Math.PI, patrolRadius);
  return [
    { x: fight.x, y: fight.y, z: null, type: config.fightType },
    { x: far.x, y: far.y, z: null, type: 'patrol' },
    { x: near.x, y: near.y, z: null, type: 'patrol' },
  ];
}

// Spawn a commander for a player
function spawnCommander(
  world: WorldState,
  playerId: PlayerId,
  x: number,
  y: number,
  facingAngle: number
): Entity {
  const commander = world.createUnitFromBlueprint(x, y, playerId, 'unitCommander');
  setUnitFacingYaw(commander, facingAngle);
  aimTurretsToward(commander, world.mapWidth / 2, world.mapHeight / 2);
  world.addEntity(commander);
  return commander;
}

// Map center + spawn-oval radius (margined inside the playable area).
// Single source of truth for every radial spawn-layout function below.
function getDemoOval(world: WorldState): { oval: MapOvalMetrics; radius: number } {
  const oval = makeMapOvalMetrics(world.mapWidth, world.mapHeight);
  return {
    oval,
    radius: oval.minDim / 2 - DEMO_CONFIG.spawnMarginPx,
  };
}

function commanderRadiusFromOuterSpawnRadius(spawnRadius: number): number {
  return demoBaseRingRadiusFromOuterSpawnRadius(
    spawnRadius,
    DEMO_CONFIG.baseRings.unitCommander.radiusFraction,
  );
}

function demoBaseRingRadiusFromOuterSpawnRadius(
  spawnRadius: number,
  radiusFraction: number,
): number {
  return spawnRadius * radiusFraction;
}

/** Commander placement radius for a map of the given dimensions.
 *  DEMO BATTLE and REAL BATTLE intentionally share
 *  `DEMO_CONFIG.baseRings.unitCommander.radiusFraction`, so changing the demo
 *  commander ring changes the real-battle ring and camera pre-framing
 *  at the same time. */
function commanderRadiusForMap(mapWidth: number, mapHeight: number): number {
  const spawnRadius =
    makeMapOvalMetrics(mapWidth, mapHeight).minDim / 2 -
    DEMO_CONFIG.spawnMarginPx;
  return commanderRadiusFromOuterSpawnRadius(spawnRadius);
}

/** World-space spawn position for seat `i` of a `playerCount`-player
 *  game on a map of the given dimensions. Stateless mirror of the
 *  internal `getSpawnPositions` helper, exposed so the 3D scene can
 *  pre-frame each client's camera on its own commander BEFORE the
 *  first snapshot arrives — without that, the camera stays centered
 *  on the map mid and the joiner's commander spawns off-frustum on
 *  the periphery. The radial-sector layout uses the same oval as
 *  `getDemoOval`. */
export function getSpawnPositionForSeat(
  seatIndex: number,
  playerCount: number,
  mapWidth: number,
  mapHeight: number,
): { x: number; y: number } {
  const radius = commanderRadiusForMap(mapWidth, mapHeight);
  const angle = getPlayerBaseAngle(seatIndex, playerCount);
  return mapOvalPointAt(makeMapOvalMetrics(mapWidth, mapHeight), angle, radius);
}

// Calculate spawn positions on the spawn oval for N players. Used
// for the REAL BATTLE flow (just commanders). The commander ring is
// shared with demo battle through DEMO_CONFIG.baseRings.unitCommander.
function getSpawnPositions(
  world: WorldState,
  playerCount: number
): { x: number; y: number; facingAngle: number }[] {
  const cx = world.mapWidth / 2;
  const cy = world.mapHeight / 2;
  const oval = makeMapOvalMetrics(world.mapWidth, world.mapHeight);
  const radius = commanderRadiusForMap(world.mapWidth, world.mapHeight);
  const positions: { x: number; y: number; facingAngle: number }[] = [];
  const count = getLayoutPlayerCount(playerCount);
  for (let i = 0; i < count; i++) {
    const angle = getPlayerBaseAngle(i, count);
    const point = mapOvalPointAt(oval, angle, radius);
    positions.push({
      x: point.x,
      y: point.y,
      facingAngle: Math.atan2(cy - point.y, cx - point.x),
    });
  }
  return positions;
}

// Place a pre-built (complete) building at a world position
function placeCompleteBuilding(
  world: WorldState,
  construction: ConstructionSystem,
  buildingBlueprintId: BuildingBlueprintId,
  worldX: number,
  worldY: number,
  playerId: PlayerId,
  factoryWaypoint: InitialFactoryWaypointConfig,
): Entity | null {
  const config = getBuildingConfig(buildingBlueprintId);
  const grid = construction.getGrid();

  // Snap, validate, and reserve by the placement footprint; the entity
  // body below keeps the physical footprint (shared center).
  const snapped = grid.snapToGrid(worldX, worldY, config.placementGridWidth, config.placementGridHeight);
  const gx = Math.floor(snapped.x / BUILD_GRID_CELL_SIZE);
  const gy = Math.floor(snapped.y / BUILD_GRID_CELL_SIZE);

  if (!grid.canPlace(gx, gy, config.placementGridWidth, config.placementGridHeight)) {
    return null;
  }

  const center = grid.getBuildingCenter(gx, gy, config.placementGridWidth, config.placementGridHeight);

  // Skip placements over water — water tiles are impassable.
  if (isWaterAt(center.x, center.y, world.mapWidth, world.mapHeight)) {
    return null;
  }

  const physicalSize = {
    width: config.gridWidth * BUILD_GRID_CELL_SIZE,
    height: config.gridHeight * BUILD_GRID_CELL_SIZE,
    depth: config.gridDepth * BUILD_GRID_CELL_SIZE,
  };

  const entity = world.createBuilding(
    center.x, center.y,
    physicalSize.width,
    physicalSize.height,
    physicalSize.depth,
    playerId,
  );

  applyBuildingBlueprintRuntime(entity, buildingBlueprintId, {
    allocateEntityId: () => world.generateEntityId(),
  });

  if (entity.building) {
    entity.building.hp = config.hp;
    entity.building.maxHp = config.hp;
  }

  if (buildingBlueprintId === 'towerFabricator') {
    const defaultWaypoints = computeFactoryDefaultWaypoints(
      center.x,
      center.y,
      world.mapWidth,
      world.mapHeight,
      factoryWaypoint,
    );
    const rally = defaultWaypoints[0];
    entity.factory = {
      selectedUnitBlueprintId: null,
      repeatProduction: true,
      productionQueue: [],
      currentShellId: null,
      currentBuildProgress: 0,
      defaultWaypoints,
      rallyX: rally.x,
      rallyY: rally.y,
      rallyZ: null,
      rallyType: rally.type,
      guardTargetId: null,
      isProducing: false,
      energyRateFraction: 0,
      metalRateFraction: 0,
    };
  }

  if (buildingBlueprintHasActiveState(buildingBlueprintId)) {
    initializeBuildingActiveState(world, entity);
  }

  grid.place(
    gx,
    gy,
    config.placementGridWidth,
    config.placementGridHeight,
    entity.id,
    playerId,
    true,
    config.gridWidth,
    config.gridHeight,
  );
  world.addEntity(entity);

  return entity;
}

// (Building rows replaced by per-player arcs along the spawn oval —
// see spawnInitialBases below.)

// Spawn initial entities for the game with N players (commander only)
export function spawnInitialEntities(world: WorldState, playerIds: PlayerId[] = [1, 2]): Entity[] {
  const entities: Entity[] = [];
  const normalizedPlayerIds = normalizePlayerIds(playerIds);

  world.playerCount = normalizedPlayerIds.length;

  for (const playerId of normalizedPlayerIds) {
    economyManager.initPlayer(playerId);
  }

  const spawnPositions = getSpawnPositions(world, normalizedPlayerIds.length);

  for (let i = 0; i < normalizedPlayerIds.length; i++) {
    const playerId = normalizedPlayerIds[i];
    const pos = spawnPositions[i];
    const commander = spawnCommander(world, playerId, pos.x, pos.y, pos.facingAngle);
    entities.push(commander);
  }

  return entities;
}

/**
 * Place a row of buildings evenly distributed across an angular arc on
 * the map oval. Each building faces toward the oval's center.
 * Buildings overlap-snap-skip the same
 * way they do in placeCompleteBuilding (returns null if no grid fit).
 */
function placeArcRow(
  world: WorldState,
  construction: ConstructionSystem,
  buildingBlueprintId: BuildingBlueprintId,
  count: number,
  oval: MapOvalMetrics,
  radius: number,
  baseAngle: number,
  sectorAngle: number,
  playerId: PlayerId,
  factoryWaypoint: InitialFactoryWaypointConfig,
): Entity[] {
  if (count <= 0) return [];
  const entities: Entity[] = [];
  const startAngle = baseAngle - sectorAngle / 2;
  const angularStep = count > 1 ? sectorAngle / (count - 1) : 0;
  for (let j = 0; j < count; j++) {
    const a = count > 1 ? startAngle + j * angularStep : baseAngle;
    const point = mapOvalPointAt(oval, a, radius);
    const e = placeCompleteBuilding(
      world,
      construction,
      buildingBlueprintId,
      point.x,
      point.y,
      playerId,
      factoryWaypoint,
    );
    if (e) entities.push(e);
  }
  return entities;
}

function getAvailableDemoFactoryUnitBlueprintIds(
  availableUnitBlueprintIds: ReadonlySet<string> | undefined = undefined,
): string[] {
  return BUILDABLE_UNIT_BLUEPRINT_IDS.filter((unitBlueprintId) =>
    availableUnitBlueprintIds ? availableUnitBlueprintIds.has(unitBlueprintId) : true,
  );
}

function seedFactoryRepeatBuild(factory: Entity, unitBlueprintId: string): void {
  if (!factory.factory) return;
  factory.factory.selectedUnitBlueprintId = unitBlueprintId;
  factory.factory.productionQueue.length = 0;
  factory.factory.repeatProduction = true;
}

function placeFactoryArcRowForUnitBlueprintIds(
  world: WorldState,
  construction: ConstructionSystem,
  unitBlueprintIds: readonly string[],
  oval: MapOvalMetrics,
  radius: number,
  baseAngle: number,
  sectorAngle: number,
  playerId: PlayerId,
  factoryWaypoint: InitialFactoryWaypointConfig,
): Entity[] {
  const count = unitBlueprintIds.length;
  if (count <= 0) return [];
  const entities: Entity[] = [];
  const startAngle = baseAngle - sectorAngle / 2;
  const angularStep = count > 1 ? sectorAngle / (count - 1) : 0;

  for (let j = 0; j < count; j++) {
    const a = count > 1 ? startAngle + j * angularStep : baseAngle;
    const point = mapOvalPointAt(oval, a, radius);
    const factory = placeCompleteBuilding(
      world,
      construction,
      'towerFabricator',
      point.x,
      point.y,
      playerId,
      factoryWaypoint,
    );
    if (!factory) continue;
    seedFactoryRepeatBuild(factory, unitBlueprintIds[j]);
    entities.push(factory);
  }

  return entities;
}

/**
 * Spawn a full base for each player on concentric oval arcs centered
 * on the map. Each ring's radius comes directly from DEMO_CONFIG:
 *
 *           commander  ← outermost
 *           solar arc
 *           wind arc
 *           fabricator arc
 *           resource converter arc
 *           megaBeam tower arc
 *           cannon tower arc ← closest to map center
 *
 * Each arc spans the same angular sector for the player, and every
 * building faces the map center. Solar/wind/tower counts and oval radius
 * fractions are controlled by DEMO_CONFIG. Fabricators are derived from the
 * active demo unit roster: one fabricator per available unit blueprint, seeded
 * to repeat-build that unit.
 */
export function spawnInitialBases(
  world: WorldState,
  construction: ConstructionSystem,
  playerIds: PlayerId[],
  mode: InitialBaseMode = 'demo',
  availableUnitBlueprintIds: ReadonlySet<string> | undefined = undefined,
): Entity[] {
  const entities: Entity[] = [];

  const normalizedPlayerIds = normalizePlayerIds(playerIds);

  world.playerCount = normalizedPlayerIds.length;

  for (const playerId of normalizedPlayerIds) {
    economyManager.initPlayer(playerId);
  }

  const playerCount = normalizedPlayerIds.length;
  const { oval, radius: spawnRadius } = getDemoOval(world);
  const { cx, cy } = oval;
  const factoryWaypoint = getInitialFactoryWaypointConfig(mode);
  const factoryUnitBlueprintIds = getAvailableDemoFactoryUnitBlueprintIds(availableUnitBlueprintIds);

  // Concentric radii — each ring is explicit so the demo layout can be
  // tuned the same way metal deposit rings are tuned.
  const commanderRadius = commanderRadiusFromOuterSpawnRadius(spawnRadius);
  const solarRadius = demoBaseRingRadiusFromOuterSpawnRadius(
    spawnRadius,
    DEMO_CONFIG.baseRings.buildingSolar.radiusFraction,
  );
  const windRadius = demoBaseRingRadiusFromOuterSpawnRadius(
    spawnRadius,
    DEMO_CONFIG.baseRings.buildingWind.radiusFraction,
  );
  const factoryRadius = demoBaseRingRadiusFromOuterSpawnRadius(
    spawnRadius,
    DEMO_CONFIG.baseRings.towerFabricator.radiusFraction,
  );
  const radarRadius = demoBaseRingRadiusFromOuterSpawnRadius(
    spawnRadius,
    DEMO_CONFIG.baseRings.buildingRadar.radiusFraction,
  );
  const megaBeamTowerRadius = demoBaseRingRadiusFromOuterSpawnRadius(
    spawnRadius,
    DEMO_CONFIG.baseRings.towerBeamMega.radiusFraction,
  );
  const cannonTowerRadius = demoBaseRingRadiusFromOuterSpawnRadius(
    spawnRadius,
    DEMO_CONFIG.baseRings.towerCannon.radiusFraction,
  );
  const antiAirTowerRadius = demoBaseRingRadiusFromOuterSpawnRadius(
    spawnRadius,
    DEMO_CONFIG.baseRings.towerAntiAir.radiusFraction,
  );
  const resourceConverterRadius = demoBaseRingRadiusFromOuterSpawnRadius(
    spawnRadius,
    DEMO_CONFIG.baseRings.buildingResourceConverter.radiusFraction,
  );

  // Each player's slice of the spawn oval is ONE HALF of the
  // 2π/N angular cycle — the other half is the divider terrain slice
  // (the mountain ridge in Terrain.ts). This same formula is used for
  // one-player maps too: one commander gets one team slice and one
  // divider slice, rather than a special full-circle layout.
  const sectorAngle = getPlayerBuildArcAngle(playerCount, DEMO_CONFIG.arcSectorFraction);

  for (let i = 0; i < playerCount; i++) {
    const playerId = normalizedPlayerIds[i];
    const baseAngle = getPlayerBaseAngle(i, playerCount);

    // Commander: single entity at the player's spawn point on the outer
    // oval, facing the map center.
    const cmdPoint = mapOvalPointAt(oval, baseAngle, commanderRadius);
    const cmdFacing = Math.atan2(cy - cmdPoint.y, cx - cmdPoint.x);
    const commander = spawnCommander(
      world,
      playerId,
      cmdPoint.x,
      cmdPoint.y,
      cmdFacing,
    );
    entities.push(commander);

    // Solar collector arc.
    entities.push(...placeArcRow(
      world, construction, 'buildingSolar', DEMO_CONFIG.buildingSolarCount,
      oval, solarRadius, baseAngle, sectorAngle, playerId, factoryWaypoint,
    ));

    // Wind turbine arc — independent radius so its silhouette reads on
    // its own ring, not interleaved with the solars.
    entities.push(...placeArcRow(
      world, construction, 'buildingWind', DEMO_CONFIG.buildingWindCount,
      oval, windRadius, baseAngle, sectorAngle, playerId, factoryWaypoint,
    ));

    // Radar arc — long sensor coverage without adding more weapons.
    entities.push(...placeArcRow(
      world, construction, 'buildingRadar', DEMO_CONFIG.buildingRadarCount,
      oval, radarRadius, baseAngle, sectorAngle, playerId, factoryWaypoint,
    ));

    // Fabricator arc — one fabricator per available demo unit blueprint.
    // Each fabricator starts with a repeat-build selection matching
    // its unit blueprint, so the base layout and AI production inventory
    // stay tied to the same unit roster.
    entities.push(...placeFactoryArcRowForUnitBlueprintIds(
      world, construction, factoryUnitBlueprintIds,
      oval, factoryRadius, baseAngle, sectorAngle, playerId, factoryWaypoint,
    ));

    // megaBeam tower arc — covers the approach to the base from the
    // map center.
    entities.push(...placeArcRow(
      world, construction, 'towerBeamMega', DEMO_CONFIG.towerBeamMegaCount,
      oval, megaBeamTowerRadius, baseAngle, sectorAngle, playerId, factoryWaypoint,
    ));

    // Cannon tower arc — companion static-defense ring for long-range
    // heavy shots.
    entities.push(...placeArcRow(
      world, construction, 'towerCannon', DEMO_CONFIG.towerCannonCount,
      oval, cannonTowerRadius, baseAngle, sectorAngle, playerId, factoryWaypoint,
    ));

    // Anti-air tower arc — static missile cover for hover/flying units.
    entities.push(...placeArcRow(
      world, construction, 'towerAntiAir', DEMO_CONFIG.towerAntiAirCount,
      oval, antiAirTowerRadius, baseAngle, sectorAngle, playerId, factoryWaypoint,
    ));

    // Resource converter arc — economy buildings on their own ring
    // between fabricators and the static-defense rings.
    entities.push(...placeArcRow(
      world, construction, 'buildingResourceConverter', DEMO_CONFIG.buildingResourceConverterCount,
      oval, resourceConverterRadius, baseAngle, sectorAngle, playerId, factoryWaypoint,
    ));
  }

  return entities;
}

function ownerForDeposit(world: WorldState, playerIds: PlayerId[], x: number, y: number): PlayerId {
  const depositAngle = mapOvalAngleAt(world.mapWidth, world.mapHeight, x, y);
  let bestIndex = 0;
  let bestDelta = Infinity;
  for (let i = 0; i < playerIds.length; i++) {
    const delta = angleDeltaAbs(depositAngle, getPlayerBaseAngle(i, playerIds.length));
    if (delta < bestDelta) {
      bestDelta = delta;
      bestIndex = i;
    }
  }
  return playerIds[bestIndex];
}

export function spawnMetalExtractorsOnDeposits(
  world: WorldState,
  construction: ConstructionSystem,
  playerIds: PlayerId[],
): Entity[] {
  if (playerIds.length === 0 || world.metalDeposits.length === 0) return [];
  const entities: Entity[] = [];
  const grid = construction.getGrid();
  const config = getBuildingConfig('buildingExtractor');

  for (const deposit of world.metalDeposits) {
    const ownerId = ownerForDeposit(world, playerIds, deposit.x, deposit.y);
    const snapped = grid.snapToGrid(deposit.x, deposit.y, config.placementGridWidth, config.placementGridHeight);
    const gridPos = grid.worldToGrid(snapped.x, snapped.y);
    const extractor = construction.startBuilding(
      world,
      'buildingExtractor',
      gridPos.gx,
      gridPos.gy,
      ownerId,
      0,
      0,
      { skipBuilderAuthorization: true },
    );
    if (!extractor) continue;

    if (extractor.buildable) {
      // Pre-built extractor at game start — paid in full so HP /
      // bars / activity flip directly to "complete" without going
      // through the construction loop.
      extractor.buildable.paid = { ...extractor.buildable.required };
      extractor.buildable.isComplete = true;
    }
    if (extractor.building) {
      extractor.building.hp = config.hp;
      extractor.building.maxHp = config.hp;
    }
    applyCompletedBuildingEffects(world, extractor);
    extractor.buildable = null;
    entities.push(extractor);
  }

  return entities;
}

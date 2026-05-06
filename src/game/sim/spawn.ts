import type { WorldState } from './WorldState';
import type { Entity, PlayerId, BuildingType } from './types';
import type { ConstructionSystem } from './construction';
import { economyManager } from './economy';
import { aimTurretsToward } from './turretInit';
import { getBuildingConfig } from './buildConfigs';
import { GRID_CELL_SIZE } from './grid';
import { DEMO_CONFIG, type DemoBattleWaypointType } from '../../demoConfig';
import {
  REAL_BATTLE_FACTORY_WAYPOINT_DISTANCE,
  REAL_BATTLE_FACTORY_WAYPOINT_TYPE,
} from '../../config';
import { isWaterAt } from './Terrain';
import { ensureSolarCollectorState, startSolarCollectorClosed } from './solarCollector';
import { applyCompletedBuildingEffects } from './buildingCompletion';
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

export { FIRST_PLAYER_ANGLE, getPlayerBaseAngle } from './playerLayout';

type InitialBaseMode = 'demo' | 'real';

type InitialFactoryWaypointConfig = {
  type: DemoBattleWaypointType;
  distance: number;
};

function getInitialFactoryWaypointConfig(mode: InitialBaseMode): InitialFactoryWaypointConfig {
  return mode === 'real'
    ? {
        type: REAL_BATTLE_FACTORY_WAYPOINT_TYPE,
        distance: REAL_BATTLE_FACTORY_WAYPOINT_DISTANCE,
      }
    : {
        type: DEMO_CONFIG.factoryWaypointType,
        distance: DEMO_CONFIG.factoryWaypointDistance,
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

// Spawn a commander for a player
function spawnCommander(
  world: WorldState,
  playerId: PlayerId,
  x: number,
  y: number,
  facingAngle: number
): Entity {
  const commander = world.createUnitFromBlueprint(x, y, playerId, 'commander');
  commander.transform.rotation = facingAngle;
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
  return spawnRadius * DEMO_CONFIG.commanderRadiusFraction;
}

/** Commander placement radius for a map of the given dimensions.
 *  DEMO BATTLE and REAL BATTLE intentionally share
 *  `DEMO_CONFIG.commanderRadiusFraction`, so changing the demo
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
 *  `getDemoOval`, so this is also the same seat the capture
 *  system pre-paints for that player. */
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
// shared with demo battle through DEMO_CONFIG.commanderRadiusFraction.
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
  buildingType: BuildingType,
  worldX: number,
  worldY: number,
  playerId: PlayerId,
  factoryWaypoint: InitialFactoryWaypointConfig,
): Entity | null {
  const config = getBuildingConfig(buildingType);
  const grid = construction.getGrid();

  const snapped = grid.snapToGrid(worldX, worldY, config.gridWidth, config.gridHeight);
  const gx = Math.floor(snapped.x / GRID_CELL_SIZE);
  const gy = Math.floor(snapped.y / GRID_CELL_SIZE);

  if (!grid.canPlace(gx, gy, config.gridWidth, config.gridHeight)) {
    return null;
  }

  const center = grid.getBuildingCenter(gx, gy, config.gridWidth, config.gridHeight);

  // Skip placements over water — water tiles are impassable.
  if (isWaterAt(center.x, center.y, world.mapWidth, world.mapHeight)) {
    return null;
  }

  const physicalSize = {
    width: config.gridWidth * GRID_CELL_SIZE,
    height: config.gridHeight * GRID_CELL_SIZE,
    depth: config.gridDepth * GRID_CELL_SIZE,
  };

  const entity = world.createBuilding(
    center.x, center.y,
    physicalSize.width,
    physicalSize.height,
    physicalSize.depth,
    playerId,
  );

  entity.buildingType = buildingType;
  if (buildingType === 'solar') {
    ensureSolarCollectorState(entity);
  }

  if (entity.building) {
    entity.building.hp = config.hp;
    entity.building.maxHp = config.hp;
  }

  if (buildingType === 'factory') {
    const wp = computeFactoryWaypoint(
      center.x,
      center.y,
      world.mapWidth,
      world.mapHeight,
      factoryWaypoint.distance,
    );
    const rally = computeFactoryWaypoint(
      center.x,
      center.y,
      world.mapWidth,
      world.mapHeight,
      REAL_BATTLE_FACTORY_WAYPOINT_DISTANCE,
    );
    entity.factory = {
      buildQueue: [],
      currentShellId: null,
      currentBuildProgress: 0,
      rallyX: rally.x,
      rallyY: rally.y,
      isProducing: false,
      waypoints: [{ x: wp.x, y: wp.y, type: factoryWaypoint.type }],
      energyRateFraction: 0,
      manaRateFraction: 0,
      metalRateFraction: 0,
    };
  }

  if (buildingType === 'solar' && config.energyProduction) {
    startSolarCollectorClosed(world, entity);
  }

  grid.place(gx, gy, config.gridWidth, config.gridHeight, entity.id, playerId);
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
  buildingType: BuildingType,
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
      buildingType,
      point.x,
      point.y,
      playerId,
      factoryWaypoint,
    );
    if (e) entities.push(e);
  }
  return entities;
}

/**
 * Spawn a full base for each player on three concentric oval arcs centered
 * on the map. Mirrors the original square layout's radial ordering —
 * commander outermost (at the spawn oval), then solars, then factories
 * closest to the map center — but each "row" is now an arc rather than
 * a straight line:
 *
 *           commander  ← outermost (spawn radius)
 *           solar arc
 *           factory arc ← closest to map center
 *
 * Each arc spans the same angular sector for the player, and every
 * building faces the map center. Building counts and oval radial gaps are
 * controlled by DEMO_CONFIG.
 */
export function spawnInitialBases(
  world: WorldState,
  construction: ConstructionSystem,
  playerIds: PlayerId[],
  mode: InitialBaseMode = 'demo',
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

  const solarConfig = getBuildingConfig('solar');
  const windConfig = getBuildingConfig('wind');
  const factoryConfig = getBuildingConfig('factory');
  const megaBeamTowerConfig = getBuildingConfig('megaBeamTower');
  const cellGap = DEMO_CONFIG.rowGapCells * GRID_CELL_SIZE;
  const commanderGap = DEMO_CONFIG.commanderGapCells * GRID_CELL_SIZE;
  const megaBeamTowerGap = DEMO_CONFIG.megaBeamTowerGapCells * GRID_CELL_SIZE;
  const solarDepth = solarConfig.gridHeight * GRID_CELL_SIZE;
  const windDepth = windConfig.gridHeight * GRID_CELL_SIZE;
  const factoryDepth = factoryConfig.gridHeight * GRID_CELL_SIZE;
  const megaBeamTowerDepth = megaBeamTowerConfig.gridHeight * GRID_CELL_SIZE;

  // Five concentric radii — outermost to innermost: commander, solar,
  // wind, factory, megaBeam tower. Solar and wind used to share one
  // alternating arc; they now ride on independent radii. The megaBeam
  // tower arc sits further inward than every other building so the
  // towers cover the approach to the base from the map center.
  const commanderRadius = commanderRadiusFromOuterSpawnRadius(spawnRadius);
  const solarRadius = commanderRadius - commanderGap - solarDepth / 2;
  const windRadius = solarRadius - solarDepth / 2 - cellGap - windDepth / 2;
  const factoryRadius = windRadius - windDepth / 2 - cellGap - factoryDepth / 2;
  const megaBeamTowerRadius =
    factoryRadius - factoryDepth / 2 - megaBeamTowerGap - megaBeamTowerDepth / 2;

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
      world, construction, 'solar', DEMO_CONFIG.solarCount,
      oval, solarRadius, baseAngle, sectorAngle, playerId, factoryWaypoint,
    ));

    // Wind turbine arc — independent radius so its silhouette reads on
    // its own ring, not interleaved with the solars.
    entities.push(...placeArcRow(
      world, construction, 'wind', DEMO_CONFIG.windCount,
      oval, windRadius, baseAngle, sectorAngle, playerId, factoryWaypoint,
    ));

    // Factory arc.
    entities.push(...placeArcRow(
      world, construction, 'factory', DEMO_CONFIG.factoryCount,
      oval, factoryRadius, baseAngle, sectorAngle, playerId, factoryWaypoint,
    ));

    // megaBeam tower arc — innermost, covers the approach to the base
    // from the map center.
    entities.push(...placeArcRow(
      world, construction, 'megaBeamTower', DEMO_CONFIG.megaBeamTowerCount,
      oval, megaBeamTowerRadius, baseAngle, sectorAngle, playerId, factoryWaypoint,
    ));
  }

  return entities;
}

function angleDeltaAbs(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return Math.abs(d);
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
  const config = getBuildingConfig('extractor');

  for (const deposit of world.metalDeposits) {
    const ownerId = ownerForDeposit(world, playerIds, deposit.x, deposit.y);
    const snapped = grid.snapToGrid(deposit.x, deposit.y, config.gridWidth, config.gridHeight);
    const gridPos = grid.worldToGrid(snapped.x, snapped.y);
    const extractor = construction.startBuilding(
      world,
      'extractor',
      gridPos.gx,
      gridPos.gy,
      ownerId,
      0,
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
    delete extractor.buildable;
    entities.push(extractor);
  }

  return entities;
}

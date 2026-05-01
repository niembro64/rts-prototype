import type { WorldState } from './WorldState';
import type { Entity, PlayerId, BuildingType } from './types';
import type { ConstructionSystem } from './construction';
import { economyManager } from './economy';
import { aimTurretsToward } from './turretInit';
import { getBuildingConfig } from './buildConfigs';
import { GRID_CELL_SIZE } from './grid';
import { DEMO_CONFIG } from '../../demoConfig';
import { isWaterAt } from './Terrain';
import { ensureSolarCollectorState, startSolarCollectorClosed } from './solarCollector';

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

// Map center + spawn-circle radius (margined inside the playable area).
// Single source of truth for every demo-layout function below.
function getDemoCircle(world: WorldState): { cx: number; cy: number; radius: number } {
  return {
    cx: world.mapWidth / 2,
    cy: world.mapHeight / 2,
    radius: Math.min(world.mapWidth, world.mapHeight) / 2 - DEMO_CONFIG.spawnMarginPx,
  };
}

// Angular position of player i on the spawn circle. Players are spaced
// evenly starting from FIRST_PLAYER_ANGLE. Anchor is rotated 45°
// counterclockwise from the top (-π/2) so player 0 lands at -π/4 —
// a corner of a square map (northeast in screen coords with +Y down)
// — instead of the middle of a flat edge. With this anchor + the
// matching terrain phase shift in `getTerrainHeight`, the team-area
// arcs sit at the four corners and the divider ridges run along the
// four cardinal directions, so each team's back is to a corner of
// the map. Exported so the background-battle unit spawner can place
// each team's units on the same arc as their base.
export const FIRST_PLAYER_ANGLE = -Math.PI / 2 + Math.PI / 4;
export function getPlayerBaseAngle(i: number, playerCount: number): number {
  return (i / playerCount) * Math.PI * 2 + FIRST_PLAYER_ANGLE;
}

/** World-space spawn position for seat `i` of a `playerCount`-player
 *  game on a map of the given dimensions. Stateless mirror of the
 *  internal `getSpawnPositions` helper, exposed so the 3D scene can
 *  pre-frame each client's camera on its own commander BEFORE the
 *  first snapshot arrives — without that, the camera stays centered
 *  on the map mid and the joiner's commander spawns off-frustum on
 *  the periphery. The radial-sector layout uses the same circle as
 *  `getDemoCircle`, so this is also the same seat the capture
 *  system pre-paints for that player. */
export function getSpawnPositionForSeat(
  seatIndex: number,
  playerCount: number,
  mapWidth: number,
  mapHeight: number,
): { x: number; y: number } {
  const radius = Math.min(mapWidth, mapHeight) / 2 - DEMO_CONFIG.spawnMarginPx;
  const angle = getPlayerBaseAngle(seatIndex, Math.max(1, playerCount));
  return {
    x: mapWidth / 2 + Math.cos(angle) * radius,
    y: mapHeight / 2 + Math.sin(angle) * radius,
  };
}

// Calculate spawn positions on the spawn circle for N players.
function getSpawnPositions(
  world: WorldState,
  playerCount: number
): { x: number; y: number; facingAngle: number }[] {
  const c = getDemoCircle(world);
  const positions: { x: number; y: number; facingAngle: number }[] = [];
  for (let i = 0; i < playerCount; i++) {
    const angle = getPlayerBaseAngle(i, playerCount);
    const x = c.cx + Math.cos(angle) * c.radius;
    const y = c.cy + Math.sin(angle) * c.radius;
    positions.push({ x, y, facingAngle: Math.atan2(c.cy - y, c.cx - x) });
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

  entity.buildable = {
    buildProgress: 1,
    resourceCost: config.resourceCost,
    isComplete: true,
    isGhost: false,
  };
  entity.buildingType = buildingType;
  if (buildingType === 'solar') {
    ensureSolarCollectorState(entity);
  }

  if (entity.building) {
    entity.building.hp = config.hp;
    entity.building.maxHp = config.hp;
  }

  if (buildingType === 'factory') {
    const wp = computeFactoryWaypoint(center.x, center.y, world.mapWidth, world.mapHeight, DEMO_CONFIG.factoryWaypointDistance);
    const rally = computeFactoryWaypoint(center.x, center.y, world.mapWidth, world.mapHeight, 0.5);
    entity.factory = {
      buildQueue: [],
      currentBuildProgress: 0,
      currentBuildResourceCost: 0,
      rallyX: rally.x,
      rallyY: rally.y,
      isProducing: false,
      waypoints: [{ x: wp.x, y: wp.y, type: DEMO_CONFIG.factoryWaypointType }],
    };
  }

  if (buildingType === 'solar' && config.energyProduction) {
    startSolarCollectorClosed(world, entity);
  }

  grid.place(gx, gy, config.gridWidth, config.gridHeight, entity.id, playerId);
  world.addEntity(entity);

  return entity;
}

// (Building rows replaced by per-player arcs along the spawn circle —
// see spawnInitialBases below.)

// Spawn initial entities for the game with N players (commander only)
export function spawnInitialEntities(world: WorldState, playerIds: PlayerId[] = [1, 2]): Entity[] {
  const entities: Entity[] = [];

  world.playerCount = playerIds.length;

  for (const playerId of playerIds) {
    economyManager.initPlayer(playerId);
  }

  const spawnPositions = getSpawnPositions(world, playerIds.length);

  for (let i = 0; i < playerIds.length; i++) {
    const playerId = playerIds[i];
    const pos = spawnPositions[i];
    const commander = spawnCommander(world, playerId, pos.x, pos.y, pos.facingAngle);
    entities.push(commander);
  }

  return entities;
}

/**
 * Place a row of buildings evenly distributed across an angular arc on
 * a circle of given radius around (centerX, centerY). Each building
 * faces toward the circle's center. Buildings overlap-snap-skip the same
 * way they do in placeCompleteBuilding (returns null if no grid fit).
 */
function placeArcRow(
  world: WorldState,
  construction: ConstructionSystem,
  buildingType: BuildingType,
  count: number,
  centerX: number,
  centerY: number,
  radius: number,
  baseAngle: number,
  sectorAngle: number,
  playerId: PlayerId,
): Entity[] {
  if (count <= 0) return [];
  const entities: Entity[] = [];
  const startAngle = baseAngle - sectorAngle / 2;
  const angularStep = count > 1 ? sectorAngle / (count - 1) : 0;
  for (let j = 0; j < count; j++) {
    const a = count > 1 ? startAngle + j * angularStep : baseAngle;
    const wx = centerX + Math.cos(a) * radius;
    const wy = centerY + Math.sin(a) * radius;
    const e = placeCompleteBuilding(world, construction, buildingType, wx, wy, playerId);
    if (e) entities.push(e);
  }
  return entities;
}

function placePowerArcRow(
  world: WorldState,
  construction: ConstructionSystem,
  count: number,
  centerX: number,
  centerY: number,
  radius: number,
  baseAngle: number,
  sectorAngle: number,
  playerId: PlayerId,
): Entity[] {
  if (count <= 0) return [];
  const entities: Entity[] = [];
  const startAngle = baseAngle - sectorAngle / 2;
  const angularStep = count > 1 ? sectorAngle / (count - 1) : 0;
  let solarRemaining = Math.ceil(count / 2);
  let windRemaining = Math.floor(count / 2);
  for (let j = 0; j < count; j++) {
    const preferWind = j % 2 === 1;
    const buildingType: BuildingType =
      (preferWind && windRemaining > 0) || solarRemaining <= 0 ? 'wind' : 'solar';
    if (buildingType === 'wind') windRemaining--;
    else solarRemaining--;
    const a = count > 1 ? startAngle + j * angularStep : baseAngle;
    const wx = centerX + Math.cos(a) * radius;
    const wy = centerY + Math.sin(a) * radius;
    const e = placeCompleteBuilding(world, construction, buildingType, wx, wy, playerId);
    if (e) entities.push(e);
  }
  return entities;
}

/**
 * Spawn a full base for each player on three concentric arcs centered
 * on the map. Mirrors the original square layout's radial ordering —
 * commander outermost (at the spawn circle), then solars, then factories
 * closest to the map center — but each "row" is now an arc rather than
 * a straight line:
 *
 *           commander  ← outermost (spawn radius)
 *           solar arc
 *           factory arc ← closest to map center
 *
 * Each arc spans the same angular sector for the player, and every
 * building faces the map center. Building counts and radial gaps are
 * controlled by DEMO_CONFIG.
 */
export function spawnInitialBases(
  world: WorldState,
  construction: ConstructionSystem,
  playerIds: PlayerId[],
): Entity[] {
  const entities: Entity[] = [];

  world.playerCount = playerIds.length;

  for (const playerId of playerIds) {
    economyManager.initPlayer(playerId);
  }

  const playerCount = playerIds.length;
  const { cx, cy, radius: spawnRadius } = getDemoCircle(world);

  const solarConfig = getBuildingConfig('solar');
  const factoryConfig = getBuildingConfig('factory');
  const cellGap = DEMO_CONFIG.rowGapCells * GRID_CELL_SIZE;
  const commanderGap = DEMO_CONFIG.commanderGapCells * GRID_CELL_SIZE;
  const solarDepth = solarConfig.gridHeight * GRID_CELL_SIZE;
  const factoryDepth = factoryConfig.gridHeight * GRID_CELL_SIZE;

  // Three concentric radii — same radial order as the original square
  // layout (commander outermost, then solars, then factories).
  const commanderRadius = spawnRadius;
  const solarRadius = commanderRadius - commanderGap - solarDepth / 2;
  const factoryRadius = solarRadius - solarDepth / 2 - cellGap - factoryDepth / 2;

  // Each player's slice of the spawn circle is ONE HALF of the
  // 2π/N angular cycle — the other half is the team-separator
  // barrier slice (the mountain ridge in Terrain.ts). With N=3 the
  // map has 6 slices total: 3 team slices alternating with 3 barrier
  // slices. arcSectorFraction trims a bit off the team slice so
  // buildings don't kiss the barrier edges.
  const sectorAngle = (Math.PI / playerCount) * DEMO_CONFIG.arcSectorFraction;

  for (let i = 0; i < playerCount; i++) {
    const playerId = playerIds[i];
    const baseAngle = getPlayerBaseAngle(i, playerCount);

    // Commander: single entity at the player's spawn point on the outer
    // circle, facing the map center.
    const cmdX = cx + Math.cos(baseAngle) * commanderRadius;
    const cmdY = cy + Math.sin(baseAngle) * commanderRadius;
    const cmdFacing = Math.atan2(cy - cmdY, cx - cmdX);
    const commander = spawnCommander(world, playerId, cmdX, cmdY, cmdFacing);
    entities.push(commander);

    // Power arc: same slots that used to be all solar, split evenly
    // between solar collectors and wind turbines.
    entities.push(...placePowerArcRow(
      world, construction, DEMO_CONFIG.solarCount,
      cx, cy, solarRadius, baseAngle, sectorAngle, playerId,
    ));

    // Factory arc (closest to center).
    entities.push(...placeArcRow(
      world, construction, 'factory', DEMO_CONFIG.factoryCount,
      cx, cy, factoryRadius, baseAngle, sectorAngle, playerId,
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
  if (playerIds.length <= 1) return playerIds[0] ?? (1 as PlayerId);
  const cx = world.mapWidth / 2;
  const cy = world.mapHeight / 2;
  const depositAngle = Math.atan2(y - cy, x - cx);
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
      extractor.buildable.buildProgress = 1;
      extractor.buildable.isComplete = true;
    }
    if (config.metalProduction) {
      economyManager.addMetalExtraction(ownerId, config.metalProduction);
    }
    entities.push(extractor);
  }

  return entities;
}

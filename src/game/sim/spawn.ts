import type { WorldState } from './WorldState';
import type { Entity, PlayerId, BuildingType } from './types';
import type { ConstructionSystem } from './construction';
import { economyManager } from './economy';
import { aimTurretsToward } from './turretInit';
import { getBuildingConfig } from './buildConfigs';
import { GRID_CELL_SIZE } from './grid';
import { DEMO_CONFIG } from '../../demoConfig';

/**
 * Compute a factory's default fight waypoint along the factory → map-center axis.
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

// Calculate spawn positions on a circle for N players
function getSpawnPositions(
  world: WorldState,
  playerCount: number
): { x: number; y: number; facingAngle: number }[] {
  const centerX = world.mapWidth / 2;
  const centerY = world.mapHeight / 2;
  const radius = Math.min(world.mapWidth, world.mapHeight) / 2 - DEMO_CONFIG.spawnMarginPx;

  const positions: { x: number; y: number; facingAngle: number }[] = [];

  for (let i = 0; i < playerCount; i++) {
    // Distribute evenly around circle, starting from top
    const angle = (i / playerCount) * Math.PI * 2 - Math.PI / 2;
    const x = centerX + Math.cos(angle) * radius;
    const y = centerY + Math.sin(angle) * radius;
    const facingAngle = Math.atan2(centerY - y, centerX - x);
    positions.push({ x, y, facingAngle });
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

  const entity = world.createBuilding(
    center.x, center.y,
    config.gridWidth * GRID_CELL_SIZE,
    config.gridHeight * GRID_CELL_SIZE,
    playerId,
  );

  entity.buildable = {
    buildProgress: 1,
    energyCost: config.energyCost,
    isComplete: true,
    isGhost: false,
  };
  entity.buildingType = buildingType;

  if (entity.building) {
    entity.building.hp = config.hp;
    entity.building.maxHp = config.hp;
  }

  if (buildingType === 'factory') {
    const wp = computeFactoryWaypoint(center.x, center.y, world.mapWidth, world.mapHeight, DEMO_CONFIG.factoryFightDistance);
    const rally = computeFactoryWaypoint(center.x, center.y, world.mapWidth, world.mapHeight, 0.5);
    entity.factory = {
      buildQueue: [],
      currentBuildProgress: 0,
      currentBuildCost: 0,
      rallyX: rally.x,
      rallyY: rally.y,
      isProducing: false,
      waypoints: [{ x: wp.x, y: wp.y, type: DEMO_CONFIG.factoryWaypointType }],
    };
  }

  if (buildingType === 'solar' && config.energyProduction) {
    economyManager.addProduction(playerId, config.energyProduction);
  }

  grid.place(gx, gy, config.gridWidth, config.gridHeight, entity.id, playerId);
  world.addEntity(entity);

  return entity;
}

/**
 * Place a row of buildings evenly spaced along a lateral line.
 * The total spread is determined by `lateralSpreadRatio` — the fraction
 * of the map edge the row occupies. Buildings are centered within that span.
 */
function placeBuildingRow(
  world: WorldState,
  construction: ConstructionSystem,
  buildingType: BuildingType,
  count: number,
  baseX: number,
  baseY: number,
  facingAngle: number,
  forwardOffset: number,
  playerId: PlayerId,
): Entity[] {
  if (count <= 0) return [];

  const entities: Entity[] = [];
  const cos = Math.cos(facingAngle);
  const sin = Math.sin(facingAngle);
  const perpCos = -sin;
  const perpSin = cos;

  // Total lateral span available = map edge * spread ratio
  const mapEdge = Math.min(world.mapWidth, world.mapHeight);
  const totalSpan = mapEdge * DEMO_CONFIG.lateralSpreadRatio;

  // Spacing between building centers (even distribution across the span)
  const spacing = count > 1 ? totalSpan / (count - 1) : 0;
  const halfSpan = totalSpan / 2;

  for (let i = 0; i < count; i++) {
    const lateral = count > 1 ? i * spacing - halfSpan : 0;
    const wx = baseX + cos * forwardOffset + perpCos * lateral;
    const wy = baseY + sin * forwardOffset + perpSin * lateral;

    const entity = placeCompleteBuilding(world, construction, buildingType, wx, wy, playerId);
    if (entity) entities.push(entity);
  }

  return entities;
}

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
 * Spawn a full base for each player: commander + solar panels + factories.
 * Layout (all positive offsets = toward map center):
 *   spawn point → commander → solar panels → factories (closest to center)
 * Building counts and spacing controlled by DEMO_CONFIG.
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

  const spawnPositions = getSpawnPositions(world, playerIds.length);

  const solarConfig = getBuildingConfig('solar');
  const factoryConfig = getBuildingConfig('factory');

  const cellGap = DEMO_CONFIG.rowGapCells * GRID_CELL_SIZE;
  const commanderGap = DEMO_CONFIG.commanderGapCells * GRID_CELL_SIZE;
  const solarDepth = solarConfig.gridHeight * GRID_CELL_SIZE;
  const factoryDepth = factoryConfig.gridHeight * GRID_CELL_SIZE;

  for (let i = 0; i < playerIds.length; i++) {
    const playerId = playerIds[i];
    const pos = spawnPositions[i];

    // Commander: at spawn point (furthest from center)
    const commander = spawnCommander(world, playerId, pos.x, pos.y, pos.facingAngle);
    entities.push(commander);

    // Solar panels: single row, behind factories
    let offset = commanderGap + solarDepth / 2;
    const solars = placeBuildingRow(
      world, construction, 'solar', DEMO_CONFIG.solarCount,
      pos.x, pos.y, pos.facingAngle,
      offset, playerId,
    );
    entities.push(...solars);

    // Factories: single row, closest to center
    offset += solarDepth / 2 + cellGap + factoryDepth / 2;
    const factories = placeBuildingRow(
      world, construction, 'factory', DEMO_CONFIG.factoryCount,
      pos.x, pos.y, pos.facingAngle,
      offset, playerId,
    );
    entities.push(...factories);
  }

  return entities;
}

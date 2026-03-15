import type { WorldState } from './WorldState';
import type { Entity, PlayerId, BuildingType } from './types';
import type { ConstructionSystem } from './construction';
import { economyManager } from './economy';
import { aimTurretsToward } from './turretInit';
import { getBuildingConfig } from './buildConfigs';
import { GRID_CELL_SIZE } from './grid';

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
  // Radius that nearly touches the edges (leave 100px margin)
  const radius = Math.min(world.mapWidth, world.mapHeight) / 2 - 100;

  const positions: { x: number; y: number; facingAngle: number }[] = [];

  for (let i = 0; i < playerCount; i++) {
    // Distribute evenly around circle, starting from top
    const angle = (i / playerCount) * Math.PI * 2 - Math.PI / 2;
    const x = centerX + Math.cos(angle) * radius;
    const y = centerY + Math.sin(angle) * radius;
    // Face toward center
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

  // Snap to grid
  const snapped = grid.snapToGrid(worldX, worldY, config.gridWidth, config.gridHeight);
  const gx = Math.floor(snapped.x / GRID_CELL_SIZE);
  const gy = Math.floor(snapped.y / GRID_CELL_SIZE);

  if (!grid.canPlace(gx, gy, config.gridWidth, config.gridHeight)) {
    return null;
  }

  const center = grid.getBuildingCenter(gx, gy, config.gridWidth, config.gridHeight);

  // Create building entity directly
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
    const mapCenterX = world.mapWidth / 2;
    const mapCenterY = world.mapHeight / 2;
    const rallyX = center.x + (mapCenterX - center.x) * 0.5;
    const rallyY = center.y + (mapCenterY - center.y) * 0.5;
    entity.factory = {
      buildQueue: [],
      currentBuildProgress: 0,
      currentBuildCost: 0,
      rallyX,
      rallyY,
      isProducing: false,
      waypoints: [{ x: mapCenterX, y: mapCenterY, type: 'fight' }],
    };
  }

  if (buildingType === 'solar' && config.energyProduction) {
    economyManager.addProduction(playerId, config.energyProduction);
  }

  grid.place(gx, gy, config.gridWidth, config.gridHeight, entity.id, playerId);
  world.addEntity(entity);

  return entity;
}

// Place a row of buildings perpendicular to the facing direction at a given forward offset
function placeBuildingRow(
  world: WorldState,
  construction: ConstructionSystem,
  buildingType: BuildingType,
  count: number,
  baseX: number,
  baseY: number,
  facingAngle: number,
  forwardOffset: number,
  lateralSpacing: number,
  playerId: PlayerId,
): Entity[] {
  const entities: Entity[] = [];
  const cos = Math.cos(facingAngle);
  const sin = Math.sin(facingAngle);
  // Perpendicular direction (right of facing)
  const perpCos = -sin;
  const perpSin = cos;

  // Center the row
  const halfWidth = ((count - 1) * lateralSpacing) / 2;

  for (let i = 0; i < count; i++) {
    const lateral = i * lateralSpacing - halfWidth;
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
 * Spawn a full base for each player: commander + factories + solar panels.
 * Layout (relative to facing direction toward center):
 *   - 5 factories in front (closest to center)
 *   - 10 solar panels behind factories (2 rows of 5)
 *   - Commander behind everything (furthest from center)
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

  const factoryConfig = getBuildingConfig('factory');
  const solarConfig = getBuildingConfig('solar');

  // All spacings must be grid-cell-aligned to prevent overlap after snapping
  // Factory: 5w x 4h grid cells. Add 1 cell gap between buildings.
  const factoryLateral = (factoryConfig.gridWidth + 1) * GRID_CELL_SIZE;   // 120px
  const factoryDepth = (factoryConfig.gridHeight + 1) * GRID_CELL_SIZE;    // 100px
  // Solar: 3w x 3h grid cells. Add 1 cell gap.
  const solarLateral = (solarConfig.gridWidth + 1) * GRID_CELL_SIZE;       // 80px
  const solarDepth = (solarConfig.gridHeight + 1) * GRID_CELL_SIZE;        // 80px

  for (let i = 0; i < playerIds.length; i++) {
    const playerId = playerIds[i];
    const pos = spawnPositions[i];

    // Layout from back to front (positive offset = toward map center):
    //   spawn point → commander → solars (2 rows) → factories

    // Commander: at spawn point (furthest from center)
    const commander = spawnCommander(world, playerId, pos.x, pos.y, pos.facingAngle);
    entities.push(commander);

    // Solar row 1: first row toward center
    let offset = solarDepth;
    const solars1 = placeBuildingRow(
      world, construction, 'solar', 5,
      pos.x, pos.y, pos.facingAngle,
      offset, solarLateral, playerId,
    );
    entities.push(...solars1);

    // Solar row 2: second row toward center
    offset += solarDepth;
    const solars2 = placeBuildingRow(
      world, construction, 'solar', 5,
      pos.x, pos.y, pos.facingAngle,
      offset, solarLateral, playerId,
    );
    entities.push(...solars2);

    // Factories: 5 in a row, closest to center (in front of solars)
    offset += solarDepth / 2 + factoryDepth / 2;
    const factories = placeBuildingRow(
      world, construction, 'factory', 5,
      pos.x, pos.y, pos.facingAngle,
      offset, factoryLateral, playerId,
    );
    entities.push(...factories);
  }

  return entities;
}

import type { WorldState } from './WorldState';
import type { Entity, PlayerId } from './types';
import { economyManager } from './economy';
import { COMMANDER_CONFIG, UNIT_BUILD_CONFIGS } from './buildConfigs';

// Unit composition for each player - all unit types
interface UnitSpawnConfig {
  weaponId: string;
  count: number;
}

// Include all 7 unit types
const PLAYER_UNIT_COMPOSITION: UnitSpawnConfig[] = [
  { weaponId: 'minigun', count: 2 },
  { weaponId: 'laser', count: 2 },
  { weaponId: 'cannon', count: 1 },
  { weaponId: 'shotgun', count: 2 },
  { weaponId: 'grenade', count: 1 },
  { weaponId: 'railgun', count: 1 },
  { weaponId: 'burstRifle', count: 2 },
];

// Spawn a commander for a player
function spawnCommander(
  world: WorldState,
  playerId: PlayerId,
  x: number,
  y: number,
  facingAngle: number
): Entity {
  const commander = world.createCommander(x, y, playerId, COMMANDER_CONFIG);
  commander.transform.rotation = facingAngle;
  world.addEntity(commander);
  return commander;
}

// Spawn units for a player in a formation
function spawnPlayerUnits(
  world: WorldState,
  playerId: PlayerId,
  centerX: number,
  centerY: number,
  facingAngle: number
): Entity[] {
  const entities: Entity[] = [];
  const spacing = 50;
  let unitIndex = 0;

  for (const config of PLAYER_UNIT_COMPOSITION) {
    const unitConfig = UNIT_BUILD_CONFIGS[config.weaponId];
    if (!unitConfig) continue;

    for (let i = 0; i < config.count; i++) {
      // Arrange in a grid formation
      const row = Math.floor(unitIndex / 4);
      const col = unitIndex % 4;

      // Offset from center
      const localX = (col - 1.5) * spacing;
      const localY = row * spacing;

      // Rotate based on facing angle
      const cos = Math.cos(facingAngle);
      const sin = Math.sin(facingAngle);
      const rotatedX = localX * cos - localY * sin;
      const rotatedY = localX * sin + localY * cos;

      const x = centerX + rotatedX;
      const y = centerY + rotatedY;

      const unit = world.createUnit(
        x,
        y,
        playerId,
        config.weaponId,
        unitConfig.radius,
        unitConfig.moveSpeed
      );

      // Set HP from config
      if (unit.unit) {
        unit.unit.hp = unitConfig.hp;
        unit.unit.maxHp = unitConfig.hp;
      }

      // Set initial rotation to face the enemy
      unit.transform.rotation = facingAngle;

      world.addEntity(unit);
      entities.push(unit);
      unitIndex++;
    }
  }

  return entities;
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

// Spawn initial entities for the game with N players
export function spawnInitialEntities(world: WorldState, playerIds: PlayerId[] = [1, 2]): Entity[] {
  const entities: Entity[] = [];

  // Set player count for unit cap calculation
  world.playerCount = playerIds.length;

  // Initialize economy for all players
  for (const playerId of playerIds) {
    economyManager.initPlayer(playerId);
  }

  // Get spawn positions on circle
  const spawnPositions = getSpawnPositions(world, playerIds.length);

  // Spawn commander for each player
  for (let i = 0; i < playerIds.length; i++) {
    const playerId = playerIds[i];
    const pos = spawnPositions[i];

    const commander = spawnCommander(world, playerId, pos.x, pos.y, pos.facingAngle);
    entities.push(commander);
  }

  return entities;
}

// Spawn initial entities with test units (for debugging/testing)
export function spawnInitialEntitiesWithUnits(world: WorldState): Entity[] {
  const entities: Entity[] = [];

  // Initialize economy for both players
  economyManager.initPlayer(1);
  economyManager.initPlayer(2);

  // Player 1 Commander (Blue) - left side
  const commander1 = spawnCommander(
    world,
    1,
    200,
    world.mapHeight / 2,
    0
  );
  entities.push(commander1);

  // Player 1 units - behind commander
  const player1Units = spawnPlayerUnits(
    world,
    1,
    350, // centerX
    world.mapHeight / 2, // centerY
    0 // facing right
  );
  entities.push(...player1Units);

  // Player 2 Commander (Red) - right side
  const commander2 = spawnCommander(
    world,
    2,
    world.mapWidth - 200,
    world.mapHeight / 2,
    Math.PI
  );
  entities.push(commander2);

  // Player 2 units - behind commander
  const player2Units = spawnPlayerUnits(
    world,
    2,
    world.mapWidth - 350, // centerX
    world.mapHeight / 2, // centerY
    Math.PI // facing left
  );
  entities.push(...player2Units);

  return entities;
}

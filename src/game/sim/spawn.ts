import type { WorldState } from './WorldState';
import type { Entity, PlayerId } from './types';
import { economyManager } from './economy';
import { COMMANDER_CONFIG } from './buildConfigs';

// Unit composition for each player (legacy - now only used for testing)
interface UnitSpawnConfig {
  weaponId: string;
  count: number;
  radius?: number;
  moveSpeed?: number;
}

const PLAYER_UNIT_COMPOSITION: UnitSpawnConfig[] = [
  { weaponId: 'minigun', count: 3, radius: 12, moveSpeed: 120 },
  { weaponId: 'laser', count: 2, radius: 14, moveSpeed: 100 },
  { weaponId: 'cannon', count: 2, radius: 16, moveSpeed: 80 },
  { weaponId: 'shotgun', count: 2, radius: 13, moveSpeed: 110 },
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

// Spawn units for a player in a formation (legacy - for testing)
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
        config.radius ?? 15,
        config.moveSpeed ?? 100
      );

      // Set initial rotation to face the enemy
      unit.transform.rotation = facingAngle;

      world.addEntity(unit);
      entities.push(unit);
      unitIndex++;
    }
  }

  return entities;
}

// Spawn initial entities for the game
export function spawnInitialEntities(world: WorldState): Entity[] {
  const entities: Entity[] = [];

  // Initialize economy for both players
  economyManager.initPlayer(1);
  economyManager.initPlayer(2);

  // Player 1 Commander (Blue) - left side, facing right
  const commander1 = spawnCommander(
    world,
    1,
    500, // x - closer to center for quicker engagement
    world.mapHeight / 2, // y
    0 // facing right
  );
  entities.push(commander1);

  // Player 2 Commander (Red) - right side, facing left
  const commander2 = spawnCommander(
    world,
    2,
    world.mapWidth - 500, // x - closer to center for quicker engagement
    world.mapHeight / 2, // y
    Math.PI // facing left
  );
  entities.push(commander2);

  // Note: Neutral buildings removed - players will build their own structures

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

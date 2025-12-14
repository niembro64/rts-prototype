import type { WorldState } from './WorldState';
import type { Entity, PlayerId } from './types';

// Unit composition for each player
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

  // Player 1 units (Blue) - left side, facing right
  const player1Units = spawnPlayerUnits(
    world,
    1,
    300, // centerX
    world.mapHeight / 2, // centerY
    0 // facing right
  );
  entities.push(...player1Units);

  // Player 2 units (Red) - right side, facing left
  const player2Units = spawnPlayerUnits(
    world,
    2,
    world.mapWidth - 300, // centerX
    world.mapHeight / 2, // centerY
    Math.PI // facing left
  );
  entities.push(...player2Units);

  // Spawn some neutral buildings (obstacles)
  const buildings = [
    { x: world.mapWidth / 2, y: world.mapHeight / 2 - 200, w: 100, h: 80 },
    { x: world.mapWidth / 2, y: world.mapHeight / 2 + 200, w: 100, h: 80 },
    { x: world.mapWidth / 2 - 300, y: world.mapHeight / 2, w: 60, h: 120 },
    { x: world.mapWidth / 2 + 300, y: world.mapHeight / 2, w: 60, h: 120 },
  ];

  for (const b of buildings) {
    const building = world.createBuilding(b.x, b.y, b.w, b.h);
    world.addEntity(building);
    entities.push(building);
  }

  return entities;
}

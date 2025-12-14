import type { WorldState } from './WorldState';
import type { Entity } from './types';

// Spawn initial entities for the game
export function spawnInitialEntities(world: WorldState): Entity[] {
  const entities: Entity[] = [];

  // Spawn some units in a cluster
  const unitCount = 8;
  const centerX = 300;
  const centerY = 300;
  const spread = 80;

  for (let i = 0; i < unitCount; i++) {
    const angle = (i / unitCount) * Math.PI * 2;
    const radius = spread * (0.5 + world.rng.next() * 0.5);
    const x = centerX + Math.cos(angle) * radius;
    const y = centerY + Math.sin(angle) * radius;

    const unit = world.createUnit(x, y, 15, 120);
    world.addEntity(unit);
    entities.push(unit);
  }

  // Spawn a second group of units
  const group2Count = 5;
  const group2CenterX = 600;
  const group2CenterY = 400;

  for (let i = 0; i < group2Count; i++) {
    const angle = (i / group2Count) * Math.PI * 2;
    const radius = 60 * (0.5 + world.rng.next() * 0.5);
    const x = group2CenterX + Math.cos(angle) * radius;
    const y = group2CenterY + Math.sin(angle) * radius;

    const unit = world.createUnit(x, y, 12, 150);
    world.addEntity(unit);
    entities.push(unit);
  }

  // Spawn some buildings (obstacles)
  const buildings = [
    { x: 500, y: 200, w: 80, h: 60 },
    { x: 800, y: 500, w: 100, h: 100 },
    { x: 200, y: 600, w: 60, h: 120 },
    { x: 1000, y: 300, w: 120, h: 80 },
    { x: 400, y: 800, w: 150, h: 50 },
    { x: 1200, y: 700, w: 80, h: 80 },
    { x: 700, y: 1000, w: 100, h: 60 },
    { x: 1500, y: 400, w: 90, h: 90 },
  ];

  for (const b of buildings) {
    const building = world.createBuilding(b.x, b.y, b.w, b.h);
    world.addEntity(building);
    entities.push(building);
  }

  return entities;
}

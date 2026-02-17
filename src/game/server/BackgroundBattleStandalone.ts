// Background battle spawning logic (standalone Matter.js, no Phaser)

import type Matter from 'matter-js';
import type { Entity, PlayerId } from '../sim/types';
import type { WorldState } from '../sim/WorldState';
import { createWeaponsFromDefinition } from '../sim/unitDefinitions';
import { aimTurretsToward } from '../sim/turretInit';
import { createUnitBodyStandalone, toPhaserBody } from './PhysicsStandalone';
import {
  UNIT_STATS,
  MAX_TOTAL_UNITS,
  BACKGROUND_SPAWN_INVERSE_COST_WEIGHTING,
} from '../../config';

// Available unit types for background spawning
const BACKGROUND_UNIT_TYPES = Object.keys(UNIT_STATS) as (keyof typeof UNIT_STATS)[];

// Precomputed inverse cost weights for weighted random selection
let backgroundUnitWeights: { type: keyof typeof UNIT_STATS; weight: number }[] = [];
let backgroundTotalWeight: number = 0;

function initBackgroundUnitWeights(): void {
  if (backgroundUnitWeights.length > 0) return;

  for (const unitType of BACKGROUND_UNIT_TYPES) {
    const cost = UNIT_STATS[unitType].baseCost;
    const weight = 1 / cost;
    backgroundUnitWeights.push({ type: unitType, weight });
    backgroundTotalWeight += weight;
  }
}

function selectWeightedUnitType(): keyof typeof UNIT_STATS {
  initBackgroundUnitWeights();

  const random = Math.random() * backgroundTotalWeight;
  let cumulative = 0;

  for (const entry of backgroundUnitWeights) {
    cumulative += entry.weight;
    if (random <= cumulative) {
      return entry.type;
    }
  }

  return backgroundUnitWeights[backgroundUnitWeights.length - 1].type;
}

// Spawn a single background unit with standalone physics
function spawnBackgroundUnitStandalone(
  world: WorldState,
  engine: Matter.Engine,
  playerId: PlayerId,
  minX: number,
  maxX: number,
  minY: number,
  maxY: number,
  targetMinX: number,
  targetMaxX: number,
  targetMinY: number,
  targetMaxY: number,
  initialRotation: number
): Entity | null {
  const x = minX + Math.random() * (maxX - minX);
  const y = minY + Math.random() * (maxY - minY);

  const unitType = BACKGROUND_SPAWN_INVERSE_COST_WEIGHTING
    ? selectWeightedUnitType()
    : BACKGROUND_UNIT_TYPES[Math.floor(Math.random() * BACKGROUND_UNIT_TYPES.length)];
  const stats = UNIT_STATS[unitType];

  const unit = world.createUnitBase(
    x,
    y,
    playerId,
    unitType,
    stats.collisionRadius,
    stats.moveSpeed,
    stats.mass,
    stats.hp
  );
  unit.weapons = createWeaponsFromDefinition(unitType, stats.collisionRadius);

  unit.transform.rotation = initialRotation;
  aimTurretsToward(unit, world.mapWidth / 2, world.mapHeight / 2);

  const targetX = targetMinX + Math.random() * (targetMaxX - targetMinX);
  const targetY = targetMinY + Math.random() * (targetMaxY - targetMinY);

  if (unit.unit) {
    unit.unit.actions = [{
      type: 'fight',
      x: targetX,
      y: targetY,
    }];
  }

  world.addEntity(unit);

  if (unit.unit) {
    const body = createUnitBodyStandalone(
      engine,
      x,
      y,
      unit.unit.collisionRadius,
      unit.unit.mass,
      `unit_${unit.id}`
    );
    unit.body = { matterBody: toPhaserBody(body) };
  }

  return unit;
}

// Spawn units for the background battle (4 players)
export function spawnBackgroundUnitsStandalone(
  world: WorldState,
  engine: Matter.Engine,
  initialSpawn: boolean
): Entity[] {
  const spawned: Entity[] = [];
  const numPlayers = 4;
  const unitCapPerPlayer = Math.floor(MAX_TOTAL_UNITS / numPlayers);
  const spawnMargin = 100;
  const mapWidth = world.mapWidth;
  const mapHeight = world.mapHeight;

  const unitsToSpawnPerPlayer = initialSpawn ? Math.min(15, unitCapPerPlayer) : 1;

  // Player 1 (Red) - top of map, moving down
  const player1Units = world.getUnitsByPlayer(1).length;
  for (let i = 0; i < unitsToSpawnPerPlayer && player1Units + i < unitCapPerPlayer; i++) {
    const unit = spawnBackgroundUnitStandalone(world, engine, 1,
      spawnMargin, mapWidth - spawnMargin, spawnMargin, spawnMargin,
      spawnMargin, mapWidth - spawnMargin, mapHeight - spawnMargin, mapHeight,
      Math.PI / 2
    );
    if (unit) spawned.push(unit);
  }

  // Player 2 (Blue) - bottom of map, moving up
  const player2Units = world.getUnitsByPlayer(2).length;
  for (let i = 0; i < unitsToSpawnPerPlayer && player2Units + i < unitCapPerPlayer; i++) {
    const unit = spawnBackgroundUnitStandalone(world, engine, 2,
      spawnMargin, mapWidth - spawnMargin, mapHeight - spawnMargin, mapHeight,
      spawnMargin, mapWidth - spawnMargin, spawnMargin, spawnMargin,
      -Math.PI / 2
    );
    if (unit) spawned.push(unit);
  }

  // Player 3 (Yellow) - left of map, moving right
  const player3Units = world.getUnitsByPlayer(3).length;
  for (let i = 0; i < unitsToSpawnPerPlayer && player3Units + i < unitCapPerPlayer; i++) {
    const unit = spawnBackgroundUnitStandalone(world, engine, 3,
      spawnMargin, spawnMargin, spawnMargin, mapHeight - spawnMargin,
      mapWidth - spawnMargin, mapWidth, spawnMargin, mapHeight - spawnMargin,
      0
    );
    if (unit) spawned.push(unit);
  }

  // Player 4 (Green) - right of map, moving left
  const player4Units = world.getUnitsByPlayer(4).length;
  for (let i = 0; i < unitsToSpawnPerPlayer && player4Units + i < unitCapPerPlayer; i++) {
    const unit = spawnBackgroundUnitStandalone(world, engine, 4,
      mapWidth - spawnMargin, mapWidth, spawnMargin, mapHeight - spawnMargin,
      spawnMargin, spawnMargin, spawnMargin, mapHeight - spawnMargin,
      Math.PI
    );
    if (unit) spawned.push(unit);
  }

  return spawned;
}

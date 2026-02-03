// Background battle spawning logic

import type Phaser from 'phaser';
import type { Entity, PlayerId } from '../../sim/types';
import type { WorldState } from '../../sim/WorldState';
import { createWeaponsFromDefinition } from '../../sim/unitDefinitions';
import { createUnitBody } from './PhysicsHelpers';
import {
  UNIT_STATS,
  MAX_TOTAL_UNITS,
  BACKGROUND_SPAWN_INVERSE_COST_WEIGHTING,
} from '../../../config';

// Available unit types for background spawning
const BACKGROUND_UNIT_TYPES = Object.keys(UNIT_STATS) as (keyof typeof UNIT_STATS)[];

// Precomputed inverse cost weights for weighted random selection
let backgroundUnitWeights: { type: keyof typeof UNIT_STATS; weight: number }[] = [];
let backgroundTotalWeight: number = 0;

// Initialize background unit weights (call once)
function initBackgroundUnitWeights(): void {
  if (backgroundUnitWeights.length > 0) return; // Already initialized

  // Calculate inverse cost weights: weight = 1 / cost
  // This makes cheaper units spawn more frequently
  for (const unitType of BACKGROUND_UNIT_TYPES) {
    const cost = UNIT_STATS[unitType].baseCost;
    const weight = 1 / cost;
    backgroundUnitWeights.push({ type: unitType, weight });
    backgroundTotalWeight += weight;
  }
}

// Select a random unit type based on inverse cost weighting
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

  // Fallback (shouldn't reach here)
  return backgroundUnitWeights[backgroundUnitWeights.length - 1].type;
}

// Spawn a single background unit with a fight waypoint to opposite side
export function spawnBackgroundUnit(
  world: WorldState,
  matter: Phaser.Physics.Matter.MatterPhysics,
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
  // Random position within spawn area
  const x = minX + Math.random() * (maxX - minX);
  const y = minY + Math.random() * (maxY - minY);

  // Select unit type based on config (weighted by inverse cost or flat distribution)
  const unitType = BACKGROUND_SPAWN_INVERSE_COST_WEIGHTING
    ? selectWeightedUnitType()
    : BACKGROUND_UNIT_TYPES[Math.floor(Math.random() * BACKGROUND_UNIT_TYPES.length)];
  const stats = UNIT_STATS[unitType];

  // Create the unit using base method and set weapons for this unit type
  const unit = world.createUnitBase(
    x,
    y,
    playerId,
    stats.collisionRadius,
    stats.moveSpeed,
    stats.mass,
    stats.hp
  );
  unit.weapons = createWeaponsFromDefinition(unitType, stats.collisionRadius);

  // Set initial rotation
  unit.transform.rotation = initialRotation;

  // Add fight waypoint to opposite side of map
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

  // Create physics body with proper mass
  if (unit.unit) {
    const body = createUnitBody(
      matter,
      x,
      y,
      unit.unit.collisionRadius,
      unit.unit.mass,
      `unit_${unit.id}`
    );
    unit.body = { matterBody: body };
  }

  return unit;
}

// Spawn units for the background battle (4 players: Red, Blue, Yellow, Green)
export function spawnBackgroundUnits(
  world: WorldState,
  matter: Phaser.Physics.Matter.MatterPhysics,
  initialSpawn: boolean
): void {
  const numPlayers = 4;
  const unitCapPerPlayer = Math.floor(MAX_TOTAL_UNITS / numPlayers);
  const spawnMargin = 100; // Distance from map edge for spawning
  const mapWidth = world.mapWidth;
  const mapHeight = world.mapHeight;

  // How many to spawn this cycle per player
  const unitsToSpawnPerPlayer = initialSpawn ? Math.min(15, unitCapPerPlayer) : 1;

  // Player 1 (Red) - top of map, moving down
  const player1Units = world.getUnitsByPlayer(1).length;
  for (let i = 0; i < unitsToSpawnPerPlayer && player1Units + i < unitCapPerPlayer; i++) {
    spawnBackgroundUnit(world, matter, 1,
      spawnMargin, mapWidth - spawnMargin, spawnMargin, spawnMargin, // spawn at top
      spawnMargin, mapWidth - spawnMargin, mapHeight - spawnMargin, mapHeight, // target bottom
      Math.PI / 2 // facing down
    );
  }

  // Player 2 (Blue) - bottom of map, moving up
  const player2Units = world.getUnitsByPlayer(2).length;
  for (let i = 0; i < unitsToSpawnPerPlayer && player2Units + i < unitCapPerPlayer; i++) {
    spawnBackgroundUnit(world, matter, 2,
      spawnMargin, mapWidth - spawnMargin, mapHeight - spawnMargin, mapHeight, // spawn at bottom
      spawnMargin, mapWidth - spawnMargin, spawnMargin, spawnMargin, // target top
      -Math.PI / 2 // facing up
    );
  }

  // Player 3 (Yellow) - left of map, moving right
  const player3Units = world.getUnitsByPlayer(3).length;
  for (let i = 0; i < unitsToSpawnPerPlayer && player3Units + i < unitCapPerPlayer; i++) {
    spawnBackgroundUnit(world, matter, 3,
      spawnMargin, spawnMargin, spawnMargin, mapHeight - spawnMargin, // spawn at left
      mapWidth - spawnMargin, mapWidth, spawnMargin, mapHeight - spawnMargin, // target right
      0 // facing right
    );
  }

  // Player 4 (Green) - right of map, moving left
  const player4Units = world.getUnitsByPlayer(4).length;
  for (let i = 0; i < unitsToSpawnPerPlayer && player4Units + i < unitCapPerPlayer; i++) {
    spawnBackgroundUnit(world, matter, 4,
      mapWidth - spawnMargin, mapWidth, spawnMargin, mapHeight - spawnMargin, // spawn at right
      spawnMargin, spawnMargin, spawnMargin, mapHeight - spawnMargin, // target left
      Math.PI // facing left
    );
  }
}

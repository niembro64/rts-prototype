// Background battle spawning logic (standalone physics, no Phaser)

import type { Entity, PlayerId } from '../sim/types';
import type { WorldState } from '../sim/WorldState';
import { aimTurretsToward } from '../sim/turretInit';
import type { IPhysicsEngine as PhysicsEngine } from './IPhysicsEngine';
import { BUILDABLE_UNIT_IDS, getUnitBlueprint } from '../sim/blueprints';
import {
  BACKGROUND_SPAWN_INVERSE_COST_WEIGHTING,
} from '../../config';
import { DEMO_CONFIG } from '../../demoConfig';

// Available unit types for background spawning (excludes commander)
export const BACKGROUND_UNIT_TYPES = [...BUILDABLE_UNIT_IDS];

// Pre-computed inverse-cost weights for background unit selection
let backgroundUnitWeights: { type: string; cumWeight: number }[] = [];

function buildWeightTable(allowedTypes?: ReadonlySet<string>): void {
  const types = allowedTypes ? BACKGROUND_UNIT_TYPES.filter(t => allowedTypes.has(t)) : BACKGROUND_UNIT_TYPES;
  let totalWeight = 0;
  backgroundUnitWeights = [];
  for (const t of types) {
    const bp = getUnitBlueprint(t);
    const cost = bp?.baseCost ?? 100;
    const weight = 1 / Math.max(cost, 1);
    totalWeight += weight;
    backgroundUnitWeights.push({ type: t, cumWeight: totalWeight });
  }
  // Normalize
  for (const entry of backgroundUnitWeights) {
    entry.cumWeight /= totalWeight;
  }
}

function selectWeightedUnitType(allowedTypes?: ReadonlySet<string>): string {
  if (backgroundUnitWeights.length === 0) buildWeightTable(allowedTypes);
  const r = Math.random();
  for (const entry of backgroundUnitWeights) {
    if (r <= entry.cumWeight) return entry.type;
  }
  return backgroundUnitWeights[backgroundUnitWeights.length - 1].type;
}

function selectUnitType(allowedTypes?: ReadonlySet<string>): string {
  if (BACKGROUND_SPAWN_INVERSE_COST_WEIGHTING) {
    return selectWeightedUnitType(allowedTypes);
  } else if (allowedTypes && allowedTypes.size > 0) {
    const allowed = Array.from(allowedTypes);
    return allowed[Math.floor(Math.random() * allowed.length)];
  }
  return BACKGROUND_UNIT_TYPES[Math.floor(Math.random() * BACKGROUND_UNIT_TYPES.length)];
}

// Spawn a single unit at a specific position with a fight waypoint
function spawnUnit(
  world: WorldState,
  physics: PhysicsEngine,
  playerId: PlayerId,
  x: number,
  y: number,
  targetX: number,
  targetY: number,
  allowedTypes?: ReadonlySet<string>,
): Entity | null {
  if (allowedTypes && allowedTypes.size === 0) return null;

  const unitType = selectUnitType(allowedTypes);
  const unit = world.createUnitFromBlueprint(x, y, playerId, unitType);

  unit.transform.rotation = Math.atan2(targetY - y, targetX - x);
  aimTurretsToward(unit, targetX, targetY);

  if (unit.unit) {
    unit.unit.actions = [{ type: 'fight', x: targetX, y: targetY }];
  }

  world.addEntity(unit);

  if (unit.unit) {
    const body = physics.createUnitBody(
      x, y,
      unit.unit.radiusColliderUnitUnit,
      unit.unit.mass,
      `unit_${unit.id}`,
    );
    unit.body = { physicsBody: body };
  }

  return unit;
}

// Spawn units for the background battle (4 players)
export function spawnBackgroundUnitsStandalone(
  world: WorldState,
  physics: PhysicsEngine,
  initialSpawn: boolean,
  allowedTypes?: ReadonlySet<string>,
): Entity[] {
  const spawned: Entity[] = [];
  const numPlayers = 4;
  const unitCapPerPlayer = Math.floor(world.maxTotalUnits / numPlayers);
  const mapWidth = world.mapWidth;
  const mapHeight = world.mapHeight;
  const cx = mapWidth / 2;
  const cy = mapHeight / 2;

  if (initialSpawn) {
    // Spawn all initial units near the center for immediate combat.
    // Each player's units cluster in their quadrant of the center area.
    const centerRadius = DEMO_CONFIG.centerSpawnRadius;
    const totalPerPlayer = DEMO_CONFIG.centerSpawnPerPlayer;

    // Player spawn angles (same as base positions: evenly around circle)
    const playerAngles: number[] = [];
    for (let i = 0; i < numPlayers; i++) {
      playerAngles.push((i / numPlayers) * Math.PI * 2 - Math.PI / 2);
    }

    for (let p = 0; p < numPlayers; p++) {
      const playerId = (p + 1) as PlayerId;
      const pUnits = world.getUnitsByPlayer(playerId).length;
      const angle = playerAngles[p];
      // Each player's cluster is offset slightly from center toward their base
      const clusterCx = cx + Math.cos(angle) * centerRadius * 0.3;
      const clusterCy = cy + Math.sin(angle) * centerRadius * 0.3;

      for (let i = 0; i < totalPerPlayer && pUnits + i < unitCapPerPlayer; i++) {
        // Random position within the cluster
        const spawnAngle = Math.random() * Math.PI * 2;
        const spawnDist = Math.random() * centerRadius;
        const spawnX = clusterCx + Math.cos(spawnAngle) * spawnDist;
        const spawnY = clusterCy + Math.sin(spawnAngle) * spawnDist;

        // Fight waypoint: toward map center
        const unit = spawnUnit(world, physics, playerId, spawnX, spawnY, cx, cy, allowedTypes);
        if (unit) spawned.push(unit);
      }
    }
  } else {
    // Reinforcement spawns: one unit per player from their base side, heading to center
    const spawnMargin = 100;
    const playerEdges = [
      // Player 1: top edge
      { minX: spawnMargin, maxX: mapWidth - spawnMargin, minY: spawnMargin, maxY: spawnMargin + 50 },
      // Player 2: bottom edge
      { minX: spawnMargin, maxX: mapWidth - spawnMargin, minY: mapHeight - spawnMargin - 50, maxY: mapHeight - spawnMargin },
      // Player 3: left edge
      { minX: spawnMargin, maxX: spawnMargin + 50, minY: spawnMargin, maxY: mapHeight - spawnMargin },
      // Player 4: right edge
      { minX: mapWidth - spawnMargin - 50, maxX: mapWidth - spawnMargin, minY: spawnMargin, maxY: mapHeight - spawnMargin },
    ];

    for (let p = 0; p < numPlayers; p++) {
      const playerId = (p + 1) as PlayerId;
      const pUnits = world.getUnitsByPlayer(playerId).length;
      if (pUnits >= unitCapPerPlayer) continue;

      const edge = playerEdges[p];
      const x = edge.minX + Math.random() * (edge.maxX - edge.minX);
      const y = edge.minY + Math.random() * (edge.maxY - edge.minY);

      const unit = spawnUnit(world, physics, playerId, x, y, cx, cy, allowedTypes);
      if (unit) spawned.push(unit);
    }
  }

  return spawned;
}

// Background battle spawning logic (standalone physics, no Phaser)

import type { Entity, PlayerId } from '../sim/types';
import type { WorldState } from '../sim/WorldState';
import { aimTurretsToward } from '../sim/turretInit';
import type { PhysicsEngine3D as PhysicsEngine } from './PhysicsEngine3D';
import { BUILDABLE_UNIT_IDS, getUnitBlueprint, getNormalizedUnitCost } from '../sim/blueprints';
import {
  BACKGROUND_SPAWN_INVERSE_COST_WEIGHTING,
} from '../../config';
import { DEMO_CONFIG } from '../../demoConfig';
import { getPlayerBaseAngle } from '../sim/spawn';

// Available unit types for background spawning (excludes commander)
export const BACKGROUND_UNIT_TYPES = [...BUILDABLE_UNIT_IDS];

// Pre-computed inverse-cost weights for background unit selection.
// Cached across spawn calls but RE-BUILT whenever the allowedTypes
// signature changes — without this the original lazy cache would
// keep picking from a stale type list after a toggle, then those
// disallowed units would get wiped a tick later by the toggle
// handler in GameServer.setBackgroundUnitTypeEnabled (which gave
// the "spawning then despawning the wrong unit" behaviour).
let backgroundUnitWeights: { type: string; cumWeight: number }[] = [];
let cachedWeightSignature = '';

/** Stable string signature for an allowedTypes set. Sorting keeps
 *  signature equality independent of insertion order. */
function signatureFor(allowedTypes?: ReadonlySet<string>): string {
  if (!allowedTypes) return '*';
  if (allowedTypes.size === 0) return '∅';
  return [...allowedTypes].sort().join('|');
}

function ensureWeightTable(allowedTypes?: ReadonlySet<string>): void {
  const sig = signatureFor(allowedTypes);
  if (sig === cachedWeightSignature && backgroundUnitWeights.length > 0) return;
  cachedWeightSignature = sig;

  const types = allowedTypes
    ? BACKGROUND_UNIT_TYPES.filter(t => allowedTypes.has(t))
    : BACKGROUND_UNIT_TYPES;
  let totalWeight = 0;
  backgroundUnitWeights = [];
  for (const t of types) {
    const bp = getUnitBlueprint(t);
    const cost = getNormalizedUnitCost(bp);
    const weight = 1 / Math.max(cost, 0.01);
    totalWeight += weight;
    backgroundUnitWeights.push({ type: t, cumWeight: totalWeight });
  }
  // Normalize cumulative weights to [0, 1] for the random pick.
  if (totalWeight > 0) {
    for (const entry of backgroundUnitWeights) {
      entry.cumWeight /= totalWeight;
    }
  }
}

function selectWeightedUnitType(allowedTypes?: ReadonlySet<string>): string | null {
  ensureWeightTable(allowedTypes);
  if (backgroundUnitWeights.length === 0) return null;
  const r = Math.random();
  for (const entry of backgroundUnitWeights) {
    if (r <= entry.cumWeight) return entry.type;
  }
  return backgroundUnitWeights[backgroundUnitWeights.length - 1].type;
}

function selectUnitType(allowedTypes?: ReadonlySet<string>): string | null {
  // No allowed types → caller will skip the spawn.
  if (allowedTypes && allowedTypes.size === 0) return null;
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
  // Defensive: only ever spawn from the allowed-types set. If
  // selectUnitType signalled "nothing valid" (empty set, weight
  // table empty after rebuild), skip the spawn entirely instead of
  // creating a unit that would be wiped by the toggle handler a
  // tick later.
  if (!unitType) return null;
  const unit = world.createUnitFromBlueprint(x, y, playerId, unitType);

  unit.transform.rotation = Math.atan2(targetY - y, targetX - x);
  aimTurretsToward(unit, targetX, targetY);

  if (unit.unit) {
    // 'fight' (not plain 'move'): demo units engage targets en route
    // to the waypoint instead of running blind through the contact
    // line. Lining up with the factory rally so initial units and
    // factory-spawned units share behaviour.
    unit.unit.actions = [{ type: 'fight', x: targetX, y: targetY }];
  }

  world.addEntity(unit);

  if (unit.unit) {
    const body = physics.createUnitBody(
      x, y,
      unit.unit.unitRadiusCollider.push,
      unit.unit.mass,
      `unit_${unit.id}`,
    );
    unit.body = { physicsBody: body };
  }

  return unit;
}

// Spawn units for the background battle. Teams + their angular bands
// on the spawn circle come from DEMO_CONFIG so 3-vs-3 (or 2-vs-2, 4-vs-4)
// works without code changes.
export function spawnBackgroundUnitsStandalone(
  world: WorldState,
  physics: PhysicsEngine,
  initialSpawn: boolean,
  allowedTypes?: ReadonlySet<string>,
): Entity[] {
  const spawned: Entity[] = [];
  const numPlayers = DEMO_CONFIG.playerCount;
  const unitCapPerPlayer = Math.floor(world.maxTotalUnits / numPlayers);
  const mapWidth = world.mapWidth;
  const mapHeight = world.mapHeight;
  const cx = mapWidth / 2;
  const cy = mapHeight / 2;

  // Each team's angular position on the spawn circle (matches the layout
  // used for commanders / solars / factories in spawn.ts).
  const baseAngles: number[] = [];
  for (let p = 0; p < numPlayers; p++) {
    baseAngles.push(getPlayerBaseAngle(p, numPlayers));
  }

  if (initialSpawn) {
    // All teams' initial units spawn at random positions inside a
    // single circle around the map center (uniform area density via
    // sqrt-sample). Each unit's fight waypoint is the diametrically
    // opposite point through the center, so the units from every team
    // intermix on launch and converge through the middle — the
    // characteristic demo-battle clash.
    const centerRadius = DEMO_CONFIG.centerSpawnRadius * mapHeight;
    const totalPerPlayer = DEMO_CONFIG.centerSpawnPerPlayer;

    for (let p = 0; p < numPlayers; p++) {
      const playerId = (p + 1) as PlayerId;
      const pUnits = world.getUnitsByPlayer(playerId).length;

      for (let i = 0; i < totalPerPlayer && pUnits + i < unitCapPerPlayer; i++) {
        const spawnAngle = Math.random() * Math.PI * 2;
        const spawnDist = Math.sqrt(Math.random()) * centerRadius;
        const spawnX = cx + Math.cos(spawnAngle) * spawnDist;
        const spawnY = cy + Math.sin(spawnAngle) * spawnDist;

        // Fight waypoint = diametrically opposite point through center.
        const targetX = cx - (spawnX - cx);
        const targetY = cy - (spawnY - cy);

        const unit = spawnUnit(world, physics, playerId, spawnX, spawnY, targetX, targetY, allowedTypes);
        if (unit) spawned.push(unit);
      }
    }
  } else {
    // Reinforcements: one unit per team at their base sector arc, heading
    // toward map center. Same angular layout as the initial spawn.
    const spawnRadius = DEMO_CONFIG.centerSpawnRadius * mapHeight;
    const sectorAngle = (2 * Math.PI / numPlayers) * DEMO_CONFIG.centerSpawnSectorFraction;

    for (let p = 0; p < numPlayers; p++) {
      const playerId = (p + 1) as PlayerId;
      const pUnits = world.getUnitsByPlayer(playerId).length;
      if (pUnits >= unitCapPerPlayer) continue;

      const offsetAngle = (Math.random() - 0.5) * sectorAngle;
      const a = baseAngles[p] + offsetAngle;
      const r = spawnRadius * (0.85 + Math.random() * 0.15);
      const x = cx + Math.cos(a) * r;
      const y = cy + Math.sin(a) * r;

      const unit = spawnUnit(world, physics, playerId, x, y, cx, cy, allowedTypes);
      if (unit) spawned.push(unit);
    }
  }

  return spawned;
}

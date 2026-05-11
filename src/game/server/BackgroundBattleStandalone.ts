// Background battle spawning logic (standalone physics, no Phaser)

import type { Entity, PlayerId } from '../sim/types';
import type { WorldState } from '../sim/WorldState';
import { aimTurretsToward } from '../sim/turretInit';
import type { PhysicsEngine3D as PhysicsEngine } from './PhysicsEngine3D';
import { BUILDABLE_UNIT_IDS, getUnitBlueprint, getNormalizedUnitCost } from '../sim/blueprints';
import {
  BACKGROUND_SPAWN_INVERSE_COST_WEIGHTING,
} from '../../config';
import { DEMO_CONFIG, type DemoBattleWaypointType } from '../../demoConfig';
import { getPlayerBaseAngle, normalizePlayerIds } from '../sim/playerLayout';
import { isFarFromWater } from '../sim/Terrain';
import { makeMapOvalMetrics, mapOvalPointAt } from '../sim/mapOval';
import { expandPathActions } from '../sim/Pathfinder';
import { setUnitActions } from '../sim/unitActions';
import type { BuildingGrid } from '../sim/buildGrid';
import { createPhysicsBodyForUnit } from './unitPhysicsBody';

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

// Spawn a single unit at a specific position with the configured demo waypoint.
function spawnUnit(
  world: WorldState,
  physics: PhysicsEngine,
  playerId: PlayerId,
  x: number,
  y: number,
  targetX: number,
  targetY: number,
  buildingGrid: BuildingGrid,
  waypointType: DemoBattleWaypointType,
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
    // Demo order type is data-driven so initial waves can use cheap
    // normal move while still keeping the path expansion that routes
    // around valleys / mountains / building lines.
    setUnitActions(
      unit.unit,
      expandPathActions(
        x, y, targetX, targetY, waypointType,
        world.mapWidth, world.mapHeight, buildingGrid,
        undefined,
        { minSurfaceNormalZ: unit.unit.locomotion.minSurfaceNormalZ },
      ),
    );
  }

  world.addEntity(unit);

  createPhysicsBodyForUnit(world, physics, unit);

  return unit;
}

// Spawn units for the background battle. Teams + their angular bands
// on the spawn oval come from DEMO_CONFIG so 3-vs-3 (or 2-vs-2, 4-vs-4)
// works without code changes.
export function spawnBackgroundUnitsStandalone(
  world: WorldState,
  physics: PhysicsEngine,
  initialSpawn: boolean,
  buildingGrid: BuildingGrid,
  allowedTypes?: ReadonlySet<string>,
  playerIds?: readonly PlayerId[],
): Entity[] {
  const spawned: Entity[] = [];
  const players = normalizePlayerIds(
    playerIds && playerIds.length > 0
      ? playerIds
      : Array.from({ length: Math.max(1, world.playerCount || DEMO_CONFIG.playerCount) }, (_, i) => (i + 1) as PlayerId),
  );
  const numPlayers = players.length;
  const unitCapPerPlayer = Math.floor(world.maxTotalUnits / numPlayers);
  const mapWidth = world.mapWidth;
  const mapHeight = world.mapHeight;
  const oval = makeMapOvalMetrics(mapWidth, mapHeight);
  const cx = oval.cx;
  const cy = oval.cy;

  // Each team's angular position on the spawn oval (matches the layout
  // used for commanders / solars / factories in spawn.ts).
  const baseAngles: number[] = [];
  for (let p = 0; p < numPlayers; p++) {
    baseAngles.push(getPlayerBaseAngle(p, numPlayers));
  }

  if (initialSpawn) {
    // All teams' initial units spawn at random positions inside a
    // single oval around the map center (uniform oval-space area density via
    // sqrt-sample). Each unit's waypoint is the diametrically
    // opposite point through the center, so the units from every team
    // intermix on launch and converge through the middle — the
    // characteristic demo-battle clash.
    //
    // Water exclusion: each candidate (x, y) is rejection-sampled
    // against `isFarFromWater`. After centerSpawnWaterMaxAttempts
    // failures the unit is skipped — the central disk is the SAME
    // sample area as before, just with the wet portion carved out.
    const centerRadius = DEMO_CONFIG.centerSpawnRadius * oval.minDim;
    // Initial demo spawn fills each team's slice of the global unit cap
    // — `unitCapPerPlayer` (= maxTotalUnits / numPlayers). The demo
    // starts at FULL CAP so the user immediately sees the battle at
    // the intended scale; reinforcement ticks below pick up any units
    // that water-rejection skipped, but with unitCapPerPlayer as the
    // ceiling there's no separate "demo size" knob to keep in sync.
    const totalPerPlayer = unitCapPerPlayer;
    const waterBuffer = DEMO_CONFIG.centerSpawnWaterBufferPx;
    const maxAttempts = DEMO_CONFIG.centerSpawnWaterMaxAttempts;

    for (let p = 0; p < numPlayers; p++) {
      const playerId = players[p];
      const pUnits = world.getUnitsByPlayer(playerId).length;

      for (let i = 0; i < totalPerPlayer && pUnits + i < unitCapPerPlayer; i++) {
        let spawnX = 0;
        let spawnY = 0;
        let found = false;
        for (let k = 0; k < maxAttempts; k++) {
          const spawnAngle = Math.random() * Math.PI * 2;
          const spawnDist = Math.sqrt(Math.random()) * centerRadius;
          const point = mapOvalPointAt(oval, spawnAngle, spawnDist);
          spawnX = point.x;
          spawnY = point.y;
          if (isFarFromWater(spawnX, spawnY, mapWidth, mapHeight, waterBuffer)) {
            found = true;
            break;
          }
        }
        if (!found) continue;

        // Waypoint = diametrically opposite point through center.
        const targetX = cx - (spawnX - cx);
        const targetY = cy - (spawnY - cy);

        const unit = spawnUnit(
          world, physics, playerId, spawnX, spawnY, targetX, targetY,
          buildingGrid, DEMO_CONFIG.initialUnitWaypointType, allowedTypes,
        );
        if (unit) spawned.push(unit);
      }
    }
  } else {
    // Reinforcements: one unit per team at their base sector arc, heading
    // toward map center. Same angular layout as the initial spawn.
    const spawnRadius = DEMO_CONFIG.centerSpawnRadius * oval.minDim;
    const sectorAngle = (2 * Math.PI / numPlayers) * DEMO_CONFIG.centerSpawnSectorFraction;

    for (let p = 0; p < numPlayers; p++) {
      const playerId = players[p];
      const pUnits = world.getUnitsByPlayer(playerId).length;
      if (pUnits >= unitCapPerPlayer) continue;

      const offsetAngle = (Math.random() - 0.5) * sectorAngle;
      const a = baseAngles[p] + offsetAngle;
      const r = spawnRadius * (0.85 + Math.random() * 0.15);
      const point = mapOvalPointAt(oval, a, r);

      const unit = spawnUnit(
        world, physics, playerId, point.x, point.y, cx, cy,
        buildingGrid, DEMO_CONFIG.initialUnitWaypointType, allowedTypes,
      );
      if (unit) spawned.push(unit);
    }
  }

  return spawned;
}

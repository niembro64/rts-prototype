// Background battle spawning logic.

import type { Entity, PlayerId } from '../sim/types';
import type { WorldState } from '../sim/WorldState';
import { aimTurretsToward } from '../sim/turretInit';
import type { PhysicsEngine3D as PhysicsEngine } from './PhysicsEngine3D';
import { BUILDABLE_UNIT_IDS, getUnitBlueprint, getNormalizedUnitCost } from '../sim/blueprints';
import {
  BACKGROUND_SPAWN_INVERSE_COST_WEIGHTING,
} from '../../config';
import { DEMO_CONFIG } from '../../demoConfig';
import { getPlayerBaseAngle, normalizePlayerIds } from '../sim/playerLayout';
import { isFarFromWater } from '../sim/Terrain';
import {
  makeMapOvalMetrics,
  mapOvalPointAt,
  type MapOvalMetrics,
} from '../sim/mapOval';
import {
  expandMultiLegPathActions,
  pathTerrainFilterForLocomotion,
  type MultiLegWaypoint,
} from '../sim/Pathfinder';
import { setUnitActions } from '../sim/unitActions';
import { setUnitFacingYaw } from '../sim/unitOrientation';
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
function signatureFor(allowedTypes: ReadonlySet<string> | undefined = undefined): string {
  if (allowedTypes === undefined) return '*';
  if (allowedTypes.size === 0) return '∅';
  return [...allowedTypes].sort().join('|');
}

function ensureWeightTable(allowedTypes: ReadonlySet<string> | undefined = undefined): void {
  const sig = signatureFor(allowedTypes);
  if (sig === cachedWeightSignature && backgroundUnitWeights.length > 0) return;
  cachedWeightSignature = sig;

  const types = allowedTypes !== undefined
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

function selectWeightedUnitType(allowedTypes: ReadonlySet<string> | undefined = undefined): string | null {
  ensureWeightTable(allowedTypes);
  if (backgroundUnitWeights.length === 0) return null;
  const r = Math.random();
  for (const entry of backgroundUnitWeights) {
    if (r <= entry.cumWeight) return entry.type;
  }
  return backgroundUnitWeights[backgroundUnitWeights.length - 1].type;
}

function selectUnitType(allowedTypes: ReadonlySet<string> | undefined = undefined): string | null {
  // No allowed types → caller will skip the spawn.
  if (allowedTypes !== undefined && allowedTypes.size === 0) return null;
  if (BACKGROUND_SPAWN_INVERSE_COST_WEIGHTING) {
    return selectWeightedUnitType(allowedTypes);
  } else if (allowedTypes !== undefined && allowedTypes.size > 0) {
    const allowed = Array.from(allowedTypes);
    return allowed[Math.floor(Math.random() * allowed.length)];
  }
  return BACKGROUND_UNIT_TYPES[Math.floor(Math.random() * BACKGROUND_UNIT_TYPES.length)];
}

// Spawn a single unit at a specific position with the configured demo waypoints.
// `waypoints` may contain one entry (legacy single-target move/fight) or
// multiple entries (e.g. two 'patrol' points for back-and-forth motion);
// when any waypoint is 'patrol', the unit's patrolStartIndex is set so
// the action queue rotates through every patrol-flagged action forever.
function spawnUnit(
  world: WorldState,
  physics: PhysicsEngine,
  playerId: PlayerId,
  x: number,
  y: number,
  waypoints: readonly MultiLegWaypoint[],
  buildingGrid: BuildingGrid,
  allowedTypes: ReadonlySet<string> | undefined = undefined,
): Entity | null {
  if (allowedTypes !== undefined && allowedTypes.size === 0) return null;
  if (waypoints.length === 0) return null;

  const unitType = selectUnitType(allowedTypes);
  // Defensive: only ever spawn from the allowed-types set. If
  // selectUnitType signalled "nothing valid" (empty set, weight
  // table empty after rebuild), skip the spawn entirely instead of
  // creating a unit that would be wiped by the toggle handler a
  // tick later.
  if (!unitType) return null;
  const unit = world.createUnitFromBlueprint(x, y, playerId, unitType);

  const firstWp = waypoints[0];
  setUnitFacingYaw(unit, Math.atan2(firstWp.y - y, firstWp.x - x));
  aimTurretsToward(unit, firstWp.x, firstWp.y);

  if (unit.unit) {
    const { actions, patrolStartIndex } = expandMultiLegPathActions(
      x, y, waypoints,
      world.mapWidth, world.mapHeight, buildingGrid,
      pathTerrainFilterForLocomotion(unit.unit.locomotion),
    );
    setUnitActions(unit.unit, actions);
    if (patrolStartIndex !== null) {
      unit.unit.patrolStartIndex = patrolStartIndex;
    }
  }

  world.addEntity(unit);

  createPhysicsBodyForUnit(world, physics, unit);

  return unit;
}

function countInitialDemoUnitsByPlayer(world: WorldState, playerId: PlayerId): number {
  let count = 0;
  for (const unit of world.getUnitsByPlayer(playerId)) {
    const unitComponent = unit.unit;
    if (unitComponent !== null && unitComponent.unitType === 'commander') continue;
    count++;
  }
  return count;
}

function sampleCenterSpawnPoint(
  oval: MapOvalMetrics,
  centerRadius: number,
  mapWidth: number,
  mapHeight: number,
  waterBuffer: number,
  maxAttempts: number,
): { x: number; y: number } | null {
  let dryFallback: { x: number; y: number } | null = null;
  let anyFallback: { x: number; y: number } | null = null;

  for (let k = 0; k < maxAttempts; k++) {
    const spawnAngle = Math.random() * Math.PI * 2;
    const spawnDist = Math.sqrt(Math.random()) * centerRadius;
    const point = mapOvalPointAt(oval, spawnAngle, spawnDist);
    anyFallback = point;
    if (!dryFallback && isFarFromWater(point.x, point.y, mapWidth, mapHeight, 0)) {
      dryFallback = point;
    }
    if (isFarFromWater(point.x, point.y, mapWidth, mapHeight, waterBuffer)) {
      return point;
    }
  }

  return dryFallback ?? anyFallback;
}

// Spawn units for the background battle. Teams + their angular bands
// on the spawn oval come from DEMO_CONFIG so 3-vs-3 (or 2-vs-2, 4-vs-4)
// works without code changes.
export function spawnBackgroundUnitsStandalone(
  world: WorldState,
  physics: PhysicsEngine,
  initialSpawn: boolean,
  buildingGrid: BuildingGrid,
  allowedTypes: ReadonlySet<string> | undefined = undefined,
  playerIds: readonly PlayerId[] | undefined = undefined,
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
    // against `isFarFromWater`. If the buffered search fails, fall
    // back to an unbuffered dry candidate, then finally to the last
    // sampled center-radius point. The demo's startup contract is to
    // fill the center battle immediately instead of silently dropping
    // units on terrain presets whose center disk is mostly water.
    const centerRadius = DEMO_CONFIG.centerSpawnRadius * oval.minDim;
    // Initial demo spawn fills each team's non-commander slice of the global unit cap
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
      const pUnits = countInitialDemoUnitsByPlayer(world, playerId);

      for (let i = 0; i < totalPerPlayer && pUnits + i < unitCapPerPlayer; i++) {
        const spawn = sampleCenterSpawnPoint(
          oval,
          centerRadius,
          mapWidth,
          mapHeight,
          waterBuffer,
          maxAttempts,
        );
        if (!spawn) continue;

        // Two patrol waypoints along the spawn → opposite-through-center
        // line: units march across, return to their spawn arc, and
        // repeat. Keeps the front from collapsing into a static knot
        // once the initial wave makes contact.
        const targetX = cx - (spawn.x - cx);
        const targetY = cy - (spawn.y - cy);

        const unit = spawnUnit(
          world, physics, playerId, spawn.x, spawn.y,
          [
            { x: targetX, y: targetY, z: null, type: 'patrol' },
            { x: spawn.x, y: spawn.y, z: null, type: 'patrol' },
          ],
          buildingGrid, allowedTypes,
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
        world, physics, playerId, point.x, point.y,
        [
          { x: cx, y: cy, z: null, type: 'patrol' },
          { x: point.x, y: point.y, z: null, type: 'patrol' },
        ],
        buildingGrid, allowedTypes,
      );
      if (unit) spawned.push(unit);
    }
  }

  return spawned;
}

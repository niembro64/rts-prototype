import { deterministicMath as DMath } from '@/game/sim/deterministicMath';
// Background battle spawning logic.

import type { Entity, PlayerId, UnitAction } from '../sim/types';
import type { WorldState } from '../sim/WorldState';
import { aimTurretsToward } from '../sim/turretInit';
import type { PhysicsEngine3D as PhysicsEngine } from './PhysicsEngine3D';
import { BUILDABLE_UNIT_BLUEPRINT_IDS, getUnitBlueprint, getNormalizedUnitCost } from '../sim/blueprints';
import { BACKGROUND_UNIT_SPAWN_DISTRIBUTION } from '../../config';
import { DEMO_CONFIG } from '../../demoConfig';
import { getPlayerBaseAngle, normalizePlayerIds } from '../sim/playerLayout';
import {
  makeMapOvalMetrics,
  mapOvalPointAt,
} from '../sim/mapOval';
import type { MultiLegWaypoint } from '../sim/Pathfinder';
import { setUnitActions } from '../sim/unitActions';
import { setUnitFacingYaw } from '../sim/unitOrientation';
import { createPhysicsBodyForUnit } from './unitPhysicsBody';

// Available unit blueprints for background spawning (excludes commander)
export const BACKGROUND_UNIT_BLUEPRINT_IDS = [...BUILDABLE_UNIT_BLUEPRINT_IDS];
const BACKGROUND_UNIT_BLUEPRINT_ID_SET = new Set<string>(BACKGROUND_UNIT_BLUEPRINT_IDS);

// Pre-computed inverse-cost weights for the optional weighted background
// selection mode. The flat mode samples the same enabled roster uniformly.
// Cached across spawn calls but RE-BUILT whenever the allowedUnitBlueprintIds
// signature changes — without this the original lazy cache would
// keep picking from a stale type list after a toggle, then those
// disallowed units would get wiped a tick later by the toggle
// handler in GameServer.setBackgroundUnitBlueprintEnabled (which gave
// the "spawning then despawning the wrong unit" behaviour).
let backgroundUnitWeights: { type: string; cumWeight: number }[] = [];
let cachedWeightSignature = '';
let cachedAllowedSorted: string[] = [];
let cachedAllowedSignature = '∅';

/** Stable string signature for an allowedUnitBlueprintIds set. Sorting keeps
 *  signature equality independent of insertion order. */
function signatureFor(allowedUnitBlueprintIds: ReadonlySet<string> | undefined = undefined): string {
  if (allowedUnitBlueprintIds === undefined) return '*';
  resolveAllowedSortedList(allowedUnitBlueprintIds);
  return cachedAllowedSignature;
}

function resolveAllowedSortedList(
  allowedUnitBlueprintIds: ReadonlySet<string>,
): readonly string[] {
  if (allowedUnitBlueprintIds.size === 0) {
    cachedAllowedSorted.length = 0;
    cachedAllowedSignature = '∅';
    return cachedAllowedSorted;
  }
  if (cachedAllowedSorted.length === allowedUnitBlueprintIds.size) {
    let matches = true;
    for (let i = 0; i < cachedAllowedSorted.length; i++) {
      if (!allowedUnitBlueprintIds.has(cachedAllowedSorted[i])) {
        matches = false;
        break;
      }
    }
    if (matches) return cachedAllowedSorted;
  }
  cachedAllowedSorted = [];
  for (const unitBlueprintId of allowedUnitBlueprintIds) {
    cachedAllowedSorted.push(unitBlueprintId);
  }
  cachedAllowedSorted.sort();
  cachedAllowedSignature = cachedAllowedSorted.join('|');
  return cachedAllowedSorted;
}

function ensureWeightTable(allowedUnitBlueprintIds: ReadonlySet<string> | undefined = undefined): void {
  const sig = signatureFor(allowedUnitBlueprintIds);
  if (sig === cachedWeightSignature && backgroundUnitWeights.length > 0) return;
  cachedWeightSignature = sig;

  let totalWeight = 0;
  backgroundUnitWeights = [];
  for (let i = 0; i < BACKGROUND_UNIT_BLUEPRINT_IDS.length; i++) {
    const t = BACKGROUND_UNIT_BLUEPRINT_IDS[i];
    if (allowedUnitBlueprintIds !== undefined && !allowedUnitBlueprintIds.has(t)) continue;
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

function selectWeightedUnitBlueprintId(
  rngNext: () => number,
  allowedUnitBlueprintIds: ReadonlySet<string> | undefined = undefined,
): string | null {
  ensureWeightTable(allowedUnitBlueprintIds);
  if (backgroundUnitWeights.length === 0) return null;
  const r = rngNext();
  for (const entry of backgroundUnitWeights) {
    if (r <= entry.cumWeight) return entry.type;
  }
  return backgroundUnitWeights[backgroundUnitWeights.length - 1].type;
}

function selectUnitBlueprintId(
  rngNext: () => number,
  allowedUnitBlueprintIds: ReadonlySet<string> | undefined = undefined,
): string | null {
  // No allowed types → caller will skip the spawn.
  if (allowedUnitBlueprintIds !== undefined && allowedUnitBlueprintIds.size === 0) return null;
  if (BACKGROUND_UNIT_SPAWN_DISTRIBUTION === 'inverse-cost') {
    return selectWeightedUnitBlueprintId(rngNext, allowedUnitBlueprintIds);
  }
  if (allowedUnitBlueprintIds !== undefined && allowedUnitBlueprintIds.size > 0) {
    const allowed = resolveAllowedSortedList(allowedUnitBlueprintIds);
    return allowed[Math.floor(rngNext() * allowed.length)];
  }
  return BACKGROUND_UNIT_BLUEPRINT_IDS[Math.floor(rngNext() * BACKGROUND_UNIT_BLUEPRINT_IDS.length)];
}

/** A shuffled cycle makes the opening wave genuinely flat: every enabled
 * blueprint appears once before any one of them appears twice. */
function shuffledInitialFlatRoster(
  allowedUnitBlueprintIds: ReadonlySet<string> | undefined,
  rngNext: () => number,
): string[] {
  const roster = allowedUnitBlueprintIds === undefined
    ? [...BACKGROUND_UNIT_BLUEPRINT_IDS]
    : Array.from(allowedUnitBlueprintIds).filter((id) => BACKGROUND_UNIT_BLUEPRINT_ID_SET.has(id));
  roster.sort();
  for (let i = roster.length - 1; i > 0; i--) {
    const j = Math.floor(rngNext() * (i + 1));
    const swap = roster[i];
    roster[i] = roster[j];
    roster[j] = swap;
  }
  return roster;
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
  unitBlueprintId: string,
  initialZ: number | undefined = undefined,
): Entity | null {
  if (waypoints.length === 0) return null;
  const unit = world.createUnitFromBlueprint(x, y, playerId, unitBlueprintId);
  if (initialZ !== undefined) unit.transform.z = initialZ;

  const firstWp = waypoints[0];
  setUnitFacingYaw(unit, DMath.atan2(firstWp.y - y, firstWp.x - x));
  aimTurretsToward(unit, firstWp.x, firstWp.y);

  if (unit.unit) {
    const actions = new Array<UnitAction>(waypoints.length);
    let patrolStartIndex = -1;
    for (let i = 0; i < waypoints.length; i++) {
      const wp = waypoints[i];
      const action: UnitAction = { type: wp.type, x: wp.x, y: wp.y };
      if (wp.z !== null) action.z = wp.z;
      actions[i] = action;
      if (patrolStartIndex < 0 && action.type === 'patrol') patrolStartIndex = i;
    }
    setUnitActions(unit.unit, actions);
    if (patrolStartIndex >= 0) {
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
    if (unitComponent !== null && unitComponent.unitBlueprintId === 'unitCommander') continue;
    count++;
  }
  return count;
}

/** Keep one live-unit slot available for every seeded Fabricator repeat line.
 * The quick-start center wave must not fill the cap before the one-factory-
 * per-unit demo layout can visibly produce its first shell. */
function seededFabricatorProductionReserve(world: WorldState, playerId: PlayerId): number {
  let count = 0;
  for (const factory of world.getFactoriesByPlayer(playerId)) {
    if (factory.buildingBlueprintId !== 'towerFabricator') continue;
    const factoryComponent = factory.factory;
    if (factoryComponent === null) continue;
    const selected = factoryComponent.selectedUnitBlueprintId;
    if (
      factoryComponent.repeatProduction === true &&
      selected !== null &&
      BACKGROUND_UNIT_BLUEPRINT_ID_SET.has(selected)
    ) {
      count++;
    }
  }
  return count;
}

/** The opening wave deliberately ignores terrain, medium, and path
 * suitability. Every enabled unit uses this same uniform center disk. */
function sampleInitialCenterSpawnPoint(
  oval: ReturnType<typeof makeMapOvalMetrics>,
  centerRadius: number,
  rngNext: () => number,
): { x: number; y: number } {
  const spawnAngle = rngNext() * Math.PI * 2;
  const spawnDist = DMath.sqrt(rngNext()) * centerRadius;
  return mapOvalPointAt(oval, spawnAngle, spawnDist);
}

// Spawn units for the background battle. Teams + their angular bands
// on the spawn oval come from DEMO_CONFIG so 3-vs-3 (or 2-vs-2, 4-vs-4)
// works without code changes.
export function spawnBackgroundUnitsStandalone(
  world: WorldState,
  physics: PhysicsEngine,
  initialSpawn: boolean,
  allowedUnitBlueprintIds: ReadonlySet<string> | undefined = undefined,
  playerIds: readonly PlayerId[] | undefined = undefined,
): Entity[] {
  const spawned: Entity[] = [];
  const sourceUnitBlueprintIds = allowedUnitBlueprintIds ?? BACKGROUND_UNIT_BLUEPRINT_IDS;
  const centerBattleAllowedUnitBlueprintIds = new Set<string>();
  for (const unitBlueprintId of sourceUnitBlueprintIds) {
    if (DEMO_CONFIG.waterFabricators.unitBlueprintIds.includes(unitBlueprintId)) continue;
    centerBattleAllowedUnitBlueprintIds.add(unitBlueprintId);
  }
  let playersSource: readonly PlayerId[];
  if (playerIds && playerIds.length > 0) {
    playersSource = playerIds;
  } else {
    const fallbackPlayerCount = Math.max(1, world.playerCount || DEMO_CONFIG.playerCount);
    const fallbackPlayerIds = new Array<PlayerId>(fallbackPlayerCount);
    for (let i = 0; i < fallbackPlayerCount; i++) fallbackPlayerIds[i] = (i + 1) as PlayerId;
    playersSource = fallbackPlayerIds;
  }
  const players = normalizePlayerIds(playersSource);
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
    // Every opening unit draws from the enabled roster under the configured
    // distribution, then drops into the same center disk. The flat mode uses
    // a shuffled repeating roster; this intentionally performs no terrain,
    // water, path, or factory-roster suitability checks.
    const centerRadius = DEMO_CONFIG.centerSpawnRadius * oval.minDim;

    for (let p = 0; p < numPlayers; p++) {
      const playerId = players[p];
      const pUnits = countInitialDemoUnitsByPlayer(world, playerId);
      const productionReserve = seededFabricatorProductionReserve(world, playerId);
      const flatRoster = BACKGROUND_UNIT_SPAWN_DISTRIBUTION === 'flat-distribution'
        ? shuffledInitialFlatRoster(allowedUnitBlueprintIds, () => world.nextRandom(playerId))
        : null;
      // Commander is already live and counts against the cap. Fill the center
      // battle only to cap - commander - repeat-production reservations.
      const totalPerPlayer = Math.max(0, unitCapPerPlayer - 1 - productionReserve);

      for (let i = 0; i < totalPerPlayer && pUnits + i < unitCapPerPlayer; i++) {
        const unitBlueprintId = flatRoster !== null
          ? flatRoster[i % flatRoster.length] ?? null
          : selectUnitBlueprintId(
              () => world.nextRandom(playerId),
              allowedUnitBlueprintIds,
            );
        if (unitBlueprintId === null) continue;

        const spawn = sampleInitialCenterSpawnPoint(
          oval,
          centerRadius,
          () => world.nextRandom(playerId),
        );
        // Every initial locomotion type receives the same patrol shape.
        const targetX = cx - (spawn.x - cx);
        const targetY = cy - (spawn.y - cy);
        const initialZ = world.getGroundZ(spawn.x, spawn.y) +
          DEMO_CONFIG.initialUnitSpawnHeightAboveSurface;
        const unit = spawnUnit(
          world, physics, playerId, spawn.x, spawn.y,
          [
            { x: targetX, y: targetY, z: null, type: 'patrol' },
            { x: spawn.x, y: spawn.y, z: null, type: 'patrol' },
          ],
          unitBlueprintId,
          initialZ,
        );
        if (unit === null) continue;
        spawned.push(unit);
      }
    }
  } else {
    // Reinforcements stay on their team base-sector arcs and head toward map
    // center. This is intentionally separate from the unconstrained opening
    // wave above.
    const spawnRadius = DEMO_CONFIG.centerSpawnRadius * oval.minDim;
    const sectorAngle = (2 * Math.PI / numPlayers) * DEMO_CONFIG.centerSpawnSectorFraction;

    for (let p = 0; p < numPlayers; p++) {
      const playerId = players[p];
      const pUnits = world.getUnitsByPlayer(playerId).length;
      const reinforcementCeiling = Math.max(
        1,
        unitCapPerPlayer - seededFabricatorProductionReserve(world, playerId),
      );
      if (pUnits >= reinforcementCeiling) continue;

      const offsetAngle = (world.nextRandom(playerId) - 0.5) * sectorAngle;
      const a = baseAngles[p] + offsetAngle;
      const r = spawnRadius * (0.85 + world.nextRandom(playerId) * 0.15);
      const point = mapOvalPointAt(oval, a, r);
      const unitBlueprintId = selectUnitBlueprintId(
        () => world.nextRandom(playerId),
        centerBattleAllowedUnitBlueprintIds,
      );
      if (unitBlueprintId === null) continue;

      const unit = spawnUnit(
        world, physics, playerId, point.x, point.y,
        [
          { x: cx, y: cy, z: null, type: 'patrol' },
          { x: point.x, y: point.y, z: null, type: 'patrol' },
        ],
        unitBlueprintId,
      );
      if (unit) spawned.push(unit);
    }
  }

  return spawned;
}

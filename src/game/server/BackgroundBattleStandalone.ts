import { deterministicMath as DMath } from '@/game/sim/deterministicMath';
// Background battle spawning logic.

import type { Entity, PlayerId, UnitAction } from '../sim/types';
import type { WorldState } from '../sim/WorldState';
import { aimTurretsToward } from '../sim/turretInit';
import type { PhysicsEngine3D as PhysicsEngine } from './PhysicsEngine3D';
import { BUILDABLE_UNIT_BLUEPRINT_IDS, getUnitBlueprint, getNormalizedUnitCost } from '../sim/blueprints';
import { BACKGROUND_UNIT_SPAWN_DISTRIBUTION } from '../../config';
import { DEMO_CONFIG } from '../../demoConfig';
import { getSeatBaseAngle, normalizePlayerIds } from '../sim/playerLayout';
import { getAllyTeamMembers } from '../sim/teamRoster';
import {
  makeMapOvalMetrics,
  mapOvalPointAt,
} from '../sim/mapOval';
import { getUnitLocomotion } from '../sim/blueprints/units';
import { isWaterAt } from '../sim/Terrain';
import { isPathSegmentTraversable } from '../sim/Pathfinder';
import { pathTerrainFilterForLocomotion } from '../sim/pathfindingTraversal';
import type { MultiLegWaypoint } from '../sim/Pathfinder';
import { setUnitActions } from '../sim/unitActions';
import { setUnitFacingYaw } from '../sim/unitOrientation';
import { createPhysicsBodyForUnit } from './unitPhysicsBody';
import { mapHasWater } from '../sim/mapSurface';
import {
  SHORE_MARGIN_WATER_SPAWN_WU,
  getShoreDistanceField,
  pointHasShoreMargin,
  type ShoreDistanceField,
} from '../sim/shoreDistanceField';
import { isFabricatorBuildingBlueprintId } from '../sim/blueprints/buildings';

// Available unit blueprints for background spawning (excludes commander)
export const BACKGROUND_UNIT_BLUEPRINT_IDS = [...BUILDABLE_UNIT_BLUEPRINT_IDS];
const BACKGROUND_UNIT_BLUEPRINT_ID_SET = new Set<string>(BACKGROUND_UNIT_BLUEPRINT_IDS);

// Pre-computed inverse-cost weights for the opening wave and the optional
// weighted reinforcement selection mode. The opening wave always uses this
// table; later background unit generation still follows its configured mode.
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
    const weight = cost > 0 ? 1 / cost : 0;
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

/** Canonical opening-wave coverage order. Set iteration order is caller-owned,
 * so derive from the authoritative roster to keep Demo deterministic and make
 * every enabled blueprint visible before weighted duplicates begin. */
function openingWaveCoverageBlueprintIds(
  allowedUnitBlueprintIds: ReadonlySet<string> | undefined,
): readonly string[] {
  if (allowedUnitBlueprintIds === undefined) return BACKGROUND_UNIT_BLUEPRINT_IDS;
  return BACKGROUND_UNIT_BLUEPRINT_IDS.filter(
    (unitBlueprintId) => allowedUnitBlueprintIds.has(unitBlueprintId),
  );
}

let bodyPoolSaturatedWarned = false;
function warnBodyPoolSaturatedOnce(): void {
  if (bodyPoolSaturatedWarned) return;
  bodyPoolSaturatedWarned = true;
  console.warn(
    '[background battle] BodyPool near capacity — further wave spawns are skipped',
  );
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
  // Stop the wave before the shared BodyPool runs out: a demo battle that
  // saturates the pool must degrade to fewer units, not trap the module
  // with an out-of-bounds allocation mid-spawn. The margin reserves slots
  // for factory production and building bodies.
  if (!physics.hasBodyPoolHeadroom(128)) {
    warnBodyPoolSaturatedOnce();
    return null;
  }
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

/** The whole side's Fabricator reserve. The cap is a side pool, so the
 * reserve has to be one too — otherwise a 3-seat side reserves a third of
 * what its factories will actually try to build. */
function seededFabricatorProductionReserveForTeam(
  world: WorldState,
  playerId: PlayerId,
): number {
  let count = 0;
  for (const member of getAllyTeamMembers(world.teamRoster, playerId)) {
    count += seededFabricatorProductionReserve(world, member);
  }
  return count;
}

/** Keep one live-unit slot available for every seeded Fabricator repeat line.
 * The quick-start center wave must not fill the cap before the one-factory-
 * per-unit demo layout can visibly produce its first shell. */
function seededFabricatorProductionReserve(world: WorldState, playerId: PlayerId): number {
  let count = 0;
  for (const factory of world.getFactoriesByPlayer(playerId)) {
    if (!isFabricatorBuildingBlueprintId(factory.buildingBlueprintId)) continue;
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

type OpenWaterPatrolPair = Readonly<{
  x: number;
  y: number;
  oppositeX: number;
  oppositeY: number;
}>;

type OpenWaterPatrolPool = {
  field: ShoreDistanceField;
  /** Canonical cell index for each centre-reflected pair. Shuffled lazily so
   *  opening hulls sample the entire water area uniformly without replacement. */
  remainingCellIndices: Uint32Array;
  nextIndex: number;
};

function reflectedCellIndex(field: ShoreDistanceField, x: number, y: number): number {
  const oppositeX = field.mapWidth - x;
  const oppositeY = field.mapHeight - y;
  const gx = Math.min(field.cellsX - 1, Math.max(0, Math.floor(oppositeX / field.cellSize)));
  const gy = Math.min(field.cellsY - 1, Math.max(0, Math.floor(oppositeY / field.cellSize)));
  return gy * field.cellsX + gx;
}

export function openWaterPatrolPairFromCellIndex(
  field: ShoreDistanceField,
  cellIndex: number,
): OpenWaterPatrolPair {
  const gx = cellIndex % field.cellsX;
  const gy = Math.floor(cellIndex / field.cellsX);
  const x = (gx + 0.5) * field.cellSize;
  const y = (gy + 0.5) * field.cellSize;
  return {
    x,
    y,
    oppositeX: field.mapWidth - x,
    oppositeY: field.mapHeight - y,
  };
}

/** Every map-wide open-water spawn candidate, collapsed into exact
 *  centre-reflected pairs. Both endpoints must keep the authored launch
 *  margin; retaining only the lower cell index makes each pair appear once. */
export function buildPaddedOpenWaterPatrolPairCellIndices(
  field: ShoreDistanceField,
): Uint32Array {
  const candidates: number[] = [];
  const cellCount = field.cellsX * field.cellsY;
  for (let cellIndex = 0; cellIndex < cellCount; cellIndex++) {
    const pair = openWaterPatrolPairFromCellIndex(field, cellIndex);
    const oppositeCellIndex = reflectedCellIndex(field, pair.x, pair.y);
    if (cellIndex > oppositeCellIndex) continue;
    if (
      !pointHasShoreMargin(
        field,
        'water',
        pair.x,
        pair.y,
        SHORE_MARGIN_WATER_SPAWN_WU,
      ) ||
      !pointHasShoreMargin(
        field,
        'water',
        pair.oppositeX,
        pair.oppositeY,
        SHORE_MARGIN_WATER_SPAWN_WU,
      )
    ) {
      continue;
    }
    candidates.push(cellIndex);
  }
  return Uint32Array.from(candidates);
}

function createOpenWaterPatrolPool(field: ShoreDistanceField): OpenWaterPatrolPool {
  return {
    field,
    remainingCellIndices: buildPaddedOpenWaterPatrolPairCellIndices(field),
    nextIndex: 0,
  };
}

function isStandableWaterPoint(
  world: WorldState,
  x: number,
  y: number,
  radius: number,
  filter: ReturnType<typeof pathTerrainFilterForLocomotion>,
): boolean {
  if (
    x < radius || y < radius ||
    x > world.mapWidth - radius || y > world.mapHeight - radius ||
    !isWaterAt(x, y, world.mapWidth, world.mapHeight)
  ) {
    return false;
  }
  const z = world.getTerrainBedZ(x, y);
  return isPathSegmentTraversable(
    x,
    y,
    { x, y, z },
    world.mapWidth,
    world.mapHeight,
    filter,
    radius,
    world.slopePathMode === 'symmetric',
  );
}

/** Draw one uniformly shuffled pair from every padded water cell on the map.
 *  Invalid body-specific candidates are discarded and the next shuffled pair
 *  is tried. Orientation is random, so the canonical half-pair storage still
 *  produces spawn points over both halves of the world. */
function sampleOpenWaterPatrolPair(
  world: WorldState,
  pool: OpenWaterPatrolPool,
  unitBlueprintId: string,
  rngNext: () => number,
): OpenWaterPatrolPair | null {
  const blueprint = getUnitBlueprint(unitBlueprintId);
  const filter = pathTerrainFilterForLocomotion(
    getUnitLocomotion(unitBlueprintId),
    blueprint.mass,
    blueprint.supportPointOffsetZ,
  );
  const radius = blueprint.radius.collision;
  const remaining = pool.remainingCellIndices;
  while (pool.nextIndex < remaining.length) {
    const available = remaining.length - pool.nextIndex;
    const drawOffset = Math.min(available - 1, Math.floor(rngNext() * available));
    const drawIndex = pool.nextIndex + drawOffset;
    const cellIndex = remaining[drawIndex];
    remaining[drawIndex] = remaining[pool.nextIndex];
    remaining[pool.nextIndex] = cellIndex;
    pool.nextIndex++;

    const canonical = openWaterPatrolPairFromCellIndex(pool.field, cellIndex);
    const forward = rngNext() < 0.5;
    const pair: OpenWaterPatrolPair = forward
      ? canonical
      : {
        x: canonical.oppositeX,
        y: canonical.oppositeY,
        oppositeX: canonical.x,
        oppositeY: canonical.y,
      };
    if (
      isStandableWaterPoint(world, pair.x, pair.y, radius, filter) &&
      isStandableWaterPoint(world, pair.oppositeX, pair.oppositeY, radius, filter)
    ) {
      return pair;
    }
  }
  return null;
}

/** The opening wave ignores terrain and path suitability for land bodies:
 * every enabled unit samples this same uniform center disk. Water-required
 * hulls replace that sample with a map-wide open-water patrol pair. */
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
    if (getUnitBlueprint(unitBlueprintId).requiresWater) continue;
    centerBattleAllowedUnitBlueprintIds.add(unitBlueprintId);
  }
  // A map with no water turns the demo's water roster off entirely: the
  // opening wave must not drop sea units onto dry land, or into molten rock.
  // Reinforcements already draw from the water-excluded center-battle set in
  // every world. `mapHasWater()` owns which maps those are — LAVA and NONE
  // are two of them, and an unexcavated WATER map is another.
  const initialWaveAllowedUnitBlueprintIds = mapHasWater()
    ? allowedUnitBlueprintIds
    : centerBattleAllowedUnitBlueprintIds;
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
  // Each seat's slice of ITS OWN SIDE's remaining pool, fixed before the wave
  // starts so seat order cannot starve a teammate. Sides are uneven by design
  // (DEMO_CONFIG.allyTeamSeats), and the base rings already placed count
  // against the pool — buildings are entities too — so this reads what is
  // actually left rather than the raw cap.
  const seatShareByPlayer = new Map<PlayerId, number>();
  for (let p = 0; p < numPlayers; p++) {
    const playerId = players[p];
    const seats = Math.max(1, getAllyTeamMembers(world.teamRoster, playerId).length);
    seatShareByPlayer.set(
      playerId,
      Math.floor(world.getRemainingTeamEntityCapacity(playerId) / seats),
    );
  }
  const mapWidth = world.mapWidth;
  const mapHeight = world.mapHeight;
  const oval = makeMapOvalMetrics(mapWidth, mapHeight);
  // Null on bare worlds (no authoritative terrain): water hulls retain the
  // roster-guarantee fallback at their center-disk sample.
  const shoreField = getShoreDistanceField(mapWidth, mapHeight);
  const openWaterPatrolPool = shoreField === null
    ? null
    : createOpenWaterPatrolPool(shoreField);
  const cx = oval.cx;
  const cy = oval.cy;

  // Each team's angular position on the spawn oval (matches the layout
  // used for commanders / solars / factories in spawn.ts).
  const baseAngles: number[] = [];
  for (let p = 0; p < numPlayers; p++) {
    baseAngles.push(getSeatBaseAngle(world.teamRoster, players[p]));
  }

  if (initialSpawn) {
    // Seed one of every enabled unit first whenever this seat's cap share has
    // room, then fill remaining slots with the inverse-cost weighted roster.
    // This turns "enabled" into a visible Demo guarantee instead of a random
    // chance. Land bodies drop into the same center disk with no terrain,
    // path, or factory-roster suitability checks. Water-required hulls draw
    // without replacement from every padded, standable water pair on the
    // map; on lava the water roster is off entirely.
    const centerRadius = DEMO_CONFIG.centerSpawnRadius * oval.minDim;
    const coverageBlueprintIds = openingWaveCoverageBlueprintIds(
      initialWaveAllowedUnitBlueprintIds,
    );

    for (let p = 0; p < numPlayers; p++) {
      const playerId = players[p];
      const pUnits = countInitialDemoUnitsByPlayer(world, playerId);
      // CAP now specifies the whole match, so the opening wave gets whatever
      // this seat's share of its side has left after infrastructure. The
      // live-capacity guard is the real ceiling; the share only decides how
      // the side's remainder is spread across its own seats.
      const seatShare = seatShareByPlayer.get(playerId) ?? 0;

      for (
        let i = 0;
        pUnits + i < seatShare && world.getRemainingTeamEntityCapacity(playerId) > 0;
        i++
      ) {
        // Rotate short-cap coverage between seats so a match that can fit the
        // full roster in aggregate still shows all types even when no one seat
        // can. A seat with >= roster-size slots always receives all of them.
        const coverageIndex = coverageBlueprintIds.length > 0
          ? (p * seatShare + i) % coverageBlueprintIds.length
          : -1;
        const unitBlueprintId = i < coverageBlueprintIds.length
          ? coverageBlueprintIds[coverageIndex]
          : selectWeightedUnitBlueprintId(
            () => world.nextRandom(playerId),
            initialWaveAllowedUnitBlueprintIds,
          );
        if (unitBlueprintId === null) continue;

        let spawn = sampleInitialCenterSpawnPoint(
          oval,
          centerRadius,
          () => world.nextRandom(playerId),
        );
        // Every initial locomotion type receives the same patrol shape: the
        // spawn point and its mirror through the map center.
        let targetX = cx - (spawn.x - cx);
        let targetY = cy - (spawn.y - cy);
        if (getUnitBlueprint(unitBlueprintId).requiresWater && openWaterPatrolPool !== null) {
          const waterPair = sampleOpenWaterPatrolPair(
            world,
            openWaterPatrolPool,
            unitBlueprintId,
            () => world.nextRandom(playerId),
          );
          // An authoritative map with no body-valid padded pair has nowhere
          // legal to launch this hull. Do not silently fall back onto land;
          // bare test worlds are the only case that retains the center sample.
          if (waterPair === null) continue;
          spawn = { x: waterPair.x, y: waterPair.y };
          targetX = waterPair.oppositeX;
          targetY = waterPair.oppositeY;
        }
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
      // Reinforcements draw from the SIDE's pool, so the whole side's live
      // entities and the whole side's reserved Fabricator lines both count.
      const teamEntities = world.getTeamEntityCount(playerId);
      const reinforcementCeiling = Math.max(
        1,
        world.getTeamEntityCountCap() - seededFabricatorProductionReserveForTeam(world, playerId),
      );
      if (teamEntities >= reinforcementCeiling) continue;

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

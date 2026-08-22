import { deterministicMath as DMath } from '@/game/sim/deterministicMath';
import type { WorldState } from './WorldState';
import type { Entity, PlayerId, BuildingBlueprintId, FactoryDefaultWaypoint } from './types';
import type { ConstructionSystem } from './construction';
import { economyManager } from './economy';
import { aimTurretsToward } from './turretInit';
import { setUnitFacingYaw } from './unitOrientation';
import { getBuildingConfig } from './buildConfigs';
import { getStructureFactoryAllowedUnitBlueprintIds } from './factoryProductionRoster';
import { mapHasWater } from './mapSurface';
import { DEMO_CONFIG } from '../../demoConfig';
import type { WaypointType } from '../../types/commandTypes';
import {
  REAL_BATTLE_FACTORY_WAYPOINT_DISTANCE,
  REAL_BATTLE_FACTORY_WAYPOINT_TYPE,
} from '../../config';
import { applyCompletedBuildingEffects } from './buildingCompletion';
import { setBuildingActiveOpen } from './buildingActiveState';
import {
  getSeatBaseAngle,
  getSeatBuildArcAngle,
  normalizePlayerIds,
} from './playerLayout';
import type { TeamRoster } from './teamRoster';
import {
  makeMapOvalMetrics,
  mapOvalAngleAt,
  mapOvalPointAt,
  sampleMapOvalAt,
  type MapOvalMetrics,
} from './mapOval';
import { angleDeltaAbs } from '../math';
import { isWaterAt } from './Terrain';
import { fabricatorTorusOuterRadius } from './blueprints';
import {
  BUILD_GRID_CELL_SIZE,
  getRotatedBuildingPlacementFootprint,
} from './buildGrid';
import { BUILDING_BLUEPRINT_IDS } from '../../types/blueprintIds';
import { getBuildingPlacementSetSquareType } from '../../types/buildingTypes';

export { getSeatBaseAngle } from './playerLayout';

type InitialBaseMode = 'demo' | 'real';

type CommanderBuildingExclusion = Readonly<{
  x: number;
  y: number;
  radius: number;
}>;

const INITIAL_BASE_PLACEMENT_SEARCH_RADIUS_CELLS = 8;

type GridOffset = {
  dx: number;
  dy: number;
};

function compareGridOffsetsByDistance(a: GridOffset, b: GridOffset): number {
  const aDist = a.dx * a.dx + a.dy * a.dy;
  const bDist = b.dx * b.dx + b.dy * b.dy;
  if (aDist !== bDist) return aDist - bDist;
  if (a.dy !== b.dy) return a.dy - b.dy;
  return a.dx - b.dx;
}

function buildPlacementSearchOffsets(radius: number): readonly GridOffset[] {
  const offsets: GridOffset[] = [];
  const safeRadius = Math.max(0, Math.floor(radius));
  for (let dy = -safeRadius; dy <= safeRadius; dy++) {
    for (let dx = -safeRadius; dx <= safeRadius; dx++) {
      offsets.push({ dx, dy });
    }
  }
  offsets.sort(compareGridOffsetsByDistance);
  return offsets;
}

function buildStridedPlacementSearchOffsets(
  radius: number,
  stride: number,
): readonly GridOffset[] {
  const safeRadius = Math.max(0, Math.floor(radius));
  const safeStride = Math.max(1, Math.floor(stride));
  const axis = [0];
  for (let distance = safeStride; distance <= safeRadius; distance += safeStride) {
    axis.push(-distance, distance);
  }
  if (safeRadius > 0 && safeRadius % safeStride !== 0) {
    axis.push(-safeRadius, safeRadius);
  }
  const offsets: GridOffset[] = [];
  for (let y = 0; y < axis.length; y++) {
    for (let x = 0; x < axis.length; x++) {
      offsets.push({ dx: axis[x], dy: axis[y] });
    }
  }
  offsets.sort(compareGridOffsetsByDistance);
  return offsets;
}

const INITIAL_BASE_PLACEMENT_SEARCH_OFFSETS = buildPlacementSearchOffsets(
  INITIAL_BASE_PLACEMENT_SEARCH_RADIUS_CELLS,
);
// A complete demo roster can be much denser than the shared structure arcs,
// especially on rectangular maps. Fabricators may fan across nearby free grid
// cells while remaining inside their team's dedicated production sector.
// 48 cells left the last seat of the tightest preset (Spikey Lake) one line
// short: eight of nine seats fit all 26 demo production lines and the ninth
// found no free cell for its last Fabricator. The ring is deterministic and
// ordered nearest-first, so a wider radius only lets a crowded seat reach one
// ring further out; it never moves a placement that already succeeded.
// A Fabricator reserves a 14x14-cell pixel-circle. Half-footprint search
// steps cover dense packing while avoiding tens of thousands of near-identical
// probes whose rectangles overlap the same occupied cells.
const FACTORY_PLACEMENT_SEARCH_OFFSETS = buildStridedPlacementSearchOffsets(64, 7);
const WATER_FACTORY_PLACEMENT_SEARCH_OFFSETS = buildStridedPlacementSearchOffsets(36, 7);
// Authored demo extractors belong on their deposit's own snapped footprint.
// Do not fan outward like generic base placement: a nearby extractor with
// partial coverage is not the authored deposit/extractor pair.
const METAL_EXTRACTOR_PLACEMENT_SEARCH_OFFSETS: readonly GridOffset[] = [
  { dx: 0, dy: 0 },
];

/** Rows with bespoke counts/semantics below. Every other non-extractor
 * building is automatically placed on the supplemental ground/water row.
 * This inversion is deliberate: appending a blueprint to the canonical
 * registry makes it appear in Demo without requiring another hand-maintained
 * spawn list. */
const DEMO_BESPOKE_BASE_BUILDING_BLUEPRINT_IDS = new Set<BuildingBlueprintId>([
  'buildingSolar',
  'buildingWind',
  'towerFabricator',
  'towerBeamMega',
  'towerCannon',
  'buildingRadar',
  'buildingResourceConverter',
  'towerAntiAir',
  'buildingSonar',
  'buildingShieldTargetingTech',
  'buildingShieldTech',
  'buildingPrecisionTargetingTech',
]);

function getDemoExtractorBlueprintIds(
  availableBuildingBlueprintIds: ReadonlySet<string> | undefined,
): BuildingBlueprintId[] {
  return BUILDING_BLUEPRINT_IDS.filter((id) => {
    if (availableBuildingBlueprintIds !== undefined && !availableBuildingBlueprintIds.has(id)) {
      return false;
    }
    return getBuildingConfig(id).metalProduction !== null;
  });
}

function getDemoSupplementalBuildingBlueprintIds(
  squareType: 'ground' | 'water',
  availableBuildingBlueprintIds: ReadonlySet<string> | undefined,
): BuildingBlueprintId[] {
  return BUILDING_BLUEPRINT_IDS.filter((id) => {
    if (availableBuildingBlueprintIds !== undefined && !availableBuildingBlueprintIds.has(id)) {
      return false;
    }
    if (DEMO_BESPOKE_BASE_BUILDING_BLUEPRINT_IDS.has(id)) return false;
    const config = getBuildingConfig(id);
    if (config.metalProduction !== null) return false;
    // A dual-domain structure belongs on the ground showcase row. Water is
    // reserved for structures that genuinely have no ground placement set.
    const supportsGround = config.placementSets.some(
      (set) => getBuildingPlacementSetSquareType(set) === 'ground',
    );
    return squareType === 'ground'
      ? supportsGround
      : !supportsGround && config.placementSets.some(
        (set) => getBuildingPlacementSetSquareType(set) === 'water',
      );
  });
}

/** Everything about a pre-placed initial-base building that depends on which
 *  kind of base is being stood up. Threaded to every placement site so the
 *  demo/real split is decided once, here, instead of at each call. */
type InitialBasePolicy = {
  fightType: WaypointType;
  fightDistance: number;
  /** Game-start factories in EVERY battle kind ship the full three-leg
   *  route (fight leg + the two cross-map patrol legs); a factory built in
   *  play gets only the simple rally (construction.ts). The split is
   *  game-init vs game-built, not demo vs real. */
  addCenterPatrolLoop: boolean;
  /** Pre-placed hosts that come up with their ON/OFF switch already OFF.
   *  Only the demo's opening base authors any; a normally constructed
   *  building always completes with its switch ON. */
  initiallyOffBuildingBlueprintIds: ReadonlySet<BuildingBlueprintId>;
  /** Demo-only circles that no authored building footprint may enter. */
  commanderBuildingExclusions: readonly CommanderBuildingExclusion[];
};

function getInitialBasePolicy(
  mode: InitialBaseMode,
  commanderBuildingExclusions: readonly CommanderBuildingExclusion[] = [],
): InitialBasePolicy {
  if (mode === 'real') {
    return {
      fightType: REAL_BATTLE_FACTORY_WAYPOINT_TYPE,
      fightDistance: REAL_BATTLE_FACTORY_WAYPOINT_DISTANCE,
      addCenterPatrolLoop: true,
      initiallyOffBuildingBlueprintIds: EMPTY_INITIALLY_OFF_BUILDING_BLUEPRINT_IDS,
      commanderBuildingExclusions,
    };
  }
  return {
    fightType: 'fight',
    fightDistance: DEMO_CONFIG.factoryFightWaypointDistance,
    addCenterPatrolLoop: true,
    initiallyOffBuildingBlueprintIds: DEMO_CONFIG.initiallyOffBuildingBlueprintIds,
    commanderBuildingExclusions,
  };
}

const EMPTY_INITIALLY_OFF_BUILDING_BLUEPRINT_IDS: ReadonlySet<BuildingBlueprintId> =
  new Set<BuildingBlueprintId>();

function commanderBuildingExclusionAt(
  x: number,
  y: number,
): CommanderBuildingExclusion {
  return {
    x,
    y,
    radius: DEMO_CONFIG.commanderBuildingExclusionRadius,
  };
}

function existingCommanderBuildingExclusions(
  world: WorldState,
): CommanderBuildingExclusion[] {
  const exclusions: CommanderBuildingExclusion[] = [];
  const entities = world.getAllEntities();
  for (let i = 0; i < entities.length; i++) {
    const entity = entities[i];
    if (entity.commander === null) continue;
    exclusions.push(commanderBuildingExclusionAt(
      entity.transform.x,
      entity.transform.y,
    ));
  }
  return exclusions;
}

/**
 * Compute a factory's default waypoint along the factory -> map-center axis.
 * `distance` controls how far: 0.5 = halfway to center, 1.0 = center, 1.5 = past center.
 */
export function computeFactoryWaypoint(
  factoryX: number, factoryY: number,
  mapWidth: number, mapHeight: number,
  distance: number,
): { x: number; y: number } {
  const cx = mapWidth / 2;
  const cy = mapHeight / 2;
  return {
    x: factoryX + (cx - factoryX) * distance,
    y: factoryY + (cy - factoryY) * distance,
  };
}

function computeFactoryDefaultWaypoints(
  factoryX: number,
  factoryY: number,
  mapWidth: number,
  mapHeight: number,
  basePolicy: InitialBasePolicy,
): readonly FactoryDefaultWaypoint[] {
  const fight = computeFactoryWaypoint(
    factoryX,
    factoryY,
    mapWidth,
    mapHeight,
    basePolicy.fightDistance,
  );
  if (!basePolicy.addCenterPatrolLoop) {
    return [{ x: fight.x, y: fight.y, z: null, type: basePolicy.fightType }];
  }

  const oval = makeMapOvalMetrics(mapWidth, mapHeight);
  const angle = mapOvalAngleAt(mapWidth, mapHeight, factoryX, factoryY);
  const patrolRadius = DEMO_CONFIG.centerSpawnRadius * oval.minDim;
  const near = mapOvalPointAt(oval, angle, patrolRadius);
  const far = mapOvalPointAt(oval, angle + Math.PI, patrolRadius);
  return [
    { x: fight.x, y: fight.y, z: null, type: basePolicy.fightType },
    { x: far.x, y: far.y, z: null, type: 'patrol' },
    { x: near.x, y: near.y, z: null, type: 'patrol' },
  ];
}

// Spawn a commander for a player
function spawnCommander(
  world: WorldState,
  playerId: PlayerId,
  x: number,
  y: number,
  facingAngle: number
): Entity {
  const commander = world.createUnitFromBlueprint(x, y, playerId, 'unitCommander');
  setUnitFacingYaw(commander, facingAngle);
  aimTurretsToward(commander, world.mapWidth / 2, world.mapHeight / 2);
  world.addEntity(commander);
  return commander;
}

// Map center + spawn-oval radius (margined inside the playable area).
// Single source of truth for every radial spawn-layout function below.
function getDemoOval(world: WorldState): { oval: MapOvalMetrics; radius: number } {
  const oval = makeMapOvalMetrics(world.mapWidth, world.mapHeight);
  return {
    oval,
    radius: oval.minDim / 2 - DEMO_CONFIG.spawnMarginPx,
  };
}

function commanderRadiusFromOuterSpawnRadius(spawnRadius: number): number {
  return demoBaseRingRadiusFromOuterSpawnRadius(
    spawnRadius,
    DEMO_CONFIG.baseRings.unitCommander.radiusFraction,
  );
}

function demoBaseRingRadiusFromOuterSpawnRadius(
  spawnRadius: number,
  radiusFraction: number,
): number {
  return spawnRadius * radiusFraction;
}

/** Commander placement radius for a map of the given dimensions.
 *  DEMO BATTLE and REAL BATTLE intentionally share
 *  `DEMO_CONFIG.baseRings.unitCommander.radiusFraction`, so changing the demo
 *  commander ring changes the real-battle ring and camera pre-framing
 *  at the same time. */
function commanderRadiusForMap(mapWidth: number, mapHeight: number): number {
  const spawnRadius =
    makeMapOvalMetrics(mapWidth, mapHeight).minDim / 2 -
    DEMO_CONFIG.spawnMarginPx;
  return commanderRadiusFromOuterSpawnRadius(spawnRadius);
}

/** World-space spawn position for seat `i` of a `playerCount`-player
 *  game on a map of the given dimensions. Stateless mirror of the
 *  internal `getSpawnPositions` helper, exposed so the 3D scene can
 *  pre-frame each client's camera on its own commander BEFORE the
 *  first snapshot arrives — without that, the camera stays centered
 *  on the map mid and the joiner's commander spawns off-frustum on
 *  the periphery. The radial-sector layout uses the same oval as
 *  `getDemoOval`. */
export function getSpawnPositionForSeat(
  roster: TeamRoster,
  playerId: PlayerId,
  mapWidth: number,
  mapHeight: number,
): { x: number; y: number } {
  const radius = commanderRadiusForMap(mapWidth, mapHeight);
  const angle = getSeatBaseAngle(roster, playerId);
  return mapOvalPointAt(makeMapOvalMetrics(mapWidth, mapHeight), angle, radius);
}

// Calculate spawn positions on the spawn oval for N players. Used
// for the REAL BATTLE flow (just commanders). The commander ring is
// shared with demo battle through DEMO_CONFIG.baseRings.unitCommander.
function getSpawnPositions(
  world: WorldState,
  playerIds: readonly PlayerId[],
): { x: number; y: number; facingAngle: number }[] {
  const cx = world.mapWidth / 2;
  const cy = world.mapHeight / 2;
  const oval = makeMapOvalMetrics(world.mapWidth, world.mapHeight);
  const radius = commanderRadiusForMap(world.mapWidth, world.mapHeight);
  const positions: { x: number; y: number; facingAngle: number }[] = [];
  for (let i = 0; i < playerIds.length; i++) {
    const angle = getSeatBaseAngle(world.teamRoster, playerIds[i]);
    const point = mapOvalPointAt(oval, angle, radius);
    positions.push({
      x: point.x,
      y: point.y,
      facingAngle: DMath.atan2(cy - point.y, cx - point.x),
    });
  }
  return positions;
}

// Place a pre-built (complete) building at a world position
function placeCompleteBuilding(
  world: WorldState,
  construction: ConstructionSystem,
  buildingBlueprintId: BuildingBlueprintId,
  worldX: number,
  worldY: number,
  playerId: PlayerId,
  basePolicy: InitialBasePolicy,
  searchOffsets: readonly GridOffset[] = INITIAL_BASE_PLACEMENT_SEARCH_OFFSETS,
  acceptCompleted: ((entity: Entity) => boolean) | null = null,
  acceptCandidate: ((x: number, y: number) => boolean) | null = null,
  ignoreTerrainForPlacement = false,
): Entity | null {
  const config = getBuildingConfig(buildingBlueprintId);
  const placementFootprint = getRotatedBuildingPlacementFootprint(
    config.placementFootprint,
    0,
  );
  const grid = construction.getGrid();
  const snapped = grid.snapToGrid(worldX, worldY, config.placementGridWidth, config.placementGridHeight);
  const baseGrid = grid.worldToGrid(snapped.x, snapped.y);

  for (let i = 0; i < searchOffsets.length; i++) {
    const offset = searchOffsets[i];
    const candidateGridX = baseGrid.gx + offset.dx;
    const candidateGridY = baseGrid.gy + offset.dy;
    // Demo factory rows can probe thousands of offsets. Occupancy and map
    // bounds are already authoritative in BuildingGrid, so reject those
    // candidates before startBuilding allocates a full per-cell terrain/
    // metal diagnostic packet. This is an exact preflight, not a second
    // placement rule: every candidate that passes is still validated by the
    // normal ConstructionSystem path below.
    if (!grid.canPlaceFootprint(
      candidateGridX,
      candidateGridY,
      placementFootprint,
    )) continue;
    if (!buildingFootprintAvoidsCommanderExclusions(
      candidateGridX,
      candidateGridY,
      placementFootprint,
      basePolicy.commanderBuildingExclusions,
    )) continue;
    if (acceptCandidate !== null) {
      const candidate = grid.getBuildingCenter(
        candidateGridX,
        candidateGridY,
        config.placementGridWidth,
        config.placementGridHeight,
      );
      if (!acceptCandidate(candidate.x, candidate.y)) continue;
    }
    const entity = construction.startBuilding(
      world,
      buildingBlueprintId,
      candidateGridX,
      candidateGridY,
      playerId,
      0,
      0,
      {
        skipBuilderAuthorization: true,
        ignoreTerrainForPlacement,
      },
    );
    if (entity === null) continue;
    completeInitialBuilding(world, entity, config, basePolicy);
    if (acceptCompleted !== null && !acceptCompleted(entity)) {
      construction.onBuildingDestroyed(world, entity);
      world.removeEntity(entity.id);
      continue;
    }
    return entity;
  }

  return null;
}

/** Keep the entire authored reservation mask outside every commander spawn
 * circle. Testing cells rather than only building centers also covers large,
 * irregular, and hovering footprints without inventing a second radius. */
function buildingFootprintAvoidsCommanderExclusions(
  gridX: number,
  gridY: number,
  footprint: ReturnType<typeof getRotatedBuildingPlacementFootprint>,
  exclusions: readonly CommanderBuildingExclusion[],
): boolean {
  if (exclusions.length === 0) return true;
  for (let cellIndex = 0; cellIndex < footprint.cells.length; cellIndex++) {
    const cell = footprint.cells[cellIndex];
    const left = (gridX + cell.dx) * BUILD_GRID_CELL_SIZE;
    const top = (gridY + cell.dy) * BUILD_GRID_CELL_SIZE;
    const right = left + BUILD_GRID_CELL_SIZE;
    const bottom = top + BUILD_GRID_CELL_SIZE;
    for (let exclusionIndex = 0; exclusionIndex < exclusions.length; exclusionIndex++) {
      const exclusion = exclusions[exclusionIndex];
      const nearestX = Math.max(left, Math.min(exclusion.x, right));
      const nearestY = Math.max(top, Math.min(exclusion.y, bottom));
      const dx = exclusion.x - nearestX;
      const dy = exclusion.y - nearestY;
      if (dx * dx + dy * dy < exclusion.radius * exclusion.radius) return false;
    }
  }
  return true;
}

function completeInitialBuilding(
  world: WorldState,
  entity: Entity,
  config: ReturnType<typeof getBuildingConfig>,
  basePolicy: InitialBasePolicy,
): void {
  if (entity.buildable) {
    entity.buildable.paid = { ...entity.buildable.required };
    entity.buildable.isComplete = true;
    entity.buildable.healthBuildFraction = 1;
  }
  if (entity.building) {
    entity.building.hp = config.hp;
    entity.building.maxHp = config.hp;
  }

  if (entity.factory) {
    const defaultWaypoints = computeFactoryDefaultWaypoints(
      entity.transform.x,
      entity.transform.y,
      world.mapWidth,
      world.mapHeight,
      basePolicy,
    );
    setFactoryDefaultWaypoints(entity, defaultWaypoints);
  }

  applyCompletedBuildingEffects(world, entity);

  // Pre-placed hosts the base authored as switched OFF. This runs after
  // completion on purpose: applyCompletedBuildingEffects puts every ON/OFF
  // host into the shared activation pose (switch ON, debounce primed), and
  // the authored OFF is a standing player-style order on top of that — the
  // same call the ON/OFF button makes, so the host fortifies and parks its
  // timers exactly as a manual switch-off would. Only pre-placed initial-base
  // buildings reach here; anything constructed during play completes ON.
  const blueprintId = entity.buildingBlueprintId;
  if (
    blueprintId !== null &&
    basePolicy.initiallyOffBuildingBlueprintIds.has(blueprintId)
  ) {
    setBuildingActiveOpen(world, entity, false);
  }

  entity.buildable = null;
}

function setFactoryDefaultWaypoints(
  entity: Entity,
  defaultWaypoints: readonly FactoryDefaultWaypoint[],
): void {
  if (entity.factory === null || defaultWaypoints.length === 0) return;
  const rally = defaultWaypoints[0];
  entity.factory.defaultWaypoints = defaultWaypoints;
  entity.factory.rallyX = rally.x;
  entity.factory.rallyY = rally.y;
  entity.factory.rallyZ = rally.z;
  entity.factory.rallyType = rally.type === 'guard' ? 'move' : rally.type;
}

// (Building rows replaced by per-player arcs along the spawn oval —
// see spawnInitialBases below.)

// Spawn initial entities for the game with N players (commander only)
export function spawnInitialEntities(world: WorldState, playerIds: PlayerId[] = [1, 2]): Entity[] {
  const entities: Entity[] = [];
  const normalizedPlayerIds = normalizePlayerIds(playerIds);

  // Raise, never lower: bootstrap may call this with a SUBSET of seats (the
  // commander-start half of a mixed roster) after the world already knows
  // the full count. Standalone callers on a fresh world still get it set.
  world.playerCount = Math.max(world.playerCount, normalizedPlayerIds.length);

  for (const playerId of normalizedPlayerIds) {
    economyManager.initPlayer(playerId);
  }

  const spawnPositions = getSpawnPositions(world, normalizedPlayerIds);

  for (let i = 0; i < normalizedPlayerIds.length; i++) {
    const playerId = normalizedPlayerIds[i];
    const pos = spawnPositions[i];
    const commander = spawnCommander(world, playerId, pos.x, pos.y, pos.facingAngle);
    entities.push(commander);
  }

  return entities;
}

/**
 * Place a row of buildings evenly distributed across an angular arc on
 * the map oval. Each building faces toward the oval's center.
 * Buildings overlap-snap-skip the same
 * way they do in placeCompleteBuilding (returns null if no grid fit).
 */
function placeArcRow(
  world: WorldState,
  construction: ConstructionSystem,
  buildingBlueprintId: BuildingBlueprintId,
  count: number,
  oval: MapOvalMetrics,
  radius: number,
  baseAngle: number,
  sectorAngle: number,
  playerId: PlayerId,
  basePolicy: InitialBasePolicy,
  searchOffsets: readonly GridOffset[] = INITIAL_BASE_PLACEMENT_SEARCH_OFFSETS,
  acceptCandidate: ((x: number, y: number) => boolean) | null = null,
  ignoreTerrainForPlacement = false,
): Entity[] {
  if (count <= 0) return [];
  const entities: Entity[] = [];
  const startAngle = baseAngle - sectorAngle / 2;
  const angularStep = count > 1 ? sectorAngle / (count - 1) : 0;
  for (let j = 0; j < count; j++) {
    const a = count > 1 ? startAngle + j * angularStep : baseAngle;
    const point = mapOvalPointAt(oval, a, radius);
    const e = placeCompleteBuilding(
      world,
      construction,
      buildingBlueprintId,
      point.x,
      point.y,
      playerId,
      basePolicy,
      searchOffsets,
      null,
      acceptCandidate,
      ignoreTerrainForPlacement,
    );
    if (e) entities.push(e);
  }
  return entities;
}

/** Place one of each blueprint across a shared showcase arc. Unlike the
 * bespoke homogeneous rows, the registry-derived supplemental row may mix
 * footprints and support anchors. Each item therefore runs through its own
 * canonical building config and ordinary ConstructionSystem placement. */
function placeMixedBlueprintArcRow(
  world: WorldState,
  construction: ConstructionSystem,
  buildingBlueprintIds: readonly BuildingBlueprintId[],
  oval: MapOvalMetrics,
  radius: number,
  baseAngle: number,
  sectorAngle: number,
  playerId: PlayerId,
  basePolicy: InitialBasePolicy,
  searchOffsets: readonly GridOffset[],
  squareType: 'ground' | 'water',
): Entity[] {
  const count = buildingBlueprintIds.length;
  if (count === 0) return [];
  const entities: Entity[] = [];
  const startAngle = baseAngle - sectorAngle / 2;
  const angularStep = count > 1 ? sectorAngle / (count - 1) : 0;
  for (let i = 0; i < count; i++) {
    const buildingBlueprintId = buildingBlueprintIds[i];
    const config = getBuildingConfig(buildingBlueprintId);
    const angle = count > 1 ? startAngle + i * angularStep : baseAngle;
    const point = mapOvalPointAt(oval, angle, radius);
    const width = config.placementGridWidth * BUILD_GRID_CELL_SIZE;
    const height = config.placementGridHeight * BUILD_GRID_CELL_SIZE;
    const entity = placeCompleteBuilding(
      world,
      construction,
      buildingBlueprintId,
      point.x,
      point.y,
      playerId,
      basePolicy,
      searchOffsets,
      null,
      squareType === 'water'
        ? (x, y) => isRectFootprintOverWater(world, x, y, width, height)
        : (x, y) => isRectFootprintOverLand(world, x, y, width, height),
      // These are prebuilt authored showcase rows. The medium preflight above,
      // map bounds, and occupancy remain hard requirements; terrain slope and
      // ordinary player-build restrictions must not silently omit a roster id.
      true,
    );
    if (entity !== null) entities.push(entity);
  }
  return entities;
}

function getAvailableDemoFactoryUnitBlueprintIds(
  availableUnitBlueprintIds: ReadonlySet<string> | undefined = undefined,
  excludedUnitBlueprintIds: ReadonlySet<string> | undefined = undefined,
): string[] {
  const unitBlueprintIds: string[] = [];
  const factoryRoster = getStructureFactoryAllowedUnitBlueprintIds('towerFabricator');
  for (let i = 0; i < factoryRoster.length; i++) {
    const unitBlueprintId = factoryRoster[i];
    if (availableUnitBlueprintIds !== undefined && !availableUnitBlueprintIds.has(unitBlueprintId)) continue;
    if (excludedUnitBlueprintIds?.has(unitBlueprintId)) continue;
    unitBlueprintIds.push(unitBlueprintId);
  }
  return unitBlueprintIds;
}

function seedFactoryRepeatBuild(factory: Entity, unitBlueprintId: string): void {
  if (!factory.factory) return;
  factory.factory.selectedUnitBlueprintId = unitBlueprintId;
  factory.factory.productionQueue.length = 0;
  factory.factory.repeatProduction = true;
}

function assertPlacedFactoriesRepeat(
  factories: readonly Entity[],
  playerId: PlayerId,
): void {
  for (let i = 0; i < factories.length; i++) {
    const factory = factories[i].factory;
    if (factory === null || factory === undefined) {
      throw new Error(`Demo base factory for player ${playerId} must have factory state`);
    }
    const selected = factory.selectedUnitBlueprintId;
    if (factory.repeatProduction !== true || selected === null) {
      throw new Error(`Demo base factory for player ${playerId} must start in repeat production`);
    }
  }
}

function placeFactoryArcRowForUnitBlueprintIds(
  world: WorldState,
  construction: ConstructionSystem,
  unitBlueprintIds: readonly string[],
  oval: MapOvalMetrics,
  radius: number,
  baseAngle: number,
  sectorAngle: number,
  playerId: PlayerId,
  basePolicy: InitialBasePolicy,
  searchOffsets: readonly GridOffset[] = INITIAL_BASE_PLACEMENT_SEARCH_OFFSETS,
  acceptCompleted: ((entity: Entity) => boolean) | null = null,
  acceptCandidate: ((x: number, y: number) => boolean) | null = null,
  fallbackToAuthoredArea = false,
): Entity[] {
  const count = unitBlueprintIds.length;
  if (count <= 0) return [];
  const entities: Entity[] = [];
  const startAngle = baseAngle - sectorAngle / 2;
  const angularStep = count > 1 ? sectorAngle / (count - 1) : 0;

  for (let j = 0; j < count; j++) {
    const a = count > 1 ? startAngle + j * angularStep : baseAngle;
    const point = mapOvalPointAt(oval, a, radius);
    let factory = placeCompleteBuilding(
      world,
      construction,
      'towerFabricator',
      point.x,
      point.y,
      playerId,
      basePolicy,
      searchOffsets,
      acceptCompleted,
      acceptCandidate,
    );
    if (factory === null && fallbackToAuthoredArea) {
      // Terrain can invalidate an entire search patch (dry outer-water rings,
      // steep divider shoulders, or a highly deformed land arc), but the demo
      // contract requires one production line per enabled unit. Retry on the
      // same authored arc while bypassing only terrain suitability; map bounds
      // and occupied grid cells remain enforced.
      factory = placeCompleteBuilding(
        world,
        construction,
        'towerFabricator',
        point.x,
        point.y,
        playerId,
        basePolicy,
        searchOffsets,
        null,
        null,
        true,
      );
    }
    if (!factory) continue;
    seedFactoryRepeatBuild(factory, unitBlueprintIds[j]);
    entities.push(factory);
  }

  return entities;
}

function isFabricatorOverWater(world: WorldState, entity: Entity): boolean {
  const building = entity.building;
  if (building === null) return false;
  return isFabricatorFootprintOverWater(
    world,
    entity.transform.x,
    entity.transform.y,
    building.width,
    building.height,
  );
}

function isFabricatorFootprintOverWater(
  world: WorldState,
  x: number,
  y: number,
  width: number,
  height: number,
): boolean {
  const sampleRadius = fabricatorTorusOuterRadius(width, height) * 0.72;
  for (let i = 0; i < 8; i++) {
    const angle = i * Math.PI / 4;
    const sampleX = x + DMath.cos(angle) * sampleRadius;
    const sampleY = y + DMath.sin(angle) * sampleRadius;
    if (!isWaterAt(sampleX, sampleY, world.mapWidth, world.mapHeight)) return false;
  }
  return isWaterAt(x, y, world.mapWidth, world.mapHeight);
}

/** Fully-dry counterpart of isFabricatorFootprintOverWater: the center AND
 *  every torus sample must be dry. Used by the lava-world land factory arc,
 *  where a Fabricator straddling the shoreline would hover over molten rock
 *  and drop its produced land units straight into it. */
function isFabricatorFootprintOverLand(
  world: WorldState,
  x: number,
  y: number,
  width: number,
  height: number,
): boolean {
  const sampleRadius = fabricatorTorusOuterRadius(width, height) * 0.72;
  for (let i = 0; i < 8; i++) {
    const angle = i * Math.PI / 4;
    const sampleX = x + DMath.cos(angle) * sampleRadius;
    const sampleY = y + DMath.sin(angle) * sampleRadius;
    if (isWaterAt(sampleX, sampleY, world.mapWidth, world.mapHeight)) return false;
  }
  return !isWaterAt(x, y, world.mapWidth, world.mapHeight);
}

function isRectFootprintOverWater(
  world: WorldState,
  x: number,
  y: number,
  width: number,
  height: number,
): boolean {
  const halfWidth = width * 0.5;
  const halfHeight = height * 0.5;
  return isWaterAt(x, y, world.mapWidth, world.mapHeight) &&
    isWaterAt(x - halfWidth, y - halfHeight, world.mapWidth, world.mapHeight) &&
    isWaterAt(x + halfWidth, y - halfHeight, world.mapWidth, world.mapHeight) &&
    isWaterAt(x - halfWidth, y + halfHeight, world.mapWidth, world.mapHeight) &&
    isWaterAt(x + halfWidth, y + halfHeight, world.mapWidth, world.mapHeight);
}

function isRectFootprintOverLand(
  world: WorldState,
  x: number,
  y: number,
  width: number,
  height: number,
): boolean {
  const halfWidth = width * 0.5;
  const halfHeight = height * 0.5;
  return !isWaterAt(x, y, world.mapWidth, world.mapHeight) &&
    !isWaterAt(x - halfWidth, y - halfHeight, world.mapWidth, world.mapHeight) &&
    !isWaterAt(x + halfWidth, y - halfHeight, world.mapWidth, world.mapHeight) &&
    !isWaterAt(x - halfWidth, y + halfHeight, world.mapWidth, world.mapHeight) &&
    !isWaterAt(x + halfWidth, y + halfHeight, world.mapWidth, world.mapHeight);
}

function configureOuterWaterFactoryWaypoints(
  world: WorldState,
  entity: Entity,
  oval: MapOvalMetrics,
  radius: number,
): void {
  const angle = mapOvalAngleAt(
    world.mapWidth,
    world.mapHeight,
    entity.transform.x,
    entity.transform.y,
  );
  const patrolArc = Math.PI / Math.max(2, world.playerCount);
  const forward = mapOvalPointAt(oval, angle + patrolArc, radius);
  const backward = mapOvalPointAt(oval, angle - patrolArc, radius);
  setFactoryDefaultWaypoints(entity, [
    { x: forward.x, y: forward.y, z: null, type: 'patrol' },
    { x: backward.x, y: backward.y, z: null, type: 'patrol' },
  ]);
}

/**
 * Spawn a full base for each player on concentric oval arcs centered
 * on the map. Each ring's radius comes directly from DEMO_CONFIG:
 *
 *           commander  ← outermost
 *           solar arc
 *           wind arc
 *           fabricator arc
 *           resource converter arc
 *           megaBeam defense arc
 *           cannon defense arc ← closest to map center
 *
 * Each arc spans the same angular sector for the player, and every
 * building faces the map center. Structure counts and oval radius
 * fractions are controlled by DEMO_CONFIG. Fabricators are derived from the
 * active demo unit roster: one fabricator per available unit blueprint, seeded
 * to repeat-build that unit.
 */
export function spawnInitialBases(
  world: WorldState,
  construction: ConstructionSystem,
  playerIds: PlayerId[],
  mode: InitialBaseMode = 'demo',
  availableUnitBlueprintIds: ReadonlySet<string> | undefined = undefined,
  availableBuildingBlueprintIds: ReadonlySet<string> | undefined = undefined,
): Entity[] {
  const entities: Entity[] = [];

  // Demo BUILDINGS toggles: an undefined set means "place every building"
  // (unrestricted callers / real games). A defined set skips disabled ids.
  const isBuildingEnabled = (id: string): boolean =>
    availableBuildingBlueprintIds === undefined || availableBuildingBlueprintIds.has(id);

  const normalizedPlayerIds = normalizePlayerIds(playerIds);

  // Raise, never lower — bootstrap may pass only the 'base' seats of a
  // mixed roster (see spawnInitialEntities for the same rule).
  world.playerCount = Math.max(world.playerCount, normalizedPlayerIds.length);

  for (const playerId of normalizedPlayerIds) {
    economyManager.initPlayer(playerId);
  }

  const playerCount = normalizedPlayerIds.length;
  const { oval, radius: spawnRadius } = getDemoOval(world);
  const { cx, cy } = oval;
  // No water on this map — because nothing digs below datum, or because the
  // liquid is molten rock — and the demo spawns nothing that belongs in or on
  // it. The offshore Fabricator arc (the water-unit production lines) and its
  // Sonar ring are omitted entirely; every Fabricator the demo still places is
  // a land line on the land factory ring. A map with water keeps the authored
  // offshore installation. `mapHasWater()` owns which maps those are.
  const hasWater = mapHasWater();
  // Losing the offshore arc must not lose the hulls that never needed it. The
  // arc's roster is a mixed bag — an amphibian and an aerosub alongside the two
  // submarines — and only the submarines have nowhere to be on a dry map. So
  // when the arc is gone, nothing is held back FROM the land ring either: the
  // land ring draws from the factory roster, which `mapHasWater()` has already
  // narrowed, so the submarines stay gone and the rest simply move ashore.
  const landFactoryExclusions = new Set<string>(
    hasWater ? DEMO_CONFIG.waterFabricators.unitBlueprintIds : [],
  );
  // Narrower than `!hasWater`: only LAVA actively burns what stands in it, so
  // only lava makes an over-land footprint a requirement rather than a
  // formality. A dry map has no wet cells to avoid in the first place.
  const lavaLiquid = world.liquidSurfaceMode === 'lava';
  const supplementalGroundBuildingBlueprintIds =
    getDemoSupplementalBuildingBlueprintIds(
      'ground',
      availableBuildingBlueprintIds,
    );
  const supplementalWaterBuildingBlueprintIds = hasWater
    ? getDemoSupplementalBuildingBlueprintIds(
      'water',
      availableBuildingBlueprintIds,
    )
    : [];
  const waterFactoryUnitBlueprintIds = hasWater
    ? DEMO_CONFIG.waterFabricators.unitBlueprintIds.filter(
      (id) => availableUnitBlueprintIds === undefined || availableUnitBlueprintIds.has(id),
    )
    : [];
  const factoryUnitBlueprintIds = getAvailableDemoFactoryUnitBlueprintIds(
    availableUnitBlueprintIds,
    landFactoryExclusions,
  );
  const fabricatorConfig = getBuildingConfig('towerFabricator');
  const fabricatorWidth = fabricatorConfig.gridWidth * BUILD_GRID_CELL_SIZE;
  const fabricatorHeight = fabricatorConfig.gridHeight * BUILD_GRID_CELL_SIZE;

  // Concentric radii — each ring is explicit so the demo layout can be
  // tuned the same way metal deposit rings are tuned.
  const commanderRadius = commanderRadiusFromOuterSpawnRadius(spawnRadius);
  const commanderPoints = normalizedPlayerIds.map((playerId) =>
    mapOvalPointAt(
      oval,
      getSeatBaseAngle(world.teamRoster, playerId),
      commanderRadius,
    ));
  const basePolicy = getInitialBasePolicy(
    mode,
    mode === 'demo'
      ? commanderPoints.map((point) => commanderBuildingExclusionAt(point.x, point.y))
      : [],
  );
  const solarRadius = demoBaseRingRadiusFromOuterSpawnRadius(
    spawnRadius,
    DEMO_CONFIG.baseRings.buildingSolar.radiusFraction,
  );
  const windRadius = demoBaseRingRadiusFromOuterSpawnRadius(
    spawnRadius,
    DEMO_CONFIG.baseRings.buildingWind.radiusFraction,
  );
  const supplementalGroundRadius = demoBaseRingRadiusFromOuterSpawnRadius(
    spawnRadius,
    DEMO_CONFIG.baseRings.supplementalGround.radiusFraction,
  );
  const factoryRadius = demoBaseRingRadiusFromOuterSpawnRadius(
    spawnRadius,
    DEMO_CONFIG.baseRings.towerFabricator.radiusFraction,
  );
  const waterFactoryRadius = demoBaseRingRadiusFromOuterSpawnRadius(
    spawnRadius,
    DEMO_CONFIG.waterFabricators.radiusFraction,
  );
  const radarRadius = demoBaseRingRadiusFromOuterSpawnRadius(
    spawnRadius,
    DEMO_CONFIG.baseRings.buildingRadar.radiusFraction,
  );
  const authoredSonarRadius = demoBaseRingRadiusFromOuterSpawnRadius(
    spawnRadius,
    DEMO_CONFIG.waterFabricators.sonarRadiusFraction,
  );
  const supplementalWaterRadius = demoBaseRingRadiusFromOuterSpawnRadius(
    spawnRadius,
    DEMO_CONFIG.baseRings.supplementalWater.radiusFraction,
  );
  const megaBeamTowerRadius = demoBaseRingRadiusFromOuterSpawnRadius(
    spawnRadius,
    DEMO_CONFIG.baseRings.towerBeamMega.radiusFraction,
  );
  const cannonTowerRadius = demoBaseRingRadiusFromOuterSpawnRadius(
    spawnRadius,
    DEMO_CONFIG.baseRings.towerCannon.radiusFraction,
  );
  const antiAirTowerRadius = demoBaseRingRadiusFromOuterSpawnRadius(
    spawnRadius,
    DEMO_CONFIG.baseRings.towerAntiAir.radiusFraction,
  );
  const resourceConverterRadius = demoBaseRingRadiusFromOuterSpawnRadius(
    spawnRadius,
    DEMO_CONFIG.baseRings.buildingResourceConverter.radiusFraction,
  );
  const shieldTargetingTechRadius = demoBaseRingRadiusFromOuterSpawnRadius(
    spawnRadius,
    DEMO_CONFIG.baseRings.buildingShieldTargetingTech.radiusFraction,
  );
  const shieldTechRadius = demoBaseRingRadiusFromOuterSpawnRadius(
    spawnRadius,
    DEMO_CONFIG.baseRings.buildingShieldTech.radiusFraction,
  );
  const precisionTargetingTechRadius = demoBaseRingRadiusFromOuterSpawnRadius(
    spawnRadius,
    DEMO_CONFIG.baseRings.buildingPrecisionTargetingTech.radiusFraction,
  );

  for (let i = 0; i < playerCount; i++) {
    const playerId = normalizedPlayerIds[i];
    const baseAngle = getSeatBaseAngle(world.teamRoster, playerId);
    const sectorAngle = getSeatBuildArcAngle(
      world.teamRoster,
      playerId,
      DEMO_CONFIG.arcSectorFraction,
    );
    // Teammates share one build slice. Give each factory row only its seat's
    // subdivision so rows meet at their boundaries instead of overlapping.
    const factorySectorAngle = getSeatBuildArcAngle(
      world.teamRoster,
      playerId,
      1,
    );

    // Commander: single entity at the player's spawn point on the outer
    // oval, facing the map center.
    const cmdPoint = commanderPoints[i];
    const cmdFacing = DMath.atan2(cy - cmdPoint.y, cx - cmdPoint.x);
    const commander = spawnCommander(
      world,
      playerId,
      cmdPoint.x,
      cmdPoint.y,
      cmdFacing,
    );
    entities.push(commander);

    // Wind turbine arc — independent radius so its silhouette reads on
    // its own ring, not interleaved with the solars.
    if (isBuildingEnabled('buildingWind')) {
      entities.push(...placeArcRow(
        world, construction, 'buildingWind', DEMO_CONFIG.buildingWindCount,
        oval, windRadius, baseAngle, sectorAngle, playerId, basePolicy,
      ));
    }

    entities.push(...placeMixedBlueprintArcRow(
      world,
      construction,
      supplementalGroundBuildingBlueprintIds,
      oval,
      supplementalGroundRadius,
      baseAngle,
      sectorAngle,
      playerId,
      basePolicy,
      FACTORY_PLACEMENT_SEARCH_OFFSETS,
      'ground',
    ));

    // ── The radar↔beam band ─────────────────────────────────────────
    // The radar (0.65) and beam-tower (0.40) rings are fixed endpoints;
    // between them six rows — targeting-tech spire, shield forge,
    // anti-air, converter, solar, cannon — sit on evenly spaced rings
    // (steps of 0.25/7). The tech pair grants the seat shield-aware
    // targeting and shielded production, so the demo exercises both
    // upgrades live. Two rules keep the tightened band stable:
    //   1. Rows place in STRICT outer→inner radial order, so a row's
    //      preferred cells are claimed before its inner neighbour's
    //      search can squat on them.
    //   2. Every band row uses the wide factory search offsets, so a
    //      cell lost to a deposit pad or cramped terrain slides to the
    //      nearest free cells instead of silently failing best-effort
    //      placement.
    // Outside the radar↔beam band on its own ring, so the band's strict
    // outer→inner claim order is untouched.
    if (isBuildingEnabled('buildingPrecisionTargetingTech')) {
      entities.push(...placeArcRow(
        world, construction, 'buildingPrecisionTargetingTech',
        DEMO_CONFIG.buildingPrecisionTargetingTechCount,
        oval, precisionTargetingTechRadius, baseAngle, sectorAngle, playerId, basePolicy,
        FACTORY_PLACEMENT_SEARCH_OFFSETS,
      ));
    }
    if (isBuildingEnabled('buildingRadar')) {
      entities.push(...placeArcRow(
        world, construction, 'buildingRadar', DEMO_CONFIG.buildingRadarCount,
        oval, radarRadius, baseAngle, sectorAngle, playerId, basePolicy,
        FACTORY_PLACEMENT_SEARCH_OFFSETS,
      ));
    }
    if (isBuildingEnabled('buildingShieldTargetingTech')) {
      entities.push(...placeArcRow(
        world, construction, 'buildingShieldTargetingTech',
        DEMO_CONFIG.buildingShieldTargetingTechCount,
        oval, shieldTargetingTechRadius, baseAngle, sectorAngle, playerId, basePolicy,
        FACTORY_PLACEMENT_SEARCH_OFFSETS,
      ));
    }
    if (isBuildingEnabled('buildingShieldTech')) {
      entities.push(...placeArcRow(
        world, construction, 'buildingShieldTech',
        DEMO_CONFIG.buildingShieldTechCount,
        oval, shieldTechRadius, baseAngle, sectorAngle, playerId, basePolicy,
        FACTORY_PLACEMENT_SEARCH_OFFSETS,
      ));
    }
    if (isBuildingEnabled('towerAntiAir')) {
      entities.push(...placeArcRow(
        world, construction, 'towerAntiAir', DEMO_CONFIG.towerAntiAirCount,
        oval, antiAirTowerRadius, baseAngle, sectorAngle, playerId, basePolicy,
        FACTORY_PLACEMENT_SEARCH_OFFSETS,
      ));
    }
    if (isBuildingEnabled('buildingResourceConverter')) {
      entities.push(...placeArcRow(
        world, construction, 'buildingResourceConverter', DEMO_CONFIG.buildingResourceConverterCount,
        oval, resourceConverterRadius, baseAngle, sectorAngle, playerId, basePolicy,
        FACTORY_PLACEMENT_SEARCH_OFFSETS,
      ));
    }
    if (isBuildingEnabled('buildingSolar')) {
      entities.push(...placeArcRow(
        world, construction, 'buildingSolar', DEMO_CONFIG.buildingSolarCount,
        oval, solarRadius, baseAngle, sectorAngle, playerId, basePolicy,
        FACTORY_PLACEMENT_SEARCH_OFFSETS,
      ));
    }
    if (isBuildingEnabled('towerCannon')) {
      entities.push(...placeArcRow(
        world, construction, 'towerCannon', DEMO_CONFIG.towerCannonCount,
        oval, cannonTowerRadius, baseAngle, sectorAngle, playerId, basePolicy,
        FACTORY_PLACEMENT_SEARCH_OFFSETS,
      ));
    }
    if (isBuildingEnabled('towerBeamMega')) {
      entities.push(...placeArcRow(
        world, construction, 'towerBeamMega', DEMO_CONFIG.towerBeamMegaCount,
        oval, megaBeamTowerRadius, baseAngle, sectorAngle, playerId, basePolicy,
        FACTORY_PLACEMENT_SEARCH_OFFSETS,
      ));
    }

    // Fabricator arcs — attempt one Fabricator per available demo unit.
    // Water-capable lines use the outer-water ring; every other line uses the
    // land ring inside this seat's part of the team sector. Each successfully
    // placed factory begins repeat production of its assigned unit.
    // Each fabricator starts with a repeat-build selection matching
    // its unit blueprint, so the base layout and AI production inventory
    // stay tied to the same unit roster. Disabling the towerFabricator
    // building id removes the demo's whole factory ring.
    let waterFactories: Entity[] = [];
    if (isBuildingEnabled('towerFabricator')) {
      // Offshore factories are inserted first so the deterministic factory
      // update order is stable across every one-per-unit production line.
      waterFactories = placeFactoryArcRowForUnitBlueprintIds(
        world,
        construction,
        waterFactoryUnitBlueprintIds,
        oval,
        waterFactoryRadius,
        baseAngle,
        getSeatBuildArcAngle(
          world.teamRoster,
          playerId,
          DEMO_CONFIG.waterFabricators.arcSectorFraction,
        ),
        playerId,
        basePolicy,
        WATER_FACTORY_PLACEMENT_SEARCH_OFFSETS,
        (entity) => isFabricatorOverWater(world, entity),
        (x, y) => isFabricatorFootprintOverWater(
          world,
          x,
          y,
          fabricatorWidth,
          fabricatorHeight,
        ),
        true,
      );
      for (let j = 0; j < waterFactories.length; j++) {
        const factory = waterFactories[j];
        if (factory.factory !== null) {
          configureOuterWaterFactoryWaypoints(
            world,
            factory,
            oval,
            waterFactoryRadius,
          );
        }
      }
      const landFactories = placeFactoryArcRowForUnitBlueprintIds(
        world, construction, factoryUnitBlueprintIds,
        oval, factoryRadius, baseAngle, factorySectorAngle, playerId, basePolicy,
        FACTORY_PLACEMENT_SEARCH_OFFSETS,
        null,
        // On a lava world every Fabricator must sit fully over land: a line
        // whose authored arc cell is flooded slides to the nearest dry cells
        // instead. The authored-arc fallback below still runs if the whole
        // search patch is molten, because a missing production line is worse
        // for the demo than a scorched one.
        lavaLiquid
          ? (x, y) => isFabricatorFootprintOverLand(
            world,
            x,
            y,
            fabricatorWidth,
            fabricatorHeight,
          )
          : null,
        true,
      );
      // Placement remains best-effort: unusually small maps or dense custom
      // rosters may not have room for every decorative demo production line.
      // A skipped line must never abort creation of the lobby background.
      assertPlacedFactoriesRepeat(
        [...waterFactories, ...landFactories],
        playerId,
      );
      entities.push(...waterFactories, ...landFactories);
    }

    // One Sonar sits immediately outside the offshore Fabricator arc.
    // Use their actual post-grid-snap radius, then add both collision radii
    // plus one grid cell so the installation remains visually separated.
    // Sonar is a water-surface building, so a map with no water places none.
    if (hasWater && isBuildingEnabled('buildingSonar')) {
      let outermostWaterFactoryRadius = waterFactoryRadius;
      for (let j = 0; j < waterFactories.length; j++) {
        const factory = waterFactories[j];
        outermostWaterFactoryRadius = Math.max(
          outermostWaterFactoryRadius,
          sampleMapOvalAt(
            oval,
            factory.transform.x,
            factory.transform.y,
          ).distance,
        );
      }
      const sonarConfig = getBuildingConfig('buildingSonar');
      const sonarRadius = Math.max(
        authoredSonarRadius,
        outermostWaterFactoryRadius +
          fabricatorConfig.radius.collision +
          sonarConfig.radius.collision +
          BUILD_GRID_CELL_SIZE,
      );
      const sonarWidth = sonarConfig.gridWidth * BUILD_GRID_CELL_SIZE;
      const sonarHeight = sonarConfig.gridHeight * BUILD_GRID_CELL_SIZE;
      entities.push(...placeArcRow(
        world, construction, 'buildingSonar', DEMO_CONFIG.buildingSonarCount,
        oval, sonarRadius, baseAngle, sectorAngle, playerId, basePolicy,
        WATER_FACTORY_PLACEMENT_SEARCH_OFFSETS,
        (x, y) =>
          sampleMapOvalAt(oval, x, y).distance >= sonarRadius &&
          isRectFootprintOverWater(world, x, y, sonarWidth, sonarHeight),
        true,
      ));
    }

    if (hasWater) {
      entities.push(...placeMixedBlueprintArcRow(
        world,
        construction,
        supplementalWaterBuildingBlueprintIds,
        oval,
        supplementalWaterRadius,
        baseAngle,
        getSeatBuildArcAngle(
          world.teamRoster,
          playerId,
          DEMO_CONFIG.waterFabricators.arcSectorFraction,
        ),
        playerId,
        basePolicy,
        WATER_FACTORY_PLACEMENT_SEARCH_OFFSETS,
        'water',
      ));
    }

  }


  return entities;
}

function ownerForDeposit(world: WorldState, playerIds: PlayerId[], x: number, y: number): PlayerId {
  const depositAngle = mapOvalAngleAt(world.mapWidth, world.mapHeight, x, y);
  let bestIndex = 0;
  let bestDelta = Infinity;
  for (let i = 0; i < playerIds.length; i++) {
    const delta = angleDeltaAbs(depositAngle, getSeatBaseAngle(world.teamRoster, playerIds[i]));
    if (delta < bestDelta) {
      bestDelta = delta;
      bestIndex = i;
    }
  }
  return playerIds[bestIndex];
}

export function spawnMetalExtractorsOnDeposits(
  world: WorldState,
  construction: ConstructionSystem,
  playerIds: PlayerId[],
  availableBuildingBlueprintIds: ReadonlySet<string> | undefined = undefined,
  // Deposit OWNERSHIP is decided over the whole roster; extractors only
  // SPAWN for the seats in `playerIds` (the 'base' initial-state seats).
  // Without the split, a mixed roster would let a base seat claim the
  // deposits sitting in a commander seat's slice on the far side of the map.
  ownerCandidatePlayerIds: readonly PlayerId[] = playerIds,
): Entity[] {
  if (playerIds.length === 0 || world.metalDeposits.length === 0) return [];
  const spawnSeats = new Set(playerIds);
  const ownerCandidates = ownerCandidatePlayerIds.length > 0
    ? [...ownerCandidatePlayerIds]
    : playerIds;
  const extractorBlueprintIds = getDemoExtractorBlueprintIds(
    availableBuildingBlueprintIds,
  );
  if (extractorBlueprintIds.length === 0) return [];
  const entities: Entity[] = [];
  // Auto-extractors are part of the authored Demo opening state. They retain
  // real-building activation defaults, but must honor the same commander
  // no-building zones as every base row.
  const basePolicy = getInitialBasePolicy(
    'real',
    existingCommanderBuildingExclusions(world),
  );
  const extractorCountByOwner = new Map<PlayerId, number>();

  for (const deposit of world.metalDeposits) {
    // Rings authored with demoAutoExtractor: false start neutral — no
    // team gets a free extractor there (e.g. the exact-center deposit).
    if (deposit.demoAutoExtractor === false) continue;
    const ownerId = ownerForDeposit(world, ownerCandidates, deposit.x, deposit.y);
    // The rightful owner is a commander-start seat: its deposits stay bare.
    if (!spawnSeats.has(ownerId)) continue;
    const ownerExtractorIndex = extractorCountByOwner.get(ownerId) ?? 0;
    const extractorBlueprintId =
      extractorBlueprintIds[ownerExtractorIndex % extractorBlueprintIds.length];
    const extractor = placeCompleteBuilding(
      world,
      construction,
      extractorBlueprintId,
      deposit.x,
      deposit.y,
      ownerId,
      basePolicy,
      METAL_EXTRACTOR_PLACEMENT_SEARCH_OFFSETS,
      (entity) => (entity.metalExtractionRate ?? 0) > 0,
      null,
      // Demo auto-extractors are authored starting infrastructure. Outer
      // deposits may sit on the seabed, so ordinary dry-land construction
      // terrain rules must not prevent the prebuilt extractor from existing.
      // Bounds, occupied cells, and positive metal coverage remain enforced.
      true,
    );
    if (!extractor) continue;

    extractorCountByOwner.set(ownerId, ownerExtractorIndex + 1);
    entities.push(extractor);
  }

  return entities;
}

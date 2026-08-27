import { deterministicMath as DMath } from '@/game/sim/deterministicMath';
import type { WorldState } from './WorldState';
import type { Entity, PlayerId, BuildingBlueprintId, FactoryDefaultWaypoint } from './types';
import type { ConstructionSystem } from './construction';
import { economyManager } from './economy';
import { aimTurretsToward } from './turretInit';
import { setUnitFacingYaw } from './unitOrientation';
import { getBuildingConfig } from './buildConfigs';
import { installedMapMediumKey, mapHasLand, mapHasWater } from './mapSurface';
import {
  buildingBlueprintIdsForMediumKey,
  unitBlueprintIdsForMediumKey,
} from './mapRoster';
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
import {
  SHORE_MARGIN_LAND_FOOTPRINT_WU,
  SHORE_MARGIN_LAND_WAYPOINT_WU,
  SHORE_MARGIN_WATER_FOOTPRINT_WU,
  SHORE_MARGIN_WATER_WAYPOINT_WU,
  getShoreDistanceField,
  pointHasShoreMargin,
  shoreClearanceSqAt,
  snapPointToShoreMargin,
  type ShoreDistanceField,
} from './shoreDistanceField';
import {
  FABRICATOR_BLUEPRINT_IDS,
  getFabricatorBuildingBlueprintId,
  getUnitBlueprint,
} from './blueprints';
import {
  BUILD_GRID_CELL_SIZE,
  getRotatedBuildingPlacementFootprint,
} from './buildGrid';
import {
  BUILDING_BLUEPRINT_IDS,
  UNIT_BLUEPRINT_IDS,
  type UnitBlueprintId,
} from '../../types/blueprintIds';
import { getBuildingPlacementSetSquareType } from '../../types/buildingTypes';

export { getSeatBaseAngle } from './playerLayout';

type InitialBaseMode = 'demo' | 'real';
type ProductionTechLevel = 1 | 2 | 3;

type FactoryLinesByTech = Record<ProductionTechLevel, UnitBlueprintId[]>;

function groupFactoryLinesByTech(
  unitBlueprintIds: readonly UnitBlueprintId[],
): FactoryLinesByTech {
  const rows: FactoryLinesByTech = { 1: [], 2: [], 3: [] };
  for (let i = 0; i < unitBlueprintIds.length; i++) {
    const unitBlueprintId = unitBlueprintIds[i];
    const production = getUnitBlueprint(unitBlueprintId).production;
    if (production === null) continue;
    rows[production.techLevel].push(unitBlueprintId);
  }
  return rows;
}

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
// The tightest presets need a 140-cell fan to retain all current repeat lines,
// including the larger T2/T3 hosts. The ring is
// deterministic and ordered nearest-first, so the wider budget only lets a
// crowded seat reach another free ring; it never moves a placement that
// already succeeded.
// A Fabricator reserves a 14x14-cell pixel-circle. Half-footprint search
// steps cover dense packing while avoiding tens of thousands of near-identical
// probes whose rectangles overlap the same occupied cells.
const FACTORY_PLACEMENT_SEARCH_OFFSETS = buildStridedPlacementSearchOffsets(140, 7);
// Water-required lines use a dedicated deterministic fan-out so shoreline
// footprints and neighboring seats can still pack completely.
const WATER_FACTORY_PLACEMENT_SEARCH_OFFSETS = buildStridedPlacementSearchOffsets(64, 7);
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
  ...FABRICATOR_BLUEPRINT_IDS,
  'towerBeamMega',
  'towerCannon',
  'towerHelios',
  'buildingRadar',
  'buildingResourceConverter',
  'towerAntiAir',
  'buildingSonar',
  'buildingShieldTargetingTech',
  'buildingShieldTech',
  'buildingPrecisionTargetingTech',
]);

function isBlueprintAvailable(
  blueprintId: string,
  availableBlueprintIds: ReadonlySet<string> | undefined,
): boolean {
  return availableBlueprintIds === undefined || availableBlueprintIds.has(blueprintId);
}

/** Intersect caller-authored building toggles with what the installed map can
 * host. Initial-base placement bypasses builder authorization by design, so it
 * must apply the same terrain-requirement roster gate explicitly. */
function availableBuildingBlueprintIdsForInstalledMap(
  availableBuildingBlueprintIds: ReadonlySet<string> | undefined,
): ReadonlySet<string> {
  const enabled = availableBuildingBlueprintIds === undefined
    ? BUILDING_BLUEPRINT_IDS
    : BUILDING_BLUEPRINT_IDS.filter((id) => availableBuildingBlueprintIds.has(id));
  return new Set(buildingBlueprintIdsForMediumKey(
    enabled,
    installedMapMediumKey(),
  ));
}

function getDemoExtractorBlueprintIds(
  availableBuildingBlueprintIds: ReadonlySet<string> | undefined,
): BuildingBlueprintId[] {
  return BUILDING_BLUEPRINT_IDS.filter((id) => {
    if (!isBlueprintAvailable(id, availableBuildingBlueprintIds)) return false;
    return getBuildingConfig(id).metalProduction !== null;
  });
}

function getDemoSupplementalBuildingBlueprintIds(
  squareType: 'ground' | 'water',
  availableBuildingBlueprintIds: ReadonlySet<string> | undefined,
): BuildingBlueprintId[] {
  return BUILDING_BLUEPRINT_IDS.filter((id) => {
    if (!isBlueprintAvailable(id, availableBuildingBlueprintIds)) return false;
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

/** A land factory's authored legs (the fight leg toward map centre and the
 * centre patrol loop) are nominal geometry; each is walked onto dry ground
 * with a shore margin once the terrain is known, so a leg that the centre
 * lake or a bay happens to cover never sends the line onto the beach. Water
 * lines replace these legs entirely (configureWaterFactoryWaypoints). */
function computeFactoryDefaultWaypoints(
  factoryX: number,
  factoryY: number,
  mapWidth: number,
  mapHeight: number,
  basePolicy: InitialBasePolicy,
  field: ShoreDistanceField | null,
): readonly FactoryDefaultWaypoint[] {
  const nominalFight = computeFactoryWaypoint(
    factoryX,
    factoryY,
    mapWidth,
    mapHeight,
    basePolicy.fightDistance,
  );
  const fight = snapPointToShoreMargin(
    field, 'ground', nominalFight.x, nominalFight.y, SHORE_MARGIN_LAND_WAYPOINT_WU,
  );
  if (!basePolicy.addCenterPatrolLoop) {
    return [{ x: fight.x, y: fight.y, z: null, type: basePolicy.fightType }];
  }

  const oval = makeMapOvalMetrics(mapWidth, mapHeight);
  const angle = mapOvalAngleAt(mapWidth, mapHeight, factoryX, factoryY);
  const patrolRadius = DEMO_CONFIG.centerSpawnRadius * oval.minDim;
  const nominalNear = mapOvalPointAt(oval, angle, patrolRadius);
  const nominalFar = mapOvalPointAt(oval, angle + Math.PI, patrolRadius);
  const near = snapPointToShoreMargin(
    field, 'ground', nominalNear.x, nominalNear.y, SHORE_MARGIN_LAND_WAYPOINT_WU,
  );
  const far = snapPointToShoreMargin(
    field, 'ground', nominalFar.x, nominalFar.y, SHORE_MARGIN_LAND_WAYPOINT_WU,
  );
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
      getShoreDistanceField(world.mapWidth, world.mapHeight),
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
      (x, y) => isFootprintOnSurface(world, x, y, width, height, squareType),
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
): UnitBlueprintId[] {
  const unitBlueprintIds: UnitBlueprintId[] = [];
  const mapRoster = unitBlueprintIdsForMediumKey(
    UNIT_BLUEPRINT_IDS,
    installedMapMediumKey(),
  );
  for (let i = 0; i < mapRoster.length; i++) {
    const unitBlueprintId = mapRoster[i];
    if (getUnitBlueprint(unitBlueprintId).production === null) continue;
    if (!isBlueprintAvailable(unitBlueprintId, availableUnitBlueprintIds)) continue;
    unitBlueprintIds.push(unitBlueprintId);
  }
  return unitBlueprintIds;
}

function getUniversalFabricatorForDemoUnit(
  unitBlueprintId: UnitBlueprintId,
): BuildingBlueprintId {
  const production = getUnitBlueprint(unitBlueprintId).production;
  if (production === null) {
    throw new Error(`Demo production unit ${unitBlueprintId} has no production identity`);
  }
  return getFabricatorBuildingBlueprintId(production.techLevel, 'universal');
}

/** Every authored full-base production line owns exactly one unit. Keeping
 * this as ordinary repeat production makes the prebuilt base behave exactly
 * like a player who selected that unit and enabled Repeat. */
function seedFactoryRepeatBuild(
  factory: Entity,
  unitBlueprintId: UnitBlueprintId,
): void {
  const factoryState = factory.factory;
  if (factoryState === null) return;
  factoryState.selectedUnitBlueprintId = unitBlueprintId;
  factoryState.productionQueue.length = 0;
  factoryState.productionQuotas = {};
  factoryState.productionQuotaCounts = {};
  factoryState.repeatProduction = true;
}

/** Place one radial Universal per active unit, choosing T1, T2, or T3 from the
 * unit's canonical production identity. A disabled host tier suppresses only
 * the lines that require that tier. */
function placeUniversalFactoryLines(
  world: WorldState,
  construction: ConstructionSystem,
  unitBlueprintIds: readonly UnitBlueprintId[],
  oval: MapOvalMetrics,
  radius: number,
  baseAngle: number,
  sectorAngle: number,
  playerId: PlayerId,
  basePolicy: InitialBasePolicy,
  availableBuildingBlueprintIds: ReadonlySet<string> | undefined,
  surface: 'ground' | 'water',
  searchOffsets: readonly GridOffset[],
): Entity[] {
  const count = unitBlueprintIds.length;
  if (count === 0) return [];
  const entities: Entity[] = [];
  const startAngle = baseAngle - sectorAngle / 2;
  const angularStep = count > 1 ? sectorAngle / (count - 1) : 0;
  for (let i = 0; i < count; i++) {
    const unitBlueprintId = unitBlueprintIds[i];
    const buildingBlueprintId = getUniversalFabricatorForDemoUnit(unitBlueprintId);
    if (!isBlueprintAvailable(buildingBlueprintId, availableBuildingBlueprintIds)) continue;
    const angle = count > 1 ? startAngle + i * angularStep : baseAngle;
    const point = mapOvalPointAt(oval, angle, radius);
    const config = getBuildingConfig(buildingBlueprintId);
    const width = config.placementGridWidth * BUILD_GRID_CELL_SIZE;
    const height = config.placementGridHeight * BUILD_GRID_CELL_SIZE;
    const factory = placeCompleteBuilding(
      world,
      construction,
      buildingBlueprintId,
      point.x,
      point.y,
      playerId,
      basePolicy,
      searchOffsets,
      null,
      (x, y) => isFootprintOnSurface(world, x, y, width, height, surface),
      true,
    );
    if (factory === null) continue;
    seedFactoryRepeatBuild(factory, unitBlueprintId);
    entities.push(factory);
  }
  return entities;
}

/** Keep water-line output on the offshore ring instead of sending it through
 * the land base toward map center. */
function configureWaterFactoryWaypoints(
  world: WorldState,
  factory: Entity,
  oval: MapOvalMetrics,
  radius: number,
): void {
  const angle = mapOvalAngleAt(
    world.mapWidth,
    world.mapHeight,
    factory.transform.x,
    factory.transform.y,
  );
  const patrolArc = Math.PI / Math.max(2, world.playerCount);
  // The ring points are nominal: wherever the ring runs through a spit,
  // a divider ridge, or a beach, each leg is walked to the nearest open
  // water with a shore margin, so the line's hulls never patrol onto land.
  const field = getShoreDistanceField(world.mapWidth, world.mapHeight);
  const nominalForward = mapOvalPointAt(oval, angle + patrolArc, radius);
  const nominalBackward = mapOvalPointAt(oval, angle - patrolArc, radius);
  const forward = snapPointToShoreMargin(
    field, 'water', nominalForward.x, nominalForward.y, SHORE_MARGIN_WATER_WAYPOINT_WU,
  );
  const backward = snapPointToShoreMargin(
    field, 'water', nominalBackward.x, nominalBackward.y, SHORE_MARGIN_WATER_WAYPOINT_WU,
  );
  setFactoryDefaultWaypoints(factory, [
    { x: forward.x, y: forward.y, z: null, type: 'patrol' },
    { x: backward.x, y: backward.y, z: null, type: 'patrol' },
  ]);
}

/** Every build cell of a footprint centred at (x, y) lies on `surface`, and —
 * once the authoritative terrain is installed — keeps that medium's shore
 * margin around it. Sampling the corners alone let a shoreline cut straight
 * through a 14-cell fabricator; a complete footprint means every cell. Bare
 * worlds without a field keep the per-cell medium test alone. */
function isFootprintOnSurface(
  world: WorldState,
  x: number,
  y: number,
  width: number,
  height: number,
  surface: 'ground' | 'water',
): boolean {
  const cellSize = BUILD_GRID_CELL_SIZE;
  const cellsWide = Math.max(1, Math.round(width / cellSize));
  const cellsDeep = Math.max(1, Math.round(height / cellSize));
  const startX = x - (cellsWide - 1) * 0.5 * cellSize;
  const startY = y - (cellsDeep - 1) * 0.5 * cellSize;
  const expectsWater = surface === 'water';
  const field = getShoreDistanceField(world.mapWidth, world.mapHeight);
  const margin = expectsWater
    ? SHORE_MARGIN_WATER_FOOTPRINT_WU
    : SHORE_MARGIN_LAND_FOOTPRINT_WU;
  for (let cy = 0; cy < cellsDeep; cy++) {
    for (let cx = 0; cx < cellsWide; cx++) {
      const px = startX + cx * cellSize;
      const py = startY + cy * cellSize;
      if (isWaterAt(px, py, world.mapWidth, world.mapHeight) !== expectsWater) return false;
      if (field !== null && !pointHasShoreMargin(field, surface, px, py, margin)) return false;
    }
  }
  if (field === null) {
    // No installed mesh to classify whole cells: sample every cell corner
    // too, so a footprint whose outer edge touches the other medium is still
    // refused the way the field would refuse it.
    const cornerStartX = startX - cellSize * 0.5;
    const cornerStartY = startY - cellSize * 0.5;
    for (let cy = 0; cy <= cellsDeep; cy++) {
      for (let cx = 0; cx <= cellsWide; cx++) {
        const px = cornerStartX + cx * cellSize;
        const py = cornerStartY + cy * cellSize;
        if (isWaterAt(px, py, world.mapWidth, world.mapHeight) !== expectsWater) return false;
      }
    }
  }
  return true;
}

/** The seat's offshore anchor: the map-oval radius along its base angle, in
 * [minRadius, maxRadius], where the water is deepest — farthest from any
 * shore — measured on the installed terrain. Ties go to the farther radius,
 * so a wide ocean band anchors its rows toward the rear. Null when the ray
 * never crosses fully submerged water (the water lives elsewhere in the
 * seat's sector, or the map is dry); callers then fall back to the authored
 * ring. This is what "decided after the land is created" means for the
 * offshore rows: the authored fractions are spacings around this anchor,
 * never absolute positions. */
function resolveSeatOffshoreRadius(
  field: ShoreDistanceField,
  oval: MapOvalMetrics,
  angle: number,
  minRadius: number,
  maxRadius: number,
): number | null {
  let bestSq = 0;
  let bestRadius: number | null = null;
  for (let radius = minRadius; radius <= maxRadius; radius += BUILD_GRID_CELL_SIZE) {
    const point = mapOvalPointAt(oval, angle, radius);
    const sq = shoreClearanceSqAt(field, 'water', point.x, point.y);
    if (sq > 0 && sq >= bestSq) {
      bestSq = sq;
      bestRadius = radius;
    }
  }
  return bestRadius;
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
 * fractions are controlled by DEMO_CONFIG. Every active unit receives one
 * same-tier Universal Fabricator, preselected to repeat-build that unit.
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
  const normalizedPlayerIds = normalizePlayerIds(playerIds);

  // Raise, never lower — bootstrap may pass only the two base-state seats of a
  // mixed roster (see spawnInitialEntities for the same rule).
  world.playerCount = Math.max(world.playerCount, normalizedPlayerIds.length);

  for (const playerId of normalizedPlayerIds) {
    economyManager.initPlayer(playerId);
  }

  const playerCount = normalizedPlayerIds.length;
  const { oval, radius: spawnRadius } = getDemoOval(world);
  const { cx, cy } = oval;
  const hasWater = mapHasWater();
  const hasLand = mapHasLand();
  const enabledBuildingBlueprintIds =
    availableBuildingBlueprintIdsForInstalledMap(availableBuildingBlueprintIds);
  const supplementalGroundBuildingBlueprintIds =
    getDemoSupplementalBuildingBlueprintIds(
      'ground',
      enabledBuildingBlueprintIds,
    );
  const supplementalWaterBuildingBlueprintIds = hasWater
    ? getDemoSupplementalBuildingBlueprintIds(
      'water',
      enabledBuildingBlueprintIds,
    )
    : [];
  const factoryUnitBlueprintIds = getAvailableDemoFactoryUnitBlueprintIds(
    availableUnitBlueprintIds,
  );
  // Water-required lines always live offshore. Terrain-neutral lines prefer
  // the ordinary ground ring, but remain available on a future all-sea map by
  // joining the water rows there. Land-required units have already been
  // removed from that map by the shared roster filter above.
  const waterFactoryUnitBlueprintIds = factoryUnitBlueprintIds.filter((id) => {
    const blueprint = getUnitBlueprint(id);
    return blueprint.requiresWater ||
      (!hasLand && hasWater && !blueprint.requiresLand);
  });
  const waterFactoryUnitBlueprintIdSet = new Set(waterFactoryUnitBlueprintIds);
  const groundFactoryUnitBlueprintIds = factoryUnitBlueprintIds.filter(
    (id) => !waterFactoryUnitBlueprintIdSet.has(id),
  );
  const waterFactoryLinesByTech = groupFactoryLinesByTech(
    waterFactoryUnitBlueprintIds,
  );
  const groundFactoryLinesByTech = groupFactoryLinesByTech(
    groundFactoryUnitBlueprintIds,
  );

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
  const universalFactoryRadiusByTech: Readonly<Record<ProductionTechLevel, number>> = {
    1: demoBaseRingRadiusFromOuterSpawnRadius(
      spawnRadius,
      DEMO_CONFIG.baseRings.universalFabricator.tech1RadiusFraction,
    ),
    2: demoBaseRingRadiusFromOuterSpawnRadius(
      spawnRadius,
      DEMO_CONFIG.baseRings.universalFabricator.tech2RadiusFraction,
    ),
    3: demoBaseRingRadiusFromOuterSpawnRadius(
      spawnRadius,
      DEMO_CONFIG.baseRings.universalFabricator.tech3RadiusFraction,
    ),
  };
  // Offshore rows anchor on each seat's measured deep-water radius (see
  // resolveSeatOffshoreRadius); the authored fractions are spacings around
  // that anchor and only become absolute radii when a seat has no anchor.
  const shoreField = getShoreDistanceField(world.mapWidth, world.mapHeight);
  const offshoreAnchorFraction = DEMO_CONFIG.waterFabricators.tech1RadiusFraction;
  const offshoreSearchMinRadius = demoBaseRingRadiusFromOuterSpawnRadius(
    spawnRadius,
    DEMO_CONFIG.waterFabricators.anchorSearchMinRadiusFraction,
  );
  const radarRadius = demoBaseRingRadiusFromOuterSpawnRadius(
    spawnRadius,
    DEMO_CONFIG.baseRings.buildingRadar.radiusFraction,
  );
  const megaBeamTowerRadius = demoBaseRingRadiusFromOuterSpawnRadius(
    spawnRadius,
    DEMO_CONFIG.baseRings.towerBeamMega.radiusFraction,
  );
  const cannonTowerRadius = demoBaseRingRadiusFromOuterSpawnRadius(
    spawnRadius,
    DEMO_CONFIG.baseRings.towerCannon.radiusFraction,
  );
  const heliosTowerRadius = demoBaseRingRadiusFromOuterSpawnRadius(
    spawnRadius,
    DEMO_CONFIG.baseRings.towerHelios.radiusFraction,
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
  const wideSearchArcRows: ReadonlyArray<{
    buildingBlueprintId: BuildingBlueprintId;
    count: number;
    radius: number;
  }> = [
    {
      buildingBlueprintId: 'buildingPrecisionTargetingTech',
      count: DEMO_CONFIG.buildingPrecisionTargetingTechCount,
      radius: precisionTargetingTechRadius,
    },
    {
      buildingBlueprintId: 'buildingRadar',
      count: DEMO_CONFIG.buildingRadarCount,
      radius: radarRadius,
    },
    {
      buildingBlueprintId: 'buildingShieldTargetingTech',
      count: DEMO_CONFIG.buildingShieldTargetingTechCount,
      radius: shieldTargetingTechRadius,
    },
    {
      buildingBlueprintId: 'buildingShieldTech',
      count: DEMO_CONFIG.buildingShieldTechCount,
      radius: shieldTechRadius,
    },
    {
      buildingBlueprintId: 'towerAntiAir',
      count: DEMO_CONFIG.towerAntiAirCount,
      radius: antiAirTowerRadius,
    },
    {
      buildingBlueprintId: 'buildingResourceConverter',
      count: DEMO_CONFIG.buildingResourceConverterCount,
      radius: resourceConverterRadius,
    },
    {
      buildingBlueprintId: 'buildingSolar',
      count: DEMO_CONFIG.buildingSolarCount,
      radius: solarRadius,
    },
    {
      buildingBlueprintId: 'towerCannon',
      count: DEMO_CONFIG.towerCannonCount,
      radius: cannonTowerRadius,
    },
    {
      buildingBlueprintId: 'towerHelios',
      count: DEMO_CONFIG.towerHeliosCount,
      radius: heliosTowerRadius,
    },
    {
      buildingBlueprintId: 'towerBeamMega',
      count: DEMO_CONFIG.towerBeamMegaCount,
      radius: megaBeamTowerRadius,
    },
  ];

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

    const offshoreAnchorRadius = shoreField === null || !hasWater
      ? null
      : resolveSeatOffshoreRadius(
        shoreField,
        oval,
        baseAngle,
        offshoreSearchMinRadius,
        spawnRadius,
      );
    const offshoreRadiusFor = (radiusFraction: number): number =>
      offshoreAnchorRadius === null
        ? demoBaseRingRadiusFromOuterSpawnRadius(spawnRadius, radiusFraction)
        : offshoreAnchorRadius +
          (radiusFraction - offshoreAnchorFraction) * spawnRadius;
    const waterFactoryRadiusByTech: Readonly<Record<ProductionTechLevel, number>> = {
      1: offshoreRadiusFor(DEMO_CONFIG.waterFabricators.tech1RadiusFraction),
      2: offshoreRadiusFor(DEMO_CONFIG.waterFabricators.tech2RadiusFraction),
      3: offshoreRadiusFor(DEMO_CONFIG.waterFabricators.tech3RadiusFraction),
    };
    const authoredSonarRadius = offshoreRadiusFor(
      DEMO_CONFIG.waterFabricators.sonarRadiusFraction,
    );
    const supplementalWaterRadius = offshoreRadiusFor(
      DEMO_CONFIG.baseRings.supplementalWater.radiusFraction,
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
    if (isBlueprintAvailable('buildingWind', enabledBuildingBlueprintIds)) {
      entities.push(...placeArcRow(
        world, construction, 'buildingWind', DEMO_CONFIG.buildingWindCount,
        oval, windRadius, baseAngle, sectorAngle, playerId, basePolicy,
      ));
    }

    // Offshore rows go first so water-required units are never assigned a
    // land factory merely because Universal hosts can stand on both mediums.
    const waterFactories: Entity[] = [];
    const waterFactoryRows: ReadonlyArray<readonly [
      ProductionTechLevel,
      readonly UnitBlueprintId[],
      number,
    ]> = ([1, 2, 3] as const).map((techLevel) => [
      techLevel,
      waterFactoryLinesByTech[techLevel],
      waterFactoryRadiusByTech[techLevel],
    ]);
    for (let rowIndex = 0; rowIndex < waterFactoryRows.length; rowIndex++) {
      const [, rowUnitBlueprintIds, rowRadius] = waterFactoryRows[rowIndex];
      const rowFactories = placeUniversalFactoryLines(
        world,
        construction,
        rowUnitBlueprintIds,
        oval,
        rowRadius,
        baseAngle,
        getSeatBuildArcAngle(
          world.teamRoster,
          playerId,
          DEMO_CONFIG.waterFabricators.arcSectorFraction,
        ),
        playerId,
        basePolicy,
        enabledBuildingBlueprintIds,
        'water',
        WATER_FACTORY_PLACEMENT_SEARCH_OFFSETS,
      );
      for (let factoryIndex = 0; factoryIndex < rowFactories.length; factoryIndex++) {
        configureWaterFactoryWaypoints(world, rowFactories[factoryIndex], oval, rowRadius);
      }
      waterFactories.push(...rowFactories);
    }
    entities.push(...waterFactories);

    // Ground production also runs outside-in: T1 holds the rear line, T2 the
    // middle, and T3 the most forward line toward the battlefield center.
    // Each active unit still owns exactly one same-tier repeating Universal.
    for (const techLevel of [1, 2, 3] as const) {
      entities.push(...placeUniversalFactoryLines(
        world,
        construction,
        groundFactoryLinesByTech[techLevel],
        oval,
        universalFactoryRadiusByTech[techLevel],
        baseAngle,
        factorySectorAngle,
        playerId,
        basePolicy,
        enabledBuildingBlueprintIds,
        'ground',
        FACTORY_PLACEMENT_SEARCH_OFFSETS,
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

    // Precision targeting and the radar↔beam band place in the configured
    // outer-to-inner order above. The tech pair grants the seat shield-aware
    // targeting and shielded production, so the demo exercises both upgrades
    // live. Two rules keep the tightened band stable:
    //   1. Rows place in STRICT outer→inner radial order, so a row's
    //      preferred cells are claimed before its inner neighbour's
    //      search can squat on them.
    //   2. Every band row uses the wide factory search offsets, so a
    //      cell lost to a deposit pad or cramped terrain slides to the
    //      nearest free cells instead of silently failing best-effort
    //      placement.
    for (const row of wideSearchArcRows) {
      if (!isBlueprintAvailable(row.buildingBlueprintId, enabledBuildingBlueprintIds)) {
        continue;
      }
      entities.push(...placeArcRow(
        world,
        construction,
        row.buildingBlueprintId,
        row.count,
        oval,
        row.radius,
        baseAngle,
        sectorAngle,
        playerId,
        basePolicy,
        FACTORY_PLACEMENT_SEARCH_OFFSETS,
      ));
    }

    // Sonar remains an offshore utility showcase, independent of unit
    // production. A map with no water places none.
    if (hasWater && isBlueprintAvailable('buildingSonar', enabledBuildingBlueprintIds)) {
      const sonarConfig = getBuildingConfig('buildingSonar');
      const sonarWidth = sonarConfig.gridWidth * BUILD_GRID_CELL_SIZE;
      const sonarHeight = sonarConfig.gridHeight * BUILD_GRID_CELL_SIZE;
      entities.push(...placeArcRow(
        world, construction, 'buildingSonar', DEMO_CONFIG.buildingSonarCount,
        oval, authoredSonarRadius, baseAngle, sectorAngle, playerId, basePolicy,
        WATER_FACTORY_PLACEMENT_SEARCH_OFFSETS,
        (x, y) =>
          sampleMapOvalAt(oval, x, y).distance >= authoredSonarRadius &&
          isFootprintOnSurface(world, x, y, sonarWidth, sonarHeight, 'water'),
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
  // SPAWN for the seats in `playerIds` (either base initial-state choice).
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
    availableBuildingBlueprintIdsForInstalledMap(availableBuildingBlueprintIds),
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

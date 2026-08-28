// Pins "decided after the land is created" for the initialized base:
//   - every offshore Universal / sonar / supplemental-water footprint lies
//     completely on water with the footprint shore margin around every cell;
//   - every land Universal footprint lies completely on dry cells;
//   - every water line's rally and patrol legs sit in open water with the
//     waypoint shore margin; every land line's legs sit on dry ground;
//   - the offshore rows anchor on the seat's measured deep-water radius, not
//     on the authored ring fraction;
//   - the opening wave launches its water-required hulls with the spawn
//     shore margin under them, never on the first wet cell of the beach;
//   - the field itself: margins sit inside its reach, and its answers agree
//     with the boolean medium test at cell centres.

import { LAND_CELL_SIZE } from '../../config';
import { installDemoWaterTerrainFixture } from './demoWaterTerrainContractFixture';
import { createPhysicsHarness } from '../server/poolFreePhysicsHarness';
import { DEMO_CONFIG } from '../../demoConfig';
import { getUnitBlueprint } from './blueprints';
import { getBuildingConfig } from './buildConfigs';
import { BUILD_GRID_CELL_SIZE } from './buildGrid';
import { ConstructionSystem } from './construction';
import { makeMapOvalMetrics, mapOvalPointAt, sampleMapOvalAt } from './mapOval';
import { getSeatBaseAngle } from './playerLayout';
import {
  SHORE_MARGIN_LAND_FOOTPRINT_WU,
  SHORE_MARGIN_LAND_WAYPOINT_WU,
  SHORE_MARGIN_WATER_FOOTPRINT_WU,
  SHORE_MARGIN_WATER_SPAWN_WU,
  SHORE_MARGIN_WATER_WAYPOINT_WU,
  findShorePointNear,
  getShoreDistanceField,
  pointHasShoreMargin,
  shoreClearanceAt,
  shoreClearanceSqAt,
  type ShoreDistanceField,
} from './shoreDistanceField';
import { spawnInitialBases } from './spawn';
import { buildTeamRosterFromSeatCounts } from './teamRoster';
import {
  buildTerrainTileMap,
  isWaterAt,
  setAuthoritativeTerrainTileMap,
} from './Terrain';
import type { Entity, PlayerId } from './types';
import { WorldState } from './WorldState';
import { isFabricatorBuildingBlueprintId } from './blueprints/buildings';
import {
  buildPaddedOpenWaterPatrolPairCellIndices,
  openWaterPatrolPairFromCellIndex,
  spawnBackgroundUnitsStandalone,
} from '../server/BackgroundBattleStandalone';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[initial base shore placement contract] ${message}`);
}

function footprintCellCentres(entity: Entity): { x: number; y: number }[] {
  const config = getBuildingConfig(entity.buildingBlueprintId!);
  const cellsWide = config.placementGridWidth;
  const cellsDeep = config.placementGridHeight;
  const startX = entity.transform.x - (cellsWide - 1) * 0.5 * BUILD_GRID_CELL_SIZE;
  const startY = entity.transform.y - (cellsDeep - 1) * 0.5 * BUILD_GRID_CELL_SIZE;
  const out: { x: number; y: number }[] = [];
  for (let cy = 0; cy < cellsDeep; cy++) {
    for (let cx = 0; cx < cellsWide; cx++) {
      out.push({ x: startX + cx * BUILD_GRID_CELL_SIZE, y: startY + cy * BUILD_GRID_CELL_SIZE });
    }
  }
  return out;
}

function factoryMedium(entity: Entity): 'water' | 'ground' | null {
  const selected = entity.factory?.selectedUnitBlueprintId ?? null;
  if (selected === null) return null;
  const blueprint = getUnitBlueprint(selected);
  if (blueprint.requiresWater) return 'water';
  if (blueprint.requiresLand) return 'ground';
  return null;
}

function assertFieldSelfConsistent(field: ShoreDistanceField, mapWidth: number, mapHeight: number): void {
  for (const margin of [
    SHORE_MARGIN_WATER_FOOTPRINT_WU,
    SHORE_MARGIN_LAND_FOOTPRINT_WU,
    SHORE_MARGIN_WATER_WAYPOINT_WU,
    SHORE_MARGIN_LAND_WAYPOINT_WU,
    SHORE_MARGIN_WATER_SPAWN_WU,
  ]) {
    assertContract(
      margin > 0 && margin < field.reachWu,
      `shore margin ${margin} must lie inside the field's reach ${field.reachWu}`,
    );
  }
  let waterCells = 0;
  let landCells = 0;
  let disagreements = 0;
  for (let gy = 0; gy < field.cellsY; gy++) {
    for (let gx = 0; gx < field.cellsX; gx++) {
      const x = (gx + 0.5) * field.cellSize;
      const y = (gy + 0.5) * field.cellSize;
      const water = shoreClearanceSqAt(field, 'water', x, y);
      const land = shoreClearanceSqAt(field, 'ground', x, y);
      assertContract(!(water > 0 && land > 0), `cell ${gx},${gy} cannot be both deep water and dry land`);
      if (water > 0) {
        waterCells++;
        if (!isWaterAt(x, y, mapWidth, mapHeight)) disagreements++;
      } else if (land > 0) {
        landCells++;
        if (isWaterAt(x, y, mapWidth, mapHeight)) disagreements++;
      }
    }
  }
  assertContract(waterCells > 0 && landCells > 0, 'fixture terrain has both water and land');
  assertContract(
    disagreements === 0,
    `field medium must agree with isWaterAt at every classified cell centre (${disagreements} differ)`,
  );
}

function assertBasePlacement(
  world: WorldState,
  field: ShoreDistanceField,
  entities: Entity[],
  playerIds: PlayerId[],
  spawnRadius: number,
): void {
  const oval = makeMapOvalMetrics(world.mapWidth, world.mapHeight);
  let waterFactories = 0;
  let groundFactories = 0;
  for (const entity of entities) {
    const blueprintId = entity.buildingBlueprintId;
    if (blueprintId === null) continue;
    const isOffshoreUtility = blueprintId === 'buildingSonar';
    const medium = isFabricatorBuildingBlueprintId(blueprintId)
      ? factoryMedium(entity)
      : isOffshoreUtility ? 'water' : null;
    if (medium === null) continue;
    const margin = medium === 'water'
      ? SHORE_MARGIN_WATER_FOOTPRINT_WU
      : SHORE_MARGIN_LAND_FOOTPRINT_WU;
    for (const cell of footprintCellCentres(entity)) {
      assertContract(
        isWaterAt(cell.x, cell.y, world.mapWidth, world.mapHeight) === (medium === 'water'),
        `${blueprintId}#${entity.id} (${medium}) has a footprint cell on the wrong medium at ${cell.x},${cell.y}`,
      );
      assertContract(
        pointHasShoreMargin(field, medium, cell.x, cell.y, margin),
        `${blueprintId}#${entity.id} (${medium}) footprint cell at ${cell.x},${cell.y} lacks the ${margin} wu shore margin (has ${shoreClearanceAt(field, medium, cell.x, cell.y)})`,
      );
    }
    if (!isFabricatorBuildingBlueprintId(blueprintId)) continue;
    if (medium === 'water') waterFactories++;
    else groundFactories++;
    const waypointMargin = medium === 'water'
      ? SHORE_MARGIN_WATER_WAYPOINT_WU
      : SHORE_MARGIN_LAND_WAYPOINT_WU;
    const factory = entity.factory!;
    const legs = [
      { x: factory.rallyX, y: factory.rallyY },
      ...(factory.defaultWaypoints ?? []).map((leg) => ({ x: leg.x, y: leg.y })),
    ];
    for (const leg of legs) {
      assertContract(
        pointHasShoreMargin(field, medium, leg.x, leg.y, waypointMargin),
        `${blueprintId}#${entity.id} (${medium}) leg at ${leg.x},${leg.y} lacks the ${waypointMargin} wu shore margin (has ${shoreClearanceAt(field, medium, leg.x, leg.y)})`,
      );
    }
    if (medium === 'water') {
      // The row anchors on measured deep water: the factory must sit at least
      // as far from shore as the authored ring point would have, and the
      // authored ring itself is not where it stands unless that point is
      // already deep water.
      const authoredRing = spawnRadius * DEMO_CONFIG.waterFabricators.tech1RadiusFraction;
      const ownAngle = sampleMapOvalAt(oval, entity.transform.x, entity.transform.y).angle;
      const authoredPoint = mapOvalPointAt(oval, ownAngle, authoredRing);
      const authoredSq = shoreClearanceSqAt(field, 'water', authoredPoint.x, authoredPoint.y);
      const ownSq = shoreClearanceSqAt(field, 'water', entity.transform.x, entity.transform.y);
      assertContract(
        ownSq >= Math.min(authoredSq, Math.pow(SHORE_MARGIN_WATER_FOOTPRINT_WU / field.cellSize, 2)),
        `${blueprintId}#${entity.id} stands in shallower water than its authored ring point`,
      );
    }
  }
  assertContract(waterFactories > 0, 'fixture places at least one water line');
  assertContract(groundFactories > 0, 'fixture places at least one land line');
  assertContract(playerIds.length > 0, 'fixture has seats');
}

function assertOpeningWaveWaterHulls(
  world: WorldState,
  field: ShoreDistanceField,
  playerIds: PlayerId[],
): void {
  const spawned = spawnBackgroundUnitsStandalone(
    world,
    createPhysicsHarness(),
    true,
    undefined,
    playerIds,
  );
  let waterHulls = 0;
  for (const entity of spawned) {
    const id = entity.id;
    if (entity.unit === null) continue;
    if (!getUnitBlueprint(entity.unit.unitBlueprintId).requiresWater) continue;
    waterHulls++;
    const x = entity.transform.x;
    const y = entity.transform.y;
    assertContract(
      pointHasShoreMargin(field, 'water', x, y, SHORE_MARGIN_WATER_SPAWN_WU),
      `${entity.unit.unitBlueprintId}#${id} launched at ${x},${y} with only ${shoreClearanceAt(field, 'water', x, y)} wu of water around it`,
    );
    const patrolActions = entity.unit.actions.filter((action) => action.type === 'patrol');
    assertContract(
      patrolActions.length === 2 &&
        patrolActions[0].x === world.mapWidth - x &&
        patrolActions[0].y === world.mapHeight - y &&
        patrolActions[1].x === x &&
        patrolActions[1].y === y,
      `${entity.unit.unitBlueprintId}#${id} must patrol through the exact map-centre reflection and back`,
    );
    for (const action of entity.unit.actions) {
      if (action.type !== 'patrol' && action.type !== 'move') continue;
      const target = { x: action.x, y: action.y };
      assertContract(
        pointHasShoreMargin(field, 'water', target.x, target.y, SHORE_MARGIN_WATER_SPAWN_WU),
        `${entity.unit.unitBlueprintId}#${id} patrols to ${target.x},${target.y} with only ${shoreClearanceAt(field, 'water', target.x, target.y)} wu of water around it`,
      );
    }
  }
  assertContract(waterHulls > 0, 'the opening wave launched at least one water-required hull');
}

function assertMapWideWaterPatrolPool(field: ShoreDistanceField): void {
  const cellIndices = buildPaddedOpenWaterPatrolPairCellIndices(field);
  assertContract(cellIndices.length > 0, 'fixture exposes padded centre-reflected water pairs');
  let occupiedQuadrants = 0;
  for (let i = 0; i < cellIndices.length; i++) {
    const pair = openWaterPatrolPairFromCellIndex(field, cellIndices[i]);
    for (const point of [
      { x: pair.x, y: pair.y },
      { x: pair.oppositeX, y: pair.oppositeY },
    ]) {
      assertContract(
        pointHasShoreMargin(field, 'water', point.x, point.y, SHORE_MARGIN_WATER_SPAWN_WU),
        `map-wide water candidate ${point.x},${point.y} lacks launch padding`,
      );
      const right = point.x >= field.mapWidth / 2 ? 1 : 0;
      const bottom = point.y >= field.mapHeight / 2 ? 2 : 0;
      occupiedQuadrants |= 1 << (right + bottom);
    }
    assertContract(
      pair.oppositeX === field.mapWidth - pair.x &&
        pair.oppositeY === field.mapHeight - pair.y,
      'every water candidate pair is an exact reflection through map centre',
    );
  }
  assertContract(
    occupiedQuadrants === 0b1111,
    `map-wide water pool must expose all four quadrants, got mask ${occupiedQuadrants.toString(2)}`,
  );
}

function assertNearestPointWalk(field: ShoreDistanceField): void {
  // Starting on land, the walk finds open water with the margin; starting in
  // open water it stays put.
  let landStart: { x: number; y: number } | null = null;
  let deepStart: { x: number; y: number } | null = null;
  for (let gy = 0; gy < field.cellsY && (landStart === null || deepStart === null); gy++) {
    for (let gx = 0; gx < field.cellsX; gx++) {
      const x = (gx + 0.5) * field.cellSize;
      const y = (gy + 0.5) * field.cellSize;
      if (landStart === null && shoreClearanceSqAt(field, 'ground', x, y) > 0) landStart = { x, y };
      if (
        deepStart === null &&
        pointHasShoreMargin(field, 'water', x, y, SHORE_MARGIN_WATER_WAYPOINT_WU)
      ) {
        deepStart = { x, y };
      }
    }
  }
  assertContract(landStart !== null && deepStart !== null, 'fixture has land and open water cells');
  const stay = findShorePointNear(field, 'water', deepStart.x, deepStart.y, SHORE_MARGIN_WATER_WAYPOINT_WU);
  assertContract(
    stay !== null && stay.x === deepStart.x && stay.y === deepStart.y,
    'a point already in open water is its own snap',
  );
  const moved = findShorePointNear(field, 'water', landStart.x, landStart.y, SHORE_MARGIN_WATER_WAYPOINT_WU, 400);
  assertContract(
    moved !== null && pointHasShoreMargin(field, 'water', moved.x, moved.y, SHORE_MARGIN_WATER_WAYPOINT_WU),
    'a land point walks to open water with the margin when any exists in range',
  );
}

export function runInitialBaseShorePlacementContractTest(): void {
  const { preset, restore } = installDemoWaterTerrainFixture();
  const mapWidth = preset.mapWidthLandCells * LAND_CELL_SIZE;
  const mapHeight = preset.mapLengthLandCells * LAND_CELL_SIZE;
  try {
    // The shore field reads the installed authoritative mesh through the WASM
    // pathfinder, exactly as ServerBootstrap installs it before any spawn.
    setAuthoritativeTerrainTileMap(buildTerrainTileMap(mapWidth, mapHeight, LAND_CELL_SIZE));
    const field = getShoreDistanceField(mapWidth, mapHeight);
    assertContract(field !== null, 'an installed authoritative terrain yields a shore field');
    assertFieldSelfConsistent(field, mapWidth, mapHeight);
    assertNearestPointWalk(field);
    assertMapWideWaterPatrolPool(field);

    const playerIds: PlayerId[] = [];
    for (let i = 0; i < DEMO_CONFIG.allyTeamSeats.length; i++) playerIds.push((i + 1) as PlayerId);
    const world = new WorldState(0x5107e5, mapWidth, mapHeight);
    world.setTeamRoster(buildTeamRosterFromSeatCounts(playerIds, DEMO_CONFIG.allyTeamSeats));
    const construction = new ConstructionSystem(mapWidth, mapHeight, null);
    const entities = spawnInitialBases(world, construction, playerIds, 'demo');
    const oval = makeMapOvalMetrics(mapWidth, mapHeight);
    const spawnRadius = oval.minDim / 2 - DEMO_CONFIG.spawnMarginPx;
    assertBasePlacement(world, field, entities, playerIds, spawnRadius);
    for (const playerId of playerIds) {
      assertContract(
        Number.isFinite(getSeatBaseAngle(world.teamRoster, playerId)),
        `seat ${playerId} has a base angle`,
      );
    }
    assertOpeningWaveWaterHulls(world, field, playerIds);
  } finally {
    restore();
  }
}

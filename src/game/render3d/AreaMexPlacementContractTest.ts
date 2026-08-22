/**
 * Area-mex membership is BAR's rule: a deposit is inside the drag circle when
 * its ORIGIN is inside the circle, and nothing else counts.
 *
 * The regression this guards: membership used to be widened by
 * `deposit.placementRadius`, which is the connected-growth wander cap rather
 * than the ore's size. The titanic dead-center deposit's cap exceeds the whole
 * playable map, so every area-mex drag, anywhere, of any size, "contained" the
 * deposit at map center and queued an extractor far outside the drawn circle.
 *
 * Deliberately HERMETIC: synthetic deposits and a synthetic all-ground
 * buildability grid, never generateMetalDeposits. The real generator installs
 * flat zones into the shared terrain module and drives Rust-side deposit
 * state, and an earlier draft of this test corrupted both for every
 * terrain-reading contract test registered after it (the turret-host suite
 * failure of 2026-08-21). The membership rule under test needs neither.
 */

import { Input3DBuildPlacementState } from './Input3DBuildPlacementState';
import type { MetalDeposit } from '../../metalDepositConfig';
import { BUILD_GRID_CELL_SIZE } from '../sim/buildGrid';
import {
  GROUND_BUILD_SQUARE_FLAG,
  TERRAIN_BUILDABLE_FLAG,
} from '../sim/terrain/terrainBuildability';
import type { TerrainBuildabilityGrid } from '@/types/terrain';

function assertContract(condition: boolean, message: string): void {
  if (!condition) throw new Error(`[area mex contract] ${message}`);
}

/** Snap can move a placement off the deposit origin by a couple of build
 *  cells; membership itself must not be looser than the drawn circle. */
const SNAP_SLACK = 60;

const CELLS_PER_SIDE = 200;
const MAP_SIZE = CELLS_PER_SIDE * BUILD_GRID_CELL_SIZE;

function makeAllGroundGrid(): TerrainBuildabilityGrid {
  const cellCount = CELLS_PER_SIDE * CELLS_PER_SIDE;
  return {
    mapWidth: MAP_SIZE,
    mapHeight: MAP_SIZE,
    cellSize: BUILD_GRID_CELL_SIZE,
    cellsX: CELLS_PER_SIDE,
    cellsY: CELLS_PER_SIDE,
    version: 1,
    configKey: 'area-mex-contract',
    flags: new Array<number>(cellCount).fill(
      TERRAIN_BUILDABLE_FLAG | GROUND_BUILD_SQUARE_FLAG,
    ),
    levels: new Array<number>(cellCount).fill(0),
  };
}

/** A deposit owning a 3x3 block of metal cells around its origin, with an
 *  arbitrary authored placementRadius — the value membership must IGNORE. */
function makeDeposit(id: number, originGx: number, originGy: number, placementRadius: number): MetalDeposit {
  const cells: MetalDeposit['cells'] = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const gx = originGx + dx;
      const gy = originGy + dy;
      cells.push({
        gx,
        gy,
        x: gx * BUILD_GRID_CELL_SIZE + BUILD_GRID_CELL_SIZE / 2,
        y: gy * BUILD_GRID_CELL_SIZE + BUILD_GRID_CELL_SIZE / 2,
      });
    }
  }
  return {
    id,
    x: originGx * BUILD_GRID_CELL_SIZE + BUILD_GRID_CELL_SIZE / 2,
    y: originGy * BUILD_GRID_CELL_SIZE + BUILD_GRID_CELL_SIZE / 2,
    originGx,
    originGy,
    authoredMetalCellCount: cells.length,
    cells,
    metalCellCount: cells.length,
    placementRadiusCells: Math.round(placementRadius / BUILD_GRID_CELL_SIZE),
    boundsGridX: originGx - 1,
    boundsGridY: originGy - 1,
    boundsGridW: 3,
    boundsGridH: 3,
    placementRadius,
    flatPadRadius: Math.min(placementRadius, 3 * BUILD_GRID_CELL_SIZE),
    dTerrainLevels: null,
    // Far above any liquid, so the drowned-deposit filter never bites.
    height: 10000,
    blendRadius: 0,
    demoAutoExtractor: false,
    groupId: -1,
  };
}

export function runAreaMexPlacementContractTest(): void {
  // The pathological center deposit: a growth cap wider than the whole map,
  // exactly the titanic ring's authored shape that caused the bug.
  const centerDeposit = makeDeposit(0, CELLS_PER_SIDE / 2, CELLS_PER_SIDE / 2, MAP_SIZE * 2);
  const farDeposit = makeDeposit(1, 30, 30, 90);
  const deposits = [centerDeposit, farDeposit];

  const state = new Input3DBuildPlacementState();
  state.setMapBounds(MAP_SIZE, MAP_SIZE, 2, deposits);
  const grid = makeAllGroundGrid();
  const entitySource = {
    getBuildings: () => [],
    getTerrainBuildabilityGrid: () => grid,
  };

  // A circle drawn around the far deposit plans that deposit...
  const radius = 300;
  const plan = state.planMetalExtractorPlacementsInArea(
    farDeposit.x, farDeposit.y, radius, entitySource, farDeposit.x, farDeposit.y,
  );
  assertContract(plan.length >= 1, 'a circle around a free deposit must plan an extractor on it');
  for (const placement of plan) {
    // ...and nothing outside the drawn circle — dead center most of all.
    assertContract(
      Math.hypot(placement.x - farDeposit.x, placement.y - farDeposit.y) <= radius + SNAP_SLACK,
      `a planned extractor at ${placement.x},${placement.y} sits outside the drawn circle`,
    );
    assertContract(
      Math.hypot(placement.x - centerDeposit.x, placement.y - centerDeposit.y) > SNAP_SLACK,
      'the map-center deposit must never ride along on a drag drawn elsewhere',
    );
  }

  // A small circle over empty ground plans nothing at all. Before the fix
  // the center deposit's map-wide growth cap put it inside EVERY circle, so
  // this exact drag planned an extractor at dead center.
  const emptyDragX = 150 * BUILD_GRID_CELL_SIZE;
  const emptyDragY = 150 * BUILD_GRID_CELL_SIZE;
  const emptyPlan = state.planMetalExtractorPlacementsInArea(
    emptyDragX, emptyDragY, 120, entitySource, emptyDragX, emptyDragY,
  );
  assertContract(
    emptyPlan.length === 0,
    'a circle over empty ground must plan nothing — before the fix it always planned dead center',
  );

  // And the giant deposit is still perfectly reachable the honest way: put
  // the drag ON it and its origin is inside the circle.
  const centerPlan = state.planMetalExtractorPlacementsInArea(
    centerDeposit.x, centerDeposit.y, radius, entitySource, centerDeposit.x, centerDeposit.y,
  );
  assertContract(
    centerPlan.length >= 1,
    'a circle drawn over the center deposit itself must still plan it',
  );

  // BAR cmd_area_mex ordering: placements come out as a chained
  // nearest-neighbour path from the ordering seed, not in generator order.
  // Three deposits in a row, listed farthest-first; a seed at the near end
  // must reverse them.
  const rowDeposits = [
    makeDeposit(0, 60, 100, 90),
    makeDeposit(1, 50, 100, 90),
    makeDeposit(2, 40, 100, 90),
  ];
  const rowState = new Input3DBuildPlacementState();
  rowState.setMapBounds(MAP_SIZE, MAP_SIZE, 2, rowDeposits);
  const rowCenterX = 50 * BUILD_GRID_CELL_SIZE;
  const rowCenterY = 100 * BUILD_GRID_CELL_SIZE;
  const seedX = 30 * BUILD_GRID_CELL_SIZE;
  const rowPlan = rowState.planMetalExtractorPlacementsInArea(
    rowCenterX, rowCenterY, 15 * BUILD_GRID_CELL_SIZE, entitySource, seedX, rowCenterY,
  );
  assertContract(rowPlan.length === 3, 'the row drag must plan all three deposits');
  for (let i = 1; i < rowPlan.length; i++) {
    assertContract(
      rowPlan[i].x > rowPlan[i - 1].x,
      'area-mex placements must walk the chained nearest path from the builder seed',
    );
  }

  console.log('[contract] area mex placement OK');
}

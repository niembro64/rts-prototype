import * as THREE from 'three';
import { STRUCTURE_BLUEPRINT_IDS } from '../../types/blueprintIds';
import { buildSolarCollector } from '../render3d/SolarCollectorMesh3D';
import { BUILDING_BLUEPRINTS } from './blueprints/buildings';
import { getBuildingConfig } from './buildConfigs';
import {
  BuildingGrid,
  getRotatedBuildingPlacementFootprint,
  parseBuildingPlacementFootprint,
} from './buildGrid';
import type { EntityId, PlayerId } from './types';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[building footprint] ${message}`);
}

function assertConnected(id: string): void {
  const cells = getBuildingConfig(id as keyof typeof BUILDING_BLUEPRINTS).placementFootprint.cells;
  const remaining = new Set(cells.map((cell) => `${cell.dx},${cell.dy}`));
  const first = cells[0];
  const stack = [first];
  remaining.delete(`${first.dx},${first.dy}`);
  while (stack.length > 0) {
    const cell = stack.pop()!;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const key = `${cell.dx + dx},${cell.dy + dy}`;
      if (!remaining.delete(key)) continue;
      stack.push({ dx: cell.dx + dx, dy: cell.dy + dy, kind: 'structure' });
    }
  }
  assertContract(remaining.size === 0, `${id} mask must be one four-connected reservation`);
}

export function runBuildingFootprintContractTest(): void {
  for (const id of STRUCTURE_BLUEPRINT_IDS) {
    const blueprint = BUILDING_BLUEPRINTS[id];
    const config = getBuildingConfig(id);
    assertContract(
      config.placementGridWidth === blueprint.footprintMask[0].length &&
      config.placementGridHeight === blueprint.footprintMask.length,
      `${id} runtime placement bounds must derive from footprintMask`,
    );
    assertConnected(id);
    let rotated = config.placementFootprint;
    for (let turn = 0; turn < 4; turn++) {
      rotated = getRotatedBuildingPlacementFootprint(rotated, Math.PI / 2);
    }
    assertContract(
      rotated.gridWidth === config.placementGridWidth &&
      rotated.gridHeight === config.placementGridHeight &&
      rotated.cells.every((cell, index) => {
        const source = config.placementFootprint.cells[index];
        return source !== undefined &&
          cell.dx === source.dx && cell.dy === source.dy && cell.kind === source.kind;
      }),
      `${id} mask must return exactly to its authored pose after four turns`,
    );
  }

  const solarRows = BUILDING_BLUEPRINTS.buildingSolar.footprintMask;
  assertContract(
    solarRows.join('/') ===
      '.....+...../....+++..../...+++++.../..++###++../.++#####++./+++#####+++/.++#####++./..++###++../...+++++.../....+++..../.....+.....',
    'solar must reserve the authored 11x11 diamond, extending two cells beyond every side of its prior footprint',
  );
  const solar = getBuildingConfig('buildingSolar').placementFootprint;
  assertContract(
    solar.gridWidth === 11 && solar.gridHeight === 11 &&
      solar.cells.length === 61 &&
      solar.cells.filter((cell) => cell.kind === 'structure').length === 21 &&
      solar.cells.filter((cell) => cell.kind === 'clearance').length === 40,
    'solar diamond must keep 21 structural cells and add a 40-cell construction-clearance perimeter',
  );

  const fabricator = getBuildingConfig('towerFabricator').placementFootprint;
  assertContract(
    fabricator.gridWidth === 14 && fabricator.gridHeight === 14 &&
    fabricator.cells.length === 156,
    'Fabricator must use the 14x14 pixel-circle reservation',
  );
  const targetingLab = getBuildingConfig('buildingShieldTargetingTech').placementFootprint;
  const shieldLab = getBuildingConfig('buildingShieldTech').placementFootprint;
  assertContract(
    targetingLab.gridWidth === 12 && targetingLab.gridHeight === 12 &&
    shieldLab.gridWidth === 12 && shieldLab.gridHeight === 12 &&
    targetingLab.cells.length >= 100 && shieldLab.cells.length >= 100,
    'both research labs must occupy near-Fabricator-scale authored masks',
  );

  const grid = new BuildingGrid(800, 800);
  grid.placeFootprint(
    10,
    10,
    solar,
    7001 as EntityId,
    1 as PlayerId,
    true,
    20,
  );
  assertContract(grid.getCell(10, 10) === undefined, 'empty diamond corners must remain buildable');
  assertContract(
    grid.getCell(15, 10)?.blocksMovement === false,
    'outer solar clearance must reserve construction without blocking locomotion',
  );
  assertContract(
    grid.getCell(15, 15)?.blocksMovement === true,
    'solar structural core must block grounded locomotion',
  );
  assertContract(
    grid.canPlaceFootprint(10, 10, parseBuildingPlacementFootprint(['#'], 'contract probe')),
    'a shaped mask must allow another footprint in an unused bounding-box corner',
  );

  const primaryMat = new THREE.MeshLambertMaterial();
  const solarShape = buildSolarCollector(100, 100, primaryMat);
  assertContract(
    Math.abs((solarShape.authoredYaw ?? 0) - Math.PI / 4) <= 1e-9,
    'solar collector assembly, including every panel, must be natively yawed 45 degrees',
  );
  primaryMat.dispose();
}

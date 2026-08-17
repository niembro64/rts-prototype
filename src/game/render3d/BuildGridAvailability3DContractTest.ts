import { resolveBuildGridAvailabilityStatus } from './BuildGridAvailability3D';
import {
  FLAT_GROUND_BUILD_SQUARE_FLAGS,
  FLAT_WATER_BUILD_SQUARE_FLAGS,
  GROUND_BUILD_SQUARE_FLAG,
  WATER_BUILD_SQUARE_FLAG,
  getTerrainBuildabilityGridCell,
} from '../sim/terrain/terrainBuildability';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[build grid availability] ${message}`);
}

const OPEN_FACTS = {
  occupied: false,
  squareType: 'ground' as const,
  terrainBuildable: true,
  waterSurfaceClear: true,
  metal: false,
} as const;

export function runBuildGridAvailability3DContractTest(): void {
  const encodedGrid = {
    mapWidth: 80,
    mapHeight: 20,
    cellSize: 20,
    cellsX: 4,
    cellsY: 1,
    version: 1,
    configKey: 'build-square-bit-contract',
    flags: [
      FLAT_GROUND_BUILD_SQUARE_FLAGS,
      FLAT_WATER_BUILD_SQUARE_FLAGS,
      GROUND_BUILD_SQUARE_FLAG,
      GROUND_BUILD_SQUARE_FLAG | WATER_BUILD_SQUARE_FLAG,
    ],
    levels: [3, -2, 0, 0],
  };
  assertContract(
    getTerrainBuildabilityGridCell(encodedGrid, 0, 0).squareType === 'ground' &&
      getTerrainBuildabilityGridCell(encodedGrid, 0, 0).terrainBuildable,
    'the baked grid must decode a flat ground build square independently',
  );
  assertContract(
    getTerrainBuildabilityGridCell(encodedGrid, 1, 0).squareType === 'water' &&
      getTerrainBuildabilityGridCell(encodedGrid, 1, 0).terrainBuildable,
    'the baked grid must decode a flat underwater sea bed independently',
  );
  assertContract(
    getTerrainBuildabilityGridCell(encodedGrid, 2, 0).squareType === 'ground' &&
      !getTerrainBuildabilityGridCell(encodedGrid, 2, 0).terrainBuildable,
    'medium classification must survive a failed flatness test',
  );
  assertContract(
    getTerrainBuildabilityGridCell(encodedGrid, 3, 0).squareType === null,
    'a contradictory/split medium encoding must belong to neither square class',
  );
  assertContract(
    resolveBuildGridAvailabilityStatus('none', OPEN_FACTS) === 'hidden',
    'NONE must hide the whole-map availability overlay',
  );
  assertContract(
    resolveBuildGridAvailabilityStatus('ground-build-squares-surface', {
      ...OPEN_FACTS,
      terrainBuildable: false,
    }) === 'blocked',
    'ground availability must honor authoritative terrain buildability',
  );
  assertContract(
    resolveBuildGridAvailabilityStatus('ground-build-squares-hover', {
      ...OPEN_FACTS,
      terrainBuildable: false,
      waterSurfaceClear: false,
    }) === 'available',
    'hover availability must ignore ground slope and water depth',
  );
  assertContract(
    resolveBuildGridAvailabilityStatus('water-build-squares-sea-on-surface', {
      ...OPEN_FACTS,
      squareType: 'water',
      waterSurfaceClear: false,
    }) === 'blocked',
    'water-surface availability must honor seabed clearance',
  );
  for (const mode of [
    'ground-build-squares-hover',
    'ground-build-squares-surface',
    'water-build-squares-sea-bed',
    'water-build-squares-sea-on-surface',
    'water-build-squares-hover-surface',
  ] as const) {
    assertContract(
      resolveBuildGridAvailabilityStatus(mode, {
        ...OPEN_FACTS,
        occupied: true,
      }) === 'blocked',
      `${mode} availability must reject occupied squares`,
    );
  }
  assertContract(
    resolveBuildGridAvailabilityStatus('ground-build-squares-surface', {
      ...OPEN_FACTS,
      metal: true,
    }) === 'metal',
    'ground availability must retain the metal-cell diagnostic',
  );
  assertContract(
    resolveBuildGridAvailabilityStatus('water-build-squares-sea-bed', {
      ...OPEN_FACTS,
      squareType: 'water',
      terrainBuildable: false,
    }) === 'blocked',
    'sea-bed availability must honor underwater terrain flatness',
  );
  assertContract(
    resolveBuildGridAvailabilityStatus('water-build-squares-hover-surface', {
      ...OPEN_FACTS,
      squareType: 'water',
      terrainBuildable: false,
      waterSurfaceClear: false,
    }) === 'available',
    'water hover-surface availability must ignore bed slope and water depth',
  );
  for (const mode of [
    'ground-build-squares-hover',
    'ground-build-squares-surface',
    'water-build-squares-sea-bed',
    'water-build-squares-sea-on-surface',
    'water-build-squares-hover-surface',
  ] as const) {
    assertContract(
      resolveBuildGridAvailabilityStatus(mode, {
        ...OPEN_FACTS,
        squareType: null,
      }) === 'blocked',
      `${mode} must reject a waterline-split square`,
    );
  }
}

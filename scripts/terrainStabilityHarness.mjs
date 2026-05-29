#!/usr/bin/env node
import { createServer } from 'vite';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const baselinePath = path.join(scriptDir, 'terrainStabilityBaseline.json');
const updateBaseline = process.argv.includes('--update');

const CASES = [
  {
    id: '7x7-circle-flat-detail1-2p',
    widthLandCells: 7,
    heightLandCells: 7,
    playerCount: 2,
    terrainMapShape: 'circle',
    centerMagnitude: 0,
    dividersMagnitude: 0,
    terrainDTerrain: 0,
    metalDepositStep: 0,
    terrainDetail: 1,
  },
  {
    id: '11x7-square-plateau200-detail5-3p',
    widthLandCells: 11,
    heightLandCells: 7,
    playerCount: 3,
    terrainMapShape: 'square',
    centerMagnitude: 400,
    dividersMagnitude: 200,
    terrainDTerrain: 200,
    metalDepositStep: 200,
    terrainDetail: 5,
  },
  {
    id: '15x15-circle-plateau400-detail10-4p',
    widthLandCells: 15,
    heightLandCells: 15,
    playerCount: 4,
    terrainMapShape: 'circle',
    centerMagnitude: 800,
    dividersMagnitude: 400,
    terrainDTerrain: 400,
    metalDepositStep: 400,
    terrainDetail: 10,
  },
  {
    id: '23x11-square-plateau800-detail15-6p',
    widthLandCells: 23,
    heightLandCells: 11,
    playerCount: 6,
    terrainMapShape: 'square',
    centerMagnitude: -800,
    dividersMagnitude: 800,
    terrainDTerrain: 800,
    metalDepositStep: 200,
    terrainDetail: 15,
  },
];

class Fnv64 {
  constructor() {
    this.hash = 0xcbf29ce484222325n;
    this.bytes = new Uint8Array(8);
    this.view = new DataView(this.bytes.buffer);
  }

  byte(value) {
    this.hash ^= BigInt(value & 0xff);
    this.hash = BigInt.asUintN(64, this.hash * 0x100000001b3n);
  }

  string(value) {
    for (let i = 0; i < value.length; i++) {
      const code = value.charCodeAt(i);
      this.byte(code & 0xff);
      this.byte(code >>> 8);
    }
    this.byte(0);
  }

  uint32(value) {
    this.view.setUint32(0, value >>> 0, true);
    for (let i = 0; i < 4; i++) this.byte(this.bytes[i]);
  }

  number(value) {
    this.view.setFloat64(0, Object.is(value, -0) ? 0 : value, true);
    for (let i = 0; i < 8; i++) this.byte(this.bytes[i]);
  }

  digest() {
    return this.hash.toString(16).padStart(16, '0');
  }
}

function hashNumberArray(values) {
  const h = new Fnv64();
  h.uint32(values.length);
  for (const value of values) h.number(value);
  return h.digest();
}

function summarizeNumberArray(values) {
  return {
    length: values.length,
    hash: hashNumberArray(values),
  };
}

function hashDeposits(deposits) {
  const h = new Fnv64();
  h.uint32(deposits.length);
  for (const deposit of deposits) {
    h.uint32(deposit.id);
    h.number(deposit.x);
    h.number(deposit.y);
    h.number(deposit.height);
    h.number(deposit.dTerrainLevels ?? Number.NaN);
    h.uint32(deposit.gridX);
    h.uint32(deposit.gridY);
    h.uint32(deposit.originGx);
    h.uint32(deposit.originGy);
    h.uint32(deposit.resourceCells);
    h.uint32(deposit.resourceCellCount);
    h.uint32(deposit.resourceRadiusCells);
    h.uint32(deposit.boundsGridX);
    h.uint32(deposit.boundsGridY);
    h.uint32(deposit.boundsGridW);
    h.uint32(deposit.boundsGridH);
    h.number(deposit.resourceHalfSize);
    h.number(deposit.resourceRadius);
    h.number(deposit.flatPadRadius);
    h.number(deposit.blendRadius);
    h.uint32(deposit.cells.length);
    for (const cell of deposit.cells) {
      h.uint32(cell.gx);
      h.uint32(cell.gy);
      h.number(cell.x);
      h.number(cell.y);
    }
  }
  return h.digest();
}

function summarizeDeposits(deposits) {
  return {
    count: deposits.length,
    resourceCellCount: deposits.reduce(
      (sum, deposit) => sum + deposit.cells.length,
      0,
    ),
    hash: hashDeposits(deposits),
  };
}

function summarizeTerrain(map) {
  return {
    metadata: {
      mapWidth: map.mapWidth,
      mapHeight: map.mapHeight,
      cellSize: map.cellSize,
      subdiv: map.subdiv,
      cellsX: map.cellsX,
      cellsY: map.cellsY,
      verticesX: map.verticesX,
      verticesY: map.verticesY,
    },
    meshVertexCoords: summarizeNumberArray(map.meshVertexCoords),
    meshVertexHeights: summarizeNumberArray(map.meshVertexHeights),
    meshTriangleIndices: summarizeNumberArray(map.meshTriangleIndices),
    meshTriangleLevels: summarizeNumberArray(map.meshTriangleLevels),
    meshTriangleNeighborIndices: summarizeNumberArray(
      map.meshTriangleNeighborIndices,
    ),
    meshTriangleNeighborLevels: summarizeNumberArray(
      map.meshTriangleNeighborLevels,
    ),
    meshCellTriangleOffsets: summarizeNumberArray(map.meshCellTriangleOffsets),
    meshCellTriangleIndices: summarizeNumberArray(map.meshCellTriangleIndices),
  };
}

function summarizeBuildability(grid) {
  return {
    metadata: {
      mapWidth: grid.mapWidth,
      mapHeight: grid.mapHeight,
      cellSize: grid.cellSize,
      cellsX: grid.cellsX,
      cellsY: grid.cellsY,
      configKey: grid.configKey,
    },
    flags: summarizeNumberArray(grid.flags),
    levels: summarizeNumberArray(grid.levels),
  };
}

function compareReports(actual, expected, pathParts = [], diffs = []) {
  if (Object.is(actual, expected)) return diffs;
  const pathLabel = pathParts.length === 0 ? '<root>' : pathParts.join('.');
  if (
    actual === null ||
    expected === null ||
    typeof actual !== 'object' ||
    typeof expected !== 'object'
  ) {
    diffs.push(`${pathLabel}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    return diffs;
  }

  const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  for (const key of [...keys].sort()) {
    if (!(key in expected)) {
      diffs.push(`${[...pathParts, key].join('.')}: unexpected key`);
      continue;
    }
    if (!(key in actual)) {
      diffs.push(`${[...pathParts, key].join('.')}: missing key`);
      continue;
    }
    compareReports(actual[key], expected[key], [...pathParts, key], diffs);
    if (diffs.length >= 40) return diffs;
  }
  return diffs;
}

async function buildReport() {
  const server = await createServer({
    root: repoRoot,
    configFile: path.join(repoRoot, 'vite.config.ts'),
    appType: 'custom',
    logLevel: 'error',
    server: { middlewareMode: true },
  });

  try {
    const terrain = await server.ssrLoadModule('/src/game/sim/Terrain.ts');
    const depositsModule = await server.ssrLoadModule('/src/metalDepositConfig.ts');
    const config = await server.ssrLoadModule('/src/config.ts');

    const cases = [];
    for (const testCase of CASES) {
      const mapWidth = testCase.widthLandCells * config.LAND_CELL_SIZE;
      const mapHeight = testCase.heightLandCells * config.LAND_CELL_SIZE;

      terrain.setMetalDepositFlatZones([]);
      terrain.setAuthoritativeTerrainTileMap(null);
      terrain.setTerrainRuntimeConfig({
        centerMagnitude: testCase.centerMagnitude,
        dividersMagnitude: testCase.dividersMagnitude,
        terrainDTerrain: testCase.terrainDTerrain,
        metalDepositStep: testCase.metalDepositStep,
        terrainDetail: testCase.terrainDetail,
      });
      terrain.setTerrainTeamCount(testCase.playerCount);
      terrain.setTerrainMapShape(testCase.terrainMapShape);

      const deposits = depositsModule.generateMetalDeposits(
        mapWidth,
        mapHeight,
        testCase.playerCount,
      );
      const terrainMap = terrain.buildTerrainTileMap(
        mapWidth,
        mapHeight,
        config.LAND_CELL_SIZE,
      );
      terrain.setAuthoritativeTerrainTileMap(terrainMap);
      const buildability = terrain.buildTerrainBuildabilityGrid(mapWidth, mapHeight);

      cases.push({
        id: testCase.id,
        config: { ...testCase, mapWidth, mapHeight },
        deposits: summarizeDeposits(deposits),
        terrain: summarizeTerrain(terrainMap),
        buildability: summarizeBuildability(buildability),
      });
    }

    terrain.setMetalDepositFlatZones([]);
    terrain.setAuthoritativeTerrainTileMap(null);

    return {
      version: 1,
      description:
        'Deterministic terrain/deposit/buildability hashes. Update only for intentional generation changes.',
      cases,
    };
  } finally {
    await server.close();
  }
}

async function readBaseline() {
  try {
    return JSON.parse(await readFile(baselinePath, 'utf8'));
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

const report = await buildReport();

if (updateBaseline) {
  await writeFile(baselinePath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Updated terrain stability baseline: ${baselinePath}`);
  process.exit(0);
}

const baseline = await readBaseline();
if (baseline === null) {
  console.error(
    `Missing terrain stability baseline at ${baselinePath}. Run npm run terrain:stability -- --update first.`,
  );
  process.exit(1);
}

const diffs = compareReports(report, baseline);
if (diffs.length > 0) {
  console.error('Terrain stability harness detected output drift:');
  for (const diff of diffs) console.error(`- ${diff}`);
  console.error('Run npm run terrain:stability -- --update only if the drift is intentional.');
  process.exit(1);
}

console.log(`Terrain stability harness passed (${report.cases.length} cases).`);

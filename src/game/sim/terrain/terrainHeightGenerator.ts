// Thin WASM-backed samplers for the GENERATED (analytic) terrain.
//
// The generation pipeline itself lives ONLY in Rust
// (rts-sim-wasm/src/deposits.rs): natural height, map boundary,
// plateau terracing, metal-deposit flat-pad override (including
// group-manual smoothing), and the waters-edge shoreline pass.
// TypeScript packs the live config + flat zones and asks Rust — there
// is no mirrored height math on this side. Callers are the tile-map
// fallback sampler (no baked mesh installed yet) and the terrain
// renderer's boundary-fade edge shading, so per-call batches are
// boot/rebuild-time work, not per-frame hot paths.

import { getSimWasm } from '../../sim-wasm/init';
import { getMetalDepositFlatZones } from './terrainFlatZones';
import {
  packTerrainFlatZoneRowsForWasm,
  packTerrainGenerationConfigForWasm,
  TERRAIN_GENERATION_EXTENT_FRACTION,
} from './terrainGenerationConfig';
import { getTerrainVersion } from './terrainState';

// Packed config + flat-zone rows, cached per (terrain version, zone
// list identity). Zone installs always swap the array reference and
// config edits bump the terrain version, so staleness is impossible.
let cachedConfigVersion = -1;
let cachedZonesRef: unknown = null;
let cachedConfigRows: Float64Array | null = null;
let cachedZoneRows: Float64Array | null = null;

function packedTerrainInputs(): { config: Float64Array; zones: Float64Array } {
  const version = getTerrainVersion();
  const zonesList = getMetalDepositFlatZones();
  if (
    cachedConfigRows === null ||
    cachedZoneRows === null ||
    cachedConfigVersion !== version ||
    cachedZonesRef !== zonesList
  ) {
    cachedConfigRows = packTerrainGenerationConfigForWasm();
    cachedZoneRows = packTerrainFlatZoneRowsForWasm(zonesList);
    cachedConfigVersion = version;
    cachedZonesRef = zonesList;
  }
  return { config: cachedConfigRows, zones: cachedZoneRows };
}

function requireSimWasm() {
  const sim = getSimWasm();
  if (sim === undefined) {
    throw new Error(
      'terrainHeightGenerator requires sim-wasm to be initialized — the terrain pipeline lives in Rust',
    );
  }
  return sim;
}

// Growable scratch so batch calls never allocate at steady state.
let heightInputScratch = new Float64Array(0);
let heightOutputScratch = new Float64Array(0);
const singlePointScratch = new Float64Array(2);
const singleHeightScratch = new Float64Array(1);
const singleFadeScratch = new Float64Array(1);

/**
 * Sample the full generated-terrain pipeline at `count` packed (x, y)
 * pairs, writing heights into `out`. One WASM call for the whole batch.
 *
 * Non-finite coordinates (the sim probes projectile terminal positions
 * that can carry NaN) yield NaN heights, matching the old analytic
 * sampler's silent propagation — callers like `isWaterAt` treat NaN as
 * "not water". The kernel itself rejects non-finite inputs, so those
 * points are skipped rather than batched.
 */
export function sampleGeneratedTerrainHeights(
  pointsXy: Float64Array,
  count: number,
  mapWidth: number,
  mapHeight: number,
  out: Float64Array,
): void {
  if (count <= 0) return;
  if (!Number.isFinite(mapWidth) || !Number.isFinite(mapHeight)) {
    for (let i = 0; i < count; i++) out[i] = Number.NaN;
    return;
  }
  const sim = requireSimWasm();
  const inputs = packedTerrainInputs();
  if (heightInputScratch.length < count * 3) {
    heightInputScratch = new Float64Array(count * 3);
  }
  if (heightOutputScratch.length < count) {
    heightOutputScratch = new Float64Array(count);
  }
  let finiteCount = 0;
  for (let i = 0; i < count; i++) {
    const x = pointsXy[i * 2];
    const y = pointsXy[i * 2 + 1];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    heightInputScratch[finiteCount * 3] = x;
    heightInputScratch[finiteCount * 3 + 1] = y;
    // NaN explicit height = "sample the pipeline here".
    heightInputScratch[finiteCount * 3 + 2] = Number.NaN;
    finiteCount++;
  }
  if (finiteCount > 0) {
    const written = sim.metalDepositResolveTerrainHeights(
      mapWidth,
      mapHeight,
      TERRAIN_GENERATION_EXTENT_FRACTION,
      inputs.config,
      inputs.zones,
      heightInputScratch.subarray(0, finiteCount * 3),
      heightOutputScratch.subarray(0, finiteCount),
    );
    if (written !== finiteCount) {
      throw new Error(
        `terrain height kernel returned ${written} samples; expected ${finiteCount}`,
      );
    }
  }
  let read = 0;
  for (let i = 0; i < count; i++) {
    const x = pointsXy[i * 2];
    const y = pointsXy[i * 2 + 1];
    out[i] = Number.isFinite(x) && Number.isFinite(y)
      ? heightOutputScratch[read++]
      : Number.NaN;
  }
}

/** Generated (analytic) terrain height at one point. Prefer
 *  {@link sampleGeneratedTerrainHeights} when sampling several points. */
export function getTerrainHeight(
  x: number,
  y: number,
  mapWidth: number,
  mapHeight: number,
): number {
  singlePointScratch[0] = x;
  singlePointScratch[1] = y;
  sampleGeneratedTerrainHeights(
    singlePointScratch,
    1,
    mapWidth,
    mapHeight,
    singleHeightScratch,
  );
  return singleHeightScratch[0];
}

/** Map-boundary (PERIMETER ring) fade weight at (x, y): 0 inside the
 *  inner radius, raised-cosine ramp across the band, 1 at/beyond the
 *  outer radius. Sampled from the Rust pipeline. */
export function getTerrainMapBoundaryFade(
  x: number,
  y: number,
  mapWidth: number,
  mapHeight: number,
): number {
  if (
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(mapWidth) ||
    !Number.isFinite(mapHeight)
  ) {
    return Number.NaN;
  }
  const sim = requireSimWasm();
  const inputs = packedTerrainInputs();
  singlePointScratch[0] = x;
  singlePointScratch[1] = y;
  const written = sim.terrainSampleMapBoundaryFades(
    mapWidth,
    mapHeight,
    TERRAIN_GENERATION_EXTENT_FRACTION,
    inputs.config,
    singlePointScratch,
    singleFadeScratch,
  );
  if (written !== 1) {
    throw new Error(
      `terrain boundary-fade kernel returned ${written} samples; expected 1`,
    );
  }
  return singleFadeScratch[0];
}

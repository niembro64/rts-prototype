import {
  TERRAIN_GENERATION_EDGE_TRANSITION_WIDTH_FRACTION,
  TERRAIN_PERIMETER_CONFIG,
  TERRAIN_PIPELINE,
  TERRAIN_PIPELINE_STEP_CODES,
  TERRAIN_PLATEAU_CONFIG,
  TERRAIN_RIDGE_CONFIG,
  TERRAIN_RIPPLE_CONFIG,
  TERRAIN_SHORELINE_CONFIG,
  TILE_FLOOR_Y,
} from './terrainConfig';
import type { TerrainFlatZone } from './terrainFlatZones';
import {
  getTerrainRuntimeConfig,
  getTerrainTeamCount,
} from './terrainState';

/** Oval extent used by every analytic terrain-height sampler. Re-exported
 *  here so the mesh baker and the metal-deposit kernels pass the SAME value
 *  to Rust — they all sample `metal_deposit_terrain_height_with_explicit_zones`
 *  and must agree on the island metrics. */
export const TERRAIN_GENERATION_EXTENT_FRACTION = 0.85;

/** Length of the packed generation-config slice consumed by Rust
 *  (`metal_deposit_terrain_config_from_slice`). */
const TERRAIN_GENERATION_CONFIG_LENGTH = 34;

/** Stride of a packed deposit flat-zone row: x, y, radius, height, blendRadius.
 *  Matches `METAL_DEPOSIT_FLAT_ZONE_INPUT_STRIDE` in the Rust sim. */
const TERRAIN_FLAT_ZONE_WASM_STRIDE = 5;

/** Pack the live terrain generation config into the 23-value slice the Rust
 *  height sampler reads. Single source of truth for both the adaptive mesh
 *  baker and the metal-deposit placement/height kernels. */
export function packTerrainGenerationConfigForWasm(): Float64Array {
  const runtime = getTerrainRuntimeConfig();
  const [r0, r1, r2] = TERRAIN_RIPPLE_CONFIG.components;
  const rows = new Float64Array(TERRAIN_GENERATION_CONFIG_LENGTH);
  rows[0] = runtime.centerMagnitude;
  rows[1] = runtime.dividersMagnitude;
  rows[2] = runtime.terrainDTerrain;
  rows[3] = runtime.perimeterMagnitude;
  rows[4] = getTerrainTeamCount();
  rows[5] = TILE_FLOOR_Y;
  rows[6] = TERRAIN_PERIMETER_CONFIG.outerRadiusFraction;
  rows[7] = TERRAIN_PERIMETER_CONFIG.innerRadiusFraction;
  rows[8] = TERRAIN_GENERATION_EDGE_TRANSITION_WIDTH_FRACTION;
  rows[9] = TERRAIN_PLATEAU_CONFIG.shelfFractionOfStep;
  rows[10] = TERRAIN_PLATEAU_CONFIG.rampEdgeSharpness;
  rows[11] = TERRAIN_RIPPLE_CONFIG.radiusFraction;
  rows[12] = TERRAIN_RIPPLE_CONFIG.phase;
  rows[13] = r0.wavelength;
  rows[14] = r0.magnitude;
  rows[15] = r1.wavelength;
  rows[16] = r1.magnitude;
  rows[17] = r2.wavelength;
  rows[18] = r2.magnitude;
  rows[19] = TERRAIN_RIDGE_CONFIG.innerRadiusFraction;
  rows[20] = TERRAIN_RIDGE_CONFIG.outerRadiusFraction;
  rows[21] = TERRAIN_RIDGE_CONFIG.halfWidthFraction;
  rows[22] = runtime.plateauWallSlopeDegrees;
  rows[23] = runtime.watersEdgeBeachSlopeDegrees;
  rows[24] = runtime.watersEdgeCliffHeight;
  rows[25] = TERRAIN_SHORELINE_CONFIG.beachFadeRadius;
  rows[26] = TERRAIN_SHORELINE_CONFIG.cliffFadeRadius;
  for (let i = 0; i < TERRAIN_PIPELINE.length; i++) {
    const entry = TERRAIN_PIPELINE[i];
    rows[27 + i] =
      TERRAIN_PIPELINE_STEP_CODES[entry.step] + (entry.active ? 0 : 8);
  }
  return rows;
}

/** Pack flat zones into the 5-stride row layout the Rust deposit-override
 *  sampler reads (x, y, radius, height, blendRadius). */
export function packTerrainFlatZoneRowsForWasm(
  zones: readonly TerrainFlatZone[],
): Float64Array {
  const rows = new Float64Array(zones.length * TERRAIN_FLAT_ZONE_WASM_STRIDE);
  for (let i = 0; i < zones.length; i++) {
    const zone = zones[i];
    const base = i * TERRAIN_FLAT_ZONE_WASM_STRIDE;
    rows[base] = zone.x;
    rows[base + 1] = zone.y;
    rows[base + 2] = zone.radius;
    rows[base + 3] = zone.height;
    rows[base + 4] = zone.blendRadius;
  }
  return rows;
}

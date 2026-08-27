import { deterministicMath as DMath } from '@/game/sim/deterministicMath';
import { LAND_CELL_SIZE } from '../../../config';
import { getSimWasm } from '../../sim-wasm/init';
import { WATER_LEVEL } from './terrainConfig';
import { findDepositFlatZoneAt } from './terrainFlatZones';
import {
  getTerrainMeshHeight,
  getTerrainMeshSample,
  terrainMeshHeightFromSample,
  terrainMeshNormalFromSample,
  terrainMeshNormalFromSampleInto,
} from './terrainTileMap';

// Module-scope scratch for the WASM normal sampler — Rust writes
// (nx, ny, nz) at indices 0..3. Reused across calls to avoid per-
// call typed-array allocation. Callers that pass `out` avoid the
// normal-result object allocation too; callers that omit it keep the
// existing fresh-object API contract.
const _normalWasmScratch = new Float64Array(3);
const _bedNormalWasmScratch = new Float64Array(3);

/** Cached "WASM mesh installed" answer. Polling `terrainIsInstalled()` is a
 * boundary crossing and this module's samplers run thousands of times per
 * tick (every projectile terminal classify, every beam ground sample). A
 * POSITIVE answer is cached against the sim instance and cleared explicitly
 * by terrainState on `terrainClear`; a NEGATIVE answer is re-polled on every
 * call, so the cache can never miss a later install. A momentarily stale
 * positive (between clear and the dirty mark) degrades gracefully: the Rust
 * samplers return their NaN/0 sentinels and callers take the JS fallback. */
let _terrainInstalledSim: object | null = null;

export function markTerrainInstallStateDirty(): void {
  _terrainInstalledSim = null;
}

function isTerrainInstalled(sim: NonNullable<ReturnType<typeof getSimWasm>>): boolean {
  if ((sim as unknown as object) === _terrainInstalledSim) return true;
  if (sim.terrainIsInstalled() !== 0) {
    _terrainInstalledSim = sim as unknown as object;
    return true;
  }
  return false;
}

export function getSurfaceNormal(
  x: number,
  z: number,
  mapWidth: number,
  mapHeight: number,
  cellSize: number = LAND_CELL_SIZE,
  out?: { nx: number; ny: number; nz: number },
): { nx: number; ny: number; nz: number } {
  const sim = getSimWasm();
  if (sim !== undefined && isTerrainInstalled(sim)) {
    const ok = sim.terrainGetSurfaceNormal(x, z, _normalWasmScratch);
    if (ok !== 0) {
      if (out !== undefined) {
        out.nx = _normalWasmScratch[0];
        out.ny = _normalWasmScratch[1];
        out.nz = _normalWasmScratch[2];
        return out;
      }
      return { nx: _normalWasmScratch[0], ny: _normalWasmScratch[1], nz: _normalWasmScratch[2] };
    }
    // Fall through to TS path if Rust returned "no triangle" — e.g.
    // the rare degenerate-mesh case. Caller pays one branch.
  }
  const sample = getTerrainMeshSample(x, z, mapWidth, mapHeight, cellSize);
  const h0 = terrainMeshHeightFromSample(sample);
  if (h0 < WATER_LEVEL) {
    if (out !== undefined) {
      out.nx = 0;
      out.ny = 0;
      out.nz = 1;
      return out;
    }
    return { nx: 0, ny: 0, nz: 1 };
  }
  return out !== undefined
    ? terrainMeshNormalFromSampleInto(sample, out)
    : terrainMeshNormalFromSample(sample);
}

export function applySurfaceTilt(
  vx: number,
  vy: number,
  vz: number,
  n: { nx: number; ny: number; nz: number },
  out?: { x: number; y: number; z: number },
): { x: number; y: number; z: number } {
  const sinT2 = n.nx * n.nx + n.ny * n.ny;
  if (sinT2 < 1e-12) {
    if (out !== undefined) {
      out.x = vx;
      out.y = vy;
      out.z = vz;
      return out;
    }
    return { x: vx, y: vy, z: vz };
  }
  const sinT = DMath.sqrt(sinT2);
  const cosT = n.nz;
  const kx = -n.ny / sinT;
  const ky = n.nx / sinT;
  const kdotv = kx * vx + ky * vy;
  const crossX = ky * vz;
  const crossY = -kx * vz;
  const crossZ = kx * vy - ky * vx;
  const oneMinusCos = 1 - cosT;
  const rx = vx * cosT + crossX * sinT + kx * kdotv * oneMinusCos;
  const ry = vy * cosT + crossY * sinT + ky * kdotv * oneMinusCos;
  const rz = vz * cosT + crossZ * sinT;
  if (out !== undefined) {
    out.x = rx;
    out.y = ry;
    out.z = rz;
    return out;
  }
  return { x: rx, y: ry, z: rz };
}

/** Elevation angle (radians, positive = up) of a surface along a horizontal
 * heading: the pitch a barrel stowed along `yaw` must take to lie parallel
 * to the ground whose unit normal (+Z up) is `n`. Rising ground ahead is
 * positive; flat ground and the water plane (0, 0, 1) give exactly 0.
 * Deterministic — this feeds the lockstep turret joint on every peer. */
export function surfaceSlopePitchAlongHeading(
  n: { nx: number; ny: number; nz: number },
  yaw: number,
): number {
  const rise = -(n.nx * DMath.cos(yaw) + n.ny * DMath.sin(yaw));
  if (rise === 0) return 0;
  const run = n.nz > 1e-6 ? n.nz : 1e-6;
  return DMath.atan2(rise, run);
}

export function getSurfaceHeight(
  x: number,
  z: number,
  mapWidth: number,
  mapHeight: number,
  cellSize: number = LAND_CELL_SIZE,
): number {
  const sim = getSimWasm();
  if (sim !== undefined && isTerrainInstalled(sim)) {
    const h = sim.terrainGetSurfaceHeight(x, z);
    if (!Number.isNaN(h)) return h;
    // Fall through to TS path on NaN sentinel — degenerate triangle
    // or point outside the mesh after clamp.
  }
  return Math.max(
    WATER_LEVEL,
    getTerrainMeshHeight(x, z, mapWidth, mapHeight, cellSize),
  );
}

export function getTerrainBedHeight(
  x: number,
  z: number,
  mapWidth: number,
  mapHeight: number,
  cellSize: number = LAND_CELL_SIZE,
): number {
  const sim = getSimWasm();
  if (sim !== undefined && isTerrainInstalled(sim)) {
    const h = sim.terrainGetBedHeight(x, z);
    if (!Number.isNaN(h)) return h;
  }
  return getTerrainMeshHeight(x, z, mapWidth, mapHeight, cellSize);
}

export function getTerrainBedNormal(
  x: number,
  z: number,
  mapWidth: number,
  mapHeight: number,
  cellSize: number = LAND_CELL_SIZE,
  out?: { nx: number; ny: number; nz: number },
): { nx: number; ny: number; nz: number } {
  const sim = getSimWasm();
  if (sim !== undefined && isTerrainInstalled(sim)) {
    const ok = sim.terrainGetBedNormal(x, z, _bedNormalWasmScratch);
    if (ok !== 0) {
      if (out !== undefined) {
        out.nx = _bedNormalWasmScratch[0];
        out.ny = _bedNormalWasmScratch[1];
        out.nz = _bedNormalWasmScratch[2];
        return out;
      }
      return {
        nx: _bedNormalWasmScratch[0],
        ny: _bedNormalWasmScratch[1],
        nz: _bedNormalWasmScratch[2],
      };
    }
  }
  const sample = getTerrainMeshSample(x, z, mapWidth, mapHeight, cellSize);
  return out !== undefined
    ? terrainMeshNormalFromSampleInto(sample, out)
    : terrainMeshNormalFromSample(sample);
}

export function isWaterAt(
  x: number,
  z: number,
  mapWidth: number,
  mapHeight: number,
  cellSize: number = LAND_CELL_SIZE,
): boolean {
  const flatZone = findDepositFlatZoneAt(x, z);
  if (flatZone) return flatZone.height < WATER_LEVEL;
  // Bed height rides the WASM terrain sampler (with the same JS mesh
  // fallback), so the per-probe barycentric walk stays out of JS on the
  // hot support-surface path.
  return (
    getTerrainBedHeight(x, z, mapWidth, mapHeight, cellSize) < WATER_LEVEL
  );
}


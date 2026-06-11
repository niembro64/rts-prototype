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

const WATER_CLEARANCE_SAMPLES = 8;

// Module-scope scratch for the WASM normal sampler — Rust writes
// (nx, ny, nz) at indices 0..3. Reused across calls to avoid per-
// call typed-array allocation. Callers that pass `out` avoid the
// normal-result object allocation too; callers that omit it keep the
// existing fresh-object API contract.
const _normalWasmScratch = new Float64Array(3);

export function getSurfaceNormal(
  x: number,
  z: number,
  mapWidth: number,
  mapHeight: number,
  cellSize: number = LAND_CELL_SIZE,
  out?: { nx: number; ny: number; nz: number },
): { nx: number; ny: number; nz: number } {
  const sim = getSimWasm();
  if (sim !== undefined && sim.terrainIsInstalled() !== 0) {
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
  const sinT = Math.sqrt(sinT2);
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

export function getSurfaceHeight(
  x: number,
  z: number,
  mapWidth: number,
  mapHeight: number,
  cellSize: number = LAND_CELL_SIZE,
): number {
  const sim = getSimWasm();
  if (sim !== undefined && sim.terrainIsInstalled() !== 0) {
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

export function isWaterAt(
  x: number,
  z: number,
  mapWidth: number,
  mapHeight: number,
  cellSize: number = LAND_CELL_SIZE,
): boolean {
  const flatZone = findDepositFlatZoneAt(x, z);
  if (flatZone) return flatZone.height < WATER_LEVEL;
  return (
    getTerrainMeshHeight(x, z, mapWidth, mapHeight, cellSize) < WATER_LEVEL
  );
}

export function isFarFromWater(
  x: number,
  z: number,
  mapWidth: number,
  mapHeight: number,
  bufferPx: number,
): boolean {
  if (isWaterAt(x, z, mapWidth, mapHeight)) return false;
  if (bufferPx <= 0) return true;
  for (let i = 0; i < WATER_CLEARANCE_SAMPLES; i++) {
    const a = (i / WATER_CLEARANCE_SAMPLES) * Math.PI * 2;
    const px = x + Math.cos(a) * bufferPx;
    const pz = z + Math.sin(a) * bufferPx;
    if (isWaterAt(px, pz, mapWidth, mapHeight)) return false;
  }
  return true;
}

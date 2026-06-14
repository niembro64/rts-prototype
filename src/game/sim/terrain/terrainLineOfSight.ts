import { deterministicMath as DMath } from '@/game/sim/deterministicMath';
import { LAND_CELL_SIZE } from '../../../config';
import { getSimWasm } from '../../sim-wasm/init';
import type { WorldState } from '../WorldState';

/** Step the terrain LOS ray at this fraction of LAND_CELL_SIZE. Half-cell
 *  is the natural floor: terrain features authored at cell scale cannot
 *  hide between samples. */
const TERRAIN_LOS_STEP_FRAC = 0.5;

/** True if the straight line from (sx,sy,sz) to (tx,ty,tz) clears the
 *  terrain surface. Higher-level callers compose this with any
 *  non-terrain blockers their policy requires. */
export function hasTerrainLineOfSight(
  world: WorldState,
  sx: number, sy: number, sz: number,
  tx: number, ty: number, tz: number,
): boolean {
  const stepLen = LAND_CELL_SIZE * TERRAIN_LOS_STEP_FRAC;
  const sim = getSimWasm();
  if (sim !== undefined) {
    const result = sim.terrainHasLineOfSight(sx, sy, sz, tx, ty, tz, stepLen);
    if (result !== 2) return result === 1;
  }
  const dx = tx - sx;
  const dy = ty - sy;
  const dz = tz - sz;
  const horizDist = DMath.hypot(dx, dy);
  if (horizDist < stepLen) return true;
  const stepCount = Math.ceil(horizDist / stepLen);
  for (let i = 1; i < stepCount; i++) {
    const t = i / stepCount;
    const x = sx + dx * t;
    const y = sy + dy * t;
    const rayZ = sz + dz * t;
    if (world.getGroundZ(x, y) > rayZ) return false;
  }
  return true;
}

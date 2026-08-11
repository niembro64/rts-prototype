import { deterministicMath as DMath } from '@/game/sim/deterministicMath';
import { LAND_CELL_SIZE } from '../../../config';
import { getSimWasm } from '../../sim-wasm/init';
import type { WorldState } from '../WorldState';

/** Step the terrain LOS ray at this fraction of LAND_CELL_SIZE. Half-cell
 *  is the natural floor: terrain features authored at cell scale cannot
 *  hide between samples. */
const TERRAIN_LOS_STEP_FRAC = 0.5;
const TERRAIN_LOS_STEP_LEN = LAND_CELL_SIZE * TERRAIN_LOS_STEP_FRAC;
const TERRAIN_LOS_STEP_LEN_SQ = TERRAIN_LOS_STEP_LEN * TERRAIN_LOS_STEP_LEN;

/** True if the straight line from (sx,sy,sz) to (tx,ty,tz) clears the SOLID
 *  terrain. Higher-level callers compose this with any non-terrain blockers
 *  their policy requires.
 *
 *  The occluder is the terrain BED, not the gameplay ground. getGroundZ clamps
 *  to the liquid surface wherever the bed sits under it, so sampling it here
 *  made the water surface an opaque wall: any sightline whose ray dipped below
 *  the waterline was blocked by the sea itself, and underwater-to-underwater
 *  full sight could never succeed no matter what a suite authored. Sonar still
 *  worked -- the contact tier runs no sightline -- so the symptom was submarines
 *  that could be heard and never seen.
 *
 *  Water is a MEDIUM, not geometry. Which media a sensor bridges is decided by
 *  the source-row/target-column matrix in sensorConfig; this function only
 *  answers whether solid ground is in the way. Above-water pairs are unaffected:
 *  a straight line between two points above the waterline never dips below it,
 *  so bed and ground give the same answer there. It also puts the JS fallback
 *  back in step with the WASM path, which samples the terrain mesh directly. */
export function hasTerrainLineOfSight(
  world: WorldState,
  sx: number, sy: number, sz: number,
  tx: number, ty: number, tz: number,
): boolean {
  const dx = tx - sx;
  const dy = ty - sy;
  if (dx * dx + dy * dy < TERRAIN_LOS_STEP_LEN_SQ) return true;
  const sim = getSimWasm();
  if (sim !== undefined) {
    const result = sim.terrainHasLineOfSight(sx, sy, sz, tx, ty, tz, TERRAIN_LOS_STEP_LEN);
    if (result !== 2) return result === 1;
  }
  const dz = tz - sz;
  const horizDist = DMath.hypot(dx, dy);
  const stepCount = Math.ceil(horizDist / TERRAIN_LOS_STEP_LEN);
  for (let i = 1; i < stepCount; i++) {
    const t = i / stepCount;
    const x = sx + dx * t;
    const y = sy + dy * t;
    const rayZ = sz + dz * t;
    if (world.getTerrainBedZ(x, y) > rayZ) return false;
  }
  return true;
}

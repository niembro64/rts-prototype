// Terrain line-of-sight gating for direct-fire turrets.
//
// High-arc shells lob over hills, force-field emitters are area effects,
// and mirror panels rotate toward unseen threats — none of those care
// about terrain blocking. Everything else (cannons, beams, lasers,
// gatlings) needs a clear sightline from its turret head to the target
// center before it can lock on or keep firing.

import { LAND_CELL_SIZE } from '../../../config';
import type { WorldState } from '../WorldState';
import type { Turret } from '../../../types/sim';

/** Step the LOS ray at this fraction of LAND_CELL_SIZE. Half-cell is
 *  the natural floor: terrain features authored at cell scale cannot
 *  hide between samples. Smaller is wasted work; larger could miss
 *  thin ridges. */
const LOS_STEP_FRAC = 0.5;

/** Ticks of consecutive LOS occlusion before a tracked target is
 *  dropped entirely. Engagement (firing) is gated immediately on the
 *  first blocked tick; the grace only delays the full lock-loss so a
 *  unit briefly clipping a corner doesn't restart the spatial-grid
 *  reacquisition cycle. ~67 ms at 60 TPS. */
export const LOS_DROP_GRACE_TICKS = 4;

/** Whether this turret's targeting must respect terrain occlusion. */
export function weaponNeedsLineOfSight(weapon: Turret): boolean {
  const cfg = weapon.config;
  if (cfg.highArc) return false;
  if (cfg.verticalLauncher) return false;
  if (cfg.shot.type === 'force') return false;
  if (cfg.passive) return false;
  return true;
}

/** True if the straight line from (sx,sy,sz) to (tx,ty,tz) clears the
 *  terrain surface. Walks intermediate samples at half-cell resolution
 *  and compares each ray height against the authoritative ground
 *  height. The endpoints sit inside the source/target collider geometry
 *  and are skipped. */
export function hasTerrainLineOfSight(
  world: WorldState,
  sx: number, sy: number, sz: number,
  tx: number, ty: number, tz: number,
): boolean {
  const dx = tx - sx;
  const dy = ty - sy;
  const dz = tz - sz;
  const horizDist = Math.hypot(dx, dy);
  const stepLen = LAND_CELL_SIZE * LOS_STEP_FRAC;
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

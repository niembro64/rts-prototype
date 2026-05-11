// Line-of-sight gating for direct-fire turrets.
//
// High-arc shells lob over hills, force-field emitters are area effects,
// and mirror panels rotate toward unseen threats — none of those care
// about world occlusion. Everything else (cannons, beams, lasers,
// gatlings) needs a clear sightline from its turret head to the target
// aim point before it can lock on or keep firing.

import { LAND_CELL_SIZE } from '../../../config';
import { lineSphereIntersectionT, rayBoxIntersectionT } from '../../math';
import { spatialGrid } from '../SpatialGrid';
import type { WorldState } from '../WorldState';
import type { EntityId, Turret } from '../../../types/sim';
import { UNIT_BLUEPRINTS } from '../blueprints/units';

/** Step the LOS ray at this fraction of LAND_CELL_SIZE. Half-cell is
 *  the natural floor: terrain features authored at cell scale cannot
 *  hide between samples. Smaller is wasted work; larger could miss
 *  thin ridges. */
const LOS_STEP_FRAC = 0.5;
const LOS_ENTITY_QUERY_WIDTH = LAND_CELL_SIZE;
const LOS_UNIT_QUERY_WIDTH = LOS_ENTITY_QUERY_WIDTH + 2 * Math.max(
  0,
  ...Object.values(UNIT_BLUEPRINTS).map((bp) => bp.radius.push),
);

/** Ticks of consecutive LOS occlusion before a tracked target is
 *  dropped entirely. Engagement (firing) is gated immediately on the
 *  first blocked tick; the grace only delays the full lock-loss so a
 *  unit briefly clipping a corner doesn't restart the spatial-grid
 *  reacquisition cycle. ~67 ms at 60 TPS. */
export const LOS_DROP_GRACE_TICKS = 4;

/** Whether this turret's targeting must respect line-of-sight occlusion. */
export function weaponNeedsLineOfSight(weapon: Turret): boolean {
  const cfg = weapon.config;
  if (cfg.aimStyle === 'high' || cfg.aimStyle === 'none') return false;
  if (cfg.verticalLauncher) return false;
  if (cfg.shot?.type === 'force') return false;
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

function isExcludedLineOfSightEntity(
  id: EntityId,
  sourceEntityId: EntityId | undefined,
  targetEntityId: EntityId | undefined,
): boolean {
  return id === sourceEntityId || id === targetEntityId;
}

/** True if no live unit push sphere or building AABB intersects the
 *  straight sightline. The shooter and intended target are ignored
 *  because the sightline can start/end inside or on their gameplay
 *  colliders; every other live unit/building is a blocker regardless
 *  of ownership. */
export function hasEntityLineOfSight(
  sx: number, sy: number, sz: number,
  tx: number, ty: number, tz: number,
  sourceEntityId?: EntityId,
  targetEntityId?: EntityId,
): boolean {
  const nearbyUnits = spatialGrid.queryUnitsAlongLine(
    sx, sy, sz,
    tx, ty, tz,
    LOS_UNIT_QUERY_WIDTH,
  );
  for (const unit of nearbyUnits) {
    if (isExcludedLineOfSightEntity(unit.id, sourceEntityId, targetEntityId)) continue;
    if (!unit.unit || unit.unit.hp <= 0) continue;

    const t = lineSphereIntersectionT(
      sx, sy, sz,
      tx, ty, tz,
      unit.transform.x, unit.transform.y, unit.transform.z,
      unit.unit.radius.push,
    );
    if (t !== null) return false;
  }

  const nearbyBuildings = spatialGrid.queryBuildingsAlongLine(
    sx, sy, sz,
    tx, ty, tz,
    LOS_ENTITY_QUERY_WIDTH,
  );
  for (const building of nearbyBuildings) {
    if (isExcludedLineOfSightEntity(building.id, sourceEntityId, targetEntityId)) continue;
    if (!building.building || building.building.hp <= 0) continue;

    const b = building.building;
    const halfW = b.width / 2;
    const halfH = b.height / 2;
    const halfD = b.depth / 2;
    const t = rayBoxIntersectionT(
      sx, sy, sz,
      tx, ty, tz,
      building.transform.x - halfW,
      building.transform.y - halfH,
      building.transform.z - halfD,
      building.transform.x + halfW,
      building.transform.y + halfH,
      building.transform.z + halfD,
    );
    if (t !== null) return false;
  }

  return true;
}

/** Full direct-fire sightline: terrain plus live unit/building
 *  occluders. */
export function hasCombatLineOfSight(
  world: WorldState,
  sx: number, sy: number, sz: number,
  tx: number, ty: number, tz: number,
  sourceEntityId?: EntityId,
  targetEntityId?: EntityId,
): boolean {
  return (
    hasTerrainLineOfSight(world, sx, sy, sz, tx, ty, tz) &&
    hasEntityLineOfSight(sx, sy, sz, tx, ty, tz, sourceEntityId, targetEntityId)
  );
}

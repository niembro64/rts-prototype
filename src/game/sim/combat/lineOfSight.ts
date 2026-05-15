// Line-of-sight gating for direct-fire turrets.
//
// High-arc shells lob over hills, force-field emitters are area effects,
// and mirror panels rotate toward unseen threats — none of those care
// about world occlusion. Everything else (cannons, beams, lasers,
// gatlings) needs a clear sightline from its turret head to the target
// aim point before it can lock on or keep firing.

import { LAND_CELL_SIZE } from '../../../config';
import { lineSphereIntersectionT, rayBoxIntersectionT } from '../../math';
import { getSimWasm } from '../../sim-wasm/init';
import { spatialGrid } from '../SpatialGrid';
import type { WorldState } from '../WorldState';
import type { EntityId, Turret } from '../../../types/sim';
import { UNIT_BLUEPRINTS } from '../blueprints/units';
import type { ActiveForceFieldRef } from './forceFieldTurret';

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
  if (cfg.aimStyle === 'highArc' || cfg.aimStyle === 'none') return false;
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
  const stepLen = LAND_CELL_SIZE * LOS_STEP_FRAC;
  const sim = getSimWasm();
  if (sim !== undefined) {
    // WASM walks the segment entirely inside Rust — one boundary
    // crossing instead of `stepCount` getGroundZ dispatches.
    const result = sim.terrainHasLineOfSight(sx, sy, sz, tx, ty, tz, stepLen);
    if (result !== 2) return result === 1;
    // result === 2: no mesh installed → fall through to TS path.
  }
  const dx = tx - sx;
  const dy = ty - sy;
  const dz = tz - sz;
  const horizDist = Math.hypot(dx, dy);
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

/** True if the segment from (sx,sy,sz) to (tx,ty,tz) crosses the
 *  spherical boundary of `field` — i.e., the field is physically
 *  "in the way" of the line. Boundary crossings near the segment
 *  endpoints (within FORCE_FIELD_GRAZE_EPS) are treated as
 *  non-blocking so a turret or target sitting on a shield edge
 *  doesn't flicker between locked and unlocked. */
const FORCE_FIELD_GRAZE_EPS = 1e-6;
function segmentCrossesForceFieldBoundary(
  sx: number, sy: number, sz: number,
  tx: number, ty: number, tz: number,
  cx: number, cy: number, cz: number,
  radius: number,
): boolean {
  // Cheap AABB reject before the quadratic. A shield off to one side of
  // the segment's bounding box can't possibly contribute a crossing.
  if (Math.max(sx, tx) < cx - radius || Math.min(sx, tx) > cx + radius) return false;
  if (Math.max(sy, ty) < cy - radius || Math.min(sy, ty) > cy + radius) return false;
  if (Math.max(sz, tz) < cz - radius || Math.min(sz, tz) > cz + radius) return false;

  const dx = tx - sx;
  const dy = ty - sy;
  const dz = tz - sz;
  const a = dx * dx + dy * dy + dz * dz;
  if (a < 1e-9) return false;

  const fx = sx - cx;
  const fy = sy - cy;
  const fz = sz - cz;
  const b = 2 * (fx * dx + fy * dy + fz * dz);
  const c = fx * fx + fy * fy + fz * fz - radius * radius;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return false;

  const sqrtDisc = Math.sqrt(disc);
  const invDenom = 1 / (2 * a);
  const t1 = (-b - sqrtDisc) * invDenom;
  const t2 = (-b + sqrtDisc) * invDenom;
  const lo = FORCE_FIELD_GRAZE_EPS;
  const hi = 1 - FORCE_FIELD_GRAZE_EPS;
  return (t1 > lo && t1 < hi) || (t2 > lo && t2 < hi);
}

export type ForceFieldClearanceOptions = {
  /** Number of force fields a turret may "see through." 0 = any
   *  intervening field blocks lock-on (default). Future targeting
   *  brain upgrades raise this per-player to pierce N shields. */
  maxCrossings?: number;
  /** Entity id of the unit firing. Fields emitted by this same unit
   *  are skipped so a unit can fight from inside its own shield —
   *  the whole point of a force-field turret is to target enemies
   *  outside its protective sphere. Fields emitted by any other
   *  unit (teammate or enemy) still block. */
  excludeOwnerEntityId?: number;
};

/** True if no active force-field sphere stands between the segment's
 *  endpoints. Force fields are physical, team-agnostic barriers — the
 *  same rule applies to every turret in either direction. A field is
 *  "in the way" when the line from source to target crosses its
 *  boundary at any point strictly inside the segment. The only
 *  exemption is the unit's own field (see options.excludeOwnerEntityId).
 *
 *  Performance: caller passes the per-tick cached field list (from
 *  getActiveForceFields()). With a typical handful of fields and the
 *  cheap AABB pre-check, this stays well under a microsecond per call. */
export function hasForceFieldClearance(
  sx: number, sy: number, sz: number,
  tx: number, ty: number, tz: number,
  fields: readonly ActiveForceFieldRef[],
  options: ForceFieldClearanceOptions = {},
): boolean {
  if (fields.length === 0) return true;
  const maxCrossings = options.maxCrossings ?? 0;
  const excludeOwnerEntityId = options.excludeOwnerEntityId;
  let crossings = 0;
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    if (f.entityId === excludeOwnerEntityId) continue;
    if (
      segmentCrossesForceFieldBoundary(
        sx, sy, sz,
        tx, ty, tz,
        f.centerX, f.centerY, f.centerZ,
        f.radius,
      )
    ) {
      crossings++;
      if (crossings > maxCrossings) return false;
    }
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

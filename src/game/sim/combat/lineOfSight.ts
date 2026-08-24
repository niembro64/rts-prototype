// Terrain/entity line-of-sight gating for direct-fire turrets.
//
// High-arc shells lob over hills, and shield-only emitters maintain
// area effects through their own force material. Everything else
// (cannons, beams, gatlings, and shield emitters with offensive
// submunitions) needs a clear sightline from its turret head to the
// target aim point before it can lock on or keep firing. Cross-shield
// sight obstruction is a separate targeting gate.
//
// That shield gate is directional, and deliberately matches what the barrier
// does to a shot rather than being its own rule: a closed dome obstructs a
// sightline only when the line ENTERS it, because every barrier authors
// `reflect-outside` and therefore lets its own side's fire out. A flat mirror
// panel has no inside and obstructs from either face, which is what its
// `reflect-both` policy says too. See shield_segment_enters_sphere in
// projectile_interactions.rs.

import { LAND_CELL_SIZE } from '../../../config';
import type { WorldState } from '../WorldState';
import type { Turret } from '../../../types/sim';
import { maxUnitCollisionRadius } from '../blueprints/buildings';
import { hasTerrainLineOfSight } from '../terrain/terrainLineOfSight';

/** Terrain samples still use the half-cell cadence; the walk now runs
 *  inside the AIM-08.LOS Rust combat LOS kernel. */
const LOS_STEP_FRAC = 0.5;
/** Effective per-call params for the Rust LOS kernel. Exported so the
 *  unified gate kernels (which call combat_has_line_of_sight directly
 *  from inside another Rust function) can be invoked from JS with the
 *  same values the old per-turret path used. */
export const COMBAT_LOS_TERRAIN_STEP_LEN = LAND_CELL_SIZE * LOS_STEP_FRAC;
export const COMBAT_LOS_ENTITY_QUERY_WIDTH = LAND_CELL_SIZE + 2 * Math.max(
  0,
  maxUnitCollisionRadius(),
);
/** Force-field-panel broadphase pad. Stamping adds this to the mirror's
 *  bound radius so the Rust shield-panel kernel only narrowphase-walks
 *  units whose silhouettes can touch the segment. */
export const MIRROR_SIGHT_QUERY_PAD = 1;

/** Ticks of consecutive sight obstruction before a tracked target is
 *  dropped entirely. Engagement (firing) is gated immediately on the
 *  first blocked tick; the grace only delays the full lock-loss so a
 *  unit briefly clipping a corner doesn't restart the spatial-grid
 *  reacquisition cycle. ~67 ms at 60 TPS. */
export const SIGHT_DROP_GRACE_TICKS = 4;

/** Whether this turret's targeting must respect line-of-sight occlusion. */
export function weaponRequiresNonObstructedLineOfSight(weapon: Turret): boolean {
  return weapon.config.requiresNonObstructedLineOfSight;
}

/** Whether this turret may keep its targeting ray through force material
 *  when shield-aware targeting is enabled. This is deliberately narrower
 *  than "is a shield emission": shield-only emitters need the exemption
 *  to maintain their own barrier, but shield emitters with offensive
 *  submunitions must obey the same obstruction rule as every other
 *  attacking turret. */
export function turretIgnoresForceMaterialSightObstruction(weapon: Turret): boolean {
  return weapon.config.shot?.type === 'shield' && weapon.config.submunitions === null;
}

/** Fog/entity-visibility sightline policy. This intentionally does not
 *  use hasCombatLineOfSight because ordinary unit/building bodies do
 *  not hide fog-of-war information, and force material no longer does
 *  either: shield-aware behaviour is a per-player TARGETING upgrade
 *  (see WorldState.playerHasShieldAwareTargeting), not a vision rule.
 *  Terrain is the only fog occluder. */
export function hasFogOfWarLineOfSight(
  world: WorldState,
  sx: number, sy: number, sz: number,
  tx: number, ty: number, tz: number,
): boolean {
  return hasTerrainLineOfSight(world, sx, sy, sz, tx, ty, tz);
}

// Line-of-sight gating for direct-fire turrets.
//
// High-arc shells lob over hills, force-field emitters are area effects,
// and mirror panels rotate toward unseen threats — none of those care
// about world occlusion. Everything else (cannons, beams, lasers,
// gatlings) needs a clear sightline from its turret head to the target
// aim point before it can lock on or keep firing.

import { LAND_CELL_SIZE } from '../../../config';
import { getSimWasm } from '../../sim-wasm/init';
import type { WorldState } from '../WorldState';
import type { EntityId, Turret } from '../../../types/sim';
import { UNIT_BLUEPRINTS } from '../blueprints/units';

/** Terrain samples still use the half-cell cadence; the walk now runs
 *  inside the AIM-08.LOS Rust combat LOS kernel. */
const LOS_STEP_FRAC = 0.5;
const COMBAT_LOS_ENTITY_QUERY_WIDTH = LAND_CELL_SIZE + 2 * Math.max(
  0,
  ...Object.values(UNIT_BLUEPRINTS).map((bp) => bp.radius.push),
);
const NO_EXCLUDED_ENTITY = -1;

/** Ticks of consecutive LOS occlusion before a tracked target is
 *  dropped entirely. Engagement (firing) is gated immediately on the
 *  first blocked tick; the grace only delays the full lock-loss so a
 *  unit briefly clipping a corner doesn't restart the spatial-grid
 *  reacquisition cycle. ~67 ms at 60 TPS. */
export const LOS_DROP_GRACE_TICKS = 4;

/** Whether this turret's targeting must respect line-of-sight occlusion. */
export function weaponNeedsLineOfSight(weapon: Turret): boolean {
  const cfg = weapon.config;
  if (cfg.aimStyle.angleType === 'ballisticArcHigh') return false;
  if (cfg.verticalLauncher) return false;
  if (cfg.shot?.type === 'force') return false;
  if (cfg.passive) return false;
  return true;
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

/** AIM-08.2 — Sentinel passed to the Rust kernel when no owner is
 *  excluded. -1 cannot collide with a real entityId because entity ids
 *  are non-negative; the kernel skips a field iff its stamped owner
 *  matches the sentinel-or-real value handed in. */
const NO_EXCLUDED_OWNER = -1;

/** True if no active force-field sphere stands between the segment's
 *  endpoints. Force fields are physical, team-agnostic barriers — the
 *  same rule applies to every turret in either direction. A field is
 *  "in the way" when the line from source to target crosses its
 *  boundary at any point strictly inside the segment. The only
 *  exemption is the unit's own field (see options.excludeOwnerEntityId).
 *
 *  Use this for direct-fire weapons (beams, lasers, low-arc cannons
 *  whose trajectory really is approximately the straight chord).
 *  Ballistic-arc and vertical-launch shots should call
 *  `hasArcForceFieldClearance` instead so the targeting test walks the
 *  same parabolic envelope the projectile will actually fly.
 *
 *  Implementation: dispatches to the Rust `force_field_clearance_segment`
 *  kernel, which reads the FF pool slab stamped each tick by
 *  stampForceFieldPool. Endpoint grazes (within FORCE_FIELD_GRAZE_EPS)
 *  don't count, matching the projectile-collision behaviour so lock-on
 *  agrees with what the simulator will actually let through. */
export function hasForceFieldClearance(
  sx: number, sy: number, sz: number,
  tx: number, ty: number, tz: number,
  options: ForceFieldClearanceOptions = {},
): boolean {
  const sim = getSimWasm();
  if (sim === undefined) return true;
  const maxCrossings = options.maxCrossings ?? 0;
  const excludeOwnerEntityId = options.excludeOwnerEntityId ?? NO_EXCLUDED_OWNER;
  return (
    sim.forceFieldPool.clearanceSegment(
      sx, sy, sz,
      tx, ty, tz,
      excludeOwnerEntityId,
      maxCrossings,
    ) === 1
  );
}

/** True if the parabolic ballistic arc described by
 *  (launch position, launch velocity, flight time, universal gravity)
 *  does not enter any non-self force-field sphere between launch and
 *  impact. The arc-aware counterpart of `hasForceFieldClearance`:
 *  walks the same `pos = p₀ + v·t − 0.5·g·ẑ·t²` envelope the projectile
 *  integrator advances each tick, so lock-on rules and projectile-
 *  collision rules agree on which shields stop a shot.
 *
 *  Implementation: dispatches to the Rust `force_field_clearance_arc`
 *  kernel, which interior-samples the parabola (i=1..N-1) so the same
 *  "endpoints don't count" rule applies as for the straight test. */
export function hasArcForceFieldClearance(
  launchX: number, launchY: number, launchZ: number,
  launchVx: number, launchVy: number, launchVz: number,
  flightTime: number,
  options: ForceFieldClearanceOptions = {},
): boolean {
  const sim = getSimWasm();
  if (sim === undefined) return true;
  const maxCrossings = options.maxCrossings ?? 0;
  const excludeOwnerEntityId = options.excludeOwnerEntityId ?? NO_EXCLUDED_OWNER;
  return (
    sim.forceFieldPool.clearanceArc(
      launchX, launchY, launchZ,
      launchVx, launchVy, launchVz,
      flightTime,
      excludeOwnerEntityId,
      maxCrossings,
    ) === 1
  );
}

/** Full direct-fire sightline: terrain plus live unit/building
 *  occluders. The Rust kernel owns the per-call gate math and reads
 *  live blockers from the spatial slab; TypeScript only supplies the
 *  segment and source/target exclusions. */
export function hasCombatLineOfSight(
  _world: WorldState,
  sx: number, sy: number, sz: number,
  tx: number, ty: number, tz: number,
  sourceEntityId?: EntityId,
  targetEntityId?: EntityId,
): boolean {
  const sim = getSimWasm();
  if (sim === undefined) return true;
  return sim.combatHasLineOfSight(
    sx, sy, sz,
    tx, ty, tz,
    LAND_CELL_SIZE * LOS_STEP_FRAC,
    COMBAT_LOS_ENTITY_QUERY_WIDTH,
    sourceEntityId ?? NO_EXCLUDED_ENTITY,
    targetEntityId ?? NO_EXCLUDED_ENTITY,
  ) === 1;
}

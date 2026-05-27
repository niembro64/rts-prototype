// Terrain/entity line-of-sight gating for direct-fire turrets.
//
// High-arc shells lob over hills, force-field emitters are area effects,
// and force-field panels rotate toward unseen threats — none of those care
// about world occlusion. Everything else (cannons, beams, lasers,
// gatlings) needs a clear sightline from its turret head to the target
// aim point before it can lock on or keep firing. Cross-force-field
// sight obstruction is a separate targeting gate.

import { LAND_CELL_SIZE } from '../../../config';
import { getSimWasm } from '../../sim-wasm/init';
import type { WorldState } from '../WorldState';
import type { EntityId, Turret } from '../../../types/sim';
import { UNIT_BLUEPRINTS } from '../blueprints/units';
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
  ...Object.values(UNIT_BLUEPRINTS).map((bp) => bp.radius.push),
);
const NO_EXCLUDED_ENTITY = -1;
/** Sightline-graze epsilon. Hits within FORCE_MATERIAL_GRAZE_EPS of
 *  either endpoint don't count — keeps targeting and projectile
 *  collision in agreement when a turret or target sits on a panel
 *  edge. Force-field-panel and force-field clearance both use this. */
export const FORCE_MATERIAL_GRAZE_EPS = 1e-6;
/** Force-field-panel broadphase pad. Stamping adds this to the mirror's
 *  bound radius so the Rust force-field-panel kernel only narrowphase-walks
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

export type ForceFieldClearanceOptions = {
  /** Number of force fields a turret may "see through." 0 = any
   *  intervening field blocks lock-on (default). Future targeting
   *  brain upgrades raise this per-player to pierce N shields. */
  maxCrossings: number | undefined;
};

/** AIM-08.2 — Sentinel passed to the Rust kernel so no shield owner is
 *  excluded. -1 cannot collide with a real entityId because entity ids
 *  are non-negative. */
const NO_EXCLUDED_OWNER = -1;

/** True if no active force-field sphere stands between the segment's
 *  endpoints. Force fields are physical, team-agnostic barriers — the
 *  same rule applies to every turret in either direction. A field is
 *  "in the way" when the line from source to target crosses its
 *  boundary at any point strictly inside the segment.
 *
 *  Use this for straight visibility checks against force-field spheres.
 *  The targeting gate kernels in Rust layer force-field-panel clearance
 *  on top via the force-field-panel slab for OBSTRUCT SIGHT targeting.
 *
 *  Implementation: dispatches to the Rust `force_field_clearance_segment`
 *  kernel, which reads the FF pool slab stamped each tick by
 *  stampForceFieldPool. Endpoint grazes (within FORCE_FIELD_GRAZE_EPS)
 *  don't count, matching the projectile-collision behaviour so lock-on
 *  agrees with what the simulator will actually let through. */
export function hasForceFieldClearance(
  sx: number, sy: number, sz: number,
  tx: number, ty: number, tz: number,
  options: ForceFieldClearanceOptions = { maxCrossings: undefined },
): boolean {
  const sim = getSimWasm();
  if (sim === undefined) return true;
  const maxCrossings = options.maxCrossings ?? 0;
  return (
    sim.forceFieldPool.clearanceSegment(
      sx, sy, sz,
      tx, ty, tz,
      NO_EXCLUDED_OWNER,
      maxCrossings,
    ) === 1
  );
}

export function hasForceFieldPanelClearance(
  sx: number, sy: number, sz: number,
  tx: number, ty: number, tz: number,
): boolean {
  const sim = getSimWasm();
  if (sim === undefined) return true;
  return sim.forceFieldPanelPool.clearanceSegment(sx, sy, sz, tx, ty, tz) === 1;
}

/** Fog/entity-visibility sightline policy. This intentionally does not
 *  use hasCombatLineOfSight because ordinary unit/building bodies do
 *  not hide fog-of-war information. Shape-independent force material
 *  does: when OBSTRUCT SIGHT is active, force-field spheres and mirror
 *  panels block the same visibility ray after terrain has cleared. */
export function hasFogOfWarLineOfSight(
  world: WorldState,
  sx: number, sy: number, sz: number,
  tx: number, ty: number, tz: number,
): boolean {
  if (!hasTerrainLineOfSight(world, sx, sy, sz, tx, ty, tz)) return false;
  if (!world.forceFieldsObstructSight) return true;
  if (
    world.turretForceFieldSpheresEnabled &&
    !hasForceFieldClearance(sx, sy, sz, tx, ty, tz)
  ) {
    return false;
  }
  if (
    world.turretForceFieldPanelsEnabled &&
    !hasForceFieldPanelClearance(sx, sy, sz, tx, ty, tz)
  ) {
    return false;
  }
  return true;
}

/** True if the parabolic ballistic arc described by
 *  (launch position, launch velocity, flight time, universal gravity)
 *  does not cross any force-field sphere boundary between launch and
 *  impact. The arc-aware counterpart of `hasForceFieldClearance`
 *  approximates the same `pos = p₀ + v·t − 0.5·g·ẑ·t²` envelope the
 *  projectile integrator advances each tick.
 *
 *  Implementation: dispatches to the Rust `force_field_clearance_arc`
 *  kernel, which chord-samples the parabola so the same "endpoints
 *  don't count" rule applies as for the straight test. Keep this
 *  helper for callers that need projectile-path clearance — the
 *  targeting gate uses the segment + slab walks in Rust directly. */
export function hasArcForceFieldClearance(
  launchX: number, launchY: number, launchZ: number,
  launchVx: number, launchVy: number, launchVz: number,
  flightTime: number,
  options: ForceFieldClearanceOptions = { maxCrossings: undefined },
): boolean {
  const sim = getSimWasm();
  if (sim === undefined) return true;
  const maxCrossings = options.maxCrossings ?? 0;
  return (
    sim.forceFieldPool.clearanceArc(
      launchX, launchY, launchZ,
      launchVx, launchVy, launchVz,
      flightTime,
      NO_EXCLUDED_OWNER,
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
  sourceEntityId: EntityId | undefined = undefined,
  targetEntityId: EntityId | undefined = undefined,
): boolean {
  const sim = getSimWasm();
  if (sim === undefined) return true;
  return sim.combatHasLineOfSight(
    sx, sy, sz,
    tx, ty, tz,
    COMBAT_LOS_TERRAIN_STEP_LEN,
    COMBAT_LOS_ENTITY_QUERY_WIDTH,
    sourceEntityId ?? NO_EXCLUDED_ENTITY,
    targetEntityId ?? NO_EXCLUDED_ENTITY,
  ) === 1;
}

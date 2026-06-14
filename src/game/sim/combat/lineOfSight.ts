// Terrain/entity line-of-sight gating for direct-fire turrets.
//
// High-arc shells lob over hills, and shield-only emitters maintain
// area effects through their own force material. Everything else
// (cannons, beams, lasers, gatlings, and shield emitters with offensive
// submunitions) needs a clear sightline from its turret head to the
// target aim point before it can lock on or keep firing. Cross-shield
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
  ...Object.values(UNIT_BLUEPRINTS).map((bp) => bp.radius.collision),
);
const NO_EXCLUDED_ENTITY = -1;
/** Sightline-graze epsilon. Hits within FORCE_MATERIAL_GRAZE_EPS of
 *  either endpoint don't count — keeps targeting and projectile
 *  collision in agreement when a turret or target sits on a panel
 *  edge. Force-field-panel and shield clearance both use this. */
export const FORCE_MATERIAL_GRAZE_EPS = 1e-6;
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
  return weapon.config.shot?.type === 'shield' && weapon.config.submunitions === undefined;
}

export type ShieldClearanceOptions = {
  /** Number of shields a turret may "see through." 0 = any
   *  intervening field blocks lock-on (default). Future targeting
   *  brain upgrades raise this per-player to pierce N shields. */
  maxCrossings: number | undefined;
};

/** AIM-08.2 — Sentinel passed to the Rust kernel so no shield owner is
 *  excluded. -1 cannot collide with a real entityId because entity ids
 *  are non-negative. */
const NO_EXCLUDED_OWNER = -1;

/** True if no active shield sphere stands between the segment's
 *  endpoints. Shields are physical, team-agnostic barriers — the
 *  same rule applies to every turret in either direction. A field is
 *  "in the way" when the line from source to target crosses its
 *  boundary at any point strictly inside the segment.
 *
 *  Use this for straight visibility checks against shield spheres.
 *  The targeting gate kernels in Rust layer shield-panel clearance
 *  on top via the shield-panel slab for shield-aware targeting.
 *
 *  Implementation: dispatches to the Rust `shield_clearance_segment`
 *  kernel, which reads the FF pool slab stamped each tick by
 *  stampShieldPool. Endpoint grazes (within SHIELD_GRAZE_EPS)
 *  don't count, matching the projectile-collision behaviour so lock-on
 *  agrees with what the simulator will actually let through. */
/** Which shield shapes a clearance query considers. Materials Are
 *  Independent Of Shape: spheres and flat panels are one material, so a
 *  single query answers both — the flags only exist so a caller can
 *  restrict to shapes currently enabled by battle-bar toggles. */
export type ShieldShapeMask = {
  includeSpheres: boolean;
  includePanels: boolean;
};

export function hasShieldClearance(
  sx: number, sy: number, sz: number,
  tx: number, ty: number, tz: number,
  shapes: ShieldShapeMask,
  options: ShieldClearanceOptions = { maxCrossings: undefined },
): boolean {
  const sim = getSimWasm();
  if (sim === undefined) return true;
  const maxCrossings = options.maxCrossings ?? 0;
  return (
    sim.shieldSurfacePool.clearanceSegment(
      sx, sy, sz,
      tx, ty, tz,
      NO_EXCLUDED_OWNER,
      maxCrossings,
      shapes.includeSpheres ? 1 : 0,
      shapes.includePanels ? 1 : 0,
    ) === 1
  );
}

/** Fog/entity-visibility sightline policy. This intentionally does not
 *  use hasCombatLineOfSight because ordinary unit/building bodies do
 *  not hide fog-of-war information. Shape-independent force material
 *  does: when shield-aware targeting is active, shield spheres and
 *  mirror panels block the same visibility ray after terrain has
 *  cleared. */
export function hasFogOfWarLineOfSight(
  world: WorldState,
  sx: number, sy: number, sz: number,
  tx: number, ty: number, tz: number,
): boolean {
  if (!hasTerrainLineOfSight(world, sx, sy, sz, tx, ty, tz)) return false;
  if (!world.shieldsObstructSight) return true;
  // One material, two shapes: a single clearance query answers both the
  // sphere and the flat-panel surface, each gated by its battle-bar toggle.
  if (
    !hasShieldClearance(sx, sy, sz, tx, ty, tz, {
      includeSpheres: world.turretShieldSpheresEnabled,
      includePanels: world.turretShieldPanelsEnabled,
    })
  ) {
    return false;
  }
  return true;
}

/** True if the parabolic ballistic arc described by
 *  (launch position, launch velocity, flight time, universal gravity)
 *  does not cross any shield sphere boundary between launch and
 *  impact. The arc-aware counterpart of `hasShieldClearance`
 *  approximates the same `pos = p₀ + v·t − 0.5·g·ẑ·t²` envelope the
 *  projectile integrator advances each tick.
 *
 *  Implementation: dispatches to the Rust `shield_clearance_arc`
 *  kernel, which chord-samples the parabola so the same "endpoints
 *  don't count" rule applies as for the straight test. Keep this
 *  helper for callers that need projectile-path clearance — the
 *  targeting gate uses the segment + slab walks in Rust directly. */
export function hasArcShieldClearance(
  launchX: number, launchY: number, launchZ: number,
  launchVx: number, launchVy: number, launchVz: number,
  flightTime: number,
  options: ShieldClearanceOptions = { maxCrossings: undefined },
): boolean {
  const sim = getSimWasm();
  if (sim === undefined) return true;
  const maxCrossings = options.maxCrossings ?? 0;
  return (
    sim.shieldSurfacePool.clearanceArc(
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

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
import { getTransformCosSin } from '../../math';
import { getUnitGroundZ } from '../unitGeometry';
import { resolveWeaponWorldMount } from './combatUtils';
import { findClosestPanelHit } from './MirrorPanelHit';

/** Terrain samples still use the half-cell cadence; the walk now runs
 *  inside the AIM-08.LOS Rust combat LOS kernel. */
const LOS_STEP_FRAC = 0.5;
const COMBAT_LOS_ENTITY_QUERY_WIDTH = LAND_CELL_SIZE + 2 * Math.max(
  0,
  ...Object.values(UNIT_BLUEPRINTS).map((bp) => bp.radius.push),
);
const NO_EXCLUDED_ENTITY = -1;
const FORCE_MATERIAL_GRAZE_EPS = 1e-6;
const MIRROR_LOS_QUERY_PAD = 1;
const _mirrorLosPivot = { x: 0, y: 0, z: 0 };

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
 *  `hasForceMaterialLineOfSightClearance` layers mirror-panel
 *  boundaries on top for BLOCK LOS targeting.
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
  return (
    sim.forceFieldPool.clearanceSegment(
      sx, sy, sz,
      tx, ty, tz,
      NO_EXCLUDED_OWNER,
      maxCrossings,
    ) === 1
  );
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
 *  don't count" rule applies as for the straight test.
 *  Targeting uses `hasForceMaterialLineOfSightClearance`; keep this
 *  helper for callers that need projectile-path clearance. */
export function hasArcForceFieldClearance(
  launchX: number, launchY: number, launchZ: number,
  launchVx: number, launchVy: number, launchVz: number,
  flightTime: number,
  options: ForceFieldClearanceOptions = {},
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

function pointSegmentDistanceSq3(
  px: number,
  py: number,
  pz: number,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
): number {
  const abx = bx - ax;
  const aby = by - ay;
  const abz = bz - az;
  const lenSq = abx * abx + aby * aby + abz * abz;
  if (lenSq <= 1e-9) {
    const dx = px - ax;
    const dy = py - ay;
    const dz = pz - az;
    return dx * dx + dy * dy + dz * dz;
  }
  const t = Math.max(
    0,
    Math.min(1, ((px - ax) * abx + (py - ay) * aby + (pz - az) * abz) / lenSq),
  );
  const cx = ax + abx * t;
  const cy = ay + aby * t;
  const cz = az + abz * t;
  const dx = px - cx;
  const dy = py - cy;
  const dz = pz - cz;
  return dx * dx + dy * dy + dz * dz;
}

function hasForceMirrorPanelClearance(
  world: WorldState,
  sx: number, sy: number, sz: number,
  tx: number, ty: number, tz: number,
): boolean {
  if (!world.mirrorsEnabled) return true;
  const mirrorUnits = world.getMirrorUnits();
  if (mirrorUnits.length === 0) return true;

  for (const unit of mirrorUnits) {
    if (!unit.unit || unit.unit.hp <= 0) continue;
    const panels = unit.unit.mirrorPanels;
    if (!panels || panels.length === 0) continue;
    const broadRadius = Math.max(unit.unit.mirrorBoundRadius, unit.unit.radius.shot) + MIRROR_LOS_QUERY_PAD;
    if (
      pointSegmentDistanceSq3(
        unit.transform.x, unit.transform.y, unit.transform.z,
        sx, sy, sz,
        tx, ty, tz,
      ) > broadRadius * broadRadius
    ) {
      continue;
    }

    const unitTurrets = unit.combat?.turrets;
    const mirrorRot = unitTurrets && unitTurrets.length > 0
      ? unitTurrets[0].rotation
      : unit.transform.rotation;
    const mirrorPitch = unitTurrets && unitTurrets.length > 0
      ? unitTurrets[0].pitch
      : 0;
    const unitGroundZ = getUnitGroundZ(unit);
    const unitCS = getTransformCosSin(unit.transform);
    const mirrorPivot = unitTurrets && unitTurrets.length > 0
      ? resolveWeaponWorldMount(
          unit, unitTurrets[0], 0,
          unitCS.cos, unitCS.sin,
          {
            currentTick: world.getTick(),
            unitGroundZ,
            surfaceN: unit.unit.surfaceNormal,
          },
          _mirrorLosPivot,
        )
      : undefined;
    const hit = findClosestPanelHit(
      panels, mirrorRot, mirrorPitch,
      unit.transform.x, unit.transform.y, unitGroundZ,
      sx, sy, sz, tx, ty, tz,
      -1,
      mirrorPivot,
    );
    if (
      hit !== null &&
      hit.t > FORCE_MATERIAL_GRAZE_EPS &&
      hit.t < 1 - FORCE_MATERIAL_GRAZE_EPS
    ) {
      return false;
    }
  }

  return true;
}

/** True when the straight sightline does not cross any force material
 *  boundary: active force-field spheres or active force mirror panels.
 *  This is intentionally a visibility test, not a projectile-flight
 *  prediction. If both endpoints are inside the same sphere, no
 *  boundary is crossed and the sightline remains clear. */
export function hasForceMaterialLineOfSightClearance(
  world: WorldState,
  sx: number, sy: number, sz: number,
  tx: number, ty: number, tz: number,
  options: ForceFieldClearanceOptions = {},
): boolean {
  return (
    hasForceFieldClearance(sx, sy, sz, tx, ty, tz, options) &&
    hasForceMirrorPanelClearance(world, sx, sy, sz, tx, ty, tz)
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

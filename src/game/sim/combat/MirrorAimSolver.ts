// Mirror-turret aim solver. A passive ("mirror") turret doesn't fire
// — its job is to ORIENT a flat reflector so an enemy beam fired at
// the mirror-bearing unit reflects BACK at the firing source's body.
//
// The mirror turret is a RIGID ASSEMBLY: turret base, arm cylinder,
// and panel rotate as one body. Yawing or pitching the turret swings
// the panel through 3D space — the panel CENTER sits at arm's length
// out along the arm direction, and the panel NORMAL is also that
// arm direction. So solving "where to aim the panel" simultaneously
// solves "where the panel ends up in 3D" — they're the same vector.
//
// Inputs (per tick, per mirror turret):
//   - unit            — the mirror-bearing unit
//   - weapon          — the mirror turret on `unit`
//   - target          — the LOCKED-ON enemy unit (already chosen by
//                       targetingSystem because it has a non-passive
//                       beam/laser turret); also the redirect victim.
//   - weaponX/Y/Z     — turret mount world position (the rigid
//                       assembly's pivot point; the arm extends from
//                       here along the bisector direction)
//   - unitGroundZ     — unit's ground footprint Z (kept for caller
//                       symmetry with non-passive solvers; not used
//                       directly any more — the assembly pivot is
//                       weaponZ).
//   - fallbackYaw     — current desired yaw to use if the bisector
//                       can't be solved (degenerate input vectors)
//   - fallbackPitch   — current pitch to seed the iteration from;
//                       lets the solver converge in one pass when
//                       the target moves slowly relative to the
//                       previous solution.
//
// Output: { targetAngle, mirrorPitch, aim{X,Y,Z} } — yaw + pitch the
// turret damper should drive toward, plus a sensible aim point for
// downstream consumers. Returns null when `target` carries no
// beam/laser turret to reflect (caller falls back to normal aim).
//
// Geometry: flat-panel reflection r = d − 2(d · n) n. To bend an
// incoming beam from S onto V the panel normal n must BISECT the
// angle between (P→S) and (P→V):
//
//     n  ∝  (S − P) / |S − P|  +  (V − P) / |V − P|
//
// Yaw α = atan2(n.y, n.x), pitch β = atan2(n.z, hypot(n.x, n.y)).
//
// The panel center P is mounted at arm's length out from the turret
// pivot ALONG THE ARM, which has direction
//
//     a(α, β) = (cos α · cos β,  sin α · cos β,  sin β)
//
// So P(α, β) = pivot + armLength · a(α, β). When yaw or pitch
// updates, the panel center sweeps through 3D. Both axes feed back:
// changing α moves the panel sideways AND tilts the bisector;
// changing β moves the panel up/down AND pitches the bisector. We
// solve the coupled system with three fixed-point iterations. The
// residual collapses well below 0.01° after the third pass for any
// realistic arm length / target distance combo.

import type { Entity, Turret } from '../types';
import { isLineShot } from '../types';
import { getTransformCosSin, getBarrelTip } from '../../math';
import { resolveWeaponWorldMount } from './combatUtils';

/** Pick the most-relevant non-passive line-shot turret on `target` to
 *  bisect the mirror panel against. Priority (lowest rank wins):
 *
 *    1. Engaged AND targeting our unit — that turret is firing at us
 *       right now; the mirror MUST orient against this one.
 *    2. Targeting our unit (any state ≠ idle) — the turret has us in
 *       its sights but isn't yet in fire range; pre-aim so the bounce
 *       lands the moment it engages.
 *    3. Engaged at someone else — at least the barrel is pointing
 *       somewhere we can compute a bisector against. Falls out of
 *       use once targetingSystem narrows acquisition to threats
 *       targeting us, but kept as a defensive last resort for
 *       legacy / racy frames where the threat predicate just flipped.
 *    4. Any line-shot — pure backstop so the panel never hangs at
 *       its previous yaw because of a one-tick state-machine race.
 *
 *  Returns null when the target carries no line-shot turret at all,
 *  matching the previous semantics. */
function pickEnemyLineShotTurret(
  target: Entity,
  ourUnitId: number,
): { turret: Turret; index: number } | null {
  if (!target.turrets) return null;
  let best: { turret: Turret; index: number; rank: number } | null = null;
  for (let ti = 0; ti < target.turrets.length; ti++) {
    const t = target.turrets[ti];
    if (t.config.passive) continue;
    if (!isLineShot(t.config.shot)) continue;
    let rank = 4;
    if (t.target === ourUnitId && t.state === 'engaged') rank = 1;
    else if (t.target === ourUnitId) rank = 2;
    else if (t.state === 'engaged') rank = 3;
    if (best === null || rank < best.rank) {
      best = { turret: t, index: ti, rank };
      if (rank === 1) break; // can't improve on "engaged at us"
    }
  }
  return best === null ? null : { turret: best.turret, index: best.index };
}

export type MirrorAim = {
  targetAngle: number;
  mirrorPitch: number;
  aimX: number;
  aimY: number;
  aimZ: number;
};

const _enemyBeamMount = { x: 0, y: 0, z: 0 };

export function solveMirrorAim(
  unit: Entity,
  _weapon: Turret,
  target: Entity,
  weaponX: number,
  weaponY: number,
  weaponZ: number,
  fallbackYaw: number,
  fallbackPitch: number,
  currentTick?: number,
): MirrorAim | null {
  if (!target.turrets || !unit.unit) return null;

  // Pick the single most-relevant line-shot turret on `target`. The
  // priority chain (engaged-at-us > targeting-us > engaged-elsewhere
  // > any) collapses to "the one firing at us" as soon as the
  // targeting system has narrowed acquisition to threats — see
  // pickEnemyLineShotTurret above for the full rationale. isLineShot
  // (in @/types/sim) remains the SINGLE source of truth for "is a
  // shot mirror-reflectable" — it covers laser, beam, and megaBeam
  // (which is just type='beam' with bigger dps/width).
  const picked = pickEnemyLineShotTurret(target, unit.id);
  if (picked === null) return null;
  const enemyTurret = picked.turret;
  const ti = picked.index;

  // Source S = the enemy beam barrel tip in world. Prefer the
  // targeting system's cached mount because it already includes
  // chassis lift and slope tilt; fall back to upright mount math for
  // first-frame/stale targets.
  const tCS = getTransformCosSin(target.transform);
  const ewp = resolveWeaponWorldMount(
    target, enemyTurret, ti,
    tCS.cos, tCS.sin,
    currentTick === undefined ? undefined : { currentTick },
    _enemyBeamMount,
  );
  const eTip = getBarrelTip(
    ewp.x, ewp.y, ewp.z,
    enemyTurret.rotation, enemyTurret.pitch,
    enemyTurret.config,
    0,
  );

  const panels = unit.unit.mirrorPanels;
  if (panels.length === 0) return null;
  const panel = panels[0];
  const armLength = panel.offsetX;

  // Three fixed-point iterations on the panel center P (now full 3D).
  // P(α, β) = (weaponX, weaponY, weaponZ) + armLength · a(α, β)
  // where a(α, β) = (cos α · cos β,  sin α · cos β,  sin β) is the
  // arm direction vector. Seed (α, β) from the weapon's last solved
  // pose so the residual is sub-degree after one iter for nearly-
  // stationary targets.
  let bisectorYaw = fallbackYaw;
  let bisectorPitch = fallbackPitch;
  let valid = false;
  let cosA = Math.cos(bisectorYaw);
  let sinA = Math.sin(bisectorYaw);
  let cosB = Math.cos(bisectorPitch);
  let sinB = Math.sin(bisectorPitch);
  let pcx = weaponX + cosA * cosB * armLength;
  let pcy = weaponY + sinA * cosB * armLength;
  let pcz = weaponZ + sinB * armLength;
  for (let iter = 0; iter < 3; iter++) {
    const sX = eTip.x - pcx;
    const sY = eTip.y - pcy;
    const sZ = eTip.z - pcz;
    const sLen = Math.hypot(sX, sY, sZ);
    const cX = target.transform.x - pcx;
    const cY = target.transform.y - pcy;
    const cZ = target.transform.z - pcz;
    const cLen = Math.hypot(cX, cY, cZ);
    if (sLen <= 1e-6 || cLen <= 1e-6) break;
    const nx = sX / sLen + cX / cLen;
    const ny = sY / sLen + cY / cLen;
    const nz = sZ / sLen + cZ / cLen;
    const nLen = Math.hypot(nx, ny, nz);
    if (nLen <= 1e-6) break;
    bisectorYaw = Math.atan2(ny, nx);
    bisectorPitch = Math.atan2(nz / nLen, Math.hypot(nx / nLen, ny / nLen));
    valid = true;
    // Re-anchor P at the just-solved bisector direction. Both yaw
    // and pitch feed back into the new panel center.
    cosA = Math.cos(bisectorYaw);
    sinA = Math.sin(bisectorYaw);
    cosB = Math.cos(bisectorPitch);
    sinB = Math.sin(bisectorPitch);
    pcx = weaponX + cosA * cosB * armLength;
    pcy = weaponY + sinA * cosB * armLength;
    pcz = weaponZ + sinB * armLength;
  }

  if (!valid) {
    // Bisector degenerate (S, V, or n collapsed) — damper holds
    // its current pose until next tick.
    return null;
  }
  return {
    targetAngle: bisectorYaw,
    mirrorPitch: bisectorPitch,
    aimX: target.transform.x,
    aimY: target.transform.y,
    aimZ: target.transform.z,
  };
}

// Mirror-turret aim solver. A passive ("mirror") turret doesn't fire
// — its job is to ORIENT a flat reflector so an enemy beam fired at
// the mirror-bearing unit reflects BACK at the firing source's body.
//
// Inputs (per tick, per mirror turret):
//   - unit            — the mirror-bearing unit
//   - weapon          — the mirror turret on `unit`
//   - target          — the LOCKED-ON enemy unit (already chosen by
//                       targetingSystem because it has a non-passive
//                       beam/laser turret); also the redirect victim.
//   - weaponX/Y       — turret mount world position (chassis-local
//                       offset already resolved)
//   - unitGroundZ     — unit's ground footprint Z
//   - fallbackYaw     — current desired yaw to use if the bisector
//                       can't be solved (degenerate input vectors)
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
// The panel center P is mounted at ARM'S LENGTH out in front of the
// turret (panel `offsetX` chassis-local), so P depends on α — moving
// the bisector yaw moves the panel sideways, which moves the bisector
// yaw. We solve with three fixed-point iterations (P_{i+1} = weaponMount
// + offsetX · (cos α_i, sin α_i)). The residual collapses well below
// 0.01° after the third pass for any reasonable arm length / target
// distance combination. Vertical P is independent of pitch (panel
// rotates around its horizontal edge axis) so no β iteration.

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
  unitGroundZ: number,
  fallbackYaw: number,
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
  const panelCenterZ = unitGroundZ + (panel.baseY + panel.topY) / 2;
  const armLength = panel.offsetX;

  // Three fixed-point iterations on the panel center P. Seed P_0
  // with the panel's CURRENT yaw (the weapon's last solved rotation)
  // so we converge fast even when the target is moving sideways.
  let bisectorYaw = fallbackYaw;
  let bisectorPitch = 0;
  let valid = false;
  let pcx = weaponX + Math.cos(fallbackYaw) * armLength;
  let pcy = weaponY + Math.sin(fallbackYaw) * armLength;
  for (let iter = 0; iter < 3; iter++) {
    const sX = eTip.x - pcx;
    const sY = eTip.y - pcy;
    const sZ = eTip.z - panelCenterZ;
    const sLen = Math.hypot(sX, sY, sZ);
    const cX = target.transform.x - pcx;
    const cY = target.transform.y - pcy;
    const cZ = target.transform.z - panelCenterZ;
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
    // Re-anchor P at the new yaw — panel sits arm's length forward
    // along the just-solved bisector direction.
    pcx = weaponX + Math.cos(bisectorYaw) * armLength;
    pcy = weaponY + Math.sin(bisectorYaw) * armLength;
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

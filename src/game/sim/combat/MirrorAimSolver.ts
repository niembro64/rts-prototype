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
import { getTransformCosSin, getBarrelTip } from '../../math';
import { resolveWeaponWorldMount } from './combatUtils';
import { getMirrorPanelCenter } from '../mirrorPanelCache';
import { unapplySurfaceTilt } from '../terrain/terrainSurface';
import { pickMirrorLineTurret } from './mirrorTargetPriority';

export type MirrorAim = {
  targetAngle: number;
  mirrorPitch: number;
  aimX: number;
  aimY: number;
  aimZ: number;
};

const _enemyBeamMount = { x: 0, y: 0, z: 0 };
const _panelCenter = { x: 0, y: 0, z: 0 };

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
  if (!target.combat || !unit.unit) return null;

  // Pick the single most-relevant line-shot turret on `target`. The
  // shared mirror priority ranks:
  // direct threat to this unit > engaged elsewhere > any line weapon,
  // and within each tier megaBeam > beam > laser.
  const picked = pickMirrorLineTurret(target, unit.id);
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

  // Mirror angles are CHASSIS-LOCAL: weapon.rotation/pitch describe
  // the arm direction inside the host's tilted frame, and the panel
  // builder rotates that direction through `applySurfaceTilt` to get
  // the world arm. So the solver works in a hybrid frame:
  //   - Bisector candidate is computed in WORLD frame from
  //     world-frame ray-from-S and ray-toward-V.
  //   - That world bisector is rotated INTO chassis-local frame via
  //     `unapplySurfaceTilt`, then decomposed to (yaw, pitch). Those
  //     are the chassis-local angles the panel cache expects.
  //   - Re-anchoring P uses `getMirrorPanelCenter(..., surfaceNormal,
  //     ...)`, which rotates the chassis-local arm back to world
  //     before adding it to the pivot — closing the loop.
  // On flat ground (surfaceNormal undefined or pointing straight up)
  // both rotations are identity and the math collapses to the legacy
  // upright form.
  const surfaceNormal = unit.unit.surfaceNormal;
  let bisectorYaw = fallbackYaw;
  let bisectorPitch = fallbackPitch;
  let valid = false;
  getMirrorPanelCenter(weaponX, weaponY, weaponZ, armLength, bisectorYaw, bisectorPitch, surfaceNormal, _panelCenter);
  for (let iter = 0; iter < 3; iter++) {
    const sX = eTip.x - _panelCenter.x;
    const sY = eTip.y - _panelCenter.y;
    const sZ = eTip.z - _panelCenter.z;
    const sLen = Math.hypot(sX, sY, sZ);
    const cX = target.transform.x - _panelCenter.x;
    const cY = target.transform.y - _panelCenter.y;
    const cZ = target.transform.z - _panelCenter.z;
    const cLen = Math.hypot(cX, cY, cZ);
    if (sLen <= 1e-6 || cLen <= 1e-6) break;
    const wnx = sX / sLen + cX / cLen;
    const wny = sY / sLen + cY / cLen;
    const wnz = sZ / sLen + cZ / cLen;
    const wnLen = Math.hypot(wnx, wny, wnz);
    if (wnLen <= 1e-6) break;
    // Project the world bisector into the chassis-local frame so the
    // decomposed yaw/pitch are angles the panel cache will rotate
    // back through `applySurfaceTilt(…, surfaceNormal)`.
    const local = unapplySurfaceTilt(wnx, wny, wnz, surfaceNormal);
    const localLen = Math.hypot(local.x, local.y, local.z);
    if (localLen <= 1e-6) break;
    bisectorYaw = Math.atan2(local.y, local.x);
    bisectorPitch = Math.atan2(local.z / localLen, Math.hypot(local.x / localLen, local.y / localLen));
    valid = true;
    // Re-anchor P at the just-solved chassis-local bisector. The
    // panel-center helper rotates back into world via tilt.
    getMirrorPanelCenter(weaponX, weaponY, weaponZ, armLength, bisectorYaw, bisectorPitch, surfaceNormal, _panelCenter);
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

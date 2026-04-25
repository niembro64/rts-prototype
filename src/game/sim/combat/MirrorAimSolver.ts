// Mirror-turret aim solver. A passive ("mirror") turret doesn't fire
// — its job is to ORIENT a flat reflector so an enemy beam fired at
// the mirror-bearing unit reflects toward a chosen victim.
//
// Inputs (per tick, per mirror turret):
//   - unit            — the mirror-bearing unit
//   - weapon          — the mirror turret on `unit`
//   - target          — the LOCKED-ON enemy unit (already chosen by
//                       targetingSystem because it has a non-passive
//                       beam/laser turret)
//   - weaponX/Y       — turret mount world position (chassis-local
//                       offset already resolved)
//   - unitGroundZ     — unit's ground footprint Z (transform.z − push)
//   - fallbackYaw     — current desired yaw to use if the bisector
//                       can't be solved (degenerate input vectors)
//
// Output: { targetAngle, mirrorPitch, aim{X,Y,Z} } — yaw + pitch the
// turret damper should drive toward, plus a sensible aim point for
// downstream consumers. Returns null when `target` carries no
// beam/laser turret to reflect (caller falls back to normal aim).
//
// Geometry: flat-panel reflection r = d − 2(d · n) n. For a beam
// from S to bend through panel point P toward V, the normal n must
// BISECT the angle between (P→S) and (P→V):
//
//     n  ∝  (S − P) / |S − P|  +  (V − P) / |V − P|
//
// Yaw α = atan2(n.y, n.x), pitch β = atan2(n.z, hypot(n.x, n.y)).
// P depends on α (the panel sits at offsetX in front of the turret),
// so we run two fixed-point iterations: P₀=mount, then P₁=mount +
// offset·(cos α₀, sin α₀). That drives the residual under 0.02°,
// well inside any unit body radius. Vertical P is independent of
// pitch (panel rotates around its center) so no β iteration.
//
// Victim selection: nearest enemy unit to the mirror by spatial-grid
// query, filtered by the same-side test (P→S)·(P→V) > 0 so we never
// try to reflect through the panel's back face. The source's own
// host always passes the test (P→S and P→target are co-linear up to
// the source barrel offset), so a valid V exists whenever S exists.

import type { Entity, Turret } from '../types';
import { getTransformCosSin, getBarrelTip, getWeaponWorldPosition } from '../../math';
import { getTurretMountHeight } from './combatUtils';
import { spatialGrid } from '../SpatialGrid';

export type MirrorAim = {
  targetAngle: number;
  mirrorPitch: number;
  aimX: number;
  aimY: number;
  aimZ: number;
};

export function solveMirrorAim(
  unit: Entity,
  weapon: Turret,
  target: Entity,
  weaponX: number,
  weaponY: number,
  unitGroundZ: number,
  fallbackYaw: number,
): MirrorAim | null {
  if (!target.turrets || !unit.unit) return null;

  for (let ti = 0; ti < target.turrets.length; ti++) {
    const enemyTurret = target.turrets[ti];
    if (enemyTurret.config.passive) continue;
    const eShotType = enemyTurret.config.shot.type;
    if (eShotType !== 'beam' && eShotType !== 'laser') continue;

    // Source S = the enemy beam barrel tip in world.
    const tCS = getTransformCosSin(target.transform);
    const ewp = getWeaponWorldPosition(
      target.transform.x, target.transform.y,
      tCS.cos, tCS.sin,
      enemyTurret.offset.x, enemyTurret.offset.y,
    );
    const eGroundZ = target.transform.z - (target.unit?.unitRadiusCollider.push ?? 0);
    const eMountZ = eGroundZ + getTurretMountHeight(target, ti);
    const eTip = getBarrelTip(
      ewp.x, ewp.y, eMountZ,
      enemyTurret.rotation, enemyTurret.pitch,
      enemyTurret.config,
      target.unit?.unitRadiusCollider.scale ?? 15,
      0,
    );

    const panels = unit.unit.mirrorPanels;
    const panelCenterZ = panels.length > 0
      ? unitGroundZ + (panels[0].baseY + panels[0].topY) / 2
      : unitGroundZ;
    const panelOffsetX = panels.length > 0 ? panels[0].offsetX : 0;

    // Victim selection — nearest enemy passing the same-side test.
    // Seeded with the mirror's previous-tick panel pose; the bisector
    // iteration below refines P with the freshly solved yaw.
    const seedPx = weaponX + Math.cos(weapon.rotation) * panelOffsetX;
    const seedPy = weaponY + Math.sin(weapon.rotation) * panelOffsetX;
    const sSeedX = eTip.x - seedPx;
    const sSeedY = eTip.y - seedPy;
    const sSeedZ = eTip.z - panelCenterZ;
    const sSeedLen = Math.hypot(sSeedX, sSeedY, sSeedZ);
    let victim: Entity = target;
    let victimDist = Infinity;
    if (sSeedLen > 1e-6 && unit.ownership) {
      const enemies = spatialGrid.queryEnemyEntitiesInRadius(
        weaponX, weaponY,
        weapon.ranges.tracking.acquire,
        unit.ownership.playerId,
      );
      for (const enemy of enemies) {
        if (!enemy.unit || enemy.unit.hp <= 0) continue;
        const vX = enemy.transform.x - seedPx;
        const vY = enemy.transform.y - seedPy;
        const vZ = enemy.transform.z - panelCenterZ;
        const vLen = Math.hypot(vX, vY, vZ);
        if (vLen <= 1e-6) continue;
        const dot = sSeedX * vX + sSeedY * vY + sSeedZ * vZ;
        if (dot <= 0) continue;
        if (vLen < victimDist) {
          victimDist = vLen;
          victim = enemy;
        }
      }
    }

    // Two-pass fixed-point iteration on P.
    let pcx = weaponX;
    let pcy = weaponY;
    let bisectorYaw = fallbackYaw;
    let bisectorPitch: number | null = null;
    let valid = false;
    for (let iter = 0; iter < 2; iter++) {
      const sX = eTip.x - pcx;
      const sY = eTip.y - pcy;
      const sZ = eTip.z - panelCenterZ;
      const sLen = Math.hypot(sX, sY, sZ);
      const cX = victim.transform.x - pcx;
      const cY = victim.transform.y - pcy;
      const cZ = victim.transform.z - panelCenterZ;
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
      pcx = weaponX + Math.cos(bisectorYaw) * panelOffsetX;
      pcy = weaponY + Math.sin(bisectorYaw) * panelOffsetX;
    }

    if (valid && bisectorPitch !== null) {
      return {
        targetAngle: bisectorYaw,
        mirrorPitch: bisectorPitch,
        aimX: victim.transform.x,
        aimY: victim.transform.y,
        aimZ: victim.transform.z,
      };
    }
    // Found a beam turret but bisector was degenerate — give up
    // rather than scanning further turrets on the same target; the
    // damper will just hold its current pose.
    return null;
  }

  // Target has no beam/laser turret at all.
  return null;
}

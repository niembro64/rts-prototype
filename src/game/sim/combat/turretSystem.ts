// Turret rotation system — damped-spring integrator on both yaw and
// pitch. The solver picks a target pose each tick (target bearing for
// yaw, ballistic-arc angle for pitch); the damper converges the
// weapon's current pose on that target along an overshoot-free curve,
// so tick-to-tick jitter in the solver (e.g. a ballistic solution
// that wobbles slightly as the target moves) doesn't propagate into
// visible barrel oscillation.
//
// Per-axis dynamics (rotation axis shown as θ):
//
//   accel = (targetθ − θ) · k  −  θ̇ · c
//   θ̇   += accel · dt
//   θ   += θ̇ · dt
//
// where k = turretTurnAccel (reused as stiffness so existing per-
// turret tuning carries over — stiffer turret = snappier track) and
// c = 2·√k gives critical damping. `turretDrag` from the old bang-
// bang integrator no longer scales velocity directly; instead it's
// applied as an EXTRA damping coefficient on top of critical. A drag
// of 0 produces exactly critical damping; positive values overdamp
// (slower, no-overshoot response).

import type { WorldState } from '../WorldState';
import type { Entity } from '../types';
import { getMovementAngle, resolveWeaponWorldPos, getTurretMountHeight } from './combatUtils';
import { getTransformCosSin, solveBallisticPitch, computeInterceptTime, getBarrelTip, normalizeAngle, getWeaponWorldPosition } from '../../math';
import { spatialGrid } from '../SpatialGrid';
import {
  TURRET_RETURN_TO_FORWARD,
  GRAVITY,
} from '../../../config';

/** Pitch is clamped to straight-down → straight-up. Matches the
 *  renderer's pitch range and keeps the ballistic solver from driving
 *  the barrel through the body. */
const PITCH_MIN = -Math.PI / 2;
const PITCH_MAX = Math.PI / 2;

export function updateTurretRotation(world: WorldState, dtMs: number): void {
  const dtSec = dtMs / 1000;

  for (const unit of world.getUnits()) {
    if (!unit.unit || !unit.ownership || !unit.turrets) continue;
    if (unit.unit.hp <= 0) continue;

    const { cos, sin } = getTransformCosSin(unit.transform);

    for (let weaponIndex = 0; weaponIndex < unit.turrets.length; weaponIndex++) {
      const weapon = unit.turrets[weaponIndex];
      // Vertical launchers skip the normal yaw/pitch aim math — the
      // turret always points straight up and each fired rocket picks
      // a random cone-from-vertical direction at launch (projectile-
      // System handles that). Targeting state still runs in
      // targetingSystem so the weapon acquires a homing target, but
      // here we just pin the pose so the rendered barrels stay
      // skyward and the gatling spin (driven by engagement state)
      // keeps working.
      if (weapon.config.verticalLauncher) {
        weapon.rotation = 0;
        weapon.angularVelocity = 0;
        weapon.pitch = Math.PI / 2;
        weapon.pitchVelocity = 0;
        continue;
      }

      // --- 1) Derive per-axis target pose for this tick. ---
      let targetAngle: number | null = null;
      let targetPitch = 0;
      let hasActiveTarget = false;

      if (weapon.target !== null) {
        const target = world.getEntity(weapon.target);
        if (target) {
          const wp = resolveWeaponWorldPos(weapon, unit.transform.x, unit.transform.y, cos, sin);
          const weaponX = wp.x, weaponY = wp.y;

          // Initial unleaded aim — used to bootstrap the barrel tip
          // reference. The lead step below replaces this with a
          // velocity-predicted intercept point.
          targetAngle = Math.atan2(target.transform.y - weaponY, target.transform.x - weaponX);

          // Ballistic arcs are solved from the actual barrel tip (not
          // the turret mount) — otherwise shots would fire from a
          // point one barrel-length farther back than the pitch was
          // solved for, and every projectile would overshoot. The
          // primitive returns a tip in world coords that already
          // accounts for the barrel's orbit offset, pitch contribution,
          // and yaw direction. Use barrelIndex = 0 (reference barrel)
          // and the CURRENT weapon.pitch — as the damper converges
          // the solver input settles along with it.
          const unitGroundZ = unit.transform.z - unit.unit.unitRadiusCollider.push;
          const mountZ = unitGroundZ + getTurretMountHeight(unit, weaponIndex);
          const tipRef = getBarrelTip(
            weaponX, weaponY, mountZ,
            targetAngle, weapon.pitch,
            weapon.config,
            unit.unit.unitRadiusCollider.scale,
            0,
          );

          // Lead prediction: aim at where the target will be when the
          // projectile arrives, not where it is now. Skip for:
          //   - Beams/lasers: instant, no flight time.
          //   - Homing shots (homingTurnRate > 0): the projectile
          //     steers mid-flight, so initial aim doesn't need lead.
          //   - Stationary or non-unit targets: no velocity to lead.
          // For ballistic arcs we run a single refinement pass using
          // the horizontal projectile speed (launchSpeed · cos(pitch))
          // — gravity slows horizontal travel for high-arc shots, so
          // the straight-line estimate undershoots flight time.
          const shot = weapon.config.shot;
          const tvx = target.unit?.velocityX ?? 0;
          const tvy = target.unit?.velocityY ?? 0;
          const tvz = target.unit?.velocityZ ?? 0;
          const tvMoves = (tvx * tvx + tvy * tvy + tvz * tvz) > 1e-6;

          let aimX = target.transform.x;
          let aimY = target.transform.y;
          let aimZ = target.transform.z;

          // ── Passive (mirror) turret aim ──
          //
          // Goal: an enemy beam fired from B (their barrel tip) along
          // their aim line should reflect off our panel and land on U
          // (their unit center).
          //
          // Flat-panel reflection: r = d − 2(d · n) n. For an incoming
          // ray to bend from (P → B) to (P → U) at the panel point P,
          // the panel normal must BISECT the angle between those two
          // rays:
          //
          //     n  ∝  (B − P) / |B − P|  +  (U − P) / |U − P|
          //
          // Yaw α = atan2(n.y, n.x), pitch β = atan2(n.z, hypot(n.x,
          // n.y)) puts the mirror's 3D normal exactly along the
          // bisector.
          //
          // Self-reference: P depends on α — the panel center sits at
          // P(α) = M + offsetX · (cos α, sin α) in chassis-local
          // coords, so the bisector formula at P(α₀) gives a slightly
          // different α₁. With Loris's 18-wu offset and ~1000-wu
          // engagements, the single-shot solution is off by ~1° per
          // axis, which lands the bounced beam ~17 wu off the body.
          // Two iterations of fixed-point refinement (P₀=M, then
          // P₁=M+offset·(cos α₀, sin α₀)) drive the residual below
          // 0.02° — well inside the unit body radius. Vertical P is
          // independent of pitch (panel rotates around its center) so
          // no iteration on β is needed.
          let mirrorPitchOverride: number | null = null;
          if (weapon.config.passive && target.turrets) {
            for (let ti = 0; ti < target.turrets.length; ti++) {
              const enemyTurret = target.turrets[ti];
              if (enemyTurret.config.passive) continue;
              const eShotType = enemyTurret.config.shot.type;
              if (eShotType !== 'beam' && eShotType !== 'laser') continue;
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

              // Pick the VICTIM V — the enemy unit the bounced beam
              // should land on. Nearest enemy to the panel wins, with
              // a same-side test (V must be in the same half-space as
              // S relative to the panel point — otherwise the panel's
              // front face can't physically see both). The source's
              // own host (`target`) ALWAYS passes the same-side test
              // (P→S and P→target are the same ray modulo the barrel
              // offset) so it is a valid fallback whenever no other
              // enemy qualifies, satisfying the "there's always a V"
              // invariant the user spelled out.
              //
              // Seed P with the previous-tick panel pose — close enough
              // to the post-iteration P for the same-side test to be
              // stable. The bisector iteration below refines P with
              // the actual solved yaw.
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
                  // Same-side: cosθ between (P→S) and (P→V) > 0.
                  const dot = sSeedX * vX + sSeedY * vY + sSeedZ * vZ;
                  if (dot <= 0) continue;
                  if (vLen < victimDist) {
                    victimDist = vLen;
                    victim = enemy;
                  }
                }
              }

              // Iterate twice. Pass 1 uses P = chassis center to seed
              // an α₀; pass 2 uses P = chassis + offset·(cos α₀, sin α₀)
              // to land within ~0.02° of the true bisector.
              let pcx = weaponX;
              let pcy = weaponY;
              let bisectorYaw = targetAngle ?? 0;
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
                // Refine P for the next iteration using the just-
                // computed yaw. Panel center moves with α only
                // horizontally; vertical stays at panelCenterZ.
                pcx = weaponX + Math.cos(bisectorYaw) * panelOffsetX;
                pcy = weaponY + Math.sin(bisectorYaw) * panelOffsetX;
              }

              if (valid && bisectorPitch !== null) {
                targetAngle = bisectorYaw;
                mirrorPitchOverride = bisectorPitch;
                // Aim point only used by downstream fallback code
                // (passive's pitch is overridden below). Point it at
                // the VICTIM center so any non-pitch consumer still
                // gets a sensible value.
                aimX = victim.transform.x;
                aimY = victim.transform.y;
                aimZ = victim.transform.z;
              }
              break;
            }
          }

          if (shot.type === 'projectile') {
            const launchSpeed = shot.launchForce / shot.mass;
            const isHoming = (shot.homingTurnRate ?? 0) > 0;

            if (!isHoming && tvMoves) {
              const dxT = target.transform.x - tipRef.x;
              const dyT = target.transform.y - tipRef.y;
              const dzT = target.transform.z - tipRef.z;

              // First pass — closed-form intercept assuming straight-
              // line projectile speed.
              let tIntercept = computeInterceptTime(dxT, dyT, dzT, tvx, tvy, tvz, launchSpeed);

              // Second pass — refine using the ballistic horizontal
              // speed (gravity drag on the arc). Only meaningful for
              // gravity-affected shots; ignoresGravity shots stay flat.
              if (tIntercept > 0 && !shot.ignoresGravity) {
                const px = target.transform.x + tvx * tIntercept;
                const py = target.transform.y + tvy * tIntercept;
                const pz = target.transform.z + tvz * tIntercept;
                const horizD = Math.hypot(px - tipRef.x, py - tipRef.y);
                const heightD = pz - tipRef.z;
                const pitch0 = solveBallisticPitch(
                  horizD, heightD, launchSpeed, GRAVITY, weapon.config.highArc ?? false,
                );
                const horizSpeed = launchSpeed * Math.max(Math.cos(pitch0), 0.1);
                const tRefined = computeInterceptTime(dxT, dyT, dzT, tvx, tvy, tvz, horizSpeed);
                if (tRefined > 0) tIntercept = tRefined;
              }

              aimX = target.transform.x + tvx * tIntercept;
              aimY = target.transform.y + tvy * tIntercept;
              aimZ = target.transform.z + tvz * tIntercept;
              targetAngle = Math.atan2(aimY - weaponY, aimX - weaponX);
            }

            // groundAimFraction: aim short of the lead-corrected
            // target so the round lands on the ground at this
            // fraction of the weapon→aim distance, then let the
            // submunition bounce/spread carry the rest. Mortar uses
            // this so its lightShots arc into the impact ring around
            // the target instead of the carrier dropping directly on
            // top. Applied after lead so the "aim point" we shorten
            // is the predicted intercept, not the stale current pos.
            const groundAimFraction = weapon.config.groundAimFraction;
            if (groundAimFraction !== undefined && groundAimFraction > 0) {
              const f = groundAimFraction;
              aimX = weaponX + f * (aimX - weaponX);
              aimY = weaponY + f * (aimY - weaponY);
              aimZ = 0;
              targetAngle = Math.atan2(aimY - weaponY, aimX - weaponX);
            }

            const horizDist = Math.hypot(aimX - tipRef.x, aimY - tipRef.y);
            const heightDiff = aimZ - tipRef.z;
            targetPitch = solveBallisticPitch(
              horizDist, heightDiff, launchSpeed, GRAVITY, weapon.config.highArc ?? false,
            );
          } else {
            // Beam / laser / force — direct aim, no ballistic drop.
            const horizDist = Math.hypot(aimX - tipRef.x, aimY - tipRef.y);
            const heightDiff = aimZ - tipRef.z;
            targetPitch = Math.atan2(heightDiff, horizDist);
          }
          // Mirror turrets pivot at the panel center, not the turret
          // mount — override with the panel-aware pitch computed above
          // so the panel normal points at the beam source in 3D.
          if (mirrorPitchOverride !== null) {
            targetPitch = mirrorPitchOverride;
          }
          hasActiveTarget = true;
        }
      }

      if (!hasActiveTarget) {
        // No target: pitch settles to 0 (barrel horizontal); yaw
        // either glides toward forward (match movement direction)
        // or coasts via the damper with target = current angle (no
        // pull), letting the existing damping bleed velocity off.
        targetPitch = 0;
        if (TURRET_RETURN_TO_FORWARD) {
          targetAngle = getMovementAngle(unit);
        } else {
          targetAngle = weapon.rotation;
        }
      }

      // --- 2) Damped-spring integrate both axes toward targets. ---
      // k = stiffness; c = 2·√k for critical damping. `weapon.drag`
      // is an optional EXTRA damping coefficient (0 = exactly
      // critical). Tuning `turretTurnAccel` higher gives a snappier
      // response; tuning `turretDrag` higher keeps it smooth-but-
      // slower.
      const k = Math.max(weapon.turnAccel, 1);
      const cCritical = 2 * Math.sqrt(k);
      const c = cCritical * (1 + weapon.drag);

      // Yaw — use normalized angle difference so we always turn the
      // short way around and don't blow up near ±π.
      const yawDiff = normalizeAngle(targetAngle! - weapon.rotation);
      const yawAccel = yawDiff * k - weapon.angularVelocity * c;
      weapon.angularVelocity += yawAccel * dtSec;
      weapon.rotation = normalizeAngle(weapon.rotation + weapon.angularVelocity * dtSec);

      // Pitch — straight difference; clamp the integrated pitch so
      // the barrel doesn't rotate past vertical.
      const pitchDiff = targetPitch - weapon.pitch;
      const pitchAccel = pitchDiff * k - weapon.pitchVelocity * c;
      weapon.pitchVelocity += pitchAccel * dtSec;
      let newPitch = weapon.pitch + weapon.pitchVelocity * dtSec;
      if (newPitch < PITCH_MIN) { newPitch = PITCH_MIN; weapon.pitchVelocity = 0; }
      else if (newPitch > PITCH_MAX) { newPitch = PITCH_MAX; weapon.pitchVelocity = 0; }
      weapon.pitch = newPitch;
    }
  }
}

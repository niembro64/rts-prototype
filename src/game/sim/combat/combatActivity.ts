import type { Turret } from '../types';

/** AIM-08.7 — Reset the JS-only Turret fields that the combat-targeting
 *  slab does not own (angular/pitch velocity + acceleration,
 *  burst.remaining, shield.transition/range). The slab-side reset
 *  for a disabled turret is handled by the Rust scheduler's
 *  reset_disabled_weapons pass; this is its JS counterpart.
 *
 *  Called from the transition moments where a turret newly becomes
 *  disabled (mirror-disable, shield-disable). Newly constructed
 *  turrets start with zero values, so there is no startup transition
 *  to handle. */
export function resetDisabledTurretJsOnlyFields(turret: Turret): void {
  turret.angularVelocity = 0;
  turret.angularAcceleration = 0;
  turret.pitchVelocity = 0;
  turret.pitchAcceleration = 0;
  if (turret.burst) {
    turret.burst.remaining = 0;
  }
  if (turret.shield) {
    turret.shield.transition = 0;
    turret.shield.range = 0;
  }
}

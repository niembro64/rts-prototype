import type { Turret } from '../sim/types';

/**
 * Head-only turrets normally have no orientable mesh pose to correct on the
 * client, so their yaw/pitch/angular fields are pinned to 0 on the wire. Line
 * weapons are the exception: their yaw/pitch is the live beam/laser
 * presentation state even when the turret art is only a head sphere.
 *
 * Non-head-only turrets (including turretForceFieldPanel, whose authored
 * barrel rotates to bisect its targets) always ship their aim normally.
 */
export function turretAimMotionIsSnapshotVisible(turret: Turret): boolean {
  if (turret.config.headOnly !== true) return true;
  const shotConfig = turret.config.shot;
  const shotType = shotConfig !== undefined ? shotConfig.type : undefined;
  return shotType === 'beam' || shotType === 'laser';
}

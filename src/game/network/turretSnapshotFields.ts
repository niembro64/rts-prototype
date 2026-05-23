import type { Entity, Turret } from '../sim/types';

/**
 * Head-only turrets normally have no visible yaw/pitch pose to correct on the
 * client. Mirror-panel hosts are the exception: their panel slab is posed from
 * the passive turret's yaw/pitch even though the turret head/barrel is hidden.
 */
export function turretAimMotionIsSnapshotVisible(entity: Entity, turret: Turret): boolean {
  if (turret.config.headOnly !== true) return true;
  return turret.config.passive === true && (entity.unit?.mirrorPanels.length ?? 0) > 0;
}

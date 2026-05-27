import type { Entity, Turret } from '../sim/types';

/**
 * Head-only turrets normally have no orientable mesh pose to correct on the
 * client. Line weapons are an exception: their yaw/pitch is the live
 * beam/laser presentation state, even when the turret art is only a head
 * sphere. Mirror-panel hosts are another exception: their panel slab is posed
 * from the passive turret's yaw/pitch even though the turret head/barrel is
 * hidden.
 */
export function turretAimMotionIsSnapshotVisible(entity: Entity, turret: Turret): boolean {
  if (turret.config.headOnly !== true) return true;
  const shotConfig = turret.config.shot;
  const shotType = shotConfig !== undefined ? shotConfig.type : undefined;
  if (shotType === 'beam' || shotType === 'laser') return true;
  const forceFieldPanelCount = entity.unit !== null ? entity.unit.forceFieldPanels.length : 0;
  return turret.config.passive === true && forceFieldPanelCount > 0;
}

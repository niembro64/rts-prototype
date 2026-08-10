import type { Turret } from '../sim/types';
import { NO_ENTITY_ID } from '../sim/types';

/**
 * Logical turrets explicitly declare whether clients need their aim motion.
 * This must not be inferred from host-owned geometry: two hosts may present
 * the same logical turret differently while sharing one wire contract.
 */
export function turretAimMotionIsSnapshotVisible(turret: Turret): boolean {
  return turret.config.aimMotionSnapshotVisible;
}

export function turretShouldEncodeInactive(turret: Turret, targetId: number): boolean {
  return turret.id === NO_ENTITY_ID &&
    targetId === -1 &&
    turret.state === 'idle' &&
    turret.shield === null;
}

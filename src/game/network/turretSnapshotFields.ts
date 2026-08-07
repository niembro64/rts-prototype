import type { Turret } from '../sim/types';
import { NO_ENTITY_ID } from '../sim/types';

/**
 * Head-only utility turrets have no orientable mesh pose to correct on the
 * client, so their yaw/pitch/angular fields are pinned to 0 on the wire.
 *
 * Full-barrel turrets (including ray emitters and turretShieldPanel, whose
 * authored barrel rotates to bisect its targets) always ship aim normally.
 */
export function turretAimMotionIsSnapshotVisible(turret: Turret): boolean {
  return turret.config.headOnly !== true;
}

export function turretShouldEncodeInactive(turret: Turret, targetId: number): boolean {
  return turret.id === NO_ENTITY_ID &&
    targetId === -1 &&
    turret.state === 'idle' &&
    turret.shield === null;
}

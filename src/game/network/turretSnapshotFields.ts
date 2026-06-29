import type { Turret } from '../sim/types';
import { NO_ENTITY_ID } from '../sim/types';

/**
 * Head-only turrets normally have no orientable mesh pose to correct on the
 * client, so their yaw/pitch/angular fields are pinned to 0 on the wire.
 * Beam/laser paths travel separately as projectile beam updates; they do not
 * need turret aim motion on the entity row.
 *
 * Non-head-only turrets (including turretShieldPanel, whose authored
 * barrel rotates to bisect its targets) always ship their aim normally.
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

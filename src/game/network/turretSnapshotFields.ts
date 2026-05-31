import type { Turret } from '../sim/types';

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

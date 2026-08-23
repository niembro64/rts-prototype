import type { Entity, EntityId } from '../sim/types';
import { isRayType } from '../sim/types';

type TurretKey = number | string;
const TURRET_KEY_STRIDE = 1024;

function turretKey(entityId: EntityId, turretIndex: number): TurretKey {
  if (
    turretIndex >= 0 &&
    turretIndex < TURRET_KEY_STRIDE &&
    Number.isSafeInteger(entityId)
  ) {
    return entityId * TURRET_KEY_STRIDE + turretIndex;
  }
  return `${entityId}:${turretIndex}`;
}

/** Presentation state for the idle cone on beam turrets. Firing keys are a
 *  pure function of line-projectile topology, so the set is rebuilt only
 *  when the caller's line render version moves (P1-29) instead of on every
 *  display frame. */
export class BeamPilotLightState3D {
  private readonly firingTurrets = new Set<TurretKey>();
  private lastLineVersion = -1;

  update(lineProjectiles: readonly Entity[], lineRenderVersion: number): void {
    if (lineRenderVersion === this.lastLineVersion) return;
    this.lastLineVersion = lineRenderVersion;
    this.firingTurrets.clear();
    for (let i = 0; i < lineProjectiles.length; i++) {
      const projectile = lineProjectiles[i].projectile;
      if (projectile === null || !isRayType(projectile.projectileType)) continue;
      this.firingTurrets.add(turretKey(
        projectile.sourceEntityId,
        projectile.config.turretIndex ?? 0,
      ));
    }
  }

  isVisible(entityId: EntityId, turretIndex: number): boolean {
    return !this.firingTurrets.has(turretKey(entityId, turretIndex));
  }

  clear(): void {
    this.firingTurrets.clear();
    this.lastLineVersion = -1;
  }
}

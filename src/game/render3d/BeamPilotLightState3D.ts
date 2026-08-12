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

/** Per-frame presentation state for the idle cone on beam turrets. */
export class BeamPilotLightState3D {
  private readonly firingTurrets = new Set<TurretKey>();

  update(lineProjectiles: readonly Entity[]): void {
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
  }
}

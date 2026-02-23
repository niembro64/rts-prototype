// Utility to initialize turret rotations toward a target point

import type { Entity } from './types';

/** Set all turret rotations on an entity to face toward (targetX, targetY) */
export function aimTurretsToward(entity: Entity, targetX: number, targetY: number): void {
  if (!entity.turrets) return;
  const angle = Math.atan2(targetY - entity.transform.y, targetX - entity.transform.x);
  for (const turret of entity.turrets) {
    turret.rotation = angle;
  }
}

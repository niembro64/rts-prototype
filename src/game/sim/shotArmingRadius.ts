export const SHOT_ARMING_RADIUS_COLLISION_MULTIPLIER = 1.5;

export function deriveShotArmingRadius(collisionRadius: number): number {
  return Number.isFinite(collisionRadius)
    ? Math.max(0, collisionRadius) * SHOT_ARMING_RADIUS_COLLISION_MULTIPLIER
    : 0;
}

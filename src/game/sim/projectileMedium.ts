import type { ProjectileShot } from './types';

type ProjectilePhysicsMedium = ProjectileShot['physicsMedium'];

/**
 * Medium policy for projectile engines and guidance. Gravity is deliberately
 * excluded: it remains a universal force, so a water-only projectile that
 * breaches the surface loses counter-gravity and falls back into the water.
 */
export function projectilePhysicsAppliesAtHeight(
  medium: ProjectilePhysicsMedium,
  z: number,
  waterLevel: number,
): boolean {
  if (medium === 'air-and-water') return true;
  const isInWater = z <= waterLevel;
  return medium === 'water-only' ? isInWater : !isInWater;
}

export function projectileCanOperateInWater(
  medium: ProjectilePhysicsMedium,
): boolean {
  return medium === 'water-only' || medium === 'air-and-water';
}

/** Returns the swept-segment fraction at which an air-only shot meets water. */
export function getAirProjectileWaterEntryFraction(
  previousZ: number,
  currentZ: number,
  waterLevel: number,
): number | null {
  if (previousZ <= waterLevel) return 0;
  if (currentZ > waterLevel) return null;
  const dz = currentZ - previousZ;
  if (!Number.isFinite(dz) || Math.abs(dz) <= 1e-12) return 0;
  return Math.max(0, Math.min(1, (waterLevel - previousZ) / dz));
}

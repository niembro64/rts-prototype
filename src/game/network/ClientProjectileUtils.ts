import { isRayType } from '@/types/sim';
import { codeToShotBlueprintId } from '../../types/network';
import type { Entity } from '../sim/types';
import type { NetworkServerSnapshotProjectileSpawn } from './NetworkManager';

export function isLineProjectileEntity(entity: Entity): boolean {
  return entity.projectile !== null && isRayType(entity.projectile.projectileType);
}

export function decodeProjectileShotBlueprintId(
  spawn: NetworkServerSnapshotProjectileSpawn,
): string | undefined {
  return spawn.shotBlueprintCode !== null
    ? codeToShotBlueprintId(spawn.shotBlueprintCode) ?? undefined
    : undefined;
}

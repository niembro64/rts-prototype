import { isLineShotType } from '@/types/sim';
import type { ShotId } from '../../types/blueprintIds';
import { codeToShotId } from '../../types/network';
import type { Entity } from '../sim/types';
import type { NetworkServerSnapshotProjectileSpawn } from './NetworkManager';

export function isLineProjectileEntity(entity: Entity): boolean {
  return entity.projectile !== undefined && isLineShotType(entity.projectile.projectileType);
}

export function decodeProjectileShotId(
  spawn: NetworkServerSnapshotProjectileSpawn,
): ShotId | undefined {
  return spawn.shotId !== undefined
    ? codeToShotId(spawn.shotId) ?? undefined
    : undefined;
}

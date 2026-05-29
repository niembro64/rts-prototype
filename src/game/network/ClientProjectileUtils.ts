import { isLineShotType } from '@/types/sim';
import type { ShotBlueprintId } from '../../types/blueprintIds';
import { codeToShotBlueprintId } from '../../types/network';
import type { Entity } from '../sim/types';
import type { NetworkServerSnapshotProjectileSpawn } from './NetworkManager';

export function isLineProjectileEntity(entity: Entity): boolean {
  return entity.projectile !== null && isLineShotType(entity.projectile.projectileType);
}

export function decodeProjectileShotBlueprintId(
  spawn: NetworkServerSnapshotProjectileSpawn,
): ShotBlueprintId | undefined {
  return spawn.shotBlueprintCode !== null
    ? codeToShotBlueprintId(spawn.shotBlueprintCode) ?? undefined
    : undefined;
}

import type { EntityId } from '../sim/types';
import type { TurretBlueprintId } from '../../types/blueprintIds';
import type { NetworkServerSnapshotProjectileSpawn } from './NetworkManager';
import {
  codeToTurretBlueprintId,
  PROJECTILE_TYPE_PROJECTILE,
} from '../../types/network';
import { TURRET_CONFIGS } from '../sim/turretConfigs';
import { copySpawnInto, createSpawnDto } from './snapshotDtoCopy';

type QueuedProjectileSpawn = {
  spawn: NetworkServerSnapshotProjectileSpawn;
  playAt: number;
};

export function decodeProjectileSourceTurretBlueprintId(
  spawn: NetworkServerSnapshotProjectileSpawn,
): TurretBlueprintId | undefined {
  const sourceTurretBlueprintId = spawn.sourceTurretBlueprintCode !== null
    ? codeToTurretBlueprintId(spawn.sourceTurretBlueprintCode) ?? undefined
    : undefined;
  if (sourceTurretBlueprintId) return sourceTurretBlueprintId;
  return codeToTurretBlueprintId(spawn.turretBlueprintCode) ?? undefined;
}

export function projectileSpawnFieldsShouldSmooth(
  projectileType: number,
  turretBlueprintCode: number,
  sourceTurretBlueprintCode: number | null,
  fromParentDetonation: boolean,
): boolean {
  const sourceTurretBlueprintId = sourceTurretBlueprintCode !== null
    ? codeToTurretBlueprintId(sourceTurretBlueprintCode) ?? undefined
    : undefined;
  const fallbackTurretBlueprintId = sourceTurretBlueprintId ??
    codeToTurretBlueprintId(turretBlueprintCode) ??
    undefined;
  const sourceTurretConfig = fallbackTurretBlueprintId !== undefined
    ? TURRET_CONFIGS[fallbackTurretBlueprintId]
    : undefined;
  return projectileType === PROJECTILE_TYPE_PROJECTILE &&
    !fromParentDetonation &&
    sourceTurretConfig !== undefined &&
    sourceTurretConfig.eventsSmooth;
}

export class ProjectileSpawnQueue {
  private queue: QueuedProjectileSpawn[] = [];
  private pool: QueuedProjectileSpawn[] = [];
  private snapshotTime = 0;
  private snapshotInterval = 100;

  recordSnapshot(now: number): void {
    if (this.snapshotTime > 0) {
      const dt = now - this.snapshotTime;
      if (dt > 0) {
        this.snapshotInterval = 0.8 * this.snapshotInterval + 0.2 * dt;
      }
    }
    this.snapshotTime = now;
  }

  remove(id: EntityId): void {
    const q = this.queue;
    for (let i = q.length - 1; i >= 0; i--) {
      if (q[i].spawn.id !== id) continue;
      const queued = q[i];
      q[i] = q[q.length - 1];
      q.length--;
      this.release(queued);
      return;
    }
  }

  shouldSmooth(spawn: NetworkServerSnapshotProjectileSpawn): boolean {
    return projectileSpawnFieldsShouldSmooth(
      spawn.projectileType,
      spawn.turretBlueprintCode,
      spawn.sourceTurretBlueprintCode,
      spawn.fromParentDetonation === true,
    );
  }

  enqueue(spawn: NetworkServerSnapshotProjectileSpawn, now: number): void {
    this.remove(spawn.id);
    const queued = this.acquire();
    copySpawnInto(spawn, queued.spawn);
    queued.playAt = now + Math.random() * this.snapshotInterval;
    this.queue.push(queued);
  }

  drain(
    now: number,
    apply: (spawn: NetworkServerSnapshotProjectileSpawn) => boolean,
  ): boolean {
    const q = this.queue;
    let changed = false;
    for (let i = q.length - 1; i >= 0; i--) {
      const queued = q[i];
      if (now < queued.playAt) continue;
      if (apply(queued.spawn)) changed = true;
      q[i] = q[q.length - 1];
      q.length--;
      this.release(queued);
    }
    return changed;
  }

  clear(): void {
    for (let i = 0; i < this.queue.length; i++) {
      this.release(this.queue[i]);
    }
    this.queue.length = 0;
    this.snapshotTime = 0;
    this.snapshotInterval = 100;
  }

  private acquire(): QueuedProjectileSpawn {
    const queued = this.pool.pop();
    if (queued) {
      queued.playAt = 0;
      return queued;
    }
    return {
      spawn: createSpawnDto(),
      playAt: 0,
    };
  }

  private release(queued: QueuedProjectileSpawn): void {
    queued.spawn.beam = null;
    queued.spawn.maxLifespan = null;
    queued.spawn.isDGun = null;
    queued.spawn.fromParentDetonation = null;
    queued.spawn.targetEntityId = null;
    queued.spawn.homingTurnRate = null;
    queued.playAt = 0;
    this.pool.push(queued);
  }
}

import type { EntityId } from '../sim/types';
import type { TurretId } from '../../types/blueprintIds';
import type { NetworkServerSnapshotProjectileSpawn } from './NetworkManager';
import {
  codeToTurretId,
  PROJECTILE_TYPE_PROJECTILE,
  TURRET_ID_UNKNOWN,
} from '../../types/network';
import { TURRET_CONFIGS } from '../sim/turretConfigs';

type QueuedProjectileSpawn = {
  spawn: NetworkServerSnapshotProjectileSpawn;
  playAt: number;
};

function createOwnedProjectileSpawn(): NetworkServerSnapshotProjectileSpawn {
  return {
    id: 0,
    pos: { x: 0, y: 0, z: 0 },
    rotation: 0,
    velocity: { x: 0, y: 0, z: 0 },
    projectileType: PROJECTILE_TYPE_PROJECTILE,
    turretId: TURRET_ID_UNKNOWN,
    shotId: undefined,
    sourceTurretId: undefined,
    playerId: 0,
    sourceEntityId: 0,
    turretIndex: 0,
    barrelIndex: 0,
  };
}

function copyProjectileSpawnInto(
  src: NetworkServerSnapshotProjectileSpawn,
  dst: NetworkServerSnapshotProjectileSpawn,
): NetworkServerSnapshotProjectileSpawn {
  dst.id = src.id;
  dst.pos.x = src.pos.x;
  dst.pos.y = src.pos.y;
  dst.pos.z = src.pos.z;
  dst.rotation = src.rotation;
  dst.velocity.x = src.velocity.x;
  dst.velocity.y = src.velocity.y;
  dst.velocity.z = src.velocity.z;
  dst.projectileType = src.projectileType;
  dst.maxLifespan = src.maxLifespan;
  dst.turretId = src.turretId;
  dst.shotId = src.shotId;
  dst.sourceTurretId = src.sourceTurretId;
  dst.playerId = src.playerId;
  dst.sourceEntityId = src.sourceEntityId;
  dst.turretIndex = src.turretIndex;
  dst.barrelIndex = src.barrelIndex;
  dst.isDGun = src.isDGun;
  dst.fromParentDetonation = src.fromParentDetonation;
  dst.targetEntityId = src.targetEntityId;
  dst.homingTurnRate = src.homingTurnRate;
  if (src.beam) {
    const beam = dst.beam ?? {
      start: { x: 0, y: 0, z: 0 },
      end: { x: 0, y: 0, z: 0 },
    };
    beam.start.x = src.beam.start.x;
    beam.start.y = src.beam.start.y;
    beam.start.z = src.beam.start.z;
    beam.end.x = src.beam.end.x;
    beam.end.y = src.beam.end.y;
    beam.end.z = src.beam.end.z;
    dst.beam = beam;
  } else {
    dst.beam = undefined;
  }
  return dst;
}

export function decodeProjectileSourceTurretId(
  spawn: NetworkServerSnapshotProjectileSpawn,
): TurretId | undefined {
  const sourceTurretId = spawn.sourceTurretId !== undefined
    ? codeToTurretId(spawn.sourceTurretId) ?? undefined
    : undefined;
  if (sourceTurretId) return sourceTurretId;
  return codeToTurretId(spawn.turretId) ?? undefined;
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
    const sourceTurretId = decodeProjectileSourceTurretId(spawn);
    return spawn.projectileType === PROJECTILE_TYPE_PROJECTILE &&
      !spawn.fromParentDetonation &&
      !!(sourceTurretId && TURRET_CONFIGS[sourceTurretId]?.eventsSmooth);
  }

  enqueue(spawn: NetworkServerSnapshotProjectileSpawn, now: number): void {
    this.remove(spawn.id);
    const queued = this.acquire();
    copyProjectileSpawnInto(spawn, queued.spawn);
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
      spawn: createOwnedProjectileSpawn(),
      playAt: 0,
    };
  }

  private release(queued: QueuedProjectileSpawn): void {
    queued.spawn.beam = undefined;
    queued.spawn.maxLifespan = undefined;
    queued.spawn.isDGun = undefined;
    queued.spawn.fromParentDetonation = undefined;
    queued.spawn.targetEntityId = undefined;
    queued.spawn.homingTurnRate = undefined;
    queued.playAt = 0;
    this.pool.push(queued);
  }
}

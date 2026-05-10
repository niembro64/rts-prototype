import type { PlayerId } from '../sim/types';
import type { SprayTarget } from '../sim/commanderAbilities';
import type { NetworkServerSnapshot } from './NetworkTypes';

const SPRAY_TARGET_POOL_MIN_CAP = 16;
const SPRAY_TARGET_POOL_ACTIVE_MULTIPLIER = 4;

export class ClientSprayTargetStore {
  private targets: SprayTarget[] = [];
  private pool: SprayTarget[] = [];

  applySnapshot(snapshotSprayTargets: NetworkServerSnapshot['sprayTargets']): void {
    const nextActiveCount = snapshotSprayTargets?.length ?? 0;
    this.releaseActiveTargets(nextActiveCount);
    if (snapshotSprayTargets && snapshotSprayTargets.length > 0) {
      for (let i = 0; i < snapshotSprayTargets.length; i++) {
        const source = snapshotSprayTargets[i];
        const target = this.acquireTarget();
        target.source.id = source.source.id;
        target.source.pos.x = source.source.pos.x;
        target.source.pos.y = source.source.pos.y;
        target.source.z = source.source.z;
        target.source.playerId = source.source.playerId;
        target.target.id = source.target.id;
        target.target.pos.x = source.target.pos.x;
        target.target.pos.y = source.target.pos.y;
        target.target.z = source.target.z;
        target.target.dim = source.target.dim;
        target.target.radius = source.target.radius;
        target.type = source.type;
        target.intensity = source.intensity;
        target.speed = source.speed;
        target.particleRadius = source.particleRadius;
        this.targets.push(target);
      }
    }
    this.trimPool(nextActiveCount);
  }

  getTargets(): SprayTarget[] {
    return this.targets;
  }

  reset(): void {
    this.releaseActiveTargets(0);
    this.pool.length = 0;
  }

  private acquireTarget(): SprayTarget {
    let target = this.pool.pop();
    if (!target) {
      target = {
        source: { id: 0, pos: { x: 0, y: 0 }, z: 0, playerId: 1 as PlayerId },
        target: { id: 0, pos: { x: 0, y: 0 }, z: 0 },
        type: 'build',
        intensity: 0,
      };
    }
    target.speed = undefined;
    target.particleRadius = undefined;
    return target;
  }

  private getPoolLimit(activeCount: number): number {
    return Math.max(
      SPRAY_TARGET_POOL_MIN_CAP,
      activeCount * SPRAY_TARGET_POOL_ACTIVE_MULTIPLIER,
    );
  }

  private trimPool(activeCount: number): void {
    const limit = this.getPoolLimit(activeCount);
    if (this.pool.length > limit) {
      this.pool.length = limit;
    }
  }

  private releaseActiveTargets(nextActiveCount: number): void {
    const limit = this.getPoolLimit(nextActiveCount);
    for (let i = 0; i < this.targets.length; i++) {
      if (this.pool.length < limit) {
        this.pool.push(this.targets[i]);
      }
    }
    this.targets.length = 0;
  }
}

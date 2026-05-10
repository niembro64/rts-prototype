import type { SpinConfig } from '../../config';
import type { Entity, EntityId } from '../sim/types';

type BarrelSpinState = {
  angle: number;
  speed: number;
};

export type BarrelSpinFrameState = {
  spinDtSec: number;
  currentDtMs: number;
  timeMs: number;
};

export class UnitBarrelSpinState3D {
  private readonly spins = new Map<EntityId, BarrelSpinState>();
  private lastSpinMs = performance.now();

  beginFrame(): BarrelSpinFrameState {
    const timeMs = performance.now();
    const spinDtSec = Math.min((timeMs - this.lastSpinMs) / 1000, 0.1);
    this.lastSpinMs = timeMs;
    return {
      spinDtSec,
      currentDtMs: spinDtSec * 1000,
      timeMs,
    };
  }

  advance(entity: Entity, dtSec: number): void {
    const turrets = entity.combat?.turrets;
    if (!turrets) return;
    let spinConfig: SpinConfig | undefined;
    for (const turret of turrets) {
      if (turret.config.visualOnly) continue;
      const barrel = turret.config.barrel;
      if (
        barrel &&
        (barrel.type === 'simpleMultiBarrel' || barrel.type === 'coneMultiBarrel')
      ) {
        spinConfig = barrel.spin;
        break;
      }
    }
    if (!spinConfig) return;

    let state = this.spins.get(entity.id);
    if (!state) {
      state = { angle: 0, speed: spinConfig.idle };
      this.spins.set(entity.id, state);
    }

    const firing = turrets.some((turret) => !turret.config.visualOnly && turret.state === 'engaged');
    if (firing) {
      state.speed = Math.min(state.speed + spinConfig.accel * dtSec, spinConfig.max);
    } else {
      state.speed = Math.max(state.speed - spinConfig.decel * dtSec, spinConfig.idle);
    }
    state.angle = (state.angle + state.speed * dtSec) % (Math.PI * 2);
  }

  angleFor(entityId: EntityId): number | undefined {
    return this.spins.get(entityId)?.angle;
  }

  delete(entityId: EntityId): void {
    this.spins.delete(entityId);
  }

  prune(seenIds: ReadonlySet<EntityId>): void {
    for (const id of this.spins.keys()) {
      if (!seenIds.has(id)) this.spins.delete(id);
    }
  }

  clear(): void {
    this.spins.clear();
  }
}

import type { Entity, EntityId } from '../sim/types';
import { CT_TURRET_STATE_ENGAGED } from '../sim-wasm/init';
import {
  readCombatTargetingTurretFsmInto,
  type CombatTargetingTurretFsmOut,
} from '../sim/combat/targetingInputStamping';

type BarrelSpinState = {
  angle: number;
  speed: number;
};

const _barrelSpinFsm: CombatTargetingTurretFsmOut = {
  stateCode: CT_TURRET_STATE_ENGAGED,
  targetId: -1,
};

export type BarrelSpinFrameState = {
  spinDtSec: number;
  currentDtMs: number;
  timeMs: number;
};

export class UnitBarrelSpinState3D {
  // Per-turret spin state: each multi-barrel turret on a unit keeps
  // its own angle + speed so one engaged turret doesn't spin up its
  // neighbors. Outer key = entity id, inner key = turretIndex.
  private readonly spins = new Map<EntityId, Map<number, BarrelSpinState>>();
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

    for (let turretIdx = 0; turretIdx < turrets.length; turretIdx++) {
      const turret = turrets[turretIdx];
      if (turret.config.visualOnly) continue;
      const barrel = turret.config.barrel;
      if (
        !barrel ||
        (barrel.type !== 'simpleMultiBarrel' && barrel.type !== 'coneMultiBarrel')
      ) {
        continue;
      }
      const spinConfig = barrel.spin;

      let perEntity = this.spins.get(entity.id);
      if (!perEntity) {
        perEntity = new Map();
        this.spins.set(entity.id, perEntity);
      }
      let state = perEntity.get(turretIdx);
      if (!state) {
        state = { angle: 0, speed: spinConfig.idle };
        perEntity.set(turretIdx, state);
      }

      const firing = readCombatTargetingTurretFsmInto(entity, turretIdx, _barrelSpinFsm)
        ? _barrelSpinFsm.stateCode === CT_TURRET_STATE_ENGAGED
        : turret.state === 'engaged';
      if (firing) {
        state.speed = Math.min(state.speed + spinConfig.accel * dtSec, spinConfig.max);
      } else {
        state.speed = Math.max(state.speed - spinConfig.decel * dtSec, spinConfig.idle);
      }
      state.angle = (state.angle + state.speed * dtSec) % (Math.PI * 2);
    }
  }

  angleFor(entityId: EntityId, turretIdx: number): number | undefined {
    return this.spins.get(entityId)?.get(turretIdx)?.angle;
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

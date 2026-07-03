import type { Entity, EntityId } from '../sim/types';
import { IndexedEntityIdMap } from '../network/IndexedEntityIdCollections';
import { CT_TURRET_STATE_ENGAGED } from '../sim-wasm/init';
import {
  readCombatTargetingTurretFsmInto,
  type CombatTargetingTurretFsmOut,
} from '../sim/combat/targetingInputStamping';
import {
  CLIENT_RENDER_TURRET_FLAG_MULTI_BARREL_SPIN,
  CLIENT_RENDER_TURRET_FLAG_VISUAL_ONLY,
  CLIENT_RENDER_TURRET_STATE_ENGAGED,
  type ClientRenderTurretHostRows,
} from './ClientRenderTurretStateSlab';

type BarrelSpinState = {
  angle: number;
  speed: number;
};

const _barrelSpinFsm: CombatTargetingTurretFsmOut = {
  stateCode: CT_TURRET_STATE_ENGAGED,
  targetId: -1,
};

type BarrelSpinFrameState = {
  spinDtSec: number;
  currentDtMs: number;
  timeMs: number;
};

export class UnitBarrelSpinState3D {
  // Per-turret spin state: each multi-barrel turret on a unit keeps
  // its own angle + speed so one engaged turret doesn't spin up its
  // neighbors. Outer key = entity id, inner key = turretIndex.
  private readonly spins = new IndexedEntityIdMap<Map<number, BarrelSpinState>>();
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

  advanceRows(entityId: EntityId, rows: ClientRenderTurretHostRows | undefined, dtSec: number): boolean {
    if (rows === undefined) return false;
    const views = rows.views;
    for (let turretIdx = 0; turretIdx < rows.count; turretIdx++) {
      const row = rows.start + turretIdx;
      const flags = views.flags[row];
      if ((flags & CLIENT_RENDER_TURRET_FLAG_VISUAL_ONLY) !== 0) continue;
      if ((flags & CLIENT_RENDER_TURRET_FLAG_MULTI_BARREL_SPIN) === 0) continue;

      let perEntity = this.spins.get(entityId);
      if (!perEntity) {
        perEntity = new Map();
        this.spins.set(entityId, perEntity);
      }
      let state = perEntity.get(turretIdx);
      if (!state) {
        state = { angle: 0, speed: views.spinIdle[row] };
        perEntity.set(turretIdx, state);
      }

      if (views.stateCode[row] === CLIENT_RENDER_TURRET_STATE_ENGAGED) {
        state.speed = Math.min(state.speed + views.spinAccel[row] * dtSec, views.spinMax[row]);
      } else {
        state.speed = Math.max(state.speed - views.spinDecel[row] * dtSec, views.spinIdle[row]);
      }
      state.angle = (state.angle + state.speed * dtSec) % (Math.PI * 2);
    }
    return true;
  }

  angleFor(entityId: EntityId, turretIdx: number): number | undefined {
    return this.spins.get(entityId)?.get(turretIdx)?.angle;
  }

  delete(entityId: EntityId): void {
    this.spins.delete(entityId);
  }

  clear(): void {
    this.spins.clear();
  }
}

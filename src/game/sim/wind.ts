import type { PlayerId } from '@/types/sim';
import type { WorldState } from './WorldState';
import { getBuildingConfig } from './buildConfigs';
import { isEntityActive } from './buildableHelpers';
import { economyManager } from './economy';
import { getSimWasm } from '../sim-wasm/init';

export type WindState = {
  x: number;
  y: number;
  speed: number;
  angle: number;
};

const _windSampleOut = new Float64Array(4);

export function sampleWindState(nowMs = Date.now()): WindState {
  return sampleWindStateInto({ x: 0, y: 0, speed: 0, angle: 0 }, nowMs);
}

export function sampleWindStateInto(target: WindState, nowMs = Date.now()): WindState {
  const sim = getSimWasm();
  if (sim === undefined) {
    throw new Error('sampleWindStateInto: sim-wasm is not initialized');
  }
  if (sim.windSampleState(nowMs, _windSampleOut) === 0) {
    throw new Error('sampleWindStateInto: wind_sample_state rejected its output buffer or timestamp');
  }
  target.x = _windSampleOut[0];
  target.y = _windSampleOut[1];
  target.speed = _windSampleOut[2];
  target.angle = _windSampleOut[3];
  return target;
}

export class WindPowerTracker {
  private appliedProductionByPlayer = new Map<PlayerId, number>();
  private nextProductionByPlayer = new Map<PlayerId, number>();

  update(world: WorldState, wind: WindState): void {
    const baseProduction = getBuildingConfig('buildingWind').energyProduction ?? 0;
    const nextProductionByPlayer = this.nextProductionByPlayer;
    nextProductionByPlayer.clear();

    for (const entity of world.getWindBuildings()) {
      if (!entity.ownership || !entity.building || entity.building.hp <= 0) continue;
      if (!isEntityActive(entity)) continue;
      // OFF (closed) wind turbines stop producing — they're in their
      // stowed pose with blades folded against the pole.
      const activeState = entity.building.activeState;
      if (activeState !== null && activeState.open === false) continue;
      const pid = entity.ownership.playerId;
      nextProductionByPlayer.set(
        pid,
        (nextProductionByPlayer.get(pid) ?? 0) + baseProduction * wind.speed,
      );
    }

    for (const [pid, next] of nextProductionByPlayer) {
      const prev = this.appliedProductionByPlayer.get(pid) ?? 0;
      this.applyDelta(pid, next - prev);
      this.appliedProductionByPlayer.set(pid, next);
    }

    for (const [pid, prev] of this.appliedProductionByPlayer) {
      if (nextProductionByPlayer.has(pid)) continue;
      this.applyDelta(pid, -prev);
      this.appliedProductionByPlayer.delete(pid);
    }
  }

  private applyDelta(playerId: PlayerId, delta: number): void {
    if (Math.abs(delta) < 1e-6) return;
    if (delta > 0) economyManager.addProduction(playerId, delta);
    else economyManager.removeProduction(playerId, -delta);
  }
}

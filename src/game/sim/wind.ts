import type { PlayerId } from '@/types/sim';
import type { WorldState } from './WorldState';
import { getBuildingConfig } from './buildConfigs';
import { isEntityActive } from './buildableHelpers';
import { economyManager } from './economy';
import { getSimWasm } from '../sim-wasm/init';

export type WindState = {
  x: number;
  y: number;
  z: number;
  speed: number;
  angle: number;
};

const _windSampleOut = new Float64Array(5);

export function sampleWindState(nowMs = 0): WindState {
  return sampleWindStateInto({ x: 0, y: 0, z: 0, speed: 0, angle: 0 }, nowMs);
}

export function sampleWindStateInto(target: WindState, nowMs: number): WindState {
  const sim = getSimWasm();
  if (sim === undefined) {
    throw new Error('sampleWindStateInto: sim-wasm is not initialized');
  }
  if (sim.windSampleState(nowMs, _windSampleOut) === 0) {
    throw new Error('sampleWindStateInto: wind_sample_state rejected its output buffer or timestamp');
  }
  target.x = _windSampleOut[0];
  target.y = _windSampleOut[1];
  target.z = _windSampleOut[2];
  target.speed = _windSampleOut[3];
  target.angle = _windSampleOut[4];
  return target;
}

export class WindPowerTracker {
  private appliedProductionByPlayer = new Map<PlayerId, number>();
  private producerPlayerIds = new Uint32Array(32);
  private producerRates = new Float64Array(32);
  private ratesByPlayer = new Float64Array(8);

  update(world: WorldState, wind: WindState): void {
    const baseProduction = getBuildingConfig('buildingWind').energyProduction ?? 0;
    const ratePerTurbine = Math.max(0, baseProduction * wind.speed);
    let count = 0;
    let maxPlayerId = 0;

    if (ratePerTurbine > 0) {
      const windBuildings = world.getWindBuildings();
      for (let i = 0; i < windBuildings.length; i++) {
        const entity = windBuildings[i];
        if (!entity.ownership || !entity.building || entity.building.hp <= 0) continue;
        if (!isEntityActive(entity)) continue;
        // OFF (closed) wind turbines stop producing — they're in their
        // stowed pose with blades folded against the pole.
        const activeState = entity.building.activeState;
        if (activeState !== null && activeState.open === false) continue;
        const pid = entity.ownership.playerId;
        this.ensureProducerCapacity(count + 1);
        this.producerPlayerIds[count] = pid;
        this.producerRates[count] = ratePerTurbine;
        count++;
        if (pid > maxPlayerId) maxPlayerId = pid;
      }
    }

    this.ensurePlayerRateCapacity(maxPlayerId);
    const sim = getSimWasm();
    if (sim === undefined) {
      throw new Error('WindPowerTracker.update: sim-wasm is not initialized');
    }

    const maxExclusive = sim.economyAccumulatePlayerRates(
      this.producerPlayerIds,
      this.producerRates,
      count,
      this.ratesByPlayer,
    );

    for (let playerId = 1; playerId < maxExclusive; playerId++) {
      const next = this.ratesByPlayer[playerId];
      if (next <= 0) continue;
      const pid = playerId as PlayerId;
      const prev = this.appliedProductionByPlayer.get(pid) ?? 0;
      this.applyDelta(pid, next - prev);
      this.appliedProductionByPlayer.set(pid, next);
    }

    for (const [pid, prev] of this.appliedProductionByPlayer) {
      const next = pid < maxExclusive ? this.ratesByPlayer[pid] : 0;
      if (next > 0) continue;
      this.applyDelta(pid, -prev);
      this.appliedProductionByPlayer.delete(pid);
    }
  }

  private ensureProducerCapacity(count: number): void {
    if (count <= this.producerPlayerIds.length) return;
    let nextCapacity = this.producerPlayerIds.length;
    while (nextCapacity < count) nextCapacity *= 2;

    const nextPlayerIds = new Uint32Array(nextCapacity);
    nextPlayerIds.set(this.producerPlayerIds);
    this.producerPlayerIds = nextPlayerIds;

    const nextRates = new Float64Array(nextCapacity);
    nextRates.set(this.producerRates);
    this.producerRates = nextRates;
  }

  private ensurePlayerRateCapacity(playerId: number): void {
    if (playerId < this.ratesByPlayer.length) return;
    let nextCapacity = this.ratesByPlayer.length;
    while (nextCapacity <= playerId) nextCapacity *= 2;
    this.ratesByPlayer = new Float64Array(nextCapacity);
  }

  private applyDelta(playerId: PlayerId, delta: number): void {
    if (Math.abs(delta) < 1e-6) return;
    if (delta > 0) economyManager.addProduction(playerId, delta);
    else economyManager.removeProduction(playerId, -delta);
  }
}

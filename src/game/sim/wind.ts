import type { PlayerId } from '@/types/sim';
import type { WorldState } from './WorldState';
import { getBuildingConfig } from './buildConfigs';
import { isEntityActive } from './buildableHelpers';
import { economyManager } from './economy';
import { getSimWasm } from '../sim-wasm/init';
import { nextGeometricCapacity } from '../memory/typedArrayGrowth';

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
  private ratesByPlayer = new Float64Array(8);

  /** P1-20: per-player ACTIVE turbine counts, cached against building
   *  lifecycle + open-state versions. Every producing turbine contributes
   *  the identical ratePerTurbine, so the per-tick math collapses to
   *  count * rate per player with no turbine scan. */
  private cachedTurbineCounts = new Float64Array(8);
  private cachedTurbineMaxExclusive = 0;
  private cachedBuildingVersion = -1;
  private cachedOpenStateVersion = -1;

  private refreshTurbineCounts(world: WorldState): void {
    const buildingVersion = world.getBuildingVersion();
    const openVersion = world.buildingOpenStateVersion;
    if (
      buildingVersion === this.cachedBuildingVersion &&
      openVersion === this.cachedOpenStateVersion
    ) {
      return;
    }
    this.cachedBuildingVersion = buildingVersion;
    this.cachedOpenStateVersion = openVersion;
    this.cachedTurbineCounts.fill(0);
    let maxPlayerId = 0;
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
      if (pid >= this.cachedTurbineCounts.length) {
        const next = new Float64Array(Math.max(pid + 1, this.cachedTurbineCounts.length * 2));
        next.set(this.cachedTurbineCounts);
        this.cachedTurbineCounts = next;
      }
      this.cachedTurbineCounts[pid] += 1;
      if (pid > maxPlayerId) maxPlayerId = pid;
    }
    this.cachedTurbineMaxExclusive = maxPlayerId + 1;
  }

  update(world: WorldState, wind: WindState): void {
    const baseProduction = getBuildingConfig('buildingWind').energyProduction ?? 0;
    const ratePerTurbine = Math.max(0, baseProduction * wind.speed);
    this.refreshTurbineCounts(world);

    const maxExclusive = ratePerTurbine > 0 ? this.cachedTurbineMaxExclusive : 0;
    this.ensurePlayerRateCapacity(Math.max(0, maxExclusive - 1));
    for (let pid = 0; pid < this.ratesByPlayer.length; pid++) this.ratesByPlayer[pid] = 0;
    for (let pid = 1; pid < maxExclusive; pid++) {
      this.ratesByPlayer[pid] = this.cachedTurbineCounts[pid] * ratePerTurbine;
    }

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

  private ensurePlayerRateCapacity(playerId: number): void {
    if (playerId < this.ratesByPlayer.length) return;
    const nextCapacity = nextGeometricCapacity(this.ratesByPlayer.length, playerId + 1);
    this.ratesByPlayer = new Float64Array(nextCapacity);
  }

  private applyDelta(playerId: PlayerId, delta: number): void {
    if (Math.abs(delta) < 1e-6) return;
    if (delta > 0) economyManager.addProduction(playerId, delta);
    else economyManager.removeProduction(playerId, -delta);
  }
}

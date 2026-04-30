import type { PlayerId } from '@/types/sim';
import type { WorldState } from './WorldState';
import { getBuildingConfig } from './buildConfigs';
import { economyManager } from './economy';

export type WindState = {
  x: number;
  y: number;
  speed: number;
  angle: number;
};

export function sampleWindState(nowMs = Date.now()): WindState {
  const t = nowMs / 1000;
  const angle =
    Math.sin(t / 271) * 1.1 +
    Math.cos(t / 619 + 0.8) * 0.7 +
    Math.sin(t / 1429 + 2.4) * 0.45;
  const rawSpeed =
    0.92 +
    Math.sin(t / 353 + 1.7) * 0.28 +
    Math.cos(t / 811 + 0.2) * 0.22 +
    Math.sin(t / 1777 + 4.1) * 0.13;
  const speed = Math.max(0.25, Math.min(1.55, rawSpeed));
  return {
    x: Math.cos(angle) * speed,
    y: Math.sin(angle) * speed,
    speed,
    angle,
  };
}

export class WindPowerTracker {
  private appliedProductionByPlayer = new Map<PlayerId, number>();
  private nextProductionByPlayer = new Map<PlayerId, number>();

  update(world: WorldState, wind: WindState): void {
    const baseProduction = getBuildingConfig('wind').energyProduction ?? 0;
    const nextProductionByPlayer = this.nextProductionByPlayer;
    nextProductionByPlayer.clear();

    for (const entity of world.getBuildings()) {
      if (entity.buildingType !== 'wind') continue;
      if (!entity.ownership || !entity.building || entity.building.hp <= 0) continue;
      if (!entity.buildable?.isComplete || entity.buildable.isGhost) continue;
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

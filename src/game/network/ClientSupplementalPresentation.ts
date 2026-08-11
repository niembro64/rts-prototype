import type { Entity, EntityId } from '../sim/types';
import type { ProjectileSpawnQueue } from './ProjectileSpawnQueue';
import type { NetworkServerSnapshotProjectileSpawn } from './NetworkManager';
import {
  type BeamPathTarget,
  shrinkBeamPoints,
} from './ClientPredictionTargets';
import { isLineProjectileEntity } from './ClientProjectileUtils';
import type { ClientPredictionTargetAgeStats } from './ClientPredictionDiagnostics';

type ClientSupplementalPresentationOptions = {
  entities: Map<EntityId, Entity>;
  beamPathTargets: Map<EntityId, BeamPathTarget>;
  projectileSpawns: ProjectileSpawnQueue;
  activeBeamPathIds: Set<EntityId>;
  applyProjectileSpawn: (spawn: NetworkServerSnapshotProjectileSpawn) => boolean;
};

function noteTargetAge(
  stats: ClientPredictionTargetAgeStats,
  updatedAtMs: number | undefined,
  now: number,
): void {
  if (!updatedAtMs || updatedAtMs <= 0) return;
  const ageMs = Math.max(0, now - updatedAtMs);
  stats.activeTargets++;
  stats.totalTargetAgeMs += ageMs;
  if (ageMs > stats.maxTargetAgeMs) stats.maxTargetAgeMs = ageMs;
}

export class ClientSupplementalPresentation {
  private frameCounter = 0;

  constructor(private readonly options: ClientSupplementalPresentationOptions) {}

  getFrameCounter(): number {
    return this.frameCounter;
  }

  reset(): void {
    this.frameCounter = 0;
  }

  apply(_deltaMs: number): ClientPredictionTargetAgeStats {
    const {
      entities,
      beamPathTargets,
      projectileSpawns,
      activeBeamPathIds,
      applyProjectileSpawn,
    } = this.options;

    this.frameCounter = (this.frameCounter + 1) & 0x3fffffff;
    if (this.frameCounter === 0) this.frameCounter = 1;

    const now = performance.now();
    const targetAgeStats: ClientPredictionTargetAgeStats = {
      activeTargets: 0,
      totalTargetAgeMs: 0,
      maxTargetAgeMs: 0,
    };
    projectileSpawns.drain(now, applyProjectileSpawn);

    for (const id of activeBeamPathIds) {
      const entity = entities.get(id);
      if (entity === undefined || entity.projectile === null || !isLineProjectileEntity(entity)) {
        const beamTarget = beamPathTargets.get(id);
        if (beamTarget !== undefined) shrinkBeamPoints(beamTarget.points, 0);
        activeBeamPathIds.delete(id);
        beamPathTargets.delete(id);
        continue;
      }

      const beamTarget = beamPathTargets.get(id);
      noteTargetAge(targetAgeStats, beamTarget?.updatedAtMs, now);
    }
    return targetAgeStats;
  }
}

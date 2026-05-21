import {
  getMovementPosEmaMode,
  getPredictionMode,
} from '@/clientBarConfig';
import type { Entity, EntityId } from '../sim/types';
import { angleDeltaAbs, lerp } from '../math';
import { getChannelBlend } from './driftEma';
import { ClientPredictionCadence } from './ClientPredictionCadence';
import {
  applyClientCombatExpensivePrediction,
  applyClientUnitVisualPrediction,
  clientUnitPredictionIsSettled,
} from './ClientUnitPrediction';
import { applyClientProjectilePrediction } from './ClientProjectilePrediction';
import type { ProjectileSpawnQueue } from './ProjectileSpawnQueue';
import type { NetworkServerSnapshotProjectileSpawn } from './NetworkManager';
import {
  type BeamPathTarget,
  ensureBeamPoint,
  shrinkBeamPoints,
  type ServerTarget,
} from './ClientPredictionTargets';
import { isLineProjectileEntity } from './ClientProjectileUtils';
import type { ClientPredictionTargetAgeStats } from './ClientPredictionDiagnostics';

type ClientPredictionStepperOptions = {
  entities: Map<EntityId, Entity>;
  serverTargets: Map<EntityId, ServerTarget>;
  beamPathTargets: Map<EntityId, BeamPathTarget>;
  projectileSpawns: ProjectileSpawnQueue;
  predictionCadence: ClientPredictionCadence;
  activeEntityPredictionIds: Set<EntityId>;
  activeProjectilePredictionIds: Set<EntityId>;
  activeBeamPathIds: Set<EntityId>;
  dirtyUnitRenderIds: Set<EntityId>;
  getMapWidth: () => number;
  getMapHeight: () => number;
  getServerForceFieldsEnabled: () => boolean;
  setForceFieldsEnabledForPrediction: (enabled: boolean) => void;
  applyProjectileSpawn: (spawn: NetworkServerSnapshotProjectileSpawn) => boolean;
  deleteEntityLocalState: (id: EntityId) => void;
  markLineProjectilesChanged: () => void;
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

function applyBeamPathPrediction(
  entity: Entity,
  target: BeamPathTarget,
  deltaMs: number,
  movPosBlend: number,
): boolean {
  const proj = entity.projectile;
  if (!proj) return false;
  const tgtPts = target.points;
  if (tgtPts.length === 0) return false;

  const dt = deltaMs / 1000;
  let changed = false;

  const projPts = proj.points ?? (proj.points = []);
  const oldLen = projPts.length;
  if (oldLen !== tgtPts.length) {
    if (oldLen > tgtPts.length) {
      shrinkBeamPoints(projPts, tgtPts.length);
    } else {
      projPts.length = tgtPts.length;
    }
    changed = true;
  }

  // PREDICT mode gates whether we step the snapshot beam-path target
  // forward each frame. 'pos' freezes the target at its last snapshot
  // value (the per-channel movement-pos EMA below still pulls the
  // rendered point toward it). 'vel' steps position from velocity.
  // Acceleration is not on the wire, so the
  // per-vertex `ax/ay/az` slots stay at 0 and the integrator never
  // reads them — there is no ACC mode.
  const predictionMode = getPredictionMode();
  if (predictionMode !== 'pos') {
    for (let i = 0; i < tgtPts.length; i++) {
      const tp = tgtPts[i];
      tp.x += tp.vx * dt;
      tp.y += tp.vy * dt;
      tp.z += tp.vz * dt;
    }
  }

  for (let i = 0; i < tgtPts.length; i++) {
    const tp = tgtPts[i];
    let pp = projPts[i];
    if (!pp || i >= oldLen) {
      pp = ensureBeamPoint(projPts, i);
      pp.x = tp.x; pp.y = tp.y; pp.z = tp.z;
      pp.vx = tp.vx; pp.vy = tp.vy; pp.vz = tp.vz;
      pp.ax = tp.ax; pp.ay = tp.ay; pp.az = tp.az;
      pp.mirrorEntityId = tp.mirrorEntityId;
      pp.reflectorKind = tp.reflectorKind;
      pp.reflectorPlayerId = tp.reflectorPlayerId;
      pp.normalX = tp.normalX;
      pp.normalY = tp.normalY;
      pp.normalZ = tp.normalZ;
      changed = true;
      continue;
    }
    const px = pp.x, py = pp.y, pz = pp.z;
    const nx = movPosBlend < 0 ? px : lerp(px, tp.x, movPosBlend);
    const ny = movPosBlend < 0 ? py : lerp(py, tp.y, movPosBlend);
    const nz = movPosBlend < 0 ? pz : lerp(pz, tp.z, movPosBlend);
    if (
      Math.abs(nx - px) > 1e-4 ||
      Math.abs(ny - py) > 1e-4 ||
      Math.abs(nz - pz) > 1e-4 ||
      pp.mirrorEntityId !== tp.mirrorEntityId
      || pp.reflectorKind !== tp.reflectorKind
      || pp.reflectorPlayerId !== tp.reflectorPlayerId
      || pp.normalX !== tp.normalX
      || pp.normalY !== tp.normalY
      || pp.normalZ !== tp.normalZ
      || pp.ax !== tp.ax
      || pp.ay !== tp.ay
      || pp.az !== tp.az
    ) {
      changed = true;
    }
    pp.x = nx;
    pp.y = ny;
    pp.z = nz;
    pp.vx = tp.vx; pp.vy = tp.vy; pp.vz = tp.vz;
    pp.ax = tp.ax; pp.ay = tp.ay; pp.az = tp.az;
    pp.mirrorEntityId = tp.mirrorEntityId;
    pp.reflectorKind = tp.reflectorKind;
    pp.reflectorPlayerId = tp.reflectorPlayerId;
    pp.normalX = tp.normalX;
    pp.normalY = tp.normalY;
    pp.normalZ = tp.normalZ;
  }
  proj.obstructionT = target.obstructionT;
  proj.endpointDamageable = target.endpointDamageable !== false;

  const start = projPts[0];
  const second = projPts[1] ?? start;
  const nextRotation = Math.atan2(second.y - start.y, second.x - start.x);
  if (
    Math.abs(entity.transform.x - start.x) > 1e-4 ||
    Math.abs(entity.transform.y - start.y) > 1e-4 ||
    Math.abs(entity.transform.z - start.z) > 1e-4 ||
    angleDeltaAbs(entity.transform.rotation, nextRotation) > 1e-4
  ) {
    changed = true;
  }
  entity.transform.x = start.x;
  entity.transform.y = start.y;
  entity.transform.z = start.z;
  entity.transform.rotation = nextRotation;
  return changed;
}

export class ClientPredictionStepper {
  private frameCounter = 0;

  constructor(private readonly options: ClientPredictionStepperOptions) {}

  getFrameCounter(): number {
    return this.frameCounter;
  }

  reset(): void {
    this.frameCounter = 0;
  }

  apply(deltaMs: number): ClientPredictionTargetAgeStats {
    const {
      entities,
      serverTargets,
      beamPathTargets,
      projectileSpawns,
      predictionCadence,
      activeEntityPredictionIds,
      activeProjectilePredictionIds,
      activeBeamPathIds,
      dirtyUnitRenderIds,
      getMapWidth,
      getMapHeight,
      getServerForceFieldsEnabled,
      setForceFieldsEnabledForPrediction,
      applyProjectileSpawn,
      deleteEntityLocalState,
      markLineProjectilesChanged,
    } = this.options;

    this.frameCounter = (this.frameCounter + 1) & 0x3fffffff;
    if (this.frameCounter === 0) this.frameCounter = 1;

    const now = performance.now();
    const targetAgeStats: ClientPredictionTargetAgeStats = {
      activeTargets: 0,
      totalTargetAgeMs: 0,
      maxTargetAgeMs: 0,
    };
    // Beam paths follow the movement-position channel for their per-
    // vertex EMA. Projectiles use the same channel through
    // applyClientProjectilePrediction (passed via the same blend).
    const beamMovPosBlend = getChannelBlend(getMovementPosEmaMode(), deltaMs / 1000);
    projectileSpawns.drain(now, applyProjectileSpawn);

    const forceFieldsEnabled = getServerForceFieldsEnabled();
    setForceFieldsEnabledForPrediction(forceFieldsEnabled);

    let beamPathsChanged = false;
    for (const id of activeBeamPathIds) {
      const entity = entities.get(id);
      if (!entity?.projectile || !isLineProjectileEntity(entity)) {
        activeBeamPathIds.delete(id);
        beamPathTargets.delete(id);
        continue;
      }

      entity.projectile.timeAlive += deltaMs;
      if (
        Number.isFinite(entity.projectile.maxLifespan) &&
        entity.projectile.timeAlive > entity.projectile.maxLifespan + 1000
      ) {
        deleteEntityLocalState(entity.id);
        beamPathsChanged = true;
        continue;
      }

      const beamTarget = beamPathTargets.get(id);
      noteTargetAge(targetAgeStats, beamTarget?.updatedAtMs, now);
      if (beamTarget && applyBeamPathPrediction(entity, beamTarget, deltaMs, beamMovPosBlend)) {
        beamPathsChanged = true;
      }
    }
    if (beamPathsChanged) markLineProjectilesChanged();

    for (const id of activeEntityPredictionIds) {
      const entity = entities.get(id);
      if (!entity?.unit && !entity?.combat) {
        activeEntityPredictionIds.delete(id);
        predictionCadence.clear(id);
        continue;
      }

      const target = serverTargets.get(id);
      noteTargetAge(targetAgeStats, target?.updatedAtMs, now);
      if (entity.unit) {
        applyClientUnitVisualPrediction({
          entity,
          target,
          deltaMs,
          mapWidth: getMapWidth(),
          mapHeight: getMapHeight(),
        });
        dirtyUnitRenderIds.add(id);
      }
      if (entity.combat && entity.combat.turrets.length > 0) {
        const predictionStep = predictionCadence.consumeDelta(deltaMs);
        applyClientCombatExpensivePrediction({
          entity,
          target,
          predictionStep,
          forceFieldsEnabled,
        });
      }

      if (clientUnitPredictionIsSettled(entity, target, forceFieldsEnabled)) {
        activeEntityPredictionIds.delete(id);
        predictionCadence.clear(id);
      }
    }

    for (const id of activeProjectilePredictionIds) {
      const entity = entities.get(id);
      if (!entity?.projectile) {
        activeProjectilePredictionIds.delete(id);
        continue;
      }

      const target = serverTargets.get(id);
      noteTargetAge(targetAgeStats, target?.updatedAtMs, now);
      const predictionStep = predictionCadence.consumeDelta(deltaMs);

      const projectileResult = applyClientProjectilePrediction({
        entity,
        target,
        predictionStep,
        mapWidth: getMapWidth(),
        mapHeight: getMapHeight(),
        getEntity: (entityId) => entities.get(entityId),
      });
      if (projectileResult.becameLineProjectile) {
        activeBeamPathIds.add(id);
        activeProjectilePredictionIds.delete(id);
        continue;
      }
      if (projectileResult.shouldDelete) {
        deleteEntityLocalState(entity.id);
      }
    }
    return targetAgeStats;
  }
}

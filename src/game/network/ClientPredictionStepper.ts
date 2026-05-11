import { getDriftMode } from '@/clientBarConfig';
import type { Entity, EntityId } from '../sim/types';
import { lerp } from '../math';
import { getDriftPreset, halfLifeBlend, type DriftPreset } from './driftEma';
import {
  ClientPredictionLod,
  type PredictionLodContext,
} from './ClientPredictionLod';
import {
  applyClientCombatExpensivePrediction,
  applyClientUnitVisualPrediction,
  clientUnitPredictionIsSettled,
} from './ClientUnitPrediction';
import { applyClientProjectilePrediction } from './ClientProjectilePrediction';
import type { ClientRocketTargetFinder } from './ClientRocketTargetFinder';
import type { ProjectileSpawnQueue } from './ProjectileSpawnQueue';
import type { NetworkServerSnapshotProjectileSpawn } from './NetworkManager';
import {
  type BeamPathTarget,
  ensureBeamPoint,
  type ServerTarget,
} from './ClientPredictionTargets';
import { isLineProjectileEntity } from './ClientProjectileUtils';

type ClientPredictionStepperOptions = {
  entities: Map<EntityId, Entity>;
  serverTargets: Map<EntityId, ServerTarget>;
  beamPathTargets: Map<EntityId, BeamPathTarget>;
  projectileSpawns: ProjectileSpawnQueue;
  predictionLod: ClientPredictionLod;
  rocketTargetFinder: ClientRocketTargetFinder;
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

function angleDeltaAbs(a: number, b: number): number {
  return Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
}

function applyBeamPathPrediction(
  entity: Entity,
  target: BeamPathTarget,
  deltaMs: number,
  preset: DriftPreset,
): boolean {
  const proj = entity.projectile;
  if (!proj) return false;
  const tgtPts = target.points;
  if (tgtPts.length === 0) return false;

  const blend = halfLifeBlend(deltaMs / 1000, preset.movement.pos);
  const dt = deltaMs / 1000;
  let changed = false;

  const projPts = proj.points ?? (proj.points = []);
  const oldLen = projPts.length;
  if (oldLen !== tgtPts.length) {
    projPts.length = tgtPts.length;
    changed = true;
  }

  for (let i = 0; i < tgtPts.length; i++) {
    const tp = tgtPts[i];
    const halfDtSq = 0.5 * dt * dt;
    tp.x += tp.vx * dt + tp.ax * halfDtSq;
    tp.y += tp.vy * dt + tp.ay * halfDtSq;
    tp.z += tp.vz * dt + tp.az * halfDtSq;
    tp.vx += tp.ax * dt;
    tp.vy += tp.ay * dt;
    tp.vz += tp.az * dt;
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
    const nx = lerp(px, tp.x, blend);
    const ny = lerp(py, tp.y, blend);
    const nz = lerp(pz, tp.z, blend);
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

  apply(deltaMs: number, lod?: PredictionLodContext): void {
    const {
      entities,
      serverTargets,
      beamPathTargets,
      projectileSpawns,
      predictionLod,
      rocketTargetFinder,
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
    predictionLod.beginFrame(lod);

    const preset = getDriftPreset(getDriftMode());
    projectileSpawns.drain(performance.now(), applyProjectileSpawn);

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
      if (beamTarget && applyBeamPathPrediction(entity, beamTarget, deltaMs, preset)) {
        beamPathsChanged = true;
      }
    }
    if (beamPathsChanged) markLineProjectilesChanged();

    for (const id of activeEntityPredictionIds) {
      const entity = entities.get(id);
      if (!entity?.unit && !entity?.combat) {
        activeEntityPredictionIds.delete(id);
        predictionLod.clear(id);
        continue;
      }

      const target = serverTargets.get(id);
      if (entity.unit) {
        applyClientUnitVisualPrediction({
          entity,
          target,
          deltaMs,
          preset,
          mapWidth: getMapWidth(),
          mapHeight: getMapHeight(),
        });
        dirtyUnitRenderIds.add(id);
      }
      if (entity.combat && entity.combat.turrets.length > 0) {
        const predictionTier = predictionLod.resolveTier(entity, lod);
        const predictionStride = predictionLod.frameStride(
          predictionTier,
          entity,
          lod,
          (sourceId) => entities.get(sourceId)?.selectable?.selected === true,
        );
        const predictionStep = predictionLod.consumeDelta(
          entity.id,
          this.frameCounter,
          deltaMs,
          predictionStride,
        );
        if (predictionStep) {
          applyClientCombatExpensivePrediction({
            entity,
            target,
            predictionStep,
            preset,
            forceFieldsEnabled,
          });
        }
      }

      if (clientUnitPredictionIsSettled(entity, target, forceFieldsEnabled)) {
        activeEntityPredictionIds.delete(id);
        predictionLod.clear(id);
      }
    }

    for (const id of activeProjectilePredictionIds) {
      const entity = entities.get(id);
      if (!entity?.projectile) {
        activeProjectilePredictionIds.delete(id);
        continue;
      }

      const target = serverTargets.get(id);
      const predictionTier = predictionLod.resolveTier(entity, lod);
      const predictionStride = predictionLod.frameStride(
        predictionTier,
        entity,
        lod,
        (sourceId) => entities.get(sourceId)?.selectable?.selected === true,
      );
      const predictionStep = predictionLod.consumeDelta(
        entity.id,
        this.frameCounter,
        deltaMs,
        predictionStride,
      );
      if (predictionStep === null) continue;

      const projectileResult = applyClientProjectilePrediction({
        entity,
        target,
        predictionStep,
        preset,
        mapWidth: getMapWidth(),
        mapHeight: getMapHeight(),
        getEntity: (entityId) => entities.get(entityId),
        findNearestEnemyForRocket: (projectile, ownerId) =>
          rocketTargetFinder.findNearestEnemyForRocket(projectile, ownerId),
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
  }
}

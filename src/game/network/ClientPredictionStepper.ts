import {
  getBeamEmaMode,
  getMovementPosEmaMode,
  getMovementVelEmaMode,
  getPredictionMode,
} from '@/clientBarConfig';
import type { BeamPoint, Entity, EntityId } from '../sim/types';
import { angleDeltaAbs, lerp } from '../math';
import { getChannelBlend } from './driftEma';
import { ClientPredictionCadence } from './ClientPredictionCadence';
import {
  applyClientCombatExpensivePrediction,
  applyClientUnitVisualPredictionBatch,
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
  supportSurfaceEntities: readonly Entity[];
  getMapWidth: () => number;
  getMapHeight: () => number;
  getServerShieldsEnabled: () => boolean;
  setTurretShieldSpheresEnabledForPrediction: (enabled: boolean) => void;
  applyProjectileSpawn: (spawn: NetworkServerSnapshotProjectileSpawn) => boolean;
  deleteEntityLocalState: (id: EntityId) => void;
  markLineProjectilesChanged: () => void;
  updateProjectileRenderSpatialIndex: (entity: Entity) => void;
  markBeamHostRenderDirty: (beamEntity: Entity) => void;
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

function beamPointIsReflector(point: BeamPoint): boolean {
  return point.reflectorEntityId !== null || point.reflectorKind !== null;
}

function beamPointStateDiffers(a: BeamPoint, b: BeamPoint): boolean {
  return (
    Math.abs(a.x - b.x) > 1e-4 ||
    Math.abs(a.y - b.y) > 1e-4 ||
    Math.abs(a.z - b.z) > 1e-4 ||
    Math.abs(a.vx - b.vx) > 1e-4 ||
    Math.abs(a.vy - b.vy) > 1e-4 ||
    Math.abs(a.vz - b.vz) > 1e-4 ||
    a.reflectorEntityId !== b.reflectorEntityId ||
    a.reflectorKind !== b.reflectorKind ||
    a.reflectorPlayerId !== b.reflectorPlayerId ||
    a.normalX !== b.normalX ||
    a.normalY !== b.normalY ||
    a.normalZ !== b.normalZ
  );
}

function copyBeamPointState(dst: BeamPoint, src: BeamPoint): void {
  dst.x = src.x; dst.y = src.y; dst.z = src.z;
  dst.vx = src.vx; dst.vy = src.vy; dst.vz = src.vz;
  dst.reflectorEntityId = src.reflectorEntityId;
  dst.reflectorKind = src.reflectorKind;
  dst.reflectorPlayerId = src.reflectorPlayerId;
  dst.normalX = src.normalX;
  dst.normalY = src.normalY;
  dst.normalZ = src.normalZ;
}

function seedBeamPointPositionScalars(
  dst: BeamPoint,
  x: number,
  y: number,
  z: number,
  vx: number,
  vy: number,
  vz: number,
): void {
  dst.x = x; dst.y = y; dst.z = z;
  dst.vx = vx; dst.vy = vy; dst.vz = vz;
}

function shouldSnapExistingBeamPoint(current: BeamPoint, target: BeamPoint): boolean {
  const targetIsReflector = beamPointIsReflector(target);
  // A target reflector vertex is a hard boundary point. If this display
  // index was previously an endpoint, snap it to the shield hit so the
  // incoming segment cannot visually pass through the shield. The inverse
  // transition is allowed to EMA away from the old reflector; that avoids
  // whole-polyline resets when a reflection ends.
  if (!beamPointIsReflector(current) && targetIsReflector) {
    return true;
  }
  if (
    current.reflectorEntityId !== null &&
    target.reflectorEntityId !== null &&
    (current.reflectorEntityId !== target.reflectorEntityId ||
      current.reflectorKind !== target.reflectorKind)
  ) {
    return true;
  }
  if (
    current.reflectorEntityId === null &&
    target.reflectorEntityId === null &&
    current.reflectorKind !== null &&
    target.reflectorKind !== null &&
    current.reflectorKind !== target.reflectorKind
  ) {
    return true;
  }
  return false;
}

function applyBeamPathPrediction(
  entity: Entity,
  target: BeamPathTarget,
  deltaMs: number,
  movPosBlend: number,
  movVelBlend: number,
  predictionMode: ReturnType<typeof getPredictionMode>,
): boolean {
  const proj = entity.projectile;
  if (!proj) return false;
  const tgtPts = target.points;
  if (tgtPts.length === 0) return false;

  const dt = deltaMs / 1000;
  let changed = false;

  const projPts = proj.points ?? (proj.points = []);
  const oldLen = projPts.length;
  // Keep snapshot application out of the displayed points. Length changes
  // are reconciled here so existing indexes can keep their EMA state; new
  // non-reflector endpoints seed from the old endpoint instead of from zero
  // or from the authoritative target, which removes snapshot-time resets.
  let hasOldLastPointSeed = false;
  let oldLastX = 0, oldLastY = 0, oldLastZ = 0;
  let oldLastVx = 0, oldLastVy = 0, oldLastVz = 0;
  if (oldLen > 0 && oldLen < tgtPts.length) {
    const oldLastPoint = projPts[oldLen - 1];
    if (oldLastPoint !== undefined) {
      hasOldLastPointSeed = true;
      oldLastX = oldLastPoint.x;
      oldLastY = oldLastPoint.y;
      oldLastZ = oldLastPoint.z;
      oldLastVx = oldLastPoint.vx;
      oldLastVy = oldLastPoint.vy;
      oldLastVz = oldLastPoint.vz;
    }
  }
  if (oldLen > tgtPts.length) {
    shrinkBeamPoints(projPts, tgtPts.length);
    changed = true;
  } else if (oldLen < tgtPts.length) {
    projPts.length = tgtPts.length;
    changed = true;
  }

  // PREDICT mode gates whether we step the snapshot beam-path target
  // forward each frame. 'pos' freezes the target at its last snapshot
  // value (the per-channel movement-pos EMA below still pulls the
  // rendered point toward it). 'vel' steps position from velocity only
  // while the path is still an unreflected open ray. A shield reflection
  // vertex is not a particle: it is a ray/plane constraint point, and
  // all later vertices are only valid as the result of that full
  // reflected trace. Without a local re-trace, independently
  // dead-reckoning those vertices can manufacture paths that cross
  // shield planes before the next authoritative snapshot arrives.
  // Acceleration is not on the wire, so there is no ACC mode.
  if (predictionMode !== 'pos') {
    let canDeadReckonVertex = true;
    for (let i = 0; i < tgtPts.length; i++) {
      const tp = tgtPts[i];
      if (!canDeadReckonVertex || beamPointIsReflector(tp)) {
        canDeadReckonVertex = false;
        continue;
      }
      tp.x += tp.vx * dt;
      tp.y += tp.vy * dt;
      tp.z += tp.vz * dt;
    }
  }

  for (let i = 0; i < tgtPts.length; i++) {
    const tp = tgtPts[i];
    let pp = projPts[i];
    const isNewPoint = !pp || i >= oldLen;
    if (isNewPoint) {
      pp = ensureBeamPoint(projPts, i);
      if (beamPointIsReflector(tp) || !hasOldLastPointSeed) {
        copyBeamPointState(pp, tp);
        changed = true;
        continue;
      }
      seedBeamPointPositionScalars(
        pp,
        oldLastX,
        oldLastY,
        oldLastZ,
        oldLastVx,
        oldLastVy,
        oldLastVz,
      );
      pp.reflectorEntityId = tp.reflectorEntityId;
      pp.reflectorKind = tp.reflectorKind;
      pp.reflectorPlayerId = tp.reflectorPlayerId;
      pp.normalX = tp.normalX;
      pp.normalY = tp.normalY;
      pp.normalZ = tp.normalZ;
      changed = true;
    } else if (shouldSnapExistingBeamPoint(pp, tp)) {
      copyBeamPointState(pp, tp);
      changed = true;
      continue;
    } else if (beamPointIsReflector(tp)) {
      if (beamPointStateDiffers(pp, tp)) changed = true;
      copyBeamPointState(pp, tp);
      continue;
    }
    const px = pp.x, py = pp.y, pz = pp.z;
    const nx = movPosBlend < 0 ? px : lerp(px, tp.x, movPosBlend);
    const ny = movPosBlend < 0 ? py : lerp(py, tp.y, movPosBlend);
    const nz = movPosBlend < 0 ? pz : lerp(pz, tp.z, movPosBlend);
    const pvx = pp.vx, pvy = pp.vy, pvz = pp.vz;
    let nvx = pvx, nvy = pvy, nvz = pvz;
    if (movVelBlend >= 1) {
      nvx = tp.vx; nvy = tp.vy; nvz = tp.vz;
    } else if (movVelBlend >= 0) {
      nvx = lerp(pvx, tp.vx, movVelBlend);
      nvy = lerp(pvy, tp.vy, movVelBlend);
      nvz = lerp(pvz, tp.vz, movVelBlend);
    }
    if (
      Math.abs(nx - px) > 1e-4 ||
      Math.abs(ny - py) > 1e-4 ||
      Math.abs(nz - pz) > 1e-4 ||
      Math.abs(nvx - pvx) > 1e-4 ||
      Math.abs(nvy - pvy) > 1e-4 ||
      Math.abs(nvz - pvz) > 1e-4 ||
      pp.reflectorEntityId !== tp.reflectorEntityId ||
      pp.reflectorKind !== tp.reflectorKind ||
      pp.reflectorPlayerId !== tp.reflectorPlayerId ||
      pp.normalX !== tp.normalX ||
      pp.normalY !== tp.normalY ||
      pp.normalZ !== tp.normalZ
    ) {
      changed = true;
    }
    pp.x = nx;
    pp.y = ny;
    pp.z = nz;
    pp.vx = nvx; pp.vy = nvy; pp.vz = nvz;
    pp.reflectorEntityId = tp.reflectorEntityId;
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
  private readonly unitPredictionEntities: Entity[] = [];
  private readonly unitPredictionTargets: Array<ServerTarget | undefined> = [];
  private readonly entitySettlementIds: EntityId[] = [];

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
      supportSurfaceEntities,
      getMapWidth,
      getMapHeight,
      getServerShieldsEnabled,
      setTurretShieldSpheresEnabledForPrediction,
      applyProjectileSpawn,
      deleteEntityLocalState,
      markLineProjectilesChanged,
      updateProjectileRenderSpatialIndex,
      markBeamHostRenderDirty,
    } = this.options;

    this.frameCounter = (this.frameCounter + 1) & 0x3fffffff;
    if (this.frameCounter === 0) this.frameCounter = 1;

    const now = performance.now();
    const targetAgeStats: ClientPredictionTargetAgeStats = {
      activeTargets: 0,
      totalTargetAgeMs: 0,
      maxTargetAgeMs: 0,
    };
    // Beam path positions have their own EMA because smoothing a reflected
    // polyline has different visual failure modes than smoothing unit motion.
    const movPosBlend = getChannelBlend(getMovementPosEmaMode(), deltaMs / 1000);
    const movVelBlend = getChannelBlend(getMovementVelEmaMode(), deltaMs / 1000);
    const beamPosBlend = getChannelBlend(getBeamEmaMode(), deltaMs / 1000);
    const predictionMode = getPredictionMode();
    const mapWidth = getMapWidth();
    const mapHeight = getMapHeight();
    projectileSpawns.drain(now, applyProjectileSpawn);

    const turretShieldSpheresEnabled = getServerShieldsEnabled();
    setTurretShieldSpheresEnabledForPrediction(turretShieldSpheresEnabled);

    let beamPathsChanged = false;
    for (const id of activeBeamPathIds) {
      const entity = entities.get(id);
      if (entity === undefined || entity.projectile === null || !isLineProjectileEntity(entity)) {
        const beamTarget = beamPathTargets.get(id);
        if (beamTarget !== undefined) shrinkBeamPoints(beamTarget.points, 0);
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
      noteTargetAge(targetAgeStats, beamTarget === undefined ? undefined : beamTarget.updatedAtMs, now);
      if (
        beamTarget &&
        applyBeamPathPrediction(
          entity,
          beamTarget,
          deltaMs,
          beamPosBlend,
          movVelBlend,
          predictionMode,
        )
      ) {
        beamPathsChanged = true;
        updateProjectileRenderSpatialIndex(entity);
        // Beam-directed barrels (turretBarrelFollowsBeam) are posed from
        // this path by the turret-pose passes, and the building renderer
        // only re-poses dirty rows — so a moved beam must dirty its
        // emitting host or a tower's barrel freezes mid-sweep.
        markBeamHostRenderDirty(entity);
      }
    }
    if (beamPathsChanged) markLineProjectilesChanged();

    const unitPredictionEntities = this.unitPredictionEntities;
    const unitPredictionTargets = this.unitPredictionTargets;
    const entitySettlementIds = this.entitySettlementIds;
    unitPredictionEntities.length = 0;
    unitPredictionTargets.length = 0;
    entitySettlementIds.length = 0;

    for (const id of activeEntityPredictionIds) {
      const entity = entities.get(id);
      if (entity === undefined || (entity.unit === null && entity.combat === null)) {
        activeEntityPredictionIds.delete(id);
        predictionCadence.clear(id);
        continue;
      }

      const target = serverTargets.get(id);
      noteTargetAge(targetAgeStats, target === undefined ? undefined : target.updatedAtMs, now);
      if (entity.unit) {
        unitPredictionEntities.push(entity);
        unitPredictionTargets.push(target);
        dirtyUnitRenderIds.add(id);
      }
      if (entity.combat && entity.combat.turrets.length > 0) {
        const predictionStep = predictionCadence.consumeDelta(deltaMs);
        applyClientCombatExpensivePrediction({
          entity,
          target,
          predictionStep,
          turretShieldSpheresEnabled,
        });
      }

      entitySettlementIds.push(id);
    }

    applyClientUnitVisualPredictionBatch({
      entities: unitPredictionEntities,
      targets: unitPredictionTargets,
      supportEntities: supportSurfaceEntities,
      deltaMs,
      mapWidth,
      mapHeight,
    });

    for (let i = 0; i < entitySettlementIds.length; i++) {
      const id = entitySettlementIds[i];
      const entity = entities.get(id);
      if (entity === undefined || (entity.unit === null && entity.combat === null)) {
        activeEntityPredictionIds.delete(id);
        predictionCadence.clear(id);
        continue;
      }
      const target = serverTargets.get(id);
      if (clientUnitPredictionIsSettled(entity, target, turretShieldSpheresEnabled)) {
        activeEntityPredictionIds.delete(id);
        predictionCadence.clear(id);
      }
    }

    for (const id of activeProjectilePredictionIds) {
      const entity = entities.get(id);
      if (entity === undefined || entity.projectile === null) {
        activeProjectilePredictionIds.delete(id);
        continue;
      }

      const target = serverTargets.get(id);
      const projectileTarget = entity.projectile.config.shotProfile.runtime.isRocketLike === true
        ? target
        : undefined;
      if (target !== undefined && projectileTarget === undefined) {
        serverTargets.delete(id);
      }
      noteTargetAge(
        targetAgeStats,
        projectileTarget === undefined ? undefined : projectileTarget.updatedAtMs,
        now,
      );
      const predictionStep = predictionCadence.consumeDelta(deltaMs);

      const projectileResult = applyClientProjectilePrediction({
        entity,
        predictionStep,
        target: projectileTarget,
        movPosBlend,
        movVelBlend,
        mapWidth,
        mapHeight,
        getEntity: (entityId) => entities.get(entityId),
      });
      if (projectileResult.becameLineProjectile) {
        activeBeamPathIds.add(id);
        activeProjectilePredictionIds.delete(id);
        serverTargets.delete(id);
        updateProjectileRenderSpatialIndex(entity);
        markLineProjectilesChanged();
        markBeamHostRenderDirty(entity);
        continue;
      }
      if (projectileResult.shouldDelete) {
        deleteEntityLocalState(entity.id);
      } else {
        if (projectileResult.targetSettled) serverTargets.delete(id);
        updateProjectileRenderSpatialIndex(entity);
      }
    }
    return targetAgeStats;
  }
}

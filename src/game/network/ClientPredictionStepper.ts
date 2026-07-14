import {
  getMovementPosEmaMode,
  getMovementVelEmaMode,
  getRotationPosEmaMode,
  getRotationVelEmaMode,
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
import {
  applyClientProjectileMotionBatch,
  type ClientProjectileMotionItem,
} from './ClientProjectileMotion';
import type { ClientProjectileMotionResult } from './ClientProjectileMotion';
import type { ProjectileSpawnQueue } from './ProjectileSpawnQueue';
import type { NetworkServerSnapshotProjectileSpawn } from './NetworkManager';
import {
  type BeamPathTarget,
  ensureBeamPoint,
  shrinkBeamPoints,
  snapBeamPathDisplayToTarget,
  type ServerTarget,
} from './ClientPredictionTargets';
import { isLineProjectileEntity } from './ClientProjectileUtils';
import type { ClientPredictionTargetAgeStats } from './ClientPredictionDiagnostics';

// Reused per-frame work + result buffers for projectile EMA application.
// Never shrunk, so the render loop does not allocate per frame.
const _projectileMotionItems: ClientProjectileMotionItem[] = [];
const _projectileMotionResults: ClientProjectileMotionResult[] = [];
const _projectileMotionIds: EntityId[] = [];
function ensureProjectileMotionItem(i: number): ClientProjectileMotionItem {
  let item = _projectileMotionItems[i];
  if (item === undefined) {
    item = { entity: null as unknown as Entity, target: undefined };
    _projectileMotionItems[i] = item;
  }
  return item;
}

type ClientPredictionStepperOptions = {
  entities: Map<EntityId, Entity>;
  serverTargets: Map<EntityId, ServerTarget>;
  beamPathTargets: Map<EntityId, BeamPathTarget>;
  projectileSpawns: ProjectileSpawnQueue;
  predictionCadence: ClientPredictionCadence;
  activeEntityPredictionIds: Set<EntityId>;
  activeProjectileMotionIds: Set<EntityId>;
  activeBeamPathIds: Set<EntityId>;
  dirtyUnitRenderIds: Set<EntityId>;
  supportSurfaceEntities: readonly Entity[];
  getMapWidth: () => number;
  getMapHeight: () => number;
  getServerShieldsEnabled: () => boolean;
  setTurretShieldSpheresEnabledForPrediction: (enabled: boolean) => void;
  applyProjectileSpawn: (spawn: NetworkServerSnapshotProjectileSpawn) => boolean;
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

function copyBeamPointStateAtPosition(
  dst: BeamPoint,
  src: BeamPoint,
  x: number,
  y: number,
  z: number,
): void {
  dst.x = x; dst.y = y; dst.z = z;
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

function applyBeamPathMotion(
  entity: Entity,
  target: BeamPathTarget,
  movPosBlend: number,
  movVelBlend: number,
): boolean {
  const proj = entity.projectile;
  if (!proj) return false;
  const tgtPts = target.points;
  if (tgtPts.length === 0) return false;
  if (target.initialSnapPending) {
    target.initialSnapPending = false;
    return snapBeamPathDisplayToTarget(entity, target);
  }

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

  for (let i = 0; i < tgtPts.length; i++) {
    const tp = tgtPts[i];
    const targetIsReflector = beamPointIsReflector(tp);
    const targetX = tp.x;
    const targetY = tp.y;
    const targetZ = tp.z;
    let pp = projPts[i];
    const isNewPoint = !pp || i >= oldLen;
    if (isNewPoint) {
      pp = ensureBeamPoint(projPts, i);
      if (targetIsReflector || !hasOldLastPointSeed) {
        copyBeamPointStateAtPosition(pp, tp, targetX, targetY, targetZ);
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
      copyBeamPointStateAtPosition(pp, tp, targetX, targetY, targetZ);
      changed = true;
      continue;
    } else if (targetIsReflector) {
      if (beamPointStateDiffers(pp, tp)) changed = true;
      copyBeamPointState(pp, tp);
      continue;
    }
    const px = pp.x, py = pp.y, pz = pp.z;
    const nx = movPosBlend < 0 ? px : lerp(px, targetX, movPosBlend);
    const ny = movPosBlend < 0 ? py : lerp(py, targetY, movPosBlend);
    const nz = movPosBlend < 0 ? pz : lerp(pz, targetZ, movPosBlend);
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
  private readonly entitySettlementEntities: Entity[] = [];
  private readonly entitySettlementTargets: Array<ServerTarget | undefined> = [];

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
      activeProjectileMotionIds,
      activeBeamPathIds,
      dirtyUnitRenderIds,
      supportSurfaceEntities,
      getMapWidth,
      getMapHeight,
      getServerShieldsEnabled,
      setTurretShieldSpheresEnabledForPrediction,
      applyProjectileSpawn,
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
    // Beam vertices are paired motion state: their position rides the
    // movement-position channel and their velocity rides movement-velocity,
    // exactly like a unit body center (budget_design_philosophy.html "What
    // each EMA channel applies to" — proj.points[i].x/y/z are movement
    // position, .vx/vy/vz are movement velocity). One channel must drive
    // every field it owns, so both blends come from the movement knobs.
    const movPosBlend = getChannelBlend(getMovementPosEmaMode(), deltaMs / 1000);
    const movVelBlend = getChannelBlend(getMovementVelEmaMode(), deltaMs / 1000);
    const rotPosBlend = getChannelBlend(getRotationPosEmaMode(), deltaMs / 1000);
    const rotVelBlend = getChannelBlend(getRotationVelEmaMode(), deltaMs / 1000);
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

      const beamTarget = beamPathTargets.get(id);
      noteTargetAge(targetAgeStats, beamTarget === undefined ? undefined : beamTarget.updatedAtMs, now);
      if (
        beamTarget &&
        applyBeamPathMotion(
          entity,
          beamTarget,
          movPosBlend,
          movVelBlend,
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
    const entitySettlementEntities = this.entitySettlementEntities;
    const entitySettlementTargets = this.entitySettlementTargets;
    unitPredictionEntities.length = 0;
    unitPredictionTargets.length = 0;
    entitySettlementEntities.length = 0;
    entitySettlementTargets.length = 0;

    for (const id of activeEntityPredictionIds) {
      const entity = entities.get(id);
      if (entity === undefined || (entity.unit === null && entity.combat === null)) {
        activeEntityPredictionIds.delete(id);
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

      entitySettlementEntities.push(entity);
      entitySettlementTargets.push(target);
    }

    applyClientUnitVisualPredictionBatch({
      entities: unitPredictionEntities,
      targets: unitPredictionTargets,
      supportEntities: supportSurfaceEntities,
      deltaMs,
      mapWidth,
      mapHeight,
    });

    for (let i = 0; i < entitySettlementEntities.length; i++) {
      const entity = entitySettlementEntities[i];
      const id = entity.id;
      if (entity.unit === null && entity.combat === null) {
        activeEntityPredictionIds.delete(id);
        continue;
      }
      const target = entitySettlementTargets[i];
      if (clientUnitPredictionIsSettled(entity, target, turretShieldSpheresEnabled)) {
        activeEntityPredictionIds.delete(id);
      }
    }

    // Every traveling projectile follows the same four authoritative motion
    // targets. No shot family runs render-side physics or homing.
    let projectileItemCount = 0;
    const projectileIds = _projectileMotionIds;
    projectileIds.length = 0;
    for (const id of activeProjectileMotionIds) {
      const entity = entities.get(id);
      if (entity === undefined || entity.projectile === null) {
        activeProjectileMotionIds.delete(id);
        continue;
      }

      const target = serverTargets.get(id);
      noteTargetAge(
        targetAgeStats,
        target === undefined ? undefined : target.updatedAtMs,
        now,
      );
      const item = ensureProjectileMotionItem(projectileItemCount);
      item.entity = entity;
      item.target = target;
      projectileIds[projectileItemCount] = id;
      projectileItemCount++;
    }

    if (projectileItemCount > 0) {
      _projectileMotionItems.length = projectileItemCount;
      const projectileResults = applyClientProjectileMotionBatch({
        items: _projectileMotionItems,
        movPosBlend,
        movVelBlend,
        rotPosBlend,
        rotVelBlend,
        out: _projectileMotionResults,
      });
      for (let i = 0; i < projectileItemCount; i++) {
        const id = projectileIds[i];
        const entity = _projectileMotionItems[i].entity;
        const projectileResult = projectileResults[i];
        if (projectileResult.targetSettled) serverTargets.delete(id);
        updateProjectileRenderSpatialIndex(entity);
      }
    }
    return targetAgeStats;
  }
}

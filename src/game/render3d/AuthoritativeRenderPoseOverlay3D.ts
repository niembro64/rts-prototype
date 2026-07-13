import type { AuthoritativeRenderSource } from '@/types/game';
import type { BeamPoint } from '@/types/sim';
import { LOCKSTEP_FIXED_DT_MS } from '../architecture/LockstepFrameScheduler';
import { lerp, lerpAngle } from '../math';
import type { Entity, EntityId, Turret } from '../sim/types';
import type { FootprintBounds } from '../ViewportFootprint';
import { spatialGrid } from '../sim/SpatialGrid';
import {
  ensureBeamPoint,
  shrinkBeamPoints,
} from '../network/ClientPredictionTargets';
import type { ClientProjectileRenderLists } from '../network/ClientProjectileStore';
import { getBuildingCombatCenterZ } from '../sim/buildingAnchors';
import {
  getConstructionPieceOpacity,
  getConstructionPieceRenderFraction,
  isBuildInProgress,
} from '../sim/buildableHelpers';
import { getUnitGroundZ } from '../sim/unitGeometry';
import {
  CLIENT_RENDER_ENTITY_KIND_BUILDING,
  CLIENT_RENDER_ENTITY_KIND_UNIT,
  type ClientRenderEntityStateViews,
} from './ClientRenderEntityStateSlab';

type BeamPointCopyResult = {
  points: BeamPoint[] | null;
  changed: boolean;
};

type AuthoritativeProjectileRenderLists = {
  traveling: readonly Entity[];
  smokeTrail: readonly Entity[];
  line: readonly Entity[];
  burnMark: readonly Entity[];
};

export type AuthoritativeRenderUnitState3D = {
  kind: 'unit';
  x: number;
  y: number;
  z: number;
  rotation: number;
  groundY: number;
  normalX: number;
  normalY: number;
  normalZ: number;
  velocityX: number;
  velocityY: number;
  yawRate: number;
  bodyOpacity: number;
  bodyCenterHeight: number;
  turrets: readonly Turret[] | undefined;
};

export type AuthoritativeRenderBuildingState3D = {
  kind: 'building';
  x: number;
  y: number;
  rotation: number;
  combatCenterZ: number;
  baseY: number;
  progress: number;
  bodyOpacity: number;
  turrets: readonly Turret[] | undefined;
};

export type AuthoritativeRenderEntityState3D =
  | AuthoritativeRenderUnitState3D
  | AuthoritativeRenderBuildingState3D;

type EntityPoseSample = {
  currTick: number;
  hasPrev: boolean;
  lastSeenFrame: number;
  prevX: number;
  prevY: number;
  prevZ: number;
  prevRotation: number;
  prevGroundY: number;
  prevNormalX: number;
  prevNormalY: number;
  prevNormalZ: number;
  prevBodyOpacity: number;
  prevBodyCenterHeight: number;
  prevBuildingBaseY: number;
  prevBuildingProgress: number;
  currX: number;
  currY: number;
  currZ: number;
  currRotation: number;
  currGroundY: number;
  currNormalX: number;
  currNormalY: number;
  currNormalZ: number;
  currVelocityX: number;
  currVelocityY: number;
  currYawRate: number;
  currBodyOpacity: number;
  currBodyCenterHeight: number;
  currBuildingBaseY: number;
  currBuildingProgress: number;
  prevTurretCount: number;
  currTurretCount: number;
  prevTurretRotation: number[];
  prevTurretPitch: number[];
  currTurretRotation: number[];
  currTurretPitch: number[];
  appliedFrame: number;
};

const STALE_SAMPLE_FRAME_LIMIT = 240;
const STALE_SAMPLE_PRUNE_STRIDE = 120;

function createPoseSample(): EntityPoseSample {
  return {
    currTick: -1,
    hasPrev: false,
    lastSeenFrame: 0,
    prevX: 0,
    prevY: 0,
    prevZ: 0,
    prevRotation: 0,
    prevGroundY: 0,
    prevNormalX: 0,
    prevNormalY: 0,
    prevNormalZ: 1,
    prevBodyOpacity: 1,
    prevBodyCenterHeight: 0,
    prevBuildingBaseY: 0,
    prevBuildingProgress: 1,
    currX: 0,
    currY: 0,
    currZ: 0,
    currRotation: 0,
    currGroundY: 0,
    currNormalX: 0,
    currNormalY: 0,
    currNormalZ: 1,
    currVelocityX: 0,
    currVelocityY: 0,
    currYawRate: 0,
    currBodyOpacity: 1,
    currBodyCenterHeight: 0,
    currBuildingBaseY: 0,
    currBuildingProgress: 1,
    prevTurretCount: 0,
    currTurretCount: 0,
    prevTurretRotation: [],
    prevTurretPitch: [],
    currTurretRotation: [],
    currTurretPitch: [],
    appliedFrame: -1,
  };
}

function copyCurrentToPrevious(sample: EntityPoseSample): void {
  sample.prevX = sample.currX;
  sample.prevY = sample.currY;
  sample.prevZ = sample.currZ;
  sample.prevRotation = sample.currRotation;
  sample.prevGroundY = sample.currGroundY;
  sample.prevNormalX = sample.currNormalX;
  sample.prevNormalY = sample.currNormalY;
  sample.prevNormalZ = sample.currNormalZ;
  sample.prevBodyOpacity = sample.currBodyOpacity;
  sample.prevBodyCenterHeight = sample.currBodyCenterHeight;
  sample.prevBuildingBaseY = sample.currBuildingBaseY;
  sample.prevBuildingProgress = sample.currBuildingProgress;
  sample.prevTurretCount = sample.currTurretCount;
  sample.prevTurretRotation.length = sample.currTurretCount;
  sample.prevTurretPitch.length = sample.currTurretCount;
  for (let i = 0; i < sample.currTurretCount; i++) {
    sample.prevTurretRotation[i] = sample.currTurretRotation[i];
    sample.prevTurretPitch[i] = sample.currTurretPitch[i];
  }
}

function readUnitPose(sample: EntityPoseSample, entity: Entity): void {
  const unit = entity.unit;
  if (unit === null) return;
  sample.currX = entity.transform.x;
  sample.currY = entity.transform.y;
  sample.currZ = entity.transform.z;
  sample.currRotation = entity.transform.rotation;
  sample.currGroundY = getUnitGroundZ(entity);
  sample.currNormalX = unit.surfaceNormal.nx;
  sample.currNormalY = unit.surfaceNormal.ny;
  sample.currNormalZ = unit.surfaceNormal.nz;
  sample.currVelocityX = unit.velocityX;
  sample.currVelocityY = unit.velocityY;
  sample.currYawRate = unit.angularVelocity3?.z ?? 0;
  sample.currBodyOpacity = getConstructionPieceOpacity(entity, 'body');
  sample.currBodyCenterHeight = unit.bodyCenterHeight;
  sample.currBuildingBaseY = 0;
  sample.currBuildingProgress = 1;
  readTurretPose(sample, entity);
}

function readBuildingPose(sample: EntityPoseSample, entity: Entity): void {
  const building = entity.building;
  if (building === null) return;
  sample.currX = entity.transform.x;
  sample.currY = entity.transform.y;
  sample.currZ = getBuildingCombatCenterZ(entity);
  sample.currRotation = entity.transform.rotation;
  sample.currGroundY = 0;
  sample.currNormalX = 0;
  sample.currNormalY = 0;
  sample.currNormalZ = 1;
  sample.currVelocityX = 0;
  sample.currVelocityY = 0;
  sample.currYawRate = 0;
  sample.currBodyOpacity = getConstructionPieceOpacity(entity, 'body');
  sample.currBodyCenterHeight = 0;
  sample.currBuildingBaseY = entity.transform.z - building.depth / 2;
  sample.currBuildingProgress = getConstructionPieceRenderFraction(entity, 'body');
  readTurretPose(sample, entity);
}

function readProjectilePose(sample: EntityPoseSample, entity: Entity): void {
  const projectile = entity.projectile;
  if (projectile === null) return;
  sample.currX = entity.transform.x;
  sample.currY = entity.transform.y;
  sample.currZ = entity.transform.z;
  sample.currRotation = entity.transform.rotation;
  sample.currGroundY = 0;
  sample.currNormalX = 0;
  sample.currNormalY = 0;
  sample.currNormalZ = 1;
  sample.currVelocityX = projectile.velocityX;
  sample.currVelocityY = projectile.velocityY;
  sample.currYawRate = projectile.velocityZ;
  sample.currBodyOpacity = 1;
  sample.currBodyCenterHeight = 0;
  sample.currBuildingBaseY = 0;
  sample.currBuildingProgress = 1;
  sample.currTurretCount = 0;
  sample.currTurretRotation.length = 0;
  sample.currTurretPitch.length = 0;
}

function readTurretPose(sample: EntityPoseSample, entity: Entity): void {
  const turrets = entity.combat?.turrets;
  const count = turrets?.length ?? 0;
  sample.currTurretCount = count;
  sample.currTurretRotation.length = count;
  sample.currTurretPitch.length = count;
  if (turrets === undefined) return;
  for (let i = 0; i < count; i++) {
    const turret = turrets[i];
    sample.currTurretRotation[i] = turret.rotation;
    sample.currTurretPitch[i] = turret.pitch;
  }
}

function authoritativeProjectileOverlapsBounds(
  entity: Entity,
  bounds: FootprintBounds | null,
): boolean {
  if (bounds === null) return true;
  const projectile = entity.projectile;
  if (projectile === null) return false;
  const points = projectile.points;
  if (points !== null && points.length > 0) {
    let minX = entity.transform.x;
    let maxX = entity.transform.x;
    let minY = entity.transform.y;
    let maxY = entity.transform.y;
    for (let i = 0; i < points.length; i++) {
      const point = points[i];
      if (point.x < minX) minX = point.x;
      if (point.x > maxX) maxX = point.x;
      if (point.y < minY) minY = point.y;
      if (point.y > maxY) maxY = point.y;
    }
    return (
      maxX >= bounds.minX &&
      minX <= bounds.maxX &&
      maxY >= bounds.minY &&
      minY <= bounds.maxY
    );
  }
  return (
    entity.transform.x >= bounds.minX &&
    entity.transform.x <= bounds.maxX &&
    entity.transform.y >= bounds.minY &&
    entity.transform.y <= bounds.maxY
  );
}

function pushAuthoritativeProjectileRenderLists(
  entity: Entity,
  out: ClientProjectileRenderLists,
): void {
  const projectile = entity.projectile;
  if (projectile === null) return;
  if (projectile.projectileType === 'projectile') {
    out.traveling.push(entity);
    if (projectile.config.shotProfile.visual.smokeTrail !== undefined) {
      out.smokeTrail.push(entity);
    }
    if (entity.dgunProjectile?.isDGun === true) {
      out.burnMark.push(entity);
    }
    return;
  }
  out.line.push(entity);
  out.burnMark.push(entity);
}

function pushAuthoritativeTravelingProjectileRenderLists(
  entity: Entity,
  out: ClientProjectileRenderLists,
): void {
  const projectile = entity.projectile;
  if (projectile === null || projectile.projectileType !== 'projectile') return;
  out.traveling.push(entity);
  if (projectile.config.shotProfile.visual.smokeTrail !== undefined) {
    out.smokeTrail.push(entity);
  }
  if (entity.dgunProjectile?.isDGun === true) {
    out.burnMark.push(entity);
  }
}

function pushAuthoritativeLineProjectileRenderLists(
  entity: Entity,
  out: ClientProjectileRenderLists,
): void {
  const projectile = entity.projectile;
  if (projectile === null || projectile.projectileType === 'projectile') return;
  out.line.push(entity);
  out.burnMark.push(entity);
}

function copyBeamPoint(dst: BeamPoint, src: BeamPoint): boolean {
  const changed =
    dst.x !== src.x ||
    dst.y !== src.y ||
    dst.z !== src.z ||
    dst.vx !== src.vx ||
    dst.vy !== src.vy ||
    dst.vz !== src.vz ||
    dst.reflectorEntityId !== src.reflectorEntityId ||
    dst.reflectorKind !== src.reflectorKind ||
    dst.reflectorPlayerId !== src.reflectorPlayerId ||
    dst.normalX !== src.normalX ||
    dst.normalY !== src.normalY ||
    dst.normalZ !== src.normalZ;
  dst.x = src.x;
  dst.y = src.y;
  dst.z = src.z;
  dst.vx = src.vx;
  dst.vy = src.vy;
  dst.vz = src.vz;
  dst.reflectorEntityId = src.reflectorEntityId;
  dst.reflectorKind = src.reflectorKind;
  dst.reflectorPlayerId = src.reflectorPlayerId;
  dst.normalX = src.normalX;
  dst.normalY = src.normalY;
  dst.normalZ = src.normalZ;
  return changed;
}

function copyBeamPoints(
  dst: BeamPoint[] | null,
  src: readonly BeamPoint[] | null,
): BeamPointCopyResult {
  if (src === null) {
    const changed = dst !== null && dst.length > 0;
    if (dst !== null) shrinkBeamPoints(dst, 0);
    return { points: null, changed };
  }
  const out = dst ?? [];
  let changed = dst === null || dst.length !== src.length;
  shrinkBeamPoints(out, src.length);
  for (let i = 0; i < src.length; i++) {
    if (copyBeamPoint(ensureBeamPoint(out, i), src[i])) changed = true;
  }
  return { points: out, changed };
}

function setPresentationRotation(entity: Entity, rotation: number): void {
  entity.transform.rotation = rotation;
  entity.transform.rotCos = null;
  entity.transform.rotSin = null;
}

function buildingHasDynamicAuthoritativeRenderState(entity: Entity): boolean {
  if ((entity.combat?.turrets.length ?? 0) > 0) return true;
  if (isBuildInProgress(entity.buildable)) return true;
  return (
    getConstructionPieceOpacity(entity, 'body') < 1 ||
    getConstructionPieceRenderFraction(entity, 'body') < 1
  );
}

function advanceSample(
  sample: EntityPoseSample,
  entity: Entity,
  tick: number,
  unit: boolean,
): void {
  if (sample.currTick === tick) return;
  const consecutive = tick - sample.currTick === 1;
  if (consecutive) copyCurrentToPrevious(sample);
  if (unit) {
    readUnitPose(sample, entity);
  } else {
    readBuildingPose(sample, entity);
  }
  sample.hasPrev = consecutive;
  sample.currTick = tick;
}

function advanceProjectileSample(sample: EntityPoseSample, entity: Entity, tick: number): void {
  if (sample.currTick === tick) return;
  const consecutive = tick - sample.currTick === 1;
  if (consecutive) copyCurrentToPrevious(sample);
  readProjectilePose(sample, entity);
  sample.hasPrev = consecutive;
  sample.currTick = tick;
}

function sampleForEntity(
  samples: Map<EntityId, EntityPoseSample>,
  entity: Entity,
  tick: number,
  frame: number,
  unit: boolean,
): EntityPoseSample {
  let sample = samples.get(entity.id);
  if (sample === undefined) {
    sample = createPoseSample();
    samples.set(entity.id, sample);
  }
  sample.lastSeenFrame = frame;
  advanceSample(sample, entity, tick, unit);
  return sample;
}

function sampleForUnitEntity(
  samples: Map<EntityId, EntityPoseSample>,
  entity: Entity,
  tick: number,
  frame: number,
): EntityPoseSample {
  let sample = samples.get(entity.id);
  if (sample !== undefined) {
    sample.lastSeenFrame = frame;
    advanceSample(sample, entity, tick, true);
    return sample;
  }

  sample = createPoseSample();
  samples.set(entity.id, sample);
  sample.lastSeenFrame = frame;
  advanceSample(sample, entity, tick, true);
  return sample;
}

function sampleForProjectile(
  samples: Map<EntityId, EntityPoseSample>,
  entity: Entity,
  tick: number,
  frame: number,
): EntityPoseSample {
  let sample = samples.get(entity.id);
  if (sample === undefined) {
    sample = createPoseSample();
    samples.set(entity.id, sample);
  }
  sample.lastSeenFrame = frame;
  advanceProjectileSample(sample, entity, tick);
  return sample;
}

function interpolationAlpha(sample: EntityPoseSample, frameAlpha: number): number {
  return sample.hasPrev ? frameAlpha : 1;
}

function unitStateFromSample(
  sample: EntityPoseSample,
  t: number,
  turrets: readonly Turret[] | undefined,
  out: AuthoritativeRenderUnitState3D,
): AuthoritativeRenderUnitState3D {
  out.x = lerp(sample.prevX, sample.currX, t);
  out.y = lerp(sample.prevY, sample.currY, t);
  out.z = lerp(sample.prevZ, sample.currZ, t);
  out.rotation = lerpAngle(sample.prevRotation, sample.currRotation, t);
  out.groundY = lerp(sample.prevGroundY, sample.currGroundY, t);
  out.normalX = lerp(sample.prevNormalX, sample.currNormalX, t);
  out.normalY = lerp(sample.prevNormalY, sample.currNormalY, t);
  out.normalZ = lerp(sample.prevNormalZ, sample.currNormalZ, t);
  // Velocity and yaw-rate are derivative inputs for animation/effects, not
  // poses. Copy the current authoritative values directly so we avoid
  // smoothing stale rates into the rendered frame.
  out.velocityX = sample.currVelocityX;
  out.velocityY = sample.currVelocityY;
  out.yawRate = sample.currYawRate;
  out.bodyOpacity = lerp(sample.prevBodyOpacity, sample.currBodyOpacity, t);
  out.bodyCenterHeight = lerp(sample.prevBodyCenterHeight, sample.currBodyCenterHeight, t);
  out.turrets = turrets;
  return out;
}

function buildingStateFromSample(
  sample: EntityPoseSample,
  t: number,
  turrets: readonly Turret[] | undefined,
  out: AuthoritativeRenderBuildingState3D,
): AuthoritativeRenderBuildingState3D {
  out.x = lerp(sample.prevX, sample.currX, t);
  out.y = lerp(sample.prevY, sample.currY, t);
  out.rotation = lerpAngle(sample.prevRotation, sample.currRotation, t);
  out.combatCenterZ = lerp(sample.prevZ, sample.currZ, t);
  out.baseY = lerp(sample.prevBuildingBaseY, sample.currBuildingBaseY, t);
  out.progress = lerp(sample.prevBuildingProgress, sample.currBuildingProgress, t);
  out.bodyOpacity = lerp(sample.prevBodyOpacity, sample.currBodyOpacity, t);
  out.turrets = turrets;
  return out;
}

function pruneStaleSamples(
  samples: Map<EntityId, { lastSeenFrame: number }>,
  frame: number,
): void {
  if (frame % STALE_SAMPLE_PRUNE_STRIDE !== 0) return;
  const staleBefore = frame - STALE_SAMPLE_FRAME_LIMIT;
  for (const [id, sample] of samples) {
    if (sample.lastSeenFrame < staleBefore) samples.delete(id);
  }
}

export class AuthoritativeRenderPoseOverlay3D {
  private readonly samples = new Map<EntityId, EntityPoseSample>();
  private lastTick = -1;
  private tickElapsedMs = 0;
  private frame = 0;
  private frameSource: AuthoritativeRenderSource | null = null;
  private frameTick = 0;
  private frameAlpha = 1;
  private readonly unitStateScratch: AuthoritativeRenderUnitState3D = {
    kind: 'unit',
    x: 0,
    y: 0,
    z: 0,
    rotation: 0,
    groundY: 0,
    normalX: 0,
    normalY: 0,
    normalZ: 1,
    velocityX: 0,
    velocityY: 0,
    yawRate: 0,
    bodyOpacity: 1,
    bodyCenterHeight: 0,
    turrets: undefined,
  };
  private readonly buildingStateScratch: AuthoritativeRenderBuildingState3D = {
    kind: 'building',
    x: 0,
    y: 0,
    rotation: 0,
    combatCenterZ: 0,
    baseY: 0,
    progress: 1,
    bodyOpacity: 1,
    turrets: undefined,
  };

  constructor(private readonly getSource: () => AuthoritativeRenderSource | null) {}

  isEnabled(): boolean {
    return this.getSource() !== null;
  }

  isFrameActive(): boolean {
    return this.frameSource !== null;
  }

  getFrameContentVersion(): number {
    return this.frameSource !== null ? this.frameTick : -1;
  }

  beginFrame(deltaMs: number): boolean {
    const source = this.getSource();
    if (source === null) {
      this.tickElapsedMs = 0;
      this.lastTick = -1;
      this.frameSource = null;
      this.frameTick = 0;
      this.frameAlpha = 1;
      return false;
    }

    this.frame = (this.frame + 1) & 0x3fffffff;
    const tick = source.getTick();
    if (tick !== this.lastTick) {
      this.lastTick = tick;
      this.tickElapsedMs = 0;
    } else if (Number.isFinite(deltaMs) && deltaMs > 0) {
      this.tickElapsedMs += deltaMs;
    }
    this.frameSource = source;
    this.frameTick = tick;
    this.frameAlpha = Math.max(0, Math.min(1, this.tickElapsedMs / LOCKSTEP_FIXED_DT_MS));
    return true;
  }

  applyVisibleEntities(
    entities: readonly Entity[],
    refreshEntity: (entity: Entity, state: AuthoritativeRenderEntityState3D) => void,
  ): void {
    const source = this.frameSource;
    if (source === null) return;
    for (let i = 0; i < entities.length; i++) {
      const entity = entities[i];
      const sourceEntity = source.world.getEntity(entity.id);
      if (sourceEntity === undefined) continue;
      if (entity.unit !== null && sourceEntity.unit !== null) {
        const state = this.applyUnitEntity(entity, sourceEntity);
        if (state !== null) refreshEntity(entity, state);
      } else if (entity.building !== null && sourceEntity.building !== null) {
        if (
          !buildingHasDynamicAuthoritativeRenderState(entity) &&
          !buildingHasDynamicAuthoritativeRenderState(sourceEntity)
        ) {
          continue;
        }
        const state = this.applyBuildingEntity(entity, sourceEntity);
        if (state !== null) refreshEntity(entity, state);
      }
    }
  }

  applyScopedEntities(
    bounds: FootprintBounds | null,
    candidateUnits: readonly Entity[],
    candidateBuildings: readonly Entity[],
    lookupClientEntity: (id: EntityId) => Entity | undefined,
    refreshEntity: (entity: Entity, state: AuthoritativeRenderEntityState3D) => void,
  ): void {
    const source = this.frameSource;
    if (source === null) return;

    // First refresh entities that the client render index currently thinks
    // are in scope. This moves stale rows out before the final scoped query.
    this.applyClientEntityList(candidateUnits, source, refreshEntity);
    this.applyClientEntityList(candidateBuildings, source, refreshEntity);

    if (bounds === null) return;

    // Then refresh entities the authoritative sim says are currently in
    // scope. Mapping back through the client view preserves visibility/fog.
    const scoped = spatialGrid.queryUnitsAndBuildingsInRect2D(
      bounds.minX,
      bounds.maxX,
      bounds.minY,
      bounds.maxY,
    );
    this.applyAuthoritativeEntityList(
      scoped.units,
      lookupClientEntity,
      refreshEntity,
    );
    this.applyAuthoritativeEntityList(
      scoped.buildings,
      lookupClientEntity,
      refreshEntity,
    );
  }

  applyScopedEntitySlots(
    bounds: FootprintBounds | null,
    candidateUnitSlots: readonly number[],
    candidateBuildingSlots: readonly number[],
    views: ClientRenderEntityStateViews,
    slotForEntityId: (id: EntityId) => number | undefined,
    refreshSlot: (slot: number, state: AuthoritativeRenderEntityState3D) => void,
  ): void {
    const source = this.frameSource;
    if (source === null) return;

    this.applyClientUnitSlots(candidateUnitSlots, views, source, refreshSlot);
    this.applyClientBuildingSlots(candidateBuildingSlots, views, source, refreshSlot);
    if (bounds === null) return;

    const scoped = spatialGrid.queryUnitsAndBuildingsInRect2D(
      bounds.minX,
      bounds.maxX,
      bounds.minY,
      bounds.maxY,
    );
    this.applyAuthoritativeUnitSlots(
      scoped.units,
      views,
      slotForEntityId,
      refreshSlot,
    );
    this.applyAuthoritativeBuildingSlots(
      scoped.buildings,
      views,
      slotForEntityId,
      refreshSlot,
    );
  }

  collectScopedEntitySlots(
    bounds: FootprintBounds | null,
    views: ClientRenderEntityStateViews,
    slotForEntityId: (id: EntityId) => number | undefined,
    refreshSlot: (slot: number, state: AuthoritativeRenderEntityState3D) => void,
    outUnitSlots: number[],
    outBuildingSlots: number[],
  ): void {
    const source = this.frameSource;
    if (source === null) return;

    const scoped = bounds === null
      ? {
          units: source.world.getUnits(),
          buildings: source.world.getBuildings(),
        }
      : spatialGrid.queryUnitsAndBuildingsInRect2D(
          bounds.minX,
          bounds.maxX,
          bounds.minY,
          bounds.maxY,
        );

    const units = scoped.units;
    for (let i = 0; i < units.length; i++) {
      const sourceEntity = units[i];
      const slot = slotForEntityId(sourceEntity.id);
      if (slot === undefined || views.kind[slot] !== CLIENT_RENDER_ENTITY_KIND_UNIT) continue;
      outUnitSlots.push(slot);
      const state = this.authoritativeUnitState(sourceEntity);
      if (state !== null) refreshSlot(slot, state);
    }

    const buildings = scoped.buildings;
    for (let i = 0; i < buildings.length; i++) {
      const sourceEntity = buildings[i];
      const slot = slotForEntityId(sourceEntity.id);
      if (slot === undefined || views.kind[slot] !== CLIENT_RENDER_ENTITY_KIND_BUILDING) continue;
      outBuildingSlots.push(slot);
      if (!buildingHasDynamicAuthoritativeRenderState(sourceEntity)) continue;
      const state = this.authoritativeBuildingState(sourceEntity);
      if (state !== null) refreshSlot(slot, state);
    }
  }

  applyVisibleProjectiles(
    projectiles: readonly Entity[],
    refreshProjectile: (entity: Entity, lineGeometryChanged: boolean) => void,
  ): void {
    const source = this.frameSource;
    if (source === null) return;
    for (let i = 0; i < projectiles.length; i++) {
      const entity = projectiles[i];
      if (entity.projectile === null) continue;
      const sourceEntity = source.world.getEntity(entity.id);
      if (sourceEntity === undefined || sourceEntity.projectile === null) continue;
      const lineGeometryChanged = this.applyProjectileEntity(entity, sourceEntity);
      if (lineGeometryChanged !== null) refreshProjectile(entity, lineGeometryChanged);
    }
  }

  applyScopedProjectiles(
    bounds: FootprintBounds | null,
    candidateLists: AuthoritativeProjectileRenderLists,
    lookupClientEntity: (id: EntityId) => Entity | undefined,
    refreshProjectile: (entity: Entity, lineGeometryChanged: boolean) => void,
  ): void {
    const source = this.frameSource;
    if (source === null) return;

    this.applyClientProjectileList(candidateLists.traveling, source, refreshProjectile);
    this.applyClientProjectileList(candidateLists.smokeTrail, source, refreshProjectile);
    this.applyClientProjectileList(candidateLists.line, source, refreshProjectile);
    this.applyClientProjectileList(candidateLists.burnMark, source, refreshProjectile);
    if (bounds === null) return;

    const scopedProjectiles = spatialGrid.queryProjectilesInRect2D(
      bounds.minX,
      bounds.maxX,
      bounds.minY,
      bounds.maxY,
    );
    this.applyAuthoritativeProjectileList(
      scopedProjectiles,
      lookupClientEntity,
      refreshProjectile,
    );
    this.applyAuthoritativeProjectileList(
      source.world.getLineProjectiles(),
      lookupClientEntity,
      refreshProjectile,
    );
  }

  collectProjectileRenderLists(
    bounds: FootprintBounds | null,
    out: ClientProjectileRenderLists,
  ): ClientProjectileRenderLists | null {
    const source = this.frameSource;
    if (source === null) return null;
    out.traveling.length = 0;
    out.smokeTrail.length = 0;
    out.line.length = 0;
    out.burnMark.length = 0;
    if (bounds !== null) {
      const scopedProjectiles = spatialGrid.queryProjectilesInRect2D(
        bounds.minX,
        bounds.maxX,
        bounds.minY,
        bounds.maxY,
      );
      for (let i = 0; i < scopedProjectiles.length; i++) {
        pushAuthoritativeTravelingProjectileRenderLists(scopedProjectiles[i], out);
      }
      const lineProjectiles = source.world.getLineProjectiles();
      for (let i = 0; i < lineProjectiles.length; i++) {
        const entity = lineProjectiles[i];
        if (!authoritativeProjectileOverlapsBounds(entity, bounds)) continue;
        pushAuthoritativeLineProjectileRenderLists(entity, out);
      }
      return out;
    }
    const projectiles = source.world.getProjectiles();
    for (let i = 0; i < projectiles.length; i++) {
      const entity = projectiles[i];
      pushAuthoritativeProjectileRenderLists(entity, out);
    }
    return out;
  }

  endFrame(): void {
    if (this.frameSource === null) return;
    pruneStaleSamples(this.samples, this.frame);
  }

  private applyUnitEntity(
    entity: Entity,
    sourceEntity: Entity,
  ): AuthoritativeRenderUnitState3D | null {
    const sourceUnit = sourceEntity.unit;
    const unit = entity.unit;
    if (sourceUnit === null || unit === null) {
      return {
        kind: 'unit',
        x: entity.transform.x,
        y: entity.transform.y,
        z: entity.transform.z,
        rotation: entity.transform.rotation,
        groundY: getUnitGroundZ(entity),
        normalX: unit?.surfaceNormal.nx ?? 0,
        normalY: unit?.surfaceNormal.ny ?? 0,
        normalZ: unit?.surfaceNormal.nz ?? 1,
        velocityX: unit?.velocityX ?? 0,
        velocityY: unit?.velocityY ?? 0,
        yawRate: unit?.angularVelocity3?.z ?? 0,
        bodyOpacity: getConstructionPieceOpacity(entity, 'body'),
        bodyCenterHeight: unit?.bodyCenterHeight ?? 0,
        turrets: entity.combat?.turrets,
      };
    }
    const sample = sampleForUnitEntity(
      this.samples,
      sourceEntity,
      this.frameTick,
      this.frame,
    );
    if (sample.appliedFrame === this.frame) return null;
    sample.appliedFrame = this.frame;
    const t = interpolationAlpha(sample, this.frameAlpha);
    const state = unitStateFromSample(
      sample,
      t,
      sourceEntity.combat?.turrets,
      this.unitStateScratch,
    );
    entity.transform.x = state.x;
    entity.transform.y = state.y;
    entity.transform.z = state.z;
    setPresentationRotation(entity, state.rotation);
    unit.surfaceNormal.nx = state.normalX;
    unit.surfaceNormal.ny = state.normalY;
    unit.surfaceNormal.nz = state.normalZ;
    unit.velocityX = state.velocityX;
    unit.velocityY = state.velocityY;
    unit.bodyCenterHeight = state.bodyCenterHeight;
    if (unit.angularVelocity3 !== null) {
      unit.angularVelocity3.z = state.yawRate;
    }
    this.applyTurretEntities(entity, sample, t);
    return state;
  }

  private applyBuildingEntity(
    entity: Entity,
    sourceEntity: Entity,
  ): AuthoritativeRenderBuildingState3D | null {
    const building = entity.building;
    if (sourceEntity.building === null || building === null) {
      return {
        kind: 'building',
        x: entity.transform.x,
        y: entity.transform.y,
        rotation: entity.transform.rotation,
        combatCenterZ: getBuildingCombatCenterZ(entity),
        baseY: entity.transform.z - (building?.depth ?? 0) / 2,
        progress: getConstructionPieceRenderFraction(entity, 'body'),
        bodyOpacity: getConstructionPieceOpacity(entity, 'body'),
        turrets: entity.combat?.turrets,
      };
    }
    const sample = sampleForEntity(this.samples, sourceEntity, this.frameTick, this.frame, false);
    if (sample.appliedFrame === this.frame) return null;
    sample.appliedFrame = this.frame;
    const t = interpolationAlpha(sample, this.frameAlpha);
    const state = buildingStateFromSample(
      sample,
      t,
      sourceEntity.combat?.turrets,
      this.buildingStateScratch,
    );
    entity.transform.x = state.x;
    entity.transform.y = state.y;
    entity.transform.z = lerp(
      sample.prevBuildingBaseY + building.depth / 2,
      sample.currBuildingBaseY + building.depth / 2,
      t,
    );
    setPresentationRotation(entity, state.rotation);
    this.applyTurretEntities(entity, sample, t);
    return state;
  }

  private applyClientEntityList(
    entities: readonly Entity[],
    source: AuthoritativeRenderSource,
    refreshEntity: (entity: Entity, state: AuthoritativeRenderEntityState3D) => void,
  ): void {
    for (let i = 0; i < entities.length; i++) {
      const entity = entities[i];
      const sourceEntity = source.world.getEntity(entity.id);
      if (sourceEntity === undefined) continue;
      this.applyEntityPair(entity, sourceEntity, refreshEntity);
    }
  }

  private applyAuthoritativeEntityList(
    sourceEntities: readonly Entity[],
    lookupClientEntity: (id: EntityId) => Entity | undefined,
    refreshEntity: (entity: Entity, state: AuthoritativeRenderEntityState3D) => void,
  ): void {
    for (let i = 0; i < sourceEntities.length; i++) {
      const sourceEntity = sourceEntities[i];
      const entity = lookupClientEntity(sourceEntity.id);
      if (entity === undefined) continue;
      this.applyEntityPair(entity, sourceEntity, refreshEntity);
    }
  }

  private applyClientUnitSlots(
    slots: readonly number[],
    views: ClientRenderEntityStateViews,
    source: AuthoritativeRenderSource,
    refreshSlot: (slot: number, state: AuthoritativeRenderEntityState3D) => void,
  ): void {
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i];
      if (views.kind[slot] !== CLIENT_RENDER_ENTITY_KIND_UNIT) continue;
      const sourceEntity = source.world.getEntity(views.entityIds[slot] as EntityId);
      if (sourceEntity === undefined || sourceEntity.unit === null) continue;
      const state = this.authoritativeUnitState(sourceEntity);
      if (state !== null) refreshSlot(slot, state);
    }
  }

  private applyClientBuildingSlots(
    slots: readonly number[],
    views: ClientRenderEntityStateViews,
    source: AuthoritativeRenderSource,
    refreshSlot: (slot: number, state: AuthoritativeRenderEntityState3D) => void,
  ): void {
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i];
      if (views.kind[slot] !== CLIENT_RENDER_ENTITY_KIND_BUILDING) continue;
      const sourceEntity = source.world.getEntity(views.entityIds[slot] as EntityId);
      if (
        sourceEntity === undefined ||
        sourceEntity.building === null ||
        !buildingHasDynamicAuthoritativeRenderState(sourceEntity)
      ) {
        continue;
      }
      const state = this.authoritativeBuildingState(sourceEntity);
      if (state !== null) refreshSlot(slot, state);
    }
  }

  private applyAuthoritativeUnitSlots(
    sourceEntities: readonly Entity[],
    views: ClientRenderEntityStateViews,
    slotForEntityId: (id: EntityId) => number | undefined,
    refreshSlot: (slot: number, state: AuthoritativeRenderEntityState3D) => void,
  ): void {
    for (let i = 0; i < sourceEntities.length; i++) {
      const sourceEntity = sourceEntities[i];
      if (sourceEntity.unit === null) continue;
      const slot = slotForEntityId(sourceEntity.id);
      if (slot === undefined || views.kind[slot] !== CLIENT_RENDER_ENTITY_KIND_UNIT) continue;
      const state = this.authoritativeUnitState(sourceEntity);
      if (state !== null) refreshSlot(slot, state);
    }
  }

  private applyAuthoritativeBuildingSlots(
    sourceEntities: readonly Entity[],
    views: ClientRenderEntityStateViews,
    slotForEntityId: (id: EntityId) => number | undefined,
    refreshSlot: (slot: number, state: AuthoritativeRenderEntityState3D) => void,
  ): void {
    for (let i = 0; i < sourceEntities.length; i++) {
      const sourceEntity = sourceEntities[i];
      if (
        sourceEntity.building === null ||
        !buildingHasDynamicAuthoritativeRenderState(sourceEntity)
      ) {
        continue;
      }
      const slot = slotForEntityId(sourceEntity.id);
      if (slot === undefined || views.kind[slot] !== CLIENT_RENDER_ENTITY_KIND_BUILDING) continue;
      const state = this.authoritativeBuildingState(sourceEntity);
      if (state !== null) refreshSlot(slot, state);
    }
  }

  private applyEntityPair(
    entity: Entity,
    sourceEntity: Entity,
    refreshEntity: (entity: Entity, state: AuthoritativeRenderEntityState3D) => void,
  ): void {
    if (entity.unit !== null && sourceEntity.unit !== null) {
      const state = this.applyUnitEntity(entity, sourceEntity);
      if (state !== null) refreshEntity(entity, state);
    } else if (entity.building !== null && sourceEntity.building !== null) {
      if (
        !buildingHasDynamicAuthoritativeRenderState(entity) &&
        !buildingHasDynamicAuthoritativeRenderState(sourceEntity)
      ) {
        return;
      }
      const state = this.applyBuildingEntity(entity, sourceEntity);
      if (state !== null) refreshEntity(entity, state);
    }
  }

  private authoritativeUnitState(sourceEntity: Entity): AuthoritativeRenderUnitState3D | null {
    if (sourceEntity.unit === null) return null;
    const sample = sampleForUnitEntity(
      this.samples,
      sourceEntity,
      this.frameTick,
      this.frame,
    );
    if (sample.appliedFrame === this.frame) return null;
    sample.appliedFrame = this.frame;
    return unitStateFromSample(
      sample,
      interpolationAlpha(sample, this.frameAlpha),
      sourceEntity.combat?.turrets,
      this.unitStateScratch,
    );
  }

  private authoritativeBuildingState(sourceEntity: Entity): AuthoritativeRenderBuildingState3D | null {
    if (sourceEntity.building === null) return null;
    const sample = sampleForEntity(this.samples, sourceEntity, this.frameTick, this.frame, false);
    if (sample.appliedFrame === this.frame) return null;
    sample.appliedFrame = this.frame;
    return buildingStateFromSample(
      sample,
      interpolationAlpha(sample, this.frameAlpha),
      sourceEntity.combat?.turrets,
      this.buildingStateScratch,
    );
  }

  private applyProjectileEntity(entity: Entity, sourceEntity: Entity): boolean | null {
    const projectile = entity.projectile;
    const sourceProjectile = sourceEntity.projectile;
    if (projectile === null || sourceProjectile === null) return false;
    const sample = sampleForProjectile(this.samples, sourceEntity, this.frameTick, this.frame);
    if (sample.appliedFrame === this.frame) return null;
    sample.appliedFrame = this.frame;
    const t = interpolationAlpha(sample, this.frameAlpha);
    entity.transform.x = lerp(sample.prevX, sample.currX, t);
    entity.transform.y = lerp(sample.prevY, sample.currY, t);
    entity.transform.z = lerp(sample.prevZ, sample.currZ, t);
    setPresentationRotation(entity, lerpAngle(sample.prevRotation, sample.currRotation, t));
    projectile.velocityX = sample.currVelocityX;
    projectile.velocityY = sample.currVelocityY;
    projectile.velocityZ = sample.currYawRate;

    const beamPoints = copyBeamPoints(projectile.points, sourceProjectile.points);
    projectile.points = beamPoints.points;
    let lineGeometryChanged = beamPoints.changed;
    if (projectile.endpointDamageable !== sourceProjectile.endpointDamageable) {
      projectile.endpointDamageable = sourceProjectile.endpointDamageable;
      lineGeometryChanged = true;
    }
    if (projectile.segmentLimitReached !== sourceProjectile.segmentLimitReached) {
      projectile.segmentLimitReached = sourceProjectile.segmentLimitReached;
      lineGeometryChanged = true;
    }
    if (projectile.obstructionT !== sourceProjectile.obstructionT) {
      projectile.obstructionT = sourceProjectile.obstructionT;
      lineGeometryChanged = true;
    }
    if (projectile.obstructionTick !== sourceProjectile.obstructionTick) {
      projectile.obstructionTick = sourceProjectile.obstructionTick;
      lineGeometryChanged = true;
    }
    return lineGeometryChanged;
  }

  private applyClientProjectileList(
    projectiles: readonly Entity[],
    source: AuthoritativeRenderSource,
    refreshProjectile: (entity: Entity, lineGeometryChanged: boolean) => void,
  ): void {
    for (let i = 0; i < projectiles.length; i++) {
      const entity = projectiles[i];
      if (entity.projectile === null) continue;
      const sourceEntity = source.world.getEntity(entity.id);
      if (sourceEntity === undefined || sourceEntity.projectile === null) continue;
      const lineGeometryChanged = this.applyProjectileEntity(entity, sourceEntity);
      if (lineGeometryChanged !== null) refreshProjectile(entity, lineGeometryChanged);
    }
  }

  private applyAuthoritativeProjectileList(
    sourceProjectiles: readonly Entity[],
    lookupClientEntity: (id: EntityId) => Entity | undefined,
    refreshProjectile: (entity: Entity, lineGeometryChanged: boolean) => void,
  ): void {
    for (let i = 0; i < sourceProjectiles.length; i++) {
      const sourceEntity = sourceProjectiles[i];
      if (sourceEntity.projectile === null) continue;
      const entity = lookupClientEntity(sourceEntity.id);
      if (entity === undefined || entity.projectile === null) continue;
      const lineGeometryChanged = this.applyProjectileEntity(entity, sourceEntity);
      if (lineGeometryChanged !== null) refreshProjectile(entity, lineGeometryChanged);
    }
  }

  private applyTurretEntities(entity: Entity, sample: EntityPoseSample, t: number): void {
    const turrets = entity.combat?.turrets;
    if (turrets === undefined) return;
    const count = Math.min(turrets.length, sample.currTurretCount);
    for (let i = 0; i < count; i++) {
      const hasPrevTurret = sample.hasPrev && i < sample.prevTurretCount;
      turrets[i].rotation = hasPrevTurret
        ? lerpAngle(sample.prevTurretRotation[i], sample.currTurretRotation[i], t)
        : sample.currTurretRotation[i];
      turrets[i].pitch = hasPrevTurret
        ? lerp(sample.prevTurretPitch[i], sample.currTurretPitch[i], t)
        : sample.currTurretPitch[i];
    }
  }

}

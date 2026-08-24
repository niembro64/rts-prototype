import { deterministicMath as DMath } from '@/game/sim/deterministicMath';
import { SIM_TICK_INSTRUMENTATION } from '@/game/perf/SimTickInstrumentation';
// Projectile collision detection and damage application

import type { WorldState } from '../WorldState';
import type { Entity, EntityId, PlayerId, Projectile, ProjectileShot, BeamRay, ShotSource } from '../types';
import {
  REFLECTOR_HIT_KIND_NONE,
  SHIELD_REFLECTION_ENTITY_PLASMA,
  SHIELD_REFLECTION_ENTITY_ROCKET,
  SHIELD_PANEL_PROJECTILE_QUERY_PAD,
} from './reflectorBatch';
import {
  getEmissionBlueprintId,
  isRayType,
  isProjectileShot,
  isRocketLikeShot,
  PROJECTILE_GUIDANCE_LOST_INTERCEPT_ALIGNED,
  PROJECTILE_GUIDANCE_LOST_INTERCEPT_TURNING,
} from '../types';
import type { DamageSystem } from '../damage';
import type { ForceAccumulator } from '../ForceAccumulator';
import type {
  SimEvent,
  CollisionResult,
  ProjectileDespawnEvent,
  ProjectileSpawnEvent,
  SimEventSourceType,
} from './types';
import { beamIndex } from '../BeamIndex';
import type { DamageResult, DeathContext } from '../damage/types';
import { buildImpactContext, collectKillsAndDeathContexts, emitBeamHitAudio } from './damageHelpers';
import { createProjectileConfigFromShot } from '../projectileConfigs';
import { getSurfaceNormal, isWaterAt, WATER_LEVEL } from '../Terrain';
import { spatialGrid } from '../SpatialGrid';
import {
  BEAM_MIN_ON_TIME_MS,
  BEAM_PULSE_ACTIVE_OUTPUT_MULTIPLIER,
  LAND_CELL_SIZE,
  PROJECTILE_MASS_MULTIPLIER,
} from '../../../config';
import { getActiveShields } from './shieldTurret';
import { REFLECTIVE_SHIELD_MATERIAL } from '../blueprints/shieldMaterials';
import { getSimWasm } from '../../sim-wasm/init';
import { updateProjectileSourceClearance } from './combatUtils';
import { writeTurretCooldownToSlab } from './combatActivitySlab';
import { getCombatTargetingSourceSlots } from './targetingInputStamping';
import { rollTurretCooldownDuration } from '../turretCooldown';
import { normalizeAngle } from '../../math';
import { rollBeamPulseOffTimeMs } from './beamPulse';
import { firingRandomnessEnabled } from './precisionFire';
import {
  getShotWaterSurfaceCrossingFraction,
  getShotLocomotionMaxTurnRate,
  shotLocomotionCanOperateInWater,
} from '../shotLocomotion';


const PROJECTILE_HITBOX_SWEEP_QUERY_EXTRA = 32;
const MAX_PROJECTILE_SWEEP_DISTANCE = LAND_CELL_SIZE * 64;
const MAX_PROJECTILE_SWEEP_DISTANCE_SQ =
  MAX_PROJECTILE_SWEEP_DISTANCE * MAX_PROJECTILE_SWEEP_DISTANCE;
const MAX_REFLECTOR_IMPACT_EVENTS_PER_PASS = 96;

// Materials Are Independent Of Shape: a projectile reflecting off either the
// shield sphere or a flat shield panel reports one kind. The shape
// only decided where the hit was and what the normal looks like; the reflection
// response and impact are identical.
const REFLECTOR_HIT_KIND_SHIELD = 1;
const PROJECTILE_SWEEP_HIT_KIND_NONE = 0;
const PROJECTILE_SWEEP_HIT_KIND_UNIT = 1;
const PROJECTILE_SWEEP_HIT_KIND_BUILDING = 2;
const PROJECTILE_SWEEP_HIT_KIND_PROJECTILE = 3;
const PROJECTILE_SWEEP_NO_SLOT = 0xffff_ffff;

function isValidProjectileSweep(
  prevX: number, prevY: number, prevZ: number,
  currentX: number, currentY: number, currentZ: number,
): boolean {
  if (
    !Number.isFinite(prevX) || !Number.isFinite(prevY) || !Number.isFinite(prevZ) ||
    !Number.isFinite(currentX) || !Number.isFinite(currentY) || !Number.isFinite(currentZ)
  ) {
    return false;
  }
  const dx = currentX - prevX;
  const dy = currentY - prevY;
  const dz = currentZ - prevZ;
  return dx * dx + dy * dy + dz * dz <= MAX_PROJECTILE_SWEEP_DISTANCE_SQ;
}

function projectileEffectiveMaxLifespanMs(proj: Projectile): number {
  return isRayType(proj.projectileType)
    ? Math.max(proj.maxLifespan, BEAM_MIN_ON_TIME_MS)
    : proj.maxLifespan;
}

// Reusable containers for checkProjectileCollisions (avoid per-frame allocations)
const _collisionUnitsToRemove = new Set<EntityId>();
const _collisionBuildingsToRemove = new Set<EntityId>();
const _collisionDeathContexts = new Map<EntityId, DeathContext>();
const _collisionProjectilesToRemove: EntityId[] = [];
const _collisionProjectileRemoveIds = new Set<EntityId>();
const _collisionWaterSurfaceImpactIds = new Set<EntityId>();
const _collisionWaterSurfaceDetonateIds = new Set<EntityId>();
const _collisionDespawnEvents: ProjectileDespawnEvent[] = [];
const _collisionSimEvents: SimEvent[] = [];
const _collisionNewProjectiles: Entity[] = [];
const _collisionSpawnEvents: ProjectileSpawnEvent[] = [];
const _killedProjectileShotIdBuffers: EntityId[][] = [];

let _reflectorBatchCapacity = 0;
let _reflectorEnabled = new Uint8Array(0);
let _reflectorStartX = new Float64Array(0);
let _reflectorStartY = new Float64Array(0);
let _reflectorStartZ = new Float64Array(0);
let _reflectorEndX = new Float64Array(0);
let _reflectorEndY = new Float64Array(0);
let _reflectorEndZ = new Float64Array(0);
let _reflectorProjectileRadius = new Float64Array(0);
let _reflectorReflectionEntity = new Uint8Array(0);
let _reflectorExcludeEntityId = new Int32Array(0);
let _reflectorExcludePanelIndex = new Int32Array(0);
let _reflectorHitKind = new Uint8Array(0);
let _reflectorHitEntityId = new Int32Array(0);
let _reflectorHitPanelIndex = new Int32Array(0);
let _reflectorHitT = new Float64Array(0);
let _reflectorHitX = new Float64Array(0);
let _reflectorHitY = new Float64Array(0);
let _reflectorHitZ = new Float64Array(0);
let _reflectorHitNormalX = new Float64Array(0);
let _reflectorHitNormalY = new Float64Array(0);
let _reflectorHitNormalZ = new Float64Array(0);
let _reflectorHitReflectDirX = new Float64Array(0);
let _reflectorHitReflectDirY = new Float64Array(0);
let _reflectorHitReflectDirZ = new Float64Array(0);
let _reflectorHitSurfaceVelocityX = new Float64Array(0);
let _reflectorHitSurfaceVelocityY = new Float64Array(0);
let _reflectorHitSurfaceVelocityZ = new Float64Array(0);
let _reflectorResponseEnabled = new Uint8Array(0);
let _reflectorResponseVelocityX = new Float64Array(0);
let _reflectorResponseVelocityY = new Float64Array(0);
let _reflectorResponseVelocityZ = new Float64Array(0);
let _reflectorResponseRadius = new Float64Array(0);
let _reflectorResponseReflected = new Uint8Array(0);
let _reflectorResponsePosX = new Float64Array(0);
let _reflectorResponsePosY = new Float64Array(0);
let _reflectorResponsePosZ = new Float64Array(0);
let _reflectorResponseOutVelocityX = new Float64Array(0);
let _reflectorResponseOutVelocityY = new Float64Array(0);
let _reflectorResponseOutVelocityZ = new Float64Array(0);
let _reflectorResponseRotationChanged = new Uint8Array(0);
let _reflectorResponseRotation = new Float64Array(0);

// Sweep id lists and outputs live in WASM staging (ledger [22]): the
// sweep runs once per projectile per tick, so the old slice-marshalling
// batch call paid ~15 array copies per projectile. Views follow the
// [25] detach discipline — wasm memory growth replaces the backing
// buffer (stale views silently no-op) but never moves data, so cached
// pointers stay valid until the next staging growth; views re-derive on
// buffer identity change, including AFTER the sweep call (its cell
// collection can grow memory).
let _hitboxSweepExcludeIds = new Int32Array(0);
let _hitboxSweepRemovedProjectileIds = new Int32Array(0);
let _hitboxSweepOutKind = new Uint8Array(0);
let _hitboxSweepOutSlot = new Uint32Array(0);
let _hitboxSweepOutT = new Float64Array(0);
let _hitboxSweepOutNormals = new Float64Array(0);
let _hitboxSweepStagingBuffer: ArrayBufferLike | null = null;
let _hitboxSweepExcludeCapacity = 0;
let _hitboxSweepRemovedCapacity = 0;
let _hitboxSweepExcludeIdsPtr = 0;
let _hitboxSweepRemovedIdsPtr = 0;

function rebuildHitboxSweepViews(sim: NonNullable<ReturnType<typeof getSimWasm>>): void {
  const buffer = sim.memory.buffer;
  _hitboxSweepStagingBuffer = buffer;
  _hitboxSweepExcludeIds = new Int32Array(buffer, _hitboxSweepExcludeIdsPtr, _hitboxSweepExcludeCapacity);
  _hitboxSweepRemovedProjectileIds = new Int32Array(buffer, _hitboxSweepRemovedIdsPtr, _hitboxSweepRemovedCapacity);
  _hitboxSweepOutKind = new Uint8Array(buffer, sim.projectileHitboxSweepOutKindPtr(), 1);
  _hitboxSweepOutSlot = new Uint32Array(buffer, sim.projectileHitboxSweepOutSlotPtr(), 1);
  _hitboxSweepOutT = new Float64Array(buffer, sim.projectileHitboxSweepOutTPtr(), 1);
  _hitboxSweepOutNormals = new Float64Array(buffer, sim.projectileHitboxSweepOutNormalPtr(), 3);
}

function refreshHitboxSweepViews(sim: NonNullable<ReturnType<typeof getSimWasm>>): void {
  if (sim.memory.buffer !== _hitboxSweepStagingBuffer) rebuildHitboxSweepViews(sim);
}
let _submunitionLaunchCapacity = 0;
let _submunitionLaunchVelocityX = new Float64Array(0);
let _submunitionLaunchVelocityY = new Float64Array(0);
let _submunitionLaunchVelocityZ = new Float64Array(0);
const PROJECTILE_TERMINAL_REASON_GROUND = 2;
const PROJECTILE_TERMINAL_FLAG_SET_HP_ZERO = 1 << 1;
const PROJECTILE_TERMINAL_FLAG_CLAMP_Z = 1 << 2;
const PROJECTILE_TERMINAL_EFFECT_FLAG_QUEUE_DESPAWN = 1 << 0;
const PROJECTILE_TERMINAL_EFFECT_FLAG_SET_EXPLODED = 1 << 1;
const PROJECTILE_TERMINAL_EFFECT_FLAG_APPLY_SPLASH = 1 << 2;
const PROJECTILE_TERMINAL_EFFECT_FLAG_SPAWN_SUBMUNITIONS = 1 << 3;
const PROJECTILE_TERMINAL_EFFECT_FLAG_EMIT_HIT_EVENT = 1 << 4;
const PROJECTILE_TERMINAL_EFFECT_FLAG_EMIT_EXPIRE_EVENT = 1 << 5;
const PROJECTILE_TERMINAL_EFFECT_FLAG_EMIT_WATER_SPLASH_EVENT = 1 << 6;
const PROJECTILE_TERMINAL_EFFECT_FLAG_EMIT_REFLECTOR_IMPACT_EVENT = 1 << 7;
const PROJECTILE_OUT_OF_BOUNDS_MARGIN = 100;

// Input bits for projectileTerminalSingle — mirror of TERMINAL_IN_* in
// rts-sim-wasm/src/combat_targeting/projectile_interactions.rs. Append-only.
const TERMINAL_IN_IS_PROJECTILE_TYPE = 1 << 0;
const TERMINAL_IN_IS_ARMED = 1 << 1;
const TERMINAL_IN_HAS_EXPLODED = 1 << 2;
const TERMINAL_IN_DETONATE_ON_ENTITY_IMPACT = 1 << 3;
const TERMINAL_IN_DETONATE_ON_GROUND_CONTACT = 1 << 4;
const TERMINAL_IN_DETONATE_ON_EXPIRY = 1 << 5;
const TERMINAL_IN_DETONATE_ON_DESTROYED = 1 << 6;
const TERMINAL_IN_DETONATE_ON_REFLECTOR_IMPACT = 1 << 7;
const TERMINAL_IN_DETONATE_ON_WATER_TRANSITION = 1 << 8;
const TERMINAL_IN_HAS_DETONATION_PAYLOAD = 1 << 9;
const TERMINAL_IN_DIRECT_HIT_THIS_TICK = 1 << 10;
const TERMINAL_IN_REFLECTED_PROJECTILE = 1 << 11;
const TERMINAL_IN_HIT_SHIELD = 1 << 12;
const TERMINAL_IN_TERMINAL_REFLECTOR_HIT = 1 << 13;
const TERMINAL_IN_WATER_AT_IMPACT = 1 << 14;
const TERMINAL_IN_WATER_SURFACE_IMPACT = 1 << 15;
const TERMINAL_IN_WATER_COMPATIBLE = 1 << 16;
const TERMINAL_IN_HAS_EXPLOSION = 1 << 17;
const TERMINAL_IN_HAS_SUBMUNITIONS = 1 << 18;

/** Reused unpack target for the merged classify+plan single call. Consumed
 *  synchronously by the caller before the next projectile's call. */
const _terminalResult = { reason: 0, terminalFlags: 0, effectFlags: 0 };

function queueProjectileRemoval(
  id: EntityId,
  projectilesToRemove: EntityId[],
  despawnEvents: ProjectileDespawnEvent[],
): void {
  if (_collisionProjectileRemoveIds.has(id)) return;
  _collisionProjectileRemoveIds.add(id);
  projectilesToRemove.push(id);
  despawnEvents.push({ id });
}

function copyKilledProjectileIdsForDepth(
  killedProjectileIds: ReadonlySet<EntityId>,
  depth: number,
): EntityId[] {
  const buffer = _killedProjectileShotIdBuffers[depth] ??
    (_killedProjectileShotIdBuffers[depth] = []);
  buffer.length = 0;
  for (const id of killedProjectileIds) buffer.push(id);
  return buffer;
}

function ensureReflectorBatchCapacity(count: number): void {
  if (count <= _reflectorBatchCapacity) return;
  let next = Math.max(8, _reflectorBatchCapacity);
  while (next < count) next *= 2;
  _reflectorBatchCapacity = next;
  _reflectorEnabled = new Uint8Array(next);
  _reflectorStartX = new Float64Array(next);
  _reflectorStartY = new Float64Array(next);
  _reflectorStartZ = new Float64Array(next);
  _reflectorEndX = new Float64Array(next);
  _reflectorEndY = new Float64Array(next);
  _reflectorEndZ = new Float64Array(next);
  _reflectorProjectileRadius = new Float64Array(next);
  _reflectorReflectionEntity = new Uint8Array(next);
  _reflectorExcludeEntityId = new Int32Array(next);
  _reflectorExcludePanelIndex = new Int32Array(next);
  _reflectorHitKind = new Uint8Array(next);
  _reflectorHitEntityId = new Int32Array(next);
  _reflectorHitPanelIndex = new Int32Array(next);
  _reflectorHitT = new Float64Array(next);
  _reflectorHitX = new Float64Array(next);
  _reflectorHitY = new Float64Array(next);
  _reflectorHitZ = new Float64Array(next);
  _reflectorHitNormalX = new Float64Array(next);
  _reflectorHitNormalY = new Float64Array(next);
  _reflectorHitNormalZ = new Float64Array(next);
  _reflectorHitReflectDirX = new Float64Array(next);
  _reflectorHitReflectDirY = new Float64Array(next);
  _reflectorHitReflectDirZ = new Float64Array(next);
  _reflectorHitSurfaceVelocityX = new Float64Array(next);
  _reflectorHitSurfaceVelocityY = new Float64Array(next);
  _reflectorHitSurfaceVelocityZ = new Float64Array(next);
  _reflectorResponseEnabled = new Uint8Array(next);
  _reflectorResponseVelocityX = new Float64Array(next);
  _reflectorResponseVelocityY = new Float64Array(next);
  _reflectorResponseVelocityZ = new Float64Array(next);
  _reflectorResponseRadius = new Float64Array(next);
  _reflectorResponseReflected = new Uint8Array(next);
  _reflectorResponsePosX = new Float64Array(next);
  _reflectorResponsePosY = new Float64Array(next);
  _reflectorResponsePosZ = new Float64Array(next);
  _reflectorResponseOutVelocityX = new Float64Array(next);
  _reflectorResponseOutVelocityY = new Float64Array(next);
  _reflectorResponseOutVelocityZ = new Float64Array(next);
  _reflectorResponseRotationChanged = new Uint8Array(next);
  _reflectorResponseRotation = new Float64Array(next);
}

function ensureHitboxSweepCapacity(excludeCount: number, removedCount: number): void {
  const sim = getSimWasm();
  if (sim === undefined) {
    throw new Error('Projectile hitbox sweep requires initialized sim-wasm');
  }
  if (
    excludeCount > _hitboxSweepExcludeCapacity ||
    removedCount > _hitboxSweepRemovedCapacity
  ) {
    const nextExclude = Math.max(excludeCount, _hitboxSweepExcludeCapacity * 2, 64);
    const nextRemoved = Math.max(removedCount, _hitboxSweepRemovedCapacity * 2, 64);
    sim.projectileHitboxSweepStagingEnsure(nextExclude, nextRemoved);
    _hitboxSweepExcludeCapacity = nextExclude;
    _hitboxSweepRemovedCapacity = nextRemoved;
    // Growth may have moved the staging arrays — re-fetch the pointers.
    _hitboxSweepExcludeIdsPtr = sim.projectileHitboxSweepExcludeIdsPtr();
    _hitboxSweepRemovedIdsPtr = sim.projectileHitboxSweepRemovedIdsPtr();
    rebuildHitboxSweepViews(sim);
  } else {
    refreshHitboxSweepViews(sim);
  }
}

function ensureSubmunitionLaunchCapacity(count: number): void {
  if (count <= _submunitionLaunchCapacity) return;
  let next = Math.max(8, _submunitionLaunchCapacity);
  while (next < count) next *= 2;
  _submunitionLaunchCapacity = next;
  _submunitionLaunchVelocityX = new Float64Array(next);
  _submunitionLaunchVelocityY = new Float64Array(next);
  _submunitionLaunchVelocityZ = new Float64Array(next);
}

function mixSubmunitionSeed(seed: number, value: number): number {
  let next = Math.imul(seed ^ (value | 0), 0x85ebca6b) >>> 0;
  next = (next ^ (next >>> 13)) >>> 0;
  return Math.imul(next, 0xc2b2ae35) >>> 0;
}

function makeSubmunitionSeed(
  parentShotEntityId: EntityId,
  parentShotSource: ShotSource,
  currentTick: number,
  gameplayRandomSeed: number,
): number {
  let seed = mixSubmunitionSeed(0x9e3779b9, gameplayRandomSeed);
  seed = mixSubmunitionSeed(seed, parentShotEntityId);
  seed = mixSubmunitionSeed(seed, currentTick);
  seed = mixSubmunitionSeed(seed, parentShotSource.spawnTick);
  seed = mixSubmunitionSeed(seed, parentShotSource.sourceHostEntityId);
  seed = mixSubmunitionSeed(seed, parentShotSource.sourceRootEntityId);
  seed = mixSubmunitionSeed(seed, parentShotSource.sourceTurretEntityId ?? 0);
  seed = mixSubmunitionSeed(seed, parentShotSource.parentShotEntityId ?? 0);
  return seed === 0 ? 0x6d2b79f5 : seed;
}

function computeProjectileReflectorHits(
  world: WorldState,
  projectiles: readonly Entity[],
  dtMs: number,
): void {
  const count = projectiles.length;
  if (count === 0) return;
  ensureReflectorBatchCapacity(count);
  _reflectorHitKind.fill(REFLECTOR_HIT_KIND_NONE, 0, count);
  _reflectorResponseReflected.fill(0, 0, count);
  _reflectorResponseRotationChanged.fill(0, 0, count);

  const mirrorsActive = world.turretShieldPanelsEnabled && world.getShieldPanelUnits().length > 0;
  const shieldsActive = world.turretShieldSpheresEnabled && getActiveShields().length > 0;
  if (!mirrorsActive && !shieldsActive) return;

  let enabledCount = 0;
  for (let i = 0; i < count; i++) {
    _reflectorEnabled[i] = 0;
    const projEntity = projectiles[i];
    if (!projEntity.projectile || !projEntity.ownership) continue;
    const proj = projEntity.projectile;
    if (proj.projectileType !== 'projectile' || !proj.isArmed) continue;

    const prevX = proj.collisionStartX ?? proj.prevX ?? projEntity.transform.x;
    const prevY = proj.collisionStartY ?? proj.prevY ?? projEntity.transform.y;
    const prevZ = proj.collisionStartZ ?? proj.prevZ ?? projEntity.transform.z;
    const curX = projEntity.transform.x;
    const curY = projEntity.transform.y;
    const curZ = projEntity.transform.z;
    if (!isValidProjectileSweep(prevX, prevY, prevZ, curX, curY, curZ)) continue;

    _reflectorEnabled[i] = 1;
    _reflectorStartX[i] = prevX;
    _reflectorStartY[i] = prevY;
    _reflectorStartZ[i] = prevZ;
    _reflectorEndX[i] = curX;
    _reflectorEndY[i] = curY;
    _reflectorEndZ[i] = curZ;
    _reflectorProjectileRadius[i] = proj.config.shotProfile.runtime.radius.collision;
    _reflectorReflectionEntity[i] =
      isProjectileShot(proj.config.shot) && isRocketLikeShot(proj.config.shot)
        ? SHIELD_REFLECTION_ENTITY_ROCKET
        : SHIELD_REFLECTION_ENTITY_PLASMA;
    _reflectorExcludeEntityId[i] = proj.sourceEntityId;
    _reflectorExcludePanelIndex[i] = -1;
    enabledCount++;
  }
  if (enabledCount === 0) return;

  const sim = getSimWasm();
  if (sim === undefined) {
    throw new Error('ProjectileCollisionHandler: sim-wasm is not initialized');
  }
  sim.projectileReflectorIntersectionsBatch(
    count,
    _reflectorEnabled,
    _reflectorStartX,
    _reflectorStartY,
    _reflectorStartZ,
    _reflectorEndX,
    _reflectorEndY,
    _reflectorEndZ,
    _reflectorProjectileRadius,
    _reflectorReflectionEntity,
    _reflectorExcludeEntityId,
    _reflectorExcludePanelIndex,
    mirrorsActive ? 1 : 0,
    shieldsActive ? 1 : 0,
    0,
    SHIELD_PANEL_PROJECTILE_QUERY_PAD,
    dtMs,
    _reflectorHitKind,
    _reflectorHitEntityId,
    _reflectorHitPanelIndex,
    _reflectorHitT,
    _reflectorHitX,
    _reflectorHitY,
    _reflectorHitZ,
    _reflectorHitNormalX,
    _reflectorHitNormalY,
    _reflectorHitNormalZ,
    _reflectorHitReflectDirX,
    _reflectorHitReflectDirY,
    _reflectorHitReflectDirZ,
    _reflectorHitSurfaceVelocityX,
    _reflectorHitSurfaceVelocityY,
    _reflectorHitSurfaceVelocityZ,
  );

  let responseCount = 0;
  for (let i = 0; i < count; i++) {
    _reflectorResponseEnabled[i] = 0;
    if (_reflectorHitKind[i] === REFLECTOR_HIT_KIND_NONE) continue;
    const projEntity = projectiles[i];
    const proj = projEntity.projectile;
    if (!proj || proj.projectileType !== 'projectile') continue;
    if (!shieldMaterialReflectsProjectile(proj.config.shotProfile.runtime.isRocketLike)) continue;
    _reflectorResponseEnabled[i] = 1;
    _reflectorResponseVelocityX[i] = proj.velocityX;
    _reflectorResponseVelocityY[i] = proj.velocityY;
    _reflectorResponseVelocityZ[i] = proj.velocityZ;
    _reflectorResponseRadius[i] = proj.config.shotProfile.runtime.radius.collision;
    responseCount++;
  }
  if (responseCount === 0) return;

  sim.projectileReflectionResponseBatch(
    count,
    _reflectorResponseEnabled,
    _reflectorHitT,
    _reflectorHitX,
    _reflectorHitY,
    _reflectorHitZ,
    _reflectorResponseVelocityX,
    _reflectorResponseVelocityY,
    _reflectorResponseVelocityZ,
    _reflectorHitNormalX,
    _reflectorHitNormalY,
    _reflectorHitNormalZ,
    _reflectorHitSurfaceVelocityX,
    _reflectorHitSurfaceVelocityY,
    _reflectorHitSurfaceVelocityZ,
    _reflectorResponseRadius,
    dtMs,
    REFLECTIVE_SHIELD_MATERIAL.reflection.reflectivity,
    _reflectorResponseReflected,
    _reflectorResponsePosX,
    _reflectorResponsePosY,
    _reflectorResponsePosZ,
    _reflectorResponseOutVelocityX,
    _reflectorResponseOutVelocityY,
    _reflectorResponseOutVelocityZ,
    _reflectorResponseRotationChanged,
    _reflectorResponseRotation,
  );
}

/**
 * Stop shots whose locomotion terminates on a water transition at the exact
 * swept surface crossing. The terminal classifier decides detonation/splash.
 */
function clipTerminalWaterTransitions(
  world: WorldState,
  projectiles: readonly Entity[],
): void {
  _collisionWaterSurfaceImpactIds.clear();
  _collisionWaterSurfaceDetonateIds.clear();
  for (let i = 0; i < projectiles.length; i++) {
    const entity = projectiles[i];
    const proj = entity.projectile;
    if (
      proj === null ||
      proj.projectileType !== 'projectile' ||
      !proj.isArmed ||
      !isProjectileShot(proj.config.shot)
    ) {
      continue;
    }
    const previousX = proj.collisionStartX ?? proj.prevX ?? entity.transform.x;
    const previousY = proj.collisionStartY ?? proj.prevY ?? entity.transform.y;
    const previousZ = proj.collisionStartZ ?? proj.prevZ ?? entity.transform.z;
    const enteringWater = previousZ > WATER_LEVEL && entity.transform.z <= WATER_LEVEL;
    const exitingWater = previousZ <= WATER_LEVEL && entity.transform.z > WATER_LEVEL;
    if (!enteringWater && !exitingWater) continue;
    const outcome = enteringWater
      ? proj.config.shot.shotLocomotion.transitions.enterWater
      : proj.config.shot.shotLocomotion.transitions.exitWater;
    if (outcome === 'continue' || outcome === 'continueBallistic') continue;
    const fraction = getShotWaterSurfaceCrossingFraction(
      previousZ,
      entity.transform.z,
      WATER_LEVEL,
    );
    if (fraction === null) continue;
    const impactX = previousX + fraction * (entity.transform.x - previousX);
    const impactY = previousY + fraction * (entity.transform.y - previousY);
    if (!isWaterAt(impactX, impactY, world.mapWidth, world.mapHeight)) continue;
    entity.transform.x = impactX;
    entity.transform.y = impactY;
    entity.transform.z = WATER_LEVEL;
    _collisionWaterSurfaceImpactIds.add(entity.id);
    if (outcome === 'detonate') _collisionWaterSurfaceDetonateIds.add(entity.id);
  }
}

function shieldMaterialReflectsProjectile(isRocketShot: boolean): boolean {
  const response = isRocketShot
    ? REFLECTIVE_SHIELD_MATERIAL.projectileResponse.rocket
    : REFLECTIVE_SHIELD_MATERIAL.projectileResponse.plasma;
  return response === 'reflect';
}

// Reusable empty set for additive area damage (avoids allocating new Set per frame)
const _emptyExcludeSet = new Set<EntityId>();

function getSplashExcludes(): Set<EntityId> {
  return _emptyExcludeSet;
}

function refreshProjectileCollisionTurretMounts(world: WorldState, dtMs: number): void {
  const sourceSlots = getCombatTargetingSourceSlots();
  if (sourceSlots.length === 0) return;
  const sim = getSimWasm();
  if (sim === undefined) {
    throw new Error('Projectile turret hitbox refresh requires initialized sim-wasm');
  }
  sim.combatTargeting.updateMountKinematicsBatch(
    sourceSlots,
    world.getTick(),
    dtMs,
    world.turretShieldPanelsEnabled ? 1 : 0,
    world.turretShieldSpheresEnabled ? 1 : 0,
  );
}

function ensureProjectileHitEntities(proj: { hitEntities: Set<EntityId> }): Set<EntityId> {
  return proj.hitEntities;
}

function getProjectileHitCount(proj: { hitEntities: Set<EntityId> }): number {
  return proj.hitEntities.size;
}

function pushReflectorImpactEvent(
  audioEvents: SimEvent[],
  projectileEntityId: EntityId,
  x: number,
  y: number,
  z: number,
  normalX: number,
  normalY: number,
  normalZ: number,
  playerId: number | undefined,
): void {
  // Materials Are Independent Of Shape: the shield material's impact
  // reaction (sound, particles) is identical whether a projectile reflected
  // off the sphere shape or a flat-panel shape — one source key for both.
  audioEvents.push({
    type: 'shieldImpact',
    turretBlueprintId: 'turretShieldSphere',
    sourceType: 'turret',
    sourceKey: 'turretShieldSphere',
    pos: { x, y, z },
    playerId,
    entityId: projectileEntityId,
    shieldImpact: {
      normal: { x: normalX, y: normalY, z: normalZ },
      playerId: playerId ?? 0,
    },
  });
}

type ProjectileHitboxSweepHit = {
  entity: Entity;
  t: number;
  normalX: number;
  normalY: number;
  normalZ: number;
};

const _projectileHitboxSweepHit = {
  entity: undefined as Entity | undefined,
  t: Infinity,
  normalX: 0,
  normalY: 0,
  normalZ: 1,
};

function resetProjectileHitboxSweepHit(out: typeof _projectileHitboxSweepHit): void {
  out.entity = undefined;
  out.t = Infinity;
  out.normalX = 0;
  out.normalY = 0;
  out.normalZ = 1;
}

// The removal-set PREFIX of the sweep exclude staging is shared by every
// sweep in the pass and re-packed (and re-committed to the Rust stamp
// membership) only when a removal set grew — the old per-projectile
// rebuild-and-SORT was an O(projectiles x removals log removals) term that
// worsened exactly as a battle escalated. Nothing ever consumed the order:
// the kernel only membership-tests.
let _sweepPrefixUnitsSize = -1;
let _sweepPrefixBuildingsSize = -1;
let _sweepPrefixProjectilesSize = -1;
let _sweepPrefixCount = 0;
let _sweepRemovedCount = 0;

/** Reset at the top of each collision pass so the first sweep re-packs. */
function beginProjectileSweepPass(): void {
  _sweepPrefixUnitsSize = -1;
  _sweepPrefixBuildingsSize = -1;
  _sweepPrefixProjectilesSize = -1;
  _sweepPrefixCount = 0;
  _sweepRemovedCount = 0;
}

function syncSweepRemovalPrefix(
  sim: NonNullable<ReturnType<typeof getSimWasm>>,
  tailMax: number,
): void {
  const unitCount = _collisionUnitsToRemove.size;
  const buildingCount = _collisionBuildingsToRemove.size;
  const projectileCount = _collisionProjectileRemoveIds.size;
  const prefixDirty =
    unitCount !== _sweepPrefixUnitsSize ||
    buildingCount !== _sweepPrefixBuildingsSize ||
    projectileCount !== _sweepPrefixProjectilesSize;
  ensureHitboxSweepCapacity(
    Math.max(1, unitCount + buildingCount + projectileCount + tailMax),
    Math.max(1, projectileCount),
  );
  if (!prefixDirty) return;
  _sweepPrefixUnitsSize = unitCount;
  _sweepPrefixBuildingsSize = buildingCount;
  _sweepPrefixProjectilesSize = projectileCount;
  let count = 0;
  for (const id of _collisionUnitsToRemove) _hitboxSweepExcludeIds[count++] = id;
  for (const id of _collisionBuildingsToRemove) _hitboxSweepExcludeIds[count++] = id;
  for (const id of _collisionProjectileRemoveIds) _hitboxSweepExcludeIds[count++] = id;
  _sweepPrefixCount = count;
  sim.projectileHitboxSweepPrefixCommit(count);
  let removed = 0;
  for (const id of _collisionProjectileRemoveIds) {
    _hitboxSweepRemovedProjectileIds[removed++] = id;
  }
  _sweepRemovedCount = removed;
}

function isValidSpatialSweepTarget(kind: number, entity: Entity | undefined): entity is Entity {
  if (entity === undefined) return false;
  switch (kind) {
    case PROJECTILE_SWEEP_HIT_KIND_UNIT:
      return entity.unit !== null && entity.unit.hp > 0;
    case PROJECTILE_SWEEP_HIT_KIND_BUILDING:
      return entity.building !== null && entity.building.hp > 0;
    case PROJECTILE_SWEEP_HIT_KIND_PROJECTILE: {
      const proj = entity.projectile;
      return (
        proj !== null &&
        proj.projectileType === 'projectile' &&
        proj.hp > 0 &&
        isProjectileShot(proj.config.shot)
      );
    }
    default:
      return false;
  }
}

function findProjectileHitboxSweepHit(
  world: WorldState,
  projectileHitboxRadius: number,
  prevX: number,
  prevY: number,
  prevZ: number,
  currentX: number,
  currentY: number,
  currentZ: number,
  excludeEntities: Set<EntityId>,
): ProjectileHitboxSweepHit | null {
  resetProjectileHitboxSweepHit(_projectileHitboxSweepHit);

  const sim = getSimWasm();
  if (sim === undefined) {
    throw new Error('Projectile hitbox sweep requires initialized sim-wasm');
  }
  syncSweepRemovalPrefix(sim, excludeEntities.size);
  let tailCount = 0;
  for (const id of excludeEntities) {
    _hitboxSweepExcludeIds[_sweepPrefixCount + tailCount++] = id;
  }
  const processed = sim.projectileHitboxSweepSingle(
    prevX,
    prevY,
    prevZ,
    currentX,
    currentY,
    currentZ,
    projectileHitboxRadius,
    tailCount,
    _sweepRemovedCount,
    world.getMaxTargetableRadius(),
    PROJECTILE_HITBOX_SWEEP_QUERY_EXTRA,
    world.getTick(),
  );
  if (processed !== 1) {
    throw new Error(`Projectile hitbox sweep batch failed: ${processed}/1`);
  }
  // The sweep's cell collection can grow wasm memory — re-derive the
  // output views before reading (data is already in place either way).
  refreshHitboxSweepViews(sim);

  const kind = _hitboxSweepOutKind[0];
  const slot = _hitboxSweepOutSlot[0];
  if (kind === PROJECTILE_SWEEP_HIT_KIND_NONE || slot === PROJECTILE_SWEEP_NO_SLOT) {
    return null;
  }

  const entity = spatialGrid.resolveSlot(slot);
  if (!isValidSpatialSweepTarget(kind, entity)) return null;

  _projectileHitboxSweepHit.entity = entity;
  _projectileHitboxSweepHit.t = _hitboxSweepOutT[0];
  _projectileHitboxSweepHit.normalX = _hitboxSweepOutNormals[0];
  _projectileHitboxSweepHit.normalY = _hitboxSweepOutNormals[1];
  _projectileHitboxSweepHit.normalZ = _hitboxSweepOutNormals[2];
  return _projectileHitboxSweepHit as ProjectileHitboxSweepHit;
}

// Reset collision-specific reusable buffers between game sessions
// (prevents stale entity references from surviving across sessions)
export function resetCollisionBuffers(): void {
  _collisionUnitsToRemove.clear();
  _collisionBuildingsToRemove.clear();
  _collisionDeathContexts.clear();
  _collisionProjectilesToRemove.length = 0;
  _collisionProjectileRemoveIds.clear();
  _collisionWaterSurfaceImpactIds.clear();
  _collisionWaterSurfaceDetonateIds.clear();
  _collisionDespawnEvents.length = 0;
  _collisionSimEvents.length = 0;
  _collisionNewProjectiles.length = 0;
  _collisionSpawnEvents.length = 0;
}

/**
 * Spawn cluster submunitions when a projectile with `submunitions`
 * detonates. Each child inherits the parent's owner + sourceEntityId
 * so any further kills still credit the original shooter.
 *
 * Direction model — two formal cases, owned by the Rust kernel
 * (`projectile_submunition_launch_velocity_batch`):
 *
 *     surface hit:     v = reflect(parentVelocity, N) * damper
 *                        + jitterDir * randomSpreadSpeed,
 *                      folded into the outgoing half-space (v·N >= 0)
 *     in-flight death: v = parentVelocity
 *                        + jitterDir * randomSpreadSpeed,
 *                      folded into the forward half-space along the
 *                      parent's direction of travel
 *
 * Which case applies is decided by HOW the parent died, not by what
 * its sweep happened to touch:
 *
 *   - reflect (surface): the parent flew into a real surface — terrain,
 *     a unit/building body, or a shield reflector. Fragments
 *     spray off that surface (a particle explosion that never tunnels
 *     back in).
 *   - momentum (no surface): the parent died in flight — chipped to
 *     zero HP by point-defense fire, destroyed in a shot-vs-shot
 *     collision, caught in another explosion, or expired. Fragments
 *     are thrown onward with the parent's momentum.
 *
 * The half-space folds mirror rather than clamp, so fragment speeds
 * and the spread shape are preserved.
 *
 * `surfaceNormalX/Y/Z` is the world-space surface normal at the
 * impact point (sim coords: z is up). Pass undefined for all three
 * when there is no surface (the momentum case).
 */
function spawnSubmunitions(
  world: WorldState,
  parentShot: ProjectileShot,
  parentShotEntityId: EntityId,
  parentShotSource: ShotSource,
  detonationX: number,
  detonationY: number,
  detonationZ: number,
  parentVx: number,
  parentVy: number,
  parentVz: number,
  surfaceNormalX: number | undefined,
  surfaceNormalY: number | undefined,
  surfaceNormalZ: number | undefined,
  ownerId: number,
  sourceEntityId: EntityId,
  outProjectiles: Entity[],
  outSpawnEvents: ProjectileSpawnEvent[],
): void {
  const spec = parentShot.submunitions;
  if (!spec || spec.count <= 0) return;
  const childCount = Math.floor(spec.count);
  if (childCount <= 0) return;

  const sourceTurretBlueprintId = parentShotSource.sourceTurretBlueprintId;
  const childCfg = createProjectileConfigFromShot(spec.shotBlueprintId, sourceTurretBlueprintId);

  const reflectedVelocityDamper = spec.reflectedVelocityDamper ?? 1.0;
  const hasSurfaceNormal =
    surfaceNormalX !== undefined &&
    surfaceNormalY !== undefined &&
    surfaceNormalZ !== undefined;
  ensureSubmunitionLaunchCapacity(childCount);
  const sim = getSimWasm();
  if (sim === undefined) {
    throw new Error('Submunition launch velocity generation requires initialized sim-wasm');
  }
  const processed = sim.projectileSubmunitionLaunchVelocityBatch(
    childCount,
    makeSubmunitionSeed(
      parentShotEntityId,
      parentShotSource,
      world.getTick(),
      Math.floor(world.nextRandom(ownerId as PlayerId) * 0x1_0000_0000) >>> 0,
    ),
    parentVx,
    parentVy,
    parentVz,
    surfaceNormalX ?? 0,
    surfaceNormalY ?? 0,
    surfaceNormalZ ?? 0,
    hasSurfaceNormal ? 1 : 0,
    reflectedVelocityDamper,
    spec.randomSpreadSpeedHorizontal,
    spec.randomSpreadSpeedVertical,
    _submunitionLaunchVelocityX,
    _submunitionLaunchVelocityY,
    _submunitionLaunchVelocityZ,
  );
  if (processed !== childCount) {
    throw new Error(`Submunition launch velocity batch failed: ${processed}/${childCount}`);
  }

  for (let i = 0; i < childCount; i++) {
    const launchVx = _submunitionLaunchVelocityX[i];
    const launchVy = _submunitionLaunchVelocityY[i];
    const launchVz = _submunitionLaunchVelocityZ[i];

    const proj = world.createProjectile(
      detonationX, detonationY, launchVx, launchVy,
      ownerId, sourceEntityId, childCfg, 'projectile',
      {
        shotBlueprintId: spec.shotBlueprintId,
        shotSource: {
          ...parentShotSource,
          spawnTick: world.getTick(),
          parentShotEntityId: parentShotEntityId,
        },
      },
    );
    if (proj.projectile) {
      // Inherit the parent's altitude at detonation; vertical velocity
      // from the bounce + perturbation is set on the projectile here so
      // gravity integrates from the right initial vz next tick.
      proj.transform.z = detonationZ;
      proj.projectile.velocityZ = launchVz;
    }
    const projectileComponent = proj.projectile;
    const maxLifespan = projectileComponent !== null ? projectileComponent.maxLifespan : undefined;
    outProjectiles.push(proj);
    outSpawnEvents.push({
      id: proj.id,
      pos: { x: detonationX, y: detonationY, z: detonationZ },
      rotation: DMath.atan2(launchVy, launchVx),
      velocity: { x: launchVx, y: launchVy, z: launchVz },
      projectileType: 'projectile',
      maxLifespan: typeof maxLifespan === 'number' && Number.isFinite(maxLifespan)
        ? maxLifespan
        : undefined,
      // Source/provenance remains the real turret; shotBlueprintId tells the
      // client which child projectile blueprint to hydrate.
      turretBlueprintId: sourceTurretBlueprintId ?? '',
      shotBlueprintId: spec.shotBlueprintId,
      sourceTurretBlueprintId: sourceTurretBlueprintId ?? undefined,
      sourceTurretEntityId: parentShotSource.sourceTurretEntityId ?? undefined,
      sourceHostEntityId: parentShotSource.sourceHostEntityId,
      sourceRootEntityId: parentShotSource.sourceRootEntityId,
      sourceTeamId: parentShotSource.sourceTeamId,
      spawnTick: world.getTick(),
      parentShotEntityId: parentShotEntityId,
      playerId: ownerId,
      sourceEntityId,
      turretIndex: 0,
      barrelIndex: 0,
      // Submunitions spawn AT the parent's detonation point, not at
      // the original shooter's turret launch origin.
      fromParentDetonation: true,
      homingTurnRate: isProjectileShot(childCfg.shot)
        ? getShotLocomotionMaxTurnRate(childCfg.shot.shotLocomotion) || undefined
        : undefined,
    });
  }
}

function processKilledProjectileShots(
  result: DamageResult,
  world: WorldState,
  damageSystem: DamageSystem,
  forceAccumulator: ForceAccumulator | undefined,
  unitsToRemove: Set<EntityId>,
  buildingsToRemove: Set<EntityId>,
  audioEvents: SimEvent[],
  deathContexts: Map<EntityId, DeathContext>,
  newProjectiles: Entity[],
  spawnEvents: ProjectileSpawnEvent[],
  projectilesToRemove: EntityId[],
  despawnEvents: ProjectileDespawnEvent[],
  depth: number = 0,
): void {
  if (result.killedProjectileIds.size === 0) return;
  const killedProjectileIds = copyKilledProjectileIdsForDepth(
    result.killedProjectileIds,
    depth,
  );
  for (let i = 0; i < killedProjectileIds.length; i++) {
    const projectileEntity = world.getEntity(killedProjectileIds[i]);
    if (projectileEntity === undefined) continue;
    detonateKilledProjectileShot(
      projectileEntity,
      world,
      damageSystem,
      forceAccumulator,
      unitsToRemove,
      buildingsToRemove,
      audioEvents,
      deathContexts,
      newProjectiles,
      spawnEvents,
      projectilesToRemove,
      despawnEvents,
      depth,
    );
  }
}

function detonateKilledProjectileShot(
  projEntity: Entity,
  world: WorldState,
  damageSystem: DamageSystem,
  forceAccumulator: ForceAccumulator | undefined,
  unitsToRemove: Set<EntityId>,
  buildingsToRemove: Set<EntityId>,
  audioEvents: SimEvent[],
  deathContexts: Map<EntityId, DeathContext>,
  newProjectiles: Entity[],
  spawnEvents: ProjectileSpawnEvent[],
  projectilesToRemove: EntityId[],
  despawnEvents: ProjectileDespawnEvent[],
  depth: number,
): void {
  const proj = projEntity.projectile;
  const shot = proj === null ? undefined : proj.config.shot;
  if (
    proj === null ||
    projEntity.ownership === null ||
    proj.projectileType !== 'projectile' ||
    shot === undefined ||
    !isProjectileShot(shot)
  ) {
    queueProjectileRemoval(projEntity.id, projectilesToRemove, despawnEvents);
    return;
  }

  proj.hp = 0;
  const terminalEffectFlags = classifyAndPlanProjectileTerminal(
    world,
    projEntity,
    false,
    true,
    false,
    false,
  ).effectFlags;

  const config = proj.config;
  const projShot = shot;
  const runtimeProfile = config.shotProfile.runtime;
  const shotBlueprintId = projShot.shotBlueprintId;
  const damageSourceKey = proj.sourceTurretBlueprintId ?? shotBlueprintId;
  const damageSourceType: SimEventSourceType = proj.sourceTurretBlueprintId ? 'turret' : 'system';
  let firstSplashHit: Entity | undefined;

  if ((terminalEffectFlags & PROJECTILE_TERMINAL_EFFECT_FLAG_QUEUE_DESPAWN) === 0) {
    queueProjectileRemoval(projEntity.id, projectilesToRemove, despawnEvents);
    return;
  }

  if ((terminalEffectFlags & PROJECTILE_TERMINAL_EFFECT_FLAG_SET_EXPLODED) !== 0) {
    proj.hasExploded = true;
  } else {
    if ((terminalEffectFlags & PROJECTILE_TERMINAL_EFFECT_FLAG_EMIT_EXPIRE_EVENT) !== 0) {
      pushProjectileExpireEvent(audioEvents, projEntity, config, shotBlueprintId);
    }
    queueProjectileRemoval(projEntity.id, projectilesToRemove, despawnEvents);
    return;
  }

  if ((terminalEffectFlags & PROJECTILE_TERMINAL_EFFECT_FLAG_APPLY_SPLASH) !== 0 && projShot.explosion) {
    const splashResult = damageSystem.applyDamage({
      type: 'area',
      sourceEntityId: proj.sourceEntityId,
      ownerId: projEntity.ownership.playerId,
      damage: projShot.explosion.damage,
      excludeEntities: getSplashExcludes(),
      center: { x: projEntity.transform.x, y: projEntity.transform.y, z: projEntity.transform.z },
      radius: projShot.explosion.radius,
      knockbackForce: projShot.explosion.force,
    });
    forceAccumulator?.addKnockbackForces(splashResult.knockbacks);
    collectKillsAndDeathContexts(
      splashResult, world, damageSourceKey, damageSourceType,
      unitsToRemove, buildingsToRemove, audioEvents, deathContexts,
      proj.sourceEntityId,
    );
    firstSplashHit = splashResult.hitEntityIds.length > 0
      ? world.getEntity(splashResult.hitEntityIds[0]) ?? undefined
      : undefined;
    if (depth < 8) {
      processKilledProjectileShots(
        splashResult,
        world,
        damageSystem,
        forceAccumulator,
        unitsToRemove,
        buildingsToRemove,
        audioEvents,
        deathContexts,
        newProjectiles,
        spawnEvents,
        projectilesToRemove,
        despawnEvents,
        depth + 1,
      );
    }
  }

  if ((terminalEffectFlags & PROJECTILE_TERMINAL_EFFECT_FLAG_EMIT_HIT_EVENT) !== 0) {
    audioEvents.push({
      type: 'hit',
      turretBlueprintId: shotBlueprintId,
      pos: { x: projEntity.transform.x, y: projEntity.transform.y, z: projEntity.transform.z },
      playerId: projEntity.ownership.playerId,
      entityId: projEntity.id,
      impactContext: buildImpactContext(
        config, projEntity.transform.x, projEntity.transform.y,
        proj.velocityX ?? 0, proj.velocityY ?? 0,
        runtimeProfile.radius.collision, firstSplashHit,
      ),
    });
  }

  if ((terminalEffectFlags & PROJECTILE_TERMINAL_EFFECT_FLAG_SPAWN_SUBMUNITIONS) !== 0) {
    spawnSubmunitions(
      world, projShot,
      projEntity.id, proj.shotSource,
      projEntity.transform.x, projEntity.transform.y, projEntity.transform.z,
      proj.velocityX ?? 0, proj.velocityY ?? 0, proj.velocityZ ?? 0,
      undefined, undefined, undefined,
      projEntity.ownership.playerId, proj.sourceEntityId,
      newProjectiles, spawnEvents,
    );
  }

  queueProjectileRemoval(projEntity.id, projectilesToRemove, despawnEvents);
}

function pushProjectileExpireEvent(
  audioEvents: SimEvent[],
  projEntity: Entity,
  config: ReturnType<typeof createProjectileConfigFromShot>,
  shotBlueprintId: string,
): void {
  const proj = projEntity.projectile;
  const ownership = projEntity.ownership;
  if (proj === null || ownership === null) return;
  const projRadius = config.shotProfile.runtime.radius.collision;
  audioEvents.push({
    type: 'projectileExpire',
    turretBlueprintId: shotBlueprintId,
    pos: { x: projEntity.transform.x, y: projEntity.transform.y, z: projEntity.transform.z },
    playerId: ownership.playerId,
    entityId: projEntity.id,
    impactContext: buildImpactContext(
      config, projEntity.transform.x, projEntity.transform.y,
      proj.velocityX ?? 0, proj.velocityY ?? 0,
      projRadius,
    ),
  });
}

/** Merged terminal classify + effect plan: ONE scalar WASM call per
 *  projectile (the count=1 batch pair it replaced marshalled ~35 slices).
 *  Applies the CLAMP_Z / SET_HP_ZERO side effects exactly as the batch
 *  wrapper did (out_z/out_hp are implied by those flags) and returns the
 *  shared `_terminalResult` scratch. */
function classifyAndPlanProjectileTerminal(
  world: WorldState,
  projEntity: Entity,
  terminalReflectorHit: boolean,
  directHitThisTick: boolean,
  reflectedProjectile: boolean,
  hitShield: boolean,
  waterSurfaceImpact = false,
): typeof _terminalResult {
  _terminalResult.reason = 0;
  _terminalResult.terminalFlags = 0;
  _terminalResult.effectFlags = 0;
  const proj = projEntity.projectile;
  if (proj === null) return _terminalResult;

  const config = proj.config;
  const runtimeProfile = config.shotProfile.runtime;
  const x = projEntity.transform.x;
  const y = projEntity.transform.y;
  const z = projEntity.transform.z;
  const groundZ = world.getGroundZ(x, y);
  const shotLocomotion = isProjectileShot(config.shot)
    ? config.shot.shotLocomotion
    : null;

  let bits = 0;
  if (proj.projectileType === 'projectile') bits |= TERMINAL_IN_IS_PROJECTILE_TYPE;
  if (proj.isArmed) bits |= TERMINAL_IN_IS_ARMED;
  if (proj.hasExploded) bits |= TERMINAL_IN_HAS_EXPLODED;
  if (shotLocomotion?.terminal.entityImpact === 'detonate') bits |= TERMINAL_IN_DETONATE_ON_ENTITY_IMPACT;
  if (shotLocomotion?.terminal.groundContact === 'detonate') bits |= TERMINAL_IN_DETONATE_ON_GROUND_CONTACT;
  if (shotLocomotion?.terminal.expiry === 'detonate') bits |= TERMINAL_IN_DETONATE_ON_EXPIRY;
  if (shotLocomotion?.terminal.destroyed === 'detonate') bits |= TERMINAL_IN_DETONATE_ON_DESTROYED;
  if (shotLocomotion?.terminal.reflectorImpact === 'detonate') bits |= TERMINAL_IN_DETONATE_ON_REFLECTOR_IMPACT;
  if (_collisionWaterSurfaceDetonateIds.has(projEntity.id)) bits |= TERMINAL_IN_DETONATE_ON_WATER_TRANSITION;
  if (runtimeProfile.hasExplosion || runtimeProfile.hasSubmunitions) bits |= TERMINAL_IN_HAS_DETONATION_PAYLOAD;
  if (directHitThisTick) bits |= TERMINAL_IN_DIRECT_HIT_THIS_TICK;
  if (reflectedProjectile) bits |= TERMINAL_IN_REFLECTED_PROJECTILE;
  if (hitShield) bits |= TERMINAL_IN_HIT_SHIELD;
  if (terminalReflectorHit) bits |= TERMINAL_IN_TERMINAL_REFLECTOR_HIT;
  if (isWaterAt(x, y, world.mapWidth, world.mapHeight)) bits |= TERMINAL_IN_WATER_AT_IMPACT;
  if (waterSurfaceImpact) bits |= TERMINAL_IN_WATER_SURFACE_IMPACT;
  if (
    isProjectileShot(config.shot) &&
    shotLocomotionCanOperateInWater(config.shot.shotLocomotion)
  ) {
    bits |= TERMINAL_IN_WATER_COMPATIBLE;
  }
  if (runtimeProfile.hasExplosion) bits |= TERMINAL_IN_HAS_EXPLOSION;
  if (runtimeProfile.hasSubmunitions) bits |= TERMINAL_IN_HAS_SUBMUNITIONS;
  const effectiveMaxLifespanMs = projectileEffectiveMaxLifespanMs(proj);
  const effectiveTimeAliveMs = proj.guidancePointReached
    ? effectiveMaxLifespanMs
    : proj.timeAlive;

  const sim = getSimWasm();
  if (sim === undefined) {
    throw new Error('Projectile terminal classification requires initialized sim-wasm');
  }
  const packed = sim.projectileTerminalSingle(
    bits,
    x,
    y,
    z,
    groundZ,
    proj.hp,
    effectiveTimeAliveMs,
    effectiveMaxLifespanMs,
    world.mapWidth,
    world.mapHeight,
    PROJECTILE_OUT_OF_BOUNDS_MARGIN,
  );
  const flags = (packed >>> 3) & 0x3f;
  if ((flags & PROJECTILE_TERMINAL_FLAG_CLAMP_Z) !== 0) {
    projEntity.transform.z = groundZ;
  }
  if ((flags & PROJECTILE_TERMINAL_FLAG_SET_HP_ZERO) !== 0) {
    proj.hp = 0;
  }
  _terminalResult.reason = packed & 0x7;
  _terminalResult.terminalFlags = flags;
  _terminalResult.effectFlags = (packed >>> 9) & 0xff;
  return _terminalResult;
}

// Check projectile collisions and apply damage.
// Friendly fire is enabled: traveling shots can hit any live unit,
// building, or projectile body after clearing their source.
export function checkProjectileCollisions(
  world: WorldState,
  dtMs: number,
  damageSystem: DamageSystem,
  forceAccumulator: ForceAccumulator | undefined = undefined,
  shouldSkipProjectile: ((id: EntityId) => boolean) | undefined = undefined,
): CollisionResult {
  // Reuse module-level containers (cleared each call)
  _collisionProjectilesToRemove.length = 0;
  _collisionProjectileRemoveIds.clear();
  _collisionWaterSurfaceImpactIds.clear();
  _collisionWaterSurfaceDetonateIds.clear();
  _collisionDespawnEvents.length = 0;
  _collisionUnitsToRemove.clear();
  _collisionBuildingsToRemove.clear();
  _collisionSimEvents.length = 0;
  _collisionDeathContexts.clear();
  _collisionNewProjectiles.length = 0;
  _collisionSpawnEvents.length = 0;
  const projectilesToRemove = _collisionProjectilesToRemove;
  const despawnEvents = _collisionDespawnEvents;
  const unitsToRemove = _collisionUnitsToRemove;
  const buildingsToRemove = _collisionBuildingsToRemove;
  const audioEvents = _collisionSimEvents;
  const deathContexts = _collisionDeathContexts;
  const newProjectiles = _collisionNewProjectiles;
  const spawnEvents = _collisionSpawnEvents;
  // Resolved once for the whole pass, tested per expiring beam below.
  const precisionTargetingMask = world.getPrecisionTargetingPlayerMask();
  let reflectorImpactEvents = 0;
  const collisionDtMs = dtMs;
  const projectileEntities = world.getProjectiles();
  beginProjectileSweepPass();
  refreshProjectileCollisionTurretMounts(world, dtMs);
  clipTerminalWaterTransitions(world, projectileEntities);
  computeProjectileReflectorHits(world, projectileEntities, collisionDtMs);
  SIM_TICK_INSTRUMENTATION.phase('combat.proj.reflector');

  for (let projectileOrdinal = 0; projectileOrdinal < projectileEntities.length; projectileOrdinal++) {
    const projEntity = projectileEntities[projectileOrdinal];
    if (!projEntity.projectile || !projEntity.ownership) continue;
    if (shouldSkipProjectile?.(projEntity.id) === true) continue;

    const proj = projEntity.projectile;
    const config = proj.config;
    // Projectile entities always use projectile/ray emission types (never shields).
    const shotBlueprintId = getEmissionBlueprintId(config.shot as ProjectileShot | BeamRay);
    const damageSourceKey = proj.sourceTurretBlueprintId ?? shotBlueprintId;
    const damageSourceType: SimEventSourceType = proj.sourceTurretBlueprintId ? 'turret' : 'system';
    const dgunProjectile = projEntity.dgunProjectile;
    const isDGunProjectile = dgunProjectile !== null && dgunProjectile.isDGun === true;
    const profile = config.shotProfile;
    const runtimeProfile = profile.runtime;
    if (proj.projectileType === 'projectile') {
      const sweepPrevX = proj.collisionStartX ?? proj.prevX ?? projEntity.transform.x;
      const sweepPrevY = proj.collisionStartY ?? proj.prevY ?? projEntity.transform.y;
      const sweepPrevZ = proj.collisionStartZ ?? proj.prevZ ?? projEntity.transform.z;
      if (!isValidProjectileSweep(
        sweepPrevX, sweepPrevY, sweepPrevZ,
        projEntity.transform.x, projEntity.transform.y, projEntity.transform.z,
      )) {
        queueProjectileRemoval(projEntity.id, projectilesToRemove, despawnEvents);
        continue;
      }
    }

    // Reflector contacts — shield panels and shield spheres are the
    // same reflector material. Normal traveling projectiles skip off the
    // surface with the same vector reflection math beams use; per-shot-type
    // behavior comes from the shield material. Beams are handled
    // by their own line path.
    let hitShield = false;
    let reflectedProjectile = false;
    let reflectorNormalX: number | undefined;
    let reflectorNormalY: number | undefined;
    let reflectorNormalZ: number | undefined;
    let reflectorPlayerId: number | undefined;
    let reflectorHitX = 0;
    let reflectorHitY = 0;
    let reflectorHitZ = 0;
    if (proj.projectileType === 'projectile') {
      let bestT = Infinity;
      let bestX = 0, bestY = 0, bestZ = 0;
      const reflectorKind = _reflectorHitKind[projectileOrdinal];
      if (reflectorKind !== REFLECTOR_HIT_KIND_NONE) {
        bestT = _reflectorHitT[projectileOrdinal];
        bestX = _reflectorHitX[projectileOrdinal];
        bestY = _reflectorHitY[projectileOrdinal];
        bestZ = _reflectorHitZ[projectileOrdinal];
        reflectorNormalX = _reflectorHitNormalX[projectileOrdinal];
        reflectorNormalY = _reflectorHitNormalY[projectileOrdinal];
        reflectorNormalZ = _reflectorHitNormalZ[projectileOrdinal];
        const reflectorEntityId = _reflectorHitEntityId[projectileOrdinal];
        if (reflectorEntityId >= 0) {
          const reflectorEntity = world.getEntity(reflectorEntityId);
          const reflectorOwnership = reflectorEntity !== undefined ? reflectorEntity.ownership : null;
          reflectorPlayerId = reflectorOwnership !== null ? reflectorOwnership.playerId : undefined;
        } else {
          reflectorPlayerId = undefined;
        }
        hitShield = reflectorKind === REFLECTOR_HIT_KIND_SHIELD;
      }
      if (bestT < Infinity) {
        if (_reflectorResponseReflected[projectileOrdinal] !== 0) {
          reflectorHitX = bestX;
          reflectorHitY = bestY;
          reflectorHitZ = bestZ;
          const reflectedX = _reflectorResponseOutVelocityX[projectileOrdinal];
          const reflectedY = _reflectorResponseOutVelocityY[projectileOrdinal];
          const reflectedZ = _reflectorResponseOutVelocityZ[projectileOrdinal];
          proj.velocityX = reflectedX;
          proj.velocityY = reflectedY;
          proj.velocityZ = reflectedZ;
          if (proj.guidanceMode === PROJECTILE_GUIDANCE_LOST_INTERCEPT_ALIGNED) {
            // Reflection is a discrete velocity change, so a previously
            // aligned lost-point rocket must spend steering work again.
            proj.guidanceMode = PROJECTILE_GUIDANCE_LOST_INTERCEPT_TURNING;
          }
          projEntity.transform.x = _reflectorResponsePosX[projectileOrdinal];
          projEntity.transform.y = _reflectorResponsePosY[projectileOrdinal];
          projEntity.transform.z = _reflectorResponsePosZ[projectileOrdinal];
          if (_reflectorResponseRotationChanged[projectileOrdinal] !== 0) {
            const previousRotation = projEntity.transform.rotation;
            projEntity.transform.rotation = _reflectorResponseRotation[projectileOrdinal];
            const dtSec = collisionDtMs / 1000;
            proj.angularVelocity = dtSec > 0
              ? normalizeAngle(projEntity.transform.rotation - previousRotation) / dtSec
              : 0;
          }
          proj.collisionStartX = projEntity.transform.x;
          proj.collisionStartY = projEntity.transform.y;
          proj.collisionStartZ = projEntity.transform.z;
          proj.prevX = projEntity.transform.x;
          proj.prevY = projEntity.transform.y;
          proj.prevZ = projEntity.transform.z;
          spatialGrid.updateProjectile(projEntity);
          reflectedProjectile = true;
          if (reflectorImpactEvents < MAX_REFLECTOR_IMPACT_EVENTS_PER_PASS) {
            reflectorImpactEvents++;
            pushReflectorImpactEvent(
              audioEvents,
              projEntity.id,
              reflectorHitX, reflectorHitY, reflectorHitZ,
              reflectorNormalX!, reflectorNormalY!, reflectorNormalZ!,
              reflectorPlayerId,
            );
          }
        } else {
          projEntity.transform.x = bestX;
          projEntity.transform.y = bestY;
          projEntity.transform.z = bestZ;
        }
      }
    }

    const terminalReflectorHit = hitShield && !reflectedProjectile;
    const hasCommittedPulseSample = proj.beamPulsePlan !== null && proj.beamDamageWindowMs > 0;
    // A pulse's final coarse sample lands exactly at maxLifespan. Let that
    // sample integrate its remaining damage window before the normal terminal
    // classifier removes the beam later in this same pass.
    const expiredBeforeDamage =
      (proj.guidancePointReached ||
        proj.timeAlive >= projectileEffectiveMaxLifespanMs(proj)) &&
      !hasCommittedPulseSample;
    const healthZeroBeforeDamage = proj.projectileType === 'projectile' && proj.hp <= 0;
    let directHitThisTick = false;
    let directHitSurfaceNormalX: number | undefined;
    let directHitSurfaceNormalY: number | undefined;
    let directHitSurfaceNormalZ: number | undefined;

    // Handle different projectile types.
    // Ground impact is checked after this block so a swept projectile
    // hitbox can stop on an entity it overlapped before reaching terrain.
    const waterSurfaceImpact =
      _collisionWaterSurfaceImpactIds.has(projEntity.id) &&
      !reflectedProjectile &&
      !terminalReflectorHit;
    const canApplyDamageThisTick =
      !waterSurfaceImpact &&
      !terminalReflectorHit &&
      !expiredBeforeDamage &&
      !healthZeroBeforeDamage &&
      (proj.beamPulsePlan === null || hasCommittedPulseSample);
    if (canApplyDamageThisTick && isRayType(proj.projectileType)) {
      if (proj.obstructionTick === undefined) {
        // A newly-created beam that has not received its first
        // authoritative trace should not deal endpoint damage at its
        // provisional max-range visual endpoint.
        continue;
      }
      // Beam damage: single area zone at truncated endpoint
      const beamShot = config.shot as BeamRay;
      const points = proj.points;
      const lastPoint = points && points.length >= 2 ? points[points.length - 1] : undefined;
      const impactX = lastPoint !== undefined ? lastPoint.x : projEntity.transform.x;
      const impactY = lastPoint !== undefined ? lastPoint.y : projEntity.transform.y;
      const impactZ = lastPoint !== undefined ? lastPoint.z : projEntity.transform.z;
      const dtSec = (proj.beamPulsePlan !== null ? proj.beamDamageWindowMs : collisionDtMs) / 1000;
      const outputMultiplier = proj.beamPulsePlan !== null
        ? BEAM_PULSE_ACTIVE_OUTPUT_MULTIPLIER
        : 1;

      const damageSphereRadius = runtimeProfile.radius.hitbox;
      if (!updateProjectileSourceClearance(
        world.getEntity(proj.sourceEntityId),
        proj,
        impactX, impactY, impactZ,
        runtimeProfile.radius.collision,
      )) {
        continue;
      }

      // Per-tick damage and force (DPS/force scaled by dt for framerate independence)
      const tickDamage = beamShot.dps * dtSec * outputMultiplier;
      const tickForce = beamShot.force * dtSec * outputMultiplier;

      // Beam direction for hit knockback
      const beamAngle = projEntity.transform.rotation;
      const beamDirX = DMath.cos(beamAngle);
      const beamDirY = DMath.sin(beamAngle);

      // Reflected beams: attribute damage/kills to the last reflector
      // entity that redirected the beam (= last polyline vertex with a
      // reflectorEntityId, a legacy field name). Points layout:
      // [start, ...reflections, end]; when the max-segment cap is hit,
      // the endpoint itself can be the terminal reflector.
      let lastMirrorEntityId: EntityId | undefined;
      if (points) {
        for (let i = points.length - 1; i >= 1; i--) {
          const mid = points[i].reflectorEntityId;
          if (mid !== null) { lastMirrorEntityId = mid; break; }
        }
      }
      const damageSourceId = lastMirrorEntityId ?? proj.sourceEntityId;
      const endpointDamageable = proj.endpointDamageable !== false;
      const result = endpointDamageable
        ? damageSystem.applyDamage({
            type: 'area',
            sourceEntityId: damageSourceId,
            ownerId: projEntity.ownership.playerId,
            damage: tickDamage,
            excludeEntities: _emptyExcludeSet,
            center: { x: impactX, y: impactY, z: impactZ },
            radius: damageSphereRadius,
            knockbackForce: tickForce,
          })
        : null;

      if (result) forceAccumulator?.addKnockbackForces(result.knockbacks);

      // Committed attack beams apply their equal-and-opposite recoil on the
      // same coarse integration windows as endpoint force. This preserves the
      // original sustained recoil over the 1-on/2-off duty cycle even if the
      // live target lock disappears during an already-fired pulse.
      if (
        proj.beamPulsePlan !== null &&
        beamShot.recoil > 0 &&
        points !== null &&
        points.length >= 2 &&
        forceAccumulator
      ) {
        const first = points[0];
        const second = points[1];
        const dx = second.x - first.x;
        const dy = second.y - first.y;
        const length = DMath.hypot(dx, dy);
        if (length > 1e-9) {
          const recoil = beamShot.recoil * PROJECTILE_MASS_MULTIPLIER * dtSec * outputMultiplier;
          forceAccumulator.addForce(
            proj.sourceEntityId,
            -(dx / length) * recoil,
            -(dy / length) * recoil,
            'recoil',
          );
        }
      }

      // Apply beam force (knockback only, no damage) to each reflector entity.
      // Walk segment-by-segment along the polyline; whenever a vertex
      // carries a reflectorEntityId, the segment ENTERING that vertex is
      // the incoming beam direction at that reflector.
      if (points && points.length > 1 && forceAccumulator) {
        for (let i = 1; i < points.length; i++) {
          const refl = points[i];
          if (refl.reflectorEntityId === null) continue;
          const prev = points[i - 1];
          const segDx = refl.x - prev.x;
          const segDy = refl.y - prev.y;
          const segLen = DMath.sqrt(segDx * segDx + segDy * segDy);
          if (segLen > 0) {
            const dirX = segDx / segLen;
            const dirY = segDy / segLen;
            forceAccumulator.addForce(refl.reflectorEntityId, dirX * tickForce, dirY * tickForce, 'beam');
          }
        }
      }

      if (result) {
        emitBeamHitAudio(result.hitEntityIds, world, proj, config, impactX, impactY, beamDirX, beamDirY, damageSphereRadius, audioEvents);
        collectKillsAndDeathContexts(
          result, world, damageSourceKey, damageSourceType,
          unitsToRemove, buildingsToRemove, audioEvents, deathContexts,
          proj.sourceEntityId,
        );
        processKilledProjectileShots(
          result,
          world,
          damageSystem,
          forceAccumulator,
          unitsToRemove,
          buildingsToRemove,
              audioEvents,
          deathContexts,
          newProjectiles,
          spawnEvents,
          projectilesToRemove,
          despawnEvents,
        );
      }

      // Committed attack-beam recoil is integrated above from the sampled
      // pulse path.
    } else if (canApplyDamageThisTick) {
      if (reflectedProjectile) {
        // Reflection already consumed this tick's swept segment. Start
        // the next collision sweep from the post-reflection position
        // so the projectile does not immediately direct-hit the
        // reflector it just skipped off.
        proj.collisionStartX = projEntity.transform.x;
        proj.collisionStartY = projEntity.transform.y;
        proj.collisionStartZ = projEntity.transform.z;
      } else {
        const projShot = config.shot as ProjectileShot;
        const projHitboxRadius = runtimeProfile.radius.hitbox;
        const projCollisionRadius = runtimeProfile.radius.collision;
        const prevX = proj.collisionStartX ?? proj.prevX ?? projEntity.transform.x;
        const prevY = proj.collisionStartY ?? proj.prevY ?? projEntity.transform.y;
        const prevZ = proj.collisionStartZ ?? proj.prevZ ?? projEntity.transform.z;
        const currentX = projEntity.transform.x;
        const currentY = projEntity.transform.y;
        const currentZ = projEntity.transform.z;

        if (!proj.isArmed) {
          proj.collisionStartX = currentX;
          proj.collisionStartY = currentY;
          proj.collisionStartZ = currentZ;
        } else {
          const hitEntities = proj.hitEntities;
          const hadSelfExclusion = hitEntities.has(projEntity.id);
          const previousTargetHitCount =
            getProjectileHitCount(proj) - (hadSelfExclusion ? 1 : 0);
          hitEntities.add(projEntity.id);

          if (!isDGunProjectile) {
            // Normal rockets/plasma sweep their authored hitbox through
            // entity hitboxes. This tests overlap volume rather than
            // only the projectile origin/centerline.
            const directHit = findProjectileHitboxSweepHit(
              world,
              projHitboxRadius,
              prevX, prevY, prevZ,
              currentX, currentY, currentZ,
              hitEntities,
            );
            if (directHit !== null) {
              directHitThisTick = true;
              const clampedT = Math.max(0, Math.min(1, directHit.t));
              projEntity.transform.x = prevX + clampedT * (currentX - prevX);
              projEntity.transform.y = prevY + clampedT * (currentY - prevY);
              projEntity.transform.z = prevZ + clampedT * (currentZ - prevZ);
              proj.hp = 0;
              ensureProjectileHitEntities(proj).add(directHit.entity.id);

              const hitProjectile = directHit.entity.projectile;
              const hitTravellingShot =
                hitProjectile !== null &&
                hitProjectile.projectileType === 'projectile' &&
                isProjectileShot(hitProjectile.config.shot);
              if (hitTravellingShot) {
                // Shot-vs-shot is mutual mid-air destruction, not a surface
                // impact: leave the surface normal unset so this parent's
                // submunitions run the momentum-continuation model, exactly
                // like the victim's below. Reflecting off the other round's
                // tiny hitbox normal made the spray direction depend on
                // which projectile's sweep happened to run first.
                if (hitProjectile.hp > 0) {
                  hitProjectile.hp = 0;
                  detonateKilledProjectileShot(
                    directHit.entity,
                    world,
                    damageSystem,
                    forceAccumulator,
                    unitsToRemove,
                    buildingsToRemove,
                    audioEvents,
                    deathContexts,
                    newProjectiles,
                    spawnEvents,
                    projectilesToRemove,
                    despawnEvents,
                    0,
                  );
                }
              } else {
                directHitSurfaceNormalX = directHit.normalX;
                directHitSurfaceNormalY = directHit.normalY;
                directHitSurfaceNormalZ = directHit.normalZ;
              }
            }
          } else {
            const result = damageSystem.applyDamage({
              type: 'swept',
              sourceEntityId: proj.sourceEntityId,
              ownerId: projEntity.ownership.playerId,
              damage: projShot.explosion !== undefined ? projShot.explosion.damage : 0,
              excludeEntities: hitEntities,
              excludeCommanders: true,
              prev: { x: prevX, y: prevY, z: prevZ },
              current: { x: currentX, y: currentY, z: currentZ },
              radius: projCollisionRadius,
              maxHits: Math.max(0, proj.maxHits - previousTargetHitCount),
              velocity: { x: proj.velocityX, y: proj.velocityY, z: proj.velocityZ },
              projectileMass: projShot.mass,
            });

            // Apply knockback from projectile hit
            forceAccumulator?.addKnockbackForces(result.knockbacks);
            // Note: Recoil for traveling projectiles is applied at fire time in fireTurrets()

            // Track hits
            for (const hitId of result.hitEntityIds) {
              ensureProjectileHitEntities(proj).add(hitId);

              const entity = world.getEntity(hitId);
              if (entity === undefined) continue;
              const hitProjectile = entity.projectile;
              if (
                hitProjectile !== null &&
                hitProjectile.projectileType === 'projectile' &&
                isProjectileShot(hitProjectile.config.shot)
              ) {
                hitProjectile.hp = 0;
                result.killedProjectileIds.add(entity.id);
              }
            }

            // Handle deaths from direct hit before any HP-zero detonation
            // below (result is reusable singleton).
            collectKillsAndDeathContexts(
              result, world, damageSourceKey, damageSourceType,
              unitsToRemove, buildingsToRemove, audioEvents, deathContexts,
              proj.sourceEntityId,
            );
            processKilledProjectileShots(
              result,
              world,
              damageSystem,
              forceAccumulator,
              unitsToRemove,
              buildingsToRemove,
              audioEvents,
              deathContexts,
              newProjectiles,
              spawnEvents,
              projectilesToRemove,
              despawnEvents,
            );
          }

          if (!hadSelfExclusion) {
            hitEntities.delete(projEntity.id);
          }

          proj.collisionStartX = currentX;
          proj.collisionStartY = currentY;
          proj.collisionStartZ = currentZ;
        }
      }
    }

    const terminal = classifyAndPlanProjectileTerminal(
      world,
      projEntity,
      terminalReflectorHit,
      directHitThisTick,
      reflectedProjectile,
      hitShield,
      waterSurfaceImpact,
    );
    const terminalGroundImpact =
      terminal.reason === PROJECTILE_TERMINAL_REASON_GROUND;
    const terminalEffectFlags = terminal.effectFlags;

    // Water hit — Rust classifies this as a silent terminal (no
    // explosion, no submunitions, no damage) and plans only the
    // returned visual event plus despawn diff for TypeScript to apply.
    if ((terminalEffectFlags & PROJECTILE_TERMINAL_EFFECT_FLAG_EMIT_WATER_SPLASH_EVENT) !== 0) {
      const projRadius = runtimeProfile.radius.collision;
      const splashMass = isProjectileShot(config.shot) ? config.shot.mass : projRadius;
      audioEvents.push({
        type: 'waterSplash',
        turretBlueprintId: shotBlueprintId,
        pos: { x: projEntity.transform.x, y: projEntity.transform.y, z: WATER_LEVEL },
        playerId: projEntity.ownership.playerId,
        entityId: projEntity.id,
        waterSplash: {
          velocity: {
            x: proj.velocityX ?? 0,
            y: proj.velocityY ?? 0,
            z: proj.velocityZ ?? 0,
          },
          mass: splashMass,
        },
        impactContext: buildImpactContext(
          config, projEntity.transform.x, projEntity.transform.y,
          proj.velocityX ?? 0, proj.velocityY ?? 0,
          projRadius,
        ),
      });
      queueProjectileRemoval(projEntity.id, projectilesToRemove, despawnEvents);
      continue;
    }

    if ((terminalEffectFlags & PROJECTILE_TERMINAL_EFFECT_FLAG_QUEUE_DESPAWN) !== 0) {
      // Beam audio is handled by updateLaserSounds based on targeting state
      if (
        (terminalEffectFlags & PROJECTILE_TERMINAL_EFFECT_FLAG_EMIT_REFLECTOR_IMPACT_EVENT) !== 0 &&
        reflectorNormalX !== undefined &&
        reflectorNormalY !== undefined &&
        reflectorNormalZ !== undefined &&
        reflectorImpactEvents < MAX_REFLECTOR_IMPACT_EVENTS_PER_PASS
      ) {
        reflectorImpactEvents++;
        pushReflectorImpactEvent(
          audioEvents,
          projEntity.id,
          projEntity.transform.x, projEntity.transform.y, projEntity.transform.z,
          reflectorNormalX, reflectorNormalY, reflectorNormalZ,
          reflectorPlayerId,
        );
      }

      if ((terminalEffectFlags & PROJECTILE_TERMINAL_EFFECT_FLAG_SET_EXPLODED) !== 0) {
        const projShot = config.shot as ProjectileShot;
        proj.hasExploded = true;
        let firstSplashHit: Entity | undefined;
        let splashHitCount = 0;

        if ((terminalEffectFlags & PROJECTILE_TERMINAL_EFFECT_FLAG_APPLY_SPLASH) !== 0 && projShot.explosion) {
          const splashExcludes = getSplashExcludes();
          // Single boolean AoE — every unit whose shot collider
          // intersects the explosion sphere takes the full damage
          // and full knockback force; nothing outside the sphere.
          const splashResult = damageSystem.applyDamage({
            type: 'area',
            sourceEntityId: proj.sourceEntityId,
            ownerId: projEntity.ownership.playerId,
            damage: projShot.explosion.damage,
            excludeEntities: splashExcludes,
            excludeCommanders: isDGunProjectile,
            center: { x: projEntity.transform.x, y: projEntity.transform.y, z: projEntity.transform.z },
            radius: projShot.explosion.radius,
            knockbackForce: projShot.explosion.force,
          });
          forceAccumulator?.addKnockbackForces(splashResult.knockbacks);
          collectKillsAndDeathContexts(
            splashResult, world, damageSourceKey, damageSourceType,
            unitsToRemove, buildingsToRemove, audioEvents, deathContexts,
            proj.sourceEntityId,
          );
          splashHitCount = splashResult.hitEntityIds.length;
          firstSplashHit = splashHitCount > 0 ? world.getEntity(splashResult.hitEntityIds[0]) ?? undefined : undefined;
          processKilledProjectileShots(
            splashResult,
            world,
            damageSystem,
            forceAccumulator,
            unitsToRemove,
            buildingsToRemove,
            audioEvents,
            deathContexts,
            newProjectiles,
            spawnEvents,
            projectilesToRemove,
            despawnEvents,
          );
        }

        // Detonation audio + explosion FX. Always emit when the
        // shot actually detonates (`hasExploded` was just set to
        // true above) — every projectile that explodes should LOOK
        // like it explodes, regardless of whether anything was in
        // splash range. The visual FX size comes from the shot's
        // own explosion radius via impactContext. Pure carriers
        // without an explosion still get a small fragmentation pop
        // sized by collision.radius.
        if ((terminalEffectFlags & PROJECTILE_TERMINAL_EFFECT_FLAG_EMIT_HIT_EVENT) !== 0) {
          audioEvents.push({
            type: 'hit',
            turretBlueprintId: shotBlueprintId,
            pos: { x: projEntity.transform.x, y: projEntity.transform.y, z: projEntity.transform.z },
            playerId: projEntity.ownership.playerId,
            entityId: projEntity.id,
            impactContext: buildImpactContext(
              config, projEntity.transform.x, projEntity.transform.y,
              proj.velocityX ?? 0, proj.velocityY ?? 0,
              runtimeProfile.radius.collision, firstSplashHit,
            ),
          });
        }

        // Cluster flak: spawn submunitions on detonation. Surface
        // deaths (shield reflector, entity body, ground) reflect the
        // parent's velocity across that surface; in-flight deaths
        // (shot down, shot-vs-shot, expiry) pass no normal so the
        // fragments carry the parent's momentum. See the
        // spawnSubmunitions doc for the full direction model.
        if ((terminalEffectFlags & PROJECTILE_TERMINAL_EFFECT_FLAG_SPAWN_SUBMUNITIONS) !== 0) {
          // Ground impact gets the actual surface tangent normal at
          // (x, y) — bilinear gradient of the heightmap, NOT a flat
          // (0, 0, 1). On a sloped ripple cube the bounce direction
          // tracks the slope, so cluster fragments spray AWAY from
          // the hill instead of always straight up.
          let surfaceNormalX: number | undefined;
          let surfaceNormalY: number | undefined;
          let surfaceNormalZ: number | undefined;
          if (terminalReflectorHit) {
            surfaceNormalX = reflectorNormalX;
            surfaceNormalY = reflectorNormalY;
            surfaceNormalZ = reflectorNormalZ;
          } else if (directHitThisTick) {
            surfaceNormalX = directHitSurfaceNormalX;
            surfaceNormalY = directHitSurfaceNormalY;
            surfaceNormalZ = directHitSurfaceNormalZ;
          } else if (terminalGroundImpact) {
            const n = getSurfaceNormal(
              projEntity.transform.x, projEntity.transform.y,
              world.mapWidth, world.mapHeight, LAND_CELL_SIZE,
            );
            surfaceNormalX = n.nx;
            surfaceNormalY = n.ny;
            surfaceNormalZ = n.nz;
          }
          spawnSubmunitions(
            world, projShot,
            projEntity.id, proj.shotSource,
            projEntity.transform.x, projEntity.transform.y, projEntity.transform.z,
            proj.velocityX ?? 0, proj.velocityY ?? 0, proj.velocityZ ?? 0,
            surfaceNormalX, surfaceNormalY, surfaceNormalZ,
            projEntity.ownership.playerId, proj.sourceEntityId,
            newProjectiles, spawnEvents,
          );
        }
      }

      if ((terminalEffectFlags & PROJECTILE_TERMINAL_EFFECT_FLAG_EMIT_EXPIRE_EVENT) !== 0) {
        pushProjectileExpireEvent(audioEvents, projEntity, config, shotBlueprintId);
      }

      queueProjectileRemoval(projEntity.id, projectilesToRemove, despawnEvents);
      continue;
    }
  }

  // Remove expired projectiles (and clean up beam index for any beams)
  projectilesToRemove.sort((a, b) => a - b);
  for (const id of projectilesToRemove) {
    const entity = world.getEntity(id);
    if (entity !== undefined && entity.projectile !== null && isRayType(entity.projectile.projectileType)) {
      const proj = entity.projectile;
      const weaponIdx = proj.config.turretIndex ?? 0;
      beamIndex.removeBeam(proj.sourceEntityId, weaponIdx);

      // For cooldown beams, start the cooldown now (after beam expires).
      // Cooldown is slab-owned: the scheduled targeting batch decrements
      // it next tick, so we write the post-expire value directly into
      // the slab. If the source despawned during the pulse there is no
      // cooldown to install, so that abandoned transition consumes no RNG.
      const source = world.getEntity(proj.sourceEntityId);
      if (source) {
        const sourcePlayerId = source.ownership?.playerId ?? (0 as PlayerId);
        const fireRandomness = firingRandomnessEnabled(precisionTargetingMask, sourcePlayerId);
        const cooldown = proj.beamPulsePlan !== null
          ? rollBeamPulseOffTimeMs(() => world.nextRandom(sourcePlayerId), fireRandomness)
          : rollTurretCooldownDuration(
              proj.config.cooldown,
              () => world.nextRandom(sourcePlayerId),
              fireRandomness,
            );
        if (cooldown > 0) {
          writeTurretCooldownToSlab(source, weaponIdx, cooldown);
        }
      }
    }
    world.removeEntity(id);
  }
  SIM_TICK_INSTRUMENTATION.phase('combat.proj.sweepTerminal');

  return {
    deadUnitIds: unitsToRemove,
    deadBuildingIds: buildingsToRemove,
    events: audioEvents,
    despawnEvents,
    deathContexts,
    newProjectiles,
    spawnEvents,
  };
}

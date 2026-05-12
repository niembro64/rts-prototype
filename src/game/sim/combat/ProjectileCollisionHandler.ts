// Projectile collision detection and damage application

import type { WorldState } from '../WorldState';
import type { Entity, EntityId, ProjectileShot, BeamShot, LaserShot } from '../types';
import { isLineShotType } from '../types';
import type { DamageSystem } from '../damage';
import type { ForceAccumulator } from '../ForceAccumulator';
import type {
  SimEvent,
  CollisionResult,
  ProjectileDespawnEvent,
  ProjectileSpawnEvent,
  ProjectileVelocityUpdateEvent,
  SimEventSourceType,
} from './types';
import type { TurretId } from '../../../types/blueprintIds';
import { beamIndex } from '../BeamIndex';
import type { DeathContext } from '../damage/types';
import { buildImpactContext, applyKnockbackForces, collectKillsWithDeathAudio, collectKillsAndDeathContexts, emitBeamHitAudio } from './damageHelpers';
import { findClosestPanelHit } from './MirrorPanelHit';
import { createProjectileConfigFromShot } from '../projectileConfigs';
import { getSurfaceNormal } from '../Terrain';
import { getSimDetailConfig } from '../simQuality';
import { spatialGrid } from '../SpatialGrid';
import { LAND_CELL_SIZE, ROCKET_REFLECTOR_COLLISION_MODE } from '../../../config';
import { getUnitGroundZ } from '../unitGeometry';
import { findForceFieldProjectileIntersection } from './forceFieldTurret';
import { getTransformCosSin } from '../../math';
import { resolveWeaponWorldMount, updateProjectileSourceClearance } from './combatUtils';

const MIRROR_PROJECTILE_QUERY_PAD = 96;
const MAX_PROJECTILE_SWEEP_DISTANCE = LAND_CELL_SIZE * 64;
const MAX_PROJECTILE_SWEEP_DISTANCE_SQ =
  MAX_PROJECTILE_SWEEP_DISTANCE * MAX_PROJECTILE_SWEEP_DISTANCE;
const MAX_REFLECTOR_IMPACT_EVENTS_PER_PASS = 96;

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

function pointSegmentDistanceSq3(
  px: number,
  py: number,
  pz: number,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
): number {
  const abx = bx - ax;
  const aby = by - ay;
  const abz = bz - az;
  const lenSq = abx * abx + aby * aby + abz * abz;
  if (lenSq <= 1e-9) {
    const dx = px - ax;
    const dy = py - ay;
    const dz = pz - az;
    return dx * dx + dy * dy + dz * dz;
  }
  const t = Math.max(
    0,
    Math.min(1, ((px - ax) * abx + (py - ay) * aby + (pz - az) * abz) / lenSq),
  );
  const cx = ax + abx * t;
  const cy = ay + aby * t;
  const cz = az + abz * t;
  const dx = px - cx;
  const dy = py - cy;
  const dz = pz - cz;
  return dx * dx + dy * dy + dz * dz;
}

// Reusable containers for checkProjectileCollisions (avoid per-frame allocations)
const _collisionUnitsToRemove = new Set<EntityId>();
const _collisionBuildingsToRemove = new Set<EntityId>();
const _collisionDeathContexts = new Map<EntityId, DeathContext>();
const _collisionProjectilesToRemove: EntityId[] = [];
const _collisionDespawnEvents: ProjectileDespawnEvent[] = [];
const _collisionSimEvents: SimEvent[] = [];
const _collisionNewProjectiles: Entity[] = [];
const _collisionSpawnEvents: ProjectileSpawnEvent[] = [];
const _collisionVelocityUpdates: ProjectileVelocityUpdateEvent[] = [];
const _mirrorProjectilePivot = { x: 0, y: 0, z: 0 };

// Reusable empty set for additive area damage (avoids allocating new Set per frame)
const _emptyExcludeSet = new Set<EntityId>();

// Reusable set for excluding the source entity from splash while projectile is still inside source
const _sourceExcludeSet = new Set<EntityId>();
function getSplashExcludes(proj: { hasLeftSource?: boolean; sourceEntityId: EntityId }): Set<EntityId> {
  if (proj.hasLeftSource) return _emptyExcludeSet;
  _sourceExcludeSet.clear();
  _sourceExcludeSet.add(proj.sourceEntityId);
  return _sourceExcludeSet;
}

function ensureProjectileHitEntities(proj: { hitEntities?: Set<EntityId> }): Set<EntityId> {
  return proj.hitEntities ?? (proj.hitEntities = new Set<EntityId>());
}

function getProjectileHitCount(proj: { hitEntities?: Set<EntityId> }): number {
  return proj.hitEntities?.size ?? 0;
}

function pushReflectorImpactEvent(
  audioEvents: SimEvent[],
  hitForceField: boolean,
  x: number,
  y: number,
  z: number,
  normalX: number,
  normalY: number,
  normalZ: number,
  playerId: number | undefined,
): void {
  audioEvents.push({
    type: 'forceFieldImpact',
    turretId: 'forceTurret',
    sourceType: 'turret',
    sourceKey: hitForceField ? 'forceTurret' : 'mirrorTurret',
    pos: { x, y, z },
    forceFieldImpact: {
      normal: { x: normalX, y: normalY, z: normalZ },
      playerId: playerId ?? 0,
    },
  });
}

function reflectVelocityPreserveSpeed(
  vx: number,
  vy: number,
  vz: number,
  normalX: number,
  normalY: number,
  normalZ: number,
): { x: number; y: number; z: number } | null {
  const speed = Math.hypot(vx, vy, vz);
  const nLen = Math.hypot(normalX, normalY, normalZ);
  if (speed <= 1e-9 || nLen <= 1e-9) return null;
  const nx = normalX / nLen;
  const ny = normalY / nLen;
  const nz = normalZ / nLen;
  const dot = vx * nx + vy * ny + vz * nz;
  let rx = vx - 2 * dot * nx;
  let ry = vy - 2 * dot * ny;
  let rz = vz - 2 * dot * nz;
  const rLen = Math.hypot(rx, ry, rz);
  if (rLen <= 1e-9) return null;
  const scale = speed / rLen;
  rx *= scale;
  ry *= scale;
  rz *= scale;
  return { x: rx, y: ry, z: rz };
}

// Reset collision-specific reusable buffers between game sessions
// (prevents stale entity references from surviving across sessions)
export function resetCollisionBuffers(): void {
  _collisionUnitsToRemove.clear();
  _collisionBuildingsToRemove.clear();
  _collisionDeathContexts.clear();
  _collisionProjectilesToRemove.length = 0;
  _collisionDespawnEvents.length = 0;
  _collisionSimEvents.length = 0;
  _collisionNewProjectiles.length = 0;
  _collisionSpawnEvents.length = 0;
  _collisionVelocityUpdates.length = 0;
}

/**
 * Spawn cluster submunitions when a projectile with `submunitions`
 * detonates. Each child inherits the parent's owner + sourceEntityId
 * so any further kills still credit the original shooter.
 *
 * Direction model — each submunition's launch velocity is:
 *
 *     surface hit: v = reflectedVelocity * reflectedVelocityDamper
 *                  + jitterDir         * randomSpreadSpeed
 *     airburst:    v = parentVelocity
 *                  + jitterDir * randomSpreadSpeed
 *
 * where `reflectedVelocity` is the parent's velocity reflected across
 * the impact surface (V − 2(V·N)N) and `jitterDir` is a random unit
 * 3D vector. The reflected component gives the cluster a "bounce off
 * the impact surface" feel; the jitter component gives each fragment
 * its own offset within a sphere of radius `randomSpreadSpeed` around
 * the base direction. Mid-air detonation (no surface normal) skips
 * both the reflection and the reflected-velocity damper, so fragments
 * start from the parent's position and velocity with only configured
 * random spread added.
 *
 * `surfaceNormalX/Y/Z` is the world-space surface normal at the
 * impact point (sim coords: z is up). Pass undefined for all three
 * when there is no surface (lifespan expiry mid-air).
 */
function spawnSubmunitions(
  world: WorldState,
  parentShot: ProjectileShot,
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
  sourceTurretId: TurretId | undefined,
  outProjectiles: Entity[],
  outSpawnEvents: ProjectileSpawnEvent[],
): void {
  const spec = parentShot.submunitions;
  if (!spec || spec.count <= 0) return;

  const childCfg = createProjectileConfigFromShot(spec.shotId, sourceTurretId);

  // Reflect the parent's velocity across the surface normal:
  //   bounce = V − 2(V·N)N
  // then scale by the spec's damper to model energy loss on impact
  // (1.0 = elastic bounce, 0.0 = velocity fully absorbed, default 1.0).
  // No valid normal (mid-air expiry) → inherit parent velocity directly.
  const reflectedVelocityDamper = spec.reflectedVelocityDamper ?? 1.0;
  let bounceVx = parentVx;
  let bounceVy = parentVy;
  let bounceVz = parentVz;
  if (
    surfaceNormalX !== undefined
    && surfaceNormalY !== undefined
    && surfaceNormalZ !== undefined
  ) {
    const normalLen2 =
      surfaceNormalX * surfaceNormalX
      + surfaceNormalY * surfaceNormalY
      + surfaceNormalZ * surfaceNormalZ;
    if (normalLen2 > 1e-9) {
      // Normalize n in case the caller passed an unnormalized vector.
      const normalInv = 1 / Math.sqrt(normalLen2);
      const normalX = surfaceNormalX * normalInv;
      const normalY = surfaceNormalY * normalInv;
      const normalZ = surfaceNormalZ * normalInv;
      const velocityDotNormal =
        parentVx * normalX + parentVy * normalY + parentVz * normalZ;
      bounceVx = (parentVx - 2 * velocityDotNormal * normalX) * reflectedVelocityDamper;
      bounceVy = (parentVy - 2 * velocityDotNormal * normalY) * reflectedVelocityDamper;
      bounceVz = (parentVz - 2 * velocityDotNormal * normalZ) * reflectedVelocityDamper;
    }
  }

  // Sim RNG isn't exposed here, so Math.random() drives the cosmetic
  // spread — submunition direction doesn't feed back into deterministic
  // sim state (damage / knockback come from the parent's detonation
  // and the fragments' own collisions, both of which use sim RNG).
  // Horizontal and vertical spread magnitudes are independent so a
  // shot can fan WIDE horizontally without launching half its fragments
  // straight up (or vice versa).
  const horizSpread = spec.randomSpreadSpeedHorizontal;
  const vertSpread = spec.randomSpreadSpeedVertical;
  for (let i = 0; i < spec.count; i++) {
    // Uniform random unit vector via 3D rejection sampling — gives
    // each fragment a different perturbation around the bounce
    // direction. Repeat-until-inside-unit-ball avoids the cube-bias
    // a naive (rand, rand, rand) would produce.
    let jitterDirX = 0;
    let jitterDirY = 0;
    let jitterDirZ = 0;
    let jitterLen2 = 0;
    do {
      jitterDirX = Math.random() * 2 - 1;
      jitterDirY = Math.random() * 2 - 1;
      jitterDirZ = Math.random() * 2 - 1;
      jitterLen2 =
        jitterDirX * jitterDirX
        + jitterDirY * jitterDirY
        + jitterDirZ * jitterDirZ;
    } while (jitterLen2 > 1 || jitterLen2 < 1e-6);
    const jitterInv = 1 / Math.sqrt(jitterLen2);
    jitterDirX *= jitterInv;
    jitterDirY *= jitterInv;
    jitterDirZ *= jitterInv;

    // Anisotropic scaling: horizontal speed for the XY component, a
    // separate vertical speed for Z. The unit-vector input keeps the
    // distribution shape uniform on the sphere; scaling per-axis
    // turns the random offset into an ellipsoid.
    const launchVx = bounceVx + horizSpread * jitterDirX;
    const launchVy = bounceVy + horizSpread * jitterDirY;
    const launchVz = bounceVz + vertSpread * jitterDirZ;

    const proj = world.createProjectile(
      detonationX, detonationY, launchVx, launchVy,
      ownerId, sourceEntityId, childCfg, 'projectile',
    );
    if (proj.projectile) {
      // Children start outside any source hitbox (parent already exploded).
      proj.projectile.hasLeftSource = true;
      // Inherit the parent's altitude at detonation; vertical velocity
      // from the bounce + perturbation is set on the projectile here so
      // gravity integrates from the right initial vz next tick.
      proj.transform.z = detonationZ;
      proj.projectile.velocityZ = launchVz;
      proj.projectile.lastSentVelZ = launchVz;
    }
    outProjectiles.push(proj);
    outSpawnEvents.push({
      id: proj.id,
      pos: { x: detonationX, y: detonationY, z: detonationZ },
      rotation: Math.atan2(launchVy, launchVx),
      velocity: { x: launchVx, y: launchVy, z: launchVz },
      projectileType: 'projectile',
      maxLifespan: proj.projectile?.maxLifespan,
      // Source/provenance remains the real turret; shotId tells the
      // client which child projectile blueprint to hydrate.
      turretId: sourceTurretId ?? '',
      shotId: spec.shotId,
      sourceTurretId,
      playerId: ownerId,
      sourceEntityId,
      turretIndex: 0,
      barrelIndex: 0,
      // Submunitions spawn AT the parent's detonation point, not at
      // the original shooter's turret launch origin.
      fromParentDetonation: true,
    });
  }
}

// Check projectile collisions and apply damage
// Friendly fire is enabled - projectiles hit ALL units and buildings
// Uses DamageSystem for unified collision detection (swept volumes, line damage, etc.)
export function checkProjectileCollisions(
  world: WorldState,
  dtMs: number,
  damageSystem: DamageSystem,
  forceAccumulator?: ForceAccumulator
): CollisionResult {
  // Reuse module-level containers (cleared each call)
  _collisionProjectilesToRemove.length = 0;
  _collisionDespawnEvents.length = 0;
  _collisionUnitsToRemove.clear();
  _collisionBuildingsToRemove.clear();
  _collisionSimEvents.length = 0;
  _collisionDeathContexts.clear();
  _collisionNewProjectiles.length = 0;
  _collisionSpawnEvents.length = 0;
  _collisionVelocityUpdates.length = 0;
  const projectilesToRemove = _collisionProjectilesToRemove;
  const despawnEvents = _collisionDespawnEvents;
  const unitsToRemove = _collisionUnitsToRemove;
  const buildingsToRemove = _collisionBuildingsToRemove;
  const audioEvents = _collisionSimEvents;
  const deathContexts = _collisionDeathContexts;
  const newProjectiles = _collisionNewProjectiles;
  const spawnEvents = _collisionSpawnEvents;
  const velocityUpdates = _collisionVelocityUpdates;
  let reflectorImpactEvents = 0;
  const projectileCollisionStride = Math.max(1, getSimDetailConfig().projectileCollisionStride | 0);
  const collisionDtMs = dtMs * projectileCollisionStride;
  const tick = world.getTick();

  for (const projEntity of world.getProjectiles()) {
    if (!projEntity.projectile || !projEntity.ownership) continue;

    const proj = projEntity.projectile;
    const config = proj.config;
    const processCollision = projectileCollisionStride === 1 ||
      ((projEntity.id + tick) % projectileCollisionStride) === 0;
    // Projectile entities always use projectile/beam/laser shot types (never force)
    const shotId = (config.shot as ProjectileShot | BeamShot | LaserShot).id;
    const damageSourceKey = proj.sourceTurretId ?? shotId;
    const damageSourceType: SimEventSourceType = proj.sourceTurretId ? 'turret' : 'system';
    const isDGunProjectile = projEntity.dgunProjectile?.isDGun === true;
    const isTerrainFollowingDGun = projEntity.dgunProjectile?.terrainFollow === true;
    const profile = config.shotProfile;
    const runtimeProfile = profile.runtime;
    const isRocketShot = runtimeProfile.isRocketLike;
    if (proj.projectileType === 'projectile') {
      const sweepPrevX = proj.collisionStartX ?? proj.prevX ?? projEntity.transform.x;
      const sweepPrevY = proj.collisionStartY ?? proj.prevY ?? projEntity.transform.y;
      const sweepPrevZ = proj.collisionStartZ ?? proj.prevZ ?? projEntity.transform.z;
      if (!isValidProjectileSweep(
        sweepPrevX, sweepPrevY, sweepPrevZ,
        projEntity.transform.x, projEntity.transform.y, projEntity.transform.z,
      )) {
        projectilesToRemove.push(projEntity.id);
        despawnEvents.push({ id: projEntity.id });
        continue;
      }
    }

    // Reflector contacts — mirror panels and force-field spheres are the
    // same reflector material. Normal traveling projectiles skip off the
    // surface with the same vector reflection math beams use; rocket-class
    // behavior is controlled by ROCKET_REFLECTOR_COLLISION_MODE. Beams/lasers
    // are handled by their own line path.
    let hitMirrorPanel = false;
    let hitForceField = false;
    let reflectedProjectile = false;
    let reflectorNormalX: number | undefined;
    let reflectorNormalY: number | undefined;
    let reflectorNormalZ: number | undefined;
    let reflectorPlayerId: number | undefined;
    let reflectorHitX = 0;
    let reflectorHitY = 0;
    let reflectorHitZ = 0;
    if (processCollision && proj.projectileType === 'projectile') {
      const prevX = proj.collisionStartX ?? proj.prevX ?? projEntity.transform.x;
      const prevY = proj.collisionStartY ?? proj.prevY ?? projEntity.transform.y;
      const prevZ = proj.collisionStartZ ?? proj.prevZ ?? projEntity.transform.z;
      const curX = projEntity.transform.x;
      const curY = projEntity.transform.y;
      const curZ = projEntity.transform.z;
      let bestT = Infinity;
      let bestX = 0, bestY = 0, bestZ = 0;
      if (world.mirrorsEnabled) {
        const mirrorCandidates = world.getMirrorUnits();
        const projectileRadius = runtimeProfile.collisionRadius;
        for (const u of mirrorCandidates) {
          if (u.id === proj.sourceEntityId) continue;
          if (!u.unit || u.unit.hp <= 0) continue;
          const panels = u.unit.mirrorPanels;
          if (!panels || panels.length === 0) continue;
          const mirrorBroadRadius =
            Math.max(u.unit.mirrorBoundRadius, u.unit.radius.shot) +
            projectileRadius +
            MIRROR_PROJECTILE_QUERY_PAD;
          if (
            pointSegmentDistanceSq3(
              u.transform.x, u.transform.y, u.transform.z,
              prevX, prevY, prevZ,
              curX, curY, curZ,
            ) > mirrorBroadRadius * mirrorBroadRadius
          ) {
            continue;
          }
          const uTurrets = u.combat?.turrets;
          const mirrorRot = uTurrets && uTurrets.length > 0
            ? uTurrets[0].rotation
            : u.transform.rotation;
          const mirrorPitch = uTurrets && uTurrets.length > 0
            ? uTurrets[0].pitch
            : 0;
          const groundZ = getUnitGroundZ(u);
          const uCS = getTransformCosSin(u.transform);
          const mirrorPivot = uTurrets && uTurrets.length > 0
            ? resolveWeaponWorldMount(
                u, uTurrets[0], 0,
                uCS.cos, uCS.sin,
                {
                  currentTick: world.getTick(),
                  unitGroundZ: groundZ,
                  surfaceN: u.unit.surfaceNormal,
                },
                _mirrorProjectilePivot,
              )
            : undefined;
          const hit = findClosestPanelHit(
            panels, mirrorRot, mirrorPitch,
            u.transform.x, u.transform.y, groundZ,
            prevX, prevY, prevZ, curX, curY, curZ,
            -1,
            mirrorPivot,
          );
          if (hit && hit.t < bestT) {
            bestT = hit.t;
            bestX = hit.x;
            bestY = hit.y;
            bestZ = hit.z;
            reflectorNormalX = hit.normalX;
            reflectorNormalY = hit.normalY;
            reflectorNormalZ = hit.normalZ;
            reflectorPlayerId = u.ownership?.playerId;
            hitMirrorPanel = true;
            hitForceField = false;
          }
        }
      }
      // Reflector contacts are checked geometrically, with no
      // projectile-owner/friendly filtering. The force-field mode selects
      // incoming, outgoing, or both boundary crossings.
      const shieldHit = world.forceFieldsEnabled
        ? findForceFieldProjectileIntersection(
            world,
            prevX, prevY, prevZ,
            curX, curY, curZ,
          )
        : null;
      if (shieldHit && shieldHit.t < bestT) {
        bestT = shieldHit.t;
        bestX = shieldHit.x;
        bestY = shieldHit.y;
        bestZ = shieldHit.z;
        reflectorNormalX = shieldHit.nx;
        reflectorNormalY = shieldHit.ny;
        reflectorNormalZ = shieldHit.nz;
        reflectorPlayerId = shieldHit.playerId;
        hitMirrorPanel = false;
        hitForceField = true;
      }
      if (bestT < Infinity) {
        const shouldReflectProjectile =
          !isRocketShot || ROCKET_REFLECTOR_COLLISION_MODE === 'reflect';
        const reflected = shouldReflectProjectile &&
          reflectorNormalX !== undefined &&
          reflectorNormalY !== undefined &&
          reflectorNormalZ !== undefined
          ? reflectVelocityPreserveSpeed(
              proj.velocityX, proj.velocityY, proj.velocityZ,
              reflectorNormalX, reflectorNormalY, reflectorNormalZ,
            )
          : null;
        if (reflected) {
          reflectorHitX = bestX;
          reflectorHitY = bestY;
          reflectorHitZ = bestZ;
          const remainingSec = Math.max(0, (collisionDtMs / 1000) * (1 - bestT));
          const nLen = Math.hypot(reflectorNormalX!, reflectorNormalY!, reflectorNormalZ!) || 1;
          const nx = reflectorNormalX! / nLen;
          const ny = reflectorNormalY! / nLen;
          const nz = reflectorNormalZ! / nLen;
          const surfaceOffset = Math.max(0.5, runtimeProfile.collisionRadius * 0.25);
          const reflectedNormalDot = reflected.x * nx + reflected.y * ny + reflected.z * nz;
          const offsetSign = reflectedNormalDot >= 0 ? 1 : -1;
          proj.velocityX = reflected.x;
          proj.velocityY = reflected.y;
          proj.velocityZ = reflected.z;
          projEntity.transform.x = bestX + nx * surfaceOffset * offsetSign + reflected.x * remainingSec;
          projEntity.transform.y = bestY + ny * surfaceOffset * offsetSign + reflected.y * remainingSec;
          projEntity.transform.z = bestZ + nz * surfaceOffset * offsetSign + reflected.z * remainingSec;
          if (Math.hypot(reflected.x, reflected.y) > 1e-6) {
            projEntity.transform.rotation = Math.atan2(reflected.y, reflected.x);
          }
          proj.collisionStartX = projEntity.transform.x;
          proj.collisionStartY = projEntity.transform.y;
          proj.collisionStartZ = projEntity.transform.z;
          proj.prevX = projEntity.transform.x;
          proj.prevY = projEntity.transform.y;
          proj.prevZ = projEntity.transform.z;
          updateProjectileSourceClearance(
            world.getEntity(proj.sourceEntityId),
            proj,
            projEntity.transform.x, projEntity.transform.y, projEntity.transform.z,
            runtimeProfile.collisionRadius,
          );
          proj.lastSentVelX = reflected.x;
          proj.lastSentVelY = reflected.y;
          proj.lastSentVelZ = reflected.z;
          spatialGrid.updateProjectile(projEntity);
          velocityUpdates.push({
            id: projEntity.id,
            pos: {
              x: projEntity.transform.x,
              y: projEntity.transform.y,
              z: projEntity.transform.z,
            },
            velocity: { x: reflected.x, y: reflected.y, z: reflected.z },
          });
          reflectedProjectile = true;
          if (reflectorImpactEvents < MAX_REFLECTOR_IMPACT_EVENTS_PER_PASS) {
            reflectorImpactEvents++;
            pushReflectorImpactEvent(
              audioEvents,
              hitForceField,
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

    // Ground impact — a traveling projectile whose center drops below
    // the ground plane is treated exactly like lifespan expiry: if the
    // shot has detonateOnExpiry the splash goes off at the impact point,
    // otherwise just a projectileExpire visual. Snap z to the local
    // terrain so splash AOE is centered ON the ground, not below it
    // — for tiles in the central ripple disc the snap can lift the
    // detonation 30+ units above absolute z=0. Beams and lasers can't
    // hit the ground (they're instantaneous lines, not falling shots)
    // so they skip this check.
    const groundZAtProj = world.getGroundZ(projEntity.transform.x, projEntity.transform.y);
    const hitGround =
      !reflectedProjectile &&
      !hitMirrorPanel &&
      !hitForceField &&
      proj.projectileType === 'projectile' &&
      !isTerrainFollowingDGun &&
      proj.hasLeftSource &&
      projEntity.transform.z <= groundZAtProj;
    if (hitGround) {
      projEntity.transform.z = groundZAtProj;
    }

    // Check if projectile expired (lifespan OR ground/barrier impact)
    const terminalReflectorHit = (hitMirrorPanel || hitForceField) && !reflectedProjectile;
    if (proj.timeAlive >= proj.maxLifespan || hitGround || terminalReflectorHit) {
      // Beam audio is handled by updateLaserSounds based on targeting state
      if (
        terminalReflectorHit &&
        reflectorNormalX !== undefined &&
        reflectorNormalY !== undefined &&
        reflectorNormalZ !== undefined &&
        reflectorImpactEvents < MAX_REFLECTOR_IMPACT_EVENTS_PER_PASS
      ) {
        reflectorImpactEvents++;
        pushReflectorImpactEvent(
          audioEvents,
          hitForceField,
          projEntity.transform.x, projEntity.transform.y, projEntity.transform.z,
          reflectorNormalX, reflectorNormalY, reflectorNormalZ,
          reflectorPlayerId,
        );
      }

      // Detonate on lifespan expiry when detonateOnExpiry is set AND the
      // shot has something to do at the apex (an explosion, submunitions,
      // or both). A pure carrier (no explosion, only submunitions) still
      // fragments here.
      if (runtimeProfile.detonateOnExpiry && proj.hasLeftSource && !proj.hasExploded) {
        const projShot = config.shot as ProjectileShot;
        const hasSplash = runtimeProfile.hasExplosion;
        const hasSubs = runtimeProfile.hasSubmunitions;
        if (hasSplash || hasSubs) {
          proj.hasExploded = true;
          let firstSplashHit: Entity | undefined;
          let splashHitCount = 0;

          if (hasSplash) {
            const splashExcludes = getSplashExcludes(proj);
            // Single boolean AoE — every unit whose shot collider
            // intersects the explosion sphere takes the full damage
            // and full knockback force; nothing outside the sphere.
            const splashResult = damageSystem.applyDamage({
              type: 'area',
              sourceEntityId: proj.sourceEntityId,
              ownerId: projEntity.ownership.playerId,
              damage: projShot.explosion!.damage,
              excludeEntities: splashExcludes,
              excludeCommanders: isDGunProjectile,
              center: { x: projEntity.transform.x, y: projEntity.transform.y, z: projEntity.transform.z },
              radius: projShot.explosion!.radius,
              knockbackForce: projShot.explosion!.force,
            });
            applyKnockbackForces(splashResult.knockbacks, forceAccumulator);
            collectKillsAndDeathContexts(
              splashResult, world, damageSourceKey, damageSourceType,
              unitsToRemove, buildingsToRemove, audioEvents, deathContexts,
              proj.sourceEntityId,
            );
            splashHitCount = splashResult.hitEntityIds.length;
            firstSplashHit = splashHitCount > 0 ? world.getEntity(splashResult.hitEntityIds[0]) ?? undefined : undefined;
          }

          // Detonation audio + explosion FX. Always emit when the
          // shot actually detonates (`hasExploded` was just set to
          // true above) — every projectile that explodes should LOOK
          // like it explodes, regardless of whether anything was in
          // splash range. The visual FX size comes from the shot's
          // own explosion radius via impactContext. Pure carriers
          // without an explosion still get a small fragmentation pop
          // sized by collision.radius.
          audioEvents.push({
            type: 'hit',
            turretId: shotId,
            pos: { x: projEntity.transform.x, y: projEntity.transform.y, z: projEntity.transform.z },
            impactContext: buildImpactContext(
              config, projEntity.transform.x, projEntity.transform.y,
              proj.velocityX ?? 0, proj.velocityY ?? 0,
              runtimeProfile.collisionRadius, firstSplashHit,
            ),
          });

          // Cluster flak: spawn submunitions on detonation. The
          // bounce-direction is computed from the parent's velocity
          // reflected across the impact surface — ground hit (z=0)
          // gets a vertical normal so submunitions spray upward in
          // the direction the carrier was flying, mid-air expiry
          // passes no normal so fragments just inherit the parent's
          // forward velocity with random spread.
          if (hasSubs) {
            // Ground impact gets the actual surface tangent normal at
            // (x, y) — bilinear gradient of the heightmap, NOT a flat
            // (0, 0, 1). On a sloped ripple cube the bounce direction
            // tracks the slope, so cluster fragments spray AWAY from
            // the hill instead of always straight up. Mid-air expiry
            // (no ground hit) passes undefined so fragments inherit
            // forward velocity.
            let surfaceNormalX: number | undefined;
            let surfaceNormalY: number | undefined;
            let surfaceNormalZ: number | undefined;
            if (terminalReflectorHit) {
              surfaceNormalX = reflectorNormalX;
              surfaceNormalY = reflectorNormalY;
              surfaceNormalZ = reflectorNormalZ;
            } else if (hitGround) {
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
              projEntity.transform.x, projEntity.transform.y, projEntity.transform.z,
              proj.velocityX ?? 0, proj.velocityY ?? 0, proj.velocityZ ?? 0,
              surfaceNormalX, surfaceNormalY, surfaceNormalZ,
              projEntity.ownership.playerId, proj.sourceEntityId, proj.sourceTurretId,
              newProjectiles, spawnEvents,
            );
          }
        }
      }

      // Add projectile expire event for traveling projectiles (not beams)
      // This creates an explosion effect at projectile termination point
      if (proj.projectileType === 'projectile' && proj.hasLeftSource && !proj.hasExploded) {
        const projRadius = runtimeProfile.collisionRadius;
        audioEvents.push({
          type: 'projectileExpire',
          turretId: shotId,
          pos: { x: projEntity.transform.x, y: projEntity.transform.y, z: projEntity.transform.z },
          impactContext: buildImpactContext(
            config, projEntity.transform.x, projEntity.transform.y,
            proj.velocityX ?? 0, proj.velocityY ?? 0,
            projRadius,
          ),
        });
      }

      projectilesToRemove.push(projEntity.id);
      despawnEvents.push({ id: projEntity.id });
      continue;
    }

    // Handle different projectile types with unified damage system
    if (isLineShotType(proj.projectileType)) {
      if (!processCollision) {
        // Beam endpoints still update every tick in updateProjectiles();
        // only the expensive damage query is staggered under server LOD.
      } else {
        if (proj.obstructionTick === undefined) {
          // Path tracing is globally budgeted. A newly-created beam that
          // has not received its first authoritative trace should not deal
          // endpoint damage at its provisional max-range visual endpoint.
          continue;
        }
        // Beam/laser damage: single area zone at truncated endpoint
        const beamShot = config.shot as BeamShot | LaserShot;
        const points = proj.points;
        const lastPoint = points && points.length >= 2 ? points[points.length - 1] : undefined;
        const impactX = lastPoint?.x ?? projEntity.transform.x;
        const impactY = lastPoint?.y ?? projEntity.transform.y;
        const impactZ = lastPoint?.z ?? projEntity.transform.z;
        const dtSec = collisionDtMs / 1000;

        const damageSphereRadius = runtimeProfile.damageRadius;
        if (!updateProjectileSourceClearance(
          world.getEntity(proj.sourceEntityId),
          proj,
          impactX, impactY, impactZ,
          runtimeProfile.collisionRadius,
        )) {
          continue;
        }

        // Per-tick damage and force (DPS/force scaled by dt for framerate independence)
        const tickDamage = beamShot.dps * dtSec;
        const tickForce = beamShot.force * dtSec;

        // Beam direction for hit knockback
        const beamAngle = projEntity.transform.rotation;
        const beamDirX = Math.cos(beamAngle);
        const beamDirY = Math.sin(beamAngle);

        // Reflected beams: attribute damage/kills to the last reflector
        // entity that redirected the beam (= last polyline vertex with a
        // mirrorEntityId, a legacy field name). Points layout:
        // [start, ...reflections, end]; when the max-segment cap is hit,
        // the endpoint itself can be the terminal reflector.
        let lastMirrorEntityId: EntityId | undefined;
        if (points) {
          for (let i = points.length - 1; i >= 1; i--) {
            const mid = points[i].mirrorEntityId;
            if (mid !== undefined) { lastMirrorEntityId = mid; break; }
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

        if (result) applyKnockbackForces(result.knockbacks, forceAccumulator);

        // Apply beam force (knockback only, no damage) to each reflector entity.
        // Walk segment-by-segment along the polyline; whenever a vertex
        // carries a mirrorEntityId, the segment ENTERING that vertex is
        // the incoming beam direction at that reflector.
        if (points && points.length > 1 && forceAccumulator) {
          for (let i = 1; i < points.length; i++) {
            const refl = points[i];
            if (refl.mirrorEntityId === undefined) continue;
            const prev = points[i - 1];
            const segDx = refl.x - prev.x;
            const segDy = refl.y - prev.y;
            const segLen = Math.sqrt(segDx * segDx + segDy * segDy);
            if (segLen > 0) {
              const dirX = segDx / segLen;
              const dirY = segDy / segLen;
              forceAccumulator.addForce(refl.mirrorEntityId, dirX * tickForce, dirY * tickForce, 'beam');
            }
          }
        }

        if (result) {
          emitBeamHitAudio(result.hitEntityIds, world, proj, config, impactX, impactY, beamDirX, beamDirY, damageSphereRadius, audioEvents);
          collectKillsWithDeathAudio(
            result, world, damageSourceKey, damageSourceType,
            unitsToRemove, buildingsToRemove, audioEvents, deathContexts,
            proj.sourceEntityId,
          );
        }

        // Note: beam recoil is applied in fireTurrets() based on weapon.state
      }
    } else {
      if (reflectedProjectile) {
        // Reflection already consumed this tick's swept segment. Start
        // the next collision sweep from the post-reflection position
        // so the projectile does not immediately direct-hit the
        // reflector it just skipped off.
        proj.collisionStartX = projEntity.transform.x;
        proj.collisionStartY = projEntity.transform.y;
        proj.collisionStartZ = projEntity.transform.z;
      } else if (!processCollision) {
        // Keep collisionStart intact so the next processed tick sweeps
        // the full skipped path instead of only the most recent segment.
      } else {
        // Traveling projectiles use swept 3D volume collision (prevents tunneling)
        const projShot = config.shot as ProjectileShot;
        const projRadius = runtimeProfile.collisionRadius;
        const prevX = proj.collisionStartX ?? proj.prevX ?? projEntity.transform.x;
        const prevY = proj.collisionStartY ?? proj.prevY ?? projEntity.transform.y;
        const prevZ = proj.collisionStartZ ?? proj.prevZ ?? projEntity.transform.z;
        const currentX = projEntity.transform.x;
        const currentY = projEntity.transform.y;
        const currentZ = projEntity.transform.z;

        // Source arming guard: while the round is still inside its
        // firing unit's shot-clearance volume, do not run swept entity
        // collision at all. Large chassis + multi-barrel turrets can
        // spawn some barrels inside the source collider; excluding only
        // the source still let carrier shots detonate instantly on nearby
        // units in a crowded formation.
        if (!proj.hasLeftSource) {
          proj.collisionStartX = currentX;
          proj.collisionStartY = currentY;
          proj.collisionStartZ = currentZ;
        } else {
          const hitEntities = proj.hitEntities ?? _emptyExcludeSet;

          // 3D swept: capsule from prev→current (the projectile's flight
          // path this tick) vs each unit sphere. Normal projectiles keep
          // direct damage at 0 and detonate on first hit. D-gun waves are
          // terrain-following passthrough projectiles, so their swept
          // capsule is the damage source and commanders are immune.
          const result = damageSystem.applyDamage({
            type: 'swept',
            sourceEntityId: proj.sourceEntityId,
            ownerId: projEntity.ownership.playerId,
            damage: isDGunProjectile ? (projShot.explosion?.damage ?? 0) : 0,
            excludeEntities: hitEntities,
            excludeCommanders: isDGunProjectile,
            prev: { x: prevX, y: prevY, z: prevZ },
            current: { x: currentX, y: currentY, z: currentZ },
            radius: projRadius,
            maxHits: proj.maxHits - getProjectileHitCount(proj),
            velocity: { x: proj.velocityX, y: proj.velocityY, z: proj.velocityZ },
            projectileMass: projShot.mass,
          });

          // Apply knockback from projectile hit
          applyKnockbackForces(result.knockbacks, forceAccumulator);
          // Note: Recoil for traveling projectiles is applied at fire time in fireTurrets()

          // Track hits
          for (const hitId of result.hitEntityIds) {
            ensureProjectileHitEntities(proj).add(hitId);

            // Add hit audio event with impact context for directional flame explosions
            // Position at the projectile's location (not the unit's center)
            const entity = world.getEntity(hitId);
            if (entity && !isDGunProjectile) {
              audioEvents.push({
                type: 'hit',
                turretId: shotId,
                pos: { x: projEntity.transform.x, y: projEntity.transform.y, z: projEntity.transform.z },
                impactContext: buildImpactContext(
                  config, projEntity.transform.x, projEntity.transform.y,
                  proj.velocityX ?? 0, proj.velocityY ?? 0,
                  projRadius, entity,
                ),
              });
            }
          }

          // Handle deaths from direct hit BEFORE splash (result is reusable singleton)
          const hadHits = result.hitEntityIds.length > 0;
          collectKillsWithDeathAudio(
            result, world, damageSourceKey, damageSourceType,
            unitsToRemove, buildingsToRemove, audioEvents, deathContexts,
            proj.sourceEntityId,
          );

          // Detonate on direct hit when the shot has either an explosion
          // or submunitions to release. A carrier with both applies its
          // own splash first, then releases children from the same point.
          if (!isDGunProjectile && hadHits && !proj.hasExploded
              && (runtimeProfile.hasExplosion || runtimeProfile.hasSubmunitions)) {
            proj.hasExploded = true;

            if (runtimeProfile.hasExplosion && projShot.explosion) {
              const splashExcludes = getSplashExcludes(proj);
              // Single boolean AoE — everyone whose shot collider
              // intersects the explosion sphere eats the full damage and
              // full force. The directly-hit target is included
              // (additive on top of its direct-hit damage).
              const splash = damageSystem.applyDamage({
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

              applyKnockbackForces(splash.knockbacks, forceAccumulator);
              collectKillsAndDeathContexts(
                splash, world, damageSourceKey, damageSourceType,
                unitsToRemove, buildingsToRemove, audioEvents, deathContexts,
                proj.sourceEntityId,
              );
            }

            // Cluster flak: spawn submunitions on detonation. Surface
            // normal at the impact point points from the hit entity's
            // center outward to the projectile, so the bounce direction
            // sprays fragments AWAY from the unit (or building) rather
            // than INTO it. Falls back to "no normal" when the hit
            // entity isn't resolvable (rare — would only happen if it
            // was removed mid-tick), in which case fragments just inherit
            // forward velocity with random spread.
            if (projShot.submunitions) {
              let surfaceNormalX: number | undefined;
              let surfaceNormalY: number | undefined;
              let surfaceNormalZ: number | undefined;
              const hitEntity = result.hitEntityIds.length > 0
                ? world.getEntity(result.hitEntityIds[0])
                : undefined;
              if (hitEntity) {
                // Outward normal at the hit point = unit-center → projectile.
                surfaceNormalX = projEntity.transform.x - hitEntity.transform.x;
                surfaceNormalY = projEntity.transform.y - hitEntity.transform.y;
                surfaceNormalZ = projEntity.transform.z - hitEntity.transform.z;
              }
              spawnSubmunitions(
                world, projShot,
                projEntity.transform.x, projEntity.transform.y, projEntity.transform.z,
                proj.velocityX ?? 0, proj.velocityY ?? 0, proj.velocityZ ?? 0,
                surfaceNormalX, surfaceNormalY, surfaceNormalZ,
                projEntity.ownership.playerId, proj.sourceEntityId, proj.sourceTurretId,
                newProjectiles, spawnEvents,
              );
            }
          }

          // Remove projectile if max hits reached
          if (getProjectileHitCount(proj) >= proj.maxHits) {
            // Always emit projectileExpire at the projectile's position so it produces a termination explosion
            audioEvents.push({
              type: 'projectileExpire',
              turretId: shotId,
              pos: { x: projEntity.transform.x, y: projEntity.transform.y, z: projEntity.transform.z },
              impactContext: buildImpactContext(
                config, projEntity.transform.x, projEntity.transform.y,
                proj.velocityX ?? 0, proj.velocityY ?? 0,
                projRadius,
              ),
            });
            projectilesToRemove.push(projEntity.id);
            despawnEvents.push({ id: projEntity.id });
            continue;
          }
          proj.collisionStartX = currentX;
          proj.collisionStartY = currentY;
          proj.collisionStartZ = currentZ;
        }
      }
    }

    // Check if projectile is out of bounds
    const margin = 100;
    if (
      projEntity.transform.x < -margin ||
      projEntity.transform.x > world.mapWidth + margin ||
      projEntity.transform.y < -margin ||
      projEntity.transform.y > world.mapHeight + margin
    ) {
      projectilesToRemove.push(projEntity.id);
      despawnEvents.push({ id: projEntity.id });
    }
  }

  // Remove expired projectiles (and clean up beam index for any beams)
  for (const id of projectilesToRemove) {
    const entity = world.getEntity(id);
    if (entity?.projectile && isLineShotType(entity.projectile.projectileType)) {
      const proj = entity.projectile;
      const weaponIdx = proj.config.turretIndex ?? 0;
      beamIndex.removeBeam(proj.sourceEntityId, weaponIdx);

      // For cooldown beams, start the cooldown now (after beam expires)
      const cooldown = proj.config.cooldown;
      if (cooldown > 0) {
        const source = world.getEntity(proj.sourceEntityId);
        if (source?.combat) {
          const weapon = source.combat.turrets[weaponIdx];
          if (weapon) {
            weapon.cooldown = cooldown;
          }
        }
      }
    }
    world.removeEntity(id);
  }

  return {
    deadUnitIds: unitsToRemove,
    deadBuildingIds: buildingsToRemove,
    events: audioEvents,
    despawnEvents,
    velocityUpdates,
    deathContexts,
    newProjectiles,
    spawnEvents,
  };
}

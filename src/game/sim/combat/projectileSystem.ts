// Projectile system - firing, movement, and beam updates

import type { WorldState } from '../WorldState';
import type { Entity, EntityId, ProjectileShot, BeamShot, LaserShot } from '../types';
import { isLineShot } from '../types';
import type { DamageSystem } from '../damage';
import type { ForceAccumulator } from '../ForceAccumulator';
import type { FireTurretsResult, ProjectileSpawnEvent, ProjectileDespawnEvent } from './types';
import { beamIndex } from '../BeamIndex';
import { getTransformCosSin, applyHomingSteering } from '../../math';
import { PROJECTILE_MASS_MULTIPLIER, SNAPSHOT_CONFIG } from '../../../config';
import { getWasmEngine, getWasmMemory } from '../../server/WasmBatch';
import { getBarrelTipOffset, resolveWeaponWorldPos, getBarrelTipWorldPos } from './combatUtils';
import { resetCollisionBuffers } from './ProjectileCollisionHandler';

export { checkProjectileCollisions } from './ProjectileCollisionHandler';

// Reusable arrays for fireTurrets (avoids per-frame allocation)
const _fireNewProjectiles: Entity[] = [];
const _fireSimEvents: import('./types').SimEvent[] = [];
const _fireSpawnEvents: ProjectileSpawnEvent[] = [];

// Reset module-level reusable buffers between game sessions
// (prevents stale entity references from surviving across sessions)
export function resetProjectileBuffers(): void {
  resetCollisionBuffers();
  _fireNewProjectiles.length = 0;
  _fireSimEvents.length = 0;
  _fireSpawnEvents.length = 0;
  _homingVelocityUpdates.length = 0;
}

// Check if a specific weapon has an active beam (by weapon index)
// Uses O(1) beam index lookup instead of O(n) projectile scan
function hasActiveWeaponBeam(_world: WorldState, unitId: EntityId, turretIndex: number): boolean {
  return beamIndex.hasActiveBeam(unitId, turretIndex);
}

// Fire weapons at targets - unified for all units
// Each weapon fires independently based on its own state
export function fireTurrets(world: WorldState, dtMs: number, forceAccumulator?: ForceAccumulator): FireTurretsResult {
  _fireNewProjectiles.length = 0;
  _fireSimEvents.length = 0;
  _fireSpawnEvents.length = 0;
  const newProjectiles = _fireNewProjectiles;
  const audioEvents = _fireSimEvents;
  const spawnEvents = _fireSpawnEvents;

  for (const unit of world.getUnits()) {
    if (!unit.ownership || !unit.unit || !unit.turrets) continue;
    if (unit.unit.hp <= 0) continue;

    const playerId = unit.ownership.playerId;
    const { cos: unitCos, sin: unitSin } = getTransformCosSin(unit.transform);

    // Fire each weapon independently
    for (let weaponIndex = 0; weaponIndex < unit.turrets.length; weaponIndex++) {
      const weapon = unit.turrets[weaponIndex];
      const config = weapon.config;
      const shot = config.shot;
      if (shot.type === 'force') continue; // Force fields don't create projectiles
      if (config.passive) continue; // Passive turrets track/engage but never fire
      const isBeamWeapon = isLineShot(shot);

      // Skip if weapon is not engaged (target not in range or no target)
      if (weapon.state !== 'engaged') continue;

      // Apply beam recoil only while the beam is actually active
      if (isBeamWeapon && forceAccumulator && (shot as BeamShot | LaserShot).recoil && hasActiveWeaponBeam(world, unit.id, weaponIndex)) {
        const dtSec = dtMs / 1000;
        const knockBackPerTick = (shot as BeamShot | LaserShot).recoil * PROJECTILE_MASS_MULTIPLIER * dtSec;
        const turretAngle = weapon.rotation;
        const dirX = Math.cos(turretAngle);
        const dirY = Math.sin(turretAngle);
        forceAccumulator.addForce(unit.id, -dirX * knockBackPerTick, -dirY * knockBackPerTick, 'recoil');
      }

      const target = world.getEntity(weapon.target!);
      if (!target) {
        weapon.target = null;
        weapon.state = 'idle';
        continue;
      }

      // Use cached weapon world position from targeting phase
      const weaponWP = resolveWeaponWorldPos(weapon, unit.transform.x, unit.transform.y, unitCos, unitSin);
      const weaponX = weaponWP.x, weaponY = weaponWP.y;

      // Check cooldown / active beam
      if (shot.type === 'beam') {
        if (hasActiveWeaponBeam(world, unit.id, weaponIndex)) continue;
      } else {
        const canFire = weapon.cooldown <= 0;
        const canBurstFire = weapon.burst?.remaining !== undefined &&
          weapon.burst.remaining > 0 &&
          (weapon.burst.cooldown === undefined || weapon.burst.cooldown <= 0);

        if (!canFire && !canBurstFire) continue;

        if (shot.type === 'laser' && hasActiveWeaponBeam(world, unit.id, weaponIndex)) continue;
      }

      // Handle cooldowns
      // For laser shots, cooldown is set when the beam expires (not at fire time),
      // so the gap between shots = beamDuration + cooldown.
      if (shot.type !== 'beam') {
        const canFire = weapon.cooldown <= 0;
        const canBurstFire = weapon.burst?.remaining !== undefined &&
          weapon.burst.remaining > 0 &&
          (weapon.burst.cooldown === undefined || weapon.burst.cooldown <= 0);

        if (canBurstFire && weapon.burst?.remaining !== undefined) {
          weapon.burst!.remaining--;
          weapon.burst!.cooldown = config.burst?.delay ?? 80;
          if (weapon.burst!.remaining <= 0) {
            weapon.burst = undefined;
          }
        } else if (canFire && shot.type !== 'laser') {
          weapon.cooldown = config.cooldown;
          if (config.burst?.count && config.burst.count > 1) {
            weapon.burst = { remaining: config.burst.count - 1, cooldown: config.burst?.delay ?? 80 };
          }
        }
      }

      // Add fire event (skip continuous beams — they use start/stop lifecycle)
      if (shot.type !== 'beam') {
        audioEvents.push({
          type: 'fire',
          turretId: config.id,
          pos: { x: weaponX, y: weaponY },
        });
      }

      // Fire the weapon in turret direction
      const turretAngle = weapon.rotation;

      // Create projectile(s)
      const pellets = config.spread?.pelletCount ?? 1;
      const spreadAngle = config.spread?.angle ?? 0;
      const barrelOffset = getBarrelTipOffset(config, unit.unit.unitRadiusCollider.shot);

      for (let i = 0; i < pellets; i++) {
        // Calculate spread — each pellet gets a random angle within the cone
        let angle = turretAngle;
        if (spreadAngle > 0) {
          angle += (world.rng.next() - 0.5) * spreadAngle;
        }

        const fireCos = Math.cos(angle);
        const fireSin = Math.sin(angle);

        // Spawn position at barrel tip
        const spawnX = weaponX + fireCos * barrelOffset;
        const spawnY = weaponY + fireSin * barrelOffset;

        if (isBeamWeapon) {
          // Create beam using weapon's fireRange
          const beamLength = weapon.ranges.engage.acquire;
          const endX = spawnX + fireCos * beamLength;
          const endY = spawnY + fireSin * beamLength;

          // Tag config with turretIndex for beam tracking (mutate in place — each weapon has its own config copy)
          config.turretIndex = weaponIndex;
          const beamProjectileType = shot.type === 'laser' ? 'laser' as const : 'beam' as const;
          const beam = world.createBeam(spawnX, spawnY, endX, endY, playerId, unit.id, config, beamProjectileType);
          if (beam.projectile) {
            beam.projectile.sourceEntityId = unit.id;
          }
          // Register beam in index immediately (no need for full rebuild)
          beamIndex.addBeam(unit.id, weaponIndex, beam.id);
          newProjectiles.push(beam);
          spawnEvents.push({
            id: beam.id,
            pos: { x: spawnX, y: spawnY }, rotation: angle,
            velocity: { x: 0, y: 0 },
            projectileType: beamProjectileType,
            turretId: config.id,
            playerId,
            sourceEntityId: unit.id,
            turretIndex: weaponIndex,
            beam: { start: { x: spawnX, y: spawnY }, end: { x: endX, y: endY } },
          });
          // Note: Beam recoil is applied continuously above while weapon is engaged
        } else {
          // Create traveling projectile
          const projShot = shot as ProjectileShot;
          const speed = projShot.launchForce / projShot.mass;
          let projVx = fireCos * speed;
          let projVy = fireSin * speed;
          if (world.projVelInherit && unit.unit) {
            // Unit linear velocity
            projVx += unit.unit.velocityX ?? 0;
            projVy += unit.unit.velocityY ?? 0;
            // Turret rotational velocity at fire point (tangential = omega * r)
            const barrelDx = fireCos * barrelOffset;
            const barrelDy = fireSin * barrelOffset;
            const omega = weapon.angularVelocity;
            projVx += -barrelDy * omega;
            projVy += barrelDx * omega;
          }
          const projectile = world.createProjectile(
            spawnX,
            spawnY,
            projVx,
            projVy,
            playerId,
            unit.id,
            config,
            'projectile'
          );
          // Set homing properties if weapon has homingTurnRate and weapon has a locked target
          if (projShot.homingTurnRate && weapon.target !== null) {
            projectile.projectile!.homingTargetId = weapon.target;
            projectile.projectile!.homingTurnRate = projShot.homingTurnRate;
          }

          newProjectiles.push(projectile);
          spawnEvents.push({
            id: projectile.id,
            pos: { x: spawnX, y: spawnY }, rotation: angle,
            velocity: { x: projVx, y: projVy },
            projectileType: 'projectile',
            turretId: config.id,
            playerId,
            sourceEntityId: unit.id,
            turretIndex: weaponIndex,
            targetEntityId: (projShot.homingTurnRate && weapon.target !== null) ? weapon.target : undefined,
            homingTurnRate: projShot.homingTurnRate,
          });

          // Apply recoil to firing unit (momentum-based: p = mv)
          if (forceAccumulator && projShot.mass > 0) {
            const recoilForce = projShot.launchForce * PROJECTILE_MASS_MULTIPLIER;
            forceAccumulator.addForce(unit.id, -fireCos * recoilForce, -fireSin * recoilForce, 'recoil');
          }
        }
      }
    }
  }

  return { projectiles: newProjectiles, events: audioEvents, spawnEvents };
}

// Reusable array for homing velocity updates (avoid per-frame allocation)
const _homingVelocityUpdates: import('./types').ProjectileVelocityUpdateEvent[] = [];

// Reusable arrays for WASM batch projectile processing
let _projEntities: Entity[] = [];

// JS fallback: update traveling projectile positions + homing (original code)
function _updateTravelingProjectilesJS(world: WorldState, dtMs: number, dtSec: number): void {
  for (const entity of world.getProjectiles()) {
    if (!entity.projectile) continue;
    const proj = entity.projectile;

    if (proj.projectileType !== 'projectile') continue;

    proj.timeAlive += dtMs;

    proj.prevX = entity.transform.x;
    proj.prevY = entity.transform.y;
    entity.transform.x += proj.velocityX * dtSec;
    entity.transform.y += proj.velocityY * dtSec;

    if (!proj.hasLeftSource) {
      const source = world.getEntity(proj.sourceEntityId);
      if (!source?.unit) {
        proj.hasLeftSource = true;
      } else {
        const dx = proj.prevX - source.transform.x;
        const dy = proj.prevY - source.transform.y;
        const distSq = dx * dx + dy * dy;
        const clearance = source.unit.unitRadiusCollider.shot + (proj.config.shot.type === 'projectile' ? proj.config.shot.collision.radius : 5) + 2;
        if (distSq > clearance * clearance) {
          proj.hasLeftSource = true;
        }
      }
    }

    if (proj.homingTargetId !== undefined) {
      const homingTarget = world.getEntity(proj.homingTargetId);
      if (homingTarget && ((homingTarget.unit && homingTarget.unit.hp > 0) || (homingTarget.building && homingTarget.building.hp > 0))) {
        const steered = applyHomingSteering(
          proj.velocityX, proj.velocityY,
          homingTarget.transform.x, homingTarget.transform.y,
          entity.transform.x, entity.transform.y,
          proj.homingTurnRate ?? 0, dtSec
        );
        proj.velocityX = steered.velocityX;
        proj.velocityY = steered.velocityY;
        entity.transform.rotation = steered.rotation;

        const velTh = SNAPSHOT_CONFIG.velocityThreshold;
        const lastVx = proj.lastSentVelX ?? proj.velocityX;
        const lastVy = proj.lastSentVelY ?? proj.velocityY;
        if (Math.abs(proj.velocityX - lastVx) > velTh ||
            Math.abs(proj.velocityY - lastVy) > velTh) {
          proj.lastSentVelX = proj.velocityX;
          proj.lastSentVelY = proj.velocityY;
          _homingVelocityUpdates.push({
            id: entity.id,
            pos: { x: entity.transform.x, y: entity.transform.y },
            velocity: { x: proj.velocityX, y: proj.velocityY },
          });
        }
      } else {
        proj.homingTargetId = undefined;
      }
    }
  }
}

// WASM batch: position integration + homing steering in WASM, game logic in JS
function _updateTravelingProjectilesWasm(
  world: WorldState,
  dtMs: number,
  dtSec: number,
  wasmEngine: NonNullable<ReturnType<typeof getWasmEngine>>,
  wasmMemory: WebAssembly.Memory,
): void {
  // Collect traveling projectiles and resolve homing targets (requires entity lookups)
  _projEntities.length = 0;
  for (const entity of world.getProjectiles()) {
    if (!entity.projectile) continue;
    if (entity.projectile.projectileType === 'projectile') {
      entity.projectile.timeAlive += dtMs;
      _projEntities.push(entity);
    }
  }

  const count = _projEntities.length;
  if (count === 0) return;

  // Pack data into WASM input buffer
  // Stride 8: [x, y, vx, vy, targetX, targetY, turnRate, hasHoming]
  const inPtr = wasmEngine.proj_in_alloc(count);
  const inBuf = new Float64Array(wasmMemory.buffer, inPtr, count * 8);

  for (let i = 0; i < count; i++) {
    const entity = _projEntities[i];
    const proj = entity.projectile!;
    const base = i * 8;

    // Store prev position before WASM moves it
    proj.prevX = entity.transform.x;
    proj.prevY = entity.transform.y;

    inBuf[base] = entity.transform.x;
    inBuf[base + 1] = entity.transform.y;
    inBuf[base + 2] = proj.velocityX;
    inBuf[base + 3] = proj.velocityY;

    // Resolve homing target (needs entity lookup)
    let hasHoming = 0;
    let targetX = 0;
    let targetY = 0;
    let turnRate = 0;

    if (proj.homingTargetId !== undefined) {
      const homingTarget = world.getEntity(proj.homingTargetId);
      if (homingTarget && ((homingTarget.unit && homingTarget.unit.hp > 0) || (homingTarget.building && homingTarget.building.hp > 0))) {
        hasHoming = 1;
        targetX = homingTarget.transform.x;
        targetY = homingTarget.transform.y;
        turnRate = proj.homingTurnRate ?? 0;
      } else {
        proj.homingTargetId = undefined;
      }
    }

    inBuf[base + 4] = targetX;
    inBuf[base + 5] = targetY;
    inBuf[base + 6] = turnRate;
    inBuf[base + 7] = hasHoming;
  }

  // One WASM call for all projectiles
  const outPtr = wasmEngine.proj_update(count, dtSec);
  const outBuf = new Float64Array(wasmMemory.buffer, outPtr, count * 5);

  // Unpack results + JS game logic (source check, velocity events)
  for (let i = 0; i < count; i++) {
    const entity = _projEntities[i];
    const proj = entity.projectile!;
    const base = i * 5;

    entity.transform.x = outBuf[base];
    entity.transform.y = outBuf[base + 1];
    proj.velocityX = outBuf[base + 2];
    proj.velocityY = outBuf[base + 3];
    entity.transform.rotation = outBuf[base + 4];

    // Source clearance check (needs entity lookup — stays in JS)
    if (!proj.hasLeftSource) {
      const source = world.getEntity(proj.sourceEntityId);
      if (!source?.unit) {
        proj.hasLeftSource = true;
      } else {
        const dx = (proj.prevX ?? entity.transform.x) - source.transform.x;
        const dy = (proj.prevY ?? entity.transform.y) - source.transform.y;
        const distSq = dx * dx + dy * dy;
        const clearance = source.unit.unitRadiusCollider.shot + (proj.config.shot.type === 'projectile' ? proj.config.shot.collision.radius : 5) + 2;
        if (distSq > clearance * clearance) {
          proj.hasLeftSource = true;
        }
      }
    }

    // Homing velocity update events (needs threshold check — stays in JS)
    if (proj.homingTargetId !== undefined) {
      const velTh = SNAPSHOT_CONFIG.velocityThreshold;
      const lastVx = proj.lastSentVelX ?? proj.velocityX;
      const lastVy = proj.lastSentVelY ?? proj.velocityY;
      if (Math.abs(proj.velocityX - lastVx) > velTh ||
          Math.abs(proj.velocityY - lastVy) > velTh) {
        proj.lastSentVelX = proj.velocityX;
        proj.lastSentVelY = proj.velocityY;
        _homingVelocityUpdates.push({
          id: entity.id,
          pos: { x: entity.transform.x, y: entity.transform.y },
          velocity: { x: proj.velocityX, y: proj.velocityY },
        });
      }
    }
  }
}

// Update projectile positions - returns IDs of projectiles to remove (e.g., orphaned beams)
// Also returns despawn events for removed projectiles and velocity updates for homing projectiles
export function updateProjectiles(
  world: WorldState,
  dtMs: number,
  damageSystem: DamageSystem
): { orphanedIds: EntityId[]; despawnEvents: ProjectileDespawnEvent[]; velocityUpdates: import('./types').ProjectileVelocityUpdateEvent[] } {
  const dtSec = dtMs / 1000;
  const projectilesToRemove: EntityId[] = [];
  const despawnEvents: ProjectileDespawnEvent[] = [];
  _homingVelocityUpdates.length = 0;

  // Phase 4: batch position integration + homing for traveling projectiles via WASM
  const wasmEngine = getWasmEngine();
  const wasmMemory = getWasmMemory();
  if (wasmEngine && wasmMemory) {
    _updateTravelingProjectilesWasm(world, dtMs, dtSec, wasmEngine, wasmMemory);
  } else {
    _updateTravelingProjectilesJS(world, dtMs, dtSec);
  }

  for (const entity of world.getProjectiles()) {
    if (!entity.projectile) continue;

    const proj = entity.projectile;

    // Traveling projectiles already handled in pre-pass (WASM or JS)
    if (proj.projectileType === 'projectile') continue;

    // Update beam/laser positions to follow turret direction
    if (proj.projectileType === 'beam' || proj.projectileType === 'laser') {
      proj.timeAlive += dtMs;
      const source = world.getEntity(proj.sourceEntityId);

      // Get weapon index from config
      const weaponIndex = proj.config.turretIndex ?? 0;

      // Remove beam if source unit is dead or gone
      if (!source || !source.unit || source.unit.hp <= 0 || !source.turrets) {
        beamIndex.removeBeam(proj.sourceEntityId, weaponIndex);
        projectilesToRemove.push(entity.id);
        despawnEvents.push({ id: entity.id });
        continue;
      }

      if (source && source.unit && source.turrets) {
        const weapon = source.turrets[weaponIndex];

        if (!weapon) {
          beamIndex.removeBeam(proj.sourceEntityId, weaponIndex);
          projectilesToRemove.push(entity.id);
          despawnEvents.push({ id: entity.id });
          continue;
        }

        // Continuous beams: stay alive while firing, remove immediately when not
        const isContinuous = proj.config.shot.type === 'beam';
        if (isContinuous) {
          if (weapon.state === 'engaged') {
            proj.timeAlive = 0;
          } else {
            // Remove immediately — no linger time
            beamIndex.removeBeam(proj.sourceEntityId, weaponIndex);
            projectilesToRemove.push(entity.id);
            despawnEvents.push({ id: entity.id });
            continue;
          }
        }

        // Get turret direction from specific weapon
        const turretAngle = weapon.rotation;
        const dirX = Math.cos(turretAngle);
        const dirY = Math.sin(turretAngle);

        // Use cached weapon world position from targeting phase
        const { cos: srcCos, sin: srcSin } = getTransformCosSin(source.transform);
        const beamWP = resolveWeaponWorldPos(weapon, source.transform.x, source.transform.y, srcCos, srcSin);
        const weaponX = beamWP.x, weaponY = beamWP.y;

        // Beam starts at barrel tip
        const bt = getBarrelTipWorldPos(weaponX, weaponY, turretAngle, proj.config, source.unit.unitRadiusCollider.shot);
        proj.startX = bt.x;
        proj.startY = bt.y;

        // Use weapon's fireRange for consistent beam length (not proj.config.range)
        const beamLength = weapon.ranges.engage.acquire;
        const fullEndX = proj.startX + dirX * beamLength;
        const fullEndY = proj.startY + dirY * beamLength;

        // Find beam path (with possible reflections off mirror units)
        // Throttle: only recompute every 3 ticks (beam visuals tolerate slight staleness)
        const currentTick = world.getTick();
        const collisionRadius = isLineShot(proj.config.shot) ? proj.config.shot.radius : 2;
        if (proj.obstructionTick === undefined || currentTick - proj.obstructionTick >= 3) {
          const beamPath = damageSystem.findBeamPath(
            proj.startX, proj.startY,
            fullEndX, fullEndY,
            proj.sourceEntityId,
            collisionRadius
          );
          proj.endX = beamPath.endX;
          proj.endY = beamPath.endY;
          proj.obstructionT = beamPath.obstructionT;
          proj.reflections = beamPath.reflections.length > 0 ? beamPath.reflections : undefined;
          proj.obstructionTick = currentTick;
        } else {
          // Use cached values — endX/endY already set from last computation
          if (proj.endX === undefined) {
            proj.endX = fullEndX;
            proj.endY = fullEndY;
          }
        }

        // Update entity transform to match beam start (for visual reference)
        entity.transform.x = proj.startX;
        entity.transform.y = proj.startY;
        entity.transform.rotation = turretAngle;
      }
    }
  }

  return { orphanedIds: projectilesToRemove, despawnEvents, velocityUpdates: _homingVelocityUpdates };
}


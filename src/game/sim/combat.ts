import type { WorldState } from './WorldState';
import type { Entity, EntityId } from './types';
import { FIXED_TIMESTEP } from './Simulation';

// Audio event types
export interface AudioEvent {
  type: 'fire' | 'hit' | 'death' | 'laserStart' | 'laserStop';
  weaponId: string;
  x: number;
  y: number;
  entityId?: EntityId; // For tracking continuous sounds
}

// Combat result containing entities and audio events
export interface FireWeaponsResult {
  projectiles: Entity[];
  audioEvents: AudioEvent[];
}

export interface CollisionResult {
  deadUnitIds: EntityId[];
  audioEvents: AudioEvent[];
}

// Distance between two points
function distance(x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  return Math.sqrt(dx * dx + dy * dy);
}

// Find closest enemy unit within range
export function findClosestEnemy(
  world: WorldState,
  unit: Entity,
  range: number
): Entity | null {
  if (!unit.ownership) return null;

  const enemies = world.getEnemyUnits(unit.ownership.playerId);
  let closestEnemy: Entity | null = null;
  let closestDistance = Infinity;

  for (const enemy of enemies) {
    if (!enemy.unit || enemy.unit.hp <= 0) continue;

    const dist = distance(
      unit.transform.x,
      unit.transform.y,
      enemy.transform.x,
      enemy.transform.y
    );

    // Check if in range - weapon fires from unit edge, so effective range
    // is weapon range plus target radius (to hit target's edge)
    const effectiveRange = range + enemy.unit.radius;

    if (dist <= effectiveRange && dist < closestDistance) {
      closestDistance = dist;
      closestEnemy = enemy;
    }
  }

  return closestEnemy;
}

// Normalize angle to [-PI, PI]
function normalizeAngle(angle: number): number {
  while (angle > Math.PI) angle -= 2 * Math.PI;
  while (angle < -Math.PI) angle += 2 * Math.PI;
  return angle;
}

// Rotate turret toward target angle, limited by turn rate
function rotateTurretToward(
  currentAngle: number,
  targetAngle: number,
  turnRate: number,
  dtSec: number
): number {
  const diff = normalizeAngle(targetAngle - currentAngle);
  const maxTurn = turnRate * dtSec;

  if (Math.abs(diff) <= maxTurn) {
    return targetAngle;
  }

  return currentAngle + Math.sign(diff) * maxTurn;
}

// Update turret rotation for all units (call before fireWeapons)
export function updateTurretRotation(world: WorldState, dtMs: number): void {
  const dtSec = dtMs / 1000;

  for (const unit of world.getUnits()) {
    if (!unit.unit || !unit.ownership) continue;
    if (unit.unit.hp <= 0) continue;

    const unitComp = unit.unit;
    const currentTurretRotation = unitComp.turretRotation ?? unit.transform.rotation;

    // Determine target angle
    let targetAngle: number;

    if (unit.weapon && unit.weapon.targetEntityId !== null) {
      // Has target - aim turret at target
      const target = world.getEntity(unit.weapon.targetEntityId);
      if (target) {
        const dx = target.transform.x - unit.transform.x;
        const dy = target.transform.y - unit.transform.y;
        targetAngle = Math.atan2(dy, dx);
      } else {
        // Target doesn't exist, face movement direction
        targetAngle = getMovementAngle(unit);
      }
    } else {
      // No target - face movement direction (or body direction if stationary)
      targetAngle = getMovementAngle(unit);
    }

    // Rotate turret toward target angle
    unitComp.turretRotation = rotateTurretToward(
      currentTurretRotation,
      targetAngle,
      unitComp.turretTurnRate,
      dtSec
    );
  }
}

// Get angle to face based on movement (or body direction if stationary)
function getMovementAngle(unit: Entity): number {
  if (!unit.unit) return unit.transform.rotation;

  const velX = unit.unit.velocityX ?? 0;
  const velY = unit.unit.velocityY ?? 0;
  const speed = Math.sqrt(velX * velX + velY * velY);

  if (speed > 1) {
    // Moving - face movement direction
    return Math.atan2(velY, velX);
  }

  // Stationary - keep current turret direction (or body direction)
  return unit.unit.turretRotation ?? unit.transform.rotation;
}

// Update laser sounds based on targeting state (not beam existence)
// This is called every frame to ensure sounds match targeting state
export function updateLaserSounds(world: WorldState): AudioEvent[] {
  const audioEvents: AudioEvent[] = [];

  for (const unit of world.getUnits()) {
    if (!unit.weapon || !unit.unit || !unit.ownership) continue;
    if (unit.unit.hp <= 0) continue;

    const config = unit.weapon.config;
    const isBeamWeapon = config.beamDuration !== undefined && config.cooldown === 0;

    if (!isBeamWeapon) continue;

    // Check if unit has a valid target in range
    const hasTarget = unit.weapon.targetEntityId !== null;

    if (hasTarget) {
      // Laser should be ON - emit laserStart (AudioManager ignores if already playing)
      audioEvents.push({
        type: 'laserStart',
        weaponId: config.id,
        x: unit.transform.x,
        y: unit.transform.y,
        entityId: unit.id,
      });
    } else {
      // Laser should be OFF - emit laserStop
      audioEvents.push({
        type: 'laserStop',
        weaponId: config.id,
        x: unit.transform.x,
        y: unit.transform.y,
        entityId: unit.id,
      });
    }
  }

  return audioEvents;
}

// Update auto-targeting for all units
export function updateAutoTargeting(world: WorldState): void {
  for (const unit of world.getUnits()) {
    if (!unit.weapon || !unit.ownership || !unit.unit) continue;
    if (unit.unit.hp <= 0) continue;

    const weapon = unit.weapon;
    const range = weapon.config.range;

    // Check if current target is still valid
    if (weapon.targetEntityId !== null) {
      const target = world.getEntity(weapon.targetEntityId);
      if (target && target.unit && target.unit.hp > 0) {
        const dist = distance(
          unit.transform.x,
          unit.transform.y,
          target.transform.x,
          target.transform.y
        );
        // Weapon fires from unit edge, so effective range is weapon range plus target radius
        const effectiveRange = range + target.unit.radius;

        // Target still valid and in range
        if (dist <= effectiveRange) {
          continue;
        }
      }
      // Target invalid or out of range, clear it
      weapon.targetEntityId = null;
    }

    // Find new target
    const enemy = findClosestEnemy(world, unit, range);
    if (enemy) {
      weapon.targetEntityId = enemy.id;
    }
  }
}

// Update weapon cooldowns
export function updateWeaponCooldowns(world: WorldState, dtMs: number): void {
  for (const unit of world.getUnits()) {
    if (!unit.weapon) continue;

    if (unit.weapon.currentCooldown > 0) {
      unit.weapon.currentCooldown -= dtMs;
      if (unit.weapon.currentCooldown < 0) {
        unit.weapon.currentCooldown = 0;
      }
    }

    // Update burst cooldown
    if (unit.weapon.burstCooldown !== undefined && unit.weapon.burstCooldown > 0) {
      unit.weapon.burstCooldown -= dtMs;
      if (unit.weapon.burstCooldown < 0) {
        unit.weapon.burstCooldown = 0;
      }
    }
  }
}

// Check if a unit already has an active beam that won't expire this frame
function hasActiveBeam(world: WorldState, unitId: EntityId): boolean {
  for (const proj of world.getProjectiles()) {
    if (proj.projectile?.sourceEntityId === unitId && proj.projectile.projectileType === 'beam') {
      // Don't count beams that will expire this frame (after timeAlive update)
      // timeAlive is updated AFTER fireWeapons, so we need to look ahead
      if (proj.projectile.timeAlive + FIXED_TIMESTEP >= proj.projectile.maxLifespan) {
        continue;
      }
      return true;
    }
  }
  return false;
}

// Fire weapons at targets
export function fireWeapons(world: WorldState): FireWeaponsResult {
  const newProjectiles: Entity[] = [];
  const audioEvents: AudioEvent[] = [];

  for (const unit of world.getUnits()) {
    if (!unit.weapon || !unit.ownership || !unit.unit) continue;
    if (unit.unit.hp <= 0) continue;

    const weapon = unit.weapon;
    const config = weapon.config;
    const isBeamWeapon = config.beamDuration !== undefined;

    // Check if we have a target
    if (weapon.targetEntityId === null) continue;

    const target = world.getEntity(weapon.targetEntityId);
    if (!target || !target.unit || target.unit.hp <= 0) {
      weapon.targetEntityId = null;
      continue;
    }

    // For beam weapons, fire continuously but only one beam at a time
    if (isBeamWeapon) {
      if (hasActiveBeam(world, unit.id)) continue; // Already has a beam active
    } else {
      // Check if off cooldown for non-beam weapons
      const canFire = weapon.currentCooldown <= 0;
      const canBurstFire =
        weapon.burstShotsRemaining !== undefined &&
        weapon.burstShotsRemaining > 0 &&
        (weapon.burstCooldown === undefined || weapon.burstCooldown <= 0);

      if (!canFire && !canBurstFire) continue;
    }

    // Use turret direction (not target direction) - turret rotation was updated in updateTurretRotation
    const turretAngle = unit.unit.turretRotation ?? unit.transform.rotation;

    const playerId = unit.ownership.playerId;

    // Handle cooldowns for non-beam weapons
    if (!isBeamWeapon) {
      const canFire = weapon.currentCooldown <= 0;
      const canBurstFire =
        weapon.burstShotsRemaining !== undefined &&
        weapon.burstShotsRemaining > 0 &&
        (weapon.burstCooldown === undefined || weapon.burstCooldown <= 0);

      if (canBurstFire && weapon.burstShotsRemaining !== undefined) {
        weapon.burstShotsRemaining--;
        weapon.burstCooldown = config.burstDelay ?? 80;

        if (weapon.burstShotsRemaining <= 0) {
          weapon.burstShotsRemaining = undefined;
          weapon.burstCooldown = undefined;
        }
      } else if (canFire) {
        // Start cooldown
        weapon.currentCooldown = config.cooldown;

        // Initialize burst if applicable
        if (config.burstCount && config.burstCount > 1) {
          weapon.burstShotsRemaining = config.burstCount - 1; // -1 because we're firing one now
          weapon.burstCooldown = config.burstDelay ?? 80;
        }
      }
    }

    // Add fire audio event for non-beam weapons only
    // Beam weapon audio is handled separately by updateLaserSounds (based on targeting state)
    if (!isBeamWeapon) {
      audioEvents.push({
        type: 'fire',
        weaponId: config.id,
        x: unit.transform.x,
        y: unit.transform.y,
      });
    }

    // Create projectile(s)
    const pellets = config.pelletCount ?? 1;
    const spreadAngle = config.spreadAngle ?? 0;
    const baseAngle = turretAngle; // Fire in turret direction

    for (let i = 0; i < pellets; i++) {
      // Calculate spread
      let angle = baseAngle;
      if (pellets > 1 && spreadAngle > 0) {
        const spreadOffset = (i / (pellets - 1) - 0.5) * spreadAngle;
        angle += spreadOffset;
      } else if (pellets === 1 && spreadAngle > 0) {
        // Random spread for single pellet
        angle += (world.rng.next() - 0.5) * spreadAngle;
      }

      const cos = Math.cos(angle);
      const sin = Math.sin(angle);

      // Spawn position (at edge of unit)
      const spawnX = unit.transform.x + cos * (unit.unit.radius + 2);
      const spawnY = unit.transform.y + sin * (unit.unit.radius + 2);

      // Check if this is a beam/hitscan weapon
      if (config.beamDuration !== undefined) {
        // Create beam as fixed-length ray in turret direction (damages anything it touches)
        const beamLength = config.range;
        const endX = spawnX + cos * beamLength;
        const endY = spawnY + sin * beamLength;
        const beam = world.createBeam(spawnX, spawnY, endX, endY, playerId, unit.id, config);
        // Store source entity for position tracking (beam follows turret direction)
        if (beam.projectile) {
          beam.projectile.sourceEntityId = unit.id;
          // No targetEntityId - beam fires in fixed direction from turret
        }
        newProjectiles.push(beam);
      } else if (config.projectileSpeed !== undefined) {
        // Create traveling projectile
        const speed = config.projectileSpeed;
        const velX = cos * speed;
        const velY = sin * speed;

        const projectile = world.createProjectile(
          spawnX,
          spawnY,
          velX,
          velY,
          playerId,
          unit.id,
          config,
          'traveling'
        );
        newProjectiles.push(projectile);
      }
    }
  }

  return { projectiles: newProjectiles, audioEvents };
}

// Update projectile positions
export function updateProjectiles(world: WorldState, dtMs: number): void {
  const dtSec = dtMs / 1000;

  for (const entity of world.getProjectiles()) {
    if (!entity.projectile) continue;

    const proj = entity.projectile;

    // Update time alive
    proj.timeAlive += dtMs;

    // Move traveling projectiles
    if (proj.projectileType === 'traveling') {
      entity.transform.x += proj.velocityX * dtSec;
      entity.transform.y += proj.velocityY * dtSec;
    }

    // Update beam positions to follow turret direction
    if (proj.projectileType === 'beam') {
      const source = world.getEntity(proj.sourceEntityId);

      if (source && source.unit) {
        // Get turret direction
        const turretAngle = source.unit.turretRotation ?? source.transform.rotation;
        const dirX = Math.cos(turretAngle);
        const dirY = Math.sin(turretAngle);

        // Beam starts at edge of source unit
        proj.startX = source.transform.x + dirX * (source.unit.radius + 2);
        proj.startY = source.transform.y + dirY * (source.unit.radius + 2);

        // Beam ends at fixed length (weapon range) in turret direction
        const beamLength = proj.config.range;
        proj.endX = proj.startX + dirX * beamLength;
        proj.endY = proj.startY + dirY * beamLength;

        // Update entity transform to match beam start (for visual reference)
        entity.transform.x = proj.startX;
        entity.transform.y = proj.startY;
        entity.transform.rotation = turretAngle;
      }
    }
  }
}

// Check projectile collisions and apply damage
export function checkProjectileCollisions(world: WorldState, dtMs: number): CollisionResult {
  const projectilesToRemove: EntityId[] = [];
  const unitsToRemove: EntityId[] = [];
  const audioEvents: AudioEvent[] = [];

  for (const projEntity of world.getProjectiles()) {
    if (!projEntity.projectile || !projEntity.ownership) continue;

    const proj = projEntity.projectile;
    const config = proj.config;

    // Check if projectile expired
    if (proj.timeAlive >= proj.maxLifespan) {
      // Beam audio is handled by updateLaserSounds based on targeting state

      // Handle splash damage on expiration for grenades
      if (config.splashRadius && !proj.hasExploded) {
        const splashHits = applyAoEDamage(world, projEntity, unitsToRemove);
        proj.hasExploded = true;

        // Add explosion audio event if there were hits or it's a grenade
        if (splashHits > 0 || config.id === 'grenade') {
          audioEvents.push({
            type: 'hit',
            weaponId: config.id,
            x: projEntity.transform.x,
            y: projEntity.transform.y,
          });
        }
      }
      projectilesToRemove.push(projEntity.id);
      continue;
    }

    // Get potential targets (enemies of projectile owner)
    const enemies = world.getEnemyUnits(proj.ownerId);

    for (const enemy of enemies) {
      if (!enemy.unit || enemy.unit.hp <= 0) continue;

      // For non-beam projectiles, skip if already hit this entity
      if (proj.projectileType !== 'beam' && proj.hitEntities.has(enemy.id)) continue;

      let hit = false;

      if (proj.projectileType === 'beam') {
        // Line-circle intersection for beams
        hit = lineCircleIntersection(
          proj.startX ?? projEntity.transform.x,
          proj.startY ?? projEntity.transform.y,
          proj.endX ?? projEntity.transform.x,
          proj.endY ?? projEntity.transform.y,
          enemy.transform.x,
          enemy.transform.y,
          enemy.unit.radius + (config.beamWidth ?? 2) / 2
        );
      } else {
        // Circle-circle intersection for projectiles
        const projRadius = config.projectileRadius ?? 5;
        const dist = distance(
          projEntity.transform.x,
          projEntity.transform.y,
          enemy.transform.x,
          enemy.transform.y
        );
        hit = dist <= projRadius + enemy.unit.radius;
      }

      if (hit) {
        // Calculate damage based on projectile type
        let damage: number;
        if (proj.projectileType === 'beam') {
          // Beams deal continuous damage over their duration
          // damage config represents total damage, spread over beamDuration
          const beamDuration = config.beamDuration ?? 150;
          damage = (config.damage / beamDuration) * dtMs;
        } else {
          // Regular projectiles deal full damage on hit
          damage = config.damage;
          proj.hitEntities.add(enemy.id);
        }

        // Apply damage
        enemy.unit.hp -= damage;

        // Add hit audio event (skip for continuous beams - they just have the continuous laser sound)
        const isContinuousBeam = proj.projectileType === 'beam' && config.cooldown === 0;
        if (!isContinuousBeam) {
          if (proj.projectileType !== 'beam' || !proj.hitEntities.has(enemy.id)) {
            audioEvents.push({
              type: 'hit',
              weaponId: config.id,
              x: enemy.transform.x,
              y: enemy.transform.y,
            });
            // Mark beam as having played hit sound for this target
            if (proj.projectileType === 'beam') {
              proj.hitEntities.add(enemy.id);
            }
          }
        }

        // Check for splash damage (only for non-beam projectiles)
        if (config.splashRadius && !proj.hasExploded && proj.projectileType !== 'beam') {
          applyAoEDamage(world, projEntity, unitsToRemove);
          proj.hasExploded = true;
        }

        // Check if unit died
        if (enemy.unit.hp <= 0 && !unitsToRemove.includes(enemy.id)) {
          // Add death audio event based on the dying unit's weapon type
          const deathWeaponId = enemy.weapon?.config.id ?? 'minigun';
          audioEvents.push({
            type: 'death',
            weaponId: deathWeaponId,
            x: enemy.transform.x,
            y: enemy.transform.y,
          });
          unitsToRemove.push(enemy.id);
        }

        // Check if projectile should be removed (beams persist for full duration)
        if (proj.hitEntities.size >= proj.maxHits && proj.projectileType !== 'beam') {
          projectilesToRemove.push(projEntity.id);
          break;
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
    }
  }

  // Remove expired projectiles
  for (const id of projectilesToRemove) {
    world.removeEntity(id);
  }

  return { deadUnitIds: unitsToRemove, audioEvents };
}

// Apply AoE damage around a point - returns number of hits
function applyAoEDamage(world: WorldState, projEntity: Entity, unitsToRemove: EntityId[]): number {
  if (!projEntity.projectile) return 0;

  const proj = projEntity.projectile;
  const config = proj.config;
  const splashRadius = config.splashRadius ?? 0;
  const falloff = config.splashDamageFalloff ?? 0.5;

  const enemies = world.getEnemyUnits(proj.ownerId);
  let hitCount = 0;

  for (const enemy of enemies) {
    if (!enemy.unit || enemy.unit.hp <= 0) continue;
    if (proj.hitEntities.has(enemy.id)) continue; // Don't double-hit

    const dist = distance(
      projEntity.transform.x,
      projEntity.transform.y,
      enemy.transform.x,
      enemy.transform.y
    );

    if (dist <= splashRadius + enemy.unit.radius) {
      proj.hitEntities.add(enemy.id);
      hitCount++;

      // Calculate damage with falloff
      const distRatio = Math.min(1, dist / splashRadius);
      const damageMultiplier = 1 - distRatio * (1 - falloff);
      const damage = config.damage * damageMultiplier;

      enemy.unit.hp -= damage;

      if (enemy.unit.hp <= 0 && !unitsToRemove.includes(enemy.id)) {
        unitsToRemove.push(enemy.id);
      }
    }
  }

  return hitCount;
}

// Line-circle intersection test
function lineCircleIntersection(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  cx: number,
  cy: number,
  r: number
): boolean {
  // Vector from line start to circle center
  const dx = x2 - x1;
  const dy = y2 - y1;
  const fx = x1 - cx;
  const fy = y1 - cy;

  const a = dx * dx + dy * dy;
  const b = 2 * (fx * dx + fy * dy);
  const c = fx * fx + fy * fy - r * r;

  let discriminant = b * b - 4 * a * c;

  if (discriminant < 0) {
    return false;
  }

  discriminant = Math.sqrt(discriminant);

  const t1 = (-b - discriminant) / (2 * a);
  const t2 = (-b + discriminant) / (2 * a);

  // Check if intersection is on the line segment
  return (t1 >= 0 && t1 <= 1) || (t2 >= 0 && t2 <= 1);
}

// Remove dead units and clean up their Matter bodies
export function removeDeadUnits(world: WorldState, deadUnitIds: EntityId[], scene: Phaser.Scene): void {
  for (const id of deadUnitIds) {
    const entity = world.getEntity(id);
    if (entity?.body?.matterBody) {
      scene.matter.world.remove(entity.body.matterBody);
    }
    world.removeEntity(id);
  }
}

import type { WorldState } from './WorldState';
import type { Entity, EntityId } from './types';
import { FIXED_TIMESTEP } from './Simulation';

// Audio event types
export interface AudioEvent {
  type: 'fire' | 'hit' | 'death' | 'laserStart' | 'laserStop' | 'projectileExpire';
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
  deadBuildingIds: EntityId[];
  audioEvents: AudioEvent[];
}

// Distance between two points
function distance(x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  return Math.sqrt(dx * dx + dy * dy);
}

// Get target radius for range calculations
function getTargetRadius(target: Entity): number {
  if (target.unit) {
    return target.unit.collisionRadius;
  } else if (target.building) {
    const bWidth = target.building.width;
    const bHeight = target.building.height;
    return Math.sqrt(bWidth * bWidth + bHeight * bHeight) / 2;
  }
  return 0;
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
// Each weapon uses its own turretTurnRate
export function updateTurretRotation(world: WorldState, dtMs: number): void {
  const dtSec = dtMs / 1000;

  for (const unit of world.getUnits()) {
    if (!unit.unit || !unit.ownership || !unit.weapons) continue;
    if (unit.unit.hp <= 0) continue;

    const cos = Math.cos(unit.transform.rotation);
    const sin = Math.sin(unit.transform.rotation);

    // Update each weapon's turret rotation using its own turretTurnRate
    for (const weapon of unit.weapons) {
      let targetAngle: number;

      if (weapon.targetEntityId !== null) {
        const target = world.getEntity(weapon.targetEntityId);
        if (target) {
          // Calculate angle from weapon position to target (using rotated coordinates)
          const weaponX = unit.transform.x + cos * weapon.offsetX - sin * weapon.offsetY;
          const weaponY = unit.transform.y + sin * weapon.offsetX + cos * weapon.offsetY;
          const dx = target.transform.x - weaponX;
          const dy = target.transform.y - weaponY;
          targetAngle = Math.atan2(dy, dx);
        } else {
          targetAngle = getMovementAngle(unit);
        }
      } else {
        // No target - face movement direction (or body direction if stationary)
        targetAngle = getMovementAngle(unit);
      }

      // Rotate turret toward target angle using weapon's own turn rate
      // Each weapon operates independently - unit has no control
      weapon.turretRotation = rotateTurretToward(
        weapon.turretRotation,
        targetAngle,
        weapon.turretTurnRate,
        dtSec
      );
    }
    // Note: No syncing to unit - weapons are fully independent
  }
}

// Get angle to face based on movement (or body direction if stationary)
// Used by weapons when they have no target - they face movement direction
function getMovementAngle(unit: Entity): number {
  if (!unit.unit) return unit.transform.rotation;

  const velX = unit.unit.velocityX ?? 0;
  const velY = unit.unit.velocityY ?? 0;
  const speed = Math.sqrt(velX * velX + velY * velY);

  if (speed > 1) {
    // Moving - face movement direction
    return Math.atan2(velY, velX);
  }

  // Stationary - use body direction (weapons maintain their own rotation)
  return unit.transform.rotation;
}

// Update laser sounds based on targeting state (not beam existence)
// This is called every frame to ensure sounds match targeting state
export function updateLaserSounds(world: WorldState): AudioEvent[] {
  const audioEvents: AudioEvent[] = [];

  for (const unit of world.getUnits()) {
    if (!unit.weapons || !unit.unit || !unit.ownership) continue;
    if (unit.unit.hp <= 0) continue;

    const cos = Math.cos(unit.transform.rotation);
    const sin = Math.sin(unit.transform.rotation);

    // Check each weapon for beam sounds
    for (let i = 0; i < unit.weapons.length; i++) {
      const weapon = unit.weapons[i];
      const config = weapon.config;
      const isBeamWeapon = config.beamDuration !== undefined && config.cooldown === 0;

      if (!isBeamWeapon) continue;

      // Check if weapon has a valid target in weapon's fire range
      let hasTargetInRange = false;
      if (weapon.targetEntityId !== null) {
        const target = world.getEntity(weapon.targetEntityId);
        if (target) {
          const targetIsUnit = target.unit && target.unit.hp > 0;
          const targetIsBuilding = target.building && target.building.hp > 0;
          if (targetIsUnit || targetIsBuilding) {
            // Calculate weapon position
            const weaponX = unit.transform.x + cos * weapon.offsetX - sin * weapon.offsetY;
            const weaponY = unit.transform.y + sin * weapon.offsetX + cos * weapon.offsetY;
            const dist = distance(weaponX, weaponY, target.transform.x, target.transform.y);
            const targetRadius = getTargetRadius(target);
            hasTargetInRange = dist <= weapon.fireRange + targetRadius;
          }
        }
      }

      // Use unique entity ID based on unit ID and weapon index
      const soundEntityId = unit.id * 100 + i;

      if (hasTargetInRange) {
        audioEvents.push({
          type: 'laserStart',
          weaponId: config.id,
          x: unit.transform.x,
          y: unit.transform.y,
          entityId: soundEntityId,
        });
      } else {
        audioEvents.push({
          type: 'laserStop',
          weaponId: config.id,
          x: unit.transform.x,
          y: unit.transform.y,
          entityId: soundEntityId,
        });
      }
    }
  }

  return audioEvents;
}

// Update auto-targeting for all units
// Each weapon independently finds its own target using its own seeRange
export function updateAutoTargeting(world: WorldState): void {
  for (const unit of world.getUnits()) {
    if (!unit.ownership || !unit.unit || !unit.weapons) continue;
    if (unit.unit.hp <= 0) continue;

    const playerId = unit.ownership.playerId;
    const cos = Math.cos(unit.transform.rotation);
    const sin = Math.sin(unit.transform.rotation);

    // Each weapon finds its own target using its own seeRange
    for (const weapon of unit.weapons) {
      // Calculate weapon position in world coordinates (rotated)
      const weaponX = unit.transform.x + cos * weapon.offsetX - sin * weapon.offsetY;
      const weaponY = unit.transform.y + sin * weapon.offsetX + cos * weapon.offsetY;

      // Use weapon's own seeRange for tracking
      const trackingRange = weapon.seeRange;

      // Check if current target is still valid
      if (weapon.targetEntityId !== null) {
        const target = world.getEntity(weapon.targetEntityId);

        let targetIsValid = false;
        let targetRadius = 0;

        if (target?.unit && target.unit.hp > 0) {
          targetIsValid = true;
          targetRadius = target.unit.collisionRadius;
        } else if (target?.building && target.building.hp > 0) {
          targetIsValid = true;
          targetRadius = getTargetRadius(target);
        }

        if (targetIsValid && target) {
          const dist = distance(weaponX, weaponY, target.transform.x, target.transform.y);
          const effectiveTrackingRange = trackingRange + targetRadius;

          // Target still valid and in tracking range - keep tracking
          if (dist <= effectiveTrackingRange * 1.2) { // Allow some leeway
            continue;
          }
        }
        // Target invalid or out of tracking range, clear it
        weapon.targetEntityId = null;
      }

      // Find new target - use weapon's seeRange for acquisition
      const enemies = world.getEnemyEntities(playerId);
      let closestEnemy: Entity | null = null;
      let closestDist = Infinity;

      for (const enemy of enemies) {
        let isAlive = false;
        let enemyRadius = 0;

        if (enemy.unit && enemy.unit.hp > 0) {
          isAlive = true;
          enemyRadius = enemy.unit.collisionRadius;
        } else if (enemy.building && enemy.building.hp > 0) {
          isAlive = true;
          enemyRadius = getTargetRadius(enemy);
        }

        if (!isAlive) continue;

        const dist = distance(weaponX, weaponY, enemy.transform.x, enemy.transform.y);
        const effectiveTrackingRange = trackingRange + enemyRadius;

        if (dist <= effectiveTrackingRange && dist < closestDist) {
          closestDist = dist;
          closestEnemy = enemy;
        }
      }

      if (closestEnemy) {
        weapon.targetEntityId = closestEnemy.id;
      }
    }
  }
}

// Update weapon cooldowns
export function updateWeaponCooldowns(world: WorldState, dtMs: number): void {
  for (const unit of world.getUnits()) {
    if (!unit.weapons) continue;

    for (const weapon of unit.weapons) {
      if (weapon.currentCooldown > 0) {
        weapon.currentCooldown -= dtMs;
        if (weapon.currentCooldown < 0) {
          weapon.currentCooldown = 0;
        }
      }

      // Update burst cooldown
      if (weapon.burstCooldown !== undefined && weapon.burstCooldown > 0) {
        weapon.burstCooldown -= dtMs;
        if (weapon.burstCooldown < 0) {
          weapon.burstCooldown = 0;
        }
      }
    }
  }
}

// Check if a specific weapon has an active beam (by weapon index)
function hasActiveWeaponBeam(world: WorldState, unitId: EntityId, weaponIndex: number): boolean {
  for (const proj of world.getProjectiles()) {
    if (!proj.projectile) continue;
    if (proj.projectile.sourceEntityId !== unitId) continue;
    if (proj.projectile.projectileType !== 'beam') continue;
    // Check if this beam belongs to this weapon (stored in config metadata)
    if ((proj.projectile.config as { weaponIndex?: number }).weaponIndex !== weaponIndex) continue;
    // Don't count beams that will expire this frame
    if (proj.projectile.timeAlive + FIXED_TIMESTEP >= proj.projectile.maxLifespan) continue;
    return true;
  }
  return false;
}

// Update isFiring state for all weapons
// This should be called before movement decisions are made
export function updateWeaponFiringState(world: WorldState): void {
  for (const unit of world.getUnits()) {
    if (!unit.weapons) continue;

    const unitCos = Math.cos(unit.transform.rotation);
    const unitSin = Math.sin(unit.transform.rotation);

    for (const weapon of unit.weapons) {
      // Default to not firing
      weapon.isFiring = false;

      // Check if weapon has a valid target
      if (weapon.targetEntityId === null) continue;

      const target = world.getEntity(weapon.targetEntityId);
      if (!target) continue;

      // Check if target is alive
      const targetIsUnit = target.unit && target.unit.hp > 0;
      const targetIsBuilding = target.building && target.building.hp > 0;
      if (!targetIsUnit && !targetIsBuilding) continue;

      // Calculate weapon position
      const weaponX = unit.transform.x + unitCos * weapon.offsetX - unitSin * weapon.offsetY;
      const weaponY = unit.transform.y + unitSin * weapon.offsetX + unitCos * weapon.offsetY;

      // Check if target is in weapon's fire range
      const dist = distance(weaponX, weaponY, target.transform.x, target.transform.y);
      const targetRadius = getTargetRadius(target);

      if (dist <= weapon.fireRange + targetRadius) {
        weapon.isFiring = true;
      }
    }
  }
}

// Fire weapons at targets - unified for all units
// Each weapon fires independently based on its own state
export function fireWeapons(world: WorldState): FireWeaponsResult {
  const newProjectiles: Entity[] = [];
  const audioEvents: AudioEvent[] = [];

  for (const unit of world.getUnits()) {
    if (!unit.ownership || !unit.unit || !unit.weapons) continue;
    if (unit.unit.hp <= 0) continue;

    const playerId = unit.ownership.playerId;
    const unitCos = Math.cos(unit.transform.rotation);
    const unitSin = Math.sin(unit.transform.rotation);

    // Fire each weapon independently
    for (let weaponIndex = 0; weaponIndex < unit.weapons.length; weaponIndex++) {
      const weapon = unit.weapons[weaponIndex];
      const config = weapon.config;
      const isBeamWeapon = config.beamDuration !== undefined;
      const isContinuousBeam = isBeamWeapon && config.cooldown === 0;
      const isCooldownBeam = isBeamWeapon && config.cooldown > 0;

      // Skip if weapon is not firing (target not in range or no target)
      if (!weapon.isFiring) continue;

      const target = world.getEntity(weapon.targetEntityId!);
      if (!target) {
        weapon.targetEntityId = null;
        weapon.isFiring = false;
        continue;
      }

      // Calculate weapon position in world coordinates
      const weaponX = unit.transform.x + unitCos * weapon.offsetX - unitSin * weapon.offsetY;
      const weaponY = unit.transform.y + unitSin * weapon.offsetX + unitCos * weapon.offsetY;

      // Check cooldown / active beam
      if (isContinuousBeam) {
        if (hasActiveWeaponBeam(world, unit.id, weaponIndex)) continue;
      } else {
        const canFire = weapon.currentCooldown <= 0;
        const canBurstFire = weapon.burstShotsRemaining !== undefined &&
          weapon.burstShotsRemaining > 0 &&
          (weapon.burstCooldown === undefined || weapon.burstCooldown <= 0);

        if (!canFire && !canBurstFire) continue;

        if (isCooldownBeam && hasActiveWeaponBeam(world, unit.id, weaponIndex)) continue;
      }

      // Handle cooldowns
      if (!isContinuousBeam) {
        const canFire = weapon.currentCooldown <= 0;
        const canBurstFire = weapon.burstShotsRemaining !== undefined &&
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
          weapon.currentCooldown = config.cooldown;
          if (config.burstCount && config.burstCount > 1) {
            weapon.burstShotsRemaining = config.burstCount - 1;
            weapon.burstCooldown = config.burstDelay ?? 80;
          }
        }
      }

      // Add fire audio event
      if (!isBeamWeapon || isCooldownBeam) {
        audioEvents.push({
          type: 'fire',
          weaponId: config.id,
          x: weaponX,
          y: weaponY,
        });
      }

      // Fire the weapon in turret direction
      const turretAngle = weapon.turretRotation;

      // Create projectile(s)
      const pellets = config.pelletCount ?? 1;
      const spreadAngle = config.spreadAngle ?? 0;

      for (let i = 0; i < pellets; i++) {
        // Calculate spread
        let angle = turretAngle;
        if (pellets > 1 && spreadAngle > 0) {
          const spreadOffset = (i / (pellets - 1) - 0.5) * spreadAngle;
          angle += spreadOffset;
        } else if (pellets === 1 && spreadAngle > 0) {
          angle += (world.rng.next() - 0.5) * spreadAngle;
        }

        const fireCos = Math.cos(angle);
        const fireSin = Math.sin(angle);

        // Spawn position
        const spawnX = weaponX + fireCos * 5;
        const spawnY = weaponY + fireSin * 5;

        if (isBeamWeapon) {
          // Create beam using weapon's fireRange
          const beamLength = weapon.fireRange;
          const endX = spawnX + fireCos * beamLength;
          const endY = spawnY + fireSin * beamLength;

          // Create config with weaponIndex for beam tracking
          const beamConfig = { ...config, weaponIndex };
          const beam = world.createBeam(spawnX, spawnY, endX, endY, playerId, unit.id, beamConfig);
          if (beam.projectile) {
            beam.projectile.sourceEntityId = unit.id;
          }
          newProjectiles.push(beam);
        } else if (config.projectileSpeed !== undefined) {
          // Create traveling projectile
          const speed = config.projectileSpeed;
          const projectile = world.createProjectile(
            spawnX,
            spawnY,
            fireCos * speed,
            fireSin * speed,
            playerId,
            unit.id,
            config,
            'traveling'
          );
          newProjectiles.push(projectile);
        }
      }
    }
  }

  return { projectiles: newProjectiles, audioEvents };
}

// Apply wave weapon damage (continuous pie-slice AoE with inverse-square falloff)
// Wave weapons like Sonic deal damage to all enemies within a pie-slice area
export function applyWaveDamage(world: WorldState, dtMs: number): void {
  const dtSec = dtMs / 1000;
  if (dtSec <= 0) return;

  for (const unit of world.getUnits()) {
    if (!unit.ownership || !unit.unit || !unit.weapons) continue;
    if (unit.unit.hp <= 0) continue;

    const playerId = unit.ownership.playerId;
    const unitCos = Math.cos(unit.transform.rotation);
    const unitSin = Math.sin(unit.transform.rotation);

    for (const weapon of unit.weapons) {
      const config = weapon.config;

      // Only process wave weapons
      if (!config.isWaveWeapon) continue;

      // Only deal damage when firing (has a target)
      if (!weapon.isFiring) continue;

      // Wave weapon properties
      const sliceHalfAngle = (config.sliceAngle ?? Math.PI / 4) / 2; // Half the total slice angle
      const maxRange = weapon.fireRange;
      const baseDamage = config.damage; // DPS at reference distance

      // Calculate weapon position
      const weaponX = unit.transform.x + unitCos * weapon.offsetX - unitSin * weapon.offsetY;
      const weaponY = unit.transform.y + unitSin * weapon.offsetX + unitCos * weapon.offsetY;

      // Get turret direction
      const turretAngle = weapon.turretRotation;

      // Check all enemy units
      for (const enemy of world.getUnits()) {
        if (!enemy.unit || !enemy.ownership) continue;
        if (enemy.ownership.playerId === playerId) continue; // Skip friendlies
        if (enemy.unit.hp <= 0) continue; // Skip dead units

        const enemyX = enemy.transform.x;
        const enemyY = enemy.transform.y;
        const enemyRadius = enemy.unit.collisionRadius;

        // Check distance
        const dx = enemyX - weaponX;
        const dy = enemyY - weaponY;
        const dist = Math.sqrt(dx * dx + dy * dy);

        // Skip if out of range (accounting for enemy radius)
        if (dist > maxRange + enemyRadius) continue;

        // Calculate angle to enemy
        const angleToEnemy = Math.atan2(dy, dx);
        const angleDiff = normalizeAngle(angleToEnemy - turretAngle);

        // Check if within pie slice angle (account for enemy radius)
        const angularSize = dist > 0 ? Math.atan2(enemyRadius, dist) : Math.PI;
        if (Math.abs(angleDiff) > sliceHalfAngle + angularSize) continue;

        // Enemy is in the slice - apply constant damage
        const damage = baseDamage * dtSec;

        // Apply damage
        enemy.unit.hp -= damage;
      }

      // Check all enemy buildings
      for (const building of world.getBuildings()) {
        if (!building.building || !building.ownership) continue;
        if (building.ownership.playerId === playerId) continue; // Skip friendly buildings
        if (building.building.hp <= 0) continue; // Skip destroyed buildings

        const buildingX = building.transform.x;
        const buildingY = building.transform.y;
        const bWidth = building.building.width;
        const bHeight = building.building.height;
        const buildingRadius = Math.sqrt(bWidth * bWidth + bHeight * bHeight) / 2;

        // Check distance
        const dx = buildingX - weaponX;
        const dy = buildingY - weaponY;
        const dist = Math.sqrt(dx * dx + dy * dy);

        // Skip if out of range
        if (dist > maxRange + buildingRadius) continue;

        // Calculate angle to building
        const angleToBuilding = Math.atan2(dy, dx);
        const angleDiff = normalizeAngle(angleToBuilding - turretAngle);

        // Check if within pie slice angle
        const angularSize = dist > 0 ? Math.atan2(buildingRadius, dist) : Math.PI;
        if (Math.abs(angleDiff) > sliceHalfAngle + angularSize) continue;

        // Building is in the slice - apply constant damage
        const damage = baseDamage * dtSec;

        // Apply damage
        building.building.hp -= damage;
      }
    }
  }
}

// Update projectile positions - returns IDs of projectiles to remove (e.g., orphaned beams)
export function updateProjectiles(world: WorldState, dtMs: number): EntityId[] {
  const dtSec = dtMs / 1000;
  const projectilesToRemove: EntityId[] = [];

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

      // Remove beam if source unit is dead or gone
      if (!source || !source.unit || source.unit.hp <= 0 || !source.weapons) {
        projectilesToRemove.push(entity.id);
        continue;
      }

      if (source && source.unit && source.weapons) {
        // Get weapon index from config
        const weaponIndex = (proj.config as { weaponIndex?: number }).weaponIndex ?? 0;
        const weapon = source.weapons[weaponIndex];

        if (!weapon) {
          projectilesToRemove.push(entity.id);
          continue;
        }

        // Get turret direction from specific weapon
        const turretAngle = weapon.turretRotation;
        const dirX = Math.cos(turretAngle);
        const dirY = Math.sin(turretAngle);

        // Calculate weapon position in world coordinates
        const unitCos = Math.cos(source.transform.rotation);
        const unitSin = Math.sin(source.transform.rotation);
        const weaponX = source.transform.x + unitCos * weapon.offsetX - unitSin * weapon.offsetY;
        const weaponY = source.transform.y + unitSin * weapon.offsetX + unitCos * weapon.offsetY;

        // Beam starts at weapon position
        proj.startX = weaponX + dirX * 5;
        proj.startY = weaponY + dirY * 5;

        // Initially set beam to full length
        const beamLength = proj.config.range;
        const fullEndX = proj.startX + dirX * beamLength;
        const fullEndY = proj.startY + dirY * beamLength;

        // Find closest hit to truncate beam
        const closestT = findClosestBeamHit(
          world,
          proj.startX, proj.startY,
          fullEndX, fullEndY,
          proj.sourceEntityId,
          proj.config.beamWidth ?? 2
        );

        // Set beam end based on closest hit (or full length if no hit)
        // Extend slightly past hit point (t + 0.05) to ensure collision detection works
        if (closestT !== null && closestT < 1) {
          const extendedT = Math.min(closestT + 0.05, 1.0);
          proj.endX = proj.startX + (fullEndX - proj.startX) * extendedT;
          proj.endY = proj.startY + (fullEndY - proj.startY) * extendedT;
        } else {
          proj.endX = fullEndX;
          proj.endY = fullEndY;
        }

        // Update entity transform to match beam start (for visual reference)
        entity.transform.x = proj.startX;
        entity.transform.y = proj.startY;
        entity.transform.rotation = turretAngle;
      }
    }
  }

  return projectilesToRemove;
}

// Find the closest hit point along a beam (returns T value 0-1, or null if no hit)
function findClosestBeamHit(
  world: WorldState,
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  sourceEntityId: EntityId,
  beamWidth: number
): number | null {
  let closestT: number | null = null;

  // Check all units (except source)
  for (const unit of world.getUnits()) {
    if (unit.id === sourceEntityId) continue;
    if (!unit.unit || unit.unit.hp <= 0) continue;

    const t = lineCircleIntersectionT(
      startX, startY, endX, endY,
      unit.transform.x, unit.transform.y,
      unit.unit.collisionRadius + beamWidth / 2
    );

    if (t !== null && (closestT === null || t < closestT)) {
      closestT = t;
    }
  }

  // Check all buildings
  for (const building of world.getBuildings()) {
    if (!building.building || building.building.hp <= 0) continue;

    const bWidth = building.building.width;
    const bHeight = building.building.height;
    const rectX = building.transform.x - bWidth / 2;
    const rectY = building.transform.y - bHeight / 2;

    const t = lineRectIntersectionT(
      startX, startY, endX, endY,
      rectX, rectY, bWidth, bHeight
    );

    if (t !== null && (closestT === null || t < closestT)) {
      closestT = t;
    }
  }

  return closestT;
}

// Check projectile collisions and apply damage
// Friendly fire is enabled - projectiles hit ALL units and buildings
export function checkProjectileCollisions(world: WorldState, dtMs: number): CollisionResult {
  const projectilesToRemove: EntityId[] = [];
  const unitsToRemove: EntityId[] = [];
  const buildingsToRemove: EntityId[] = [];
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
        const splashHits = applyAoEDamage(world, projEntity, unitsToRemove, buildingsToRemove);
        proj.hasExploded = true;

        // Add explosion audio event if there were hits or it's a mortar
        if (splashHits > 0 || config.id === 'mortar') {
          audioEvents.push({
            type: 'hit',
            weaponId: config.id,
            x: projEntity.transform.x,
            y: projEntity.transform.y,
          });
        }
      }

      // Add projectile expire event for traveling projectiles (not beams)
      // This creates an explosion effect at projectile termination point
      if (proj.projectileType === 'traveling' && !proj.hasExploded) {
        audioEvents.push({
          type: 'projectileExpire',
          weaponId: config.id,
          x: projEntity.transform.x,
          y: projEntity.transform.y,
        });
      }

      projectilesToRemove.push(projEntity.id);
      continue;
    }

    // Get ALL units (friendly fire enabled) - exclude the source unit
    const allUnits = world.getUnits().filter(u => u.id !== proj.sourceEntityId);

    for (const target of allUnits) {
      if (!target.unit || target.unit.hp <= 0) continue;

      // For non-beam projectiles, skip if already hit this entity
      if (proj.projectileType !== 'beam' && proj.hitEntities.has(target.id)) continue;

      let hit = false;

      if (proj.projectileType === 'beam') {
        // Line-circle intersection for beams
        hit = lineCircleIntersection(
          proj.startX ?? projEntity.transform.x,
          proj.startY ?? projEntity.transform.y,
          proj.endX ?? projEntity.transform.x,
          proj.endY ?? projEntity.transform.y,
          target.transform.x,
          target.transform.y,
          target.unit.collisionRadius + (config.beamWidth ?? 2) / 2
        );
      } else {
        // Circle-circle intersection for projectiles
        const projRadius = config.projectileRadius ?? 5;
        const dist = distance(
          projEntity.transform.x,
          projEntity.transform.y,
          target.transform.x,
          target.transform.y
        );
        hit = dist <= projRadius + target.unit.collisionRadius;
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
          proj.hitEntities.add(target.id);
        }

        // Apply damage
        target.unit.hp -= damage;

        // Add hit audio event (skip for continuous beams - they just have the continuous laser sound)
        const isContinuousBeam = proj.projectileType === 'beam' && config.cooldown === 0;
        if (!isContinuousBeam) {
          if (proj.projectileType !== 'beam' || !proj.hitEntities.has(target.id)) {
            audioEvents.push({
              type: 'hit',
              weaponId: config.id,
              x: target.transform.x,
              y: target.transform.y,
            });
            // Mark beam as having played hit sound for this target
            if (proj.projectileType === 'beam') {
              proj.hitEntities.add(target.id);
            }
          }
        }

        // Check for splash damage (only for non-beam projectiles)
        if (config.splashRadius && !proj.hasExploded && proj.projectileType !== 'beam') {
          applyAoEDamage(world, projEntity, unitsToRemove, buildingsToRemove);
          proj.hasExploded = true;
        }

        // Check if unit died
        if (target.unit.hp <= 0 && !unitsToRemove.includes(target.id)) {
          // Add death audio event based on the dying unit's weapon type
          // Loop through all weapons to get type
          let deathWeaponId = 'scout';
          const targetWeapons = target.weapons ?? [];
          for (const weapon of targetWeapons) {
            deathWeaponId = weapon.config.id;
          }
          audioEvents.push({
            type: 'death',
            weaponId: deathWeaponId,
            x: target.transform.x,
            y: target.transform.y,
          });
          unitsToRemove.push(target.id);
        }

        // Check if projectile should be removed (beams persist for full duration)
        if (proj.hitEntities.size >= proj.maxHits && proj.projectileType !== 'beam') {
          projectilesToRemove.push(projEntity.id);
          break;
        }
      }
    }

    // Check building collisions (friendly fire enabled)
    const allBuildings = world.getBuildings();

    for (const building of allBuildings) {
      if (!building.building || building.building.hp <= 0) continue;

      // For non-beam projectiles, skip if already hit this entity
      if (proj.projectileType !== 'beam' && proj.hitEntities.has(building.id)) continue;

      const bWidth = building.building.width;
      const bHeight = building.building.height;
      const bLeft = building.transform.x - bWidth / 2;
      const bTop = building.transform.y - bHeight / 2;

      let hit = false;

      if (proj.projectileType === 'beam') {
        // Line-rectangle intersection for beams
        hit = lineRectIntersection(
          proj.startX ?? projEntity.transform.x,
          proj.startY ?? projEntity.transform.y,
          proj.endX ?? projEntity.transform.x,
          proj.endY ?? projEntity.transform.y,
          bLeft,
          bTop,
          bWidth,
          bHeight
        );
      } else {
        // Circle-rectangle intersection for projectiles
        const projRadius = config.projectileRadius ?? 5;
        hit = circleRectIntersection(
          projEntity.transform.x,
          projEntity.transform.y,
          projRadius,
          bLeft,
          bTop,
          bWidth,
          bHeight
        );
      }

      if (hit) {
        // Calculate damage based on projectile type
        let damage: number;
        if (proj.projectileType === 'beam') {
          const beamDuration = config.beamDuration ?? 150;
          damage = (config.damage / beamDuration) * dtMs;
        } else {
          damage = config.damage;
          proj.hitEntities.add(building.id);
        }

        // Apply damage to building
        building.building.hp -= damage;

        // Add hit audio event
        const isContinuousBeam = proj.projectileType === 'beam' && config.cooldown === 0;
        if (!isContinuousBeam) {
          if (proj.projectileType !== 'beam' || !proj.hitEntities.has(building.id)) {
            audioEvents.push({
              type: 'hit',
              weaponId: config.id,
              x: building.transform.x,
              y: building.transform.y,
            });
            if (proj.projectileType === 'beam') {
              proj.hitEntities.add(building.id);
            }
          }
        }

        // Check for splash damage
        if (config.splashRadius && !proj.hasExploded && proj.projectileType !== 'beam') {
          applyAoEDamage(world, projEntity, unitsToRemove, buildingsToRemove);
          proj.hasExploded = true;
        }

        // Check if building destroyed
        if (building.building.hp <= 0 && !buildingsToRemove.includes(building.id)) {
          audioEvents.push({
            type: 'death',
            weaponId: config.id,
            x: building.transform.x,
            y: building.transform.y,
          });
          buildingsToRemove.push(building.id);
        }

        // Check if projectile should be removed
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

  return { deadUnitIds: unitsToRemove, deadBuildingIds: buildingsToRemove, audioEvents };
}

// Circle-rectangle intersection test
function circleRectIntersection(
  cx: number,
  cy: number,
  radius: number,
  rectX: number,
  rectY: number,
  rectWidth: number,
  rectHeight: number
): boolean {
  // Find closest point on rectangle to circle center
  const closestX = Math.max(rectX, Math.min(cx, rectX + rectWidth));
  const closestY = Math.max(rectY, Math.min(cy, rectY + rectHeight));

  // Calculate distance from closest point to circle center
  const dx = cx - closestX;
  const dy = cy - closestY;

  return (dx * dx + dy * dy) <= (radius * radius);
}

// Line-rectangle intersection test
function lineRectIntersection(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  rectX: number,
  rectY: number,
  rectWidth: number,
  rectHeight: number
): boolean {
  // Check if line intersects any of the 4 edges of the rectangle
  const left = rectX;
  const right = rectX + rectWidth;
  const top = rectY;
  const bottom = rectY + rectHeight;

  // Check if either endpoint is inside the rectangle
  if ((x1 >= left && x1 <= right && y1 >= top && y1 <= bottom) ||
      (x2 >= left && x2 <= right && y2 >= top && y2 <= bottom)) {
    return true;
  }

  // Check intersection with each edge
  return lineLineIntersection(x1, y1, x2, y2, left, top, right, top) ||     // Top
         lineLineIntersection(x1, y1, x2, y2, left, bottom, right, bottom) || // Bottom
         lineLineIntersection(x1, y1, x2, y2, left, top, left, bottom) ||     // Left
         lineLineIntersection(x1, y1, x2, y2, right, top, right, bottom);     // Right
}

// Line-line intersection test (boolean)
function lineLineIntersection(
  x1: number, y1: number, x2: number, y2: number,
  x3: number, y3: number, x4: number, y4: number
): boolean {
  return lineLineIntersectionT(x1, y1, x2, y2, x3, y3, x4, y4) !== null;
}

// Apply AoE damage around a point - returns number of hits
// Friendly fire enabled - damages ALL units and buildings in range
function applyAoEDamage(
  world: WorldState,
  projEntity: Entity,
  unitsToRemove: EntityId[],
  buildingsToRemove: EntityId[]
): number {
  if (!projEntity.projectile) return 0;

  const proj = projEntity.projectile;
  const config = proj.config;
  const splashRadius = config.splashRadius ?? 0;
  const falloff = config.splashDamageFalloff ?? 0.5;

  let hitCount = 0;

  // Damage ALL units (friendly fire enabled) - exclude source unit
  const allUnits = world.getUnits().filter(u => u.id !== proj.sourceEntityId);

  for (const target of allUnits) {
    if (!target.unit || target.unit.hp <= 0) continue;
    if (proj.hitEntities.has(target.id)) continue; // Don't double-hit

    const dist = distance(
      projEntity.transform.x,
      projEntity.transform.y,
      target.transform.x,
      target.transform.y
    );

    if (dist <= splashRadius + target.unit.collisionRadius) {
      proj.hitEntities.add(target.id);
      hitCount++;

      // Calculate damage with falloff
      const distRatio = Math.min(1, dist / splashRadius);
      const damageMultiplier = 1 - distRatio * (1 - falloff);
      const damage = config.damage * damageMultiplier;

      target.unit.hp -= damage;

      if (target.unit.hp <= 0 && !unitsToRemove.includes(target.id)) {
        unitsToRemove.push(target.id);
      }
    }
  }

  // Damage ALL buildings in splash radius
  const allBuildings = world.getBuildings();

  for (const building of allBuildings) {
    if (!building.building || building.building.hp <= 0) continue;
    if (proj.hitEntities.has(building.id)) continue; // Don't double-hit

    // Calculate distance from explosion to building center
    const dist = distance(
      projEntity.transform.x,
      projEntity.transform.y,
      building.transform.x,
      building.transform.y
    );

    // Use diagonal of building as effective radius for splash check
    const bWidth = building.building.width;
    const bHeight = building.building.height;
    const buildingRadius = Math.sqrt(bWidth * bWidth + bHeight * bHeight) / 2;

    if (dist <= splashRadius + buildingRadius) {
      proj.hitEntities.add(building.id);
      hitCount++;

      // Calculate damage with falloff
      const distRatio = Math.min(1, dist / splashRadius);
      const damageMultiplier = 1 - distRatio * (1 - falloff);
      const damage = config.damage * damageMultiplier;

      building.building.hp -= damage;

      if (building.building.hp <= 0 && !buildingsToRemove.includes(building.id)) {
        buildingsToRemove.push(building.id);
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
  const t = lineCircleIntersectionT(x1, y1, x2, y2, cx, cy, r);
  return t !== null;
}

// Line-circle intersection - returns parametric T value (0-1) of first intersection, or null
function lineCircleIntersectionT(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  cx: number,
  cy: number,
  r: number
): number | null {
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
    return null;
  }

  discriminant = Math.sqrt(discriminant);

  const t1 = (-b - discriminant) / (2 * a);
  const t2 = (-b + discriminant) / (2 * a);

  // Return smallest t in valid range [0, 1]
  if (t1 >= 0 && t1 <= 1) return t1;
  if (t2 >= 0 && t2 <= 1) return t2;
  return null;
}

// Line-rectangle intersection - returns parametric T value (0-1) of first intersection, or null
function lineRectIntersectionT(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  rectX: number,
  rectY: number,
  rectWidth: number,
  rectHeight: number
): number | null {
  const left = rectX;
  const right = rectX + rectWidth;
  const top = rectY;
  const bottom = rectY + rectHeight;

  // If start point is inside rectangle, intersection is at t=0
  if (x1 >= left && x1 <= right && y1 >= top && y1 <= bottom) {
    return 0;
  }

  // Check intersection with each edge, track smallest t
  let minT: number | null = null;

  const edges = [
    [left, top, right, top],       // Top
    [left, bottom, right, bottom], // Bottom
    [left, top, left, bottom],     // Left
    [right, top, right, bottom],   // Right
  ];

  for (const [x3, y3, x4, y4] of edges) {
    const t = lineLineIntersectionT(x1, y1, x2, y2, x3, y3, x4, y4);
    if (t !== null && (minT === null || t < minT)) {
      minT = t;
    }
  }

  return minT;
}

// Line-line intersection - returns T value for first line, or null
function lineLineIntersectionT(
  x1: number, y1: number, x2: number, y2: number,
  x3: number, y3: number, x4: number, y4: number
): number | null {
  const denom = (y4 - y3) * (x2 - x1) - (x4 - x3) * (y2 - y1);
  if (Math.abs(denom) < 0.0001) return null; // Lines are parallel

  const ua = ((x4 - x3) * (y1 - y3) - (y4 - y3) * (x1 - x3)) / denom;
  const ub = ((x2 - x1) * (y1 - y3) - (y2 - y1) * (x1 - x3)) / denom;

  if (ua >= 0 && ua <= 1 && ub >= 0 && ub <= 1) {
    return ua;
  }
  return null;
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

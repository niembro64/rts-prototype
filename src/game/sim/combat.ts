import type { WorldState } from './WorldState';
import type { Entity, EntityId } from './types';
import { FIXED_TIMESTEP } from './Simulation';
import { DamageSystem } from './damage';
import type { ForceAccumulator } from './ForceAccumulator';

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
// Units ALWAYS check for closer targets and switch to them
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

      // Use weapon's own seeRange for tracking (strict - no leeway)
      const trackingRange = weapon.seeRange;

      // Track current target distance for comparison
      let currentTargetDist = Infinity;

      // Check if current target is still valid and in range
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

          // Target still valid and in strict tracking range
          if (dist <= effectiveTrackingRange) {
            currentTargetDist = dist;
            // Don't continue here - always check for closer targets below
          } else {
            // Target out of range, clear it
            weapon.targetEntityId = null;
          }
        } else {
          // Target invalid (dead or gone), clear it
          weapon.targetEntityId = null;
        }
      }

      // Always search for closest enemy - switch if closer than current target
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

      // Switch to closer target if found, or set new target if no current target
      if (closestEnemy && closestDist < currentTargetDist) {
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

// Update isFiring and inFightstopRange state for all weapons
// This should be called before movement decisions are made
// - isFiring: true when target is within fireRange (weapon will fire)
// - inFightstopRange: true when target is within fightstopRange (unit should consider stopping in fight mode)
export function updateWeaponFiringState(world: WorldState): void {
  for (const unit of world.getUnits()) {
    if (!unit.weapons) continue;

    const unitCos = Math.cos(unit.transform.rotation);
    const unitSin = Math.sin(unit.transform.rotation);

    for (const weapon of unit.weapons) {
      // Default to not firing and not in fightstop range
      weapon.isFiring = false;
      weapon.inFightstopRange = false;

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

      // Check distance to target
      const dist = distance(weaponX, weaponY, target.transform.x, target.transform.y);
      const targetRadius = getTargetRadius(target);

      // Check if target is in weapon's fire range
      if (dist <= weapon.fireRange + targetRadius) {
        weapon.isFiring = true;
      }

      // Check if target is in weapon's fightstop range (tighter than fire range)
      if (dist <= weapon.fightstopRange + targetRadius) {
        weapon.inFightstopRange = true;
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

// Update wave weapon state (transition between idle and attack angles)
// Call this before applyWaveDamage each frame
export function updateWaveWeaponState(world: WorldState, dtMs: number): void {
  for (const unit of world.getUnits()) {
    if (!unit.weapons) continue;

    for (const weapon of unit.weapons) {
      const config = weapon.config;
      if (!config.isWaveWeapon) continue;

      const angleIdle = config.waveAngleIdle ?? Math.PI / 16;
      const angleAttack = config.waveAngleAttack ?? Math.PI / 4;
      const transitionTime = config.waveTransitionTime ?? 1000;

      // Initialize wave state if not set
      if (weapon.waveTransitionProgress === undefined) {
        weapon.waveTransitionProgress = 0;
        weapon.currentSliceAngle = angleIdle;
      }

      // Move progress toward target based on firing state
      const targetProgress = weapon.isFiring ? 1 : 0;
      const progressDelta = dtMs / transitionTime;

      if (weapon.waveTransitionProgress < targetProgress) {
        // Transitioning to attack
        weapon.waveTransitionProgress = Math.min(weapon.waveTransitionProgress + progressDelta, 1);
      } else if (weapon.waveTransitionProgress > targetProgress) {
        // Transitioning to idle
        weapon.waveTransitionProgress = Math.max(weapon.waveTransitionProgress - progressDelta, 0);
      }

      // Interpolate angle based on progress
      weapon.currentSliceAngle = angleIdle + (angleAttack - angleIdle) * weapon.waveTransitionProgress;
    }
  }
}

// Apply wave weapon damage (continuous pie-slice AoE)
// Wave weapons like Sonic AIM at a specific target (for turret rotation) but deal damage
// to ALL units and buildings within the pie-slice area, not just the target.
// The slice expands/contracts based on firing state (see updateWaveWeaponState).
// Uses DamageSystem for unified area damage with slice support.
// Also applies a pull effect, drawing units toward the wave origin.

// Pull strength in units per second (how fast units are pulled toward wave origin)
const WAVE_PULL_STRENGTH = 15;

// Helper: Check if a point is within a pie slice
function isPointInSlice(
  px: number, py: number,
  originX: number, originY: number,
  sliceDirection: number,
  sliceHalfAngle: number,
  maxRadius: number,
  targetRadius: number
): boolean {
  const dx = px - originX;
  const dy = py - originY;
  const dist = Math.sqrt(dx * dx + dy * dy);

  // Check distance (accounting for target radius)
  if (dist > maxRadius + targetRadius) return false;

  // Check angle (accounting for target angular size)
  const angleToPoint = Math.atan2(dy, dx);
  const angleDiff = normalizeAngle(angleToPoint - sliceDirection);
  const angularSize = dist > 0 ? Math.atan2(targetRadius, dist) : Math.PI;

  return Math.abs(angleDiff) <= sliceHalfAngle + angularSize;
}

export function applyWaveDamage(
  world: WorldState,
  dtMs: number,
  damageSystem: DamageSystem,
  forceAccumulator?: ForceAccumulator
): void {
  const dtSec = dtMs / 1000;
  if (dtSec <= 0) return;

  for (const unit of world.getUnits()) {
    if (!unit.ownership || !unit.unit || !unit.weapons) continue;
    if (unit.unit.hp <= 0) continue;

    const unitCos = Math.cos(unit.transform.rotation);
    const unitSin = Math.sin(unit.transform.rotation);
    const sourcePlayerId = unit.ownership.playerId;

    for (const weapon of unit.weapons) {
      const config = weapon.config;

      // Only process wave weapons
      if (!config.isWaveWeapon) continue;

      // Only deal damage when slice angle is greater than 0 (expanding, active, or cooldown)
      const currentAngle = weapon.currentSliceAngle ?? 0;
      if (currentAngle <= 0) continue;

      // Wave weapon properties - use dynamic slice angle
      const baseDamage = config.damage; // DPS at reference distance
      const damage = baseDamage * dtSec;

      // Calculate weapon position
      const weaponX = unit.transform.x + unitCos * weapon.offsetX - unitSin * weapon.offsetY;
      const weaponY = unit.transform.y + unitSin * weapon.offsetX + unitCos * weapon.offsetY;

      // Get turret direction
      const turretAngle = weapon.turretRotation;
      const sliceHalfAngle = currentAngle / 2;

      // Apply area damage with slice using unified DamageSystem
      damageSystem.applyDamage({
        type: 'area',
        sourceEntityId: unit.id,
        ownerId: unit.ownership.playerId,
        damage: damage,
        excludeEntities: new Set(), // Wave weapons can hit same targets every frame (DPS)
        centerX: weaponX,
        centerY: weaponY,
        radius: weapon.fireRange,
        falloff: 1, // No falloff - constant damage across distance
        sliceAngle: currentAngle,
        sliceDirection: turretAngle,
      });

      // Apply pull effect to all enemy units in the slice
      for (const target of world.getUnits()) {
        if (!target.unit || target.unit.hp <= 0) continue;
        // Don't pull friendly units
        if (target.ownership?.playerId === sourcePlayerId) continue;
        // Don't pull self
        if (target.id === unit.id) continue;

        const targetRadius = target.unit.collisionRadius;

        // Check if target is in the wave slice
        if (!isPointInSlice(
          target.transform.x, target.transform.y,
          weaponX, weaponY,
          turretAngle,
          sliceHalfAngle,
          weapon.fireRange,
          targetRadius
        )) continue;

        // Calculate pull direction (toward wave origin)
        const dx = weaponX - target.transform.x;
        const dy = weaponY - target.transform.y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist > 0 && forceAccumulator) {
          // Get target's mass from its body (default to 1 if no physics body)
          const targetMass = (target.body?.matterBody as { mass?: number })?.mass ?? 1;

          // Add directional force toward wave origin
          // affectedByMass=true so heavier units resist the pull more
          forceAccumulator.addDirectionalForce(
            target.id,
            dx,  // direction X (toward wave origin)
            dy,  // direction Y (toward wave origin)
            WAVE_PULL_STRENGTH,
            targetMass,
            true,  // heavier units resist pull
            'wave_pull'
          );
        }
      }
    }
  }
}

// Update projectile positions - returns IDs of projectiles to remove (e.g., orphaned beams)
export function updateProjectiles(world: WorldState, dtMs: number, damageSystem: DamageSystem): EntityId[] {
  const dtSec = dtMs / 1000;
  const projectilesToRemove: EntityId[] = [];

  for (const entity of world.getProjectiles()) {
    if (!entity.projectile) continue;

    const proj = entity.projectile;

    // Update time alive
    proj.timeAlive += dtMs;

    // Move traveling projectiles - track previous position for swept collision detection
    if (proj.projectileType === 'traveling') {
      // Store previous position before moving (prevents tunneling through targets)
      proj.prevX = entity.transform.x;
      proj.prevY = entity.transform.y;

      // Move projectile
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

        // Use weapon's fireRange for consistent beam length (not proj.config.range)
        const beamLength = weapon.fireRange;
        const fullEndX = proj.startX + dirX * beamLength;
        const fullEndY = proj.startY + dirY * beamLength;

        // Find closest obstruction using unified DamageSystem
        const beamWidth = proj.config.beamWidth ?? 2;
        const obstruction = damageSystem.findLineObstruction(
          proj.startX, proj.startY,
          fullEndX, fullEndY,
          proj.sourceEntityId,
          beamWidth
        );

        // Truncate beam exactly at obstruction point (no extension needed)
        if (obstruction) {
          proj.endX = proj.startX + (fullEndX - proj.startX) * obstruction.t;
          proj.endY = proj.startY + (fullEndY - proj.startY) * obstruction.t;
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

// Check projectile collisions and apply damage
// Friendly fire is enabled - projectiles hit ALL units and buildings
// Uses DamageSystem for unified collision detection (swept volumes, line damage, etc.)
export function checkProjectileCollisions(world: WorldState, dtMs: number, damageSystem: DamageSystem): CollisionResult {
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
        const splashResult = damageSystem.applyDamage({
          type: 'area',
          sourceEntityId: proj.sourceEntityId,
          ownerId: projEntity.ownership.playerId,
          damage: config.damage,
          excludeEntities: proj.hitEntities,
          centerX: projEntity.transform.x,
          centerY: projEntity.transform.y,
          radius: config.splashRadius,
          falloff: config.splashDamageFalloff ?? 0.5,
        });
        proj.hasExploded = true;

        // Track killed entities
        for (const id of splashResult.killedUnitIds) {
          if (!unitsToRemove.includes(id)) unitsToRemove.push(id);
        }
        for (const id of splashResult.killedBuildingIds) {
          if (!buildingsToRemove.includes(id)) buildingsToRemove.push(id);
        }

        // Add explosion audio event if there were hits or it's a shotgun
        if (splashResult.hitEntityIds.length > 0 || config.id === 'shotgun') {
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

    // Handle different projectile types with unified damage system
    if (proj.projectileType === 'beam') {
      // Beam damage uses line damage source
      const startX = proj.startX ?? projEntity.transform.x;
      const startY = proj.startY ?? projEntity.transform.y;
      const endX = proj.endX ?? projEntity.transform.x;
      const endY = proj.endY ?? projEntity.transform.y;
      const beamWidth = config.beamWidth ?? 2;

      // Calculate per-tick damage for continuous beams
      const beamDuration = config.beamDuration ?? 150;
      const tickDamage = (config.damage / beamDuration) * dtMs;

      // Apply line damage
      const result = damageSystem.applyDamage({
        type: 'line',
        sourceEntityId: proj.sourceEntityId,
        ownerId: projEntity.ownership.playerId,
        damage: tickDamage,
        excludeEntities: new Set(), // Beams can hit same targets repeatedly
        startX,
        startY,
        endX,
        endY,
        width: beamWidth,
        piercing: config.piercing ?? false,
        maxHits: config.piercing ? Infinity : 1,
      });

      // Handle hit audio events (skip for continuous beams)
      const isContinuousBeam = config.cooldown === 0;
      if (!isContinuousBeam) {
        for (const hitId of result.hitEntityIds) {
          if (!proj.hitEntities.has(hitId)) {
            const entity = world.getEntity(hitId);
            if (entity) {
              audioEvents.push({
                type: 'hit',
                weaponId: config.id,
                x: entity.transform.x,
                y: entity.transform.y,
              });
              proj.hitEntities.add(hitId);
            }
          }
        }
      }

      // Handle deaths
      for (const id of result.killedUnitIds) {
        if (!unitsToRemove.includes(id)) {
          const target = world.getEntity(id);
          let deathWeaponId = 'scout';
          const targetWeapons = target?.weapons ?? [];
          for (const weapon of targetWeapons) {
            deathWeaponId = weapon.config.id;
          }
          audioEvents.push({
            type: 'death',
            weaponId: deathWeaponId,
            x: target?.transform.x ?? 0,
            y: target?.transform.y ?? 0,
          });
          unitsToRemove.push(id);
        }
      }
      for (const id of result.killedBuildingIds) {
        if (!buildingsToRemove.includes(id)) {
          const building = world.getEntity(id);
          audioEvents.push({
            type: 'death',
            weaponId: config.id,
            x: building?.transform.x ?? 0,
            y: building?.transform.y ?? 0,
          });
          buildingsToRemove.push(id);
        }
      }
    } else {
      // Traveling projectiles use swept volume collision (prevents tunneling)
      const projRadius = config.projectileRadius ?? 5;
      const prevX = proj.prevX ?? projEntity.transform.x;
      const prevY = proj.prevY ?? projEntity.transform.y;
      const currentX = projEntity.transform.x;
      const currentY = projEntity.transform.y;

      // Apply swept damage (line from prev to current with projectile radius)
      const result = damageSystem.applyDamage({
        type: 'swept',
        sourceEntityId: proj.sourceEntityId,
        ownerId: projEntity.ownership.playerId,
        damage: config.damage,
        excludeEntities: proj.hitEntities,
        prevX,
        prevY,
        currentX,
        currentY,
        radius: projRadius,
        maxHits: proj.maxHits - proj.hitEntities.size, // Remaining hits allowed
      });

      // Track hits
      for (const hitId of result.hitEntityIds) {
        proj.hitEntities.add(hitId);

        // Add hit audio event
        const entity = world.getEntity(hitId);
        if (entity) {
          audioEvents.push({
            type: 'hit',
            weaponId: config.id,
            x: entity.transform.x,
            y: entity.transform.y,
          });
        }
      }

      // Handle splash damage on first hit
      if (result.hitEntityIds.length > 0 && config.splashRadius && !proj.hasExploded) {
        const splashResult = damageSystem.applyDamage({
          type: 'area',
          sourceEntityId: proj.sourceEntityId,
          ownerId: projEntity.ownership.playerId,
          damage: config.damage,
          excludeEntities: proj.hitEntities,
          centerX: projEntity.transform.x,
          centerY: projEntity.transform.y,
          radius: config.splashRadius,
          falloff: config.splashDamageFalloff ?? 0.5,
        });
        proj.hasExploded = true;

        // Track splash kills
        for (const id of splashResult.killedUnitIds) {
          if (!unitsToRemove.includes(id)) unitsToRemove.push(id);
        }
        for (const id of splashResult.killedBuildingIds) {
          if (!buildingsToRemove.includes(id)) buildingsToRemove.push(id);
        }
      }

      // Handle deaths from direct hit
      for (const id of result.killedUnitIds) {
        if (!unitsToRemove.includes(id)) {
          const target = world.getEntity(id);
          let deathWeaponId = 'scout';
          const targetWeapons = target?.weapons ?? [];
          for (const weapon of targetWeapons) {
            deathWeaponId = weapon.config.id;
          }
          audioEvents.push({
            type: 'death',
            weaponId: deathWeaponId,
            x: target?.transform.x ?? 0,
            y: target?.transform.y ?? 0,
          });
          unitsToRemove.push(id);
        }
      }
      for (const id of result.killedBuildingIds) {
        if (!buildingsToRemove.includes(id)) {
          const building = world.getEntity(id);
          audioEvents.push({
            type: 'death',
            weaponId: config.id,
            x: building?.transform.x ?? 0,
            y: building?.transform.y ?? 0,
          });
          buildingsToRemove.push(id);
        }
      }

      // Remove projectile if max hits reached
      if (proj.hitEntities.size >= proj.maxHits) {
        projectilesToRemove.push(projEntity.id);
        continue;
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

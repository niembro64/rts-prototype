// Wave weapon system - pie-slice AoE damage with pull effect

import type { WorldState } from '../WorldState';
import type { DamageSystem } from '../damage';
import type { ForceAccumulator } from '../ForceAccumulator';
import type { ProjectileVelocityUpdateEvent } from './types';
import { normalizeAngle } from './combatUtils';
import { magnitude } from '../../math';
import { spatialGrid } from '../SpatialGrid';
import { KNOCKBACK, PROJECTILE_MASS_MULTIPLIER } from '../../../config';

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

// Helper: Check if a point is within a pie slice (annular ring between minRadius and maxRadius)
function isPointInSlice(
  px: number, py: number,
  originX: number, originY: number,
  sliceDirection: number,
  sliceHalfAngle: number,
  maxRadius: number,
  targetRadius: number,
  minRadius: number = 0
): boolean {
  const dx = px - originX;
  const dy = py - originY;
  const dist = magnitude(dx, dy);

  // Check outer distance (accounting for target radius)
  if (dist > maxRadius + targetRadius) return false;

  // Check inner distance (target must be outside inner radius)
  if (minRadius > 0 && dist + targetRadius < minRadius) return false;

  // Check angle (accounting for target angular size)
  const angleToPoint = Math.atan2(dy, dx);
  const angleDiff = normalizeAngle(angleToPoint - sliceDirection);
  const angularSize = dist > 0 ? Math.atan2(targetRadius, dist) : Math.PI;

  return Math.abs(angleDiff) <= sliceHalfAngle + angularSize;
}

// Apply wave weapon damage (continuous pie-slice AoE)
// Wave weapons like Sonic AIM at a specific target (for turret rotation) but deal damage
// to ALL units and buildings within the pie-slice area, not just the target.
// The slice expands/contracts based on firing state (see updateWaveWeaponState).
// Both damage and pull scale with 1/distance - stronger effect when closer to origin.
// Reference distance for scaling is half the weapon's fire range.
export function applyWaveDamage(
  world: WorldState,
  dtMs: number,
  _damageSystem: DamageSystem,
  forceAccumulator?: ForceAccumulator
): ProjectileVelocityUpdateEvent[] {
  const dtSec = dtMs / 1000;
  if (dtSec <= 0) return [];

  const velocityUpdates: ProjectileVelocityUpdateEvent[] = [];

  // Minimum distance to prevent division by zero (units closer than this get max effect)
  const MIN_DISTANCE = 20;

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

      // Wave weapon properties
      const baseDamage = config.damage; // DPS at reference distance
      const baseDamagePerFrame = baseDamage * dtSec;
      const basePullStrength = (config.pullPower ?? 0) * KNOCKBACK.SONIC_PULL_MULTIPLIER;
      const innerRange = (config.waveInnerRange as number | undefined) ?? 0;

      // Reference distance for 1/distance scaling (half the fire range)
      // At this distance, damage/pull equals the base config value
      const referenceDistance = weapon.fireRange * 0.5;

      // Calculate weapon position
      const weaponX = unit.transform.x + unitCos * weapon.offsetX - unitSin * weapon.offsetY;
      const weaponY = unit.transform.y + unitSin * weapon.offsetX + unitCos * weapon.offsetY;

      // Get turret direction
      const turretAngle = weapon.turretRotation;
      const sliceHalfAngle = currentAngle / 2;

      // PERFORMANCE: Use spatial grid to query only nearby enemies
      const nearbyUnits = spatialGrid.queryEnemyUnitsInRadius(
        weaponX, weaponY, weapon.fireRange, sourcePlayerId
      );

      // Apply damage and pull to enemy units in the slice
      for (const target of nearbyUnits) {
        if (!target.unit || target.unit.hp <= 0) continue;
        // Don't affect self
        if (target.id === unit.id) continue;

        const targetRadius = target.unit.collisionRadius;

        // Calculate distance to target
        const dx = target.transform.x - weaponX;
        const dy = target.transform.y - weaponY;
        const dist = magnitude(dx, dy);

        // Check if target is in the wave slice (between inner and outer radius)
        if (!isPointInSlice(
          target.transform.x, target.transform.y,
          weaponX, weaponY,
          turretAngle,
          sliceHalfAngle,
          weapon.fireRange,
          targetRadius,
          innerRange
        )) continue;

        // Calculate 1/distance scaling factor
        // At referenceDistance, scale = 1. Closer = stronger, farther = weaker.
        const effectiveDist = Math.max(dist, MIN_DISTANCE);
        const distanceScale = referenceDistance / effectiveDist;

        // Apply scaled damage directly to target
        const scaledDamage = baseDamagePerFrame * distanceScale;
        target.unit.hp -= scaledDamage;

        // Apply scaled pull force
        if (dist > 0 && forceAccumulator) {
          const scaledPullStrength = basePullStrength * distanceScale;

          // Get target's mass from its body (default to 1 if no physics body)
          const targetMass = (target.body?.matterBody as { mass?: number })?.mass ?? 1;

          // Add directional force toward wave origin (negate dx/dy for pull direction)
          // affectedByMass=true so heavier units resist the pull more
          forceAccumulator.addDirectionalForce(
            target.id,
            -dx,  // direction X (toward wave origin)
            -dy,  // direction Y (toward wave origin)
            scaledPullStrength,
            targetMass,
            true,  // heavier units resist pull
            'wave_pull'
          );
        }
      }

      // PERFORMANCE: Use spatial grid to query only nearby buildings
      const nearbyBuildings = spatialGrid.queryBuildingsInRadius(
        weaponX, weaponY, weapon.fireRange
      );

      // Apply damage to buildings in the slice
      for (const building of nearbyBuildings) {
        if (!building.building || building.building.hp <= 0) continue;
        // Don't damage friendly buildings
        if (building.ownership?.playerId === sourcePlayerId) continue;

        // Calculate distance to building center
        const dx = building.transform.x - weaponX;
        const dy = building.transform.y - weaponY;
        const dist = magnitude(dx, dy);

        // Approximate building radius from dimensions
        const buildingRadius = Math.max(building.building.width, building.building.height) / 2;

        // Check if building is in the wave slice (between inner and outer radius)
        if (!isPointInSlice(
          building.transform.x, building.transform.y,
          weaponX, weaponY,
          turretAngle,
          sliceHalfAngle,
          weapon.fireRange,
          buildingRadius,
          innerRange
        )) continue;

        // Calculate 1/distance scaling factor
        const effectiveDist = Math.max(dist, MIN_DISTANCE);
        const distanceScale = referenceDistance / effectiveDist;

        // Apply scaled damage to building
        const scaledDamage = baseDamagePerFrame * distanceScale;
        building.building.hp -= scaledDamage;
      }

      // Pull enemy projectiles within the wave slice
      // Heavier projectiles resist the pull more (force / mass)
      for (const projEntity of world.getProjectiles()) {
        const proj = projEntity.projectile;
        if (!proj) continue;
        // Only affect traveling projectiles
        if (proj.projectileType !== 'traveling') continue;
        // Only affect enemy projectiles
        if (proj.ownerId === sourcePlayerId) continue;

        const projRadius = proj.config.projectileRadius ?? 5;

        // Check if projectile is in the wave slice
        if (!isPointInSlice(
          projEntity.transform.x, projEntity.transform.y,
          weaponX, weaponY,
          turretAngle,
          sliceHalfAngle,
          weapon.fireRange,
          projRadius,
          innerRange
        )) continue;

        const dx = projEntity.transform.x - weaponX;
        const dy = projEntity.transform.y - weaponY;
        const dist = magnitude(dx, dy);

        // Uniform pull strength (no distance scaling), inversely with projectile mass
        const projMass = (proj.config.projectileMass ?? 1) * PROJECTILE_MASS_MULTIPLIER;
        const pullAccel = basePullStrength / projMass;

        // Apply pull as velocity delta toward wave origin
        const dirX = dist > 0 ? dx / dist : 0;
        const dirY = dist > 0 ? dy / dist : 0;
        proj.velocityX += -dirX * pullAccel * dtSec;
        proj.velocityY += -dirY * pullAccel * dtSec;

        // Update projectile rotation to match new velocity direction
        projEntity.transform.rotation = Math.atan2(proj.velocityY, proj.velocityX);

        velocityUpdates.push({
          id: projEntity.id,
          x: projEntity.transform.x,
          y: projEntity.transform.y,
          velocityX: proj.velocityX,
          velocityY: proj.velocityY,
        });
      }
    }
  }

  return velocityUpdates;
}

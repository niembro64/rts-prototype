// Force field weapon system - dual-zone pie-slice AoE with push (inner) and pull (outer)

import type { WorldState } from '../WorldState';
import type { DamageSystem } from '../damage';
import type { ForceAccumulator } from '../ForceAccumulator';
import type { ProjectileVelocityUpdateEvent } from './types';
import { normalizeAngle } from './combatUtils';
import { magnitude } from '../../math';
import { spatialGrid } from '../SpatialGrid';
import { KNOCKBACK, PROJECTILE_MASS_MULTIPLIER } from '../../../config';

// Update force field state (transition progress 0→1)
// Both push and pull zones grow outward from middleRadius simultaneously.
// currentForceFieldRange is repurposed to carry the progress (0→1) for serialization.
export function updateForceFieldState(world: WorldState, dtMs: number): void {
  for (const unit of world.getUnits()) {
    if (!unit.weapons) continue;

    for (const weapon of unit.weapons) {
      const config = weapon.config;
      if (!config.isForceField) continue;

      const transitionTime = config.forceFieldTransitionTime ?? 1000;

      // Initialize
      if (weapon.forceFieldTransitionProgress === undefined) {
        weapon.forceFieldTransitionProgress = 0;
        weapon.currentForceFieldRange = 0;
      }

      // Move progress toward target based on firing state
      const targetProgress = weapon.isFiring ? 1 : 0;
      const progressDelta = dtMs / transitionTime;

      if (weapon.forceFieldTransitionProgress < targetProgress) {
        weapon.forceFieldTransitionProgress = Math.min(weapon.forceFieldTransitionProgress + progressDelta, 1);
      } else if (weapon.forceFieldTransitionProgress > targetProgress) {
        weapon.forceFieldTransitionProgress = Math.max(weapon.forceFieldTransitionProgress - progressDelta, 0);
      }

      // Serialize progress as currentForceFieldRange (0→1)
      weapon.currentForceFieldRange = weapon.forceFieldTransitionProgress;
    }
  }
}

// Compute the effective push and pull zone boundaries from transition progress + config
function getForceFieldZones(config: { forceFieldInnerRange?: number | unknown; forceFieldMiddleRadius?: number | unknown; range: number }, progress: number) {
  const innerRadius = (config.forceFieldInnerRange as number | undefined) ?? 0;
  const middleRadius = (config.forceFieldMiddleRadius as number | undefined) ?? config.range;
  const outerRadius = config.range;

  // Push zone: inner boundary shrinks from middle toward innerRadius
  const pushInner = middleRadius - (middleRadius - innerRadius) * progress;
  const pushOuter = middleRadius;

  // Pull zone: outer boundary grows from middle toward outerRadius
  const pullInner = middleRadius;
  const pullOuter = middleRadius + (outerRadius - middleRadius) * progress;

  return { innerRadius, middleRadius, outerRadius, pushInner, pushOuter, pullInner, pullOuter };
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

// Apply force field damage (continuous pie-slice AoE with dual push/pull zones)
export function applyForceFieldDamage(
  world: WorldState,
  dtMs: number,
  _damageSystem: DamageSystem,
  forceAccumulator?: ForceAccumulator
): ProjectileVelocityUpdateEvent[] {
  const dtSec = dtMs / 1000;
  if (dtSec <= 0) return [];

  const velocityUpdates: ProjectileVelocityUpdateEvent[] = [];

  for (const unit of world.getUnits()) {
    if (!unit.ownership || !unit.unit || !unit.weapons) continue;
    if (unit.unit.hp <= 0) continue;

    const unitCos = Math.cos(unit.transform.rotation);
    const unitSin = Math.sin(unit.transform.rotation);
    const sourcePlayerId = unit.ownership.playerId;

    for (const weapon of unit.weapons) {
      const config = weapon.config;
      if (!config.isForceField) continue;

      const progress = weapon.forceFieldTransitionProgress ?? (weapon.currentForceFieldRange ?? 0);
      if (progress <= 0) continue;

      const zones = getForceFieldZones(config, progress);

      // Overall effective range (union of push and pull zones)
      const effectiveOuter = Math.max(zones.pushOuter, zones.pullOuter);
      const effectiveInner = Math.min(zones.pushInner, zones.pullInner);

      if (effectiveOuter <= effectiveInner) continue;

      const baseDamagePerFrame = config.damage * dtSec;
      const basePullStrength = (config.pullPower ?? 0) * KNOCKBACK.FORCE_FIELD_PULL_MULTIPLIER;

      const sliceAngle = config.forceFieldAngle ?? Math.PI / 4;
      const sliceHalfAngle = sliceAngle / 2;

      const weaponX = unit.transform.x + unitCos * weapon.offsetX - unitSin * weapon.offsetY;
      const weaponY = unit.transform.y + unitSin * weapon.offsetX + unitCos * weapon.offsetY;

      const turretAngle = weapon.turretRotation;

      // --- Enemy units ---
      const nearbyUnits = spatialGrid.queryEnemyUnitsInRadius(
        weaponX, weaponY, effectiveOuter, sourcePlayerId
      );

      for (const target of nearbyUnits) {
        if (!target.unit || target.unit.hp <= 0) continue;
        if (target.id === unit.id) continue;

        const targetRadius = target.unit.collisionRadius;
        const dx = target.transform.x - weaponX;
        const dy = target.transform.y - weaponY;
        const dist = magnitude(dx, dy);

        // Check if in overall slice
        if (!isPointInSlice(
          target.transform.x, target.transform.y,
          weaponX, weaponY, turretAngle, sliceHalfAngle,
          effectiveOuter, targetRadius, effectiveInner
        )) continue;

        // Determine which zone: push (inner to middle) or pull (middle to outer)
        const inPush = dist < zones.middleRadius && zones.pushOuter > zones.pushInner;
        const inPull = dist >= zones.middleRadius && zones.pullOuter > zones.pullInner;

        if (!inPush && !inPull) continue;

        target.unit.hp -= baseDamagePerFrame;

        if (dist > 0 && forceAccumulator) {
          const targetMass = (target.body?.matterBody as { mass?: number })?.mass ?? 1;
          const pullDir = inPush ? 1 : -1; // push outward in inner zone, pull inward in outer zone

          forceAccumulator.addDirectionalForce(
            target.id,
            pullDir * dx, pullDir * dy,
            basePullStrength, targetMass,
            true, 'force_field_pull'
          );
        }
      }

      // --- Buildings ---
      const nearbyBuildings = spatialGrid.queryBuildingsInRadius(
        weaponX, weaponY, effectiveOuter
      );

      for (const building of nearbyBuildings) {
        if (!building.building || building.building.hp <= 0) continue;
        if (building.ownership?.playerId === sourcePlayerId) continue;

        const buildingRadius = Math.max(building.building.width, building.building.height) / 2;

        if (!isPointInSlice(
          building.transform.x, building.transform.y,
          weaponX, weaponY, turretAngle, sliceHalfAngle,
          effectiveOuter, buildingRadius, effectiveInner
        )) continue;

        building.building.hp -= baseDamagePerFrame;
      }

      // --- Projectiles ---
      for (const projEntity of world.getProjectiles()) {
        const proj = projEntity.projectile;
        if (!proj) continue;
        if (proj.projectileType !== 'traveling') continue;
        if (proj.ownerId === sourcePlayerId) continue;

        const projRadius = proj.config.projectileRadius ?? 5;

        if (!isPointInSlice(
          projEntity.transform.x, projEntity.transform.y,
          weaponX, weaponY, turretAngle, sliceHalfAngle,
          effectiveOuter, projRadius, effectiveInner
        )) continue;

        const dx = projEntity.transform.x - weaponX;
        const dy = projEntity.transform.y - weaponY;
        const dist = magnitude(dx, dy);

        const inPush = dist < zones.middleRadius;
        const pullDir = inPush ? 1 : -1;

        const projMass = (proj.config.projectileMass ?? 1) * PROJECTILE_MASS_MULTIPLIER;
        const pullAccel = basePullStrength / projMass;

        const dirX = dist > 0 ? dx / dist : 0;
        const dirY = dist > 0 ? dy / dist : 0;
        proj.velocityX += pullDir * dirX * pullAccel * dtSec;
        proj.velocityY += pullDir * dirY * pullAccel * dtSec;

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

// Force field weapon system - dual-zone pie-slice AoE with push (inner) and pull (outer)

import type { WorldState } from '../WorldState';
import type { DamageSystem } from '../damage';
import type { ForceAccumulator } from '../ForceAccumulator';
import type { CombatStatsTracker } from '../CombatStatsTracker';
import type { ProjectileVelocityUpdateEvent } from './types';
import { normalizeAngle } from './combatUtils';
import { magnitude } from '../../math';
import { spatialGrid } from '../SpatialGrid';
import { KNOCKBACK, PROJECTILE_MASS_MULTIPLIER } from '../../../config';

// Module-level dedup map: keyed by projectile entity ID, keeps only the last velocity state
// when a projectile is affected by multiple force fields in the same tick.
const _velocityUpdateMap = new Map<number, ProjectileVelocityUpdateEvent>();
const _velocityUpdateResult: ProjectileVelocityUpdateEvent[] = [];

// Tracks how many force field weapons have progress > 0 (set by updateForceFieldState)
let _activeForceFieldCount = 0;

// Reset module-level buffers (call between game sessions)
export function resetForceFieldBuffers(): void {
  _velocityUpdateMap.clear();
  _velocityUpdateResult.length = 0;
  _activeForceFieldCount = 0;
}

// Update force field state (transition progress 0→1)
// Both push and pull zones grow outward from middleRadius simultaneously.
// currentForceFieldRange is repurposed to carry the progress (0→1) for serialization.
export function updateForceFieldState(world: WorldState, dtMs: number): void {
  _activeForceFieldCount = 0;

  for (const unit of world.getForceFieldUnits()) {
    for (const weapon of unit.weapons!) {
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

      if (weapon.forceFieldTransitionProgress > 0) {
        _activeForceFieldCount++;
      }
    }
  }
}

// Compute the effective push and pull zone boundaries from transition progress + config
// Reusable object to avoid allocation per call
const _zones = { pushInner: 0, pushOuter: 0, pullInner: 0, pullOuter: 0 };

function getForceFieldZones(push: import('../types').ForceFieldZoneConfig | null | undefined, pull: import('../types').ForceFieldZoneConfig | null | undefined, progress: number) {
  if (push) {
    _zones.pushInner = push.outerRange - (push.outerRange - push.innerRange) * progress;
    _zones.pushOuter = push.outerRange;
  } else {
    _zones.pushInner = 0;
    _zones.pushOuter = 0;
  }
  if (pull) {
    _zones.pullInner = pull.innerRange;
    _zones.pullOuter = pull.innerRange + (pull.outerRange - pull.innerRange) * progress;
  } else {
    _zones.pullInner = 0;
    _zones.pullOuter = 0;
  }
  return _zones;
}

// Check if a point is within a pie slice (annular ring between minRadius and maxRadius)
// Takes pre-computed dx, dy, dist to avoid redundant sqrt when caller already has them.
// When isFullCircle is true, skips the expensive atan2 angle checks (360° fields).
function isPointInSlicePrecomputed(
  dx: number, dy: number, dist: number,
  sliceDirection: number,
  sliceHalfAngle: number,
  maxRadius: number,
  targetRadius: number,
  minRadius: number,
  isFullCircle: boolean
): boolean {
  // Check outer distance (accounting for target radius)
  if (dist > maxRadius + targetRadius) return false;

  // Check inner distance (target must be outside inner radius)
  if (minRadius > 0 && dist + targetRadius < minRadius) return false;

  // Full-circle force fields skip the angle check entirely (avoids 2x atan2)
  if (isFullCircle) return true;

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
  forceAccumulator?: ForceAccumulator,
  statsTracker?: CombatStatsTracker
): ProjectileVelocityUpdateEvent[] {
  const dtSec = dtMs / 1000;
  if (dtSec <= 0 || _activeForceFieldCount === 0) return [];

  _velocityUpdateMap.clear();

  for (const unit of world.getForceFieldUnits()) {
    if (!unit.ownership || !unit.unit) continue;
    if (unit.unit.hp <= 0) continue;

    const unitCos = unit.transform.rotCos ?? Math.cos(unit.transform.rotation);
    const unitSin = unit.transform.rotSin ?? Math.sin(unit.transform.rotation);
    const sourcePlayerId = unit.ownership.playerId;

    for (const weapon of unit.weapons!) {
      const config = weapon.config;
      if (!config.isForceField) continue;

      const progress = weapon.forceFieldTransitionProgress ?? (weapon.currentForceFieldRange ?? 0);
      if (progress <= 0) continue;

      const push = config.push;
      const pull = config.pull;
      // Zones with power: null are visual-only — skip sim entirely for that zone
      const pushSim = push != null && push.power != null;
      const pullSim = pull != null && pull.power != null;
      if (!pushSim && !pullSim) continue;

      const zones = getForceFieldZones(pushSim ? push : null, pullSim ? pull : null, progress);

      // Overall effective range (union of sim-active zones)
      const effectiveOuter = Math.max(zones.pushOuter, zones.pullOuter);
      const effectiveInner = Math.min(
        zones.pushOuter > zones.pushInner ? zones.pushInner : Infinity,
        zones.pullOuter > zones.pullInner ? zones.pullInner : Infinity
      );

      if (effectiveOuter <= effectiveInner) continue;

      // Per-zone damage and force
      const pushDamagePerFrame = pushSim ? push!.damage * dtSec : 0;
      const pullDamagePerFrame = pullSim ? pull!.damage * dtSec : 0;
      const pushStrength = pushSim ? push!.power! * KNOCKBACK.FORCE_FIELD_PULL_MULTIPLIER : 0;
      const pullStrength = pullSim ? pull!.power! * KNOCKBACK.FORCE_FIELD_PULL_MULTIPLIER : 0;

      const sliceAngle = config.forceFieldAngle ?? Math.PI / 4;
      const sliceHalfAngle = sliceAngle / 2;
      const isFullCircle = sliceHalfAngle >= Math.PI;

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

        const targetRadius = target.unit.physicsRadius;
        const dx = target.transform.x - weaponX;
        const dy = target.transform.y - weaponY;
        const dist = magnitude(dx, dy);

        // Check if in overall slice (precomputed avoids redundant sqrt)
        if (!isPointInSlicePrecomputed(
          dx, dy, dist, turretAngle, sliceHalfAngle,
          effectiveOuter, targetRadius, effectiveInner, isFullCircle
        )) continue;

        // Determine which zone: push (inner) or pull (outer)
        const inPush = zones.pushOuter > zones.pushInner && dist < zones.pushOuter;
        const inPull = !inPush && zones.pullOuter > zones.pullInner && dist >= zones.pullInner;

        if (!inPush && !inPull) continue;

        const damagePerFrame = inPush ? pushDamagePerFrame : pullDamagePerFrame;
        const wasAlive = target.unit.hp > 0;
        if (wasAlive) {
          // Cap recorded damage at remaining HP to avoid overkill inflation
          const actualDamage = Math.min(damagePerFrame, target.unit.hp);
          statsTracker?.recordDamage(unit.id, target.id, actualDamage);
        }
        target.unit.hp -= damagePerFrame;
        if (wasAlive && target.unit.hp <= 0) {
          statsTracker?.recordKill(unit.id, target.id);
        }

        if (dist > 0 && forceAccumulator) {
          const targetMass = (target.body?.matterBody as { mass?: number })?.mass ?? 1;
          const pullDir = inPush ? 1 : -1; // push outward in inner zone, pull inward in outer zone
          const zoneStrength = inPush ? pushStrength : pullStrength;
          const nx = (pullDir * dx) / dist;
          const ny = (pullDir * dy) / dist;

          forceAccumulator.addNormalizedDirectionalForce(
            target.id,
            nx, ny,
            zoneStrength, targetMass,
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
        const bdx = building.transform.x - weaponX;
        const bdy = building.transform.y - weaponY;
        const bdist = magnitude(bdx, bdy);

        if (!isPointInSlicePrecomputed(
          bdx, bdy, bdist, turretAngle, sliceHalfAngle,
          effectiveOuter, buildingRadius, effectiveInner, isFullCircle
        )) continue;

        const bInPush = zones.pushOuter > zones.pushInner && bdist < zones.pushOuter;
        const bInPull = !bInPush && zones.pullOuter > zones.pullInner && bdist >= zones.pullInner;
        if (!bInPush && !bInPull) continue;

        const bDamagePerFrame = bInPush ? pushDamagePerFrame : pullDamagePerFrame;
        const bWasAlive = building.building.hp > 0;
        if (bWasAlive) {
          const actualDamage = Math.min(bDamagePerFrame, building.building.hp);
          statsTracker?.recordDamage(unit.id, building.id, actualDamage);
        }
        building.building.hp -= bDamagePerFrame;
        if (bWasAlive && building.building.hp <= 0) {
          statsTracker?.recordKill(unit.id, building.id);
        }
      }

      // --- Projectiles (spatial grid query replaces full-world iteration) ---
      const nearbyProjectiles = spatialGrid.queryEnemyProjectilesInRadius(
        weaponX, weaponY, effectiveOuter, sourcePlayerId
      );

      for (const projEntity of nearbyProjectiles) {
        const proj = projEntity.projectile!;
        const projRadius = proj.config.projectileRadius ?? 5;

        const dx = projEntity.transform.x - weaponX;
        const dy = projEntity.transform.y - weaponY;
        const distSq = dx * dx + dy * dy;
        const dist = Math.sqrt(distSq);

        if (!isPointInSlicePrecomputed(
          dx, dy, dist, turretAngle, sliceHalfAngle,
          effectiveOuter, projRadius, effectiveInner, isFullCircle
        )) continue;

        const pInPush = zones.pushOuter > zones.pushInner && dist < zones.pushOuter;
        const pInPull = !pInPush && zones.pullOuter > zones.pullInner && dist >= zones.pullInner;
        if (!pInPush && !pInPull) continue;

        const pullDir = pInPush ? 1 : -1;
        const pZoneStrength = pInPush ? pushStrength : pullStrength;

        const projMass = (proj.config.projectileMass ?? 1) * PROJECTILE_MASS_MULTIPLIER;
        const pullAccel = pZoneStrength / projMass;

        const dirX = dist > 0 ? dx / dist : 0;
        const dirY = dist > 0 ? dy / dist : 0;
        proj.velocityX += pullDir * dirX * pullAccel * dtSec;
        proj.velocityY += pullDir * dirY * pullAccel * dtSec;

        projEntity.transform.rotation = Math.atan2(proj.velocityY, proj.velocityX);

        // Dedup: if same projectile affected by multiple force fields, keep latest
        _velocityUpdateMap.set(projEntity.id, {
          id: projEntity.id,
          x: projEntity.transform.x,
          y: projEntity.transform.y,
          velocityX: proj.velocityX,
          velocityY: proj.velocityY,
        });
      }
    }
  }

  // Build result from dedup map (reuse array to reduce GC pressure)
  _velocityUpdateResult.length = 0;
  for (const event of _velocityUpdateMap.values()) {
    _velocityUpdateResult.push(event);
  }
  return _velocityUpdateResult;
}

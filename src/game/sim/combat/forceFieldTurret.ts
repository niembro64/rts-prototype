// Force field weapon system - dual-zone pie-slice AoE with push (inner) and pull (outer)

import type { WorldState } from '../WorldState';
import type { ForceShot } from '../types';
import type { DamageSystem } from '../damage';
import type { ForceAccumulator } from '../ForceAccumulator';
import type { ProjectileVelocityUpdateEvent } from './types';
import { getTransformCosSin } from '../../math';
import { spatialGrid } from '../SpatialGrid';
import { KNOCKBACK, PROJECTILE_MASS_MULTIPLIER, SNAPSHOT_CONFIG } from '../../../config';
import { getSimDetailConfig } from '../simQuality';

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
    for (const weapon of unit.turrets!) {
      const config = weapon.config;
      if (config.shot.type !== 'force') continue;
      const fieldShot = config.shot as ForceShot;

      const transitionTime = fieldShot.transitionTime;

      // Initialize
      if (weapon.forceField === undefined) {
        weapon.forceField = { transition: 0, range: 0 };
      }

      // Move progress toward target based on engaged state
      const targetProgress = weapon.state === 'engaged' ? 1 : 0;
      const progressDelta = dtMs / transitionTime;

      if (weapon.forceField.transition < targetProgress) {
        weapon.forceField.transition = Math.min(weapon.forceField.transition + progressDelta, 1);
      } else if (weapon.forceField.transition > targetProgress) {
        weapon.forceField.transition = Math.max(weapon.forceField.transition - progressDelta, 0);
      }

      // Serialize progress as forceField.range (0→1)
      weapon.forceField.range = weapon.forceField.transition;

      if (weapon.forceField.transition > 0) {
        _activeForceFieldCount++;
      }
    }
  }
}

// Compute the effective push zone boundaries from transition progress + config
const _zones = { pushInner: 0, pushOuter: 0 };

function getForceFieldZones(push: import('../types').ForceFieldZoneConfig | null | undefined, progress: number) {
  if (push) {
    _zones.pushInner = push.outerRange - (push.outerRange - push.innerRange) * progress;
    _zones.pushOuter = push.outerRange;
  } else {
    _zones.pushInner = 0;
    _zones.pushOuter = 0;
  }
  return _zones;
}

// Apply force field damage (continuous pie-slice AoE with dual push/pull zones)
export function applyForceFieldDamage(
  world: WorldState,
  dtMs: number,
  _damageSystem: DamageSystem,
  forceAccumulator?: ForceAccumulator,
): ProjectileVelocityUpdateEvent[] {
  // HOST SERVER LOD throttle: at low tiers run every Nth tick. The
  // skipped ticks contribute zero force; on the apply tick we scale
  // dt by the stride so the time-integral of force matches the
  // every-tick path. Push pulses get coarser at low LOD but the
  // average velocity change over time stays the same.
  const stride = Math.max(1, getSimDetailConfig().forceFieldStride | 0);
  if (stride > 1) {
    if (world.getTick() % stride !== 0) return [];
    dtMs = dtMs * stride;
  }
  const dtSec = dtMs / 1000;
  if (dtSec <= 0 || _activeForceFieldCount === 0) return [];

  // Both effect flags off → there's nothing the outer loop could
  // accomplish. Skip wholesale.
  if (!world.ffAccelUnits && !world.ffAccelShots) {
    return [];
  }

  _velocityUpdateMap.clear();

  for (const unit of world.getForceFieldUnits()) {
    if (!unit.ownership || !unit.unit) continue;
    if (unit.unit.hp <= 0) continue;

    const { cos: unitCos, sin: unitSin } = getTransformCosSin(unit.transform);
    const sourcePlayerId = unit.ownership.playerId;

    for (const weapon of unit.turrets!) {
      const config = weapon.config;
      if (config.shot.type !== 'force') continue;
      const fieldShot = config.shot as ForceShot;

      const progress = weapon.forceField?.transition ?? (weapon.forceField?.range ?? 0);
      if (progress <= 0) continue;

      const push = fieldShot.push;
      if (!push || push.power == null) continue;

      const zones = getForceFieldZones(push, progress);
      if (zones.pushOuter <= zones.pushInner) continue;

      const pushStrength = push.power * KNOCKBACK.FORCE_FIELD_PULL_MULTIPLIER;

      // Force fields are always 360° — no angle checks needed
      const weaponX = unit.transform.x + unitCos * weapon.offset.x - unitSin * weapon.offset.y;
      const weaponY = unit.transform.y + unitSin * weapon.offset.x + unitCos * weapon.offset.y;
      // Mount points are 2D (XY offset on the unit chassis); the
      // emitter's altitude is the unit's. Force-field zones are now
      // true 3D spheres around (weaponX, weaponY, weaponZ).
      const weaponZ = unit.transform.z;

      // Single combined cell sweep when BOTH unit and projectile pushes
      // are enabled — saves rebuilding `nearbyCells` twice for the same
      // (weaponX, weaponY, pushOuter). When only one is enabled we fall
      // through to the targeted helper.
      const useCombinedQuery =
        (world.ffAccelUnits && forceAccumulator !== null) && world.ffAccelShots;
      const combined = useCombinedQuery
        ? spatialGrid.queryEnemyUnitsAndProjectilesInRadius(
            weaponX, weaponY, weaponZ, zones.pushOuter, sourcePlayerId,
          )
        : null;

      // --- Enemy units (knockback only — force fields no longer
      // deal damage; if ffAccelUnits is off there's nothing to do). ---
      if (world.ffAccelUnits && forceAccumulator) {
        const nearbyUnits = combined
          ? combined.units
          : spatialGrid.queryEnemyUnitsInRadius(
              weaponX, weaponY, weaponZ, zones.pushOuter, sourcePlayerId,
            );
        for (const target of nearbyUnits) {
          if (!target.unit || target.unit.hp <= 0) continue;
          if (target.id === unit.id) continue;

          const targetRadius = target.unit.unitRadiusCollider.shot;
          const dx = target.transform.x - weaponX;
          const dy = target.transform.y - weaponY;
          const dz = target.transform.z - weaponZ;

          const distSq = dx * dx + dy * dy + dz * dz;
          const maxDist = zones.pushOuter + targetRadius;
          if (distSq > maxDist * maxDist) continue;

          const dist = Math.sqrt(distSq);
          if (zones.pushInner > 0 && dist + targetRadius < zones.pushInner) continue;
          if (dist <= 0) continue;

          const targetMass = target.body?.physicsBody.mass ?? 1;
          // Force-field push is currently a 2D shove on the horizontal
          // plane — the addNormalizedDirectionalForce API only accepts
          // (nx, ny). Vertical separation between emitter and target
          // is correctly used to gate IN/OUT (3D distance check above)
          // but the impulse itself is horizontal. When the force API
          // grows a Z component, this can become a true 3D push.
          const nx = dx / dist;
          const ny = dy / dist;

          forceAccumulator.addNormalizedDirectionalForce(
            target.id,
            nx, ny,
            pushStrength, targetMass,
            true, 'force_field_push'
          );
        }
      }

      // --- Projectiles (skipped when ffAccelShots is disabled) ---
      const nearbyProjectiles = !world.ffAccelShots
        ? []
        : combined
          ? combined.projectiles
          : spatialGrid.queryEnemyProjectilesInRadius(weaponX, weaponY, weaponZ, zones.pushOuter, sourcePlayerId);

      for (const projEntity of nearbyProjectiles) {
        const proj = projEntity.projectile!;
        const projRadius = proj.config.shot.type === 'projectile' ? proj.config.shot.collision.radius : 5;

        const dx = projEntity.transform.x - weaponX;
        const dy = projEntity.transform.y - weaponY;
        const dz = projEntity.transform.z - weaponZ;
        const distSq = dx * dx + dy * dy + dz * dz;
        const pmaxDist = zones.pushOuter + projRadius;
        if (distSq > pmaxDist * pmaxDist) continue;

        const dist = Math.sqrt(distSq);
        if (zones.pushInner > 0 && dist + projRadius < zones.pushInner) continue;

        const projMass = (proj.config.shot.type === 'projectile' ? proj.config.shot.mass : 1) * PROJECTILE_MASS_MULTIPLIER;
        const pushAccel = pushStrength / projMass;

        // 3D push: scale outward direction along all three axes so a
        // projectile passing high above the emitter gets shoved up as
        // well as out, and one passing below gets shoved down.
        const dirX = dist > 0 ? dx / dist : 0;
        const dirY = dist > 0 ? dy / dist : 0;
        const dirZ = dist > 0 ? dz / dist : 0;
        proj.velocityX += dirX * pushAccel * dtSec;
        proj.velocityY += dirY * pushAccel * dtSec;
        proj.velocityZ += dirZ * pushAccel * dtSec;

        projEntity.transform.rotation = Math.atan2(proj.velocityY, proj.velocityX);

        // Only emit when velocity changed beyond threshold since last sent
        const velTh = SNAPSHOT_CONFIG.velocityThreshold;
        const lastVx = proj.lastSentVelX ?? proj.velocityX;
        const lastVy = proj.lastSentVelY ?? proj.velocityY;
        const lastVz = proj.lastSentVelZ ?? proj.velocityZ;
        if (Math.abs(proj.velocityX - lastVx) > velTh ||
            Math.abs(proj.velocityY - lastVy) > velTh ||
            Math.abs(proj.velocityZ - lastVz) > velTh) {
          proj.lastSentVelX = proj.velocityX;
          proj.lastSentVelY = proj.velocityY;
          proj.lastSentVelZ = proj.velocityZ;
          // Dedup: if same projectile affected by multiple force fields, keep latest
          _velocityUpdateMap.set(projEntity.id, {
            id: projEntity.id,
            pos: { x: projEntity.transform.x, y: projEntity.transform.y, z: projEntity.transform.z },
            velocity: { x: proj.velocityX, y: proj.velocityY, z: proj.velocityZ },
          });
        }
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

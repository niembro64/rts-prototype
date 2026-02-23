// Unified Damage System
// Handles all damage types consistently: line (beams), swept (projectiles), area (splash/force field)
// PERFORMANCE: Uses spatial grid for O(k) queries instead of O(n) full entity scans

import type { WorldState } from '../WorldState';
import type { Entity, EntityId } from '../types';
import type { CombatStatsTracker } from '../CombatStatsTracker';
import type {
  AnyDamageSource,
  LineDamageSource,
  SweptDamageSource,
  AreaDamageSource,
  DamageResult,
  HitInfo,
  DeathContext,
} from './types';
import { KNOCKBACK, PROJECTILE_MASS_MULTIPLIER } from '../../../config';
import { BEAM_EXPLOSION_MAGNITUDE } from '../../../explosionConfig';
import { spatialGrid } from '../SpatialGrid';
import { magnitude, lineCircleIntersectionT, lineRectIntersectionT, isPointInSlice } from '../../math';
import { getTargetRadius } from '../combat/combatUtils';

// Reusable DamageResult to avoid per-call allocations
const _reusableResult: DamageResult = {
  hitEntityIds: [],
  killedUnitIds: new Set(),
  killedBuildingIds: new Set(),
  knockbacks: [],
  deathContexts: new Map(),
};
function resetResult(): DamageResult {
  _reusableResult.hitEntityIds.length = 0;
  _reusableResult.killedUnitIds.clear();
  _reusableResult.killedBuildingIds.clear();
  _reusableResult.truncationT = undefined;
  _reusableResult.knockbacks.length = 0;
  _reusableResult.recoil = undefined;
  _reusableResult.deathContexts.clear();
  return _reusableResult;
}

// Reusable HitInfo array for line/swept damage sorting
const _reusableHits: HitInfo[] = [];

// Reset module-level reusable buffers between game sessions
// (prevents stale entity references from surviving across sessions)
export function resetDamageBuffers(): void {
  _reusableResult.hitEntityIds.length = 0;
  _reusableResult.killedUnitIds.clear();
  _reusableResult.killedBuildingIds.clear();
  _reusableResult.knockbacks.length = 0;
  _reusableResult.deathContexts.clear();
  _reusableHits.length = 0;
}

// Compute distance-based falloff damage for area effects
function computeFalloffDamage(dist: number, radius: number, baseDamage: number, falloff: number): number {
  const distRatio = Math.max(0, Math.min(1, dist / radius));
  return baseDamage * (1 - distRatio * (1 - falloff));
}

export class DamageSystem {
  public statsTracker?: CombatStatsTracker;

  constructor(private world: WorldState) {}

  // Main entry point - apply any damage source
  applyDamage(source: AnyDamageSource): DamageResult {
    switch (source.type) {
      case 'line':
        return this.applyLineDamage(source);
      case 'swept':
        return this.applySweptDamage(source);
      case 'area':
        return this.applyAreaDamage(source);
    }
  }

  // Find first obstruction along a line (for beam truncation)
  // Returns the parametric T value (0-1) and entity ID of first hit
  // PERFORMANCE: Uses spatial grid line query for O(k) instead of O(n)
  findLineObstruction(
    startX: number, startY: number,
    endX: number, endY: number,
    sourceEntityId: EntityId,
    lineWidth: number
  ): { t: number; entityId: EntityId } | null {
    let closestT: number | null = null;
    let closestEntityId: EntityId | null = null;

    // PERFORMANCE: Query only entities near the line using spatial grid
    const nearbyUnits = spatialGrid.queryUnitsAlongLine(startX, startY, endX, endY, lineWidth + 50);
    const nearbyBuildings = spatialGrid.queryBuildingsAlongLine(startX, startY, endX, endY, lineWidth + 100);

    // Check units
    for (const unit of nearbyUnits) {
      if (unit.id === sourceEntityId) continue;
      if (!unit.unit || unit.unit.hp <= 0) continue;

      const t = lineCircleIntersectionT(
        startX, startY, endX, endY,
        unit.transform.x, unit.transform.y,
        unit.unit.radiusColliderUnitShot + lineWidth / 2
      );

      if (t !== null && (closestT === null || t < closestT)) {
        closestT = t;
        closestEntityId = unit.id;
      }
    }

    // Check buildings
    for (const building of nearbyBuildings) {
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
        closestEntityId = building.id;
      }
    }

    return closestT !== null ? { t: closestT, entityId: closestEntityId! } : null;
  }

  // Line damage (beams) - sorted by distance, stops at first hit for non-piercing
  // PERFORMANCE: Uses spatial grid line query for O(k) instead of O(n)
  // Note: Beam recoil is applied continuously in updateProjectiles(), not here
  private applyLineDamage(source: LineDamageSource): DamageResult {
    const result = resetResult();

    // Calculate knockback direction (along the beam)
    const beamDx = source.end.x - source.start.x;
    const beamDy = source.end.y - source.start.y;
    const beamLen = magnitude(beamDx, beamDy);
    const knockbackDirX = beamLen > 0 ? beamDx / beamLen : 0;
    const knockbackDirY = beamLen > 0 ? beamDy / beamLen : 0;

    // Collect all hits with their T values
    _reusableHits.length = 0;
    const hits = _reusableHits;

    // PERFORMANCE: Query only entities near the line using spatial grid
    const nearbyUnits = spatialGrid.queryUnitsAlongLine(
      source.start.x, source.start.y, source.end.x, source.end.y, source.width + 50
    );
    const nearbyBuildings = spatialGrid.queryBuildingsAlongLine(
      source.start.x, source.start.y, source.end.x, source.end.y, source.width + 100
    );

    // Check units
    for (const unit of nearbyUnits) {
      if (source.excludeEntities.has(unit.id)) continue;
      if (!unit.unit || unit.unit.hp <= 0) continue;

      const t = lineCircleIntersectionT(
        source.start.x, source.start.y, source.end.x, source.end.y,
        unit.transform.x, unit.transform.y,
        unit.unit.radiusColliderUnitShot + source.width / 2
      );

      if (t !== null) {
        hits.push({ entityId: unit.id, t, isUnit: true, isBuilding: false });
      }
    }

    // Check buildings
    for (const building of nearbyBuildings) {
      if (source.excludeEntities.has(building.id)) continue;
      if (!building.building || building.building.hp <= 0) continue;

      const bWidth = building.building.width;
      const bHeight = building.building.height;
      const rectX = building.transform.x - bWidth / 2;
      const rectY = building.transform.y - bHeight / 2;

      const t = lineRectIntersectionT(
        source.start.x, source.start.y, source.end.x, source.end.y,
        rectX, rectY, bWidth, bHeight
      );

      if (t !== null) {
        hits.push({ entityId: building.id, t, isUnit: false, isBuilding: true });
      }
    }

    // Sort by T (distance along line)
    hits.sort((a, b) => a.t - b.t);

    // Apply damage in order, respecting maxHits and piercing
    let hitCount = 0;
    for (const hit of hits) {
      if (hitCount >= source.maxHits) break;

      const entity = this.world.getEntity(hit.entityId);
      if (!entity) continue;

      // Momentum-based knockback (mass × velocity × MULTIPLIER)
      const lineMomentum = (source.projectileMass ?? 0) * PROJECTILE_MASS_MULTIPLIER * (source.velocity ?? 0);
      const forceX = knockbackDirX * lineMomentum;
      const forceY = knockbackDirY * lineMomentum;

      // Calculate hit point using T value
      const hitX = source.start.x + hit.t * (source.end.x - source.start.x);
      const hitY = source.start.y + hit.t * (source.end.y - source.start.y);

      // Calculate penetration direction: from hit point through unit center
      const penDirX = entity.transform.x - hitX;
      const penDirY = entity.transform.y - hitY;
      const penMag = magnitude(penDirX, penDirY);
      const penNormX = penMag > 0 ? penDirX / penMag : knockbackDirX;
      const penNormY = penMag > 0 ? penDirY / penMag : knockbackDirY;

      // Apply damage with death context (attacker velocity = beam direction * magnitude)
      this.applyDamageToEntity(entity, source.damage, result, source.sourceEntityId, {
        penetrationDir: { x: penNormX, y: penNormY },
        attackerVel: { x: knockbackDirX * BEAM_EXPLOSION_MAGNITUDE, y: knockbackDirY * BEAM_EXPLOSION_MAGNITUDE },
        attackMagnitude: source.damage,
      });
      result.hitEntityIds.push(hit.entityId);
      hitCount++;

      // Add knockback for units (buildings don't get pushed)
      if (hit.isUnit && lineMomentum > 0) {
        result.knockbacks.push({
          entityId: hit.entityId,
          force: { x: forceX, y: forceY },
        });
      }

      // For non-piercing, record truncation point and stop
      if (!source.piercing) {
        result.truncationT = hit.t;
        break;
      }
    }

    return result;
  }

  // Swept volume damage (traveling projectiles)
  // Uses line from prevPos to currentPos with projectile radius
  // PERFORMANCE: Uses spatial grid line query for O(k) instead of O(n)
  // Note: Recoil for traveling projectiles is applied at fire time in fireTurrets(), not here
  private applySweptDamage(source: SweptDamageSource): DamageResult {
    const result = resetResult();

    // Calculate knockback direction (along projectile travel)
    const projDx = source.current.x - source.prev.x;
    const projDy = source.current.y - source.prev.y;
    const projLen = magnitude(projDx, projDy);
    const knockbackDirX = projLen > 0 ? projDx / projLen : 0;
    const knockbackDirY = projLen > 0 ? projDy / projLen : 0;

    // Collect all hits with their T values
    _reusableHits.length = 0;
    const hits = _reusableHits;

    // PERFORMANCE: Query only entities near the projectile path using spatial grid
    const nearbyUnits = spatialGrid.queryUnitsAlongLine(
      source.prev.x, source.prev.y, source.current.x, source.current.y, source.radius + 50
    );
    const nearbyBuildings = spatialGrid.queryBuildingsAlongLine(
      source.prev.x, source.prev.y, source.current.x, source.current.y, source.radius + 100
    );

    // Check units using swept collision (line-circle with combined radii)
    for (const unit of nearbyUnits) {
      if (source.excludeEntities.has(unit.id)) continue;
      if (!unit.unit || unit.unit.hp <= 0) continue;

      // Treat projectile path as line, combine radii for collision
      const combinedRadius = source.radius + unit.unit.radiusColliderUnitShot;
      const t = lineCircleIntersectionT(
        source.prev.x, source.prev.y,
        source.current.x, source.current.y,
        unit.transform.x, unit.transform.y,
        combinedRadius
      );

      if (t !== null) {
        hits.push({ entityId: unit.id, t, isUnit: true, isBuilding: false });
      }
    }

    // Check buildings using swept collision
    for (const building of nearbyBuildings) {
      if (source.excludeEntities.has(building.id)) continue;
      if (!building.building || building.building.hp <= 0) continue;

      const bWidth = building.building.width;
      const bHeight = building.building.height;
      // Expand rect by projectile radius
      const rectX = building.transform.x - bWidth / 2 - source.radius;
      const rectY = building.transform.y - bHeight / 2 - source.radius;

      const t = lineRectIntersectionT(
        source.prev.x, source.prev.y,
        source.current.x, source.current.y,
        rectX, rectY,
        bWidth + source.radius * 2,
        bHeight + source.radius * 2
      );

      if (t !== null) {
        hits.push({ entityId: building.id, t, isUnit: false, isBuilding: true });
      }
    }

    // Sort by T and apply damage in order
    hits.sort((a, b) => a.t - b.t);

    let hitCount = 0;
    for (const hit of hits) {
      if (hitCount >= source.maxHits) break;

      const entity = this.world.getEntity(hit.entityId);
      if (!entity) continue;

      // Calculate momentum-based knockback (p = mv)
      const projMass = (source.projectileMass ?? 0) * PROJECTILE_MASS_MULTIPLIER;
      const projSpeed = magnitude(source.velocity?.x ?? 0, source.velocity?.y ?? 0);
      const force = projMass * projSpeed;
      const forceX = knockbackDirX * force;
      const forceY = knockbackDirY * force;

      // Calculate hit point using T value along projectile path
      const hitX = source.prev.x + hit.t * (source.current.x - source.prev.x);
      const hitY = source.prev.y + hit.t * (source.current.y - source.prev.y);

      // Calculate penetration direction: from hit point through unit center
      const penDirX = entity.transform.x - hitX;
      const penDirY = entity.transform.y - hitY;
      const penMag = magnitude(penDirX, penDirY);
      const penNormX = penMag > 0 ? penDirX / penMag : knockbackDirX;
      const penNormY = penMag > 0 ? penDirY / penMag : knockbackDirY;

      // Apply damage with death context (attacker velocity = actual projectile velocity)
      // Use actual projectile velocity if available, otherwise fallback to direction * damage
      const attackerVelX = source.velocity?.x ?? knockbackDirX * source.damage;
      const attackerVelY = source.velocity?.y ?? knockbackDirY * source.damage;
      this.applyDamageToEntity(entity, source.damage, result, source.sourceEntityId, {
        penetrationDir: { x: penNormX, y: penNormY },
        attackerVel: { x: attackerVelX, y: attackerVelY },
        attackMagnitude: source.damage,
      });
      result.hitEntityIds.push(hit.entityId);
      hitCount++;

      // Add knockback for units (buildings don't get pushed)
      if (hit.isUnit && projMass > 0) {
        result.knockbacks.push({
          entityId: hit.entityId,
          force: { x: forceX, y: forceY },
        });
      }
    }

    return result;
  }

  // Area damage (splash, wave)
  // PERFORMANCE: Uses spatial grid radius query for O(k) instead of O(n)
  private applyAreaDamage(source: AreaDamageSource): DamageResult {
    const result = resetResult();

    const hasSlice = source.sliceAngle !== undefined && source.sliceDirection !== undefined;
    const sliceHalfAngle = hasSlice ? source.sliceAngle! / 2 : Math.PI;
    const sliceDirection = source.sliceDirection ?? 0;

    // PERFORMANCE: Query only entities within the damage radius using spatial grid
    const nearbyUnits = spatialGrid.queryUnitsInRadius(source.center.x, source.center.y, source.radius + 50);
    const nearbyBuildings = spatialGrid.queryBuildingsInRadius(source.center.x, source.center.y, source.radius + 100);

    // Check units
    for (const unit of nearbyUnits) {
      if (source.excludeEntities.has(unit.id)) continue;
      if (!unit.unit || unit.unit.hp <= 0) continue;

      const dx = unit.transform.x - source.center.x;
      const dy = unit.transform.y - source.center.y;
      const targetRadius = unit.unit.radiusColliderUnitShot;

      // Cheap squared-distance rejection before sqrt
      const distSq = dx * dx + dy * dy;
      const maxDist = source.radius + targetRadius;
      if (distSq > maxDist * maxDist) continue;

      const dist = Math.sqrt(distSq);

      // Check slice angle if wave weapon
      if (hasSlice) {
        if (!isPointInSlice(
          dx, dy, dist,
          sliceDirection,
          sliceHalfAngle,
          source.radius,
          targetRadius
        )) continue;
      }

      // Calculate damage with falloff
      const damage = computeFalloffDamage(dist, source.radius, source.damage, source.falloff);

      // Calculate knockback direction (from center outward)
      const dirX = dist > 0 ? dx / dist : 0;
      const dirY = dist > 0 ? dy / dist : 0;
      const force = source.knockbackForce ?? (damage * KNOCKBACK.SPLASH);
      const forceX = dirX * force;
      const forceY = dirY * force;

      // For area damage, penetration direction is from explosion center through unit
      // (same as knockback direction - outward from center)
      // Attacker velocity uses direction * force for area damage
      this.applyDamageToEntity(unit, damage, result, source.sourceEntityId, {
        penetrationDir: { x: dirX, y: dirY },
        attackerVel: { x: dirX * force, y: dirY * force },
        attackMagnitude: damage,
      });
      result.hitEntityIds.push(unit.id);

      // Add knockback (direction is from center outward)
      if (force > 0 && dist > 0) {
        result.knockbacks.push({
          entityId: unit.id,
          force: { x: forceX, y: forceY },
        });
      }
    }

    // Check buildings
    for (const building of nearbyBuildings) {
      if (source.excludeEntities.has(building.id)) continue;
      if (!building.building || building.building.hp <= 0) continue;

      const dx = building.transform.x - source.center.x;
      const dy = building.transform.y - source.center.y;
      const buildingRadius = getTargetRadius(building);

      // Cheap squared-distance rejection before sqrt
      const distSq = dx * dx + dy * dy;
      const maxDist = source.radius + buildingRadius;
      if (distSq > maxDist * maxDist) continue;

      const dist = Math.sqrt(distSq);

      // Check slice for wave weapons
      if (hasSlice) {
        if (!isPointInSlice(
          dx, dy, dist,
          sliceDirection,
          sliceHalfAngle,
          source.radius,
          buildingRadius
        )) continue;
      }

      // Calculate damage with falloff
      const damage = computeFalloffDamage(dist, source.radius, source.damage, source.falloff);

      // Calculate direction (from center outward)
      const dirX = dist > 0 ? dx / dist : 0;
      const dirY = dist > 0 ? dy / dist : 0;

      // Apply damage with death context
      const bForce = source.knockbackForce ?? (damage * KNOCKBACK.SPLASH);
      this.applyDamageToEntity(building, damage, result, source.sourceEntityId, {
        penetrationDir: { x: dirX, y: dirY },
        attackerVel: { x: dirX * bForce, y: dirY * bForce },
        attackMagnitude: damage,
      });
      result.hitEntityIds.push(building.id);
    }

    return result;
  }

  // Helper to apply damage and track kills
  private applyDamageToEntity(
    entity: Entity,
    damage: number,
    result: DamageResult,
    sourceEntityId: EntityId,
    deathContext?: DeathContext
  ): void {
    if (entity.unit && entity.unit.hp > 0) {
      // Cap recorded damage at remaining HP to avoid overkill inflation
      const actualDamage = Math.min(damage, entity.unit.hp);
      this.statsTracker?.recordDamage(sourceEntityId, entity.id, actualDamage);
      entity.unit.hp -= damage;
      if (entity.unit.hp <= 0 && !result.killedUnitIds.has(entity.id)) {
        result.killedUnitIds.add(entity.id);
        this.statsTracker?.recordKill(sourceEntityId, entity.id);
        // Store death context for explosion effects
        if (deathContext) {
          result.deathContexts.set(entity.id, deathContext);
        }
      }
    } else if (entity.building && entity.building.hp > 0) {
      const actualDamage = Math.min(damage, entity.building.hp);
      this.statsTracker?.recordDamage(sourceEntityId, entity.id, actualDamage);
      entity.building.hp -= damage;
      if (entity.building.hp <= 0 && !result.killedBuildingIds.has(entity.id)) {
        result.killedBuildingIds.add(entity.id);
        this.statsTracker?.recordKill(sourceEntityId, entity.id);
      }
    }
  }
}

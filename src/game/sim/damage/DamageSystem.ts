// Unified Damage System
// Handles all damage types consistently: line (beams), swept (projectiles), area (splash/wave)
// PERFORMANCE: Uses spatial grid for O(k) queries instead of O(n) full entity scans

import type { WorldState } from '../WorldState';
import type { Entity, EntityId } from '../types';
import type {
  AnyDamageSource,
  LineDamageSource,
  SweptDamageSource,
  AreaDamageSource,
  DamageResult,
  HitInfo,
  DeathContext,
} from './types';
import { KNOCKBACK, BEAM_EXPLOSION_MAGNITUDE, PROJECTILE_MASS_MULTIPLIER } from '../../../config';
import { spatialGrid } from '../SpatialGrid';
import { normalizeAngle, magnitude } from '../../math';

// Line-circle intersection - returns parametric T value (0-1) of first intersection, or null
function lineCircleIntersectionT(
  x1: number, y1: number,
  x2: number, y2: number,
  cx: number, cy: number,
  r: number
): number | null {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const fx = x1 - cx;
  const fy = y1 - cy;

  const a = dx * dx + dy * dy;
  if (a === 0) return null; // Zero-length line

  const b = 2 * (fx * dx + fy * dy);
  const c = fx * fx + fy * fy - r * r;

  let discriminant = b * b - 4 * a * c;
  if (discriminant < 0) return null;

  discriminant = Math.sqrt(discriminant);

  const t1 = (-b - discriminant) / (2 * a);
  const t2 = (-b + discriminant) / (2 * a);

  // Return smallest t in valid range [0, 1]
  if (t1 >= 0 && t1 <= 1) return t1;
  if (t2 >= 0 && t2 <= 1) return t2;
  return null;
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

// Line-rectangle intersection - returns parametric T value (0-1) of first intersection, or null
function lineRectIntersectionT(
  x1: number, y1: number,
  x2: number, y2: number,
  rectX: number, rectY: number,
  rectWidth: number, rectHeight: number
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

  const edges: [number, number, number, number][] = [
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

// Get target radius for collision
function getTargetRadius(entity: Entity): number {
  if (entity.unit) {
    return entity.unit.collisionRadius;
  } else if (entity.building) {
    const bWidth = entity.building.width;
    const bHeight = entity.building.height;
    return magnitude(bWidth, bHeight) / 2;
  }
  return 0;
}

// Check if a point is within a pie slice
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
  const dist = magnitude(dx, dy);

  // Check distance (accounting for target radius)
  if (dist > maxRadius + targetRadius) return false;

  // Check angle (accounting for target angular size)
  const angleToPoint = Math.atan2(dy, dx);
  const angleDiff = normalizeAngle(angleToPoint - sliceDirection);
  const angularSize = dist > 0 ? Math.atan2(targetRadius, dist) : Math.PI;

  return Math.abs(angleDiff) <= sliceHalfAngle + angularSize;
}

export class DamageSystem {
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
        unit.unit.collisionRadius + lineWidth / 2
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
    const result: DamageResult = {
      hitEntityIds: [],
      killedUnitIds: new Set(),
      killedBuildingIds: new Set(),
      knockbacks: [],
      deathContexts: new Map(),
    };

    // Calculate knockback direction (along the beam)
    const beamDx = source.endX - source.startX;
    const beamDy = source.endY - source.startY;
    const beamLen = magnitude(beamDx, beamDy);
    const knockbackDirX = beamLen > 0 ? beamDx / beamLen : 0;
    const knockbackDirY = beamLen > 0 ? beamDy / beamLen : 0;

    // Collect all hits with their T values
    const hits: HitInfo[] = [];

    // PERFORMANCE: Query only entities near the line using spatial grid
    const nearbyUnits = spatialGrid.queryUnitsAlongLine(
      source.startX, source.startY, source.endX, source.endY, source.width + 50
    );
    const nearbyBuildings = spatialGrid.queryBuildingsAlongLine(
      source.startX, source.startY, source.endX, source.endY, source.width + 100
    );

    // Check units
    for (const unit of nearbyUnits) {
      if (unit.id === source.sourceEntityId) continue;
      if (source.excludeEntities.has(unit.id)) continue;
      if (!unit.unit || unit.unit.hp <= 0) continue;

      const t = lineCircleIntersectionT(
        source.startX, source.startY, source.endX, source.endY,
        unit.transform.x, unit.transform.y,
        unit.unit.collisionRadius + source.width / 2
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
        source.startX, source.startY, source.endX, source.endY,
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

      // Calculate knockback force for this hit (beams use BEAM_HIT)
      const force = source.damage * KNOCKBACK.BEAM_HIT;
      const forceX = knockbackDirX * force;
      const forceY = knockbackDirY * force;

      // Calculate hit point using T value
      const hitX = source.startX + hit.t * (source.endX - source.startX);
      const hitY = source.startY + hit.t * (source.endY - source.startY);

      // Calculate penetration direction: from hit point through unit center
      const penDirX = entity.transform.x - hitX;
      const penDirY = entity.transform.y - hitY;
      const penMag = magnitude(penDirX, penDirY);
      const penNormX = penMag > 0 ? penDirX / penMag : knockbackDirX;
      const penNormY = penMag > 0 ? penDirY / penMag : knockbackDirY;

      // Apply damage with death context (attacker velocity = beam direction * magnitude)
      this.applyDamageToEntity(entity, source.damage, result, {
        penetrationDirX: penNormX,
        penetrationDirY: penNormY,
        attackerVelX: knockbackDirX * BEAM_EXPLOSION_MAGNITUDE,
        attackerVelY: knockbackDirY * BEAM_EXPLOSION_MAGNITUDE,
        attackMagnitude: source.damage,
      });
      result.hitEntityIds.push(hit.entityId);
      hitCount++;

      // Add knockback for units (buildings don't get pushed)
      if (hit.isUnit && KNOCKBACK.BEAM_HIT > 0) {
        result.knockbacks.push({
          entityId: hit.entityId,
          forceX,
          forceY,
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
  // Note: Recoil for traveling projectiles is applied at fire time in fireWeapons(), not here
  private applySweptDamage(source: SweptDamageSource): DamageResult {
    const result: DamageResult = {
      hitEntityIds: [],
      killedUnitIds: new Set(),
      killedBuildingIds: new Set(),
      knockbacks: [],
      deathContexts: new Map(),
    };

    // Calculate knockback direction (along projectile travel)
    const projDx = source.currentX - source.prevX;
    const projDy = source.currentY - source.prevY;
    const projLen = magnitude(projDx, projDy);
    const knockbackDirX = projLen > 0 ? projDx / projLen : 0;
    const knockbackDirY = projLen > 0 ? projDy / projLen : 0;

    // Collect all hits with their T values
    const hits: HitInfo[] = [];

    // PERFORMANCE: Query only entities near the projectile path using spatial grid
    const nearbyUnits = spatialGrid.queryUnitsAlongLine(
      source.prevX, source.prevY, source.currentX, source.currentY, source.radius + 50
    );
    const nearbyBuildings = spatialGrid.queryBuildingsAlongLine(
      source.prevX, source.prevY, source.currentX, source.currentY, source.radius + 100
    );

    // Check units using swept collision (line-circle with combined radii)
    for (const unit of nearbyUnits) {
      if (unit.id === source.sourceEntityId) continue;
      if (source.excludeEntities.has(unit.id)) continue;
      if (!unit.unit || unit.unit.hp <= 0) continue;

      // Treat projectile path as line, combine radii for collision
      const combinedRadius = source.radius + unit.unit.collisionRadius;
      const t = lineCircleIntersectionT(
        source.prevX, source.prevY,
        source.currentX, source.currentY,
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
        source.prevX, source.prevY,
        source.currentX, source.currentY,
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
      const projSpeed = magnitude(source.velocityX ?? 0, source.velocityY ?? 0);
      const force = projMass * projSpeed;
      const forceX = knockbackDirX * force;
      const forceY = knockbackDirY * force;

      // Calculate hit point using T value along projectile path
      const hitX = source.prevX + hit.t * (source.currentX - source.prevX);
      const hitY = source.prevY + hit.t * (source.currentY - source.prevY);

      // Calculate penetration direction: from hit point through unit center
      const penDirX = entity.transform.x - hitX;
      const penDirY = entity.transform.y - hitY;
      const penMag = magnitude(penDirX, penDirY);
      const penNormX = penMag > 0 ? penDirX / penMag : knockbackDirX;
      const penNormY = penMag > 0 ? penDirY / penMag : knockbackDirY;

      // Apply damage with death context (attacker velocity = actual projectile velocity)
      // Use actual projectile velocity if available, otherwise fallback to direction * damage
      const attackerVelX = source.velocityX ?? knockbackDirX * source.damage;
      const attackerVelY = source.velocityY ?? knockbackDirY * source.damage;
      this.applyDamageToEntity(entity, source.damage, result, {
        penetrationDirX: penNormX,
        penetrationDirY: penNormY,
        attackerVelX,
        attackerVelY,
        attackMagnitude: source.damage,
      });
      result.hitEntityIds.push(hit.entityId);
      hitCount++;

      // Add knockback for units (buildings don't get pushed)
      if (hit.isUnit && projMass > 0) {
        result.knockbacks.push({
          entityId: hit.entityId,
          forceX,
          forceY,
        });
      }
    }

    return result;
  }

  // Area damage (splash, wave)
  // PERFORMANCE: Uses spatial grid radius query for O(k) instead of O(n)
  private applyAreaDamage(source: AreaDamageSource): DamageResult {
    const result: DamageResult = {
      hitEntityIds: [],
      killedUnitIds: new Set(),
      killedBuildingIds: new Set(),
      knockbacks: [],
      deathContexts: new Map(),
    };

    const hasSlice = source.sliceAngle !== undefined && source.sliceDirection !== undefined;
    const sliceHalfAngle = hasSlice ? source.sliceAngle! / 2 : Math.PI;
    const sliceDirection = source.sliceDirection ?? 0;

    // PERFORMANCE: Query only entities within the damage radius using spatial grid
    const nearbyUnits = spatialGrid.queryUnitsInRadius(source.centerX, source.centerY, source.radius + 50);
    const nearbyBuildings = spatialGrid.queryBuildingsInRadius(source.centerX, source.centerY, source.radius + 100);

    // Check units
    for (const unit of nearbyUnits) {
      if (unit.id === source.sourceEntityId) continue;
      if (source.excludeEntities.has(unit.id)) continue;
      if (!unit.unit || unit.unit.hp <= 0) continue;

      const dx = unit.transform.x - source.centerX;
      const dy = unit.transform.y - source.centerY;
      const dist = magnitude(dx, dy);
      const targetRadius = unit.unit.collisionRadius;

      // Check distance
      if (dist > source.radius + targetRadius) continue;

      // Check slice angle if wave weapon
      if (hasSlice) {
        if (!isPointInSlice(
          unit.transform.x, unit.transform.y,
          source.centerX, source.centerY,
          sliceDirection,
          sliceHalfAngle,
          source.radius,
          targetRadius
        )) continue;
      }

      // Calculate damage with falloff
      const distRatio = Math.max(0, Math.min(1, dist / source.radius));
      const damageMultiplier = 1 - distRatio * (1 - source.falloff);
      const damage = source.damage * damageMultiplier;

      // Calculate knockback direction (from center outward)
      const dirX = dist > 0 ? dx / dist : 0;
      const dirY = dist > 0 ? dy / dist : 0;
      const force = damage * KNOCKBACK.SPLASH;
      const forceX = dirX * force;
      const forceY = dirY * force;

      // For area damage, penetration direction is from explosion center through unit
      // (same as knockback direction - outward from center)
      // Attacker velocity uses direction * force for area damage
      this.applyDamageToEntity(unit, damage, result, {
        penetrationDirX: dirX,
        penetrationDirY: dirY,
        attackerVelX: dirX * force,
        attackerVelY: dirY * force,
        attackMagnitude: damage,
      });
      result.hitEntityIds.push(unit.id);

      // Add knockback (direction is from center outward)
      if (KNOCKBACK.SPLASH > 0 && dist > 0) {
        result.knockbacks.push({
          entityId: unit.id,
          forceX,
          forceY,
        });
      }
    }

    // Check buildings
    for (const building of nearbyBuildings) {
      if (source.excludeEntities.has(building.id)) continue;
      if (!building.building || building.building.hp <= 0) continue;

      const dx = building.transform.x - source.centerX;
      const dy = building.transform.y - source.centerY;
      const dist = magnitude(dx, dy);
      const buildingRadius = getTargetRadius(building);

      // Check distance
      if (dist > source.radius + buildingRadius) continue;

      // Check slice for wave weapons
      if (hasSlice) {
        if (!isPointInSlice(
          building.transform.x, building.transform.y,
          source.centerX, source.centerY,
          sliceDirection,
          sliceHalfAngle,
          source.radius,
          buildingRadius
        )) continue;
      }

      // Calculate damage with falloff
      const distRatio = Math.max(0, Math.min(1, dist / source.radius));
      const damageMultiplier = 1 - distRatio * (1 - source.falloff);
      const damage = source.damage * damageMultiplier;

      // Calculate direction (from center outward)
      const dirX = dist > 0 ? dx / dist : 0;
      const dirY = dist > 0 ? dy / dist : 0;

      // Apply damage with death context
      const force = damage * KNOCKBACK.SPLASH;
      this.applyDamageToEntity(building, damage, result, {
        penetrationDirX: dirX,
        penetrationDirY: dirY,
        attackerVelX: dirX * force,
        attackerVelY: dirY * force,
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
    deathContext?: DeathContext
  ): void {
    if (entity.unit && entity.unit.hp > 0) {
      entity.unit.hp -= damage;
      if (entity.unit.hp <= 0 && !result.killedUnitIds.has(entity.id)) {
        result.killedUnitIds.add(entity.id);
        // Store death context for explosion effects
        if (deathContext) {
          result.deathContexts.set(entity.id, deathContext);
        }
      }
    } else if (entity.building && entity.building.hp > 0) {
      entity.building.hp -= damage;
      if (entity.building.hp <= 0 && !result.killedBuildingIds.has(entity.id)) {
        result.killedBuildingIds.add(entity.id);
      }
    }
  }
}

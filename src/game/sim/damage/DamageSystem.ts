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
import { magnitude, lineCircleIntersectionT, lineSphereIntersectionT, lineRectIntersectionT, rayBoxIntersectionT, rayVerticalRectIntersectionT, isPointInSlice } from '../../math';
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

// Reusable result for findBeamSegmentHit.
// `z` is the world altitude of the hit point; `normalX/Y` is the
// panel's outward-facing horizontal normal (mirror panels are upright,
// so normalZ is always 0 — see the reflection formula in findBeamPath
// where d.z is preserved through the bounce).
const _segHit = { t: 0, x: 0, y: 0, z: 0, entityId: 0 as EntityId, isMirror: false, normalX: 0, normalY: 0, panelIndex: -1 };

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
        unit.unit.unitRadiusCollider.shot + lineWidth / 2
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

  // Find beam path with reflections off mirror units — full 3D.
  //
  // Mirror panels are upright rectangles (vertical slab, horizontal
  // yaw-only normal). A beam tilted up into the sky genuinely misses a
  // low panel even if its horizontal projection would cross the panel's
  // edge line, and a bounce off a panel preserves the beam's pitch
  // because the reflection formula r = d − 2·(d·n)·n with n.z=0 leaves
  // d.z untouched. Buildings are 3D AABBs (x/y footprint × z depth), so
  // a high-arc beam can pass over a short building and hit the mirror
  // behind it.
  findBeamPath(
    startX: number, startY: number, startZ: number,
    endX: number, endY: number, endZ: number,
    sourceEntityId: EntityId,
    lineWidth: number,
    maxBounces: number = 3
  ): {
    endX: number; endY: number; endZ: number;
    obstructionT?: number;
    reflections: { x: number; y: number; z: number; mirrorEntityId: EntityId }[];
  } {
    const reflections: { x: number; y: number; z: number; mirrorEntityId: EntityId }[] = [];
    let curSX = startX, curSY = startY, curSZ = startZ;
    let curEX = endX, curEY = endY, curEZ = endZ;
    let excludeEntityId = sourceEntityId;
    let excludePanelIndex = -1; // -1 = exclude entire entity (source), >= 0 = exclude only that panel

    for (let bounce = 0; bounce <= maxBounces; bounce++) {
      const hit = this.findBeamSegmentHit(
        curSX, curSY, curSZ, curEX, curEY, curEZ,
        excludeEntityId, excludePanelIndex, lineWidth
      );

      if (!hit) {
        return { endX: curEX, endY: curEY, endZ: curEZ, reflections };
      }

      if (!hit.isMirror) {
        if (bounce === 0) {
          return { endX: hit.x, endY: hit.y, endZ: hit.z, obstructionT: hit.t, reflections };
        }
        return { endX: hit.x, endY: hit.y, endZ: hit.z, reflections };
      }

      reflections.push({ x: hit.x, y: hit.y, z: hit.z, mirrorEntityId: hit.entityId });

      const segDx = curEX - curSX;
      const segDy = curEY - curSY;
      const segDz = curEZ - curSZ;
      const segLen = Math.hypot(segDx, segDy, segDz);
      if (segLen === 0) break;
      const beamDirX = segDx / segLen;
      const beamDirY = segDy / segLen;
      const beamDirZ = segDz / segLen;

      // Reflect around the panel's horizontal normal. normalZ is 0 for
      // yaw-only panels, so d.z comes out unchanged — a pitched beam
      // exits the mirror with the same vertical slope it arrived at,
      // just mirrored horizontally (the natural result for a vertical
      // mirror).
      const dotDN = beamDirX * hit.normalX + beamDirY * hit.normalY;
      const reflDirX = beamDirX - 2 * dotDN * hit.normalX;
      const reflDirY = beamDirY - 2 * dotDN * hit.normalY;
      const reflDirZ = beamDirZ;
      const remaining = segLen * (1 - hit.t);

      curSX = hit.x;
      curSY = hit.y;
      curSZ = hit.z;
      curEX = hit.x + reflDirX * remaining;
      curEY = hit.y + reflDirY * remaining;
      curEZ = hit.z + reflDirZ * remaining;
      excludeEntityId = hit.entityId;
      excludePanelIndex = hit.panelIndex;
    }

    return { endX: curEX, endY: curEY, endZ: curEZ, reflections };
  }

  // Find closest beam hit — checks mirror panel rectangles AND regular
  // entity colliders, all in 3D.
  //   excludeEntityId: on bounce 0 = source (don't hit self), on bounce N = last mirror hit
  //   excludePanelIndex: -1 = exclude entire entity, >= 0 = exclude only that panel
  private findBeamSegmentHit(
    startX: number, startY: number, startZ: number,
    endX: number, endY: number, endZ: number,
    excludeEntityId: EntityId,
    excludePanelIndex: number,
    lineWidth: number
  ): typeof _segHit | null {
    let bestT = Infinity;
    let found = false;

    const dx = endX - startX;
    const dy = endY - startY;
    const dz = endZ - startZ;
    const segLenSq = dx * dx + dy * dy;

    const nearbyUnits = spatialGrid.queryUnitsAlongLine(startX, startY, endX, endY, lineWidth + 60);

    for (const unit of nearbyUnits) {
      const isExcludedEntity = unit.id === excludeEntityId;
      if (isExcludedEntity && excludePanelIndex < 0) continue;
      if (!unit.unit || unit.unit.hp <= 0) continue;

      // Horizontal-only early-out — the beam may arc vertically past
      // the unit, but we still require its XY projection to come near
      // the unit's bounding radius.
      const ux = unit.transform.x - startX, uy = unit.transform.y - startY;
      const crossSq = (ux * dy - uy * dx);
      const panels = unit.unit.mirrorPanels;
      const boundR = panels.length > 0
        ? Math.max(unit.unit.mirrorBoundRadius, unit.unit.unitRadiusCollider.shot) + lineWidth
        : unit.unit.unitRadiusCollider.shot + lineWidth / 2;
      if (crossSq * crossSq > boundR * boundR * segLenSq) continue;

      if (panels.length > 0) {
        // Mirror unit: 3D ray-vs-upright-rectangle for each panel.
        let mirrorRot = unit.transform.rotation;
        if (unit.turrets && unit.turrets.length > 0) {
          mirrorRot = unit.turrets[0].rotation;
        }
        const fwdX = Math.cos(mirrorRot);
        const fwdY = Math.sin(mirrorRot);
        const perpX = -fwdY;
        const perpY = fwdX;

        // Panel vertical range in world-z = unit's ground footprint
        // altitude (transform.z − push radius when the unit is resting)
        // plus the panel's per-unit base/top offsets above ground.
        const unitGroundZ = unit.transform.z - unit.unit.unitRadiusCollider.push;

        for (let pi = 0; pi < panels.length; pi++) {
          if (isExcludedEntity && pi === excludePanelIndex) continue;

          const panel = panels[pi];
          const pcx = unit.transform.x + fwdX * panel.offsetX + perpX * panel.offsetY;
          const pcy = unit.transform.y + fwdY * panel.offsetX + perpY * panel.offsetY;
          const panelAngle = mirrorRot + panel.angle;
          const pnx = Math.cos(panelAngle);
          const pny = Math.sin(panelAngle);

          const t = rayVerticalRectIntersectionT(
            startX, startY, startZ,
            endX, endY, endZ,
            pcx, pcy,
            pnx, pny,
            panel.halfWidth,
            unitGroundZ + panel.baseY,
            unitGroundZ + panel.topY,
          );
          if (t !== null && t < bestT) {
            bestT = t; found = true;
            _segHit.t = t;
            _segHit.x = startX + t * dx;
            _segHit.y = startY + t * dy;
            _segHit.z = startZ + t * dz;
            _segHit.entityId = unit.id;
            _segHit.isMirror = true;
            _segHit.normalX = pnx; _segHit.normalY = pny;
            _segHit.panelIndex = pi;
          }
        }
      }

      // Unit body: 3D segment-vs-sphere.
      {
        const t = lineSphereIntersectionT(
          startX, startY, startZ,
          endX, endY, endZ,
          unit.transform.x, unit.transform.y, unit.transform.z,
          unit.unit.unitRadiusCollider.shot + lineWidth / 2
        );
        if (t !== null && t < bestT) {
          bestT = t; found = true;
          _segHit.t = t;
          _segHit.x = startX + t * dx;
          _segHit.y = startY + t * dy;
          _segHit.z = startZ + t * dz;
          _segHit.entityId = unit.id;
          _segHit.isMirror = false;
          _segHit.normalX = 0; _segHit.normalY = 0;
          _segHit.panelIndex = -1;
        }
      }
    }

    // Buildings: 3D ray-vs-AABB (x/y footprint × z depth). A beam arcing
    // over a short building correctly misses; clipping the wall stops.
    const nearbyBuildings = spatialGrid.queryBuildingsAlongLine(startX, startY, endX, endY, lineWidth + 100);
    for (const building of nearbyBuildings) {
      if (!building.building || building.building.hp <= 0) continue;
      const bWidth = building.building.width;
      const bHeight = building.building.height;
      const bDepth = building.building.depth;
      const minX = building.transform.x - bWidth / 2;
      const minY = building.transform.y - bHeight / 2;
      const maxX = building.transform.x + bWidth / 2;
      const maxY = building.transform.y + bHeight / 2;
      const t = rayBoxIntersectionT(
        startX, startY, startZ,
        endX, endY, endZ,
        minX, minY, 0,
        maxX, maxY, bDepth,
      );
      if (t !== null && t < bestT) {
        bestT = t; found = true;
        _segHit.t = t;
        _segHit.x = startX + t * dx;
        _segHit.y = startY + t * dy;
        _segHit.z = startZ + t * dz;
        _segHit.entityId = building.id;
        _segHit.isMirror = false;
        _segHit.normalX = 0; _segHit.normalY = 0;
        _segHit.panelIndex = -1;
      }
    }

    return found ? _segHit : null;
  }

  // Line damage (beams) - sorted by distance, stops at first hit
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

    // Check units — 3D segment-vs-sphere: the beam is a line in 3D
    // space; a unit takes a hit when its sphere intersects that line
    // (inflated by beam half-width). A beam pitched upward into the
    // sky can't catch ground units; a beam aimed down does.
    for (const unit of nearbyUnits) {
      if (source.excludeEntities.has(unit.id)) continue;
      if (!unit.unit || unit.unit.hp <= 0) continue;

      const t = lineSphereIntersectionT(
        source.start.x, source.start.y, source.start.z,
        source.end.x, source.end.y, source.end.z,
        unit.transform.x, unit.transform.y, unit.transform.z,
        unit.unit.unitRadiusCollider.shot + source.width / 2
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

    // Apply damage in order, respecting maxHits
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

      // Always truncate at first hit
      result.truncationT = hit.t;
      break;
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

    // Check units using swept 3D collision — segment prev→current vs a
    // sphere with the combined radius at unit.transform (full 3D: x, y,
    // AND z). A projectile sweeping above a ground unit's head misses;
    // one arcing into the top of the unit's sphere hits earlier in the
    // arc than a horizontal shot because the sphere is closer to the
    // flight path.
    for (const unit of nearbyUnits) {
      if (source.excludeEntities.has(unit.id)) continue;
      if (!unit.unit || unit.unit.hp <= 0) continue;

      const combinedRadius = source.radius + unit.unit.unitRadiusCollider.shot;
      const t = lineSphereIntersectionT(
        source.prev.x, source.prev.y, source.prev.z,
        source.current.x, source.current.y, source.current.z,
        unit.transform.x, unit.transform.y, unit.transform.z,
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

    // Check units — full 3D sphere-vs-sphere: the AOE sphere around
    // source.center must overlap the unit's collision sphere. A mortar
    // airburst above a unit hits; a blast in a pit below a unit at
    // altitude doesn't (once air units exist).
    for (const unit of nearbyUnits) {
      if (source.excludeEntities.has(unit.id)) continue;
      if (!unit.unit || unit.unit.hp <= 0) continue;

      const dx = unit.transform.x - source.center.x;
      const dy = unit.transform.y - source.center.y;
      const dz = unit.transform.z - source.center.z;
      const targetRadius = unit.unit.unitRadiusCollider.shot;

      // Cheap squared-distance rejection before sqrt
      const distSq = dx * dx + dy * dy + dz * dz;
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

    // Check buildings — full 3D. Buildings are axis-aligned boxes
    // (width × height × depth) sitting on the ground; the real
    // sphere-vs-building test is "sphere intersects AABB," computed
    // as distance from the sphere center to the nearest point of the
    // box. This lets a high-arc shell's blast wash over the top of a
    // short building without damaging it, and catches tall buildings
    // with explosions from above.
    for (const building of nearbyBuildings) {
      if (source.excludeEntities.has(building.id)) continue;
      if (!building.building || building.building.hp <= 0) continue;

      const hw = building.building.width / 2;
      const hh = building.building.height / 2;
      const bd = building.building.depth;
      const bMinX = building.transform.x - hw;
      const bMaxX = building.transform.x + hw;
      const bMinY = building.transform.y - hh;
      const bMaxY = building.transform.y + hh;
      const bMinZ = 0;
      const bMaxZ = bd;

      // Closest point on the AABB to the sphere center.
      const cx = source.center.x < bMinX ? bMinX : source.center.x > bMaxX ? bMaxX : source.center.x;
      const cy = source.center.y < bMinY ? bMinY : source.center.y > bMaxY ? bMaxY : source.center.y;
      const cz = source.center.z < bMinZ ? bMinZ : source.center.z > bMaxZ ? bMaxZ : source.center.z;

      const dx = source.center.x - cx;
      const dy = source.center.y - cy;
      const dz = source.center.z - cz;
      const distSq = dx * dx + dy * dy + dz * dz;
      if (distSq > source.radius * source.radius) continue;

      const dist = Math.sqrt(distSq);

      // Slice (wave-weapon cone) stays a horizontal test — the wave
      // direction is a yaw, not a 3D vector — using the horizontal
      // delta from explosion center to building center.
      if (hasSlice) {
        const hDx = building.transform.x - source.center.x;
        const hDy = building.transform.y - source.center.y;
        const hDist = Math.hypot(hDx, hDy);
        const buildingRadius = getTargetRadius(building);
        if (!isPointInSlice(
          hDx, hDy, hDist,
          sliceDirection,
          sliceHalfAngle,
          source.radius,
          buildingRadius
        )) continue;
      }

      const damage = computeFalloffDamage(dist, source.radius, source.damage, source.falloff);

      // Knockback direction: from the AABB's closest point back toward
      // the sphere center, flattened to horizontal because buildings
      // are static — the vertical component of force would be wasted.
      const hKx = building.transform.x - source.center.x;
      const hKy = building.transform.y - source.center.y;
      const hKmag = Math.hypot(hKx, hKy);
      const dirX = hKmag > 0 ? hKx / hKmag : 0;
      const dirY = hKmag > 0 ? hKy / hKmag : 0;

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

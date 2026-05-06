// Unified Damage System
// Handles all damage types consistently: line (beams), swept (projectiles), area (splash/force field)
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
  KnockbackInfo,
} from './types';
import { KNOCKBACK, PROJECTILE_MASS_MULTIPLIER } from '../../../config';
import { BEAM_EXPLOSION_MAGNITUDE } from '../../../explosionConfig';
import { spatialGrid } from '../SpatialGrid';
import { magnitude, lineCircleIntersectionT, lineSphereIntersectionT, lineRectIntersectionT, rayBoxIntersectionT, isPointInSlice } from '../../math';
import { findClosestPanelHit } from '../combat/MirrorPanelHit';
import { findForceFieldSegmentIntersection } from '../combat/forceFieldTurret';
import { getTargetRadius } from '../combat/combatUtils';
import { ENTITY_CHANGED_HP } from '../../../types/network';
import {
  SOLAR_CLOSED_DAMAGE_MULTIPLIER,
  isSolarCollectorDamageReduced,
  notifySolarCollectorDamaged,
} from '../solarCollector';
import { getUnitGroundZ } from '../unitGeometry';


// Reusable DamageResult to avoid per-call allocations
const _reusableResult: DamageResult = {
  hitEntityIds: [],
  killedUnitIds: new Set(),
  killedBuildingIds: new Set(),
  knockbacks: [],
  deathContexts: new Map(),
};
// Pool for KnockbackInfo + its inner Vec2. The result.knockbacks array
// itself is reused, but each entry pushed during an explosion was a
// fresh `{ entityId, force: { x, y } }` allocation — and big splashes
// drop these by the hundred per second. Pool both the outer entry
// AND the inner force vector; pushKnockback() rents an entry, fills
// it, and appends. resetResult() returns the previous tick's entries
// to the pool before clearing the result.
const _knockbackPool: KnockbackInfo[] = [];
function rentKnockback(): KnockbackInfo {
  return _knockbackPool.pop() ?? { entityId: 0, force: { x: 0, y: 0 } };
}
function pushKnockback(
  result: DamageResult,
  entityId: number,
  fx: number,
  fy: number,
): void {
  const k = rentKnockback();
  k.entityId = entityId;
  k.force.x = fx;
  k.force.y = fy;
  result.knockbacks.push(k);
}
function resetResult(): DamageResult {
  _reusableResult.hitEntityIds.length = 0;
  _reusableResult.killedUnitIds.clear();
  _reusableResult.killedBuildingIds.clear();
  _reusableResult.truncationT = undefined;
  // Recycle prior tick's knockback entries before clearing the array.
  for (const k of _reusableResult.knockbacks) _knockbackPool.push(k);
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
  for (const k of _reusableResult.knockbacks) _knockbackPool.push(k);
  _reusableResult.knockbacks.length = 0;
  _reusableResult.deathContexts.clear();
  _reusableHits.length = 0;
}

// Reusable result for findBeamSegmentHit. `z` is the world altitude
// of the hit point; `normalX/Y/Z` is the reflector's outward-facing
// 3D normal. Mirrors use their panel normal, force fields use the
// sphere surface normal.
const _segHit = { t: 0, x: 0, y: 0, z: 0, entityId: 0 as EntityId, isMirror: false, normalX: 0, normalY: 0, normalZ: 0, panelIndex: -1 };

const BEAM_GROUND_HIT_STEPS = 12;
const BEAM_GROUND_HIT_BISECT_STEPS = 6;
const BEAM_GROUND_EPSILON = 0.25;


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
    startX: number, startY: number, startZ: number,
    endX: number, endY: number, endZ: number,
    sourceEntityId: EntityId,
    lineWidth: number
  ): { t: number; entityId: EntityId } | null {
    let closestT: number | null = null;
    let closestEntityId: EntityId | null = null;

    // PERFORMANCE: Query only entities near the line using spatial grid
    const nearbyUnits = spatialGrid.queryUnitsAlongLine(startX, startY, startZ, endX, endY, endZ, lineWidth + 50);
    const nearbyBuildings = spatialGrid.queryBuildingsAlongLine(startX, startY, startZ, endX, endY, endZ, lineWidth + 100);

    // Check units
    for (const unit of nearbyUnits) {
      if (unit.id === sourceEntityId) continue;
      if (!unit.unit || unit.unit.hp <= 0) continue;

      const t = lineCircleIntersectionT(
        startX, startY, endX, endY,
        unit.transform.x, unit.transform.y,
        unit.unit.radius.shot + lineWidth / 2
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

  // Find beam path with reflections off mirror units and force-field
  // spheres — full 3D.
  //
  // The beam terminates at the first of: a unit hit, a building hit,
  // a ground hit, or the firing turret's RANGE SPHERE — a sphere of
  // radius `range` centered at the muzzle (`startX/Y/Z`). Mirrors and
  // force fields bounce; every segment after a reflection is also
  // clipped at the same range sphere, so the beam can travel any
  // distance along its bouncing polyline as long as the current segment
  // hasn't exited the sphere.
  //
  // Mirror panels are tilted rectangles; force fields are spherical
  // reflectors that only catch outside-to-inside crossings. Buildings
  // are 3D AABBs (x/y footprint × z depth), so a high-arc beam can pass
  // over a short building and hit the reflector behind it.
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
    // Range sphere — every bounced segment is clipped at this boundary
    // so the beam never travels further than `range` from the muzzle,
    // regardless of how many mirrors it bounces off. Caller passes the
    // initial endpoint as `start + dir × range`, which gives us the
    // sphere radius for free.
    const range = Math.hypot(endX - startX, endY - startY, endZ - startZ);
    const rangeSq = range * range;
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

      // Reflect around the reflector's full 3D normal. Mirrors provide
      // a panel normal; force fields provide the sphere surface normal.
      const dotDN = beamDirX * hit.normalX + beamDirY * hit.normalY + beamDirZ * hit.normalZ;
      const reflDirX = beamDirX - 2 * dotDN * hit.normalX;
      const reflDirY = beamDirY - 2 * dotDN * hit.normalY;
      const reflDirZ = beamDirZ - 2 * dotDN * hit.normalZ;

      // Reflected segment runs from the bounce point outward to wherever
      // the ray exits the firing turret's range sphere. Ray–sphere
      // exit: solve |hit + t·refl − origin|² = range² for the FAR
      // (positive) root with origin = startX/Y/Z and dir already unit.
      // The bounce point is at distance ≤ range from the origin, so the
      // discriminant is always non-negative and t_far ≥ 0.
      const ex = hit.x - startX;
      const ey = hit.y - startY;
      const ez = hit.z - startZ;
      const b = ex * reflDirX + ey * reflDirY + ez * reflDirZ;
      const c = ex * ex + ey * ey + ez * ez - rangeSq;
      const disc = b * b - c;
      const tFar = disc > 0 ? -b + Math.sqrt(disc) : 0;
      if (tFar <= 0) break;

      curSX = hit.x;
      curSY = hit.y;
      curSZ = hit.z;
      curEX = hit.x + reflDirX * tFar;
      curEY = hit.y + reflDirY * tFar;
      curEZ = hit.z + reflDirZ * tFar;
      excludeEntityId = hit.entityId;
      excludePanelIndex = hit.panelIndex;
    }

    return { endX: curEX, endY: curEY, endZ: curEZ, reflections };
  }

  // Find closest beam hit — checks mirror panel rectangles AND regular
  // entity colliders, all in 3D.
  //   excludeEntityId: on bounce 0 = source (don't hit self), on bounce N = last mirror hit
  //   excludePanelIndex: -1 = exclude entire entity, >= 0 = exclude only that panel
  private findGroundSegmentT(
    startX: number, startY: number, startZ: number,
    endX: number, endY: number, endZ: number,
  ): number | null {
    const sampleClearance = (t: number): number => {
      const x = startX + (endX - startX) * t;
      const y = startY + (endY - startY) * t;
      const z = startZ + (endZ - startZ) * t;
      return z - this.world.getGroundZ(x, y);
    };

    let prevT = 0;
    let prevClear = sampleClearance(0);
    if (prevClear < -BEAM_GROUND_EPSILON) return 0;

    for (let i = 1; i <= BEAM_GROUND_HIT_STEPS; i++) {
      const t = i / BEAM_GROUND_HIT_STEPS;
      const clear = sampleClearance(t);
      if (clear <= BEAM_GROUND_EPSILON && prevClear > BEAM_GROUND_EPSILON) {
        let lo = prevT;
        let hi = t;
        for (let b = 0; b < BEAM_GROUND_HIT_BISECT_STEPS; b++) {
          const mid = (lo + hi) * 0.5;
          if (sampleClearance(mid) <= BEAM_GROUND_EPSILON) hi = mid;
          else lo = mid;
        }
        return hi;
      }
      prevT = t;
      prevClear = clear;
    }

    return null;
  }

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

    const nearbyUnits = spatialGrid.queryUnitsAlongLine(startX, startY, startZ, endX, endY, endZ, lineWidth + 60);

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
      const mirrorsActive = this.world.mirrorsEnabled && panels.length > 0;
      const boundR = mirrorsActive
        ? Math.max(unit.unit.mirrorBoundRadius, unit.unit.radius.shot) + lineWidth
        : unit.unit.radius.shot + lineWidth / 2;
      if (crossSq * crossSq > boundR * boundR * segLenSq) continue;

      if (mirrorsActive) {
        // Mirror unit: 3D ray-vs-tilted-rectangle for each panel
        // (yaw + pitch from the mirror turret rotation/pitch).
        const unitTurrets = unit.combat?.turrets;
        const mirrorRot = unitTurrets && unitTurrets.length > 0
          ? unitTurrets[0].rotation
          : unit.transform.rotation;
        const mirrorPitch = unitTurrets && unitTurrets.length > 0
          ? unitTurrets[0].pitch
          : 0;
        const unitGroundZ = getUnitGroundZ(unit);
        const panelExclude = isExcludedEntity ? excludePanelIndex : -1;
        const hit = findClosestPanelHit(
          panels, mirrorRot, mirrorPitch,
          unit.transform.x, unit.transform.y, unitGroundZ,
          startX, startY, startZ, endX, endY, endZ,
          panelExclude,
        );
        if (hit !== null && hit.t < bestT) {
          bestT = hit.t; found = true;
          _segHit.t = hit.t;
          _segHit.x = hit.x;
          _segHit.y = hit.y;
          _segHit.z = hit.z;
          _segHit.entityId = unit.id;
          _segHit.isMirror = true;
          _segHit.normalX = hit.normalX;
          _segHit.normalY = hit.normalY;
          _segHit.normalZ = hit.normalZ;
          _segHit.panelIndex = hit.panelIndex;
        }
      }

      // Unit body: 3D segment-vs-sphere.
      {
        const t = lineSphereIntersectionT(
          startX, startY, startZ,
          endX, endY, endZ,
          unit.transform.x, unit.transform.y, unit.transform.z,
          unit.unit.radius.shot + lineWidth / 2
        );
        if (t !== null && t < bestT) {
          bestT = t; found = true;
          _segHit.t = t;
          _segHit.x = startX + t * dx;
          _segHit.y = startY + t * dy;
          _segHit.z = startZ + t * dz;
          _segHit.entityId = unit.id;
          _segHit.isMirror = false;
          _segHit.normalX = 0; _segHit.normalY = 0; _segHit.normalZ = 0;
          _segHit.panelIndex = -1;
        }
      }
    }

    if (this.world.forceFieldsEnabled) {
      const forceFieldHit = findForceFieldSegmentIntersection(
        this.world,
        startX, startY, startZ,
        endX, endY, endZ,
      );
      if (forceFieldHit !== null && forceFieldHit.t < bestT) {
        bestT = forceFieldHit.t; found = true;
        _segHit.t = forceFieldHit.t;
        _segHit.x = forceFieldHit.x;
        _segHit.y = forceFieldHit.y;
        _segHit.z = forceFieldHit.z;
        _segHit.entityId = forceFieldHit.entityId as EntityId;
        _segHit.isMirror = true;
        _segHit.normalX = forceFieldHit.nx;
        _segHit.normalY = forceFieldHit.ny;
        _segHit.normalZ = forceFieldHit.nz;
        _segHit.panelIndex = -1;
      }
    }

    // Buildings: 3D ray-vs-AABB (x/y footprint × z depth). A beam arcing
    // over a short building correctly misses; clipping the wall stops.
    const nearbyBuildings = spatialGrid.queryBuildingsAlongLine(startX, startY, startZ, endX, endY, endZ, lineWidth + 100);
    for (const building of nearbyBuildings) {
      if (!building.building || building.building.hp <= 0) continue;
      const bWidth = building.building.width;
      const bHeight = building.building.height;
      const bDepth = building.building.depth;
      const minX = building.transform.x - bWidth / 2;
      const minY = building.transform.y - bHeight / 2;
      const maxX = building.transform.x + bWidth / 2;
      const maxY = building.transform.y + bHeight / 2;
      const minZ = building.transform.z - bDepth / 2;
      const maxZ = building.transform.z + bDepth / 2;
      const t = rayBoxIntersectionT(
        startX, startY, startZ,
        endX, endY, endZ,
        minX, minY, minZ,
        maxX, maxY, maxZ,
      );
      if (t !== null && t < bestT) {
        bestT = t; found = true;
        _segHit.t = t;
        _segHit.x = startX + t * dx;
        _segHit.y = startY + t * dy;
        _segHit.z = startZ + t * dz;
        _segHit.entityId = building.id;
        _segHit.isMirror = false;
        _segHit.normalX = 0; _segHit.normalY = 0; _segHit.normalZ = 0;
        _segHit.panelIndex = -1;
      }
    }

    const groundT = this.findGroundSegmentT(startX, startY, startZ, endX, endY, endZ);
    if (groundT !== null && groundT < bestT) {
      bestT = groundT; found = true;
      _segHit.t = groundT;
      _segHit.x = startX + groundT * dx;
      _segHit.y = startY + groundT * dy;
      _segHit.z = this.world.getGroundZ(_segHit.x, _segHit.y);
      _segHit.entityId = 0 as EntityId;
      _segHit.isMirror = false;
      _segHit.normalX = 0; _segHit.normalY = 0; _segHit.normalZ = 1;
      _segHit.panelIndex = -1;
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

    // Beams truncate at the closest hit (the loop below used to collect
    // all hits, sort by T, then unconditionally break on the first one —
    // the sort and per-hit allocations were pure waste). Track the
    // single closest hit instead. PERFORMANCE: spatial grid culls to
    // near-line entities; we still test each candidate but skip the
    // array + sort entirely.
    let bestT = Infinity;
    let bestEntityId: EntityId = 0;
    let bestIsUnit = false;

    const nearbyUnits = spatialGrid.queryUnitsAlongLine(
      source.start.x, source.start.y, source.start.z,
      source.end.x, source.end.y, source.end.z, source.width + 50
    );
    const nearbyBuildings = spatialGrid.queryBuildingsAlongLine(
      source.start.x, source.start.y, source.start.z,
      source.end.x, source.end.y, source.end.z, source.width + 100
    );

    // Check units — 3D segment-vs-sphere: the beam is a line in 3D
    // space; a unit takes a hit when its sphere intersects that line
    // (inflated by beam half-width). A beam pitched upward into the
    // sky can't catch ground units; a beam aimed down does.
    for (const unit of nearbyUnits) {
      if (source.excludeEntities.has(unit.id)) continue;
      if (source.excludeCommanders && unit.commander) continue;
      if (!unit.unit || unit.unit.hp <= 0) continue;

      const t = lineSphereIntersectionT(
        source.start.x, source.start.y, source.start.z,
        source.end.x, source.end.y, source.end.z,
        unit.transform.x, unit.transform.y, unit.transform.z,
        unit.unit.radius.shot + source.width / 2
      );

      if (t !== null && t < bestT) {
        bestT = t;
        bestEntityId = unit.id;
        bestIsUnit = true;
      }
    }

    // Check buildings — full 3D AABB, matching the beam tracer and
    // client predictor. A beam that visually passes over a building
    // no longer applies 2D footprint damage.
    for (const building of nearbyBuildings) {
      if (source.excludeEntities.has(building.id)) continue;
      if (!building.building || building.building.hp <= 0) continue;

      const halfW = building.building.width / 2;
      const halfH = building.building.height / 2;
      const halfD = building.building.depth / 2;
      const t = rayBoxIntersectionT(
        source.start.x, source.start.y, source.start.z,
        source.end.x, source.end.y, source.end.z,
        building.transform.x - halfW,
        building.transform.y - halfH,
        building.transform.z - halfD,
        building.transform.x + halfW,
        building.transform.y + halfH,
        building.transform.z + halfD,
      );

      if (t !== null && t < bestT) {
        bestT = t;
        bestEntityId = building.id;
        bestIsUnit = false;
      }
    }

    if (bestT === Infinity) return result;

    const entity = this.world.getEntity(bestEntityId);
    if (!entity) return result;

    // Momentum-based knockback (mass × velocity × MULTIPLIER) — depends
    // only on source, hoist out of the (now-unrolled) hit loop.
    const lineMomentum = (source.projectileMass ?? 0) * PROJECTILE_MASS_MULTIPLIER * (source.velocity ?? 0);

    // Calculate hit point using T value
    const hitX = source.start.x + bestT * (source.end.x - source.start.x);
    const hitY = source.start.y + bestT * (source.end.y - source.start.y);

    // Penetration direction: from hit point through unit center
    const penDirX = entity.transform.x - hitX;
    const penDirY = entity.transform.y - hitY;
    const penMag = magnitude(penDirX, penDirY);
    const penNormX = penMag > 0 ? penDirX / penMag : knockbackDirX;
    const penNormY = penMag > 0 ? penDirY / penMag : knockbackDirY;

    this.applyDamageToEntity(entity, source.damage, result, source.sourceEntityId, {
      penetrationDir: { x: penNormX, y: penNormY },
      attackerVel: { x: knockbackDirX * BEAM_EXPLOSION_MAGNITUDE, y: knockbackDirY * BEAM_EXPLOSION_MAGNITUDE },
      attackMagnitude: source.damage,
    });
    result.hitEntityIds.push(bestEntityId);
    result.truncationT = bestT;

    if (bestIsUnit && lineMomentum > 0) {
      pushKnockback(result, bestEntityId, knockbackDirX * lineMomentum, knockbackDirY * lineMomentum);
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
      source.prev.x, source.prev.y, source.prev.z,
      source.current.x, source.current.y, source.current.z, source.radius + 50
    );
    const nearbyBuildings = spatialGrid.queryBuildingsAlongLine(
      source.prev.x, source.prev.y, source.prev.z,
      source.current.x, source.current.y, source.current.z, source.radius + 100
    );

    // Check units using swept 3D collision — segment prev→current vs a
    // sphere with the combined radius at unit.transform (full 3D: x, y,
    // AND z). A projectile sweeping above a ground unit's head misses;
    // one arcing into the top of the unit's sphere hits earlier in the
    // arc than a horizontal shot because the sphere is closer to the
    // flight path.
    for (const unit of nearbyUnits) {
      if (source.excludeEntities.has(unit.id)) continue;
      if (source.excludeCommanders && unit.commander) continue;
      if (!unit.unit || unit.unit.hp <= 0) continue;

      const combinedRadius = source.radius + unit.unit.radius.shot;
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

    // Check buildings using swept 3D collision against the AABB
    // expanded by projectile radius.
    for (const building of nearbyBuildings) {
      if (source.excludeEntities.has(building.id)) continue;
      if (!building.building || building.building.hp <= 0) continue;

      const halfW = building.building.width / 2 + source.radius;
      const halfH = building.building.height / 2 + source.radius;
      const halfD = building.building.depth / 2 + source.radius;
      const t = rayBoxIntersectionT(
        source.prev.x, source.prev.y, source.prev.z,
        source.current.x, source.current.y, source.current.z,
        building.transform.x - halfW,
        building.transform.y - halfH,
        building.transform.z - halfD,
        building.transform.x + halfW,
        building.transform.y + halfH,
        building.transform.z + halfD,
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
        pushKnockback(result, hit.entityId, forceX, forceY);
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
    const nearbyUnits = spatialGrid.queryUnitsInRadius(source.center.x, source.center.y, source.center.z, source.radius + 50);
    const nearbyBuildings = spatialGrid.queryBuildingsInRadius(source.center.x, source.center.y, source.center.z, source.radius + 100);

    // Check units — full 3D sphere-vs-sphere: the AOE sphere around
    // source.center must overlap the unit's collision sphere. A mortar
    // airburst above a unit hits; a blast in a pit below a unit at
    // altitude doesn't (once air units exist).
    for (const unit of nearbyUnits) {
      if (source.excludeEntities.has(unit.id)) continue;
      if (source.excludeCommanders && unit.commander) continue;
      if (!unit.unit || unit.unit.hp <= 0) continue;

      const dx = unit.transform.x - source.center.x;
      const dy = unit.transform.y - source.center.y;
      const dz = unit.transform.z - source.center.z;
      const targetRadius = unit.unit.radius.shot;

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

      // Boolean AoE: full damage, full force — no distance falloff.
      // The sphere-vs-sphere overlap test above is the entire gate.
      const damage = source.damage;

      // Knockback direction is still from center outward so units are
      // pushed AWAY from the blast, not in a fixed direction.
      const invDist = dist > 0 ? 1 / dist : 0;
      const dirX = dx * invDist;
      const dirY = dy * invDist;
      const force = source.knockbackForce ?? (damage * KNOCKBACK.SPLASH);
      const forceX = dirX * force;
      const forceY = dirY * force;

      // For area damage, penetration direction is from explosion center
      // through unit (same as knockback direction — outward from center).
      this.applyDamageToEntity(unit, damage, result, source.sourceEntityId, {
        penetrationDir: { x: dirX, y: dirY },
        attackerVel: { x: forceX, y: forceY },
        attackMagnitude: damage,
      });
      result.hitEntityIds.push(unit.id);

      // Add knockback (direction is from center outward)
      if (force > 0 && dist > 0) {
        pushKnockback(result, unit.id, forceX, forceY);
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
      const bMinZ = building.transform.z - bd / 2;
      const bMaxZ = building.transform.z + bd / 2;

      // Closest point on the AABB to the sphere center.
      const cx = source.center.x < bMinX ? bMinX : source.center.x > bMaxX ? bMaxX : source.center.x;
      const cy = source.center.y < bMinY ? bMinY : source.center.y > bMaxY ? bMaxY : source.center.y;
      const cz = source.center.z < bMinZ ? bMinZ : source.center.z > bMaxZ ? bMaxZ : source.center.z;

      const dx = source.center.x - cx;
      const dy = source.center.y - cy;
      const dz = source.center.z - cz;
      const distSq = dx * dx + dy * dy + dz * dz;
      if (distSq > source.radius * source.radius) continue;

      // Horizontal delta from explosion center to building center.
      // Used by both the slice (wave-weapon cone) test and the knockback
      // direction below — compute once.
      const hDx = building.transform.x - source.center.x;
      const hDy = building.transform.y - source.center.y;
      const hDist = Math.hypot(hDx, hDy);

      // Slice (wave-weapon cone) stays a horizontal test — the wave
      // direction is a yaw, not a 3D vector.
      if (hasSlice) {
        const buildingRadius = getTargetRadius(building);
        if (!isPointInSlice(
          hDx, hDy, hDist,
          sliceDirection,
          sliceHalfAngle,
          source.radius,
          buildingRadius
        )) continue;
      }

      // Boolean AoE damage to buildings — same as units above.
      const damage = source.damage;

      // Knockback direction: horizontal (buildings are static, vertical
      // force is wasted). Reuse hDist from above.
      const invH = hDist > 0 ? 1 / hDist : 0;
      const dirX = hDx * invH;
      const dirY = hDy * invH;

      const bForce = source.knockbackForce ?? (damage * KNOCKBACK.SPLASH);
      const bForceX = dirX * bForce;
      const bForceY = dirY * bForce;
      this.applyDamageToEntity(building, damage, result, source.sourceEntityId, {
        penetrationDir: { x: dirX, y: dirY },
        attackerVel: { x: bForceX, y: bForceY },
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
    void sourceEntityId;
    if (entity.unit && entity.unit.hp > 0) {
      entity.unit.hp -= damage;
      this.world.markSnapshotDirty(entity.id, ENTITY_CHANGED_HP);
      if (entity.unit.hp <= 0 && !result.killedUnitIds.has(entity.id)) {
        result.killedUnitIds.add(entity.id);
        // Store death context for explosion effects
        if (deathContext) {
          result.deathContexts.set(entity.id, deathContext);
        }
      }
    } else if (entity.building && entity.building.hp > 0) {
      const effectiveDamage = isSolarCollectorDamageReduced(entity)
        ? damage * SOLAR_CLOSED_DAMAGE_MULTIPLIER
        : damage;
      if (entity.buildingType === 'solar') {
        notifySolarCollectorDamaged(this.world, entity);
      }
      entity.building.hp -= effectiveDamage;
      this.world.markSnapshotDirty(entity.id, ENTITY_CHANGED_HP);
      if (entity.building.hp <= 0 && !result.killedBuildingIds.has(entity.id)) {
        result.killedBuildingIds.add(entity.id);
      }
    }
  }
}

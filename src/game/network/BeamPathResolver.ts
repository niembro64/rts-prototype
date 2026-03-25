/**
 * BeamPathResolver - Beam path tracing with reflections off mirror units.
 *
 * Extracted from ClientViewState. Client-side equivalent of DamageSystem.findBeamPath().
 */

import { magnitude, lineCircleIntersectionT } from '../math';
import type { EntityCacheManager } from '../sim/EntityCacheManager';

// Reusable result for raySegmentIntersection (avoids per-hit allocations in hot loop)
const _rsHit = { t: 0, x: 0, y: 0 };

// Ray-vs-line-segment intersection (shared with DamageSystem)
// Returns reusable _rsHit on hit — caller must read values before next call
function raySegmentIntersection(
  sx: number,
  sy: number,
  ex: number,
  ey: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): typeof _rsHit | null {
  const rdx = ex - sx,
    rdy = ey - sy;
  const sdx = bx - ax,
    sdy = by - ay;
  const denom = rdx * sdy - rdy * sdx;
  if (Math.abs(denom) < 1e-10) return null;
  const t = ((ax - sx) * sdy - (ay - sy) * sdx) / denom;
  const u = ((ax - sx) * rdy - (ay - sy) * rdx) / denom;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  _rsHit.t = t;
  _rsHit.x = sx + t * rdx;
  _rsHit.y = sy + t * rdy;
  return _rsHit;
}

// Reusable result for findBeamSegmentHit (avoids per-call allocations)
const _segHit = {
  t: 0,
  x: 0,
  y: 0,
  entityId: 0,
  isMirror: false,
  normalX: 0,
  normalY: 0,
  panelIndex: -1,
};

export type BeamPathResult = {
  endX: number;
  endY: number;
  obstructionT?: number;
  reflections: { x: number; y: number; mirrorEntityId: number }[];
};

/**
 * Trace a beam path with reflections off mirror units.
 * Mirror collision uses ray-vs-line-segment (flat mirror surface), not circle colliders.
 * Client-side equivalent of DamageSystem.findBeamPath().
 */
export function findBeamPath(
  cache: EntityCacheManager,
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  sourceId: number,
  maxBounces: number = 3,
): BeamPathResult {
  const reflections: { x: number; y: number; mirrorEntityId: number }[] = [];
  let curSX = startX,
    curSY = startY;
  let curEX = endX,
    curEY = endY;
  let excludeId = sourceId;
  let excludePanelIndex = -1; // -1 = exclude entire entity (source), >= 0 = exclude only that panel

  for (let bounce = 0; bounce <= maxBounces; bounce++) {
    const hit = findBeamSegmentHit(
      cache,
      curSX,
      curSY,
      curEX,
      curEY,
      excludeId,
      excludePanelIndex,
    );

    if (!hit) {
      return { endX: curEX, endY: curEY, reflections };
    }

    if (!hit.isMirror) {
      if (bounce === 0)
        return { endX: hit.x, endY: hit.y, obstructionT: hit.t, reflections };
      return { endX: hit.x, endY: hit.y, reflections };
    }

    // Mirror reflection
    reflections.push({ x: hit.x, y: hit.y, mirrorEntityId: hit.entityId });

    const segDx = curEX - curSX,
      segDy = curEY - curSY;
    const segLen = magnitude(segDx, segDy);
    if (segLen === 0) break;
    const beamDirX = segDx / segLen,
      beamDirY = segDy / segLen;

    const dotDN = beamDirX * hit.normalX + beamDirY * hit.normalY;
    const reflDirX = beamDirX - 2 * dotDN * hit.normalX;
    const reflDirY = beamDirY - 2 * dotDN * hit.normalY;
    const remaining = segLen * (1 - hit.t);

    curSX = hit.x;
    curSY = hit.y;
    curEX = hit.x + reflDirX * remaining;
    curEY = hit.y + reflDirY * remaining;
    excludeId = hit.entityId;
    excludePanelIndex = hit.panelIndex; // only exclude the panel we just bounced off
  }

  return { endX: curEX, endY: curEY, reflections };
}

/** Find closest beam hit — checks mirror line segments AND regular entity colliders
 *  excludeId: on bounce 0 = source (don't hit self), on bounce N = last mirror hit
 *  excludePanelIndex: -1 = exclude entire entity, >= 0 = exclude only that panel */
function findBeamSegmentHit(
  cache: EntityCacheManager,
  sx: number,
  sy: number,
  ex: number,
  ey: number,
  excludeId: number,
  excludePanelIndex: number,
): typeof _segHit | null {
  let bestT = Infinity;
  let found = false;
  const dx = ex - sx,
    dy = ey - sy;
  const segLenSq = dx * dx + dy * dy;

  for (const unit of cache.getUnits()) {
    // Panel-level exclude: if excludePanelIndex >= 0, only skip the specific panel (not the whole entity)
    const isExcludedEntity = unit.id === excludeId;
    if (isExcludedEntity && excludePanelIndex < 0) continue; // full entity exclude (source unit)
    if (!unit.unit || unit.unit.hp <= 0) continue;

    // Early-out: point-to-line distance check (avoids expensive per-unit math for distant units)
    const ux = unit.transform.x - sx,
      uy = unit.transform.y - sy;
    const crossSq = ux * dy - uy * dx;
    const panels = unit.unit.mirrorPanels;
    const boundR =
      panels.length > 0
        ? Math.max(
            unit.unit.mirrorBoundRadius,
            unit.unit.radiusColliderUnitShot,
          )
        : unit.unit.radiusColliderUnitShot;
    if (crossSq * crossSq > boundR * boundR * segLenSq) continue;

    if (panels.length > 0) {
      // Mirror unit: test ray vs outer edge of each rectangular panel
      let mirrorRot = unit.transform.rotation;
      if (unit.turrets && unit.turrets.length > 0) {
        mirrorRot = unit.turrets[0].rotation;
      }
      const fwdX = Math.cos(mirrorRot),
        fwdY = Math.sin(mirrorRot);
      const perpX = -fwdY,
        perpY = fwdX;

      for (let pi = 0; pi < panels.length; pi++) {
        // Skip only the specific panel we just bounced off
        if (isExcludedEntity && pi === excludePanelIndex) continue;

        const panel = panels[pi];
        const pcx =
          unit.transform.x + fwdX * panel.offsetX + perpX * panel.offsetY;
        const pcy =
          unit.transform.y + fwdY * panel.offsetX + perpY * panel.offsetY;

        const panelAngle = mirrorRot + panel.angle;
        const pnx = Math.cos(panelAngle);
        const pny = Math.sin(panelAngle);

        const edx = -pny;
        const edy = pnx;

        const e1x = pcx + edx * panel.halfWidth;
        const e1y = pcy + edy * panel.halfWidth;
        const e2x = pcx - edx * panel.halfWidth;
        const e2y = pcy - edy * panel.halfWidth;

        const faceHit = raySegmentIntersection(
          sx,
          sy,
          ex,
          ey,
          e1x,
          e1y,
          e2x,
          e2y,
        );
        if (faceHit && faceHit.t < bestT) {
          bestT = faceHit.t;
          found = true;
          _segHit.t = faceHit.t;
          _segHit.x = faceHit.x;
          _segHit.y = faceHit.y;
          _segHit.entityId = unit.id;
          _segHit.isMirror = true;
          _segHit.normalX = pnx;
          _segHit.normalY = pny;
          _segHit.panelIndex = pi;
        }
      }
    }

    // Circle collision — all units (mirror units can be hit on their body too)
    {
      const r = unit.unit.radiusColliderUnitShot;
      const t = lineCircleIntersectionT(
        sx,
        sy,
        ex,
        ey,
        unit.transform.x,
        unit.transform.y,
        r,
      );
      if (t !== null && t < bestT) {
        bestT = t;
        found = true;
        _segHit.t = t;
        _segHit.x = sx + t * dx;
        _segHit.y = sy + t * dy;
        _segHit.entityId = unit.id;
        _segHit.isMirror = false;
        _segHit.normalX = 0;
        _segHit.normalY = 0;
        _segHit.panelIndex = -1;
      }
    }
  }

  // Buildings: AABB slab method
  for (const bldg of cache.getBuildings()) {
    if (bldg.id === excludeId) continue;
    if (!bldg.building) continue;
    const hw = bldg.building.width / 2,
      hh = bldg.building.height / 2;
    const bx = bldg.transform.x,
      by = bldg.transform.y;
    let tmin = 0,
      tmax = 1;
    if (Math.abs(dx) > 0.0001) {
      let t1 = (bx - hw - sx) / dx,
        t2 = (bx + hw - sx) / dx;
      if (t1 > t2) {
        const tmp = t1;
        t1 = t2;
        t2 = tmp;
      }
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
    } else if (sx < bx - hw || sx > bx + hw) continue;
    if (Math.abs(dy) > 0.0001) {
      let t1 = (by - hh - sy) / dy,
        t2 = (by + hh - sy) / dy;
      if (t1 > t2) {
        const tmp = t1;
        t1 = t2;
        t2 = tmp;
      }
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
    } else if (sy < by - hh || sy > by + hh) continue;
    if (tmin <= tmax && tmax > 0) {
      const t = Math.max(tmin, 0);
      if (t < bestT) {
        bestT = t;
        found = true;
        _segHit.t = t;
        _segHit.x = sx + t * dx;
        _segHit.y = sy + t * dy;
        _segHit.entityId = bldg.id;
        _segHit.isMirror = false;
        _segHit.normalX = 0;
        _segHit.normalY = 0;
      }
    }
  }

  return found ? _segHit : null;
}

/**
 * BeamPathResolver — 3D beam path tracing with reflections off mirror units.
 *
 * Client-side equivalent of DamageSystem.findBeamPath(). Both versions
 * share the same geometry: mirror panels are upright rectangles with a
 * horizontal yaw-only normal, unit bodies are 3D spheres, buildings are
 * axis-aligned boxes (x/y footprint × z depth). A bounce off a mirror
 * preserves the beam's vertical component (d.z unchanged) because the
 * panel's normal lies entirely in the horizontal plane.
 */

import {
  lineSphereIntersectionT,
  rayBoxIntersectionT,
} from '../math';
import { findClosestPanelHit } from '../sim/combat/MirrorPanelHit';
import type { EntityCacheManager } from '../sim/EntityCacheManager';

// Reusable result for findBeamSegmentHit (avoids per-call allocations)
const _segHit = {
  t: 0,
  x: 0,
  y: 0,
  z: 0,
  entityId: 0,
  isMirror: false,
  normalX: 0,
  normalY: 0,
  normalZ: 0,
  panelIndex: -1,
};

export type BeamPathResult = {
  endX: number;
  endY: number;
  endZ: number;
  obstructionT?: number;
  reflections: { x: number; y: number; z: number; mirrorEntityId: number }[];
};

/**
 * Trace a beam path with reflections off mirror units in full 3D.
 */
export function findBeamPath(
  cache: EntityCacheManager,
  startX: number,
  startY: number,
  startZ: number,
  endX: number,
  endY: number,
  endZ: number,
  sourceId: number,
  maxBounces: number = 3,
): BeamPathResult {
  const reflections: { x: number; y: number; z: number; mirrorEntityId: number }[] = [];
  let curSX = startX, curSY = startY, curSZ = startZ;
  let curEX = endX, curEY = endY, curEZ = endZ;
  let excludeId = sourceId;
  let excludePanelIndex = -1;

  for (let bounce = 0; bounce <= maxBounces; bounce++) {
    const hit = findBeamSegmentHit(
      cache,
      curSX, curSY, curSZ,
      curEX, curEY, curEZ,
      excludeId,
      excludePanelIndex,
    );

    if (!hit) {
      return { endX: curEX, endY: curEY, endZ: curEZ, reflections };
    }

    if (!hit.isMirror) {
      if (bounce === 0)
        return {
          endX: hit.x, endY: hit.y, endZ: hit.z,
          obstructionT: hit.t, reflections,
        };
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

    // Reflect around the panel's full 3D normal so a pitched mirror
    // redirects the beam's vertical component as well as horizontal.
    const dotDN = beamDirX * hit.normalX + beamDirY * hit.normalY + beamDirZ * hit.normalZ;
    const reflDirX = beamDirX - 2 * dotDN * hit.normalX;
    const reflDirY = beamDirY - 2 * dotDN * hit.normalY;
    const reflDirZ = beamDirZ - 2 * dotDN * hit.normalZ;
    const remaining = segLen * (1 - hit.t);

    curSX = hit.x;
    curSY = hit.y;
    curSZ = hit.z;
    curEX = hit.x + reflDirX * remaining;
    curEY = hit.y + reflDirY * remaining;
    curEZ = hit.z + reflDirZ * remaining;
    excludeId = hit.entityId;
    excludePanelIndex = hit.panelIndex;
  }

  return { endX: curEX, endY: curEY, endZ: curEZ, reflections };
}

/** Find closest beam hit — checks mirror panel rectangles AND regular
 *  entity colliders. All intersection tests are 3D. */
function findBeamSegmentHit(
  cache: EntityCacheManager,
  sx: number, sy: number, sz: number,
  ex: number, ey: number, ez: number,
  excludeId: number,
  excludePanelIndex: number,
): typeof _segHit | null {
  let bestT = Infinity;
  let found = false;
  const dx = ex - sx, dy = ey - sy, dz = ez - sz;
  const segLenSq = dx * dx + dy * dy;

  for (const unit of cache.getUnits()) {
    const isExcludedEntity = unit.id === excludeId;
    if (isExcludedEntity && excludePanelIndex < 0) continue;
    if (!unit.unit || unit.unit.hp <= 0) continue;

    // Horizontal early-out — the beam may sweep vertically, but its
    // XY projection must still approach the unit's bounding radius.
    const ux = unit.transform.x - sx,
      uy = unit.transform.y - sy;
    const crossSq = ux * dy - uy * dx;
    const panels = unit.unit.mirrorPanels;
    const boundR =
      panels.length > 0
        ? Math.max(
            unit.unit.mirrorBoundRadius,
            unit.unit.unitRadiusCollider.shot,
          )
        : unit.unit.unitRadiusCollider.shot;
    if (crossSq * crossSq > boundR * boundR * segLenSq) continue;

    if (panels.length > 0) {
      const mirrorRot = unit.turrets && unit.turrets.length > 0
        ? unit.turrets[0].rotation
        : unit.transform.rotation;
      const mirrorPitch = unit.turrets && unit.turrets.length > 0
        ? unit.turrets[0].pitch
        : 0;
      const unitGroundZ = unit.transform.z - unit.unit.unitRadiusCollider.push;
      const panelExclude = isExcludedEntity ? excludePanelIndex : -1;
      const hit = findClosestPanelHit(
        panels, mirrorRot, mirrorPitch,
        unit.transform.x, unit.transform.y, unitGroundZ,
        sx, sy, sz, ex, ey, ez,
        panelExclude,
      );
      if (hit !== null && hit.t < bestT) {
        bestT = hit.t;
        found = true;
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

    // Unit body: 3D sphere.
    {
      const r = unit.unit.unitRadiusCollider.shot;
      const t = lineSphereIntersectionT(
        sx, sy, sz,
        ex, ey, ez,
        unit.transform.x, unit.transform.y, unit.transform.z,
        r,
      );
      if (t !== null && t < bestT) {
        bestT = t;
        found = true;
        _segHit.t = t;
        _segHit.x = sx + t * dx;
        _segHit.y = sy + t * dy;
        _segHit.z = sz + t * dz;
        _segHit.entityId = unit.id;
        _segHit.isMirror = false;
        _segHit.normalX = 0;
        _segHit.normalY = 0;
        _segHit.normalZ = 0;
        _segHit.panelIndex = -1;
      }
    }
  }

  // Buildings: 3D ray-vs-AABB.
  for (const bldg of cache.getBuildings()) {
    if (bldg.id === excludeId) continue;
    if (!bldg.building) continue;
    const hw = bldg.building.width / 2;
    const hh = bldg.building.height / 2;
    const bx = bldg.transform.x;
    const by = bldg.transform.y;
    const bd = bldg.building.depth;
    const t = rayBoxIntersectionT(
      sx, sy, sz,
      ex, ey, ez,
      bx - hw, by - hh, 0,
      bx + hw, by + hh, bd,
    );
    if (t !== null && t < bestT) {
      bestT = t;
      found = true;
      _segHit.t = t;
      _segHit.x = sx + t * dx;
      _segHit.y = sy + t * dy;
      _segHit.z = sz + t * dz;
      _segHit.entityId = bldg.id;
      _segHit.isMirror = false;
      _segHit.normalX = 0;
      _segHit.normalY = 0;
      _segHit.normalZ = 0;
      _segHit.panelIndex = -1;
    }
  }

  return found ? _segHit : null;
}

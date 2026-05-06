// Mirror-panel hit testing — shared by server beam tracing and
// projectile collision. Computes the closest hit of a 3D ray segment
// against a unit's reflective panels.
//
// The mirror is RIGID with the turret arm: yawing the assembly
// swings the panel sideways, pitching it swings the panel up/down.
// So the panel center is at arm's length out along the arm
// direction
//
//     a(α, β) = (cos α · cos β,  sin α · cos β,  sin β)
//
// from the turret pivot — pitch displaces the panel vertically AND
// pulls it horizontally toward the chassis as β → π/2. The panel
// NORMAL is also a(α, β) (panel face is perpendicular to the arm),
// and the panel rotates around its horizontal edge axis as pitch
// changes — that part of the math (handed to rayTiltedRectIntersectionT
// via `edge axis` + the implicit `normal × edge`) was already there.
// Pre-fix the pcx/pcy/pcz computation was the bug: panel offsetX was
// applied flat in XY and pcz was a fixed body-mid Z, so a panel
// pitched up still collided where it was when horizontal.

import { rayTiltedRectIntersectionT } from '../../math';
import type { CachedMirrorPanel } from '../../../types/sim';
import { getMirrorArmDirection, getMirrorPanelCenter, getMirrorUprightPivot } from '../mirrorPanelCache';

export type MirrorPanelHit = {
  t: number;
  x: number;
  y: number;
  z: number;
  /** Panel normal at the hit point (3D, unit length). */
  normalX: number;
  normalY: number;
  normalZ: number;
  panelIndex: number;
};

const _result: MirrorPanelHit = {
  t: 0, x: 0, y: 0, z: 0,
  normalX: 0, normalY: 0, normalZ: 0,
  panelIndex: -1,
};
const _panelCenter = { x: 0, y: 0, z: 0 };
const _panelNormal = { x: 0, y: 0, z: 0 };
const _panelPivot = { x: 0, y: 0, z: 0 };

/**
 * Find the closest mirror-panel hit on a single unit by a 3D ray
 * segment from (sx, sy, sz) → (ex, ey, ez). The returned object is
 * reused — copy out before re-calling.
 *
 * Each panel's normal in the world is constructed as
 *
 *     n = (cos α · cos β, sin α · cos β, sin β)
 *
 * where α = mirrorRot + panel.angle (yaw) and β = mirrorPitch (pitch).
 * The edge axis is the horizontal perpendicular to yaw; the up-in-plane
 * axis is implicitly n × edge so the panel rotates rigidly around its
 * edge as pitch increases.
 *
 * `excludePanelIndex` lets a beam skip the panel it just bounced off
 * (avoids self-intersection on the next ray segment). Pass -1 to test
 * every panel.
 *
 * `pivotOverride`, when provided, is the mirror turret's real
 * world-space joint. Callers pass it on slope-aware units so the
 * panel collision plane uses the same turret attachment point as the
 * aim solver and renderer.
 */
export function findClosestPanelHit(
  panels: readonly CachedMirrorPanel[],
  mirrorRot: number,
  mirrorPitch: number,
  unitX: number, unitY: number, unitGroundZ: number,
  sx: number, sy: number, sz: number,
  ex: number, ey: number, ez: number,
  excludePanelIndex: number,
  pivotOverride?: { x: number; y: number; z: number },
): MirrorPanelHit | null {
  if (panels.length === 0) return null;

  const cosRot = Math.cos(mirrorRot);
  const sinRot = Math.sin(mirrorRot);
  const perpX = -sinRot;
  const perpY = cosRot;

  let bestT = Infinity;
  let found = false;
  const dx = ex - sx, dy = ey - sy, dz = ez - sz;

  for (let pi = 0; pi < panels.length; pi++) {
    if (pi === excludePanelIndex) continue;
    const panel = panels[pi];

    // Panel center in world. The rigid arm starts at the turret
    // pivot and extends `armLength = offsetX` along the 3D arm
    // direction. Slope-aware callers provide the real turret joint;
    // legacy/fallback callers use the upright pivot formula.
    const armLength = panel.offsetX;
    if (pivotOverride) {
      _panelPivot.x = pivotOverride.x + perpX * panel.offsetY;
      _panelPivot.y = pivotOverride.y + perpY * panel.offsetY;
      _panelPivot.z = pivotOverride.z;
    } else {
      getMirrorUprightPivot(unitX, unitY, unitGroundZ, perpX, perpY, panel, _panelPivot);
    }
    getMirrorPanelCenter(
      _panelPivot.x, _panelPivot.y, _panelPivot.z,
      armLength, mirrorRot, mirrorPitch, _panelCenter,
    );
    const pcx = _panelCenter.x;
    const pcy = _panelCenter.y;
    const pcz = _panelCenter.z;

    // Yaw of the panel itself = turret yaw + panel's blueprint angle.
    const panelYaw = mirrorRot + panel.angle;

    // 3D normal = arm direction (panel face perpendicular to arm).
    // Shared with getMirrorPanelCenter so the hit-test normal can't
    // drift from the arm-extension formula it pairs with.
    getMirrorArmDirection(panelYaw, mirrorPitch, _panelNormal);
    const nx = _panelNormal.x;
    const ny = _panelNormal.y;
    const nz = _panelNormal.z;

    // Edge axis: horizontal perpendicular to panel-yaw (unaffected by
    // pitch, since pitch rotates around this axis).
    const edx = -Math.sin(panelYaw);
    const edy = Math.cos(panelYaw);
    const edz = 0;

    const halfH = (panel.topY - panel.baseY) / 2;

    const t = rayTiltedRectIntersectionT(
      sx, sy, sz, ex, ey, ez,
      pcx, pcy, pcz,
      nx, ny, nz,
      edx, edy, edz,
      panel.halfWidth, halfH,
    );
    if (t === null || t >= bestT) continue;

    bestT = t;
    found = true;
    _result.t = t;
    _result.x = sx + t * dx;
    _result.y = sy + t * dy;
    _result.z = sz + t * dz;
    _result.normalX = nx;
    _result.normalY = ny;
    _result.normalZ = nz;
    _result.panelIndex = pi;
  }

  return found ? _result : null;
}

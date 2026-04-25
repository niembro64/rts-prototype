// Mirror-panel hit testing — shared between server (DamageSystem),
// client (BeamPathResolver), and projectile collision. Computes the
// closest hit of a 3D ray segment against a unit's reflective panels,
// honoring both YAW (turret rotation) and PITCH (turret pitch) so the
// panel can redirect both horizontal and vertical components of an
// incoming beam / shot.

import { rayTiltedRectIntersectionT } from '../../math';
import type { CachedMirrorPanel } from '../../../types/sim';

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
 */
export function findClosestPanelHit(
  panels: readonly CachedMirrorPanel[],
  mirrorRot: number,
  mirrorPitch: number,
  unitX: number, unitY: number, unitGroundZ: number,
  sx: number, sy: number, sz: number,
  ex: number, ey: number, ez: number,
  excludePanelIndex: number,
): MirrorPanelHit | null {
  if (panels.length === 0) return null;

  const fwdX = Math.cos(mirrorRot);
  const fwdY = Math.sin(mirrorRot);
  const perpX = -fwdY;
  const perpY = fwdX;
  const cosPitch = Math.cos(mirrorPitch);
  const sinPitch = Math.sin(mirrorPitch);

  let bestT = Infinity;
  let found = false;
  const dx = ex - sx, dy = ey - sy, dz = ez - sz;

  for (let pi = 0; pi < panels.length; pi++) {
    if (pi === excludePanelIndex) continue;
    const panel = panels[pi];

    // Panel center in world: chassis + chassis-local offset, vertical
    // midpoint of (baseY, topY) above unit ground.
    const pcx = unitX + fwdX * panel.offsetX + perpX * panel.offsetY;
    const pcy = unitY + fwdY * panel.offsetX + perpY * panel.offsetY;
    const pcz = unitGroundZ + (panel.baseY + panel.topY) / 2;

    // Yaw of the panel itself = turret yaw + panel's blueprint angle.
    const panelYaw = mirrorRot + panel.angle;
    const yawCos = Math.cos(panelYaw);
    const yawSin = Math.sin(panelYaw);

    // 3D normal: yaw rotated then pitched up.
    const nx = yawCos * cosPitch;
    const ny = yawSin * cosPitch;
    const nz = sinPitch;

    // Edge axis: horizontal perpendicular to panel-yaw (unaffected by
    // pitch, since pitch rotates around this axis).
    const edx = -yawSin;
    const edy = yawCos;
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

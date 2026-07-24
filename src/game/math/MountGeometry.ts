// MountGeometry — single canonical "where does a turret physically
// sit on a unit?" helper.
//
// Both the authoritative sim and the client-side prediction paths
// call this. The renderer reaches the same answer via the three.js
// scene graph (unitGroup carries the world tilt; yawGroup inside
// carries the chassis yaw; turret meshes are positioned at the
// chassis-local mount). With the math centralized here, every
// consumer agrees on:
//
//   world_mount = unit_base + tilt · Ry_sim(yaw) · (offset.x, offset.y, mountHeight)
//
// — yaw INNER (around the chassis-local up axis = slope's up), tilt
// OUTER (in world frame). Same hierarchy the renderer encodes, so
// projectile spawn, beam origin, and the rendered turret base agree
// pixel-perfect on slopes.
//
// Flat ground is the easy case: applySurfaceTilt early-returns with
// the input vector unchanged, the math collapses to the legacy yaw-
// only path, and no work is wasted on the (large) flat majority of
// the map.

import { applySurfaceTilt } from '../sim/Terrain';

/** Full authoritative body orientation, sim-frame quaternion with yaw
 *  included. Present only for hosts whose unit-force attitude step owns
 *  a quaternion (hover, buoyant, attitude-simulated bodies). */
export type MountBodyOrientation = { x: number; y: number; z: number; w: number };

/** World position of a turret's mount on a tilted chassis.
 *
 *  - `unitBaseZ` is the unit's BASE altitude (sim z − sphere radius).
 *  - `cos`, `sin` are the chassis yaw's cosine and sine (cached
 *    upstream so callers iterating multiple turrets per unit don't
 *    redo the trig).
 *  - `offsetX`, `offsetY` are the chassis-local XY mount point on
 *    the (untilted) chassis surface.
 *  - `mountHeight` is the mount's height above the unit base in the
 *    chassis-local frame.
 *  - `surfaceN` is the surface tangent normal at the unit footprint
 *    (sim coords, +Z up).
 *  - `orientation`, when present, is the host's full authoritative body
 *    quaternion. The renderer's chassis parent IS this quaternion (yaw
 *    included), so mounts on such hosts must ride it too — the yaw+tilt
 *    path detaches emissions from the drawn turret whenever body
 *    attitude diverges from the surface normal (steep slopes, buoyancy).
 */
const _tiltScratch = { x: 0, y: 0, z: 0 };

export function getTurretWorldMount(
  unitX: number, unitY: number, unitBaseZ: number,
  cos: number, sin: number,
  offsetX: number, offsetY: number, mountHeight: number,
  surfaceN: { nx: number; ny: number; nz: number },
  orientation?: MountBodyOrientation | null,
  out?: { x: number; y: number; z: number },
): { x: number; y: number; z: number } {
  if (orientation !== undefined && orientation !== null) {
    // q · v: rotate the raw chassis-local mount (yaw is inside q).
    const { x: qx, y: qy, z: qz, w: qw } = orientation;
    const tx = 2 * (qy * mountHeight - qz * offsetY);
    const ty = 2 * (qz * offsetX - qx * mountHeight);
    const tz = 2 * (qx * offsetY - qy * offsetX);
    const rx = offsetX + qw * tx + qy * tz - qz * ty;
    const ry = offsetY + qw * ty + qz * tx - qx * tz;
    const rz = mountHeight + qw * tz + qx * ty - qy * tx;
    if (out !== undefined) {
      out.x = unitX + rx;
      out.y = unitY + ry;
      out.z = unitBaseZ + rz;
      return out;
    }
    return { x: unitX + rx, y: unitY + ry, z: unitBaseZ + rz };
  }
  // Yaw INNER — rotate the chassis-local mount XY by the chassis
  // facing first; mountHeight stays along chassis-local +Z.
  const yawedX = cos * offsetX - sin * offsetY;
  const yawedY = sin * offsetX + cos * offsetY;
  // Tilt OUTER — apply the surface-normal rotation in world frame.
  const tilted = applySurfaceTilt(yawedX, yawedY, mountHeight, surfaceN, _tiltScratch);
  if (out !== undefined) {
    out.x = unitX + tilted.x;
    out.y = unitY + tilted.y;
    out.z = unitBaseZ + tilted.z;
    return out;
  }
  return {
    x: unitX + tilted.x,
    y: unitY + tilted.y,
    z: unitBaseZ + tilted.z,
  };
}

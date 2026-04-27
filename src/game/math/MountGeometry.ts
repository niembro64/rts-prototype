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
 */
export function getTurretWorldMount(
  unitX: number, unitY: number, unitBaseZ: number,
  cos: number, sin: number,
  offsetX: number, offsetY: number, mountHeight: number,
  surfaceN: { nx: number; ny: number; nz: number },
): { x: number; y: number; z: number } {
  // Yaw INNER — rotate the chassis-local mount XY by the chassis
  // facing first; mountHeight stays along chassis-local +Z.
  const yawedX = cos * offsetX - sin * offsetY;
  const yawedY = sin * offsetX + cos * offsetY;
  // Tilt OUTER — apply the surface-normal rotation in world frame.
  const tilted = applySurfaceTilt(yawedX, yawedY, mountHeight, surfaceN);
  return {
    x: unitX + tilted.x,
    y: unitY + tilted.y,
    z: unitBaseZ + tilted.z,
  };
}

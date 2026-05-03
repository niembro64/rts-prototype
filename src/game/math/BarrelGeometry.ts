// BarrelGeometry — single source of truth for "where does a shot come out
// of a turret?" in full 3D.
//
// Every call site that needed the 3D barrel tip used to unroll the same
// transform chain (unit yaw → turret yaw → turret pitch → per-barrel orbit
// offset) by hand, and each place did it slightly differently. This module
// folds the whole chain into one pure function that the sim's spawn path,
// the sim's beam tracer, and the client's beam predictor all call — so
// projectile origin, beam origin, ballistic target math, and the rendered
// barrel centerline stay locked to the same numbers.
//
// The firing-frame forward vector lines up 1-to-1 with the renderer's
// nested pitchGroup hierarchy:
//   forward = barrel axis (the direction a shot leaves in)
// Multi-barrel turrets still render and spin their physical barrel clusters,
// but authoritative firing uses the shared center point between the barrels.
// That keeps projectile, beam, and ballistic math stable while the visual
// round-robin can continue independently.

import { TURRET_HEIGHT } from '../../config';
import type { TurretConfig } from '../sim/types';

/** X/Z footprint of the spherical turret head as a fraction of the
 *  host unit's body radius. Mirrors the constant in Render3DEntities
 *  so the renderer (which draws the sphere) and the sim (which
 *  computes shot spawn positions) agree on where the head ENDS and
 *  the barrel BEGINS. */
export const TURRET_HEAD_FOOTPRINT_FRAC = 0.42;

/** Radius of the spherical turret head for a unit of the given body
 *  radius. Floored to TURRET_HEIGHT / 2 so very small units still get
 *  a visible head sphere. A turret blueprint can override this with
 *  its own `bodyRadius` field — passing the config lets the renderer
 *  prefer the per-turret value when present. */
export function getTurretHeadRadius(
  unitBodyRadius: number,
  config?: TurretConfig,
): number {
  if (config?.bodyRadius !== undefined && config.bodyRadius > 0) {
    return config.bodyRadius;
  }
  return Math.max(unitBodyRadius * TURRET_HEAD_FOOTPRINT_FRAC, TURRET_HEIGHT / 2);
}

/** Same as getTurretHeadRadius but takes the per-turret bodyRadius
 *  value directly — for blueprint-side callers that only have a
 *  `bodyRadius?: number` field rather than a full TurretConfig. */
export function turretHeadRadiusFromBodyRadius(
  unitBodyRadius: number,
  turretBodyRadius: number | undefined,
): number {
  if (turretBodyRadius !== undefined && turretBodyRadius > 0) return turretBodyRadius;
  return Math.max(unitBodyRadius * TURRET_HEAD_FOOTPRINT_FRAC, TURRET_HEIGHT / 2);
}

/** World-space 3D position + unit-vector firing direction for a single
 *  barrel. Every fire path returns one of these per shot. */
export type BarrelEndpoint = {
  x: number;
  y: number;
  z: number;
  dirX: number;
  dirY: number;
  dirZ: number;
};

/** How many physical barrels a turret config has. Single-barrel and
 *  force-field emitters report 1; gatlings and cone shotguns report
 *  their `barrelCount`. Used by the firing round-robin and visual
 *  metadata to pick barrelIndex = fireCount mod N. Authoritative
 *  multi-barrel shots still spawn from the cluster centerline. */
export function countBarrels(config: TurretConfig): number {
  const b = config.barrel;
  if (!b) return 1;
  if (b.type === 'simpleSingleBarrel') return 1;
  if (b.type === 'complexSingleEmitter') return 1;
  return b.barrelCount;
}

/** Compute the 3D tip position and firing direction for a specific
 *  barrel on a turret.
 *
 *  mountX/Y/Z — world-space turret pivot (weapon's cached worldPos +
 *    unit-ground + muzzle-height). This is where every barrel's
 *    transform chain starts.
 *  turretYaw  — absolute world yaw of the turret (radians).
 *  turretPitch — elevation above horizontal (radians; +π/2 = straight up).
 *  config     — the turret blueprint; emitters fire from the mount,
 *               barrel configs fire from their centerline tip.
 *  unitBodyRadius — host unit's body radius (`Unit.bodyRadius`); the
 *               authored `barrelLength` is a fraction of it.
 *  barrelIndex — retained for call-site compatibility and fire metadata.
 *                Multi-barrel physics no longer varies by index; shots
 *                come from the center point between the barrels.
 *  spinAngle   — retained for compatibility with callers that know about
 *                visual gatling spin. Authoritative firing ignores it.
 */
export function getBarrelTip(
  mountX: number, mountY: number, mountZ: number,
  turretYaw: number, turretPitch: number,
  config: TurretConfig,
  unitBodyRadius: number,
  _barrelIndex: number = 0,
  _spinAngle: number = 0,
): BarrelEndpoint {
  const yawCos = Math.cos(turretYaw);
  const yawSin = Math.sin(turretYaw);
  const pitchCos = Math.cos(turretPitch);
  const pitchSin = Math.sin(turretPitch);

  // Firing frame. Orthonormal basis in sim world coords.
  const fwdX = yawCos * pitchCos;
  const fwdY = yawSin * pitchCos;
  const fwdZ = pitchSin;

  const b = config.barrel;
  if (!b || b.type === 'complexSingleEmitter') {
    // Force-field emitters and bodies with no barrel at all emit from
    // the turret pivot itself.
    return {
      x: mountX, y: mountY, z: mountZ,
      dirX: fwdX, dirY: fwdY, dirZ: fwdZ,
    };
  }

  // The barrel attaches at the CENTER of the spherical turret head.
  // Tip is `barrelLen` from the mount along the firing axis — the
  // visible cylinder runs from the head's interior outward through
  // the surface. (Anything inside the sphere is occluded by the
  // head mesh, so visually you only see the protruding portion.)
  const barrelLen = unitBodyRadius * b.barrelLength;

  // Single-barrel and multi-barrel weapons both fire from the centerline.
  // The renderer owns the visible per-barrel offsets and spin; the sim owns
  // one stable muzzle point for projectile, beam, and aim math.
  return {
    x: mountX + fwdX * barrelLen,
    y: mountY + fwdY * barrelLen,
    z: mountZ + fwdZ * barrelLen,
    dirX: fwdX, dirY: fwdY, dirZ: fwdZ,
  };
}

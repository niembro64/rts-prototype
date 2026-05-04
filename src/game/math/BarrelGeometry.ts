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
import type { BarrelShape } from '@/types/blueprints';
import type { ActiveProjectileShot, ShotConfig, TurretConfig } from '../sim/types';

export const TURRET_BARREL_MIN_DIAMETER = 2;

/** Radius of the spherical turret head. Read directly from the
 *  turret blueprint's `bodyRadius`; turrets are unit-agnostic by
 *  contract, so the host unit's body radius does NOT factor in.
 *  Throws if the turret config is missing `bodyRadius` — every
 *  turret blueprint is required to declare it. */
type TurretRadiusSource = { id?: string; bodyRadius?: number };
type TurretBarrelSource = TurretRadiusSource & { barrel?: BarrelShape };
type BarrelShotSource = TurretBarrelSource & { shot: ShotConfig | ActiveProjectileShot };

export function getTurretHeadRadius(config: TurretRadiusSource): number {
  const r = config.bodyRadius;
  if (r === undefined || r <= 0) {
    const id = config.id ?? 'unknown-source';
    throw new Error(
      `Turret config '${id}' must define a positive bodyRadius`,
    );
  }
  return Math.max(r, TURRET_HEIGHT / 2);
}

/** Same as getTurretHeadRadius but takes the per-turret bodyRadius
 *  value directly — for blueprint-side callers that only have a
 *  `bodyRadius?: number` field rather than a full TurretConfig. */
export function turretHeadRadiusFromBodyRadius(
  turretBodyRadius: number | undefined,
): number {
  if (turretBodyRadius === undefined || turretBodyRadius <= 0) {
    throw new Error('Turret bodyRadius must be a positive number');
  }
  return Math.max(turretBodyRadius, TURRET_HEIGHT / 2);
}

/** Center-to-tip length of the visible/authoritative barrel. The
 *  authored `barrelLength` is the protruding length beyond the head
 *  surface, expressed as a fraction of the turret head radius. The
 *  actual cylinder and muzzle tip start at the head center, so add
 *  one radius to reach the surface first.
 *
 *  `barrelLength <= 0` remains the explicit "no visible barrel"
 *  contract used by mirror-style emitters. */
export function getTurretBarrelCenterToTipLength(
  config: TurretBarrelSource,
): number {
  const barrel = config.barrel;
  if (!barrel || barrel.type === 'complexSingleEmitter' || barrel.barrelLength <= 0) {
    return 0;
  }
  return getTurretHeadRadius(config) * (1 + barrel.barrelLength);
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
export function countBarrels(config: Pick<TurretConfig, 'barrel'>): number {
  const b = config.barrel;
  if (!b) return 1;
  if (b.type === 'simpleSingleBarrel') return 1;
  if (b.type === 'complexSingleEmitter') return 1;
  return b.barrelCount;
}

export function getTurretBarrelDiameter(
  config: BarrelShotSource,
): number {
  const barrel = config.barrel;
  if (!barrel || barrel.type === 'complexSingleEmitter') return 0;

  const shot = config.shot;
  const lineShotWidth = shot.type === 'beam' || shot.type === 'laser'
    ? shot.width
    : undefined;
  const diameter =
    (barrel.type === 'simpleSingleBarrel' ? lineShotWidth : undefined)
    ?? barrel.barrelThickness
    ?? TURRET_BARREL_MIN_DIAMETER;
  return Math.max(diameter, TURRET_BARREL_MIN_DIAMETER);
}

/** Compute the 3D tip position and firing direction for a specific
 *  barrel on a turret. Unit-agnostic: the host unit's body radius
 *  is intentionally NOT a parameter. Barrel dimensions are derived
 *  from the turret blueprint's own `bodyRadius`, so a turret of a
 *  given blueprint fires from the same offset on every host that
 *  mounts it.
 *
 *  mountX/Y/Z — world-space turret pivot (weapon's cached worldPos +
 *    unit-ground + muzzle-height).
 *  turretYaw  — absolute world yaw of the turret (radians).
 *  turretPitch — elevation above horizontal (radians; +π/2 = up).
 *  config     — the turret blueprint; emitters fire from the mount,
 *               barrel configs fire from the centerline tip.
 *  barrelIndex — retained for call-site compatibility and fire metadata.
 *                Multi-barrel physics no longer varies by index; shots
 *                come from the center point between the barrels.
 *  spinAngle   — retained for compatibility with callers that know about
 *                visual gatling spin. Authoritative firing ignores it.
 */
export function getBarrelTip(
  mountX: number, mountY: number, mountZ: number,
  turretYaw: number, turretPitch: number,
  config: BarrelShotSource,
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
  // the surface. (Anything inside the sphere is occluded by the head
  // mesh, so visually you only see the protruding portion.)
  //
  // The renderer uses this exact helper when building the cylinder, so
  // the muzzle stays at the visible barrel tip.
  const barrelLen = getTurretBarrelCenterToTipLength(config);

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

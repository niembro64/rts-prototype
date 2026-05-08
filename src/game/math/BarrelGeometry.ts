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
// Multi-barrel turrets use the same per-barrel local offsets as
// TurretMesh3D, so the barrelIndex carried in projectile spawn events is
// real muzzle metadata rather than just visual cadence.

import type { BarrelShape } from '@/types/blueprints';
import type { ActiveProjectileShot, ShotConfig, TurretConfig } from '../sim/types';
import { isLineShot } from '../sim/types';
import { magnitude3 } from './MathHelpers';

export const TURRET_BARREL_MIN_DIAMETER = 2;

/** Maximum barrel orbit radius — fractions of the turret body sphere
 *  radius — applied to authored blueprint orbit values so a barrel
 *  cluster cannot fan outside its own turret silhouette. All muzzle,
 *  render, HUD, and debris paths use the helpers below so the same
 *  blueprint geometry is used everywhere. */
const BARREL_ORBIT_CLAMP_FRAC = {
  /** simpleMultiBarrel — single orbit ring of parallel barrels. */
  parallel: 0.45,
  /** coneMultiBarrel — base end of the diverging cone. */
  coneBase: 0.35,
  /** coneMultiBarrel — tip end of the diverging cone (when the
   *  blueprint doesn't author `tipOrbit` explicitly and we derive
   *  it from spread + length). */
  coneTip: 0.9,
} as const;

/** Radius of the spherical turret body. Read directly from the turret
 *  blueprint's `radius.body`; turrets are unit-agnostic by contract,
 *  so the host unit's body radius does NOT factor in. */
type TurretRadiusSource = { id?: string; radius?: { body?: number } };
type TurretBarrelSource = TurretRadiusSource & { barrel?: BarrelShape };
type BarrelShotSource = TurretBarrelSource & {
  shot?: ShotConfig | ActiveProjectileShot;
  spread?: TurretConfig['spread'];
};

function getTurretBodyRadius(config: TurretRadiusSource): number {
  const r = config.radius?.body;
  if (r === undefined || r <= 0) {
    const id = config.id ?? 'unknown-source';
    throw new Error(
      `Turret config '${id}' must define a positive radius.body`,
    );
  }
  return r;
}

/** Legacy name retained for the existing turret mesh/HUD vocabulary:
 *  the visible turret "head" is the same sphere as `radius.body`. */
export function getTurretHeadRadius(config: TurretRadiusSource): number {
  return getTurretBodyRadius(config);
}

export function turretBodyRadiusFromRadius(
  radius: TurretRadiusSource['radius'] | undefined,
): number {
  const body = radius?.body;
  if (body === undefined || body <= 0) {
    throw new Error('Turret radius.body must be a positive number');
  }
  return body;
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
 *  their `barrelCount`. Used by the firing round-robin to pick
 *  barrelIndex = fireCount mod N. */
export function countBarrels(config: Pick<TurretConfig, 'barrel'>): number {
  const b = config.barrel;
  if (!b) return 1;
  if (b.type === 'simpleSingleBarrel') return 1;
  if (b.type === 'complexSingleEmitter') return 1;
  return b.barrelCount;
}

/** Per-barrel orbit angle around the firing axis: barrels are evenly
 *  spaced on a circle, half-step offset so the i=0 barrel is NOT on
 *  any cardinal axis (which would visually align with the chassis edge
 *  at one orientation). Same convention used by the renderer's
 *  YZ-plane multi-barrel layout AND the sim's firing-frame barrel-tip
 *  computation; centralizing keeps a future change to the spacing
 *  rule (e.g. anti-aliased sub-step jitter) atomic across both. */
export function getBarrelOrbitAngle(idx: number, n: number): number {
  return ((idx + 0.5) / n) * Math.PI * 2;
}

function clampBarrelOrbitRadius(
  authoredRadiusFrac: number,
  turretBodyRadius: number,
  clampFrac: number,
): number {
  return Math.min(
    authoredRadiusFrac * turretBodyRadius,
    turretBodyRadius * clampFrac,
  );
}

export function getSimpleMultiBarrelOrbitRadius(
  barrel: Extract<BarrelShape, { type: 'simpleMultiBarrel' }>,
  turretBodyRadius: number,
): number {
  return clampBarrelOrbitRadius(
    barrel.orbitRadius,
    turretBodyRadius,
    BARREL_ORBIT_CLAMP_FRAC.parallel,
  );
}

export function getConeBarrelBaseOrbitRadius(
  barrel: Extract<BarrelShape, { type: 'coneMultiBarrel' }>,
  turretBodyRadius: number,
): number {
  return clampBarrelOrbitRadius(
    barrel.baseOrbit,
    turretBodyRadius,
    BARREL_ORBIT_CLAMP_FRAC.coneBase,
  );
}

export function getConeBarrelTipOrbitRadius(
  barrel: Extract<BarrelShape, { type: 'coneMultiBarrel' }>,
  turretBodyRadius: number,
  barrelLen: number,
  spreadAngle: number | undefined,
): number {
  if (barrel.tipOrbit !== undefined) {
    return barrel.tipOrbit * turretBodyRadius;
  }
  return Math.min(
    getConeBarrelBaseOrbitRadius(barrel, turretBodyRadius)
      + barrelLen * Math.tan((spreadAngle ?? Math.PI / 5) / 2),
    turretBodyRadius * BARREL_ORBIT_CLAMP_FRAC.coneTip,
  );
}

export function getTurretBarrelDiameter(
  config: BarrelShotSource,
): number {
  const barrel = config.barrel;
  if (!barrel || barrel.type === 'complexSingleEmitter') return 0;

  const shot = config.shot;
  const lineShotWidth = shot && isLineShot(shot) ? shot.width : undefined;
  const diameter =
    (barrel.type === 'simpleSingleBarrel' ? lineShotWidth : undefined)
    ?? barrel.barrelThickness
    ?? TURRET_BARREL_MIN_DIAMETER;
  return Math.max(diameter, TURRET_BARREL_MIN_DIAMETER);
}

/** Compute the 3D tip position and firing direction for a specific
 *  barrel on a turret. Unit-agnostic: the host unit's body radius
 *  is intentionally NOT a parameter. Barrel dimensions are derived
 *  from the turret blueprint's own `radius.body`, so a turret of a
 *  given blueprint fires from the same offset on every host that
 *  mounts it.
 *
 *  mountX/Y/Z — world-space turret pivot (weapon's cached worldPos +
 *    unit-ground + muzzle-height).
 *  turretYaw  — absolute world yaw of the turret (radians).
 *  turretPitch — elevation above horizontal (radians; +π/2 = up).
 *  config     — the turret blueprint; emitters fire from the mount,
 *               barrel configs fire from the indexed barrel tip.
 *  barrelIndex — physical barrel in the authored cluster. The same
 *                index is serialized to clients for spawn correction.
 *  spinAngle   — optional barrel-cluster rotation around the firing
 *                axis. Defaults to the unspun authored cluster.
 */
export function getBarrelTip(
  mountX: number, mountY: number, mountZ: number,
  turretYaw: number, turretPitch: number,
  config: BarrelShotSource,
  barrelIndex: number = 0,
  spinAngle: number = 0,
): BarrelEndpoint {
  const yawCos = Math.cos(turretYaw);
  const yawSin = Math.sin(turretYaw);
  const pitchCos = Math.cos(turretPitch);
  const pitchSin = Math.sin(turretPitch);

  // Firing frame. Orthonormal basis in sim world coords.
  const fwdX = yawCos * pitchCos;
  const fwdY = yawSin * pitchCos;
  const fwdZ = pitchSin;
  const upX = -yawCos * pitchSin;
  const upY = -yawSin * pitchSin;
  const upZ = pitchCos;
  const sideX = -yawSin;
  const sideY = yawCos;
  const sideZ = 0;

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

  if (b.type === 'simpleSingleBarrel') {
    return {
      x: mountX + fwdX * barrelLen,
      y: mountY + fwdY * barrelLen,
      z: mountZ + fwdZ * barrelLen,
      dirX: fwdX, dirY: fwdY, dirZ: fwdZ,
    };
  }

  const n = Math.max(1, b.barrelCount);
  const idx = ((Math.floor(barrelIndex) % n) + n) % n;
  const orbitAngle = getBarrelOrbitAngle(idx, n);
  const spinCos = Math.cos(spinAngle);
  const spinSin = Math.sin(spinAngle);
  let baseOrbitR: number;
  let tipOrbitR: number;

  if (b.type === 'simpleMultiBarrel') {
    baseOrbitR = tipOrbitR = getSimpleMultiBarrelOrbitRadius(
      b,
      getTurretHeadRadius(config),
    );
  } else {
    const turretBodyRadius = getTurretHeadRadius(config);
    baseOrbitR = getConeBarrelBaseOrbitRadius(b, turretBodyRadius);
    tipOrbitR = getConeBarrelTipOrbitRadius(
      b,
      turretBodyRadius,
      barrelLen,
      config.spread?.angle,
    );
  }

  const cosA = Math.cos(orbitAngle);
  const sinA = Math.sin(orbitAngle);
  const baseLocalY = cosA * baseOrbitR;
  const baseLocalZ = sinA * baseOrbitR;
  const tipLocalY = cosA * tipOrbitR;
  const tipLocalZ = sinA * tipOrbitR;
  const baseY = baseLocalY * spinCos - baseLocalZ * spinSin;
  const baseZ = baseLocalY * spinSin + baseLocalZ * spinCos;
  const tipY = tipLocalY * spinCos - tipLocalZ * spinSin;
  const tipZ = tipLocalY * spinSin + tipLocalZ * spinCos;

  const x = mountX + fwdX * barrelLen + upX * tipY + sideX * tipZ;
  const y = mountY + fwdY * barrelLen + upY * tipY + sideY * tipZ;
  const z = mountZ + fwdZ * barrelLen + upZ * tipY + sideZ * tipZ;
  let dirX = fwdX * barrelLen + upX * (tipY - baseY) + sideX * (tipZ - baseZ);
  let dirY = fwdY * barrelLen + upY * (tipY - baseY) + sideY * (tipZ - baseZ);
  let dirZ = fwdZ * barrelLen + upZ * (tipY - baseY) + sideZ * (tipZ - baseZ);
  const dirLen = magnitude3(dirX, dirY, dirZ);
  if (dirLen > 1e-6) {
    dirX /= dirLen;
    dirY /= dirLen;
    dirZ /= dirLen;
  } else {
    dirX = fwdX;
    dirY = fwdY;
    dirZ = fwdZ;
  }

  return {
    x,
    y,
    z,
    dirX,
    dirY,
    dirZ,
  };
}

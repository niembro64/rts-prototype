// BarrelGeometry — single source of truth for "where does a shot come out
// of a turret?" in full 3D.
//
// Every call site that needed the 3D barrel tip used to unroll the same
// transform chain (unit yaw → turret yaw → turret pitch → per-barrel orbit
// offset) by hand, and each place did it slightly differently. This module
// folds the whole chain into one pure function that the sim's spawn path,
// the sim's beam tracer, and the client's beam predictor all call — so
// projectile origin, beam origin, ballistic target math, and the rendered
// barrel geometry stay locked to the same numbers.
//
// The firing-frame basis (forward / up / right) lines up 1-to-1 with the
// renderer's nested pitchGroup → spinGroup hierarchy:
//   forward = barrel axis (the direction a shot leaves in)
//   up      = the "vertical" of the firing frame (world-Z when pitch = 0)
//   right   = the horizontal lateral axis (never has a Z component — it's
//             shared between all pitches because yaw rotates around world-Z
//             and pitch rotates around this same lateral axis).
// A barrel's orbit offset in a multi-barrel cluster is expressed in
// (up, right) components, so adding spin is a single cos/sin rotation of
// the angular position without touching the basis.

import { TURRET_HEIGHT } from '../../config';
import type { TurretConfig } from '../sim/types';

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
 *  config     — the turret blueprint; the barrel type drives which shape
 *               of per-barrel offset we apply.
 *  unitScale  — unit radius that `barrelLength`, `orbitRadius`, and
 *               `baseOrbit` are fractions of.
 *  barrelIndex — which barrel in the cluster (0..N-1). Defaulting to 0
 *                gives a stable "reference barrel" for single-shot
 *                weapons and for pre-fire geometry queries like the
 *                ballistic solver's barrel-tip reference point.
 *  spinAngle   — gatling angle (radians); adds to the barrel's fixed
 *                angular slot when picking orbit direction. Default 0
 *                means "use the barrel's rest position in the cluster".
 */
export function getBarrelTip(
  mountX: number, mountY: number, mountZ: number,
  turretYaw: number, turretPitch: number,
  config: TurretConfig,
  unitScale: number,
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
  const rightX = -yawSin;
  const rightY = yawCos;
  // rightZ is always 0 — yaw rotates about vertical, and pitch shares this
  // lateral axis, so "right" is the horizontal perpendicular regardless of
  // pitch.

  const b = config.barrel;
  if (!b || b.type === 'complexSingleEmitter') {
    // Force-field emitters and bodies with no barrel at all emit from
    // the turret pivot itself.
    return {
      x: mountX, y: mountY, z: mountZ,
      dirX: fwdX, dirY: fwdY, dirZ: fwdZ,
    };
  }

  const barrelLen = unitScale * b.barrelLength;

  if (b.type === 'simpleSingleBarrel') {
    return {
      x: mountX + fwdX * barrelLen,
      y: mountY + fwdY * barrelLen,
      z: mountZ + fwdZ * barrelLen,
      dirX: fwdX, dirY: fwdY, dirZ: fwdZ,
    };
  }

  // Multi-barrel: compute the barrel's angular slot in the cluster.
  const n = b.barrelCount;
  const angle = ((barrelIndex + 0.5) / n) * Math.PI * 2 + spinAngle;
  const orbCos = Math.cos(angle);
  const orbSin = Math.sin(angle);

  if (b.type === 'simpleMultiBarrel') {
    // Parallel gatling. All barrels fire in the same direction (forward);
    // each tip is offset perpendicular to the firing axis by orbitR.
    const orbitR = b.orbitRadius * unitScale;
    const offUp = orbitR * orbCos;
    const offRight = orbitR * orbSin;
    return {
      x: mountX + fwdX * barrelLen + upX * offUp + rightX * offRight,
      y: mountY + fwdY * barrelLen + upY * offUp + rightY * offRight,
      z: mountZ + fwdZ * barrelLen + upZ * offUp,  // rightZ is 0
      dirX: fwdX, dirY: fwdY, dirZ: fwdZ,
    };
  }

  // coneMultiBarrel (shotgun). Each barrel runs from a `baseOrbit`-radius
  // point on the near face to a `tipOrbit`-radius point on the far face,
  // so each barrel's own axis tilts outward and a shot from barrel i
  // comes out pointing along that tilted axis, not forward.
  const baseOrbitR = b.baseOrbit * unitScale;
  // Tip orbit grows by `len · tan(halfSpread)` and clamps to the same
  // TURRET_HEIGHT * 0.9 ceiling the 3D renderer uses, so the physically-
  // spawned pellet emerges from the exact spot the visible barrel ends.
  const spreadHalf = (config.spread?.angle ?? Math.PI / 5) / 2;
  const tipOrbitR = Math.min(
    baseOrbitR + barrelLen * Math.tan(spreadHalf),
    TURRET_HEIGHT * 0.9,
  );

  const tipUp = tipOrbitR * orbCos;
  const tipRight = tipOrbitR * orbSin;
  const tipX = mountX + fwdX * barrelLen + upX * tipUp + rightX * tipRight;
  const tipY = mountY + fwdY * barrelLen + upY * tipUp + rightY * tipRight;
  const tipZ = mountZ + fwdZ * barrelLen + upZ * tipUp;

  // Barrel direction = (tip − base) normalized. `base` sits at
  // mount + baseOrbitR · (cosA·up + sinA·right); the subtraction keeps
  // only the forward-plus-Δorbit components.
  const deltaOrbit = tipOrbitR - baseOrbitR;
  const dUp = deltaOrbit * orbCos;
  const dRight = deltaOrbit * orbSin;
  const rawDirX = fwdX * barrelLen + upX * dUp + rightX * dRight;
  const rawDirY = fwdY * barrelLen + upY * dUp + rightY * dRight;
  const rawDirZ = fwdZ * barrelLen + upZ * dUp;
  const mag = Math.hypot(rawDirX, rawDirY, rawDirZ);
  const inv = mag > 1e-6 ? 1 / mag : 0;

  return {
    x: tipX, y: tipY, z: tipZ,
    dirX: rawDirX * inv,
    dirY: rawDirY * inv,
    dirZ: rawDirZ * inv,
  };
}

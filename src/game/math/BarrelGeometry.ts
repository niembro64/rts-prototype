// BarrelGeometry — shared visual barrel layout in full 3D.
//
// Shared barrel dimensions and multi-barrel layout rules used by the
// renderer and visual helpers.
//
// Multi-barrel turrets use the same per-barrel local offsets as
// TurretMesh3D, so barrelIndex remains meaningful visual cadence metadata.

import type { BarrelShape } from '@/types/blueprints';
import type { ActiveProjectileShot, EmissionConfig } from '../sim/types';
import { isProjectileShot, isRayConfig, isRocketLikeShot } from '../sim/types';

export const TURRET_BARREL_MIN_DIAMETER = 2;

/** Maximum barrel orbit radius — fractions of the turret body sphere
 *  radius — applied to authored blueprint orbit values so a barrel
 *  cluster cannot fan outside its host-authored silhouette. Render, HUD, and
 *  collision paths use the helpers below so the same
 *  presentation geometry is used everywhere. */
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

/** Radius of the spherical turret head authored by this specific host mount. */
type TurretRadiusSource = { headRadius?: number | null };
type TurretBarrelSource = TurretRadiusSource & { barrel?: BarrelShape | null };

function getTurretBodyRadius(config: TurretRadiusSource): number {
  const body = config.headRadius;
  return typeof body === 'number' && body > 0 ? body : 0;
}

/** Legacy name retained for the existing turret mesh/HUD vocabulary.
 *  Returns 0 when `headRadius` is `null` — the explicit "draw no body
 *  sphere" signal (the head mesh is skipped and barrels, which pivot/scale
 *  off this radius, collapse to nothing). A positive number is the drawn
 *  sphere's world radius. */
export function getTurretHeadRadius(config: TurretRadiusSource): number {
  return getTurretBodyRadius(config);
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
  if (
    !barrel ||
    barrel.type === 'complexSingleEmitter' ||
    barrel.type === 'shieldPanelEmitter' ||
    barrel.barrelLength <= 0
  ) {
    return 0;
  }
  return getTurretHeadRadius(config) * (1 + barrel.barrelLength);
}

/** Per-barrel orbit angle around the firing axis. Lane zero begins at the
 * fixed top firing position; as the cluster rotates, every following barrel
 * passes through that same position. Weapon cadence is intentionally not
 * phase-locked to this presentation angle. */
export function getBarrelOrbitAngle(idx: number, n: number): number {
  return (idx / n) * Math.PI * 2;
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

/** Distance between a multi-barrel cluster's rotating axis and its one fixed
 * firing socket. The renderer lowers the spin axis by this amount, leaving
 * the top barrel at the turret's centered QueryWeapon muzzle. */
export function getMultiBarrelFiringOrbitRadius(
  barrel: Extract<BarrelShape, { type: 'simpleMultiBarrel' | 'coneMultiBarrel' }>,
  turretBodyRadius: number,
  barrelLen: number,
  spreadAngle: number | undefined,
): number {
  return barrel.type === 'simpleMultiBarrel'
    ? getSimpleMultiBarrelOrbitRadius(barrel, turretBodyRadius)
    : getConeBarrelTipOrbitRadius(barrel, turretBodyRadius, barrelLen, spreadAngle);
}

export function getTurretBarrelDiameter(
  presentation: TurretBarrelSource,
  shot: EmissionConfig | ActiveProjectileShot | null | undefined,
): number {
  const barrel = presentation.barrel;
  if (
    !barrel ||
    barrel.type === 'complexSingleEmitter' ||
    barrel.type === 'shieldPanelEmitter'
  ) {
    return 0;
  }

  // Shots and rockets: the barrel cylinder ALWAYS inherits its width from the
  // munition it fires — it is never authored. Any `barrelThickness` on a
  // shot/rocket turret is intentionally ignored. A rocket reads 1.5x its
  // visual radius so the launch tube looks chunkier than the projectile.
  if (shot !== null && shot !== undefined && isProjectileShot(shot)) {
    const width = shot.radius.other * 2 * (isRocketLikeShot(shot) ? 1.5 : 1);
    return Math.max(width, TURRET_BARREL_MIN_DIAMETER);
  }
  // Rays (beams/lasers): width comes from the ray emission, or an explicit
  // `barrelThickness` override on the cone barrel.
  const lineShotWidth = shot !== null && shot !== undefined && isRayConfig(shot) ? shot.width : undefined;
  const diameter = barrel.barrelThickness ?? lineShotWidth ?? TURRET_BARREL_MIN_DIAMETER;
  return Math.max(diameter, TURRET_BARREL_MIN_DIAMETER);
}

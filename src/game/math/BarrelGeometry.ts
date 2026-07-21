// BarrelGeometry — shared visual barrel layout in full 3D.
//
// Shared barrel dimensions and multi-barrel layout rules used by the
// renderer and visual helpers.
//
// Multi-barrel turrets use the same per-barrel local offsets as
// TurretMesh3D, so barrelIndex remains meaningful visual cadence metadata.

import type { BarrelShape } from '@/types/blueprints';
import type { ActiveProjectileShot, EmissionConfig, TurretConfig } from '../sim/types';
import { isRayConfig, isProjectileShot, isRocketLikeShot } from '../sim/types';

export const TURRET_BARREL_MIN_DIAMETER = 2;

/** Maximum barrel orbit radius — fractions of the turret body sphere
 *  radius — applied to authored blueprint orbit values so a barrel
 *  cluster cannot fan outside its own turret silhouette. Render, HUD,
 *  and debris paths use the helpers below so the same
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
 *  blueprint's `radius.other`; turrets are unit-agnostic by contract,
 *  so the host unit's body radius does NOT factor in. */
type TurretRadiusSource = { id?: string; radius?: { other?: number } };
type TurretBarrelSource = TurretRadiusSource & { barrel?: BarrelShape };
type BarrelShotSource = TurretBarrelSource & {
  shot?: EmissionConfig | ActiveProjectileShot | null;
  spread?: TurretConfig['spread'];
};

function getTurretBodyRadius(config: TurretRadiusSource): number {
  return turretBodyRadiusFromRadius(config.radius);
}

/** Legacy name retained for the existing turret mesh/HUD vocabulary:
 *  the visible turret "head" is the same sphere as `radius.other`.
 *  Returns 0 when `radius.other` is `null` — the explicit "draw no body
 *  sphere" signal (the head mesh is skipped and barrels, which pivot/scale
 *  off this radius, collapse to nothing). A positive number is the drawn
 *  sphere's world radius. */
export function getTurretHeadRadius(config: TurretRadiusSource): number {
  return getTurretBodyRadius(config);
}

/** Turret body sphere radius from a radius config: the positive
 *  `radius.other`, or 0 when it is `null` / absent / non-positive (no body
 *  sphere). Top-mounted turrets still require a positive radius — that's
 *  enforced where `mount.z` is resolved, not here. */
export function turretBodyRadiusFromRadius(
  radius: TurretRadiusSource['radius'] | undefined,
): number {
  const body = radius?.other;
  if (typeof body !== 'number' || body <= 0) return 0;
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

/** A head-only turret emitting a ray keeps its aim off the wire and poses
 *  from the last beam fired. The historical flag name is kept as the
 *  single source of truth for "this ray turret follows its beam"; the
 *  mesh builder now leaves it head-only and the pose passes aim that head
 *  from `TurretBeamAimCache3D`. */
export function turretBarrelFollowsBeam(
  config: { headOnly?: boolean; shot?: EmissionConfig | null | undefined },
): boolean {
  return config.headOnly === true
    && config.shot !== null
    && config.shot !== undefined
    && isRayConfig(config.shot);
}

/** How many physical barrels a turret config has. Single-barrel and
 *  shield emitters report 1; gatlings and cone shotguns report
 *  their `barrelCount`. Used by the firing round-robin to pick
 *  barrelIndex = fireCount mod N. */
export function countBarrels(config: Pick<TurretConfig, 'barrel'>): number {
  const b = config.barrel;
  if (!b) return 1;
  if (b.type === 'singleCylinderBarrel') return 1;
  if (b.type === 'singleConeBarrel') return 1;
  if (b.type === 'complexSingleEmitter') return 1;
  if (b.type === 'shieldPanelEmitter') return 1;
  return b.barrelCount;
}

/** Per-barrel orbit angle around the firing axis: barrels are evenly
 *  spaced on a circle, half-step offset so the i=0 barrel is NOT on
 *  any cardinal axis (which would visually align with the chassis edge
 *  at one orientation). Same convention used by the renderer's
 *  YZ-plane multi-barrel layout; centralizing keeps a future change
 *  to the spacing rule atomic across visual systems. */
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
  if (
    !barrel ||
    barrel.type === 'complexSingleEmitter' ||
    barrel.type === 'shieldPanelEmitter'
  ) {
    return 0;
  }

  const shot = config.shot;
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

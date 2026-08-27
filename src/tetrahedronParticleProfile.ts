/**
 * Shared presentation profile for loose tetrahedron particles.
 *
 * Explosion magnitude and work-emitter scale may choose how many particles
 * are born and how quickly they move, but they never stretch the particles
 * themselves. Every consumer resolves to one of these three exact radii.
 */

export type TetrahedronParticleSizeClass = 0 | 1 | 2;

export const TETRAHEDRON_PARTICLE_SMALL: TetrahedronParticleSizeClass = 0;
export const TETRAHEDRON_PARTICLE_MEDIUM: TetrahedronParticleSizeClass = 1;
export const TETRAHEDRON_PARTICLE_LARGE: TetrahedronParticleSizeClass = 2;

/** The small class radius; every larger class is an exact multiple of it. */
export const TETRAHEDRON_PARTICLE_SMALL_RADIUS = 0.75;
/** Each class is exactly this many times the radius of the class below it. */
export const TETRAHEDRON_PARTICLE_CLASS_RADIUS_RATIO = 2;

/** Exact world-space radii for the only three loose-tetrahedron sizes:
 *  small, medium = small x ratio, large = medium x ratio. */
export const TETRAHEDRON_PARTICLE_RADIUS = [
  TETRAHEDRON_PARTICLE_SMALL_RADIUS,
  TETRAHEDRON_PARTICLE_SMALL_RADIUS * TETRAHEDRON_PARTICLE_CLASS_RADIUS_RATIO,
  TETRAHEDRON_PARTICLE_SMALL_RADIUS *
    TETRAHEDRON_PARTICLE_CLASS_RADIUS_RATIO *
    TETRAHEDRON_PARTICLE_CLASS_RADIUS_RATIO,
] as const;

/** Smaller chunks move faster; the separated bands keep that ordering even
 * after the bounded per-particle speed variation is applied. */
export const TETRAHEDRON_PARTICLE_SPEED_SCALE = [1.6, 1, 0.6] as const;
export const TETRAHEDRON_PARTICLE_SPEED_VARIATION_MIN = 0.85;
export const TETRAHEDRON_PARTICLE_SPEED_VARIATION_RANGE = 0.3;

export const TETRAHEDRON_PARTICLE_SPIN_MIN_RAD_PER_SEC = 7;
export const TETRAHEDRON_PARTICLE_SPIN_MAX_RAD_PER_SEC = 22;

export type MutableTetrahedronSpinAxis = {
  x: number;
  y: number;
  z: number;
};

function clampUnit(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = clampUnit((value - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/** Matches the hot explosion material's short birth fade. */
export function tetrahedronParticleFadeIn(age01: number): number {
  return smoothstep(0, 0.08, age01);
}

/** Matches the hot explosion material's longer tail fade. */
export function tetrahedronParticleFadeOut(age01: number): number {
  return 1 - smoothstep(0.56, 1, age01);
}

export function tetrahedronParticleRadius(
  sizeClass: TetrahedronParticleSizeClass,
): number {
  return TETRAHEDRON_PARTICLE_RADIUS[sizeClass];
}

export function tetrahedronParticleSpeedVariation(random01: number): number {
  return TETRAHEDRON_PARTICLE_SPEED_VARIATION_MIN +
    TETRAHEDRON_PARTICLE_SPEED_VARIATION_RANGE * clampUnit(random01);
}

/** Resolve a legacy/numeric radius hint to the nearest standardized class. */
export function tetrahedronParticleSizeClassForRadius(
  requestedRadius: number | undefined,
): TetrahedronParticleSizeClass {
  const radius = requestedRadius !== undefined && Number.isFinite(requestedRadius)
    ? requestedRadius
    : TETRAHEDRON_PARTICLE_RADIUS[TETRAHEDRON_PARTICLE_MEDIUM];
  const smallMediumBoundary = (
    TETRAHEDRON_PARTICLE_RADIUS[TETRAHEDRON_PARTICLE_SMALL] +
    TETRAHEDRON_PARTICLE_RADIUS[TETRAHEDRON_PARTICLE_MEDIUM]
  ) * 0.5;
  const mediumLargeBoundary = (
    TETRAHEDRON_PARTICLE_RADIUS[TETRAHEDRON_PARTICLE_MEDIUM] +
    TETRAHEDRON_PARTICLE_RADIUS[TETRAHEDRON_PARTICLE_LARGE]
  ) * 0.5;
  if (radius < smallMediumBoundary) return TETRAHEDRON_PARTICLE_SMALL;
  if (radius < mediumLargeBoundary) return TETRAHEDRON_PARTICLE_MEDIUM;
  return TETRAHEDRON_PARTICLE_LARGE;
}

export function isStandardTetrahedronParticleRadius(radius: number): boolean {
  return TETRAHEDRON_PARTICLE_RADIUS.some((candidate) => candidate === radius);
}

/**
 * Define one immutable random-axis spin at particle birth. The returned
 * signed angular speed and written unit axis are then held for the particle's
 * entire lifetime; callers advance only angle = birthPhase + rate * age.
 */
export function writeTetrahedronParticleSpin(
  axis: MutableTetrahedronSpinAxis,
  azimuth01: number,
  vertical01: number,
  speed01: number,
  direction01: number,
): number {
  const vertical = clampUnit(vertical01) * 2 - 1;
  const radial = Math.sqrt(Math.max(0, 1 - vertical * vertical));
  const azimuth = clampUnit(azimuth01) * Math.PI * 2;
  axis.x = Math.cos(azimuth) * radial;
  axis.y = vertical;
  axis.z = Math.sin(azimuth) * radial;
  const speed = TETRAHEDRON_PARTICLE_SPIN_MIN_RAD_PER_SEC +
    (TETRAHEDRON_PARTICLE_SPIN_MAX_RAD_PER_SEC -
      TETRAHEDRON_PARTICLE_SPIN_MIN_RAD_PER_SEC) * clampUnit(speed01);
  return clampUnit(direction01) < 0.5 ? -speed : speed;
}

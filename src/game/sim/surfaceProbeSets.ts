import type { SurfaceProbeSetId } from '@/types/unitLocomotionTypes';
import rawSurfaceProbeConfig from './surfaceProbeConfig.json';

export const SURFACE_PROBE_SET_IDS = ['single', 'few', 'many'] as const;
export type SurfaceProbePoint = Readonly<{
  /** Integer lattice coordinate in units of the one shared probe spacing. */
  forward: number;
  lateral: number;
}>;

export type SurfaceProbeSpacing = Readonly<{
  /** One probe interval in simulation world units. */
  world: number;
}>;

export type SurfaceProbeSet = Readonly<{
  points: readonly SurfaceProbePoint[];
}>;

type SurfaceProbeConfig = {
  spacing: SurfaceProbeSpacing;
  sets: Record<SurfaceProbeSetId, SurfaceProbeSet>;
};

function assertExactKeys(
  label: string,
  value: Record<string, unknown>,
  expected: readonly string[],
): void {
  const expectedKeys = new Set(expected);
  for (const key of Object.keys(value)) {
    if (!expectedKeys.has(key)) {
      throw new Error(`Invalid surfaceProbeConfig.json: ${label}.${key}`);
    }
  }
  for (const key of expected) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      throw new Error(`Invalid surfaceProbeConfig.json: missing ${label}.${key}`);
    }
  }
}

function assertObject(label: string, value: unknown): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid surfaceProbeConfig.json: expected ${label} object`);
  }
}

function assertFinite(label: string, value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Invalid surfaceProbeConfig.json: expected finite ${label}`);
  }
}

function readSurfaceProbeConfig(): SurfaceProbeConfig {
  assertObject('root', rawSurfaceProbeConfig);
  assertExactKeys('root', rawSurfaceProbeConfig, ['spacing', 'sets']);
  assertObject('spacing', rawSurfaceProbeConfig.spacing);
  assertExactKeys('spacing', rawSurfaceProbeConfig.spacing, ['world']);
  assertFinite('spacing.world', rawSurfaceProbeConfig.spacing.world);
  if (rawSurfaceProbeConfig.spacing.world <= 0) {
    throw new Error('Invalid surfaceProbeConfig.json: spacing.world must be positive');
  }
  assertObject('sets', rawSurfaceProbeConfig.sets);
  assertExactKeys('sets', rawSurfaceProbeConfig.sets, SURFACE_PROBE_SET_IDS);

  const sets = {} as Record<SurfaceProbeSetId, SurfaceProbeSet>;
  for (const setId of SURFACE_PROBE_SET_IDS) {
    const set = rawSurfaceProbeConfig.sets[setId];
    assertObject(`sets.${setId}`, set);
    assertExactKeys(`sets.${setId}`, set, ['points']);
    if (!Array.isArray(set.points) || set.points.length === 0) {
      throw new Error(`Invalid surfaceProbeConfig.json: sets.${setId}.points must be non-empty`);
    }
    const points = set.points.map((point, index): SurfaceProbePoint => {
      const label = `sets.${setId}.points[${index}]`;
      assertObject(label, point);
      assertExactKeys(label, point, ['forward', 'lateral']);
      assertFinite(`${label}.forward`, point.forward);
      assertFinite(`${label}.lateral`, point.lateral);
      return Object.freeze({
        forward: point.forward,
        lateral: point.lateral,
      });
    });
    if (points.filter((point) => point.forward === 0 && point.lateral === 0).length !== 1) {
      throw new Error(`Invalid surfaceProbeConfig.json: ${setId} must contain one center point`);
    }
    sets[setId] = Object.freeze({ points: Object.freeze(points) });
  }
  return {
    spacing: Object.freeze({
      world: rawSurfaceProbeConfig.spacing.world,
    }),
    sets,
  };
}

const SURFACE_PROBE_CONFIG = readSurfaceProbeConfig();

export function isSurfaceProbeSetId(value: unknown): value is SurfaceProbeSetId {
  return typeof value === 'string' &&
    (SURFACE_PROBE_SET_IDS as readonly string[]).includes(value);
}

export function getSurfaceProbeSet(setId: SurfaceProbeSetId): SurfaceProbeSet {
  return SURFACE_PROBE_CONFIG.sets[setId];
}

/** The sole metric definition for spacing between non-center probe points. */
export function getSurfaceProbeSpacing(): SurfaceProbeSpacing {
  return SURFACE_PROBE_CONFIG.spacing;
}

export function getSurfaceProbePointCount(setId: SurfaceProbeSetId): number {
  return getSurfaceProbeSet(setId).points.length;
}

export function forEachSurfaceProbePoint(
  setId: SurfaceProbeSetId,
  bodyX: number,
  bodyY: number,
  forwardX: number,
  forwardY: number,
  visit: (x: number, y: number, isCenter: boolean) => void,
): number {
  if (![bodyX, bodyY, forwardX, forwardY].every(Number.isFinite)) return 0;
  const set = getSurfaceProbeSet(setId);
  const spacing = getSurfaceProbeSpacing().world;
  const leftX = -forwardY;
  const leftY = forwardX;
  for (const point of set.points) {
    visit(
      bodyX + spacing * (forwardX * point.forward + leftX * point.lateral),
      bodyY + spacing * (forwardY * point.forward + leftY * point.lateral),
      point.forward === 0 && point.lateral === 0,
    );
  }
  return set.points.length;
}

import type { SurfaceProbeSetId } from '@/types/unitLocomotionTypes';
import rawSurfaceProbeConfig from './surfaceProbeConfig.json';

export const SURFACE_PROBE_SET_IDS = ['1-point', '5-points', '8-points'] as const;
export type SurfaceProbePointRole = 'center' | 'forward' | 'side' | 'rear';

export type SurfaceProbePoint = Readonly<{
  forward: number;
  lateral: number;
  role: SurfaceProbePointRole;
}>;

export type SurfaceProbeSet = Readonly<{
  reach: Readonly<{
    world: number;
    bodyRadiusMultiplier: number;
  }>;
  points: readonly SurfaceProbePoint[];
}>;

type SurfaceProbeConfig = {
  sets: Record<SurfaceProbeSetId, SurfaceProbeSet>;
};

const POINT_ROLES = new Set<SurfaceProbePointRole>(['center', 'forward', 'side', 'rear']);

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
  assertExactKeys('root', rawSurfaceProbeConfig, ['sets']);
  assertObject('sets', rawSurfaceProbeConfig.sets);
  assertExactKeys('sets', rawSurfaceProbeConfig.sets, SURFACE_PROBE_SET_IDS);

  const sets = {} as Record<SurfaceProbeSetId, SurfaceProbeSet>;
  for (const setId of SURFACE_PROBE_SET_IDS) {
    const set = rawSurfaceProbeConfig.sets[setId];
    assertObject(`sets.${setId}`, set);
    assertExactKeys(`sets.${setId}`, set, ['reach', 'points']);
    assertObject(`sets.${setId}.reach`, set.reach);
    assertExactKeys(`sets.${setId}.reach`, set.reach, ['world', 'bodyRadiusMultiplier']);
    assertFinite(`sets.${setId}.reach.world`, set.reach.world);
    assertFinite(`sets.${setId}.reach.bodyRadiusMultiplier`, set.reach.bodyRadiusMultiplier);
    if (set.reach.world < 0 || set.reach.bodyRadiusMultiplier < 0) {
      throw new Error(`Invalid surfaceProbeConfig.json: ${setId} reach must be non-negative`);
    }
    if (!Array.isArray(set.points) || set.points.length === 0) {
      throw new Error(`Invalid surfaceProbeConfig.json: sets.${setId}.points must be non-empty`);
    }
    const points = set.points.map((point, index): SurfaceProbePoint => {
      const label = `sets.${setId}.points[${index}]`;
      assertObject(label, point);
      assertExactKeys(label, point, ['forward', 'lateral', 'role']);
      assertFinite(`${label}.forward`, point.forward);
      assertFinite(`${label}.lateral`, point.lateral);
      if (!POINT_ROLES.has(point.role as SurfaceProbePointRole)) {
        throw new Error(`Invalid surfaceProbeConfig.json: unknown ${label}.role`);
      }
      return Object.freeze({
        forward: point.forward,
        lateral: point.lateral,
        role: point.role as SurfaceProbePointRole,
      });
    });
    const expectedPointCount = Number.parseInt(setId, 10);
    if (points.length !== expectedPointCount) {
      throw new Error(
        `Invalid surfaceProbeConfig.json: ${setId} must contain ${expectedPointCount} points`,
      );
    }
    if (points.filter((point) => point.role === 'center').length !== 1) {
      throw new Error(`Invalid surfaceProbeConfig.json: ${setId} must contain one center point`);
    }
    sets[setId] = Object.freeze({
      reach: Object.freeze({
        world: set.reach.world,
        bodyRadiusMultiplier: set.reach.bodyRadiusMultiplier,
      }),
      points: Object.freeze(points),
    });
  }
  return { sets };
}

const SURFACE_PROBE_CONFIG = readSurfaceProbeConfig();

export function isSurfaceProbeSetId(value: unknown): value is SurfaceProbeSetId {
  return typeof value === 'string' &&
    (SURFACE_PROBE_SET_IDS as readonly string[]).includes(value);
}

export function getSurfaceProbeSet(setId: SurfaceProbeSetId): SurfaceProbeSet {
  return SURFACE_PROBE_CONFIG.sets[setId];
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
  bodyRadius: number,
  visit: (x: number, y: number, role: SurfaceProbePointRole) => void,
): number {
  if (![bodyX, bodyY, forwardX, forwardY, bodyRadius].every(Number.isFinite)) return 0;
  const set = getSurfaceProbeSet(setId);
  const reach = set.reach.world + Math.max(0, bodyRadius) * set.reach.bodyRadiusMultiplier;
  const leftX = -forwardY;
  const leftY = forwardX;
  for (const point of set.points) {
    visit(
      bodyX + reach * (forwardX * point.forward + leftX * point.lateral),
      bodyY + reach * (forwardY * point.forward + leftY * point.lateral),
      point.role,
    );
  }
  return set.points.length;
}

import { COLORS } from '@/colorsConfig';
import type { NetworkServerSnapshotSimEvent } from '../../network/NetworkTypes';

export const WATER_SURFACE_NORMAL_SIM = { x: 0, y: 0, z: 1 } as const;

export type SimDeathContext3D = NonNullable<NetworkServerSnapshotSimEvent['deathContext']>;

let warnedNonFiniteVisualEvent = false;

export function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

export function finiteAtLeast(value: number | undefined, min: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(value, min);
}

export function maxFiniteNonNegativeOr(fallback: number, a: number, b: number): number {
  let best = -Infinity;
  if (Number.isFinite(a)) best = Math.max(best, Math.max(0, a));
  if (Number.isFinite(b)) best = Math.max(best, Math.max(0, b));
  return best === -Infinity ? fallback : best;
}

export function hasFiniteEventPosition(event: NetworkServerSnapshotSimEvent): boolean {
  return (
    Number.isFinite(event.pos.x) &&
    Number.isFinite(event.pos.y) &&
    Number.isFinite(event.pos.z)
  );
}

export function warnNonFiniteVisualEvent(event: NetworkServerSnapshotSimEvent): void {
  if (warnedNonFiniteVisualEvent) return;
  warnedNonFiniteVisualEvent = true;
  console.warn('RtsScene3D dropped visual SimEvent with non-finite position', {
    type: event.type,
    pos: event.pos,
    entityId: event.entityId,
    turretBlueprintId: event.turretBlueprintId,
  });
}

export function sanitizeDeathContext(ctx: SimDeathContext3D): SimDeathContext3D {
  const radius = finiteAtLeast(ctx.radius, 0, 15);
  return {
    ...ctx,
    unitVel: {
      x: finiteOr(ctx.unitVel.x, 0),
      y: finiteOr(ctx.unitVel.y, 0),
    },
    hitDir: {
      x: finiteOr(ctx.hitDir.x, 0),
      y: finiteOr(ctx.hitDir.y, 0),
    },
    projectileVel: {
      x: finiteOr(ctx.projectileVel.x, 0),
      y: finiteOr(ctx.projectileVel.y, 0),
    },
    attackMagnitude: finiteAtLeast(ctx.attackMagnitude, 0, 25),
    radius,
    visualRadius: ctx.visualRadius === undefined
      ? undefined
      : finiteAtLeast(ctx.visualRadius, 0, radius),
    collisionRadius: ctx.collisionRadius === undefined
      ? undefined
      : finiteAtLeast(ctx.collisionRadius, 0, radius),
    baseZ: ctx.baseZ === undefined ? undefined : finiteOr(ctx.baseZ, 0),
    color: Number.isFinite(ctx.color)
      ? ctx.color
      : COLORS.units.locomotion.hover.smoke.colorHex,
    rotation: ctx.rotation === undefined ? undefined : finiteOr(ctx.rotation, 0),
    turretPoses: ctx.turretPoses?.map((pose) => ({
      rotation: finiteOr(pose.rotation, 0),
      pitch: finiteOr(pose.pitch, 0),
    })),
  };
}

import { COLORS } from '@/colorsConfig';
import { isUnitBlueprintId } from '@/types/blueprintIds';
import type { NetworkServerSnapshotSimEvent } from '../../network/NetworkTypes';
import { getUnitSupportPointOffsetZ, getUnitGroundZ } from '../../sim/unitGeometry';
import { getPlayerPrimaryColor, type Entity } from '../../sim/types';

export const WATER_SURFACE_NORMAL_SIM = { x: 0, y: 0, z: 1 } as const;

type SimDeathContext3D = NonNullable<NetworkServerSnapshotSimEvent['deathContext']>;

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

function sanitizeDeathContext(ctx: SimDeathContext3D): SimDeathContext3D {
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
    turretPoses: sanitizeTurretPoses(ctx.turretPoses),
  };
}

export function resolveDeathContext3D(
  event: NetworkServerSnapshotSimEvent,
  ent: Entity | undefined,
): SimDeathContext3D {
  // Some kill paths (splash, bleed-out, shield zone damage) emit
  // a death event with no deathContext. Rather than skipping the
  // material explosion entirely, try to reconstruct a minimal context
  // from the entity if it's still in view state; otherwise synthesize
  // a generic fallback so debris still fires.
  let ctx = event.deathContext;
  if (!ctx && ent) {
    const pid = ent.ownership?.playerId;
    const tcol = getPlayerPrimaryColor(pid);
    const visualRadius = ent.unit?.radius.other
      ?? ent.unit?.radius.hitbox
      ?? 15;
    const collisionRadius = ent.unit ? getUnitSupportPointOffsetZ(ent.unit) : visualRadius;
    ctx = {
      unitVel: {
        x: ent.unit?.velocityX ?? 0,
        y: ent.unit?.velocityY ?? 0,
      },
      hitDir: { x: 0, y: 0 },
      projectileVel: { x: 0, y: 0 },
      attackMagnitude: 25,
      radius: ent.unit?.radius.hitbox ?? 15,
      visualRadius,
      collisionRadius,
      baseZ: ent.unit ? getUnitGroundZ(ent) : ent.transform.z - collisionRadius,
      color: tcol,
      unitBlueprintId: ent.unit?.unitBlueprintId && isUnitBlueprintId(ent.unit.unitBlueprintId)
        ? ent.unit.unitBlueprintId
        : undefined,
      rotation: ent.transform.rotation,
    };
  }
  if (ctx && ent?.unit) {
    const visualRadius = ent.unit.radius.other
      ?? ent.unit.radius.hitbox
      ?? ctx.visualRadius
      ?? ctx.radius;
    const collisionRadius = getUnitSupportPointOffsetZ(ent.unit);
    if (
      ctx.visualRadius === undefined ||
      ctx.collisionRadius === undefined ||
      ctx.baseZ === undefined
    ) {
      ctx = {
        ...ctx,
        visualRadius: ctx.visualRadius ?? visualRadius,
        collisionRadius: ctx.collisionRadius ?? collisionRadius,
        baseZ: ctx.baseZ ?? getUnitGroundZ(ent),
      };
    }
  }
  if (ctx && ent && !ctx.turretPoses && ent.combat && ent.combat.turrets.length > 0) {
    const turretPoses = new Array<{ rotation: number; pitch: number }>(ent.combat.turrets.length);
    for (let i = 0; i < ent.combat.turrets.length; i++) {
      const turret = ent.combat.turrets[i];
      turretPoses[i] = {
        rotation: turret.rotation,
        pitch: turret.pitch,
      };
    }
    ctx = {
      ...ctx,
      turretPoses,
    };
  }
  if (!ctx) {
    // Entity already gone and no server-supplied context: synthesize a
    // bare-minimum neutral context so Debris3D's generic-chunks fallback
    // still produces something visible. Worse than a real debris
    // burst but better than silence.
    ctx = {
      unitVel: { x: 0, y: 0 },
      hitDir: { x: 0, y: 0 },
      projectileVel: { x: 0, y: 0 },
      attackMagnitude: 25,
      radius: 15,
      visualRadius: 15,
      collisionRadius: 15,
      baseZ: event.pos.z - 15,
      color: COLORS.units.locomotion.hover.smoke.colorHex,
    };
  }
  return sanitizeDeathContext(ctx);
}

function sanitizeTurretPoses(
  poses: SimDeathContext3D['turretPoses'],
): SimDeathContext3D['turretPoses'] {
  if (poses === undefined) return undefined;
  const sanitized = new Array<{ rotation: number; pitch: number }>(poses.length);
  for (let i = 0; i < poses.length; i++) {
    const pose = poses[i];
    sanitized[i] = {
      rotation: finiteOr(pose.rotation, 0),
      pitch: finiteOr(pose.pitch, 0),
    };
  }
  return sanitized;
}

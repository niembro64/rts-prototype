import { getMaterialExplosions } from '@/clientBarConfig';
import type { ClientViewState } from '../../network/ClientViewState';
import type { NetworkServerSnapshotSimEvent } from '../../network/NetworkTypes';
import type { BeamRenderer3D } from '../../render3d/BeamRenderer3D';
import type { Render3DEntities } from '../../render3d/Render3DEntities';
import type { ShieldImpactRenderer3D } from '../../render3d/ShieldImpactRenderer3D';
import type { WaterSplash3D } from '../../render3d/WaterSplash3D';
import { entityDeathBlastFromContext3D } from '../../render3d/EntityDeathDisassembly3D';
import { finiteOr } from '../../math';
import { DEATH_EXPLOSION_HITBOX_RADIUS_MULT } from '../../sim/blueprints/entityBaseLedger';
import { getShotBlueprint } from '../../sim/blueprints/shots';
import { isShotBlueprintId } from '@/types/blueprintIds';
import { playSimEventAudio3D } from './RtsScene3DSimEventAudio';
import {
  WATER_SURFACE_NORMAL_SIM,
  finiteAtLeast,
  hasFiniteEventPosition,
  maxFiniteNonNegativeOr,
  resolveDeathContext3D,
  warnNonFiniteVisualEvent,
} from './RtsScene3DVisualEventSanitizer';

type RtsScene3DVisualEventDispatchContext = {
  clientViewState: ClientViewState;
  entityRenderer: Render3DEntities;
  beamRenderer: BeamRenderer3D;
  shieldImpactRenderer: ShieldImpactRenderer3D;
  waterSplashRenderer: WaterSplash3D;
  isPositionLowLod: (
    simX: number,
    simY: number,
    simZ: number,
  ) => boolean;
  positionVisualDetailLevel: (
    simX: number,
    simY: number,
    simZ: number,
  ) => number;
};

const EFFECT_RADIUS_FALLBACKS = {
  deathExplosionMin: 6,
  hitImpact: 2,
  projectileExpireImpact: 8,
} as const;

/** The damage a shot's detonation deals, from its own blueprint. hit /
 *  projectileExpire events carry the SHOT blueprint id as their audio key,
 *  and every peer runs the same build with the same blueprints, so the
 *  fire-explosion particle count needs nothing extra on the wire. */
function shotExplosionDamageForEvent(
  event: NetworkServerSnapshotSimEvent,
): number | undefined {
  const key = event.turretBlueprintId;
  if (typeof key !== 'string' || !isShotBlueprintId(key)) return undefined;
  const damage = getShotBlueprint(key).base.deathExplosion.damage;
  return damage > 0 ? damage : undefined;
}

export function dispatchSimEvent3DVisual(
  event: NetworkServerSnapshotSimEvent,
  context: RtsScene3DVisualEventDispatchContext,
): void {
  playSimEventAudio3D(event);
  if (event.audioOnly) return;
  if (!hasFiniteEventPosition(event)) {
    warnNonFiniteVisualEvent(event);
    return;
  }
  if (
    event.type === 'ping' ||
    event.type === 'attackAlert' ||
    event.type === 'selfDestructArmed' ||
    event.type === 'selfDestructDisarmed'
  ) {
    // Marker/state events: handled by the scene (ping marker,
    // self-destruct blink), no world-space effect to spawn here.
    return;
  }

  if (event.type === 'hit') {
    const ctx = event.impactContext;
    const radius = ctx
      ? maxFiniteNonNegativeOr(
        EFFECT_RADIUS_FALLBACKS.hitImpact,
        ctx.radiusCollision,
        ctx.deathExplosionRadius,
      )
      : EFFECT_RADIUS_FALLBACKS.hitImpact;
    if (context.isPositionLowLod(
      event.pos.x,
      event.pos.y,
      event.pos.z,
    )) return;
    const detailLevel = context.positionVisualDetailLevel(
      event.pos.x,
      event.pos.y,
      event.pos.z,
    );
    let mx = 0, mz = 0;
    if (ctx) {
      mx =
        finiteOr(ctx.penetrationDir.x, 0) * 120 +
        finiteOr(ctx.projectile.vel.x, 0) * 0.3 +
        finiteOr(ctx.entity.vel.x, 0) * 0.3;
      mz =
        finiteOr(ctx.penetrationDir.y, 0) * 120 +
        finiteOr(ctx.projectile.vel.y, 0) * 0.3 +
        finiteOr(ctx.entity.vel.y, 0) * 0.3;
    }
    context.beamRenderer.spawnDamageImpact({
      x: event.pos.x,
      y: event.pos.y,
      z: event.pos.z,
      damageRadius: radius,
      damage: shotExplosionDamageForEvent(event),
      incomingX: mx,
      incomingY: mz,
      incomingZ: 0,
      hitEntity: (ctx?.entity.radiusCollision ?? 0) > 0,
      detailLevel,
      seedSource: event.entityId ?? undefined,
    });
  } else if (event.type === 'waterSplash') {
    const splash = event.waterSplash;
    const ctx = event.impactContext;
    if (context.isPositionLowLod(
      event.pos.x,
      event.pos.y,
      event.pos.z,
    )) return;
    const fallbackVelocity = {
      x: ctx ? finiteOr(ctx.projectile.vel.x, 0) : 0,
      y: ctx ? finiteOr(ctx.projectile.vel.y, 0) : 0,
      z: 0,
    };
    const mass = splash
      ? finiteAtLeast(splash.mass, 0.001, 1)
      : ctx
        ? finiteAtLeast(ctx.radiusCollision, 1, 1)
        : 2;
    context.waterSplashRenderer.createSplash(
      event.pos,
      splash ? splash.velocity : fallbackVelocity,
      mass,
    );
    context.shieldImpactRenderer.spawn(
      event.pos.x,
      event.pos.y,
      event.pos.z,
      WATER_SURFACE_NORMAL_SIM,
      event.playerId ?? undefined,
    );
  } else if (event.type === 'projectileExpire') {
    if (context.isPositionLowLod(
      event.pos.x,
      event.pos.y,
      event.pos.z,
    )) return;
    const ctx = event.impactContext;
    const radius = ctx
      ? maxFiniteNonNegativeOr(
        EFFECT_RADIUS_FALLBACKS.projectileExpireImpact,
        ctx.radiusCollision,
        ctx.deathExplosionRadius,
      )
      : EFFECT_RADIUS_FALLBACKS.projectileExpireImpact;
    context.beamRenderer.spawnDamageImpact({
      x: event.pos.x,
      y: event.pos.y,
      z: event.pos.z,
      damageRadius: radius,
      damage: shotExplosionDamageForEvent(event),
      incomingX: ctx ? finiteOr(ctx.projectile.vel.x, 0) : 0,
      incomingY: ctx ? finiteOr(ctx.projectile.vel.y, 0) : 0,
      incomingZ: 0,
      detailLevel: context.positionVisualDetailLevel(
        event.pos.x,
        event.pos.y,
        event.pos.z,
      ),
      seedSource: event.entityId ?? undefined,
    });
  } else if (event.type === 'shieldImpact') {
    const ctx = event.shieldImpact;
    if (ctx) {
      if (context.isPositionLowLod(
        event.pos.x,
        event.pos.y,
        event.pos.z,
      )) return;
      context.shieldImpactRenderer.spawn(
        event.pos.x,
        event.pos.y,
        event.pos.z,
        ctx.normal,
        ctx.playerId,
      );
    }
  } else if (event.type === 'death') {
    const ent = event.entityId !== null
      ? context.clientViewState.getEntity(event.entityId)
      : undefined;
    const ctx = resolveDeathContext3D(event, ent);
    const materialExplosionEnabled = getMaterialExplosions();
    if (event.entityId !== null) {
      context.entityRenderer.markEntityKilled(
        event.entityId,
        materialExplosionEnabled
          ? entityDeathBlastFromContext3D(ctx, event.entityId)
          : undefined,
      );
    }
    if (!materialExplosionEnabled) return;
    if (context.isPositionLowLod(
      event.pos.x,
      event.pos.y,
      event.pos.z,
    )) return;
    const attackPush = Math.min(ctx.attackMagnitude * 2, 200);
    // The fire blast draws at the death explosion's DAMAGE sphere — the
    // same derived radius the sim detonates (hitbox × the shared multiple)
    // — so what the player sees burning is exactly what got hurt.
    const deathRadius = Math.max(
      ctx.radius * DEATH_EXPLOSION_HITBOX_RADIUS_MULT,
      EFFECT_RADIUS_FALLBACKS.deathExplosionMin,
    );
    const eventDetailLevel = context.positionVisualDetailLevel(
      event.pos.x,
      event.pos.y,
      event.pos.z,
    );
    const mx =
      ctx.hitDir.x * attackPush +
      ctx.projectileVel.x * 0.3 +
      ctx.unitVel.x * 0.5;
    const mz =
      ctx.hitDir.y * attackPush +
      ctx.projectileVel.y * 0.3 +
      ctx.unitVel.y * 0.5;
    context.beamRenderer.spawnDamageImpact({
      x: event.pos.x,
      y: event.pos.y,
      z: event.pos.z,
      damageRadius: deathRadius,
      damage: ctx.explosionDamage,
      incomingX: mx,
      incomingY: mz,
      incomingZ: 0,
      surface: 'blast',
      detailLevel: eventDetailLevel,
      seedSource: event.entityId ?? undefined,
    });
  }
}

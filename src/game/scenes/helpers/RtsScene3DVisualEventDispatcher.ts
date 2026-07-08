import { getGraphicsConfig, getMaterialExplosions } from '@/clientBarConfig';
import {
  ENTITY_LOD_EFFECT_RADIUS_FALLBACKS,
} from '@/config';
import type { ClientViewState } from '../../network/ClientViewState';
import type { NetworkServerSnapshotSimEvent } from '../../network/NetworkTypes';
import type { Debris3D } from '../../render3d/Debris3D';
import type { Explosion3D } from '../../render3d/Explosion3D';
import type { Render3DEntities } from '../../render3d/Render3DEntities';
import type { ShieldImpactRenderer3D } from '../../render3d/ShieldImpactRenderer3D';
import type { WaterSplash3D } from '../../render3d/WaterSplash3D';
import type { EntityLodEmission3D } from '../../render3d/EntityLod3D';
import {
  debrisSpawnScaleForDetail,
  explosionSpawnScaleForDetail,
} from '../../render3d/EntityDetailLevel3D';
import { playSimEventAudio3D } from './RtsScene3DSimEventAudio';
import {
  WATER_SURFACE_NORMAL_SIM,
  finiteAtLeast,
  finiteOr,
  hasFiniteEventPosition,
  maxFiniteNonNegativeOr,
  resolveDeathContext3D,
  warnNonFiniteVisualEvent,
} from './RtsScene3DVisualEventSanitizer';

type RtsScene3DVisualEventDispatchContext = {
  clientViewState: ClientViewState;
  entityRenderer: Render3DEntities;
  explosionRenderer: Explosion3D;
  shieldImpactRenderer: ShieldImpactRenderer3D;
  waterSplashRenderer: WaterSplash3D;
  debrisRenderer: Debris3D;
  isPositionLowEmissionLod: (
    simX: number,
    simY: number,
    simZ: number,
    emission: EntityLodEmission3D,
  ) => boolean;
  positionVisualDetailLevel: (
    simX: number,
    simY: number,
    simZ: number,
    radius: number,
  ) => number;
};

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

  const effectGfx = getGraphicsConfig();
  if (!effectGfx) return;

  if (event.type === 'hit') {
    const ctx = event.impactContext;
    const radius = ctx
      ? maxFiniteNonNegativeOr(
        ENTITY_LOD_EFFECT_RADIUS_FALLBACKS.hitImpact,
        ctx.radiusCollision,
        ctx.deathExplosionRadius,
      )
      : ENTITY_LOD_EFFECT_RADIUS_FALLBACKS.hitImpact;
    if (context.isPositionLowEmissionLod(
      event.pos.x,
      event.pos.y,
      event.pos.z,
      'hitImpacts',
    )) return;
    const detailScale = explosionSpawnScaleForDetail(
      context.positionVisualDetailLevel(event.pos.x, event.pos.y, event.pos.z, radius),
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
    context.explosionRenderer.spawnImpact(
      event.pos.x,
      event.pos.y,
      event.pos.z,
      radius,
      mx,
      mz,
      undefined,
      effectGfx.fireExplosionStyle,
      detailScale,
    );
  } else if (event.type === 'waterSplash') {
    const splash = event.waterSplash;
    const ctx = event.impactContext;
    if (context.isPositionLowEmissionLod(
      event.pos.x,
      event.pos.y,
      event.pos.z,
      'waterSplashes',
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
    if (context.isPositionLowEmissionLod(
      event.pos.x,
      event.pos.y,
      event.pos.z,
      'projectileExpireImpacts',
    )) return;
    context.explosionRenderer.spawnImpact(
      event.pos.x,
      event.pos.y,
      event.pos.z,
      ENTITY_LOD_EFFECT_RADIUS_FALLBACKS.projectileExpireImpact,
      0,
      0,
      undefined,
      effectGfx.fireExplosionStyle,
      explosionSpawnScaleForDetail(
        context.positionVisualDetailLevel(
          event.pos.x,
          event.pos.y,
          event.pos.z,
          ENTITY_LOD_EFFECT_RADIUS_FALLBACKS.projectileExpireImpact,
        ),
      ),
    );
  } else if (event.type === 'shieldImpact') {
    const ctx = event.shieldImpact;
    if (ctx) {
      if (context.isPositionLowEmissionLod(
        event.pos.x,
        event.pos.y,
        event.pos.z,
        'shieldImpacts',
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
    if (event.entityId !== null) {
      context.entityRenderer.markEntityKilled(event.entityId);
    }
    if (!getMaterialExplosions()) return;
    const ent = event.entityId !== null
      ? context.clientViewState.getEntity(event.entityId)
      : undefined;
    const ctx = resolveDeathContext3D(event, ent);
    if (context.isPositionLowEmissionLod(
      event.pos.x,
      event.pos.y,
      event.pos.z,
      'materialDeathExplosions',
    )) return;
    const attackPush = Math.min(ctx.attackMagnitude * 2, 200);
    const deathRadius = Math.max(ctx.radius, ENTITY_LOD_EFFECT_RADIUS_FALLBACKS.deathExplosionMin);
    const eventDetailLevel = context.positionVisualDetailLevel(
      event.pos.x,
      event.pos.y,
      event.pos.z,
      deathRadius,
    );
    const mx =
      ctx.hitDir.x * attackPush +
      ctx.projectileVel.x * 0.3 +
      ctx.unitVel.x * 0.5;
    const mz =
      ctx.hitDir.y * attackPush +
      ctx.projectileVel.y * 0.3 +
      ctx.unitVel.y * 0.5;
    context.explosionRenderer.spawnDeath(
      event.pos.x, event.pos.y, event.pos.z,
      deathRadius,
      mx, mz,
      effectGfx.fireExplosionStyle,
      explosionSpawnScaleForDetail(eventDetailLevel),
    );
    context.debrisRenderer.spawn(
      event.pos.x,
      event.pos.y,
      event.pos.z,
      ctx,
      effectGfx,
      debrisSpawnScaleForDetail(eventDetailLevel),
    );
  }
}

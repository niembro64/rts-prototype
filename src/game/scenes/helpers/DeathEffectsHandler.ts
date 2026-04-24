// Death effects and audio event handling

import type { Viewport } from '../../Camera';
import type { EntityRenderer } from '../../render/renderEntities';
import type { SimEvent } from '../../sim/combat';
import type { ClientViewState } from '../../network/ClientViewState';
import { audioManager } from '../../audio/AudioManager';
import { AUDIO } from '../../../audioConfig';
import { getTurretBlueprint } from '../../sim/blueprints';
import {
  EXPLOSION_VELOCITY_MULTIPLIER,
  EXPLOSION_IMPACT_FORCE_MULTIPLIER,
  EXPLOSION_ATTACKER_DIRECTION_MULTIPLIER,
  EXPLOSION_BASE_MOMENTUM,
  FIRE_EXPLOSION,
} from '../../../explosionConfig';
import { TURRET_CONFIGS } from '../../sim/turretConfigs';
import { getPlayerPrimaryColor } from '../../sim/types';
import { magnitude } from '../../math';
import { getAudioScope, getSoundToggle } from '@/clientBarConfig';

// Get explosion radius based on turret type (uses explosion.primary.radius from config)
export function getExplosionRadius(turretId: string): number {
  const config = TURRET_CONFIGS[turretId as keyof typeof TURRET_CONFIGS];
  if (config?.shot.type === 'projectile' && config.shot.explosion?.primary.radius) {
    return config.shot.explosion.primary.radius;
  }
  if (config?.shot.type === 'beam' || config?.shot.type === 'laser') {
    return config.shot.radius;
  }
  return 8; // fallback
}

// Get secondary explosion radius based on turret type
function getSecondaryExplosionRadius(turretId: string): number | undefined {
  const config = TURRET_CONFIGS[turretId as keyof typeof TURRET_CONFIGS];
  if (config?.shot.type === 'projectile') {
    return config.shot.explosion?.secondary.radius;
  }
  return undefined;
}

// Handle audio events from simulation (or network)
export function handleSimEvent(
  event: SimEvent,
  entityRenderer: EntityRenderer,
  audioInitialized: boolean,
  viewport?: Viewport,
  zoom: number = 1,
  clientViewState?: ClientViewState,
): void {
  // Always handle visual effects even if audio not initialized
  if (event.type === 'hit' || event.type === 'projectileExpire') {
    const ic = event.impactContext;
    if (ic) {
      // Rich impact explosion with directional data
      const explosionRadius = ic.primaryRadius;

      // Projectile velocity → "attacker" direction (how the projectile was traveling)
      const attackerX = ic.projectile.vel.x * FIRE_EXPLOSION.projectileVelMult;
      const attackerY = ic.projectile.vel.y * FIRE_EXPLOSION.projectileVelMult;

      // Entity velocity → "velocity" direction (how the hit unit was moving)
      const velocityX = ic.entity.vel.x * FIRE_EXPLOSION.entityVelMult;
      const velocityY = ic.entity.vel.y * FIRE_EXPLOSION.entityVelMult;

      // Penetration direction (projectile center → entity center, normalized)
      const penetrationX = ic.penetrationDir.x * FIRE_EXPLOSION.penetrationMult;
      const penetrationY = ic.penetrationDir.y * FIRE_EXPLOSION.penetrationMult;

      entityRenderer.addExplosion(
        event.pos.x,
        event.pos.y,
        explosionRadius,
        0xff8844,
        'impact',
        velocityX,
        velocityY,
        penetrationX,
        penetrationY,
        attackerX,
        attackerY,
        ic.collisionRadius,
        ic.primaryRadius,
        ic.secondaryRadius,
        ic.entity.collisionRadius,
      );
    } else {
      // Fallback: no impactContext (shouldn't happen but safe)
      const explosionRadius = getExplosionRadius(event.turretId);
      const secondaryRadius = getSecondaryExplosionRadius(event.turretId);
      entityRenderer.addExplosion(
        event.pos.x,
        event.pos.y,
        explosionRadius,
        0xff8844,
        'impact',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        explosionRadius,
        secondaryRadius,
      );
    }
  }

  // Handle death explosions (visual) - uses death context from event
  if (event.type === 'death') {
    // Reconstruct a minimal deathContext when the event didn't carry one
    // (splash / DoT / safety-net kills). Mirrors the 3D fallback so 2D
    // units don't silently vanish without a material explosion.
    let ctx = event.deathContext;
    if (!ctx && event.entityId !== undefined && clientViewState) {
      const ent = clientViewState.getEntity(event.entityId);
      if (ent) {
        const pid = ent.ownership?.playerId;
        const tcol = getPlayerPrimaryColor(pid);
        ctx = {
          unitVel: {
            x: ent.unit?.velocityX ?? 0,
            y: ent.unit?.velocityY ?? 0,
          },
          hitDir: { x: 0, y: 0 },
          projectileVel: { x: 0, y: 0 },
          attackMagnitude: 25,
          radius: ent.unit?.unitRadiusCollider.shot ?? 15,
          color: tcol,
          unitType: ent.unit?.unitType,
          rotation: ent.transform.rotation,
        };
      }
    }
    if (!ctx) ctx = {
      unitVel: { x: 0, y: 0 },
      hitDir: { x: 0, y: 0 },
      projectileVel: { x: 0, y: 0 },
      attackMagnitude: 25,
      radius: 15,
      color: 0xcccccc,
    };
    const radius = ctx.radius * 2.5; // Death explosions are 2.5x collision radius

    // Apply same multipliers as host-side death handling
    const velocityX = ctx.unitVel.x * EXPLOSION_VELOCITY_MULTIPLIER;
    const velocityY = ctx.unitVel.y * EXPLOSION_VELOCITY_MULTIPLIER;

    const penetrationX = ctx.hitDir.x * EXPLOSION_IMPACT_FORCE_MULTIPLIER;
    const penetrationY = ctx.hitDir.y * EXPLOSION_IMPACT_FORCE_MULTIPLIER;

    const attackScale = Math.min(ctx.attackMagnitude / 50, 2);
    const attackerX =
      ctx.projectileVel.x *
      EXPLOSION_ATTACKER_DIRECTION_MULTIPLIER *
      attackScale;
    const attackerY =
      ctx.projectileVel.y *
      EXPLOSION_ATTACKER_DIRECTION_MULTIPLIER *
      attackScale;

    // Add base momentum
    let baseVelX = velocityX;
    let baseVelY = velocityY;
    const combinedX = velocityX + penetrationX + attackerX;
    const combinedY = velocityY + penetrationY + attackerY;
    const combinedMag = magnitude(combinedX, combinedY);
    if (combinedMag > 0 && EXPLOSION_BASE_MOMENTUM > 0) {
      baseVelX += (combinedX / combinedMag) * EXPLOSION_BASE_MOMENTUM;
      baseVelY += (combinedY / combinedMag) * EXPLOSION_BASE_MOMENTUM;
    }

    entityRenderer.addExplosion(
      event.pos.x,
      event.pos.y,
      radius,
      ctx.color,
      'death',
      baseVelX,
      baseVelY,
      penetrationX,
      penetrationY,
      attackerX,
      attackerY,
    );

    // Generate debris fragments from unit visual pieces
    if (ctx.unitType) {
      entityRenderer.addDebris(
        event.pos.x,
        event.pos.y,
        ctx.unitType,
        ctx.rotation ?? 0,
        ctx.radius,
        ctx.color,
        ctx.hitDir.x,
        ctx.hitDir.y,
      );
    }
  }

  if (!audioInitialized) return;

  // Stop events must always be processed to clean up continuous sounds,
  // even if the source has moved off-screen or audio scope is 'off'
  if (event.type === 'laserStop') {
    if (event.entityId !== undefined) {
      audioManager.stopLaserSound(event.entityId);
    }
    return;
  }
  if (event.type === 'forceFieldStop') {
    if (event.entityId !== undefined) {
      audioManager.stopForceFieldSound(event.entityId);
    }
    return;
  }

  // Audio scope filtering: 'off' = no audio, 'window' = viewport only,
  // 'padded' = 2x viewport area, 'all' = everything
  const audioScope = getAudioScope();
  if (audioScope === 'off') return;
  if (audioScope === 'window' && viewport) {
    if (!viewport.contains(event.pos.x, event.pos.y)) return;
  } else if (audioScope === 'padded' && viewport) {
    const padX = viewport.width * 0.5;
    const padY = viewport.height * 0.5;
    if (
      event.pos.x < viewport.x - padX ||
      event.pos.x > viewport.right + padX ||
      event.pos.y < viewport.y - padY ||
      event.pos.y > viewport.bottom + padY
    )
      return;
  }

  // Volume scales with zoom^exponent (configurable). Locked at play time per-sound.
  const zoomVolume = Math.pow(zoom, AUDIO.zoomVolumeExponent);

  switch (event.type) {
    case 'fire':
      if (getSoundToggle('fire')) {
        audioManager.playWeaponFire(event.turretId, 1, zoomVolume);
      }
      break;
    case 'hit':
      if (getSoundToggle('hit')) {
        audioManager.playWeaponHit(event.turretId, zoomVolume);
      }
      break;
    case 'death':
      if (getSoundToggle('dead')) {
        audioManager.playUnitDeath(
          event.deathContext?.unitType ?? '',
          zoomVolume,
        );
      }
      break;
    case 'laserStart':
      {
        if (!getSoundToggle('beam')) break;
        if (!AUDIO.beamGain) break;
        let laserEntry;
        try {
          laserEntry = getTurretBlueprint(event.turretId).audio?.laserSound;
        } catch {
          break;
        }
        if (!laserEntry || !laserEntry.volume) break;
        if (event.entityId !== undefined) {
          audioManager.startLaserSound(
            event.entityId,
            laserEntry.freq,
            laserEntry.volume * AUDIO.beamGain,
            zoomVolume,
          );
        }
      }
      break;
    case 'forceFieldStart':
      {
        if (!getSoundToggle('field')) break;
        if (!AUDIO.fieldGain) break;
        let ffEntry;
        try {
          ffEntry = getTurretBlueprint(event.turretId).audio?.fireSound;
        } catch {
          break;
        }
        if (!ffEntry || !ffEntry.volume) break;
        if (event.entityId !== undefined) {
          audioManager.startForceFieldSound(
            event.entityId,
            ffEntry.playSpeed,
            ffEntry.volume * AUDIO.fieldGain,
            zoomVolume,
          );
        }
      }
      break;
    case 'projectileExpire':
      // No sound for projectile expiration (visual only)
      break;
  }
}

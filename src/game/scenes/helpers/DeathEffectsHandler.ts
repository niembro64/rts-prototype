// Death effects and audio event handling

import type { EntityRenderer } from '../../render/renderEntities';
import type { SimEvent } from '../../sim/combat';
import { audioManager } from '../../audio/AudioManager';
import { AUDIO } from '../../../audioConfig';
import { getWeaponBlueprint } from '../../sim/blueprints';
import {
  EXPLOSION_VELOCITY_MULTIPLIER,
  EXPLOSION_IMPACT_FORCE_MULTIPLIER,
  EXPLOSION_ATTACKER_DIRECTION_MULTIPLIER,
  EXPLOSION_BASE_MOMENTUM,
  FIRE_EXPLOSION,
} from '../../../config';
import { TURRET_CONFIGS } from '../../sim/weapons';
import { magnitude } from '../../math';
import { getAudioScope } from '../../render/graphicsSettings';

// Get explosion radius based on weapon type (uses primaryDamageRadius from config)
export function getExplosionRadius(weaponId: string): number {
  const config = TURRET_CONFIGS[weaponId as keyof typeof TURRET_CONFIGS];
  if (config?.primaryDamageRadius) {
    return config.primaryDamageRadius as number;
  }
  return 8; // fallback
}

// Get secondary explosion radius based on weapon type
function getSecondaryExplosionRadius(weaponId: string): number | undefined {
  const config = TURRET_CONFIGS[weaponId as keyof typeof TURRET_CONFIGS];
  return config?.secondaryDamageRadius as number | undefined;
}

// Handle audio events from simulation (or network)
export function handleSimEvent(
  event: SimEvent,
  entityRenderer: EntityRenderer,
  audioInitialized: boolean,
  viewport?: Phaser.Geom.Rectangle,
  zoom: number = 1,
): void {
  // Always handle visual effects even if audio not initialized
  if (event.type === 'hit' || event.type === 'projectileExpire') {
    const ic = event.impactContext;
    if (ic) {
      // Rich impact explosion with directional data
      const explosionRadius = ic.primaryRadius;

      // Projectile velocity → "attacker" direction (how the projectile was traveling)
      const attackerX = ic.projectileVelX * FIRE_EXPLOSION.projectileVelMult;
      const attackerY = ic.projectileVelY * FIRE_EXPLOSION.projectileVelMult;

      // Entity velocity → "velocity" direction (how the hit unit was moving)
      const velocityX = ic.entityVelX * FIRE_EXPLOSION.entityVelMult;
      const velocityY = ic.entityVelY * FIRE_EXPLOSION.entityVelMult;

      // Penetration direction (projectile center → entity center, normalized)
      const penetrationX = ic.penetrationDirX * FIRE_EXPLOSION.penetrationMult;
      const penetrationY = ic.penetrationDirY * FIRE_EXPLOSION.penetrationMult;

      entityRenderer.addExplosion(
        event.x, event.y, explosionRadius, 0xff8844, 'impact',
        velocityX, velocityY,
        penetrationX, penetrationY,
        attackerX, attackerY,
        ic.collisionRadius, ic.primaryRadius, ic.secondaryRadius,
        ic.entityCollisionRadius,
      );
    } else {
      // Fallback: no impactContext (shouldn't happen but safe)
      const explosionRadius = getExplosionRadius(event.weaponId);
      const secondaryRadius = getSecondaryExplosionRadius(event.weaponId);
      entityRenderer.addExplosion(
        event.x, event.y, explosionRadius, 0xff8844, 'impact',
        undefined, undefined, undefined, undefined, undefined, undefined,
        undefined, explosionRadius, secondaryRadius,
      );
    }
  }

  // Handle death explosions (visual) - uses death context from event
  if (event.type === 'death' && event.deathContext) {
    const ctx = event.deathContext;
    const radius = ctx.radius * 2.5; // Death explosions are 2.5x collision radius

    // Apply same multipliers as host-side death handling
    const velocityX = ctx.unitVelX * EXPLOSION_VELOCITY_MULTIPLIER;
    const velocityY = ctx.unitVelY * EXPLOSION_VELOCITY_MULTIPLIER;

    const penetrationX = ctx.hitDirX * EXPLOSION_IMPACT_FORCE_MULTIPLIER;
    const penetrationY = ctx.hitDirY * EXPLOSION_IMPACT_FORCE_MULTIPLIER;

    const attackScale = Math.min(ctx.attackMagnitude / 50, 2);
    const attackerX = ctx.projectileVelX * EXPLOSION_ATTACKER_DIRECTION_MULTIPLIER * attackScale;
    const attackerY = ctx.projectileVelY * EXPLOSION_ATTACKER_DIRECTION_MULTIPLIER * attackScale;

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
      event.x,
      event.y,
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
        event.x, event.y,
        ctx.unitType, ctx.rotation ?? 0,
        ctx.radius, ctx.color,
        ctx.hitDirX, ctx.hitDirY
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
    if (!viewport.contains(event.x, event.y)) return;
  } else if (audioScope === 'padded' && viewport) {
    const padX = viewport.width * 0.5;
    const padY = viewport.height * 0.5;
    if (
      event.x < viewport.x - padX || event.x > viewport.right + padX ||
      event.y < viewport.y - padY || event.y > viewport.bottom + padY
    ) return;
  }

  // Volume scales with zoom^exponent (configurable). Locked at play time per-sound.
  const zoomVolume = Math.pow(zoom, AUDIO.zoomVolumeExponent);

  switch (event.type) {
    case 'fire':
      audioManager.playWeaponFire(event.weaponId, 1, zoomVolume);
      break;
    case 'hit':
      audioManager.playWeaponHit(event.weaponId, zoomVolume);
      break;
    case 'death':
      audioManager.playUnitDeath(event.deathContext?.unitType ?? '', zoomVolume);
      break;
    case 'laserStart': {
      if (!AUDIO.turrets.laserGain) break;
      let laserEntry;
      try { laserEntry = getWeaponBlueprint(event.weaponId).laserSound; } catch { break; }
      if (!laserEntry || !laserEntry.volume) break;
      if (event.entityId !== undefined) {
        audioManager.startLaserSound(event.entityId, 1, zoomVolume * laserEntry.volume * AUDIO.turrets.laserGain);
      }
    }
      break;
    case 'forceFieldStart': {
      if (!AUDIO.turrets.fireGain) break;
      let ffEntry;
      try { ffEntry = getWeaponBlueprint(event.weaponId).fireSound; } catch { break; }
      if (!ffEntry || !ffEntry.volume) break;
      if (event.entityId !== undefined) {
        audioManager.startForceFieldSound(event.entityId, ffEntry.playSpeed, zoomVolume * ffEntry.volume * AUDIO.turrets.fireGain);
      }
    }
      break;
    case 'projectileExpire':
      // No sound for projectile expiration (visual only)
      break;
  }
}

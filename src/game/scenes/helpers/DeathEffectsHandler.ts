// Death effects and audio event handling

import type { EntityRenderer } from '../../render/renderEntities';
import type { AudioEvent } from '../../sim/combat';
import { audioManager } from '../../audio/AudioManager';
import {
  LASER_SOUND_ENABLED,
  EXPLOSION_VELOCITY_MULTIPLIER,
  EXPLOSION_IMPACT_FORCE_MULTIPLIER,
  EXPLOSION_ATTACKER_DIRECTION_MULTIPLIER,
  EXPLOSION_BASE_MOMENTUM,
} from '../../../config';
import { magnitude } from '../../math';

// Get explosion radius based on weapon type
export function getExplosionRadius(weaponId: string): number {
  const weaponSizes: Record<string, number> = {
    gatling: 6,
    pulse: 7,
    beam: 5,
    shotgun: 10,
    mortar: 18,
    railgun: 8,
    cannon: 15,
    disruptor: 30,
  };
  return weaponSizes[weaponId] ?? 8;
}

// Handle audio events from simulation (or network)
export function handleAudioEvent(
  event: AudioEvent,
  entityRenderer: EntityRenderer,
  audioInitialized: boolean
): void {
  // Always handle visual effects even if audio not initialized
  if (event.type === 'hit' || event.type === 'projectileExpire') {
    // Add impact explosion at hit/termination location
    // Size based on weapon type (larger for heavy weapons)
    const explosionRadius = getExplosionRadius(event.weaponId);
    const explosionColor = 0xff8844; // Orange-ish for impacts
    entityRenderer.addExplosion(event.x, event.y, explosionRadius, explosionColor, 'impact');
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
      attackerY
    );
  }

  if (!audioInitialized) return;

  switch (event.type) {
    case 'fire':
      audioManager.playWeaponFire(event.weaponId);
      break;
    case 'hit':
      audioManager.playWeaponHit(event.weaponId);
      break;
    case 'death':
      audioManager.playUnitDeath(event.weaponId);
      break;
    case 'laserStart':
      // Only play laser sound if enabled in config
      if (LASER_SOUND_ENABLED && event.entityId !== undefined) {
        audioManager.startLaserSound(event.entityId);
      }
      break;
    case 'laserStop':
      // Always try to stop (in case config changed mid-game)
      if (event.entityId !== undefined) {
        audioManager.stopLaserSound(event.entityId);
      }
      break;
    case 'projectileExpire':
      // No sound for projectile expiration (visual only)
      break;
  }
}

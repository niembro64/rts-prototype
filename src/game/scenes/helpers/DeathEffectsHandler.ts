// Death effects and audio event handling

import type Phaser from 'phaser';
import type { EntityId, PlayerId } from '../../sim/types';
import { PLAYER_COLORS } from '../../sim/types';
import type { WorldState } from '../../sim/WorldState';
import type { Simulation } from '../../sim/Simulation';
import type { EntityRenderer } from '../../render/renderEntities';
import type { AudioEvent, DeathContext } from '../../sim/combat';
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
    scout: 6,
    burst: 7,
    beam: 5,
    brawl: 10,
    mortar: 18,
    snipe: 8,
    tank: 15,
    dgun: 30,
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

// Handle unit deaths (cleanup Matter bodies and audio)
// deathContexts contains info about the killing blow for directional explosions
export function handleUnitDeaths(
  world: WorldState,
  matter: Phaser.Physics.Matter.MatterPhysics,
  entityRenderer: EntityRenderer,
  deadUnitIds: EntityId[],
  deathContexts?: Map<EntityId, DeathContext>
): void {
  for (const id of deadUnitIds) {
    const entity = world.getEntity(id);
    if (entity) {
      // Add death explosion at 2.5x collision radius
      // Pass three separate momentum vectors for different explosion layers:
      // 1. Unit's own velocity - affects smoke, embers (trailing effect)
      // 2. Impact force from killing blow - affects debris, shockwaves (blown away)
      // 3. Attacker's projectile/beam direction - affects sparks (penetration effect)
      if (entity.unit) {
        const radius = entity.unit.collisionRadius * 2.5;
        const playerColor = entity.ownership?.playerId
          ? PLAYER_COLORS[entity.ownership.playerId]?.primary ?? 0xff6600
          : 0xff6600;

        // 1. Unit's velocity from physics body (scaled by multiplier)
        const bodyVel = (entity.body?.matterBody as { velocity?: { x: number; y: number } })?.velocity;
        const velocityX = (bodyVel?.x ?? 0) * EXPLOSION_VELOCITY_MULTIPLIER;
        const velocityY = (bodyVel?.y ?? 0) * EXPLOSION_VELOCITY_MULTIPLIER;

        // 2 & 3: Hit direction and attacker velocity from death context
        let penetrationX = 0;
        let penetrationY = 0;
        let attackerX = 0;
        let attackerY = 0;

        const ctx = deathContexts?.get(id);
        if (ctx) {
          // Hit direction (from hit point through unit center)
          penetrationX = ctx.penetrationDirX * EXPLOSION_IMPACT_FORCE_MULTIPLIER;
          penetrationY = ctx.penetrationDirY * EXPLOSION_IMPACT_FORCE_MULTIPLIER;

          // Attacker velocity (actual projectile velocity or beam direction * magnitude)
          // Scale by attack magnitude for bigger hits = bigger directional effect
          const attackScale = Math.min(ctx.attackMagnitude / 50, 2); // Normalize to ~1 for 50 damage
          attackerX = ctx.attackerVelX * EXPLOSION_ATTACKER_DIRECTION_MULTIPLIER * attackScale;
          attackerY = ctx.attackerVelY * EXPLOSION_ATTACKER_DIRECTION_MULTIPLIER * attackScale;
        }

        // Add base momentum to combined direction (gives minimum "oomph")
        // We add it to velocity since that's always present
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
          entity.transform.x,
          entity.transform.y,
          radius,
          playerColor,
          'death',
          baseVelX,
          baseVelY,
          penetrationX,
          penetrationY,
          attackerX,
          attackerY
        );
      }
      if (entity.body?.matterBody) {
        matter.world.remove(entity.body.matterBody);
      }
      // Stop any laser sound this unit was making
      audioManager.stopLaserSound(id);
    }
    world.removeEntity(id);
  }
}

// Handle building deaths (remove from world and clean up construction grid)
export function handleBuildingDeaths(
  world: WorldState,
  simulation: Simulation,
  deadBuildingIds: EntityId[]
): void {
  const constructionSystem = simulation.getConstructionSystem();
  for (const id of deadBuildingIds) {
    const entity = world.getEntity(id);
    if (entity) {
      // Clean up construction grid occupancy and energy production
      constructionSystem.onBuildingDestroyed(entity);
    }
    world.removeEntity(id);
  }
}

// Handle game over (last commander standing)
export function handleGameOver(
  winnerId: PlayerId,
  isGameOver: boolean,
  onGameOverUI: ((winnerId: PlayerId) => void) | undefined,
  input: Phaser.Input.InputPlugin,
  restartGame: () => void
): boolean {
  if (isGameOver) return true; // Already handled

  // Notify Vue UI to show game over modal
  onGameOverUI?.(winnerId);

  // Listen for R key to restart
  input.keyboard?.once('keydown-R', () => {
    restartGame();
  });

  return true;
}

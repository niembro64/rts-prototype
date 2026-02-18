// Standalone projectile rendering function extracted from EntityRenderer

import Phaser from 'phaser';
import type { Entity, EntityId } from '../sim/types';
import type { BeamRandomOffsets, LodLevel } from './types';
import { COLORS } from './types';
import { getPlayerColor, getProjectileColor } from './helpers';
import { getGraphicsConfig } from './graphicsSettings';
import { magnitude } from '../math';

export function renderProjectile(
  graphics: Phaser.GameObjects.Graphics,
  entity: Entity,
  beamRandomOffsets: Map<EntityId, BeamRandomOffsets>,
  lod: LodLevel,
  sprayParticleTime: number,
): void {
  if (!entity.projectile) return;

  const { transform, projectile, ownership } = entity;
  const { x, y } = transform;
  const config = projectile.config;
  const baseColor = getPlayerColor(ownership?.playerId);
  const color = getProjectileColor(baseColor);

  if (projectile.projectileType === 'beam') {
    const startX = projectile.startX ?? x;
    const startY = projectile.startY ?? y;
    const endX = projectile.endX ?? x;
    const endY = projectile.endY ?? y;
    const beamWidth = config.beamWidth ?? 2;
    const beamStyle = getGraphicsConfig().beamStyle;
    const hasCollision = projectile.obstructionT !== undefined;

    let randomOffsets = beamRandomOffsets.get(entity.id);
    if (!randomOffsets) {
      randomOffsets = {
        phaseOffset: Math.random() * Math.PI * 2,
        rotationOffset: Math.random() * Math.PI * 2,
        sizeScale: 0.8 + Math.random() * 0.4,
        pulseSpeed: 0.7 + Math.random() * 0.6,
      };
      beamRandomOffsets.set(entity.id, randomOffsets);
    }

    // Beam LOD: downgrade beam style but never upgrade beyond quality config
    let effectiveBeamStyle = beamStyle;
    if (lod === 'min') effectiveBeamStyle = 'simple';
    else if (lod === 'low' && beamStyle !== 'simple') effectiveBeamStyle = 'standard';

    // Outer glow layer (detailed/complex only)
    if (effectiveBeamStyle === 'detailed' || effectiveBeamStyle === 'complex') {
      graphics.lineStyle(beamWidth + 4, color, 0.3);
      graphics.lineBetween(startX, startY, endX, endY);
    }

    // Main beam line — always white
    graphics.lineStyle(beamWidth, 0xffffff, 1);
    graphics.lineBetween(startX, startY, endX, endY);

    // Endpoint ball — always drawn at collision radius, always white
    const collisionRadius = config.collisionRadius ?? beamWidth;
    graphics.fillStyle(0xffffff, 1);
    graphics.fillCircle(endX, endY, collisionRadius);

    // Collision-triggered damage radii highlights
    if (hasCollision) {
      const primaryRadius = config.primaryDamageRadius ?? (collisionRadius * 2 + 6);
      const secondaryRadius = config.secondaryDamageRadius ?? primaryRadius;

      if (lod === 'min' || lod === 'low') {
        // Simple: just primary + secondary filled circles
        graphics.fillStyle(color, 0.08);
        graphics.fillCircle(endX, endY, secondaryRadius);
        graphics.fillStyle(color, 0.15);
        graphics.fillCircle(endX, endY, primaryRadius);
      } else if (effectiveBeamStyle === 'standard') {
        // Standard: primary glow ring
        graphics.fillStyle(color, 0.15);
        graphics.fillCircle(endX, endY, primaryRadius);
      } else if (effectiveBeamStyle === 'detailed' || effectiveBeamStyle === 'complex') {
        // Detailed/complex: primary + secondary glow rings + sparks
        graphics.fillStyle(color, 0.08);
        graphics.fillCircle(endX, endY, secondaryRadius);
        graphics.fillStyle(color, 0.15);
        graphics.fillCircle(endX, endY, primaryRadius);

        const pulseTime = sprayParticleTime * randomOffsets.pulseSpeed;
        const sparkCount = effectiveBeamStyle === 'complex' ? 6 : 4;
        for (let i = 0; i < sparkCount; i++) {
          const baseAngle = (pulseTime / 150 + i / sparkCount) * Math.PI * 2;
          const angle = baseAngle + randomOffsets.rotationOffset;
          const sparkDist = primaryRadius * (0.8 + Math.sin(pulseTime / 50 + i * 2 + randomOffsets.phaseOffset) * 0.4);
          const sx = endX + Math.cos(angle) * sparkDist;
          const sy = endY + Math.sin(angle) * sparkDist;
          graphics.fillStyle(color, 0.7);
          graphics.fillCircle(sx, sy, 2);
        }
      }
    }
  } else if (entity.dgunProjectile) {
    const radius = config.projectileRadius ?? 25;

    if (lod === 'min') {
      // Min: just a colored circle
      graphics.fillStyle(color, 1);
      graphics.fillCircle(x, y, radius);
    } else if (lod === 'low') {
      // Low: colored circle + inner glow, no trail/pulse
      graphics.fillStyle(color, 0.9);
      graphics.fillCircle(x, y, radius);
      graphics.fillStyle(0xffff00, 0.8);
      graphics.fillCircle(x, y, radius * 0.5);
    } else {
      const pulsePhase = (projectile.timeAlive / 100) % 1;
      const pulseRadius = radius * (1.3 + 0.2 * Math.sin(pulsePhase * Math.PI * 2));

      graphics.fillStyle(0xff4400, 0.3);
      graphics.fillCircle(x, y, pulseRadius);
      graphics.fillStyle(0xff6600, 0.5);
      graphics.fillCircle(x, y, radius * 1.1);
      graphics.fillStyle(color, 0.9);
      graphics.fillCircle(x, y, radius);
      graphics.fillStyle(0xffff00, 0.8);
      graphics.fillCircle(x, y, radius * 0.5);
      graphics.fillStyle(0xffffff, 1);
      graphics.fillCircle(x, y, radius * 0.2);

      const velMag = magnitude(projectile.velocityX, projectile.velocityY);
      if (velMag > 0) {
        const dirX = projectile.velocityX / velMag;
        const dirY = projectile.velocityY / velMag;
        for (let i = 1; i <= 5; i++) {
          const trailX = x - dirX * i * radius * 0.8;
          const trailY = y - dirY * i * radius * 0.8;
          const alpha = 0.6 - i * 0.1;
          const trailRadius = radius * (0.8 - i * 0.12);
          if (alpha > 0 && trailRadius > 0) {
            graphics.fillStyle(0xff4400, alpha);
            graphics.fillCircle(trailX, trailY, trailRadius);
          }
        }
      }
    }
  } else {
    const radius = config.projectileRadius ?? 5;

    if (lod === 'min') {
      // Min: just a colored circle
      graphics.fillStyle(color, 1);
      graphics.fillCircle(x, y, radius);
    } else if (lod === 'low') {
      // Low: colored circle + inner white dot, no trail
      graphics.fillStyle(color, 0.9);
      graphics.fillCircle(x, y, radius);
      graphics.fillStyle(0xffffff, 0.8);
      graphics.fillCircle(x, y, radius * 0.4);
    } else {
      const trailLength = config.trailLength ?? 3;
      const velMag = magnitude(projectile.velocityX, projectile.velocityY);

      if (velMag > 0) {
        const dirX = projectile.velocityX / velMag;
        const dirY = projectile.velocityY / velMag;
        for (let i = 1; i <= trailLength; i++) {
          const trailX = x - dirX * i * radius * 1.5;
          const trailY = y - dirY * i * radius * 1.5;
          const alpha = 0.5 - i * 0.15;
          const trailRadius = radius * (1 - i * 0.2);
          if (alpha > 0 && trailRadius > 0) {
            graphics.fillStyle(color, alpha);
            graphics.fillCircle(trailX, trailY, trailRadius);
          }
        }
      }

      graphics.fillStyle(color, 0.9);
      graphics.fillCircle(x, y, radius);
      graphics.fillStyle(0xffffff, 0.8);
      graphics.fillCircle(x, y, radius * 0.4);
    }
  }
}

/**
 * Render proj range circles (collision, primary, secondary radii) on in-flight projectiles.
 * For beams, shows primary/secondary circles at the endpoint.
 * Called when any proj range toggle is active.
 */
export function renderProjRangeCircles(
  graphics: Phaser.GameObjects.Graphics,
  entity: Entity,
  visibility: { collision: boolean; primary: boolean; secondary: boolean },
): void {
  if (!entity.projectile) return;
  const proj = entity.projectile;
  const config = proj.config;

  if (proj.projectileType === 'beam') {
    const endX = proj.endX ?? entity.transform.x;
    const endY = proj.endY ?? entity.transform.y;
    const collisionRadius = config.collisionRadius ?? config.beamWidth ?? 2;
    const primaryRadius = config.primaryDamageRadius ?? (collisionRadius * 2 + 6);

    if (visibility.collision) {
      graphics.lineStyle(1, COLORS.PROJ_COLLISION_RANGE, 0.5);
      graphics.strokeCircle(endX, endY, collisionRadius);
    }
    if (visibility.primary) {
      graphics.lineStyle(1, COLORS.PROJ_PRIMARY_RANGE, 0.3);
      graphics.strokeCircle(endX, endY, primaryRadius);
    }
    if (visibility.secondary && config.secondaryDamageRadius) {
      graphics.lineStyle(1, COLORS.PROJ_SECONDARY_RANGE, 0.3);
      graphics.strokeCircle(endX, endY, config.secondaryDamageRadius);
    }
    return;
  }

  const { x, y } = entity.transform;

  if (visibility.collision) {
    const radius = config.projectileRadius ?? 5;
    graphics.lineStyle(1, COLORS.PROJ_COLLISION_RANGE, 0.5);
    graphics.strokeCircle(x, y, radius);
  }

  if (visibility.primary && config.primaryDamageRadius && !proj.hasExploded) {
    graphics.lineStyle(1, COLORS.PROJ_PRIMARY_RANGE, 0.3);
    graphics.strokeCircle(x, y, config.primaryDamageRadius);
  }

  if (visibility.secondary && config.secondaryDamageRadius && !proj.hasExploded) {
    graphics.lineStyle(1, COLORS.PROJ_SECONDARY_RANGE, 0.3);
    graphics.strokeCircle(x, y, config.secondaryDamageRadius);
  }
}

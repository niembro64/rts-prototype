// Standalone projectile rendering function extracted from EntityRenderer

import Phaser from 'phaser';
import type { Entity, EntityId } from '../sim/types';
import type { BeamRandomOffsets, LodLevel } from './types';
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

    // Beam LOD: at low zoom, downgrade beam style to reduce draw calls
    const effectiveBeamStyle = lod === 'min' ? 'simple' : lod === 'low' ? 'standard' : beamStyle;

    if (effectiveBeamStyle === 'detailed' || effectiveBeamStyle === 'complex') {
      graphics.lineStyle(beamWidth + 4, color, 0.3);
      graphics.lineBetween(startX, startY, endX, endY);
    }

    const beamAlpha = effectiveBeamStyle === 'simple' ? 1 : 0.9;
    graphics.lineStyle(beamWidth, color, beamAlpha);
    graphics.lineBetween(startX, startY, endX, endY);

    if (effectiveBeamStyle !== 'simple') {
      graphics.lineStyle(beamWidth / 2, 0xffffff, 1);
      graphics.lineBetween(startX, startY, endX, endY);
    }

    const baseRadius = beamWidth * 2 + 6;
    const explosionRadius = baseRadius * randomOffsets.sizeScale;

    if (effectiveBeamStyle === 'simple') {
      graphics.fillStyle(color, 1);
      graphics.fillCircle(endX, endY, explosionRadius);
    } else if (effectiveBeamStyle === 'standard') {
      graphics.fillStyle(color, 0.6);
      graphics.fillCircle(endX, endY, explosionRadius);
      graphics.fillStyle(0xffffff, 0.8);
      graphics.fillCircle(endX, endY, explosionRadius * 0.4);
    } else {
      graphics.fillStyle(color, 0.4);
      graphics.fillCircle(endX, endY, explosionRadius * 1.3);
      graphics.fillStyle(color, 0.6);
      graphics.fillCircle(endX, endY, explosionRadius);
      graphics.fillStyle(0xffffff, 0.8);
      graphics.fillCircle(endX, endY, explosionRadius * 0.4);

      const pulseTime = sprayParticleTime * randomOffsets.pulseSpeed;
      const sparkCount = effectiveBeamStyle === 'complex' ? 6 : 4;
      for (let i = 0; i < sparkCount; i++) {
        const baseAngle = (pulseTime / 150 + i / sparkCount) * Math.PI * 2;
        const angle = baseAngle + randomOffsets.rotationOffset;
        const sparkDist = explosionRadius * (0.8 + Math.sin(pulseTime / 50 + i * 2 + randomOffsets.phaseOffset) * 0.4);
        const sx = endX + Math.cos(angle) * sparkDist;
        const sy = endY + Math.sin(angle) * sparkDist;
        graphics.fillStyle(color, 0.7);
        graphics.fillCircle(sx, sy, 2);
      }
    }
  } else if (entity.dgunProjectile) {
    const radius = config.projectileRadius ?? 25;
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
  } else {
    const radius = config.projectileRadius ?? 5;
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

    if (config.splashRadius && !projectile.hasExploded) {
      graphics.lineStyle(1, color, 0.2);
      graphics.strokeCircle(x, y, config.splashRadius);
    }
  }
}

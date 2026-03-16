// Standalone projectile rendering function extracted from EntityRenderer

import Phaser from 'phaser';
import type { Entity, EntityId } from '../sim/types';
import { isLineShot } from '../sim/types';
import type { BeamRandomOffsets, ProjectileTrail } from './types';
import { COLORS } from './types';
import { getPlayerColor, getProjectileColor } from './helpers';
import { getGraphicsConfig } from '@/clientBarConfig';
import type { ProjectileStyle } from '@/types/graphics';

/** Rank ordering for projectile style (used for >= comparisons) */
const PROJ_STYLE_RANK: Record<ProjectileStyle, number> = {
  dot: 0,
  core: 1,
  trail: 2,
  glow: 3,
  full: 4,
};
function projStyleAtLeast(
  style: ProjectileStyle,
  threshold: ProjectileStyle,
): boolean {
  return PROJ_STYLE_RANK[style] >= PROJ_STYLE_RANK[threshold];
}

/**
 * Read position i from a ProjectileTrail ring buffer.
 * i=0 is the most recent sample, i=1 is one step older, etc.
 */
function trailPos(
  trail: ProjectileTrail,
  i: number,
  out: { x: number; y: number },
): boolean {
  if (i >= trail.count) return false;
  const idx = ((trail.head - 1 - i + trail.capacity) % trail.capacity) * 2;
  out.x = trail.positions[idx];
  out.y = trail.positions[idx + 1];
  return true;
}

// Reusable point object to avoid per-frame allocation
const _tp = { x: 0, y: 0 };

export function renderProjectile(
  graphics: Phaser.GameObjects.Graphics,
  entity: Entity,
  beamRandomOffsets: Map<EntityId, BeamRandomOffsets>,
  sprayParticleTime: number,
  trail: ProjectileTrail | undefined,
): void {
  if (!entity.projectile) return;

  const { transform, projectile, ownership } = entity;
  const { x, y } = transform;
  const config = projectile.config;
  const baseColor = getPlayerColor(ownership?.playerId);
  const color = getProjectileColor(baseColor);

  if (projectile.projectileType === 'beam' || projectile.projectileType === 'laser') {
    renderBeam(
      graphics,
      entity,
      beamRandomOffsets,
      sprayParticleTime,
      x,
      y,
      color,
    );
  } else if (entity.dgunProjectile) {
    renderDgun(graphics, x, y, color, projectile, config, trail);
  } else {
    renderRegular(graphics, x, y, color, config, trail);
  }
}

// ==================== BEAM ====================

function renderBeam(
  graphics: Phaser.GameObjects.Graphics,
  entity: Entity,
  beamRandomOffsets: Map<EntityId, BeamRandomOffsets>,
  sprayParticleTime: number,
  x: number,
  y: number,
  color: number,
): void {
  const projectile = entity.projectile!;
  const config = projectile.config;
  const startX = projectile.startX ?? x;
  const startY = projectile.startY ?? y;
  const endX = projectile.endX ?? x;
  const endY = projectile.endY ?? y;
  const beamWidth = isLineShot(config.shot) ? config.shot.width : 2;
  const beamStyle = getGraphicsConfig().beamStyle;
  const hasCollision = projectile.obstructionT !== undefined ||
    (projectile.reflections !== undefined && projectile.reflections.length > 0);

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

  const reflections = projectile.reflections;
  const hasReflections = reflections && reflections.length > 0;

  // Build segment list: start → bounce1 → bounce2 → ... → end
  if (hasReflections) {
    // Multi-segment beam through reflection points
    let prevSegX = startX;
    let prevSegY = startY;

    for (const refl of reflections) {
      if (beamStyle === 'detailed' || beamStyle === 'complex') {
        graphics.lineStyle(beamWidth + 4, color, 0.1);
        graphics.lineBetween(prevSegX, prevSegY, refl.x, refl.y);
      }
      graphics.lineStyle(beamWidth, 0xffffff, 0.33);
      graphics.lineBetween(prevSegX, prevSegY, refl.x, refl.y);
      prevSegX = refl.x;
      prevSegY = refl.y;
    }
    // Final segment: last bounce → end
    if (beamStyle === 'detailed' || beamStyle === 'complex') {
      graphics.lineStyle(beamWidth + 4, color, 0.1);
      graphics.lineBetween(prevSegX, prevSegY, endX, endY);
    }
    graphics.lineStyle(beamWidth, 0xffffff, 0.33);
    graphics.lineBetween(prevSegX, prevSegY, endX, endY);

    // Draw reflection circles at each bounce point
    for (const refl of reflections) {
      graphics.fillStyle(0xffffff, 0.9);
      graphics.fillCircle(refl.x, refl.y, beamWidth + 2);
      graphics.fillStyle(color, 0.4);
      graphics.fillCircle(refl.x, refl.y, beamWidth + 5);
    }
  } else {
    // Single-segment beam (existing code path)
    if (beamStyle === 'detailed' || beamStyle === 'complex') {
      graphics.lineStyle(beamWidth + 4, color, 0.1);
      graphics.lineBetween(startX, startY, endX, endY);
    }
    graphics.lineStyle(beamWidth, 0xffffff, 0.33);
    graphics.lineBetween(startX, startY, endX, endY);
  }

  // Endpoint ball — always drawn at beam radius, semi-transparent white
  const beamRadius = isLineShot(config.shot) ? config.shot.radius : beamWidth;
  graphics.fillStyle(0xffffff, 0.33);
  graphics.fillCircle(endX, endY, beamRadius);

  // Collision-triggered damage radius highlight
  if (hasCollision) {
    const primaryRadius = beamRadius;
    const secondaryRadius = primaryRadius;

    if (beamStyle === 'simple') {
      graphics.fillStyle(color, 0.08);
      graphics.fillCircle(endX, endY, secondaryRadius);
      graphics.fillStyle(color, 0.15);
      graphics.fillCircle(endX, endY, primaryRadius);
    } else if (beamStyle === 'standard') {
      graphics.fillStyle(color, 0.15);
      graphics.fillCircle(endX, endY, primaryRadius);
    } else if (beamStyle === 'detailed' || beamStyle === 'complex') {
      graphics.fillStyle(color, 0.08);
      graphics.fillCircle(endX, endY, secondaryRadius);
      graphics.fillStyle(color, 0.15);
      graphics.fillCircle(endX, endY, primaryRadius);

      const pulseTime = sprayParticleTime * randomOffsets.pulseSpeed;
      const sparkCount = beamStyle === 'complex' ? 6 : 4;
      for (let i = 0; i < sparkCount; i++) {
        const baseAngle = (pulseTime / 150 + i / sparkCount) * Math.PI * 2;
        const angle = baseAngle + randomOffsets.rotationOffset;
        const sparkDist =
          primaryRadius *
          (0.8 +
            Math.sin(pulseTime / 50 + i * 2 + randomOffsets.phaseOffset) * 0.4);
        const sx = endX + Math.cos(angle) * sparkDist;
        const sy = endY + Math.sin(angle) * sparkDist;
        graphics.fillStyle(color, 0.7);
        graphics.fillCircle(sx, sy, 2);
      }
    }
  }
}

// ==================== REGULAR PROJECTILE (5-tier) ====================

function renderRegular(
  graphics: Phaser.GameObjects.Graphics,
  x: number,
  y: number,
  color: number,
  config: Entity['projectile'] extends infer P
    ? P extends { config: infer C }
      ? C
      : never
    : never,
  trail: ProjectileTrail | undefined,
): void {
  const radius = config.shot.type === 'projectile' ? config.shot.collision.radius : 5;
  const trailLength = config.shot.type === 'projectile' ? (config.shot.trailLength ?? 3) : 3;
  const pStyle = getGraphicsConfig().projectileStyle;

  if (pStyle === 'dot') {
    // Dot: colored circle only
    graphics.fillStyle(color, 1);
    graphics.fillCircle(x, y, radius);
    return;
  }

  if (pStyle === 'core') {
    // Core: colored circle + white inner dot
    graphics.fillStyle(color, 0.9);
    graphics.fillCircle(x, y, radius);
    graphics.fillStyle(0xffffff, 0.8);
    graphics.fillCircle(x, y, radius * 0.4);
    return;
  }

  // trail / glow / full all use position-history trails
  const maxTrailPts = pStyle === 'full' ? trailLength + 2 : trailLength;

  // Draw trail (oldest first so head paints on top)
  if (trail && trail.count > 1) {
    const pts = Math.min(maxTrailPts, trail.count - 1); // skip index 0 (current pos)

    // Full: contrail lines connecting trail points
    if (pStyle === 'full' && pts >= 2) {
      graphics.lineStyle(1, color, 0.25);
      let prevOk = trailPos(trail, 1, _tp);
      let prevX = _tp.x,
        prevY = _tp.y;
      for (let i = 2; i <= pts; i++) {
        if (trailPos(trail, i, _tp)) {
          if (prevOk) graphics.lineBetween(prevX, prevY, _tp.x, _tp.y);
          prevX = _tp.x;
          prevY = _tp.y;
          prevOk = true;
        } else {
          prevOk = false;
        }
      }
      // Connect most recent trail point to current position
      if (prevOk || trailPos(trail, 1, _tp)) {
        const connX = prevOk ? prevX : _tp.x;
        const connY = prevOk ? prevY : _tp.y;
        graphics.lineBetween(connX, connY, x, y);
      }
    }

    for (let i = pts; i >= 1; i--) {
      if (!trailPos(trail, i, _tp)) continue;
      const t = i / (pts + 1); // 0→1 from newest to oldest
      const alpha = 0.5 * (1 - t);
      const trailR = radius * (1 - t * 0.6);
      if (alpha > 0 && trailR > 0) {
        graphics.fillStyle(color, alpha);
        graphics.fillCircle(_tp.x, _tp.y, trailR);

        // Glow+Full: trail circles get white inner dots
        if (projStyleAtLeast(pStyle, 'glow')) {
          graphics.fillStyle(0xffffff, alpha * 0.6);
          graphics.fillCircle(_tp.x, _tp.y, trailR * 0.35);
        }
      }
    }
  }

  // Glow+Full: outer glow ring
  if (projStyleAtLeast(pStyle, 'glow')) {
    graphics.fillStyle(color, 0.3);
    graphics.fillCircle(x, y, radius * 1.4);
  }

  // Full: pulsing glow halo
  if (pStyle === 'full') {
    const pulse = 0.15 + 0.1 * Math.sin(Date.now() / 80);
    graphics.fillStyle(color, pulse);
    graphics.fillCircle(x, y, radius * 1.8);
  }

  // Core: colored circle + white inner dot
  graphics.fillStyle(color, 0.9);
  graphics.fillCircle(x, y, radius);
  graphics.fillStyle(0xffffff, 0.8);
  graphics.fillCircle(x, y, radius * 0.4);
}

// ==================== DGUN PROJECTILE (5-tier) ====================

function renderDgun(
  graphics: Phaser.GameObjects.Graphics,
  x: number,
  y: number,
  color: number,
  projectile: NonNullable<Entity['projectile']>,
  config: NonNullable<Entity['projectile']>['config'],
  trail: ProjectileTrail | undefined,
): void {
  const radius = config.shot.type === 'projectile' ? config.shot.collision.radius : 25;
  const pStyle = getGraphicsConfig().projectileStyle;

  if (pStyle === 'dot') {
    graphics.fillStyle(color, 1);
    graphics.fillCircle(x, y, radius);
    return;
  }

  if (pStyle === 'core') {
    graphics.fillStyle(color, 0.9);
    graphics.fillCircle(x, y, radius);
    graphics.fillStyle(0xffff00, 0.8);
    graphics.fillCircle(x, y, radius * 0.5);
    return;
  }

  // Determine trail point count by tier
  const trailPts = pStyle === 'full' ? 7 : pStyle === 'glow' ? 5 : 3;

  // Draw trail from position history (oldest first)
  if (trail && trail.count > 1) {
    const pts = Math.min(trailPts, trail.count - 1);

    // Full: contrail lines
    if (pStyle === 'full' && pts >= 2) {
      graphics.lineStyle(2, 0xff4400, 0.2);
      let prevOk = trailPos(trail, 1, _tp);
      let prevX = _tp.x,
        prevY = _tp.y;
      for (let i = 2; i <= pts; i++) {
        if (trailPos(trail, i, _tp)) {
          if (prevOk) graphics.lineBetween(prevX, prevY, _tp.x, _tp.y);
          prevX = _tp.x;
          prevY = _tp.y;
          prevOk = true;
        } else {
          prevOk = false;
        }
      }
      if (prevOk || trailPos(trail, 1, _tp)) {
        const connX = prevOk ? prevX : _tp.x;
        const connY = prevOk ? prevY : _tp.y;
        graphics.lineBetween(connX, connY, x, y);
      }
    }

    for (let i = pts; i >= 1; i--) {
      if (!trailPos(trail, i, _tp)) continue;
      const t = i / (pts + 1);
      const alpha = 0.6 * (1 - t);
      const trailR = radius * (0.8 - t * 0.4);
      if (alpha > 0 && trailR > 0) {
        graphics.fillStyle(0xff4400, alpha);
        graphics.fillCircle(_tp.x, _tp.y, trailR);

        // Full: trail points get inner glow
        if (pStyle === 'full') {
          graphics.fillStyle(0xffff00, alpha * 0.4);
          graphics.fillCircle(_tp.x, _tp.y, trailR * 0.4);
        }
      }
    }
  }

  const pulsePhase = (projectile.timeAlive / 100) % 1;

  // Glow+Full: pulsing outer radius
  if (projStyleAtLeast(pStyle, 'glow')) {
    const pulseRadius =
      radius * (1.3 + 0.2 * Math.sin(pulsePhase * Math.PI * 2));
    graphics.fillStyle(0xff4400, 0.3);
    graphics.fillCircle(x, y, pulseRadius);
  }

  // Full: secondary shimmer ring (out-of-phase)
  if (pStyle === 'full') {
    const shimmerRadius =
      radius * (1.5 + 0.15 * Math.sin(pulsePhase * Math.PI * 2 + Math.PI));
    graphics.fillStyle(0xff6600, 0.15);
    graphics.fillCircle(x, y, shimmerRadius);
  }

  // Trail: orange glow
  if (pStyle === 'trail') {
    graphics.fillStyle(0xff4400, 0.25);
    graphics.fillCircle(x, y, radius * 1.2);
  }

  // Core layers (trail+)
  graphics.fillStyle(0xff6600, 0.5);
  graphics.fillCircle(x, y, radius * 1.1);
  graphics.fillStyle(color, 0.9);
  graphics.fillCircle(x, y, radius);
  graphics.fillStyle(0xffff00, 0.8);
  graphics.fillCircle(x, y, radius * 0.5);
  graphics.fillStyle(0xffffff, 1);
  graphics.fillCircle(x, y, radius * 0.2);
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

  if ((proj.projectileType === 'beam' || proj.projectileType === 'laser') && isLineShot(config.shot)) {
    const endX = proj.endX ?? entity.transform.x;
    const endY = proj.endY ?? entity.transform.y;
    const beamRadius = config.shot.radius;

    if (visibility.collision || visibility.primary) {
      graphics.lineStyle(1, COLORS.PROJ_PRIMARY_RANGE, 0.3);
      graphics.strokeCircle(endX, endY, beamRadius);
    }
    return;
  }

  const { x, y } = entity.transform;

  if (visibility.collision && config.shot.type === 'projectile') {
    graphics.lineStyle(1, COLORS.PROJ_COLLISION_RANGE, 0.5);
    graphics.strokeCircle(x, y, config.shot.collision.radius);
  }

  if (
    visibility.primary &&
    config.shot.type === 'projectile' &&
    config.shot.explosion?.primary.radius &&
    !proj.hasExploded
  ) {
    graphics.lineStyle(1, COLORS.PROJ_PRIMARY_RANGE, 0.3);
    graphics.strokeCircle(x, y, config.shot.explosion.primary.radius);
  }

  if (
    visibility.secondary &&
    config.shot.type === 'projectile' &&
    config.shot.explosion?.secondary.radius &&
    !proj.hasExploded
  ) {
    graphics.lineStyle(1, COLORS.PROJ_SECONDARY_RANGE, 0.3);
    graphics.strokeCircle(x, y, config.shot.explosion.secondary.radius);
  }
}

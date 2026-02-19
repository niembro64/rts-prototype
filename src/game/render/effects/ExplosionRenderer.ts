// Explosion effect renderer - handles all explosion visual styles

import Phaser from 'phaser';
import type { ExplosionEffect } from '../types';
import { getGraphicsConfig, getEffectiveQuality } from '../graphicsSettings';
import { clamp01, angleDiff as computeAngleDiff } from '../../math';
import { FIRE_EXPLOSION } from '../../../config';

/**
 * Render an explosion effect based on current graphics settings.
 * Quality is determined solely by zoom-based graphics config.
 */
export function renderExplosion(
  graphics: Phaser.GameObjects.Graphics,
  exp: ExplosionEffect,
): void {
  const progress = exp.elapsed / exp.lifetime;

  // Impact explosions use their own 5-tier renderer
  if (exp.type === 'impact') {
    renderImpact(graphics, exp, progress);
    return;
  }

  // Death explosions use the existing quality-based renderers
  const gfxConfig = getGraphicsConfig();
  const explosionStyle = gfxConfig.explosions;

  if (explosionStyle === 'one-simple-circle') {
    renderSimpleCircle(graphics, exp, progress);
  } else if (explosionStyle === 'three-velocity-circles') {
    renderVelocityCircles(graphics, exp, progress);
  } else if (explosionStyle === 'three-velocity-chunks') {
    renderVelocityChunks(graphics, exp, progress);
  } else {
    renderComplexExplosion(graphics, exp, progress);
  }
}

// ==================== IMPACT (FLAME) EXPLOSION ====================
// Single renderer for ALL impact explosions across all 5 LOD tiers.
// Every tier renders ALL 6 required elements:
//   1. Something starting at collisionRadius
//   2. Something starting at primaryRadius
//   3. Something starting at secondaryRadius
//   4. Something moving with projectile velocity (attacker direction)
//   5. Something moving with entity velocity
//   6. Something moving with penetration vector (proj→entity)
//
// LOD controls particle COUNT, trail LENGTH, and detail — never presence/absence.
//   MIN:  1 particle per element, no trails            (~12 draws)
//   LOW:  1-2 particles, no trails, hot core           (~18 draws)
//   MED:  2-4 particles, no trails, center drift       (~30 draws)
//   HIGH: 4-7 particles, short trails                  (~45 draws)
//   MAX:  6-12 particles, long trails, embers          (~65 draws)

function renderImpact(
  graphics: Phaser.GameObjects.Graphics,
  exp: ExplosionEffect,
  progress: number,
): void {
  const C = FIRE_EXPLOSION;
  const CC = C.colors;
  const quality = getEffectiveQuality();
  const qIdx = quality === 'min' ? 0 : quality === 'low' ? 1 : quality === 'medium' ? 2 : quality === 'high' ? 3 : 4;

  const alpha = 1 - progress * progress;
  const seed = (exp.x * 1000 + exp.y) % 10000;
  const seededRandom = createSeededRandom(seed);

  // Resolve radii
  const collR = exp.collisionRadius ?? exp.radius * 0.3;
  const primR = exp.primaryRadius ?? exp.radius;
  const secR = exp.secondaryRadius ?? primR * 1.5;

  // Direction data (all elements render even when magnitude is zero)
  const velMag = exp.velocityMag ?? 0;
  const penMag = exp.penetrationMag ?? 0;
  const attackMag = exp.attackerMag ?? 0;
  const combinedMag = exp.combinedMag ?? 0;

  const velDirX = velMag > 0.01 ? (exp.velocityX ?? 0) / velMag : 0;
  const velDirY = velMag > 0.01 ? (exp.velocityY ?? 0) / velMag : 0;
  const penDirX = penMag > 0.01 ? (exp.penetrationX ?? 0) / penMag : 0;
  const penDirY = penMag > 0.01 ? (exp.penetrationY ?? 0) / penMag : 0;
  const attackDirX = attackMag > 0.01 ? (exp.attackerX ?? 0) / attackMag : 0;
  const attackDirY = attackMag > 0.01 ? (exp.attackerY ?? 0) / attackMag : 0;

  const velStr = Math.min(velMag / C.strengthNormalize, C.strengthMax);
  const penStr = Math.min(penMag / C.strengthNormalize, C.strengthMax);
  const attackStr = Math.min(attackMag / C.strengthNormalize, C.strengthMax);
  const sFloor = C.strengthFloor;

  // Center drift (scaled by LOD)
  let cx = exp.x;
  let cy = exp.y;
  if (combinedMag > 0.01) {
    const drift = primR * C.driftScale[qIdx] * progress * Math.min(combinedMag / C.driftNormalize, 1);
    cx += ((exp.combinedX ?? 0) / combinedMag) * drift;
    cy += ((exp.combinedY ?? 0) / combinedMag) * drift;
  }

  // Per-LOD tuning
  const countMult = C.countMult[qIdx];
  const tMult = C.trailMult[qIdx];
  const hasTrails = tMult > 0;

  // ======================================================================
  // ELEMENT 1: COLLISION-RADIUS ZONE — core fireball expanding from collR
  // ======================================================================
  const coreR = collR + (primR * C.coreExpandTarget - collR) * progress;
  const coreFade = Math.max(0, 1 - progress * C.coreFadeRate);
  if (coreFade > 0) {
    graphics.fillStyle(CC.coreGlow, alpha * 0.3 * coreFade);
    graphics.fillCircle(cx, cy, coreR * C.coreGlowScale);
    graphics.fillStyle(CC.coreFireball, alpha * 0.55 * coreFade);
    graphics.fillCircle(cx, cy, coreR);
    if (qIdx >= 1) {
      graphics.fillStyle(CC.coreHot, alpha * 0.6 * coreFade);
      graphics.fillCircle(cx, cy, coreR * 0.5);
      graphics.fillStyle(CC.coreWhite, alpha * 0.7 * coreFade);
      graphics.fillCircle(cx, cy, coreR * 0.2);
    }
  }

  // ======================================================================
  // ELEMENT 2: PRIMARY-RADIUS ZONE — expanding glow ring at primR
  // ======================================================================
  const primGlowR = primR * (C.primaryGlowStart + progress * C.primaryGlowExpand);
  const primFade = Math.max(0, 1 - progress * C.primaryFadeRate);
  if (primFade > 0) {
    graphics.fillStyle(CC.primaryGlow, alpha * C.primaryGlowAlpha * primFade);
    graphics.fillCircle(cx, cy, primGlowR);
    graphics.lineStyle(1.5 + qIdx * 0.3, CC.primaryRing, alpha * 0.25 * primFade);
    graphics.strokeCircle(cx, cy, primGlowR);
  }

  // ======================================================================
  // ELEMENT 3: SECONDARY-RADIUS ZONE — expanding glow + ring + particles at secR
  // ======================================================================
  const secGlowR = secR * (C.secondaryGlowStart + progress * C.secondaryGlowExpand);
  const secFade = Math.max(0, 1 - progress * C.secondaryFadeRate);
  if (secFade > 0) {
    graphics.fillStyle(CC.secondaryGlow, alpha * C.secondaryGlowAlpha * secFade);
    graphics.fillCircle(cx, cy, secGlowR);
    graphics.lineStyle(1 + qIdx * 0.2, CC.secondaryRing, alpha * 0.18 * secFade);
    graphics.strokeCircle(cx, cy, secGlowR);
  }

  // Secondary-zone particles (originate from secR, move outward along penetration)
  {
    const count = Math.max(1, Math.floor(countMult * (1 + penStr)));
    for (let i = 0; i < count; i++) {
      const delay = seededRandom(i + 500) * 0.08;
      const p = Math.max(0, (progress - delay) * 1.3);
      if (p <= 0 || p > 1) continue;

      const spread = (seededRandom(i + 501) - 0.5) * C.secParticleSpread;
      const angle = Math.atan2(penDirY, penDirX) + spread;
      const speed = 0.4 + seededRandom(i + 502) * 0.5;
      const dist = secR * 0.6 + secR * p * C.secParticleDistMult * speed;
      const px = cx + Math.cos(angle) * dist;
      const py = cy + Math.sin(angle) * dist;

      const pFade = 1 - p;
      const pSize = (C.secParticleSizeBase + seededRandom(i + 503) * C.secParticleSizeRange) * pFade;
      if (pSize > 0.8 && pFade > 0.05) {
        if (hasTrails) {
          const tLen = Math.min(dist * 0.3, C.secParticleTrailMax) * pFade * tMult;
          if (tLen > 1.5) {
            graphics.lineStyle(pSize * 0.4, CC.secondaryRing, alpha * 0.2 * pFade);
            graphics.lineBetween(px - Math.cos(angle) * tLen, py - Math.sin(angle) * tLen, px, py);
          }
        }
        graphics.fillStyle(CC.secParticle, alpha * 0.4 * pFade);
        graphics.fillCircle(px, py, pSize);
      }
    }
  }

  // ======================================================================
  // ELEMENT 4: PROJECTILE-VELOCITY SPARKS — originate from collR, move along attacker dir
  // ======================================================================
  {
    const count = Math.max(1, Math.floor(countMult * (1 + attackStr)));
    for (let i = 0; i < count; i++) {
      const delay = seededRandom(i + 300) * 0.08;
      const p = Math.max(0, (progress - delay) * 1.4);
      if (p <= 0 || p > 1) continue;

      const spread = (seededRandom(i + 301) - 0.5) * C.sparkSpread;
      const angle = Math.atan2(attackDirY, attackDirX) + spread;
      const speed = 0.8 + seededRandom(i + 302) * 0.8;
      const dist = collR * 0.8 + primR * p * C.sparkDistMult * speed * Math.max(attackStr, sFloor);
      const px = cx + Math.cos(angle) * dist;
      const py = cy + Math.sin(angle) * dist;

      const pFade = 1 - p;
      const pSize = (C.sparkSizeBase + seededRandom(i + 303) * C.sparkSizeRange) * pFade;
      if (pSize > 0.8 && pFade > 0.05) {
        if (hasTrails) {
          const tLen = Math.min(dist * 0.3, C.sparkTrailMax) * pFade * tMult;
          if (tLen > 1.5) {
            graphics.lineStyle(pSize * 0.5, CC.sparkTrail, alpha * 0.3 * pFade);
            graphics.lineBetween(px - Math.cos(angle) * tLen, py - Math.sin(angle) * tLen, px, py);
          }
        }
        graphics.fillStyle(CC.sparkFill, alpha * 0.7 * pFade);
        graphics.fillCircle(px, py, pSize);
        if (qIdx >= 1) {
          graphics.fillStyle(CC.sparkCenter, alpha * 0.5 * pFade);
          graphics.fillCircle(px, py, pSize * 0.4);
        }
      }
    }
  }

  // ======================================================================
  // ELEMENT 5: ENTITY-VELOCITY SMOKE — originate from primR, move along entity vel
  // ======================================================================
  {
    const count = Math.max(1, Math.floor(countMult * (1 + velStr * 0.5)));
    for (let i = 0; i < count; i++) {
      const delay = seededRandom(i + 400) * 0.1;
      const p = Math.max(0, (progress - delay) * 1.5);
      if (p <= 0 || p > 1) continue;

      const spread = (seededRandom(i + 401) - 0.5) * C.smokeSpread;
      const angle = Math.atan2(velDirY, velDirX) + spread;
      const speed = 0.5 + seededRandom(i + 402) * 0.5;
      const dist = primR * 0.5 + primR * p * C.smokeDistMult * speed * Math.max(velStr, sFloor);
      const px = cx + Math.cos(angle) * dist;
      const py = cy + Math.sin(angle) * dist - p * (C.smokeFloatBase + qIdx);

      const pFade = 1 - p;
      const pSize = (C.smokeSizeBase + seededRandom(i + 403) * C.smokeSizeRange) * pFade;
      if (pSize > 0.8 && pFade > 0.05) {
        if (hasTrails) {
          const tLen = Math.min(dist * 0.2, C.smokeTrailMax) * pFade * tMult;
          if (tLen > 1.5) {
            graphics.lineStyle(pSize * 0.5, CC.smokeTrail, alpha * 0.15 * pFade);
            graphics.lineBetween(px - Math.cos(angle) * tLen, py - Math.sin(angle) * tLen, px, py);
          }
        }
        graphics.fillStyle(CC.smokeFill, alpha * 0.3 * pFade);
        graphics.fillCircle(px, py, pSize);
      }
    }
  }

  // ======================================================================
  // ELEMENT 6: PENETRATION PARTICLES — originate from primR, move along proj→entity dir
  // ======================================================================
  {
    const count = Math.max(1, Math.floor(countMult * (1 + penStr)));
    for (let i = 0; i < count; i++) {
      const delay = seededRandom(i + 200) * 0.06;
      const p = Math.max(0, (progress - delay) * 1.4);
      if (p <= 0 || p > 1) continue;

      const spread = (seededRandom(i + 201) - 0.5) * C.penSpread;
      const angle = Math.atan2(penDirY, penDirX) + spread;
      const speed = 0.7 + seededRandom(i + 202) * 0.7;
      const dist = primR * 0.4 + primR * p * C.penDistMult * speed * Math.max(penStr, sFloor);
      const px = cx + Math.cos(angle) * dist;
      const py = cy + Math.sin(angle) * dist;

      const pFade = 1 - p;
      const pSize = (C.penSizeBase + seededRandom(i + 203) * C.penSizeRange) * pFade;
      if (pSize > 0.8 && pFade > 0.05) {
        if (hasTrails) {
          const tLen = Math.min(dist * 0.3, C.penTrailMax) * pFade * tMult;
          if (tLen > 1.5) {
            graphics.lineStyle(pSize * 0.5, CC.penTrail, alpha * 0.25 * pFade);
            graphics.lineBetween(px - Math.cos(angle) * tLen, py - Math.sin(angle) * tLen, px, py);
          }
        }
        graphics.fillStyle(CC.penFill, alpha * 0.5 * pFade);
        graphics.fillCircle(px, py, pSize);
        if (qIdx >= 1) {
          graphics.fillStyle(CC.penInner, alpha * 0.35 * pFade);
          graphics.fillCircle(px, py, pSize * 0.5);
        }
      }
    }
  }

  // ======================================================================
  // MAX-ONLY BONUS: embers rising from primary zone
  // ======================================================================
  if (qIdx >= 4 && progress > 0.1) {
    const count = C.emberCountBase + Math.floor((velStr + penStr) * C.emberCountPerStrength);
    for (let i = 0; i < count; i++) {
      const ep = Math.max(0, (progress - 0.1 - seededRandom(i + 600) * 0.15) * 2.0);
      if (ep <= 0 || ep > 1) continue;

      const baseAngle = seededRandom(i + 601) * Math.PI * 2;
      const eDist = primR * (0.3 + ep * 0.5) * (0.5 + seededRandom(i + 602) * 0.5);
      const ex = cx + Math.cos(baseAngle) * eDist;
      const ey = cy + Math.sin(baseAngle) * eDist - ep * C.emberFloat;

      const eFade = 1 - ep;
      const eSize = (C.emberSizeBase + seededRandom(i + 603) * C.emberSizeRange) * eFade;
      if (eSize > 0.5 && eFade > 0.05) {
        graphics.fillStyle(CC.emberOuter, alpha * 0.7 * eFade);
        graphics.fillCircle(ex, ey, eSize);
        graphics.fillStyle(CC.emberInner, alpha * 0.5 * eFade);
        graphics.fillCircle(ex, ey, eSize * 0.5);
      }
    }
  }
}

// Seeded random for consistent particles
function createSeededRandom(seed: number): (i: number) => number {
  return (i: number) => {
    const x = Math.sin(seed + i * 127.1) * 43758.5453;
    return x - Math.floor(x);
  };
}

/**
 * Simple expanding circle explosion (low quality)
 */
function renderSimpleCircle(
  graphics: Phaser.GameObjects.Graphics,
  exp: ExplosionEffect,
  progress: number
): void {
  // Use primaryRadius → secondaryRadius when available, else default 0.3→1.3 scaling
  const startRadius = exp.primaryRadius ?? exp.radius * 0.3;
  const endRadius = exp.secondaryRadius ?? exp.radius * 1.3;
  const currentRadius = startRadius + (endRadius - startRadius) * progress;
  const alpha = 1 - progress * progress;
  // Outer orange glow
  graphics.fillStyle(0xff6600, alpha * 0.3);
  graphics.fillCircle(exp.x, exp.y, currentRadius * 1.1);
  // Main fireball (orange-yellow)
  graphics.fillStyle(0xff8822, alpha * 0.6);
  graphics.fillCircle(exp.x, exp.y, currentRadius);
  // Inner yellow
  graphics.fillStyle(0xffcc44, alpha * 0.7);
  graphics.fillCircle(exp.x, exp.y, currentRadius * 0.6);
  // Hot white core
  graphics.fillStyle(0xffffff, alpha * 0.8);
  graphics.fillCircle(exp.x, exp.y, currentRadius * 0.25);
}

/**
 * Three velocity circles with scattered particles (medium quality)
 */
function renderVelocityCircles(
  graphics: Phaser.GameObjects.Graphics,
  exp: ExplosionEffect,
  progress: number
): void {
  const alpha = 1 - progress * progress;
  const seed = (exp.x * 1000 + exp.y) % 10000;
  const seededRandom = createSeededRandom(seed);

  // Get the three velocity directions
  const hasVelocity = (exp.velocityMag ?? 0) > 10;
  const hasPenetration = (exp.penetrationMag ?? 0) > 10;
  const hasAttacker = (exp.attackerMag ?? 0) > 10;

  // Normalize directions
  const velDirX = hasVelocity ? (exp.velocityX ?? 0) / exp.velocityMag! : 0;
  const velDirY = hasVelocity ? (exp.velocityY ?? 0) / exp.velocityMag! : 0;
  const penDirX = hasPenetration ? (exp.penetrationX ?? 0) / exp.penetrationMag! : 0;
  const penDirY = hasPenetration ? (exp.penetrationY ?? 0) / exp.penetrationMag! : 0;
  const attackDirX = hasAttacker ? (exp.attackerX ?? 0) / exp.attackerMag! : 0;
  const attackDirY = hasAttacker ? (exp.attackerY ?? 0) / exp.attackerMag! : 0;

  // Strength factors
  const velStrength = hasVelocity ? Math.min(exp.velocityMag! / 300, 1.5) : 0;
  const penStrength = hasPenetration ? Math.min(exp.penetrationMag! / 300, 1.5) : 0;
  const attackStrength = hasAttacker ? Math.min(exp.attackerMag! / 300, 1.5) : 0;

  // Central fireball
  const baseRadius = exp.radius * (0.4 + progress * 0.4);
  const baseFade = Math.max(0, 1 - progress * 1.3);
  if (baseFade > 0) {
    graphics.fillStyle(0xff6600, alpha * 0.4 * baseFade);
    graphics.fillCircle(exp.x, exp.y, baseRadius * 1.2);
    graphics.fillStyle(0xffaa33, alpha * 0.6 * baseFade);
    graphics.fillCircle(exp.x, exp.y, baseRadius * 0.8);
    graphics.fillStyle(0xffdd66, alpha * 0.7 * baseFade);
    graphics.fillCircle(exp.x, exp.y, baseRadius * 0.4);
    graphics.fillStyle(0xffffff, alpha * 0.6 * baseFade);
    graphics.fillCircle(exp.x, exp.y, baseRadius * 0.15);
  }

  // Particles in unit velocity direction (smoke-ish gray particles)
  if (hasVelocity) {
    const particleCount = 4 + Math.floor(velStrength * 3);
    for (let i = 0; i < particleCount; i++) {
      const spread = (seededRandom(i + 100) - 0.5) * 0.8;
      const angle = Math.atan2(velDirY, velDirX) + spread;
      const speed = 0.8 + seededRandom(i + 101) * 0.6;
      const dist = exp.radius * progress * 1.8 * speed * velStrength;
      const px = exp.x + Math.cos(angle) * dist;
      const py = exp.y + Math.sin(angle) * dist;
      const pSize = (3 + seededRandom(i + 102) * 4) * (1 - progress * 0.7);
      const pFade = Math.max(0, 1 - progress * 1.2);
      if (pFade > 0 && pSize > 1) {
        graphics.fillStyle(0x666666, alpha * 0.4 * pFade);
        graphics.fillCircle(px, py, pSize);
      }
    }
  }

  // Particles in penetration direction (orange debris)
  if (hasPenetration) {
    const particleCount = 5 + Math.floor(penStrength * 3);
    for (let i = 0; i < particleCount; i++) {
      const spread = (seededRandom(i + 200) - 0.5) * 0.7;
      const angle = Math.atan2(penDirY, penDirX) + spread;
      const speed = 0.7 + seededRandom(i + 201) * 0.8;
      const dist = exp.radius * progress * 2.0 * speed * penStrength;
      const px = exp.x + Math.cos(angle) * dist;
      const py = exp.y + Math.sin(angle) * dist;
      const pSize = (3 + seededRandom(i + 202) * 5) * (1 - progress * 0.6);
      const pFade = Math.max(0, 1 - progress * 1.1);
      if (pFade > 0 && pSize > 1) {
        graphics.fillStyle(0xff7722, alpha * 0.5 * pFade);
        graphics.fillCircle(px, py, pSize);
        graphics.fillStyle(0xffaa55, alpha * 0.4 * pFade);
        graphics.fillCircle(px, py, pSize * 0.5);
      }
    }
  }

  // Particles in attacker direction (bright sparks - main explosion direction)
  if (hasAttacker) {
    const particleCount = 6 + Math.floor(attackStrength * 4);
    for (let i = 0; i < particleCount; i++) {
      const spread = (seededRandom(i + 300) - 0.5) * 0.6;
      const angle = Math.atan2(attackDirY, attackDirX) + spread;
      const speed = 1.0 + seededRandom(i + 301) * 0.8;
      const dist = exp.radius * progress * 2.5 * speed * attackStrength;
      const px = exp.x + Math.cos(angle) * dist;
      const py = exp.y + Math.sin(angle) * dist;
      const pSize = (4 + seededRandom(i + 302) * 5) * (1 - progress * 0.5);
      const pFade = Math.max(0, 1 - progress * 1.0);
      if (pFade > 0 && pSize > 1) {
        graphics.fillStyle(0xff4400, alpha * 0.6 * pFade);
        graphics.fillCircle(px, py, pSize);
        graphics.fillStyle(0xffcc44, alpha * 0.5 * pFade);
        graphics.fillCircle(px, py, pSize * 0.6);
        graphics.fillStyle(0xffffff, alpha * 0.4 * pFade);
        graphics.fillCircle(px, py, pSize * 0.25);
      }
    }
  }
}

/**
 * Three velocity chunks with debris trails (high quality)
 */
function renderVelocityChunks(
  graphics: Phaser.GameObjects.Graphics,
  exp: ExplosionEffect,
  progress: number
): void {
  const alpha = 1 - progress;
  const seed = (exp.x * 1000 + exp.y) % 10000;
  const seededRandom = createSeededRandom(seed);

  // Get directions and strengths
  const hasVelocity = (exp.velocityMag ?? 0) > 10;
  const hasPenetration = (exp.penetrationMag ?? 0) > 10;
  const hasAttacker = (exp.attackerMag ?? 0) > 10;

  const velDirX = hasVelocity ? (exp.velocityX ?? 0) / exp.velocityMag! : 0;
  const velDirY = hasVelocity ? (exp.velocityY ?? 0) / exp.velocityMag! : 0;
  const penDirX = hasPenetration ? (exp.penetrationX ?? 0) / exp.penetrationMag! : 0;
  const penDirY = hasPenetration ? (exp.penetrationY ?? 0) / exp.penetrationMag! : 0;
  const attackDirX = hasAttacker ? (exp.attackerX ?? 0) / exp.attackerMag! : 0;
  const attackDirY = hasAttacker ? (exp.attackerY ?? 0) / exp.attackerMag! : 0;

  const velStrength = hasVelocity ? Math.min(exp.velocityMag! / 300, 1.5) : 0;
  const penStrength = hasPenetration ? Math.min(exp.penetrationMag! / 300, 1.5) : 0;
  const attackStrength = hasAttacker ? Math.min(exp.attackerMag! / 300, 1.5) : 0;

  // Central fireball with glow
  const baseRadius = exp.radius * (0.5 + progress * 0.3);
  const baseFade = Math.max(0, 1 - progress * 1.2);
  if (baseFade > 0) {
    graphics.fillStyle(0xff4400, alpha * 0.3 * baseFade);
    graphics.fillCircle(exp.x, exp.y, baseRadius * 1.4);
    graphics.fillStyle(0xff6622, alpha * 0.5 * baseFade);
    graphics.fillCircle(exp.x, exp.y, baseRadius);
    graphics.fillStyle(0xffaa44, alpha * 0.7 * baseFade);
    graphics.fillCircle(exp.x, exp.y, baseRadius * 0.6);
    graphics.fillStyle(0xffdd88, alpha * 0.8 * baseFade);
    graphics.fillCircle(exp.x, exp.y, baseRadius * 0.3);
    graphics.fillStyle(0xffffff, alpha * 0.7 * baseFade);
    graphics.fillCircle(exp.x, exp.y, baseRadius * 0.12);
  }

  // Smoke chunks in velocity direction
  if (hasVelocity) {
    const chunkCount = 6 + Math.floor(velStrength * 4);
    for (let i = 0; i < chunkCount; i++) {
      const delay = seededRandom(i + 100) * 0.1;
      const chunkProgress = Math.max(0, (progress - delay) * 1.3);
      if (chunkProgress <= 0 || chunkProgress > 1) continue;

      const spread = (seededRandom(i + 101) - 0.5) * 1.0;
      const angle = Math.atan2(velDirY, velDirX) + spread;
      const speed = 0.6 + seededRandom(i + 102) * 0.6;
      const dist = exp.radius * chunkProgress * 1.6 * speed * velStrength;
      const px = exp.x + Math.cos(angle) * dist;
      const py = exp.y + Math.sin(angle) * dist - chunkProgress * 5; // Float up slightly

      const chunkFade = 1 - chunkProgress;
      const chunkSize = (4 + seededRandom(i + 103) * 5) * chunkFade;

      // Short trail
      if (chunkSize > 2 && chunkFade > 0.1) {
        const trailLen = Math.min(dist * 0.3, 12) * chunkFade;
        if (trailLen > 2) {
          const tx = px - Math.cos(angle) * trailLen;
          const ty = py - Math.sin(angle) * trailLen + chunkProgress * 2.5;
          graphics.lineStyle(chunkSize * 0.6, 0x555555, alpha * 0.25 * chunkFade);
          graphics.lineBetween(tx, ty, px, py);
        }
        graphics.fillStyle(0x444444, alpha * 0.4 * chunkFade);
        graphics.fillCircle(px, py, chunkSize);
      }
    }
  }

  // Orange debris chunks in penetration direction
  if (hasPenetration) {
    const chunkCount = 8 + Math.floor(penStrength * 5);
    for (let i = 0; i < chunkCount; i++) {
      const delay = seededRandom(i + 200) * 0.08;
      const chunkProgress = Math.max(0, (progress - delay) * 1.4);
      if (chunkProgress <= 0 || chunkProgress > 1) continue;

      const spread = (seededRandom(i + 201) - 0.5) * 0.8;
      const angle = Math.atan2(penDirY, penDirX) + spread;
      const speed = 0.8 + seededRandom(i + 202) * 0.7;
      const dist = exp.radius * chunkProgress * 2.0 * speed * penStrength;
      const px = exp.x + Math.cos(angle) * dist;
      const py = exp.y + Math.sin(angle) * dist;

      const chunkFade = 1 - chunkProgress;
      const chunkSize = (4 + seededRandom(i + 203) * 6) * chunkFade;

      if (chunkSize > 2 && chunkFade > 0.1) {
        // Trail
        const trailLen = Math.min(dist * 0.35, 15) * chunkFade;
        if (trailLen > 2) {
          const tx = px - Math.cos(angle) * trailLen;
          const ty = py - Math.sin(angle) * trailLen;
          graphics.lineStyle(chunkSize * 0.5, 0xff5500, alpha * 0.3 * chunkFade);
          graphics.lineBetween(tx, ty, px, py);
        }
        graphics.fillStyle(0xff6600, alpha * 0.6 * chunkFade);
        graphics.fillCircle(px, py, chunkSize);
        graphics.fillStyle(0xffaa44, alpha * 0.5 * chunkFade);
        graphics.fillCircle(px, py, chunkSize * 0.5);
      }
    }
  }

  // Bright spark chunks in attacker direction (main explosion spray)
  if (hasAttacker) {
    const chunkCount = 10 + Math.floor(attackStrength * 8);
    for (let i = 0; i < chunkCount; i++) {
      const delay = seededRandom(i + 300) * 0.06;
      const chunkProgress = Math.max(0, (progress - delay) * 1.5);
      if (chunkProgress <= 0 || chunkProgress > 1) continue;

      const spread = (seededRandom(i + 301) - 0.5) * 0.6;
      const angle = Math.atan2(attackDirY, attackDirX) + spread;
      const speed = 1.0 + seededRandom(i + 302) * 1.0;
      const dist = exp.radius * chunkProgress * 2.8 * speed * attackStrength;
      const px = exp.x + Math.cos(angle) * dist;
      const py = exp.y + Math.sin(angle) * dist;

      const chunkFade = 1 - chunkProgress;
      const chunkSize = (3 + seededRandom(i + 303) * 5) * chunkFade;

      if (chunkSize > 1.5 && chunkFade > 0.1) {
        // Longer bright trail
        const trailLen = Math.min(dist * 0.4, 20) * chunkFade;
        if (trailLen > 3) {
          const tx = px - Math.cos(angle) * trailLen;
          const ty = py - Math.sin(angle) * trailLen;
          graphics.lineStyle(chunkSize * 0.7, 0xff6622, alpha * 0.35 * chunkFade);
          graphics.lineBetween(tx, ty, px, py);
          graphics.lineStyle(chunkSize * 0.4, 0xffaa44, alpha * 0.5 * chunkFade);
          graphics.lineBetween((tx + px) / 2, (ty + py) / 2, px, py);
        }
        graphics.fillStyle(0xffcc44, alpha * 0.7 * chunkFade);
        graphics.fillCircle(px, py, chunkSize);
        graphics.fillStyle(0xffffff, alpha * 0.6 * chunkFade);
        graphics.fillCircle(px, py, chunkSize * 0.4);
      }
    }
  }
}

/**
 * Complex explosion with full particle system (max quality)
 */
function renderComplexExplosion(
  graphics: Phaser.GameObjects.Graphics,
  exp: ExplosionEffect,
  progress: number
): void {
  const alpha = 1 - progress;
  const seed = (exp.x * 1000 + exp.y) % 10000;
  const seededRandom = createSeededRandom(seed);

  // Calculate directions and strengths
  let velDirX = 0, velDirY = 0, velStrength = 0, velAngle = 0;
  const hasVelocity = (exp.velocityMag ?? 0) > 10;
  if (hasVelocity) {
    velDirX = (exp.velocityX ?? 0) / exp.velocityMag!;
    velDirY = (exp.velocityY ?? 0) / exp.velocityMag!;
    velAngle = Math.atan2(velDirY, velDirX);
    velStrength = Math.min(exp.velocityMag! / 400, 1);
  }

  let penDirX = 0, penDirY = 0, penStrength = 0, penAngle = 0;
  const hasPenetration = (exp.penetrationMag ?? 0) > 10;
  if (hasPenetration) {
    penDirX = (exp.penetrationX ?? 0) / exp.penetrationMag!;
    penDirY = (exp.penetrationY ?? 0) / exp.penetrationMag!;
    penAngle = Math.atan2(penDirY, penDirX);
    penStrength = Math.min(exp.penetrationMag! / 400, 1);
  }

  let attackDirX = 0, attackDirY = 0, attackStrength = 0, attackAngle = 0;
  const hasAttacker = (exp.attackerMag ?? 0) > 10;
  if (hasAttacker) {
    attackDirX = (exp.attackerX ?? 0) / exp.attackerMag!;
    attackDirY = (exp.attackerY ?? 0) / exp.attackerMag!;
    attackAngle = Math.atan2(attackDirY, attackDirX);
    attackStrength = Math.min(exp.attackerMag! / 400, 1);
  }

  let combinedDirX = 0, combinedDirY = 0, combinedStrength = 0, combinedAngle = 0;
  const hasCombined = (exp.combinedMag ?? 0) > 10;
  if (hasCombined) {
    combinedDirX = (exp.combinedX ?? 0) / exp.combinedMag!;
    combinedDirY = (exp.combinedY ?? 0) / exp.combinedMag!;
    combinedAngle = Math.atan2(combinedDirY, combinedDirX);
    combinedStrength = Math.min(exp.combinedMag! / 400, 1);
  }

  // Dynamic center that drifts with combined momentum over time
  const driftDistance = hasCombined ? exp.radius * 0.8 * progress * combinedStrength : 0;
  const centerX = exp.x + combinedDirX * driftDistance;
  const centerY = exp.y + combinedDirY * driftDistance;

  // LAYER 1: SMOKE CLOUDS (uses VELOCITY - trails behind moving unit)
  if (progress > 0.1) {
    const smokeCount = 6 + Math.floor(velStrength * 4);
    for (let i = 0; i < smokeCount; i++) {
      const smokeProgress = Math.max(0, (progress - 0.1 - i * 0.02) * 1.8);
      if (smokeProgress <= 0 || smokeProgress > 1) continue;

      const baseAngle = seededRandom(i + 100) * Math.PI * 2;
      let smokeAngle = baseAngle;
      let smokeDist = exp.radius * (0.3 + smokeProgress * 0.8) * (0.7 + seededRandom(i + 101) * 0.6);

      if (hasVelocity) {
        const oppositeAngle = velAngle + Math.PI;
        const alignment = Math.cos(baseAngle - oppositeAngle);
        if (alignment > 0) {
          smokeDist *= 1 + alignment * velStrength * 0.8;
          smokeAngle = baseAngle - (baseAngle - oppositeAngle) * 0.3 * velStrength;
        }
      }

      const smokeX = centerX + Math.cos(smokeAngle) * smokeDist;
      const smokeY = centerY + Math.sin(smokeAngle) * smokeDist - smokeProgress * 8;

      const smokeFade = 1 - smokeProgress;
      const smokeSize = exp.radius * 0.3 * smokeFade * (0.8 + seededRandom(i + 102) * 0.4);
      const smokeAlpha = 0.15 * smokeFade;

      if (smokeFade > 0.05) {
        graphics.fillStyle(0x444444, smokeAlpha);
        graphics.fillCircle(smokeX, smokeY, smokeSize);
      }
    }
  }

  // LAYER 2: SPARK PARTICLES WITH TRAILS (uses ATTACKER direction)
  const sparkCount = 24 + Math.floor(attackStrength * 20);
  for (let i = 0; i < sparkCount; i++) {
    const sparkDelay = seededRandom(i + 300) * 0.12;
    const sparkProgress = clamp01((progress - sparkDelay) * 1.5);
    if (sparkProgress <= 0) continue;

    const baseAngle = (i / sparkCount) * Math.PI * 2 + seededRandom(i + 301) * 0.3;
    const sparkSpeed = 1.0 + seededRandom(i + 302) * 1.0;

    let finalAngle = baseAngle;
    let distMult = 1;
    if (hasAttacker) {
      const angDiff = computeAngleDiff(attackAngle, baseAngle);

      const alignment = Math.cos(angDiff);
      if (alignment > 0) {
        distMult = 1 + alignment * attackStrength * 3.0;
        finalAngle = baseAngle - angDiff * 0.7 * attackStrength;
      } else {
        distMult = Math.max(0.1, 1 + alignment * attackStrength * 0.8);
      }
    }

    const sparkDist = exp.radius * (0.3 + sparkProgress * 2.5) * sparkSpeed * distMult;
    const sparkX = centerX + Math.cos(finalAngle) * sparkDist;
    const sparkY = centerY + Math.sin(finalAngle) * sparkDist;

    const sparkFade = 1 - sparkProgress;
    const trailLength = Math.min(sparkDist * 0.5, 30) * sparkFade;
    if (trailLength > 2 && sparkFade > 0.05) {
      const trailStartX = sparkX - Math.cos(finalAngle) * trailLength;
      const trailStartY = sparkY - Math.sin(finalAngle) * trailLength;
      graphics.lineStyle(3, 0xff6622, alpha * 0.3 * sparkFade);
      graphics.lineBetween(trailStartX, trailStartY, sparkX, sparkY);
      graphics.lineStyle(2, 0xffaa44, alpha * 0.6 * sparkFade);
      const midX = (trailStartX + sparkX) / 2;
      const midY = (trailStartY + sparkY) / 2;
      graphics.lineBetween(midX, midY, sparkX, sparkY);
    }

    const sparkSize = (3.5 + seededRandom(i + 303) * 3) * sparkFade;
    if (sparkSize > 0.5 && sparkFade > 0.05) {
      graphics.fillStyle(0xffdd88, alpha * 0.95 * sparkFade);
      graphics.fillCircle(sparkX, sparkY, sparkSize);
      graphics.fillStyle(0xffffff, alpha * 0.8 * sparkFade);
      graphics.fillCircle(sparkX, sparkY, sparkSize * 0.5);
    }
  }

  // LAYER 3: PENETRATION FRAGMENTS
  if (hasAttacker && attackStrength > 0.2) {
    const fragmentCount = 8 + Math.floor(attackStrength * 15);
    for (let i = 0; i < fragmentCount; i++) {
      const fragDelay = seededRandom(i + 350) * 0.08;
      const fragProgress = clamp01((progress - fragDelay) * 1.8);
      if (fragProgress <= 0) continue;

      const coneSpread = 0.5 * (1 - attackStrength * 0.3);
      const fragAngle = attackAngle + (seededRandom(i + 351) - 0.5) * coneSpread;
      const fragSpeed = 1.5 + seededRandom(i + 352) * 1.5;

      const fragDist = exp.radius * (0.5 + fragProgress * 3.5) * fragSpeed;
      const fragX = centerX + Math.cos(fragAngle) * fragDist;
      const fragY = centerY + Math.sin(fragAngle) * fragDist;

      const fragFade = 1 - fragProgress;
      const fragTrailLen = Math.min(fragDist * 0.4, 25) * fragFade;
      if (fragTrailLen > 3 && fragFade > 0.05) {
        const trailStartX = fragX - Math.cos(fragAngle) * fragTrailLen;
        const trailStartY = fragY - Math.sin(fragAngle) * fragTrailLen;
        graphics.lineStyle(4, 0xff4400, alpha * 0.4 * fragFade);
        graphics.lineBetween(trailStartX, trailStartY, fragX, fragY);
        graphics.lineStyle(2, 0xffaa00, alpha * 0.7 * fragFade);
        graphics.lineBetween(trailStartX, trailStartY, fragX, fragY);
      }

      const fragSize = (4 + seededRandom(i + 353) * 4) * fragFade;
      if (fragSize > 1 && fragFade > 0.05) {
        graphics.fillStyle(0xff6600, alpha * 0.9 * fragFade);
        graphics.fillCircle(fragX, fragY, fragSize);
        graphics.fillStyle(0xffcc44, alpha * 0.7 * fragFade);
        graphics.fillCircle(fragX, fragY, fragSize * 0.6);
        graphics.fillStyle(0xffffff, alpha * 0.5 * fragFade);
        graphics.fillCircle(fragX, fragY, fragSize * 0.25);
      }
    }
  }

  // LAYER 4: DEBRIS CHUNKS (uses PENETRATION)
  const debrisCount = 8 + Math.floor(penStrength * 6);
  for (let i = 0; i < debrisCount; i++) {
    const debrisDelay = seededRandom(i + 400) * 0.08;
    const debrisProgress = clamp01((progress - debrisDelay) * 1.3);
    if (debrisProgress <= 0) continue;

    const baseAngle = seededRandom(i + 401) * Math.PI * 2;
    const debrisSpeed = 0.5 + seededRandom(i + 402) * 0.5;

    let finalAngle = baseAngle;
    let distMult = 1;
    if (hasPenetration) {
      const angDiff = computeAngleDiff(penAngle, baseAngle);

      const alignment = Math.cos(angDiff);
      if (alignment > 0) {
        distMult = 1 + alignment * penStrength * 1.8;
        finalAngle = baseAngle - angDiff * 0.6 * penStrength;
      } else {
        distMult = Math.max(0.2, 1 + alignment * penStrength * 0.5);
      }
    }

    const debrisDist = exp.radius * (0.3 + debrisProgress * 1.0) * debrisSpeed * distMult;
    const gravityDrop = debrisProgress * debrisProgress * 20;
    const debrisX = centerX + Math.cos(finalAngle) * debrisDist;
    const debrisY = centerY + Math.sin(finalAngle) * debrisDist + gravityDrop;

    const debrisFade = 1 - debrisProgress;
    const debrisSize = (3 + seededRandom(i + 403) * 4) * debrisFade;
    if (debrisSize > 1 && debrisFade > 0.05) {
      graphics.fillStyle(0x332211, alpha * 0.8 * debrisFade);
      graphics.fillCircle(debrisX, debrisY, debrisSize);
      graphics.fillStyle(0x664422, alpha * 0.5 * debrisFade);
      graphics.fillCircle(debrisX - debrisSize * 0.3, debrisY - debrisSize * 0.3, debrisSize * 0.5);
    }
  }

  // LAYER 5: FIRE EMBERS (uses VELOCITY)
  if (progress > 0.15) {
    const emberCount = 10 + Math.floor(velStrength * 8);
    for (let i = 0; i < emberCount; i++) {
      const emberProgress = Math.max(0, (progress - 0.15 - seededRandom(i + 500) * 0.2) * 2.0);
      if (emberProgress <= 0 || emberProgress > 1) continue;

      const baseAngle = seededRandom(i + 501) * Math.PI * 2;
      let emberAngle = baseAngle;
      let emberDist = exp.radius * (0.4 + emberProgress * 0.6) * (0.5 + seededRandom(i + 502) * 0.5);

      if (hasVelocity) {
        const oppositeAngle = velAngle + Math.PI;
        const alignment = Math.cos(baseAngle - oppositeAngle);
        if (alignment > 0) {
          emberDist *= 1 + alignment * velStrength * 1.0;
          emberAngle = baseAngle - (baseAngle - oppositeAngle) * 0.35 * velStrength;
        }
      }

      const emberX = centerX + Math.cos(emberAngle) * emberDist;
      const emberY = centerY + Math.sin(emberAngle) * emberDist - emberProgress * 15;

      const emberFade = 1 - emberProgress;
      const emberSize = (1.5 + seededRandom(i + 503) * 1.5) * emberFade;
      const emberAlpha = alpha * 0.8 * emberFade;

      if (emberSize > 0.5 && emberFade > 0.05) {
        graphics.fillStyle(0xff6600, emberAlpha);
        graphics.fillCircle(emberX, emberY, emberSize);
        graphics.fillStyle(0xffcc00, emberAlpha * 0.6);
        graphics.fillCircle(emberX, emberY, emberSize * 0.5);
      }
    }
  }

  // LAYER 6: MOMENTUM TRAIL (uses COMBINED)
  if (hasCombined && combinedStrength > 0.3) {
    const trailCount = Math.floor(combinedStrength * 15);
    for (let i = 0; i < trailCount; i++) {
      const trailT = i / trailCount;
      const trailProgress = clamp01((progress - trailT * 0.2) * 1.6);
      if (trailProgress <= 0) continue;

      const spreadAngle = (seededRandom(i + 600) - 0.5) * 0.6 * (1 - combinedStrength * 0.5);
      const trailAngle = combinedAngle + spreadAngle;
      const trailDist = exp.radius * (0.5 + trailProgress * 2.0 + trailT * 0.8) * (0.8 + combinedStrength * 0.4);

      const trailX = exp.x + Math.cos(trailAngle) * trailDist;
      const trailY = exp.y + Math.sin(trailAngle) * trailDist;

      const trailFade = 1 - trailProgress;
      const trailSize = (3 + seededRandom(i + 601) * 2) * (1 - trailT * 0.5) * trailFade;
      const trailAlpha = alpha * 0.7 * (1 - trailT * 0.3) * trailFade;

      if (trailSize > 0.5 && trailFade > 0.05) {
        graphics.fillStyle(0xff8844, trailAlpha);
        graphics.fillCircle(trailX, trailY, trailSize);
        graphics.fillStyle(0xffcc88, trailAlpha * 0.5);
        graphics.fillCircle(trailX, trailY, trailSize * 0.4);
      }
    }
  }
}

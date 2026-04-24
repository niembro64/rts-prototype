// Impact (projectile-hit) explosion renderer.
// Single function for ALL impact explosions across all 5 LOD tiers.
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

import Phaser from '../../PhaserCompat';
import type { ExplosionEffect } from '../types';
import { getGraphicsConfig } from '@/clientBarConfig';
import type { FireExplosionStyle } from '@/types/graphics';
import { FIRE_EXPLOSION } from '../../../explosionConfig';
import { createSeededRandom } from './explosionShared';

// Map fire explosion style strings to quality index (0-4)
const FIRE_STYLE_IDX: Record<FireExplosionStyle, number> = {
  flash: 0, spark: 1, burst: 2, blaze: 3, inferno: 4,
};

export function renderImpact(
  graphics: Phaser.GameObjects.Graphics,
  exp: ExplosionEffect,
  progress: number,
): void {
  const C = FIRE_EXPLOSION;
  const CC = C.colors;
  const qIdx = FIRE_STYLE_IDX[getGraphicsConfig().fireExplosionStyle];

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
    const drift =
      primR *
      C.driftScale[qIdx] *
      progress *
      Math.min(combinedMag / C.driftNormalize, 1);
    cx += ((exp.combinedX ?? 0) / combinedMag) * drift;
    cy += ((exp.combinedY ?? 0) / combinedMag) * drift;
  }

  // Per-LOD tuning
  const countMult = C.countMult[qIdx];
  const tMult = C.trailMult[qIdx];
  const hasTrails = tMult > 0;

  // Pre-compute direction angles (hoisted out of particle loops)
  const penAngle = Math.atan2(penDirY, penDirX);
  const attackAngle = Math.atan2(attackDirY, attackDirX);
  const velAngle = Math.atan2(velDirY, velDirX);

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
  const primGlowR =
    primR * (C.primaryGlowStart + progress * C.primaryGlowExpand);
  const primFade = Math.max(0, 1 - progress * C.primaryFadeRate);
  if (primFade > 0) {
    graphics.fillStyle(CC.primaryGlow, alpha * C.primaryGlowAlpha * primFade);
    graphics.fillCircle(cx, cy, primGlowR);
    graphics.lineStyle(
      1.5 + qIdx * 0.3,
      CC.primaryRing,
      alpha * 0.25 * primFade,
    );
    graphics.strokeCircle(cx, cy, primGlowR);
  }

  // ======================================================================
  // ELEMENT 3: SECONDARY-RADIUS ZONE — expanding glow + ring + particles at secR
  // ======================================================================
  const secGlowR =
    secR * (C.secondaryGlowStart + progress * C.secondaryGlowExpand);
  const secFade = Math.max(0, 1 - progress * C.secondaryFadeRate);
  if (secFade > 0) {
    graphics.fillStyle(
      CC.secondaryGlow,
      alpha * C.secondaryGlowAlpha * secFade,
    );
    graphics.fillCircle(cx, cy, secGlowR);
    graphics.lineStyle(
      1 + qIdx * 0.2,
      CC.secondaryRing,
      alpha * 0.18 * secFade,
    );
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
      const angle = penAngle + spread;
      const speed = 0.4 + seededRandom(i + 502) * 0.5;
      const dist = secR * 0.6 + secR * p * C.secParticleDistMult * speed;
      const px = cx + Math.cos(angle) * dist;
      const py = cy + Math.sin(angle) * dist;

      const pFade = 1 - p;
      const pSize =
        (C.secParticleSizeBase +
          seededRandom(i + 503) * C.secParticleSizeRange) *
        pFade;
      if (pSize > 0.8 && pFade > 0.05) {
        if (hasTrails) {
          const tLen =
            Math.min(dist * 0.3, C.secParticleTrailMax) * pFade * tMult;
          if (tLen > 1.5) {
            graphics.lineStyle(
              pSize * 0.4,
              CC.secondaryRing,
              alpha * 0.2 * pFade,
            );
            graphics.lineBetween(
              px - Math.cos(angle) * tLen,
              py - Math.sin(angle) * tLen,
              px,
              py,
            );
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
      const angle = attackAngle + spread;
      const speed = 0.8 + seededRandom(i + 302) * 0.8;
      const dist =
        collR * 0.8 +
        primR * p * C.sparkDistMult * speed * Math.max(attackStr, sFloor);
      const px = cx + Math.cos(angle) * dist;
      const py = cy + Math.sin(angle) * dist;

      const pFade = 1 - p;
      const pSize =
        (C.sparkSizeBase + seededRandom(i + 303) * C.sparkSizeRange) * pFade;
      if (pSize > 0.8 && pFade > 0.05) {
        if (hasTrails) {
          const tLen = Math.min(dist * 0.3, C.sparkTrailMax) * pFade * tMult;
          if (tLen > 1.5) {
            graphics.lineStyle(pSize * 0.5, CC.sparkTrail, alpha * 0.3 * pFade);
            graphics.lineBetween(
              px - Math.cos(angle) * tLen,
              py - Math.sin(angle) * tLen,
              px,
              py,
            );
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
      const angle = velAngle + spread;
      const speed = 0.5 + seededRandom(i + 402) * 0.5;
      const dist =
        primR * 0.5 +
        primR * p * C.smokeDistMult * speed * Math.max(velStr, sFloor);
      const px = cx + Math.cos(angle) * dist;
      const py = cy + Math.sin(angle) * dist - p * (C.smokeFloatBase + qIdx);

      const pFade = 1 - p;
      const pSize =
        (C.smokeSizeBase + seededRandom(i + 403) * C.smokeSizeRange) * pFade;
      if (pSize > 0.8 && pFade > 0.05) {
        if (hasTrails) {
          const tLen = Math.min(dist * 0.2, C.smokeTrailMax) * pFade * tMult;
          if (tLen > 1.5) {
            graphics.lineStyle(
              pSize * 0.5,
              CC.smokeTrail,
              alpha * 0.15 * pFade,
            );
            graphics.lineBetween(
              px - Math.cos(angle) * tLen,
              py - Math.sin(angle) * tLen,
              px,
              py,
            );
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
      const angle = penAngle + spread;
      const speed = 0.7 + seededRandom(i + 202) * 0.7;
      const dist =
        primR * 0.4 +
        primR * p * C.penDistMult * speed * Math.max(penStr, sFloor);
      const px = cx + Math.cos(angle) * dist;
      const py = cy + Math.sin(angle) * dist;

      const pFade = 1 - p;
      const pSize =
        (C.penSizeBase + seededRandom(i + 203) * C.penSizeRange) * pFade;
      if (pSize > 0.8 && pFade > 0.05) {
        if (hasTrails) {
          const tLen = Math.min(dist * 0.3, C.penTrailMax) * pFade * tMult;
          if (tLen > 1.5) {
            graphics.lineStyle(pSize * 0.5, CC.penTrail, alpha * 0.25 * pFade);
            graphics.lineBetween(
              px - Math.cos(angle) * tLen,
              py - Math.sin(angle) * tLen,
              px,
              py,
            );
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
    const count =
      C.emberCountBase +
      Math.floor((velStr + penStr) * C.emberCountPerStrength);
    for (let i = 0; i < count; i++) {
      const ep = Math.max(
        0,
        (progress - 0.1 - seededRandom(i + 600) * 0.15) * 2.0,
      );
      if (ep <= 0 || ep > 1) continue;

      const baseAngle = seededRandom(i + 601) * Math.PI * 2;
      const eDist =
        primR * (0.3 + ep * 0.5) * (0.5 + seededRandom(i + 602) * 0.5);
      const ex = cx + Math.cos(baseAngle) * eDist;
      const ey = cy + Math.sin(baseAngle) * eDist - ep * C.emberFloat;

      const eFade = 1 - ep;
      const eSize =
        (C.emberSizeBase + seededRandom(i + 603) * C.emberSizeRange) * eFade;
      if (eSize > 0.5 && eFade > 0.05) {
        graphics.fillStyle(CC.emberOuter, alpha * 0.7 * eFade);
        graphics.fillCircle(ex, ey, eSize);
        graphics.fillStyle(CC.emberInner, alpha * 0.5 * eFade);
        graphics.fillCircle(ex, ey, eSize * 0.5);
      }
    }
  }
}

// Unified death explosion renderer — all 5 LOD tiers driven by DEATH_EXPLOSION config.
//   MIN:  ~3 draws   (core fireball only)
//   LOW:  ~12 draws  (core + smoke/debris/sparks)
//   MED:  ~25 draws  (more particles + inner highlights)
//   HIGH: ~55 draws  (fragments, chunks, trails)
//   MAX:  ~120 draws (embers, momentum trail, dual spark trails)

import Phaser from '../../PhaserCompat';
import type { ExplosionEffect } from '../types';
import { getGraphicsConfig } from '@/clientBarConfig';
import type { DeathExplosionStyle } from '@/types/graphics';
import { clamp01, angleDiff as computeAngleDiff } from '../../math';
import { DEATH_EXPLOSION } from '../../../explosionConfig';
import { createSeededRandom } from './explosionShared';

// Map death explosion style strings to quality index (0-4)
const DEATH_STYLE_IDX: Record<DeathExplosionStyle, number> = {
  puff: 0, scatter: 1, shatter: 2, detonate: 3, obliterate: 4,
};

export function renderDeath(
  graphics: Phaser.GameObjects.Graphics,
  exp: ExplosionEffect,
  progress: number,
): void {
  const C = DEATH_EXPLOSION;
  const CC = C.colors;
  const qIdx = DEATH_STYLE_IDX[getGraphicsConfig().deathExplosionStyle];

  const alpha = 1 - progress;
  const seed = (exp.x * 1000 + exp.y) % 10000;
  const seededRandom = createSeededRandom(seed);

  // Direction vectors + strength factors
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

  // Pre-compute direction angles (hoisted out of particle loops)
  const velAngle = Math.atan2(velDirY, velDirX);
  const penAngle = Math.atan2(penDirY, penDirX);
  const attackAngle = Math.atan2(attackDirY, attackDirX);

  // Center drift
  let cx = exp.x;
  let cy = exp.y;
  if (combinedMag > 0.01) {
    const drift =
      exp.radius *
      C.driftScale[qIdx] *
      progress *
      Math.min(combinedMag / C.driftNormalize, 1);
    cx += ((exp.combinedX ?? 0) / combinedMag) * drift;
    cy += ((exp.combinedY ?? 0) / combinedMag) * drift;
  }

  // ======================================================================
  // CORE FIREBALL — expanding concentric circles
  // ======================================================================
  const coreR = exp.radius * (0.4 + progress * C.coreExpandMult);
  const coreFade = Math.max(0, 1 - progress * C.coreFadeRate);
  if (coreFade > 0) {
    const coreCount = C.coreCircles[qIdx];
    // Outermost glow
    graphics.fillStyle(CC.coreGlow, alpha * 0.3 * coreFade);
    graphics.fillCircle(cx, cy, coreR * C.coreGlowScale);
    // Main fireball
    graphics.fillStyle(CC.coreFireball, alpha * 0.6 * coreFade);
    graphics.fillCircle(cx, cy, coreR);
    if (coreCount >= 3) {
      graphics.fillStyle(CC.coreHot, alpha * 0.7 * coreFade);
      graphics.fillCircle(cx, cy, coreR * 0.5);
    }
    if (coreCount >= 4) {
      graphics.fillStyle(CC.coreWhite, alpha * 0.8 * coreFade);
      graphics.fillCircle(cx, cy, coreR * 0.2);
    }
    if (coreCount >= 5) {
      graphics.fillStyle(CC.coreWhite, alpha * 0.6 * coreFade);
      graphics.fillCircle(cx, cy, coreR * 0.1);
    }
  }

  // ======================================================================
  // SMOKE STREAM — entity velocity direction
  // ======================================================================
  const smokeN = C.smokeCount[qIdx];
  if (smokeN > 0) {
    const smokeTMult = C.smokeTrailMult[qIdx];
    for (let i = 0; i < smokeN; i++) {
      const delay = seededRandom(i + 100) * 0.1;
      const p = Math.max(0, (progress - delay) * 1.5);
      if (p <= 0 || p > 1) continue;

      const spread = (seededRandom(i + 101) - 0.5) * C.smokeSpread;
      const angle = velAngle + spread;
      const speed =
        C.smokeSpeedBase + seededRandom(i + 102) * C.smokeSpeedRange;
      const dist =
        exp.radius * p * C.smokeDistMult * speed * Math.max(velStr, sFloor);
      const px = cx + Math.cos(angle) * dist;
      const py = cy + Math.sin(angle) * dist - p * C.smokeFloat[qIdx];

      const pFade = 1 - p;
      const pSize =
        (C.smokeSizeBase + seededRandom(i + 103) * C.smokeSizeRange) * pFade;
      if (pSize > 0.8 && pFade > 0.05) {
        if (smokeTMult > 0) {
          const tLen =
            Math.min(dist * 0.2, C.smokeTrailMax) * pFade * smokeTMult;
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
  // DEBRIS STREAM — penetration direction
  // ======================================================================
  const debrisN = C.debrisCount[qIdx];
  if (debrisN > 0) {
    const debrisTMult = C.debrisTrailMult[qIdx];
    const debrisInners = C.debrisInners[qIdx];
    for (let i = 0; i < debrisN; i++) {
      const delay = seededRandom(i + 200) * 0.06;
      const p = Math.max(0, (progress - delay) * 1.4);
      if (p <= 0 || p > 1) continue;

      const spread = (seededRandom(i + 201) - 0.5) * C.debrisSpread;
      const angle = penAngle + spread;
      const speed =
        C.debrisSpeedBase + seededRandom(i + 202) * C.debrisSpeedRange;
      const dist =
        exp.radius * p * C.debrisDistMult * speed * Math.max(penStr, sFloor);
      const px = cx + Math.cos(angle) * dist;
      const py = cy + Math.sin(angle) * dist;

      const pFade = 1 - p;
      const pSize =
        (C.debrisSizeBase + seededRandom(i + 203) * C.debrisSizeRange) * pFade;
      if (pSize > 0.8 && pFade > 0.05) {
        if (debrisTMult > 0) {
          const tLen =
            Math.min(dist * 0.3, C.debrisTrailMax) * pFade * debrisTMult;
          if (tLen > 1.5) {
            graphics.lineStyle(
              pSize * 0.5,
              CC.debrisTrail,
              alpha * 0.25 * pFade,
            );
            graphics.lineBetween(
              px - Math.cos(angle) * tLen,
              py - Math.sin(angle) * tLen,
              px,
              py,
            );
          }
        }
        graphics.fillStyle(CC.debrisFill, alpha * 0.5 * pFade);
        graphics.fillCircle(px, py, pSize);
        if (debrisInners >= 1) {
          graphics.fillStyle(CC.debrisInner, alpha * 0.35 * pFade);
          graphics.fillCircle(px, py, pSize * 0.5);
        }
        if (debrisInners >= 2) {
          graphics.fillStyle(CC.debrisInner, alpha * 0.25 * pFade);
          graphics.fillCircle(px, py, pSize * 0.25);
        }
      }
    }
  }

  // ======================================================================
  // SPARK STREAM — attacker direction (cone or full circle)
  // ======================================================================
  const sparkN = C.sparkCount[qIdx];
  if (sparkN > 0) {
    const sparkTMult = C.sparkTrailMult[qIdx];
    const sparkInners = C.sparkInners[qIdx];
    const fullCircle = C.sparkFullCircle[qIdx];
    const dirBias = C.sparkDirBias[qIdx];
    const dualTrail = C.sparkDualTrail[qIdx];

    for (let i = 0; i < sparkN; i++) {
      const delay = seededRandom(i + 300) * 0.12;
      const p = clamp01((progress - delay) * 1.5);
      if (p <= 0) continue;

      let angle: number;
      let distMult = 1;
      if (fullCircle) {
        // Full circle with directional bias
        const baseAngle =
          (i / sparkN) * Math.PI * 2 + seededRandom(i + 301) * 0.3;
        const angDiff = computeAngleDiff(attackAngle, baseAngle);
        const alignment = Math.cos(angDiff);
        if (alignment > 0) {
          distMult = 1 + alignment * attackStr * dirBias;
          angle = baseAngle - angDiff * 0.7 * Math.min(attackStr, 1);
        } else {
          distMult = Math.max(0.1, 1 + alignment * attackStr * 0.8);
          angle = baseAngle;
        }
      } else {
        // Cone distribution
        const spread = (seededRandom(i + 301) - 0.5) * C.sparkConeSpread;
        angle = attackAngle + spread;
        distMult = Math.max(attackStr, sFloor);
      }

      const speed =
        C.sparkSpeedBase + seededRandom(i + 302) * C.sparkSpeedRange;
      const dist = exp.radius * (0.3 + p * C.sparkDistMult) * speed * distMult;
      const px = cx + Math.cos(angle) * dist;
      const py = cy + Math.sin(angle) * dist;

      const pFade = 1 - p;
      const pSize =
        (C.sparkSizeBase + seededRandom(i + 303) * C.sparkSizeRange) * pFade;
      if (pSize > 0.5 && pFade > 0.05) {
        if (sparkTMult > 0) {
          const tLen =
            Math.min(dist * 0.4, C.sparkTrailMax) * pFade * sparkTMult;
          if (tLen > 1.5) {
            graphics.lineStyle(pSize * 0.6, CC.sparkTrail, alpha * 0.3 * pFade);
            graphics.lineBetween(
              px - Math.cos(angle) * tLen,
              py - Math.sin(angle) * tLen,
              px,
              py,
            );
            if (dualTrail) {
              const midX = px - Math.cos(angle) * tLen * 0.5;
              const midY = py - Math.sin(angle) * tLen * 0.5;
              graphics.lineStyle(
                pSize * 0.3,
                CC.sparkTrailInner,
                alpha * 0.5 * pFade,
              );
              graphics.lineBetween(midX, midY, px, py);
            }
          }
        }
        graphics.fillStyle(CC.sparkFill, alpha * 0.9 * pFade);
        graphics.fillCircle(px, py, pSize);
        if (sparkInners >= 1) {
          graphics.fillStyle(CC.sparkInner, alpha * 0.7 * pFade);
          graphics.fillCircle(px, py, pSize * 0.5);
        }
        if (sparkInners >= 2) {
          graphics.fillStyle(CC.sparkInner, alpha * 0.5 * pFade);
          graphics.fillCircle(px, py, pSize * 0.25);
        }
      }
    }
  }

  // ======================================================================
  // FRAGMENT CONE — tight attacker direction (HIGH+ only)
  // ======================================================================
  const fragmentN = C.fragmentCount[qIdx];
  if (fragmentN > 0) {
    const fragTMult = C.fragmentTrailMult[qIdx];
    const fragInners = C.fragmentInners[qIdx];
    for (let i = 0; i < fragmentN; i++) {
      const delay = seededRandom(i + 350) * 0.08;
      const p = clamp01((progress - delay) * 1.8);
      if (p <= 0) continue;

      const spread = (seededRandom(i + 351) - 0.5) * C.fragmentSpread;
      const angle = attackAngle + spread;
      const speed =
        C.fragmentSpeedBase + seededRandom(i + 352) * C.fragmentSpeedRange;
      const dist = exp.radius * (0.5 + p * C.fragmentDistMult) * speed;
      const px = cx + Math.cos(angle) * dist;
      const py = cy + Math.sin(angle) * dist;

      const pFade = 1 - p;
      const pSize =
        (C.fragmentSizeBase + seededRandom(i + 353) * C.fragmentSizeRange) *
        pFade;
      if (pSize > 1 && pFade > 0.05) {
        if (fragTMult > 0) {
          const tLen =
            Math.min(dist * 0.4, C.fragmentTrailMax) * pFade * fragTMult;
          if (tLen > 2) {
            const tx = px - Math.cos(angle) * tLen;
            const ty = py - Math.sin(angle) * tLen;
            graphics.lineStyle(
              pSize * 0.6,
              CC.fragmentTrail,
              alpha * 0.4 * pFade,
            );
            graphics.lineBetween(tx, ty, px, py);
            graphics.lineStyle(
              pSize * 0.3,
              CC.fragmentTrailInner,
              alpha * 0.6 * pFade,
            );
            graphics.lineBetween(tx, ty, px, py);
          }
        }
        graphics.fillStyle(CC.fragmentFill, alpha * 0.9 * pFade);
        graphics.fillCircle(px, py, pSize);
        if (fragInners >= 1) {
          graphics.fillStyle(CC.fragmentInner, alpha * 0.7 * pFade);
          graphics.fillCircle(px, py, pSize * 0.6);
        }
        if (fragInners >= 2) {
          graphics.fillStyle(CC.fragmentCenter, alpha * 0.5 * pFade);
          graphics.fillCircle(px, py, pSize * 0.25);
        }
        if (fragInners >= 3) {
          graphics.fillStyle(CC.fragmentCenter, alpha * 0.4 * pFade);
          graphics.fillCircle(px, py, pSize * 0.12);
        }
      }
    }
  }

  // ======================================================================
  // DEBRIS CHUNKS — penetration direction with gravity (HIGH+ only)
  // ======================================================================
  const chunkN = C.chunkCount[qIdx];
  if (chunkN > 0) {
    const chunkInners = C.chunkInners[qIdx];
    for (let i = 0; i < chunkN; i++) {
      const delay = seededRandom(i + 400) * 0.08;
      const p = clamp01((progress - delay) * 1.3);
      if (p <= 0) continue;

      const spread = (seededRandom(i + 401) - 0.5) * C.chunkSpread;
      const angle = penAngle + spread;
      const speed =
        C.chunkSpeedBase + seededRandom(i + 402) * C.chunkSpeedRange;
      const dist =
        exp.radius *
        (0.3 + p * C.chunkDistMult) *
        speed *
        Math.max(penStr, sFloor);
      const gravityDrop = p * p * C.chunkGravity;
      const px = cx + Math.cos(angle) * dist;
      const py = cy + Math.sin(angle) * dist + gravityDrop;

      const pFade = 1 - p;
      const pSize =
        (C.chunkSizeBase + seededRandom(i + 403) * C.chunkSizeRange) * pFade;
      if (pSize > 1 && pFade > 0.05) {
        graphics.fillStyle(CC.chunkFill, alpha * 0.8 * pFade);
        graphics.fillCircle(px, py, pSize);
        if (chunkInners >= 1) {
          graphics.fillStyle(CC.chunkInner, alpha * 0.5 * pFade);
          graphics.fillCircle(px - pSize * 0.3, py - pSize * 0.3, pSize * 0.5);
        }
      }
    }
  }

  // ======================================================================
  // EMBERS — float upward (MAX only)
  // ======================================================================
  const emberN = C.emberCount[qIdx];
  if (emberN > 0 && progress > 0.15) {
    for (let i = 0; i < emberN; i++) {
      const ep = Math.max(
        0,
        (progress - 0.15 - seededRandom(i + 500) * 0.2) * 2.0,
      );
      if (ep <= 0 || ep > 1) continue;

      const baseAngle = seededRandom(i + 501) * Math.PI * 2;
      const eDist =
        exp.radius * (0.4 + ep * 0.6) * (0.5 + seededRandom(i + 502) * 0.5);
      const ex = cx + Math.cos(baseAngle) * eDist;
      const ey = cy + Math.sin(baseAngle) * eDist - ep * C.emberFloat;

      const eFade = 1 - ep;
      const eSize =
        (C.emberSizeBase + seededRandom(i + 503) * C.emberSizeRange) * eFade;
      if (eSize > 0.5 && eFade > 0.05) {
        graphics.fillStyle(CC.emberOuter, alpha * 0.8 * eFade);
        graphics.fillCircle(ex, ey, eSize);
        graphics.fillStyle(CC.emberInner, alpha * 0.6 * eFade);
        graphics.fillCircle(ex, ey, eSize * 0.5);
      }
    }
  }

  // ======================================================================
  // MOMENTUM TRAIL — combined direction (MAX only)
  // ======================================================================
  const momentumN = C.momentumCount[qIdx];
  if (momentumN > 0 && combinedMag > 0.01) {
    const combinedStr = Math.min(combinedMag / C.driftNormalize, 1);
    if (combinedStr > 0.3) {
      const combinedAngle = Math.atan2(exp.combinedY ?? 0, exp.combinedX ?? 0);
      for (let i = 0; i < momentumN; i++) {
        const trailT = i / momentumN;
        const tp = clamp01((progress - trailT * 0.2) * 1.6);
        if (tp <= 0) continue;

        const spreadAngle =
          (seededRandom(i + 600) - 0.5) * 0.6 * (1 - combinedStr * 0.5);
        const angle = combinedAngle + spreadAngle;
        const dist =
          exp.radius *
          (0.5 + tp * 2.0 + trailT * 0.8) *
          (0.8 + combinedStr * 0.4);
        const tx = exp.x + Math.cos(angle) * dist;
        const ty = exp.y + Math.sin(angle) * dist;

        const tFade = 1 - tp;
        const tSize =
          (C.momentumSizeBase + seededRandom(i + 601) * C.momentumSizeRange) *
          (1 - trailT * 0.5) *
          tFade;
        const tAlpha = alpha * 0.7 * (1 - trailT * 0.3) * tFade;

        if (tSize > 0.5 && tFade > 0.05) {
          graphics.fillStyle(CC.momentumFill, tAlpha);
          graphics.fillCircle(tx, ty, tSize);
          graphics.fillStyle(CC.momentumInner, tAlpha * 0.5);
          graphics.fillCircle(tx, ty, tSize * 0.4);
        }
      }
    }
  }
}

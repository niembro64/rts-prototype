// BurnMarkSystem - Manages scorched earth burn marks left by beam weapons
// Extracted from renderEntities.ts

import type Phaser from 'phaser';
import { BURN_COLOR_TAU, BURN_COOL_TAU, BURN_COLOR_HOT, BURN_COLOR_COOL, hexToRgb } from '../../config';
import type { Entity } from '../sim/types';

// Scorched earth burn mark left by beam weapons -- line segments matching beam width
export interface BurnMark {
  x1: number; y1: number; // segment start
  x2: number; y2: number; // segment end
  width: number;           // beam width
  age: number;             // ms since creation
  color: number;           // cached RGB color (updated during aging)
}

const BURN_HOT_RGB = hexToRgb(BURN_COLOR_HOT);
const BURN_COOL_RGB = hexToRgb(BURN_COLOR_COOL);
const MAX_BURN_MARKS = 5000;

export class BurnMarkSystem {
  marks: BurnMark[] = [];
  prevBeamEndpoints: Map<string, { x: number; y: number }> = new Map();
  frameCounter: number = 0;

  // Reusable set to track active beam keys per frame (avoids allocation)
  private _activeBeamKeys: Set<string> = new Set();

  /**
   * Sample beam endpoints from projectiles to create burn mark line segments.
   * Call once per render frame.
   * @param projectiles - iterable of all projectile entities (not just visible ones)
   * @param framesSkip - how many frames to skip between samples (from graphics config)
   * @param sampleBurn - whether this frame should actually sample (pre-computed by caller, or computed internally)
   */
  sampleBeamEndpoints(projectiles: Iterable<Entity>, framesSkip: number): void {
    this._activeBeamKeys.clear();
    const sampleBurn = this.frameCounter === 0;
    this.frameCounter = (this.frameCounter + 1) % (framesSkip + 1);

    for (const entity of projectiles) {
      const proj = entity.projectile;
      if (!proj || proj.projectileType !== 'beam') continue;
      const weaponIndex = (proj.config as { weaponIndex?: number }).weaponIndex ?? 0;
      const beamKey = `${proj.sourceEntityId}:${weaponIndex}`;
      this._activeBeamKeys.add(beamKey);
      const ex = proj.endX ?? entity.transform.x;
      const ey = proj.endY ?? entity.transform.y;
      const beamWidth = proj.config.beamWidth ?? 2;
      if (sampleBurn) {
        const prev = this.prevBeamEndpoints.get(beamKey);
        if (prev) {
          const dx = ex - prev.x;
          const dy = ey - prev.y;
          if (dx * dx + dy * dy > 1) {
            this.marks.push({ x1: prev.x, y1: prev.y, x2: ex, y2: ey, width: beamWidth, age: 0, color: BURN_COLOR_HOT });
          }
        }
        this.prevBeamEndpoints.set(beamKey, { x: ex, y: ey });
      }
    }

    // Clean up prev endpoints for beams that no longer exist
    for (const key of this.prevBeamEndpoints.keys()) {
      if (!this._activeBeamKeys.has(key)) this.prevBeamEndpoints.delete(key);
    }

    this.capMarks();
  }

  /**
   * Age burn marks, compute cached color, and prune ones that have blended to background.
   */
  update(dtMs: number, burnCutoff: number): void {
    let burnWrite = 0;
    for (let i = 0; i < this.marks.length; i++) {
      const mark = this.marks[i];
      mark.age += dtMs;
      // coolBlend approaches 1 as mark fades to background; prune when close enough
      const coolBlend = 1 - Math.exp(-mark.age / BURN_COOL_TAU);
      if (coolBlend < 1 - burnCutoff) {
        // Cache color so render pass doesn't recompute exp() per mark
        const hotDecay = Math.exp(-mark.age / BURN_COLOR_TAU);
        const red = Math.round(BURN_HOT_RGB.r * hotDecay + BURN_COOL_RGB.r * coolBlend);
        const green = Math.round(BURN_HOT_RGB.g * hotDecay + BURN_COOL_RGB.g * coolBlend);
        const blue = Math.round(BURN_HOT_RGB.b * hotDecay + BURN_COOL_RGB.b * coolBlend);
        mark.color = (red << 16) | (green << 8) | blue;
        this.marks[burnWrite++] = mark;
      }
    }
    this.marks.length = burnWrite;
  }

  /**
   * Render all burn marks. Color is pre-computed during the aging pass in update().
   */
  render(graphics: Phaser.GameObjects.Graphics, isInViewport: (x: number, y: number, padding: number) => boolean): void {
    for (let i = 0; i < this.marks.length; i++) {
      const mark = this.marks[i];
      const midX = (mark.x1 + mark.x2) * 0.5;
      const midY = (mark.y1 + mark.y2) * 0.5;
      if (!isInViewport(midX, midY, 50)) continue;
      graphics.lineStyle(mark.width, mark.color, 1);
      graphics.lineBetween(mark.x1, mark.y1, mark.x2, mark.y2);
      const r = mark.width / 2;
      graphics.fillStyle(mark.color, 1);
      graphics.fillCircle(mark.x1, mark.y1, r);
      graphics.fillCircle(mark.x2, mark.y2, r);
    }
  }

  /**
   * Cap burn marks to prevent unbounded growth.
   * Copies newest marks to front, O(MAX) not O(n) like splice.
   */
  capMarks(): void {
    if (this.marks.length > MAX_BURN_MARKS) {
      const excess = this.marks.length - MAX_BURN_MARKS;
      for (let i = 0; i < MAX_BURN_MARKS; i++) {
        this.marks[i] = this.marks[i + excess];
      }
      this.marks.length = MAX_BURN_MARKS;
    }
  }

  /**
   * Clear all burn marks and tracking state.
   */
  clear(): void {
    this.marks.length = 0;
    this.prevBeamEndpoints.clear();
    this.frameCounter = 0;
    this._activeBeamKeys.clear();
  }
}

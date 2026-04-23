// BurnMarkSystem — scorched-earth trail along beam / laser paths.
//
// Each mark is a 4-vertex quad rather than a stroked line segment. When a
// beam's endpoint moves, we append a new quad and — crucially — update the
// previous quad's end vertices to the bisector of the two segments. The
// adjacent quads therefore share an edge, producing a continuous trail
// with no overlap at joints and no gap. A mark whose end is still "free"
// (no successor yet) keeps a square cap perpendicular to its direction.

import type Phaser from '../PhaserCompat';
import {
  BURN_COLOR_TAU,
  BURN_COOL_TAU,
  BURN_COLOR_HOT,
  hexToRgb,
} from '../../config';
import type { Entity } from '../sim/types';
import { isLineShot } from '../sim/types';
import { getGraphicsConfig } from '@/clientBarConfig';

export type { BurnMark } from '@/types/render';
import type { BurnMark } from '@/types/render';

const BURN_HOT_RGB = hexToRgb(BURN_COLOR_HOT);
const BURN_COOL_COLOR = 0x221100; // dark brown residue before the alpha fade

// Burn-mark cap scales inversely with the alpha cutoff: lower cutoff →
// marks persist longer → more active marks → bigger cap. Matches the 5-tier
// `burnMarkAlphaCutoff` LOD.
function getBurnMarkCap(): number {
  const cutoff = getGraphicsConfig().burnMarkAlphaCutoff;
  if (cutoff >= 1) return 300;
  if (cutoff >= 0.5) return 800;
  if (cutoff >= 0.3) return 2000;
  if (cutoff >= 0.1) return 3500;
  return 5000;
}

/** Per-beam chain-state: last endpoint + last direction, plus a reference
 *  to the last mark added for this beam so we can miter-join the next one. */
type BeamState = {
  lastEndX: number;
  lastEndY: number;
  lastDirX: number;
  lastDirY: number;
  /** Reference to the most recently appended mark for this beam. We check
   *  its `.removed` flag before touching it — if it aged out we start a
   *  fresh square cap instead of mitering onto a dead quad. */
  prevMark: BurnMark | null;
};

// Miter length is `halfWidth / sin(θ/2)` for joint angle θ. That grows
// unboundedly at sharp angles — cap it so a tight zig-zag doesn't produce
// a spike-through-infinity. 3× halfWidth is the common PostScript default.
const MITER_LIMIT = 3;

// Pre-allocated polygon points array for fillPoints — avoids per-draw
// allocations inside the render loop.
const _polyPts: { x: number; y: number }[] = [
  { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 },
];

export class BurnMarkSystem {
  marks: BurnMark[] = [];
  /** Per-beam chain state keyed by `${sourceEntityId}:${turretIndex}`. */
  beams: Map<string, BeamState> = new Map();
  frameCounter: number = 0;

  // Reusable set to track active beam keys per frame (avoids allocation).
  private _activeBeamKeys: Set<string> = new Set();

  /** Sample beam endpoints from projectiles and append new mitered quads. */
  sampleBeamEndpoints(projectiles: Iterable<Entity>, framesSkip: number): void {
    this._activeBeamKeys.clear();
    const sampleBurn = this.frameCounter === 0;
    this.frameCounter = (this.frameCounter + 1) % (framesSkip + 1);

    for (const entity of projectiles) {
      const proj = entity.projectile;
      if (!proj || (proj.projectileType !== 'beam' && proj.projectileType !== 'laser')) continue;
      const turretIndex = proj.config.turretIndex ?? 0;
      const beamKey = `${proj.sourceEntityId}:${turretIndex}`;
      this._activeBeamKeys.add(beamKey);
      const ex = proj.endX ?? entity.transform.x;
      const ey = proj.endY ?? entity.transform.y;
      const beamWidth = isLineShot(proj.config.shot) ? proj.config.shot.width * 2 : 4;

      let state = this.beams.get(beamKey);
      if (!state) {
        state = {
          lastEndX: ex,
          lastEndY: ey,
          lastDirX: 0,
          lastDirY: 0,
          prevMark: null,
        };
        this.beams.set(beamKey, state);
        continue;
      }

      if (!sampleBurn) continue;

      const dx = ex - state.lastEndX;
      const dy = ey - state.lastEndY;
      const len2 = dx * dx + dy * dy;
      if (len2 <= 1) continue;

      const len = Math.sqrt(len2);
      const invLen = 1 / len;
      const dirX = dx * invLen;
      const dirY = dy * invLen;
      this.appendMark(state, ex, ey, dirX, dirY, beamWidth);
    }

    // Drop beam state for beams that went away this frame.
    for (const key of this.beams.keys()) {
      if (!this._activeBeamKeys.has(key)) this.beams.delete(key);
    }

    this.capMarks();
  }

  /** Append one quad to the trail. Start vertices are the bisector at the
   *  previous endpoint (or square cap if there's no live previous mark).
   *  End vertices are a square cap; they'll be rewritten to the bisector
   *  when/if a successor joins. */
  private appendMark(
    state: BeamState,
    endX: number, endY: number,
    dirX: number, dirY: number,
    width: number,
  ): void {
    const halfW = width * 0.5;
    // Right-hand perpendicular of the NEW segment direction.
    const perpRX = -dirY;
    const perpRY = dirX;

    const startCx = state.lastEndX;
    const startCy = state.lastEndY;

    // Start vertices — miter onto previous mark if we have one alive.
    let sLx: number, sLy: number, sRx: number, sRy: number;
    const prev = state.prevMark;
    const haveLivePrev = prev !== null && !prev.removed;
    if (haveLivePrev) {
      // Bisector of prevDir + newDir (both unit vectors). Its length is
      // 2·cos(θ/2) where θ is the turn angle; normalize to unit, and the
      // miter extends along the perpendicular to the bisector at distance
      // halfW / cos(θ/2) = halfW / (|sum| / 2).
      const sumX = state.lastDirX + dirX;
      const sumY = state.lastDirY + dirY;
      const sumLen = Math.sqrt(sumX * sumX + sumY * sumY);
      if (sumLen > 1e-4) {
        // Miter offset scalar = halfW * 2 / |sum| (algebraically simpler
        // than dividing by cos of half the angle).
        let miter = (halfW * 2) / sumLen;
        if (miter > halfW * MITER_LIMIT) miter = halfW * MITER_LIMIT;
        // Perpendicular to the bisector — this is where the outside of
        // the turn sits. Left/right are on opposite sides.
        const bX = sumX / sumLen;
        const bY = sumY / sumLen;
        const perpBX = -bY;
        const perpBY = bX;
        sLx = startCx - perpBX * miter;
        sLy = startCy - perpBY * miter;
        sRx = startCx + perpBX * miter;
        sRy = startCy + perpBY * miter;
      } else {
        // Degenerate (180° turn) — fall back to square cap.
        sLx = startCx - perpRX * halfW;
        sLy = startCy - perpRY * halfW;
        sRx = startCx + perpRX * halfW;
        sRy = startCy + perpRY * halfW;
      }
    } else {
      // No live predecessor — square start cap perpendicular to new dir.
      sLx = startCx - perpRX * halfW;
      sLy = startCy - perpRY * halfW;
      sRx = startCx + perpRX * halfW;
      sRy = startCy + perpRY * halfW;
    }

    // End vertices: square cap for now. Updated to a miter when a
    // subsequent mark joins this one.
    const eLx = endX - perpRX * halfW;
    const eLy = endY - perpRY * halfW;
    const eRx = endX + perpRX * halfW;
    const eRy = endY + perpRY * halfW;

    // If we mitered, rewrite the previous mark's end vertices so the two
    // quads share an edge exactly. (It's the same (sLx,sLy)/(sRx,sRy)
    // pair — we store it twice because quad vertex winding differs between
    // the two marks' start vs end pairs.)
    if (haveLivePrev) {
      prev!.x2 = sRx;
      prev!.y2 = sRy;
      prev!.x3 = sLx;
      prev!.y3 = sLy;
    }

    const mark: BurnMark = {
      x0: sLx, y0: sLy,
      x1: sRx, y1: sRy,
      x2: eRx, y2: eRy,
      x3: eLx, y3: eLy,
      dirX, dirY,
      width,
      age: 0,
      color: BURN_COLOR_HOT,
      alpha: 1,
      removed: false,
    };
    this.marks.push(mark);

    state.lastEndX = endX;
    state.lastEndY = endY;
    state.lastDirX = dirX;
    state.lastDirY = dirY;
    state.prevMark = mark;
  }

  /** Age marks, update per-frame color + alpha, prune below cutoff. */
  update(dtMs: number, burnCutoff: number): void {
    // Rational approximation of exp(-x), same as before.
    const invCoolTau = 1 / BURN_COOL_TAU;
    const invColorTau = 1 / BURN_COLOR_TAU;
    const coolRgb = hexToRgb(BURN_COOL_COLOR);
    let burnWrite = 0;
    for (let i = 0; i < this.marks.length; i++) {
      const mark = this.marks[i];
      mark.age += dtMs;
      const xCool = mark.age * invCoolTau;
      const alpha =
        1 /
        (1 + xCool + 0.48 * xCool * xCool + 0.235 * xCool * xCool * xCool);
      if (alpha < burnCutoff) {
        mark.removed = true;
        continue;
      }
      const xHot = mark.age * invColorTau;
      const hotDecay =
        1 /
        (1 + xHot + 0.48 * xHot * xHot + 0.235 * xHot * xHot * xHot);
      const coolBlend = 1 - hotDecay;
      const red = (BURN_HOT_RGB.r * hotDecay + coolRgb.r * coolBlend) | 0;
      const green = (BURN_HOT_RGB.g * hotDecay + coolRgb.g * coolBlend) | 0;
      const blue = (BURN_HOT_RGB.b * hotDecay + coolRgb.b * coolBlend) | 0;
      mark.color = (red << 16) | (green << 8) | blue;
      mark.alpha = alpha;
      this.marks[burnWrite++] = mark;
    }
    this.marks.length = burnWrite;
  }

  /** Fill each quad with its pre-computed age color/alpha. */
  render(
    graphics: Phaser.GameObjects.Graphics,
    isInViewport: (x: number, y: number, padding: number) => boolean,
  ): void {
    for (let i = 0; i < this.marks.length; i++) {
      const mark = this.marks[i];
      // Rough center for culling — average of the 4 corners.
      const midX = (mark.x0 + mark.x1 + mark.x2 + mark.x3) * 0.25;
      const midY = (mark.y0 + mark.y1 + mark.y2 + mark.y3) * 0.25;
      if (!isInViewport(midX, midY, 50)) continue;
      graphics.fillStyle(mark.color, mark.alpha);
      _polyPts[0].x = mark.x0; _polyPts[0].y = mark.y0;
      _polyPts[1].x = mark.x1; _polyPts[1].y = mark.y1;
      _polyPts[2].x = mark.x2; _polyPts[2].y = mark.y2;
      _polyPts[3].x = mark.x3; _polyPts[3].y = mark.y3;
      graphics.fillPoints(_polyPts, true);
    }
  }

  /** Drop the oldest marks if we blew past the LOD-driven cap. */
  capMarks(): void {
    const maxMarks = getBurnMarkCap();
    if (this.marks.length > maxMarks) {
      const excess = this.marks.length - maxMarks;
      for (let i = 0; i < excess; i++) this.marks[i].removed = true;
      for (let i = 0; i < maxMarks; i++) {
        this.marks[i] = this.marks[i + excess];
      }
      this.marks.length = maxMarks;
    }
  }

  /** Wipe everything — used by the renderEntities `MARKS: BURN` toggle. */
  clear(): void {
    for (const m of this.marks) m.removed = true;
    this.marks.length = 0;
    this.beams.clear();
    this.frameCounter = 0;
    this._activeBeamKeys.clear();
  }
}

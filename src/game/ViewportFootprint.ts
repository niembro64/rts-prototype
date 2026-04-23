// ViewportFootprint — shared world-space "what can the camera
// currently see on the ground plane?" representation used by both
// renderers for:
//   (a) CPU-side scope culling via the RENDER: WIN/PAD/ALL toggle
//       (prev. 2D `isInViewport` and 3D `RenderScope3D`).
//   (b) the minimap's camera-footprint quad.
//
// Why unify: each renderer used to compute its own visibility rect
// from camera-target + half-dims, which ignored camera rotation (2D)
// and perspective foreshortening (3D). Meanwhile the minimap got an
// accurate 4-corner ground-plane quad. This class uses those same 4
// corners as the source of truth, and exposes a bounding-box scope
// test that both renderers share. Tight, correct, cheap.
//
// The AABB is a conservative superset of the real visible region
// (a trapezoid in 3D, a rotated rect in 2D). That's fine for CPU
// culling — over-drawing a few entities at the corners beats
// missing ones, and the GPU does its own frustum cull on top.

import type { RenderMode } from '@/types/graphics';
import { getRenderMode } from '@/clientBarConfig';

export type Vec2 = { x: number; y: number };

/** 4 world-space points (sim x / y) in screen order: TL, TR, BR, BL. */
export type FootprintQuad = readonly [Vec2, Vec2, Vec2, Vec2];

export class ViewportFootprint {
  private _quad: FootprintQuad = [
    { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 },
  ];
  private minX = -Infinity;
  private maxX = Infinity;
  private minY = -Infinity;
  private maxY = Infinity;
  private mode: RenderMode = 'all';
  /** Cached "padded" extra margin, = 30% of max(width, height). */
  private paddedExtra = 0;

  /** Update the footprint from 4 world-space corners (same as the
   *  minimap's cameraQuad). Also refreshes the current render mode
   *  from clientBarConfig so inScope() checks it atomically. */
  setQuad(quad: FootprintQuad): void {
    this._quad = quad;
    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    for (const p of quad) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    this.minX = minX; this.maxX = maxX;
    this.minY = minY; this.maxY = maxY;
    this.mode = getRenderMode() as RenderMode;
    this.paddedExtra =
      this.mode === 'padded'
        ? Math.max(maxX - minX, maxY - minY) * 0.3
        : 0;
  }

  /** The 4 corners in screen order (TL, TR, BR, BL), sim coords. */
  get quad(): FootprintQuad {
    return this._quad;
  }

  /** Current RENDER mode (convenience passthrough, so callers that
   *  want a coarse short-circuit don't re-query clientBarConfig). */
  getMode(): RenderMode {
    return this.mode;
  }

  /** Conservative AABB scope test:
   *   - mode='all'     → always true (no culling).
   *   - mode='window'  → AABB + per-entity padding.
   *   - mode='padded'  → AABB + 30% of its larger axis + per-entity padding.
   *
   *  `padding` is in sim world units and represents the entity's own
   *  extent so a unit whose visual radius or spawned effect extends
   *  past its center isn't culled at the edge. 2D callers pass 100
   *  for units, 150 for buildings, 50 for projectiles; 3D callers
   *  use the same.
   */
  inScope(x: number, y: number, padding: number = 100): boolean {
    if (this.mode === 'all') return true;
    const p = padding + this.paddedExtra;
    return (
      x >= this.minX - p && x <= this.maxX + p &&
      y >= this.minY - p && y <= this.maxY + p
    );
  }
}

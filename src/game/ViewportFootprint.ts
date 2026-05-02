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
export type FootprintBounds = {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
};

/** 4 world-space points (sim x / y) in screen order: TL, TR, BR, BL. */
export type FootprintQuad = readonly [Vec2, Vec2, Vec2, Vec2];

export class ViewportFootprint {
  private static readonly VERSION_EPSILON = 0.01;
  private _quad: FootprintQuad = [
    { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 },
  ];
  private minX = -Infinity;
  private maxX = Infinity;
  private minY = -Infinity;
  private maxY = Infinity;
  private mode: RenderMode = 'all';
  private version = 0;
  /** Cached "padded" extra margin, = 30% of the viewport's visible
   *  edge length (NOT the AABB diagonal — under camera rotation or
   *  3D pitch the AABB is much larger than the visible quad and
   *  would over-pad, defeating the point of PAD vs ALL). */
  private paddedExtra = 0;

  /** Update the footprint from 4 world-space corners (same as the
   *  minimap's cameraQuad). `scopeBounds`, when supplied, is a more
   *  conservative culling AABB than the visible ground-plane quad:
   *  3D terrain can sit far above/below y=0, so RtsScene3D expands
   *  the scope from a vertical height band while leaving `_quad`
   *  unchanged for minimap drawing. Also refreshes the current render
   *  mode from clientBarConfig so inScope() checks it atomically. */
  setQuad(quad: FootprintQuad, scopeBounds?: FootprintBounds): void {
    this._quad = quad;
    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    for (const p of quad) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    if (scopeBounds) {
      minX = Math.min(minX, scopeBounds.minX);
      maxX = Math.max(maxX, scopeBounds.maxX);
      minY = Math.min(minY, scopeBounds.minY);
      maxY = Math.max(maxY, scopeBounds.maxY);
    }
    const nextMode = getRenderMode() as RenderMode;
    let nextPaddedExtra = 0;
    if (nextMode === 'padded') {
      // Average of the two "width" edges (top TL→TR, bottom BL→BR)
      // and the two "height" edges (left TL→BL, right TR→BR). For a
      // rotated 2D rect all four are equal; for a 3D trapezoid this
      // balances near-edge and far-edge lengths into a stable metric.
      const tl = quad[0], tr = quad[1], br = quad[2], bl = quad[3];
      const edgeLen = (a: Vec2, b: Vec2) =>
        Math.hypot(a.x - b.x, a.y - b.y);
      const avgW = (edgeLen(tl, tr) + edgeLen(bl, br)) * 0.5;
      const avgH = (edgeLen(tl, bl) + edgeLen(tr, br)) * 0.5;
      nextPaddedExtra = Math.max(avgW, avgH) * 0.3;
    }

    const eps = ViewportFootprint.VERSION_EPSILON;
    if (
      nextMode !== this.mode ||
      Math.abs(minX - this.minX) > eps ||
      Math.abs(maxX - this.maxX) > eps ||
      Math.abs(minY - this.minY) > eps ||
      Math.abs(maxY - this.maxY) > eps ||
      Math.abs(nextPaddedExtra - this.paddedExtra) > eps
    ) {
      this.version = (this.version + 1) & 0x3fffffff;
    }
    this.minX = minX; this.maxX = maxX;
    this.minY = minY; this.maxY = maxY;
    this.mode = nextMode;
    this.paddedExtra = nextPaddedExtra;
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

  getVersion(): number {
    return this.version;
  }

  /** Conservative AABB scope test:
   *   - mode='all'     → always true (no culling).
   *   - mode='window'  → AABB + per-entity padding.
   *   - mode='padded'  → AABB + 30% of the quad's average edge length
   *                      + per-entity padding.
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

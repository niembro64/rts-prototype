// RenderScope3D — world-space visibility rect driven by the
// `RENDER: WIN/PAD/ALL` toggle, for the 3D renderer.
//
// The 2D renderer uses `isInViewport(x, y, padding)` to skip drawing
// for off-screen entities; that short-circuits per-entity setup work
// (calls, state lookups, further draws). Three.js does its own GPU-side
// frustum culling automatically, so off-screen meshes don't rasterize —
// but the CPU-side update loop (position writes, locomotion IK, turret
// placement, mirror glint animation, barrel spin, debris integration,
// beam segment placement) still runs for every entity every frame
// regardless of on-screen-ness. That's the CPU cost this helper cuts.
//
// Per-frame usage:
//   renderScope.refresh(orbitTarget, halfWidth, halfHeight)
// Per-entity usage (inside any hot loop):
//   if (!renderScope.inScope(entity.x, entity.z, padding)) continue;
//
// Modes mirror the 2D `renderMode` semantics exactly:
//   'all'    — no culling, always returns true.
//   'window' — the tight camera rect + the caller's explicit padding.
//   'padded' — camera rect expanded by 30% of the larger half-dimension,
//              plus the caller's padding (matches renderEntities.ts).

import { getRenderMode } from '@/clientBarConfig';

export class RenderScope3D {
  /** Last-refreshed mode. `'all'` skips the rect check entirely. */
  private mode: 'window' | 'padded' | 'all' = 'all';
  // Scope rect in world XZ. +Infinity defaults mean "no culling."
  private xMin = -Infinity;
  private xMax = Infinity;
  private zMin = -Infinity;
  private zMax = Infinity;

  /** Recompute the scope rect from the current camera target + visible
   *  world-space half-dimensions. Call once per frame before any
   *  inScope() queries so a moving camera's rect stays fresh. */
  refresh(
    targetX: number,
    targetZ: number,
    visibleHalfWidth: number,
    visibleHalfHeight: number,
  ): void {
    this.mode = getRenderMode() as 'window' | 'padded' | 'all';
    if (this.mode === 'all') {
      this.xMin = -Infinity;
      this.xMax = Infinity;
      this.zMin = -Infinity;
      this.zMax = Infinity;
      return;
    }
    // 'padded' mode: 30% of the largest visible half-dim as extra margin.
    // Expressed in the same terms as the 2D helper (which uses
    // Math.max(view.width, view.height) * 0.3 on full-dimension worldView);
    // here halves go in so the multiplier stays 0.6 of a half = 30% of full.
    const extra =
      this.mode === 'padded'
        ? Math.max(visibleHalfWidth, visibleHalfHeight) * 0.6
        : 0;
    this.xMin = targetX - visibleHalfWidth - extra;
    this.xMax = targetX + visibleHalfWidth + extra;
    this.zMin = targetZ - visibleHalfHeight - extra;
    this.zMax = targetZ + visibleHalfHeight + extra;
  }

  /** True if (x, z) is inside the current scope, plus `padding` world
   *  units in every direction. Callers pass a per-entity padding that
   *  reflects the entity's own extent (e.g. 100 for normal units, 200
   *  for big AoE effects). On 'all' mode this always returns true. */
  inScope(x: number, z: number, padding: number = 100): boolean {
    if (this.mode === 'all') return true;
    return (
      x >= this.xMin - padding &&
      x <= this.xMax + padding &&
      z >= this.zMin - padding &&
      z <= this.zMax + padding
    );
  }

  /** Current mode, exposed for callers that want a coarse short-circuit
   *  (e.g. don't bother computing entity positions if 'all'). */
  getMode(): 'window' | 'padded' | 'all' {
    return this.mode;
  }
}

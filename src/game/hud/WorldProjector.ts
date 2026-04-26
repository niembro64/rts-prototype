// WorldProjector — minimal interface a HUD overlay uses to position itself
// over a world-space entity.

export type Vec2 = { x: number; y: number };

export interface WorldProjector {
  /**
   * Refresh any per-frame caches (viewport rect, etc.). Scenes call this once
   * per frame before overlays use the projector, so every project() /
   * worldToScreenScale() call in the same frame reads consistent data without
   * triggering a browser layout thrash.
   */
  refreshViewport(): void;

  /**
   * Project a sim (x, y, z) point to overlay pixel coordinates. The z arg
   * is the SIM altitude — the unit's center, the building's center, the
   * terrain surface at a waypoint, etc. Without it the overlay can't
   * follow units that have walked onto raised terrain. Writes result into
   * `out` and returns true if the point is visible (in-frustum, in front
   * of the camera). If it returns false, the overlay should skip drawing.
   */
  project(worldX: number, worldY: number, worldZ: number, out: Vec2): boolean;

  /**
   * Pixels-per-world-unit scale at the given world point. Used to size
   * screen-space UI proportional to entity size. The z arg is the same
   * sim altitude passed to project — perspective scale depends on camera
   * distance, which is now altitude-aware.
   */
  worldToScreenScale(worldX: number, worldY: number, worldZ: number): number;
}

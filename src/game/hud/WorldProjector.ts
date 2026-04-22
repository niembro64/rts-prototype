// WorldProjector — minimal interface a HUD overlay uses to position itself
// over a world-space entity. Implemented separately by the 2D and 3D renderers
// (one uses the Pixi orthographic camera, the other uses Three.js perspective).

export type Vec2 = { x: number; y: number };

export interface WorldProjector {
  /**
   * Project a sim (x, y) point to overlay pixel coordinates. Writes result
   * into `out` and returns true if the point is visible (in-frustum, in front
   * of the camera). If it returns false, the overlay should skip drawing.
   */
  project(worldX: number, worldY: number, out: Vec2): boolean;

  /**
   * Pixels-per-world-unit scale at the given world point. Used to size
   * screen-space UI proportional to entity size.
   *   - 2D orthographic: constant (camera.zoom)
   *   - 3D perspective:  varies with camera distance
   */
  worldToScreenScale(worldX: number, worldY: number): number;
}

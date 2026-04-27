// LinePathAccumulator — shared state machine for the right-drag
// "line path" both renderers expose. While the right mouse button
// is held, each cursor sample gets appended to a list of path
// points (dropping ones closer than LINE_PATH_SEGMENT_MIN to the
// previous point so idle jitter doesn't bloat the path), and a
// per-unit target list is recomputed via calculateLinePathTargets
// so the preview overlay can draw live assignments.
//
// Neither renderer's dispatcher logic (attack target, repair, etc.)
// belongs here — this class owns only the path mechanics.

import type { WorldPoint } from './PathDistribution';
import { calculateLinePathTargets } from './PathDistribution';
import { LINE_PATH_SEGMENT_MIN } from '../constants';
import { magnitude } from '../../math';

export class LinePathAccumulator {
  private _active = false;
  private _points: WorldPoint[] = [];
  private _targets: WorldPoint[] = [];

  get active(): boolean { return this._active; }
  get points(): readonly WorldPoint[] { return this._points; }
  get targets(): readonly WorldPoint[] { return this._targets; }

  /** Start a new path seeded at (x, y, z?). Any previous path is
   *  discarded. Callers pass the initial unit count so the target
   *  list starts populated — factory-waypoint callers can pass 1
   *  to mark the seed point as the single target. `z` is the
   *  altitude of the cursor's 3D ground hit (from CursorGround.pickSim);
   *  preserved through the accumulator so emitted commands carry the
   *  click-altitude. 2D callers omit it. */
  start(x: number, y: number, unitCount: number, z?: number): void {
    this._active = true;
    this._points = [{ x, y, z }];
    this._targets = [];
    this.recomputeTargets(unitCount);
  }

  /** Seed a path with a pre-filled target list (factory waypoints:
   *  the single placed point *is* the target, not something
   *  distributed across a path). Mirrors the 2D CommandController's
   *  factory-path start. */
  startWithFixedTarget(x: number, y: number, z?: number): void {
    this._active = true;
    this._points = [{ x, y, z }];
    this._targets = [{ x, y, z }];
  }

  /** Record a new cursor sample. Dropped as a duplicate if it's
   *  closer than LINE_PATH_SEGMENT_MIN to the previous point. On
   *  append, targets are recomputed. No-op if not active. */
  append(x: number, y: number, unitCount: number, z?: number): void {
    if (!this._active || this._points.length === 0) return;
    const last = this._points[this._points.length - 1];
    if (magnitude(x - last.x, y - last.y) < LINE_PATH_SEGMENT_MIN) return;
    this._points.push({ x, y, z });
    this.recomputeTargets(unitCount);
  }

  /** Rebuild targets from the current unit count without adding a
   *  point. 3D's per-frame mouse-move recomputes even when the
   *  cursor hasn't moved far enough to append a new segment, so
   *  the preview stays live. */
  recomputeTargets(unitCount: number): void {
    if (!this._active) return;
    this._targets =
      unitCount > 0 && this._points.length > 0
        ? calculateLinePathTargets(this._points, unitCount)
        : [];
  }

  /** End the path and reset state. */
  reset(): void {
    this._active = false;
    this._points = [];
    this._targets = [];
  }
}

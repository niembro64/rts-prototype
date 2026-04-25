// WaypointOverlay — shared SVG overlay for the command-queue visuals
// (unit action chains, factory rally waypoints). Used by both 2D and 3D
// scenes via a WorldProjector, so the 3D version gets the exact same
// visual treatment as the 2D one: thin screen-space lines, small dots
// with white outlines, build/repair squares, and a flag on the factory's
// final rally point.
//
// Styling mirrors render/selection/WaypointRenderer.ts:
//   - line width : 2 px (0.25 alpha for patrol return, 0.5 otherwise)
//   - dot radius : 6 px,   fill alpha 0.8, white outline alpha 0.6

import type { Entity } from '../sim/types';
import type { WorldProjector, Vec2 } from './WorldProjector';
import { ACTION_COLORS, WAYPOINT_COLORS } from '../uiLabels';

const SVG_NS = 'http://www.w3.org/2000/svg';

const LINE_WIDTH_PX = 2;
const LINE_ALPHA = 0.5;
const PATROL_RETURN_ALPHA = 0.25;
const DOT_RADIUS_PX = 6;
const DOT_FILL_ALPHA = 0.8;
const DOT_OUTLINE_COLOR = '#ffffff';
const DOT_OUTLINE_ALPHA = 0.6;
const DOT_OUTLINE_WIDTH_PX = 1;
const FLAG_SIZE_PX = 10; // flag marker on the factory's final rally waypoint

function hexToCss(hex: number): string {
  return `#${hex.toString(16).padStart(6, '0')}`;
}

export class WaypointOverlay {
  private svg: SVGSVGElement;
  private projector: WorldProjector;

  private linePool: SVGLineElement[] = [];
  private circlePool: SVGCircleElement[] = [];
  private rectPool: SVGRectElement[] = [];
  private pathPool: SVGPathElement[] = [];

  private _scratchA: Vec2 = { x: 0, y: 0 };
  private _scratchB: Vec2 = { x: 0, y: 0 };

  constructor(parent: HTMLElement, projector: WorldProjector) {
    this.projector = projector;
    if (getComputedStyle(parent).position === 'static') {
      parent.style.position = 'relative';
    }
    this.svg = document.createElementNS(SVG_NS, 'svg') as SVGSVGElement;
    Object.assign(this.svg.style, {
      position: 'absolute',
      inset: '0',
      width: '100%',
      height: '100%',
      pointerEvents: 'none',
      zIndex: '3',
      // Promote the SVG to its own compositor layer so it composites in sync
      // with the canvas during camera pan (avoids a one-frame desync).
      willChange: 'transform',
      transform: 'translateZ(0)',
    });
    this.svg.setAttribute('preserveAspectRatio', 'none');
    this.svg.setAttribute('shape-rendering', 'geometricPrecision');
    parent.appendChild(this.svg);
  }

  update(selectedUnits: readonly Entity[], selectedBuildings: readonly Entity[]): void {
    this.projector.refreshViewport();
    const counts = { L: 0, C: 0, R: 0, P: 0 };

    for (const u of selectedUnits) {
      const actions = u.unit?.actions;
      if (!actions || actions.length === 0) continue;

      let prevX = u.transform.x;
      let prevY = u.transform.y;
      for (let i = 0; i < actions.length; i++) {
        const a = actions[i];
        const color = ACTION_COLORS[a.type] ?? 0xffffff;
        this.drawLineIfVisible(prevX, prevY, a.x, a.y, color, LINE_ALPHA, counts);
        if (a.type === 'build' || a.type === 'repair') {
          this.drawRectIfVisible(a.x, a.y, color, counts);
        } else {
          this.drawDotIfVisible(a.x, a.y, color, counts);
        }
        prevX = a.x;
        prevY = a.y;
      }

      // Patrol return line (lower alpha)
      if (u.unit!.patrolStartIndex !== null && actions.length > 0) {
        const last = actions[actions.length - 1];
        const first = actions[u.unit!.patrolStartIndex];
        if (last.type === 'patrol' && first) {
          const color = ACTION_COLORS['patrol'];
          this.drawLineIfVisible(
            last.x, last.y,
            first.x, first.y,
            color, PATROL_RETURN_ALPHA,
            counts,
          );
        }
      }
    }

    for (const b of selectedBuildings) {
      const wps = b.factory?.waypoints;
      if (!wps || wps.length === 0) continue;

      let prevX = b.transform.x;
      let prevY = b.transform.y;
      for (let i = 0; i < wps.length; i++) {
        const w = wps[i];
        const color = WAYPOINT_COLORS[w.type] ?? 0xffffff;
        this.drawLineIfVisible(prevX, prevY, w.x, w.y, color, LINE_ALPHA, counts);
        this.drawDotIfVisible(w.x, w.y, color, counts);
        if (i === wps.length - 1) {
          this.drawFlagIfVisible(w.x, w.y, color, counts);
        }
        prevX = w.x;
        prevY = w.y;
      }

      // Patrol return line from last patrol waypoint back to first patrol waypoint
      if (wps.length > 0) {
        const last = wps[wps.length - 1];
        if (last.type === 'patrol') {
          const firstIdx = wps.findIndex((w) => w.type === 'patrol');
          if (firstIdx >= 0) {
            const first = wps[firstIdx];
            this.drawLineIfVisible(
              last.x, last.y,
              first.x, first.y,
              WAYPOINT_COLORS['patrol'], PATROL_RETURN_ALPHA,
              counts,
            );
          }
        }
      }
    }

    this.hideRemainder(counts);
  }

  // ── drawing primitives (allocate from pool, write attributes) ──

  private drawLineIfVisible(
    ax: number, ay: number, bx: number, by: number,
    color: number, alpha: number,
    counts: { L: number; C: number; R: number; P: number },
  ): void {
    if (
      !this.projector.project(ax, ay, this._scratchA) ||
      !this.projector.project(bx, by, this._scratchB)
    ) return;
    const line = this.acquireLine(counts.L++);
    line.setAttribute('x1', String(this._scratchA.x));
    line.setAttribute('y1', String(this._scratchA.y));
    line.setAttribute('x2', String(this._scratchB.x));
    line.setAttribute('y2', String(this._scratchB.y));
    line.setAttribute('stroke', hexToCss(color));
    line.setAttribute('stroke-opacity', String(alpha));
    line.setAttribute('stroke-width', String(LINE_WIDTH_PX));
  }

  private drawDotIfVisible(
    x: number, y: number, color: number,
    counts: { L: number; C: number; R: number; P: number },
  ): void {
    if (!this.projector.project(x, y, this._scratchA)) return;
    const sx = String(this._scratchA.x);
    const sy = String(this._scratchA.y);

    // Fill
    const fill = this.acquireCircle(counts.C++);
    fill.setAttribute('cx', sx);
    fill.setAttribute('cy', sy);
    fill.setAttribute('r', String(DOT_RADIUS_PX));
    fill.setAttribute('fill', hexToCss(color));
    fill.setAttribute('fill-opacity', String(DOT_FILL_ALPHA));
    fill.setAttribute('stroke', 'none');

    // White outline
    const outline = this.acquireCircle(counts.C++);
    outline.setAttribute('cx', sx);
    outline.setAttribute('cy', sy);
    outline.setAttribute('r', String(DOT_RADIUS_PX));
    outline.setAttribute('fill', 'none');
    outline.setAttribute('stroke', DOT_OUTLINE_COLOR);
    outline.setAttribute('stroke-opacity', String(DOT_OUTLINE_ALPHA));
    outline.setAttribute('stroke-width', String(DOT_OUTLINE_WIDTH_PX));
  }

  private drawRectIfVisible(
    x: number, y: number, color: number,
    counts: { L: number; C: number; R: number; P: number },
  ): void {
    if (!this.projector.project(x, y, this._scratchA)) return;
    const r = this.acquireRect(counts.R++);
    const size = DOT_RADIUS_PX * 2;
    r.setAttribute('x', String(this._scratchA.x - DOT_RADIUS_PX));
    r.setAttribute('y', String(this._scratchA.y - DOT_RADIUS_PX));
    r.setAttribute('width', String(size));
    r.setAttribute('height', String(size));
    r.setAttribute('fill', 'none');
    r.setAttribute('stroke', hexToCss(color));
    r.setAttribute('stroke-opacity', String(LINE_ALPHA + 0.3));
    r.setAttribute('stroke-width', String(LINE_WIDTH_PX));
  }

  private drawFlagIfVisible(
    x: number, y: number, color: number,
    counts: { L: number; C: number; R: number; P: number },
  ): void {
    if (!this.projector.project(x, y, this._scratchA)) return;
    // Flag: triangle + vertical pole. Pole rises from (cx, cy) to (cx, cy - FLAG_SIZE).
    // Triangle fills (cx, cy - FLAG_SIZE), (cx + FLAG_SIZE, cy - FLAG_SIZE/2), (cx, cy).
    const cx = this._scratchA.x;
    const cy = this._scratchA.y;
    const s = FLAG_SIZE_PX;
    const p = this.acquirePath(counts.P++);
    p.setAttribute(
      'd',
      `M${cx} ${cy} L${cx} ${cy - s} L${cx + s} ${cy - s / 2} Z`,
    );
    p.setAttribute('fill', hexToCss(color));
    p.setAttribute('fill-opacity', '0.9');
    p.setAttribute('stroke', hexToCss(color));
    p.setAttribute('stroke-width', '1');
  }

  // ── pool management ──

  private acquireLine(i: number): SVGLineElement {
    let el = this.linePool[i];
    if (!el) {
      el = document.createElementNS(SVG_NS, 'line') as SVGLineElement;
      this.svg.appendChild(el);
      this.linePool.push(el);
    }
    el.style.display = '';
    return el;
  }

  private acquireCircle(i: number): SVGCircleElement {
    let el = this.circlePool[i];
    if (!el) {
      el = document.createElementNS(SVG_NS, 'circle') as SVGCircleElement;
      this.svg.appendChild(el);
      this.circlePool.push(el);
    }
    el.style.display = '';
    return el;
  }

  private acquireRect(i: number): SVGRectElement {
    let el = this.rectPool[i];
    if (!el) {
      el = document.createElementNS(SVG_NS, 'rect') as SVGRectElement;
      this.svg.appendChild(el);
      this.rectPool.push(el);
    }
    el.style.display = '';
    return el;
  }

  private acquirePath(i: number): SVGPathElement {
    let el = this.pathPool[i];
    if (!el) {
      el = document.createElementNS(SVG_NS, 'path') as SVGPathElement;
      this.svg.appendChild(el);
      this.pathPool.push(el);
    }
    el.style.display = '';
    return el;
  }

  private hideRemainder(counts: { L: number; C: number; R: number; P: number }): void {
    for (let i = counts.L; i < this.linePool.length; i++) this.linePool[i].style.display = 'none';
    for (let i = counts.C; i < this.circlePool.length; i++) this.circlePool[i].style.display = 'none';
    for (let i = counts.R; i < this.rectPool.length; i++) this.rectPool[i].style.display = 'none';
    for (let i = counts.P; i < this.pathPool.length; i++) this.pathPool[i].style.display = 'none';
  }

  destroy(): void {
    this.svg.remove();
    this.linePool.length = 0;
    this.circlePool.length = 0;
    this.rectPool.length = 0;
    this.pathPool.length = 0;
  }
}

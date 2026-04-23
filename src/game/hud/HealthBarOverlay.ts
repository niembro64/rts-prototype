// HealthBarOverlay — shared entity-bar layer used by both 2D and 3D.
//
// One bar per entity, either showing HEALTH (green/red, hidden at full)
// or BUILD PROGRESS (blue, always shown) — never both. Construction
// takes priority: an incomplete building shows its build-progress bar,
// and the HP bar only surfaces once the building is complete.
//
// Rendered as SVG rectangles. With the stale-matrix fix in
// ThreeWorldProjector, positions stay in lock-step with the canvas
// during camera pan, so jitter is gone without needing to convert bars
// to HTML divs.

import type { Entity } from '../sim/types';
import type { WorldProjector, Vec2 } from './WorldProjector';

export const HEALTH_BAR_STYLE = {
  /** Bar height in screen pixels. */
  heightPx: 4,
  /** Distance in world units from the top of the entity to the bar bottom. */
  paddingWorldUnits: 10,
  bgColor: '#333333',
  bgAlpha: 0.8,
  fgColorHigh: '#44dd44',
  fgColorLow: '#ff4444',
  /** Blue — clearly different from health's green/red so the user can
   *  tell construction progress apart from HP at a glance. */
  fgColorBuild: '#4488ff',
  fgAlpha: 0.9,
  /** Below this HP fraction, foreground switches to low color. */
  lowThreshold: 0.3,
  /** Hide the bar entirely at >=100% HP. */
  hideAtFull: true,
};

const SVG_NS = 'http://www.w3.org/2000/svg';

/** What a bar currently shows — used to avoid reassigning the SVG fill
 *  attribute every frame when nothing changed. */
type BarMode = 'healthHigh' | 'healthLow' | 'build';

type Bar = {
  bg: SVGRectElement;
  fg: SVGRectElement;
  lastMode: BarMode | null;
};

export class HealthBarOverlay {
  private svg: SVGSVGElement;
  private projector: WorldProjector;
  private pool: Bar[] = [];
  private _scratch: Vec2 = { x: 0, y: 0 };

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
      zIndex: '4',
      // Promote the SVG to its own compositor layer so it composites in sync
      // with the canvas (same trick used on the other SVG overlays).
      willChange: 'transform',
      transform: 'translateZ(0)',
    });
    this.svg.setAttribute('preserveAspectRatio', 'none');
    this.svg.setAttribute('shape-rendering', 'geometricPrecision');
    parent.appendChild(this.svg);
  }

  private acquire(i: number): Bar {
    let bar = this.pool[i];
    if (!bar) {
      const bg = document.createElementNS(SVG_NS, 'rect') as SVGRectElement;
      bg.setAttribute('fill', HEALTH_BAR_STYLE.bgColor);
      bg.setAttribute('fill-opacity', String(HEALTH_BAR_STYLE.bgAlpha));
      const fg = document.createElementNS(SVG_NS, 'rect') as SVGRectElement;
      fg.setAttribute('fill-opacity', String(HEALTH_BAR_STYLE.fgAlpha));
      this.svg.appendChild(bg);
      this.svg.appendChild(fg);
      bar = { bg, fg, lastMode: null };
      this.pool.push(bar);
    }
    bar.bg.style.display = '';
    bar.fg.style.display = '';
    return bar;
  }

  update(units: readonly Entity[], buildings: readonly Entity[]): void {
    // Cache projector per-frame state once for all queries this frame.
    this.projector.refreshViewport();

    let used = 0;

    // Units — health-only. (Units-under-construction would be a factory
    // production queue edge case; the project doesn't surface per-unit
    // build progress on the client today, so just render HP.)
    for (const u of units) {
      if (!u.unit) continue;
      const hp = u.unit.hp;
      const maxHp = u.unit.maxHp;
      if (hp <= 0 || (HEALTH_BAR_STYLE.hideAtFull && hp >= maxHp)) continue;

      const radius = u.unit.unitRadiusCollider.scale;
      used = this.renderBar(
        used,
        u.transform.x, u.transform.y,
        radius, 2 * radius,
        hp / maxHp,
        'health',
      );
    }

    // Buildings — construction takes priority. Show a blue build-
    // progress bar while incomplete (even at full HP, which ghost
    // entities have), and fall back to the health bar once complete.
    for (const b of buildings) {
      if (!b.building) continue;
      const halfExtent = Math.max(b.building.width, b.building.height) / 2;
      const width = b.building.width;

      if (b.buildable && !b.buildable.isComplete) {
        const progress = Math.max(0, Math.min(1, b.buildable.buildProgress));
        used = this.renderBar(
          used,
          b.transform.x, b.transform.y,
          halfExtent, width,
          progress,
          'build',
        );
        continue;
      }

      const hp = b.building.hp;
      const maxHp = b.building.maxHp;
      if (hp <= 0 || (HEALTH_BAR_STYLE.hideAtFull && hp >= maxHp)) continue;
      used = this.renderBar(
        used,
        b.transform.x, b.transform.y,
        halfExtent, width,
        hp / maxHp,
        'health',
      );
    }

    for (let i = used; i < this.pool.length; i++) {
      this.pool[i].bg.style.display = 'none';
      this.pool[i].fg.style.display = 'none';
    }
  }

  private renderBar(
    used: number,
    worldX: number, worldY: number,
    worldTopHalfExtent: number, worldWidth: number,
    percent: number,
    kind: 'health' | 'build',
  ): number {
    if (!this.projector.project(worldX, worldY, this._scratch)) return used;
    const scale = this.projector.worldToScreenScale(worldX, worldY);
    if (scale <= 0) return used;

    const widthPx = worldWidth * scale;
    if (widthPx < 2) return used;

    const heightPx = HEALTH_BAR_STYLE.heightPx;
    const leftPx = this._scratch.x - widthPx / 2;
    const topPx =
      this._scratch.y
      - worldTopHalfExtent * scale
      - HEALTH_BAR_STYLE.paddingWorldUnits * scale
      - heightPx;

    const bar = this.acquire(used);
    bar.bg.setAttribute('x', String(leftPx));
    bar.bg.setAttribute('y', String(topPx));
    bar.bg.setAttribute('width', String(widthPx));
    bar.bg.setAttribute('height', String(heightPx));

    bar.fg.setAttribute('x', String(leftPx));
    bar.fg.setAttribute('y', String(topPx));
    bar.fg.setAttribute('width', String(Math.max(0, widthPx * percent)));
    bar.fg.setAttribute('height', String(heightPx));

    const mode: BarMode =
      kind === 'build'
        ? 'build'
        : percent < HEALTH_BAR_STYLE.lowThreshold
          ? 'healthLow'
          : 'healthHigh';
    if (bar.lastMode !== mode) {
      const fill =
        mode === 'build'
          ? HEALTH_BAR_STYLE.fgColorBuild
          : mode === 'healthLow'
            ? HEALTH_BAR_STYLE.fgColorLow
            : HEALTH_BAR_STYLE.fgColorHigh;
      bar.fg.setAttribute('fill', fill);
      bar.lastMode = mode;
    }

    return used + 1;
  }

  destroy(): void {
    this.svg.remove();
    this.pool.length = 0;
  }
}

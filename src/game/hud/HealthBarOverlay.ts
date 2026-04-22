// HealthBarOverlay — shared HP bar layer used by both the 2D and 3D scenes.
//
// Renders SVG rects positioned over each damaged entity, using a WorldProjector
// supplied by the renderer. Styling is shared (HEALTH_BAR_STYLE) so both modes
// look identical. Bars stay proportional to the entity's world size — they
// shrink/grow with camera zoom the way the 2D in-canvas bars used to.

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
  fgAlpha: 0.9,
  /** Below this HP fraction, foreground switches to low color. */
  lowThreshold: 0.3,
  /** Hide the bar entirely at >=100% HP. */
  hideAtFull: true,
};

const SVG_NS = 'http://www.w3.org/2000/svg';

type Bar = {
  bg: SVGRectElement;
  fg: SVGRectElement;
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
    });
    this.svg.setAttribute('preserveAspectRatio', 'none');
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
      bar = { bg, fg };
      this.pool.push(bar);
    }
    bar.bg.style.display = '';
    bar.fg.style.display = '';
    return bar;
  }

  update(units: readonly Entity[], buildings: readonly Entity[]): void {
    let used = 0;

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
      );
    }

    for (const b of buildings) {
      if (!b.building) continue;
      const hp = b.building.hp;
      const maxHp = b.building.maxHp;
      if (hp <= 0 || (HEALTH_BAR_STYLE.hideAtFull && hp >= maxHp)) continue;

      // Approximate the building's "top" using half of its largest dimension,
      // mirroring the 2D getTargetRadius-ish heuristic.
      const halfExtent = Math.max(b.building.width, b.building.height) / 2;
      used = this.renderBar(
        used,
        b.transform.x, b.transform.y,
        halfExtent, b.building.width,
        hp / maxHp,
      );
    }

    // Hide any leftover pool entries from previous frames.
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
  ): number {
    if (!this.projector.project(worldX, worldY, this._scratch)) return used;
    const scale = this.projector.worldToScreenScale(worldX, worldY);
    if (scale <= 0) return used;

    const widthPx = worldWidth * scale;
    if (widthPx < 2) return used; // too small to be meaningful at this zoom

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
    bar.fg.setAttribute(
      'fill',
      percent < HEALTH_BAR_STYLE.lowThreshold
        ? HEALTH_BAR_STYLE.fgColorLow
        : HEALTH_BAR_STYLE.fgColorHigh,
    );

    return used + 1;
  }

  destroy(): void {
    this.svg.remove();
    this.pool.length = 0;
  }
}

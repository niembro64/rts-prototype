// HealthBarOverlay — shared HP bar layer used by both the 2D and 3D scenes.
//
// Rendered with HTML divs positioned via CSS `transform: translate3d(X, Y, 0)`
// rather than SVG rects. Why:
//   - CSS translate3d puts each bar on the browser's GPU compositor, matching
//     the WebGL canvas's own sub-pixel smoothness.
//   - SVG rect x/y attributes are typically rasterised snapped to the pixel
//     grid, which produces visible jitter against a canvas panning smoothly
//     underneath.
// The visual spec still matches the 2D original (green/red threshold, thin
// bar above the entity, hidden at full HP).

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

type Bar = {
  bg: HTMLDivElement;  // container (positioned), draws the background
  fg: HTMLDivElement;  // child (left-aligned), draws the foreground fill
  /** Tracks the last color applied so we can avoid redundant style writes. */
  lastLow: boolean | null;
};

export class HealthBarOverlay {
  private root: HTMLDivElement;
  private projector: WorldProjector;
  private pool: Bar[] = [];
  private _scratch: Vec2 = { x: 0, y: 0 };

  constructor(parent: HTMLElement, projector: WorldProjector) {
    this.projector = projector;

    if (getComputedStyle(parent).position === 'static') {
      parent.style.position = 'relative';
    }

    this.root = document.createElement('div');
    Object.assign(this.root.style, {
      position: 'absolute',
      inset: '0',
      width: '100%',
      height: '100%',
      pointerEvents: 'none',
      overflow: 'hidden',
      zIndex: '4',
    });
    parent.appendChild(this.root);
  }

  private acquire(i: number): Bar {
    let bar = this.pool[i];
    if (!bar) {
      const bg = document.createElement('div');
      Object.assign(bg.style, {
        position: 'absolute',
        left: '0',
        top: '0',
        backgroundColor: HEALTH_BAR_STYLE.bgColor,
        opacity: String(HEALTH_BAR_STYLE.bgAlpha),
        // GPU compositor hint — the browser will keep each bar on its own
        // transform layer so movement is sub-pixel-accurate.
        willChange: 'transform',
      });
      const fg = document.createElement('div');
      Object.assign(fg.style, {
        position: 'absolute',
        left: '0',
        top: '0',
        height: '100%',
        backgroundColor: HEALTH_BAR_STYLE.fgColorHigh,
        opacity: String(HEALTH_BAR_STYLE.fgAlpha),
      });
      bg.appendChild(fg);
      this.root.appendChild(bg);
      bar = { bg, fg, lastLow: null };
      this.pool.push(bar);
    }
    bar.bg.style.display = '';
    return bar;
  }

  update(units: readonly Entity[], buildings: readonly Entity[]): void {
    // Cache any per-frame viewport data (e.g., canvas rect) exactly once for
    // all projector calls in this frame. Without this, each project() call
    // would trigger a getBoundingClientRect → layout thrash.
    this.projector.refreshViewport();

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
    // translate3d() puts the bar on the GPU compositor layer and gives full
    // sub-pixel precision (unlike left/top pixel attributes, which snap).
    bar.bg.style.transform = `translate3d(${leftPx}px, ${topPx}px, 0)`;
    bar.bg.style.width = `${widthPx}px`;
    bar.bg.style.height = `${heightPx}px`;
    const fgWidth = Math.max(0, widthPx * percent);
    bar.fg.style.width = `${fgWidth}px`;

    const isLow = percent < HEALTH_BAR_STYLE.lowThreshold;
    if (bar.lastLow !== isLow) {
      bar.fg.style.backgroundColor = isLow
        ? HEALTH_BAR_STYLE.fgColorLow
        : HEALTH_BAR_STYLE.fgColorHigh;
      bar.lastLow = isLow;
    }

    return used + 1;
  }

  destroy(): void {
    this.root.remove();
    this.pool.length = 0;
  }
}

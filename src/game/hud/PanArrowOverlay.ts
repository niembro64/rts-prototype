// PanArrowOverlay — shared SVG overlay for the pan-direction arrow.
//
// Both the 2D (Pixi) and 3D (Three.js) renderers write pan state into this
// overlay by calling `set(dirX, dirY, intensity)`. The overlay handles
// centering, rotation, scaling, and styling from EDGE_SCROLL config. This
// keeps screen-space UI (arrow, marquee, health bars) in a shared DOM layer
// and out of each renderer's drawing code.

import { EDGE_SCROLL } from '../../config';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Convert a 0xRRGGBB number and 0–1 alpha to a CSS color string. */
function rgba(hex: number, alpha: number): string {
  const r = (hex >> 16) & 0xff;
  const g = (hex >> 8) & 0xff;
  const b = hex & 0xff;
  return `rgba(${r},${g},${b},${alpha})`;
}

/** Callback to get the vertical insets of the game viewport (top/bottom bars)
 *  so the arrow can be centered in the visible game area, not the whole window. */
export type ViewportInsets = () => { top: number; bottom: number };

export class PanArrowOverlay {
  private parent: HTMLElement;
  private getInsets: ViewportInsets;

  private svg: SVGSVGElement;
  private outlineShaft: SVGLineElement;
  private outlineHead: SVGPathElement;
  private shaft: SVGLineElement;
  private head: SVGPathElement;

  constructor(parent: HTMLElement, getInsets: ViewportInsets) {
    this.parent = parent;
    this.getInsets = getInsets;

    // Ensure parent can host absolutely-positioned children
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
      display: 'none',
      zIndex: '6',
    });
    this.svg.setAttribute('preserveAspectRatio', 'none');

    // Outline (thicker, drawn behind main stroke for contrast)
    this.outlineShaft = document.createElementNS(SVG_NS, 'line') as SVGLineElement;
    this.outlineHead = document.createElementNS(SVG_NS, 'path') as SVGPathElement;
    // Main shaft + head
    this.shaft = document.createElementNS(SVG_NS, 'line') as SVGLineElement;
    this.head = document.createElementNS(SVG_NS, 'path') as SVGPathElement;

    this.applyStyles();

    this.svg.appendChild(this.outlineShaft);
    this.svg.appendChild(this.outlineHead);
    this.svg.appendChild(this.shaft);
    this.svg.appendChild(this.head);
    parent.appendChild(this.svg);
  }

  private applyStyles(): void {
    // Outline
    const outlineStroke = EDGE_SCROLL.shaftWidth + EDGE_SCROLL.outlineWidth * 2;
    const outlineColor = rgba(EDGE_SCROLL.outlineColor, EDGE_SCROLL.outlineAlpha);
    this.outlineShaft.setAttribute('stroke', outlineColor);
    this.outlineShaft.setAttribute('stroke-width', String(outlineStroke));
    this.outlineHead.setAttribute('stroke', outlineColor);
    this.outlineHead.setAttribute('stroke-width', String(outlineStroke));
    this.outlineHead.setAttribute('fill', 'none');
    this.outlineHead.setAttribute('stroke-linejoin', 'round');

    // Main shaft
    this.shaft.setAttribute(
      'stroke',
      rgba(EDGE_SCROLL.shaftColor, EDGE_SCROLL.shaftAlpha),
    );
    this.shaft.setAttribute('stroke-width', String(EDGE_SCROLL.shaftWidth));

    // Arrow head (filled + optional stroke)
    this.head.setAttribute(
      'fill',
      rgba(EDGE_SCROLL.headFillColor, EDGE_SCROLL.headFillAlpha),
    );
    if (EDGE_SCROLL.headStrokeAlpha > 0) {
      this.head.setAttribute(
        'stroke',
        rgba(EDGE_SCROLL.headStrokeColor, EDGE_SCROLL.headStrokeAlpha),
      );
      this.head.setAttribute('stroke-width', String(EDGE_SCROLL.headStrokeWidth));
    }
  }

  /** Set the arrow to a normalized direction + intensity (0–1). Intensity ≤ 0
   *  hides the arrow. The direction vector is expected to be unit-length (or
   *  zero); we normalize defensively. */
  set(dirX: number, dirY: number, intensity: number): void {
    if (intensity <= 0) {
      this.svg.style.display = 'none';
      return;
    }
    const len = Math.hypot(dirX, dirY);
    if (len <= 0) {
      this.svg.style.display = 'none';
      return;
    }
    const nx = dirX / len;
    const ny = dirY / len;

    const rect = this.parent.getBoundingClientRect();
    const insets = this.getInsets();
    const cx = rect.width * 0.5;
    const cy = insets.top + (rect.height - insets.top - insets.bottom) * 0.5;

    const gap = EDGE_SCROLL.arrowGap;
    const visibleLength = intensity * EDGE_SCROLL.arrowMaxLength;
    const headScale =
      visibleLength >= EDGE_SCROLL.headLength
        ? 1
        : visibleLength / EDGE_SCROLL.headLength;
    const headLen = EDGE_SCROLL.headLength * headScale;
    const headW = EDGE_SCROLL.headWidth * headScale;

    const perpX = -ny;
    const perpY = nx;

    const startX = cx + nx * gap;
    const startY = cy + ny * gap;
    const tipX = cx + nx * (gap + visibleLength);
    const tipY = cy + ny * (gap + visibleLength);
    const baseX = tipX - nx * headLen;
    const baseY = tipY - ny * headLen;
    const leftX = baseX + perpX * headW;
    const leftY = baseY + perpY * headW;
    const rightX = baseX - perpX * headW;
    const rightY = baseY - perpY * headW;

    const shaftEndX = baseX;
    const shaftEndY = baseY;

    this.outlineShaft.setAttribute('x1', String(startX));
    this.outlineShaft.setAttribute('y1', String(startY));
    this.outlineShaft.setAttribute('x2', String(shaftEndX));
    this.outlineShaft.setAttribute('y2', String(shaftEndY));

    const headPath = `M${tipX},${tipY} L${leftX},${leftY} L${rightX},${rightY} Z`;
    this.outlineHead.setAttribute('d', headPath);

    this.shaft.setAttribute('x1', String(startX));
    this.shaft.setAttribute('y1', String(startY));
    this.shaft.setAttribute('x2', String(shaftEndX));
    this.shaft.setAttribute('y2', String(shaftEndY));
    this.head.setAttribute('d', headPath);

    this.svg.style.display = 'block';
  }

  clear(): void {
    this.svg.style.display = 'none';
  }

  destroy(): void {
    this.svg.remove();
  }
}

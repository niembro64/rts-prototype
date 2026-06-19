import { COLORS } from '@/colorsConfig';

type Input3DScreenPoint = {
  x: number;
  y: number;
};

export class Input3DSelectionDragState {
  active = false;
  start: Input3DScreenPoint = { x: 0, y: 0 };
  end: Input3DScreenPoint = { x: 0, y: 0 };
  private readonly marquee: HTMLDivElement;

  constructor(canvas: HTMLCanvasElement) {
    this.marquee = document.createElement('div');
    Object.assign(this.marquee.style, {
      position: 'absolute',
      border: COLORS.effects.inputSelectionMarquee.border,
      background: COLORS.effects.inputSelectionMarquee.background,
      pointerEvents: 'none',
      display: 'none',
      zIndex: '5',
    });
    const parent = canvas.parentElement;
    if (parent) {
      if (getComputedStyle(parent).position === 'static') {
        parent.style.position = 'relative';
      }
      parent.appendChild(this.marquee);
    }
  }

  begin(clientX: number, clientY: number): void {
    this.active = true;
    this.start = { x: clientX, y: clientY };
    this.end = { x: clientX, y: clientY };
  }

  update(clientX: number, clientY: number, thresholdPx: number, canvasRect: DOMRect): void {
    this.end = { x: clientX, y: clientY };
    if (this.distanceFromStart(clientX, clientY) >= thresholdPx) {
      this.show(canvasRect);
    }
  }

  finish(): void {
    this.active = false;
    this.hide();
  }

  isClick(clientX: number, clientY: number, thresholdPx: number): boolean {
    return this.distanceFromStart(clientX, clientY) < thresholdPx;
  }

  destroy(): void {
    this.marquee.remove();
  }

  private distanceFromStart(clientX: number, clientY: number): number {
    const dx = clientX - this.start.x;
    const dy = clientY - this.start.y;
    return Math.hypot(dx, dy);
  }

  private show(canvasRect: DOMRect): void {
    const x = Math.min(this.start.x, this.end.x) - canvasRect.left;
    const y = Math.min(this.start.y, this.end.y) - canvasRect.top;
    const w = Math.abs(this.start.x - this.end.x);
    const h = Math.abs(this.start.y - this.end.y);
    this.marquee.style.left = `${x}px`;
    this.marquee.style.top = `${y}px`;
    this.marquee.style.width = `${w}px`;
    this.marquee.style.height = `${h}px`;
    this.marquee.style.display = 'block';
  }

  private hide(): void {
    this.marquee.style.display = 'none';
  }
}

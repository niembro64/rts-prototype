// Custom camera replacing Phaser.Cameras.Scene2D.Camera.
// Provides pan, zoom, bounds clamping, and screen↔world coordinate transforms.

export interface Viewport {
  x: number;
  y: number;
  width: number;
  height: number;
  right: number;
  bottom: number;
  contains(px: number, py: number): boolean;
}

export class Camera {
  scrollX = 0;
  scrollY = 0;
  zoom = 1;
  width: number;
  height: number;

  // Map bounds for clamping
  private boundsX = 0;
  private boundsY = 0;
  private boundsW = Infinity;
  private boundsH = Infinity;

  private _bgColor = '#000000';

  // Reusable viewport object (avoids allocation per frame)
  private _vp: Viewport = {
    x: 0, y: 0, width: 0, height: 0, right: 0, bottom: 0,
    contains(px: number, py: number): boolean {
      return px >= this.x && px <= this.right && py >= this.y && py <= this.bottom;
    },
  };

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
  }

  setBackgroundColor(color: string | number): void {
    this._bgColor = typeof color === 'number'
      ? '#' + color.toString(16).padStart(6, '0')
      : color;
  }

  getBackgroundColor(): string {
    return this._bgColor;
  }

  setBounds(x: number, y: number, w: number, h: number): void {
    this.boundsX = x;
    this.boundsY = y;
    this.boundsW = w;
    this.boundsH = h;
  }

  setZoom(z: number): void {
    this.zoom = z;
  }

  centerOn(x: number, y: number): void {
    this.scrollX = x - this.width / (2 * this.zoom);
    this.scrollY = y - this.height / (2 * this.zoom);
    this.clamp();
  }

  resize(w: number, h: number): void {
    this.width = w;
    this.height = h;
  }

  /** Get the world-space rectangle currently visible. */
  get worldView(): Viewport {
    const vw = this.width / this.zoom;
    const vh = this.height / this.zoom;
    this._vp.x = this.scrollX;
    this._vp.y = this.scrollY;
    this._vp.width = vw;
    this._vp.height = vh;
    this._vp.right = this.scrollX + vw;
    this._vp.bottom = this.scrollY + vh;
    return this._vp;
  }

  /** Convert screen coordinates to world coordinates. */
  getWorldPoint(screenX: number, screenY: number): { x: number; y: number } {
    return {
      x: screenX / this.zoom + this.scrollX,
      y: screenY / this.zoom + this.scrollY,
    };
  }

  /** Clamp scroll to map bounds. */
  clamp(): void {
    const vw = this.width / this.zoom;
    const vh = this.height / this.zoom;
    const maxX = this.boundsX + this.boundsW - vw;
    const maxY = this.boundsY + this.boundsH - vh;
    this.scrollX = Math.max(this.boundsX, Math.min(this.scrollX, maxX));
    this.scrollY = Math.max(this.boundsY, Math.min(this.scrollY, maxY));
  }
}

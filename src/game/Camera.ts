// Custom camera replacing Phaser.Cameras.Scene2D.Camera.
// scrollX/scrollY represent the TOP-LEFT of the visible viewport (same as Phaser).
// In Phaser, camera.scrollX is actually the center of the viewport internally,
// but worldView.x = scrollX - width/(2*zoom). We match Phaser's external behavior:
// scrollX/scrollY = top-left corner of what's visible in world space.

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
  /** Top-left world X of the viewport. Matches Phaser's camera.scrollX. */
  scrollX = 0;
  /** Top-left world Y of the viewport. Matches Phaser's camera.scrollY. */
  scrollY = 0;
  zoom = 1;
  /** Camera rotation in radians. The world container rotates by
   *  -rotation around the viewport center so that a positive rotation
   *  here rotates the scene clockwise on screen — matching the
   *  intuition of "turn the camera clockwise". */
  rotation = 0;
  width: number;
  height: number;

  // Map bounds for clamping
  private boundsX = 0;
  private boundsY = 0;
  private boundsW = Infinity;
  private boundsH = Infinity;

  private _bgColor = '#000000';

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

  /** Center the camera on a world point. */
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

  /** Convert world coordinates to screen coordinates — the inverse
   *  of getWorldPoint. Used by the selection system when checking
   *  which units fall inside a screen-space drag rect (matches the
   *  3D renderer's approach, which projects world positions to NDC
   *  and tests against the screen rect). */
  getScreenPoint(worldX: number, worldY: number): { x: number; y: number } {
    const targetX = this.scrollX + this.width / (2 * this.zoom);
    const targetY = this.scrollY + this.height / (2 * this.zoom);
    const rx = (worldX - targetX) * this.zoom;
    const ry = (worldY - targetY) * this.zoom;
    // Inverse rotation: getWorldPoint rotates the screen vector by
    // +rotation, so going the other way rotates by -rotation.
    const cos = Math.cos(this.rotation);
    const sin = Math.sin(this.rotation);
    const dx = rx * cos + ry * sin;
    const dy = -rx * sin + ry * cos;
    return {
      x: dx + this.width / 2,
      y: dy + this.height / 2,
    };
  }

  /** Convert screen coordinates to world coordinates. Inverts the
   *  world container's transform chain: translate (viewport center) →
   *  rotate (-camera.rotation) → scale (zoom) → translate (pivot). */
  getWorldPoint(screenX: number, screenY: number): { x: number; y: number } {
    // Viewport-center-relative screen coords.
    const dx = screenX - this.width / 2;
    const dy = screenY - this.height / 2;
    // Inverse rotation: since the world is rotated by -camera.rotation,
    // we rotate the screen vector by +camera.rotation to undo it.
    const cos = Math.cos(this.rotation);
    const sin = Math.sin(this.rotation);
    const rx = dx * cos - dy * sin;
    const ry = dx * sin + dy * cos;
    // Descale then add world-space viewport center (the "target").
    const targetX = this.scrollX + this.width / (2 * this.zoom);
    const targetY = this.scrollY + this.height / (2 * this.zoom);
    return {
      x: rx / this.zoom + targetX,
      y: ry / this.zoom + targetY,
    };
  }

  /** Clamp scroll to map bounds. */
  clamp(): void {
    const vw = this.width / this.zoom;
    const vh = this.height / this.zoom;
    const maxX = this.boundsX + this.boundsW - vw;
    const maxY = this.boundsY + this.boundsH - vh;
    if (maxX > this.boundsX) {
      this.scrollX = Math.max(this.boundsX, Math.min(this.scrollX, maxX));
    }
    if (maxY > this.boundsY) {
      this.scrollY = Math.max(this.boundsY, Math.min(this.scrollY, maxY));
    }
  }
}

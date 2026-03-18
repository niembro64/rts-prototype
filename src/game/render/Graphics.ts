// Phaser-compatible Graphics interface backed by PIXI.Graphics.
// All render files use this interface so they work with either backend.

import { Graphics as PIXIGraphics } from 'pixi.js';

/**
 * Subset of Phaser.GameObjects.Graphics methods used by the codebase.
 * Implemented by GraphicsAdapter wrapping PIXI.Graphics.
 */
export interface IGraphics {
  clear(): void;
  fillStyle(color: number, alpha?: number): void;
  lineStyle(width: number, color: number, alpha?: number): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  strokeRect(x: number, y: number, w: number, h: number): void;
  fillCircle(x: number, y: number, radius: number): void;
  strokeCircle(x: number, y: number, radius: number): void;
  fillTriangle(x1: number, y1: number, x2: number, y2: number, x3: number, y3: number): void;
  fillPoints(points: { x: number; y: number }[], close?: boolean): void;
  strokePoints(points: { x: number; y: number }[], close?: boolean): void;
  lineBetween(x1: number, y1: number, x2: number, y2: number): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number, anticlockwise?: boolean): void;
  closePath(): void;
  fill(): void;
  fillPath(): void;
  strokePath(): void;
  setDepth(depth: number): void;
  setBlendMode(mode: number): void;
  setScrollFactor(x: number, y?: number): void;
  destroy(): void;
}

// Blend mode constants matching Phaser.BlendModes
export const BlendModes = {
  NORMAL: 0,
  ADD: 1,
  MULTIPLY: 2,
  SCREEN: 3,
} as const;

/**
 * Wraps PIXI.Graphics with Phaser-like API.
 * Call methods in the same order as Phaser: fillStyle/lineStyle, then draw shape.
 */
export class GraphicsAdapter implements IGraphics {
  public pixi: PIXIGraphics;

  // Current fill/line state (Phaser sets state then draws, PixiJS uses begin/end)
  private _fillColor = 0x000000;
  private _fillAlpha = 1;
  private _lineWidth = 0;
  private _lineColor = 0x000000;
  private _lineAlpha = 1;
  _hasFill = false;
  private _hasLine = false;

  // Path building state

  // Fixed to screen (for HUD elements like edge scroll overlay)
  public fixedToCamera = false;

  constructor() {
    this.pixi = new PIXIGraphics();
  }

  clear(): void {
    this.pixi.clear();
    // path ended
  }

  fillStyle(color: number, alpha = 1): void {
    this._fillColor = color;
    this._fillAlpha = alpha;
    this._hasFill = true;
  }

  lineStyle(width: number, color: number, alpha = 1): void {
    this._lineWidth = width;
    this._lineColor = color;
    this._lineAlpha = alpha;
    this._hasLine = width > 0;
  }

  private applyLine(): void {
    if (this._hasLine) {
      this.pixi.lineStyle(this._lineWidth, this._lineColor, this._lineAlpha);
    } else {
      this.pixi.lineStyle(0, 0, 0);
    }
  }

  fillRect(x: number, y: number, w: number, h: number): void {
    this.pixi.beginFill(this._fillColor, this._fillAlpha);
    this.pixi.lineStyle(0, 0, 0);
    this.pixi.drawRect(x, y, w, h);
    this.pixi.endFill();
  }

  strokeRect(x: number, y: number, w: number, h: number): void {
    this.applyLine();
    this.pixi.beginFill(0, 0); // no fill
    this.pixi.drawRect(x, y, w, h);
    this.pixi.endFill();
  }

  fillCircle(x: number, y: number, radius: number): void {
    this.pixi.beginFill(this._fillColor, this._fillAlpha);
    this.pixi.lineStyle(0, 0, 0);
    this.pixi.drawCircle(x, y, radius);
    this.pixi.endFill();
  }

  strokeCircle(x: number, y: number, radius: number): void {
    this.applyLine();
    this.pixi.beginFill(0, 0); // no fill
    this.pixi.drawCircle(x, y, radius);
    this.pixi.endFill();
  }

  fillTriangle(x1: number, y1: number, x2: number, y2: number, x3: number, y3: number): void {
    this.pixi.beginFill(this._fillColor, this._fillAlpha);
    this.pixi.lineStyle(0, 0, 0);
    this.pixi.moveTo(x1, y1);
    this.pixi.lineTo(x2, y2);
    this.pixi.lineTo(x3, y3);
    this.pixi.closePath();
    this.pixi.endFill();
  }

  fillPoints(points: { x: number; y: number }[], _close = true): void {
    if (points.length < 3) return;
    this.pixi.beginFill(this._fillColor, this._fillAlpha);
    this.pixi.lineStyle(0, 0, 0);
    const flat: number[] = [];
    for (const p of points) {
      flat.push(p.x, p.y);
    }
    this.pixi.drawPolygon(flat);
    this.pixi.endFill();
  }

  strokePoints(points: { x: number; y: number }[], _close = true): void {
    if (points.length < 2) return;
    this.applyLine();
    const flat: number[] = [];
    for (const p of points) {
      flat.push(p.x, p.y);
    }
    this.pixi.drawPolygon(flat);
  }

  lineBetween(x1: number, y1: number, x2: number, y2: number): void {
    this.applyLine();
    this.pixi.moveTo(x1, y1);
    this.pixi.lineTo(x2, y2);
  }

  // Path building (Phaser pattern: beginPath → moveTo/lineTo → closePath → fillPath/strokePath)
  beginPath(): void {
    // path started
  }

  moveTo(x: number, y: number): void {
    this.pixi.moveTo(x, y);
  }

  lineTo(x: number, y: number): void {
    this.pixi.lineTo(x, y);
  }

  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number, anticlockwise = false): void {
    this.pixi.arc(x, y, radius, startAngle, endAngle, anticlockwise);
  }

  closePath(): void {
    this.pixi.closePath();
  }

  /** Alias for fillPath (compatibility with code using .fill()) */
  fill(): void { this.fillPath(); }

  fillPath(): void {
    // In PixiJS, we need to have started with beginFill before the path
    // Since Phaser does fillStyle → beginPath → draw → fillPath,
    // we re-draw by flushing current geometry with fill
    this.pixi.beginFill(this._fillColor, this._fillAlpha);
    this.pixi.endFill();
    // path ended
  }

  strokePath(): void {
    this.applyLine();
    // path ended
  }

  setDepth(_depth: number): void {
    // Depth is managed by container ordering in PixiJS
    // The pixi object's zIndex could be set, but we use container order instead
  }

  setBlendMode(mode: number): void {
    // Map Phaser blend modes to PixiJS
    const PIXI_BLEND: Record<number, number> = {
      0: 0, // NORMAL
      1: 1, // ADD
      2: 2, // MULTIPLY
      3: 3, // SCREEN
    };
    this.pixi.blendMode = PIXI_BLEND[mode] ?? 0;
  }

  setScrollFactor(_x: number, _y?: number): void {
    // Mark as fixed to camera (handled by the scene's render loop)
    this.fixedToCamera = _x === 0;
  }

  destroy(): void {
    this.pixi.destroy();
  }
}

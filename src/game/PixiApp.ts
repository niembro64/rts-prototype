// PixiJS application wrapper — replaces Phaser.Game.
// Manages the PIXI.Application, update loop, and resize handling.

import { Application, Container } from 'pixi.js';
import { Camera } from './Camera';

export class PixiApp {
  public app: Application;
  public camera: Camera;
  /** World container — all game objects go here. Transformed by camera. */
  public world: Container;
  /** HUD container — fixed to screen (not affected by camera). */
  public hud: Container;

  private _updateCallback: ((time: number, delta: number) => void) | null = null;
  private _lastTime = 0;
  private _running = false;
  private _rafId = 0;

  constructor(parent: HTMLElement, width: number, height: number, backgroundColor: string) {
    this.app = new Application({
      width,
      height,
      backgroundColor: parseInt(backgroundColor.replace('#', ''), 16),
      antialias: true,
      resolution: window.devicePixelRatio || 1,
      autoDensity: true,
    });

    parent.appendChild(this.app.view as HTMLCanvasElement);

    this.camera = new Camera(width, height);
    this.camera.setBackgroundColor(backgroundColor);

    // World container (camera-transformed)
    this.world = new Container();
    this.app.stage.addChild(this.world);

    // HUD container (screen-fixed, on top)
    this.hud = new Container();
    this.app.stage.addChild(this.hud);

    // Handle resize
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width: w, height: h } = entry.contentRect;
        if (w > 0 && h > 0) {
          this.app.renderer.resize(w, h);
          this.camera.resize(w, h);
        }
      }
    });
    ro.observe(parent);
  }

  /** Get the canvas element. */
  get canvas(): HTMLCanvasElement {
    return this.app.view as HTMLCanvasElement;
  }

  /** Set the per-frame update callback. */
  onUpdate(cb: (time: number, delta: number) => void): void {
    this._updateCallback = cb;
  }

  /** Start the update + render loop. */
  start(): void {
    if (this._running) return;
    this._running = true;
    this._lastTime = performance.now();
    this._loop(this._lastTime);
  }

  /** Stop the loop. */
  stop(): void {
    this._running = false;
    if (this._rafId) {
      cancelAnimationFrame(this._rafId);
      this._rafId = 0;
    }
  }

  private _loop = (now: number): void => {
    if (!this._running) return;
    this._rafId = requestAnimationFrame(this._loop);

    const delta = now - this._lastTime;
    this._lastTime = now;

    // Apply camera transform to world container
    const cam = this.camera;
    this.world.scale.set(cam.zoom, cam.zoom);
    this.world.position.set(-cam.scrollX * cam.zoom, -cam.scrollY * cam.zoom);

    // Run game update
    if (this._updateCallback) {
      this._updateCallback(now, delta);
    }

    // Render
    this.app.renderer.render(this.app.stage);
  };

  /** Destroy the application and clean up. */
  destroy(): void {
    this.stop();
    this.app.destroy(true, { children: true });
  }
}

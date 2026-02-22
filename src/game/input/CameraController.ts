import Phaser from 'phaser';
import { ZOOM_MIN, ZOOM_MAX, ZOOM_FACTOR, CAMERA_PAN_MULTIPLIER, EDGE_SCROLL } from '../../config';
import { getEdgeScrollEnabled, getBottomBarsHeight } from '../render/graphicsSettings';
import type { InputState } from './InputState';

/**
 * CameraController - Handles camera panning (middle-mouse drag), zoom (scroll wheel),
 * and edge scrolling.
 */
export class CameraController {
  private scene: Phaser.Scene;
  private state: InputState;
  private wheelHandler: (pointer: Phaser.Input.Pointer, _gos: unknown, _dx: number, dy: number) => void;
  private edgeOverlay: Phaser.GameObjects.Graphics;

  constructor(scene: Phaser.Scene, state: InputState) {
    this.scene = scene;
    this.state = state;

    // Screen-fixed overlay for edge scroll border zone
    this.edgeOverlay = scene.add.graphics();
    this.edgeOverlay.setScrollFactor(0);
    this.edgeOverlay.setDepth(999);

    this.wheelHandler = (pointer: Phaser.Input.Pointer, _gos: unknown, _dx: number, dy: number) => {
      const camera = this.scene.cameras.main;
      const oldZoom = camera.zoom;

      const newZoom = dy > 0
        ? oldZoom / ZOOM_FACTOR
        : oldZoom * ZOOM_FACTOR;
      const clampedZoom = Phaser.Math.Clamp(newZoom, ZOOM_MIN, ZOOM_MAX);

      if (clampedZoom === oldZoom) return;

      const cursorOffsetX = pointer.x - camera.width / 2;
      const cursorOffsetY = pointer.y - camera.height / 2;

      const worldX = camera.scrollX + cursorOffsetX / oldZoom;
      const worldY = camera.scrollY + cursorOffsetY / oldZoom;

      camera.scrollX = worldX - cursorOffsetX / clampedZoom;
      camera.scrollY = worldY - cursorOffsetY / clampedZoom;
      camera.zoom = clampedZoom;
    };
  }

  /** Start camera pan from a screen-space point */
  startPan(screenX: number, screenY: number): void {
    this.state.isPanningCamera = true;
    this.state.panStartX = screenX;
    this.state.panStartY = screenY;
    this.state.cameraStartX = this.scene.cameras.main.scrollX;
    this.state.cameraStartY = this.scene.cameras.main.scrollY;
  }

  /** Update camera pan based on current screen-space pointer position */
  updatePan(screenX: number, screenY: number): void {
    // Camera moves in the direction of mouse movement (like Beyond All Reason)
    const dx = (screenX - this.state.panStartX) * CAMERA_PAN_MULTIPLIER;
    const dy = (screenY - this.state.panStartY) * CAMERA_PAN_MULTIPLIER;
    const camera = this.scene.cameras.main;
    camera.scrollX = this.state.cameraStartX + dx / camera.zoom;
    camera.scrollY = this.state.cameraStartY + dy / camera.zoom;
  }

  /** Stop camera pan */
  endPan(): void {
    this.state.isPanningCamera = false;
  }

  /** Setup wheel zoom event */
  setupWheelEvent(): void {
    this.scene.input.on('wheel', this.wheelHandler);
  }

  destroy(): void {
    this.scene.input.off('wheel', this.wheelHandler);
    this.edgeOverlay.destroy();
  }

  /** Edge scroll: move camera when pointer is near viewport edges, draw border overlay */
  updateEdgeScroll(delta: number): void {
    this.edgeOverlay.clear();

    if (!getEdgeScrollEnabled()) return;

    const camera = this.scene.cameras.main;

    // Effective viewport in screen pixels (exclude top bar and bottom bars)
    const topInset = EDGE_SCROLL.topBarHeight;
    const bottomInset = getBottomBarsHeight();
    const vpLeft = 0;
    const vpRight = camera.width;
    const vpTop = topInset;
    const vpBottom = camera.height - bottomInset;
    const vpW = vpRight - vpLeft;
    const vpH = vpBottom - vpTop;

    if (vpW <= 0 || vpH <= 0) return;

    // Border zone dimensions in screen pixels
    const borderW = vpW * EDGE_SCROLL.borderRatio;
    const borderH = vpH * EDGE_SCROLL.borderRatio;

    // scrollFactor(0) prevents scroll but Phaser still applies zoom.
    // Invert the zoom transform so the overlay stays pixel-perfect on screen.
    const zoom = camera.zoom;
    const cx = camera.width * 0.5;
    const cy = camera.height * 0.5;
    const gx = (sx: number) => (sx - cx * (1 - zoom)) / zoom;
    const gy = (sy: number) => (sy - cy * (1 - zoom)) / zoom;
    const gw = (sw: number) => sw / zoom;
    const gh = (sh: number) => sh / zoom;

    const { overlay } = EDGE_SCROLL;

    // Draw semi-transparent border zone (4 strips)
    this.edgeOverlay.fillStyle(overlay.fillColor, overlay.fillAlpha);
    // Top strip
    this.edgeOverlay.fillRect(gx(vpLeft), gy(vpTop), gw(vpW), gh(borderH));
    // Bottom strip
    this.edgeOverlay.fillRect(gx(vpLeft), gy(vpBottom - borderH), gw(vpW), gh(borderH));
    // Left strip (between top and bottom strips)
    this.edgeOverlay.fillRect(gx(vpLeft), gy(vpTop + borderH), gw(borderW), gh(vpH - borderH * 2));
    // Right strip (between top and bottom strips)
    this.edgeOverlay.fillRect(gx(vpRight - borderW), gy(vpTop + borderH), gw(borderW), gh(vpH - borderH * 2));

    // Inner border line
    this.edgeOverlay.lineStyle(overlay.strokeWidth / zoom, overlay.strokeColor, overlay.strokeAlpha);
    this.edgeOverlay.strokeRect(
      gx(vpLeft + borderW), gy(vpTop + borderH),
      gw(vpW - borderW * 2), gh(vpH - borderH * 2),
    );

    // Camera scrolling
    if (this.state.isPanningCamera || this.state.isDraggingSelection || this.state.isDrawingLinePath) return;

    const pointer = this.scene.input.activePointer;
    const dtSec = delta / 1000;

    // Check pointer is within the effective viewport
    const px = pointer.x;
    const py = pointer.y;
    if (px < vpLeft || px > vpRight || py < vpTop || py > vpBottom) return;

    // Normalize to [-1, +1] within viewport
    const nx = ((px - vpLeft) / vpW) * 2 - 1; // -1 = left edge, +1 = right edge
    const ny = ((py - vpTop) / vpH) * 2 - 1;  // -1 = top edge, +1 = bottom edge

    // In [-1,+1] normalized space, borderRatio fraction of viewport = 2*borderRatio units
    const normBorder = 2 * EDGE_SCROLL.borderRatio;
    const threshold = 1 - normBorder;
    const abx = Math.abs(nx);
    const aby = Math.abs(ny);

    // If pointer is not in the edge zone on either axis, skip
    if (abx < threshold && aby < threshold) return;

    // Compute direction and intensity per axis
    let dx = 0;
    let dy = 0;

    if (abx >= threshold) {
      const intensity = Math.min((abx - threshold) / normBorder, 1);
      dx = Math.sign(nx) * intensity;
    }
    if (aby >= threshold) {
      const intensity = Math.min((aby - threshold) / normBorder, 1);
      dy = Math.sign(ny) * intensity;
    }

    // Normalize direction vector
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len === 0) return;
    dx /= len;
    dy /= len;

    // Apply scroll (speed scales inversely with zoom for consistency)
    const speed = EDGE_SCROLL.speed * dtSec / camera.zoom;
    camera.scrollX += dx * speed * len;
    camera.scrollY += dy * speed * len;
  }

  // Get current zoom level
  getZoom(): number {
    return this.scene.cameras.main.zoom;
  }
}

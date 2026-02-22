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

  /** Edge scroll, border overlay (only when mouse is in zone), and pan direction arrow */
  updateEdgeScroll(delta: number): void {
    this.edgeOverlay.clear();

    const camera = this.scene.cameras.main;
    const zoom = camera.zoom;

    // scrollFactor(0) prevents scroll but Phaser still applies zoom.
    // Invert the zoom transform so the overlay stays pixel-perfect on screen.
    const halfW = camera.width * 0.5;
    const halfH = camera.height * 0.5;
    const gx = (sx: number) => (sx - halfW * (1 - zoom)) / zoom;
    const gy = (sy: number) => (sy - halfH * (1 - zoom)) / zoom;
    const gs = (s: number) => s / zoom;

    let arrowDirX = 0;
    let arrowDirY = 0;
    let arrowIntensity = 0;

    // --- Edge scroll ---
    if (getEdgeScrollEnabled()) {
      const topInset = EDGE_SCROLL.topBarHeight;
      const bottomInset = getBottomBarsHeight();
      const vpLeft = 0;
      const vpRight = camera.width;
      const vpTop = topInset;
      const vpBottom = camera.height - bottomInset;
      const vpW = vpRight - vpLeft;
      const vpH = vpBottom - vpTop;

      if (vpW > 0 && vpH > 0) {
        const borderW = vpW * EDGE_SCROLL.borderRatio;
        const borderH = vpH * EDGE_SCROLL.borderRatio;
        const vpCenterX = vpLeft + vpW * 0.5;
        const vpCenterY = vpTop + vpH * 0.5;

        const pointer = this.scene.input.activePointer;
        const px = pointer.x;
        const py = pointer.y;

        // Compute intensity (depth into border zone)
        let intensity = 0;
        if (px >= vpLeft && px <= vpRight && py >= vpTop && py <= vpBottom) {
          const depthX = Math.max(0, (Math.abs(px - vpCenterX) - (vpW * 0.5 - borderW)) / borderW);
          const depthY = Math.max(0, (Math.abs(py - vpCenterY) - (vpH * 0.5 - borderH)) / borderH);
          intensity = Math.min(Math.max(depthX, depthY), 1);
        }

        // Only draw overlay when mouse is in the border zone
        if (intensity > 0) {
          const { overlay } = EDGE_SCROLL;
          this.edgeOverlay.fillStyle(overlay.fillColor, overlay.fillAlpha);
          // Top strip
          this.edgeOverlay.fillRect(gx(vpLeft), gy(vpTop), gs(vpW), gs(borderH));
          // Bottom strip
          this.edgeOverlay.fillRect(gx(vpLeft), gy(vpBottom - borderH), gs(vpW), gs(borderH));
          // Left strip (between top and bottom strips)
          this.edgeOverlay.fillRect(gx(vpLeft), gy(vpTop + borderH), gs(borderW), gs(vpH - borderH * 2));
          // Right strip (between top and bottom strips)
          this.edgeOverlay.fillRect(gx(vpRight - borderW), gy(vpTop + borderH), gs(borderW), gs(vpH - borderH * 2));

          // Inner border line
          this.edgeOverlay.lineStyle(overlay.strokeWidth / zoom, overlay.strokeColor, overlay.strokeAlpha);
          this.edgeOverlay.strokeRect(
            gx(vpLeft + borderW), gy(vpTop + borderH),
            gs(vpW - borderW * 2), gs(vpH - borderH * 2),
          );
        }

        // Apply scrolling (skip if in another drag state)
        if (intensity > 0 && !this.state.isPanningCamera && !this.state.isDraggingSelection && !this.state.isDrawingLinePath) {
          let dirX = px - vpCenterX;
          let dirY = py - vpCenterY;
          const dirLen = Math.sqrt(dirX * dirX + dirY * dirY);
          if (dirLen > 0) {
            dirX /= dirLen;
            dirY /= dirLen;
            const dtSec = delta / 1000;
            const speed = EDGE_SCROLL.speed * intensity * dtSec / camera.zoom;
            camera.scrollX += dirX * speed;
            camera.scrollY += dirY * speed;

            arrowDirX = dirX;
            arrowDirY = dirY;
            arrowIntensity = intensity;
          }
        }
      }
    }

    // --- Drag pan arrow ---
    if (this.state.isPanningCamera) {
      const pointer = this.scene.input.activePointer;
      const dx = pointer.x - this.state.panStartX;
      const dy = pointer.y - this.state.panStartY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > 0) {
        arrowDirX = dx / dist;
        arrowDirY = dy / dist;
        arrowIntensity = Math.min(dist / EDGE_SCROLL.arrow.dragMaxDist, 1);
      }
    }

    // --- Draw pan direction arrow at screen center ---
    if (arrowIntensity > 0) {
      const { arrow } = EDGE_SCROLL;
      const length = arrowIntensity * arrow.maxLength;
      if (length >= arrow.head.length) {
        const perpX = -arrowDirY;
        const perpY = arrowDirX;

        const startSX = halfW + arrowDirX * arrow.gap;
        const startSY = halfH + arrowDirY * arrow.gap;
        const tipSX = halfW + arrowDirX * length;
        const tipSY = halfH + arrowDirY * length;
        const baseSX = tipSX - arrowDirX * arrow.head.length;
        const baseSY = tipSY - arrowDirY * arrow.head.length;
        const headLX = baseSX + perpX * arrow.head.width;
        const headLY = baseSY + perpY * arrow.head.width;
        const headRX = baseSX - perpX * arrow.head.width;
        const headRY = baseSY - perpY * arrow.head.width;

        // Outline pass (thicker, behind)
        const { outline } = arrow;
        this.edgeOverlay.lineStyle((arrow.shaft.width + outline.width * 2) / zoom, outline.color, outline.alpha);
        this.edgeOverlay.beginPath();
        this.edgeOverlay.moveTo(gx(startSX), gy(startSY));
        this.edgeOverlay.lineTo(gx(baseSX), gy(baseSY));
        this.edgeOverlay.strokePath();

        this.edgeOverlay.lineStyle((arrow.shaft.width + outline.width * 2) / zoom, outline.color, outline.alpha);
        this.edgeOverlay.beginPath();
        this.edgeOverlay.moveTo(gx(tipSX), gy(tipSY));
        this.edgeOverlay.lineTo(gx(headLX), gy(headLY));
        this.edgeOverlay.lineTo(gx(headRX), gy(headRY));
        this.edgeOverlay.closePath();
        this.edgeOverlay.strokePath();

        // Shaft line
        this.edgeOverlay.lineStyle(arrow.shaft.width / zoom, arrow.shaft.color, arrow.shaft.alpha);
        this.edgeOverlay.beginPath();
        this.edgeOverlay.moveTo(gx(startSX), gy(startSY));
        this.edgeOverlay.lineTo(gx(baseSX), gy(baseSY));
        this.edgeOverlay.strokePath();

        // Arrowhead (filled triangle)
        this.edgeOverlay.fillStyle(arrow.head.color, arrow.head.alpha);
        this.edgeOverlay.beginPath();
        this.edgeOverlay.moveTo(gx(tipSX), gy(tipSY));
        this.edgeOverlay.lineTo(gx(headLX), gy(headLY));
        this.edgeOverlay.lineTo(gx(headRX), gy(headRY));
        this.edgeOverlay.closePath();
        this.edgeOverlay.fillPath();
      }
    }
  }

  // Get current zoom level
  getZoom(): number {
    return this.scene.cameras.main.zoom;
  }
}

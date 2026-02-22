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
    this.edgeOverlay.setDepth(EDGE_SCROLL.depth);

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

    // Effective viewport center (accounts for top bar and bottom bars)
    const topInset = EDGE_SCROLL.topBarHeight;
    const bottomInset = getBottomBarsHeight();
    const screenCenterX = camera.width * 0.5;
    const screenCenterY = topInset + (camera.height - topInset - bottomInset) * 0.5;

    let arrowDirX = 0;
    let arrowDirY = 0;
    let arrowIntensity = 0;

    // --- Edge scroll ---
    if (getEdgeScrollEnabled()) {
      const vpLeft = 0;
      const vpRight = camera.width;
      const vpTop = topInset;
      const vpBottom = camera.height - bottomInset;
      const vpW = vpRight - vpLeft;
      const vpH = vpBottom - vpTop;

      if (vpW > 0 && vpH > 0) {
        const borderW = vpW * EDGE_SCROLL.borderRatio;
        const borderH = vpH * EDGE_SCROLL.borderRatio;
        const vpCenterX = screenCenterX;
        const vpCenterY = screenCenterY;

        // Inner ellipse semi-axes (inscribed in what was the old inner rect)
        const erx = vpW * 0.5 - borderW;
        const ery = vpH * 0.5 - borderH;

        const pointer = this.scene.input.activePointer;
        const px = pointer.x;
        const py = pointer.y;

        // Compute intensity using elliptical distance
        let intensity = 0;
        if (px >= vpLeft && px <= vpRight && py >= vpTop && py <= vpBottom) {
          const relX = px - vpCenterX;
          const relY = py - vpCenterY;
          const ellDist = Math.sqrt((relX / erx) ** 2 + (relY / ery) ** 2);

          if (ellDist > 1) {
            // Mouse is outside the ellipse — in the pan zone
            const mouseDist = Math.sqrt(relX * relX + relY * relY);
            if (mouseDist > 0) {
              const dx = relX / mouseDist;
              const dy = relY / mouseDist;

              // Distance from center to ellipse boundary in this direction
              const ellipseDist = 1 / Math.sqrt((dx / erx) ** 2 + (dy / ery) ** 2);

              // Distance from center to viewport rect edge in this direction
              let rectDist = Infinity;
              if (dx !== 0) {
                const t1 = (vpLeft - vpCenterX) / dx;
                const t2 = (vpRight - vpCenterX) / dx;
                if (t1 > 0) rectDist = Math.min(rectDist, t1);
                if (t2 > 0) rectDist = Math.min(rectDist, t2);
              }
              if (dy !== 0) {
                const t1 = (vpTop - vpCenterY) / dy;
                const t2 = (vpBottom - vpCenterY) / dy;
                if (t1 > 0) rectDist = Math.min(rectDist, t1);
                if (t2 > 0) rectDist = Math.min(rectDist, t2);
              }

              const rawIntensity = Math.min((mouseDist - ellipseDist) / (rectDist - ellipseDist), 1);
              intensity = Math.pow(rawIntensity, EDGE_SCROLL.intensityCurve);
            }
          }
        }

        // Only draw overlay when mouse is in the border zone
        if (intensity > 0) {
          const seg = EDGE_SCROLL.ovalSegments;

          // Oval fill (inner ellipse)
          if (EDGE_SCROLL.ovalFillAlpha > 0) {
            this.edgeOverlay.fillStyle(EDGE_SCROLL.ovalFillColor, EDGE_SCROLL.ovalFillAlpha);
            this.edgeOverlay.beginPath();
            for (let i = 0; i <= seg; i++) {
              const angle = (i / seg) * Math.PI * 2;
              const ex = vpCenterX + erx * Math.cos(angle);
              const ey = vpCenterY + ery * Math.sin(angle);
              if (i === 0) {
                this.edgeOverlay.moveTo(gx(ex), gy(ey));
              } else {
                this.edgeOverlay.lineTo(gx(ex), gy(ey));
              }
            }
            this.edgeOverlay.closePath();
            this.edgeOverlay.fillPath();
          }

          // Ring fill (region between viewport rect and inner ellipse)
          // Drawn as polygon segments — one per ellipse slice — to avoid
          // Phaser's WebGL renderer ignoring path holes.
          if (EDGE_SCROLL.ringFillAlpha > 0) {
            // CW rect corners: TR, BR, BL, TL — corner[e] sits between edge e and (e+1)%4
            const corners = [
              { x: vpRight, y: vpTop },
              { x: vpRight, y: vpBottom },
              { x: vpLeft,  y: vpBottom },
              { x: vpLeft,  y: vpTop },
            ];

            this.edgeOverlay.fillStyle(EDGE_SCROLL.ringFillColor, EDGE_SCROLL.ringFillAlpha);
            this.edgeOverlay.beginPath();
            for (let i = 0; i < seg; i++) {
              const a0 = (i / seg) * Math.PI * 2;
              const a1 = ((i + 1) / seg) * Math.PI * 2;

              // Inner ellipse points
              const ex0 = vpCenterX + erx * Math.cos(a0);
              const ey0 = vpCenterY + ery * Math.sin(a0);
              const ex1 = vpCenterX + erx * Math.cos(a1);
              const ey1 = vpCenterY + ery * Math.sin(a1);

              // Outer rect boundary points via ray-rect intersection
              const r0 = this.rayRect(vpCenterX, vpCenterY, a0, vpLeft, vpTop, vpRight, vpBottom);
              const r1 = this.rayRect(vpCenterX, vpCenterY, a1, vpLeft, vpTop, vpRight, vpBottom);

              // Build polygon: ellipse arc → rect boundary (inserting corners)
              this.edgeOverlay.moveTo(gx(ex0), gy(ey0));
              this.edgeOverlay.lineTo(gx(r0.x), gy(r0.y));
              // Insert CW corners between r0.edge and r1.edge
              let e = r0.edge;
              while (e !== r1.edge) {
                this.edgeOverlay.lineTo(gx(corners[e].x), gy(corners[e].y));
                e = (e + 1) % 4;
              }
              this.edgeOverlay.lineTo(gx(r1.x), gy(r1.y));
              this.edgeOverlay.lineTo(gx(ex1), gy(ey1));
              this.edgeOverlay.closePath();
            }
            this.edgeOverlay.fillPath();
          }

          // Oval stroke (inner ellipse border)
          if (EDGE_SCROLL.ovalStrokeAlpha > 0) {
            this.edgeOverlay.lineStyle(EDGE_SCROLL.ovalStrokeWidth / zoom, EDGE_SCROLL.ovalStrokeColor, EDGE_SCROLL.ovalStrokeAlpha);
            this.edgeOverlay.beginPath();
            for (let i = 0; i <= seg; i++) {
              const angle = (i / seg) * Math.PI * 2;
              const ex = vpCenterX + erx * Math.cos(angle);
              const ey = vpCenterY + ery * Math.sin(angle);
              if (i === 0) {
                this.edgeOverlay.moveTo(gx(ex), gy(ey));
              } else {
                this.edgeOverlay.lineTo(gx(ex), gy(ey));
              }
            }
            this.edgeOverlay.strokePath();
          }
        }

        // Apply scrolling (skip if in another drag/click state)
        if (intensity > 0 && !this.state.isPanningCamera && !this.state.isDraggingSelection && !this.state.isDrawingLinePath && !pointer.rightButtonDown()) {
          const relX = px - vpCenterX;
          const relY = py - vpCenterY;
          const dirLen = Math.sqrt(relX * relX + relY * relY);
          if (dirLen > 0) {
            const dirX = relX / dirLen;
            const dirY = relY / dirLen;
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
        arrowIntensity = Math.min(dist / EDGE_SCROLL.arrowDragMaxDist, 1);
      }
    }

    // --- Draw pan direction arrow at screen center ---
    if (arrowIntensity > 0) {
      const gap = EDGE_SCROLL.arrowGap;
      const visibleLength = arrowIntensity * EDGE_SCROLL.arrowMaxLength;

      // Scale head to fit when arrow is short
      const headScale = visibleLength >= EDGE_SCROLL.headLength ? 1 : visibleLength / EDGE_SCROLL.headLength;
      const headLen = EDGE_SCROLL.headLength * headScale;
      const headW = EDGE_SCROLL.headWidth * headScale;

      const perpX = -arrowDirY;
      const perpY = arrowDirX;

      const startSX = screenCenterX + arrowDirX * gap;
      const startSY = screenCenterY + arrowDirY * gap;
      const tipSX = screenCenterX + arrowDirX * (gap + visibleLength);
      const tipSY = screenCenterY + arrowDirY * (gap + visibleLength);
      const baseSX = tipSX - arrowDirX * headLen;
      const baseSY = tipSY - arrowDirY * headLen;
      const headLX = baseSX + perpX * headW;
      const headLY = baseSY + perpY * headW;
      const headRX = baseSX - perpX * headW;
      const headRY = baseSY - perpY * headW;

      // Outline pass (thicker, behind)
      if (EDGE_SCROLL.outlineAlpha > 0) {
        this.edgeOverlay.lineStyle((EDGE_SCROLL.shaftWidth + EDGE_SCROLL.outlineWidth * 2) / zoom, EDGE_SCROLL.outlineColor, EDGE_SCROLL.outlineAlpha);
        this.edgeOverlay.beginPath();
        this.edgeOverlay.moveTo(gx(startSX), gy(startSY));
        this.edgeOverlay.lineTo(gx(baseSX), gy(baseSY));
        this.edgeOverlay.strokePath();

        this.edgeOverlay.lineStyle((EDGE_SCROLL.shaftWidth + EDGE_SCROLL.outlineWidth * 2) / zoom, EDGE_SCROLL.outlineColor, EDGE_SCROLL.outlineAlpha);
        this.edgeOverlay.beginPath();
        this.edgeOverlay.moveTo(gx(tipSX), gy(tipSY));
        this.edgeOverlay.lineTo(gx(headLX), gy(headLY));
        this.edgeOverlay.lineTo(gx(headRX), gy(headRY));
        this.edgeOverlay.closePath();
        this.edgeOverlay.strokePath();
      }

      // Shaft line
      this.edgeOverlay.lineStyle(EDGE_SCROLL.shaftWidth / zoom, EDGE_SCROLL.shaftColor, EDGE_SCROLL.shaftAlpha);
      this.edgeOverlay.beginPath();
      this.edgeOverlay.moveTo(gx(startSX), gy(startSY));
      this.edgeOverlay.lineTo(gx(baseSX), gy(baseSY));
      this.edgeOverlay.strokePath();

      // Arrowhead fill
      this.edgeOverlay.fillStyle(EDGE_SCROLL.headFillColor, EDGE_SCROLL.headFillAlpha);
      this.edgeOverlay.beginPath();
      this.edgeOverlay.moveTo(gx(tipSX), gy(tipSY));
      this.edgeOverlay.lineTo(gx(headLX), gy(headLY));
      this.edgeOverlay.lineTo(gx(headRX), gy(headRY));
      this.edgeOverlay.closePath();
      this.edgeOverlay.fillPath();

      // Arrowhead stroke
      if (EDGE_SCROLL.headStrokeAlpha > 0) {
        this.edgeOverlay.lineStyle(EDGE_SCROLL.headStrokeWidth / zoom, EDGE_SCROLL.headStrokeColor, EDGE_SCROLL.headStrokeAlpha);
        this.edgeOverlay.beginPath();
        this.edgeOverlay.moveTo(gx(tipSX), gy(tipSY));
        this.edgeOverlay.lineTo(gx(headLX), gy(headLY));
        this.edgeOverlay.lineTo(gx(headRX), gy(headRY));
        this.edgeOverlay.closePath();
        this.edgeOverlay.strokePath();
      }
    }
  }

  /** Ray from (cx,cy) at angle → first intersection with viewport rect, plus which edge */
  private rayRect(
    cx: number, cy: number, angle: number,
    left: number, top: number, right: number, bottom: number,
  ): { x: number; y: number; edge: number } {
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    let tMin = Infinity;
    let edge = 0;

    if (dx > 0)      { const t = (right - cx) / dx;  if (t > 0 && t < tMin) { tMin = t; edge = 1; } }
    else if (dx < 0) { const t = (left - cx) / dx;   if (t > 0 && t < tMin) { tMin = t; edge = 3; } }
    if (dy > 0)      { const t = (bottom - cy) / dy;  if (t > 0 && t < tMin) { tMin = t; edge = 2; } }
    else if (dy < 0) { const t = (top - cy) / dy;    if (t > 0 && t < tMin) { tMin = t; edge = 0; } }

    return { x: cx + dx * tMin, y: cy + dy * tMin, edge };
  }

  // Get current zoom level
  getZoom(): number {
    return this.scene.cameras.main.zoom;
  }
}

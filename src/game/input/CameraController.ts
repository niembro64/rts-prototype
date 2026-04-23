import Phaser from '../PhaserCompat';
import {
  ZOOM_MIN,
  ZOOM_MAX,
  ZOOM_FACTOR,
  CAMERA_PAN_MULTIPLIER,
  EDGE_SCROLL,
} from '../../config';
import { getEdgeScrollEnabled, getBottomBarsHeight } from '@/clientBarConfig';
import type { InputState } from './InputState';
import type { PanArrowOverlay } from '../hud/PanArrowOverlay';

/**
 * CameraController - Handles camera panning (middle-mouse drag), zoom (scroll wheel),
 * and edge scrolling.
 */
export class CameraController {
  private scene: Phaser.Scene;
  private state: InputState;
  private wheelHandler: (
    pointer: Phaser.Input.Pointer,
    _gos: unknown,
    _dx: number,
    dy: number,
  ) => void;
  private edgeOverlay: Phaser.GameObjects.Graphics;
  private panArrow: PanArrowOverlay | null = null;

  constructor(scene: Phaser.Scene, state: InputState) {
    this.scene = scene;
    this.state = state;

    // Screen-fixed overlay for edge scroll border zone (the ellipses are
    // currently invisible via EDGE_SCROLL alphas, but we keep the geometry
    // drawing here in case they're re-enabled). The pan arrow is drawn by
    // the shared PanArrowOverlay, not this layer.
    this.edgeOverlay = scene.add.graphics();
    this.edgeOverlay.setScrollFactor(0);
    this.edgeOverlay.setDepth(EDGE_SCROLL.depth);

    this.wheelHandler = (
      pointer: Phaser.Input.Pointer,
      _gos: unknown,
      _dx: number,
      dy: number,
    ) => {
      const camera = this.scene.cameras.main;
      const oldZoom = camera.zoom;

      const newZoom = dy > 0 ? oldZoom / ZOOM_FACTOR : oldZoom * ZOOM_FACTOR;
      const clampedZoom = Phaser.Math.Clamp(newZoom, ZOOM_MIN, ZOOM_MAX);

      if (clampedZoom === oldZoom) return;

      // Zoom around the cursor: compute the world point under the
      // pointer BEFORE the zoom change, apply the new zoom, then
      // translate so the same world point re-projects to the same
      // screen position. Using camera.getWorldPoint on both sides
      // handles camera rotation correctly — the old direct formula
      // (scrollX + pointer.x / zoom) assumed zero rotation.
      const before = camera.getWorldPoint(pointer.x, pointer.y);
      camera.zoom = clampedZoom;
      const after = camera.getWorldPoint(pointer.x, pointer.y);
      camera.scrollX += before.x - after.x;
      camera.scrollY += before.y - after.y;
      camera.clamp();
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
    // Camera moves in the direction of mouse movement (like Beyond All
    // Reason). Screen-space delta needs to be rotated back into world
    // space before we apply it to scrollX/Y, otherwise a rotated camera
    // drifts along the wrong axis when the user drags.
    const dxs = (screenX - this.state.panStartX) * CAMERA_PAN_MULTIPLIER;
    const dys = (screenY - this.state.panStartY) * CAMERA_PAN_MULTIPLIER;
    const camera = this.scene.cameras.main;
    const cos = Math.cos(camera.rotation);
    const sin = Math.sin(camera.rotation);
    const dxw = (dxs * cos - dys * sin) / camera.zoom;
    const dyw = (dxs * sin + dys * cos) / camera.zoom;
    camera.scrollX = this.state.cameraStartX + dxw;
    camera.scrollY = this.state.cameraStartY + dyw;
  }

  /** Update camera pan for touch — map follows finger (1:1, inverted direction) */
  updateTouchPan(screenX: number, screenY: number): void {
    const dxs = screenX - this.state.panStartX;
    const dys = screenY - this.state.panStartY;
    const camera = this.scene.cameras.main;
    const cos = Math.cos(camera.rotation);
    const sin = Math.sin(camera.rotation);
    const dxw = (dxs * cos - dys * sin) / camera.zoom;
    const dyw = (dxs * sin + dys * cos) / camera.zoom;
    camera.scrollX = this.state.cameraStartX - dxw;
    camera.scrollY = this.state.cameraStartY - dyw;
  }

  /** Stop camera pan */
  endPan(): void {
    this.state.isPanningCamera = false;
  }

  /** Setup wheel zoom event */
  setupWheelEvent(): void {
    this.scene.input.on('wheel', this.wheelHandler);
  }

  setPanArrowOverlay(overlay: PanArrowOverlay | null): void {
    this.panArrow = overlay;
  }

  destroy(): void {
    this.scene.input.off('wheel', this.wheelHandler);
    this.edgeOverlay.destroy();
    this.panArrow?.clear();
  }

  /** Edge scroll, border overlay (only when mouse is in zone), and pan direction arrow */
  updateEdgeScroll(delta: number): void {
    this.edgeOverlay.clear();

    const camera = this.scene.cameras.main;

    // Edge overlay is in the HUD container (screen-fixed, no camera transform).
    // Screen coordinates map directly — no zoom correction needed.
    const gx = (sx: number) => sx;
    const gy = (sy: number) => sy;

    // Effective viewport center (accounts for top bar and bottom bars)
    const topInset = EDGE_SCROLL.topBarHeight;
    const bottomInset = getBottomBarsHeight();
    const screenCenterX = camera.width * 0.5;
    const screenCenterY =
      topInset + (camera.height - topInset - bottomInset) * 0.5;

    let arrowDirX = 0;
    let arrowDirY = 0;
    let arrowIntensity = 0;

    // --- Edge scroll ---
    if (getEdgeScrollEnabled()) {
      const vpW = camera.width;
      const vpH = camera.height - topInset - bottomInset;

      if (vpW > 0 && vpH > 0) {
        const cx = screenCenterX;
        const cy = screenCenterY;

        // Inner ellipse semi-axes
        const irx = vpW * (0.5 - EDGE_SCROLL.borderRatioInner);
        const iry = vpH * (0.5 - EDGE_SCROLL.borderRatioInner);
        // Outer ellipse semi-axes
        const orx = vpW * (0.5 - EDGE_SCROLL.borderRatioOuter);
        const ory = vpH * (0.5 - EDGE_SCROLL.borderRatioOuter);

        const pointer = this.scene.input.activePointer;
        const px = pointer.x;
        const py = pointer.y;
        const relX = px - cx;
        const relY = py - cy;

        // Normalized elliptical distances (1.0 = on the boundary)
        const innerEllDist = Math.sqrt((relX / irx) ** 2 + (relY / iry) ** 2);
        const outerEllDist = Math.sqrt((relX / orx) ** 2 + (relY / ory) ** 2);

        // Mouse is in the pan zone when outside inner oval and inside outer oval
        let intensity = 0;
        if (innerEllDist > 1 && outerEllDist < 1) {
          const mouseDist = Math.sqrt(relX * relX + relY * relY);
          if (mouseDist > 0) {
            const dx = relX / mouseDist;
            const dy = relY / mouseDist;
            const innerDist = 1 / Math.sqrt((dx / irx) ** 2 + (dy / iry) ** 2);
            const outerDist = 1 / Math.sqrt((dx / orx) ** 2 + (dy / ory) ** 2);
            const rawIntensity = Math.min(
              (mouseDist - innerDist) / (outerDist - innerDist),
              1,
            );
            intensity = Math.pow(rawIntensity, EDGE_SCROLL.intensityCurve);
          }
        }

        // Only draw overlay when mouse is in the pan zone
        if (intensity > 0) {
          const seg = EDGE_SCROLL.ovalSegments;

          // Inner oval fill
          if (EDGE_SCROLL.innerOvalFillAlpha > 0) {
            this.edgeOverlay.fillStyle(
              EDGE_SCROLL.innerOvalFillColor,
              EDGE_SCROLL.innerOvalFillAlpha,
            );
            this.edgeOverlay.beginPath();
            for (let i = 0; i <= seg; i++) {
              const angle = (i / seg) * Math.PI * 2;
              const ex = cx + irx * Math.cos(angle);
              const ey = cy + iry * Math.sin(angle);
              if (i === 0) this.edgeOverlay.moveTo(gx(ex), gy(ey));
              else this.edgeOverlay.lineTo(gx(ex), gy(ey));
            }
            this.edgeOverlay.closePath();
            this.edgeOverlay.fillPath();
          }

          // Ring fill (quad strip between inner and outer ovals)
          if (EDGE_SCROLL.ringFillAlpha > 0) {
            this.edgeOverlay.fillStyle(
              EDGE_SCROLL.ringFillColor,
              EDGE_SCROLL.ringFillAlpha,
            );
            this.edgeOverlay.beginPath();
            for (let i = 0; i < seg; i++) {
              const a0 = (i / seg) * Math.PI * 2;
              const a1 = ((i + 1) / seg) * Math.PI * 2;
              const c0 = Math.cos(a0),
                s0 = Math.sin(a0);
              const c1 = Math.cos(a1),
                s1 = Math.sin(a1);
              // Quad: inner0 → outer0 → outer1 → inner1
              this.edgeOverlay.moveTo(gx(cx + irx * c0), gy(cy + iry * s0));
              this.edgeOverlay.lineTo(gx(cx + orx * c0), gy(cy + ory * s0));
              this.edgeOverlay.lineTo(gx(cx + orx * c1), gy(cy + ory * s1));
              this.edgeOverlay.lineTo(gx(cx + irx * c1), gy(cy + iry * s1));
              this.edgeOverlay.closePath();
            }
            this.edgeOverlay.fillPath();
          }

          // Inner oval stroke
          if (EDGE_SCROLL.innerOvalStrokeAlpha > 0) {
            this.edgeOverlay.lineStyle(
              EDGE_SCROLL.innerOvalStrokeWidth ,
              EDGE_SCROLL.innerOvalStrokeColor,
              EDGE_SCROLL.innerOvalStrokeAlpha,
            );
            this.edgeOverlay.beginPath();
            for (let i = 0; i <= seg; i++) {
              const angle = (i / seg) * Math.PI * 2;
              const ex = cx + irx * Math.cos(angle);
              const ey = cy + iry * Math.sin(angle);
              if (i === 0) this.edgeOverlay.moveTo(gx(ex), gy(ey));
              else this.edgeOverlay.lineTo(gx(ex), gy(ey));
            }
            this.edgeOverlay.strokePath();
          }

          // Outer oval stroke
          if (EDGE_SCROLL.outerOvalStrokeAlpha > 0) {
            this.edgeOverlay.lineStyle(
              EDGE_SCROLL.outerOvalStrokeWidth ,
              EDGE_SCROLL.outerOvalStrokeColor,
              EDGE_SCROLL.outerOvalStrokeAlpha,
            );
            this.edgeOverlay.beginPath();
            for (let i = 0; i <= seg; i++) {
              const angle = (i / seg) * Math.PI * 2;
              const ex = cx + orx * Math.cos(angle);
              const ey = cy + ory * Math.sin(angle);
              if (i === 0) this.edgeOverlay.moveTo(gx(ex), gy(ey));
              else this.edgeOverlay.lineTo(gx(ex), gy(ey));
            }
            this.edgeOverlay.strokePath();
          }
        }

        // Apply scrolling (skip if in another drag/click state)
        if (
          intensity > 0 &&
          !this.state.isPanningCamera &&
          !this.state.isDraggingSelection &&
          !this.state.isDrawingLinePath &&
          !pointer.rightButtonDown()
        ) {
          const dirLen = Math.sqrt(relX * relX + relY * relY);
          if (dirLen > 0) {
            const dirX = relX / dirLen;
            const dirY = relY / dirLen;
            const dtSec = delta / 1000;
            const speed = (EDGE_SCROLL.speed * intensity * dtSec) / camera.zoom;
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

    // Arrow rendering is delegated to the shared PanArrowOverlay (DOM/SVG),
    // so both 2D and 3D use identical rendering + styling from EDGE_SCROLL.
    if (this.panArrow) {
      if (arrowIntensity > 0) {
        this.panArrow.set(arrowDirX, arrowDirY, arrowIntensity);
      } else {
        this.panArrow.clear();
      }
    }
  }

  /** Unified two-finger gesture: zoom + pan in a single operation.
   *  All coordinates are canvas-relative pixels.
   *  The world point that was under the previous midpoint ends up
   *  under the current midpoint — this handles both pan and zoom. */
  applyTwoFingerGesture(
    prevDist: number, currDist: number,
    prevMidX: number, prevMidY: number,
    currMidX: number, currMidY: number,
  ): void {
    const camera = this.scene.cameras.main;

    // 1. World point under the previous midpoint
    const worldX = camera.scrollX + prevMidX / camera.zoom;
    const worldY = camera.scrollY + prevMidY / camera.zoom;

    // 2. Apply zoom from pinch distance change
    if (prevDist > 0) {
      const scale = currDist / prevDist;
      camera.zoom = Phaser.Math.Clamp(camera.zoom * scale, ZOOM_MIN, ZOOM_MAX);
    }

    // 3. Re-anchor: place that world point under the current midpoint
    camera.scrollX = worldX - currMidX / camera.zoom;
    camera.scrollY = worldY - currMidY / camera.zoom;
  }

  // Get current zoom level
  getZoom(): number {
    return this.scene.cameras.main.zoom;
  }
}

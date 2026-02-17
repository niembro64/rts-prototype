import Phaser from 'phaser';
import { ZOOM_MIN, ZOOM_MAX, ZOOM_FACTOR, CAMERA_PAN_MULTIPLIER } from '../../config';
import type { InputState } from './InputState';

/**
 * CameraController - Handles camera panning (middle-mouse drag), zoom (scroll wheel),
 * and edge scrolling.
 */
export class CameraController {
  private scene: Phaser.Scene;
  private state: InputState;

  constructor(scene: Phaser.Scene, state: InputState) {
    this.scene = scene;
    this.state = state;
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
    this.scene.input.on('wheel', (pointer: Phaser.Input.Pointer, _gos: unknown, _dx: number, dy: number) => {
      const camera = this.scene.cameras.main;
      const oldZoom = camera.zoom;

      // Calculate new zoom level
      const newZoom = dy > 0
        ? oldZoom / ZOOM_FACTOR  // Scroll down = zoom out
        : oldZoom * ZOOM_FACTOR; // Scroll up = zoom in
      const clampedZoom = Phaser.Math.Clamp(newZoom, ZOOM_MIN, ZOOM_MAX);

      // Skip if zoom didn't change (at min/max)
      if (clampedZoom === oldZoom) return;

      // Cursor offset from screen center (Phaser camera is centered by default)
      const cursorOffsetX = pointer.x - camera.width / 2;
      const cursorOffsetY = pointer.y - camera.height / 2;

      // Calculate world point under cursor with current zoom
      // Formula: worldX = scrollX + cursorOffset / zoom
      const worldX = camera.scrollX + cursorOffsetX / oldZoom;
      const worldY = camera.scrollY + cursorOffsetY / oldZoom;

      // Calculate new scroll to keep same world point under cursor after zoom
      // We want: worldX = newScrollX + cursorOffset / newZoom
      // So: newScrollX = worldX - cursorOffset / newZoom
      camera.scrollX = worldX - cursorOffsetX / clampedZoom;
      camera.scrollY = worldY - cursorOffsetY / clampedZoom;
      camera.zoom = clampedZoom;
    });
  }

  // Get current zoom level
  getZoom(): number {
    return this.scene.cameras.main.zoom;
  }
}

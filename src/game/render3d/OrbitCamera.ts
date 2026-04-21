// OrbitCamera — RTS-style orbit camera controller for Three.js.
//
// Controls:
//   - Scroll wheel        → zoom (dolly along view direction)
//   - Alt + middle drag   → orbit (yaw + pitch)
//   - Middle drag         → pan (move target on ground plane)
//   - Shift + middle drag → pan (alias)

import * as THREE from 'three';

export type OrbitCameraOptions = {
  minDistance?: number;
  maxDistance?: number;
  minPitch?: number;
  maxPitch?: number;
  zoomSpeed?: number;
  rotateSpeed?: number;
  panSpeed?: number;
};

export class OrbitCamera {
  public camera: THREE.PerspectiveCamera;
  /** World-space point the camera orbits around. */
  public target = new THREE.Vector3(0, 0, 0);
  /** Distance from target. */
  public distance = 1500;
  /** Yaw (rotation around world-Y), radians. */
  public yaw = 0;
  /** Pitch (tilt from vertical), radians. 0 = straight down, PI/2 = horizontal. */
  public pitch = Math.PI * 0.25;

  private minDistance: number;
  private maxDistance: number;
  private minPitch: number;
  private maxPitch: number;
  private zoomSpeed: number;
  private rotateSpeed: number;
  private panSpeed: number;

  private dragMode: 'none' | 'orbit' | 'pan' = 'none';
  private lastMouseX = 0;
  private lastMouseY = 0;

  private canvas: HTMLElement;
  private onWheel: (e: WheelEvent) => void;
  private onMouseDown: (e: MouseEvent) => void;
  private onMouseMove: (e: MouseEvent) => void;
  private onMouseUp: (e: MouseEvent) => void;
  private onContextMenu: (e: MouseEvent) => void;

  constructor(
    camera: THREE.PerspectiveCamera,
    canvas: HTMLElement,
    opts: OrbitCameraOptions = {},
  ) {
    this.camera = camera;
    this.canvas = canvas;
    this.minDistance = opts.minDistance ?? 100;
    this.maxDistance = opts.maxDistance ?? 8000;
    this.minPitch = opts.minPitch ?? 0.05;
    this.maxPitch = opts.maxPitch ?? Math.PI * 0.49;
    this.zoomSpeed = opts.zoomSpeed ?? 0.0015;
    this.rotateSpeed = opts.rotateSpeed ?? 0.005;
    this.panSpeed = opts.panSpeed ?? 1.0;

    this.onWheel = (e) => {
      e.preventDefault();
      const factor = Math.exp(e.deltaY * this.zoomSpeed);
      this.distance = Math.min(
        this.maxDistance,
        Math.max(this.minDistance, this.distance * factor),
      );
      this.apply();
    };

    this.onMouseDown = (e) => {
      // Middle mouse button = camera control
      if (e.button !== 1) return;
      e.preventDefault();
      this.dragMode = e.altKey ? 'orbit' : 'pan';
      this.lastMouseX = e.clientX;
      this.lastMouseY = e.clientY;
    };

    this.onMouseMove = (e) => {
      if (this.dragMode === 'none') return;
      const dx = e.clientX - this.lastMouseX;
      const dy = e.clientY - this.lastMouseY;
      this.lastMouseX = e.clientX;
      this.lastMouseY = e.clientY;

      if (this.dragMode === 'orbit') {
        this.yaw -= dx * this.rotateSpeed;
        this.pitch -= dy * this.rotateSpeed;
        this.pitch = Math.min(this.maxPitch, Math.max(this.minPitch, this.pitch));
      } else if (this.dragMode === 'pan') {
        // Pan in screen-space X/Y of the camera's ground-plane projection.
        // Pan distance scales with current view distance so feel is consistent.
        const scale = (this.distance / this.canvas.clientHeight) * this.panSpeed;
        // Right vector (world-space) at current yaw
        const rx = Math.cos(this.yaw);
        const rz = Math.sin(this.yaw);
        // Forward vector projected onto ground plane
        const fx = Math.sin(this.yaw);
        const fz = -Math.cos(this.yaw);
        this.target.x -= dx * scale * rx + dy * scale * fx;
        this.target.z -= dx * scale * rz + dy * scale * fz;
      }
      this.apply();
    };

    this.onMouseUp = (e) => {
      if (e.button !== 1) return;
      this.dragMode = 'none';
    };

    this.onContextMenu = (e) => {
      e.preventDefault();
    };

    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    canvas.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mousemove', this.onMouseMove);
    window.addEventListener('mouseup', this.onMouseUp);
    canvas.addEventListener('contextmenu', this.onContextMenu);

    this.apply();
  }

  /** Recompute camera position from target + yaw + pitch + distance. */
  apply(): void {
    const sinP = Math.sin(this.pitch);
    const cosP = Math.cos(this.pitch);
    const x = this.target.x + this.distance * sinP * Math.sin(this.yaw);
    const y = this.target.y + this.distance * cosP;
    const z = this.target.z + this.distance * sinP * -Math.cos(this.yaw);
    this.camera.position.set(x, y, z);
    this.camera.lookAt(this.target);
  }

  /** Set orbit target without changing distance/yaw/pitch. */
  setTarget(x: number, y: number, z: number): void {
    this.target.set(x, y, z);
    this.apply();
  }

  destroy(): void {
    this.canvas.removeEventListener('wheel', this.onWheel);
    this.canvas.removeEventListener('mousedown', this.onMouseDown);
    window.removeEventListener('mousemove', this.onMouseMove);
    window.removeEventListener('mouseup', this.onMouseUp);
    this.canvas.removeEventListener('contextmenu', this.onContextMenu);
  }
}

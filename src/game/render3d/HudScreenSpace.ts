// HudScreenSpace — per-frame screen-space scaler for billboarded HUD
// sprites (health bars, name labels).
//
// Converts an on-screen pixel size + pixel offset into the world-space
// scale + position a THREE.Sprite needs, so HUD elements hold a constant
// pixel size AND sit a constant pixel distance above their world anchor
// regardless of camera zoom (dolly) under perspective.
//
// The sprites stay in the 3D scene (depth-tested, so terrain still
// occludes them) — only their scale/position are recomputed each frame
// from the live camera. The core relation is
//   worldPerPixel(depth) = 2·tan(fovV/2)·depth / viewportHeightPx
// the same one OrbitCamera.panWorldScale() uses for pan feel. Multiplying
// a desired pixel size by worldPerPixel(depth) yields a world size whose
// projected pixel size is constant: the ∝depth growth exactly cancels
// perspective foreshortening.

import * as THREE from 'three';

export class HudScreenSpace {
  private readonly camPos = new THREE.Vector3();
  /** Camera view direction (normalized −Z in world). Used for view-space
   *  depth so worldPerPixel is exact off-center, not just at screen
   *  center. */
  private readonly forward = new THREE.Vector3(0, 0, -1);
  /** World-space direction that maps to screen-up — the camera's up
   *  axis. Offsetting a sprite along this by `px · worldPerPixel` moves
   *  it exactly `px` pixels up the screen, at any pitch/yaw. */
  readonly up = new THREE.Vector3(0, 1, 0);
  private tanHalfFov = 0;
  private invViewportHeight = 0;

  /** Recompute from the live camera + viewport (CSS pixels). Call once
   *  per frame before placing any sprites. */
  update(camera: THREE.PerspectiveCamera, viewportHeightPx: number): void {
    camera.getWorldPosition(this.camPos);
    this.up.setFromMatrixColumn(camera.matrixWorld, 1).normalize();
    camera.getWorldDirection(this.forward);
    // camera.fov is the VERTICAL fov in degrees; fov/2 in radians.
    this.tanHalfFov = Math.tan((camera.fov * Math.PI) / 360);
    this.invViewportHeight = viewportHeightPx > 0 ? 1 / viewportHeightPx : 0;
  }

  /** World units per screen pixel at a world point. */
  worldPerPixelAt(x: number, y: number, z: number): number {
    const depth =
      (x - this.camPos.x) * this.forward.x +
      (y - this.camPos.y) * this.forward.y +
      (z - this.camPos.z) * this.forward.z;
    // Behind / on the camera → clamp to a tiny positive depth so the
    // sprite collapses to ~nothing rather than inverting; the frustum
    // probe hides it anyway.
    const safeDepth = depth > 1 ? depth : 1;
    return 2 * this.tanHalfFov * safeDepth * this.invViewportHeight;
  }

  /** Place + size a billboarded sprite so its center sits `centerPx`
   *  screen-pixels above the world anchor (ax,ay,az) and it draws
   *  `widthPx × heightPx` on screen. worldPerPixel is taken at the
   *  shared anchor so every element of one entity scales identically. */
  placeSprite(
    sprite: THREE.Sprite,
    ax: number,
    ay: number,
    az: number,
    centerPx: number,
    widthPx: number,
    heightPx: number,
  ): void {
    const wpp = this.worldPerPixelAt(ax, ay, az);
    const off = centerPx * wpp;
    sprite.position.set(
      ax + this.up.x * off,
      ay + this.up.y * off,
      az + this.up.z * off,
    );
    sprite.scale.set(widthPx * wpp, heightPx * wpp, 1);
  }
}

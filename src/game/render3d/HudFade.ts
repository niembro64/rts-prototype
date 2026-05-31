// HudFade — per-frame camera-distance fade for billboarded HUD sprites
// (health/build bars, name labels), matching Beyond All Reason's
// behavior: bars/names are full-opacity up close, ramp to zero between
// `fadeStart` and `fadeEnd`, and are culled past `fadeEnd`. That's the
// clutter control that makes world-scaled (foreshortening) HUD elements
// workable when zoomed out — the bars shrink AND fade as the camera
// pulls back, then vanish for the strategic view.
//
// Distances are camera→anchor world distances. Callers derive fadeStart
// / fadeEnd from the orbit camera's max distance (which scales with map
// size) so the fade generalizes across maps instead of using BAR's
// hard-coded 3200/3800.

import * as THREE from 'three';

/** Below this opacity a faded HUD element is skipped (culled) entirely. */
export const FADE_CULL_ALPHA = 0.03;

export class HudFade {
  private readonly camPos = new THREE.Vector3();
  private fadeStart = Infinity;
  private fadeEnd = Infinity;
  private invSpan = 0;

  /** Refresh from the live camera + the active fade window. Call once
   *  per frame before placing any sprites. */
  update(camera: THREE.PerspectiveCamera, fadeStart: number, fadeEnd: number): void {
    camera.getWorldPosition(this.camPos);
    this.fadeStart = fadeStart;
    this.fadeEnd = Math.max(fadeStart + 1e-3, fadeEnd);
    this.invSpan = 1 / (this.fadeEnd - this.fadeStart);
  }

  /** Opacity for a HUD element anchored at the given world point:
   *  1 nearer than fadeStart, ramping linearly to 0 at fadeEnd. */
  alphaAt(x: number, y: number, z: number): number {
    const dx = x - this.camPos.x;
    const dy = y - this.camPos.y;
    const dz = z - this.camPos.z;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d <= this.fadeStart) return 1;
    if (d >= this.fadeEnd) return 0;
    return 1 - (d - this.fadeStart) * this.invSpan;
  }
}

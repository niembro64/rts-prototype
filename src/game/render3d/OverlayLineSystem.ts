// OverlayLineSystem — owns the single shared ScreenSpaceLineMaterial behind
// every ground overlay line/ring and the per-kind style table (pixel width,
// ground lift, render order from worldRenderConfig.overlayLines).
//
// Consumers ask for a GroundLineBatch3D per overlay kind; they all share the
// one material, so a single setResolution() each frame keeps every line's
// on-screen pixel width correct across canvas resizes.

import * as THREE from 'three';
import { OVERLAY_LINE_CONFIG, type OverlayLineKind } from '@/config';
import { createScreenSpaceLineMaterial } from './ScreenSpaceLineMaterial';
import { GroundLineBatch3D } from './GroundLineBatch3D';

export type OverlayLineKindStyle = {
  widthPx: number;
  groundLift: number;
  renderOrder: number;
};

export class OverlayLineSystem {
  readonly material: THREE.ShaderMaterial;
  private readonly resolution = new THREE.Vector2(1, 1);

  constructor() {
    this.material = createScreenSpaceLineMaterial({
      resolution: this.resolution,
      feather: OVERLAY_LINE_CONFIG.feather,
    });
  }

  style(kind: OverlayLineKind): OverlayLineKindStyle {
    return OVERLAY_LINE_CONFIG.kinds[kind];
  }

  /** A batch that draws at the given kind's configured render order. */
  createBatch(kind: OverlayLineKind, initialCapacity?: number): GroundLineBatch3D {
    return new GroundLineBatch3D(this.material, this.style(kind).renderOrder, initialCapacity);
  }

  /** Keep the screen-pixel width math correct (CSS pixels). */
  setResolution(width: number, height: number): void {
    if (width > 0 && height > 0) this.resolution.set(width, height);
  }

  dispose(): void {
    this.material.dispose();
  }
}

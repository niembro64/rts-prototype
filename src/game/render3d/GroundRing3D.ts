// GroundRing3D — a retained single-circle overlay built on top of the base
// GroundLineBatch3D, for the per-entity rings that persist across frames
// (selection ring, weapon/build/radar/reclaim range circles).
//
// It is the "circle" layer of the overlay-line hierarchy: callers set a center,
// radius and colour; the ring rebuilds its segment ribbon only when those
// change. Like every overlay line it draws at a constant screen-pixel width and
// follows natural depth occlusion. Pass a `sampleY` to drape the ring over
// terrain (world-space rings); omit it for a flat local ring parented to a
// moving entity group.

import * as THREE from 'three';
import type { OverlayLineKind } from '@/config';
import type { OverlayLineSystem, OverlayLineKindStyle } from './OverlayLineSystem';
import { GroundLineBatch3D } from './GroundLineBatch3D';

type SampleY = (x: number, z: number) => number;

export class GroundRing3D {
  private readonly batch: GroundLineBatch3D;
  private readonly style: OverlayLineKindStyle;
  private readonly segments: number;
  // NaN so the first set() always rebuilds (NaN === NaN is false).
  private lastCx = NaN;
  private lastCy = NaN;
  private lastCz = NaN;
  private lastRadius = NaN;
  private lastR = NaN;
  private lastG = NaN;
  private lastB = NaN;
  private lastA = NaN;

  constructor(overlay: OverlayLineSystem, kind: OverlayLineKind, segments = 96) {
    this.segments = Math.max(3, Math.floor(segments));
    this.style = overlay.style(kind);
    this.batch = overlay.createBatch(kind, this.segments + 1);
    this.batch.mesh.visible = false;
  }

  /** The Object3D to parent (world group for draped rings, entity group for
   *  flat auto-following rings). */
  get mesh(): THREE.Mesh {
    return this.batch.mesh;
  }

  /** Place/colour the ring. Rebuilds segment geometry only when something
   *  changed; otherwise just flips visibility. */
  set(
    cx: number, cy: number, cz: number,
    radius: number,
    r: number, g: number, b: number, a: number,
    sampleY?: SampleY,
  ): void {
    if (radius <= 0) {
      this.batch.mesh.visible = false;
      return;
    }
    if (
      cx === this.lastCx && cy === this.lastCy && cz === this.lastCz &&
      radius === this.lastRadius &&
      r === this.lastR && g === this.lastG && b === this.lastB && a === this.lastA
    ) {
      this.batch.mesh.visible = true;
      return;
    }
    this.lastCx = cx;
    this.lastCy = cy;
    this.lastCz = cz;
    this.lastRadius = radius;
    this.lastR = r;
    this.lastG = g;
    this.lastB = b;
    this.lastA = a;
    this.batch.begin();
    this.batch.pushRing(
      cx, cy, cz, radius, this.segments,
      r, g, b, a, this.style.widthPx, this.style.groundLift, sampleY,
    );
    this.batch.finishFrame();
  }

  hide(): void {
    this.batch.mesh.visible = false;
  }

  dispose(): void {
    this.batch.dispose();
  }
}

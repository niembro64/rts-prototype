// GroundLineBatch3D — a growable, batched buffer of screen-space-width line
// segments rendered in a single draw call with ScreenSpaceLineMaterial.
//
// This is the one primitive every ground overlay funnels through. It replaces
// both the old DynamicLineBuffer3D (1px THREE.LineSegments that vanished at far
// zoom) and the world-thick GroundCircleLine3D ribbon: callers push segments,
// open polylines, or terrain-draped rings, and they all draw as constant
// on-screen-pixel-width 3D ribbons that occlude naturally.
//
// Per-frame consumers (waypoints, sight/radar arcs, drag previews) call begin()
// → push…() → finishFrame() each frame. The shared material instance is owned
// by the renderer bootstrap so a single setResolution() keeps every batch's
// pixel width correct across resizes.

import * as THREE from 'three';
import { createSegmentQuadGeometry } from './ScreenSpaceLineMaterial';

type SampleY = (x: number, z: number) => number;

export class GroundLineBatch3D {
  readonly mesh: THREE.Mesh;
  private readonly geometry: THREE.InstancedBufferGeometry;

  private capacity: number;
  private starts: Float32Array;
  private ends: Float32Array;
  private colors: Float32Array;
  private widths: Float32Array;
  private startAttr!: THREE.InstancedBufferAttribute;
  private endAttr!: THREE.InstancedBufferAttribute;
  private colorAttr!: THREE.InstancedBufferAttribute;
  private widthAttr!: THREE.InstancedBufferAttribute;
  private count = 0;

  constructor(material: THREE.ShaderMaterial, renderOrder: number, initialCapacity = 256) {
    this.capacity = Math.max(1, Math.floor(initialCapacity));
    this.starts = new Float32Array(this.capacity * 3);
    this.ends = new Float32Array(this.capacity * 3);
    this.colors = new Float32Array(this.capacity * 4);
    this.widths = new Float32Array(this.capacity);

    const base = createSegmentQuadGeometry();
    this.geometry = new THREE.InstancedBufferGeometry();
    this.geometry.setAttribute('position', base.getAttribute('position'));
    this.geometry.setIndex(base.getIndex());
    this.rebindInstanceAttributes();
    this.geometry.instanceCount = 0;

    this.mesh = new THREE.Mesh(this.geometry, material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = renderOrder;
    this.mesh.visible = false;
  }

  /** Reset the buffer for a fresh frame of pushes. */
  begin(): void {
    this.count = 0;
  }

  /** Append one world-space segment. */
  pushSegment(
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    r: number, g: number, b: number, a: number,
    widthPx: number,
  ): void {
    this.ensureCapacity(this.count + 1);
    const i3 = this.count * 3;
    const i4 = this.count * 4;
    this.starts[i3] = ax; this.starts[i3 + 1] = ay; this.starts[i3 + 2] = az;
    this.ends[i3] = bx; this.ends[i3 + 1] = by; this.ends[i3 + 2] = bz;
    this.colors[i4] = r; this.colors[i4 + 1] = g; this.colors[i4 + 2] = b; this.colors[i4 + 3] = a;
    this.widths[this.count] = widthPx;
    this.count++;
  }

  /** Append an open or closed polyline given a flat [x,y,z, x,y,z, …] array. */
  pushPolyline(
    points: ArrayLike<number>,
    pointCount: number,
    r: number, g: number, b: number, a: number,
    widthPx: number,
    closed: boolean,
  ): void {
    if (pointCount < 2) return;
    for (let i = 0; i < pointCount - 1; i++) {
      const o = i * 3;
      const n = o + 3;
      this.pushSegment(
        points[o], points[o + 1], points[o + 2],
        points[n], points[n + 1], points[n + 2],
        r, g, b, a, widthPx,
      );
    }
    if (closed) {
      const last = (pointCount - 1) * 3;
      this.pushSegment(
        points[last], points[last + 1], points[last + 2],
        points[0], points[1], points[2],
        r, g, b, a, widthPx,
      );
    }
  }

  /** Append a closed circle of `segments` segments centred at (cx,cz). Each
   *  vertex Y is sampled through `sampleY` (terrain-draped) plus `lift`, or a
   *  flat `cy + lift` when no sampler is given. */
  pushRing(
    cx: number, cy: number, cz: number,
    radius: number, segments: number,
    r: number, g: number, b: number, a: number,
    widthPx: number,
    lift: number,
    sampleY?: SampleY,
  ): void {
    const n = Math.max(3, Math.floor(segments));
    let prevX = 0; let prevY = 0; let prevZ = 0;
    // i runs 0..n inclusive; the final point (angle wraps to 0) closes the ring.
    for (let i = 0; i <= n; i++) {
      const angle = (i % n) / n * Math.PI * 2;
      const x = cx + Math.cos(angle) * radius;
      const z = cz + Math.sin(angle) * radius;
      const y = (sampleY ? sampleY(x, z) : cy) + lift;
      if (i > 0) {
        this.pushSegment(prevX, prevY, prevZ, x, y, z, r, g, b, a, widthPx);
      }
      prevX = x; prevY = y; prevZ = z;
    }
  }

  /** Upload the frame's segments and flip visibility. */
  finishFrame(): number {
    this.geometry.instanceCount = this.count;
    this.mesh.visible = this.count > 0;
    if (this.count === 0) return 0;
    this.markUpdated(this.startAttr, this.count * 3);
    this.markUpdated(this.endAttr, this.count * 3);
    this.markUpdated(this.colorAttr, this.count * 4);
    this.markUpdated(this.widthAttr, this.count);
    return this.count;
  }

  dispose(): void {
    this.geometry.dispose();
  }

  private markUpdated(attr: THREE.InstancedBufferAttribute, usedFloats: number): void {
    attr.clearUpdateRanges();
    attr.addUpdateRange(0, usedFloats);
    attr.needsUpdate = true;
  }

  private ensureCapacity(needed: number): void {
    if (needed <= this.capacity) return;
    let next = this.capacity;
    while (next < needed) next *= 2;
    const starts = new Float32Array(next * 3);
    const ends = new Float32Array(next * 3);
    const colors = new Float32Array(next * 4);
    const widths = new Float32Array(next);
    starts.set(this.starts.subarray(0, this.count * 3));
    ends.set(this.ends.subarray(0, this.count * 3));
    colors.set(this.colors.subarray(0, this.count * 4));
    widths.set(this.widths.subarray(0, this.count));
    this.capacity = next;
    this.starts = starts;
    this.ends = ends;
    this.colors = colors;
    this.widths = widths;
    this.rebindInstanceAttributes();
  }

  private rebindInstanceAttributes(): void {
    this.startAttr = new THREE.InstancedBufferAttribute(this.starts, 3).setUsage(THREE.DynamicDrawUsage);
    this.endAttr = new THREE.InstancedBufferAttribute(this.ends, 3).setUsage(THREE.DynamicDrawUsage);
    this.colorAttr = new THREE.InstancedBufferAttribute(this.colors, 4).setUsage(THREE.DynamicDrawUsage);
    this.widthAttr = new THREE.InstancedBufferAttribute(this.widths, 1).setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('instanceStart', this.startAttr);
    this.geometry.setAttribute('instanceEnd', this.endAttr);
    this.geometry.setAttribute('instanceColor', this.colorAttr);
    this.geometry.setAttribute('instanceWidth', this.widthAttr);
  }
}

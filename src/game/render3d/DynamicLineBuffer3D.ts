import * as THREE from 'three';

const FLOATS_PER_SEGMENT = 6;
const VERTICES_PER_SEGMENT = 2;

export type LinePoint3D = {
  x: number;
  y: number;
  z: number;
};

export class DynamicLineBuffer3D {
  readonly geometry = new THREE.BufferGeometry();

  private capacity: number;
  private positions: Float32Array;
  private colors: Float32Array;
  private segmentCount = 0;

  constructor(initialCapacity: number) {
    this.capacity = Math.max(1, Math.floor(initialCapacity));
    this.positions = new Float32Array(this.capacity * FLOATS_PER_SEGMENT);
    this.colors = new Float32Array(this.capacity * FLOATS_PER_SEGMENT);
    this.rebindAttributes();
    this.geometry.setDrawRange(0, 0);
  }

  get count(): number {
    return this.segmentCount;
  }

  resetDrawRange(): void {
    this.segmentCount = 0;
    this.geometry.setDrawRange(0, 0);
  }

  ensureCapacity(neededSegments: number): void {
    if (neededSegments <= this.capacity) return;
    let nextCapacity = this.capacity;
    while (nextCapacity < neededSegments) nextCapacity *= 2;

    const nextPositions = new Float32Array(nextCapacity * FLOATS_PER_SEGMENT);
    const nextColors = new Float32Array(nextCapacity * FLOATS_PER_SEGMENT);
    const usedFloats = this.segmentCount * FLOATS_PER_SEGMENT;
    nextPositions.set(this.positions.subarray(0, usedFloats));
    nextColors.set(this.colors.subarray(0, usedFloats));

    this.capacity = nextCapacity;
    this.positions = nextPositions;
    this.colors = nextColors;
    this.rebindAttributes();
  }

  pushSegment(
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    r: number,
    g: number,
    b: number,
  ): void {
    this.ensureCapacity(this.segmentCount + 1);
    const o = this.segmentCount * FLOATS_PER_SEGMENT;
    this.positions[o + 0] = ax;
    this.positions[o + 1] = ay;
    this.positions[o + 2] = az;
    this.positions[o + 3] = bx;
    this.positions[o + 4] = by;
    this.positions[o + 5] = bz;
    this.colors[o + 0] = r;
    this.colors[o + 1] = g;
    this.colors[o + 2] = b;
    this.colors[o + 3] = r;
    this.colors[o + 4] = g;
    this.colors[o + 5] = b;
    this.segmentCount++;
  }

  pushPointSegment(a: LinePoint3D, b: LinePoint3D, r: number, g: number, colorB: number): void {
    this.pushSegment(a.x, a.y, a.z, b.x, b.y, b.z, r, g, colorB);
  }

  finishFrame(): number {
    this.geometry.setDrawRange(0, this.segmentCount * VERTICES_PER_SEGMENT);
    const position = this.geometry.getAttribute('position') as THREE.BufferAttribute;
    const color = this.geometry.getAttribute('color') as THREE.BufferAttribute;
    position.needsUpdate = true;
    color.needsUpdate = true;
    return this.segmentCount;
  }

  dispose(): void {
    this.geometry.dispose();
  }

  private rebindAttributes(): void {
    this.geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage),
    );
    this.geometry.setAttribute(
      'color',
      new THREE.BufferAttribute(this.colors, 3).setUsage(THREE.DynamicDrawUsage),
    );
  }
}

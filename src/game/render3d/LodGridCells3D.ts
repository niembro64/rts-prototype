import * as THREE from 'three';
import {
  lodCellBoundaryCeil,
  lodCellIndex,
  lodCellMin,
  normalizeLodCellSize,
} from '../lodGridMath';

const STYLE = {
  initialLineCap: 4096,
};

export class LodGridCells3D {
  private parent: THREE.Group;
  private mapWidth: number;
  private mapHeight: number;
  private waterLevelY: number;
  private maxY: number;
  private lineCap = STYLE.initialLineCap;
  private linePositions = new Float32Array(this.lineCap * 2 * 3);
  private lineColors = new Float32Array(this.lineCap * 2 * 3);
  private lineGeom = new THREE.BufferGeometry();
  private lineMesh: THREE.LineSegments;
  private lastKey = '';

  constructor(
    parent: THREE.Group,
    mapWidth: number,
    mapHeight: number,
    waterLevelY: number,
    maxY: number,
  ) {
    this.parent = parent;
    this.mapWidth = mapWidth;
    this.mapHeight = mapHeight;
    this.waterLevelY = waterLevelY;
    this.maxY = maxY;

    this.lineGeom.setAttribute(
      'position',
      new THREE.BufferAttribute(this.linePositions, 3).setUsage(THREE.DynamicDrawUsage),
    );
    this.lineGeom.setAttribute(
      'color',
      new THREE.BufferAttribute(this.lineColors, 3).setUsage(THREE.DynamicDrawUsage),
    );

    const material = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.34,
      depthTest: false,
      depthWrite: false,
    });
    this.lineMesh = new THREE.LineSegments(this.lineGeom, material);
    this.lineMesh.frustumCulled = false;
    this.lineMesh.renderOrder = 6;
    this.lineMesh.visible = false;
    this.parent.add(this.lineMesh);
  }

  update(cellSize: number, visible: boolean): void {
    if (!visible) {
      this.hide();
      return;
    }

    const size = normalizeLodCellSize(cellSize);
    const x0 = lodCellMin(lodCellIndex(0, size), size);
    const x1 = lodCellBoundaryCeil(this.mapWidth, size);
    // Draw the cell plane that contains water level, then everything
    // above it. That preserves exact LOD-cell alignment while avoiding
    // deep underground/lake-bed stacks; the water plane's own cell is
    // the one buffer layer below playable surface.
    const y0 = lodCellMin(lodCellIndex(this.waterLevelY, size), size);
    const y1 = lodCellBoundaryCeil(this.maxY, size);
    const z0 = lodCellMin(lodCellIndex(0, size), size);
    const z1 = lodCellBoundaryCeil(this.mapHeight, size);
    const key = `${x0}|${x1}|${y0}|${y1}|${z0}|${z1}|${size}`;
    if (key === this.lastKey) {
      this.lineMesh.visible = true;
      return;
    }
    this.lastKey = key;

    const state = { lineSeg: 0 };
    const xSteps = Math.floor((x1 - x0) / size) + 1;
    const ySteps = Math.floor((y1 - y0) / size) + 1;
    const zSteps = Math.floor((z1 - z0) / size) + 1;
    this.growLineCap((ySteps * zSteps) + (xSteps * zSteps) + (xSteps * ySteps));
    const xColor = { r: 0.4, g: 0.94, b: 1.0 };
    const yColor = { r: 0.52, g: 1.0, b: 0.78 };
    const zColor = { r: 0.72, g: 0.62, b: 1.0 };

    for (let y = y0; y <= y1; y += size) {
      for (let z = z0; z <= z1; z += size) {
        this.pushSegment(state, x0, y, z, x1, y, z, xColor);
      }
    }
    for (let x = x0; x <= x1; x += size) {
      for (let z = z0; z <= z1; z += size) {
        this.pushSegment(state, x, y0, z, x, y1, z, yColor);
      }
    }
    for (let x = x0; x <= x1; x += size) {
      for (let y = y0; y <= y1; y += size) {
        this.pushSegment(state, x, y, z0, x, y, z1, zColor);
      }
    }

    this.lineGeom.setDrawRange(0, state.lineSeg * 2);
    const position = this.lineGeom.getAttribute('position') as THREE.BufferAttribute;
    const color = this.lineGeom.getAttribute('color') as THREE.BufferAttribute;
    position.needsUpdate = true;
    color.needsUpdate = true;
    this.lineMesh.visible = state.lineSeg > 0;
  }

  destroy(): void {
    this.parent.remove(this.lineMesh);
    this.lineGeom.dispose();
    const material = this.lineMesh.material;
    if (Array.isArray(material)) {
      for (const mat of material) mat.dispose();
    } else {
      material.dispose();
    }
  }

  private hide(): void {
    if (!this.lineMesh.visible && this.lastKey === '') return;
    this.lineGeom.setDrawRange(0, 0);
    this.lineMesh.visible = false;
    this.lastKey = '';
  }

  private pushSegment(
    state: { lineSeg: number },
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    color: { r: number; g: number; b: number },
  ): void {
    this.growLineCap(state.lineSeg + 1);
    const base = state.lineSeg * 6;
    this.linePositions[base] = ax;
    this.linePositions[base + 1] = ay;
    this.linePositions[base + 2] = az;
    this.linePositions[base + 3] = bx;
    this.linePositions[base + 4] = by;
    this.linePositions[base + 5] = bz;
    this.lineColors[base] = color.r;
    this.lineColors[base + 1] = color.g;
    this.lineColors[base + 2] = color.b;
    this.lineColors[base + 3] = color.r;
    this.lineColors[base + 4] = color.g;
    this.lineColors[base + 5] = color.b;
    state.lineSeg++;
  }

  private growLineCap(needed: number): void {
    let cap = this.lineCap;
    while (cap < needed) cap *= 2;
    if (cap === this.lineCap) return;
    this.lineCap = cap;
    this.linePositions = new Float32Array(cap * 2 * 3);
    this.lineColors = new Float32Array(cap * 2 * 3);
    this.lineGeom.setAttribute(
      'position',
      new THREE.BufferAttribute(this.linePositions, 3).setUsage(THREE.DynamicDrawUsage),
    );
    this.lineGeom.setAttribute(
      'color',
      new THREE.BufferAttribute(this.lineColors, 3).setUsage(THREE.DynamicDrawUsage),
    );
  }
}

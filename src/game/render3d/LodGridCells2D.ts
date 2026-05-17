import * as THREE from 'three';
import {
  landCellBoundaryCeil,
  landCellIndexForSize,
  landCellMinForSize,
  normalizeLandCellSize,
  assertCanonicalLandCellSize,
} from '../landGrid';
import { DynamicLineBuffer3D } from './DynamicLineBuffer3D';

const STYLE = {
  initialLineCap: 4096,
};

const FLOATING_CELL_Y = 14;

export class LodGridCells2D {
  private parent: THREE.Group;
  private mapWidth: number;
  private mapHeight: number;
  private lineBuffer = new DynamicLineBuffer3D(STYLE.initialLineCap);
  private lineMesh: THREE.LineSegments;
  private lastKey = '';

  constructor(
    parent: THREE.Group,
    mapWidth: number,
    mapHeight: number,
    _clientViewState: unknown,
  ) {
    this.parent = parent;
    this.mapWidth = mapWidth;
    this.mapHeight = mapHeight;

    const material = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.34,
      depthTest: false,
      depthWrite: false,
    });
    this.lineMesh = new THREE.LineSegments(this.lineBuffer.geometry, material);
    this.lineMesh.frustumCulled = false;
    this.lineMesh.renderOrder = 7;
    this.lineMesh.visible = false;
    this.parent.add(this.lineMesh);
  }

  update(
    cellSize: number,
    lineVisible: boolean,
  ): void {
    this.updateLines(cellSize, lineVisible);
  }

  private updateLines(cellSize: number, visible: boolean): void {
    if (!visible) {
      this.hideLines();
      return;
    }

    assertCanonicalLandCellSize('LOD grid border cell size', cellSize);
    const size = normalizeLandCellSize(cellSize);
    const x0 = landCellMinForSize(landCellIndexForSize(0, size), size);
    const x1 = landCellBoundaryCeil(this.mapWidth, size);
    const z0 = landCellMinForSize(landCellIndexForSize(0, size), size);
    const z1 = landCellBoundaryCeil(this.mapHeight, size);
    const key = `${x0}|${x1}|${z0}|${z1}|${size}`;
    if (key === this.lastKey) {
      this.lineMesh.visible = true;
      return;
    }
    this.lastKey = key;

    const xSteps = Math.floor((x1 - x0) / size) + 1;
    const zSteps = Math.floor((z1 - z0) / size) + 1;
    this.lineBuffer.resetDrawRange();
    this.lineBuffer.ensureCapacity(xSteps + zSteps);
    const xColor = { r: 0.4, g: 0.94, b: 1.0 };
    const zColor = { r: 0.72, g: 0.62, b: 1.0 };
    const y = FLOATING_CELL_Y + 0.6;

    for (let z = z0; z <= z1; z += size) {
      this.lineBuffer.pushSegment(x0, y, z, x1, y, z, xColor.r, xColor.g, xColor.b);
    }
    for (let x = x0; x <= x1; x += size) {
      this.lineBuffer.pushSegment(x, y, z0, x, y, z1, zColor.r, zColor.g, zColor.b);
    }

    const lineSeg = this.lineBuffer.finishFrame();
    this.lineMesh.visible = lineSeg > 0;
  }

  destroy(): void {
    this.parent.remove(this.lineMesh);
    this.lineBuffer.dispose();
    const material = this.lineMesh.material;
    if (Array.isArray(material)) {
      for (const mat of material) mat.dispose();
    } else {
      material.dispose();
    }
  }

  private hideLines(): void {
    if (!this.lineMesh.visible && this.lastKey === '') return;
    this.lineBuffer.resetDrawRange();
    this.lineMesh.visible = false;
    this.lastKey = '';
  }
}

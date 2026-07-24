import * as THREE from 'three';
import type { CameraZoomDistanceSamplingConfig } from '../../types/camera';
import type {
  CameraZoomTerrainSampleSnapshot,
  OrbitCamera,
} from './OrbitCamera';

/** Draws the exact world-space terrain points used by OrbitCamera's latest
 *  relative zoom calculation. The OrbitCamera-owned position buffer is bound
 *  directly as the geometry attribute, so the diagnostic cannot accidentally
 *  visualize a separately recomputed sample pattern. */
export class ZoomTerrainPointsOverlay3D {
  private readonly geometry: THREE.BufferGeometry;
  private readonly material: THREE.PointsMaterial;
  private readonly points: THREE.Points;
  private readonly colorValues: Float32Array;
  private readonly colorAttribute: THREE.BufferAttribute;
  private readonly centerColor: THREE.Color;
  private readonly innerColor: THREE.Color;
  private readonly outerColor: THREE.Color;
  private readonly selectedColor: THREE.Color;
  private readonly samples: Readonly<CameraZoomTerrainSampleSnapshot>;
  private lastVersion = -1;

  constructor(
    private readonly parent: THREE.Object3D,
    orbit: OrbitCamera,
    private readonly config: CameraZoomDistanceSamplingConfig,
  ) {
    this.samples = orbit.getZoomTerrainSampleSnapshot();
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(this.samples.positions, 3),
    );

    this.colorValues = new Float32Array(this.samples.distances.length * 3);
    this.colorAttribute = new THREE.BufferAttribute(this.colorValues, 3);
    this.centerColor = new THREE.Color(config.debugCenterColor);
    this.innerColor = new THREE.Color(config.debugInnerColor);
    this.outerColor = new THREE.Color(config.debugOuterColor);
    this.selectedColor = new THREE.Color(config.debugSelectedColor);
    this.refreshColors();
    this.geometry.setAttribute('color', this.colorAttribute);
    this.geometry.setDrawRange(0, 0);

    this.material = new THREE.PointsMaterial({
      size: Math.max(1, config.debugPointSizePixels),
      sizeAttenuation: false,
      vertexColors: true,
      transparent: true,
      opacity: 0.95,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    this.points = new THREE.Points(this.geometry, this.material);
    this.points.name = 'ZoomTerrainPointsOverlay3D';
    this.points.frustumCulled = false;
    this.points.renderOrder = 10_000;
    this.points.visible = false;
    parent.add(this.points);
  }

  update(nowMilliseconds: number, enabled: boolean): void {
    const age = nowMilliseconds - this.samples.sampledAtMilliseconds;
    this.points.visible = enabled
      && this.samples.count > 0
      && age >= 0
      && age <= Math.max(0, this.config.debugVisibleMilliseconds);
    if (!this.points.visible || this.lastVersion === this.samples.version) return;

    this.lastVersion = this.samples.version;
    const position = this.geometry.getAttribute('position') as THREE.BufferAttribute;
    position.needsUpdate = true;
    this.refreshColors();
    this.geometry.setDrawRange(0, this.samples.count);
  }

  private refreshColors(): void {
    for (let i = 0; i < this.samples.distances.length; i++) {
      // A flagged sample contributed to the aggregate depth: the single
      // winner in `min`, the N nearest in `average-of-shortest-N`. Plain
      // `average` flags nothing — every point contributes equally.
      const selected = i < this.samples.count
        && this.samples.selectedFlags[i] === 1;
      const color = selected
        ? this.selectedColor
        : i === 0
          ? this.centerColor
          : i <= this.samples.ringPointCount
            ? this.innerColor
            : this.outerColor;
      const offset = i * 3;
      this.colorValues[offset] = color.r;
      this.colorValues[offset + 1] = color.g;
      this.colorValues[offset + 2] = color.b;
    }
    this.colorAttribute.needsUpdate = true;
  }

  destroy(): void {
    this.parent.remove(this.points);
    this.geometry.dispose();
    this.material.dispose();
  }
}

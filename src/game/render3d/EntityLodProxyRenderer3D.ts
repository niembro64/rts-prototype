import * as THREE from 'three';
import type { Entity } from '../sim/types';
import { entityInstanceColorHex } from './EntityInstanceColor3D';

const ENTITY_LOD_PROXY_CAP = 32768;
const UNIT_PROXY_MIN_PIXELS = 6;
const UNIT_PROXY_MAX_PIXELS = 42;
const BUILDING_PROXY_MIN_PIXELS = 10;
const BUILDING_PROXY_MAX_PIXELS = 72;

const POINT_VERTEX_SHADER = `
attribute vec3 color;
attribute float aRadius;
uniform float uViewportHeight;
uniform float uMinPointSize;
uniform float uMaxPointSize;
varying vec3 vColor;

void main() {
  vColor = color;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  float viewDistance = max(1.0, -mvPosition.z);
  float projectedDiameter = aRadius * projectionMatrix[1][1] * uViewportHeight / viewDistance;
  gl_PointSize = clamp(projectedDiameter, uMinPointSize, uMaxPointSize);
}
`;

const POINT_FRAGMENT_SHADER = `
varying vec3 vColor;

void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  if (dot(p, p) > 1.0) discard;
  gl_FragColor = vec4(vColor, 1.0);
}
`;

type ProxyPointBatch = {
  points: THREE.Points;
  geometry: THREE.BufferGeometry;
  material: THREE.ShaderMaterial;
  positions: Float32Array;
  colors: Float32Array;
  radii: Float32Array;
  positionAttr: THREE.BufferAttribute;
  colorAttr: THREE.BufferAttribute;
  radiusAttr: THREE.BufferAttribute;
  count: number;
};

function createProxyPointMaterial(minPointSize: number, maxPointSize: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uViewportHeight: { value: 1 },
      uMinPointSize: { value: minPointSize },
      uMaxPointSize: { value: maxPointSize },
    },
    vertexShader: POINT_VERTEX_SHADER,
    fragmentShader: POINT_FRAGMENT_SHADER,
    depthTest: false,
    depthWrite: false,
  });
}

function createProxyPointBatch(minPointSize: number, maxPointSize: number): ProxyPointBatch {
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array(ENTITY_LOD_PROXY_CAP * 3);
  const colors = new Float32Array(ENTITY_LOD_PROXY_CAP * 3);
  const radii = new Float32Array(ENTITY_LOD_PROXY_CAP);
  const positionAttr = new THREE.BufferAttribute(positions, 3);
  const colorAttr = new THREE.BufferAttribute(colors, 3);
  const radiusAttr = new THREE.BufferAttribute(radii, 1);
  positionAttr.setUsage(THREE.DynamicDrawUsage);
  colorAttr.setUsage(THREE.DynamicDrawUsage);
  radiusAttr.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('position', positionAttr);
  geometry.setAttribute('color', colorAttr);
  geometry.setAttribute('aRadius', radiusAttr);
  geometry.setDrawRange(0, 0);

  const material = createProxyPointMaterial(minPointSize, maxPointSize);
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  points.renderOrder = 3;
  return {
    points,
    geometry,
    material,
    positions,
    colors,
    radii,
    positionAttr,
    colorAttr,
    radiusAttr,
    count: 0,
  };
}

function writeColorHex(out: Float32Array, slot: number, colorHex: number): void {
  const o = slot * 3;
  out[o] = ((colorHex >> 16) & 0xff) / 255;
  out[o + 1] = ((colorHex >> 8) & 0xff) / 255;
  out[o + 2] = (colorHex & 0xff) / 255;
}

function writePoint(
  batch: ProxyPointBatch,
  slot: number,
  x: number,
  y: number,
  z: number,
  radius: number,
  colorHex: number,
): void {
  const posOffset = slot * 3;
  batch.positions[posOffset] = x;
  batch.positions[posOffset + 1] = y;
  batch.positions[posOffset + 2] = z;
  batch.radii[slot] = radius;
  writeColorHex(batch.colors, slot, colorHex);
}

function markBatchRange(batch: ProxyPointBatch, viewportHeight: number): void {
  const count = batch.count;
  batch.geometry.setDrawRange(0, count);
  batch.material.uniforms.uViewportHeight.value = Math.max(1, viewportHeight);
  if (count <= 0) return;
  batch.positionAttr.clearUpdateRanges();
  batch.positionAttr.addUpdateRange(0, count * 3);
  batch.positionAttr.needsUpdate = true;
  batch.colorAttr.clearUpdateRanges();
  batch.colorAttr.addUpdateRange(0, count * 3);
  batch.colorAttr.needsUpdate = true;
  batch.radiusAttr.clearUpdateRanges();
  batch.radiusAttr.addUpdateRange(0, count);
  batch.radiusAttr.needsUpdate = true;
}

export class EntityLodProxyRenderer3D {
  private readonly unitBatch = createProxyPointBatch(
    UNIT_PROXY_MIN_PIXELS,
    UNIT_PROXY_MAX_PIXELS,
  );
  private readonly buildingBatch = createProxyPointBatch(
    BUILDING_PROXY_MIN_PIXELS,
    BUILDING_PROXY_MAX_PIXELS,
  );

  constructor(private readonly world: THREE.Group) {
    this.world.add(this.unitBatch.points);
    this.world.add(this.buildingBatch.points);
  }

  beginFrame(): void {
    this.unitBatch.count = 0;
    this.buildingBatch.count = 0;
  }

  pushUnit(entity: Entity): void {
    const unit = entity.unit;
    const slot = this.unitBatch.count;
    if (unit === null || slot >= ENTITY_LOD_PROXY_CAP) return;
    const radius = Math.max(1, unit.radius.hitbox || unit.radius.visual || 15);
    writePoint(
      this.unitBatch,
      slot,
      entity.transform.x,
      entity.transform.z,
      entity.transform.y,
      radius,
      entityInstanceColorHex(entity),
    );
    this.unitBatch.count = slot + 1;
  }

  pushBuilding(entity: Entity): void {
    const building = entity.building;
    const slot = this.buildingBatch.count;
    if (building === null || slot >= ENTITY_LOD_PROXY_CAP) return;
    const radius = Math.max(1, Math.hypot(building.width, building.height) * 0.5);
    writePoint(
      this.buildingBatch,
      slot,
      entity.transform.x,
      entity.transform.z,
      entity.transform.y,
      radius,
      entityInstanceColorHex(entity),
    );
    this.buildingBatch.count = slot + 1;
  }

  flush(viewportHeight: number): void {
    markBatchRange(this.unitBatch, viewportHeight);
    markBatchRange(this.buildingBatch, viewportHeight);
  }

  destroy(): void {
    this.world.remove(this.unitBatch.points);
    this.world.remove(this.buildingBatch.points);
    this.unitBatch.geometry.dispose();
    this.buildingBatch.geometry.dispose();
    this.unitBatch.material.dispose();
    this.buildingBatch.material.dispose();
  }
}

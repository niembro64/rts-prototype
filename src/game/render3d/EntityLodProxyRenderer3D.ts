import * as THREE from 'three';
import {
  ENTITY_LOD_PROXY_BUILDING_MAX_PIXELS,
  ENTITY_LOD_PROXY_BUILDING_MIN_PIXELS,
  ENTITY_LOD_PROXY_CAP,
  ENTITY_LOD_PROXY_DEPTH_TEST,
  ENTITY_LOD_PROXY_DEPTH_WRITE,
  ENTITY_LOD_PROXY_OPACITY,
  ENTITY_LOD_PROXY_RENDER_ORDER,
  ENTITY_LOD_PROXY_UNIT_MAX_PIXELS,
  ENTITY_LOD_PROXY_UNIT_MIN_PIXELS,
  ENTITY_LOD_PROXY_USE_TEAM_COLOR,
} from '@/config';
import { getBrowserRenderRuntimeProfile } from '@/browserRuntime';
import type { Entity } from '../sim/types';
import { entityInstanceColorHex } from './EntityInstanceColor3D';
import { entityLodRadius3D } from './EntityLod3D';
import { EntityLodProxyWebGpuRenderer3D } from './EntityLodProxyWebGpuRenderer3D';

const ENTITY_LOD_PROXY_NEUTRAL_COLOR = 0xffffff;

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
uniform float uOpacity;
varying vec3 vColor;

void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  if (dot(p, p) > 1.0) discard;
  gl_FragColor = vec4(vColor, uOpacity);
}
`;

type DirtySpan = {
  min: number;
  max: number;
};

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
  positionDirty: DirtySpan;
  colorDirty: DirtySpan;
  radiusDirty: DirtySpan;
  count: number;
  drawRangeCount: number;
};

type EntityLodProxyRendererBackend3D = {
  beginFrame(): void;
  pushUnit(entity: Entity): void;
  pushBuilding(entity: Entity): void;
  flush(viewportHeight: number): void;
  destroy(): void;
};

export type EntityLodProxyRenderer3DOptions = {
  readonly world: THREE.Group;
  readonly camera?: THREE.PerspectiveCamera;
  readonly canvas?: HTMLCanvasElement;
};

function createDirtySpan(): DirtySpan {
  return { min: Number.POSITIVE_INFINITY, max: -1 };
}

function markDirty(span: DirtySpan, slot: number): void {
  if (slot < span.min) span.min = slot;
  if (slot > span.max) span.max = slot;
}

function hasDirty(span: DirtySpan): boolean {
  return span.max >= span.min;
}

function uploadDirty(
  attr: THREE.BufferAttribute,
  span: DirtySpan,
  itemSize: number,
): void {
  if (!hasDirty(span)) return;
  attr.clearUpdateRanges();
  attr.addUpdateRange(span.min * itemSize, (span.max - span.min + 1) * itemSize);
  attr.needsUpdate = true;
  span.min = Number.POSITIVE_INFINITY;
  span.max = -1;
}

function createProxyPointMaterial(minPointSize: number, maxPointSize: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uViewportHeight: { value: 1 },
      uMinPointSize: { value: minPointSize },
      uMaxPointSize: { value: maxPointSize },
      uOpacity: { value: Math.max(0, Math.min(1, ENTITY_LOD_PROXY_OPACITY)) },
    },
    vertexShader: POINT_VERTEX_SHADER,
    fragmentShader: POINT_FRAGMENT_SHADER,
    transparent: ENTITY_LOD_PROXY_OPACITY < 1,
    depthTest: ENTITY_LOD_PROXY_DEPTH_TEST,
    depthWrite: ENTITY_LOD_PROXY_DEPTH_WRITE,
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
  points.renderOrder = ENTITY_LOD_PROXY_RENDER_ORDER;
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
    positionDirty: createDirtySpan(),
    colorDirty: createDirtySpan(),
    radiusDirty: createDirtySpan(),
    count: 0,
    drawRangeCount: 0,
  };
}

function writeColorHex(batch: ProxyPointBatch, slot: number, colorHex: number): void {
  const out = batch.colors;
  const o = slot * 3;
  const r = ((colorHex >> 16) & 0xff) / 255;
  const g = ((colorHex >> 8) & 0xff) / 255;
  const b = (colorHex & 0xff) / 255;
  if (out[o] === r && out[o + 1] === g && out[o + 2] === b) return;
  out[o] = r;
  out[o + 1] = g;
  out[o + 2] = b;
  markDirty(batch.colorDirty, slot);
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
  const px = Math.fround(x);
  const py = Math.fround(y);
  const pz = Math.fround(z);
  if (
    batch.positions[posOffset] !== px ||
    batch.positions[posOffset + 1] !== py ||
    batch.positions[posOffset + 2] !== pz
  ) {
    batch.positions[posOffset] = px;
    batch.positions[posOffset + 1] = py;
    batch.positions[posOffset + 2] = pz;
    markDirty(batch.positionDirty, slot);
  }

  const nextRadius = Math.fround(radius);
  if (batch.radii[slot] !== nextRadius) {
    batch.radii[slot] = nextRadius;
    markDirty(batch.radiusDirty, slot);
  }
  writeColorHex(batch, slot, colorHex);
}

function markBatchRange(batch: ProxyPointBatch, viewportHeight: number): void {
  const count = batch.count;
  if (batch.drawRangeCount !== count) {
    batch.geometry.setDrawRange(0, count);
    batch.drawRangeCount = count;
  }
  batch.material.uniforms.uViewportHeight.value = Math.max(1, viewportHeight);
  if (count <= 0) return;
  uploadDirty(batch.positionAttr, batch.positionDirty, 3);
  uploadDirty(batch.colorAttr, batch.colorDirty, 3);
  uploadDirty(batch.radiusAttr, batch.radiusDirty, 1);
}

class EntityLodProxyWebGlRenderer3D implements EntityLodProxyRendererBackend3D {
  private readonly unitBatch = createProxyPointBatch(
    ENTITY_LOD_PROXY_UNIT_MIN_PIXELS,
    ENTITY_LOD_PROXY_UNIT_MAX_PIXELS,
  );
  private readonly buildingBatch = createProxyPointBatch(
    ENTITY_LOD_PROXY_BUILDING_MIN_PIXELS,
    ENTITY_LOD_PROXY_BUILDING_MAX_PIXELS,
  );

  constructor(private readonly world: THREE.Group) {
    this.world.add(this.unitBatch.points);
    this.world.add(this.buildingBatch.points);
  }

  setVisible(visible: boolean): void {
    this.unitBatch.points.visible = visible;
    this.buildingBatch.points.visible = visible;
  }

  beginFrame(): void {
    this.unitBatch.count = 0;
    this.buildingBatch.count = 0;
  }

  pushUnit(entity: Entity): void {
    const unit = entity.unit;
    const slot = this.unitBatch.count;
    if (unit === null || slot >= ENTITY_LOD_PROXY_CAP) return;
    writePoint(
      this.unitBatch,
      slot,
      entity.transform.x,
      entity.transform.z,
      entity.transform.y,
      entityLodRadius3D(entity),
      ENTITY_LOD_PROXY_USE_TEAM_COLOR
        ? entityInstanceColorHex(entity)
        : ENTITY_LOD_PROXY_NEUTRAL_COLOR,
    );
    this.unitBatch.count = slot + 1;
  }

  pushBuilding(entity: Entity): void {
    const building = entity.building;
    const slot = this.buildingBatch.count;
    if (building === null || slot >= ENTITY_LOD_PROXY_CAP) return;
    writePoint(
      this.buildingBatch,
      slot,
      entity.transform.x,
      entity.transform.z,
      entity.transform.y,
      entityLodRadius3D(entity),
      ENTITY_LOD_PROXY_USE_TEAM_COLOR
        ? entityInstanceColorHex(entity)
        : ENTITY_LOD_PROXY_NEUTRAL_COLOR,
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

function normalizeOptions(
  options: THREE.Group | EntityLodProxyRenderer3DOptions,
): EntityLodProxyRenderer3DOptions {
  if ('world' in options) return options;
  return { world: options };
}

export class EntityLodProxyRenderer3D implements EntityLodProxyRendererBackend3D {
  private readonly webGlBackend: EntityLodProxyWebGlRenderer3D;
  private activeBackend: EntityLodProxyRendererBackend3D;
  private webGpuBackend: EntityLodProxyWebGpuRenderer3D | null = null;
  private destroyed = false;

  constructor(options: THREE.Group | EntityLodProxyRenderer3DOptions) {
    const normalizedOptions = normalizeOptions(options);
    this.webGlBackend = new EntityLodProxyWebGlRenderer3D(normalizedOptions.world);
    this.activeBackend = this.webGlBackend;
    const runtimeProfile = getBrowserRenderRuntimeProfile();
    if (
      runtimeProfile.tauri &&
      normalizedOptions.camera !== undefined &&
      normalizedOptions.canvas !== undefined
    ) {
      void this.installWebGpuBackend(normalizedOptions.camera, normalizedOptions.canvas);
    }
  }

  beginFrame(): void {
    this.activeBackend.beginFrame();
  }

  pushUnit(entity: Entity): void {
    this.activeBackend.pushUnit(entity);
  }

  pushBuilding(entity: Entity): void {
    this.activeBackend.pushBuilding(entity);
  }

  flush(viewportHeight: number): void {
    this.activeBackend.flush(viewportHeight);
  }

  destroy(): void {
    this.destroyed = true;
    this.webGpuBackend?.destroy();
    this.webGlBackend.destroy();
    this.webGpuBackend = null;
    this.activeBackend = this.webGlBackend;
  }

  private async installWebGpuBackend(
    camera: THREE.PerspectiveCamera,
    canvas: HTMLCanvasElement,
  ): Promise<void> {
    const webGpuBackend = await EntityLodProxyWebGpuRenderer3D.create({
      baseCanvas: canvas,
      camera,
    });
    if (webGpuBackend === null || this.destroyed) {
      webGpuBackend?.destroy();
      return;
    }
    this.webGpuBackend = webGpuBackend;
    this.webGlBackend.setVisible(false);
    this.activeBackend = webGpuBackend;
  }
}

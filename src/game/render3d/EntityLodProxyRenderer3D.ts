import * as THREE from 'three';
import type { Entity, PlayerId } from '../sim/types';
import { getBuildingCombatCenterZ } from '../sim/buildingAnchors';
import { entityInstanceColorHexForPlayer } from './EntityInstanceColor3D';
import {
  entityLodProxyGlyph3D,
  entityLodProxyRadius3D,
} from './EntityLod3D';

const ENTITY_LOD_PROXY_CAP = 32768;
const ENTITY_LOD_PROXY_OPACITY = 1;
const ENTITY_LOD_PROXY_DEPTH_TEST = true;
const ENTITY_LOD_PROXY_DEPTH_WRITE = true;
const ENTITY_LOD_PROXY_RENDER_ORDER = 3;

const POINT_VERTEX_SHADER = `
attribute vec3 color;
attribute float aRadius;
attribute float aGlyph;
attribute float aAlpha;
uniform float uViewportHeight;
varying vec3 vColor;
varying float vGlyph;
varying float vAlpha;
varying float vViewZ;
varying float vViewRadius;
varying vec4 vDepthProjection;

void main() {
  vColor = color;
  vGlyph = aGlyph;
  vAlpha = aAlpha;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  float viewDistance = max(1.0, -mvPosition.z);
  // Glyphs are bounded by the entity's true collision radius in world space:
  // project that radius straight to pixels with no min/max clamp, so the
  // marker tracks the collision volume at every zoom level.
  gl_PointSize = aRadius * projectionMatrix[1][1] * uViewportHeight / viewDistance;
  vViewZ = mvPosition.z;
  vViewRadius = aRadius;
  vDepthProjection = vec4(
    projectionMatrix[2][2],
    projectionMatrix[3][2],
    projectionMatrix[2][3],
    projectionMatrix[3][3]
  );
}
`;

const POINT_FRAGMENT_SHADER = `
uniform float uOpacity;
varying vec3 vColor;
varying float vGlyph;
varying float vAlpha;
varying float vViewZ;
varying float vViewRadius;
varying vec4 vDepthProjection;

float proxyGlyphMask(vec2 p, float glyph) {
  float glyphId = floor(glyph + 0.5);
  if (glyphId < 0.5) {
    return dot(p, p) <= 1.0 ? 1.0 : 0.0;
  }
  if (glyphId < 1.5) {
    return abs(p.x) + abs(p.y) <= 1.0 ? 1.0 : 0.0;
  }
  if (glyphId < 2.5) {
    return p.y >= -0.85 && p.y <= 0.95 && abs(p.x) <= (0.95 - p.y) * 0.58
      ? 1.0
      : 0.0;
  }
  if (glyphId < 3.5) {
    return max(abs(p.x), abs(p.y)) <= 0.78 ? 1.0 : 0.0;
  }
  if (glyphId < 4.5) {
    return max(abs(p.x), abs(p.y)) <= 0.9 && (abs(p.x) <= 0.26 || abs(p.y) <= 0.26)
      ? 1.0
      : 0.0;
  }
  return dot(p, p) <= 1.0 ? 1.0 : 0.0;
}

void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float radialSq = dot(p, p);
  if (proxyGlyphMask(p, vGlyph) < 0.5) discard;

  float frontShell = sqrt(max(0.0, 1.0 - radialSq)) * vViewRadius;
  float viewZ = vViewZ + frontShell;
  float clipZ = vDepthProjection.x * viewZ + vDepthProjection.y;
  float clipW = vDepthProjection.z * viewZ + vDepthProjection.w;
  float depth = (clipZ / clipW) * 0.5 + 0.5;
  if (depth < 0.0 || depth > 1.0) discard;
  gl_FragDepthEXT = depth;
  gl_FragColor = vec4(vColor, uOpacity * vAlpha);
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
  glyphs: Float32Array;
  alphas: Float32Array;
  positionAttr: THREE.BufferAttribute;
  colorAttr: THREE.BufferAttribute;
  radiusAttr: THREE.BufferAttribute;
  glyphAttr: THREE.BufferAttribute;
  alphaAttr: THREE.BufferAttribute;
  positionDirty: DirtySpan;
  colorDirty: DirtySpan;
  radiusDirty: DirtySpan;
  glyphDirty: DirtySpan;
  alphaDirty: DirtySpan;
  count: number;
  drawRangeCount: number;
};

type EntityLodProxyRendererBackend3D = {
  beginFrame(): void;
  pushUnit(entity: Entity): void;
  pushUnitProxy(
    simX: number,
    simY: number,
    simZ: number,
    radius: number,
    glyph: number,
    ownerId: PlayerId | undefined,
    alpha?: number,
  ): void;
  pushBuilding(entity: Entity): void;
  pushBuildingProxy(
    simX: number,
    simY: number,
    simZ: number,
    radius: number,
    glyph: number,
    ownerId: PlayerId | undefined,
    alpha?: number,
  ): void;
  flush(viewportHeight: number): void;
  destroy(): void;
};

type EntityLodProxyRenderer3DOptions = {
  readonly world: THREE.Group;
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

function createProxyPointMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uViewportHeight: { value: 1 },
      uOpacity: { value: Math.max(0, Math.min(1, ENTITY_LOD_PROXY_OPACITY)) },
    },
    vertexShader: POINT_VERTEX_SHADER,
    fragmentShader: POINT_FRAGMENT_SHADER,
    // Always blended: cross-fade rows carry per-instance alpha < 1 while
    // the icon fades in over the still-opaque model (BAR behavior).
    transparent: true,
    depthTest: ENTITY_LOD_PROXY_DEPTH_TEST,
    depthWrite: ENTITY_LOD_PROXY_DEPTH_WRITE,
  });
}

function createProxyPointBatch(): ProxyPointBatch {
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array(ENTITY_LOD_PROXY_CAP * 3);
  const colors = new Float32Array(ENTITY_LOD_PROXY_CAP * 3);
  const radii = new Float32Array(ENTITY_LOD_PROXY_CAP);
  const glyphs = new Float32Array(ENTITY_LOD_PROXY_CAP);
  const alphas = new Float32Array(ENTITY_LOD_PROXY_CAP);
  const positionAttr = new THREE.BufferAttribute(positions, 3);
  const colorAttr = new THREE.BufferAttribute(colors, 3);
  const radiusAttr = new THREE.BufferAttribute(radii, 1);
  const glyphAttr = new THREE.BufferAttribute(glyphs, 1);
  const alphaAttr = new THREE.BufferAttribute(alphas, 1);
  positionAttr.setUsage(THREE.DynamicDrawUsage);
  colorAttr.setUsage(THREE.DynamicDrawUsage);
  radiusAttr.setUsage(THREE.DynamicDrawUsage);
  glyphAttr.setUsage(THREE.DynamicDrawUsage);
  alphaAttr.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('position', positionAttr);
  geometry.setAttribute('color', colorAttr);
  geometry.setAttribute('aRadius', radiusAttr);
  geometry.setAttribute('aGlyph', glyphAttr);
  geometry.setAttribute('aAlpha', alphaAttr);
  geometry.setDrawRange(0, 0);

  const material = createProxyPointMaterial();
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
    glyphs,
    alphas,
    positionAttr,
    colorAttr,
    radiusAttr,
    glyphAttr,
    alphaAttr,
    positionDirty: createDirtySpan(),
    colorDirty: createDirtySpan(),
    radiusDirty: createDirtySpan(),
    glyphDirty: createDirtySpan(),
    alphaDirty: createDirtySpan(),
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

function lodProxyColorHex(ownerId: PlayerId | undefined): number {
  return entityInstanceColorHexForPlayer(ownerId);
}

function writePoint(
  batch: ProxyPointBatch,
  slot: number,
  x: number,
  y: number,
  z: number,
  radius: number,
  glyph: number,
  colorHex: number,
  alpha: number,
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
  const nextGlyph = Math.fround(glyph);
  if (batch.glyphs[slot] !== nextGlyph) {
    batch.glyphs[slot] = nextGlyph;
    markDirty(batch.glyphDirty, slot);
  }
  const nextAlpha = Math.fround(alpha);
  if (batch.alphas[slot] !== nextAlpha) {
    batch.alphas[slot] = nextAlpha;
    markDirty(batch.alphaDirty, slot);
  }
  writeColorHex(batch, slot, colorHex);
}

function writeSimPoint(
  batch: ProxyPointBatch,
  slot: number,
  simX: number,
  simY: number,
  simZ: number,
  radius: number,
  glyph: number,
  ownerId: PlayerId | undefined,
  alpha: number,
): void {
  writePoint(batch, slot, simX, simZ, simY, radius, glyph, lodProxyColorHex(ownerId), alpha);
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
  uploadDirty(batch.glyphAttr, batch.glyphDirty, 1);
  uploadDirty(batch.alphaAttr, batch.alphaDirty, 1);
}

class EntityLodProxyWebGlRenderer3D implements EntityLodProxyRendererBackend3D {
  private readonly unitBatch = createProxyPointBatch();
  private readonly buildingBatch = createProxyPointBatch();

  constructor(
    private readonly world: THREE.Group,
    private readonly canvas?: HTMLCanvasElement,
  ) {
    this.world.add(this.unitBatch.points);
    this.world.add(this.buildingBatch.points);
  }

  /**
   * The glyph shader sizes `gl_PointSize` in physical framebuffer pixels, so it
   * must be fed the drawing-buffer height, NOT the CSS height. `canvas.height`
   * is exactly that (Three.js keeps it at cssHeight * activePixelRatio), so it
   * stays correct at any resolution and pixel density — and tracks the dynamic
   * pixel-ratio the renderer may drop to under load. The passed CSS height is
   * only a fallback for when no canvas is wired (e.g. tests).
   */
  private physicalViewportHeight(cssViewportHeight: number): number {
    const bufferHeight = this.canvas?.height ?? 0;
    if (Number.isFinite(bufferHeight) && bufferHeight > 0) return bufferHeight;
    const dpr = typeof globalThis !== 'undefined' && globalThis.devicePixelRatio > 0
      ? globalThis.devicePixelRatio
      : 1;
    return cssViewportHeight * dpr;
  }

  beginFrame(): void {
    this.unitBatch.count = 0;
    this.buildingBatch.count = 0;
  }

  pushUnit(entity: Entity): void {
    const unit = entity.unit;
    if (unit === null) return;
    this.pushUnitProxy(
      entity.transform.x,
      entity.transform.y,
      entity.transform.z,
      entityLodProxyRadius3D(entity),
      entityLodProxyGlyph3D(entity),
      entity.ownership?.playerId,
    );
  }

  pushUnitProxy(
    simX: number,
    simY: number,
    simZ: number,
    radius: number,
    glyph: number,
    ownerId: PlayerId | undefined,
    alpha: number = 1,
  ): void {
    const slot = this.unitBatch.count;
    if (slot >= ENTITY_LOD_PROXY_CAP) return;
    writeSimPoint(
      this.unitBatch,
      slot,
      simX,
      simY,
      simZ,
      radius,
      glyph,
      ownerId,
      alpha,
    );
    this.unitBatch.count = slot + 1;
  }

  pushBuilding(entity: Entity): void {
    const building = entity.building;
    if (building === null) return;
    this.pushBuildingProxy(
      entity.transform.x,
      entity.transform.y,
      getBuildingCombatCenterZ(entity),
      entityLodProxyRadius3D(entity),
      entityLodProxyGlyph3D(entity),
      entity.ownership?.playerId,
    );
  }

  pushBuildingProxy(
    simX: number,
    simY: number,
    simZ: number,
    radius: number,
    glyph: number,
    ownerId: PlayerId | undefined,
    alpha: number = 1,
  ): void {
    const slot = this.buildingBatch.count;
    if (slot >= ENTITY_LOD_PROXY_CAP) return;
    writeSimPoint(
      this.buildingBatch,
      slot,
      simX,
      simY,
      simZ,
      radius,
      glyph,
      ownerId,
      alpha,
    );
    this.buildingBatch.count = slot + 1;
  }

  flush(viewportHeight: number): void {
    const physicalHeight = this.physicalViewportHeight(viewportHeight);
    markBatchRange(this.unitBatch, physicalHeight);
    markBatchRange(this.buildingBatch, physicalHeight);
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
  private readonly backend: EntityLodProxyWebGlRenderer3D;

  constructor(options: THREE.Group | EntityLodProxyRenderer3DOptions) {
    const normalizedOptions = normalizeOptions(options);
    this.backend = new EntityLodProxyWebGlRenderer3D(
      normalizedOptions.world,
      normalizedOptions.canvas,
    );
  }

  beginFrame(): void {
    this.backend.beginFrame();
  }

  pushUnit(entity: Entity): void {
    this.backend.pushUnit(entity);
  }

  pushUnitProxy(
    simX: number,
    simY: number,
    simZ: number,
    radius: number,
    glyph: number,
    ownerId: PlayerId | undefined,
    alpha: number = 1,
  ): void {
    this.backend.pushUnitProxy(simX, simY, simZ, radius, glyph, ownerId, alpha);
  }

  pushBuilding(entity: Entity): void {
    this.backend.pushBuilding(entity);
  }

  pushBuildingProxy(
    simX: number,
    simY: number,
    simZ: number,
    radius: number,
    glyph: number,
    ownerId: PlayerId | undefined,
    alpha: number = 1,
  ): void {
    this.backend.pushBuildingProxy(simX, simY, simZ, radius, glyph, ownerId, alpha);
  }

  flush(viewportHeight: number): void {
    this.backend.flush(viewportHeight);
  }

  destroy(): void {
    this.backend.destroy();
  }
}

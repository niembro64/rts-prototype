import * as THREE from 'three';
import type { Entity, PlayerId } from '../sim/types';
import { getBuildingCombatCenterZ } from '../sim/buildingAnchors';
import { writeHexToRgb01Array } from './colorUtils';
import {
  entityInstanceColorHexForPlayer,
  entityTeamColorHexForPlayer,
} from './EntityInstanceColor3D';
import {
  entityLodProxyGlyph3D,
  entityLodProxyRadius3D,
} from './EntityLod3D';
import {
  GLYPH_PLAYER_RING_FRACTION,
  GLYPH_TEAM_RING_FRACTION,
  GLYPH_WHITE_CORE_FRACTION,
  glyphMinScreenRadiusPxForViewport,
} from './EntityDetailLevel3D';
import { TRANSPARENT_RENDER_ORDER_3D } from './TransparentRenderOrder3D';
import {
  createDirtySlotSpan as createDirtySpan,
  markDirtySlot as markDirty,
  type DirtySlotSpan as DirtySpan,
  uploadDirtySlotSpan as uploadDirty,
} from './instancedBufferUpdate';
import { configureSelfLitEffectMaterial } from './RenderLighting3D';

const ENTITY_LOD_PROXY_CAP = 32768;
const ENTITY_LOD_PROXY_OPACITY = 1;
const ENTITY_LOD_PROXY_DEPTH_TEST = true;
export const ENTITY_LOD_PROXY_FINAL_DEPTH_WRITE = true;
export const ENTITY_LOD_PROXY_TRANSITION_DEPTH_WRITE = false;
const ENTITY_LOD_PROXY_FINAL_RENDER_ORDER = 3;
export const ENTITY_LOD_PROXY_TRANSITION_RENDER_ORDER =
  TRANSPARENT_RENDER_ORDER_3D.entityParts + 0.25;

const POINT_VERTEX_SHADER = `
attribute vec3 color;
attribute vec3 aTeamColor;
attribute float aRadius;
attribute float aGlyph;
attribute float aAlpha;
uniform float uViewportHeight;
uniform float uMinPointSizePx;
varying vec3 vColor;
varying vec3 vTeamColor;
varying float vGlyph;
varying float vAlpha;
varying float vViewZ;
varying float vViewRadius;
varying vec4 vDepthProjection;

void main() {
  vColor = color;
  vTeamColor = aTeamColor;
  vGlyph = aGlyph;
  vAlpha = aAlpha;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  float viewDistance = max(1.0, -mvPosition.z);
  // Glyphs are bounded by the entity's true collision radius in world space:
  // project that radius straight to pixels, so the marker tracks the collision
  // volume at every zoom level — until it reaches the floor. Past the MIN flip
  // the glyph IS the entity rather than a picture of it, and a symbol shrinking
  // into a sub-pixel dot stops saying anything, so the size stops tracking
  // distance there. Position and depth still do.
  gl_PointSize = max(
    aRadius * projectionMatrix[1][1] * uViewportHeight / viewDistance,
    uMinPointSizePx
  );
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
uniform float uWhiteCoreFraction;
uniform float uTeamRingFraction;
uniform float uPlayerRingFraction;
varying vec3 vColor;
varying vec3 vTeamColor;
varying float vGlyph;
varying float vAlpha;
varying float vViewZ;
varying float vViewRadius;
varying vec4 vDepthProjection;

// Normalised distance to a glyph's silhouette: <= 1 is inside, and the value
// scales linearly out from the shape's centre, so the SAME function draws the
// concentric colour bands — band edge f is just this field compared against a
// fraction of the radius. Each shape keeps the exact outline it had when the
// mask was a boolean; only its interior is now graded.
float proxyGlyphField(vec2 p, float glyph) {
  float glyphId = floor(glyph + 0.5);
  if (glyphId < 1.5) {
    // 0 circle, 1 diamond — both centred on the origin.
    return glyphId < 0.5 ? length(p) : abs(p.x) + abs(p.y);
  }
  if (glyphId < 2.5) {
    // 2 triangle. Graded about its centroid so the bands stay concentric
    // instead of crowding the apex.
    vec2 c = vec2(0.0, -0.25);
    vec2 q = p - c;
    float apex = 0.95 - c.y;
    float baseY = -0.85 - c.y;
    float top = q.y / apex;
    float bottom = q.y / baseY;
    float side = abs(q.x) / max(1e-4, (apex - q.y) * 0.58);
    return max(max(top, bottom), side);
  }
  if (glyphId < 3.5) {
    // 3 square.
    return max(abs(p.x), abs(p.y)) / 0.78;
  }
  if (glyphId < 4.5) {
    // 4 cross: inside the 0.9 box AND within the 0.26 arm of one axis.
    return max(max(abs(p.x), abs(p.y)) / 0.9, min(abs(p.x), abs(p.y)) / 0.26);
  }
  return length(p);
}

// Every glyph carries all four colors an entity must show: a small white core,
// then the team color, then the player color, then a black outline. White and
// black are the contrast pair that keeps the marker legible over any terrain;
// team sits INSIDE player so friend-or-enemy is the last thing to become
// unreadable as the glyph approaches its floor size.
vec3 proxyGlyphBandColor(float field, vec3 playerColor, vec3 teamColor) {
  if (field <= uWhiteCoreFraction) return vec3(1.0);
  if (field <= uTeamRingFraction) return teamColor;
  if (field <= uPlayerRingFraction) return playerColor;
  return vec3(0.0);
}

void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float radialSq = dot(p, p);
  float field = proxyGlyphField(p, vGlyph);
  if (field > 1.0) discard;

  // The glyph fakes the depth of a sphere of the entity's own radius, on that
  // sphere's NEAR shell — the icon reads in front of the model it is replacing
  // and in front of the terrain the entity stands on. (Putting the
  // cross-fading glyph on the FAR shell so the model occluded it was tried and
  // reverted: an icon peeking around a silhouette reads as a rendering error,
  // not as a marker.)
  float frontShell = sqrt(max(0.0, 1.0 - radialSq)) * vViewRadius;
  float viewZ = vViewZ + frontShell;
  float clipZ = vDepthProjection.x * viewZ + vDepthProjection.y;
  float clipW = vDepthProjection.z * viewZ + vDepthProjection.w;
  float depth = (clipZ / clipW) * 0.5 + 0.5;
  if (depth < 0.0 || depth > 1.0) discard;
  gl_FragDepthEXT = depth;
  gl_FragColor = vec4(
    proxyGlyphBandColor(field, vColor, vTeamColor),
    uOpacity * vAlpha
  );
}
`;

type ProxyPointBatch = {
  points: THREE.Points;
  geometry: THREE.BufferGeometry;
  material: THREE.ShaderMaterial;
  positions: Float32Array;
  colors: Float32Array;
  teamColors: Float32Array;
  radii: Float32Array;
  glyphs: Float32Array;
  alphas: Float32Array;
  positionAttr: THREE.BufferAttribute;
  colorAttr: THREE.BufferAttribute;
  teamColorAttr: THREE.BufferAttribute;
  radiusAttr: THREE.BufferAttribute;
  glyphAttr: THREE.BufferAttribute;
  alphaAttr: THREE.BufferAttribute;
  positionDirty: DirtySpan;
  colorDirty: DirtySpan;
  teamColorDirty: DirtySpan;
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

export function createEntityLodProxyMaterial3D(
  transition: boolean,
): THREE.ShaderMaterial {
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uViewportHeight: { value: 1 },
      uOpacity: { value: Math.max(0, Math.min(1, ENTITY_LOD_PROXY_OPACITY)) },
      uMinPointSizePx: { value: 0 },
      uWhiteCoreFraction: { value: GLYPH_WHITE_CORE_FRACTION },
      uTeamRingFraction: { value: GLYPH_TEAM_RING_FRACTION },
      uPlayerRingFraction: { value: GLYPH_PLAYER_RING_FRACTION },
    },
    vertexShader: POINT_VERTEX_SHADER,
    fragmentShader: POINT_FRAGMENT_SHADER,
    // A final glyph is an opaque replacement body. A transition glyph is a
    // true overlay: it blends after entity parts and must not populate its
    // fake spherical depth ahead of them.
    transparent: transition,
    depthTest: ENTITY_LOD_PROXY_DEPTH_TEST,
    depthWrite: transition
      ? ENTITY_LOD_PROXY_TRANSITION_DEPTH_WRITE
      : ENTITY_LOD_PROXY_FINAL_DEPTH_WRITE,
  });
  // MIN glyphs are HUD-like identity marks, not pieces of the lit world. Their
  // white/team/player/black bands must remain the exact authored colors under
  // every ENV/AMB/SUN/EXPO selection.
  return configureSelfLitEffectMaterial(material);
}

function createProxyPointBatch(transition: boolean): ProxyPointBatch {
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array(ENTITY_LOD_PROXY_CAP * 3);
  const colors = new Float32Array(ENTITY_LOD_PROXY_CAP * 3);
  const teamColors = new Float32Array(ENTITY_LOD_PROXY_CAP * 3);
  const radii = new Float32Array(ENTITY_LOD_PROXY_CAP);
  const glyphs = new Float32Array(ENTITY_LOD_PROXY_CAP);
  const alphas = new Float32Array(ENTITY_LOD_PROXY_CAP);
  const positionAttr = new THREE.BufferAttribute(positions, 3);
  const colorAttr = new THREE.BufferAttribute(colors, 3);
  const teamColorAttr = new THREE.BufferAttribute(teamColors, 3);
  const radiusAttr = new THREE.BufferAttribute(radii, 1);
  const glyphAttr = new THREE.BufferAttribute(glyphs, 1);
  const alphaAttr = new THREE.BufferAttribute(alphas, 1);
  positionAttr.setUsage(THREE.DynamicDrawUsage);
  colorAttr.setUsage(THREE.DynamicDrawUsage);
  teamColorAttr.setUsage(THREE.DynamicDrawUsage);
  radiusAttr.setUsage(THREE.DynamicDrawUsage);
  glyphAttr.setUsage(THREE.DynamicDrawUsage);
  alphaAttr.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('position', positionAttr);
  geometry.setAttribute('color', colorAttr);
  geometry.setAttribute('aTeamColor', teamColorAttr);
  geometry.setAttribute('aRadius', radiusAttr);
  geometry.setAttribute('aGlyph', glyphAttr);
  geometry.setAttribute('aAlpha', alphaAttr);
  geometry.setDrawRange(0, 0);

  const material = createEntityLodProxyMaterial3D(transition);
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  points.renderOrder = transition
    ? ENTITY_LOD_PROXY_TRANSITION_RENDER_ORDER
    : ENTITY_LOD_PROXY_FINAL_RENDER_ORDER;
  return {
    points,
    geometry,
    material,
    positions,
    colors,
    teamColors,
    radii,
    glyphs,
    alphas,
    positionAttr,
    colorAttr,
    teamColorAttr,
    radiusAttr,
    glyphAttr,
    alphaAttr,
    positionDirty: createDirtySpan(),
    colorDirty: createDirtySpan(),
    teamColorDirty: createDirtySpan(),
    radiusDirty: createDirtySpan(),
    glyphDirty: createDirtySpan(),
    alphaDirty: createDirtySpan(),
    count: 0,
    drawRangeCount: 0,
  };
}

// Per-frame scratch for the hex → 0..1 conversion. A number[] (not a
// Float32Array) keeps the change-detection comparison in float64, exactly
// as the former inline math compared.
const _scratchRgb01: number[] = [0, 0, 0];

function writeColorChannel(
  out: Float32Array,
  dirty: DirtySpan,
  slot: number,
  colorHex: number,
): void {
  const o = slot * 3;
  writeHexToRgb01Array(colorHex, _scratchRgb01, 0);
  const r = _scratchRgb01[0];
  const g = _scratchRgb01[1];
  const b = _scratchRgb01[2];
  if (out[o] === r && out[o + 1] === g && out[o + 2] === b) return;
  out[o] = r;
  out[o + 1] = g;
  out[o + 2] = b;
  markDirty(dirty, slot);
}

/** A glyph carries BOTH seat identities — the player's own color and the
 *  side's — because the shader bands them together with white and black. */
function lodProxyColorHex(ownerId: PlayerId | undefined): number {
  return entityInstanceColorHexForPlayer(ownerId);
}

function lodProxyTeamColorHex(ownerId: PlayerId | undefined): number {
  return entityTeamColorHexForPlayer(ownerId);
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
  teamColorHex: number,
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
  writeColorChannel(batch.colors, batch.colorDirty, slot, colorHex);
  writeColorChannel(batch.teamColors, batch.teamColorDirty, slot, teamColorHex);
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
  writePoint(
    batch,
    slot,
    simX,
    simZ,
    simY,
    radius,
    glyph,
    lodProxyColorHex(ownerId),
    lodProxyTeamColorHex(ownerId),
    alpha,
  );
}

function markBatchRange(batch: ProxyPointBatch, viewportHeight: number): void {
  const count = batch.count;
  if (batch.drawRangeCount !== count) {
    batch.geometry.setDrawRange(0, count);
    batch.drawRangeCount = count;
  }
  const liveViewportHeight = Math.max(1, viewportHeight);
  batch.material.uniforms.uViewportHeight.value = liveViewportHeight;
  // gl_PointSize is a diameter, and the floor is authored as a radius at the
  // reference viewport — convert once per batch rather than per vertex.
  batch.material.uniforms.uMinPointSizePx.value =
    2 * glyphMinScreenRadiusPxForViewport(liveViewportHeight);
  if (count <= 0) return;
  uploadDirty(batch.positionAttr, batch.positionDirty, 3);
  uploadDirty(batch.colorAttr, batch.colorDirty, 3);
  uploadDirty(batch.teamColorAttr, batch.teamColorDirty, 3);
  uploadDirty(batch.radiusAttr, batch.radiusDirty, 1);
  uploadDirty(batch.glyphAttr, batch.glyphDirty, 1);
  uploadDirty(batch.alphaAttr, batch.alphaDirty, 1);
}

class EntityLodProxyWebGlRenderer3D implements EntityLodProxyRendererBackend3D {
  private readonly unitBatch = createProxyPointBatch(false);
  private readonly unitTransitionBatch = createProxyPointBatch(true);
  private readonly buildingBatch = createProxyPointBatch(false);
  private readonly buildingTransitionBatch = createProxyPointBatch(true);

  constructor(
    private readonly world: THREE.Group,
    private readonly canvas?: HTMLCanvasElement,
  ) {
    this.world.add(this.unitBatch.points);
    this.world.add(this.unitTransitionBatch.points);
    this.world.add(this.buildingBatch.points);
    this.world.add(this.buildingTransitionBatch.points);
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
    this.unitTransitionBatch.count = 0;
    this.buildingBatch.count = 0;
    this.buildingTransitionBatch.count = 0;
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
    const batch = alpha < 1 ? this.unitTransitionBatch : this.unitBatch;
    const slot = batch.count;
    if (slot >= ENTITY_LOD_PROXY_CAP) return;
    writeSimPoint(
      batch,
      slot,
      simX,
      simY,
      simZ,
      radius,
      glyph,
      ownerId,
      alpha,
    );
    batch.count = slot + 1;
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
    const batch = alpha < 1 ? this.buildingTransitionBatch : this.buildingBatch;
    const slot = batch.count;
    if (slot >= ENTITY_LOD_PROXY_CAP) return;
    writeSimPoint(
      batch,
      slot,
      simX,
      simY,
      simZ,
      radius,
      glyph,
      ownerId,
      alpha,
    );
    batch.count = slot + 1;
  }

  flush(viewportHeight: number): void {
    const physicalHeight = this.physicalViewportHeight(viewportHeight);
    markBatchRange(this.unitBatch, physicalHeight);
    markBatchRange(this.unitTransitionBatch, physicalHeight);
    markBatchRange(this.buildingBatch, physicalHeight);
    markBatchRange(this.buildingTransitionBatch, physicalHeight);
  }

  destroy(): void {
    this.world.remove(this.unitBatch.points);
    this.world.remove(this.unitTransitionBatch.points);
    this.world.remove(this.buildingBatch.points);
    this.world.remove(this.buildingTransitionBatch.points);
    this.unitBatch.geometry.dispose();
    this.unitTransitionBatch.geometry.dispose();
    this.buildingBatch.geometry.dispose();
    this.buildingTransitionBatch.geometry.dispose();
    this.unitBatch.material.dispose();
    this.unitTransitionBatch.material.dispose();
    this.buildingBatch.material.dispose();
    this.buildingTransitionBatch.material.dispose();
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

/** Reusable single-batch form of the LOD:MIN proxy pipeline. Fog contacts use
 * this instead of physical sphere meshes, while supplying their own fixed
 * radius, neutral color, and non-identifying glyph. */
export class LodProxyPointBatchRenderer3D {
  private readonly batch = createProxyPointBatch(true);

  constructor(
    private readonly world: THREE.Group,
    private readonly canvas?: HTMLCanvasElement,
  ) {
    // Contacts are HUD knowledge, not physical bodies. Once a radar/sonar
    // return is earned it must remain legible rather than being buried by the
    // terrain whose ridge test already gated the contact.
    this.batch.material.depthTest = false;
    this.batch.material.depthWrite = false;
    this.batch.points.renderOrder = TRANSPARENT_RENDER_ORDER_3D.entityParts + 0.5;
    this.world.add(this.batch.points);
  }

  beginFrame(): void {
    this.batch.count = 0;
  }

  /** A contact has no seat to read a second identity from, so its player and
   *  team bands are the same neutral color — it still gets the white core and
   *  the black outline, which is what keeps it legible over any terrain.
   *  Passing teamColorHex splits the two bands where a caller does know. */
  pushProxy(
    simX: number,
    simY: number,
    simZ: number,
    radius: number,
    glyph: number,
    colorHex: number,
    alpha: number,
    teamColorHex: number = colorHex,
  ): void {
    const slot = this.batch.count;
    if (slot >= ENTITY_LOD_PROXY_CAP) return;
    writePoint(
      this.batch,
      slot,
      simX,
      simZ,
      simY,
      radius,
      glyph,
      colorHex,
      teamColorHex,
      alpha,
    );
    this.batch.count = slot + 1;
  }

  flush(cssViewportHeight = 1): void {
    const bufferHeight = this.canvas?.height ?? 0;
    const physicalHeight = Number.isFinite(bufferHeight) && bufferHeight > 0
      ? bufferHeight
      : cssViewportHeight * (
        typeof globalThis !== 'undefined' && globalThis.devicePixelRatio > 0
          ? globalThis.devicePixelRatio
          : 1
      );
    markBatchRange(this.batch, physicalHeight);
  }

  destroy(): void {
    this.world.remove(this.batch.points);
    this.batch.geometry.dispose();
    this.batch.material.dispose();
  }
}

// WaterRenderer3D — WATER or LAVA surface at WATER_LEVEL with four
// independently sorted perimeter curtains plus a bottom face in
// floating-square modes, so present liquid is a closed box rather than an
// open-bottomed shell. NONE retains only a stable empty mesh handle for
// callers and emits no renderable or pickable geometry.
//
// In infinity mode water is one large horizontal plane. The submerged land
// that makes CIRCLE perimeter mode continuous is emitted by
// TerrainTileRenderer3D as part of the terrain mesh itself, so edge terrain
// and off-map terrain share one material/shader/color path.

import * as THREE from 'three';
import {
  getWaterBoundaryMode,
  getWaterTriangleDebug,
  type WaterBoundaryMode,
} from '@/clientBarConfig';
import { WATER_FULLY_OPAQUE, WATER_LEVEL } from '../sim/Terrain';
import { HORIZON_RENDER_EXTEND, LAVA_RENDER_CONFIG, WATER_RENDER_CONFIG } from '../../config';
import { getLiquidSurfaceMode } from '../sim/worldSurfaceState';
import type { LiquidSurfaceMode } from '../../types/worldSurfaceMode';
import type { GraphicsConfig } from '@/types/graphics';
import type { RenderFrameState3D } from './RenderFrameState3D';
import { TRANSPARENT_RENDER_ORDER_3D } from './TransparentRenderOrder3D';
import { getFloatingWaterOverhang, getWaterBoxFloorY } from './WorldBoxGeometry3D';
import {
  mapInfoAnnexRowPointX,
  mapInfoAnnexRowPointZ,
  resolveMapInfoAnnexFootprint,
  resolveMapInfoAnnexLiquidRows,
  type MapInfoAnnexRow,
} from './MapInfoAnnex3D';
import { createLiquidSurfaceTexture3D } from './LiquidSurfaceTexture3D';

// Depth bias only. The mesh vertices stay exactly at WATER_LEVEL for
// gameplay/readability, but the fragments are pushed slightly behind
// terrain in the depth buffer so shoreline faces do not shimmer as
// the camera eases in and out.
//
// Keep `factor=0` so the bias is pure constant offset, not slope-
// coupled. The OpenGL formula is `factor × max(|dz/dx|, |dz/dy|) +
// units × ULP_at_z`. The `factor × slope` term re-evaluates every
// frame the camera angle changes — even sub-pixel — so each frame's
// offset value is slightly different. That itself causes flicker
// during camera motion: the bias amount oscillates across ULP
// boundaries even with the camera "settled" by the eye.
//
// Pure `units` is constant per frame, so the bias is rock-steady
// while the camera moves.
//
// `units` is sized for the renderer's LINEAR depth buffer (log depth
// was reverted — see the note in ThreeApp.ts). One linear-depth ULP
// at view distance z spans ~z² × (far−near)/(far·near·2²⁴) world
// units — ~0.12 wu at z = 10k, growing quadratically — so every unit
// here pushes the visible waterline down the beach by a distance-
// scaled amount. The previous value (64, tuned while the renderer
// briefly ran log depth) displaced the shoreline tens of world units
// at zoomed-out distances, visibly detaching the water's edge from
// the per-fragment above/below-water terrain shading. Z-fight noise
// between the tessellated surface grid and terrain is ULP-scale, so
// a few ULPs suffice at every distance.
const WATER_DEPTH_OFFSET_FACTOR = 0;
const WATER_DEPTH_OFFSET_UNITS = 4;
/** Curtains do not carry the horizontal flow shader, so they use the palette's
 * deep side-wall colour directly. */
function lavaCurtainColor(): THREE.Color {
  return new THREE.Color(LAVA_RENDER_CONFIG.curtainColor);
}

const WATER_TRIANGLE_DEBUG_COLOR = 0xfff17a;
const WATER_TRIANGLE_DEBUG_OPACITY = 0.95;

/** Three independent field offsets are integrated on the CPU from the live
 * horizontal wind. The fragment shader samples the same seamless authored
 * field at three scales; subtracting each accumulated offset makes features
 * travel downstream rather than sliding opposite the wind like a UV decal. */
const LIQUID_MAP_UNIFORMS = `
uniform float uLiquidTime;
uniform vec2 uLiquidFlow0;
uniform vec2 uLiquidFlow1;
uniform vec2 uLiquidFlow2;
uniform vec3 uLiquidLayerScales;
uniform vec3 uLavaColdCrustColor;
uniform vec3 uLavaWarmCrustColor;
uniform vec3 uLavaMoltenColor;
uniform vec3 uLavaHotColor;
uniform vec3 uLavaCoreColor;
uniform float uLavaEmissiveScale;
`;

const WATER_MAP_FRAGMENT = `
#ifdef USE_MAP
  vec3 waterPrimary = texture2D(
    map,
    vMapUv * uLiquidLayerScales.x - uLiquidFlow0
  ).rgb;
  vec3 waterSecondary = texture2D(
    map,
    vMapUv * uLiquidLayerScales.y - uLiquidFlow1
  ).rgb;
  vec3 waterTertiary = texture2D(
    map,
    vMapUv * uLiquidLayerScales.z - uLiquidFlow2
  ).rgb;
  diffuseColor.rgb *=
    waterPrimary * 0.52 + waterSecondary * 0.30 + waterTertiary * 0.18;
#endif
`;

/** Viscous lava is a moving material rather than an orange decal. A broad
 * sample bends the domain; two independently advected samples slide cooling
 * rafts across major and hairline rifts; localized thermal maxima breathe into
 * hot upwellings. MeshBasicMaterial still supplies ordinary fog and tone
 * mapping, while this block owns the lava's unlit/emissive colour. */
const LAVA_MAP_FRAGMENT = `
#ifdef USE_MAP
  vec2 lavaMacroUv = vMapUv * uLiquidLayerScales.x - uLiquidFlow0;
  vec3 lavaMacro = texture2D(map, lavaMacroUv).rgb;
  vec3 lavaWarpProbe = texture2D(
    map,
    lavaMacroUv + vec2(0.371, 0.619)
  ).rgb;
  vec2 lavaWarp = (vec2(lavaMacro.b, lavaWarpProbe.b) - vec2(0.5)) * 0.19;

  vec3 lavaRaft = texture2D(
    map,
    vMapUv * uLiquidLayerScales.y - uLiquidFlow1 + lavaWarp
  ).rgb;
  vec3 lavaDetail = texture2D(
    map,
    vMapUv * uLiquidLayerScales.z - uLiquidFlow2 - lavaWarp * 0.42
  ).rgb;

  float lavaRiftTopology = lavaRaft.r;
  float lavaHairline = max(lavaRaft.g, lavaDetail.g * 0.82);
  float lavaThermal = dot(
    vec3(lavaMacro.b, lavaRaft.b, lavaDetail.b),
    vec3(0.24, 0.48, 0.28)
  );
  // Thermal gating closes most of the cellular borders into dark seams. Only
  // connected hot regions open into visible melt, avoiding a uniform glowing
  // stained-glass web across the whole lake.
  float lavaOpenGate = smoothstep(0.39, 0.72, lavaThermal);
  float lavaOpenRift = lavaRiftTopology * (0.28 + lavaOpenGate * 0.72);
  float lavaMelt = smoothstep(0.42, 0.94, lavaOpenRift);
  float lavaHot = smoothstep(0.76, 0.995, lavaOpenRift)
    * (0.74 + lavaThermal * 0.26);
  float lavaCore = smoothstep(0.975, 1.0, lavaOpenRift);

  // Broad thermal maxima become sparse upwellings. Their per-region phase is
  // sourced from the drifting detail field, so the whole lake never pulses as
  // one synchronized light.
  float lavaUpwellPulse = 0.5 + 0.5 * sin(
    uLiquidTime * 0.72 + lavaDetail.b * 12.5663706 + lavaMacro.b * 4.7123890
  );
  float lavaUpwell = smoothstep(
    0.69,
    0.88,
    lavaThermal + lavaUpwellPulse * 0.11
  );
  float lavaUpwellChannel = lavaUpwell
    * smoothstep(0.16, 0.72, lavaRiftTopology);
  lavaMelt = max(lavaMelt, lavaUpwellChannel * 0.82);
  lavaHot = max(lavaHot, lavaUpwellChannel * 0.74);
  lavaCore = max(
    lavaCore,
    lavaUpwellChannel * lavaUpwellPulse * 0.28
  );

  // A warm bevel around each opening gives the dark crust thickness. The
  // interior remains nearly black; only exposed melt receives emissive gain.
  float lavaCrustBevel = smoothstep(0.045, 0.34, lavaRiftTopology)
    * (1.0 - smoothstep(0.47, 0.83, lavaRiftTopology));
  float lavaHairGlow = smoothstep(0.62, 0.98, lavaHairline) * 0.14;
  float lavaRaftWarmth = clamp(
    lavaThermal * 0.42 + lavaCrustBevel * 0.68 + lavaHairline * 0.08,
    0.0,
    1.0
  );
  vec3 lavaColor = mix(
    uLavaColdCrustColor,
    uLavaWarmCrustColor,
    lavaRaftWarmth
  );
  lavaColor = mix(lavaColor, uLavaMoltenColor, max(lavaMelt, lavaHairGlow));
  lavaColor = mix(lavaColor, uLavaHotColor, lavaHot);
  lavaColor = mix(lavaColor, uLavaCoreColor, lavaCore);
  float lavaEmission = mix(
    1.0,
    uLavaEmissiveScale,
    smoothstep(0.18, 0.92, max(lavaMelt, lavaHot))
  );
  diffuseColor.rgb *= lavaColor * lavaEmission;
#endif
`;

const LIQUID_FLOW_LAYER_RANDOM_SEEDS = [
  0x19d3,
  0x4a7f,
  0x83b1,
] as const;

type LiquidFlowWind = Readonly<{ x: number; y: number }>;

function wrapRepeat(value: number): number {
  // RepeatWrapping treats negative and positive integer offsets identically.
  // Preserve the sign of the remainder so the stored displacement still
  // communicates which side of the wind bearing a layer is wiggling toward.
  return value % 1;
}

/** Stable integer hash mapped to [-1, 1]. This is render-only motion state:
 * it supplies successive heading targets without touching simulation RNG. */
function liquidFlowRandomSigned(segment: number, seed: number): number {
  let value = (Math.trunc(segment) ^ seed) >>> 0;
  value = Math.imul(value ^ (value >>> 16), 0x7feb352d);
  value = Math.imul(value ^ (value >>> 15), 0x846ca68b);
  value = (value ^ (value >>> 16)) >>> 0;
  return (value / 0xffff_ffff) * 2 - 1;
}

/** Smoothly interpolate between deterministic pseudo-random heading targets.
 * The authored prime periods keep the three layers from changing together. */
function liquidFlowHeadingWiggle(
  timeSeconds: number,
  periodSeconds: number,
  seed: number,
): number {
  const position = timeSeconds / periodSeconds;
  const segment = Math.floor(position);
  const rawT = position - segment;
  const smoothT = rawT * rawT * (3 - 2 * rawT);
  const from = liquidFlowRandomSigned(segment, seed);
  const to = liquidFlowRandomSigned(segment + 1, seed);
  return from + (to - from) * smoothT;
}

// The horizontal surface is a rectilinear grid, not one giant quad. Depth
// at a pixel is interpolated from that triangle's own vertices, so a quad
// whose corners sit HORIZON_RENDER_EXTEND (~180k wu) away carries float32
// interpolation noise of several depth ULPs at every on-map shoreline
// pixel; map-scale cells keep that noise near/under one ULP, which is what
// lets WATER_DEPTH_OFFSET_UNITS stay small. The off-map horizon ring
// reuses the map-edge breakpoints, so the grid stays crack-free.
const WATER_SURFACE_GRID_STEPS = 16;

/** Axis breakpoints: `steps` uniform interior steps across [innerStart,
 *  innerEnd], plus the outer horizon edges when they extend past it. */
function gridBreakpoints(
  outerStart: number,
  innerStart: number,
  innerEnd: number,
  outerEnd: number,
  steps: number,
): number[] {
  const points: number[] = [];
  if (outerStart < innerStart) points.push(outerStart);
  for (let i = 0; i <= steps; i++) {
    points.push(innerStart + ((innerEnd - innerStart) * i) / steps);
  }
  if (outerEnd > innerEnd) points.push(outerEnd);
  return points;
}

/** The `points` that fall strictly inside [a, b], with both ends added — the
 *  breakpoints of one sub-span of an axis, sharing the parent axis's
 *  interior points so the two meshes meet without T-junctions. Empty for a
 *  span with no length, which is a strip that must not be emitted at all. */
function clipBreakpoints(points: readonly number[], a: number, b: number): number[] {
  if (b - a <= 1e-6) return [];
  const inner = points.filter((value) => value > a + 1e-6 && value < b - 1e-6);
  return [a, ...inner, b];
}

/**
 * Emits one horizontal indexed grid at height `y` over a stack of the info
 * annex's ROWS — a trapezoid per band rather than a rectangle, so the liquid
 * covering the headland is the headland's own shape.
 *
 * The winding is the reverse of {@link pushHorizontalGrid}'s for the same
 * `facing`: the annex's (along, out) frame is a fixed quarter-turn of `out`,
 * which makes it left-handed against world (+X, +Z) on every map edge.
 */
function pushAnnexRowGrid(
  positions: number[],
  normals: number[],
  indices: number[],
  point: (row: MapInfoAnnexRow, across: number) => readonly [number, number],
  rows: readonly MapInfoAnnexRow[],
  columns: number,
  y: number,
  facing: 1 | -1 = 1,
): void {
  const base = positions.length / 3;
  const stride = columns + 1;
  for (const row of rows) {
    for (let column = 0; column <= columns; column++) {
      const [x, z] = point(row, (column / columns) * 2 - 1);
      positions.push(x, y, z);
      normals.push(0, facing, 0);
    }
  }
  for (let row = 0; row < rows.length - 1; row++) {
    for (let column = 0; column < columns; column++) {
      const a = base + row * stride + column;
      const b = a + 1;
      const c = b + stride;
      const d = a + stride;
      if (facing > 0) {
        indices.push(a, b, c, a, c, d);
      } else {
        indices.push(a, c, b, a, d, c);
      }
    }
  }
}

/** Emits one horizontal indexed grid at height `y` over xs × zs. `facing` is
 *  the outward normal's sign on Y: +1 for the water surface, -1 for the box's
 *  bottom face. The winding follows it, so gl_FrontFacing agrees with the
 *  authored normal on every face of the box — the same invariant
 *  pushCurtainStrip holds for the four vertical curtains. */
function pushHorizontalGrid(
  positions: number[],
  normals: number[],
  indices: number[],
  xs: readonly number[],
  zs: readonly number[],
  y: number,
  facing: 1 | -1 = 1,
): void {
  const base = positions.length / 3;
  for (const z of zs) {
    for (const x of xs) {
      positions.push(x, y, z);
      normals.push(0, facing, 0);
    }
  }
  const cols = xs.length;
  for (let j = 0; j < zs.length - 1; j++) {
    for (let i = 0; i < cols - 1; i++) {
      const a = base + j * cols + i;
      const b = a + 1;
      const c = b + cols;
      const d = a + cols;
      // a→b runs +x and a→d runs +z, so (b-a)×(c-a) points DOWN; the
      // upward-facing surface is the one that needs the reversal.
      if (facing > 0) {
        indices.push(a, c, b, a, d, c);
      } else {
        indices.push(a, b, c, a, c, d);
      }
    }
  }
}

/**
 * Emits one vertical curtain strip whose top edge runs along `edgePoints`
 * ([x, z] pairs). The points come from the same breakpoints as the surface
 * grid so the surface↔curtain seam has no T-junctions.
 *
 * SUBDIVIDED VERTICALLY, for exactly the reason the surface is subdivided
 * horizontally (see WATER_SURFACE_GRID_STEPS). Depth at a pixel is
 * interpolated from its own triangle's vertices, so a triangle spanning a
 * huge distance carries float32 interpolation noise of several depth ULPs —
 * which is more than the whole polygon offset this material leans on.
 *
 * The surface was tessellated into map-scale cells to keep that noise under
 * one ULP; the curtains were left one quad tall, and they are the TALLEST
 * geometry in the scene — floor depth is a quarter of the map's average axis
 * plus the water's overhang, so a 16k map hangs a single 4200-unit quad off
 * every edge against 1000-unit surface cells. Rows are capped at the surface
 * cell size so both axes of this mesh carry the same interpolation error.
 */
function pushCurtainStrip(
  positions: number[],
  normals: number[],
  indices: number[],
  edgePoints: ReadonlyArray<readonly [number, number]>,
  bottomY: number,
  topY: number,
  nx: number,
  nz: number,
  maxRowHeight: number,
): void {
  const base = positions.length / 3;
  const span = Math.abs(topY - bottomY);
  const rows = Math.max(1, Math.ceil(span / Math.max(1e-3, maxRowHeight)));
  for (let r = 0; r <= rows; r++) {
    const y = bottomY + ((topY - bottomY) * r) / rows;
    for (const [x, z] of edgePoints) {
      positions.push(x, y, z);
      normals.push(nx, 0, nz);
    }
  }
  const cols = edgePoints.length;
  for (let r = 0; r < rows; r++) {
    const row = base + r * cols;
    const next = row + cols;
    for (let i = 0; i < cols - 1; i++) {
      // edgePoints are authored clockwise around the water box. Reverse the
      // original inward winding so gl_FrontFacing agrees with the explicit
      // outward normal on all four curtains.
      indices.push(row + i, next + i + 1, row + i + 1);
      indices.push(row + i, next + i, next + i + 1);
    }
  }
}

/** The five non-surface faces of the floating water box, in the order their
 *  meshes and geometry are built. */
export const WATER_BOX_FACES = ['north', 'east', 'south', 'west', 'bottom'] as const;
type WaterBoxFace = (typeof WATER_BOX_FACES)[number];

export class WaterRenderer3D {
  private waterMesh: THREE.Mesh;
  private waterGeometry: THREE.BufferGeometry;
  /** Five independent transparent objects — four perimeter curtains and the
   *  bottom face — so Three.js can sort the world-box faces back-to-front.
   *  Keeping them in the surface mesh made triangle insertion order decide
   *  which opposite face won the depth test. */
  private waterCurtains: Array<{
    readonly direction: WaterBoxFace;
    readonly mesh: THREE.Mesh;
    readonly geometry: THREE.BufferGeometry;
  }> = [];
  private waterMaterial: THREE.MeshBasicMaterial;
  private waterCurtainMaterial: THREE.MeshBasicMaterial;
  private waterTriangleLines: THREE.LineSegments;
  private waterTriangleGeometry: THREE.BufferGeometry;
  private waterTriangleMaterial: THREE.LineBasicMaterial;
  private liquidTexture: THREE.DataTexture;
  private liquidTextureTileWorldSize: number;
  private liquidFlowConfig: typeof WATER_RENDER_CONFIG.texture;
  private liquidFlowElapsedSeconds = 0;
  private readonly liquidTimeUniform = { value: 0 };
  private readonly liquidFlowOffsetUniforms = [
    { value: new THREE.Vector2() },
    { value: new THREE.Vector2() },
    { value: new THREE.Vector2() },
  ] as const;
  private readonly liquidLayerScalesUniform = { value: new THREE.Vector3() };
  private readonly lavaColdCrustColorUniform = {
    value: new THREE.Color(LAVA_RENDER_CONFIG.palette.coldCrust),
  };
  private readonly lavaWarmCrustColorUniform = {
    value: new THREE.Color(LAVA_RENDER_CONFIG.palette.warmCrust),
  };
  private readonly lavaMoltenColorUniform = {
    value: new THREE.Color(LAVA_RENDER_CONFIG.palette.molten),
  };
  private readonly lavaHotColorUniform = {
    value: new THREE.Color(LAVA_RENDER_CONFIG.palette.hot),
  };
  private readonly lavaCoreColorUniform = {
    value: new THREE.Color(LAVA_RENDER_CONFIG.palette.core),
  };
  private readonly lavaEmissiveScaleUniform = {
    value: Math.max(1, LAVA_RENDER_CONFIG.emissiveScale),
  };
  private mapWidth: number;
  private mapHeight: number;
  private built = false;
  private lastVisible = true;
  private lastTriangleDebugVisible = false;
  private lastOpacity = Number.NaN;
  private lastWaterBoundaryMode: WaterBoundaryMode | null = null;
  private lastLiquidSurfaceMode: LiquidSurfaceMode;

  constructor(parent: THREE.Group, mapWidth: number, mapHeight: number) {
    this.mapWidth = mapWidth;
    this.mapHeight = mapHeight;
    this.waterGeometry = new THREE.BufferGeometry();
    // Even when transparent, water is still a real surface for later
    // transparent effects: writing depth prevents fog/smoke fragments
    // physically behind the water plane from being composited over it.
    // Transparent entity parts render immediately before this surface,
    // otherwise this depth write would erase submerged instanced bodies.
    // WATER_FULLY_OPAQUE additionally disables alpha blending; triangles
    // beneath the ocean are culled in TerrainTileRenderer3D for that mode.
    // LIQUID = LAVA swaps the surface for opaque molten rock. Same base
    // material path (unlit, still tone mapped), with a small shader extension
    // for wind-advected crust. LIQUID = NONE keeps this stable mesh object
    // for callers but gives it no geometry at all.
    this.lastLiquidSurfaceMode = getLiquidSurfaceMode();
    const lava = this.lastLiquidSurfaceMode === 'lava';
    const textureConfig = lava
      ? LAVA_RENDER_CONFIG.texture
      : WATER_RENDER_CONFIG.texture;
    this.liquidTexture = createLiquidSurfaceTexture3D(
      lava ? 'lava' : 'water',
      textureConfig,
    );
    this.liquidTextureTileWorldSize = textureConfig.tileWorldSize;
    this.liquidFlowConfig = textureConfig;
    this.liquidLayerScalesUniform.value.fromArray(textureConfig.layerScales);
    this.waterMaterial = new THREE.MeshBasicMaterial({
      // Lava's shader owns its complete palette. White leaves those linear
      // colours untouched before the stock fog/tone-mapping tail runs.
      color: lava ? 0xffffff : WATER_RENDER_CONFIG.color,
      map: this.liquidTexture,
      transparent: !lava && !WATER_FULLY_OPAQUE,
      opacity: lava || WATER_FULLY_OPAQUE ? 1 : WATER_RENDER_CONFIG.opacity,
      depthWrite: true,
      depthTest: true,
      polygonOffset: true,
      polygonOffsetFactor: WATER_DEPTH_OFFSET_FACTOR,
      polygonOffsetUnits: WATER_DEPTH_OFFSET_UNITS,
      side: THREE.DoubleSide,
    });
    // A consistently wound plane does not need Three's automatic transparent
    // BackSide + FrontSide double draw. One uncullled pass remains visible
    // above and below water without letting driver-specific depth rounding
    // differ between two passes over the same triangles.
    this.waterMaterial.forceSinglePass = true;
    this.configureSurfaceShader(lava ? 'lava' : 'water');
    this.waterCurtainMaterial = this.waterMaterial.clone();
    // Flow grain belongs to the horizontal skin. Stretching it down the
    // render-only world-box curtains would turn every wave into a long stripe.
    this.waterCurtainMaterial.map = null;
    if (lava) this.waterCurtainMaterial.color.copy(lavaCurtainColor());
    this.waterCurtainMaterial.forceSinglePass = true;
    // Only the horizontal gameplay water surface owns water occlusion. These
    // render-only outer panels contain no pickable/gameplay surface and have
    // nothing gameplay-relevant behind them, so they must not compete in the
    // depth buffer with the inset terrain slab or an opposite curtain.
    this.waterCurtainMaterial.depthWrite = false;
    // Polygon offset exists solely to settle the horizontal shoreline against
    // terrain. The curtains sit outside the terrain slab and share only an
    // edge with the surface, so biasing their depth is unnecessary. Keeping
    // the driver-defined bias on those faces was also the remaining platform-
    // sensitive path in the reported Windows/NVIDIA +X/+Z sparkle.
    this.waterCurtainMaterial.polygonOffset = false;
    this.waterCurtainMaterial.polygonOffsetFactor = 0;
    this.waterCurtainMaterial.polygonOffsetUnits = 0;
    this.waterCurtainMaterial.onBeforeCompile = () => {};
    this.waterCurtainMaterial.customProgramCacheKey = () => 'liquid-curtain-v1';

    this.waterMesh = new THREE.Mesh(this.waterGeometry, this.waterMaterial);
    this.waterMesh.name = 'WaterSurface';
    this.waterMesh.renderOrder = TRANSPARENT_RENDER_ORDER_3D.waterSurface;
    this.waterMesh.frustumCulled = false;
    this.lastVisible = this.waterMesh.visible;
    parent.add(this.waterMesh);

    for (const direction of WATER_BOX_FACES) {
      const geometry = new THREE.BufferGeometry();
      const mesh = new THREE.Mesh(geometry, this.waterCurtainMaterial);
      mesh.name = `WaterCurtain:${direction}`;
      mesh.renderOrder = TRANSPARENT_RENDER_ORDER_3D.waterSurface;
      mesh.frustumCulled = false;
      parent.add(mesh);
      this.waterCurtains.push({ direction, mesh, geometry });
    }

    // The water is indexed triangle geometry just like terrain: a rectilinear
    // surface grid (see WATER_SURFACE_GRID_STEPS) plus, in floating-square
    // mode, five independently sorted world-box face meshes. Keep its debug
    // wireframe as one separate depth-tested overlay so WATER TRIS exposes all
    // actual triangles without changing the water material or surface level.
    this.waterTriangleGeometry = new THREE.BufferGeometry();
    this.waterTriangleMaterial = new THREE.LineBasicMaterial({
      color: WATER_TRIANGLE_DEBUG_COLOR,
      transparent: true,
      opacity: WATER_TRIANGLE_DEBUG_OPACITY,
      depthWrite: false,
      depthTest: true,
      toneMapped: false,
    });
    this.waterTriangleLines = new THREE.LineSegments(
      this.waterTriangleGeometry,
      this.waterTriangleMaterial,
    );
    this.waterTriangleLines.renderOrder = TRANSPARENT_RENDER_ORDER_3D.waterSurface + 0.1;
    this.waterTriangleLines.frustumCulled = false;
    this.waterTriangleLines.visible = false;
    parent.add(this.waterTriangleLines);
  }

  /** Canonical horizontal water geometry for command cursor first-surface
   *  picking. The independently sorted box faces are intentionally
   *  excluded, and camera anchors use terrain only. The mesh object is stable
   *  when geometry is rebuilt for a different boundary presentation mode. */
  getMesh(): THREE.Mesh {
    return this.waterMesh;
  }

  private configureSurfaceShader(mode: Exclude<LiquidSurfaceMode, 'none'>): void {
    this.waterMaterial.onBeforeCompile = (shader): void => {
      shader.uniforms.uLiquidTime = this.liquidTimeUniform;
      shader.uniforms.uLiquidFlow0 = this.liquidFlowOffsetUniforms[0];
      shader.uniforms.uLiquidFlow1 = this.liquidFlowOffsetUniforms[1];
      shader.uniforms.uLiquidFlow2 = this.liquidFlowOffsetUniforms[2];
      shader.uniforms.uLiquidLayerScales = this.liquidLayerScalesUniform;
      shader.uniforms.uLavaColdCrustColor = this.lavaColdCrustColorUniform;
      shader.uniforms.uLavaWarmCrustColor = this.lavaWarmCrustColorUniform;
      shader.uniforms.uLavaMoltenColor = this.lavaMoltenColorUniform;
      shader.uniforms.uLavaHotColor = this.lavaHotColorUniform;
      shader.uniforms.uLavaCoreColor = this.lavaCoreColorUniform;
      shader.uniforms.uLavaEmissiveScale = this.lavaEmissiveScaleUniform;
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <map_pars_fragment>',
          `#include <map_pars_fragment>\n${LIQUID_MAP_UNIFORMS}`,
        )
        .replace(
          '#include <map_fragment>',
          mode === 'lava' ? LAVA_MAP_FRAGMENT : WATER_MAP_FRAGMENT,
        );
    };
    const shaderVersion = mode === 'lava'
      ? 'lava-viscous-flow-v2'
      : 'water-wind-flow-v1';
    this.waterMaterial.customProgramCacheKey = () => shaderVersion;
    this.waterMaterial.userData.liquidSurfaceShader = shaderVersion;
    this.waterMaterial.needsUpdate = true;
  }

  private configureLiquidMaterial(mode: Exclude<LiquidSurfaceMode, 'none'>): void {
    const lava = mode === 'lava';
    const textureConfig = lava
      ? LAVA_RENDER_CONFIG.texture
      : WATER_RENDER_CONFIG.texture;
    const previousTexture = this.liquidTexture;
    this.liquidTexture = createLiquidSurfaceTexture3D(mode, textureConfig);
    this.liquidTextureTileWorldSize = textureConfig.tileWorldSize;
    this.liquidFlowConfig = textureConfig;
    this.liquidLayerScalesUniform.value.fromArray(textureConfig.layerScales);
    this.liquidFlowElapsedSeconds = 0;
    this.liquidTimeUniform.value = 0;
    for (const offset of this.liquidFlowOffsetUniforms) offset.value.set(0, 0);

    this.waterMaterial.color.copy(
      lava ? new THREE.Color(0xffffff) : new THREE.Color(WATER_RENDER_CONFIG.color),
    );
    this.waterMaterial.map = this.liquidTexture;
    this.waterMaterial.transparent = !lava && !WATER_FULLY_OPAQUE;
    this.waterMaterial.opacity = lava || WATER_FULLY_OPAQUE
      ? 1
      : WATER_RENDER_CONFIG.opacity;
    this.configureSurfaceShader(mode);

    this.waterCurtainMaterial.color.copy(
      lava ? lavaCurtainColor() : this.waterMaterial.color,
    );
    this.waterCurtainMaterial.transparent = this.waterMaterial.transparent;
    this.waterCurtainMaterial.opacity = this.waterMaterial.opacity;
    this.waterCurtainMaterial.needsUpdate = true;
    this.lastOpacity = this.waterMaterial.opacity;
    previousTexture.dispose();

    // The mode can change the texture's world scale, so every world-anchored
    // UV must be regenerated together with the geometry.
    this.built = false;
    this.lastWaterBoundaryMode = null;
  }

  private clearLiquidGeometry(): void {
    this.setGeometry(this.waterGeometry, [], [], []);
    for (const curtain of this.waterCurtains) {
      this.setGeometry(curtain.geometry, [], [], []);
    }
    this.rebuildTriangleGeometry([]);
    this.built = false;
    this.lastWaterBoundaryMode = null;
  }

  private buildInfinityGeometry(): void {
    const outer = HORIZON_RENDER_EXTEND;
    const xs = gridBreakpoints(
      -outer, 0, this.mapWidth, this.mapWidth + outer, WATER_SURFACE_GRID_STEPS,
    );
    const zs = gridBreakpoints(
      -outer, 0, this.mapHeight, this.mapHeight + outer, WATER_SURFACE_GRID_STEPS,
    );

    const positions: number[] = [];
    const normals: number[] = [];
    const indices: number[] = [];
    pushHorizontalGrid(positions, normals, indices, xs, zs, WATER_LEVEL);
    this.setGeometry(this.waterGeometry, positions, normals, indices);
    for (const curtain of this.waterCurtains) {
      this.setGeometry(curtain.geometry, [], [], []);
    }
    this.rebuildTriangleGeometry([{ positions, normals, indices }]);
  }

  private buildFloatingSquareGeometry(): void {
    const overhang = getFloatingWaterOverhang();
    const x0 = -overhang;
    const z0 = -overhang;
    const x1 = this.mapWidth + overhang;
    const z1 = this.mapHeight + overhang;
    const topY = WATER_LEVEL;
    // Curtains reach the same authored overhang BELOW the land slab's floor
    // that the water extends past every terrain edge.
    const bottomY = getWaterBoxFloorY(this.mapWidth, this.mapHeight);
    const xs = gridBreakpoints(x0, x0, x1, x1, WATER_SURFACE_GRID_STEPS);
    const zs = gridBreakpoints(z0, z0, z1, z1, WATER_SURFACE_GRID_STEPS);
    // Use the surface grid's cell size so every panel added below carries the
    // same depth-interpolation error as the horizontal surface.
    const cell = Math.max(x1 - x0, z1 - z0) / WATER_SURFACE_GRID_STEPS;

    // THE INFO ANNEX'S ARM. The liquid footprint is the map rectangle plus
    // the annex's own, each grown by the SAME overhang: an L, not a bigger
    // rectangle. Widening one whole side of the sea out to meet the headland
    // would give that side a border several times every other side's; the L
    // gives the headland exactly the border the map has, at exactly the same
    // level, which is the whole point of attaching it. The arm stops at the
    // map's own liquid boundary — that part is already covered, and a second
    // coplanar sheet of translucent water over it reads as a darker patch.
    //
    // The arm follows the headland's SILHOUETTE, not its bounding box. Since
    // the annex gained cut corners those are very different shapes: a box
    // would leave a wedge of slack water in each cut corner and pinch the
    // border at each flare, which is the uneven padding this arm exists to
    // prevent. So it comes back as a stack of rows, each as wide as the
    // headland is at that distance out plus one overhang measured
    // perpendicular to whatever edge it is standing off.
    const annex = resolveMapInfoAnnexFootprint(this.mapWidth, this.mapHeight);
    const armRows = resolveMapInfoAnnexLiquidRows(annex, overhang, cell);
    const armExists = armRows.length >= 2
      && armRows.every((row) => row.halfWidth > 1e-6);
    const armRunsAlongX = annex.outX === 0;
    const armHalfWidth = armRows.reduce(
      (widest, row) => Math.max(widest, row.halfWidth),
      0,
    );
    const armColumns = Math.max(2, Math.ceil((2 * armHalfWidth) / Math.max(1e-3, cell)));
    const armPoint = (
      row: MapInfoAnnexRow,
      across: number,
    ): readonly [number, number] => [
      mapInfoAnnexRowPointX(annex, row, across),
      mapInfoAnnexRowPointZ(annex, row, across),
    ];

    const surface = {
      positions: [] as number[],
      normals: [] as number[],
      indices: [] as number[],
    };
    pushHorizontalGrid(
      surface.positions,
      surface.normals,
      surface.indices,
      xs,
      zs,
      topY,
    );
    if (armExists) {
      pushAnnexRowGrid(
        surface.positions,
        surface.normals,
        surface.indices,
        armPoint,
        armRows,
        armColumns,
        topY,
      );
    }
    this.setGeometry(
      this.waterGeometry,
      surface.positions,
      surface.normals,
      surface.indices,
    );

    // These overhanging curtains close the water box's outer perimeter, and
    // the bottom face below closes its floor, so the liquid is a complete
    // solid from every angle the camera can reach — including from under the
    // world, where the land slab's own floor cap now sits just inside it.
    //
    // Every strip is walked in the direction (-nz, nx) for its outward
    // normal (nx, nz): that is the walk pushCurtainStrip's winding agrees
    // with, so a face is never drawn inside out.
    const alongX = (
      values: readonly number[],
      z: number,
    ): ReadonlyArray<readonly [number, number]> =>
      values.map((x): readonly [number, number] => [x, z]);
    const alongZ = (
      values: readonly number[],
      x: number,
    ): ReadonlyArray<readonly [number, number]> =>
      values.map((z): readonly [number, number] => [x, z]);
    // Each strip carries its OWN outward normal now: the map's four sides are
    // still axis-aligned, but the arm's perimeter runs diagonally around the
    // headland's cut corners and no single normal per face would fit it.
    type CurtainStrip = {
      readonly points: ReadonlyArray<readonly [number, number]>;
      readonly nx: number;
      readonly nz: number;
    };
    const strips: Record<WaterBoxFace, CurtainStrip[]> = {
      north: [{ points: alongX(xs, z0), nx: 0, nz: -1 }],
      east: [{ points: alongZ(zs, x1), nx: 1, nz: 0 }],
      south: [{ points: alongX([...xs].reverse(), z1), nx: 0, nz: 1 }],
      west: [{ points: alongZ([...zs].reverse(), x0), nx: -1, nz: 0 }],
      bottom: [],
    };
    if (armExists) {
      // The map side the arm joins is OPENED over exactly the span the arm's
      // first row covers, and the arm's own perimeter closes it again further
      // out. The opening comes from that row rather than from a rectangle,
      // because the flare means the arm is at its widest right here.
      const seam = armRows[0];
      const seamLow = armPoint(seam, -1);
      const seamHigh = armPoint(seam, 1);
      if (armRunsAlongX) {
        const attached: WaterBoxFace = annex.outZ < 0 ? 'north' : 'south';
        const attachedZ = annex.outZ < 0 ? z0 : z1;
        const nz = annex.outZ < 0 ? -1 : 1;
        const order = (values: readonly number[]): readonly number[] =>
          annex.outZ < 0 ? values : [...values].reverse();
        const openLow = Math.min(seamLow[0], seamHigh[0]);
        const openHigh = Math.max(seamLow[0], seamHigh[0]);
        strips[attached] = [
          { points: alongX(order(clipBreakpoints(xs, x0, openLow)), attachedZ), nx: 0, nz },
          { points: alongX(order(clipBreakpoints(xs, openHigh, x1)), attachedZ), nx: 0, nz },
        ];
      } else {
        const attached: WaterBoxFace = annex.outX < 0 ? 'west' : 'east';
        const attachedX = annex.outX < 0 ? x0 : x1;
        const nx = annex.outX < 0 ? -1 : 1;
        const order = (values: readonly number[]): readonly number[] =>
          annex.outX > 0 ? values : [...values].reverse();
        const openLow = Math.min(seamLow[1], seamHigh[1]);
        const openHigh = Math.max(seamLow[1], seamHigh[1]);
        strips[attached] = [
          { points: alongZ(order(clipBreakpoints(zs, z0, openLow)), attachedX), nx, nz: 0 },
          { points: alongZ(order(clipBreakpoints(zs, openHigh, z1)), attachedX), nx, nz: 0 },
        ];
      }

      // ONE walk around the arm's perimeter: up the low-across flank, across
      // the far rim, back down the high-across flank. Those directions are
      // what put each segment's derived normal on the outside, exactly as
      // they do for the annex's own walls. Each segment is emitted on its own
      // so it can carry that normal — a shared vertex could only hold one,
      // and a headland with cut corners wants the hard edge anyway.
      const perimeter: Array<readonly [number, number]> = [];
      for (const row of armRows) perimeter.push(armPoint(row, -1));
      const rim = armRows[armRows.length - 1];
      for (let column = 1; column < armColumns; column++) {
        perimeter.push(armPoint(rim, (column / armColumns) * 2 - 1));
      }
      for (let index = armRows.length - 1; index >= 0; index--) {
        perimeter.push(armPoint(armRows[index], 1));
      }
      for (let index = 0; index < perimeter.length - 1; index++) {
        const from = perimeter[index];
        const to = perimeter[index + 1];
        const dx = to[0] - from[0];
        const dz = to[1] - from[1];
        const span = Math.hypot(dx, dz);
        if (span < 1e-6) continue;
        const nx = dz / span;
        const nz = -dx / span;
        // Sorted with whichever face it most nearly belongs to, so the
        // transparent draw order still runs by direction.
        const face: WaterBoxFace = Math.abs(nx) >= Math.abs(nz)
          ? (nx >= 0 ? 'east' : 'west')
          : (nz >= 0 ? 'south' : 'north');
        strips[face].push({ points: [from, to], nx, nz });
      }
    }

    const triangleParts = [surface];
    for (let i = 0; i < WATER_BOX_FACES.length; i++) {
      const direction = WATER_BOX_FACES[i];
      const part = {
        positions: [] as number[],
        normals: [] as number[],
        indices: [] as number[],
      };
      if (direction === 'bottom') {
        // The floor is the surface's own footprint at the box's floor, so it
        // shares the curtains' bottom edge with no T-junctions and carries the
        // same depth-interpolation error as every other face.
        pushHorizontalGrid(
          part.positions,
          part.normals,
          part.indices,
          xs,
          zs,
          bottomY,
          -1,
        );
        if (armExists) {
          pushAnnexRowGrid(
            part.positions,
            part.normals,
            part.indices,
            armPoint,
            armRows,
            armColumns,
            bottomY,
            -1,
          );
        }
      } else {
        for (const strip of strips[direction]) {
          if (strip.points.length < 2) continue;
          pushCurtainStrip(
            part.positions,
            part.normals,
            part.indices,
            strip.points,
            bottomY,
            topY,
            strip.nx,
            strip.nz,
            cell,
          );
        }
      }
      const curtain = this.waterCurtains[i];
      if (curtain.direction !== direction) {
        throw new Error(`Water box face order mismatch: ${curtain.direction}/${direction}`);
      }
      this.setGeometry(curtain.geometry, part.positions, part.normals, part.indices);
      triangleParts.push(part);
    }
    this.rebuildTriangleGeometry(triangleParts);
  }

  private setGeometry(
    geometry: THREE.BufferGeometry,
    positions: number[],
    normals: number[],
    indices: number[],
  ): void {
    geometry.dispose();
    geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array(positions), 3),
    );
    geometry.setAttribute(
      'normal',
      new THREE.BufferAttribute(new Float32Array(normals), 3),
    );
    const uvs = new Float32Array((positions.length / 3) * 2);
    for (let vertex = 0; vertex < positions.length / 3; vertex++) {
      uvs[vertex * 2] = positions[vertex * 3] / this.liquidTextureTileWorldSize;
      uvs[vertex * 2 + 1] = positions[vertex * 3 + 2] / this.liquidTextureTileWorldSize;
    }
    geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geometry.setIndex(
      new THREE.BufferAttribute(new Uint16Array(indices), 1),
    );
    geometry.computeBoundingSphere();
  }

  private rebuildTriangleGeometry(
    parts: ReadonlyArray<{
      readonly positions: readonly number[];
      readonly normals: readonly number[];
      readonly indices: readonly number[];
    }>,
  ): void {
    const positions: number[] = [];
    const normals: number[] = [];
    const indices: number[] = [];
    for (const part of parts) {
      const base = positions.length / 3;
      positions.push(...part.positions);
      normals.push(...part.normals);
      for (const index of part.indices) indices.push(base + index);
    }
    const combined = new THREE.BufferGeometry();
    this.setGeometry(combined, positions, normals, indices);
    this.waterTriangleGeometry.dispose();
    this.waterTriangleGeometry = new THREE.WireframeGeometry(combined);
    this.waterTriangleLines.geometry = this.waterTriangleGeometry;
    combined.dispose();
  }

  private buildGeometry(mode: WaterBoundaryMode): void {
    if (mode === 'infinity') {
      this.buildInfinityGeometry();
    } else {
      this.buildFloatingSquareGeometry();
    }
    this.built = true;
    this.lastWaterBoundaryMode = mode;
  }

  /** Integrate three continuous downstream offsets. Each layer smoothly
   * wanders between pseudo-random headings around the current wind bearing on
   * its own prime-number interval, keeping coherent flow without a repeating
   * conveyor weave. Integrating displacement avoids UV jumps when wind turns. */
  private advanceLiquidFlow(dtSec: number, wind: LiquidFlowWind | undefined): void {
    if (!Number.isFinite(dtSec) || dtSec <= 0) return;
    this.liquidFlowElapsedSeconds += dtSec;
    // Keep the fragment uniform in a precision-friendly range while the CPU
    // heading clock remains continuous across long matches.
    this.liquidTimeUniform.value = this.liquidFlowElapsedSeconds % 10_000;
    const windX = Number.isFinite(wind?.x) ? wind!.x : 0;
    const windZ = Number.isFinite(wind?.y) ? wind!.y : 0;
    const horizontalSpeed = Math.hypot(windX, windZ);
    if (horizontalSpeed <= 1e-6) return;

    const directionX = windX / horizontalSpeed;
    const directionZ = windZ / horizontalSpeed;
    const config = this.liquidFlowConfig;
    for (let layer = 0; layer < this.liquidFlowOffsetUniforms.length; layer++) {
      const angle = liquidFlowHeadingWiggle(
        this.liquidFlowElapsedSeconds,
        config.wigglePeriodsSeconds[layer],
        LIQUID_FLOW_LAYER_RANDOM_SEEDS[layer],
      ) * config.directionWiggleRadians;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const layerDirectionX = directionX * cos - directionZ * sin;
      const layerDirectionZ = directionX * sin + directionZ * cos;
      // The shader samples UV * layerScale. Scale the offset by the same
      // amount so a world-space feature travels at the authored speed on
      // every frequency layer.
      const sampleUvPerSecond =
        config.flowWorldUnitsPerSecond
        * config.layerSpeedMultipliers[layer]
        * config.layerScales[layer]
        / config.tileWorldSize;
      const offset = this.liquidFlowOffsetUniforms[layer].value;
      offset.set(
        wrapRepeat(offset.x + layerDirectionX * sampleUvPerSecond * dtSec),
        wrapRepeat(offset.y + layerDirectionZ * sampleUvPerSecond * dtSec),
      );
    }
  }

  update(
    dtSec: number,
    _graphicsConfig: GraphicsConfig,
    _frameState?: RenderFrameState3D,
    wind?: LiquidFlowWind,
  ): void {
    const liquidSurfaceMode = getLiquidSurfaceMode();
    if (liquidSurfaceMode !== this.lastLiquidSurfaceMode) {
      if (liquidSurfaceMode === 'none') {
        this.clearLiquidGeometry();
      } else {
        this.configureLiquidMaterial(liquidSurfaceMode);
      }
      this.lastLiquidSurfaceMode = liquidSurfaceMode;
    }
    if (liquidSurfaceMode === 'none') {
      this.setVisible(false);
      this.setTriangleDebugVisible(false);
      return;
    }

    const opacity = liquidSurfaceMode === 'lava' || WATER_FULLY_OPAQUE
      ? 1
      : WATER_RENDER_CONFIG.opacity;
    if (opacity <= 0) {
      this.setVisible(false);
      this.setTriangleDebugVisible(false);
      return;
    }
    const waterBoundaryMode = getWaterBoundaryMode();
    if (!this.built || this.lastWaterBoundaryMode !== waterBoundaryMode) {
      this.buildGeometry(waterBoundaryMode);
    }
    if (this.lastOpacity !== opacity) {
      this.waterMaterial.opacity = opacity;
      this.waterCurtainMaterial.opacity = opacity;
      this.lastOpacity = opacity;
    }
    this.advanceLiquidFlow(dtSec, wind);
    this.setVisible(true);
    this.setTriangleDebugVisible(getWaterTriangleDebug());
  }

  private setVisible(visible: boolean): void {
    if (this.lastVisible === visible) return;
    this.waterMesh.visible = visible;
    for (const curtain of this.waterCurtains) curtain.mesh.visible = visible;
    this.lastVisible = visible;
  }

  private setTriangleDebugVisible(visible: boolean): void {
    if (this.lastTriangleDebugVisible === visible) return;
    this.waterTriangleLines.visible = visible;
    this.lastTriangleDebugVisible = visible;
  }

  destroy(): void {
    this.waterMesh.parent?.remove(this.waterMesh);
    for (const curtain of this.waterCurtains) {
      curtain.mesh.parent?.remove(curtain.mesh);
      curtain.geometry.dispose();
    }
    this.waterCurtains.length = 0;
    this.waterTriangleLines.parent?.remove(this.waterTriangleLines);
    this.waterGeometry.dispose();
    this.waterMaterial.dispose();
    this.waterCurtainMaterial.dispose();
    this.liquidTexture.dispose();
    this.waterTriangleGeometry.dispose();
    this.waterTriangleMaterial.dispose();
  }
}

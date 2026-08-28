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
/** The lava surface colour in the renderer's linear working space, scaled past
 *  the display range so tone mapping treats it as an emitter. */
function lavaSurfaceColor(): THREE.Color {
  return new THREE.Color(LAVA_RENDER_CONFIG.color)
    .multiplyScalar(Math.max(0, LAVA_RENDER_CONFIG.emissiveScale));
}

const WATER_TRIANGLE_DEBUG_COLOR = 0xfff17a;
const WATER_TRIANGLE_DEBUG_OPACITY = 0.95;

/** Lava is not a translated decal. Two scales of the seamless crust field
 * counter-flow through one another, warping and exposing hot fissures while
 * the larger plates remain dark. MeshBasicMaterial still supplies the scene's
 * ordinary fog/tone-mapping path; this only replaces its stock map multiply. */
const LAVA_MAP_FRAGMENT = `
#ifdef USE_MAP
  vec2 lavaFlow = uLavaFlowUvPerSecond * uLavaTime;
  vec3 lavaPrimary = texture2D(map, vMapUv + lavaFlow).rgb;
  vec2 lavaWarp = (lavaPrimary.gb - vec2(0.5)) * 0.075;
  vec3 lavaSecondary = texture2D(
    map,
    vMapUv * 1.83 - lavaFlow * 0.71 + lavaWarp
  ).rgb;
  vec3 lavaTertiary = texture2D(
    map,
    vMapUv * 0.53 + lavaFlow * vec2(-0.19, 0.31) - lavaWarp * 0.45
  ).rgb;
  float lavaFissure = max(
    lavaPrimary.r,
    max(lavaSecondary.r * 0.78, lavaTertiary.r * 0.62)
  );
  float lavaCore = max(lavaPrimary.g, lavaSecondary.g * 0.86);
  float lavaPulse = 0.88 + 0.12 * sin(
    uLavaTime * 1.15 + lavaTertiary.b * 6.2831853
  );
  vec3 lavaMultiplier = mix(
    vec3(0.055, 0.032, 0.022),
    vec3(0.92, 0.44, 0.08),
    smoothstep(0.08, 0.72, lavaFissure)
  );
  lavaMultiplier = mix(
    lavaMultiplier,
    vec3(1.08, 1.72, 0.48),
    smoothstep(0.58, 0.98, lavaCore) * lavaPulse
  );
  diffuseColor.rgb *= lavaMultiplier;
#endif
`;

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
  private liquidTextureScrollUvPerSecond: THREE.Vector2;
  private readonly lavaTimeUniform = { value: 0 };
  private readonly lavaFlowUvPerSecondUniform = { value: new THREE.Vector2() };
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
    // for counter-flowing crust. LIQUID = NONE keeps this stable mesh object
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
    this.liquidTextureScrollUvPerSecond = new THREE.Vector2(
      textureConfig.scrollWorldUnitsPerSecondX / textureConfig.tileWorldSize,
      textureConfig.scrollWorldUnitsPerSecondZ / textureConfig.tileWorldSize,
    );
    this.lavaFlowUvPerSecondUniform.value.copy(this.liquidTextureScrollUvPerSecond);
    this.waterMaterial = new THREE.MeshBasicMaterial({
      color: lava ? lavaSurfaceColor() : WATER_RENDER_CONFIG.color,
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
    this.configureSurfaceShader(lava);
    this.waterCurtainMaterial = this.waterMaterial.clone();
    // Flow grain belongs to the horizontal skin. Stretching it down the
    // render-only world-box curtains would turn every wave into a long stripe.
    this.waterCurtainMaterial.map = null;
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

  private configureSurfaceShader(lava: boolean): void {
    if (!lava) {
      this.waterMaterial.onBeforeCompile = () => {};
      this.waterMaterial.customProgramCacheKey = () => 'water-surface-v1';
      this.waterMaterial.userData.liquidSurfaceShader = 'water';
      this.waterMaterial.needsUpdate = true;
      return;
    }
    this.waterMaterial.onBeforeCompile = (shader): void => {
      shader.uniforms.uLavaTime = this.lavaTimeUniform;
      shader.uniforms.uLavaFlowUvPerSecond = this.lavaFlowUvPerSecondUniform;
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <map_pars_fragment>',
          '#include <map_pars_fragment>\nuniform float uLavaTime;\nuniform vec2 uLavaFlowUvPerSecond;',
        )
        .replace('#include <map_fragment>', LAVA_MAP_FRAGMENT);
    };
    this.waterMaterial.customProgramCacheKey = () => 'lava-surface-flow-v2';
    this.waterMaterial.userData.liquidSurfaceShader = 'lava-flow-v2';
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
    this.liquidTextureScrollUvPerSecond.set(
      textureConfig.scrollWorldUnitsPerSecondX / textureConfig.tileWorldSize,
      textureConfig.scrollWorldUnitsPerSecondZ / textureConfig.tileWorldSize,
    );
    this.lavaFlowUvPerSecondUniform.value.copy(this.liquidTextureScrollUvPerSecond);
    this.lavaTimeUniform.value = 0;

    this.waterMaterial.color.copy(
      lava ? lavaSurfaceColor() : new THREE.Color(WATER_RENDER_CONFIG.color),
    );
    this.waterMaterial.map = this.liquidTexture;
    this.waterMaterial.transparent = !lava && !WATER_FULLY_OPAQUE;
    this.waterMaterial.opacity = lava || WATER_FULLY_OPAQUE
      ? 1
      : WATER_RENDER_CONFIG.opacity;
    this.configureSurfaceShader(lava);

    this.waterCurtainMaterial.color.copy(this.waterMaterial.color);
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

  update(
    dtSec: number,
    _graphicsConfig: GraphicsConfig,
    _frameState?: RenderFrameState3D,
    _sharedRenderGrid?: unknown,
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
    if (Number.isFinite(dtSec) && dtSec > 0) {
      if (liquidSurfaceMode === 'lava') {
        this.lavaTimeUniform.value = (this.lavaTimeUniform.value + dtSec) % 10_000;
      } else {
        this.liquidTexture.offset.x = (
          this.liquidTexture.offset.x + this.liquidTextureScrollUvPerSecond.x * dtSec
        ) % 1;
        this.liquidTexture.offset.y = (
          this.liquidTexture.offset.y + this.liquidTextureScrollUvPerSecond.y * dtSec
        ) % 1;
      }
    }
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

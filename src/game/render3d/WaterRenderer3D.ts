// WaterRenderer3D — transparent water surface at WATER_LEVEL with four
// independently sorted open-bottom perimeter curtains in floating-square
// modes.
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
import { isLavaLiquidSurface } from '../sim/worldSurfaceState';
import type { GraphicsConfig } from '@/types/graphics';
import type { RenderFrameState3D } from './RenderFrameState3D';
import { TRANSPARENT_RENDER_ORDER_3D } from './TransparentRenderOrder3D';
import { getFloatingWaterOverhang, getWaterBoxFloorY } from './WorldBoxGeometry3D';

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

/** Emits one horizontal indexed grid at height `y` over xs × zs. */
function pushHorizontalGrid(
  positions: number[],
  normals: number[],
  indices: number[],
  xs: readonly number[],
  zs: readonly number[],
  y: number,
): void {
  const base = positions.length / 3;
  for (const z of zs) {
    for (const x of xs) {
      positions.push(x, y, z);
      normals.push(0, 1, 0);
    }
  }
  const cols = xs.length;
  for (let j = 0; j < zs.length - 1; j++) {
    for (let i = 0; i < cols - 1; i++) {
      const a = base + j * cols + i;
      const b = a + 1;
      const c = b + cols;
      const d = a + cols;
      indices.push(a, b, c, a, c, d);
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

export class WaterRenderer3D {
  private waterMesh: THREE.Mesh;
  private waterGeometry: THREE.BufferGeometry;
  /** Four independent transparent objects so Three.js can sort the world-box
   *  faces back-to-front. Keeping them in the surface mesh made triangle
   *  insertion order decide which opposite face won the depth test. */
  private waterCurtains: Array<{
    readonly direction: 'north' | 'east' | 'south' | 'west';
    readonly mesh: THREE.Mesh;
    readonly geometry: THREE.BufferGeometry;
  }> = [];
  private waterMaterial: THREE.MeshBasicMaterial;
  private waterCurtainMaterial: THREE.MeshBasicMaterial;
  private waterTriangleLines: THREE.LineSegments;
  private waterTriangleGeometry: THREE.BufferGeometry;
  private waterTriangleMaterial: THREE.LineBasicMaterial;
  private mapWidth: number;
  private mapHeight: number;
  private built = false;
  private lastVisible = true;
  private lastTriangleDebugVisible = false;
  private lastOpacity = Number.NaN;
  private lastWaterBoundaryMode: WaterBoundaryMode | null = null;

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
    // LIQUID = LAVA swaps the surface for opaque molten rock. Same
    // MeshBasicMaterial (unlit, still tone mapped), but the colour is scaled
    // past 1.0 so ACES renders it as an emitter rather than as red paint.
    const lava = isLavaLiquidSurface();
    this.waterMaterial = new THREE.MeshBasicMaterial({
      color: lava ? lavaSurfaceColor() : WATER_RENDER_CONFIG.color,
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
    this.waterCurtainMaterial = this.waterMaterial.clone();
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

    this.waterMesh = new THREE.Mesh(this.waterGeometry, this.waterMaterial);
    this.waterMesh.name = 'WaterSurface';
    this.waterMesh.renderOrder = TRANSPARENT_RENDER_ORDER_3D.waterSurface;
    this.waterMesh.frustumCulled = false;
    this.lastVisible = this.waterMesh.visible;
    parent.add(this.waterMesh);

    for (const direction of ['north', 'east', 'south', 'west'] as const) {
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
    // mode, four independently sorted perimeter curtain meshes. Keep its debug
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
   *  picking. The independently sorted vertical curtains are intentionally
   *  excluded, and camera anchors use terrain only. The mesh object is stable
   *  when geometry is rebuilt for a different boundary presentation mode. */
  getMesh(): THREE.Mesh {
    return this.waterMesh;
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
    this.setGeometry(
      this.waterGeometry,
      surface.positions,
      surface.normals,
      surface.indices,
    );

    // The map is an open-bottom slab. These four overhanging water curtains
    // close its visible outer perimeter; an unseen horizontal bottom would
    // only add fill and triangles.
    const north = xs.map((x): readonly [number, number] => [x, z0]);
    const east = zs.map((z): readonly [number, number] => [x1, z]);
    const south = [...xs].reverse().map((x): readonly [number, number] => [x, z1]);
    const west = [...zs].reverse().map((z): readonly [number, number] => [x0, z]);
    // Use the surface grid's cell size so the independently sorted curtains
    // carry the same depth-interpolation error as the horizontal surface.
    const cell = Math.max(x1 - x0, z1 - z0) / WATER_SURFACE_GRID_STEPS;
    const curtainInputs = [
      { direction: 'north', points: north, nx: 0, nz: -1 },
      { direction: 'east', points: east, nx: 1, nz: 0 },
      { direction: 'south', points: south, nx: 0, nz: 1 },
      { direction: 'west', points: west, nx: -1, nz: 0 },
    ] as const;
    const triangleParts = [surface];
    for (let i = 0; i < curtainInputs.length; i++) {
      const input = curtainInputs[i];
      const part = {
        positions: [] as number[],
        normals: [] as number[],
        indices: [] as number[],
      };
      pushCurtainStrip(
        part.positions,
        part.normals,
        part.indices,
        input.points,
        bottomY,
        topY,
        input.nx,
        input.nz,
        cell,
      );
      const curtain = this.waterCurtains[i];
      if (curtain.direction !== input.direction) {
        throw new Error(`Water curtain order mismatch: ${curtain.direction}/${input.direction}`);
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
    _dtSec: number,
    _graphicsConfig: GraphicsConfig,
    _frameState?: RenderFrameState3D,
    _sharedRenderGrid?: unknown,
  ): void {
    const opacity = isLavaLiquidSurface() || WATER_FULLY_OPAQUE
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
    this.waterTriangleGeometry.dispose();
    this.waterTriangleMaterial.dispose();
  }
}

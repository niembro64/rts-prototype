// CaptureTileRenderer3D — static terrain mesh + tiny capture-overlay texture.
//
// The old path used one vertex-coloured mesh for both terrain and capture
// ownership. Every capture update could touch a large vertex color buffer.
// This renderer splits the responsibilities:
//   - terrainMesh: static lit geometry, rebuilt only for map/cell/LOD changes
//   - overlayMesh: top surface only, transparent, sampled from a cellsX*cellsY
//     DataTexture. Dynamic ownership updates modify a few bytes per tile and
//     upload a tiny texture instead of a terrain-sized color buffer.

import * as THREE from 'three';
import type { ClientViewState } from '../network/ClientViewState';
import { getGraphicsConfigFor, getGridOverlay, getGridOverlayIntensity } from '@/clientBarConfig';
import type { GraphicsConfig } from '@/types/graphics';
import type { NetworkCaptureTile } from '@/types/capture';
import { MANA_TILE_SIZE, MANA_TILE_TEXTURE, MAP_BG_COLOR } from '../../config';
import { getTerrainHeight, TERRAIN_MESH_SUBDIV, TILE_FLOOR_Y } from '../sim/Terrain';
import { getCaptureTileDisplayColor } from '../sim/manaProduction';
import { objectLodToCameraSphereGraphicsTier } from './RenderObjectLod';
import type { RenderLodGrid } from './RenderLodGrid';

const CUBE_FLOOR_Y = TILE_FLOOR_Y;
const OVERLAY_Y_OFFSET = 1.5;

const NEUTRAL_R_BYTE = (MAP_BG_COLOR >> 16) & 0xff;
const NEUTRAL_G_BYTE = (MAP_BG_COLOR >> 8) & 0xff;
const NEUTRAL_B_BYTE = MAP_BG_COLOR & 0xff;
const NEUTRAL_COLOR = new THREE.Color(MAP_BG_COLOR);
const WHITE_COLOR = new THREE.Color(0xffffff);

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function clampSigned(v: number): number {
  return Math.max(-1, Math.min(1, v));
}

function softSignedWave(v: number, power: number): number {
  const clamped = clampSigned(v);
  const magnitude = Math.pow(Math.abs(clamped), Math.max(0.25, power));
  return clamped < 0 ? -magnitude : magnitude;
}

function lerpColorChannel(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function pushManaTerrainColor(
  out: number[],
  wx: number,
  wz: number,
  verticalShade = 1,
): void {
  // Seam-safe procedural texture: color is a pure function of world
  // coordinates, not tile id. Adjacent mana tiles duplicate edge/corner
  // vertices, but those duplicate vertices now resolve identical colors
  // and triangle interpolation lines up across shared boundaries.
  const xWaves =
    Math.sin(wx * MANA_TILE_TEXTURE.xWaves[0].scale + MANA_TILE_TEXTURE.xWaves[0].phase) * MANA_TILE_TEXTURE.xWaves[0].amplitude +
    Math.sin(wx * MANA_TILE_TEXTURE.xWaves[1].scale + MANA_TILE_TEXTURE.xWaves[1].phase) * MANA_TILE_TEXTURE.xWaves[1].amplitude;
  const zWaves =
    Math.sin(wz * MANA_TILE_TEXTURE.zWaves[0].scale + MANA_TILE_TEXTURE.zWaves[0].phase) * MANA_TILE_TEXTURE.zWaves[0].amplitude +
    Math.sin(wz * MANA_TILE_TEXTURE.zWaves[1].scale + MANA_TILE_TEXTURE.zWaves[1].phase) * MANA_TILE_TEXTURE.zWaves[1].amplitude;
  const cross =
    Math.sin(
      (wx + wz) * MANA_TILE_TEXTURE.cross.scale +
      MANA_TILE_TEXTURE.cross.phase +
      xWaves * MANA_TILE_TEXTURE.cross.xInfluence +
      zWaves * MANA_TILE_TEXTURE.cross.zInfluence,
    );
  const fleckWave =
    Math.sin(wx * MANA_TILE_TEXTURE.fleck.xScale + MANA_TILE_TEXTURE.fleck.xPhase) *
    Math.sin(
      wz * (MANA_TILE_TEXTURE.fleck.xScale * MANA_TILE_TEXTURE.fleck.zScaleMultiplier) +
      MANA_TILE_TEXTURE.fleck.zPhase,
    );
  const fleck = softSignedWave(fleckWave, MANA_TILE_TEXTURE.fleck.power);
  const veinRaw = Math.sin(
    wx * MANA_TILE_TEXTURE.vein.xScale +
    wz * MANA_TILE_TEXTURE.vein.zScale +
    Math.sin(wx * MANA_TILE_TEXTURE.vein.xWarpScale) * MANA_TILE_TEXTURE.vein.xWarpAmplitude +
    Math.sin(wz * MANA_TILE_TEXTURE.vein.zWarpScale) * MANA_TILE_TEXTURE.vein.zWarpAmplitude,
  );
  const vein = softSignedWave(veinRaw, MANA_TILE_TEXTURE.vein.power);
  const signedTexture = clampSigned(
    xWaves * MANA_TILE_TEXTURE.base.xWaveAmplitude +
    zWaves * MANA_TILE_TEXTURE.base.zWaveAmplitude +
    cross * MANA_TILE_TEXTURE.cross.amplitude +
    fleck * MANA_TILE_TEXTURE.fleck.amplitude +
    vein * MANA_TILE_TEXTURE.vein.amplitude,
  );
  const brightness =
    MANA_TILE_TEXTURE.base.brightness +
    xWaves * MANA_TILE_TEXTURE.base.xWaveAmplitude +
    zWaves * MANA_TILE_TEXTURE.base.zWaveAmplitude +
    cross * MANA_TILE_TEXTURE.cross.amplitude +
    fleck * MANA_TILE_TEXTURE.fleck.amplitude;
  const baseR = clamp01(MANA_TILE_TEXTURE.base.color.r * brightness * verticalShade);
  const baseG = clamp01(MANA_TILE_TEXTURE.base.color.g * brightness * verticalShade);
  const baseB = clamp01(MANA_TILE_TEXTURE.base.color.b * brightness * verticalShade);
  const grayTone = clamp01(
    (MANA_TILE_TEXTURE.tone.neutral + signedTexture * MANA_TILE_TEXTURE.tone.contrast) *
    verticalShade,
  );
  const mix = clamp01(MANA_TILE_TEXTURE.tone.mix);

  out.push(
    clamp01(lerpColorChannel(baseR, grayTone, mix)),
    clamp01(lerpColorChannel(baseG, grayTone, mix)),
    clamp01(lerpColorChannel(baseB, grayTone, mix)),
  );
}

function captureOverlayOpacity(intensity: number): number {
  const t = clamp01(intensity);
  return MANA_TILE_TEXTURE.overlayOpacity.min +
    (MANA_TILE_TEXTURE.overlayOpacity.max - MANA_TILE_TEXTURE.overlayOpacity.min) * t;
}

function terrainColorDiffSq(colors: number[], ai: number, bi: number): number {
  const a = ai * 3;
  const b = bi * 3;
  const dr = colors[a] - colors[b];
  const dg = colors[a + 1] - colors[b + 1];
  const db = colors[a + 2] - colors[b + 2];
  return dr * dr + dg * dg + db * db;
}

export class CaptureTileRenderer3D {
  private terrainMesh: THREE.Mesh;
  private terrainGeometry: THREE.BufferGeometry;
  private terrainMaterial: THREE.MeshLambertMaterial;

  private overlayMesh: THREE.Mesh;
  private overlayGeometry: THREE.BufferGeometry;
  private overlayMaterial: THREE.MeshBasicMaterial;
  private overlayTexture: THREE.DataTexture;
  private overlayPixels = new Uint8Array(4);

  private gridCellsX = 0;
  private gridCellsY = 0;
  private gridCellSize = 0;
  private terrainLodKey = '';
  private tileSubdivisions = new Uint8Array(0);
  private tileSideWalls = new Uint8Array(0);
  private horizontalEdgeSubdivisions = new Uint8Array(0);
  private verticalEdgeSubdivisions = new Uint8Array(0);
  private renderFrameIndex = 0;
  private lastCaptureVersion = -1;
  private lastOverlayIntensity = -1;
  private terrainTextureActive = false;

  private clientViewState: ClientViewState;
  private mapWidth: number;
  private mapHeight: number;

  constructor(
    parentWorld: THREE.Group,
    clientViewState: ClientViewState,
    mapWidth: number,
    mapHeight: number,
  ) {
    this.clientViewState = clientViewState;
    this.mapWidth = mapWidth;
    this.mapHeight = mapHeight;

    this.terrainGeometry = new THREE.BufferGeometry();
    this.terrainMaterial = new THREE.MeshLambertMaterial({
      color: NEUTRAL_COLOR,
      side: THREE.DoubleSide,
      vertexColors: false,
    });
    this.terrainMesh = new THREE.Mesh(this.terrainGeometry, this.terrainMaterial);
    this.terrainMesh.frustumCulled = false;
    this.terrainMesh.visible = false;
    parentWorld.add(this.terrainMesh);

    this.overlayTexture = this.makeOverlayTexture(1, 1);
    this.overlayGeometry = new THREE.BufferGeometry();
    this.overlayMaterial = new THREE.MeshBasicMaterial({
      map: this.overlayTexture,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
    this.overlayMesh = new THREE.Mesh(this.overlayGeometry, this.overlayMaterial);
    this.overlayMesh.frustumCulled = false;
    this.overlayMesh.visible = false;
    parentWorld.add(this.overlayMesh);
  }

  private makeOverlayTexture(width: number, height: number): THREE.DataTexture {
    this.overlayPixels = new Uint8Array(Math.max(1, width * height * 4));
    const texture = new THREE.DataTexture(
      this.overlayPixels,
      Math.max(1, width),
      Math.max(1, height),
      THREE.RGBAFormat,
    );
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestFilter;
    texture.generateMipmaps = false;
    texture.flipY = false;
    texture.needsUpdate = true;
    return texture;
  }

  private ensureOverlayTexture(width: number, height: number): boolean {
    if (
      this.overlayTexture.image.width === width &&
      this.overlayTexture.image.height === height
    ) {
      return false;
    }
    const old = this.overlayTexture;
    this.overlayTexture = this.makeOverlayTexture(width, height);
    this.overlayMaterial.map = this.overlayTexture;
    this.overlayMaterial.needsUpdate = true;
    old.dispose();
    this.lastCaptureVersion = -1;
    this.lastOverlayIntensity = -1;
    return true;
  }

  private rebuildGeometryIfNeeded(
    cellSize: number,
    graphicsConfig: GraphicsConfig,
    terrainTextureEnabled: boolean,
    sharedLodGrid?: RenderLodGrid,
  ): boolean {
    const cellsX = Math.max(1, Math.ceil(this.mapWidth / cellSize));
    const cellsY = Math.max(1, Math.ceil(this.mapHeight / cellSize));
    const tileCount = cellsX * cellsY;
    if (this.tileSubdivisions.length !== tileCount) {
      this.tileSubdivisions = new Uint8Array(tileCount);
      this.tileSideWalls = new Uint8Array(tileCount);
    }
    const horizontalEdgeCount = cellsX * (cellsY + 1);
    if (this.horizontalEdgeSubdivisions.length !== horizontalEdgeCount) {
      this.horizontalEdgeSubdivisions = new Uint8Array(horizontalEdgeCount);
    }
    const verticalEdgeCount = (cellsX + 1) * cellsY;
    if (this.verticalEdgeSubdivisions.length !== verticalEdgeCount) {
      this.verticalEdgeSubdivisions = new Uint8Array(verticalEdgeCount);
    }
    const tileSubdivisions = this.tileSubdivisions;
    const tileSideWalls = this.tileSideWalls;
    const horizontalEdgeSubdivisions = this.horizontalEdgeSubdivisions;
    const verticalEdgeSubdivisions = this.verticalEdgeSubdivisions;
    let lodHash = 2166136261;
    // Height-variation threshold (in world units) above which a tile is
    // treated as "steep" and forced to TERRAIN_MESH_SUBDIV regardless
    // of its camera-based LOD tier. Two reasons this is a flat-tile
    // safety net rather than a smooth scaling:
    //   1. Steep tiles need the regular subdiv x subdiv grid to
    //      accurately capture cliff faces — the irregular path's
    //      inner-grid + skirt approximation is much coarser than the
    //      regular grid for the same tileSubdiv (e.g. at subdiv=3 the
    //      irregular path produces 1 inner quad vs the regular path's
    //      9). On flat ground that gap is invisible; on a cliff it's
    //      a visibly different mesh between regular and irregular
    //      neighbors at the SAME LOD tier.
    //   2. Steepness is computed from samples taken at world coords
    //      shared between every tile touching the steep area
    //      (corners, edge midpoints, center). Both sides of any steep
    //      seam see the same sample heights, so they detect the same
    //      "this is steep" and bump together — adjacent steep tiles
    //      always end up at matching subdivs.
    // Tuned for typical map heights (TERRAIN_MAX_RENDER_Y = 1600 wu);
    // 30 wu of corner-to-corner spread comfortably catches cliff and
    // ridge tiles while leaving gentle terrain at its proposed LOD.
    const STEEP_TILE_HEIGHT_THRESHOLD = 30;

    for (let cy = 0; cy < cellsY; cy++) {
      for (let cx = 0; cx < cellsX; cx++) {
        let tileGfx = graphicsConfig;
        if (sharedLodGrid) {
          const x = (cx + 0.5) * cellSize;
          const z = (cy + 0.5) * cellSize;
          // Bucket the LOD lookup at y=0 so two horizontally adjacent
          // tiles whose terrain heights happen to straddle a Y LOD-cell
          // boundary still resolve to the SAME LOD cell — and therefore
          // the same tier. Using the tile's actual terrain Y here
          // produced visible LOD mismatches on the rare tile pairs
          // where one center sat just under and the other just over a
          // vertical cell edge. Mana tile fidelity is a horizontal
          // decision; binning by terrain height was an accidental
          // coupling.
          const tier = objectLodToCameraSphereGraphicsTier(sharedLodGrid.resolve(x, 0, z));
          tileGfx = getGraphicsConfigFor(tier);
        }
        let subdiv = tileGfx.captureTileSubdiv | 0;
        subdiv = Math.max(1, Math.min(TERRAIN_MESH_SUBDIV, subdiv));

        // Steep-tile bump. Sample 9 heights in a 3x3 grid (corners,
        // edge midpoints, center). All sample points are at world
        // coords any neighboring tile that touches them will also
        // sample, so the comparison is symmetric — both sides of a
        // steep seam reach the same conclusion and bump together.
        if (subdiv < TERRAIN_MESH_SUBDIV) {
          const x0w = cx * cellSize;
          const x1w = x0w + cellSize;
          const xCw = x0w + cellSize * 0.5;
          const z0w = cy * cellSize;
          const z1w = z0w + cellSize;
          const zCw = z0w + cellSize * 0.5;
          const h00 = getTerrainHeight(x0w, z0w, this.mapWidth, this.mapHeight);
          const h10 = getTerrainHeight(x1w, z0w, this.mapWidth, this.mapHeight);
          const h11 = getTerrainHeight(x1w, z1w, this.mapWidth, this.mapHeight);
          const h01 = getTerrainHeight(x0w, z1w, this.mapWidth, this.mapHeight);
          const hN  = getTerrainHeight(xCw, z0w, this.mapWidth, this.mapHeight);
          const hS  = getTerrainHeight(xCw, z1w, this.mapWidth, this.mapHeight);
          const hE  = getTerrainHeight(x1w, zCw, this.mapWidth, this.mapHeight);
          const hW  = getTerrainHeight(x0w, zCw, this.mapWidth, this.mapHeight);
          const hC  = getTerrainHeight(xCw, zCw, this.mapWidth, this.mapHeight);
          const hMin = Math.min(h00, h10, h11, h01, hN, hS, hE, hW, hC);
          const hMax = Math.max(h00, h10, h11, h01, hN, hS, hE, hW, hC);
          if (hMax - hMin > STEEP_TILE_HEIGHT_THRESHOLD) {
            subdiv = TERRAIN_MESH_SUBDIV;
          }
        }

        const tileIdx = cy * cellsX + cx;
        tileSubdivisions[tileIdx] = subdiv;
        tileSideWalls[tileIdx] = tileGfx.captureTileSideWalls ? 1 : 0;
        lodHash = Math.imul(
          lodHash ^ (subdiv | (tileSideWalls[tileIdx] << 4)),
          16777619,
        ) >>> 0;
      }
    }

    // Canonical shared-edge resolution. Each tile reads these buffers
    // instead of independently asking its neighbor, so both sides of a
    // shared edge always emit the exact same vertex count.
    for (let ey = 0; ey <= cellsY; ey++) {
      for (let cx = 0; cx < cellsX; cx++) {
        const above = ey > 0 ? tileSubdivisions[(ey - 1) * cellsX + cx] : 0;
        const below = ey < cellsY ? tileSubdivisions[ey * cellsX + cx] : 0;
        horizontalEdgeSubdivisions[ey * cellsX + cx] = Math.max(above, below, 1);
      }
    }
    for (let cy = 0; cy < cellsY; cy++) {
      const rowOff = cy * (cellsX + 1);
      const tileRowOff = cy * cellsX;
      for (let ex = 0; ex <= cellsX; ex++) {
        const left = ex > 0 ? tileSubdivisions[tileRowOff + ex - 1] : 0;
        const right = ex < cellsX ? tileSubdivisions[tileRowOff + ex] : 0;
        verticalEdgeSubdivisions[rowOff + ex] = Math.max(left, right, 1);
      }
    }

    const nextTerrainLodKey = [
      graphicsConfig.tier,
      lodHash.toString(36),
      terrainTextureEnabled ? 'texture' : 'flat-color',
    ].join('|');
    const textureRebuilt = this.ensureOverlayTexture(cellsX, cellsY);

    if (
      !textureRebuilt &&
      cellsX === this.gridCellsX &&
      cellsY === this.gridCellsY &&
      cellSize === this.gridCellSize &&
      nextTerrainLodKey === this.terrainLodKey
    ) {
      return false;
    }

    this.gridCellsX = cellsX;
    this.gridCellsY = cellsY;
    this.gridCellSize = cellSize;
    this.terrainLodKey = nextTerrainLodKey;
    this.lastCaptureVersion = -1;

    const terrainPositions: number[] = [];
    const terrainNormals: number[] = [];
    const terrainColors: number[] = [];
    const terrainIndices: number[] = [];
    const overlayPositions: number[] = [];
    const overlayUvs: number[] = [];
    const overlayIndices: number[] = [];

    const eps = 1;
    for (let cy = 0; cy < cellsY; cy++) {
      for (let cx = 0; cx < cellsX; cx++) {
        const x0 = cx * cellSize;
        const z0 = cy * cellSize;
        const tileU = (cx + 0.5) / cellsX;
        const tileV = (cy + 0.5) / cellsY;
        const tileIdx = cy * cellsX + cx;
        const tileSubdiv = tileSubdivisions[tileIdx] || 1;
        const includeSideWalls = tileSideWalls[tileIdx] === 1;
        const terrainVertexBase = terrainPositions.length / 3;
        const overlayVertexBase = overlayPositions.length / 3;
        const topLocal: number[] = [];

        const addTopVertex = (fx: number, fz: number): number => {
          const wx = x0 + fx * cellSize;
          const wz = z0 + fz * cellSize;
          const h = getTerrainHeight(wx, wz, this.mapWidth, this.mapHeight);
          const localIndex = topLocal.length;
          topLocal.push(localIndex);
          terrainPositions.push(wx, h, wz);
          if (terrainTextureEnabled) pushManaTerrainColor(terrainColors, wx, wz);

          const hxp = getTerrainHeight(wx + eps, wz, this.mapWidth, this.mapHeight);
          const hxm = getTerrainHeight(wx - eps, wz, this.mapWidth, this.mapHeight);
          const hzp = getTerrainHeight(wx, wz + eps, this.mapWidth, this.mapHeight);
          const hzm = getTerrainHeight(wx, wz - eps, this.mapWidth, this.mapHeight);
          const dHdx = (hxp - hxm) / (2 * eps);
          const dHdz = (hzp - hzm) / (2 * eps);
          let nx = -dHdx, ny = 1, nz = -dHdz;
          const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
          nx /= len; ny /= len; nz /= len;
          terrainNormals.push(nx, ny, nz);

          overlayPositions.push(wx, h + OVERLAY_Y_OFFSET, wz);
          overlayUvs.push(tileU, tileV);
          return localIndex;
        };

        const addTopTri = (a: number, b: number, c: number): void => {
          terrainIndices.push(terrainVertexBase + a, terrainVertexBase + b, terrainVertexBase + c);
          overlayIndices.push(overlayVertexBase + a, overlayVertexBase + b, overlayVertexBase + c);
        };

        const addBoundaryLoop = (
          northSubdiv: number,
          eastSubdiv: number,
          southSubdiv: number,
          westSubdiv: number,
        ): number[] => {
          const loop: number[] = [];
          const push = (fx: number, fz: number): number => {
            const idx = addTopVertex(fx, fz);
            loop.push(idx);
            return idx;
          };

          for (let i = 0; i < northSubdiv; i++) {
            edgeNorth.push(push(i / northSubdiv, 0));
          }
          for (let i = 0; i < eastSubdiv; i++) {
            const idx = push(1, i / eastSubdiv);
            if (i === 0) edgeNorth.push(idx);
            edgeEast.push(idx);
          }
          for (let i = southSubdiv; i > 0; i--) {
            const idx = push(i / southSubdiv, 1);
            if (i === southSubdiv) edgeEast.push(idx);
            edgeSouth.push(idx);
          }
          for (let i = westSubdiv; i > 0; i--) {
            const idx = push(0, i / westSubdiv);
            if (i === westSubdiv) edgeSouth.push(idx);
            edgeWest.push(idx);
          }
          edgeWest.push(loop[0]);
          return loop;
        };

        const addFanToCenter = (loop: readonly number[]): void => {
          const center = addTopVertex(0.5, 0.5);
          for (let i = 0; i < loop.length; i++) {
            addTopTri(center, loop[i], loop[(i + 1) % loop.length]);
          }
        };

        const addFanFromFirstBoundaryVertex = (loop: readonly number[]): void => {
          for (let i = 1; i < loop.length - 1; i++) {
            addTopTri(loop[0], loop[i], loop[i + 1]);
          }
        };

        let edgeNorth: number[] = [];
        let edgeEast: number[] = [];
        let edgeSouth: number[] = [];
        let edgeWest: number[] = [];

        const northSubdiv = horizontalEdgeSubdivisions[cy * cellsX + cx] || tileSubdiv;
        const eastSubdiv = verticalEdgeSubdivisions[cy * (cellsX + 1) + cx + 1] || tileSubdiv;
        const southSubdiv = horizontalEdgeSubdivisions[(cy + 1) * cellsX + cx] || tileSubdiv;
        const westSubdiv = verticalEdgeSubdivisions[cy * (cellsX + 1) + cx] || tileSubdiv;
        const regularInterior =
          tileSubdiv >= 3 &&
          northSubdiv === tileSubdiv &&
          eastSubdiv === tileSubdiv &&
          southSubdiv === tileSubdiv &&
          westSubdiv === tileSubdiv;

        if (regularInterior) {
          const subdiv = tileSubdiv;
          const topVertsPerRow = subdiv + 1;
          const topIdx = (ix: number, iz: number): number => iz * topVertsPerRow + ix;
          for (let j = 0; j <= subdiv; j++) {
            for (let ix = 0; ix <= subdiv; ix++) {
              addTopVertex(ix / subdiv, j / subdiv);
            }
          }
          edgeNorth = Array.from({ length: subdiv + 1 }, (_, i) => topIdx(i, 0));
          edgeEast = Array.from({ length: subdiv + 1 }, (_, i) => topIdx(subdiv, i));
          edgeSouth = Array.from({ length: subdiv + 1 }, (_, i) => topIdx(subdiv - i, subdiv));
          edgeWest = Array.from({ length: subdiv + 1 }, (_, i) => topIdx(0, subdiv - i));

          for (let j = 0; j < subdiv; j++) {
            for (let ix = 0; ix < subdiv; ix++) {
              const a = topIdx(ix, j);
              const b = topIdx(ix + 1, j);
              const c = topIdx(ix + 1, j + 1);
              const d = topIdx(ix, j + 1);
              const useAcDiagonal = terrainTextureEnabled
                ? terrainColorDiffSq(terrainColors, terrainVertexBase + a, terrainVertexBase + c) <=
                  terrainColorDiffSq(terrainColors, terrainVertexBase + b, terrainVertexBase + d)
                : true;
              if (useAcDiagonal) {
                addTopTri(a, b, c);
                addTopTri(a, c, d);
              } else {
                addTopTri(a, b, d);
                addTopTri(b, c, d);
              }
            }
          }
        } else {
          const outer = addBoundaryLoop(northSubdiv, eastSubdiv, southSubdiv, westSubdiv);

          if (tileSubdiv >= 3) {
            // Two adjacent tiles can share the same LOD tier yet take
            // different paths here: tile A becomes irregular only because
            // ONE of its OTHER neighbors is at a higher LOD (bumping
            // that edge's subdiv via Math.max), while same-LOD tile B
            // (with all-equal neighbors) goes through regularInterior.
            // The old fan-to-center path then produced ~one triangle per
            // boundary segment for A while B got a full subdiv x subdiv
            // grid — visibly different meshes on hilly terrain at the
            // same LOD.
            //
            // Fix: still generate the full regular interior grid at
            // tileSubdiv density, then zip-stitch the (higher-density)
            // outer boundary loop to the inner ring of the grid. Inner
            // grid triangulation matches regularInterior exactly; only
            // the outer skirt differs.
            const subdiv = tileSubdiv;
            const innerStride = subdiv - 1;
            const innerStart = topLocal.length;
            for (let j = 1; j <= subdiv - 1; j++) {
              for (let ix = 1; ix <= subdiv - 1; ix++) {
                addTopVertex(ix / subdiv, j / subdiv);
              }
            }
            const innerIdx = (i: number, j: number): number =>
              innerStart + (j - 1) * innerStride + (i - 1);

            // Inner grid quads (interior only — the inner "ring" is
            // stitched separately to the outer boundary below).
            for (let j = 1; j < subdiv - 1; j++) {
              for (let ix = 1; ix < subdiv - 1; ix++) {
                const a = innerIdx(ix, j);
                const b = innerIdx(ix + 1, j);
                const c = innerIdx(ix + 1, j + 1);
                const d = innerIdx(ix, j + 1);
                const useAcDiagonal = terrainTextureEnabled
                  ? terrainColorDiffSq(terrainColors, terrainVertexBase + a, terrainVertexBase + c) <=
                    terrainColorDiffSq(terrainColors, terrainVertexBase + b, terrainVertexBase + d)
                  : true;
                if (useAcDiagonal) {
                  addTopTri(a, b, c);
                  addTopTri(a, c, d);
                } else {
                  addTopTri(a, b, d);
                  addTopTri(b, c, d);
                }
              }
            }

            // Inner ring — outermost layer of the inner grid, walked
            // CCW starting at inner_NW (matches the outer loop's CCW
            // start at outer_NW).
            const innerRing: number[] = [];
            // North side: (1, 1) → (subdiv-1, 1).
            for (let i = 1; i <= subdiv - 1; i++) innerRing.push(innerIdx(i, 1));
            // East side: (subdiv-1, 2) → (subdiv-1, subdiv-1).
            for (let j = 2; j <= subdiv - 1; j++) innerRing.push(innerIdx(subdiv - 1, j));
            // South side: (subdiv-2, subdiv-1) → (1, subdiv-1).
            for (let i = subdiv - 2; i >= 1; i--) innerRing.push(innerIdx(i, subdiv - 1));
            // West side: (1, subdiv-2) → (1, 2).
            for (let j = subdiv - 2; j >= 2; j--) innerRing.push(innerIdx(1, j));

            // Perimeter t for each loop, both walked CCW from the
            // tile's NW corner. Each side contributes 0.25 of the total
            // perimeter so corners always align at t = 0.25, 0.5, 0.75.
            const outerT = new Float32Array(outer.length);
            const innerT = new Float32Array(innerRing.length);
            const noN = northSubdiv, noE = eastSubdiv, noS = southSubdiv, noW = westSubdiv;
            for (let i = 0; i < noN; i++) outerT[i] = (i / noN) * 0.25;
            for (let i = 0; i < noE; i++) outerT[noN + i] = 0.25 + (i / noE) * 0.25;
            for (let i = 0; i < noS; i++) outerT[noN + noE + i] = 0.5 + (i / noS) * 0.25;
            for (let i = 0; i < noW; i++) outerT[noN + noE + noS + i] = 0.75 + (i / noW) * 0.25;

            const innerSide = subdiv - 1;
            const innerSegPerSide = subdiv - 2;
            // Vertices per side in the ring excluding the next side's
            // starting corner: subdiv-1 verts per side, but consecutive
            // sides share corners so each side after the first
            // contributes subdiv-2 fresh entries. The corners (other
            // than NW=0) are at ring indices innerSide-1, 2*(innerSide-1),
            // 3*(innerSide-1).
            const cornerNE = innerSide - 1;
            const cornerSE = 2 * (innerSide - 1);
            const cornerSW = 3 * (innerSide - 1);
            for (let k = 0; k < innerRing.length; k++) {
              if (k <= cornerNE) {
                innerT[k] = innerSegPerSide > 0 ? (k / innerSegPerSide) * 0.25 : 0;
              } else if (k <= cornerSE) {
                innerT[k] = 0.25 + ((k - cornerNE) / innerSegPerSide) * 0.25;
              } else if (k <= cornerSW) {
                innerT[k] = 0.5 + ((k - cornerSE) / innerSegPerSide) * 0.25;
              } else {
                innerT[k] = 0.75 + ((k - cornerSW) / innerSegPerSide) * 0.25;
              }
            }

            // Zip-stitch: walk both loops CCW. At each step, advance the
            // pointer whose NEXT vertex has the smaller perimeter t, and
            // emit a triangle bridging the current pair to the advanced
            // vertex. Total triangles = outer.length + innerRing.length
            // (each ring segment contributes one tri).
            const no = outer.length;
            const ni = innerRing.length;
            let oi = 0, ii = 0;
            while (oi < no || ii < ni) {
              const tOuterNext = (oi + 1) >= no ? 1 : outerT[oi + 1];
              const tInnerNext = (ii + 1) >= ni ? 1 : innerT[ii + 1];
              const advanceOuter = ii >= ni ? true
                : oi >= no ? false
                : tOuterNext <= tInnerNext;
              if (advanceOuter) {
                const a = outer[oi];
                const b = outer[(oi + 1) % no];
                const c = innerRing[ii % ni];
                addTopTri(a, b, c);
                oi++;
              } else {
                const a = outer[oi % no];
                const b = innerRing[(ii + 1) % ni];
                const c = innerRing[ii];
                addTopTri(a, b, c);
                ii++;
              }
            }
          } else if (tileSubdiv >= 2) {
            addFanToCenter(outer);
          } else {
            addFanFromFirstBoundaryVertex(outer);
          }
        }

        let floorVertexBase = 0;
        if (includeSideWalls) {
          floorVertexBase = terrainPositions.length / 3;
          const x1 = x0 + cellSize;
          const z1 = z0 + cellSize;
          terrainPositions.push(
            x0, CUBE_FLOOR_Y, z0,
            x1, CUBE_FLOOR_Y, z0,
            x1, CUBE_FLOOR_Y, z1,
            x0, CUBE_FLOOR_Y, z1,
          );
          if (terrainTextureEnabled) {
            pushManaTerrainColor(terrainColors, x0, z0, 0.68);
            pushManaTerrainColor(terrainColors, x1, z0, 0.68);
            pushManaTerrainColor(terrainColors, x1, z1, 0.68);
            pushManaTerrainColor(terrainColors, x0, z1, 0.68);
          }

          const cornerSrc = [edgeNorth[0], edgeNorth[edgeNorth.length - 1], edgeSouth[0], edgeSouth[edgeSouth.length - 1]];
          for (let f = 0; f < 4; f++) {
            const srcOff = (terrainVertexBase + cornerSrc[f]) * 3;
            terrainNormals.push(
              terrainNormals[srcOff],
              terrainNormals[srcOff + 1],
              terrainNormals[srcOff + 2],
            );
          }

          const f00 = floorVertexBase + 0;
          const f10 = floorVertexBase + 1;
          const f11 = floorVertexBase + 2;
          const f01 = floorVertexBase + 3;
          const addWall = (floorA: number, floorB: number, edge: readonly number[]): void => {
            for (let s = 0; s < edge.length - 1; s++) {
              terrainIndices.push(floorA, terrainVertexBase + edge[s], terrainVertexBase + edge[s + 1]);
            }
            terrainIndices.push(floorA, terrainVertexBase + edge[edge.length - 1], floorB);
          };
          addWall(f00, f10, edgeNorth);
          addWall(f10, f11, edgeEast);
          addWall(f11, f01, edgeSouth);
          addWall(f01, f00, edgeWest);
        }
      }
    }

    this.terrainGeometry.dispose();
    this.terrainGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(terrainPositions), 3));
    this.terrainGeometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(terrainNormals), 3));
    if (terrainTextureEnabled) {
      this.terrainGeometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(terrainColors), 3));
    } else {
      this.terrainGeometry.deleteAttribute('color');
    }
    this.terrainGeometry.setIndex(new THREE.BufferAttribute(new Uint32Array(terrainIndices), 1));
    this.terrainGeometry.computeBoundingSphere();

    this.overlayGeometry.dispose();
    this.overlayGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(overlayPositions), 3));
    this.overlayGeometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(overlayUvs), 2));
    this.overlayGeometry.setIndex(new THREE.BufferAttribute(new Uint32Array(overlayIndices), 1));
    this.overlayGeometry.computeBoundingSphere();

    return true;
  }

  private setTerrainTextureActive(active: boolean): void {
    if (this.terrainTextureActive === active) return;
    this.terrainTextureActive = active;
    this.terrainMaterial.vertexColors = active;
    this.terrainMaterial.color.copy(active ? WHITE_COLOR : NEUTRAL_COLOR);
    this.terrainMaterial.needsUpdate = true;
  }

  private clearOverlayTexture(): void {
    this.overlayPixels.fill(0);
    this.overlayTexture.needsUpdate = true;
  }

  private writeOverlayTile(tile: NetworkCaptureTile, cellSize: number, intensity: number): void {
    const cx = tile.cx;
    const cy = tile.cy;
    if (cx < 0 || cx >= this.gridCellsX || cy < 0 || cy >= this.gridCellsY) return;
    const idx = (cy * this.gridCellsX + cx) * 4;
    if (Object.keys(tile.heights).length === 0 || intensity <= 0) {
      this.overlayPixels[idx] = 0;
      this.overlayPixels[idx + 1] = 0;
      this.overlayPixels[idx + 2] = 0;
      this.overlayPixels[idx + 3] = 0;
      return;
    }

    const color = getCaptureTileDisplayColor(
      tile.heights,
      cx,
      cy,
      cellSize,
      this.mapWidth,
      this.mapHeight,
      intensity,
      NEUTRAL_R_BYTE,
      NEUTRAL_G_BYTE,
      NEUTRAL_B_BYTE,
    );
    if (!color.hasColor) {
      this.overlayPixels[idx] = 0;
      this.overlayPixels[idx + 1] = 0;
      this.overlayPixels[idx + 2] = 0;
      this.overlayPixels[idx + 3] = 0;
      return;
    }
    this.overlayPixels[idx] = Math.max(0, Math.min(255, Math.round(color.r)));
    this.overlayPixels[idx + 1] = Math.max(0, Math.min(255, Math.round(color.g)));
    this.overlayPixels[idx + 2] = Math.max(0, Math.min(255, Math.round(color.b)));
    this.overlayPixels[idx + 3] = 255;
  }

  private refreshAllOverlayTiles(cellSize: number, intensity: number): void {
    this.overlayPixels.fill(0);
    if (intensity > 0) {
      const tiles = this.clientViewState.getCaptureTiles();
      for (let i = 0; i < tiles.length; i++) {
        this.writeOverlayTile(tiles[i], cellSize, intensity);
      }
    }
    this.overlayTexture.needsUpdate = true;
  }

  private refreshChangedOverlayTiles(
    tiles: readonly NetworkCaptureTile[],
    cellSize: number,
    intensity: number,
  ): void {
    if (tiles.length === 0) return;
    for (let i = 0; i < tiles.length; i++) {
      this.writeOverlayTile(tiles[i], cellSize, intensity);
    }
    this.overlayTexture.needsUpdate = true;
  }

  update(
    graphicsConfig: GraphicsConfig,
    sharedLodGrid?: RenderLodGrid,
  ): void {
    this.renderFrameIndex = (this.renderFrameIndex + 1) & 0x3fffffff;

    let cellSize = this.clientViewState.getCaptureCellSize();
    if (cellSize <= 0) cellSize = MANA_TILE_SIZE;

    const gridMode = getGridOverlay();
    const intensity = getGridOverlayIntensity();
    const terrainTextureEnabled = gridMode !== 'off';
    const rebuilt = this.rebuildGeometryIfNeeded(
      cellSize,
      graphicsConfig,
      terrainTextureEnabled,
      sharedLodGrid,
    );
    this.terrainMesh.visible = true;

    this.setTerrainTextureActive(gridMode !== 'off');
    const overlayActive = gridMode !== 'off' && intensity > 0;
    this.overlayMesh.visible = overlayActive;
    this.overlayMaterial.opacity = captureOverlayOpacity(intensity);
    if (!overlayActive) {
      if (this.lastOverlayIntensity !== intensity) {
        this.clearOverlayTexture();
        this.lastOverlayIntensity = intensity;
      }
      return;
    }

    const captureVersion = this.clientViewState.getCaptureVersion();
    const intensityChanged = intensity !== this.lastOverlayIntensity;
    if (
      !rebuilt &&
      captureVersion === this.lastCaptureVersion &&
      !intensityChanged
    ) {
      return;
    }

    if (!rebuilt && !intensityChanged && captureVersion !== this.lastCaptureVersion) {
      const stride = Math.max(1, graphicsConfig.captureTileFrameStride | 0);
      if (stride > 1 && this.renderFrameIndex % stride !== 0) return;
    }

    const changes = this.clientViewState.consumeCaptureTileChanges();
    if (rebuilt || intensityChanged || changes.full) {
      this.refreshAllOverlayTiles(cellSize, intensity);
    } else {
      this.refreshChangedOverlayTiles(changes.tiles, cellSize, intensity);
    }

    this.lastCaptureVersion = captureVersion;
    this.lastOverlayIntensity = intensity;
  }

  getMesh(): THREE.Mesh {
    return this.terrainMesh;
  }

  destroy(): void {
    this.terrainGeometry.dispose();
    this.terrainMaterial.dispose();
    this.terrainMesh.parent?.remove(this.terrainMesh);
    this.overlayGeometry.dispose();
    this.overlayTexture.dispose();
    this.overlayMaterial.dispose();
    this.overlayMesh.parent?.remove(this.overlayMesh);
    this.overlayPixels = new Uint8Array(4);
    this.tileSubdivisions = new Uint8Array(0);
    this.tileSideWalls = new Uint8Array(0);
    this.horizontalEdgeSubdivisions = new Uint8Array(0);
    this.verticalEdgeSubdivisions = new Uint8Array(0);
  }
}

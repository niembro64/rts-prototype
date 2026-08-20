// MetalDepositSurfaceField3D — the ore region, as a texture.
//
// A metal deposit is a REGION of the world, not a thing sitting on it.
// This module bakes every workable deposit's build cells into one
// whole-map signed-distance field and hands the terrain shader the
// uniforms to sample it by world XZ.
//
// Why a texture and not geometry: the terrain is an adaptive equilateral
// lattice whose finest edge (LAND_CELL_SIZE / TERRAIN DETAIL) is larger
// than one 20-unit build cell, whose row pitch is irrational relative to
// it, and whose collapse pass merges exactly the flat ground a deposit
// pad creates. No subdivision level can express a build-cell silhouette
// on terrain vertices, and cutting triangles to the boundary is the same
// contour-clipping that produces the wall slivers. Sampling a field in
// world XZ sidesteps all of it: the ore reads at any camera distance, on
// any TERRAIN DETAIL setting, and — because the lookup carries no height
// term — drapes over whatever relief it covers. An ore body wider than
// its flat pad runs off the flat and down the mountainside for free.
//
// This is SURFACE = METAL's trick scoped to a region instead of applied
// to the whole map, which is why both go through one material contract
// in MetalSurfaceMaterial3D.

import * as THREE from 'three';
import { METAL_DEPOSIT_CONFIG } from '../../metalDepositConfig';
import type { MetalDeposit } from '../../metalDepositConfig';
import { BUILD_GRID_CELL_SIZE } from '../sim/buildGrid';
import { packMetalDepositGridCellsXY } from '../sim/metalDeposits';
import { getSimWasm } from '../sim-wasm/init';

export type MetalDepositSurfaceFieldUniforms = {
  field: { value: THREE.DataTexture };
  /** World extent the field's texels actually cover — the texel count
   *  times the texel size, which is a hair larger than the map when the
   *  map is not an exact multiple. Using the map size here instead would
   *  shear the lookup by up to one texel. */
  worldSize: { value: THREE.Vector2 };
  edgeRange: { value: number };
  edgeFeather: { value: number };
  enabled: { value: number };
};

type FieldGrid = {
  width: number;
  height: number;
  texelWorldSize: number;
};

/** Texel size is the authored target until the map is large enough that
 *  it would blow the texture cap, at which point the field coarsens
 *  rather than the allocation growing without bound. */
function resolveMetalDepositFieldGrid(mapWidth: number, mapHeight: number): FieldGrid {
  const cfg = METAL_DEPOSIT_CONFIG.surfaceField;
  const maxDimension = Math.max(1, Math.floor(cfg.maxTextureDimension));
  const largestAxis = Math.max(mapWidth, mapHeight, 1);
  const texelWorldSize = Math.max(cfg.texelWorldSize, largestAxis / maxDimension);
  return {
    width: Math.max(1, Math.min(maxDimension, Math.ceil(mapWidth / texelWorldSize))),
    height: Math.max(1, Math.min(maxDimension, Math.ceil(mapHeight / texelWorldSize))),
    texelWorldSize,
  };
}

export class MetalDepositSurfaceField3D {
  private readonly texture: THREE.DataTexture;
  private readonly grid: FieldGrid;
  readonly uniforms: MetalDepositSurfaceFieldUniforms;

  constructor(
    mapWidth: number,
    mapHeight: number,
    deposits: ReadonlyArray<MetalDeposit>,
  ) {
    const cfg = METAL_DEPOSIT_CONFIG.surfaceField;
    this.grid = resolveMetalDepositFieldGrid(mapWidth, mapHeight);
    const { width, height, texelWorldSize } = this.grid;
    const bytes = new Uint8Array(width * height);

    // A field the kernel never filled must read as ore-free everywhere,
    // not as a fully-ore map: 255 is the encoding's "far outside".
    bytes.fill(255);
    const sim = getSimWasm();
    if (sim !== undefined) {
      const cells = packMetalDepositGridCellsXY(deposits);
      sim.metalDepositBakeSurfaceField(
        width,
        height,
        texelWorldSize,
        BUILD_GRID_CELL_SIZE,
        cells,
        cfg.edgeRangeWorldUnits,
        Math.max(0, Math.floor(cfg.smoothPasses)),
        bytes,
      );
    }

    this.texture = new THREE.DataTexture(
      bytes,
      width,
      height,
      THREE.RedFormat,
      THREE.UnsignedByteType,
    );
    // Rows are one byte per texel and the width is rarely a multiple of
    // four, so the default 4-byte unpack alignment would skew the image.
    this.texture.unpackAlignment = 1;
    this.texture.wrapS = THREE.ClampToEdgeWrapping;
    this.texture.wrapT = THREE.ClampToEdgeWrapping;
    this.texture.magFilter = THREE.LinearFilter;
    // Mips are safe here precisely because the payload is a distance:
    // averaging distances stays a distance, where averaging a 0/1 mask
    // would turn the ore edge to mush at battle zoom.
    this.texture.minFilter = THREE.LinearMipmapLinearFilter;
    this.texture.generateMipmaps = true;
    this.texture.needsUpdate = true;

    this.uniforms = {
      field: { value: this.texture },
      worldSize: { value: new THREE.Vector2(width * texelWorldSize, height * texelWorldSize) },
      edgeRange: { value: cfg.edgeRangeWorldUnits },
      edgeFeather: { value: cfg.edgeFeatherWorldUnits },
      enabled: { value: 1 },
    };
  }

  /** Texel dimensions of the baked field, for diagnostics and tests. */
  get size(): Readonly<FieldGrid> {
    return this.grid;
  }

  dispose(): void {
    this.texture.dispose();
  }
}

export function assignMetalDepositSurfaceFieldUniforms(
  shader: { uniforms: Record<string, { value: unknown }> },
  uniforms: MetalDepositSurfaceFieldUniforms,
): void {
  shader.uniforms.uMetalRegionField = uniforms.field;
  shader.uniforms.uMetalRegionWorldSize = uniforms.worldSize;
  shader.uniforms.uMetalRegionEdgeRange = uniforms.edgeRange;
  shader.uniforms.uMetalRegionEdgeFeather = uniforms.edgeFeather;
  shader.uniforms.uMetalRegionEnabled = uniforms.enabled;
}

export function metalDepositSurfaceFieldUniformDeclarations(): string {
  return [
    'uniform sampler2D uMetalRegionField;',
    'uniform vec2 uMetalRegionWorldSize;',
    'uniform float uMetalRegionEdgeRange;',
    'uniform float uMetalRegionEdgeFeather;',
    'uniform float uMetalRegionEnabled;',
  ].join('\n');
}

/** GLSL expression yielding the SIGNED DISTANCE to the ore edge at a world
 *  position, in world units, negative inside. Kept next to the uniform names
 *  it reads so a rename cannot leave one half behind; the math itself lives
 *  in MetalSurfaceMaterial3D with the rest of the metal surface contract.
 *
 *  The distance is the useful quantity, not the coverage: the edge treatment
 *  displaces and dissolves it before anything is resolved to [0,1]. Hosts
 *  therefore read distance first, take its screen width at top level, and
 *  resolve coverage last. */
export function metalDepositSurfaceFieldDistance(worldPositionExpr: string): string {
  return [
    'metalSurfaceRegionDistance(',
    '  uMetalRegionField,',
    '  uMetalRegionWorldSize,',
    `  ${worldPositionExpr},`,
    '  uMetalRegionEdgeRange',
    ')',
  ].join('\n');
}

/** Screen width of that distance. MUST be evaluated at top level: fwidth
 *  under non-uniform control flow is undefined. */
export function metalDepositSurfaceFieldScreenWidth(distanceExpr: string): string {
  return `metalSurfaceRegionScreenWidth(${distanceExpr}, uMetalRegionEdgeRange)`;
}

/** GLSL expression yielding ore coverage in [0,1] from a distance and its
 *  screen width. `uMetalRegionEnabled` gates the whole region here, which is
 *  why it multiplies the coverage rather than the distance — a zeroed
 *  distance would read as "exactly on the boundary everywhere". */
export function metalDepositSurfaceFieldCoverage(
  distanceExpr: string,
  screenWidthExpr: string,
): string {
  return [
    'metalSurfaceRegionCoverage(',
    `  ${distanceExpr},`,
    `  ${screenWidthExpr},`,
    '  uMetalRegionEdgeFeather',
    ') * uMetalRegionEnabled',
  ].join('\n');
}

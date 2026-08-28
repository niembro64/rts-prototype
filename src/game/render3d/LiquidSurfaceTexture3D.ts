// Small deterministic, seamless textures for the horizontal liquid surfaces.
// Water gets quiet bent flow lines. Lava gets two scales of cellular plates:
// its shader counter-flows those fields so hot fissures open and close without
// making the whole molten surface slide like a decal.

import * as THREE from 'three';

export type LiquidSurfaceTextureMode = 'water' | 'lava';

export type LiquidSurfaceTextureSpec = Readonly<{
  resolution: number;
  contrast: number;
}>;

function clampUnit(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function byte(value: number): number {
  return Math.round(clampUnit(value) * 255);
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = clampUnit((value - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

function hashCell(x: number, y: number, seed: number): number {
  const value = Math.sin(
    x * 127.1 + y * 311.7 + seed * 74.7,
  ) * 43_758.545_312_3;
  return value - Math.floor(value);
}

function wrappedCell(value: number, cells: number): number {
  return ((value % cells) + cells) % cells;
}

type CellularSample = Readonly<{
  edge: number;
  plate: number;
}>;

/** Periodic Worley/Voronoi sample. `edge` is bright only near the boundary
 * between two plates; `plate` gives each nearest plate a stable dark value. */
function sampleCellular(
  u: number,
  v: number,
  cells: number,
  seed: number,
): CellularSample {
  const px = u * cells;
  const py = v * cells;
  const baseX = Math.floor(px);
  const baseY = Math.floor(py);
  let nearest = Number.POSITIVE_INFINITY;
  let secondNearest = Number.POSITIVE_INFINITY;
  let nearestWrappedX = 0;
  let nearestWrappedY = 0;

  for (let offsetY = -1; offsetY <= 1; offsetY++) {
    const cellY = baseY + offsetY;
    const wrappedY = wrappedCell(cellY, cells);
    for (let offsetX = -1; offsetX <= 1; offsetX++) {
      const cellX = baseX + offsetX;
      const wrappedX = wrappedCell(cellX, cells);
      const featureX = cellX + 0.16 + hashCell(wrappedX, wrappedY, seed) * 0.68;
      const featureY = cellY + 0.16 + hashCell(wrappedX, wrappedY, seed + 19) * 0.68;
      const dx = featureX - px;
      const dy = featureY - py;
      const distanceSquared = dx * dx + dy * dy;
      if (distanceSquared < nearest) {
        secondNearest = nearest;
        nearest = distanceSquared;
        nearestWrappedX = wrappedX;
        nearestWrappedY = wrappedY;
      } else if (distanceSquared < secondNearest) {
        secondNearest = distanceSquared;
      }
    }
  }

  const separation = Math.sqrt(secondNearest) - Math.sqrt(nearest);
  return {
    edge: 1 - smoothstep(0.025, 0.19, separation),
    plate: hashCell(nearestWrappedX, nearestWrappedY, seed + 47),
  };
}

/** Build one tileable RGB multiplier. Alpha stays fully opaque: the owning
 * material's authored opacity is the sole see-through control for water. */
export function createLiquidSurfaceTexture3D(
  mode: LiquidSurfaceTextureMode,
  spec: LiquidSurfaceTextureSpec,
): THREE.DataTexture {
  const pixels = spec.resolution;
  const data = new Uint8Array(pixels * pixels * 4);
  const tau = Math.PI * 2;

  for (let y = 0; y < pixels; y++) {
    const normalizedY = y / pixels;
    const v = (y / pixels) * tau;
    for (let x = 0; x < pixels; x++) {
      const normalizedX = x / pixels;
      const u = (x / pixels) * tau;
      const offset = (y * pixels + x) * 4;

      if (mode === 'water') {
        // Integer-frequency periodic terms remain seamless on both axes. The
        // nested sines bend the bands into flow lines without hash-noise grit.
        const broadA = Math.sin(u * 2 + Math.sin(v * 3) * 0.82);
        const broadB = Math.sin(v * 3 - Math.sin(u * 2) * 0.68);
        const crossing = Math.sin(u * 5 - v * 4 + Math.sin(u + v) * 0.55);
        const field = clampUnit(
          0.5 + broadA * 0.22 + broadB * 0.18 + crossing * 0.10,
        );
        const ridge = Math.pow(field, 2.7);
        // Eight percent contrast is deliberately quiet. It gives the plane a
        // readable flow direction while leaving material alpha—and therefore
        // everything beneath the water—untouched.
        const shade = 1 - spec.contrast * (0.18 + ridge * 0.82);
        data[offset] = byte(shade * 0.985);
        data[offset + 1] = byte(shade * 0.995);
        data[offset + 2] = byte(shade);
      } else {
        const broad = sampleCellular(normalizedX, normalizedY, 7, 13);
        const fine = sampleCellular(normalizedX, normalizedY, 17, 71);
        const fissure = clampUnit(
          Math.max(
            Math.pow(broad.edge, 1.7),
            Math.pow(fine.edge, 2.5) * 0.58,
          ) * (0.7 + spec.contrast * 0.55),
        );
        const hotCore = Math.pow(fissure, 2.25);
        // R/G are fissure and white-hot-core masks consumed by the lava
        // shader. B is a stable per-plate phase/warp value. With the shader
        // absent this still degrades to recognisable dark crust and red seams.
        data[offset] = byte(fissure);
        data[offset + 1] = byte(hotCore);
        data[offset + 2] = byte(0.12 + broad.plate * 0.38 + fine.plate * 0.12);
      }
      data[offset + 3] = 255;
    }
  }

  const texture = new THREE.DataTexture(data, pixels, pixels, THREE.RGBAFormat);
  texture.name = `LiquidSurfaceTexture:${mode}`;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.colorSpace = mode === 'water'
    ? THREE.SRGBColorSpace
    : THREE.NoColorSpace;
  texture.needsUpdate = true;
  return texture;
}

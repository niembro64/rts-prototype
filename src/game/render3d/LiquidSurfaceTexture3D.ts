// Small deterministic, seamless textures for the horizontal liquid surfaces.
// Water gets quiet bent flow lines. Lava gets an organic periodic flow field
// plus broad and fine cellular fracture masks. The renderer samples those
// channels at independently wind-advected scales to move cooling rafts over
// the molten field without turning the whole surface into one sliding decal.

import * as THREE from 'three';

type LiquidSurfaceTextureMode = 'water' | 'lava';

type LiquidSurfaceTextureSpec = Readonly<{
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

function lerp(from: number, to: number, amount: number): number {
  return from + (to - from) * amount;
}

/** Tileable smooth value noise. Integer lattice coordinates are wrapped
 * before hashing, so both the value and its interpolation slope meet cleanly
 * across a repeating texture boundary. */
function samplePeriodicValueNoise(
  u: number,
  v: number,
  cells: number,
  seed: number,
): number {
  const px = u * cells;
  const py = v * cells;
  const x0 = Math.floor(px);
  const y0 = Math.floor(py);
  const tx = px - x0;
  const ty = py - y0;
  const sx = tx * tx * (3 - 2 * tx);
  const sy = ty * ty * (3 - 2 * ty);
  const n00 = hashCell(wrappedCell(x0, cells), wrappedCell(y0, cells), seed);
  const n10 = hashCell(wrappedCell(x0 + 1, cells), wrappedCell(y0, cells), seed);
  const n01 = hashCell(wrappedCell(x0, cells), wrappedCell(y0 + 1, cells), seed);
  const n11 = hashCell(wrappedCell(x0 + 1, cells), wrappedCell(y0 + 1, cells), seed);
  return lerp(lerp(n00, n10, sx), lerp(n01, n11, sx), sy);
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
        // Warp both crack lattices through a very broad periodic flow field.
        // Straight Voronoi borders read like a stained-glass decal; warped
        // borders form stretched cooling rafts and branching molten channels.
        const warpX = samplePeriodicValueNoise(normalizedX, normalizedY, 4, 29) - 0.5;
        const warpY = samplePeriodicValueNoise(
          normalizedX + 0.371,
          normalizedY + 0.619,
          4,
          83,
        ) - 0.5;
        const warpedX = normalizedX + warpX * 0.13;
        const warpedY = normalizedY + warpY * 0.13;
        const broad = sampleCellular(warpedX, warpedY, 6, 13);
        const fine = sampleCellular(
          warpedX - warpY * 0.07,
          warpedY + warpX * 0.07,
          15,
          71,
        );
        const broadFracture = clampUnit(
          Math.pow(broad.edge, 2.4) * (0.72 + spec.contrast * 0.48),
        );
        const fineFracture = clampUnit(
          Math.pow(fine.edge, 3.1)
            * (0.42 + spec.contrast * 0.38)
            * (0.72 + broad.plate * 0.28),
        );
        const thermalField = clampUnit(
          samplePeriodicValueNoise(warpedX, warpedY, 3, 127) * 0.48
            + samplePeriodicValueNoise(warpedX, warpedY, 7, 191) * 0.31
            + samplePeriodicValueNoise(warpedX, warpedY, 13, 251) * 0.14
            + broad.plate * 0.07,
        );
        // R = major molten-rift topology, G = fine cooling fractures,
        // B = smooth thermal/domain-warp field and per-region animation phase.
        data[offset] = byte(broadFracture);
        data[offset + 1] = byte(fineFracture);
        data[offset + 2] = byte(thermalField);
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

// Procedurally generated tileable noise fields for the ore-region edge.
//
// This is NOT a look texture — nothing samples it as colour. It is three
// independent scalar fields packed into R, G and B, which the terrain shader
// reads in world XZ to decide WHERE the ore boundary actually falls:
//
//   R  smooth mottle  — displaces the ore contour. Sampled twice at two
//                       world scales, which is what turns a stencil-clean
//                       silhouette into lobes with fingers eroded into them.
//   G  granular       — the dissolve grain. Inside the transition band the
//                       ore is either there or not, and this decides which,
//                       so the boundary breaks into grit instead of fading
//                       through a uniform gradient.
//   B  broad blotch   — thickness. Sampled twice, once for how wide the
//                       ore-to-ground ramp is here and once for how far the
//                       dirt band reaches, so neither is constant along the
//                       edge and the two do not vary together.
//
// The channels differ in ROUGHNESS, not just in scale: R and B are sampled
// at world scales that overlap, so if they were the same field the band
// would always be thickest on the same side of every lobe. Independent
// lattices are what keeps the two decorrelated where it matters.
//
// Alpha is pinned at 255 on purpose. A Canvas 2D surface premultiplies, so
// a field stored in alpha would scale the three stored in RGB — the same
// trap the trim sheet documents.
//
// In dev mode, `window.downloadOreEdgeNoiseTexture()` writes the PNG to disk.

import * as THREE from 'three';
import { createRepeatingCanvasTexture } from './repeatingCanvasTexture';
import { ORE_EDGE_NOISE_TEXTURE_RESOLUTION } from '../../config';
import {
  installDetailTextureDevDownloadHelper,
  makeSeededRng,
} from './detailTextureHelpers';

/** One octave stack. `basePeriod` is in LATTICE CELLS ACROSS THE TILE, so
 *  the field is exactly periodic over the texture and tiles seamlessly at
 *  every octave. Lacunarity is fixed at 2 for the same reason: the period
 *  has to stay an integer or the finest octaves stop wrapping. */
type FieldSpec = {
  seed: number;
  basePeriod: number;
  octaves: number;
  gain: number;
};

/** R — contour displacement. A coarse lattice carrying progressively
 *  smaller bites out of its own lobe edges. */
const WARP_FIELD: FieldSpec = { seed: 0x0E0D61, basePeriod: 4, octaves: 5, gain: 0.55 };

/** G — the dissolve grain. Starts finer and holds its high octaves harder,
 *  which is the difference between grit and just-small-blobs. */
const GRAIN_FIELD: FieldSpec = { seed: 0x9a17c3, basePeriod: 6, octaves: 4, gain: 0.66 };

/** B — thickness. Deliberately the smoothest of the three: this one has to
 *  vary over hundreds of world units, not tens, or the band's width would
 *  change faster than the band is wide and read as noise rather than as a
 *  thick stretch and a thin stretch. */
const THICKNESS_FIELD: FieldSpec = { seed: 0x2be4f0, basePeriod: 3, octaves: 3, gain: 0.5 };

let cachedTexture: THREE.CanvasTexture | null = null;
let cachedCanvas: HTMLCanvasElement | null = null;

export function getOreEdgeNoiseTexture(): THREE.CanvasTexture {
  if (!cachedTexture) {
    const { canvas, texture } = generate();
    cachedCanvas = canvas;
    cachedTexture = texture;
    installDetailTextureDevDownloadHelper(
      'ore-edge-noise.png',
      () => cachedCanvas,
      'downloadOreEdgeNoiseTexture',
    );
  }
  return cachedTexture;
}

/** Periodic value-noise lattice: `period × period` samples, wrapped. */
function makeLattice(period: number, rng: () => number): Float32Array {
  const lattice = new Float32Array(period * period);
  for (let i = 0; i < lattice.length; i++) lattice[i] = rng();
  return lattice;
}

function fade(t: number): number {
  // Smootherstep. The first derivative vanishing at both ends is what stops
  // the lattice showing as a grid of creases once octaves are summed.
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** Samples a lattice at tile coordinates in [0, 1), wrapping in both axes. */
function sampleLattice(
  lattice: Float32Array,
  period: number,
  u: number,
  v: number,
): number {
  const x = u * period;
  const y = v * period;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = fade(x - x0);
  const fy = fade(y - y0);
  const ix0 = ((x0 % period) + period) % period;
  const iy0 = ((y0 % period) + period) % period;
  const ix1 = (ix0 + 1) % period;
  const iy1 = (iy0 + 1) % period;
  const v00 = lattice[iy0 * period + ix0];
  const v10 = lattice[iy0 * period + ix1];
  const v01 = lattice[iy1 * period + ix0];
  const v11 = lattice[iy1 * period + ix1];
  const top = v00 + (v10 - v00) * fx;
  const bottom = v01 + (v11 - v01) * fx;
  return top + (bottom - top) * fy;
}

/** Renders one fBm field into a full-resolution [0,1] buffer, normalized to
 *  span the whole range so the config's amplitudes mean what they say. */
function renderField(spec: FieldSpec, resolution: number): Float32Array {
  const rng = makeSeededRng(spec.seed);
  const lattices: Float32Array[] = [];
  const periods: number[] = [];
  const amplitudes: number[] = [];
  let amplitude = 1;
  for (let octave = 0; octave < spec.octaves; octave++) {
    const period = spec.basePeriod * (1 << octave);
    // Beyond one lattice cell per texel the octave carries no information
    // the texture can hold; it would only add sampling noise.
    if (period > resolution) break;
    periods.push(period);
    lattices.push(makeLattice(period, rng));
    amplitudes.push(amplitude);
    amplitude *= spec.gain;
  }

  const out = new Float32Array(resolution * resolution);
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (let y = 0; y < resolution; y++) {
    const v = y / resolution;
    for (let x = 0; x < resolution; x++) {
      const u = x / resolution;
      let sum = 0;
      for (let octave = 0; octave < lattices.length; octave++) {
        sum += amplitudes[octave] * sampleLattice(lattices[octave], periods[octave], u, v);
      }
      out[y * resolution + x] = sum;
      if (sum < min) min = sum;
      if (sum > max) max = sum;
    }
  }

  const span = max - min;
  const scale = span > 1e-6 ? 1 / span : 0;
  for (let i = 0; i < out.length; i++) out[i] = (out[i] - min) * scale;
  return out;
}

function generate(): { canvas: HTMLCanvasElement; texture: THREE.CanvasTexture } {
  const resolution = ORE_EDGE_NOISE_TEXTURE_RESOLUTION;
  const canvas = document.createElement('canvas');
  canvas.width = resolution;
  canvas.height = resolution;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('OreEdgeNoiseTexture: 2D context unavailable');

  const warp = renderField(WARP_FIELD, resolution);
  const grain = renderField(GRAIN_FIELD, resolution);
  const thickness = renderField(THICKNESS_FIELD, resolution);

  const image = ctx.createImageData(resolution, resolution);
  const pixels = image.data;
  for (let i = 0, p = 0; i < warp.length; i++, p += 4) {
    pixels[p] = Math.round(warp[i] * 255);
    pixels[p + 1] = Math.round(grain[i] * 255);
    pixels[p + 2] = Math.round(thickness[i] * 255);
    pixels[p + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);

  // LinearSRGBColorSpace means "hand the shader the byte as authored". These
  // are scalar fields, not colour: a decode would bend every one of them
  // through the sRGB transfer curve and quietly bias the contour outward.
  const texture = createRepeatingCanvasTexture(canvas, THREE.LinearSRGBColorSpace);
  return { canvas, texture };
}

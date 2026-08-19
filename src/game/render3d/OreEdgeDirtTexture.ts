// Procedurally generated tileable dirt texture — the SURFACE the ore edge is
// buried under. Parallel structure to RockDetailTexture: one canvas filled
// once at startup, pre-filled with its base colour so `detail.a ≈ 1`
// everywhere and the shader's colour pull and texture overlay stay in
// lockstep. What differs is what it is made of.
//
// This is a separate material from the cliff rock on purpose. Tailings and
// churned soil around an ore body are not the same stuff as a mountain face,
// and dressing them in the rock tile would give the rim the same slab
// vocabulary as the cliff behind it — which is exactly the "one clean
// authored surface meeting another" read this whole treatment exists to
// break. The palette is wet earth through rust-stained ochre to a near-black
// crumb, and the shape mix is biased small and blunt: clods and grit, not
// slabs.
//
// In dev mode, `window.downloadOreEdgeDirtTexture()` writes the PNG to disk.

import * as THREE from 'three';
import { createRepeatingCanvasTexture } from './repeatingCanvasTexture';
import { COLORS, readRgbTupleArray } from '@/colorsConfig';
import {
  ORE_EDGE_DIRT_BASE_COLOR,
  ORE_EDGE_DIRT_TEXTURE_RESOLUTION,
} from '../../config';
import {
  type CommonShapeItem,
  cssRgb,
  drawCommonItemWithWrap,
  installDetailTextureDevDownloadHelper,
  makeSeededRng,
  randIn,
  sampleAngularDetailShape,
  sampleLogDistributedSize,
} from './detailTextureHelpers';

const BASE_TEXTURE_PIXELS = 4096;
const DIRT_TEXTURE_PIXELS = ORE_EDGE_DIRT_TEXTURE_RESOLUTION;
const TEXTURE_SCALE = DIRT_TEXTURE_PIXELS / BASE_TEXTURE_PIXELS;
// Denser than the rock tile relative to its area: dirt has no large flat
// facets to carry it, so its whole read comes from how finely it is broken up.
const ITEM_COUNT = 26000;

const DIRT_SHADE_PALETTE = readRgbTupleArray(
  COLORS.environment.metalDeposit.edge.dirtTexture.shadePaletteRgb,
  'environment.metalDeposit.edge.dirtTexture.shadePaletteRgb',
);

let cachedTexture: THREE.CanvasTexture | null = null;
let cachedCanvas: HTMLCanvasElement | null = null;

export function getOreEdgeDirtTexture(): THREE.CanvasTexture {
  if (!cachedTexture) {
    const { canvas, texture } = generate();
    cachedCanvas = canvas;
    cachedTexture = texture;
    installDetailTextureDevDownloadHelper(
      'ore-edge-dirt.png',
      () => cachedCanvas,
      'downloadOreEdgeDirtTexture',
    );
  }
  return cachedTexture;
}

function generate(): { canvas: HTMLCanvasElement; texture: THREE.CanvasTexture } {
  const canvas = document.createElement('canvas');
  canvas.width = DIRT_TEXTURE_PIXELS;
  canvas.height = DIRT_TEXTURE_PIXELS;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('OreEdgeDirtTexture: 2D context unavailable');
  ctx.fillStyle = cssRgb(ORE_EDGE_DIRT_BASE_COLOR);
  ctx.fillRect(0, 0, DIRT_TEXTURE_PIXELS, DIRT_TEXTURE_PIXELS);

  const rng = makeSeededRng(0xD1927A);
  for (const item of generateItems(rng)) {
    drawCommonItemWithWrap(ctx, item, DIRT_TEXTURE_PIXELS);
  }

  // Sampled as-is, matching the terrain shader's "raw vec3 = working colour"
  // convention (see GroundDetailTexture.ts for the full reasoning).
  return { canvas, texture: createRepeatingCanvasTexture(canvas, THREE.LinearSRGBColorSpace) };
}

function generateItems(rng: () => number): CommonShapeItem[] {
  const items: CommonShapeItem[] = [];
  for (let i = 0; i < ITEM_COUNT; i++) {
    // Top of the range is a third of the rock tile's, and the exponent is
    // steeper, so the population sits far lower: churned earth is mostly
    // crumb with the occasional turned clod, where rock is mostly slab.
    const size = sampleLogDistributedSize(
      rng,
      4 * TEXTURE_SCALE,
      170 * TEXTURE_SCALE,
      2.1,
    );
    const { shapeKind, shapeParam } = sampleAngularDetailShape(rng, size, 90, 40, 16);
    const shade = DIRT_SHADE_PALETTE[Math.floor(rng() * DIRT_SHADE_PALETTE.length)];
    items.push({
      x: rng() * DIRT_TEXTURE_PIXELS,
      y: rng() * DIRT_TEXTURE_PIXELS,
      size,
      rotation: rng() * Math.PI * 2,
      shapeKind,
      shapeParam,
      rgb: shade,
      // Weaker than the rock tile's. Dirt reads as one substance whose grain
      // you can see, not as a mosaic of distinguishable pieces — every clod
      // arriving at full opacity turns the tile into confetti at battle zoom.
      alpha: randIn(rng, 0.35, 0.8),
    });
  }
  // Large first → small last so grit layers over clods.
  items.sort((a, b) => b.size - a.size);
  return items;
}

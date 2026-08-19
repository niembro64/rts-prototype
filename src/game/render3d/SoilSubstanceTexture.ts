// Procedurally generated tileable soil — the SUBSTANCE every weathered
// boundary in the game is buried under.
//
// Parallel structure to RockDetailTexture: one canvas filled once at startup,
// pre-filled with its base colour so `detail.a ~ 1` everywhere and a host's
// colour pull and texture overlay stay in lockstep. What differs is what it
// is made of, and that it is shared.
//
// ONE soil, every treatment. The ore region's dirty rim, the debris at the
// bottom of a plateau wall, the spall along its top, and the dirt at the base
// of a tree are the same stuff — dust and grit — and they are painted from
// this one tile at one world size. Hosts differ only in how they EXPOSE it:
// a dry pale wall rim and a damp dark tree base are one substance under two
// tints, not two materials that happen to look similar.
//
// It is deliberately NOT the cliff-rock tile. Tailings and churned earth are
// not a mountain face, and dressing them in the rock vocabulary would give
// every weathered boundary the same slab structure as the cliff behind it —
// which is exactly the "one authored surface meeting another" read the whole
// treatment exists to break. The palette is wet earth through rust-stained
// ochre to a near-black crumb, and the shape mix is biased small and blunt:
// clods and grit, not slabs.
//
// In dev mode, `window.downloadSoilSubstanceTexture()` writes the PNG to disk.

import * as THREE from 'three';
import { createRepeatingCanvasTexture } from './repeatingCanvasTexture';
import { COLORS, readRgbTupleArray } from '@/colorsConfig';
import {
  SOIL_SUBSTANCE_BASE_COLOR,
  SOIL_SUBSTANCE_TEXTURE_RESOLUTION,
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
const SOIL_TEXTURE_PIXELS = SOIL_SUBSTANCE_TEXTURE_RESOLUTION;
const TEXTURE_SCALE = SOIL_TEXTURE_PIXELS / BASE_TEXTURE_PIXELS;
// Denser than the rock tile relative to its area: dirt has no large flat
// facets to carry it, so its whole read comes from how finely it is broken up.
const ITEM_COUNT = 26000;

const SOIL_SHADE_PALETTE = readRgbTupleArray(
  COLORS.environment.weathering.soilTexture.shadePaletteRgb,
  'environment.weathering.soilTexture.shadePaletteRgb',
);

let cachedTexture: THREE.CanvasTexture | null = null;
let cachedCanvas: HTMLCanvasElement | null = null;

export function getSoilSubstanceTexture(): THREE.CanvasTexture {
  if (!cachedTexture) {
    const { canvas, texture } = generate();
    cachedCanvas = canvas;
    cachedTexture = texture;
    installDetailTextureDevDownloadHelper(
      'soil-substance.png',
      () => cachedCanvas,
      'downloadSoilSubstanceTexture',
    );
  }
  return cachedTexture;
}

function generate(): { canvas: HTMLCanvasElement; texture: THREE.CanvasTexture } {
  const canvas = document.createElement('canvas');
  canvas.width = SOIL_TEXTURE_PIXELS;
  canvas.height = SOIL_TEXTURE_PIXELS;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('SoilSubstanceTexture: 2D context unavailable');
  ctx.fillStyle = cssRgb(SOIL_SUBSTANCE_BASE_COLOR);
  ctx.fillRect(0, 0, SOIL_TEXTURE_PIXELS, SOIL_TEXTURE_PIXELS);

  const rng = makeSeededRng(0x5017A1);
  for (const item of generateItems(rng)) {
    drawCommonItemWithWrap(ctx, item, SOIL_TEXTURE_PIXELS);
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
    const shade = SOIL_SHADE_PALETTE[Math.floor(rng() * SOIL_SHADE_PALETTE.length)];
    items.push({
      x: rng() * SOIL_TEXTURE_PIXELS,
      y: rng() * SOIL_TEXTURE_PIXELS,
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

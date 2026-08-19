// Procedurally generated tileable grass texture.
//
// Grass had no texture at all. `EnvironmentPropRenderer3D` handed every blade
// one flat leaf colour with `map: undefined` — a literal flat-colour surface,
// which is the one fallback tier "every surface is textured" exists to
// forbid, and the reason a field of grass read as a field of identical
// plastic shapes however many blades were in it.
//
// What grass needs is not the leaf tile shrunk. A canopy is many small leaves
// seen against each other; a sward is long thin blades seen END ON, so its
// variation is almost entirely ALONG the blade and between neighbours:
// green at the root, drier toward the tip, one clump yellow where another is
// deep. So the vocabulary here is streaks, drawn long and thin, from a
// palette that runs green through straw — not the leaf tile's rounded
// facets.
//
// It is sampled by world position rather than through the blades' uvs (see
// VegetationWeathering3D), so a clump's tone comes from WHERE it grows. Two
// clumps a metre apart differ; the same clump is the same every frame.
//
// In dev mode, `window.downloadGrassBladeTexture()` writes the PNG to disk.

import * as THREE from 'three';
import { createRepeatingCanvasTexture } from './repeatingCanvasTexture';
import { COLORS, readRgbTupleArray } from '@/colorsConfig';
import {
  GRASS_BLADE_BASE_COLOR,
  GRASS_BLADE_TEXTURE_RESOLUTION,
} from '../../config';
import {
  cssRgb,
  installDetailTextureDevDownloadHelper,
  makeSeededRng,
  randIn,
} from './detailTextureHelpers';
import { drawWrappedCanvasItem } from './repeatingCanvasTexture';

const GRASS_TEXTURE_PIXELS = GRASS_BLADE_TEXTURE_RESOLUTION;
const BASE_TEXTURE_PIXELS = 2048;
const TEXTURE_SCALE = GRASS_TEXTURE_PIXELS / BASE_TEXTURE_PIXELS;
const ITEM_COUNT = 21000;

/** Blades lie down in one loose direction rather than pointing every way; a
 *  sward has a lay to it, and fully random rotation reads as static. */
const LAY_JITTER_RAD = 0.85;

const GRASS_SHADE_PALETTE = readRgbTupleArray(
  COLORS.environment.grass.shadePaletteRgb,
  'environment.grass.shadePaletteRgb',
);

type GrassStreak = {
  x: number;
  y: number;
  rotation: number;
  length: number;
  width: number;
  rgb: readonly [number, number, number];
  alpha: number;
};

let cachedTexture: THREE.CanvasTexture | null = null;
let cachedCanvas: HTMLCanvasElement | null = null;

export function getGrassBladeTexture(): THREE.CanvasTexture {
  if (!cachedTexture) {
    const { canvas, texture } = generate();
    cachedCanvas = canvas;
    cachedTexture = texture;
    installDetailTextureDevDownloadHelper(
      'grass-blade.png',
      () => cachedCanvas,
      'downloadGrassBladeTexture',
    );
  }
  return cachedTexture;
}

function drawStreak(ctx: CanvasRenderingContext2D, item: GrassStreak): void {
  // A blade tapers: wide at the root, a point at the tip.
  ctx.beginPath();
  ctx.moveTo(-item.width / 2, -item.length / 2);
  ctx.lineTo(item.width / 2, -item.length / 2);
  ctx.lineTo(0, item.length / 2);
  ctx.closePath();
  ctx.fill();
}

function generate(): { canvas: HTMLCanvasElement; texture: THREE.CanvasTexture } {
  const canvas = document.createElement('canvas');
  canvas.width = GRASS_TEXTURE_PIXELS;
  canvas.height = GRASS_TEXTURE_PIXELS;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('GrassBladeTexture: 2D context unavailable');
  // Solid base so alpha is 1 everywhere and a host's colour pull and texture
  // overlay stay in lockstep — the same mechanism the ground and rock tiles use.
  ctx.fillStyle = cssRgb(GRASS_BLADE_BASE_COLOR);
  ctx.fillRect(0, 0, GRASS_TEXTURE_PIXELS, GRASS_TEXTURE_PIXELS);

  const rng = makeSeededRng(0x62A55E);
  const items = generateItems(rng);
  for (const item of items) {
    ctx.fillStyle = `rgba(${item.rgb[0]}, ${item.rgb[1]}, ${item.rgb[2]}, ${item.alpha.toFixed(3)})`;
    drawWrappedCanvasItem(
      ctx,
      item,
      GRASS_TEXTURE_PIXELS,
      item.length * 0.6 + 2,
      drawStreak,
    );
  }

  // sRGB, matching the tree tiles: this one carries a colour, not a scalar
  // field, and three converts it in the sampler.
  return {
    canvas,
    texture: createRepeatingCanvasTexture(canvas, THREE.SRGBColorSpace),
  };
}

function generateItems(rng: () => number): GrassStreak[] {
  const items: GrassStreak[] = [];
  // One lay direction per tile, jittered per blade. Drawn from the seeded
  // stream so the tile is reproducible.
  const lay = rng() * Math.PI * 2;
  for (let i = 0; i < ITEM_COUNT; i++) {
    const length = randIn(rng, 26, 190) * TEXTURE_SCALE;
    items.push({
      x: rng() * GRASS_TEXTURE_PIXELS,
      y: rng() * GRASS_TEXTURE_PIXELS,
      rotation: lay + randIn(rng, -LAY_JITTER_RAD, LAY_JITTER_RAD),
      length,
      // Thin: a blade is a streak, and a fat one reads as a leaf.
      width: length * randIn(rng, 0.045, 0.13),
      rgb: GRASS_SHADE_PALETTE[Math.floor(rng() * GRASS_SHADE_PALETTE.length)],
      alpha: randIn(rng, 0.4, 0.9),
    });
  }
  // Long first, short last, so fine blades lie over the broad tonal ones.
  items.sort((a, b) => b.length - a.length);
  return items;
}

// Procedurally generated tileable rock-detail texture, used by the terrain
// shader to cover any surface that is NOT part of the base 0-height flat
// zone — cliffs, plateaus, mountain faces. Parallel structure to
// GroundDetailTexture: one canvas filled once at startup, sampled at runtime
// by the shader. Differences from the grass texture:
//
//   - Rock-toned palette (grays, tans, sun-bleach highlights, dark crevices)
//     instead of forest leaf/wood colors.
//   - Shape mix biased toward hex slabs, pebble circles, and jagged
//     triangles. No grass-blade rosettes.
//   - Pre-filled with TERRAIN_ROCK_BASE_COLOR so detail.a ≈ 1 everywhere,
//     keeping the rock pull and the texture overlay in lockstep (same
//     mechanism the grass texture uses).
//
// The shader samples this texture triplanar (XZ + XY + YZ blended by the
// dominant world-space normal axis), so vertical cliff faces don't suffer
// from the smeared-stripe artifact a flat XZ projection would produce.

import * as THREE from 'three';
import { TERRAIN_ROCK_BASE_COLOR } from '../../config';

export const ROCK_DETAIL_TEXTURE_PIXELS = 4096;
export const ROCK_DETAIL_TILE_WORLD_SIZE = 512;
const ITEM_COUNT = 83200;

// Only hard-cornered shapes — rock fractures along straight lines, not curves.
type ShapeKind = 'box' | 'tri' | 'hex';

type Item = {
  x: number;
  y: number;
  size: number;
  rotation: number;
  shapeKind: ShapeKind;
  shapeParam: number;
  rgb: readonly [number, number, number];
  alpha: number;
};

// Hand-picked rock palette. Mixed grays with brown and sun-bleach extremes to
// give the texture some warmth without straying into "grass" or "wood" hues
// that would clash with the prop materials.
const ROCK_SHADE_PALETTE: readonly (readonly [number, number, number])[] = [
  [54, 50, 43],    // deep crevice
  [78, 72, 62],    // shadow
  [104, 96, 82],   // medium-dark
  [128, 120, 104], // medium
  [156, 146, 128], // medium-light
  [186, 174, 154], // sun-bleached
  [212, 196, 172], // bright highlight
  [92, 76, 60],    // earth-tinted shadow
  [148, 124, 96],  // tan
  [70, 64, 58],    // cool gray
];

let cachedTexture: THREE.CanvasTexture | null = null;
let cachedCanvas: HTMLCanvasElement | null = null;

export function getRockDetailTexture(): THREE.CanvasTexture {
  if (!cachedTexture) {
    const { canvas, texture } = generate();
    cachedCanvas = canvas;
    cachedTexture = texture;
    installDevDownloadHelper();
  }
  return cachedTexture;
}

function generate(): { canvas: HTMLCanvasElement; texture: THREE.CanvasTexture } {
  const canvas = document.createElement('canvas');
  canvas.width = ROCK_DETAIL_TEXTURE_PIXELS;
  canvas.height = ROCK_DETAIL_TEXTURE_PIXELS;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('RockDetailTexture: 2D context unavailable');
  // Solid rock-base background so detail.a ≈ 1 everywhere — the shader's
  // rock pull and texture overlay then apply in perfect lockstep.
  ctx.fillStyle = cssRgb(TERRAIN_ROCK_BASE_COLOR);
  ctx.fillRect(0, 0, ROCK_DETAIL_TEXTURE_PIXELS, ROCK_DETAIL_TEXTURE_PIXELS);

  const rng = makeSeededRng(0xCAFE52);
  const items = generateItems(rng);
  for (const item of items) {
    drawItemWithWrap(ctx, item);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  // Sample as-is to match the terrain shader's "raw vec3 = working color"
  // convention (see GroundDetailTexture.ts for the full reasoning).
  texture.colorSpace = THREE.LinearSRGBColorSpace;
  texture.anisotropy = 8;
  texture.needsUpdate = true;
  return { canvas, texture };
}

function cssRgb(hex: number): string {
  const r = (hex >> 16) & 0xff;
  const g = (hex >> 8) & 0xff;
  const b = hex & 0xff;
  return `rgb(${r}, ${g}, ${b})`;
}

function makeSeededRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randIn(rng: () => number, min: number, max: number): number {
  return min + rng() * (max - min);
}

function generateItems(rng: () => number): Item[] {
  const items: Item[] = [];
  for (let i = 0; i < ITEM_COUNT; i++) {
    // Log-uniform size with a t^1.5 squash. Range stretched up to 500 px so
    // the texture now spans from tiny debris through chunky boulders and
    // full slabs — many small pieces dominate, but big pieces show up often
    // enough to land prominently across the tile. The eased exponent
    // (vs t² for the grass texture) deliberately gives large slabs more
    // representation than the grass-side "many small grass blades" curve.
    const sizeT = rng();
    const tSquashed = Math.pow(sizeT, 1.5);
    const size = Math.exp(
      Math.log(5) + tSquashed * (Math.log(500) - Math.log(5)),
    );

    let shapeKind: ShapeKind;
    const shapeRoll = rng();
    if (size > 200) {
      // Giant slabs: hexagonal rock plates dominate, with chunky wedges mixed in.
      shapeKind = shapeRoll < 0.65 ? 'hex' : 'tri';
    } else if (size > 80) {
      // Big chunks: still hex-led, plus jagged wedges and the occasional
      // rectangular slab.
      shapeKind = shapeRoll < 0.55 ? 'hex'
        : shapeRoll < 0.90 ? 'tri'
        : 'box';
    } else if (size > 30) {
      shapeKind = shapeRoll < 0.40 ? 'hex'
        : shapeRoll < 0.75 ? 'tri'
        : 'box';
    } else {
      // Small debris: cracks (thin boxes), hex shards, tri chips.
      shapeKind = shapeRoll < 0.40 ? 'box'
        : shapeRoll < 0.72 ? 'tri'
        : 'hex';
    }

    let shapeParam: number;
    switch (shapeKind) {
      case 'box':
        // Mostly thin cracks; occasionally wider rectangular slab chunks so
        // the angular variety extends to "blocky rock" shapes too.
        shapeParam = rng() < 0.75
          ? randIn(rng, 0.04, 0.14)
          : randIn(rng, 0.30, 0.65);
        break;
      case 'tri':
        // Squat jagged triangles, not pointed leaves.
        shapeParam = randIn(rng, 0.30, 0.55);
        break;
      default:
        shapeParam = 0;
    }

    const shade = ROCK_SHADE_PALETTE[Math.floor(rng() * ROCK_SHADE_PALETTE.length)];

    items.push({
      x: rng() * ROCK_DETAIL_TEXTURE_PIXELS,
      y: rng() * ROCK_DETAIL_TEXTURE_PIXELS,
      size,
      rotation: rng() * Math.PI * 2,
      shapeKind,
      shapeParam,
      rgb: shade,
      alpha: randIn(rng, 0.55, 0.95),
    });
  }
  // Large first → small last so fine pebbles/cracks layer over big slabs.
  items.sort((a, b) => b.size - a.size);
  return items;
}

function drawShape(ctx: CanvasRenderingContext2D, item: Item): void {
  const s = item.size;
  switch (item.shapeKind) {
    case 'box': {
      const w = s * item.shapeParam;
      ctx.fillRect(-w / 2, -s / 2, w, s);
      return;
    }
    case 'tri': {
      const halfBase = s * item.shapeParam;
      ctx.beginPath();
      ctx.moveTo(0, -s / 2);
      ctx.lineTo(halfBase, s / 2);
      ctx.lineTo(-halfBase, s / 2);
      ctx.closePath();
      ctx.fill();
      return;
    }
    case 'hex': {
      ctx.beginPath();
      for (let v = 0; v < 6; v++) {
        const a = (v / 6) * Math.PI * 2;
        const x = (s / 2) * Math.cos(a);
        const y = (s / 2) * Math.sin(a);
        if (v === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.fill();
      return;
    }
  }
}

function drawItemWithWrap(ctx: CanvasRenderingContext2D, item: Item): void {
  ctx.fillStyle = `rgba(${item.rgb[0]}, ${item.rgb[1]}, ${item.rgb[2]}, ${item.alpha.toFixed(3)})`;
  const S = ROCK_DETAIL_TEXTURE_PIXELS;
  // Padding past the bounding radius keeps anti-aliased edges that spill
  // past the tile border from showing a seam on the wrapped side.
  const half = item.size * 0.55 + 2;
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      const cx = item.x + ox * S;
      const cy = item.y + oy * S;
      if (cx + half < 0 || cx - half >= S) continue;
      if (cy + half < 0 || cy - half >= S) continue;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(item.rotation);
      drawShape(ctx, item);
      ctx.restore();
    }
  }
}

function installDevDownloadHelper(): void {
  if (!import.meta.env.DEV) return;
  if (typeof window === 'undefined') return;
  const w = window as unknown as { downloadRockDetailTexture?: () => void };
  if (w.downloadRockDetailTexture) return;
  w.downloadRockDetailTexture = () => {
    if (!cachedCanvas) return;
    const link = document.createElement('a');
    link.href = cachedCanvas.toDataURL('image/png');
    link.download = 'rock-detail.png';
    link.click();
  };
}

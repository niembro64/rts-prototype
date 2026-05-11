// Procedurally generated tileable ground-detail texture.
//
// The texture is built once in-browser via Canvas 2D, then handed to the
// terrain shader as a repeating sampler. Replaces the previous 120-layer
// fragment-shader approach: shader runtime cost is one texture sample
// instead of ~120 hashed shape tests, and items can be placed at free
// (x, y) positions with no grid constraint — so the result has no visible
// lattice regularity.
//
// In dev mode, `window.downloadGroundDetailTexture()` writes the current
// PNG to disk for inspection.

import * as THREE from 'three';
import {
  FOREST_SPRUCE2_LEAF_COLOR,
  FOREST_SPRUCE2_WOOD_COLOR,
  TERRAIN_GROUND_BASE_COLOR,
} from '../../config';

// Texture resolution in pixels (square). Power of two for clean mipmaps.
// 4096² @ 8 px/world = 512 world unit tile; 64 MB GPU memory.
export const GROUND_DETAIL_TEXTURE_PIXELS = 4096;
// How many world units one tile spans. The shader also samples a second
// rotated+rescaled copy of this texture (see CaptureTileRenderer3D), so the
// *visible* repeat period is the LCM of two co-prime scales on top of this
// literal tile — effectively unbounded at normal RTS zoom levels.
export const GROUND_DETAIL_TILE_WORLD_SIZE = 512;
// Item count scales with tile area (16× area vs the original 128-unit /
// 1024-px tile) so per-world-unit density stays constant.
const ITEM_COUNT = 83200;

type ShapeKind = 'box' | 'tri' | 'circle' | 'hex' | 'rosette';

type Item = {
  x: number;
  y: number;
  size: number;
  rotation: number;
  shapeKind: ShapeKind;
  shapeParam: number;
  palette: 'wood' | 'leaf';
  pure: boolean;
  colorBlend: number;
  alpha: number;
};

let cachedTexture: THREE.CanvasTexture | null = null;
let cachedCanvas: HTMLCanvasElement | null = null;

export function getGroundDetailTexture(): THREE.CanvasTexture {
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
  canvas.width = GROUND_DETAIL_TEXTURE_PIXELS;
  canvas.height = GROUND_DETAIL_TEXTURE_PIXELS;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('GroundDetailTexture: 2D context unavailable');
  // Fill the entire tile with the base tree/grass color first. This makes the
  // texture's alpha effectively 1 everywhere so the shader's "green pull" and
  // "texture overlay" are in lockstep — both gated by the same flatGreenDetail
  // mask, both fully present or fully absent together. Shapes drawn on top of
  // this base composite over the green via standard source-over blending.
  ctx.fillStyle = cssRgb(TERRAIN_GROUND_BASE_COLOR);
  ctx.fillRect(0, 0, GROUND_DETAIL_TEXTURE_PIXELS, GROUND_DETAIL_TEXTURE_PIXELS);

  const rng = makeSeededRng(0xC0FFEE);
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
  // LinearSRGBColorSpace means "sample the texel as-is, no conversion". The
  // rest of the terrain shader writes raw vec3 literals (lowGrass, dryGrass,
  // etc.) and treats them as already in working space, so the detail texture
  // must match that convention — otherwise the sampled colors come out
  // noticeably darker than the same color drawn in a PNG viewer.
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
    // Log-uniform size with a t² squash biases toward small items: many fine
    // grass blades / sticks, few large logs / clumps. Matches the natural
    // forest-floor distribution.
    const sizeT = rng();
    const size = Math.exp(
      Math.log(5) + sizeT * sizeT * (Math.log(190) - Math.log(5)),
    );

    let shapeKind: ShapeKind;
    const shapeRoll = rng();
    if (size > 90) {
      shapeKind = shapeRoll < 0.30 ? 'hex'
        : shapeRoll < 0.52 ? 'box'
        : shapeRoll < 0.78 ? 'tri'
        : 'rosette';
    } else if (size > 35) {
      shapeKind = shapeRoll < 0.14 ? 'hex'
        : shapeRoll < 0.42 ? 'box'
        : shapeRoll < 0.58 ? 'circle'
        : shapeRoll < 0.78 ? 'tri'
        : 'rosette';
    } else {
      shapeKind = shapeRoll < 0.52 ? 'box'
        : shapeRoll < 0.76 ? 'tri'
        : shapeRoll < 0.94 ? 'circle'
        : 'rosette';
    }

    let palette: 'wood' | 'leaf';
    if (shapeKind === 'hex') palette = 'wood';
    else if (shapeKind === 'rosette') palette = 'leaf';
    else if (shapeKind === 'box') {
      palette = rng() < (size > 40 ? 0.62 : 0.28) ? 'wood' : 'leaf';
    } else if (shapeKind === 'tri') {
      palette = rng() < 0.40 ? 'wood' : 'leaf';
    } else {
      palette = rng() < 0.55 ? 'wood' : 'leaf';
    }

    let shapeParam: number;
    switch (shapeKind) {
      case 'box':
        shapeParam = randIn(rng, 0.05, 0.18);
        break;
      case 'tri':
        shapeParam = randIn(rng, 0.22, 0.42);
        break;
      case 'rosette': {
        const p = rng();
        shapeParam = p < 0.30 ? 4 : p < 0.60 ? 5 : p < 0.86 ? 6 : 3;
        break;
      }
      default:
        shapeParam = 0;
    }

    // Restrict pure-color patches to small/medium sizes so the exact spruce
    // wood / leaf color never appears as a giant solid blob.
    const pure = size < 72 && rng() < 0.18;

    items.push({
      x: rng() * GROUND_DETAIL_TEXTURE_PIXELS,
      y: rng() * GROUND_DETAIL_TEXTURE_PIXELS,
      size,
      rotation: rng() * Math.PI * 2,
      shapeKind,
      shapeParam,
      palette,
      pure,
      colorBlend: rng(),
      alpha: pure ? randIn(rng, 0.92, 1.0) : randIn(rng, 0.55, 0.95),
    });
  }
  // Large items first; smaller items overlay them. This stacks fine debris
  // on top of bigger fallen logs / hex slices, matching real forest floors.
  items.sort((a, b) => b.size - a.size);
  return items;
}

function computeFillStyle(item: Item): string {
  const baseHex = item.palette === 'wood'
    ? FOREST_SPRUCE2_WOOD_COLOR
    : FOREST_SPRUCE2_LEAF_COLOR;
  const baseR = (baseHex >> 16) & 0xff;
  const baseG = (baseHex >> 8) & 0xff;
  const baseB = baseHex & 0xff;

  let r: number;
  let g: number;
  let b: number;
  if (item.pure) {
    r = baseR;
    g = baseG;
    b = baseB;
  } else {
    const darkF = item.palette === 'wood' ? 0.40 : 0.50;
    const lightF = item.palette === 'wood' ? 1.30 : 1.30;
    const f = darkF + item.colorBlend * (lightF - darkF);
    const gBoost = item.palette === 'leaf' ? 1.04 : 1.0;
    r = clampByte(Math.round(baseR * f));
    g = clampByte(Math.round(baseG * f * gBoost));
    b = clampByte(Math.round(baseB * f));
  }
  return `rgba(${r}, ${g}, ${b}, ${item.alpha.toFixed(3)})`;
}

function clampByte(v: number): number {
  if (v < 0) return 0;
  if (v > 255) return 255;
  return v;
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
    case 'circle': {
      ctx.beginPath();
      ctx.arc(0, 0, s / 2, 0, Math.PI * 2);
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
    case 'rosette': {
      const petals = item.shapeParam;
      const r0 = s / 2;
      const steps = 96;
      ctx.beginPath();
      for (let k = 0; k < steps; k++) {
        const a = (k / steps) * Math.PI * 2;
        const r = r0 * (0.50 + 0.50 * Math.cos(petals * a));
        const x = r * Math.cos(a);
        const y = r * Math.sin(a);
        if (k === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.fill();
      return;
    }
  }
}

function drawItemWithWrap(ctx: CanvasRenderingContext2D, item: Item): void {
  ctx.fillStyle = computeFillStyle(item);
  const S = GROUND_DETAIL_TEXTURE_PIXELS;
  // Half the bounding extent (size/2 is the radius for all shapes drawn here).
  // Add a tiny padding so anti-aliased edges that bleed past the boundary
  // appear on the wrapped side too.
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
  const w = window as unknown as { downloadGroundDetailTexture?: () => void };
  if (w.downloadGroundDetailTexture) return;
  w.downloadGroundDetailTexture = () => {
    if (!cachedCanvas) return;
    const link = document.createElement('a');
    link.href = cachedCanvas.toDataURL('image/png');
    link.download = 'ground-detail.png';
    link.click();
  };
}

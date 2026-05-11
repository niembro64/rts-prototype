// Procedurally generated tileable tree-leaf texture, applied to tree foliage
// materials only (not grass props — grass keeps its plain-color material).
//
// Structurally a near-copy of RockDetailTexture: same shape mix (hex / tri /
// box, no circles), same wider size distribution, same canvas pre-filled
// with the leaf base color. Only the palette differs — greens, yellow-greens
// and shadow-greens instead of the rock grays.
//
// Sampled by the standard MeshLambertMaterial via the model's baked UVs, so
// there is no world-space tile-size knob; the texture wraps once per UV
// [0, 1] interval and the model decides how the wrap looks on the mesh.

import * as THREE from 'three';
import {
  FOREST_SPRUCE2_LEAF_COLOR,
  TREE_LEAF_DETAIL_CONTRAST,
  TREE_LEAF_TEXTURE_REPEAT,
} from '../../config';

export const TREE_LEAF_TEXTURE_PIXELS = 1024;
const ITEM_COUNT = 5200;

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

// Leaf-tone palette: cool deep shadow, mid foliage greens, sun-bleached
// yellow-greens, and a couple of brown-tinted shadows for variety.
const LEAF_SHADE_PALETTE: readonly (readonly [number, number, number])[] = [
  [38, 58, 32],   // deep shadow
  [55, 78, 42],   // shadow
  [72, 100, 52],  // mid-dark
  [94, 130, 65],  // mid
  [120, 156, 80], // mid-bright
  [156, 184, 95], // bright leaf
  [196, 210, 115],// sun-bleached / yellow-green
  [70, 86, 42],   // olive shadow
  [110, 124, 56], // olive
  [60, 50, 35],   // brown leaf-litter shadow
];

let cachedTexture: THREE.CanvasTexture | null = null;
let cachedCanvas: HTMLCanvasElement | null = null;

export function getTreeLeafTexture(): THREE.CanvasTexture {
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
  canvas.width = TREE_LEAF_TEXTURE_PIXELS;
  canvas.height = TREE_LEAF_TEXTURE_PIXELS;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('TreeLeafTexture: 2D context unavailable');
  // Solid leaf-base background so detail.a ≈ 1 everywhere and the texture
  // overall reads as the prop's exact leaf color.
  ctx.fillStyle = cssRgb(FOREST_SPRUCE2_LEAF_COLOR);
  ctx.fillRect(0, 0, TREE_LEAF_TEXTURE_PIXELS, TREE_LEAF_TEXTURE_PIXELS);

  const rng = makeSeededRng(0x1EAF55);
  const items = generateItems(rng);
  for (const item of items) {
    drawItemWithWrap(ctx, item);
  }

  // Contrast knob: pull every pixel back toward the base color by
  // (1 - contrast). At contrast=0 the final canvas is a flat field of base
  // color (no variation visible); at contrast=1 the shapes are left
  // unchanged. Same semantics as TERRAIN_GROUND/ROCK_DETAIL_CONTRAST, just
  // baked into the canvas instead of mixed at shader time.
  const contrast = Math.max(0, Math.min(1, TREE_LEAF_DETAIL_CONTRAST));
  if (contrast < 1) {
    ctx.globalAlpha = 1 - contrast;
    ctx.fillStyle = cssRgb(FOREST_SPRUCE2_LEAF_COLOR);
    ctx.fillRect(0, 0, TREE_LEAF_TEXTURE_PIXELS, TREE_LEAF_TEXTURE_PIXELS);
    ctx.globalAlpha = 1;
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  // Tile the texture multiple times per UV unit. Trees come in at a small
  // global scale so individual faces are minified hard; without this, the
  // mipmaps average the shapes into the mean color and you only see the
  // overall hue change. Repeating multiplies the pattern density per face
  // so shapes survive minification.
  const repeat = Math.max(1, TREE_LEAF_TEXTURE_REPEAT);
  texture.repeat.set(repeat, repeat);
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  // Tree materials use stock MeshLambertMaterial whose pipeline does the
  // sRGB→linear conversion on sample, so this texture should be tagged sRGB
  // (unlike the terrain detail textures, which feed a custom shader that
  // works in the "raw-vec3-as-linear" convention).
  texture.colorSpace = THREE.SRGBColorSpace;
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
  // Sizes are scaled down 4× relative to the rock canvas (this canvas is
  // 1024² vs rock's 4096²) so the proportion of canvas-coverage per item
  // matches the rock generation.
  for (let i = 0; i < ITEM_COUNT; i++) {
    const sizeT = rng();
    const tSquashed = Math.pow(sizeT, 1.5);
    const size = Math.exp(
      Math.log(2) + tSquashed * (Math.log(125) - Math.log(2)),
    );

    let shapeKind: ShapeKind;
    const shapeRoll = rng();
    if (size > 50) {
      shapeKind = shapeRoll < 0.65 ? 'hex' : 'tri';
    } else if (size > 20) {
      shapeKind = shapeRoll < 0.55 ? 'hex'
        : shapeRoll < 0.90 ? 'tri'
        : 'box';
    } else if (size > 8) {
      shapeKind = shapeRoll < 0.40 ? 'hex'
        : shapeRoll < 0.75 ? 'tri'
        : 'box';
    } else {
      shapeKind = shapeRoll < 0.40 ? 'box'
        : shapeRoll < 0.72 ? 'tri'
        : 'hex';
    }

    let shapeParam: number;
    switch (shapeKind) {
      case 'box':
        shapeParam = rng() < 0.75
          ? randIn(rng, 0.04, 0.14)
          : randIn(rng, 0.30, 0.65);
        break;
      case 'tri':
        shapeParam = randIn(rng, 0.30, 0.55);
        break;
      default:
        shapeParam = 0;
    }

    const shade = LEAF_SHADE_PALETTE[Math.floor(rng() * LEAF_SHADE_PALETTE.length)];

    items.push({
      x: rng() * TREE_LEAF_TEXTURE_PIXELS,
      y: rng() * TREE_LEAF_TEXTURE_PIXELS,
      size,
      rotation: rng() * Math.PI * 2,
      shapeKind,
      shapeParam,
      rgb: shade,
      alpha: randIn(rng, 0.55, 0.95),
    });
  }
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
  const S = TREE_LEAF_TEXTURE_PIXELS;
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
  const w = window as unknown as { downloadTreeLeafTexture?: () => void };
  if (w.downloadTreeLeafTexture) return;
  w.downloadTreeLeafTexture = () => {
    if (!cachedCanvas) return;
    const link = document.createElement('a');
    link.href = cachedCanvas.toDataURL('image/png');
    link.download = 'tree-leaf.png';
    link.click();
  };
}

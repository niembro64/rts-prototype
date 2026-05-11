// Procedurally generated tileable tree-bark texture, applied to tree-trunk
// materials only.
//
// Trees grow upward, so bark fractures along the direction of growth. Two
// generation tweaks vs the rock / leaf textures produce the bark look:
//
//   1. Rotation bias toward vertical — ~75 % of items get a near-vertical
//      rotation (±0.3 rad). The remaining 25 % keep a random rotation so the
//      surface doesn't read as a uniform comb.
//   2. Per-item vertical stretch — every item is scaled 1.5× along Y in
//      local space after rotation. Round hex plates become tall hexes,
//      already-thin vertical cracks become thinner-ratio cracks, jagged
//      triangles get pointier. Universally makes everything elongated up.
//
// Shape vocabulary is the same hard-cornered hex / tri / box from the rock
// texture (no circles / oval knots — keeps the geometric aesthetic
// consistent). Palette is warm browns through deep shadow.

import * as THREE from 'three';
import {
  FOREST_SPRUCE2_WOOD_COLOR,
  TREE_TRUNK_DETAIL_CONTRAST,
} from '../../config';

export const TREE_TRUNK_TEXTURE_PIXELS = 1024;
const ITEM_COUNT = 5200;

// Fraction of items that get a near-vertical rotation. The rest get full
// random rotation so the surface isn't perfectly grid-comb-like.
const VERTICAL_BIAS_FRACTION = 0.75;
// Vertical jitter applied to vertically-biased items (radians, ±half-range).
const VERTICAL_JITTER_RAD = 0.6;
// All shapes get this Y-scale after rotation, baking in the elongated-plate
// look across the entire texture.
const VERTICAL_STRETCH = 1.5;

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

// Bark-tone palette: very dark crack shadows through medium browns up to
// sun-bleached / tan highlights, with a couple of reddish-tinted variants
// to match real conifer bark hue range.
const BARK_SHADE_PALETTE: readonly (readonly [number, number, number])[] = [
  [28, 20, 14],   // crack shadow
  [48, 36, 26],   // deep shadow
  [70, 54, 40],   // dark bark
  [96, 76, 56],   // medium
  [124, 100, 76], // medium-light
  [156, 130, 100],// light plate
  [188, 160, 124],// sun-bleached
  [82, 50, 32],   // reddish dark
  [128, 86, 56],  // reddish medium
  [88, 78, 68],   // gray-brown
];

let cachedTexture: THREE.CanvasTexture | null = null;
let cachedCanvas: HTMLCanvasElement | null = null;

export function getTreeTrunkTexture(): THREE.CanvasTexture {
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
  canvas.width = TREE_TRUNK_TEXTURE_PIXELS;
  canvas.height = TREE_TRUNK_TEXTURE_PIXELS;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('TreeTrunkTexture: 2D context unavailable');
  ctx.fillStyle = cssRgb(FOREST_SPRUCE2_WOOD_COLOR);
  ctx.fillRect(0, 0, TREE_TRUNK_TEXTURE_PIXELS, TREE_TRUNK_TEXTURE_PIXELS);

  const rng = makeSeededRng(0xBA12CB);
  const items = generateItems(rng);
  for (const item of items) {
    drawItemWithWrap(ctx, item);
  }

  // Contrast knob: pull every pixel back toward the base color by
  // (1 - contrast). 0 = flat base brown (no variation), 1 = full bark detail.
  // Baked into the canvas because trees use stock MeshLambertMaterial.
  const contrast = Math.max(0, Math.min(1, TREE_TRUNK_DETAIL_CONTRAST));
  if (contrast < 1) {
    ctx.globalAlpha = 1 - contrast;
    ctx.fillStyle = cssRgb(FOREST_SPRUCE2_WOOD_COLOR);
    ctx.fillRect(0, 0, TREE_TRUNK_TEXTURE_PIXELS, TREE_TRUNK_TEXTURE_PIXELS);
    ctx.globalAlpha = 1;
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
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
  for (let i = 0; i < ITEM_COUNT; i++) {
    const sizeT = rng();
    const tSquashed = Math.pow(sizeT, 1.5);
    const size = Math.exp(
      Math.log(2) + tSquashed * (Math.log(125) - Math.log(2)),
    );

    let shapeKind: ShapeKind;
    const shapeRoll = rng();
    if (size > 50) {
      // Large plates: hex-dominated, with the occasional pointed vertical
      // wedge (becomes a tall narrow plate after the vertical stretch).
      shapeKind = shapeRoll < 0.55 ? 'hex' : 'tri';
    } else if (size > 20) {
      // Medium plates and cracks: more boxes show up here (medium-length
      // vertical fissures between plate clusters).
      shapeKind = shapeRoll < 0.40 ? 'hex'
        : shapeRoll < 0.65 ? 'tri'
        : 'box';
    } else if (size > 8) {
      // Small bark detail: cracks (boxes) dominate as the fissure look.
      shapeKind = shapeRoll < 0.55 ? 'box'
        : shapeRoll < 0.85 ? 'tri'
        : 'hex';
    } else {
      // Fine grain: thin vertical cracks running between plates.
      shapeKind = shapeRoll < 0.70 ? 'box'
        : shapeRoll < 0.90 ? 'tri'
        : 'hex';
    }

    let shapeParam: number;
    switch (shapeKind) {
      case 'box':
        // Boxes are deliberately mostly thin (vertical cracks); plate-wide
        // boxes show up occasionally too.
        shapeParam = rng() < 0.80
          ? randIn(rng, 0.05, 0.18)
          : randIn(rng, 0.30, 0.55);
        break;
      case 'tri':
        shapeParam = randIn(rng, 0.25, 0.50);
        break;
      default:
        shapeParam = 0;
    }

    // Rotation: most items get a tight vertical bias. A minority are fully
    // random so the surface doesn't read as a uniform vertical comb.
    const rotation = rng() < VERTICAL_BIAS_FRACTION
      ? (rng() - 0.5) * VERTICAL_JITTER_RAD
      : rng() * Math.PI * 2;

    const shade = BARK_SHADE_PALETTE[Math.floor(rng() * BARK_SHADE_PALETTE.length)];

    items.push({
      x: rng() * TREE_TRUNK_TEXTURE_PIXELS,
      y: rng() * TREE_TRUNK_TEXTURE_PIXELS,
      size,
      rotation,
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
  const S = TREE_TRUNK_TEXTURE_PIXELS;
  // Bounding extent after the vertical stretch — be generous so anti-aliased
  // edges don't get clipped on the wrap copies.
  const half = item.size * 0.55 * VERTICAL_STRETCH + 2;
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      const cx = item.x + ox * S;
      const cy = item.y + oy * S;
      if (cx + half < 0 || cx - half >= S) continue;
      if (cy + half < 0 || cy - half >= S) continue;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(item.rotation);
      // Apply vertical stretch in local frame *after* rotation so the
      // stretch is along the item's own up axis (consistent with bark's
      // along-the-grain elongation).
      ctx.scale(1.0, VERTICAL_STRETCH);
      drawShape(ctx, item);
      ctx.restore();
    }
  }
}

function installDevDownloadHelper(): void {
  if (!import.meta.env.DEV) return;
  if (typeof window === 'undefined') return;
  const w = window as unknown as { downloadTreeTrunkTexture?: () => void };
  if (w.downloadTreeTrunkTexture) return;
  w.downloadTreeTrunkTexture = () => {
    if (!cachedCanvas) return;
    const link = document.createElement('a');
    link.href = cachedCanvas.toDataURL('image/png');
    link.download = 'tree-trunk.png';
    link.click();
  };
}

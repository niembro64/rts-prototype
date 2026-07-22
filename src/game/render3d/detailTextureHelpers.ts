// Shared helpers for the procedural detail-texture generators
// (GroundDetailTexture, RockDetailTexture, TreeLeafTexture, TreeTrunkTexture).
//
// Each of those modules builds a tileable Canvas 2D texture from a stream of
// seeded random shapes. The color conversion, the seeded PRNG, the
// uniform-range helper, the common box/tri/hex shape rasterization, and the
// dev-only PNG download hook were byte-for-byte identical across all four
// files; they live here now so there is a single source of truth.

export function cssRgb(hex: number): string {
  const r = (hex >> 16) & 0xff;
  const g = (hex >> 8) & 0xff;
  const b = hex & 0xff;
  return `rgb(${r}, ${g}, ${b})`;
}

function decodeSrgbByte(value: number): number {
  const channel = value / 255;
  return channel <= 0.04045
    ? channel / 12.92
    : Math.pow((channel + 0.055) / 1.055, 2.4);
}

const SRGB_BYTE_TO_LINEAR = new Float64Array(256);
for (let i = 0; i < SRGB_BYTE_TO_LINEAR.length; i++) {
  SRGB_BYTE_TO_LINEAR[i] = decodeSrgbByte(i);
}

function linearToSrgbByte(value: number): number {
  const channel = Math.max(0, Math.min(1, value));
  const srgb = channel <= 0.0031308
    ? channel * 12.92
    : 1.055 * Math.pow(channel, 1 / 2.4) - 0.055;
  return Math.round(srgb * 255);
}

/**
 * Color-grades an opaque procedural texture so its average albedo matches a
 * flat reference color while retaining the texture's authored variation.
 *
 * The mean and correction are calculated in linear light because Three.js
 * decodes sRGB color textures before filtering and multiplying them into a
 * material. Matching the byte average instead would still make the textured
 * HIGH prop visibly drift from its flat MED/LOW counterpart.
 */
export function matchCanvasLinearMeanToColor(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  targetHex: number,
): void {
  const image = ctx.getImageData(0, 0, width, height);
  const pixels = image.data;
  const sums = [0, 0, 0];
  const pixelCount = pixels.length / 4;
  for (let i = 0; i < pixels.length; i += 4) {
    sums[0] += SRGB_BYTE_TO_LINEAR[pixels[i]];
    sums[1] += SRGB_BYTE_TO_LINEAR[pixels[i + 1]];
    sums[2] += SRGB_BYTE_TO_LINEAR[pixels[i + 2]];
  }

  const target = [
    SRGB_BYTE_TO_LINEAR[(targetHex >> 16) & 0xff],
    SRGB_BYTE_TO_LINEAR[(targetHex >> 8) & 0xff],
    SRGB_BYTE_TO_LINEAR[targetHex & 0xff],
  ];
  const scale = target.map((channel, index) => {
    const mean = sums[index] / pixelCount;
    return mean > 0 ? channel / mean : 1;
  });
  const channelRemap = scale.map((channelScale) => {
    const remap = new Uint8ClampedArray(256);
    for (let value = 0; value < remap.length; value++) {
      remap[value] = linearToSrgbByte(
        SRGB_BYTE_TO_LINEAR[value] * channelScale,
      );
    }
    return remap;
  });

  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i] = channelRemap[0][pixels[i]];
    pixels[i + 1] = channelRemap[1][pixels[i + 1]];
    pixels[i + 2] = channelRemap[2][pixels[i + 2]];
  }
  ctx.putImageData(image, 0, 0);
}

// DETERMINISM-CRITICAL: this xorshift-style PRNG must stay byte-identical to
// the inlined copies the four texture generators used, or every generated
// texture (and the dev-comparison PNGs) would change. Do not "improve" it.
export function makeSeededRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randIn(rng: () => number, min: number, max: number): number {
  return min + rng() * (max - min);
}

// The box / tri / hex shape cases that are identical across all four
// generators. Ground-specific circle / rosette cases stay inline in
// GroundDetailTexture since they are not shared.
export function drawCommonShape(
  ctx: CanvasRenderingContext2D,
  size: number,
  shapeKind: 'box' | 'tri' | 'hex',
  shapeParam: number,
): void {
  const s = size;
  switch (shapeKind) {
    case 'box': {
      const w = s * shapeParam;
      ctx.fillRect(-w / 2, -s / 2, w, s);
      return;
    }
    case 'tri': {
      const halfBase = s * shapeParam;
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

// Installs a dev-only `window[windowKey]()` that downloads the cached canvas
// as a PNG for inspection. No-op outside DEV / outside the browser, and only
// installs once per key. `getCanvas` is read lazily at call time so the helper
// can be installed before the canvas exists.
export function installDetailTextureDevDownloadHelper(
  filename: string,
  getCanvas: () => HTMLCanvasElement | null,
  windowKey: string,
): void {
  if (!import.meta.env.DEV) return;
  if (typeof window === 'undefined') return;
  const w = window as unknown as Record<string, (() => void) | undefined>;
  if (w[windowKey]) return;
  w[windowKey] = () => {
    const canvas = getCanvas();
    if (!canvas) return;
    const link = document.createElement('a');
    link.href = canvas.toDataURL('image/png');
    link.download = filename;
    link.click();
  };
}

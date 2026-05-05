// Hex-int / hex-string → 0..1 RGB conversion helpers, shared by all
// renderers that feed packed-RGB integers (the THREE.js convention for
// color literals: 0xRRGGBB) into per-vertex / per-instance color
// attributes that need 0..1 floats. Centralized so a future format
// change (premultiplied alpha, sRGB → linear, ...) lands in one place.

export type Rgb01 = { r: number; g: number; b: number };

/** Hex-int (0xRRGGBB) → 0..1 RGB. Pre-bake at module load when the
 *  hex is a constant; call per-frame is fine but allocates an object
 *  — use `writeHexToRgb01Array` for the InstancedBufferAttribute
 *  hot paths. */
export function hexToRgb01(hex: number): Rgb01 {
  return {
    r: ((hex >> 16) & 0xff) / 255,
    g: ((hex >>  8) & 0xff) / 255,
    b: ( hex        & 0xff) / 255,
  };
}

/** Allocation-free variant: write the three RGB channels into
 *  `arr[offset..offset+2]`. Used by InstancedBufferAttribute writers
 *  (Float32Array backings) so per-instance color updates don't churn
 *  the heap. */
export function writeHexToRgb01Array(
  hex: number,
  arr: Float32Array | number[] | Uint8ClampedArray,
  offset: number,
): void {
  arr[offset    ] = ((hex >> 16) & 0xff) / 255;
  arr[offset + 1] = ((hex >>  8) & 0xff) / 255;
  arr[offset + 2] = ( hex        & 0xff) / 255;
}

/** Hex-string ('#RRGGBB' or 'RRGGBB') → 0..1 RGB. Used by SHELL_BAR_COLORS
 *  and other config that authors colors as CSS-style strings. */
export function hexStringToRgb(hex: string): Rgb01 {
  return hexToRgb01(parseInt(hex.replace('#', ''), 16));
}

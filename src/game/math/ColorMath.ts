/** Convert a linear-light sRGB component to a gamma-encoded byte. */
export function linearToSrgbByte(value: number): number {
  const channel = !Number.isFinite(value) || value <= 0
    ? 0
    : value >= 1
      ? 1
      : value;
  const srgb = channel <= 0.0031308
    ? channel * 12.92
    : 1.055 * Math.pow(channel, 1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(srgb * 255)));
}

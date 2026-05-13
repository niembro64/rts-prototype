// Shared scanline circle-fill for fog-of-war bitmaps
// (issues.txt FOW-OPT-05).
//
// The server's per-player shroud bitmap (shroudBitmap.ts) and the
// client's per-pixel alphaMap (FogOfWarShroudRenderer3D) both need to
// "mark every cell inside a circle as 1." The naïve bounding-box +
// (dx² + dy²) ≤ r² test is O(diameter²) with a per-cell multiply and
// branch; the scanline form is the same logical set but uses a single
// sqrt per row and a tight inner write loop with no per-cell distance
// math. Big radii (radar / commander vision) get the biggest win.
//
// One helper serves both sites: cell-center sampling is selected by
// passing cellAnchor=0.5 (server, where cells are physical tiles);
// pixel-corner sampling is selected by passing cellAnchor=0 (client,
// where the bitmap entry is a pixel index). The geometry is the same;
// only the offset between cell index and the point we test against
// the circle differs.

/** Mark all cells inside the circle (cx, cy) of radius r on a
 *  row-major byte-per-cell bitmap. Returns true iff any cell flipped
 *  0→1 — callers tracking version counters / dirty flags can use this
 *  signal to skip work when the circle covered already-set ground.
 *
 *  cx, cy, r are in the same units as the bitmap stride (cells for
 *  the server shroud, pixels for the client alphaMap). cellAnchor
 *  picks how the bitmap cell at index `(x, y)` is positioned for the
 *  inside-circle test: 0.5 = cell-center sampling, 0 = cell-corner /
 *  pixel sampling.
 *
 *  Optional rgbBuffer + rgbValue (issues.txt FOW-OPT-17): when the
 *  caller passes an RGBA-byte buffer aligned 1:1 with `bitmap` (4
 *  bytes per cell), each cell that flips 0→1 also writes `rgbValue`
 *  into the RGB channels at the matching offset (alpha channel left
 *  alone — the buffer is expected to have alpha=255 pre-seeded). The
 *  client renderer uses this to keep its alphaMap ImageData
 *  incrementally in sync with `revealed` so paintAlphaMap can skip
 *  the per-frame base-coat loop. */
export function markCircleScanline(
  bitmap: Uint8Array,
  gridW: number,
  gridH: number,
  cx: number,
  cy: number,
  r: number,
  cellAnchor: number,
  rgbBuffer?: Uint8ClampedArray,
  rgbValue?: number,
): boolean {
  if (r <= 0) return false;
  const r2 = r * r;
  const minY = Math.max(0, Math.floor(cy - r));
  const maxY = Math.min(gridH - 1, Math.ceil(cy + r));
  let modified = false;
  const paint = rgbBuffer !== undefined;
  const v = rgbValue ?? 0;
  for (let y = minY; y <= maxY; y++) {
    const dy = y + cellAnchor - cy;
    const dySq = dy * dy;
    if (dySq > r2) continue;
    const xspan = Math.sqrt(r2 - dySq);
    const xMin = Math.max(0, Math.ceil(cx - cellAnchor - xspan));
    const xMax = Math.min(gridW - 1, Math.floor(cx - cellAnchor + xspan));
    if (xMin > xMax) continue;
    const row = y * gridW;
    for (let x = xMin; x <= xMax; x++) {
      const idx = row + x;
      if (bitmap[idx] === 0) {
        bitmap[idx] = 1;
        modified = true;
        if (paint) {
          const p = idx << 2;
          rgbBuffer![p] = v;
          rgbBuffer![p + 1] = v;
          rgbBuffer![p + 2] = v;
        }
      }
    }
  }
  return modified;
}

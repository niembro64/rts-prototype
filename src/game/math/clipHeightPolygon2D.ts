/** A height-bearing vertex in an arbitrary horizontal 2D coordinate system. */
export type HeightPolygonVertex2D = Readonly<{
  horizontal0: number;
  horizontal1: number;
  height: number;
}>;

type HeightPolygonCoordinate = 'horizontal0' | 'horizontal1';

/**
 * Clip a convex height polygon against one axis-aligned half-plane.
 *
 * This is one Sutherland-Hodgman pass. Interpolation order is intentionally
 * fixed so terrain rendering and authoritative buildability get identical
 * boundary heights.
 */
export function clipHeightPolygon2D(
  input: readonly HeightPolygonVertex2D[],
  coordinate: HeightPolygonCoordinate,
  limit: number,
  keepGreater: boolean,
): HeightPolygonVertex2D[] {
  if (input.length === 0) return [];
  const inside = (value: number): boolean => keepGreater ? value >= limit : value <= limit;
  const output: HeightPolygonVertex2D[] = [];
  let previous = input[input.length - 1];
  let previousValue = previous[coordinate];
  let previousInside = inside(previousValue);
  for (const current of input) {
    const currentValue = current[coordinate];
    const currentInside = inside(currentValue);
    if (currentInside !== previousInside) {
      const denominator = currentValue - previousValue;
      if (Math.abs(denominator) > 1e-12) {
        const t = Math.max(0, Math.min(1, (limit - previousValue) / denominator));
        output.push({
          horizontal0: previous.horizontal0 + (current.horizontal0 - previous.horizontal0) * t,
          horizontal1: previous.horizontal1 + (current.horizontal1 - previous.horizontal1) * t,
          height: previous.height + (current.height - previous.height) * t,
        });
      }
    }
    if (currentInside) output.push(current);
    previous = current;
    previousValue = currentValue;
    previousInside = currentInside;
  }
  return output;
}

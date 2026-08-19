// AlphaMaskExtrusion3D — closed outlines traced out of a painted 2D-canvas
// alpha mask, so canvas art can become real extruded geometry.
//
// The renderer paints its text with Canvas 2D (one code path, every system
// font, no font-outline asset to ship). Canvas hands back pixels, not
// outlines, so this module recovers the outlines: marching squares with
// interpolated crossings follows the glyph's antialiased edge rather than its
// pixel staircase, the resulting segments are chained into closed loops,
// simplified, and nested — so letters with counters (O, e, R) extrude with
// real holes instead of filled blobs.
//
// Pure math on a flat alpha array: no THREE, no DOM, so the contract test can
// hold its invariants headlessly.

/** A closed loop as flat `x0, y0, x1, y1, …` mask coordinates. The closing
 *  edge back to the first point is implicit. */
export type MaskPolygon = readonly number[];

/** One extrudable island: an outline and the holes punched through it. */
export type MaskContourGroup = {
  readonly outline: MaskPolygon;
  readonly holes: readonly MaskPolygon[];
};

export type AlphaMaskContourOptions = {
  /** Alpha in [0, 1] the surface is cut at. 0.5 puts the outline on the
   *  antialiased edge's half-covered texels, where the eye reads the glyph
   *  boundary. */
  readonly threshold: number;
  /** Douglas–Peucker tolerance in mask pixels. Marching squares emits a point
   *  per crossed cell edge; almost all of them sit on straight stem walls. */
  readonly simplifyTolerance: number;
  /** Loops smaller than this (square mask pixels) are antialiasing specks and
   *  stray accent fragments, not shapes worth extruding. */
  readonly minimumArea: number;
};

/** Shoelace area. Sign reports winding; callers that only nest shapes use the
 *  magnitude, because marching-squares winding depends on which corner the
 *  loop happened to start at. */
export function polygonSignedArea(points: MaskPolygon): number {
  const count = points.length / 2;
  if (count < 3) return 0;
  let sum = 0;
  let previousX = points[(count - 1) * 2];
  let previousY = points[(count - 1) * 2 + 1];
  for (let i = 0; i < count; i++) {
    const x = points[i * 2];
    const y = points[i * 2 + 1];
    sum += previousX * y - x * previousY;
    previousX = x;
    previousY = y;
  }
  return sum * 0.5;
}

/** Even-odd crossing test. Points exactly on an edge are undefined either
 *  way, which is fine for nesting: glyph outlines never touch. */
export function polygonContainsPoint(
  polygon: MaskPolygon,
  x: number,
  y: number,
): boolean {
  const count = polygon.length / 2;
  let inside = false;
  for (let i = 0, j = count - 1; i < count; j = i++) {
    const xi = polygon[i * 2];
    const yi = polygon[i * 2 + 1];
    const xj = polygon[j * 2];
    const yj = polygon[j * 2 + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Trace every closed outline in `alpha` (one byte per mask texel, row major).
 *
 * Coordinates are in mask-texel space, where integer `x` is the CENTRE of
 * column `x`. Samples outside the array read as 0, so a shape that runs to the
 * edge still closes instead of leaving an open polyline.
 */
export function traceAlphaMaskContours(
  alpha: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  options: AlphaMaskContourOptions,
): MaskPolygon[] {
  if (width <= 0 || height <= 0) return [];
  const threshold = options.threshold;
  const sample = (x: number, y: number): number => {
    if (x < 0 || y < 0 || x >= width || y >= height) return 0;
    return alpha[y * width + x] / 255;
  };
  // Where between two samples the surface crosses the threshold. Both cells
  // sharing an edge evaluate this from the same pair of corner values, so the
  // two crossing points are bit-identical and the loop chaining below can key
  // on exact coordinates.
  const crossing = (low: number, high: number): number => {
    const span = high - low;
    if (span === 0) return 0.5;
    return Math.min(1, Math.max(0, (threshold - low) / span));
  };

  const pointIds = new Map<string, number>();
  const pointCoords: number[] = [];
  const neighbors: number[][] = [];
  const pointId = (x: number, y: number): number => {
    const key = `${x},${y}`;
    const existing = pointIds.get(key);
    if (existing !== undefined) return existing;
    const id = pointCoords.length / 2;
    pointIds.set(key, id);
    pointCoords.push(x, y);
    neighbors.push([]);
    return id;
  };
  const link = (ax: number, ay: number, bx: number, by: number): void => {
    const a = pointId(ax, ay);
    const b = pointId(bx, by);
    if (a === b) return;
    neighbors[a].push(b);
    neighbors[b].push(a);
  };

  // One cell per gap between samples, plus a ring of cells one step outside
  // the mask so edge-touching shapes close against the implicit zero border.
  for (let y = -1; y < height; y++) {
    for (let x = -1; x < width; x++) {
      const topLeft = sample(x, y);
      const topRight = sample(x + 1, y);
      const bottomRight = sample(x + 1, y + 1);
      const bottomLeft = sample(x, y + 1);
      const code =
        (topLeft >= threshold ? 1 : 0) |
        (topRight >= threshold ? 2 : 0) |
        (bottomRight >= threshold ? 4 : 0) |
        (bottomLeft >= threshold ? 8 : 0);
      if (code === 0 || code === 15) continue;
      const topX = x + crossing(topLeft, topRight);
      const rightY = y + crossing(topRight, bottomRight);
      const bottomX = x + crossing(bottomLeft, bottomRight);
      const leftY = y + crossing(topLeft, bottomLeft);
      const top: readonly [number, number] = [topX, y];
      const right: readonly [number, number] = [x + 1, rightY];
      const bottom: readonly [number, number] = [bottomX, y + 1];
      const left: readonly [number, number] = [x, leftY];
      const connect = (
        a: readonly [number, number],
        b: readonly [number, number],
      ): void => link(a[0], a[1], b[0], b[1]);
      switch (code) {
        case 1: case 14: connect(left, top); break;
        case 2: case 13: connect(top, right); break;
        case 3: case 12: connect(left, right); break;
        case 4: case 11: connect(right, bottom); break;
        case 6: case 9: connect(top, bottom); break;
        case 7: case 8: connect(left, bottom); break;
        // Saddles. The cell centre decides whether the two inside corners are
        // one waist or two separate tips; the asymptotic decider is the usual
        // choice and keeps thin strokes from pinching apart.
        case 5: {
          const centre = (topLeft + topRight + bottomRight + bottomLeft) * 0.25;
          if (centre >= threshold) {
            connect(top, right);
            connect(left, bottom);
          } else {
            connect(left, top);
            connect(right, bottom);
          }
          break;
        }
        case 10: {
          const centre = (topLeft + topRight + bottomRight + bottomLeft) * 0.25;
          if (centre >= threshold) {
            connect(left, top);
            connect(right, bottom);
          } else {
            connect(top, right);
            connect(left, bottom);
          }
          break;
        }
        default: break;
      }
    }
  }

  // Every crossing point is shared by exactly two cells and used once by each,
  // so the graph is a union of simple cycles: walking neighbours without
  // doubling back traverses one whole loop.
  const pointCount = pointCoords.length / 2;
  const visited = new Uint8Array(pointCount);
  const polygons: MaskPolygon[] = [];
  for (let start = 0; start < pointCount; start++) {
    if (visited[start] === 1 || neighbors[start].length < 2) continue;
    const loop: number[] = [];
    let previous = -1;
    let current = start;
    let closed = false;
    for (;;) {
      visited[current] = 1;
      loop.push(pointCoords[current * 2], pointCoords[current * 2 + 1]);
      const links = neighbors[current];
      let next = -1;
      for (let k = 0; k < links.length; k++) {
        if (links[k] !== previous) {
          next = links[k];
          break;
        }
      }
      if (next < 0) break;
      if (next === start) {
        closed = true;
        break;
      }
      if (visited[next] === 1) break;
      previous = current;
      current = next;
    }
    if (!closed) continue;
    const simplified = simplifyClosedPolygon(loop, options.simplifyTolerance);
    if (simplified.length < 6) continue;
    if (Math.abs(polygonSignedArea(simplified)) < options.minimumArea) continue;
    polygons.push(simplified);
  }
  return polygons;
}

/**
 * Sort traced loops into extrudable islands. Nesting depth decides the role —
 * a loop inside an odd number of others is a hole, anything else is an
 * outline — so the counter of an O becomes a hole while the dot inside that
 * counter (were a glyph to have one) becomes an island of its own.
 */
export function groupNestedContours(
  polygons: readonly MaskPolygon[],
): MaskContourGroup[] {
  const areas = polygons.map((polygon) => Math.abs(polygonSignedArea(polygon)));
  const parents = polygons.map((polygon, index) => {
    let parent = -1;
    let parentArea = Infinity;
    for (let other = 0; other < polygons.length; other++) {
      if (other === index || areas[other] <= areas[index]) continue;
      if (!polygonContainsPoint(polygons[other], polygon[0], polygon[1])) continue;
      if (areas[other] < parentArea) {
        parent = other;
        parentArea = areas[other];
      }
    }
    return parent;
  });
  const depths = polygons.map((_, index) => {
    let depth = 0;
    let walk = parents[index];
    while (walk >= 0 && depth <= polygons.length) {
      depth++;
      walk = parents[walk];
    }
    return depth;
  });
  const groups: MaskContourGroup[] = [];
  const groupForOutline = new Map<number, number>();
  for (let index = 0; index < polygons.length; index++) {
    if (depths[index] % 2 !== 0) continue;
    groupForOutline.set(index, groups.length);
    groups.push({ outline: polygons[index], holes: [] });
  }
  for (let index = 0; index < polygons.length; index++) {
    if (depths[index] % 2 === 0) continue;
    const group = groupForOutline.get(parents[index]);
    if (group === undefined) continue;
    (groups[group].holes as MaskPolygon[]).push(polygons[index]);
  }
  return groups;
}

// ── internals ──

/** Douglas–Peucker on a closed loop: split it at its two most distant points
 *  first, because a closed ring has no natural endpoints to anchor on. */
function simplifyClosedPolygon(points: number[], tolerance: number): number[] {
  const count = points.length / 2;
  if (count < 4 || tolerance <= 0) return points;
  let farthest = 0;
  let farthestDistanceSq = -1;
  for (let i = 1; i < count; i++) {
    const dx = points[i * 2] - points[0];
    const dy = points[i * 2 + 1] - points[1];
    const distanceSq = dx * dx + dy * dy;
    if (distanceSq > farthestDistanceSq) {
      farthestDistanceSq = distanceSq;
      farthest = i;
    }
  }
  const first = simplifyOpenPolyline(points, 0, farthest, tolerance);
  const second = simplifyOpenPolyline(points, farthest, count, tolerance);
  // Both halves carry their shared split point; the second also wraps back to
  // index 0, which the implicit closing edge already covers.
  return [...first, ...second.slice(2, second.length - 2)];
}

/** Simplify `points[from … to)` (`to` may be the wrapped end index `count`,
 *  meaning "back to point 0"), returning a flat inclusive-endpoint list. */
function simplifyOpenPolyline(
  points: number[],
  from: number,
  to: number,
  tolerance: number,
): number[] {
  const count = points.length / 2;
  const at = (index: number): readonly [number, number] => {
    const wrapped = index % count;
    return [points[wrapped * 2], points[wrapped * 2 + 1]];
  };
  const keep = new Uint8Array(to - from + 1);
  keep[0] = 1;
  keep[to - from] = 1;
  const stack: Array<readonly [number, number]> = [[from, to]];
  const toleranceSq = tolerance * tolerance;
  while (stack.length > 0) {
    const segment = stack.pop();
    if (segment === undefined) break;
    const [startIndex, endIndex] = segment;
    if (endIndex - startIndex < 2) continue;
    const [ax, ay] = at(startIndex);
    const [bx, by] = at(endIndex);
    const dx = bx - ax;
    const dy = by - ay;
    const lengthSq = dx * dx + dy * dy;
    let worst = -1;
    let worstDistanceSq = -1;
    for (let i = startIndex + 1; i < endIndex; i++) {
      const [px, py] = at(i);
      let distanceSq: number;
      if (lengthSq === 0) {
        distanceSq = (px - ax) * (px - ax) + (py - ay) * (py - ay);
      } else {
        const t = Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / lengthSq));
        const cx = ax + t * dx - px;
        const cy = ay + t * dy - py;
        distanceSq = cx * cx + cy * cy;
      }
      if (distanceSq > worstDistanceSq) {
        worstDistanceSq = distanceSq;
        worst = i;
      }
    }
    if (worst < 0 || worstDistanceSq <= toleranceSq) continue;
    keep[worst - from] = 1;
    stack.push([startIndex, worst], [worst, endIndex]);
  }
  const result: number[] = [];
  for (let i = from; i <= to; i++) {
    if (keep[i - from] !== 1) continue;
    const [x, y] = at(i);
    result.push(x, y);
  }
  return result;
}

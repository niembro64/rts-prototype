import {
  clipHeightPolygon2D,
  type HeightPolygonVertex2D,
} from './clipHeightPolygon2D';

function assertContract(condition: boolean, message: string): void {
  if (!condition) throw new Error(`[height polygon clip contract] ${message}`);
}

function vertexKey(vertex: HeightPolygonVertex2D): string {
  return `${vertex.horizontal0.toFixed(6)},${vertex.horizontal1.toFixed(6)},${vertex.height.toFixed(6)}`;
}

export function runClipHeightPolygon2DContractTest(): void {
  // Height is the affine plane h = horizontal0 + 2 * horizontal1. Clipping
  // must preserve that plane exactly at every newly interpolated boundary.
  let polygon: HeightPolygonVertex2D[] = [
    { horizontal0: 0, horizontal1: 0, height: 0 },
    { horizontal0: 2, horizontal1: 0, height: 2 },
    { horizontal0: 2, horizontal1: 2, height: 6 },
    { horizontal0: 0, horizontal1: 2, height: 4 },
  ];
  polygon = clipHeightPolygon2D(polygon, 'horizontal0', 0.5, true);
  polygon = clipHeightPolygon2D(polygon, 'horizontal0', 1.5, false);
  polygon = clipHeightPolygon2D(polygon, 'horizontal1', 0.5, true);
  polygon = clipHeightPolygon2D(polygon, 'horizontal1', 1.5, false);

  const actual = polygon.map(vertexKey).sort();
  const expected = [
    '0.500000,0.500000,1.500000',
    '0.500000,1.500000,3.500000',
    '1.500000,0.500000,2.500000',
    '1.500000,1.500000,4.500000',
  ].sort();
  assertContract(
    actual.join('|') === expected.join('|'),
    'four half-plane passes preserve clipped coordinates and interpolated heights',
  );
  assertContract(
    clipHeightPolygon2D([], 'horizontal0', 0, true).length === 0,
    'an empty polygon remains empty',
  );
}

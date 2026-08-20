type PointXZ = Readonly<{ x: number; z: number }>;

export function signedPolygonAreaXZ(points: readonly PointXZ[]): number {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    area += a.x * b.z - b.x * a.z;
  }
  return area * 0.5;
}

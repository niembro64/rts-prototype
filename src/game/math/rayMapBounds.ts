const RAY_DIRECTION_EPSILON = 1e-6;

export function rayDistanceToMapEdge(
  x: number,
  y: number,
  dirX: number,
  dirY: number,
  mapWidth: number,
  mapHeight: number,
): number {
  let distance = Number.POSITIVE_INFINITY;
  if (dirX > RAY_DIRECTION_EPSILON) {
    distance = Math.min(distance, (mapWidth - x) / dirX);
  } else if (dirX < -RAY_DIRECTION_EPSILON) {
    distance = Math.min(distance, -x / dirX);
  }
  if (dirY > RAY_DIRECTION_EPSILON) {
    distance = Math.min(distance, (mapHeight - y) / dirY);
  } else if (dirY < -RAY_DIRECTION_EPSILON) {
    distance = Math.min(distance, -y / dirY);
  }
  return Number.isFinite(distance) ? Math.max(0, distance) : 0;
}

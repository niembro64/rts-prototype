const FULL_ROTATION_RADIANS = Math.PI * 2;
const RATIO_DELTA_EPSILON = 1e-9;

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export function snapshotPositionThresholdWorldUnits(
  ratio: number,
  mapWidth: number,
  mapHeight: number,
): number {
  return finiteNonNegative(ratio) * Math.max(mapWidth, mapHeight, 1);
}

export function snapshotRotationThresholdRadians(ratio: number): number {
  return finiteNonNegative(ratio) * FULL_ROTATION_RADIANS;
}

export function snapshotAngularDistanceRadians(a: number, b: number): number {
  const raw = Math.abs(a - b) % FULL_ROTATION_RADIANS;
  return raw > Math.PI ? FULL_ROTATION_RADIANS - raw : raw;
}

export function snapshotPositionDeltaExceeded(
  nextX: number,
  nextY: number,
  nextZ: number,
  prevX: number,
  prevY: number,
  prevZ: number,
  thresholdWorldUnits: number,
): boolean {
  return Math.hypot(nextX - prevX, nextY - prevY, nextZ - prevZ) > thresholdWorldUnits;
}

export function snapshotRotationDeltaExceeded(
  next: number,
  prev: number,
  thresholdRadians: number,
): boolean {
  return snapshotAngularDistanceRadians(next, prev) > thresholdRadians;
}

export function snapshotVectorMagnitudeRatioDeltaExceeded(
  nextX: number,
  nextY: number,
  nextZ: number,
  prevX: number,
  prevY: number,
  prevZ: number,
  ratio: number,
): boolean {
  const nextMagnitude = Math.hypot(nextX, nextY, nextZ);
  const baseline = Math.hypot(prevX, prevY, prevZ);
  const delta = Math.abs(nextMagnitude - baseline);
  return delta > RATIO_DELTA_EPSILON && delta > baseline * finiteNonNegative(ratio);
}

export function snapshotVectorDirectionDeltaExceeded(
  nextX: number,
  nextY: number,
  nextZ: number,
  prevX: number,
  prevY: number,
  prevZ: number,
  thresholdRadians: number,
): boolean {
  const nextMagnitude = Math.hypot(nextX, nextY, nextZ);
  const prevMagnitude = Math.hypot(prevX, prevY, prevZ);
  if (nextMagnitude <= RATIO_DELTA_EPSILON || prevMagnitude <= RATIO_DELTA_EPSILON) {
    return false;
  }

  const threshold = finiteNonNegative(thresholdRadians);
  if (threshold >= Math.PI) return false;

  const normalizedDot = Math.max(
    -1,
    Math.min(
      1,
      (nextX * prevX + nextY * prevY + nextZ * prevZ) / (nextMagnitude * prevMagnitude),
    ),
  );
  return normalizedDot < Math.cos(threshold);
}

export function snapshotVectorVelocityDeltaExceeded(
  nextX: number,
  nextY: number,
  nextZ: number,
  prevX: number,
  prevY: number,
  prevZ: number,
  magnitudeRatio: number,
  directionThresholdRadians: number,
): boolean {
  return snapshotVectorMagnitudeRatioDeltaExceeded(
    nextX, nextY, nextZ,
    prevX, prevY, prevZ,
    magnitudeRatio,
  ) || snapshotVectorDirectionDeltaExceeded(
    nextX, nextY, nextZ,
    prevX, prevY, prevZ,
    directionThresholdRadians,
  );
}

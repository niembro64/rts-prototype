const FULL_ROTATION_RADIANS = Math.PI * 2;
const RATIO_DELTA_EPSILON = 1e-9;

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}


export function snapshotRotationThresholdRadians(ratio: number): number {
  return finiteNonNegative(ratio) * FULL_ROTATION_RADIANS;
}




function snapshotVectorMagnitudeRatioDeltaExceeded(
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
  // Zero is a semantic edge: a nonzero↔zero transition always emits no
  // matter how the ratio is configured — otherwise a ratio >= 1 would let
  // a stopped body keep integrating its stale last-sent velocity forever.
  if ((baseline <= RATIO_DELTA_EPSILON) !== (nextMagnitude <= RATIO_DELTA_EPSILON)) {
    return delta > RATIO_DELTA_EPSILON;
  }
  return delta > RATIO_DELTA_EPSILON && delta > baseline * finiteNonNegative(ratio);
}

function snapshotVectorDirectionDeltaExceeded(
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

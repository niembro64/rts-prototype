import type { ClientPredictionCorrectionStats } from './ClientPredictionDiagnostics';

type SnapshotCorrectionApplyStats = {
  correction: ClientPredictionCorrectionStats;
};

/** Accumulate one predicted-vs-server position correction sample plus the
 *  age of the server target it replaced. Call sites own computing the
 *  deltas from their wire/DTO source; the accumulation math is shared so
 *  the snapshot apply paths cannot drift apart. */
export function recordSnapshotCorrectionStats(
  applyStats: SnapshotCorrectionApplyStats,
  dx: number,
  dy: number,
  dz: number,
  previousTargetAgeMs: number,
): void {
  const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
  applyStats.correction.count++;
  applyStats.correction.totalDistance += distance;
  if (distance > applyStats.correction.maxDistance) {
    applyStats.correction.maxDistance = distance;
  }
  if (previousTargetAgeMs > 0) {
    applyStats.correction.targetAgeCount++;
    applyStats.correction.totalTargetAgeMs += previousTargetAgeMs;
    if (previousTargetAgeMs > applyStats.correction.maxTargetAgeMs) {
      applyStats.correction.maxTargetAgeMs = previousTargetAgeMs;
    }
  }
}

/** Accumulate one predicted-vs-server velocity correction sample. */
export function recordSnapshotVelocityCorrectionStats(
  applyStats: SnapshotCorrectionApplyStats,
  dvx: number,
  dvy: number,
  dvz: number,
): void {
  const velocityDelta = Math.sqrt(dvx * dvx + dvy * dvy + dvz * dvz);
  applyStats.correction.velocityCount++;
  applyStats.correction.totalVelocityDelta += velocityDelta;
  if (velocityDelta > applyStats.correction.maxVelocityDelta) {
    applyStats.correction.maxVelocityDelta = velocityDelta;
  }
}

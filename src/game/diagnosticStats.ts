export type RunningStats = {
  count: number;
  total: number;
  max: number;
};

export function createRunningStats(): RunningStats {
  return { count: 0, total: 0, max: 0 };
}

export function addRunningStat(stats: RunningStats, value: number): void {
  if (!Number.isFinite(value)) return;
  stats.count++;
  stats.total += value;
  if (value > stats.max) stats.max = value;
}

export function averageRunningStat(stats: RunningStats): number | null {
  return stats.count > 0 ? stats.total / stats.count : null;
}

export function formatRunningAverage(stats: RunningStats, digits = 2): number | string {
  const average = averageRunningStat(stats);
  return average === null ? 'n/a' : Number(average.toFixed(digits));
}

export function formatRunningMax(stats: RunningStats, digits = 2): number | string {
  return stats.count > 0 ? Number(stats.max.toFixed(digits)) : 'n/a';
}

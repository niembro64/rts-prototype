import type { SnapshotRate, KeyframeRatio, TickRate, ServerBarConfig } from './types/server';

export const SERVER_CONFIG = {
  tickRate: {
    default: 128 as TickRate,
    options: [1, 4, 8, 16, 32, 64, 128, 256] as readonly TickRate[],
  },
  snapshot: {
    default: 32 as SnapshotRate,
    options: [1, 4, 8, 16, 32, 64, 128] as readonly SnapshotRate[],
    // 'none' removed — uncapped SPS at high TPS causes delta snapshot issues
  },
  gridInfo: { default: false },
  keyframe: {
    default: (1 / Math.pow(2, 6)) as KeyframeRatio,
    options: [
      'ALL',
      1 / Math.pow(2, 3),
      1 / Math.pow(2, 6),
      1 / Math.pow(2, 9),
      'NONE',
    ] as readonly KeyframeRatio[],
  },
} as const satisfies ServerBarConfig;

// ── localStorage keys (module-private) ──
const STORAGE_SNAPSHOT_RATE = 'rts-snapshot-rate';
const STORAGE_KEYFRAME_RATIO = 'rts-keyframe-ratio';
const STORAGE_TICK_RATE = 'rts-tick-rate';
const STORAGE_GRID_INFO = 'rts-grid-info';

export function loadStoredSnapshotRate(): SnapshotRate {
  try {
    const stored = localStorage.getItem(STORAGE_SNAPSHOT_RATE);
    if (stored === 'none') return 'none';
    if (stored) {
      const num = Number(stored);
      if (!isNaN(num) && num > 0) return num;
    }
  } catch { /* localStorage unavailable */ }
  return SERVER_CONFIG.snapshot.default;
}

export function saveSnapshotRate(rate: SnapshotRate): void {
  try { localStorage.setItem(STORAGE_SNAPSHOT_RATE, String(rate)); } catch { /* */ }
}

export function loadStoredKeyframeRatio(): KeyframeRatio {
  try {
    const stored = localStorage.getItem(STORAGE_KEYFRAME_RATIO);
    if (stored === 'ALL') return 'ALL';
    if (stored === 'NONE') return 'NONE';
    if (stored) {
      const num = Number(stored);
      if (!isNaN(num)) return num;
    }
  } catch { /* localStorage unavailable */ }
  return SERVER_CONFIG.keyframe.default;
}

export function saveKeyframeRatio(ratio: KeyframeRatio): void {
  try { localStorage.setItem(STORAGE_KEYFRAME_RATIO, String(ratio)); } catch { /* */ }
}

export function loadStoredTickRate(): TickRate {
  try {
    const stored = localStorage.getItem(STORAGE_TICK_RATE);
    if (stored) {
      const num = Number(stored);
      if (!isNaN(num) && num > 0) return num;
    }
  } catch { /* localStorage unavailable */ }
  return SERVER_CONFIG.tickRate.default;
}

export function saveTickRate(rate: TickRate): void {
  try { localStorage.setItem(STORAGE_TICK_RATE, String(rate)); } catch { /* */ }
}

export function loadStoredGridInfo(): boolean {
  try {
    const stored = localStorage.getItem(STORAGE_GRID_INFO);
    if (stored === 'false') return false;
    if (stored === 'true') return true;
  } catch { /* localStorage unavailable */ }
  return SERVER_CONFIG.gridInfo.default;
}

export function saveGridInfo(enabled: boolean): void {
  try { localStorage.setItem(STORAGE_GRID_INFO, String(enabled)); } catch { /* */ }
}

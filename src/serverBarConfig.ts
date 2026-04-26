import type { SnapshotRate, KeyframeRatio, TickRate, ServerBarConfig } from './types/server';
import type { ServerSimQuality } from './types/serverSimLod';
import { persist, readPersisted } from './persistence';

export const SERVER_CONFIG = {
  tickRate: {
    default: 128 as TickRate,
    options: [1, 4, 8, 16, 32, 64, 128, 256, 512] as readonly TickRate[],
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
const STORAGE_SIM_QUALITY = 'rts-sim-quality';

const VALID_SIM_QUALITIES: readonly ServerSimQuality[] = [
  'auto', 'auto-tps', 'auto-cpu', 'auto-units',
  'min', 'low', 'medium', 'high', 'max',
];

export function loadStoredSimQuality(): ServerSimQuality {
  const stored = readPersisted(STORAGE_SIM_QUALITY);
  if (stored && (VALID_SIM_QUALITIES as readonly string[]).includes(stored)) {
    return stored as ServerSimQuality;
  }
  return 'auto';
}

export function saveSimQuality(q: ServerSimQuality): void {
  persist(STORAGE_SIM_QUALITY, q);
}

export function loadStoredSnapshotRate(): SnapshotRate {
  const stored = readPersisted(STORAGE_SNAPSHOT_RATE);
  if (stored === 'none') return 'none';
  if (stored) {
    const num = Number(stored);
    if (!isNaN(num) && num > 0) return num;
  }
  return SERVER_CONFIG.snapshot.default;
}

export function saveSnapshotRate(rate: SnapshotRate): void {
  persist(STORAGE_SNAPSHOT_RATE, String(rate));
}

export function loadStoredKeyframeRatio(): KeyframeRatio {
  const stored = readPersisted(STORAGE_KEYFRAME_RATIO);
  if (stored === 'ALL') return 'ALL';
  if (stored === 'NONE') return 'NONE';
  if (stored) {
    const num = Number(stored);
    if (!isNaN(num)) return num;
  }
  return SERVER_CONFIG.keyframe.default;
}

export function saveKeyframeRatio(ratio: KeyframeRatio): void {
  persist(STORAGE_KEYFRAME_RATIO, String(ratio));
}

export function loadStoredTickRate(): TickRate {
  const stored = readPersisted(STORAGE_TICK_RATE);
  if (stored) {
    const num = Number(stored);
    if (!isNaN(num) && num > 0) return num;
  }
  return SERVER_CONFIG.tickRate.default;
}

export function saveTickRate(rate: TickRate): void {
  persist(STORAGE_TICK_RATE, String(rate));
}

export function loadStoredGridInfo(): boolean {
  const stored = readPersisted(STORAGE_GRID_INFO);
  if (stored === 'false') return false;
  if (stored === 'true') return true;
  return SERVER_CONFIG.gridInfo.default;
}

export function saveGridInfo(enabled: boolean): void {
  persist(STORAGE_GRID_INFO, String(enabled));
}

import type { SnapshotRate, KeyframeRatio, TickRate, ServerBarConfig } from './types/server';
import type { ServerSimQuality, ServerSimSignalStates } from './types/serverSimLod';
import type { SignalState } from './types/lod';
import { persist, persistJson, readPersisted } from './persistence';

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

// Includes legacy auto-tps / auto-cpu / auto-units for backward
// compat — those are migrated to 'auto' + a SOLO signal state on
// load. Kept as plain strings here so the type union doesn't have
// to carry them.
const VALID_SIM_QUALITIES: readonly string[] = [
  'auto', 'auto-tps', 'auto-cpu', 'auto-units',
  'min', 'low', 'medium', 'high', 'max',
];

export function loadStoredSimQuality(): ServerSimQuality {
  const stored = readPersisted(STORAGE_SIM_QUALITY);
  if (stored && VALID_SIM_QUALITIES.includes(stored)) {
    // Migrate legacy auto-X to 'auto'. The corresponding SOLO
    // signal state is set by loadStoredSimSignalStates().
    if (stored === 'auto-tps' || stored === 'auto-cpu' || stored === 'auto-units') {
      return 'auto';
    }
    return stored as ServerSimQuality;
  }
  return 'auto';
}

export function saveSimQuality(q: ServerSimQuality): void {
  persist(STORAGE_SIM_QUALITY, q);
}

const STORAGE_SIM_SIGNAL_STATES = 'rts-sim-signal-states';

export function loadStoredSimSignalStates(): ServerSimSignalStates {
  // Default: every signal ACTIVE (contributes to AUTO's min).
  const def: ServerSimSignalStates = { tps: 'active', cpu: 'active', units: 'active' };

  // Migration path: a previous session may have stored an
  // auto-{signal} string in STORAGE_SIM_QUALITY. Translate that
  // to a SOLO state on the matching signal so the user's intent
  // ("only this signal drives") survives the schema change.
  const storedQuality = readPersisted(STORAGE_SIM_QUALITY);
  const storedSignals = readPersisted(STORAGE_SIM_SIGNAL_STATES);
  if (!storedSignals) {
    if (storedQuality === 'auto-tps') return { tps: 'solo', cpu: 'off', units: 'off' };
    if (storedQuality === 'auto-cpu') return { tps: 'off', cpu: 'solo', units: 'off' };
    if (storedQuality === 'auto-units') return { tps: 'off', cpu: 'off', units: 'solo' };
    return def;
  }
  try {
    const parsed = JSON.parse(storedSignals);
    const valid = (s: unknown): s is SignalState =>
      s === 'off' || s === 'active' || s === 'solo';
    if (parsed && typeof parsed === 'object') {
      if (valid(parsed.tps)) def.tps = parsed.tps;
      if (valid(parsed.cpu)) def.cpu = parsed.cpu;
      if (valid(parsed.units)) def.units = parsed.units;
    }
  } catch { /* ignore malformed */ }
  return def;
}

export function saveSimSignalStates(states: ServerSimSignalStates): void {
  persistJson(STORAGE_SIM_SIGNAL_STATES, states);
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

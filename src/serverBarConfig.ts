import type { SnapshotRate, KeyframeRatio, TickRate, ServerBarConfig } from './types/server';
import type { ServerSimQuality, ServerSimSignalStates } from './types/serverSimLod';
import { isSignalState } from './types/lod';
import { persist, persistJson, readPersisted, migrateKey } from './persistence';
import {
  SERVER_SIM_LOD_SIGNAL_DEFAULTS,
  SERVER_SIM_QUALITY_DEFAULT,
} from './serverSimLodConfig';
import { TILT_EMA_MODE_DEFAULT, type TiltEmaMode } from './shellConfig';

export const HOST_SNAPSHOT_RATE_NORMAL_MIN = 5;
export const HOST_SNAPSHOT_RATE_NORMAL_MAX = 10;
export const HOST_SNAPSHOT_RATE_DIAGNOSTIC_MIN = 16;
export const HOST_SNAPSHOT_RATE_DEFAULT: SnapshotRate = 8;
export const HOST_SNAPSHOT_RATE_OPTIONS: readonly SnapshotRate[] = [
  1, 4, 5, 8, 10, 16, 32, 64, 128,
];
export const LEGACY_UNCAPPED_SNAPSHOT_RATE_FALLBACK = 60;

export function isNormalSnapshotRate(rate: SnapshotRate): boolean {
  return (
    typeof rate === 'number' &&
    rate >= HOST_SNAPSHOT_RATE_NORMAL_MIN &&
    rate <= HOST_SNAPSHOT_RATE_NORMAL_MAX
  );
}

export function isDiagnosticSnapshotRate(rate: SnapshotRate): boolean {
  return typeof rate === 'number' && rate >= HOST_SNAPSHOT_RATE_DIAGNOSTIC_MIN;
}

export function isSnapshotRateOption(rate: SnapshotRate): boolean {
  return HOST_SNAPSHOT_RATE_OPTIONS.includes(rate);
}

export function normalizeSnapshotRate(rate: SnapshotRate): SnapshotRate {
  return isSnapshotRateOption(rate) ? rate : HOST_SNAPSHOT_RATE_DEFAULT;
}

export function parseSnapshotRate(value: string | null | undefined): SnapshotRate {
  if (!value) return HOST_SNAPSHOT_RATE_DEFAULT;
  if (value === 'none') return HOST_SNAPSHOT_RATE_DEFAULT;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return HOST_SNAPSHOT_RATE_DEFAULT;
  return normalizeSnapshotRate(parsed);
}

export function snapshotRateHz(
  rate: SnapshotRate,
  uncappedFallback = LEGACY_UNCAPPED_SNAPSHOT_RATE_FALLBACK,
): number {
  return rate === 'none' ? uncappedFallback : rate;
}

export function snapshotRateIntervalMs(rate: SnapshotRate): number {
  const normalized = normalizeSnapshotRate(rate);
  return normalized === 'none' ? 0 : 1000 / normalized;
}

export function snapshotRateLabel(rate: SnapshotRate): string {
  return rate === 'none' ? 'NONE' : String(rate);
}

export function snapshotRateTitle(rate: SnapshotRate): string {
  if (isNormalSnapshotRate(rate)) {
    return `Normal authoritative snapshot cap: ${rate}/sec.`;
  }
  if (isDiagnosticSnapshotRate(rate)) {
    return `Diagnostic snapshot cap: ${rate}/sec for low-unit-count testing.`;
  }
  if (rate === 'none') {
    return 'Legacy uncapped snapshots; normalized back to the normal default.';
  }
  return `Low-cadence snapshot cap: ${rate}/sec for prediction stress testing.`;
}

export const SERVER_CONFIG = {
  tickRate: {
    default: 32 as TickRate,
    options: [1, 4, 8, 16, 32, 64, 128, 256, 512] as readonly TickRate[],
  },
  tiltEma: {
    default: TILT_EMA_MODE_DEFAULT,
    options: ['snap', 'fast', 'mid', 'slow'] as readonly TiltEmaMode[],
  },
  snapshot: {
    default: HOST_SNAPSHOT_RATE_DEFAULT,
    options: HOST_SNAPSHOT_RATE_OPTIONS,
    // 5-10 SPS is normal play. 16+ SPS remains available as diagnostic
    // headroom for low-unit-count tests and snapshot/prediction debugging.
  },
  keyframe: {
    default: (1 / Math.pow(2, 9)) as KeyframeRatio,
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
// Every key in this file is for the HOST SERVER bar — namespace
// prefix `host-server-` makes that explicit in DevTools. Legacy
// `rts-*` keys are migrated lazily by the load helpers below.
const STORAGE_SNAPSHOT_RATE = 'host-server-snapshot-rate';
const STORAGE_KEYFRAME_RATIO = 'host-server-keyframe-ratio';
const STORAGE_TICK_RATE = 'host-server-tick-rate';
const STORAGE_SIM_QUALITY = 'host-server-sim-quality';
const STORAGE_TILT_EMA_MODE = 'host-server-tilt-ema-mode';

const HOST_SERVER_KEY_MIGRATIONS: ReadonlyArray<readonly [string, string]> = [
  ['rts-snapshot-rate', STORAGE_SNAPSHOT_RATE],
  ['rts-keyframe-ratio', STORAGE_KEYFRAME_RATIO],
  ['rts-tick-rate', STORAGE_TICK_RATE],
  ['rts-sim-quality', STORAGE_SIM_QUALITY],
  ['rts-sim-signal-states', 'host-server-sim-signal-states'],
];

let _hostServerMigrationsRun = false;
/** Run the legacy → prefixed key rename once per process. Each
 *  loadStored* helper calls this before reading; idempotent. */
function ensureHostServerMigrations(): void {
  if (_hostServerMigrationsRun) return;
  _hostServerMigrationsRun = true;
  for (const [oldK, newK] of HOST_SERVER_KEY_MIGRATIONS) migrateKey(oldK, newK);
}

// Includes legacy auto-tps / auto-cpu / auto-units for backward
// compat — those are migrated to 'auto' + a SOLO signal state on
// load. Kept as plain strings here so the type union doesn't have
// to carry them.
const VALID_SIM_QUALITIES: readonly string[] = [
  'auto', 'auto-tps', 'auto-cpu', 'auto-units',
  'min', 'low', 'medium', 'high', 'max',
];

export function loadStoredSimQuality(): ServerSimQuality {
  ensureHostServerMigrations();
  const stored = readPersisted(STORAGE_SIM_QUALITY);
  if (stored && VALID_SIM_QUALITIES.includes(stored)) {
    // Migrate legacy auto-X to 'auto'. The corresponding SOLO
    // signal state is set by loadStoredSimSignalStates().
    if (stored === 'auto-tps' || stored === 'auto-cpu' || stored === 'auto-units') {
      return SERVER_SIM_QUALITY_DEFAULT;
    }
    return stored as ServerSimQuality;
  }
  return SERVER_SIM_QUALITY_DEFAULT;
}

export function saveSimQuality(q: ServerSimQuality): void {
  persist(STORAGE_SIM_QUALITY, q);
}

const STORAGE_SIM_SIGNAL_STATES = 'host-server-sim-signal-states';

export function loadStoredSimSignalStates(): ServerSimSignalStates {
  ensureHostServerMigrations();
  // Seed from the centralized SERVER_SIM_LOD_SIGNAL_DEFAULTS table
  // (single source of truth for first-load + DEFAULTS-button state).
  const def: ServerSimSignalStates = { ...SERVER_SIM_LOD_SIGNAL_DEFAULTS };

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
    if (parsed && typeof parsed === 'object') {
      if (isSignalState(parsed.tps)) def.tps = parsed.tps;
      if (isSignalState(parsed.cpu)) def.cpu = parsed.cpu;
      if (isSignalState(parsed.units)) def.units = parsed.units;
    }
  } catch { /* ignore malformed */ }
  return def;
}

export function saveSimSignalStates(states: ServerSimSignalStates): void {
  persistJson(STORAGE_SIM_SIGNAL_STATES, states);
}

/** Reset every HOST SERVER LOD signal to its
 *  SERVER_SIM_LOD_SIGNAL_DEFAULTS value and persist. Wired to the
 *  DEFAULTS button in the host-server bar so first-load defaults and
 *  the reset button stay in lockstep. */
export function resetSimSignalStates(): ServerSimSignalStates {
  const fresh: ServerSimSignalStates = { ...SERVER_SIM_LOD_SIGNAL_DEFAULTS };
  persistJson(STORAGE_SIM_SIGNAL_STATES, fresh);
  return fresh;
}

export function loadStoredSnapshotRate(): SnapshotRate {
  ensureHostServerMigrations();
  return parseSnapshotRate(readPersisted(STORAGE_SNAPSHOT_RATE));
}

export function saveSnapshotRate(rate: SnapshotRate): void {
  persist(STORAGE_SNAPSHOT_RATE, String(normalizeSnapshotRate(rate)));
}

export function loadStoredKeyframeRatio(): KeyframeRatio {
  ensureHostServerMigrations();
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
  ensureHostServerMigrations();
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

export function loadStoredTiltEmaMode(): TiltEmaMode {
  ensureHostServerMigrations();
  const stored = readPersisted(STORAGE_TILT_EMA_MODE);
  if (stored && (SERVER_CONFIG.tiltEma.options as readonly string[]).includes(stored)) {
    return stored as TiltEmaMode;
  }
  return TILT_EMA_MODE_DEFAULT;
}

export function saveTiltEmaMode(mode: TiltEmaMode): void {
  persist(STORAGE_TILT_EMA_MODE, mode);
}


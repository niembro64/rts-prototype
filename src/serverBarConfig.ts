import type { SnapshotRate, KeyframeRatio, TickRate, ServerBarConfig } from './types/server';
import { persist, readPersisted, migrateKey } from './persistence';
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
    // Fraction of DIFFSNAPs that are actually FULLSNAPs.
    // Each option is 4× rarer (skips one power of two): 1/1, 1/4, 1/16, 1/64.
    default: (1 / 64) as KeyframeRatio,
    options: [
      'ALL',
      1 / 4,
      1 / 16,
      1 / 64,
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
const STORAGE_TILT_EMA_MODE = 'host-server-tilt-ema-mode';

const HOST_SERVER_KEY_MIGRATIONS: ReadonlyArray<readonly [string, string]> = [
  ['rts-snapshot-rate', STORAGE_SNAPSHOT_RATE],
  ['rts-keyframe-ratio', STORAGE_KEYFRAME_RATIO],
  ['rts-tick-rate', STORAGE_TICK_RATE],
];

let _hostServerMigrationsRun = false;
/** Run the legacy → prefixed key rename once per process. Each
 *  loadStored* helper calls this before reading; idempotent. */
function ensureHostServerMigrations(): void {
  if (_hostServerMigrationsRun) return;
  _hostServerMigrationsRun = true;
  for (const [oldK, newK] of HOST_SERVER_KEY_MIGRATIONS) migrateKey(oldK, newK);
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


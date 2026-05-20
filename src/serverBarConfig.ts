import type { SnapshotRate, KeyframeRatio, TickRate, ServerBarConfig } from './types/server';
import { persist, readPersisted, migrateKey } from './persistence';
import { UNIT_GROUND_NORMAL_EMA_MODE_DEFAULT, type UnitGroundNormalEmaMode } from './shellConfig';
import serverBarConfig from './serverBarConfig.json';

// ── Static tuning data (sourced from serverBarConfig.json) ──
// JSON owns the values so both TS and Rust/WASM can load the same
// source of truth. Functions + persistence stay in this module.

export const HOST_SNAPSHOT_RATE_NORMAL_MIN =
  serverBarConfig.hostSnapshotRate.normalMin;
export const HOST_SNAPSHOT_RATE_NORMAL_MAX =
  serverBarConfig.hostSnapshotRate.normalMax;
export const HOST_SNAPSHOT_RATE_DIAGNOSTIC_MIN =
  serverBarConfig.hostSnapshotRate.diagnosticMin;
export const HOST_SNAPSHOT_RATE_DEFAULT: SnapshotRate =
  serverBarConfig.hostSnapshotRate.default as SnapshotRate;
export const HOST_SNAPSHOT_RATE_OPTIONS: readonly SnapshotRate[] =
  serverBarConfig.hostSnapshotRate.options as readonly SnapshotRate[];
export const LEGACY_UNCAPPED_SNAPSHOT_RATE_FALLBACK =
  serverBarConfig.hostSnapshotRate.legacyUncappedFallback;

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
    default: serverBarConfig.tickRate.default as TickRate,
    options: serverBarConfig.tickRate.options as readonly TickRate[],
  },
  unitGroundNormalEma: {
    // Default comes from shellConfig (the canonical EMA-mode source).
    // Options list lives in serverBarConfig.json.
    default: UNIT_GROUND_NORMAL_EMA_MODE_DEFAULT,
    options: serverBarConfig.unitGroundNormalEma.options as readonly UnitGroundNormalEmaMode[],
  },
  snapshot: {
    default: HOST_SNAPSHOT_RATE_DEFAULT,
    options: HOST_SNAPSHOT_RATE_OPTIONS,
    // 5-10 SPS is normal play. 16+ SPS remains available as diagnostic
    // headroom for low-unit-count tests and snapshot/prediction debugging.
  },
  keyframe: {
    // Fraction of DIFFSNAPs that are actually FULLSNAPs.
    // Each option is 4x rarer (skips one power of two): 1/1, 1/4, 1/16, 1/64.
    default: serverBarConfig.keyframe.default as KeyframeRatio,
    options: serverBarConfig.keyframe.options as readonly KeyframeRatio[],
  },
} as const satisfies ServerBarConfig;

// ── localStorage keys (module-private) ──
// Every key in this file is for the HOST SERVER bar — namespace
// prefix `host-server-` makes that explicit in DevTools. Legacy and
// renamed keys are migrated lazily by the load helpers below.
const STORAGE_SNAPSHOT_RATE = serverBarConfig.storageKeys.snapshotRate;
const STORAGE_KEYFRAME_RATIO = serverBarConfig.storageKeys.keyframeRatio;
const STORAGE_TICK_RATE = serverBarConfig.storageKeys.tickRate;
const STORAGE_UNIT_GROUND_NORMAL_EMA_MODE =
  serverBarConfig.storageKeys.unitGroundNormalEmaMode;

const HOST_SERVER_KEY_MIGRATIONS: ReadonlyArray<readonly [string, string]> =
  serverBarConfig.storageMigrations as unknown as ReadonlyArray<readonly [string, string]>;

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
    if (!isNaN(num) && SERVER_CONFIG.keyframe.options.includes(num)) return num;
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

export function loadStoredUnitGroundNormalEmaMode(): UnitGroundNormalEmaMode {
  ensureHostServerMigrations();
  const stored = readPersisted(STORAGE_UNIT_GROUND_NORMAL_EMA_MODE);
  if (stored && (SERVER_CONFIG.unitGroundNormalEma.options as readonly string[]).includes(stored)) {
    return stored as UnitGroundNormalEmaMode;
  }
  return UNIT_GROUND_NORMAL_EMA_MODE_DEFAULT;
}

export function saveUnitGroundNormalEmaMode(mode: UnitGroundNormalEmaMode): void {
  persist(STORAGE_UNIT_GROUND_NORMAL_EMA_MODE, mode);
}

import type { SnapshotRate, KeyframeRatio, TickRate, ServerBarConfig } from './types/server';
import type { BattleMode } from './battleBarConfig';
import { persist, readPersisted } from './persistence';
import { UNIT_GROUND_NORMAL_EMA_MODE_DEFAULT, type UnitGroundNormalEmaMode } from './shellConfig';
import serverBarConfig from './serverBarConfig.json';

// ── Static tuning data (sourced from serverBarConfig.json) ──
// JSON owns the values so both TS and Rust/WASM can load the same
// source of truth. Functions + persistence stay in this module.

export type ServerMode = BattleMode;

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

type ServerDefaults = {
  readonly tickRate: TickRate;
  readonly snapshotRate: SnapshotRate;
  readonly keyframeRatio: KeyframeRatio;
  readonly unitGroundNormalEmaMode: UnitGroundNormalEmaMode;
};

type ServerModeDefaultOverrides = Partial<ServerDefaults>;

const BASE_SERVER_DEFAULTS: ServerDefaults = {
  tickRate: serverBarConfig.tickRate.default as TickRate,
  snapshotRate: HOST_SNAPSHOT_RATE_DEFAULT,
  keyframeRatio: serverBarConfig.keyframe.default as KeyframeRatio,
  unitGroundNormalEmaMode: UNIT_GROUND_NORMAL_EMA_MODE_DEFAULT,
};

const SERVER_MODE_DEFAULT_OVERRIDES =
  serverBarConfig.modeDefaults as Record<ServerMode, ServerModeDefaultOverrides>;

function resolveServerDefaults(mode: ServerMode): ServerDefaults {
  return {
    ...BASE_SERVER_DEFAULTS,
    ...(SERVER_MODE_DEFAULT_OVERRIDES[mode] ?? {}),
  };
}

export const SERVER_CONFIG = {
  tickRate: {
    default: BASE_SERVER_DEFAULTS.tickRate,
    options: serverBarConfig.tickRate.options as readonly TickRate[],
  },
  unitGroundNormalEma: {
    // Default comes from shellConfig (the canonical EMA-mode source).
    // Options list lives in serverBarConfig.json.
    default: BASE_SERVER_DEFAULTS.unitGroundNormalEmaMode,
    options: serverBarConfig.unitGroundNormalEma.options as readonly UnitGroundNormalEmaMode[],
  },
  snapshot: {
    default: BASE_SERVER_DEFAULTS.snapshotRate,
    options: HOST_SNAPSHOT_RATE_OPTIONS,
    // 5-10 SPS is normal play. 16+ SPS remains available as diagnostic
    // headroom for low-unit-count tests and snapshot/prediction debugging.
  },
  keyframe: {
    // Fraction of DIFFSNAPs that are actually FULLSNAPs.
    // Each option is 4x rarer (skips one power of two): 1/1, 1/4, 1/16, 1/64.
    default: BASE_SERVER_DEFAULTS.keyframeRatio,
    options: serverBarConfig.keyframe.options as readonly KeyframeRatio[],
  },
} as const satisfies ServerBarConfig;

// ── localStorage keys (module-private) ──
// DEMO SERVER and REAL SERVER each get their own namespace —
// `demo-server-*` and `real-server-*` — matching the DEMO/REAL split
// already in place for the battle and client bars. No migrations.
type ServerStorageKeyName =
  | 'snapshotRate'
  | 'keyframeRatio'
  | 'tickRate'
  | 'unitGroundNormalEmaMode';

type ServerStorageKeys = Record<ServerStorageKeyName, string>;

const SERVER_STORAGE_KEY_NAMES: readonly ServerStorageKeyName[] = [
  'snapshotRate',
  'keyframeRatio',
  'tickRate',
  'unitGroundNormalEmaMode',
];

const storageKeySuffixes =
  serverBarConfig.storageKeySuffixes as Record<ServerStorageKeyName, string>;

function buildStorageKeys(mode: ServerMode): ServerStorageKeys {
  const keys = {} as ServerStorageKeys;
  for (const name of SERVER_STORAGE_KEY_NAMES) {
    keys[name] = `${mode}-server-${storageKeySuffixes[name]}`;
  }
  return keys;
}

const SERVER_STORAGE_KEYS: Record<ServerMode, ServerStorageKeys> = {
  demo: buildStorageKeys('demo'),
  real: buildStorageKeys('real'),
};

export function loadStoredSnapshotRate(mode: ServerMode): SnapshotRate {
  const stored = readPersisted(SERVER_STORAGE_KEYS[mode].snapshotRate);
  if (stored === null) return resolveServerDefaults(mode).snapshotRate;
  return parseSnapshotRate(stored);
}

export function saveSnapshotRate(rate: SnapshotRate, mode: ServerMode): void {
  persist(SERVER_STORAGE_KEYS[mode].snapshotRate, String(normalizeSnapshotRate(rate)));
}

export function loadStoredKeyframeRatio(mode: ServerMode): KeyframeRatio {
  const stored = readPersisted(SERVER_STORAGE_KEYS[mode].keyframeRatio);
  if (stored === 'ALL') return 'ALL';
  if (stored === 'NONE') return 'NONE';
  if (stored) {
    const num = Number(stored);
    if (!isNaN(num) && SERVER_CONFIG.keyframe.options.includes(num)) return num;
  }
  return resolveServerDefaults(mode).keyframeRatio;
}

export function saveKeyframeRatio(ratio: KeyframeRatio, mode: ServerMode): void {
  persist(SERVER_STORAGE_KEYS[mode].keyframeRatio, String(ratio));
}

export function loadStoredTickRate(mode: ServerMode): TickRate {
  const stored = readPersisted(SERVER_STORAGE_KEYS[mode].tickRate);
  if (stored) {
    const num = Number(stored);
    if (!isNaN(num) && num > 0) return num;
  }
  return resolveServerDefaults(mode).tickRate;
}

export function saveTickRate(rate: TickRate, mode: ServerMode): void {
  persist(SERVER_STORAGE_KEYS[mode].tickRate, String(rate));
}

export function loadStoredUnitGroundNormalEmaMode(mode: ServerMode): UnitGroundNormalEmaMode {
  const stored = readPersisted(SERVER_STORAGE_KEYS[mode].unitGroundNormalEmaMode);
  if (stored && (SERVER_CONFIG.unitGroundNormalEma.options as readonly string[]).includes(stored)) {
    return stored as UnitGroundNormalEmaMode;
  }
  return resolveServerDefaults(mode).unitGroundNormalEmaMode;
}

export function saveUnitGroundNormalEmaMode(
  mode: UnitGroundNormalEmaMode,
  serverMode: ServerMode,
): void {
  persist(SERVER_STORAGE_KEYS[serverMode].unitGroundNormalEmaMode, mode);
}

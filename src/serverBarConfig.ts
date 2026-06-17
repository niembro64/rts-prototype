import type { ServerBarConfig } from './types/server';
import type { BattleMode } from './battleBarConfig';
import { persist, readPersisted } from './persistence';
import { UNIT_GROUND_NORMAL_EMA_MODE_DEFAULT, type UnitGroundNormalEmaMode } from './shellConfig';
import serverBarConfig from './serverBarConfig.json';

// Server-bar JSON owns only settings still exposed by the deterministic
// lockstep SERVER bar. Fixed-step timing and presentation snapshot
// cadence live in architecture.json.

export type ServerMode = BattleMode;

type ServerDefaults = {
  readonly unitGroundNormalEmaMode: UnitGroundNormalEmaMode;
};

function resolveServerDefaults(_mode: ServerMode): ServerDefaults {
  return {
    unitGroundNormalEmaMode: UNIT_GROUND_NORMAL_EMA_MODE_DEFAULT,
  };
}

const DEMO_SERVER_DEFAULTS = resolveServerDefaults('demo');

export const SERVER_CONFIG = {
  unitGroundNormalEma: {
    default: DEMO_SERVER_DEFAULTS.unitGroundNormalEmaMode,
    options: serverBarConfig.unitGroundNormalEma.options as readonly UnitGroundNormalEmaMode[],
  },
} as const satisfies ServerBarConfig;

// ── localStorage keys (module-private) ──
// DEMO SERVER and REAL SERVER each get their own namespace —
// `demo-server-*` and `real-server-*` — matching the DEMO/REAL split
// already in place for the battle and client bars. No migrations.
type ServerStorageKeyName = 'unitGroundNormalEmaMode';

type ServerStorageKeys = Record<ServerStorageKeyName, string>;

const SERVER_STORAGE_KEY_NAMES: readonly ServerStorageKeyName[] = [
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

import type { ServerBarConfig } from './types/server';
import type { BattleMode } from './battleBarConfig';
import { readModeSetting, writeModeSetting } from './realBattleSessionSettings';
import { UNIT_GROUND_NORMAL_EMA_MODE_DEFAULT, type UnitGroundNormalEmaMode } from './shellConfig';
import serverBarConfig from './serverBarConfig.json';
import { buildNamespacedStorageKeys } from './storageKeys';

// Host-applied simulation settings that still travel through server commands.
// The ground-normal EMA control is rendered in the BATTLE bar; fixed-step
// timing and presentation snapshot cadence live in architecture.json.

type ServerMode = BattleMode;

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
// `demo-server-*` and `real-server-*`. These are SIMULATION settings, so
// they follow the battle bar's rule (realBattleSessionSettings.ts): the
// demo namespace is localStorage, the real namespace is session memory
// that a lobby entry clears. No migrations.
type ServerStorageKeyName = 'unitGroundNormalEmaMode';

type ServerStorageKeys = Record<ServerStorageKeyName, string>;

const SERVER_STORAGE_KEY_NAMES: readonly ServerStorageKeyName[] = [
  'unitGroundNormalEmaMode',
];

const storageKeySuffixes =
  serverBarConfig.storageKeySuffixes as Record<ServerStorageKeyName, string>;

function buildStorageKeys(mode: ServerMode): ServerStorageKeys {
  return buildNamespacedStorageKeys(
    SERVER_STORAGE_KEY_NAMES,
    storageKeySuffixes,
    `${mode}-server`,
  );
}

const SERVER_STORAGE_KEYS: Record<ServerMode, ServerStorageKeys> = {
  demo: buildStorageKeys('demo'),
  real: buildStorageKeys('real'),
};

export function loadStoredUnitGroundNormalEmaMode(mode: ServerMode): UnitGroundNormalEmaMode {
  const stored = readModeSetting(
    mode,
    SERVER_STORAGE_KEYS.real.unitGroundNormalEmaMode,
    SERVER_STORAGE_KEYS.demo.unitGroundNormalEmaMode,
  );
  if (stored && (SERVER_CONFIG.unitGroundNormalEma.options as readonly string[]).includes(stored)) {
    return stored as UnitGroundNormalEmaMode;
  }
  return resolveServerDefaults(mode).unitGroundNormalEmaMode;
}

export function saveUnitGroundNormalEmaMode(
  mode: UnitGroundNormalEmaMode,
  serverMode: ServerMode,
): void {
  writeModeSetting(
    serverMode,
    SERVER_STORAGE_KEYS.real.unitGroundNormalEmaMode,
    SERVER_STORAGE_KEYS.demo.unitGroundNormalEmaMode,
    mode,
  );
}

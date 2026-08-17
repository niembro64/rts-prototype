/**
 * Where per-mode battle settings live.
 *
 * DEMO settings are the user's persistent sandbox: they belong in
 * localStorage and are expected to survive a reload.
 *
 * REAL (lobby / real battle) settings are SESSION state and never touch the
 * browser. A lobby must open identically every time, on every machine — the
 * same authored defaults regardless of what the last game was tuned to or
 * what the demo sandbox was left on. So `real` reads and writes this
 * in-memory map, and `resetRealBattleSettings()` empties it on every lobby
 * entry, dropping each loader back to its default.
 *
 * Both bars that carry simulation settings (BATTLE and SERVER) route through
 * here, so the rule is enforced in one place rather than re-derived per
 * field. The `real*` storage keys still exist as names — they key this map
 * instead of localStorage.
 */
import { persist, readPersisted } from './persistence';

/** `demo` = the backdrop demo battle. `real` = the lobby AND the real game.
 *  Structurally identical to `BattleMode`; declared here so this module sits
 *  below battleBarConfig with no import cycle. */
export type SettingsMode = 'demo' | 'real';

const realSessionSettings = new Map<string, string>();

/** Read a per-mode setting: session memory for `real`, localStorage for
 *  `demo`. Real deliberately does NOT fall back to the demo key — that
 *  fallback is what let a lobby inherit demo customizations. */
export function readModeSetting(
  mode: SettingsMode,
  realKey: string,
  demoKey: string,
): string | null {
  if (mode === 'real') return realSessionSettings.get(realKey) ?? null;
  return readPersisted(demoKey);
}

/** Write a per-mode setting. Real stays in memory for this session only. */
export function writeModeSetting(
  mode: SettingsMode,
  realKey: string,
  demoKey: string,
  value: string,
): void {
  if (mode === 'real') {
    realSessionSettings.set(realKey, value);
    return;
  }
  persist(demoKey, value);
}

/** Begin a new lobby / real-battle session from the authored defaults.
 *  Called on every entry into the lobby (host, join, and offline), which is
 *  what makes the real battle reproducible across sessions and machines. */
export function resetRealBattleSettings(): void {
  realSessionSettings.clear();
}

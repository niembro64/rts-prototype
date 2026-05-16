function envFlag(name: string): boolean {
  const value = import.meta.env[name];
  if (typeof value !== 'string') return false;
  return value === '1' || value.toLowerCase() === 'true' || value.toLowerCase() === 'yes';
}

function queryFlag(...names: string[]): boolean {
  if (typeof window === 'undefined') return false;
  const params = new URLSearchParams(window.location.search);
  for (const name of names) {
    const value = params.get(name);
    if (value === null) continue;
    if (value === '' || value === '1') return true;
    const normalized = value.toLowerCase();
    if (normalized === 'true' || normalized === 'yes' || normalized === 'on') return true;
  }
  return false;
}

export const GAME_DIAGNOSTICS = {
  pathValidation: envFlag('VITE_BA_VALIDATE_PATHS'),
  commandPlans: envFlag('VITE_BA_DEBUG_COMMANDS'),
  networkSnapshots: envFlag('VITE_BA_DEBUG_NET_SNAPSHOTS'),
  snapshotCadenceRegression:
    envFlag('VITE_BA_DP01_REGRESSION') ||
    queryFlag('dp01', 'snapshotCadenceRegression'),
  snapshotEncodeInstrumentation:
    envFlag('VITE_BA_DP02_SNAPSHOT_WIRE') ||
    queryFlag('dp02', 'snapshotEncodeInstrumentation', 'snapshotWireStats'),
};

export function debugLog(enabled: boolean, ...args: unknown[]): void {
  if (enabled) console.log(...args);
}

export function debugWarn(enabled: boolean, ...args: unknown[]): void {
  if (enabled) console.warn(...args);
}

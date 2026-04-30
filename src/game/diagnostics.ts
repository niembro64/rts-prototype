function envFlag(name: string): boolean {
  const value = import.meta.env[name];
  if (typeof value !== 'string') return false;
  return value === '1' || value.toLowerCase() === 'true' || value.toLowerCase() === 'yes';
}

export const GAME_DIAGNOSTICS = {
  pathValidation: envFlag('VITE_BA_VALIDATE_PATHS'),
  commandPlans: envFlag('VITE_BA_DEBUG_COMMANDS'),
  networkSnapshots: envFlag('VITE_BA_DEBUG_NET_SNAPSHOTS'),
};

export function debugLog(enabled: boolean, ...args: unknown[]): void {
  if (enabled) console.log(...args);
}

export function debugWarn(enabled: boolean, ...args: unknown[]): void {
  if (enabled) console.warn(...args);
}

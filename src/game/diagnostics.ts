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
  clientPredictionDiagnostics:
    envFlag('VITE_BA_DP03_CLIENT_PREDICTION') ||
    queryFlag('dp03', 'clientPredictionDiagnostics', 'predictionDiagnostics'),
  // AIM-08.0 — gate for the targeting parity harness that diffs the TS
  // FSM output against the (eventually populated) SoA kernel output.
  // See src/game/sim/combat/targetingParityHarness.ts.
  targetingParity:
    envFlag('VITE_BA_AIM08_PARITY') ||
    queryFlag('aim08', 'targetingParity'),
};

export function debugLog(enabled: boolean, ...args: unknown[]): void {
  if (enabled) console.log(...args);
}

export function debugWarn(enabled: boolean, ...args: unknown[]): void {
  if (enabled) console.warn(...args);
}

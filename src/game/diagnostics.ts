import {
  readBooleanEnvFlag as envFlag,
  readBooleanQueryFlag as queryFlag,
} from './runtimeFlags';

export const GAME_DIAGNOSTICS = {
  pathValidation: envFlag('VITE_BA_VALIDATE_PATHS'),
  pathfindingSearch:
    envFlag('VITE_BA_DEBUG_PATHFINDING') ||
    queryFlag('pathfinding', 'pathfindingSearch'),
  commandPlans: envFlag('VITE_BA_DEBUG_COMMANDS'),
  networkSnapshots: envFlag('VITE_BA_DEBUG_NET_SNAPSHOTS'),
  shaderErrorChecks:
    envFlag('VITE_BA_CHECK_SHADER_ERRORS') ||
    queryFlag('shaderErrors', 'checkShaderErrors'),
  snapshotCadenceRegression:
    envFlag('VITE_BA_DP01_REGRESSION') ||
    queryFlag('dp01', 'snapshotCadenceRegression'),
  snapshotEncodeInstrumentation:
    envFlag('VITE_BA_DP02_SNAPSHOT_WIRE') ||
    queryFlag('dp02', 'snapshotEncodeInstrumentation', 'snapshotWireStats'),
  clientPredictionDiagnostics:
    envFlag('VITE_BA_DP03_CLIENT_PREDICTION') ||
    queryFlag('dp03', 'clientPredictionDiagnostics', 'predictionDiagnostics'),
  supportSurfaceDiagnostics:
    envFlag('VITE_BA_DEBUG_SUPPORT_SURFACES') ||
    queryFlag('supportDiagnostics', 'supportSurfaceDiagnostics'),
  nameLabelIdentityTrace:
    envFlag('VITE_BA_DEBUG_NAME_LABEL_IDENTITY') ||
    queryFlag('nameLabelIdentityTrace', 'debugNameLabelIdentity'),
  webglBufferUploads:
    envFlag('VITE_BA_PROFILE_WEBGL_UPLOADS') ||
    queryFlag('webglUploads', 'profileWebglUploads'),
};

export function debugLog(enabled: boolean, ...args: unknown[]): void {
  if (enabled) console.log(...args);
}

export function debugWarn(enabled: boolean, ...args: unknown[]): void {
  if (enabled) console.warn(...args);
}

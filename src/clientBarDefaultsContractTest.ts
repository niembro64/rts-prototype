import rawClientBarConfig from './clientBarConfig.json';
import {
  AA_MSAA_MODE_DEFAULT,
  AA_RESOLUTION_MODE_DEFAULT,
  LOD_MODE_DEFAULT,
  getAaMsaaMode,
  getAaResolutionMode,
  getAmbientLight,
  getClientConfig,
  getDirectionalLight,
  getEnvironmentLight,
  getExposure,
  getLodMode,
  getSkyLight,
  getWaterTriangleDebug,
  resetClientSettingsToDefaults,
  setAaMsaaMode,
  setAaResolutionMode,
  setClientMode,
  setEnvironmentLight,
  setLodMode,
  setWaterTriangleDebug,
  type ClientMode,
} from './clientBarConfig';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[client bar defaults contract] ${message}`);
}

function restoreStorageValue(key: string, value: string | null): void {
  if (value === null) window.localStorage.removeItem(key);
  else window.localStorage.setItem(key, value);
}

export function runClientBarDefaultsContractTest(): void {
  const suffixes = rawClientBarConfig.storageKeySuffixes as Record<string, string>;
  const originalMode: ClientMode = getClientConfig() === getClientConfig('demo')
    ? 'demo'
    : 'real';
  const otherMode: ClientMode = originalMode === 'demo' ? 'real' : 'demo';
  const keysFor = (mode: ClientMode): string[] => Object.values(suffixes)
    .map((suffix) => `${mode}-client-${suffix}`);
  const keysByMode: Record<ClientMode, string[]> = {
    demo: keysFor('demo'),
    real: keysFor('real'),
  };
  const allModeKeys = [...keysByMode.demo, ...keysByMode.real];
  const globalKeys = [
    'client-lod-mode',
    'client-aa-msaa-mode',
    'client-aa-resolution-mode',
  ];
  const saved = new Map(
    [...allModeKeys, ...globalKeys].map((key) => [key, window.localStorage.getItem(key)]),
  );
  const originalLod = getLodMode();
  const originalMsaa = getAaMsaaMode();
  const originalResolution = getAaResolutionMode();
  const keyFor = (name: string): string =>
    `${originalMode}-client-${suffixes[name]}`;

  try {
    // Force a fresh load of the active namespace after clearing it. Every
    // absent preference must become an explicit authored localStorage value.
    setClientMode(otherMode);
    for (const key of keysByMode[originalMode]) window.localStorage.removeItem(key);
    setClientMode(originalMode);
    assertContract(
      keysByMode[originalMode].every((key) => window.localStorage.getItem(key) !== null),
      `${originalMode} startup must materialize every missing per-mode preference`,
    );

    const defaults = getClientConfig(originalMode);
    assertContract(
      window.localStorage.getItem(keyFor('environmentLight')) ===
          String(defaults.environmentLight.default) &&
        window.localStorage.getItem(keyFor('ambientLight')) ===
          String(defaults.ambientLight.default) &&
        window.localStorage.getItem(keyFor('directionalLight')) ===
          String(defaults.directionalLight.default) &&
        window.localStorage.getItem(keyFor('skyLight')) ===
          String(defaults.skyLight.default) &&
        window.localStorage.getItem(keyFor('exposure')) ===
          String(defaults.exposure.default),
      `${originalMode} first-run lighting values must come from the current authored defaults`,
    );

    const alternateEnvironment = defaults.environmentLight.options.find(
      (option) => option.value !== defaults.environmentLight.default,
    )?.value;
    assertContract(
      alternateEnvironment !== undefined,
      'environment-light fixture requires a non-default option',
    );
    setEnvironmentLight(alternateEnvironment);
    setWaterTriangleDebug(!defaults.waterTriangleDebug.default);
    setLodMode(LOD_MODE_DEFAULT === 'min' ? 'auto' : 'min');
    setAaMsaaMode(AA_MSAA_MODE_DEFAULT === '4x' ? '8x' : '4x');
    setAaResolutionMode(AA_RESOLUTION_MODE_DEFAULT === 50 ? 75 : 50);

    const sentinel = '__client-default-contract-custom__';
    for (const key of keysByMode[originalMode]) window.localStorage.setItem(key, sentinel);
    resetClientSettingsToDefaults(originalMode);

    const lobbyKey = keyFor('lobbyVisible');
    assertContract(
      keysByMode[originalMode].every((key) =>
        key === lobbyKey || window.localStorage.getItem(key) !== sentinel) &&
        window.localStorage.getItem(lobbyKey) === sentinel,
      'DEFAULTS must rewrite every bottom-bar preference while leaving live chrome visibility alone',
    );
    assertContract(
      getEnvironmentLight() === defaults.environmentLight.default &&
        getAmbientLight() === defaults.ambientLight.default &&
        getDirectionalLight() === defaults.directionalLight.default &&
        getSkyLight() === defaults.skyLight.default &&
        getExposure() === defaults.exposure.default &&
        getWaterTriangleDebug() === defaults.waterTriangleDebug.default &&
        getLodMode() === LOD_MODE_DEFAULT &&
        getAaMsaaMode() === AA_MSAA_MODE_DEFAULT &&
        getAaResolutionMode() === AA_RESOLUTION_MODE_DEFAULT,
      'DEFAULTS must apply authored lighting, debug, LOD, and antialias values through one runtime path',
    );

    // A mode round-trip exercises the same storage loader used after a page
    // refresh. The reset values must survive that reload path rather than
    // existing only in the current module's live state.
    setClientMode(otherMode);
    setClientMode(originalMode);
    assertContract(
      getEnvironmentLight() === defaults.environmentLight.default &&
        getAmbientLight() === defaults.ambientLight.default &&
        getDirectionalLight() === defaults.directionalLight.default &&
        getSkyLight() === defaults.skyLight.default &&
        getExposure() === defaults.exposure.default &&
        getWaterTriangleDebug() === defaults.waterTriangleDebug.default,
      'DEFAULTS must survive the persisted per-mode reload path',
    );
  } finally {
    // Restore the active runtime from the profile that existed before this
    // test, then restore the exact browser bytes (including missing keys).
    for (const [key, value] of saved) restoreStorageValue(key, value);
    setClientMode(otherMode);
    setClientMode(originalMode);
    setLodMode(originalLod);
    setAaMsaaMode(originalMsaa);
    setAaResolutionMode(originalResolution);
    for (const [key, value] of saved) restoreStorageValue(key, value);
  }
}

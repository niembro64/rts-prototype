import { ref, watch, type Ref } from 'vue';
import {
  loadStoredDemoBarsCollapsed,
  loadStoredRealBarsCollapsed,
  saveDemoBarsCollapsed,
  saveRealBarsCollapsed,
  type BattleMode,
} from '../battleBarConfig';
import {
  getStoredLobbyVisible,
  setLobbyVisible,
} from '../clientBarConfig';

type PlayerClientRenderInstance = {
  app: { setRenderEnabled(enabled: boolean): void };
  getScene?: () => { setClientRenderEnabled(enabled: boolean): void } | null | undefined;
};

const CLIENT_ENABLED_STORAGE_KEYS: Record<BattleMode, string> = {
  demo: 'demo-client-game-enabled',
  real: 'real-client-game-enabled',
};

function loadStoredClientEnabled(mode: BattleMode): boolean {
  try {
    const raw = window.localStorage.getItem(CLIENT_ENABLED_STORAGE_KEYS[mode]);
    return raw === null ? true : raw !== 'false';
  } catch {
    return true;
  }
}

function saveClientEnabled(mode: BattleMode, enabled: boolean): void {
  try {
    window.localStorage.setItem(CLIENT_ENABLED_STORAGE_KEYS[mode], enabled ? 'true' : 'false');
  } catch {
    // The toggle still works for this session when storage is unavailable.
  }
}

export function setPlayerClientRenderEnabled(
  instance: PlayerClientRenderInstance | null | undefined,
  enabled: boolean,
): void {
  if (!instance) return;
  instance.app.setRenderEnabled(enabled);
  instance.getScene?.()?.setClientRenderEnabled(enabled);
}

export function useGameCanvasChromeState(
  currentBattleMode: Readonly<Ref<BattleMode>>,
  onPlayerClientEnabledChange: () => void,
): {
  mobileBarsVisible: Ref<boolean>;
  spectateMode: Ref<boolean>;
  bottomBarsCollapsed: Ref<boolean>;
  playerClientEnabled: Ref<boolean>;
  toggleBottomBars: () => void;
  togglePlayerClientEnabled: () => void;
  toggleSpectateMode: () => void;
} {
  const mobileBarsVisible = ref(false);
  const spectateMode = ref(!getStoredLobbyVisible(currentBattleMode.value));
  const bottomBarsCollapsed = ref(
    currentBattleMode.value === 'real'
      ? loadStoredRealBarsCollapsed()
      : loadStoredDemoBarsCollapsed(),
  );
  const playerClientEnabled = ref(loadStoredClientEnabled(currentBattleMode.value));

  watch(currentBattleMode, (mode) => {
    spectateMode.value = !getStoredLobbyVisible(mode);
    bottomBarsCollapsed.value = mode === 'real'
      ? loadStoredRealBarsCollapsed()
      : loadStoredDemoBarsCollapsed();
    playerClientEnabled.value = loadStoredClientEnabled(mode);
  });

  watch(playerClientEnabled, (enabled) => {
    saveClientEnabled(currentBattleMode.value, enabled);
    onPlayerClientEnabledChange();
  });

  function toggleBottomBars(): void {
    const next = !bottomBarsCollapsed.value;
    bottomBarsCollapsed.value = next;
    if (currentBattleMode.value === 'real') saveRealBarsCollapsed(next);
    else saveDemoBarsCollapsed(next);
  }

  function togglePlayerClientEnabled(): void {
    playerClientEnabled.value = !playerClientEnabled.value;
  }

  function toggleSpectateMode(): void {
    spectateMode.value = !spectateMode.value;
    setLobbyVisible(!spectateMode.value);
  }

  return {
    mobileBarsVisible,
    spectateMode,
    bottomBarsCollapsed,
    playerClientEnabled,
    toggleBottomBars,
    togglePlayerClientEnabled,
    toggleSpectateMode,
  };
}

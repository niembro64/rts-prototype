import { ref, watch, type Ref } from 'vue';
import {
  loadStoredDemoBarsCollapsed,
  loadStoredRealBarsCollapsed,
  saveDemoBarsCollapsed,
  saveRealBarsCollapsed,
} from '../battleBarConfig';
import {
  getLobbyVisible,
  setLobbyVisible,
} from '../clientBarConfig';

type PlayerClientRenderInstance = {
  app: { setRenderEnabled(enabled: boolean): void };
  getScene?: () => { setClientRenderEnabled(enabled: boolean): void } | null | undefined;
};

const PLAYER_CLIENT_ENABLED_STORAGE_KEY = 'player-client-game-enabled';

function loadStoredPlayerClientEnabled(): boolean {
  try {
    const raw = window.localStorage.getItem(PLAYER_CLIENT_ENABLED_STORAGE_KEY);
    return raw === null ? true : raw !== 'false';
  } catch {
    return true;
  }
}

function savePlayerClientEnabled(enabled: boolean): void {
  try {
    window.localStorage.setItem(PLAYER_CLIENT_ENABLED_STORAGE_KEY, enabled ? 'true' : 'false');
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
  gameStarted: Ref<boolean>,
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
  const spectateMode = ref(!getLobbyVisible());
  const bottomBarsCollapsed = ref(loadStoredDemoBarsCollapsed());
  const playerClientEnabled = ref(loadStoredPlayerClientEnabled());

  watch(gameStarted, (started) => {
    bottomBarsCollapsed.value = started
      ? loadStoredRealBarsCollapsed()
      : loadStoredDemoBarsCollapsed();
  });

  watch(playerClientEnabled, (enabled) => {
    savePlayerClientEnabled(enabled);
    onPlayerClientEnabledChange();
  });

  function toggleBottomBars(): void {
    const next = !bottomBarsCollapsed.value;
    bottomBarsCollapsed.value = next;
    if (gameStarted.value) saveRealBarsCollapsed(next);
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


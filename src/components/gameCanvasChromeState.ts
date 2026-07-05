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

export type GameCanvasPresentationPhase =
  | 'background-loading'
  | 'background-interactive'
  | 'lobby-preview-loading'
  | 'lobby-preview-interactive'
  | 'real-battle-loading'
  | 'real-battle-interactive'
  | 'client-paused';

export type GameCanvasPresentationInputs = {
  currentBattleMode: BattleMode;
  gameStarted: boolean;
  lobbyFullscreenVisible: boolean;
  loading: boolean;
  playerClientEnabled: boolean;
};

export type GameCanvasChromeVisibilityInputs = {
  phase: GameCanvasPresentationPhase;
  uiChromeVisible: boolean;
  isMobile: boolean;
  mobileBarsVisible: boolean;
  lobbyFullscreenVisible: boolean;
};

export type GameCanvasChromeVisibility = {
  topBar: boolean;
  bottomBars: boolean;
  gameplayHud: boolean;
  overlayControls: boolean;
  playerClientOffOverlay: boolean;
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

function isLoadingPresentationPhase(phase: GameCanvasPresentationPhase): boolean {
  return phase === 'background-loading' ||
    phase === 'lobby-preview-loading' ||
    phase === 'real-battle-loading';
}

export function resolveGameCanvasPresentationPhase({
  currentBattleMode,
  gameStarted,
  lobbyFullscreenVisible,
  loading,
  playerClientEnabled,
}: GameCanvasPresentationInputs): GameCanvasPresentationPhase {
  if (gameStarted) {
    if (loading) return 'real-battle-loading';
    return playerClientEnabled ? 'real-battle-interactive' : 'client-paused';
  }

  if (currentBattleMode === 'real' && lobbyFullscreenVisible) {
    return loading ? 'lobby-preview-loading' : 'lobby-preview-interactive';
  }

  if (loading) return 'background-loading';
  return playerClientEnabled ? 'background-interactive' : 'client-paused';
}

export function resolveGameCanvasChromeVisibility({
  phase,
  uiChromeVisible,
  isMobile,
  mobileBarsVisible,
  lobbyFullscreenVisible,
}: GameCanvasChromeVisibilityInputs): GameCanvasChromeVisibility {
  const loading = isLoadingPresentationPhase(phase);
  const shellOpen = uiChromeVisible &&
    (isMobile ? mobileBarsVisible : !lobbyFullscreenVisible);
  const gameplayHud = shellOpen && !loading && phase !== 'client-paused';

  return {
    topBar: shellOpen && !loading,
    bottomBars: shellOpen && !loading,
    gameplayHud,
    overlayControls: uiChromeVisible && !loading,
    playerClientOffOverlay: phase === 'client-paused',
  };
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

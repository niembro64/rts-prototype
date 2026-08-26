import { ref, watch, type Ref } from 'vue';
import { type BattleMode } from '../battleBarConfig';
import {
  getStoredLobbyVisible,
  setLobbyVisible,
} from '../clientBarConfig';

type PlayerClientRenderInstance = {
  app: { setRenderEnabled(enabled: boolean): void };
  getScene?: () => { setClientRenderEnabled(enabled: boolean): void } | null | undefined;
};

type GameCanvasPresentationPhase =
  | 'background-loading'
  | 'background-interactive'
  | 'lobby-preview-loading'
  | 'lobby-preview-interactive'
  | 'real-battle-loading'
  | 'real-battle-interactive'
  | 'client-paused';

type GameCanvasPresentationInputs = {
  currentBattleMode: BattleMode;
  gameStarted: boolean;
  lobbyFullscreenVisible: boolean;
  loading: boolean;
  playerClientEnabled: boolean;
};

type GameCanvasChromeVisibilityInputs = {
  phase: GameCanvasPresentationPhase;
  uiChromeVisible: boolean;
  isMobile: boolean;
  mobileBarsVisible: boolean;
  lobbyFullscreenVisible: boolean;
};

type GameCanvasChromeVisibility = {
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
export const PLAYER_CLIENT_ENABLED_DEFAULT = true;

function loadStoredClientEnabled(mode: BattleMode): boolean {
  try {
    const raw = window.localStorage.getItem(CLIENT_ENABLED_STORAGE_KEYS[mode]);
    if (raw === null) {
      saveClientEnabled(mode, PLAYER_CLIENT_ENABLED_DEFAULT);
      return PLAYER_CLIENT_ENABLED_DEFAULT;
    }
    return raw !== 'false';
  } catch {
    return PLAYER_CLIENT_ENABLED_DEFAULT;
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
  menuHidden: Ref<boolean>;
  bottomBarsCollapsed: Ref<boolean>;
  playerClientEnabled: Ref<boolean>;
  toggleBottomBars: () => void;
  togglePlayerClientEnabled: () => void;
  resetPlayerClientEnabled: () => void;
  toggleMenuHidden: () => void;
} {
  const mobileBarsVisible = ref(false);
  const menuHidden = ref(!getStoredLobbyVisible(currentBattleMode.value));
  // Deliberately session-only: the BATTLE/SERVER/CLIENT group always starts
  // hidden — no localStorage read or write, and mode switches re-hide it.
  const bottomBarsCollapsed = ref(true);
  const playerClientEnabled = ref(loadStoredClientEnabled(currentBattleMode.value));

  watch(currentBattleMode, (mode) => {
    menuHidden.value = !getStoredLobbyVisible(mode);
    bottomBarsCollapsed.value = true;
    playerClientEnabled.value = loadStoredClientEnabled(mode);
  });

  watch(playerClientEnabled, (enabled) => {
    saveClientEnabled(currentBattleMode.value, enabled);
    onPlayerClientEnabledChange();
  });

  function toggleBottomBars(): void {
    bottomBarsCollapsed.value = !bottomBarsCollapsed.value;
  }

  function togglePlayerClientEnabled(): void {
    playerClientEnabled.value = !playerClientEnabled.value;
  }

  function resetPlayerClientEnabled(): void {
    // Persist explicitly even when the ref is already true. A watcher only
    // runs on a value transition, so relying on it would leave stale browser
    // state in place and the next reload would undo DEFAULTS.
    saveClientEnabled(currentBattleMode.value, PLAYER_CLIENT_ENABLED_DEFAULT);
    playerClientEnabled.value = PLAYER_CLIENT_ENABLED_DEFAULT;
  }

  function toggleMenuHidden(): void {
    menuHidden.value = !menuHidden.value;
    setLobbyVisible(!menuHidden.value);
  }

  return {
    mobileBarsVisible,
    menuHidden,
    bottomBarsCollapsed,
    playerClientEnabled,
    toggleBottomBars,
    togglePlayerClientEnabled,
    resetPlayerClientEnabled,
    toggleMenuHidden,
  };
}

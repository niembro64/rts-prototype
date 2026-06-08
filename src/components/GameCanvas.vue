<script setup lang="ts">
import { ref, computed, reactive, watch, watchEffect, onMounted, onBeforeUnmount } from 'vue';
import type { GameInstance } from '../game/createGame';
import type { PlayerId } from '../game/sim/types';
import type { BackgroundBattleState } from '../game/lobby/LobbyManager';
import SelectionPanel from './SelectionPanel.vue';
import TopBar from './TopBar.vue';
import Minimap from './Minimap.vue';
import LobbyModal, { type LobbyPlayer } from './LobbyModal.vue';
import GameCanvasOverlays from './GameCanvasOverlays.vue';
import GameCanvasBattleControlBar from './GameCanvasBattleControlBar.vue';
import GameCanvasServerControlBar from './GameCanvasServerControlBar.vue';
import GameCanvasClientControlBar from './GameCanvasClientControlBar.vue';
import LoadingEmblem from './LoadingEmblem.vue';
import type {
  GameCanvasBattleControlBarModel,
  GameCanvasClientControlBarModel,
  GameCanvasServerControlBarModel,
} from './gameCanvasControlBarModels';
import type { NetworkServerSnapshotMeta } from '../game/network/NetworkTypes';
import {
  networkManager,
  type NetworkRole,
} from '../game/network/NetworkManager';
import { BACKGROUND_UNIT_BLUEPRINT_IDS } from '../game/server/BackgroundBattleStandalone';
import {
  BATTLE_CONFIG,
  loadStoredCap,
  loadStoredCenterMagnitude,
  loadStoredDividersMagnitude,
  loadStoredGrid,
  loadStoredTerrainDTerrain,
  loadStoredMetalDepositStep,
  loadStoredTerrainDetail,
  loadStoredTerrainMapShape,
  loadStoredMapLandDimensions,
  type BattleMode,
} from '../battleBarConfig';
import type { TerrainMapShape } from '../types/terrain';
import {
  SERVER_CONFIG,
  loadStoredUnitGroundNormalEmaMode,
  snapshotRateHz,
} from '../serverBarConfig';
import type { UnitGroundNormalEmaMode } from '../shellConfig';
import { getPlayerColor } from './uiUtils';
import type { GameServer } from '../game/server/GameServer';
import type { GameConnection } from '../game/server/GameConnection';
import type { CameraFovDegrees } from '../types/client';
import {
  setPlayerClientRenderEnabled,
  useGameCanvasChromeState,
} from './gameCanvasChromeState';
import { useGameCanvasTelemetry } from './gameCanvasTelemetry';
import { useGameCanvasBackgroundBattle } from './gameCanvasBackgroundBattle';
import { useGameCanvasPresence } from './gameCanvasPresence';
import { useGameCanvasSoundTest } from './gameCanvasSoundTest';
import { useGameCanvasRealBattleLifecycle } from './gameCanvasRealBattleLifecycle';
import { useGameCanvasForegroundSceneBinding } from './gameCanvasForegroundSceneBinding';
import { useGameCanvasForegroundGame } from './gameCanvasForegroundGame';
import { useGameCanvasLobbyPreview } from './gameCanvasLobbyPreview';
import { useGameCanvasLobbyActions } from './gameCanvasLobbyActions';
import { useGameCanvasLobbySettings } from './gameCanvasLobbySettings';
import { useGameCanvasBattleSettings } from './gameCanvasBattleSettings';
import { BATTLE_PRESETS, findMatchingPresetName } from './battlePresets';
import { useGameCanvasServerSettings } from './gameCanvasServerSettings';
import { useGameCanvasClientSettings } from './gameCanvasClientSettings';
import { useGameCanvasRealBattleHandoff } from './gameCanvasRealBattleHandoff';
import { useGameCanvasSceneUi } from './gameCanvasSceneUi';
import { useGameCanvasSessionLifecycle } from './gameCanvasSessionLifecycle';
import { useGameCanvasShellDisplay } from './gameCanvasShellDisplay';
import { useGameCanvasLobbyRoster } from './gameCanvasLobbyRoster';

const isMobile =
  /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
    navigator.userAgent,
  );

const containerRef = ref<HTMLDivElement | null>(null);
const backgroundContainerRef = ref<HTMLDivElement | null>(null);
// The original DOM home of `backgroundContainerRef`. The watcher
// below moves the container between this element and the lobby
// modal's preview slot (`#lobby-preview-target`). Captured as a
// ref so the watcher doesn't depend on selector lookups.
const gameAreaRef = ref<HTMLDivElement | null>(null);
const activePlayer = ref<PlayerId>(1);
const fullscreenActive = ref(false);
const uiChromeVisible = ref(true);
const gameOverWinner = ref<PlayerId | null>(null);
const battleLoading = ref(false);
const rendererWarmupLoading = ref(true);
const showLoadingOverlay = computed(() => battleLoading.value || rendererWarmupLoading.value);
const loadingProgress = ref(0);
const loadingPhase = ref('Preparing battle');
const displayedLoadingProgress = computed(() => loadingProgress.value);
const displayedLoadingPhase = computed(() => loadingPhase.value);

function setLoadingProgress(progress: number, phase?: string): void {
  if (!Number.isFinite(progress)) {
    loadingProgress.value = 0;
    loadingPhase.value = phase ?? 'Preparing battle';
    return;
  }
  const clamped = Math.max(0, Math.min(1, progress));
  if (clamped <= 0) {
    loadingProgress.value = 0;
    loadingPhase.value = phase ?? 'Preparing battle';
    return;
  }
  if (phase && clamped >= loadingProgress.value) {
    loadingPhase.value = phase;
  }
  loadingProgress.value = Math.max(loadingProgress.value, clamped);
}

let getBackgroundBattle = (): BackgroundBattleState | null => null;
let startBackgroundBattle = async (): Promise<void> => {};
let stopBackgroundBattle = (): void => {};
let waitForBackgroundBattleIdle = async (): Promise<void> => {};

// Current game server (owned by this component)
let currentServer: GameServer | null = null;
const realBattleLifecycle = useGameCanvasRealBattleLifecycle();
const foregroundSceneBinding = useGameCanvasForegroundSceneBinding();
const foregroundGame = useGameCanvasForegroundGame();

// Lobby state
const showLobby = ref(true);
const isHost = ref(false);
const roomCode = ref('');
const lobbyPlayers = ref<LobbyPlayer[]>([]);
const localPlayerId = ref<PlayerId>(1);
const lobbyError = ref<string | null>(null);
const isConnecting = ref(false);
const gameStarted = ref(false);
const currentBattleMode = computed<BattleMode>(
  () => (gameStarted.value || roomCode.value !== '' ? 'real' : 'demo'),
);
const {
  mobileBarsVisible,
  spectateMode,
  bottomBarsCollapsed,
  playerClientEnabled,
  toggleBottomBars,
  togglePlayerClientEnabled,
  toggleSpectateMode,
} = useGameCanvasChromeState(currentBattleMode, applyPlayerClientEnabled);

function toggleUiChrome(): void {
  uiChromeVisible.value = !uiChromeVisible.value;
}

function getActiveOrbitCamera(): import('../game/render3d/OrbitCamera').OrbitCamera | null {
  return foregroundGame.getScene()?.getOrbitCamera() ?? null;
}
const networkRole = ref<NetworkRole | null>(null);
const hasServer = ref(false); // True when we own a GameServer (host/offline/background)
const networkNotice = ref<string | null>(null);
// Server metadata received from snapshots (for remote clients to display server bar)
const serverMetaFromSnapshot = ref<NetworkServerSnapshotMeta | null>(null);

const {
  lobbyPlayerCount,
  networkStatus,
  localLobbyPlayer,
  showPlayerToggle,
  lobbyModalVisible,
  showServerControls,
  serverBarReadonly,
  battleBarVars,
  serverBarVars,
  clientBarVars,
  battleLabel,
  serverLabel,
  clientLabel,
} = useGameCanvasShellDisplay({
  currentBattleMode,
  isMobile,
  showLobby,
  spectateMode,
  gameStarted,
  roomCode,
  lobbyPlayers,
  localPlayerId,
  networkRole,
  networkNotice,
  hasServer,
  serverMetaFromSnapshot,
});

const gameChromeVisible = computed(
  () => uiChromeVisible.value && (isMobile ? mobileBarsVisible.value : !lobbyModalVisible.value),
);
const bottomChromeVisible = computed(
  () => uiChromeVisible.value && !showLoadingOverlay.value && (isMobile ? mobileBarsVisible.value : !lobbyModalVisible.value),
);

const loadingInLobbyPreview = computed(
  () =>
    !gameStarted.value &&
    currentBattleMode.value === 'real' &&
    lobbyModalVisible.value &&
    showLoadingOverlay.value,
);
const showDemoLoadingOverlay = computed(
  () => showLoadingOverlay.value && !gameStarted.value && !loadingInLobbyPreview.value,
);
const showRealLoadingOverlay = computed(
  () => battleLoading.value && gameStarted.value,
);
const loadingNextLabel = computed(() => {
  if (gameStarted.value) return 'LOADING ONLINE BATTLE';
  if (currentBattleMode.value === 'real') return 'LOADING LOBBY SIMULATION';
  return 'LOADING DEMO BATTLE';
});
const lobbyControlsSidebarOpen = ref(false);
const showLobbyControlsSidebar = computed(
  () => uiChromeVisible.value && !isMobile && lobbyModalVisible.value,
);
watch(showLobbyControlsSidebar, (visible) => {
  if (!visible) lobbyControlsSidebarOpen.value = false;
});

const {
  localUsername,
  resolvePlayerName,
  upsertLobbyPlayer,
  onPlayerNameChange,
} = useGameCanvasLobbyRoster({
  network: networkManager,
  currentBattleMode,
  lobbyPlayers,
  localPlayerId,
});

let battleStartTime = 0;
const {
  battleElapsed,
  displayedClientIp,
  displayedClientTime,
  localIpAddress,
  reportLocalPlayerInfo,
} = useGameCanvasPresence({
  currentBattleMode,
  localLobbyPlayer,
  getBattleStartTime: () => battleStartTime,
  getBackgroundBattle: () => getBackgroundBattle(),
  getCurrentServer: () => currentServer,
});

function setInstanceCameraFovDegrees(
  instance: GameInstance | null | undefined,
  fov: CameraFovDegrees,
): void {
  instance?.app.setCameraFovDegrees(fov);
}

const effectivePlayerClientRenderEnabled = computed(
  () => playerClientEnabled.value && !showLoadingOverlay.value,
);
function applyPlayerClientEnabled(): void {
  const enabled = effectivePlayerClientRenderEnabled.value;
  setPlayerClientRenderEnabled(getBackgroundBattle()?.gameInstance, enabled);
  setPlayerClientRenderEnabled(foregroundGame.getInstance(), enabled);
}
watch(effectivePlayerClientRenderEnabled, () => applyPlayerClientEnabled());

function applyCameraFovDegrees(fov: CameraFovDegrees): void {
  setInstanceCameraFovDegrees(getBackgroundBattle()?.gameInstance, fov);
  setInstanceCameraFovDegrees(foregroundGame.getInstance(), fov);
}

// Active connection for sending commands (set when server/connection is created)
let activeConnection: GameConnection | null = null;

function syncFullscreenActive(): void {
  fullscreenActive.value = document.fullscreenElement !== null;
}

async function toggleFullscreen(): Promise<void> {
  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
    } else {
      await document.documentElement.requestFullscreen();
    }
  } catch (err) {
    console.warn('Fullscreen request failed', err);
  } finally {
    syncFullscreenActive();
  }
}

function captureScreenshot(): void {
  const canvas =
    containerRef.value?.querySelector('canvas') ??
    backgroundContainerRef.value?.querySelector('canvas');
  if (!(canvas instanceof HTMLCanvasElement)) return;

  canvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `budget-annihilation-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }, 'image/png');
}

function getActiveGameScene() {
  return foregroundGame.getScene() ?? getBackgroundBattle()?.gameInstance?.getScene() ?? null;
}

function goToLastPing(): void {
  getActiveGameScene()?.goToLastPing();
}

function flipCameraYaw(): void {
  getActiveGameScene()?.flipCameraYaw();
}

function showMapOverview(): void {
  getActiveGameScene()?.showMapOverview();
}

function setCameraAnchor(index: number): void {
  getActiveGameScene()?.setCameraAnchor(index);
}

function focusCameraAnchor(index: number): void {
  getActiveGameScene()?.focusCameraAnchor(index);
}

onMounted(() => {
  syncFullscreenActive();
  document.addEventListener('fullscreenchange', syncFullscreenActive);
});

onBeforeUnmount(() => {
  document.removeEventListener('fullscreenchange', syncFullscreenActive);
});

// Demo battle unit blueprint list (state read from snapshots)
const demoUnitBlueprintIds = BACKGROUND_UNIT_BLUEPRINT_IDS;

// Terrain-shape selection. Source of truth is localStorage; the
// refs below mirror it so the battle bar can reactively highlight
// the active option. Changing the shape rebuilds the heightmap on
// the next game construction (background battle restart for live
// preview, or first real-game start), so click handlers save the
// new value AND restart the demo battle when one is running.
// Initial load is always demo mode — at component-mount time the
// user is on the BUDGET ANNIHILATION screen (gameStarted=false,
// roomCode=''). Switching into the GAME LOBBY flips
// `currentBattleMode` to `real`; the lobby-preview composable reloads
// these refs from the real-battle keys at that point.
const centerMagnitude = ref<number>(loadStoredCenterMagnitude('demo'));
const dividersMagnitude = ref<number>(loadStoredDividersMagnitude('demo'));
const terrainMapShape = ref<TerrainMapShape>(loadStoredTerrainMapShape('demo'));
const terrainDTerrain = ref<number>(loadStoredTerrainDTerrain('demo'));
const metalDepositStep = ref<number>(loadStoredMetalDepositStep('demo'));
const terrainDetail = ref<number>(loadStoredTerrainDetail('demo'));
const initialMapDimensions = loadStoredMapLandDimensions('demo');
const mapWidthLandCells = ref<number>(initialMapDimensions.widthLandCells);
const mapLengthLandCells = ref<number>(initialMapDimensions.lengthLandCells);
const {
  renderMode,
  audioScope,
  masterVolume,
  audioSmoothing,
  burnMarks,
  locomotionMarks,
  smokeTrails,
  smokeSoftEdges,
  beamSnapToTurret,
  resourceBallDensity,
  triangleDebug,
  buildGridDebug,
  sightBoundary,
  radarBoundary,
  movementPosEma,
  movementVelEma,
  rotationPosEma,
  rotationVelEma,
  predictionMode,
  clientUnitGroundNormalEmaMode,
  edgeScrollEnabled,
  dragPanEnabled,
  waypointDetail,
  entityHud,
  selectionHudMode,
  commandHotkeyPreset,
  soundToggles,
  rangeToggles,
  projRangeToggles,
  unitRadiusToggles,
  legsRadiusToggle,
  cameraSmoothMode,
  cameraFollowMode,
  cameraFovDegrees,
  allRangesActive,
  allProjRangesActive,
  allUnitRadiiActive,
  allPanActive,
  entityHudTypes,
  entityHudElements,
  SFX_CATEGORIES,
  allSoundsActive,
  SOUND_LABELS,
  SOUND_TOOLTIPS,
  resetClientDefaults,
  changeRenderMode,
  changeAudioScope,
  changeMasterVolume,
  toggleRange,
  toggleProjRange,
  toggleUnitRadius,
  toggleLegsRadius,
  setCameraMode,
  setCameraFollow,
  changeCameraFovDegrees,
  toggleAllRanges,
  toggleAllProjRanges,
  toggleAllUnitRadii,
  toggleAudioSmoothing,
  toggleBurnMarks,
  toggleLocomotionMarks,
  toggleSmokeTrails,
  toggleSmokeSoftEdges,
  toggleBeamSnapToTurret,
  changeResourceBallDensity,
  toggleTriangleDebug,
  toggleBuildGridDebug,
  toggleSightBoundary,
  toggleRadarBoundary,
  changeMovementPosEma,
  changeMovementVelEma,
  changeRotationPosEma,
  changeRotationVelEma,
  changePredictionMode,
  changeClientUnitGroundNormalEmaMode,
  changeWaypointDetail,
  toggleEntityHud,
  changeSelectionHudMode,
  changeCommandHotkeyPreset,
  toggleEdgeScroll,
  toggleDragPan,
  toggleAllPan,
  toggleAllSounds,
  toggleSoundCategory,
} = useGameCanvasClientSettings({
  currentClientMode: currentBattleMode,
  applyCameraFovDegrees,
});

const { showSoundTest } = useGameCanvasSoundTest();

const {
  selectionInfo,
  economyInfo,
  minimapData,
  bindGameSceneUi,
  togglePlayer,
  handleMinimapClick,
  selectionActions,
} = useGameCanvasSceneUi({
  activePlayer,
  gameOverWinner,
  serverMetaFromSnapshot,
  foregroundGame,
  getBackgroundBattle: () => getBackgroundBattle(),
});

({
  getBackgroundBattle,
  startBackgroundBattle,
  stopBackgroundBattle,
  waitForBackgroundBattleIdle,
} = useGameCanvasBackgroundBattle({
  backgroundContainerRef,
  getLocalIpAddress: () => localIpAddress.value,
  getBattleMode: () => currentBattleMode.value,
  getPreviewPlayerIds: () => currentBattleMode.value === 'real'
    ? lobbyPlayers.value.map((p) => p.playerId)
    : undefined,
  getPreviewLocalPlayerId: () => currentBattleMode.value === 'real'
    ? localPlayerId.value
    : undefined,
  getPlayerClientEnabled: () => playerClientEnabled.value,
  onLoadingProgress: setLoadingProgress,
  bindSceneUi: (scene) => bindGameSceneUi(scene),
  onRendererWarmupChange: (warming) => {
    if (!gameStarted.value) rendererWarmupLoading.value = warming;
  },
  onStarted: (battle) => {
    activeConnection = battle.connection;
    hasServer.value = true;
    battleStartTime = Date.now();
    setPlayerClientRenderEnabled(battle.gameInstance, playerClientEnabled.value);
    setInstanceCameraFovDegrees(battle.gameInstance, cameraFovDegrees.value);
  },
  onStopped: () => {
    if (!currentServer) {
      activeConnection = null;
      hasServer.value = false;
      if (!gameStarted.value) battleStartTime = 0;
    }
  },
}));

useGameCanvasLobbyPreview({
  backgroundContainerRef,
  gameAreaRef,
  currentBattleMode,
  lobbyModalVisible,
  roomCode,
  gameStarted,
  lobbyPlayerCount,
  localPlayerId,
  centerMagnitude,
  dividersMagnitude,
  terrainMapShape,
  terrainDTerrain,
  metalDepositStep,
  terrainDetail,
  mapWidthLandCells,
  mapLengthLandCells,
  stopBackgroundBattle,
  startBackgroundBattle,
});

// Display values: always read from snapshot meta (server→snapshot→display)
const displayServerTpsAvg = computed(
  () => serverMetaFromSnapshot.value?.ticks.avg ?? 0,
);
const displayServerTpsWorst = computed(
  () => serverMetaFromSnapshot.value?.ticks.low ?? 0,
);
const {
  currentZoom,
  diffSnapSizeAvgBytes,
  diffSnapSizeHiBytes,
  displayGpuMs,
  frameMsAvg,
  frameMsHi,
  fullSnapAvgRate,
  fullSnapSizeAvgBytes,
  fullSnapSizeHiBytes,
  fullSnapWorstRate,
  gpuSourceLabel,
  gpuTimerSupported,
  hudSpriteActiveCount,
  hudSpriteBudgetCount,
  hudSpriteDisposedCount,
  hudSpritePeakCount,
  hudSpriteRetainedCount,
  scopedMeshDestroyPerSec,
  scopedMeshHiddenPerSec,
  scopedMeshReactivatedPerSec,
  scopedMeshRebuildPerSec,
  scopedRetainedBuildingMeshes,
  scopedRetainedUnitMeshes,
  rendererContextAuxiliaryBudget,
  rendererContextAuxiliaryCount,
  rendererContextDeniedAuxiliaryCount,
  rendererContextMainCount,
  logicMsAvg,
  logicMsHi,
  longtaskMsPerSec,
  longtaskSupported,
  renderMsAvg,
  renderMsHi,
  renderTpsAvg,
  renderTpsWorst,
  snapAvgRate,
  snapWorstRate,
} = useGameCanvasTelemetry({
  getScene: () => getBackgroundBattle()?.gameInstance?.getScene() ?? foregroundGame.getScene(),
});
const displayServerCpuAvg = computed(
  () => serverMetaFromSnapshot.value?.cpu?.avg ?? 0,
);
const displayServerCpuHi = computed(
  () => serverMetaFromSnapshot.value?.cpu?.hi ?? 0,
);
const displayTickRate = computed(
  () =>
    serverMetaFromSnapshot.value?.ticks.rate ?? SERVER_CONFIG.tickRate.default,
);
// HOST SERVER unit ground normal EMA mode. Picks the half-life used by the
// sim's updateUnitGroundNormal (UNIT_GROUND_NORMAL_EMA_HALF_LIFE_SEC[mode]). Persisted to
// localStorage and pushed via setUnitGroundNormalEmaMode command.
const serverUnitGroundNormalEmaMode = ref<UnitGroundNormalEmaMode>(
  loadStoredUnitGroundNormalEmaMode(currentBattleMode.value),
);
// Reload the persisted EMA mode when the bar swaps namespaces. The
// host pushes its own setting via the setUnitGroundNormalEmaMode
// command path; this watcher keeps the local control's display in
// sync with the new mode's stored value.
watch(currentBattleMode, (mode) => {
  serverUnitGroundNormalEmaMode.value = loadStoredUnitGroundNormalEmaMode(mode);
});
// HOST SERVER unit ground normal EMA — the host applies its setting via the
// setUnitGroundNormalEmaMode command, but remote clients render this control
// from snapshot meta (their own localStorage is irrelevant once
// connected). Reconcile when the host's value differs.
watch(
  () => serverMetaFromSnapshot.value?.unitGroundNormalEma,
  (mode) => {
    if (!mode) return;
    if (!SERVER_CONFIG.unitGroundNormalEma.options.includes(mode as UnitGroundNormalEmaMode)) return;
    if (mode === serverUnitGroundNormalEmaMode.value) return;
    serverUnitGroundNormalEmaMode.value = mode as UnitGroundNormalEmaMode;
  },
);
const displaySnapshotRate = computed(
  () =>
    serverMetaFromSnapshot.value?.snaps.rate ??
    SERVER_CONFIG.snapshot.default,
);
const displayKeyframeRatio = computed(
  () =>
    serverMetaFromSnapshot.value?.snaps.keyframes ??
    SERVER_CONFIG.keyframe.default,
);
// Bar-fill target for FSPS: full snapshots are a configurable fraction
// of the host DIFFSNAP rate.
const fullSnapBarTarget = computed(() => {
  const sps = snapshotRateHz(displaySnapshotRate.value, displayTickRate.value);
  const kf = displayKeyframeRatio.value;
  if (kf === 'NONE') return 1;
  if (kf === 'ALL') return sps;
  return Math.max(0.1, sps * (kf as number));
});
const remoteSnapshotClientCount = computed(() =>
  Math.max(0, lobbyPlayerCount.value - 1),
);
const snapshotMbpsPerClient = computed(() => {
  const diffSnapAvgRate = Math.max(0, snapAvgRate.value - fullSnapAvgRate.value);
  const bytesPerSec =
    diffSnapSizeAvgBytes.value * diffSnapAvgRate +
    fullSnapSizeAvgBytes.value * fullSnapAvgRate.value;
  return Math.max(0, (bytesPerSec * 8) / 1_000_000);
});
const snapshotMbpsHostTotal = computed(() =>
  snapshotMbpsPerClient.value * remoteSnapshotClientCount.value,
);
const displayGridInfo = computed(
  () => serverMetaFromSnapshot.value?.grid ?? loadStoredGrid(currentBattleMode.value),
);
const displayUnitCount = computed(
  () => serverMetaFromSnapshot.value?.units.count ?? 0,
);
const displayUnitCap = computed(
  () => serverMetaFromSnapshot.value?.units.max ?? loadStoredCap(currentBattleMode.value),
);
const displayServerTime = computed(
  () => serverMetaFromSnapshot.value?.server.time ?? '',
);
const displayServerIp = computed(
  () => serverMetaFromSnapshot.value?.server.ip ?? '',
);
const {
  currentLobbySettings,
  broadcastLobbySettingsIfHost,
  applyCenterMagnitude,
  applyDividersMagnitude,
  applyTerrainMapShape,
  applyTerrainDTerrain,
  applyMetalDepositStep,
  applyTerrainDetail,
  applyMapLandDimensions,
  applyLobbySettingsFromHost,
} = useGameCanvasLobbySettings({
  network: networkManager,
  currentBattleMode,
  networkRole,
  roomCode,
  gameStarted,
  centerMagnitude,
  dividersMagnitude,
  terrainMapShape,
  terrainDTerrain,
  metalDepositStep,
  terrainDetail,
  mapWidthLandCells,
  mapLengthLandCells,
  stopBackgroundBattle,
  startBackgroundBattle,
});

const {
  resetServerDefaults,
  setNetworkUpdateRate,
  setTickRateValue,
  setUnitGroundNormalEmaModeValue,
  setKeyframeRatioValue,
  resetGridInfoToDefault,
} = useGameCanvasServerSettings({
  currentBattleMode,
  displayGridInfo,
  serverUnitGroundNormalEmaMode,
  getActiveConnection: () => activeConnection,
});

const {
  currentAllowedUnits,
  currentAllowedUnitsSet,
  allDemoUnitsActive,
  currentShieldsObstructSight,
  currentFogOfWarEnabled,
  currentConverterTax,
  toggleDemoUnitBlueprintId,
  toggleAllDemoUnits,
  changeMaxTotalUnits,
  setShieldsObstructSight,
  setFogOfWarEnabled,
  setConverterTax,
  resetDemoDefaults,
  applyPreset,
} = useGameCanvasBattleSettings({
  serverMetaFromSnapshot,
  currentBattleMode,
  demoUnitBlueprintIds,
  getActiveConnection: () => activeConnection,
  resetGridInfoToDefault,
  broadcastLobbySettingsIfHost,
  applyCenterMagnitude,
  applyDividersMagnitude,
  applyTerrainMapShape,
  applyTerrainDTerrain,
  applyMetalDepositStep,
  applyTerrainDetail,
  applyMapLandDimensions,
});

const {
  setupNetworkCallbacks,
  startGameWithPlayers,
} = useGameCanvasRealBattleHandoff({
  containerRef,
  showLobby,
  gameStarted,
  battleLoading,
  activePlayer,
  localPlayerId,
  networkRole,
  playerClientEnabled,
  cameraFovDegrees,
  localIpAddress,
  hasServer,
  networkNotice,
  lobbyError,
  lobbyPlayers,
  roomCode,
  localUsername,
  network: networkManager,
  lifecycle: realBattleLifecycle,
  foregroundGame,
  foregroundSceneBinding,
  stopBackgroundBattle,
  waitForBackgroundBattleIdle,
  getCurrentServer: () => currentServer,
  setCurrentServer: (server) => {
    currentServer = server;
  },
  setActiveConnection: (connection) => {
    activeConnection = connection;
  },
  setBattleStartTime: (time) => {
    battleStartTime = time;
  },
  resolvePlayerName,
  upsertLobbyPlayer,
  applyLobbySettingsFromHost,
  currentLobbySettings,
  onLoadingProgress: setLoadingProgress,
  bindSceneUi: (scene) => {
    bindGameSceneUi(scene, true);
  },
});

const { restartGame } = useGameCanvasSessionLifecycle({
  gameOverWinner,
  battleLoading,
  gameStarted,
  showLobby,
  networkRole,
  lobbyPlayers,
  roomCode,
  lobbyError,
  networkNotice,
  hasServer,
  serverMetaFromSnapshot,
  network: networkManager,
  lifecycle: realBattleLifecycle,
  foregroundSceneBinding,
  foregroundGame,
  getCurrentServer: () => currentServer,
  setCurrentServer: (server) => {
    currentServer = server;
  },
  setActiveConnection: (connection) => {
    activeConnection = connection;
  },
  setBattleStartTime: (time) => {
    battleStartTime = time;
  },
  startBackgroundBattle,
  stopBackgroundBattle,
});

const {
  handleHost,
  handleJoin,
  handleLobbyStart,
  handleLobbyCancel,
  handleOffline,
} = useGameCanvasLobbyActions({
  network: networkManager,
  isConnecting,
  lobbyError,
  networkNotice,
  roomCode,
  isHost,
  networkRole,
  localPlayerId,
  lobbyPlayers,
  battleLoading,
  setupNetworkCallbacks,
  reportLocalPlayerInfo,
  startGameWithPlayers,
  onLoadingProgress: setLoadingProgress,
});

// Reactive object instead of computed-returning-fresh-literal so the
// model identity stays stable across snapshot ticks. The previous
// pattern allocated a brand new 30-field object on every dep change,
// forcing the child <GameCanvasBattleControlBar> + its 50-odd
// BarButton children through a full prop diff. With per-field
// reactivity the only re-evaluations are templates that actually
// read the changed field. Methods and the demoUnitBlueprintIds ref are
// stable references so they sit on the object once at construction.
const battleControlBarModel = reactive<GameCanvasBattleControlBarModel>({
  isReadonly: serverBarReadonly.value,
  barStyle: battleBarVars.value,
  battleLabel: battleLabel.value,
  battleElapsed: battleElapsed.value,
  allDemoUnitsActive: allDemoUnitsActive.value,
  demoUnitBlueprintIds,
  currentAllowedUnits: currentAllowedUnits.value,
  currentAllowedUnitsSet: currentAllowedUnitsSet.value,
  displayUnitCap: displayUnitCap.value,
  gameStarted: gameStarted.value,
  mapWidthLandCells: mapWidthLandCells.value,
  mapLengthLandCells: mapLengthLandCells.value,
  centerMagnitude: centerMagnitude.value,
  dividersMagnitude: dividersMagnitude.value,
  terrainMapShape: terrainMapShape.value,
  terrainDTerrain: terrainDTerrain.value,
  metalDepositStep: metalDepositStep.value,
  terrainDetail: terrainDetail.value,
  displayUnitCount: displayUnitCount.value,
  currentShieldsObstructSight: currentShieldsObstructSight.value,
  currentFogOfWarEnabled: currentFogOfWarEnabled.value,
  currentConverterTax: currentConverterTax.value,
  presets: BATTLE_PRESETS,
  activePresetName: null,
  applyPreset,
  resetDemoDefaults,
  toggleAllDemoUnits,
  toggleDemoUnitBlueprintId,
  changeMaxTotalUnits,
  applyMapLandDimensions,
  applyCenterMagnitude,
  applyDividersMagnitude,
  applyTerrainMapShape,
  applyTerrainDTerrain,
  applyMetalDepositStep,
  applyTerrainDetail,
  setShieldsObstructSight,
  setFogOfWarEnabled,
  setConverterTax,
});
watchEffect(() => {
  const m = battleControlBarModel as {
    -readonly [K in keyof GameCanvasBattleControlBarModel]: GameCanvasBattleControlBarModel[K];
  };
  m.isReadonly = serverBarReadonly.value;
  m.barStyle = battleBarVars.value;
  m.battleLabel = battleLabel.value;
  m.battleElapsed = battleElapsed.value;
  m.allDemoUnitsActive = allDemoUnitsActive.value;
  m.currentAllowedUnits = currentAllowedUnits.value;
  m.currentAllowedUnitsSet = currentAllowedUnitsSet.value;
  m.displayUnitCap = displayUnitCap.value;
  m.gameStarted = gameStarted.value;
  m.mapWidthLandCells = mapWidthLandCells.value;
  m.mapLengthLandCells = mapLengthLandCells.value;
  m.centerMagnitude = centerMagnitude.value;
  m.dividersMagnitude = dividersMagnitude.value;
  m.terrainMapShape = terrainMapShape.value;
  m.terrainDTerrain = terrainDTerrain.value;
  m.metalDepositStep = metalDepositStep.value;
  m.terrainDetail = terrainDetail.value;
  m.displayUnitCount = displayUnitCount.value;
  m.currentShieldsObstructSight = currentShieldsObstructSight.value;
  m.currentFogOfWarEnabled = currentFogOfWarEnabled.value;
  m.currentConverterTax = currentConverterTax.value;
  m.activePresetName = findMatchingPresetName({
    units: currentAllowedUnits.value,
    cap: displayUnitCap.value,
    turretShieldPanelsEnabled: BATTLE_CONFIG.turretShieldPanelsEnabled.default,
    turretShieldSpheresEnabled: BATTLE_CONFIG.turretShieldSpheresEnabled.default,
    shieldsObstructSight: currentShieldsObstructSight.value,
    shieldReflectionMode: BATTLE_CONFIG.shieldReflectionMode.default,
    fogOfWarEnabled: currentFogOfWarEnabled.value,
    converterTax: currentConverterTax.value,
    centerMagnitude: centerMagnitude.value,
    dividersMagnitude: dividersMagnitude.value,
    terrainMapShape: terrainMapShape.value,
    terrainDTerrain: terrainDTerrain.value,
    metalDepositStep: metalDepositStep.value,
    terrainDetail: terrainDetail.value,
    mapWidthLandCells: mapWidthLandCells.value,
    mapLengthLandCells: mapLengthLandCells.value,
    grid: displayGridInfo.value,
    barsCollapsed: bottomBarsCollapsed.value,
  });
});

// Same reactive() pattern as battleControlBarModel: stable proxy
// identity so per-field changes only trigger renders of bindings that
  // actually read the changed field. See the battle bar comment above
  // for the why.
const serverControlBarModel = reactive<GameCanvasServerControlBarModel>({
  isReadonly: serverBarReadonly.value,
  barStyle: serverBarVars.value,
  serverLabel: serverLabel.value,
  displayServerTime: displayServerTime.value,
  displayServerIp: displayServerIp.value,
  displayTickRate: displayTickRate.value,
  serverUnitGroundNormalEmaMode: serverUnitGroundNormalEmaMode.value,
  displayServerTpsAvg: displayServerTpsAvg.value,
  displayServerTpsWorst: displayServerTpsWorst.value,
  displayServerCpuAvg: displayServerCpuAvg.value,
  displayServerCpuHi: displayServerCpuHi.value,
  displaySnapshotRate: displaySnapshotRate.value,
  displayKeyframeRatio: displayKeyframeRatio.value,
  resetServerDefaults,
  setTickRateValue,
  setUnitGroundNormalEmaModeValue,
  setNetworkUpdateRate,
  setKeyframeRatioValue,
});
watchEffect(() => {
  const m = serverControlBarModel as {
    -readonly [K in keyof GameCanvasServerControlBarModel]: GameCanvasServerControlBarModel[K];
  };
  m.isReadonly = serverBarReadonly.value;
  m.barStyle = serverBarVars.value;
  m.serverLabel = serverLabel.value;
  m.displayServerTime = displayServerTime.value;
  m.displayServerIp = displayServerIp.value;
  m.displayTickRate = displayTickRate.value;
  m.serverUnitGroundNormalEmaMode = serverUnitGroundNormalEmaMode.value;
  m.displayServerTpsAvg = displayServerTpsAvg.value;
  m.displayServerTpsWorst = displayServerTpsWorst.value;
  m.displayServerCpuAvg = displayServerCpuAvg.value;
  m.displayServerCpuHi = displayServerCpuHi.value;
  m.displaySnapshotRate = displaySnapshotRate.value;
  m.displayKeyframeRatio = displayKeyframeRatio.value;
});

// Same reactive() pattern as the other two bar models. This one is
// the biggest bar model, so the parent + child re-render savings
// scale across sound/range/radius toggles and live telemetry.
const clientControlBarModel = reactive<GameCanvasClientControlBarModel>({
  barStyle: clientBarVars.value,
  clientLabel: clientLabel.value,
  playerClientEnabled: playerClientEnabled.value,
  displayedClientTime: displayedClientTime.value,
  displayedClientIp: displayedClientIp.value,
  waypointDetail: waypointDetail.value,
  entityHud,
  selectionHudMode: selectionHudMode.value,
  commandHotkeyPreset: commandHotkeyPreset.value,
  entityHudTypes,
  entityHudElements,
  logicMsAvg: logicMsAvg.value,
  logicMsHi: logicMsHi.value,
  renderMsAvg: renderMsAvg.value,
  renderMsHi: renderMsHi.value,
  displayGpuMs: displayGpuMs.value,
  gpuSourceLabel: gpuSourceLabel.value,
  gpuTimerSupported: gpuTimerSupported.value,
  rendererContextMainCount: rendererContextMainCount.value,
  rendererContextAuxiliaryCount: rendererContextAuxiliaryCount.value,
  rendererContextAuxiliaryBudget: rendererContextAuxiliaryBudget.value,
  rendererContextDeniedAuxiliaryCount: rendererContextDeniedAuxiliaryCount.value,
  hudSpriteActiveCount: hudSpriteActiveCount.value,
  hudSpriteRetainedCount: hudSpriteRetainedCount.value,
  hudSpritePeakCount: hudSpritePeakCount.value,
  hudSpriteDisposedCount: hudSpriteDisposedCount.value,
  hudSpriteBudgetCount: hudSpriteBudgetCount.value,
  scopedRetainedUnitMeshes: scopedRetainedUnitMeshes.value,
  scopedRetainedBuildingMeshes: scopedRetainedBuildingMeshes.value,
  scopedMeshHiddenPerSec: scopedMeshHiddenPerSec.value,
  scopedMeshReactivatedPerSec: scopedMeshReactivatedPerSec.value,
  scopedMeshDestroyPerSec: scopedMeshDestroyPerSec.value,
  scopedMeshRebuildPerSec: scopedMeshRebuildPerSec.value,
  frameMsAvg: frameMsAvg.value,
  frameMsHi: frameMsHi.value,
  longtaskSupported: longtaskSupported.value,
  longtaskMsPerSec: longtaskMsPerSec.value,
  renderTpsAvg: renderTpsAvg.value,
  renderTpsWorst: renderTpsWorst.value,
  currentZoom: currentZoom.value,
  snapAvgRate: snapAvgRate.value,
  snapWorstRate: snapWorstRate.value,
  displayTickRate: displayTickRate.value,
  displaySnapshotRate: displaySnapshotRate.value,
  fullSnapAvgRate: fullSnapAvgRate.value,
  fullSnapWorstRate: fullSnapWorstRate.value,
  fullSnapBarTarget: fullSnapBarTarget.value,
  diffSnapSizeAvgBytes: diffSnapSizeAvgBytes.value,
  diffSnapSizeHiBytes: diffSnapSizeHiBytes.value,
  fullSnapSizeAvgBytes: fullSnapSizeAvgBytes.value,
  fullSnapSizeHiBytes: fullSnapSizeHiBytes.value,
  snapshotMbpsPerClient: snapshotMbpsPerClient.value,
  snapshotMbpsHostTotal: snapshotMbpsHostTotal.value,
  remoteSnapshotClientCount: remoteSnapshotClientCount.value,
  audioSmoothing: audioSmoothing.value,
  burnMarks: burnMarks.value,
  locomotionMarks: locomotionMarks.value,
  smokeTrails: smokeTrails.value,
  smokeSoftEdges: smokeSoftEdges.value,
  beamSnapToTurret: beamSnapToTurret.value,
  resourceBallDensity: resourceBallDensity.value,
  movementPosEma: movementPosEma.value,
  movementVelEma: movementVelEma.value,
  rotationPosEma: rotationPosEma.value,
  rotationVelEma: rotationVelEma.value,
  predictionMode: predictionMode.value,
  clientUnitGroundNormalEmaMode: clientUnitGroundNormalEmaMode.value,
  allPanActive: allPanActive.value,
  dragPanEnabled: dragPanEnabled.value,
  edgeScrollEnabled: edgeScrollEnabled.value,
  showServerControls: showServerControls.value,
  triangleDebug: triangleDebug.value,
  buildGridDebug: buildGridDebug.value,
  sightBoundary: sightBoundary.value,
  radarBoundary: radarBoundary.value,
  renderMode: renderMode.value,
  audioScope: audioScope.value,
  masterVolume: masterVolume.value,
  allSoundsActive: allSoundsActive.value,
  soundToggles,
  sfxCategories: SFX_CATEGORIES,
  soundLabels: SOUND_LABELS,
  soundTooltips: SOUND_TOOLTIPS,
  allRangesActive: allRangesActive.value,
  rangeToggles,
  allProjRangesActive: allProjRangesActive.value,
  projRangeToggles,
  allUnitRadiiActive: allUnitRadiiActive.value,
  unitRadiusToggles,
  legsRadiusToggle: legsRadiusToggle.value,
  cameraFovDegrees: cameraFovDegrees.value,
  cameraSmoothMode: cameraSmoothMode.value,
  cameraFollowMode: cameraFollowMode.value,
  fullscreenActive: fullscreenActive.value,
  uiChromeVisible: uiChromeVisible.value,
  resetClientDefaults,
  togglePlayerClientEnabled,
  changeWaypointDetail,
  toggleEntityHud,
  changeSelectionHudMode,
  changeCommandHotkeyPreset,
  toggleAudioSmoothing,
  toggleBurnMarks,
  toggleLocomotionMarks,
  toggleSmokeTrails,
  toggleSmokeSoftEdges,
  toggleBeamSnapToTurret,
  changeResourceBallDensity,
  changeMovementPosEma,
  changeMovementVelEma,
  changeRotationPosEma,
  changeRotationVelEma,
  changePredictionMode,
  changeClientUnitGroundNormalEmaMode,
  toggleAllPan,
  toggleDragPan,
  toggleEdgeScroll,
  toggleTriangleDebug,
  toggleBuildGridDebug,
  toggleSightBoundary,
  toggleRadarBoundary,
  changeRenderMode,
  changeAudioScope,
  changeMasterVolume,
  changeGameSpeed: setTickRateValue,
  toggleAllSounds,
  toggleSoundCategory,
  toggleAllRanges,
  toggleRange,
  toggleAllProjRanges,
  toggleProjRange,
  toggleAllUnitRadii,
  toggleUnitRadius,
  toggleLegsRadius,
  changeCameraFovDegrees,
  setCameraMode,
  setCameraFollowMode: setCameraFollow,
  showMapOverview,
  flipCameraYaw,
  setCameraAnchor,
  focusCameraAnchor,
  toggleFullscreen,
  captureScreenshot,
  goToLastPing,
  toggleUiChrome,
});
watchEffect(() => {
  const m = clientControlBarModel as {
    -readonly [K in keyof GameCanvasClientControlBarModel]: GameCanvasClientControlBarModel[K];
  };
  m.barStyle = clientBarVars.value;
  m.clientLabel = clientLabel.value;
  m.playerClientEnabled = playerClientEnabled.value;
  m.displayedClientTime = displayedClientTime.value;
  m.displayedClientIp = displayedClientIp.value;
  m.waypointDetail = waypointDetail.value;
  m.selectionHudMode = selectionHudMode.value;
  m.commandHotkeyPreset = commandHotkeyPreset.value;
  m.logicMsAvg = logicMsAvg.value;
  m.logicMsHi = logicMsHi.value;
  m.renderMsAvg = renderMsAvg.value;
  m.renderMsHi = renderMsHi.value;
  m.displayGpuMs = displayGpuMs.value;
  m.gpuSourceLabel = gpuSourceLabel.value;
  m.gpuTimerSupported = gpuTimerSupported.value;
  m.rendererContextMainCount = rendererContextMainCount.value;
  m.rendererContextAuxiliaryCount = rendererContextAuxiliaryCount.value;
  m.rendererContextAuxiliaryBudget = rendererContextAuxiliaryBudget.value;
  m.rendererContextDeniedAuxiliaryCount = rendererContextDeniedAuxiliaryCount.value;
  m.hudSpriteActiveCount = hudSpriteActiveCount.value;
  m.hudSpriteRetainedCount = hudSpriteRetainedCount.value;
  m.hudSpritePeakCount = hudSpritePeakCount.value;
  m.hudSpriteDisposedCount = hudSpriteDisposedCount.value;
  m.hudSpriteBudgetCount = hudSpriteBudgetCount.value;
  m.scopedRetainedUnitMeshes = scopedRetainedUnitMeshes.value;
  m.scopedRetainedBuildingMeshes = scopedRetainedBuildingMeshes.value;
  m.scopedMeshHiddenPerSec = scopedMeshHiddenPerSec.value;
  m.scopedMeshReactivatedPerSec = scopedMeshReactivatedPerSec.value;
  m.scopedMeshDestroyPerSec = scopedMeshDestroyPerSec.value;
  m.scopedMeshRebuildPerSec = scopedMeshRebuildPerSec.value;
  m.frameMsAvg = frameMsAvg.value;
  m.frameMsHi = frameMsHi.value;
  m.longtaskSupported = longtaskSupported.value;
  m.longtaskMsPerSec = longtaskMsPerSec.value;
  m.renderTpsAvg = renderTpsAvg.value;
  m.renderTpsWorst = renderTpsWorst.value;
  m.currentZoom = currentZoom.value;
  m.snapAvgRate = snapAvgRate.value;
  m.snapWorstRate = snapWorstRate.value;
  m.displayTickRate = displayTickRate.value;
  m.displaySnapshotRate = displaySnapshotRate.value;
  m.fullSnapAvgRate = fullSnapAvgRate.value;
  m.fullSnapWorstRate = fullSnapWorstRate.value;
  m.fullSnapBarTarget = fullSnapBarTarget.value;
  m.diffSnapSizeAvgBytes = diffSnapSizeAvgBytes.value;
  m.diffSnapSizeHiBytes = diffSnapSizeHiBytes.value;
  m.fullSnapSizeAvgBytes = fullSnapSizeAvgBytes.value;
  m.fullSnapSizeHiBytes = fullSnapSizeHiBytes.value;
  m.snapshotMbpsPerClient = snapshotMbpsPerClient.value;
  m.snapshotMbpsHostTotal = snapshotMbpsHostTotal.value;
  m.remoteSnapshotClientCount = remoteSnapshotClientCount.value;
  m.audioSmoothing = audioSmoothing.value;
  m.burnMarks = burnMarks.value;
  m.locomotionMarks = locomotionMarks.value;
  m.smokeTrails = smokeTrails.value;
  m.smokeSoftEdges = smokeSoftEdges.value;
  m.beamSnapToTurret = beamSnapToTurret.value;
  m.resourceBallDensity = resourceBallDensity.value;
  m.movementPosEma = movementPosEma.value;
  m.movementVelEma = movementVelEma.value;
  m.rotationPosEma = rotationPosEma.value;
  m.rotationVelEma = rotationVelEma.value;
  m.predictionMode = predictionMode.value;
  m.clientUnitGroundNormalEmaMode = clientUnitGroundNormalEmaMode.value;
  m.allPanActive = allPanActive.value;
  m.dragPanEnabled = dragPanEnabled.value;
  m.edgeScrollEnabled = edgeScrollEnabled.value;
  m.showServerControls = showServerControls.value;
  m.triangleDebug = triangleDebug.value;
  m.buildGridDebug = buildGridDebug.value;
  m.sightBoundary = sightBoundary.value;
  m.radarBoundary = radarBoundary.value;
  m.renderMode = renderMode.value;
  m.audioScope = audioScope.value;
  m.masterVolume = masterVolume.value;
  m.allSoundsActive = allSoundsActive.value;
  m.allRangesActive = allRangesActive.value;
  m.allProjRangesActive = allProjRangesActive.value;
  m.allUnitRadiiActive = allUnitRadiiActive.value;
  m.legsRadiusToggle = legsRadiusToggle.value;
  m.cameraFovDegrees = cameraFovDegrees.value;
  m.cameraSmoothMode = cameraSmoothMode.value;
  m.cameraFollowMode = cameraFollowMode.value;
  m.fullscreenActive = fullscreenActive.value;
  m.uiChromeVisible = uiChromeVisible.value;
});

</script>

<template>
  <div class="game-wrapper">
    <!-- Top status bar lives outside the 3D game area, like the bottom controls. -->
    <div
      v-if="gameChromeVisible"
      class="top-controls-shell"
    >
      <TopBar
        :economy="economyInfo"
        :player-name="resolvePlayerName(activePlayer)"
        :player-color="getPlayerColor(activePlayer)"
        :can-toggle-player="showPlayerToggle"
        :direction-data="minimapData"
        :network-status="networkStatus"
        :network-warning="networkNotice"
        @toggle-player="togglePlayer"
      />
    </div>

    <div
      ref="gameAreaRef"
      class="game-area"
      :class="{ 'player-client-off': !playerClientEnabled }"
    >
      <!-- Background battle container (demo game).
           Loads full-screen behind the BUDGET ANNIHILATION screen
           exactly as before. Once the user clicks Host/Join AND
           lands in the GAME LOBBY state, the lobby-preview composable
           re-parents this element into the lobby modal's
           `#lobby-preview-target` so the demo runs as a small preview
           pane. Vue Teleport was the
           obvious tool but its interaction with the demo battle's
           per-frame reactive updates triggered "Cannot set
           properties of null" patcher crashes on initial mount;
           an imperative move keeps Vue's vnode tree stable. -->
      <div
        ref="backgroundContainerRef"
        class="background-battle-container"
        :class="{ 'loading-active': showDemoLoadingOverlay }"
        v-show="!gameStarted"
      >
        <div
          v-if="showDemoLoadingOverlay"
          class="battle-loading-overlay"
          role="status"
          aria-live="polite"
        >
          <LoadingEmblem
            :progress="displayedLoadingProgress"
            :phase="displayedLoadingPhase"
            :next-label="loadingNextLabel"
          />
        </div>
      </div>

      <!-- Main game container (real game) -->
      <div
        ref="containerRef"
        class="game-container"
        :class="{ 'loading-active': showRealLoadingOverlay }"
        v-show="gameStarted"
      >
        <div
          v-if="showRealLoadingOverlay"
          class="battle-loading-overlay"
          role="status"
          aria-live="polite"
        >
          <LoadingEmblem
            :progress="displayedLoadingProgress"
            :phase="displayedLoadingPhase"
            :next-label="loadingNextLabel"
          />
        </div>
      </div>

      <div
        v-if="!playerClientEnabled && !showLoadingOverlay"
        class="player-client-off-overlay"
        role="status"
        aria-live="polite"
      >
        <LoadingEmblem
          :show-progress="false"
          phase="Client paused — toggle CLIENT to resume"
          :next-label="loadingNextLabel"
        />
      </div>

      <!-- Game UI (desktop: hidden when lobby modal visible; mobile: follows hamburger toggle) -->
      <template v-if="playerClientEnabled && gameChromeVisible">
        <!-- Selection panel (bottom-left) -->
        <SelectionPanel
          :selection="selectionInfo"
          :actions="selectionActions"
          :hotkey-preset="commandHotkeyPreset"
        />

        <!-- Minimap -->
        <div class="minimap-stack">
          <Minimap :data="minimapData" @click="handleMinimapClick" />
        </div>
      </template>
    </div>

    <!-- Bottom control bars (desktop: hidden when lobby modal visible; mobile: toggled) -->
    <div
      v-if="bottomChromeVisible"
      class="bottom-controls-shell"
      :class="{ collapsed: !isMobile && bottomBarsCollapsed }"
    >
      <button
        v-if="!isMobile"
        class="bottom-controls-toggle"
        :class="{ collapsed: bottomBarsCollapsed }"
        :aria-expanded="!bottomBarsCollapsed"
        :aria-label="bottomBarsCollapsed ? 'Show bottom controls' : 'Hide bottom controls'"
        :title="bottomBarsCollapsed ? 'Show bottom controls' : 'Hide bottom controls'"
        @click="toggleBottomBars"
      >
        <span class="toggle-dot"></span>
        <span class="toggle-dot"></span>
        <span class="toggle-dot"></span>
      </button>

      <div v-show="isMobile || !bottomBarsCollapsed" class="bottom-controls">
        <GameCanvasBattleControlBar
          v-if="showServerControls && currentBattleMode === 'demo'"
          :model="battleControlBarModel"
        />
        <GameCanvasServerControlBar
          v-if="showServerControls"
          :model="serverControlBarModel"
        />
        <GameCanvasClientControlBar :model="clientControlBarModel" />
      </div>

    </div>

    <button
      v-if="!uiChromeVisible"
      class="ui-chrome-restore"
      title="Show UI"
      aria-label="Show UI"
      @click="toggleUiChrome"
    >
      UI
    </button>

    <div
      v-if="showLobbyControlsSidebar"
      class="lobby-controls-sidebar"
      :class="{ open: lobbyControlsSidebarOpen }"
    >
      <button
        class="lobby-controls-sidebar-toggle"
        :aria-expanded="lobbyControlsSidebarOpen"
        :aria-label="lobbyControlsSidebarOpen ? 'Close lobby server and client controls' : 'Open lobby server and client controls'"
        :title="lobbyControlsSidebarOpen ? 'Close server/client controls' : 'Open server/client controls'"
        @click="lobbyControlsSidebarOpen = !lobbyControlsSidebarOpen"
      >
        <span class="toggle-dot"></span>
        <span class="toggle-dot"></span>
        <span class="toggle-dot"></span>
      </button>

      <aside
        class="lobby-controls-sidebar-panel"
        aria-label="Lobby server and client controls"
        :aria-hidden="!lobbyControlsSidebarOpen"
      >
        <GameCanvasServerControlBar
          v-if="showServerControls"
          :model="serverControlBarModel"
        />
        <GameCanvasClientControlBar :model="clientControlBarModel" />
      </aside>
    </div>

    <!-- Lobby Modal. On the initial (BUDGET ANNIHILATION) and
         connecting screens it renders full-screen over the
         demo-battle backdrop — exactly the original load-time
         behavior. Once `roomCode` is set (the user clicked
         Host or finished joining), the GAME LOBBY screen renders
         a `#lobby-preview-target` div inside the modal; the demo
         container teleports into it (see Teleport above) and the
         demo battle runs as a small simulation preview alongside
         the lobby's terrain / player controls. -->
    <LobbyModal
      :visible="!isMobile && showLobby && !spectateMode"
      :is-host="isHost"
      :room-code="roomCode"
      :players="lobbyPlayers"
      :local-player-id="localPlayerId"
      :error="lobbyError"
      :is-connecting="isConnecting"
      :center-magnitude="centerMagnitude"
      :dividers-magnitude="dividersMagnitude"
      :terrain-map-shape="terrainMapShape"
      :terrain-d-terrain="terrainDTerrain"
      :metal-deposit-step="metalDepositStep"
      :terrain-detail="terrainDetail"
      :map-width-land-cells="mapWidthLandCells"
      :map-length-land-cells="mapLengthLandCells"
      :unit-blueprint-ids="demoUnitBlueprintIds"
      :allowed-units="currentAllowedUnits"
      :unit-cap="displayUnitCap"
      :shields-obstruct-sight="currentShieldsObstructSight"
      :converter-tax="currentConverterTax"
      :preview-loading="loadingInLobbyPreview"
      :preview-loading-progress="displayedLoadingProgress"
      :preview-loading-phase="displayedLoadingPhase"
      :presets="BATTLE_PRESETS"
      :active-preset-name="battleControlBarModel.activePresetName"
      @host="handleHost"
      @join="handleJoin"
      @start="handleLobbyStart"
      @cancel="handleLobbyCancel"
      @offline="handleOffline"
      @spectate="toggleSpectateMode"
      @set-center-magnitude="(v) => applyCenterMagnitude(v)"
      @set-dividers-magnitude="(v) => applyDividersMagnitude(v)"
      @set-terrain-map-shape="(s) => applyTerrainMapShape(s)"
      @set-terrain-d-terrain="(v) => applyTerrainDTerrain(v)"
      @set-metal-deposit-step="(v) => applyMetalDepositStep(v)"
      @set-terrain-detail="(v) => applyTerrainDetail(v)"
      @set-preset="(p) => applyPreset(p)"
      @set-map-land-dimensions="(dimensions) => applyMapLandDimensions(dimensions)"
      @toggle-unit="(ut) => toggleDemoUnitBlueprintId(ut)"
      @toggle-all-units="toggleAllDemoUnits"
      @set-unit-cap="(c) => changeMaxTotalUnits(c)"
      @set-shields-obstruct-sight="(e) => setShieldsObstructSight(e)"
      @set-converter-tax="(v) => setConverterTax(v)"
      @set-player-name="onPlayerNameChange"
      @reset-defaults="resetDemoDefaults"
    />

    <GameCanvasOverlays
      :is-mobile="isMobile"
      :show-lobby="showLobby"
      :spectate-mode="spectateMode"
      :ui-chrome-visible="uiChromeVisible"
      :mobile-bars-visible="mobileBarsVisible"
      :show-sound-test="showSoundTest"
      :game-started="gameStarted"
      :current-battle-mode="currentBattleMode"
      :get-orbit="getActiveOrbitCamera"
      :game-over-winner="gameOverWinner"
      :winner-name="gameOverWinner === null ? '' : resolvePlayerName(gameOverWinner)"
      :winner-color="gameOverWinner === null ? '' : getPlayerColor(gameOverWinner)"
      @toggle-spectate-mode="toggleSpectateMode"
      @toggle-mobile-bars="mobileBarsVisible = !mobileBarsVisible"
      @close-sound-test="showSoundTest = false"
      @dismiss-game-over="gameOverWinner = null"
      @restart-game="restartGame"
    />
  </div>
</template>

<style scoped>
.game-wrapper {
  width: 100%;
  height: 100%;
  position: relative;
  display: flex;
  flex-direction: column;
}

.game-area {
  flex: 1;
  position: relative;
  overflow: hidden;
  min-height: 0;
}

.game-container {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
}

.background-battle-container {
  /* Identical positioning rules in both contexts:
   *   - default home: inside `.game-area` (position: relative) →
   *     fills the full viewport behind the BUDGET ANNIHILATION
   *     lobby screen (original pre-change behavior).
   *   - re-parented home: inside `.preview-pane` (also
   *     position: relative, sized 480x270) → fills that small
   *     box, framing the demo as a mini-simulation preview.
   *
   * The lobby-preview composable does the DOM move; the element's own
   * CSS doesn't need to change because both parents resolve `position:
   * absolute; width/height: 100%` to the right thing. */
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  overflow: hidden;
  z-index: 0;
}

.game-container canvas {
  display: block;
}

.game-container.loading-active {
  z-index: 3700;
}

.battle-loading-overlay {
  position: absolute;
  inset: 0;
  z-index: 3600;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  background: rgba(5, 7, 10, 0.92);
  color: #edf3ff;
  pointer-events: auto;
}

.player-client-off .game-container canvas,
.player-client-off .background-battle-container canvas {
  visibility: hidden;
}

.player-client-off-overlay {
  position: absolute;
  inset: 0;
  z-index: 900;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  background: rgba(5, 7, 10, 0.92);
  color: #edf3ff;
  pointer-events: auto;
}

.top-controls-shell {
  flex-shrink: 0;
  z-index: 3001;
  width: 100%;
  pointer-events: none;
}

.top-controls-shell :deep(.top-bar) {
  pointer-events: auto;
}

.minimap-stack {
  position: absolute;
  top: 10px;
  left: 10px;
  z-index: 1000;
  display: grid;
  pointer-events: none;
}

.minimap-stack :deep(.minimap-container) {
  pointer-events: auto;
}

.ui-chrome-restore {
  position: fixed;
  right: 12px;
  bottom: 12px;
  z-index: 4200;
  min-width: 38px;
  min-height: 28px;
  padding: 0 10px;
  border: 1px solid #5d6b82;
  border-radius: 4px;
  background: rgba(17, 22, 30, 0.9);
  color: #e8f0ff;
  font: 700 11px/1 system-ui, sans-serif;
  letter-spacing: 0;
  cursor: pointer;
  pointer-events: auto;
}

.ui-chrome-restore:hover {
  border-color: #8da1c0;
  background: rgba(28, 36, 48, 0.94);
}

.ui-chrome-restore:active {
  background: rgba(9, 12, 18, 0.96);
}



/* Bottom control bars */
.bottom-controls-shell {
  flex-shrink: 0;
  z-index: 3001;
  display: flex;
  align-items: stretch;
  justify-content: flex-start;
  width: 100%;
  pointer-events: none;
}

.bottom-controls-shell.collapsed {
  position: absolute;
  left: 0;
  bottom: 0;
  width: 30px;
  height: 72px;
  background: transparent;
}

.bottom-controls {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  pointer-events: none;
}

.bottom-controls-toggle {
  flex: 0 0 30px;
  align-self: stretch;
  min-height: 100%;
  padding: 0;
  background: rgba(18, 18, 26, 0.92);
  border: 1px solid #444;
  border-right: none;
  border-radius: 0;
  color: #888;
  cursor: pointer;
  pointer-events: auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
}

.bottom-controls-toggle.collapsed {
  height: 100%;
  min-height: 72px;
  border-right: 1px solid #444;
}

.bottom-controls-toggle:hover {
  background: rgba(35, 35, 48, 0.96);
  border-color: #777;
}

.bottom-controls-toggle:active {
  background: rgba(12, 12, 18, 0.98);
  border-color: #666;
}

.toggle-dot {
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: currentColor;
  display: block;
}

.lobby-controls-sidebar {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  z-index: 3002;
  width: min(860px, calc(100vw - 40px));
  pointer-events: none;
  transform: translateX(100%);
  transition: transform 0.18s ease;
}

.lobby-controls-sidebar.open {
  transform: translateX(0);
}

.lobby-controls-sidebar-toggle {
  position: absolute;
  top: 50%;
  left: -30px;
  width: 30px;
  height: 72px;
  padding: 0;
  transform: translateY(-50%);
  background: rgba(18, 18, 26, 0.94);
  border: 1px solid #444;
  border-right: none;
  border-radius: 6px 0 0 6px;
  color: #888;
  cursor: pointer;
  pointer-events: auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
}

.lobby-controls-sidebar-toggle:hover {
  background: rgba(35, 35, 48, 0.98);
  border-color: #777;
  color: #bbb;
}

.lobby-controls-sidebar-toggle:active {
  background: rgba(12, 12, 18, 0.98);
  border-color: #666;
}

.lobby-controls-sidebar-panel {
  width: 100%;
  height: 100%;
  box-sizing: border-box;
  padding: 10px;
  overflow-y: auto;
  background: rgba(10, 12, 18, 0.96);
  border-left: 1px solid #444;
  box-shadow: -16px 0 32px rgba(0, 0, 0, 0.36);
  pointer-events: auto;
  visibility: visible;
}

.lobby-controls-sidebar:not(.open) .lobby-controls-sidebar-panel {
  visibility: hidden;
}

</style>

<script setup lang="ts">
import { ref, computed, reactive, watch, watchEffect } from 'vue';
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
import { BACKGROUND_UNIT_TYPES } from '../game/server/BackgroundBattleStandalone';
import {
  BATTLE_CONFIG,
  loadStoredCap,
  loadStoredCenterMagnitude,
  loadStoredDividersMagnitude,
  loadStoredGrid,
  loadStoredTerrainDTerrain,
  loadStoredMetalDepositStep,
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
  if (gameStarted.value) return 'ONLINE BATTLE';
  if (currentBattleMode.value === 'real') return 'LOBBY VISUALIZATION';
  return 'DEMO BATTLE';
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

// Demo battle unit type list (state read from snapshots)
const demoUnitTypes = BACKGROUND_UNIT_TYPES;

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
const initialMapDimensions = loadStoredMapLandDimensions('demo');
const mapWidthLandCells = ref<number>(initialMapDimensions.widthLandCells);
const mapLengthLandCells = ref<number>(initialMapDimensions.lengthLandCells);
const {
  renderMode,
  audioScope,
  audioSmoothing,
  burnMarks,
  locomotionMarks,
  smokeTrails,
  beamSnapToTurret,
  triangleDebug,
  buildGridDebug,
  sightBoundary,
  radarBoundary,
  fogShade,
  fogClouds,
  movementPosEma,
  movementVelEma,
  rotationPosEma,
  rotationVelEma,
  predictionMode,
  clientUnitGroundNormalEmaMode,
  edgeScrollEnabled,
  dragPanEnabled,
  waypointDetail,
  soundToggles,
  rangeToggles,
  projRangeToggles,
  unitRadiusToggles,
  legsRadiusToggle,
  cameraSmoothMode,
  cameraFovDegrees,
  allRangesActive,
  allProjRangesActive,
  allUnitRadiiActive,
  allPanActive,
  SFX_CATEGORIES,
  allSoundsActive,
  SOUND_LABELS,
  SOUND_TOOLTIPS,
  resetClientDefaults,
  changeRenderMode,
  changeAudioScope,
  toggleRange,
  toggleProjRange,
  toggleUnitRadius,
  toggleLegsRadius,
  setCameraMode,
  changeCameraFovDegrees,
  toggleAllRanges,
  toggleAllProjRanges,
  toggleAllUnitRadii,
  toggleAudioSmoothing,
  toggleBurnMarks,
  toggleLocomotionMarks,
  toggleSmokeTrails,
  toggleBeamSnapToTurret,
  toggleTriangleDebug,
  toggleBuildGridDebug,
  toggleSightBoundary,
  toggleRadarBoundary,
  toggleFogShade,
  toggleFogClouds,
  changeMovementPosEma,
  changeMovementVelEma,
  changeRotationPosEma,
  changeRotationVelEma,
  changePredictionMode,
  changeClientUnitGroundNormalEmaMode,
  changeWaypointDetail,
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
  getPlayerClientEnabled: () => effectivePlayerClientRenderEnabled.value,
  onLoadingProgress: setLoadingProgress,
  bindSceneUi: (scene) => bindGameSceneUi(scene),
  onRendererWarmupChange: (warming) => {
    if (!gameStarted.value) rendererWarmupLoading.value = warming;
  },
  onStarted: (battle) => {
    activeConnection = battle.connection;
    hasServer.value = true;
    battleStartTime = Date.now();
    setPlayerClientRenderEnabled(battle.gameInstance, effectivePlayerClientRenderEnabled.value);
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
  currentForceFieldsObstructSight,
  currentFogOfWarEnabled,
  currentConverterTax,
  toggleDemoUnitType,
  toggleAllDemoUnits,
  changeMaxTotalUnits,
  setForceFieldsObstructSight,
  setFogOfWarEnabled,
  setConverterTax,
  resetDemoDefaults,
  applyPreset,
} = useGameCanvasBattleSettings({
  serverMetaFromSnapshot,
  currentBattleMode,
  demoUnitTypes,
  getActiveConnection: () => activeConnection,
  resetGridInfoToDefault,
  broadcastLobbySettingsIfHost,
  applyCenterMagnitude,
  applyDividersMagnitude,
  applyTerrainMapShape,
  applyTerrainDTerrain,
  applyMetalDepositStep,
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
// read the changed field. Methods and the demoUnitTypes ref are
// stable references so they sit on the object once at construction.
const battleControlBarModel = reactive<GameCanvasBattleControlBarModel>({
  isReadonly: serverBarReadonly.value,
  barStyle: battleBarVars.value,
  battleLabel: battleLabel.value,
  battleElapsed: battleElapsed.value,
  allDemoUnitsActive: allDemoUnitsActive.value,
  demoUnitTypes,
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
  displayUnitCount: displayUnitCount.value,
  currentForceFieldsObstructSight: currentForceFieldsObstructSight.value,
  currentFogOfWarEnabled: currentFogOfWarEnabled.value,
  currentConverterTax: currentConverterTax.value,
  presets: BATTLE_PRESETS,
  activePresetName: null,
  applyPreset,
  resetDemoDefaults,
  toggleAllDemoUnits,
  toggleDemoUnitType,
  changeMaxTotalUnits,
  applyMapLandDimensions,
  applyCenterMagnitude,
  applyDividersMagnitude,
  applyTerrainMapShape,
  applyTerrainDTerrain,
  applyMetalDepositStep,
  setForceFieldsObstructSight,
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
  m.displayUnitCount = displayUnitCount.value;
  m.currentForceFieldsObstructSight = currentForceFieldsObstructSight.value;
  m.currentFogOfWarEnabled = currentFogOfWarEnabled.value;
  m.currentConverterTax = currentConverterTax.value;
  m.activePresetName = findMatchingPresetName({
    units: currentAllowedUnits.value,
    cap: displayUnitCap.value,
    mirrorsEnabled: BATTLE_CONFIG.mirrorsEnabled.default,
    forceFieldsEnabled: BATTLE_CONFIG.forceFieldsEnabled.default,
    forceFieldsObstructSight: currentForceFieldsObstructSight.value,
    forceFieldReflectionMode: BATTLE_CONFIG.forceFieldReflectionMode.default,
    fogOfWarEnabled: currentFogOfWarEnabled.value,
    converterTax: currentConverterTax.value,
    centerMagnitude: centerMagnitude.value,
    dividersMagnitude: dividersMagnitude.value,
    terrainMapShape: terrainMapShape.value,
    terrainDTerrain: terrainDTerrain.value,
    metalDepositStep: metalDepositStep.value,
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
  logicMsAvg: logicMsAvg.value,
  logicMsHi: logicMsHi.value,
  renderMsAvg: renderMsAvg.value,
  renderMsHi: renderMsHi.value,
  displayGpuMs: displayGpuMs.value,
  gpuSourceLabel: gpuSourceLabel.value,
  gpuTimerSupported: gpuTimerSupported.value,
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
  beamSnapToTurret: beamSnapToTurret.value,
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
  fogShade: fogShade.value,
  fogClouds: fogClouds.value,
  renderMode: renderMode.value,
  audioScope: audioScope.value,
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
  resetClientDefaults,
  togglePlayerClientEnabled,
  changeWaypointDetail,
  toggleAudioSmoothing,
  toggleBurnMarks,
  toggleLocomotionMarks,
  toggleSmokeTrails,
  toggleBeamSnapToTurret,
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
  toggleFogShade,
  toggleFogClouds,
  changeRenderMode,
  changeAudioScope,
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
  m.logicMsAvg = logicMsAvg.value;
  m.logicMsHi = logicMsHi.value;
  m.renderMsAvg = renderMsAvg.value;
  m.renderMsHi = renderMsHi.value;
  m.displayGpuMs = displayGpuMs.value;
  m.gpuSourceLabel = gpuSourceLabel.value;
  m.gpuTimerSupported = gpuTimerSupported.value;
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
  m.beamSnapToTurret = beamSnapToTurret.value;
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
  m.fogShade = fogShade.value;
  m.fogClouds = fogClouds.value;
  m.renderMode = renderMode.value;
  m.audioScope = audioScope.value;
  m.allSoundsActive = allSoundsActive.value;
  m.allRangesActive = allRangesActive.value;
  m.allProjRangesActive = allProjRangesActive.value;
  m.allUnitRadiiActive = allUnitRadiiActive.value;
  m.legsRadiusToggle = legsRadiusToggle.value;
  m.cameraFovDegrees = cameraFovDegrees.value;
  m.cameraSmoothMode = cameraSmoothMode.value;
});

</script>

<template>
  <div class="game-wrapper">
    <!-- Top status bar lives outside the 3D game area, like the bottom controls. -->
    <div
      v-if="isMobile ? mobileBarsVisible : !lobbyModalVisible"
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
      <template v-if="playerClientEnabled && (isMobile ? mobileBarsVisible : !lobbyModalVisible)">
        <!-- Selection panel (bottom-left) -->
        <SelectionPanel
          :selection="selectionInfo"
          :actions="selectionActions"
        />

        <!-- Minimap -->
        <div class="minimap-stack">
          <Minimap :data="minimapData" @click="handleMinimapClick" />
        </div>
      </template>
    </div>

    <!-- Bottom control bars (desktop: hidden when lobby modal visible; mobile: toggled) -->
    <div
      v-if="isMobile ? mobileBarsVisible : !lobbyModalVisible"
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
      :map-width-land-cells="mapWidthLandCells"
      :map-length-land-cells="mapLengthLandCells"
      :unit-types="demoUnitTypes"
      :allowed-units="currentAllowedUnits"
      :unit-cap="displayUnitCap"
      :force-fields-obstruct-sight="currentForceFieldsObstructSight"
      :fog-of-war-enabled="currentFogOfWarEnabled"
      :converter-tax="currentConverterTax"
      :preview-loading="loadingInLobbyPreview"
      :preview-loading-progress="displayedLoadingProgress"
      :preview-loading-phase="displayedLoadingPhase"
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
      @set-map-land-dimensions="(dimensions) => applyMapLandDimensions(dimensions)"
      @toggle-unit="(ut) => toggleDemoUnitType(ut)"
      @toggle-all-units="toggleAllDemoUnits"
      @set-unit-cap="(c) => changeMaxTotalUnits(c)"
      @set-force-fields-obstruct-sight="(e) => setForceFieldsObstructSight(e)"
      @set-fog-of-war-enabled="(e) => setFogOfWarEnabled(e)"
      @set-converter-tax="(v) => setConverterTax(v)"
      @set-player-name="onPlayerNameChange"
      @reset-defaults="resetDemoDefaults"
    />

    <GameCanvasOverlays
      :is-mobile="isMobile"
      :show-lobby="showLobby"
      :spectate-mode="spectateMode"
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

.background-battle-container.loading-active,
.game-container.loading-active {
  z-index: 3700;
}

.battle-loading-overlay {
  position: fixed;
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

</style>

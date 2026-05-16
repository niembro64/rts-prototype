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
  loadStoredCap,
  loadStoredGrid,
  loadStoredTerrainCenter,
  loadStoredTerrainDividers,
  loadStoredTerrainMapShape,
  loadStoredMapLandDimensions,
} from '../battleBarConfig';
import type { TerrainMapShape, TerrainShape } from '../types/terrain';
import {
  SERVER_CONFIG,
  loadStoredSimQuality,
  loadStoredSimSignalStates,
  loadStoredTiltEmaMode,
  snapshotRateHz,
} from '../serverBarConfig';
import type { TiltEmaMode } from '../shellConfig';
import type { ServerSimQuality, ServerSimSignalStates } from '../types/serverSimLod';
import { isSignalState } from '../types/lod';
import { getPlayerColor } from './uiUtils';
import type { GameServer } from '../game/server/GameServer';
import type { GameConnection } from '../game/server/GameConnection';
import type { ConcreteGraphicsQuality } from '../types/graphics';
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
const {
  mobileBarsVisible,
  spectateMode,
  bottomBarsCollapsed,
  playerClientEnabled,
  toggleBottomBars,
  togglePlayerClientEnabled,
  toggleSpectateMode,
} = useGameCanvasChromeState(gameStarted, applyPlayerClientEnabled);

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
  currentBattleMode,
  localLobbyPlayer,
  showPlayerToggle,
  lobbyModalVisible,
  showServerControls,
  serverBarReadonly,
  battleBarVars,
  serverBarVars,
  clientBarVars,
  battleLabel,
} = useGameCanvasShellDisplay({
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
  () => showLoadingOverlay.value && gameStarted.value,
);

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

function applyPlayerClientEnabled(): void {
  setPlayerClientRenderEnabled(getBackgroundBattle()?.gameInstance, playerClientEnabled.value);
  setPlayerClientRenderEnabled(foregroundGame.getInstance(), playerClientEnabled.value);
}

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
const terrainCenter = ref<TerrainShape>(loadStoredTerrainCenter('demo'));
const terrainDividers = ref<TerrainShape>(loadStoredTerrainDividers('demo'));
const terrainMapShape = ref<TerrainMapShape>(loadStoredTerrainMapShape('demo'));
const initialMapDimensions = loadStoredMapLandDimensions('demo');
const mapWidthLandCells = ref<number>(initialMapDimensions.widthLandCells);
const mapLengthLandCells = ref<number>(initialMapDimensions.lengthLandCells);
const {
  graphicsQuality,
  clientSignalStates,
  clientAnySolo,
  renderMode,
  audioScope,
  audioSmoothing,
  burnMarks,
  locomotionMarks,
  beamSnapToTurret,
  lodShellRings,
  lodGridBorders,
  triangleDebug,
  buildGridDebug,
  baseLodMode,
  driftMode,
  predictionMode,
  clientTiltEmaMode,
  edgeScrollEnabled,
  dragPanEnabled,
  gridOverlay,
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
  changeGraphicsQuality,
  cycleClientSignal,
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
  toggleBeamSnapToTurret,
  toggleLodShellRings,
  toggleLodGridBorders,
  toggleTriangleDebug,
  toggleBuildGridDebug,
  toggleBaseLodMode,
  changeDriftMode,
  changePredictionMode,
  changeClientTiltEmaMode,
  changeGridOverlay,
  changeWaypointDetail,
  toggleEdgeScroll,
  toggleDragPan,
  toggleAllPan,
  toggleAllSounds,
  toggleSoundCategory,
} = useGameCanvasClientSettings({
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
  getPlayerClientEnabled: () => playerClientEnabled.value,
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
  terrainCenter,
  terrainDividers,
  terrainMapShape,
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
  displayGpuMs,
  effectiveQuality,
  frameMsAvg,
  frameMsHi,
  fullSnapAvgRate,
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
  displayServerTpsAvg,
  displayServerTpsWorst,
  serverMetaFromSnapshot,
  showServerControls,
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
const displayTargetTickRate = computed(
  () =>
    serverMetaFromSnapshot.value?.ticks.target ?? displayTickRate.value,
);
// HOST SERVER LOD pick — driven from local persistence + sent to the
// server via setSimQuality command. Effective tier (after the auto
// resolver) is read from the server's snapshot meta — the server
// runs the resolver each tick and ships both the picked AND
// effective values, so the bar lights the picked button as
// background AND the effective tier as white text just like the
// PLAYER CLIENT bar does.
const serverSimQuality = ref<ServerSimQuality>(loadStoredSimQuality());
// HOST SERVER chassis-tilt EMA mode. Picks the half-life used by the
// sim's updateUnitTilt (TILT_EMA_HALF_LIFE_SEC[mode]). Persisted to
// localStorage and pushed via setTiltEmaMode command.
const serverTiltEmaMode = ref<TiltEmaMode>(loadStoredTiltEmaMode());
// HOST SERVER per-signal tri-state — persisted locally and pushed
// to the server via setSimSignalStates command.
const serverSignalStates = ref<ServerSimSignalStates>(loadStoredSimSignalStates());
// True when any HOST SERVER signal is SOLO. Same role as
// clientAnySolo — controls whether AUTO is the level (background)
// or just a parent indicator (white text).
const serverAnySolo = computed(() =>
  serverSignalStates.value.tps === 'solo' ||
  serverSignalStates.value.cpu === 'solo' ||
  serverSignalStates.value.units === 'solo',
);
// effective is one of the concrete tiers ('min'..'max') or '' before
// the first snapshot. The wire format is plain string; narrow the
// computed result so the v-bind class equality checks don't fall
// through TypeScript's `any` widening.
const effectiveSimQuality = computed<ConcreteGraphicsQuality | ''>(
  () => {
    const v = serverMetaFromSnapshot.value?.simLod?.effective;
    if (v === 'min' || v === 'low' || v === 'medium' || v === 'high' || v === 'max') {
      return v;
    }
    return '';
  },
);
// Reconcile from server snapshot. The host's localStorage is the
// source of truth at boot (the `setSimQuality` command goes from
// host client to GameServer). For REMOTE clients connecting to
// someone else's server, their localStorage is irrelevant — the
// host already chose. Sync from `simLod.picked` whenever it differs
// from the local ref so the bar lights the correct "active" button.
const VALID_SIM_QUALITIES = new Set<string>([
  'auto', 'auto-tps', 'auto-cpu', 'auto-units',
  'min', 'low', 'medium', 'high', 'max',
]);
watch(
  () => serverMetaFromSnapshot.value?.simLod?.picked,
  (picked) => {
    if (!picked) return;
    if (!VALID_SIM_QUALITIES.has(picked)) return;
    if (picked === serverSimQuality.value) return;
    serverSimQuality.value = picked as ServerSimQuality;
  },
);
// Same reconciliation for the per-signal tri-state — non-host
// clients pick up whatever the host actually configured.
watch(
  () => serverMetaFromSnapshot.value?.simLod?.signals,
  (signals) => {
    if (!signals) return;
    const updated: ServerSimSignalStates = { ...serverSignalStates.value };
    let changed = false;
    if (isSignalState(signals.tps) && signals.tps !== updated.tps) { updated.tps = signals.tps; changed = true; }
    if (isSignalState(signals.cpu) && signals.cpu !== updated.cpu) { updated.cpu = signals.cpu; changed = true; }
    if (isSignalState(signals.units) && signals.units !== updated.units) { updated.units = signals.units; changed = true; }
    if (changed) serverSignalStates.value = updated;
  },
  { deep: true },
);
// HOST SERVER tilt EMA — the host applies its setting via the
// setTiltEmaMode command, but remote clients render this control
// from snapshot meta (their own localStorage is irrelevant once
// connected). Reconcile when the host's value differs.
watch(
  () => serverMetaFromSnapshot.value?.tiltEma,
  (mode) => {
    if (!mode) return;
    if (!SERVER_CONFIG.tiltEma.options.includes(mode as TiltEmaMode)) return;
    if (mode === serverTiltEmaMode.value) return;
    serverTiltEmaMode.value = mode as TiltEmaMode;
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
// Bar-fill target for FSPS. The host's keyframe ratio describes
// "every Nth snapshot is a keyframe" — so the expected FSPS is
// snapsPerSec × ratio. 'ALL' clamps to the snapshot rate; 'NONE'
// has no recurring keyframes so we still draw a tiny non-zero
// target (1 fps) so the bar isn't divide-by-zero.
const fullSnapBarTarget = computed(() => {
  const sps = snapshotRateHz(displaySnapshotRate.value);
  const kf = displayKeyframeRatio.value;
  if (kf === 'NONE') return 1;
  if (kf === 'ALL') return sps;
  return Math.max(0.1, sps * (kf as number));
});
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
  applyTerrainShape,
  applyTerrainMapShape,
  applyMapLandDimensions,
  applyLobbySettingsFromHost,
  resetTerrainDefaults,
} = useGameCanvasLobbySettings({
  network: networkManager,
  currentBattleMode,
  networkRole,
  roomCode,
  gameStarted,
  terrainCenter,
  terrainDividers,
  terrainMapShape,
  mapWidthLandCells,
  mapLengthLandCells,
  stopBackgroundBattle,
  startBackgroundBattle,
});

const {
  resetServerDefaults,
  setNetworkUpdateRate,
  setTickRateValue,
  setTiltEmaModeValue,
  setSimQualityValue,
  cycleServerSignal,
  setKeyframeRatioValue,
  resetGridInfoToDefault,
} = useGameCanvasServerSettings({
  currentBattleMode,
  displayGridInfo,
  serverSimQuality,
  serverTiltEmaMode,
  serverSignalStates,
  getActiveConnection: () => activeConnection,
});

const {
  currentAllowedUnits,
  currentAllowedUnitsSet,
  allDemoUnitsActive,
  currentMirrorsEnabled,
  currentForceFieldsEnabled,
  currentForceFieldsBlockTargeting,
  currentForceFieldReflectionMode,
  currentFogOfWarEnabled,
  toggleDemoUnitType,
  toggleAllDemoUnits,
  changeMaxTotalUnits,
  setMirrorsEnabled,
  setForceFieldsEnabled,
  setForceFieldsBlockTargeting,
  setForceFieldReflectionMode,
  setFogOfWarEnabled,
  resetDemoDefaults,
} = useGameCanvasBattleSettings({
  serverMetaFromSnapshot,
  currentBattleMode,
  demoUnitTypes,
  getActiveConnection: () => activeConnection,
  resetTerrainDefaults,
  resetGridInfoToDefault,
  broadcastLobbySettingsIfHost,
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
  serverSimQuality,
  serverSignalStates,
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
  terrainCenter: terrainCenter.value,
  terrainDividers: terrainDividers.value,
  terrainMapShape: terrainMapShape.value,
  displayUnitCount: displayUnitCount.value,
  currentMirrorsEnabled: currentMirrorsEnabled.value,
  currentForceFieldsEnabled: currentForceFieldsEnabled.value,
  currentForceFieldsBlockTargeting: currentForceFieldsBlockTargeting.value,
  currentForceFieldReflectionMode: currentForceFieldReflectionMode.value,
  currentFogOfWarEnabled: currentFogOfWarEnabled.value,
  resetDemoDefaults,
  toggleAllDemoUnits,
  toggleDemoUnitType,
  changeMaxTotalUnits,
  applyMapLandDimensions,
  applyTerrainShape,
  applyTerrainMapShape,
  setMirrorsEnabled,
  setForceFieldsEnabled,
  setForceFieldsBlockTargeting,
  setForceFieldReflectionMode,
  setFogOfWarEnabled,
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
  m.terrainCenter = terrainCenter.value;
  m.terrainDividers = terrainDividers.value;
  m.terrainMapShape = terrainMapShape.value;
  m.displayUnitCount = displayUnitCount.value;
  m.currentMirrorsEnabled = currentMirrorsEnabled.value;
  m.currentForceFieldsEnabled = currentForceFieldsEnabled.value;
  m.currentForceFieldsBlockTargeting = currentForceFieldsBlockTargeting.value;
  m.currentForceFieldReflectionMode = currentForceFieldReflectionMode.value;
  m.currentFogOfWarEnabled = currentFogOfWarEnabled.value;
});

// Same reactive() pattern as battleControlBarModel: stable proxy
// identity so per-field changes only trigger renders of bindings that
// actually read the changed field. See the battle bar comment above
// for the why.
const serverControlBarModel = reactive<GameCanvasServerControlBarModel>({
  isReadonly: serverBarReadonly.value,
  barStyle: serverBarVars.value,
  displayServerTime: displayServerTime.value,
  displayServerIp: displayServerIp.value,
  displayTargetTickRate: displayTargetTickRate.value,
  displayTickRate: displayTickRate.value,
  serverTiltEmaMode: serverTiltEmaMode.value,
  displayServerTpsAvg: displayServerTpsAvg.value,
  displayServerTpsWorst: displayServerTpsWorst.value,
  displayServerCpuAvg: displayServerCpuAvg.value,
  displayServerCpuHi: displayServerCpuHi.value,
  displaySnapshotRate: displaySnapshotRate.value,
  displayKeyframeRatio: displayKeyframeRatio.value,
  serverSimQuality: serverSimQuality.value,
  serverAnySolo: serverAnySolo.value,
  serverSignalStates: serverSignalStates.value,
  effectiveSimQuality: effectiveSimQuality.value,
  resetServerDefaults,
  setTickRateValue,
  setTiltEmaModeValue,
  setNetworkUpdateRate,
  setKeyframeRatioValue,
  setSimQualityValue,
  cycleServerSignal,
});
watchEffect(() => {
  const m = serverControlBarModel as {
    -readonly [K in keyof GameCanvasServerControlBarModel]: GameCanvasServerControlBarModel[K];
  };
  m.isReadonly = serverBarReadonly.value;
  m.barStyle = serverBarVars.value;
  m.displayServerTime = displayServerTime.value;
  m.displayServerIp = displayServerIp.value;
  m.displayTargetTickRate = displayTargetTickRate.value;
  m.displayTickRate = displayTickRate.value;
  m.serverTiltEmaMode = serverTiltEmaMode.value;
  m.displayServerTpsAvg = displayServerTpsAvg.value;
  m.displayServerTpsWorst = displayServerTpsWorst.value;
  m.displayServerCpuAvg = displayServerCpuAvg.value;
  m.displayServerCpuHi = displayServerCpuHi.value;
  m.displaySnapshotRate = displaySnapshotRate.value;
  m.displayKeyframeRatio = displayKeyframeRatio.value;
  m.serverSimQuality = serverSimQuality.value;
  m.serverAnySolo = serverAnySolo.value;
  m.serverSignalStates = serverSignalStates.value;
  m.effectiveSimQuality = effectiveSimQuality.value;
});

// Same reactive() pattern as the other two bar models. This one is
// the biggest (~60 fields) so the parent + child re-render savings
// scale the most here in a fully-instrumented client (LOD signals,
// sound/range/radius toggles all push fields per tick).
const clientControlBarModel = reactive<GameCanvasClientControlBarModel>({
  barStyle: clientBarVars.value,
  playerClientEnabled: playerClientEnabled.value,
  displayedClientTime: displayedClientTime.value,
  displayedClientIp: displayedClientIp.value,
  gridOverlay: gridOverlay.value,
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
  displaySnapshotRate: displaySnapshotRate.value,
  fullSnapAvgRate: fullSnapAvgRate.value,
  fullSnapWorstRate: fullSnapWorstRate.value,
  fullSnapBarTarget: fullSnapBarTarget.value,
  audioSmoothing: audioSmoothing.value,
  burnMarks: burnMarks.value,
  locomotionMarks: locomotionMarks.value,
  beamSnapToTurret: beamSnapToTurret.value,
  driftMode: driftMode.value,
  predictionMode: predictionMode.value,
  clientTiltEmaMode: clientTiltEmaMode.value,
  allPanActive: allPanActive.value,
  dragPanEnabled: dragPanEnabled.value,
  edgeScrollEnabled: edgeScrollEnabled.value,
  graphicsQuality: graphicsQuality.value,
  effectiveQuality: effectiveQuality.value,
  clientAnySolo: clientAnySolo.value,
  clientSignalStates: clientSignalStates.value,
  showServerControls: showServerControls.value,
  baseLodMode: baseLodMode.value,
  lodShellRings: lodShellRings.value,
  lodGridBorders: lodGridBorders.value,
  triangleDebug: triangleDebug.value,
  buildGridDebug: buildGridDebug.value,
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
  changeGridOverlay,
  changeWaypointDetail,
  toggleAudioSmoothing,
  toggleBurnMarks,
  toggleLocomotionMarks,
  toggleBeamSnapToTurret,
  changeDriftMode,
  changePredictionMode,
  changeClientTiltEmaMode,
  toggleAllPan,
  toggleDragPan,
  toggleEdgeScroll,
  changeGraphicsQuality,
  cycleClientSignal,
  toggleBaseLodMode,
  toggleLodShellRings,
  toggleLodGridBorders,
  toggleTriangleDebug,
  toggleBuildGridDebug,
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
  m.playerClientEnabled = playerClientEnabled.value;
  m.displayedClientTime = displayedClientTime.value;
  m.displayedClientIp = displayedClientIp.value;
  m.gridOverlay = gridOverlay.value;
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
  m.displaySnapshotRate = displaySnapshotRate.value;
  m.fullSnapAvgRate = fullSnapAvgRate.value;
  m.fullSnapWorstRate = fullSnapWorstRate.value;
  m.fullSnapBarTarget = fullSnapBarTarget.value;
  m.audioSmoothing = audioSmoothing.value;
  m.burnMarks = burnMarks.value;
  m.locomotionMarks = locomotionMarks.value;
  m.beamSnapToTurret = beamSnapToTurret.value;
  m.driftMode = driftMode.value;
  m.predictionMode = predictionMode.value;
  m.clientTiltEmaMode = clientTiltEmaMode.value;
  m.allPanActive = allPanActive.value;
  m.dragPanEnabled = dragPanEnabled.value;
  m.edgeScrollEnabled = edgeScrollEnabled.value;
  m.graphicsQuality = graphicsQuality.value;
  m.effectiveQuality = effectiveQuality.value;
  m.clientAnySolo = clientAnySolo.value;
  m.clientSignalStates = clientSignalStates.value;
  m.showServerControls = showServerControls.value;
  m.baseLodMode = baseLodMode.value;
  m.lodShellRings = lodShellRings.value;
  m.lodGridBorders = lodGridBorders.value;
  m.triangleDebug = triangleDebug.value;
  m.buildGridDebug = buildGridDebug.value;
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
    <!-- Top status bar lives outside the Three.js game area, like the bottom controls. -->
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
        v-show="!gameStarted"
      >
        <div
          v-if="showDemoLoadingOverlay"
          class="battle-loading-overlay"
          role="status"
          aria-live="polite"
        >
          <LoadingEmblem />
        </div>
      </div>

      <!-- Main game container (real game) -->
      <div
        ref="containerRef"
        class="phaser-container"
        v-show="gameStarted"
      >
        <div
          v-if="showRealLoadingOverlay"
          class="battle-loading-overlay"
          role="status"
          aria-live="polite"
        >
          <LoadingEmblem />
        </div>
      </div>

      <div
        v-if="!playerClientEnabled"
        class="player-client-off-overlay"
        aria-hidden="true"
      ></div>

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
      :terrain-center="terrainCenter"
      :terrain-dividers="terrainDividers"
      :terrain-map-shape="terrainMapShape"
      :map-width-land-cells="mapWidthLandCells"
      :map-length-land-cells="mapLengthLandCells"
      :unit-types="demoUnitTypes"
      :allowed-units="currentAllowedUnits"
      :unit-cap="displayUnitCap"
      :mirrors-enabled="currentMirrorsEnabled"
      :force-fields-enabled="currentForceFieldsEnabled"
      :force-fields-block-targeting="currentForceFieldsBlockTargeting"
      :force-field-reflection-mode="currentForceFieldReflectionMode"
      :fog-of-war-enabled="currentFogOfWarEnabled"
      :preview-loading="loadingInLobbyPreview"
      @host="handleHost"
      @join="handleJoin"
      @start="handleLobbyStart"
      @cancel="handleLobbyCancel"
      @offline="handleOffline"
      @spectate="toggleSpectateMode"
      @set-terrain-center="(s) => applyTerrainShape('center', s)"
      @set-terrain-dividers="(s) => applyTerrainShape('dividers', s)"
      @set-terrain-map-shape="(s) => applyTerrainMapShape(s)"
      @set-map-land-dimensions="(dimensions) => applyMapLandDimensions(dimensions)"
      @toggle-unit="(ut) => toggleDemoUnitType(ut)"
      @toggle-all-units="toggleAllDemoUnits"
      @set-unit-cap="(c) => changeMaxTotalUnits(c)"
      @set-mirrors-enabled="(e) => setMirrorsEnabled(e)"
      @set-force-fields-enabled="(e) => setForceFieldsEnabled(e)"
      @set-force-fields-block-targeting="(e) => setForceFieldsBlockTargeting(e)"
      @set-force-field-reflection-mode="(m) => setForceFieldReflectionMode(m)"
      @set-fog-of-war-enabled="(e) => setFogOfWarEnabled(e)"
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

.phaser-container {
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

.phaser-container canvas {
  display: block;
}

.battle-loading-overlay {
  position: absolute;
  inset: 0;
  z-index: 3200;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  background: rgba(5, 7, 10, 0.92);
  color: #edf3ff;
  pointer-events: auto;
}

.player-client-off .phaser-container canvas,
.player-client-off .background-battle-container canvas {
  visibility: hidden;
}

.player-client-off-overlay {
  position: absolute;
  inset: 0;
  z-index: 900;
  background: #000;
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

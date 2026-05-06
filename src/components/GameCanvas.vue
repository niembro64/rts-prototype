<script setup lang="ts">
import { ref, reactive, onMounted, onUnmounted, computed, nextTick, watch } from 'vue';
import { createGame, destroyGame, type GameInstance, type GameScene } from '../game/createGame';
import { ClientViewState } from '../game/network/ClientViewState';
import { type BuildingType, type PlayerId, type WaypointType } from '../game/sim/types';
import {
  createBackgroundBattle,
  destroyBackgroundBattle,
  type BackgroundBattleState,
} from '../game/lobby/LobbyManager';
import BarDivider from './BarDivider.vue';
import BarLabel from './BarLabel.vue';
import BarButton from './BarButton.vue';
import BarButtonGroup from './BarButtonGroup.vue';
import BarControlGroup from './BarControlGroup.vue';
import SelectionPanel, {
  type SelectionInfo,
  type SelectionActions,
} from './SelectionPanel.vue';
import TopBar, { type EconomyInfo } from './TopBar.vue';
import Minimap from './Minimap.vue';
import LobbyModal, { type LobbyPlayer } from './LobbyModal.vue';
import CameraTutorial from './CameraTutorial.vue';
import { persist, readPersisted } from '../persistence';
import SoundTestModal from './SoundTestModal.vue';
import type { MinimapData } from '@/types/ui';
import type { NetworkServerSnapshotMeta } from '../game/network/NetworkTypes';
import {
  networkManager,
  type NetworkRole,
  type BattleHandoff,
} from '../game/network/NetworkManager';
import { getMapSize } from '../config';
import { getUnitBlueprint } from '../game/sim/blueprints';
import { BACKGROUND_UNIT_TYPES } from '../game/server/BackgroundBattleStandalone';
import { LOD_EMA_SOURCE, GOOD_TPS } from '../lodConfig';
import type { SnapshotRate, KeyframeRatio, TickRate } from '../types/server';
import {
  BATTLE_CONFIG,
  saveDemoUnits,
  getDefaultCap,
  loadStoredCap,
  saveStoredCap,
  loadStoredRealCap,
  getDefaultGrid,
  loadStoredGrid,
  saveStoredGrid,
  saveMirrorsEnabled,
  saveForceFieldsEnabled,
  loadStoredTerrainCenter,
  saveTerrainCenter,
  loadStoredTerrainDividers,
  saveTerrainDividers,
  loadStoredTerrainMapShape,
  saveTerrainMapShape,
  loadStoredMapLandDimensions,
  saveMapLandDimensions,
  getDefaultMapLandDimensions,
  getDefaultDemoUnits,
  loadStoredDemoBarsCollapsed,
  saveDemoBarsCollapsed,
  loadStoredRealBarsCollapsed,
  saveRealBarsCollapsed,
  type BattleMode,
} from '../battleBarConfig';
import type { MapLandCellDimensions } from '../mapSizeConfig';
import { setTerrainCenterShape, setTerrainDividersShape, setTerrainMapShape } from '../game/sim/Terrain';
import type { TerrainMapShape, TerrainShape } from '../types/terrain';
import {
  SERVER_CONFIG,
  saveSnapshotRate,
  saveKeyframeRatio,
  saveTickRate,
  loadStoredSimQuality,
  saveSimQuality,
  loadStoredSimSignalStates,
  saveSimSignalStates,
  resetSimSignalStates,
  loadStoredTiltEmaMode,
  saveTiltEmaMode,
} from '../serverBarConfig';
import type { TiltEmaMode } from '../shellConfig';
import type { ServerSimQuality, ServerSimSignalStates } from '../types/serverSimLod';
import type { SignalState } from '../types/lod';
import { CLIENT_CONFIG, LOD_SIGNALS_ENABLED } from '../clientBarConfig';
import {
  SERVER_SIM_LOD_SIGNALS_ENABLED,
  SERVER_SIM_QUALITY_DEFAULT,
} from '../serverSimLodConfig';
import { BAR_THEMES, barVars } from '../barThemes';
import {
  formatDuration,
  fmt4,
  statBarStyle,
  msBarStyle,
  getPlayerColor,
} from './uiUtils';
import {
  getInitialLocalUsername,
  getDefaultPlayerName,
  saveUsername,
} from '@/playerNamesConfig';
import { GameServer } from '../game/server/GameServer';
import { LocalGameConnection } from '../game/server/LocalGameConnection';
import { RemoteGameConnection } from '../game/server/RemoteGameConnection';
import { applyStoredBattleServerSettings } from '../game/server/battleServerSettings';
import type { GameConnection } from '../game/server/GameConnection';
import {
  getGraphicsQuality,
  setGraphicsQuality,
  cycleLodSignalState,
  resetLodSignalStates,
  getLodSignalStates,
  getEffectiveQuality,
  getRenderMode,
  setRenderMode,
  getRangeToggle,
  setRangeToggle,
  getProjRangeToggle,
  setProjRangeToggle,
  getUnitRadiusToggle,
  setUnitRadiusToggle,
  getLegsRadiusToggle,
  setLegsRadiusToggle,
  getCameraSmoothMode,
  setCameraSmoothMode,
  RANGE_TYPES,
  PROJ_RANGE_TYPES,
  UNIT_RADIUS_TYPES,
  getEdgeScrollEnabled,
  setEdgeScrollEnabled,
  getDragPanEnabled,
  setDragPanEnabled,
  getAudioScope,
  setAudioScope,
  getAudioSmoothing,
  setAudioSmoothing,
  getBurnMarks,
  setBurnMarks,
  getLodShellRings,
  setLodShellRings,
  getLodGridBorders,
  setLodGridBorders,
  getTriangleDebug,
  setTriangleDebug,
  getBuildGridDebug,
  setBuildGridDebug,
  getBaseLodMode,
  setBaseLodMode,
  getDriftMode,
  setDriftMode,
  getClientTiltEmaMode,
  setClientTiltEmaMode,
  getSoundToggle,
  setSoundToggle,
  SOUND_CATEGORIES,
  getLobbyVisible,
  setLobbyVisible,
  getGridOverlay,
  setGridOverlay,
  getWaypointDetail,
  setWaypointDetail,
  setCurrentServerTpsRatio,
  setCurrentRenderTpsRatio,
  setCurrentUnitCount,
  setCurrentUnitCap,
  setServerTpsAvailable,
} from '../clientBarConfig';
import type { CameraSmoothMode } from '../clientBarConfig';
import type { GraphicsQuality, ConcreteGraphicsQuality, RenderMode } from '../types/graphics';
import type {
  AudioScope,
  DriftMode,
  GridOverlay,
  SoundCategory,
  RangeType,
  ProjRangeType,
  UnitRadiusType,
  WaypointDetail,
} from '../types/client';
import { audioManager } from '../game/audio/AudioManager';
import { musicPlayer } from '../game/audio/MusicPlayer';
import {
  applyMinimapCameraQuad,
  applyMinimapContentData,
  createInitialMinimapData,
} from './minimapHelpers';
import {
  bindSceneUiCallbacks,
  waitForSceneAndBind,
} from './gameSceneBindings';

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
const mobileBarsVisible = ref(false);
// When true, hide the BUDGET ANNIHILATION lobby modal so the demo
// battle is full-screen in the background (the user's "watch the
// demo battle" mode). The hamburger ☰ button is what brings the
// lobby back. Persisted under `demo-battle-lobby-visible`.
const spectateMode = ref(!getLobbyVisible());
// Bottom-bars collapsed state, persisted PER MODE — demo and real
// each remember their own preference. The watcher below swaps the
// value when `gameStarted` flips, so transitioning lobby → real
// game (or back) restores the appropriate stored state. Initial
// value uses the demo key because gameStarted starts at false.
const bottomBarsCollapsed = ref(loadStoredDemoBarsCollapsed());
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
    // Ignore storage failures; the button still works for this session.
  }
}

const playerClientEnabled = ref(loadStoredPlayerClientEnabled());
const activePlayer = ref<PlayerId>(1);
const gameOverWinner = ref<PlayerId | null>(null);

// Background battle state (managed by LobbyManager)
let backgroundBattle: BackgroundBattleState | null = null;
// Monotonic counter incremented at the start of every
// `startBackgroundBattle` call. Lets concurrent invocations (e.g.
// multiple lobby-roster-change watcher firings during initial
// handshake) racing through the async createBackgroundBattle
// await detect that they've been superseded — see
// startBackgroundBattle below.
let backgroundBattleGen = 0;

// Current game server (owned by this component)
let currentServer: GameServer | null = null;
let realBattleStartGen = 0;
let realBattleStartTimeout: ReturnType<typeof setTimeout> | null = null;
let recoveryKeyframeTimeouts: ReturnType<typeof setTimeout>[] = [];
const realBattleSnapshotListenerKeys = new Map<PlayerId, string>();

function clearRealBattleTimeouts(): void {
  realBattleStartGen++;
  if (realBattleStartTimeout) {
    clearTimeout(realBattleStartTimeout);
    realBattleStartTimeout = null;
  }
  for (const timeout of recoveryKeyframeTimeouts) clearTimeout(timeout);
  recoveryKeyframeTimeouts = [];
}

function removeRealBattleSnapshotListener(playerId: PlayerId): void {
  const key = realBattleSnapshotListenerKeys.get(playerId);
  if (!key) return;
  currentServer?.removeSnapshotListener(key);
  realBattleSnapshotListenerKeys.delete(playerId);
}

function clearRealBattleSnapshotListeners(): void {
  if (currentServer) {
    for (const key of realBattleSnapshotListenerKeys.values()) {
      currentServer.removeSnapshotListener(key);
    }
  }
  realBattleSnapshotListenerKeys.clear();
}

// Lobby state
const showLobby = ref(true);
const isHost = ref(false);
const roomCode = ref('');
const lobbyPlayers = ref<LobbyPlayer[]>([]);
const localPlayerId = ref<PlayerId>(1);
// LOCAL user's username — persisted in localStorage by playerNamesConfig.
// The lobby is the only place the user can edit it; this ref is still
// the demo/offline fallback and the source we hand to NetworkManager
// when the local lobby slot commits a rename.
const localUsername = ref<string>(getInitialLocalUsername());

/** Resolves a playerId to the name to render in the UI (TopBar) or
 *  above a commander in 3D (NameLabel3D). Lookup priority:
 *    1. lobbyPlayers (real battle): roster name kept in sync by
 *       NetworkManager via playerInfoUpdate.
 *    2. localUsername (when asked for the local player and the roster
 *       hasn't seeded yet — covers DEMO BATTLE and the brief window
 *       between hostGame() and the first roster mirror).
 *    3. Funny default keyed by playerId so every viewer agrees on what
 *       to call AI seats with no host-side rename. */
function resolvePlayerName(pid: PlayerId): string;
function resolvePlayerName(pid: PlayerId, fallback: null): string | null;
function resolvePlayerName(pid: PlayerId, fallback?: string | null): string | null {
  const roster = lobbyPlayers.value.find((p) => p.playerId === pid);
  if (roster && roster.name && roster.name.length > 0) return roster.name;
  if (pid === localPlayerId.value) return localUsername.value;
  return fallback === undefined ? getDefaultPlayerName(pid) : fallback;
}

function upsertLobbyPlayer(player: LobbyPlayer): void {
  const idx = lobbyPlayers.value.findIndex((p) => p.playerId === player.playerId);
  if (idx === -1) {
    lobbyPlayers.value = [...lobbyPlayers.value, { ...player }];
    return;
  }
  lobbyPlayers.value = lobbyPlayers.value.map((existing, i) => {
    if (i !== idx) return existing;
    return {
      ...existing,
      playerId: player.playerId,
      isHost: player.isHost,
      name: player.name || existing.name,
      ipAddress: player.ipAddress ?? existing.ipAddress,
      location: player.location ?? existing.location,
      timezone: player.timezone ?? existing.timezone,
      localTime: player.localTime ?? existing.localTime,
    };
  });
}

/** Commit a local lobby-slot rename — updates the local ref, persists
 *  to localStorage, and (in real battle) hands off to NetworkManager
 *  which broadcasts the change to every other client. */
function onPlayerNameChange(name: string): void {
  const trimmed = name.trim();
  if (trimmed.length === 0) return;
  localUsername.value = trimmed;
  saveUsername(trimmed);
  // Real-battle: NetworkManager owns the lobby roster broadcast.
  // Demo: no networking, the localUsername ref is the only state we
  // need to update — resolvePlayerName picks it up automatically.
  if (currentBattleMode.value === 'real') {
    networkManager.setLocalPlayerName(trimmed);
  }
}
const lobbyError = ref<string | null>(null);
const isConnecting = ref(false);
const gameStarted = ref(false);

// Camera tutorial — shown the first time the player enters a real
// game. Three flashing cards (ZOOM / PAN / ROTATE) clear themselves
// when the player performs each input. Once all three are cleared
// the completion is persisted and the overlay never shows again.
// Persistence key uses the same prefix as other RTS settings so a
// localStorage clear wipes it alongside the rest of the user's
// preferences. Reset by clearing the key from devtools.
const CAMERA_TUTORIAL_DONE_KEY = 'rts-camera-tutorial-done';
const cameraTutorialDone = ref(readPersisted(CAMERA_TUTORIAL_DONE_KEY) === 'true');
function handleCameraTutorialDone(): void {
  cameraTutorialDone.value = true;
  persist(CAMERA_TUTORIAL_DONE_KEY, 'true');
}
function getActiveOrbitCamera(): import('../game/render3d/OrbitCamera').OrbitCamera | null {
  return gameInstance?.getScene()?.getOrbitCamera() ?? null;
}
const networkRole = ref<NetworkRole | null>(null);
const hasServer = ref(false); // True when we own a GameServer (host/offline/background)
const networkNotice = ref<string | null>(null);

const networkStatus = computed(() => {
  if (networkRole.value === 'host') {
    const players = lobbyPlayers.value.length > 0 ? ` ${lobbyPlayers.value.length}P` : '';
    return roomCode.value ? `HOST ${roomCode.value}${players}` : `HOST${players}`;
  }
  if (networkRole.value === 'client') {
    return roomCode.value ? `CLIENT ${roomCode.value}` : 'CLIENT';
  }
  if (gameStarted.value) return 'OFFLINE';
  return networkNotice.value ? 'NETWORK' : '';
});

// When the user switches between demo battle and real battle, restore
// THAT mode's saved bottom-bars collapse preference. Persistence
// happens in `toggleBottomBars` below — this watcher only handles the
// READ side of the per-mode split, so swapping modes doesn't clobber
// the destination mode's stored state.
watch(gameStarted, (started) => {
  bottomBarsCollapsed.value = started
    ? loadStoredRealBarsCollapsed()
    : loadStoredDemoBarsCollapsed();
});

function toggleBottomBars(): void {
  const next = !bottomBarsCollapsed.value;
  bottomBarsCollapsed.value = next;
  if (gameStarted.value) saveRealBarsCollapsed(next);
  else saveDemoBarsCollapsed(next);
}

function setInstancePlayerClientEnabled(instance: GameInstance | null | undefined, enabled: boolean): void {
  if (!instance) return;
  instance.app.setRenderEnabled(enabled);
  instance.getScene()?.setClientRenderEnabled(enabled);
}

function applyPlayerClientEnabled(): void {
  setInstancePlayerClientEnabled(backgroundBattle?.gameInstance, playerClientEnabled.value);
  setInstancePlayerClientEnabled(gameInstance, playerClientEnabled.value);
}

function togglePlayerClientEnabled(): void {
  playerClientEnabled.value = !playerClientEnabled.value;
}

watch(playerClientEnabled, (enabled) => {
  savePlayerClientEnabled(enabled);
  applyPlayerClientEnabled();
});

// Server metadata received from snapshots (for remote clients to display server bar)
const serverMetaFromSnapshot = ref<NetworkServerSnapshotMeta | null>(null);
// Local lookup values are inputs to NetworkManager only. In real
// battles the UI displays the host-propagated LobbyPlayer record.
const localIpAddress = ref<string>('N/A');
// Coarse "City, Country" string from the IP-services lookup,
// or a timezone-derived fallback if the IP service didn't yield
// one. Used in the GAME LOBBY player list. Empty until resolved.
const localLocation = ref<string>('');
// IANA timezone string (e.g. "America/Los_Angeles") for the
// local browser. Available synchronously via Intl, populated
// once at script init and never changes for the session.
const localTimezone = ref<string>(
  (() => {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; }
    catch { return ''; }
  })(),
);
const clientTime = ref<string>('');

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
// `currentBattleMode` to `real`; the watcher below re-loads these
// refs from the real-battle keys at that point.
const terrainCenter = ref<TerrainShape>(loadStoredTerrainCenter('demo'));
const terrainDividers = ref<TerrainShape>(loadStoredTerrainDividers('demo'));
const terrainMapShape = ref<TerrainMapShape>(loadStoredTerrainMapShape('demo'));
const initialMapDimensions = loadStoredMapLandDimensions('demo');
const mapWidthLandCells = ref<number>(initialMapDimensions.widthLandCells);
const mapLengthLandCells = ref<number>(initialMapDimensions.lengthLandCells);
const graphicsQuality = ref<GraphicsQuality>(getGraphicsQuality());
const effectiveQuality = ref<ConcreteGraphicsQuality>(
  getEffectiveQuality(),
);
// Reactive snapshot of the per-signal tri-state. cycleClientSignal()
// re-reads it after each cycle; the template binds button classes
// against this object.
const clientSignalStates = ref({ ...getLodSignalStates() });
// True when ANY client signal is SOLO. The SOLO signal becomes the
// "level in the hierarchy that's running"; AUTO drops to a white-
// text indicator (it's the parent mode, still relevant), and other
// active signals stop showing white text (they're overridden).
const clientAnySolo = computed(() =>
  (LOD_SIGNALS_ENABLED.zoom && clientSignalStates.value.zoom === 'solo') ||
  (LOD_SIGNALS_ENABLED.serverTps && clientSignalStates.value.serverTps === 'solo') ||
  (LOD_SIGNALS_ENABLED.renderTps && clientSignalStates.value.renderTps === 'solo') ||
  (LOD_SIGNALS_ENABLED.units && clientSignalStates.value.units === 'solo'),
);
const renderMode = ref<RenderMode>(getRenderMode());
const audioScope = ref<AudioScope>(getAudioScope());
const audioSmoothing = ref<boolean>(getAudioSmoothing());
const burnMarks = ref<boolean>(getBurnMarks());
const lodShellRings = ref<boolean>(getLodShellRings());
const lodGridBorders = ref<boolean>(getLodGridBorders());
const triangleDebug = ref<boolean>(getTriangleDebug());
const buildGridDebug = ref<boolean>(getBuildGridDebug());
const baseLodMode = ref<boolean>(getBaseLodMode());
const driftMode = ref<DriftMode>(getDriftMode());
// Per-frame chassis-tilt EMA on the client. Layered ON TOP of the
// HOST SERVER tilt EMA. Same SNAP/FAST/MED/SLOW shape as DRIFT.
const clientTiltEmaMode = ref<DriftMode>(getClientTiltEmaMode());
const edgeScrollEnabled = ref(getEdgeScrollEnabled());
const dragPanEnabled = ref(getDragPanEnabled());
const gridOverlay = ref<GridOverlay>(getGridOverlay());
const waypointDetail = ref<WaypointDetail>(getWaypointDetail());
const soundToggles = reactive<Record<SoundCategory, boolean>>({
  fire: getSoundToggle('fire'),
  hit: getSoundToggle('hit'),
  dead: getSoundToggle('dead'),
  beam: getSoundToggle('beam'),
  field: getSoundToggle('field'),
  music: getSoundToggle('music'),
});
audioManager.setMuted(audioScope.value === 'off');
const rangeToggles = reactive<Record<RangeType, boolean>>({
  trackAcquire: getRangeToggle('trackAcquire'),
  trackRelease: getRangeToggle('trackRelease'),
  engageAcquire: getRangeToggle('engageAcquire'),
  engageRelease: getRangeToggle('engageRelease'),
  engageMinAcquire: getRangeToggle('engageMinAcquire'),
  engageMinRelease: getRangeToggle('engageMinRelease'),
  build: getRangeToggle('build'),
});
const projRangeToggles = reactive<Record<ProjRangeType, boolean>>({
  collision: getProjRangeToggle('collision'),
  explosion: getProjRangeToggle('explosion'),
});
const unitRadiusToggles = reactive<Record<UnitRadiusType, boolean>>({
  visual: getUnitRadiusToggle('visual'),
  shot: getUnitRadiusToggle('shot'),
  push: getUnitRadiusToggle('push'),
});
// LEGS-radius (single boolean): show the per-leg "rest circle" — the
// chassis-local circle each foot wanders inside before snapping to the
// opposite edge. Useful for tuning leg gait visually.
const legsRadiusToggle = ref(getLegsRadiusToggle());
// CAMERA: SNAP / FAST / MID / SLOW — controls the OrbitCamera EMA
// time-constant for both zoom and pan. SNAP applies inputs
// instantly; FAST / MID / SLOW use exponential smoothing with
// progressively larger τ.
const cameraSmoothMode = ref<CameraSmoothMode>(getCameraSmoothMode());

// Frame timing tracking (EMA-based, polled from scene)
const frameMsAvg = ref(0);
const frameMsHi = ref(0);
const renderMsAvg = ref(0);
const renderMsHi = ref(0);
const logicMsAvg = ref(0);
const logicMsHi = ref(0);
// Real-GPU-time from EXT_disjoint_timer_query_webgl2 (nanoseconds → ms).
// Supported on Chrome/Edge/recent Firefox; not Safari. When unsupported,
// `gpuTimerSupported` is false and the UI falls back to renderMs.
const gpuTimerMs = ref(0);
const gpuTimerSupported = ref(false);
// Longtask API signal — blocked ms / sec of wall-clock time. 100+ = the
// main thread lost ≥10% of real time to single ≥50 ms tasks.
const longtaskMsPerSec = ref(0);
const longtaskSupported = ref(false);

// Client cadence, snapshot rate, and zoom tracking (EMA-based, polled from scene)
const renderTpsAvg = ref(0);
const renderTpsWorst = ref(0);
const snapAvgRate = ref(0);
const snapWorstRate = ref(0);
// Parallel pair tracking ONLY full-keyframe arrivals — used by the
// FSPS stat bar so the user can see how often the protocol re-seeds
// statics. Hosts with a tight keyframe ratio show a high FSPS;
// 'NONE' keyframe ratio holds FSPS at zero after the initial snap.
const fullSnapAvgRate = ref(0);
const fullSnapWorstRate = ref(0);
const currentZoom = ref(0.4);
let clientTelemetryUpdateInterval: ReturnType<typeof setInterval> | null = null;

// Selection state for the panel
const selectionInfo = reactive<SelectionInfo>({
  unitCount: 0,
  hasCommander: false,
  hasBuilder: false,
  hasDGun: false,
  hasFactory: false,
  factoryId: undefined,
  commanderId: undefined,
  waypointMode: 'move',
  isBuildMode: false,
  selectedBuildingType: null,
  isDGunMode: false,
  factoryQueue: [],
  factoryProgress: 0,
  factoryIsProducing: false,
});

// Economy state for the top bar
const economyInfo = reactive<EconomyInfo>({
  stockpile: { curr: 250, max: 1000 },
  income: { base: 5, production: 0, total: 5 },
  expenditure: 0,
  netFlow: 5,
  mana: {
    stockpile: { curr: 200, max: 1000 },
    income: { base: 5, territory: 0, total: 5 },
    expenditure: 0,
    netFlow: 5,
  },
  metal: {
    stockpile: { curr: 200, max: 1000 },
    income: { base: 2, extraction: 0, total: 2 },
    expenditure: 0,
    netFlow: 2,
  },
  units: { count: 1, cap: 120 },
  buildings: { solar: 0, wind: 0, factory: 0, extractor: 0 },
});

// Minimap state
const minimapData = reactive<MinimapData>(createInitialMinimapData());

const showSoundTest = ref(false);
const battleElapsed = ref('00:00:00');
let battleStartTime = 0;

function setRefIfChanged<T>(target: { value: T }, value: T): void {
  if (!Object.is(target.value, value)) target.value = value;
}

function setNumberRefIfChanged(target: { value: number }, value: number, epsilon = 0.01): void {
  if (!Number.isFinite(value)) return;
  if (Math.abs(target.value - value) > epsilon) target.value = value;
}

function bindGameSceneUi(scene: GameScene, includeGameLifecycle = false): void {
  bindSceneUiCallbacks(scene, {
    onPlayerChange: (playerId) => {
      activePlayer.value = playerId;
    },
    onSelectionChange: (info) => {
      Object.assign(selectionInfo, info);
    },
    onEconomyChange: (info) => {
      Object.assign(economyInfo, info);
    },
    onMinimapUpdate: (data) => {
      applyMinimapContentData(minimapData, data);
    },
    onCameraQuadUpdate: (quad, cameraYaw) => {
      applyMinimapCameraQuad(minimapData, quad, cameraYaw);
    },
    onServerMetaUpdate: (meta) => {
      serverMetaFromSnapshot.value = meta;
    },
    ...(includeGameLifecycle
      ? {
          onGameOver: (winnerId: PlayerId) => {
            gameOverWinner.value = winnerId;
          },
          onGameRestart: () => {
            gameOverWinner.value = null;
          },
        }
      : {}),
  });
}

let gameInstance: GameInstance | null = null;
// Hoisted from the scene so state survives a live 2D↔3D renderer swap.
// One instance per game session — created alongside gameConnection when
// the match starts, cleared when the match ends.
let clientViewState: ClientViewState | null = null;

// Polling interval IDs for cleanup
let checkBgSceneInterval: ReturnType<typeof setInterval> | null = null;
let checkSceneInterval: ReturnType<typeof setInterval> | null = null;
let clientTimeInterval: ReturnType<typeof setInterval> | null = null;

// Start the background battle (runs behind lobby).
//
// The "background battle" is the live demo simulation we use as the
// pre-game backdrop AND the GAME LOBBY preview pane. Pass the
// active battle mode so the demo reads its terrain + sim settings
// from the right namespace: `demo` keys when the user is on the
// BUDGET ANNIHILATION screen (solo prefs), `real` keys once they
// click Host/Join (so the preview shows what the upcoming real
// battle will look like).
//
// In lobby-preview mode we also pass the live lobby player count
// so the spawn circle reflects who's actually in the room — the
// watcher below restarts the demo whenever that count changes.
async function startBackgroundBattle(): Promise<void> {
  if (!backgroundContainerRef.value) return;
  // Always teardown any existing battle first — this function is
  // the canonical "rebuild the simulation NOW" entry point, called
  // from every watcher (mode flip, terrain change, lobby roster
  // change). Concurrent calls during the async createBattle await
  // are handled by the generation counter below: each invocation
  // claims a fresh `gen`, and only the call whose `gen` still
  // matches the latest counter value gets to install its result.
  // Earlier-generation results are silently destroyed so we don't
  // leak GameServer instances.
  stopBackgroundBattle();
  const myGen = ++backgroundBattleGen;
  // For the GAME LOBBY preview we pass the ACTUAL lobby seat IDs
  // (not a generic 1..N) and the local player's seat — so the
  // preview spawns commanders at the same seats the real battle
  // will use AND the camera/HUD treats the local player's
  // commander as "yours" instead of always defaulting to seat 1.
  const previewPlayerIds = currentBattleMode.value === 'real'
    ? lobbyPlayers.value.map((p) => p.playerId)
    : undefined;
  const previewLocalPlayerId = currentBattleMode.value === 'real'
    ? localPlayerId.value
    : undefined;
  const battle = await createBackgroundBattle(
    backgroundContainerRef.value,
    localIpAddress.value,
    currentBattleMode.value,
    previewPlayerIds,
    previewLocalPlayerId,
  );
  if (myGen !== backgroundBattleGen) {
    // Superseded by a later restart while we were awaiting —
    // discard this instance instead of installing it.
    destroyBackgroundBattle(battle);
    return;
  }
  backgroundBattle = battle;
  activeConnection = backgroundBattle.connection;
  hasServer.value = true;
  battleStartTime = Date.now();
  setInstancePlayerClientEnabled(backgroundBattle.gameInstance, playerClientEnabled.value);

  checkBgSceneInterval = waitForSceneAndBind(
    () => backgroundBattle?.gameInstance?.getScene(),
    (bgScene) => {
      bgScene.setClientRenderEnabled(playerClientEnabled.value);
      bindGameSceneUi(bgScene);
      checkBgSceneInterval = null;
    },
  );
}

// Stop the background battle
function stopBackgroundBattle(): void {
  if (checkBgSceneInterval) {
    clearInterval(checkBgSceneInterval);
    checkBgSceneInterval = null;
  }
  if (backgroundBattle) {
    destroyBackgroundBattle(backgroundBattle);
    backgroundBattle = null;
  }
  // Only clear hasServer/activeConnection if there's no game server either
  if (!currentServer) {
    activeConnection = null;
    hasServer.value = false;
    if (!gameStarted.value) battleStartTime = 0;
  }
}

// Show player toggle only in single-player mode (offline or hosting alone)
const showPlayerToggle = computed(() => {
  // Demo game: always allow toggling
  if (!gameStarted.value) return true;
  // Real game: only host in single-player
  const isSinglePlayer = lobbyPlayers.value.length === 1;
  return networkRole.value === null ||
    (networkRole.value === 'host' && isSinglePlayer);
});

// Is the lobby modal actually visible on screen? (desktop only)
const lobbyModalVisible = computed(
  () => !isMobile && showLobby.value && !spectateMode.value,
);
// True ONLY when the user is on the GAME LOBBY screen AND the
// lobby modal is mounted. The watcher below uses this to decide
// where the demo-battle container should be DOM-parented.
const inGameLobby = computed(
  () => roomCode.value !== '' && lobbyModalVisible.value,
);

// Which battle storage namespace is active right now.
//   `demo` = the visual demo behind the BUDGET ANNIHILATION screen
//            (initial page load + return-to-lobby cancel).
//   `real` = the GAME LOBBY (preview pane) AND the actual REAL
//            BATTLE — both share the `real-battle-*` keys so the
//            lobby preview reflects what the upcoming real game
//            will look like, and any host adjustments in the lobby
//            persist into the real battle and across sessions.
//
// `roomCode` is set the moment the user clicks Host/Join (or
// finishes joining), and `gameStarted` covers the actual game; the
// union of those two flips the namespace at exactly the right
// boundary without depending on modal visibility (so a brief
// hide-modal during transitions doesn't accidentally write to demo
// keys mid-lobby).
const currentBattleMode = computed<BattleMode>(
  () => (gameStarted.value || roomCode.value !== '' ? 'real' : 'demo'),
);

const localLobbyPlayer = computed(
  () => lobbyPlayers.value.find((p) => p.playerId === localPlayerId.value) ?? null,
);
const displayedClientTime = computed(() =>
  currentBattleMode.value === 'real'
    ? localLobbyPlayer.value?.localTime ?? ''
    : clientTime.value,
);
const displayedClientIp = computed(() =>
  currentBattleMode.value === 'real'
    ? localLobbyPlayer.value?.ipAddress ?? ''
    : (localIpAddress.value !== 'N/A' ? localIpAddress.value : ''),
);

// When the active namespace flips, refresh the reactive UI refs so
// the BATTLE bar + terrain options reflect THAT mode's stored
// values, AND restart the running demo battle so the preview pane
// rebuilds against the new mode's settings (terrain shape, sim
// rules). The first-write-falls-back-to-demo logic in the loaders
// means a user entering the lobby for the first time sees their
// existing demo settings, after which lobby mutations save under
// real-battle-* and the two namespaces diverge. Skipped when
// `gameStarted` is true — by then the real battle owns the
// container and the demo isn't running.
watch(currentBattleMode, (mode) => {
  terrainCenter.value = loadStoredTerrainCenter(mode);
  terrainDividers.value = loadStoredTerrainDividers(mode);
  terrainMapShape.value = loadStoredTerrainMapShape(mode);
  const mapDimensions = loadStoredMapLandDimensions(mode);
  mapWidthLandCells.value = mapDimensions.widthLandCells;
  mapLengthLandCells.value = mapDimensions.lengthLandCells;
  if (!gameStarted.value) {
    stopBackgroundBattle();
    nextTick(() => {
      startBackgroundBattle();
    });
  }
});

// GAME LOBBY preview keeps its commander count in sync with the
// actual lobby roster — every join / leave triggers a demo
// rebuild so the preview reflects who's connected. Only fires in
// lobby-preview mode (real namespace + lobby active); the
// full-screen demo backdrop stays at DEMO_CONFIG.playerCount.
watch(() => lobbyPlayers.value.length, () => {
  if (
    currentBattleMode.value === 'real' &&
    !gameStarted.value &&
    inGameLobby.value
  ) {
    stopBackgroundBattle();
    nextTick(() => {
      startBackgroundBattle();
    });
  }
});

// Local seat assignment (`onPlayerAssignment`) can land AFTER the
// initial roster sync — a fresh joiner first sees the player list
// arrive, then receives their seat. Rebuild the preview when our
// own seat changes so the local commander reflects who we are,
// not seat 1.
watch(localPlayerId, () => {
  if (
    currentBattleMode.value === 'real' &&
    !gameStarted.value &&
    inGameLobby.value
  ) {
    stopBackgroundBattle();
    nextTick(() => {
      startBackgroundBattle();
    });
  }
});

// Re-parent the demo-battle container into the lobby's preview
// pane when in the GAME LOBBY state, and back to its original spot
// otherwise. Imperative DOM move (not Vue Teleport) because the
// demo battle pumps reactive refs every frame, and Vue Teleport
// with a reactive `:disabled` interacts badly with that traffic —
// the patcher hits stale vnodes ("Cannot set properties of null
// setting '__vnode'"). Pure DOM moves bypass Vue's vnode tracking
// entirely; the element's vnode→DOM mapping stays fixed via its
// `el` reference, and Three.js's ResizeObserver on the parent
// picks up the new size automatically.
watch(inGameLobby, (active) => {
  const container = backgroundContainerRef.value;
  if (!container) return;
  // Wait one tick so the LobbyModal has rendered the target div
  // (or torn it down) before we attempt to move into / out of it.
  nextTick(() => {
    if (active) {
      const target = document.getElementById('lobby-preview-target');
      if (target && container.parentElement !== target) {
        target.appendChild(container);
      }
    } else {
      const home = gameAreaRef.value;
      if (home && container.parentElement !== home) {
        home.appendChild(container);
      }
    }
  });
});

// Show server controls when we own a server OR when we receive server meta from snapshots (remote client)
const showServerControls = computed(
  () => hasServer.value || serverMetaFromSnapshot.value !== null,
);

// Server bar is read-only for remote clients (no local server)
const serverBarReadonly = computed(() => !hasServer.value);

// Bar color theming — `barVars` lives in `src/barThemes.ts` so the
// LobbyModal's CENTER / DIVIDERS controls can apply the same battle
// palette without duplicating the CSS-var dictionary.
const battleBarVars = computed(() =>
  barVars(serverBarReadonly.value
    ? BAR_THEMES.disabled
    : gameStarted.value ? BAR_THEMES.realBattle : BAR_THEMES.battle),
);
const serverBarVars = computed(() =>
  barVars(serverBarReadonly.value ? BAR_THEMES.disabled : BAR_THEMES.server),
);
const clientBarVars = computed(() => barVars(BAR_THEMES.client));

const battleLabel = computed(() => gameStarted.value ? 'REAL BATTLE' : 'DEMO BATTLE');

// Display values: always read from snapshot meta (server→snapshot→display)
const displayServerTpsAvg = computed(
  () => serverMetaFromSnapshot.value?.ticks.avg ?? 0,
);
const displayServerTpsWorst = computed(
  () => serverMetaFromSnapshot.value?.ticks.low ?? 0,
);
const displayServerCpuAvg = computed(
  () => serverMetaFromSnapshot.value?.cpu?.avg ?? 0,
);
const displayServerCpuHi = computed(
  () => serverMetaFromSnapshot.value?.cpu?.hi ?? 0,
);
// GPU displayed time: prefer the real EXT_disjoint_timer_query_webgl2
// result (true GPU-side execution time); fall back to renderMs, which is
// the CPU wall-clock of renderer.render() — mostly draw-call submission,
// but correlates with GPU cost.
const displayGpuMs = computed(() =>
  gpuTimerSupported.value ? gpuTimerMs.value : renderMsAvg.value,
);
const gpuSourceLabel = computed(() =>
  gpuTimerSupported.value ? 'GPU time query' : 'renderer.render() wall-clock',
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
    const valid = (s: unknown): s is SignalState =>
      s === 'off' || s === 'active' || s === 'solo';
    const updated: ServerSimSignalStates = { ...serverSignalStates.value };
    let changed = false;
    if (valid(signals.tps) && signals.tps !== updated.tps) { updated.tps = signals.tps; changed = true; }
    if (valid(signals.cpu) && signals.cpu !== updated.cpu) { updated.cpu = signals.cpu; changed = true; }
    if (valid(signals.units) && signals.units !== updated.units) { updated.units = signals.units; changed = true; }
    if (changed) serverSignalStates.value = updated;
  },
  { deep: true },
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
  const sps = displaySnapshotRate.value === 'none' ? 60 : displaySnapshotRate.value;
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

// Single source of truth for "the current value of every battle
// setting on the host" — `serverMetaFromSnapshot` (snapshot meta is
// authoritative) with `BATTLE_CONFIG` defaults as the only fallback
// when no snapshot has arrived yet. The bottom BATTLE bar template,
// the LobbyModal, the toggle/setter functions below, and any read
// elsewhere all consume these computeds rather than re-deriving the
// same fallback chain inline. Add a new battle-config field and you
// touch this block once instead of every consumer.
const currentAllowedUnits = computed<readonly string[]>(
  () =>
    serverMetaFromSnapshot.value?.units.allowed ??
    demoUnitTypes.filter((ut) => BATTLE_CONFIG.units[ut]?.default ?? false),
);
const allDemoUnitsActive = computed(() =>
  demoUnitTypes.every((ut) => currentAllowedUnits.value.includes(ut)),
);
const currentMirrorsEnabled = computed(
  () => serverMetaFromSnapshot.value?.mirrorsEnabled ?? BATTLE_CONFIG.mirrorsEnabled.default,
);
const currentForceFieldsEnabled = computed(
  () => serverMetaFromSnapshot.value?.forceFieldsEnabled ?? BATTLE_CONFIG.forceFieldsEnabled.default,
);

function toggleDemoUnitType(unitType: string): void {
  const allowed = currentAllowedUnits.value;
  const current = allowed.includes(unitType);
  activeConnection?.sendCommand({
    type: 'setBackgroundUnitType',
    tick: 0,
    unitType,
    enabled: !current,
  });

  // Persist updated unit list to localStorage
  const newList = current
    ? allowed.filter((ut) => ut !== unitType)
    : [...allowed, unitType];
  saveDemoUnits(newList);
}

function toggleAllDemoUnits(): void {
  const enableAll = !allDemoUnitsActive.value;
  for (const ut of demoUnitTypes) {
    activeConnection?.sendCommand({
      type: 'setBackgroundUnitType',
      tick: 0,
      unitType: ut,
      enabled: enableAll,
    });
  }
  saveDemoUnits(enableAll ? [...demoUnitTypes] : []);
}

function changeMaxTotalUnits(value: number): void {
  activeConnection?.sendCommand({
    type: 'setMaxTotalUnits',
    tick: 0,
    maxTotalUnits: value,
  });
  // Cap is mode-namespaced: GAME LOBBY changes write to the
  // real-battle key (alongside the running real battle), demo
  // mutations write to the demo key. Same pattern every shared
  // setting below uses via `currentBattleMode`.
  saveStoredCap(currentBattleMode.value, value);
}

function setMirrorsEnabled(enabled: boolean): void {
  activeConnection?.sendCommand({ type: 'setMirrorsEnabled', tick: 0, enabled });
  saveMirrorsEnabled(enabled, currentBattleMode.value);
}

function setForceFieldsEnabled(enabled: boolean): void {
  activeConnection?.sendCommand({ type: 'setForceFieldsEnabled', tick: 0, enabled });
  saveForceFieldsEnabled(enabled, currentBattleMode.value);
}

function currentLobbySettings() {
  return {
    terrainCenter: terrainCenter.value,
    terrainDividers: terrainDividers.value,
    terrainMapShape: terrainMapShape.value,
    mapWidthLandCells: mapWidthLandCells.value,
    mapLengthLandCells: mapLengthLandCells.value,
  };
}

function broadcastLobbySettingsIfHost(): void {
  if (networkRole.value === 'host' && roomCode.value !== '') {
    networkManager.broadcastLobbySettings(currentLobbySettings());
  }
}

/** Pick a new terrain shape (CENTER or DIVIDERS). Persists the choice
 *  and, if a demo battle is running, restarts it so the new heightmap
 *  takes effect immediately. The demo path stops + recreates the
 *  background server (which is what `restartGame` does for the lobby
 *  return); we skip the network teardown since we're staying in the
 *  same lobby. During a real battle, the choice is saved but won't
 *  be visible until the next game start — terrain meshes are baked
 *  once at scene construction. */
function applyTerrainShape(
  kind: 'center' | 'dividers',
  shape: TerrainShape,
  broadcast = true,
): void {
  const mode = currentBattleMode.value;
  if (kind === 'center') {
    terrainCenter.value = shape;
    saveTerrainCenter(shape, mode);
  } else {
    terrainDividers.value = shape;
    saveTerrainDividers(shape, mode);
  }
  // Live preview only when the demo battle is the active scene; a real
  // battle keeps the host's choice queued for the next game start.
  if (!gameStarted.value) {
    stopBackgroundBattle();
    nextTick(() => {
      startBackgroundBattle();
    });
  }
  // Sync the change to remote clients when the host is in the
  // GAME LOBBY. `broadcast=false` is the path used by the
  // `onLobbySettings` listener below (a client receiving the
  // host's broadcast applies it locally without re-broadcasting,
  // so there's no echo loop).
  if (
    broadcast &&
    networkRole.value === 'host' &&
    roomCode.value !== ''
  ) {
    broadcastLobbySettingsIfHost();
  }
}

function applyTerrainMapShape(shape: TerrainMapShape, broadcast = true): void {
  const mode = currentBattleMode.value;
  terrainMapShape.value = shape;
  saveTerrainMapShape(shape, mode);
  if (!gameStarted.value) {
    stopBackgroundBattle();
    nextTick(() => {
      startBackgroundBattle();
    });
  }
  if (
    broadcast &&
    networkRole.value === 'host' &&
    roomCode.value !== ''
  ) {
    broadcastLobbySettingsIfHost();
  }
}

function sameMapLandDimensions(
  a: MapLandCellDimensions,
  b: MapLandCellDimensions,
): boolean {
  return (
    a.widthLandCells === b.widthLandCells &&
    a.lengthLandCells === b.lengthLandCells
  );
}

function applyMapLandDimensions(
  dimensions: MapLandCellDimensions,
  broadcast = true,
): void {
  const mode = currentBattleMode.value;
  mapWidthLandCells.value = dimensions.widthLandCells;
  mapLengthLandCells.value = dimensions.lengthLandCells;
  saveMapLandDimensions(dimensions, mode);
  if (!gameStarted.value) {
    stopBackgroundBattle();
    nextTick(() => {
      startBackgroundBattle();
    });
  }
  if (broadcast) broadcastLobbySettingsIfHost();
}

function resetDemoDefaults(): void {
  const defaultUnits = getDefaultDemoUnits();
  const defaultSet = new Set(defaultUnits);
  for (const ut of demoUnitTypes) {
    activeConnection?.sendCommand({
      type: 'setBackgroundUnitType',
      tick: 0,
      unitType: ut,
      enabled: defaultSet.has(ut),
    });
  }
  saveDemoUnits(defaultUnits);
  changeMaxTotalUnits(getDefaultCap(currentBattleMode.value));
  // DEFAULTS only resets the CURRENTLY-ACTIVE mode's namespace —
  // resetting demo while in the lobby would wipe the user's solo
  // demo prefs out from under them, and vice versa.
  const mode = currentBattleMode.value;
  setMirrorsEnabled(BATTLE_CONFIG.mirrorsEnabled.default);
  setForceFieldsEnabled(BATTLE_CONFIG.forceFieldsEnabled.default);
  // Reset terrain shape to defaults. applyTerrainShape handles the
  // demo-battle restart so the new heightmap is visible immediately.
  // Skip the restart if both values already match the defaults — a
  // restart wipes in-flight units in the current demo and would feel
  // janky for a no-op click on RESET DEFAULTS.
  const centerDefault = BATTLE_CONFIG.center.default;
  const dividersDefault = BATTLE_CONFIG.dividers.default;
  const mapShapeDefault = BATTLE_CONFIG.mapShape.default;
  const mapDimensionsDefault = getDefaultMapLandDimensions();
  if (
    terrainCenter.value !== centerDefault ||
    terrainDividers.value !== dividersDefault ||
    terrainMapShape.value !== mapShapeDefault ||
    !sameMapLandDimensions(
      {
        widthLandCells: mapWidthLandCells.value,
        lengthLandCells: mapLengthLandCells.value,
      },
      mapDimensionsDefault,
    )
  ) {
    terrainCenter.value = centerDefault;
    terrainDividers.value = dividersDefault;
    terrainMapShape.value = mapShapeDefault;
    mapWidthLandCells.value = mapDimensionsDefault.widthLandCells;
    mapLengthLandCells.value = mapDimensionsDefault.lengthLandCells;
    saveTerrainCenter(centerDefault, mode);
    saveTerrainDividers(dividersDefault, mode);
    saveTerrainMapShape(mapShapeDefault, mode);
    saveMapLandDimensions(mapDimensionsDefault, mode);
    if (!gameStarted.value) {
      stopBackgroundBattle();
      nextTick(() => {
        startBackgroundBattle();
      });
    }
  }
  // Reset grid to mode default
  const gridDefault = getDefaultGrid(currentBattleMode.value);
  if (displayGridInfo.value !== gridDefault) {
    toggleSendGridInfo();
  }
  broadcastLobbySettingsIfHost();
}

function resetServerDefaults(): void {
  setTickRateValue(SERVER_CONFIG.tickRate.default);
  setNetworkUpdateRate(SERVER_CONFIG.snapshot.default);
  setKeyframeRatioValue(SERVER_CONFIG.keyframe.default);
  // Sim quality (auto / min / low / med / high / max). Was missing
  // from the reset path — clicking DEFAULTS reverted everything else
  // but left this at whatever the user last picked, so a refresh
  // would replay the stale value while every other server setting
  // came back at default.
  setSimQualityValue(SERVER_SIM_QUALITY_DEFAULT);
  // Reset every HOST SERVER LOD signal to the centralized
  // SERVER_SIM_LOD_SIGNAL_DEFAULTS table, persist, and ship the new
  // states so the simulation's auto-LOD picks them up immediately.
  const fresh = resetSimSignalStates();
  serverSignalStates.value = fresh;
  activeConnection?.sendCommand({
    type: 'setSimSignalStates',
    tick: 0,
    tps: fresh.tps,
    cpu: fresh.cpu,
    units: fresh.units,
  });
}

function resetClientDefaults(): void {
  const cd = CLIENT_CONFIG;
  changeGraphicsQuality(cd.graphics.default);
  changeRenderMode(cd.render.default);
  changeAudioScope(cd.audio.default);
  setAudioSmoothing(cd.audioSmoothing.default);
  audioSmoothing.value = cd.audioSmoothing.default;
  setBurnMarks(cd.burnMarks.default);
  burnMarks.value = cd.burnMarks.default;
  setLodShellRings(cd.lodShellRings.default);
  lodShellRings.value = cd.lodShellRings.default;
  setLodGridBorders(cd.lodGridBorders.default);
  lodGridBorders.value = cd.lodGridBorders.default;
  setTriangleDebug(cd.triangleDebug.default);
  triangleDebug.value = cd.triangleDebug.default;
  setBuildGridDebug(cd.buildGridDebug.default);
  buildGridDebug.value = cd.buildGridDebug.default;
  setBaseLodMode(cd.baseLodMode.default);
  baseLodMode.value = cd.baseLodMode.default;
  setDriftMode(cd.driftMode.default);
  driftMode.value = cd.driftMode.default;
  setClientTiltEmaMode(cd.tiltEma.default);
  clientTiltEmaMode.value = cd.tiltEma.default;
  if (edgeScrollEnabled.value !== cd.edgeScroll.default) toggleEdgeScroll();
  if (dragPanEnabled.value !== cd.dragPan.default) toggleDragPan();
  for (const rt of RANGE_TYPES) {
    if (rangeToggles[rt] !== cd.rangeToggles.default) toggleRange(rt);
  }
  for (const prt of PROJ_RANGE_TYPES) {
    if (projRangeToggles[prt] !== cd.projRangeToggles.default)
      toggleProjRange(prt);
  }
  for (const urt of UNIT_RADIUS_TYPES) {
    if (unitRadiusToggles[urt] !== cd.unitRadiusToggles.default)
      toggleUnitRadius(urt);
  }
  for (const cat of SOUND_CATEGORIES) {
    if (soundToggles[cat] !== cd.sounds.default[cat]) toggleSoundCategory(cat);
  }
  gridOverlay.value = cd.gridOverlay.default;
  setGridOverlay(cd.gridOverlay.default);
  waypointDetail.value = cd.waypointDetail.default;
  setWaypointDetail(cd.waypointDetail.default);
  // Two settings the previous reset was forgetting to persist — the
  // bar showed them flip back to default in the UI, but neither
  // setter was called, so localStorage retained the old value and
  // the next page refresh replayed it.
  if (legsRadiusToggle.value !== cd.legsRadius.default) toggleLegsRadius();
  setCameraMode(cd.cameraSmooth.default);
  // Reset every PLAYER CLIENT LOD signal to the centralized
  // LOD_SIGNAL_DEFAULTS table, then refresh the reactive ref the
  // bar template reads from so the buttons repaint immediately.
  resetLodSignalStates();
  clientSignalStates.value = { ...getLodSignalStates() };
}

function togglePlayer(): void {
  const scene = gameInstance?.getScene() ?? backgroundBattle?.gameInstance?.getScene();
  if (scene) {
    scene.togglePlayer();
    activePlayer.value = scene.getActivePlayer();
  }
}

function handleMinimapClick(x: number, y: number): void {
  const scene = gameInstance?.getScene();
  scene?.centerCameraOn(x, y);
}

function restartGame(): void {
  gameOverWinner.value = null;
  battleStartTime = 0;
  clearRealBattleTimeouts();
  // Return to lobby
  gameStarted.value = false;
  showLobby.value = true;
  networkManager.disconnect();
  networkRole.value = null;
  lobbyPlayers.value = [];
  roomCode.value = '';
  lobbyError.value = null;
  networkNotice.value = null;

  // Stop current server
  if (currentServer) {
    clearRealBattleSnapshotListeners();
    currentServer.stop();
    currentServer = null;
  }
  activeConnection = null;
  hasServer.value = false;
  serverMetaFromSnapshot.value = null;

  if (gameInstance) {
    destroyGame(gameInstance);
    gameInstance = null;
  }

  // Restart the background battle
  nextTick(() => {
    startBackgroundBattle();
  });
}

// Selection panel actions
const selectionActions: SelectionActions = {
  setWaypointMode: (mode: WaypointType) => {
    const scene = gameInstance?.getScene();
    scene?.setWaypointMode(mode);
  },
  startBuild: (buildingType: BuildingType) => {
    const scene = gameInstance?.getScene();
    scene?.startBuildMode(buildingType);
  },
  cancelBuild: () => {
    const scene = gameInstance?.getScene();
    scene?.cancelBuildMode();
  },
  toggleDGun: () => {
    const scene = gameInstance?.getScene();
    scene?.toggleDGunMode();
  },
  queueUnit: (factoryId: number, unitId: string) => {
    const scene = gameInstance?.getScene();
    scene?.queueFactoryUnit(factoryId, unitId);
  },
  cancelQueueItem: (factoryId: number, index: number) => {
    const scene = gameInstance?.getScene();
    scene?.cancelFactoryQueueItem(factoryId, index);
  },
};

// Lobby handlers
async function handleHost(): Promise<void> {
  try {
    isConnecting.value = true;
    lobbyError.value = null;
    networkNotice.value = null;

    await networkManager.hostGame();
    roomCode.value = networkManager.getRoomCode();
    isHost.value = true;
    networkRole.value = 'host';
    localPlayerId.value = 1;

    // Add self from NetworkManager's canonical host roster. IP/time
    // arrive through reportLocalPlayerInfo and host heartbeat updates.
    lobbyPlayers.value = networkManager.getPlayers().map((player) => ({ ...player }));

    // Setup network callbacks
    setupNetworkCallbacks();

    // Always broadcast on host start — we have at least the local
    // timezone (synchronously available via Intl), and may also
    // have IP/location if the IP fetch already resolved. Future
    // joiners receive this via the playerJoined handshake's
    // info-update follow-up; a later fetch resolution overwrites.
    networkManager.reportLocalPlayerInfo(
      localIpAddress.value !== 'N/A' ? localIpAddress.value : undefined,
      localLocation.value || undefined,
      localTimezone.value || undefined,
    );

    isConnecting.value = false;
  } catch (err) {
    lobbyError.value = (err as Error).message || 'Failed to host game';
    networkNotice.value = lobbyError.value;
    isConnecting.value = false;
  }
}

async function handleJoin(code: string): Promise<void> {
  try {
    isConnecting.value = true;
    lobbyError.value = null;
    networkNotice.value = null;

    // Wire callbacks BEFORE joining. The host sends `playerAssignment`
    // immediately on `conn.on('open')`, so the message can land in
    // the joiner's data handler the moment the await unwraps —
    // before any code AFTER the await has had a chance to run.
    // If the callbacks aren't set up by then, the message is still
    // processed (`networkManager.localPlayerId` is updated internally)
    // but `onPlayerAssignment` is `undefined` so the Vue ref
    // `localPlayerId.value` never gets the assigned seat. The joiner
    // would then build their scene with the default `localPlayerId=1`,
    // and centerCameraOnCommander would look for player 1's commander
    // instead of the joiner's assigned commander.
    networkRole.value = 'client';
    setupNetworkCallbacks();

    await networkManager.joinGame(code);
    roomCode.value = networkManager.getRoomCode();
    isHost.value = false;

    // Same eager-report rule as `handleHost` above — timezone is
    // always available, IP/location may still be pending; the
    // onMounted fetch's .then() will re-call this once IP
    // resolves to fill in the remaining columns.
    networkManager.reportLocalPlayerInfo(
      localIpAddress.value !== 'N/A' ? localIpAddress.value : undefined,
      localLocation.value || undefined,
      localTimezone.value || undefined,
    );

    isConnecting.value = false;
  } catch (err) {
    lobbyError.value = (err as Error).message || 'Failed to join game';
    networkNotice.value = lobbyError.value;
    isConnecting.value = false;
  }
}

function handleLobbyStart(): void {
  // Host starts the game
  networkManager.startGame();
}

function handleLobbyCancel(): void {
  networkManager.disconnect();
  networkRole.value = null;
  roomCode.value = '';
  isHost.value = false;
  lobbyPlayers.value = [];
  lobbyError.value = null;
  networkNotice.value = null;
  isConnecting.value = false;
}

function handleOffline(): void {
  // Start game in offline mode — 4-player AI game, user controls player 1
  networkRole.value = null;
  networkNotice.value = null;
  localPlayerId.value = 1;

  nextTick(() => {
    startGameWithPlayers(
      [1, 2, 3, 4] as PlayerId[],
      [2, 3, 4] as PlayerId[],
    );
  });
}

function toggleSpectateMode(): void {
  spectateMode.value = !spectateMode.value;
  setLobbyVisible(!spectateMode.value);
}

function changeGraphicsQuality(quality: GraphicsQuality): void {
  setGraphicsQuality(quality);
  graphicsQuality.value = quality;
}

// Tri-state click handler for the LOD signal buttons. Cycles the
// signal's state OFF → ACTIVE → SOLO → OFF and bumps the reactive
// ref so the template repaints without polling. Note: clicking a
// signal does NOT change the global mode — the user has to pick
// AUTO or a manual tier separately.
function cycleClientSignal(signal: 'zoom' | 'serverTps' | 'renderTps' | 'units'): void {
  cycleLodSignalState(signal);
  // Trigger reactivity by re-reading the snapshot.
  clientSignalStates.value = { ...getLodSignalStates() };
}

function changeRenderMode(mode: RenderMode): void {
  setRenderMode(mode);
  renderMode.value = mode;
}

function changeAudioScope(scope: AudioScope): void {
  setAudioScope(scope);
  audioScope.value = scope;
  audioManager.setMuted(scope === 'off');
}

function toggleRange(type: RangeType): void {
  const newValue = !rangeToggles[type];
  setRangeToggle(type, newValue);
  rangeToggles[type] = newValue;
}

function toggleProjRange(type: ProjRangeType): void {
  const newValue = !projRangeToggles[type];
  setProjRangeToggle(type, newValue);
  projRangeToggles[type] = newValue;
}

function toggleUnitRadius(type: UnitRadiusType): void {
  const newValue = !unitRadiusToggles[type];
  setUnitRadiusToggle(type, newValue);
  unitRadiusToggles[type] = newValue;
}

function toggleLegsRadius(): void {
  const newValue = !legsRadiusToggle.value;
  setLegsRadiusToggle(newValue);
  legsRadiusToggle.value = newValue;
}

function setCameraMode(mode: CameraSmoothMode): void {
  setCameraSmoothMode(mode);
  cameraSmoothMode.value = mode;
}

// "ALL" helpers for each radius/range section — same behavior as
// the UNITS: ALL button in the battle bar: flip every sub-toggle to
// match the resulting "all-on" or "all-off" state. Computed flags
// drive the ALL button's active state.
const allRangesActive = computed(() =>
  RANGE_TYPES.every((rt) => rangeToggles[rt]),
);
const allProjRangesActive = computed(() =>
  PROJ_RANGE_TYPES.every((prt) => projRangeToggles[prt]),
);
const allUnitRadiiActive = computed(() =>
  UNIT_RADIUS_TYPES.every((urt) => unitRadiusToggles[urt]),
);

function toggleAllRanges(): void {
  const enable = !allRangesActive.value;
  for (const rt of RANGE_TYPES) {
    setRangeToggle(rt, enable);
    rangeToggles[rt] = enable;
  }
}

function toggleAllProjRanges(): void {
  const enable = !allProjRangesActive.value;
  for (const prt of PROJ_RANGE_TYPES) {
    setProjRangeToggle(prt, enable);
    projRangeToggles[prt] = enable;
  }
}

function toggleAllUnitRadii(): void {
  const enable = !allUnitRadiiActive.value;
  for (const urt of UNIT_RADIUS_TYPES) {
    setUnitRadiusToggle(urt, enable);
    unitRadiusToggles[urt] = enable;
  }
}

function toggleAudioSmoothing(): void {
  const newValue = !audioSmoothing.value;
  setAudioSmoothing(newValue);
  audioSmoothing.value = newValue;
}

function toggleBurnMarks(): void {
  const newValue = !burnMarks.value;
  setBurnMarks(newValue);
  burnMarks.value = newValue;
}

function toggleLodShellRings(): void {
  const newValue = !lodShellRings.value;
  setLodShellRings(newValue);
  lodShellRings.value = newValue;
}

function toggleLodGridBorders(): void {
  const newValue = !lodGridBorders.value;
  setLodGridBorders(newValue);
  lodGridBorders.value = newValue;
}

function toggleTriangleDebug(): void {
  const newValue = !triangleDebug.value;
  setTriangleDebug(newValue);
  triangleDebug.value = newValue;
}

function toggleBuildGridDebug(): void {
  const newValue = !buildGridDebug.value;
  setBuildGridDebug(newValue);
  buildGridDebug.value = newValue;
}

function toggleBaseLodMode(): void {
  const newValue = !baseLodMode.value;
  setBaseLodMode(newValue);
  baseLodMode.value = newValue;
}

function changeDriftMode(mode: DriftMode): void {
  setDriftMode(mode);
  driftMode.value = mode;
}

function changeClientTiltEmaMode(mode: DriftMode): void {
  setClientTiltEmaMode(mode);
  clientTiltEmaMode.value = mode;
}

function toggleEdgeScroll(): void {
  const newValue = !edgeScrollEnabled.value;
  setEdgeScrollEnabled(newValue);
  edgeScrollEnabled.value = newValue;
}

function toggleDragPan(): void {
  const newValue = !dragPanEnabled.value;
  setDragPanEnabled(newValue);
  dragPanEnabled.value = newValue;
}

const allPanActive = computed(
  () => edgeScrollEnabled.value && dragPanEnabled.value,
);

function toggleAllPan(): void {
  const enable = !allPanActive.value;
  if (edgeScrollEnabled.value !== enable) toggleEdgeScroll();
  if (dragPanEnabled.value !== enable) toggleDragPan();
}

const SFX_CATEGORIES = SOUND_CATEGORIES.filter((c) => c !== 'music');

const allSoundsActive = computed(() =>
  SFX_CATEGORIES.every((cat) => soundToggles[cat]),
);

function toggleAllSounds(): void {
  const enable = !allSoundsActive.value;
  for (const cat of SFX_CATEGORIES) {
    if (soundToggles[cat] !== enable) toggleSoundCategory(cat);
  }
}

function toggleSoundCategory(category: SoundCategory): void {
  const newValue = !soundToggles[category];
  setSoundToggle(category, newValue);
  soundToggles[category] = newValue;
  // Stop active continuous sounds immediately when toggling off
  if (!newValue) {
    if (category === 'beam') audioManager.stopAllLaserSounds();
    if (category === 'field') audioManager.stopAllForceFieldSounds();
    if (category === 'music') musicPlayer.stop();
  }
  if (newValue && category === 'music') musicPlayer.start();
}

const SOUND_LABELS: Record<SoundCategory, string> = {
  fire: 'FIRE',
  hit: 'HIT',
  dead: 'DEAD',
  beam: 'BEAM',
  field: 'FIELD',
  music: 'MUSIC',
};

const SOUND_TOOLTIPS: Record<SoundCategory, string> = {
  fire: 'Weapon fire sounds',
  hit: 'Projectile hit sounds',
  dead: 'Unit death sounds',
  beam: 'Continuous beam sounds',
  field: 'Continuous force field sounds',
  music: 'Background music (procedural or MIDI)',
};

function updateClientTelemetryStats(): void {
  const scene = backgroundBattle?.gameInstance?.getScene() ?? gameInstance?.getScene();
  if (scene) {
    // Display camera altitude — distance from the y=0 ground plane
    // along its normal. Universal: same physical state → same number
    // regardless of pan / wheel-tick / target-y history. The wheel
    // clamp also rides on altitude (in OrbitCamera), so "min/max
    // zoom" matches what the user feels: at the floor you're grazing
    // the surface, at the ceiling you're at panoramic altitude. The
    // `zoom` ratio is still used internally for LOD + save/restore.
    setNumberRefIfChanged(currentZoom, scene.cameras.main.altitude ?? scene.cameras.main.zoom, 0.05);

    const timing = scene.getFrameTiming();
    setNumberRefIfChanged(frameMsAvg, timing.frameMsAvg);
    setNumberRefIfChanged(frameMsHi, timing.frameMsHi);
    setNumberRefIfChanged(renderMsAvg, timing.renderMsAvg);
    setNumberRefIfChanged(renderMsHi, timing.renderMsHi);
    setNumberRefIfChanged(logicMsAvg, timing.logicMsAvg);
    setNumberRefIfChanged(logicMsHi, timing.logicMsHi);
    setNumberRefIfChanged(gpuTimerMs, timing.gpuTimerMs);
    setRefIfChanged(gpuTimerSupported, timing.gpuTimerSupported);
    setNumberRefIfChanged(longtaskMsPerSec, timing.longtaskMsPerSec);
    setRefIfChanged(longtaskSupported, timing.longtaskSupported);

    const renderTpsStats = scene.getRenderTpsStats();
    setNumberRefIfChanged(renderTpsAvg, renderTpsStats.avgRate, 0.05);
    setNumberRefIfChanged(renderTpsWorst, renderTpsStats.worstRate, 0.05);

    const snapStats = scene.getSnapshotStats();
    setNumberRefIfChanged(snapAvgRate, snapStats.avgRate, 0.05);
    setNumberRefIfChanged(snapWorstRate, snapStats.worstRate, 0.05);
    const fullSnapStats = scene.getFullSnapshotStats();
    setNumberRefIfChanged(fullSnapAvgRate, fullSnapStats.avgRate, 0.05);
    setNumberRefIfChanged(fullSnapWorstRate, fullSnapStats.worstRate, 0.05);
  }
  const serverTpsVal = LOD_EMA_SOURCE.serverTps === 'avg' ? displayServerTpsAvg.value : displayServerTpsWorst.value;
  const renderTpsVal = LOD_EMA_SOURCE.renderTps === 'avg' ? renderTpsAvg.value : renderTpsWorst.value;
  setCurrentServerTpsRatio(serverTpsVal / GOOD_TPS);
  setCurrentRenderTpsRatio(renderTpsVal / GOOD_TPS);
  // UNITS auto-LOD reads (count, cap) from the server's snapshot
  // meta. The LOD ladder operates on `1 − count/cap` (fullness ratio)
  // so visual quality drops at the same proportional milestones
  // whether the cap is 1k or 16k. Pre-snapshot the count stays at
  // 0 (sparse world ⇒ MAX tier) and the cap falls back to the
  // bundled default until a real snapshot arrives.
  const meta = serverMetaFromSnapshot.value;
  setCurrentUnitCount(meta?.units.count ?? 0);
  if (meta?.units.max !== undefined) setCurrentUnitCap(meta.units.max);
  setServerTpsAvailable(showServerControls.value);
  setRefIfChanged(effectiveQuality, getEffectiveQuality());
}

function setupNetworkCallbacks(): void {
  networkManager.onPlayerJoined = (player: LobbyPlayer) => {
    networkNotice.value = null;
    upsertLobbyPlayer(player);
  };

  networkManager.onPlayerLeft = (playerId: PlayerId) => {
    // Resolve BEFORE removing from the roster — once the entry is
    // gone, resolvePlayerName falls back to the funny-default which
    // would not match the displayed name in the leaving notice.
    const playerName = resolvePlayerName(playerId);
    lobbyPlayers.value = lobbyPlayers.value.filter(
      (p) => p.playerId !== playerId,
    );
    removeRealBattleSnapshotListener(playerId);
    if (gameStarted.value) {
      networkNotice.value = `${playerName} disconnected`;
    }
  };

  networkManager.onPlayerAssignment = (playerId: PlayerId) => {
    networkNotice.value = null;
    localPlayerId.value = playerId;
    activePlayer.value = playerId;
  };

  networkManager.onGameStart = (handoff: BattleHandoff) => {
    networkNotice.value = null;
    roomCode.value = handoff.roomCode;
    lobbyPlayers.value = handoff.players.map((player) => ({ ...player }));
    if (handoff.settings) {
      applyLobbySettingsFromHost(handoff.settings, { restartPreview: false });
    }
    startGameWithPlayers(handoff.playerIds);
  };

  networkManager.onError = (error: string) => {
    lobbyError.value = error;
    networkNotice.value = error;
  };

  // Player IP + location reports flow in here for both the host
  // (own + every joining client's report) and clients (host
  // re-broadcast). Update the matching entry in lobbyPlayers so
  // the GAME LOBBY player list re-renders with the new columns.
  networkManager.onPlayerInfoUpdate = (player) => {
    if (player.playerId === localPlayerId.value && player.name) {
      localUsername.value = player.name;
    }
    upsertLobbyPlayer(player);
  };

  // Lobby-settings sync. The host registers a getter so the
  // network layer can grab fresh terrain values whenever a new
  // client joins (initial handshake push). Clients always write
  // these into the real-match namespace, even if the packet arrives
  // before `roomCode` flips the UI out of demo mode.
  networkManager.getLobbySettings = currentLobbySettings;
  networkManager.onLobbySettings = (settings) => {
    applyLobbySettingsFromHost(settings);
  };
}

function applyLobbySettingsFromHost(settings: {
  terrainCenter: TerrainShape;
  terrainDividers: TerrainShape;
  terrainMapShape: TerrainMapShape;
  mapWidthLandCells: number;
  mapLengthLandCells: number;
}, options: { restartPreview?: boolean } = {}): void {
  const changed =
    settings.terrainCenter !== terrainCenter.value ||
    settings.terrainDividers !== terrainDividers.value ||
    settings.terrainMapShape !== terrainMapShape.value ||
    settings.mapWidthLandCells !== mapWidthLandCells.value ||
    settings.mapLengthLandCells !== mapLengthLandCells.value;

  terrainCenter.value = settings.terrainCenter;
  terrainDividers.value = settings.terrainDividers;
  terrainMapShape.value = settings.terrainMapShape;
  mapWidthLandCells.value = settings.mapWidthLandCells;
  mapLengthLandCells.value = settings.mapLengthLandCells;
  saveTerrainCenter(settings.terrainCenter, 'real');
  saveTerrainDividers(settings.terrainDividers, 'real');
  saveTerrainMapShape(settings.terrainMapShape, 'real');
  saveMapLandDimensions(
    {
      widthLandCells: settings.mapWidthLandCells,
      lengthLandCells: settings.mapLengthLandCells,
    },
    'real',
  );
  setTerrainCenterShape(settings.terrainCenter);
  setTerrainDividersShape(settings.terrainDividers);
  setTerrainMapShape(settings.terrainMapShape);

  const restartPreview = options.restartPreview ?? true;
  if (restartPreview && changed && !gameStarted.value && currentBattleMode.value === 'real') {
    stopBackgroundBattle();
    nextTick(() => {
      startBackgroundBattle();
    });
  }
}

async function startGameWithPlayers(playerIds: PlayerId[], aiPlayerIds?: PlayerId[]): Promise<void> {
  showLobby.value = false;
  gameStarted.value = true;
  battleStartTime = Date.now();
  if (networkRole.value !== null) {
    localPlayerId.value = networkManager.getLocalPlayerId();
    activePlayer.value = localPlayerId.value;
  }

  // Stop the background battle first
  stopBackgroundBattle();
  clearRealBattleTimeouts();
  const startGen = realBattleStartGen;

  // Small delay to ensure WebGL cleanup before creating new game
  realBattleStartTimeout = setTimeout(async () => {
    realBattleStartTimeout = null;
    if (startGen !== realBattleStartGen || !containerRef.value) return;

    const rect = containerRef.value.getBoundingClientRect();

    let gameConnection: GameConnection;

    // Apply the real-match terrain before constructing either the
    // authoritative server or a remote client's renderer. The host
    // persisted this through lobbySettings, so clients must read the
    // same namespace before baking their terrain mesh.
    const realTerrainCenter = loadStoredTerrainCenter('real');
    const realTerrainDividers = loadStoredTerrainDividers('real');
    const realTerrainMapShape = loadStoredTerrainMapShape('real');
    const realMapDimensions = loadStoredMapLandDimensions('real');
    const realMapSize = getMapSize(
      false,
      realMapDimensions.widthLandCells,
      realMapDimensions.lengthLandCells,
    );
    setTerrainCenterShape(realTerrainCenter);
    setTerrainDividersShape(realTerrainDividers);
    setTerrainMapShape(realTerrainMapShape);

    if (networkRole.value !== 'client') {
      // Create GameServer for host/offline (WASM physics)
      const createdServer = await GameServer.create({
        playerIds,
        aiPlayerIds,
        terrainCenter: realTerrainCenter,
        terrainDividers: realTerrainDividers,
        terrainMapShape: realTerrainMapShape,
        mapWidthLandCells: realMapDimensions.widthLandCells,
        mapLengthLandCells: realMapDimensions.lengthLandCells,
      });
      if (startGen !== realBattleStartGen || !gameStarted.value || !containerRef.value) {
        createdServer.stop();
        return;
      }
      realBattleSnapshotListenerKeys.clear();
      currentServer = createdServer;

      // If hosting, send each remote client its own authoritative
      // real-battle snapshot. Scoped listeners let the server apply
      // per-recipient delta history and fidelity thresholds instead of
      // sharing one global diff history across peers.
      //
      // The PeerJS peer instance + every connection established
      // during the lobby phase persist into the real battle — we
      // never call `disconnect()` or `new Peer(...)` between the
      // two phases. So the host's `ba-${roomCode}` peer ID and the
      // existing client peer connections are the SAME identifiers
      // the lobby gameStart broadcast just used. Routing snapshots
      // to those connections continues to work; clients don't
      // re-handshake.
      //
      if (networkRole.value === 'host') {
        for (const playerId of networkManager.getConnectedPlayerIds()) {
          const trackingKey = currentServer.addSnapshotListener((state) => {
            const sent = networkManager.sendStateTo(playerId, state);
            if (!sent) currentServer?.forceNextSnapshotKeyframe();
          }, playerId);
          realBattleSnapshotListenerKeys.set(playerId, trackingKey);
        }

        // Receive commands from remote clients
        networkManager.onCommandReceived = (command, _fromPlayerId) => {
          currentServer?.receiveCommand(command);
        };
      }

      // Create LocalGameConnection for the local player. In hosted
      // real battles, scope the host's own client exactly like remote
      // clients so red uses the same per-recipient delta history and
      // fidelity thresholds as every other player.
      const localConnection = new LocalGameConnection(
        currentServer,
        networkRole.value === 'host' ? localPlayerId.value : undefined,
      );
      activeConnection = localConnection;
      gameConnection = localConnection;

      applyStoredBattleServerSettings(currentServer, 'real', {
        ipAddress: localIpAddress.value,
        maxTotalUnits: loadStoredRealCap(),
        simQuality: serverSimQuality.value,
        simSignalStates: serverSignalStates.value,
      });
      currentServer.start();
      if (networkRole.value === 'host') {
        const serverForRecoveryKeyframes = currentServer;
        for (const delayMs of [500, 1500]) {
          const timeout = setTimeout(() => {
            recoveryKeyframeTimeouts = recoveryKeyframeTimeouts.filter((item) => item !== timeout);
            if (startGen === realBattleStartGen && currentServer === serverForRecoveryKeyframes) {
              serverForRecoveryKeyframes.forceNextSnapshotKeyframe();
            }
          }, delayMs);
          recoveryKeyframeTimeouts.push(timeout);
        }
      }
      hasServer.value = true;
    } else {
      // Client: create RemoteGameConnection wrapping networkManager
      const remoteConnection = new RemoteGameConnection();
      activeConnection = remoteConnection;
      gameConnection = remoteConnection;
    }

    // Create ClientViewState once per game session.
    clientViewState = new ClientViewState();
    clientViewState.setMapDimensions(realMapSize.width, realMapSize.height);

    // Create game with player configuration
    gameInstance = createGame({
      parent: containerRef.value!,
      width: rect.width || window.innerWidth,
      height: rect.height || window.innerHeight,
      playerIds,
      localPlayerId: localPlayerId.value,
      gameConnection,
      clientViewState,
      mapWidth: realMapSize.width,
      mapHeight: realMapSize.height,
      terrainCenter: realTerrainCenter,
      terrainDividers: realTerrainDividers,
      terrainMapShape: realTerrainMapShape,
      backgroundMode: false,
      lookupPlayerName: (pid) => resolvePlayerName(pid, null),
    });
    setInstancePlayerClientEnabled(gameInstance, playerClientEnabled.value);

    // Setup scene callbacks
    setupSceneCallbacks();
  }, 100);
}

function setupSceneCallbacks(): void {
  checkSceneInterval = waitForSceneAndBind(
    () => gameInstance?.getScene(),
    (scene) => {
      scene.setClientRenderEnabled(playerClientEnabled.value);
      bindGameSceneUi(scene, true);
      checkSceneInterval = null;
    },
  );
}

function setNetworkUpdateRate(rate: SnapshotRate): void {
  activeConnection?.sendCommand({ type: 'setSnapshotRate', tick: 0, rate });
  saveSnapshotRate(rate);
}

function setTickRateValue(rate: TickRate): void {
  activeConnection?.sendCommand({ type: 'setTickRate', tick: 0, rate });
  saveTickRate(rate);
}

function setTiltEmaModeValue(mode: TiltEmaMode): void {
  activeConnection?.sendCommand({ type: 'setTiltEmaMode', tick: 0, mode });
  saveTiltEmaMode(mode);
  serverTiltEmaMode.value = mode;
}

/** Display labels for the TILT EMA bar. Keys stay as the canonical
 *  TiltEmaMode strings (storage / wire / config-table) so a future
 *  rename only touches this map. 'mid' renders as MED for visual
 *  symmetry with the surrounding 3-letter labels. */
const TILT_EMA_LABEL: Record<TiltEmaMode, string> = {
  snap: 'SNAP',
  fast: 'FAST',
  mid: 'MED',
  slow: 'SLOW',
};

function setSimQualityValue(q: ServerSimQuality): void {
  activeConnection?.sendCommand({ type: 'setSimQuality', tick: 0, quality: q });
  saveSimQuality(q);
  serverSimQuality.value = q;
}

// Tri-state click handler for the HOST SERVER signal buttons. Same
// shape as cycleClientSignal, but the canonical state lives on the
// server — we cycle locally for snappy UI, persist, and ship the
// resolved struct via setSimSignalStates command. Snapshot brings
// it back for non-host clients (see watcher below).
function cycleServerSignal(signal: keyof ServerSimSignalStates): void {
  const cur = serverSignalStates.value[signal];
  const next: SignalState =
    cur === 'off' ? 'active' : cur === 'active' ? 'solo' : 'off';
  const updated: ServerSimSignalStates = { ...serverSignalStates.value, [signal]: next };
  if (next === 'solo') {
    // Demote any other SOLO so only one signal is solo at a time.
    (Object.keys(updated) as (keyof ServerSimSignalStates)[]).forEach((k) => {
      if (k !== signal && updated[k] === 'solo') updated[k] = 'active';
    });
  }
  serverSignalStates.value = updated;
  saveSimSignalStates(updated);
  activeConnection?.sendCommand({
    type: 'setSimSignalStates',
    tick: 0,
    tps: updated.tps,
    cpu: updated.cpu,
    units: updated.units,
  });
}

function secPerFullsnap(ratio: number): string {
  const sps =
    displaySnapshotRate.value === 'none'
      ? displayTickRate.value
      : displaySnapshotRate.value;
  const sec = 1 / (sps * ratio);
  return `~1 fullsnap every ${+sec.toPrecision(2)}s`;
}

function setKeyframeRatioValue(ratio: KeyframeRatio): void {
  activeConnection?.sendCommand({ type: 'setKeyframeRatio', tick: 0, ratio });
  saveKeyframeRatio(ratio);
}

function toggleSendGridInfo(): void {
  const current = displayGridInfo.value;
  activeConnection?.sendCommand({
    type: 'setSendGridInfo',
    tick: 0,
    enabled: !current,
  });
  saveStoredGrid(currentBattleMode.value, !current);
}

function changeGridOverlay(mode: GridOverlay): void {
  setGridOverlay(mode);
  gridOverlay.value = mode;
}

function changeWaypointDetail(mode: WaypointDetail): void {
  setWaypointDetail(mode);
  waypointDetail.value = mode;
}

function dismissGameOver(): void {
  gameOverWinner.value = null;
}

function handleSoundTestKeydown(e: KeyboardEvent): void {
  if (e.key === '~') {
    showSoundTest.value = !showSoundTest.value;
  }
}

onMounted(() => {
  // Start the background battle behind the lobby
  nextTick(() => {
    startBackgroundBattle();
  });

  // Poll client/server telemetry for the bottom bars and AUTO LOD.
  clientTelemetryUpdateInterval = setInterval(updateClientTelemetryStats, 100);

  // Public IP + coarse location for the server bar AND the GAME
  // LOBBY player list. Avoid geo-IP providers that commonly return
  // browser-visible 403s; use ipify for the IP and derive the
  // readable location from the browser timezone.
  function deriveLocationFromTimezone(): string {
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (!tz) return '';
      const parts = tz.split('/');
      const tzCity = (parts[parts.length - 1] ?? '').replace(/_/g, ' ');
      const tzRegion = parts.length > 1 ? parts[0] : '';
      return [tzCity, tzRegion].filter((s) => s.length > 0).join(', ');
    } catch {
      return '';
    }
  }

  fetch('https://api.ipify.org?format=text')
    .then((r) => (r.ok ? r.text() : ''))
    .catch(() => '')
    .then((ipText) => {
      const ip = ipText.trim();
      const loc = deriveLocationFromTimezone();
      if (ip) {
        localIpAddress.value = ip;
        backgroundBattle?.server.setIpAddress(ip);
        currentServer?.setIpAddress(ip);
      }
      if (loc) localLocation.value = loc;
      // Fan out to peers so every player's row in the lobby has
      // populated IP + location + timezone columns. No-op when
      // not connected to a network session.
      networkManager.reportLocalPlayerInfo(
        ip || undefined,
        loc || undefined,
        localTimezone.value || undefined,
      );
    });

  // Update client time every second
  function updateClientTime() {
    clientTime.value = new Intl.DateTimeFormat('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
      timeZoneName: 'short',
    }).format(new Date());
    if (battleStartTime > 0) {
      battleElapsed.value = formatDuration(Date.now() - battleStartTime);
    } else {
      battleElapsed.value = '00:00:00';
    }
  }
  updateClientTime();
  clientTimeInterval = setInterval(updateClientTime, 1000);

  // Listen for backtick to toggle combat stats
  window.addEventListener('keydown', handleSoundTestKeydown);
});

onUnmounted(() => {
  clearRealBattleTimeouts();
  if (clientTelemetryUpdateInterval) {
    clearInterval(clientTelemetryUpdateInterval);
    clientTelemetryUpdateInterval = null;
  }
  if (checkSceneInterval) {
    clearInterval(checkSceneInterval);
    checkSceneInterval = null;
  }
  if (clientTimeInterval) {
    clearInterval(clientTimeInterval);
    clientTimeInterval = null;
  }
  if (checkBgSceneInterval) {
    clearInterval(checkBgSceneInterval);
    checkBgSceneInterval = null;
  }
  window.removeEventListener('keydown', handleSoundTestKeydown);
  // Stop servers
  if (currentServer) {
    clearRealBattleSnapshotListeners();
    currentServer.stop();
    currentServer = null;
  }
  networkManager.disconnect();
  stopBackgroundBattle();
  if (gameInstance) {
    destroyGame(gameInstance);
    gameInstance = null;
  }
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
           lands in the GAME LOBBY state (`inGameLobby` true), an
           imperative watcher (see script) re-parents this element
           into the lobby modal's `#lobby-preview-target` so the
           demo runs as a small preview pane. Vue Teleport was the
           obvious tool but its interaction with the demo battle's
           per-frame reactive updates triggered "Cannot set
           properties of null" patcher crashes on initial mount;
           an imperative move keeps Vue's vnode tree stable. -->
      <div
        ref="backgroundContainerRef"
        class="background-battle-container"
        v-show="!gameStarted"
      ></div>

      <!-- Main game container (real game) -->
      <div
        ref="containerRef"
        class="phaser-container"
        v-show="gameStarted"
      ></div>

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
        <!-- BATTLE CONTROLS — DEMO BATTLE only. The REAL BATTLE bar
             was retired: every config item it carried (UNITS, CAP,
             CENTER/DIVIDERS/PERIMETER, FF, SYSTEM) is now decided in
             the GAME LOBBY before the real battle starts and is locked
             in once the host clicks Start. The lobby modal carries
             matching controls; this bar stays clickable any time during
             the demo battle. `currentBattleMode === 'real'` covers both
             the lobby preview (modal already covers the bar) and the
             live real battle (bar simply hidden). -->
        <div
          v-if="showServerControls && currentBattleMode === 'demo'"
          class="control-bar"
          :class="{ 'bar-readonly': serverBarReadonly }"
          :style="battleBarVars"
        >
        <div class="bar-info">
          <BarButton
            :active="true"
            class="bar-label"
            title="Click to reset battle settings to defaults"
            @click="resetDemoDefaults"
          >
            <span class="bar-label-text">{{ battleLabel }}</span
            ><span class="bar-label-hover">DEFAULTS</span>
          </BarButton>
        </div>
        <BarDivider />
        <div class="bar-controls">
          <span class="time-display" title="Battle elapsed time">{{
            battleElapsed
          }}</span>
          <BarDivider />
          <BarControlGroup>
            <BarLabel>UNITS:</BarLabel>
            <BarButton
              :active="allDemoUnitsActive"
              title="Toggle all unit types on/off"
              @click="toggleAllDemoUnits"
            >ALL</BarButton>
            <BarButtonGroup>
              <BarButton
                v-for="ut in demoUnitTypes"
                :key="ut"
                :active="currentAllowedUnits.includes(ut)"
                :title="`Toggle ${ut} units in demo battle`"
                @click="toggleDemoUnitType(ut)"
              >{{ getUnitBlueprint(ut).shortName }}</BarButton>
            </BarButtonGroup>
          </BarControlGroup>
          <BarControlGroup>
            <BarDivider />
            <BarLabel>CAP:</BarLabel>
            <BarButtonGroup>
              <BarButton
                v-for="opt in BATTLE_CONFIG.cap.options"
                :key="opt"
                :active="displayUnitCap === opt"
                :title="`Max ${opt} total units`"
                @click="changeMaxTotalUnits(opt)"
              >{{ opt.toLocaleString() }}</BarButton>
            </BarButtonGroup>
          </BarControlGroup>
          <!-- CENTER / DIVIDERS only in DEMO BATTLE — terrain is baked
               into the heightmap at game construction, so changing it
               mid-real-battle would desync against the rendered tile
               mesh. Lobby modal owns the SAME components for these
               controls (BarControlGroup + BarButtonGroup + BarButton),
               so the bottom-bar's pre-game terrain pickers and the
               GAME LOBBY's pre-game terrain pickers render from one
               component tree — single source of truth. -->
          <BarControlGroup v-if="!gameStarted">
            <BarDivider />
            <BarLabel>WIDTH:</BarLabel>
            <BarButtonGroup>
              <BarButton
                v-for="opt in BATTLE_CONFIG.mapSize.width.options"
                :key="opt.label"
                :active="mapWidthLandCells === opt.valueLandCells"
                :title="`Set map width to ${opt.label} land cells`"
                @click="applyMapLandDimensions({ widthLandCells: opt.valueLandCells, lengthLandCells: mapLengthLandCells })"
              >{{ opt.label }}</BarButton>
            </BarButtonGroup>
          </BarControlGroup>
          <BarControlGroup v-if="!gameStarted">
            <BarDivider />
            <BarLabel>LENGTH:</BarLabel>
            <BarButtonGroup>
              <BarButton
                v-for="opt in BATTLE_CONFIG.mapSize.length.options"
                :key="opt.label"
                :active="mapLengthLandCells === opt.valueLandCells"
                :title="`Set map length to ${opt.label} land cells`"
                @click="applyMapLandDimensions({ widthLandCells: mapWidthLandCells, lengthLandCells: opt.valueLandCells })"
              >{{ opt.label }}</BarButton>
            </BarButtonGroup>
          </BarControlGroup>
          <BarControlGroup v-if="!gameStarted">
            <BarDivider />
            <BarLabel>CENTER:</BarLabel>
            <BarButtonGroup>
              <BarButton
                v-for="opt in BATTLE_CONFIG.center.options"
                :key="opt.value"
                :active="terrainCenter === opt.value"
                :title="`Set the central ripple to ${opt.label.toLowerCase()}`"
                @click="applyTerrainShape('center', opt.value)"
              >{{ opt.label }}</BarButton>
            </BarButtonGroup>
          </BarControlGroup>
          <BarControlGroup v-if="!gameStarted">
            <BarDivider />
            <BarLabel>DIVIDERS:</BarLabel>
            <BarButtonGroup>
              <BarButton
                v-for="opt in BATTLE_CONFIG.dividers.options"
                :key="opt.value"
                :active="terrainDividers === opt.value"
                :title="`Set the team-separator ridges to ${opt.label.toLowerCase()}`"
                @click="applyTerrainShape('dividers', opt.value)"
              >{{ opt.label }}</BarButton>
            </BarButtonGroup>
          </BarControlGroup>
          <BarControlGroup v-if="!gameStarted">
            <BarDivider />
            <BarLabel>PERIMETER:</BarLabel>
            <BarButtonGroup>
              <BarButton
                v-for="opt in BATTLE_CONFIG.mapShape.options"
                :key="opt.value"
                :active="terrainMapShape === opt.value"
                :title="`Set the map perimeter to ${opt.label.toLowerCase()}`"
                @click="applyTerrainMapShape(opt.value)"
              >{{ opt.label }}</BarButton>
            </BarButtonGroup>
          </BarControlGroup>
          <BarControlGroup>
            <BarDivider />
            <BarLabel title="Total units alive / unit cap">UNITS:</BarLabel>
            <div class="stat-bar-group">
              <div class="stat-bar">
                <div class="stat-bar-top">
                  <span class="fps-value">{{ displayUnitCount }}</span>
                  <span class="fps-label">/ {{ displayUnitCap }}</span>
                </div>
                <div class="stat-bar-track">
                  <div
                    class="stat-bar-fill"
                    :style="statBarStyle(displayUnitCount, displayUnitCap)"
                  ></div>
                </div>
              </div>
            </div>
          </BarControlGroup>
          <BarControlGroup>
            <BarDivider />
            <BarLabel>SYSTEM:</BarLabel>
            <BarButtonGroup>
              <BarButton
                :active="currentMirrorsEnabled"
                title="Enable mirror turrets and laser/beam reflections"
                @click="setMirrorsEnabled(!currentMirrorsEnabled)"
              >MIRROR</BarButton>
              <BarButton
                :active="currentForceFieldsEnabled"
                title="Enable force-field turrets, force-field simulation, and force-field rendering"
                @click="setForceFieldsEnabled(!currentForceFieldsEnabled)"
              >FIELD</BarButton>
            </BarButtonGroup>
          </BarControlGroup>
        </div>
      </div>

      <!-- SERVER CONTROLS (visible when we own a server or receive server meta) -->
      <div
        v-if="showServerControls"
        class="control-bar"
        :class="{ 'bar-readonly': serverBarReadonly }"
        :style="serverBarVars"
      >
        <div class="bar-info">
          <BarButton
            :active="true"
            class="bar-label"
            title="Click to reset server settings to defaults"
            @click="resetServerDefaults"
          >
            <span class="bar-label-text">HOST SERVER</span
            ><span class="bar-label-hover">DEFAULTS</span>
          </BarButton>
        </div>
        <BarDivider />
        <div class="bar-controls">
          <span
            v-if="displayServerTime"
            class="time-display"
            title="Server wall-clock time"
            >{{ displayServerTime }}</span
          >
          <span
            v-if="displayServerIp"
            class="ip-display"
            title="Server IP address"
            >{{ displayServerIp }}</span
          >
          <BarDivider />
          <BarControlGroup>
            <BarLabel>TARGET TPS:</BarLabel>
            <BarButtonGroup>
              <BarButton
                v-for="rate in SERVER_CONFIG.tickRate.options"
                :key="rate"
                :active="displayTargetTickRate === rate"
                :active-level="displayTickRate === rate && displayTargetTickRate !== rate"
                :title="`Target ${rate} simulation ticks per second. Effective TPS cap is currently ${displayTickRate}.`"
                @click="setTickRateValue(rate)"
              >{{ rate }}</BarButton>
            </BarButtonGroup>
          </BarControlGroup>
          <BarDivider />
          <BarControlGroup>
            <BarLabel title="Per-unit chassis-tilt EMA. SNAP = no smoothing (raw triangle-jump), FAST/MED/SLOW progressively heavier blending. Drives the sim's updateUnitTilt half-life.">TILT EMA:</BarLabel>
            <BarButtonGroup>
              <BarButton
                v-for="mode in SERVER_CONFIG.tiltEma.options"
                :key="mode"
                :active="serverTiltEmaMode === mode"
                :title="`Set chassis-tilt EMA to ${TILT_EMA_LABEL[mode]}.`"
                @click="setTiltEmaModeValue(mode)"
              >{{ TILT_EMA_LABEL[mode] }}</BarButton>
            </BarButtonGroup>
          </BarControlGroup>
          <BarControlGroup>
            <BarDivider />
            <BarLabel title="Server simulation ticks per second">S-TPS:</BarLabel>
            <div class="stat-bar-group">
              <div class="stat-bar">
                <div class="stat-bar-top">
                  <span class="fps-value">{{ fmt4(displayServerTpsAvg) }}</span>
                  <span class="fps-label">avg</span>
                </div>
                <div class="stat-bar-track">
                  <div
                    class="stat-bar-fill"
                    :style="
                      statBarStyle(displayServerTpsAvg, GOOD_TPS, serverBarReadonly)
                    "
                  ></div>
                </div>
              </div>
              <div class="stat-bar">
                <div class="stat-bar-top">
                  <span class="fps-value">{{
                    fmt4(displayServerTpsWorst)
                  }}</span>
                  <span class="fps-label">low</span>
                </div>
                <div class="stat-bar-track">
                  <div
                    class="stat-bar-fill"
                    :style="
                      statBarStyle(displayServerTpsWorst, GOOD_TPS, serverBarReadonly)
                    "
                  ></div>
                </div>
              </div>
            </div>
          </BarControlGroup>
          <!--
            Host CPU load: how much of each tick's budget (1000 / tickRate
            ms) the sim actually spent working. Ticked here as avg + hi,
            same semantics as the client CPU/GPU bars. >100 means the host
            is falling behind the target TPS.
          -->
          <BarControlGroup>
            <BarDivider />
            <BarLabel title="Host CPU load — simulation tick time as a percent of the target tick budget. >100% means the host is falling behind.">CPU:</BarLabel>
            <div class="stat-bar-group">
              <div class="stat-bar">
                <div class="stat-bar-top">
                  <span class="fps-value">{{ fmt4(displayServerCpuAvg) }}%</span>
                  <span class="fps-label">avg</span>
                </div>
                <div class="stat-bar-track">
                  <div
                    class="stat-bar-fill"
                    :style="msBarStyle(displayServerCpuAvg, 100)"
                  ></div>
                </div>
              </div>
              <div class="stat-bar">
                <div class="stat-bar-top">
                  <span class="fps-value">{{ fmt4(displayServerCpuHi) }}%</span>
                  <span class="fps-label">hi</span>
                </div>
                <div class="stat-bar-track">
                  <div
                    class="stat-bar-fill"
                    :style="msBarStyle(displayServerCpuHi, 100)"
                  ></div>
                </div>
              </div>
            </div>
          </BarControlGroup>
          <BarControlGroup>
            <BarDivider />
            <BarLabel>TARGET SPS:</BarLabel>
            <BarButtonGroup>
              <BarButton
                v-for="rate in SERVER_CONFIG.snapshot.options"
                :key="String(rate)"
                :active="displaySnapshotRate === rate"
                :title="`Cap snapshots at ${rate === 'none' ? 'no limit (every tick)' : rate + '/sec'}`"
                @click="setNetworkUpdateRate(rate)"
              >{{ rate === 'none' ? 'NONE' : (rate as number) }}</BarButton>
            </BarButtonGroup>
          </BarControlGroup>
          <BarControlGroup>
            <BarDivider />
            <BarLabel>FULLSNAP:</BarLabel>
            <BarButtonGroup>
              <BarButton
                v-for="opt in SERVER_CONFIG.keyframe.options"
                :key="String(opt)"
                :active="displayKeyframeRatio === opt"
                :title="
                  opt === 'ALL'
                    ? 'Every snapshot is a full keyframe'
                    : opt === 'NONE'
                      ? 'Never send full keyframes (delta only)'
                      : secPerFullsnap(opt as number)
                "
                @click="setKeyframeRatioValue(opt)"
              >{{
                opt === 'ALL'
                  ? 'ALL'
                  : opt === 'NONE'
                    ? 'NONE'
                    : `1e-${Math.round(-Math.log10(opt as number))}`
              }}</BarButton>
            </BarButtonGroup>
          </BarControlGroup>
          <BarControlGroup>
            <BarDivider />
            <BarLabel>LOD:</BarLabel>
            <BarButton
              :active="serverSimQuality === 'auto' && !serverAnySolo"
              :active-level="serverSimQuality === 'auto' && serverAnySolo"
              title="Auto-adjust sim throttling (lowest of TPS, CPU, units)"
              @click="setSimQualityValue('auto')"
            >AUTO</BarButton>
            <BarButtonGroup>
              <BarButton
                v-if="SERVER_SIM_LOD_SIGNALS_ENABLED.tps"
                :active="serverSimQuality === 'auto' && serverSignalStates.tps === 'solo'"
                :active-level="
                  serverSimQuality === 'auto'
                    && serverSignalStates.tps === 'active'
                    && !serverAnySolo
                "
                :title="`Server TPS signal — click to cycle off / active / solo. Currently ${serverSignalStates.tps}.`"
                @click="cycleServerSignal('tps')"
              >TPS</BarButton>
              <BarButton
                v-if="SERVER_SIM_LOD_SIGNALS_ENABLED.cpu"
                :active="serverSimQuality === 'auto' && serverSignalStates.cpu === 'solo'"
                :active-level="
                  serverSimQuality === 'auto'
                    && serverSignalStates.cpu === 'active'
                    && !serverAnySolo
                "
                :title="`Host CPU load signal — click to cycle off / active / solo. Currently ${serverSignalStates.cpu}.`"
                @click="cycleServerSignal('cpu')"
              >CPU</BarButton>
              <BarButton
                v-if="SERVER_SIM_LOD_SIGNALS_ENABLED.units"
                :active="serverSimQuality === 'auto' && serverSignalStates.units === 'solo'"
                :active-level="
                  serverSimQuality === 'auto'
                    && serverSignalStates.units === 'active'
                    && !serverAnySolo
                "
                :title="`World fullness signal — click to cycle off / active / solo. Currently ${serverSignalStates.units}.`"
                @click="cycleServerSignal('units')"
              >UNITS</BarButton>
            </BarButtonGroup>
            <BarButtonGroup>
              <BarButton
                v-for="opt in CLIENT_CONFIG.graphics.options"
                :key="opt.value"
                :active="serverSimQuality === opt.value"
                :active-level="
                  effectiveSimQuality === opt.value &&
                  serverSimQuality !== opt.value
                "
                :title="`Lock sim throttling to ${opt.value} tier`"
                @click="setSimQualityValue(opt.value)"
              >{{ opt.label }}</BarButton>
            </BarButtonGroup>
          </BarControlGroup>
        </div>
      </div>

      <!-- CLIENT CONTROLS (always visible) -->
      <div class="control-bar" :style="clientBarVars">
        <div class="bar-info">
          <BarButton
            :active="true"
            class="bar-label"
            title="Click to reset client settings to defaults"
            @click="resetClientDefaults"
          >
            <span class="bar-label-text">PLAYER CLIENT</span
            ><span class="bar-label-hover">DEFAULTS</span>
          </BarButton>
          <BarButton
            :active="playerClientEnabled"
            class="client-power-button"
            :title="playerClientEnabled ? 'Turn PLAYER CLIENT game rendering off' : 'Turn PLAYER CLIENT game rendering on'"
            @click="togglePlayerClientEnabled"
          >{{ playerClientEnabled ? 'ON' : 'OFF' }}</BarButton>
        </div>
        <BarDivider />
        <div class="bar-controls">
          <span
            v-if="displayedClientTime"
            class="time-display"
            title="Host-propagated client wall-clock time"
            >{{ displayedClientTime }}</span
          >
          <span
            v-if="displayedClientIp"
            class="ip-display"
            title="Host-propagated public IP address"
            >{{ displayedClientIp }}</span
          >
          <BarDivider />
          <BarControlGroup>
            <BarLabel>GRID:</BarLabel>
            <BarButtonGroup>
              <BarButton
                v-for="opt in CLIENT_CONFIG.gridOverlay.options"
                :key="opt.value"
                :active="gridOverlay === opt.value"
                title="Territory capture overlay intensity"
                @click="changeGridOverlay(opt.value)"
              >{{ opt.label }}</BarButton>
            </BarButtonGroup>
          </BarControlGroup>
          <BarControlGroup>
            <BarDivider />
            <BarLabel>WAYPOINTS:</BarLabel>
            <BarButtonGroup>
              <BarButton
                v-for="opt in CLIENT_CONFIG.waypointDetail.options"
                :key="opt.value"
                :active="waypointDetail === opt.value"
                title="Waypoint visualization — SIMPLE shows only your click points; DETAILED shows the planner's intermediates too"
                @click="changeWaypointDetail(opt.value)"
              >{{ opt.label }}</BarButton>
            </BarButtonGroup>
          </BarControlGroup>
          <BarDivider />
          <!--
            Bottleneck-first ordering: CPU (sim/update work) then GPU (real
            execution time if the EXT_disjoint_timer_query_webgl2 extension
            is available, otherwise renderer.render() wall-clock), then
            FRAME (total), then LONG (main-thread blocks ≥50 ms from the
            Longtask API). Raw ms throughout — no arbitrary 100%.
          -->
          <BarControlGroup>
            <BarLabel title="Client CPU — simulation prediction, input, HUD updates. Raw logicMs avg/hi in milliseconds per frame.">CPU:</BarLabel>
            <div class="stat-bar-group">
              <div class="stat-bar">
                <div class="stat-bar-top">
                  <span class="fps-value">{{ fmt4(logicMsAvg) }}</span>
                  <span class="fps-label">avg</span>
                </div>
                <div class="stat-bar-track">
                  <div class="stat-bar-fill" :style="msBarStyle(logicMsAvg)"></div>
                </div>
              </div>
              <div class="stat-bar">
                <div class="stat-bar-top">
                  <span class="fps-value">{{ fmt4(logicMsHi) }}</span>
                  <span class="fps-label">hi</span>
                </div>
                <div class="stat-bar-track">
                  <div class="stat-bar-fill" :style="msBarStyle(logicMsHi)"></div>
                </div>
              </div>
            </div>
          </BarControlGroup>
          <BarControlGroup>
            <BarLabel :title="`Client GPU — source: ${gpuSourceLabel}. Raw renderMs avg/hi ${fmt4(renderMsAvg)} / ${fmt4(renderMsHi)} ms. Timer-query (when supported) shows the actual GPU-side execution time in milliseconds; otherwise shows renderer.render() wall-clock which is mostly CPU draw-call submission.`">GPU:</BarLabel>
            <div class="stat-bar-group">
              <div class="stat-bar">
                <div class="stat-bar-top">
                  <span class="fps-value">{{ fmt4(displayGpuMs) }}</span>
                  <span class="fps-label">
                    {{ gpuTimerSupported ? 'hw' : 'cpu' }}
                  </span>
                </div>
                <div class="stat-bar-track">
                  <div class="stat-bar-fill" :style="msBarStyle(displayGpuMs)"></div>
                </div>
              </div>
              <div class="stat-bar">
                <div class="stat-bar-top">
                  <span class="fps-value">{{ fmt4(renderMsHi) }}</span>
                  <span class="fps-label">hi</span>
                </div>
                <div class="stat-bar-track">
                  <div class="stat-bar-fill" :style="msBarStyle(renderMsHi)"></div>
                </div>
              </div>
            </div>
          </BarControlGroup>
          <BarControlGroup>
            <BarLabel title="Total frame time — CPU + GPU wall-clock per frame (ms)">FRAME:</BarLabel>
            <div class="stat-bar-group">
              <div class="stat-bar">
                <div class="stat-bar-top">
                  <span class="fps-value">{{ fmt4(frameMsAvg) }}</span>
                  <span class="fps-label">avg</span>
                </div>
                <div class="stat-bar-track">
                  <div class="stat-bar-fill" :style="msBarStyle(frameMsAvg)"></div>
                </div>
              </div>
              <div class="stat-bar">
                <div class="stat-bar-top">
                  <span class="fps-value">{{ fmt4(frameMsHi) }}</span>
                  <span class="fps-label">hi</span>
                </div>
                <div class="stat-bar-track">
                  <div class="stat-bar-fill" :style="msBarStyle(frameMsHi)"></div>
                </div>
              </div>
            </div>
          </BarControlGroup>
          <BarControlGroup v-if="longtaskSupported">
            <!--
              Longtask API: any single main-thread task ≥50 ms counts. This
              shows how many ms per second of wall-clock time were "lost"
              to those long tasks — a direct CPU-saturation indicator that
              complements CPU ms (which can't distinguish sustained heavy
              work from a single giant stall). Scaled to 200 ms/sec = red
              (20% of wall-clock blocked).
            -->
            <BarLabel title="Long-task blocked time from PerformanceObserver — ms per second of wall-clock time lost to main-thread tasks ≥50 ms. 0 = smooth; 200+ = heavy main-thread contention. Not available in Safari.">LONG:</BarLabel>
            <div class="stat-bar-group">
              <div class="stat-bar">
                <div class="stat-bar-top">
                  <span class="fps-value">{{ fmt4(longtaskMsPerSec) }}</span>
                  <span class="fps-label">ms/s</span>
                </div>
                <div class="stat-bar-track">
                  <div
                    class="stat-bar-fill"
                    :style="msBarStyle(longtaskMsPerSec, 200)"
                  ></div>
                </div>
              </div>
            </div>
          </BarControlGroup>
          <BarDivider />
          <BarControlGroup>
            <BarLabel title="PLAYER CLIENT update-loop ticks per second. This includes prediction/input/render prep cadence and is the client-side TPS signal for LOD.">R-TPS:</BarLabel>
            <div class="stat-bar-group">
              <div class="stat-bar">
                <div class="stat-bar-top">
                  <span class="fps-value">{{ fmt4(renderTpsAvg) }}</span>
                  <span class="fps-label">avg</span>
                </div>
                <div class="stat-bar-track">
                  <div
                    class="stat-bar-fill"
                    :style="statBarStyle(renderTpsAvg, GOOD_TPS)"
                  ></div>
                </div>
              </div>
              <div class="stat-bar">
                <div class="stat-bar-top">
                  <span class="fps-value">{{ fmt4(renderTpsWorst) }}</span>
                  <span class="fps-label">low</span>
                </div>
                <div class="stat-bar-track">
                  <div
                    class="stat-bar-fill"
                    :style="statBarStyle(renderTpsWorst, GOOD_TPS)"
                  ></div>
                </div>
              </div>
            </div>
          </BarControlGroup>
          <BarControlGroup>
            <BarDivider />
            <div class="fps-stats">
              <BarLabel title="Camera altitude (world units, distance from the ground plane). Smaller = closer to surface. Wheel clamp rides on altitude too — at the floor / ceiling you're at the actual physical limit, no more 'stuck' states.">ZOOM:</BarLabel>
              <span class="fps-value">{{ fmt4(currentZoom) }}</span>
            </div>
          </BarControlGroup>
          <BarControlGroup>
            <BarDivider />
            <BarLabel title="Snapshots received per second from server">SPS:</BarLabel>
            <div class="stat-bar-group">
              <div class="stat-bar">
                <div class="stat-bar-top">
                  <span class="fps-value">{{ fmt4(snapAvgRate) }}</span>
                  <span class="fps-label">avg</span>
                </div>
                <div class="stat-bar-track">
                  <div
                    class="stat-bar-fill"
                    :style="
                      statBarStyle(
                        snapAvgRate,
                        displaySnapshotRate === 'none'
                          ? 60
                          : displaySnapshotRate,
                      )
                    "
                  ></div>
                </div>
              </div>
              <div class="stat-bar">
                <div class="stat-bar-top">
                  <span class="fps-value">{{ fmt4(snapWorstRate) }}</span>
                  <span class="fps-label">low</span>
                </div>
                <div class="stat-bar-track">
                  <div
                    class="stat-bar-fill"
                    :style="
                      statBarStyle(
                        snapWorstRate,
                        displaySnapshotRate === 'none'
                          ? 60
                          : displaySnapshotRate,
                      )
                    "
                  ></div>
                </div>
              </div>
            </div>
          </BarControlGroup>
          <!-- FSPS — full snapshots per second. Counts only keyframes
               (state.isDelta === false). The bar is scaled by the host's
               configured keyframeRatio × snapshotRate so a healthy
               host fills the bar. A high reading means the protocol
               is re-seeding statics often (catch-up cheap, late-joiner
               friendly); a low reading saves bandwidth at the cost of
               longer recovery if a delta gets lost. -->
          <BarControlGroup>
            <BarDivider />
            <BarLabel title="Full keyframe snapshots received per second (state.isDelta === false). Driven by the host's keyframe ratio.">FSPS:</BarLabel>
            <div class="stat-bar-group">
              <div class="stat-bar">
                <div class="stat-bar-top">
                  <span class="fps-value">{{ fmt4(fullSnapAvgRate) }}</span>
                  <span class="fps-label">avg</span>
                </div>
                <div class="stat-bar-track">
                  <div
                    class="stat-bar-fill"
                    :style="statBarStyle(fullSnapAvgRate, fullSnapBarTarget)"
                  ></div>
                </div>
              </div>
              <div class="stat-bar">
                <div class="stat-bar-top">
                  <span class="fps-value">{{ fmt4(fullSnapWorstRate) }}</span>
                  <span class="fps-label">low</span>
                </div>
                <div class="stat-bar-track">
                  <div
                    class="stat-bar-fill"
                    :style="statBarStyle(fullSnapWorstRate, fullSnapBarTarget)"
                  ></div>
                </div>
              </div>
            </div>
          </BarControlGroup>
          <BarControlGroup>
            <BarDivider />
            <BarLabel>EVENTS:</BarLabel>
            <BarButton
              :active="audioSmoothing"
              title="Smooth one-shot events and turret projectile spawns across snapshot intervals"
              @click="toggleAudioSmoothing"
            >SMOOTH</BarButton>
          </BarControlGroup>
          <BarControlGroup>
            <BarDivider />
            <BarLabel>MARKS:</BarLabel>
            <BarButton
              :active="burnMarks"
              title="Draw scorch marks on the ground where beams and lasers hit"
              @click="toggleBurnMarks"
            >BURN</BarButton>
          </BarControlGroup>
          <BarControlGroup>
            <BarDivider />
            <BarLabel>DRIFT:</BarLabel>
            <BarButtonGroup>
              <BarButton
                :active="driftMode === 'snap'"
                title="Snap instantly to new server state"
                @click="changeDriftMode('snap')"
              >SNAP</BarButton>
              <BarButton
                :active="driftMode === 'fast'"
                title="Fast interpolation to server state"
                @click="changeDriftMode('fast')"
              >FAST</BarButton>
              <BarButton
                :active="driftMode === 'mid'"
                title="Medium interpolation to server state"
                @click="changeDriftMode('mid')"
              >MID</BarButton>
              <BarButton
                :active="driftMode === 'slow'"
                title="Slow interpolation to server state"
                @click="changeDriftMode('slow')"
              >SLOW</BarButton>
            </BarButtonGroup>
          </BarControlGroup>
          <BarControlGroup>
            <BarDivider />
            <BarLabel title="Per-frame chassis-tilt EMA on the client. Layered on top of the HOST SERVER TILT EMA — sim smooths first, then this knob smooths further at render cadence.">TILT EMA:</BarLabel>
            <BarButtonGroup>
              <BarButton
                v-for="opt in CLIENT_CONFIG.tiltEma.options"
                :key="opt.value"
                :active="clientTiltEmaMode === opt.value"
                :title="`Set client-side chassis-tilt EMA to ${opt.label}.`"
                @click="changeClientTiltEmaMode(opt.value)"
              >{{ opt.label }}</BarButton>
            </BarButtonGroup>
          </BarControlGroup>
          <BarControlGroup>
            <BarDivider />
            <BarLabel>PAN:</BarLabel>
            <BarButton
              :active="allPanActive"
              title="Toggle all camera pan methods on/off"
              @click="toggleAllPan"
            >ALL</BarButton>
            <BarButtonGroup>
              <BarButton
                :active="dragPanEnabled"
                title="Middle-click drag to pan camera"
                @click="toggleDragPan"
              >DRAG</BarButton>
              <BarButton
                :active="edgeScrollEnabled"
                title="Edge scroll — move camera when mouse near viewport border"
                @click="toggleEdgeScroll"
              >EDGE</BarButton>
            </BarButtonGroup>
          </BarControlGroup>
          <BarControlGroup>
            <BarDivider />
            <BarLabel>LOD:</BarLabel>
            <BarButton
              :active="graphicsQuality === 'auto' && !clientAnySolo"
              :active-level="graphicsQuality === 'auto' && clientAnySolo"
              title="Auto-adjust graphics quality from the lowest active client signal"
              @click="changeGraphicsQuality('auto')"
            >AUTO</BarButton>
            <BarButtonGroup>
              <BarButton
                v-if="LOD_SIGNALS_ENABLED.zoom"
                :active="graphicsQuality === 'auto' && clientSignalStates.zoom === 'solo'"
                :active-level="
                  graphicsQuality === 'auto'
                    && clientSignalStates.zoom === 'active'
                    && !clientAnySolo
                "
                :title="`Zoom signal — click to cycle off / active / solo. Currently ${clientSignalStates.zoom}.`"
                @click="cycleClientSignal('zoom')"
              >ZOOM</BarButton>
              <BarButton
                v-if="LOD_SIGNALS_ENABLED.serverTps"
                :active="graphicsQuality === 'auto' && clientSignalStates.serverTps === 'solo'"
                :active-level="
                  graphicsQuality === 'auto'
                    && clientSignalStates.serverTps === 'active'
                    && !clientAnySolo
                    && showServerControls
                "
                :title="`Server TPS signal — click to cycle off / active / solo. Currently ${clientSignalStates.serverTps}.`"
                @click="cycleClientSignal('serverTps')"
              >S-TPS</BarButton>
              <BarButton
                v-if="LOD_SIGNALS_ENABLED.renderTps"
                :active="graphicsQuality === 'auto' && clientSignalStates.renderTps === 'solo'"
                :active-level="
                  graphicsQuality === 'auto'
                    && clientSignalStates.renderTps === 'active'
                    && !clientAnySolo
                "
                :title="`Render TPS signal — click to cycle off / active / solo. Currently ${clientSignalStates.renderTps}.`"
                @click="cycleClientSignal('renderTps')"
              >R-TPS</BarButton>
              <BarButton
                v-if="LOD_SIGNALS_ENABLED.units"
                :active="graphicsQuality === 'auto' && clientSignalStates.units === 'solo'"
                :active-level="
                  graphicsQuality === 'auto'
                    && clientSignalStates.units === 'active'
                    && !clientAnySolo
                "
                :title="`World fullness signal — click to cycle off / active / solo. Currently ${clientSignalStates.units}.`"
                @click="cycleClientSignal('units')"
              >UNITS</BarButton>
            </BarButtonGroup>
            <BarButtonGroup>
              <BarButton
                v-for="opt in CLIENT_CONFIG.graphics.options"
                :key="opt.value"
                :active="graphicsQuality === opt.value"
                :active-level="
                  effectiveQuality === opt.value &&
                  graphicsQuality !== opt.value
                "
                :title="`${opt.value} graphics quality`"
                @click="changeGraphicsQuality(opt.value)"
              >{{ opt.label }}</BarButton>
            </BarButtonGroup>
            <BarButton
              :active="baseLodMode"
              title="BASE — when ON, the chosen MIN/LOW/MED/HI/MAX tier applies UNIFORMLY to every entity (camera-sphere distance resolution disabled). When OFF, tiers cap a per-entity object-tier resolved from camera distance, so close units render richer than far units."
              @click="toggleBaseLodMode"
            >BASE</BarButton>
            <BarButton
              :active="lodShellRings"
              title="Show object-LOD shell intersections on the terrain around the camera"
              @click="toggleLodShellRings"
            >RINGS</BarButton>
            <BarButton
              :active="lodGridBorders"
              title="Show object-LOD spatial grid tiles as 2D ground-plane outlines"
              @click="toggleLodGridBorders"
            >CELLS</BarButton>
            <BarButton
              :active="triangleDebug"
              title="TRIS — debug-color every terrain/mana mesh triangle so triangle reduction and flat-tile optimization are visually obvious"
              @click="toggleTriangleDebug"
            >TRIS</BarButton>
            <BarButton
              :active="buildGridDebug"
              title="BUILD — show every fine build-placement cell using the same green/red/blue colors as the building ghost"
              @click="toggleBuildGridDebug"
            >BUILD</BarButton>
          </BarControlGroup>
          <BarControlGroup>
            <BarDivider />
            <BarLabel>RENDER:</BarLabel>
            <BarButtonGroup>
              <BarButton
                v-for="opt in CLIENT_CONFIG.render.options"
                :key="opt.value"
                :active="renderMode === opt.value"
                :title="
                  opt.value === 'window'
                    ? 'Render only visible window'
                    : opt.value === 'padded'
                      ? 'Render window plus padding'
                      : 'Render entire map'
                "
                @click="changeRenderMode(opt.value)"
              >{{ opt.label }}</BarButton>
            </BarButtonGroup>
          </BarControlGroup>
          <BarControlGroup>
            <BarDivider />
            <BarLabel>AUDIO:</BarLabel>
            <BarButtonGroup>
              <BarButton
                v-for="opt in CLIENT_CONFIG.audio.options"
                :key="opt.value"
                :active="audioScope === opt.value"
                :title="
                  opt.value === 'window'
                    ? 'Play audio from visible area'
                    : opt.value === 'padded'
                      ? 'Play audio from visible area plus padding'
                      : 'Play audio from entire map'
                "
                @click="changeAudioScope(opt.value)"
              >{{ opt.label }}</BarButton>
            </BarButtonGroup>
          </BarControlGroup>
          <BarControlGroup>
            <BarDivider />
            <BarLabel>SOUNDS:</BarLabel>
            <BarButton
              :active="allSoundsActive"
              title="Toggle all sound categories on/off"
              @click="toggleAllSounds"
            >ALL</BarButton>
            <BarButtonGroup>
              <BarButton
                v-for="cat in SFX_CATEGORIES"
                :key="cat"
                :active="soundToggles[cat]"
                :title="SOUND_TOOLTIPS[cat]"
                @click="toggleSoundCategory(cat)"
              >{{ SOUND_LABELS[cat] }}</BarButton>
            </BarButtonGroup>
          </BarControlGroup>
          <BarControlGroup>
            <BarDivider />
            <BarLabel>MUSIC:</BarLabel>
            <BarButton
              :active="soundToggles.music"
              :title="SOUND_TOOLTIPS.music"
              @click="toggleSoundCategory('music')"
            >{{ soundToggles.music ? 'ON' : 'OFF' }}</BarButton>
          </BarControlGroup>
          <BarControlGroup>
            <BarDivider />
            <BarLabel>TURR RAD:</BarLabel>
            <BarButton
              :active="allRangesActive"
              title="Toggle every turret-range viz on/off"
              @click="toggleAllRanges"
            >ALL</BarButton>
            <BarButtonGroup>
              <BarButton
                :active="rangeToggles.trackAcquire"
                title="Show tracking acquire range (start tracking target)"
                @click="toggleRange('trackAcquire')"
              >T.A</BarButton>
              <BarButton
                :active="rangeToggles.trackRelease"
                title="Show tracking release range (lose target)"
                @click="toggleRange('trackRelease')"
              >T.R</BarButton>
              <BarButton
                :active="rangeToggles.engageAcquire"
                title="Show engage acquire range (start firing)"
                @click="toggleRange('engageAcquire')"
              >E.A</BarButton>
              <BarButton
                :active="rangeToggles.engageRelease"
                title="Show engage release range (stop firing)"
                @click="toggleRange('engageRelease')"
              >E.R</BarButton>
              <BarButton
                :active="rangeToggles.build"
                title="Show build range"
                @click="toggleRange('build')"
              >BLD</BarButton>
            </BarButtonGroup>
          </BarControlGroup>
          <BarControlGroup>
            <BarDivider />
            <BarLabel>SHOT RAD:</BarLabel>
            <BarButton
              :active="allProjRangesActive"
              title="Toggle every projectile-radius viz on/off"
              @click="toggleAllProjRanges"
            >ALL</BarButton>
            <BarButtonGroup>
              <BarButton
                :active="projRangeToggles.collision"
                title="Show projectile collision radius"
                @click="toggleProjRange('collision')"
              >COL</BarButton>
              <BarButton
                :active="projRangeToggles.explosion"
                title="Show projectile explosion radius"
                @click="toggleProjRange('explosion')"
              >EXP</BarButton>
            </BarButtonGroup>
          </BarControlGroup>
          <BarControlGroup>
            <BarDivider />
            <BarLabel>UNIT RAD:</BarLabel>
            <BarButton
              :active="allUnitRadiiActive"
              title="Toggle every unit-radius viz on/off"
              @click="toggleAllUnitRadii"
            >ALL</BarButton>
            <BarButtonGroup>
              <BarButton
                :active="unitRadiusToggles.visual"
                title="Show unit body radius (unit.radius.body — visible chassis size)"
                @click="toggleUnitRadius('visual')"
              >BODY</BarButton>
              <BarButton
                :active="unitRadiusToggles.shot"
                title="Show unit shot radius (radius.shot — projectile/beam hit detection)"
                @click="toggleUnitRadius('shot')"
              >SHOT</BarButton>
              <BarButton
                :active="unitRadiusToggles.push"
                title="Show unit push radius (radius.push — unit-unit push physics, ground-click selection fallback)"
                @click="toggleUnitRadius('push')"
              >PUSH</BarButton>
            </BarButtonGroup>
          </BarControlGroup>
          <BarControlGroup>
            <BarDivider />
            <BarLabel>LEGS:</BarLabel>
            <BarButton
              :active="legsRadiusToggle"
              title="Show each leg's rest circle (chassis-local — the foot wanders inside this radius before snapping to the opposite edge)"
              @click="toggleLegsRadius"
            >RAD</BarButton>
          </BarControlGroup>
          <BarControlGroup>
            <BarDivider />
            <BarLabel>CAMERA:</BarLabel>
            <BarButtonGroup>
              <BarButton
                :active="cameraSmoothMode === 'snap'"
                title="Zoom and pan apply instantly — original behavior, no animation"
                @click="setCameraMode('snap')"
              >SNAP</BarButton>
              <BarButton
                :active="cameraSmoothMode === 'fast'"
                title="Zoom and pan ease with EMA τ ≈ 50 ms — quick settle"
                @click="setCameraMode('fast')"
              >FAST</BarButton>
              <BarButton
                :active="cameraSmoothMode === 'mid'"
                title="Zoom and pan ease with EMA τ ≈ 120 ms — default-feeling smoothness"
                @click="setCameraMode('mid')"
              >MID</BarButton>
              <BarButton
                :active="cameraSmoothMode === 'slow'"
                title="Zoom and pan ease with EMA τ ≈ 400 ms — deliberate, weighty feel"
                @click="setCameraMode('slow')"
              >SLOW</BarButton>
            </BarButtonGroup>
          </BarControlGroup>
        </div>
        </div>
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
      @set-player-name="onPlayerNameChange"
      @reset-defaults="resetDemoDefaults"
    />

    <!-- Camera tutorial — only shown during a REAL game and only
         until the player has performed all three movements once.
         pointer-events are off on the overlay so it never blocks
         clicks on units or terrain underneath. -->
    <CameraTutorial
      v-if="gameStarted && currentBattleMode === 'real' && !cameraTutorialDone"
      :get-orbit="getActiveOrbitCamera"
      @done="handleCameraTutorialDone"
    />

    <!-- Spectate mode toggle — restored. When the user has hidden
         the lobby to watch the demo battle full-screen, this ☰
         button brings the lobby back. -->
    <button
      v-if="!isMobile && showLobby && spectateMode"
      class="spectate-toggle-btn"
      @click="toggleSpectateMode"
      title="Show Menu"
    >
      ☰
    </button>

    <!-- Mobile: toggle bottom bars -->
    <button
      v-if="isMobile"
      class="mobile-bars-toggle"
      :class="{ active: mobileBarsVisible }"
      @click="mobileBarsVisible = !mobileBarsVisible"
      :title="mobileBarsVisible ? 'Hide Controls' : 'Show Controls'"
    >
      ☰
    </button>

    <!-- Sound Test Modal -->
    <SoundTestModal
      :visible="showSoundTest"
      @close="showSoundTest = false"
    />

    <!-- Game Over Banner (dismissible, game keeps running) -->
    <div
      v-if="gameOverWinner !== null"
      class="game-over-banner"
      @click="dismissGameOver"
    >
      <div class="game-over-content" @click.stop>
        <h1
          class="winner-text"
          :style="{ color: getPlayerColor(gameOverWinner) }"
        >
          {{ resolvePlayerName(gameOverWinner) }} wins!
        </h1>
        <p class="loser-text">All other commanders were destroyed</p>
        <div class="game-over-actions">
          <button class="restart-btn" @click="restartGame">
            Return to Lobby
          </button>
          <button class="dismiss-btn" @click="dismissGameOver">
            Continue Watching
          </button>
        </div>
      </div>
    </div>
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
   * The watcher on `inGameLobby` does the DOM move; the element's
   * own CSS doesn't need to change because both parents resolve
   * `position: absolute; width/height: 100%` to the right thing. */
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



/* Game Over Banner */
.game-over-banner {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 2000;
  cursor: pointer;
}

.game-over-content {
  /* Aligned with the bottom-bar aesthetic: dark semi-transparent
   * base + muted gray border. Rounded corners stay; the soft glow
   * is preserved as the game-over moment's accent. */
  text-align: center;
  padding: 40px 60px;
  background: rgba(15, 18, 24, 0.92);
  border: 1px solid #444;
  border-radius: 16px;
  box-shadow: 0 0 40px rgba(68, 68, 170, 0.4);
  cursor: default;
}

.winner-text {
  font-family: monospace;
  font-size: 48px;
  margin: 0 0 20px 0;
  text-shadow: 0 0 20px currentColor;
}

.loser-text {
  font-family: monospace;
  font-size: 20px;
  color: #cccccc;
  margin: 0 0 30px 0;
}

.game-over-actions {
  display: flex;
  gap: 16px;
  justify-content: center;
}

.restart-btn {
  font-family: monospace;
  font-size: 16px;
  padding: 12px 32px;
  background: #4444aa;
  color: white;
  border: none;
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.restart-btn:hover {
  background: #5555cc;
  transform: scale(1.05);
}

.restart-btn:active {
  transform: scale(0.98);
}

.dismiss-btn {
  font-family: monospace;
  font-size: 16px;
  padding: 12px 32px;
  background: rgba(60, 60, 60, 0.9);
  color: #ccc;
  border: 1px solid #666;
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.dismiss-btn:hover {
  background: rgba(80, 80, 80, 0.9);
  border-color: #888;
  color: white;
  transform: scale(1.05);
}

.dismiss-btn:active {
  transform: scale(0.98);
}

/* Spectate mode toggle button — restored. Aligned with the
 * bottom-bar aesthetic: dark base + muted gray border. */
.spectate-toggle-btn {
  position: absolute;
  top: 12px;
  right: 12px;
  z-index: 3001;
  width: 36px;
  height: 36px;
  padding: 0;
  background: rgba(15, 18, 24, 0.92);
  border: 1px solid #444;
  border-radius: 8px;
  color: #aaa;
  font-size: 18px;
  cursor: pointer;
  transition: all 0.2s ease;
  display: flex;
  align-items: center;
  justify-content: center;
}

.spectate-toggle-btn:hover {
  background: rgba(35, 35, 48, 0.96);
  border-color: #777;
  color: white;
}

/* Mobile bars toggle button */
.mobile-bars-toggle {
  position: absolute;
  top: 12px;
  right: 12px;
  z-index: 3001;
  width: 36px;
  height: 36px;
  padding: 0;
  background: rgba(20, 20, 35, 0.8);
  border: 2px solid #555;
  border-radius: 8px;
  color: #667;
  font-size: 18px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
}

.mobile-bars-toggle.active {
  background: rgba(40, 60, 40, 0.9);
  border-color: #6a6;
  color: #fff;
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

.control-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  background: var(--bar-bg);
  border: 1px solid #444;
  border-radius: 0;
  font-family: monospace;
  pointer-events: auto;
  width: 100%;
  box-sizing: border-box;
}

/* Mobile: stack title above options */
@media (pointer: coarse) {
  .control-bar {
    flex-direction: column;
    align-items: stretch;
    gap: 4px;
    padding: 4px 8px;
  }
  .control-bar > .bar-info {
    flex-direction: row;
    justify-content: center;
  }
  .control-bar > .bar-controls {
    justify-content: center;
  }
}

.control-bar:not(:last-child) {
  border-bottom: none;
}

.bar-info {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  flex-shrink: 0;
  white-space: nowrap;
}

.bar-controls {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  flex: 1;
}

.bar-label {
  display: inline-grid;
  font-weight: bold;
  letter-spacing: 1px;
  text-align: center;
  min-width: 105px;
}

.client-power-button {
  width: 100%;
  min-width: 105px;
  padding-block: 2px;
}

.bar-label-text,
.bar-label-hover {
  grid-area: 1 / 1;
}

.bar-label-hover {
  visibility: hidden;
}

.bar-label:hover .bar-label-text {
  visibility: hidden;
}

.bar-label:hover .bar-label-hover {
  visibility: visible;
}

/* `.control-group` and `.control-label` rules now live in
 * `src/styles/barControls.css` (single source of truth shared
 * with the GAME LOBBY's BarControlGroup / BarLabel components). */

.fps-stats {
  display: flex;
  align-items: baseline;
  gap: 2px;
}

.fps-stats .fps-label + .fps-value {
  margin-left: 4px;
}

.fps-value {
  color: #b0b0b0;
  font-size: 13px;
  font-weight: bold;
  font-family: 'Courier New', Courier, monospace;
  font-variant-numeric: tabular-nums;
  display: inline-block;
  width: 4ch;
  text-align: right;
}

.fps-label {
  color: #666;
  font-size: 9px;
  text-transform: uppercase;
}

.stat-bar-group {
  display: flex;
  gap: 6px;
}

.stat-bar {
  display: flex;
  flex-direction: column;
}

.stat-bar-top {
  display: flex;
  align-items: baseline;
  gap: 2px;
}

.stat-bar-track {
  height: 3px;
  background: rgba(255, 255, 255, 0.1);
  border-radius: 1px;
  overflow: hidden;
}

.stat-bar-fill {
  height: 100%;
  border-radius: 1px;
}

.fps-divider {
  color: #444;
  margin: 0 6px;
}

/* `.button-group` and `.control-btn` rules — including the
 * disabled-active fix — now live in `src/styles/barControls.css`.
 * Bottom-bar bare HTML, BarButton/BarButtonGroup components, and
 * the GAME LOBBY all draw from the same source. The bar-specific
 * `.button-group.view-toggle` width override stays here because
 * it's a one-off used by a single bar. */
.button-group.view-toggle {
  width: 105px;
}

.time-display {
  font-size: 10px;
  font-family: monospace;
  color: var(--bar-time, #999);
  margin-left: 4px;
  white-space: nowrap;
}

.ip-display {
  font-size: 10px;
  font-family: monospace;
  color: var(--bar-time, #888);
  white-space: nowrap;
}
</style>

<script setup lang="ts">
import { ref, reactive, onMounted, onUnmounted, computed, nextTick, watch } from 'vue';
import { createGame, destroyGame, type GameInstance } from '../game/createGame';
import { ClientViewState } from '../game/network/ClientViewState';
import { type PlayerId, type WaypointType } from '../game/sim/types';
import {
  createBackgroundBattle,
  destroyBackgroundBattle,
  type BackgroundBattleState,
} from '../game/lobby/LobbyManager';
import BarDivider from './BarDivider.vue';
import SelectionPanel, {
  type SelectionInfo,
  type SelectionActions,
} from './SelectionPanel.vue';
import TopBar, { type EconomyInfo } from './TopBar.vue';
import Minimap, { type MinimapData } from './Minimap.vue';
import LobbyModal, { type LobbyPlayer } from './LobbyModal.vue';
import CombatStatsModal from './CombatStatsModal.vue';
import SoundTestModal from './SoundTestModal.vue';
import type {
  NetworkServerSnapshotCombatStats,
  NetworkServerSnapshotMeta,
} from '../game/network/NetworkTypes';
import type { StatsSnapshot } from './combatStatsUtils';
import {
  networkManager,
  type NetworkRole,
} from '../game/network/NetworkManager';
import {
  getMapSize,
  COMBAT_STATS_HISTORY_MAX,
  COMBAT_STATS_VISIBLE_ON_LOAD,
} from '../config';
import { getUnitBlueprint } from '../game/sim/blueprints';
import { BACKGROUND_UNIT_TYPES } from '../game/server/BackgroundBattleStandalone';
import { LOD_EMA_SOURCE, GOOD_TPS } from '../lodConfig';
import type { SnapshotRate, KeyframeRatio, TickRate } from '../types/server';
import {
  BATTLE_CONFIG,
  saveDemoUnits,
  saveMaxTotalUnits,
  saveDemoCap,
  loadStoredRealCap,
  saveRealCap,
  DEMO_CAP_DEFAULT,
  REAL_CAP_DEFAULT,
  saveDemoGrid,
  loadStoredRealGrid,
  saveRealGrid,
  loadStoredProjVelInherit,
  saveProjVelInherit,
  loadStoredFfAccelUnits,
  saveFfAccelUnits,
  loadStoredFfAccelShots,
  saveFfAccelShots,
  getDefaultDemoUnits,
} from '../battleBarConfig';
import {
  SERVER_CONFIG,
  loadStoredSnapshotRate,
  saveSnapshotRate,
  loadStoredKeyframeRatio,
  saveKeyframeRatio,
  loadStoredTickRate,
  saveTickRate,
  saveGridInfo,
  loadStoredSimQuality,
  saveSimQuality,
  loadStoredSimSignalStates,
  saveSimSignalStates,
} from '../serverBarConfig';
import type { ServerSimQuality, ServerSimSignalStates } from '../types/serverSimLod';
import type { SignalState } from '../types/lod';
import { CLIENT_CONFIG, LOD_SIGNALS_ENABLED } from '../clientBarConfig';
import { SERVER_SIM_LOD_SIGNALS_ENABLED } from '../serverSimLodConfig';
import { BAR_THEMES } from '../barThemes';
import {
  formatDuration,
  fmt4,
  statBarStyle,
  msBarStyle,
  getPlayerColor,
  getPlayerName,
} from './uiUtils';
import { GameServer } from '../game/server/GameServer';
import { LocalGameConnection } from '../game/server/LocalGameConnection';
import { RemoteGameConnection } from '../game/server/RemoteGameConnection';
import type { GameConnection } from '../game/server/GameConnection';
import {
  getGraphicsQuality,
  setGraphicsQuality,
  cycleLodSignalState,
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
  getDriftMode,
  setDriftMode,
  getSoundToggle,
  setSoundToggle,
  SOUND_CATEGORIES,
  getLobbyVisible,
  setLobbyVisible,
  getGridOverlay,
  setGridOverlay,
  setCurrentTpsRatio,
  setCurrentFpsRatio,
  setCurrentUnitCount,
  setCurrentUnitCap,
  setLocalServerRunning,
} from '../clientBarConfig';
import type { GraphicsQuality, ConcreteGraphicsQuality, RenderMode } from '../types/graphics';
import type {
  AudioScope,
  DriftMode,
  GridOverlay,
  SoundCategory,
  RangeType,
  ProjRangeType,
  UnitRadiusType,
} from '../types/client';
import { audioManager } from '../game/audio/AudioManager';
import { musicPlayer } from '../game/audio/MusicPlayer';

const isMobile =
  /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
    navigator.userAgent,
  );

const containerRef = ref<HTMLDivElement | null>(null);
const backgroundContainerRef = ref<HTMLDivElement | null>(null);
const mobileBarsVisible = ref(false);
const activePlayer = ref<PlayerId>(1);
const gameOverWinner = ref<PlayerId | null>(null);

// Background battle state (managed by LobbyManager)
let backgroundBattle: BackgroundBattleState | null = null;

// Current game server (owned by this component)
let currentServer: GameServer | null = null;

// Lobby state
const showLobby = ref(true);
const spectateMode = ref(!getLobbyVisible()); // When true, hide lobby to spectate background battle
const isHost = ref(false);
const roomCode = ref('');
const lobbyPlayers = ref<LobbyPlayer[]>([]);
const localPlayerId = ref<PlayerId>(1);
const lobbyError = ref<string | null>(null);
const isConnecting = ref(false);
const gameStarted = ref(false);
const networkRole = ref<NetworkRole | null>(null);
const hasServer = ref(false); // True when we own a GameServer (host/offline/background)

// Server metadata received from snapshots (for remote clients to display server bar)
const serverMetaFromSnapshot = ref<NetworkServerSnapshotMeta | null>(null);
const localIpAddress = ref<string>('N/A');
const clientTime = ref<string>('');

// Active connection for sending commands (set when server/connection is created)
let activeConnection: GameConnection | null = null;

// Demo battle unit type list (state read from snapshots)
const demoUnitTypes = BACKGROUND_UNIT_TYPES;
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
  clientSignalStates.value.zoom === 'solo' ||
  clientSignalStates.value.tps === 'solo' ||
  clientSignalStates.value.fps === 'solo' ||
  clientSignalStates.value.units === 'solo',
);
const renderMode = ref<RenderMode>(getRenderMode());
const audioScope = ref<AudioScope>(getAudioScope());
const audioSmoothing = ref<boolean>(getAudioSmoothing());
const burnMarks = ref<boolean>(getBurnMarks());
const driftMode = ref<DriftMode>(getDriftMode());
const edgeScrollEnabled = ref(getEdgeScrollEnabled());
const dragPanEnabled = ref(getDragPanEnabled());
const gridOverlay = ref<GridOverlay>(getGridOverlay());
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

// FPS, snapshot rate, and zoom tracking (EMA-based, polled from scene)
const actualAvgFPS = ref(0);
const actualWorstFPS = ref(0);
const snapAvgRate = ref(0);
const snapWorstRate = ref(0);
// Parallel pair tracking ONLY full-keyframe arrivals — used by the
// FSPS stat bar so the user can see how often the protocol re-seeds
// statics. Hosts with a tight keyframe ratio show a high FSPS;
// 'NONE' keyframe ratio holds FSPS at zero after the initial snap.
const fullSnapAvgRate = ref(0);
const fullSnapWorstRate = ref(0);
const currentZoom = ref(0.4);
let fpsUpdateInterval: ReturnType<typeof setInterval> | null = null;

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
  units: { count: 1, cap: 120 },
  buildings: { solar: 0, factory: 0 },
});

// Minimap state
const minimapData = reactive<MinimapData>({
  mapWidth: 2000,
  mapHeight: 2000,
  entities: [],
  cameraQuad: [
    { x: 0, y: 0 },
    { x: 800, y: 0 },
    { x: 800, y: 600 },
    { x: 0, y: 600 },
  ],
});

// Combat stats state
const combatStats = ref<NetworkServerSnapshotCombatStats | null>(null);
const showCombatStats = ref(COMBAT_STATS_VISIBLE_ON_LOAD);
const showSoundTest = ref(false);
const combatStatsViewMode = ref<'global' | 'player'>('global');
const combatStatsHistory = ref<StatsSnapshot[]>([]);
let statsHistoryStartTime = 0;
const battleElapsed = ref('00:00:00');

let gameInstance: GameInstance | null = null;
// Hoisted from the scene so state survives a live 2D↔3D renderer swap.
// One instance per game session — created alongside gameConnection when
// the match starts, cleared when the match ends.
let clientViewState: ClientViewState | null = null;

// Polling interval IDs for cleanup
let checkBgSceneInterval: ReturnType<typeof setInterval> | null = null;
let checkSceneInterval: ReturnType<typeof setInterval> | null = null;
let clientTimeInterval: ReturnType<typeof setInterval> | null = null;

// Start the background battle (runs behind lobby)
async function startBackgroundBattle(): Promise<void> {
  if (backgroundBattle || !backgroundContainerRef.value) return;

  backgroundBattle = await createBackgroundBattle(
    backgroundContainerRef.value,
    localIpAddress.value,
  );
  activeConnection = backgroundBattle.connection;
  hasServer.value = true;

  // Wire combat stats callback for background scene
  let bgAttempts = 0;
  checkBgSceneInterval = setInterval(() => {
    bgAttempts++;
    if (bgAttempts > 50) {
      if (checkBgSceneInterval) clearInterval(checkBgSceneInterval);
      checkBgSceneInterval = null;
      return;
    }
    const bgScene = backgroundBattle?.gameInstance?.getScene();
    if (bgScene) {
      bgScene.onCombatStatsUpdate = (stats: NetworkServerSnapshotCombatStats) => {
        const cloned = structuredClone(stats);
        combatStats.value = cloned;
        if (statsHistoryStartTime === 0) statsHistoryStartTime = Date.now();
        combatStatsHistory.value.push({
          timestamp: Date.now() - statsHistoryStartTime,
          stats: cloned,
        });
        if (combatStatsHistory.value.length > COMBAT_STATS_HISTORY_MAX) {
          combatStatsHistory.value.shift();
        }
      };
      bgScene.onServerMetaUpdate = (meta: NetworkServerSnapshotMeta) => {
        serverMetaFromSnapshot.value = meta;
      };
      bgScene.onEconomyChange = (info: EconomyInfo) => {
        Object.assign(economyInfo, info);
      };
      bgScene.onSelectionChange = (info: SelectionInfo) => {
        Object.assign(selectionInfo, info);
      };
      bgScene.onPlayerChange = (playerId: PlayerId) => {
        activePlayer.value = playerId;
      };
      bgScene.onMinimapUpdate = (data: MinimapData) => {
        // Entity refresh (throttled by the scene, ~20 Hz). The
        // cameraQuad is live-updated separately below at full fps.
        minimapData.entities = data.entities;
        minimapData.mapWidth = data.mapWidth;
        minimapData.mapHeight = data.mapHeight;
      };
      bgScene.onCameraQuadUpdate = (quad) => {
        minimapData.cameraQuad = quad;
      };
      if (checkBgSceneInterval) clearInterval(checkBgSceneInterval);
      checkBgSceneInterval = null;
    }
  }, 100);
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
  }
  combatStatsHistory.value = [];
  statsHistoryStartTime = 0;
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

// Show server controls when we own a server OR when we receive server meta from snapshots (remote client)
const showServerControls = computed(
  () => hasServer.value || serverMetaFromSnapshot.value !== null,
);

// Server bar is read-only for remote clients (no local server)
const serverBarReadonly = computed(() => !hasServer.value);

// Bar color theming via CSS custom properties
type BarColorTheme = (typeof BAR_THEMES)[keyof typeof BAR_THEMES];
function barVars(theme: BarColorTheme): Record<string, string> {
  return {
    '--bar-bg': theme.barBg,
    '--bar-time': theme.time,
    '--bar-active-bg': theme.activeBg,
    '--bar-active-border': theme.activeBorder,
    '--bar-active-hover-bg': theme.activeHoverBg,
    '--bar-active-hover-border': theme.activeHoverBorder,
    '--bar-active-pressed-bg': theme.activePressedBg,
    '--bar-active-pressed-border': theme.activePressedBorder,
  };
}
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
// HOST SERVER LOD pick — driven from local persistence + sent to the
// server via setSimQuality command. Effective tier (after the auto
// resolver) is read from the server's snapshot meta — the server
// runs the resolver each tick and ships both the picked AND
// effective values, so the bar lights the picked button as
// background AND the effective tier as white text just like the
// PLAYER CLIENT bar does.
const serverSimQuality = ref<ServerSimQuality>(loadStoredSimQuality());
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
  () => serverMetaFromSnapshot.value?.grid ?? false,
);
const displayUnitCount = computed(
  () => serverMetaFromSnapshot.value?.units.count ?? 0,
);
const displayUnitCap = computed(
  () => serverMetaFromSnapshot.value?.units.max ?? 100,
);
const displayServerTime = computed(
  () => serverMetaFromSnapshot.value?.server.time ?? '',
);
const displayServerIp = computed(
  () => serverMetaFromSnapshot.value?.server.ip ?? '',
);

const allDemoUnitsActive = computed(() => {
  const allowed = serverMetaFromSnapshot.value?.units.allowed;
  if (!allowed) return true; // default is all enabled
  return demoUnitTypes.every((ut) => allowed.includes(ut));
});

function toggleDemoUnitType(unitType: string): void {
  const current =
    serverMetaFromSnapshot.value?.units.allowed?.includes(unitType) ?? true;
  activeConnection?.sendCommand({
    type: 'setBackgroundUnitType',
    tick: 0,
    unitType,
    enabled: !current,
  });

  // Persist updated unit list to localStorage
  const currentList = serverMetaFromSnapshot.value?.units.allowed ?? [
    ...demoUnitTypes,
  ];
  const newList = current
    ? currentList.filter((ut) => ut !== unitType)
    : [...currentList, unitType];
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
  saveMaxTotalUnits(value);
  // Save to mode-specific storage
  if (gameStarted.value) {
    saveRealCap(value);
  } else {
    saveDemoCap(value);
  }
}

function toggleProjVelInherit(): void {
  const current =
    serverMetaFromSnapshot.value?.projVelInherit ?? BATTLE_CONFIG.projVelInherit.default;
  activeConnection?.sendCommand({
    type: 'setProjVelInherit',
    tick: 0,
    enabled: !current,
  });
  saveProjVelInherit(!current);
}

function setFfAccelUnits(enabled: boolean): void {
  activeConnection?.sendCommand({ type: 'setFfAccelUnits', tick: 0, enabled });
  saveFfAccelUnits(enabled);
}

function setFfAccelShots(enabled: boolean): void {
  activeConnection?.sendCommand({ type: 'setFfAccelShots', tick: 0, enabled });
  saveFfAccelShots(enabled);
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
  changeMaxTotalUnits(gameStarted.value ? REAL_CAP_DEFAULT : DEMO_CAP_DEFAULT);
  activeConnection?.sendCommand({
    type: 'setProjVelInherit',
    tick: 0,
    enabled: BATTLE_CONFIG.projVelInherit.default,
  });
  saveProjVelInherit(BATTLE_CONFIG.projVelInherit.default);
  setFfAccelUnits(BATTLE_CONFIG.ffAccelUnits.default);
  setFfAccelShots(BATTLE_CONFIG.ffAccelShots.default);
  // Reset grid to mode default
  const gridDefault = gameStarted.value ? false : true;
  if (displayGridInfo.value !== gridDefault) {
    toggleSendGridInfo();
  }
}

function resetServerDefaults(): void {
  setTickRateValue(SERVER_CONFIG.tickRate.default);
  setNetworkUpdateRate(SERVER_CONFIG.snapshot.default);
  setKeyframeRatioValue(SERVER_CONFIG.keyframe.default);
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
  setDriftMode(cd.driftMode.default);
  driftMode.value = cd.driftMode.default;
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
  combatStatsHistory.value = [];
  statsHistoryStartTime = 0;
  // Return to lobby
  gameStarted.value = false;
  showLobby.value = true;
  networkManager.disconnect();
  networkRole.value = null;
  lobbyPlayers.value = [];
  roomCode.value = '';

  // Stop current server
  if (currentServer) {
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
  startBuild: (buildingType: 'solar' | 'factory') => {
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

    const code = await networkManager.hostGame();
    roomCode.value = code;
    isHost.value = true;
    networkRole.value = 'host';
    localPlayerId.value = 1;

    // Add self to player list
    lobbyPlayers.value = [
      {
        playerId: 1,
        name: 'Red',
        isHost: true,
      },
    ];

    // Setup network callbacks
    setupNetworkCallbacks();

    isConnecting.value = false;
  } catch (err) {
    lobbyError.value = (err as Error).message || 'Failed to host game';
    isConnecting.value = false;
  }
}

async function handleJoin(code: string): Promise<void> {
  try {
    isConnecting.value = true;
    lobbyError.value = null;

    await networkManager.joinGame(code);
    roomCode.value = code;
    isHost.value = false;
    networkRole.value = 'client';

    // Setup network callbacks
    setupNetworkCallbacks();

    isConnecting.value = false;
  } catch (err) {
    lobbyError.value = (err as Error).message || 'Failed to join game';
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
  isConnecting.value = false;
}

function handleOffline(): void {
  // Start game in offline mode — 4-player AI game, user controls player 1
  networkRole.value = null;
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
function cycleClientSignal(signal: 'zoom' | 'tps' | 'fps' | 'units'): void {
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

function changeDriftMode(mode: DriftMode): void {
  setDriftMode(mode);
  driftMode.value = mode;
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

function updateFPSStats(): void {
  const scene = backgroundBattle?.gameInstance?.getScene() ?? gameInstance?.getScene();
  if (scene) {
    currentZoom.value = scene.cameras.main.zoom;

    const timing = scene.getFrameTiming();
    frameMsAvg.value = timing.frameMsAvg;
    frameMsHi.value = timing.frameMsHi;
    renderMsAvg.value = timing.renderMsAvg;
    renderMsHi.value = timing.renderMsHi;
    logicMsAvg.value = timing.logicMsAvg;
    logicMsHi.value = timing.logicMsHi;
    gpuTimerMs.value = timing.gpuTimerMs;
    gpuTimerSupported.value = timing.gpuTimerSupported;
    longtaskMsPerSec.value = timing.longtaskMsPerSec;
    longtaskSupported.value = timing.longtaskSupported;

    const frameStats = scene.getFrameStats();
    actualAvgFPS.value = frameStats.avgFps;
    actualWorstFPS.value = frameStats.worstFps;

    const snapStats = scene.getSnapshotStats();
    snapAvgRate.value = snapStats.avgRate;
    snapWorstRate.value = snapStats.worstRate;
    const fullSnapStats = scene.getFullSnapshotStats();
    fullSnapAvgRate.value = fullSnapStats.avgRate;
    fullSnapWorstRate.value = fullSnapStats.worstRate;
  }
  const fpsVal = LOD_EMA_SOURCE.fps === 'avg' ? actualAvgFPS.value : actualWorstFPS.value;
  const tpsVal = LOD_EMA_SOURCE.tps === 'avg' ? displayServerTpsAvg.value : displayServerTpsWorst.value;
  setCurrentFpsRatio(fpsVal / 60);
  setCurrentTpsRatio(tpsVal / GOOD_TPS);
  // UNITS auto-LOD reads (count, cap) from the server's snapshot
  // meta. The LOD ladder operates on `1 − count/cap` (fullness ratio)
  // so visual quality drops at the same proportional milestones
  // whether the cap is 1k or 16k. Pre-snapshot the count stays at
  // 0 (sparse world ⇒ MAX tier) and the cap falls back to the
  // bundled default until a real snapshot arrives.
  const meta = serverMetaFromSnapshot.value;
  setCurrentUnitCount(meta?.units.count ?? 0);
  if (meta?.units.max !== undefined) setCurrentUnitCap(meta.units.max);
  setLocalServerRunning(hasServer.value);
  effectiveQuality.value = getEffectiveQuality();
}

function setupNetworkCallbacks(): void {
  networkManager.onPlayerJoined = (player: LobbyPlayer) => {
    // Check if already in list
    const existing = lobbyPlayers.value.find(
      (p) => p.playerId === player.playerId,
    );
    if (!existing) {
      lobbyPlayers.value = [...lobbyPlayers.value, player];
    }
  };

  networkManager.onPlayerLeft = (playerId: PlayerId) => {
    lobbyPlayers.value = lobbyPlayers.value.filter(
      (p) => p.playerId !== playerId,
    );
  };

  networkManager.onPlayerAssignment = (playerId: PlayerId) => {
    localPlayerId.value = playerId;
    activePlayer.value = playerId;
  };

  networkManager.onGameStart = (playerIds: PlayerId[]) => {
    startGameWithPlayers(playerIds);
  };

  networkManager.onError = (error: string) => {
    lobbyError.value = error;
  };
}

async function startGameWithPlayers(playerIds: PlayerId[], aiPlayerIds?: PlayerId[]): Promise<void> {
  showLobby.value = false;
  gameStarted.value = true;

  // Stop the background battle first
  stopBackgroundBattle();

  // Small delay to ensure WebGL cleanup before creating new game
  setTimeout(async () => {
    if (!containerRef.value) return;

    const rect = containerRef.value.getBoundingClientRect();

    let gameConnection: GameConnection;

    if (networkRole.value !== 'client') {
      // Create GameServer for host/offline (WASM physics)
      currentServer = await GameServer.create({ playerIds, aiPlayerIds });

      // Create LocalGameConnection for the host client
      const localConnection = new LocalGameConnection(currentServer);
      activeConnection = localConnection;
      gameConnection = localConnection;

      // If hosting, also broadcast snapshots to remote clients
      if (networkRole.value === 'host') {
        currentServer.addSnapshotListener((state) => {
          networkManager.broadcastState(state);
        });

        // Receive commands from remote clients
        networkManager.onCommandReceived = (command, _fromPlayerId) => {
          currentServer?.receiveCommand(command);
        };
      }

      // Configure snapshot rate and start (restore from localStorage)
      currentServer.setTickRate(loadStoredTickRate());
      currentServer.setSnapshotRate(loadStoredSnapshotRate());
      currentServer.setKeyframeRatio(loadStoredKeyframeRatio());
      currentServer.setSimQuality(serverSimQuality.value);
      currentServer.receiveCommand({
        type: 'setSimSignalStates',
        tick: 0,
        tps: serverSignalStates.value.tps,
        cpu: serverSignalStates.value.cpu,
        units: serverSignalStates.value.units,
      });
      currentServer.setIpAddress(localIpAddress.value);
      currentServer.receiveCommand({
        type: 'setMaxTotalUnits',
        tick: 0,
        maxTotalUnits: loadStoredRealCap(),
      });
      currentServer.receiveCommand({
        type: 'setProjVelInherit',
        tick: 0,
        enabled: loadStoredProjVelInherit(),
      });
      currentServer.receiveCommand({
        type: 'setFfAccelUnits',
        tick: 0,
        enabled: loadStoredFfAccelUnits(),
      });
      currentServer.receiveCommand({
        type: 'setFfAccelShots',
        tick: 0,
        enabled: loadStoredFfAccelShots(),
      });
      currentServer.receiveCommand({
        type: 'setSendGridInfo',
        tick: 0,
        enabled: loadStoredRealGrid(),
      });
      currentServer.start();
      hasServer.value = true;
    } else {
      // Client: create RemoteGameConnection wrapping networkManager
      const remoteConnection = new RemoteGameConnection();
      activeConnection = remoteConnection;
      gameConnection = remoteConnection;
    }

    // Create ClientViewState once per game session.
    clientViewState = new ClientViewState();

    // Create game with player configuration
    gameInstance = createGame({
      parent: containerRef.value!,
      width: rect.width || window.innerWidth,
      height: rect.height || window.innerHeight,
      playerIds,
      localPlayerId: localPlayerId.value,
      gameConnection,
      clientViewState,
      mapWidth: getMapSize(false).width,
      mapHeight: getMapSize(false).height,
      backgroundMode: false,
    });

    // Setup scene callbacks
    setupSceneCallbacks();
  }, 100);
}

function setupSceneCallbacks(): void {
  let sceneAttempts = 0;
  checkSceneInterval = setInterval(() => {
    sceneAttempts++;
    if (sceneAttempts > 50) {
      if (checkSceneInterval) clearInterval(checkSceneInterval);
      checkSceneInterval = null;
      return;
    }
    const scene = gameInstance?.getScene();
    if (scene) {
      // Player change callback
      scene.onPlayerChange = (playerId: PlayerId) => {
        activePlayer.value = playerId;
      };

      // Selection change callback
      scene.onSelectionChange = (info: SelectionInfo) => {
        Object.assign(selectionInfo, info);
      };

      // Economy change callback
      scene.onEconomyChange = (info: EconomyInfo) => {
        Object.assign(economyInfo, info);
      };

      // Minimap data callback — entities + map size only, throttled
      // by the scene. The camera quad flows through the dedicated
      // per-frame channel below so the box tracks the view at 60 fps.
      scene.onMinimapUpdate = (data: MinimapData) => {
        minimapData.entities = data.entities;
        minimapData.mapWidth = data.mapWidth;
        minimapData.mapHeight = data.mapHeight;
      };
      scene.onCameraQuadUpdate = (quad) => {
        minimapData.cameraQuad = quad;
      };

      // Game over callback
      scene.onGameOverUI = (winnerId: PlayerId) => {
        gameOverWinner.value = winnerId;
      };

      // Game restart callback
      scene.onGameRestart = () => {
        gameOverWinner.value = null;
      };

      // Combat stats callback
      scene.onCombatStatsUpdate = (stats: NetworkServerSnapshotCombatStats) => {
        const cloned = structuredClone(stats);
        combatStats.value = cloned;
        if (statsHistoryStartTime === 0) statsHistoryStartTime = Date.now();
        combatStatsHistory.value.push({
          timestamp: Date.now() - statsHistoryStartTime,
          stats: cloned,
        });
        if (combatStatsHistory.value.length > COMBAT_STATS_HISTORY_MAX) {
          combatStatsHistory.value.shift();
        }
      };

      // Server metadata callback (for remote clients to see server bar)
      scene.onServerMetaUpdate = (meta: NetworkServerSnapshotMeta) => {
        serverMetaFromSnapshot.value = meta;
      };

      if (checkSceneInterval) clearInterval(checkSceneInterval);
      checkSceneInterval = null;
    }
  }, 100);
}

function setNetworkUpdateRate(rate: SnapshotRate): void {
  activeConnection?.sendCommand({ type: 'setSnapshotRate', tick: 0, rate });
  saveSnapshotRate(rate);
}

function setTickRateValue(rate: TickRate): void {
  activeConnection?.sendCommand({ type: 'setTickRate', tick: 0, rate });
  saveTickRate(rate);
}

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
  const current = serverMetaFromSnapshot.value?.grid ?? false;
  activeConnection?.sendCommand({
    type: 'setSendGridInfo',
    tick: 0,
    enabled: !current,
  });
  saveGridInfo(!current);
  if (gameStarted.value) {
    saveRealGrid(!current);
  } else {
    saveDemoGrid(!current);
  }
}

function changeGridOverlay(mode: GridOverlay): void {
  setGridOverlay(mode);
  gridOverlay.value = mode;
}

function dismissGameOver(): void {
  gameOverWinner.value = null;
}

function handleCombatStatsKeydown(e: KeyboardEvent): void {
  if (e.key === '`') {
    showCombatStats.value = !showCombatStats.value;
  }
  if (e.key === '~') {
    showSoundTest.value = !showSoundTest.value;
  }
}

onMounted(() => {
  // Start the background battle behind the lobby
  nextTick(() => {
    startBackgroundBattle();
  });

  // Start FPS tracking
  fpsUpdateInterval = setInterval(updateFPSStats, 100); // Update 10x per second

  // Fetch public IP for server bar display
  fetch('https://api.ipify.org?format=text')
    .then((res) => res.text())
    .then((ip) => {
      localIpAddress.value = ip.trim();
      // Push to whichever server is already running (fetch is async)
      backgroundBattle?.server.setIpAddress(localIpAddress.value);
      currentServer?.setIpAddress(localIpAddress.value);
    })
    .catch(() => {
      /* keep 'N/A' */
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
    if (statsHistoryStartTime > 0) {
      battleElapsed.value = formatDuration(Date.now() - statsHistoryStartTime);
    } else {
      battleElapsed.value = '00:00:00';
    }
  }
  updateClientTime();
  clientTimeInterval = setInterval(updateClientTime, 1000);

  // Listen for backtick to toggle combat stats
  window.addEventListener('keydown', handleCombatStatsKeydown);
});

onUnmounted(() => {
  if (fpsUpdateInterval) {
    clearInterval(fpsUpdateInterval);
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
  window.removeEventListener('keydown', handleCombatStatsKeydown);
  // Stop servers
  if (currentServer) {
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
    <div class="game-area">
      <!-- Background battle container (demo game — always visible when no real game) -->
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

      <!-- Game UI (desktop: hidden when lobby modal visible; mobile: follows hamburger toggle) -->
      <template v-if="isMobile ? mobileBarsVisible : !lobbyModalVisible">
        <!-- Top bar with economy info -->
        <TopBar
          :economy="economyInfo"
          :player-name="getPlayerName(activePlayer)"
          :player-color="getPlayerColor(activePlayer)"
          :can-toggle-player="showPlayerToggle"
          @toggle-player="togglePlayer"
        />

        <!-- Selection panel (bottom-left) -->
        <SelectionPanel
          :selection="selectionInfo"
          :actions="selectionActions"
        />

        <!-- Minimap (bottom-right) -->
        <Minimap :data="minimapData" @click="handleMinimapClick" />
      </template>
    </div>

    <!-- Bottom control bars (desktop: hidden when lobby modal visible; mobile: toggled) -->
    <div v-if="isMobile ? mobileBarsVisible : !lobbyModalVisible" class="bottom-controls">
      <!-- BATTLE CONTROLS -->
      <div
        v-if="showServerControls"
        class="control-bar"
        :class="{ 'bar-readonly': serverBarReadonly }"
        :style="battleBarVars"
      >
        <div class="bar-info">
          <button
            class="control-btn active bar-label"
            title="Click to reset battle settings to defaults"
            @click="resetDemoDefaults"
          >
            <span class="bar-label-text">{{ battleLabel }}</span
            ><span class="bar-label-hover">DEFAULTS</span>
          </button>
        </div>
        <BarDivider />
        <div class="bar-controls">
          <span class="time-display" title="Battle elapsed time">{{
            battleElapsed
          }}</span>
          <BarDivider />
          <div class="control-group">
            <span class="control-label">UNITS:</span>
            <button
              class="control-btn"
              :class="{ active: allDemoUnitsActive }"
              title="Toggle all unit types on/off"
              @click="toggleAllDemoUnits"
            >
              ALL
            </button>
            <div class="button-group">
              <button
                v-for="ut in demoUnitTypes"
                :key="ut"
                class="control-btn"
                :class="{
                  active:
                    serverMetaFromSnapshot?.units.allowed?.includes(ut) ??
                    true,
                }"
                :title="`Toggle ${ut} units in demo battle`"
                @click="toggleDemoUnitType(ut)"
              >
                {{ getUnitBlueprint(ut).shortName }}
              </button>
            </div>
          </div>
          <div class="control-group">
            <BarDivider />
            <span class="control-label">CAP:</span>
            <div class="button-group">
              <button
                v-for="opt in BATTLE_CONFIG.cap.options"
                :key="opt"
                class="control-btn"
                :class="{
                  active: serverMetaFromSnapshot?.units.max === opt,
                }"
                :title="`Max ${opt} total units`"
                @click="changeMaxTotalUnits(opt)"
              >
                {{ opt.toExponential(0).toUpperCase() }}
              </button>
            </div>
          </div>
          <div class="control-group">
            <BarDivider />
            <span class="control-label" title="Total units alive / unit cap">UNITS:</span>
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
          </div>
          <div class="control-group">
            <BarDivider />
            <span class="control-label">SHOT VEL:</span>
            <button
              class="control-btn"
              :class="{ active: serverMetaFromSnapshot?.projVelInherit }"
              title="Add firing unit's velocity to projectile velocity"
              @click="toggleProjVelInherit"
            >
              ADD
            </button>
          </div>
          <div class="control-group">
            <BarDivider />
            <span class="control-label">FF:</span>
            <div class="button-group">
              <button
                class="control-btn"
                :class="{
                  active: serverMetaFromSnapshot?.ffAccel.units ?? false,
                }"
                title="Force field accelerates enemy units"
                @click="
                  setFfAccelUnits(
                    !(serverMetaFromSnapshot?.ffAccel.units ?? false),
                  )
                "
              >
                UNIT-ACC
              </button>
              <button
                class="control-btn"
                :class="{
                  active: serverMetaFromSnapshot?.ffAccel.shots ?? true,
                }"
                title="Force field accelerates enemy projectiles"
                @click="
                  setFfAccelShots(
                    !(serverMetaFromSnapshot?.ffAccel.shots ?? true),
                  )
                "
              >
                SHOT-ACC
              </button>
            </div>
          </div>
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
          <button
            class="control-btn active bar-label"
            title="Click to reset server settings to defaults"
            @click="resetServerDefaults"
          >
            <span class="bar-label-text">HOST SERVER</span
            ><span class="bar-label-hover">DEFAULTS</span>
          </button>
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
          <div class="control-group">
            <span class="control-label">TARGET TPS:</span>
            <div class="button-group">
              <button
                v-for="rate in SERVER_CONFIG.tickRate.options"
                :key="rate"
                class="control-btn"
                :class="{ active: displayTickRate === rate }"
                :title="`Target ${rate} simulation ticks per second`"
                @click="setTickRateValue(rate)"
              >
                {{ rate }}
              </button>
            </div>
          </div>
          <div class="control-group">
            <BarDivider />
            <span
              class="control-label"
              title="Server simulation ticks per second"
              >TPS:</span
            >
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
          </div>
          <!--
            Host CPU load: how much of each tick's budget (1000 / tickRate
            ms) the sim actually spent working. Ticked here as avg + hi,
            same semantics as the client CPU/GPU bars. >100 means the host
            is falling behind the target TPS.
          -->
          <div class="control-group">
            <BarDivider />
            <span
              class="control-label"
              title="Host CPU load — simulation tick time as a percent of the target tick budget. >100% means the host is falling behind."
              >CPU:</span
            >
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
          </div>
          <div class="control-group">
            <BarDivider />
            <span class="control-label">TARGET SPS:</span>
            <div class="button-group">
              <button
                v-for="rate in SERVER_CONFIG.snapshot.options"
                :key="String(rate)"
                class="control-btn"
                :class="{ active: displaySnapshotRate === rate }"
                :title="`Cap snapshots at ${rate === 'none' ? 'no limit (every tick)' : rate + '/sec'}`"
                @click="setNetworkUpdateRate(rate)"
              >
                {{ rate === 'none' ? 'NONE' : (rate as number) }}
              </button>
            </div>
          </div>
          <div class="control-group">
            <BarDivider />
            <span class="control-label">FULLSNAP:</span>
            <div class="button-group">
              <button
                v-for="opt in SERVER_CONFIG.keyframe.options"
                :key="String(opt)"
                class="control-btn"
                :class="{ active: displayKeyframeRatio === opt }"
                :title="
                  opt === 'ALL'
                    ? 'Every snapshot is a full keyframe'
                    : opt === 'NONE'
                      ? 'Never send full keyframes (delta only)'
                      : secPerFullsnap(opt as number)
                "
                @click="setKeyframeRatioValue(opt)"
              >
                {{
                  opt === 'ALL'
                    ? 'ALL'
                    : opt === 'NONE'
                      ? 'NONE'
                      : `1e-${Math.round(-Math.log10(opt as number))}`
                }}
              </button>
            </div>
          </div>
          <div class="control-group">
            <BarDivider />
            <span class="control-label">LOD:</span>
            <button
              class="control-btn"
              :class="{
                active: serverSimQuality === 'auto' && !serverAnySolo,
                'active-level': serverSimQuality === 'auto' && serverAnySolo,
              }"
              title="Auto-adjust sim throttling (lowest of TPS, CPU, units)"
              @click="setSimQualityValue('auto')"
            >
              AUTO
            </button>
            <div class="button-group">
              <button
                v-if="SERVER_SIM_LOD_SIGNALS_ENABLED.tps"
                class="control-btn signal-btn"
                :class="{
                  'signal-off': serverSignalStates.tps === 'off',
                  active: serverSimQuality === 'auto' && serverSignalStates.tps === 'solo',
                  'active-level':
                    serverSimQuality === 'auto'
                    && serverSignalStates.tps === 'active'
                    && !serverAnySolo,
                }"
                :title="`Server TPS signal — click to cycle off / active / solo. Currently ${serverSignalStates.tps}.`"
                @click="cycleServerSignal('tps')"
              >
                TPS
              </button>
              <button
                v-if="SERVER_SIM_LOD_SIGNALS_ENABLED.cpu"
                class="control-btn signal-btn"
                :class="{
                  'signal-off': serverSignalStates.cpu === 'off',
                  active: serverSimQuality === 'auto' && serverSignalStates.cpu === 'solo',
                  'active-level':
                    serverSimQuality === 'auto'
                    && serverSignalStates.cpu === 'active'
                    && !serverAnySolo,
                }"
                :title="`Host CPU load signal — click to cycle off / active / solo. Currently ${serverSignalStates.cpu}.`"
                @click="cycleServerSignal('cpu')"
              >
                CPU
              </button>
              <button
                v-if="SERVER_SIM_LOD_SIGNALS_ENABLED.units"
                class="control-btn signal-btn"
                :class="{
                  'signal-off': serverSignalStates.units === 'off',
                  active: serverSimQuality === 'auto' && serverSignalStates.units === 'solo',
                  'active-level':
                    serverSimQuality === 'auto'
                    && serverSignalStates.units === 'active'
                    && !serverAnySolo,
                }"
                :title="`World fullness signal — click to cycle off / active / solo. Currently ${serverSignalStates.units}.`"
                @click="cycleServerSignal('units')"
              >
                UNITS
              </button>
            </div>
            <div class="button-group">
              <button
                v-for="opt in CLIENT_CONFIG.graphics.options"
                :key="opt.value"
                class="control-btn"
                :class="{
                  active: serverSimQuality === opt.value,
                  'active-level':
                    effectiveSimQuality === opt.value &&
                    serverSimQuality !== opt.value,
                }"
                :title="`Lock sim throttling to ${opt.value} tier`"
                @click="setSimQualityValue(opt.value)"
              >
                {{ opt.label }}
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- CLIENT CONTROLS (always visible) -->
      <div class="control-bar" :style="clientBarVars">
        <div class="bar-info">
          <button
            class="control-btn active bar-label"
            title="Click to reset client settings to defaults"
            @click="resetClientDefaults"
          >
            <span class="bar-label-text">PLAYER CLIENT</span
            ><span class="bar-label-hover">DEFAULTS</span>
          </button>
        </div>
        <BarDivider />
        <div class="bar-controls">
          <span
            v-if="clientTime"
            class="time-display"
            title="Client wall-clock time"
            >{{ clientTime }}</span
          >
          <span
            v-if="localIpAddress !== 'N/A'"
            class="ip-display"
            title="Public IP address"
            >{{ localIpAddress }}</span
          >
          <BarDivider />
          <div class="control-group">
            <span class="control-label">GRID:</span>
            <div class="button-group">
              <button
                v-for="opt in CLIENT_CONFIG.gridOverlay.options"
                :key="opt.value"
                class="control-btn"
                :class="{ active: gridOverlay === opt.value }"
                title="Territory capture overlay intensity"
                @click="changeGridOverlay(opt.value)"
              >
                {{ opt.label }}
              </button>
            </div>
          </div>
          <BarDivider />
          <!--
            Bottleneck-first ordering: CPU (sim/update work) then GPU (real
            execution time if the EXT_disjoint_timer_query_webgl2 extension
            is available, otherwise renderer.render() wall-clock), then
            FRAME (total), then LONG (main-thread blocks ≥50 ms from the
            Longtask API). Raw ms throughout — no arbitrary 100%.
          -->
          <div class="control-group">
            <span
              class="control-label"
              title="Client CPU — simulation prediction, input, HUD updates. Raw logicMs avg/hi in milliseconds per frame."
              >CPU:</span
            >
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
          </div>
          <div class="control-group">
            <span
              class="control-label"
              :title="`Client GPU — source: ${gpuSourceLabel}. Raw renderMs avg/hi ${fmt4(renderMsAvg)} / ${fmt4(renderMsHi)} ms. Timer-query (when supported) shows the actual GPU-side execution time in milliseconds; otherwise shows renderer.render() wall-clock which is mostly CPU draw-call submission.`"
              >GPU:</span
            >
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
          </div>
          <div class="control-group">
            <span
              class="control-label"
              title="Total frame time — CPU + GPU wall-clock per frame (ms)"
              >FRAME:</span
            >
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
          </div>
          <div v-if="longtaskSupported" class="control-group">
            <!--
              Longtask API: any single main-thread task ≥50 ms counts. This
              shows how many ms per second of wall-clock time were "lost"
              to those long tasks — a direct CPU-saturation indicator that
              complements CPU ms (which can't distinguish sustained heavy
              work from a single giant stall). Scaled to 200 ms/sec = red
              (20% of wall-clock blocked).
            -->
            <span
              class="control-label"
              title="Long-task blocked time from PerformanceObserver — ms per second of wall-clock time lost to main-thread tasks ≥50 ms. 0 = smooth; 200+ = heavy main-thread contention. Not available in Safari."
              >LONG:</span
            >
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
          </div>
          <BarDivider />
          <div class="control-group">
            <span
              class="control-label"
              title="Client rendering frames per second"
              >FPS:</span
            >
            <div class="stat-bar-group">
              <div class="stat-bar">
                <div class="stat-bar-top">
                  <span class="fps-value">{{ fmt4(actualAvgFPS) }}</span>
                  <span class="fps-label">avg</span>
                </div>
                <div class="stat-bar-track">
                  <div
                    class="stat-bar-fill"
                    :style="statBarStyle(actualAvgFPS)"
                  ></div>
                </div>
              </div>
              <div class="stat-bar">
                <div class="stat-bar-top">
                  <span class="fps-value">{{ fmt4(actualWorstFPS) }}</span>
                  <span class="fps-label">low</span>
                </div>
                <div class="stat-bar-track">
                  <div
                    class="stat-bar-fill"
                    :style="statBarStyle(actualWorstFPS)"
                  ></div>
                </div>
              </div>
            </div>
          </div>
          <div class="control-group">
            <BarDivider />
            <div class="fps-stats">
              <span class="control-label" title="Current camera zoom level"
                >ZOOM:</span
              >
              <span class="fps-value">{{ fmt4(currentZoom) }}</span>
            </div>
          </div>
          <div class="control-group">
            <BarDivider />
            <span
              class="control-label"
              title="Snapshots received per second from server"
              >SPS:</span
            >
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
          </div>
          <!-- FSPS — full snapshots per second. Counts only keyframes
               (state.isDelta === false). The bar is scaled by the host's
               configured keyframeRatio × snapshotRate so a healthy
               host fills the bar. A high reading means the protocol
               is re-seeding statics often (catch-up cheap, late-joiner
               friendly); a low reading saves bandwidth at the cost of
               longer recovery if a delta gets lost. -->
          <div class="control-group">
            <BarDivider />
            <span
              class="control-label"
              title="Full keyframe snapshots received per second (state.isDelta === false). Driven by the host's keyframe ratio."
              >FSPS:</span
            >
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
          </div>
          <div class="control-group">
            <BarDivider />
            <span class="control-label">EVENTS:</span>
            <button
              class="control-btn"
              :class="{ active: audioSmoothing }"
              title="Smooth audio events across snapshot intervals"
              @click="toggleAudioSmoothing"
            >
              SMOOTH
            </button>
          </div>
          <div class="control-group">
            <BarDivider />
            <span class="control-label">MARKS:</span>
            <button
              class="control-btn"
              :class="{ active: burnMarks }"
              title="Draw scorch marks on the ground where beams and lasers hit"
              @click="toggleBurnMarks"
            >
              BURN
            </button>
          </div>
          <div class="control-group">
            <BarDivider />
            <span class="control-label">DRIFT:</span>
            <div class="button-group">
              <button
                class="control-btn"
                :class="{ active: driftMode === 'snap' }"
                title="Snap instantly to new server state"
                @click="changeDriftMode('snap')"
              >
                SNAP
              </button>
              <button
                class="control-btn"
                :class="{ active: driftMode === 'fast' }"
                title="Fast interpolation to server state"
                @click="changeDriftMode('fast')"
              >
                FAST
              </button>
              <button
                class="control-btn"
                :class="{ active: driftMode === 'mid' }"
                title="Medium interpolation to server state"
                @click="changeDriftMode('mid')"
              >
                MID
              </button>
              <button
                class="control-btn"
                :class="{ active: driftMode === 'slow' }"
                title="Slow interpolation to server state"
                @click="changeDriftMode('slow')"
              >
                SLOW
              </button>
            </div>
          </div>
          <div class="control-group">
            <BarDivider />
            <span class="control-label">PAN:</span>
            <button
              class="control-btn"
              :class="{ active: allPanActive }"
              title="Toggle all camera pan methods on/off"
              @click="toggleAllPan"
            >
              ALL
            </button>
            <div class="button-group">
              <button
                class="control-btn"
                :class="{ active: dragPanEnabled }"
                title="Middle-click drag to pan camera"
                @click="toggleDragPan"
              >
                DRAG
              </button>
              <button
                class="control-btn"
                :class="{ active: edgeScrollEnabled }"
                title="Edge scroll — move camera when mouse near viewport border"
                @click="toggleEdgeScroll"
              >
                EDGE
              </button>
            </div>
          </div>
          <div class="control-group">
            <BarDivider />
            <span class="control-label">LOD:</span>
            <button
              class="control-btn"
              :class="{
                active: graphicsQuality === 'auto' && !clientAnySolo,
                'active-level': graphicsQuality === 'auto' && clientAnySolo,
              }"
              title="Auto-adjust graphics quality (lowest of zoom, TPS, FPS, units)"
              @click="changeGraphicsQuality('auto')"
            >
              AUTO
            </button>
            <div class="button-group">
              <button
                v-if="LOD_SIGNALS_ENABLED.zoom"
                class="control-btn signal-btn"
                :class="{
                  'signal-off': clientSignalStates.zoom === 'off',
                  active: graphicsQuality === 'auto' && clientSignalStates.zoom === 'solo',
                  'active-level':
                    graphicsQuality === 'auto'
                    && clientSignalStates.zoom === 'active'
                    && !clientAnySolo,
                }"
                :title="`Zoom signal — click to cycle off / active / solo. Currently ${clientSignalStates.zoom}.`"
                @click="cycleClientSignal('zoom')"
              >
                ZOOM
              </button>
              <button
                v-if="LOD_SIGNALS_ENABLED.tps"
                class="control-btn signal-btn"
                :class="{
                  'signal-off': clientSignalStates.tps === 'off',
                  active: graphicsQuality === 'auto' && clientSignalStates.tps === 'solo',
                  'active-level':
                    graphicsQuality === 'auto'
                    && clientSignalStates.tps === 'active'
                    && !clientAnySolo
                    && hasServer,
                }"
                :title="`Server TPS signal — click to cycle off / active / solo. Currently ${clientSignalStates.tps}.`"
                @click="cycleClientSignal('tps')"
              >
                TPS
              </button>
              <button
                v-if="LOD_SIGNALS_ENABLED.fps"
                class="control-btn signal-btn"
                :class="{
                  'signal-off': clientSignalStates.fps === 'off',
                  active: graphicsQuality === 'auto' && clientSignalStates.fps === 'solo',
                  'active-level':
                    graphicsQuality === 'auto'
                    && clientSignalStates.fps === 'active'
                    && !clientAnySolo,
                }"
                :title="`Client FPS signal — click to cycle off / active / solo. Currently ${clientSignalStates.fps}.`"
                @click="cycleClientSignal('fps')"
              >
                FPS
              </button>
              <button
                v-if="LOD_SIGNALS_ENABLED.units"
                class="control-btn signal-btn"
                :class="{
                  'signal-off': clientSignalStates.units === 'off',
                  active: graphicsQuality === 'auto' && clientSignalStates.units === 'solo',
                  'active-level':
                    graphicsQuality === 'auto'
                    && clientSignalStates.units === 'active'
                    && !clientAnySolo,
                }"
                :title="`World fullness signal — click to cycle off / active / solo. Currently ${clientSignalStates.units}.`"
                @click="cycleClientSignal('units')"
              >
                UNITS
              </button>
            </div>
            <div class="button-group">
              <button
                v-for="opt in CLIENT_CONFIG.graphics.options"
                :key="opt.value"
                class="control-btn"
                :class="{
                  active: graphicsQuality === opt.value,
                  'active-level':
                    effectiveQuality === opt.value &&
                    graphicsQuality !== opt.value,
                }"
                :title="`${opt.value} graphics quality`"
                @click="changeGraphicsQuality(opt.value)"
              >
                {{ opt.label }}
              </button>
            </div>
          </div>
          <div class="control-group">
            <BarDivider />
            <span class="control-label">RENDER:</span>
            <div class="button-group">
              <button
                v-for="opt in CLIENT_CONFIG.render.options"
                :key="opt.value"
                class="control-btn"
                :class="{ active: renderMode === opt.value }"
                :title="
                  opt.value === 'window'
                    ? 'Render only visible window'
                    : opt.value === 'padded'
                      ? 'Render window plus padding'
                      : 'Render entire map'
                "
                @click="changeRenderMode(opt.value)"
              >
                {{ opt.label }}
              </button>
            </div>
          </div>
          <div class="control-group">
            <BarDivider />
            <span class="control-label">AUDIO:</span>
            <div class="button-group">
              <button
                v-for="opt in CLIENT_CONFIG.audio.options"
                :key="opt.value"
                class="control-btn"
                :class="{ active: audioScope === opt.value }"
                :title="
                  opt.value === 'window'
                    ? 'Play audio from visible area'
                    : opt.value === 'padded'
                      ? 'Play audio from visible area plus padding'
                      : 'Play audio from entire map'
                "
                @click="changeAudioScope(opt.value)"
              >
                {{ opt.label }}
              </button>
            </div>
          </div>
          <div class="control-group">
            <BarDivider />
            <span class="control-label">SOUNDS:</span>
            <button
              class="control-btn"
              :class="{ active: allSoundsActive }"
              title="Toggle all sound categories on/off"
              @click="toggleAllSounds"
            >F
              ALL
            </button>
            <div class="button-group">
              <button
                v-for="cat in SFX_CATEGORIES"
                :key="cat"
                class="control-btn"
                :class="{ active: soundToggles[cat] }"
                :title="SOUND_TOOLTIPS[cat]"
                @click="toggleSoundCategory(cat)"
              >
                {{ SOUND_LABELS[cat] }}
              </button>
            </div>
          </div>
          <div class="control-group">
            <BarDivider />
            <span class="control-label">MUSIC:</span>
            <button
              class="control-btn"
              :class="{ active: soundToggles.music }"
              :title="SOUND_TOOLTIPS.music"
              @click="toggleSoundCategory('music')"
            >
              {{ soundToggles.music ? 'ON' : 'OFF' }}
            </button>
          </div>
          <div class="control-group">
            <BarDivider />
            <span class="control-label">TURR RAD:</span>
            <button
              class="control-btn"
              :class="{ active: allRangesActive }"
              title="Toggle every turret-range viz on/off"
              @click="toggleAllRanges"
            >
              ALL
            </button>
            <div class="button-group">
              <button
                class="control-btn"
                :class="{ active: rangeToggles.trackAcquire }"
                title="Show tracking acquire range (start tracking target)"
                @click="toggleRange('trackAcquire')"
              >
                T.A
              </button>
              <button
                class="control-btn"
                :class="{ active: rangeToggles.trackRelease }"
                title="Show tracking release range (lose target)"
                @click="toggleRange('trackRelease')"
              >
                T.R
              </button>
              <button
                class="control-btn"
                :class="{ active: rangeToggles.engageAcquire }"
                title="Show engage acquire range (start firing)"
                @click="toggleRange('engageAcquire')"
              >
                E.A
              </button>
              <button
                class="control-btn"
                :class="{ active: rangeToggles.engageRelease }"
                title="Show engage release range (stop firing)"
                @click="toggleRange('engageRelease')"
              >
                E.R
              </button>
              <button
                class="control-btn"
                :class="{ active: rangeToggles.build }"
                title="Show build range"
                @click="toggleRange('build')"
              >
                BLD
              </button>
            </div>
          </div>
          <div class="control-group">
            <BarDivider />
            <span class="control-label">SHOT RAD:</span>
            <button
              class="control-btn"
              :class="{ active: allProjRangesActive }"
              title="Toggle every projectile-radius viz on/off"
              @click="toggleAllProjRanges"
            >
              ALL
            </button>
            <div class="button-group">
              <button
                class="control-btn"
                :class="{ active: projRangeToggles.collision }"
                title="Show projectile collision radius"
                @click="toggleProjRange('collision')"
              >
                COL
              </button>
              <button
                class="control-btn"
                :class="{ active: projRangeToggles.explosion }"
                title="Show projectile explosion radius"
                @click="toggleProjRange('explosion')"
              >
                EXP
              </button>
            </div>
          </div>
          <div class="control-group">
            <BarDivider />
            <span class="control-label">UNIT RAD:</span>
            <button
              class="control-btn"
              :class="{ active: allUnitRadiiActive }"
              title="Toggle every unit-radius viz on/off"
              @click="toggleAllUnitRadii"
            >
              ALL
            </button>
            <div class="button-group">
              <button
                class="control-btn"
                :class="{ active: unitRadiusToggles.visual }"
                title="Show unit scale radius (unitRadiusCollider.scale — rendering &amp; click detection)"
                @click="toggleUnitRadius('visual')"
              >
                SCAL
              </button>
              <button
                class="control-btn"
                :class="{ active: unitRadiusToggles.shot }"
                title="Show unit shot radius (unitRadiusCollider.shot — projectile/beam hit detection)"
                @click="toggleUnitRadius('shot')"
              >
                SHOT
              </button>
              <button
                class="control-btn"
                :class="{ active: unitRadiusToggles.push }"
                title="Show unit push radius (unitRadiusCollider.push — unit-unit push physics)"
                @click="toggleUnitRadius('push')"
              >
                PUSH
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Lobby Modal (full-screen overlay, covers bars too) -->
    <LobbyModal
      :visible="!isMobile && showLobby && !spectateMode"
      :is-host="isHost"
      :room-code="roomCode"
      :players="lobbyPlayers"
      :local-player-id="localPlayerId"
      :error="lobbyError"
      :is-connecting="isConnecting"
      @host="handleHost"
      @join="handleJoin"
      @start="handleLobbyStart"
      @cancel="handleLobbyCancel"
      @offline="handleOffline"
      @spectate="toggleSpectateMode"
    />

    <!-- Spectate mode toggle (show menu button when spectating) -->
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

    <!-- Combat Stats Modal -->
    <CombatStatsModal
      :visible="showCombatStats"
      :stats="combatStats"
      :view-mode="combatStatsViewMode"
      :stats-history="combatStatsHistory"
      @update:view-mode="combatStatsViewMode = $event"
      @close="showCombatStats = false"
    />

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
          {{ getPlayerName(gameOverWinner).toUpperCase() }} WINS!
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
  text-align: center;
  padding: 40px 60px;
  background: rgba(20, 20, 30, 0.95);
  border: 3px solid #4444aa;
  border-radius: 16px;
  box-shadow: 0 0 40px rgba(68, 68, 170, 0.5);
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

/* Spectate mode toggle button */
.spectate-toggle-btn {
  position: absolute;
  top: 12px;
  right: 12px;
  z-index: 3001;
  width: 36px;
  height: 36px;
  padding: 0;
  background: rgba(20, 20, 35, 0.9);
  border: 2px solid #4444aa;
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
  background: rgba(40, 40, 60, 0.95);
  border-color: #6666cc;
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
.bottom-controls {
  flex-shrink: 0;
  z-index: 3001;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  pointer-events: none;
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

.control-group {
  display: flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
}

.control-label {
  color: #888;
  font-size: 11px;
  text-transform: uppercase;
  white-space: nowrap;
}

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

.button-group {
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: 1fr;
}

.button-group .control-btn {
  border-radius: 0;
  margin-left: -1px;
  text-align: center;
  overflow: hidden;
}

.button-group .control-btn:first-child {
  border-radius: 3px 0 0 3px;
  margin-left: 0;
}

.button-group .control-btn:last-child {
  border-radius: 0 3px 3px 0;
}

.button-group.view-toggle {
  width: 105px;
}

.control-btn {
  padding: 3px 6px;
  background: rgba(60, 60, 60, 0.8);
  border: 1px solid #555;
  border-radius: 3px;
  color: #556;
  font-family: monospace;
  font-size: 10px;
  text-transform: uppercase;
  cursor: pointer;
  transition: all 0.15s ease;
}

.control-btn:hover {
  background: rgba(85, 85, 85, 0.9);
  border-color: #888;
  color: #99a;
}

.control-btn:active {
  background: rgba(50, 50, 50, 0.95);
  border-color: #666;
  color: #778;
  transition: all 0.05s ease;
}

.control-btn.active {
  background: var(--bar-active-bg);
  border-color: var(--bar-active-border);
  color: #fff;
}

.control-btn.active:hover {
  background: var(--bar-active-hover-bg);
  border-color: var(--bar-active-hover-border);
}

.control-btn.active:active {
  background: var(--bar-active-pressed-bg);
  border-color: var(--bar-active-pressed-border);
  transition: all 0.05s ease;
}

.control-btn.active-level {
  color: white;
}

/* Tri-state LOD signal buttons. ACTIVE = white text via .active-level
 * (defined above). SOLO = full background via .active. OFF = dim
 * via this class — visually conveys "this signal is parked, click
 * to bring it back into the mix." */
.control-btn.signal-btn.signal-off {
  opacity: 0.35;
}
.control-btn.signal-btn.signal-off:hover {
  opacity: 0.6;
}

.bar-readonly .control-btn {
  pointer-events: none;
  cursor: default;
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

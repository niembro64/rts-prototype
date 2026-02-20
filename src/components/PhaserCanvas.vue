<script setup lang="ts">
import { ref, reactive, onMounted, onUnmounted, computed, nextTick } from 'vue';
import { createGame, destroyGame, type GameInstance } from '../game/createGame';
import {
  type PlayerId,
  type WaypointType,
} from '../game/sim/types';
import SelectionPanel, {
  type SelectionInfo,
  type SelectionActions,
} from './SelectionPanel.vue';
import TopBar, { type EconomyInfo } from './TopBar.vue';
import Minimap, { type MinimapData } from './Minimap.vue';
import LobbyModal, { type LobbyPlayer } from './LobbyModal.vue';
import CombatStatsModal from './CombatStatsModal.vue';
import type {
  NetworkCombatStats,
  NetworkServerMeta,
} from '../game/network/NetworkTypes';
import type { StatsSnapshot } from './combatStatsUtils';
import {
  networkManager,
  type NetworkRole,
} from '../game/network/NetworkManager';
import {
  MAP_SETTINGS,
  SHOW_LOBBY_ON_STARTUP,
  COMBAT_STATS_HISTORY_MAX,
  COMBAT_STATS_VISIBLE_ON_LOAD,
} from '../config';
import { BUILDABLE_UNIT_IDS, getUnitBlueprint } from '../game/sim/blueprints';
import {
  CONTROL_BARS,
  type SnapshotRate,
  type KeyframeRatio,
  type TickRate,
} from '../controlBarConfig';
import {
  loadStoredSnapshotRate,
  saveSnapshotRate,
  loadStoredKeyframeRatio,
  saveKeyframeRatio,
  loadStoredTickRate,
  saveTickRate,
  loadStoredDemoUnits,
  saveDemoUnits,
  loadStoredMaxTotalUnits,
  saveMaxTotalUnits,
  loadStoredProjVelInherit,
  saveProjVelInherit,
} from './controlBarStorage';
import {
  formatDuration,
  fmt4,
  statBarStyle,
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
  getAudioScope,
  setAudioScope,
  getAudioSmoothing,
  setAudioSmoothing,
  getDriftMode,
  setDriftMode,
  getSoundToggle,
  setSoundToggle,
  SOUND_CATEGORIES,
  type GraphicsQuality,
  type RenderMode,
  type RangeType,
  type ProjRangeType,
  type UnitRadiusType,
  type AudioScope,
  type DriftMode,
  type SoundCategory,
} from '../game/render/graphicsSettings';
import { audioManager } from '../game/audio/AudioManager';
import { musicPlayer } from '../game/audio/MusicPlayer';

const containerRef = ref<HTMLDivElement | null>(null);
const backgroundContainerRef = ref<HTMLDivElement | null>(null);
const activePlayer = ref<PlayerId>(1);
const gameOverWinner = ref<PlayerId | null>(null);

// Background battle game instance (runs behind lobby)
let backgroundGameInstance: GameInstance | null = null;

// Current game server (owned by this component)
let currentServer: GameServer | null = null;
let backgroundServer: GameServer | null = null;

// Lobby state
const showLobby = ref(true);
const spectateMode = ref(!SHOW_LOBBY_ON_STARTUP); // When true, hide lobby to spectate background battle
const isHost = ref(false);
const roomCode = ref('');
const lobbyPlayers = ref<LobbyPlayer[]>([]);
const localPlayerId = ref<PlayerId>(1);
const lobbyError = ref<string | null>(null);
const isConnecting = ref(false);
const gameStarted = ref(false);
const networkRole = ref<NetworkRole>('offline');
const hasServer = ref(false); // True when we own a GameServer (host/offline/background)

// Server metadata received from snapshots (for remote clients to display server bar)
const serverMetaFromSnapshot = ref<NetworkServerMeta | null>(null);
const localIpAddress = ref<string>('N/A');
const clientTime = ref<string>('');

// Active connection for sending commands (set when server/connection is created)
let activeConnection: GameConnection | null = null;

// Demo battle unit type list (state read from snapshots)
const demoUnitTypes = BUILDABLE_UNIT_IDS;
const graphicsQuality = ref<GraphicsQuality>(getGraphicsQuality());
const effectiveQuality = ref<Exclude<GraphicsQuality, 'auto'>>(
  getEffectiveQuality(),
);
const renderMode = ref<RenderMode>(getRenderMode());
const audioScope = ref<AudioScope>(getAudioScope());
const audioSmoothing = ref<boolean>(getAudioSmoothing());
const driftMode = ref<DriftMode>(getDriftMode());
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
  see: getRangeToggle('see'),
  fire: getRangeToggle('fire'),
  release: getRangeToggle('release'),
  lock: getRangeToggle('lock'),
  fightstop: getRangeToggle('fightstop'),
  build: getRangeToggle('build'),
});
const projRangeToggles = reactive<Record<ProjRangeType, boolean>>({
  collision: getProjRangeToggle('collision'),
  primary: getProjRangeToggle('primary'),
  secondary: getProjRangeToggle('secondary'),
});
const unitRadiusToggles = reactive<Record<UnitRadiusType, boolean>>({
  collision: getUnitRadiusToggle('collision'),
  physics: getUnitRadiusToggle('physics'),
});

// FPS, snapshot rate, and zoom tracking (EMA-based, polled from scene)
const actualAvgFPS = ref(0);
const actualWorstFPS = ref(0);
const snapAvgRate = ref(0);
const snapWorstRate = ref(0);
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
  stockpile: 250,
  maxStockpile: 1000,
  income: 5,
  baseIncome: 5,
  production: 0,
  expenditure: 0,
  netFlow: 5,
  solarCount: 0,
  factoryCount: 0,
  unitCount: 1,
  unitCap: 60,
});

// Minimap state
const minimapData = reactive<MinimapData>({
  mapWidth: 2000,
  mapHeight: 2000,
  entities: [],
  cameraX: 0,
  cameraY: 0,
  cameraWidth: 800,
  cameraHeight: 600,
});

// Combat stats state
const combatStats = ref<NetworkCombatStats | null>(null);
const showCombatStats = ref(COMBAT_STATS_VISIBLE_ON_LOAD);
const combatStatsViewMode = ref<'global' | 'player'>('global');
const combatStatsHistory = ref<StatsSnapshot[]>([]);
let statsHistoryStartTime = 0;
const battleElapsed = ref('00:00:00');

let gameInstance: GameInstance | null = null;

// Polling interval IDs for cleanup
let checkBgSceneInterval: ReturnType<typeof setInterval> | null = null;
let checkSceneInterval: ReturnType<typeof setInterval> | null = null;
let clientTimeInterval: ReturnType<typeof setInterval> | null = null;

// Start the background battle (runs behind lobby)
function startBackgroundBattle(): void {
  if (backgroundGameInstance || !backgroundContainerRef.value) return;

  const rect = backgroundContainerRef.value.getBoundingClientRect();

  // Create a GameServer for background mode
  backgroundServer = new GameServer({
    playerIds: [1, 2, 3, 4] as PlayerId[],
    backgroundMode: true,
  });

  const bgConnection = new LocalGameConnection(backgroundServer);
  activeConnection = bgConnection;
  backgroundServer.setTickRate(loadStoredTickRate());
  backgroundServer.setSnapshotRate(loadStoredSnapshotRate());
  backgroundServer.setKeyframeRatio(loadStoredKeyframeRatio());
  backgroundServer.setIpAddress(localIpAddress.value);

  // Restore stored demo unit selection
  const storedDemoUnits = loadStoredDemoUnits();
  if (storedDemoUnits) {
    for (const ut of demoUnitTypes) {
      backgroundServer.setBackgroundUnitTypeEnabled(
        ut,
        storedDemoUnits.includes(ut),
      );
    }
  }

  // Restore stored max total units
  backgroundServer.receiveCommand({
    type: 'setMaxTotalUnits',
    tick: 0,
    maxTotalUnits: loadStoredMaxTotalUnits(),
  });

  backgroundServer.start();
  hasServer.value = true;

  backgroundGameInstance = createGame({
    parent: backgroundContainerRef.value,
    width: rect.width || window.innerWidth,
    height: rect.height || window.innerHeight,
    playerIds: [1, 2, 3, 4] as PlayerId[],
    localPlayerId: 1,
    gameConnection: bgConnection,
    mapWidth: MAP_SETTINGS.demo.width,
    mapHeight: MAP_SETTINGS.demo.height,
    backgroundMode: true,
  });

  // Wire combat stats callback for background scene
  let bgAttempts = 0;
  checkBgSceneInterval = setInterval(() => {
    bgAttempts++;
    if (bgAttempts > 50) {
      if (checkBgSceneInterval) clearInterval(checkBgSceneInterval);
      checkBgSceneInterval = null;
      return;
    }
    const bgScene = backgroundGameInstance?.getScene();
    if (bgScene) {
      bgScene.onCombatStatsUpdate = (stats: NetworkCombatStats) => {
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
      bgScene.onServerMetaUpdate = (meta: NetworkServerMeta) => {
        serverMetaFromSnapshot.value = meta;
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
  if (backgroundServer) {
    backgroundServer.stop();
    backgroundServer = null;
  }
  if (backgroundGameInstance) {
    destroyGame(backgroundGameInstance);
    backgroundGameInstance = null;
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
  const isSinglePlayer = lobbyPlayers.value.length === 1;
  const canToggle =
    networkRole.value === 'offline' ||
    (networkRole.value === 'host' && isSinglePlayer);
  return gameStarted.value && canToggle;
});

// Show server controls when we own a server OR when we receive server meta from snapshots (remote client)
const showServerControls = computed(
  () => hasServer.value || serverMetaFromSnapshot.value !== null,
);

// Server bar is read-only for remote clients (no local server)
const serverBarReadonly = computed(() => !hasServer.value);

// Bar color theming via CSS custom properties
type BarColorTheme =
  (typeof CONTROL_BARS.themes)[keyof typeof CONTROL_BARS.themes];
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
  barVars(
    serverBarReadonly.value
      ? CONTROL_BARS.themes.disabled
      : CONTROL_BARS.themes.battle,
  ),
);
const serverBarVars = computed(() =>
  barVars(
    serverBarReadonly.value
      ? CONTROL_BARS.themes.disabled
      : CONTROL_BARS.themes.server,
  ),
);
const clientBarVars = computed(() => barVars(CONTROL_BARS.themes.client));

const battleLabel = computed(() => {
  if (networkRole.value === 'client') return 'ONLINE BATTLE';
  if (networkRole.value === 'host' && lobbyPlayers.value.length > 1)
    return 'ONLINE BATTLE';
  return 'LOCAL BATTLE';
});

// Display values: always read from snapshot meta (server→snapshot→display)
const displayServerTpsAvg = computed(
  () => serverMetaFromSnapshot.value?.tpsAvg ?? 0,
);
const displayServerTpsWorst = computed(
  () => serverMetaFromSnapshot.value?.tpsWorst ?? 0,
);
const displayTickRate = computed(
  () =>
    serverMetaFromSnapshot.value?.tickRate ??
    CONTROL_BARS.server.tickRate.default,
);
const displaySnapshotRate = computed(
  () =>
    serverMetaFromSnapshot.value?.snapshotRate ??
    CONTROL_BARS.server.snapshot.default,
);
const displayKeyframeRatio = computed(
  () =>
    serverMetaFromSnapshot.value?.keyframeRatio ??
    CONTROL_BARS.server.keyframe.default,
);
const displayGridInfo = computed(
  () => serverMetaFromSnapshot.value?.sendGridInfo ?? false,
);
const displayServerTime = computed(
  () => serverMetaFromSnapshot.value?.serverTime ?? '',
);
const displayServerIp = computed(
  () => serverMetaFromSnapshot.value?.ipAddress ?? '',
);

// Show demo battle bar only during background demo (uses reactive refs only)
const isBackgroundBattle = computed(
  () => showLobby.value && !gameStarted.value && hasServer.value,
);

const allDemoUnitsActive = computed(() => {
  const allowed = serverMetaFromSnapshot.value?.allowedUnitTypes;
  if (!allowed) return true; // default is all enabled
  return demoUnitTypes.every((ut) => allowed.includes(ut));
});

function toggleDemoUnitType(unitType: string): void {
  const current =
    serverMetaFromSnapshot.value?.allowedUnitTypes?.includes(unitType) ?? true;
  activeConnection?.sendCommand({
    type: 'setBackgroundUnitType',
    tick: 0,
    unitType,
    enabled: !current,
  });

  // Persist updated unit list to localStorage
  const currentList = serverMetaFromSnapshot.value?.allowedUnitTypes ?? [
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
}

function toggleProjVelInherit(): void {
  const current =
    serverMetaFromSnapshot.value?.projVelInherit ??
    CONTROL_BARS.battle.projVelInherit.default;
  activeConnection?.sendCommand({
    type: 'setProjVelInherit',
    tick: 0,
    enabled: !current,
  });
  saveProjVelInherit(!current);
}

function resetDemoDefaults(): void {
  // All units enabled
  for (const ut of demoUnitTypes) {
    activeConnection?.sendCommand({
      type: 'setBackgroundUnitType',
      tick: 0,
      unitType: ut,
      enabled: true,
    });
  }
  saveDemoUnits([...demoUnitTypes]);
  changeMaxTotalUnits(CONTROL_BARS.battle.cap.default);
  activeConnection?.sendCommand({
    type: 'setProjVelInherit',
    tick: 0,
    enabled: false,
  });
}

function resetServerDefaults(): void {
  setTickRateValue(CONTROL_BARS.server.tickRate.default);
  setNetworkUpdateRate(CONTROL_BARS.server.snapshot.default);
  setKeyframeRatioValue(CONTROL_BARS.server.keyframe.default);
  if (displayGridInfo.value) {
    toggleSendGridInfo();
  }
}

function resetClientDefaults(): void {
  changeGraphicsQuality('auto');
  changeRenderMode('padded');
  changeAudioScope('padded');
  setAudioSmoothing(true);
  audioSmoothing.value = true;
  setDriftMode('slow');
  driftMode.value = 'slow';
  for (const rt of RANGE_TYPES) {
    if (rangeToggles[rt]) toggleRange(rt);
  }
  for (const prt of PROJ_RANGE_TYPES) {
    if (projRangeToggles[prt]) toggleProjRange(prt);
  }
  for (const urt of UNIT_RADIUS_TYPES) {
    if (unitRadiusToggles[urt]) toggleUnitRadius(urt);
  }
  // Reset sound toggles: all on except music
  const SOUND_DEFAULTS: Record<SoundCategory, boolean> = {
    fire: true,
    hit: false,
    dead: false,
    beam: false,
    field: true,
    music: false,
  };
  for (const cat of SOUND_CATEGORIES) {
    if (soundToggles[cat] !== SOUND_DEFAULTS[cat]) toggleSoundCategory(cat);
  }
}

function togglePlayer(): void {
  const scene = gameInstance?.getScene();
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
  networkRole.value = 'offline';
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
  queueUnit: (factoryId: number, weaponId: string) => {
    const scene = gameInstance?.getScene();
    scene?.queueFactoryUnit(factoryId, weaponId);
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
  networkRole.value = 'offline';
  roomCode.value = '';
  isHost.value = false;
  lobbyPlayers.value = [];
  lobbyError.value = null;
  isConnecting.value = false;
}

function handleOffline(): void {
  // Start game in offline mode without network
  networkRole.value = 'offline';
  localPlayerId.value = 1;

  // Create game immediately with single player
  nextTick(() => {
    startGameWithPlayers([1]);
  });
}

function toggleSpectateMode(): void {
  spectateMode.value = !spectateMode.value;
}

function changeGraphicsQuality(quality: GraphicsQuality): void {
  setGraphicsQuality(quality);
  graphicsQuality.value = quality;
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

function toggleAudioSmoothing(): void {
  const newValue = !audioSmoothing.value;
  setAudioSmoothing(newValue);
  audioSmoothing.value = newValue;
}

function changeDriftMode(mode: DriftMode): void {
  setDriftMode(mode);
  driftMode.value = mode;
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
  const scene = backgroundGameInstance?.getScene() ?? gameInstance?.getScene();
  if (scene) {
    currentZoom.value = scene.cameras.main.zoom;

    const frameStats = scene.getFrameStats();
    actualAvgFPS.value = frameStats.avgFps;
    actualWorstFPS.value = frameStats.worstFps;

    const snapStats = scene.getSnapshotStats();
    snapAvgRate.value = snapStats.avgRate;
    snapWorstRate.value = snapStats.worstRate;
  }
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

function startGameWithPlayers(playerIds: PlayerId[]): void {
  showLobby.value = false;
  gameStarted.value = true;

  // Stop the background battle first
  stopBackgroundBattle();

  // Small delay to ensure WebGL cleanup before creating new game
  setTimeout(() => {
    if (!containerRef.value) return;

    const rect = containerRef.value.getBoundingClientRect();

    let gameConnection: GameConnection;

    if (networkRole.value === 'host' || networkRole.value === 'offline') {
      // Create GameServer for host/offline
      currentServer = new GameServer({ playerIds });

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
      currentServer.setIpAddress(localIpAddress.value);
      currentServer.receiveCommand({
        type: 'setMaxTotalUnits',
        tick: 0,
        maxTotalUnits: loadStoredMaxTotalUnits(),
      });
      currentServer.receiveCommand({
        type: 'setProjVelInherit',
        tick: 0,
        enabled: loadStoredProjVelInherit(),
      });
      currentServer.start();
      hasServer.value = true;
    } else {
      // Client: create RemoteGameConnection wrapping networkManager
      const remoteConnection = new RemoteGameConnection();
      activeConnection = remoteConnection;
      gameConnection = remoteConnection;
    }

    // Create game with player configuration
    gameInstance = createGame({
      parent: containerRef.value!,
      width: rect.width || window.innerWidth,
      height: rect.height || window.innerHeight,
      playerIds,
      localPlayerId: localPlayerId.value,
      gameConnection,
      mapWidth: MAP_SETTINGS.game.width,
      mapHeight: MAP_SETTINGS.game.height,
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

      // Minimap data callback
      scene.onMinimapUpdate = (data: MinimapData) => {
        minimapData.entities = data.entities;
        minimapData.cameraX = data.cameraX;
        minimapData.cameraY = data.cameraY;
        minimapData.cameraWidth = data.cameraWidth;
        minimapData.cameraHeight = data.cameraHeight;
        minimapData.mapWidth = data.mapWidth;
        minimapData.mapHeight = data.mapHeight;
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
      scene.onCombatStatsUpdate = (stats: NetworkCombatStats) => {
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
      scene.onServerMetaUpdate = (meta: NetworkServerMeta) => {
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

function setKeyframeRatioValue(ratio: KeyframeRatio): void {
  activeConnection?.sendCommand({ type: 'setKeyframeRatio', tick: 0, ratio });
  saveKeyframeRatio(ratio);
}

function toggleSendGridInfo(): void {
  const current = serverMetaFromSnapshot.value?.sendGridInfo ?? false;
  activeConnection?.sendCommand({
    type: 'setSendGridInfo',
    tick: 0,
    enabled: !current,
  });
}

function dismissGameOver(): void {
  gameOverWinner.value = null;
}

function handleCombatStatsKeydown(e: KeyboardEvent): void {
  if (e.key === '`') {
    showCombatStats.value = !showCombatStats.value;
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
      backgroundServer?.setIpAddress(localIpAddress.value);
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
    <!-- Background battle container (runs behind lobby) -->
    <div
      ref="backgroundContainerRef"
      class="background-battle-container"
      v-show="showLobby"
    ></div>

    <!-- Main game container -->
    <div ref="containerRef" class="phaser-container" v-show="!showLobby"></div>

    <!-- Lobby Modal -->
    <LobbyModal
      :visible="showLobby && !spectateMode"
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
      v-if="showLobby && spectateMode"
      class="spectate-toggle-btn"
      @click="toggleSpectateMode"
      title="Show Menu"
    >
      ☰
    </button>

    <!-- Bottom control bars (always visible) -->
    <div class="bottom-controls">
      <!-- BATTLE CONTROLS -->
      <div
        v-if="showServerControls"
        class="control-bar"
        :class="{ 'bar-readonly': serverBarReadonly }"
        :style="battleBarVars"
      >
        <div class="control-group">
          <button
            class="control-btn active bar-label"
            title="Click to reset battle settings to defaults"
            @click="resetDemoDefaults"
          >
            <span class="bar-label-text">{{ battleLabel }}</span
            ><span class="bar-label-hover">DEFAULTS</span>
          </button>
          <span class="time-display" title="Battle elapsed time">{{
            battleElapsed
          }}</span>
        </div>
        <div class="control-group">
          <div class="bar-divider"></div>
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
                  serverMetaFromSnapshot?.allowedUnitTypes?.includes(ut) ??
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
          <div class="bar-divider"></div>
          <span class="control-label">CAP:</span>
          <div class="button-group">
            <button
              v-for="opt in CONTROL_BARS.battle.cap.options"
              :key="opt.value"
              class="control-btn"
              :class="{
                active: serverMetaFromSnapshot?.maxTotalUnits === opt.value,
              }"
              :title="`Max ${opt.value} total units in demo battle`"
              @click="changeMaxTotalUnits(opt.value)"
            >
              {{ opt.label }}
            </button>
          </div>
        </div>
        <div class="control-group">
          <div class="bar-divider"></div>
          <span class="control-label">PROJ VEL:</span>
          <button
            class="control-btn"
            :class="{ active: serverMetaFromSnapshot?.projVelInherit }"
            title="Projectiles inherit firing unit's velocity"
            @click="toggleProjVelInherit"
          >
            INHERIT
          </button>
        </div>
      </div>

      <!-- SERVER CONTROLS (visible when we own a server or receive server meta) -->
      <div
        v-if="showServerControls"
        class="control-bar"
        :class="{ 'bar-readonly': serverBarReadonly }"
        :style="serverBarVars"
      >
        <div class="control-group">
          <button
            class="control-btn active bar-label"
            title="Click to reset server settings to defaults"
            @click="resetServerDefaults"
          >
            <span class="bar-label-text">HOST SERVER</span
            ><span class="bar-label-hover">DEFAULTS</span>
          </button>
          <span
            v-if="displayServerTime"
            class="time-display"
            title="Server wall-clock time"
            >{{ displayServerTime }}</span
          >
        </div>
        <div class="control-group">
          <div class="bar-divider"></div>
          <span
            v-if="displayServerIp"
            class="ip-display"
            title="Server IP address"
            >{{ displayServerIp }}</span
          >
        </div>
        <div class="control-group">
          <div v-if="displayServerIp" class="bar-divider"></div>
          <span class="control-label">MAX TICKS/S:</span>
          <div class="button-group">
            <button
              v-for="rate in CONTROL_BARS.server.tickRate.options"
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
          <div class="bar-divider"></div>
          <span class="control-label" title="Server simulation ticks per second"
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
                    statBarStyle(displayServerTpsAvg, 60, serverBarReadonly)
                  "
                ></div>
              </div>
            </div>
            <div class="stat-bar">
              <div class="stat-bar-top">
                <span class="fps-value">{{ fmt4(displayServerTpsWorst) }}</span>
                <span class="fps-label">low</span>
              </div>
              <div class="stat-bar-track">
                <div
                  class="stat-bar-fill"
                  :style="
                    statBarStyle(displayServerTpsWorst, 60, serverBarReadonly)
                  "
                ></div>
              </div>
            </div>
          </div>
        </div>
        <div class="control-group">
          <div class="bar-divider"></div>
          <span class="control-label">MAX SNAPS/S:</span>
          <div class="button-group">
            <button
              v-for="rate in CONTROL_BARS.server.snapshot.options"
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
          <div class="bar-divider"></div>
          <span class="control-label">FULLSNAP:</span>
          <div class="button-group">
            <button
              v-for="opt in CONTROL_BARS.server.keyframe.options"
              :key="String(opt)"
              class="control-btn"
              :class="{ active: displayKeyframeRatio === opt }"
              :title="
                opt === 'ALL'
                  ? 'Every snapshot is a full keyframe'
                  : opt === 'NONE'
                    ? 'Never send full keyframes (delta only)'
                    : `Full keyframe probability: ${opt}`
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
          <div class="bar-divider"></div>
          <button
            class="control-btn"
            :class="{ active: displayGridInfo }"
            title="Include spatial grid debug info in snapshots"
            @click="toggleSendGridInfo"
          >
            GRID
          </button>
        </div>
      </div>

      <!-- CLIENT CONTROLS (always visible) -->
      <div class="control-bar" :style="clientBarVars">
        <div class="control-group">
          <button
            class="control-btn active bar-label"
            title="Click to reset client settings to defaults"
            @click="resetClientDefaults"
          >
            <span class="bar-label-text">PLAYER CLIENT</span
            ><span class="bar-label-hover">DEFAULTS</span>
          </button>
          <span
            v-if="clientTime"
            class="time-display"
            title="Client wall-clock time"
            >{{ clientTime }}</span
          >
        </div>
        <div class="control-group">
          <div class="bar-divider"></div>
          <span
            v-if="localIpAddress !== 'N/A'"
            class="ip-display"
            title="Public IP address"
            >{{ localIpAddress }}</span
          >
        </div>
        <div class="control-group">
          <div v-if="localIpAddress !== 'N/A'" class="bar-divider"></div>
          <span class="control-label" title="Client rendering frames per second"
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
          <div class="bar-divider"></div>
          <div class="fps-stats">
            <span class="control-label" title="Current camera zoom level"
              >ZOOM:</span
            >
            <span class="fps-value">{{ fmt4(currentZoom) }}</span>
          </div>
        </div>
        <div class="control-group">
          <div class="bar-divider"></div>
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
                      displaySnapshotRate === 'none' ? 60 : displaySnapshotRate,
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
                      displaySnapshotRate === 'none' ? 60 : displaySnapshotRate,
                    )
                  "
                ></div>
              </div>
            </div>
          </div>
        </div>
        <div class="control-group">
          <div class="bar-divider"></div>
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
          <div class="bar-divider"></div>
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
              :class="{ active: driftMode === 'slow' }"
              title="Slow interpolation to server state"
              @click="changeDriftMode('slow')"
            >
              SLOW
            </button>
          </div>
        </div>
        <div class="control-group">
          <div class="bar-divider"></div>
          <span class="control-label">LOD:</span>
          <button
            class="control-btn"
            :class="{ active: graphicsQuality === 'auto' }"
            title="Automatically adjust graphics quality based on FPS"
            @click="changeGraphicsQuality('auto')"
          >
            AUTO
          </button>
          <div class="button-group">
            <button
              v-for="opt in CONTROL_BARS.client.graphics.options"
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
          <div class="bar-divider"></div>
          <span class="control-label">RENDER:</span>
          <div class="button-group">
            <button
              v-for="opt in CONTROL_BARS.client.render.options"
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
          <div class="bar-divider"></div>
          <span class="control-label">AUDIO:</span>
          <div class="button-group">
            <button
              v-for="opt in CONTROL_BARS.client.audio.options"
              :key="opt.value"
              class="control-btn"
              :class="{ active: audioScope === opt.value }"
              :title="
                opt.value === 'off'
                  ? 'Audio disabled'
                  : opt.value === 'window'
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
          <div class="bar-divider"></div>
          <span class="control-label">SOUNDS:</span>
          <div class="button-group">
            <button
              v-for="cat in SOUND_CATEGORIES"
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
          <div class="bar-divider"></div>
          <span class="control-label">TUR RAD:</span>
          <div class="button-group">
            <button
              class="control-btn"
              :class="{ active: rangeToggles.see }"
              title="Show turret see range (target acquisition)"
              @click="toggleRange('see')"
            >
              SEE
            </button>
            <button
              class="control-btn"
              :class="{ active: rangeToggles.fire }"
              title="Show turret fire range (begin shooting)"
              @click="toggleRange('fire')"
            >
              FIR
            </button>
            <button
              class="control-btn"
              :class="{ active: rangeToggles.release }"
              title="Show turret release range (stop tracking)"
              @click="toggleRange('release')"
            >
              REL
            </button>
            <button
              class="control-btn"
              :class="{ active: rangeToggles.lock }"
              title="Show turret lock range (maintain lock)"
              @click="toggleRange('lock')"
            >
              LCK
            </button>
            <button
              class="control-btn"
              :class="{ active: rangeToggles.fightstop }"
              title="Show fight-stop range (stop pursuing)"
              @click="toggleRange('fightstop')"
            >
              STP
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
          <div class="bar-divider"></div>
          <span class="control-label">PROJ RAD:</span>
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
              :class="{ active: projRangeToggles.primary }"
              title="Show projectile primary damage radius"
              @click="toggleProjRange('primary')"
            >
              PRM
            </button>
            <button
              class="control-btn"
              :class="{ active: projRangeToggles.secondary }"
              title="Show projectile secondary damage radius"
              @click="toggleProjRange('secondary')"
            >
              SEC
            </button>
          </div>
        </div>
        <div class="control-group">
          <div class="bar-divider"></div>
          <span class="control-label">UNIT RAD:</span>
          <div class="button-group">
            <button
              class="control-btn"
              :class="{ active: unitRadiusToggles.collision }"
              title="Show unit collision radius"
              @click="toggleUnitRadius('collision')"
            >
              COL
            </button>
            <button
              class="control-btn"
              :class="{ active: unitRadiusToggles.physics }"
              title="Show unit physics radius"
              @click="toggleUnitRadius('physics')"
            >
              PHY
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Game UI (only when game is running) -->
    <template v-if="gameStarted && !showLobby">
      <!-- Top bar with economy info -->
      <TopBar
        :economy="economyInfo"
        :player-name="getPlayerName(activePlayer)"
        :player-color="getPlayerColor(activePlayer)"
      />

      <!-- Player toggle (single-player only) -->
      <div v-if="showPlayerToggle" class="ui-overlay top-right">
        <button
          class="player-toggle-btn"
          :style="{ borderColor: getPlayerColor(activePlayer) }"
          @click="togglePlayer"
        >
          <span
            class="player-indicator"
            :style="{ backgroundColor: getPlayerColor(activePlayer) }"
          ></span>
          <span class="player-label">{{ getPlayerName(activePlayer) }}</span>
          <span class="toggle-hint">(Click to switch)</span>
        </button>
      </div>

      <!-- Selection panel (bottom-left) -->
      <SelectionPanel :selection="selectionInfo" :actions="selectionActions" />

      <!-- Minimap (bottom-right) -->
      <Minimap :data="minimapData" @click="handleMinimapClick" />
    </template>

    <!-- Combat Stats Modal -->
    <CombatStatsModal
      :visible="showCombatStats"
      :stats="combatStats"
      :view-mode="combatStatsViewMode"
      :stats-history="combatStatsHistory"
      @update:view-mode="combatStatsViewMode = $event"
      @close="showCombatStats = false"
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

.ui-overlay.top-right {
  position: absolute;
  top: 10px;
  right: 10px;
  z-index: 1000;
  pointer-events: none;
}

.player-toggle-btn {
  pointer-events: auto;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 16px;
  background: rgba(0, 0, 0, 0.8);
  border: 2px solid;
  border-radius: 8px;
  color: white;
  font-family: monospace;
  font-size: 14px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.player-toggle-btn:hover {
  background: rgba(0, 0, 0, 0.9);
  transform: scale(1.02);
}

.player-toggle-btn:active {
  transform: scale(0.98);
}

.player-indicator {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  border: 2px solid rgba(255, 255, 255, 0.5);
}

.player-label {
  font-weight: bold;
  font-size: 16px;
}

.toggle-hint {
  font-size: 11px;
  opacity: 0.6;
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

/* Bottom control bars */
.bottom-controls {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  z-index: 3001;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  pointer-events: none;
}

.control-bar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
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

.control-bar:not(:last-child) {
  border-bottom: none;
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

.bar-divider {
  width: 1px;
  height: 14px;
  background: #444;
  margin: 0 4px;
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

.control-btn {
  padding: 3px 6px;
  background: rgba(60, 60, 60, 0.8);
  border: 1px solid #555;
  border-radius: 3px;
  color: #aaa;
  font-family: monospace;
  font-size: 10px;
  text-transform: uppercase;
  cursor: pointer;
  transition: all 0.15s ease;
}

.control-btn:hover {
  background: rgba(85, 85, 85, 0.9);
  border-color: #888;
  color: #ddd;
}

.control-btn:active {
  background: rgba(50, 50, 50, 0.95);
  border-color: #666;
  color: #ccc;
  transition: all 0.05s ease;
}

.control-btn.active {
  background: var(--bar-active-bg);
  border-color: var(--bar-active-border);
  color: white;
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
  color: #888;
  white-space: nowrap;
}
</style>

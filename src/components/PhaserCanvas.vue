<script setup lang="ts">
import { ref, reactive, onMounted, onUnmounted, computed, nextTick } from 'vue';
import { createGame, destroyGame, type GameInstance } from '../game/createGame';
import { PLAYER_COLORS, type PlayerId, type WaypointType } from '../game/sim/types';
import SelectionPanel, { type SelectionInfo, type SelectionActions } from './SelectionPanel.vue';
import TopBar, { type EconomyInfo } from './TopBar.vue';
import Minimap, { type MinimapData } from './Minimap.vue';
import LobbyModal, { type LobbyPlayer } from './LobbyModal.vue';
import { networkManager, type NetworkRole } from '../game/network/NetworkManager';
import { DEFAULT_NETWORK_UPDATES_PER_SECOND, MAP_WIDTH, MAP_HEIGHT, BACKGROUND_MAP_WIDTH, BACKGROUND_MAP_HEIGHT } from '../config';
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
  type GraphicsQuality,
  type RenderMode,
} from '../game/render/graphicsSettings';
import { audioManager } from '../game/audio/AudioManager';

// Available update rate options
const UPDATE_RATE_OPTIONS = [1, 5, 10, 30] as const;

// Graphics quality options - Auto is separate from quality levels
const GRAPHICS_QUALITY_LEVELS: { value: GraphicsQuality; label: string }[] = [
  { value: 'min', label: 'Min' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Med' },
  { value: 'high', label: 'High' },
  { value: 'max', label: 'Max' },
];

// Render mode options
const RENDER_OPTIONS: { value: RenderMode; label: string }[] = [
  { value: 'window', label: 'Visual' },
  { value: 'all', label: 'All' },
];

// Audio options
const AUDIO_OPTIONS: { value: boolean; label: string }[] = [
  { value: true, label: 'On' },
  { value: false, label: 'Off' },
];

const containerRef = ref<HTMLDivElement | null>(null);
const backgroundContainerRef = ref<HTMLDivElement | null>(null);
const activePlayer = ref<PlayerId>(1);
const gameOverWinner = ref<PlayerId | null>(null);

// Background battle game instance (runs behind lobby)
let backgroundGameInstance: GameInstance | null = null;

// Current game server (owned by this component)
let currentServer: GameServer | null = null;
let currentConnection: GameConnection | null = null;
let backgroundServer: GameServer | null = null;

// Lobby state
const showLobby = ref(true);
const spectateMode = ref(false); // When true, hide lobby to spectate background battle
const isHost = ref(false);
const roomCode = ref('');
const lobbyPlayers = ref<LobbyPlayer[]>([]);
const localPlayerId = ref<PlayerId>(1);
const lobbyError = ref<string | null>(null);
const isConnecting = ref(false);
const gameStarted = ref(false);
const networkRole = ref<NetworkRole>('offline');
const networkUpdatesPerSecond = ref(DEFAULT_NETWORK_UPDATES_PER_SECOND);
const graphicsQuality = ref<GraphicsQuality>(getGraphicsQuality());
const effectiveQuality = ref<Exclude<GraphicsQuality, 'auto'>>(getEffectiveQuality());
const renderMode = ref<RenderMode>(getRenderMode());
const audioEnabled = ref(!audioManager.muted);

// FPS and zoom tracking (Phaser's smoothed values)
const meanFPS = ref(0);
const lowFPS = ref(0);
// Actual frame delta measurements (our own tracking)
const actualAvgFPS = ref(0);
const actualWorstFPS = ref(0);
const currentZoom = ref(0.4);
const fpsHistory: number[] = [];
const FPS_HISTORY_SIZE = 1000; // ~16 seconds of samples at 60fps
let fpsUpdateInterval: ReturnType<typeof setInterval> | null = null;

// Selection state for the panel
const selectionInfo = reactive<SelectionInfo>({
  unitCount: 0,
  hasCommander: false,
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

let gameInstance: GameInstance | null = null;

// Start the background battle (runs behind lobby)
function startBackgroundBattle(): void {
  if (backgroundGameInstance || !backgroundContainerRef.value) return;

  const rect = backgroundContainerRef.value.getBoundingClientRect();

  // Create a GameServer for background mode
  backgroundServer = new GameServer({
    playerIds: [1, 2, 3, 4] as PlayerId[],
    backgroundMode: true,
    snapshotRate: DEFAULT_NETWORK_UPDATES_PER_SECOND,
  });

  const bgConnection = new LocalGameConnection(backgroundServer);
  backgroundServer.start();

  backgroundGameInstance = createGame({
    parent: backgroundContainerRef.value,
    width: rect.width || window.innerWidth,
    height: rect.height || window.innerHeight,
    playerIds: [1, 2, 3, 4] as PlayerId[],
    localPlayerId: 1,
    gameConnection: bgConnection,
    mapWidth: BACKGROUND_MAP_WIDTH,
    mapHeight: BACKGROUND_MAP_HEIGHT,
    backgroundMode: true,
  });
}

// Stop the background battle
function stopBackgroundBattle(): void {
  if (backgroundServer) {
    backgroundServer.stop();
    backgroundServer = null;
  }
  if (backgroundGameInstance) {
    destroyGame(backgroundGameInstance);
    backgroundGameInstance = null;
  }
}

// Show player toggle only in single-player mode (offline or hosting alone)
const showPlayerToggle = computed(() => {
  const isSinglePlayer = lobbyPlayers.value.length === 1;
  const canToggle = networkRole.value === 'offline' || (networkRole.value === 'host' && isSinglePlayer);
  return gameStarted.value && canToggle;
});

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
  currentConnection = null;

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

function getPlayerColor(playerId: PlayerId): string {
  const color = PLAYER_COLORS[playerId]?.primary ?? 0x888888;
  return '#' + color.toString(16).padStart(6, '0');
}

function getPlayerName(playerId: PlayerId): string {
  return PLAYER_COLORS[playerId]?.name ?? 'Unknown';
}

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
    lobbyPlayers.value = [{
      playerId: 1,
      name: 'Red',
      isHost: true,
    }];

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

function setAudioEnabled(enabled: boolean): void {
  audioManager.setMuted(!enabled);
  audioEnabled.value = enabled;
}

function updateFPSStats(): void {
  // Get FPS from whichever game instance is active
  const game = backgroundGameInstance?.game ?? gameInstance?.game;
  if (!game) return;

  const currentFPS = game.loop.actualFps;

  // Add to history
  fpsHistory.push(currentFPS);
  if (fpsHistory.length > FPS_HISTORY_SIZE) {
    fpsHistory.shift();
  }

  if (fpsHistory.length > 0) {
    // Calculate mean
    const sum = fpsHistory.reduce((a, b) => a + b, 0);
    meanFPS.value = sum / fpsHistory.length;

    // Calculate 99% low (1st percentile - value that 99% of frames are above)
    const sorted = [...fpsHistory].sort((a, b) => a - b);
    const percentileIndex = Math.floor(sorted.length * 0.01);
    lowFPS.value = sorted[percentileIndex] ?? sorted[0];
  }

  // Update zoom level and effective quality
  const scene = backgroundGameInstance?.getScene() ?? gameInstance?.getScene();
  if (scene) {
    currentZoom.value = scene.cameras.main.zoom;

    // Get actual frame delta stats from scene
    const frameStats = scene.getFrameStats();
    actualAvgFPS.value = frameStats.avgFps;
    actualWorstFPS.value = frameStats.worstFps;
  }
  effectiveQuality.value = getEffectiveQuality();
}

function setupNetworkCallbacks(): void {
  networkManager.onPlayerJoined = (player: LobbyPlayer) => {
    // Check if already in list
    const existing = lobbyPlayers.value.find(p => p.playerId === player.playerId);
    if (!existing) {
      lobbyPlayers.value = [...lobbyPlayers.value, player];
    }
  };

  networkManager.onPlayerLeft = (playerId: PlayerId) => {
    lobbyPlayers.value = lobbyPlayers.value.filter(p => p.playerId !== playerId);
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
      currentServer = new GameServer({
        playerIds,
        snapshotRate: networkUpdatesPerSecond.value,
      });

      // Create LocalGameConnection for the host client
      const localConnection = new LocalGameConnection(currentServer);
      gameConnection = localConnection;
      currentConnection = localConnection;

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

      // Start the server
      currentServer.start();
    } else {
      // Client: create RemoteGameConnection wrapping networkManager
      const remoteConnection = new RemoteGameConnection();
      gameConnection = remoteConnection;
      currentConnection = remoteConnection;
    }

    // Create game with player configuration
    gameInstance = createGame({
      parent: containerRef.value!,
      width: rect.width || window.innerWidth,
      height: rect.height || window.innerHeight,
      playerIds,
      localPlayerId: localPlayerId.value,
      gameConnection,
      mapWidth: MAP_WIDTH,
      mapHeight: MAP_HEIGHT,
      backgroundMode: false,
    });

    // Setup scene callbacks
    setupSceneCallbacks();
  }, 100);
}

function setupSceneCallbacks(): void {
  const checkScene = setInterval(() => {
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

      clearInterval(checkScene);
    }
  }, 100);
}

function setNetworkUpdateRate(rate: number): void {
  networkUpdatesPerSecond.value = rate;
  // Update the server's snapshot rate directly
  if (currentServer) {
    currentServer.setSnapshotRate(rate);
  }
}

onMounted(() => {
  // Start the background battle behind the lobby
  nextTick(() => {
    startBackgroundBattle();
  });

  // Start FPS tracking
  fpsUpdateInterval = setInterval(updateFPSStats, 100); // Update 10x per second
});

onUnmounted(() => {
  if (fpsUpdateInterval) {
    clearInterval(fpsUpdateInterval);
  }
  // Stop servers
  if (currentServer) {
    currentServer.stop();
    currentServer = null;
  }
  currentConnection = null;
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
    <div ref="backgroundContainerRef" class="background-battle-container" v-show="showLobby"></div>

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

    <!-- Graphics quality toggle (always visible) -->
    <div class="graphics-options">
      <div class="fps-stats">
        <span class="fps-label">actual:</span>
        <span class="fps-value">{{ actualAvgFPS.toFixed(1) }}</span>
        <span class="fps-label">avg</span>
        <span class="fps-value">{{ actualWorstFPS.toFixed(1) }}</span>
        <span class="fps-label">worst</span>
        <span class="fps-divider">|</span>
        <span class="fps-label">phaser:</span>
        <span class="fps-value">{{ meanFPS.toFixed(1) }}</span>
        <span class="fps-label">avg</span>
        <span class="fps-value">{{ lowFPS.toFixed(1) }}</span>
        <span class="fps-label">low</span>
        <span class="fps-divider">|</span>
        <span class="fps-value">{{ currentZoom.toFixed(2) }}</span>
        <span class="fps-label">zoom</span>
      </div>
      <div class="gfx-divider"></div>
      <span class="graphics-label">Detail:</span>
      <button
        class="graphics-btn"
        :class="{ active: graphicsQuality === 'auto' }"
        @click="changeGraphicsQuality('auto')"
      >
        Auto
      </button>
      <div class="button-group">
        <button
          v-for="opt in GRAPHICS_QUALITY_LEVELS"
          :key="opt.value"
          class="graphics-btn"
          :class="{
            active: graphicsQuality === opt.value,
            'active-level': effectiveQuality === opt.value && graphicsQuality !== opt.value
          }"
          @click="changeGraphicsQuality(opt.value)"
        >
          {{ opt.label }}
        </button>
      </div>
      <div class="gfx-divider"></div>
      <span class="graphics-label">Render:</span>
      <div class="button-group">
        <button
          v-for="opt in RENDER_OPTIONS"
          :key="opt.value"
          class="graphics-btn"
          :class="{ active: renderMode === opt.value }"
          @click="changeRenderMode(opt.value)"
        >
          {{ opt.label }}
        </button>
      </div>
      <div class="gfx-divider"></div>
      <span class="graphics-label">Audio:</span>
      <div class="button-group">
        <button
          v-for="opt in AUDIO_OPTIONS"
          :key="opt.value.toString()"
          class="graphics-btn"
          :class="{ active: audioEnabled === opt.value }"
          @click="setAudioEnabled(opt.value)"
        >
          {{ opt.label }}
        </button>
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
          <span class="player-indicator" :style="{ backgroundColor: getPlayerColor(activePlayer) }"></span>
          <span class="player-label">{{ getPlayerName(activePlayer) }}</span>
          <span class="toggle-hint">(Click to switch)</span>
        </button>
      </div>

      <!-- Host Options (host and offline) -->
      <div v-if="networkRole === 'host' || networkRole === 'offline'" class="ui-overlay top-right-below">
        <div class="host-options">
          <div class="host-options-title">Host Options</div>

          <!-- Network Update Rate -->
          <div class="option-row">
            <span class="option-label">Updates/sec:</span>
            <div class="option-buttons">
              <button
                v-for="rate in UPDATE_RATE_OPTIONS"
                :key="rate"
                class="option-btn"
                :class="{ active: networkUpdatesPerSecond === rate }"
                @click="setNetworkUpdateRate(rate)"
              >
                {{ rate }}
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- Selection panel (bottom-left) -->
      <SelectionPanel :selection="selectionInfo" :actions="selectionActions" />

      <!-- Minimap (bottom-right) -->
      <Minimap :data="minimapData" @click="handleMinimapClick" />
    </template>

    <!-- Game Over Modal -->
    <div v-if="gameOverWinner !== null" class="game-over-modal">
      <div class="game-over-content">
        <h1 class="winner-text" :style="{ color: getPlayerColor(gameOverWinner) }">
          {{ getPlayerName(gameOverWinner).toUpperCase() }} WINS!
        </h1>
        <p class="loser-text">
          All other commanders were destroyed
        </p>
        <p class="restart-hint">Press R to return to lobby</p>
        <button class="restart-btn" @click="restartGame">Return to Lobby</button>
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

/* Game Over Modal */
.game-over-modal {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.8);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 2000;
}

.game-over-content {
  text-align: center;
  padding: 40px 60px;
  background: rgba(20, 20, 30, 0.95);
  border: 3px solid #4444aa;
  border-radius: 16px;
  box-shadow: 0 0 40px rgba(68, 68, 170, 0.5);
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

.restart-hint {
  font-family: monospace;
  font-size: 16px;
  color: #888888;
  margin: 0 0 20px 0;
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

/* Host Options Panel */
.ui-overlay.top-right-below {
  position: absolute;
  top: 60px;
  right: 10px;
  z-index: 1000;
  pointer-events: none;
}

.host-options {
  pointer-events: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 14px;
  background: rgba(0, 0, 0, 0.85);
  border: 2px solid #666;
  border-radius: 8px;
  font-family: monospace;
  min-width: 200px;
}

.host-options-title {
  color: #4488ff;
  font-size: 11px;
  font-weight: bold;
  text-transform: uppercase;
  letter-spacing: 1px;
  padding-bottom: 4px;
  border-bottom: 1px solid #444;
  margin-bottom: 2px;
}

.option-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.option-label {
  color: #aaa;
  font-size: 12px;
  white-space: nowrap;
}

.option-buttons {
  display: flex;
  gap: 4px;
}

.option-btn {
  padding: 4px 10px;
  background: rgba(60, 60, 60, 0.9);
  border: 1px solid #555;
  border-radius: 4px;
  color: #ccc;
  font-family: monospace;
  font-size: 11px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.option-btn:hover {
  background: rgba(80, 80, 80, 0.9);
  border-color: #777;
}

.option-btn.active {
  background: rgba(68, 68, 170, 0.9);
  border-color: #6666cc;
  color: white;
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

/* Graphics quality options */
.graphics-options {
  position: absolute;
  bottom: 12px;
  right: 12px;
  z-index: 3001;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  background: rgba(0, 0, 0, 0.7);
  border: 1px solid #444;
  border-radius: 6px;
  font-family: monospace;
}

.fps-stats {
  display: flex;
  align-items: baseline;
  gap: 3px;
}

.fps-value {
  color: #48f;
  font-size: 13px;
  font-weight: bold;
  min-width: 24px;
  text-align: right;
}

.fps-label {
  color: #666;
  font-size: 9px;
  text-transform: uppercase;
  margin-right: 4px;
}

.fps-divider {
  color: #444;
  margin: 0 6px;
}

.gfx-divider {
  width: 1px;
  height: 14px;
  background: #444;
  margin: 0 6px;
}

.graphics-label {
  color: #888;
  font-size: 11px;
  text-transform: uppercase;
}

.graphics-buttons {
  display: flex;
  gap: 3px;
}

.button-group {
  display: flex;
}

.button-group .graphics-btn {
  border-radius: 0;
  margin-left: -1px;
}

.button-group .graphics-btn:first-child {
  border-radius: 3px 0 0 3px;
  margin-left: 0;
}

.button-group .graphics-btn:last-child {
  border-radius: 0 3px 3px 0;
}

.graphics-btn {
  padding: 3px 8px;
  background: rgba(60, 60, 60, 0.8);
  border: 1px solid #555;
  border-radius: 3px;
  color: #aaa;
  font-family: monospace;
  font-size: 10px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.graphics-btn:hover {
  background: rgba(80, 80, 80, 0.9);
  border-color: #777;
  color: #ddd;
}

.graphics-btn.active {
  background: rgba(68, 136, 68, 0.9);
  border-color: #6a6;
  color: white;
}

.graphics-btn.active-level {
  color: white;
}
</style>

<script setup lang="ts">
import { ref, reactive, onMounted, onUnmounted, computed, nextTick } from 'vue';
import { createGame, destroyGame, type GameInstance } from '../game/createGame';
import { PLAYER_COLORS, type PlayerId, type WaypointType } from '../game/sim/types';
import SelectionPanel, { type SelectionInfo, type SelectionActions } from './SelectionPanel.vue';
import TopBar, { type EconomyInfo } from './TopBar.vue';
import Minimap, { type MinimapData } from './Minimap.vue';
import LobbyModal, { type LobbyPlayer } from './LobbyModal.vue';
import { networkManager, type NetworkRole } from '../game/network/NetworkManager';
import { DEFAULT_NETWORK_UPDATES_PER_SECOND } from '../config';
import type { HostViewMode } from '../game/scenes/RtsScene';

// Available update rate options
const UPDATE_RATE_OPTIONS = [1, 5, 10, 30] as const;

// Host view mode options
const VIEW_MODE_OPTIONS: { value: HostViewMode; label: string }[] = [
  { value: 'simulation', label: 'Simulation' },
  { value: 'client', label: 'Client View' },
];

const containerRef = ref<HTMLDivElement | null>(null);
const backgroundContainerRef = ref<HTMLDivElement | null>(null);
const activePlayer = ref<PlayerId>(1);
const gameOverWinner = ref<PlayerId | null>(null);

// Background battle game instance (runs behind lobby)
let backgroundGameInstance: GameInstance | null = null;

// Lobby state
const showLobby = ref(true);
const isHost = ref(false);
const roomCode = ref('');
const lobbyPlayers = ref<LobbyPlayer[]>([]);
const localPlayerId = ref<PlayerId>(1);
const lobbyError = ref<string | null>(null);
const isConnecting = ref(false);
const gameStarted = ref(false);
const networkRole = ref<NetworkRole>('offline');
const networkUpdatesPerSecond = ref(DEFAULT_NETWORK_UPDATES_PER_SECOND);
const hostViewMode = ref<HostViewMode>('simulation');

// State broadcast interval (for host)
let stateBroadcastInterval: ReturnType<typeof setInterval> | null = null;

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

  backgroundGameInstance = createGame({
    parent: backgroundContainerRef.value,
    width: rect.width || window.innerWidth,
    height: rect.height || window.innerHeight,
    playerIds: [1, 2],
    localPlayerId: 1,
    networkRole: 'offline',
    backgroundMode: true,
  });
}

// Stop the background battle
function stopBackgroundBattle(): void {
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

  if (gameInstance) {
    destroyGame(gameInstance);
    gameInstance = null;
  }

  if (stateBroadcastInterval) {
    clearInterval(stateBroadcastInterval);
    stateBroadcastInterval = null;
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

  // For clients: receive state updates
  networkManager.onStateReceived = (state) => {
    const scene = gameInstance?.getScene();
    if (scene && networkRole.value === 'client') {
      scene.applyNetworkState(state);

      // Check for game over in received state
      if (state.gameOver) {
        gameOverWinner.value = state.gameOver.winnerId;
      }
    }
  };

  // For host: receive commands from clients
  networkManager.onCommandReceived = (command, fromPlayerId) => {
    const scene = gameInstance?.getScene();
    if (scene && networkRole.value === 'host') {
      scene.enqueueNetworkCommand(command, fromPlayerId);
    }
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

    // Create game with player configuration (explicitly set backgroundMode: false)
    gameInstance = createGame({
      parent: containerRef.value,
      width: rect.width || window.innerWidth,
      height: rect.height || window.innerHeight,
      playerIds,
      localPlayerId: localPlayerId.value,
      networkRole: networkRole.value,
      backgroundMode: false,
    });

    // Setup scene callbacks
    setupSceneCallbacks();

    // If host or offline, start broadcasting state (offline uses it for ClientViewState)
    if (networkRole.value === 'host' || networkRole.value === 'offline') {
      startStateBroadcast();
    }
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

function startStateBroadcast(): void {
  // Clear existing interval if any
  if (stateBroadcastInterval) {
    clearInterval(stateBroadcastInterval);
  }

  // Broadcast state at current rate
  const intervalMs = 1000 / networkUpdatesPerSecond.value;
  stateBroadcastInterval = setInterval(() => {
    const scene = gameInstance?.getScene();
    if (scene && (networkRole.value === 'host' || networkRole.value === 'offline')) {
      const state = scene.getSerializedState();
      if (state) {
        // Only broadcast to network in host mode, not offline
        if (networkRole.value === 'host') {
          networkManager.broadcastState(state);
        }
        // In both modes, getSerializedState already feeds ClientViewState
      }
    }
  }, intervalMs);
}

function setNetworkUpdateRate(rate: number): void {
  networkUpdatesPerSecond.value = rate;
  // Restart broadcast with new rate
  if ((networkRole.value === 'host' || networkRole.value === 'offline') && gameStarted.value) {
    startStateBroadcast();
  }
}

function setHostViewMode(mode: HostViewMode): void {
  const scene = gameInstance?.getScene();
  if (scene && (networkRole.value === 'host' || networkRole.value === 'offline')) {
    scene.setHostViewMode(mode);
    hostViewMode.value = mode;
  }
}

onMounted(() => {
  // Start the background battle behind the lobby
  nextTick(() => {
    startBackgroundBattle();
  });
});

onUnmounted(() => {
  if (stateBroadcastInterval) {
    clearInterval(stateBroadcastInterval);
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
    <div ref="backgroundContainerRef" class="background-battle-container" v-show="showLobby"></div>

    <!-- Main game container -->
    <div ref="containerRef" class="phaser-container" v-show="!showLobby"></div>

    <!-- Lobby Modal -->
    <LobbyModal
      :visible="showLobby"
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
    />

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

          <!-- View Mode Toggle -->
          <div class="option-row">
            <span class="option-label">View:</span>
            <div class="option-buttons">
              <button
                v-for="opt in VIEW_MODE_OPTIONS"
                :key="opt.value"
                class="option-btn"
                :class="{ active: hostViewMode === opt.value }"
                @click="setHostViewMode(opt.value)"
              >
                {{ opt.label }}
              </button>
            </div>
          </div>

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
</style>

<script setup lang="ts">
import { ref, reactive, onMounted, onUnmounted } from 'vue';
import { createGame, destroyGame, type GameInstance } from '../game/createGame';
import { PLAYER_COLORS, type PlayerId, type WaypointType } from '../game/sim/types';
import SelectionPanel, { type SelectionInfo, type SelectionActions } from './SelectionPanel.vue';
import TopBar, { type EconomyInfo } from './TopBar.vue';
import Minimap, { type MinimapData } from './Minimap.vue';

const containerRef = ref<HTMLDivElement | null>(null);
const activePlayer = ref<PlayerId>(1);
const gameOverWinner = ref<PlayerId | null>(null);

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
});

// Minimap state
const minimapData = reactive<MinimapData>({
  mapWidth: 2000,
  mapHeight: 1500,
  entities: [],
  cameraX: 0,
  cameraY: 0,
  cameraWidth: 800,
  cameraHeight: 600,
});

let gameInstance: GameInstance | null = null;

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
  const scene = gameInstance?.getScene();
  scene?.restartGame();
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

onMounted(() => {
  if (!containerRef.value) return;

  const rect = containerRef.value.getBoundingClientRect();

  gameInstance = createGame({
    parent: containerRef.value,
    width: rect.width || window.innerWidth,
    height: rect.height || window.innerHeight,
  });

  // Listen for changes from the game
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
});

onUnmounted(() => {
  if (gameInstance) {
    destroyGame(gameInstance);
    gameInstance = null;
  }
});
</script>

<template>
  <div class="game-wrapper">
    <div ref="containerRef" class="phaser-container"></div>

    <!-- Top bar with economy info -->
    <TopBar
      :economy="economyInfo"
      :player-name="getPlayerName(activePlayer)"
      :player-color="getPlayerColor(activePlayer)"
    />

    <!-- Top-right UI overlay -->
    <div class="ui-overlay top-right">
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

    <!-- Selection panel (bottom-left) -->
    <SelectionPanel :selection="selectionInfo" :actions="selectionActions" />

    <!-- Minimap (bottom-right) -->
    <Minimap :data="minimapData" @click="handleMinimapClick" />

    <!-- Game Over Modal -->
    <div v-if="gameOverWinner !== null" class="game-over-modal">
      <div class="game-over-content">
        <h1 class="winner-text" :style="{ color: getPlayerColor(gameOverWinner) }">
          PLAYER {{ gameOverWinner }} WINS!
        </h1>
        <p class="loser-text">
          Player {{ gameOverWinner === 1 ? 2 : 1 }}'s commander was destroyed
        </p>
        <p class="restart-hint">Press R to restart</p>
        <button class="restart-btn" @click="restartGame">Restart Game</button>
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
</style>

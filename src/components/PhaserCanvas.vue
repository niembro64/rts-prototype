<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import { createGame, destroyGame, type GameInstance } from '../game/createGame';
import { PLAYER_COLORS, type PlayerId } from '../game/sim/types';

const containerRef = ref<HTMLDivElement | null>(null);
const activePlayer = ref<PlayerId>(1);

let gameInstance: GameInstance | null = null;

function togglePlayer(): void {
  const scene = gameInstance?.getScene();
  if (scene) {
    scene.togglePlayer();
    activePlayer.value = scene.getActivePlayer();
  }
}

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

  // Listen for player changes from the game
  const checkScene = setInterval(() => {
    const scene = gameInstance?.getScene();
    if (scene) {
      scene.onPlayerChange = (playerId: PlayerId) => {
        activePlayer.value = playerId;
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

    <div class="ui-overlay">
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

.ui-overlay {
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
</style>

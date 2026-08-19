<script setup lang="ts">
import { ref } from 'vue';
import CameraTutorial from './CameraTutorial.vue';
import { persist, readPersisted } from '../persistence';
import type { BattleMode } from '../battleBarConfig';
import type { PlayerId } from '../game/sim/types';
import type { OrbitCamera } from '../game/render3d/OrbitCamera';

defineProps<{
  isMobile: boolean;
  showLobby: boolean;
  hudVisible: boolean;
  mobileBarsVisible: boolean;
  gameStarted: boolean;
  currentBattleMode: BattleMode;
  getOrbit: () => OrbitCamera | null;
  gameOverWinner: PlayerId | null;
  winnerName: string;
  winnerColor: string;
  /** Seconds until this client is returned to the menu because the host
   *  left, or null when that is not happening. */
  hostLeftSecondsRemaining: number | null;
}>();

const emit = defineEmits<{
  toggleMobileBars: [];
  dismissGameOver: [];
  restartGame: [];
  exitAfterHostLeft: [];
}>();

const CAMERA_TUTORIAL_DONE_KEY = 'rts-camera-tutorial-done';
const cameraTutorialDone = ref(readPersisted(CAMERA_TUTORIAL_DONE_KEY) === 'true');

function handleCameraTutorialDone(): void {
  cameraTutorialDone.value = true;
  persist(CAMERA_TUTORIAL_DONE_KEY, 'true');
}
</script>

<template>
  <CameraTutorial
    v-if="hudVisible && gameStarted && currentBattleMode === 'real' && !cameraTutorialDone"
    :get-orbit="getOrbit"
    @done="handleCameraTutorialDone"
  />

  <button
    v-if="hudVisible && isMobile"
    class="mobile-bars-toggle"
    :class="{ active: mobileBarsVisible }"
    :title="mobileBarsVisible ? 'Hide Controls' : 'Show Controls'"
    @click="emit('toggleMobileBars')"
  >
    ☰
  </button>

  <!-- Host left. Outranks the game-over banner: if both land at once, why the
       session is ending matters more than how it ended. -->
  <div v-if="hostLeftSecondsRemaining !== null" class="host-left-banner">
    <div class="host-left-content">
      <h1 class="host-left-title">HOST HAS LEFT</h1>
      <p class="host-left-text">
        Returning to the menu in {{ hostLeftSecondsRemaining }}s…
      </p>
      <button class="host-left-btn" @click="emit('exitAfterHostLeft')">
        Return to Menu
      </button>
    </div>
  </div>

  <div
    v-if="gameOverWinner !== null"
    class="game-over-banner"
    @click="emit('dismissGameOver')"
  >
    <div class="game-over-content" @click.stop>
      <h1
        class="winner-text"
        :style="{ color: winnerColor }"
      >
        {{ winnerName }} wins!
      </h1>
      <p class="loser-text">{{ winnerName }} is the only team with living commanders.</p>
      <div class="game-over-actions">
        <button class="restart-btn" @click="emit('restartGame')">
          Return to Lobby
        </button>
        <button class="dismiss-btn" @click="emit('dismissGameOver')">
          Keep Watching
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.host-left-banner {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.75);
  display: flex;
  align-items: center;
  justify-content: center;
  /* Above the game-over banner (2000) so a simultaneous win cannot bury it. */
  z-index: 2100;
}

.host-left-content {
  text-align: center;
  padding: 40px 60px;
  background: rgba(15, 18, 24, 0.95);
  border: 1px solid #aa4444;
  border-radius: 16px;
  box-shadow: 0 0 40px rgba(170, 68, 68, 0.35);
}

.host-left-title {
  font-family: monospace;
  font-size: 40px;
  margin: 0 0 16px 0;
  color: #ff6666;
  text-shadow: 0 0 20px currentColor;
}

.host-left-text {
  font-family: monospace;
  font-size: 18px;
  color: #cccccc;
  margin: 0 0 28px 0;
}

.host-left-btn {
  font-family: monospace;
  font-size: 16px;
  padding: 12px 32px;
  background: #aa4444;
  color: white;
  border: none;
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.host-left-btn:hover {
  background: #cc5555;
  transform: scale(1.05);
}

.host-left-btn:active {
  transform: scale(0.98);
}

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
</style>

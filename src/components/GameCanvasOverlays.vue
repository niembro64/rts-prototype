<script setup lang="ts">
import { ref } from 'vue';
import CameraTutorial from './CameraTutorial.vue';
import SoundTestModal from './SoundTestModal.vue';
import { persist, readPersisted } from '../persistence';
import type { BattleMode } from '../battleBarConfig';
import type { PlayerId } from '../game/sim/types';
import type { OrbitCamera } from '../game/render3d/OrbitCamera';

defineProps<{
  isMobile: boolean;
  showLobby: boolean;
  spectateMode: boolean;
  mobileBarsVisible: boolean;
  showSoundTest: boolean;
  gameStarted: boolean;
  currentBattleMode: BattleMode;
  getOrbit: () => OrbitCamera | null;
  gameOverWinner: PlayerId | null;
  winnerName: string;
  winnerColor: string;
}>();

const emit = defineEmits<{
  toggleSpectateMode: [];
  toggleMobileBars: [];
  closeSoundTest: [];
  dismissGameOver: [];
  restartGame: [];
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
    v-if="gameStarted && currentBattleMode === 'real' && !cameraTutorialDone"
    :get-orbit="getOrbit"
    @done="handleCameraTutorialDone"
  />

  <button
    v-if="!isMobile && showLobby && spectateMode"
    class="spectate-toggle-btn"
    title="Show Menu"
    @click="emit('toggleSpectateMode')"
  >
    ☰
  </button>

  <button
    v-if="isMobile"
    class="mobile-bars-toggle"
    :class="{ active: mobileBarsVisible }"
    :title="mobileBarsVisible ? 'Hide Controls' : 'Show Controls'"
    @click="emit('toggleMobileBars')"
  >
    ☰
  </button>

  <SoundTestModal
    :visible="showSoundTest"
    @close="emit('closeSoundTest')"
  />

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
      <p class="loser-text">All other commanders were destroyed</p>
      <div class="game-over-actions">
        <button class="restart-btn" @click="emit('restartGame')">
          Return to Lobby
        </button>
        <button class="dismiss-btn" @click="emit('dismissGameOver')">
          Continue Watching
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
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

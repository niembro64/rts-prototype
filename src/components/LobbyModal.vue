<script setup lang="ts">
import { ref, computed } from 'vue';
import { PLAYER_COLORS, type PlayerId } from '../game/sim/types';

export interface LobbyPlayer {
  playerId: PlayerId;
  name: string;
  isHost: boolean;
}

const props = defineProps<{
  visible: boolean;
  isHost: boolean;
  roomCode: string;
  players: LobbyPlayer[];
  localPlayerId: PlayerId;
  error: string | null;
  isConnecting: boolean;
}>();

const emit = defineEmits<{
  (e: 'host'): void;
  (e: 'join', roomCode: string): void;
  (e: 'start'): void;
  (e: 'cancel'): void;
}>();

const joinCode = ref('');
const showJoinInput = ref(false);

function getPlayerColor(playerId: PlayerId): string {
  const color = PLAYER_COLORS[playerId]?.primary ?? 0x888888;
  return '#' + color.toString(16).padStart(6, '0');
}

function handleHost() {
  emit('host');
}

function handleJoinClick() {
  showJoinInput.value = true;
}

function handleJoinSubmit() {
  if (joinCode.value.length >= 4) {
    emit('join', joinCode.value.toUpperCase());
  }
}

function handleStart() {
  emit('start');
}

function handleCancel() {
  showJoinInput.value = false;
  joinCode.value = '';
  emit('cancel');
}

const canStart = computed(() => {
  return props.isHost && props.players.length >= 1;
});

const isInLobby = computed(() => {
  return props.roomCode !== '';
});
</script>

<template>
  <div v-if="visible" class="lobby-overlay">
    <div class="lobby-modal">
      <!-- Initial screen: Host or Join -->
      <template v-if="!isInLobby && !showJoinInput && !isConnecting">
        <h1 class="title">RTS PROTOTYPE</h1>
        <div class="button-group">
          <button class="lobby-btn host-btn" @click="handleHost">
            Host Game
          </button>
          <div class="divider">or</div>
          <button class="lobby-btn join-btn" @click="handleJoinClick">
            Join Game
          </button>
        </div>
      </template>

      <!-- Join input screen -->
      <template v-else-if="showJoinInput && !isInLobby && !isConnecting">
        <h1 class="title">JOIN GAME</h1>
        <div class="join-form">
          <label class="input-label">Room Code:</label>
          <input
            v-model="joinCode"
            class="code-input"
            type="text"
            maxlength="4"
            placeholder="XXXX"
            @keyup.enter="handleJoinSubmit"
          />
          <div class="button-row">
            <button class="lobby-btn cancel-btn" @click="handleCancel">
              Back
            </button>
            <button
              class="lobby-btn join-btn"
              :disabled="joinCode.length < 4"
              @click="handleJoinSubmit"
            >
              Join
            </button>
          </div>
        </div>
      </template>

      <!-- Connecting screen -->
      <template v-else-if="isConnecting">
        <h1 class="title">CONNECTING...</h1>
        <div class="connecting-spinner"></div>
        <button class="lobby-btn cancel-btn" @click="handleCancel">
          Cancel
        </button>
      </template>

      <!-- Lobby screen (hosting or joined) -->
      <template v-else-if="isInLobby">
        <h1 class="title">GAME LOBBY</h1>

        <div class="room-code-display">
          <span class="room-label">Room Code:</span>
          <span class="room-code">{{ roomCode }}</span>
        </div>

        <div class="players-section">
          <h2 class="players-title">Players ({{ players.length }}/6)</h2>
          <ul class="player-list">
            <li
              v-for="player in players"
              :key="player.playerId"
              class="player-item"
              :class="{ 'is-local': player.playerId === localPlayerId }"
            >
              <span
                class="player-color"
                :style="{ backgroundColor: getPlayerColor(player.playerId) }"
              ></span>
              <span class="player-name">{{ player.name }}</span>
              <span v-if="player.isHost" class="host-badge">HOST</span>
              <span v-if="player.playerId === localPlayerId" class="you-badge">YOU</span>
            </li>
          </ul>
        </div>

        <div v-if="error" class="error-message">{{ error }}</div>

        <div class="button-row">
          <button class="lobby-btn cancel-btn" @click="handleCancel">
            Leave
          </button>
          <button
            v-if="isHost"
            class="lobby-btn start-btn"
            :disabled="!canStart"
            @click="handleStart"
          >
            Start Game
          </button>
          <span v-else class="waiting-text">Waiting for host to start...</span>
        </div>
      </template>

      <!-- Error display -->
      <div v-if="error && !isInLobby" class="error-message">{{ error }}</div>
    </div>
  </div>
</template>

<style scoped>
.lobby-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(10, 10, 20, 0.95);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 3000;
}

.lobby-modal {
  background: rgba(20, 20, 35, 0.98);
  border: 2px solid #4444aa;
  border-radius: 16px;
  padding: 40px 50px;
  min-width: 400px;
  text-align: center;
  box-shadow: 0 0 60px rgba(68, 68, 170, 0.3);
}

.title {
  font-family: monospace;
  font-size: 32px;
  color: #ffffff;
  margin: 0 0 30px 0;
  text-shadow: 0 0 20px rgba(68, 68, 170, 0.5);
}

.button-group {
  display: flex;
  flex-direction: column;
  gap: 15px;
  align-items: center;
}

.divider {
  color: #666;
  font-family: monospace;
  font-size: 14px;
}

.lobby-btn {
  font-family: monospace;
  font-size: 18px;
  padding: 14px 40px;
  border: none;
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.2s ease;
  min-width: 200px;
}

.lobby-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.host-btn {
  background: #44aa44;
  color: white;
}

.host-btn:hover:not(:disabled) {
  background: #55cc55;
  transform: scale(1.02);
}

.join-btn {
  background: #4a9eff;
  color: white;
}

.join-btn:hover:not(:disabled) {
  background: #5aafff;
  transform: scale(1.02);
}

.start-btn {
  background: #44aa44;
  color: white;
}

.start-btn:hover:not(:disabled) {
  background: #55cc55;
  transform: scale(1.02);
}

.cancel-btn {
  background: #666;
  color: white;
}

.cancel-btn:hover {
  background: #777;
}

.join-form {
  display: flex;
  flex-direction: column;
  gap: 15px;
  align-items: center;
}

.input-label {
  font-family: monospace;
  font-size: 16px;
  color: #aaa;
}

.code-input {
  font-family: monospace;
  font-size: 32px;
  text-align: center;
  width: 150px;
  padding: 10px;
  background: rgba(0, 0, 0, 0.3);
  border: 2px solid #4444aa;
  border-radius: 8px;
  color: white;
  text-transform: uppercase;
  letter-spacing: 8px;
}

.code-input::placeholder {
  color: #555;
  letter-spacing: 8px;
}

.code-input:focus {
  outline: none;
  border-color: #6666cc;
}

.button-row {
  display: flex;
  gap: 15px;
  justify-content: center;
  margin-top: 20px;
}

.room-code-display {
  background: rgba(0, 0, 0, 0.3);
  padding: 15px 25px;
  border-radius: 8px;
  margin-bottom: 25px;
}

.room-label {
  font-family: monospace;
  font-size: 14px;
  color: #888;
  margin-right: 10px;
}

.room-code {
  font-family: monospace;
  font-size: 28px;
  color: #4a9eff;
  letter-spacing: 6px;
  font-weight: bold;
}

.players-section {
  margin-bottom: 25px;
}

.players-title {
  font-family: monospace;
  font-size: 16px;
  color: #aaa;
  margin: 0 0 15px 0;
}

.player-list {
  list-style: none;
  padding: 0;
  margin: 0;
}

.player-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 15px;
  background: rgba(0, 0, 0, 0.2);
  border-radius: 6px;
  margin-bottom: 8px;
}

.player-item.is-local {
  background: rgba(68, 68, 170, 0.2);
  border: 1px solid rgba(68, 68, 170, 0.4);
}

.player-color {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  border: 2px solid rgba(255, 255, 255, 0.3);
}

.player-name {
  font-family: monospace;
  font-size: 16px;
  color: white;
  flex: 1;
  text-align: left;
}

.host-badge {
  font-family: monospace;
  font-size: 11px;
  background: #44aa44;
  color: white;
  padding: 3px 8px;
  border-radius: 4px;
}

.you-badge {
  font-family: monospace;
  font-size: 11px;
  background: #4a9eff;
  color: white;
  padding: 3px 8px;
  border-radius: 4px;
}

.waiting-text {
  font-family: monospace;
  font-size: 14px;
  color: #888;
  padding: 14px 20px;
}

.error-message {
  font-family: monospace;
  font-size: 14px;
  color: #ff6666;
  background: rgba(255, 0, 0, 0.1);
  padding: 10px 15px;
  border-radius: 6px;
  margin-top: 15px;
}

.connecting-spinner {
  width: 40px;
  height: 40px;
  border: 4px solid rgba(68, 68, 170, 0.3);
  border-top-color: #4a9eff;
  border-radius: 50%;
  margin: 20px auto;
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>

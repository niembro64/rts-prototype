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
  (e: 'spectate'): void;
}>();

const joinCode = ref('');
const codeCopied = ref(false);

async function copyCode() {
  try {
    await navigator.clipboard.writeText(props.roomCode);
    codeCopied.value = true;
    setTimeout(() => {
      codeCopied.value = false;
    }, 2000);
  } catch (err) {
    // Fallback: select the text
    const codeEl = document.querySelector('.room-code') as HTMLElement;
    if (codeEl) {
      const range = document.createRange();
      range.selectNodeContents(codeEl);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
  }
}

function getPlayerColor(playerId: PlayerId): string {
  const color = PLAYER_COLORS[playerId]?.primary ?? 0x888888;
  return '#' + color.toString(16).padStart(6, '0');
}

function handleHost() {
  emit('host');
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
  joinCode.value = '';
  emit('cancel');
}

const canStart = computed(() => {
  return props.isHost && props.players.length >= 1;
});

const isInLobby = computed(() => {
  return props.roomCode !== '';
});

const canJoin = computed(() => {
  return joinCode.value.length >= 4;
});
</script>

<template>
  <div v-if="visible" class="lobby-overlay">
    <div class="lobby-modal">
      <!-- Spectate button (hide menu to watch background battle) -->
      <button
        class="spectate-btn"
        @click="emit('spectate')"
        title="Watch Battle"
      >
        ●
      </button>

      <!-- Initial screen: Host and Join side by side -->
      <template v-if="!isInLobby && !isConnecting">
        <h1 class="title">BUDGET ANNIHILATION</h1>
        <p class="subtitle">Multiplayer RTS</p>

        <div class="options-container">
          <button class="lobby-btn host-btn" @click="handleHost">
            Host Game
          </button>

          <div class="divider-vertical"></div>

          <div class="join-section">
            <input
              v-model="joinCode"
              class="code-input"
              type="text"
              maxlength="4"
              placeholder="CODE"
              @keyup.enter="handleJoinSubmit"
            />
            <button
              class="lobby-btn join-btn"
              :disabled="!canJoin"
              @click="handleJoinSubmit"
            >
              Join
            </button>
          </div>
        </div>

        <!-- Error display -->
        <div v-if="error" class="error-message">{{ error }}</div>
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

        <div class="room-code-display" @click="copyCode">
          <span class="room-label">Share this code with friends:</span>
          <div class="room-code-row">
            <span class="room-code">{{ roomCode }}</span>
            <button class="copy-btn" :class="{ copied: codeCopied }" :title="codeCopied ? 'Copied!' : 'Copy to clipboard'">
              {{ codeCopied ? '✓' : '⧉' }}
            </button>
          </div>
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
  background: rgba(10, 10, 20, 0.7);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 3000;
}

.lobby-modal {
  position: relative;
  background: rgba(20, 20, 35, 0.98);
  border: 2px solid #4444aa;
  border-radius: 16px;
  padding: 40px 50px;
  min-width: 500px;
  text-align: center;
  box-shadow: 0 0 60px rgba(68, 68, 170, 0.3);
}

.spectate-btn {
  position: absolute;
  top: 10px;
  right: 10px;
  width: 24px;
  height: 24px;
  padding: 0;
  background: transparent;
  border: none;
  color: #555;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.2s ease;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
}

.spectate-btn:hover {
  color: #4a9eff;
  background: rgba(74, 158, 255, 0.1);
}

.title {
  font-family: monospace;
  font-size: 32px;
  color: #ffffff;
  margin: 0;
  text-shadow: 0 0 20px rgba(68, 68, 170, 0.5);
}

.subtitle {
  font-family: monospace;
  font-size: 14px;
  color: #888;
  margin: 8px 0 20px 0;
}

.options-container {
  display: flex;
  gap: 30px;
  align-items: center;
  justify-content: center;
}

.join-section {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
}

.divider-vertical {
  width: 1px;
  height: 40px;
  background: linear-gradient(to bottom, transparent, #4444aa, transparent);
}

.lobby-btn {
  font-family: monospace;
  font-size: 16px;
  padding: 12px 30px;
  border: none;
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.2s ease;
  min-width: 140px;
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

.code-input {
  font-family: monospace;
  font-size: 24px;
  text-align: center;
  width: 120px;
  padding: 8px;
  background: rgba(0, 0, 0, 0.3);
  border: 2px solid #4444aa;
  border-radius: 8px;
  color: white;
  text-transform: uppercase;
  letter-spacing: 4px;
}

.code-input::placeholder {
  color: #555;
  letter-spacing: 4px;
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
  padding: 20px 30px;
  border-radius: 12px;
  margin-bottom: 25px;
  cursor: pointer;
  border: 2px solid rgba(74, 158, 255, 0.3);
  transition: all 0.2s ease;
}

.room-code-display:hover {
  border-color: rgba(74, 158, 255, 0.6);
  background: rgba(0, 0, 0, 0.4);
}

.room-label {
  font-family: monospace;
  font-size: 14px;
  color: #aaa;
  display: block;
  margin-bottom: 12px;
}

.room-code-row {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 15px;
}

.room-code {
  font-family: monospace;
  font-size: 36px;
  color: #4a9eff;
  letter-spacing: 8px;
  font-weight: bold;
  user-select: all;
  text-shadow: 0 0 10px rgba(74, 158, 255, 0.4);
}

.copy-btn {
  font-size: 20px;
  width: 40px;
  height: 40px;
  padding: 0;
  background: rgba(74, 158, 255, 0.2);
  border: 1px solid #4a9eff;
  border-radius: 8px;
  color: #4a9eff;
  cursor: pointer;
  transition: all 0.2s ease;
  display: flex;
  align-items: center;
  justify-content: center;
}

.copy-btn:hover {
  background: rgba(74, 158, 255, 0.4);
}

.copy-btn.copied {
  background: rgba(68, 170, 68, 0.3);
  border-color: #44aa44;
  color: #44aa44;
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

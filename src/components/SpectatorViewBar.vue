<script setup lang="ts">
/**
 * What a watcher is looking through.
 *
 * Entirely local. Every peer in a lockstep match already holds the complete
 * authoritative world — snapshots are presentation, not truth — so choosing
 * whose vision to borrow, or to take none at all, costs the network nothing
 * and tells nobody.
 *
 * Which also means the honest thing to say about ALL: it is not a privilege
 * this grants. Any client in a lockstep match has the whole world in memory
 * already, players included. Fog is a courtesy here, not a boundary.
 */
import type { PlayerId } from '../game/sim/types';
import type { LobbyPlayer } from '../types/network';

defineProps<{
  players: readonly LobbyPlayer[];
  /** The seat currently being watched, or null while watching everything. */
  watching: PlayerId | null;
  getPlayerColor: (playerId: PlayerId) => string;
}>();

const emit = defineEmits<{
  (e: 'watch', playerId: PlayerId | null): void;
}>();
</script>

<template>
  <div class="spectator-bar" role="group" aria-label="Spectator view">
    <span class="spectator-bar-label">WATCHING</span>
    <button
      class="spectator-bar-btn"
      :class="{ active: watching === null }"
      title="See the whole battle, with no fog of war"
      @click="emit('watch', null)"
    >ALL</button>
    <button
      v-for="player in players"
      :key="player.playerId"
      class="spectator-bar-btn"
      :class="{ active: watching === player.playerId }"
      :title="`See only what ${player.name} and their allies can see`"
      @click="emit('watch', player.playerId)"
    >
      <span class="spectator-bar-dot" :style="{ background: getPlayerColor(player.playerId) }" />
      {{ player.name }}
    </button>
  </div>
</template>

<style scoped>
.spectator-bar {
  position: absolute;
  bottom: 12px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-radius: 4px;
  background: rgba(10, 12, 16, 0.82);
  z-index: 35;
}

.spectator-bar-label {
  font-size: 10px;
  letter-spacing: 0.12em;
  opacity: 0.55;
}

.spectator-bar-btn {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  letter-spacing: 0.04em;
  padding: 3px 8px;
  border-radius: 3px;
  border: 1px solid rgba(255, 255, 255, 0.22);
  background: transparent;
  color: rgba(255, 255, 255, 0.75);
  cursor: pointer;
}

.spectator-bar-btn:hover {
  border-color: rgba(255, 255, 255, 0.6);
  color: #fff;
}

.spectator-bar-btn.active {
  border-color: rgba(255, 255, 255, 0.85);
  color: #fff;
  background: rgba(255, 255, 255, 0.12);
}

.spectator-bar-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}
</style>

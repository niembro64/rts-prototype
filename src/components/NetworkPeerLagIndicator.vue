<script setup lang="ts">
/**
 * Names the players who are holding the match up.
 *
 * Deliberately absent when everything is fine — a permanent readout of
 * everyone's frame number is noise nobody reads, and it would train players
 * to ignore the one moment it matters. It appears only while somebody is
 * actually behind, and disappears the moment they catch up.
 *
 * The flashing is the point: lockstep stutter feels like a broken game, so
 * the indicator has to be impossible to miss and has to say a name.
 */
import type { PlayerId } from '../game/sim/types';
import type { LaggingPeer } from './gameCanvasPeerLag';

defineProps<{
  peers: readonly LaggingPeer[];
  resolvePlayerName: (playerId: PlayerId) => string;
  getPlayerColor: (playerId: PlayerId) => string;
}>();

function formatBehind(secondsBehind: number): string {
  if (secondsBehind < 10) return `${secondsBehind.toFixed(1)}s behind`;
  return `${Math.round(secondsBehind)}s behind`;
}
</script>

<template>
  <div v-if="peers.length > 0" class="peer-lag" role="status" aria-live="polite">
    <span class="peer-lag-label">WAITING FOR</span>
    <span
      v-for="peer in peers"
      :key="peer.playerId"
      class="peer-lag-chip"
      :title="`${resolvePlayerName(peer.playerId)} is ${formatBehind(peer.secondsBehind)}`"
    >
      <span class="peer-lag-dot" :style="{ background: getPlayerColor(peer.playerId) }" />
      <span class="peer-lag-name">{{ resolvePlayerName(peer.playerId) }}</span>
      <span class="peer-lag-behind">{{ formatBehind(peer.secondsBehind) }}</span>
    </span>
  </div>
</template>

<style scoped>
.peer-lag {
  position: absolute;
  top: 8px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 1900;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  font-family: monospace;
  font-size: 12px;
  background: rgba(15, 18, 24, 0.9);
  border: 1px solid #aa4444;
  border-radius: 8px;
  pointer-events: none;
  animation: peer-lag-flash 1s ease-in-out infinite;
}

/* Pulse the whole panel rather than the text: the border and glow read at a
 * glance mid-battle, while flashing the names would make them hard to read —
 * and the name is the actionable part. */
@keyframes peer-lag-flash {
  0%,
  100% {
    border-color: #aa4444;
    box-shadow: 0 0 0 rgba(255, 68, 68, 0);
  }
  50% {
    border-color: #ff6666;
    box-shadow: 0 0 14px rgba(255, 68, 68, 0.55);
  }
}

@media (prefers-reduced-motion: reduce) {
  .peer-lag {
    animation: none;
    border-color: #ff6666;
  }
}

.peer-lag-label {
  letter-spacing: 2px;
  color: #ff6666;
}

.peer-lag-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.peer-lag-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  box-shadow: 0 0 4px currentColor;
}

.peer-lag-name {
  color: #ffffff;
}

.peer-lag-behind {
  color: #cc8888;
}
</style>

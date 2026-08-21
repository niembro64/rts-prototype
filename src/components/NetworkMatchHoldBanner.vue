<script setup lang="ts">
/**
 * The match is stopped, and this says who for.
 *
 * Deliberately separate from the lag indicator next to it. That one names who
 * is BEHIND — informational, and true while everyone is still playing. This
 * one appears only when nothing is advancing at all, which is a different
 * thing for a player to be told and a much worse one to leave unexplained.
 *
 * A watcher can never be the subject: it holds no seat, so flow control never
 * sees it and a spectator falling behind stops nothing.
 */
import { computed } from 'vue';
import type { PlayerId } from '../game/sim/types';
import type { RealBattleFlowControlReport } from './gameCanvasRealBattleStartup';

const props = defineProps<{
  hold: RealBattleFlowControlReport | null;
  resolvePlayerName: (playerId: PlayerId) => string;
  getPlayerColor: (playerId: PlayerId) => string;
  /** Seconds a subject may hold the match before their seat is resigned and
   *  play continues. Shown so the wait has a visible end. */
  dropAfterSeconds: number;
}>();

const subjectName = computed(() =>
  props.hold?.subjectPlayerId === null || props.hold?.subjectPlayerId === undefined
    ? ''
    : props.resolvePlayerName(props.hold.subjectPlayerId),
);

const subjectColor = computed(() =>
  props.hold?.subjectPlayerId === null || props.hold?.subjectPlayerId === undefined
    ? 'transparent'
    : props.getPlayerColor(props.hold.subjectPlayerId),
);

const explanation = computed(() => {
  if (props.hold === null) return '';
  return props.hold.reason === 'disconnected'
    ? 'lost connection'
    : `${props.hold.secondsBehind.toFixed(1)}s behind`;
});
</script>

<template>
  <div v-if="hold !== null" class="match-hold" role="status" aria-live="polite">
    <span class="match-hold-label">MATCH HELD</span>
    <span class="match-hold-subject">
      <span class="match-hold-dot" :style="{ background: subjectColor }" />
      <span class="match-hold-name">{{ subjectName }}</span>
      <span class="match-hold-why">{{ explanation }}</span>
    </span>
    <span class="match-hold-note">
      resuming when they catch up — dropping after {{ dropAfterSeconds }}s
    </span>
  </div>
</template>

<style scoped>
.match-hold {
  position: absolute;
  top: 96px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  padding: 8px 16px;
  border: 1px solid rgba(255, 210, 90, 0.7);
  border-radius: 4px;
  background: rgba(20, 16, 6, 0.86);
  color: #ffd25a;
  font-size: 12px;
  letter-spacing: 0.08em;
  pointer-events: none;
  /* Above the pause scrim (1900): the hold banner names WHO the match is
   * held for, and the scrim's subtitle points at it. */
  z-index: 1950;
}

.match-hold-label {
  font-weight: 700;
  animation: match-hold-flash 1.4s ease-in-out infinite;
}

@keyframes match-hold-flash {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.45; }
}

.match-hold-subject {
  display: flex;
  align-items: center;
  gap: 6px;
}

.match-hold-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.match-hold-name {
  color: #fff;
}

.match-hold-why {
  opacity: 0.75;
}

.match-hold-note {
  font-size: 10px;
  opacity: 0.6;
  letter-spacing: 0.05em;
}
</style>

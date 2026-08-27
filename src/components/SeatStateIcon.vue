<script setup lang="ts">
// A seat's INITIAL STATE, drawn instead of spelled: a lone COMMANDER,
// BASE BUILDINGS, or those same buildings plus an opening UNIT pair.
// The accessible name lives on the wrapping control's title.
import type { SeatInitialState } from '../game/sim/agentSeat';

defineProps<{
  state: SeatInitialState;
}>();
</script>

<template>
  <svg
    class="seat-state-icon"
    viewBox="0 0 16 16"
    width="12"
    height="12"
    fill="none"
    aria-hidden="true"
  >
    <template v-if="state === 'baseBuildings'">
      <!-- Base buildings only: slab, two structures, one taller stack. -->
      <path d="M2 13.5h12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
      <path d="M3.5 13.5V9h4v4.5" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" />
      <path d="M9.5 13.5V6.5h3v7" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" />
      <path d="M11 6.5V4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
    </template>
    <template v-else-if="state === 'baseAndUnits'">
      <!-- The same base, raised slightly to leave two opening units below. -->
      <path d="M2 10.5h12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
      <path d="M3.5 10.5V7h4v3.5" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" />
      <path d="M9.5 10.5V4.5h3v6" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" />
      <path d="M11 4.5V2.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
      <circle cx="4.5" cy="13.5" r="1.1" fill="currentColor" />
      <circle cx="11.5" cy="13.5" r="1.1" fill="currentColor" />
    </template>
    <template v-else>
      <!-- A lone commander: head over a broad-shouldered body. -->
      <circle cx="8" cy="4.6" r="2.1" stroke="currentColor" stroke-width="1.5" />
      <path d="M3.8 13.5c.5-3 2.2-4.5 4.2-4.5s3.7 1.5 4.2 4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
    </template>
  </svg>
</template>

<style scoped>
.seat-state-icon {
  display: block;
}
</style>

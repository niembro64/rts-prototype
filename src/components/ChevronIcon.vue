<script setup lang="ts">
// Small chevron used by the edge toggle handles (menu sidebar, bottom
// bars) to show which way a panel opens/closes. Base art points right;
// the prop rotates it, and the rotation animates so flipping
// open<->close reads as the arrow turning around.
const ROTATION: Record<string, number> = {
  right: 0,
  down: 90,
  left: 180,
  up: 270,
};

defineProps<{ direction: 'left' | 'right' | 'up' | 'down' }>();
</script>

<template>
  <svg
    class="chevron-icon"
    viewBox="0 0 16 16"
    width="12"
    height="12"
    aria-hidden="true"
    :style="{ transform: `rotate(${ROTATION[direction]}deg)` }"
  >
    <path
      d="M5.5 2.5 L11 8 L5.5 13.5"
      fill="none"
      stroke="currentColor"
      stroke-width="2.2"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
  </svg>
</template>

<style scoped>
.chevron-icon {
  display: block;
  transition: transform 0.18s ease;
}
</style>

<script setup lang="ts">
defineProps<{
  fullscreen: boolean;
}>();
</script>

<template>
  <svg
    class="fullscreen-toggle-icon"
    viewBox="0 0 24 24"
    fill="none"
    aria-hidden="true"
  >
    <!-- Outward corners mean ENTER fullscreen; inward corners mean return
         to the ordinary window. Keeping both silhouettes explicit avoids a
         generic square icon whose action/state is ambiguous. -->
    <path
      v-if="!fullscreen"
      d="M8 3H3v5 M16 3h5v5 M21 16v5h-5 M8 21H3v-5"
    />
    <path
      v-else
      d="M3 8h5V3 M21 8h-5V3 M21 16h-5v5 M3 16h5v5"
    />
  </svg>
</template>

<style scoped>
.fullscreen-toggle-icon {
  display: block;
  width: 20px;
  height: 20px;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}
</style>

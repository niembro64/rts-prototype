<script setup lang="ts">
// Plain X glyph for "take this out of the list" row controls (bench a
// seated player back to the watchers). The accessible name lives on the
// wrapping button's title/aria-label; the glyph itself is decoration.
</script>

<template>
  <svg
    class="x-icon"
    viewBox="0 0 16 16"
    width="12"
    height="12"
    fill="none"
    aria-hidden="true"
  >
    <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" />
  </svg>
</template>

<style scoped>
.x-icon {
  display: block;
}
</style>

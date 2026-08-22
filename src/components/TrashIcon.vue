<script setup lang="ts">
// Trash-can glyph for destructive row controls (remove a bot seat). The
// accessible name lives on the wrapping button's title/aria-label; the
// glyph itself is decoration.
</script>

<template>
  <svg
    class="trash-icon"
    viewBox="0 0 16 16"
    width="12"
    height="12"
    fill="none"
    aria-hidden="true"
  >
    <path d="M3 4.5h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
    <path d="M6 4.5V3h4v1.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
    <path d="M4.5 4.5 5.2 13h5.6l.7-8.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
    <path d="M6.7 7v3.6M9.3 7v3.6" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
  </svg>
</template>

<style scoped>
.trash-icon {
  display: block;
}
</style>

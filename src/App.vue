<script setup lang="ts">
import GameCanvas from './components/GameCanvas.vue';

// 3D-only: the renderer choice is no longer URL- or storage-driven.
// Any /2d or /3d path the URL still carries is harmless; we just
// rewrite anything that isn't the app root back to the root so future
// reloads come up at the canonical URL.
const path = window.location.pathname;
const base = (import.meta.env.BASE_URL || '/').replace(/\/$/, '');
const after = path.startsWith(base) ? path.slice(base.length) : path;

if (after !== '' && after !== '/') {
  window.history.replaceState(
    null,
    '',
    `${base}/${window.location.search}${window.location.hash}`,
  );
}
</script>

<template>
  <GameCanvas />
</template>

<style>
#app {
  width: 100%;
  height: 100%;
}

/* Disable text selection across the entire app */
* {
  user-select: none;
  -webkit-user-select: none;
  -moz-user-select: none;
  -ms-user-select: none;
}
</style>

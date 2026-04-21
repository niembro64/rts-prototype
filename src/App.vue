<script setup lang="ts">
import PhaserCanvas from './components/PhaserCanvas.vue';
import ThreeCanvas from './components/ThreeCanvas.vue';

// Renderer is chosen by the URL path: /2d or /3d. If neither matches we redirect
// to /2d so users always land on an explicit mode.
const path = window.location.pathname;
const base = (import.meta.env.BASE_URL || '/').replace(/\/$/, '');
const after = path.startsWith(base) ? path.slice(base.length) : path;
const mode = after.startsWith('/3d')
  ? '3d'
  : after.startsWith('/2d')
    ? '2d'
    : null;

if (mode === null) {
  window.history.replaceState(null, '', `${base}/2d${window.location.search}${window.location.hash}`);
}

const use3D = mode === '3d';
</script>

<template>
  <ThreeCanvas v-if="use3D" />
  <PhaserCanvas v-else />
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

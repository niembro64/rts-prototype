<script setup lang="ts">
import GameCanvas from './components/GameCanvas.vue';
import type { RendererMode } from './types/game';

// Renderer is chosen by the URL path: /2d or /3d. If neither matches we redirect
// to /2d so users always land on an explicit mode.
const path = window.location.pathname;
const base = (import.meta.env.BASE_URL || '/').replace(/\/$/, '');
const after = path.startsWith(base) ? path.slice(base.length) : path;
const parsed: RendererMode | null = after.startsWith('/3d')
  ? '3d'
  : after.startsWith('/2d')
    ? '2d'
    : null;

if (parsed === null) {
  window.history.replaceState(
    null,
    '',
    `${base}/2d${window.location.search}${window.location.hash}`,
  );
}

const rendererMode: RendererMode = parsed ?? '2d';
</script>

<template>
  <GameCanvas :renderer-mode="rendererMode" />
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

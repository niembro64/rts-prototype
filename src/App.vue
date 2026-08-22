<script setup lang="ts">
import { defineAsyncComponent, ref, watch } from 'vue';
import { appSurface } from './appSurfaceMachine';

const GameCanvas = defineAsyncComponent(() => import('./components/GameCanvas.vue'));
const EntityLabPage = defineAsyncComponent(() => import('./components/EntityLabPage.vue'));
const GameControlsPage = defineAsyncComponent(() => import('./components/GameControlsPage.vue'));
const GameInfoPage = defineAsyncComponent(() => import('./components/GameInfoPage.vue'));

// The high-level surface lives in the app surface machine
// (src/appSurfaceMachine.ts): init, home, and the game room's sub-states
// are all hosted by GameCanvas; entityLab and gameControls each have their
// own page. This component renders the state and holds no navigation logic
// of its own — the components that own the gestures send the events.
const PAGE_SURFACES = new Set(['entityLab', 'gameControls', 'gameInfo']);
const gameCanvasKey = ref(0);
watch(appSurface, (surface, previous) => {
  // Remount the canvas fresh each time a side page hands control back;
  // moves between the canvas-hosted surfaces never remount it, which is
  // what lets a network session survive them.
  if (PAGE_SURFACES.has(previous) && !PAGE_SURFACES.has(surface)) gameCanvasKey.value++;
});

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
  <EntityLabPage v-if="appSurface === 'entityLab'" />
  <GameControlsPage v-else-if="appSurface === 'gameControls'" />
  <GameInfoPage v-else-if="appSurface === 'gameInfo'" />
  <GameCanvas v-else :key="gameCanvasKey" />
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

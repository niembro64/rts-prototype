<script setup lang="ts">
import GameCanvas from './components/GameCanvas.vue';
import type { RendererMode } from './types/game';
import { getRendererMode, setRendererMode } from './clientBarConfig';

/**
 * Route → renderer resolution:
 *
 *   <base>/       — app root. Initial mode comes from localStorage
 *                   (last chosen) via getRendererMode(), defaulting
 *                   to '2d'. The PLAYER CLIENT bar toggle flips the
 *                   mode live without navigating.
 *   <base>/3d,
 *   <base>/2d     — aliases. The path sets the initial mode AND
 *                   persists via setRendererMode — same code path
 *                   as pressing the button — so the next visit to
 *                   the root keeps whichever was chosen.
 *   anything else — redirect to <base>/, keep stored mode.
 *
 * `<base>` comes from Vite's BASE_URL — e.g. '/budget-annihilation/'
 * in production web builds, '/' inside Tauri. `after` is the path
 * with that prefix stripped so the /3d /2d checks work identically
 * in both environments.
 *
 * The URL is not kept in sync with runtime toggles — that would
 * churn browser history on every click. Persistence goes through
 * clientBarConfig so the storage key stays shared with every other
 * setting.
 */
const path = window.location.pathname;
const base = (import.meta.env.BASE_URL || '/').replace(/\/$/, '');
const after = path.startsWith(base) ? path.slice(base.length) : path;

let mode: RendererMode;

if (after.startsWith('/3d')) {
  mode = '3d';
  setRendererMode('3d');
} else if (after.startsWith('/2d')) {
  mode = '2d';
  setRendererMode('2d');
} else if (after === '' || after === '/') {
  // App root — stored mode wins, no URL change.
  mode = getRendererMode();
} else {
  // Unknown subpath — rewrite to the app root (NOT base+base, which
  // the previous revision produced and broke future reloads). Stored
  // mode still wins.
  mode = getRendererMode();
  window.history.replaceState(
    null,
    '',
    `${base}/${window.location.search}${window.location.hash}`,
  );
}

const rendererMode: RendererMode = mode;
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

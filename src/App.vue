<script setup lang="ts">
import GameCanvas from './components/GameCanvas.vue';
import type { RendererMode } from './types/game';
import { getRendererMode, setRendererMode } from './clientBarConfig';

/**
 * Route → renderer resolution:
 *
 *   /budget-annihilation   — primary route. Initial mode comes from
 *                            localStorage (last chosen), falling back
 *                            to '2d'. The PLAYER CLIENT bar toggle
 *                            flips the mode live without navigating.
 *   /2d, /3d               — compatibility aliases. The path sets the
 *                            initial mode and is persisted to
 *                            localStorage (via setRendererMode — same
 *                            code path as pressing the button) so the
 *                            next visit to /budget-annihilation keeps
 *                            whichever was chosen.
 *   anything else          — redirect to /budget-annihilation.
 *
 * The URL is not kept in sync with runtime toggles — that would churn
 * browser history on every click. Persistence goes through
 * clientBarConfig's getRendererMode/setRendererMode so the storage key
 * and format stay shared with every other setting.
 */
const CANONICAL_PATH = '/budget-annihilation';

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
} else if (after.startsWith(CANONICAL_PATH)) {
  mode = getRendererMode();
} else {
  // Unknown route — redirect to the canonical path and use whichever
  // mode was last chosen (or 2D on first visit).
  mode = getRendererMode();
  window.history.replaceState(
    null,
    '',
    `${base}${CANONICAL_PATH}${window.location.search}${window.location.hash}`,
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

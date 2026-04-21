<script setup lang="ts">
import PhaserCanvas from './components/PhaserCanvas.vue';
import ThreeCanvas from './components/ThreeCanvas.vue';

const use3D = new URLSearchParams(window.location.search).has('3d');
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

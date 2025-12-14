<script setup lang="ts">
import PhaserCanvas from './components/PhaserCanvas.vue';
</script>

<template>
  <PhaserCanvas />
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

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import { createGame, destroyGame } from '../game/createGame';
import type Phaser from 'phaser';

const containerRef = ref<HTMLDivElement | null>(null);
let game: Phaser.Game | null = null;

onMounted(() => {
  if (!containerRef.value) return;

  const rect = containerRef.value.getBoundingClientRect();

  game = createGame({
    parent: containerRef.value,
    width: rect.width || window.innerWidth,
    height: rect.height || window.innerHeight,
  });
});

onUnmounted(() => {
  if (game) {
    destroyGame(game);
    game = null;
  }
});
</script>

<template>
  <div ref="containerRef" class="phaser-container"></div>
</template>

<style scoped>
.phaser-container {
  width: 100%;
  height: 100%;
  overflow: hidden;
}

.phaser-container canvas {
  display: block;
}
</style>

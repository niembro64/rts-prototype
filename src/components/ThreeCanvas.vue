<script setup lang="ts">
// ThreeCanvas — minimal Vue wrapper for the 3D PoC.
//
// Spins up a LocalGameConnection against a background battle GameServer and
// renders it in 3D. No UI, no selection, no multiplayer — this is a proof of
// concept that the server/sim can be visualized with Three.js.

import { ref, onMounted, onUnmounted } from 'vue';
import { createGame3D, type Game3DInstance } from '../game/createGame3D';
import { GameServer } from '../game/server/GameServer';
import { LocalGameConnection } from '../game/server/LocalGameConnection';
import { MAP_SETTINGS } from '../config';
import { BACKGROUND_UNIT_TYPES } from '../game/server/BackgroundBattleStandalone';
import type { PlayerId } from '../game/sim/types';

const container = ref<HTMLDivElement | null>(null);

let gameInstance: Game3DInstance | null = null;
let server: GameServer | null = null;
let connection: LocalGameConnection | null = null;

onMounted(async () => {
  if (!container.value) return;

  const rect = container.value.getBoundingClientRect();

  server = await GameServer.create({
    playerIds: [1, 2, 3, 4] as PlayerId[],
    backgroundMode: true,
  });
  connection = new LocalGameConnection(server);

  server.setTickRate(60);
  server.setSnapshotRate(20);
  server.setKeyframeRatio(10);

  // Enable all background unit types
  for (const ut of BACKGROUND_UNIT_TYPES) {
    server.setBackgroundUnitTypeEnabled(ut, true);
  }
  server.receiveCommand({ type: 'setMaxTotalUnits', tick: 0, maxTotalUnits: 120 });

  const mapSize = MAP_SETTINGS.demo;
  gameInstance = createGame3D({
    parent: container.value,
    width: rect.width,
    height: rect.height,
    gameConnection: connection,
    mapWidth: mapSize.width,
    mapHeight: mapSize.height,
  });
});

onUnmounted(() => {
  gameInstance?.destroy();
  gameInstance = null;
  connection?.disconnect();
  connection = null;
  server?.stop();
  server = null;
});
</script>

<template>
  <div class="three-root">
    <div class="three-canvas" ref="container"></div>
    <div class="three-hint">
      3D PoC — scroll: zoom · middle-drag: pan · alt + middle-drag: orbit
    </div>
  </div>
</template>

<style scoped>
.three-root {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
}
.three-canvas {
  position: absolute;
  inset: 0;
}
.three-hint {
  position: absolute;
  bottom: 8px;
  left: 12px;
  padding: 4px 10px;
  background: rgba(0, 0, 0, 0.5);
  color: #c8d0e0;
  font-family: ui-monospace, monospace;
  font-size: 12px;
  border-radius: 4px;
  pointer-events: none;
  z-index: 10;
}
</style>

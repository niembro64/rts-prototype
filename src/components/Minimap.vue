<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue';

export type { MinimapEntity, MinimapData } from '@/types/ui';
import type { MinimapData } from '@/types/ui';

const props = defineProps<{
  data: MinimapData;
}>();

const emit = defineEmits<{
  (e: 'click', x: number, y: number): void;
}>();

const canvasRef = ref<HTMLCanvasElement | null>(null);

// Minimap display size
const MINIMAP_WIDTH = 180;
const MINIMAP_HEIGHT = 135;

const scale = computed(() => ({
  x: MINIMAP_WIDTH / props.data.mapWidth,
  y: MINIMAP_HEIGHT / props.data.mapHeight,
}));

// Offscreen canvas holding the "slow layer" — map background, grid
// lines, and entity markers. Regenerated only when props.data changes
// (entity refresh cadence is 20 Hz, throttled by the scene). The
// main visible canvas composites this + strokes the camera quad
// every frame; that hot path is ~1 drawImage + 1 polygon stroke,
// so the camera box stays pinned to the view with no lag.
let offscreen: HTMLCanvasElement | null = null;
let offCtx: CanvasRenderingContext2D | null = null;

function ensureOffscreen(): void {
  if (offscreen) return;
  offscreen = document.createElement('canvas');
  offscreen.width = MINIMAP_WIDTH;
  offscreen.height = MINIMAP_HEIGHT;
  offCtx = offscreen.getContext('2d');
}

function drawEntityLayer(): void {
  ensureOffscreen();
  if (!offCtx || !offscreen) return;
  const ctx = offCtx;
  const { mapWidth, mapHeight, entities } = props.data;
  const scaleX = scale.value.x;
  const scaleY = scale.value.y;

  ctx.fillStyle = '#1a1a2e';
  ctx.fillRect(0, 0, MINIMAP_WIDTH, MINIMAP_HEIGHT);

  // Subtle world grid
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
  ctx.lineWidth = 0.5;
  const gridSize = 200;
  for (let x = 0; x <= mapWidth; x += gridSize) {
    ctx.beginPath();
    ctx.moveTo(x * scaleX, 0);
    ctx.lineTo(x * scaleX, MINIMAP_HEIGHT);
    ctx.stroke();
  }
  for (let y = 0; y <= mapHeight; y += gridSize) {
    ctx.beginPath();
    ctx.moveTo(0, y * scaleY);
    ctx.lineTo(MINIMAP_WIDTH, y * scaleY);
    ctx.stroke();
  }

  for (const entity of entities) {
    const x = entity.pos.x * scaleX;
    const y = entity.pos.y * scaleY;
    if (entity.type === 'building') {
      const size = entity.isSelected ? 5 : 4;
      ctx.fillStyle = entity.color;
      ctx.fillRect(x - size / 2, y - size / 2, size, size);
      if (entity.isSelected) {
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1;
        ctx.strokeRect(x - size / 2 - 1, y - size / 2 - 1, size + 2, size + 2);
      }
    } else {
      const radius = entity.isSelected ? 3 : 2;
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fillStyle = entity.color;
      ctx.fill();
      if (entity.isSelected) {
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
  }
}

/** Composite the cached entity layer + stroke the camera quad + the
 *  frame border. Called on every cameraQuad change — cheap. */
function compose(): void {
  const canvas = canvasRef.value;
  if (!canvas || !offscreen) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const { cameraQuad } = props.data;
  const scaleX = scale.value.x;
  const scaleY = scale.value.y;

  ctx.clearRect(0, 0, MINIMAP_WIDTH, MINIMAP_HEIGHT);
  ctx.drawImage(offscreen, 0, 0);

  // Camera footprint polygon — axis-aligned rect for an unrotated
  // 2D camera, rotated rect for 2D with rotation, trapezoid for the
  // 3D perspective camera. Clipped to the minimap bounds so rays
  // above the horizon don't scribble outside.
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, MINIMAP_WIDTH, MINIMAP_HEIGHT);
  ctx.clip();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(cameraQuad[0].x * scaleX, cameraQuad[0].y * scaleY);
  for (let i = 1; i < cameraQuad.length; i++) {
    ctx.lineTo(cameraQuad[i].x * scaleX, cameraQuad[i].y * scaleY);
  }
  ctx.closePath();
  ctx.stroke();
  ctx.restore();

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
  ctx.lineWidth = 2;
  ctx.strokeRect(0, 0, MINIMAP_WIDTH, MINIMAP_HEIGHT);
}

function handleClick(event: MouseEvent) {
  const canvas = canvasRef.value;
  if (!canvas) return;

  const rect = canvas.getBoundingClientRect();
  const clickX = event.clientX - rect.left;
  const clickY = event.clientY - rect.top;

  const worldX = clickX / scale.value.x;
  const worldY = clickY / scale.value.y;

  emit('click', worldX, worldY);
}

// Regenerate the entity layer only when entities / map size change.
// GameCanvas mutates these slower (20 Hz) and keeps `cameraQuad` as
// a live reference that changes every frame — so watching specific
// sub-fields instead of `props.data` lets the cheap camera-only
// path skip the expensive full rebuild.
watch(
  () => [props.data.entities, props.data.mapWidth, props.data.mapHeight],
  () => { drawEntityLayer(); compose(); },
  { deep: false },
);

// Redraw camera box on every quad change (expected 60 Hz).
watch(
  () => props.data.cameraQuad,
  compose,
);

onMounted(() => {
  drawEntityLayer();
  compose();
});
</script>

<template>
  <div class="minimap-container">
    <div class="minimap-label">Map</div>
    <canvas
      ref="canvasRef"
      :width="180"
      :height="135"
      class="minimap-canvas"
      @click="handleClick"
    ></canvas>
  </div>
</template>

<style scoped>
.minimap-container {
  position: absolute;
  top: 60px;  /* Below the top bar */
  left: 10px;
  background: rgba(0, 0, 0, 0.85);
  border: 2px solid rgba(255, 255, 255, 0.2);
  border-radius: 8px;
  padding: 8px;
  font-family: monospace;
  color: white;
  pointer-events: auto;
  z-index: 1000;
}

.minimap-label {
  font-size: 10px;
  color: rgba(255, 255, 255, 0.6);
  text-transform: uppercase;
  margin-bottom: 4px;
}

.minimap-canvas {
  display: block;
  cursor: pointer;
  border-radius: 4px;
}

.minimap-canvas:hover {
  box-shadow: 0 0 8px rgba(255, 255, 255, 0.3);
}
</style>

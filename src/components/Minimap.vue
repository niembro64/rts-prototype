<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue';

export interface MinimapEntity {
  x: number;
  y: number;
  type: 'unit' | 'building';
  color: string;
  isSelected?: boolean;
}

export interface MinimapData {
  mapWidth: number;
  mapHeight: number;
  entities: MinimapEntity[];
  cameraX: number;
  cameraY: number;
  cameraWidth: number;
  cameraHeight: number;
}

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

function draw() {
  const canvas = canvasRef.value;
  if (!canvas) return;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const { mapWidth, mapHeight, entities, cameraX, cameraY, cameraWidth, cameraHeight } = props.data;
  const scaleX = scale.value.x;
  const scaleY = scale.value.y;

  // Clear canvas
  ctx.fillStyle = '#1a1a2e';
  ctx.fillRect(0, 0, MINIMAP_WIDTH, MINIMAP_HEIGHT);

  // Draw grid lines (subtle)
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
  ctx.lineWidth = 0.5;
  const gridSize = 200; // World units
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

  // Draw entities
  for (const entity of entities) {
    const x = entity.x * scaleX;
    const y = entity.y * scaleY;

    if (entity.type === 'building') {
      // Buildings as squares
      const size = entity.isSelected ? 5 : 4;
      ctx.fillStyle = entity.color;
      ctx.fillRect(x - size / 2, y - size / 2, size, size);

      if (entity.isSelected) {
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1;
        ctx.strokeRect(x - size / 2 - 1, y - size / 2 - 1, size + 2, size + 2);
      }
    } else {
      // Units as circles
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

  // Draw camera viewport rectangle
  const camX = cameraX * scaleX;
  const camY = cameraY * scaleY;
  const camW = cameraWidth * scaleX;
  const camH = cameraHeight * scaleY;

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(camX, camY, camW, camH);

  // Draw border
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

  // Convert to world coordinates
  const worldX = clickX / scale.value.x;
  const worldY = clickY / scale.value.y;

  emit('click', worldX, worldY);
}

// Redraw when data changes
watch(() => props.data, draw, { deep: true });

onMounted(() => {
  draw();
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

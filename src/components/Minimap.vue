<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue';
import { getTerrainHeight, WATER_LEVEL } from '@/game/sim/Terrain';
import { PLAYER_COLORS } from '@/game/sim/types';
import type { PlayerId } from '@/game/sim/types';
import { MAP_BG_COLOR } from '@/config';
import { getManaCellMultiplier, getCaptureTileBlendFactors } from '@/game/sim/manaProduction';

export type { MinimapEntity, MinimapData } from '@/types/ui';
import type { MinimapData } from '@/types/ui';

// Same neutral baseline the 3D CaptureTileRenderer3D uses (lifted from
// MAP_BG_COLOR), so unowned cells on the minimap match unowned cells in
// the 3D scene exactly.
const NEUTRAL_R = (MAP_BG_COLOR >> 16) & 0xff;
const NEUTRAL_G = (MAP_BG_COLOR >> 8) & 0xff;
const NEUTRAL_B = MAP_BG_COLOR & 0xff;

const props = defineProps<{
  data: MinimapData;
}>();

const emit = defineEmits<{
  (e: 'click', x: number, y: number): void;
}>();

const canvasRef = ref<HTMLCanvasElement | null>(null);

// Minimap display size. The longest side is pinned at MINIMAP_MAX;
// the other side follows the map's aspect ratio — so a 3000×3000
// square map renders as a 180×180 square, a 4000×2000 map as
// 180×90, and so on. Previously both dimensions were hardcoded 4:3
// regardless of the map, which squashed square maps into rectangles
// and miscomputed the camera-quad overlay.
const MINIMAP_MAX = 180;

const size = computed(() => {
  const mw = Math.max(1, props.data.mapWidth);
  const mh = Math.max(1, props.data.mapHeight);
  if (mw >= mh) {
    return { w: MINIMAP_MAX, h: Math.round(MINIMAP_MAX * mh / mw) };
  }
  return { w: Math.round(MINIMAP_MAX * mw / mh), h: MINIMAP_MAX };
});

const scale = computed(() => ({
  x: size.value.w / props.data.mapWidth,
  y: size.value.h / props.data.mapHeight,
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
  // Rebuild offscreen if the minimap's target dimensions changed
  // (e.g. map swap between sessions, or load-time data arriving).
  if (offscreen && offscreen.width === size.value.w && offscreen.height === size.value.h) return;
  if (!offscreen) {
    offscreen = document.createElement('canvas');
    offCtx = offscreen.getContext('2d');
  }
  offscreen.width = size.value.w;
  offscreen.height = size.value.h;
}

function drawEntityLayer(): void {
  ensureOffscreen();
  if (!offCtx || !offscreen) return;
  const ctx = offCtx;
  const { mapWidth, mapHeight, entities } = props.data;
  const scaleX = scale.value.x;
  const scaleY = scale.value.y;
  const w = size.value.w;
  const h = size.value.h;

  // Lake / background — single pass over every minimap pixel, sample
  // the heightmap once per pixel, write either lake-blue or the dark
  // background color into a single ImageData buffer with full alpha,
  // then putImageData stamps the whole tile in one shot. The minimap
  // is at most 180×180, so this is ~32K terrain samples (each a
  // handful of trig ops); well under a millisecond. drawEntityLayer
  // only fires on entities / mapWidth / mapHeight change — not every
  // frame — so the cost is effectively one-time per data refresh.
  //
  // putImageData ignores canvas composite ops (it stamps raw RGBA),
  // so writing a fully-opaque per-pixel color avoids the alpha-mask
  // dance you'd need with a transparent overlay.
  // Pre-resolve the per-tile dominant-team color + max flag height into
  // flat lookup arrays before the per-pixel loop. Each pixel just maps
  // its world coords to a (cx, cy) and hits these arrays — no nested
  // dict lookups inside the hot loop.
  //
  // Identical two-axis blend (saturation + glow toward white) the 3D
  // CaptureTileRenderer3D uses — see manaProduction.ts. We pre-resolve
  // the FINAL blended RGB per tile once, then the per-pixel hot loop
  // is a flat array lookup. The hotspot's centre-of-map glow shows up
  // here exactly as it does in the 3D scene because both views go
  // through getCaptureTileBlendFactors.
  const { captureTiles, captureCellSize, gridOverlayIntensity, showTerrain } = props.data;
  const overlayActive = showTerrain && captureCellSize > 0 && gridOverlayIntensity > 0 && captureTiles.length > 0;
  let tileFinalR: Uint8ClampedArray | null = null;
  let tileFinalG: Uint8ClampedArray | null = null;
  let tileFinalB: Uint8ClampedArray | null = null;
  let tileHasColor: Uint8Array | null = null;
  let tileCellsX = 0;
  let tileCellsY = 0;
  if (overlayActive) {
    tileCellsX = Math.max(1, Math.ceil(mapWidth / captureCellSize));
    tileCellsY = Math.max(1, Math.ceil(mapHeight / captureCellSize));
    const n = tileCellsX * tileCellsY;
    tileFinalR = new Uint8ClampedArray(n);
    tileFinalG = new Uint8ClampedArray(n);
    tileFinalB = new Uint8ClampedArray(n);
    tileHasColor = new Uint8Array(n);
    for (let i = 0; i < captureTiles.length; i++) {
      const tile = captureTiles[i];
      const { cx, cy } = tile;
      if (cx < 0 || cx >= tileCellsX || cy < 0 || cy >= tileCellsY) continue;
      let totalWeight = 0;
      let r = 0, g = 0, b = 0;
      let maxHeight = 0;
      for (const pidStr in tile.heights) {
        const height = tile.heights[Number(pidStr)];
        if (height <= 0) continue;
        const pc = PLAYER_COLORS[Number(pidStr) as PlayerId];
        if (!pc) continue;
        const color = pc.primary;
        totalWeight += height;
        r += ((color >> 16) & 0xff) * height;
        g += ((color >> 8) & 0xff) * height;
        b += (color & 0xff) * height;
        if (height > maxHeight) maxHeight = height;
      }
      if (totalWeight <= 0) continue;
      const tr = r / totalWeight;
      const tg = g / totalWeight;
      const tb = b / totalWeight;
      const tileMult = getManaCellMultiplier(cx, cy, captureCellSize, mapWidth, mapHeight);
      const { saturation, glow } = getCaptureTileBlendFactors(tileMult, maxHeight, gridOverlayIntensity);
      const invSat = 1 - saturation;
      const invGlow = 1 - glow;
      const idx = cy * tileCellsX + cx;
      // Stage 1: neutral → team colour by saturation.
      // Stage 2: that result → white (255) by glow (hotspot brightness).
      tileFinalR[idx] = (NEUTRAL_R * invSat + tr * saturation) * invGlow + 255 * glow;
      tileFinalG[idx] = (NEUTRAL_G * invSat + tg * saturation) * invGlow + 255 * glow;
      tileFinalB[idx] = (NEUTRAL_B * invSat + tb * saturation) * invGlow + 255 * glow;
      tileHasColor[idx] = 1;
    }
  }

  const lakeImg = ctx.createImageData(w, h);
  const lakePixels = lakeImg.data;
  // Lake color same family as the 3D water plane; background mirrors
  // the previous fillStyle = '#1a1a2e' (= NEUTRAL_*).
  const lakeR = 0x2a, lakeG = 0x55, lakeB = 0x9a;
  let pi = 0;
  if (!showTerrain) {
    // GRID = OFF: 3D scene hides the capture-tile mesh entirely (no
    // land), so the minimap mirrors that — stamp the dark map bg under
    // every pixel and let the entity dots ride on top. Skipping the
    // per-pixel terrain sample is also a meaningful speedup on the
    // canvas-render path.
    for (let py = 0; py < h; py++) {
      for (let px = 0; px < w; px++, pi += 4) {
        lakePixels[pi]     = NEUTRAL_R;
        lakePixels[pi + 1] = NEUTRAL_G;
        lakePixels[pi + 2] = NEUTRAL_B;
        lakePixels[pi + 3] = 0xff;
      }
    }
  } else {
    for (let py = 0; py < h; py++) {
      const worldY = py / scaleY;
      const ty = overlayActive ? Math.floor(worldY / captureCellSize) : 0;
      for (let px = 0; px < w; px++, pi += 4) {
        const worldX = px / scaleX;
        const height = getTerrainHeight(worldX, worldY, mapWidth, mapHeight);
        const wet = height < WATER_LEVEL;
        let outR: number, outG: number, outB: number;
        if (wet) {
          outR = lakeR; outG = lakeG; outB = lakeB;
        } else {
          outR = NEUTRAL_R; outG = NEUTRAL_G; outB = NEUTRAL_B;
          if (overlayActive && tileFinalR && tileFinalG && tileFinalB && tileHasColor) {
            const tx = Math.floor(worldX / captureCellSize);
            if (tx >= 0 && tx < tileCellsX && ty >= 0 && ty < tileCellsY) {
              const idx = ty * tileCellsX + tx;
              if (tileHasColor[idx]) {
                outR = tileFinalR[idx];
                outG = tileFinalG[idx];
                outB = tileFinalB[idx];
              }
            }
          }
        }
        lakePixels[pi]     = outR;
        lakePixels[pi + 1] = outG;
        lakePixels[pi + 2] = outB;
        lakePixels[pi + 3] = 0xff;
      }
    }
  }
  ctx.putImageData(lakeImg, 0, 0);

  // Subtle world grid
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
  ctx.lineWidth = 0.5;
  const gridSize = 200;
  for (let x = 0; x <= mapWidth; x += gridSize) {
    ctx.beginPath();
    ctx.moveTo(x * scaleX, 0);
    ctx.lineTo(x * scaleX, h);
    ctx.stroke();
  }
  for (let y = 0; y <= mapHeight; y += gridSize) {
    ctx.beginPath();
    ctx.moveTo(0, y * scaleY);
    ctx.lineTo(w, y * scaleY);
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
  const w = size.value.w;
  const h = size.value.h;

  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(offscreen, 0, 0);

  // Camera footprint polygon — axis-aligned rect for an unrotated
  // 2D camera, rotated rect for 2D with rotation, trapezoid for the
  // 3D perspective camera. Clipped to the minimap bounds so rays
  // above the horizon don't scribble outside.
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, w, h);
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
  ctx.strokeRect(0, 0, w, h);
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
//
// REACTIVITY CONTRACT: `deep: false` means the watch fires on reference
// change, NOT in-place mutation. Callers (RtsScene*.updateMinimapInfo
// via buildMinimapData) MUST emit a fresh `entities` array on every
// update — buildMinimapData already does this by constructing a new
// array per call. If anything ever starts pushing into the same array
// in-place, flip this to `deep: true` or this watch will silently stop
// firing.
watch(
  () => [
    props.data.entities,
    props.data.mapWidth,
    props.data.mapHeight,
    props.data.captureTiles,
    props.data.captureCellSize,
    props.data.gridOverlayIntensity,
    props.data.showTerrain,
  ],
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
      :width="size.w"
      :height="size.h"
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

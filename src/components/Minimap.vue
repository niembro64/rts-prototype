<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue';
import { getTerrainMeshHeight, WATER_LEVEL } from '@/game/sim/Terrain';
import { MAP_BG_COLOR } from '@/config';
import { getCaptureTileDisplayColor } from '@/game/sim/manaProduction';
import { minimapPointerToWorld } from './minimapHelpers';

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
const draggingPointerId = ref<number | null>(null);

// Minimap display size. The longest side is pinned at MINIMAP_MAX;
// the other side follows the map's aspect ratio — so a 3000×3000
// square map renders as a 180×180 square, a 4000×2000 map as
// 180×90, and so on. Previously both dimensions were hardcoded 4:3
// regardless of the map, which squashed square maps into rectangles
// and miscomputed the camera-quad overlay.
const MINIMAP_MAX = 180;
const DENSE_ENTITY_MARKER_THRESHOLD = 1500;
const DENSE_UNIT_MARKER_SIZE = 2;

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

// Offscreen canvas holding the "slow layer" — terrain/capture
// background and entity markers. Regenerated only when props.data
// changes (entity refresh cadence is 20 Hz, throttled by the scene).
// The main visible canvas composites this + strokes the camera quad
// every frame; that hot path is ~1 drawImage + 1 polygon stroke, so
// the camera box stays pinned to the view with no lag.
let offscreen: HTMLCanvasElement | null = null;
let offCtx: CanvasRenderingContext2D | null = null;
let background: HTMLCanvasElement | null = null;
let backgroundCtx: CanvasRenderingContext2D | null = null;
let backgroundKey = '';
let canvasCtx: CanvasRenderingContext2D | null = null;

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

function ensureBackground(): void {
  if (background && background.width === size.value.w && background.height === size.value.h) return;
  if (!background) {
    background = document.createElement('canvas');
    backgroundCtx = background.getContext('2d');
  }
  background.width = size.value.w;
  background.height = size.value.h;
  backgroundKey = '';
}

function drawBackgroundLayer(): void {
  ensureBackground();
  if (!backgroundCtx || !background) return;
  const ctx = backgroundCtx;
  const { mapWidth, mapHeight } = props.data;
  const scaleX = scale.value.x;
  const scaleY = scale.value.y;
  const w = size.value.w;
  const h = size.value.h;
  const { captureTiles, captureVersion, captureCellSize, gridOverlayIntensity, showTerrain } = props.data;
  const nextKey = [
    w,
    h,
    mapWidth,
    mapHeight,
    captureVersion,
    captureCellSize,
    gridOverlayIntensity,
    showTerrain ? 1 : 0,
  ].join('|');
  if (nextKey === backgroundKey) return;
  backgroundKey = nextKey;

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
  // Identical proportional brightness model the 3D
  // CaptureTileRenderer3D uses — see manaProduction.ts. We
  // pre-resolve the FINAL blended RGB per tile once, then the
  // per-pixel hot loop is a flat array lookup. Each tile's
  // brightness is `intensity × tileMana / maxTileMana`, so the
  // centre tile reaches the GRID-overlay ceiling and every other
  // tile scales down in exact proportion to its mana/sec.
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
      const color = getCaptureTileDisplayColor(
        tile.heights,
        cx, cy,
        captureCellSize,
        mapWidth,
        mapHeight,
        gridOverlayIntensity,
        NEUTRAL_R,
        NEUTRAL_G,
        NEUTRAL_B,
      );
      if (!color.hasColor) continue;
      const idx = cy * tileCellsX + cx;
      tileFinalR[idx] = color.r;
      tileFinalG[idx] = color.g;
      tileFinalB[idx] = color.b;
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
        const height = getTerrainMeshHeight(worldX, worldY, mapWidth, mapHeight);
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
}

function drawEntityLayer(): void {
  ensureOffscreen();
  drawBackgroundLayer();
  if (!offCtx || !offscreen || !background) return;
  const ctx = offCtx;
  const { entities } = props.data;
  const denseMarkers = entities.length >= DENSE_ENTITY_MARKER_THRESHOLD;
  const scaleX = scale.value.x;
  const scaleY = scale.value.y;
  let activeFill = '';
  let activeStroke = '';
  const setFill = (color: string): void => {
    if (activeFill === color) return;
    ctx.fillStyle = color;
    activeFill = color;
  };
  const setStroke = (color: string): void => {
    if (activeStroke === color) return;
    ctx.strokeStyle = color;
    activeStroke = color;
  };
  ctx.clearRect(0, 0, offscreen.width, offscreen.height);
  ctx.drawImage(background, 0, 0);

  for (const entity of entities) {
    const x = entity.pos.x * scaleX;
    const y = entity.pos.y * scaleY;
    if (entity.type === 'building') {
      const size = entity.isSelected ? 5 : 4;
      setFill(entity.color);
      ctx.fillRect(x - size / 2, y - size / 2, size, size);
      if (entity.isSelected) {
        setStroke('#ffffff');
        ctx.lineWidth = 1;
        ctx.strokeRect(x - size / 2 - 1, y - size / 2 - 1, size + 2, size + 2);
      }
    } else if (denseMarkers && !entity.isSelected) {
      // Canvas arc paths are surprisingly expensive when 10k-unit
      // scenes refresh the minimap. Dense-mode units are minimap
      // pixels, not inspectable shapes, so use rect stamps and avoid
      // per-entity path construction.
      setFill(entity.color);
      ctx.fillRect(
        x - DENSE_UNIT_MARKER_SIZE * 0.5,
        y - DENSE_UNIT_MARKER_SIZE * 0.5,
        DENSE_UNIT_MARKER_SIZE,
        DENSE_UNIT_MARKER_SIZE,
      );
    } else {
      const radius = entity.isSelected ? 3 : 2;
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      setFill(entity.color);
      ctx.fill();
      if (entity.isSelected) {
        setStroke('#ffffff');
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
  if (!canvasCtx) canvasCtx = canvas.getContext('2d');
  const ctx = canvasCtx;
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

function emitCameraTargetFromPointer(event: PointerEvent): void {
  const canvas = canvasRef.value;
  if (!canvas) return;
  const target = minimapPointerToWorld(event, canvas, props.data);
  if (!target) return;
  emit('click', target.x, target.y);
}

function handlePointerDown(event: PointerEvent): void {
  if (event.button !== 0) return;
  const canvas = canvasRef.value;
  if (!canvas) return;
  event.preventDefault();
  event.stopPropagation();
  draggingPointerId.value = event.pointerId;
  canvas.setPointerCapture(event.pointerId);
  emitCameraTargetFromPointer(event);
}

function handlePointerMove(event: PointerEvent): void {
  if (draggingPointerId.value !== event.pointerId) return;
  if ((event.buttons & 1) === 0) {
    draggingPointerId.value = null;
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  emitCameraTargetFromPointer(event);
}

function handlePointerEnd(event: PointerEvent): void {
  if (draggingPointerId.value !== event.pointerId) return;
  draggingPointerId.value = null;
  event.preventDefault();
  event.stopPropagation();
}

// Regenerate the entity layer only when minimap content changes.
// GameCanvas mutates these slower (20 Hz) and keeps `cameraQuad` as
// a live reference that changes every frame — so watching specific
// sub-fields instead of `props.data` lets the cheap camera-only
// path skip the expensive full rebuild.
//
// REACTIVITY CONTRACT: callers may reuse entity records in-place, but
// they MUST bump contentVersion whenever that cached content changes.
watch(
  () => [
    props.data.contentVersion,
    props.data.captureVersion,
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
      :class="{ dragging: draggingPointerId !== null }"
      @pointerdown="handlePointerDown"
      @pointermove="handlePointerMove"
      @pointerup="handlePointerEnd"
      @pointercancel="handlePointerEnd"
      @lostpointercapture="handlePointerEnd"
    ></canvas>
  </div>
</template>

<style scoped>
.minimap-container {
  /* Aligned with the bottom-bar aesthetic: dark semi-transparent
   * base + muted gray border. Rounded corners stay. */
  position: relative;
  background: rgba(15, 18, 24, 0.92);
  border: 1px solid #444;
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
  touch-action: none;
  user-select: none;
}

.minimap-canvas:hover {
  box-shadow: 0 0 8px rgba(255, 255, 255, 0.3);
}

.minimap-canvas.dragging {
  cursor: grabbing;
}
</style>

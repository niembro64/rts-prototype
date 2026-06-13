<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue';
import {
  getTerrainMeshHeight,
  getTerrainVersion,
  WATER_LEVEL,
} from '@/game/sim/Terrain';
import { MAP_BG_COLOR } from '@/config';
import { COLORS, readRgbTuple } from '@/colorsConfig';
import { minimapPointerToWorld } from './minimapHelpers';

export type { MinimapEntity, MinimapData } from '@/types/ui';
import type { MinimapData } from '@/types/ui';

export type MinimapMapDrawing = {
  id: string;
  kind: 'line' | 'label';
  points: ReadonlyArray<{ x: number; y: number }>;
  label?: string;
  color: string;
};

// Neutral land baseline lifted from MAP_BG_COLOR so the minimap
// background matches the scene's untextured map floor.
const NEUTRAL_R = (MAP_BG_COLOR >> 16) & 0xff;
const NEUTRAL_G = (MAP_BG_COLOR >> 8) & 0xff;
const NEUTRAL_B = MAP_BG_COLOR & 0xff;
const MINIMAP_WATER_RGB = readRgbTuple(COLORS.ui.minimap.waterRgb, 'ui.minimap.waterRgb');
const MINIMAP_SELECTION_STROKE = COLORS.ui.minimap.selectionStroke;
const MINIMAP_CAMERA_STROKE = COLORS.ui.minimap.cameraStroke;
const MINIMAP_FRAME_STROKE = COLORS.ui.minimap.frameStroke;
const MINIMAP_PANEL = COLORS.ui.minimap.panel;

const props = withDefaults(defineProps<{
  data: MinimapData;
  drawings?: ReadonlyArray<MinimapMapDrawing>;
  dragPan?: boolean;
}>(), {
  drawings: () => [],
  dragPan: true,
});

const emit = defineEmits<{
  (e: 'click', x: number, y: number): void;
  /** Right-click command at a minimap world point (BAR convention:
   *  left = camera, right = order the current selection). `queue`
   *  carries shift-queue. */
  (e: 'command', x: number, y: number, queue: boolean): void;
}>();

const canvasRef = ref<HTMLCanvasElement | null>(null);
const draggingPointerId = ref<number | null>(null);

// Minimap display size. The longest side is pinned at MINIMAP_MAX;
// the other side follows the map's aspect ratio — so a 3000×3000
// square map renders as a 204×204 square, a 4000×2000 map as
// 204×102, and so on. Previously both dimensions were hardcoded 4:3
// regardless of the map, which squashed square maps into rectangles
// and miscomputed the camera-quad overlay.
const MINIMAP_MAX = 204;
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

const minimapStyle = computed(() => ({
  '--minimap-bg': MINIMAP_PANEL.background,
  '--minimap-border': MINIMAP_PANEL.border,
  '--minimap-text': MINIMAP_PANEL.text,
  '--minimap-label': MINIMAP_PANEL.label,
  '--minimap-hover-shadow': MINIMAP_PANEL.hoverShadow,
}));

// Offscreen canvas holding the "slow layer" — terrain background and
// entity markers. Regenerated only when props.data
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

// Water-mask cache. drawBackgroundLayer's pixel loop classifies each
// minimap pixel as wet (height < WATER_LEVEL) or dry; that classification
// only changes when the underlying terrain changes.
//
// Pre-compute the wet/dry decision into a Uint8Array keyed by terrain
// version + canvas size + map dimensions. Subsequent background rebuilds
// just read 1 byte per pixel instead of doing an O(1) mesh sample.
let waterMask: Uint8Array | null = null;
let waterMaskKey = '';

function ensureWaterMask(
  w: number,
  h: number,
  mapWidth: number,
  mapHeight: number,
): Uint8Array {
  const nextKey = [getTerrainVersion(), w, h, mapWidth, mapHeight].join('|');
  if (waterMask && waterMaskKey === nextKey && waterMask.length === w * h) {
    return waterMask;
  }
  const mask = new Uint8Array(w * h);
  const scaleX = w / mapWidth;
  const scaleY = h / mapHeight;
  let mi = 0;
  for (let py = 0; py < h; py++) {
    const worldY = py / scaleY;
    for (let px = 0; px < w; px++, mi++) {
      const worldX = px / scaleX;
      // getTerrainMeshHeight is O(1) against the baked tile map (with
      // analytical fallback before the map is installed). The audit
      // flagged the previous analytical getTerrainHeight call as ~5x
      // more expensive after slope-gated plateaus landed.
      mask[mi] = getTerrainMeshHeight(worldX, worldY, mapWidth, mapHeight)
        < WATER_LEVEL ? 1 : 0;
    }
  }
  waterMask = mask;
  waterMaskKey = nextKey;
  return mask;
}

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
  const w = size.value.w;
  const h = size.value.h;
  const { showTerrain } = props.data;
  const nextKey = [
    w,
    h,
    mapWidth,
    mapHeight,
    showTerrain ? 1 : 0,
  ].join('|');
  if (nextKey === backgroundKey) return;
  backgroundKey = nextKey;

  // Water / background — single pass over every minimap pixel, sample
  // the heightmap once per pixel, write either water-blue or the dark
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
  const waterImg = ctx.createImageData(w, h);
  const waterPixels = waterImg.data;
  // Water color same family as the 3D water plane; background mirrors
  // the neutral map floor color.
  const [waterR, waterG, waterB] = MINIMAP_WATER_RGB;
  let pi = 0;
  if (!showTerrain) {
    // Terrain hidden: stamp the dark map bg under every pixel and let
    // the entity dots ride on top.
    for (let py = 0; py < h; py++) {
      for (let px = 0; px < w; px++, pi += 4) {
        waterPixels[pi]     = NEUTRAL_R;
        waterPixels[pi + 1] = NEUTRAL_G;
        waterPixels[pi + 2] = NEUTRAL_B;
        waterPixels[pi + 3] = 0xff;
      }
    }
  } else {
    // Water is a flat plane at WATER_LEVEL — a pixel is "wet" iff the
    // continuous heightmap underneath it dips below that plane. We
    // pre-bake that decision into a Uint8Array keyed by terrain version
    // (see ensureWaterMask).
    const mask = ensureWaterMask(w, h, mapWidth, mapHeight);
    let mi = 0;
    for (let py = 0; py < h; py++) {
      for (let px = 0; px < w; px++, pi += 4, mi++) {
        let outR: number, outG: number, outB: number;
        if (mask[mi]) {
          outR = waterR; outG = waterG; outB = waterB;
        } else {
          outR = NEUTRAL_R; outG = NEUTRAL_G; outB = NEUTRAL_B;
        }
        waterPixels[pi]     = outR;
        waterPixels[pi + 1] = outG;
        waterPixels[pi + 2] = outB;
        waterPixels[pi + 3] = 0xff;
      }
    }
  }
  ctx.putImageData(waterImg, 0, 0);
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
    if (entity.radarOnly) {
      // FOW-03a: radar contacts render as small neutral dots — same
      // shape whether they're a unit or a building, since radar
      // doesn't reveal identity. Color is already neutralized by
      // ClientMinimapOverrideStore.
      ctx.beginPath();
      ctx.arc(x, y, 1.5, 0, Math.PI * 2);
      setFill(entity.color);
      ctx.fill();
    } else if (entity.type === 'building' || entity.type === 'tower') {
      // Towers use the same static minimap glyph as buildings. The
      // distinction is gameplay (turrets + lock-on), not minimap shape.
      const size = entity.isSelected ? 5 : 4;
      setFill(entity.color);
      ctx.fillRect(x - size / 2, y - size / 2, size, size);
      if (entity.isSelected) {
        setStroke(MINIMAP_SELECTION_STROKE);
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
        setStroke(MINIMAP_SELECTION_STROKE);
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
  }
}

function drawCommunicationLayer(
  ctx: CanvasRenderingContext2D,
  scaleX: number,
  scaleY: number,
): void {
  const drawings = props.drawings;
  if (drawings.length === 0) return;

  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.font = '700 10px system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  ctx.shadowBlur = 5;
  ctx.shadowColor = 'rgba(0, 0, 0, 0.85)';

  for (const drawing of drawings) {
    const points = drawing.points;
    if (drawing.kind === 'line') {
      if (points.length < 2) continue;
      ctx.strokeStyle = drawing.color;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(points[0].x * scaleX, points[0].y * scaleY);
      for (let i = 1; i < points.length; i++) {
        ctx.lineTo(points[i].x * scaleX, points[i].y * scaleY);
      }
      ctx.stroke();
      continue;
    }

    const point = points[0];
    if (!point) continue;
    const x = point.x * scaleX;
    const y = point.y * scaleY;
    const label = drawing.label ?? '';
    ctx.fillStyle = drawing.color;
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.fill();
    if (label.length > 0) {
      const metrics = ctx.measureText(label);
      const padX = 4;
      const boxX = x + 6;
      const boxY = y - 8;
      ctx.shadowBlur = 0;
      ctx.fillStyle = 'rgba(4, 8, 14, 0.78)';
      ctx.fillRect(boxX, boxY, metrics.width + padX * 2, 16);
      ctx.strokeStyle = drawing.color;
      ctx.lineWidth = 1;
      ctx.strokeRect(boxX, boxY, metrics.width + padX * 2, 16);
      ctx.fillStyle = '#f6fbff';
      ctx.fillText(label, boxX + padX, boxY + 8);
      ctx.shadowBlur = 5;
    }
  }

  ctx.restore();
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
  drawCommunicationLayer(ctx, scaleX, scaleY);

  // Camera footprint polygon — axis-aligned rect for an unrotated
  // 2D camera, rotated rect for 2D with rotation, trapezoid for the
  // 3D perspective camera. Clipped to the minimap bounds so rays
  // above the horizon don't scribble outside.
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, w, h);
  ctx.clip();
  ctx.strokeStyle = MINIMAP_CAMERA_STROKE;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(cameraQuad[0].x * scaleX, cameraQuad[0].y * scaleY);
  for (let i = 1; i < cameraQuad.length; i++) {
    ctx.lineTo(cameraQuad[i].x * scaleX, cameraQuad[i].y * scaleY);
  }
  ctx.closePath();
  ctx.stroke();
  ctx.restore();

  ctx.strokeStyle = MINIMAP_FRAME_STROKE;
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
  const canvas = canvasRef.value;
  if (!canvas) return;
  if (event.button === 2) {
    event.preventDefault();
    event.stopPropagation();
    const target = minimapPointerToWorld(event, canvas, props.data);
    if (target) emit('command', target.x, target.y, event.shiftKey);
    return;
  }
  if (event.button !== 0) return;
  event.preventDefault();
  event.stopPropagation();
  draggingPointerId.value = event.pointerId;
  canvas.setPointerCapture(event.pointerId);
  emitCameraTargetFromPointer(event);
}

function handlePointerMove(event: PointerEvent): void {
  if (draggingPointerId.value !== event.pointerId) return;
  if (!props.dragPan) return;
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
    props.data.mapWidth,
    props.data.mapHeight,
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

// Shallow on purpose: the parent builds a fresh drawings array (computed
// .map) whenever content changes, so identity comparison is enough — a
// deep walk of every drawing object per change bought nothing.
watch(
  () => props.drawings,
  compose,
);

onMounted(() => {
  drawEntityLayer();
  compose();
});
</script>

<template>
  <div class="minimap-container" :style="minimapStyle">
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
      @contextmenu.prevent
    ></canvas>
  </div>
</template>

<style scoped>
.minimap-container {
  /* Aligned with the bottom-bar aesthetic: dark semi-transparent
   * base + muted gray border. Rounded corners stay. */
  position: relative;
  background: var(--minimap-bg);
  border: 1px solid var(--minimap-border);
  border-radius: 6px;
  padding: 4px;
  font-family: monospace;
  color: var(--minimap-text);
  pointer-events: auto;
  z-index: 1000;
}

.minimap-canvas {
  display: block;
  cursor: pointer;
  border-radius: 3px;
  touch-action: none;
  user-select: none;
}

.minimap-canvas:hover {
  box-shadow: 0 0 8px var(--minimap-hover-shadow);
}

.minimap-canvas.dragging {
  cursor: grabbing;
}
</style>

<script setup lang="ts">
// Camera-tutorial overlay. Three flashing cards (ZOOM / PAN /
// ROTATE) that teach the new player how to drive the orbit camera.
// Each card disappears the moment that input is detected with at
// least the configured threshold of motion — for ZOOM a small
// distance change is enough (any wheel scroll hits it); PAN and
// ROTATE require a non-trivial sustained input so a stray click on
// the chassis doesn't clear them by accident. Pointer-events are
// off on the whole overlay so the cards never block a click into
// the game underneath. When all three thresholds have been met the
// component emits `done`; the parent persists completion to
// localStorage so subsequent real games don't re-prompt.

import { ref, onMounted, onBeforeUnmount } from 'vue';
import type { OrbitCamera } from '../game/render3d/OrbitCamera';

const props = defineProps<{
  /** Returns the active OrbitCamera instance, or null if the scene
   *  hasn't finished mounting yet. The component polls each frame and
   *  initializes its baseline on the first non-null read, so it's
   *  fine for this to return null during the very first frames. */
  getOrbit: () => OrbitCamera | null;
}>();

const emit = defineEmits<{
  (e: 'done'): void;
}>();

const zoomDone = ref(false);
const panDone = ref(false);
const rotateDone = ref(false);

// ZOOM fires on any noticeable wheel tick; PAN/ROTATE require a
// minimum delta so the card can't be cleared by a tiny accidental
// nudge. PAN is in world units (the map is several thousand wu wide,
// so 100 wu reads as a clear, deliberate slide); ROTATE is in radians
// (~6° — past any inertia from a single frame's drag).
const ZOOM_THRESHOLD = 0.5;
const PAN_THRESHOLD_WU = 100;
const ROTATE_THRESHOLD_RAD = 0.1;

let initialDistance = 0;
let initialTargetX = 0;
let initialTargetZ = 0;
let initialYaw = 0;
let initialized = false;
let rafId: number | null = null;

function angleDelta(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return Math.abs(d);
}

function tick(): void {
  rafId = requestAnimationFrame(tick);
  const orbit = props.getOrbit();
  if (!orbit) return;
  if (!initialized) {
    initialDistance = orbit.distance;
    initialTargetX = orbit.target.x;
    initialTargetZ = orbit.target.z;
    initialYaw = orbit.yaw;
    initialized = true;
    return;
  }
  if (!zoomDone.value && Math.abs(orbit.distance - initialDistance) > ZOOM_THRESHOLD) {
    zoomDone.value = true;
  }
  if (!panDone.value) {
    const dx = orbit.target.x - initialTargetX;
    const dz = orbit.target.z - initialTargetZ;
    if (Math.sqrt(dx * dx + dz * dz) > PAN_THRESHOLD_WU) {
      panDone.value = true;
    }
  }
  if (!rotateDone.value && angleDelta(orbit.yaw, initialYaw) > ROTATE_THRESHOLD_RAD) {
    rotateDone.value = true;
  }
  if (zoomDone.value && panDone.value && rotateDone.value) {
    if (rafId !== null) cancelAnimationFrame(rafId);
    rafId = null;
    emit('done');
  }
}

onMounted(() => {
  rafId = requestAnimationFrame(tick);
});

onBeforeUnmount(() => {
  if (rafId !== null) cancelAnimationFrame(rafId);
  rafId = null;
});
</script>

<template>
  <div class="camera-tutorial">
    <div v-if="!zoomDone" class="tutorial-card">
      <div class="tutorial-title">ZOOM</div>
      <div class="tutorial-desc">Scroll wheel · pinch (touch)</div>
    </div>
    <div v-if="!panDone" class="tutorial-card">
      <div class="tutorial-title">PAN</div>
      <div class="tutorial-desc">Middle-click drag · one-finger drag</div>
    </div>
    <div v-if="!rotateDone" class="tutorial-card">
      <div class="tutorial-title">ROTATE</div>
      <div class="tutorial-desc">Alt + middle-drag · two-finger twist</div>
    </div>
  </div>
</template>

<style scoped>
.camera-tutorial {
  position: fixed;
  top: 80px;
  right: 24px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  z-index: 1500;
  pointer-events: none;
}

.tutorial-card {
  background: rgba(15, 18, 24, 0.85);
  border: 1px solid rgba(74, 158, 255, 0.45);
  border-radius: 8px;
  padding: 12px 18px;
  color: white;
  font-family: monospace;
  text-align: center;
  min-width: 220px;
  box-shadow: 0 0 20px rgba(74, 158, 255, 0.18);
  animation: tutorial-flash 1.6s ease-in-out infinite;
}

.tutorial-title {
  font-size: 18px;
  font-weight: bold;
  letter-spacing: 0.12em;
  color: #4a9eff;
}

.tutorial-desc {
  font-size: 12px;
  color: #aaa;
  margin-top: 4px;
}

@keyframes tutorial-flash {
  0%, 100% { opacity: 0.55; }
  50% { opacity: 1.0; }
}
</style>

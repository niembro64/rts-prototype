<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import * as THREE from 'three';
import type { MinimapData } from '@/types/ui';

const props = withDefaults(defineProps<{
  data: Pick<MinimapData, 'cameraYaw' | 'wind'>;
  compact?: boolean;
}>(), {
  compact: false,
});

const compassCanvasRef = ref<HTMLCanvasElement | null>(null);
const windCanvasRef = ref<HTMLCanvasElement | null>(null);
const windSpeedLabel = computed(() => `${(props.data.wind?.speed ?? 0).toFixed(2)}x`);

type HudView = {
  canvas: HTMLCanvasElement;
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  width: number;
  height: number;
  compact: boolean;
};

let compassView: HudView | null = null;
let windView: HudView | null = null;
let compassRig: THREE.Group | null = null;
let windArrow: THREE.Group | null = null;
let resizeObserver: ResizeObserver | null = null;
let rafId = 0;
let throttleTimer: ReturnType<typeof setTimeout> | null = null;
let lastRenderMs = 0;
let lastCompassYaw = Number.NaN;
let lastWindYaw = Number.NaN;
let lastWindScale = Number.NaN;
let lastWindVisible = false;
let needsRender = true;

const RENDER_INTERVAL_MS = 1000 / 30;
const ANGLE_EPS = 0.0005;
const SCALE_EPS = 0.001;
const COMPACT_CAMERA_FOV = 28;
const DEFAULT_CAMERA_FOV = 38;
const COMPACT_CAMERA_Y = 2.45;
const COMPACT_CAMERA_Z = 2.88;
const DEFAULT_CAMERA_Y = 4.0;
const DEFAULT_CAMERA_Z = 4.8;

const rightVec = new THREE.Vector2();
const upVec = new THREE.Vector2();

function cameraRelativeYaw(x: number, y: number): number {
  const len = Math.hypot(x, y);
  if (len <= 1e-6) return 0;
  const yaw = props.data.cameraYaw ?? 0;
  rightVec.set(Math.cos(yaw), Math.sin(yaw));
  upVec.set(-Math.sin(yaw), Math.cos(yaw));
  const nx = x / len;
  const ny = y / len;
  const right = nx * rightVec.x + ny * rightVec.y;
  const up = nx * upVec.x + ny * upVec.y;
  return Math.atan2(right, up);
}

function makeArrow(material: THREE.Material, accent: THREE.Material): THREE.Group {
  const group = new THREE.Group();
  const shaftLength = 1.65;
  const headLength = 0.62;
  const totalLength = shaftLength + headLength;
  const tail = -totalLength * 0.5;

  const shaft = new THREE.Mesh(
    new THREE.CylinderGeometry(0.105, 0.13, shaftLength, 24),
    material,
  );
  shaft.rotation.x = Math.PI / 2;
  shaft.position.z = tail + shaftLength * 0.5;
  group.add(shaft);

  const head = new THREE.Mesh(
    new THREE.ConeGeometry(0.34, headLength, 32),
    material,
  );
  head.rotation.x = Math.PI / 2;
  head.position.z = tail + shaftLength + headLength * 0.5;
  group.add(head);

  const ridge = new THREE.Mesh(
    new THREE.BoxGeometry(0.065, 0.06, totalLength * 0.76),
    accent,
  );
  ridge.position.set(0, 0.125, 0.02);
  group.add(ridge);

  const tailCap = new THREE.Mesh(
    new THREE.CylinderGeometry(0.17, 0.17, 0.08, 24),
    accent,
  );
  tailCap.rotation.x = Math.PI / 2;
  tailCap.position.z = tail + 0.02;
  group.add(tailCap);

  return group;
}

function makeCompass(
  ringMat: THREE.Material,
  tickMat: THREE.Material,
  northMat: THREE.Material,
  northAccent: THREE.Material,
): THREE.Group {
  const group = new THREE.Group();

  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(0.82, 0.035, 12, 56),
    ringMat,
  );
  ring.rotation.x = Math.PI / 2;
  group.add(ring);

  for (let i = 0; i < 16; i++) {
    const cardinal = i % 4 === 0;
    const angle = (i / 16) * Math.PI * 2;
    const tick = new THREE.Mesh(
      new THREE.BoxGeometry(cardinal ? 0.07 : 0.035, 0.055, cardinal ? 0.26 : 0.15),
      i === 0 ? northMat : tickMat,
    );
    const radius = cardinal ? 0.72 : 0.75;
    tick.position.set(Math.sin(angle) * radius, 0.045, Math.cos(angle) * radius);
    tick.rotation.y = angle;
    group.add(tick);
  }

  const north = makeArrow(northMat, northAccent);
  north.scale.setScalar(0.72);
  north.position.y = 0.085;
  group.add(north);

  const hub = new THREE.Mesh(
    new THREE.CylinderGeometry(0.18, 0.18, 0.08, 28),
    northAccent,
  );
  hub.position.y = 0.09;
  group.add(hub);

  return group;
}

function addHudLights(scene: THREE.Scene): void {
  const ambient = new THREE.AmbientLight(0xffffff, 1.15);
  scene.add(ambient);
  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.position.set(1.8, 4.5, 3.2);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0x8fdcff, 0.65);
  fill.position.set(-2.5, 2.5, -2);
  scene.add(fill);
}

function frameHudCamera(camera: THREE.PerspectiveCamera): void {
  camera.fov = props.compact ? COMPACT_CAMERA_FOV : DEFAULT_CAMERA_FOV;
  camera.position.set(
    0,
    props.compact ? COMPACT_CAMERA_Y : DEFAULT_CAMERA_Y,
    props.compact ? COMPACT_CAMERA_Z : DEFAULT_CAMERA_Z,
  );
  camera.lookAt(0, 0, 0);
  camera.updateProjectionMatrix();
}

function createHudView(canvas: HTMLCanvasElement, root: THREE.Group): HudView {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true,
  });
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, props.compact ? 1.5 : 2));

  const scene = new THREE.Scene();
  addHudLights(scene);
  scene.add(root);

  const camera = new THREE.PerspectiveCamera(
    props.compact ? COMPACT_CAMERA_FOV : DEFAULT_CAMERA_FOV,
    1,
    0.1,
    30,
  );
  frameHudCamera(camera);

  return {
    canvas,
    renderer,
    scene,
    camera,
    width: 0,
    height: 0,
    compact: props.compact,
  };
}

function buildScene(): void {
  const compassCanvas = compassCanvasRef.value;
  const windCanvas = windCanvasRef.value;
  if (!compassCanvas || !windCanvas) return;

  const compassMat = new THREE.MeshPhongMaterial({
    color: 0xe9f0f8,
    specular: 0xffffff,
    shininess: 62,
  });
  const compassAccent = new THREE.MeshPhongMaterial({
    color: 0x7a8796,
    specular: 0xe5edf6,
    shininess: 42,
  });
  const northMat = new THREE.MeshPhongMaterial({
    color: 0xff4c3d,
    specular: 0xffffff,
    shininess: 74,
  });
  const northAccent = new THREE.MeshPhongMaterial({
    color: 0xffd8d2,
    specular: 0xffffff,
    shininess: 58,
  });
  const windMat = new THREE.MeshPhongMaterial({
    color: 0x9be8ff,
    specular: 0xffffff,
    shininess: 70,
  });
  const windAccent = new THREE.MeshPhongMaterial({
    color: 0x246b86,
    specular: 0xbbefff,
    shininess: 50,
  });

  compassRig = makeCompass(compassMat, compassAccent, northMat, northAccent);
  windArrow = makeArrow(windMat, windAccent);
  windArrow.visible = false;

  compassView = createHudView(compassCanvas, compassRig);
  windView = createHudView(windCanvas, windArrow);

  resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(compassCanvas);
  resizeObserver.observe(windCanvas);
  resize();
}

function resizeHudView(view: HudView): boolean {
  const width = Math.max(1, view.canvas.clientWidth);
  const height = Math.max(1, view.canvas.clientHeight);
  if (width === view.width && height === view.height && props.compact === view.compact) {
    return false;
  }
  view.width = width;
  view.height = height;
  view.compact = props.compact;
  view.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, props.compact ? 1.5 : 2));
  view.renderer.setSize(width, height, false);
  view.camera.aspect = width / height;
  frameHudCamera(view.camera);
  return true;
}

function resize(): void {
  let resized = false;
  if (compassView) resized = resizeHudView(compassView) || resized;
  if (windView) resized = resizeHudView(windView) || resized;
  if (resized) requestHudRender();
}

function renderHud(now: number): void {
  rafId = 0;
  if (!compassView || !windView || !compassRig || !windArrow) return;
  if (typeof document !== 'undefined' && document.hidden) {
    needsRender = true;
    return;
  }
  const waitMs = RENDER_INTERVAL_MS - (now - lastRenderMs);
  if (waitMs > 0) {
    if (!throttleTimer) {
      throttleTimer = setTimeout(() => {
        throttleTimer = null;
        requestHudRender();
      }, waitMs);
    }
    return;
  }
  lastRenderMs = now;

  let changed = needsRender;
  const compassYaw = cameraRelativeYaw(0, -1);
  if (Math.abs(compassYaw - lastCompassYaw) > ANGLE_EPS || Number.isNaN(lastCompassYaw)) {
    compassRig.rotation.y = compassYaw;
    lastCompassYaw = compassYaw;
    changed = true;
  }

  const wind = props.data.wind;
  if (wind && wind.speed > 1e-6) {
    if (!lastWindVisible) {
      windArrow.visible = true;
      lastWindVisible = true;
      changed = true;
    }
    const windYaw = cameraRelativeYaw(wind.x, wind.y);
    if (Math.abs(windYaw - lastWindYaw) > ANGLE_EPS || Number.isNaN(lastWindYaw)) {
      windArrow.rotation.y = windYaw;
      lastWindYaw = windYaw;
      changed = true;
    }
    const speedScale = Math.max(0.72, Math.min(1.35, 0.74 + wind.speed * 0.28));
    if (Math.abs(speedScale - lastWindScale) > SCALE_EPS || Number.isNaN(lastWindScale)) {
      windArrow.scale.set(1, 1, speedScale);
      lastWindScale = speedScale;
      changed = true;
    }
  } else if (lastWindVisible) {
    windArrow.visible = false;
    lastWindVisible = false;
    changed = true;
  }

  if (changed) {
    compassView.renderer.render(compassView.scene, compassView.camera);
    windView.renderer.render(windView.scene, windView.camera);
    needsRender = false;
  }
}

function requestHudRender(): void {
  needsRender = true;
  if (throttleTimer) return;
  if (rafId !== 0) return;
  rafId = requestAnimationFrame(renderHud);
}

function handleVisibilityChange(): void {
  if (typeof document !== 'undefined' && !document.hidden) requestHudRender();
}

function disposeSceneResources(root: THREE.Scene): void {
  const disposedGeometries = new Set<THREE.BufferGeometry>();
  const disposedMaterials = new Set<THREE.Material>();
  root.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    if (!disposedGeometries.has(obj.geometry)) {
      obj.geometry.dispose();
      disposedGeometries.add(obj.geometry);
    }
    if (Array.isArray(obj.material)) {
      for (const mat of obj.material) {
        if (disposedMaterials.has(mat)) continue;
        mat.dispose();
        disposedMaterials.add(mat);
      }
    } else if (!disposedMaterials.has(obj.material)) {
      obj.material.dispose();
      disposedMaterials.add(obj.material);
    }
  });
}

onMounted(() => {
  buildScene();
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', handleVisibilityChange);
  }
  requestHudRender();
});

onUnmounted(() => {
  if (typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', handleVisibilityChange);
  }
  if (rafId !== 0) cancelAnimationFrame(rafId);
  if (throttleTimer) clearTimeout(throttleTimer);
  throttleTimer = null;
  resizeObserver?.disconnect();
  resizeObserver = null;
  if (compassView) {
    disposeSceneResources(compassView.scene);
    compassView.renderer.dispose();
  }
  if (windView) {
    disposeSceneResources(windView.scene);
    windView.renderer.dispose();
  }
  compassView = null;
  windView = null;
  compassRig = null;
  windArrow = null;
});

watch(
  () => [
    props.data.cameraYaw ?? 0,
    props.data.wind?.x ?? 0,
    props.data.wind?.y ?? 0,
    props.data.wind?.speed ?? 0,
    props.compact ? 1 : 0,
  ],
  requestHudRender,
);
</script>

<template>
  <div
    class="world-direction-hud"
    :class="{ compact }"
    aria-label="Compass and wind direction"
  >
    <div class="direction-item">
      <canvas ref="compassCanvasRef" class="direction-canvas"></canvas>
      <div class="direction-label">
        <span>Compass</span>
        <strong>N</strong>
      </div>
    </div>
    <div class="direction-item">
      <canvas ref="windCanvasRef" class="direction-canvas"></canvas>
      <div class="direction-label">
        <span>Wind Speed</span>
        <strong>{{ windSpeedLabel }}</strong>
      </div>
    </div>
  </div>
</template>

<style scoped>
.world-direction-hud {
  display: flex;
  align-items: stretch;
  gap: 10px;
  width: 300px;
  height: 118px;
  min-height: 0;
  padding: 0;
  background: transparent;
  border: 0;
  color: white;
  font-family: monospace;
  pointer-events: none;
}

.world-direction-hud.compact {
  width: 276px;
  height: 100%;
}

.direction-item {
  display: flex;
  align-items: stretch;
  gap: 5px;
  min-width: 0;
  flex: 1 1 0;
  height: 100%;
}

.direction-label {
  display: grid;
  align-self: center;
  min-width: 0;
  gap: 1px;
  line-height: 1.05;
  text-align: left;
}

.direction-canvas {
  display: block;
  flex: 0 0 58px;
  width: 58px;
  height: 100%;
  min-height: 0;
}

.world-direction-hud.compact .direction-canvas {
  flex-basis: 58px;
  width: 58px;
}

.direction-label span {
  overflow: hidden;
  color: rgba(255, 255, 255, 0.58);
  font-size: 9px;
  text-shadow: 0 1px 4px rgba(0, 0, 0, 0.75);
  text-overflow: ellipsis;
  text-transform: uppercase;
  white-space: nowrap;
}

.world-direction-hud.compact .direction-label span {
  font-size: 8px;
}

.direction-label strong {
  overflow: hidden;
  color: rgba(255, 255, 255, 0.9);
  font-size: 12px;
  font-weight: 700;
  text-shadow: 0 1px 5px rgba(0, 0, 0, 0.85);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.world-direction-hud.compact .direction-label strong {
  font-size: 10px;
}
</style>

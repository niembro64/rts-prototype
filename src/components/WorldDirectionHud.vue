<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import * as THREE from 'three';
import { COLORS } from '@/colorsConfig';
import type { MinimapData } from '@/types/ui';
import {
  acquireAuxiliaryRendererContext,
  type RendererContextToken,
} from '@/game/render3d/RendererContextBudget';

const props = withDefaults(defineProps<{
  data: Pick<MinimapData, 'cameraView' | 'wind'>;
  compact?: boolean;
}>(), {
  compact: false,
});

const compassCanvasRef = ref<HTMLCanvasElement | null>(null);
const windCanvasRef = ref<HTMLCanvasElement | null>(null);
const windSpeedLabel = computed(() => (props.data.wind?.speed ?? 0).toFixed(2));
const windComponentLabels = computed(() => ({
  x: fmtWindComponent(props.data.wind?.x ?? 0),
  y: fmtWindComponent(props.data.wind?.y ?? 0),
  z: fmtWindComponent(props.data.wind?.z ?? 0),
}));
const HUD_COLORS = COLORS.ui.worldDirectionHud;
const hudStyle = {
  '--world-direction-text': HUD_COLORS.label.text,
  '--world-direction-strong': HUD_COLORS.label.strong,
  '--world-direction-shadow': HUD_COLORS.label.shadow,
  '--world-direction-strong-shadow': HUD_COLORS.label.strongShadow,
} as const;

type HudView = {
  canvas: HTMLCanvasElement;
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  width: number;
  height: number;
  compact: boolean;
  contextToken: RendererContextToken;
};

let compassView: HudView | null = null;
let windView: HudView | null = null;
let compassRig: THREE.Group | null = null;
let windArrow: THREE.Group | null = null;
let resizeObserver: ResizeObserver | null = null;
let rafId = 0;
let throttleTimer: ReturnType<typeof setTimeout> | null = null;
let lastRenderMs = 0;
let lastWindScale = Number.NaN;
let lastWindVisible = false;
let needsRender = true;
let lowMemoryHud = false;

const RENDER_INTERVAL_MS = 1000 / 30;
const SCALE_EPS = 0.001;
const COMPACT_CAMERA_FOV = 20;
const DEFAULT_CAMERA_FOV = 24;
const COMPACT_CAMERA_Y = 3.0;
const COMPACT_CAMERA_Z = 4.1;
const DEFAULT_CAMERA_Y = 4.5;
const DEFAULT_CAMERA_Z = 5.9;

const viewDirection = new THREE.Vector3();
const hudDirection = new THREE.Vector3();
const arrowForward = new THREE.Vector3(0, 0, 1);
const hudRight = new THREE.Vector3();
const hudUp = new THREE.Vector3();
const hudTowardCamera = new THREE.Vector3();

function fmtWindComponent(value: number): string {
  const rounded = Math.abs(value) < 0.05 ? 0 : value;
  const sign = rounded < 0 ? '-' : '+';
  return `${sign}${Math.abs(rounded).toFixed(1)}`;
}

function writeWorldVectorInView(
  x: number,
  y: number,
  z: number,
  out: THREE.Vector3,
): number {
  const { right: viewRight, up: viewUp, towardCamera } = props.data.cameraView;
  const right = x * viewRight.x + y * viewRight.y + z * viewRight.z;
  const up = x * viewUp.x + y * viewUp.y + z * viewUp.z;
  const toward = x * towardCamera.x + y * towardCamera.y + z * towardCamera.z;
  out.set(right, up, toward);
  return out.length();
}

function applyViewArrowDirection(
  view: HudView,
  arrow: THREE.Object3D,
  right: number,
  up: number,
  towardCamera: number,
): void {
  view.camera.updateMatrixWorld();
  const matrix = view.camera.matrixWorld.elements;
  hudRight.set(matrix[0], matrix[1], matrix[2]);
  hudUp.set(matrix[4], matrix[5], matrix[6]);
  hudTowardCamera.set(matrix[8], matrix[9], matrix[10]);
  hudDirection
    .copy(hudRight).multiplyScalar(right)
    .addScaledVector(hudUp, up)
    .addScaledVector(hudTowardCamera, towardCamera);
  const len = hudDirection.length();
  if (len <= 1e-6) return;
  hudDirection.multiplyScalar(1 / len);
  arrow.quaternion.setFromUnitVectors(arrowForward, hudDirection);
}

function makeArrow(material: THREE.Material): THREE.Group {
  const group = new THREE.Group();
  const shaftLength = 0.9;
  const headLength = 0.42;
  const totalLength = shaftLength + headLength;
  const tail = -totalLength * 0.5;

  const shaft = new THREE.Mesh(
    new THREE.CylinderGeometry(0.055, 0.065, shaftLength, 14),
    material,
  );
  shaft.rotation.x = Math.PI / 2;
  shaft.position.z = tail + shaftLength * 0.5;
  group.add(shaft);

  const head = new THREE.Mesh(
    new THREE.ConeGeometry(0.17, headLength, 18),
    material,
  );
  head.rotation.x = Math.PI / 2;
  head.position.z = tail + shaftLength + headLength * 0.5;
  group.add(head);

  return group;
}

function addHudLights(scene: THREE.Scene): void {
  const ambient = new THREE.AmbientLight(
    HUD_COLORS.lights.ambient.colorHex,
    HUD_COLORS.lights.ambient.intensity,
  );
  scene.add(ambient);
  const key = new THREE.DirectionalLight(
    HUD_COLORS.lights.key.colorHex,
    HUD_COLORS.lights.key.intensity,
  );
  key.position.set(1.8, 4.5, 3.2);
  scene.add(key);
  const fill = new THREE.DirectionalLight(
    HUD_COLORS.lights.fill.colorHex,
    HUD_COLORS.lights.fill.intensity,
  );
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

function createHudView(
  canvas: HTMLCanvasElement,
  root: THREE.Group,
  contextToken: RendererContextToken,
): HudView {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true,
  });
  renderer.setClearColor(HUD_COLORS.clear.colorHex, HUD_COLORS.clear.alpha);
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
    contextToken,
  };
}

function buildScene(): void {
  const compassCanvas = compassCanvasRef.value;
  const windCanvas = windCanvasRef.value;
  if (!compassCanvas || !windCanvas) return;

  const compassToken = acquireAuxiliaryRendererContext('world-direction-hud:compass', compassCanvas);
  const windToken = acquireAuxiliaryRendererContext('world-direction-hud:wind', windCanvas);
  if (compassToken === null || windToken === null) {
    compassToken?.release();
    windToken?.release();
    enableLowMemoryHud(compassCanvas, windCanvas);
    return;
  }

  const northMat = makeHudMaterial(HUD_COLORS.materials.north);
  const windMat = makeHudMaterial(HUD_COLORS.materials.wind);

  compassRig = makeArrow(northMat);
  windArrow = makeArrow(windMat);
  windArrow.visible = false;

  try {
    compassView = createHudView(compassCanvas, compassRig, compassToken);
    windView = createHudView(windCanvas, windArrow, windToken);
  } catch (error) {
    if (compassView) {
      disposeHudView(compassView);
      compassView = null;
    } else {
      disposeObjectResources(compassRig);
      compassToken.release();
    }
    if (windView) {
      disposeHudView(windView);
      windView = null;
    } else {
      disposeObjectResources(windArrow);
      windToken.release();
    }
    compassRig = null;
    windArrow = null;
    enableLowMemoryHud(compassCanvas, windCanvas);
    console.warn('WorldDirectionHud: falling back after WebGL HUD init failed.', error);
    return;
  }

  resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(compassCanvas);
  resizeObserver.observe(windCanvas);
  resize();
}

function enableLowMemoryHud(compassCanvas: HTMLCanvasElement, windCanvas: HTMLCanvasElement): void {
  lowMemoryHud = true;
  resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(compassCanvas);
  resizeObserver.observe(windCanvas);
  resize();
}

function makeHudMaterial(config: typeof HUD_COLORS.materials.compass): THREE.MeshPhongMaterial {
  return new THREE.MeshPhongMaterial({
    color: config.colorHex,
    specular: config.specularHex,
    shininess: config.shininess,
  });
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
  if (lowMemoryHud) {
    resizeLowMemoryCanvas(compassCanvasRef.value);
    resizeLowMemoryCanvas(windCanvasRef.value);
    requestHudRender();
    return;
  }
  let resized = false;
  if (compassView) resized = resizeHudView(compassView) || resized;
  if (windView) resized = resizeHudView(windView) || resized;
  if (resized) requestHudRender();
}

function resizeLowMemoryCanvas(canvas: HTMLCanvasElement | null): void {
  if (!canvas) return;
  const dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, props.compact ? 1.5 : 2));
  const width = Math.max(1, Math.round(canvas.clientWidth));
  const height = Math.max(1, Math.round(canvas.clientHeight));
  canvas.width = Math.max(1, Math.round(width * dpr));
  canvas.height = Math.max(1, Math.round(height * dpr));
  const ctx = canvas.getContext('2d');
  ctx?.clearRect(0, 0, canvas.width, canvas.height);
}

function renderHud(now: number): void {
  rafId = 0;
  if (lowMemoryHud) {
    resizeLowMemoryCanvas(compassCanvasRef.value);
    resizeLowMemoryCanvas(windCanvasRef.value);
    needsRender = false;
    return;
  }
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
  writeWorldVectorInView(0, -1, 0, viewDirection);
  applyViewArrowDirection(compassView, compassRig, viewDirection.x, viewDirection.y, 0);

  const wind = props.data.wind;
  if (wind && wind.speed > 1e-6) {
    if (!lastWindVisible) {
      windArrow.visible = true;
      lastWindVisible = true;
      changed = true;
    }
    writeWorldVectorInView(wind.x, wind.y, wind.z, viewDirection);
    applyViewArrowDirection(windView, windArrow, viewDirection.x, viewDirection.y, viewDirection.z);
    const speedScale = Math.max(0.86, Math.min(1.06, 0.86 + wind.speed * 0.0025));
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

function disposeObjectResources(root: THREE.Object3D | null): void {
  if (root === null) return;
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

function disposeHudView(view: HudView): void {
  disposeObjectResources(view.scene);
  view.renderer.renderLists.dispose();
  view.renderer.forceContextLoss();
  view.renderer.dispose();
  view.contextToken.release();
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
  rafId = 0;
  if (throttleTimer) clearTimeout(throttleTimer);
  throttleTimer = null;
  resizeObserver?.disconnect();
  resizeObserver = null;
  lowMemoryHud = false;
  if (compassView) {
    disposeHudView(compassView);
  }
  if (windView) {
    disposeHudView(windView);
  }
  compassView = null;
  windView = null;
  compassRig = null;
  windArrow = null;
});

watch(
  () => [
    props.data.cameraView.right.x,
    props.data.cameraView.right.y,
    props.data.cameraView.right.z,
    props.data.cameraView.up.x,
    props.data.cameraView.up.y,
    props.data.cameraView.up.z,
    props.data.cameraView.towardCamera.x,
    props.data.cameraView.towardCamera.y,
    props.data.cameraView.towardCamera.z,
    props.data.wind?.x ?? 0,
    props.data.wind?.y ?? 0,
    props.data.wind?.z ?? 0,
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
    :style="hudStyle"
    aria-label="Compass and wind direction"
  >
    <div class="direction-item">
      <canvas ref="compassCanvasRef" class="direction-canvas"></canvas>
      <div class="direction-label">
        <span>Compass</span>
        <strong>N</strong>
      </div>
    </div>
    <div class="direction-item wind-item">
      <canvas ref="windCanvasRef" class="direction-canvas"></canvas>
      <div class="direction-label wind-label">
        <span>Wind Speed</span>
        <strong>{{ windSpeedLabel }}</strong>
        <div class="wind-components" aria-label="Wind speed components">
          <span><b>X</b>{{ windComponentLabels.x }}</span>
          <span><b>Y</b>{{ windComponentLabels.y }}</span>
          <span><b>Z</b>{{ windComponentLabels.z }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.world-direction-hud {
  display: flex;
  align-items: stretch;
  gap: 10px;
  width: 330px;
  height: 118px;
  min-height: 0;
  padding: 0;
  background: transparent;
  border: 0;
  color: var(--world-direction-strong);
  font-family: monospace;
  pointer-events: none;
}

.world-direction-hud.compact {
  width: 320px;
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

.wind-item {
  flex: 1.45 1 0;
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
  flex: 0 0 48px;
  width: 48px;
  height: 100%;
  min-height: 0;
}

.world-direction-hud.compact .direction-canvas {
  flex-basis: 48px;
  width: 48px;
}

.direction-label span {
  overflow: hidden;
  color: var(--world-direction-text);
  font-size: 9px;
  text-shadow: 0 1px 4px var(--world-direction-shadow);
  text-overflow: ellipsis;
  text-transform: uppercase;
  white-space: nowrap;
}

.world-direction-hud.compact .direction-label span {
  font-size: 8px;
}

.direction-label strong {
  overflow: hidden;
  color: var(--world-direction-strong);
  font-size: 12px;
  font-weight: 700;
  text-shadow: 0 1px 5px var(--world-direction-strong-shadow);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.world-direction-hud.compact .direction-label strong {
  font-size: 10px;
}

.wind-components {
  display: grid;
  grid-template-columns: repeat(3, max-content);
  gap: 4px;
  min-width: 0;
  margin-top: 1px;
  color: var(--world-direction-strong);
  font-size: 9px;
  font-weight: 700;
  line-height: 1;
  text-shadow: 0 1px 5px var(--world-direction-strong-shadow);
  white-space: nowrap;
}

.wind-components span {
  display: inline-flex;
  align-items: baseline;
  gap: 2px;
}

.wind-components b {
  color: var(--world-direction-text);
  font-size: 8px;
}

.world-direction-hud.compact .wind-components {
  gap: 3px;
  font-size: 9px;
}

.world-direction-hud.compact .wind-components b {
  font-size: 8px;
}
</style>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import * as THREE from 'three';
import { COLORS } from '@/colorsConfig';
import type { MinimapData } from '@/types/ui';
import {
  acquireAuxiliaryRendererContext,
  type RendererContextToken,
} from '@/game/render3d/RendererContextBudget';
import {
  createPrimitiveConeGeometry,
  createPrimitiveCylinderGeometry,
} from '@/game/render3d/PrimitiveGeometryQuality3D';
import { SUN_DIRECTION_SIM } from '@/game/render3d/SunLighting';
import { SUN_RENDER_CONFIG } from '@/config';

const props = defineProps<{
  data: Pick<MinimapData, 'cameraView' | 'directionVersion' | 'wind'>;
}>();

const compassCanvasRef = ref<HTMLCanvasElement | null>(null);
const windCanvasRef = ref<HTMLCanvasElement | null>(null);
const sunCanvasRef = ref<HTMLCanvasElement | null>(null);
/** SUN_DIRECTION_SIM points from the world toward the sun; the HUD arrow
 *  shows the direction the light travels, so it is negated. */
const SUN_LIGHT_TRAVEL_SIM = Object.freeze({
  x: -SUN_DIRECTION_SIM.x,
  y: -SUN_DIRECTION_SIM.y,
  z: -SUN_DIRECTION_SIM.z,
});
const sunElevationLabel = `${Math.round((SUN_RENDER_CONFIG.elevationRad * 180) / Math.PI)}°`;
const windSpeedLabel = computed(() => {
  void props.data.directionVersion;
  return (props.data.wind?.speed ?? 0).toFixed(2);
});
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
  contextToken: RendererContextToken;
};

let compassView: HudView | null = null;
let windView: HudView | null = null;
let sunView: HudView | null = null;
let compassRig: THREE.Group | null = null;
let windArrow: THREE.Group | null = null;
let sunArrow: THREE.Group | null = null;
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
const CAMERA_FOV = 20;
const CAMERA_Y = 3.0;
const CAMERA_Z = 4.1;
const HUD_PIXEL_RATIO_CAP = 1.5;

const viewDirection = new THREE.Vector3();
const hudDirection = new THREE.Vector3();
const arrowForward = new THREE.Vector3(0, 0, 1);
const hudRight = new THREE.Vector3();
const hudUp = new THREE.Vector3();
const hudTowardCamera = new THREE.Vector3();
const lowMemoryCompassDirection = new THREE.Vector3();
const lowMemoryWindDirection = new THREE.Vector3();
const lowMemorySunDirection = new THREE.Vector3();

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
    createPrimitiveCylinderGeometry('hud', 'close', 0.055, 0.065, shaftLength),
    material,
  );
  shaft.rotation.x = Math.PI / 2;
  shaft.position.z = tail + shaftLength * 0.5;
  group.add(shaft);

  const head = new THREE.Mesh(
    createPrimitiveConeGeometry('hud', 'close', 0.17, headLength),
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
  // The bar slot is taller than the canvas is wide; on a narrow canvas the
  // authored fov must widen so a horizontally-pointing arrow keeps the same
  // on-screen margin a square canvas gives it vertically.
  const fovRad = (CAMERA_FOV * Math.PI) / 180;
  const aspect = camera.aspect > 0 ? camera.aspect : 1;
  camera.fov = aspect < 1
    ? (2 * Math.atan(Math.tan(fovRad / 2) / aspect) * 180) / Math.PI
    : CAMERA_FOV;
  camera.position.set(0, CAMERA_Y, CAMERA_Z);
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
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, HUD_PIXEL_RATIO_CAP));

  const scene = new THREE.Scene();
  addHudLights(scene);
  scene.add(root);

  const camera = new THREE.PerspectiveCamera(CAMERA_FOV, 1, 0.1, 30);
  frameHudCamera(camera);

  return {
    canvas,
    renderer,
    scene,
    camera,
    width: 0,
    height: 0,
    contextToken,
  };
}

function buildScene(): void {
  const compassCanvas = compassCanvasRef.value;
  const windCanvas = windCanvasRef.value;
  const sunCanvas = sunCanvasRef.value;
  if (!compassCanvas || !windCanvas || !sunCanvas) return;

  const compassToken = acquireAuxiliaryRendererContext('world-direction-hud:compass', compassCanvas);
  const windToken = acquireAuxiliaryRendererContext('world-direction-hud:wind', windCanvas);
  const sunToken = acquireAuxiliaryRendererContext('world-direction-hud:sun', sunCanvas);
  if (compassToken === null || windToken === null || sunToken === null) {
    compassToken?.release();
    windToken?.release();
    sunToken?.release();
    enableLowMemoryHud(compassCanvas, windCanvas, sunCanvas);
    return;
  }

  const northMat = makeHudMaterial(HUD_COLORS.materials.north);
  const windMat = makeHudMaterial(HUD_COLORS.materials.wind);
  const sunMat = makeHudMaterial(HUD_COLORS.materials.sun);

  compassRig = makeArrow(northMat);
  windArrow = makeArrow(windMat);
  windArrow.visible = false;
  sunArrow = makeArrow(sunMat);

  try {
    compassView = createHudView(compassCanvas, compassRig, compassToken);
    windView = createHudView(windCanvas, windArrow, windToken);
    sunView = createHudView(sunCanvas, sunArrow, sunToken);
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
    if (sunView) {
      disposeHudView(sunView);
      sunView = null;
    } else {
      disposeObjectResources(sunArrow);
      sunToken.release();
    }
    compassRig = null;
    windArrow = null;
    sunArrow = null;
    enableLowMemoryHud(compassCanvas, windCanvas, sunCanvas);
    console.warn('WorldDirectionHud: falling back after WebGL HUD init failed.', error);
    return;
  }

  resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(compassCanvas);
  resizeObserver.observe(windCanvas);
  resizeObserver.observe(sunCanvas);
  resize();
}

function enableLowMemoryHud(
  compassCanvas: HTMLCanvasElement,
  windCanvas: HTMLCanvasElement,
  sunCanvas: HTMLCanvasElement,
): void {
  lowMemoryHud = true;
  resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(compassCanvas);
  resizeObserver.observe(windCanvas);
  resizeObserver.observe(sunCanvas);
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
  if (width === view.width && height === view.height) {
    return false;
  }
  view.width = width;
  view.height = height;
  view.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, HUD_PIXEL_RATIO_CAP));
  view.renderer.setSize(width, height, false);
  view.camera.aspect = width / height;
  frameHudCamera(view.camera);
  return true;
}

function resize(): void {
  if (lowMemoryHud) {
    resizeLowMemoryCanvas(compassCanvasRef.value);
    resizeLowMemoryCanvas(windCanvasRef.value);
    resizeLowMemoryCanvas(sunCanvasRef.value);
    requestHudRender();
    return;
  }
  let resized = false;
  if (compassView) resized = resizeHudView(compassView) || resized;
  if (windView) resized = resizeHudView(windView) || resized;
  if (sunView) resized = resizeHudView(sunView) || resized;
  if (resized) requestHudRender();
}

function resizeLowMemoryCanvas(canvas: HTMLCanvasElement | null): void {
  if (!canvas) return;
  const dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, HUD_PIXEL_RATIO_CAP));
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
    resizeLowMemoryCanvas(sunCanvasRef.value);
    renderLowMemoryHud();
    needsRender = false;
    return;
  }
  if (!compassView || !windView || !sunView || !compassRig || !windArrow || !sunArrow) return;
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

  writeWorldVectorInView(
    SUN_LIGHT_TRAVEL_SIM.x,
    SUN_LIGHT_TRAVEL_SIM.y,
    SUN_LIGHT_TRAVEL_SIM.z,
    viewDirection,
  );
  applyViewArrowDirection(sunView, sunArrow, viewDirection.x, viewDirection.y, viewDirection.z);

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
    sunView.renderer.render(sunView.scene, sunView.camera);
    needsRender = false;
  }
}

function drawLowMemoryArrow(
  canvas: HTMLCanvasElement | null,
  direction: THREE.Vector3,
  color: string,
  visible: boolean,
  scale = 1,
): void {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!visible) return;

  const width = canvas.width;
  const height = canvas.height;
  const cx = width * 0.5;
  const cy = height * 0.5;
  const len = Math.hypot(direction.x, direction.y);
  if (len <= 1e-6) return;
  const ux = direction.x / len;
  const uy = -direction.y / len;
  const length = Math.min(width, height) * 0.34 * scale;
  const head = Math.max(7, length * 0.32);
  const tailX = cx - ux * length * 0.48;
  const tailY = cy - uy * length * 0.48;
  const headX = cx + ux * length * 0.52;
  const headY = cy + uy * length * 0.52;
  const px = -uy;
  const py = ux;

  const arrowHeadPath = (): void => {
    ctx.beginPath();
    ctx.moveTo(headX, headY);
    ctx.lineTo(headX - ux * head + px * head * 0.55, headY - uy * head + py * head * 0.55);
    ctx.lineTo(headX - ux * head - px * head * 0.55, headY - uy * head - py * head * 0.55);
    ctx.closePath();
  };

  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.78)';
  ctx.lineWidth = Math.max(5, width * 0.06);
  ctx.beginPath();
  ctx.moveTo(tailX, tailY);
  ctx.lineTo(headX, headY);
  ctx.stroke();
  arrowHeadPath();
  ctx.fillStyle = 'rgba(0, 0, 0, 0.78)';
  ctx.fill();

  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(2, width * 0.025);
  ctx.beginPath();
  ctx.moveTo(tailX, tailY);
  ctx.lineTo(headX, headY);
  ctx.stroke();
  arrowHeadPath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.restore();
}

function renderLowMemoryHud(): void {
  writeWorldVectorInView(0, -1, 0, lowMemoryCompassDirection);
  drawLowMemoryArrow(
    compassCanvasRef.value,
    lowMemoryCompassDirection,
    `#${HUD_COLORS.materials.north.colorHex.toString(16).padStart(6, '0')}`,
    true,
  );

  const wind = props.data.wind;
  if (wind && wind.speed > 1e-6) {
    writeWorldVectorInView(wind.x, wind.y, wind.z, lowMemoryWindDirection);
    const speedScale = Math.max(0.86, Math.min(1.06, 0.86 + wind.speed * 0.0025));
    drawLowMemoryArrow(
      windCanvasRef.value,
      lowMemoryWindDirection,
      `#${HUD_COLORS.materials.wind.colorHex.toString(16).padStart(6, '0')}`,
      true,
      speedScale,
    );
  } else {
    drawLowMemoryArrow(
      windCanvasRef.value,
      lowMemoryWindDirection,
      `#${HUD_COLORS.materials.wind.colorHex.toString(16).padStart(6, '0')}`,
      false,
    );
  }

  writeWorldVectorInView(
    SUN_LIGHT_TRAVEL_SIM.x,
    SUN_LIGHT_TRAVEL_SIM.y,
    SUN_LIGHT_TRAVEL_SIM.z,
    lowMemorySunDirection,
  );
  drawLowMemoryArrow(
    sunCanvasRef.value,
    lowMemorySunDirection,
    `#${HUD_COLORS.materials.sun.colorHex.toString(16).padStart(6, '0')}`,
    true,
  );
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
  if (sunView) {
    disposeHudView(sunView);
  }
  compassView = null;
  windView = null;
  sunView = null;
  compassRig = null;
  windArrow = null;
  sunArrow = null;
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
    props.data.directionVersion,
  ],
  requestHudRender,
);
</script>

<template>
  <div
    class="world-direction-hud"
    :style="hudStyle"
    aria-label="Compass, sunlight, and wind direction"
  >
    <div class="direction-item">
      <canvas ref="compassCanvasRef" class="direction-canvas"></canvas>
      <div class="direction-label">
        <span>Compass</span>
        <strong>N</strong>
      </div>
    </div>
    <div class="direction-item">
      <canvas ref="sunCanvasRef" class="direction-canvas"></canvas>
      <div class="direction-label">
        <span>Sunlight</span>
        <strong>{{ sunElevationLabel }}</strong>
      </div>
    </div>
    <div class="direction-item">
      <canvas ref="windCanvasRef" class="direction-canvas"></canvas>
      <div class="direction-label">
        <span>Wind</span>
        <strong>{{ windSpeedLabel }}</strong>
      </div>
    </div>
  </div>
</template>

<style scoped>
.world-direction-hud {
  display: flex;
  align-items: stretch;
  gap: 6px;
  width: max-content;
  height: 100%;
  min-height: 0;
  padding: 0;
  background: transparent;
  border: 0;
  color: var(--world-direction-strong);
  font-family: monospace;
  pointer-events: none;
}

.direction-item {
  display: flex;
  align-items: stretch;
  gap: 4px;
  flex: 0 0 auto;
  height: 100%;
}

.direction-label {
  display: grid;
  align-self: center;
  gap: 1px;
  line-height: 1.05;
  text-align: left;
}

.direction-canvas {
  display: block;
  flex: 0 0 30px;
  width: 30px;
  height: 100%;
  min-height: 0;
}

.direction-label span {
  color: var(--world-direction-text);
  font-size: 7px;
  text-shadow: 0 1px 4px var(--world-direction-shadow);
  text-transform: uppercase;
  white-space: nowrap;
}

.direction-label strong {
  color: var(--world-direction-strong);
  font-size: 9px;
  font-weight: 700;
  text-shadow: 0 1px 5px var(--world-direction-strong-shadow);
  white-space: nowrap;
}
</style>

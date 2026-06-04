<script setup lang="ts">
// Tiny standalone Three.js avatar — one icosahedron in the player's
// team color, rotating around its vertical axis. Used in the GAME
// LOBBY player list to give each row a recognizable per-player
// motif. Each instance owns its own WebGLRenderer + scene + canvas;
// with the lobby cap of 6 players that's well under the browser's
// WebGL context limit (Chrome ~16). Geometry is shared module-wide
// so the cost per avatar is roughly one material + one Mesh.

import { ref, onMounted, onUnmounted, watch } from 'vue';
import * as THREE from 'three';
import { COLORS } from '@/colorsConfig';
import {
  acquireAuxiliaryRendererContext,
  type RendererContextToken,
} from '@/game/render3d/RendererContextBudget';

const props = defineProps<{
  /** Hex color string for the icosahedron's
   *  Lambert material. */
  color: string;
  /** Width / height of the canvas in CSS pixels. The component
   *  applies devicePixelRatio internally, so the bitmap is sharp
   *  on hi-DPI displays. */
  size: number;
}>();

const canvasRef = ref<HTMLCanvasElement | null>(null);

const AVATAR_COLORS = COLORS.ui.commanderAvatar;

let renderer: THREE.WebGLRenderer | null = null;
let scene: THREE.Scene | null = null;
let camera: THREE.PerspectiveCamera | null = null;
let geometry: THREE.IcosahedronGeometry | null = null;
let mesh: THREE.Mesh | null = null;
let material: THREE.MeshLambertMaterial | null = null;
let contextToken: RendererContextToken | null = null;
let canvasFallback = false;
let rafId = 0;

function start(): void {
  stop();
  const canvas = canvasRef.value;
  if (!canvas) return;
  const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));

  contextToken = acquireAuxiliaryRendererContext('commander-avatar', canvas);
  if (contextToken === null) {
    canvasFallback = true;
    drawCanvasFallback(canvas);
    return;
  }

  try {
    renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  } catch (error) {
    contextToken.release();
    contextToken = null;
    canvasFallback = true;
    drawCanvasFallback(canvas);
    console.warn('CommanderAvatar: falling back to canvas renderer after WebGL init failed.', error);
    return;
  }
  renderer.setPixelRatio(dpr);
  renderer.setSize(props.size, props.size, false);

  scene = new THREE.Scene();
  // 45° vertical FOV at z=3.5 reveals ~2.9 wu vertical / horizontal
  // (1:1 aspect), giving ~45 % margin around the unit-radius
  // icosahedron's diameter-2 bounding box. The earlier 35°/z=3
  // framing only revealed 1.89 wu, so the icosahedron's outer
  // facets ran into the canvas edge and clipped to the row.
  camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
  camera.position.set(0, 0, 3.5);

  material = new THREE.MeshLambertMaterial({ color: props.color });
  geometry = new THREE.IcosahedronGeometry(1, 0);
  mesh = new THREE.Mesh(geometry, material);
  // Slight forward tilt so the icosahedron's facets read at any
  // rotation phase — straight-on the silhouette can flatten when
  // a vertex points directly at the camera.
  mesh.rotation.x = 0.45;
  scene.add(mesh);

  scene.add(new THREE.AmbientLight(
    AVATAR_COLORS.ambient.colorHex,
    AVATAR_COLORS.ambient.intensity,
  ));
  const sun = new THREE.DirectionalLight(
    AVATAR_COLORS.sun.colorHex,
    AVATAR_COLORS.sun.intensity,
  );
  sun.position.set(2, 3, 2);
  scene.add(sun);

  function tick() {
    if (!mesh || !renderer || !scene || !camera) return;
    mesh.rotation.y += 0.02;
    renderer.render(scene, camera);
    rafId = requestAnimationFrame(tick);
  }
  tick();
}

function stop(): void {
  cancelAnimationFrame(rafId);
  rafId = 0;
  canvasFallback = false;
  scene?.clear();
  geometry?.dispose();
  material?.dispose();
  if (renderer) {
    renderer.renderLists.dispose();
    renderer.forceContextLoss();
    renderer.dispose();
  }
  contextToken?.release();
  renderer = null;
  contextToken = null;
  scene = null;
  camera = null;
  geometry = null;
  mesh = null;
  material = null;
}

function drawCanvasFallback(canvas: HTMLCanvasElement): void {
  const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
  const pixelSize = Math.max(1, Math.round(props.size * dpr));
  canvas.width = pixelSize;
  canvas.height = pixelSize;
  canvas.style.width = `${props.size}px`;
  canvas.style.height = `${props.size}px`;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, props.size, props.size);
  const cx = props.size * 0.5;
  const cy = props.size * 0.5;
  const r = props.size * 0.34;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(Math.PI * 0.25);
  ctx.fillStyle = props.color;
  ctx.strokeStyle = AVATAR_COLORS.sun.colorHex;
  ctx.lineWidth = Math.max(1, props.size * 0.05);
  ctx.beginPath();
  ctx.rect(-r * 0.72, -r * 0.72, r * 1.44, r * 1.44);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

onMounted(() => start());
onUnmounted(() => stop());

// Color is the only prop that can change in practice (player
// switches seats — rare, but covered). Rebuild the material with
// the new color; everything else stays.
watch(() => props.color, (next) => {
  if (material) {
    material.color.set(next);
  } else if (canvasFallback && canvasRef.value) {
    drawCanvasFallback(canvasRef.value);
  }
});
</script>

<template>
  <canvas
    ref="canvasRef"
    class="commander-avatar"
    :width="size"
    :height="size"
    :style="{ width: `${size}px`, height: `${size}px` }"
  ></canvas>
</template>

<style scoped>
.commander-avatar {
  display: block;
  flex-shrink: 0;
}
</style>

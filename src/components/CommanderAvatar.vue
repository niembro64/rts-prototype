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

const props = defineProps<{
  /** Hex color string (e.g. '#ff4444') for the icosahedron's
   *  Lambert material. */
  color: string;
  /** Width / height of the canvas in CSS pixels. The component
   *  applies devicePixelRatio internally, so the bitmap is sharp
   *  on hi-DPI displays. */
  size: number;
}>();

const canvasRef = ref<HTMLCanvasElement | null>(null);

// Module-shared geometry: every avatar renders the same shape, so
// there's no point allocating one per instance. Disposed at app
// teardown isn't strictly needed for module-level state but
// dropping the reference would let it be GC'd on hot-reload.
const SHARED_GEOM = new THREE.IcosahedronGeometry(1, 0);
const AMBIENT_COLOR = 0xffffff;
const SUN_COLOR = 0xffffff;

let renderer: THREE.WebGLRenderer | null = null;
let scene: THREE.Scene | null = null;
let camera: THREE.PerspectiveCamera | null = null;
let mesh: THREE.Mesh | null = null;
let material: THREE.MeshLambertMaterial | null = null;
let rafId = 0;

function start(): void {
  const canvas = canvasRef.value;
  if (!canvas) return;
  const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));

  renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
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
  mesh = new THREE.Mesh(SHARED_GEOM, material);
  // Slight forward tilt so the icosahedron's facets read at any
  // rotation phase — straight-on the silhouette can flatten when
  // a vertex points directly at the camera.
  mesh.rotation.x = 0.45;
  scene.add(mesh);

  scene.add(new THREE.AmbientLight(AMBIENT_COLOR, 0.55));
  const sun = new THREE.DirectionalLight(SUN_COLOR, 0.85);
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
  material?.dispose();
  renderer?.dispose();
  renderer = null;
  scene = null;
  camera = null;
  mesh = null;
  material = null;
}

onMounted(() => start());
onUnmounted(() => stop());

// Color is the only prop that can change in practice (player
// switches seats — rare, but covered). Rebuild the material with
// the new color; everything else stays.
watch(() => props.color, (next) => {
  if (material) {
    material.color.set(next);
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

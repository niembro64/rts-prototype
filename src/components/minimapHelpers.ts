import { markRaw } from 'vue';
import type { CameraViewBasis, MinimapData, MinimapEntity } from '@/types/ui';
import type { Vec2 } from '@/types/vec2';
import { assignCameraViewBasis, cloneCameraViewBasis } from '@/game/cameraViewBasis';

const DEFAULT_CAMERA_PITCH = Math.PI * 0.25;
const DEFAULT_CAMERA_VIEW: CameraViewBasis = {
  right: { x: 1, y: 0, z: 0 },
  up: { x: 0, y: Math.cos(DEFAULT_CAMERA_PITCH), z: Math.sin(DEFAULT_CAMERA_PITCH) },
  towardCamera: { x: 0, y: -Math.sin(DEFAULT_CAMERA_PITCH), z: Math.cos(DEFAULT_CAMERA_PITCH) },
};

function cloneWind(source: MinimapData['wind']): MinimapData['wind'] {
  return source === undefined
    ? undefined
    : { x: source.x, y: source.y, z: source.z, speed: source.speed };
}

export function createInitialMinimapData(
  mapWidth = 2000,
  mapHeight = 2000,
): MinimapData {
  const viewWidth = Math.min(800, mapWidth);
  const viewHeight = Math.min(600, mapHeight);
  return {
    contentVersion: 0,
    mapWidth,
    mapHeight,
    entities: markRaw([] as MinimapEntity[]),
    cameraQuad: markRaw([
      { x: 0, y: 0 },
      { x: viewWidth, y: 0 },
      { x: viewWidth, y: viewHeight },
      { x: 0, y: viewHeight },
    ]),
    cameraYaw: 0,
    cameraPitch: DEFAULT_CAMERA_PITCH,
    cameraView: cloneCameraViewBasis(DEFAULT_CAMERA_VIEW),
    directionVersion: 0,
    showTerrain: true,
    wind: undefined,
  };
}

export function applyMinimapContentData(
  target: MinimapData,
  source: MinimapData,
): void {
  target.contentVersion = source.contentVersion;
  target.entities = markRaw(source.entities);
  target.mapWidth = source.mapWidth;
  target.mapHeight = source.mapHeight;
  target.cameraYaw = source.cameraYaw;
  target.cameraPitch = source.cameraPitch;
  assignCameraViewBasis(target.cameraView, source.cameraView);
  target.directionVersion += 1;
  target.showTerrain = source.showTerrain;
  target.wind = cloneWind(source.wind);
}

/** Last-applied camera pose per minimap target: 8 quad coords, yaw, pitch,
 *  and the 9 view-basis components. The scene calls the quad update every
 *  render frame with an identity-stable, mutated-in-place array, so without
 *  this compare the directionVersion bump wakes the direction-HUD watcher
 *  every frame even with a motionless camera. */
const cameraQuadSignatures = new WeakMap<MinimapData, Float64Array>();

export function applyMinimapCameraQuad(
  target: MinimapData,
  cameraQuad: MinimapData['cameraQuad'],
  cameraYaw?: number,
  cameraPitch?: number,
  cameraView?: CameraViewBasis,
): void {
  let sig = cameraQuadSignatures.get(target);
  if (sig === undefined) {
    sig = new Float64Array(19).fill(Number.NaN);
    cameraQuadSignatures.set(target, sig);
  }
  let changed = target.cameraQuad !== cameraQuad;
  for (let p = 0; p < 4; p++) {
    const point = cameraQuad[p];
    const base = p * 2;
    if (sig[base] !== point.x) { sig[base] = point.x; changed = true; }
    if (sig[base + 1] !== point.y) { sig[base + 1] = point.y; changed = true; }
  }
  if (cameraYaw !== undefined && sig[8] !== cameraYaw) { sig[8] = cameraYaw; changed = true; }
  if (cameraPitch !== undefined && sig[9] !== cameraPitch) { sig[9] = cameraPitch; changed = true; }
  if (cameraView !== undefined) {
    const b = [
      cameraView.right.x, cameraView.right.y, cameraView.right.z,
      cameraView.up.x, cameraView.up.y, cameraView.up.z,
      cameraView.towardCamera.x, cameraView.towardCamera.y, cameraView.towardCamera.z,
    ];
    for (let i = 0; i < 9; i++) {
      if (sig[10 + i] !== b[i]) { sig[10 + i] = b[i]; changed = true; }
    }
  }
  if (!changed) return;
  target.cameraQuad = markRaw(cameraQuad);
  if (cameraYaw !== undefined) target.cameraYaw = cameraYaw;
  if (cameraPitch !== undefined) target.cameraPitch = cameraPitch;
  if (cameraView !== undefined) assignCameraViewBasis(target.cameraView, cameraView);
  target.directionVersion += 1;
}

export function minimapPointerToWorld(
  event: PointerEvent,
  canvas: HTMLCanvasElement,
  data: Pick<MinimapData, 'mapWidth' | 'mapHeight'>,
): Vec2 | null {
  const rect = canvas.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;

  const localX = Math.max(0, Math.min(rect.width, event.clientX - rect.left));
  const localY = Math.max(0, Math.min(rect.height, event.clientY - rect.top));
  return {
    x: (localX / rect.width) * data.mapWidth,
    y: (localY / rect.height) * data.mapHeight,
  };
}

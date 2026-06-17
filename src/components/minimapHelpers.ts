import type { CameraViewBasis, MinimapData } from '@/types/ui';
import type { Vec2 } from '@/types/vec2';

const DEFAULT_CAMERA_PITCH = Math.PI * 0.25;
const DEFAULT_CAMERA_VIEW: CameraViewBasis = {
  right: { x: 1, y: 0, z: 0 },
  up: { x: 0, y: Math.cos(DEFAULT_CAMERA_PITCH), z: Math.sin(DEFAULT_CAMERA_PITCH) },
  towardCamera: { x: 0, y: -Math.sin(DEFAULT_CAMERA_PITCH), z: Math.cos(DEFAULT_CAMERA_PITCH) },
};

function createCameraViewBasis(source = DEFAULT_CAMERA_VIEW): CameraViewBasis {
  return {
    right: { ...source.right },
    up: { ...source.up },
    towardCamera: { ...source.towardCamera },
  };
}

function applyCameraViewBasis(target: CameraViewBasis, source: CameraViewBasis): void {
  target.right.x = source.right.x;
  target.right.y = source.right.y;
  target.right.z = source.right.z;
  target.up.x = source.up.x;
  target.up.y = source.up.y;
  target.up.z = source.up.z;
  target.towardCamera.x = source.towardCamera.x;
  target.towardCamera.y = source.towardCamera.y;
  target.towardCamera.z = source.towardCamera.z;
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
    entities: [],
    cameraQuad: [
      { x: 0, y: 0 },
      { x: viewWidth, y: 0 },
      { x: viewWidth, y: viewHeight },
      { x: 0, y: viewHeight },
    ],
    cameraYaw: 0,
    cameraPitch: DEFAULT_CAMERA_PITCH,
    cameraView: createCameraViewBasis(),
    showTerrain: true,
    wind: undefined,
  };
}

export function applyMinimapContentData(
  target: MinimapData,
  source: MinimapData,
): void {
  target.contentVersion = source.contentVersion;
  target.entities = source.entities;
  target.mapWidth = source.mapWidth;
  target.mapHeight = source.mapHeight;
  target.cameraYaw = source.cameraYaw;
  target.cameraPitch = source.cameraPitch;
  applyCameraViewBasis(target.cameraView, source.cameraView);
  target.showTerrain = source.showTerrain;
  target.wind = source.wind;
}

export function applyMinimapCameraQuad(
  target: MinimapData,
  cameraQuad: MinimapData['cameraQuad'],
  cameraYaw?: number,
  cameraPitch?: number,
  cameraView?: CameraViewBasis,
): void {
  target.cameraQuad = cameraQuad;
  if (cameraYaw !== undefined) target.cameraYaw = cameraYaw;
  if (cameraPitch !== undefined) target.cameraPitch = cameraPitch;
  if (cameraView !== undefined) applyCameraViewBasis(target.cameraView, cameraView);
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

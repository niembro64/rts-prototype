import type { MinimapData } from '@/types/ui';
import type { Vec2 } from '@/types/vec2';

export function createInitialMinimapData(
  mapWidth = 2000,
  mapHeight = 2000,
): MinimapData {
  const viewWidth = Math.min(800, mapWidth);
  const viewHeight = Math.min(600, mapHeight);
  return {
    mapWidth,
    mapHeight,
    entities: [],
    cameraQuad: [
      { x: 0, y: 0 },
      { x: viewWidth, y: 0 },
      { x: viewWidth, y: viewHeight },
      { x: 0, y: viewHeight },
    ],
    captureTiles: [],
    captureCellSize: 0,
    gridOverlayIntensity: 0,
    showTerrain: true,
  };
}

export function applyMinimapContentData(
  target: MinimapData,
  source: MinimapData,
): void {
  target.entities = source.entities;
  target.mapWidth = source.mapWidth;
  target.mapHeight = source.mapHeight;
  target.captureTiles = source.captureTiles;
  target.captureCellSize = source.captureCellSize;
  target.gridOverlayIntensity = source.gridOverlayIntensity;
  target.showTerrain = source.showTerrain;
}

export function applyMinimapCameraQuad(
  target: MinimapData,
  cameraQuad: MinimapData['cameraQuad'],
): void {
  target.cameraQuad = cameraQuad;
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

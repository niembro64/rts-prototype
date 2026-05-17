// Capture tile display helpers.
//
// Territory ownership is visual state only: tile color blends toward the
// owning teams in proportion to flag height and the active GRID overlay
// intensity. Capture does not produce or carry any economy resource.

import { getPlayerPrimaryColor } from './types';
import type { PlayerId } from './types';

export function getCaptureTileBrightness(
  totalOwnershipHeight: number,
  intensity: number,
): number {
  if (intensity <= 0 || totalOwnershipHeight <= 0) return 0;
  return Math.min(1, intensity * Math.min(1, totalOwnershipHeight));
}

export type CaptureTileColor = {
  hasColor: boolean;
  r: number;
  g: number;
  b: number;
};

export function getCaptureTileDisplayColor(
  heights: Record<number, number>,
  _cx: number,
  _cy: number,
  _cellSize: number,
  _mapWidth: number,
  _mapHeight: number,
  intensity: number,
  neutralR: number,
  neutralG: number,
  neutralB: number,
): CaptureTileColor {
  let totalWeight = 0;
  let r = 0;
  let g = 0;
  let b = 0;
  for (const pidStr in heights) {
    const height = heights[Number(pidStr)];
    if (height <= 0) continue;
    const color = getPlayerPrimaryColor(Number(pidStr) as PlayerId);
    totalWeight += height;
    r += ((color >> 16) & 0xff) * height;
    g += ((color >> 8) & 0xff) * height;
    b += (color & 0xff) * height;
  }
  if (totalWeight <= 0) {
    return { hasColor: false, r: neutralR, g: neutralG, b: neutralB };
  }

  const mix = getCaptureTileBrightness(totalWeight, intensity);
  const inv = 1 - mix;
  return {
    hasColor: true,
    r: neutralR * inv + (r / totalWeight) * mix,
    g: neutralG * inv + (g / totalWeight) * mix,
    b: neutralB * inv + (b / totalWeight) * mix,
  };
}

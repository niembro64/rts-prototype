import type { BuildingSupportSurface } from './types';
import { isOddQuarterTurnGridRotation } from './buildGrid';

export type BuildingSupportQueryOptions = {
  bodyZ?: number;
  groundOffset?: number;
};

export function cloneBuildingSupportSurface(
  surface: BuildingSupportSurface,
  rotation = 0,
): BuildingSupportSurface {
  if (surface.kind === 'none') {
    return { kind: 'none' };
  }
  const swap = isOddQuarterTurnGridRotation(rotation);
  return {
    kind: 'boxTop',
    topZ: surface.topZ,
    width: swap ? surface.height : surface.width,
    height: swap ? surface.width : surface.height,
  };
}

export function createCollisionTopBuildingSupportSurface(
  width: number,
  height: number,
  depth: number,
): BuildingSupportSurface {
  return { kind: 'boxTop', topZ: depth, width, height };
}


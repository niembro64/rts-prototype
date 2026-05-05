import { MAP_GENERATION_EXTENT_FRACTION } from '../../mapSizeConfig';

export type MapOvalMetrics = {
  readonly cx: number;
  readonly cy: number;
  readonly minDim: number;
  readonly scaleX: number;
  readonly scaleY: number;
  readonly width: number;
  readonly height: number;
};

export type MapOvalPoint = {
  readonly x: number;
  readonly y: number;
};

export type MapOvalSample = {
  readonly ox: number;
  readonly oy: number;
  readonly distance: number;
  readonly angle: number;
};

export function makeMapOvalMetrics(
  mapWidth: number,
  mapHeight: number,
  extentFraction: number = MAP_GENERATION_EXTENT_FRACTION,
): MapOvalMetrics {
  const fraction = Math.max(0.01, Math.min(1, extentFraction));
  const width = Math.max(1, mapWidth * fraction);
  const height = Math.max(1, mapHeight * fraction);
  const minDim = Math.max(1, Math.min(width, height));
  return {
    cx: mapWidth / 2,
    cy: mapHeight / 2,
    minDim,
    scaleX: width / minDim,
    scaleY: height / minDim,
    width,
    height,
  };
}

/** Convert world space into the canonical generated-oval coordinate
 *  system. Circles in this space render/simulate as ellipses in world
 *  space inside MAP_GENERATION_EXTENT_FRACTION of the full map:
 *  square maps have scaleX=scaleY=1, while rectangular maps stretch
 *  radii along their longer generated axis. */
export function sampleMapOvalAt(
  metrics: MapOvalMetrics,
  x: number,
  y: number,
): MapOvalSample {
  const ox = (x - metrics.cx) / metrics.scaleX;
  const oy = (y - metrics.cy) / metrics.scaleY;
  return {
    ox,
    oy,
    distance: Math.sqrt(ox * ox + oy * oy),
    angle: Math.atan2(oy, ox),
  };
}

export function mapOvalPointAt(
  metrics: MapOvalMetrics,
  angle: number,
  radius: number,
): MapOvalPoint {
  return {
    x: metrics.cx + Math.cos(angle) * radius * metrics.scaleX,
    y: metrics.cy + Math.sin(angle) * radius * metrics.scaleY,
  };
}

export function mapOvalAngleAt(
  mapWidth: number,
  mapHeight: number,
  x: number,
  y: number,
): number {
  return sampleMapOvalAt(makeMapOvalMetrics(mapWidth, mapHeight), x, y).angle;
}

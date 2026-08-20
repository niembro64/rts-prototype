// CameraTargetBounds3D — the rectangle the orbit focus is allowed to live in.
//
// The camera used to be railed to the playable map square (plus
// WORLD_PADDING_PERCENT), which predates the map info annex: the headland
// grown out of one map edge that the preset caption and author byline stand
// on (see MapInfoAnnex3D). Rendered land the focus cannot reach reads as a
// bug — you can see the sign but never pan to it — so the rail is the UNION
// of the map square and every out-of-map surface we draw, padded once.
//
// Pure and renderer-free: RtsScene3D feeds it map dimensions and hands the
// result to OrbitCamera.setTargetBounds, and the contract test resolves the
// same rectangle from the same numbers.

import { WORLD_PADDING_PERCENT } from '../../config';
import { resolveMapInfoAnnexFootprint } from './MapInfoAnnex3D';

type CameraTargetBounds = {
  readonly minX: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxZ: number;
};

/** The padded rail for the orbit focus: the map square unioned with the info
 *  annex's footprint, then grown by the configured world padding (a fraction
 *  of the MAP's own dimensions, so padding stays the same on every edge no
 *  matter which one the annex hangs off). */
export function resolveCameraTargetBounds(
  mapWidth: number,
  mapHeight: number,
): CameraTargetBounds {
  const annex = resolveMapInfoAnnexFootprint(mapWidth, mapHeight);
  const paddingX = mapWidth * WORLD_PADDING_PERCENT;
  const paddingZ = mapHeight * WORLD_PADDING_PERCENT;
  return {
    minX: Math.min(0, annex.minX) - paddingX,
    minZ: Math.min(0, annex.minZ) - paddingZ,
    maxX: Math.max(mapWidth, annex.maxX) + paddingX,
    maxZ: Math.max(mapHeight, annex.maxZ) + paddingZ,
  };
}

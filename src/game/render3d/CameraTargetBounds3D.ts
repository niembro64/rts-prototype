// CameraTargetBounds3D — the rectangle the orbit focus is allowed to live in.
//
// The camera used to be railed to the playable map square (plus
// WORLD_PADDING_PERCENT), which predates the map info annex: the headland
// grown out of one map edge that the preset caption and author byline stand
// on (see MapInfoAnnex3D). Rendered land the focus cannot reach reads as a
// bug — you can see the sign but never pan to it — so the rail is the UNION
// of the map square and every out-of-map surface we draw.
//
// That union alone gave one edge a deep extension and the other three
// nothing, because WORLD_PADDING_PERCENT is authored at zero: the focus could
// stand a fifth of the map past the north coast and not one unit past the
// south one. So the union is then grown by a BUFFER on every side — half the
// annex's depth, which is a size the map already chose for itself rather than
// a second number to keep in sync with the first. The authored world padding
// still wins where it is larger, so setting it remains a way to open the rail
// up further.
//
// The buffer is deliberately smaller than the annex: it is standoff, not
// reach. Its job is that the coast can be centred on screen and orbited
// around instead of only ever being viewed from inside the map, and it is the
// same on all four sides so the camera does not feel different at each one.
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

/** Half the annex's depth: the standoff buffer every map edge gets. Exported
 *  so the contract test asserts the rail against the same derivation rather
 *  than against a copy of the fraction. */
export function resolveCameraTargetBufferDepth(
  mapWidth: number,
  mapHeight: number,
): number {
  return resolveMapInfoAnnexFootprint(mapWidth, mapHeight).depth / 2;
}

/** The padded rail for the orbit focus: the map square unioned with the info
 *  annex's footprint, then grown on every side by the standoff buffer (or by
 *  the authored world padding, whichever is larger). Both terms are measured
 *  against the MAP's own dimensions, so the rail stays the same shape on
 *  whichever edge the annex hangs off. */
export function resolveCameraTargetBounds(
  mapWidth: number,
  mapHeight: number,
): CameraTargetBounds {
  const annex = resolveMapInfoAnnexFootprint(mapWidth, mapHeight);
  const buffer = resolveCameraTargetBufferDepth(mapWidth, mapHeight);
  const paddingX = Math.max(buffer, mapWidth * WORLD_PADDING_PERCENT);
  const paddingZ = Math.max(buffer, mapHeight * WORLD_PADDING_PERCENT);
  return {
    minX: Math.min(0, annex.minX) - paddingX,
    minZ: Math.min(0, annex.minZ) - paddingZ,
    maxX: Math.max(mapWidth, annex.maxX) + paddingX,
    maxZ: Math.max(mapHeight, annex.maxZ) + paddingZ,
  };
}

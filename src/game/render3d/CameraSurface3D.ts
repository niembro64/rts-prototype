// CameraSurface3D — the ONE height field the camera is allowed to ask about.
//
// The camera has three separate reasons to want a ground height: the focus
// altitude band (OrbitCamera.clampFocusAltitude), eye clearance
// (terrainClearanceRaise), and the screen-ray solvers that place zoom anchors
// (CursorGround). Until this module they asked three different questions and
// got three different answers outside the playable square:
//
//   getTerrainMeshHeight   CLAMPS x/z into the map rectangle, so every point
//                          off the map reported the height of the nearest map
//                          edge — an infinite phantom plateau at the coast's
//                          altitude, over ground that is drawn as open air.
//   CursorGround's zoom    returned NaN off the map, i.e. "nothing here".
//     sample solver
//   the rendered mesh      knows about the info annex, which IS drawn out
//                          there and IS a real surface.
//
// That was survivable while the camera focus was railed to the map square. It
// stopped being survivable when the rail grew onto the annex: the phantom
// plateau floors the focus above the surface actually under it, and a focus
// floating above the ground is exactly what makes a cursor-pinned zoom-out
// walk its own altitude upward (the focus/anchor height gap is multiplied by
// the zoom factor every notch) until the screen-centre ray's ground hit is so
// far away that the zoom travel budget throttles the gesture to nothing.
//
// So there is one answer now, and it is the DRAWN surface:
//
//   inside the map square      the terrain mesh's own height
//   on the info annex          the annex's blended surface
//   anywhere else              NaN — there is no ground there
//
// NaN is the point, not a failure mode. Every camera consumer already had to
// handle a non-finite sample ("off-map / before terrain loads"), and each one
// already does the right thing with it: the focus band declines to clamp, the
// clearance lift stays zero, a ray probe reports no hit. Inventing a plateau
// to avoid the NaN is what broke the camera; reporting honestly that the
// camera is out over the void is what fixes it.

import { LAND_TILE_GROUND_LIFT } from '../../config';
import { getTerrainMeshHeight } from '../sim/Terrain';
import {
  mapInfoAnnexFlatHeight,
  mapInfoAnnexHalfWidthAt,
  mapInfoAnnexSurfaceY,
  resolveMapInfoAnnexFootprint,
  type MapInfoAnnexFootprint,
} from './MapInfoAnnex3D';

/** Footprint resolution is pure but not free, and this is called once per
 *  screen-ray probe (seventeen per wheel event) and once per marched step of
 *  the ray-sampling fallback. The map dimensions are fixed for a match, so one
 *  slot keyed by them is all the memo that is needed. */
let cachedFootprintWidth = Number.NaN;
let cachedFootprintHeight = Number.NaN;
let cachedFootprint: MapInfoAnnexFootprint | null = null;

function annexFootprint(
  mapWidth: number,
  mapHeight: number,
): MapInfoAnnexFootprint {
  if (
    cachedFootprint === null ||
    cachedFootprintWidth !== mapWidth ||
    cachedFootprintHeight !== mapHeight
  ) {
    cachedFootprint = resolveMapInfoAnnexFootprint(mapWidth, mapHeight);
    cachedFootprintWidth = mapWidth;
    cachedFootprintHeight = mapHeight;
  }
  return cachedFootprint;
}

/** The map's own drawn surface, without the annex. Same expression the terrain
 *  mesh builds its vertices from, so the camera floors on the ground it can
 *  see rather than on the raw height field the mesh was lifted off. */
function mapSurfaceHeight(
  x: number,
  z: number,
  mapWidth: number,
  mapHeight: number,
): number {
  return getTerrainMeshHeight(x, z, mapWidth, mapHeight) + LAND_TILE_GROUND_LIFT;
}

/** True when (x, z) stands on the annex: past the map edge it grows from, not
 *  past its far rim, and inside the silhouette's half-width at that depth —
 *  the flare and the cut included, so the flanks agree with the triangles. */
export function isOnMapInfoAnnex(
  x: number,
  z: number,
  mapWidth: number,
  mapHeight: number,
): boolean {
  const annex = annexFootprint(mapWidth, mapHeight);
  const out = (x - annex.attachX) * annex.outX + (z - annex.attachZ) * annex.outZ;
  if (out < 0 || out > annex.depth) return false;
  const along =
    (x - annex.attachX) * annex.alongX + (z - annex.attachZ) * annex.alongZ;
  return Math.abs(along) <= mapInfoAnnexHalfWidthAt(annex, out);
}

/**
 * The altitude of the drawn surface under (x, z), or NaN where nothing is
 * drawn. This is the camera's only height field — see the module note.
 *
 * The map square is tested first and answers with no annex work at all, which
 * matters because the ray-march fallback calls this thousands of times for one
 * missed pick.
 */
export function cameraSurfaceHeight(
  x: number,
  z: number,
  mapWidth: number,
  mapHeight: number,
): number {
  if (x >= 0 && x <= mapWidth && z >= 0 && z <= mapHeight) {
    return mapSurfaceHeight(x, z, mapWidth, mapHeight);
  }
  if (!isOnMapInfoAnnex(x, z, mapWidth, mapHeight)) return Number.NaN;
  const annex = annexFootprint(mapWidth, mapHeight);
  const sampleMap = (mapX: number, mapZ: number): number =>
    getTerrainMeshHeight(mapX, mapZ, mapWidth, mapHeight);
  return mapInfoAnnexSurfaceY(
    annex,
    x,
    z,
    mapInfoAnnexFlatHeight(annex, sampleMap),
    sampleMap,
  );
}

import * as THREE from 'three';
import { WORLD_BOX_RENDER_CONFIG } from '../../config';
import {
  mapInfoAnnexHalfWidthAt,
  mapInfoAnnexProfileBreakpoints,
  mapInfoAnnexRowPointX,
  mapInfoAnnexRowPointZ,
  resolveMapInfoAnnexFootprint,
} from './MapInfoAnnex3D';

/**
 * Shared render-only bounds for the visible world slab. Gameplay terrain,
 * water level, and map limits remain authoritative elsewhere; these values
 * only close the presentation geometry when the player looks beneath a map.
 */
export function getWorldBoxFloorY(mapWidth: number, mapHeight: number): number {
  const averageAxisLength = (Math.max(0, mapWidth) + Math.max(0, mapHeight)) * 0.5;
  return -averageAxisLength * WORLD_BOX_RENDER_CONFIG.depthAverageAxisFraction;
}

/** Keep the water footprint's small, authored overhang in one place so its
 * vertical border and surface always share the same extent. */
export function getFloatingWaterOverhang(): number {
  return WORLD_BOX_RENDER_CONFIG.waterExtensionWorldUnits;
}

/** The water curtains drop this far BELOW the world-box floor — the same
 * authored overhang the water extends past every terrain edge, so the land
 * slab reads as sitting inside a slightly larger water box. */
export function getWaterBoxFloorY(mapWidth: number, mapHeight: number): number {
  return getWorldBoxFloorY(mapWidth, mapHeight) - getFloatingWaterOverhang();
}

/** The quads that close the land slab: the map footprint at the world-box
 *  floor, plus the info annex's own silhouette hanging off one edge, wound
 *  and normalled so their FRONT face is the one a camera under the world
 *  sees. Two triangles for the map and one band per kink in the headland's
 *  outline — nothing samples this cap, so it needs no interior vertices
 *  beyond the ones its own shape asks for. Following the outline rather than
 *  the bounding box is what keeps the cut corners cut when you look up at the
 *  underside of the world. */
export function buildWorldBoxFloorGeometry(
  mapWidth: number,
  mapHeight: number,
  floorY: number,
): THREE.BufferGeometry {
  const annex = resolveMapInfoAnnexFootprint(mapWidth, mapHeight);
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  // Corner order (min, min) → (max, min) → (max, max) → (min, max) with a
  // fan index wound so the face normal comes out pointing DOWN, matching the
  // authored one.
  const pushFloorQuad = (
    ax: number, az: number,
    bx: number, bz: number,
    cx: number, cz: number,
    dx: number, dz: number,
  ): void => {
    const base = positions.length / 3;
    positions.push(
      ax, floorY, az,
      bx, floorY, bz,
      cx, floorY, cz,
      dx, floorY, dz,
    );
    for (let corner = 0; corner < 4; corner++) normals.push(0, -1, 0);
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  pushFloorQuad(0, 0, mapWidth, 0, mapWidth, mapHeight, 0, mapHeight);

  const outs = mapInfoAnnexProfileBreakpoints(annex);
  for (let band = 0; band < outs.length - 1; band++) {
    const near = { out: outs[band], halfWidth: mapInfoAnnexHalfWidthAt(annex, outs[band]) };
    const far = {
      out: outs[band + 1],
      halfWidth: mapInfoAnnexHalfWidthAt(annex, outs[band + 1]),
    };
    // +along first, then out. `along` is `out` turned a fixed quarter, so the
    // annex's frame is left-handed against world (+X, +Z) on EVERY edge —
    // which is why this order is the reverse of the map quad's above and
    // still lands the same downward normal.
    pushFloorQuad(
      mapInfoAnnexRowPointX(annex, near, 1), mapInfoAnnexRowPointZ(annex, near, 1),
      mapInfoAnnexRowPointX(annex, near, -1), mapInfoAnnexRowPointZ(annex, near, -1),
      mapInfoAnnexRowPointX(annex, far, -1), mapInfoAnnexRowPointZ(annex, far, -1),
      mapInfoAnnexRowPointX(annex, far, 1), mapInfoAnnexRowPointZ(annex, far, 1),
    );
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  return geometry;
}

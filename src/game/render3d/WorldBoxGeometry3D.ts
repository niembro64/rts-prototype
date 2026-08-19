import * as THREE from 'three';
import { WORLD_BOX_RENDER_CONFIG } from '../../config';

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

/** The quad that closes the land slab: the map footprint at the world-box
 *  floor, wound and normalled so its FRONT face is the one a camera under the
 *  world sees. Deliberately two triangles and no more — nothing samples it,
 *  so it needs no interior vertices to interpolate anything across. */
export function buildWorldBoxFloorGeometry(
  mapWidth: number,
  mapHeight: number,
  floorY: number,
): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([
    0, floorY, 0,
    mapWidth, floorY, 0,
    mapWidth, floorY, mapHeight,
    0, floorY, mapHeight,
  ], 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute([
    0, -1, 0,
    0, -1, 0,
    0, -1, 0,
    0, -1, 0,
  ], 3));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  geometry.computeBoundingSphere();
  return geometry;
}

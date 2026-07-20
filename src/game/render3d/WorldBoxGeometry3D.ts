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

// Battle-scoped world-material state (BATTLE bar WORLD group).
//
// The authoritative copy lives on WorldState (and is in the canonical state
// hash). This module mirrors it as module-scoped battle state — the same shape
// terrainState.ts uses for the terrain magnitudes — because the 3D renderers
// are constructed with a THREE.Group, not the sim world, and still have to
// know whether the ground is metal and whether the liquid is lava.
//
// Set from the battle-construction paths (RtsScene3D / LobbyManager /
// ServerBootstrap) alongside the terrain runtime config.

import {
  DEFAULT_LIQUID_SURFACE_MODE,
  DEFAULT_TERRAIN_SURFACE_MODE,
  isLiquidSurfaceMode,
  isTerrainSurfaceMode,
  type LiquidSurfaceMode,
  type TerrainSurfaceMode,
} from '../../types/worldSurfaceMode';

let terrainSurfaceMode: TerrainSurfaceMode = DEFAULT_TERRAIN_SURFACE_MODE;
let liquidSurfaceMode: LiquidSurfaceMode = DEFAULT_LIQUID_SURFACE_MODE;

export function getTerrainSurfaceMode(): TerrainSurfaceMode {
  return terrainSurfaceMode;
}

export function getLiquidSurfaceMode(): LiquidSurfaceMode {
  return liquidSurfaceMode;
}

/** True when the whole map is metal ore: no discrete deposit crowns are built,
 *  every build-grid cell counts as a metal cell, and the ground shades as
 *  polished metal. Terrain geometry is unaffected — deposit placement still
 *  shaped the land. */
export function isMetalTerrainSurface(): boolean {
  return terrainSurfaceMode === 'metal';
}

/** True when the map's liquid is lava: opaque, self-lit, and lethal to touch. */
export function isLavaLiquidSurface(): boolean {
  return liquidSurfaceMode === 'lava';
}

/** Returns true when the value changed, so callers can rebuild what depends
 *  on it (the terrain mesh bakes the horizon liquid colour per vertex). */
export function setTerrainSurfaceMode(mode: TerrainSurfaceMode): boolean {
  if (!isTerrainSurfaceMode(mode) || mode === terrainSurfaceMode) return false;
  terrainSurfaceMode = mode;
  return true;
}

export function setLiquidSurfaceMode(mode: LiquidSurfaceMode): boolean {
  if (!isLiquidSurfaceMode(mode) || mode === liquidSurfaceMode) return false;
  liquidSurfaceMode = mode;
  return true;
}

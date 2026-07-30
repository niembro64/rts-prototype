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
import { WATER_LEVEL } from './terrain/terrainConfig';

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

/** Whether anything grows on the current world. Vegetation belongs to the
 *  authored world and nothing else: a map made of metal has no soil, and a
 *  world whose sea is molten rock is no place for anything to grow — not even
 *  inland, well away from the lava. So the authored NORMAL + WATER world is the
 *  only one that grows trees, grass, and seaweed; every other WORLD combination
 *  is barren. Kind-agnostic, so a new vegetation kind inherits the rule for
 *  free. */
export function vegetationSupported(): boolean {
  return !isMetalTerrainSurface() && !isLavaLiquidSurface();
}

/** Whether a deposit at this pad height can be worked. A deposit below the
 *  liquid surface is unworkable once that liquid is molten rock: no crown is
 *  drawn and its cells pay no metal. The deposit is still GENERATED either
 *  way, because it already shaped the terrain and that shaping must not
 *  change with the liquid. */
export function metalDepositWorkableAtHeight(height: number): boolean {
  return !(isLavaLiquidSurface() && height <= WATER_LEVEL);
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

// Battle-scoped world-material state (BATTLE bar WORLD group).
//
// The authoritative copy lives on WorldState (and is in the canonical state
// hash). This module mirrors it as module-scoped battle state — the same shape
// terrainState.ts uses for the terrain magnitudes — because the 3D renderers
// are constructed with a THREE.Group, not the sim world, and still have to
// know whether the ground is metal and whether the liquid is water, lava, or
// absent.
//
// Set from the battle-construction paths (RtsScene3D / LobbyManager /
// ServerBootstrap) alongside the terrain runtime config.

import {
  DEFAULT_LIQUID_SURFACE_MODE,
  DEFAULT_METAL_COVERAGE,
  isLiquidSurfaceMode,
  isMetalCoverage,
  metalCoverageIsWholeMap,
  type LiquidSurfaceMode,
  type MetalCoverage,
} from '../../types/worldSurfaceMode';
import { getSimWasm } from '../sim-wasm/init';
import { WATER_LEVEL } from './terrain/terrainConfig';

let metalCoverage: MetalCoverage = DEFAULT_METAL_COVERAGE;
let liquidSurfaceMode: LiquidSurfaceMode = DEFAULT_LIQUID_SURFACE_MODE;

export function getMetalCoverage(): MetalCoverage {
  return metalCoverage;
}

export function getLiquidSurfaceMode(): LiquidSurfaceMode {
  return liquidSurfaceMode;
}

/** Whether the authored liquid plane is physically present. WATER and LAVA
 *  share the same plane; NONE exposes the terrain bed as ordinary ground. */
export function liquidSurfaceExists(): boolean {
  return liquidSurfaceMode !== 'none';
}

/** Runtime medium boundary. Terrain generation still uses WATER_LEVEL as its
 *  authored datum, but NONE puts the effective plane below every finite body
 *  and terrain height without reshaping the map. */
export function getLiquidSurfaceLevel(): number {
  return liquidSurfaceExists() ? WATER_LEVEL : Number.NEGATIVE_INFINITY;
}

/** True when the whole map is metal ore: no discrete deposit crowns are built,
 *  every build-grid cell counts as a metal cell, and the ground shades as
 *  polished metal. Terrain geometry is unaffected — deposit placement still
 *  shaped the land. */
export function isMetalTerrainSurface(): boolean {
  return metalCoverageIsWholeMap(metalCoverage);
}

/** True when the map's liquid is lava: opaque, self-lit, and lethal to touch. */
export function isLavaLiquidSurface(): boolean {
  return liquidSurfaceMode === 'lava';
}

/** Whether anything grows on the current world. Vegetation belongs to the
 *  authored world and nothing else: a map made of metal has no soil, and a
 *  world whose sea is molten rock is no place for anything to grow — not even
 *  inland, well away from the lava. A drained NONE world remains fertile; the
 *  placement kernel classifies its exposed basins as land and emits no
 *  seaweed. ALL metal or LAVA leaves the world barren. */
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
export function setMetalCoverage(mode: MetalCoverage): boolean {
  if (!isMetalCoverage(mode) || mode === metalCoverage) return false;
  metalCoverage = mode;
  return true;
}

export function setLiquidSurfaceMode(mode: LiquidSurfaceMode): boolean {
  if (!isLiquidSurfaceMode(mode)) return false;
  // The WASM module defaults to WATER for cold boot, but every bootstrap calls
  // this after initialization too. Synchronize even when the TS value already
  // matches so a persisted NONE selection cannot leave the kernels wet.
  getSimWasm()?.liquidSurfaceSetEnabled(mode !== 'none');
  if (mode === liquidSurfaceMode) return false;
  liquidSurfaceMode = mode;
  return true;
}

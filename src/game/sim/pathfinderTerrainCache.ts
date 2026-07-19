import { getSimWasm } from '../sim-wasm/init';
import { getTerrainVersion } from './Terrain';

let initializedMapWidth = 0;
let initializedMapHeight = 0;
let initializedSim: ReturnType<typeof getSimWasm> | null = null;

function ensureInitialized(mapWidth: number, mapHeight: number): void {
  const sim = getSimWasm()!;
  if (sim !== initializedSim) {
    initializedSim = sim;
    initializedMapWidth = 0;
    initializedMapHeight = 0;
  }
  if (mapWidth === initializedMapWidth && mapHeight === initializedMapHeight) return;

  sim.pathfinder.init(mapWidth, mapHeight);
  initializedMapWidth = mapWidth;
  initializedMapHeight = mapHeight;
}

/** Ensure the WASM locomotion grid matches only the authoritative terrain.
 * Build-grid occupancy is a construction reservation and never participates
 * in route planning or route-cache invalidation. */
export function ensurePathfinderTerrain(mapWidth: number, mapHeight: number): void {
  ensureInitialized(mapWidth, mapHeight);
  // The Rust key is the source of truth and makes this an O(1) no-op when
  // terrain is unchanged. Reassert it every time because diagnostics/tests
  // can reinitialize the shared WASM pathfinder without this JS module seeing
  // that mutation. Construction state remains completely absent.
  getSimWasm()!.pathfinder.rebuildTerrainMaskAndCc(getTerrainVersion());
}

import { getSimWasm } from '../sim-wasm/init';
import { getTerrainVersion } from './Terrain';

let initializedMapWidth = 0;
let initializedMapHeight = 0;
let initializedSim: ReturnType<typeof getSimWasm> | null = null;

/** Provider of the current simulation's grounded building footprint cells.
 * Registered by the owning Simulation; the pathfinder cache pulls from it
 * whenever the installed occupancy version differs. Hovering structures must
 * never be reported — they have no pathfinding surface. */
type PathfinderBuildingOccupancySource = {
  getVersion(): number;
  forEachBlockedCell(visit: (gx: number, gy: number) => void): void;
};

let occupancySource: PathfinderBuildingOccupancySource | null = null;
let syncedSource: PathfinderBuildingOccupancySource | null = null;
let cellGxScratch = new Int32Array(256);
let cellGyScratch = new Int32Array(256);

export function registerPathfinderBuildingOccupancy(
  source: PathfinderBuildingOccupancySource | null,
): () => void {
  const previousSource = occupancySource;
  occupancySource = source;
  syncedSource = null;
  return () => {
    occupancySource = previousSource;
    // The installed WASM layer still belongs to the temporary source. Force
    // the restored owner to reassert its cells on the next path query.
    syncedSource = null;
  };
}

/** The registered occupancy source's live version, so downstream bakes that
 *  fold building cells into their masks (the traversability overlay grids)
 *  can key their caches on it instead of silently keeping pre-placement —
 *  or a previous match's — buildings forever. */
export function getRegisteredBuildingOccupancyVersion(): number {
  return occupancySource?.getVersion() ?? 0;
}

function ensureInitialized(mapWidth: number, mapHeight: number): void {
  const sim = getSimWasm()!;
  if (sim !== initializedSim) {
    initializedSim = sim;
    initializedMapWidth = 0;
    initializedMapHeight = 0;
    syncedSource = null;
  }
  if (mapWidth === initializedMapWidth && mapHeight === initializedMapHeight) return;
  // The locomotion grid is always the 20 wu build grid: the fine grid is the
  // single legality truth, and the hierarchy is what keeps long routes cheap.
  sim.pathfinder.init(mapWidth, mapHeight);
  initializedMapWidth = mapWidth;
  initializedMapHeight = mapHeight;
}

function syncBuildingOccupancy(): void {
  const source = occupancySource;
  if (source === null) return;
  const sim = getSimWasm()!;
  const version = source.getVersion();
  // Version match on the same source = layer already installed. A source
  // swap (battle change) forces one resync even on version collision.
  if (syncedSource === source && sim.pathfinder.buildingOccupancyVersion() === version) return;
  let count = 0;
  source.forEachBlockedCell((gx, gy) => {
    if (count >= cellGxScratch.length) {
      const grown = cellGxScratch.length * 2;
      const nextGx = new Int32Array(grown);
      const nextGy = new Int32Array(grown);
      nextGx.set(cellGxScratch);
      nextGy.set(cellGyScratch);
      cellGxScratch = nextGx;
      cellGyScratch = nextGy;
    }
    cellGxScratch[count] = gx;
    cellGyScratch[count] = gy;
    count++;
  });
  sim.pathfinder.syncBuildingOccupancy(
    cellGxScratch.subarray(0, count),
    cellGyScratch.subarray(0, count),
    version,
  );
  syncedSource = source;
}

/** Ensure the WASM locomotion grid matches the authoritative terrain plus
 * the registered building occupancy layer. Terrain is the base surface;
 * grounded building footprints are a dynamic obstacle layer synced on top
 * whenever the BuildingGrid version moves (or after a terrain rebuild,
 * which resets the installed layer). */
export function ensurePathfinderTerrain(mapWidth: number, mapHeight: number): void {
  ensureInitialized(mapWidth, mapHeight);
  // The Rust key is the source of truth and makes this an O(1) no-op when
  // terrain is unchanged. Reassert it every time because diagnostics/tests
  // can reinitialize the shared WASM pathfinder without this JS module seeing
  // that mutation.
  getSimWasm()!.pathfinder.rebuildTerrainMaskAndCc(getTerrainVersion());
  syncBuildingOccupancy();
}

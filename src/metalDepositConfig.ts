// Metal deposit map layout.
//
// Deposits are placed deterministically on a set of concentric rings.
// Each ring carries a per-player count: a player's radial slice
// (2π/playerCount wide, centered on their spawn angle from
// `getPlayerBaseAngle`) gets `countPerPlayer` deposits evenly spread
// across it. So a 6-player map with `countPerPlayer: 2` yields 12
// deposits in that ring; the same ring on a 4-player map yields 8.
//
// Rings can be phase-shifted independently with `sliceOffset`, expressed
// as a fraction of one player's slice width (= 2π / playerCount). The
// shift therefore SCALES with the number of map divisions: 0.25 = a
// quarter-slice (24° at 3 players, 18° at 5), 1.0 = one full slice (the
// next player's spoke), 0.5 = half a slice. Keeps rings from lining up
// on the same radial spokes without baking a player-count-specific
// radian value into config.
//
// Each deposit owns an irregular connected logical resource footprint
// on the fine build grid. The authored `resourceCells` value remains
// the nominal side length used to derive the target cell count
// (`resourceCells²`), while the generated footprint grows out from
// one origin build cell within a circular candidate radius. Terrain
// flattening still reads a separate flat-pad config.
//
// Each ring also carries `dTerrainLevels`. When set to an integer it
// is a signed count of METAL_DEPOSIT_STEP units above/below world
// height 0, used as-authored — the CENTER bar's sign does NOT flip
// it. When set to `null` the pad sits at whatever height the natural
// (post-plateau, post-boundary) heightmap happens to be at the
// deposit's xy — only the vertical origin differs from the integer
// case. Around each pad the terrain blends smoothly from the derived
// height back to natural over the ring's `terrainBlendRadius`.
//
// Special case — `radiusFraction: 0` is the map center: a single
// deposit is placed at (cx, cy) regardless of countPerPlayer / playerCount.

import { getPlayerBaseAngle } from './game/sim/playerLayout';
import { makeMapOvalMetrics, mapOvalPointAt } from './game/sim/mapOval';
import {
  createTerrainHeightSampler,
  METAL_DEPOSIT_STEP,
  setMetalDepositFlatZones,
  type TerrainFlatZone,
} from './game/sim/Terrain';
import { BUILD_GRID_CELL_SIZE, snapBuildingToGrid } from './game/sim/buildGrid';
import rawConfig from './metalDepositConfig.json';

export type DepositRing = {
  /** Distance from map center as a fraction of the oval-space
   *  (mapMinExtent/2 - margin). 0 = center (single deposit),
   *  1 = at the spawn oval edge. */
  radiusFraction: number;
  /** How many deposits each player's radial slice gets on this ring.
   *  Total deposits per ring = countPerPlayer × playerCount (with the
   *  center ring as a special case — always 1 regardless). */
  countPerPlayer: number;
  /** Angular phase offset as a fraction of one player's slice width
   *  (= 2π / playerCount). 0.5 shifts the ring's deposits by half a
   *  slice, 1.0 by a full slice (i.e. into the neighboring player's
   *  spoke). Scales automatically with player count: 0.25 means 30° at
   *  3 players, 18° at 5. Negative values rotate the other way. */
  sliceOffset?: number;
  /** Signed count of METAL_DEPOSIT_STEP units above/below world height
   *  0, used as-authored regardless of the CENTER bar sign. Pass
   *  `null` to anchor the pad at the natural terrain height under the
   *  deposit's xy instead. */
  dTerrainLevels: number | null;
  /** Circular terrain-flattening diameter in fine building cells; can be
   *  larger than the resource footprint to give the extractor a clean
   *  buildable pad without increasing production area. */
  flatPadCells: number;
  /** World-unit width outside the circular flat pad where terrain eases
   *  back to the natural heightmap. Larger values make the deposit pad
   *  integrate more gradually with surrounding terrain. */
  terrainBlendRadius: number;
  /** Optional free-form note for the author — purely descriptive, not
   *  read by any runtime code. Useful for labeling where a ring sits
   *  ("inner near spawn", "back side cluster", etc.). */
  comment?: string;
};

/** Authored layout config for the metal deposit ring placer. Pure data
 *  lives in metalDepositConfig.json so both TypeScript and Rust/WASM
 *  can load the same source of truth. Field meanings:
 *    - `edgeMarginPx`: oval-space world units between the spawn oval
 *      and the outermost deposit ring (keeps deposits from clipping
 *      into commander spawns).
 *    - `coinHeight`: full visual coin thickness in world units; the
 *      renderer draws the upper half above the terrain and treats the
 *      equator as the ground contact edge. Purely cosmetic.
 *    - `resourceCells`: nominal footprint side in fine building cells.
 *      The generated deposit gets `resourceCells²` connected metal cells
 *      grown from the center cell inside a circular candidate radius.
 *    - `resourceRadiusCells`: candidate-circle radius in fine building
 *      cells for the irregular footprint grow pass.
 *    - `rings`: concentric deposit rings; order doesn't matter — the
 *      renderer and placement validator iterate over all of them. Each
 *      ring carries its own `flatPadCells` and `terrainBlendRadius`. */
export const METAL_DEPOSIT_CONFIG = {
  edgeMarginPx: rawConfig.edgeMarginPx,
  coinHeight: rawConfig.coinHeight,
  resourceCells: rawConfig.resourceCells,
  resourceRadiusCells: rawConfig.resourceRadiusCells,
  rings: rawConfig.rings as DepositRing[],
};

export type MetalDepositResourceCell = {
  gx: number;
  gy: number;
  x: number;
  y: number;
};

export type MetalDeposit = {
  /** Stable index — same number across all clients/peers in a session. */
  id: number;
  /** World-space center of the origin resource cell and flat terrain pad. */
  x: number;
  y: number;
  /** Top-left build cell of the nominal legacy square centered on the origin. */
  gridX: number;
  gridY: number;
  /** Origin build cell from which the connected footprint is grown. */
  originGx: number;
  originGy: number;
  /** Nominal legacy side length. The generated target count is this squared. */
  resourceCells: number;
  /** Actual connected metal-producing build cells. */
  cells: MetalDepositResourceCell[];
  /** Actual count of metal-producing build cells. */
  resourceCellCount: number;
  /** Candidate-circle radius, measured from the origin cell in build cells. */
  resourceRadiusCells: number;
  /** Tight build-grid bounds around `cells`. */
  boundsGridX: number;
  boundsGridY: number;
  boundsGridW: number;
  boundsGridH: number;
  /** Legacy nominal half-size in world units. */
  resourceHalfSize: number;
  /** Radius enclosing the generated cell footprint in world units. */
  resourceRadius: number;
  /** Radius of the circular flat terrain pad in world units. */
  flatPadRadius: number;
  /** Signed count of METAL_DEPOSIT_STEP units, taken directly from
   *  the authored ring config. `null` means the pad rides the natural
   *  terrain height under the deposit's xy (see `height`). */
  dTerrainLevels: number | null;
  /** Signed z elevation (sim units) of this deposit's flat pad. */
  height: number;
  /** World-unit blend width outside the circular flat pad before natural
   *  terrain fully takes over. */
  blendRadius: number;
};

type MetalDepositPlacement = Pick<
  MetalDeposit,
  | 'x'
  | 'y'
  | 'gridX'
  | 'gridY'
  | 'originGx'
  | 'originGy'
  | 'resourceCells'
  | 'cells'
  | 'resourceCellCount'
  | 'resourceRadiusCells'
  | 'boundsGridX'
  | 'boundsGridY'
  | 'boundsGridW'
  | 'boundsGridH'
  | 'resourceHalfSize'
  | 'resourceRadius'
  | 'flatPadRadius'
>;

type PendingPlacement = {
  placement: MetalDepositPlacement;
  dTerrainLevels: number | null;
  blendRadius: number;
};

/**
 * Compute the deterministic deposit list for a map of given size and
 * player count, and install the resulting flat zones into the terrain
 * state. Same `(mapWidth, mapHeight, playerCount)` always produces the
 * same deposits in the same order — fine to call independently on
 * host and clients without networking the list.
 *
 * SIDE EFFECT: calls `setMetalDepositFlatZones` twice — first with
 * the explicit-height pads, then with the full list once `null`
 * rings have resolved their height from the post-blend terrain. The
 * caller does NOT need to install zones separately.
 *
 * Two passes are required so that a `dTerrainLevels: null` ring rides
 * the terrain ALREADY SHAPED by every explicit-height pad nearby
 * (including their blend rings). Without the intermediate install,
 * a null pad anchored to raw natural terrain near a tall mountain
 * commander pad would sit far below it and create a cliff at the
 * blend overlap.
 */
export function generateMetalDeposits(
  mapWidth: number,
  mapHeight: number,
  playerCount: number,
): MetalDeposit[] {
  const ovalMetrics = makeMapOvalMetrics(mapWidth, mapHeight);
  const halfExtent = ovalMetrics.minDim / 2 - METAL_DEPOSIT_CONFIG.edgeMarginPx;
  const cx = ovalMetrics.cx;
  const cy = ovalMetrics.cy;
  const players = Math.max(1, playerCount);
  const sliceWidth = (2 * Math.PI) / players;

  // Pass 1: lay out every deposit's xy + per-ring metadata. No
  // heights yet — those depend on whether the ring is explicit-height
  // (immediate) or null (sampled after explicit pads are installed).
  const placements: PendingPlacement[] = [];
  for (const ring of METAL_DEPOSIT_CONFIG.rings) {
    const ringRadius = ring.radiusFraction * halfExtent;
    const flatPadCells = validMetalDepositFlatPadCells(ring.flatPadCells);
    const blendRadius = validMetalDepositTerrainBlendRadius(
      ring.terrainBlendRadius,
    );
    const dTerrainLevels = validMetalDepositDTerrainLevels(ring.dTerrainLevels);
    // Slice-fraction offset: scaled by the player's slice width so the
    // configured value means the same thing (a fraction of one slice)
    // regardless of how many players are dividing the map.
    const ringAngularOffset = (ring.sliceOffset ?? 0) * sliceWidth;
    const pushPlacement = (rawX: number, rawY: number): void => {
      placements.push({
        placement: makeMetalDepositPlacement(rawX, rawY, flatPadCells, placements.length),
        dTerrainLevels,
        blendRadius,
      });
    };

    // Center: one deposit, regardless of countPerPlayer.
    if (ring.radiusFraction <= 1e-6) {
      pushPlacement(cx, cy);
      continue;
    }

    for (let p = 0; p < players; p++) {
      const sliceCenter = getPlayerBaseAngle(p, players);
      for (let j = 0; j < ring.countPerPlayer; j++) {
        // Sub-slice midpoints: countPerPlayer=1 → t=0.5 → angle=sliceCenter;
        // countPerPlayer=2 → t=0.25, 0.75 → angles at ±sliceWidth/4 around centre.
        const t = (j + 0.5) / ring.countPerPlayer;
        const angleInSlice = -sliceWidth / 2 + t * sliceWidth;
        const angle = sliceCenter + angleInSlice + ringAngularOffset;
        const point = mapOvalPointAt(ovalMetrics, angle, ringRadius);
        pushPlacement(point.x, point.y);
      }
    }
  }

  // Pass 2: heights for explicit-dTerrain rings, and install those
  // pads so the null-ring sampler in pass 3 sees the terrain already
  // shaped by them (including blend bands).
  const heights = new Array<number>(placements.length);
  const explicitZones: TerrainFlatZone[] = [];
  for (let i = 0; i < placements.length; i++) {
    const p = placements[i];
    if (p.dTerrainLevels === null) continue;
    const height = p.dTerrainLevels * METAL_DEPOSIT_STEP;
    heights[i] = height;
    explicitZones.push({
      x: p.placement.x,
      y: p.placement.y,
      radius: p.placement.flatPadRadius,
      height,
      blendRadius: p.blendRadius,
    });
  }
  setMetalDepositFlatZones(explicitZones, false);

  // Pass 3: resolve every null-dTerrain pad against the post-blend
  // terrain. `includeDeposits=true` makes getTerrainHeight fold the
  // explicit zones we just installed into the sampled height, so a
  // null pad next to a tall commander mountain rides up onto its
  // blend skirt instead of sitting at raw natural terrain underneath.
  // Null pads do NOT see each other (order-dependent feedback);
  // they'll smooth into each other when the full set is installed in
  // pass 4.
  const postExplicitTerrainHeight = createTerrainHeightSampler(mapWidth, mapHeight);
  for (let i = 0; i < placements.length; i++) {
    const p = placements[i];
    if (p.dTerrainLevels !== null) continue;
    heights[i] = postExplicitTerrainHeight(p.placement.x, p.placement.y);
  }

  // Pass 4: emit the final deposit list and install the full flat-zone
  // set (including resolved nulls).
  const deposits: MetalDeposit[] = [];
  const allZones: TerrainFlatZone[] = [];
  for (let i = 0; i < placements.length; i++) {
    const p = placements[i];
    const height = heights[i];
    deposits.push({
      id: i,
      ...p.placement,
      dTerrainLevels: p.dTerrainLevels,
      height,
      blendRadius: p.blendRadius,
    });
    allZones.push({
      x: p.placement.x,
      y: p.placement.y,
      radius: p.placement.flatPadRadius,
      height,
      blendRadius: p.blendRadius,
    });
  }
  setMetalDepositFlatZones(allZones);

  return deposits;
}

function makeMetalDepositPlacement(
  rawX: number,
  rawY: number,
  flatPadCells: number,
  seedIndex: number,
): MetalDepositPlacement {
  const resourceCells = METAL_DEPOSIT_CONFIG.resourceCells;
  const resourceCellCount = resourceCells * resourceCells;
  const resourceRadiusCells = getMetalDepositResourceRadiusCells(resourceCells);
  const resourceHalfSize = (resourceCells * BUILD_GRID_CELL_SIZE) / 2;
  const resourceRadius = (resourceRadiusCells + 0.5) * BUILD_GRID_CELL_SIZE;
  const flatPadRadius = (flatPadCells * BUILD_GRID_CELL_SIZE) / 2;
  if (flatPadRadius < resourceRadius) {
    throw new Error(
      `Metal deposit ring flatPadCells (${flatPadCells}) must produce a circular radius >= the generated resource footprint radius (${resourceRadius.toFixed(2)} world units)`,
    );
  }
  const snapped = snapBuildingToGrid(rawX, rawY, resourceCells, resourceCells);
  const originGx = Math.floor(snapped.x / BUILD_GRID_CELL_SIZE);
  const originGy = Math.floor(snapped.y / BUILD_GRID_CELL_SIZE);
  const cells = growMetalDepositResourceCells(
    originGx,
    originGy,
    resourceCellCount,
    resourceRadiusCells,
    hashMetalDepositSeed(originGx, originGy, seedIndex),
  );
  const bounds = getMetalDepositCellBounds(cells);
  return {
    x: snapped.x,
    y: snapped.y,
    gridX: snapped.gridX,
    gridY: snapped.gridY,
    originGx,
    originGy,
    resourceCells,
    cells,
    resourceCellCount: cells.length,
    resourceRadiusCells,
    boundsGridX: bounds.gridX,
    boundsGridY: bounds.gridY,
    boundsGridW: bounds.gridW,
    boundsGridH: bounds.gridH,
    resourceHalfSize,
    resourceRadius,
    flatPadRadius,
  };
}

function getMetalDepositResourceRadiusCells(resourceCells: number): number {
  const targetCellCount = resourceCells * resourceCells;
  const configured = METAL_DEPOSIT_CONFIG.resourceRadiusCells;
  const radius = configured ?? Math.max(1, Math.ceil(resourceCells * 0.75));
  if (!Number.isFinite(radius) || !Number.isInteger(radius) || radius <= 0) {
    throw new Error(
      `Metal deposit resourceRadiusCells must be a positive integer; received ${radius}`,
    );
  }
  const candidateCount = countGridCellsInRadius(radius);
  if (candidateCount < targetCellCount) {
    throw new Error(
      `Metal deposit resource radius (${radius}) cannot fit ${targetCellCount} cells`,
    );
  }
  return radius;
}

function countGridCellsInRadius(radiusCells: number): number {
  return getMetalDepositResourceCandidateLayout(radiusCells).count;
}

function cellCenter(gx: number, gy: number): MetalDepositResourceCell {
  return {
    gx,
    gy,
    x: gx * BUILD_GRID_CELL_SIZE + BUILD_GRID_CELL_SIZE / 2,
    y: gy * BUILD_GRID_CELL_SIZE + BUILD_GRID_CELL_SIZE / 2,
  };
}

type MetalDepositResourceCandidateLayout = {
  count: number;
  dx: Int32Array;
  dy: Int32Array;
  centerBias: Float64Array;
  neighborIndices: Int32Array;
  originIndex: number;
};

const METAL_DEPOSIT_RESOURCE_NEIGHBOR_COUNT = 4;
const metalDepositResourceCandidateLayoutCache = new Map<
  number,
  MetalDepositResourceCandidateLayout
>();

function getMetalDepositResourceCandidateLayout(
  radiusCells: number,
): MetalDepositResourceCandidateLayout {
  const cached = metalDepositResourceCandidateLayoutCache.get(radiusCells);
  if (cached !== undefined) return cached;

  const diameter = radiusCells * 2 + 1;
  const offsetToIndex = new Int32Array(diameter * diameter);
  offsetToIndex.fill(-1);

  const dxValues: number[] = [];
  const dyValues: number[] = [];
  const centerBiasValues: number[] = [];
  const r2 = radiusCells * radiusCells;
  const radiusScale = Math.max(1, radiusCells);
  let originIndex = -1;

  for (let dy = -radiusCells; dy <= radiusCells; dy++) {
    for (let dx = -radiusCells; dx <= radiusCells; dx++) {
      const distanceSquared = dx * dx + dy * dy;
      if (distanceSquared > r2) continue;
      const index = dxValues.length;
      offsetToIndex[(dy + radiusCells) * diameter + dx + radiusCells] = index;
      dxValues.push(dx);
      dyValues.push(dy);
      centerBiasValues.push(1 - Math.min(1, Math.sqrt(distanceSquared) / radiusScale));
      if (dx === 0 && dy === 0) originIndex = index;
    }
  }

  const count = dxValues.length;
  const neighborIndices = new Int32Array(count * METAL_DEPOSIT_RESOURCE_NEIGHBOR_COUNT);
  neighborIndices.fill(-1);
  const lookupOffset = (dx: number, dy: number): number => {
    if (
      dx < -radiusCells ||
      dx > radiusCells ||
      dy < -radiusCells ||
      dy > radiusCells
    ) {
      return -1;
    }
    return offsetToIndex[(dy + radiusCells) * diameter + dx + radiusCells];
  };

  for (let i = 0; i < count; i++) {
    const dx = dxValues[i];
    const dy = dyValues[i];
    const base = i * METAL_DEPOSIT_RESOURCE_NEIGHBOR_COUNT;
    neighborIndices[base] = lookupOffset(dx + 1, dy);
    neighborIndices[base + 1] = lookupOffset(dx - 1, dy);
    neighborIndices[base + 2] = lookupOffset(dx, dy + 1);
    neighborIndices[base + 3] = lookupOffset(dx, dy - 1);
  }

  if (originIndex < 0) {
    throw new Error(
      `Metal deposit resource radius (${radiusCells}) did not include the origin cell`,
    );
  }

  const layout = {
    count,
    dx: Int32Array.from(dxValues),
    dy: Int32Array.from(dyValues),
    centerBias: Float64Array.from(centerBiasValues),
    neighborIndices,
    originIndex,
  };
  metalDepositResourceCandidateLayoutCache.set(radiusCells, layout);
  return layout;
}

function hashMetalDepositSeed(gx: number, gy: number, index: number): number {
  let h = 2166136261 >>> 0;
  h = Math.imul(h ^ gx, 16777619);
  h = Math.imul(h ^ gy, 16777619);
  h = Math.imul(h ^ index, 16777619);
  return h >>> 0;
}

function makeSeededRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function growMetalDepositResourceCells(
  originGx: number,
  originGy: number,
  targetCellCount: number,
  radiusCells: number,
  seed: number,
): MetalDepositResourceCell[] {
  const rng = makeSeededRng(seed);
  const layout = getMetalDepositResourceCandidateLayout(radiusCells);
  const selected = new Uint8Array(layout.count);
  const frontier = new Uint8Array(layout.count);
  const neighborCounts = new Uint8Array(layout.count);
  const frontierPrev = new Int32Array(layout.count);
  const frontierNext = new Int32Array(layout.count);
  const weights = new Float64Array(layout.count);
  const selectedIndices: number[] = [];
  frontierPrev.fill(-1);
  frontierNext.fill(-1);

  let frontierHead = -1;
  let frontierTail = -1;
  let frontierSize = 0;

  const appendFrontier = (index: number): void => {
    if (index < 0 || selected[index] !== 0 || frontier[index] !== 0) return;
    frontier[index] = 1;
    frontierPrev[index] = frontierTail;
    frontierNext[index] = -1;
    if (frontierTail >= 0) frontierNext[frontierTail] = index;
    else frontierHead = index;
    frontierTail = index;
    frontierSize++;
  };

  const removeFrontier = (index: number): void => {
    if (frontier[index] === 0) return;
    const prev = frontierPrev[index];
    const next = frontierNext[index];
    if (prev >= 0) frontierNext[prev] = next;
    else frontierHead = next;
    if (next >= 0) frontierPrev[next] = prev;
    else frontierTail = prev;
    frontierPrev[index] = -1;
    frontierNext[index] = -1;
    frontier[index] = 0;
    frontierSize--;
  };

  const addSelected = (index: number): void => {
    if (selected[index] !== 0) return;
    selected[index] = 1;
    selectedIndices.push(index);
    removeFrontier(index);

    const base = index * METAL_DEPOSIT_RESOURCE_NEIGHBOR_COUNT;
    for (let i = 0; i < METAL_DEPOSIT_RESOURCE_NEIGHBOR_COUNT; i++) {
      const neighborIndex = layout.neighborIndices[base + i];
      if (neighborIndex >= 0) neighborCounts[neighborIndex]++;
    }
    for (let i = 0; i < METAL_DEPOSIT_RESOURCE_NEIGHBOR_COUNT; i++) {
      appendFrontier(layout.neighborIndices[base + i]);
    }
  };

  addSelected(layout.originIndex);
  while (selectedIndices.length < targetCellCount && frontierSize > 0) {
    let totalWeight = 0;
    let lastFrontierIndex = -1;
    for (let index = frontierHead; index >= 0; index = frontierNext[index]) {
      const weight =
        0.45 +
        neighborCounts[index] * 1.75 +
        layout.centerBias[index] * 2.25 +
        rng() * 0.35;
      totalWeight += weight;
      weights[index] = weight;
      lastFrontierIndex = index;
    }

    let pick = rng() * totalWeight;
    let chosenIndex = lastFrontierIndex;
    for (let index = frontierHead; index >= 0; index = frontierNext[index]) {
      pick -= weights[index];
      if (pick <= 0) {
        chosenIndex = index;
        break;
      }
    }
    if (chosenIndex < 0) break;
    addSelected(chosenIndex);
  }

  return selectedIndices
    .map((index) => cellCenter(originGx + layout.dx[index], originGy + layout.dy[index]))
    .sort((a, b) => (a.gy - b.gy) || (a.gx - b.gx));
}

function getMetalDepositCellBounds(
  cells: ReadonlyArray<MetalDepositResourceCell>,
): { gridX: number; gridY: number; gridW: number; gridH: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const cell of cells) {
    minX = Math.min(minX, cell.gx);
    minY = Math.min(minY, cell.gy);
    maxX = Math.max(maxX, cell.gx);
    maxY = Math.max(maxY, cell.gy);
  }
  if (!Number.isFinite(minX)) return { gridX: 0, gridY: 0, gridW: 0, gridH: 0 };
  return {
    gridX: minX,
    gridY: minY,
    gridW: maxX - minX + 1,
    gridH: maxY - minY + 1,
  };
}

function validMetalDepositDTerrainLevels(levels: number | null): number | null {
  if (levels === null) return null;
  if (!Number.isFinite(levels) || !Number.isInteger(levels)) {
    throw new Error(
      `Metal deposit dTerrainLevels must be a finite integer or null; received ${levels}`,
    );
  }
  return levels;
}

function validMetalDepositFlatPadCells(cells: number): number {
  if (!Number.isFinite(cells) || !Number.isInteger(cells) || cells <= 0) {
    throw new Error(
      `Metal deposit ring flatPadCells must be a positive integer; received ${cells}`,
    );
  }
  return cells;
}

function validMetalDepositTerrainBlendRadius(radius: number): number {
  if (!Number.isFinite(radius) || radius < 0) {
    throw new Error(
      `Metal deposit ring terrainBlendRadius must be a finite non-negative number; received ${radius}`,
    );
  }
  return radius;
}

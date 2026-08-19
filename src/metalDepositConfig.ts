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
// Each deposit owns a logical ore body on the fine build grid: exactly
// `metalCellCount` metal cells inside a disc around its origin cell.
// Which cells is the config's `cellPlacementMode` question, and the two
// answers read very differently on the ground —
//   'cosine-scatter'    draws every cell from the whole disc at once,
//                       weighted by a raised cosine of radial distance
//                       (1.0 at the centre, 0.5 at half the radius, 0.0
//                       at the rim). No connectivity rule; a dense core
//                       that frays into specks, filling its radius.
//   'connected-growth'  takes cells off the body's own frontier so every
//                       one touches another; a single blob, and its
//                       radius is a wander cap it rarely reaches.
// Neither ever draws a cell twice, so the authored count always lands in
// full either way. Terrain flattening still reads a separate flat-pad
// config.
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
//
// Each origin can then expand into a local deposit cluster. A ring's
// `depositCluster` defines how many deposits are placed around that
// origin and the world-unit radius of that secondary circle.
// `angleOffset` is relative to the origin's radial angle from map
// center, so every player's slice keeps the same local cluster shape.
// The legacy single-deposit behavior is
// `depositCluster: { count: 1, radius: 0, angleOffset: 0 }`.

import { MAP_GENERATION_EXTENT_FRACTION } from './mapSizeConfig';
import {
  METAL_DEPOSIT_STEP,
  setMetalDepositFlatZones,
  type TerrainFlatZone,
} from './game/sim/Terrain';
import {
  packTerrainFlatZoneRowsForWasm,
  packTerrainGenerationConfigForWasm,
} from './game/sim/terrain/terrainGenerationConfig';
import { BUILD_GRID_CELL_SIZE } from './game/sim/buildGrid';
import { getSimWasm } from './game/sim-wasm/init';
import { getMetalCoverage } from './game/sim/worldSurfaceState';
import type { MetalCoverage } from './types/worldSurfaceMode';
import rawConfig from './metalDepositConfig.json';

type DepositRing = {
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
  /** Name of an entry in the config's `sizes` table, deciding how big
   *  this ring's ore bodies are. Omit to inherit `defaultSize`. Size is
   *  the ORE BODY and is independent of `flatPadCells` — a large body
   *  over a small pad drapes across whatever relief it crosses. */
  size?: string;
  /** Signed count of METAL_DEPOSIT_STEP units above/below world height
   *  0, used as-authored regardless of the CENTER bar sign. Pass
   *  `null` to anchor the pad at the natural terrain height under the
   *  deposit's xy instead. */
  dTerrainLevels: number | null;
  /** Circular terrain-flattening diameter in fine building cells. Larger
   *  than the ore body gives the extractor a clean buildable pad without
   *  increasing production area; SMALLER than the body is equally legal
   *  and lets the ore leave the pad and drape over the surrounding
   *  relief. Pass `null` to auto-size to the smallest cell count whose
   *  circular radius covers the placement disc. */
  flatPadCells: number | null;
  /** World-unit width outside the circular flat pad where terrain eases
   *  back to the natural heightmap. Larger values make the deposit pad
   *  integrate more gradually with surrounding terrain. */
  terrainBlendRadius: number;
  /** Secondary local cluster spawned from each primary ring origin.
   *  `type: "group-ring"` (the default when omitted) places `count`
   *  deposits on a circle of `radius` around the origin; `angleOffset`
   *  is a radian offset relative to the origin's radial angle from map
   *  center. `{ count: 1, radius: 0, angleOffset: 0 }` exactly
   *  preserves the legacy behavior.
   *  `type: "group-manual"` places one deposit per authored spot
   *  (world-unit offsets in the origin's radial frame: +x points away
   *  from map center, +y is perpendicular, so every player's slice
   *  keeps the same local shape). Manual groups are one TERRAIN UNIT:
   *  the union of the spots' flat pads is fully overridden by a single
   *  smoothed height field — each deposit's resource footprint stays
   *  perfectly flat at its own height, heights interpolate between
   *  plateaus with cosine shaping across the pads, and the whole field
   *  eases back to natural terrain over `terrainBlendRadius`. Spots may
   *  override the ring's `dTerrainLevels` individually. */
  depositCluster: MetalDepositClusterConfig;
  /** When false, the demo/background battle does NOT auto-build a team
   *  extractor on this ring's deposits — they start neutral and any
   *  player may claim them. Defaults to true (legacy behavior). Real
   *  battles are unaffected (players always build their own). */
  demoAutoExtractor?: boolean;
  /** Optional free-form note for the author — purely descriptive, not
   *  read by any runtime code. Useful for labeling where a ring sits
   *  ("inner near spawn", "back side cluster", etc.). */
  comment?: string;
};

type MetalDepositRingClusterConfig = {
  type?: 'group-ring';
  count: number;
  radius: number;
  angleOffset: number;
};

type MetalDepositManualOffsetSpot = {
  /** World-unit offset along the origin's radial direction from map
   *  center (+x = away from center). */
  x: number;
  /** World-unit offset perpendicular to the radial direction. */
  y: number;
  /** Per-spot height override in METAL_DEPOSIT_STEP units. Omit to
   *  inherit the ring's `dTerrainLevels`; `null` anchors this spot to
   *  the natural terrain height under its xy. */
  dTerrainLevels?: number | null;
  /** Per-spot flat-pad override in build cells (same rules as the
   *  ring's `flatPadCells`). Omit to inherit the ring's value. */
  flatPadCells?: number | null;
  /** Per-spot ore size-class override. Omit to inherit the ring's. */
  size?: string;
};

/** Ring-coordinate spot: placed by the EXACT same oval/slice formula
 *  as a standalone ring origin, so merging existing rings into one
 *  group reproduces their positions identically for every player
 *  count and map size. */
type MetalDepositManualRingSpot = {
  radiusFraction: number;
  sliceOffset: number;
  dTerrainLevels?: number | null;
  flatPadCells?: number | null;
  size?: string;
};

type MetalDepositManualSpot =
  | MetalDepositManualOffsetSpot
  | MetalDepositManualRingSpot;

type MetalDepositManualClusterConfig = {
  type: 'group-manual';
  spots: MetalDepositManualSpot[];
};

type MetalDepositClusterConfig =
  | MetalDepositRingClusterConfig
  | MetalDepositManualClusterConfig;

/** How a deposit picks which build cells inside its disc are metal.
 *  Authored once for the whole map in metalDepositConfig.json — it feeds
 *  the canonical cell list every peer generates, so it is config, never a
 *  runtime toggle. */
export const METAL_DEPOSIT_CELL_PLACEMENT_MODES = [
  'cosine-scatter',
  'connected-growth',
] as const;

export type MetalDepositCellPlacementMode =
  typeof METAL_DEPOSIT_CELL_PLACEMENT_MODES[number];

/** One authored ore-body size class: `metalCellCount` metal cells inside a
 *  disc, plus that disc's radius for each placement mode. The count is
 *  shared, so switching modes moves the ore without changing how much of
 *  it is on the map. */
export type MetalDepositSize = {
  /** Exactly how many metal build cells this ore body owns, in either
   *  placement mode. */
  metalCellCount: number;
  /** Radius, in build cells from the origin cell, of the disc
   *  'cosine-scatter' fills. The body's true extent. */
  scatterRadiusCells: number;
  /** The same disc for 'connected-growth', where it is a wander cap the
   *  blob rarely reaches rather than an extent it fills. */
  growthRadiusCells: number;
};

/** How the ore REGION is baked for rendering. See metalDepositConfig.json
 *  `surfaceFieldComment` — this is presentation data only and never
 *  reaches the simulation or the canonical state hash. */
export type MetalDepositSurfaceFieldConfig = {
  texelWorldSize: number;
  maxTextureDimension: number;
  edgeRangeWorldUnits: number;
  smoothPasses: number;
  edgeFeatherWorldUnits: number;
};

/** Authored layout config for the metal deposit ring placer. Pure data
 *  lives in metalDepositConfig.json so both TypeScript and Rust/WASM
 *  can load the same source of truth. Field meanings:
 *    - `edgeMarginPx`: oval-space world units between the spawn oval
 *      and the outermost deposit ring (keeps deposits from clipping
 *      into commander spawns).
 *    - `cellPlacementMode`: which algorithm decides WHICH cells inside a
 *      deposit's disc are metal — see the JSON's comment block. Both
 *      modes place the same authored count.
 *    - `sizes` / `defaultSize`: the ore-body size classes rings pick
 *      from. Size decides the ORE BODY only; how much terrain is
 *      flattened underneath stays each ring's `flatPadCells`, and the
 *      two are deliberately independent.
 *    - `productionNominalCells`: economy calibration for the extractor
 *      metal rate. Held apart from the size table so retuning a size
 *      class cannot silently retune income.
 *    - `surfaceField`: the rendered ore region's bake settings.
 *    - `rings`: concentric deposit rings; order doesn't matter — the
 *      renderer and placement validator iterate over all of them. Each
 *      ring carries its own `flatPadCells` and `terrainBlendRadius`. */
export const METAL_DEPOSIT_CONFIG = {
  edgeMarginPx: rawConfig.edgeMarginPx,
  cellPlacementMode: validMetalDepositCellPlacementMode(
    rawConfig.cellPlacementMode,
  ),
  sizes: rawConfig.sizes as Record<string, MetalDepositSize>,
  defaultSize: rawConfig.defaultSize as string,
  productionNominalCells: rawConfig.productionNominalCells,
  surfaceField: rawConfig.surfaceField as MetalDepositSurfaceFieldConfig,
  rings: rawConfig.rings as DepositRing[],
};

function validMetalDepositCellPlacementMode(
  mode: unknown,
): MetalDepositCellPlacementMode {
  if (
    !METAL_DEPOSIT_CELL_PLACEMENT_MODES.includes(
      mode as MetalDepositCellPlacementMode,
    )
  ) {
    throw new Error(
      `Metal deposit cellPlacementMode must be one of ` +
      `${METAL_DEPOSIT_CELL_PLACEMENT_MODES.join(', ')}; received ${String(mode)}`,
    );
  }
  return mode as MetalDepositCellPlacementMode;
}

/** The placement-disc radius the ACTIVE mode uses. Everything downstream —
 *  the placer's bound, a `null` flatPadCells, the build-placement safety
 *  radius — reads this one accessor, so the mode switch cannot leave a
 *  consumer sized for the other algorithm. */
export function getMetalDepositPlacementRadiusCells(
  size: MetalDepositSize,
): number {
  return METAL_DEPOSIT_CONFIG.cellPlacementMode === 'connected-growth'
    ? size.growthRadiusCells
    : size.scatterRadiusCells;
}

/** Resolve an authored size name against the config's size table. */
export function getMetalDepositSize(name: string): MetalDepositSize {
  const size = METAL_DEPOSIT_CONFIG.sizes[name];
  if (size === undefined) {
    throw new Error(
      `Metal deposit size "${name}" is not defined in metalDepositConfig.json sizes; ` +
      `known sizes: ${Object.keys(METAL_DEPOSIT_CONFIG.sizes).join(', ')}`,
    );
  }
  const cellCount = size.metalCellCount;
  if (!Number.isInteger(cellCount) || cellCount <= 0) {
    throw new Error(
      `Metal deposit size "${name}" metalCellCount must be a positive integer; received ${cellCount}`,
    );
  }
  // Both modes' radii are checked whichever one is active, so flipping
  // cellPlacementMode can never fail at map-generation time.
  for (const field of ['scatterRadiusCells', 'growthRadiusCells'] as const) {
    const radiusCells = size[field];
    if (!Number.isInteger(radiusCells) || radiusCells <= 0) {
      throw new Error(
        `Metal deposit size "${name}" ${field} must be a positive integer; received ${radiusCells}`,
      );
    }
  }
  return size;
}

type MetalDepositResourceCell = {
  gx: number;
  gy: number;
  x: number;
  y: number;
};

export type MetalDeposit = {
  /** Stable index — same number across all clients/peers in a session. */
  id: number;
  /** World-space center of the origin build cell and flat terrain pad. */
  x: number;
  y: number;
  /** Origin build cell — the centre of the cosine placement disc. */
  originGx: number;
  originGy: number;
  /** How many metal cells the authored size class asks this body for.
   *  Cluster copies inherit it; the METAL coverage setting may scatter a
   *  different number, which lands in `metalCellCount`. */
  authoredMetalCellCount: number;
  /** The metal-producing build cells this body actually owns. */
  cells: MetalDepositResourceCell[];
  /** How many metal cells landed — `cells.length`. */
  metalCellCount: number;
  /** Radius of the placement disc, measured from the origin cell in
   *  build cells. No metal exists outside it. */
  placementRadiusCells: number;
  /** Tight build-grid bounds around `cells`. */
  boundsGridX: number;
  boundsGridY: number;
  boundsGridW: number;
  boundsGridH: number;
  /** The placement disc's outer radius in world units. */
  placementRadius: number;
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
  /** False when the authored ring opts this deposit out of the demo
   *  battle's auto-built team extractor (the deposit starts neutral). */
  demoAutoExtractor: boolean;
  /** Deposits sharing a non-negative id came from one `group-manual`
   *  cluster and are smoothed as one terrain unit. -1 = standalone. */
  groupId: number;
};

type MetalDepositPlacement = Pick<
  MetalDeposit,
  | 'x'
  | 'y'
  | 'originGx'
  | 'originGy'
  | 'authoredMetalCellCount'
  | 'cells'
  | 'metalCellCount'
  | 'placementRadiusCells'
  | 'boundsGridX'
  | 'boundsGridY'
  | 'boundsGridW'
  | 'boundsGridH'
  | 'placementRadius'
  | 'flatPadRadius'
>;

type PendingPlacement = {
  placement: MetalDepositPlacement;
  dTerrainLevels: number | null;
  blendRadius: number;
  explicitHeight: number | null;
  demoAutoExtractor: boolean;
  /** Shared non-negative id for `group-manual` siblings; -1 standalone. */
  groupId: number;
};

const METAL_DEPOSIT_RING_INPUT_STRIDE = 8;
const METAL_DEPOSIT_PLACEMENT_OUTPUT_STRIDE = 11;
const METAL_DEPOSIT_HEIGHT_INPUT_STRIDE = 3;
const METAL_DEPOSIT_D_TERRAIN_NULL = Number.NaN;

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
 *
 * The METAL coverage rung (BATTLE bar) is read here and changes NOTHING
 * about the four passes: every rung lays out the same placements, resolves
 * the same heights and installs the same flat zones, so the world is shaped
 * identically whichever rung is picked. It decides only how big each ore
 * body grows — and NONE goes one step further and returns no deposits at
 * all, leaving the land they shaped behind them.
 */
export function generateMetalDeposits(
  mapWidth: number,
  mapHeight: number,
  playerCount: number,
  coverage: MetalCoverage = getMetalCoverage(),
): MetalDeposit[] {
  // Pass 1: lay out every deposit's xy + per-ring metadata. No
  // heights yet — those depend on whether the ring is explicit-height
  // (immediate) or null (sampled after explicit pads are installed).
  const placements = generateMetalDepositPlacementsFromWasm(
    mapWidth,
    mapHeight,
    playerCount,
    coverage,
  );

  // Pass 2: collect explicit-dTerrain pads and install them so the
  // Rust null-ring sampler in pass 3 sees terrain already shaped by
  // those pads (including blend bands).
  const explicitZones: TerrainFlatZone[] = [];
  for (let i = 0; i < placements.length; i++) {
    const p = placements[i];
    if (p.explicitHeight === null) continue;
    const height = p.explicitHeight;
    explicitZones.push(makeMetalDepositFlatZone(p, height));
  }
  setMetalDepositFlatZones(explicitZones, false);

  // Pass 3: resolve every deposit height in Rust/WASM. Explicit
  // heights are copied through; null-dTerrain pads sample the
  // deterministic analytical terrain after explicit zones are applied.
  // Null pads do NOT see each other (order-dependent feedback);
  // they'll smooth into each other when the full set is installed in
  // pass 4.
  const heights = resolveMetalDepositTerrainHeightsFromWasm(
    mapWidth,
    mapHeight,
    placements,
    explicitZones,
  );

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
      demoAutoExtractor: p.demoAutoExtractor,
      groupId: p.groupId,
    });
    allZones.push(makeMetalDepositFlatZone(p, height));
  }
  setMetalDepositFlatZones(allZones);

  // NONE: the pads above are already installed, so the map keeps the exact
  // land every other rung generates. Handing back no deposits is what makes
  // it a metal-free world — nothing to mine, nowhere to place an extractor.
  if (coverage === 'none') return [];

  return deposits;
}

/** Flat zone for one pending placement. Standalone deposits keep the
 *  whole pad hard-flat (plateauRadius = pad radius); `group-manual`
 *  members are hard-flat only over their resource footprint — the pad
 *  annulus outside it carries the group's smoothed interpolation. */
function makeMetalDepositFlatZone(
  p: PendingPlacement,
  height: number,
): TerrainFlatZone {
  const grouped = p.groupId >= 0;
  return {
    x: p.placement.x,
    y: p.placement.y,
    radius: p.placement.flatPadRadius,
    height,
    blendRadius: p.blendRadius,
    plateauRadius: grouped
      ? Math.min(p.placement.placementRadius, p.placement.flatPadRadius)
      : p.placement.flatPadRadius,
    groupId: p.groupId,
  };
}

/** One packed Rust placement row. A classic ring packs one row;
 *  a `group-manual` ring with RING-COORDINATE spots packs one row PER
 *  SPOT — each spot runs the exact same oval/slice placement formula
 *  a standalone ring would, so merging rings into a group reproduces
 *  their positions identically. */
type MetalDepositPackRow = {
  ring: DepositRing;
  cluster: ResolvedMetalDepositClusterConfig;
  /** Set for ring-coordinate group spots; null = the ring's own row. */
  ringSpot: MetalDepositManualRingSpot | null;
  radiusFraction: number;
  countPerPlayer: number;
  sliceOffset: number;
  dTerrainLevels: number | null;
  flatPadCells: number;
  blendRadius: number;
  /** Resolved from the row's authored size name — per row, because one
   *  map mixes standard spots with very large ore bodies. */
  metalCellCount: number;
  placementRadiusCells: number;
};

/** World-unit radius of the disc a size places its metal inside, under the
 *  active mode. This is what a `null` flatPadCells auto-sizes its pad to
 *  cover. */
function metalDepositPlacementRadiusForSize(size: MetalDepositSize): number {
  return (
    (getMetalDepositPlacementRadiusCells(size) + 0.5) * BUILD_GRID_CELL_SIZE
  );
}

function buildMetalDepositPackPlan(): MetalDepositPackRow[] {
  const plan: MetalDepositPackRow[] = [];
  for (const ring of METAL_DEPOSIT_CONFIG.rings) {
    const cluster = validMetalDepositClusterConfig(ring.depositCluster);
    const ringSize = resolveMetalDepositSize(ring.size);
    const ringPlacementRadius = metalDepositPlacementRadiusForSize(ringSize);
    const ringPadCells = resolveMetalDepositFlatPadCells(
      ring.flatPadCells,
      ringPlacementRadius,
    );
    const ringDTerrain = validMetalDepositDTerrainLevels(ring.dTerrainLevels);
    const blendRadius = validMetalDepositTerrainBlendRadius(ring.terrainBlendRadius);
    if (cluster.type === 'group-manual' && cluster.spotKind === 'ring') {
      if (metalDepositLoopCount(ring.countPerPlayer) !== 1) {
        throw new Error(
          'Metal deposit rings with ring-coordinate group-manual spots must author countPerPlayer 1 — each spot already places once per player slice',
        );
      }
      for (const spot of cluster.spots) {
        const spotSize = spot.size === undefined
          ? ringSize
          : resolveMetalDepositSize(spot.size);
        plan.push({
          ring,
          cluster,
          ringSpot: spot,
          radiusFraction: spot.radiusFraction,
          countPerPlayer: 1,
          sliceOffset: spot.sliceOffset,
          dTerrainLevels: spot.dTerrainLevels === undefined
            ? ringDTerrain
            : validMetalDepositDTerrainLevels(spot.dTerrainLevels),
          flatPadCells: spot.flatPadCells === undefined && spot.size === undefined
            ? ringPadCells
            : resolveMetalDepositFlatPadCells(
              spot.flatPadCells === undefined ? ring.flatPadCells : spot.flatPadCells,
              metalDepositPlacementRadiusForSize(spotSize),
            ),
          blendRadius,
          metalCellCount: spotSize.metalCellCount,
          placementRadiusCells: getMetalDepositPlacementRadiusCells(spotSize),
        });
      }
      continue;
    }
    plan.push({
      ring,
      cluster,
      ringSpot: null,
      radiusFraction: ring.radiusFraction,
      countPerPlayer: ring.countPerPlayer,
      sliceOffset: ring.sliceOffset ?? 0,
      dTerrainLevels: ringDTerrain,
      flatPadCells: ringPadCells,
      blendRadius,
      metalCellCount: ringSize.metalCellCount,
      placementRadiusCells: getMetalDepositPlacementRadiusCells(ringSize),
    });
  }
  return plan;
}

function generateMetalDepositPlacementsFromWasm(
  mapWidth: number,
  mapHeight: number,
  playerCount: number,
  coverage: MetalCoverage,
): PendingPlacement[] {
  const sim = getRequiredSimWasm();
  const plan = buildMetalDepositPackPlan();
  const ringRows = packMetalDepositRingRows(plan);
  const players = Math.max(1, Math.floor(playerCount));
  const placementCount = sim.metalDepositCountPlacements(players, ringRows);
  const placementRows = new Float64Array(
    placementCount * METAL_DEPOSIT_PLACEMENT_OUTPUT_STRIDE,
  );
  const written = sim.metalDepositGeneratePlacements(
    mapWidth,
    mapHeight,
    players,
    MAP_GENERATION_EXTENT_FRACTION,
    METAL_DEPOSIT_CONFIG.edgeMarginPx,
    BUILD_GRID_CELL_SIZE,
    METAL_DEPOSIT_STEP,
    ringRows,
    placementRows,
  );
  if (written !== placementCount) {
    throw new Error(
      `Metal deposit placement kernel returned ${written} placements; expected ${placementCount}`,
    );
  }

  const placements: PendingPlacement[] = [];
  const groupIdAllocator = { next: 0 };
  let sourceIndex = 0;
  const consumeOrigin = (row: MetalDepositPackRow, groupId: number): PendingPlacement => {
    const base = sourceIndex * METAL_DEPOSIT_PLACEMENT_OUTPUT_STRIDE;
    const dTerrainRaw = placementRows[base + 8];
    const explicitHeightRaw = placementRows[base + 10];
    const origin: PendingPlacement = {
      placement: makeMetalDepositPlacementFromWasmRow(
        placementRows,
        base,
        sourceIndex,
        coverage,
      ),
      dTerrainLevels: Number.isNaN(dTerrainRaw)
        ? null
        : finiteInteger(dTerrainRaw, 'metal deposit dTerrainLevels'),
      blendRadius: placementRows[base + 9],
      explicitHeight: Number.isNaN(explicitHeightRaw) ? null : explicitHeightRaw,
      demoAutoExtractor: row.ring.demoAutoExtractor !== false,
      groupId,
    };
    sourceIndex++;
    return origin;
  };

  let planIndex = 0;
  while (planIndex < plan.length) {
    const row = plan[planIndex];
    if (row.ringSpot !== null) {
      // Ring-coordinate group: this ring's spot rows are consecutive in
      // the plan. Rust emitted origins spot-major then player-major;
      // player p's copies of every spot share one group id, so each
      // slice's group smooths as its own terrain unit.
      let spotRowCount = 0;
      while (
        planIndex + spotRowCount < plan.length &&
        plan[planIndex + spotRowCount].ring === row.ring
      ) {
        spotRowCount++;
      }
      const groupIdBase = groupIdAllocator.next;
      groupIdAllocator.next += players;
      for (let s = 0; s < spotRowCount; s++) {
        const spotRow = plan[planIndex + s];
        for (let p = 0; p < players; p++) {
          placements.push(consumeOrigin(spotRow, groupIdBase + p));
        }
      }
      planIndex += spotRowCount;
      continue;
    }
    const originCount = row.radiusFraction <= 1e-6
      ? 1
      : players * metalDepositLoopCount(row.countPerPlayer);
    for (let i = 0; i < originCount; i++) {
      const origin = consumeOrigin(row, -1);
      expandMetalDepositClusterPlacements(
        origin,
        row.cluster,
        mapWidth,
        mapHeight,
        placements,
        groupIdAllocator,
        coverage,
      );
    }
    planIndex++;
  }
  if (sourceIndex !== written) {
    throw new Error(
      `Metal deposit placement expansion consumed ${sourceIndex} origins; expected ${written}`,
    );
  }

  return placements;
}

function metalDepositLoopCount(limit: number): number {
  if (!Number.isFinite(limit) || limit <= 0) return 0;
  return Math.ceil(limit);
}

function expandMetalDepositClusterPlacements(
  origin: PendingPlacement,
  cluster: ResolvedMetalDepositClusterConfig,
  mapWidth: number,
  mapHeight: number,
  out: PendingPlacement[],
  groupIdAllocator: { next: number },
  coverage: MetalCoverage,
): void {
  const radialAngle = metalDepositRadialAngleFromMapCenter(
    origin.placement.x,
    origin.placement.y,
    mapWidth,
    mapHeight,
  );

  if (cluster.type === 'group-manual') {
    // Ring-coordinate spots never reach this expansion — they pack as
    // their own placement rows in buildMetalDepositPackPlan.
    if (cluster.spotKind !== 'offsets') {
      throw new Error(
        'Metal deposit ring-coordinate group-manual spots must be expanded from the pack plan',
      );
    }
    // Every origin (each player's copy of the ring) becomes its OWN
    // terrain group — groups smooth internally, never across players.
    const groupId = groupIdAllocator.next++;
    const cosA = Math.cos(radialAngle);
    const sinA = Math.sin(radialAngle);
    for (const spot of cluster.spots) {
      // Spot offsets live in the origin's radial frame (+x away from
      // map center) so every player's slice keeps the same local shape.
      const rawX = origin.placement.x + spot.x * cosA - spot.y * sinA;
      const rawY = origin.placement.y + spot.x * sinA + spot.y * cosA;
      const dTerrainLevels = spot.dTerrainLevels === undefined
        ? origin.dTerrainLevels
        : spot.dTerrainLevels;
      const explicitHeight = spot.dTerrainLevels === undefined
        ? origin.explicitHeight
        : spot.dTerrainLevels === null
          ? null
          : spot.dTerrainLevels * METAL_DEPOSIT_STEP;
      const placement = makeMetalDepositPlacementFromRawPoint(
        rawX,
        rawY,
        origin.placement,
        out.length,
        coverage,
      );
      if (spot.flatPadCells !== undefined) {
        placement.flatPadRadius =
          resolveMetalDepositFlatPadCells(
            spot.flatPadCells,
            origin.placement.placementRadius,
          ) * BUILD_GRID_CELL_SIZE * 0.5;
      }
      out.push({
        placement,
        dTerrainLevels,
        blendRadius: origin.blendRadius,
        explicitHeight,
        demoAutoExtractor: origin.demoAutoExtractor,
        groupId,
      });
    }
    return;
  }

  if (cluster.count === 1 && cluster.radius <= 0) {
    out.push(origin);
    return;
  }
  for (let i = 0; i < cluster.count; i++) {
    const angle =
      radialAngle + cluster.angleOffset + (i / cluster.count) * Math.PI * 2;
    const rawX = origin.placement.x + Math.cos(angle) * cluster.radius;
    const rawY = origin.placement.y + Math.sin(angle) * cluster.radius;
    out.push({
      placement: makeMetalDepositPlacementFromRawPoint(
        rawX,
        rawY,
        origin.placement,
        out.length,
        coverage,
      ),
      dTerrainLevels: origin.dTerrainLevels,
      blendRadius: origin.blendRadius,
      explicitHeight: origin.explicitHeight,
      demoAutoExtractor: origin.demoAutoExtractor,
      groupId: -1,
    });
  }
}

function metalDepositRadialAngleFromMapCenter(
  x: number,
  y: number,
  mapWidth: number,
  mapHeight: number,
): number {
  const dx = x - mapWidth * 0.5;
  const dy = y - mapHeight * 0.5;
  if (Math.abs(dx) <= 1e-6 && Math.abs(dy) <= 1e-6) return 0;
  return Math.atan2(dy, dx);
}

function makeMetalDepositPlacementFromRawPoint(
  rawX: number,
  rawY: number,
  template: MetalDepositPlacement,
  seedIndex: number,
  coverage: MetalCoverage,
): MetalDepositPlacement {
  // Mirrors the Rust placement kernel: a deposit sits at the CENTRE of
  // whichever build cell its raw point fell in, reading nothing from the
  // ore body, so a size class can never move a flat pad.
  const originGx = Math.floor(rawX / BUILD_GRID_CELL_SIZE);
  const originGy = Math.floor(rawY / BUILD_GRID_CELL_SIZE);
  const x = (originGx + 0.5) * BUILD_GRID_CELL_SIZE;
  const y = (originGy + 0.5) * BUILD_GRID_CELL_SIZE;
  const ore = metalDepositOreForCoverage(
    coverage,
    template.authoredMetalCellCount,
    template.placementRadiusCells,
  );
  const cells = placeMetalDepositCells(
    originGx,
    originGy,
    ore.metalCellCount,
    ore.placementRadiusCells,
    hashMetalDepositSeed(originGx, originGy, seedIndex),
  );
  const bounds = getMetalDepositCellBounds(cells);
  return {
    x,
    y,
    originGx,
    originGy,
    authoredMetalCellCount: template.authoredMetalCellCount,
    cells,
    metalCellCount: cells.length,
    placementRadiusCells: template.placementRadiusCells,
    boundsGridX: bounds.gridX,
    boundsGridY: bounds.gridY,
    boundsGridW: bounds.gridW,
    boundsGridH: bounds.gridH,
    placementRadius: template.placementRadius,
    flatPadRadius: template.flatPadRadius,
  };
}

function resolveMetalDepositTerrainHeightsFromWasm(
  mapWidth: number,
  mapHeight: number,
  placements: readonly PendingPlacement[],
  explicitZones: readonly TerrainFlatZone[],
): number[] {
  const sim = getRequiredSimWasm();
  const heightInputs = new Float64Array(
    placements.length * METAL_DEPOSIT_HEIGHT_INPUT_STRIDE,
  );
  for (let i = 0; i < placements.length; i++) {
    const base = i * METAL_DEPOSIT_HEIGHT_INPUT_STRIDE;
    const p = placements[i];
    heightInputs[base] = p.placement.x;
    heightInputs[base + 1] = p.placement.y;
    heightInputs[base + 2] =
      p.explicitHeight === null ? METAL_DEPOSIT_D_TERRAIN_NULL : p.explicitHeight;
  }

  const outHeights = new Float64Array(placements.length);
  const written = sim.metalDepositResolveTerrainHeights(
    mapWidth,
    mapHeight,
    MAP_GENERATION_EXTENT_FRACTION,
    packTerrainGenerationConfigForWasm(),
    packTerrainFlatZoneRowsForWasm(explicitZones),
    heightInputs,
    outHeights,
  );
  if (written !== placements.length) {
    throw new Error(
      `Metal deposit terrain-height kernel returned ${written} heights; expected ${placements.length}`,
    );
  }
  return Array.from(outHeights);
}

function packMetalDepositRingRows(plan: readonly MetalDepositPackRow[]): Float64Array {
  const ringRows = new Float64Array(plan.length * METAL_DEPOSIT_RING_INPUT_STRIDE);
  for (let i = 0; i < plan.length; i++) {
    const row = plan[i];
    const base = i * METAL_DEPOSIT_RING_INPUT_STRIDE;
    ringRows[base] = row.radiusFraction;
    ringRows[base + 1] = row.countPerPlayer;
    ringRows[base + 2] = row.sliceOffset;
    ringRows[base + 3] = row.dTerrainLevels ?? METAL_DEPOSIT_D_TERRAIN_NULL;
    ringRows[base + 4] = row.flatPadCells;
    ringRows[base + 5] = row.blendRadius;
    ringRows[base + 6] = row.metalCellCount;
    ringRows[base + 7] = row.placementRadiusCells;
  }
  return ringRows;
}

function makeMetalDepositPlacementFromWasmRow(
  rows: Float64Array,
  base: number,
  seedIndex: number,
  coverage: MetalCoverage,
): MetalDepositPlacement {
  const x = rows[base];
  const y = rows[base + 1];
  const originGx = finiteInteger(rows[base + 2], 'metal deposit originGx');
  const originGy = finiteInteger(rows[base + 3], 'metal deposit originGy');
  const authoredMetalCellCount = finiteInteger(
    rows[base + 4],
    'metal deposit metalCellCount',
  );
  const placementRadiusCells = finiteInteger(
    rows[base + 5],
    'metal deposit placementRadiusCells',
  );
  const placementRadius = rows[base + 6];
  const flatPadRadius = rows[base + 7];
  // Everything above this line is the AUTHORED body — the one the terrain
  // pipeline sized its pad and plateau from. Only the scattered cells
  // below follow the METAL setting.
  const ore = metalDepositOreForCoverage(
    coverage,
    authoredMetalCellCount,
    placementRadiusCells,
  );
  const cells = placeMetalDepositCells(
    originGx,
    originGy,
    ore.metalCellCount,
    ore.placementRadiusCells,
    hashMetalDepositSeed(originGx, originGy, seedIndex),
  );
  const bounds = getMetalDepositCellBounds(cells);
  return {
    x,
    y,
    originGx,
    originGy,
    authoredMetalCellCount,
    cells,
    metalCellCount: cells.length,
    placementRadiusCells,
    boundsGridX: bounds.gridX,
    boundsGridY: bounds.gridY,
    boundsGridW: bounds.gridW,
    boundsGridH: bounds.gridH,
    placementRadius,
    flatPadRadius,
  };
}

function finiteInteger(value: number, label: string): number {
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new Error(`${label} must be a finite integer; received ${value}`);
  }
  return value;
}

/** Resolve a ring's or spot's authored size name (undefined = the
 *  config default) and prove the placement disc can actually hold the
 *  authored cell count. Every cell must land, so a disc too small for
 *  its own body is a config error — caught here rather than showing up
 *  later as a short cell list. */
function resolveMetalDepositSize(name: string | undefined): MetalDepositSize {
  const size = getMetalDepositSize(name ?? METAL_DEPOSIT_CONFIG.defaultSize);
  // Check BOTH modes' discs, not just the active one — a config that would
  // throw the moment cellPlacementMode flips is already broken.
  for (const field of ['scatterRadiusCells', 'growthRadiusCells'] as const) {
    const candidateCount = countMetalDepositPlacementCandidates(size[field]);
    if (candidateCount < size.metalCellCount) {
      throw new Error(
        `Metal deposit size ${field} (${size[field]}) offers ` +
        `${candidateCount} placeable cells, which cannot hold ${size.metalCellCount}`,
      );
    }
  }
  return size;
}

/** The ore body a METAL coverage rung actually scatters at one spot, given
 *  the authored size class. Terrain never reads this: pads, plateau radii,
 *  blend skirts and the deposit's own xy all keep the AUTHORED size, so all
 *  four rungs shape the land identically and only the ore moves.
 *    NONE  - nothing is placed (and generateMetalDeposits drops the list).
 *    SOME  - one default-size body per spot, the pre-size-table world.
 *    MORE  - the per-ring authored sizes.
 *    ALL   - authored too: the bodies stay under a map that is ore anyway,
 *            so METAL-everywhere behaves exactly as it always has. */
function metalDepositOreForCoverage(
  coverage: MetalCoverage,
  authoredMetalCellCount: number,
  authoredPlacementRadiusCells: number,
): { metalCellCount: number; placementRadiusCells: number } {
  if (coverage === 'none') {
    return {
      metalCellCount: 0,
      placementRadiusCells: authoredPlacementRadiusCells,
    };
  }
  if (coverage === 'some') {
    const size = getMetalDepositSize(METAL_DEPOSIT_CONFIG.defaultSize);
    return {
      metalCellCount: size.metalCellCount,
      placementRadiusCells: getMetalDepositPlacementRadiusCells(size),
    };
  }
  return {
    metalCellCount: authoredMetalCellCount,
    placementRadiusCells: authoredPlacementRadiusCells,
  };
}

function getRequiredSimWasm() {
  const sim = getSimWasm();
  if (sim === undefined) {
    throw new Error(
      'generateMetalDeposits requires sim-wasm to be initialized before terrain/deposit generation',
    );
  }
  return sim;
}

/** How many build cells a placement disc of this radius can legally hold —
 *  the lattice points strictly inside it, which is where the cosine
 *  probability is still non-zero. */
function countMetalDepositPlacementCandidates(radiusCells: number): number {
  return getRequiredSimWasm().metalDepositCountPlacementCandidates(radiusCells);
}

function cellCenter(gx: number, gy: number): MetalDepositResourceCell {
  return {
    gx,
    gy,
    x: gx * BUILD_GRID_CELL_SIZE + BUILD_GRID_CELL_SIZE / 2,
    y: gy * BUILD_GRID_CELL_SIZE + BUILD_GRID_CELL_SIZE / 2,
  };
}

function hashMetalDepositSeed(gx: number, gy: number, index: number): number {
  let h = 2166136261 >>> 0;
  h = Math.imul(h ^ gx, 16777619);
  h = Math.imul(h ^ gy, 16777619);
  h = Math.imul(h ^ index, 16777619);
  return h >>> 0;
}

/** Fill one deposit's placement disc with metal cells, by whichever
 *  algorithm `cellPlacementMode` selects. Every authored cell has to land
 *  in either mode — a short list means the disc could not hold the body
 *  and is a config error, not something to render around. */
function placeMetalDepositCells(
  originGx: number,
  originGy: number,
  metalCellCount: number,
  placementRadiusCells: number,
  seed: number,
): MetalDepositResourceCell[] {
  // NONE places nothing. The deposit still exists as a terrain feature at
  // this point; it simply has no ore body to rasterize.
  if (metalCellCount <= 0) return [];
  const sim = getRequiredSimWasm();
  const place = METAL_DEPOSIT_CONFIG.cellPlacementMode === 'connected-growth'
    ? sim.metalDepositGrowMetalCells
    : sim.metalDepositScatterMetalCells;
  const outCells = new Int32Array(metalCellCount * 2);
  const count = place(
    originGx,
    originGy,
    metalCellCount,
    placementRadiusCells,
    seed,
    outCells,
  );
  if (count !== metalCellCount) {
    throw new Error(
      `Metal deposit ${METAL_DEPOSIT_CONFIG.cellPlacementMode} placement returned ` +
      `${count} cells; expected ${metalCellCount}`,
    );
  }
  const cells: MetalDepositResourceCell[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const base = i * 2;
    cells[i] = cellCenter(outCells[base], outCells[base + 1]);
  }
  return cells;
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

/** Resolve a ring's authored flatPadCells against the generated ore
 *  placement disc. `null` auto-sizes to the smallest cell count whose
 *  circular flat-pad radius covers that disc.
 *
 *  An authored value is taken AS AUTHORED, including values smaller
 *  than the disc. That used to throw, on the assumption that ore
 *  and buildable pad were the same thing. They are not: the pad is
 *  terrain shaping and the ore is a shaded region sampled in world XZ,
 *  so a small pad inside a large body is the authored way to get ore
 *  that runs off the flat and down the surrounding relief. The pad
 *  still decides where an extractor will fit. */
function resolveMetalDepositFlatPadCells(
  cells: number | null,
  placementRadius: number,
): number {
  if (cells === null) {
    return Math.max(1, Math.ceil((placementRadius * 2) / BUILD_GRID_CELL_SIZE));
  }
  if (!Number.isFinite(cells) || !Number.isInteger(cells) || cells <= 0) {
    throw new Error(
      `Metal deposit ring flatPadCells must be a positive integer or null; received ${cells}`,
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

type ResolvedMetalDepositClusterConfig =
  | { type: 'group-ring'; count: number; radius: number; angleOffset: number }
  | { type: 'group-manual'; spotKind: 'offsets'; spots: readonly MetalDepositManualOffsetSpot[] }
  | { type: 'group-manual'; spotKind: 'ring'; spots: readonly MetalDepositManualRingSpot[] };

function isMetalDepositRingSpot(
  spot: MetalDepositManualSpot,
): spot is MetalDepositManualRingSpot {
  return (spot as MetalDepositManualRingSpot).radiusFraction !== undefined;
}

function validMetalDepositClusterConfig(
  cluster: MetalDepositClusterConfig | undefined,
): ResolvedMetalDepositClusterConfig {
  if (cluster === undefined) {
    throw new Error(
      'Metal deposit depositCluster must be authored (group-ring count/radius/angleOffset or group-manual spots)',
    );
  }
  const type = cluster.type ?? 'group-ring';
  if (type === 'group-manual') {
    const spots = (cluster as MetalDepositManualClusterConfig).spots;
    if (!Array.isArray(spots) || spots.length === 0) {
      throw new Error(
        'Metal deposit depositCluster type "group-manual" must author a non-empty spots array',
      );
    }
    const ringSpotCount = spots.filter(isMetalDepositRingSpot).length;
    if (ringSpotCount !== 0 && ringSpotCount !== spots.length) {
      throw new Error(
        'Metal deposit group-manual spots must all use ONE addressing form: either radial-frame offsets (x/y) or ring coordinates (radiusFraction/sliceOffset)',
      );
    }
    for (let i = 0; i < spots.length; i++) {
      const spot = spots[i];
      if (isMetalDepositRingSpot(spot)) {
        if (
          !Number.isFinite(spot.radiusFraction) ||
          spot.radiusFraction <= 1e-6 ||
          !Number.isFinite(spot.sliceOffset)
        ) {
          throw new Error(
            `Metal deposit group-manual ring spot ${i} must have finite radiusFraction > 0 and finite sliceOffset; received (${spot.radiusFraction}, ${spot.sliceOffset})`,
          );
        }
      } else if (!Number.isFinite(spot.x) || !Number.isFinite(spot.y)) {
        throw new Error(
          `Metal deposit group-manual spot ${i} must have finite x/y offsets; received (${spot.x}, ${spot.y})`,
        );
      }
      if (spot.dTerrainLevels !== undefined) {
        validMetalDepositDTerrainLevels(spot.dTerrainLevels);
      }
    }
    if (ringSpotCount > 0) {
      return {
        type: 'group-manual',
        spotKind: 'ring',
        spots: spots as MetalDepositManualRingSpot[],
      };
    }
    return {
      type: 'group-manual',
      spotKind: 'offsets',
      spots: spots as MetalDepositManualOffsetSpot[],
    };
  }
  if (type !== 'group-ring') {
    throw new Error(
      `Metal deposit depositCluster.type must be "group-ring" or "group-manual"; received ${String(type)}`,
    );
  }
  const ringCluster = cluster as MetalDepositRingClusterConfig;
  const count = ringCluster.count;
  const radius = ringCluster.radius;
  const angleOffset = ringCluster.angleOffset;
  if (!Number.isFinite(count) || !Number.isInteger(count) || count <= 0) {
    throw new Error(
      `Metal deposit depositCluster.count must be a positive integer; received ${count}`,
    );
  }
  if (!Number.isFinite(radius) || radius < 0) {
    throw new Error(
      `Metal deposit depositCluster.radius must be a finite non-negative number; received ${radius}`,
    );
  }
  if (count > 1 && radius <= 0) {
    throw new Error(
      'Metal deposit depositCluster.radius must be > 0 when depositCluster.count is greater than 1',
    );
  }
  if (!Number.isFinite(angleOffset)) {
    throw new Error(
      `Metal deposit depositCluster.angleOffset must be finite; received ${angleOffset}`,
    );
  }
  return { type: 'group-ring', count, radius, angleOffset };
}

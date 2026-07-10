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
  /** Signed count of METAL_DEPOSIT_STEP units above/below world height
   *  0, used as-authored regardless of the CENTER bar sign. Pass
   *  `null` to anchor the pad at the natural terrain height under the
   *  deposit's xy instead. */
  dTerrainLevels: number | null;
  /** Circular terrain-flattening diameter in fine building cells; can be
   *  larger than the resource footprint to give the extractor a clean
   *  buildable pad without increasing production area. Pass `null` to
   *  auto-size: the smallest cell count whose circular radius covers the
   *  generated resource footprint radius. */
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
  explicitHeight: number | null;
  demoAutoExtractor: boolean;
  /** Shared non-negative id for `group-manual` siblings; -1 standalone. */
  groupId: number;
};

const METAL_DEPOSIT_RING_INPUT_STRIDE = 6;
const METAL_DEPOSIT_PLACEMENT_OUTPUT_STRIDE = 15;
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
 */
export function generateMetalDeposits(
  mapWidth: number,
  mapHeight: number,
  playerCount: number,
): MetalDeposit[] {
  // Pass 1: lay out every deposit's xy + per-ring metadata. No
  // heights yet — those depend on whether the ring is explicit-height
  // (immediate) or null (sampled after explicit pads are installed).
  const placements = generateMetalDepositPlacementsFromWasm(
    mapWidth,
    mapHeight,
    playerCount,
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
      ? Math.min(p.placement.resourceRadius, p.placement.flatPadRadius)
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
};

function buildMetalDepositPackPlan(resourceRadius: number): MetalDepositPackRow[] {
  const plan: MetalDepositPackRow[] = [];
  for (const ring of METAL_DEPOSIT_CONFIG.rings) {
    const cluster = validMetalDepositClusterConfig(ring.depositCluster);
    const ringPadCells = resolveMetalDepositFlatPadCells(
      ring.flatPadCells,
      resourceRadius,
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
          flatPadCells: spot.flatPadCells === undefined
            ? ringPadCells
            : resolveMetalDepositFlatPadCells(spot.flatPadCells, resourceRadius),
          blendRadius,
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
    });
  }
  return plan;
}

function generateMetalDepositPlacementsFromWasm(
  mapWidth: number,
  mapHeight: number,
  playerCount: number,
): PendingPlacement[] {
  const sim = getRequiredSimWasm();
  const resourceCells = METAL_DEPOSIT_CONFIG.resourceCells;
  const resourceRadiusCells = getMetalDepositResourceRadiusCells(resourceCells);
  const resourceRadius = (resourceRadiusCells + 0.5) * BUILD_GRID_CELL_SIZE;
  const plan = buildMetalDepositPackPlan(resourceRadius);
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
    resourceCells,
    resourceRadiusCells,
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
    const dTerrainRaw = placementRows[base + 12];
    const explicitHeightRaw = placementRows[base + 14];
    const origin: PendingPlacement = {
      placement: makeMetalDepositPlacementFromWasmRow(placementRows, base, sourceIndex),
      dTerrainLevels: Number.isNaN(dTerrainRaw)
        ? null
        : finiteInteger(dTerrainRaw, 'metal deposit dTerrainLevels'),
      blendRadius: placementRows[base + 13],
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
        resourceRadius,
        mapWidth,
        mapHeight,
        placements,
        groupIdAllocator,
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
  resourceRadius: number,
  mapWidth: number,
  mapHeight: number,
  out: PendingPlacement[],
  groupIdAllocator: { next: number },
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
      );
      if (spot.flatPadCells !== undefined) {
        placement.flatPadRadius =
          resolveMetalDepositFlatPadCells(spot.flatPadCells, resourceRadius) *
          BUILD_GRID_CELL_SIZE * 0.5;
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
      placement: makeMetalDepositPlacementFromRawPoint(rawX, rawY, origin.placement, out.length),
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
): MetalDepositPlacement {
  const gridHalfCells = Math.floor(template.resourceCells / 2);
  const centerGx = Math.floor(rawX / BUILD_GRID_CELL_SIZE);
  const centerGy = Math.floor(rawY / BUILD_GRID_CELL_SIZE);
  const gridX = centerGx - gridHalfCells;
  const gridY = centerGy - gridHalfCells;
  const x = gridX * BUILD_GRID_CELL_SIZE + template.resourceHalfSize;
  const y = gridY * BUILD_GRID_CELL_SIZE + template.resourceHalfSize;
  const originGx = Math.floor(x / BUILD_GRID_CELL_SIZE);
  const originGy = Math.floor(y / BUILD_GRID_CELL_SIZE);
  const resourceCellCount = template.resourceCells * template.resourceCells;
  const cells = growMetalDepositResourceCells(
    originGx,
    originGy,
    resourceCellCount,
    template.resourceRadiusCells,
    hashMetalDepositSeed(originGx, originGy, seedIndex),
  );
  const bounds = getMetalDepositCellBounds(cells);
  return {
    x,
    y,
    gridX,
    gridY,
    originGx,
    originGy,
    resourceCells: template.resourceCells,
    cells,
    resourceCellCount: cells.length,
    resourceRadiusCells: template.resourceRadiusCells,
    boundsGridX: bounds.gridX,
    boundsGridY: bounds.gridY,
    boundsGridW: bounds.gridW,
    boundsGridH: bounds.gridH,
    resourceHalfSize: template.resourceHalfSize,
    resourceRadius: template.resourceRadius,
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
  }
  return ringRows;
}

function makeMetalDepositPlacementFromWasmRow(
  rows: Float64Array,
  base: number,
  seedIndex: number,
): MetalDepositPlacement {
  const x = rows[base];
  const y = rows[base + 1];
  const gridX = finiteInteger(rows[base + 2], 'metal deposit gridX');
  const gridY = finiteInteger(rows[base + 3], 'metal deposit gridY');
  const originGx = finiteInteger(rows[base + 4], 'metal deposit originGx');
  const originGy = finiteInteger(rows[base + 5], 'metal deposit originGy');
  const resourceCells = finiteInteger(rows[base + 6], 'metal deposit resourceCells');
  const resourceCellCount = finiteInteger(
    rows[base + 7],
    'metal deposit resourceCellCount',
  );
  const resourceRadiusCells = finiteInteger(
    rows[base + 8],
    'metal deposit resourceRadiusCells',
  );
  const resourceHalfSize = rows[base + 9];
  const resourceRadius = rows[base + 10];
  const flatPadRadius = rows[base + 11];
  const cells = growMetalDepositResourceCells(
    originGx,
    originGy,
    resourceCellCount,
    resourceRadiusCells,
    hashMetalDepositSeed(originGx, originGy, seedIndex),
  );
  const bounds = getMetalDepositCellBounds(cells);
  return {
    x,
    y,
    gridX,
    gridY,
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

function finiteInteger(value: number, label: string): number {
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new Error(`${label} must be a finite integer; received ${value}`);
  }
  return value;
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

function getRequiredSimWasm() {
  const sim = getSimWasm();
  if (sim === undefined) {
    throw new Error(
      'generateMetalDeposits requires sim-wasm to be initialized before terrain/deposit generation',
    );
  }
  return sim;
}

function countGridCellsInRadius(radiusCells: number): number {
  return getRequiredSimWasm().metalDepositCountResourceCandidates(radiusCells);
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

function growMetalDepositResourceCells(
  originGx: number,
  originGy: number,
  targetCellCount: number,
  radiusCells: number,
  seed: number,
): MetalDepositResourceCell[] {
  const outCells = new Int32Array(targetCellCount * 2);
  const count = getRequiredSimWasm().metalDepositGrowResourceCells(
    originGx,
    originGy,
    targetCellCount,
    radiusCells,
    seed,
    outCells,
  );
  if (count !== targetCellCount) {
    throw new Error(
      `Metal deposit resource growth returned ${count} cells; expected ${targetCellCount}`,
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

/** Resolve a ring's authored flatPadCells against the generated
 *  resource footprint. `null` auto-sizes to the smallest cell count
 *  whose circular flat-pad radius covers the footprint; an authored
 *  number must still cover it or the config is rejected. */
function resolveMetalDepositFlatPadCells(
  cells: number | null,
  resourceRadius: number,
): number {
  const requiredCells = Math.max(
    1,
    Math.ceil((resourceRadius * 2) / BUILD_GRID_CELL_SIZE),
  );
  if (cells === null) return requiredCells;
  if (!Number.isFinite(cells) || !Number.isInteger(cells) || cells <= 0) {
    throw new Error(
      `Metal deposit ring flatPadCells must be a positive integer or null; received ${cells}`,
    );
  }
  if (cells < requiredCells) {
    throw new Error(
      `Metal deposit ring flatPadCells (${cells}) must produce a circular radius >= the generated resource footprint radius (${resourceRadius.toFixed(2)} world units); author >= ${requiredCells} or null to auto-size`,
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

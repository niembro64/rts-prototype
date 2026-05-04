import { terrainShapeSign, type TerrainMapShape, type TerrainShape } from '@/types/terrain';
import { SPATIAL_GRID_CELL_SIZE } from '../../config';
import { getTerrainDividerTeamCount } from './playerLayout';
export type { TerrainShape } from '@/types/terrain';

// Terrain — deterministic heightmap generator.
//
// Returns the ground elevation at any world (x, y). The world starts
// flat at z=0 and gets a circular patch of "ripples" at the map
// center: a hand-tuned superposition of three sinusoids whose
// amplitude tapers to zero on a cosine curve as you walk outward.
// That natural height is then terraced into dTerrain plateau shelves
// with smooth ramp bands between them. Outside the ripple radius the
// terrain is exactly flat — which keeps player corner-spawns and most
// building placements untouched while giving the early game readable
// shelves, ramps, and sightline terrain.
//
// This module is a PURE FUNCTION of (x, y, mapWidth, mapHeight) so
// the client and server compute the same surface without any seed
// plumbing. When randomness is introduced (e.g. per-game noise seed)
// it must be derived from a value both sides already share — the map
// dimensions, a seeded RNG, etc. — so the heightmap stays the same
// on both sides without networking the heightmap itself.
//
// Two functions, one canonical surface:
//
//   `getTerrainHeight(x, z)` — final authored heightmap after natural
//   terrain, dTerrain terracing, and special flat-zone overrides. The
//   terrain mesh sampler and renderer call it to sample tile-corner
//   heights and the shading gradient.
//
//   `getSurfaceHeight(x, z, cellSize)` — THE one and only "what is
//   the ground at (x, z)?" answer that gameplay reads. It samples the
//   same subdivided triangle mesh that CaptureTileRenderer3D draws
//   across every tile top. Sim, physics, and client dead-reckoning
//   all call this — units, projectiles, and buildings settle on the
//   same surface the player sees.

/** Floor of the world's vertical extent — the BOTTOM face of every
 *  3D tile cube the renderer draws. Anything in the heightmap that
 *  would dip below this is clamped up to it (the math otherwise
 *  produces inverted tile geometry where the "top" is below the
 *  floor). Also the lower bound for the water level. Set in this
 *  module so every consumer (terrain, water, tile renderer) reads
 *  one canonical value. */
export const TILE_FLOOR_Y = -1200;

/** Where the water surface sits between the tile floor (0.0) and
 *  ground level Y=0 (1.0). 0.5 → halfway between TILE_FLOOR_Y and
 *  0, which is the historical hardcoded value. 0.0 disables water
 *  entirely (the surface coincides with the tile floor — no terrain
 *  ever dips below it, so isWaterAt is always false). 1.0 floods up
 *  to the ground plane. Read once at module load — runtime tweaks
 *  to the config should reload the page so client and server agree
 *  on the same surface. */
export const WATER_LEVEL_FRACTION = 0.7;

/** Water surface elevation in sim units. Linear interpolation:
 *  fraction=0 → TILE_FLOOR_Y, fraction=1 → 0. Anywhere the heightmap
 *  dips below this level, water is what's actually visible
 *  (opaque plane drawn by WaterRenderer3D); units cannot
 *  enter those cells — `isWaterAt` flags them as impassable so the
 *  thrust-application step zeros horizontal force pointing into
 *  water. */
export const WATER_LEVEL = TILE_FLOOR_Y * (1 - WATER_LEVEL_FRACTION);

// Tile tops are rendered as TERRAIN_MESH_SUBDIV x TERRAIN_MESH_SUBDIV
// sub-cells, split with the same diagonal in every sub-cell. Keep the
// value here so the host sim and all clients share the same surface
// interpolation instead of each module carrying its own copy.
export const TERRAIN_MESH_SUBDIV = 4;

/** |amplitude| in sim units when shape is 'lake' or 'mountain'.
 *  Magnitude only — the sign is picked from the shape. Tuned so a
 *  lake is deep enough to flood meaningfully under WATER_LEVEL=0.5
 *  and a mountain is tall enough to actually block sightlines. */
const TERRAIN_SHAPE_MAGNITUDE = 600;
export const TERRAIN_MAX_RENDER_Y = TERRAIN_SHAPE_MAGNITUDE * 2;

/** Vertical spacing between authored terrain plateau levels. Metal
 *  deposit rings store signed multiples of this value so extractor pads
 *  stay aligned with the same dTerrain scale as future terraced terrain. */
export const TERRAIN_D_TERRAIN = 100 * (TERRAIN_SHAPE_MAGNITUDE / 800);
/** CIRCLE-perimeter shoreline tuning (as fractions of mapMin).
 *
 *  The transition band is a smootherstep ramp from natural terrain
 *  down to TERRAIN_CIRCLE_UNDERWATER_HEIGHT. It ENDS at the
 *  inscribed-circle radius (≤0.5 × mapMin, set by `EDGE_FRACTION`,
 *  clamped at runtime to 0.5 so every side-edge midpoint of the
 *  square map sits at the underwater height in CIRCLE mode). The
 *  band runs INWARD from there by `WIDTH_FRACTION` × mapMin.
 *
 *  This is the single knob to tune the shoreline feel:
 *    0.05  — sharp / abrupt edge.
 *    0.10  — mild gradient, default.
 *    0.20+ — long gradual beach (eats into the playable area).
 *
 *  The runtime clamps width to (0, 0.5 × mapMin] so a misconfigured
 *  value can't push start outside the map or invert the band. */
export const TERRAIN_CIRCLE_PERIMETER_EDGE_FRACTION = 0.49;
export const TERRAIN_CIRCLE_PERIMETER_TRANSITION_WIDTH_FRACTION = 0.10;
export const TERRAIN_CIRCLE_UNDERWATER_HEIGHT = WATER_LEVEL - TERRAIN_D_TERRAIN;

export const TERRAIN_PLATEAU_CONFIG = {
  enabled: true,
  /** Fraction of each vertical dTerrain band that snaps flat to one
   *  of the two neighboring plateau levels. The rest of the band is a
   *  smooth ramp, so terrain stays continuous instead of stair-stepped. */
  flatFraction: 0.6,
  /** 0 = soft eased shelf edges, 1 = crisp linear ramp-to-flat edges.
   *  The same symmetric curve is used at the lower and upper plateau
   *  boundaries, so floor and top edges stay visually consistent. */
  edgeSharpness: 1,
  /** Height tolerance used by building placement when deciding whether
   *  a sampled rendered mesh point is on a plateau shelf. */
  buildHeightEpsilon: 0.5,
} as const;

/** Mutable amplitude for the central ripple zone. Negative = basin
 *  (lake), positive = peak (mountain), 0 = flat. Default 'lake'.
 *  Set via `setTerrainCenterShape`; read on the heightmap hot path
 *  by `getTerrainHeight`. */
let mountainRippleAmplitude = TERRAIN_SHAPE_MAGNITUDE;

/** Mutable peak amplitude for the team-separator ridges. Same
 *  sign convention as the central ripple. Default 'lake'. Set via
 *  `setTerrainDividersShape`. */
let mountainSeparatorAmplitude = TERRAIN_SHAPE_MAGNITUDE;
let terrainMapShape: TerrainMapShape = 'circle';

function shapeToAmplitude(shape: TerrainShape): number {
  return terrainShapeSign(shape) * TERRAIN_SHAPE_MAGNITUDE;
}

/** Monotonically-increasing token bumped whenever the heightmap's
 *  parameters change (centre amplitude, divider amplitude, team
 *  count). Caches that key off "this terrain config" — primarily
 *  the pathfinder's water / slope blocked-cell precompute — read
 *  this and invalidate when it differs from the value they
 *  recorded. Pure read, no allocation. */
let _terrainVersion = 1;
export function getTerrainVersion(): number {
  return _terrainVersion;
}

/** Apply the host's CENTER choice. Must be called BEFORE
 *  GameServer construction (which spawns buildings using
 *  getTerrainHeight) and before the renderer bakes its tile
 *  geometry. Changing it mid-game leaves stale meshes in the
 *  scene; the lobby restarts the background battle to pick up a
 *  new value. */
export function setTerrainCenterShape(shape: TerrainShape): void {
  const next = shapeToAmplitude(shape);
  if (next === mountainRippleAmplitude) return;
  mountainRippleAmplitude = next;
  _terrainVersion++;
}

/** Apply the host's DIVIDERS choice. Same lifecycle constraints
 *  as `setTerrainCenterShape`. */
export function setTerrainDividersShape(shape: TerrainShape): void {
  const next = shapeToAmplitude(shape);
  if (next === mountainSeparatorAmplitude) return;
  mountainSeparatorAmplitude = next;
  _terrainVersion++;
}

export function setTerrainMapShape(shape: TerrainMapShape): void {
  if (shape !== 'square' && shape !== 'circle') {
    throw new Error(`Unknown terrain map shape: ${shape as string}`);
  }
  if (shape === terrainMapShape) return;
  terrainMapShape = shape;
  _terrainVersion++;
}

// Ripples occupy this fraction of `min(mapWidth, mapHeight)` from
// the map center outward. With a 2000×2000 map and 0.25, the
// ripple zone is a disc of radius 500 centered on the map.
const RIPPLE_RADIUS_FRACTION = 0.4;

// Team-separator ridges grow from a flat central plain to a peak
// plateau that fills out toward the map edge. Profile (all radii
// are fractions of min(mapW, mapH)):
//
//   r ≤ RIDGE_INNER_RADIUS_FRACTION   → 0     (flat near the map centre — no ridge)
//   r between inner and outer         → linear ramp from 0 up to peak
//   r ≥ RIDGE_OUTER_RADIUS_FRACTION   → peak  (plateau, propagates to the map edge)
//
// • RIDGE_INNER_RADIUS_FRACTION (the smaller one) — the radius at
//   which the ridge starts rising. Inside it, the divider has zero
//   height so the centre of the map stays as an open arena.
// • RIDGE_OUTER_RADIUS_FRACTION — the radius at which the ridge
//   reaches peak height. The peak then propagates outward all the
//   way to the map edge — the divider mountains form a continuous
//   wall behind the team areas.
// Set inner = outer for an instant step (a sheer cliff at that
// radius); set inner = outer = 0 to plateau across the entire map.
const RIDGE_INNER_RADIUS_FRACTION = 0.1;
const RIDGE_OUTER_RADIUS_FRACTION = 0.4;

// Half-width of one divider ridge in physical sim units, expressed
// as a fraction of min(mapWidth, mapHeight). The angular cross-
// section of each ridge is a Hann window in PHYSICAL distance from
// the radial barrier line — not in angular distance — so the slope
// (height per unit distance) is uniform along the entire ridge,
// regardless of how far it is from the map centre. The earlier
// angular-Hann formulation made ridges sharp near the centre and
// gentle near the perimeter; this one keeps them looking the same
// thickness everywhere.
const RIDGE_HALF_WIDTH_FRACTION = 0.08;

// ── TEAM SEPARATION RIDGES ───────────────────────────────────────
//
// On top of the central ripple disc the heightmap can carve a radial
// barrier system that funnels each team toward the center: 2N angular
// sections (N team areas alternating with N barrier areas) and a
// mountain ridge running the full length of every barrier. Each
// ridge's height profile:
//
//   peak  =  RIDGE_PEAK_FACTOR · RIPPLE_AMPLITUDE  at r = spawnRadius
//   dips down to 0 at r = 0 (the central neutral area)
//   plateaus past the spawn radius (toward the map edge)
//
// Angularly the ridge tapers smoothly from 0 at the team-area edge
// to peak at the barrier center via a cosine ease, so the
// boundary between "open team area" and "tall mountain" is a soft
// cliff rather than a hard wall.
//
// Set the team count via `setTerrainTeamCount` once the player count
// is known (GameServer constructor for real battles, the demo battle
// initializer for the lobby). Default 0 → no ridges, equivalent to
// the pre-team-separation behavior.
let teamCount = 0;

export function setTerrainTeamCount(n: number): void {
  const next = getTerrainDividerTeamCount(n);
  if (next === teamCount) return;
  teamCount = next;
  _terrainVersion++;
}

/** Read the team-separation ridge count back. Useful for tests /
 *  diagnostics; the heightmap reads directly from the module-level
 *  `teamCount` for hot-path queries. */
export function getTerrainTeamCount(): number {
  return teamCount;
}

// ── METAL-DEPOSIT FLAT ZONES ─────────────────────────────────────
//
// Each zone is a circle on the map where the terrain is forced to a
// fixed height (`height`) so an extractor has a clean buildable pad.
// This flat pad is intentionally independent from the logical
// metal-producing resource square.
// height=0 stays at ground level; positive values raise the pad above
// natural terrain (a knoll); negative cuts a pit. Outside the circular
// radius the natural terrain (ripple + ridge) takes back over; the
// blend band eases from the circle edge outward.
//
// Set once at world init via `setMetalDepositFlatZones`; reads on
// the heightmap hot path. Empty list (default) = no flattening.

type FlatZone = {
  x: number;
  y: number;
  radius: number;
  height: number;
  blendRadius: number;
};
let depositFlatZones: ReadonlyArray<FlatZone> = [];
let depositFlatZoneBuckets = new Map<number, FlatZone[]>();
const FLAT_ZONE_BUCKET_SIZE = SPATIAL_GRID_CELL_SIZE;
const FLAT_ZONE_BUCKET_BIAS = 10000;
const FLAT_ZONE_BUCKET_BASE = 20000;

function flatZoneBucketKey(gx: number, gy: number): number {
  return (gx + FLAT_ZONE_BUCKET_BIAS) * FLAT_ZONE_BUCKET_BASE
    + (gy + FLAT_ZONE_BUCKET_BIAS);
}

function rebuildDepositFlatZoneBuckets(): void {
  const buckets = new Map<number, FlatZone[]>();
  const size = FLAT_ZONE_BUCKET_SIZE;
  for (const z of depositFlatZones) {
    const influenceRadius = z.radius + Math.max(0, z.blendRadius);
    const minGx = Math.floor((z.x - influenceRadius) / size);
    const maxGx = Math.floor((z.x + influenceRadius) / size);
    const minGy = Math.floor((z.y - influenceRadius) / size);
    const maxGy = Math.floor((z.y + influenceRadius) / size);
    for (let gx = minGx; gx <= maxGx; gx++) {
      for (let gy = minGy; gy <= maxGy; gy++) {
        const key = flatZoneBucketKey(gx, gy);
        let list = buckets.get(key);
        if (!list) {
          list = [];
          buckets.set(key, list);
        }
        list.push(z);
      }
    }
  }
  depositFlatZoneBuckets = buckets;
}

/** Install the flat zones for the current map. Call once after
 *  metal deposits are generated and BEFORE the renderer bakes its
 *  tile geometry. Pass `[]` to clear (e.g. on world reset). */
export function setMetalDepositFlatZones(zones: ReadonlyArray<FlatZone>): void {
  depositFlatZones = zones.slice();
  rebuildDepositFlatZoneBuckets();
  _terrainVersion++;
}

function getDepositFlatZoneCandidates(x: number, y: number): readonly FlatZone[] {
  if (depositFlatZoneBuckets.size === 0) return [];
  const gx = Math.floor(x / FLAT_ZONE_BUCKET_SIZE);
  const gy = Math.floor(y / FLAT_ZONE_BUCKET_SIZE);
  return depositFlatZoneBuckets.get(flatZoneBucketKey(gx, gy)) ?? [];
}

function findDepositFlatZoneAt(x: number, y: number): FlatZone | null {
  const candidates = getDepositFlatZoneCandidates(x, y);
  for (const z of candidates) {
    const dx = x - z.x;
    const dy = y - z.y;
    if (dx * dx + dy * dy <= z.radius * z.radius) return z;
  }
  return null;
}

/** Find the deposit override at sample point (x, y).
 *  Returns blend weight w (0 = fully deposit, 1 = fully natural)
 *  and the deposit's target height. When no zone affects the sample,
 *  weight is 1 and height is irrelevant — the caller uses the
 *  natural value untouched. */
function depositOverride(
  x: number,
  y: number,
): { weight: number; height: number } {
  if (depositFlatZones.length === 0) return { weight: 1, height: 0 };
  const candidates = getDepositFlatZoneCandidates(x, y);
  if (candidates.length === 0) return { weight: 1, height: 0 };
  let minWeight = 1;
  let bestHeight = 0;
  for (const z of candidates) {
    const dx = x - z.x;
    const dy = y - z.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d <= z.radius) return { weight: 0, height: z.height };
    const blendRadius = Math.max(0, z.blendRadius);
    if (blendRadius > 0 && d < z.radius + blendRadius) {
      const t = (d - z.radius) / blendRadius;
      const w = (1 - Math.cos(t * Math.PI)) * 0.5;
      if (w < minWeight) {
        minWeight = w;
        bestHeight = z.height;
      }
    }
  }
  return { weight: minWeight, height: bestHeight };
}
// Wavelengths for the three sinusoids that combine into the
// ripple pattern. Mixing irrational ratios prevents the layers
// from harmonizing into a clean grid.
const RIPPLE_W1 = 200;
const RIPPLE_W2 = 600;
const RIPPLE_W3 = 600;
// Phase offset on the second sinusoid so the bumps don't all
// peak at the same dist value.
const RIPPLE_PHASE = 1.7;

function smootherstep(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function clamp01(value: number): number {
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function plateauRampCurve(t: number): number {
  const smooth = smootherstep(t);
  const sharpness = clamp01(TERRAIN_PLATEAU_CONFIG.edgeSharpness);
  return smooth + (t - smooth) * sharpness;
}

function applyTerrainPlateaus(height: number): number {
  if (!TERRAIN_PLATEAU_CONFIG.enabled || !Number.isFinite(height))
    return height;
  const step = TERRAIN_D_TERRAIN;
  if (step <= 0) return height;

  const flatHalf = Math.min(
    0.49,
    Math.max(0, TERRAIN_PLATEAU_CONFIG.flatFraction * 0.5),
  );
  const q = height / step;
  const lowerLevel = Math.floor(q);
  const t = q - lowerLevel;
  if (t <= flatHalf) return lowerLevel * step;
  if (t >= 1 - flatHalf) return (lowerLevel + 1) * step;

  const rampT = (t - flatHalf) / Math.max(1e-6, 1 - flatHalf * 2);
  return (lowerLevel + plateauRampCurve(rampT)) * step;
}

function getTerrainCircleEndRadius(mapWidth: number, mapHeight: number): number {
  const minDim = Math.min(mapWidth, mapHeight);
  const maxEndRadius = minDim * 0.5;
  return Math.max(
    1,
    Math.min(
      maxEndRadius,
      minDim * TERRAIN_CIRCLE_PERIMETER_EDGE_FRACTION,
    ),
  );
}

function getTerrainCircleStartRadius(
  mapWidth: number,
  mapHeight: number,
  endRadius: number,
): number {
  const minDim = Math.min(mapWidth, mapHeight);
  // Width derived from the single tuning knob. Clamp to (0,
  // endRadius − 1] so a misconfigured value can't invert the band
  // or push start outside the map.
  const maxWidth = Math.max(0, endRadius - 1);
  const desiredWidth =
    minDim * Math.max(0, TERRAIN_CIRCLE_PERIMETER_TRANSITION_WIDTH_FRACTION);
  const width = Math.min(maxWidth, desiredWidth);
  return Math.max(0, endRadius - width);
}

export function getTerrainMapBoundaryFade(
  x: number,
  y: number,
  mapWidth: number,
  mapHeight: number,
): number {
  if (terrainMapShape !== 'circle') return 0;
  const endRadius = getTerrainCircleEndRadius(mapWidth, mapHeight);
  const startRadius = getTerrainCircleStartRadius(mapWidth, mapHeight, endRadius);
  const dx = x - mapWidth / 2;
  const dy = y - mapHeight / 2;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist <= startRadius) return 0;
  if (dist >= endRadius) return 1;

  return smootherstep(clamp01((dist - startRadius) / (endRadius - startRadius)));
}

function applyTerrainMapBoundary(
  height: number,
  x: number,
  y: number,
  mapWidth: number,
  mapHeight: number,
): number {
  const w = getTerrainMapBoundaryFade(x, y, mapWidth, mapHeight);
  if (w <= 0) return height;
  if (w >= 1) return TERRAIN_CIRCLE_UNDERWATER_HEIGHT;
  return height + (TERRAIN_CIRCLE_UNDERWATER_HEIGHT - height) * w;
}

/** Final authored terrain height at world point (x, y): natural
 *  central ripple disc + radial team-separation ridges, terraced into
 *  dTerrain plateaus, then locally overridden by special flat zones. */
export function getTerrainHeight(
  x: number,
  y: number,
  mapWidth: number,
  mapHeight: number,
): number {
  const cxw = mapWidth / 2;
  const cyw = mapHeight / 2;
  const dx = x - cxw;
  const dy = y - cyw;
  const dist = Math.sqrt(dx * dx + dy * dy);

  // ── Central ripple component ────────────────────────────────────
  let ripple = 0;
  const maxDist = Math.min(mapWidth, mapHeight) * RIPPLE_RADIUS_FRACTION;
  if (dist < maxDist && maxDist > 0) {
    // Cosine fade: 1 at center, 0 at the ripple edge.
    const fadeT = (dist / maxDist) * (Math.PI / 2);
    const fade = Math.cos(fadeT);
    // Three sinusoids in dist + a directional ridge. Sum lives in
    // roughly [-1, +1]; normalize into [0, 1] so tiles never produce
    // negative heights.
    const a = Math.cos(dist / RIPPLE_W1);
    const b = Math.cos(dist / RIPPLE_W2 + RIPPLE_PHASE);
    const c = Math.sin((dx + dy) / RIPPLE_W3);
    const sum = a * 0.5 + b * 0.3 + c * 0.2;
    const norm = (sum + 1) * 0.5;
    ripple = mountainRippleAmplitude * fade * norm;
  }

  // ── Team-separation ridge component ─────────────────────────────
  let ridge = 0;
  if (teamCount > 0 && dist > 0) {
    const theta = Math.atan2(dy, dx);
    // Pattern: team_center → barrier_center → next team_center
    // repeats every 2π/N. Within one cycle:
    //   pos = 0          → team area center (player base angle)
    //   pos = cycle/2    → barrier (mountain ridge) center
    //   pos = cycle      → next team center
    // Player 0 is anchored at theta = -π/4 by spawn.ts'
    // getPlayerBaseAngle (FIRST_PLAYER_ANGLE = -π/2 + π/4 = -π/4), so
    // we phase-shift by +π/4 to make pos=0 coincide with player 0.
    // Net effect with teamCount=4: team-area arcs sit at the four
    // corners and divider ridges run along the four cardinal
    // directions, so each team's back is to a corner of the map.
    const cycle = (2 * Math.PI) / teamCount;
    let pos = (theta + Math.PI / 4) % cycle;
    if (pos < 0) pos += cycle;
    const barrierMid = cycle / 2;
    const distFromBarrierCenter = Math.abs(pos - barrierMid);

    // Cross-section profile: RAISED COSINE half-wave (Hann window),
    //   f(t) = (1 + cos(πt)) / 2
    // — peak = 1 at the barrier centreline (t=0), 0 at the ridge's
    // outer edge (t=1). The Hann is keyed off PHYSICAL perpendicular
    // distance to the radial barrier RAY, so the slope of the mountain
    // (height per unit distance) is the same everywhere along its
    // length without treating the opposite ray as another divider.
    //
    // The old line-distance form used `dist * sin(angleDelta)` and
    // therefore matched both directions of the same infinite line.
    // With teamCount=1 that put a second valley/ridge through the
    // player's own slice. Projecting onto the divider ray keeps the
    // same math for every player count while giving each divider one
    // start and one end.
    const minDim = Math.min(mapWidth, mapHeight);
    const halfWidth = minDim * RIDGE_HALF_WIDTH_FRACTION;
    const alongDist = dist * Math.cos(distFromBarrierCenter);
    const perpDist = dist * Math.sin(distFromBarrierCenter);
    if (alongDist > 0 && perpDist < halfWidth) {
      const widthT = perpDist / halfWidth; // 0..1
      const angFalloff = (1 + Math.cos(widthT * Math.PI)) * 0.5;
      // Radial profile — see RIDGE_INNER_RADIUS_FRACTION /
      // RIDGE_OUTER_RADIUS_FRACTION up top.
      const innerR = minDim * RIDGE_INNER_RADIUS_FRACTION;
      const outerR = minDim * RIDGE_OUTER_RADIUS_FRACTION;
      let radT: number;
      if (alongDist >= outerR) {
        // Peak plateau — propagates outward to the map edge.
        radT = 1;
      } else if (alongDist <= innerR) {
        // Flat inner plain — no ridge near the map centre.
        radT = 0;
      } else {
        // Ramp from 0 at innerR up to 1 at outerR.
        const span = outerR - innerR;
        radT = span > 0 ? (alongDist - innerR) / span : 1;
      }
      ridge = mountainSeparatorAmplitude * angFalloff * radT;
    }
  }

  // Terracing happens after the natural terrain math, but before
  // special flat zones. That gives the map clean buildable shelves
  // while preserving exact authored pads for metal deposits.
  const natural = ripple + ridge;
  const terraced = applyTerrainPlateaus(natural);

  // Apply the map-boundary shaping (e.g. circle perimeter sinking the
  // edge below water) to the NATURAL terraced terrain BEFORE the
  // deposit override blend. Doing this in the other order — boundary
  // shaping after the deposit blend — distorts any pad whose center
  // sits past `startRadius`, pulling its samples toward the
  // underwater target via the smootherstep ramp. That makes
  // `isBuildableTerrainFootprint` reject extractors on outer-ring
  // deposits (footprint samples come back at varying heights → no
  // consistent plateau level), so the demo battle can't build
  // extractors on the outermost deposit ring under the circle
  // perimeter. Applying the boundary first, then blending the pad
  // over it, lets the pad's exact authored height win inside its
  // radius regardless of perimeter shape.
  const terracedShaped = applyTerrainMapBoundary(
    terraced,
    x,
    y,
    mapWidth,
    mapHeight,
  );

  // Metal-deposit flat zones override BOTH ripple and ridge: inside
  // each circular flat pad the terrain is forced to the ring's
  // dTerrain-derived `height`. Outside the falloff band the weight is
  // 1 (terraced terrain), so this is a pass-through for every map
  // sample that isn't near a deposit.
  const override = depositOverride(x, y);
  const blended =
    override.height * (1 - override.weight) + terracedShaped * override.weight;

  // Clamp to the tile floor — the heightmap defines the TOP of every
  // 3D tile cube and tiles can't physically extend below their floor.
  // Without this clamp, a strongly-negative amplitude (e.g. carved
  // trenches) would invert the tile geometry: top vertex lower than
  // floor vertex, faces flipped, sides facing inward.
  return Math.max(TILE_FLOOR_Y, blended);
}

type TerrainMeshSample = {
  u: number;
  v: number;
  subSize: number;
  h00: number;
  h10: number;
  h11: number;
  h01: number;
};

function terrainCellSize(cellSize: number | undefined): number {
  return cellSize !== undefined && cellSize > 0
    ? cellSize
    : SPATIAL_GRID_CELL_SIZE;
}

function clampToMeshExtent(
  value: number,
  cells: number,
  cellSize: number,
): number {
  const max = cells * cellSize;
  if (value <= 0) return 0;
  if (value >= max) return max;
  return value;
}

function getTerrainMeshSample(
  x: number,
  z: number,
  mapWidth: number,
  mapHeight: number,
  cellSize: number = SPATIAL_GRID_CELL_SIZE,
): TerrainMeshSample {
  const size = terrainCellSize(cellSize);
  const cellsX = Math.max(1, Math.ceil(mapWidth / size));
  const cellsZ = Math.max(1, Math.ceil(mapHeight / size));
  const px = clampToMeshExtent(x, cellsX, size);
  const pz = clampToMeshExtent(z, cellsZ, size);
  const cellX = Math.min(cellsX - 1, Math.max(0, Math.floor(px / size)));
  const cellZ = Math.min(cellsZ - 1, Math.max(0, Math.floor(pz / size)));
  const subSize = size / TERRAIN_MESH_SUBDIV;
  const localX = px - cellX * size;
  const localZ = pz - cellZ * size;
  const subX = Math.min(
    TERRAIN_MESH_SUBDIV - 1,
    Math.max(0, Math.floor(localX / subSize)),
  );
  const subZ = Math.min(
    TERRAIN_MESH_SUBDIV - 1,
    Math.max(0, Math.floor(localZ / subSize)),
  );
  const x0 = cellX * size + subX * subSize;
  const z0 = cellZ * size + subZ * subSize;
  const x1 = x0 + subSize;
  const z1 = z0 + subSize;
  const u = Math.max(0, Math.min(1, (px - x0) / subSize));
  const v = Math.max(0, Math.min(1, (pz - z0) / subSize));

  return {
    u,
    v,
    subSize,
    h00: getTerrainHeight(x0, z0, mapWidth, mapHeight),
    h10: getTerrainHeight(x1, z0, mapWidth, mapHeight),
    h11: getTerrainHeight(x1, z1, mapWidth, mapHeight),
    h01: getTerrainHeight(x0, z1, mapWidth, mapHeight),
  };
}

function terrainMeshHeightFromSample(sample: TerrainMeshSample): number {
  const { u, v, h00, h10, h11, h01 } = sample;
  if (u >= v) {
    return (1 - u) * h00 + (u - v) * h10 + v * h11;
  }
  return (1 - v) * h00 + u * h11 + (v - u) * h01;
}

function terrainMeshNormalFromSample(sample: TerrainMeshSample): {
  nx: number;
  ny: number;
  nz: number;
} {
  const { u, v, subSize, h00, h10, h11, h01 } = sample;
  const dHdx = u >= v ? (h10 - h00) / subSize : (h11 - h01) / subSize;
  const dHdz = u >= v ? (h11 - h10) / subSize : (h01 - h00) / subSize;
  const nx = -dHdx;
  const ny = -dHdz;
  const nz = 1;
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
  return { nx: nx / len, ny: ny / len, nz: nz / len };
}

/** Raw terrain height on the exact triangle mesh drawn by
 *  CaptureTileRenderer3D. Use this when code needs the rendered
 *  ground surface instead of the underlying continuous height field. */
export function getTerrainMeshHeight(
  x: number,
  z: number,
  mapWidth: number,
  mapHeight: number,
  cellSize: number = SPATIAL_GRID_CELL_SIZE,
): number {
  return terrainMeshHeightFromSample(
    getTerrainMeshSample(x, z, mapWidth, mapHeight, cellSize),
  );
}

export function getTerrainMeshNormal(
  x: number,
  z: number,
  mapWidth: number,
  mapHeight: number,
  cellSize: number = SPATIAL_GRID_CELL_SIZE,
): { nx: number; ny: number; nz: number } {
  return terrainMeshNormalFromSample(
    getTerrainMeshSample(x, z, mapWidth, mapHeight, cellSize),
  );
}

export function getTerrainPlateauLevelAt(
  x: number,
  z: number,
  mapWidth: number,
  mapHeight: number,
  cellSize: number = SPATIAL_GRID_CELL_SIZE,
): number | null {
  if (!TERRAIN_PLATEAU_CONFIG.enabled) return 0;
  const step = TERRAIN_D_TERRAIN;
  if (step <= 0) return 0;
  const flatZone = findDepositFlatZoneAt(x, z);
  const height = flatZone
    ? flatZone.height
    : getTerrainMeshHeight(x, z, mapWidth, mapHeight, cellSize);
  const level = Math.round(height / step);
  return Math.abs(height - level * step) <=
    TERRAIN_PLATEAU_CONFIG.buildHeightEpsilon
    ? level
    : null;
}

/** Authoritative terrain buildability check for rectangular building
 *  footprints. A footprint is buildable only if all sampled points are
 *  dry, on plateau flats, and on the same dTerrain level. Ramps between
 *  plateaus remain traversable terrain, but are not build pads. */
export function isBuildableTerrainFootprint(
  centerX: number,
  centerZ: number,
  halfWidth: number,
  halfDepth: number,
  mapWidth: number,
  mapHeight: number,
  cellSize: number = SPATIAL_GRID_CELL_SIZE,
): boolean {
  const rx = Math.max(0, halfWidth - 1);
  const rz = Math.max(0, halfDepth - 1);
  const samples: [number, number][] = [
    [centerX, centerZ],
    [centerX - rx, centerZ - rz],
    [centerX + rx, centerZ - rz],
    [centerX - rx, centerZ + rz],
    [centerX + rx, centerZ + rz],
    [centerX, centerZ - rz],
    [centerX, centerZ + rz],
    [centerX - rx, centerZ],
    [centerX + rx, centerZ],
  ];

  let footprintLevel: number | null = null;
  for (const [sx, sz] of samples) {
    if (isWaterAt(sx, sz, mapWidth, mapHeight, cellSize)) return false;
    const level = getTerrainPlateauLevelAt(
      sx,
      sz,
      mapWidth,
      mapHeight,
      cellSize,
    );
    if (level === null) return false;
    if (footprintLevel === null) {
      footprintLevel = level;
    } else if (level !== footprintLevel) {
      return false;
    }
  }
  return true;
}

/** Step size for the finite-difference gradient used by visual-only
 *  normals that intentionally read the continuous heightmap. */
const NORMAL_GRADIENT_EPS = 1;

/** Surface-tangent normal at world point (x, z) in SIM coords (z is
 *  up). This is the normal of the same subdivided terrain triangle
 *  that CaptureTileRenderer3D draws. Water samples still return flat
 *  up so the water plane never tilts units.
 *
 *  Why: at the shoreline, a unit's body straddles dry-land and
 *  below-water cells. With water-clamped sampling, the +eps and
 *  −eps samples land on different surfaces (one on rising land,
 *  one on the flat water plane). Tiny position oscillations from
 *  physics integration flip whether the cross-axis sample lands
 *  on water or land, so the gradient flickers and the unit's
 *  rendered chassis jitters between "leaning down toward water"
 *  and "level with water". The user's complaint: a unit on the
 *  rim of a lake never wants to tilt because of the water; if it
 *  has a tilt at all it should reflect the LAND alone.
 *
 *  Outside the ripple disc the sampled mesh is exactly flat, so the
 *  normal collapses to (0, 0, 1) immediately. */
export function getSurfaceNormal(
  x: number,
  z: number,
  mapWidth: number,
  mapHeight: number,
  cellSize: number = SPATIAL_GRID_CELL_SIZE,
): { nx: number; ny: number; nz: number } {
  const sample = getTerrainMeshSample(x, z, mapWidth, mapHeight, cellSize);
  const h0 = terrainMeshHeightFromSample(sample);

  // Centre-sample mesh terrain. If the centre is itself in water,
  // the unit either is currently being pushed out by the water-
  // pusher (transient), or this normal is being asked for at a
  // point where there isn't really a unit (e.g. projectile splash).
  // Either way returning the flat normal is the right answer:
  // water surface is flat; a unit standing on it should not tilt.
  if (h0 < WATER_LEVEL) return { nx: 0, ny: 0, nz: 1 };
  return terrainMeshNormalFromSample(sample);
}

/** Visual-only ground normal at world point (x, z) in SIM coords.
 *  Never returns the flat WATER normal — it always reflects the
 *  underlying LAND gradient, regardless of whether the centre sample
 *  is below WATER_LEVEL.
 *
 *  Why a separate function: `getSurfaceNormal` has a water-aware
 *  branch that is correct for the SIM — physics body tilt, knockback
 *  projection, capture-cell occupancy. But on the rendered chassis
 *  that branch manifests as a hard switch at the shoreline: one frame
 *  a unit's centre samples 0.001 above WATER_LEVEL → tilted, next
 *  frame it dips 0.001 below → flat. Users see this as visible
 *  chassis flicker.
 *
 *  This visual variant always uses centered finite differences over
 *  the raw heightmap, so the rendered tilt is a continuous function
 *  of position. Units on shoreline tiles tilt with the ground beneath
 *  them, never with the water above. Sim/physics paths must KEEP
 *  using `getSurfaceNormal`; only renderers should call this. */
export function getGroundNormal(
  x: number,
  z: number,
  mapWidth: number,
  mapHeight: number,
): { nx: number; ny: number; nz: number } {
  const eps = NORMAL_GRADIENT_EPS;
  const hxp = getTerrainHeight(x + eps, z, mapWidth, mapHeight);
  const hxm = getTerrainHeight(x - eps, z, mapWidth, mapHeight);
  const hzp = getTerrainHeight(x, z + eps, mapWidth, mapHeight);
  const hzm = getTerrainHeight(x, z - eps, mapWidth, mapHeight);
  const dHdx = (hxp - hxm) / (2 * eps);
  const dHdz = (hzp - hzm) / (2 * eps);
  const nx = -dHdx;
  const ny = -dHdz;
  const nz = 1;
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
  return { nx: nx / len, ny: ny / len, nz: nz / len };
}

/** Project a horizontal direction (hx, hy) onto the local surface
 *  tangent plane, returning a UNIT vector along the slope. Used by
 *  the physics force pass so a unit driving "north" on a north-rising
 *  hill produces a north-AND-up force tangent to the slope, not a
 *  flat-horizontal force that pushes the unit through the ground.
 *
 *  Math: tangent = horizontal − (horizontal · n) · n, then
 *  normalized. Flat ground (n = (0, 0, 1)) collapses to a
 *  pass-through with z = 0 and (x, y) = (hx, hy) unchanged.
 *
 *  `hx`, `hy` should already be the unit-magnitude horizontal
 *  direction the action system wants — the magnitude returned here
 *  is always 1, and the caller multiplies by `thrustMagnitude`. */
export function projectHorizontalOntoSlope(
  hx: number,
  hy: number,
  n: { nx: number; ny: number; nz: number },
): { x: number; y: number; z: number } {
  const dot = hx * n.nx + hy * n.ny; // horizontal hz = 0 cancels out
  const tx = hx - dot * n.nx;
  const ty = hy - dot * n.ny;
  const tz = -dot * n.nz;
  const m = Math.sqrt(tx * tx + ty * ty + tz * tz) || 1;
  return { x: tx / m, y: ty / m, z: tz / m };
}

/** Apply the surface tilt rotation (the one that takes sim's +Z up
 *  vector to the surface normal `n`) to a 3D vector `v`. Used by the
 *  sim to compute the world position of a turret mount that sits on
 *  the tilted chassis surface, so projectile spawn coords agree
 *  pixel-perfect with the renderer's tilted mesh hierarchy.
 *
 *  Rodrigues' rotation around axis k = (0,0,1) × n / |…| by angle θ
 *  with cos θ = n.z, sin θ = √(n.x² + n.y²). Flat-ground fast path
 *  early-returns on |sin θ|² < epsilon so units outside the ripple
 *  disc pay nothing. */
export function applySurfaceTilt(
  vx: number,
  vy: number,
  vz: number,
  n: { nx: number; ny: number; nz: number },
): { x: number; y: number; z: number } {
  const sinT2 = n.nx * n.nx + n.ny * n.ny;
  if (sinT2 < 1e-12) return { x: vx, y: vy, z: vz };
  const sinT = Math.sqrt(sinT2);
  const cosT = n.nz;
  // Unit rotation axis in sim coords: (-ny, nx, 0) normalized.
  const kx = -n.ny / sinT;
  const ky = n.nx / sinT;
  // (k · v) — k_z is 0, so this is kx·vx + ky·vy.
  const kdotv = kx * vx + ky * vy;
  // (k × v) with k_z = 0: (ky·vz, -kx·vz, kx·vy − ky·vx).
  const crossX = ky * vz;
  const crossY = -kx * vz;
  const crossZ = kx * vy - ky * vx;
  const oneMinusCos = 1 - cosT;
  return {
    x: vx * cosT + crossX * sinT + kx * kdotv * oneMinusCos,
    y: vy * cosT + crossY * sinT + ky * kdotv * oneMinusCos,
    z: vz * cosT + crossZ * sinT,
  };
}

/** Canonical ground-surface height at world point (x, z) — what the
 *  PHYSICS sees as "the ground" everywhere on the map. Returns the
 *  rendered terrain-mesh value, but clamped UP to WATER_LEVEL:
 *  anywhere the terrain dips below the water surface, the water
 *  plane is what units walk on.
 *
 *  The RENDERER (CaptureTileRenderer3D) reads `getTerrainHeight`
 *  directly so it can draw the actual carved terrain below the
 *  water; WaterRenderer3D draws an opaque flat plane on top at
 *  WATER_LEVEL. The combination gives the visual: deep terrain
 *  → submerged below water; shallow / above-water terrain → dry
 *  land. Physics treats both cases uniformly: the unit's "ground"
 *  is whichever surface is on top.
 *
 *  `cellSize` must match the capture/spatial tile size used by
 *  CaptureTileRenderer3D; callers normally pass SPATIAL_GRID_CELL_SIZE
 *  or omit it for that default. */
export function getSurfaceHeight(
  x: number,
  z: number,
  mapWidth: number,
  mapHeight: number,
  cellSize: number = SPATIAL_GRID_CELL_SIZE,
): number {
  return Math.max(
    WATER_LEVEL,
    getTerrainMeshHeight(x, z, mapWidth, mapHeight, cellSize),
  );
}

/** True iff (x, z) is over water — i.e. the rendered terrain mesh
 *  dips below the water surface. Used by movement and building
 *  placement to treat water cells as impassable. With
 *  WATER_LEVEL_FRACTION=0 (water at the tile floor) this always
 *  returns false. */
export function isWaterAt(
  x: number,
  z: number,
  mapWidth: number,
  mapHeight: number,
  cellSize: number = SPATIAL_GRID_CELL_SIZE,
): boolean {
  const flatZone = findDepositFlatZoneAt(x, z);
  if (flatZone) return flatZone.height < WATER_LEVEL;
  return (
    getTerrainMeshHeight(x, z, mapWidth, mapHeight, cellSize) < WATER_LEVEL
  );
}

/** Number of cardinal points sampled around the candidate when
 *  testing water clearance. 8 catches concave shorelines that a
 *  single-point check at the center would skip. */
const WATER_CLEARANCE_SAMPLES = 8;

/** True iff (x, z) is on dry land AND no point within `bufferPx`
 *  of (x, z) is water. Used by the demo-game spawner so initial
 *  units land safely away from the shoreline (the unit's collision
 *  radius + a little slack). With WATER_LEVEL_FRACTION=0 this
 *  collapses to "always true" since `isWaterAt` is always false. */
export function isFarFromWater(
  x: number,
  z: number,
  mapWidth: number,
  mapHeight: number,
  bufferPx: number,
): boolean {
  if (isWaterAt(x, z, mapWidth, mapHeight)) return false;
  if (bufferPx <= 0) return true;
  for (let i = 0; i < WATER_CLEARANCE_SAMPLES; i++) {
    const a = (i / WATER_CLEARANCE_SAMPLES) * Math.PI * 2;
    const px = x + Math.cos(a) * bufferPx;
    const pz = z + Math.sin(a) * bufferPx;
    if (isWaterAt(px, pz, mapWidth, mapHeight)) return false;
  }
  return true;
}

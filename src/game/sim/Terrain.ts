import type { TerrainShape } from '@/types/terrain';
import { SPATIAL_GRID_CELL_SIZE } from '../../config';
export type { TerrainShape } from '@/types/terrain';

// Terrain — deterministic heightmap generator.
//
// Returns the ground elevation at any world (x, y). The world starts
// flat at z=0 and gets a circular patch of "ripples" at the map
// center: a hand-tuned superposition of three sinusoids whose
// amplitude tapers to zero on a cosine curve as you walk outward.
// Outside the ripple radius the terrain is exactly flat — which keeps
// player corner-spawns and most building placements untouched while
// giving the early game a piece of interesting topography to fly over
// and shoot through.
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
//   `getTerrainHeight(x, z)` — raw continuous heightmap. The terrain
//   mesh sampler and renderer call it to sample tile-corner heights
//   and the shading gradient.
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
export const WATER_LEVEL_FRACTION = 0.6;

/** Water surface elevation in sim units. Linear interpolation:
 *  fraction=0 → TILE_FLOOR_Y, fraction=1 → 0. Anywhere the heightmap
 *  dips below this level, water is what's actually visible
 *  (semi-transparent plane drawn by WaterRenderer3D); units cannot
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
const TERRAIN_SHAPE_MAGNITUDE = 750;
export const TERRAIN_MAX_RENDER_Y = TERRAIN_SHAPE_MAGNITUDE * 2;

/** Mutable amplitude for the central ripple zone. Negative = basin
 *  (lake), positive = peak (mountain), 0 = flat. Default 'lake'.
 *  Set via `setTerrainCenterShape`; read on the heightmap hot path
 *  by `getTerrainHeight`. */
let mountainRippleAmplitude = TERRAIN_SHAPE_MAGNITUDE;

/** Mutable peak amplitude for the team-separator ridges. Same
 *  sign convention as the central ripple. Default 'lake'. Set via
 *  `setTerrainDividersShape`. */
let mountainSeparatorAmplitude = TERRAIN_SHAPE_MAGNITUDE;

function shapeToAmplitude(shape: TerrainShape): number {
  switch (shape) {
    case 'lake': return -TERRAIN_SHAPE_MAGNITUDE;
    case 'mountain': return TERRAIN_SHAPE_MAGNITUDE;
    case 'flat': return 0;
    default: throw new Error(`Unknown terrain shape: ${shape as string}`);
  }
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
  const next = Math.max(0, n | 0);
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
// Wavelengths for the three sinusoids that combine into the
// ripple pattern. Mixing irrational ratios prevents the layers
// from harmonizing into a clean grid.
const RIPPLE_W1 = 200;
const RIPPLE_W2 = 600;
const RIPPLE_W3 = 600;
// Phase offset on the second sinusoid so the bumps don't all
// peak at the same dist value.
const RIPPLE_PHASE = 1.7;

/** Raw continuous terrain height at world point (x, y) =
 *  central ripple disc + radial team-separation ridges. Always ≥ 0. */
export function getTerrainHeight(
  x: number, y: number,
  mapWidth: number, mapHeight: number,
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
    const sum = (a * 0.5 + b * 0.3 + c * 0.2);
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
    // distance to the radial barrier line, so the slope of the
    // mountain (height per unit distance) is the same everywhere
    // along its length — no more "sharp at the centre, gentle at
    // the edge" artifact from the old angular-Hann formulation.
    const minDim = Math.min(mapWidth, mapHeight);
    const halfWidth = minDim * RIDGE_HALF_WIDTH_FRACTION;
    const perpDist = dist * Math.sin(distFromBarrierCenter);
    if (perpDist < halfWidth) {
      const widthT = perpDist / halfWidth; // 0..1
      const angFalloff = (1 + Math.cos(widthT * Math.PI)) * 0.5;
      // Radial profile — see RIDGE_INNER_RADIUS_FRACTION /
      // RIDGE_OUTER_RADIUS_FRACTION up top.
      const innerR = minDim * RIDGE_INNER_RADIUS_FRACTION;
      const outerR = minDim * RIDGE_OUTER_RADIUS_FRACTION;
      let radT: number;
      if (dist >= outerR) {
        // Peak plateau — propagates outward to the map edge.
        radT = 1;
      } else if (dist <= innerR) {
        // Flat inner plain — no ridge near the map centre.
        radT = 0;
      } else {
        // Ramp from 0 at innerR up to 1 at outerR.
        const span = outerR - innerR;
        radT = span > 0 ? (dist - innerR) / span : 1;
      }
      ridge = mountainSeparatorAmplitude * angFalloff * radT;
    }
  }

  // Clamp to the tile floor — the heightmap defines the TOP of every
  // 3D tile cube and tiles can't physically extend below their floor.
  // Without this clamp, a strongly-negative amplitude (e.g. carved
  // trenches) would invert the tile geometry: top vertex lower than
  // floor vertex, faces flipped, sides facing inward.
  return Math.max(TILE_FLOOR_Y, ripple + ridge);
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
  return cellSize !== undefined && cellSize > 0 ? cellSize : SPATIAL_GRID_CELL_SIZE;
}

function clampToMeshExtent(value: number, cells: number, cellSize: number): number {
  const max = cells * cellSize;
  if (value <= 0) return 0;
  if (value >= max) return max;
  return value;
}

function getTerrainMeshSample(
  x: number, z: number,
  mapWidth: number, mapHeight: number,
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

function terrainMeshNormalFromSample(sample: TerrainMeshSample): { nx: number; ny: number; nz: number } {
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
  x: number, z: number,
  mapWidth: number, mapHeight: number,
  cellSize: number = SPATIAL_GRID_CELL_SIZE,
): number {
  return terrainMeshHeightFromSample(
    getTerrainMeshSample(x, z, mapWidth, mapHeight, cellSize),
  );
}

export function getTerrainMeshNormal(
  x: number, z: number,
  mapWidth: number, mapHeight: number,
  cellSize: number = SPATIAL_GRID_CELL_SIZE,
): { nx: number; ny: number; nz: number } {
  return terrainMeshNormalFromSample(
    getTerrainMeshSample(x, z, mapWidth, mapHeight, cellSize),
  );
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
  x: number, z: number,
  mapWidth: number, mapHeight: number,
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
  x: number, z: number,
  mapWidth: number, mapHeight: number,
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
  hx: number, hy: number,
  n: { nx: number; ny: number; nz: number },
): { x: number; y: number; z: number } {
  const dot = hx * n.nx + hy * n.ny;  // horizontal hz = 0 cancels out
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
  vx: number, vy: number, vz: number,
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
 *  water; WaterRenderer3D draws a translucent flat plane on top at
 *  WATER_LEVEL. The combination gives the visual: deep terrain
 *  → submerged below water; shallow / above-water terrain → dry
 *  land. Physics treats both cases uniformly: the unit's "ground"
 *  is whichever surface is on top.
 *
 *  `cellSize` must match the capture/spatial tile size used by
 *  CaptureTileRenderer3D; callers normally pass SPATIAL_GRID_CELL_SIZE
 *  or omit it for that default. */
export function getSurfaceHeight(
  x: number, z: number,
  mapWidth: number, mapHeight: number,
  cellSize: number = SPATIAL_GRID_CELL_SIZE,
): number {
  return Math.max(WATER_LEVEL, getTerrainMeshHeight(x, z, mapWidth, mapHeight, cellSize));
}

/** True iff (x, z) is over water — i.e. the rendered terrain mesh
 *  dips below the water surface. Used by movement and building
 *  placement to treat water cells as impassable. With
 *  WATER_LEVEL_FRACTION=0 (water at the tile floor) this always
 *  returns false. */
export function isWaterAt(
  x: number, z: number,
  mapWidth: number, mapHeight: number,
  cellSize: number = SPATIAL_GRID_CELL_SIZE,
): boolean {
  return getTerrainMeshHeight(x, z, mapWidth, mapHeight, cellSize) < WATER_LEVEL;
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
  x: number, z: number,
  mapWidth: number, mapHeight: number,
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

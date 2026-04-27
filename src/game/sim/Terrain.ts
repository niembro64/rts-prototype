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
//   `getTerrainHeight(x, z)` — raw continuous heightmap. ONLY the
//   renderer calls it directly, to sample tile-corner heights and
//   the shading gradient.
//
//   `getSurfaceHeight(x, z, cellSize)` — THE one and only "what is
//   the ground at (x, z)?" answer that gameplay reads. It bilinearly
//   interpolates the four corner heights of the tile that contains
//   (x, z), so the surface it returns matches EXACTLY what the tile
//   renderer draws across the top of every cube. Sim, physics, and
//   client dead-reckoning all call this — units, projectiles, and
//   buildings settle on the same surface the player sees, with no
//   tile-center stepping when crossing a cell boundary.

const RIPPLE_AMPLITUDE = 1000;
// Ripples occupy this fraction of `min(mapWidth, mapHeight)` from
// the map center outward. With a 2000×2000 map and 0.25, the
// ripple zone is a disc of radius 500 centered on the map.
const RIPPLE_RADIUS_FRACTION = 0.4;

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
const RIDGE_PEAK_FACTOR = 2;
// Spawn margin in sim units — matches DEMO_CONFIG.spawnMarginPx.
// Inlined to keep Terrain.ts free of a demoConfig import.
const SPAWN_MARGIN = 100;

export function setTerrainTeamCount(n: number): void {
  teamCount = Math.max(0, n | 0);
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
const RIPPLE_W2 = 500;
const RIPPLE_W3 = 500;
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
    ripple = RIPPLE_AMPLITUDE * fade * norm;
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
    // Player 0 is anchored at theta = -π/2 by spawn.ts'
    // getPlayerBaseAngle, so we phase-shift by +π/2 to make pos=0
    // coincide with player 0.
    const cycle = (2 * Math.PI) / teamCount;
    let pos = (theta + Math.PI / 2) % cycle;
    if (pos < 0) pos += cycle;
    const barrierMid = cycle / 2;
    const halfBarrier = cycle / 4; // half-width = π/(2N)
    const distFromBarrierCenter = Math.abs(pos - barrierMid);
    if (distFromBarrierCenter < halfBarrier) {
      // Angular profile: cosine ease, peak at barrier center, 0 at
      // the boundary with the team area.
      const angT = distFromBarrierCenter / halfBarrier; // 0..1
      const angFalloff = Math.cos(angT * (Math.PI / 2));
      // Radial profile: 0 at center, ramp linearly up to the spawn
      // ring, plateau beyond. The user-spec is "starts at 2x
      // amplitude from the outer ring of the starting circle".
      const spawnRadius = Math.min(mapWidth, mapHeight) / 2 - SPAWN_MARGIN;
      const radT = spawnRadius > 0 ? Math.min(dist / spawnRadius, 1) : 0;
      ridge = RIPPLE_AMPLITUDE * RIDGE_PEAK_FACTOR * angFalloff * radT;
    }
  }

  return ripple + ridge;
}

/** Step size for the finite-difference gradient that drives the
 *  surface normal. Small enough to track ripples (RIPPLE_W2 = 50)
 *  faithfully, large enough that single-precision noise on the
 *  heightmap function doesn't show up as gradient jitter. */
const NORMAL_GRADIENT_EPS = 1;

/** Surface-tangent normal at world point (x, z) in SIM coords (z is
 *  up). Continuous finite-difference gradient of the underlying
 *  heightmap — NOT the per-triangle face normal of the rendered
 *  geometry. The renderer subdivides each tile finely enough that
 *  the visible surface approximates the smooth heightmap, so the
 *  smooth gradient here matches the rendered surface visually and
 *  the unit's tilt transitions continuously across the map (no jump
 *  along tile diagonals).
 *
 *  Outside the ripple disc the heightmap is exactly flat; the
 *  finite differences cancel out, the normal collapses to (0, 0, 1)
 *  and downstream early-returns kick in.
 *
 *  `cellSize` is unused here but kept in the signature so the public
 *  API stays the same as `getSurfaceHeight`. */
export function getSurfaceNormal(
  x: number, z: number,
  mapWidth: number, mapHeight: number,
  _cellSize: number,
): { nx: number; ny: number; nz: number } {
  const eps = NORMAL_GRADIENT_EPS;
  const hxp = getTerrainHeight(x + eps, z, mapWidth, mapHeight);
  const hxm = getTerrainHeight(x - eps, z, mapWidth, mapHeight);
  const hzp = getTerrainHeight(x, z + eps, mapWidth, mapHeight);
  const hzm = getTerrainHeight(x, z - eps, mapWidth, mapHeight);
  const dHdx = (hxp - hxm) / (2 * eps);
  const dHdz = (hzp - hzm) / (2 * eps);
  // Sim normal: surface up is (-∂h/∂x, -∂h/∂z, 1).
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

/** Canonical ground-surface height at world point (x, z). Returns
 *  the smooth analytical heightmap directly — no tile-aligned
 *  triangulation. The tile renderer subdivides each big tile into a
 *  fine sub-grid and samples the same heightmap at every sub-vertex,
 *  so the rendered surface approximates this function to sub-pixel
 *  accuracy. Sim, physics, client dead-reckoning, and the renderer
 *  agree on one continuous surface; unit tilt and altitude
 *  transition smoothly anywhere on the map.
 *
 *  `cellSize` is unused here but kept in the signature for API
 *  parity with the rest of the heightmap helpers. */
export function getSurfaceHeight(
  x: number, z: number,
  mapWidth: number, mapHeight: number,
  _cellSize: number,
): number {
  return getTerrainHeight(x, z, mapWidth, mapHeight);
}

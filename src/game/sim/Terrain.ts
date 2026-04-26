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

const RIPPLE_AMPLITUDE = 800;
// Ripples occupy this fraction of `min(mapWidth, mapHeight)` from
// the map center outward. With a 2000×2000 map and 0.25, the
// ripple zone is a disc of radius 500 centered on the map.
const RIPPLE_RADIUS_FRACTION = 0.4;
// Wavelengths for the three sinusoids that combine into the
// ripple pattern. Mixing irrational ratios prevents the layers
// from harmonizing into a clean grid.
const RIPPLE_W1 = 200;
const RIPPLE_W2 = 50;
const RIPPLE_W3 = 500;
// Phase offset on the second sinusoid so the bumps don't all
// peak at the same dist value.
const RIPPLE_PHASE = 1.7;

/** Raw continuous terrain height at world point (x, y). Always
 *  ≥ 0. Outside the ripple disc, returns exactly 0. */
export function getTerrainHeight(
  x: number, y: number,
  mapWidth: number, mapHeight: number,
): number {
  const cxw = mapWidth / 2;
  const cyw = mapHeight / 2;
  const dx = x - cxw;
  const dy = y - cyw;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const maxDist = Math.min(mapWidth, mapHeight) * RIPPLE_RADIUS_FRACTION;
  if (dist >= maxDist || maxDist <= 0) return 0;

  // Cosine fade: 1 at center, 0 at the ripple edge.
  const fadeT = (dist / maxDist) * (Math.PI / 2);
  const fade = Math.cos(fadeT);

  // Three sinusoids in dist + a directional ridge. Sum lives in
  // roughly [-1, +1]; normalize into [0, 1] before scaling so tiles
  // don't produce negative heights.
  const a = Math.cos(dist / RIPPLE_W1);
  const b = Math.cos(dist / RIPPLE_W2 + RIPPLE_PHASE);
  const c = Math.sin((dx + dy) / RIPPLE_W3);
  const sum = (a * 0.5 + b * 0.3 + c * 0.2);
  // Map (-1..+1) to (0..1) then to amplitude. The fade taper
  // attenuates by distance so the ripple disc edge sits at z=0
  // and joins the surrounding flat terrain seamlessly.
  const norm = (sum + 1) * 0.5;
  return RIPPLE_AMPLITUDE * fade * norm;
}

/** Canonical ground-surface height at world point (x, z). Bilinear
 *  interpolation of the four corner heights of the tile that
 *  contains (x, z). This matches the renderer's drawn surface
 *  EXACTLY along tile edges and very closely within tiles — the
 *  renderer triangulates each tile into two triangles, while this
 *  uses bilinear, so the two agree pixel-perfect on all four edges
 *  and differ only by tiny saddle-vs-fold variation in the interior.
 *
 *  Use this for every gameplay/physics ground query — unit footing,
 *  building base, projectile-vs-ground hit, client dead-reckoning
 *  ground clamp. With every consumer reading the same function on
 *  both sides, the simulation surface and the rendered surface are
 *  the same surface, full stop. */
export function getSurfaceHeight(
  x: number, z: number,
  mapWidth: number, mapHeight: number,
  cellSize: number,
): number {
  const cx = Math.floor(x / cellSize);
  const cz = Math.floor(z / cellSize);
  const x0 = cx * cellSize;
  const x1 = x0 + cellSize;
  const z0 = cz * cellSize;
  const z1 = z0 + cellSize;
  const h00 = getTerrainHeight(x0, z0, mapWidth, mapHeight);
  const h10 = getTerrainHeight(x1, z0, mapWidth, mapHeight);
  const h11 = getTerrainHeight(x1, z1, mapWidth, mapHeight);
  const h01 = getTerrainHeight(x0, z1, mapWidth, mapHeight);
  const fx = (x - x0) / cellSize;
  const fz = (z - z0) / cellSize;
  // Bilinear: lerp along x at z=z0 and z=z1, then lerp those by fz.
  const hX0 = h00 * (1 - fx) + h10 * fx;
  const hX1 = h01 * (1 - fx) + h11 * fx;
  return hX0 * (1 - fz) + hX1 * fz;
}

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
// Tile alignment: `getTileTerrainHeight` snaps (x, y) to the spatial
// grid's tile and returns the height at the tile center. Use this
// for unit ground levels — every unit on a tile stands on the SAME
// flat top face, so a unit walking across the tile doesn't bob up
// and down with the underlying continuous heightmap. Crossing a tile
// boundary then steps cleanly between the two cube tops.
//
// `getTerrainHeight` is the underlying continuous version; use it
// where you want the smooth surface (projectile-vs-ground impact
// snapping, debris settling) so things don't pop.

const RIPPLE_AMPLITUDE = 30;
// Ripples occupy this fraction of `min(mapWidth, mapHeight)` from
// the map center outward. With a 2000×2000 map and 0.25, the
// ripple zone is a disc of radius 500 centered on the map.
const RIPPLE_RADIUS_FRACTION = 0.25;
// Wavelengths for the three sinusoids that combine into the
// ripple pattern. Mixing irrational ratios prevents the layers
// from harmonizing into a clean grid.
const RIPPLE_W1 = 80;
const RIPPLE_W2 = 130;
const RIPPLE_W3 = 200;
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

/** Tile-aligned ground height. Units, buildings and capture cubes
 *  sample this so each cell has ONE flat top face — gameplay reads
 *  cleanly as block terrain instead of as a continuous slope, and
 *  units don't bob up and down crossing a tile.
 *
 *  Crossing a tile boundary still steps between the two cube tops
 *  exactly like climbing a stair, which matches the "3D mana cube"
 *  visualization. */
export function getTileTerrainHeight(
  x: number, y: number,
  cellSize: number,
  mapWidth: number, mapHeight: number,
): number {
  const cx = Math.floor(x / cellSize);
  const cy = Math.floor(y / cellSize);
  const centerX = cx * cellSize + cellSize / 2;
  const centerY = cy * cellSize + cellSize / 2;
  return getTerrainHeight(centerX, centerY, mapWidth, mapHeight);
}

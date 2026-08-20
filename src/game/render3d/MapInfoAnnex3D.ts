// MapInfoAnnex3D — the headland the map's info caption stands on.
//
// The caption used to stand on a plinth parked in the void outside the map's
// (0, 0) corner: a terrain-coloured box with nothing under it, no water
// around it and a hard edge between it and the world, which read as exactly
// what it was — a prop.
//
// It is now a piece of the map. The annex is a rectangle of land grown
// straight out of the MIDDLE of the map edge behind ally team 0 — the side
// the default camera looks in over, and the side every radial layout phases
// its first side onto. Its top starts at the terrain's own height along that
// edge and eases, over `blendDepth`, into one flat table at the height of the
// edge's midpoint, so the join is the map's own surface continuing rather
// than a step.
//
// Three consumers share this one description, which is why it lives in its
// own module rather than inside any of them:
//
//   TerrainTileRenderer3D emits the annex INTO the terrain mesh — same
//     shader, so the same substances, shoreline tint, underwater darkening
//     and world-box walls down to the same floor.
//   WaterRenderer3D grows the liquid footprint around it by the same
//     overhang every map edge gets, so the sea (or the lava) covers it at the
//     same level with the same border.
//   MapPresetLabel3D stands its letters on the flat part.
//
// It is deliberately NOT playable: the authoritative terrain mesh, the
// pathfinding grid and the build grid all still stop at the map rectangle.
// Looking playable is the whole point — it is meant to be worth one wasted
// scout.

import { LAND_TILE_GROUND_LIFT, MAP_INFO_ANNEX_RENDER_CONFIG } from '../../config';
import { getAllyTeamBaseAngle } from '../sim/playerLayout';

/** Which map edge the annex grows out of. */
export type MapInfoAnnexEdge = 'north' | 'east' | 'south' | 'west';

type EdgeFrame = {
  readonly edge: MapInfoAnnexEdge;
  /** Unit direction out of the map, in world XZ. */
  readonly outX: number;
  readonly outZ: number;
  /** Yaw about world +Y that carries the north-edge sign frame onto this
   *  edge — the rotation that keeps the caption's own "up" pointing at the
   *  map, so it reads from outside whichever edge it landed on. */
  readonly signYaw: number;
};

const EDGE_FRAMES: readonly EdgeFrame[] = [
  { edge: 'north', outX: 0, outZ: -1, signYaw: 0 },
  { edge: 'east', outX: 1, outZ: 0, signYaw: -Math.PI / 2 },
  { edge: 'south', outX: 0, outZ: 1, signYaw: Math.PI },
  { edge: 'west', outX: -1, outZ: 0, signYaw: Math.PI / 2 },
];

export type MapInfoAnnexFootprint = {
  readonly edge: MapInfoAnnexEdge;
  /** World XZ bounds of the annex rectangle. It touches the map along one
   *  side and lies entirely outside it. */
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
  /** The point on the map perimeter the annex grows out of: the midpoint of
   *  the edge behind ally team 0. Its terrain height is the flat table's. */
  readonly attachX: number;
  readonly attachZ: number;
  /** Unit direction away from the map. */
  readonly outX: number;
  readonly outZ: number;
  /** Unit direction along the edge; `out` rotated so that a grid walked
   *  (along, out) always winds its top face upward. */
  readonly alongX: number;
  readonly alongZ: number;
  /** Extent along the edge and away from it. */
  readonly width: number;
  readonly depth: number;
  /** How much of `depth`, measured from the map edge, is spent easing from
   *  the map's own edge profile into the flat table. */
  readonly blendDepth: number;
  readonly signYaw: number;
};

/** Size the annex from the map's larger axis and hang it off the middle of
 *  the edge behind ally team 0. Pure: the contract test, the terrain mesh,
 *  the liquid box and the caption all resolve the same rectangle from the map
 *  dimensions alone, with no renderer in the way. */
export function resolveMapInfoAnnexFootprint(
  mapWidth: number,
  mapHeight: number,
): MapInfoAnnexFootprint {
  const axis = Math.max(mapWidth, mapHeight);
  // Ally team 0's slice centre is the same angle at every side count, so this
  // reads the ONE constant the whole radial layout is phased off rather than
  // hard-coding the edge the layout happens to use today.
  const angle = getAllyTeamBaseAngle(0, 1);
  const dirX = Math.cos(angle);
  const dirZ = Math.sin(angle);
  let frame = EDGE_FRAMES[0];
  let bestAlignment = -Infinity;
  for (const candidate of EDGE_FRAMES) {
    const alignment = candidate.outX * dirX + candidate.outZ * dirZ;
    if (alignment > bestAlignment) {
      bestAlignment = alignment;
      frame = candidate;
    }
  }
  // The annex is sized against the LARGER map axis so it keeps its
  // whole-map-zoom size, but it can never take over the coast it hangs off:
  // a long thin map's short edge would otherwise sprout a tongue as wide as
  // itself. Width and depth are scaled down TOGETHER, so the headland keeps
  // its shape (and the caption on it its proportions) rather than being
  // squashed into a different one.
  const edgeSpan = frame.outX === 0 ? mapWidth : mapHeight;
  const wantedWidth = axis * MAP_INFO_ANNEX_RENDER_CONFIG.widthMapFraction;
  const widthCeiling = edgeSpan * MAP_INFO_ANNEX_RENDER_CONFIG.maxEdgeSpanFraction;
  const fit = wantedWidth > 0 ? Math.min(1, widthCeiling / wantedWidth) : 1;
  const width = wantedWidth * fit;
  const depth = axis * MAP_INFO_ANNEX_RENDER_CONFIG.depthMapFraction * fit;
  const attachX = frame.outX > 0 ? mapWidth : frame.outX < 0 ? 0 : mapWidth / 2;
  const attachZ = frame.outZ > 0 ? mapHeight : frame.outZ < 0 ? 0 : mapHeight / 2;
  const farX = attachX + frame.outX * depth;
  const farZ = attachZ + frame.outZ * depth;
  const halfAlongX = frame.outX === 0 ? width / 2 : 0;
  const halfAlongZ = frame.outZ === 0 ? width / 2 : 0;
  return {
    edge: frame.edge,
    minX: Math.min(attachX, farX) - halfAlongX,
    maxX: Math.max(attachX, farX) + halfAlongX,
    minZ: Math.min(attachZ, farZ) - halfAlongZ,
    maxZ: Math.max(attachZ, farZ) + halfAlongZ,
    attachX,
    attachZ,
    outX: frame.outX,
    outZ: frame.outZ,
    alongX: -frame.outZ,
    alongZ: frame.outX,
    width,
    depth,
    blendDepth: depth * MAP_INFO_ANNEX_RENDER_CONFIG.blendDepthFraction,
    signYaw: frame.signYaw,
  };
}

/** The map's terrain height at the attachment point — the altitude the whole
 *  flat part of the annex sits at. Raw terrain height, without the render
 *  lift; {@link mapInfoAnnexSurfaceY} is what anything drawn uses. */
export function mapInfoAnnexFlatHeight(
  footprint: MapInfoAnnexFootprint,
  sampleTerrainHeight: (x: number, z: number) => number,
): number {
  return sampleTerrainHeight(footprint.attachX, footprint.attachZ);
}

/** How far out of the map (x, z) lies, along the annex's own outward axis. */
function outDistance(footprint: MapInfoAnnexFootprint, x: number, z: number): number {
  return Math.max(
    0,
    (x - footprint.attachX) * footprint.outX + (z - footprint.attachZ) * footprint.outZ,
  );
}

/** The annex's one blend curve, shared by everything that eases off the map
 *  edge onto the flat table: 0 at the seam, 1 once past `blendDepth`. */
function blendWeight(footprint: MapInfoAnnexFootprint, out: number): number {
  const t = footprint.blendDepth > 0 ? Math.min(1, out / footprint.blendDepth) : 1;
  return t * t * (3 - 2 * t);
}

/** The annex's rendered surface height at (x, z). The seam row (out = 0)
 *  returns the map's own edge height at that point EXACTLY — the terrain
 *  sampler interpolates linearly inside a mesh triangle, so samples taken
 *  along the map's boundary edge lie on that edge no matter how finely the
 *  annex is stepped, and the two meshes meet without a crack. */
export function mapInfoAnnexSurfaceY(
  footprint: MapInfoAnnexFootprint,
  x: number,
  z: number,
  flatHeight: number,
  sampleTerrainHeight: (x: number, z: number) => number,
): number {
  const out = outDistance(footprint, x, z);
  const edgeHeight = sampleTerrainHeight(
    x - footprint.outX * out,
    z - footprint.outZ * out,
  );
  return (
    edgeHeight +
    (flatHeight - edgeHeight) * blendWeight(footprint, out) +
    LAND_TILE_GROUND_LIFT
  );
}

/**
 * The annex's horizon blend at (x, z) — how much of the terrain's
 * end-of-the-world colour is painted over it — eased off the map edge on the
 * SAME band and the SAME curve as the height above.
 *
 * It cannot be read at (x, z) directly. The blend answers "how close is this
 * to the edge of the world", and the map's rectangle IS that edge: sampled
 * where it actually stands, every annex vertex scores a full blend, and the
 * headland paints as one flat slab of horizon colour with no substances, no
 * shoreline tint and no underwater darkening — the "that is not the seabed"
 * tell the annex exists to avoid.
 *
 * So the annex inherits the coast's blend at the seam and sheds it over
 * `blendDepth`, exactly as it inherits the coast's height and eases to its
 * own flat table. The join stays continuous, and the table the caption stands
 * on is painted by the same terms as the seabed inside the map.
 */
export function mapInfoAnnexHorizonFade(
  footprint: MapInfoAnnexFootprint,
  x: number,
  z: number,
  sampleMapHorizonFade: (x: number, z: number) => number,
): number {
  const out = outDistance(footprint, x, z);
  const edgeFade = sampleMapHorizonFade(
    x - footprint.outX * out,
    z - footprint.outZ * out,
  );
  return edgeFade * (1 - blendWeight(footprint, out));
}

/** The rendered altitude of the flat table itself. */
export function mapInfoAnnexFlatSurfaceY(flatHeight: number): number {
  return flatHeight + LAND_TILE_GROUND_LIFT;
}

export type MapInfoAnnexRect = {
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
};

/**
 * The annex's own share of the liquid footprint: its rectangle grown by the
 * same `overhang` every map edge gets, with the map-facing side stopped at
 * the map's own liquid border — that part is already covered, and a second
 * coplanar layer of translucent water over it would read as a darker patch.
 *
 * The result is the arm of an L. Its along-edge extent is clamped to the
 * map's liquid rectangle so the union stays an L rather than a cross.
 */
export function resolveMapInfoAnnexLiquidRect(
  footprint: MapInfoAnnexFootprint,
  overhang: number,
  mapWidth: number,
  mapHeight: number,
): MapInfoAnnexRect {
  let minX = footprint.minX - overhang;
  let maxX = footprint.maxX + overhang;
  let minZ = footprint.minZ - overhang;
  let maxZ = footprint.maxZ + overhang;
  if (footprint.outX === 0) {
    const shared = footprint.attachZ + footprint.outZ * overhang;
    if (footprint.outZ < 0) maxZ = shared;
    else minZ = shared;
    minX = Math.max(minX, -overhang);
    maxX = Math.min(maxX, mapWidth + overhang);
  } else {
    const shared = footprint.attachX + footprint.outX * overhang;
    if (footprint.outX < 0) maxX = shared;
    else minX = shared;
    minZ = Math.max(minZ, -overhang);
    maxZ = Math.min(maxZ, mapHeight + overhang);
  }
  return { minX, maxX, minZ, maxZ };
}

/**
 * How far out the annex's surface has SETTLED to within `tolerance` of the
 * flat table, given the worst height its seam is handed by the coast.
 *
 * Zero when the map edge behind the team is already at the table's altitude:
 * a flat coast leaves the whole headland flat, and a caption has no reason to
 * stand back from ground that never ramps. The blend band is not a keep-out
 * zone, it is a ramp — and on most maps most of it is a ramp of nothing.
 *
 * This inverts the same smoothstep {@link mapInfoAnnexSurfaceY} eases with,
 * in closed form, so the answer is the exact distance rather than a guess
 * with a safety factor bolted on.
 */
export function mapInfoAnnexSettledDepth(
  footprint: MapInfoAnnexFootprint,
  seamDeviation: number,
  tolerance: number,
): number {
  const deviation = Math.abs(seamDeviation);
  if (!(deviation > Math.max(0, tolerance))) return 0;
  const settled = 1 - Math.max(0, tolerance) / deviation;
  const t = 0.5 - Math.sin(Math.asin(Math.max(-1, Math.min(1, 1 - 2 * settled))) / 3);
  return footprint.blendDepth * Math.max(0, Math.min(1, t));
}

/** Where the caption may stand: everything past `nearLimit` — the point the
 *  ramp off the coast has settled onto the flat table — inset by one margin
 *  on every side. Letters all rise from one plane, so ground still easing
 *  under them would leave them floating at one end; ground that eased to
 *  nothing costs the caption nothing. */
export function resolveMapInfoAnnexCaptionArea(
  footprint: MapInfoAnnexFootprint,
  margin: number,
  nearLimit: number,
): {
  readonly centerX: number;
  readonly centerZ: number;
  readonly width: number;
  readonly depth: number;
} {
  const near = Math.max(0, Math.min(footprint.depth, nearLimit));
  const flatDepth = footprint.depth - near;
  const centerOut = near + flatDepth / 2;
  return {
    centerX: footprint.attachX + footprint.outX * centerOut,
    centerZ: footprint.attachZ + footprint.outZ * centerOut,
    width: Math.max(0, footprint.width - 2 * margin),
    depth: Math.max(0, flatDepth - 2 * margin),
  };
}

/** The worst the coast deviates from the flat table along the annex's seam,
 *  sampled across its width. This is what decides how much of the ramp the
 *  caption has to stand clear of. */
export function mapInfoAnnexSeamDeviation(
  footprint: MapInfoAnnexFootprint,
  flatHeight: number,
  sampleTerrainHeight: (x: number, z: number) => number,
  samples = 9,
): number {
  let worst = 0;
  const count = Math.max(2, Math.floor(samples));
  for (let i = 0; i < count; i++) {
    const across = (i / (count - 1) - 0.5) * footprint.width;
    const height = sampleTerrainHeight(
      footprint.attachX + footprint.alongX * across,
      footprint.attachZ + footprint.alongZ * across,
    );
    if (!Number.isFinite(height)) continue;
    worst = Math.max(worst, Math.abs(height - flatHeight));
  }
  return worst;
}

/** Where the emitted triangles go. TerrainTileRenderer3D implements this over
 *  its own parallel vertex arrays, so the annex ends up in the terrain mesh
 *  itself rather than in a lookalike mesh beside it. */
export type MapInfoAnnexSink = {
  /** One annex TOP vertex, with its surface normal (render space, +Y up) and
   *  its own slope. Returns the vertex index. */
  pushSurfaceVertex(
    x: number,
    y: number,
    z: number,
    nx: number,
    ny: number,
    nz: number,
    slope: number,
  ): number;
  /** One annex WALL vertex: a vertical cliff face with a horizontal outward
   *  normal, exactly like the map's own world-box walls. */
  pushWallVertex(x: number, y: number, z: number, nx: number, nz: number): number;
  pushTriangle(a: number, b: number, c: number): void;
};

export type MapInfoAnnexEmitOptions = {
  readonly flatHeight: number;
  readonly sampleTerrainHeight: (x: number, z: number) => number;
  /** Triangle spacing along both annex axes. */
  readonly step: number;
  /** Altitude the annex's walls hang down to — the world-box floor. */
  readonly floorY: number;
  /** Emit the walls at all (the terrain's own side-wall graphics option). */
  readonly walls: boolean;
  /** Drop quads that lie wholly at or below this altitude, mirroring the
   *  terrain's fully-opaque-ocean culling. Pass null to keep everything. */
  readonly cullAtOrBelowY: number | null;
};

/**
 * Emit the annex: one grid for its top, three vertical walls for its outer
 * sides. The fourth side is the map edge it grew out of and stays open — the
 * map's own wall already closes that plane, from inside the annex's solid.
 *
 * The grid is walked (along, out). `along` is `out` rotated a quarter turn,
 * so the quad order below has the same handedness on every edge instead of
 * only on the one the annex happens to use today.
 *
 * THE TOP IS WOUND THE WAY THE AUTHORITATIVE TERRAIN MESH IS WOUND, which is
 * clockwise seen from above — its triangles present their BACK face to a
 * camera over the map. That is not a bug to route around: the terrain
 * material is DoubleSide, and three.js negates the shading normal on a back
 * face, so every square metre of this map is lit through a downward normal
 * and its daylight comes from the baked `terrainShade` instead. An annex
 * wound the other way is lit by the sun and the environment on top of that
 * same baked shade and comes out several times brighter than the seabed it
 * is welded to — which is exactly the "that is not the map" tell the annex
 * exists to remove. Matching the map's winding is therefore load-bearing,
 * and is asserted by MapInfoAnnex3DContractTest.
 */
export function emitMapInfoAnnexGeometry(
  footprint: MapInfoAnnexFootprint,
  options: MapInfoAnnexEmitOptions,
  sink: MapInfoAnnexSink,
): void {
  const step = Math.max(1, options.step);
  const columns = Math.max(2, Math.ceil(footprint.width / step) + 1);
  const rows = Math.max(2, Math.ceil(footprint.depth / step) + 1);
  const positionX = (column: number, row: number): number =>
    footprint.attachX +
    footprint.alongX * ((column / (columns - 1)) * footprint.width - footprint.width / 2) +
    footprint.outX * ((row / (rows - 1)) * footprint.depth);
  const positionZ = (column: number, row: number): number =>
    footprint.attachZ +
    footprint.alongZ * ((column / (columns - 1)) * footprint.width - footprint.width / 2) +
    footprint.outZ * ((row / (rows - 1)) * footprint.depth);

  const heights = new Float64Array(columns * rows);
  const xs = new Float64Array(columns * rows);
  const zs = new Float64Array(columns * rows);
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const at = row * columns + column;
      const x = positionX(column, row);
      const z = positionZ(column, row);
      xs[at] = x;
      zs[at] = z;
      heights[at] = mapInfoAnnexSurfaceY(
        footprint,
        x,
        z,
        options.flatHeight,
        options.sampleTerrainHeight,
      );
    }
  }

  // Central differences over the grid itself, so the shading normal is the
  // surface the triangles actually describe rather than a second sampling of
  // the height field at a different scale.
  const surfaceIndices = new Int32Array(columns * rows).fill(-1);
  const gradientStepX = footprint.width / (columns - 1);
  const gradientStepZ = footprint.depth / (rows - 1);
  const allocateSurfaceVertex = (column: number, row: number): number => {
    const at = row * columns + column;
    const existing = surfaceIndices[at];
    if (existing >= 0) return existing;
    const leftColumn = Math.max(0, column - 1);
    const rightColumn = Math.min(columns - 1, column + 1);
    const nearRow = Math.max(0, row - 1);
    const farRow = Math.min(rows - 1, row + 1);
    const alongSlope =
      (heights[row * columns + rightColumn] - heights[row * columns + leftColumn]) /
      Math.max(1e-6, (rightColumn - leftColumn) * gradientStepX);
    const outSlope =
      (heights[farRow * columns + column] - heights[nearRow * columns + column]) /
      Math.max(1e-6, (farRow - nearRow) * gradientStepZ);
    // The two gradients are measured along the annex's own axes; rotate them
    // back onto world X/Z through the same (along, out) basis.
    const gradientX = alongSlope * footprint.alongX + outSlope * footprint.outX;
    const gradientZ = alongSlope * footprint.alongZ + outSlope * footprint.outZ;
    const length = Math.hypot(gradientX, gradientZ, 1);
    const ny = 1 / length;
    const index = sink.pushSurfaceVertex(
      xs[at],
      heights[at],
      zs[at],
      -gradientX / length,
      ny,
      -gradientZ / length,
      1 - ny,
    );
    surfaceIndices[at] = index;
    return index;
  };

  const cull = options.cullAtOrBelowY;
  const quadIsCulled = (
    a: number,
    b: number,
    c: number,
    d: number,
  ): boolean =>
    cull !== null &&
    heights[a] <= cull &&
    heights[b] <= cull &&
    heights[c] <= cull &&
    heights[d] <= cull;

  for (let row = 0; row < rows - 1; row++) {
    for (let column = 0; column < columns - 1; column++) {
      const a = row * columns + column;
      const b = row * columns + column + 1;
      const c = (row + 1) * columns + column + 1;
      const d = (row + 1) * columns + column;
      if (quadIsCulled(a, b, c, d)) continue;
      const va = allocateSurfaceVertex(column, row);
      const vb = allocateSurfaceVertex(column + 1, row);
      const vc = allocateSurfaceVertex(column + 1, row + 1);
      const vd = allocateSurfaceVertex(column, row + 1);
      // Reversed on purpose — see the winding note in this function's doc.
      sink.pushTriangle(va, vc, vb);
      sink.pushTriangle(va, vd, vc);
    }
  }

  if (!options.walls) return;

  // A wall quad is wound (bottom0, top0, top1) / (bottom0, top1, bottom1),
  // whose face normal comes out as (dz, 0, -dx) for a top edge running
  // (dx, dz). Walking each side in the direction (-nz, nx) is therefore what
  // makes the drawn face agree with the outward normal it is authored with.
  const pushWall = (
    rim: ReadonlyArray<number>,
    nx: number,
    nz: number,
  ): void => {
    for (let i = 0; i < rim.length - 1; i++) {
      const a = rim[i];
      const b = rim[i + 1];
      if (cull !== null && heights[a] <= cull && heights[b] <= cull) continue;
      const topA = sink.pushWallVertex(xs[a], heights[a], zs[a], nx, nz);
      const topB = sink.pushWallVertex(xs[b], heights[b], zs[b], nx, nz);
      const floorA = sink.pushWallVertex(xs[a], options.floorY, zs[a], nx, nz);
      const floorB = sink.pushWallVertex(xs[b], options.floorY, zs[b], nx, nz);
      sink.pushTriangle(floorA, topA, topB);
      sink.pushTriangle(floorA, topB, floorB);
    }
  };

  const farRim: number[] = [];
  for (let column = 0; column < columns; column++) {
    farRim.push((rows - 1) * columns + column);
  }
  const firstColumnRim: number[] = [];
  const lastColumnRim: number[] = [];
  for (let row = 0; row < rows; row++) {
    firstColumnRim.push(row * columns);
    lastColumnRim.push(row * columns + columns - 1);
  }
  pushWall(farRim, footprint.outX, footprint.outZ);
  // The low-column side faces −along and is walked outward; the high-column
  // side faces +along and is walked back toward the map.
  pushWall(firstColumnRim, -footprint.alongX, -footprint.alongZ);
  pushWall([...lastColumnRim].reverse(), footprint.alongX, footprint.alongZ);
}

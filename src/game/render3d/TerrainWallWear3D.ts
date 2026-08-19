// TerrainWallWear3D — the top and bottom rims of a plateau wall, worn.
//
// A D-PLATEAU map is a stack of terraces, and every terrace meets its wall at
// two lines: the TOP rim, where the plateau surface folds over into the drop,
// and the BOTTOM rim, where the drop lands on the ground below. Drawn
// straight they are exactly what the mesh says they are — a fold, at one
// angle, the same all the way along. Nothing that has stood in weather for
// any length of time has a fold like that: a top rim spalls and rounds and
// sheds what breaks off it, and a bottom rim collects the debris.
//
// This is Nothing In The World Has A Clean Edge applied to the second-most
// obvious clean edge on the map. It reads the same noise and calls the same
// displace / dissolve / grime functions the ore region does
// (SurfaceWeathering3D), so the two look like the same weather where they
// meet — and ore regularly runs off its flat pad and down a terrace.
//
// ── THE SAFETY PROPERTY ───────────────────────────────────────────────────
//
// Walls are frequently FLATTENED INTO THE TERRAIN on purpose. The wall
// triangles are still flagged as walls in the mesh, but geometrically they
// have been blended flush with the ground around them, because the map author
// wanted that terrace step gone there. Wearing those rims would draw a wall
// the map deliberately erased — the treatment would expose exactly what the
// flattening was for.
//
// So the intensity is driven by the DIHEDRAL ANGLE measured at the rim
// between the wall-side surface and the ground-side surface. Flush wall,
// coincident normals, zero wear. Sharp cliff, full wear. It is measured from
// the geometry, never read off the D-PLATEAU or PLATEAU WALL SLOPE settings,
// which is what lets a partially flattened wall fade smoothly along its own
// length instead of snapping between two cases.
//
// ── WHY THIS IS A MESH TRAVERSAL AND NOT A FIELD ──────────────────────────
//
// The ore region gets its distances from a baked world-XZ field. That cannot
// work here: at the shipped 89° wall slope the top and bottom rims are only a
// few world units apart in XZ, and a field at ten units per texel cannot tell
// them apart. Worse, they want opposite treatments. So the reach is measured
// as GEODESIC distance over the terrain mesh itself, which is also more
// correct — wear travels along the surface, not through the air, and a rim
// 30 units above you across a gap should not dirty the ground you are on.
//
// ── WHAT IS DELIBERATELY NOT ATTEMPTED ────────────────────────────────────
//
// No geometry. Not one vertex moves, not one triangle is cut or merged. The
// 2026-07-30 attempt to improve wall triangles tried strip consolidation,
// rung-only strips, and contour snap-rounding; all three were reverted, and
// the snap-rounding was rejected on sight because moving terrace edges reads
// as chunks bitten out of the walls. At 89° the thin triangles ARE the cliff.
// This is shading, and shading only.

import * as THREE from 'three';
import {
  SOIL_SUBSTANCE_TILE_WORLD_SIZE,
  TERRAIN_WALL_WEAR,
  TERRAIN_WALL_WEAR_MAX_ANGLE_DEGREES,
  TERRAIN_WALL_WEAR_MIN_ANGLE_DEGREES,
  TERRAIN_WALL_WEAR_REACH_WORLD_UNITS,
} from '../../config';
import {
  WEATHER_NOISE_SAMPLER,
  WEATHER_SOIL_SAMPLER,
} from './SurfaceWeathering3D';

/** The subset of the authoritative terrain mesh this needs. Declared
 *  structurally so the module can be exercised without building a map. */
export type TerrainWallWearMesh = {
  vertexCount: number;
  triangleCount: number;
  /** Interleaved (x, z) per vertex. */
  vertexCoords: ArrayLike<number>;
  vertexHeights: ArrayLike<number>;
  triangleIndices: ArrayLike<number>;
  triangleWallFlags: ArrayLike<number>;
};

/** Per authoritative vertex and per rim kind: how far that rim is, as a
 *  fraction of the reach (0 at the rim, 1 at or past it), and how sharp the
 *  nearest rim of that kind is.
 *
 *  THREE VALUES, AND EACH ONE IS THERE FOR A MEASURED REASON.
 *
 *  A wall face has NO INTERIOR VERTICES — at the shipped slope the mesh runs
 *  straight from the top rim to the bottom one — so every per-vertex value on
 *  it is interpolated across the entire drop, by whichever pair of rim
 *  vertices that particular long thin triangle happens to join.
 *
 *  DISTANCE, not a pre-multiplied ramp: a [0,1] ramp smears the wear down the
 *  whole face however short the authored reach is. A metric distance clips at
 *  the reach, so the middle of a tall cliff comes out clean.
 *
 *  INTENSITY separate from it: the angle term has to survive the clip, and
 *  folding it into the ramp makes a shallow rim indistinguishable from a
 *  distant sharp one.
 *
 *  RIM HEIGHT, because distance alone still bands. Adjacent wall triangles
 *  pair their top and bottom vertices differently, so the interpolated
 *  distance is piecewise-linear with a kink at every triangle edge — which
 *  draws the mesh's own triangle columns down the cliff as evenly spaced
 *  vertical stripes. The height of the nearest rim is CONSTANT across a wall
 *  face (every vertex of it shares the same rim), so the shader can measure
 *  the drop directly and get a smooth field on exactly the surface where the
 *  interpolated one is worthless. It blends back to the interpolated distance
 *  as the surface flattens, where there are vertices again and where the
 *  height difference stops meaning anything. */
export type TerrainWallWear = {
  /** Per vertex, per rim kind: (normalized distance, intensity, rim height).
   *  Six floats, laid out top-then-bottom. */
  rims: Float32Array;
};

/** Floats per vertex in `rims`. */
export const WALL_WEAR_RIM_STRIDE = 6;

/** Face normal of one triangle, +up, unnormalized. Mirrors the renderer's own
 *  helper; kept here so the module is self-contained and does not depend on
 *  the renderer having its class-normal accumulation switched on. */
function faceNormal(
  mesh: TerrainWallWearMesh,
  ia: number,
  ib: number,
  ic: number,
): { nx: number; ny: number; nUp: number } | null {
  const ax = mesh.vertexCoords[ia * 2];
  const az = mesh.vertexCoords[ia * 2 + 1];
  const ah = mesh.vertexHeights[ia] ?? 0;
  const ux = mesh.vertexCoords[ib * 2] - ax;
  const uUp = (mesh.vertexHeights[ib] ?? 0) - ah;
  const uz = mesh.vertexCoords[ib * 2 + 1] - az;
  const vx = mesh.vertexCoords[ic * 2] - ax;
  const vUp = (mesh.vertexHeights[ic] ?? 0) - ah;
  const vz = mesh.vertexCoords[ic * 2 + 1] - az;
  let nx = uUp * vz - uz * vUp;
  let nUp = uz * vx - ux * vz;
  let ny = ux * vUp - uUp * vx;
  if (nUp < 0) {
    nx = -nx;
    ny = -ny;
    nUp = -nUp;
  }
  const length = Math.hypot(nx, ny, nUp);
  if (!Number.isFinite(length) || length <= 1e-9) return null;
  return { nx: nx / length, ny: ny / length, nUp: nUp / length };
}

/** Minimal binary heap over (distance, vertex). A plain sort would dominate
 *  the whole pass; a bucket queue would need a fixed quantum. */
class VertexHeap {
  private readonly dist: number[] = [];
  private readonly vertex: number[] = [];

  get size(): number {
    return this.vertex.length;
  }

  push(distance: number, vertex: number): void {
    this.dist.push(distance);
    this.vertex.push(vertex);
    let child = this.vertex.length - 1;
    while (child > 0) {
      const parent = (child - 1) >> 1;
      if (this.dist[parent] <= this.dist[child]) break;
      this.swap(parent, child);
      child = parent;
    }
  }

  pop(): { distance: number; vertex: number } {
    const distance = this.dist[0];
    const vertex = this.vertex[0];
    const lastDist = this.dist.pop() as number;
    const lastVertex = this.vertex.pop() as number;
    if (this.vertex.length > 0) {
      this.dist[0] = lastDist;
      this.vertex[0] = lastVertex;
      let parent = 0;
      for (;;) {
        const left = parent * 2 + 1;
        const right = left + 1;
        let smallest = parent;
        if (left < this.dist.length && this.dist[left] < this.dist[smallest]) smallest = left;
        if (right < this.dist.length && this.dist[right] < this.dist[smallest]) smallest = right;
        if (smallest === parent) break;
        this.swap(parent, smallest);
        parent = smallest;
      }
    }
    return { distance, vertex };
  }

  private swap(a: number, b: number): void {
    const d = this.dist[a];
    this.dist[a] = this.dist[b];
    this.dist[b] = d;
    const v = this.vertex[a];
    this.vertex[a] = this.vertex[b];
    this.vertex[b] = v;
  }
}

/** Compressed adjacency over the mesh's triangle edges. Duplicates are kept
 *  rather than deduplicated — a repeated edge costs one redundant relaxation
 *  that Dijkstra rejects immediately, where deduplicating costs a hash per
 *  edge over the whole terrain. */
function buildAdjacency(
  mesh: TerrainWallWearMesh,
  wallOnly: boolean,
): {
  offsets: Int32Array;
  neighbors: Int32Array;
} {
  const includes = (tri: number): boolean =>
    !wallOnly || (mesh.triangleWallFlags[tri] ?? 0) !== 0;
  const degree = new Int32Array(mesh.vertexCount + 1);
  const bump = (v: number): void => {
    if (v >= 0 && v < mesh.vertexCount) degree[v + 1]++;
  };
  for (let tri = 0; tri < mesh.triangleCount; tri++) {
    if (!includes(tri)) continue;
    const o = tri * 3;
    const ia = mesh.triangleIndices[o];
    const ib = mesh.triangleIndices[o + 1];
    const ic = mesh.triangleIndices[o + 2];
    bump(ia); bump(ia);
    bump(ib); bump(ib);
    bump(ic); bump(ic);
  }
  for (let i = 0; i < mesh.vertexCount; i++) degree[i + 1] += degree[i];
  const offsets = degree;
  const cursor = offsets.slice(0, mesh.vertexCount);
  const neighbors = new Int32Array(offsets[mesh.vertexCount]);
  const link = (a: number, b: number): void => {
    if (a < 0 || a >= mesh.vertexCount || b < 0 || b >= mesh.vertexCount) return;
    neighbors[cursor[a]++] = b;
  };
  for (let tri = 0; tri < mesh.triangleCount; tri++) {
    if (!includes(tri)) continue;
    const o = tri * 3;
    const ia = mesh.triangleIndices[o];
    const ib = mesh.triangleIndices[o + 1];
    const ic = mesh.triangleIndices[o + 2];
    link(ia, ib); link(ib, ia);
    link(ib, ic); link(ic, ib);
    link(ic, ia); link(ia, ic);
  }
  return { offsets, neighbors };
}

/** 3D distance between two mesh vertices. Wear spreads over the surface, so
 *  the height difference counts: at a near-vertical wall the drop is almost
 *  all of the distance, and using XZ alone would let a rim's wear reach the
 *  full width of the terrace below it. */
function vertexDistance(mesh: TerrainWallWearMesh, a: number, b: number): number {
  const dx = mesh.vertexCoords[a * 2] - mesh.vertexCoords[b * 2];
  const dz = mesh.vertexCoords[a * 2 + 1] - mesh.vertexCoords[b * 2 + 1];
  const dh = (mesh.vertexHeights[a] ?? 0) - (mesh.vertexHeights[b] ?? 0);
  return Math.hypot(dx, dz, dh);
}

/** How far past the reach the search still runs. Intensity has to be right on
 *  BOTH ends of every edge that a fragment can interpolate across, and an edge
 *  can leave the reach; searching a margin past it means the far end still
 *  carries its nearest rim's intensity instead of falling to zero and
 *  steepening the falloff. Past this the ramp is zero anyway. */
const SEARCH_MARGIN = 2.5;

/** Multi-source Dijkstra, carrying each seed's intensity along with its
 *  distance so the nearest rim decides both. Writes normalized distance into
 *  `outDistance` (1 = at or past the reach) and the seed intensity into
 *  `outIntensity`. */
function spreadFromSeeds(
  mesh: TerrainWallWearMesh,
  adjacency: { offsets: Int32Array; neighbors: Int32Array },
  seedIntensity: Float32Array,
  reach: number,
  rims: Float32Array,
  slot: number,
): void {
  // FLOAT64, and this is not a micro-optimisation in reverse. Stored in
  // float32, a candidate distance that is genuinely smaller than the stored
  // one can ROUND BACK to it: the improvement test passes, the write changes
  // nothing, and the vertex is enqueued again — forever, shaving less than a
  // ULP each pass. It presents as "RangeError: Invalid array length" from the
  // heap's own backing array, several million relaxations later.
  const distance = new Float64Array(mesh.vertexCount).fill(Number.POSITIVE_INFINITY);
  const intensity = new Float32Array(mesh.vertexCount);
  const heap = new VertexHeap();
  let seeded = false;
  for (let v = 0; v < mesh.vertexCount; v++) {
    if (seedIntensity[v] <= 0) continue;
    distance[v] = 0;
    intensity[v] = seedIntensity[v];
    heap.push(0, v);
    seeded = true;
  }
  if (!seeded) {
    for (let v = 0; v < mesh.vertexCount; v++) {
      rims[v * WALL_WEAR_RIM_STRIDE + slot] = 1;
    }
    return;
  }


  const bound = reach * SEARCH_MARGIN;
  while (heap.size > 0) {
    const { distance: d, vertex: v } = heap.pop();
    // Stale entry: this vertex was already settled at a shorter distance.
    if (d > distance[v]) continue;
    const end = adjacency.offsets[v + 1];
    for (let e = adjacency.offsets[v]; e < end; e++) {
      const n = adjacency.neighbors[e];
      const nd = d + vertexDistance(mesh, v, n);
      if (nd >= bound || nd >= distance[n]) continue;
      distance[n] = nd;
      intensity[n] = intensity[v];
      heap.push(nd, n);
    }
  }

  for (let v = 0; v < mesh.vertexCount; v++) {
    const d = distance[v];
    const base = v * WALL_WEAR_RIM_STRIDE + slot;
    rims[base] = Number.isFinite(d) ? Math.min(1, d / reach) : 1;
    rims[base + 1] = intensity[v];
  }
}

/** The height of the nearest rim of one kind, propagated THROUGH THE WALL
 *  ONLY, written into the third slot.
 *
 *  This is the term that makes the drop measurement work, and it has to be a
 *  separate traversal for a reason worth stating. The main search is bounded
 *  by the reach, so on a cliff taller than the reach the top vertices are
 *  never reached from the bottom rim — and whatever default they carry gets
 *  interpolated down the face by every long thin wall triangle, each pairing
 *  its rim vertices differently. That draws the mesh's triangle columns down
 *  the cliff as vertical stripes, which is precisely the artefact the drop
 *  term exists to remove.
 *
 *  Restricting the traversal to wall triangles makes it cheap enough to run
 *  unbounded: a wall band is a thin strip, not a map. Every vertex of a face
 *  then agrees about which rim is below it and how high that rim is, so the
 *  interpolated height is constant across the face and the drop is exactly
 *  the height above the base. Vertices the wall never reaches keep their own
 *  height, which zeroes the drop — correct, because those are flats, where
 *  the surface is not steep and the shader takes the geodesic term instead. */
function propagateRimHeightThroughWall(
  mesh: TerrainWallWearMesh,
  wallAdjacency: { offsets: Int32Array; neighbors: Int32Array },
  seedIntensity: Float32Array,
  rims: Float32Array,
  slot: number,
): void {
  // FLOAT64, and this is not a micro-optimisation in reverse. Stored in
  // float32, a candidate distance that is genuinely smaller than the stored
  // one can ROUND BACK to it: the improvement test passes, the write changes
  // nothing, and the vertex is enqueued again — forever, shaving less than a
  // ULP each pass. It presents as "RangeError: Invalid array length" from the
  // heap's own backing array, several million relaxations later.
  const distance = new Float64Array(mesh.vertexCount).fill(Number.POSITIVE_INFINITY);
  const height = new Float32Array(mesh.vertexCount);
  for (let v = 0; v < mesh.vertexCount; v++) height[v] = mesh.vertexHeights[v] ?? 0;
  const heap = new VertexHeap();
  for (let v = 0; v < mesh.vertexCount; v++) {
    if (seedIntensity[v] <= 0) continue;
    distance[v] = 0;
    heap.push(0, v);
  }
  while (heap.size > 0) {
    const { distance: d, vertex: v } = heap.pop();
    if (d > distance[v]) continue;
    const end = wallAdjacency.offsets[v + 1];
    for (let e = wallAdjacency.offsets[v]; e < end; e++) {
      const n = wallAdjacency.neighbors[e];
      const nd = d + vertexDistance(mesh, v, n);
      if (nd >= distance[n]) continue;
      distance[n] = nd;
      height[n] = height[v];
      heap.push(nd, n);
    }
  }
  for (let v = 0; v < mesh.vertexCount; v++) {
    rims[v * WALL_WEAR_RIM_STRIDE + slot + 2] = height[v];
  }
}

/** Where the rims are, how sharp they are, and how far their wear reaches.
 *
 *  Runs once per terrain geometry build. The terrain is immutable for the
 *  match, so this never re-runs during play. */
export function computeTerrainWallWear(mesh: TerrainWallWearMesh): TerrainWallWear {
  // No rim reached means distance 1 (past the reach) and intensity 0, which
  // is the shader's "nothing here" and takes its early-out.
  const empty = (): TerrainWallWear => {
    const rims = new Float32Array(Math.max(0, mesh.vertexCount) * WALL_WEAR_RIM_STRIDE);
    for (let v = 0; v < mesh.vertexCount; v++) {
      const base = v * WALL_WEAR_RIM_STRIDE;
      rims[base] = 1;
      rims[base + 3] = 1;
      rims[base + 2] = mesh.vertexHeights[v] ?? 0;
      rims[base + 5] = mesh.vertexHeights[v] ?? 0;
    }
    return { rims };
  };
  if (mesh.vertexCount <= 0 || mesh.triangleCount <= 0) return empty();

  // Per vertex: which classes of triangle touch it, the summed face normal of
  // each class, and the summed height of the wall-side neighbours (which is
  // what separates a top rim from a bottom one).
  const classMask = new Uint8Array(mesh.vertexCount);
  const classNormals = new Float64Array(mesh.vertexCount * 6);
  const wallNeighborHeightSum = new Float64Array(mesh.vertexCount);
  const wallNeighborCount = new Int32Array(mesh.vertexCount);

  for (let tri = 0; tri < mesh.triangleCount; tri++) {
    const o = tri * 3;
    const ia = mesh.triangleIndices[o];
    const ib = mesh.triangleIndices[o + 1];
    const ic = mesh.triangleIndices[o + 2];
    if (ia < 0 || ib < 0 || ic < 0) continue;
    const isWall = (mesh.triangleWallFlags[tri] ?? 0) !== 0;
    const bit = isWall ? 0b10 : 0b01;
    classMask[ia] |= bit;
    classMask[ib] |= bit;
    classMask[ic] |= bit;
    const normal = faceNormal(mesh, ia, ib, ic);
    if (normal) {
      const slot = isWall ? 3 : 0;
      for (const v of [ia, ib, ic]) {
        const off = v * 6 + slot;
        classNormals[off] += normal.nx;
        classNormals[off + 1] += normal.ny;
        classNormals[off + 2] += normal.nUp;
      }
    }
    if (isWall) {
      const ha = mesh.vertexHeights[ia] ?? 0;
      const hb = mesh.vertexHeights[ib] ?? 0;
      const hc = mesh.vertexHeights[ic] ?? 0;
      wallNeighborHeightSum[ia] += hb + hc;
      wallNeighborCount[ia] += 2;
      wallNeighborHeightSum[ib] += ha + hc;
      wallNeighborCount[ib] += 2;
      wallNeighborHeightSum[ic] += ha + hb;
      wallNeighborCount[ic] += 2;
    }
  }

  const minAngle = Math.min(
    TERRAIN_WALL_WEAR_MIN_ANGLE_DEGREES,
    TERRAIN_WALL_WEAR_MAX_ANGLE_DEGREES,
  );
  const maxAngle = Math.max(
    TERRAIN_WALL_WEAR_MIN_ANGLE_DEGREES,
    TERRAIN_WALL_WEAR_MAX_ANGLE_DEGREES,
  );
  const topSeeds = new Float32Array(mesh.vertexCount);
  const bottomSeeds = new Float32Array(mesh.vertexCount);
  let anyRim = false;

  for (let v = 0; v < mesh.vertexCount; v++) {
    // A rim vertex is one both a wall triangle and a ground triangle touch.
    // That set IS the two corner lines; nothing else has to identify them.
    if ((classMask[v] & 0b11) !== 0b11) continue;
    const off = v * 6;
    const gLen = Math.hypot(classNormals[off], classNormals[off + 1], classNormals[off + 2]);
    const wLen = Math.hypot(classNormals[off + 3], classNormals[off + 4], classNormals[off + 5]);
    if (gLen <= 1e-9 || wLen <= 1e-9) continue;
    const dot =
      (classNormals[off] * classNormals[off + 3] +
        classNormals[off + 1] * classNormals[off + 4] +
        classNormals[off + 2] * classNormals[off + 5]) /
      (gLen * wLen);
    // THE SAFETY PROPERTY. A wall flattened flush into the terrain has
    // coincident class normals, so this angle is zero and the whole treatment
    // switches itself off there — no wear, no exposure of a step the map
    // deliberately erased.
    const angleDegrees = (Math.acos(Math.min(1, Math.max(-1, dot))) * 180) / Math.PI;
    if (angleDegrees <= minAngle) continue;
    const intensity = Math.min(
      1,
      (angleDegrees - minAngle) / Math.max(1e-6, maxAngle - minAngle),
    );
    if (intensity <= 0) continue;

    // Top or bottom: at a top rim the wall falls away below, so the wall-side
    // neighbours average lower than the rim itself. At a bottom rim they
    // average higher.
    const count = wallNeighborCount[v];
    const neighborMean = count > 0 ? wallNeighborHeightSum[v] / count : 0;
    const height = mesh.vertexHeights[v] ?? 0;
    if (count === 0) continue;
    if (height >= neighborMean) topSeeds[v] = intensity;
    else bottomSeeds[v] = intensity;
    anyRim = true;
  }

  if (!anyRim) return empty();

  const reach = Math.max(1, TERRAIN_WALL_WEAR_REACH_WORLD_UNITS);
  const adjacency = buildAdjacency(mesh, false);
  const wallAdjacency = buildAdjacency(mesh, true);
  const rims = new Float32Array(mesh.vertexCount * WALL_WEAR_RIM_STRIDE);
  spreadFromSeeds(mesh, adjacency, topSeeds, reach, rims, 0);
  spreadFromSeeds(mesh, adjacency, bottomSeeds, reach, rims, 3);
  propagateRimHeightThroughWall(mesh, wallAdjacency, topSeeds, rims, 0);
  propagateRimHeightThroughWall(mesh, wallAdjacency, bottomSeeds, rims, 3);
  return { rims };
}

// ── The shader half ────────────────────────────────────────────────────────

/** Both rims paint the SAME substance — the soil every weathered boundary in
 *  the game uses — because a worn rim is grit and dust, and grit is grit. They
 *  differ in exposure and in tuning, which is what separates a dry pale top
 *  that has spalled and shed from a damp dark bottom that has collected what
 *  fell. Two substances here would be two materials pretending to be the same
 *  weather on two ends of one wall. */
export type TerrainWallWearUniforms = {
  enabled: { value: number };
  noiseTileWorldSize: { value: number };
  soilTileWorldSize: { value: number };
  reach: { value: number };
  grow: { value: number };
  warp: { value: number };
  grain: { value: number };
  variation: { value: number };
  matte: { value: number };
  topTint: { value: THREE.Vector3 };
  topExposure: { value: number };
  topStrength: { value: number };
  topDarken: { value: number };
  topSeamPower: { value: number };
  topFalloff: { value: number };
  topPatchDepth: { value: number };
  bottomTint: { value: THREE.Vector3 };
  bottomExposure: { value: number };
  bottomStrength: { value: number };
  bottomDarken: { value: number };
  bottomSeamPower: { value: number };
  bottomFalloff: { value: number };
  bottomPatchDepth: { value: number };
};

export function createTerrainWallWearUniforms(enabled: boolean): TerrainWallWearUniforms {
  const cfg = TERRAIN_WALL_WEAR;
  return {
    enabled: { value: enabled ? 1 : 0 },
    noiseTileWorldSize: { value: cfg.noiseTileWorldSize },
    soilTileWorldSize: { value: SOIL_SUBSTANCE_TILE_WORLD_SIZE },
    reach: { value: TERRAIN_WALL_WEAR_REACH_WORLD_UNITS },
    grow: { value: cfg.growWorldUnits },
    warp: { value: cfg.warpWorldUnits },
    grain: { value: cfg.grainStrength },
    variation: { value: cfg.thicknessVariation },
    matte: { value: cfg.matte },
    topTint: { value: new THREE.Vector3(...cfg.top.tint) },
    topExposure: { value: cfg.top.exposure },
    topStrength: { value: cfg.top.strength },
    topDarken: { value: cfg.top.darken },
    topSeamPower: { value: cfg.top.seamPower },
    topFalloff: { value: cfg.top.falloff },
    topPatchDepth: { value: cfg.top.patchDepth },
    bottomTint: { value: new THREE.Vector3(...cfg.bottom.tint) },
    bottomExposure: { value: cfg.bottom.exposure },
    bottomStrength: { value: cfg.bottom.strength },
    bottomDarken: { value: cfg.bottom.darken },
    bottomSeamPower: { value: cfg.bottom.seamPower },
    bottomFalloff: { value: cfg.bottom.falloff },
    bottomPatchDepth: { value: cfg.bottom.patchDepth },
  };
}

export function assignTerrainWallWearUniforms(
  shader: { uniforms: Record<string, { value: unknown }> },
  uniforms: TerrainWallWearUniforms,
): void {
  shader.uniforms.uWallWearEnabled = uniforms.enabled;
  shader.uniforms.uWallWearNoiseTileWorldSize = uniforms.noiseTileWorldSize;
  shader.uniforms.uWallWearSoilTileWorldSize = uniforms.soilTileWorldSize;
  shader.uniforms.uWallWearReach = uniforms.reach;
  shader.uniforms.uWallWearGrow = uniforms.grow;
  shader.uniforms.uWallWearWarp = uniforms.warp;
  shader.uniforms.uWallWearGrain = uniforms.grain;
  shader.uniforms.uWallWearVariation = uniforms.variation;
  shader.uniforms.uWallWearMatte = uniforms.matte;
  shader.uniforms.uWallWearTopTint = uniforms.topTint;
  shader.uniforms.uWallWearTopExposure = uniforms.topExposure;
  shader.uniforms.uWallWearTopStrength = uniforms.topStrength;
  shader.uniforms.uWallWearTopDarken = uniforms.topDarken;
  shader.uniforms.uWallWearTopSeamPower = uniforms.topSeamPower;
  shader.uniforms.uWallWearTopFalloff = uniforms.topFalloff;
  shader.uniforms.uWallWearTopPatchDepth = uniforms.topPatchDepth;
  shader.uniforms.uWallWearBottomTint = uniforms.bottomTint;
  shader.uniforms.uWallWearBottomExposure = uniforms.bottomExposure;
  shader.uniforms.uWallWearBottomStrength = uniforms.bottomStrength;
  shader.uniforms.uWallWearBottomDarken = uniforms.bottomDarken;
  shader.uniforms.uWallWearBottomSeamPower = uniforms.bottomSeamPower;
  shader.uniforms.uWallWearBottomFalloff = uniforms.bottomFalloff;
  shader.uniforms.uWallWearBottomPatchDepth = uniforms.bottomPatchDepth;
}

export function terrainWallWearUniformDeclarations(): string {
  return [
    'uniform float uWallWearEnabled;',
    // Both textures arrive through the shared weathering samplers the host
    // declares once; the rims own only how big they read.
    'uniform float uWallWearNoiseTileWorldSize;',
    'uniform float uWallWearSoilTileWorldSize;',
    'uniform float uWallWearReach;',
    'uniform float uWallWearGrow;',
    'uniform float uWallWearWarp;',
    'uniform float uWallWearGrain;',
    'uniform float uWallWearVariation;',
    'uniform float uWallWearMatte;',
    'uniform vec3 uWallWearTopTint;',
    'uniform float uWallWearTopExposure;',
    'uniform float uWallWearTopStrength;',
    'uniform float uWallWearTopDarken;',
    'uniform float uWallWearTopSeamPower;',
    'uniform float uWallWearTopFalloff;',
    'uniform float uWallWearTopPatchDepth;',
    'uniform vec3 uWallWearBottomTint;',
    'uniform float uWallWearBottomExposure;',
    'uniform float uWallWearBottomStrength;',
    'uniform float uWallWearBottomDarken;',
    'uniform float uWallWearBottomSeamPower;',
    'uniform float uWallWearBottomFalloff;',
    'uniform float uWallWearBottomPatchDepth;',
  ].join('\n');
}

/** The per-rim amount, from the per-vertex proximity ramp.
 *
 *  The ramp arrives normalized — 1 at the rim, 0 at the reach — because the
 *  CPU folded the dihedral angle into it, which is what makes a flattened
 *  wall carry a flat zero and take the early-out. Converting it back to world
 *  units before displacing is deliberate: the grow and the warp are authored
 *  in world units like every other weathering distance in the game, so a
 *  short terrace and a tall cliff wear by the same physical amount rather
 *  than by the same fraction of themselves. */
export const TERRAIN_WALL_WEAR_GLSL = [
  '// How far this fragment is from its rim, in world units.',
  '//',
  '// Two measurements, blended by how steep the surface is, because neither',
  '// works everywhere. The interpolated geodesic distance is right on the',
  '// flat, where the mesh has vertices to interpolate between. On a wall face',
  '// it is worthless: the face has no interior vertices, adjacent long thin',
  '// triangles pair their rim vertices differently, and the result is',
  '// piecewise-linear with a kink at every triangle edge — which draws the',
  '// mesh\'s own triangle columns down the cliff as evenly spaced vertical',
  '// stripes. The drop below the rim has no such problem, because every',
  '// vertex of a wall face shares one rim height.',
  '//',
  '// Both terms are zero AT the rim, so the blend cannot introduce a seam',
  '// there — which is the one place a seam would be unforgivable.',
  'float terrainWallRimDistance(',
  '  float normalizedDistance,',
  '  float rimHeight,',
  '  float worldHeight,',
  '  vec3 geometricNormal,',
  '  float reach',
  ') {',
  '  float flatDistance = clamp(normalizedDistance, 0.0, 1.0) * max(reach, 1.0);',
  '  float dropDistance = abs(worldHeight - rimHeight);',
  '  float steep = smoothstep(0.30, 0.75, 1.0 - abs(geometricNormal.y));',
  '  return mix(flatDistance, dropDistance, steep);',
  '}',
  '',
  'float terrainWallWearAmount(',
  '  float distance,',
  '  float intensity,',
  '  WeatherFields fields,',
  '  float reach,',
  '  float grow,',
  '  float warp,',
  '  float distanceWidth,',
  '  float grainStrength,',
  '  float variation,',
  '  float falloff,',
  '  float patchDepth',
  ') {',
  '  float span = max(reach, 1.0);',
  '  // World units throughout: the grow and the warp are authored like every',
  '  // other weathering distance in the game, so a short terrace and a tall',
  '  // cliff wear by the same physical amount rather than by the same',
  '  // fraction of themselves.',
  '  float displaced = weatherDisplace(distance, fields, grow, warp);',
  '  float worn = weatherJitterRamp(clamp(1.0 - displaced / span, 0.0, 1.0), fields, variation);',
  '  // The dissolve bites only in the outer half, so the wear is solid where',
  '  // it hugs the rim and crumbles away at its far edge. Dissolving the whole',
  '  // ramp instead would punch holes in the fold itself, which reads as',
  '  // damage to the terrain rather than as dirt on it.',
  '  float crumble = weatherDissolve(clamp(worn * 2.0, 0.0, 1.0), fields, distanceWidth * 2.0, grainStrength);',
  '  return weatherGrimeAmount(worn, fields, falloff, patchDepth) * crumble * clamp(intensity, 0.0, 1.0);',
  '}',
].join('\n');

/** How much of a metal reflection the wear suppresses.
 *
 *  Ore runs off its flat pad and down a terrace often enough that the two
 *  treatments overlap in the ordinary case, and dirt is dirt whichever one
 *  laid it down: a rim buried in debris must not still carry the ore's
 *  environment highlight tracing the fold. Exported rather than inlined at
 *  the injection site so the uniform is read where it is declared. */
export function terrainWallWearMatteCoverage(coverageExpr: string): string {
  return `${coverageExpr} * (1.0 - uWallWearMatte * terrainWallWear)`;
}

/** Resolves both rims and dirties the surface with them.
 *
 *  Exported as source so a contract test can read the shipped strings.
 *
 *  Host contract: the varyings `vTerrainWallRimTop` and
 *  `vTerrainWallRimBottom` — each (normalized distance, intensity, rim
 *  height) — the screen width `wallWearDistanceWidth` measured at TOP LEVEL,
 *  a mutable `vec3 terrainRgb`, the world position varying and the geometric
 *  normal. Declares `terrainWallWear`, the combined amount the PBR half
 *  mattes by. */
export function terrainWallWearFragment(
  worldPositionExpr: string,
  geometricNormalExpr: string,
): string {
  return [
    'float terrainWallWear = 0.0;',
    // The intensity is zero everywhere except within reach of a rim that has
    // a real dihedral angle — which is what makes a wall flattened flush into
    // the terrain cost nothing and, more importantly, show nothing.
    'if (uWallWearEnabled > 0.0 && max(vTerrainWallRimTop.y, vTerrainWallRimBottom.y) > 0.0) {',
    '  WeatherFields wallFields = weatherSampleFields(',
    `    ${WEATHER_NOISE_SAMPLER},`,
    // NOT world XZ. A near-vertical wall barely moves in XZ, so every field
    // would be constant down its face and the whole treatment would streak
    // vertically — which is exactly what it did before this line.
    //
    // And the normal handed in here MUST be the smooth interpolated one, not
    // the geometric face normal the rest of the terrain shader uses. The
    // plane blend is continuous in the normal, but a wall's face normal is
    // not continuous ACROSS it: neighbouring long thin wall triangles pair
    // their rim vertices differently and so face slightly different ways, and
    // that jump lands straight in the sampling coordinate. The result is the
    // mesh's own triangle columns drawn down the cliff as evenly spaced
    // vertical stripes — measured, not theorised.
    `    weatherSurfacePlane(${worldPositionExpr}, ${geometricNormalExpr}),`,
    '    uWallWearNoiseTileWorldSize',
    '  );',
    '  vec3 wallSoil = weatherSampleSubstance(',
    `    ${WEATHER_SOIL_SAMPLER},`,
    `    ${worldPositionExpr},`,
    `    ${geometricNormalExpr},`,
    '    uWallWearSoilTileWorldSize',
    '  );',
    '  float topDistance = terrainWallRimDistance(',
    `    vTerrainWallRimTop.x, vTerrainWallRimTop.z, ${worldPositionExpr}.y,`,
    `    ${geometricNormalExpr}, uWallWearReach`,
    '  );',
    '  float bottomDistance = terrainWallRimDistance(',
    `    vTerrainWallRimBottom.x, vTerrainWallRimBottom.z, ${worldPositionExpr}.y,`,
    `    ${geometricNormalExpr}, uWallWearReach`,
    '  );',
    '  float topWear = terrainWallWearAmount(',
    '    topDistance, vTerrainWallRimTop.y, wallFields,',
    '    uWallWearReach, uWallWearGrow, uWallWearWarp,',
    '    wallWearDistanceWidth, uWallWearGrain, uWallWearVariation,',
    '    uWallWearTopFalloff, uWallWearTopPatchDepth',
    '  );',
    '  float bottomWear = terrainWallWearAmount(',
    '    bottomDistance, vTerrainWallRimBottom.y, wallFields,',
    '    uWallWearReach, uWallWearGrow, uWallWearWarp,',
    '    wallWearDistanceWidth, uWallWearGrain, uWallWearVariation,',
    '    uWallWearBottomFalloff, uWallWearBottomPatchDepth',
    '  );',
    '  // Bottom first, top over it. Where a terrace is short enough that the',
    '  // two bands overlap, what shows at the fold is the spall — which is',
    '  // right: a rim that has worn through has shed onto its own base.',
    '  terrainRgb = weatherApplyGrime(',
    '    terrainRgb, wallSoil * uWallWearBottomTint * uWallWearBottomExposure,',
    '    bottomWear, uWallWearBottomStrength, uWallWearBottomDarken, uWallWearBottomSeamPower',
    '  );',
    '  terrainRgb = weatherApplyGrime(',
    '    terrainRgb, wallSoil * uWallWearTopTint * uWallWearTopExposure,',
    '    topWear, uWallWearTopStrength, uWallWearTopDarken, uWallWearTopSeamPower',
    '  );',
    '  terrainWallWear = clamp(max(topWear, bottomWear), 0.0, 1.0);',
    '}',
  ].join('\n');
}

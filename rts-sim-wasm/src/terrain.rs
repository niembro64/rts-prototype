// terrain — extracted from lib.rs (pure code motion).

#[allow(unused_imports)]
use crate::*;
#[allow(unused_imports)]
use wasm_bindgen::prelude::*;

// ─────────────────────────────────────────────────────────────────
//  Phase 8 — Terrain heightmap in WASM linear memory
//
//  Mirrors the read side of src/game/sim/terrain/terrainTileMap.ts:
//    terrainTriangleSampleFromGlobalMesh  +  terrainBarycentricAt
//    terrainMeshHeightFromSample (triangle branch)
//    terrainMeshNormalFromSample (triangle branch)
//  plus the WATER_LEVEL clamp / below-water-up-vector semantics from
//  terrainSurface.ts.
//
//  The 8 mesh arrays land in WASM linear memory once at world-load
//  via `terrain_install_mesh` (called by the JS-side
//  setAuthoritativeTerrainTileMap install hook). Per-call samplers
//  walk the cell's triangle bucket and barycentric-interpolate
//  directly from those Vecs — no JS callback, no per-call
//  marshalling.
//
//  Fallback path (bilinear quad over the noise generator) is NOT
//  ported here. The triangle walk should always find a containing
//  triangle in a real match; the rare-case fallback in
//  `getTerrainMeshSample` is only hit before the mesh is baked or
//  for points outside the map (already clamped away). Rust signals
//  "no triangle found" by returning NaN from height and 0 from
//  normal; JS falls back to the TS path on either sentinel.
// ─────────────────────────────────────────────────────────────────

// TERRAIN_TILE_FLOOR_Y / TERRAIN_WATER_LEVEL are generated from
// src/game/sim/terrain/terrainConfig.json (same fields terrainConfig.ts
// reads), so the sim's waterline cannot drift from the TS side.
include!(concat!(env!("OUT_DIR"), "/terrain_constants.rs"));

// Matches terrainTileMap.ts TERRAIN_MESH_EPSILON for the degenerate
// barycentric guard.
pub(crate) const TERRAIN_MESH_EPSILON: f64 = 1e-6;
pub(crate) const TERRAIN_MESH_EDGE_EPSILON: f64 = 1e-4;
pub(crate) const TERRAIN_PLATEAU_CONSTRAINT_EPSILON: f64 = 1e-7;
pub(crate) const TERRAIN_INV_SQRT3: f64 = 0.5773502691896258;
pub(crate) const TERRAIN_EDGE_LINE_KEY_BIAS: i64 = 0x100000000;
pub(crate) const TERRAIN_EDGE_LINE_KEY_STRIDE: i64 = 0x200000000;

mod mesh;
#[allow(unused_imports)]
pub(crate) use mesh::*;
pub(crate) struct TerrainGrid {
    map_width: f64,
    map_height: f64,
    cell_size: f64,
    subdiv: i32,
    cells_x: i32,
    cells_y: i32,
    pub(crate) installed: bool,
    // mesh storage — names mirror TerrainTileMap field names in
    // src/types/terrain.ts (without the "mesh" prefix since this is
    // already inside a terrain struct).
    vertex_coords: Vec<f64>, // (x, z) pairs, length = 2 * vertex_count
    vertex_heights: Vec<f64>,
    triangle_indices: Vec<i32>, // (ia, ib, ic) triples, length = 3 * triangle_count
    triangle_levels: Vec<i32>,
    neighbor_indices: Vec<i32>,
    neighbor_levels: Vec<i32>,
    cell_triangle_offsets: Vec<i32>,
    cell_triangle_indices: Vec<i32>,
    /// Per-cell maximum vertex height over every triangle listed for the
    /// cell (conservative — listed triangles may overhang the cell).
    /// Built at install; terrain_has_line_of_sight uses it to fast-accept
    /// sightlines whose minimum altitude clears every crossed cell's max,
    /// skipping the per-step triangle march entirely.
    cell_max_height: Vec<f64>,
}

impl TerrainGrid {
    const fn empty() -> Self {
        Self {
            map_width: 0.0,
            map_height: 0.0,
            cell_size: 0.0,
            subdiv: 0,
            cells_x: 0,
            cells_y: 0,
            installed: false,
            vertex_coords: Vec::new(),
            vertex_heights: Vec::new(),
            triangle_indices: Vec::new(),
            triangle_levels: Vec::new(),
            neighbor_indices: Vec::new(),
            neighbor_levels: Vec::new(),
            cell_triangle_offsets: Vec::new(),
            cell_triangle_indices: Vec::new(),
            cell_max_height: Vec::new(),
        }
    }
}

pub(crate) static TERRAIN_GRID: WasmGlobal<TerrainGrid> = WasmGlobal::new(TerrainGrid::empty());

#[inline]
pub(crate) fn terrain_grid() -> &'static mut TerrainGrid {
    TERRAIN_GRID.get()
}

#[wasm_bindgen]
pub fn terrain_install_mesh(
    vertex_coords: &[f64],
    vertex_heights: &[f64],
    triangle_indices: &[i32],
    triangle_levels: &[i32],
    neighbor_indices: &[i32],
    neighbor_levels: &[i32],
    cell_triangle_offsets: &[i32],
    cell_triangle_indices: &[i32],
    map_width: f64,
    map_height: f64,
    cell_size: f64,
    subdiv: i32,
    cells_x: i32,
    cells_y: i32,
) {
    let t = terrain_grid();
    t.vertex_coords.clear();
    t.vertex_coords.extend_from_slice(vertex_coords);
    t.vertex_heights.clear();
    t.vertex_heights.extend_from_slice(vertex_heights);
    t.triangle_indices.clear();
    t.triangle_indices.extend_from_slice(triangle_indices);
    t.triangle_levels.clear();
    t.triangle_levels.extend_from_slice(triangle_levels);
    t.neighbor_indices.clear();
    t.neighbor_indices.extend_from_slice(neighbor_indices);
    t.neighbor_levels.clear();
    t.neighbor_levels.extend_from_slice(neighbor_levels);
    t.cell_triangle_offsets.clear();
    t.cell_triangle_offsets
        .extend_from_slice(cell_triangle_offsets);
    t.cell_triangle_indices.clear();
    t.cell_triangle_indices
        .extend_from_slice(cell_triangle_indices);
    t.map_width = map_width;
    t.map_height = map_height;
    t.cell_size = cell_size;
    t.subdiv = subdiv;
    t.cells_x = cells_x;
    t.cells_y = cells_y;
    terrain_rebuild_cell_max_heights(t);
    t.installed = true;
}

/// Amanatides–Woo traversal of the 2D cell grid under the sightline,
/// early-accepting when every crossed cell's conservative max height is
/// at or below the segment's minimum altitude. Returns false whenever it
/// cannot PROVE clearance (tall cell, endpoint outside the grid, empty
/// table) — callers then run the exact march, so this can only shortcut
/// to the same answer the march would produce.
fn terrain_los_fast_accept(
    t: &TerrainGrid,
    sx: f64,
    sy: f64,
    sz: f64,
    tx: f64,
    ty: f64,
    tz: f64,
) -> bool {
    if t.cell_max_height.is_empty() || t.cell_size <= 0.0 {
        return false;
    }
    let cs = t.cell_size;
    let cells_x = t.cells_x;
    let cells_y = t.cells_y;
    let max_x = cells_x as f64 * cs;
    let max_y = cells_y as f64 * cs;
    // Out-of-bounds endpoints clamp per-sample in the exact march; the
    // traversal below has no clamping, so only in-bounds segments take
    // the fast path.
    if sx < 0.0 || sy < 0.0 || tx < 0.0 || ty < 0.0
        || sx >= max_x || sy >= max_y || tx >= max_x || ty >= max_y
    {
        return false;
    }
    let mut cx = (sx / cs).floor() as i32;
    let mut cy = (sy / cs).floor() as i32;
    let end_cx = (tx / cs).floor() as i32;
    let end_cy = (ty / cs).floor() as i32;
    let dx = tx - sx;
    let dy = ty - sy;
    let dz = tz - sz;
    let step_x: i32 = if dx > 0.0 { 1 } else { -1 };
    let step_y: i32 = if dy > 0.0 { 1 } else { -1 };
    // Parametric distance to the first x/y cell boundary and per-cell
    // increments; f64::INFINITY legs never advance that axis.
    let inv_dx = if dx != 0.0 { 1.0 / dx } else { f64::INFINITY };
    let inv_dy = if dy != 0.0 { 1.0 / dy } else { f64::INFINITY };
    let next_boundary_x = if dx > 0.0 { (cx + 1) as f64 * cs } else { cx as f64 * cs };
    let next_boundary_y = if dy > 0.0 { (cy + 1) as f64 * cs } else { cy as f64 * cs };
    let mut t_max_x = if dx != 0.0 { (next_boundary_x - sx) * inv_dx } else { f64::INFINITY };
    let mut t_max_y = if dy != 0.0 { (next_boundary_y - sy) * inv_dy } else { f64::INFINITY };
    let t_delta_x = if dx != 0.0 { (cs * inv_dx).abs() } else { f64::INFINITY };
    let t_delta_y = if dy != 0.0 { (cs * inv_dy).abs() } else { f64::INFINITY };
    // Per-cell altitude bound: the sightline's minimum z OVER THE CELL'S
    // crossing interval [t_enter, t_exit], not the whole segment — a
    // high-to-low sightline stays acceptable near its high end instead
    // of bailing at the first cell taller than the far endpoint. ray z
    // is linear in t, so the interval minimum sits at an endpoint.
    let mut t_enter = 0.0_f64;
    // Cell count along the traversal is bounded by the Manhattan cell
    // distance + 1; guard against float-edge livelock all the same.
    let max_steps = ((end_cx - cx).abs() + (end_cy - cy).abs() + 2) as u32;
    for _ in 0..max_steps {
        if cx < 0 || cy < 0 || cx >= cells_x || cy >= cells_y {
            return false;
        }
        let at_end = cx == end_cx && cy == end_cy;
        let t_exit = if at_end {
            1.0
        } else {
            t_max_x.min(t_max_y).min(1.0)
        };
        let z_enter = sz + dz * t_enter;
        let z_exit = sz + dz * t_exit;
        let cell_min_ray_z = z_enter.min(z_exit);
        let cell = (cy as usize) * (cells_x as usize) + cx as usize;
        if t.cell_max_height[cell] > cell_min_ray_z {
            return false;
        }
        if at_end {
            return true;
        }
        t_enter = t_exit;
        if t_max_x < t_max_y {
            t_max_x += t_delta_x;
            cx += step_x;
        } else {
            t_max_y += t_delta_y;
            cy += step_y;
        }
    }
    false
}

/// Rebuilds the per-cell max-height table from the installed mesh. Each
/// cell's value is the EXACT height maximum over the intersection of the
/// cell rectangle with its listed triangles (heights are linear inside a
/// triangle, so extrema sit at clipped-polygon vertices) — an overhanging
/// summit triangle no longer poisons every cell it merely touches. Cells
/// with no overlapping geometry get NEG_INFINITY (never block).
fn terrain_rebuild_cell_max_heights(t: &mut TerrainGrid) {
    let cells_x = t.cells_x.max(0) as usize;
    let cells_y = t.cells_y.max(0) as usize;
    let cell_count = cells_x * cells_y;
    t.cell_max_height.clear();
    t.cell_max_height.resize(cell_count, f64::NEG_INFINITY);
    let cs = t.cell_size;
    let mut a = [(0.0_f64, 0.0_f64, 0.0_f64); TERRAIN_CLIP_VERTEX_CAPACITY];
    let mut b = [(0.0_f64, 0.0_f64, 0.0_f64); TERRAIN_CLIP_VERTEX_CAPACITY];
    for cell in 0..cell_count {
        let cell_x = (cell % cells_x) as f64;
        let cell_y = (cell / cells_x) as f64;
        let rect_min_x = cell_x * cs;
        let rect_max_x = rect_min_x + cs;
        let rect_min_y = cell_y * cs;
        let rect_max_y = rect_min_y + cs;
        let start = t.cell_triangle_offsets[cell] as usize;
        let end = t.cell_triangle_offsets[cell + 1] as usize;
        let mut max_h = f64::NEG_INFINITY;
        for &tri in &t.cell_triangle_indices[start..end] {
            let base = tri as usize * 3;
            for k in 0..3 {
                let v = t.triangle_indices[base + k] as usize;
                a[k] = (
                    t.vertex_coords[v * 2],
                    t.vertex_coords[v * 2 + 1],
                    t.vertex_heights[v],
                );
            }
            let mut len = terrain_clip_polygon_axis(&a, 3, &mut b, 0, rect_min_x, true);
            len = terrain_clip_polygon_axis(&b, len, &mut a, 0, rect_max_x, false);
            len = terrain_clip_polygon_axis(&a, len, &mut b, 1, rect_min_y, true);
            len = terrain_clip_polygon_axis(&b, len, &mut a, 1, rect_max_y, false);
            for vertex in a.iter().take(len) {
                if vertex.2 > max_h {
                    max_h = vertex.2;
                }
            }
        }
        t.cell_max_height[cell] = max_h;
    }
}

#[wasm_bindgen]
pub fn terrain_clear() {
    let t = terrain_grid();
    t.installed = false;
    // Drop Vec contents so the memory comes back to Rust's allocator
    // — installs are rare so the next install will reallocate.
    t.vertex_coords.clear();
    t.vertex_heights.clear();
    t.triangle_indices.clear();
    t.triangle_levels.clear();
    t.neighbor_indices.clear();
    t.neighbor_levels.clear();
    t.cell_triangle_offsets.clear();
    t.cell_triangle_indices.clear();
    t.cell_max_height.clear();
}

#[wasm_bindgen]
pub fn terrain_is_installed() -> u32 {
    if terrain_grid().installed {
        1
    } else {
        0
    }
}

#[wasm_bindgen]
pub fn terrain_metadata(out_buf: &mut [f64]) {
    debug_assert!(out_buf.len() >= 6);
    let t = terrain_grid();
    out_buf[0] = t.map_width;
    out_buf[1] = t.map_height;
    out_buf[2] = t.cell_size;
    out_buf[3] = t.subdiv as f64;
    out_buf[4] = t.cells_x as f64;
    out_buf[5] = t.cells_y as f64;
}

#[inline]
pub(crate) fn terrain_barycentric_at(
    px: f64,
    pz: f64,
    ax: f64,
    az: f64,
    bx: f64,
    bz: f64,
    cx: f64,
    cz: f64,
) -> Option<(f64, f64, f64)> {
    let denom = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
    if denom.abs() <= TERRAIN_MESH_EPSILON {
        return None;
    }
    let inv = 1.0 / denom;
    let wa = ((bz - cz) * (px - cx) + (cx - bx) * (pz - cz)) * inv;
    let wb = ((cz - az) * (px - cx) + (ax - cx) * (pz - cz)) * inv;
    Some((wa, wb, 1.0 - wa - wb))
}

#[inline]
pub(crate) fn normalize_barycentric_weights(wa: f64, wb: f64, wc: f64) -> (f64, f64, f64) {
    let ca = wa.max(0.0);
    let cb = wb.max(0.0);
    let cc = wc.max(0.0);
    let sum = ca + cb + cc;
    if sum <= 0.0 {
        return (1.0, 0.0, 0.0);
    }
    let inv = 1.0 / sum;
    (ca * inv, cb * inv, cc * inv)
}

/// Triangle sample tuple: (wa, wb, wc, ax, az, ah, bx, bz, bh, cx, cz, ch).
/// Same shape as TerrainTriangleSample in terrainTileMap.ts.
pub(crate) type TerrainTriangleSample = (
    f64,
    f64,
    f64, // weights
    f64,
    f64,
    f64, // a (x, z, h)
    f64,
    f64,
    f64, // b
    f64,
    f64,
    f64, // c
);

#[inline]
pub(crate) fn terrain_height_from_triangle_sample(sample: TerrainTriangleSample) -> f64 {
    let (wa, wb, wc, _, _, ah, _, _, bh, _, _, ch) = sample;
    wa * ah + wb * bh + wc * ch
}

#[inline]
pub(crate) fn terrain_triangle_sample_from_index(
    t: &TerrainGrid,
    tri: usize,
) -> Option<TerrainTriangleSample> {
    let tri_offset = tri * 3;
    let ia = *t.triangle_indices.get(tri_offset)? as usize;
    let ib = *t.triangle_indices.get(tri_offset + 1)? as usize;
    let ic = *t.triangle_indices.get(tri_offset + 2)? as usize;
    let ax = *t.vertex_coords.get(ia * 2)?;
    let az = *t.vertex_coords.get(ia * 2 + 1)?;
    let ah = *t.vertex_heights.get(ia)?;
    let bx = *t.vertex_coords.get(ib * 2)?;
    let bz = *t.vertex_coords.get(ib * 2 + 1)?;
    let bh = *t.vertex_heights.get(ib)?;
    let cx = *t.vertex_coords.get(ic * 2)?;
    let cz = *t.vertex_coords.get(ic * 2 + 1)?;
    let ch = *t.vertex_heights.get(ic)?;
    Some((
        1.0 / 3.0,
        1.0 / 3.0,
        1.0 / 3.0,
        ax,
        az,
        ah,
        bx,
        bz,
        bh,
        cx,
        cz,
        ch,
    ))
}

#[inline]
pub(crate) fn terrain_triangle_touches_rect(
    sample: TerrainTriangleSample,
    min_x: f64,
    min_y: f64,
    max_x: f64,
    max_y: f64,
) -> bool {
    let (_, _, _, ax, az, _, bx, bz, _, cx, cz, _) = sample;
    const TOUCH_EPS: f64 = 1.0e-9;

    // Triangle and rectangle are both convex. They overlap iff no separating
    // axis exists among the rectangle axes and the normals of all three
    // triangle edges. The previous implementation stopped after the first two
    // axes (their AABBs), so a large diagonal triangle classified every build
    // square in the unused half of its bounding box as if the triangle
    // actually covered it.
    let rect_min_x = min_x.min(max_x);
    let rect_max_x = min_x.max(max_x);
    let rect_min_y = min_y.min(max_y);
    let rect_max_y = min_y.max(max_y);
    let tri_min_x = ax.min(bx).min(cx);
    let tri_max_x = ax.max(bx).max(cx);
    let tri_min_y = az.min(bz).min(cz);
    let tri_max_y = az.max(bz).max(cz);
    if tri_max_x + TOUCH_EPS < rect_min_x
        || tri_min_x - TOUCH_EPS > rect_max_x
        || tri_max_y + TOUCH_EPS < rect_min_y
        || tri_min_y - TOUCH_EPS > rect_max_y
    {
        return false;
    }

    let rect_center_x = (rect_min_x + rect_max_x) * 0.5;
    let rect_center_y = (rect_min_y + rect_max_y) * 0.5;
    let rect_half_x = (rect_max_x - rect_min_x) * 0.5;
    let rect_half_y = (rect_max_y - rect_min_y) * 0.5;
    for (edge_x, edge_y) in [(bx - ax, bz - az), (cx - bx, cz - bz), (ax - cx, az - cz)] {
        // A zero-length projected edge contributes no separating axis. This
        // also keeps projected vertical wall faces well-defined.
        if edge_x.abs() <= TOUCH_EPS && edge_y.abs() <= TOUCH_EPS {
            continue;
        }
        let axis_x = -edge_y;
        let axis_y = edge_x;
        let tri_a = ax * axis_x + az * axis_y;
        let tri_b = bx * axis_x + bz * axis_y;
        let tri_c = cx * axis_x + cz * axis_y;
        let tri_min = tri_a.min(tri_b).min(tri_c);
        let tri_max = tri_a.max(tri_b).max(tri_c);
        let rect_center = rect_center_x * axis_x + rect_center_y * axis_y;
        let rect_radius = rect_half_x * axis_x.abs() + rect_half_y * axis_y.abs();
        if tri_max + TOUCH_EPS < rect_center - rect_radius
            || tri_min - TOUCH_EPS > rect_center + rect_radius
        {
            return false;
        }
    }
    true
}

type TerrainClipVertex = (f64, f64, f64);
const TERRAIN_CLIP_VERTEX_CAPACITY: usize = 12;

#[inline]
fn terrain_clip_polygon_axis(
    input: &[TerrainClipVertex; TERRAIN_CLIP_VERTEX_CAPACITY],
    input_len: usize,
    output: &mut [TerrainClipVertex; TERRAIN_CLIP_VERTEX_CAPACITY],
    axis: usize,
    limit: f64,
    keep_greater: bool,
) -> usize {
    if input_len == 0 {
        return 0;
    }
    let coordinate = |vertex: TerrainClipVertex| {
        if axis == 0 {
            vertex.0
        } else {
            vertex.1
        }
    };
    let inside = |value: f64| {
        if keep_greater {
            value >= limit
        } else {
            value <= limit
        }
    };
    let mut output_len = 0usize;
    let mut previous = input[input_len - 1];
    let mut previous_coordinate = coordinate(previous);
    let mut previous_inside = inside(previous_coordinate);
    for &current in input.iter().take(input_len) {
        let current_coordinate = coordinate(current);
        let current_inside = inside(current_coordinate);
        if current_inside != previous_inside {
            let denominator = current_coordinate - previous_coordinate;
            if denominator.abs() > 1.0e-12 && output_len < TERRAIN_CLIP_VERTEX_CAPACITY {
                let t = ((limit - previous_coordinate) / denominator).clamp(0.0, 1.0);
                output[output_len] = (
                    previous.0 + (current.0 - previous.0) * t,
                    previous.1 + (current.1 - previous.1) * t,
                    previous.2 + (current.2 - previous.2) * t,
                );
                output_len += 1;
            }
        }
        if current_inside && output_len < TERRAIN_CLIP_VERTEX_CAPACITY {
            output[output_len] = current;
            output_len += 1;
        }
        previous = current;
        previous_coordinate = current_coordinate;
        previous_inside = current_inside;
    }
    output_len
}

/// Exact terrain-height range over the positive intersection of a triangle
/// and a path-cell rectangle. The height field is linear inside a triangle,
/// so extrema occur at vertices of the clipped convex polygon.
#[inline]
pub(crate) fn terrain_triangle_rect_height_range(
    sample: TerrainTriangleSample,
    min_x: f64,
    min_y: f64,
    max_x: f64,
    max_y: f64,
) -> Option<(f64, f64)> {
    let (_, _, _, ax, az, ah, bx, bz, bh, cx, cz, ch) = sample;
    let rect_min_x = min_x.min(max_x);
    let rect_max_x = min_x.max(max_x);
    let rect_min_y = min_y.min(max_y);
    let rect_max_y = min_y.max(max_y);
    let mut a = [(0.0, 0.0, 0.0); TERRAIN_CLIP_VERTEX_CAPACITY];
    let mut b = [(0.0, 0.0, 0.0); TERRAIN_CLIP_VERTEX_CAPACITY];
    a[0] = (ax, az, ah);
    a[1] = (bx, bz, bh);
    a[2] = (cx, cz, ch);
    let mut len = terrain_clip_polygon_axis(&a, 3, &mut b, 0, rect_min_x, true);
    len = terrain_clip_polygon_axis(&b, len, &mut a, 0, rect_max_x, false);
    len = terrain_clip_polygon_axis(&a, len, &mut b, 1, rect_min_y, true);
    len = terrain_clip_polygon_axis(&b, len, &mut a, 1, rect_max_y, false);
    if len == 0 {
        return None;
    }
    let mut min_height = f64::INFINITY;
    let mut max_height = f64::NEG_INFINITY;
    for vertex in a.iter().take(len) {
        min_height = min_height.min(vertex.2);
        max_height = max_height.max(vertex.2);
    }
    if min_height.is_finite() && max_height.is_finite() {
        Some((min_height, max_height))
    } else {
        None
    }
}

#[inline]
pub(crate) fn terrain_accumulate_touching_triangle_safety_sample(
    sample: TerrainTriangleSample,
    min_height: f64,
    max_height_in_rect: f64,
    has_water: &mut bool,
    has_air: &mut bool,
    min_normal_z: &mut f32,
) {
    if min_height < TERRAIN_WATER_LEVEL {
        *has_water = true;
    }
    if max_height_in_rect >= TERRAIN_WATER_LEVEL {
        *has_air = true;
    }
    // Retain the actual bed angle here. Water-surface-supported traversals
    // ignore this value later, while bed-supported traversals still need the
    // slope of submerged terrain for their force envelope.
    let (_, _, nz) = terrain_bed_normal_from_triangle_sample(sample);
    let normal_z = nz.abs().min(1.0) as f32;
    if normal_z < *min_normal_z {
        *min_normal_z = normal_z;
    }
}

pub(crate) fn terrain_accumulate_touching_triangle_safety(
    min_x: f64,
    min_y: f64,
    max_x: f64,
    max_y: f64,
    has_water: &mut bool,
    has_air: &mut bool,
    min_normal_z: &mut f32,
) {
    let t = terrain_grid();
    if !t.installed || t.cell_size <= 0.0 || t.cells_x <= 0 || t.cells_y <= 0 {
        return;
    }

    let min_cell_x = ((min_x / t.cell_size).floor() as i32)
        .max(0)
        .min(t.cells_x - 1);
    let max_cell_x = ((max_x / t.cell_size).floor() as i32)
        .max(0)
        .min(t.cells_x - 1);
    let min_cell_y = ((min_y / t.cell_size).floor() as i32)
        .max(0)
        .min(t.cells_y - 1);
    let max_cell_y = ((max_y / t.cell_size).floor() as i32)
        .max(0)
        .min(t.cells_y - 1);

    for cy in min_cell_y..=max_cell_y {
        for cx in min_cell_x..=max_cell_x {
            let cell_idx = (cy * t.cells_x + cx) as usize;
            if cell_idx + 1 >= t.cell_triangle_offsets.len() {
                continue;
            }
            let start = t.cell_triangle_offsets[cell_idx].max(0) as usize;
            let end = t.cell_triangle_offsets[cell_idx + 1].max(0) as usize;
            let end = end.min(t.cell_triangle_indices.len());
            for ref_idx in start..end {
                let tri = t.cell_triangle_indices[ref_idx];
                if tri < 0 {
                    continue;
                }
                let sample = match terrain_triangle_sample_from_index(t, tri as usize) {
                    Some(sample) => sample,
                    None => continue,
                };
                if !terrain_triangle_touches_rect(sample, min_x, min_y, max_x, max_y) {
                    continue;
                }
                let Some((min_height, max_height_in_rect)) =
                    terrain_triangle_rect_height_range(sample, min_x, min_y, max_x, max_y)
                else {
                    continue;
                };
                terrain_accumulate_touching_triangle_safety_sample(
                    sample,
                    min_height,
                    max_height_in_rect,
                    has_water,
                    has_air,
                    min_normal_z,
                );
            }
        }
    }
}

pub(crate) fn terrain_triangle_sample_at(
    t: &TerrainGrid,
    px: f64,
    pz: f64,
    cell_x: i32,
    cell_y: i32,
) -> Option<TerrainTriangleSample> {
    if cell_x < 0 || cell_y < 0 || cell_x >= t.cells_x || cell_y >= t.cells_y {
        return None;
    }
    let cell_idx = (cell_y * t.cells_x + cell_x) as usize;
    if cell_idx + 1 >= t.cell_triangle_offsets.len() {
        return None;
    }
    let start = t.cell_triangle_offsets[cell_idx] as usize;
    let end = t.cell_triangle_offsets[cell_idx + 1] as usize;
    let mut best: Option<TerrainTriangleSample> = None;
    let mut best_score = f64::NEG_INFINITY;

    for ref_idx in start..end {
        let tri = t.cell_triangle_indices[ref_idx] as usize;
        let tri_offset = tri * 3;
        let ia = t.triangle_indices[tri_offset] as usize;
        let ib = t.triangle_indices[tri_offset + 1] as usize;
        let ic = t.triangle_indices[tri_offset + 2] as usize;
        let ax = t.vertex_coords[ia * 2];
        let az = t.vertex_coords[ia * 2 + 1];
        let bx = t.vertex_coords[ib * 2];
        let bz = t.vertex_coords[ib * 2 + 1];
        let cx = t.vertex_coords[ic * 2];
        let cz = t.vertex_coords[ic * 2 + 1];
        let (wa, wb, wc) = match terrain_barycentric_at(px, pz, ax, az, bx, bz, cx, cz) {
            Some(b) => b,
            None => continue,
        };
        let score = wa.min(wb).min(wc);
        if score < -1e-5 && score <= best_score {
            continue;
        }
        let (final_wa, final_wb, final_wc) = if score >= -1e-5 {
            (wa, wb, wc)
        } else {
            normalize_barycentric_weights(wa, wb, wc)
        };
        // TerrainTileMap uses ?? 0 for missing heights; clamp the
        // index get to 0 if out of range.
        let ah = t.vertex_heights.get(ia).copied().unwrap_or(0.0);
        let bh = t.vertex_heights.get(ib).copied().unwrap_or(0.0);
        let ch = t.vertex_heights.get(ic).copied().unwrap_or(0.0);
        let sample = (
            final_wa, final_wb, final_wc, ax, az, ah, bx, bz, bh, cx, cz, ch,
        );
        if score >= -1e-5 {
            return Some(sample);
        }
        best = Some(sample);
        best_score = score;
    }
    best
}

#[inline]
pub(crate) fn terrain_clamp_to_cell(t: &TerrainGrid, x: f64, z: f64) -> (f64, f64, i32, i32) {
    let max_x = t.cells_x as f64 * t.cell_size;
    let max_z = t.cells_y as f64 * t.cell_size;
    let px = if x <= 0.0 {
        0.0
    } else if x >= max_x {
        max_x
    } else {
        x
    };
    let pz = if z <= 0.0 {
        0.0
    } else if z >= max_z {
        max_z
    } else {
        z
    };
    let cell_x = ((px / t.cell_size).floor() as i32)
        .max(0)
        .min(t.cells_x - 1);
    let cell_y = ((pz / t.cell_size).floor() as i32)
        .max(0)
        .min(t.cells_y - 1);
    (px, pz, cell_x, cell_y)
}

/// Sample terrain surface height at world-space (x, z). Returns
/// NaN if no mesh is installed or the triangle walk degenerates —
/// JS callers should treat NaN as "fall back to TS sampler" since
/// that handles the bilinear-quad-over-noise path.
#[wasm_bindgen]
pub fn terrain_get_surface_height(x: f64, z: f64) -> f64 {
    let t = terrain_grid();
    if !t.installed {
        return f64::NAN;
    }
    let (px, pz, cell_x, cell_y) = terrain_clamp_to_cell(t, x, z);
    match terrain_triangle_sample_at(t, px, pz, cell_x, cell_y) {
        Some(sample) => terrain_height_from_triangle_sample(sample).max(TERRAIN_WATER_LEVEL),
        None => f64::NAN,
    }
}

/// Sample raw terrain-bed height at world-space (x, z), without clamping
/// below-water terrain up to the water plane. Unit physics uses this as the
/// universal solid-ground contact height.
#[wasm_bindgen]
pub fn terrain_get_bed_height(x: f64, z: f64) -> f64 {
    let t = terrain_grid();
    if !t.installed {
        return f64::NAN;
    }
    let (px, pz, cell_x, cell_y) = terrain_clamp_to_cell(t, x, z);
    match terrain_triangle_sample_at(t, px, pz, cell_x, cell_y) {
        Some(sample) => terrain_height_from_triangle_sample(sample),
        None => f64::NAN,
    }
}

/// Batch raw terrain-bed height sampling for arbitrary world-space points.
/// Returns 1 on a complete WASM sample; returns 0 if no terrain mesh is
/// installed or any triangle sample degenerates so JS can fall back to the
/// compatibility terrain sampler.
#[wasm_bindgen]
pub fn terrain_sample_bed_heights(xs: &[f64], zs: &[f64], heights_out: &mut [f64]) -> u32 {
    let count = xs.len();
    debug_assert!(zs.len() >= count);
    debug_assert!(heights_out.len() >= count);

    let t = terrain_grid();
    if !t.installed {
        return 0;
    }

    for i in 0..count {
        let (px, pz, cell_x, cell_y) = terrain_clamp_to_cell(t, xs[i], zs[i]);
        let sample = match terrain_triangle_sample_at(t, px, pz, cell_x, cell_y) {
            Some(s) => s,
            None => return 0,
        };
        heights_out[i] = terrain_height_from_triangle_sample(sample);
    }

    1
}

/// Segment-vs-terrain line-of-sight test. Walks the line from
/// (sx, sy, sz) to (tx, ty, tz) in `step_len`-spaced samples and
/// returns:
///   0 = ground blocks the ray (one sample's height > ray height)
///   1 = segment clears terrain end to end
///   2 = no mesh installed → caller should fall back to TS path
/// Mirrors hasTerrainLineOfSight in terrainLineOfSight.ts. Caller passes
/// the JS-side step_len (LAND_CELL_SIZE * 0.5 today — kept JS-side
/// so we don't duplicate the LAND_CELL_SIZE constant across the
/// boundary).
#[wasm_bindgen]
pub fn terrain_has_line_of_sight(
    sx: f64,
    sy: f64,
    sz: f64,
    tx: f64,
    ty: f64,
    tz: f64,
    step_len: f64,
) -> u32 {
    let t = terrain_grid();
    if !t.installed {
        return 2;
    }
    let dx = tx - sx;
    let dy = ty - sy;
    let dz = tz - sz;
    let horiz_dist = (dx * dx + dy * dy).sqrt();
    if horiz_dist < step_len {
        return 1;
    }
    // Conservative fast-accept: if every grid cell the 2D segment crosses
    // has a max terrain height at or below the sightline's minimum
    // altitude, no sample of the exact march below could exceed its
    // ray_z — the answer is provably "clear" without marching. Anything
    // else (a tall cell, an out-of-bounds endpoint whose samples would
    // clamp) falls through to the exact march unchanged, so results are
    // bit-identical either way.
    if terrain_los_fast_accept(t, sx, sy, sz, tx, ty, tz) {
        return 1;
    }
    let step_count = (horiz_dist / step_len).ceil() as i32;
    let inv_steps = 1.0 / step_count as f64;
    for i in 1..step_count {
        let f = i as f64 * inv_steps;
        let x = sx + dx * f;
        let y = sy + dy * f;
        let ray_z = sz + dz * f;
        // Inline the height sampler — same path as
        // terrain_get_surface_height, but skip the NaN sentinel
        // branch since we're inside Rust and an unmapped point
        // produces a degenerate sample (no triangle found) which
        // we treat as "no blocker" (height = -inf → never blocks).
        let (px, pz, cell_x, cell_y) = terrain_clamp_to_cell(t, x, y);
        if let Some(sample) = terrain_triangle_sample_at(t, px, pz, cell_x, cell_y) {
            // The occluder is the SOLID mesh. Clamping this up to
            // TERRAIN_WATER_LEVEL made the water surface an opaque wall, so any
            // sightline dipping below the waterline was blocked by the sea
            // itself and underwater-to-underwater full sight could never
            // succeed. Sonar still worked (the contact tier runs no sightline),
            // so the symptom was submarines you could hear and never see.
            // Water is a MEDIUM: which media a sensor bridges is decided by the
            // source-row/target-column matrix, not by geometry. Two points above
            // the waterline never produce a ray below it, so above-water
            // sightlines are unaffected.
            let h = terrain_height_from_triangle_sample(sample);
            if h > ray_z {
                return 0;
            }
        }
    }
    1
}

pub(crate) fn fog_mark_circle_scanline_impl(
    bitmap: &mut [u8],
    rgba: Option<&mut [u8]>,
    grid_w: u32,
    grid_h: u32,
    cx: f64,
    cy: f64,
    radius: f64,
    cell_anchor: f64,
    rgb_value: u8,
) -> u32 {
    if radius <= 0.0 || grid_w == 0 || grid_h == 0 {
        return 0;
    }
    let grid_w_usize = grid_w as usize;
    let grid_h_usize = grid_h as usize;
    let expected_cells = grid_w_usize.saturating_mul(grid_h_usize);
    if bitmap.len() < expected_cells {
        return 0;
    }
    let mut rgba = rgba;
    if let Some(buf) = rgba.as_ref() {
        if buf.len() < expected_cells.saturating_mul(4) {
            rgba = None;
        }
    }

    let r2 = radius * radius;
    let min_y = (cy - radius).floor().max(0.0) as i32;
    let max_y = (cy + radius).ceil().min((grid_h - 1) as f64) as i32;
    let mut modified = 0u32;
    for y in min_y..=max_y {
        let dy = y as f64 + cell_anchor - cy;
        let dy_sq = dy * dy;
        if dy_sq > r2 {
            continue;
        }
        let xspan = (r2 - dy_sq).sqrt();
        let x_min = (cx - cell_anchor - xspan).ceil().max(0.0) as i32;
        let x_max = (cx - cell_anchor + xspan).floor().min((grid_w - 1) as f64) as i32;
        if x_min > x_max {
            continue;
        }
        let row = y as usize * grid_w_usize;
        for x in x_min..=x_max {
            let idx = row + x as usize;
            if bitmap[idx] != 0 {
                continue;
            }
            bitmap[idx] = 1;
            modified = 1;
            if let Some(buf) = rgba.as_deref_mut() {
                let p = idx << 2;
                buf[p] = rgb_value;
                buf[p + 1] = rgb_value;
                buf[p + 2] = rgb_value;
            }
        }
    }
    modified
}

/// Fog scanline circle fill. Mutates a row-major byte bitmap
/// in-place and returns 1 if any cell flipped 0 -> 1.
#[wasm_bindgen]
pub fn fog_mark_circle_scanline(
    bitmap: &mut [u8],
    grid_w: u32,
    grid_h: u32,
    cx: f64,
    cy: f64,
    radius: f64,
    cell_anchor: f64,
) -> u32 {
    fog_mark_circle_scanline_impl(bitmap, None, grid_w, grid_h, cx, cy, radius, cell_anchor, 0)
}

/// Fog scanline circle fill with an aligned RGBA side buffer.
/// Each newly revealed bitmap cell also writes `rgb_value` to RGB,
/// leaving alpha untouched.
#[wasm_bindgen]
pub fn fog_mark_circle_scanline_rgba(
    bitmap: &mut [u8],
    rgba: &mut [u8],
    grid_w: u32,
    grid_h: u32,
    cx: f64,
    cy: f64,
    radius: f64,
    cell_anchor: f64,
    rgb_value: u8,
) -> u32 {
    fog_mark_circle_scanline_impl(
        bitmap,
        Some(rgba),
        grid_w,
        grid_h,
        cx,
        cy,
        radius,
        cell_anchor,
        rgb_value,
    )
}

pub(crate) fn terrain_normal_from_triangle_sample(
    sample: TerrainTriangleSample,
) -> (f64, f64, f64) {
    let h0 = terrain_height_from_triangle_sample(sample);
    if h0 < TERRAIN_WATER_LEVEL {
        return (0.0, 0.0, 1.0);
    }
    terrain_bed_normal_from_triangle_sample(sample)
}

pub(crate) fn terrain_bed_normal_from_triangle_sample(
    sample: TerrainTriangleSample,
) -> (f64, f64, f64) {
    let (_, _, _, ax, az, ah, bx, bz, bh, cx, cz, ch) = sample;
    // Triangle-plane normal — same math as terrainMeshNormalFromSample.
    let ux = bx - ax;
    let uy = bh - ah;
    let uz = bz - az;
    let vx_ = cx - ax;
    let vy = ch - ah;
    let vz = cz - az;
    let mut nx = uy * vz - uz * vy;
    let mut vertical = uz * vx_ - ux * vz;
    let mut nz = ux * vy - uy * vx_;
    if vertical < 0.0 {
        nx = -nx;
        vertical = -vertical;
        nz = -nz;
    }
    let len_sq = nx * nx + vertical * vertical + nz * nz;
    let len = if len_sq > 0.0 { len_sq.sqrt() } else { 1.0 };
    // Match terrainMeshNormalFromSample's return shape: { nx, ny: nz, nz: vertical }.
    (nx / len, nz / len, vertical / len)
}

pub(crate) fn terrain_surface_normal_at(
    t: &TerrainGrid,
    x: f64,
    z: f64,
) -> Option<(f64, f64, f64)> {
    let (px, pz, cell_x, cell_y) = terrain_clamp_to_cell(t, x, z);
    let sample = match terrain_triangle_sample_at(t, px, pz, cell_x, cell_y) {
        Some(s) => s,
        None => return None,
    };
    Some(terrain_normal_from_triangle_sample(sample))
}

/// Sample terrain surface normal at world-space (x, z). Writes
/// (nx, ny, nz) into out_buf[0..3] and returns 1 on success, 0 on
/// "no mesh installed / degenerate" so JS can fall back to TS.
/// nz is the up component (vertical); nx / ny are the horizontal
/// slope components. Below-water samples return (0, 0, 1) as the
/// flat water surface normal — matches getSurfaceNormal in
/// terrainSurface.ts.
#[wasm_bindgen]
pub fn terrain_get_surface_normal(x: f64, z: f64, out_buf: &mut [f64]) -> u32 {
    debug_assert!(out_buf.len() >= 3);
    let t = terrain_grid();
    if !t.installed {
        return 0;
    }
    let (nx, ny, nz) = match terrain_surface_normal_at(t, x, z) {
        Some(normal) => normal,
        None => return 0,
    };
    out_buf[0] = nx;
    out_buf[1] = ny;
    out_buf[2] = nz;
    1
}

/// Sample raw terrain-bed normal at world-space (x, z). Unlike
/// terrain_get_surface_normal, below-water samples return the terrain mesh
/// normal instead of the flat water-surface normal.
#[wasm_bindgen]
pub fn terrain_get_bed_normal(x: f64, z: f64, out_buf: &mut [f64]) -> u32 {
    debug_assert!(out_buf.len() >= 3);
    let t = terrain_grid();
    if !t.installed {
        return 0;
    }
    let (px, pz, cell_x, cell_y) = terrain_clamp_to_cell(t, x, z);
    let sample = match terrain_triangle_sample_at(t, px, pz, cell_x, cell_y) {
        Some(s) => s,
        None => return 0,
    };
    let (nx, ny, nz) = terrain_bed_normal_from_triangle_sample(sample);
    out_buf[0] = nx;
    out_buf[1] = ny;
    out_buf[2] = nz;
    1
}

/// Batch terrain bed samples for pool-backed dynamic body slots.
/// Writes `ground_z_out[i]` and `ground_normals_out[i * 3..i * 3 + 3]`
/// for each `body_slots[i]`, using the body's current pool position
/// and ground offset. Normals are only computed for slots at or near
/// terrain-bed contact, preserving the JS integrator's "skip normal while
/// airborne" rule. Returns 1 on a complete WASM sample; returns 0 if no terrain
/// mesh is installed, a slot is invalid, or any triangle sample
/// degenerates so JS can fall back to the compatibility sampler.
#[wasm_bindgen]
pub fn terrain_sample_ground_for_slots(
    body_slots: &[u32],
    ground_z_out: &mut [f64],
    ground_normals_out: &mut [f64],
) -> u32 {
    let count = body_slots.len();
    debug_assert!(ground_z_out.len() >= count);
    debug_assert!(ground_normals_out.len() >= 3 * count);

    let t = terrain_grid();
    if !t.installed {
        return 0;
    }
    let p = pool();
    for i in 0..count {
        let slot = body_slots[i] as usize;
        if slot >= POOL_CAPACITY_USIZE || p.flags[slot] & BODY_FLAG_OCCUPIED == 0 {
            return 0;
        }

        let (px, pz, cell_x, cell_y) = terrain_clamp_to_cell(t, p.pos_x[slot], p.pos_y[slot]);
        let sample = match terrain_triangle_sample_at(t, px, pz, cell_x, cell_y) {
            Some(s) => s,
            None => return 0,
        };
        let ground_z = terrain_height_from_triangle_sample(sample);
        ground_z_out[i] = ground_z;

        let base = i * 3;
        let penetration = ground_z - (p.pos_z[slot] - p.ground_offset[slot]);
        if is_in_contact(penetration) {
            let (nx, ny, nz) = terrain_bed_normal_from_triangle_sample(sample);
            ground_normals_out[base] = nx;
            ground_normals_out[base + 1] = ny;
            ground_normals_out[base + 2] = nz;
        } else {
            ground_normals_out[base] = 0.0;
            ground_normals_out[base + 1] = 0.0;
            ground_normals_out[base + 2] = 1.0;
        }
    }
    1
}

/// Batch terrain bed samples for force/support input rows.
/// Unlike `terrain_sample_ground_for_slots`, this always writes the terrain-bed
/// normal and whether the sampled bed is below the water plane, so callers can
/// build terrain support rows without re-sampling terrain in TypeScript.
#[wasm_bindgen]
pub fn terrain_sample_force_support_for_slots(
    body_slots: &[u32],
    ground_z_out: &mut [f64],
    ground_normals_out: &mut [f64],
    material_flags_out: &mut [u32],
) -> u32 {
    let count = body_slots.len();
    debug_assert!(ground_z_out.len() >= count);
    debug_assert!(ground_normals_out.len() >= 3 * count);
    debug_assert!(material_flags_out.len() >= count);

    let t = terrain_grid();
    if !t.installed {
        return 0;
    }
    let p = pool();
    for i in 0..count {
        let slot = body_slots[i] as usize;
        if slot >= POOL_CAPACITY_USIZE || p.flags[slot] & BODY_FLAG_OCCUPIED == 0 {
            return 0;
        }

        let (px, pz, cell_x, cell_y) = terrain_clamp_to_cell(t, p.pos_x[slot], p.pos_y[slot]);
        let sample = match terrain_triangle_sample_at(t, px, pz, cell_x, cell_y) {
            Some(s) => s,
            None => return 0,
        };
        let ground_z = terrain_height_from_triangle_sample(sample);
        let (nx, ny, nz) = terrain_bed_normal_from_triangle_sample(sample);
        let base = i * 3;
        ground_z_out[i] = ground_z;
        ground_normals_out[base] = nx;
        ground_normals_out[base + 1] = ny;
        ground_normals_out[base + 2] = nz;
        material_flags_out[i] = if ground_z < TERRAIN_WATER_LEVEL { 1 } else { 0 };
    }
    1
}

const TERRAIN_WATER_PROBE_DX: [f64; 8] = [
    1.0,
    0.7071067811865476,
    0.0,
    -0.7071067811865475,
    -1.0,
    -0.7071067811865477,
    0.0,
    0.7071067811865474,
];
const TERRAIN_WATER_PROBE_DY: [f64; 8] = [
    0.0,
    0.7071067811865475,
    1.0,
    0.7071067811865476,
    0.0,
    -0.7071067811865475,
    -1.0,
    -0.7071067811865477,
];

#[inline]
fn terrain_sample_is_water(t: &TerrainGrid, x: f64, z: f64) -> Option<bool> {
    let (px, pz, cell_x, cell_y) = terrain_clamp_to_cell(t, x, z);
    let sample = terrain_triangle_sample_at(t, px, pz, cell_x, cell_y)?;
    Some(terrain_height_from_triangle_sample(sample) < TERRAIN_WATER_LEVEL)
}

/// Batch terrain-only water escape probes. `center_water_flags_out[i]` is 1
/// when the probe center is under the water plane. `dry_masks_out[i]` uses the
/// same eight compass bits as UnitForceSystem's JS waterDryMask path, with a bit
/// set when that offset point is not water.
#[wasm_bindgen]
pub fn terrain_sample_water_probe_masks(
    centers_x: &[f64],
    centers_z: &[f64],
    probe_radii: &[f64],
    center_water_flags_out: &mut [u32],
    dry_masks_out: &mut [u32],
) -> u32 {
    let count = centers_x.len();
    debug_assert!(centers_z.len() >= count);
    debug_assert!(probe_radii.len() >= count);
    debug_assert!(center_water_flags_out.len() >= count);
    debug_assert!(dry_masks_out.len() >= count);

    let t = terrain_grid();
    if !t.installed {
        return 0;
    }

    for i in 0..count {
        let x = centers_x[i];
        let z = centers_z[i];
        let radius = probe_radii[i].max(0.0);
        let center_is_water = match terrain_sample_is_water(t, x, z) {
            Some(value) => value,
            None => return 0,
        };
        center_water_flags_out[i] = if center_is_water { 1 } else { 0 };

        let mut mask = 0u32;
        for probe in 0..8 {
            let px = x + TERRAIN_WATER_PROBE_DX[probe] * radius;
            let pz = z + TERRAIN_WATER_PROBE_DY[probe] * radius;
            let probe_is_water = match terrain_sample_is_water(t, px, pz) {
                Some(value) => value,
                None => return 0,
            };
            if !probe_is_water {
                mask |= 1 << probe;
            }
        }
        dry_masks_out[i] = mask;
    }

    1
}

pub(crate) const TERRAIN_FLAT_ZONE_STRIDE: usize = 4;
pub(crate) const TERRAIN_FLAT_ZONE_LEVEL_OFFSET: i32 = 1_000_000;
pub(crate) const TERRAIN_FLAT_ZONE_LEVEL_SCALE: f64 = 1_000.0;

#[inline]
pub(crate) fn terrain_flat_zone_height_at(flat_zones: &[f64], x: f64, y: f64) -> Option<f64> {
    let zone_count = flat_zones.len() / TERRAIN_FLAT_ZONE_STRIDE;
    for i in 0..zone_count {
        let base = i * TERRAIN_FLAT_ZONE_STRIDE;
        let zx = flat_zones[base];
        let zy = flat_zones[base + 1];
        let radius = flat_zones[base + 2];
        let height = flat_zones[base + 3];
        let dx = x - zx;
        let dy = y - zy;
        if dx * dx + dy * dy <= radius * radius {
            return Some(height);
        }
    }
    None
}

#[inline]
pub(crate) fn terrain_js_round_to_i32(value: f64) -> i32 {
    (value + 0.5).floor() as i32
}

#[inline]
pub(crate) fn terrain_plateau_level_for_height(
    height: f64,
    d_terrain: f64,
    shelf_height_tolerance: f64,
) -> Option<i32> {
    if d_terrain <= 0.0 {
        return Some(0);
    }
    let level = terrain_js_round_to_i32(height / d_terrain);
    if (height - level as f64 * d_terrain).abs() <= shelf_height_tolerance {
        Some(level)
    } else {
        None
    }
}

#[inline]
pub(crate) fn terrain_flat_zone_buildability_level(
    height: f64,
    d_terrain: f64,
    shelf_height_tolerance: f64,
) -> Option<i32> {
    if let Some(level) = terrain_plateau_level_for_height(height, d_terrain, shelf_height_tolerance)
    {
        return Some(level);
    }
    if !height.is_finite() {
        return None;
    }
    Some(TERRAIN_FLAT_ZONE_LEVEL_OFFSET + (height * TERRAIN_FLAT_ZONE_LEVEL_SCALE).round() as i32)
}

pub(crate) fn terrain_sample_buildability(
    t: &TerrainGrid,
    flat_zones: &[f64],
    x: f64,
    y: f64,
    d_terrain: f64,
    shelf_height_tolerance: f64,
) -> Option<(bool, f64, Option<i32>)> {
    let flat_height = terrain_flat_zone_height_at(flat_zones, x, y);
    if let Some(height) = flat_height {
        return Some((
            height < TERRAIN_WATER_LEVEL,
            1.0,
            terrain_flat_zone_buildability_level(height, d_terrain, shelf_height_tolerance),
        ));
    }
    let (px, pz, cell_x, cell_y) = terrain_clamp_to_cell(t, x, y);
    let sample = terrain_triangle_sample_at(t, px, pz, cell_x, cell_y)?;
    let mesh_height = terrain_height_from_triangle_sample(sample);
    if mesh_height < TERRAIN_WATER_LEVEL {
        return Some((true, 1.0, None));
    }
    let (_, _, normal_up) = terrain_normal_from_triangle_sample(sample);
    Some((
        false,
        normal_up,
        terrain_plateau_level_for_height(mesh_height, d_terrain, shelf_height_tolerance),
    ))
}

pub(crate) fn terrain_evaluate_buildability_footprint(
    t: &TerrainGrid,
    flat_zones: &[f64],
    center_x: f64,
    center_y: f64,
    half_width: f64,
    half_depth: f64,
    d_terrain: f64,
    shelf_height_tolerance: f64,
    min_normal_up: f64,
) -> Option<(bool, i32)> {
    let rx = (half_width - 1.0).max(0.0);
    let ry = (half_depth - 1.0).max(0.0);
    let samples = [
        (center_x, center_y),
        (center_x - rx, center_y - ry),
        (center_x + rx, center_y - ry),
        (center_x - rx, center_y + ry),
        (center_x + rx, center_y + ry),
        (center_x, center_y - ry),
        (center_x, center_y + ry),
        (center_x - rx, center_y),
        (center_x + rx, center_y),
    ];

    let mut footprint_level: Option<i32> = None;
    for (sx, sy) in samples {
        let (water, normal_up, plateau_level) =
            terrain_sample_buildability(t, flat_zones, sx, sy, d_terrain, shelf_height_tolerance)?;
        if water || normal_up < min_normal_up {
            return Some((false, 0));
        }
        let level = match plateau_level {
            Some(level) => level,
            None => return Some((false, 0)),
        };
        match footprint_level {
            Some(existing) if existing != level => return Some((false, 0)),
            Some(_) => {}
            None => footprint_level = Some(level),
        }
    }

    Some((true, footprint_level.unwrap_or(0)))
}

/// Bake the static terrain-buildability grid from the installed terrain
/// mesh. Returns 1 when `flags_out` and `levels_out` are complete; returns
/// 0 when JS should fall back to the compatibility baker.
#[wasm_bindgen]
pub fn terrain_bake_buildability_grid(
    map_width: f64,
    map_height: f64,
    build_cell_size: f64,
    d_terrain: f64,
    shelf_height_tolerance: f64,
    min_normal_up: f64,
    flat_zones: &[f64],
    flags_out: &mut [u8],
    levels_out: &mut [i32],
) -> u32 {
    let t = terrain_grid();
    if !t.installed
        || (t.map_width - map_width).abs() > TERRAIN_MESH_EPSILON
        || (t.map_height - map_height).abs() > TERRAIN_MESH_EPSILON
        || !map_width.is_finite()
        || !map_height.is_finite()
        || !build_cell_size.is_finite()
        || build_cell_size <= 0.0
        || flat_zones.len() % TERRAIN_FLAT_ZONE_STRIDE != 0
    {
        return 0;
    }

    let cells_x = (map_width / build_cell_size).ceil().max(1.0) as usize;
    let cells_y = (map_height / build_cell_size).ceil().max(1.0) as usize;
    let count = cells_x.saturating_mul(cells_y);
    if flags_out.len() < count || levels_out.len() < count {
        return 0;
    }

    let half = build_cell_size * 0.5;
    for gy in 0..cells_y {
        for gx in 0..cells_x {
            let x = gx as f64 * build_cell_size + half;
            let y = gy as f64 * build_cell_size + half;
            let (buildable, level) = match terrain_evaluate_buildability_footprint(
                t,
                flat_zones,
                x,
                y,
                half,
                half,
                d_terrain,
                shelf_height_tolerance,
                min_normal_up,
            ) {
                Some(result) => result,
                None => return 0,
            };
            let index = gy * cells_x + gx;
            flags_out[index] = if buildable { 1 } else { 0 };
            levels_out[index] = if buildable { level } else { 0 };
        }
    }

    1
}

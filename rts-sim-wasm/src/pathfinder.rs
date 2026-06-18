// pathfinder — extracted from lib.rs (pure code motion).

#[allow(unused_imports)]
use crate::*;
#[allow(unused_imports)]
use wasm_bindgen::prelude::*;

// ─────────────────────────────────────────────────────────────────
//  Phase 9 — Pathfinder: A* over the build/walk grid in WASM
//
//  Mirrors src/game/sim/Pathfinder.ts. Full pipeline (ensureMaskAndCC,
//  snap-to-component, A*, Bresenham LOS smoothing) runs inside one
//  WASM call. JS-side Pathfinder.ts becomes a thin wrapper that
//  forwards (start, goal, mapWidth, mapHeight, buildingGrid.occupiedCells,
//  terrainFilter) and reads the smoothed waypoint scratch. Building and
//  tower footprints are elevated terrain cells: flat on top, vertical
//  on the sides, and governed by the same directed slope rules as hills
//  and cliffs.
//
//  Mask + CC are cached internally; JS passes the terrain + building
//  version pair on each call, the Rust side rebuilds only when the
//  pair changes.
//
//  Terrain sampling reads directly from the in-WASM TerrainGrid
//  (Phase 8) — no boundary crossings during a rebuild. ~9 k cells in
//  a typical map; each one previously required 2 WASM dispatches
//  (height + normal), now it's all-in-Rust.
// ─────────────────────────────────────────────────────────────────

// Constants — grid/search constants live here; tuning constants are generated
// from src/game/sim/pathfindingTuningConfig.json.
pub(crate) const PATHFINDER_BUILD_GRID_CELL_SIZE: f64 = 20.0;
pub(crate) const PATHFINDER_SNAP_RADIUS_CELLS: i32 = 32;
pub(crate) const PATHFINDER_MAX_A_STAR_NODES: u32 = 50_000;
pub(crate) const PATHFINDER_SQRT2: f32 = 1.4142135623730951;
pub(crate) const PATHFINDER_SQRT2_MINUS_1: f32 = 0.41421356237309515;

pub(crate) struct PathfinderState {
    grid_w: i32,
    grid_h: i32,
    n: usize,
    map_width: f64,
    map_height: f64,

    blocked: Vec<u8>,
    terrain_blocked: Vec<u8>,
    terrain_base_height: Vec<f32>,
    terrain_height: Vec<f32>,
    terrain_normal_z: Vec<f32>,
    cc_labels: Vec<i16>,

    // A* scratch (reused per query)
    g_score: Vec<f32>,
    f_score: Vec<f32>,
    parent: Vec<i32>,
    closed: Vec<u8>,
    visited_gen: Vec<u32>,
    current_gen: u32,
    heap: Vec<u32>,
    // BFS scratch
    bfs_queue: Vec<u32>,

    // Cache keys — invalidated on terrain/building/grid-dim change.
    terrain_only_key: u64, // = (tVer as u64) << 32 | (gridW as u64) << 16 | gridH
    full_mask_key: u128,   // = tVer | bVer | gridW | gridH
    full_mask_grid_id: u32,

    // Sorted snap offsets — populated once per grid-dim change.
    snap_offsets: Vec<(i16, i16)>,

    // Output: smoothed waypoints as (x, y) f64 pairs.
    waypoint_scratch: Vec<f64>,
    path_scratch: Vec<u32>,
}

impl PathfinderState {
    pub(crate) fn empty() -> Self {
        Self {
            grid_w: 0,
            grid_h: 0,
            n: 0,
            map_width: 0.0,
            map_height: 0.0,
            blocked: Vec::new(),
            terrain_blocked: Vec::new(),
            terrain_base_height: Vec::new(),
            terrain_height: Vec::new(),
            terrain_normal_z: Vec::new(),
            cc_labels: Vec::new(),
            g_score: Vec::new(),
            f_score: Vec::new(),
            parent: Vec::new(),
            closed: Vec::new(),
            visited_gen: Vec::new(),
            current_gen: 1,
            heap: Vec::new(),
            bfs_queue: Vec::new(),
            terrain_only_key: u64::MAX,
            full_mask_key: u128::MAX,
            full_mask_grid_id: u32::MAX,
            snap_offsets: Vec::new(),
            waypoint_scratch: Vec::new(),
            path_scratch: Vec::new(),
        }
    }
}

pub(crate) struct PathfinderHolder(UnsafeCell<Option<PathfinderState>>);
unsafe impl Sync for PathfinderHolder {}
pub(crate) static PATHFINDER: PathfinderHolder = PathfinderHolder(UnsafeCell::new(None));

#[inline]
pub(crate) fn pathfinder_state() -> &'static mut PathfinderState {
    unsafe {
        let cell = &mut *PATHFINDER.0.get();
        if cell.is_none() {
            *cell = Some(PathfinderState::empty());
        }
        cell.as_mut().unwrap()
    }
}

pub(crate) fn pathfinder_build_snap_offsets(state: &mut PathfinderState) {
    let r = PATHFINDER_SNAP_RADIUS_CELLS;
    let mut list: Vec<(i16, i16, i32)> = Vec::new();
    for dy in -r..=r {
        for dx in -r..=r {
            if dx == 0 && dy == 0 {
                continue;
            }
            let d2 = dx * dx + dy * dy;
            if d2 > r * r {
                continue;
            }
            list.push((dx as i16, dy as i16, d2));
        }
    }
    list.sort_by_key(|&(_, _, d2)| d2);
    state.snap_offsets.clear();
    state.snap_offsets.reserve(list.len());
    for (dx, dy, _) in list {
        state.snap_offsets.push((dx, dy));
    }
}

#[wasm_bindgen]
pub fn pathfinder_init(map_width: f64, map_height: f64) {
    let state = pathfinder_state();
    let grid_w = (map_width / PATHFINDER_BUILD_GRID_CELL_SIZE).ceil() as i32;
    let grid_h = (map_height / PATHFINDER_BUILD_GRID_CELL_SIZE).ceil() as i32;
    let n = (grid_w * grid_h) as usize;
    if state.grid_w == grid_w && state.grid_h == grid_h && state.n == n {
        // Same dims — just invalidate caches so the next rebuild fires.
        state.terrain_only_key = u64::MAX;
        state.full_mask_key = u128::MAX;
        state.full_mask_grid_id = u32::MAX;
        state.map_width = map_width;
        state.map_height = map_height;
        return;
    }
    state.grid_w = grid_w;
    state.grid_h = grid_h;
    state.n = n;
    state.map_width = map_width;
    state.map_height = map_height;
    state.blocked.clear();
    state.blocked.resize(n, 0);
    state.terrain_blocked.clear();
    state.terrain_blocked.resize(n, 0);
    state.terrain_base_height.clear();
    state
        .terrain_base_height
        .resize(n, TERRAIN_WATER_LEVEL as f32 + 1.0);
    state.terrain_height.clear();
    state
        .terrain_height
        .resize(n, TERRAIN_WATER_LEVEL as f32 + 1.0);
    state.terrain_normal_z.clear();
    state.terrain_normal_z.resize(n, 1.0);
    state.cc_labels.clear();
    state.cc_labels.resize(n, 0);
    state.g_score.clear();
    state.g_score.resize(n, f32::INFINITY);
    state.f_score.clear();
    state.f_score.resize(n, f32::INFINITY);
    state.parent.clear();
    state.parent.resize(n, -1);
    state.closed.clear();
    state.closed.resize(n, 0);
    state.visited_gen.clear();
    state.visited_gen.resize(n, 0);
    state.current_gen = 1;
    state.heap.clear();
    state.path_scratch.clear();
    state.bfs_queue.clear();
    state.bfs_queue.resize(n, 0);
    state.terrain_only_key = u64::MAX;
    state.full_mask_key = u128::MAX;
    state.full_mask_grid_id = u32::MAX;
    pathfinder_build_snap_offsets(state);
}

/// Sample raw terrain mesh height + surface normal nz at world (x, y).
/// Mirrors getTerrainMeshHeight + getSurfaceNormal.nz used in
/// Pathfinder.ts ensureTerrainBlocked. Returns (height, nz). If the
/// terrain isn't installed or the sample degenerates, returns
/// (water_level + 1, 1.0) so the cell is treated as flat dry land
/// (best-effort — caller is responsible for terrain bootstrap order).
#[inline]
pub(crate) fn pathfinder_sample_terrain(x: f64, y: f64) -> (f64, f32) {
    let t = terrain_grid();
    if !t.installed {
        return (TERRAIN_WATER_LEVEL + 1.0, 1.0);
    }
    let (px, pz, cell_x, cell_y) = terrain_clamp_to_cell(t, x, y);
    let sample = match terrain_triangle_sample_at(t, px, pz, cell_x, cell_y) {
        Some(s) => s,
        None => return (TERRAIN_WATER_LEVEL + 1.0, 1.0),
    };
    let (wa, wb, wc, ax, az, ah, bx, bz, bh, cx, cz, ch) = sample;
    let h = wa * ah + wb * bh + wc * ch;
    if h < TERRAIN_WATER_LEVEL {
        // Below water — normal.nz unused (water-check blocks first).
        return (h, 0.0);
    }
    // Triangle normal — same math as terrain_get_surface_normal.
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
    let _ = nx;
    let _ = nz;
    let len_sq = nx * nx + vertical * vertical + nz * nz;
    let len = if len_sq > 0.0 { len_sq.sqrt() } else { 1.0 };
    let normal_z = (vertical / len) as f32;
    (h, normal_z)
}

#[inline]
pub(crate) fn pathfinder_sample_cell_terrain(gx: i32, gy: i32) -> (bool, f32, f32) {
    let cs = PATHFINDER_BUILD_GRID_CELL_SIZE;
    let x0 = gx as f64 * cs;
    let y0 = gy as f64 * cs;
    let x1 = x0 + cs;
    let y1 = y0 + cs;
    let inset = 0.001;
    let left = x0 + inset;
    let right = x1 - inset;
    let top = y0 + inset;
    let bottom = y1 - inset;
    let mid_x = x0 + cs * 0.5;
    let mid_y = y0 + cs * 0.5;
    let (center_h, center_nz) = pathfinder_sample_terrain(mid_x, mid_y);
    let samples = [
        (left, top),
        (mid_x, top),
        (right, top),
        (left, mid_y),
        (right, mid_y),
        (left, bottom),
        (mid_x, bottom),
        (right, bottom),
    ];
    let mut has_water = center_h < TERRAIN_WATER_LEVEL;
    let mut min_normal_z = center_nz;
    for (x, y) in samples {
        let (h, nz) = pathfinder_sample_terrain(x, y);
        if h < TERRAIN_WATER_LEVEL {
            has_water = true;
        }
        if nz < min_normal_z {
            min_normal_z = nz;
        }
    }
    terrain_accumulate_touching_triangle_safety(
        x0,
        y0,
        x1,
        y1,
        &mut has_water,
        &mut min_normal_z,
    );
    (has_water, min_normal_z, center_h as f32)
}

pub(crate) fn pathfinder_rebuild_terrain_mask(state: &mut PathfinderState, terrain_version: u32) {
    let key =
        ((terrain_version as u64) << 32) | ((state.grid_w as u64) << 16) | (state.grid_h as u64);
    if key == state.terrain_only_key {
        return;
    }

    let grid_w = state.grid_w;
    let grid_h = state.grid_h;
    let n = state.n;
    // Step 1 - classify water and the steepest terrain touching each cell.
    // Slope is not a symmetric cell blocker: downhill movement and falling
    // off cliffs must remain legal. The per-cell normal is kept for the
    // directed uphill edge gate below.
    let mut water_mask: Vec<u8> = vec![0u8; n];
    for gy in 0..grid_h {
        for gx in 0..grid_w {
            let idx = (gy * grid_w + gx) as usize;
            let (has_water, nz, height) = pathfinder_sample_cell_terrain(gx, gy);
            state.terrain_base_height[idx] = height;
            state.terrain_height[idx] = height;
            if has_water {
                state.terrain_normal_z[idx] = 0.0;
                water_mask[idx] = 1;
            } else {
                state.terrain_normal_z[idx] = nz;
            }
        }
    }

    // Step 2 — dilate water by WATER_BUFFER_CELLS into terrain_blocked.
    // Map-edge cells within `tk` of any border are blocked so ground routes
    // keep their collision space in-bounds.
    let tk = PATHFINDING_WATER_BUFFER_CELLS;
    for cell in state.terrain_blocked.iter_mut() {
        *cell = 0;
    }
    for gy in 0..grid_h {
        for gx in 0..grid_w {
            let out_idx = (gy * grid_w + gx) as usize;
            if gx < tk || gy < tk || gx >= grid_w - tk || gy >= grid_h - tk {
                state.terrain_blocked[out_idx] = 1;
                continue;
            }
            let mut blk = 0u8;
            'stencil: for dy in -tk..=tk {
                let row = (gy + dy) * grid_w;
                for dx in -tk..=tk {
                    if water_mask[(row + gx + dx) as usize] == 1 {
                        blk = 1;
                        break 'stencil;
                    }
                }
            }
            state.terrain_blocked[out_idx] = blk;
        }
    }

    state.terrain_only_key = key;
}

/// Rebuilds the full blocked mask + CC labels from the terrain mask
/// + a flat list of building cells (gx, gy, roofTopZ triples).
/// JS passes terrain/building versions plus a building-grid identity so
/// the rebuild can short-circuit when nothing has changed.
#[wasm_bindgen]
pub fn pathfinder_rebuild_mask_and_cc(
    building_cells: &[f64],
    terrain_version: u32,
    building_version: u32,
    building_grid_id: u32,
) {
    let state = pathfinder_state();
    pathfinder_rebuild_terrain_mask(state, terrain_version);

    // Cache key over (tVer, bVer, gridW, gridH).
    let key = ((terrain_version as u128) << 96)
        | ((building_version as u128) << 64)
        | ((state.grid_w as u128) << 32)
        | (state.grid_h as u128);
    if key == state.full_mask_key && building_grid_id == state.full_mask_grid_id {
        return;
    }

    // Start from cached terrain mask.
    let grid_w = state.grid_w;
    let grid_h = state.grid_h;
    state.blocked.copy_from_slice(&state.terrain_blocked);
    state.terrain_height.copy_from_slice(&state.terrain_base_height);

    let mut i = 0usize;
    while i + 2 < building_cells.len() {
        let gx = building_cells[i].floor() as i32;
        let gy = building_cells[i + 1].floor() as i32;
        let roof_top_z = building_cells[i + 2];
        i += 3;
        if gx < 0 || gy < 0 || gx >= grid_w || gy >= grid_h {
            continue;
        }
        let idx = (gy * grid_w + gx) as usize;
        let base_h = state.terrain_base_height[idx] as f64;
        if base_h.is_finite() && roof_top_z.is_finite() && roof_top_z > 0.0 {
            state.terrain_height[idx] = (base_h + roof_top_z) as f32;
        }
        // The top is flat, but every footprint boundary is a vertical side.
        // Equal-height roof traversal exits before the normal gate; uphill
        // entry from terrain into this cell must see the side as unclimbable.
        state.terrain_normal_z[idx] = 0.0;
        state.blocked[idx] = 0;
    }

    // CC labelling via BFS over open cells. This is an obstacle pre-flight
    // only: slope traversal is directional, so it cannot be represented by
    // one undirected component label without rejecting valid downhill paths.
    state.cc_labels.fill(0);
    let mut next_label: i16 = 1;
    for seed in 0..state.n {
        if state.blocked[seed] == 1 || state.cc_labels[seed] != 0 {
            continue;
        }
        if next_label > 32_000 {
            break;
        }
        state.cc_labels[seed] = next_label;
        let mut q_head = 0usize;
        let mut q_tail = 0usize;
        state.bfs_queue[q_tail] = seed as u32;
        q_tail += 1;
        while q_head < q_tail {
            let idx = state.bfs_queue[q_head] as i32;
            q_head += 1;
            let cgx = idx % grid_w;
            let cgy = (idx - cgx) / grid_w;
            for dy in -1..=1 {
                let ny = cgy + dy;
                if ny < 0 || ny >= grid_h {
                    continue;
                }
                let row = ny * grid_w;
                for dx in -1..=1 {
                    if dx == 0 && dy == 0 {
                        continue;
                    }
                    let nx = cgx + dx;
                    if nx < 0 || nx >= grid_w {
                        continue;
                    }
                    let nidx = (row + nx) as usize;
                    if state.blocked[nidx] == 1 || state.cc_labels[nidx] != 0 {
                        continue;
                    }
                    state.cc_labels[nidx] = next_label;
                    state.bfs_queue[q_tail] = nidx as u32;
                    q_tail += 1;
                }
            }
        }
        next_label += 1;
    }

    state.full_mask_key = key;
    state.full_mask_grid_id = building_grid_id;
}

#[inline]
pub(crate) fn pathfinder_is_cell_passable(
    state: &PathfinderState,
    idx: usize,
    _min_normal_z: f32,
    ignore_terrain_blocking: bool,
) -> bool {
    if ignore_terrain_blocking {
        return true;
    }
    if state.blocked[idx] == 1 {
        return false;
    }
    true
}

#[inline]
pub(crate) fn pathfinder_is_grid_cell_passable(
    state: &PathfinderState,
    gx: i32,
    gy: i32,
    min_normal_z: f32,
    ignore_terrain_blocking: bool,
) -> bool {
    if gx < 0 || gy < 0 || gx >= state.grid_w || gy >= state.grid_h {
        return false;
    }
    pathfinder_is_cell_passable(
        state,
        (gy * state.grid_w + gx) as usize,
        min_normal_z,
        ignore_terrain_blocking,
    )
}

#[inline]
pub(crate) fn pathfinder_required_step_normal_z(min_normal_z: f32) -> f32 {
    if min_normal_z.is_finite() && min_normal_z > PATHFINDING_STABILITY_MIN_NORMAL_Z {
        min_normal_z
    } else {
        PATHFINDING_STABILITY_MIN_NORMAL_Z
    }
}

#[inline]
pub(crate) fn pathfinder_can_step_height_delta(
    state: &PathfinderState,
    from_idx: usize,
    to_idx: usize,
    min_normal_z: f32,
) -> bool {
    let from_h = state.terrain_height[from_idx] as f64;
    let to_h = state.terrain_height[to_idx] as f64;
    if !from_h.is_finite() || !to_h.is_finite() {
        return false;
    }
    let from_i32 = from_idx as i32;
    let to_i32 = to_idx as i32;
    let from_gx = from_i32 % state.grid_w;
    let from_gy = (from_i32 - from_gx) / state.grid_w;
    let to_gx = to_i32 % state.grid_w;
    let to_gy = (to_i32 - to_gx) / state.grid_w;
    let dx = (to_gx - from_gx) as f64;
    let dy = (to_gy - from_gy) as f64;
    let horizontal = (dx * dx + dy * dy).sqrt() * PATHFINDER_BUILD_GRID_CELL_SIZE;
    if horizontal <= 1.0e-9 {
        return true;
    }
    let dz = to_h - from_h;
    if dz <= 0.0 {
        return true;
    }
    let required_normal_z = pathfinder_required_step_normal_z(min_normal_z);
    if state.terrain_normal_z[from_idx] < required_normal_z
        || state.terrain_normal_z[to_idx] < required_normal_z
    {
        return false;
    }
    let step_normal_z = horizontal / (horizontal * horizontal + dz * dz).sqrt();
    step_normal_z >= required_normal_z as f64
}

pub(crate) fn pathfinder_can_step_between(
    state: &PathfinderState,
    from_idx: usize,
    to_idx: usize,
    min_normal_z: f32,
    ignore_terrain_blocking: bool,
) -> bool {
    if !pathfinder_is_cell_passable(
        state,
        to_idx,
        min_normal_z,
        ignore_terrain_blocking,
    ) {
        return false;
    }
    ignore_terrain_blocking
        || pathfinder_can_step_height_delta(state, from_idx, to_idx, min_normal_z)
}

pub(crate) fn pathfinder_find_nearest_open(
    state: &PathfinderState,
    gx: i32,
    gy: i32,
    min_normal_z: f32,
    ignore_terrain_blocking: bool,
) -> Option<(i32, i32)> {
    for &(dx, dy) in &state.snap_offsets {
        let nx = gx + dx as i32;
        let ny = gy + dy as i32;
        if nx < 0 || ny < 0 || nx >= state.grid_w || ny >= state.grid_h {
            continue;
        }
        if pathfinder_is_cell_passable(
            state,
            (ny * state.grid_w + nx) as usize,
            min_normal_z,
            ignore_terrain_blocking,
        ) {
            return Some((nx, ny));
        }
    }
    None
}

pub(crate) fn pathfinder_find_nearest_open_toward(
    state: &PathfinderState,
    gx: i32,
    gy: i32,
    target_gx: i32,
    target_gy: i32,
    min_normal_z: f32,
    ignore_terrain_blocking: bool,
) -> Option<(i32, i32)> {
    let vx = target_gx - gx;
    let vy = target_gy - gy;
    let v_len_sq = vx * vx + vy * vy;
    if v_len_sq <= 0 {
        return pathfinder_find_nearest_open(
            state,
            gx,
            gy,
            min_normal_z,
            ignore_terrain_blocking,
        );
    }

    let mut best: Option<(i32, i32, i32, f64)> = None;
    let inv_v_len = 1.0 / (v_len_sq as f64).sqrt();
    for &(dx, dy) in &state.snap_offsets {
        let nx = gx + dx as i32;
        let ny = gy + dy as i32;
        if nx < 0 || ny < 0 || nx >= state.grid_w || ny >= state.grid_h {
            continue;
        }
        if !pathfinder_is_cell_passable(
            state,
            (ny * state.grid_w + nx) as usize,
            min_normal_z,
            ignore_terrain_blocking,
        ) {
            continue;
        }

        let dx_i = nx - gx;
        let dy_i = ny - gy;
        let dist_sq = dx_i * dx_i + dy_i * dy_i;
        if dist_sq <= 0 {
            continue;
        }
        let projection = dx_i * vx + dy_i * vy;
        let dir_score = if projection > 0 {
            (projection as f64) / (dist_sq as f64).sqrt() * inv_v_len
        } else {
            -1.0
        };
        match best {
            Some((_, _, best_dist_sq, best_dir_score))
                if dir_score < best_dir_score - 1.0e-9
                    || ((dir_score - best_dir_score).abs() <= 1.0e-9
                        && dist_sq >= best_dist_sq) => {}
            _ => best = Some((nx, ny, dist_sq, dir_score)),
        }
    }
    best.map(|(x, y, _, _)| (x, y))
}

pub(crate) fn pathfinder_find_nearest_in_component(
    state: &PathfinderState,
    gx: i32,
    gy: i32,
    component: i16,
    min_normal_z: f32,
    ignore_terrain_blocking: bool,
) -> Option<(i32, i32)> {
    if component <= 0 {
        return None;
    }
    let grid_w = state.grid_w;
    let grid_h = state.grid_h;
    // Fast snap-radius scan first.
    for &(dx, dy) in &state.snap_offsets {
        let nx = gx + dx as i32;
        let ny = gy + dy as i32;
        if nx < 0 || ny < 0 || nx >= grid_w || ny >= grid_h {
            continue;
        }
        let idx = (ny * grid_w + nx) as usize;
        if state.cc_labels[idx] == component
            && pathfinder_is_cell_passable(
                state,
                idx,
                min_normal_z,
                ignore_terrain_blocking,
            )
        {
            return Some((nx, ny));
        }
    }
    // Full component scan fallback — for goals beyond snap radius.
    let mut best: Option<(i32, i32, i32)> = None;
    for ny in 0..grid_h {
        let row = ny * grid_w;
        let dy = ny - gy;
        for nx in 0..grid_w {
            let idx = (row + nx) as usize;
            if state.cc_labels[idx] != component {
                continue;
            }
            if !pathfinder_is_cell_passable(
                state,
                idx,
                min_normal_z,
                ignore_terrain_blocking,
            ) {
                continue;
            }
            let dx = nx - gx;
            let d2 = dx * dx + dy * dy;
            if best.map_or(true, |(_, _, bd)| d2 < bd) {
                best = Some((nx, ny, d2));
            }
        }
    }
    best.map(|(x, y, _)| (x, y))
}

#[inline]
pub(crate) fn pathfinder_octile(ax: i32, ay: i32, bx: i32, by: i32) -> f32 {
    let dx = (ax - bx).abs() as f32;
    let dy = (ay - by).abs() as f32;
    dx.max(dy) + PATHFINDER_SQRT2_MINUS_1 * dx.min(dy)
}

pub(crate) fn pathfinder_heap_push(state: &mut PathfinderState, idx: u32) {
    state.heap.push(idx);
    let mut i = state.heap.len() - 1;
    while i > 0 {
        let p = (i - 1) >> 1;
        if state.f_score[state.heap[i] as usize] < state.f_score[state.heap[p] as usize] {
            state.heap.swap(i, p);
            i = p;
        } else {
            break;
        }
    }
}

pub(crate) fn pathfinder_heap_pop(state: &mut PathfinderState) -> u32 {
    let top = state.heap[0];
    let last = state.heap.pop().unwrap();
    let len = state.heap.len();
    if len > 0 {
        state.heap[0] = last;
        let mut i = 0usize;
        loop {
            let l = (i << 1) + 1;
            let r = l + 1;
            let mut s = i;
            if l < len
                && state.f_score[state.heap[l] as usize] < state.f_score[state.heap[s] as usize]
            {
                s = l;
            }
            if r < len
                && state.f_score[state.heap[r] as usize] < state.f_score[state.heap[s] as usize]
            {
                s = r;
            }
            if s == i {
                break;
            }
            state.heap.swap(i, s);
            i = s;
        }
    }
    top
}

pub(crate) const PATHFINDER_NEIGHBOR_DX: [i32; 8] = [1, -1, 0, 0, 1, 1, -1, -1];
pub(crate) const PATHFINDER_NEIGHBOR_DY: [i32; 8] = [0, 0, 1, -1, 1, -1, 1, -1];
// Neighbour costs: 1.0 for cardinal, SQRT2 for diagonal.
pub(crate) const PATHFINDER_NEIGHBOR_COST: [f32; 8] = [
    1.0,
    1.0,
    1.0,
    1.0,
    PATHFINDER_SQRT2,
    PATHFINDER_SQRT2,
    PATHFINDER_SQRT2,
    PATHFINDER_SQRT2,
];

pub(crate) struct AStarResult {
    goal_gx: i32,
    goal_gy: i32,
    reached_goal: bool,
}

#[inline]
fn pathfinder_begin_a_star_generation(state: &mut PathfinderState) {
    state.current_gen = state.current_gen.wrapping_add(1);
    if state.current_gen == 0 {
        for gen in state.visited_gen.iter_mut() {
            *gen = 0;
        }
        state.current_gen = 1;
    }
}

#[inline]
fn pathfinder_touch_a_star_cell(state: &mut PathfinderState, idx: usize) {
    if state.visited_gen[idx] == state.current_gen {
        return;
    }
    state.visited_gen[idx] = state.current_gen;
    state.g_score[idx] = f32::INFINITY;
    state.f_score[idx] = f32::INFINITY;
    state.parent[idx] = -1;
    state.closed[idx] = 0;
}

pub(crate) fn pathfinder_a_star(
    state: &mut PathfinderState,
    start_gx: i32,
    start_gy: i32,
    goal_gx: i32,
    goal_gy: i32,
    min_normal_z: f32,
    ignore_terrain_blocking: bool,
) -> Option<AStarResult> {
    let grid_w = state.grid_w;
    let grid_h = state.grid_h;
    pathfinder_begin_a_star_generation(state);
    state.heap.clear();
    state.path_scratch.clear();

    let start_idx = (start_gy * grid_w + start_gx) as usize;
    let goal_idx = (goal_gy * grid_w + goal_gx) as u32;
    pathfinder_touch_a_star_cell(state, start_idx);
    state.g_score[start_idx] = 0.0;
    state.f_score[start_idx] = pathfinder_octile(start_gx, start_gy, goal_gx, goal_gy);
    pathfinder_heap_push(state, start_idx as u32);

    let mut best_idx = start_idx as u32;
    let mut best_d2 = {
        let dx = start_gx - goal_gx;
        let dy = start_gy - goal_gy;
        dx * dx + dy * dy
    };
    let mut expanded = 0u32;
    let mut found = false;
    while !state.heap.is_empty() && expanded < PATHFINDER_MAX_A_STAR_NODES {
        let cur = pathfinder_heap_pop(state);
        let cur_us = cur as usize;
        if state.closed[cur_us] != 0 {
            continue;
        }
        state.closed[cur_us] = 1;
        expanded += 1;
        if cur == goal_idx {
            found = true;
            break;
        }

        let cur_i32 = cur as i32;
        let cgx = cur_i32 % grid_w;
        let cgy = (cur_i32 - cgx) / grid_w;
        for k in 0..8 {
            let nx = cgx + PATHFINDER_NEIGHBOR_DX[k];
            let ny = cgy + PATHFINDER_NEIGHBOR_DY[k];
            if nx < 0 || ny < 0 || nx >= grid_w || ny >= grid_h {
                continue;
            }
            let nidx = (ny * grid_w + nx) as usize;
            pathfinder_touch_a_star_cell(state, nidx);
            if !pathfinder_can_step_between(
                state,
                cur_us,
                nidx,
                min_normal_z,
                ignore_terrain_blocking,
            ) {
                continue;
            }
            if state.closed[nidx] != 0 {
                continue;
            }
            let tentative = state.g_score[cur_us] + PATHFINDER_NEIGHBOR_COST[k];
            if tentative < state.g_score[nidx] {
                state.parent[nidx] = cur as i32;
                state.g_score[nidx] = tentative;
                state.f_score[nidx] = tentative + pathfinder_octile(nx, ny, goal_gx, goal_gy);
                let dx = nx - goal_gx;
                let dy = ny - goal_gy;
                let d2 = dx * dx + dy * dy;
                if d2 < best_d2 {
                    best_d2 = d2;
                    best_idx = nidx as u32;
                }
                pathfinder_heap_push(state, nidx as u32);
            }
        }
    }

    let target = if found { goal_idx } else { best_idx };
    let mut walker = target as i32;
    while walker != start_idx as i32 && walker != -1 {
        state.path_scratch.push(walker as u32);
        walker = state.parent[walker as usize];
    }
    // If parent chain didn't reach start, target is unreachable from
    // start in the discovered subgraph — treat as no path.
    if !state.path_scratch.is_empty()
        && state.parent[*state.path_scratch.last().unwrap() as usize] == -1
        && (*state.path_scratch.last().unwrap() as i32) != start_idx as i32
    {
        // Final node has no parent and isn't start — unreachable.
        // (Matches the JS check `parent[path[last]] === -1`.)
        return None;
    }
    state.path_scratch.reverse();
    let gx = (target as i32) % grid_w;
    let gy = ((target as i32) - gx) / grid_w;
    Some(AStarResult {
        goal_gx: gx,
        goal_gy: gy,
        reached_goal: found,
    })
}

/// Supercover Bresenham LOS — true iff every cell crossed is unblocked.
pub(crate) fn pathfinder_has_los(
    state: &PathfinderState,
    x0: f64,
    y0: f64,
    x1: f64,
    y1: f64,
    min_normal_z: f32,
    ignore_terrain_blocking: bool,
) -> bool {
    let mut gx = (x0 / PATHFINDER_BUILD_GRID_CELL_SIZE).floor() as i32;
    let mut gy = (y0 / PATHFINDER_BUILD_GRID_CELL_SIZE).floor() as i32;
    let tgx = (x1 / PATHFINDER_BUILD_GRID_CELL_SIZE).floor() as i32;
    let tgy = (y1 / PATHFINDER_BUILD_GRID_CELL_SIZE).floor() as i32;
    let sx = if gx < tgx { 1 } else { -1 };
    let sy = if gy < tgy { 1 } else { -1 };
    let dx = (tgx - gx).abs();
    let dy = (tgy - gy).abs();
    let mut err = dx - dy;
    let max_steps = dx + dy + 2;
    for _ in 0..max_steps {
        if gx < 0 || gy < 0 || gx >= state.grid_w || gy >= state.grid_h {
            return false;
        }
        let current_idx = (gy * state.grid_w + gx) as usize;
        if !pathfinder_is_grid_cell_passable(
            state,
            gx,
            gy,
            min_normal_z,
            ignore_terrain_blocking,
        ) {
            return false;
        }
        if gx == tgx && gy == tgy {
            return true;
        }
        let e2 = 2 * err;
        let a_x = e2 > -dy;
        let a_y = e2 < dx;
        if a_x && a_y {
            if !pathfinder_is_grid_cell_passable(
                state,
                gx + sx,
                gy,
                min_normal_z,
                ignore_terrain_blocking,
            ) {
                return false;
            }
            if !pathfinder_is_grid_cell_passable(
                state,
                gx,
                gy + sy,
                min_normal_z,
                ignore_terrain_blocking,
            ) {
                return false;
            }
        }
        let mut next_gx = gx;
        let mut next_gy = gy;
        if a_x {
            err -= dy;
            next_gx += sx;
        }
        if a_y {
            err += dx;
            next_gy += sy;
        }
        if next_gx < 0 || next_gy < 0 || next_gx >= state.grid_w || next_gy >= state.grid_h {
            return false;
        }
        let next_idx = (next_gy * state.grid_w + next_gx) as usize;
        if !pathfinder_can_step_between(
            state,
            current_idx,
            next_idx,
            min_normal_z,
            ignore_terrain_blocking,
        ) {
            return false;
        }
        gx = next_gx;
        gy = next_gy;
    }
    false
}

#[inline]
pub(crate) fn pathfinder_cell_center(gx: i32, gy: i32) -> (f64, f64) {
    (
        (gx as f64 + 0.5) * PATHFINDER_BUILD_GRID_CELL_SIZE,
        (gy as f64 + 0.5) * PATHFINDER_BUILD_GRID_CELL_SIZE,
    )
}

/// Plan a path from (start_x, start_y) to (goal_x, goal_y).
/// `min_normal_z` is the per-unit slope filter (0 = no filter,
/// matches normalizeMinSurfaceNormalZ returning undefined in JS).
/// `ignore_terrain_blocking` lets airborne locomotion ignore water,
/// terrain-inflation, and slope gates while still respecting map bounds
/// and building-occupied cells.
/// Smoothed waypoints land in `waypoint_scratch` as interleaved
/// (x, y) f64 pairs; returns the waypoint count.
///
/// Note: caller must have run pathfinder_init + pathfinder_rebuild_mask_and_cc
/// for the current terrain/building state before calling this.
#[wasm_bindgen]
pub fn pathfinder_find_path(
    start_x: f64,
    start_y: f64,
    goal_x: f64,
    goal_y: f64,
    min_normal_z: f32,
    ignore_terrain_blocking: bool,
) -> u32 {
    let state = pathfinder_state();
    state.waypoint_scratch.clear();
    let grid_w = state.grid_w;
    let grid_h = state.grid_h;
    if grid_w == 0 || grid_h == 0 {
        // Not initialised — fall back to direct line.
        state.waypoint_scratch.push(start_x);
        state.waypoint_scratch.push(start_y);
        return 1;
    }

    let cs = PATHFINDER_BUILD_GRID_CELL_SIZE;
    let sgx = ((start_x / cs).floor() as i32).max(0).min(grid_w - 1);
    let sgy = ((start_y / cs).floor() as i32).max(0).min(grid_h - 1);
    let ggx = ((goal_x / cs).floor() as i32).max(0).min(grid_w - 1);
    let ggy = ((goal_y / cs).floor() as i32).max(0).min(grid_h - 1);
    let start_idx = (sgy * grid_w + sgx) as usize;

    // Snap blocked start.
    let mut start_cell_gx = sgx;
    let mut start_cell_gy = sgy;
    let mut start_was_snapped = false;
    if !pathfinder_is_cell_passable(
        state,
        start_idx,
        min_normal_z,
        ignore_terrain_blocking,
    ) {
        match pathfinder_find_nearest_open_toward(
            state,
            sgx,
            sgy,
            ggx,
            ggy,
            min_normal_z,
            ignore_terrain_blocking,
        ) {
            Some((nx, ny)) => {
                start_cell_gx = nx;
                start_cell_gy = ny;
                start_was_snapped = true;
            }
            None => {
                // No open cell anywhere near start — return single waypoint at start.
                state.waypoint_scratch.push(start_x);
                state.waypoint_scratch.push(start_y);
                return 1;
            }
        }
    }

    let mut goal_cell_gx = ggx;
    let mut goal_cell_gy = ggy;
    let mut goal_was_snapped = false;
    let ggy_idx = (ggy * grid_w + ggx) as usize;
    if ignore_terrain_blocking {
        if !pathfinder_is_cell_passable(state, ggy_idx, min_normal_z, true) {
            match pathfinder_find_nearest_open(
                state,
                ggx,
                ggy,
                min_normal_z,
                true,
            ) {
                Some((nx, ny)) => {
                    goal_cell_gx = nx;
                    goal_cell_gy = ny;
                    goal_was_snapped = true;
                }
                None => {
                    state.waypoint_scratch.push(start_x);
                    state.waypoint_scratch.push(start_y);
                    return 1;
                }
            }
        }
    } else {
        // Snap goal to start's component for terrain-bound locomotion.
        let start_label = state.cc_labels[(start_cell_gy * grid_w + start_cell_gx) as usize];
        if state.cc_labels[ggy_idx] != start_label
            || !pathfinder_is_cell_passable(
                state,
                ggy_idx,
                min_normal_z,
                false,
            )
        {
            match pathfinder_find_nearest_in_component(
                state,
                ggx,
                ggy,
                start_label,
                min_normal_z,
                false,
            ) {
                Some((nx, ny)) => {
                    goal_cell_gx = nx;
                    goal_cell_gy = ny;
                    goal_was_snapped = true;
                }
                None => {
                    state.waypoint_scratch.push(start_x);
                    state.waypoint_scratch.push(start_y);
                    return 1;
                }
            }
        }
    }

    // Same cell after snapping — no A* needed.
    if start_cell_gx == goal_cell_gx && start_cell_gy == goal_cell_gy {
        if goal_was_snapped {
            let (cx, cy) = pathfinder_cell_center(goal_cell_gx, goal_cell_gy);
            state.waypoint_scratch.push(cx);
            state.waypoint_scratch.push(cy);
        } else {
            state.waypoint_scratch.push(goal_x);
            state.waypoint_scratch.push(goal_y);
        }
        return 1;
    }

    let a_star_result = match pathfinder_a_star(
        state,
        start_cell_gx,
        start_cell_gy,
        goal_cell_gx,
        goal_cell_gy,
        min_normal_z,
        ignore_terrain_blocking,
    ) {
        Some(r) => r,
        None => {
            state.waypoint_scratch.push(start_x);
            state.waypoint_scratch.push(start_y);
            return 1;
        }
    };

    if !a_star_result.reached_goal {
        goal_cell_gx = a_star_result.goal_gx;
        goal_cell_gy = a_star_result.goal_gy;
        goal_was_snapped = true;
        if start_cell_gx == goal_cell_gx && start_cell_gy == goal_cell_gy {
            if start_was_snapped {
                let (cx, cy) = pathfinder_cell_center(start_cell_gx, start_cell_gy);
                state.waypoint_scratch.push(cx);
                state.waypoint_scratch.push(cy);
            } else {
                state.waypoint_scratch.push(start_x);
                state.waypoint_scratch.push(start_y);
            }
            return 1;
        }
    }
    // String-pull LOS smoothing.
    let mut anchor_x: f64;
    let mut anchor_y: f64;
    if start_was_snapped {
        let (cx, cy) = pathfinder_cell_center(start_cell_gx, start_cell_gy);
        anchor_x = cx;
        anchor_y = cy;
    } else {
        anchor_x = start_x;
        anchor_y = start_y;
    }
    let path_len = state.path_scratch.len();
    if path_len > 1 {
        for i in 0..path_len - 1 {
            let cand_idx = state.path_scratch[i] as i32;
            let next_idx = state.path_scratch[i + 1] as i32;
            let cgx = cand_idx % grid_w;
            let cgy = (cand_idx - cgx) / grid_w;
            let ngx = next_idx % grid_w;
            let ngy = (next_idx - ngx) / grid_w;
            let (cand_x, cand_y) = pathfinder_cell_center(cgx, cgy);
            let (next_x, next_y) = pathfinder_cell_center(ngx, ngy);
            if !pathfinder_has_los(
                state,
                anchor_x,
                anchor_y,
                next_x,
                next_y,
                min_normal_z,
                ignore_terrain_blocking,
            ) {
                state.waypoint_scratch.push(cand_x);
                state.waypoint_scratch.push(cand_y);
                anchor_x = cand_x;
                anchor_y = cand_y;
            }
        }
    }
    if goal_was_snapped {
        let (cx, cy) = pathfinder_cell_center(goal_cell_gx, goal_cell_gy);
        state.waypoint_scratch.push(cx);
        state.waypoint_scratch.push(cy);
    } else {
        state.waypoint_scratch.push(goal_x);
        state.waypoint_scratch.push(goal_y);
    }
    (state.waypoint_scratch.len() / 2) as u32
}

#[wasm_bindgen]
pub fn pathfinder_waypoints_ptr() -> *const f64 {
    pathfinder_state().waypoint_scratch.as_ptr()
}

#[wasm_bindgen]
pub fn pathfinder_grid_size_w() -> i32 {
    pathfinder_state().grid_w
}

#[wasm_bindgen]
pub fn pathfinder_grid_size_h() -> i32 {
    pathfinder_state().grid_h
}

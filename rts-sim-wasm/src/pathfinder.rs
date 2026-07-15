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
pub(crate) const PATHFINDER_MAX_STEEP_START_ESCAPE_CANDIDATES: usize = 384;
pub(crate) const PATHFINDER_SQRT2_MINUS_1: f32 = 0.41421356237309515;
pub(crate) const PATHFINDER_RESULT_UNREACHABLE: u32 = 0;
pub(crate) const PATHFINDER_RESULT_COMPLETE: u32 = 1;
pub(crate) const PATHFINDER_RESULT_SNAPPED: u32 = 2;
pub(crate) const PATHFINDER_RESULT_PARTIAL: u32 = 3;

pub(crate) struct PathfinderState {
    grid_w: i32,
    grid_h: i32,
    n: usize,
    map_width: f64,
    map_height: f64,

    blocked: Vec<u8>,
    terrain_blocked: Vec<u8>,
    terrain_water: Vec<u8>,
    terrain_edge_blocked: Vec<u8>,
    terrain_base_height: Vec<f32>,
    terrain_height: Vec<f32>,
    terrain_normal_z: Vec<f32>,
    cc_labels: Vec<i16>,
    /// Chebyshev cell-distance from each open cell to the nearest blocked
    /// cell (0 for blocked cells). Rebuilt with the mask and consumed as a
    /// per-unit collision-clearance gate, so a body of collision radius r is
    /// not routed through gaps narrower than it can fit. Independent of unit
    /// size, so it is cached once per mask rather than per radius.
    clearance: Vec<u16>,
    /// Clearance from map edges and structure footprints only. Water-capable
    /// and bed-walking queries use this so wet cells are not self-obstacles.
    medium_clearance: Vec<u16>,

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

    // Per-query traversal params, set at pathfinder_find_path entry (one query
    // runs at a time). `cur_required_clearance` gates cells by the unit's
    // collision footprint in cells; `cur_symmetric_slope` makes the climb gate
    // apply to downhill edges too (SYMMETRIC mode) instead of only uphill.
    cur_required_clearance: i32,
    cur_symmetric_slope: bool,

    // Cache keys — invalidated on terrain/building/grid-dim change.
    terrain_only_key: u64, // = (tVer as u64) << 32 | (gridW as u64) << 16 | gridH
    full_mask_key: u128,   // = tVer | bVer | gridW | gridH
    full_mask_grid_id: u32,

    // Sorted snap offsets — populated once per grid-dim change.
    snap_offsets: Vec<(i16, i16)>,

    // Output: smoothed waypoints as (x, y) f64 pairs.
    waypoint_scratch: Vec<f64>,
    path_scratch: Vec<u32>,
    last_result_status: u32,
}

#[derive(Clone, Copy)]
pub(crate) struct PathfinderTraversal {
    min_normal_z: f32,
    allow_ground: bool,
    allow_water: bool,
    allow_air: bool,
}

/// Query-local route objective, deliberately independent of locomotion rig
/// names. The wrapper reduces force/mass/grip physics to flat acceleration;
/// A* only knows how that capability changes travel time over terrain.
#[derive(Clone, Copy)]
pub(crate) struct PathfinderCostProfile {
    flat_drive_accel: f64,
    hard_clearance_cells: i32,
    soft_clearance_cells: i32,
    soft_clearance_penalty_per_cell: f32,
}

impl PathfinderCostProfile {
    #[inline]
    fn for_query(flat_drive_accel: f64, hard_clearance_cells: i32) -> Self {
        Self {
            flat_drive_accel: if flat_drive_accel.is_finite() && flat_drive_accel > 0.0 {
                flat_drive_accel
            } else {
                0.0
            },
            hard_clearance_cells,
            soft_clearance_cells: PATHFINDING_SOFT_CLEARANCE_CELLS.max(0),
            soft_clearance_penalty_per_cell: PATHFINDING_SOFT_CLEARANCE_PENALTY_PER_CELL.max(0.0),
        }
    }

    #[inline]
    fn neutral() -> Self {
        Self {
            flat_drive_accel: 0.0,
            hard_clearance_cells: 0,
            soft_clearance_cells: 0,
            soft_clearance_penalty_per_cell: 0.0,
        }
    }
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
            terrain_water: Vec::new(),
            terrain_edge_blocked: Vec::new(),
            terrain_base_height: Vec::new(),
            terrain_height: Vec::new(),
            terrain_normal_z: Vec::new(),
            cc_labels: Vec::new(),
            clearance: Vec::new(),
            medium_clearance: Vec::new(),
            g_score: Vec::new(),
            f_score: Vec::new(),
            parent: Vec::new(),
            closed: Vec::new(),
            visited_gen: Vec::new(),
            current_gen: 1,
            heap: Vec::new(),
            bfs_queue: Vec::new(),
            cur_required_clearance: 0,
            cur_symmetric_slope: false,
            terrain_only_key: u64::MAX,
            full_mask_key: u128::MAX,
            full_mask_grid_id: u32::MAX,
            snap_offsets: Vec::new(),
            waypoint_scratch: Vec::new(),
            path_scratch: Vec::new(),
            last_result_status: PATHFINDER_RESULT_UNREACHABLE,
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
    state.terrain_water.clear();
    state.terrain_water.resize(n, 0);
    state.terrain_edge_blocked.clear();
    state.terrain_edge_blocked.resize(n, 0);
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
    state.clearance.clear();
    state.clearance.resize(n, 0);
    state.medium_clearance.clear();
    state.medium_clearance.resize(n, 0);
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
    terrain_accumulate_touching_triangle_safety(x0, y0, x1, y1, &mut has_water, &mut min_normal_z);
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
            state.terrain_normal_z[idx] = nz;
            if has_water {
                water_mask[idx] = 1;
            }
        }
    }
    state.terrain_water.copy_from_slice(&water_mask);

    // Step 2 — dilate water by WATER_BUFFER_CELLS into terrain_blocked.
    // Map-edge cells within `tk` of any border are blocked so ground routes
    // keep their collision space in-bounds.
    let tk = PATHFINDING_WATER_BUFFER_CELLS;
    for cell in state.terrain_blocked.iter_mut() {
        *cell = 0;
    }
    for cell in state.terrain_edge_blocked.iter_mut() {
        *cell = 0;
    }
    for gy in 0..grid_h {
        for gx in 0..grid_w {
            let out_idx = (gy * grid_w + gx) as usize;
            if gx < tk || gy < tk || gx >= grid_w - tk || gy >= grid_h - tk {
                state.terrain_edge_blocked[out_idx] = 1;
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

pub(crate) fn pathfinder_rebuild_clearance_distance(
    clearance: &mut [u16],
    grid_w: i32,
    grid_h: i32,
) {
    // Forward pass: top-left → bottom-right (W, N, NW, NE already settled).
    for gy in 0..grid_h {
        for gx in 0..grid_w {
            let idx = (gy * grid_w + gx) as usize;
            if clearance[idx] == 0 {
                continue;
            }
            let mut m = clearance[idx];
            if gx > 0 {
                m = m.min(clearance[idx - 1].saturating_add(1));
            }
            if gy > 0 {
                let up = idx - grid_w as usize;
                m = m.min(clearance[up].saturating_add(1));
                if gx > 0 {
                    m = m.min(clearance[up - 1].saturating_add(1));
                }
                if gx < grid_w - 1 {
                    m = m.min(clearance[up + 1].saturating_add(1));
                }
            }
            clearance[idx] = m;
        }
    }
    // Backward pass: bottom-right → top-left (E, S, SE, SW).
    for gy in (0..grid_h).rev() {
        for gx in (0..grid_w).rev() {
            let idx = (gy * grid_w + gx) as usize;
            if clearance[idx] == 0 {
                continue;
            }
            let mut m = clearance[idx];
            if gx < grid_w - 1 {
                m = m.min(clearance[idx + 1].saturating_add(1));
            }
            if gy < grid_h - 1 {
                let dn = idx + grid_w as usize;
                m = m.min(clearance[dn].saturating_add(1));
                if gx < grid_w - 1 {
                    m = m.min(clearance[dn + 1].saturating_add(1));
                }
                if gx > 0 {
                    m = m.min(clearance[dn - 1].saturating_add(1));
                }
            }
            clearance[idx] = m;
        }
    }
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
    state
        .terrain_height
        .copy_from_slice(&state.terrain_base_height);

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

    // Clearance distance fields: Chebyshev cell-distance from each open cell
    // to the nearest OBSTACLE cell (0 for obstacle cells). Ground-only
    // clearance treats water + map edges + building footprints as obstacles.
    // Medium clearance treats only map edges + building footprints as
    // obstacles, so water-capable and bed-walking routes do not make wet cells
    // self-blocking. Building footprints seed both fields because buildings are
    // walkable elevated terrain rather than `blocked` cells, but a unit routing
    // past one must still hold its body clear of the vertical sides.
    {
        let n = state.n;
        for idx in 0..n {
            state.clearance[idx] = if state.blocked[idx] == 1 { 0 } else { u16::MAX };
            state.medium_clearance[idx] = if state.terrain_edge_blocked[idx] == 1 {
                0
            } else {
                u16::MAX
            };
        }
        // Seed building footprints as clearance obstacles (see comment above).
        let mut bi = 0usize;
        while bi + 2 < building_cells.len() {
            let bgx = building_cells[bi].floor() as i32;
            let bgy = building_cells[bi + 1].floor() as i32;
            bi += 3;
            if bgx >= 0 && bgy >= 0 && bgx < grid_w && bgy < grid_h {
                let idx = (bgy * grid_w + bgx) as usize;
                state.clearance[idx] = 0;
                state.medium_clearance[idx] = 0;
            }
        }
        pathfinder_rebuild_clearance_distance(&mut state.clearance, grid_w, grid_h);
        pathfinder_rebuild_clearance_distance(&mut state.medium_clearance, grid_w, grid_h);
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
                    if dx != 0 && dy != 0 && !PATHFINDING_ALLOW_DIAGONAL_NEIGHBORS {
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
                    if dx != 0 && dy != 0 {
                        let side_x = (cgy * grid_w + nx) as usize;
                        let side_y = (ny * grid_w + cgx) as usize;
                        if state.blocked[side_x] == 1 || state.blocked[side_y] == 1 {
                            continue;
                        }
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
    traversal: PathfinderTraversal,
) -> bool {
    if traversal.allow_air {
        return true;
    }
    if state.terrain_edge_blocked[idx] == 1 {
        return false;
    }
    let wet = state.terrain_water[idx] == 1;
    let terrain_blocked = state.blocked[idx] == 1;
    let passable_by_medium = if wet {
        // Intentional water traversal is an explicit navigation policy.
        // Ground contact may physically exist on the lakebed, but that does
        // not authorize an ordinary land unit to route itself into water.
        traversal.allow_water
    } else if terrain_blocked {
        // Dry shoreline-buffer cells are blocked for ground-only units, but
        // amphibious units may cross them because the adjacent wet cells are
        // part of their legal route space.
        traversal.allow_water && traversal.allow_ground
    } else {
        traversal.allow_ground
    };
    if !passable_by_medium {
        return false;
    }
    // Collision-clearance gate: keep a unit of the current query's footprint
    // out of cells whose nearest blocker is closer than the body can fit.
    // cur_required_clearance is 0 during start/goal snapping and for point-size
    // units, so this is inert there (every open cell has clearance >= 1).
    let clearance = if wet || traversal.allow_water {
        state.medium_clearance[idx]
    } else {
        state.clearance[idx]
    };
    if (clearance as i32) < state.cur_required_clearance {
        return false;
    }
    true
}

/// Hard configuration-space clearance for the unit's physical collision disk.
/// Arrival tolerance is controller behavior and must never make the planner
/// pretend the body is larger than it is. The nearest blocked cell's near edge
/// sits ~(c - 0.5) cells from the cell centre, so
/// `c >= radius/cell + 0.5` keeps the disk out of the blocker. Returns 0 for
/// point-size / non-finite radii (gate becomes a no-op, e.g. airborne).
#[inline]
pub(crate) fn pathfinder_hard_clearance_cells_for_radius(radius: f64) -> i32 {
    if !radius.is_finite() || radius <= 0.0 {
        return 0;
    }
    ((radius / PATHFINDER_BUILD_GRID_CELL_SIZE) + 0.5).ceil() as i32
}

#[inline]
pub(crate) fn pathfinder_is_grid_cell_passable(
    state: &PathfinderState,
    gx: i32,
    gy: i32,
    traversal: PathfinderTraversal,
) -> bool {
    if gx < 0 || gy < 0 || gx >= state.grid_w || gy >= state.grid_h {
        return false;
    }
    pathfinder_is_cell_passable(state, (gy * state.grid_w + gx) as usize, traversal)
}

#[inline]
pub(crate) fn pathfinder_required_step_normal_z(min_normal_z: f32) -> f32 {
    if min_normal_z.is_finite() && min_normal_z > PATHFINDING_STABILITY_MIN_NORMAL_Z {
        min_normal_z
    } else {
        PATHFINDING_STABILITY_MIN_NORMAL_Z
    }
}

/// Derive the terrain-bound climb envelope from the same authored drive force,
/// force_coupling and contact grip consumed by the force kernel. TypeScript supplies
/// immutable configuration values; all force-to-acceleration and slope physics
/// remain canonical here in Rust.
#[wasm_bindgen]
pub fn pathfinder_compute_locomotion_climb_profile(
    ground_drive_force: f64,
    ground_force_coupling: f64,
    surface_grip: f64,
    mass: f64,
    thrust_multiplier: f64,
    force_scale: f64,
    reference_mass: f64,
    unit_mass_multiplier: f64,
    gravity: f64,
    force_safety_ratio: f64,
    stability_max_slope_deg: f64,
    allow_ground: bool,
    allow_air: bool,
    out: &mut [f64],
) -> u32 {
    const PROFILE_LEN: usize = 7;
    if out.len() < PROFILE_LEN {
        return 0;
    }
    if allow_air {
        out[..PROFILE_LEN].copy_from_slice(&[
            f64::NAN,
            f64::NAN,
            f64::INFINITY,
            f64::NAN,
            f64::NAN,
            f64::NAN,
            f64::NAN,
        ]);
        return 1;
    }
    if !allow_ground {
        out[..PROFILE_LEN].copy_from_slice(&[
            f64::NAN,
            f64::NAN,
            0.0,
            f64::NAN,
            f64::NAN,
            f64::NAN,
            f64::NAN,
        ]);
        return 1;
    }
    if !mass.is_finite()
        || mass <= 0.0
        || !unit_mass_multiplier.is_finite()
        || unit_mass_multiplier <= 0.0
        || !gravity.is_finite()
        || gravity <= 0.0
    {
        return 0;
    }

    let (_, coupled_force_magnitude) = unit_force_locomotion_magnitudes(
        ground_drive_force,
        ground_force_coupling,
        reference_mass,
        thrust_multiplier,
        force_scale,
    );
    let effective_mass = mass * unit_mass_multiplier;
    let drive_accel = coupled_force_magnitude * 1_000_000.0 / effective_mass;
    let grip_accel = gravity * surface_grip.max(0.0);
    let flat_drive_accel = drive_accel.min(grip_accel).max(0.0);
    let safe_drive_force = coupled_force_magnitude * force_safety_ratio.clamp(0.0, 1.0);
    let safe_drive_accel = safe_drive_force * 1_000_000.0 / effective_mass;
    let radians_to_degrees = 180.0 / core::f64::consts::PI;
    let drive_limited_slope_deg =
        (safe_drive_accel / gravity).clamp(0.0, 1.0).asin() * radians_to_degrees;
    let grip_limited_slope_deg = surface_grip.max(0.0).atan() * radians_to_degrees;
    let stability_limited_slope_deg = stability_max_slope_deg.clamp(0.0, 90.0);
    let max_slope_deg = drive_limited_slope_deg
        .min(grip_limited_slope_deg)
        .min(stability_limited_slope_deg)
        .max(0.0);
    let min_surface_normal_z = (max_slope_deg / radians_to_degrees).cos();
    out[..PROFILE_LEN].copy_from_slice(&[
        max_slope_deg,
        min_surface_normal_z,
        safe_drive_accel,
        drive_limited_slope_deg,
        grip_limited_slope_deg,
        stability_limited_slope_deg,
        flat_drive_accel,
    ]);
    1
}

#[inline]
pub(crate) fn pathfinder_can_step_height_delta(
    state: &PathfinderState,
    from_idx: usize,
    to_idx: usize,
    traversal: PathfinderTraversal,
) -> bool {
    if traversal.allow_air || (state.terrain_water[to_idx] == 1 && traversal.allow_water) {
        return true;
    }
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
    // DIRECTIONAL mode (default): descending and flat steps are always legal —
    // gravity assists, so a unit may drive down or fall off any slope while
    // only uphill is gated by its climb profile. SYMMETRIC mode: the climb gate
    // applies regardless of direction, so a face too steep to climb also blocks
    // the downhill edge.
    if dz <= 0.0 && !state.cur_symmetric_slope {
        return true;
    }
    let required_normal_z = pathfinder_required_step_normal_z(traversal.min_normal_z);
    if state.terrain_normal_z[from_idx] < required_normal_z
        || state.terrain_normal_z[to_idx] < required_normal_z
    {
        return false;
    }
    let abs_dz = dz.abs();
    let step_normal_z = horizontal / (horizontal * horizontal + abs_dz * abs_dz).sqrt();
    step_normal_z >= required_normal_z as f64
}

pub(crate) fn pathfinder_can_step_between(
    state: &PathfinderState,
    from_idx: usize,
    to_idx: usize,
    traversal: PathfinderTraversal,
) -> bool {
    if !pathfinder_is_cell_passable(state, to_idx, traversal) {
        return false;
    }
    pathfinder_can_step_height_delta(state, from_idx, to_idx, traversal)
}

#[inline]
pub(crate) fn pathfinder_can_step_neighbor(
    state: &PathfinderState,
    from_gx: i32,
    from_gy: i32,
    to_gx: i32,
    to_gy: i32,
    traversal: PathfinderTraversal,
) -> bool {
    let from_idx = (from_gy * state.grid_w + from_gx) as usize;
    let to_idx = (to_gy * state.grid_w + to_gx) as usize;
    if !pathfinder_can_step_between(state, from_idx, to_idx, traversal) {
        return false;
    }
    let dx = to_gx - from_gx;
    let dy = to_gy - from_gy;
    if dx == 0 || dy == 0 {
        return true;
    }

    // A diagonal swept segment touches both edge-sharing cells. Requiring
    // both directed side steps prevents corner clipping through water,
    // structures, or an uphill face that the body's disk cannot traverse.
    let side_x_idx = (from_gy * state.grid_w + to_gx) as usize;
    let side_y_idx = (to_gy * state.grid_w + from_gx) as usize;
    pathfinder_can_step_between(state, from_idx, side_x_idx, traversal)
        && pathfinder_can_step_between(state, from_idx, side_y_idx, traversal)
}

#[inline]
fn pathfinder_clearance_at(
    state: &PathfinderState,
    idx: usize,
    traversal: PathfinderTraversal,
) -> i32 {
    if state.terrain_water[idx] == 1 || traversal.allow_water {
        state.medium_clearance[idx] as i32
    } else {
        state.clearance[idx] as i32
    }
}

/// Normalized traversal-time cost for one legal neighboring edge. Flat travel
/// costs its grid distance. Uphill travel uses the acceleration remaining after
/// gravity along the grade, while downhill receives no artificial bonus: the
/// extra surface distance remains real, but there is no speculative top-speed
/// model in the cell-only search. Medium changes add no cost.
#[inline]
pub(crate) fn pathfinder_edge_cost(
    state: &PathfinderState,
    from_gx: i32,
    from_gy: i32,
    to_gx: i32,
    to_gy: i32,
    traversal: PathfinderTraversal,
    cost_profile: PathfinderCostProfile,
) -> f32 {
    let dx = (to_gx - from_gx) as f64;
    let dy = (to_gy - from_gy) as f64;
    let horizontal_cells = (dx * dx + dy * dy).sqrt();
    if horizontal_cells <= 0.0 {
        return 0.0;
    }
    let from_idx = (from_gy * state.grid_w + from_gx) as usize;
    let to_idx = (to_gy * state.grid_w + to_gx) as usize;
    let mut travel_cost = horizontal_cells;

    let dry_ground_edge = !traversal.allow_air
        && traversal.allow_ground
        && state.terrain_water[from_idx] == 0
        && state.terrain_water[to_idx] == 0
        && cost_profile.flat_drive_accel > 0.0;
    if dry_ground_edge {
        let horizontal = horizontal_cells * PATHFINDER_BUILD_GRID_CELL_SIZE;
        let dz = state.terrain_height[to_idx] as f64 - state.terrain_height[from_idx] as f64;
        let surface_distance = (horizontal * horizontal + dz * dz).sqrt();
        let uphill_sine = (dz / surface_distance.max(1.0e-9)).max(0.0);
        let remaining_accel = (cost_profile.flat_drive_accel - GRAVITY * uphill_sine).max(1.0e-9);
        let acceleration_time_scale = (cost_profile.flat_drive_accel / remaining_accel)
            .sqrt()
            .max(1.0);
        travel_cost = surface_distance / PATHFINDER_BUILD_GRID_CELL_SIZE * acceleration_time_scale;
    }

    if !traversal.allow_air
        && cost_profile.soft_clearance_cells > 0
        && cost_profile.soft_clearance_penalty_per_cell > 0.0
    {
        let preferred = cost_profile
            .hard_clearance_cells
            .saturating_add(cost_profile.soft_clearance_cells);
        let shortfall = (preferred - pathfinder_clearance_at(state, to_idx, traversal)).max(0);
        if shortfall > 0 {
            let shortfall = shortfall as f32;
            let multiplier =
                1.0 + cost_profile.soft_clearance_penalty_per_cell * shortfall * shortfall;
            travel_cost *= multiplier as f64;
        }
    }
    travel_cost.min(f32::MAX as f64) as f32
}

pub(crate) fn pathfinder_find_nearest_open(
    state: &PathfinderState,
    gx: i32,
    gy: i32,
    traversal: PathfinderTraversal,
) -> Option<(i32, i32)> {
    for &(dx, dy) in &state.snap_offsets {
        let nx = gx + dx as i32;
        let ny = gy + dy as i32;
        if nx < 0 || ny < 0 || nx >= state.grid_w || ny >= state.grid_h {
            continue;
        }
        if pathfinder_is_cell_passable(state, (ny * state.grid_w + nx) as usize, traversal) {
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
    traversal: PathfinderTraversal,
) -> Option<(i32, i32)> {
    let vx = target_gx - gx;
    let vy = target_gy - gy;
    let v_len_sq = vx * vx + vy * vy;
    if v_len_sq <= 0 {
        return pathfinder_find_nearest_open(state, gx, gy, traversal);
    }

    let mut best: Option<(i32, i32, i32, f64)> = None;
    let inv_v_len = 1.0 / (v_len_sq as f64).sqrt();
    for &(dx, dy) in &state.snap_offsets {
        let nx = gx + dx as i32;
        let ny = gy + dy as i32;
        if nx < 0 || ny < 0 || nx >= state.grid_w || ny >= state.grid_h {
            continue;
        }
        if !pathfinder_is_cell_passable(state, (ny * state.grid_w + nx) as usize, traversal) {
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

#[inline]
pub(crate) fn pathfinder_exact_sample_is_too_steep(
    x: f64,
    y: f64,
    traversal: PathfinderTraversal,
) -> bool {
    if traversal.allow_air {
        return false;
    }
    let (height, normal_z) = pathfinder_sample_terrain(x, y);
    if height < TERRAIN_WATER_LEVEL {
        return !traversal.allow_water;
    }
    (height >= TERRAIN_WATER_LEVEL || traversal.allow_ground)
        && normal_z.is_finite()
        && normal_z < pathfinder_required_step_normal_z(traversal.min_normal_z)
}

#[inline]
pub(crate) fn pathfinder_escape_candidate_is_stable(
    state: &PathfinderState,
    gx: i32,
    gy: i32,
    traversal: PathfinderTraversal,
) -> bool {
    if gx < 0 || gy < 0 || gx >= state.grid_w || gy >= state.grid_h {
        return false;
    }
    let idx = (gy * state.grid_w + gx) as usize;
    if !pathfinder_is_cell_passable(state, idx, traversal) {
        return false;
    }
    if traversal.allow_air || (state.terrain_water[idx] == 1 && traversal.allow_water) {
        return true;
    }
    let (x, y) = pathfinder_cell_center(gx, gy);
    let (height, normal_z) = pathfinder_sample_terrain(x, y);
    (height >= TERRAIN_WATER_LEVEL || traversal.allow_ground)
        && normal_z.is_finite()
        && normal_z >= pathfinder_required_step_normal_z(traversal.min_normal_z)
}

pub(crate) struct StartEscapeResult {
    start_gx: i32,
    start_gy: i32,
    a_star_result: AStarResult,
}

pub(crate) fn pathfinder_try_steep_start_escape(
    state: &mut PathfinderState,
    origin_gx: i32,
    origin_gy: i32,
    goal_gx: i32,
    goal_gy: i32,
    traversal: PathfinderTraversal,
    cost_profile: PathfinderCostProfile,
) -> Option<StartEscapeResult> {
    let target_dx = goal_gx - origin_gx;
    let target_dy = goal_gy - origin_gy;
    let has_target_dir = target_dx != 0 || target_dy != 0;

    // First try candidates in the command direction, then fall back to any
    // nearby stable cell. This lets a unit already on a wall escape either up
    // or down according to the player's click, without turning ordinary flat
    // uphill failures into wall climbs.
    for pass in 0..2 {
        let mut attempts = 0usize;
        for offset_index in 0..state.snap_offsets.len() {
            if attempts >= PATHFINDER_MAX_STEEP_START_ESCAPE_CANDIDATES {
                break;
            }
            let (dx, dy) = state.snap_offsets[offset_index];
            let candidate_gx = origin_gx + dx as i32;
            let candidate_gy = origin_gy + dy as i32;
            if candidate_gx == origin_gx && candidate_gy == origin_gy {
                continue;
            }
            if pass == 0
                && has_target_dir
                && (candidate_gx - origin_gx) * target_dx + (candidate_gy - origin_gy) * target_dy
                    < 0
            {
                continue;
            }

            state.cur_required_clearance = 0;
            if !pathfinder_escape_candidate_is_stable(state, candidate_gx, candidate_gy, traversal)
            {
                continue;
            }
            attempts += 1;

            if candidate_gx == goal_gx && candidate_gy == goal_gy {
                state.path_scratch.clear();
                return Some(StartEscapeResult {
                    start_gx: candidate_gx,
                    start_gy: candidate_gy,
                    a_star_result: AStarResult {
                        goal_gx,
                        goal_gy,
                        reached_goal: true,
                    },
                });
            }

            state.cur_required_clearance = cost_profile.hard_clearance_cells;
            let a_star_result = pathfinder_a_star(
                state,
                candidate_gx,
                candidate_gy,
                goal_gx,
                goal_gy,
                traversal,
                cost_profile,
            );
            if let Some(result) = a_star_result {
                if result.reached_goal || !state.path_scratch.is_empty() {
                    return Some(StartEscapeResult {
                        start_gx: candidate_gx,
                        start_gy: candidate_gy,
                        a_star_result: result,
                    });
                }
            }
        }
    }
    None
}

pub(crate) fn pathfinder_find_nearest_in_component(
    state: &PathfinderState,
    gx: i32,
    gy: i32,
    component: i16,
    traversal: PathfinderTraversal,
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
        if state.cc_labels[idx] == component && pathfinder_is_cell_passable(state, idx, traversal) {
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
            if !pathfinder_is_cell_passable(state, idx, traversal) {
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

#[inline]
fn pathfinder_heap_precedes(state: &PathfinderState, left: u32, right: u32) -> bool {
    let left_idx = left as usize;
    let right_idx = right as usize;
    let left_f = state.f_score[left_idx];
    let right_f = state.f_score[right_idx];
    if left_f != right_f {
        return left_f < right_f;
    }
    // For equal f, prefer the node with more confirmed route cost (therefore
    // less estimated distance remaining), then stable cell order.
    let left_g = state.g_score[left_idx];
    let right_g = state.g_score[right_idx];
    if left_g != right_g {
        return left_g > right_g;
    }
    left < right
}

pub(crate) fn pathfinder_heap_push(state: &mut PathfinderState, idx: u32) {
    state.heap.push(idx);
    let mut i = state.heap.len() - 1;
    while i > 0 {
        let p = (i - 1) >> 1;
        if pathfinder_heap_precedes(state, state.heap[i], state.heap[p]) {
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
            if l < len && pathfinder_heap_precedes(state, state.heap[l], state.heap[s]) {
                s = l;
            }
            if r < len && pathfinder_heap_precedes(state, state.heap[r], state.heap[s]) {
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
    traversal: PathfinderTraversal,
    cost_profile: PathfinderCostProfile,
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
        // Grid connectivity: the first four neighbour offsets are the edge-
        // sharing (cardinal) cells, the last four are the corner-sharing
        // (diagonal) cells. PATHFINDING_ALLOW_DIAGONAL_NEIGHBORS picks 8-way
        // (edges + corners) vs 4-way (edges only) adjacency.
        let neighbor_count = if PATHFINDING_ALLOW_DIAGONAL_NEIGHBORS {
            8
        } else {
            4
        };
        for k in 0..neighbor_count {
            let nx = cgx + PATHFINDER_NEIGHBOR_DX[k];
            let ny = cgy + PATHFINDER_NEIGHBOR_DY[k];
            if nx < 0 || ny < 0 || nx >= grid_w || ny >= grid_h {
                continue;
            }
            let nidx = (ny * grid_w + nx) as usize;
            pathfinder_touch_a_star_cell(state, nidx);
            if !pathfinder_can_step_neighbor(state, cgx, cgy, nx, ny, traversal) {
                continue;
            }
            if state.closed[nidx] != 0 {
                continue;
            }
            let tentative = state.g_score[cur_us]
                + pathfinder_edge_cost(state, cgx, cgy, nx, ny, traversal, cost_profile);
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

/// Trace the same supercover Bresenham segment used by validation and
/// smoothing. Returning its cost keeps path legality and route quality on one
/// traversal primitive; `None` means the segment is illegal.
pub(crate) fn pathfinder_line_cost(
    state: &PathfinderState,
    x0: f64,
    y0: f64,
    x1: f64,
    y1: f64,
    traversal: PathfinderTraversal,
    cost_profile: PathfinderCostProfile,
) -> Option<f32> {
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
    let mut cost = 0.0f32;
    for _ in 0..max_steps {
        if gx < 0 || gy < 0 || gx >= state.grid_w || gy >= state.grid_h {
            return None;
        }
        if !pathfinder_is_grid_cell_passable(state, gx, gy, traversal) {
            return None;
        }
        if gx == tgx && gy == tgy {
            return Some(cost);
        }
        let e2 = 2 * err;
        let a_x = e2 > -dy;
        let a_y = e2 < dx;
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
            return None;
        }
        if !pathfinder_can_step_neighbor(state, gx, gy, next_gx, next_gy, traversal) {
            return None;
        }
        cost += pathfinder_edge_cost(state, gx, gy, next_gx, next_gy, traversal, cost_profile);
        gx = next_gx;
        gy = next_gy;
    }
    None
}

#[inline]
pub(crate) fn pathfinder_has_los(
    state: &PathfinderState,
    x0: f64,
    y0: f64,
    x1: f64,
    y1: f64,
    traversal: PathfinderTraversal,
) -> bool {
    pathfinder_line_cost(
        state,
        x0,
        y0,
        x1,
        y1,
        traversal,
        PathfinderCostProfile::neutral(),
    )
    .is_some()
}

#[inline]
pub(crate) fn pathfinder_cell_center(gx: i32, gy: i32) -> (f64, f64) {
    (
        (gx as f64 + 0.5) * PATHFINDER_BUILD_GRID_CELL_SIZE,
        (gy as f64 + 0.5) * PATHFINDER_BUILD_GRID_CELL_SIZE,
    )
}

#[inline]
pub(crate) fn pathfinder_push_waypoint(state: &mut PathfinderState, x: f64, y: f64) {
    let len = state.waypoint_scratch.len();
    if len >= 2 {
        let last_x = state.waypoint_scratch[len - 2];
        let last_y = state.waypoint_scratch[len - 1];
        if (last_x - x).abs() <= 1.0e-9 && (last_y - y).abs() <= 1.0e-9 {
            return;
        }
    }
    state.waypoint_scratch.push(x);
    state.waypoint_scratch.push(y);
}

/// Plan a path from (start_x, start_y) to (goal_x, goal_y).
/// `min_normal_z` is the per-unit dry-ground slope filter (0 = no filter,
/// matches normalizeMinSurfaceNormalZ returning undefined in JS). The
/// allow_* flags are derived from the unit's usable ground/water/air medium
/// navigation policy: air bypasses terrain, wet cells require explicit water
/// navigation, and dry cells require ground navigation. Physical lakebed
/// contact does not by itself authorize an intentional water route.
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
    allow_ground: bool,
    allow_water: bool,
    allow_air: bool,
    unit_radius: f64,
    flat_drive_accel: f64,
    symmetric_slope: bool,
) -> u32 {
    let state = pathfinder_state();
    state.waypoint_scratch.clear();
    state.last_result_status = PATHFINDER_RESULT_UNREACHABLE;
    let traversal = PathfinderTraversal {
        min_normal_z,
        allow_ground,
        allow_water,
        allow_air,
    };
    // Per-query traversal params. The start may escape without clearance (a
    // unit pushed against a building still needs a way out), but the goal and
    // every planned segment must fit at least the hard physical footprint.
    // Air traversal flies over footprints, so it carries no clearance.
    state.cur_symmetric_slope = symmetric_slope;
    let hard_clearance = if traversal.allow_air {
        0
    } else {
        pathfinder_hard_clearance_cells_for_radius(unit_radius)
    };
    let cost_profile = PathfinderCostProfile::for_query(flat_drive_accel, hard_clearance);
    state.cur_required_clearance = 0;
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
    let mut start_escape_waypoint = false;
    if !pathfinder_is_cell_passable(state, start_idx, traversal) {
        match pathfinder_find_nearest_open_toward(state, sgx, sgy, ggx, ggy, traversal) {
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

    // Goals must fit the physical collision disk. Starts are allowed to be
    // illegal so pushed/knocked units can escape, but snapping a destination
    // without hard clearance would knowingly route the body into overlap.
    state.cur_required_clearance = hard_clearance;
    let mut goal_cell_gx = ggx;
    let mut goal_cell_gy = ggy;
    let mut goal_was_snapped = false;
    let ggy_idx = (ggy * grid_w + ggx) as usize;
    if traversal.allow_air || traversal.allow_water {
        if !pathfinder_is_cell_passable(state, ggy_idx, traversal) {
            match pathfinder_find_nearest_open(state, ggx, ggy, traversal) {
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
            || !pathfinder_is_cell_passable(state, ggy_idx, traversal)
        {
            match pathfinder_find_nearest_in_component(state, ggx, ggy, start_label, traversal) {
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
        state.last_result_status = if goal_was_snapped || start_was_snapped {
            PATHFINDER_RESULT_SNAPPED
        } else {
            PATHFINDER_RESULT_COMPLETE
        };
        return 1;
    }

    // Search and smoothing enforce only physical clearance. Extra stand-off is
    // represented by the soft cost profile and can never make a route illegal.
    state.cur_required_clearance = hard_clearance;

    // BAR-style raw move: if the current leg has direct line-of-sight through
    // passable cells, do not touch A*. This is the common case for open-field
    // move/fight/formation orders and keeps the planner out of the tick path
    // unless terrain or structures actually require a route.
    if !start_was_snapped {
        let (raw_goal_x, raw_goal_y) = if goal_was_snapped {
            pathfinder_cell_center(goal_cell_gx, goal_cell_gy)
        } else {
            (goal_x, goal_y)
        };
        let direct_cost = pathfinder_line_cost(
            state,
            start_x,
            start_y,
            raw_goal_x,
            raw_goal_y,
            traversal,
            cost_profile,
        );
        let geometric_lower_bound =
            pathfinder_octile(start_cell_gx, start_cell_gy, goal_cell_gx, goal_cell_gy);
        if direct_cost.is_some_and(|cost| cost <= geometric_lower_bound + 1.0e-5) {
            state.waypoint_scratch.push(raw_goal_x);
            state.waypoint_scratch.push(raw_goal_y);
            state.last_result_status = if goal_was_snapped {
                PATHFINDER_RESULT_SNAPPED
            } else {
                PATHFINDER_RESULT_COMPLETE
            };
            return 1;
        }
    }

    let mut a_star_result = pathfinder_a_star(
        state,
        start_cell_gx,
        start_cell_gy,
        goal_cell_gx,
        goal_cell_gy,
        traversal,
        cost_profile,
    );
    let made_progress = match &a_star_result {
        Some(result) => result.reached_goal || !state.path_scratch.is_empty(),
        None => false,
    };
    if !made_progress
        && !start_was_snapped
        && pathfinder_exact_sample_is_too_steep(start_x, start_y, traversal)
    {
        if let Some(escape) = pathfinder_try_steep_start_escape(
            state,
            sgx,
            sgy,
            goal_cell_gx,
            goal_cell_gy,
            traversal,
            cost_profile,
        ) {
            start_cell_gx = escape.start_gx;
            start_cell_gy = escape.start_gy;
            start_was_snapped = true;
            start_escape_waypoint = true;
            a_star_result = Some(escape.a_star_result);
        }
    }
    let a_star_result = match a_star_result {
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
        state.last_result_status = PATHFINDER_RESULT_PARTIAL;
    }
    // Cost-aware string pulling. A legal shortcut is accepted only when it is
    // no more expensive than the A* chain it replaces, so smoothing cannot
    // erase slope-time or soft-clearance decisions.
    let mut anchor_x: f64;
    let mut anchor_y: f64;
    if start_was_snapped {
        let (cx, cy) = pathfinder_cell_center(start_cell_gx, start_cell_gy);
        if start_escape_waypoint {
            pathfinder_push_waypoint(state, cx, cy);
        }
        anchor_x = cx;
        anchor_y = cy;
    } else {
        anchor_x = start_x;
        anchor_y = start_y;
    }
    let path_len = state.path_scratch.len();
    if path_len > 1 {
        let first_idx = state.path_scratch[0] as i32;
        let first_gx = first_idx % grid_w;
        let first_gy = (first_idx - first_gx) / grid_w;
        let (first_x, first_y) = pathfinder_cell_center(first_gx, first_gy);
        let mut chain_cost = pathfinder_line_cost(
            state,
            anchor_x,
            anchor_y,
            first_x,
            first_y,
            traversal,
            cost_profile,
        )
        .unwrap_or(f32::INFINITY);
        for i in 0..path_len - 1 {
            let cand_idx = state.path_scratch[i] as i32;
            let next_idx = state.path_scratch[i + 1] as i32;
            let cgx = cand_idx % grid_w;
            let cgy = (cand_idx - cgx) / grid_w;
            let ngx = next_idx % grid_w;
            let ngy = (next_idx - ngx) / grid_w;
            let (cand_x, cand_y) = pathfinder_cell_center(cgx, cgy);
            let (next_x, next_y) = pathfinder_cell_center(ngx, ngy);
            let raw_edge_cost = pathfinder_line_cost(
                state,
                cand_x,
                cand_y,
                next_x,
                next_y,
                traversal,
                cost_profile,
            )
            .unwrap_or(f32::INFINITY);
            chain_cost += raw_edge_cost;
            let shortcut_cost = pathfinder_line_cost(
                state,
                anchor_x,
                anchor_y,
                next_x,
                next_y,
                traversal,
                cost_profile,
            );
            if shortcut_cost.is_none_or(|cost| cost > chain_cost + 1.0e-5) {
                pathfinder_push_waypoint(state, cand_x, cand_y);
                anchor_x = cand_x;
                anchor_y = cand_y;
                chain_cost = raw_edge_cost;
            }
        }
    }
    if goal_was_snapped {
        let (cx, cy) = pathfinder_cell_center(goal_cell_gx, goal_cell_gy);
        pathfinder_push_waypoint(state, cx, cy);
    } else {
        pathfinder_push_waypoint(state, goal_x, goal_y);
    }
    if a_star_result.reached_goal {
        state.last_result_status = if goal_was_snapped {
            PATHFINDER_RESULT_SNAPPED
        } else {
            PATHFINDER_RESULT_COMPLETE
        };
    }
    (state.waypoint_scratch.len() / 2) as u32
}

#[wasm_bindgen]
pub fn pathfinder_last_result_status() -> u32 {
    pathfinder_state().last_result_status
}

/// Validate a world-space polyline against the exact traversal rules consumed
/// by direct LOS, A*, and string-pull smoothing. `points` is interleaved x/y
/// and includes the unit's current position as its first point. Validation uses
/// hard collision clearance only: a translated shared route may give up comfort
/// margin, but it may never overlap water, a structure, map bounds, or an
/// illegal directed slope edge.
#[wasm_bindgen]
pub fn pathfinder_validate_path(
    points: &[f64],
    min_normal_z: f32,
    allow_ground: bool,
    allow_water: bool,
    allow_air: bool,
    unit_radius: f64,
    symmetric_slope: bool,
) -> u32 {
    if points.len() < 4 || points.len() % 2 != 0 {
        return 0;
    }
    let state = pathfinder_state();
    if state.grid_w == 0 || state.grid_h == 0 {
        return 0;
    }
    let traversal = PathfinderTraversal {
        min_normal_z,
        allow_ground,
        allow_water,
        allow_air,
    };
    state.cur_symmetric_slope = symmetric_slope;
    state.cur_required_clearance = if traversal.allow_air {
        0
    } else {
        pathfinder_hard_clearance_cells_for_radius(unit_radius)
    };
    let mut i = 0usize;
    while i + 3 < points.len() {
        let x0 = points[i];
        let y0 = points[i + 1];
        let x1 = points[i + 2];
        let y1 = points[i + 3];
        if !x0.is_finite()
            || !y0.is_finite()
            || !x1.is_finite()
            || !y1.is_finite()
            || !pathfinder_has_los(state, x0, y0, x1, y1, traversal)
        {
            return 0;
        }
        i += 2;
    }
    1
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

#[cfg(test)]
mod tests {
    use super::*;

    fn open_test_state(grid_w: i32, grid_h: i32) -> PathfinderState {
        let mut state = PathfinderState::empty();
        let n = (grid_w * grid_h) as usize;
        state.grid_w = grid_w;
        state.grid_h = grid_h;
        state.n = n;
        state.blocked = vec![0; n];
        state.terrain_water = vec![0; n];
        state.terrain_edge_blocked = vec![0; n];
        state.terrain_height = vec![0.0; n];
        state.terrain_normal_z = vec![1.0; n];
        state.clearance = vec![u16::MAX; n];
        state.medium_clearance = vec![u16::MAX; n];
        state.g_score = vec![f32::INFINITY; n];
        state.f_score = vec![f32::INFINITY; n];
        state.parent = vec![-1; n];
        state.closed = vec![0; n];
        state.visited_gen = vec![0; n];
        state.current_gen = 1;
        state
    }

    fn ground_traversal() -> PathfinderTraversal {
        PathfinderTraversal {
            min_normal_z: 0.0,
            allow_ground: true,
            allow_water: false,
            allow_air: false,
        }
    }

    #[test]
    fn locomotion_climb_profile_is_limited_by_contact_grip() {
        let mut out = [0.0; 7];
        assert_eq!(
            pathfinder_compute_locomotion_climb_profile(
                1_000.0, 1.0, 0.5, 100.0, 20.0, 150_000.0, 100.0, 10.0, GRAVITY, 0.8, 70.0, true,
                false, &mut out,
            ),
            1,
        );
        let expected_grip_slope = 0.5_f64.atan() * 180.0 / core::f64::consts::PI;
        assert!((out[0] - expected_grip_slope).abs() < 1e-9);
        assert!((out[1] - (out[0] * core::f64::consts::PI / 180.0).cos()).abs() < 1e-9);
        assert!((out[4] - expected_grip_slope).abs() < 1e-9);
        assert!((out[6] - GRAVITY * 0.5).abs() < 1e-9);
    }

    #[test]
    fn air_navigation_has_no_terrain_slope_limit() {
        let mut out = [0.0; 7];
        assert_eq!(
            pathfinder_compute_locomotion_climb_profile(
                0.0, 0.0, 0.0, 100.0, 20.0, 150_000.0, 100.0, 10.0, GRAVITY, 0.8, 70.0, false,
                true, &mut out,
            ),
            1,
        );
        assert!(out[0].is_nan() && out[1].is_nan());
        assert!(out[2].is_infinite());
    }

    #[test]
    fn clearance_separates_physical_radius_from_soft_preference() {
        assert_eq!(pathfinder_hard_clearance_cells_for_radius(0.0), 0);
        assert_eq!(pathfinder_hard_clearance_cells_for_radius(9.6), 1);
        let profile = PathfinderCostProfile::for_query(100.0, 1);
        assert_eq!(profile.hard_clearance_cells, 1);
        assert_eq!(
            profile.soft_clearance_cells,
            PATHFINDING_SOFT_CLEARANCE_CELLS
        );
        assert_eq!(pathfinder_hard_clearance_cells_for_radius(50.0), 3);
    }

    #[test]
    fn slope_cost_uses_gravity_reduced_uphill_acceleration() {
        let mut state = open_test_state(2, 1);
        let traversal = ground_traversal();
        let profile = PathfinderCostProfile {
            flat_drive_accel: GRAVITY,
            hard_clearance_cells: 0,
            soft_clearance_cells: 0,
            soft_clearance_penalty_per_cell: 0.0,
        };
        let flat = pathfinder_edge_cost(&state, 0, 0, 1, 0, traversal, profile);
        state.terrain_height[1] = 10.0;
        let uphill = pathfinder_edge_cost(&state, 0, 0, 1, 0, traversal, profile);
        assert!((flat - 1.0).abs() < 1.0e-6);
        assert!(uphill > flat, "uphill time must exceed flat time");
    }

    #[test]
    fn a_star_prefers_faster_flat_detour_over_legal_steep_hill() {
        let mut state = open_test_state(5, 3);
        state.terrain_height[(1 * state.grid_w + 2) as usize] = 15.0;
        let traversal = ground_traversal();
        let profile = PathfinderCostProfile {
            flat_drive_accel: GRAVITY,
            hard_clearance_cells: 0,
            soft_clearance_cells: 0,
            soft_clearance_penalty_per_cell: 0.0,
        };
        let result = pathfinder_a_star(&mut state, 0, 1, 4, 1, traversal, profile)
            .expect("open grid must produce a route");
        assert!(result.reached_goal);
        let hill_idx = (1 * state.grid_w + 2) as u32;
        assert!(
            !state.path_scratch.contains(&hill_idx),
            "time-optimal route should go around the legal but slower hill"
        );
    }

    #[test]
    fn medium_transition_has_no_route_cost() {
        let mut state = open_test_state(2, 1);
        state.terrain_water[1] = 1;
        let traversal = PathfinderTraversal {
            min_normal_z: 0.0,
            allow_ground: true,
            allow_water: true,
            allow_air: false,
        };
        let profile = PathfinderCostProfile {
            flat_drive_accel: GRAVITY,
            hard_clearance_cells: 0,
            soft_clearance_cells: 0,
            soft_clearance_penalty_per_cell: 0.0,
        };
        assert!(
            (pathfinder_edge_cost(&state, 0, 0, 1, 0, traversal, profile) - 1.0).abs() < 1.0e-6
        );
    }

    #[test]
    fn soft_clearance_cost_prefers_open_cells_without_blocking_narrow_routes() {
        let mut state = open_test_state(5, 3);
        state.cur_required_clearance = 1;
        for gx in 1..=3 {
            state.clearance[(1 * state.grid_w + gx) as usize] = 1;
        }
        let traversal = ground_traversal();
        let profile = PathfinderCostProfile {
            flat_drive_accel: 0.0,
            hard_clearance_cells: 1,
            soft_clearance_cells: 2,
            soft_clearance_penalty_per_cell: 0.35,
        };
        let result = pathfinder_a_star(&mut state, 0, 1, 4, 1, traversal, profile)
            .expect("open grid must produce a route");
        assert!(result.reached_goal);
        assert!(state
            .path_scratch
            .iter()
            .any(|&idx| (idx as i32 / state.grid_w) != 1));
        let direct_cost = pathfinder_line_cost(&state, 10.0, 30.0, 90.0, 30.0, traversal, profile)
            .expect("tight direct row remains physically legal");
        let chosen_cost = state.g_score[(1 * state.grid_w + 4) as usize];
        assert!(
            direct_cost > chosen_cost,
            "smoothing must preserve the cheaper open route"
        );

        // Soft preference never changes passability: if only the tight row is
        // available, the same hard-clearance cells remain legal.
        for gy in [0, 2] {
            for gx in 0..state.grid_w {
                state.blocked[(gy * state.grid_w + gx) as usize] = 1;
            }
        }
        let result = pathfinder_a_star(&mut state, 0, 1, 4, 1, traversal, profile)
            .expect("soft clearance must not prohibit the narrow route");
        assert!(result.reached_goal);
    }

    #[test]
    fn diagonal_neighbor_cannot_cut_a_blocked_corner() {
        let mut state = open_test_state(3, 3);
        state.cur_required_clearance = 0;
        let traversal = ground_traversal();

        state.blocked[1 * 3 + 2] = 1;
        assert!(!pathfinder_can_step_neighbor(&state, 1, 1, 2, 2, traversal,));
        state.blocked[1 * 3 + 2] = 0;
        assert!(pathfinder_can_step_neighbor(&state, 1, 1, 2, 2, traversal,));
    }
}

// pathfinder — extracted from lib.rs (pure code motion).

#[allow(unused_imports)]
use crate::*;
#[allow(unused_imports)]
use wasm_bindgen::prelude::*;

// ─────────────────────────────────────────────────────────────────
//  Phase 9 — Pathfinder: A* over the terrain locomotion grid in WASM
//
//  Mirrors src/game/sim/Pathfinder.ts. Full pipeline (ensureMaskAndCC,
//  snap-to-component, A*, Bresenham LOS smoothing) runs inside one
//  WASM call. JS-side Pathfinder.ts becomes a thin wrapper that
//  forwards terrain traversal inputs and reads the smoothed waypoint scratch.
//  Construction-grid reservations and hovering building footprints are not
//  terrain cells and never change locomotion routing.
//
//  Mask + CC are cached internally by terrain version.
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
    /// Broad water contact mask. A cell is set when any part of its terrain
    /// touches water; ground routes use it to conservatively avoid shorelines.
    terrain_water: Vec<u8>,
    /// Strict water-occupancy mask. A cell is set only when its interior is
    /// fully submerged, so water-only units cannot plan onto a beach cell
    /// that merely contains a sliver of water.
    terrain_submerged: Vec<u8>,
    terrain_edge_blocked: Vec<u8>,
    terrain_height: Vec<f32>,
    /// Highest terrain vertex belonging to any triangle that touches the
    /// path cell. Used to conservatively derive the minimum displaced-water
    /// fraction available anywhere in that cell.
    terrain_max_height: Vec<f32>,
    terrain_normal_z: Vec<f32>,
    cc_labels: Vec<i16>,
    /// Chebyshev cell-distance from each open cell to the nearest blocked
    /// cell (0 for blocked cells). Rebuilt with the mask and consumed as a
    /// per-unit collision-clearance gate, so a body of collision radius r is
    /// not routed through gaps narrower than it can fit. Independent of unit
    /// size, so it is cached once per mask rather than per radius.
    clearance: Vec<u16>,
    /// Clearance from map edges only. Water-capable and bed-walking queries
    /// use this so wet cells are not self-obstacles.
    medium_clearance: Vec<u16>,
    /// Clearance from dry shore and map edges. Pure water navigation uses
    /// this configuration-space field so the shared shoreline buffer and
    /// the body's collision disk stay in navigable water rather than
    /// clipping a beach.
    water_clearance: Vec<u16>,

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
    // collision footprint in cells. Every ground direction must satisfy the
    // medium-specific local force envelope; `cur_symmetric_slope` additionally
    // makes the inter-cell climb gate apply downhill (SYMMETRIC mode).
    cur_required_clearance: i32,
    cur_symmetric_slope: bool,
    /// Intentional destination/entry domain for the current query. Physical
    /// passability uses the traversal passed to the kernels; this second
    /// domain only prevents a body that is already in its intended medium
    /// from voluntarily entering a recovery-only medium.
    cur_waypoint_traversal: PathfinderTraversal,

    // Cache key — invalidated on terrain/grid-dimension change.
    terrain_only_key: u64, // = (tVer as u64) << 32 | (gridW as u64) << 16 | gridH

    // Sorted snap offsets — populated once per grid-dim change.
    snap_offsets: Vec<(i16, i16)>,

    // Output: smoothed waypoints as (x, y) f64 pairs.
    waypoint_scratch: Vec<f64>,
    path_scratch: Vec<u32>,
    last_result_status: u32,
}

#[derive(Clone, Copy)]
pub(crate) struct PathfinderTraversal {
    /// Minimum terrain normal supported by the unit's dry-contact force
    /// budget. This is derived from propulsion, mass, gravity, and Coulomb
    /// grip; there is no global angle ceiling.
    min_ground_normal_z: f32,
    /// Equivalent threshold while water covers the terrain. Fluid-supported
    /// bodies ignore the bed. Bed-supported bodies derive their wet threshold
    /// per cell from actual displaced volume at that cell's highest terrain.
    safe_ground_accel: f64,
    safe_water_drive_accel: f64,
    static_friction_coefficient: f64,
    body_radius: f64,
    support_point_offset_z: f64,
    water_surface_supported: bool,
    water_waypoint_hold: bool,
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
    safe_drive_accel: f64,
    flat_water_contact_accel: f64,
    safe_water_drive_accel: f64,
    static_friction_coefficient: f64,
    hard_clearance_cells: i32,
    soft_clearance_cells: i32,
    soft_clearance_penalty_per_cell: f32,
}

impl PathfinderCostProfile {
    #[inline]
    fn for_query(
        flat_drive_accel: f64,
        safe_drive_accel: f64,
        flat_water_contact_accel: f64,
        safe_water_drive_accel: f64,
        static_friction_coefficient: f64,
        hard_clearance_cells: i32,
    ) -> Self {
        Self {
            flat_drive_accel: if flat_drive_accel.is_finite() && flat_drive_accel > 0.0 {
                flat_drive_accel
            } else {
                0.0
            },
            safe_drive_accel: if safe_drive_accel.is_finite() && safe_drive_accel > 0.0 {
                safe_drive_accel
            } else {
                0.0
            },
            flat_water_contact_accel: if flat_water_contact_accel.is_finite()
                && flat_water_contact_accel > 0.0
            {
                flat_water_contact_accel
            } else {
                0.0
            },
            safe_water_drive_accel: if safe_water_drive_accel.is_finite()
                && safe_water_drive_accel > 0.0
            {
                safe_water_drive_accel
            } else {
                0.0
            },
            static_friction_coefficient: if static_friction_coefficient.is_finite() && static_friction_coefficient > 0.0 {
                static_friction_coefficient
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
            safe_drive_accel: 0.0,
            flat_water_contact_accel: 0.0,
            safe_water_drive_accel: 0.0,
            static_friction_coefficient: 0.0,
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
            terrain_submerged: Vec::new(),
            terrain_edge_blocked: Vec::new(),
            terrain_height: Vec::new(),
            terrain_max_height: Vec::new(),
            terrain_normal_z: Vec::new(),
            cc_labels: Vec::new(),
            clearance: Vec::new(),
            medium_clearance: Vec::new(),
            water_clearance: Vec::new(),
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
            cur_waypoint_traversal: PathfinderTraversal {
                min_ground_normal_z: 0.0,
                safe_ground_accel: 0.0,
                safe_water_drive_accel: 0.0,
                static_friction_coefficient: 0.0,
                body_radius: 0.0,
                support_point_offset_z: 0.0,
                water_surface_supported: false,
                water_waypoint_hold: false,
                allow_ground: true,
                allow_water: false,
                allow_air: false,
            },
            terrain_only_key: u64::MAX,
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
    state.terrain_submerged.clear();
    state.terrain_submerged.resize(n, 0);
    state.terrain_edge_blocked.clear();
    state.terrain_edge_blocked.resize(n, 0);
    state.terrain_height.clear();
    state
        .terrain_height
        .resize(n, TERRAIN_WATER_LEVEL as f32 + 1.0);
    state.terrain_max_height.clear();
    state
        .terrain_max_height
        .resize(n, TERRAIN_WATER_LEVEL as f32 + 1.0);
    state.terrain_normal_z.clear();
    state.terrain_normal_z.resize(n, 1.0);
    state.cc_labels.clear();
    state.cc_labels.resize(n, 0);
    state.clearance.clear();
    state.clearance.resize(n, 0);
    state.medium_clearance.clear();
    state.medium_clearance.resize(n, 0);
    state.water_clearance.clear();
    state.water_clearance.resize(n, 0);
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
pub(crate) fn pathfinder_sample_cell_terrain(gx: i32, gy: i32) -> (bool, bool, f32, f32, f32) {
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
    let mut fully_submerged = has_water;
    let mut min_normal_z = center_nz;
    let mut max_height = center_h;
    for (x, y) in samples {
        let (h, nz) = pathfinder_sample_terrain(x, y);
        if h < TERRAIN_WATER_LEVEL {
            has_water = true;
        } else {
            fully_submerged = false;
        }
        if nz < min_normal_z {
            min_normal_z = nz;
        }
        max_height = max_height.max(h);
    }
    terrain_accumulate_touching_triangle_safety(
        x0,
        y0,
        x1,
        y1,
        &mut has_water,
        &mut min_normal_z,
        &mut max_height,
    );
    // Use the cell interior for the strict test. Adjacent terrain triangles
    // that only share the boundary must not turn an otherwise submerged cell
    // into a shore cell; any actual beach area inside the cell still rejects
    // it conservatively through the triangle-vertex test.
    fully_submerged &= terrain_touching_triangles_are_submerged(left, top, right, bottom);
    (
        has_water,
        fully_submerged,
        min_normal_z,
        center_h as f32,
        max_height as f32,
    )
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
    // The per-cell normal is retained so each query can enforce its derived
    // medium-specific force envelope in every cell and the matching rise gate
    // on applicable directed edges.
    let mut water_mask: Vec<u8> = vec![0u8; n];
    let mut submerged_mask: Vec<u8> = vec![0u8; n];
    for gy in 0..grid_h {
        for gx in 0..grid_w {
            let idx = (gy * grid_w + gx) as usize;
            let (has_water, fully_submerged, nz, height, max_height) =
                pathfinder_sample_cell_terrain(gx, gy);
            state.terrain_height[idx] = height;
            state.terrain_max_height[idx] = max_height;
            state.terrain_normal_z[idx] = nz;
            if has_water {
                water_mask[idx] = 1;
            }
            if fully_submerged {
                submerged_mask[idx] = 1;
            }
        }
    }
    state.terrain_water.copy_from_slice(&water_mask);
    state.terrain_submerged.copy_from_slice(&submerged_mask);

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

    // Locomotion is a terrain concern. Construction-grid occupancy reserves
    // build squares only; it must not become elevated terrain, a path blocker,
    // or a clearance source here. Hovering structures therefore never change
    // the movement surface a unit plans across.
    state.blocked.copy_from_slice(&state.terrain_blocked);

    // Clearance distance fields: Chebyshev cell-distance from each open cell
    // to the nearest terrain obstacle (0 for obstacle cells). Ground-only
    // clearance treats water + map edges as obstacles. Medium clearance treats
    // only map edges as obstacles, so amphibious and bed-walking routes do not
    // make wet cells self-blocking. Water-only clearance treats every
    // non-submerged shore cell as an obstacle, keeping an aquatic body's
    // collision disk in water.
    for idx in 0..n {
        state.clearance[idx] = if state.blocked[idx] == 1 { 0 } else { u16::MAX };
        state.medium_clearance[idx] = if state.terrain_edge_blocked[idx] == 1 {
            0
        } else {
            u16::MAX
        };
        state.water_clearance[idx] = if state.terrain_submerged[idx] == 0
            || state.terrain_edge_blocked[idx] == 1
        {
            0
        } else {
            u16::MAX
        };
    }
    pathfinder_rebuild_clearance_distance(&mut state.clearance, grid_w, grid_h);
    pathfinder_rebuild_clearance_distance(&mut state.medium_clearance, grid_w, grid_h);
    pathfinder_rebuild_clearance_distance(&mut state.water_clearance, grid_w, grid_h);

    // CC labelling is an obstacle pre-flight only: slope capability is
    // query-specific and directional, so it cannot be encoded in one shared
    // undirected label.
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

/// Rebuilds the locomotion mask and CC labels from authoritative terrain.
/// Construction-grid occupancy is intentionally excluded: build reservations
/// and route surfaces are separate systems.
#[wasm_bindgen]
pub fn pathfinder_rebuild_terrain_mask_and_cc(terrain_version: u32) {
    let state = pathfinder_state();
    pathfinder_rebuild_terrain_mask(state, terrain_version);
}

#[inline]
pub(crate) fn pathfinder_is_water_only_traversal(traversal: PathfinderTraversal) -> bool {
    !traversal.allow_air && traversal.allow_water && !traversal.allow_ground
}

/// Translate the land-side water dilation into the opposite configuration
/// space for pure-water navigation. Land treats every cell within
/// `PATHFINDING_WATER_BUFFER_CELLS` of water as blocked, then applies the
/// body's hard clearance from that expanded obstacle. Water must do the
/// mirror image: first reserve the same number of cells from dry shore, then
/// apply the body's hard clearance from the resulting shore buffer.
///
/// A zero-radius query still needs one open cell beyond the inclusive buffer:
/// distance zero is the dry-shore obstacle itself, just as a land cell inside
/// the inclusive water dilation is blocked.
#[inline]
pub(crate) fn pathfinder_required_water_clearance_cells(
    hard_clearance_cells: i32,
) -> i32 {
    let shore_buffer = PATHFINDING_WATER_BUFFER_CELLS.max(0);
    if hard_clearance_cells > 0 {
        hard_clearance_cells.saturating_add(shore_buffer)
    } else {
        shore_buffer.saturating_add(1)
    }
}

/// Water-only movement is a volume-occupancy class: its reference point must
/// itself be below the water plane. Cell classification below supplies the
/// conservative footprint clearance; this point check prevents a final raw
/// waypoint from landing on a dry corner of an otherwise relevant grid cell.
#[inline]
pub(crate) fn pathfinder_position_is_in_navigation_domain(
    state: &PathfinderState,
    x: f64,
    y: f64,
    traversal: PathfinderTraversal,
) -> bool {
    if !x.is_finite() || !y.is_finite() || x < 0.0 || y < 0.0 || x >= state.map_width || y >= state.map_height {
        return false;
    }
    !pathfinder_is_water_only_traversal(traversal)
        || pathfinder_sample_terrain(x, y).0 < TERRAIN_WATER_LEVEL
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
    let water_only = pathfinder_is_water_only_traversal(traversal);
    if water_only && state.terrain_submerged[idx] == 0 {
        return false;
    }
    let wet = state.terrain_water[idx] == 1;
    let terrain_blocked = state.blocked[idx] == 1;
    let passable_by_medium = if wet {
        // Intentional water traversal is an explicit pathing class.
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
    let required_normal_z = pathfinder_required_cell_normal_z(state, idx, traversal);
    if state.terrain_normal_z[idx] < required_normal_z {
        return false;
    }
    // Collision-clearance gate: keep a unit of the current query's footprint
    // out of cells whose nearest blocker is closer than the body can fit.
    // cur_required_clearance is 0 during start/goal snapping and for point-size
    // units, so this is inert there (every open cell has clearance >= 1).
    let clearance = if water_only {
        state.water_clearance[idx]
    } else if wet || traversal.allow_water {
        state.medium_clearance[idx]
    } else {
        state.clearance[idx]
    };
    let required_clearance = if water_only {
        pathfinder_required_water_clearance_cells(state.cur_required_clearance)
    } else {
        state.cur_required_clearance
    };
    if (clearance as i32) < required_clearance {
        return false;
    }
    true
}

#[inline]
fn pathfinder_cell_water_fraction(
    state: &PathfinderState,
    idx: usize,
    traversal: PathfinderTraversal,
) -> f64 {
    if state.terrain_water[idx] == 0 {
        return 0.0;
    }
    let terrain_height = state.terrain_max_height[idx] as f64;
    let support_offset = if traversal.support_point_offset_z.is_finite() {
        traversal.support_point_offset_z.max(0.0)
    } else {
        0.0
    };
    unit_force_water_fraction(
        terrain_height + support_offset,
        traversal.body_radius,
    )
}

#[inline]
fn pathfinder_required_cell_normal_z(
    state: &PathfinderState,
    idx: usize,
    traversal: PathfinderTraversal,
) -> f32 {
    if state.terrain_water[idx] == 0 || !traversal.allow_water {
        return pathfinder_required_normal_z(traversal.min_ground_normal_z);
    }
    if traversal.allow_air || traversal.water_surface_supported || !traversal.allow_ground {
        return 0.0;
    }
    if traversal.min_ground_normal_z <= 0.0
        && traversal.safe_ground_accel <= 0.0
        && traversal.safe_water_drive_accel <= 0.0
        && traversal.static_friction_coefficient <= 0.0
    {
        // Explicitly unfiltered developer/test queries keep slope gates off.
        return 0.0;
    }

    // Wet contact propulsion is weighted by the sphere volume actually below
    // the water plane. Use the highest terrain belonging to the conservative
    // path cell, so every point represented by a green square has at least
    // this much water authority at its ground-resting body height.
    let water_fraction = pathfinder_cell_water_fraction(state, idx, traversal);
    let max_move_slope = pathfinder_max_contact_slope_rad(
        traversal.safe_ground_accel,
        traversal.safe_water_drive_accel * water_fraction,
        traversal.static_friction_coefficient,
        GRAVITY,
    );
    let mut required = max_move_slope.cos();
    if traversal.water_waypoint_hold {
        // A destination must both be actively reachable and remain held after
        // commanded water thrust ends. Passive Coulomb grip supplies the hold.
        let hold_normal = traversal
            .static_friction_coefficient
            .max(0.0)
            .atan()
            .cos();
        required = required.max(hold_normal);
    }
    pathfinder_required_normal_z(required as f32)
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
pub(crate) fn pathfinder_required_normal_z(min_normal_z: f32) -> f32 {
    if min_normal_z.is_finite() && min_normal_z > 0.0 {
        min_normal_z.min(1.0)
    } else {
        0.0
    }
}

/// Greatest contact slope on which the safety-reduced actuators can balance
/// the downslope component of weight. Ground drive is capped by the true
/// Coulomb budget `mu * m g cos(theta)`; fluid drive does not consume contact
/// grip. The balance is monotone, so bisection gives a stable answer without
/// inventing a global angle ceiling.
#[inline]
pub(crate) fn pathfinder_max_contact_slope_rad(
    safe_ground_force: f64,
    safe_fluid_force: f64,
    static_friction_coefficient: f64,
    weight_force: f64,
) -> f64 {
    if !weight_force.is_finite() || weight_force <= 0.0 {
        return 0.0;
    }
    let ground_force = safe_ground_force.max(0.0);
    let fluid_force = safe_fluid_force.max(0.0);
    let mu = static_friction_coefficient.max(0.0);
    let half_pi = core::f64::consts::FRAC_PI_2;
    let force_margin = |theta: f64| {
        let normal_load = weight_force * theta.cos().max(0.0);
        ground_force.min(mu * normal_load) + fluid_force - weight_force * theta.sin()
    };
    if force_margin(half_pi) >= -1.0e-12 {
        return half_pi;
    }
    let mut low = 0.0;
    let mut high = half_pi;
    for _ in 0..64 {
        let mid = (low + high) * 0.5;
        if force_margin(mid) >= 0.0 {
            low = mid;
        } else {
            high = mid;
        }
    }
    low
}

/// Derive dry-contact and water-contact climb envelopes from the exact
/// physics mass and the same authored force budgets consumed by the runtime
/// kernel. The only conservatism is the caller-authored propulsion safety
/// ratio; no unrelated global slope limit participates.
#[wasm_bindgen]
pub fn pathfinder_compute_locomotion_climb_profile(
    ground_max_propulsive_force: f64,
    water_max_propulsive_force: f64,
    static_friction_coefficient: f64,
    physics_mass: f64,
    gravity: f64,
    force_safety_ratio: f64,
    allow_ground: bool,
    allow_water: bool,
    allow_air: bool,
    water_surface_supported: bool,
    out: &mut [f64],
) -> u32 {
    const PROFILE_LEN: usize = 12;
    if out.len() < PROFILE_LEN {
        return 0;
    }
    if !physics_mass.is_finite()
        || physics_mass <= 0.0
        || !gravity.is_finite()
        || gravity <= 0.0
    {
        return 0;
    }

    let ratio = force_safety_ratio.clamp(0.0, 1.0);
    let ground_force = if allow_ground {
        ground_max_propulsive_force.max(0.0)
    } else {
        0.0
    };
    let water_force = if allow_water {
        water_max_propulsive_force.max(0.0)
    } else {
        0.0
    };
    let mu = static_friction_coefficient.max(0.0);
    let weight_force = physics_mass * gravity / 1_000_000.0;
    let drive_accel = ground_force * 1_000_000.0 / physics_mass;
    let traction_accel = gravity * mu;
    let flat_drive_accel = drive_accel.min(traction_accel).max(0.0);
    let safe_ground_force = ground_force * ratio;
    let safe_water_force = water_force * ratio;
    let safe_drive_accel = safe_ground_force * 1_000_000.0 / physics_mass;
    let safe_water_drive_accel = safe_water_force * 1_000_000.0 / physics_mass;
    let radians_to_degrees = 180.0 / core::f64::consts::PI;
    let (max_ground_slope_deg, min_ground_normal_z, drive_limited_slope_deg,
        traction_limited_slope_deg) = if allow_ground {
        let drive_limit = (safe_drive_accel / gravity).clamp(0.0, 1.0).asin();
        let traction_limit = mu.atan();
        let max_slope = drive_limit.min(traction_limit);
        (
            max_slope * radians_to_degrees,
            max_slope.cos(),
            drive_limit * radians_to_degrees,
            traction_limit * radians_to_degrees,
        )
    } else {
        (f64::NAN, f64::NAN, f64::NAN, f64::NAN)
    };
    let (max_water_slope_deg, min_water_normal_z) = if !allow_water || allow_air {
        (f64::NAN, f64::NAN)
    } else if water_surface_supported || !allow_ground {
        // A fluid-supported body does not transmit its weight through the bed,
        // so lakebed angle is not a locomotion constraint.
        (f64::NAN, f64::NAN)
    } else {
        let max_slope = pathfinder_max_contact_slope_rad(
            safe_ground_force,
            safe_water_force,
            mu,
            weight_force,
        );
        (max_slope * radians_to_degrees, max_slope.cos())
    };
    let flat_water_contact_force = if allow_water {
        if water_surface_supported || !allow_ground {
            water_force
        } else {
            ground_force.min(mu * weight_force) + water_force
        }
    } else {
        0.0
    };
    let flat_water_contact_accel =
        flat_water_contact_force * 1_000_000.0 / physics_mass;
    out[..PROFILE_LEN].copy_from_slice(&[
        max_ground_slope_deg,
        min_ground_normal_z,
        safe_drive_accel,
        drive_limited_slope_deg,
        traction_limited_slope_deg,
        flat_drive_accel,
        max_water_slope_deg,
        min_water_normal_z,
        safe_water_drive_accel,
        flat_water_contact_accel,
        if water_surface_supported || !allow_water || !allow_ground || allow_air {
            f64::NAN
        } else {
            max_water_slope_deg.min(traction_limited_slope_deg)
        },
        if water_surface_supported || !allow_water || !allow_ground || allow_air {
            f64::NAN
        } else {
            (max_water_slope_deg.min(traction_limited_slope_deg) / radians_to_degrees).cos()
        },
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
    if traversal.allow_air {
        return true;
    }
    let from_h = state.terrain_height[from_idx] as f64;
    let to_h = state.terrain_height[to_idx] as f64;
    if !from_h.is_finite() || !to_h.is_finite() {
        return false;
    }
    // Each medium owns its own mass/force-derived contact envelope. A
    // fluid-supported water cell reports zero and therefore ignores lakebed
    // angle; a bed-supported cell must satisfy the same force balance as the
    // runtime contact actuator.
    let from_required_normal_z =
        pathfinder_required_cell_normal_z(state, from_idx, traversal);
    let to_required_normal_z =
        pathfinder_required_cell_normal_z(state, to_idx, traversal);
    if state.terrain_normal_z[from_idx] < from_required_normal_z
        || state.terrain_normal_z[to_idx] < to_required_normal_z
    {
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
    // DIRECTIONAL mode preserves one-way controlled descent, but unlike the old
    // fall-permitting rule the full surface already passed its local force test
    // above. SYMMETRIC mode additionally requires uphill coupling authority in
    // both directions.
    if dz <= 0.0 && !state.cur_symmetric_slope {
        return true;
    }
    let required_normal_z = from_required_normal_z.max(to_required_normal_z);
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
    // Directed recovery rule: an externally displaced body may move through
    // physically traversable recovery-only cells and enter its waypoint
    // domain, but once inside that intended domain it may not route back out.
    if pathfinder_is_cell_passable(state, from_idx, state.cur_waypoint_traversal)
        && !pathfinder_is_cell_passable(state, to_idx, state.cur_waypoint_traversal)
    {
        return false;
    }
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
    if pathfinder_is_water_only_traversal(traversal) {
        // Match ground-space clearance: land measures from the water mask
        // after it has been dilated by the shared shore buffer, so water must
        // measure from dry shore after removing the same buffer.
        (state.water_clearance[idx] as i32)
            .saturating_sub(PATHFINDING_WATER_BUFFER_CELLS.max(0))
    } else if state.terrain_water[idx] == 1 || traversal.allow_water {
        state.medium_clearance[idx] as i32
    } else {
        state.clearance[idx] as i32
    }
}

/// Normalized traversal-time cost for one legal neighboring edge. Flat travel
/// costs its grid distance. Bed-supported travel reserves the combined safe
/// tangential force budget for cross-slope support before assigning what
/// remains to forward acceleration; wet contact adds independent water drive
/// to the Coulomb-limited ground actuator. Uphill then subtracts gravity along
/// the route. Fluid-supported water ignores lakebed geometry. A downhill edge
/// receives no speculative speed bonus, keeping octile distance admissible.
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

    let wet_edge = state.terrain_water[from_idx] != 0 || state.terrain_water[to_idx] != 0;
    let bed_supported_edge = !traversal.allow_air
        && traversal.allow_ground
        && (!wet_edge || !traversal.water_surface_supported);
    let has_contact_accel = if wet_edge {
        cost_profile.flat_water_contact_accel > 0.0
    } else {
        cost_profile.flat_drive_accel > 0.0
    };
    if bed_supported_edge && has_contact_accel {
        let horizontal = horizontal_cells * PATHFINDER_BUILD_GRID_CELL_SIZE;
        let dz = state.terrain_height[to_idx] as f64 - state.terrain_height[from_idx] as f64;
        let surface_distance = (horizontal * horizontal + dz * dz).sqrt();
        let directional_sine = dz / surface_distance.max(1.0e-9);
        let uphill_sine = directional_sine.max(0.0);
        let normal_z = (state.terrain_normal_z[from_idx] as f64)
            .min(state.terrain_normal_z[to_idx] as f64)
            .clamp(0.0, 1.0);
        let total_tangent_sine = (1.0 - normal_z * normal_z).max(0.0).sqrt();
        let lateral_sine_sq = (total_tangent_sine * total_tangent_sine
            - directional_sine * directional_sine)
            .max(0.0);
        let lateral_hold_accel = GRAVITY * lateral_sine_sq.sqrt();
        let grip_accel = GRAVITY * cost_profile.static_friction_coefficient * normal_z;
        let safe_ground_accel = cost_profile.safe_drive_accel.min(grip_accel);
        let safe_water_accel = if wet_edge {
            let from_wet = state.terrain_water[from_idx] != 0;
            let to_wet = state.terrain_water[to_idx] != 0;
            let water_fraction = match (from_wet, to_wet) {
                (true, true) => pathfinder_cell_water_fraction(state, from_idx, traversal)
                    .min(pathfinder_cell_water_fraction(state, to_idx, traversal)),
                (true, false) => pathfinder_cell_water_fraction(state, from_idx, traversal),
                (false, true) => pathfinder_cell_water_fraction(state, to_idx, traversal),
                (false, false) => 0.0,
            };
            cost_profile.safe_water_drive_accel * water_fraction
        } else {
            0.0
        };
        // Ground traction and occupancy-weighted fluid thrust contribute to
        // the same available tangent-force budget before cross-slope support.
        let total_tangent_budget = safe_ground_accel + safe_water_accel;
        if lateral_hold_accel >= total_tangent_budget {
            return f32::MAX;
        }
        let longitudinal_budget =
            (total_tangent_budget * total_tangent_budget
                - lateral_hold_accel * lateral_hold_accel)
                .max(0.0)
                .sqrt();
        let remaining_accel =
            (longitudinal_budget - GRAVITY * uphill_sine).max(1.0e-9);
        let flat_safe_accel = cost_profile
            .safe_drive_accel
            .min(GRAVITY * cost_profile.static_friction_coefficient)
            + safe_water_accel;
        let acceleration_time_scale = (flat_safe_accel / remaining_accel)
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
/// Dry contact receives one precomputed minimum normal. Wet contact derives
/// its MOVE and WAYPOINT thresholds per cell from body immersion, safe force
/// budgets, and whether lift makes the body independent of the lakebed. The
/// waypoint_allow_* flags define intentional destinations and entries, while
/// move_allow_* flags define physical traversal. A pure-water route
/// additionally requires fully submerged cells and shore clearance. Physical
/// lakebed contact does not by itself authorize an intentional water route.
/// Smoothed waypoints land in `waypoint_scratch` as interleaved
/// (x, y) f64 pairs; returns the waypoint count.
///
/// Note: caller must have run pathfinder_init +
/// pathfinder_rebuild_terrain_mask_and_cc for the current terrain state
/// before calling this.
#[wasm_bindgen]
pub fn pathfinder_find_path(
    start_x: f64,
    start_y: f64,
    goal_x: f64,
    goal_y: f64,
    min_ground_normal_z: f32,
    water_surface_supported: bool,
    support_point_offset_z: f64,
    waypoint_allow_ground: bool,
    waypoint_allow_water: bool,
    waypoint_allow_air: bool,
    move_allow_ground: bool,
    move_allow_water: bool,
    move_allow_air: bool,
    unit_radius: f64,
    flat_drive_accel: f64,
    safe_drive_accel: f64,
    flat_water_contact_accel: f64,
    safe_water_drive_accel: f64,
    static_friction_coefficient: f64,
    symmetric_slope: bool,
) -> u32 {
    let state = pathfinder_state();
    state.waypoint_scratch.clear();
    state.last_result_status = PATHFINDER_RESULT_UNREACHABLE;
    let traversal = PathfinderTraversal {
        min_ground_normal_z,
        safe_ground_accel: safe_drive_accel,
        safe_water_drive_accel,
        static_friction_coefficient,
        body_radius: unit_radius,
        support_point_offset_z,
        water_surface_supported,
        water_waypoint_hold: false,
        allow_ground: move_allow_ground,
        allow_water: move_allow_water,
        allow_air: move_allow_air,
    };
    let waypoint_traversal = PathfinderTraversal {
        min_ground_normal_z,
        safe_ground_accel: safe_drive_accel,
        safe_water_drive_accel,
        static_friction_coefficient,
        body_radius: unit_radius,
        support_point_offset_z,
        water_surface_supported,
        water_waypoint_hold: true,
        allow_ground: waypoint_allow_ground,
        allow_water: waypoint_allow_water,
        allow_air: waypoint_allow_air,
    };
    state.cur_waypoint_traversal = waypoint_traversal;
    // Per-query traversal params. The current cell must be physically
    // move-valid, even when it is outside the intentional waypoint domain.
    // Goals must be waypoint-valid and every segment must fit the body.
    // Air traversal flies over footprints, so it carries no clearance.
    state.cur_symmetric_slope = symmetric_slope;
    let hard_clearance = if traversal.allow_air {
        0
    } else {
        pathfinder_hard_clearance_cells_for_radius(unit_radius)
    };
    let cost_profile = PathfinderCostProfile::for_query(
        flat_drive_accel,
        safe_drive_accel,
        flat_water_contact_accel,
        safe_water_drive_accel,
        static_friction_coefficient,
        hard_clearance,
    );
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

    // A physically blocked start is terminal. A waypoint-invalid but
    // move-valid start is a recovery start and may route into its intended
    // domain.
    let start_cell_gx = sgx;
    let start_cell_gy = sgy;
    if !pathfinder_position_is_in_navigation_domain(state, start_x, start_y, traversal)
        || !pathfinder_is_cell_passable(state, start_idx, traversal)
    {
        state.waypoint_scratch.push(start_x);
        state.waypoint_scratch.push(start_y);
        return 1;
    }

    // Goals must fit the physical collision disk. Snapping a destination
    // without hard clearance would knowingly route the body into overlap.
    state.cur_required_clearance = hard_clearance;
    let mut goal_cell_gx = ggx;
    let mut goal_cell_gy = ggy;
    let mut goal_was_snapped = false;
    let ggy_idx = (ggy * grid_w + ggx) as usize;
    let start_is_waypoint_valid =
        pathfinder_is_cell_passable(state, start_idx, waypoint_traversal);
    if waypoint_traversal.allow_air || waypoint_traversal.allow_water || !start_is_waypoint_valid {
        if !pathfinder_position_is_in_navigation_domain(state, goal_x, goal_y, waypoint_traversal)
            || !pathfinder_is_cell_passable(state, ggy_idx, waypoint_traversal)
        {
            match pathfinder_find_nearest_open(state, ggx, ggy, waypoint_traversal) {
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
            || !pathfinder_is_cell_passable(state, ggy_idx, waypoint_traversal)
        {
            match pathfinder_find_nearest_in_component(state, ggx, ggy, start_label, waypoint_traversal) {
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
        state.last_result_status = if goal_was_snapped {
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

    let a_star_result = pathfinder_a_star(
        state,
        start_cell_gx,
        start_cell_gy,
        goal_cell_gx,
        goal_cell_gy,
        traversal,
        cost_profile,
    );
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
            state.waypoint_scratch.push(start_x);
            state.waypoint_scratch.push(start_y);
            return 1;
        }
        state.last_result_status = PATHFINDER_RESULT_PARTIAL;
    }
    // Cost-aware string pulling. A legal shortcut is accepted only when it is
    // no more expensive than the A* chain it replaces, so smoothing cannot
    // erase slope-time or soft-clearance decisions.
    let mut anchor_x = start_x;
    let mut anchor_y = start_y;
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
/// margin, but it may never overlap water, dry shore for a pure-water unit, a
/// structure, map bounds, an unsupported local surface, or an illegal
/// directed climb edge.
#[wasm_bindgen]
pub fn pathfinder_validate_path(
    points: &[f64],
    min_ground_normal_z: f32,
    water_surface_supported: bool,
    support_point_offset_z: f64,
    waypoint_allow_ground: bool,
    waypoint_allow_water: bool,
    waypoint_allow_air: bool,
    move_allow_ground: bool,
    move_allow_water: bool,
    move_allow_air: bool,
    unit_radius: f64,
    safe_drive_accel: f64,
    safe_water_drive_accel: f64,
    static_friction_coefficient: f64,
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
        min_ground_normal_z,
        safe_ground_accel: safe_drive_accel,
        safe_water_drive_accel,
        static_friction_coefficient,
        body_radius: unit_radius,
        support_point_offset_z,
        water_surface_supported,
        water_waypoint_hold: false,
        allow_ground: move_allow_ground,
        allow_water: move_allow_water,
        allow_air: move_allow_air,
    };
    let waypoint_traversal = PathfinderTraversal {
        min_ground_normal_z,
        safe_ground_accel: safe_drive_accel,
        safe_water_drive_accel,
        static_friction_coefficient,
        body_radius: unit_radius,
        support_point_offset_z,
        water_surface_supported,
        water_waypoint_hold: true,
        allow_ground: waypoint_allow_ground,
        allow_water: waypoint_allow_water,
        allow_air: waypoint_allow_air,
    };
    state.cur_waypoint_traversal = waypoint_traversal;
    state.cur_symmetric_slope = symmetric_slope;
    state.cur_required_clearance = if traversal.allow_air {
        0
    } else {
        pathfinder_hard_clearance_cells_for_radius(unit_radius)
    };
    let last_x = points[points.len() - 2];
    let last_y = points[points.len() - 1];
    if !pathfinder_position_is_in_navigation_domain(state, last_x, last_y, waypoint_traversal) {
        return 0;
    }
    let last_gx = (last_x / PATHFINDER_BUILD_GRID_CELL_SIZE).floor() as i32;
    let last_gy = (last_y / PATHFINDER_BUILD_GRID_CELL_SIZE).floor() as i32;
    if !pathfinder_is_grid_cell_passable(state, last_gx, last_gy, waypoint_traversal) {
        return 0;
    }
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
            || !pathfinder_position_is_in_navigation_domain(state, x0, y0, traversal)
            || !pathfinder_position_is_in_navigation_domain(state, x1, y1, traversal)
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
        state.terrain_submerged = vec![0; n];
        state.terrain_edge_blocked = vec![0; n];
        state.terrain_height = vec![0.0; n];
        state.terrain_max_height = vec![0.0; n];
        state.terrain_normal_z = vec![1.0; n];
        state.clearance = vec![u16::MAX; n];
        state.medium_clearance = vec![u16::MAX; n];
        state.water_clearance = vec![u16::MAX; n];
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
            min_ground_normal_z: 0.0,
            safe_ground_accel: 0.0,
            safe_water_drive_accel: 0.0,
            static_friction_coefficient: 0.0,
            body_radius: 1.0,
            support_point_offset_z: 0.0,
            water_surface_supported: false,
            water_waypoint_hold: false,
            allow_ground: true,
            allow_water: false,
            allow_air: false,
        }
    }

    fn ground_cost_profile(flat_drive_accel: f64) -> PathfinderCostProfile {
        PathfinderCostProfile {
            flat_drive_accel,
            safe_drive_accel: flat_drive_accel * 0.85,
            flat_water_contact_accel: 0.0,
            safe_water_drive_accel: 0.0,
            static_friction_coefficient: 1.0,
            hard_clearance_cells: 0,
            soft_clearance_cells: 0,
            soft_clearance_penalty_per_cell: 0.0,
        }
    }

    #[test]
    fn locomotion_climb_profile_is_limited_by_contact_grip() {
        let mut out = [0.0; 12];
        assert_eq!(
            pathfinder_compute_locomotion_climb_profile(
                1_000.0, 0.0, 0.5, 1_000_000.0, GRAVITY, 0.85,
                true, false, false, false, &mut out,
            ),
            1,
        );
        let expected_grip_slope = 0.5_f64.atan() * 180.0 / core::f64::consts::PI;
        assert!((out[0] - expected_grip_slope).abs() < 1e-9);
        assert!((out[1] - (out[0] * core::f64::consts::PI / 180.0).cos()).abs() < 1e-9);
        assert!((out[4] - expected_grip_slope).abs() < 1e-9);
        assert!((out[5] - GRAVITY * 0.5).abs() < 1e-9);
        assert!(out[6].is_nan() && out[7].is_nan());
        assert_eq!(out[8], 0.0);
    }

    #[test]
    fn air_navigation_has_no_terrain_slope_limit() {
        let mut out = [0.0_f64; 12];
        assert_eq!(
            pathfinder_compute_locomotion_climb_profile(
                0.0, 1.0, 0.0, 1_000_000.0, GRAVITY, 0.85,
                false, true, true, false, &mut out,
            ),
            1,
        );
        assert!(out[0].is_nan() && out[1].is_nan());
        assert!(out[6].is_nan() && out[7].is_nan());
    }

    #[test]
    fn wet_move_envelope_has_no_global_angle_ceiling() {
        let mut out = [0.0_f64; 12];
        assert_eq!(
            pathfinder_compute_locomotion_climb_profile(
                0.0, 3.0, 1.0, 10_000.0, 100.0, 0.85,
                true, true, false, false, &mut out,
            ),
            1,
        );
        assert!((out[6] - 90.0).abs() < 1.0e-9);
        assert!(out[7].abs() < 1.0e-9);
    }

    #[test]
    fn physical_mass_reduces_force_limited_dry_and_wet_slopes() {
        let mut light = [0.0_f64; 12];
        let mut heavy = [0.0_f64; 12];
        for (mass, out) in [(1_000.0, &mut light), (10_000.0, &mut heavy)] {
            assert_eq!(
                pathfinder_compute_locomotion_climb_profile(
                    0.5, 0.4, 1.0, mass, 300.0, 0.85,
                    true, true, false, false, out,
                ),
                1,
            );
        }
        assert!(light[0] > heavy[0]);
        assert!(light[6] > heavy[6]);
    }

    #[test]
    fn wet_waypoint_requires_unpowered_contact_hold() {
        let mut out = [0.0_f64; 12];
        assert_eq!(
            pathfinder_compute_locomotion_climb_profile(
                0.2, 0.8, 1.0, 10_000.0, 100.0, 0.85,
                true, true, false, false, &mut out,
            ),
            1,
        );
        assert!(out[6] > out[10]);
        assert!((out[10] - 45.0).abs() < 1.0e-9);
        assert!(out[11] > out[7]);
    }

    #[test]
    fn fluid_supported_water_ignores_lakebed_angle() {
        let mut out = [0.0_f64; 12];
        assert_eq!(
            pathfinder_compute_locomotion_climb_profile(
                0.2, 0.8, 1.0, 10_000.0, 100.0, 0.85,
                true, true, false, true, &mut out,
            ),
            1,
        );
        assert!(out[6].is_nan() && out[7].is_nan());
        assert!(out[10].is_nan() && out[11].is_nan());
    }

    #[test]
    fn wet_cell_force_uses_actual_displaced_water_volume() {
        let mut state = open_test_state(1, 1);
        state.terrain_water[0] = 1;
        state.terrain_submerged[0] = 1;
        state.terrain_normal_z[0] = 0.6;
        state.terrain_max_height[0] = (TERRAIN_WATER_LEVEL - 100.0) as f32;
        let move_traversal = PathfinderTraversal {
            min_ground_normal_z: 0.8,
            safe_ground_accel: 100.0,
            safe_water_drive_accel: 300.0,
            static_friction_coefficient: 1.0,
            body_radius: 20.0,
            support_point_offset_z: 0.0,
            water_surface_supported: false,
            water_waypoint_hold: false,
            allow_ground: true,
            allow_water: true,
            allow_air: false,
        };
        assert!(pathfinder_is_cell_passable(&state, 0, move_traversal));

        let waypoint_traversal = PathfinderTraversal {
            water_waypoint_hold: true,
            ..move_traversal
        };
        assert!(!pathfinder_is_cell_passable(&state, 0, waypoint_traversal));

        state.terrain_max_height[0] = (TERRAIN_WATER_LEVEL + 25.0) as f32;
        assert!(
            !pathfinder_is_cell_passable(&state, 0, move_traversal),
            "a terrain-wet cell whose resting body is dry has no water-thrust budget",
        );
    }

    #[test]
    fn clearance_separates_physical_radius_from_soft_preference() {
        assert_eq!(pathfinder_hard_clearance_cells_for_radius(0.0), 0);
        assert_eq!(pathfinder_hard_clearance_cells_for_radius(9.6), 1);
        let profile = PathfinderCostProfile::for_query(100.0, 80.0, 0.0, 0.0, 0.75, 1);
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
        let profile = ground_cost_profile(GRAVITY);
        let flat = pathfinder_edge_cost(&state, 0, 0, 1, 0, traversal, profile);
        state.terrain_height[1] = 10.0;
        let uphill = pathfinder_edge_cost(&state, 0, 0, 1, 0, traversal, profile);
        assert!((flat - 1.0).abs() < 1.0e-6);
        assert!(uphill > flat, "uphill time must exceed flat time");
    }

    #[test]
    fn every_route_surface_must_fit_its_local_force_envelope() {
        let mut state = open_test_state(2, 1);
        state.terrain_height[0] = 10.0;
        state.terrain_normal_z[0] = 0.6;
        state.terrain_normal_z[1] = 0.6;
        let traversal = PathfinderTraversal {
            min_ground_normal_z: 0.8,
            safe_ground_accel: 0.0,
            safe_water_drive_accel: 0.0,
            static_friction_coefficient: 0.0,
            body_radius: 1.0,
            support_point_offset_z: 0.0,
            water_surface_supported: false,
            water_waypoint_hold: false,
            allow_ground: true,
            allow_water: false,
            allow_air: false,
        };
        assert!(
            !pathfinder_can_step_height_delta(&state, 0, 1, traversal),
            "downhill is not a valid route when the unit cannot stop on the face"
        );
    }

    #[test]
    fn uphill_constraint_does_not_reject_valid_downhill_travel() {
        let mut state = open_test_state(2, 1);
        state.terrain_height[1] = 15.0;
        // Both cells themselves support the unit. Only the inter-cell climb
        // is too steep, so directed mode may still traverse it downhill.
        state.terrain_normal_z[0] = 0.95;
        state.terrain_normal_z[1] = 0.95;
        let traversal = PathfinderTraversal {
            min_ground_normal_z: 0.9,
            safe_ground_accel: 0.0,
            safe_water_drive_accel: 0.0,
            static_friction_coefficient: 0.0,
            body_radius: 1.0,
            support_point_offset_z: 0.0,
            water_surface_supported: false,
            water_waypoint_hold: false,
            allow_ground: true,
            allow_water: false,
            allow_air: false,
        };
        assert!(!pathfinder_can_step_height_delta(&state, 0, 1, traversal));
        assert!(pathfinder_can_step_height_delta(&state, 1, 0, traversal));
    }

    #[test]
    fn contour_travel_reserves_grip_for_cross_slope_hold() {
        let mut state = open_test_state(2, 1);
        let traversal = ground_traversal();
        let profile = ground_cost_profile(GRAVITY);
        let flat = pathfinder_edge_cost(&state, 0, 0, 1, 0, traversal, profile);
        state.terrain_normal_z[0] = 0.8;
        state.terrain_normal_z[1] = 0.8;
        let contour = pathfinder_edge_cost(&state, 0, 0, 1, 0, traversal, profile);
        assert!(
            contour > flat,
            "holding position across a side slope must consume traction"
        );
    }

    #[test]
    fn a_star_prefers_faster_flat_detour_over_legal_steep_hill() {
        let mut state = open_test_state(5, 3);
        state.terrain_height[(1 * state.grid_w + 2) as usize] = 15.0;
        let traversal = ground_traversal();
        let profile = ground_cost_profile(GRAVITY);
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
            min_ground_normal_z: 0.0,
            safe_ground_accel: 0.0,
            safe_water_drive_accel: 0.0,
            static_friction_coefficient: 0.0,
            body_radius: 1.0,
            support_point_offset_z: 0.0,
            water_surface_supported: false,
            water_waypoint_hold: false,
            allow_ground: true,
            allow_water: true,
            allow_air: false,
        };
        let profile = ground_cost_profile(GRAVITY);
        assert!(
            (pathfinder_edge_cost(&state, 0, 0, 1, 0, traversal, profile) - 1.0).abs() < 1.0e-6
        );
    }

    #[test]
    fn water_only_navigation_mirrors_land_water_buffer_and_body_clearance() {
        let mut state = open_test_state(7, 1);
        let traversal = PathfinderTraversal {
            min_ground_normal_z: 0.0,
            safe_ground_accel: 0.0,
            safe_water_drive_accel: 0.0,
            static_friction_coefficient: 0.0,
            body_radius: 1.0,
            support_point_offset_z: 0.0,
            water_surface_supported: false,
            water_waypoint_hold: false,
            allow_ground: false,
            allow_water: true,
            allow_air: false,
        };
        // Every cell touches water, but only cells 1..=6 have enough water
        // volume to occupy. This models a sloped shoreline cell at index 0.
        state.terrain_water.fill(1);
        state.terrain_submerged = vec![0, 1, 1, 1, 1, 1, 1];
        state.water_clearance = vec![0, 1, 2, 3, 4, 5, 6];

        state.cur_required_clearance = 0;
        assert!(
            !pathfinder_is_cell_passable(&state, 0, traversal),
            "a shoreline cell that merely touches water is not pure-water navigable"
        );
        assert!(
            !pathfinder_is_cell_passable(&state, 2, traversal),
            "pure-water navigation must reserve the same inclusive shore buffer as land"
        );
        assert!(
            pathfinder_is_cell_passable(&state, 3, traversal),
            "the first water cell beyond the shared shore buffer is usable"
        );

        state.cur_required_clearance = 3;
        assert!(
            !pathfinder_is_cell_passable(&state, 4, traversal),
            "body clearance must be measured beyond, not instead of, the shore buffer"
        );
        assert!(pathfinder_is_cell_passable(&state, 5, traversal));
        assert_eq!(pathfinder_clearance_at(&state, 5, traversal), 3);
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
            safe_drive_accel: 0.0,
            flat_water_contact_accel: 0.0,
            safe_water_drive_accel: 0.0,
            static_friction_coefficient: 0.0,
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

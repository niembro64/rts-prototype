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
pub(crate) const PATHFINDER_SEARCH_NONE: u32 = 0;
pub(crate) const PATHFINDER_SEARCH_DIRECT: u32 = 1;
pub(crate) const PATHFINDER_SEARCH_HIERARCHICAL: u32 = 2;
pub(crate) const PATHFINDER_SEARCH_FINE_A_STAR: u32 = 3;
pub(crate) const PATHFINDER_HIERARCHY_MAX_REFINEMENTS: u32 = 4;
/// Independent of shoreline classification. Terrain-bound unit centers stay
/// out of the outer map guard cells even for point-size developer queries.
pub(crate) const PATHFINDER_MAP_EDGE_BUFFER_CELLS: i32 = 2;

pub(crate) struct PathfinderState {
    grid_w: i32,
    grid_h: i32,
    n: usize,
    map_width: f64,
    map_height: f64,

    blocked: Vec<u8>,
    terrain_blocked: Vec<u8>,
    /// A cell is set when any positive interior portion lies below water.
    terrain_water: Vec<u8>,
    /// A cell is set only when no positive interior portion is exposed above
    /// water. Together with `terrain_water`, this yields the exact binary
    /// medium cases: dry/exposed, water, or both.
    terrain_submerged: Vec<u8>,
    terrain_edge_blocked: Vec<u8>,
    /// Dynamic obstacle layer: grounded building footprint cells, synced
    /// from the TS BuildingGrid (see pathfinder_sync_building_occupancy).
    /// Hovering structures never appear here.
    building_blocked: Vec<u8>,
    /// BuildingGrid version of the installed layer; 0 = not synced.
    building_occupancy_version: u32,
    terrain_height: Vec<f32>,
    terrain_normal_z: Vec<f32>,
    /// Minimum normal of the terrain transition between neighboring cell
    /// interiors. Four canonical forward edges (E, SE, S, SW) per cell retain
    /// cliffs as blocked transitions without making either flat neighbor an
    /// invalid square.
    terrain_transition_normal_z: Vec<f32>,
    cc_labels: Vec<i16>,
    /// Chebyshev cell-distance from each open cell to the nearest blocked
    /// cell (0 for blocked cells). Rebuilt with the mask and consumed as a
    /// per-unit collision-clearance gate, so a body of collision radius r is
    /// not routed through gaps narrower than it can fit. Independent of unit
    /// size, so it is cached once per mask rather than per radius.
    clearance: Vec<u16>,
    /// Clearance from map edges only. Traversals valid in both exposed and
    /// water cases use this because neither medium is an obstacle.
    medium_clearance: Vec<u16>,
    /// Clearance from cells containing any exposed terrain and map edges.
    /// Water-only navigation uses this so the collision disk remains inside
    /// cells whose water case is exclusively applicable.
    water_clearance: Vec<u16>,

    // A* scratch (reused per query)
    g_score: Vec<f32>,
    f_score: Vec<f32>,
    parent: Vec<i32>,
    closed: Vec<u8>,
    visited_gen: Vec<u32>,
    current_gen: u32,
    heap: Vec<u32>,
    // Level-1 hierarchy scratch. One abstract node represents a square cluster
    // of fine navigation cells. Abstract edges are never assumed passable:
    // every edge is validated and priced by the exact fine-grid line tracer.
    hierarchy_grid_w: i32,
    hierarchy_grid_h: i32,
    hierarchy_node_cell: Vec<i32>,
    hierarchy_g_score: Vec<f32>,
    hierarchy_f_score: Vec<f32>,
    hierarchy_parent: Vec<i32>,
    hierarchy_closed: Vec<u8>,
    hierarchy_heap: Vec<u32>,
    hierarchy_edge_cost: Vec<f32>,
    hierarchy_edge_from_cell: Vec<i32>,
    hierarchy_edge_to_cell: Vec<i32>,
    hierarchy_path: Vec<u32>,
    // Query-local transition caches. Cell passability is revisited from many
    // incoming edges, especially for diagonal neighbors; 0 = unknown,
    // 1 = blocked, 2 = passable. Touched lists let each query clear only the
    // cells it actually inspected instead of sweeping a huge open map.
    move_passability_cache: Vec<u8>,
    move_passability_touched: Vec<u32>,
    waypoint_passability_cache: Vec<u8>,
    waypoint_passability_touched: Vec<u32>,
    // Exact directed-neighbor costs traced by direct LOS, hierarchy
    // refinement, and string pulling. Fine A* evaluates its mostly-unique
    // outgoing edges directly, avoiding a hash lookup on every expansion.
    line_transition_cost_cache: HashMap<u64, f32>,
    line_transition_cache_enabled: bool,
    line_transition_cache_hits: u32,
    line_transition_cache_misses: u32,
    // BFS scratch
    bfs_queue: Vec<u32>,

    // Per-query traversal params, set at pathfinder_find_path entry (one query
    // runs at a time). `cur_required_clearance` gates cells by the unit's
    // collision footprint in cells. Every ground direction must satisfy the
    // medium-specific local force envelope; `cur_symmetric_slope` additionally
    // makes the inter-cell climb gate apply downhill (SYMMETRIC mode).
    cur_required_clearance: i32,
    cur_symmetric_slope: bool,
    /// Collision radius of the querying body. Declares that the query has a
    /// physical body (enabling fording and immersion scaling) and sizes the
    /// displaced-volume sphere; 0 = radius-less query with legacy
    /// binary-water behavior.
    cur_unit_radius: f64,
    /// Height of the body origin above its support point — the runtime rests
    /// bodies at bed + supportPointOffsetZ, and water damage keys off the
    /// origin, so this is the honest fording depth and immersion center.
    /// 0 falls back to the collision radius (sphere resting tangent).
    cur_support_point_offset_z: f64,
    /// Per-query fast path for the lateral-hold legality gate: at or above
    /// this min-cell-normal even a fully lateral hold provably fits the dry
    /// tangent budget (and the wet budget is never smaller), so the edge
    /// force helper can be skipped with one comparison. 0 = always skip
    /// (zero-envelope queries keep legacy unconstrained legality).
    cur_lateral_skip_normal_z: f64,
    /// Per-query descent envelope cos(atan μ), precomputed so the downhill
    /// gate costs a lookup and comparison instead of per-edge trig.
    /// 0 = unconstrained descent (no authored grip).
    cur_descent_hold_normal_z: f64,
    /// Intentional destination/entry domain for the current query. Physical
    /// passability uses the traversal passed to the kernels; this second
    /// domain only prevents a body that is already in its intended medium
    /// from voluntarily entering a recovery-only medium.
    cur_waypoint_traversal: PathfinderTraversal,
    /// True when MOVE and WAYPOINT classify every cell identically. Ordinary
    /// ground/air/water units take this path and avoid two redundant waypoint
    /// passability evaluations for every directed edge. Recovery-only medium
    /// transitions keep the full directed-domain rule.
    cur_waypoint_matches_move_domain: bool,

    // Cache key — invalidated on terrain/grid-dimension change.
    terrain_only_key: u64, // = (tVer as u64) << 32 | (gridW as u64) << 16 | gridH

    // Sorted snap offsets — populated once per grid-dim change.
    snap_offsets: Vec<(i16, i16)>,

    // Output: smoothed waypoints as (x, y) f64 pairs.
    waypoint_scratch: Vec<f64>,
    path_scratch: Vec<u32>,
    last_result_status: u32,
    last_search_strategy: u32,
    last_fine_expanded_nodes: u32,
    last_coarse_expanded_nodes: u32,
    last_coarse_refinement_passes: u32,
    last_coarse_exact_edge_checks: u32,
    last_coarse_full_cluster_scans: u32,
    last_fine_hit_node_limit: bool,
    last_smoothing_line_checks: u32,
    last_direct_cost_ratio: f32,
}

#[derive(Clone, Copy)]
pub(crate) struct PathfinderTraversal {
    /// Minimum terrain normal supported by the unit's dry-contact force
    /// budget. This is derived from propulsion, mass, gravity, and Coulomb
    /// grip; there is no global angle ceiling.
    min_ground_normal_z: f32,
    /// Equivalent threshold while water covers the terrain. Fluid-supported
    /// bodies ignore the bed. Any water-containing cell applies the same full
    /// water force case; a mixed cell then intersects it with the dry case.
    safe_ground_accel: f64,
    safe_water_drive_accel: f64,
    static_friction_coefficient: f64,
    water_surface_supported: bool,
    water_waypoint_hold: bool,
    allow_ground: bool,
    allow_water: bool,
    allow_air: bool,
    /// Cached wet-contact slope gate (see `derived()`). Every literal
    /// construction site must finish with `.derived()` so this field is
    /// populated; a stale 0.0 weakens the wet slope gate.
    wet_contact_required_normal_z: f32,
}

impl PathfinderTraversal {
    /// Precompute the wet-contact required-normal gate once per traversal.
    /// Its inputs are query constants, but it used to be derived inside
    /// `pathfinder_required_cell_normal_z` — running the ~64-iteration
    /// sin/cos bisection of `pathfinder_max_contact_slope_rad` for every
    /// wet cell-passability test, which put libm trig at the top of the
    /// whole-app CPU profile. The expression sequence below is byte-moved
    /// from that function so the cached value is bit-identical.
    #[inline]
    fn derived(mut self) -> Self {
        self.wet_contact_required_normal_z = self.compute_wet_contact_required_normal_z();
        self
    }

    fn compute_wet_contact_required_normal_z(&self) -> f32 {
        if self.allow_air || !self.allow_water {
            return 0.0;
        }
        if self.water_surface_supported || !self.allow_ground {
            return 0.0;
        }
        if self.min_ground_normal_z <= 0.0
            && self.safe_ground_accel <= 0.0
            && self.safe_water_drive_accel <= 0.0
            && self.static_friction_coefficient <= 0.0
        {
            // Explicitly unfiltered developer/test queries keep slope gates off.
            return 0.0;
        }

        // Wet contact propulsion is weighted by the sphere volume actually below
        // the water plane. Use the highest terrain belonging to the conservative
        // path cell, so every point represented by a green square has at least
        // this much water authority at its ground-resting body height.
        let max_move_slope = pathfinder_max_contact_slope_rad(
            self.safe_ground_accel,
            self.safe_water_drive_accel,
            self.static_friction_coefficient,
            GRAVITY,
        );
        let mut water_required = max_move_slope.cos();
        if self.water_waypoint_hold {
            // A destination must both be actively reachable and remain held after
            // commanded water thrust ends. Passive Coulomb grip supplies the hold.
            let hold_normal = self.static_friction_coefficient.max(0.0).atan().cos();
            water_required = water_required.max(hold_normal);
        }
        pathfinder_required_normal_z(water_required as f32)
    }
}

#[inline]
fn pathfinder_traversal_cell_domain_equivalent(
    left: PathfinderTraversal,
    right: PathfinderTraversal,
) -> bool {
    // These are precisely the traversal fields consumed by cell passability.
    // Compare normalized ground requirements so two unfiltered NaN inputs are
    // still recognized as the same effective domain.
    left.allow_ground == right.allow_ground
        && left.allow_water == right.allow_water
        && left.allow_air == right.allow_air
        && pathfinder_required_normal_z(left.min_ground_normal_z)
            == pathfinder_required_normal_z(right.min_ground_normal_z)
        && left.wet_contact_required_normal_z == right.wet_contact_required_normal_z
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
            static_friction_coefficient: if static_friction_coefficient.is_finite()
                && static_friction_coefficient > 0.0
            {
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
            building_blocked: Vec::new(),
            building_occupancy_version: 0,
            terrain_height: Vec::new(),
            terrain_normal_z: Vec::new(),
            terrain_transition_normal_z: Vec::new(),
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
            hierarchy_grid_w: 0,
            hierarchy_grid_h: 0,
            hierarchy_node_cell: Vec::new(),
            hierarchy_g_score: Vec::new(),
            hierarchy_f_score: Vec::new(),
            hierarchy_parent: Vec::new(),
            hierarchy_closed: Vec::new(),
            hierarchy_heap: Vec::new(),
            hierarchy_edge_cost: Vec::new(),
            hierarchy_edge_from_cell: Vec::new(),
            hierarchy_edge_to_cell: Vec::new(),
            hierarchy_path: Vec::new(),
            move_passability_cache: Vec::new(),
            move_passability_touched: Vec::new(),
            waypoint_passability_cache: Vec::new(),
            waypoint_passability_touched: Vec::new(),
            line_transition_cost_cache: HashMap::default(),
            line_transition_cache_enabled: false,
            line_transition_cache_hits: 0,
            line_transition_cache_misses: 0,
            bfs_queue: Vec::new(),
            cur_required_clearance: 0,
            cur_symmetric_slope: false,
            cur_unit_radius: 0.0,
            cur_support_point_offset_z: 0.0,
            cur_lateral_skip_normal_z: 0.0,
            cur_descent_hold_normal_z: 0.0,
            cur_waypoint_traversal: PathfinderTraversal {
                min_ground_normal_z: 0.0,
                safe_ground_accel: 0.0,
                safe_water_drive_accel: 0.0,
                static_friction_coefficient: 0.0,
                water_surface_supported: false,
                water_waypoint_hold: false,
                allow_ground: true,
                allow_water: false,
                allow_air: false,
                wet_contact_required_normal_z: 0.0,
            }
            .derived(),
            cur_waypoint_matches_move_domain: false,
            terrain_only_key: u64::MAX,
            snap_offsets: Vec::new(),
            waypoint_scratch: Vec::new(),
            path_scratch: Vec::new(),
            last_result_status: PATHFINDER_RESULT_UNREACHABLE,
            last_search_strategy: PATHFINDER_SEARCH_NONE,
            last_fine_expanded_nodes: 0,
            last_coarse_expanded_nodes: 0,
            last_coarse_refinement_passes: 0,
            last_coarse_exact_edge_checks: 0,
            last_coarse_full_cluster_scans: 0,
            last_fine_hit_node_limit: false,
            last_smoothing_line_checks: 0,
            last_direct_cost_ratio: f32::NAN,
        }
    }
}

pub(crate) static PATHFINDER: WasmLazy<PathfinderState> = WasmLazy::new();

#[inline]
pub(crate) fn pathfinder_state() -> &'static mut PathfinderState {
    PATHFINDER.get_or_init(PathfinderState::empty)
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
    state.building_blocked.clear();
    state.building_blocked.resize(n, 0);
    state.building_occupancy_version = 0;
    state.terrain_height.clear();
    state
        .terrain_height
        .resize(n, TERRAIN_WATER_LEVEL as f32 + 1.0);
    state.terrain_normal_z.clear();
    state.terrain_normal_z.resize(n, 1.0);
    state.terrain_transition_normal_z.clear();
    state.terrain_transition_normal_z.resize(n * 4, 1.0);
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
    state.hierarchy_grid_w = 0;
    state.hierarchy_grid_h = 0;
    state.hierarchy_node_cell.clear();
    state.hierarchy_g_score.clear();
    state.hierarchy_f_score.clear();
    state.hierarchy_parent.clear();
    state.hierarchy_closed.clear();
    state.hierarchy_heap.clear();
    state.hierarchy_edge_cost.clear();
    state.hierarchy_edge_from_cell.clear();
    state.hierarchy_edge_to_cell.clear();
    state.hierarchy_path.clear();
    state.move_passability_cache.clear();
    state.move_passability_cache.resize(n, 0);
    state.move_passability_touched.clear();
    state.waypoint_passability_cache.clear();
    state.waypoint_passability_cache.resize(n, 0);
    state.waypoint_passability_touched.clear();
    state.line_transition_cost_cache.clear();
    state.line_transition_cache_enabled = false;
    state.line_transition_cache_hits = 0;
    state.line_transition_cache_misses = 0;
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
pub(crate) fn pathfinder_sample_cell_terrain(gx: i32, gy: i32) -> (bool, bool, f32, f32, [f32; 8]) {
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
    let sample_points = [
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
    let mut has_air = center_h >= TERRAIN_WATER_LEVEL;
    let mut min_normal_z = center_nz;
    let mut boundary_heights = [0.0f32; 8];
    for (sample_idx, (x, y)) in sample_points.into_iter().enumerate() {
        let (h, nz) = pathfinder_sample_terrain(x, y);
        boundary_heights[sample_idx] = h as f32;
        if h < TERRAIN_WATER_LEVEL {
            has_water = true;
        } else {
            has_air = true;
        }
        if nz < min_normal_z {
            min_normal_z = nz;
        }
    }
    terrain_accumulate_touching_triangle_safety(
        left,
        top,
        right,
        bottom,
        &mut has_water,
        &mut has_air,
        &mut min_normal_z,
    );
    // Both medium flags use the inset cell interior. A triangle that merely
    // shares a boundary contributes to the transition edge, not to either
    // cell's medium cases.
    let fully_submerged = has_water && !has_air;
    (
        has_water,
        fully_submerged,
        min_normal_z,
        center_h as f32,
        boundary_heights,
    )
}

#[inline]
fn pathfinder_transition_normal_z(from_height: f32, to_height: f32, horizontal: f64) -> f32 {
    if !from_height.is_finite() || !to_height.is_finite() || horizontal <= 1.0e-9 {
        return 0.0;
    }
    let dz = (to_height as f64 - from_height as f64).abs();
    (horizontal / (horizontal * horizontal + dz * dz).sqrt()) as f32
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
    let mut boundary_heights: Vec<[f32; 8]> = vec![[0.0; 8]; n];
    for gy in 0..grid_h {
        for gx in 0..grid_w {
            let idx = (gy * grid_w + gx) as usize;
            let (has_water, fully_submerged, nz, height, cell_boundary_heights) =
                pathfinder_sample_cell_terrain(gx, gy);
            state.terrain_height[idx] = height;
            state.terrain_normal_z[idx] = nz;
            boundary_heights[idx] = cell_boundary_heights;
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
    state.terrain_transition_normal_z.fill(1.0);
    const TRANSITION_PROBE_DISTANCE: f64 = 0.002;
    const DIAGONAL_TRANSITION_PROBE_DISTANCE: f64 =
        TRANSITION_PROBE_DISTANCE * std::f64::consts::SQRT_2;
    for gy in 0..grid_h {
        for gx in 0..grid_w {
            let idx = (gy * grid_w + gx) as usize;
            let from = boundary_heights[idx];
            if gx + 1 < grid_w {
                let east = boundary_heights[(gy * grid_w + gx + 1) as usize];
                state.terrain_transition_normal_z[idx * 4] =
                    pathfinder_transition_normal_z(from[4], east[3], TRANSITION_PROBE_DISTANCE);
            }
            if gx + 1 < grid_w && gy + 1 < grid_h {
                let south_east = boundary_heights[((gy + 1) * grid_w + gx + 1) as usize];
                state.terrain_transition_normal_z[idx * 4 + 1] = pathfinder_transition_normal_z(
                    from[7],
                    south_east[0],
                    DIAGONAL_TRANSITION_PROBE_DISTANCE,
                );
            }
            if gy + 1 < grid_h {
                let south = boundary_heights[((gy + 1) * grid_w + gx) as usize];
                state.terrain_transition_normal_z[idx * 4 + 2] =
                    pathfinder_transition_normal_z(from[6], south[1], TRANSITION_PROBE_DISTANCE);
            }
            if gx > 0 && gy + 1 < grid_h {
                let south_west = boundary_heights[((gy + 1) * grid_w + gx - 1) as usize];
                state.terrain_transition_normal_z[idx * 4 + 3] = pathfinder_transition_normal_z(
                    from[5],
                    south_west[2],
                    DIAGONAL_TRANSITION_PROBE_DISTANCE,
                );
            }
        }
    }

    // Step 2 — retain the exact per-cell water domain. There is no synthetic
    // shoreline dilation: a dry-only traversal is blocked by a cell iff that
    // cell itself contains water.
    state.terrain_blocked.copy_from_slice(&water_mask);
    for gy in 0..grid_h {
        for gx in 0..grid_w {
            let idx = (gy * grid_w + gx) as usize;
            let edge_blocked = gx < PATHFINDER_MAP_EDGE_BUFFER_CELLS
                || gy < PATHFINDER_MAP_EDGE_BUFFER_CELLS
                || gx >= grid_w - PATHFINDER_MAP_EDGE_BUFFER_CELLS
                || gy >= grid_h - PATHFINDER_MAP_EDGE_BUFFER_CELLS;
            state.terrain_edge_blocked[idx] = if edge_blocked { 1 } else { 0 };
        }
    }

    // A terrain rebuild invalidates the building occupancy layer: TS resyncs
    // it immediately afterward (version 0 never matches a live BuildingGrid
    // version, which starts at 1).
    state.building_blocked.fill(0);
    state.building_occupancy_version = 0;

    pathfinder_rebuild_blocked_clearance_and_components(state);

    state.terrain_only_key = key;
}

/// Rebuild the aggregate blocked mask, the three clearance distance fields,
/// and the connected-component labels from the current terrain masks plus
/// the building occupancy layer. Shared by the terrain rebuild and by
/// building-occupancy sync — building churn re-runs ONLY these O(n) sweeps,
/// never the far more expensive per-cell terrain sampling above.
fn pathfinder_rebuild_blocked_clearance_and_components(state: &mut PathfinderState) {
    let grid_w = state.grid_w;
    let grid_h = state.grid_h;
    let n = state.n;

    // Terrain is the base locomotion surface; building occupancy is a
    // dynamic obstacle layer on top of it. Hovering structures never enter
    // the layer, so units path freely under them.
    state.blocked.copy_from_slice(&state.terrain_blocked);
    for idx in 0..n {
        if state.terrain_edge_blocked[idx] != 0 || state.building_blocked[idx] != 0 {
            state.blocked[idx] = 1;
        }
    }

    // Clearance distance fields: Chebyshev cell-distance from each invalid
    // medium cell. Ground/air-only traversal treats every water-containing
    // cell as an obstacle; water-only traversal treats every cell containing
    // exposed terrain as an obstacle. Dual-medium traversal has no terrain
    // medium obstacle. Buildings obstruct every non-air medium. All three
    // fields are then clamped by exact map-edge distance so physical body
    // radius still remains in bounds.
    for idx in 0..n {
        let building = state.building_blocked[idx] != 0;
        state.clearance[idx] = if state.blocked[idx] == 1 { 0 } else { u16::MAX };
        state.medium_clearance[idx] = if state.terrain_edge_blocked[idx] != 0 || building {
            0
        } else {
            u16::MAX
        };
        state.water_clearance[idx] = if state.terrain_submerged[idx] == 0
            || state.terrain_edge_blocked[idx] != 0
            || building
        {
            0
        } else {
            u16::MAX
        };
    }
    pathfinder_rebuild_clearance_distance(&mut state.clearance, grid_w, grid_h);
    pathfinder_rebuild_clearance_distance(&mut state.medium_clearance, grid_w, grid_h);
    pathfinder_rebuild_clearance_distance(&mut state.water_clearance, grid_w, grid_h);
    for gy in 0..grid_h {
        for gx in 0..grid_w {
            let idx = (gy * grid_w + gx) as usize;
            let edge_clearance = (gx + 1)
                .min(gy + 1)
                .min(grid_w - gx)
                .min(grid_h - gy)
                .max(0) as u16;
            state.clearance[idx] = state.clearance[idx].min(edge_clearance);
            state.medium_clearance[idx] = state.medium_clearance[idx].min(edge_clearance);
            state.water_clearance[idx] = state.water_clearance[idx].min(edge_clearance);
        }
    }

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
}

/// Replace the building occupancy layer with the given footprint cells and
/// re-run the O(n) blocked/clearance/component sweeps. Cells are grounded
/// building footprint cells in the shared 20-wu build/path grid (hovering
/// structures are never submitted). Full replacement per sync keeps the
/// layer stateless against terrain rebuilds and desync-proof: the caller
/// owns the authoritative cell set and the version.
#[wasm_bindgen]
pub fn pathfinder_sync_building_occupancy(cell_gx: &[i32], cell_gy: &[i32], version: u32) -> u32 {
    let state = pathfinder_state();
    if state.n == 0 {
        return 0;
    }
    debug_assert!(cell_gy.len() >= cell_gx.len());
    state.building_blocked.fill(0);
    let count = cell_gx.len().min(cell_gy.len());
    for i in 0..count {
        let gx = cell_gx[i];
        let gy = cell_gy[i];
        if gx < 0 || gy < 0 || gx >= state.grid_w || gy >= state.grid_h {
            continue;
        }
        state.building_blocked[(gy * state.grid_w + gx) as usize] = 1;
    }
    state.building_occupancy_version = version;
    pathfinder_rebuild_blocked_clearance_and_components(state);
    1
}

/// Version of the currently installed building occupancy layer. 0 after any
/// terrain rebuild or init — never a live BuildingGrid version — so the TS
/// cache resyncs exactly when its grid version differs.
#[wasm_bindgen]
pub fn pathfinder_building_occupancy_version() -> u32 {
    pathfinder_state().building_occupancy_version
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

/// Bake the complete per-build-square WAYPOINT and MOVE domains for one unit
/// capability profile. This calls the same cell kernel used by A*, so the
/// presentation grid is authoritative data rather than a second
/// implementation of slope, medium, and clearance math.
#[wasm_bindgen]
pub fn pathfinder_bake_traversability_grid(
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
    waypoint_out: &mut [u8],
    move_out: &mut [u8],
) -> u32 {
    let state = pathfinder_state();
    if state.n == 0 || waypoint_out.len() < state.n || move_out.len() < state.n {
        return 0;
    }
    let move_traversal = PathfinderTraversal {
        min_ground_normal_z,
        safe_ground_accel: safe_drive_accel,
        safe_water_drive_accel,
        static_friction_coefficient,
        water_surface_supported,
        water_waypoint_hold: false,
        allow_ground: move_allow_ground,
        allow_water: move_allow_water,
        allow_air: move_allow_air,
        wet_contact_required_normal_z: 0.0,
    }
    .derived();
    let waypoint_traversal = PathfinderTraversal {
        min_ground_normal_z,
        safe_ground_accel: safe_drive_accel,
        safe_water_drive_accel,
        static_friction_coefficient,
        water_surface_supported,
        water_waypoint_hold: true,
        allow_ground: waypoint_allow_ground,
        allow_water: waypoint_allow_water,
        allow_air: waypoint_allow_air,
        wet_contact_required_normal_z: 0.0,
    }
    .derived();
    let previous_clearance = state.cur_required_clearance;
    let previous_unit_radius = state.cur_unit_radius;
    let previous_support_offset = state.cur_support_point_offset_z;
    state.cur_required_clearance = if move_allow_air && waypoint_allow_air {
        0
    } else {
        pathfinder_hard_clearance_cells_for_radius(unit_radius)
    };
    state.cur_unit_radius = pathfinder_query_unit_radius(unit_radius);
    state.cur_support_point_offset_z = pathfinder_query_unit_radius(support_point_offset_z);
    for idx in 0..state.n {
        waypoint_out[idx] = if pathfinder_is_cell_passable(state, idx, waypoint_traversal) {
            1
        } else {
            0
        };
        move_out[idx] = if pathfinder_is_cell_passable(state, idx, move_traversal) {
            1
        } else {
            0
        };
    }
    state.cur_required_clearance = previous_clearance;
    state.cur_unit_radius = previous_unit_radius;
    state.cur_support_point_offset_z = previous_support_offset;
    1
}

/// Sanitized per-query body length (radius or support offset). Non-finite /
/// non-positive values mean "not declared" and select legacy behavior.
#[inline]
fn pathfinder_query_unit_radius(unit_radius: f64) -> f64 {
    if unit_radius.is_finite() && unit_radius > 0.0 {
        unit_radius
    } else {
        0.0
    }
}

/// Height of the querying body's origin above the bed at rest: the authored
/// support offset when declared (the runtime rests bodies at
/// bed + supportPointOffsetZ), else the collision radius — a sphere resting
/// tangent on the bed.
#[inline]
fn pathfinder_query_body_center_height(state: &PathfinderState) -> f64 {
    if state.cur_support_point_offset_z > 0.0 {
        state.cur_support_point_offset_z
    } else {
        state.cur_unit_radius
    }
}

/// Precompute the per-query slope-gate thresholds consumed by
/// `pathfinder_can_step_height_delta`'s hot path.
///
/// Lateral skip: the smallest min-cell normal at which a fully lateral hold
/// provably fits the dry tangent budget — from `a ≥ g·sqrt(1−nz²)` and
/// `μ·g·nz ≥ g·sqrt(1−nz²)`, i.e. nz ≥ max(sqrt(1−(a/g)²), 1/sqrt(1+μ²)).
/// Wet edges only ever ADD budget, so the same threshold is safe for them.
///
/// Descent hold: cos(atan μ), the downhill braking envelope.
///
/// Zero-envelope queries (no accel, grip, or water drive authored) keep the
/// legacy unconstrained legality: both thresholds go to 0 (always skip).
pub(crate) fn pathfinder_apply_query_slope_gates(
    state: &mut PathfinderState,
    safe_ground_accel: f64,
    static_friction_coefficient: f64,
    safe_water_drive_accel: f64,
) {
    let a = if safe_ground_accel.is_finite() {
        safe_ground_accel.max(0.0)
    } else {
        0.0
    };
    let mu = if static_friction_coefficient.is_finite() {
        static_friction_coefficient.max(0.0)
    } else {
        0.0
    };
    let water = if safe_water_drive_accel.is_finite() {
        safe_water_drive_accel.max(0.0)
    } else {
        0.0
    };
    if a <= 0.0 && mu <= 0.0 && water <= 0.0 {
        state.cur_lateral_skip_normal_z = 0.0;
        state.cur_descent_hold_normal_z = 0.0;
        return;
    }
    let accel_branch = if a >= GRAVITY {
        0.0
    } else {
        (1.0 - (a / GRAVITY) * (a / GRAVITY)).max(0.0).sqrt()
    };
    let friction_branch = 1.0 / (1.0 + mu * mu).sqrt();
    state.cur_lateral_skip_normal_z = accel_branch.max(friction_branch);
    state.cur_descent_hold_normal_z = if mu > 0.0 { friction_branch } else { 0.0 };
}

#[inline]
pub(crate) fn pathfinder_allows_exposed_case(traversal: PathfinderTraversal) -> bool {
    traversal.allow_ground || traversal.allow_air
}

/// Mirror of the exposed case for water-containing squares: a body that can
/// occupy the water medium passes, and so does an airborne body — it overflies
/// the water surface exactly as it overflies exposed terrain. Waypoints there
/// still resolve to the terrain bed; the water plane never becomes a command
/// surface.
#[inline]
pub(crate) fn pathfinder_allows_water_case(traversal: PathfinderTraversal) -> bool {
    traversal.allow_water || traversal.allow_air
}

/// Validate a raw world point against the same binary medium permissions as
/// its containing cell. A point below the water plane exercises the water
/// case; a point on or above it exercises the exposed ground/air case.
#[inline]
pub(crate) fn pathfinder_position_is_in_navigation_domain(
    state: &PathfinderState,
    x: f64,
    y: f64,
    traversal: PathfinderTraversal,
) -> bool {
    if !x.is_finite()
        || !y.is_finite()
        || x < 0.0
        || y < 0.0
        || x >= state.map_width
        || y >= state.map_height
    {
        return false;
    }
    let height = pathfinder_sample_terrain(x, y).0;
    if height < TERRAIN_WATER_LEVEL {
        // Exact points share the cell fording rule: ankle-deep water whose
        // depth stays under the body's resting center height is valid ground.
        pathfinder_allows_water_case(traversal)
            || (traversal.allow_ground
                && !traversal.allow_air
                && state.cur_unit_radius > 0.0
                && (TERRAIN_WATER_LEVEL - height) <= pathfinder_query_body_center_height(state))
    } else {
        pathfinder_allows_exposed_case(traversal)
    }
}

#[inline]
pub(crate) fn pathfinder_is_cell_passable(
    state: &PathfinderState,
    idx: usize,
    traversal: PathfinderTraversal,
) -> bool {
    pathfinder_is_cell_passable_impl(state, idx, traversal, true)
}

/// Building-blind passability, used only to classify a blocked START as an
/// escape start: a unit standing where a building just went up may route out
/// of the footprint (`can_step_between` rejects every step INTO a building
/// cell, so escape is inherently one-way).
#[inline]
pub(crate) fn pathfinder_is_cell_passable_ignoring_buildings(
    state: &PathfinderState,
    idx: usize,
    traversal: PathfinderTraversal,
) -> bool {
    pathfinder_is_cell_passable_impl(state, idx, traversal, false)
}

#[inline]
fn pathfinder_is_cell_passable_impl(
    state: &PathfinderState,
    idx: usize,
    traversal: PathfinderTraversal,
    honor_buildings: bool,
) -> bool {
    if !traversal.allow_air && state.terrain_edge_blocked[idx] != 0 {
        return false;
    }
    // Grounded building footprints obstruct every non-air medium; air
    // traversal overflies them exactly as it overflies terrain.
    if honor_buildings && !traversal.allow_air && state.building_blocked[idx] != 0 {
        return false;
    }
    let has_water = state.terrain_water[idx] == 1;
    let has_exposed = state.terrain_submerged[idx] == 0;
    let allows_exposed = pathfinder_allows_exposed_case(traversal);
    // Fording: a ground mover whose body origin stays above the water plane
    // (cell depth <= resting center height) takes no water damage and keeps
    // its full bed traction, so shallow shoreline water is part of its
    // physical ground domain — as a route AND as a place to stand — not a
    // foreign medium. Radius-less queries keep the legacy binary water gate.
    let fords_shallow_water = has_water
        && traversal.allow_ground
        && !traversal.allow_air
        && !pathfinder_allows_water_case(traversal)
        && state.cur_unit_radius > 0.0
        && (TERRAIN_WATER_LEVEL - state.terrain_height[idx] as f64)
            <= pathfinder_query_body_center_height(state);
    // Every medium present in the square must be valid. A mixed shoreline
    // square therefore intersects its exposed and water permissions instead
    // of receiving a special shoreline class or buffer.
    let passable_by_medium = (!has_exposed || allows_exposed)
        && (!has_water || pathfinder_allows_water_case(traversal) || fords_shallow_water);
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
    let clearance = if traversal.allow_water && !allows_exposed {
        state.water_clearance[idx]
    } else if traversal.allow_water && allows_exposed {
        state.medium_clearance[idx]
    } else if traversal.allow_ground && !traversal.allow_air && state.cur_unit_radius > 0.0 {
        // A fording body's disk may overhang water — only dual-medium
        // obstacles bound it. Its CENTER cell is still depth-gated above,
        // and the soft-clearance cost still reads the dry field, so routes
        // prefer dry land and pay for hugging the waterline.
        state.medium_clearance[idx]
    } else {
        state.clearance[idx]
    };
    let required_clearance = if traversal.allow_air {
        0
    } else {
        state.cur_required_clearance
    };
    if (clearance as i32) < required_clearance {
        return false;
    }
    true
}

fn pathfinder_begin_query_transition_cache(state: &mut PathfinderState) {
    while let Some(idx) = state.move_passability_touched.pop() {
        state.move_passability_cache[idx as usize] = 0;
    }
    while let Some(idx) = state.waypoint_passability_touched.pop() {
        state.waypoint_passability_cache[idx as usize] = 0;
    }
    state.line_transition_cost_cache.clear();
    state.line_transition_cache_enabled = false;
    state.line_transition_cache_hits = 0;
    state.line_transition_cache_misses = 0;
}

#[inline]
fn pathfinder_cached_cell_passable(
    state: &mut PathfinderState,
    idx: usize,
    traversal: PathfinderTraversal,
    waypoint_domain: bool,
) -> bool {
    let cached = if waypoint_domain {
        state.waypoint_passability_cache[idx]
    } else {
        state.move_passability_cache[idx]
    };
    if cached != 0 {
        return cached == 2;
    }
    let passable = pathfinder_is_cell_passable(state, idx, traversal);
    if waypoint_domain {
        state.waypoint_passability_cache[idx] = if passable { 2 } else { 1 };
        state.waypoint_passability_touched.push(idx as u32);
    } else {
        state.move_passability_cache[idx] = if passable { 2 } else { 1 };
        state.move_passability_touched.push(idx as u32);
    }
    passable
}

/// Planner-side estimate of the runtime's displaced-volume thrust weighting
/// (`unit_force_water_fraction`): a sphere of the query's collision radius
/// with its center at the body's resting height above the cell's bed —
/// exactly where the physics rests the body (bed + supportPointOffsetZ).
/// Keeps the water thrust credit the edge budget hands out consistent with
/// what the force kernel will actually deliver in a barely-wet cell.
/// Radius-less queries keep the legacy full credit.
#[inline]
fn pathfinder_cell_water_case_scale(state: &PathfinderState, idx: usize) -> f64 {
    if state.terrain_water[idx] == 0 {
        return 0.0;
    }
    let radius = state.cur_unit_radius;
    if !(radius > 0.0) || !radius.is_finite() {
        return 1.0;
    }
    let bed = state.terrain_height[idx] as f64;
    unit_force_water_fraction(bed + pathfinder_query_body_center_height(state), radius)
}

#[inline]
fn pathfinder_required_cell_normal_z(
    state: &PathfinderState,
    idx: usize,
    traversal: PathfinderTraversal,
) -> f32 {
    if traversal.allow_air {
        return 0.0;
    }
    let has_water = state.terrain_water[idx] == 1;
    let has_exposed = state.terrain_submerged[idx] == 0;
    let required = if has_exposed {
        pathfinder_required_normal_z(traversal.min_ground_normal_z)
    } else {
        0.0
    };
    if !has_water || !traversal.allow_water {
        return required;
    }
    // The wet-contact gate is a query constant, precomputed by
    // `PathfinderTraversal::derived()`. It is 0.0 exactly in the cases the
    // per-cell code used to early-return on (surface-supported, no ground
    // contact, unfiltered dev queries), and `required >= 0`, so the max is
    // behavior-identical to the removed inline derivation.
    required.max(traversal.wet_contact_required_normal_z)
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
    if !physics_mass.is_finite() || physics_mass <= 0.0 || !gravity.is_finite() || gravity <= 0.0 {
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
    // The traversal reserve applies to every commanded contact force, not
    // only to the motor rating. At atan(mu) static friction is fully consumed
    // merely holding the body against gravity, leaving no authority to
    // accelerate uphill. Reserving the same ratio from the Coulomb budget
    // makes the advertised maximum a slope the runtime can actually traverse.
    let safe_mu = mu * ratio;
    let weight_force = physics_mass * gravity / 1_000_000.0;
    let drive_accel = ground_force * 1_000_000.0 / physics_mass;
    let traction_accel = gravity * mu;
    let flat_drive_accel = drive_accel.min(traction_accel).max(0.0);
    let safe_ground_force = ground_force * ratio;
    let safe_water_force = water_force * ratio;
    let safe_drive_accel = safe_ground_force * 1_000_000.0 / physics_mass;
    let safe_water_drive_accel = safe_water_force * 1_000_000.0 / physics_mass;
    let radians_to_degrees = 180.0 / core::f64::consts::PI;
    let (
        max_ground_slope_deg,
        min_ground_normal_z,
        drive_limited_slope_deg,
        traction_limited_slope_deg,
    ) = if allow_ground {
        let drive_limit = (safe_drive_accel / gravity).clamp(0.0, 1.0).asin();
        let traction_limit = safe_mu.atan();
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
            safe_mu,
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
    let flat_water_contact_accel = flat_water_contact_force * 1_000_000.0 / physics_mass;
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
fn pathfinder_precomputed_transition_normal_z(
    state: &PathfinderState,
    from_gx: i32,
    from_gy: i32,
    to_gx: i32,
    to_gy: i32,
) -> f64 {
    let dx = to_gx - from_gx;
    let dy = to_gy - from_gy;
    let (owner_gx, owner_gy, slot) = match (dx, dy) {
        (1, 0) => (from_gx, from_gy, 0usize),
        (-1, 0) => (to_gx, to_gy, 0usize),
        (1, 1) => (from_gx, from_gy, 1usize),
        (-1, -1) => (to_gx, to_gy, 1usize),
        (0, 1) => (from_gx, from_gy, 2usize),
        (0, -1) => (to_gx, to_gy, 2usize),
        (-1, 1) => (from_gx, from_gy, 3usize),
        (1, -1) => (to_gx, to_gy, 3usize),
        _ => return 0.0,
    };
    let owner_idx = (owner_gy * state.grid_w + owner_gx) as usize;
    state
        .terrain_transition_normal_z
        .get(owner_idx * 4 + slot)
        .copied()
        .unwrap_or(0.0) as f64
}

#[inline]
fn pathfinder_step_height_forces(
    state: &PathfinderState,
    from_idx: usize,
    to_idx: usize,
    traversal: PathfinderTraversal,
    eagerly_compute_forces: bool,
) -> Option<Option<PathfinderBedEdgeForces>> {
    if traversal.allow_air {
        return Some(None);
    }
    let from_h = state.terrain_height[from_idx] as f64;
    let to_h = state.terrain_height[to_idx] as f64;
    if !from_h.is_finite() || !to_h.is_finite() {
        return None;
    }
    // Each medium owns its own mass/force-derived contact envelope. A
    // fluid-supported water cell reports zero and therefore ignores lakebed
    // angle; a bed-supported cell must satisfy the same force balance as the
    // runtime contact actuator.
    let from_required_normal_z = pathfinder_required_cell_normal_z(state, from_idx, traversal);
    let to_required_normal_z = pathfinder_required_cell_normal_z(state, to_idx, traversal);
    if state.terrain_normal_z[from_idx] < from_required_normal_z
        || state.terrain_normal_z[to_idx] < to_required_normal_z
    {
        return None;
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
        return Some(None);
    }
    let center_dz = to_h - from_h;

    // Edge legality includes the cross-slope force contract: an edge whose
    // lateral hold demand meets or exceeds the safe tangent budget is not
    // merely expensive — the unit cannot track it, so it is not a legal step
    // in either direction. This is the same math the edge cost prices, so
    // A* can never be forced through an unholdable contour leg as a
    // least-bad route. The precomputed per-query threshold keeps this a
    // single comparison on ordinary terrain — the force helper only runs for
    // edges steep enough that a fully lateral hold might not fit the budget.
    let min_cell_normal_z =
        (state.terrain_normal_z[from_idx] as f64).min(state.terrain_normal_z[to_idx] as f64);
    let forces = if eagerly_compute_forces || min_cell_normal_z < state.cur_lateral_skip_normal_z {
        pathfinder_bed_edge_forces(
            state,
            from_idx,
            to_idx,
            horizontal,
            traversal.allow_air,
            traversal.allow_ground,
            traversal.water_surface_supported,
            traversal.safe_ground_accel,
            traversal.static_friction_coefficient,
            traversal.safe_water_drive_accel,
        )
    } else {
        None
    };
    if min_cell_normal_z < state.cur_lateral_skip_normal_z {
        if let Some(forces) = forces {
            // A query that authors no tangent envelope at all (zero accel and
            // friction — capability probes, unconstrained test traversals)
            // keeps the legacy unconstrained legality, mirroring
            // min_ground_normal_z=0.
            if forces.total_tangent_budget > 0.0
                && forces.lateral_hold_accel >= forces.total_tangent_budget
            {
                return None;
            }
        }
    }

    // DIRECTIONAL mode preserves one-way controlled descent: no climb
    // authority is needed going down, but the unit must be able to BRAKE on
    // the faces it rides — descending a surface its contact grip cannot hold
    // is a fall, not a route. The hold envelope cos(atan μ) is deliberately
    // looser than the climb envelope (a weak-engined, grippy unit may
    // descend slopes it cannot climb) but a cliff fails it for everyone.
    // The transition normal is the only record of a face lying exactly on
    // the cell boundary (both neighboring interiors can be flat), so a
    // plateau lip or waterline cliff is gated here even downhill. Queries
    // that author no grip keep the legacy unconstrained descent.
    if center_dz <= 0.0 && !state.cur_symmetric_slope {
        let hold_normal_z = state.cur_descent_hold_normal_z;
        if hold_normal_z <= 0.0 {
            return Some(forces);
        }
        let transition_normal_z =
            pathfinder_precomputed_transition_normal_z(state, from_gx, from_gy, to_gx, to_gy);
        if transition_normal_z < hold_normal_z {
            return None;
        }
        if center_dz == 0.0 {
            return Some(forces);
        }
        let center_normal_z = horizontal / (horizontal * horizontal + center_dz * center_dz).sqrt();
        return if center_normal_z >= hold_normal_z {
            Some(forces)
        } else {
            None
        };
    }
    let required_normal_z = from_required_normal_z.max(to_required_normal_z);
    let center_abs_dz = if state.cur_symmetric_slope {
        center_dz.abs()
    } else {
        center_dz.max(0.0)
    };
    let center_normal_z =
        horizontal / (horizontal * horizontal + center_abs_dz * center_abs_dz).sqrt();
    // Cell interiors deliberately exclude triangles that only lie on their
    // boundary, so a perfectly flat square beside a cliff remains visibly
    // valid. This independently precomputed transition retains that cliff as
    // a blocked edge instead of smearing it over either neighboring square.
    let transition_normal_z =
        pathfinder_precomputed_transition_normal_z(state, from_gx, from_gy, to_gx, to_gy);
    if center_normal_z.min(transition_normal_z) >= required_normal_z as f64 {
        Some(forces)
    } else {
        None
    }
}

#[inline]
#[cfg(test)]
pub(crate) fn pathfinder_can_step_height_delta(
    state: &PathfinderState,
    from_idx: usize,
    to_idx: usize,
    traversal: PathfinderTraversal,
) -> bool {
    pathfinder_step_height_forces(state, from_idx, to_idx, traversal, false).is_some()
}

#[cfg(test)]
pub(crate) fn pathfinder_can_step_between(
    state: &PathfinderState,
    from_idx: usize,
    to_idx: usize,
    traversal: PathfinderTraversal,
) -> bool {
    // Directed recovery rule: an externally displaced body may move through
    // physically traversable recovery-only cells and enter its waypoint
    // domain, but once inside that intended domain it may not route back out.
    if !state.cur_waypoint_matches_move_domain
        && pathfinder_is_cell_passable(state, from_idx, state.cur_waypoint_traversal)
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
fn pathfinder_step_between_cached_forces(
    state: &mut PathfinderState,
    from_idx: usize,
    to_idx: usize,
    traversal: PathfinderTraversal,
    eagerly_compute_forces: bool,
) -> Option<Option<PathfinderBedEdgeForces>> {
    if !state.cur_waypoint_matches_move_domain {
        let waypoint_traversal = state.cur_waypoint_traversal;
        let from_is_waypoint =
            pathfinder_cached_cell_passable(state, from_idx, waypoint_traversal, true);
        if from_is_waypoint
            && !pathfinder_cached_cell_passable(state, to_idx, waypoint_traversal, true)
        {
            return None;
        }
    }
    if !pathfinder_cached_cell_passable(state, to_idx, traversal, false) {
        return None;
    }
    pathfinder_step_height_forces(state, from_idx, to_idx, traversal, eagerly_compute_forces)
}

#[inline]
fn pathfinder_can_step_between_cached(
    state: &mut PathfinderState,
    from_idx: usize,
    to_idx: usize,
    traversal: PathfinderTraversal,
) -> bool {
    pathfinder_step_between_cached_forces(state, from_idx, to_idx, traversal, false).is_some()
}

#[inline]
fn pathfinder_can_step_neighbor_cached(
    state: &mut PathfinderState,
    from_gx: i32,
    from_gy: i32,
    to_gx: i32,
    to_gy: i32,
    traversal: PathfinderTraversal,
) -> bool {
    let from_idx = (from_gy * state.grid_w + from_gx) as usize;
    let to_idx = (to_gy * state.grid_w + to_gx) as usize;
    if !pathfinder_can_step_between_cached(state, from_idx, to_idx, traversal) {
        return false;
    }
    let dx = to_gx - from_gx;
    let dy = to_gy - from_gy;
    if dx == 0 || dy == 0 {
        return true;
    }
    let side_x_idx = (from_gy * state.grid_w + to_gx) as usize;
    let side_y_idx = (to_gy * state.grid_w + from_gx) as usize;
    pathfinder_can_step_between_cached(state, from_idx, side_x_idx, traversal)
        && pathfinder_can_step_between_cached(state, from_idx, side_y_idx, traversal)
}

#[inline]
#[cfg(test)]
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
    let allows_exposed = pathfinder_allows_exposed_case(traversal);
    if traversal.allow_water && !allows_exposed {
        state.water_clearance[idx] as i32
    } else if traversal.allow_water && allows_exposed {
        state.medium_clearance[idx] as i32
    } else {
        state.clearance[idx] as i32
    }
}

#[derive(Clone, Copy)]
pub(crate) struct PathfinderBedEdgeForces {
    pub surface_distance: f64,
    pub uphill_sine: f64,
    pub lateral_hold_accel: f64,
    pub total_tangent_budget: f64,
    pub safe_water_accel: f64,
    pub wet_edge: bool,
}

/// Force geometry of one bed-supported edge: the cross-slope hold demand and
/// the combined safe tangent budget (Coulomb-limited ground drive plus
/// occupancy-scaled water thrust). This is the single source of truth for
/// both edge cost and edge legality, so the planner cannot price a hold the
/// legality gate does not enforce (or vice versa). Returns None when the edge
/// is not bed-supported — fluid travel ignores lakebed geometry.
#[inline]
pub(crate) fn pathfinder_bed_edge_forces(
    state: &PathfinderState,
    from_idx: usize,
    to_idx: usize,
    horizontal: f64,
    allow_air: bool,
    allow_ground: bool,
    water_surface_supported: bool,
    safe_ground_accel: f64,
    static_friction_coefficient: f64,
    safe_water_drive_accel: f64,
) -> Option<PathfinderBedEdgeForces> {
    let wet_edge = state.terrain_water[from_idx] != 0 || state.terrain_water[to_idx] != 0;
    let bed_supported_edge = !allow_air && allow_ground && (!wet_edge || !water_surface_supported);
    if !bed_supported_edge {
        return None;
    }
    let dz = state.terrain_height[to_idx] as f64 - state.terrain_height[from_idx] as f64;
    let surface_distance = (horizontal * horizontal + dz * dz).sqrt();
    let directional_sine = dz / surface_distance.max(1.0e-9);
    let uphill_sine = directional_sine.max(0.0);
    let normal_z = (state.terrain_normal_z[from_idx] as f64)
        .min(state.terrain_normal_z[to_idx] as f64)
        .clamp(0.0, 1.0);
    let total_tangent_sine = (1.0 - normal_z * normal_z).max(0.0).sqrt();
    let lateral_sine_sq =
        (total_tangent_sine * total_tangent_sine - directional_sine * directional_sine).max(0.0);
    let lateral_hold_accel = GRAVITY * lateral_sine_sq.sqrt();
    let grip_accel = GRAVITY * static_friction_coefficient * normal_z;
    let safe_ground = safe_ground_accel.min(grip_accel);
    let safe_water = if wet_edge {
        let from_wet = state.terrain_water[from_idx] != 0;
        let to_wet = state.terrain_water[to_idx] != 0;
        let water_fraction = match (from_wet, to_wet) {
            (true, true) => pathfinder_cell_water_case_scale(state, from_idx)
                .min(pathfinder_cell_water_case_scale(state, to_idx)),
            (true, false) => pathfinder_cell_water_case_scale(state, from_idx),
            (false, true) => pathfinder_cell_water_case_scale(state, to_idx),
            (false, false) => 0.0,
        };
        safe_water_drive_accel * water_fraction
    } else {
        0.0
    };
    Some(PathfinderBedEdgeForces {
        surface_distance,
        uphill_sine,
        lateral_hold_accel,
        total_tangent_budget: safe_ground + safe_water,
        safe_water_accel: safe_water,
        wet_edge,
    })
}

/// Normalized traversal-time cost for one legal neighboring edge. Flat travel
/// costs its grid distance. Bed-supported travel reserves the combined safe
/// tangential force budget for cross-slope support before assigning what
/// remains to forward acceleration; wet contact adds independent water drive
/// to the Coulomb-limited ground actuator. Uphill then subtracts gravity along
/// the route. Fluid-supported water ignores lakebed geometry. A downhill edge
/// receives no speculative speed bonus, keeping octile distance admissible.
#[inline]
fn pathfinder_edge_cost_from_forces(
    state: &PathfinderState,
    to_idx: usize,
    horizontal_cells: f64,
    traversal: PathfinderTraversal,
    cost_profile: PathfinderCostProfile,
    forces: Option<PathfinderBedEdgeForces>,
) -> f32 {
    let mut travel_cost = horizontal_cells;
    if let Some(forces) = forces {
        let has_contact_accel = if forces.wet_edge {
            cost_profile.flat_water_contact_accel > 0.0
        } else {
            cost_profile.flat_drive_accel > 0.0
        };
        if has_contact_accel {
            // Ground traction and occupancy-weighted fluid thrust contribute
            // to the same available tangent-force budget before cross-slope
            // support.
            if forces.lateral_hold_accel >= forces.total_tangent_budget {
                return f32::MAX;
            }
            let longitudinal_budget = (forces.total_tangent_budget * forces.total_tangent_budget
                - forces.lateral_hold_accel * forces.lateral_hold_accel)
                .max(0.0)
                .sqrt();
            let remaining_accel = (longitudinal_budget - GRAVITY * forces.uphill_sine).max(1.0e-9);
            let flat_safe_accel = cost_profile
                .safe_drive_accel
                .min(GRAVITY * cost_profile.static_friction_coefficient)
                + forces.safe_water_accel;
            // Terminal-velocity time model: with exponential tangential
            // damping the cruise speed is accel/rate, so the edge-vs-flat
            // travel-time ratio is the LINEAR accel ratio — the damping rate
            // cancels for one unit on one edge, needing no extra plumbing.
            // (The old sqrt() was an acceleration-time model that
            // systematically under-priced climbs against the integrator's
            // steady-state speeds.) Wet edges still share the dry damping
            // assumption; water drag makes them slightly cheap, never
            // inadmissibly expensive.
            let terminal_velocity_time_scale = (flat_safe_accel / remaining_accel).max(1.0);
            travel_cost = forces.surface_distance / PATHFINDER_BUILD_GRID_CELL_SIZE
                * terminal_velocity_time_scale;
        }
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

#[inline]
#[cfg(test)]
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
    let forces = pathfinder_bed_edge_forces(
        state,
        from_idx,
        to_idx,
        horizontal_cells * PATHFINDER_BUILD_GRID_CELL_SIZE,
        traversal.allow_air,
        traversal.allow_ground,
        traversal.water_surface_supported,
        cost_profile.safe_drive_accel,
        cost_profile.static_friction_coefficient,
        cost_profile.safe_water_drive_accel,
    );
    pathfinder_edge_cost_from_forces(
        state,
        to_idx,
        horizontal_cells,
        traversal,
        cost_profile,
        forces,
    )
}

#[inline]
fn pathfinder_force_profiles_match(
    traversal: PathfinderTraversal,
    cost_profile: PathfinderCostProfile,
) -> bool {
    traversal.safe_ground_accel.to_bits() == cost_profile.safe_drive_accel.to_bits()
        && traversal.safe_water_drive_accel.to_bits()
            == cost_profile.safe_water_drive_accel.to_bits()
        && traversal.static_friction_coefficient.to_bits()
            == cost_profile.static_friction_coefficient.to_bits()
}

/// Evaluate one directed neighboring move and its cost as a single operation.
/// The primary edge's force geometry feeds both legality and travel-time cost,
/// eliminating the duplicate square roots and water-force work that formerly
/// occurred in `can_step_neighbor` followed by `edge_cost`.
#[inline]
fn pathfinder_neighbor_cost_uncached(
    state: &mut PathfinderState,
    from_gx: i32,
    from_gy: i32,
    to_gx: i32,
    to_gy: i32,
    traversal: PathfinderTraversal,
    cost_profile: PathfinderCostProfile,
) -> Option<f32> {
    let from_idx = (from_gy * state.grid_w + from_gx) as usize;
    let to_idx = (to_gy * state.grid_w + to_gx) as usize;
    let legality_forces =
        pathfinder_step_between_cached_forces(state, from_idx, to_idx, traversal, true)?;
    let dx = to_gx - from_gx;
    let dy = to_gy - from_gy;
    if dx != 0 && dy != 0 {
        // Preserve exact supercover corner rules: a diagonal is legal only
        // when both cardinal side cells can be entered from the source.
        let side_x_idx = (from_gy * state.grid_w + to_gx) as usize;
        let side_y_idx = (to_gy * state.grid_w + from_gx) as usize;
        if !pathfinder_can_step_between_cached(state, from_idx, side_x_idx, traversal)
            || !pathfinder_can_step_between_cached(state, from_idx, side_y_idx, traversal)
        {
            return None;
        }
    }
    let horizontal_cells = ((dx * dx + dy * dy) as f64).sqrt();
    let forces = if pathfinder_force_profiles_match(traversal, cost_profile) {
        legality_forces
    } else {
        pathfinder_bed_edge_forces(
            state,
            from_idx,
            to_idx,
            horizontal_cells * PATHFINDER_BUILD_GRID_CELL_SIZE,
            traversal.allow_air,
            traversal.allow_ground,
            traversal.water_surface_supported,
            cost_profile.safe_drive_accel,
            cost_profile.static_friction_coefficient,
            cost_profile.safe_water_drive_accel,
        )
    };
    Some(pathfinder_edge_cost_from_forces(
        state,
        to_idx,
        horizontal_cells,
        traversal,
        cost_profile,
        forces,
    ))
}

#[inline]
fn pathfinder_neighbor_direction(dx: i32, dy: i32) -> Option<u64> {
    match (dx, dy) {
        (1, 0) => Some(0),
        (-1, 0) => Some(1),
        (0, 1) => Some(2),
        (0, -1) => Some(3),
        (1, 1) => Some(4),
        (1, -1) => Some(5),
        (-1, 1) => Some(6),
        (-1, -1) => Some(7),
        _ => None,
    }
}

#[inline]
fn pathfinder_line_neighbor_cost(
    state: &mut PathfinderState,
    from_gx: i32,
    from_gy: i32,
    to_gx: i32,
    to_gy: i32,
    traversal: PathfinderTraversal,
    cost_profile: PathfinderCostProfile,
) -> Option<f32> {
    // The first straight-line probe is the overwhelmingly common open-field
    // fast path and usually returns immediately, so do not pay HashMap
    // insertion cost for edges that will never be revisited. Hierarchy and
    // string pulling enable the cache only after that direct probe fails.
    if !state.line_transition_cache_enabled {
        return pathfinder_neighbor_cost_uncached(
            state,
            from_gx,
            from_gy,
            to_gx,
            to_gy,
            traversal,
            cost_profile,
        );
    }
    let direction = pathfinder_neighbor_direction(to_gx - from_gx, to_gy - from_gy)?;
    let from_idx = (from_gy * state.grid_w + from_gx) as u64;
    let key = (from_idx << 3) | direction;
    if let Some(cached) = state.line_transition_cost_cache.get(&key).copied() {
        state.line_transition_cache_hits = state.line_transition_cache_hits.saturating_add(1);
        return if cached.is_finite() {
            Some(cached)
        } else {
            None
        };
    }
    state.line_transition_cache_misses = state.line_transition_cache_misses.saturating_add(1);
    let cost = pathfinder_neighbor_cost_uncached(
        state,
        from_gx,
        from_gy,
        to_gx,
        to_gy,
        traversal,
        cost_profile,
    );
    state
        .line_transition_cost_cache
        .insert(key, cost.unwrap_or(f32::INFINITY));
    cost
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
fn pathfinder_direct_cost_within_fast_path(direct_cost: Option<f32>, lower_bound: f32) -> bool {
    direct_cost
        .is_some_and(|cost| cost <= lower_bound * PATHFINDING_DIRECT_PATH_MAX_COST_RATIO + 1.0e-5)
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
    expanded_nodes: u32,
    hit_node_limit: bool,
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
            if state.closed[nidx] != 0 {
                continue;
            }
            let Some(step_cost) =
                pathfinder_neighbor_cost_uncached(state, cgx, cgy, nx, ny, traversal, cost_profile)
            else {
                continue;
            };
            let tentative = state.g_score[cur_us] + step_cost;
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
        expanded_nodes: expanded,
        hit_node_limit: !found && expanded >= PATHFINDER_MAX_A_STAR_NODES,
    })
}

/// Trace the same supercover Bresenham segment used by validation and
/// smoothing. Returning its cost keeps path legality and route quality on one
/// traversal primitive; `None` means the segment is illegal.
pub(crate) fn pathfinder_line_cost(
    state: &mut PathfinderState,
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
        cost += pathfinder_line_neighbor_cost(
            state,
            gx,
            gy,
            next_gx,
            next_gy,
            traversal,
            cost_profile,
        )?;
        gx = next_gx;
        gy = next_gy;
    }
    None
}

#[inline]
pub(crate) fn pathfinder_has_los(
    state: &mut PathfinderState,
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

struct HierarchicalAStarResult {
    route_cost: f32,
    expanded_nodes: u32,
}

#[inline]
fn pathfinder_hierarchy_heap_precedes(state: &PathfinderState, left: u32, right: u32) -> bool {
    let left_idx = left as usize;
    let right_idx = right as usize;
    let left_f = state.hierarchy_f_score[left_idx];
    let right_f = state.hierarchy_f_score[right_idx];
    if left_f != right_f {
        return left_f < right_f;
    }
    let left_g = state.hierarchy_g_score[left_idx];
    let right_g = state.hierarchy_g_score[right_idx];
    if left_g != right_g {
        return left_g > right_g;
    }
    left < right
}

fn pathfinder_hierarchy_heap_push(state: &mut PathfinderState, idx: u32) {
    state.hierarchy_heap.push(idx);
    let mut i = state.hierarchy_heap.len() - 1;
    while i > 0 {
        let parent = (i - 1) >> 1;
        if pathfinder_hierarchy_heap_precedes(
            state,
            state.hierarchy_heap[i],
            state.hierarchy_heap[parent],
        ) {
            state.hierarchy_heap.swap(i, parent);
            i = parent;
        } else {
            break;
        }
    }
}

fn pathfinder_hierarchy_heap_pop(state: &mut PathfinderState) -> u32 {
    let top = state.hierarchy_heap[0];
    let last = state.hierarchy_heap.pop().unwrap();
    let len = state.hierarchy_heap.len();
    if len > 0 {
        state.hierarchy_heap[0] = last;
        let mut i = 0usize;
        loop {
            let left = (i << 1) + 1;
            let right = left + 1;
            let mut smallest = i;
            if left < len
                && pathfinder_hierarchy_heap_precedes(
                    state,
                    state.hierarchy_heap[left],
                    state.hierarchy_heap[smallest],
                )
            {
                smallest = left;
            }
            if right < len
                && pathfinder_hierarchy_heap_precedes(
                    state,
                    state.hierarchy_heap[right],
                    state.hierarchy_heap[smallest],
                )
            {
                smallest = right;
            }
            if smallest == i {
                break;
            }
            state.hierarchy_heap.swap(i, smallest);
            i = smallest;
        }
    }
    top
}

/// Resolve a cluster to a deterministic fine-grid representative. A cluster
/// whose geometric center is blocked uses the nearest passable fine cell in
/// that same cluster. This is intentionally query-local because clearance,
/// locomotion medium, slope capability, and building occupancy all affect
/// passability.
fn pathfinder_hierarchy_resolve_node_cell(
    state: &mut PathfinderState,
    node: u32,
    traversal: PathfinderTraversal,
) -> Option<i32> {
    let node_idx = node as usize;
    let cached = state.hierarchy_node_cell[node_idx];
    if cached != i32::MIN {
        return if cached >= 0 { Some(cached) } else { None };
    }

    let cluster_size = PATHFINDING_HIERARCHICAL_CLUSTER_SIZE_CELLS;
    let cluster_x = node as i32 % state.hierarchy_grid_w;
    let cluster_y = node as i32 / state.hierarchy_grid_w;
    let min_gx = cluster_x * cluster_size;
    let min_gy = cluster_y * cluster_size;
    let max_gx = ((cluster_x + 1) * cluster_size).min(state.grid_w);
    let max_gy = ((cluster_y + 1) * cluster_size).min(state.grid_h);
    let center_gx = (min_gx + max_gx - 1) / 2;
    let center_gy = (min_gy + max_gy - 1) / 2;
    let center_cell = center_gy * state.grid_w + center_gx;
    if pathfinder_cached_cell_passable(state, center_cell as usize, traversal, false) {
        state.hierarchy_node_cell[node_idx] = center_cell;
        return Some(center_cell);
    }
    state.last_coarse_full_cluster_scans += 1;
    let mut best_cell = -1;
    let mut best_d2 = i32::MAX;
    for gy in min_gy..max_gy {
        for gx in min_gx..max_gx {
            let fine_idx = gy * state.grid_w + gx;
            if !pathfinder_cached_cell_passable(state, fine_idx as usize, traversal, false) {
                continue;
            }
            let dx = gx - center_gx;
            let dy = gy - center_gy;
            let d2 = dx * dx + dy * dy;
            if d2 < best_d2 || (d2 == best_d2 && fine_idx < best_cell) {
                best_cell = fine_idx;
                best_d2 = d2;
            }
        }
    }
    state.hierarchy_node_cell[node_idx] = best_cell;
    if best_cell >= 0 {
        Some(best_cell)
    } else {
        None
    }
}

#[inline]
fn pathfinder_hierarchy_node_position(
    state: &mut PathfinderState,
    node: u32,
    start_node: u32,
    goal_node: u32,
    start_x: f64,
    start_y: f64,
    goal_x: f64,
    goal_y: f64,
    traversal: PathfinderTraversal,
) -> Option<(f64, f64)> {
    if node == start_node {
        return Some((start_x, start_y));
    }
    if node == goal_node {
        return Some((goal_x, goal_y));
    }
    let fine_idx = pathfinder_hierarchy_resolve_node_cell(state, node, traversal)?;
    let gx = fine_idx % state.grid_w;
    let gy = (fine_idx - gx) / state.grid_w;
    Some(pathfinder_cell_center(gx, gy))
}

#[inline]
fn pathfinder_hierarchy_heuristic(x: f64, y: f64, goal_x: f64, goal_y: f64) -> f32 {
    let dx = x - goal_x;
    let dy = y - goal_y;
    ((dx * dx + dy * dy).sqrt() / PATHFINDER_BUILD_GRID_CELL_SIZE) as f32
}

/// Find a deterministic fine-grid portal across the shared boundary of two
/// adjacent hierarchy chunks. Candidates are checked from the boundary center
/// outward so open terrain stays cheap while off-center passes through long
/// walls remain discoverable. Retaining the actual cells is essential: merely
/// knowing that a boundary has an opening and then refining center-to-center
/// can still draw the exact route through the blocked part of that boundary.
fn pathfinder_hierarchy_boundary_transition(
    state: &mut PathfinderState,
    from: u32,
    to: u32,
    traversal: PathfinderTraversal,
) -> Option<(i32, i32)> {
    let cluster_size = PATHFINDING_HIERARCHICAL_CLUSTER_SIZE_CELLS;
    let from_cx = from as i32 % state.hierarchy_grid_w;
    let from_cy = from as i32 / state.hierarchy_grid_w;
    let to_cx = to as i32 % state.hierarchy_grid_w;
    let to_cy = to as i32 / state.hierarchy_grid_w;
    let dx = to_cx - from_cx;
    let dy = to_cy - from_cy;

    let from_min_x = from_cx * cluster_size;
    let from_min_y = from_cy * cluster_size;
    let from_max_x = ((from_cx + 1) * cluster_size).min(state.grid_w);
    let from_max_y = ((from_cy + 1) * cluster_size).min(state.grid_h);
    let to_min_x = to_cx * cluster_size;
    let to_min_y = to_cy * cluster_size;
    let to_max_x = ((to_cx + 1) * cluster_size).min(state.grid_w);
    let to_max_y = ((to_cy + 1) * cluster_size).min(state.grid_h);

    match (dx, dy) {
        (1, 0) | (-1, 0) => {
            let (from_gx, to_gx) = if dx > 0 {
                (from_max_x - 1, to_min_x)
            } else {
                (from_min_x, to_max_x - 1)
            };
            let min_gy = from_min_y.max(to_min_y);
            let max_gy = from_max_y.min(to_max_y);
            let center_gy = (min_gy + max_gy - 1) / 2;
            for offset in 0..(max_gy - min_gy) {
                let gy = if offset == 0 {
                    center_gy
                } else if offset & 1 == 1 {
                    center_gy - (offset + 1) / 2
                } else {
                    center_gy + offset / 2
                };
                if gy < min_gy || gy >= max_gy {
                    continue;
                }
                if pathfinder_can_step_neighbor_cached(state, from_gx, gy, to_gx, gy, traversal) {
                    return Some((gy * state.grid_w + from_gx, gy * state.grid_w + to_gx));
                }
            }
            None
        }
        (0, 1) | (0, -1) => {
            let (from_gy, to_gy) = if dy > 0 {
                (from_max_y - 1, to_min_y)
            } else {
                (from_min_y, to_max_y - 1)
            };
            let min_gx = from_min_x.max(to_min_x);
            let max_gx = from_max_x.min(to_max_x);
            let center_gx = (min_gx + max_gx - 1) / 2;
            for offset in 0..(max_gx - min_gx) {
                let gx = if offset == 0 {
                    center_gx
                } else if offset & 1 == 1 {
                    center_gx - (offset + 1) / 2
                } else {
                    center_gx + offset / 2
                };
                if gx < min_gx || gx >= max_gx {
                    continue;
                }
                if pathfinder_can_step_neighbor_cached(state, gx, from_gy, gx, to_gy, traversal) {
                    return Some((from_gy * state.grid_w + gx, to_gy * state.grid_w + gx));
                }
            }
            None
        }
        (1, 1) | (1, -1) | (-1, 1) | (-1, -1) => {
            let from_gx = if dx > 0 { from_max_x - 1 } else { from_min_x };
            let to_gx = if dx > 0 { to_min_x } else { to_max_x - 1 };
            let from_gy = if dy > 0 { from_max_y - 1 } else { from_min_y };
            let to_gy = if dy > 0 { to_min_y } else { to_max_y - 1 };
            if pathfinder_can_step_neighbor_cached(state, from_gx, from_gy, to_gx, to_gy, traversal)
            {
                Some((
                    from_gy * state.grid_w + from_gx,
                    to_gy * state.grid_w + to_gx,
                ))
            } else {
                None
            }
        }
        _ => None,
    }
}

fn pathfinder_hierarchy_edge_cost(
    state: &mut PathfinderState,
    from: u32,
    to: u32,
    direction: usize,
    start_node: u32,
    goal_node: u32,
    start_x: f64,
    start_y: f64,
    goal_x: f64,
    goal_y: f64,
    traversal: PathfinderTraversal,
    _cost_profile: PathfinderCostProfile,
) -> Option<f32> {
    let slot = from as usize * 8 + direction;
    let cached = state.hierarchy_edge_cost[slot];
    if !cached.is_nan() {
        return if cached.is_finite() {
            Some(cached)
        } else {
            None
        };
    }
    let Some((portal_from, portal_to)) =
        pathfinder_hierarchy_boundary_transition(state, from, to, traversal)
    else {
        state.hierarchy_edge_cost[slot] = f32::INFINITY;
        return None;
    };
    state.hierarchy_edge_from_cell[slot] = portal_from;
    state.hierarchy_edge_to_cell[slot] = portal_to;
    let from_position = pathfinder_hierarchy_node_position(
        state, from, start_node, goal_node, start_x, start_y, goal_x, goal_y, traversal,
    );
    let to_position = pathfinder_hierarchy_node_position(
        state, to, start_node, goal_node, start_x, start_y, goal_x, goal_y, traversal,
    );
    let cost = match (from_position, to_position) {
        (Some((from_x, from_y)), Some((to_x, to_y))) => {
            Some(pathfinder_hierarchy_heuristic(from_x, from_y, to_x, to_y))
        }
        _ => None,
    };
    state.hierarchy_edge_cost[slot] = cost.unwrap_or(f32::INFINITY);
    cost
}

#[inline]
fn pathfinder_hierarchy_direction(state: &PathfinderState, from: u32, to: u32) -> Option<usize> {
    let from_x = from as i32 % state.hierarchy_grid_w;
    let from_y = from as i32 / state.hierarchy_grid_w;
    let to_x = to as i32 % state.hierarchy_grid_w;
    let to_y = to as i32 / state.hierarchy_grid_w;
    let dx = to_x - from_x;
    let dy = to_y - from_y;
    (0..8).find(|&direction| {
        PATHFINDER_NEIGHBOR_DX[direction] == dx && PATHFINDER_NEIGHBOR_DY[direction] == dy
    })
}

/// Refine one candidate abstract path through the concrete boundary portals
/// retained for its edges. Invalid approaches become blocked abstract edges
/// for this query so coarse A* can cheaply seek another route. A successful
/// result is already an exact, legal fine-grid chain suitable for smoothing.
fn pathfinder_hierarchy_refine_candidate(
    state: &mut PathfinderState,
    start_node: u32,
    goal_node: u32,
    start_x: f64,
    start_y: f64,
    goal_x: f64,
    goal_y: f64,
    traversal: PathfinderTraversal,
    cost_profile: PathfinderCostProfile,
) -> (Option<(f32, Vec<u32>)>, bool) {
    let mut total_cost = 0.0f32;
    let mut fine_path = Vec::with_capacity(state.hierarchy_path.len() * 2 + 1);
    let mut current_x = start_x;
    let mut current_y = start_y;
    let mut from = start_node;
    let mut last_slot = None;
    for path_index in 0..state.hierarchy_path.len() {
        let to = state.hierarchy_path[path_index];
        let Some(direction) = pathfinder_hierarchy_direction(state, from, to) else {
            return (None, false);
        };
        let slot = from as usize * 8 + direction;
        let portal_from = state.hierarchy_edge_from_cell[slot];
        let portal_to = state.hierarchy_edge_to_cell[slot];
        if portal_from < 0 || portal_to < 0 {
            state.hierarchy_edge_cost[slot] = f32::INFINITY;
            return (None, true);
        }

        let portal_from_gx = portal_from % state.grid_w;
        let portal_from_gy = portal_from / state.grid_w;
        let portal_to_gx = portal_to % state.grid_w;
        let portal_to_gy = portal_to / state.grid_w;
        let portal_from_position = pathfinder_cell_center(portal_from_gx, portal_from_gy);
        let portal_to_position = pathfinder_cell_center(portal_to_gx, portal_to_gy);

        state.last_coarse_exact_edge_checks += 1;
        let Some(approach_cost) = pathfinder_line_cost(
            state,
            current_x,
            current_y,
            portal_from_position.0,
            portal_from_position.1,
            traversal,
            cost_profile,
        ) else {
            state.hierarchy_edge_cost[slot] = f32::INFINITY;
            return (None, true);
        };
        state.last_coarse_exact_edge_checks += 1;
        let Some(crossing_cost) = pathfinder_line_cost(
            state,
            portal_from_position.0,
            portal_from_position.1,
            portal_to_position.0,
            portal_to_position.1,
            traversal,
            cost_profile,
        ) else {
            state.hierarchy_edge_cost[slot] = f32::INFINITY;
            return (None, true);
        };
        total_cost += approach_cost + crossing_cost;
        for portal in [portal_from as u32, portal_to as u32] {
            if fine_path.last().copied() != Some(portal) {
                fine_path.push(portal);
            }
        }
        current_x = portal_to_position.0;
        current_y = portal_to_position.1;
        last_slot = Some(slot);
        from = to;
    }
    debug_assert_eq!(from, goal_node);
    state.last_coarse_exact_edge_checks += 1;
    let Some(goal_cost) = pathfinder_line_cost(
        state,
        current_x,
        current_y,
        goal_x,
        goal_y,
        traversal,
        cost_profile,
    ) else {
        if let Some(slot) = last_slot {
            state.hierarchy_edge_cost[slot] = f32::INFINITY;
            return (None, true);
        }
        return (None, false);
    };
    total_cost += goal_cost;
    let goal_cell = state.hierarchy_node_cell[goal_node as usize];
    if goal_cell >= 0 && fine_path.last().copied() != Some(goal_cell as u32) {
        fine_path.push(goal_cell as u32);
    }
    (Some((total_cost, fine_path)), false)
}

/// Search a sparse level-1 graph for long routes. Coarse A* uses geometric
/// lower bounds and exact directed boundary connectivity, then refines a
/// candidate through those boundary portals. Returned routes are fully legal
/// even though unselected abstract edges stay cheap.
fn pathfinder_hierarchical_a_star(
    state: &mut PathfinderState,
    start_gx: i32,
    start_gy: i32,
    goal_gx: i32,
    goal_gy: i32,
    start_x: f64,
    start_y: f64,
    goal_x: f64,
    goal_y: f64,
    traversal: PathfinderTraversal,
    cost_profile: PathfinderCostProfile,
) -> Option<HierarchicalAStarResult> {
    if pathfinder_octile(start_gx, start_gy, goal_gx, goal_gy)
        < PATHFINDING_HIERARCHICAL_MIN_DISTANCE_CELLS
    {
        return None;
    }
    let cluster_size = PATHFINDING_HIERARCHICAL_CLUSTER_SIZE_CELLS;
    let hierarchy_grid_w = (state.grid_w + cluster_size - 1) / cluster_size;
    let hierarchy_grid_h = (state.grid_h + cluster_size - 1) / cluster_size;
    let node_count = (hierarchy_grid_w * hierarchy_grid_h) as usize;
    if node_count <= 1 {
        return None;
    }
    state.hierarchy_grid_w = hierarchy_grid_w;
    state.hierarchy_grid_h = hierarchy_grid_h;
    state.hierarchy_node_cell.clear();
    state.hierarchy_node_cell.resize(node_count, i32::MIN);
    state.hierarchy_g_score.clear();
    state.hierarchy_g_score.resize(node_count, f32::INFINITY);
    state.hierarchy_f_score.clear();
    state.hierarchy_f_score.resize(node_count, f32::INFINITY);
    state.hierarchy_parent.clear();
    state.hierarchy_parent.resize(node_count, -1);
    state.hierarchy_closed.clear();
    state.hierarchy_closed.resize(node_count, 0);
    state.hierarchy_edge_cost.clear();
    state.hierarchy_edge_cost.resize(node_count * 8, f32::NAN);
    state.hierarchy_edge_from_cell.clear();
    state.hierarchy_edge_from_cell.resize(node_count * 8, -1);
    state.hierarchy_edge_to_cell.clear();
    state.hierarchy_edge_to_cell.resize(node_count * 8, -1);
    state.hierarchy_heap.clear();
    state.hierarchy_path.clear();

    let start_cluster_x = start_gx / cluster_size;
    let start_cluster_y = start_gy / cluster_size;
    let goal_cluster_x = goal_gx / cluster_size;
    let goal_cluster_y = goal_gy / cluster_size;
    let start_node = (start_cluster_y * hierarchy_grid_w + start_cluster_x) as u32;
    let goal_node = (goal_cluster_y * hierarchy_grid_w + goal_cluster_x) as u32;
    if start_node == goal_node {
        return None;
    }
    state.hierarchy_node_cell[start_node as usize] = start_gy * state.grid_w + start_gx;
    state.hierarchy_node_cell[goal_node as usize] = goal_gy * state.grid_w + goal_gx;
    let mut total_expanded = 0u32;
    let mut best_cost = f32::INFINITY;
    let mut best_fine_path: Vec<u32> = Vec::new();
    for _ in 0..PATHFINDER_HIERARCHY_MAX_REFINEMENTS {
        state.last_coarse_refinement_passes += 1;
        state.hierarchy_g_score.fill(f32::INFINITY);
        state.hierarchy_f_score.fill(f32::INFINITY);
        state.hierarchy_parent.fill(-1);
        state.hierarchy_closed.fill(0);
        state.hierarchy_heap.clear();
        state.hierarchy_path.clear();
        state.hierarchy_g_score[start_node as usize] = 0.0;
        state.hierarchy_f_score[start_node as usize] =
            pathfinder_hierarchy_heuristic(start_x, start_y, goal_x, goal_y);
        pathfinder_hierarchy_heap_push(state, start_node);

        let mut expanded = 0u32;
        let mut found = false;
        while !state.hierarchy_heap.is_empty() {
            let current = pathfinder_hierarchy_heap_pop(state);
            let current_idx = current as usize;
            if state.hierarchy_closed[current_idx] != 0 {
                continue;
            }
            state.hierarchy_closed[current_idx] = 1;
            expanded += 1;
            if current == goal_node {
                found = true;
                break;
            }
            let current_x = current as i32 % hierarchy_grid_w;
            let current_y = current as i32 / hierarchy_grid_w;
            for direction in 0..8 {
                let next_x = current_x + PATHFINDER_NEIGHBOR_DX[direction];
                let next_y = current_y + PATHFINDER_NEIGHBOR_DY[direction];
                if next_x < 0
                    || next_y < 0
                    || next_x >= hierarchy_grid_w
                    || next_y >= hierarchy_grid_h
                {
                    continue;
                }
                let next = (next_y * hierarchy_grid_w + next_x) as u32;
                if state.hierarchy_closed[next as usize] != 0 {
                    continue;
                }
                let Some(edge_cost) = pathfinder_hierarchy_edge_cost(
                    state,
                    current,
                    next,
                    direction,
                    start_node,
                    goal_node,
                    start_x,
                    start_y,
                    goal_x,
                    goal_y,
                    traversal,
                    cost_profile,
                ) else {
                    continue;
                };
                let tentative = state.hierarchy_g_score[current_idx] + edge_cost;
                let next_idx = next as usize;
                if tentative >= state.hierarchy_g_score[next_idx] {
                    continue;
                }
                state.hierarchy_parent[next_idx] = current as i32;
                state.hierarchy_g_score[next_idx] = tentative;
                let Some((next_world_x, next_world_y)) = pathfinder_hierarchy_node_position(
                    state, next, start_node, goal_node, start_x, start_y, goal_x, goal_y, traversal,
                ) else {
                    continue;
                };
                state.hierarchy_f_score[next_idx] = tentative
                    + pathfinder_hierarchy_heuristic(next_world_x, next_world_y, goal_x, goal_y);
                pathfinder_hierarchy_heap_push(state, next);
            }
        }
        total_expanded = total_expanded.saturating_add(expanded);
        if !found {
            break;
        }

        let mut walker = goal_node as i32;
        while walker != start_node as i32 && walker >= 0 {
            state.hierarchy_path.push(walker as u32);
            walker = state.hierarchy_parent[walker as usize];
        }
        if walker != start_node as i32 {
            break;
        }
        state.hierarchy_path.reverse();
        let (refined_cost, updated) = pathfinder_hierarchy_refine_candidate(
            state,
            start_node,
            goal_node,
            start_x,
            start_y,
            goal_x,
            goal_y,
            traversal,
            cost_profile,
        );
        if let Some((refined_cost, fine_path)) = refined_cost {
            if refined_cost < best_cost {
                best_cost = refined_cost;
                best_fine_path = fine_path;
            }
            if !updated {
                break;
            }
        }
    }
    state.last_coarse_expanded_nodes = total_expanded;
    if best_fine_path.is_empty() {
        return None;
    }
    state.path_scratch = best_fine_path;
    Some(HierarchicalAStarResult {
        route_cost: best_cost,
        expanded_nodes: total_expanded,
    })
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
/// move_allow_* flags define physical traversal. Each cell independently
/// reports whether exposed and/or water cases are present; mixed cells require
/// both cases to pass. Physical lakebed contact does not by itself authorize
/// an intentional water route.
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
    state.last_search_strategy = PATHFINDER_SEARCH_NONE;
    state.last_fine_expanded_nodes = 0;
    state.last_coarse_expanded_nodes = 0;
    state.last_coarse_refinement_passes = 0;
    state.last_coarse_exact_edge_checks = 0;
    state.last_coarse_full_cluster_scans = 0;
    state.last_fine_hit_node_limit = false;
    state.last_smoothing_line_checks = 0;
    state.last_direct_cost_ratio = f32::NAN;
    let traversal = PathfinderTraversal {
        min_ground_normal_z,
        safe_ground_accel: safe_drive_accel,
        safe_water_drive_accel,
        static_friction_coefficient,
        water_surface_supported,
        water_waypoint_hold: false,
        allow_ground: move_allow_ground,
        allow_water: move_allow_water,
        allow_air: move_allow_air,
        wet_contact_required_normal_z: 0.0,
    }
    .derived();
    let waypoint_traversal = PathfinderTraversal {
        min_ground_normal_z,
        safe_ground_accel: safe_drive_accel,
        safe_water_drive_accel,
        static_friction_coefficient,
        water_surface_supported,
        water_waypoint_hold: true,
        allow_ground: waypoint_allow_ground,
        allow_water: waypoint_allow_water,
        allow_air: waypoint_allow_air,
        wet_contact_required_normal_z: 0.0,
    }
    .derived();
    state.cur_waypoint_traversal = waypoint_traversal;
    state.cur_waypoint_matches_move_domain =
        pathfinder_traversal_cell_domain_equivalent(waypoint_traversal, traversal);
    pathfinder_begin_query_transition_cache(state);
    // Per-query traversal params. The current cell must be physically
    // move-valid, even when it is outside the intentional waypoint domain.
    // Goals must be waypoint-valid and every segment must fit the body.
    // Air traversal flies over footprints, so it carries no clearance.
    state.cur_symmetric_slope = symmetric_slope;
    state.cur_unit_radius = pathfinder_query_unit_radius(unit_radius);
    state.cur_support_point_offset_z = pathfinder_query_unit_radius(support_point_offset_z);
    pathfinder_apply_query_slope_gates(
        state,
        safe_drive_accel,
        static_friction_coefficient,
        safe_water_drive_accel,
    );
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
    // domain. A start blocked ONLY by a building footprint is an escape
    // start: the unit was there before the building, and every step INTO a
    // building cell is illegal anyway, so A* can only route it out.
    let start_cell_gx = sgx;
    let start_cell_gy = sgy;
    if !pathfinder_position_is_in_navigation_domain(state, start_x, start_y, traversal)
        || !pathfinder_is_cell_passable_ignoring_buildings(state, start_idx, traversal)
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
    let start_is_waypoint_valid = pathfinder_is_cell_passable(state, start_idx, waypoint_traversal);
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
            match pathfinder_find_nearest_in_component(
                state,
                ggx,
                ggy,
                start_label,
                waypoint_traversal,
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
        state.last_result_status = if goal_was_snapped {
            PATHFINDER_RESULT_SNAPPED
        } else {
            PATHFINDER_RESULT_COMPLETE
        };
        state.last_search_strategy = PATHFINDER_SEARCH_DIRECT;
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
    if let Some(cost) = direct_cost {
        state.last_direct_cost_ratio = cost / geometric_lower_bound.max(1.0e-6);
    }
    if pathfinder_direct_cost_within_fast_path(direct_cost, geometric_lower_bound) {
        state.waypoint_scratch.push(raw_goal_x);
        state.waypoint_scratch.push(raw_goal_y);
        state.last_result_status = if goal_was_snapped {
            PATHFINDER_RESULT_SNAPPED
        } else {
            PATHFINDER_RESULT_COMPLETE
        };
        state.last_search_strategy = PATHFINDER_SEARCH_DIRECT;
        return 1;
    }

    state.line_transition_cache_enabled = true;
    let hierarchical_result = pathfinder_hierarchical_a_star(
        state,
        start_cell_gx,
        start_cell_gy,
        goal_cell_gx,
        goal_cell_gy,
        start_x,
        start_y,
        raw_goal_x,
        raw_goal_y,
        traversal,
        cost_profile,
    );
    let a_star_result = if let Some(hierarchical) = hierarchical_result {
        state.last_coarse_expanded_nodes = hierarchical.expanded_nodes;
        // The legal direct segment remains a useful upper bound. If the sparse
        // graph did not improve it, prefer the simpler exact route.
        if direct_cost.is_some_and(|cost| cost <= hierarchical.route_cost + 1.0e-5) {
            state.waypoint_scratch.push(raw_goal_x);
            state.waypoint_scratch.push(raw_goal_y);
            state.last_result_status = if goal_was_snapped {
                PATHFINDER_RESULT_SNAPPED
            } else {
                PATHFINDER_RESULT_COMPLETE
            };
            state.last_search_strategy = PATHFINDER_SEARCH_DIRECT;
            return 1;
        }
        state.last_search_strategy = PATHFINDER_SEARCH_HIERARCHICAL;
        Some(AStarResult {
            goal_gx: goal_cell_gx,
            goal_gy: goal_cell_gy,
            reached_goal: true,
            expanded_nodes: 0,
            hit_node_limit: false,
        })
    } else {
        state.last_search_strategy = PATHFINDER_SEARCH_FINE_A_STAR;
        let result = pathfinder_a_star(
            state,
            start_cell_gx,
            start_cell_gy,
            goal_cell_gx,
            goal_cell_gy,
            traversal,
            cost_profile,
        );
        if let Some(result) = &result {
            state.last_fine_expanded_nodes = result.expanded_nodes;
            state.last_fine_hit_node_limit = result.hit_node_limit;
        }
        result
    };
    let a_star_result = match a_star_result {
        Some(r) => r,
        None => {
            if direct_cost.is_some() {
                state.waypoint_scratch.push(raw_goal_x);
                state.waypoint_scratch.push(raw_goal_y);
                state.last_result_status = if goal_was_snapped {
                    PATHFINDER_RESULT_SNAPPED
                } else {
                    PATHFINDER_RESULT_COMPLETE
                };
                state.last_search_strategy = PATHFINDER_SEARCH_DIRECT;
                return 1;
            }
            state.waypoint_scratch.push(start_x);
            state.waypoint_scratch.push(start_y);
            return 1;
        }
    };

    if !a_star_result.reached_goal {
        // A node-limited fine search must never return a partial route when a
        // complete, physically legal straight route is already known.
        if direct_cost.is_some() {
            state.waypoint_scratch.push(raw_goal_x);
            state.waypoint_scratch.push(raw_goal_y);
            state.last_result_status = if goal_was_snapped {
                PATHFINDER_RESULT_SNAPPED
            } else {
                PATHFINDER_RESULT_COMPLETE
            };
            state.last_search_strategy = PATHFINDER_SEARCH_DIRECT;
            return 1;
        }
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
        state.last_smoothing_line_checks += 1;
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
            state.last_smoothing_line_checks += 1;
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
            state.last_smoothing_line_checks += 1;
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

/// Strategy code for the most recent query: 0 none/unreachable, 1 direct,
/// 2 hierarchical, 3 full fine-grid A*.
#[wasm_bindgen]
pub fn pathfinder_last_search_strategy() -> u32 {
    pathfinder_state().last_search_strategy
}

#[wasm_bindgen]
pub fn pathfinder_last_fine_expanded_nodes() -> u32 {
    pathfinder_state().last_fine_expanded_nodes
}

#[wasm_bindgen]
pub fn pathfinder_last_coarse_expanded_nodes() -> u32 {
    pathfinder_state().last_coarse_expanded_nodes
}

#[wasm_bindgen]
pub fn pathfinder_last_coarse_refinement_passes() -> u32 {
    pathfinder_state().last_coarse_refinement_passes
}

#[wasm_bindgen]
pub fn pathfinder_last_coarse_exact_edge_checks() -> u32 {
    pathfinder_state().last_coarse_exact_edge_checks
}

#[wasm_bindgen]
pub fn pathfinder_last_coarse_full_cluster_scans() -> u32 {
    pathfinder_state().last_coarse_full_cluster_scans
}

#[wasm_bindgen]
pub fn pathfinder_last_fine_hit_node_limit() -> u32 {
    pathfinder_state().last_fine_hit_node_limit as u32
}

#[wasm_bindgen]
pub fn pathfinder_last_smoothing_line_checks() -> u32 {
    pathfinder_state().last_smoothing_line_checks
}

#[wasm_bindgen]
pub fn pathfinder_last_direct_cost_ratio() -> f32 {
    pathfinder_state().last_direct_cost_ratio
}

/// Validate a world-space polyline against the exact traversal rules consumed
/// by direct LOS, A*, and string-pull smoothing. `points` is interleaved x/y
/// and includes the unit's current position as its first point. Validation uses
/// hard collision clearance only: a translated shared route may give up comfort
/// margin, but it may never overlap an unsupported medium, map bounds, an
/// unsupported local surface, or an illegal directed climb edge.
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
        water_surface_supported,
        water_waypoint_hold: false,
        allow_ground: move_allow_ground,
        allow_water: move_allow_water,
        allow_air: move_allow_air,
        wet_contact_required_normal_z: 0.0,
    }
    .derived();
    let waypoint_traversal = PathfinderTraversal {
        min_ground_normal_z,
        safe_ground_accel: safe_drive_accel,
        safe_water_drive_accel,
        static_friction_coefficient,
        water_surface_supported,
        water_waypoint_hold: true,
        allow_ground: waypoint_allow_ground,
        allow_water: waypoint_allow_water,
        allow_air: waypoint_allow_air,
        wet_contact_required_normal_z: 0.0,
    }
    .derived();
    state.cur_waypoint_traversal = waypoint_traversal;
    state.cur_waypoint_matches_move_domain =
        pathfinder_traversal_cell_domain_equivalent(waypoint_traversal, traversal);
    pathfinder_begin_query_transition_cache(state);
    state.line_transition_cache_enabled = true;
    state.cur_symmetric_slope = symmetric_slope;
    state.cur_unit_radius = pathfinder_query_unit_radius(unit_radius);
    state.cur_support_point_offset_z = pathfinder_query_unit_radius(support_point_offset_z);
    pathfinder_apply_query_slope_gates(
        state,
        safe_drive_accel,
        static_friction_coefficient,
        safe_water_drive_accel,
    );
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
        state.building_blocked = vec![0; n];
        state.bfs_queue = vec![0; n];
        state.terrain_blocked = vec![0; n];
        state.cc_labels = vec![0; n];
        state.blocked = vec![0; n];
        state.terrain_water = vec![0; n];
        state.terrain_submerged = vec![0; n];
        state.terrain_edge_blocked = vec![0; n];
        state.terrain_height = vec![0.0; n];
        state.terrain_normal_z = vec![1.0; n];
        state.terrain_transition_normal_z = vec![1.0; n * 4];
        state.clearance = vec![u16::MAX; n];
        state.medium_clearance = vec![u16::MAX; n];
        state.water_clearance = vec![u16::MAX; n];
        state.g_score = vec![f32::INFINITY; n];
        state.f_score = vec![f32::INFINITY; n];
        state.parent = vec![-1; n];
        state.closed = vec![0; n];
        state.visited_gen = vec![0; n];
        state.current_gen = 1;
        state.move_passability_cache = vec![0; n];
        state.waypoint_passability_cache = vec![0; n];
        state
    }

    fn ground_traversal() -> PathfinderTraversal {
        PathfinderTraversal {
            min_ground_normal_z: 0.0,
            safe_ground_accel: 0.0,
            safe_water_drive_accel: 0.0,
            static_friction_coefficient: 0.0,
            water_surface_supported: false,
            water_waypoint_hold: false,
            allow_ground: true,
            allow_water: false,
            allow_air: false,
            wet_contact_required_normal_z: 0.0,
        }
        .derived()
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
    fn terrain_triangle_overlap_does_not_group_unused_aabb_cells() {
        // The upper-right rectangle lies inside this right triangle's AABB,
        // but entirely outside the triangle itself. It represents the flat
        // build squares that used to inherit a diagonal cliff's normal.
        let sample: TerrainTriangleSample =
            (1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 10.0, 0.0, 0.0, 0.0, 10.0, 0.0);
        assert!(!terrain_triangle_touches_rect(sample, 8.0, 8.0, 9.0, 9.0));
        assert!(terrain_triangle_touches_rect(sample, 1.0, 1.0, 2.0, 2.0));
    }

    #[test]
    fn terrain_triangle_water_case_uses_only_the_clipped_cell_portion() {
        let sample: TerrainTriangleSample = (
            1.0,
            0.0,
            0.0,
            0.0,
            0.0,
            TERRAIN_WATER_LEVEL - 10.0,
            10.0,
            0.0,
            TERRAIN_WATER_LEVEL + 10.0,
            0.0,
            10.0,
            TERRAIN_WATER_LEVEL + 10.0,
        );
        let (dry_min, dry_max) = terrain_triangle_rect_height_range(sample, 4.0, 4.0, 5.0, 5.0)
            .expect("dry rectangle overlaps the triangle");
        assert!(dry_min >= TERRAIN_WATER_LEVEL);
        assert!(dry_max >= dry_min);

        let (mixed_min, mixed_max) = terrain_triangle_rect_height_range(sample, 0.0, 0.0, 5.0, 5.0)
            .expect("mixed rectangle overlaps the triangle");
        assert!(mixed_min < TERRAIN_WATER_LEVEL);
        assert!(mixed_max >= TERRAIN_WATER_LEVEL);
    }

    #[test]
    fn locomotion_climb_profile_is_limited_by_contact_grip() {
        let mut out = [0.0; 12];
        assert_eq!(
            pathfinder_compute_locomotion_climb_profile(
                1_000.0,
                0.0,
                0.5,
                1_000_000.0,
                GRAVITY,
                0.85,
                true,
                false,
                false,
                false,
                &mut out,
            ),
            1,
        );
        let expected_grip_slope = (0.5_f64 * 0.85).atan() * 180.0 / core::f64::consts::PI;
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
                0.0,
                1.0,
                0.0,
                1_000_000.0,
                GRAVITY,
                0.85,
                false,
                true,
                true,
                false,
                &mut out,
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
                0.0, 3.0, 1.0, 10_000.0, 100.0, 0.85, true, true, false, false, &mut out,
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
                    0.5, 0.4, 1.0, mass, 300.0, 0.85, true, true, false, false, out,
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
                0.2, 0.8, 1.0, 10_000.0, 100.0, 0.85, true, true, false, false, &mut out,
            ),
            1,
        );
        assert!(out[6] > out[10]);
        let expected_safe_hold = 0.85_f64.atan() * 180.0 / core::f64::consts::PI;
        assert!((out[10] - expected_safe_hold).abs() < 1.0e-9);
        assert!(out[11] > out[7]);
    }

    #[test]
    fn fluid_supported_water_ignores_lakebed_angle() {
        let mut out = [0.0_f64; 12];
        assert_eq!(
            pathfinder_compute_locomotion_climb_profile(
                0.2, 0.8, 1.0, 10_000.0, 100.0, 0.85, true, true, false, true, &mut out,
            ),
            1,
        );
        assert!(out[6].is_nan() && out[7].is_nan());
        assert!(out[10].is_nan() && out[11].is_nan());
    }

    #[test]
    fn partial_and_full_water_use_the_same_binary_water_force_case() {
        let mut state = open_test_state(1, 1);
        state.terrain_water[0] = 1;
        state.terrain_submerged[0] = 1;
        state.terrain_normal_z[0] = 0.6;
        let move_traversal = PathfinderTraversal {
            min_ground_normal_z: 0.8,
            safe_ground_accel: 100.0,
            safe_water_drive_accel: 300.0,
            static_friction_coefficient: 1.0,
            water_surface_supported: false,
            water_waypoint_hold: false,
            allow_ground: true,
            allow_water: true,
            allow_air: false,
            wet_contact_required_normal_z: 0.0,
        }
        .derived();
        assert!(pathfinder_is_cell_passable(&state, 0, move_traversal));

        let waypoint_traversal = PathfinderTraversal {
            water_waypoint_hold: true,
            ..move_traversal
        }
        .derived();
        assert!(!pathfinder_is_cell_passable(&state, 0, waypoint_traversal));

        assert!(
            pathfinder_is_cell_passable(&state, 0, move_traversal),
            "water presence applies the full water MOVE case without an immersion threshold",
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
            water_surface_supported: false,
            water_waypoint_hold: false,
            allow_ground: true,
            allow_water: false,
            allow_air: false,
            wet_contact_required_normal_z: 0.0,
        }
        .derived();
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
            water_surface_supported: false,
            water_waypoint_hold: false,
            allow_ground: true,
            allow_water: false,
            allow_air: false,
            wet_contact_required_normal_z: 0.0,
        }
        .derived();
        assert!(!pathfinder_can_step_height_delta(&state, 0, 1, traversal));
        assert!(pathfinder_can_step_height_delta(&state, 1, 0, traversal));
    }

    #[test]
    fn building_cells_block_every_non_air_medium_but_not_air() {
        let mut state = open_test_state(3, 1);
        state.building_blocked[1] = 1;
        let ground = ground_traversal();
        assert!(pathfinder_is_cell_passable(&state, 0, ground));
        assert!(!pathfinder_is_cell_passable(&state, 1, ground));
        assert!(
            pathfinder_is_cell_passable_ignoring_buildings(&state, 1, ground),
            "the cell is blocked ONLY by the building layer"
        );
        let air = PathfinderTraversal {
            min_ground_normal_z: 0.0,
            safe_ground_accel: 0.0,
            safe_water_drive_accel: 0.0,
            static_friction_coefficient: 0.0,
            water_surface_supported: false,
            water_waypoint_hold: false,
            allow_ground: false,
            allow_water: false,
            allow_air: true,
            wet_contact_required_normal_z: 0.0,
        }
        .derived();
        assert!(
            pathfinder_is_cell_passable(&state, 1, air),
            "air traversal overflies building footprints"
        );
    }

    #[test]
    fn building_escape_is_one_way() {
        let mut state = open_test_state(3, 1);
        state.building_blocked[1] = 1;
        state.cur_waypoint_traversal = ground_traversal();
        let ground = ground_traversal();
        assert!(
            pathfinder_can_step_between(&state, 1, 0, ground),
            "a unit standing in a fresh footprint may step out"
        );
        assert!(
            !pathfinder_can_step_between(&state, 0, 1, ground),
            "no step may ever enter a building cell"
        );
    }

    #[test]
    fn building_sync_rebuilds_clearance_and_components() {
        let mut state = open_test_state(5, 3);
        // A full-height building wall down the middle column severs the map.
        for gy in 0..3 {
            state.building_blocked[(gy * 5 + 2) as usize] = 1;
        }
        pathfinder_rebuild_blocked_clearance_and_components(&mut state);
        assert_eq!(
            state.clearance[(1 * 5 + 2) as usize],
            0,
            "wall cell has no clearance"
        );
        assert_eq!(state.medium_clearance[(1 * 5 + 2) as usize], 0);
        assert_eq!(
            state.cc_labels[(1 * 5 + 2) as usize],
            0,
            "wall cells join no component"
        );
        let left = state.cc_labels[(1 * 5 + 0) as usize];
        let right = state.cc_labels[(1 * 5 + 4) as usize];
        assert!(left != 0 && right != 0);
        assert_ne!(left, right, "the wall splits the grid into two components");
        // Removing the wall re-merges the components.
        for gy in 0..3 {
            state.building_blocked[(gy * 5 + 2) as usize] = 0;
        }
        pathfinder_rebuild_blocked_clearance_and_components(&mut state);
        assert_eq!(
            state.cc_labels[(1 * 5 + 0) as usize],
            state.cc_labels[(1 * 5 + 4) as usize],
        );
    }

    #[test]
    fn shallow_water_is_fordable_ground_up_to_the_collision_radius() {
        let mut state = open_test_state(3, 1);
        // Middle cell: wet, 8 units deep. A ground-only unit of radius 12
        // keeps its center above the water plane there — valid route AND
        // valid stand; at radius 6 the same cell stays a foreign medium.
        state.terrain_water[1] = 1;
        state.terrain_height[1] = (TERRAIN_WATER_LEVEL - 8.0) as f32;
        let dry_only = PathfinderTraversal {
            min_ground_normal_z: 0.0,
            safe_ground_accel: 100.0,
            safe_water_drive_accel: 0.0,
            static_friction_coefficient: 0.85,
            water_surface_supported: false,
            water_waypoint_hold: false,
            allow_ground: true,
            allow_water: false,
            allow_air: false,
            wet_contact_required_normal_z: 0.0,
        }
        .derived();
        state.cur_unit_radius = 12.0;
        assert!(pathfinder_is_cell_passable(&state, 1, dry_only));
        state.cur_unit_radius = 6.0;
        assert!(!pathfinder_is_cell_passable(&state, 1, dry_only));
        // An authored support offset (the runtime's true resting origin
        // height) overrides the sphere-resting fallback.
        state.cur_support_point_offset_z = 9.0;
        assert!(pathfinder_is_cell_passable(&state, 1, dry_only));
        // Radius-less queries keep the legacy binary water gate even with an
        // offset: the radius is what declares a physical body.
        state.cur_unit_radius = 0.0;
        assert!(!pathfinder_is_cell_passable(&state, 1, dry_only));
    }

    #[test]
    fn planner_water_credit_scales_with_immersion() {
        let mut state = open_test_state(2, 1);
        state.terrain_water[0] = 1;
        state.terrain_water[1] = 1;
        // Bed 2·r below the waterline: body fully submerged, full credit.
        state.cur_unit_radius = 10.0;
        state.terrain_height[0] = (TERRAIN_WATER_LEVEL - 20.0) as f32;
        assert!((pathfinder_cell_water_case_scale(&state, 0) - 1.0).abs() < 1e-12);
        // Bed exactly at the waterline: resting body entirely above, none.
        state.terrain_height[1] = TERRAIN_WATER_LEVEL as f32;
        assert!(pathfinder_cell_water_case_scale(&state, 1).abs() < 1e-12);
        // Ankle-deep (r/2): a thin cap of displaced volume, far below half.
        state.terrain_height[1] = (TERRAIN_WATER_LEVEL - 5.0) as f32;
        let shallow = pathfinder_cell_water_case_scale(&state, 1);
        assert!(shallow > 0.0 && shallow < 0.2, "got {shallow}");
        // Radius-less queries keep the legacy full credit.
        state.cur_unit_radius = 0.0;
        assert!((pathfinder_cell_water_case_scale(&state, 1) - 1.0).abs() < 1e-12);
    }

    #[test]
    fn boundary_cliffs_are_not_descent_routes() {
        let mut state = open_test_state(2, 1);
        // Both interiors flat; the 80°-wall face lies exactly on the shared
        // boundary and is recorded only in the transition normal.
        state.terrain_transition_normal_z[0] = 0.17;
        let treads = PathfinderTraversal {
            min_ground_normal_z: 0.0,
            safe_ground_accel: 100.0,
            safe_water_drive_accel: 0.0,
            static_friction_coefficient: 0.85,
            water_surface_supported: false,
            water_waypoint_hold: false,
            allow_ground: true,
            allow_water: false,
            allow_air: false,
            wet_contact_required_normal_z: 0.0,
        }
        .derived();
        pathfinder_apply_query_slope_gates(&mut state, 100.0, 0.85, 0.0);
        assert!(
            !pathfinder_can_step_height_delta(&state, 0, 1, treads),
            "walking off a boundary lip is a fall, not a route"
        );
        assert!(!pathfinder_can_step_height_delta(&state, 1, 0, treads));
    }

    #[test]
    fn descent_is_gated_by_grip_not_climb_authority() {
        let mut state = open_test_state(2, 1);
        // 10-unit drop over the 20-unit cell pitch ≈ 26.6°: chord normal
        // 0.894. Treads (μ 0.85, hold normal 0.762) may ride it down;
        // wheels at μ 0.3 (hold normal 0.958) may not.
        state.terrain_height[1] = -10.0;
        let base = PathfinderTraversal {
            min_ground_normal_z: 0.0,
            safe_ground_accel: 100.0,
            safe_water_drive_accel: 0.0,
            static_friction_coefficient: 0.85,
            water_surface_supported: false,
            water_waypoint_hold: false,
            allow_ground: true,
            allow_water: false,
            allow_air: false,
            wet_contact_required_normal_z: 0.0,
        };
        let grippy = base.derived();
        pathfinder_apply_query_slope_gates(&mut state, 100.0, 0.85, 0.0);
        assert!(pathfinder_can_step_height_delta(&state, 0, 1, grippy));
        let slippery = PathfinderTraversal {
            static_friction_coefficient: 0.3,
            ..base
        }
        .derived();
        pathfinder_apply_query_slope_gates(&mut state, 100.0, 0.3, 0.0);
        assert!(!pathfinder_can_step_height_delta(&state, 0, 1, slippery));
    }

    #[test]
    fn unholdable_contour_edges_are_illegal_not_just_expensive() {
        let mut state = open_test_state(2, 1);
        // Two side-by-side cells on a steep face traversed along the contour:
        // equal heights (no rise gate), worst normal 0.8 → lateral hold
        // demand g·0.6 = 180. A unit with 100 safe accel and grip
        // 300·0.5·0.8 = 120 cannot hold the leg — the edge must be illegal
        // in BOTH directions, not merely cost f32::MAX.
        state.terrain_normal_z[0] = 0.8;
        state.terrain_normal_z[1] = 0.8;
        let weak = PathfinderTraversal {
            min_ground_normal_z: 0.0,
            safe_ground_accel: 100.0,
            safe_water_drive_accel: 0.0,
            static_friction_coefficient: 0.5,
            water_surface_supported: false,
            water_waypoint_hold: false,
            allow_ground: true,
            allow_water: false,
            allow_air: false,
            wet_contact_required_normal_z: 0.0,
        }
        .derived();
        pathfinder_apply_query_slope_gates(&mut state, 100.0, 0.5, 0.0);
        assert!(!pathfinder_can_step_height_delta(&state, 0, 1, weak));
        assert!(!pathfinder_can_step_height_delta(&state, 1, 0, weak));

        // A grippier unit (grip 300·2·0.8 = 480 > 180) holds the same leg.
        let strong = PathfinderTraversal {
            min_ground_normal_z: 0.0,
            safe_ground_accel: 500.0,
            safe_water_drive_accel: 0.0,
            static_friction_coefficient: 2.0,
            water_surface_supported: false,
            water_waypoint_hold: false,
            allow_ground: true,
            allow_water: false,
            allow_air: false,
            wet_contact_required_normal_z: 0.0,
        }
        .derived();
        pathfinder_apply_query_slope_gates(&mut state, 500.0, 2.0, 0.0);
        assert!(pathfinder_can_step_height_delta(&state, 0, 1, strong));
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
    fn direct_fast_path_allows_small_cost_overhead_but_not_large_detours() {
        let lower_bound = 100.0;
        assert!(pathfinder_direct_cost_within_fast_path(
            Some(lower_bound * PATHFINDING_DIRECT_PATH_MAX_COST_RATIO),
            lower_bound,
        ));
        assert!(!pathfinder_direct_cost_within_fast_path(
            Some(lower_bound * (PATHFINDING_DIRECT_PATH_MAX_COST_RATIO + 0.05)),
            lower_bound,
        ));
        assert!(!pathfinder_direct_cost_within_fast_path(None, lower_bound));
    }

    #[test]
    fn combined_neighbor_evaluation_matches_separate_legality_and_cost() {
        let mut state = open_test_state(3, 1);
        state.terrain_height[1] = 8.0;
        state.terrain_normal_z[0] = 0.94;
        state.terrain_normal_z[1] = 0.94;
        let traversal = ground_traversal();
        let profile = ground_cost_profile(GRAVITY);
        state.cur_waypoint_traversal = traversal;
        state.cur_waypoint_matches_move_domain = true;
        pathfinder_begin_query_transition_cache(&mut state);

        assert!(pathfinder_can_step_neighbor(&state, 0, 0, 1, 0, traversal));
        let separate = pathfinder_edge_cost(&state, 0, 0, 1, 0, traversal, profile);
        let combined =
            pathfinder_neighbor_cost_uncached(&mut state, 0, 0, 1, 0, traversal, profile)
                .expect("the legal uphill edge must retain a combined cost");
        assert_eq!(combined.to_bits(), separate.to_bits());
    }

    #[test]
    fn ordinary_domains_skip_waypoint_passability_cache() {
        let mut state = open_test_state(4, 1);
        let traversal = ground_traversal();
        let profile = ground_cost_profile(0.0);
        state.cur_waypoint_traversal = traversal;
        state.cur_waypoint_matches_move_domain =
            pathfinder_traversal_cell_domain_equivalent(traversal, traversal);
        pathfinder_begin_query_transition_cache(&mut state);

        assert!(
            pathfinder_neighbor_cost_uncached(&mut state, 0, 0, 1, 0, traversal, profile,)
                .is_some()
        );
        assert_eq!(state.move_passability_touched, vec![1]);
        assert!(state.waypoint_passability_touched.is_empty());
    }

    #[test]
    fn cached_transition_path_preserves_recovery_only_direction() {
        let mut state = open_test_state(2, 1);
        state.terrain_water[0] = 1;
        let move_traversal = PathfinderTraversal {
            allow_water: true,
            ..ground_traversal()
        }
        .derived();
        let waypoint_traversal = ground_traversal();
        state.cur_waypoint_traversal = waypoint_traversal;
        state.cur_waypoint_matches_move_domain = false;
        pathfinder_begin_query_transition_cache(&mut state);

        assert!(
            pathfinder_can_step_between_cached(&mut state, 0, 1, move_traversal),
            "a displaced unit may leave its recovery-only water cell",
        );
        assert!(
            !pathfinder_can_step_between_cached(&mut state, 1, 0, move_traversal),
            "a unit in its waypoint domain may not voluntarily re-enter recovery-only water",
        );
    }

    #[test]
    fn repeated_line_refinement_reuses_directed_transition_costs() {
        let mut state = open_test_state(16, 1);
        let traversal = ground_traversal();
        let profile = ground_cost_profile(0.0);
        state.cur_waypoint_traversal = traversal;
        state.cur_waypoint_matches_move_domain = true;
        pathfinder_begin_query_transition_cache(&mut state);
        state.line_transition_cache_enabled = true;
        let start = pathfinder_cell_center(1, 0);
        let goal = pathfinder_cell_center(14, 0);

        let first = pathfinder_line_cost(
            &mut state, start.0, start.1, goal.0, goal.1, traversal, profile,
        );
        let first_misses = state.line_transition_cache_misses;
        assert!(first.is_some() && first_misses > 0);
        let second = pathfinder_line_cost(
            &mut state, start.0, start.1, goal.0, goal.1, traversal, profile,
        );
        assert_eq!(second.map(f32::to_bits), first.map(f32::to_bits));
        assert_eq!(state.line_transition_cache_misses, first_misses);
        assert_eq!(state.line_transition_cache_hits, first_misses);
    }

    #[test]
    fn hierarchical_search_crosses_a_large_open_grid_with_few_abstract_nodes() {
        let mut state = open_test_state(256, 256);
        let traversal = ground_traversal();
        state.cur_waypoint_traversal = traversal;
        let profile = ground_cost_profile(0.0);
        let (start_x, start_y) = pathfinder_cell_center(1, 1);
        let (goal_x, goal_y) = pathfinder_cell_center(254, 254);
        let result = pathfinder_hierarchical_a_star(
            &mut state, 1, 1, 254, 254, start_x, start_y, goal_x, goal_y, traversal, profile,
        )
        .expect("the open level-1 graph must connect opposite corners");
        assert!(
            result.expanded_nodes <= 16,
            "expanded {}",
            result.expanded_nodes
        );
        assert!(!state.path_scratch.is_empty());
        assert_eq!(
            *state.path_scratch.last().unwrap(),
            (254 * state.grid_w + 254) as u32,
        );

        let mut previous = (start_x, start_y);
        let hierarchy_path = state.path_scratch.clone();
        for fine_idx in hierarchy_path {
            let fine_idx = fine_idx as i32;
            let gx = fine_idx % state.grid_w;
            let gy = (fine_idx - gx) / state.grid_w;
            let next = pathfinder_cell_center(gx, gy);
            assert!(pathfinder_line_cost(
                &mut state, previous.0, previous.1, next.0, next.1, traversal, profile,
            )
            .is_some());
            previous = next;
        }
    }

    #[test]
    fn hierarchical_search_never_invents_an_edge_through_a_blocked_wall() {
        let mut state = open_test_state(256, 256);
        for gy in 0..state.grid_h {
            state.terrain_water[(gy * state.grid_w + 128) as usize] = 1;
        }
        let traversal = ground_traversal();
        state.cur_waypoint_traversal = traversal;
        let profile = ground_cost_profile(0.0);
        let (start_x, start_y) = pathfinder_cell_center(1, 128);
        let (goal_x, goal_y) = pathfinder_cell_center(254, 128);
        assert!(pathfinder_hierarchical_a_star(
            &mut state, 1, 128, 254, 128, start_x, start_y, goal_x, goal_y, traversal, profile,
        )
        .is_none());
    }

    #[test]
    fn hierarchical_boundary_connectivity_routes_to_a_distant_wall_gap() {
        let mut state = open_test_state(256, 256);
        for gy in 0..state.grid_h {
            if !(224..=231).contains(&gy) {
                state.terrain_water[(gy * state.grid_w + 128) as usize] = 1;
            }
        }
        let traversal = ground_traversal();
        state.cur_waypoint_traversal = traversal;
        state.cur_waypoint_matches_move_domain = true;
        pathfinder_begin_query_transition_cache(&mut state);
        state.line_transition_cache_enabled = true;
        let profile = ground_cost_profile(0.0);
        let (start_x, start_y) = pathfinder_cell_center(1, 1);
        let (goal_x, goal_y) = pathfinder_cell_center(254, 254);
        let result = pathfinder_hierarchical_a_star(
            &mut state, 1, 1, 254, 254, start_x, start_y, goal_x, goal_y, traversal, profile,
        )
        .expect("coarse boundary connectivity must route toward the only wall opening");
        assert!(result.expanded_nodes > 0);
        assert!(state.path_scratch.iter().any(|&idx| {
            let idx = idx as i32;
            idx % state.grid_w >= 128 && idx / state.grid_w >= 224
        }));
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
            water_surface_supported: false,
            water_waypoint_hold: false,
            allow_ground: true,
            allow_water: true,
            allow_air: false,
            wet_contact_required_normal_z: 0.0,
        }
        .derived();
        let profile = ground_cost_profile(GRAVITY);
        assert!(
            (pathfinder_edge_cost(&state, 0, 0, 1, 0, traversal, profile) - 1.0).abs() < 1.0e-6
        );
    }

    #[test]
    fn water_only_navigation_uses_body_clearance_without_a_shore_buffer() {
        let mut state = open_test_state(7, 1);
        let traversal = PathfinderTraversal {
            min_ground_normal_z: 0.0,
            safe_ground_accel: 0.0,
            safe_water_drive_accel: 0.0,
            static_friction_coefficient: 0.0,
            water_surface_supported: false,
            water_waypoint_hold: false,
            allow_ground: false,
            allow_water: true,
            allow_air: false,
            wet_contact_required_normal_z: 0.0,
        }
        .derived();
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
            pathfinder_is_cell_passable(&state, 1, traversal),
            "the first fully wet point-size square is valid without a shoreline band"
        );

        state.cur_required_clearance = 3;
        assert!(
            !pathfinder_is_cell_passable(&state, 2, traversal),
            "physical body clearance still rejects a center too close to exposed terrain"
        );
        assert!(pathfinder_is_cell_passable(&state, 3, traversal));
        assert_eq!(pathfinder_clearance_at(&state, 3, traversal), 3);
    }

    #[test]
    fn mixed_cells_intersect_exposed_and_water_permissions() {
        let mut state = open_test_state(3, 1);
        state.terrain_water = vec![0, 1, 1];
        state.terrain_submerged = vec![0, 0, 1];

        let dry_only = ground_traversal();
        assert!(pathfinder_is_cell_passable(&state, 0, dry_only));
        assert!(!pathfinder_is_cell_passable(&state, 1, dry_only));
        assert!(!pathfinder_is_cell_passable(&state, 2, dry_only));

        let water_only = PathfinderTraversal {
            allow_ground: false,
            allow_water: true,
            ..dry_only
        }
        .derived();
        assert!(!pathfinder_is_cell_passable(&state, 0, water_only));
        assert!(!pathfinder_is_cell_passable(&state, 1, water_only));
        assert!(pathfinder_is_cell_passable(&state, 2, water_only));

        let amphibious = PathfinderTraversal {
            allow_water: true,
            ..dry_only
        }
        .derived();
        assert!(pathfinder_is_cell_passable(&state, 0, amphibious));
        assert!(pathfinder_is_cell_passable(&state, 1, amphibious));
        assert!(pathfinder_is_cell_passable(&state, 2, amphibious));

        let air_only = PathfinderTraversal {
            allow_ground: false,
            allow_air: true,
            ..dry_only
        }
        .derived();
        // Airborne traversal overflies both surface media: water squares are
        // as routable as exposed terrain, without granting the water medium.
        assert!(pathfinder_is_cell_passable(&state, 0, air_only));
        assert!(pathfinder_is_cell_passable(&state, 1, air_only));
        assert!(pathfinder_is_cell_passable(&state, 2, air_only));

        let air_and_water = PathfinderTraversal {
            allow_water: true,
            ..air_only
        }
        .derived();
        assert!(pathfinder_is_cell_passable(&state, 0, air_and_water));
        assert!(pathfinder_is_cell_passable(&state, 1, air_and_water));
        assert!(pathfinder_is_cell_passable(&state, 2, air_and_water));
    }

    #[test]
    fn mixed_cell_uses_the_worse_dry_and_water_slope_case() {
        let mut state = open_test_state(2, 1);
        state.terrain_water.fill(1);
        state.terrain_submerged = vec![0, 1];
        state.terrain_normal_z.fill(0.6);
        let traversal = PathfinderTraversal {
            min_ground_normal_z: 0.8,
            safe_ground_accel: 100.0,
            safe_water_drive_accel: 300.0,
            static_friction_coefficient: 1.0,
            water_surface_supported: false,
            water_waypoint_hold: false,
            allow_ground: true,
            allow_water: true,
            allow_air: false,
            wet_contact_required_normal_z: 0.0,
        }
        .derived();
        assert!(
            !pathfinder_is_cell_passable(&state, 0, traversal),
            "mixed square must retain the failing dry slope case"
        );
        assert!(
            pathfinder_is_cell_passable(&state, 1, traversal),
            "the same normal may pass when only the powered water case applies"
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
        let direct_cost =
            pathfinder_line_cost(&mut state, 10.0, 30.0, 90.0, 30.0, traversal, profile)
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
                state.terrain_water[(gy * state.grid_w + gx) as usize] = 1;
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

        state.terrain_water[1 * 3 + 2] = 1;
        assert!(!pathfinder_can_step_neighbor(&state, 1, 1, 2, 2, traversal,));
        state.terrain_water[1 * 3 + 2] = 0;
        assert!(pathfinder_can_step_neighbor(&state, 1, 1, 2, 2, traversal,));
    }
}

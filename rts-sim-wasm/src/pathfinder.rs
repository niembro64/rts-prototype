// pathfinder — A* over the terrain locomotion grid, in WASM.

#[allow(unused_imports)]
use crate::*;
#[allow(unused_imports)]
use wasm_bindgen::prelude::*;

mod edt;
mod hierarchy;
mod traversal;
#[allow(unused_imports)]
pub(crate) use edt::*;
#[allow(unused_imports)]
pub(crate) use hierarchy::*;
#[allow(unused_imports)]
pub(crate) use traversal::*;

// ─────────────────────────────────────────────────────────────────
//  Pathfinder — per-class hierarchical A* over the fine 20 wu grid
//
//  The fine grid is the single legality truth: every cell carries exact
//  clipped-triangle terrain classification, and every body is gated by an
//  exact Euclidean distance transform against its own collision radius.
//  Three layers sit on top of it:
//
//   * a per-class HPA* graph (hierarchy.rs) that answers reachability and
//     yields a CORRIDOR of clusters for a query;
//   * a corridor-restricted, resumable fine A* that finds the actual route
//     inside that corridor and never touches the rest of the map;
//   * cost-aware string pulling and a traffic-heat layer that spreads
//     repeated routes across parallel lanes.
//
//  Authoritative movement advances a query through bounded slices: cluster
//  builds, abstract expansions and fine expansions are all charged to the
//  same deterministic per-tick budget, and one unfinished search is retained
//  per ally team.
// ─────────────────────────────────────────────────────────────────

pub(crate) const PATHFINDER_BUILD_GRID_CELL_SIZE: f64 = 20.0;
pub(crate) const PATHFINDER_SNAP_RADIUS_WU: f64 = 640.0;
pub(crate) const PATHFINDER_SQRT2_MINUS_1: f32 = 0.41421356237309515;
pub(crate) const PATHFINDER_RESULT_UNREACHABLE: u32 = 0;
pub(crate) const PATHFINDER_RESULT_COMPLETE: u32 = 1;
pub(crate) const PATHFINDER_RESULT_SNAPPED: u32 = 2;
pub(crate) const PATHFINDER_RESULT_PARTIAL: u32 = 3;
pub(crate) const PATHFINDER_RESULT_PENDING: u32 = 4;
pub(crate) const PATHFINDER_SEARCH_NONE: u32 = 0;
pub(crate) const PATHFINDER_SEARCH_DIRECT: u32 = 1;
pub(crate) const PATHFINDER_SEARCH_HIERARCHICAL: u32 = 2;
/// Fine A* over the start-goal cluster box, no hierarchy: short routes never
/// pay for cluster entrances or intra-cluster cost rows.
pub(crate) const PATHFINDER_SEARCH_LOCAL: u32 = 3;
/// Widest start-goal cluster span (Chebyshev, in clusters) that searches the
/// cluster box directly instead of the hierarchy. 6 clusters of 16 cells =
/// ~1,900 wu; the box is padded by one cluster so a detour around a short
/// wall still fits. Measured 2026-08-26: a cold hierarchical route cost
/// ~20k work units (row builds), a boxed fine search a few hundred.
pub(crate) const PATHFINDER_LOCAL_ROUTE_MAX_CLUSTER_SPAN: i32 = 6;
/// Terrain-bound unit centers stay out of the outer map guard cells.
pub(crate) const PATHFINDER_MAP_EDGE_BUFFER_WU: f64 = 40.0;
const PATHFINDER_SYNC_CONTINUATION_OWNER: u32 = u32::MAX;
/// Clearance for straight segments: the body gate widened by the authored
/// line margin. Zero when the query has no clearance gate (air, point size).
#[inline]
fn pathfinder_line_required_d_sq_for_state(state: &PathfinderState, unit_radius: f64) -> f32 {
    let body = pathfinder_query_unit_radius(unit_radius);
    if body <= 0.0 {
        return 0.0;
    }
    pathfinder_required_d_sq_for_state(state, body + PATHFINDING_LINE_CLEARANCE_MARGIN_WU)
}

/// A supercover line step (passability + transition cost of one cell) costs
/// roughly an eighth of a fine A* expansion (heap push/pop plus eight
/// neighbour evaluations); smoothing work is charged at that ratio.
const SMOOTHING_CELLS_PER_WORK_UNIT: u32 = 8;

/// Cells a supercover line between two world points will visit — the
/// Chebyshev cell distance plus one — used to charge smoothing work.
fn pathfinder_line_cells_between(state: &PathfinderState, x0: f64, y0: f64, x1: f64, y1: f64) -> u32 {
    let cs = state.cell_size;
    let dx = ((x1 / cs).floor() - (x0 / cs).floor()).abs();
    let dy = ((y1 / cs).floor() - (y0 / cs).floor()).abs();
    dx.max(dy) as u32 + 1
}
/// Heat stamped on every cell of a completed authoritative route.
pub(crate) const PATHFINDER_TRAFFIC_HEAT_PER_ROUTE: u8 = 48;

/// A resumable fine search over one corridor. Node storage is CORRIDOR-LOCAL
/// (cluster rank × cells per cluster), so a retained frontier costs kilobytes
/// instead of a map-sized arena per ally team.
#[derive(Default)]
pub(crate) struct FineArena {
    /// True while the retained frontier is a boxed LOCAL search (no
    /// abstract route); false for a hierarchy corridor.
    local: bool,
    corridor: Vec<u32>,
    /// Per corridor rank: the cell where the abstract route leaves that
    /// cluster (the goal cell for the last rank), and the octile distance
    /// from there along the remaining exits to the goal. The fine A* uses
    /// octile(n, exit[rank]) + rem[rank] as its heuristic, so it follows
    /// the corridor the hierarchy already chose instead of pulling straight
    /// at a goal behind a wall and flooding the corridor.
    corridor_exits: Vec<u32>,
    corridor_rem: Vec<f32>,
    rank_of_cluster: Vec<u32>,
    g_score: Vec<f32>,
    f_score: Vec<f32>,
    parent: Vec<u32>,
    closed: Vec<u8>,
    visited_gen: Vec<u32>,
    current_gen: u32,
    heap: Vec<u32>,
    pending: Option<PendingFineAStar>,
}

pub(crate) struct PathfinderState {
    grid_w: i32,
    grid_h: i32,
    n: usize,
    map_width: f64,
    map_height: f64,
    cell_size: f64,

    blocked: Vec<u8>,
    terrain_blocked: Vec<u8>,
    terrain_water: Vec<u8>,
    terrain_submerged: Vec<u8>,
    terrain_edge_blocked: Vec<u8>,
    building_blocked: Vec<u8>,
    /// Ascending list of the cells currently blocked by buildings, so a
    /// resync diffs against O(building cells) instead of scanning the grid.
    building_blocked_cells: Vec<u32>,
    /// Per-cell generation stamp written by the latest resync; a listed
    /// cell not stamped this generation is a removal.
    building_mark_gen: Vec<u32>,
    building_gen: u32,
    building_occupancy_version: u32,
    terrain_height: Vec<f32>,
    terrain_normal_z: Vec<f32>,
    terrain_transition_normal_z: Vec<f32>,
    /// Squared Euclidean cell distance to the nearest obstacle (clamped) for
    /// the three obstacle sets: ground (water ∪ edge ∪ building), dual-medium
    /// (edge ∪ building), water-only (exposed ∪ edge ∪ building).
    edt_ground_sq: Vec<u16>,
    edt_medium_sq: Vec<u16>,
    edt_water_sq: Vec<u16>,
    edt_scratch: EdtScratch,
    /// Traffic heat: recently planned routes raise the cost of their cells so
    /// later routes spread across parallel lanes. Decayed by the caller.
    traffic_heat: Vec<u8>,

    fine_arena: FineArena,
    active_fine_a_star_owner: u32,
    saved_fine_arenas: HashMap<u32, FineArena>,

    // Hierarchy (see hierarchy.rs).
    pub(crate) hpa_cluster_w: i32,
    pub(crate) hpa_cluster_h: i32,
    pub(crate) hpa_cluster_change_stamp: Vec<u32>,
    pub(crate) hpa_stamp_counter: u32,
    pub(crate) hpa_classes: Vec<HpaClassGraph>,
    pub(crate) hpa_class_use_counter: u32,
    /// Class graphs discarded at the cache cap (telemetry, never hashed).
    pub(crate) hpa_class_evictions: u32,
    pub(crate) hpa_g: Vec<f32>,
    pub(crate) hpa_parent: Vec<u32>,
    pub(crate) hpa_gen: Vec<u32>,
    pub(crate) hpa_closed_gen: Vec<u32>,
    pub(crate) hpa_cur_gen: u32,
    pub(crate) hpa_heap: Vec<(f32, u32)>,
    pub(crate) hpa_work: u32,
    /// Reach set of the start cluster after an unreachable search (g per
    /// cluster-local cell, INFINITY = unreachable) and which cluster it is.
    pub(crate) hpa_start_reach: Vec<f32>,
    pub(crate) hpa_start_reach_cluster: u32,
    /// Last query's start/goal insertion, reused when the identical query
    /// re-enters after a Budget slice. (class, start, goal, dirty stamp).
    pub(crate) hpa_insertion_key: Option<(u32, u32, u32, u32)>,
    pub(crate) hpa_insertion_start_costs: Vec<f32>,
    pub(crate) hpa_insertion_goal_costs: Vec<f32>,
    pub(crate) cl_g: Vec<f32>,
    pub(crate) cl_gen: Vec<u32>,
    pub(crate) cl_cur_gen: u32,
    pub(crate) cl_heap: Vec<(f32, u32)>,

    // Query-local passability / transition caches.
    move_passability_cache: Vec<u8>,
    move_passability_touched: Vec<u32>,
    waypoint_passability_cache: Vec<u8>,
    waypoint_passability_touched: Vec<u32>,
    line_transition_cost_cache: HashMap<u64, f32>,
    line_transition_cache_enabled: bool,
    line_transition_cache_hits: u32,
    line_transition_cache_misses: u32,

    // Per-query traversal params.
    /// Squared required centre-to-obstacle distance (cells²) for the body.
    /// 0 for point-size/airborne queries and during start classification.
    cur_required_d_sq: f32,
    /// Clearance a straight segment (shortcut, direct plan, validation,
    /// follower corner shortcut) must keep: the body gate plus
    /// PATHFINDING_LINE_CLEARANCE_MARGIN_WU. The cell-to-cell A* step keeps
    /// the exact gate so narrow corridors stay legal; only straight lines
    /// stand off, which is what rounds corners in the delivered polyline.
    cur_line_required_d_sq: f32,
    /// True while a line walk is evaluating cells at the line clearance
    /// (folded into the transition-cost cache key; the per-cell passability
    /// cache is bypassed while set because it was filled at the body gate).
    line_margin_active: bool,
    /// The exact body gate saved while `line_margin_active`: the pocket
    /// escape rule keeps measuring "in a pocket" against the BODY, so a cell
    /// that merely sits inside the margin band is refused, not walked along.
    cur_body_required_d_sq: f32,
    cur_symmetric_slope: bool,
    cur_unit_radius: f64,
    cur_support_point_offset_z: f64,
    cur_escape_start_idx: usize,
    cur_lateral_skip_normal_z: f64,
    cur_descent_hold_normal_z: f64,
    cur_waypoint_traversal: PathfinderTraversal,
    cur_waypoint_matches_move_domain: bool,
    pub(crate) cur_heat_enabled: bool,

    terrain_only_key: u64,
    snap_offsets: Vec<(i16, i16)>,

    waypoint_scratch: Vec<f64>,
    path_scratch: Vec<u32>,
    last_result_status: u32,
    last_search_strategy: u32,
    last_fine_expanded_nodes: u32,
    last_fine_expanded_nodes_this_slice: u32,
    last_coarse_expanded_nodes: u32,
    last_hpa_work: u32,
    /// Every work unit any search has ever charged, sliced or not. Telemetry
    /// only (never hashed); the mass-move budget contract test reads it to
    /// prove a command tick cannot search more than one budget's worth.
    total_work_units: f64,
    last_corridor_clusters: u32,
    last_smoothing_line_checks: u32,
    last_direct_cost_ratio: f32,
}

#[derive(Clone, Copy, PartialEq)]
pub(crate) struct PathfinderTraversal {
    min_ground_normal_z: f32,
    safe_ground_accel: f64,
    safe_water_drive_accel: f64,
    static_friction_coefficient: f64,
    water_surface_supported: bool,
    water_waypoint_hold: bool,
    allow_ground: bool,
    allow_water: bool,
    allow_air: bool,
    wet_contact_required_normal_z: f32,
}

impl PathfinderTraversal {
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
            return 0.0;
        }
        let max_move_slope = pathfinder_max_contact_slope_rad(
            self.safe_ground_accel,
            self.safe_water_drive_accel,
            self.static_friction_coefficient,
            GRAVITY,
        );
        let mut water_required = max_move_slope.cos();
        if self.water_waypoint_hold {
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
    left.allow_ground == right.allow_ground
        && left.allow_water == right.allow_water
        && left.allow_air == right.allow_air
        && pathfinder_required_normal_z(left.min_ground_normal_z)
            == pathfinder_required_normal_z(right.min_ground_normal_z)
        && left.wet_contact_required_normal_z == right.wet_contact_required_normal_z
}

/// Query-local route objective. The wrapper reduces force/mass/grip physics
/// to flat acceleration; A* only knows how that capability changes travel
/// time over terrain.
#[derive(Clone, Copy, PartialEq)]
pub(crate) struct PathfinderCostProfile {
    flat_drive_accel: f64,
    safe_drive_accel: f64,
    flat_water_contact_accel: f64,
    safe_water_drive_accel: f64,
    static_friction_coefficient: f64,
    /// Required centre-to-obstacle distance in cells (radius/cell + 0.5).
    required_d_cells: f32,
    soft_clearance_cells: f32,
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
        required_d_cells: f32,
    ) -> Self {
        let positive = |v: f64| if v.is_finite() && v > 0.0 { v } else { 0.0 };
        Self {
            flat_drive_accel: positive(flat_drive_accel),
            safe_drive_accel: positive(safe_drive_accel),
            flat_water_contact_accel: positive(flat_water_contact_accel),
            safe_water_drive_accel: positive(safe_water_drive_accel),
            static_friction_coefficient: positive(static_friction_coefficient),
            required_d_cells,
            soft_clearance_cells: PATHFINDING_SOFT_CLEARANCE_CELLS.max(0) as f32,
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
            required_d_cells: 0.0,
            soft_clearance_cells: 0.0,
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
            cell_size: PATHFINDER_BUILD_GRID_CELL_SIZE,
            blocked: Vec::new(),
            terrain_blocked: Vec::new(),
            terrain_water: Vec::new(),
            terrain_submerged: Vec::new(),
            terrain_edge_blocked: Vec::new(),
            building_blocked: Vec::new(),
            building_blocked_cells: Vec::new(),
            building_mark_gen: Vec::new(),
            building_gen: 0,
            building_occupancy_version: 0,
            terrain_height: Vec::new(),
            terrain_normal_z: Vec::new(),
            terrain_transition_normal_z: Vec::new(),
            edt_ground_sq: Vec::new(),
            edt_medium_sq: Vec::new(),
            edt_water_sq: Vec::new(),
            edt_scratch: EdtScratch::default(),
            traffic_heat: Vec::new(),
            fine_arena: FineArena::default(),
            active_fine_a_star_owner: PATHFINDER_SYNC_CONTINUATION_OWNER,
            saved_fine_arenas: HashMap::default(),
            hpa_cluster_w: 0,
            hpa_cluster_h: 0,
            hpa_cluster_change_stamp: Vec::new(),
            hpa_stamp_counter: 0,
            hpa_classes: Vec::new(),
            hpa_class_use_counter: 0,
            hpa_class_evictions: 0,
            hpa_g: Vec::new(),
            hpa_parent: Vec::new(),
            hpa_gen: Vec::new(),
            hpa_closed_gen: Vec::new(),
            hpa_cur_gen: 0,
            hpa_heap: Vec::new(),
            hpa_work: 0,
            hpa_start_reach: Vec::new(),
            hpa_start_reach_cluster: u32::MAX,
            hpa_insertion_key: None,
            hpa_insertion_start_costs: Vec::new(),
            hpa_insertion_goal_costs: Vec::new(),
            cl_g: Vec::new(),
            cl_gen: Vec::new(),
            cl_cur_gen: 0,
            cl_heap: Vec::new(),
            move_passability_cache: Vec::new(),
            move_passability_touched: Vec::new(),
            waypoint_passability_cache: Vec::new(),
            waypoint_passability_touched: Vec::new(),
            line_transition_cost_cache: HashMap::default(),
            line_transition_cache_enabled: false,
            line_transition_cache_hits: 0,
            line_transition_cache_misses: 0,
            cur_required_d_sq: 0.0,
            cur_line_required_d_sq: 0.0,
            line_margin_active: false,
            cur_body_required_d_sq: 0.0,
            cur_symmetric_slope: false,
            cur_unit_radius: 0.0,
            cur_support_point_offset_z: 0.0,
            cur_escape_start_idx: usize::MAX,
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
            cur_heat_enabled: false,
            terrain_only_key: u64::MAX,
            snap_offsets: Vec::new(),
            waypoint_scratch: Vec::new(),
            path_scratch: Vec::new(),
            last_result_status: PATHFINDER_RESULT_UNREACHABLE,
            last_search_strategy: PATHFINDER_SEARCH_NONE,
            last_fine_expanded_nodes: 0,
            last_fine_expanded_nodes_this_slice: 0,
            last_coarse_expanded_nodes: 0,
            last_hpa_work: 0,
            total_work_units: 0.0,
            last_corridor_clusters: 0,
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

fn pathfinder_switch_fine_arena(state: &mut PathfinderState, owner: u32) {
    if state.active_fine_a_star_owner == owner {
        return;
    }
    let previous_owner = state.active_fine_a_star_owner;
    let previous = std::mem::take(&mut state.fine_arena);
    state.saved_fine_arenas.insert(previous_owner, previous);
    let next = state.saved_fine_arenas.remove(&owner).unwrap_or_default();
    state.fine_arena = next;
    state.active_fine_a_star_owner = owner;
}

fn pathfinder_invalidate_all_fine_arenas(state: &mut PathfinderState) {
    state.fine_arena.pending = None;
    state.saved_fine_arenas.clear();
}

/// Drop only the retained frontiers whose corridor contains a cluster that
/// the changed cells can influence (the same reach `hpa_mark_dirty_cells`
/// stamps). Frontiers over untouched corridors resume unchanged.
fn pathfinder_invalidate_fine_arenas_touching(
    state: &mut PathfinderState,
    added: &[u32],
    removed: &[u32],
) {
    if state.hpa_cluster_w <= 0 || (added.is_empty() && removed.is_empty()) {
        return;
    }
    let cluster_count = state.hpa_cluster_change_stamp.len();
    let mut touched = vec![false; cluster_count];
    let c = hpa_cluster_size();
    let reach = EDT_CLAMP_CELLS + 1;
    let mut any = false;
    for cells in [added, removed] {
        for &cell in cells {
            let cell = cell as i32;
            let gx = cell % state.grid_w;
            let gy = cell / state.grid_w;
            let cx0 = ((gx - reach).max(0)) / c;
            let cx1 = ((gx + reach).min(state.grid_w - 1)) / c;
            let cy0 = ((gy - reach).max(0)) / c;
            let cy1 = ((gy + reach).min(state.grid_h - 1)) / c;
            for cy in cy0..=cy1 {
                for cx in cx0..=cx1 {
                    let index = (cy * state.hpa_cluster_w + cx) as usize;
                    if index < cluster_count {
                        touched[index] = true;
                        any = true;
                    }
                }
            }
        }
    }
    if !any {
        return;
    }
    let corridor_touched = |arena: &FineArena| -> bool {
        arena.pending.is_some()
            && arena
                .corridor
                .iter()
                .any(|&cluster| (cluster as usize) < cluster_count && touched[cluster as usize])
    };
    if corridor_touched(&state.fine_arena) {
        state.fine_arena.pending = None;
    }
    for arena in state.saved_fine_arenas.values_mut() {
        if corridor_touched(arena) {
            arena.pending = None;
        }
    }
}

pub(crate) fn pathfinder_build_snap_offsets(state: &mut PathfinderState) {
    let r = (PATHFINDER_SNAP_RADIUS_WU / state.cell_size).ceil().max(1.0) as i32;
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
    pathfinder_invalidate_all_fine_arenas(state);
    let cell_size = PATHFINDER_BUILD_GRID_CELL_SIZE;
    let grid_w = (map_width / cell_size).ceil() as i32;
    let grid_h = (map_height / cell_size).ceil() as i32;
    let n = (grid_w * grid_h) as usize;
    if state.grid_w == grid_w && state.grid_h == grid_h && state.n == n {
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
    state.cell_size = cell_size;
    for layer in [
        &mut state.blocked,
        &mut state.terrain_blocked,
        &mut state.terrain_water,
        &mut state.terrain_submerged,
        &mut state.terrain_edge_blocked,
        &mut state.building_blocked,
        &mut state.traffic_heat,
        &mut state.move_passability_cache,
        &mut state.waypoint_passability_cache,
    ] {
        layer.clear();
        layer.resize(n, 0);
    }
    state.building_occupancy_version = 0;
    state.building_blocked_cells.clear();
    state.building_mark_gen.clear();
    state.building_mark_gen.resize(n, 0);
    state.building_gen = 0;
    state.terrain_height.clear();
    state.terrain_height.resize(n, TERRAIN_WATER_LEVEL as f32 + 1.0);
    state.terrain_normal_z.clear();
    state.terrain_normal_z.resize(n, 1.0);
    state.terrain_transition_normal_z.clear();
    state.terrain_transition_normal_z.resize(n * 4, 1.0);
    for edt in [
        &mut state.edt_ground_sq,
        &mut state.edt_medium_sq,
        &mut state.edt_water_sq,
    ] {
        edt.clear();
        edt.resize(n, EDT_CLAMP_SQ);
    }
    state.fine_arena = FineArena::default();
    state.active_fine_a_star_owner = PATHFINDER_SYNC_CONTINUATION_OWNER;
    state.saved_fine_arenas.clear();
    state.move_passability_touched.clear();
    state.waypoint_passability_touched.clear();
    state.line_transition_cost_cache.clear();
    state.line_transition_cache_enabled = false;
    state.path_scratch.clear();
    state.terrain_only_key = u64::MAX;
    hpa_reset_layout(state);
    pathfinder_build_snap_offsets(state);
}

/// Sample raw terrain mesh height + surface normal nz at world (x, y).
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
    let ux = bx - ax;
    let uy = bh - ah;
    let uz = bz - az;
    let vx_ = cx - ax;
    let vy = ch - ah;
    let vz = cz - az;
    let nx = uy * vz - uz * vy;
    let mut vertical = uz * vx_ - ux * vz;
    let nz = ux * vy - uy * vx_;
    if vertical < 0.0 {
        vertical = -vertical;
    }
    let len_sq = nx * nx + vertical * vertical + nz * nz;
    let len = if len_sq > 0.0 { len_sq.sqrt() } else { 1.0 };
    let normal_z = (vertical / len) as f32;
    (h, normal_z)
}

#[inline]
pub(crate) fn pathfinder_sample_cell_terrain(
    gx: i32,
    gy: i32,
    cell_size: f64,
) -> (bool, bool, f32, f32, [f32; 8]) {
    let cs = cell_size;
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
    let key = ((terrain_version as u64) << 32) ^ ((state.grid_w as u64) << 14) ^ state.grid_h as u64;
    if key == state.terrain_only_key {
        return;
    }
    pathfinder_invalidate_all_fine_arenas(state);

    let grid_w = state.grid_w;
    let grid_h = state.grid_h;
    let n = state.n;
    let mut water_mask: Vec<u8> = vec![0u8; n];
    let mut submerged_mask: Vec<u8> = vec![0u8; n];
    let mut boundary_heights: Vec<[f32; 8]> = vec![[0.0; 8]; n];
    for gy in 0..grid_h {
        for gx in 0..grid_w {
            let idx = (gy * grid_w + gx) as usize;
            let (has_water, fully_submerged, nz, height, cell_boundary_heights) =
                pathfinder_sample_cell_terrain(gx, gy, state.cell_size);
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

    state.terrain_blocked.copy_from_slice(&water_mask);
    let edge_buffer_cells = (PATHFINDER_MAP_EDGE_BUFFER_WU / state.cell_size).ceil().max(1.0) as i32;
    for gy in 0..grid_h {
        for gx in 0..grid_w {
            let idx = (gy * grid_w + gx) as usize;
            let edge_blocked = gx < edge_buffer_cells
                || gy < edge_buffer_cells
                || gx >= grid_w - edge_buffer_cells
                || gy >= grid_h - edge_buffer_cells;
            state.terrain_edge_blocked[idx] = if edge_blocked { 1 } else { 0 };
        }
    }

    // A terrain rebuild invalidates the building occupancy layer: TS resyncs
    // it immediately afterward.
    state.building_blocked.fill(0);
    state.building_blocked_cells.clear();
    state.building_occupancy_version = 0;
    state.traffic_heat.fill(0);

    pathfinder_rebuild_blocked_and_edt_full(state);
    hpa_invalidate_all(state);
    state.terrain_only_key = key;
}

/// Full rebuild of the aggregate blocked mask and all three distance
/// transforms. Used after terrain changes; building churn takes the
/// incremental path below.
fn pathfinder_rebuild_blocked_and_edt_full(state: &mut PathfinderState) {
    let n = state.n;
    state.blocked.copy_from_slice(&state.terrain_blocked);
    for idx in 0..n {
        if state.terrain_edge_blocked[idx] != 0 || state.building_blocked[idx] != 0 {
            state.blocked[idx] = 1;
        }
    }
    let grid_w = state.grid_w;
    let grid_h = state.grid_h;
    let blocked = std::mem::take(&mut state.blocked);
    let edge = std::mem::take(&mut state.terrain_edge_blocked);
    let building = std::mem::take(&mut state.building_blocked);
    let submerged = std::mem::take(&mut state.terrain_submerged);
    let mut scratch = std::mem::take(&mut state.edt_scratch);
    edt_build_full(&|i| blocked[i] != 0, grid_w, grid_h, &mut state.edt_ground_sq, &mut scratch);
    edt_build_full(
        &|i| edge[i] != 0 || building[i] != 0,
        grid_w,
        grid_h,
        &mut state.edt_medium_sq,
        &mut scratch,
    );
    edt_build_full(
        &|i| submerged[i] == 0 || edge[i] != 0 || building[i] != 0,
        grid_w,
        grid_h,
        &mut state.edt_water_sq,
        &mut scratch,
    );
    state.blocked = blocked;
    state.terrain_edge_blocked = edge;
    state.building_blocked = building;
    state.terrain_submerged = submerged;
    state.edt_scratch = scratch;
}

/// Replace the building occupancy layer with the given grounded 20 wu build
/// cells. Cells are diffed against the installed layer so the distance
/// transforms and hierarchy update LOCALLY; hovering structures are never
/// submitted.
#[wasm_bindgen]
pub fn pathfinder_sync_building_occupancy(cell_gx: &[i32], cell_gy: &[i32], version: u32) -> u32 {
    pathfinder_apply_building_occupancy(pathfinder_state(), cell_gx, cell_gy, version)
}

pub(crate) fn pathfinder_apply_building_occupancy(
    state: &mut PathfinderState,
    cell_gx: &[i32],
    cell_gy: &[i32],
    version: u32,
) -> u32 {
    if state.n == 0 {
        return 0;
    }
    let count = cell_gx.len().min(cell_gy.len());
    // Diff against the retained blocked-cell list, not the whole grid: a
    // one-building event used to allocate and scan every map cell twice.
    if state.building_mark_gen.len() != state.n {
        // A grid that was (re)sized without passing through init: rebuild the
        // retained list from the layer itself, once.
        state.building_mark_gen.clear();
        state.building_mark_gen.resize(state.n, 0);
        state.building_gen = 0;
        state.building_blocked_cells.clear();
        for idx in 0..state.n {
            if state.building_blocked[idx] != 0 {
                state.building_blocked_cells.push(idx as u32);
            }
        }
    }
    state.building_gen = state.building_gen.wrapping_add(1);
    if state.building_gen == 0 {
        state.building_mark_gen.fill(0);
        state.building_gen = 1;
    }
    let gen = state.building_gen;
    let mut added: Vec<u32> = Vec::new();
    for i in 0..count {
        if cell_gx[i] < 0 || cell_gy[i] < 0 || cell_gx[i] >= state.grid_w || cell_gy[i] >= state.grid_h {
            continue;
        }
        let idx = (cell_gy[i] * state.grid_w + cell_gx[i]) as usize;
        if state.building_mark_gen[idx] == gen {
            continue;
        }
        state.building_mark_gen[idx] = gen;
        if state.building_blocked[idx] == 0 {
            state.building_blocked[idx] = 1;
            added.push(idx as u32);
        }
    }
    let mut removed: Vec<u32> = Vec::new();
    let old_cells = std::mem::take(&mut state.building_blocked_cells);
    let mut kept: Vec<u32> = Vec::with_capacity(old_cells.len() + added.len());
    for &idx in &old_cells {
        if state.building_mark_gen[idx as usize] == gen {
            kept.push(idx);
        } else {
            state.building_blocked[idx as usize] = 0;
            removed.push(idx);
        }
    }
    kept.extend_from_slice(&added);
    // Ascending everywhere: the same order the old full-grid scan produced,
    // so the EDT updates and cluster dirty stamps see identical input.
    kept.sort_unstable();
    added.sort_unstable();
    removed.sort_unstable();
    state.building_blocked_cells = kept;
    state.building_occupancy_version = version;
    for &idx in &added {
        state.blocked[idx as usize] = 1;
    }
    for &idx in &removed {
        let i = idx as usize;
        state.blocked[i] = if state.terrain_blocked[i] != 0 || state.terrain_edge_blocked[i] != 0 {
            1
        } else {
            0
        };
    }
    let grid_w = state.grid_w;
    let grid_h = state.grid_h;
    if !added.is_empty() {
        edt_apply_new_obstacles(grid_w, grid_h, &added, &mut state.edt_ground_sq);
        edt_apply_new_obstacles(grid_w, grid_h, &added, &mut state.edt_medium_sq);
        edt_apply_new_obstacles(grid_w, grid_h, &added, &mut state.edt_water_sq);
    }
    if !removed.is_empty() {
        let blocked = std::mem::take(&mut state.blocked);
        let edge = std::mem::take(&mut state.terrain_edge_blocked);
        let building = std::mem::take(&mut state.building_blocked);
        let submerged = std::mem::take(&mut state.terrain_submerged);
        let mut scratch = std::mem::take(&mut state.edt_scratch);
        // One re-solve window per spatial cluster of removed cells. A single
        // window over the bounding box of ALL removals was the whole map
        // whenever two buildings died far apart in the same tick.
        let groups = pathfinder_group_cells_for_edt(grid_w, &removed);
        for group in &groups {
            edt_apply_removed_obstacles(
                &|i| blocked[i] != 0,
                grid_w,
                grid_h,
                group,
                &mut state.edt_ground_sq,
                &mut scratch,
            );
            edt_apply_removed_obstacles(
                &|i| edge[i] != 0 || building[i] != 0,
                grid_w,
                grid_h,
                group,
                &mut state.edt_medium_sq,
                &mut scratch,
            );
            edt_apply_removed_obstacles(
                &|i| submerged[i] == 0 || edge[i] != 0 || building[i] != 0,
                grid_w,
                grid_h,
                group,
                &mut state.edt_water_sq,
                &mut scratch,
            );
        }
        state.blocked = blocked;
        state.terrain_edge_blocked = edge;
        state.building_blocked = building;
        state.terrain_submerged = submerged;
        state.edt_scratch = scratch;
    }
    hpa_mark_dirty_cells(state, &added);
    hpa_mark_dirty_cells(state, &removed);
    // A retained fine frontier is corridor-local: it stays valid unless the
    // change can touch a cluster of ITS corridor. Discarding every player's
    // frontier on every footprint anywhere (the old rule) restarted long
    // searches on nearly every tick of a match with four building bots —
    // measured 2026-08-26 as the dominant cause of routes waiting > 3 s.
    pathfinder_invalidate_fine_arenas_touching(state, &added, &removed);
    1
}

/// Split removed cells (ascending) into spatially separate groups so each
/// EDT re-solve window stays local. A cell joins the first group whose
/// bounding box, expanded by twice the clearance clamp, contains it;
/// otherwise it opens a new group. Windows of different groups may overlap;
/// the windowed solve is exact and idempotent, so that only repeats work.
fn pathfinder_group_cells_for_edt(grid_w: i32, cells: &[u32]) -> Vec<Vec<u32>> {
    let gap = 2 * EDT_CLAMP_CELLS;
    let mut groups: Vec<Vec<u32>> = Vec::new();
    let mut bounds: Vec<(i32, i32, i32, i32)> = Vec::new();
    for &cell in cells {
        let cx = cell as i32 % grid_w;
        let cy = cell as i32 / grid_w;
        let mut placed = false;
        for (g, b) in bounds.iter_mut().enumerate() {
            if cx >= b.0 - gap && cx <= b.2 + gap && cy >= b.1 - gap && cy <= b.3 + gap {
                groups[g].push(cell);
                b.0 = b.0.min(cx);
                b.1 = b.1.min(cy);
                b.2 = b.2.max(cx);
                b.3 = b.3.max(cy);
                placed = true;
                break;
            }
        }
        if !placed {
            groups.push(vec![cell]);
            bounds.push((cx, cy, cx, cy));
        }
    }
    groups
}

/// Cells within which a building change can alter clearance (the EDT
/// clamp). TS reads it to decide whether a routed unit's remaining path is
/// near enough to a building change to need revalidation.
#[wasm_bindgen]
pub fn pathfinder_clearance_reach_cells() -> u32 {
    EDT_CLAMP_CELLS as u32
}

#[wasm_bindgen]
pub fn pathfinder_building_occupancy_version() -> u32 {
    pathfinder_state().building_occupancy_version
}

/// Bake the two shore-distance fields over the installed terrain mask,
/// squared and clamped exactly like the planner's clearance fields:
/// `water_sq_out[i]` is the squared cell distance from a FULLY submerged
/// cell to the nearest cell that is not (a shoreline cell, dry ground, or
/// the map-edge buffer); `land_sq_out[i]` is the squared cell distance from
/// a fully dry cell to the nearest cell touching water (or the edge buffer).
/// A cell of the other medium reads 0 in each field. Terrain only — the
/// building layer is deliberately NOT an obstacle here, so the field says
/// where the water is, not where a structure happens to stand today; the
/// build grid answers occupancy on its own. Requires the terrain mask to be
/// installed (`pathfinder_rebuild_terrain_mask_and_cc`); returns 0 until it
/// is. Both slices must hold at least grid_w * grid_h entries.
#[wasm_bindgen]
pub fn pathfinder_bake_shore_distance_sq(water_sq_out: &mut [u16], land_sq_out: &mut [u16]) -> u32 {
    let state = pathfinder_state();
    let n = state.n;
    if n == 0 || state.terrain_only_key == u64::MAX {
        return 0;
    }
    if water_sq_out.len() < n || land_sq_out.len() < n {
        return 0;
    }
    let grid_w = state.grid_w;
    let grid_h = state.grid_h;
    let water = std::mem::take(&mut state.terrain_water);
    let submerged = std::mem::take(&mut state.terrain_submerged);
    let edge = std::mem::take(&mut state.terrain_edge_blocked);
    let mut scratch = std::mem::take(&mut state.edt_scratch);
    edt_build_full(
        &|i| submerged[i] == 0 || edge[i] != 0,
        grid_w,
        grid_h,
        water_sq_out,
        &mut scratch,
    );
    edt_build_full(
        &|i| water[i] != 0 || edge[i] != 0,
        grid_w,
        grid_h,
        land_sq_out,
        &mut scratch,
    );
    state.terrain_water = water;
    state.terrain_submerged = submerged;
    state.terrain_edge_blocked = edge;
    state.edt_scratch = scratch;
    1
}


#[wasm_bindgen]
pub fn pathfinder_rebuild_terrain_mask_and_cc(terrain_version: u32) {
    let state = pathfinder_state();
    pathfinder_rebuild_terrain_mask(state, terrain_version);
}

/// Decay the traffic-heat layer: each call keeps 3/4 of every cell's heat.
/// Called by the simulation on a fixed tick cadence (deterministic).
#[wasm_bindgen]
pub fn pathfinder_decay_traffic_heat() {
    let state = pathfinder_state();
    for h in state.traffic_heat.iter_mut() {
        *h = (*h as u16 * 3 / 4) as u8;
    }
}

#[wasm_bindgen]
pub fn pathfinder_traffic_heat_ptr() -> *const u8 {
    pathfinder_state().traffic_heat.as_ptr()
}

#[inline]
#[allow(clippy::too_many_arguments)]
fn pathfinder_traversal_pair(
    min_ground_normal_z: f32,
    safe_drive_accel: f64,
    safe_water_drive_accel: f64,
    static_friction_coefficient: f64,
    water_surface_supported: bool,
    move_allow_ground: bool,
    move_allow_water: bool,
    move_allow_air: bool,
    waypoint_allow_ground: bool,
    waypoint_allow_water: bool,
    waypoint_allow_air: bool,
) -> (PathfinderTraversal, PathfinderTraversal) {
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
    (move_traversal, waypoint_traversal)
}

/// Bake the complete per-build-square WAYPOINT and MOVE domains for one unit
/// capability profile (presentation overlay; same kernel as A*).
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
    let (move_traversal, waypoint_traversal) = pathfinder_traversal_pair(
        min_ground_normal_z,
        safe_drive_accel,
        safe_water_drive_accel,
        static_friction_coefficient,
        water_surface_supported,
        move_allow_ground,
        move_allow_water,
        move_allow_air,
        waypoint_allow_ground,
        waypoint_allow_water,
        waypoint_allow_air,
    );
    let previous_required = state.cur_required_d_sq;
    let previous_unit_radius = state.cur_unit_radius;
    let previous_support_offset = state.cur_support_point_offset_z;
    state.cur_required_d_sq = if move_allow_air && waypoint_allow_air {
        0.0
    } else {
        pathfinder_required_d_sq_for_state(state, unit_radius)
    };
    state.cur_line_required_d_sq = state.cur_required_d_sq;
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
    state.cur_required_d_sq = previous_required;
    state.cur_unit_radius = previous_unit_radius;
    state.cur_support_point_offset_z = previous_support_offset;
    1
}

#[inline]
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

pub(crate) const PATHFINDER_NEIGHBOR_DX: [i32; 8] = [1, -1, 0, 0, 1, 1, -1, -1];
pub(crate) const PATHFINDER_NEIGHBOR_DY: [i32; 8] = [0, 0, 1, -1, 1, -1, 1, -1];

pub(crate) struct AStarResult {
    goal_gx: i32,
    goal_gy: i32,
    reached_goal: bool,
    expanded_nodes: u32,
}

#[derive(Clone, Copy, PartialEq)]
struct FineAStarKey {
    start_cell: u32,
    goal_cell: u32,
    class: HpaClassKey,
    terrain_only_key: u64,
}

#[derive(Clone, Copy)]
pub(crate) struct PendingFineAStar {
    key: FineAStarKey,
    start_local: u32,
    goal_local: u32,
    best_local: u32,
    best_d2: i64,
    expanded_nodes: u32,
}

enum AStarSliceOutcome {
    Pending {
        total_expanded: u32,
        expanded_this_slice: u32,
    },
    Complete {
        result: Option<AStarResult>,
        expanded_this_slice: u32,
    },
}

// ---- corridor-local arena helpers ------------------------------------------

#[inline]
fn fine_local_of_cell(state: &PathfinderState, arena: &FineArena, cell: u32) -> Option<u32> {
    let c = hpa_cluster_size();
    let gx = (cell as i32) % state.grid_w;
    let gy = (cell as i32) / state.grid_w;
    let cluster = ((gy / c) * state.hpa_cluster_w + gx / c) as usize;
    let rank = *arena.rank_of_cluster.get(cluster)?;
    if rank == u32::MAX {
        return None;
    }
    Some(rank * (c * c) as u32 + ((gy % c) * c + (gx % c)) as u32)
}

#[inline]
fn fine_cell_of_local(state: &PathfinderState, arena: &FineArena, local: u32) -> u32 {
    let c = hpa_cluster_size();
    let cc = (c * c) as u32;
    let rank = (local / cc) as usize;
    let off = (local % cc) as i32;
    let cluster = arena.corridor[rank] as i32;
    let cx = cluster % state.hpa_cluster_w;
    let cy = cluster / state.hpa_cluster_w;
    let gx = cx * c + off % c;
    let gy = cy * c + off / c;
    (gy * state.grid_w + gx) as u32
}

/// A start-goal pair close enough (in clusters) to search its cluster box
/// directly. Requires the hierarchy layout (cluster grid) to exist.
fn pathfinder_local_route_applies(state: &PathfinderState, start_idx: usize, goal_idx: usize) -> bool {
    if state.hpa_cluster_w <= 0 || state.hpa_cluster_change_stamp.is_empty() {
        return false;
    }
    let w = state.hpa_cluster_w;
    let sc = hpa_cluster_of_cell(state, start_idx as u32) as i32;
    let gc = hpa_cluster_of_cell(state, goal_idx as u32) as i32;
    let dx = (sc % w - gc % w).abs();
    let dy = (sc / w - gc / w).abs();
    dx.max(dy) <= PATHFINDER_LOCAL_ROUTE_MAX_CLUSTER_SPAN
}

/// Every cluster of the start-goal box padded by one cluster, row-major:
/// the corridor of a boxed local search.
fn pathfinder_local_corridor(state: &PathfinderState, start_idx: usize, goal_idx: usize) -> Vec<u32> {
    let w = state.hpa_cluster_w;
    let h = state.hpa_cluster_h;
    let sc = hpa_cluster_of_cell(state, start_idx as u32) as i32;
    let gc = hpa_cluster_of_cell(state, goal_idx as u32) as i32;
    let x0 = ((sc % w).min(gc % w) - 1).max(0);
    let x1 = ((sc % w).max(gc % w) + 1).min(w - 1);
    let y0 = ((sc / w).min(gc / w) - 1).max(0);
    let y1 = ((sc / w).max(gc / w) + 1).min(h - 1);
    let mut corridor = Vec::with_capacity(((x1 - x0 + 1) * (y1 - y0 + 1)) as usize);
    for cy in y0..=y1 {
        for cx in x0..=x1 {
            corridor.push((cy * w + cx) as u32);
        }
    }
    corridor
}

fn fine_arena_prepare(
    state: &PathfinderState,
    arena: &mut FineArena,
    corridor: &[u32],
    exits: &[u32],
) {
    let c = hpa_cluster_size();
    let cluster_count = state.hpa_cluster_change_stamp.len();
    if arena.rank_of_cluster.len() != cluster_count {
        arena.rank_of_cluster.clear();
        arena.rank_of_cluster.resize(cluster_count, u32::MAX);
    } else {
        for &cl in &arena.corridor {
            if (cl as usize) < cluster_count {
                arena.rank_of_cluster[cl as usize] = u32::MAX;
            }
        }
    }
    arena.corridor.clear();
    arena.corridor.extend_from_slice(corridor);
    for (rank, &cl) in arena.corridor.iter().enumerate() {
        arena.rank_of_cluster[cl as usize] = rank as u32;
    }
    arena.corridor_exits.clear();
    arena.corridor_exits.extend_from_slice(exits);
    // Pad or trim so every rank has an exit (the last exit is the goal). An
    // empty exit list (callers without an abstract route) leaves the plain
    // goal-distance heuristic in force.
    if !arena.corridor_exits.is_empty() {
        while arena.corridor_exits.len() < arena.corridor.len() {
            let last = *arena.corridor_exits.last().unwrap_or(&0);
            arena.corridor_exits.push(last);
        }
        arena.corridor_exits.truncate(arena.corridor.len());
    }
    let grid_w = state.grid_w;
    let n = arena.corridor_exits.len();
    arena.corridor_rem.clear();
    arena.corridor_rem.resize(n, 0.0);
    for i in (0..n.saturating_sub(1)).rev() {
        let a = arena.corridor_exits[i] as i32;
        let b = arena.corridor_exits[i + 1] as i32;
        arena.corridor_rem[i] = arena.corridor_rem[i + 1]
            + pathfinder_octile(a % grid_w, a / grid_w, b % grid_w, b / grid_w);
    }
    let slots = arena.corridor.len() * (c * c) as usize;
    arena.g_score.clear();
    arena.g_score.resize(slots, f32::INFINITY);
    arena.f_score.clear();
    arena.f_score.resize(slots, f32::INFINITY);
    arena.parent.clear();
    arena.parent.resize(slots, u32::MAX);
    arena.closed.clear();
    arena.closed.resize(slots, 0);
    arena.visited_gen.clear();
    arena.visited_gen.resize(slots, 0);
    arena.current_gen = 1;
    arena.heap.clear();
}

#[inline]
fn fine_heap_precedes(arena: &FineArena, left: u32, right: u32) -> bool {
    let lf = arena.f_score[left as usize];
    let rf = arena.f_score[right as usize];
    if lf != rf {
        return lf < rf;
    }
    let lg = arena.g_score[left as usize];
    let rg = arena.g_score[right as usize];
    if lg != rg {
        return lg > rg;
    }
    left < right
}

fn fine_heap_push(arena: &mut FineArena, idx: u32) {
    arena.heap.push(idx);
    let mut i = arena.heap.len() - 1;
    while i > 0 {
        let p = (i - 1) >> 1;
        if fine_heap_precedes(arena, arena.heap[i], arena.heap[p]) {
            arena.heap.swap(i, p);
            i = p;
        } else {
            break;
        }
    }
}

fn fine_heap_pop(arena: &mut FineArena) -> u32 {
    let top = arena.heap[0];
    let last = arena.heap.pop().unwrap();
    let len = arena.heap.len();
    if len > 0 {
        arena.heap[0] = last;
        let mut i = 0usize;
        loop {
            let l = (i << 1) + 1;
            let r = l + 1;
            let mut s = i;
            if l < len && fine_heap_precedes(arena, arena.heap[l], arena.heap[s]) {
                s = l;
            }
            if r < len && fine_heap_precedes(arena, arena.heap[r], arena.heap[s]) {
                s = r;
            }
            if s == i {
                break;
            }
            arena.heap.swap(i, s);
            i = s;
        }
    }
    top
}

#[inline]
fn fine_touch(arena: &mut FineArena, local: usize) {
    if arena.visited_gen[local] == arena.current_gen {
        return;
    }
    arena.visited_gen[local] = arena.current_gen;
    arena.g_score[local] = f32::INFINITY;
    arena.f_score[local] = f32::INFINITY;
    arena.parent[local] = u32::MAX;
    arena.closed[local] = 0;
}

fn pathfinder_reconstruct_a_star_path(
    state: &mut PathfinderState,
    arena: &FineArena,
    pending: PendingFineAStar,
    found: bool,
) -> Option<AStarResult> {
    let target = if found {
        pending.goal_local
    } else {
        pending.best_local
    };
    state.path_scratch.clear();
    let mut walker = target;
    while walker != pending.start_local && walker != u32::MAX {
        state.path_scratch.push(fine_cell_of_local(state, arena, walker));
        walker = arena.parent[walker as usize];
    }
    if walker == u32::MAX {
        return None;
    }
    state.path_scratch.reverse();
    let cell = fine_cell_of_local(state, arena, target) as i32;
    let gx = cell % state.grid_w;
    let gy = cell / state.grid_w;
    Some(AStarResult {
        goal_gx: gx,
        goal_gy: gy,
        reached_goal: found,
        expanded_nodes: pending.expanded_nodes,
    })
}

/// Advance one corridor-restricted fine A* by at most `expansion_budget`
/// closed nodes. Repeating the exact same query resumes the retained
/// frontier; a changed key starts fresh over the supplied corridor.
/// Corridor-guided heuristic for a cell in the fine arena: distance to its
/// cluster's exit plus the remaining exit chain to the goal, weighted.
#[inline]
fn fine_guided_heuristic(state: &PathfinderState, arena: &FineArena, gx: i32, gy: i32, ggx: i32, ggy: i32) -> f32 {
    let c = hpa_cluster_size();
    let clusters_w = (state.grid_w + c - 1) / c;
    let cluster = ((gy / c) * clusters_w + (gx / c)) as usize;
    let rank = arena.rank_of_cluster.get(cluster).copied().unwrap_or(u32::MAX);
    let guided = if (rank as usize) < arena.corridor_exits.len() {
        let exit = arena.corridor_exits[rank as usize] as i32;
        let grid_w = state.grid_w;
        pathfinder_octile(gx, gy, exit % grid_w, exit / grid_w) + arena.corridor_rem[rank as usize]
    } else {
        pathfinder_octile(gx, gy, ggx, ggy)
    };
    // Never below the plain goal distance: the exit chain can only add.
    guided.max(pathfinder_octile(gx, gy, ggx, ggy)) * PATHFINDING_CORRIDOR_HEURISTIC_WEIGHT
}

fn pathfinder_a_star_slice(
    state: &mut PathfinderState,
    key: FineAStarKey,
    corridor: &[u32],
    exits: &[u32],
    traversal: PathfinderTraversal,
    cost_profile: PathfinderCostProfile,
    expansion_budget: u32,
) -> AStarSliceOutcome {
    let grid_w = state.grid_w;
    let grid_h = state.grid_h;
    let mut arena = std::mem::take(&mut state.fine_arena);
    let mut pending = match arena.pending.take() {
        Some(pending) if pending.key == key => pending,
        _ => {
            fine_arena_prepare(state, &mut arena, corridor, exits);
            state.path_scratch.clear();
            let start_local = fine_local_of_cell(state, &arena, key.start_cell);
            let goal_local = fine_local_of_cell(state, &arena, key.goal_cell);
            let (Some(start_local), Some(goal_local)) = (start_local, goal_local) else {
                state.fine_arena = arena;
                return AStarSliceOutcome::Complete {
                    result: None,
                    expanded_this_slice: 0,
                };
            };
            fine_touch(&mut arena, start_local as usize);
            arena.g_score[start_local as usize] = 0.0;
            let sgx = (key.start_cell as i32) % grid_w;
            let sgy = (key.start_cell as i32) / grid_w;
            let ggx = (key.goal_cell as i32) % grid_w;
            let ggy = (key.goal_cell as i32) / grid_w;
            arena.f_score[start_local as usize] =
                fine_guided_heuristic(state, &arena, sgx, sgy, ggx, ggy);
            fine_heap_push(&mut arena, start_local);
            let dx = i64::from(sgx) - i64::from(ggx);
            let dy = i64::from(sgy) - i64::from(ggy);
            PendingFineAStar {
                key,
                start_local,
                goal_local,
                best_local: start_local,
                best_d2: dx * dx + dy * dy,
                expanded_nodes: 0,
            }
        }
    };
    let ggx = (key.goal_cell as i32) % grid_w;
    let ggy = (key.goal_cell as i32) / grid_w;
    let expansion_budget = expansion_budget.max(1);
    let mut expanded_this_slice = 0u32;
    let mut found = false;
    while !arena.heap.is_empty() && expanded_this_slice < expansion_budget {
        let cur = fine_heap_pop(&mut arena);
        let cur_us = cur as usize;
        if arena.closed[cur_us] != 0 {
            continue;
        }
        arena.closed[cur_us] = 1;
        pending.expanded_nodes = pending.expanded_nodes.saturating_add(1);
        expanded_this_slice += 1;
        if cur == pending.goal_local {
            found = true;
            break;
        }
        let cell = fine_cell_of_local(state, &arena, cur) as i32;
        let cgx = cell % grid_w;
        let cgy = cell / grid_w;
        let neighbor_count = if PATHFINDING_ALLOW_DIAGONAL_NEIGHBORS { 8 } else { 4 };
        for k in 0..neighbor_count {
            let nx = cgx + PATHFINDER_NEIGHBOR_DX[k];
            let ny = cgy + PATHFINDER_NEIGHBOR_DY[k];
            if nx < 0 || ny < 0 || nx >= grid_w || ny >= grid_h {
                continue;
            }
            let ncell = (ny * grid_w + nx) as u32;
            let Some(nlocal) = fine_local_of_cell(state, &arena, ncell) else {
                continue;
            };
            fine_touch(&mut arena, nlocal as usize);
            if arena.closed[nlocal as usize] != 0 {
                continue;
            }
            let Some(step_cost) =
                pathfinder_neighbor_cost_uncached(state, cgx, cgy, nx, ny, traversal, cost_profile)
            else {
                continue;
            };
            let tentative = arena.g_score[cur_us] + step_cost;
            if tentative < arena.g_score[nlocal as usize] {
                arena.parent[nlocal as usize] = cur;
                arena.g_score[nlocal as usize] = tentative;
                // Weighted A* inside the corridor: the hierarchy already chose
                // the route's shape, so a bounded-suboptimal (w × octile)
                // refinement trades a few percent of route cost for far fewer
                // expansions on sloped/heated terrain where octile alone is a
                // weak bound.
                arena.f_score[nlocal as usize] =
                    tentative + fine_guided_heuristic(state, &arena, nx, ny, ggx, ggy);
                let dx = i64::from(nx) - i64::from(ggx);
                let dy = i64::from(ny) - i64::from(ggy);
                let d2 = dx * dx + dy * dy;
                if d2 < pending.best_d2 {
                    pending.best_d2 = d2;
                    pending.best_local = nlocal;
                }
                fine_heap_push(&mut arena, nlocal);
            }
        }
    }
    if !found && !arena.heap.is_empty() {
        let total = pending.expanded_nodes;
        arena.pending = Some(pending);
        state.fine_arena = arena;
        return AStarSliceOutcome::Pending {
            total_expanded: total,
            expanded_this_slice,
        };
    }
    let result = pathfinder_reconstruct_a_star_path(state, &arena, pending, found);
    state.fine_arena = arena;
    AStarSliceOutcome::Complete {
        result,
        expanded_this_slice,
    }
}

/// Classify the querying body's start cell. The body IS there: whatever
/// makes its cell illegal — a footprint that went up under it, a shoreline
/// or cliff cell a floating hull drifted into, a slope sliver, the map-edge
/// buffer — the cell is legal to LEAVE. Such a start is an escape start:
/// `pathfinder_line_cost` exempts exactly this cell as a line's first cell,
/// and every search seeds it unconditionally. The caller has already checked
/// that the body's exact point lies in its navigation domain (a hull on dry
/// land is terminal, not an escape). Clearance-deficient starts are handled
/// by the per-step gradient rule instead (see traversal.rs). Before
/// 2026-08-26 only building-blocked starts escaped, and a hull whose centre
/// crossed into a cell with an exposed corner was terminal for good.
pub(crate) fn pathfinder_set_escape_start(
    state: &mut PathfinderState,
    start_idx: usize,
    traversal: PathfinderTraversal,
) {
    state.cur_escape_start_idx = if start_idx < state.n
        && !pathfinder_is_cell_passable(state, start_idx, traversal)
    {
        start_idx
    } else {
        usize::MAX
    };
}

/// Trace the supercover Bresenham segment used by validation and smoothing;
/// `None` means the segment is illegal.
pub(crate) fn pathfinder_line_cost(
    state: &mut PathfinderState,
    x0: f64,
    y0: f64,
    x1: f64,
    y1: f64,
    traversal: PathfinderTraversal,
    cost_profile: PathfinderCostProfile,
) -> Option<f32> {
    // A straight segment two or more cells long is a shortcut, a direct
    // plan, a validation leg or a follower corner cut: it walks its cells at
    // the line clearance (body gate + margin) so the body keeps air around
    // corners it will actually cut. Adjacent-cell steps keep the exact gate.
    let cell_size = state.cell_size;
    let span = ((x1 / cell_size).floor() - (x0 / cell_size).floor())
        .abs()
        .max(((y1 / cell_size).floor() - (y0 / cell_size).floor()).abs());
    let widen = span >= 2.0
        && !traversal.allow_air
        && state.cur_line_required_d_sq > state.cur_required_d_sq;
    if !widen {
        return pathfinder_line_cost_inner(state, x0, y0, x1, y1, traversal, cost_profile);
    }
    let exact = state.cur_required_d_sq;
    state.cur_body_required_d_sq = exact;
    state.cur_required_d_sq = state.cur_line_required_d_sq;
    state.line_margin_active = true;
    let cost = pathfinder_line_cost_inner(state, x0, y0, x1, y1, traversal, cost_profile);
    state.cur_required_d_sq = exact;
    state.line_margin_active = false;
    cost
}

#[allow(clippy::too_many_arguments)]
fn pathfinder_line_cost_inner(
    state: &mut PathfinderState,
    x0: f64,
    y0: f64,
    x1: f64,
    y1: f64,
    traversal: PathfinderTraversal,
    cost_profile: PathfinderCostProfile,
) -> Option<f32> {
    let cell_size = state.cell_size;
    let mut gx = (x0 / cell_size).floor() as i32;
    let mut gy = (y0 / cell_size).floor() as i32;
    let tgx = (x1 / cell_size).floor() as i32;
    let tgy = (y1 / cell_size).floor() as i32;
    let sx = if gx < tgx { 1 } else { -1 };
    let sy = if gy < tgy { 1 } else { -1 };
    let dx = (tgx - gx).abs();
    let dy = (tgy - gy).abs();
    let mut err = dx - dy;
    let max_steps = dx + dy + 2;
    let mut cost = 0.0f32;
    let mut first_cell = true;
    for _ in 0..max_steps {
        if gx < 0 || gy < 0 || gx >= state.grid_w || gy >= state.grid_h {
            return None;
        }
        let idx = (gy * state.grid_w + gx) as usize;
        if first_cell {
            // The first cell is where the body stands: legal ignoring the
            // clearance gate (the gradient rule governs leaving it) and, for
            // an escape start, legal outright — the body is there.
            let passable = idx == state.cur_escape_start_idx
                || pathfinder_is_cell_passable_ignoring_clearance(state, idx, traversal);
            if !passable {
                return None;
            }
        }
        first_cell = false;
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
#[cfg(test)]
pub(crate) fn pathfinder_cell_center(gx: i32, gy: i32) -> (f64, f64) {
    pathfinder_cell_center_with_size(gx, gy, PATHFINDER_BUILD_GRID_CELL_SIZE)
}

#[inline]
pub(crate) fn pathfinder_cell_center_for_state(
    state: &PathfinderState,
    gx: i32,
    gy: i32,
) -> (f64, f64) {
    pathfinder_cell_center_with_size(gx, gy, state.cell_size)
}

#[inline]
fn pathfinder_cell_center_with_size(gx: i32, gy: i32, cell_size: f64) -> (f64, f64) {
    ((gx as f64 + 0.5) * cell_size, (gy as f64 + 0.5) * cell_size)
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

fn pathfinder_finish_direct(
    state: &mut PathfinderState,
    x: f64,
    y: f64,
    goal_was_snapped: bool,
) -> u32 {
    state.waypoint_scratch.push(x);
    state.waypoint_scratch.push(y);
    state.last_result_status = if goal_was_snapped {
        PATHFINDER_RESULT_SNAPPED
    } else {
        PATHFINDER_RESULT_COMPLETE
    };
    state.last_search_strategy = PATHFINDER_SEARCH_DIRECT;
    1
}

fn pathfinder_finish_unreachable(state: &mut PathfinderState, start_x: f64, start_y: f64) -> u32 {
    state.waypoint_scratch.push(start_x);
    state.waypoint_scratch.push(start_y);
    state.last_result_status = PATHFINDER_RESULT_UNREACHABLE;
    1
}

/// Plan a path from (start_x, start_y) to (goal_x, goal_y). Smoothed
/// waypoints land in `waypoint_scratch` as interleaved (x, y) pairs; returns
/// the waypoint count (0 with PENDING status when the slice budget ran out).
#[allow(clippy::too_many_arguments)]
fn pathfinder_find_path_with_expansion_budget_inner(
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
    expansion_budget: u32,
    continuation_owner: u32,
    authoritative: bool,
) -> u32 {
    let state = pathfinder_state();
    pathfinder_switch_fine_arena(state, continuation_owner);
    state.waypoint_scratch.clear();
    state.last_result_status = PATHFINDER_RESULT_UNREACHABLE;
    state.last_search_strategy = PATHFINDER_SEARCH_NONE;
    state.last_fine_expanded_nodes = 0;
    state.last_fine_expanded_nodes_this_slice = 0;
    state.last_coarse_expanded_nodes = 0;
    state.last_hpa_work = 0;
    state.last_corridor_clusters = 0;
    state.last_smoothing_line_checks = 0;
    state.last_direct_cost_ratio = f32::NAN;
    state.hpa_work = 0;
    let (traversal, waypoint_traversal) = pathfinder_traversal_pair(
        min_ground_normal_z,
        safe_drive_accel,
        safe_water_drive_accel,
        static_friction_coefficient,
        water_surface_supported,
        move_allow_ground,
        move_allow_water,
        move_allow_air,
        waypoint_allow_ground,
        waypoint_allow_water,
        waypoint_allow_air,
    );
    state.cur_waypoint_traversal = waypoint_traversal;
    state.cur_waypoint_matches_move_domain =
        pathfinder_traversal_cell_domain_equivalent(waypoint_traversal, traversal);
    pathfinder_begin_query_transition_cache(state);
    state.cur_symmetric_slope = symmetric_slope;
    state.cur_unit_radius = pathfinder_query_unit_radius(unit_radius);
    state.cur_support_point_offset_z = pathfinder_query_unit_radius(support_point_offset_z);
    state.cur_heat_enabled = authoritative && !traversal.allow_air;
    pathfinder_apply_query_slope_gates(
        state,
        safe_drive_accel,
        static_friction_coefficient,
        safe_water_drive_accel,
    );
    let required_d_sq = if traversal.allow_air {
        0.0
    } else {
        pathfinder_required_d_sq_for_state(state, unit_radius)
    };
    let cost_profile = PathfinderCostProfile::for_query(
        flat_drive_accel,
        safe_drive_accel,
        flat_water_contact_accel,
        safe_water_drive_accel,
        static_friction_coefficient,
        required_d_sq.sqrt(),
    );
    let grid_w = state.grid_w;
    let grid_h = state.grid_h;
    if grid_w == 0 || grid_h == 0 {
        state.waypoint_scratch.push(start_x);
        state.waypoint_scratch.push(start_y);
        return 1;
    }

    let cs = state.cell_size;
    let sgx = ((start_x / cs).floor() as i32).max(0).min(grid_w - 1);
    let sgy = ((start_y / cs).floor() as i32).max(0).min(grid_h - 1);
    let ggx = ((goal_x / cs).floor() as i32).max(0).min(grid_w - 1);
    let ggy = ((goal_y / cs).floor() as i32).max(0).min(grid_h - 1);
    let start_idx = (sgy * grid_w + sgx) as usize;

    // The start is where the body IS. Its exact point must lie in the
    // body's navigation domain (a hull on dry land is terminal); its CELL
    // may be illegal — a footprint, an exposed corner, a slope sliver, the
    // edge buffer — and is then an escape start the search may leave.
    state.cur_required_d_sq = 0.0;
    state.cur_line_required_d_sq = 0.0;
    if !pathfinder_position_is_in_navigation_domain(state, start_x, start_y, traversal) {
        return pathfinder_finish_unreachable(state, start_x, start_y);
    }
    state.cur_required_d_sq = required_d_sq;
    state.cur_line_required_d_sq = if required_d_sq > 0.0 {
        pathfinder_line_required_d_sq_for_state(state, unit_radius)
    } else {
        0.0
    };
    pathfinder_set_escape_start(state, start_idx, traversal);

    // Goals must fit the physical collision disk and lie in the waypoint
    // domain; otherwise snap to the nearest such cell. Reachability is the
    // hierarchy's job below.
    let mut goal_cell_gx = ggx;
    let mut goal_cell_gy = ggy;
    let mut goal_was_snapped = false;
    let ggy_idx = (ggy * grid_w + ggx) as usize;
    if !pathfinder_position_is_in_navigation_domain(state, goal_x, goal_y, waypoint_traversal)
        || !pathfinder_is_cell_passable(state, ggy_idx, waypoint_traversal)
    {
        match pathfinder_find_nearest_open(state, ggx, ggy, waypoint_traversal) {
            Some((nx, ny)) => {
                goal_cell_gx = nx;
                goal_cell_gy = ny;
                goal_was_snapped = true;
            }
            None => return pathfinder_finish_unreachable(state, start_x, start_y),
        }
    }

    if sgx == goal_cell_gx && sgy == goal_cell_gy {
        let (x, y) = if goal_was_snapped {
            pathfinder_cell_center_for_state(state, goal_cell_gx, goal_cell_gy)
        } else {
            (goal_x, goal_y)
        };
        return pathfinder_finish_direct(state, x, y, goal_was_snapped);
    }

    // BAR-style raw move: a legal straight leg skips the planner entirely.
    let (mut raw_goal_x, mut raw_goal_y) = if goal_was_snapped {
        pathfinder_cell_center_for_state(state, goal_cell_gx, goal_cell_gy)
    } else {
        (goal_x, goal_y)
    };
    let mut direct_cost = pathfinder_line_cost(
        state,
        start_x,
        start_y,
        raw_goal_x,
        raw_goal_y,
        traversal,
        cost_profile,
    );
    let geometric_lower_bound = pathfinder_octile(sgx, sgy, goal_cell_gx, goal_cell_gy);
    if let Some(cost) = direct_cost {
        state.last_direct_cost_ratio = cost / geometric_lower_bound.max(1.0e-6);
    }
    if pathfinder_direct_cost_within_fast_path(direct_cost, geometric_lower_bound) {
        return pathfinder_finish_direct(state, raw_goal_x, raw_goal_y, goal_was_snapped);
    }

    state.line_transition_cache_enabled = true;
    let class = HpaClassKey {
        traversal,
        waypoint_traversal,
        cost_profile,
        symmetric_slope,
        unit_radius: state.cur_unit_radius,
        support_point_offset_z: state.cur_support_point_offset_z,
    };
    let make_key = |state: &PathfinderState, ggx: i32, ggy: i32| FineAStarKey {
        start_cell: start_idx as u32,
        goal_cell: (ggy * grid_w + ggx) as u32,
        class,
        terrain_only_key: state.terrain_only_key,
    };

    // Resume a retained fine frontier for the identical query without
    // touching the hierarchy again; otherwise ask the hierarchy for a
    // corridor (and for reachability).
    let mut fine_key = make_key(state, goal_cell_gx, goal_cell_gy);
    let pending_matches = state
        .fine_arena
        .pending
        .is_some_and(|pending| pending.key == fine_key);
    let resuming_local = pending_matches && state.fine_arena.local;
    let resuming = pending_matches && !state.fine_arena.local;

    // Short routes: a plain fine A* over the start-goal cluster box, no
    // hierarchy. A boxed search that reaches the goal is the route; one that
    // cannot connect inside the box (a long wall) falls through to the
    // hierarchy with what it spent charged to this slice.
    let mut local_result: Option<AStarResult> = None;
    let mut local_spent: u32 = 0;
    let goal_idx_now = (goal_cell_gy * grid_w + goal_cell_gx) as usize;
    if resuming_local
        || (!resuming && pathfinder_local_route_applies(state, start_idx, goal_idx_now))
    {
        let local_corridor: Vec<u32> = if resuming_local {
            state.fine_arena.corridor.clone()
        } else {
            pathfinder_local_corridor(state, start_idx, goal_idx_now)
        };
        state.fine_arena.local = true;
        state.last_search_strategy = PATHFINDER_SEARCH_LOCAL;
        state.last_corridor_clusters = local_corridor.len() as u32;
        match pathfinder_a_star_slice(
            state,
            fine_key,
            &local_corridor,
            &[],
            traversal,
            cost_profile,
            expansion_budget.max(1),
        ) {
            AStarSliceOutcome::Pending {
                total_expanded,
                expanded_this_slice,
            } => {
                state.last_fine_expanded_nodes = total_expanded;
                state.last_fine_expanded_nodes_this_slice = expanded_this_slice;
                state.last_result_status = PATHFINDER_RESULT_PENDING;
                return 0;
            }
            AStarSliceOutcome::Complete {
                result,
                expanded_this_slice,
            } => {
                state.fine_arena.local = false;
                local_spent = expanded_this_slice;
                if let Some(found) = result {
                    if found.reached_goal {
                        local_result = Some(found);
                    }
                }
            }
        }
    }

    let a_star_result: Option<AStarResult> = if let Some(found) = local_result {
        state.last_hpa_work = state.hpa_work;
        state.last_fine_expanded_nodes = found.expanded_nodes;
        state.last_fine_expanded_nodes_this_slice = local_spent;
        Some(found)
    } else {
    let (corridor, corridor_exits): (Vec<u32>, Vec<u32>) = if resuming {
        (state.fine_arena.corridor.clone(), state.fine_arena.corridor_exits.clone())
    } else {
        let class_idx = hpa_class_index(state, class);
        let goal_cell = (goal_cell_gy * grid_w + goal_cell_gx) as u32;
        let mut outcome = hpa_search(state, class_idx, start_idx as u32, goal_cell, expansion_budget);
        if let HpaSearchOutcome::Unreachable = outcome {
            // Snap to the nearest waypoint cell the start can actually reach
            // and route there instead (BAR: move as close as possible).
            let (nearest, flood_work) = hpa_nearest_reachable_cell(
                state,
                class_idx,
                goal_cell_gx,
                goal_cell_gy,
                waypoint_traversal,
            );
            state.hpa_work += flood_work;
            match nearest {
                Some((nx, ny)) if !(nx == sgx && ny == sgy) => {
                    goal_cell_gx = nx;
                    goal_cell_gy = ny;
                    goal_was_snapped = true;
                    let (rx, ry) = pathfinder_cell_center_for_state(state, nx, ny);
                    raw_goal_x = rx;
                    raw_goal_y = ry;
                    fine_key = make_key(state, nx, ny);
                    direct_cost = pathfinder_line_cost(
                        state,
                        start_x,
                        start_y,
                        raw_goal_x,
                        raw_goal_y,
                        traversal,
                        cost_profile,
                    );
                    outcome = hpa_search(
                        state,
                        class_idx,
                        start_idx as u32,
                        (ny * grid_w + nx) as u32,
                        expansion_budget,
                    );
                }
                Some(_) => {
                    // The nearest reachable cell is the one the body stands
                    // in: it is already as close as it can get. Resolve the
                    // order there (BAR semantics) instead of reporting a
                    // terminal start that would be retried forever.
                    state.last_hpa_work = state.hpa_work;
                    return pathfinder_finish_direct(state, start_x, start_y, true);
                }
                None => {
                    state.last_hpa_work = state.hpa_work;
                    return pathfinder_finish_unreachable(state, start_x, start_y);
                }
            }
        }
        match outcome {
            HpaSearchOutcome::Reached { corridor, exits } => (corridor, exits),
            HpaSearchOutcome::Budget => {
                state.last_hpa_work = state.hpa_work;
                state.last_fine_expanded_nodes_this_slice = state.hpa_work + local_spent;
                state.last_result_status = PATHFINDER_RESULT_PENDING;
                state.last_search_strategy = PATHFINDER_SEARCH_HIERARCHICAL;
                return 0;
            }
            HpaSearchOutcome::Unreachable => {
                state.last_hpa_work = state.hpa_work;
                return pathfinder_finish_unreachable(state, start_x, start_y);
            }
        }
    };
    state.last_hpa_work = state.hpa_work;
    state.last_corridor_clusters = corridor.len() as u32;
    state.last_search_strategy = PATHFINDER_SEARCH_HIERARCHICAL;
    let remaining_budget = expansion_budget
        .saturating_sub(state.hpa_work.saturating_add(local_spent))
        .max(1);
    match pathfinder_a_star_slice(
        state,
        fine_key,
        &corridor,
        &corridor_exits,
        traversal,
        cost_profile,
        remaining_budget,
    ) {
        AStarSliceOutcome::Pending {
            total_expanded,
            expanded_this_slice,
        } => {
            state.last_fine_expanded_nodes = total_expanded;
            state.last_fine_expanded_nodes_this_slice =
                expanded_this_slice + state.hpa_work + local_spent;
            state.last_result_status = PATHFINDER_RESULT_PENDING;
            return 0;
        }
        AStarSliceOutcome::Complete {
            result,
            expanded_this_slice,
        } => {
            state.last_fine_expanded_nodes_this_slice =
                expanded_this_slice + state.hpa_work + local_spent;
            result
        }
    }
    };
    if let Some(result) = &a_star_result {
        state.last_fine_expanded_nodes = result.expanded_nodes;
    }
    let a_star_result = match a_star_result {
        Some(r) => r,
        None => {
            if direct_cost.is_some() {
                return pathfinder_finish_direct(state, raw_goal_x, raw_goal_y, goal_was_snapped);
            }
            return pathfinder_finish_unreachable(state, start_x, start_y);
        }
    };

    if !a_star_result.reached_goal {
        if direct_cost.is_some() {
            return pathfinder_finish_direct(state, raw_goal_x, raw_goal_y, goal_was_snapped);
        }
        goal_cell_gx = a_star_result.goal_gx;
        goal_cell_gy = a_star_result.goal_gy;
        goal_was_snapped = true;
        if sgx == goal_cell_gx && sgy == goal_cell_gy {
            return pathfinder_finish_unreachable(state, start_x, start_y);
        }
        state.last_result_status = PATHFINDER_RESULT_PARTIAL;
    }
    // Traffic heat: stamp the raw A* chain so the next routes prefer a
    // parallel lane. Authoritative queries only.
    if state.cur_heat_enabled {
        for i in 0..state.path_scratch.len() {
            let idx = state.path_scratch[i] as usize;
            state.traffic_heat[idx] = state.traffic_heat[idx].saturating_add(PATHFINDER_TRAFFIC_HEAT_PER_ROUTE);
        }
    }
    // Cost-aware string pulling. Every shortcut test walks a supercover
    // line from the anchor, so a long straight stretch costs O(length) per
    // step and O(length²) over the stretch; that work is charged to the
    // slice below (one work unit per SMOOTHING_CELLS_PER_WORK_UNIT cells) so
    // the tick scheduler admits fewer routes after an expensive completion
    // instead of believing the smoothing was free.
    let mut smoothing_cells: u32 = 0;
    let mut anchor_x = start_x;
    let mut anchor_y = start_y;
    let path_len = state.path_scratch.len();
    if path_len > 1 {
        let first_idx = state.path_scratch[0] as i32;
        let (first_x, first_y) =
            pathfinder_cell_center_for_state(state, first_idx % grid_w, first_idx / grid_w);
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
            let (cand_x, cand_y) =
                pathfinder_cell_center_for_state(state, cand_idx % grid_w, cand_idx / grid_w);
            let (next_x, next_y) =
                pathfinder_cell_center_for_state(state, next_idx % grid_w, next_idx / grid_w);
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
            smoothing_cells += pathfinder_line_cells_between(state, anchor_x, anchor_y, next_x, next_y);
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
    state.last_fine_expanded_nodes_this_slice = state
        .last_fine_expanded_nodes_this_slice
        .saturating_add(smoothing_cells / SMOOTHING_CELLS_PER_WORK_UNIT);
    if goal_was_snapped {
        let (cx, cy) = pathfinder_cell_center_for_state(state, goal_cell_gx, goal_cell_gy);
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

#[allow(clippy::too_many_arguments)]
fn pathfinder_find_path_with_expansion_budget(
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
    expansion_budget: u32,
    continuation_owner: u32,
    authoritative: bool,
) -> u32 {
    let count = pathfinder_find_path_with_expansion_budget_inner(
        start_x,
        start_y,
        goal_x,
        goal_y,
        min_ground_normal_z,
        water_surface_supported,
        support_point_offset_z,
        waypoint_allow_ground,
        waypoint_allow_water,
        waypoint_allow_air,
        move_allow_ground,
        move_allow_water,
        move_allow_air,
        unit_radius,
        flat_drive_accel,
        safe_drive_accel,
        flat_water_contact_accel,
        safe_water_drive_accel,
        static_friction_coefficient,
        symmetric_slope,
        expansion_budget,
        continuation_owner,
        authoritative,
    );
    let state = pathfinder_state();
    // Every early completion (direct route, goal snapped onto the body's own
    // cell, unreachable) and every Budget return inside the abstract phase
    // records the hierarchy work it did in last_hpa_work; not all of them
    // fold it into the per-slice counter the TS scheduler charges. Before
    // this the scheduler read 0 for such a slice, charged one unit, and kept
    // admitting routes into a tick that had already spent its whole budget on
    // cluster builds. Report the larger of the two so nothing is uncharged.
    if state.last_fine_expanded_nodes_this_slice < state.last_hpa_work {
        state.last_fine_expanded_nodes_this_slice = state.last_hpa_work;
    }
    state.total_work_units += state.last_fine_expanded_nodes_this_slice as f64;
    count
}

/// Every work unit every search has charged since init (sliced searches
/// included), as a monotonic telemetry counter. Not lockstep state and never
/// hashed. Read across one fixed tick it bounds ALL pathfinding work that
/// tick did, whichever API performed it — which is what the mass-move
/// contract test asserts.
#[wasm_bindgen]
pub fn pathfinder_total_work_units() -> f64 {
    pathfinder_state().total_work_units
}

/// TEST-ONLY whole-route query: drives the budgeted slice on the reserved
/// sync owner until the search leaves PENDING. Production has no synchronous
/// search at all — see pathfinder_find_path_slice.
#[cfg(test)]
#[allow(clippy::too_many_arguments)]
pub fn pathfinder_find_path_for_tests(
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
    const TEST_SLICE_BUDGET: u32 = 8192;
    const TEST_MAX_SLICES: u32 = 5000;
    {
        let state = pathfinder_state();
        pathfinder_switch_fine_arena(state, PATHFINDER_SYNC_CONTINUATION_OWNER);
        state.fine_arena.pending = None;
    }
    for _ in 0..TEST_MAX_SLICES {
        let count = pathfinder_find_path_slice(
            start_x,
            start_y,
            goal_x,
            goal_y,
            min_ground_normal_z,
            water_surface_supported,
            support_point_offset_z,
            waypoint_allow_ground,
            waypoint_allow_water,
            waypoint_allow_air,
            move_allow_ground,
            move_allow_water,
            move_allow_air,
            unit_radius,
            flat_drive_accel,
            safe_drive_accel,
            flat_water_contact_accel,
            safe_water_drive_accel,
            static_friction_coefficient,
            symmetric_slope,
            PATHFINDER_SYNC_CONTINUATION_OWNER,
            TEST_SLICE_BUDGET,
        );
        if pathfinder_state().last_result_status != PATHFINDER_RESULT_PENDING {
            return count;
        }
    }
    panic!("pathfinder_find_path_for_tests: route did not complete within the slice ceiling");
}

/// Start or resume the exact same query, spending no more than the supplied
/// work budget (cluster builds + abstract + fine expansions). A return count
/// of zero with result status PENDING means the search is retained.
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn pathfinder_find_path_slice(
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
    continuation_owner: u32,
    expansion_budget: u32,
) -> u32 {
    pathfinder_find_path_with_expansion_budget(
        start_x,
        start_y,
        goal_x,
        goal_y,
        min_ground_normal_z,
        water_surface_supported,
        support_point_offset_z,
        waypoint_allow_ground,
        waypoint_allow_water,
        waypoint_allow_air,
        move_allow_ground,
        move_allow_water,
        move_allow_air,
        unit_radius,
        flat_drive_accel,
        safe_drive_accel,
        flat_water_contact_accel,
        safe_water_drive_accel,
        static_friction_coefficient,
        symmetric_slope,
        expansion_budget.max(1),
        continuation_owner,
        true,
    )
}

#[wasm_bindgen]
pub fn pathfinder_cancel_path_slice(continuation_owner: u32) {
    let state = pathfinder_state();
    pathfinder_switch_fine_arena(state, continuation_owner);
    state.fine_arena.pending = None;
}

#[wasm_bindgen]
pub fn pathfinder_cancel_all_path_slices() {
    pathfinder_invalidate_all_fine_arenas(pathfinder_state());
}

/// Drop every piece of QUERY-DERIVED state: traffic heat, the lazily built
/// per-class hierarchy graphs, retained frontiers. Lockstep peers must start
/// a match with identical caches — a warm hierarchy completes a route on an
/// earlier tick than a cold one (builds are charged to the budget), and warm
/// heat changes costs — so every match start and reset goes through here.
/// Terrain and building layers are untouched; they are re-derived by version.
#[wasm_bindgen]
pub fn pathfinder_reset_match_state() {
    let state = pathfinder_state();
    pathfinder_invalidate_all_fine_arenas(state);
    state.traffic_heat.fill(0);
    state.hpa_classes.clear();
    state.hpa_class_use_counter = 0;
    state.hpa_class_evictions = 0;
    state.hpa_insertion_key = None;
    hpa_invalidate_all(state);
}

#[wasm_bindgen]
pub fn pathfinder_last_result_status() -> u32 {
    pathfinder_state().last_result_status
}

/// 0 none/unreachable, 1 direct, 2 hierarchical corridor search.
#[wasm_bindgen]
pub fn pathfinder_last_search_strategy() -> u32 {
    pathfinder_state().last_search_strategy
}

#[wasm_bindgen]
pub fn pathfinder_last_fine_expanded_nodes() -> u32 {
    pathfinder_state().last_fine_expanded_nodes
}

/// Work charged this slice: fine expansions + cluster-build cells + abstract
/// expansions. This is what the per-tick budget bounds.
#[wasm_bindgen]
pub fn pathfinder_last_fine_expanded_nodes_this_slice() -> u32 {
    pathfinder_state().last_fine_expanded_nodes_this_slice
}

#[wasm_bindgen]
pub fn pathfinder_last_coarse_expanded_nodes() -> u32 {
    pathfinder_state().last_coarse_expanded_nodes
}

#[wasm_bindgen]
pub fn pathfinder_last_hpa_work() -> u32 {
    pathfinder_state().last_hpa_work
}

#[wasm_bindgen]
pub fn pathfinder_last_corridor_clusters() -> u32 {
    pathfinder_state().last_corridor_clusters
}

#[wasm_bindgen]
pub fn pathfinder_last_smoothing_line_checks() -> u32 {
    pathfinder_state().last_smoothing_line_checks
}

#[wasm_bindgen]
pub fn pathfinder_last_direct_cost_ratio() -> f32 {
    pathfinder_state().last_direct_cost_ratio
}

/// Class graphs evicted at the cache cap since match start. Telemetry only
/// (the skirmish probe reads it); a non-zero value means the cap is below
/// the number of body classes in play and searches are rebuilding rows.
#[wasm_bindgen]
pub fn pathfinder_class_graph_evictions() -> u32 {
    pathfinder_state().hpa_class_evictions
}

#[wasm_bindgen]
pub fn pathfinder_class_graph_count() -> u32 {
    pathfinder_state().hpa_classes.len() as u32
}

/// Validate a world-space polyline against the exact traversal rules
/// consumed by direct LOS, A*, and string-pull smoothing. `points` is
/// interleaved x/y and starts at the unit's current position.
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
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
    line_margin: bool,
) -> u32 {
    if points.len() < 4 || points.len() % 2 != 0 {
        return 0;
    }
    let state = pathfinder_state();
    if state.grid_w == 0 || state.grid_h == 0 {
        return 0;
    }
    let (traversal, waypoint_traversal) = pathfinder_traversal_pair(
        min_ground_normal_z,
        safe_drive_accel,
        safe_water_drive_accel,
        static_friction_coefficient,
        water_surface_supported,
        move_allow_ground,
        move_allow_water,
        move_allow_air,
        waypoint_allow_ground,
        waypoint_allow_water,
        waypoint_allow_air,
    );
    state.cur_waypoint_traversal = waypoint_traversal;
    state.cur_waypoint_matches_move_domain =
        pathfinder_traversal_cell_domain_equivalent(waypoint_traversal, traversal);
    pathfinder_begin_query_transition_cache(state);
    state.line_transition_cache_enabled = true;
    state.cur_symmetric_slope = symmetric_slope;
    state.cur_unit_radius = pathfinder_query_unit_radius(unit_radius);
    state.cur_support_point_offset_z = pathfinder_query_unit_radius(support_point_offset_z);
    state.cur_heat_enabled = false;
    pathfinder_apply_query_slope_gates(
        state,
        safe_drive_accel,
        static_friction_coefficient,
        safe_water_drive_accel,
    );
    let start_gx = ((points[0] / state.cell_size).floor() as i32)
        .max(0)
        .min(state.grid_w - 1);
    let start_gy = ((points[1] / state.cell_size).floor() as i32)
        .max(0)
        .min(state.grid_h - 1);
    let start_idx = (start_gy * state.grid_w + start_gx) as usize;
    // Same rules as the planner: full hard clearance everywhere, the first
    // cell exempt (the body stands there), leaving a tight pocket governed
    // by the per-step gradient rule, escape starts building-exempt.
    state.cur_required_d_sq = if traversal.allow_air {
        0.0
    } else {
        pathfinder_required_d_sq_for_state(state, unit_radius)
    };
    // Legality (a delivered or adopted polyline still connects) is judged at
    // the exact body gate; only a caller CHOOSING a straight segment — a
    // direct plan, the follower's corner shortcut — asks for the line margin.
    state.cur_line_required_d_sq = if line_margin && !traversal.allow_air {
        pathfinder_line_required_d_sq_for_state(state, unit_radius)
    } else {
        0.0
    };
    pathfinder_set_escape_start(state, start_idx, traversal);
    let last_x = points[points.len() - 2];
    let last_y = points[points.len() - 1];
    if !pathfinder_position_is_in_navigation_domain(state, last_x, last_y, waypoint_traversal) {
        return 0;
    }
    let last_gx = (last_x / state.cell_size).floor() as i32;
    let last_gy = (last_y / state.cell_size).floor() as i32;
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
        // Only the polyline's very first cell is the body's own cell.
        state.cur_escape_start_idx = usize::MAX;
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
mod tests;

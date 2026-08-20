// pathfinder — extracted from lib.rs (pure code motion).

#[allow(unused_imports)]
use crate::*;
#[allow(unused_imports)]
use wasm_bindgen::prelude::*;

mod hierarchy;
use hierarchy::pathfinder_hierarchical_a_star;
mod traversal;
#[allow(unused_imports)]
pub(crate) use traversal::*;

// ─────────────────────────────────────────────────────────────────
//  Phase 9 — Pathfinder: A* over the terrain locomotion grid in WASM
//
//  Mirrors src/game/sim/Pathfinder.ts. The synchronous compatibility pipeline
//  still runs inside one WASM call for tools/tests. Authoritative movement
//  retains fine-A* state and advances it through bounded WASM slices; JS stays
//  a thin wrapper that forwards traversal inputs and reads final waypoints.
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
pub(crate) const PATHFINDER_SNAP_RADIUS_WU: f64 = 640.0;
/// Resumable fine-grid A* has no artificial total-node ceiling. Authoritative
/// callers advance it with a deterministic per-tick expansion budget, so a
/// difficult route can take as many fixed ticks as it needs without turning
/// one simulation tick into a map-sized search.
pub(crate) const PATHFINDER_SQRT2_MINUS_1: f32 = 0.41421356237309515;
pub(crate) const PATHFINDER_RESULT_UNREACHABLE: u32 = 0;
pub(crate) const PATHFINDER_RESULT_COMPLETE: u32 = 1;
pub(crate) const PATHFINDER_RESULT_SNAPPED: u32 = 2;
pub(crate) const PATHFINDER_RESULT_PARTIAL: u32 = 3;
pub(crate) const PATHFINDER_RESULT_PENDING: u32 = 4;
pub(crate) const PATHFINDER_SEARCH_NONE: u32 = 0;
pub(crate) const PATHFINDER_SEARCH_DIRECT: u32 = 1;
pub(crate) const PATHFINDER_SEARCH_HIERARCHICAL: u32 = 2;
pub(crate) const PATHFINDER_SEARCH_FINE_A_STAR: u32 = 3;
pub(crate) const PATHFINDER_HIERARCHY_MAX_REFINEMENTS: u32 = 4;
/// Independent of shoreline classification. Terrain-bound unit centers stay
/// out of the outer map guard cells even for point-size developer queries.
pub(crate) const PATHFINDER_MAP_EDGE_BUFFER_WU: f64 = 40.0;
const PATHFINDER_SYNC_CONTINUATION_OWNER: u32 = u32::MAX;

struct FineAStarArena {
    g_score: Vec<f32>,
    f_score: Vec<f32>,
    parent: Vec<i32>,
    closed: Vec<u8>,
    visited_gen: Vec<u32>,
    current_gen: u32,
    heap: Vec<u32>,
    pending: Option<PendingFineAStar>,
}

impl FineAStarArena {
    fn new(n: usize) -> Self {
        Self {
            g_score: vec![f32::INFINITY; n],
            f_score: vec![f32::INFINITY; n],
            parent: vec![-1; n],
            closed: vec![0; n],
            visited_gen: vec![0; n],
            current_gen: 1,
            heap: Vec::new(),
            pending: None,
        }
    }
}

pub(crate) struct PathfinderState {
    grid_w: i32,
    grid_h: i32,
    n: usize,
    map_width: f64,
    map_height: f64,
    cell_size: f64,
    consolidation_multiplier: u32,

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
    /// Fine-grid search retained between sliced pathfinder calls. The dense
    /// scores/parents above remain the one shared arena; this small record is
    /// the continuation cursor that makes the arena resumable without
    /// duplicating map-sized memory for every queued unit.
    pending_fine_a_star: Option<PendingFineAStar>,
    /// One dense search arena per ally team. Only the selected team's arena
    /// is installed in the hot fields above; switching owners swaps vectors
    /// without copying them, so every side may retain one unfinished search.
    active_fine_a_star_owner: u32,
    saved_fine_a_star_arenas: HashMap<u32, FineAStarArena>,
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
    last_fine_expanded_nodes_this_slice: u32,
    last_coarse_expanded_nodes: u32,
    last_coarse_refinement_passes: u32,
    last_coarse_exact_edge_checks: u32,
    last_coarse_full_cluster_scans: u32,
    last_fine_hit_node_limit: bool,
    last_smoothing_line_checks: u32,
    last_direct_cost_ratio: f32,
}

#[derive(Clone, Copy, PartialEq)]
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
#[derive(Clone, Copy, PartialEq)]
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
            cell_size: PATHFINDER_BUILD_GRID_CELL_SIZE,
            consolidation_multiplier: 1,
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
            pending_fine_a_star: None,
            active_fine_a_star_owner: PATHFINDER_SYNC_CONTINUATION_OWNER,
            saved_fine_a_star_arenas: HashMap::default(),
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
            last_fine_expanded_nodes_this_slice: 0,
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

fn pathfinder_take_active_fine_arena(state: &mut PathfinderState) -> FineAStarArena {
    FineAStarArena {
        g_score: std::mem::take(&mut state.g_score),
        f_score: std::mem::take(&mut state.f_score),
        parent: std::mem::take(&mut state.parent),
        closed: std::mem::take(&mut state.closed),
        visited_gen: std::mem::take(&mut state.visited_gen),
        current_gen: state.current_gen,
        heap: std::mem::take(&mut state.heap),
        pending: state.pending_fine_a_star.take(),
    }
}

fn pathfinder_install_fine_arena(state: &mut PathfinderState, arena: FineAStarArena) {
    state.g_score = arena.g_score;
    state.f_score = arena.f_score;
    state.parent = arena.parent;
    state.closed = arena.closed;
    state.visited_gen = arena.visited_gen;
    state.current_gen = arena.current_gen;
    state.heap = arena.heap;
    state.pending_fine_a_star = arena.pending;
}

fn pathfinder_switch_fine_arena(state: &mut PathfinderState, owner: u32) {
    if state.active_fine_a_star_owner == owner {
        return;
    }
    let previous_owner = state.active_fine_a_star_owner;
    let previous = pathfinder_take_active_fine_arena(state);
    state.saved_fine_a_star_arenas.insert(previous_owner, previous);
    let next = state
        .saved_fine_a_star_arenas
        .remove(&owner)
        .unwrap_or_else(|| FineAStarArena::new(state.n));
    pathfinder_install_fine_arena(state, next);
    state.active_fine_a_star_owner = owner;
}

fn pathfinder_invalidate_all_fine_arenas(state: &mut PathfinderState) {
    state.pending_fine_a_star = None;
    state.saved_fine_a_star_arenas.clear();
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
pub fn pathfinder_init(map_width: f64, map_height: f64, consolidation_multiplier: u32) {
    let state = pathfinder_state();
    pathfinder_invalidate_all_fine_arenas(state);
    let consolidation_multiplier = consolidation_multiplier.clamp(1, 5);
    let cell_size = PATHFINDER_BUILD_GRID_CELL_SIZE * consolidation_multiplier as f64;
    let grid_w = (map_width / cell_size).ceil() as i32;
    let grid_h = (map_height / cell_size).ceil() as i32;
    let n = (grid_w * grid_h) as usize;
    if state.grid_w == grid_w
        && state.grid_h == grid_h
        && state.n == n
        && state.consolidation_multiplier == consolidation_multiplier
    {
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
    state.cell_size = cell_size;
    state.consolidation_multiplier = consolidation_multiplier;
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
    state.active_fine_a_star_owner = PATHFINDER_SYNC_CONTINUATION_OWNER;
    state.saved_fine_a_star_arenas.clear();
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
    let key = ((terrain_version as u64) << 32)
        ^ ((state.consolidation_multiplier as u64) << 28)
        ^ ((state.grid_w as u64) << 14)
        ^ state.grid_h as u64;
    if key == state.terrain_only_key {
        return;
    }
    pathfinder_invalidate_all_fine_arenas(state);

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

    // Step 2 — retain the exact per-cell water domain. There is no synthetic
    // shoreline dilation: a dry-only traversal is blocked by a cell iff that
    // cell itself contains water.
    state.terrain_blocked.copy_from_slice(&water_mask);
    for gy in 0..grid_h {
        for gx in 0..grid_w {
            let idx = (gy * grid_w + gx) as usize;
            let edge_buffer_cells =
                (PATHFINDER_MAP_EDGE_BUFFER_WU / state.cell_size).ceil().max(1.0) as i32;
            let edge_blocked = gx < edge_buffer_cells
                || gy < edge_buffer_cells
                || gx >= grid_w - edge_buffer_cells
                || gy >= grid_h - edge_buffer_cells;
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

fn pathfinder_mark_consolidated_building_cells(
    state: &mut PathfinderState,
    cell_gx: &[i32],
    cell_gy: &[i32],
) {
    let count = cell_gx.len().min(cell_gy.len());
    for i in 0..count {
        // Inputs are canonical 20-wu build cells. Any occupied build square
        // rejects its entire conservative path cell; negative build indices
        // must be rejected before Rust's truncating integer division.
        if cell_gx[i] < 0 || cell_gy[i] < 0 {
            continue;
        }
        let gx = cell_gx[i] / state.consolidation_multiplier as i32;
        let gy = cell_gy[i] / state.consolidation_multiplier as i32;
        if gx >= state.grid_w || gy >= state.grid_h {
            continue;
        }
        state.building_blocked[(gy * state.grid_w + gx) as usize] = 1;
    }
}

/// Replace the building occupancy layer with the given footprint cells and
/// re-run the O(n) blocked/clearance/component sweeps. Inputs are grounded
/// 20-wu BUILD cells; every occupied build cell rejects the larger path cell
/// containing it (hovering structures are never submitted). Full replacement keeps the
/// layer stateless against terrain rebuilds and desync-proof: the caller
/// owns the authoritative cell set and the version.
#[wasm_bindgen]
pub fn pathfinder_sync_building_occupancy(cell_gx: &[i32], cell_gy: &[i32], version: u32) -> u32 {
    let state = pathfinder_state();
    if state.n == 0 {
        return 0;
    }
    pathfinder_invalidate_all_fine_arenas(state);
    debug_assert!(cell_gy.len() >= cell_gx.len());
    state.building_blocked.fill(0);
    pathfinder_mark_consolidated_building_cells(state, cell_gx, cell_gy);
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
/// Build the move/waypoint traversal pair every pathfinder entry point needs.
///
/// The three entry points (bake, find-path, validate) all derive exactly this
/// pair from the same locomotion inputs, differing only in `water_waypoint_hold`
/// (false for movement, true for waypoints) and which allow-medium triple each
/// half reads. Deriving them here keeps a new traversal field from reaching one
/// entry point and not the others — which would make a unit path one way and
/// validate another.
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
    let previous_clearance = state.cur_required_clearance;
    let previous_unit_radius = state.cur_unit_radius;
    let previous_support_offset = state.cur_support_point_offset_z;
    state.cur_required_clearance = if move_allow_air && waypoint_allow_air {
        0
    } else {
        pathfinder_hard_clearance_cells_for_state(state, unit_radius)
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

#[derive(Clone, Copy, PartialEq)]
struct FineAStarKey {
    start_gx: i32,
    start_gy: i32,
    goal_gx: i32,
    goal_gy: i32,
    traversal: PathfinderTraversal,
    waypoint_traversal: PathfinderTraversal,
    cost_profile: PathfinderCostProfile,
    symmetric_slope: bool,
    unit_radius: f64,
    support_point_offset_z: f64,
    terrain_only_key: u64,
    building_occupancy_version: u32,
}

#[derive(Clone, Copy)]
struct PendingFineAStar {
    key: FineAStarKey,
    start_idx: u32,
    goal_idx: u32,
    best_idx: u32,
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

fn pathfinder_fine_a_star_key(
    state: &PathfinderState,
    start_gx: i32,
    start_gy: i32,
    goal_gx: i32,
    goal_gy: i32,
    traversal: PathfinderTraversal,
    cost_profile: PathfinderCostProfile,
) -> FineAStarKey {
    FineAStarKey {
        start_gx,
        start_gy,
        goal_gx,
        goal_gy,
        traversal,
        waypoint_traversal: state.cur_waypoint_traversal,
        cost_profile,
        symmetric_slope: state.cur_symmetric_slope,
        unit_radius: state.cur_unit_radius,
        support_point_offset_z: state.cur_support_point_offset_z,
        terrain_only_key: state.terrain_only_key,
        building_occupancy_version: state.building_occupancy_version,
    }
}

fn pathfinder_reconstruct_a_star_path(
    state: &mut PathfinderState,
    pending: PendingFineAStar,
    found: bool,
) -> Option<AStarResult> {
    let target = if found {
        pending.goal_idx
    } else {
        pending.best_idx
    };
    state.path_scratch.clear();
    let mut walker = target as i32;
    while walker != pending.start_idx as i32 && walker != -1 {
        state.path_scratch.push(walker as u32);
        walker = state.parent[walker as usize];
    }
    if !state.path_scratch.is_empty()
        && state.parent[*state.path_scratch.last().unwrap() as usize] == -1
        && (*state.path_scratch.last().unwrap() as i32) != pending.start_idx as i32
    {
        return None;
    }
    state.path_scratch.reverse();
    let gx = (target as i32) % state.grid_w;
    let gy = ((target as i32) - gx) / state.grid_w;
    Some(AStarResult {
        goal_gx: gx,
        goal_gy: gy,
        reached_goal: found,
        expanded_nodes: pending.expanded_nodes,
        hit_node_limit: false,
    })
}

/// Advance one fine-grid A* continuation by at most `expansion_budget`
/// closed nodes. Repeating the exact same query resumes the retained frontier;
/// any changed physics profile, endpoints, or navigation-layer version starts
/// a fresh generation deterministically.
fn pathfinder_a_star_slice(
    state: &mut PathfinderState,
    start_gx: i32,
    start_gy: i32,
    goal_gx: i32,
    goal_gy: i32,
    traversal: PathfinderTraversal,
    cost_profile: PathfinderCostProfile,
    expansion_budget: u32,
) -> AStarSliceOutcome {
    let grid_w = state.grid_w;
    let grid_h = state.grid_h;
    let key = pathfinder_fine_a_star_key(
        state,
        start_gx,
        start_gy,
        goal_gx,
        goal_gy,
        traversal,
        cost_profile,
    );
    let mut pending = match state.pending_fine_a_star.take() {
        Some(pending) if pending.key == key => pending,
        _ => {
            pathfinder_begin_a_star_generation(state);
            state.heap.clear();
            state.path_scratch.clear();
            let start_idx = (start_gy * grid_w + start_gx) as usize;
            let goal_idx = (goal_gy * grid_w + goal_gx) as u32;
            pathfinder_touch_a_star_cell(state, start_idx);
            state.g_score[start_idx] = 0.0;
            state.f_score[start_idx] = pathfinder_octile(start_gx, start_gy, goal_gx, goal_gy);
            pathfinder_heap_push(state, start_idx as u32);
            let dx = i64::from(start_gx) - i64::from(goal_gx);
            let dy = i64::from(start_gy) - i64::from(goal_gy);
            PendingFineAStar {
                key,
                start_idx: start_idx as u32,
                goal_idx,
                best_idx: start_idx as u32,
                best_d2: dx * dx + dy * dy,
                expanded_nodes: 0,
            }
        }
    };

    let expansion_budget = expansion_budget.max(1);
    let mut expanded_this_slice = 0u32;
    let mut found = false;
    while !state.heap.is_empty() && expanded_this_slice < expansion_budget {
        let cur = pathfinder_heap_pop(state);
        let cur_us = cur as usize;
        if state.closed[cur_us] != 0 {
            continue;
        }
        state.closed[cur_us] = 1;
        pending.expanded_nodes = pending.expanded_nodes.saturating_add(1);
        expanded_this_slice += 1;
        if cur == pending.goal_idx {
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
                let dx = i64::from(nx) - i64::from(goal_gx);
                let dy = i64::from(ny) - i64::from(goal_gy);
                let d2 = dx * dx + dy * dy;
                if d2 < pending.best_d2 {
                    pending.best_d2 = d2;
                    pending.best_idx = nidx as u32;
                }
                pathfinder_heap_push(state, nidx as u32);
            }
        }
    }

    if !found && !state.heap.is_empty() {
        let total = pending.expanded_nodes;
        state.pending_fine_a_star = Some(pending);
        return AStarSliceOutcome::Pending {
            total_expanded: total,
            expanded_this_slice,
        };
    }
    AStarSliceOutcome::Complete {
        result: pathfinder_reconstruct_a_star_path(state, pending, found),
        expanded_this_slice,
    }
}

#[cfg(test)]
pub(crate) fn pathfinder_a_star(
    state: &mut PathfinderState,
    start_gx: i32,
    start_gy: i32,
    goal_gx: i32,
    goal_gy: i32,
    traversal: PathfinderTraversal,
    cost_profile: PathfinderCostProfile,
) -> Option<AStarResult> {
    state.pending_fine_a_star = None;
    match pathfinder_a_star_slice(
        state,
        start_gx,
        start_gy,
        goal_gx,
        goal_gy,
        traversal,
        cost_profile,
        u32::MAX,
    ) {
        AStarSliceOutcome::Complete { result, .. } => result,
        AStarSliceOutcome::Pending { .. } => {
            unreachable!("u32::MAX exhausts any installed grid")
        }
    }
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
    allow_hierarchy: bool,
) -> u32 {
    let state = pathfinder_state();
    pathfinder_switch_fine_arena(state, continuation_owner);
    state.waypoint_scratch.clear();
    state.last_result_status = PATHFINDER_RESULT_UNREACHABLE;
    state.last_search_strategy = PATHFINDER_SEARCH_NONE;
    state.last_fine_expanded_nodes = 0;
    state.last_fine_expanded_nodes_this_slice = 0;
    state.last_coarse_expanded_nodes = 0;
    state.last_coarse_refinement_passes = 0;
    state.last_coarse_exact_edge_checks = 0;
    state.last_coarse_full_cluster_scans = 0;
    state.last_fine_hit_node_limit = false;
    state.last_smoothing_line_checks = 0;
    state.last_direct_cost_ratio = f32::NAN;
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
        pathfinder_hard_clearance_cells_for_state(state, unit_radius)
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

    let cs = state.cell_size;
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
            let (cx, cy) = pathfinder_cell_center_for_state(state, goal_cell_gx, goal_cell_gy);
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
    //
    // A body already standing in a pocket tighter than its own hard clearance
    // — the ordinary case once a structure goes up beside it — must still be
    // able to walk out. Demanding more room than the cell it currently
    // occupies makes every neighbour illegal and strands it where it stands,
    // so the search runs at the clearance the body actually has. This can only
    // widen what is legal, and never below what the start already proves is
    // occupiable; goal snapping above still demands the full hard clearance,
    // so the destination is a place the body genuinely fits.
    let start_clearance = pathfinder_clearance_at(state, start_idx, traversal).max(0);
    let escape_clearance = hard_clearance.min(start_clearance);
    state.cur_required_clearance = escape_clearance;

    // BAR-style raw move: if the current leg has direct line-of-sight through
    // passable cells, do not touch A*. This is the common case for open-field
    // move/fight/formation orders and keeps the planner out of the tick path
    // unless terrain or structures actually require a route.
    let (raw_goal_x, raw_goal_y) = if goal_was_snapped {
        pathfinder_cell_center_for_state(state, goal_cell_gx, goal_cell_gy)
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
    let fine_key = pathfinder_fine_a_star_key(
        state,
        start_cell_gx,
        start_cell_gy,
        goal_cell_gx,
        goal_cell_gy,
        traversal,
        cost_profile,
    );
    let resuming_fine_search = state
        .pending_fine_a_star
        .is_some_and(|pending| pending.key == fine_key);
    // Hierarchy is a one-time fast-path admission. Once a fine search has a
    // retained frontier, repeating coarse refinement every fixed tick would
    // waste work and make the slice cost depend on route length.
    let hierarchical_result = if resuming_fine_search || !allow_hierarchy {
        None
    } else {
        pathfinder_hierarchical_a_star(
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
        )
    };
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
        let result = match pathfinder_a_star_slice(
            state,
            start_cell_gx,
            start_cell_gy,
            goal_cell_gx,
            goal_cell_gy,
            traversal,
            cost_profile,
            expansion_budget,
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
                state.last_fine_expanded_nodes_this_slice = expanded_this_slice;
                result
            }
        };
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
        // An exhausted fine search may still provide the best physically
        // reachable frontier, but never prefer it over a complete legal
        // straight route already proven by the exact line tracer.
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
        let (first_x, first_y) = pathfinder_cell_center_for_state(state, first_gx, first_gy);
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
            let (cand_x, cand_y) = pathfinder_cell_center_for_state(state, cgx, cgy);
            let (next_x, next_y) = pathfinder_cell_center_for_state(state, ngx, ngy);
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

/// Compatibility entry point for tools and tests that explicitly want a
/// synchronous route. Authoritative simulation movement uses the sliced API
/// below so this function is never on the fixed-tick hot path.
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
    pathfinder_switch_fine_arena(state, PATHFINDER_SYNC_CONTINUATION_OWNER);
    state.pending_fine_a_star = None;
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
        u32::MAX,
        PATHFINDER_SYNC_CONTINUATION_OWNER,
        true,
    )
}

/// Start or resume the exact same fine-grid query, advancing no more than the
/// supplied number of A* node expansions. A return count of zero with result
/// status PENDING means the frontier is retained for the next fixed tick.
#[wasm_bindgen]
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
        false,
    )
}

#[wasm_bindgen]
pub fn pathfinder_cancel_path_slice(continuation_owner: u32) {
    let state = pathfinder_state();
    pathfinder_switch_fine_arena(state, continuation_owner);
    state.pending_fine_a_star = None;
}

#[wasm_bindgen]
pub fn pathfinder_cancel_all_path_slices() {
    pathfinder_invalidate_all_fine_arenas(pathfinder_state());
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
pub fn pathfinder_last_fine_expanded_nodes_this_slice() -> u32 {
    pathfinder_state().last_fine_expanded_nodes_this_slice
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
    pathfinder_apply_query_slope_gates(
        state,
        safe_drive_accel,
        static_friction_coefficient,
        safe_water_drive_accel,
    );
    state.cur_required_clearance = if traversal.allow_air {
        0
    } else {
        // Same escape rule as the planner: the polyline starts where the body
        // already stands, so a route may not be rejected for the pocket the
        // body is already occupying.
        let hard = pathfinder_hard_clearance_cells_for_state(state, unit_radius);
        let start_gx = ((points[0] / state.cell_size).floor() as i32)
            .max(0)
            .min(state.grid_w - 1);
        let start_gy = ((points[1] / state.cell_size).floor() as i32)
            .max(0)
            .min(state.grid_h - 1);
        let start_idx = (start_gy * state.grid_w + start_gx) as usize;
        hard.min(pathfinder_clearance_at(state, start_idx, traversal).max(0))
    };
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

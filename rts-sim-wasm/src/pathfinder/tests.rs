use super::*;

fn open_test_state(grid_w: i32, grid_h: i32) -> PathfinderState {
    let mut state = PathfinderState::empty();
    let n = (grid_w * grid_h) as usize;
    state.grid_w = grid_w;
    state.grid_h = grid_h;
    state.n = n;
    state.map_width = grid_w as f64 * PATHFINDER_BUILD_GRID_CELL_SIZE;
    state.map_height = grid_h as f64 * PATHFINDER_BUILD_GRID_CELL_SIZE;
    state.building_blocked = vec![0; n];
    state.terrain_blocked = vec![0; n];
    state.blocked = vec![0; n];
    state.terrain_water = vec![0; n];
    state.terrain_submerged = vec![0; n];
    state.terrain_edge_blocked = vec![0; n];
    state.terrain_height = vec![0.0; n];
    state.terrain_normal_z = vec![1.0; n];
    state.terrain_transition_normal_z = vec![1.0; n * 4];
    state.edt_ground_sq = vec![EDT_CLAMP_SQ; n];
    state.edt_medium_sq = vec![EDT_CLAMP_SQ; n];
    state.edt_water_sq = vec![EDT_CLAMP_SQ; n];
    state.traffic_heat = vec![0; n];
    state.move_passability_cache = vec![0; n];
    state.waypoint_passability_cache = vec![0; n];
    hpa_reset_layout(&mut state);
    pathfinder_build_snap_offsets(&mut state);
    state
}

/// Recompute every obstacle-derived field after a test mutated the
/// water/edge/building layers directly.
fn refresh_obstacles(state: &mut PathfinderState) {
    state.terrain_blocked.copy_from_slice(&state.terrain_water);
    pathfinder_rebuild_blocked_and_edt_full(state);
    hpa_invalidate_all(state);
}

fn full_corridor(state: &PathfinderState) -> Vec<u32> {
    (0..state.hpa_cluster_change_stamp.len() as u32).collect()
}

fn class_key(
    state: &PathfinderState,
    traversal: PathfinderTraversal,
    cost_profile: PathfinderCostProfile,
) -> HpaClassKey {
    HpaClassKey {
        traversal,
        waypoint_traversal: state.cur_waypoint_traversal,
        cost_profile,
        symmetric_slope: state.cur_symmetric_slope,
        unit_radius: state.cur_unit_radius,
        support_point_offset_z: state.cur_support_point_offset_z,
    }
}

fn fine_key(
    state: &PathfinderState,
    sgx: i32,
    sgy: i32,
    ggx: i32,
    ggy: i32,
    traversal: PathfinderTraversal,
    cost_profile: PathfinderCostProfile,
) -> FineAStarKey {
    FineAStarKey {
        start_cell: (sgy * state.grid_w + sgx) as u32,
        goal_cell: (ggy * state.grid_w + ggx) as u32,
        class: class_key(state, traversal, cost_profile),
        terrain_only_key: state.terrain_only_key,
    }
}

/// Synchronous fine A* over the whole grid (every cluster in the corridor).
fn pathfinder_a_star(
    state: &mut PathfinderState,
    sgx: i32,
    sgy: i32,
    ggx: i32,
    ggy: i32,
    traversal: PathfinderTraversal,
    cost_profile: PathfinderCostProfile,
) -> Option<AStarResult> {
    state.fine_arena.pending = None;
    let key = fine_key(state, sgx, sgy, ggx, ggy, traversal, cost_profile);
    let corridor = full_corridor(state);
    match pathfinder_a_star_slice(state, key, &corridor, &[], traversal, cost_profile, u32::MAX) {
        AStarSliceOutcome::Complete { result, .. } => result,
        AStarSliceOutcome::Pending { .. } => unreachable!("u32::MAX exhausts any grid"),
    }
}

fn slice(
    state: &mut PathfinderState,
    sgx: i32,
    sgy: i32,
    ggx: i32,
    ggy: i32,
    traversal: PathfinderTraversal,
    cost_profile: PathfinderCostProfile,
    budget: u32,
) -> AStarSliceOutcome {
    let key = fine_key(state, sgx, sgy, ggx, ggy, traversal, cost_profile);
    let corridor = full_corridor(state);
    pathfinder_a_star_slice(state, key, &corridor, &[], traversal, cost_profile, budget)
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
        required_d_cells: 0.0,
        soft_clearance_cells: 0.0,
        soft_clearance_penalty_per_cell: 0.0,
    }
}

#[test]
fn terrain_triangle_overlap_does_not_group_unused_aabb_cells() {
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
    assert!(pathfinder_is_cell_passable(&state, 0, move_traversal));
}

#[test]
fn required_clearance_is_real_valued_and_euclidean() {
    let cell = PATHFINDER_BUILD_GRID_CELL_SIZE;
    assert_eq!(pathfinder_required_d_for_radius_and_size(0.0, cell), 0.0);
    assert!((pathfinder_required_d_for_radius_and_size(9.6, cell) - 0.98).abs() < 1e-6);
    assert!((pathfinder_required_d_for_radius_and_size(41.6, cell) - 2.58).abs() < 1e-6);
    let profile = PathfinderCostProfile::for_query(100.0, 80.0, 0.0, 0.0, 0.75, 2.58);
    assert!((profile.required_d_cells - 2.58).abs() < 1e-6);
    assert_eq!(
        profile.soft_clearance_cells,
        PATHFINDING_SOFT_CLEARANCE_CELLS as f32
    );

    // A 5-cell corridor between two building walls: the centre cell sits 3
    // cells from either wall centre, so a body needing d = 2.58 fits and one
    // needing d = 3.5 (radius 60) does not — no whole-cell rounding. (Water
    // is deliberately NOT a clearance obstacle for a fording ground body —
    // its disk may overhang the shoreline — so the walls are structures.)
    let mut state = open_test_state(7, 9);
    for gy in 0..9 {
        state.building_blocked[(gy * 7) as usize] = 1;
        state.building_blocked[(gy * 7 + 6) as usize] = 1;
    }
    refresh_obstacles(&mut state);
    let centre = (4 * 7 + 3) as usize;
    assert_eq!(state.edt_ground_sq[centre], 9);
    assert_eq!(state.edt_medium_sq[centre], 9);
    let traversal = ground_traversal();
    state.cur_unit_radius = 41.6;
    state.cur_required_d_sq = pathfinder_required_d_sq_for_state(&state, 41.6);
    assert!(pathfinder_is_cell_passable(&state, centre, traversal));
    state.cur_unit_radius = 60.0;
    state.cur_required_d_sq = pathfinder_required_d_sq_for_state(&state, 60.0);
    assert!(!pathfinder_is_cell_passable(&state, centre, traversal));
    assert!(pathfinder_is_cell_passable_ignoring_clearance(&state, centre, traversal));
}

#[test]
fn escape_gradient_leaves_a_pocket_but_never_enters_one() {
    // Every cell is physically passable; the distance field forms a pocket
    // (deficient cells 1..=3) between open cells 0 and 4 for a body that
    // needs d² = 3.
    let mut state = open_test_state(5, 1);
    state.edt_ground_sq = vec![4, 2, 1, 2, 4];
    state.cur_required_d_sq = 3.0;
    state.cur_waypoint_traversal = ground_traversal();
    state.cur_waypoint_matches_move_domain = true;
    let ground = ground_traversal();
    // Out of the tightest cell in either direction: clearance grows.
    assert!(pathfinder_can_step_between(&state, 2, 1, ground));
    assert!(pathfinder_can_step_between(&state, 2, 3, ground));
    // Deeper in: clearance shrinks — never.
    assert!(!pathfinder_can_step_between(&state, 1, 2, ground));
    assert!(!pathfinder_can_step_between(&state, 3, 2, ground));
    // From open ground into any deficient cell — never.
    assert!(!pathfinder_can_step_between(&state, 0, 1, ground));
    assert!(!pathfinder_can_step_between(&state, 4, 3, ground));
    // From deficient onto open ground — yes.
    assert!(pathfinder_can_step_between(&state, 1, 0, ground));
    assert!(pathfinder_can_step_between(&state, 3, 4, ground));
    // The cached path used by A* agrees.
    pathfinder_begin_query_transition_cache(&mut state);
    assert!(pathfinder_can_step_between_cached(&mut state, 2, 1, ground));
    assert!(!pathfinder_can_step_between_cached(&mut state, 1, 2, ground));
    assert!(!pathfinder_can_step_between_cached(&mut state, 0, 1, ground));
    // And so does the line walker used by validation: a polyline that
    // starts in the pocket and leaves is legal, one that enters is not.
    state.line_transition_cache_enabled = false;
    let (x2, y) = pathfinder_cell_center(2, 0);
    let (x0, _) = pathfinder_cell_center(0, 0);
    let (x4, _) = pathfinder_cell_center(4, 0);
    assert!(pathfinder_has_los(&mut state, x2, y, x0, y, ground));
    assert!(pathfinder_has_los(&mut state, x2, y, x4, y, ground));
    assert!(!pathfinder_has_los(&mut state, x0, y, x2, y, ground));
    assert!(!pathfinder_has_los(&mut state, x4, y, x2, y, ground));
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
fn line_walker_exempts_only_the_escape_start_cell() {
    let mut state = open_test_state(3, 1);
    state.building_blocked[0] = 1;
    state.cur_waypoint_traversal = ground_traversal();
    state.cur_waypoint_matches_move_domain = true;
    let ground = ground_traversal();
    let (x0, y0) = pathfinder_cell_center(0, 0);
    let (x2, y2) = pathfinder_cell_center(2, 0);

    pathfinder_set_escape_start(&mut state, 2, ground);
    assert_eq!(state.cur_escape_start_idx, usize::MAX, "an open start is not an escape start");
    assert!(!pathfinder_has_los(&mut state, x0, y0, x2, y2, ground));

    pathfinder_set_escape_start(&mut state, 0, ground);
    assert_eq!(state.cur_escape_start_idx, 0);
    assert!(
        pathfinder_has_los(&mut state, x0, y0, x2, y2, ground),
        "a body may leave its own fresh footprint along a straight first leg"
    );
    assert!(!pathfinder_has_los(&mut state, x2, y2, x0, y0, ground));
    state.building_blocked[0] = 0;
    state.building_blocked[1] = 1;
    // Buildings only change between queries; a query begins with fresh caches.
    pathfinder_begin_query_transition_cache(&mut state);
    pathfinder_set_escape_start(&mut state, 1, ground);
    assert!(
        !pathfinder_has_los(&mut state, x0, y0, x2, y2, ground),
        "the exemption never applies to a cell that is not the line's first cell"
    );
    state.building_blocked[1] = 0;
    state.terrain_edge_blocked[0] = 1;
    pathfinder_set_escape_start(&mut state, 0, ground);
    assert_eq!(
        state.cur_escape_start_idx,
        0,
        "a body pushed into the edge buffer may leave it: any illegal start cell is an escape start"
    );
}

fn brute_edt(obstacle: &[u8], w: i32, h: i32) -> Vec<u16> {
    let mut out = vec![EDT_CLAMP_SQ; (w * h) as usize];
    for y in 0..h {
        for x in 0..w {
            let idx = (y * w + x) as usize;
            if obstacle[idx] != 0 {
                out[idx] = 0;
                continue;
            }
            let mut best = EDT_CLAMP_SQ as i32;
            for oy in 0..h {
                for ox in 0..w {
                    if obstacle[(oy * w + ox) as usize] == 0 {
                        continue;
                    }
                    let d2 = (ox - x) * (ox - x) + (oy - y) * (oy - y);
                    if d2 < best {
                        best = d2;
                    }
                }
            }
            out[idx] = best as u16;
        }
    }
    out
}

#[test]
fn building_occupancy_diff_updates_distance_fields_locally_and_exactly() {
    let mut state = open_test_state(80, 60);
    // Some terrain water so the ground field has pre-existing obstacles.
    for gy in 0..60 {
        state.terrain_water[(gy * 80 + 5) as usize] = 1;
    }
    refresh_obstacles(&mut state);
    let expected = |state: &PathfinderState| brute_edt(&state.blocked, 80, 60);
    assert_eq!(state.edt_ground_sq, expected(&state));

    // Place a 3x3 building and a far single cell.
    let mut gx = Vec::new();
    let mut gy = Vec::new();
    for y in 10..13 {
        for x in 20..23 {
            gx.push(x);
            gy.push(y);
        }
    }
    gx.push(35);
    gy.push(25);
    gx.push(-1);
    gy.push(3);
    gx.push(400);
    gy.push(3);
    assert_eq!(pathfinder_apply_building_occupancy(&mut state, &gx, &gy, 7), 1);
    assert_eq!(state.building_occupancy_version, 7);
    assert_eq!(state.building_blocked.iter().filter(|&&v| v != 0).count(), 10);
    assert_eq!(state.edt_ground_sq, expected(&state), "after placement");
    let medium_expected = brute_edt(&state.building_blocked, 80, 60);
    assert_eq!(state.edt_medium_sq, medium_expected, "medium field after placement");

    // Remove the building, keep the far cell.
    assert_eq!(pathfinder_apply_building_occupancy(&mut state, &[35], &[25], 8), 1);
    assert_eq!(state.building_blocked.iter().filter(|&&v| v != 0).count(), 1);
    assert_eq!(state.edt_ground_sq, expected(&state), "after removal");
    assert_eq!(
        state.edt_medium_sq,
        brute_edt(&state.building_blocked, 80, 60),
        "medium field after removal"
    );
    // The building's clusters were stamped dirty; a far-away cluster was not.
    let touched = hpa_cluster_of_cell(&state, (11 * 80 + 21) as u32) as usize;
    let far = hpa_cluster_of_cell(&state, (55 * 80 + 70) as u32) as usize;
    assert_eq!(state.hpa_cluster_change_stamp[touched], state.hpa_stamp_counter);
    assert_ne!(state.hpa_cluster_change_stamp[far], state.hpa_stamp_counter);
}

#[test]
fn shallow_water_is_fordable_ground_up_to_the_collision_radius() {
    let mut state = open_test_state(3, 1);
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
    state.cur_support_point_offset_z = 9.0;
    assert!(pathfinder_is_cell_passable(&state, 1, dry_only));
    state.cur_unit_radius = 0.0;
    assert!(!pathfinder_is_cell_passable(&state, 1, dry_only));
}

#[test]
fn planner_water_credit_scales_with_immersion() {
    let mut state = open_test_state(2, 1);
    state.terrain_water[0] = 1;
    state.terrain_water[1] = 1;
    state.cur_unit_radius = 10.0;
    state.terrain_height[0] = (TERRAIN_WATER_LEVEL - 20.0) as f32;
    assert!((pathfinder_cell_water_case_scale(&state, 0) - 1.0).abs() < 1e-12);
    state.terrain_height[1] = TERRAIN_WATER_LEVEL as f32;
    assert!(pathfinder_cell_water_case_scale(&state, 1).abs() < 1e-12);
    state.terrain_height[1] = (TERRAIN_WATER_LEVEL - 5.0) as f32;
    let shallow = pathfinder_cell_water_case_scale(&state, 1);
    assert!(shallow > 0.0 && shallow < 0.2, "got {shallow}");
    state.cur_unit_radius = 0.0;
    assert!((pathfinder_cell_water_case_scale(&state, 1) - 1.0).abs() < 1e-12);
}

#[test]
fn boundary_cliffs_are_not_descent_routes() {
    let mut state = open_test_state(2, 1);
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
    state.cur_waypoint_traversal = traversal;
    state.cur_waypoint_matches_move_domain = true;
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
fn fine_a_star_resumes_the_same_frontier_across_slices() {
    let mut state = open_test_state(12, 12);
    let traversal = ground_traversal();
    state.cur_waypoint_traversal = traversal;
    state.cur_waypoint_matches_move_domain = true;
    let profile = ground_cost_profile(GRAVITY);

    let first = slice(&mut state, 0, 0, 11, 11, traversal, profile, 1);
    assert!(matches!(
        first,
        AStarSliceOutcome::Pending {
            total_expanded: 1,
            expanded_this_slice: 1,
        }
    ));
    let search_generation = state.fine_arena.current_gen;
    let second = slice(&mut state, 0, 0, 11, 11, traversal, profile, 1);
    assert!(matches!(
        second,
        AStarSliceOutcome::Pending {
            total_expanded: 2,
            expanded_this_slice: 1,
        }
    ));
    assert_eq!(state.fine_arena.current_gen, search_generation, "resume must not reset scores");

    let result = loop {
        match slice(&mut state, 0, 0, 11, 11, traversal, profile, 2) {
            AStarSliceOutcome::Pending { .. } => continue,
            AStarSliceOutcome::Complete { result, .. } => break result,
        }
    }
    .expect("open grid must complete");
    assert!(result.reached_goal);
    assert!(result.expanded_nodes > 2);
    assert_eq!(state.path_scratch.last().copied(), Some((11 * 12 + 11) as u32));
}

#[test]
fn fine_a_star_frontiers_resume_independently_per_team_owner() {
    let mut state = open_test_state(12, 12);
    let traversal = ground_traversal();
    state.cur_waypoint_traversal = traversal;
    state.cur_waypoint_matches_move_domain = true;
    let profile = ground_cost_profile(GRAVITY);

    pathfinder_switch_fine_arena(&mut state, 1);
    assert!(matches!(
        slice(&mut state, 0, 0, 11, 11, traversal, profile, 1),
        AStarSliceOutcome::Pending { total_expanded: 1, .. }
    ));
    pathfinder_switch_fine_arena(&mut state, 2);
    assert!(matches!(
        slice(&mut state, 11, 0, 0, 11, traversal, profile, 1),
        AStarSliceOutcome::Pending { total_expanded: 1, .. }
    ));
    pathfinder_switch_fine_arena(&mut state, 1);
    assert!(matches!(
        slice(&mut state, 0, 0, 11, 11, traversal, profile, 1),
        AStarSliceOutcome::Pending { total_expanded: 2, .. }
    ));
    pathfinder_switch_fine_arena(&mut state, 2);
    assert!(matches!(
        slice(&mut state, 11, 0, 0, 11, traversal, profile, 1),
        AStarSliceOutcome::Pending { total_expanded: 2, .. }
    ));
}

#[test]
fn corridor_restricted_search_never_leaves_its_clusters() {
    // 64x16 grid = 4x1 clusters. A corridor of clusters {0, 1} cannot reach
    // a goal in cluster 3 even though the grid is open.
    let mut state = open_test_state(64, 16);
    let traversal = ground_traversal();
    state.cur_waypoint_traversal = traversal;
    state.cur_waypoint_matches_move_domain = true;
    let profile = ground_cost_profile(GRAVITY);
    let key = fine_key(&state, 2, 8, 60, 8, traversal, profile);
    let outcome = pathfinder_a_star_slice(&mut state, key, &[0, 1], &[], traversal, profile, u32::MAX);
    match outcome {
        AStarSliceOutcome::Complete { result, expanded_this_slice } => {
            assert!(result.is_none(), "the goal is outside the corridor");
            assert_eq!(expanded_this_slice, 0);
        }
        AStarSliceOutcome::Pending { .. } => panic!("must not pend"),
    }
    let key = fine_key(&state, 2, 8, 30, 8, traversal, profile);
    let outcome = pathfinder_a_star_slice(&mut state, key, &[0, 1], &[], traversal, profile, u32::MAX);
    match outcome {
        AStarSliceOutcome::Complete { result, expanded_this_slice } => {
            assert!(result.expect("goal inside the corridor").reached_goal);
            assert!(expanded_this_slice <= 32 * 16, "expanded {expanded_this_slice}");
        }
        AStarSliceOutcome::Pending { .. } => panic!("must not pend"),
    }
}

#[test]
fn sliced_a_star_can_exhaust_more_than_the_old_fifty_thousand_node_cap() {
    let mut state = open_test_state(405, 305);
    let traversal = ground_traversal();
    state.cur_waypoint_traversal = traversal;
    state.cur_waypoint_matches_move_domain = true;
    let profile = ground_cost_profile(GRAVITY);
    for gy in 0..state.grid_h {
        state.terrain_water[(gy * state.grid_w + 202) as usize] = 1;
    }
    refresh_obstacles(&mut state);
    let result = loop {
        match slice(&mut state, 2, 152, 402, 152, traversal, profile, 1024) {
            AStarSliceOutcome::Pending { .. } => continue,
            AStarSliceOutcome::Complete { result, .. } => break result,
        }
    }
    .expect("the reachable frontier supplies a deterministic partial route");
    assert!(!result.reached_goal);
    assert!(result.expanded_nodes > 50_000);
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

    assert!(pathfinder_can_step_between_cached(&mut state, 0, 1, move_traversal));
    assert!(!pathfinder_can_step_between_cached(&mut state, 1, 0, move_traversal));
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

fn open_query_state(grid_w: i32, grid_h: i32) -> (PathfinderState, PathfinderTraversal, PathfinderCostProfile) {
    let mut state = open_test_state(grid_w, grid_h);
    let traversal = ground_traversal();
    state.cur_waypoint_traversal = traversal;
    state.cur_waypoint_matches_move_domain = true;
    pathfinder_begin_query_transition_cache(&mut state);
    let profile = ground_cost_profile(0.0);
    (state, traversal, profile)
}

#[test]
fn hierarchy_crosses_a_large_open_grid_with_a_short_corridor() {
    let (mut state, traversal, profile) = open_query_state(256, 256);
    let key = class_key(&state, traversal, profile);
    let class_idx = hpa_class_index(&mut state, key);
    let start = (1 * 256 + 1) as u32;
    let goal = (254 * 256 + 254) as u32;
    let outcome = hpa_search(&mut state, class_idx, start, goal, u32::MAX);
    let corridor = match outcome {
        HpaSearchOutcome::Reached { corridor, .. } => corridor,
        _ => panic!("open grid must connect opposite corners"),
    };
    // 16x16 clusters on a 256 grid: a diagonal crossing touches ~31.
    assert!(corridor.len() <= 34, "corridor {} clusters", corridor.len());
    assert_eq!(corridor[0], hpa_cluster_of_cell(&state, start));
    assert_eq!(*corridor.last().unwrap(), hpa_cluster_of_cell(&state, goal));
    // Only the clusters the abstract search touched were built.
    let built = state.hpa_classes[class_idx]
        .clusters
        .iter()
        .filter(|c| c.built_stamp != 0)
        .count();
    assert!(built < 256, "built {built} of 256 clusters");
    // The corridor search finds the route without touching the rest.
    let fine = fine_key(&state, 1, 1, 254, 254, traversal, profile);
    match pathfinder_a_star_slice(&mut state, fine, &corridor, &[], traversal, profile, u32::MAX) {
        AStarSliceOutcome::Complete { result, expanded_this_slice } => {
            assert!(result.expect("route").reached_goal);
            assert!(expanded_this_slice < 34 * 256, "expanded {expanded_this_slice}");
        }
        _ => panic!("must complete"),
    }
}

#[test]
fn hierarchy_reports_unreachable_across_a_full_wall_and_snaps_to_reachable_side() {
    let (mut state, traversal, profile) = open_query_state(128, 64);
    for gy in 0..64 {
        state.terrain_water[(gy * 128 + 64) as usize] = 1;
    }
    refresh_obstacles(&mut state);
    let key = class_key(&state, traversal, profile);
    let class_idx = hpa_class_index(&mut state, key);
    let start = (32 * 128 + 4) as u32;
    let goal = (32 * 128 + 120) as u32;
    assert!(matches!(
        hpa_search(&mut state, class_idx, start, goal, u32::MAX),
        HpaSearchOutcome::Unreachable
    ));
    let (snapped, flood_work) = hpa_nearest_reachable_cell(&state, class_idx, 120, 32, traversal);
    let snapped = snapped.expect("the reachable side must offer a snap target");
    assert!(flood_work > 0, "the snap scan must report the work it charged");
    assert!(snapped.0 < 64, "snapped to x={} on the start's side", snapped.0);
    assert!(snapped.0 >= 60, "the snap is the nearest reachable cell, got x={}", snapped.0);
}

#[test]
fn hierarchy_preserves_a_gap_exactly_as_wide_as_the_body_and_no_narrower() {
    // A wall with a 3-cell gap. Point bodies and a small body (needs d²
    // below the gap's centre clearance of 4) get through; a body needing
    // d² > 4 does not — and the hierarchy agrees with the fine rule.
    let build = |gap: i32| {
        let (mut state, traversal, profile) = open_query_state(96, 48);
        for gy in 0..48 {
            if (24 - gap / 2..24 - gap / 2 + gap).contains(&gy) {
                continue;
            }
            state.terrain_water[(gy * 96 + 48) as usize] = 1;
        }
        refresh_obstacles(&mut state);
        (state, traversal, profile)
    };
    let start = (24 * 96 + 4) as u32;
    let goal = (24 * 96 + 90) as u32;
    // Point body: through the 3-cell gap.
    {
        let (mut state, traversal, profile) = build(3);
        let key = class_key(&state, traversal, profile);
        let class_idx = hpa_class_index(&mut state, key);
        let outcome = hpa_search(&mut state, class_idx, start, goal, u32::MAX);
        let corridor = match outcome {
            HpaSearchOutcome::Reached { corridor, .. } => corridor,
            _ => panic!("a point body must pass a 3-cell gap"),
        };
        // The gap border (cluster column 2 | 3, row of clusters 1) carries
        // exactly one entrance, on a gap row — never a wall/ground pair.
        {
            let gap_cluster = hpa_cluster_of_cell(&state, (24 * 96 + 40) as u32);
            let borders = hpa_cluster_borders(&state, gap_cluster);
            let pairs = &state.hpa_classes[class_idx].borders[borders[0]].pairs;
            assert_eq!(pairs.len(), 1, "one entrance for one open run");
            let row = (pairs[0].cell_b as i32) / 96;
            assert!((23..26).contains(&row), "entrance row {row} must be inside the gap");
        }
        let fine = fine_key(&state, 4, 24, 90, 24, traversal, profile);
        match pathfinder_a_star_slice(&mut state, fine, &corridor, &[], traversal, profile, u32::MAX) {
            AStarSliceOutcome::Complete { result, .. } => {
                assert!(result.expect("route").reached_goal);
                assert!(
                    state.path_scratch.iter().any(|&c| (c as i32) % 96 == 48 && (23..26).contains(&((c as i32) / 96))),
                    "route uses the gap"
                );
            }
            _ => panic!("must complete"),
        }
    }
    // Body that fits: required d² = 3.9 (< gap centre's 4).
    {
        let (mut state, traversal, mut profile) = build(3);
        state.cur_required_d_sq = 3.9;
        profile.required_d_cells = 3.9f32.sqrt();
        let key = class_key(&state, traversal, profile);
        let class_idx = hpa_class_index(&mut state, key);
        assert!(matches!(
            hpa_search(&mut state, class_idx, start, goal, u32::MAX),
            HpaSearchOutcome::Reached { .. }
        ));
    }
    // Body that does not fit: required d² = 4.1.
    {
        let (mut state, traversal, mut profile) = build(3);
        state.cur_required_d_sq = 4.1;
        profile.required_d_cells = 4.1f32.sqrt();
        let key = class_key(&state, traversal, profile);
        let class_idx = hpa_class_index(&mut state, key);
        assert!(matches!(
            hpa_search(&mut state, class_idx, start, goal, u32::MAX),
            HpaSearchOutcome::Unreachable
        ));
    }
    // A one-cell gap: exactly one entrance on that border, and a point body
    // routes through it.
    {
        let (mut state, traversal, profile) = build(1);
        let key = class_key(&state, traversal, profile);
        let class_idx = hpa_class_index(&mut state, key);
        assert!(matches!(
            hpa_search(&mut state, class_idx, start, goal, u32::MAX),
            HpaSearchOutcome::Reached { .. }
        ));
    }
}

#[test]
fn hierarchy_rebuilds_dirty_clusters_after_building_changes() {
    let (mut state, traversal, profile) = open_query_state(96, 48);
    let key = class_key(&state, traversal, profile);
    let class_idx = hpa_class_index(&mut state, key);
    let start = (24 * 96 + 4) as u32;
    let goal = (24 * 96 + 90) as u32;
    assert!(matches!(
        hpa_search(&mut state, class_idx, start, goal, u32::MAX),
        HpaSearchOutcome::Reached { .. }
    ));
    // A building wall across the map.
    let gx: Vec<i32> = (0..48).map(|_| 48).collect();
    let gy: Vec<i32> = (0..48).collect();
    pathfinder_apply_building_occupancy(&mut state, &gx, &gy, 1);
    pathfinder_begin_query_transition_cache(&mut state);
    assert!(matches!(
        hpa_search(&mut state, class_idx, start, goal, u32::MAX),
        HpaSearchOutcome::Unreachable
    ));
    // Wall gone: reachable again through rebuilt clusters.
    pathfinder_apply_building_occupancy(&mut state, &[], &[], 2);
    pathfinder_begin_query_transition_cache(&mut state);
    assert!(matches!(
        hpa_search(&mut state, class_idx, start, goal, u32::MAX),
        HpaSearchOutcome::Reached { .. }
    ));
}

#[test]
fn hierarchy_search_respects_the_work_budget_and_persists_progress() {
    let (mut state, traversal, profile) = open_query_state(256, 256);
    let key = class_key(&state, traversal, profile);
    let class_idx = hpa_class_index(&mut state, key);
    let start = (1 * 256 + 1) as u32;
    let goal = (254 * 256 + 254) as u32;
    let mut slices = 0;
    loop {
        state.hpa_work = 0;
        match hpa_search(&mut state, class_idx, start, goal, 600) {
            HpaSearchOutcome::Budget => {
                slices += 1;
                assert!(slices < 500, "must converge");
            }
            HpaSearchOutcome::Reached { .. } => break,
            HpaSearchOutcome::Unreachable => panic!("open grid"),
        }
    }
    assert!(slices > 0, "a tiny budget must pend at least once on a cold graph");
}

#[test]
fn unreachable_search_on_a_large_map_stays_within_the_slice_budget() {
    // A full wall: the abstract search must exhaust the reachable half, but
    // only one cost row (<= 256 cells) past the budget per slice, so a
    // 1,000-unit budget can never turn into a 100,000-unit tick.
    let (mut state, traversal, profile) = open_query_state(256, 256);
    for gy in 0..256 {
        state.terrain_water[(gy * 256 + 128) as usize] = 1;
    }
    refresh_obstacles(&mut state);
    let key = class_key(&state, traversal, profile);
    let class_idx = hpa_class_index(&mut state, key);
    let start = (128 * 256 + 4) as u32;
    let goal = (128 * 256 + 250) as u32;
    let budget = 1_000u32;
    let mut slices = 0;
    let mut worst = 0u32;
    loop {
        state.hpa_work = 0;
        let outcome = hpa_search(&mut state, class_idx, start, goal, budget);
        worst = worst.max(state.hpa_work);
        match outcome {
            HpaSearchOutcome::Budget => {
                slices += 1;
                assert!(slices < 5_000, "must converge");
            }
            HpaSearchOutcome::Unreachable => break,
            HpaSearchOutcome::Reached { .. } => panic!("the wall is complete"),
        }
    }
    assert!(slices > 5, "an exhaustive search on a 256x256 map must take many slices, took {slices}");
    let cluster_cells = (hpa_cluster_size() * hpa_cluster_size()) as u32;
    assert!(
        worst <= budget + cluster_cells + 64,
        "a slice may overshoot by at most one row build, worst {worst}"
    );
}

#[test]
fn traffic_heat_raises_edge_cost_only_when_enabled() {
    let mut state = open_test_state(2, 1);
    let traversal = ground_traversal();
    let profile = ground_cost_profile(0.0);
    state.traffic_heat[1] = 255;
    state.cur_heat_enabled = false;
    let cold = pathfinder_edge_cost(&state, 0, 0, 1, 0, traversal, profile);
    state.cur_heat_enabled = true;
    let hot = pathfinder_edge_cost(&state, 0, 0, 1, 0, traversal, profile);
    assert!((cold - 1.0).abs() < 1e-6);
    assert!((hot - (1.0 + PATHFINDING_TRAFFIC_HEAT_PENALTY)).abs() < 1e-5, "hot {hot}");
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
    state.terrain_water.fill(1);
    state.terrain_submerged = vec![0, 1, 1, 1, 1, 1, 1];
    refresh_obstacles(&mut state);
    assert_eq!(state.edt_water_sq[..4], [0, 1, 4, 9]);

    state.cur_required_d_sq = 0.0;
    assert!(!pathfinder_is_cell_passable(&state, 0, traversal));
    assert!(pathfinder_is_cell_passable(&state, 1, traversal));

    state.cur_required_d_sq = 9.0;
    assert!(!pathfinder_is_cell_passable(&state, 2, traversal));
    assert!(pathfinder_is_cell_passable(&state, 3, traversal));
    assert!((pathfinder_clearance_at(&state, 3, traversal) - 3.0).abs() < 1e-6);
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
    assert!(!pathfinder_is_cell_passable(&state, 0, traversal));
    assert!(pathfinder_is_cell_passable(&state, 1, traversal));
}

#[test]
fn soft_clearance_cost_prefers_open_cells_without_blocking_narrow_routes() {
    let (mut state, traversal, _) = open_query_state(5, 3);
    // Middle row cells 1..=3 are tight (d = 1) but legal for a body that
    // needs d = 1; rows 0 and 2 are wide open.
    state.cur_required_d_sq = 1.0;
    for gx in 1..=3 {
        state.edt_ground_sq[(1 * state.grid_w + gx) as usize] = 1;
    }
    let profile = PathfinderCostProfile {
        flat_drive_accel: 0.0,
        safe_drive_accel: 0.0,
        flat_water_contact_accel: 0.0,
        safe_water_drive_accel: 0.0,
        static_friction_coefficient: 0.0,
        required_d_cells: 1.0,
        soft_clearance_cells: 2.0,
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
    let goal_local = fine_local_of_cell(&state, &state.fine_arena, (1 * 5 + 4) as u32).unwrap();
    let chosen_cost = state.fine_arena.g_score[goal_local as usize];
    assert!(direct_cost > chosen_cost, "smoothing must preserve the cheaper open route");

    // Soft preference never changes passability: if only the tight row is
    // available, the same hard-clearance cells remain legal.
    for gy in [0, 2] {
        for gx in 0..state.grid_w {
            state.terrain_water[(gy * state.grid_w + gx) as usize] = 1;
        }
    }
    refresh_obstacles(&mut state);
    pathfinder_begin_query_transition_cache(&mut state);
    let result = pathfinder_a_star(&mut state, 0, 1, 4, 1, traversal, profile)
        .expect("soft clearance must not prohibit the narrow route");
    assert!(result.reached_goal);
}

#[test]
fn diagonal_neighbor_cannot_cut_a_blocked_corner() {
    let mut state = open_test_state(3, 3);
    state.cur_required_d_sq = 0.0;
    let traversal = ground_traversal();

    state.terrain_water[1 * 3 + 2] = 1;
    assert!(!pathfinder_can_step_neighbor(&state, 1, 1, 2, 2, traversal,));
    state.terrain_water[1 * 3 + 2] = 0;
    assert!(pathfinder_can_step_neighbor(&state, 1, 1, 2, 2, traversal,));
}


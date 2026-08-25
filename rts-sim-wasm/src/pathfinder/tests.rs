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
fn line_walker_exempts_only_the_escape_start_cell() {
    // 3x1 grid; a building went up over cell 0 where the body stands.
    let mut state = open_test_state(3, 1);
    state.cell_size = PATHFINDER_BUILD_GRID_CELL_SIZE;
    state.building_blocked[0] = 1;
    state.cur_waypoint_traversal = ground_traversal();
    state.cur_waypoint_matches_move_domain = true;
    let ground = ground_traversal();
    let (x0, y0) = pathfinder_cell_center(0, 0);
    let (x2, y2) = pathfinder_cell_center(2, 0);

    // Without classification the walker rejects the blocked first cell.
    pathfinder_set_escape_start(&mut state, 2, ground);
    assert_eq!(state.cur_escape_start_idx, usize::MAX, "an open start is not an escape start");
    assert!(!pathfinder_has_los(&mut state, x0, y0, x2, y2, ground));

    // Classified as the body's escape start, the SAME line is legal.
    pathfinder_set_escape_start(&mut state, 0, ground);
    assert_eq!(state.cur_escape_start_idx, 0);
    assert!(
        pathfinder_has_los(&mut state, x0, y0, x2, y2, ground),
        "a body may leave its own fresh footprint along a straight first leg"
    );
    // Escape is one-way: a line INTO the footprint is still illegal, and so
    // is one that merely crosses the escape cell later in its walk.
    assert!(!pathfinder_has_los(&mut state, x2, y2, x0, y0, ground));
    state.building_blocked[0] = 0;
    state.building_blocked[1] = 1;
    pathfinder_set_escape_start(&mut state, 1, ground);
    assert!(
        !pathfinder_has_los(&mut state, x0, y0, x2, y2, ground),
        "the exemption never applies to a cell that is not the line's first cell"
    );
    // A start blocked by terrain (not only by a building) is never an escape.
    state.building_blocked[1] = 0;
    state.terrain_edge_blocked[0] = 1;
    pathfinder_set_escape_start(&mut state, 0, ground);
    assert_eq!(state.cur_escape_start_idx, usize::MAX);
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
fn fine_a_star_resumes_the_same_frontier_across_slices() {
    let mut state = open_test_state(12, 12);
    let traversal = ground_traversal();
    state.cur_waypoint_traversal = traversal;
    let profile = ground_cost_profile(GRAVITY);
    let generation_before = state.current_gen;

    let first = pathfinder_a_star_slice(
        &mut state, 0, 0, 11, 11, traversal, profile, 1,
    );
    assert!(matches!(
        first,
        AStarSliceOutcome::Pending {
            total_expanded: 1,
            expanded_this_slice: 1,
        }
    ));
    let search_generation = state.current_gen;
    assert_ne!(search_generation, generation_before);

    let second = pathfinder_a_star_slice(
        &mut state, 0, 0, 11, 11, traversal, profile, 1,
    );
    assert!(matches!(
        second,
        AStarSliceOutcome::Pending {
            total_expanded: 2,
            expanded_this_slice: 1,
        }
    ));
    assert_eq!(state.current_gen, search_generation, "resume must not reset scores");

    let result = loop {
        match pathfinder_a_star_slice(
            &mut state, 0, 0, 11, 11, traversal, profile, 2,
        ) {
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
    let profile = ground_cost_profile(GRAVITY);

    pathfinder_switch_fine_arena(&mut state, 1);
    assert!(matches!(
        pathfinder_a_star_slice(&mut state, 0, 0, 11, 11, traversal, profile, 1),
        AStarSliceOutcome::Pending { total_expanded: 1, .. }
    ));

    pathfinder_switch_fine_arena(&mut state, 2);
    assert!(matches!(
        pathfinder_a_star_slice(&mut state, 11, 0, 0, 11, traversal, profile, 1),
        AStarSliceOutcome::Pending { total_expanded: 1, .. }
    ));

    pathfinder_switch_fine_arena(&mut state, 1);
    assert!(matches!(
        pathfinder_a_star_slice(&mut state, 0, 0, 11, 11, traversal, profile, 1),
        AStarSliceOutcome::Pending { total_expanded: 2, .. }
    ));
    pathfinder_switch_fine_arena(&mut state, 2);
    assert!(matches!(
        pathfinder_a_star_slice(&mut state, 11, 0, 0, 11, traversal, profile, 1),
        AStarSliceOutcome::Pending { total_expanded: 2, .. }
    ));
}

#[test]
fn consolidated_building_occupancy_rejects_any_contained_build_square() {
    let mut state = open_test_state(4, 3);
    state.consolidation_multiplier = 3;
    let gx = [-1, 0, 2, 3, 5, 6, 99];
    let gy = [0, 0, 2, 3, 5, 0, 0];
    pathfinder_mark_consolidated_building_cells(&mut state, &gx, &gy);

    assert_eq!(state.building_blocked[0], 1, "0 and 2 share coarse cell 0,0");
    assert_eq!(state.building_blocked[1 * 4 + 1], 1, "3 and 5 share coarse cell 1,1");
    assert_eq!(state.building_blocked[2], 1, "build cell 6 maps to coarse cell 2,0");
    assert_eq!(state.building_blocked.iter().filter(|&&v| v != 0).count(), 3);
}

#[test]
fn sliced_a_star_can_exhaust_more_than_the_old_fifty_thousand_node_cap() {
    let mut state = open_test_state(405, 305);
    let traversal = ground_traversal();
    state.cur_waypoint_traversal = traversal;
    let profile = ground_cost_profile(GRAVITY);
    // A full-height water wall splits the dry domain. Fine A* must exhaust
    // the entire 202x305 reachable half instead of returning an arbitrary
    // node-limited partial route.
    for gy in 0..state.grid_h {
        state.terrain_water[(gy * state.grid_w + 202) as usize] = 1;
    }
    let result = loop {
        match pathfinder_a_star_slice(
            &mut state, 2, 152, 402, 152, traversal, profile, 1024,
        ) {
            AStarSliceOutcome::Pending { .. } => continue,
            AStarSliceOutcome::Complete { result, .. } => break result,
        }
    }
    .expect("the reachable frontier supplies a deterministic partial route");
    assert!(!result.reached_goal);
    assert!(
        result.expanded_nodes > 50_000,
        "the search must not preserve the old total-node ceiling",
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

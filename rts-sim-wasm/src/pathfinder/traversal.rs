use super::*;

pub(crate) fn pathfinder_query_unit_radius(unit_radius: f64) -> f64 {
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
pub(crate) fn pathfinder_query_body_center_height(state: &PathfinderState) -> f64 {
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
pub(crate) fn pathfinder_is_cell_passable_impl(
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

pub(crate) fn pathfinder_begin_query_transition_cache(state: &mut PathfinderState) {
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
pub(crate) fn pathfinder_cached_cell_passable(
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
pub(crate) fn pathfinder_cell_water_case_scale(state: &PathfinderState, idx: usize) -> f64 {
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
pub(crate) fn pathfinder_required_cell_normal_z(
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
pub(crate) fn pathfinder_precomputed_transition_normal_z(
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
pub(crate) fn pathfinder_step_height_forces(
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
pub(crate) fn pathfinder_step_between_cached_forces(
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
pub(crate) fn pathfinder_can_step_between_cached(
    state: &mut PathfinderState,
    from_idx: usize,
    to_idx: usize,
    traversal: PathfinderTraversal,
) -> bool {
    pathfinder_step_between_cached_forces(state, from_idx, to_idx, traversal, false).is_some()
}

#[inline]
pub(crate) fn pathfinder_can_step_neighbor_cached(
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
pub(crate) fn pathfinder_clearance_at(
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
pub(crate) fn pathfinder_edge_cost_from_forces(
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
pub(crate) fn pathfinder_force_profiles_match(
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
pub(crate) fn pathfinder_neighbor_cost_uncached(
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
pub(crate) fn pathfinder_neighbor_direction(dx: i32, dy: i32) -> Option<u64> {
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
pub(crate) fn pathfinder_line_neighbor_cost(
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

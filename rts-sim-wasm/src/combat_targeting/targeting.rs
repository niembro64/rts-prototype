// Ballistic aim, target scoring, and per-tick targeting kernels.

use super::*;

// ─────────────────────────────────────────────────────────────────
// AIM-08.4 — Ballistic turret aim kernel.
//
// The targeting scheduler resolves slab-owned aim points and kinematics,
// then writes reusable aim outputs beside each turret slot. Ballistic
// weapons run the hot intercept and arc solve here; direct-fire weapons
// reuse the same output fields for yaw/pitch pose.
// ─────────────────────────────────────────────────────────────────

pub(crate) const CT_BALLISTIC_ARC_HIGH: u8 = 1;
pub(crate) const CT_HIGH_ARC_MIN_TIME_SEPARATION: f64 = 1.0 / 120.0;
pub(crate) const CT_SHOT_DIRECTION_EPSILON: f64 = 1e-6;

#[inline]
pub(crate) fn combat_targeting_ballistic_params_finite(values: &[f64]) -> bool {
    for v in values.iter() {
        if !v.is_finite() {
            return false;
        }
    }
    true
}

#[wasm_bindgen]
pub fn combat_targeting_solve_ballistic_aim(
    entity_slot: u32,
    turret_idx: u32,
    target_x: f64,
    target_y: f64,
    target_z: f64,
    target_vx: f64,
    target_vy: f64,
    target_vz: f64,
    target_ax: f64,
    target_ay: f64,
    target_az: f64,
    origin_ax: f64,
    origin_ay: f64,
    origin_az: f64,
    projectile_speed: f64,
    projectile_mass: f64,
    projectile_air_friction_per_60hz_frame: f64,
    gravity: f64,
    arc_preference: u8,
    max_time_sec_or_zero: f64,
    fallback_yaw: f64,
    fallback_pitch: f64,
) -> u32 {
    let pool = combat_targeting_pool();
    combat_targeting_solve_ballistic_aim_inner(
        pool,
        entity_slot,
        turret_idx,
        target_x,
        target_y,
        target_z,
        target_vx,
        target_vy,
        target_vz,
        target_ax,
        target_ay,
        target_az,
        origin_ax,
        origin_ay,
        origin_az,
        projectile_speed,
        projectile_mass,
        projectile_air_friction_per_60hz_frame,
        gravity,
        arc_preference,
        max_time_sec_or_zero,
        fallback_yaw,
        fallback_pitch,
    )
}

/// Inner helper for the ballistic solver. Takes the slab by &mut so
/// the kernel can be called from other batched paths that already hold
/// the pool reference (e.g. the unified priority-point gate+FSM batch).
/// All slab reads/writes live here; the wasm-bindgen entry above is a
/// thin wrapper that acquires the pool then defers to this.
pub(crate) fn combat_targeting_solve_ballistic_aim_inner(
    pool: &mut CombatTargetingPool,
    entity_slot: u32,
    turret_idx: u32,
    target_x: f64,
    target_y: f64,
    target_z: f64,
    target_vx: f64,
    target_vy: f64,
    target_vz: f64,
    target_ax: f64,
    target_ay: f64,
    target_az: f64,
    origin_ax: f64,
    origin_ay: f64,
    origin_az: f64,
    projectile_speed: f64,
    projectile_mass: f64,
    projectile_air_friction_per_60hz_frame: f64,
    gravity: f64,
    arc_preference: u8,
    max_time_sec_or_zero: f64,
    fallback_yaw: f64,
    fallback_pitch: f64,
) -> u32 {
    if turret_idx >= COMBAT_TARGETING_MAX_TURRETS_PER_ENTITY {
        return 0;
    }
    let entity_idx = entity_slot as usize;
    if entity_idx >= pool.entity_id.len() {
        return 0;
    }

    let idx = combat_targeting_turret_global_idx(entity_slot, turret_idx);
    let mount_x = pool.turret_mount_x[idx];
    let mount_y = pool.turret_mount_y[idx];
    let mount_z = pool.turret_mount_z[idx];
    let mount_vx = pool.turret_mount_vx[idx];
    let mount_vy = pool.turret_mount_vy[idx];
    let mount_vz = pool.turret_mount_vz[idx];
    if turret_idx >= pool.turret_count_per_entity[entity_idx] as u32 {
        combat_targeting_write_no_ballistic_solution(
            pool,
            idx,
            mount_x,
            mount_y,
            mount_z,
            fallback_yaw,
            fallback_pitch,
        );
        return 0;
    }

    let finite_values = [
        mount_x,
        mount_y,
        mount_z,
        mount_vx,
        mount_vy,
        mount_vz,
        target_x,
        target_y,
        target_z,
        target_vx,
        target_vy,
        target_vz,
        target_ax,
        target_ay,
        target_az,
        origin_ax,
        origin_ay,
        origin_az,
        projectile_speed,
        projectile_mass,
        projectile_air_friction_per_60hz_frame,
        gravity,
        max_time_sec_or_zero,
        fallback_yaw,
        fallback_pitch,
    ];
    if !combat_targeting_ballistic_params_finite(&finite_values)
        || projectile_speed <= 1e-6
        || (projectile_air_friction_per_60hz_frame > 0.0 && projectile_mass <= 1e-6)
        || projectile_air_friction_per_60hz_frame < 0.0
        || projectile_air_friction_per_60hz_frame >= 1.0
        || gravity < 0.0
        || max_time_sec_or_zero < 0.0
    {
        combat_targeting_write_no_ballistic_solution(
            pool,
            idx,
            mount_x,
            mount_y,
            mount_z,
            fallback_yaw,
            fallback_pitch,
        );
        return 0;
    }

    let input = [
        mount_x,
        mount_y,
        mount_z,
        mount_vx,
        mount_vy,
        mount_vz,
        origin_ax,
        origin_ay,
        origin_az,
        target_x,
        target_y,
        target_z,
        target_vx,
        target_vy,
        target_vz,
        target_ax,
        target_ay,
        target_az,
        0.0,
        0.0,
        -gravity,
        projectile_speed,
    ];
    let mut solution = [0.0_f64; 7];
    let found = if arc_preference == CT_BALLISTIC_ARC_HIGH {
        let mut low_solution = [0.0_f64; 7];
        let low_found = solve_damped_kinematic_intercept_inline(
            &input,
            &mut low_solution,
            0,
            max_time_sec_or_zero,
            projectile_air_friction_per_60hz_frame,
            projectile_mass,
            pool.wind_x,
            pool.wind_y,
            pool.wind_z,
        );
        let high_found = solve_damped_kinematic_intercept_inline(
            &input,
            &mut solution,
            1,
            max_time_sec_or_zero,
            projectile_air_friction_per_60hz_frame,
            projectile_mass,
            pool.wind_x,
            pool.wind_y,
            pool.wind_z,
        );
        high_found && low_found && solution[0] > low_solution[0] + CT_HIGH_ARC_MIN_TIME_SEPARATION
    } else {
        solve_damped_kinematic_intercept_inline(
            &input,
            &mut solution,
            0,
            max_time_sec_or_zero,
            projectile_air_friction_per_60hz_frame,
            projectile_mass,
            pool.wind_x,
            pool.wind_y,
            pool.wind_z,
        )
    };

    if !found {
        combat_targeting_write_no_ballistic_solution(
            pool,
            idx,
            mount_x,
            mount_y,
            mount_z,
            fallback_yaw,
            fallback_pitch,
        );
        return 0;
    }

    // ── Muzzle correction ──────────────────────────────────────────────
    // The solve above launches from the turret PIVOT, but the shell leaves the
    // barrel tip tens of units downrange along the very arc just solved. A
    // projectile released that far into its own trajectory has not fallen the
    // corresponding amount when it reaches the target, so it arrives high and
    // sails over the top — a systematic, range-dependent overshoot on every
    // barrel-offset ballistic weapon.
    //
    // Displace the launch origin to where the shot is actually released and
    // solve again. The offset runs along the aim direction, which the first
    // solve just produced, so one refinement is a fixed-point step; the turret
    // re-solves every tick and settles long before the firing gate opens.
    // A refinement that fails to converge keeps the pivot solution rather than
    // dropping the lock: a slightly-high shot beats no shot.
    let muzzle_offset = pool.turret_muzzle_forward_offset[idx];
    if muzzle_offset > CT_SHOT_DIRECTION_EPSILON {
        let first_speed = (solution[4] * solution[4]
            + solution[5] * solution[5]
            + solution[6] * solution[6])
            .sqrt();
        if first_speed > CT_SHOT_DIRECTION_EPSILON {
            let mut refined_input = input;
            refined_input[0] = mount_x + solution[4] / first_speed * muzzle_offset;
            refined_input[1] = mount_y + solution[5] / first_speed * muzzle_offset;
            refined_input[2] = mount_z + solution[6] / first_speed * muzzle_offset;
            let mut refined = [0.0_f64; 7];
            let refined_found = solve_damped_kinematic_intercept_inline(
                &refined_input,
                &mut refined,
                if arc_preference == CT_BALLISTIC_ARC_HIGH { 1 } else { 0 },
                max_time_sec_or_zero,
                projectile_air_friction_per_60hz_frame,
                projectile_mass,
                pool.wind_x,
                pool.wind_y,
                pool.wind_z,
            );
            if refined_found {
                solution = refined;
            }
        }
    }

    let launch_vx = solution[4];
    let launch_vy = solution[5];
    let launch_vz = solution[6];
    let horizontal = (launch_vx * launch_vx + launch_vy * launch_vy).sqrt();
    let speed = (horizontal * horizontal + launch_vz * launch_vz).sqrt();
    if !speed.is_finite() || speed <= CT_SHOT_DIRECTION_EPSILON {
        combat_targeting_write_no_ballistic_solution(
            pool,
            idx,
            mount_x,
            mount_y,
            mount_z,
            fallback_yaw,
            fallback_pitch,
        );
        return 0;
    }

    let yaw = if horizontal > CT_SHOT_DIRECTION_EPSILON {
        launch_vy.atan2(launch_vx)
    } else {
        (solution[2] - mount_y).atan2(solution[1] - mount_x)
    };
    let pitch = launch_vz.atan2(horizontal);
    let dir_x = launch_vx / speed;
    let dir_y = launch_vy / speed;
    let dir_z = launch_vz / speed;
    let aim_dx = solution[1] - mount_x;
    let aim_dy = solution[2] - mount_y;
    let aim_dz = solution[3] - mount_z;
    let distance_to_intercept = (aim_dx * aim_dx + aim_dy * aim_dy + aim_dz * aim_dz)
        .sqrt()
        .max(1.0);

    pool.turret_ballistic_has_solution[idx] = 1;
    pool.turret_ballistic_flight_time[idx] = solution[0];
    pool.turret_ballistic_launch_vx[idx] = launch_vx;
    pool.turret_ballistic_launch_vy[idx] = launch_vy;
    pool.turret_ballistic_launch_vz[idx] = launch_vz;
    pool.turret_ballistic_yaw[idx] = yaw as f32;
    pool.turret_ballistic_pitch[idx] = pitch as f32;
    pool.turret_ballistic_aim_x[idx] = mount_x + dir_x * distance_to_intercept;
    pool.turret_ballistic_aim_y[idx] = mount_y + dir_y * distance_to_intercept;
    pool.turret_ballistic_aim_z[idx] = mount_z + dir_z * distance_to_intercept;
    1
}

// ─────────────────────────────────────────────────────────────────
// AIM-08.3 — Target candidate scoring + ranking kernel.
//
// TypeScript still owns candidate stamping and the expensive fire
// gates that have not migrated yet (LOS/shield/ballistic), but
// the cheap per-candidate score, target preference ranks, shield-panel
// ordering, top-K bubble sort, and fallback budget now run in Rust.
// The JS side calls this once per turret candidate slice and receives
// the chosen local candidate index plus its rank/dist/shield-panel tuple.
// ─────────────────────────────────────────────────────────────────

pub(crate) const CT_TARGET_RANK_NONE: u8 = 0;
pub(crate) const CT_TARGET_RANK_TRACKING_ONLY: u8 = 1;
pub(crate) const CT_TARGET_RANK_FIRE_FALLBACK: u8 = 2;
pub(crate) const CT_TARGET_RANK_FIRE_PREFERRED: u8 = 3;

pub(crate) const CT_TARGET_RANK_MODE_FIRE: u8 = 0;
pub(crate) const CT_TARGET_RANK_MODE_ACQUISITION: u8 = 1;

pub(crate) const CT_TARGET_EDGE_RELEASE: u8 = 1;

pub(crate) const TARGETING_TOPK_LOS: usize = 4;
pub(crate) const TARGETING_FALLBACK_LOS_BUDGET: u32 = 12;
// Sensor coverage uses getEntityDetectionPadding on the target side,
// which can exceed the generic spatial shot-radius pad. Keep this
// broadphase pad conservative so a large unit straddling a sensor rim
// still reaches the precise distance check.
pub(crate) const COMBAT_TARGETING_SENSOR_QUERY_PAD: f64 = 128.0;
pub(crate) const COMBAT_TARGETING_OBSERVATION_CELL_SIZE: f64 = 512.0;
pub(crate) const COMBAT_TARGETING_OWNERLESS_OBSERVATION_BIT: u32 = 1u32 << 31;
pub(crate) const COMBAT_TARGETING_INVALID_CANDIDATE_SLOT: u32 = u32::MAX;
pub(crate) const CT_TARGETING_PREP_HAS_APPLY: u8 = 1;
pub(crate) const CT_TARGETING_PREP_HAS_PASSIVE_APPLY: u8 = 1 << 1;
pub(crate) const CT_TARGETING_TICK_MODE_AUTO: u8 = 0;
pub(crate) const CT_TARGETING_TICK_MODE_PRIORITY_POINT: u8 = 1;
pub(crate) const CT_TARGETING_TICK_MODE_PRIORITY_TARGET: u8 = 2;
pub(crate) const CT_TARGETING_TICK_MODE_CLEAR_LOCKS: u8 = 3;
pub(crate) const CT_TARGETING_TICK_MODE_SKIP: u8 = 255;
pub(crate) const CT_TARGETING_CANDIDATE_REL_FRIENDLY: u8 = 1 << 0;
pub(crate) const CT_TARGETING_CANDIDATE_REL_ENEMY: u8 = 1 << 1;

#[inline]
pub(crate) fn combat_targeting_live_turret_idx(
    pool: &CombatTargetingPool,
    entity_slot: u32,
    turret_idx: u32,
) -> Option<usize> {
    let entity_idx = entity_slot as usize;
    if entity_idx >= pool.turret_count_per_entity.len() {
        return None;
    }
    if turret_idx >= pool.turret_count_per_entity[entity_idx] as u32 {
        return None;
    }
    if turret_idx >= COMBAT_TARGETING_MAX_TURRETS_PER_ENTITY {
        return None;
    }
    Some(combat_targeting_turret_global_idx(entity_slot, turret_idx))
}

#[inline]
pub(crate) fn combat_targeting_set_target_state(
    pool: &mut CombatTargetingPool,
    idx: usize,
    target_id: i32,
    state: u8,
) {
    if pool.turret_target_id[idx] != target_id {
        pool.turret_los_blocked_ticks[idx] = 0;
    }
    pool.turret_target_id[idx] = target_id;
    pool.turret_state[idx] = state;
}

#[inline]
pub(crate) fn combat_targeting_entity_alive(
    pool: &CombatTargetingPool,
    entity_slot: usize,
) -> bool {
    entity_slot < pool.entity_flags.len()
        && (pool.entity_flags[entity_slot] & CT_ENTITY_FLAG_ALIVE) != 0
}

#[inline]
pub(crate) fn combat_targeting_player_bit(player_id: u8) -> u32 {
    if player_id == 0 || player_id > 31 {
        0
    } else {
        1u32 << ((player_id - 1) as u32)
    }
}

#[inline]
pub(crate) fn combat_targeting_entity_online_for_sensors(
    pool: &CombatTargetingPool,
    slot: usize,
) -> bool {
    slot < pool.entity_flags.len()
        && pool.entity_id[slot] >= 0
        && (pool.entity_flags[slot] & CT_ENTITY_FLAG_ALIVE) != 0
        && (pool.entity_flags[slot] & CT_ENTITY_FLAG_BUILDABLE_COMPLETE) != 0
}

#[inline]
pub(crate) fn combat_targeting_observation_cell_coord(value: f64) -> i32 {
    (value / COMBAT_TARGETING_OBSERVATION_CELL_SIZE).floor() as i32
}

#[inline]
pub(crate) fn combat_targeting_observation_cell_key(cx: i32, cy: i32) -> u64 {
    pack_contact_cell_key(cx, cy, 0)
}

#[inline]
pub(crate) fn combat_targeting_observation_cell_coords_from_key(key: u64) -> (i32, i32) {
    let cyb = ((key >> 16) & 0xFFFF) as i64;
    let cxb = ((key >> 32) & 0xFFFF) as i64;
    (
        (cxb - CONTACT_CELL_BIAS) as i32,
        (cyb - CONTACT_CELL_BIAS) as i32,
    )
}

pub(crate) fn combat_targeting_clear_observation_index(pool: &mut CombatTargetingPool) {
    for key in pool.observation_cell_keys.drain(..) {
        if let Some(cell) = pool.observation_cells.get_mut(&key) {
            cell.slots.clear();
            cell.owner_bits = 0;
            cell.saturated_fact_bits = 0;
        }
    }
    pool.observation_max_detection_padding = 0.0;
}

pub(crate) fn combat_targeting_insert_observation_index_slot(
    pool: &mut CombatTargetingPool,
    slot: usize,
) {
    if slot >= pool.entity_flags.len()
        || pool.entity_id[slot] < 0
        || !combat_targeting_entity_alive(pool, slot)
    {
        return;
    }
    let x = pool.entity_pos_x[slot];
    let y = pool.entity_pos_y[slot];
    if !x.is_finite() || !y.is_finite() {
        return;
    }
    let padding = (pool.entity_detection_padding[slot] as f64).max(0.0);
    if padding.is_finite() {
        pool.observation_max_detection_padding =
            pool.observation_max_detection_padding.max(padding);
    }
    let cx = combat_targeting_observation_cell_coord(x);
    let cy = combat_targeting_observation_cell_coord(y);
    let key = combat_targeting_observation_cell_key(cx, cy);
    let cell = pool.observation_cells.entry(key).or_default();
    if cell.slots.is_empty() {
        pool.observation_cell_keys.push(key);
    }
    cell.slots.push(slot as u32);
    let owner_bit = pool.entity_owner_bit[slot];
    cell.owner_bits |= if owner_bit == 0 {
        COMBAT_TARGETING_OWNERLESS_OBSERVATION_BIT
    } else {
        owner_bit
    };
}

pub(crate) fn combat_targeting_rebuild_observation_index(pool: &mut CombatTargetingPool) {
    combat_targeting_clear_observation_index(pool);
    let n = pool.entity_flags.len();
    for slot in 0..n {
        combat_targeting_insert_observation_index_slot(pool, slot);
    }
}

// Lane bits combat_targeting_mark_observed_slot reports back to the cell
// walk. A lane is "covered" for saturation purposes when the slot cannot
// take that mark from ANY same-owner source this tick: already marked,
// medium-impossible, or the source's own unit. Uncovered lanes keep the
// cell unsaturated so later (possibly larger-radius) sources still walk it.
pub(crate) const CT_OBSERVED_LANE_CONTACT: u8 = 1 << 0;
pub(crate) const CT_OBSERVED_LANE_SIGHT: u8 = 1 << 1;
pub(crate) const CT_OBSERVED_LANE_DETECTOR: u8 = 1 << 2;
pub(crate) const CT_OBSERVED_LANES_ALL: u8 =
    CT_OBSERVED_LANE_CONTACT | CT_OBSERVED_LANE_SIGHT | CT_OBSERVED_LANE_DETECTOR;
const CT_OBSERVATION_TERRAIN_LOS_STEP_LEN: f64 = MAP_LAND_CELL_SIZE * 0.5;

#[inline]
fn combat_targeting_observation_has_terrain_los(
    source_x: f64,
    source_y: f64,
    source_z: f64,
    target_x: f64,
    target_y: f64,
    target_z: f64,
) -> bool {
    // A missing mesh is possible in small isolated kernel tests. Runtime
    // worlds install the authoritative mesh before combat begins; no mesh
    // means there is no terrain occluder to reject here.
    terrain_has_line_of_sight(
        source_x,
        source_y,
        source_z,
        target_x,
        target_y,
        target_z,
        CT_OBSERVATION_TERRAIN_LOS_STEP_LEN,
    ) != 0
}

/// Returns the lanes still UNCOVERED for this slot after any marks were
/// applied. Mask writes are unchanged from the pre-saturation version —
/// the return value is bookkeeping only.
#[inline]
pub(crate) fn combat_targeting_mark_observed_slot(
    target_slot: usize,
    entity_owner_bit: &[u32],
    entity_pos_x: &[f64],
    entity_pos_y: &[f64],
    entity_pos_z: &[f64],
    entity_flags: &[u8],
    entity_above_water_fraction: &[f32],
    entity_underwater_fraction: &[f32],
    radar_jammer_team_mask: &[u32],
    sonar_jammer_team_mask: &[u32],
    team_air_sight_mask: &mut [u32],
    team_water_sight_mask: &mut [u32],
    team_air_radar_mask: &mut [u32],
    team_water_sonar_mask: &mut [u32],
    sensor_coverage_mask: &mut [u32],
    full_sight_coverage_mask: &mut [u32],
    detector_coverage_mask: &mut [u32],
    source_x: f64,
    source_y: f64,
    source_z: f64,
    contact_radius: f64,
    full_sight_radius: f64,
    detector_radius: f64,
    owner_bit: u32,
    source_team_bit: u32,
    target_medium: u8,
) -> u8 {
    let target_owner_bit = entity_owner_bit[target_slot];
    if target_owner_bit == owner_bit {
        return 0;
    }
    if (target_medium == CT_OBSERVATION_TARGET_WATER
        && entity_underwater_fraction[target_slot] <= 0.0)
        || (target_medium == CT_OBSERVATION_TARGET_AIR
            && entity_above_water_fraction[target_slot] <= 0.0)
    {
        // Medium-impossible: no source can mark this slot this tick
        // (occupancy fractions are stamped before marking and only
        // change on the next stamp).
        return 0;
    }
    let contact_marked = if target_medium == CT_OBSERVATION_TARGET_AIR {
        (team_air_radar_mask[target_slot] & owner_bit) != 0
    } else {
        (team_water_sonar_mask[target_slot] & owner_bit) != 0
    };
    let full_sight_marked = if target_medium == CT_OBSERVATION_TARGET_AIR {
        (team_air_sight_mask[target_slot] & owner_bit) != 0
    } else {
        (team_water_sight_mask[target_slot] & owner_bit) != 0
    };
    let detector_marked = (detector_coverage_mask[target_slot] & owner_bit) != 0;
    let contact_denied = if target_medium == CT_OBSERVATION_TARGET_AIR {
        (entity_flags[target_slot] & CT_ENTITY_FLAG_RADAR_STEALTH) != 0
            || (radar_jammer_team_mask[target_slot] & !source_team_bit) != 0
    } else {
        (entity_flags[target_slot] & CT_ENTITY_FLAG_SONAR_STEALTH) != 0
            || (sonar_jammer_team_mask[target_slot] & !source_team_bit) != 0
    };
    let contact_already_marked = contact_radius <= 0.0 || contact_marked || contact_denied;
    let full_sight_already_marked = full_sight_radius <= 0.0 || full_sight_marked;
    let detector_already_marked = detector_radius <= 0.0 || detector_marked;
    let mut uncovered = 0u8;
    if !contact_marked {
        uncovered |= CT_OBSERVED_LANE_CONTACT;
    }
    if !full_sight_marked {
        uncovered |= CT_OBSERVED_LANE_SIGHT;
    }
    if !detector_marked {
        uncovered |= CT_OBSERVED_LANE_DETECTOR;
    }
    // Contact stealth and a hostile jammer are target/view-team facts. No
    // alternate source owned by this player can overcome them, so count the
    // lane as settled for cell saturation while leaving the contact bit clear.
    if contact_denied {
        uncovered &= !CT_OBSERVED_LANE_CONTACT;
    }
    if contact_already_marked && full_sight_already_marked && detector_already_marked {
        return uncovered;
    }
    let dx = entity_pos_x[target_slot] - source_x;
    let dy = entity_pos_y[target_slot] - source_y;
    let distance_sq = dx * dx + dy * dy;
    let contact_in_range = !contact_already_marked && distance_sq <= contact_radius * contact_radius;
    let sight_in_range =
        !full_sight_already_marked && distance_sq <= full_sight_radius * full_sight_radius;
    let detector_in_range =
        !detector_already_marked && distance_sq <= detector_radius * detector_radius;
    let needs_los = sight_in_range
        || detector_in_range
        || (target_medium == CT_OBSERVATION_TARGET_AIR && contact_in_range);
    let has_los = !needs_los || combat_targeting_observation_has_terrain_los(
        source_x,
        source_y,
        source_z,
        entity_pos_x[target_slot],
        entity_pos_y[target_slot],
        entity_pos_z[target_slot],
    );
    if contact_in_range && (target_medium == CT_OBSERVATION_TARGET_WATER || has_los) {
        if target_medium == CT_OBSERVATION_TARGET_AIR {
            team_air_radar_mask[target_slot] |= owner_bit;
        } else {
            team_water_sonar_mask[target_slot] |= owner_bit;
        }
        sensor_coverage_mask[target_slot] |= owner_bit;
        uncovered &= !CT_OBSERVED_LANE_CONTACT;
    }
    if sight_in_range && has_los {
        if target_medium == CT_OBSERVATION_TARGET_AIR {
            team_air_sight_mask[target_slot] |= owner_bit;
        } else {
            team_water_sight_mask[target_slot] |= owner_bit;
        }
        sensor_coverage_mask[target_slot] |= owner_bit;
        full_sight_coverage_mask[target_slot] |= owner_bit;
        uncovered &= !CT_OBSERVED_LANE_SIGHT;
    }
    if detector_in_range && has_los {
        detector_coverage_mask[target_slot] |= owner_bit;
        uncovered &= !CT_OBSERVED_LANE_DETECTOR;
    }
    uncovered
}

#[inline]
pub(crate) fn combat_targeting_mark_observation_cell(
    cell: &mut CombatTargetingObservationCell,
    entity_owner_bit: &[u32],
    entity_pos_x: &[f64],
    entity_pos_y: &[f64],
    entity_pos_z: &[f64],
    entity_flags: &[u8],
    entity_above_water_fraction: &[f32],
    entity_underwater_fraction: &[f32],
    radar_jammer_team_mask: &[u32],
    sonar_jammer_team_mask: &[u32],
    team_air_sight_mask: &mut [u32],
    team_water_sight_mask: &mut [u32],
    team_air_radar_mask: &mut [u32],
    team_water_sonar_mask: &mut [u32],
    sensor_coverage_mask: &mut [u32],
    full_sight_coverage_mask: &mut [u32],
    detector_coverage_mask: &mut [u32],
    source_x: f64,
    source_y: f64,
    source_z: f64,
    contact_radius: f64,
    full_sight_radius: f64,
    detector_radius: f64,
    owner_bit: u32,
    source_team_bit: u32,
    target_medium: u8,
) {
    if cell.owner_bits != 0 && (cell.owner_bits & !owner_bit) == 0 {
        return;
    }
    // Saturation fast path: in an army blob, the first same-owner source
    // marks everything reachable in this cell and the second certifies
    // saturation; every later same-owner source skips the slot walk with
    // one mask test. Owners past index 7 don't fit the u64 and take the
    // ordinary walk.
    let owner_index = owner_bit.trailing_zeros();
    let lane_base = if target_medium == CT_OBSERVATION_TARGET_AIR { 0 } else { 3 };
    let saturation_base = (owner_index as u64) * 6 + lane_base;
    let saturation_supported = owner_index < 8;
    if saturation_supported {
        let mut needed: u64 = 0;
        if contact_radius > 0.0 {
            needed |= 1u64 << saturation_base;
        }
        if full_sight_radius > 0.0 {
            needed |= 1u64 << (saturation_base + 1);
        }
        if detector_radius > 0.0 {
            needed |= 1u64 << (saturation_base + 2);
        }
        if needed != 0 && (needed & !cell.saturated_fact_bits) == 0 {
            return;
        }
    }
    let mut all_covered = CT_OBSERVED_LANES_ALL;
    for &slot in &cell.slots {
        let uncovered = combat_targeting_mark_observed_slot(
            slot as usize,
            entity_owner_bit,
            entity_pos_x,
            entity_pos_y,
            entity_pos_z,
            entity_flags,
            entity_above_water_fraction,
            entity_underwater_fraction,
            radar_jammer_team_mask,
            sonar_jammer_team_mask,
            team_air_sight_mask,
            team_water_sight_mask,
            team_air_radar_mask,
            team_water_sonar_mask,
            sensor_coverage_mask,
            full_sight_coverage_mask,
            detector_coverage_mask,
            source_x,
            source_y,
            source_z,
            contact_radius,
            full_sight_radius,
            detector_radius,
            owner_bit,
            source_team_bit,
            target_medium,
        );
        all_covered &= !uncovered;
    }
    if saturation_supported {
        if all_covered & CT_OBSERVED_LANE_CONTACT != 0 {
            cell.saturated_fact_bits |= 1u64 << saturation_base;
        }
        if all_covered & CT_OBSERVED_LANE_SIGHT != 0 {
            cell.saturated_fact_bits |= 1u64 << (saturation_base + 1);
        }
        if all_covered & CT_OBSERVED_LANE_DETECTOR != 0 {
            cell.saturated_fact_bits |= 1u64 << (saturation_base + 2);
        }
    }
}

pub(crate) const CT_OBSERVATION_TARGET_AIR: u8 = 1;
pub(crate) const CT_OBSERVATION_TARGET_WATER: u8 = 2;

/// Result-identical cell rejection for the observation sweep: the
/// square bound walks every cell in [source ± query_radius]², but a
/// slot can only be marked when its distance to the source is within
/// one of the acceptance radii, all of which query_radius bounds. A
/// cell whose rect lies wholly outside the query circle (~21% of the
/// square's cells) therefore cannot mark anything and is skipped
/// before its slot walk (and, on the dense path, before its hash
/// lookup).
#[inline]
fn observation_cell_outside_radius(cx: i32, cy: i32, source_x: f64, source_y: f64, radius: f64) -> bool {
    let min_x = f64::from(cx) * COMBAT_TARGETING_OBSERVATION_CELL_SIZE;
    let min_y = f64::from(cy) * COMBAT_TARGETING_OBSERVATION_CELL_SIZE;
    let dx = (min_x - source_x)
        .max(source_x - (min_x + COMBAT_TARGETING_OBSERVATION_CELL_SIZE))
        .max(0.0);
    let dy = (min_y - source_y)
        .max(source_y - (min_y + COMBAT_TARGETING_OBSERVATION_CELL_SIZE))
        .max(0.0);
    dx * dx + dy * dy > radius * radius
}

#[inline]
fn combat_targeting_valid_observation_radius(radius: f64) -> f64 {
    if radius.is_finite() && radius > 0.0 {
        radius
    } else {
        0.0
    }
}

/// Marks independently-sized contact, full-sight, and detector circles for
/// one target medium in a single spatial traversal. The four orthogonal team
/// knowledge masks retain whether air sight, water sight, radar, or sonar
/// earned the knowledge; the older union masks are derived in the same pass.
pub(crate) fn combat_targeting_mark_observation_circles(
    pool: &mut CombatTargetingPool,
    source_x: f64,
    source_y: f64,
    source_z: f64,
    owner_bit: u32,
    source_team_bit: u32,
    contact_radius: f64,
    full_sight_radius: f64,
    detector_radius: f64,
    target_medium: u8,
) {
    if owner_bit == 0
        || source_team_bit == 0
        || !source_x.is_finite()
        || !source_y.is_finite()
        || !source_z.is_finite()
    {
        return;
    }
    debug_assert!(
        target_medium == CT_OBSERVATION_TARGET_AIR || target_medium == CT_OBSERVATION_TARGET_WATER
    );
    let contact_radius = combat_targeting_valid_observation_radius(contact_radius);
    let full_sight_radius = combat_targeting_valid_observation_radius(full_sight_radius);
    let detector_radius = combat_targeting_valid_observation_radius(detector_radius);
    let max_radius = contact_radius.max(full_sight_radius).max(detector_radius);
    if max_radius <= 0.0 {
        return;
    }

    let query_radius = max_radius
        + pool
            .observation_max_detection_padding
            .max(COMBAT_TARGETING_SENSOR_QUERY_PAD);
    let min_cx = combat_targeting_observation_cell_coord(source_x - query_radius);
    let max_cx = combat_targeting_observation_cell_coord(source_x + query_radius);
    let min_cy = combat_targeting_observation_cell_coord(source_y - query_radius);
    let max_cy = combat_targeting_observation_cell_coord(source_y + query_radius);
    let entity_owner_bit = &pool.entity_owner_bit;
    let entity_pos_x = &pool.entity_pos_x;
    let entity_pos_y = &pool.entity_pos_y;
    let entity_pos_z = &pool.entity_pos_z;
    let entity_flags = &pool.entity_flags;
    let entity_above_water_fraction = &pool.entity_above_water_fraction;
    let entity_underwater_fraction = &pool.entity_underwater_fraction;
    let radar_jammer_team_mask = &pool.entity_radar_jammer_team_mask;
    let sonar_jammer_team_mask = &pool.entity_sonar_jammer_team_mask;
    let observation_cells = &mut pool.observation_cells;
    let observation_cell_keys = &pool.observation_cell_keys;
    let team_air_sight_mask = &mut pool.entity_team_air_sight_mask;
    let team_water_sight_mask = &mut pool.entity_team_water_sight_mask;
    let team_air_radar_mask = &mut pool.entity_team_air_radar_mask;
    let team_water_sonar_mask = &mut pool.entity_team_water_sonar_mask;
    let sensor_coverage_mask = &mut pool.entity_sensor_coverage_mask;
    let full_sight_coverage_mask = &mut pool.entity_full_sight_coverage_mask;
    let detector_coverage_mask = &mut pool.entity_detector_coverage_mask;
    let cells_x = (max_cx - min_cx + 1) as i64;
    let cells_y = (max_cy - min_cy + 1) as i64;
    if cells_x <= 0 || cells_y <= 0 {
        return;
    }
    let cell_count = cells_x.saturating_mul(cells_y);
    if cell_count > observation_cell_keys.len() as i64 {
        for &key in observation_cell_keys {
            let (cx, cy) = combat_targeting_observation_cell_coords_from_key(key);
            if cx < min_cx || cx > max_cx || cy < min_cy || cy > max_cy {
                continue;
            }
            if observation_cell_outside_radius(cx, cy, source_x, source_y, query_radius) {
                continue;
            }
            let Some(cell) = observation_cells.get_mut(&key) else {
                continue;
            };
            combat_targeting_mark_observation_cell(
                cell,
                entity_owner_bit,
                entity_pos_x,
                entity_pos_y,
                entity_pos_z,
                entity_flags,
                entity_above_water_fraction,
                entity_underwater_fraction,
                radar_jammer_team_mask,
                sonar_jammer_team_mask,
                team_air_sight_mask,
                team_water_sight_mask,
                team_air_radar_mask,
                team_water_sonar_mask,
                sensor_coverage_mask,
                full_sight_coverage_mask,
                detector_coverage_mask,
                source_x,
                source_y,
                source_z,
                contact_radius,
                full_sight_radius,
                detector_radius,
                owner_bit,
                source_team_bit,
                target_medium,
            );
        }
        return;
    }
    for cx in min_cx..=max_cx {
        for cy in min_cy..=max_cy {
            if observation_cell_outside_radius(cx, cy, source_x, source_y, query_radius) {
                continue;
            }
            let key = combat_targeting_observation_cell_key(cx, cy);
            let cell = match observation_cells.get_mut(&key) {
                Some(cell) => cell,
                None => continue,
            };
            combat_targeting_mark_observation_cell(
                cell,
                entity_owner_bit,
                entity_pos_x,
                entity_pos_y,
                entity_pos_z,
                entity_flags,
                entity_above_water_fraction,
                entity_underwater_fraction,
                radar_jammer_team_mask,
                sonar_jammer_team_mask,
                team_air_sight_mask,
                team_water_sight_mask,
                team_air_radar_mask,
                team_water_sonar_mask,
                sensor_coverage_mask,
                full_sight_coverage_mask,
                detector_coverage_mask,
                source_x,
                source_y,
                source_z,
                contact_radius,
                full_sight_radius,
                detector_radius,
                owner_bit,
                source_team_bit,
                target_medium,
            );
        }
    }
}

#[inline]
fn combat_targeting_mark_jammer_cell(
    cell: &CombatTargetingObservationCell,
    entity_pos_x: &[f64],
    entity_pos_y: &[f64],
    jammer_team_mask: &mut [u32],
    source_x: f64,
    source_y: f64,
    radius_sq: f64,
    source_team_bit: u32,
) {
    for &slot in &cell.slots {
        let target_slot = slot as usize;
        let dx = entity_pos_x[target_slot] - source_x;
        let dy = entity_pos_y[target_slot] - source_y;
        if dx * dx + dy * dy <= radius_sq {
            jammer_team_mask[target_slot] |= source_team_bit;
        }
    }
}

/// Stamp one jammer into the target spatial index. This is deliberately a
/// source-to-nearby-target pass: the old target-to-every-sensor query made one
/// jammer activate an O(targets * all sensor sources) scan.
fn combat_targeting_mark_jammer_circle(
    pool: &mut CombatTargetingPool,
    source_x: f64,
    source_y: f64,
    source_team_bit: u32,
    radius: f64,
    underwater: bool,
) {
    let radius = combat_targeting_valid_observation_radius(radius);
    if radius <= 0.0
        || source_team_bit == 0
        || !source_x.is_finite()
        || !source_y.is_finite()
    {
        return;
    }
    let min_cx = combat_targeting_observation_cell_coord(source_x - radius);
    let max_cx = combat_targeting_observation_cell_coord(source_x + radius);
    let min_cy = combat_targeting_observation_cell_coord(source_y - radius);
    let max_cy = combat_targeting_observation_cell_coord(source_y + radius);
    let entity_pos_x = &pool.entity_pos_x;
    let entity_pos_y = &pool.entity_pos_y;
    let observation_cells = &pool.observation_cells;
    let observation_cell_keys = &pool.observation_cell_keys;
    let jammer_team_mask = if underwater {
        &mut pool.entity_sonar_jammer_team_mask
    } else {
        &mut pool.entity_radar_jammer_team_mask
    };
    let cells_x = (max_cx - min_cx + 1) as i64;
    let cells_y = (max_cy - min_cy + 1) as i64;
    if cells_x <= 0 || cells_y <= 0 {
        return;
    }
    let radius_sq = radius * radius;
    let cell_count = cells_x.saturating_mul(cells_y);
    if cell_count > observation_cell_keys.len() as i64 {
        for &key in observation_cell_keys {
            let (cx, cy) = combat_targeting_observation_cell_coords_from_key(key);
            if cx < min_cx || cx > max_cx || cy < min_cy || cy > max_cy {
                continue;
            }
            if observation_cell_outside_radius(cx, cy, source_x, source_y, radius) {
                continue;
            }
            let Some(cell) = observation_cells.get(&key) else {
                continue;
            };
            combat_targeting_mark_jammer_cell(
                cell,
                entity_pos_x,
                entity_pos_y,
                jammer_team_mask,
                source_x,
                source_y,
                radius_sq,
                source_team_bit,
            );
        }
        return;
    }
    for cx in min_cx..=max_cx {
        for cy in min_cy..=max_cy {
            if observation_cell_outside_radius(cx, cy, source_x, source_y, radius) {
                continue;
            }
            let key = combat_targeting_observation_cell_key(cx, cy);
            let Some(cell) = observation_cells.get(&key) else {
                continue;
            };
            combat_targeting_mark_jammer_cell(
                cell,
                entity_pos_x,
                entity_pos_y,
                jammer_team_mask,
                source_x,
                source_y,
                radius_sq,
                source_team_bit,
            );
        }
    }
}

fn combat_targeting_collect_jammer_source_slots(
    pool: &mut CombatTargetingPool,
    source_slots: &[u32],
) {
    pool.observation_radar_jammer_source_slots.clear();
    pool.observation_sonar_jammer_source_slots.clear();
    for &source_slot in source_slots {
        let slot = source_slot as usize;
        if !combat_targeting_entity_online_for_sensors(pool, slot) {
            continue;
        }
        if pool.entity_radar_jam_radius[slot] > 0.0 {
            pool.observation_radar_jammer_source_slots.push(source_slot);
        }
        if pool.entity_sonar_jam_radius[slot] > 0.0 {
            pool.observation_sonar_jammer_source_slots.push(source_slot);
        }
    }
}

fn combat_targeting_rebuild_jammer_masks_for_sources(
    pool: &mut CombatTargetingPool,
    source_slots: &[u32],
) {
    combat_targeting_collect_jammer_source_slots(pool, source_slots);
    for index in 0..pool.observation_radar_jammer_source_slots.len() {
        let slot = pool.observation_radar_jammer_source_slots[index] as usize;
        let team_bit = combat_targeting_player_bit(pool.entity_team_id[slot]);
        combat_targeting_mark_jammer_circle(
            pool,
            pool.entity_sensor_source_x[slot],
            pool.entity_sensor_source_y[slot],
            team_bit,
            pool.entity_radar_jam_radius[slot] as f64,
            false,
        );
    }
    for index in 0..pool.observation_sonar_jammer_source_slots.len() {
        let slot = pool.observation_sonar_jammer_source_slots[index] as usize;
        let team_bit = combat_targeting_player_bit(pool.entity_team_id[slot]);
        combat_targeting_mark_jammer_circle(
            pool,
            pool.entity_sensor_source_x[slot],
            pool.entity_sensor_source_y[slot],
            team_bit,
            pool.entity_sonar_jam_radius[slot] as f64,
            true,
        );
    }
}

#[inline]
pub(crate) fn combat_targeting_mark_observation_from_source_slot(
    pool: &mut CombatTargetingPool,
    source_slot: usize,
) {
    if !combat_targeting_entity_online_for_sensors(pool, source_slot) {
        return;
    }
    let owner_bit = pool.entity_owner_bit[source_slot];
    if owner_bit == 0 {
        return;
    }
    let source_x = pool.entity_sensor_source_x[source_slot];
    let source_y = pool.entity_sensor_source_y[source_slot];
    let source_z = pool.entity_sensor_source_z[source_slot];
    let stamped_team_bit = combat_targeting_player_bit(pool.entity_team_id[source_slot]);
    let source_team_bit = if stamped_team_bit != 0 {
        stamped_team_bit
    } else {
        owner_bit
    };

    let full_above_water_radius = pool.entity_full_vision_above_water_radius[source_slot] as f64;
    let full_underwater_radius = pool.entity_full_vision_underwater_radius[source_slot] as f64;
    let radar_radius = pool.entity_radar_radius[source_slot] as f64;
    let sonar_radius = pool.entity_sonar_radius[source_slot] as f64;
    let detector_above_water_radius = pool.entity_detector_above_water_radius[source_slot] as f64;
    let detector_underwater_radius = pool.entity_detector_underwater_radius[source_slot] as f64;
    // The four team facts stay orthogonal: sight and radar/sonar retain their
    // own target-medium masks. Their derived unions are written in the same
    // two spatial walks, one for each target medium.
    combat_targeting_mark_observation_circles(
        pool,
        source_x,
        source_y,
        source_z,
        owner_bit,
        source_team_bit,
        radar_radius,
        full_above_water_radius,
        detector_above_water_radius,
        CT_OBSERVATION_TARGET_AIR,
    );
    combat_targeting_mark_observation_circles(
        pool,
        source_x,
        source_y,
        source_z,
        owner_bit,
        source_team_bit,
        sonar_radius,
        full_underwater_radius,
        detector_underwater_radius,
        CT_OBSERVATION_TARGET_WATER,
    );
}

/// Rebuilds per-target contact-level coverage masks from stamped sensor
/// sources using the spatial grid. This is the hot-path
/// targeting equivalent of the snapshot visibility aggregate: do the
/// source-radius work once per tick, then every turret candidate can
/// test observability with a bitmask instead of scanning all units.
#[wasm_bindgen]
pub fn combat_targeting_rebuild_observation_masks() {
    let pool = combat_targeting_pool();
    for mask in pool.entity_team_air_sight_mask.iter_mut() {
        *mask = 0;
    }
    for mask in pool.entity_team_water_sight_mask.iter_mut() {
        *mask = 0;
    }
    for mask in pool.entity_team_air_radar_mask.iter_mut() {
        *mask = 0;
    }
    for mask in pool.entity_team_water_sonar_mask.iter_mut() {
        *mask = 0;
    }
    for mask in pool.entity_sensor_coverage_mask.iter_mut() {
        *mask = 0;
    }
    for mask in pool.entity_full_sight_coverage_mask.iter_mut() {
        *mask = 0;
    }
    for mask in pool.entity_detector_coverage_mask.iter_mut() {
        *mask = 0;
    }
    for mask in pool.entity_radar_jammer_team_mask.iter_mut() {
        *mask = 0;
    }
    for mask in pool.entity_sonar_jammer_team_mask.iter_mut() {
        *mask = 0;
    }

    combat_targeting_rebuild_observation_index(pool);
    let n = pool.entity_flags.len();
    let source_slots: Vec<u32> = (0..n as u32).collect();
    combat_targeting_rebuild_jammer_masks_for_sources(pool, &source_slots);
    for &source_slot in &source_slots {
        combat_targeting_mark_observation_from_source_slot(pool, source_slot as usize);
    }
}

/// Hot-path variant used by JS stamping: entity/turret rows have just
/// been cleared and stamped, and JS has compacted the actual sensor source
/// slots while walking live entities. This avoids scanning the whole slot
/// capacity, which can include projectile-created high-water slots.
#[wasm_bindgen]
pub fn combat_targeting_rebuild_observation_masks_for_sources(source_slots: &[u32]) {
    let pool = combat_targeting_pool();
    combat_targeting_rebuild_jammer_masks_for_sources(pool, source_slots);
    for &source_slot in source_slots {
        combat_targeting_mark_observation_from_source_slot(pool, source_slot as usize);
    }
}

/// Adds a temporary full-sight source such as a scan pulse after the
/// entity-source masks have been rebuilt. Full sight is contact-level
/// coverage for targeting, so this marks the same aggregate mask used
/// by radar, sonar, and normal sight sources.
#[wasm_bindgen]
pub fn combat_targeting_add_sensor_observation_circle(
    owner_player_id: u8,
    team_id: u8,
    x: f64,
    y: f64,
    z: f64,
    radius: f64,
) {
    let owner_bit = combat_targeting_player_bit(owner_player_id);
    let team_bit = combat_targeting_player_bit(team_id);
    let pool = combat_targeting_pool();
    // A scan pulse has no source medium and contributes both target-medium
    // sight facts wherever the corresponding target occupancy exists.
    combat_targeting_mark_observation_circles(
        pool,
        x,
        y,
        z,
        owner_bit,
        team_bit,
        0.0,
        radius,
        radius,
        CT_OBSERVATION_TARGET_AIR,
    );
    combat_targeting_mark_observation_circles(
        pool,
        x,
        y,
        z,
        owner_bit,
        team_bit,
        0.0,
        radius,
        radius,
        CT_OBSERVATION_TARGET_WATER,
    );
}

pub(crate) fn combat_targeting_view_mask_covers_entity(
    pool: &CombatTargetingPool,
    target_slot: usize,
    view_mask: u32,
) -> bool {
    if (view_mask & pool.entity_owner_bit[target_slot]) != 0 {
        return true;
    }
    (pool.entity_sensor_coverage_mask[target_slot] & view_mask) != 0
}

/// Targeting observability for one recipient/team view. Contact-level
/// coverage includes full sight.
pub(crate) fn combat_targeting_view_mask_observes_entity(
    pool: &CombatTargetingPool,
    target_slot: usize,
    view_mask: u32,
) -> bool {
    if target_slot >= pool.entity_flags.len() {
        return false;
    }
    let target_flags = pool.entity_flags[target_slot];
    if (target_flags & CT_ENTITY_FLAG_ALIVE) == 0 {
        return false;
    }
    if (view_mask & pool.entity_owner_bit[target_slot]) != 0 {
        return true;
    }
    if (target_flags & CT_ENTITY_FLAG_CLOAKED) != 0 {
        (pool.entity_detector_coverage_mask[target_slot] & view_mask) != 0
    } else {
        combat_targeting_view_mask_covers_entity(pool, target_slot, view_mask)
    }
}

pub(crate) fn combat_targeting_player_observes_entity(
    pool: &CombatTargetingPool,
    target_slot: usize,
    viewer_player_id: u8,
) -> bool {
    combat_targeting_view_mask_observes_entity(
        pool,
        target_slot,
        combat_targeting_player_bit(viewer_player_id),
    )
}

#[inline]
pub(crate) fn combat_targeting_player_observes_entity_id(
    pool: &CombatTargetingPool,
    target_id: i32,
    viewer_player_id: u8,
) -> bool {
    match combat_targeting_entity_slot_for_id(pool, target_id) {
        Some(slot) => combat_targeting_player_observes_entity(pool, slot, viewer_player_id),
        None => false,
    }
}

#[inline]
pub(crate) fn combat_targeting_level1_mask_allows(mask: u32, code: u8) -> bool {
    // Level-1 is a whitelist within an already-included family. An empty
    // mask applies no name restriction (every blueprint in the family is
    // allowed); a non-empty mask admits only the named wire codes.
    if mask == 0 {
        return true;
    }
    code != CT_BLUEPRINT_CODE_NONE && code < 32 && (mask & (1u32 << code)) != 0
}

#[inline]
pub(crate) fn combat_targeting_allowed_relationships_from_inclusions(include: u8) -> u8 {
    let mut relationships = 0u8;
    if (include & CT_LOCK_ON_REL_INCLUDE_FRIENDLY) != 0 {
        relationships |= CT_TARGETING_CANDIDATE_REL_FRIENDLY;
    }
    if (include & CT_LOCK_ON_REL_INCLUDE_ENEMY) != 0 {
        relationships |= CT_TARGETING_CANDIDATE_REL_ENEMY;
    }
    relationships
}

#[inline]
pub(crate) fn combat_targeting_turret_allowed_relationships(
    pool: &CombatTargetingPool,
    idx: usize,
) -> u8 {
    combat_targeting_allowed_relationships_from_inclusions(
        pool.turret_lockon_relationship_mask[idx],
    )
}

#[inline]
pub(crate) fn combat_targeting_owner_relationship_allowed_by_mask(
    pool: &CombatTargetingPool,
    source_entity_slot: usize,
    target_entity_slot: usize,
    allowed_relationships: u8,
) -> bool {
    if source_entity_slot >= pool.entity_team_id.len()
        || target_entity_slot >= pool.entity_team_id.len()
    {
        return false;
    }
    let source_team = pool.entity_team_id[source_entity_slot];
    let target_team = pool.entity_team_id[target_entity_slot];
    let relationship = if source_team == target_team {
        CT_TARGETING_CANDIDATE_REL_FRIENDLY
    } else {
        CT_TARGETING_CANDIDATE_REL_ENEMY
    };
    (allowed_relationships & relationship) != 0
}

#[inline]
pub(crate) fn combat_targeting_turret_owner_relationship_allowed(
    pool: &CombatTargetingPool,
    idx: usize,
    source_entity_slot: usize,
    target_entity_slot: usize,
) -> bool {
    combat_targeting_owner_relationship_allowed_by_mask(
        pool,
        source_entity_slot,
        target_entity_slot,
        combat_targeting_turret_allowed_relationships(pool, idx),
    )
}

#[inline]
pub(crate) fn combat_targeting_lockon_masks_allow_target_turret(
    entity_family_mask: u8,
    turret_mask: u32,
    target_turret_code: u8,
) -> bool {
    if (entity_family_mask & CT_LOCK_ON_FAM_INCLUDE_TURRETS) == 0 {
        return false;
    }
    combat_targeting_level1_mask_allows(turret_mask, target_turret_code)
}

#[inline]
pub(crate) fn combat_targeting_lockon_masks_allow_body_entity(
    pool: &CombatTargetingPool,
    entity_family_mask: u8,
    building_mask: u32,
    tower_mask: u32,
    unit_mask: u32,
    shot_mask: u32,
    target_entity_slot: usize,
) -> bool {
    match pool.entity_family[target_entity_slot] {
        CT_ENTITY_FAMILY_BUILDING => {
            (entity_family_mask & CT_LOCK_ON_FAM_INCLUDE_BUILDINGS) != 0
                && combat_targeting_level1_mask_allows(
                    building_mask,
                    pool.entity_blueprint_code[target_entity_slot],
                )
        }
        CT_ENTITY_FAMILY_TOWER => {
            (entity_family_mask & CT_LOCK_ON_FAM_INCLUDE_TOWERS) != 0
                && combat_targeting_level1_mask_allows(
                    tower_mask,
                    pool.entity_blueprint_code[target_entity_slot],
                )
        }
        CT_ENTITY_FAMILY_UNIT => {
            (entity_family_mask & CT_LOCK_ON_FAM_INCLUDE_UNITS) != 0
                && combat_targeting_level1_mask_allows(
                    unit_mask,
                    pool.entity_blueprint_code[target_entity_slot],
                )
        }
        CT_ENTITY_FAMILY_SHOT => {
            (entity_family_mask & CT_LOCK_ON_FAM_INCLUDE_SHOTS) != 0
                && combat_targeting_level1_mask_allows(
                    shot_mask,
                    pool.entity_blueprint_code[target_entity_slot],
                )
        }
        // Off by default: an unstamped / unknown family (CT_ENTITY_FAMILY_NONE)
        // is included by nothing, so it is never lockable.
        _ => false,
    }
}

#[inline]
pub(crate) fn combat_targeting_turret_lockon_allows_target_turret(
    pool: &CombatTargetingPool,
    source_turret_idx: usize,
    target_turret_idx: usize,
) -> bool {
    combat_targeting_lockon_masks_allow_target_turret(
        pool.turret_lockon_entity_family_mask[source_turret_idx],
        pool.turret_lockon_turret_mask[source_turret_idx],
        pool.turret_blueprint_code[target_turret_idx],
    )
}

#[inline]
pub(crate) fn combat_targeting_turret_lockon_allows_body_entity(
    pool: &CombatTargetingPool,
    source_turret_idx: usize,
    target_entity_slot: usize,
) -> bool {
    combat_targeting_lockon_masks_allow_body_entity(
        pool,
        pool.turret_lockon_entity_family_mask[source_turret_idx],
        pool.turret_lockon_building_mask[source_turret_idx],
        pool.turret_lockon_tower_mask[source_turret_idx],
        pool.turret_lockon_unit_mask[source_turret_idx],
        pool.turret_lockon_shot_mask[source_turret_idx],
        target_entity_slot,
    )
}

#[inline]
pub(crate) fn combat_targeting_turret_lockon_includes_turret_family(
    pool: &CombatTargetingPool,
    source_turret_idx: usize,
) -> bool {
    (pool.turret_lockon_entity_family_mask[source_turret_idx] & CT_LOCK_ON_FAM_INCLUDE_TURRETS) != 0
}

#[inline]
pub(crate) fn combat_targeting_committed_turret_targets_source(
    pool: &CombatTargetingPool,
    source_entity_slot: usize,
    source_entity_id: i32,
    source_turret_idx: Option<usize>,
    threat_turret_idx: usize,
) -> bool {
    if threat_turret_idx >= pool.turret_committed_target_id.len() {
        return false;
    }
    let threat_target_id = pool.turret_committed_target_id[threat_turret_idx];
    if threat_target_id == source_entity_id {
        return true;
    }
    if let Some(source_idx) = source_turret_idx {
        return source_idx < pool.turret_entity_id.len()
            && pool.turret_entity_id[source_idx] == threat_target_id;
    }
    if source_entity_slot >= pool.turret_count_per_entity.len() {
        return false;
    }
    let count = (pool.turret_count_per_entity[source_entity_slot] as usize)
        .min(COMBAT_TARGETING_MAX_TURRETS_PER_ENTITY as usize);
    for ti in 0..count {
        let idx = combat_targeting_turret_global_idx(source_entity_slot as u32, ti as u32);
        let flags = pool.turret_config_flags[idx];
        if (flags & CT_TURRET_CFG_PASSIVE) == 0
            || (flags & CT_TURRET_CFG_SHOT_IS_FORCE) == 0
            || (flags & CT_TURRET_CFG_NON_ATTACK_EMITTER) != 0
        {
            continue;
        }
        if pool.turret_entity_id[idx] == threat_target_id {
            return true;
        }
    }
    false
}

#[inline]
pub(crate) fn combat_targeting_target_slot_locked_onto_source(
    pool: &CombatTargetingPool,
    source_entity_slot: usize,
    source_entity_id: i32,
    source_turret_idx: usize,
    target_entity_slot: usize,
) -> bool {
    if target_entity_slot >= pool.turret_count_per_entity.len() {
        return false;
    }
    let count = (pool.turret_count_per_entity[target_entity_slot] as usize)
        .min(COMBAT_TARGETING_MAX_TURRETS_PER_ENTITY as usize);
    for ti in 0..count {
        let idx = combat_targeting_turret_global_idx(target_entity_slot as u32, ti as u32);
        if combat_targeting_committed_turret_targets_source(
            pool,
            source_entity_slot,
            source_entity_id,
            Some(source_turret_idx),
            idx,
        ) {
            return true;
        }
    }
    false
}

#[inline]
pub(crate) fn combat_targeting_turret_reciprocal_require_allows(
    pool: &CombatTargetingPool,
    source_entity_slot: usize,
    source_turret_idx: usize,
    target_entity_slot: usize,
) -> bool {
    if source_turret_idx >= pool.turret_lockon_reciprocal_mode.len() {
        return false;
    }
    if pool.turret_lockon_reciprocal_mode[source_turret_idx] != CT_LOCK_ON_RECIPROCAL_REQUIRE {
        return true;
    }
    let source_entity_id = pool.entity_id[source_entity_slot];
    combat_targeting_target_slot_locked_onto_source(
        pool,
        source_entity_slot,
        source_entity_id,
        source_turret_idx,
        target_entity_slot,
    )
}

#[inline]
pub(crate) fn combat_targeting_turret_reciprocal_prefer_tier(
    pool: &CombatTargetingPool,
    source_entity_slot: usize,
    source_turret_idx: usize,
    target_entity_slot: usize,
) -> u8 {
    if source_turret_idx >= pool.turret_lockon_reciprocal_mode.len() {
        return 0;
    }
    match pool.turret_lockon_reciprocal_mode[source_turret_idx] {
        CT_LOCK_ON_RECIPROCAL_PREFER_REACQUIRE | CT_LOCK_ON_RECIPROCAL_PREFER_HOLD => {}
        _ => return 0,
    }
    let source_entity_id = pool.entity_id[source_entity_slot];
    if combat_targeting_target_slot_locked_onto_source(
        pool,
        source_entity_slot,
        source_entity_id,
        source_turret_idx,
        target_entity_slot,
    ) {
        1
    } else {
        0
    }
}

#[inline]
pub(crate) fn combat_targeting_turret_prefer_reacquire_current_target_non_threat(
    pool: &CombatTargetingPool,
    source_entity_slot: usize,
    source_entity_id: i32,
    source_turret_idx: usize,
) -> bool {
    if source_turret_idx >= pool.turret_lockon_reciprocal_mode.len()
        || pool.turret_lockon_reciprocal_mode[source_turret_idx]
            != CT_LOCK_ON_RECIPROCAL_PREFER_REACQUIRE
    {
        return false;
    }
    combat_targeting_entity_slot_for_id(pool, pool.turret_target_id[source_turret_idx])
        .map(|slot| {
            !combat_targeting_target_slot_locked_onto_source(
                pool,
                source_entity_slot,
                source_entity_id,
                source_turret_idx,
                slot,
            )
        })
        .unwrap_or(false)
}

#[inline]
pub(crate) fn combat_targeting_entity_lockon_allows_target_turret(
    pool: &CombatTargetingPool,
    source_entity_slot: usize,
    target_turret_idx: usize,
) -> bool {
    combat_targeting_lockon_masks_allow_target_turret(
        pool.entity_lockon_entity_family_mask[source_entity_slot],
        pool.entity_lockon_turret_mask[source_entity_slot],
        pool.turret_blueprint_code[target_turret_idx],
    )
}

#[inline]
pub(crate) fn combat_targeting_entity_lockon_allows_any_target_turret(
    pool: &CombatTargetingPool,
    source_entity_slot: usize,
    target_entity_slot: usize,
) -> bool {
    if source_entity_slot >= pool.entity_lockon_entity_family_mask.len()
        || target_entity_slot >= pool.turret_count_per_entity.len()
        || (pool.entity_lockon_entity_family_mask[source_entity_slot]
            & CT_LOCK_ON_FAM_INCLUDE_TURRETS)
            == 0
    {
        return false;
    }

    let count = (pool.turret_count_per_entity[target_entity_slot] as usize)
        .min(COMBAT_TARGETING_MAX_TURRETS_PER_ENTITY as usize);
    for ti in 0..count {
        let idx = combat_targeting_turret_global_idx(target_entity_slot as u32, ti as u32);
        if combat_targeting_turret_is_pickable_aim_target(pool, idx)
            && combat_targeting_entity_lockon_allows_target_turret(pool, source_entity_slot, idx)
        {
            return true;
        }
    }
    false
}

#[inline]
pub(crate) fn combat_targeting_entity_allowed_relationships(
    pool: &CombatTargetingPool,
    source_entity_slot: usize,
) -> u8 {
    if source_entity_slot >= pool.entity_lockon_relationship_mask.len() {
        return 0;
    }
    combat_targeting_allowed_relationships_from_inclusions(
        pool.entity_lockon_relationship_mask[source_entity_slot],
    )
}

#[inline]
pub(crate) fn combat_targeting_entity_may_lock_entity_slot(
    pool: &CombatTargetingPool,
    source_entity_slot: usize,
    target_entity_slot: usize,
) -> bool {
    if source_entity_slot >= pool.entity_id.len()
        || target_entity_slot >= pool.entity_id.len()
        || source_entity_slot == target_entity_slot
        || pool.entity_id[source_entity_slot] < 0
        || pool.entity_id[target_entity_slot] < 0
        || !combat_targeting_entity_alive(pool, target_entity_slot)
    {
        return false;
    }
    if !combat_targeting_owner_relationship_allowed_by_mask(
        pool,
        source_entity_slot,
        target_entity_slot,
        combat_targeting_entity_allowed_relationships(pool, source_entity_slot),
    ) {
        return false;
    }
    if combat_targeting_lockon_masks_allow_body_entity(
        pool,
        pool.entity_lockon_entity_family_mask[source_entity_slot],
        pool.entity_lockon_building_mask[source_entity_slot],
        pool.entity_lockon_tower_mask[source_entity_slot],
        pool.entity_lockon_unit_mask[source_entity_slot],
        pool.entity_lockon_shot_mask[source_entity_slot],
        target_entity_slot,
    ) {
        return true;
    }

    combat_targeting_entity_lockon_allows_any_target_turret(
        pool,
        source_entity_slot,
        target_entity_slot,
    )
}

#[inline]
/// True when `source_entity_slot` carries CT_ENTITY_FLAG_PREVENT_LOCKON_IF_TEAM_ABOVE
/// AND a friendly (same-owner) entity sits directly above it (higher center,
/// footprints overlapping). Such a source refuses every lock-on so it never
/// fires up through the teammate hovering over it (e.g. the fabricator that
/// just produced it). Memoized per source per stamp epoch.
pub(crate) fn combat_targeting_source_sheltered_by_friendly_above(
    pool: &CombatTargetingPool,
    source_entity_slot: usize,
) -> bool {
    if source_entity_slot >= pool.entity_flags.len()
        || (pool.entity_flags[source_entity_slot] & CT_ENTITY_FLAG_PREVENT_LOCKON_IF_TEAM_ABOVE)
            == 0
    {
        return false;
    }
    let epoch = pool.stamp_epoch;
    if pool.entity_shelter_memo_epoch[source_entity_slot].get() == epoch {
        return pool.entity_shelter_memo_value[source_entity_slot].get() != 0;
    }
    let sheltered = combat_targeting_compute_sheltered_by_friendly_above(pool, source_entity_slot);
    pool.entity_shelter_memo_epoch[source_entity_slot].set(epoch);
    pool.entity_shelter_memo_value[source_entity_slot].set(sheltered as u8);
    sheltered
}

fn combat_targeting_compute_sheltered_by_friendly_above(
    pool: &CombatTargetingPool,
    source_entity_slot: usize,
) -> bool {
    let source_x = pool.entity_pos_x[source_entity_slot];
    let source_y = pool.entity_pos_y[source_entity_slot];
    let source_z = pool.entity_pos_z[source_entity_slot];
    let source_radius = pool.entity_radius_collision[source_entity_slot];
    let source_team = pool.entity_team_id[source_entity_slot];
    if !source_x.is_finite() || !source_y.is_finite() {
        return false;
    }
    // Reuse the observation broadphase: walk only the cells whose entities
    // could horizontally overlap the source. Entities bucket by center, so the
    // query radius adds the largest footprint padding to catch big hosts (the
    // fabricator) whose center sits a cell or two away. Cell iteration is a
    // deterministic nested loop and "any friendly above" is order-independent.
    let query_radius = source_radius + pool.observation_max_detection_padding;
    let min_cx = combat_targeting_observation_cell_coord(source_x - query_radius);
    let max_cx = combat_targeting_observation_cell_coord(source_x + query_radius);
    let min_cy = combat_targeting_observation_cell_coord(source_y - query_radius);
    let max_cy = combat_targeting_observation_cell_coord(source_y + query_radius);
    for cx in min_cx..=max_cx {
        for cy in min_cy..=max_cy {
            let key = combat_targeting_observation_cell_key(cx, cy);
            let Some(cell) = pool.observation_cells.get(&key) else {
                continue;
            };
            for &slot_u32 in &cell.slots {
                let slot = slot_u32 as usize;
                if slot == source_entity_slot
                    || slot >= pool.entity_id.len()
                    || pool.entity_id[slot] < 0
                {
                    continue;
                }
                if pool.entity_team_id[slot] != source_team {
                    continue;
                }
                if !combat_targeting_entity_alive(pool, slot) {
                    continue;
                }
                // Strictly higher center, so an upward shot passes through it.
                if pool.entity_pos_z[slot] <= source_z {
                    continue;
                }
                let overlaps = match pool.entity_family[slot] {
                    CT_ENTITY_FAMILY_BUILDING | CT_ENTITY_FAMILY_TOWER => {
                        spatial_dist_sq_to_aabb2(
                            pool.entity_pos_x[slot],
                            pool.entity_pos_y[slot],
                            pool.entity_aabb_half_x[slot],
                            pool.entity_aabb_half_y[slot],
                            source_x,
                            source_y,
                        ) <= source_radius * source_radius
                    }
                    _ => {
                        let dx = pool.entity_pos_x[slot] - source_x;
                        let dy = pool.entity_pos_y[slot] - source_y;
                        let r = source_radius + pool.entity_radius_collision[slot];
                        dx * dx + dy * dy <= r * r
                    }
                };
                if overlaps {
                    return true;
                }
            }
        }
    }
    false
}

pub(crate) fn combat_targeting_turret_may_lock_entity_slot(
    pool: &CombatTargetingPool,
    source_entity_slot: usize,
    source_turret_idx: usize,
    target_entity_slot: usize,
) -> bool {
    if source_entity_slot >= pool.entity_id.len()
        || target_entity_slot >= pool.entity_id.len()
        || source_turret_idx >= pool.turret_target_id.len()
        || source_entity_slot == target_entity_slot
        || pool.entity_id[source_entity_slot] < 0
        || pool.entity_id[target_entity_slot] < 0
        || !combat_targeting_entity_alive(pool, target_entity_slot)
    {
        return false;
    }
    // Lock-on shelter: a flagged host refuses every lock-on while a teammate
    // is directly above it, so it never fires up into that teammate.
    if combat_targeting_source_sheltered_by_friendly_above(pool, source_entity_slot) {
        return false;
    }
    // Sight-vs-radar fire tier: a turret that requires full sight may only lock
    // an enemy its team sees with full sight, never a radar-only contact. Uses
    // the same team view mask as the merged-sensor observability gate, so team
    // full sight counts; friendly (own-team) targets are always visible, so
    // this only gates enemies.
    if (pool.turret_config_flags[source_turret_idx] & CT_TURRET_CFG_REQUIRES_FULL_SIGHT) != 0 {
        let view_mask = pool.entity_view_mask[source_entity_slot];
        if (view_mask & pool.entity_owner_bit[target_entity_slot]) == 0
            && (pool.entity_full_sight_coverage_mask[target_entity_slot] & view_mask) == 0
        {
            return false;
        }
    }
    if !combat_targeting_turret_owner_relationship_allowed(
        pool,
        source_turret_idx,
        source_entity_slot,
        target_entity_slot,
    ) {
        return false;
    }

    let body_allowed = combat_targeting_turret_lockon_allows_body_entity(
        pool,
        source_turret_idx,
        target_entity_slot,
    ) && combat_targeting_turret_allows_target_medium(
        pool,
        source_turret_idx,
        combat_targeting_cylinder_target_to_entity_slot(
            pool,
            source_turret_idx,
            target_entity_slot,
        ),
    );
    let turret_allowed =
        if combat_targeting_turret_lockon_includes_turret_family(pool, source_turret_idx) {
            let source_entity_id = pool.entity_id[source_entity_slot];
            combat_targeting_pick_target_aim_turret_idx(
                pool,
                target_entity_slot,
                source_entity_slot,
                source_entity_id,
                Some(source_turret_idx),
            )
            .is_some()
        } else {
            false
        };
    let base_allowed = body_allowed || turret_allowed;

    base_allowed
        && combat_targeting_turret_reciprocal_require_allows(
            pool,
            source_entity_slot,
            source_turret_idx,
            target_entity_slot,
        )
}

pub(crate) fn combat_targeting_entity_has_turret_that_may_lock_entity_slot(
    pool: &CombatTargetingPool,
    source_entity_slot: u32,
    target_entity_slot: usize,
    turret_shield_panels_enabled: u8,
    turret_shield_spheres_enabled: u8,
) -> bool {
    let source_idx = source_entity_slot as usize;
    if source_idx >= pool.turret_count_per_entity.len() {
        return false;
    }
    let count = (pool.turret_count_per_entity[source_idx] as usize)
        .min(COMBAT_TARGETING_MAX_TURRETS_PER_ENTITY as usize);
    for turret_idx in 0..count {
        let idx = combat_targeting_turret_global_idx(source_entity_slot, turret_idx as u32);
        if (pool.turret_config_flags[idx] & CT_TURRET_CFG_IS_MANUAL_FIRE) != 0 {
            continue;
        }
        if combat_targeting_weapon_system_disabled(
            pool,
            idx,
            turret_shield_panels_enabled,
            turret_shield_spheres_enabled,
        ) {
            continue;
        }
        if combat_targeting_turret_may_lock_entity_slot(pool, source_idx, idx, target_entity_slot) {
            return true;
        }
    }
    false
}

/// AIM-08.5 — Rust port of `pickMirrorTargetTurret` /
/// `scoreShieldPanelTargetTurret` from `shieldTargetPriority.ts`. Walks the
/// target entity's turrets in the slab and returns the maximum
/// sustained DPS of any non-passive, non-visual, non-manual turret
/// whose prior committed lock points at our host or one of our
/// shield-panel turrets. Returns 0 when no qualifying turret exists — matches the
/// JS scorer's "any qualifying shield-panel target scores at its DPS;
/// otherwise 0" rule.
#[inline]
pub(crate) fn combat_targeting_shield_panel_target_score_for_slot(
    pool: &CombatTargetingPool,
    target_entity_slot: usize,
    source_entity_slot: usize,
    our_entity_id: i32,
) -> f64 {
    if target_entity_slot >= pool.turret_count_per_entity.len() {
        return 0.0;
    }
    let count = (pool.turret_count_per_entity[target_entity_slot] as usize)
        .min(COMBAT_TARGETING_MAX_TURRETS_PER_ENTITY as usize);
    let exclude_flags =
        CT_TURRET_CFG_PASSIVE | CT_TURRET_CFG_NON_ATTACK_EMITTER | CT_TURRET_CFG_IS_MANUAL_FIRE;
    let mut best: f32 = 0.0;
    for ti in 0..count {
        let idx = combat_targeting_turret_global_idx(target_entity_slot as u32, ti as u32);
        let flags = pool.turret_config_flags[idx];
        if (flags & exclude_flags) != 0 {
            continue;
        }
        if !combat_targeting_committed_turret_targets_source(
            pool,
            source_entity_slot,
            our_entity_id,
            None,
            idx,
        ) {
            continue;
        }
        let dps = pool.turret_dps[idx];
        if dps > best {
            best = dps;
        }
    }
    best as f64
}

/// AIM-08.5 — boolean wrapper over `shield_panel_target_score_for_slot`.
/// Matches `isShieldPanelTarget` in `shieldTargetPriority.ts`: true iff the
/// target carries a damaging turret currently locked onto us.
#[inline]
pub(crate) fn combat_targeting_is_shield_panel_target_for_slot(
    pool: &CombatTargetingPool,
    target_entity_slot: usize,
    source_entity_slot: usize,
    our_entity_id: i32,
) -> bool {
    combat_targeting_shield_panel_target_score_for_slot(
        pool,
        target_entity_slot,
        source_entity_slot,
        our_entity_id,
    ) > 0.0
}

#[inline]
pub(crate) fn combat_targeting_turret_is_pickable_aim_target(
    pool: &CombatTargetingPool,
    idx: usize,
) -> bool {
    let flags = pool.turret_config_flags[idx];
    let exclude_flags =
        CT_TURRET_CFG_PASSIVE | CT_TURRET_CFG_NON_ATTACK_EMITTER | CT_TURRET_CFG_IS_MANUAL_FIRE;
    (flags & exclude_flags) == 0 && pool.turret_dps[idx] > 0.0
}

/// Rust port of `pickTargetAimTurret` from `shieldTargetPriority.ts`.
/// Prefer an enemy turret directly threatening the source entity, then
/// fall back to the target's highest-DPS damaging turret.
#[inline]
pub(crate) fn combat_targeting_pick_target_aim_turret_idx(
    pool: &CombatTargetingPool,
    target_entity_slot: usize,
    source_entity_slot: usize,
    source_entity_id: i32,
    source_turret_idx: Option<usize>,
) -> Option<usize> {
    if target_entity_slot >= pool.turret_count_per_entity.len() {
        return None;
    }
    let count = (pool.turret_count_per_entity[target_entity_slot] as usize)
        .min(COMBAT_TARGETING_MAX_TURRETS_PER_ENTITY as usize);

    let mut best_direct: Option<(usize, f32)> = None;
    let mut best_any: Option<(usize, f32)> = None;
    for ti in 0..count {
        let idx = combat_targeting_turret_global_idx(target_entity_slot as u32, ti as u32);
        if !combat_targeting_turret_is_pickable_aim_target(pool, idx) {
            continue;
        }
        if let Some(source_idx) = source_turret_idx {
            if !combat_targeting_turret_lockon_allows_target_turret(pool, source_idx, idx) {
                continue;
            }
            let target_point = CombatTargetingCylinderTarget {
                horizontal_dist_sq: 0.0,
                horizontal_radius: 0.0,
                bottom_z: pool.turret_mount_z[idx],
                top_z: pool.turret_mount_z[idx],
                is_point: true,
            };
            if !combat_targeting_turret_allows_target_medium(pool, source_idx, target_point) {
                continue;
            }
        }
        let dps = pool.turret_dps[idx];
        if best_any.map_or(true, |(_, best)| dps > best) {
            best_any = Some((ti, dps));
        }
        if combat_targeting_committed_turret_targets_source(
            pool,
            source_entity_slot,
            source_entity_id,
            source_turret_idx,
            idx,
        ) && best_direct.map_or(true, |(_, best)| dps > best)
        {
            best_direct = Some((ti, dps));
        }
    }
    best_direct.or(best_any).map(|(ti, _)| ti)
}

#[inline]
pub(crate) fn combat_targeting_resolve_turret_mount_from_slab(
    pool: &CombatTargetingPool,
    target_entity_slot: usize,
    target_turret_idx: usize,
) -> (f64, f64, f64) {
    let idx =
        combat_targeting_turret_global_idx(target_entity_slot as u32, target_turret_idx as u32);
    combat_targeting_world_mount(
        pool.entity_pos_x[target_entity_slot],
        pool.entity_pos_y[target_entity_slot],
        pool.entity_ground_z[target_entity_slot],
        pool.entity_rot_cos[target_entity_slot],
        pool.entity_rot_sin[target_entity_slot],
        pool.turret_local_mount_x[idx] + pool.entity_suspension_offset_x[target_entity_slot],
        pool.turret_local_mount_y[idx] + pool.entity_suspension_offset_y[target_entity_slot],
        pool.turret_local_mount_z[idx] + pool.entity_suspension_offset_z[target_entity_slot],
        pool.entity_surface_nx[target_entity_slot],
        pool.entity_surface_ny[target_entity_slot],
        pool.entity_surface_nz[target_entity_slot],
        combat_targeting_entity_mount_orientation(pool, target_entity_slot),
    )
}

#[inline]
pub(crate) fn combat_targeting_resolve_body_aim_point_from_slot(
    pool: &CombatTargetingPool,
    target_entity_slot: usize,
    mount_x: f64,
    mount_y: f64,
    mount_z: f64,
) -> (f64, f64, f64) {
    let target_pos_x = pool.entity_pos_x[target_entity_slot];
    let target_pos_y = pool.entity_pos_y[target_entity_slot];
    let target_pos_z = pool.entity_pos_z[target_entity_slot];
    let hx = pool.entity_aabb_half_x[target_entity_slot];
    let hy = pool.entity_aabb_half_y[target_entity_slot];
    let hz = pool.entity_aabb_half_z[target_entity_slot];
    if hx > 0.0 || hy > 0.0 || hz > 0.0 {
        let min_x = target_pos_x - hx;
        let max_x = target_pos_x + hx;
        let min_y = target_pos_y - hy;
        let max_y = target_pos_y + hy;
        let min_z = target_pos_z - hz;
        let max_z = target_pos_z + hz;
        let ax = mount_x.max(min_x).min(max_x);
        let ay = mount_y.max(min_y).min(max_y);
        let az = mount_z.max(min_z).min(max_z);
        if ax == mount_x && ay == mount_y && az == mount_z {
            (target_pos_x, target_pos_y, target_pos_z)
        } else {
            (ax, ay, az)
        }
    } else {
        (target_pos_x, target_pos_y, target_pos_z)
    }
}

/// Pure static-endpoint ballistic solve (no slab writes): flight time
/// and world launch velocity for a shot from `from` to `to` with the
/// given shot parameters, under pool wind. None = no arc reaches.
pub(crate) fn combat_targeting_solve_static_arc(
    pool: &CombatTargetingPool,
    from: (f64, f64, f64),
    to: (f64, f64, f64),
    projectile_speed: f64,
    projectile_mass: f64,
    projectile_air_friction_per_60hz_frame: f64,
    gravity: f64,
    prefer_late_solution: u8,
    max_time_sec_or_zero: f64,
) -> Option<(f64, f64, f64, f64)> {
    let input = [
        from.0,
        from.1,
        from.2,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        to.0,
        to.1,
        to.2,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        -gravity,
        projectile_speed,
    ];
    let mut solution = [0.0_f64; 7];
    let found = solve_damped_kinematic_intercept_inline(
        &input,
        &mut solution,
        prefer_late_solution,
        max_time_sec_or_zero,
        projectile_air_friction_per_60hz_frame,
        projectile_mass,
        pool.wind_x,
        pool.wind_y,
        pool.wind_z,
    );
    if !found {
        return None;
    }
    Some((solution[0], solution[4], solution[5], solution[6]))
}

/// Closed-form world velocity of a shot `t` seconds after launch,
/// matching solve_damped_kinematic_intercept_inline's flight model:
/// exponential drag toward wind, constant gravity (undamped shots
/// ignore wind, exactly like the solver's zero-friction path).
pub(crate) fn combat_targeting_arc_velocity_at_time(
    pool: &CombatTargetingPool,
    launch_vx: f64,
    launch_vy: f64,
    launch_vz: f64,
    t: f64,
    projectile_mass: f64,
    projectile_air_friction_per_60hz_frame: f64,
    gravity: f64,
) -> (f64, f64, f64) {
    let drag_k = projectile_air_drag_rate_from_friction_per_60hz_frame(
        projectile_air_friction_per_60hz_frame,
        projectile_mass,
    );
    if !drag_k.is_finite() || drag_k <= 1e-9 {
        return (launch_vx, launch_vy, launch_vz - gravity * t);
    }
    let damp = (-drag_k * t).exp();
    let terminal_z = -gravity / drag_k;
    (
        pool.wind_x + (launch_vx - pool.wind_x) * damp,
        pool.wind_y + (launch_vy - pool.wind_y) * damp,
        pool.wind_z + terminal_z + (launch_vz - pool.wind_z - terminal_z) * damp,
    )
}

/// Ballistic-mirror panel normal for the incoming-threat reflector.
///
/// A ballistic threat's shot arrives along the descending leg of its
/// arc, not along the straight ray from its barrel, so the straight
/// turret/body bisector points the specular bounce far off the
/// attacker. This mirrors the threat's own ballistics equation instead:
///   1. run the threat turret's authored shot parameters from its mount
///      to this panel to predict the incoming arrival velocity;
///   2. solve the return arc from the panel to the midpoint between the
///      threat turret and its host body, at the reflected (arrival)
///      speed — the panel material's reflectivity is 1, so the bounce
///      leaves at arrival speed, not at the authored muzzle speed;
///   3. face the panel along the bisector of the reversed arrival
///      direction and the return launch direction, so the shared
///      specular formula maps the arriving velocity exactly onto the
///      return launch velocity.
/// None = either arc has no solution; the caller keeps the straight
/// bisector — a best-effort mirror is still a mirror.
pub(crate) fn combat_targeting_ballistic_mirror_panel_dir(
    pool: &CombatTargetingPool,
    threat_idx: usize,
    turret_point: (f64, f64, f64),
    body_point: (f64, f64, f64),
    mount_x: f64,
    mount_y: f64,
    mount_z: f64,
    gravity: f64,
) -> Option<(f64, f64, f64)> {
    const MIRROR_EPSILON: f64 = 1e-6;
    let projectile_speed = pool.turret_projectile_speed[threat_idx];
    let projectile_mass = pool.turret_projectile_mass[threat_idx];
    let air_friction = pool.turret_projectile_air_friction_per_60hz_frame[threat_idx];
    let prefer_late: u8 = if pool.turret_arc_preference[threat_idx] == CT_BALLISTIC_ARC_HIGH {
        1
    } else {
        0
    };
    let max_time = pool.turret_max_time_sec[threat_idx];

    let (incoming_time, in_vx, in_vy, in_vz) = combat_targeting_solve_static_arc(
        pool,
        turret_point,
        (mount_x, mount_y, mount_z),
        projectile_speed,
        projectile_mass,
        air_friction,
        gravity,
        prefer_late,
        max_time,
    )?;
    let (arr_vx, arr_vy, arr_vz) = combat_targeting_arc_velocity_at_time(
        pool,
        in_vx,
        in_vy,
        in_vz,
        incoming_time,
        projectile_mass,
        air_friction,
        gravity,
    );
    let arrival_speed = (arr_vx * arr_vx + arr_vy * arr_vy + arr_vz * arr_vz).sqrt();
    if !arrival_speed.is_finite() || arrival_speed <= MIRROR_EPSILON {
        return None;
    }

    let return_target = (
        (turret_point.0 + body_point.0) * 0.5,
        (turret_point.1 + body_point.1) * 0.5,
        (turret_point.2 + body_point.2) * 0.5,
    );
    let (_return_time, out_vx, out_vy, out_vz) = combat_targeting_solve_static_arc(
        pool,
        (mount_x, mount_y, mount_z),
        return_target,
        arrival_speed,
        projectile_mass,
        air_friction,
        gravity,
        prefer_late,
        max_time,
    )?;
    let out_speed = (out_vx * out_vx + out_vy * out_vy + out_vz * out_vz).sqrt();
    if !out_speed.is_finite() || out_speed <= MIRROR_EPSILON {
        return None;
    }

    let inv_in = 1.0 / arrival_speed;
    let inv_out = 1.0 / out_speed;
    let dir_x = out_vx * inv_out - arr_vx * inv_in;
    let dir_y = out_vy * inv_out - arr_vy * inv_in;
    let dir_z = out_vz * inv_out - arr_vz * inv_in;
    let dir_len = (dir_x * dir_x + dir_y * dir_y + dir_z * dir_z).sqrt();
    if !dir_len.is_finite() || dir_len <= MIRROR_EPSILON {
        return None;
    }
    Some((dir_x / dir_len, dir_y / dir_len, dir_z / dir_len))
}

#[inline]
pub(crate) fn combat_targeting_resolve_aim_point_from_slab(
    pool: &CombatTargetingPool,
    entity_slot: u32,
    turret_idx: u32,
    source_entity_id: i32,
    target_entity_slot: usize,
    mount_x: f64,
    mount_y: f64,
    mount_z: f64,
    gravity: f64,
) -> (f64, f64, f64) {
    let idx = combat_targeting_turret_global_idx(entity_slot, turret_idx);
    let flags = pool.turret_config_flags[idx];
    let target_turret_idx = if combat_targeting_turret_lockon_includes_turret_family(pool, idx) {
        combat_targeting_pick_target_aim_turret_idx(
            pool,
            target_entity_slot,
            entity_slot as usize,
            source_entity_id,
            Some(idx),
        )
    } else {
        None
    };
    let mut body_point = combat_targeting_resolve_body_aim_point_from_slot(
        pool,
        target_entity_slot,
        mount_x,
        mount_y,
        mount_z,
    );
    let body_point_target = CombatTargetingCylinderTarget {
        horizontal_dist_sq: 0.0,
        horizontal_radius: 0.0,
        bottom_z: body_point.2,
        top_z: body_point.2,
        is_point: true,
    };
    if !combat_targeting_flags_allow_target_medium(flags, mount_z, body_point_target) {
        // Preserve ordinary geometric aim whenever its point medium is legal.
        // Only move Z when that point selects a forbidden column despite the
        // body occupying another permitted column. This introduces no source-
        // medium preference: the pre-existing aim geometry wins whenever it is
        // in any true target column.
        let vertical_extent = combat_targeting_target_vertical_extent(pool, target_entity_slot);
        let bottom_z = pool.entity_pos_z[target_entity_slot] - vertical_extent;
        let top_z = pool.entity_pos_z[target_entity_slot] + vertical_extent;
        let above_point = CombatTargetingCylinderTarget {
            horizontal_dist_sq: 0.0,
            horizontal_radius: 0.0,
            bottom_z: top_z,
            top_z,
            is_point: true,
        };
        let underwater_point = CombatTargetingCylinderTarget {
            horizontal_dist_sq: 0.0,
            horizontal_radius: 0.0,
            bottom_z,
            top_z: bottom_z,
            is_point: true,
        };
        if top_z > TERRAIN_WATER_LEVEL
            && combat_targeting_flags_allow_target_medium(flags, mount_z, above_point)
        {
            let above_interior_z = if body_point.2 > TERRAIN_WATER_LEVEL {
                body_point.2.min(top_z)
            } else {
                TERRAIN_WATER_LEVEL + (top_z - TERRAIN_WATER_LEVEL) * 0.5
            };
            body_point.2 = above_interior_z;
        } else if bottom_z < TERRAIN_WATER_LEVEL
            && combat_targeting_flags_allow_target_medium(flags, mount_z, underwater_point)
        {
            body_point.2 = body_point.2.max(bottom_z).min(TERRAIN_WATER_LEVEL);
        }
    }
    let Some(target_turret_idx) = target_turret_idx else {
        return body_point;
    };

    let turret_point = combat_targeting_resolve_turret_mount_from_slab(
        pool,
        target_entity_slot,
        target_turret_idx,
    );
    if (flags & CT_TURRET_CFG_RAY_BISECT_TURRET_AND_BODY) == 0 {
        return turret_point;
    }

    const BISECT_EPSILON: f64 = 1e-6;
    let turret_dx = turret_point.0 - mount_x;
    let turret_dy = turret_point.1 - mount_y;
    let turret_dz = turret_point.2 - mount_z;
    let body_dx = body_point.0 - mount_x;
    let body_dy = body_point.1 - mount_y;
    let body_dz = body_point.2 - mount_z;
    let turret_len = (turret_dx * turret_dx + turret_dy * turret_dy + turret_dz * turret_dz).sqrt();
    let body_len = (body_dx * body_dx + body_dy * body_dy + body_dz * body_dz).sqrt();
    if turret_len <= BISECT_EPSILON {
        return body_point;
    }
    if body_len <= BISECT_EPSILON {
        return turret_point;
    }

    // A ballistic threat (its own aim solves an arc) does not arrive on
    // the straight barrel ray; mirror its ballistics equation instead of
    // the straight bisector. Constant-speed guided and vertical-launch
    // threats fly straight or are guided — they keep the bisector.
    let threat_global =
        combat_targeting_turret_global_idx(target_entity_slot as u32, target_turret_idx as u32);
    let threat_flags = pool.turret_config_flags[threat_global];
    if (threat_flags & CT_TURRET_CFG_NEEDS_BALLISTIC) != 0
        && (threat_flags & (CT_TURRET_CFG_VERTICAL_LAUNCHER | CT_TURRET_CFG_CONSTANT_SPEED_LEAD))
            == 0
    {
        if let Some((dir_x, dir_y, dir_z)) = combat_targeting_ballistic_mirror_panel_dir(
            pool,
            threat_global,
            turret_point,
            body_point,
            mount_x,
            mount_y,
            mount_z,
            gravity,
        ) {
            let aim_distance = turret_len.min(body_len).max(1.0);
            return (
                mount_x + dir_x * aim_distance,
                mount_y + dir_y * aim_distance,
                mount_z + dir_z * aim_distance,
            );
        }
    }

    let turret_inv = 1.0 / turret_len;
    let body_inv = 1.0 / body_len;
    let mut dir_x = turret_dx * turret_inv + body_dx * body_inv;
    let mut dir_y = turret_dy * turret_inv + body_dy * body_inv;
    let mut dir_z = turret_dz * turret_inv + body_dz * body_inv;
    let dir_len = (dir_x * dir_x + dir_y * dir_y + dir_z * dir_z).sqrt();
    if dir_len <= BISECT_EPSILON {
        dir_x = turret_dx * turret_inv;
        dir_y = turret_dy * turret_inv;
        dir_z = turret_dz * turret_inv;
    } else {
        let dir_inv = 1.0 / dir_len;
        dir_x *= dir_inv;
        dir_y *= dir_inv;
        dir_z *= dir_inv;
    }

    let aim_distance = turret_len.min(body_len).max(1.0);
    (
        mount_x + dir_x * aim_distance,
        mount_y + dir_y * aim_distance,
        mount_z + dir_z * aim_distance,
    )
}

#[derive(Clone, Copy)]
pub(crate) struct CombatTargetingCylinderTarget {
    pub(crate) horizontal_dist_sq: f64,
    pub(crate) horizontal_radius: f64,
    pub(crate) bottom_z: f64,
    pub(crate) top_z: f64,
    pub(crate) is_point: bool,
}

#[inline]
pub(crate) fn combat_targeting_nonnegative_finite(value: f64) -> f64 {
    if value.is_finite() && value > 0.0 {
        value
    } else {
        0.0
    }
}

#[inline]
pub(crate) fn combat_targeting_range_radius_from_sq(range_sq: f64) -> f64 {
    combat_targeting_nonnegative_finite(range_sq).sqrt()
}

#[inline]
pub(crate) fn combat_targeting_invalid_cylinder_target() -> CombatTargetingCylinderTarget {
    CombatTargetingCylinderTarget {
        horizontal_dist_sq: f64::INFINITY,
        horizontal_radius: 0.0,
        bottom_z: f64::INFINITY,
        top_z: f64::NEG_INFINITY,
        is_point: true,
    }
}

/// Half-height of the cylinder the range gate tests a target with.
///
/// The range shells are vertical cylinders, so a target has to be handed to
/// them in cylinder terms; this is NOT a second volume with a life of its
/// own, it is the damage volume re-expressed for that test, and it must
/// stay the damage volume's own vertical reach.
///
/// A STRUCTURE is a box: its vertical reach is `aabb_half_z` (depth/2) and
/// nothing else. It used to be `max(hitbox, aabb_half_z)`, but a building's
/// `radius_hitbox` is its FOOTPRINT half-diagonal — a horizontal measure —
/// so that max floored a vertical extent at a horizontal one and inflated
/// flat structures: a 60x60x20 solar panel was handed to the range gate as
/// 85 units tall (2 x 42.4) instead of 20.
///
/// A UNIT is a sphere at its body center, so `hitbox` is its vertical reach.
/// `aabb_half_z` carries the support-point offset for units (how far the
/// chassis floats above its footing), which legitimately extends a legged
/// body's targetable span down toward its feet, so units keep the max.
#[inline]
pub(crate) fn combat_targeting_target_vertical_extent(
    pool: &CombatTargetingPool,
    entity_slot: usize,
) -> f64 {
    if entity_slot >= pool.entity_radius_hitbox.len() {
        return 0.0;
    }
    let half_z = if entity_slot < pool.entity_aabb_half_z.len() {
        combat_targeting_nonnegative_finite(pool.entity_aabb_half_z[entity_slot])
    } else {
        0.0
    };
    let family = if entity_slot < pool.entity_family.len() {
        pool.entity_family[entity_slot]
    } else {
        CT_ENTITY_FAMILY_NONE
    };
    if family == CT_ENTITY_FAMILY_BUILDING || family == CT_ENTITY_FAMILY_TOWER {
        return half_z;
    }
    let hitbox = combat_targeting_nonnegative_finite(pool.entity_radius_hitbox[entity_slot]);
    hitbox.max(half_z)
}

#[inline]
pub(crate) fn combat_targeting_cylinder_target_to_entity_slot(
    pool: &CombatTargetingPool,
    turret_idx: usize,
    entity_slot: usize,
) -> CombatTargetingCylinderTarget {
    if turret_idx >= pool.turret_mount_x.len()
        || entity_slot >= pool.entity_pos_x.len()
        || entity_slot >= pool.entity_pos_y.len()
        || entity_slot >= pool.entity_pos_z.len()
    {
        return combat_targeting_invalid_cylinder_target();
    }
    let dx = pool.turret_mount_x[turret_idx] - pool.entity_pos_x[entity_slot];
    let dy = pool.turret_mount_y[turret_idx] - pool.entity_pos_y[entity_slot];
    let vertical_extent = combat_targeting_target_vertical_extent(pool, entity_slot);
    CombatTargetingCylinderTarget {
        horizontal_dist_sq: dx * dx + dy * dy,
        horizontal_radius: combat_targeting_nonnegative_finite(
            pool.entity_radius_hitbox[entity_slot],
        ),
        bottom_z: pool.entity_pos_z[entity_slot] - vertical_extent,
        top_z: pool.entity_pos_z[entity_slot] + vertical_extent,
        is_point: pool.entity_family[entity_slot] == CT_ENTITY_FAMILY_SHOT,
    }
}

#[inline]
pub(crate) fn combat_targeting_cylinder_target_to_point(
    pool: &CombatTargetingPool,
    turret_idx: usize,
    point_x: f64,
    point_y: f64,
    point_z: f64,
) -> CombatTargetingCylinderTarget {
    if turret_idx >= pool.turret_mount_x.len() {
        return combat_targeting_invalid_cylinder_target();
    }
    let dx = pool.turret_mount_x[turret_idx] - point_x;
    let dy = pool.turret_mount_y[turret_idx] - point_y;
    CombatTargetingCylinderTarget {
        horizontal_dist_sq: dx * dx + dy * dy,
        horizontal_radius: 0.0,
        bottom_z: point_z,
        top_z: point_z,
        is_point: true,
    }
}

#[inline]
pub(crate) fn combat_targeting_valid_range_target(
    range: f64,
    mount_z: f64,
    target: CombatTargetingCylinderTarget,
) -> bool {
    range.is_finite()
        && mount_z.is_finite()
        && target.horizontal_dist_sq.is_finite()
        && target.bottom_z.is_finite()
        && target.top_z.is_finite()
        && range >= 0.0
}

#[derive(Clone, Copy)]
pub(crate) struct CombatTargetingRangeVolume {
    pub(crate) bottom_unbounded: bool,
    pub(crate) top_unbounded: bool,
    pub(crate) water_surface_ceiling: bool,
    pub(crate) sphere: bool,
}

impl CombatTargetingRangeVolume {
    #[inline]
    pub(crate) fn cylinder_normal() -> Self {
        Self {
            bottom_unbounded: false,
            top_unbounded: false,
            water_surface_ceiling: false,
            sphere: false,
        }
    }
}

#[inline]
pub(crate) fn combat_targeting_range_volume_from_flags(flags: u32) -> CombatTargetingRangeVolume {
    let bottom_bit = (flags & CT_TURRET_CFG_RANGE_BOTTOM_UNBOUNDED) != 0;
    let top_bit = (flags & CT_TURRET_CFG_RANGE_TOP_UNBOUNDED) != 0;
    let sphere = (flags & CT_TURRET_CFG_RANGE_SPHERE) != 0;
    let water_surface_ceiling = top_bit && !bottom_bit && !sphere;
    CombatTargetingRangeVolume {
        bottom_unbounded: bottom_bit || water_surface_ceiling,
        top_unbounded: bottom_bit && top_bit,
        water_surface_ceiling,
        sphere,
    }
}

#[inline]
pub(crate) fn combat_targeting_turret_range_volume(
    pool: &CombatTargetingPool,
    idx: usize,
) -> CombatTargetingRangeVolume {
    combat_targeting_range_volume_from_flags(pool.turret_config_flags[idx])
}

#[inline]
pub(crate) fn combat_targeting_target_nearest_distance_sq_to_mount(
    mount_z: f64,
    target: CombatTargetingCylinderTarget,
) -> f64 {
    let horizontal_gap = target.horizontal_dist_sq.sqrt() - target.horizontal_radius.max(0.0);
    let horizontal_gap = horizontal_gap.max(0.0);
    let vertical_gap = if mount_z < target.bottom_z {
        target.bottom_z - mount_z
    } else if mount_z > target.top_z {
        mount_z - target.top_z
    } else {
        0.0
    };
    horizontal_gap * horizontal_gap + vertical_gap * vertical_gap
}

#[inline]
pub(crate) fn combat_targeting_range_volume_allows_target_domain(
    volume: CombatTargetingRangeVolume,
    target: CombatTargetingCylinderTarget,
) -> bool {
    !volume.water_surface_ceiling || target.bottom_z <= TERRAIN_WATER_LEVEL
}

#[inline]
/// Exhaustive emission source->target medium legality. Unit/building bodies
/// may occupy both target columns by positive volume; shot and turret points
/// occupy exactly one column, with the surface itself classified underwater.
/// True cells are tested as an unordered set: there is no same-medium bias.
pub(crate) fn combat_targeting_flags_allow_target_medium(
    flags: u32,
    source_z: f64,
    target: CombatTargetingCylinderTarget,
) -> bool {
    let routes = flags & CT_TURRET_CFG_ROUTE_MASK;
    let target_above = target.top_z > TERRAIN_WATER_LEVEL;
    let target_underwater = if target.is_point {
        target.bottom_z <= TERRAIN_WATER_LEVEL
    } else {
        target.bottom_z < TERRAIN_WATER_LEVEL
    };
    if source_z <= TERRAIN_WATER_LEVEL {
        ((routes & CT_TURRET_CFG_ROUTE_UNDERWATER_TO_ABOVE) != 0 && target_above)
            || ((routes & CT_TURRET_CFG_ROUTE_UNDERWATER_TO_UNDERWATER) != 0 && target_underwater)
    } else {
        ((routes & CT_TURRET_CFG_ROUTE_ABOVE_TO_ABOVE) != 0 && target_above)
            || ((routes & CT_TURRET_CFG_ROUTE_ABOVE_TO_UNDERWATER) != 0 && target_underwater)
    }
}

#[inline]
pub(crate) fn combat_targeting_turret_allows_target_medium(
    pool: &CombatTargetingPool,
    idx: usize,
    target: CombatTargetingCylinderTarget,
) -> bool {
    combat_targeting_flags_allow_target_medium(
        pool.turret_config_flags[idx],
        pool.turret_mount_z[idx],
        target,
    )
}

#[inline]
pub(crate) fn combat_targeting_range_volume_contains(
    range: f64,
    mount_z: f64,
    volume: CombatTargetingRangeVolume,
    target: CombatTargetingCylinderTarget,
) -> bool {
    if !combat_targeting_valid_range_target(range, mount_z, target) {
        return false;
    }
    if volume.sphere {
        return combat_targeting_target_nearest_distance_sq_to_mount(mount_z, target)
            <= range * range;
    }
    let horizontal_radius = range + target.horizontal_radius.max(0.0);
    let below_top = if volume.water_surface_ceiling {
        combat_targeting_range_volume_allows_target_domain(volume, target)
    } else {
        volume.top_unbounded || target.bottom_z <= mount_z + range
    };
    target.horizontal_dist_sq <= horizontal_radius * horizontal_radius
        && below_top
        && (volume.bottom_unbounded || target.top_z >= mount_z - range)
}

#[inline]
pub(crate) fn combat_targeting_min_range_prefers_target(
    min_range: f64,
    mount_z: f64,
    volume: CombatTargetingRangeVolume,
    target: CombatTargetingCylinderTarget,
) -> bool {
    if !min_range.is_finite() || min_range <= 0.0 {
        return true;
    }
    if !combat_targeting_valid_range_target(min_range, mount_z, target) {
        return false;
    }
    if volume.sphere {
        return combat_targeting_target_nearest_distance_sq_to_mount(mount_z, target)
            >= min_range * min_range;
    }
    if !volume.water_surface_ceiling {
        if !volume.top_unbounded && target.bottom_z > mount_z + min_range {
            return true;
        }
        if !volume.bottom_unbounded && target.top_z < mount_z - min_range {
            return true;
        }
    }
    let threshold = min_range - target.horizontal_radius.max(0.0);
    if threshold <= 0.0 {
        return true;
    }
    target.horizontal_dist_sq >= threshold * threshold
}

#[inline]
pub(crate) fn combat_targeting_fire_max_cylinder_contains(
    pool: &CombatTargetingPool,
    idx: usize,
    release_edge: bool,
    target: CombatTargetingCylinderTarget,
) -> bool {
    let range_sq = if release_edge {
        pool.turret_fire_max_release_sq[idx]
    } else {
        pool.turret_fire_max_acquire_sq[idx]
    };
    combat_targeting_range_volume_contains(
        combat_targeting_range_radius_from_sq(range_sq),
        pool.turret_mount_z[idx],
        combat_targeting_turret_range_volume(pool, idx),
        target,
    )
}

#[inline]
pub(crate) fn combat_targeting_outermost_release_cylinder_contains(
    pool: &CombatTargetingPool,
    idx: usize,
    target: CombatTargetingCylinderTarget,
) -> bool {
    let has_tracking = (pool.turret_config_flags[idx] & CT_TURRET_CFG_HAS_TRACKING_RANGE) != 0;
    let range_sq = if has_tracking {
        pool.turret_tracking_release_sq[idx]
    } else {
        pool.turret_fire_max_release_sq[idx]
    };
    combat_targeting_range_volume_contains(
        combat_targeting_range_radius_from_sq(range_sq),
        pool.turret_mount_z[idx],
        combat_targeting_turret_range_volume(pool, idx),
        target,
    )
}

#[inline]
pub(crate) fn combat_targeting_fire_rank_from_pool_cylinder(
    pool: &CombatTargetingPool,
    idx: usize,
    release_edge: bool,
    target: CombatTargetingCylinderTarget,
) -> u8 {
    if !combat_targeting_fire_max_cylinder_contains(pool, idx, release_edge, target) {
        return CT_TARGET_RANK_NONE;
    }

    let min_sq = if release_edge {
        pool.turret_fire_min_release_sq[idx]
    } else {
        pool.turret_fire_min_acquire_sq[idx]
    };
    if min_sq <= 0.0 {
        return CT_TARGET_RANK_FIRE_PREFERRED;
    }

    if combat_targeting_min_range_prefers_target(
        combat_targeting_range_radius_from_sq(min_sq),
        pool.turret_mount_z[idx],
        combat_targeting_turret_range_volume(pool, idx),
        target,
    ) {
        CT_TARGET_RANK_FIRE_PREFERRED
    } else {
        CT_TARGET_RANK_FIRE_FALLBACK
    }
}

#[inline]
pub(crate) fn combat_targeting_entity_slot_for_id(
    pool: &CombatTargetingPool,
    entity_id: i32,
) -> Option<usize> {
    if entity_id < 0 {
        return None;
    }
    let slot = *pool.entity_slot_by_id.get(&entity_id)? as usize;
    if slot >= pool.entity_id.len()
        || pool.entity_id[slot] != entity_id
        || pool.entity_stamp_epoch[slot] != pool.stamp_epoch
    {
        return None;
    }
    Some(slot)
}

#[inline]
pub(crate) fn combat_targeting_current_fire_target_rank_sq(
    pool: &CombatTargetingPool,
    turret_idx: usize,
) -> (u8, f64) {
    let target_id = pool.turret_target_id[turret_idx];
    let Some(target_slot) = combat_targeting_entity_slot_for_id(pool, target_id) else {
        return (CT_TARGET_RANK_NONE, f64::INFINITY);
    };
    let source_entity_slot = turret_idx / (COMBAT_TARGETING_MAX_TURRETS_PER_ENTITY as usize);
    if !combat_targeting_turret_may_lock_entity_slot(
        pool,
        source_entity_slot,
        turret_idx,
        target_slot,
    ) {
        return (CT_TARGET_RANK_NONE, f64::INFINITY);
    }
    let target = combat_targeting_cylinder_target_to_entity_slot(pool, turret_idx, target_slot);
    let rank = combat_targeting_fire_rank_from_pool_cylinder(pool, turret_idx, true, target);
    (rank, target.horizontal_dist_sq)
}

#[inline]
pub(crate) fn combat_targeting_weapon_system_disabled(
    pool: &CombatTargetingPool,
    idx: usize,
    turret_shield_panels_enabled: u8,
    turret_shield_spheres_enabled: u8,
) -> bool {
    let flags = pool.turret_config_flags[idx];
    (flags & CT_TURRET_CFG_NON_ATTACK_EMITTER) != 0
        || ((flags & CT_TURRET_CFG_PASSIVE) != 0 && turret_shield_panels_enabled == 0)
        || ((flags & CT_TURRET_CFG_SHOT_IS_FORCE) != 0
            && (flags & CT_TURRET_CFG_PASSIVE) == 0
            && turret_shield_spheres_enabled == 0)
}

#[inline]
pub(crate) fn combat_targeting_turret_ignores_force_material_sight_obstruction(flags: u32) -> bool {
    (flags & CT_TURRET_CFG_IGNORES_FORCE_MATERIAL_SIGHT_OBSTRUCTION) != 0
}

#[inline]
pub(crate) fn combat_targeting_entity_has_enabled_weapon(
    pool: &CombatTargetingPool,
    entity_slot: u32,
    turret_shield_panels_enabled: u8,
    turret_shield_spheres_enabled: u8,
) -> bool {
    let entity_idx = entity_slot as usize;
    if entity_idx >= pool.turret_count_per_entity.len() {
        return false;
    }
    let count = (pool.turret_count_per_entity[entity_idx] as usize)
        .min(COMBAT_TARGETING_MAX_TURRETS_PER_ENTITY as usize);
    for turret_idx in 0..count {
        let idx = combat_targeting_turret_global_idx(entity_slot, turret_idx as u32);
        if !combat_targeting_weapon_system_disabled(
            pool,
            idx,
            turret_shield_panels_enabled,
            turret_shield_spheres_enabled,
        ) {
            return true;
        }
    }
    false
}

#[inline]
pub(crate) fn combat_targeting_decrement_cooldown(value: f64, dt_ms: f64) -> f64 {
    if value <= 0.0 {
        0.0
    } else {
        let next = value - dt_ms;
        if next > 0.0 {
            next
        } else {
            0.0
        }
    }
}

// AIM-08.5 — slab-side per-turret rotation work threshold. Mirrors the
// JS `ACTIVE_ROTATION_EPSILON` in combatActivity.ts; kept in lockstep
// so the slab kernel and the (legacy) JS fallback agree on which
// turrets count as "still spinning down."
pub(crate) const CT_ROTATION_WORK_EPSILON: f32 = 0.0001;

/// AIM-08.5 — Activity mask refresh kernel. Walks every turret on
/// `entity_slot`, reads slab FSM target/state + angular/pitch velocity
/// + config flags, and writes the entity-level active/firing masks.
/// `non-attack emitter` turrets are skipped exactly like the JS path.
#[inline]
pub(crate) fn combat_targeting_refresh_activity_masks_for_entity_inner(
    pool: &mut CombatTargetingPool,
    entity_slot: u32,
) {
    let entity_idx = entity_slot as usize;
    if entity_idx >= pool.turret_count_per_entity.len() {
        return;
    }
    let count = (pool.turret_count_per_entity[entity_idx] as usize)
        .min(COMBAT_TARGETING_MAX_TURRETS_PER_ENTITY as usize);
    let mut active_mask: u32 = 0;
    let mut firing_mask: u32 = 0;
    for turret_idx in 0..count {
        let idx = combat_targeting_turret_global_idx(entity_slot, turret_idx as u32);
        let flags = pool.turret_config_flags[idx];
        if (flags & CT_TURRET_CFG_NON_ATTACK_EMITTER) != 0 {
            continue;
        }
        let state = pool.turret_state[idx];
        let has_fsm_work = pool.turret_target_id[idx] >= 0 || state != CT_TURRET_STATE_IDLE;
        let has_rotation_work = pool.turret_angular_velocity[idx].abs() > CT_ROTATION_WORK_EPSILON
            || pool.turret_pitch_velocity[idx].abs() > CT_ROTATION_WORK_EPSILON;
        if !has_fsm_work && !has_rotation_work {
            continue;
        }
        active_mask |= 1u32 << (turret_idx as u32);
        if state == CT_TURRET_STATE_ENGAGED
            && (flags & CT_TURRET_CFG_PASSIVE) == 0
            && (flags & CT_TURRET_CFG_SHOT_IS_FORCE) == 0
        {
            firing_mask |= 1u32 << (turret_idx as u32);
        }
    }
    pool.entity_active_turret_mask[entity_idx] = active_mask;
    pool.entity_firing_turret_mask[entity_idx] = firing_mask;
}

#[inline]
pub(crate) fn combat_targeting_refresh_activity_masks_for_entity_and_read_active(
    entity_slot: u32,
) -> u8 {
    let pool = combat_targeting_pool();
    combat_targeting_refresh_activity_masks_for_entity_inner(pool, entity_slot);
    let entity_idx = entity_slot as usize;
    if entity_idx < pool.entity_active_turret_mask.len()
        && pool.entity_active_turret_mask[entity_idx] != 0
    {
        1
    } else {
        0
    }
}

/// AIM-08.5 — single-entity activity mask refresh entry point. JS
/// writeback / turretSystem / projectileSystem call this after writing
/// slab FSM + velocity data so downstream readers (turretSystem,
/// projectileSystem) can read the masks directly from the slab.
#[wasm_bindgen]
pub fn combat_targeting_refresh_activity_masks_for_entity(entity_slot: u32) {
    let pool = combat_targeting_pool();
    combat_targeting_refresh_activity_masks_for_entity_inner(pool, entity_slot);
}

/// AIM-08.5 — batched activity mask refresh. Slot list lives in JS, but
/// the per-entity walk stays inside Rust so a many-entity refresh costs
/// one boundary call.
#[wasm_bindgen]
pub fn combat_targeting_refresh_activity_masks_batch(entity_slots: &[u32]) {
    let pool = combat_targeting_pool();
    for &slot in entity_slots.iter() {
        combat_targeting_refresh_activity_masks_for_entity_inner(pool, slot);
    }
}

#[inline]
pub(crate) fn combat_targeting_turret_halts_host(
    pool: &CombatTargetingPool,
    idx: usize,
    priority_point_present: bool,
    expected_target_id: i32,
) -> bool {
    if pool.turret_state[idx] != CT_TURRET_STATE_ENGAGED {
        return false;
    }
    if expected_target_id >= 0 {
        return pool.turret_target_id[idx] == expected_target_id;
    }
    pool.turret_target_id[idx] >= 0 || priority_point_present
}

/// C1 movement/combat bridge — classify whether the current movement
/// action should halt because the host's combat slab is engaged.
///
/// Mode `anyEngaged` mirrors attack / attack-ground / guard. A direct
/// attack pins the host only when an engaged turret holds the same target as
/// the current host order; an old lock may keep firing but cannot block a new
/// movement order. Point intent still accepts any engaged attack turret while
/// the priority point is active. Mode `fightRequired` mirrors fight / patrol:
/// every non-visual turret whose mount is flagged as required for fight-stop
/// must be engaged.
#[wasm_bindgen]
pub fn combat_targeting_halt_decision_batch(
    entity_slots: &[u32],
    modes: &[u8],
    priority_point_present: &[u8],
    expected_target_ids: &[i32],
    out_should_halt: &mut [u8],
) -> u32 {
    let count = entity_slots
        .len()
        .min(modes.len())
        .min(priority_point_present.len())
        .min(expected_target_ids.len())
        .min(out_should_halt.len());
    let pool = combat_targeting_pool();
    for i in 0..count {
        let slot = entity_slots[i] as usize;
        out_should_halt[i] = 0;
        if slot >= pool.turret_count_per_entity.len() {
            continue;
        }
        let turret_count = (pool.turret_count_per_entity[slot] as usize)
            .min(COMBAT_TARGETING_MAX_TURRETS_PER_ENTITY as usize);
        if turret_count == 0 {
            continue;
        }
        let has_priority_point = priority_point_present[i] != 0;
        let expected_target_id = expected_target_ids[i];
        if modes[i] == CT_COMBAT_HALT_MODE_ANY_ENGAGED {
            for turret_idx in 0..turret_count {
                let idx = combat_targeting_turret_global_idx(entity_slots[i], turret_idx as u32);
                let flags = pool.turret_config_flags[idx];
                if (flags & CT_TURRET_CFG_NON_ATTACK_EMITTER) != 0 {
                    continue;
                }
                if combat_targeting_turret_halts_host(
                    pool,
                    idx,
                    has_priority_point,
                    expected_target_id,
                ) {
                    out_should_halt[i] = 1;
                    break;
                }
            }
            continue;
        }

        if modes[i] != CT_COMBAT_HALT_MODE_FIGHT_REQUIRED {
            continue;
        }
        let mut required = 0_u32;
        let mut engaged_required = 0_u32;
        for turret_idx in 0..turret_count {
            let idx = combat_targeting_turret_global_idx(entity_slots[i], turret_idx as u32);
            let flags = pool.turret_config_flags[idx];
            if (flags & CT_TURRET_CFG_NON_ATTACK_EMITTER) != 0 {
                continue;
            }
            if (flags & CT_TURRET_CFG_REQUIRED_ENGAGED_FOR_FIGHT_STOP) == 0 {
                continue;
            }
            required += 1;
            if combat_targeting_turret_halts_host(pool, idx, has_priority_point, -1) {
                engaged_required += 1;
            }
        }
        if required > 0 && engaged_required == required {
            out_should_halt[i] = 1;
        }
    }
    count as u32
}

/// AIM-08.5 — slab-side mid-tick turret state clear, used by JS when
/// the rotation pass discovers a ballistic-fail or other reason to
/// drop a turret's lock outright. Mirrors `weapon.state = 'idle'`
/// plus `setWeaponTarget(..., null)` for the slab, so downstream
/// readers see the cleared lock once the activity-mask refresh runs.
#[wasm_bindgen]
pub fn combat_targeting_clear_turret_fsm(entity_slot: u32, turret_idx: u32) {
    let pool = combat_targeting_pool();
    if turret_idx >= COMBAT_TARGETING_MAX_TURRETS_PER_ENTITY {
        return;
    }
    let entity_idx = entity_slot as usize;
    if entity_idx >= pool.turret_count_per_entity.len() {
        return;
    }
    let idx = combat_targeting_turret_global_idx(entity_slot, turret_idx);
    combat_targeting_set_target_state(pool, idx, -1, CT_TURRET_STATE_IDLE);
}

/// AIM-08.5 — Rust port of `resetDisabledWeapon`'s slab side. For every
/// turret on `entity_slot` that the live world flags currently mark as
/// disabled (non-attack emitter, passive without shield panels enabled, force without force
/// fields), zero the slab state the writeback layer will copy back into
/// the JS Turret (target/state/cooldowns/aim error/LOS bookkeeping).
/// JS-only Turret fields outside the slab (angular/pitch velocity and
/// acceleration, burst.remaining, shield.transition/range) are
/// cleared by the writeback pass — see `targetingSystem.ts`.
#[inline]
pub(crate) fn combat_targeting_reset_disabled_weapons_for_entity(
    pool: &mut CombatTargetingPool,
    entity_slot: u32,
    turret_shield_panels_enabled: u8,
    turret_shield_spheres_enabled: u8,
) {
    let entity_idx = entity_slot as usize;
    if entity_idx >= pool.turret_count_per_entity.len() {
        return;
    }
    let count = (pool.turret_count_per_entity[entity_idx] as usize)
        .min(COMBAT_TARGETING_MAX_TURRETS_PER_ENTITY as usize);
    for turret_idx in 0..count {
        let idx = combat_targeting_turret_global_idx(entity_slot, turret_idx as u32);
        if !combat_targeting_weapon_system_disabled(
            pool,
            idx,
            turret_shield_panels_enabled,
            turret_shield_spheres_enabled,
        ) {
            continue;
        }
        combat_targeting_set_target_state(pool, idx, -1, CT_TURRET_STATE_IDLE);
        pool.turret_cooldown[idx] = 0.0;
        pool.turret_burst_cooldown[idx] = 0.0;
        pool.turret_los_blocked_ticks[idx] = 0;
    }
}

#[inline]
pub(crate) fn combat_targeting_decrement_entity_cooldowns(
    pool: &mut CombatTargetingPool,
    entity_slot: u32,
    dt_ms: f64,
) -> u8 {
    let entity_idx = entity_slot as usize;
    if entity_idx >= pool.turret_count_per_entity.len() {
        return 0;
    }
    let count = (pool.turret_count_per_entity[entity_idx] as usize)
        .min(COMBAT_TARGETING_MAX_TURRETS_PER_ENTITY as usize);
    let mut had_cooldown = 0u8;
    for turret_idx in 0..count {
        let idx = combat_targeting_turret_global_idx(entity_slot, turret_idx as u32);
        if pool.turret_cooldown[idx] > 0.0 {
            had_cooldown = 1;
            pool.turret_cooldown[idx] =
                combat_targeting_decrement_cooldown(pool.turret_cooldown[idx], dt_ms);
        }
        if pool.turret_burst_cooldown[idx] > 0.0 {
            had_cooldown = 1;
            pool.turret_burst_cooldown[idx] =
                combat_targeting_decrement_cooldown(pool.turret_burst_cooldown[idx], dt_ms);
        }
    }
    had_cooldown
}

/// AIM-08.5 — Rust auto-targeting pre-scan over the combat-targeting
/// slab. This replaces the TypeScript loop that derived:
///   - whether any turret needs a batched enemy query,
///   - the maximum outer acquire range,
///   - the maximum mount offset used to widen that query,
///   - and the per-turret current-fire rank cache for min-range
///     fallback promotion.
/// Specialist turrets with a nonzero `target_rescore_period_ticks` also
/// request a query on their entity-id-staggered cadence while engaged, so
/// they can compare a still-valid lock with newly eligible candidates.
#[inline]
pub(crate) fn combat_targeting_periodic_rescore_due(
    pool: &CombatTargetingPool,
    entity_idx: usize,
    turret_idx: usize,
    current_tick: i32,
) -> bool {
    let period = pool.turret_target_rescore_period_ticks[turret_idx] as i32;
    period > 0
        && current_tick >= 0
        && pool.entity_id[entity_idx] >= 0
        && current_tick.rem_euclid(period) == pool.entity_id[entity_idx].rem_euclid(period)
}

#[wasm_bindgen]
pub fn combat_targeting_prepare_auto_scan(
    entity_slot: u32,
    current_tick: i32,
    turret_shield_panels_enabled: u8,
    turret_shield_spheres_enabled: u8,
    cached_fire_ranks: &mut [u8],
    cached_fire_dist_sqs: &mut [f64],
    out_f64: &mut [f64],
) -> u8 {
    if out_f64.len() >= 2 {
        out_f64[0] = 0.0;
        out_f64[1] = 0.0;
    }

    let pool = combat_targeting_pool();
    let entity_idx = entity_slot as usize;
    if entity_idx >= pool.turret_count_per_entity.len() {
        return 0;
    }

    let turret_count = (pool.turret_count_per_entity[entity_idx] as usize)
        .min(COMBAT_TARGETING_MAX_TURRETS_PER_ENTITY as usize)
        .min(cached_fire_ranks.len())
        .min(cached_fire_dist_sqs.len());
    if turret_count == 0 {
        return 0;
    }

    let mut needs_any_query = false;
    let mut max_acquire_range = 0.0;
    let mut max_weapon_offset = 0.0;

    for turret_idx in 0..turret_count {
        cached_fire_ranks[turret_idx] = CT_TARGET_RANK_NONE;
        cached_fire_dist_sqs[turret_idx] = f64::INFINITY;

        let idx = combat_targeting_turret_global_idx(entity_slot, turret_idx as u32);
        if combat_targeting_weapon_system_disabled(
            pool,
            idx,
            turret_shield_panels_enabled,
            turret_shield_spheres_enabled,
        ) {
            continue;
        }

        let flags = pool.turret_config_flags[idx];
        if (flags & CT_TURRET_CFG_IS_MANUAL_FIRE) != 0 {
            continue;
        }
        if (flags & CT_TURRET_CFG_NO_AUTO_ACQUIRE) != 0 {
            continue;
        }

        // A mount that accepted its host task keeps tracking that target. A
        // sibling that rejected the same task remains idle and continues into
        // normal acquisition below.
        if combat_targeting_turret_has_satisfied_task(pool, idx) {
            continue;
        }

        let acquire = pool.turret_outermost_acquire[idx];
        if acquire > max_acquire_range {
            max_acquire_range = acquire;
        }
        let offset = pool.turret_mount_offset_2d[idx];
        if offset > max_weapon_offset {
            max_weapon_offset = offset;
        }

        let mut cached_rank = CT_TARGET_RANK_NONE;
        let periodic_rescore_due =
            combat_targeting_periodic_rescore_due(pool, entity_idx, idx, current_tick);
        if pool.turret_state[idx] == CT_TURRET_STATE_ENGAGED
            && (pool.turret_fire_min_release_sq[idx] > 0.0 || periodic_rescore_due)
        {
            let (rank, dist_sq) = combat_targeting_current_fire_target_rank_sq(pool, idx);
            cached_rank = rank;
            cached_fire_ranks[turret_idx] = rank;
            cached_fire_dist_sqs[turret_idx] = dist_sq;
        }

        let prefer_non_threat_current_target =
            combat_targeting_turret_prefer_reacquire_current_target_non_threat(
                pool,
                entity_idx,
                pool.entity_id[entity_idx],
                idx,
            );

        if pool.turret_target_id[idx] < 0
            || pool.turret_state[idx] == CT_TURRET_STATE_TRACKING
            || cached_rank == CT_TARGET_RANK_FIRE_FALLBACK
            || prefer_non_threat_current_target
            || periodic_rescore_due
        {
            needs_any_query = true;
        }
    }

    if out_f64.len() >= 2 {
        out_f64[0] = max_acquire_range;
        out_f64[1] = max_weapon_offset;
    }

    if needs_any_query {
        1
    } else {
        0
    }
}

#[inline]
pub(crate) fn combat_targeting_clear_choice_prep_outputs(
    count: usize,
    apply_mask: &mut [u8],
    seed_ranks: &mut [u8],
    seed_dist_sqs: &mut [f64],
    seed_shield_panel_scores: &mut [f64],
) {
    for i in 0..count {
        apply_mask[i] = 0;
        seed_ranks[i] = CT_TARGET_RANK_NONE;
        seed_dist_sqs[i] = f64::INFINITY;
        seed_shield_panel_scores[i] = 0.0;
    }
}

#[inline]
pub(crate) fn combat_targeting_turret_has_satisfied_task(
    pool: &CombatTargetingPool,
    idx: usize,
) -> bool {
    let task_target_id = pool.turret_task_target_id[idx];
    let task_state_active = pool.turret_state[idx] != CT_TURRET_STATE_IDLE;
    task_state_active
        && ((task_target_id >= 0 && pool.turret_target_id[idx] == task_target_id)
            || pool.turret_task_point_active[idx] != 0)
}

#[inline]
pub(crate) fn combat_targeting_choice_prep_result(current: u8, flags: u32) -> u8 {
    if (flags & CT_TURRET_CFG_PASSIVE) != 0 {
        current | CT_TARGETING_PREP_HAS_APPLY | CT_TARGETING_PREP_HAS_PASSIVE_APPLY
    } else {
        current | CT_TARGETING_PREP_HAS_APPLY
    }
}

/// AIM-08.5 — Rust-owned fire-choice gate preparation for one entity.
/// Replaces the TS per-weapon loop that decided which existing locks
/// should scan the shared candidate list and seeded each turret's
/// current fire-band rank/distance. Passive shield-panel seed scores remain
/// object-owned on the JS side because their priority function still
/// reads target turret activity.
#[wasm_bindgen]
pub fn combat_targeting_prepare_fire_choice_fsm_inputs(
    entity_slot: u32,
    source_entity_id: i32,
    turret_shield_panels_enabled: u8,
    turret_shield_spheres_enabled: u8,
    cached_fire_ranks: &[u8],
    cached_fire_dist_sqs: &[f64],
    apply_mask: &mut [u8],
    seed_ranks: &mut [u8],
    seed_dist_sqs: &mut [f64],
    seed_shield_panel_scores: &mut [f64],
) -> u8 {
    let pool = combat_targeting_pool();
    let entity_idx = entity_slot as usize;
    if entity_idx >= pool.turret_count_per_entity.len() {
        return 0;
    }

    let count = (pool.turret_count_per_entity[entity_idx] as usize)
        .min(COMBAT_TARGETING_MAX_TURRETS_PER_ENTITY as usize)
        .min(cached_fire_ranks.len())
        .min(cached_fire_dist_sqs.len())
        .min(apply_mask.len())
        .min(seed_ranks.len())
        .min(seed_dist_sqs.len())
        .min(seed_shield_panel_scores.len());
    combat_targeting_clear_choice_prep_outputs(
        count,
        apply_mask,
        seed_ranks,
        seed_dist_sqs,
        seed_shield_panel_scores,
    );

    let mut result = 0u8;
    for turret_idx in 0..count {
        let idx = combat_targeting_turret_global_idx(entity_slot, turret_idx as u32);
        if combat_targeting_weapon_system_disabled(
            pool,
            idx,
            turret_shield_panels_enabled,
            turret_shield_spheres_enabled,
        ) {
            continue;
        }

        let flags = pool.turret_config_flags[idx];
        if (flags & CT_TURRET_CFG_IS_MANUAL_FIRE) != 0 {
            continue;
        }
        if combat_targeting_turret_has_satisfied_task(pool, idx) {
            continue;
        }
        let target_id = pool.turret_target_id[idx];
        if target_id < 0 {
            continue;
        }

        let cached_rank = cached_fire_ranks[turret_idx];
        let prefer_non_threat_current_target =
            combat_targeting_turret_prefer_reacquire_current_target_non_threat(
                pool,
                entity_slot as usize,
                source_entity_id,
                idx,
            );
        let periodic_rescore =
            pool.turret_target_rescore_period_ticks[idx] > 0 && cached_rank != CT_TARGET_RANK_NONE;
        if pool.turret_state[idx] != CT_TURRET_STATE_TRACKING
            && cached_rank != CT_TARGET_RANK_FIRE_FALLBACK
            && !prefer_non_threat_current_target
            && !periodic_rescore
        {
            continue;
        }

        apply_mask[turret_idx] = 1;
        seed_ranks[turret_idx] = cached_rank;
        seed_dist_sqs[turret_idx] = cached_fire_dist_sqs[turret_idx];
        // Passive turrets seed their fire-choice rank against the
        // shield-panel DPS of their current target so candidate scoring can
        // prefer higher-DPS lock-on opportunities. Non-passive turrets
        // leave the score at the 0 cleared above.
        if (flags & CT_TURRET_CFG_PASSIVE) != 0 {
            if let Some(target_slot) = combat_targeting_entity_slot_for_id(pool, target_id) {
                seed_shield_panel_scores[turret_idx] =
                    combat_targeting_shield_panel_target_score_for_slot(
                        pool,
                        target_slot,
                        entity_slot as usize,
                        source_entity_id,
                    );
            }
        }
        result = combat_targeting_choice_prep_result(result, flags);
    }

    result
}

/// AIM-08.5 — Rust-owned acquisition gate preparation for one entity.
/// Replaces the TS per-weapon loop that selected idle turrets for the
/// acquisition candidate scan and seeded them with the empty target.
#[wasm_bindgen]
pub fn combat_targeting_prepare_acquisition_choice_fsm_inputs(
    entity_slot: u32,
    turret_shield_panels_enabled: u8,
    turret_shield_spheres_enabled: u8,
    apply_mask: &mut [u8],
    seed_ranks: &mut [u8],
    seed_dist_sqs: &mut [f64],
    seed_shield_panel_scores: &mut [f64],
) -> u8 {
    let pool = combat_targeting_pool();
    let entity_idx = entity_slot as usize;
    if entity_idx >= pool.turret_count_per_entity.len() {
        return 0;
    }

    let count = (pool.turret_count_per_entity[entity_idx] as usize)
        .min(COMBAT_TARGETING_MAX_TURRETS_PER_ENTITY as usize)
        .min(apply_mask.len())
        .min(seed_ranks.len())
        .min(seed_dist_sqs.len())
        .min(seed_shield_panel_scores.len());
    combat_targeting_clear_choice_prep_outputs(
        count,
        apply_mask,
        seed_ranks,
        seed_dist_sqs,
        seed_shield_panel_scores,
    );

    let mut result = 0u8;
    for turret_idx in 0..count {
        let idx = combat_targeting_turret_global_idx(entity_slot, turret_idx as u32);
        if combat_targeting_weapon_system_disabled(
            pool,
            idx,
            turret_shield_panels_enabled,
            turret_shield_spheres_enabled,
        ) {
            continue;
        }

        let flags = pool.turret_config_flags[idx];
        if (flags & CT_TURRET_CFG_IS_MANUAL_FIRE) != 0 {
            continue;
        }
        if combat_targeting_turret_has_satisfied_task(pool, idx) {
            continue;
        }
        if pool.turret_target_id[idx] >= 0 {
            continue;
        }

        apply_mask[turret_idx] = 1;
        result = combat_targeting_choice_prep_result(result, flags);
    }

    result
}

/// Clear one turret's lock in the combat-targeting slab. JS uses this
/// for object-owned gates (manual/passive/disabled branches) while the
/// rest of the FSM transition writes live here.
#[wasm_bindgen]
pub fn combat_targeting_clear_turret_lock(entity_slot: u32, turret_idx: u32) {
    let pool = combat_targeting_pool();
    let Some(idx) = combat_targeting_live_turret_idx(pool, entity_slot, turret_idx) else {
        return;
    };
    combat_targeting_set_target_state(pool, idx, -1, CT_TURRET_STATE_IDLE);
}

/// Clear every live turret lock for one entity in one boundary call.
/// Used by global fire-disable paths while JS still owns priority
/// command fields and cooldown bookkeeping.
#[wasm_bindgen]
pub fn combat_targeting_clear_entity_locks(entity_slot: u32) {
    let pool = combat_targeting_pool();
    let entity_idx = entity_slot as usize;
    if entity_idx >= pool.turret_count_per_entity.len() {
        return;
    }
    let count = pool.turret_count_per_entity[entity_idx] as u32;
    for turret_idx in 0..count {
        if turret_idx >= COMBAT_TARGETING_MAX_TURRETS_PER_ENTITY {
            break;
        }
        let idx = combat_targeting_turret_global_idx(entity_slot, turret_idx);
        combat_targeting_set_target_state(pool, idx, -1, CT_TURRET_STATE_IDLE);
    }
}

mod scheduler;
#[cfg(test)]
pub(crate) use scheduler::*;

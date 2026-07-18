// combat_targeting::fsm — the per-tick lock-on FSM batch processors,
// extracted from combat_targeting.rs as a child submodule (pure code
// motion, file-size discipline). Reads the parent's CombatTargetingPool
// SoA + pub(crate) helpers via `use super::*`.
#[allow(unused_imports)]
use super::*;
#[allow(unused_imports)]
use crate::*;
#[allow(unused_imports)]
use wasm_bindgen::prelude::*;

#[inline]
pub(crate) fn combat_targeting_apply_priority_point_fsm_idx(
    pool: &mut CombatTargetingPool,
    idx: usize,
    target: CombatTargetingCylinderTarget,
    los_clear: u8,
    ballistic_clear: u8,
    shield_clear: u8,
) {
    let old_state = pool.turret_state[idx];
    let next_state = if los_clear == 0
        || ballistic_clear == 0
        || !combat_targeting_turret_allows_target_medium(pool, idx, target)
    {
        CT_TURRET_STATE_IDLE
    } else if shield_clear == 0 {
        CT_TURRET_STATE_IDLE
    } else if combat_targeting_fire_max_cylinder_contains(pool, idx, false, target) {
        CT_TURRET_STATE_ENGAGED
    } else if combat_targeting_fire_max_cylinder_contains(pool, idx, true, target) {
        if old_state == CT_TURRET_STATE_ENGAGED {
            CT_TURRET_STATE_ENGAGED
        } else {
            CT_TURRET_STATE_TRACKING
        }
    } else {
        CT_TURRET_STATE_TRACKING
    };
    combat_targeting_set_target_state(pool, idx, -1, next_state);
}

/// AIM-08.5 — batch attack-ground priority transitions for one entity.
/// JS supplies the still-object-owned gates as parallel per-turret
/// masks; Rust reads the current mount positions from the slab and
/// applies all target/state transitions in one boundary call.
#[wasm_bindgen]
pub fn combat_targeting_apply_priority_point_fsm_batch(
    entity_slot: u32,
    target_x: f64,
    target_y: f64,
    target_z: f64,
    apply_mask: &[u8],
    los_clear: &[u8],
    ballistic_clear: &[u8],
    shield_clear: &[u8],
) {
    let pool = combat_targeting_pool();
    let entity_idx = entity_slot as usize;
    if entity_idx >= pool.turret_count_per_entity.len() {
        return;
    }
    let count = (pool.turret_count_per_entity[entity_idx] as usize)
        .min(COMBAT_TARGETING_MAX_TURRETS_PER_ENTITY as usize)
        .min(apply_mask.len())
        .min(los_clear.len())
        .min(ballistic_clear.len())
        .min(shield_clear.len());
    for turret_idx in 0..count {
        if apply_mask[turret_idx] == 0 {
            continue;
        }
        let idx = combat_targeting_turret_global_idx(entity_slot, turret_idx as u32);
        let target =
            combat_targeting_cylinder_target_to_point(pool, idx, target_x, target_y, target_z);
        combat_targeting_apply_priority_point_fsm_idx(
            pool,
            idx,
            target,
            los_clear[turret_idx],
            ballistic_clear[turret_idx],
            shield_clear[turret_idx],
        );
    }
}

/// Under-only ballistic lock floor: the lock-on point must sit at least
/// this far below the weapon mount along the world Z axis. Matches the
/// TypeScript UNDER_ONLY_MIN_BELOW_DISTANCE in targetingSystem.ts.
pub(crate) const CT_UNDER_ONLY_MIN_BELOW_DISTANCE: f64 = 30.0;
pub(crate) const CT_UNDER_ONLY_LOCK_EPS: f64 = 1e-6;

#[inline]
pub(crate) fn combat_targeting_slab_gate_config(
    pool: &CombatTargetingPool,
    idx: usize,
) -> (f64, f64, f64, u8, f64, f64, bool) {
    (
        pool.turret_projectile_speed[idx],
        pool.turret_projectile_mass[idx],
        pool.turret_projectile_air_friction_per_60hz_frame[idx],
        pool.turret_arc_preference[idx],
        pool.turret_max_time_sec[idx],
        pool.turret_ground_aim_fraction[idx],
        pool.turret_under_only[idx] != 0,
    )
}

/// AIM-08.5 — Shared gate-compute helper for the three unified priority
/// / existing-lock kernels. Returns the three per-turret clearance
/// flags the FSM transition functions consume:
///   - `los_clear`: terrain + entity LOS from mount to the raw aim
///     point (or `1` for high-arc / line-of-sight-exempt weapons).
///   - `ballistic_clear`: weapon can produce a flight solution given
///     the under-only floor, ground-aim adjustment, and target
///     kinematics. Direct-fire and vertical-launcher weapons auto-pass,
///     mirroring the TS `weaponUsesNormalAim`/`weaponNeedsBallisticSolution`
///     short-circuit.
///   - `shield_clear`: segment-checks the FF pool from mount to
///     raw aim point. Panel and sphere shapes use the same material
///     policy and differ only in their intersection math. Skipped
///     (returns `1`) when the feature is off, the shape toggles leave
///     no active shield material, or for shield-only emitters that
///     maintain the material themselves. Shield emitters with offensive
///     submunitions do not get the exemption.
///
/// The helper short-circuits in cost-increasing order to match the TS
/// gate evaluation: LOS → ballistic → FF. Ground-aim fraction applies
/// only to the ballistic solve's aim point — LOS and FF use the raw
/// aim point, the same way the TS path does.
pub(crate) fn compute_turret_gates_for_aim_point(
    pool: &mut CombatTargetingPool,
    entity_slot: u32,
    turret_idx: u32,
    idx: usize,
    flags: u32,
    mount_x: f64,
    mount_y: f64,
    mount_z: f64,
    raw_aim_x: f64,
    raw_aim_y: f64,
    raw_aim_z: f64,
    target_vx: f64,
    target_vy: f64,
    target_vz: f64,
    target_entity_id: i32,
    source_entity_id: i32,
    terrain_step_len: f64,
    entity_line_width: f64,
    turret_shield_panels_enabled: u8,
    turret_shield_spheres_enabled: u8,
    shield_obstruction_active: u8,
    projectile_speed: f64,
    projectile_mass: f64,
    projectile_air_friction_per_60hz_frame: f64,
    arc_preference: u8,
    max_time_sec: f64,
    ground_aim_fraction: f64,
    under_only: bool,
    gravity: f64,
) -> (u8, u8, u8) {
    let los_clear: u8 = if (flags & CT_TURRET_CFG_REQUIRES_NON_OBSTRUCTED_LOS) != 0 {
        combat_has_line_of_sight(
            mount_x,
            mount_y,
            mount_z,
            raw_aim_x,
            raw_aim_y,
            raw_aim_z,
            terrain_step_len,
            entity_line_width,
            source_entity_id,
            target_entity_id,
        ) as u8
    } else {
        1
    };

    let mut ballistic_clear: u8 = 0;
    if los_clear != 0 {
        let under_only_ok = if under_only {
            raw_aim_z <= mount_z - CT_UNDER_ONLY_MIN_BELOW_DISTANCE + CT_UNDER_ONLY_LOCK_EPS
        } else {
            true
        };
        if under_only_ok {
            if (flags & CT_TURRET_CFG_NEEDS_BALLISTIC) == 0
                || (flags & CT_TURRET_CFG_VERTICAL_LAUNCHER) != 0
            {
                // Direct-fire / vertical-launcher: skip the ballistic solve.
                // The same slab fields still carry a reusable yaw/pitch pose
                // for turret rotation and downstream beam paths.
                combat_targeting_write_direct_aim_solution(
                    pool, idx, mount_x, mount_y, mount_z, raw_aim_x, raw_aim_y, raw_aim_z,
                );
                ballistic_clear = 1;
            } else {
                // Ground-aim fraction blends the aim point toward the
                // mount and onto terrain (and scales target velocity
                // accordingly). `f == 0` means "use the raw aim point."
                let f = ground_aim_fraction;
                let (ball_aim_x, ball_aim_y, ball_aim_z, ball_tvx, ball_tvy, ball_tvz) = if f > 0.0
                {
                    let ax = mount_x + f * (raw_aim_x - mount_x);
                    let ay = mount_y + f * (raw_aim_y - mount_y);
                    let az = terrain_get_surface_height(ax, ay);
                    (ax, ay, az, target_vx * f, target_vy * f, 0.0)
                } else {
                    (
                        raw_aim_x, raw_aim_y, raw_aim_z, target_vx, target_vy, target_vz,
                    )
                };
                let fallback_yaw = pool.turret_rotation[idx] as f64;
                let fallback_pitch = pool.turret_pitch[idx] as f64;
                ballistic_clear = combat_targeting_solve_ballistic_aim_inner(
                    pool,
                    entity_slot,
                    turret_idx,
                    ball_aim_x,
                    ball_aim_y,
                    ball_aim_z,
                    ball_tvx,
                    ball_tvy,
                    ball_tvz,
                    0.0,
                    0.0,
                    0.0,
                    0.0,
                    0.0,
                    0.0,
                    projectile_speed,
                    projectile_mass,
                    projectile_air_friction_per_60hz_frame,
                    gravity,
                    arc_preference,
                    max_time_sec,
                    fallback_yaw,
                    fallback_pitch,
                ) as u8;
            }
        }
    }

    let mut shield_clear: u8 = 1;
    if ballistic_clear != 0
        && shield_obstruction_active != 0
        && !combat_targeting_turret_ignores_force_material_sight_obstruction(flags)
    {
        // Spheres and panels are one material, so a single clearance call
        // with a shared crossing budget answers both shapes at once. The
        // battle toggles decide which shapes are present; no turret-family
        // branch may make panel material transparent while sphere material
        // is opaque.
        let include_spheres: u8 = if turret_shield_spheres_enabled != 0 {
            1
        } else {
            0
        };
        let include_panels: u8 = if turret_shield_panels_enabled != 0 {
            1
        } else {
            0
        };
        if include_spheres != 0 || include_panels != 0 {
            if shield_clearance_segment(
                mount_x,
                mount_y,
                mount_z,
                raw_aim_x,
                raw_aim_y,
                raw_aim_z,
                -1,
                0,
                include_spheres,
                include_panels,
            ) == 0
            {
                shield_clear = 0;
            }
        }
    }

    (los_clear, ballistic_clear, shield_clear)
}

/// AIM-08.5 — unified priority-point gate compute + FSM apply for one
/// entity. Replaces the per-weapon TypeScript loop that called the LOS,
/// ballistic, and shield kernels separately and then applied the
/// FSM through `combat_targeting_apply_priority_point_fsm_batch`. The
/// kernel iterates the slab turrets once and computes every gate
/// internally, so a 5-turret entity makes one boundary call instead of
/// ~16 (3 gates × 5 turrets + 1 batch apply).
///
/// The kernel handles disabled/manual-fire/passive turrets the same way
/// the TS path does:
///   - manual fire → no FSM update
///   - weapon system disabled (visualOnly / passive&&!shield-panels /
///     forceShot&&!fields) → no FSM update (the TS resetDisabledWeapon
///     pass has already cleared their state)
///   - passive → clear the lock (matches `targeting.clearTurretLock(...)`)
#[wasm_bindgen]
pub fn combat_targeting_compute_and_apply_priority_point_fsm_batch(
    entity_slot: u32,
    point_x: f64,
    point_y: f64,
    point_z: f64,
    source_entity_id: i32,
    turret_shield_panels_enabled: u8,
    turret_shield_spheres_enabled: u8,
    shield_obstruction_active: u8,
    terrain_step_len: f64,
    entity_line_width: f64,
    gravity: f64,
) {
    let pool = combat_targeting_pool();
    let entity_idx = entity_slot as usize;
    if entity_idx >= pool.turret_count_per_entity.len() {
        return;
    }
    let count = (pool.turret_count_per_entity[entity_idx] as usize)
        .min(COMBAT_TARGETING_MAX_TURRETS_PER_ENTITY as usize);

    for turret_idx in 0..count {
        let idx = combat_targeting_turret_global_idx(entity_slot, turret_idx as u32);
        let flags = pool.turret_config_flags[idx];

        // Manual-fire weapons never participate in priority FSM transitions.
        // The TS Pass 0 also forces their state to 'idle' for the kinematics
        // step, but the priority-point branch skips them outright.
        if (flags & CT_TURRET_CFG_IS_MANUAL_FIRE) != 0 {
            continue;
        }
        // Fully-autonomous turrets ignore the host's priority point
        // entirely. They keep their existing FSM state and run their own
        // independent acquisition.
        if (flags & CT_TURRET_CFG_HOST_DIRECTED) == 0 {
            continue;
        }
        // System-disabled weapons have already been reset by the TS
        // resetDisabledWeapon pre-pass; mirror this kernel's skip there.
        if combat_targeting_weapon_system_disabled(
            pool,
            idx,
            turret_shield_panels_enabled,
            turret_shield_spheres_enabled,
        ) {
            continue;
        }
        // Passive shield-panel weapons never lock onto an attack-ground
        // order. Clear any existing lock — same behaviour as the old
        // targeting.clearTurretLock(unitSlot, wi) call.
        if (flags & CT_TURRET_CFG_PASSIVE) != 0 {
            combat_targeting_set_target_state(pool, idx, -1, CT_TURRET_STATE_IDLE);
            continue;
        }

        let mount_x = pool.turret_mount_x[idx];
        let mount_y = pool.turret_mount_y[idx];
        let mount_z = pool.turret_mount_z[idx];
        let (
            projectile_speed,
            projectile_mass,
            projectile_air_friction_per_60hz_frame,
            arc_preference,
            max_time_sec,
            ground_aim_fraction,
            under_only,
        ) = combat_targeting_slab_gate_config(pool, idx);

        let (los_clear, ballistic_clear, shield_clear) = compute_turret_gates_for_aim_point(
            pool,
            entity_slot,
            turret_idx as u32,
            idx,
            flags,
            mount_x,
            mount_y,
            mount_z,
            point_x,
            point_y,
            point_z,
            0.0,
            0.0,
            0.0,
            -1,
            source_entity_id,
            terrain_step_len,
            entity_line_width,
            turret_shield_panels_enabled,
            turret_shield_spheres_enabled,
            shield_obstruction_active,
            projectile_speed,
            projectile_mass,
            projectile_air_friction_per_60hz_frame,
            arc_preference,
            max_time_sec,
            ground_aim_fraction,
            under_only,
            gravity,
        );

        let target =
            combat_targeting_cylinder_target_to_point(pool, idx, point_x, point_y, point_z);
        combat_targeting_apply_priority_point_fsm_idx(
            pool,
            idx,
            target,
            los_clear,
            ballistic_clear,
            shield_clear,
        );
    }
}

#[inline]
pub(crate) fn combat_targeting_apply_priority_target_fsm_idx(
    pool: &mut CombatTargetingPool,
    idx: usize,
    target_id: i32,
    target: CombatTargetingCylinderTarget,
    target_valid: u8,
    shield_panel_valid: u8,
    los_clear: u8,
    ballistic_clear: u8,
    shield_clear: u8,
) {
    if target_id < 0
        || target_valid == 0
        || shield_panel_valid == 0
        || los_clear == 0
        || ballistic_clear == 0
        || shield_clear == 0
        || !combat_targeting_range_volume_allows_target_domain(
            combat_targeting_turret_range_volume(pool, idx),
            target,
        )
        || !combat_targeting_turret_allows_target_medium(pool, idx, target)
    {
        combat_targeting_set_target_state(pool, idx, -1, CT_TURRET_STATE_IDLE);
        return;
    }

    let old_state = pool.turret_state[idx];
    let next_state = if combat_targeting_fire_max_cylinder_contains(pool, idx, false, target) {
        CT_TURRET_STATE_ENGAGED
    } else if combat_targeting_fire_max_cylinder_contains(pool, idx, true, target) {
        if old_state == CT_TURRET_STATE_ENGAGED {
            CT_TURRET_STATE_ENGAGED
        } else {
            CT_TURRET_STATE_TRACKING
        }
    } else {
        CT_TURRET_STATE_TRACKING
    };
    combat_targeting_set_target_state(pool, idx, target_id, next_state);
}

/// AIM-08.5 — batch attack-entity priority transitions for one entity.
/// Rust resolves the target slot/radius and per-turret distances from
/// the slab; JS supplies visibility/mirror/LOS/ballistic/field gates.
#[wasm_bindgen]
pub fn combat_targeting_apply_priority_target_fsm_batch(
    entity_slot: u32,
    target_id: i32,
    apply_mask: &[u8],
    shield_panel_valid: &[u8],
    los_clear: &[u8],
    ballistic_clear: &[u8],
    shield_clear: &[u8],
) {
    let pool = combat_targeting_pool();
    let entity_idx = entity_slot as usize;
    if entity_idx >= pool.turret_count_per_entity.len() {
        return;
    }
    let target_slot = combat_targeting_entity_slot_for_id(pool, target_id);
    let target_valid = if let Some(slot) = target_slot {
        if combat_targeting_entity_alive(pool, slot) {
            1
        } else {
            0
        }
    } else {
        0
    };
    let count = (pool.turret_count_per_entity[entity_idx] as usize)
        .min(COMBAT_TARGETING_MAX_TURRETS_PER_ENTITY as usize)
        .min(apply_mask.len())
        .min(shield_panel_valid.len())
        .min(los_clear.len())
        .min(ballistic_clear.len())
        .min(shield_clear.len());
    for turret_idx in 0..count {
        if apply_mask[turret_idx] == 0 {
            continue;
        }
        let idx = combat_targeting_turret_global_idx(entity_slot, turret_idx as u32);
        let turret_target_valid = if target_valid != 0
            && target_slot
                .map(|slot| {
                    combat_targeting_turret_may_lock_entity_slot(pool, entity_idx, idx, slot)
                })
                .unwrap_or(false)
        {
            1
        } else {
            0
        };
        let target = target_slot
            .map(|slot| combat_targeting_cylinder_target_to_entity_slot(pool, idx, slot))
            .unwrap_or_else(combat_targeting_invalid_cylinder_target);
        combat_targeting_apply_priority_target_fsm_idx(
            pool,
            idx,
            target_id,
            target,
            turret_target_valid,
            shield_panel_valid[turret_idx],
            los_clear[turret_idx],
            ballistic_clear[turret_idx],
            shield_clear[turret_idx],
        );
    }
}

#[inline]
pub(crate) fn combat_targeting_validate_existing_lock_fsm_idx(
    pool: &mut CombatTargetingPool,
    idx: usize,
    target: CombatTargetingCylinderTarget,
    target_valid: u8,
    shield_panel_valid: u8,
    ballistic_clear: u8,
    los_blocked: u8,
    los_drop_grace_ticks: u16,
) {
    if target_valid == 0 || shield_panel_valid == 0 || ballistic_clear == 0 {
        combat_targeting_set_target_state(pool, idx, -1, CT_TURRET_STATE_IDLE);
        return;
    }

    let blocked = los_blocked != 0;
    pool.turret_los_blocked_ticks[idx] = if blocked {
        pool.turret_los_blocked_ticks[idx].saturating_add(1)
    } else {
        0
    };
    let los_drop = pool.turret_los_blocked_ticks[idx] > los_drop_grace_ticks;
    if !combat_targeting_outermost_release_cylinder_contains(pool, idx, target) || los_drop {
        combat_targeting_set_target_state(pool, idx, -1, CT_TURRET_STATE_IDLE);
        return;
    }

    let state = pool.turret_state[idx];
    if state == CT_TURRET_STATE_TRACKING {
        if !blocked && combat_targeting_fire_max_cylinder_contains(pool, idx, false, target) {
            pool.turret_state[idx] = CT_TURRET_STATE_ENGAGED;
        }
    } else if state == CT_TURRET_STATE_ENGAGED
        && (blocked || !combat_targeting_fire_max_cylinder_contains(pool, idx, true, target))
    {
        pool.turret_state[idx] = CT_TURRET_STATE_TRACKING;
    }
}

/// AIM-08.5 — batch existing-lock validation for one entity. Rust
/// reads target ids, target liveness, target radii, and per-turret
/// distance from the slab; JS only supplies gates that still depend on
/// object-owned systems during migration.
#[wasm_bindgen]
pub fn combat_targeting_validate_existing_lock_fsm_batch(
    entity_slot: u32,
    apply_mask: &[u8],
    target_observable: &[u8],
    shield_panel_valid: &[u8],
    ballistic_clear: &[u8],
    los_blocked: &[u8],
    los_drop_grace_ticks: u16,
) {
    let pool = combat_targeting_pool();
    let entity_idx = entity_slot as usize;
    if entity_idx >= pool.turret_count_per_entity.len() {
        return;
    }
    let count = (pool.turret_count_per_entity[entity_idx] as usize)
        .min(COMBAT_TARGETING_MAX_TURRETS_PER_ENTITY as usize)
        .min(apply_mask.len())
        .min(target_observable.len())
        .min(shield_panel_valid.len())
        .min(ballistic_clear.len())
        .min(los_blocked.len());
    for turret_idx in 0..count {
        if apply_mask[turret_idx] == 0 {
            continue;
        }
        let idx = combat_targeting_turret_global_idx(entity_slot, turret_idx as u32);
        let target_slot = combat_targeting_entity_slot_for_id(pool, pool.turret_target_id[idx]);
        let target_valid = if target_observable[turret_idx] != 0 {
            target_slot
                .map(|slot| {
                    (combat_targeting_turret_may_lock_entity_slot(pool, entity_idx, idx, slot))
                        as u8
                })
                .unwrap_or(0)
        } else {
            0
        };
        let target = target_slot
            .map(|slot| combat_targeting_cylinder_target_to_entity_slot(pool, idx, slot))
            .unwrap_or_else(combat_targeting_invalid_cylinder_target);
        combat_targeting_validate_existing_lock_fsm_idx(
            pool,
            idx,
            target,
            target_valid,
            shield_panel_valid[turret_idx],
            ballistic_clear[turret_idx],
            los_blocked[turret_idx],
            los_drop_grace_ticks,
        );
    }
}

pub(crate) fn combat_targeting_compute_and_apply_priority_target_fsm_batch_inner(
    entity_slot: u32,
    target_id: i32,
    source_entity_id: i32,
    turret_shield_panels_enabled: u8,
    turret_shield_spheres_enabled: u8,
    shield_obstruction_active: u8,
    terrain_step_len: f64,
    entity_line_width: f64,
    gravity: f64,
    aim_x: &[f64],
    aim_y: &[f64],
    aim_z: &[f64],
    resolve_aim_from_slab: bool,
) {
    let pool = combat_targeting_pool();
    let entity_idx = entity_slot as usize;
    if entity_idx >= pool.turret_count_per_entity.len() {
        return;
    }
    let source_view_mask = pool.entity_view_mask[entity_idx];

    let target_slot = combat_targeting_entity_slot_for_id(pool, target_id);
    let (base_target_valid, target_vx, target_vy, target_vz) = if let Some(slot) = target_slot {
        if combat_targeting_entity_alive(pool, slot)
            && combat_targeting_view_mask_observes_entity(pool, slot, source_view_mask)
            && combat_targeting_entity_may_lock_entity_slot(pool, entity_idx, slot)
        {
            (
                1u8,
                pool.entity_vel_x[slot],
                pool.entity_vel_y[slot],
                pool.entity_vel_z[slot],
            )
        } else {
            (0u8, 0.0, 0.0, 0.0)
        }
    } else {
        (0u8, 0.0, 0.0, 0.0)
    };

    // Mirror-valid is identical for every passive turret on this unit
    // (it depends only on target + source, not on the turret), so
    // compute it once up front using the Rust mirror-target helper.
    // Non-passive turrets get shield_panel_valid = 1 unconditionally.
    let passive_shield_panel_valid: u8 = match target_slot {
        Some(slot) => {
            if combat_targeting_is_shield_panel_target_for_slot(
                pool,
                slot,
                entity_idx,
                source_entity_id,
            ) {
                1
            } else {
                0
            }
        }
        None => 0,
    };

    let mut count = (pool.turret_count_per_entity[entity_idx] as usize)
        .min(COMBAT_TARGETING_MAX_TURRETS_PER_ENTITY as usize);
    if !resolve_aim_from_slab {
        count = count.min(aim_x.len()).min(aim_y.len()).min(aim_z.len());
    }

    for turret_idx in 0..count {
        let idx = combat_targeting_turret_global_idx(entity_slot, turret_idx as u32);
        let flags = pool.turret_config_flags[idx];

        if (flags & CT_TURRET_CFG_IS_MANUAL_FIRE) != 0 {
            continue;
        }
        // Fully-autonomous turrets ignore the host's priority target
        // entirely. They keep their existing FSM state and run their own
        // independent acquisition.
        if (flags & CT_TURRET_CFG_HOST_DIRECTED) == 0 {
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

        let target_valid = if base_target_valid != 0
            && target_slot
                .map(|slot| {
                    combat_targeting_turret_may_lock_entity_slot(pool, entity_idx, idx, slot)
                })
                .unwrap_or(false)
        {
            1u8
        } else {
            0u8
        };

        let shield_panel_valid = if (flags & CT_TURRET_CFG_PASSIVE) == 0 {
            1u8
        } else {
            passive_shield_panel_valid
        };

        let mount_x = pool.turret_mount_x[idx];
        let mount_y = pool.turret_mount_y[idx];
        let mount_z = pool.turret_mount_z[idx];
        let (
            projectile_speed,
            projectile_mass,
            projectile_air_friction_per_60hz_frame,
            arc_preference,
            max_time_sec,
            ground_aim_fraction,
            under_only,
        ) = combat_targeting_slab_gate_config(pool, idx);

        // Short-circuit when the target or mirror gate has already
        // failed — saves the LOS/ballistic/FF compute since the FSM
        // is going to idle anyway.
        let (los_clear, ballistic_clear, shield_clear) =
            if target_valid == 0 || shield_panel_valid == 0 {
                (0u8, 0u8, 0u8)
            } else {
                let (target_aim_x, target_aim_y, target_aim_z) = if resolve_aim_from_slab {
                    match target_slot {
                        Some(slot) => combat_targeting_resolve_aim_point_from_slab(
                            pool,
                            entity_slot,
                            turret_idx as u32,
                            source_entity_id,
                            slot,
                            mount_x,
                            mount_y,
                            mount_z,
                        ),
                        None => (0.0, 0.0, 0.0),
                    }
                } else {
                    (aim_x[turret_idx], aim_y[turret_idx], aim_z[turret_idx])
                };
                compute_turret_gates_for_aim_point(
                    pool,
                    entity_slot,
                    turret_idx as u32,
                    idx,
                    flags,
                    mount_x,
                    mount_y,
                    mount_z,
                    target_aim_x,
                    target_aim_y,
                    target_aim_z,
                    target_vx,
                    target_vy,
                    target_vz,
                    target_id,
                    source_entity_id,
                    terrain_step_len,
                    entity_line_width,
                    turret_shield_panels_enabled,
                    turret_shield_spheres_enabled,
                    shield_obstruction_active,
                    projectile_speed,
                    projectile_mass,
                    projectile_air_friction_per_60hz_frame,
                    arc_preference,
                    max_time_sec,
                    ground_aim_fraction,
                    under_only,
                    gravity,
                )
            };

        let target = target_slot
            .map(|slot| combat_targeting_cylinder_target_to_entity_slot(pool, idx, slot))
            .unwrap_or_else(combat_targeting_invalid_cylinder_target);
        combat_targeting_apply_priority_target_fsm_idx(
            pool,
            idx,
            target_id,
            target,
            target_valid,
            shield_panel_valid,
            los_clear,
            ballistic_clear,
            shield_clear,
        );
    }
}

/// AIM-08.5 — unified attack-entity priority gate compute + FSM apply.
/// Rust owns LOS / ballistic / FF / mirror-panel / passive-mirror
/// gates. The exported compatibility wrapper still accepts caller
/// aim arrays; the mixed tick path below resolves body/AABB/turret
/// lock points directly from the slab.
#[wasm_bindgen]
pub fn combat_targeting_compute_and_apply_priority_target_fsm_batch(
    entity_slot: u32,
    target_id: i32,
    source_entity_id: i32,
    turret_shield_panels_enabled: u8,
    turret_shield_spheres_enabled: u8,
    shield_obstruction_active: u8,
    terrain_step_len: f64,
    entity_line_width: f64,
    gravity: f64,
    aim_x: &[f64],
    aim_y: &[f64],
    aim_z: &[f64],
) {
    combat_targeting_compute_and_apply_priority_target_fsm_batch_inner(
        entity_slot,
        target_id,
        source_entity_id,
        turret_shield_panels_enabled,
        turret_shield_spheres_enabled,
        shield_obstruction_active,
        terrain_step_len,
        entity_line_width,
        gravity,
        aim_x,
        aim_y,
        aim_z,
        false,
    );
}

pub(crate) fn combat_targeting_compute_and_apply_validate_existing_lock_fsm_batch_inner(
    entity_slot: u32,
    source_entity_id: i32,
    turret_shield_panels_enabled: u8,
    turret_shield_spheres_enabled: u8,
    shield_obstruction_active: u8,
    terrain_step_len: f64,
    entity_line_width: f64,
    gravity: f64,
    los_drop_grace_ticks: u16,
    aim_x: &[f64],
    aim_y: &[f64],
    aim_z: &[f64],
    resolve_aim_from_slab: bool,
) {
    let pool = combat_targeting_pool();
    let entity_idx = entity_slot as usize;
    if entity_idx >= pool.turret_count_per_entity.len() {
        return;
    }
    let source_view_mask = pool.entity_view_mask[entity_idx];

    let mut count = (pool.turret_count_per_entity[entity_idx] as usize)
        .min(COMBAT_TARGETING_MAX_TURRETS_PER_ENTITY as usize);
    if !resolve_aim_from_slab {
        count = count.min(aim_x.len()).min(aim_y.len()).min(aim_z.len());
    }

    for turret_idx in 0..count {
        let idx = combat_targeting_turret_global_idx(entity_slot, turret_idx as u32);
        let flags = pool.turret_config_flags[idx];

        if (flags & CT_TURRET_CFG_IS_MANUAL_FIRE) != 0 {
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
        // No existing target → nothing to validate; matches the TS
        // `weapon.target === null` skip.
        let target_id = pool.turret_target_id[idx];
        if target_id < 0 {
            continue;
        }

        let target_slot = combat_targeting_entity_slot_for_id(pool, target_id);
        let target_allowed = target_slot
            .map(|slot| combat_targeting_turret_may_lock_entity_slot(pool, entity_idx, idx, slot))
            .unwrap_or(false);
        let observable = target_allowed
            && match target_slot {
                Some(slot) => {
                    combat_targeting_view_mask_observes_entity(pool, slot, source_view_mask)
                }
                None => false,
            };
        let (target_valid, target_vx, target_vy, target_vz) = if observable {
            if let Some(slot) = target_slot {
                if combat_targeting_entity_alive(pool, slot) {
                    (
                        1u8,
                        pool.entity_vel_x[slot],
                        pool.entity_vel_y[slot],
                        pool.entity_vel_z[slot],
                    )
                } else {
                    (0u8, 0.0, 0.0, 0.0)
                }
            } else {
                (0u8, 0.0, 0.0, 0.0)
            }
        } else {
            (0u8, 0.0, 0.0, 0.0)
        };

        // For passive turrets, "valid" requires the target to still
        // carry a damaging turret locked onto us. Non-passive turrets
        // skip the mirror check.
        let shield_panel_valid = if target_valid == 0 {
            0u8
        } else if (flags & CT_TURRET_CFG_PASSIVE) == 0 {
            1u8
        } else {
            target_slot
                .map(|slot| {
                    if combat_targeting_is_shield_panel_target_for_slot(
                        pool,
                        slot,
                        entity_idx,
                        source_entity_id,
                    ) {
                        1u8
                    } else {
                        0u8
                    }
                })
                .unwrap_or(0u8)
        };

        let mount_x = pool.turret_mount_x[idx];
        let mount_y = pool.turret_mount_y[idx];
        let mount_z = pool.turret_mount_z[idx];
        let (
            projectile_speed,
            projectile_mass,
            projectile_air_friction_per_60hz_frame,
            arc_preference,
            max_time_sec,
            ground_aim_fraction,
            under_only,
        ) = combat_targeting_slab_gate_config(pool, idx);

        // Short-circuit when target invalid or mirror invalid — the
        // FSM will set state idle without consulting gates anyway.
        let (ballistic_clear, sight_blocked) = if target_valid == 0 || shield_panel_valid == 0 {
            (0u8, 0u8)
        } else {
            let (target_aim_x, target_aim_y, target_aim_z) = if resolve_aim_from_slab {
                match target_slot {
                    Some(slot) => combat_targeting_resolve_aim_point_from_slab(
                        pool,
                        entity_slot,
                        turret_idx as u32,
                        source_entity_id,
                        slot,
                        mount_x,
                        mount_y,
                        mount_z,
                    ),
                    None => (0.0, 0.0, 0.0),
                }
            } else {
                (aim_x[turret_idx], aim_y[turret_idx], aim_z[turret_idx])
            };
            let (los_clear, bc, ff_clear) = compute_turret_gates_for_aim_point(
                pool,
                entity_slot,
                turret_idx as u32,
                idx,
                flags,
                mount_x,
                mount_y,
                mount_z,
                target_aim_x,
                target_aim_y,
                target_aim_z,
                target_vx,
                target_vy,
                target_vz,
                target_id,
                source_entity_id,
                terrain_step_len,
                entity_line_width,
                turret_shield_panels_enabled,
                turret_shield_spheres_enabled,
                shield_obstruction_active,
                projectile_speed,
                projectile_mass,
                projectile_air_friction_per_60hz_frame,
                arc_preference,
                max_time_sec,
                ground_aim_fraction,
                under_only,
                gravity,
            );
            // sight_blocked = the weapon could otherwise fire
            // (ballistic OK) but a visibility gate failed. Matches
            // the TS predicate `ballisticClear && (!los || !ff)`.
            let blocked = if bc != 0 && (los_clear == 0 || ff_clear == 0) {
                1u8
            } else {
                0u8
            };
            (bc, blocked)
        };

        let target = target_slot
            .map(|slot| combat_targeting_cylinder_target_to_entity_slot(pool, idx, slot))
            .unwrap_or_else(combat_targeting_invalid_cylinder_target);
        combat_targeting_validate_existing_lock_fsm_idx(
            pool,
            idx,
            target,
            target_valid,
            shield_panel_valid,
            ballistic_clear,
            sight_blocked,
            los_drop_grace_ticks,
        );
    }
}

/// AIM-08.5 — unified existing-lock gate compute + FSM apply. Each
/// turret resolves its own target via `pool.turret_target_id[idx]`, so
/// the kernel walks the slab and looks up per-turret target metadata
/// itself. The exported compatibility wrapper accepts caller aim
/// arrays; the mixed tick path resolves body/AABB/turret lock points
/// directly from the slab.
#[wasm_bindgen]
pub fn combat_targeting_compute_and_apply_validate_existing_lock_fsm_batch(
    entity_slot: u32,
    source_entity_id: i32,
    turret_shield_panels_enabled: u8,
    turret_shield_spheres_enabled: u8,
    shield_obstruction_active: u8,
    terrain_step_len: f64,
    entity_line_width: f64,
    gravity: f64,
    los_drop_grace_ticks: u16,
    aim_x: &[f64],
    aim_y: &[f64],
    aim_z: &[f64],
) {
    combat_targeting_compute_and_apply_validate_existing_lock_fsm_batch_inner(
        entity_slot,
        source_entity_id,
        turret_shield_panels_enabled,
        turret_shield_spheres_enabled,
        shield_obstruction_active,
        terrain_step_len,
        entity_line_width,
        gravity,
        los_drop_grace_ticks,
        aim_x,
        aim_y,
        aim_z,
        false,
    );
}

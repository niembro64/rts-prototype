// Targeting scheduling, candidate scans, and ranking batches.

use super::*;

fn combat_targeting_clear_stale_task_locks(entity_slot: u32) {
    let pool = combat_targeting_pool();
    let entity_idx = entity_slot as usize;
    if entity_idx >= pool.turret_count_per_entity.len() {
        return;
    }
    let count = (pool.turret_count_per_entity[entity_idx] as usize)
        .min(COMBAT_TARGETING_MAX_TURRETS_PER_ENTITY as usize);
    for turret_idx in 0..count {
        let idx = combat_targeting_turret_global_idx(entity_slot, turret_idx as u32);
        let task_target_id = pool.turret_task_target_id[idx];
        if task_target_id >= 0 && pool.turret_target_id[idx] != task_target_id {
            combat_targeting_set_target_state(pool, idx, -1, CT_TURRET_STATE_IDLE);
        }
    }
}


/// Apply named sibling-target inheritance after ordinary host/auto selection.
/// Each slave re-runs its own observation, lock-on, range, LOS, ballistic, and
/// shield gates against the master's chosen entity; only the target intent is
/// inherited. Repeating up to the mount count resolves valid slave chains
/// deterministically while invalid/cyclic chains settle to idle.
fn combat_targeting_apply_slaved_mount_targets(
    entity_slot: u32,
    source_entity_id: i32,
    turret_shield_panels_enabled: u8,
    turret_shield_spheres_enabled: u8,
    shield_obstruction_active: u8,
    terrain_step_len: f64,
    entity_line_width: f64,
    gravity: f64,
) {
    let count = {
        let pool = combat_targeting_pool();
        let entity_idx = entity_slot as usize;
        if entity_idx >= pool.turret_count_per_entity.len() {
            return;
        }
        (pool.turret_count_per_entity[entity_idx] as usize)
            .min(COMBAT_TARGETING_MAX_TURRETS_PER_ENTITY as usize)
    };

    for _ in 0..count {
        let mut changed = false;
        for slave_idx in 0..count {
            let (master_idx, master_target_id, prior_target_id, prior_state) = {
                let pool = combat_targeting_pool();
                let slave_global_idx =
                    combat_targeting_turret_global_idx(entity_slot, slave_idx as u32);
                let master_idx = pool.turret_slaved_to_mount_index[slave_global_idx];
                if master_idx < 0
                    || master_idx as usize >= count
                    || master_idx as usize == slave_idx
                {
                    continue;
                }
                let master_global_idx =
                    combat_targeting_turret_global_idx(entity_slot, master_idx as u32);
                (
                    master_idx as usize,
                    pool.turret_target_id[master_global_idx],
                    pool.turret_target_id[slave_global_idx],
                    pool.turret_state[slave_global_idx],
                )
            };
            let _ = master_idx;

            if master_target_id < 0 {
                let pool = combat_targeting_pool();
                let slave_global_idx =
                    combat_targeting_turret_global_idx(entity_slot, slave_idx as u32);
                combat_targeting_set_target_state(pool, slave_global_idx, -1, CT_TURRET_STATE_IDLE);
            } else {
                combat_targeting_compute_and_apply_priority_target_fsm_batch_inner(
                    entity_slot,
                    master_target_id,
                    source_entity_id,
                    turret_shield_panels_enabled,
                    turret_shield_spheres_enabled,
                    shield_obstruction_active,
                    terrain_step_len,
                    entity_line_width,
                    gravity,
                    &[],
                    &[],
                    &[],
                    true,
                    Some(slave_idx),
                    false,
                );
            }

            let (next_target_id, next_state) = {
                let pool = combat_targeting_pool();
                let slave_global_idx =
                    combat_targeting_turret_global_idx(entity_slot, slave_idx as u32);
                (
                    pool.turret_target_id[slave_global_idx],
                    pool.turret_state[slave_global_idx],
                )
            };
            changed |= next_target_id != prior_target_id || next_state != prior_state;
        }
        if !changed {
            break;
        }
    }
}

/// AIM-08.5 — combined existing-lock validation + auto-scan tick for
/// one entity. Replaces the JS sequence
/// `computeAndApplyValidateExistingLockFsmBatch` →
/// `prepareAutoScan` with one boundary crossing: the kernel runs the
/// existing-lock FSM first (so the slab reflects post-validation
/// state), then walks the same slab to fill `cached_fire_ranks`,
/// `cached_fire_dist_sqs`, and `out_f64 = [maxAcquireRange,
/// maxWeaponOffset]`. Returns 1 when at least one turret still wants
/// the candidate scan, 0 otherwise.
#[wasm_bindgen]
pub fn combat_targeting_existing_lock_and_auto_scan_tick(
    entity_slot: u32,
    source_entity_id: i32,
    current_tick: i32,
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
    cached_fire_ranks: &mut [u8],
    cached_fire_dist_sqs: &mut [f64],
    out_f64: &mut [f64],
) -> u8 {
    combat_targeting_compute_and_apply_validate_existing_lock_fsm_batch(
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
    );
    combat_targeting_prepare_auto_scan(
        entity_slot,
        current_tick,
        turret_shield_panels_enabled,
        turret_shield_spheres_enabled,
        cached_fire_ranks,
        cached_fire_dist_sqs,
        out_f64,
    )
}

/// AIM-08.5 — batch fire-band candidate switches for one entity.
#[wasm_bindgen]
pub fn combat_targeting_apply_fire_choice_fsm_batch(
    entity_slot: u32,
    apply_mask: &[u8],
    target_ids: &[i32],
) {
    let pool = combat_targeting_pool();
    let entity_idx = entity_slot as usize;
    if entity_idx >= pool.turret_count_per_entity.len() {
        return;
    }
    let count = (pool.turret_count_per_entity[entity_idx] as usize)
        .min(COMBAT_TARGETING_MAX_TURRETS_PER_ENTITY as usize)
        .min(apply_mask.len())
        .min(target_ids.len());
    for turret_idx in 0..count {
        if apply_mask[turret_idx] == 0 {
            continue;
        }
        let target_id = target_ids[turret_idx];
        if target_id < 0 {
            continue;
        }
        let idx = combat_targeting_turret_global_idx(entity_slot, turret_idx as u32);
        combat_targeting_set_target_state(pool, idx, target_id, CT_TURRET_STATE_ENGAGED);
    }
}

/// AIM-08.5 — batch acquisition candidate results for one entity.
#[wasm_bindgen]
pub fn combat_targeting_apply_acquisition_choice_fsm_batch(
    entity_slot: u32,
    apply_mask: &[u8],
    target_ids: &[i32],
    ranks: &[u8],
) {
    let pool = combat_targeting_pool();
    let entity_idx = entity_slot as usize;
    if entity_idx >= pool.turret_count_per_entity.len() {
        return;
    }
    let count = (pool.turret_count_per_entity[entity_idx] as usize)
        .min(COMBAT_TARGETING_MAX_TURRETS_PER_ENTITY as usize)
        .min(apply_mask.len())
        .min(target_ids.len())
        .min(ranks.len());
    for turret_idx in 0..count {
        if apply_mask[turret_idx] == 0 {
            continue;
        }
        let idx = combat_targeting_turret_global_idx(entity_slot, turret_idx as u32);
        let target_id = target_ids[turret_idx];
        if target_id < 0 {
            combat_targeting_set_target_state(pool, idx, -1, CT_TURRET_STATE_IDLE);
            continue;
        }
        let state = if ranks[turret_idx] >= CT_TARGET_RANK_FIRE_FALLBACK {
            CT_TURRET_STATE_ENGAGED
        } else {
            CT_TURRET_STATE_TRACKING
        };
        combat_targeting_set_target_state(pool, idx, target_id, state);
    }
}

/// AIM-08.5 — auto-mode candidate tick. Runs the fire-choice +
/// acquisition pair (prep → choose-best → apply, ×2) for one entity
/// inside a single Rust call. Replaces the 6-kernel JS sequence
/// (`prepareFireChoiceFsmInputs` → `computeAndChooseBestCandidatesBatch`
/// → `applyFireChoiceFsmBatch` → `prepareAcquisitionChoiceFsmInputs`
/// → `computeAndChooseBestCandidatesBatch` → `applyAcquisitionChoiceFsmBatch`)
/// with one boundary crossing.
///
/// The scratch arrays the pair used to share with JS (apply mask,
/// seed ranks/dist/mirror scores, candidate-batch output ids/ranks)
/// live on the stack here — they never escape the kernel, so JS no
/// longer has to size or zero them.
#[wasm_bindgen]
pub fn combat_targeting_auto_mode_candidate_tick(
    entity_slot: u32,
    source_entity_id: i32,
    turret_shield_panels_enabled: u8,
    turret_shield_spheres_enabled: u8,
    shield_obstruction_active: u8,
    terrain_step_len: f64,
    entity_line_width: f64,
    gravity: f64,
    cached_fire_ranks: &[u8],
    cached_fire_dist_sqs: &[f64],
    candidate_count: u32,
    candidate_ids: &[i32],
    candidate_pos_x: &[f64],
    candidate_pos_y: &[f64],
    candidate_pos_z: &[f64],
    candidate_radius: &[f64],
    candidate_shield_panel_score: &mut [f64],
) {
    combat_targeting_auto_mode_candidate_tick_inner(
        entity_slot,
        source_entity_id,
        turret_shield_panels_enabled,
        turret_shield_spheres_enabled,
        shield_obstruction_active,
        terrain_step_len,
        entity_line_width,
        gravity,
        cached_fire_ranks,
        cached_fire_dist_sqs,
        candidate_count,
        candidate_ids,
        None,
        None,
        None,
        candidate_pos_x,
        candidate_pos_y,
        candidate_pos_z,
        candidate_radius,
        candidate_shield_panel_score,
    );
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn combat_targeting_auto_mode_candidate_tick_inner(
    entity_slot: u32,
    source_entity_id: i32,
    turret_shield_panels_enabled: u8,
    turret_shield_spheres_enabled: u8,
    shield_obstruction_active: u8,
    terrain_step_len: f64,
    entity_line_width: f64,
    gravity: f64,
    cached_fire_ranks: &[u8],
    cached_fire_dist_sqs: &[f64],
    candidate_count: u32,
    candidate_ids: &[i32],
    precomputed_candidate_slots: Option<&[u32]>,
    precomputed_candidate_observable: Option<&[u8]>,
    precomputed_candidate_eligible_turret_mask: Option<&[u32]>,
    candidate_pos_x: &[f64],
    candidate_pos_y: &[f64],
    candidate_pos_z: &[f64],
    candidate_radius: &[f64],
    candidate_shield_panel_score: &mut [f64],
) {
    const MAX: usize = COMBAT_TARGETING_MAX_TURRETS_PER_ENTITY as usize;
    let turret_count = {
        let pool = combat_targeting_pool();
        let entity_idx = entity_slot as usize;
        if entity_idx >= pool.turret_count_per_entity.len() {
            return;
        }
        (pool.turret_count_per_entity[entity_idx] as usize)
            .min(MAX)
            .min(cached_fire_ranks.len())
            .min(cached_fire_dist_sqs.len())
    };
    if turret_count == 0 {
        return;
    }

    let mut apply_mask = [0u8; MAX];
    let mut seed_ranks = [CT_TARGET_RANK_NONE; MAX];
    let mut seed_dist_sqs = [f64::INFINITY; MAX];
    let mut seed_shield_panel_scores = [0.0f64; MAX];
    let mut out_target_ids = [-1i32; MAX];
    let mut out_ranks = [CT_TARGET_RANK_NONE; MAX];

    // === Fire-choice pass ===
    let fire_prep = combat_targeting_prepare_fire_choice_fsm_inputs(
        entity_slot,
        source_entity_id,
        turret_shield_panels_enabled,
        turret_shield_spheres_enabled,
        cached_fire_ranks,
        cached_fire_dist_sqs,
        &mut apply_mask[..turret_count],
        &mut seed_ranks[..turret_count],
        &mut seed_dist_sqs[..turret_count],
        &mut seed_shield_panel_scores[..turret_count],
    );

    let fire_has_apply = (fire_prep & CT_TARGETING_PREP_HAS_APPLY) != 0;
    if fire_has_apply {
        if candidate_count != 0 {
            combat_targeting_compute_and_choose_best_candidates_batch_inner(
                entity_slot,
                CT_TARGET_RANK_MODE_FIRE,
                CT_TARGET_RANK_FIRE_FALLBACK,
                &apply_mask[..turret_count],
                &seed_ranks[..turret_count],
                &seed_dist_sqs[..turret_count],
                &seed_shield_panel_scores[..turret_count],
                candidate_count,
                candidate_ids,
                precomputed_candidate_slots,
                precomputed_candidate_observable,
                precomputed_candidate_eligible_turret_mask,
                candidate_pos_x,
                candidate_pos_y,
                candidate_pos_z,
                candidate_radius,
                candidate_shield_panel_score,
                source_entity_id,
                turret_shield_panels_enabled,
                turret_shield_spheres_enabled,
                shield_obstruction_active,
                terrain_step_len,
                entity_line_width,
                gravity,
                &mut out_target_ids[..turret_count],
                &mut out_ranks[..turret_count],
            );
            combat_targeting_apply_fire_choice_fsm_batch(
                entity_slot,
                &apply_mask[..turret_count],
                &out_target_ids[..turret_count],
            );
        }
    }

    if fire_has_apply && candidate_count != 0 {
        // Reset scratch for the acquisition pass. apply_mask + seeds get
        // overwritten by prepare_acquisition; out_target_ids + out_ranks
        // must start as "no choice" so a no-candidate acquisition apply
        // still drops the lock cleanly via the target_id < 0 branch.
        for i in 0..turret_count {
            out_target_ids[i] = -1;
            out_ranks[i] = CT_TARGET_RANK_NONE;
        }
    }

    // === Acquisition pass ===
    let acq_prep = combat_targeting_prepare_acquisition_choice_fsm_inputs(
        entity_slot,
        turret_shield_panels_enabled,
        turret_shield_spheres_enabled,
        &mut apply_mask[..turret_count],
        &mut seed_ranks[..turret_count],
        &mut seed_dist_sqs[..turret_count],
        &mut seed_shield_panel_scores[..turret_count],
    );

    if (acq_prep & CT_TARGETING_PREP_HAS_APPLY) != 0 {
        if candidate_count != 0 {
            combat_targeting_compute_and_choose_best_candidates_batch_inner(
                entity_slot,
                CT_TARGET_RANK_MODE_ACQUISITION,
                CT_TARGET_RANK_TRACKING_ONLY,
                &apply_mask[..turret_count],
                &seed_ranks[..turret_count],
                &seed_dist_sqs[..turret_count],
                &seed_shield_panel_scores[..turret_count],
                candidate_count,
                candidate_ids,
                precomputed_candidate_slots,
                precomputed_candidate_observable,
                precomputed_candidate_eligible_turret_mask,
                candidate_pos_x,
                candidate_pos_y,
                candidate_pos_z,
                candidate_radius,
                candidate_shield_panel_score,
                source_entity_id,
                turret_shield_panels_enabled,
                turret_shield_spheres_enabled,
                shield_obstruction_active,
                terrain_step_len,
                entity_line_width,
                gravity,
                &mut out_target_ids[..turret_count],
                &mut out_ranks[..turret_count],
            );
        }
        combat_targeting_apply_acquisition_choice_fsm_batch(
            entity_slot,
            &apply_mask[..turret_count],
            &out_target_ids[..turret_count],
            &out_ranks[..turret_count],
        );
    }
}

pub(crate) fn combat_targeting_auto_query_masks(
    pool: &CombatTargetingPool,
    entity_slot: u32,
    turret_shield_panels_enabled: u8,
    turret_shield_spheres_enabled: u8,
) -> (u8, u32) {
    let entity_idx = entity_slot as usize;
    if entity_idx >= pool.turret_count_per_entity.len() {
        return (0, 0);
    }
    let count = (pool.turret_count_per_entity[entity_idx] as usize)
        .min(COMBAT_TARGETING_MAX_TURRETS_PER_ENTITY as usize);
    let mut relationship_mask = 0u8;
    let mut enabled_turret_mask = 0u32;
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
        if (pool.turret_config_flags[idx] & CT_TURRET_CFG_IS_MANUAL_FIRE) != 0 {
            continue;
        }
        enabled_turret_mask |= 1u32 << (turret_idx as u32);
        relationship_mask |= combat_targeting_turret_allowed_relationships(pool, idx);
    }
    (relationship_mask, enabled_turret_mask)
}

#[inline]
pub(crate) fn combat_targeting_auto_candidate_eligible_turret_mask(
    pool: &CombatTargetingPool,
    entity_slot: u32,
    source_slot: usize,
    target_slot: usize,
    enabled_turret_mask: u32,
) -> u32 {
    let mut mask = 0u32;
    let mut remaining = enabled_turret_mask;
    while remaining != 0 {
        let turret_idx = remaining.trailing_zeros();
        remaining &= remaining - 1;
        let idx = combat_targeting_turret_global_idx(entity_slot, turret_idx as u32);
        if combat_targeting_turret_may_lock_entity_slot(pool, source_slot, idx, target_slot) {
            mask |= 1u32 << turret_idx;
        }
    }
    mask
}

#[allow(clippy::too_many_arguments)]
#[inline]
pub(crate) fn combat_targeting_collect_spatial_candidate_cell(
    pool: &CombatTargetingPool,
    cell: &CombatTargetingObservationCell,
    entity_slot: u32,
    source_slot: usize,
    source_x: f64,
    source_y: f64,
    _source_z: f64,
    source_team: u8,
    _source_owner_bit: u32,
    source_view_mask: u32,
    relationship_mask: u8,
    enabled_turret_mask: u32,
    _wants_friendly: bool,
    _wants_enemy: bool,
    batch_radius: f64,
    scratch: &mut CombatTargetingSpatialCandidateScratch,
) {
    for &slot_u32 in &cell.slots {
        let slot = slot_u32 as usize;
        if slot == source_slot {
            continue;
        }
        let relationship = if pool.entity_team_id[slot] == source_team {
            CT_TARGETING_CANDIDATE_REL_FRIENDLY
        } else {
            CT_TARGETING_CANDIDATE_REL_ENEMY
        };
        if (relationship_mask & relationship) == 0 {
            continue;
        }
        let dx = pool.entity_pos_x[slot] - source_x;
        let dy = pool.entity_pos_y[slot] - source_y;
        let in_range = match pool.entity_family[slot] {
            CT_ENTITY_FAMILY_UNIT | CT_ENTITY_FAMILY_SHOT => {
                let shot = pool.entity_radius_hitbox[slot];
                shot > 0.0 && {
                    let r = batch_radius + shot;
                    dx * dx + dy * dy <= r * r
                }
            }
            CT_ENTITY_FAMILY_BUILDING | CT_ENTITY_FAMILY_TOWER => {
                spatial_dist_sq_to_aabb2(
                    pool.entity_pos_x[slot],
                    pool.entity_pos_y[slot],
                    pool.entity_aabb_half_x[slot],
                    pool.entity_aabb_half_y[slot],
                    source_x,
                    source_y,
                ) <= batch_radius * batch_radius
            }
            _ => false,
        };
        if !in_range {
            continue;
        }
        if !combat_targeting_view_mask_observes_entity(pool, slot, source_view_mask) {
            continue;
        }
        let eligible_turret_mask = combat_targeting_auto_candidate_eligible_turret_mask(
            pool,
            entity_slot,
            source_slot,
            slot,
            enabled_turret_mask,
        );
        if eligible_turret_mask == 0 {
            continue;
        }
        scratch.ids.push(pool.entity_id[slot]);
        scratch.slots.push(slot_u32);
        scratch.observable.push(1);
        scratch.eligible_turret_mask.push(eligible_turret_mask);
        scratch.pos_x.push(pool.entity_pos_x[slot]);
        scratch.pos_y.push(pool.entity_pos_y[slot]);
        scratch.pos_z.push(pool.entity_pos_z[slot]);
        scratch.radius.push(pool.entity_radius_hitbox[slot]);
        scratch.shield_panel_score.push(0.0);
    }
}

pub(crate) fn combat_targeting_fill_spatial_candidate_scratch(
    entity_slot: u32,
    max_acquire_range: f64,
    max_weapon_offset: f64,
    max_targetable_radius: f64,
    turret_shield_panels_enabled: u8,
    turret_shield_spheres_enabled: u8,
    scratch: &mut CombatTargetingSpatialCandidateScratch,
) -> u32 {
    scratch.clear();
    if !max_acquire_range.is_finite()
        || !max_weapon_offset.is_finite()
        || !max_targetable_radius.is_finite()
    {
        return 0;
    }

    let batch_radius = max_acquire_range + max_weapon_offset + max_targetable_radius;
    if !batch_radius.is_finite() || batch_radius <= 0.0 {
        return 0;
    }

    let pool = combat_targeting_pool();
    let source_slot = entity_slot as usize;
    if source_slot >= pool.entity_id.len()
        || pool.entity_id[source_slot] < 0
        || !combat_targeting_entity_alive(pool, source_slot)
    {
        return 0;
    }
    let source_x = pool.entity_pos_x[source_slot];
    let source_y = pool.entity_pos_y[source_slot];
    let source_z = pool.entity_pos_z[source_slot];
    let source_team = pool.entity_team_id[source_slot];
    let source_owner_bit = pool.entity_owner_bit[source_slot];
    let source_view_mask = pool.entity_view_mask[source_slot];
    let (relationship_mask, enabled_turret_mask) = combat_targeting_auto_query_masks(
        pool,
        entity_slot,
        turret_shield_panels_enabled,
        turret_shield_spheres_enabled,
    );
    if relationship_mask == 0 || enabled_turret_mask == 0 {
        return 0;
    }

    let query_radius = batch_radius + SPATIAL_MAX_UNIT_SHOT_RADIUS;
    let min_cx = combat_targeting_observation_cell_coord(source_x - query_radius);
    let max_cx = combat_targeting_observation_cell_coord(source_x + query_radius);
    let min_cy = combat_targeting_observation_cell_coord(source_y - query_radius);
    let max_cy = combat_targeting_observation_cell_coord(source_y + query_radius);
    let wants_friendly = (relationship_mask & CT_TARGETING_CANDIDATE_REL_FRIENDLY) != 0;
    let wants_enemy = (relationship_mask & CT_TARGETING_CANDIDATE_REL_ENEMY) != 0;
    let cells_x = (max_cx - min_cx + 1) as i64;
    let cells_y = (max_cy - min_cy + 1) as i64;
    if cells_x <= 0 || cells_y <= 0 {
        return 0;
    }
    let cell_count = cells_x.saturating_mul(cells_y);
    if cell_count > pool.observation_cell_keys.len() as i64 {
        for &key in &pool.observation_cell_keys {
            let (cx, cy) = combat_targeting_observation_cell_coords_from_key(key);
            if cx < min_cx || cx > max_cx || cy < min_cy || cy > max_cy {
                continue;
            }
            let Some(cell) = pool.observation_cells.get(&key) else {
                continue;
            };
            combat_targeting_collect_spatial_candidate_cell(
                pool,
                cell,
                entity_slot,
                source_slot,
                source_x,
                source_y,
                source_z,
                source_team,
                source_owner_bit,
                source_view_mask,
                relationship_mask,
                enabled_turret_mask,
                wants_friendly,
                wants_enemy,
                batch_radius,
                scratch,
            );
        }
        return scratch.ids.len() as u32;
    }
    for cx in min_cx..=max_cx {
        for cy in min_cy..=max_cy {
            let key = combat_targeting_observation_cell_key(cx, cy);
            let Some(cell) = pool.observation_cells.get(&key) else {
                continue;
            };
            combat_targeting_collect_spatial_candidate_cell(
                pool,
                cell,
                entity_slot,
                source_slot,
                source_x,
                source_y,
                source_z,
                source_team,
                source_owner_bit,
                source_view_mask,
                relationship_mask,
                enabled_turret_mask,
                wants_friendly,
                wants_enemy,
                batch_radius,
                scratch,
            );
        }
    }

    scratch.ids.len() as u32
}

/// AIM-08.5 — auto-mode candidate tick with Rust-owned broadphase
/// pre-pass. JS still decides whether a spatial query is needed from
/// the merged existing-lock + auto-scan tick, but when candidates are
/// needed the query now stays inside Rust: the spatial grid returns
/// slots, those slots are stamped into SoA candidate arrays from the
/// combat-targeting slab, and the existing candidate FSM kernel runs
/// without TS resolving Entity objects or filling candidate buffers.
#[wasm_bindgen]
pub fn combat_targeting_auto_mode_spatial_candidate_tick(
    entity_slot: u32,
    source_entity_id: i32,
    turret_shield_panels_enabled: u8,
    turret_shield_spheres_enabled: u8,
    shield_obstruction_active: u8,
    terrain_step_len: f64,
    entity_line_width: f64,
    gravity: f64,
    cached_fire_ranks: &[u8],
    cached_fire_dist_sqs: &[f64],
    needs_spatial_query: u8,
    max_acquire_range: f64,
    max_weapon_offset: f64,
    max_targetable_radius: f64,
) {
    let scratch = combat_targeting_spatial_candidate_scratch();
    if needs_spatial_query == 0 {
        scratch.clear();
        return;
    }

    let candidate_count = combat_targeting_fill_spatial_candidate_scratch(
        entity_slot,
        max_acquire_range,
        max_weapon_offset,
        max_targetable_radius,
        turret_shield_panels_enabled,
        turret_shield_spheres_enabled,
        scratch,
    );

    combat_targeting_auto_mode_candidate_tick_inner(
        entity_slot,
        source_entity_id,
        turret_shield_panels_enabled,
        turret_shield_spheres_enabled,
        shield_obstruction_active,
        terrain_step_len,
        entity_line_width,
        gravity,
        cached_fire_ranks,
        cached_fire_dist_sqs,
        candidate_count,
        &scratch.ids,
        Some(&scratch.slots),
        Some(&scratch.observable),
        Some(&scratch.eligible_turret_mask),
        &scratch.pos_x,
        &scratch.pos_y,
        &scratch.pos_z,
        &scratch.radius,
        &mut scratch.shield_panel_score,
    );
}

/// AIM-08.5 — multi-entity auto-mode tick over a contiguous TypeScript
/// world-order run. For each armed entity this performs the merged
/// existing-lock validation + auto-scan, runs the Rust-owned spatial
/// candidate pre-pass, and applies fire/acquisition FSM transitions.
///
/// The flat per-turret arrays are indexed as
/// `entity_index * COMBAT_TARGETING_MAX_TURRETS_PER_ENTITY + turret`.
/// TypeScript still resolves aim points during this migration where
/// compatibility wrappers pass precomputed aim arrays; the scheduled path
/// resolves body/AABB/turret-family aim points directly from the slab.
#[wasm_bindgen]
pub fn combat_targeting_auto_mode_spatial_candidate_tick_batch(
    entity_slots: &[u32],
    source_entity_ids: &[i32],
    current_tick: i32,
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
    cached_fire_ranks: &mut [u8],
    cached_fire_dist_sqs: &mut [f64],
    max_targetable_radius: f64,
) {
    const MAX: usize = COMBAT_TARGETING_MAX_TURRETS_PER_ENTITY as usize;
    let count = entity_slots.len().min(source_entity_ids.len());
    for entity_i in 0..count {
        let start = entity_i * MAX;
        let end = start + MAX;
        if end > aim_x.len()
            || end > aim_y.len()
            || end > aim_z.len()
            || end > cached_fire_ranks.len()
            || end > cached_fire_dist_sqs.len()
        {
            break;
        }

        let mut out_f64 = [0.0f64; 2];
        let needs_spatial_query = combat_targeting_existing_lock_and_auto_scan_tick(
            entity_slots[entity_i],
            source_entity_ids[entity_i],
            current_tick,
            turret_shield_panels_enabled,
            turret_shield_spheres_enabled,
            shield_obstruction_active,
            terrain_step_len,
            entity_line_width,
            gravity,
            los_drop_grace_ticks,
            &aim_x[start..end],
            &aim_y[start..end],
            &aim_z[start..end],
            &mut cached_fire_ranks[start..end],
            &mut cached_fire_dist_sqs[start..end],
            &mut out_f64,
        );

        combat_targeting_auto_mode_spatial_candidate_tick(
            entity_slots[entity_i],
            source_entity_ids[entity_i],
            turret_shield_panels_enabled,
            turret_shield_spheres_enabled,
            shield_obstruction_active,
            terrain_step_len,
            entity_line_width,
            gravity,
            &cached_fire_ranks[start..end],
            &cached_fire_dist_sqs[start..end],
            needs_spatial_query,
            out_f64[0],
            out_f64[1],
            max_targetable_radius,
        );
    }
}

pub(crate) fn combat_targeting_auto_mode_tick_from_slab(
    entity_slot: u32,
    source_entity_id: i32,
    current_tick: i32,
    turret_shield_panels_enabled: u8,
    turret_shield_spheres_enabled: u8,
    shield_obstruction_active: u8,
    terrain_step_len: f64,
    entity_line_width: f64,
    gravity: f64,
    los_drop_grace_ticks: u16,
    cached_fire_ranks: &mut [u8],
    cached_fire_dist_sqs: &mut [f64],
    max_targetable_radius: f64,
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
        &[],
        &[],
        &[],
        true,
    );
    combat_targeting_auto_scan_from_slab(
        entity_slot,
        source_entity_id,
        current_tick,
        turret_shield_panels_enabled,
        turret_shield_spheres_enabled,
        shield_obstruction_active,
        terrain_step_len,
        entity_line_width,
        gravity,
        cached_fire_ranks,
        cached_fire_dist_sqs,
        max_targetable_radius,
    );
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn combat_targeting_auto_scan_from_slab(
    entity_slot: u32,
    source_entity_id: i32,
    current_tick: i32,
    turret_shield_panels_enabled: u8,
    turret_shield_spheres_enabled: u8,
    shield_obstruction_active: u8,
    terrain_step_len: f64,
    entity_line_width: f64,
    gravity: f64,
    cached_fire_ranks: &mut [u8],
    cached_fire_dist_sqs: &mut [f64],
    max_targetable_radius: f64,
) {
    let mut out_f64 = [0.0f64; 2];
    let needs_spatial_query = combat_targeting_prepare_auto_scan(
        entity_slot,
        current_tick,
        turret_shield_panels_enabled,
        turret_shield_spheres_enabled,
        cached_fire_ranks,
        cached_fire_dist_sqs,
        &mut out_f64,
    );

    combat_targeting_auto_mode_spatial_candidate_tick(
        entity_slot,
        source_entity_id,
        turret_shield_panels_enabled,
        turret_shield_spheres_enabled,
        shield_obstruction_active,
        terrain_step_len,
        entity_line_width,
        gravity,
        cached_fire_ranks,
        cached_fire_dist_sqs,
        needs_spatial_query,
        out_f64[0],
        out_f64[1],
        max_targetable_radius,
    );
}

/// AIM-08.5 — mixed-mode per-tick targeting batch. TypeScript still
/// owns object-side command bookkeeping during the migration, but the
/// FSM dispatch and per-turret aim-point resolution for auto-mode,
/// priority-point, and priority-target entities now run in one
/// world-order Rust pass.
///
/// `modes` values:
///   0 = auto mode
///   1 = priority point
///   2 = priority target
///   3 = clear all turret locks
///
/// The flat per-turret arrays are indexed as
/// `entity_index * COMBAT_TARGETING_MAX_TURRETS_PER_ENTITY + turret`.
#[wasm_bindgen]
pub fn combat_targeting_tick_batch(
    entity_slots: &[u32],
    source_entity_ids: &[i32],
    current_tick: i32,
    modes: &[u8],
    priority_target_ids: &[i32],
    priority_point_x: &[f64],
    priority_point_y: &[f64],
    priority_point_z: &[f64],
    turret_shield_panels_enabled: u8,
    turret_shield_spheres_enabled: u8,
    shield_obstruction_active: u8,
    terrain_step_len: f64,
    entity_line_width: f64,
    gravity: f64,
    los_drop_grace_ticks: u16,
    cached_fire_ranks: &mut [u8],
    cached_fire_dist_sqs: &mut [f64],
    max_targetable_radius: f64,
) {
    const MAX: usize = COMBAT_TARGETING_MAX_TURRETS_PER_ENTITY as usize;
    let count = entity_slots
        .len()
        .min(source_entity_ids.len())
        .min(modes.len())
        .min(priority_target_ids.len())
        .min(priority_point_x.len())
        .min(priority_point_y.len())
        .min(priority_point_z.len());

    for entity_i in 0..count {
        let start = entity_i * MAX;
        let end = start + MAX;
        if end > cached_fire_ranks.len() || end > cached_fire_dist_sqs.len() {
            break;
        }

        let entity_slot = entity_slots[entity_i];
        let source_entity_id = source_entity_ids[entity_i];
        match modes[entity_i] {
            CT_TARGETING_TICK_MODE_PRIORITY_POINT => {
                combat_targeting_compute_and_apply_priority_point_fsm_batch(
                    entity_slot,
                    priority_point_x[entity_i],
                    priority_point_y[entity_i],
                    priority_point_z[entity_i],
                    source_entity_id,
                    turret_shield_panels_enabled,
                    turret_shield_spheres_enabled,
                    shield_obstruction_active,
                    terrain_step_len,
                    entity_line_width,
                    gravity,
                );
            }
            CT_TARGETING_TICK_MODE_PRIORITY_TARGET => {
                let target_id = priority_target_ids[entity_i];
                if target_id >= 0 {
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
                        &[],
                        &[],
                        &[],
                        true,
                        None,
                        true,
                    );
                }
            }
            CT_TARGETING_TICK_MODE_CLEAR_LOCKS => {
                combat_targeting_clear_entity_locks(entity_slot);
            }
            CT_TARGETING_TICK_MODE_AUTO | _ => {
                combat_targeting_auto_mode_tick_from_slab(
                    entity_slot,
                    source_entity_id,
                    current_tick,
                    turret_shield_panels_enabled,
                    turret_shield_spheres_enabled,
                    shield_obstruction_active,
                    terrain_step_len,
                    entity_line_width,
                    gravity,
                    los_drop_grace_ticks,
                    &mut cached_fire_ranks[start..end],
                    &mut cached_fire_dist_sqs[start..end],
                    max_targetable_radius,
                );
            }
        }
        if matches!(
            modes[entity_i],
            CT_TARGETING_TICK_MODE_AUTO | CT_TARGETING_TICK_MODE_PRIORITY_TARGET
        ) {
            combat_targeting_apply_slaved_mount_targets(
                entity_slot,
                source_entity_id,
                turret_shield_panels_enabled,
                turret_shield_spheres_enabled,
                shield_obstruction_active,
                terrain_step_len,
                entity_line_width,
                gravity,
            );
        }
    }
}

/// AIM-08.5 — scheduled mixed-mode targeting tick. This moves the
/// remaining TypeScript mode scheduler into Rust: the kernel reads the
/// stamped entity flags, priority commands, visibility, hold-fire flag,
/// and probe gate, resolves source IDs to slab slots, then dispatches
/// the existing mixed-mode FSM work.
///
/// AIM-08.10 — every entity that gets a non-SKIP mode also has its
/// activity-mask refreshed inline before the loop iteration ends, and
/// the active-work decision is returned through `out_has_active_work`.
/// SKIP-mode entities are intentionally not refreshed because nothing
/// they could have changed (FSM, rotation, config) was touched this
/// tick; the previous tick's masks remain authoritative.
///
/// `shield_obstruction_player_mask` carries the per-player shield-aware
/// targeting upgrade (`combat_targeting_player_bit` convention: bit
/// `player_id - 1`). An entity's turrets reject shield-blocked locks only
/// while its owner's bit is set; every downstream helper still receives
/// the resolved per-entity `shield_obstruction_active` scalar.
#[wasm_bindgen]
pub fn combat_targeting_schedule_and_tick_batch(
    source_slots: &[u32],
    current_tick: i32,
    dt_ms: f64,
    turret_shield_panels_enabled: u8,
    turret_shield_spheres_enabled: u8,
    shield_obstruction_player_mask: u32,
    terrain_step_len: f64,
    entity_line_width: f64,
    gravity: f64,
    los_drop_grace_ticks: u16,
    reacquire_period_ticks: u32,
    cached_fire_ranks: &mut [u8],
    cached_fire_dist_sqs: &mut [f64],
    max_targetable_radius: f64,
    out_had_cooldown: &mut [u8],
    out_modes: &mut [u8],
    out_has_active_work: &mut [u8],
) {
    const MAX: usize = COMBAT_TARGETING_MAX_TURRETS_PER_ENTITY as usize;
    let count = source_slots
        .len()
        .min(out_had_cooldown.len())
        .min(out_modes.len())
        .min(out_has_active_work.len());

    // Priority hosts bypass the probe-tick gate (their FSM owns the aim
    // every tick), but the TRAILING fallback scan — which only serves
    // sibling mounts that rejected the ordered target — takes the same
    // phased cadence idle hosts use, sharded by entity id.
    let reacq = reacquire_period_ticks.max(1);
    for entity_i in 0..count {
        out_modes[entity_i] = CT_TARGETING_TICK_MODE_SKIP;
        out_had_cooldown[entity_i] = 0;
        out_has_active_work[entity_i] = 0;

        let start = entity_i * MAX;
        let end = start + MAX;
        if end > cached_fire_ranks.len() || end > cached_fire_dist_sqs.len() {
            break;
        }

        let (
            source_entity_id,
            entity_slot,
            entity_ready,
            fire_enabled,
            source_view_mask,
            priority_target_id,
            priority_point_present_val,
            priority_point_x,
            priority_point_y,
            priority_point_z,
            scheduled_probe_tick,
            entity_owner_bit,
        ) = {
            let pool = combat_targeting_pool();
            let entity_slot = source_slots[entity_i];
            let entity_idx = entity_slot as usize;
            if entity_idx >= pool.entity_flags.len() {
                (
                    -1i32,
                    entity_slot,
                    false,
                    false,
                    0u32,
                    -1i32,
                    0u8,
                    0.0,
                    0.0,
                    0.0,
                    -1i32,
                    0u32,
                )
            } else {
                let source_entity_id = pool.entity_id[entity_idx];
                if source_entity_id < 0 {
                    (
                        source_entity_id,
                        entity_slot,
                        false,
                        false,
                        0u32,
                        -1i32,
                        0u8,
                        0.0,
                        0.0,
                        0.0,
                        -1i32,
                        0u32,
                    )
                } else {
                    let flags = pool.entity_flags[entity_idx];
                    let ready = (flags & CT_ENTITY_FLAG_HAS_COMBAT) != 0
                        && (flags & CT_ENTITY_FLAG_ALIVE) != 0
                        && (flags & CT_ENTITY_FLAG_BUILDABLE_COMPLETE) != 0;
                    let enabled = (flags & CT_ENTITY_FLAG_FIRE_ENABLED) != 0;
                    (
                        source_entity_id,
                        entity_slot,
                        ready,
                        enabled,
                        pool.entity_view_mask[entity_idx],
                        pool.entity_priority_target_id[entity_idx],
                        pool.entity_priority_point_present[entity_idx],
                        pool.entity_priority_point_x[entity_idx],
                        pool.entity_priority_point_y[entity_idx],
                        pool.entity_priority_point_z[entity_idx],
                        pool.entity_scheduled_probe_tick[entity_idx],
                        pool.entity_owner_bit[entity_idx],
                    )
                }
            }
        };

        if !entity_ready {
            continue;
        }

        // Per-player shield-aware targeting: this entity's turrets treat
        // force material as sight-obstructing only while its owner holds
        // the upgrade bit. The rest of the tick consumes the resolved
        // scalar exactly as the old global flag did.
        let shield_obstruction_active: u8 =
            if (shield_obstruction_player_mask & entity_owner_bit) != 0 {
                1
            } else {
                0
            };

        if !fire_enabled {
            {
                let pool = combat_targeting_pool();
                combat_targeting_reset_disabled_weapons_for_entity(
                    pool,
                    entity_slot,
                    turret_shield_panels_enabled,
                    turret_shield_spheres_enabled,
                );
            }
            combat_targeting_update_mount_kinematics(
                entity_slot,
                current_tick,
                dt_ms,
                turret_shield_panels_enabled,
                turret_shield_spheres_enabled,
            );
            combat_targeting_clear_entity_locks(entity_slot);
            out_modes[entity_i] = CT_TARGETING_TICK_MODE_CLEAR_LOCKS;
            out_has_active_work[entity_i] =
                combat_targeting_refresh_activity_masks_for_entity_and_read_active(entity_slot);
            continue;
        }

        out_had_cooldown[entity_i] = {
            let pool = combat_targeting_pool();
            combat_targeting_decrement_entity_cooldowns(pool, entity_slot, dt_ms)
        };

        let has_priority_point = priority_point_present_val != 0;
        if priority_target_id < 0 && !has_priority_point && scheduled_probe_tick > current_tick {
            // A skipped entity carries no cooldown (a ticked cooldown forces
            // probe_tick = tick + 1) and its disabled weapons are already
            // idle, so the hoisted reset below is a provable no-op here.
            continue;
        }

        let has_enabled_weapon = {
            let pool = combat_targeting_pool();
            combat_targeting_reset_disabled_weapons_for_entity(
                pool,
                entity_slot,
                turret_shield_panels_enabled,
                turret_shield_spheres_enabled,
            );
            combat_targeting_entity_has_enabled_weapon(
                pool,
                entity_slot,
                turret_shield_panels_enabled,
                turret_shield_spheres_enabled,
            )
        };

        combat_targeting_update_mount_kinematics(
            entity_slot,
            current_tick,
            dt_ms,
            turret_shield_panels_enabled,
            turret_shield_spheres_enabled,
        );

        if !has_enabled_weapon {
            combat_targeting_auto_mode_tick_from_slab(
                entity_slot,
                source_entity_id,
                current_tick,
                turret_shield_panels_enabled,
                turret_shield_spheres_enabled,
                shield_obstruction_active,
                terrain_step_len,
                entity_line_width,
                gravity,
                los_drop_grace_ticks,
                &mut cached_fire_ranks[start..end],
                &mut cached_fire_dist_sqs[start..end],
                max_targetable_radius,
            );
            combat_targeting_apply_slaved_mount_targets(
                entity_slot,
                source_entity_id,
                turret_shield_panels_enabled,
                turret_shield_spheres_enabled,
                shield_obstruction_active,
                terrain_step_len,
                entity_line_width,
                gravity,
            );
            out_modes[entity_i] = CT_TARGETING_TICK_MODE_AUTO;
            out_has_active_work[entity_i] =
                combat_targeting_refresh_activity_masks_for_entity_and_read_active(entity_slot);
            continue;
        }

        if has_priority_point {
            combat_targeting_compute_and_apply_priority_point_fsm_batch(
                entity_slot,
                priority_point_x,
                priority_point_y,
                priority_point_z,
                source_entity_id,
                turret_shield_panels_enabled,
                turret_shield_spheres_enabled,
                shield_obstruction_active,
                terrain_step_len,
                entity_line_width,
                gravity,
            );
            if (source_entity_id as u32) % reacq == (current_tick as u32) % reacq {
                combat_targeting_auto_scan_from_slab(
                    entity_slot,
                    source_entity_id,
                    current_tick,
                    turret_shield_panels_enabled,
                    turret_shield_spheres_enabled,
                    shield_obstruction_active,
                    terrain_step_len,
                    entity_line_width,
                    gravity,
                    &mut cached_fire_ranks[start..end],
                    &mut cached_fire_dist_sqs[start..end],
                    max_targetable_radius,
                );
            }
            out_modes[entity_i] = CT_TARGETING_TICK_MODE_PRIORITY_POINT;
            out_has_active_work[entity_i] =
                combat_targeting_refresh_activity_masks_for_entity_and_read_active(entity_slot);
            continue;
        }

        let priority_observable = priority_target_id >= 0 && {
            let pool = combat_targeting_pool();
            match combat_targeting_entity_slot_for_id(pool, priority_target_id) {
                Some(target_slot) => {
                    combat_targeting_view_mask_observes_entity(pool, target_slot, source_view_mask)
                        && combat_targeting_entity_may_lock_entity_slot(
                            pool,
                            entity_slot as usize,
                            target_slot,
                        )
                        && combat_targeting_entity_has_turret_that_may_lock_entity_slot(
                            pool,
                            entity_slot,
                            target_slot,
                            turret_shield_panels_enabled,
                            turret_shield_spheres_enabled,
                        )
                }
                None => false,
            }
        };

        if priority_observable {
            combat_targeting_compute_and_apply_priority_target_fsm_batch_inner(
                entity_slot,
                priority_target_id,
                source_entity_id,
                turret_shield_panels_enabled,
                turret_shield_spheres_enabled,
                shield_obstruction_active,
                terrain_step_len,
                entity_line_width,
                gravity,
                &[],
                &[],
                &[],
                true,
                None,
                true,
            );
            // Priority is per mount. Accepted task locks are protected by the
            // auto-choice prep; mounts that rejected this target independently
            // acquire a compatible fallback in the same tick.
            combat_targeting_auto_mode_tick_from_slab(
                entity_slot,
                source_entity_id,
                current_tick,
                turret_shield_panels_enabled,
                turret_shield_spheres_enabled,
                shield_obstruction_active,
                terrain_step_len,
                entity_line_width,
                gravity,
                los_drop_grace_ticks,
                &mut cached_fire_ranks[start..end],
                &mut cached_fire_dist_sqs[start..end],
                max_targetable_radius,
            );
            combat_targeting_apply_slaved_mount_targets(
                entity_slot,
                source_entity_id,
                turret_shield_panels_enabled,
                turret_shield_spheres_enabled,
                shield_obstruction_active,
                terrain_step_len,
                entity_line_width,
                gravity,
            );
            out_modes[entity_i] = CT_TARGETING_TICK_MODE_PRIORITY_TARGET;
            out_has_active_work[entity_i] =
                combat_targeting_refresh_activity_masks_for_entity_and_read_active(entity_slot);
            continue;
        }

        if priority_target_id >= 0 {
            combat_targeting_clear_stale_task_locks(entity_slot);
        }
        combat_targeting_auto_mode_tick_from_slab(
            entity_slot,
            source_entity_id,
            current_tick,
            turret_shield_panels_enabled,
            turret_shield_spheres_enabled,
            shield_obstruction_active,
            terrain_step_len,
            entity_line_width,
            gravity,
            los_drop_grace_ticks,
            &mut cached_fire_ranks[start..end],
            &mut cached_fire_dist_sqs[start..end],
            max_targetable_radius,
        );
        combat_targeting_apply_slaved_mount_targets(
            entity_slot,
            source_entity_id,
            turret_shield_panels_enabled,
            turret_shield_spheres_enabled,
            shield_obstruction_active,
            terrain_step_len,
            entity_line_width,
            gravity,
        );
        out_modes[entity_i] = CT_TARGETING_TICK_MODE_AUTO;
        out_has_active_work[entity_i] =
            combat_targeting_refresh_activity_masks_for_entity_and_read_active(entity_slot);
    }
}

#[inline]
pub(crate) fn targeting_edge_value(acquire: f64, release: f64, edge: u8) -> f64 {
    if edge == CT_TARGET_EDGE_RELEASE {
        release
    } else {
        acquire
    }
}

#[inline]
pub(crate) fn targeting_range_cylinder_contains(
    acquire: f64,
    release: f64,
    edge: u8,
    weapon_z: f64,
    range_volume: CombatTargetingRangeVolume,
    target: CombatTargetingCylinderTarget,
) -> bool {
    combat_targeting_range_volume_contains(
        targeting_edge_value(acquire, release, edge),
        weapon_z,
        range_volume,
        target,
    )
}

#[inline]
pub(crate) fn targeting_min_range_prefers_target(
    has_min: u8,
    min_acquire: f64,
    min_release: f64,
    edge: u8,
    weapon_z: f64,
    range_volume: CombatTargetingRangeVolume,
    target: CombatTargetingCylinderTarget,
) -> bool {
    if has_min == 0 {
        return true;
    }
    combat_targeting_min_range_prefers_target(
        targeting_edge_value(min_acquire, min_release, edge),
        weapon_z,
        range_volume,
        target,
    )
}

#[inline]
pub(crate) fn targeting_fire_rank_cylinder(
    fire_max_acquire: f64,
    fire_max_release: f64,
    has_fire_min: u8,
    fire_min_acquire: f64,
    fire_min_release: f64,
    edge: u8,
    weapon_z: f64,
    range_volume: CombatTargetingRangeVolume,
    target: CombatTargetingCylinderTarget,
) -> u8 {
    if !targeting_range_cylinder_contains(
        fire_max_acquire,
        fire_max_release,
        edge,
        weapon_z,
        range_volume,
        target,
    ) {
        return CT_TARGET_RANK_NONE;
    }
    if targeting_min_range_prefers_target(
        has_fire_min,
        fire_min_acquire,
        fire_min_release,
        edge,
        weapon_z,
        range_volume,
        target,
    ) {
        CT_TARGET_RANK_FIRE_PREFERRED
    } else {
        CT_TARGET_RANK_FIRE_FALLBACK
    }
}

#[inline]
pub(crate) fn targeting_acquisition_rank_cylinder(
    fire_max_acquire: f64,
    fire_max_release: f64,
    has_fire_min: u8,
    fire_min_acquire: f64,
    fire_min_release: f64,
    has_tracking: u8,
    tracking_acquire: f64,
    tracking_release: f64,
    edge: u8,
    weapon_z: f64,
    range_volume: CombatTargetingRangeVolume,
    target: CombatTargetingCylinderTarget,
) -> u8 {
    let fire_rank = targeting_fire_rank_cylinder(
        fire_max_acquire,
        fire_max_release,
        has_fire_min,
        fire_min_acquire,
        fire_min_release,
        edge,
        weapon_z,
        range_volume,
        target,
    );
    if fire_rank != CT_TARGET_RANK_NONE {
        return fire_rank;
    }
    if has_tracking != 0 {
        if targeting_range_cylinder_contains(
            tracking_acquire,
            tracking_release,
            edge,
            weapon_z,
            range_volume,
            target,
        ) {
            return CT_TARGET_RANK_TRACKING_ONLY;
        }
    }
    CT_TARGET_RANK_NONE
}

#[inline]
pub(crate) fn targeting_rank_cylinder(
    rank_mode: u8,
    fire_max_acquire: f64,
    fire_max_release: f64,
    has_fire_min: u8,
    fire_min_acquire: f64,
    fire_min_release: f64,
    has_tracking: u8,
    tracking_acquire: f64,
    tracking_release: f64,
    edge: u8,
    weapon_z: f64,
    range_volume: CombatTargetingRangeVolume,
    target: CombatTargetingCylinderTarget,
) -> u8 {
    if rank_mode == CT_TARGET_RANK_MODE_ACQUISITION {
        targeting_acquisition_rank_cylinder(
            fire_max_acquire,
            fire_max_release,
            has_fire_min,
            fire_min_acquire,
            fire_min_release,
            has_tracking,
            tracking_acquire,
            tracking_release,
            edge,
            weapon_z,
            range_volume,
            target,
        )
    } else {
        targeting_fire_rank_cylinder(
            fire_max_acquire,
            fire_max_release,
            has_fire_min,
            fire_min_acquire,
            fire_min_release,
            edge,
            weapon_z,
            range_volume,
            target,
        )
    }
}

#[inline]
pub(crate) fn targeting_is_better_candidate(
    reciprocal_tier: u8,
    rank: u8,
    dist_sq: f64,
    best_reciprocal_tier: u8,
    best_rank: u8,
    best_dist_sq: f64,
) -> bool {
    if reciprocal_tier != best_reciprocal_tier {
        return reciprocal_tier > best_reciprocal_tier;
    }
    rank > best_rank || (rank == best_rank && dist_sq < best_dist_sq)
}

#[inline]
pub(crate) fn targeting_is_better_mirror_candidate(
    reciprocal_tier: u8,
    shield_panel_score: f64,
    rank: u8,
    dist_sq: f64,
    best_reciprocal_tier: u8,
    best_shield_panel_score: f64,
    best_rank: u8,
    best_dist_sq: f64,
) -> bool {
    if reciprocal_tier != best_reciprocal_tier {
        return reciprocal_tier > best_reciprocal_tier;
    }
    if shield_panel_score != best_shield_panel_score {
        return shield_panel_score > best_shield_panel_score;
    }
    targeting_is_better_candidate(0, rank, dist_sq, 0, best_rank, best_dist_sq)
}

#[inline]
pub(crate) fn targeting_candidate_beats_seed(
    is_passive: u8,
    reciprocal_tier: u8,
    rank: u8,
    dist_sq: f64,
    shield_panel_score: f64,
    seed_reciprocal_tier: u8,
    seed_rank: u8,
    seed_dist_sq: f64,
    seed_shield_panel_score: f64,
) -> bool {
    if is_passive != 0 {
        // A live reflector lock is deliberately sticky across equal-power
        // threats. Initial acquisition still uses range/distance to break
        // ties (seed score is zero), but a periodic refresh may replace its
        // seed only with a strictly higher sustained-DPS score. Reciprocal
        // tier remains the primary ordering for any future preference-style
        // passive profile.
        if seed_shield_panel_score > 0.0 {
            if reciprocal_tier != seed_reciprocal_tier {
                return reciprocal_tier > seed_reciprocal_tier;
            }
            return shield_panel_score > seed_shield_panel_score;
        }
        targeting_is_better_mirror_candidate(
            reciprocal_tier,
            shield_panel_score,
            rank,
            dist_sq,
            seed_reciprocal_tier,
            seed_shield_panel_score,
            seed_rank,
            seed_dist_sq,
        )
    } else {
        targeting_is_better_candidate(
            reciprocal_tier,
            rank,
            dist_sq,
            seed_reciprocal_tier,
            seed_rank,
            seed_dist_sq,
        )
    }
}

#[inline]
pub(crate) fn targeting_score_candidate(
    candidate_idx: usize,
    weapon_x: f64,
    weapon_y: f64,
    weapon_z: f64,
    fire_max_acquire: f64,
    fire_max_release: f64,
    has_fire_min: u8,
    fire_min_acquire: f64,
    fire_min_release: f64,
    has_tracking: u8,
    tracking_acquire: f64,
    tracking_release: f64,
    rank_mode: u8,
    minimum_rank: u8,
    reciprocal_tier: u8,
    seed_rank: u8,
    seed_dist_sq: f64,
    seed_reciprocal_tier: u8,
    seed_shield_panel_score: f64,
    is_passive: u8,
    range_volume: CombatTargetingRangeVolume,
    candidate_observable: &[u8],
    candidate_pos_x: &[f64],
    candidate_pos_y: &[f64],
    candidate_pos_z: &[f64],
    candidate_radius: &[f64],
    candidate_vertical_extent: f64,
    candidate_shield_panel_score: &[f64],
) -> Option<(u8, f64, f64, u8)> {
    if candidate_observable[candidate_idx] == 0 {
        return None;
    }
    let mut shield_panel_score = 0.0;
    if is_passive != 0 {
        shield_panel_score = candidate_shield_panel_score[candidate_idx];
        if shield_panel_score <= 0.0 {
            return None;
        }
    }
    let dx = weapon_x - candidate_pos_x[candidate_idx];
    let dy = weapon_y - candidate_pos_y[candidate_idx];
    let horizontal_dist_sq = dx * dx + dy * dy;
    let target = CombatTargetingCylinderTarget {
        horizontal_dist_sq,
        horizontal_radius: combat_targeting_nonnegative_finite(candidate_radius[candidate_idx]),
        bottom_z: candidate_pos_z[candidate_idx]
            - combat_targeting_nonnegative_finite(candidate_vertical_extent),
        top_z: candidate_pos_z[candidate_idx]
            + combat_targeting_nonnegative_finite(candidate_vertical_extent),
        is_point: false,
    };
    let rank = targeting_rank_cylinder(
        rank_mode,
        fire_max_acquire,
        fire_max_release,
        has_fire_min,
        fire_min_acquire,
        fire_min_release,
        has_tracking,
        tracking_acquire,
        tracking_release,
        0,
        weapon_z,
        range_volume,
        target,
    );
    if rank < minimum_rank {
        return None;
    }
    if !targeting_candidate_beats_seed(
        is_passive,
        reciprocal_tier,
        rank,
        horizontal_dist_sq,
        shield_panel_score,
        seed_reciprocal_tier,
        seed_rank,
        seed_dist_sq,
        seed_shield_panel_score,
    ) {
        return None;
    }
    Some((
        rank,
        horizontal_dist_sq,
        shield_panel_score,
        reciprocal_tier,
    ))
}

#[inline]
pub(crate) fn targeting_pool_entry_is_better(
    is_passive: u8,
    reciprocal_tier: u8,
    rank: u8,
    dist_sq: f64,
    shield_panel_score: f64,
    best_reciprocal_tier: u8,
    best_rank: u8,
    best_dist_sq: f64,
    best_shield_panel_score: f64,
) -> bool {
    if is_passive != 0 {
        targeting_is_better_mirror_candidate(
            reciprocal_tier,
            shield_panel_score,
            rank,
            dist_sq,
            best_reciprocal_tier,
            best_shield_panel_score,
            best_rank,
            best_dist_sq,
        )
    } else {
        targeting_is_better_candidate(
            reciprocal_tier,
            rank,
            dist_sq,
            best_reciprocal_tier,
            best_rank,
            best_dist_sq,
        )
    }
}

pub(crate) struct TargetingCandidateChoice {
    pub(crate) candidate_idx: i32,
    pub(crate) rank: u8,
}

#[inline]
pub(crate) fn targeting_seed_choice(seed_rank: u8) -> TargetingCandidateChoice {
    TargetingCandidateChoice {
        candidate_idx: -1,
        rank: seed_rank,
    }
}

#[wasm_bindgen]
pub fn combat_targeting_rank_target(
    rank_mode: u8,
    edge: u8,
    fire_max_acquire: f64,
    fire_max_release: f64,
    has_fire_min: u8,
    fire_min_acquire: f64,
    fire_min_release: f64,
    has_tracking: u8,
    tracking_acquire: f64,
    tracking_release: f64,
    dist_sq: f64,
    target_radius: f64,
) -> u8 {
    let target = CombatTargetingCylinderTarget {
        horizontal_dist_sq: dist_sq,
        horizontal_radius: combat_targeting_nonnegative_finite(target_radius),
        bottom_z: 0.0,
        top_z: 0.0,
        is_point: true,
    };
    targeting_rank_cylinder(
        rank_mode,
        fire_max_acquire,
        fire_max_release,
        has_fire_min,
        fire_min_acquire,
        fire_min_release,
        has_tracking,
        tracking_acquire,
        tracking_release,
        edge,
        0.0,
        CombatTargetingRangeVolume::cylinder_normal(),
        target,
    )
}

/// AIM-08.5 — Rust-internal candidate fire-gate. Replaces the
/// JS `passesWeaponFireGates` callback. Resolves the candidate aim
/// point from the slab (body/AABB or turret-family mount), then dispatches
/// to the shared `compute_turret_gates_for_aim_point` helper. Returns
/// 1 if all three gates (LOS, ballistic, FF) pass.
#[inline]
pub(crate) fn combat_targeting_candidate_slot_gate_passes(
    pool: &mut CombatTargetingPool,
    entity_slot: u32,
    turret_idx: u32,
    candidate_slot: usize,
    candidate_id: i32,
    source_entity_id: i32,
    terrain_step_len: f64,
    entity_line_width: f64,
    turret_shield_panels_enabled: u8,
    turret_shield_spheres_enabled: u8,
    shield_obstruction_active: u8,
    gravity: f64,
    projectile_speed: f64,
    projectile_mass: f64,
    projectile_air_friction_per_60hz_frame: f64,
    arc_preference: u8,
    max_time_sec: f64,
    ground_aim_fraction: f64,
    under_only: bool,
) -> bool {
    let idx = combat_targeting_turret_global_idx(entity_slot, turret_idx);
    let flags = pool.turret_config_flags[idx];
    let mount_x = pool.turret_mount_x[idx];
    let mount_y = pool.turret_mount_y[idx];
    let mount_z = pool.turret_mount_z[idx];

    let (aim_x, aim_y, aim_z) = combat_targeting_resolve_aim_point_from_slab(
        pool,
        entity_slot,
        turret_idx,
        source_entity_id,
        candidate_slot,
        mount_x,
        mount_y,
        mount_z,
        gravity,
    );

    let target_vx = pool
        .entity_vel_x
        .get(candidate_slot)
        .copied()
        .unwrap_or(0.0);
    let target_vy = pool
        .entity_vel_y
        .get(candidate_slot)
        .copied()
        .unwrap_or(0.0);
    let target_vz = pool
        .entity_vel_z
        .get(candidate_slot)
        .copied()
        .unwrap_or(0.0);

    let (los_clear, ballistic_clear, shield_clear) = compute_turret_gates_for_aim_point(
        pool,
        entity_slot,
        turret_idx,
        idx,
        flags,
        mount_x,
        mount_y,
        mount_z,
        aim_x,
        aim_y,
        aim_z,
        target_vx,
        target_vy,
        target_vz,
        candidate_id,
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

    los_clear != 0 && ballistic_clear != 0 && shield_clear != 0
}

/// AIM-08.5 — batch target candidate scoring/selection + internal
/// fire-gate evaluation for one entity's turrets. Replaces the
/// legacy `combat_targeting_choose_best_candidates_batch` which
/// relied on a JS `gate_fn` callback for the per-(turret, candidate)
/// LOS / ballistic / shield check. The kernel now resolves
/// candidate aim points from the slab AABB and dispatches to
/// `compute_turret_gates_for_aim_point` inline — same physics as the
/// priority kernels, no per-pair boundary crossing.
///
/// Mirror-panel clearance is consulted via the slab inside
/// `compute_turret_gates_for_aim_point`; JS no longer needs to fill
/// a per-(turret, candidate) clearance mask.
///
/// Per-candidate observability (sight/radar) is computed
/// internally from slab data — the dedicated scratch global is
/// filled before the per-turret loop and reused across turrets,
/// since the observer player is the same for every turret on this
/// entity.
#[wasm_bindgen]
pub fn combat_targeting_compute_and_choose_best_candidates_batch(
    entity_slot: u32,
    rank_mode: u8,
    minimum_rank: u8,
    apply_mask: &[u8],
    seed_ranks: &[u8],
    seed_dist_sqs: &[f64],
    seed_shield_panel_scores: &[f64],
    candidate_count: u32,
    candidate_ids: &[i32],
    candidate_pos_x: &[f64],
    candidate_pos_y: &[f64],
    candidate_pos_z: &[f64],
    candidate_radius: &[f64],
    // Output: per-candidate mirror-target DPS, filled by the kernel
    // from the slab using candidate_ids + source_entity_id. JS no
    // longer needs to populate this — it passes the scratch buffer
    // and reads nothing back. Tuned per-source not per-turret, so
    // one walk per candidate covers every turret on this entity.
    candidate_shield_panel_score: &mut [f64],
    source_entity_id: i32,
    turret_shield_panels_enabled: u8,
    turret_shield_spheres_enabled: u8,
    shield_obstruction_active: u8,
    terrain_step_len: f64,
    entity_line_width: f64,
    gravity: f64,
    out_target_ids: &mut [i32],
    out_ranks: &mut [u8],
) {
    combat_targeting_compute_and_choose_best_candidates_batch_inner(
        entity_slot,
        rank_mode,
        minimum_rank,
        apply_mask,
        seed_ranks,
        seed_dist_sqs,
        seed_shield_panel_scores,
        candidate_count,
        candidate_ids,
        None,
        None,
        None,
        candidate_pos_x,
        candidate_pos_y,
        candidate_pos_z,
        candidate_radius,
        candidate_shield_panel_score,
        source_entity_id,
        turret_shield_panels_enabled,
        turret_shield_spheres_enabled,
        shield_obstruction_active,
        terrain_step_len,
        entity_line_width,
        gravity,
        out_target_ids,
        out_ranks,
    );
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn combat_targeting_compute_and_choose_best_candidates_batch_inner(
    entity_slot: u32,
    rank_mode: u8,
    minimum_rank: u8,
    apply_mask: &[u8],
    seed_ranks: &[u8],
    seed_dist_sqs: &[f64],
    seed_shield_panel_scores: &[f64],
    candidate_count: u32,
    candidate_ids: &[i32],
    precomputed_candidate_slots: Option<&[u32]>,
    precomputed_candidate_observable: Option<&[u8]>,
    precomputed_candidate_eligible_turret_mask: Option<&[u32]>,
    candidate_pos_x: &[f64],
    candidate_pos_y: &[f64],
    candidate_pos_z: &[f64],
    candidate_radius: &[f64],
    candidate_shield_panel_score: &mut [f64],
    source_entity_id: i32,
    turret_shield_panels_enabled: u8,
    turret_shield_spheres_enabled: u8,
    shield_obstruction_active: u8,
    terrain_step_len: f64,
    entity_line_width: f64,
    gravity: f64,
    out_target_ids: &mut [i32],
    out_ranks: &mut [u8],
) {
    let pool = combat_targeting_pool();
    let entity_idx = entity_slot as usize;
    if entity_idx >= pool.turret_count_per_entity.len() {
        return;
    }
    let source_view_mask = pool.entity_view_mask[entity_idx];
    let turret_count = (pool.turret_count_per_entity[entity_idx] as usize)
        .min(COMBAT_TARGETING_MAX_TURRETS_PER_ENTITY as usize)
        .min(apply_mask.len())
        .min(seed_ranks.len())
        .min(seed_dist_sqs.len())
        .min(seed_shield_panel_scores.len())
        .min(out_target_ids.len())
        .min(out_ranks.len());
    let clamped_candidate_count = (candidate_count as usize)
        .min(candidate_ids.len())
        .min(candidate_pos_x.len())
        .min(candidate_pos_y.len())
        .min(candidate_pos_z.len())
        .min(candidate_radius.len())
        .min(candidate_shield_panel_score.len());
    if turret_count == 0 || clamped_candidate_count == 0 {
        return;
    }
    // We use the existing apply_mask=0 turrets are NOT system-disabled
    // checks in the choose-best path; mirror that here. The JS side
    // already gates apply_mask via `prepareFireChoiceFsmInputs` /
    // `prepareAcquisitionChoiceFsmInputs`, but a belt-and-braces
    // check inside the gate helper keeps disabled/manual-fire
    // turrets from running the LOS+ballistic+FF kernels for free.
    let _ = (turret_shield_panels_enabled, turret_shield_spheres_enabled);

    let candidate_slots: &[u32] = if let Some(slots) = precomputed_candidate_slots {
        if slots.len() >= clamped_candidate_count {
            &slots[..clamped_candidate_count]
        } else {
            &[]
        }
    } else {
        &[]
    };
    let candidate_slots: &[u32] = if candidate_slots.len() == clamped_candidate_count {
        candidate_slots
    } else {
        let slot_scratch = combat_targeting_candidate_slot_scratch();
        if slot_scratch.len() < clamped_candidate_count {
            slot_scratch.resize(
                clamped_candidate_count,
                COMBAT_TARGETING_INVALID_CANDIDATE_SLOT,
            );
        }
        for ci in 0..clamped_candidate_count {
            let target_id = candidate_ids[ci];
            slot_scratch[ci] = combat_targeting_entity_slot_for_id(pool, target_id)
                .map(|target_slot| target_slot as u32)
                .unwrap_or(COMBAT_TARGETING_INVALID_CANDIDATE_SLOT);
        }
        &slot_scratch[..clamped_candidate_count]
    };
    let candidate_observable: &[u8] = if let Some(observable) = precomputed_candidate_observable {
        if observable.len() >= clamped_candidate_count {
            &observable[..clamped_candidate_count]
        } else {
            &[]
        }
    } else {
        &[]
    };
    let candidate_observable: &[u8] = if candidate_observable.len() == clamped_candidate_count {
        candidate_observable
    } else {
        // Fill per-candidate observability from the slab — same observer
        // (this entity's owner) for every turret on this entity. Stored
        // in the dedicated scratch global so the kernel can pass it as a
        // separate slice while still borrowing the pool mutably for
        // ballistic-solver writes inside the inner gate loop.
        let observable_scratch = combat_targeting_candidate_observable_scratch();
        if observable_scratch.len() < clamped_candidate_count {
            observable_scratch.resize(clamped_candidate_count, 0);
        }
        for ci in 0..clamped_candidate_count {
            let target_slot = candidate_slots[ci];
            observable_scratch[ci] = if target_slot == COMBAT_TARGETING_INVALID_CANDIDATE_SLOT {
                0
            } else {
                combat_targeting_view_mask_observes_entity(
                    pool,
                    target_slot as usize,
                    source_view_mask,
                ) as u8
            };
        }
        &observable_scratch[..clamped_candidate_count]
    };

    // Fill per-candidate mirror-target DPS from the slab only when a
    // passive turret can read it. Normal weapons never consult this
    // buffer, so leave stale scratch values untouched on that path.
    let mut any_passive = false;
    for turret_idx in 0..turret_count {
        if apply_mask[turret_idx] == 0 {
            continue;
        }
        let idx = combat_targeting_turret_global_idx(entity_slot, turret_idx as u32);
        if (pool.turret_config_flags[idx] & CT_TURRET_CFG_PASSIVE) != 0 {
            any_passive = true;
            break;
        }
    }
    if any_passive {
        for ci in 0..clamped_candidate_count {
            if candidate_observable[ci] == 0 {
                candidate_shield_panel_score[ci] = 0.0;
                continue;
            }
            let target_slot = candidate_slots[ci];
            candidate_shield_panel_score[ci] =
                if target_slot == COMBAT_TARGETING_INVALID_CANDIDATE_SLOT {
                    0.0
                } else {
                    combat_targeting_shield_panel_target_score_for_slot(
                        pool,
                        target_slot as usize,
                        entity_slot as usize,
                        source_entity_id,
                    )
                };
        }
    }

    for turret_idx in 0..turret_count {
        if apply_mask[turret_idx] == 0 {
            continue;
        }

        out_target_ids[turret_idx] = -1;
        out_ranks[turret_idx] = seed_ranks[turret_idx];

        let idx = combat_targeting_turret_global_idx(entity_slot, turret_idx as u32);
        let flags = pool.turret_config_flags[idx];
        let has_fire_min = if pool.turret_fire_min_acquire_sq[idx] > 0.0 {
            1
        } else {
            0
        };
        let has_tracking = if (flags & CT_TURRET_CFG_HAS_TRACKING_RANGE) != 0 {
            1
        } else {
            0
        };
        let is_passive = if (flags & CT_TURRET_CFG_PASSIVE) != 0 {
            1
        } else {
            0
        };

        let (
            projectile_speed,
            projectile_mass,
            projectile_air_friction_per_60hz_frame,
            arc_preference,
            max_time_sec,
            ground_aim_fraction,
            under_only,
        ) = combat_targeting_slab_gate_config(pool, idx);

        let choice = combat_targeting_choose_best_candidate_inner_with_internal_gate(
            pool,
            entity_slot,
            turret_idx as u32,
            pool.turret_mount_x[idx],
            pool.turret_mount_y[idx],
            pool.turret_mount_z[idx],
            pool.turret_fire_max_acquire_sq[idx].sqrt(),
            pool.turret_fire_max_release_sq[idx].sqrt(),
            has_fire_min,
            pool.turret_fire_min_acquire_sq[idx].sqrt(),
            pool.turret_fire_min_release_sq[idx].sqrt(),
            has_tracking,
            pool.turret_tracking_acquire_sq[idx].sqrt(),
            pool.turret_tracking_release_sq[idx].sqrt(),
            rank_mode,
            minimum_rank,
            seed_ranks[turret_idx],
            seed_dist_sqs[turret_idx],
            seed_shield_panel_scores[turret_idx],
            is_passive,
            clamped_candidate_count as u32,
            candidate_ids,
            candidate_slots,
            candidate_observable,
            precomputed_candidate_eligible_turret_mask,
            candidate_pos_x,
            candidate_pos_y,
            candidate_pos_z,
            candidate_radius,
            candidate_shield_panel_score,
            source_entity_id,
            terrain_step_len,
            entity_line_width,
            turret_shield_panels_enabled,
            turret_shield_spheres_enabled,
            shield_obstruction_active,
            gravity,
            projectile_speed,
            projectile_mass,
            projectile_air_friction_per_60hz_frame,
            arc_preference,
            max_time_sec,
            ground_aim_fraction,
            under_only,
        );
        let candidate_idx = choice.candidate_idx;
        if candidate_idx >= 0 {
            let candidate_idx = candidate_idx as usize;
            if candidate_idx < candidate_ids.len() {
                out_target_ids[turret_idx] = candidate_ids[candidate_idx];
                out_ranks[turret_idx] = choice.rank;
            }
        }
    }
}

/// Same shape as `combat_targeting_choose_best_candidate_inner` but
/// resolves the fire-gate inline by calling
/// `combat_targeting_candidate_gate_passes` instead of crossing the
/// JS boundary. Takes the pool by `&mut` so the inline ballistic solver
/// can write its scratch slot back to the slab; the choose-best logic
/// is otherwise identical to the legacy path.
pub(crate) fn combat_targeting_choose_best_candidate_inner_with_internal_gate(
    pool: &mut CombatTargetingPool,
    entity_slot: u32,
    turret_idx: u32,
    weapon_x: f64,
    weapon_y: f64,
    weapon_z: f64,
    fire_max_acquire: f64,
    fire_max_release: f64,
    has_fire_min: u8,
    fire_min_acquire: f64,
    fire_min_release: f64,
    has_tracking: u8,
    tracking_acquire: f64,
    tracking_release: f64,
    rank_mode: u8,
    minimum_rank: u8,
    seed_rank: u8,
    seed_dist_sq: f64,
    seed_shield_panel_score: f64,
    is_passive: u8,
    candidate_count: u32,
    candidate_ids: &[i32],
    candidate_slots: &[u32],
    candidate_observable: &[u8],
    precomputed_candidate_eligible_turret_mask: Option<&[u32]>,
    candidate_pos_x: &[f64],
    candidate_pos_y: &[f64],
    candidate_pos_z: &[f64],
    candidate_radius: &[f64],
    candidate_shield_panel_score: &[f64],
    source_entity_id: i32,
    terrain_step_len: f64,
    entity_line_width: f64,
    turret_shield_panels_enabled: u8,
    turret_shield_spheres_enabled: u8,
    shield_obstruction_active: u8,
    gravity: f64,
    projectile_speed: f64,
    projectile_mass: f64,
    projectile_air_friction_per_60hz_frame: f64,
    arc_preference: u8,
    max_time_sec: f64,
    ground_aim_fraction: f64,
    under_only: bool,
) -> TargetingCandidateChoice {
    let seed = targeting_seed_choice(seed_rank);
    let count = (candidate_count as usize)
        .min(candidate_observable.len())
        .min(candidate_pos_x.len())
        .min(candidate_pos_y.len())
        .min(candidate_pos_z.len())
        .min(candidate_radius.len())
        .min(candidate_shield_panel_score.len())
        .min(candidate_ids.len())
        .min(candidate_slots.len());
    if count == 0 {
        return seed;
    }
    let source_entity_slot = entity_slot as usize;
    let source_turret_idx = combat_targeting_turret_global_idx(entity_slot, turret_idx);
    let source_turret_bit = 1u32 << turret_idx;
    let range_volume = combat_targeting_turret_range_volume(pool, source_turret_idx);
    let seed_reciprocal_tier =
        combat_targeting_entity_slot_for_id(pool, pool.turret_target_id[source_turret_idx])
            .map(|slot| {
                combat_targeting_turret_reciprocal_prefer_tier(
                    pool,
                    source_entity_slot,
                    source_turret_idx,
                    slot,
                )
            })
            .unwrap_or(0);
    let candidate_eligible_turret_mask =
        if let Some(mask) = precomputed_candidate_eligible_turret_mask {
            if mask.len() >= count {
                Some(mask)
            } else {
                None
            }
        } else {
            None
        };

    let mut top_candidate_idx = [-1i32; TARGETING_TOPK_LOS];
    let mut top_rank = [CT_TARGET_RANK_NONE; TARGETING_TOPK_LOS];
    let mut top_dist_sq = [0.0f64; TARGETING_TOPK_LOS];
    let mut top_shield_panel_score = [0.0f64; TARGETING_TOPK_LOS];
    let mut top_reciprocal_tier = [0u8; TARGETING_TOPK_LOS];
    let mut top_count = 0usize;

    for ci in 0..count {
        let candidate_slot = candidate_slots[ci];
        if candidate_slot == COMBAT_TARGETING_INVALID_CANDIDATE_SLOT {
            continue;
        }
        let lock_allowed = if let Some(mask) = candidate_eligible_turret_mask {
            (mask[ci] & source_turret_bit) != 0
        } else {
            combat_targeting_turret_may_lock_entity_slot(
                pool,
                source_entity_slot,
                source_turret_idx,
                candidate_slot as usize,
            )
        };
        if !lock_allowed {
            continue;
        }
        let reciprocal_tier = combat_targeting_turret_reciprocal_prefer_tier(
            pool,
            source_entity_slot,
            source_turret_idx,
            candidate_slot as usize,
        );
        let candidate_vertical_extent =
            combat_targeting_target_vertical_extent(pool, candidate_slot as usize);
        let Some((rank, dist_sq, shield_panel_score, reciprocal_tier)) = targeting_score_candidate(
            ci,
            weapon_x,
            weapon_y,
            weapon_z,
            fire_max_acquire,
            fire_max_release,
            has_fire_min,
            fire_min_acquire,
            fire_min_release,
            has_tracking,
            tracking_acquire,
            tracking_release,
            rank_mode,
            minimum_rank,
            reciprocal_tier,
            seed_rank,
            seed_dist_sq,
            seed_reciprocal_tier,
            seed_shield_panel_score,
            is_passive,
            range_volume,
            candidate_observable,
            candidate_pos_x,
            candidate_pos_y,
            candidate_pos_z,
            candidate_radius,
            candidate_vertical_extent,
            candidate_shield_panel_score,
        ) else {
            continue;
        };

        let insert_idx: usize;
        if top_count < TARGETING_TOPK_LOS {
            insert_idx = top_count;
            top_count += 1;
        } else {
            let last = top_count - 1;
            if !targeting_pool_entry_is_better(
                is_passive,
                reciprocal_tier,
                rank,
                dist_sq,
                shield_panel_score,
                top_reciprocal_tier[last],
                top_rank[last],
                top_dist_sq[last],
                top_shield_panel_score[last],
            ) {
                continue;
            }
            insert_idx = last;
        }

        top_candidate_idx[insert_idx] = ci as i32;
        top_rank[insert_idx] = rank;
        top_dist_sq[insert_idx] = dist_sq;
        top_shield_panel_score[insert_idx] = shield_panel_score;
        top_reciprocal_tier[insert_idx] = reciprocal_tier;

        let mut i = insert_idx;
        while i > 0 {
            let j = i - 1;
            let better = targeting_pool_entry_is_better(
                is_passive,
                top_reciprocal_tier[i],
                top_rank[i],
                top_dist_sq[i],
                top_shield_panel_score[i],
                top_reciprocal_tier[j],
                top_rank[j],
                top_dist_sq[j],
                top_shield_panel_score[j],
            );
            if !better {
                break;
            }
            top_candidate_idx.swap(i, j);
            top_rank.swap(i, j);
            top_dist_sq.swap(i, j);
            top_shield_panel_score.swap(i, j);
            top_reciprocal_tier.swap(i, j);
            i = j;
        }
    }

    for k in 0..top_count {
        let candidate_idx = top_candidate_idx[k];
        if candidate_idx < 0 {
            continue;
        }
        let ci = candidate_idx as usize;
        let candidate_slot = candidate_slots[ci];
        if candidate_slot == COMBAT_TARGETING_INVALID_CANDIDATE_SLOT {
            continue;
        }
        if combat_targeting_candidate_slot_gate_passes(
            pool,
            entity_slot,
            turret_idx,
            candidate_slot as usize,
            candidate_ids[ci],
            source_entity_id,
            terrain_step_len,
            entity_line_width,
            turret_shield_panels_enabled,
            turret_shield_spheres_enabled,
            shield_obstruction_active,
            gravity,
            projectile_speed,
            projectile_mass,
            projectile_air_friction_per_60hz_frame,
            arc_preference,
            max_time_sec,
            ground_aim_fraction,
            under_only,
        ) {
            return TargetingCandidateChoice {
                candidate_idx,
                rank: top_rank[k],
            };
        }
    }

    if top_count == 0 {
        return seed;
    }

    let mut fallback_budget = TARGETING_FALLBACK_LOS_BUDGET;
    for ci in 0..count {
        if fallback_budget == 0 {
            break;
        }
        let mut in_top_k = false;
        for k in 0..top_count {
            if top_candidate_idx[k] == ci as i32 {
                in_top_k = true;
                break;
            }
        }
        if in_top_k {
            continue;
        }
        let candidate_slot = candidate_slots[ci];
        if candidate_slot == COMBAT_TARGETING_INVALID_CANDIDATE_SLOT {
            continue;
        }
        let lock_allowed = if let Some(mask) = candidate_eligible_turret_mask {
            (mask[ci] & source_turret_bit) != 0
        } else {
            combat_targeting_turret_may_lock_entity_slot(
                pool,
                source_entity_slot,
                source_turret_idx,
                candidate_slot as usize,
            )
        };
        if !lock_allowed {
            continue;
        }

        let reciprocal_tier = combat_targeting_turret_reciprocal_prefer_tier(
            pool,
            source_entity_slot,
            source_turret_idx,
            candidate_slot as usize,
        );
        let candidate_vertical_extent =
            combat_targeting_target_vertical_extent(pool, candidate_slot as usize);
        let Some((rank, _dist_sq, _shield_panel_score, _reciprocal_tier)) =
            targeting_score_candidate(
                ci,
                weapon_x,
                weapon_y,
                weapon_z,
                fire_max_acquire,
                fire_max_release,
                has_fire_min,
                fire_min_acquire,
                fire_min_release,
                has_tracking,
                tracking_acquire,
                tracking_release,
                rank_mode,
                minimum_rank,
                reciprocal_tier,
                seed_rank,
                seed_dist_sq,
                seed_reciprocal_tier,
                seed_shield_panel_score,
                is_passive,
                range_volume,
                candidate_observable,
                candidate_pos_x,
                candidate_pos_y,
                candidate_pos_z,
                candidate_radius,
                candidate_vertical_extent,
                candidate_shield_panel_score,
            )
        else {
            continue;
        };

        fallback_budget -= 1;
        if combat_targeting_candidate_slot_gate_passes(
            pool,
            entity_slot,
            turret_idx,
            candidate_slot as usize,
            candidate_ids[ci],
            source_entity_id,
            terrain_step_len,
            entity_line_width,
            turret_shield_panels_enabled,
            turret_shield_spheres_enabled,
            shield_obstruction_active,
            gravity,
            projectile_speed,
            projectile_mass,
            projectile_air_friction_per_60hz_frame,
            arc_preference,
            max_time_sec,
            ground_aim_fraction,
            under_only,
        ) {
            return TargetingCandidateChoice {
                candidate_idx: ci as i32,
                rank,
            };
        }
    }

    seed
}

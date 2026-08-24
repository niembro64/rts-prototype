use super::*;

#[cfg(test)]
mod lock_on_inclusion_tests {
    use super::*;
    use std::sync::MutexGuard;

    const MAX: usize = COMBAT_TARGETING_MAX_TURRETS_PER_ENTITY as usize;
    const SOURCE_SLOT: u32 = 0;
    const SOURCE_ID: i32 = 100;
    const PLAYER_1: u8 = 1;
    const PLAYER_2: u8 = 2;
    const SOURCE_UNIT_CODE: u8 = 1;
    const BODY_UNIT_CODE_A: u8 = 3;
    const BODY_UNIT_CODE_B: u8 = 4;
    const BODY_BUILDING_CODE_A: u8 = 5;
    const BODY_BUILDING_CODE_B: u8 = 6;
    const TURRET_CODE_A: u8 = 7;
    const TURRET_CODE_B: u8 = 8;
    const SHOT_CODE_A: u8 = 11;
    const SHOT_CODE_B: u8 = 12;

    // Lock-on is off by default. These "fully permissive" masks include
    // every relationship and family, so a locker carrying them can lock
    // onto anything — the baseline tests narrow from here by overriding
    // the include masks.
    const REL_ALL: u8 = CT_LOCK_ON_REL_INCLUDE_FRIENDLY | CT_LOCK_ON_REL_INCLUDE_ENEMY;
    const FAM_ALL: u8 = CT_LOCK_ON_FAM_INCLUDE_BUILDINGS
        | CT_LOCK_ON_FAM_INCLUDE_TOWERS
        | CT_LOCK_ON_FAM_INCLUDE_UNITS
        | CT_LOCK_ON_FAM_INCLUDE_TURRETS
        | CT_LOCK_ON_FAM_INCLUDE_SHOTS;
    // Every family except units, used to test family inclusion gating.
    const FAM_ALL_BUT_UNITS: u8 = FAM_ALL & !CT_LOCK_ON_FAM_INCLUDE_UNITS;

    #[derive(Clone, Copy)]
    struct TurretSpec {
        state: u8,
        target_id: i32,
        flags: u32,
        target_rescore_period_ticks: u16,
        dps: f32,
        blueprint_code: u8,
        relationship_mask: u8,
        family_mask: u8,
        building_mask: u32,
        unit_mask: u32,
        turret_mask: u32,
        shot_mask: u32,
        reciprocal_mode: u8,
        slaved_to_mount_index: i32,
    }

    impl Default for TurretSpec {
        fn default() -> Self {
            Self {
                state: CT_TURRET_STATE_IDLE,
                target_id: -1,
                flags: CT_TURRET_CFG_HOST_CONTROLLED,
                target_rescore_period_ticks: 0,
                dps: 10.0,
                blueprint_code: TURRET_CODE_A,
                relationship_mask: REL_ALL,
                family_mask: FAM_ALL,
                building_mask: 0,
                unit_mask: 0,
                turret_mask: 0,
                shot_mask: 0,
                reciprocal_mode: CT_LOCK_ON_RECIPROCAL_IGNORE,
                slaved_to_mount_index: -1,
            }
        }
    }

    pub(crate) fn lock_tests() -> MutexGuard<'static, ()> {
        match super::COMBAT_TARGETING_TEST_LOCK.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        }
    }

    pub(crate) fn reset_pools() {
        spatial_init(200.0, 64);
        combat_targeting_init(64);
        shield_pool_clear();
        terrain_clear();
    }

    pub(crate) fn entity_flags(has_combat: bool) -> u8 {
        let mut flags = CT_ENTITY_FLAG_ALIVE | CT_ENTITY_FLAG_BUILDABLE_COMPLETE;
        if has_combat {
            flags |= CT_ENTITY_FLAG_HAS_COMBAT | CT_ENTITY_FLAG_FIRE_ENABLED;
        }
        flags
    }

    pub(crate) fn stamp_entity_with_host_lockon_at_z(
        slot: u32,
        entity_id: i32,
        owner: u8,
        x: f64,
        z: f64,
        family: u8,
        blueprint_code: u8,
        turret_count: u8,
        priority_target_id: i32,
        lockon_relationship_mask: u8,
        lockon_entity_family_mask: u8,
        lockon_building_mask: u32,
        lockon_tower_mask: u32,
        lockon_unit_mask: u32,
        lockon_turret_mask: u32,
        lockon_shot_mask: u32,
    ) {
        let radius = 2.0;
        let (hx, hy, hz) = if family == CT_ENTITY_FAMILY_BUILDING {
            (2.0, 2.0, 2.0)
        } else {
            (0.0, 0.0, 0.0)
        };
        combat_targeting_set_entity(
            slot,
            entity_id,
            owner,
            owner,
            combat_targeting_player_bit(owner),
            x,
            0.0,
            z,
            0.0,
            0.0,
            0.0,
            z,
            1.0,
            0.0,
            0.0,
            0.0,
            1.0,
            0.0,
            0.0,
            0.0,
            radius,
            hx,
            hy,
            hz,
            100.0,
            entity_flags(turret_count > 0),
            family,
            blueprint_code,
            lockon_relationship_mask,
            lockon_entity_family_mask,
            lockon_building_mask,
            lockon_tower_mask,
            lockon_unit_mask,
            lockon_turret_mask,
            lockon_shot_mask,
            x,
            0.0,
            z,
            0.0,
            0.0,
            200.0,
            // These lock-on tests exercise range/inclusion policy rather than
            // contact medium policy, so their generic source carries both
            // above-water and underwater contact-target lanes.
            200.0,
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
            priority_target_id,
            0,
            0.0,
            0.0,
            0.0,
            -1,
            turret_count,
        );

        spatial_set_entity_id(slot, entity_id);
        if family == CT_ENTITY_FAMILY_BUILDING {
            spatial_set_building(slot, x, 0.0, z, hx, hy, hz, owner, 1, 1);
        } else {
            spatial_set_unit(slot, x, 0.0, z, 1.0, radius, owner, 1);
        }
    }

    #[test]
    pub(crate) fn lockon_shelter_detects_friendly_directly_above() {
        let _guard = lock_tests();

        // A flagged unit with a friendly (same-owner) host directly above it
        // (overlapping footprints, higher center) is sheltered → no lock-on.
        reset_pools();
        stamp_entity_with_host_lockon_at_z(
            0,
            10,
            1,
            0.0,
            0.0,
            CT_ENTITY_FAMILY_UNIT,
            0,
            1,
            -1,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
        );
        combat_targeting_pool().entity_flags[0] |= CT_ENTITY_FLAG_PREVENT_LOCKON_IF_TEAM_ABOVE;
        stamp_entity_with_host_lockon_at_z(
            1,
            11,
            1,
            0.0,
            50.0,
            CT_ENTITY_FAMILY_BUILDING,
            0,
            0,
            -1,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
        );
        combat_targeting_rebuild_observation_index(combat_targeting_pool());
        assert!(
            combat_targeting_source_sheltered_by_friendly_above(combat_targeting_pool(), 0),
            "flagged host with a friendly directly above must be sheltered",
        );

        // The same teammate BELOW does not shelter (an upward shot misses it).
        reset_pools();
        stamp_entity_with_host_lockon_at_z(
            0,
            10,
            1,
            0.0,
            0.0,
            CT_ENTITY_FAMILY_UNIT,
            0,
            1,
            -1,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
        );
        combat_targeting_pool().entity_flags[0] |= CT_ENTITY_FLAG_PREVENT_LOCKON_IF_TEAM_ABOVE;
        stamp_entity_with_host_lockon_at_z(
            1,
            11,
            1,
            0.0,
            -50.0,
            CT_ENTITY_FAMILY_BUILDING,
            0,
            0,
            -1,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
        );
        combat_targeting_rebuild_observation_index(combat_targeting_pool());
        assert!(
            !combat_targeting_source_sheltered_by_friendly_above(combat_targeting_pool(), 0),
            "a teammate below the host must not shelter it",
        );

        // An ENEMY directly above does not shelter (only friendlies do).
        reset_pools();
        stamp_entity_with_host_lockon_at_z(
            0,
            10,
            1,
            0.0,
            0.0,
            CT_ENTITY_FAMILY_UNIT,
            0,
            1,
            -1,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
        );
        combat_targeting_pool().entity_flags[0] |= CT_ENTITY_FLAG_PREVENT_LOCKON_IF_TEAM_ABOVE;
        stamp_entity_with_host_lockon_at_z(
            1,
            11,
            2,
            0.0,
            50.0,
            CT_ENTITY_FAMILY_BUILDING,
            0,
            0,
            -1,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
        );
        combat_targeting_rebuild_observation_index(combat_targeting_pool());
        assert!(
            !combat_targeting_source_sheltered_by_friendly_above(combat_targeting_pool(), 0),
            "an enemy above must not shelter the host",
        );

        // Without the opt-in flag the gate is inert even with a friendly above.
        reset_pools();
        stamp_entity_with_host_lockon_at_z(
            0,
            10,
            1,
            0.0,
            0.0,
            CT_ENTITY_FAMILY_UNIT,
            0,
            1,
            -1,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
        );
        stamp_entity_with_host_lockon_at_z(
            1,
            11,
            1,
            0.0,
            50.0,
            CT_ENTITY_FAMILY_BUILDING,
            0,
            0,
            -1,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
        );
        combat_targeting_rebuild_observation_index(combat_targeting_pool());
        assert!(
            !combat_targeting_source_sheltered_by_friendly_above(combat_targeting_pool(), 0),
            "an unflagged host is never sheltered",
        );
    }

    pub(crate) fn stamp_entity_with_host_lockon(
        slot: u32,
        entity_id: i32,
        owner: u8,
        x: f64,
        family: u8,
        blueprint_code: u8,
        turret_count: u8,
        priority_target_id: i32,
        lockon_relationship_mask: u8,
        lockon_entity_family_mask: u8,
        lockon_building_mask: u32,
        lockon_tower_mask: u32,
        lockon_unit_mask: u32,
        lockon_turret_mask: u32,
        lockon_shot_mask: u32,
    ) {
        stamp_entity_with_host_lockon_at_z(
            slot,
            entity_id,
            owner,
            x,
            0.0,
            family,
            blueprint_code,
            turret_count,
            priority_target_id,
            lockon_relationship_mask,
            lockon_entity_family_mask,
            lockon_building_mask,
            lockon_tower_mask,
            lockon_unit_mask,
            lockon_turret_mask,
            lockon_shot_mask,
        );
    }

    pub(crate) fn stamp_entity(
        slot: u32,
        entity_id: i32,
        owner: u8,
        x: f64,
        family: u8,
        blueprint_code: u8,
        turret_count: u8,
        priority_target_id: i32,
    ) {
        // Off by default: give the host fully-permissive inclusion masks
        // so priority-target tests exercise turret/host policy rather than
        // being silently blocked by an empty host include set.
        stamp_entity_with_host_lockon(
            slot,
            entity_id,
            owner,
            x,
            family,
            blueprint_code,
            turret_count,
            priority_target_id,
            REL_ALL,
            FAM_ALL,
            0,
            0,
            0,
            0,
            0,
        );
    }

    pub(crate) fn stamp_entity_at_z(
        slot: u32,
        entity_id: i32,
        owner: u8,
        x: f64,
        z: f64,
        family: u8,
        blueprint_code: u8,
        turret_count: u8,
        priority_target_id: i32,
    ) {
        stamp_entity_with_host_lockon_at_z(
            slot,
            entity_id,
            owner,
            x,
            z,
            family,
            blueprint_code,
            turret_count,
            priority_target_id,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
        );
    }

    fn stamp_source(priority_target_id: i32) {
        stamp_entity(
            SOURCE_SLOT,
            SOURCE_ID,
            PLAYER_1,
            0.0,
            CT_ENTITY_FAMILY_UNIT,
            SOURCE_UNIT_CODE,
            1,
            priority_target_id,
        );
    }

    fn stamp_turret(entity_slot: u32, turret_idx: u32, spec: TurretSpec) {
        let range = 120.0;
        // These legacy targeting fixtures isolate inclusion/range/FSM policy.
        // Give their synthetic emission every explicitly named route so the
        // new fail-closed production matrix does not become an unrelated gate.
        let fixture_flags = spec.flags | CT_TURRET_CFG_ROUTE_MASK | CT_TURRET_CFG_YAW_CONTINUOUS;
        let (parent_id, parent_z, task_target_id) = {
            let pool = combat_targeting_pool();
            let s = entity_slot as usize;
            if s < pool.entity_id.len() {
                let task_target_id = if (fixture_flags & CT_TURRET_CFG_HOST_CONTROLLED) != 0 {
                    pool.entity_priority_target_id[s]
                } else {
                    -1
                };
                (pool.entity_id[s], pool.entity_pos_z[s], task_target_id)
            } else {
                (ENTITY_META_NO_ID, 0.0, -1)
            }
        };
        let turret_entity_id = test_turret_entity_id(parent_id, turret_idx);
        combat_targeting_set_turret(
            entity_slot,
            turret_idx,
            turret_entity_id,
            parent_id,
            parent_id,
            turret_idx as i32,
            0.0,
            0.0,
            parent_z,
            1.0,
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
            -core::f64::consts::PI,
            core::f64::consts::PI,
            -core::f64::consts::FRAC_PI_2,
            core::f64::consts::FRAC_PI_2,
            range * range,
            range * range,
            0.0,
            0.0,
            0.0,
            0.0,
            range,
            0.0,
            0.0,
            0.0,
            0.0,
            -1,
            fixture_flags,
            spec.target_rescore_period_ticks,
            spec.dps,
            0.0,
            0.0,
            0.0,
            0.0,
            0,
            0.0,
            0.0,
            0,
            spec.blueprint_code,
            spec.relationship_mask,
            spec.family_mask,
            spec.building_mask,
            0,
            spec.unit_mask,
            spec.turret_mask,
            spec.shot_mask,
            spec.reciprocal_mode,
            task_target_id,
            0,
            spec.slaved_to_mount_index,
        );
        // set_turret no longer takes the slab-owned FSM tuple; tests
        // that need a non-fresh starting state write the slab directly,
        // matching what the old stamp produced (committed = target).
        let pool = combat_targeting_pool();
        let idx = combat_targeting_turret_global_idx(entity_slot, turret_idx);
        pool.turret_state[idx] = spec.state;
        pool.turret_target_id[idx] = spec.target_id;
        pool.turret_committed_target_id[idx] = spec.target_id;
    }

    pub(crate) fn test_turret_entity_id(parent_id: i32, turret_idx: u32) -> i32 {
        1_000_000 + parent_id.max(0) * 16 + turret_idx as i32
    }

    pub(crate) fn run_schedule_tick_at(
        turret_shield_panels_enabled: u8,
        current_tick: i32,
    ) -> (i32, u8, u8) {
        combat_targeting_rebuild_observation_masks();
        let source_slots = [SOURCE_SLOT];
        let mut cached_fire_ranks = [0u8; MAX];
        let mut cached_fire_dist_sqs = [0.0f64; MAX];
        let mut out_had_cooldown = [0u8; 1];
        let mut out_modes = [CT_TARGETING_TICK_MODE_SKIP; 1];
        let mut out_has_active_work = [0u8; 1];
        combat_targeting_schedule_and_tick_batch(
            &source_slots,
            current_tick,
            16.0,
            turret_shield_panels_enabled,
            1,
            0,
            10.0,
            0.0,
            9.81,
            2,
            // Reacquire period 1: the lock-on semantics under test must not
            // depend on the trailing-scan phase wheel.
            1,
            &mut cached_fire_ranks,
            &mut cached_fire_dist_sqs,
            4.0,
            &mut out_had_cooldown,
            &mut out_modes,
            &mut out_has_active_work,
        );

        let pool = combat_targeting_pool();
        let idx = combat_targeting_turret_global_idx(SOURCE_SLOT, 0);
        (
            pool.turret_target_id[idx],
            pool.turret_state[idx],
            out_modes[0],
        )
    }

    pub(crate) fn run_schedule_tick(turret_shield_panels_enabled: u8) -> (i32, u8, u8) {
        run_schedule_tick_at(turret_shield_panels_enabled, 10)
    }

    pub(crate) fn read_turret_lock(turret_idx: u32) -> (i32, u8) {
        let pool = combat_targeting_pool();
        let idx = combat_targeting_turret_global_idx(SOURCE_SLOT, turret_idx);
        (pool.turret_target_id[idx], pool.turret_state[idx])
    }

    #[test]
    pub(crate) fn obstruct_sight_blocks_non_exempt_turrets() {
        let _guard = lock_tests();
        reset_pools();
        stamp_source(-1);
        stamp_turret(
            SOURCE_SLOT,
            0,
            TurretSpec {
                flags: CT_TURRET_CFG_HOST_CONTROLLED | CT_TURRET_CFG_PASSIVE,
                ..TurretSpec::default()
            },
        );

        shield_panel_pool_set_unit_count(1);
        shield_panel_pool_set_panel_count(1);
        shield_panel_pool_set_unit(
            0, 900, 10.0, 0.0, 0.0, 0.0, 100.0, 0.0, 0.0, 10.0, 0.0, 0.0, 0, 1,
        );
        shield_panel_pool_set_panel(
            0,
            0.0,
            0.0,
            0.0,
            -10.0,
            10.0,
            10.0,
            SHIELD_REFLECTION_MODE_BOTH,
            SHIELD_REFLECTION_MODE_BOTH,
            SHIELD_REFLECTION_MODE_BOTH,
        );

        let idx = combat_targeting_turret_global_idx(SOURCE_SLOT, 0);
        let flags = combat_targeting_pool().turret_config_flags[idx];
        let (_, ballistic_clear, panel_clear) = compute_turret_gates_for_aim_point(
            combat_targeting_pool(),
            SOURCE_SLOT,
            0,
            idx,
            flags,
            0.0,
            0.0,
            0.0,
            20.0,
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
            -1,
            SOURCE_ID,
            10.0,
            0.0,
            1,
            0,
            1,
            0.0,
            0.0,
            0.0,
            0,
            0.0,
            0.0,
            false,
            9.81,
        );
        assert_eq!(ballistic_clear, 1);
        assert_eq!(
            panel_clear, 0,
            "shield-aware targeting should not make passive non-force turrets see through shield panels",
        );

        let (_, _, disabled_panel_clear) = compute_turret_gates_for_aim_point(
            combat_targeting_pool(),
            SOURCE_SLOT,
            0,
            idx,
            flags,
            0.0,
            0.0,
            0.0,
            20.0,
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
            -1,
            SOURCE_ID,
            10.0,
            0.0,
            0,
            0,
            1,
            0.0,
            0.0,
            0.0,
            0,
            0.0,
            0.0,
            false,
            9.81,
        );
        assert_eq!(disabled_panel_clear, 1);

        let shield_emitter_flags_without_exemption =
            (flags & !CT_TURRET_CFG_PASSIVE) | CT_TURRET_CFG_SHOT_IS_FORCE;
        let (_, _, non_exempt_shield_emitter_clear) = compute_turret_gates_for_aim_point(
            combat_targeting_pool(),
            SOURCE_SLOT,
            0,
            idx,
            shield_emitter_flags_without_exemption,
            0.0,
            0.0,
            0.0,
            20.0,
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
            -1,
            SOURCE_ID,
            10.0,
            0.0,
            1,
            0,
            1,
            0.0,
            0.0,
            0.0,
            0,
            0.0,
            0.0,
            false,
            9.81,
        );
        assert_eq!(
            non_exempt_shield_emitter_clear, 0,
            "shield emitters without the exemption flag obey shield-aware targeting",
        );

        let (_, _, exempt_shield_emitter_clear) = compute_turret_gates_for_aim_point(
            combat_targeting_pool(),
            SOURCE_SLOT,
            0,
            idx,
            shield_emitter_flags_without_exemption
                | CT_TURRET_CFG_IGNORES_FORCE_MATERIAL_SIGHT_OBSTRUCTION,
            0.0,
            0.0,
            0.0,
            20.0,
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
            -1,
            SOURCE_ID,
            10.0,
            0.0,
            1,
            0,
            1,
            0.0,
            0.0,
            0.0,
            0,
            0.0,
            0.0,
            false,
            9.81,
        );
        assert_eq!(
            exempt_shield_emitter_clear, 1,
            "shield emitters keep their maintenance exemption",
        );

        shield_pool_set_count(1);
        shield_pool_set_field(
            0,
            901,
            901,
            10.0,
            0.0,
            0.0,
            10.0,
            0.0,
            0.0,
            5.0,
            SHIELD_REFLECTION_MODE_BOTH,
            SHIELD_REFLECTION_MODE_BOTH,
            SHIELD_REFLECTION_MODE_BOTH,
        );
        let (_, _, active_field_clear) = compute_turret_gates_for_aim_point(
            combat_targeting_pool(),
            SOURCE_SLOT,
            0,
            idx,
            shield_emitter_flags_without_exemption,
            0.0,
            0.0,
            0.0,
            10.0,
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
            -1,
            SOURCE_ID,
            10.0,
            0.0,
            0,
            1,
            1,
            0.0,
            0.0,
            0.0,
            0,
            0.0,
            0.0,
            false,
            9.81,
        );
        assert_eq!(
            active_field_clear, 0,
            "active shield fields around targets must block shield submunition turrets",
        );
    }

    pub(crate) fn stamp_body_target(
        slot: u32,
        entity_id: i32,
        owner: u8,
        x: f64,
        family: u8,
        code: u8,
    ) {
        stamp_entity(slot, entity_id, owner, x, family, code, 0, -1);
    }

    pub(crate) fn stamp_body_target_at_z(
        slot: u32,
        entity_id: i32,
        owner: u8,
        x: f64,
        z: f64,
        family: u8,
        code: u8,
    ) {
        stamp_entity_at_z(slot, entity_id, owner, x, z, family, code, 0, -1);
    }

    pub(crate) fn stamp_turret_target(
        slot: u32,
        entity_id: i32,
        owner: u8,
        x: f64,
        turret_codes: &[u8],
        target_source: bool,
    ) {
        stamp_turret_target_with_target_id(
            slot,
            entity_id,
            owner,
            x,
            turret_codes,
            if target_source { SOURCE_ID } else { -1 },
        );
    }

    pub(crate) fn stamp_turret_target_with_target_id(
        slot: u32,
        entity_id: i32,
        owner: u8,
        x: f64,
        turret_codes: &[u8],
        target_id: i32,
    ) {
        stamp_entity(
            slot,
            entity_id,
            owner,
            x,
            CT_ENTITY_FAMILY_UNIT,
            BODY_UNIT_CODE_A,
            turret_codes.len() as u8,
            -1,
        );
        for (i, code) in turret_codes.iter().enumerate() {
            stamp_turret(
                slot,
                i as u32,
                TurretSpec {
                    state: if target_id >= 0 {
                        CT_TURRET_STATE_ENGAGED
                    } else {
                        CT_TURRET_STATE_IDLE
                    },
                    target_id,
                    blueprint_code: *code,
                    ..TurretSpec::default()
                },
            );
        }
    }

    #[test]
    pub(crate) fn turret_slabs_store_runtime_identity() {
        let _guard = lock_tests();
        reset_pools();

        turret_pool_init(8);
        turret_pool_set_count(2, 2);
        turret_pool_set_turret(2, 1, 700, 55, 55, 1, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 12.0, -1);
        let snapshot_idx = (2usize * (TURRET_POOL_MAX_PER_ENTITY as usize)) + 1;
        {
            let pool = turret_pool();
            assert_eq!(pool.entity_id[snapshot_idx], 700);
            assert_eq!(pool.parent_id[snapshot_idx], 55);
            assert_eq!(pool.root_host_id[snapshot_idx], 55);
            assert_eq!(pool.mount_index[snapshot_idx], 1);
        }

        stamp_entity(
            5,
            55,
            PLAYER_1,
            0.0,
            CT_ENTITY_FAMILY_UNIT,
            SOURCE_UNIT_CODE,
            1,
            -1,
        );
        stamp_turret(5, 0, TurretSpec::default());
        let targeting_idx = combat_targeting_turret_global_idx(5, 0);
        let targeting = combat_targeting_pool();
        assert_eq!(targeting.turret_entity_id[targeting_idx], 1_000_880);
        assert_eq!(targeting.turret_parent_id[targeting_idx], 55);
        assert_eq!(targeting.turret_root_host_id[targeting_idx], 55);
        assert_eq!(targeting.turret_mount_index[targeting_idx], 0);
    }

    #[test]
    pub(crate) fn combat_halt_any_engaged_uses_priority_point_and_skips_non_attack_emitters() {
        let _guard = lock_tests();
        reset_pools();
        stamp_source(-1);
        stamp_turret(
            SOURCE_SLOT,
            0,
            TurretSpec {
                state: CT_TURRET_STATE_ENGAGED,
                target_id: -1,
                ..TurretSpec::default()
            },
        );

        let slots = [SOURCE_SLOT];
        let modes = [CT_COMBAT_HALT_MODE_ANY_ENGAGED];
        let mut out = [0u8];
        combat_targeting_halt_decision_batch(&slots, &modes, &[0], &[-1], &mut out);
        assert_eq!(
            out[0], 0,
            "engaged priority-point turret needs an active point"
        );
        combat_targeting_halt_decision_batch(&slots, &modes, &[1], &[-1], &mut out);
        assert_eq!(out[0], 1);

        stamp_turret(
            SOURCE_SLOT,
            0,
            TurretSpec {
                state: CT_TURRET_STATE_ENGAGED,
                target_id: 201,
                ..TurretSpec::default()
            },
        );
        combat_targeting_halt_decision_batch(&slots, &modes, &[0], &[202], &mut out);
        assert_eq!(
            out[0], 0,
            "an old turret lock must not satisfy a newly ordered host target"
        );
        combat_targeting_halt_decision_batch(&slots, &modes, &[0], &[201], &mut out);
        assert_eq!(
            out[0], 1,
            "a turret lock matching the host's ordered target must halt movement"
        );

        reset_pools();
        stamp_source(-1);
        stamp_turret(
            SOURCE_SLOT,
            0,
            TurretSpec {
                state: CT_TURRET_STATE_ENGAGED,
                target_id: 201,
                flags: CT_TURRET_CFG_HOST_CONTROLLED | CT_TURRET_CFG_NON_ATTACK_EMITTER,
                ..TurretSpec::default()
            },
        );
        combat_targeting_halt_decision_batch(&slots, &modes, &[0], &[-1], &mut out);
        assert_eq!(out[0], 0, "non-attack emitters must not halt movement");
    }

    #[test]
    pub(crate) fn combat_halt_fight_required_requires_all_marked_turrets() {
        let _guard = lock_tests();
        reset_pools();
        stamp_entity(
            SOURCE_SLOT,
            SOURCE_ID,
            PLAYER_1,
            0.0,
            CT_ENTITY_FAMILY_UNIT,
            SOURCE_UNIT_CODE,
            3,
            -1,
        );
        stamp_turret(
            SOURCE_SLOT,
            0,
            TurretSpec {
                state: CT_TURRET_STATE_ENGAGED,
                target_id: 201,
                flags: CT_TURRET_CFG_REQUIRED_ENGAGED_FOR_FIGHT_STOP,
                ..TurretSpec::default()
            },
        );
        stamp_turret(
            SOURCE_SLOT,
            1,
            TurretSpec {
                state: CT_TURRET_STATE_IDLE,
                target_id: -1,
                flags: CT_TURRET_CFG_REQUIRED_ENGAGED_FOR_FIGHT_STOP,
                ..TurretSpec::default()
            },
        );
        stamp_turret(
            SOURCE_SLOT,
            2,
            TurretSpec {
                state: CT_TURRET_STATE_ENGAGED,
                target_id: 202,
                flags: CT_TURRET_CFG_HOST_CONTROLLED,
                ..TurretSpec::default()
            },
        );

        let slots = [SOURCE_SLOT];
        let modes = [CT_COMBAT_HALT_MODE_FIGHT_REQUIRED];
        let mut out = [0u8];
        combat_targeting_halt_decision_batch(&slots, &modes, &[0], &[-1], &mut out);
        assert_eq!(out[0], 0, "all required fight-stop turrets must be engaged");
        stamp_turret(
            SOURCE_SLOT,
            1,
            TurretSpec {
                state: CT_TURRET_STATE_ENGAGED,
                target_id: 203,
                flags: CT_TURRET_CFG_REQUIRED_ENGAGED_FOR_FIGHT_STOP,
                ..TurretSpec::default()
            },
        );
        combat_targeting_halt_decision_batch(&slots, &modes, &[0], &[-1], &mut out);
        assert_eq!(
            out[0], 1,
            "host-controlled turrets do not matter unless their mount is marked required"
        );
    }

    #[test]
    pub(crate) fn auto_full_inclusions_can_lock_friendly_enemy_bodies_and_turrets() {
        // A fully-permissive locker (REL_ALL + FAM_ALL, the TurretSpec
        // default) can lock onto any friendly or enemy body or turret.
        let _guard = lock_tests();
        let cases = [
            (
                "friendly unit",
                PLAYER_1,
                CT_ENTITY_FAMILY_UNIT,
                BODY_UNIT_CODE_A,
                false,
            ),
            (
                "enemy unit",
                PLAYER_2,
                CT_ENTITY_FAMILY_UNIT,
                BODY_UNIT_CODE_A,
                false,
            ),
            (
                "friendly building",
                PLAYER_1,
                CT_ENTITY_FAMILY_BUILDING,
                BODY_BUILDING_CODE_A,
                false,
            ),
            (
                "enemy building",
                PLAYER_2,
                CT_ENTITY_FAMILY_BUILDING,
                BODY_BUILDING_CODE_A,
                false,
            ),
            (
                "friendly shot",
                PLAYER_1,
                CT_ENTITY_FAMILY_SHOT,
                SHOT_CODE_A,
                false,
            ),
            (
                "enemy shot",
                PLAYER_2,
                CT_ENTITY_FAMILY_SHOT,
                SHOT_CODE_A,
                false,
            ),
            (
                "friendly turret",
                PLAYER_1,
                CT_ENTITY_FAMILY_UNIT,
                BODY_UNIT_CODE_A,
                true,
            ),
            (
                "enemy turret",
                PLAYER_2,
                CT_ENTITY_FAMILY_UNIT,
                BODY_UNIT_CODE_A,
                true,
            ),
        ];

        for (label, owner, family, blueprint_code, is_turret_target) in cases {
            reset_pools();
            stamp_source(-1);
            stamp_turret(SOURCE_SLOT, 0, TurretSpec::default());
            if is_turret_target {
                stamp_turret_target(1, 201, owner, 20.0, &[TURRET_CODE_A], false);
            } else {
                stamp_body_target(1, 201, owner, 20.0, family, blueprint_code);
            }

            let (target_id, state, _) = run_schedule_tick(1);
            assert_eq!(target_id, 201, "{label}");
            assert_ne!(state, CT_TURRET_STATE_IDLE, "{label}");
        }
    }

    #[test]
    pub(crate) fn auto_empty_inclusions_lock_nothing() {
        // Off by default: a turret that includes no relationship and no
        // family must lock onto nothing, even with an eligible enemy in
        // range.
        let _guard = lock_tests();
        reset_pools();
        stamp_source(-1);
        stamp_turret(
            SOURCE_SLOT,
            0,
            TurretSpec {
                relationship_mask: 0,
                family_mask: 0,
                ..TurretSpec::default()
            },
        );
        stamp_body_target(
            1,
            201,
            PLAYER_2,
            20.0,
            CT_ENTITY_FAMILY_UNIT,
            BODY_UNIT_CODE_A,
        );
        let (target_id, state, _) = run_schedule_tick(1);
        assert_eq!(target_id, -1, "empty inclusion masks must lock nothing");
        assert_eq!(state, CT_TURRET_STATE_IDLE);
    }

    #[test]
    pub(crate) fn observation_masks_include_targets_above_legacy_terrain_cap() {
        let _guard = lock_tests();
        reset_pools();
        let high_z = SPATIAL_TERRAIN_MAX_RENDER_Y + 3_000.0;

        stamp_entity_at_z(
            SOURCE_SLOT,
            SOURCE_ID,
            PLAYER_1,
            0.0,
            high_z,
            CT_ENTITY_FAMILY_UNIT,
            SOURCE_UNIT_CODE,
            1,
            -1,
        );
        stamp_turret(
            SOURCE_SLOT,
            0,
            TurretSpec {
                relationship_mask: CT_LOCK_ON_REL_INCLUDE_ENEMY,
                ..TurretSpec::default()
            },
        );
        stamp_body_target_at_z(
            1,
            201,
            PLAYER_2,
            20.0,
            high_z,
            CT_ENTITY_FAMILY_UNIT,
            BODY_UNIT_CODE_A,
        );
        stamp_body_target_at_z(
            2,
            202,
            PLAYER_2,
            1_000.0,
            0.0,
            CT_ENTITY_FAMILY_UNIT,
            BODY_UNIT_CODE_B,
        );

        combat_targeting_rebuild_observation_masks_for_sources(&[SOURCE_SLOT]);
        assert_eq!(
            combat_targeting_can_player_observe_entity(201, PLAYER_1),
            1,
            "fast-path sensor rebuild must cover stamped entities above the old fixed Z cap",
        );

        let (target_id, state, _) = run_schedule_tick(1);
        assert_eq!(target_id, 201);
        assert_ne!(state, CT_TURRET_STATE_IDLE);
    }

    #[test]
    pub(crate) fn relationship_inclusions_drive_auto_candidate_collection() {
        let _guard = lock_tests();

        reset_pools();
        stamp_source(-1);
        stamp_turret(
            SOURCE_SLOT,
            0,
            TurretSpec {
                relationship_mask: CT_LOCK_ON_REL_INCLUDE_ENEMY,
                ..TurretSpec::default()
            },
        );
        stamp_body_target(
            1,
            201,
            PLAYER_1,
            10.0,
            CT_ENTITY_FAMILY_UNIT,
            BODY_UNIT_CODE_A,
        );
        stamp_body_target(
            2,
            202,
            PLAYER_2,
            30.0,
            CT_ENTITY_FAMILY_UNIT,
            BODY_UNIT_CODE_A,
        );
        let (target_id, _, _) = run_schedule_tick(1);
        assert_eq!(
            target_id, 202,
            "combat turret must skip closer friendly target"
        );

        reset_pools();
        stamp_source(-1);
        stamp_turret(
            SOURCE_SLOT,
            0,
            TurretSpec {
                relationship_mask: CT_LOCK_ON_REL_INCLUDE_FRIENDLY,
                ..TurretSpec::default()
            },
        );
        stamp_body_target(
            1,
            203,
            PLAYER_2,
            10.0,
            CT_ENTITY_FAMILY_UNIT,
            BODY_UNIT_CODE_A,
        );
        stamp_body_target(
            2,
            204,
            PLAYER_1,
            30.0,
            CT_ENTITY_FAMILY_UNIT,
            BODY_UNIT_CODE_A,
        );
        let (target_id, _, _) = run_schedule_tick(1);
        assert_eq!(
            target_id, 204,
            "construction-style turret must gather friendly candidates"
        );

        // Relationship is team-based, not raw owner equality. This mirrors
        // allied-player behavior in the TypeScript world.
        reset_pools();
        stamp_source(-1);
        stamp_turret(
            SOURCE_SLOT,
            0,
            TurretSpec {
                relationship_mask: CT_LOCK_ON_REL_INCLUDE_FRIENDLY,
                ..TurretSpec::default()
            },
        );
        stamp_body_target(
            1,
            205,
            PLAYER_2,
            15.0,
            CT_ENTITY_FAMILY_UNIT,
            BODY_UNIT_CODE_A,
        );
        combat_targeting_pool().entity_team_id[1] = PLAYER_1;
        let (target_id, _, _) = run_schedule_tick(1);
        assert_eq!(target_id, 205, "allied owners on one team must be friendly");
    }

    #[test]
    pub(crate) fn bottom_unbounded_turret_range_cylinder_allows_targets_far_below() {
        let _guard = lock_tests();
        reset_pools();
        stamp_entity_at_z(
            SOURCE_SLOT,
            SOURCE_ID,
            PLAYER_1,
            0.0,
            500.0,
            CT_ENTITY_FAMILY_UNIT,
            SOURCE_UNIT_CODE,
            1,
            -1,
        );
        stamp_turret(
            SOURCE_SLOT,
            0,
            TurretSpec {
                flags: CT_TURRET_CFG_HOST_CONTROLLED | CT_TURRET_CFG_RANGE_BOTTOM_UNBOUNDED,
                ..TurretSpec::default()
            },
        );
        stamp_body_target_at_z(
            1,
            201,
            PLAYER_2,
            20.0,
            -500.0,
            CT_ENTITY_FAMILY_UNIT,
            BODY_UNIT_CODE_A,
        );

        let (target_id, state, _) = run_schedule_tick(1);
        assert_eq!(
            target_id, 201,
            "bottom-unbounded range volumes must preserve old lower-unbounded targeting"
        );
        assert_eq!(state, CT_TURRET_STATE_ENGAGED);
    }

    #[test]
    pub(crate) fn bottom_unbounded_turret_range_cylinder_ranks_by_horizontal_distance() {
        let _guard = lock_tests();
        reset_pools();
        stamp_entity_at_z(
            SOURCE_SLOT,
            SOURCE_ID,
            PLAYER_1,
            0.0,
            500.0,
            CT_ENTITY_FAMILY_UNIT,
            SOURCE_UNIT_CODE,
            1,
            -1,
        );
        stamp_turret(
            SOURCE_SLOT,
            0,
            TurretSpec {
                flags: CT_TURRET_CFG_HOST_CONTROLLED | CT_TURRET_CFG_RANGE_BOTTOM_UNBOUNDED,
                ..TurretSpec::default()
            },
        );
        stamp_body_target_at_z(
            1,
            201,
            PLAYER_2,
            20.0,
            -500.0,
            CT_ENTITY_FAMILY_UNIT,
            BODY_UNIT_CODE_A,
        );
        stamp_body_target_at_z(
            2,
            202,
            PLAYER_2,
            30.0,
            500.0,
            CT_ENTITY_FAMILY_UNIT,
            BODY_UNIT_CODE_B,
        );

        let (target_id, state, _) = run_schedule_tick(1);
        assert_eq!(
            target_id, 201,
            "candidate ordering should use horizontal distance, not 3D distance"
        );
        assert_eq!(state, CT_TURRET_STATE_ENGAGED);
    }

    #[test]
    pub(crate) fn bounded_turret_range_cylinder_rejects_targets_below_bottom_cap() {
        let _guard = lock_tests();
        reset_pools();
        stamp_source(-1);
        stamp_turret(SOURCE_SLOT, 0, TurretSpec::default());
        stamp_body_target_at_z(
            1,
            201,
            PLAYER_2,
            20.0,
            -123.0,
            CT_ENTITY_FAMILY_UNIT,
            BODY_UNIT_CODE_A,
        );

        let (target_id, state, _) = run_schedule_tick(1);
        assert_eq!(
            target_id, -1,
            "targets whose body is fully below mount.z - range must be out of range"
        );
        assert_eq!(state, CT_TURRET_STATE_IDLE);
    }

    #[test]
    pub(crate) fn turret_range_cylinder_rejects_targets_above_top_cap() {
        let _guard = lock_tests();
        reset_pools();
        stamp_source(-1);
        stamp_turret(SOURCE_SLOT, 0, TurretSpec::default());
        stamp_body_target_at_z(
            1,
            201,
            PLAYER_2,
            20.0,
            123.0,
            CT_ENTITY_FAMILY_UNIT,
            BODY_UNIT_CODE_A,
        );

        let (target_id, state, _) = run_schedule_tick(1);
        assert_eq!(
            target_id, -1,
            "targets whose body is fully above mount.z + range must be out of range"
        );
        assert_eq!(state, CT_TURRET_STATE_IDLE);
    }

    #[test]
    pub(crate) fn top_and_bottom_unbounded_turret_range_cylinder_allows_targets_far_above() {
        let _guard = lock_tests();
        reset_pools();
        stamp_source(-1);
        stamp_turret(
            SOURCE_SLOT,
            0,
            TurretSpec {
                flags: CT_TURRET_CFG_HOST_CONTROLLED
                    | CT_TURRET_CFG_RANGE_BOTTOM_UNBOUNDED
                    | CT_TURRET_CFG_RANGE_TOP_UNBOUNDED,
                ..TurretSpec::default()
            },
        );
        stamp_body_target_at_z(
            1,
            201,
            PLAYER_2,
            20.0,
            1000.0,
            CT_ENTITY_FAMILY_UNIT,
            BODY_UNIT_CODE_A,
        );

        let (target_id, state, _) = run_schedule_tick(1);
        assert_eq!(
            target_id, 201,
            "top-and-bottom-unbounded cylinders should only spend horizontal range"
        );
        assert_eq!(state, CT_TURRET_STATE_ENGAGED);
    }

    #[test]
    pub(crate) fn top_water_and_bottom_unbounded_turret_only_targets_the_submerged_volume() {
        let _guard = lock_tests();
        reset_pools();
        stamp_entity_at_z(
            SOURCE_SLOT,
            SOURCE_ID,
            PLAYER_1,
            0.0,
            TERRAIN_WATER_LEVEL - 10.0,
            CT_ENTITY_FAMILY_UNIT,
            SOURCE_UNIT_CODE,
            1,
            -1,
        );
        stamp_turret(
            SOURCE_SLOT,
            0,
            TurretSpec {
                flags: CT_TURRET_CFG_HOST_CONTROLLED
                    | CT_TURRET_CFG_RANGE_TOP_WATER_AND_BOTTOM_UNBOUNDED,
                ..TurretSpec::default()
            },
        );
        stamp_body_target_at_z(
            1,
            201,
            PLAYER_2,
            20.0,
            TERRAIN_WATER_LEVEL + 3.0,
            CT_ENTITY_FAMILY_UNIT,
            BODY_UNIT_CODE_A,
        );

        let (target_id, state, _) = run_schedule_tick(1);
        assert_eq!(target_id, -1, "a body fully above water must be rejected");
        assert_eq!(state, CT_TURRET_STATE_IDLE);

        reset_pools();
        stamp_entity_at_z(
            SOURCE_SLOT,
            SOURCE_ID,
            PLAYER_1,
            0.0,
            TERRAIN_WATER_LEVEL - 10.0,
            CT_ENTITY_FAMILY_UNIT,
            SOURCE_UNIT_CODE,
            1,
            -1,
        );
        stamp_turret(
            SOURCE_SLOT,
            0,
            TurretSpec {
                flags: CT_TURRET_CFG_HOST_CONTROLLED
                    | CT_TURRET_CFG_RANGE_TOP_WATER_AND_BOTTOM_UNBOUNDED,
                ..TurretSpec::default()
            },
        );
        stamp_body_target_at_z(
            1,
            202,
            PLAYER_2,
            20.0,
            TERRAIN_WATER_LEVEL - 1000.0,
            CT_ENTITY_FAMILY_UNIT,
            BODY_UNIT_CODE_A,
        );

        let (target_id, state, _) = run_schedule_tick(1);
        assert_eq!(
            target_id, 202,
            "the range volume must remain unbounded at depth"
        );
        assert_eq!(state, CT_TURRET_STATE_ENGAGED);
    }

    #[test]
    pub(crate) fn top_water_range_volume_rejects_an_above_water_priority_target() {
        let _guard = lock_tests();
        reset_pools();
        stamp_entity_with_host_lockon_at_z(
            SOURCE_SLOT,
            SOURCE_ID,
            PLAYER_1,
            0.0,
            TERRAIN_WATER_LEVEL - 10.0,
            CT_ENTITY_FAMILY_UNIT,
            SOURCE_UNIT_CODE,
            1,
            201,
            REL_ALL,
            FAM_ALL,
            0,
            0,
            0,
            0,
            0,
        );
        stamp_turret(
            SOURCE_SLOT,
            0,
            TurretSpec {
                flags: CT_TURRET_CFG_HOST_CONTROLLED
                    | CT_TURRET_CFG_RANGE_TOP_WATER_AND_BOTTOM_UNBOUNDED,
                ..TurretSpec::default()
            },
        );
        stamp_body_target_at_z(
            1,
            201,
            PLAYER_2,
            20.0,
            TERRAIN_WATER_LEVEL + 3.0,
            CT_ENTITY_FAMILY_UNIT,
            BODY_UNIT_CODE_A,
        );

        let (target_id, state, mode) = run_schedule_tick(1);
        assert_eq!(mode, CT_TARGETING_TICK_MODE_PRIORITY_TARGET);
        assert_eq!(
            target_id, -1,
            "an attack order must not bypass the water-surface ceiling"
        );
        assert_eq!(state, CT_TURRET_STATE_IDLE);
    }

    #[test]
    pub(crate) fn sphere_turret_range_rejects_targets_inside_cylinder_but_outside_sphere() {
        let _guard = lock_tests();
        reset_pools();
        stamp_source(-1);
        stamp_turret(
            SOURCE_SLOT,
            0,
            TurretSpec {
                flags: CT_TURRET_CFG_HOST_CONTROLLED | CT_TURRET_CFG_RANGE_SPHERE,
                ..TurretSpec::default()
            },
        );
        stamp_body_target_at_z(
            1,
            201,
            PLAYER_2,
            100.0,
            100.0,
            CT_ENTITY_FAMILY_UNIT,
            BODY_UNIT_CODE_A,
        );

        let (target_id, state, _) = run_schedule_tick(1);
        assert_eq!(
            target_id, -1,
            "sphere range should use 3D distance instead of cylinder membership"
        );
        assert_eq!(state, CT_TURRET_STATE_IDLE);
    }

    #[test]
    pub(crate) fn mirror_policy_locks_enemy_turrets_without_locking_hosts_as_bodies() {
        let _guard = lock_tests();
        reset_pools();
        stamp_source(-1);
        stamp_turret(
            SOURCE_SLOT,
            0,
            TurretSpec {
                flags: CT_TURRET_CFG_PASSIVE | CT_TURRET_CFG_SHOT_IS_FORCE,
                relationship_mask: CT_LOCK_ON_REL_INCLUDE_ENEMY,
                family_mask: CT_LOCK_ON_FAM_INCLUDE_TURRETS,
                reciprocal_mode: CT_LOCK_ON_RECIPROCAL_REQUIRE,
                ..TurretSpec::default()
            },
        );
        stamp_turret_target(1, 201, PLAYER_1, 10.0, &[TURRET_CODE_A], true);
        stamp_body_target(
            2,
            202,
            PLAYER_2,
            15.0,
            CT_ENTITY_FAMILY_UNIT,
            BODY_UNIT_CODE_A,
        );
        stamp_body_target(
            3,
            203,
            PLAYER_2,
            20.0,
            CT_ENTITY_FAMILY_BUILDING,
            BODY_BUILDING_CODE_A,
        );
        stamp_turret_target(4, 204, PLAYER_2, 30.0, &[TURRET_CODE_A], true);

        let (target_id, state, _) = run_schedule_tick(1);
        assert_eq!(target_id, 204);
        assert_ne!(state, CT_TURRET_STATE_IDLE);
    }

    #[test]
    pub(crate) fn mirror_policy_uses_panel_mount_after_a_sensor_mount() {
        let _guard = lock_tests();
        reset_pools();
        stamp_entity(
            SOURCE_SLOT,
            SOURCE_ID,
            PLAYER_1,
            0.0,
            CT_ENTITY_FAMILY_UNIT,
            SOURCE_UNIT_CODE,
            2,
            -1,
        );
        stamp_turret(
            SOURCE_SLOT,
            0,
            TurretSpec {
                flags: CT_TURRET_CFG_PASSIVE | CT_TURRET_CFG_NON_ATTACK_EMITTER,
                ..TurretSpec::default()
            },
        );
        stamp_turret(
            SOURCE_SLOT,
            1,
            TurretSpec {
                flags: CT_TURRET_CFG_PASSIVE | CT_TURRET_CFG_SHOT_IS_FORCE,
                relationship_mask: CT_LOCK_ON_REL_INCLUDE_ENEMY,
                family_mask: CT_LOCK_ON_FAM_INCLUDE_TURRETS,
                reciprocal_mode: CT_LOCK_ON_RECIPROCAL_REQUIRE,
                ..TurretSpec::default()
            },
        );
        stamp_turret_target(4, 204, PLAYER_2, 30.0, &[TURRET_CODE_A], true);

        run_schedule_tick(1);
        let (target_id, state) = read_turret_lock(1);
        assert_eq!(
            target_id, 204,
            "a leading sensor mount must not steal the Loris panel's threat lock",
        );
        assert_ne!(state, CT_TURRET_STATE_IDLE);
    }

    #[test]
    pub(crate) fn mirror_periodically_retargets_to_a_stronger_reciprocal_threat() {
        let _guard = lock_tests();
        reset_pools();
        stamp_source(-1);
        stamp_turret(
            SOURCE_SLOT,
            0,
            TurretSpec {
                state: CT_TURRET_STATE_ENGAGED,
                target_id: 201,
                flags: CT_TURRET_CFG_PASSIVE | CT_TURRET_CFG_SHOT_IS_FORCE,
                target_rescore_period_ticks: 16,
                relationship_mask: CT_LOCK_ON_REL_INCLUDE_ENEMY,
                family_mask: CT_LOCK_ON_FAM_INCLUDE_TURRETS,
                reciprocal_mode: CT_LOCK_ON_RECIPROCAL_REQUIRE,
                ..TurretSpec::default()
            },
        );
        stamp_turret_target_with_target_id(1, 201, PLAYER_2, 20.0, &[TURRET_CODE_A], SOURCE_ID);
        stamp_turret_target_with_target_id(2, 202, PLAYER_2, 30.0, &[TURRET_CODE_A], SOURCE_ID);
        {
            let pool = combat_targeting_pool();
            pool.turret_dps[combat_targeting_turret_global_idx(1, 0)] = 10.0;
            pool.turret_dps[combat_targeting_turret_global_idx(2, 0)] = 40.0;
        }

        // SOURCE_ID 100 has phase 4 on a 16-tick cadence.
        let before_refresh = run_schedule_tick_at(1, 3);
        assert_eq!(
            before_refresh.0, 201,
            "a still-valid lock must remain stable between profile refreshes",
        );
        let on_refresh = run_schedule_tick_at(1, 4);
        assert_eq!(
            on_refresh.0, 202,
            "the reflector must switch to the highest-DPS valid turret threatening it",
        );
        assert_eq!(on_refresh.1, CT_TURRET_STATE_ENGAGED);
    }

    #[test]
    pub(crate) fn mirror_refresh_holds_equal_power_and_ignores_excluded_turrets() {
        let _guard = lock_tests();
        reset_pools();
        stamp_source(-1);
        stamp_turret(
            SOURCE_SLOT,
            0,
            TurretSpec {
                state: CT_TURRET_STATE_ENGAGED,
                target_id: 201,
                flags: CT_TURRET_CFG_PASSIVE | CT_TURRET_CFG_SHOT_IS_FORCE,
                target_rescore_period_ticks: 16,
                relationship_mask: CT_LOCK_ON_REL_INCLUDE_ENEMY,
                family_mask: CT_LOCK_ON_FAM_INCLUDE_TURRETS,
                turret_mask: 1u32 << TURRET_CODE_A,
                reciprocal_mode: CT_LOCK_ON_RECIPROCAL_REQUIRE,
                ..TurretSpec::default()
            },
        );
        stamp_turret_target_with_target_id(1, 201, PLAYER_2, 40.0, &[TURRET_CODE_A], SOURCE_ID);
        stamp_turret_target_with_target_id(2, 202, PLAYER_2, 20.0, &[TURRET_CODE_A], SOURCE_ID);
        stamp_turret_target_with_target_id(3, 203, PLAYER_2, 10.0, &[TURRET_CODE_B], SOURCE_ID);
        {
            let pool = combat_targeting_pool();
            pool.turret_dps[combat_targeting_turret_global_idx(1, 0)] = 20.0;
            pool.turret_dps[combat_targeting_turret_global_idx(2, 0)] = 20.0;
            pool.turret_dps[combat_targeting_turret_global_idx(3, 0)] = 100.0;
        }

        let on_refresh = run_schedule_tick_at(1, 4);
        assert_eq!(
            on_refresh.0, 201,
            "equal-DPS valid threats must not churn the lock, and excluded turret blueprints must remain ineligible",
        );
        assert_eq!(on_refresh.1, CT_TURRET_STATE_ENGAGED);
    }

    #[test]
    pub(crate) fn shield_panel_policy_locks_enemy_turret_targeting_panel_turret() {
        let _guard = lock_tests();
        reset_pools();
        stamp_source(-1);
        stamp_turret(
            SOURCE_SLOT,
            0,
            TurretSpec {
                flags: CT_TURRET_CFG_PASSIVE | CT_TURRET_CFG_SHOT_IS_FORCE,
                relationship_mask: CT_LOCK_ON_REL_INCLUDE_ENEMY,
                family_mask: CT_LOCK_ON_FAM_INCLUDE_TURRETS,
                reciprocal_mode: CT_LOCK_ON_RECIPROCAL_REQUIRE,
                ..TurretSpec::default()
            },
        );
        let source_panel_turret_id = test_turret_entity_id(SOURCE_ID, 0);
        stamp_turret_target_with_target_id(
            1,
            201,
            PLAYER_2,
            20.0,
            &[TURRET_CODE_A],
            source_panel_turret_id,
        );

        let (target_id, state, _) = run_schedule_tick(1);
        assert_eq!(
            target_id, 201,
            "shield panels must react to turrets targeting the panel turret itself",
        );
        assert_ne!(state, CT_TURRET_STATE_IDLE);
    }

    #[test]
    pub(crate) fn shield_panel_policy_ignores_enemy_turret_targeting_elsewhere() {
        let _guard = lock_tests();
        reset_pools();
        stamp_source(-1);
        stamp_turret(
            SOURCE_SLOT,
            0,
            TurretSpec {
                flags: CT_TURRET_CFG_PASSIVE | CT_TURRET_CFG_SHOT_IS_FORCE,
                relationship_mask: CT_LOCK_ON_REL_INCLUDE_ENEMY,
                family_mask: CT_LOCK_ON_FAM_INCLUDE_TURRETS,
                reciprocal_mode: CT_LOCK_ON_RECIPROCAL_REQUIRE,
                ..TurretSpec::default()
            },
        );
        stamp_turret_target_with_target_id(1, 201, PLAYER_2, 20.0, &[TURRET_CODE_A], 999_999);

        let (target_id, state, _) = run_schedule_tick(1);
        assert_eq!(
            target_id, -1,
            "shield panels must not lock onto turrets that are not targeting the host or panel",
        );
        assert_eq!(state, CT_TURRET_STATE_IDLE);
    }

    #[test]
    pub(crate) fn reciprocal_require_admits_only_targets_locked_onto_source() {
        let _guard = lock_tests();
        reset_pools();
        stamp_source(-1);
        stamp_turret(
            SOURCE_SLOT,
            0,
            TurretSpec {
                relationship_mask: CT_LOCK_ON_REL_INCLUDE_ENEMY,
                family_mask: CT_LOCK_ON_FAM_INCLUDE_UNITS,
                reciprocal_mode: CT_LOCK_ON_RECIPROCAL_REQUIRE,
                ..TurretSpec::default()
            },
        );
        stamp_turret_target_with_target_id(1, 201, PLAYER_2, 20.0, &[TURRET_CODE_A], 999_999);
        stamp_turret_target_with_target_id(2, 202, PLAYER_2, 30.0, &[TURRET_CODE_A], SOURCE_ID);

        let (target_id, state, _) = run_schedule_tick(1);
        assert_eq!(
            target_id, 202,
            "require mode must skip closer enemies not locked onto the source",
        );
        assert_ne!(state, CT_TURRET_STATE_IDLE);
    }

    #[test]
    pub(crate) fn reciprocal_require_drops_existing_lock_when_target_reaims() {
        let _guard = lock_tests();
        reset_pools();
        stamp_source(-1);
        stamp_turret(
            SOURCE_SLOT,
            0,
            TurretSpec {
                state: CT_TURRET_STATE_ENGAGED,
                target_id: 201,
                relationship_mask: CT_LOCK_ON_REL_INCLUDE_ENEMY,
                family_mask: CT_LOCK_ON_FAM_INCLUDE_UNITS,
                reciprocal_mode: CT_LOCK_ON_RECIPROCAL_REQUIRE,
                ..TurretSpec::default()
            },
        );
        stamp_turret_target_with_target_id(1, 201, PLAYER_2, 20.0, &[TURRET_CODE_A], 999_999);

        let (target_id, state, _) = run_schedule_tick(1);
        assert_eq!(target_id, -1);
        assert_eq!(state, CT_TURRET_STATE_IDLE);
    }

    #[test]
    pub(crate) fn reciprocal_preference_modes_strictly_tier_threats_above_non_threats() {
        let _guard = lock_tests();

        for reciprocal_mode in [
            CT_LOCK_ON_RECIPROCAL_PREFER_REACQUIRE,
            CT_LOCK_ON_RECIPROCAL_PREFER_HOLD,
        ] {
            reset_pools();
            stamp_source(-1);
            stamp_turret(
                SOURCE_SLOT,
                0,
                TurretSpec {
                    relationship_mask: CT_LOCK_ON_REL_INCLUDE_ENEMY,
                    family_mask: CT_LOCK_ON_FAM_INCLUDE_UNITS,
                    reciprocal_mode,
                    ..TurretSpec::default()
                },
            );
            stamp_body_target(
                1,
                201,
                PLAYER_2,
                20.0,
                CT_ENTITY_FAMILY_UNIT,
                BODY_UNIT_CODE_A,
            );
            stamp_turret_target_with_target_id(2, 202, PLAYER_2, 40.0, &[TURRET_CODE_A], SOURCE_ID);
            let (target_id, _, _) = run_schedule_tick(1);
            assert_eq!(
                target_id, 202,
                "preference modes must choose an incoming threat over a closer non-threat",
            );

            reset_pools();
            stamp_source(-1);
            stamp_turret(
                SOURCE_SLOT,
                0,
                TurretSpec {
                    relationship_mask: CT_LOCK_ON_REL_INCLUDE_ENEMY,
                    family_mask: CT_LOCK_ON_FAM_INCLUDE_UNITS,
                    reciprocal_mode,
                    ..TurretSpec::default()
                },
            );
            stamp_body_target(
                1,
                203,
                PLAYER_2,
                20.0,
                CT_ENTITY_FAMILY_UNIT,
                BODY_UNIT_CODE_A,
            );
            stamp_body_target(
                2,
                204,
                PLAYER_2,
                40.0,
                CT_ENTITY_FAMILY_UNIT,
                BODY_UNIT_CODE_B,
            );
            let (target_id, _, _) = run_schedule_tick(1);
            assert_eq!(
                target_id, 203,
                "preference modes must fall back to normal scoring when no threat exists",
            );
        }
    }

    #[test]
    pub(crate) fn reciprocal_prefer_reacquire_replaces_non_threat_current_target() {
        let _guard = lock_tests();

        reset_pools();
        stamp_source(-1);
        stamp_turret(
            SOURCE_SLOT,
            0,
            TurretSpec {
                state: CT_TURRET_STATE_ENGAGED,
                target_id: 201,
                relationship_mask: CT_LOCK_ON_REL_INCLUDE_ENEMY,
                family_mask: CT_LOCK_ON_FAM_INCLUDE_UNITS,
                reciprocal_mode: CT_LOCK_ON_RECIPROCAL_PREFER_REACQUIRE,
                ..TurretSpec::default()
            },
        );
        stamp_turret_target_with_target_id(1, 201, PLAYER_2, 20.0, &[TURRET_CODE_A], 999_999);
        stamp_turret_target_with_target_id(2, 202, PLAYER_2, 40.0, &[TURRET_CODE_A], SOURCE_ID);

        let (target_id, state, _) = run_schedule_tick(1);
        assert_eq!(
            target_id, 202,
            "preferReacquire must rescan away from a current target that stopped reciprocating",
        );
        assert_ne!(state, CT_TURRET_STATE_IDLE);
    }

    #[test]
    pub(crate) fn reciprocal_prefer_hold_keeps_non_threat_current_target() {
        let _guard = lock_tests();

        reset_pools();
        stamp_source(-1);
        stamp_turret(
            SOURCE_SLOT,
            0,
            TurretSpec {
                state: CT_TURRET_STATE_ENGAGED,
                target_id: 201,
                relationship_mask: CT_LOCK_ON_REL_INCLUDE_ENEMY,
                family_mask: CT_LOCK_ON_FAM_INCLUDE_UNITS,
                reciprocal_mode: CT_LOCK_ON_RECIPROCAL_PREFER_HOLD,
                ..TurretSpec::default()
            },
        );
        stamp_turret_target_with_target_id(1, 201, PLAYER_2, 20.0, &[TURRET_CODE_A], 999_999);
        stamp_turret_target_with_target_id(2, 202, PLAYER_2, 40.0, &[TURRET_CODE_A], SOURCE_ID);

        let (target_id, state, _) = run_schedule_tick(1);
        assert_eq!(
            target_id, 201,
            "preferHold must not rescan solely because the current target stopped reciprocating",
        );
        assert_eq!(state, CT_TURRET_STATE_ENGAGED);
    }

    #[test]
    pub(crate) fn level1_body_inclusions_allow_only_matching_blueprints() {
        // Level-1 named masks are a whitelist within an included family:
        // only the named blueprint codes are lockable, every other code in
        // the family is rejected.
        let _guard = lock_tests();

        reset_pools();
        stamp_source(-1);
        stamp_turret(
            SOURCE_SLOT,
            0,
            TurretSpec {
                unit_mask: 1u32 << BODY_UNIT_CODE_A,
                relationship_mask: CT_LOCK_ON_REL_INCLUDE_ENEMY,
                ..TurretSpec::default()
            },
        );
        stamp_body_target(
            1,
            201,
            PLAYER_2,
            10.0,
            CT_ENTITY_FAMILY_UNIT,
            BODY_UNIT_CODE_A,
        );
        stamp_body_target(
            2,
            202,
            PLAYER_2,
            20.0,
            CT_ENTITY_FAMILY_UNIT,
            BODY_UNIT_CODE_B,
        );
        let (target_id, _, _) = run_schedule_tick(1);
        assert_eq!(
            target_id, 201,
            "unit named inclusion should allow only code A"
        );

        reset_pools();
        stamp_source(-1);
        stamp_turret(
            SOURCE_SLOT,
            0,
            TurretSpec {
                building_mask: 1u32 << BODY_BUILDING_CODE_A,
                relationship_mask: CT_LOCK_ON_REL_INCLUDE_ENEMY,
                ..TurretSpec::default()
            },
        );
        stamp_body_target(
            1,
            203,
            PLAYER_2,
            10.0,
            CT_ENTITY_FAMILY_BUILDING,
            BODY_BUILDING_CODE_A,
        );
        stamp_body_target(
            2,
            204,
            PLAYER_2,
            20.0,
            CT_ENTITY_FAMILY_BUILDING,
            BODY_BUILDING_CODE_B,
        );
        let (target_id, _, _) = run_schedule_tick(1);
        assert_eq!(
            target_id, 203,
            "building named inclusion should allow only code A"
        );

        reset_pools();
        stamp_source(-1);
        stamp_turret(
            SOURCE_SLOT,
            0,
            TurretSpec {
                shot_mask: 1u32 << SHOT_CODE_A,
                relationship_mask: CT_LOCK_ON_REL_INCLUDE_ENEMY,
                ..TurretSpec::default()
            },
        );
        stamp_body_target(1, 207, PLAYER_2, 10.0, CT_ENTITY_FAMILY_SHOT, SHOT_CODE_A);
        stamp_body_target(2, 208, PLAYER_2, 20.0, CT_ENTITY_FAMILY_SHOT, SHOT_CODE_B);
        let (target_id, _, _) = run_schedule_tick(1);
        assert_eq!(
            target_id, 207,
            "shot named inclusion should allow only code A"
        );
    }

    #[test]
    pub(crate) fn level1_turret_inclusions_filter_individual_mounted_turrets() {
        // The turret named mask whitelists turret code B, so a host is
        // lockable only if it mounts a B turret; a host that mounts only
        // the un-whitelisted A turret is rejected.
        let _guard = lock_tests();
        reset_pools();
        stamp_source(-1);
        stamp_turret(
            SOURCE_SLOT,
            0,
            TurretSpec {
                turret_mask: 1u32 << TURRET_CODE_B,
                relationship_mask: CT_LOCK_ON_REL_INCLUDE_ENEMY,
                family_mask: CT_LOCK_ON_FAM_INCLUDE_TURRETS,
                ..TurretSpec::default()
            },
        );
        stamp_turret_target(1, 201, PLAYER_2, 10.0, &[TURRET_CODE_A], false);
        stamp_turret_target(
            2,
            202,
            PLAYER_2,
            20.0,
            &[TURRET_CODE_A, TURRET_CODE_B],
            false,
        );

        let (target_id, state, _) = run_schedule_tick(1);
        assert_eq!(target_id, 202);
        assert_ne!(state, CT_TURRET_STATE_IDLE);
    }

    #[test]
    pub(crate) fn priority_and_existing_locks_respect_relationship_inclusions() {
        let _guard = lock_tests();

        reset_pools();
        stamp_source(201);
        stamp_turret(
            SOURCE_SLOT,
            0,
            TurretSpec {
                relationship_mask: CT_LOCK_ON_REL_INCLUDE_ENEMY,
                ..TurretSpec::default()
            },
        );
        stamp_body_target(
            1,
            201,
            PLAYER_1,
            20.0,
            CT_ENTITY_FAMILY_UNIT,
            BODY_UNIT_CODE_A,
        );
        let (target_id, _, mode) = run_schedule_tick(1);
        assert_eq!(mode, CT_TARGETING_TICK_MODE_AUTO);
        assert_eq!(
            target_id, -1,
            "priority target cannot override relationship policy"
        );

        reset_pools();
        stamp_source(202);
        stamp_turret(
            SOURCE_SLOT,
            0,
            TurretSpec {
                relationship_mask: CT_LOCK_ON_REL_INCLUDE_ENEMY,
                ..TurretSpec::default()
            },
        );
        stamp_body_target(
            1,
            202,
            PLAYER_2,
            20.0,
            CT_ENTITY_FAMILY_UNIT,
            BODY_UNIT_CODE_A,
        );
        let (target_id, state, mode) = run_schedule_tick(1);
        assert_eq!(mode, CT_TARGETING_TICK_MODE_PRIORITY_TARGET);
        assert_eq!(target_id, 202);
        assert_ne!(state, CT_TURRET_STATE_IDLE);

        reset_pools();
        stamp_source(-1);
        stamp_turret(
            SOURCE_SLOT,
            0,
            TurretSpec {
                state: CT_TURRET_STATE_ENGAGED,
                target_id: 203,
                relationship_mask: CT_LOCK_ON_REL_INCLUDE_ENEMY,
                ..TurretSpec::default()
            },
        );
        stamp_body_target(
            1,
            203,
            PLAYER_1,
            20.0,
            CT_ENTITY_FAMILY_UNIT,
            BODY_UNIT_CODE_A,
        );
        let (target_id, _, _) = run_schedule_tick(1);
        assert_eq!(
            target_id, -1,
            "existing lock must be dropped when policy excludes the target"
        );

        reset_pools();
        stamp_source(-1);
        stamp_turret(
            SOURCE_SLOT,
            0,
            TurretSpec {
                state: CT_TURRET_STATE_ENGAGED,
                target_id: 204,
                relationship_mask: CT_LOCK_ON_REL_INCLUDE_ENEMY,
                ..TurretSpec::default()
            },
        );
        stamp_body_target(
            1,
            204,
            PLAYER_2,
            20.0,
            CT_ENTITY_FAMILY_UNIT,
            BODY_UNIT_CODE_A,
        );
        let (target_id, state, _) = run_schedule_tick(1);
        assert_eq!(target_id, 204);
        assert_ne!(state, CT_TURRET_STATE_IDLE);
    }

    #[test]
    pub(crate) fn priority_target_respects_host_level_inclusions() {
        let _guard = lock_tests();

        // Host includes friendly only (every family), so an enemy priority
        // target is outside the host's relationship inclusions.
        reset_pools();
        stamp_entity_with_host_lockon(
            SOURCE_SLOT,
            SOURCE_ID,
            PLAYER_1,
            0.0,
            CT_ENTITY_FAMILY_UNIT,
            SOURCE_UNIT_CODE,
            1,
            201,
            CT_LOCK_ON_REL_INCLUDE_FRIENDLY,
            FAM_ALL,
            0,
            0,
            0,
            0,
            0,
        );
        stamp_turret(SOURCE_SLOT, 0, TurretSpec::default());
        stamp_body_target(
            1,
            201,
            PLAYER_2,
            20.0,
            CT_ENTITY_FAMILY_UNIT,
            BODY_UNIT_CODE_A,
        );
        let (_, _, mode) = run_schedule_tick(1);
        assert_eq!(
            mode, CT_TARGETING_TICK_MODE_AUTO,
            "host relationship inclusions must prevent priority-target mode"
        );

        // Host includes both relationships but every family except units,
        // so a unit priority target is outside the host's family inclusions.
        reset_pools();
        stamp_entity_with_host_lockon(
            SOURCE_SLOT,
            SOURCE_ID,
            PLAYER_1,
            0.0,
            CT_ENTITY_FAMILY_UNIT,
            SOURCE_UNIT_CODE,
            1,
            202,
            REL_ALL,
            FAM_ALL_BUT_UNITS,
            0,
            0,
            0,
            0,
            0,
        );
        stamp_turret(SOURCE_SLOT, 0, TurretSpec::default());
        stamp_body_target(
            1,
            202,
            PLAYER_2,
            20.0,
            CT_ENTITY_FAMILY_UNIT,
            BODY_UNIT_CODE_A,
        );
        let (_, _, mode) = run_schedule_tick(1);
        assert_eq!(
            mode, CT_TARGETING_TICK_MODE_AUTO,
            "host family inclusions must prevent priority-target mode"
        );
    }

    #[test]
    pub(crate) fn priority_target_overwrites_host_controlled_but_not_autonomous() {
        let _guard = lock_tests();

        reset_pools();
        stamp_entity(
            SOURCE_SLOT,
            SOURCE_ID,
            PLAYER_1,
            0.0,
            CT_ENTITY_FAMILY_UNIT,
            SOURCE_UNIT_CODE,
            2,
            201,
        );
        stamp_turret(
            SOURCE_SLOT,
            0,
            TurretSpec {
                state: CT_TURRET_STATE_ENGAGED,
                target_id: 202,
                flags: 0,
                ..TurretSpec::default()
            },
        );
        stamp_turret(SOURCE_SLOT, 1, TurretSpec::default());
        stamp_body_target(
            1,
            201,
            PLAYER_2,
            20.0,
            CT_ENTITY_FAMILY_UNIT,
            BODY_UNIT_CODE_A,
        );
        stamp_body_target(
            2,
            202,
            PLAYER_2,
            30.0,
            CT_ENTITY_FAMILY_UNIT,
            BODY_UNIT_CODE_B,
        );

        let (_, _, mode) = run_schedule_tick(1);
        assert_eq!(mode, CT_TARGETING_TICK_MODE_PRIORITY_TARGET);

        let autonomous = read_turret_lock(0);
        assert_eq!(
            autonomous.0, 202,
            "autonomous turret must keep its independent lock"
        );
        assert_ne!(autonomous.1, CT_TURRET_STATE_IDLE);

        let host_controlled = read_turret_lock(1);
        assert_eq!(
            host_controlled.0, 201,
            "host-controlled turret must inherit the host priority target"
        );
        assert_ne!(host_controlled.1, CT_TURRET_STATE_IDLE);
    }

    #[test]
    pub(crate) fn host_controlled_turret_keeps_priority_target_while_fire_path_is_blocked() {
        let _guard = lock_tests();

        reset_pools();
        stamp_source(201);
        stamp_turret(SOURCE_SLOT, 0, TurretSpec::default());
        stamp_body_target(
            1,
            201,
            PLAYER_2,
            20.0,
            CT_ENTITY_FAMILY_UNIT,
            BODY_UNIT_CODE_A,
        );

        combat_targeting_apply_priority_target_fsm_batch(
            SOURCE_SLOT,
            201,
            &[1],
            &[1],
            &[0],
            &[1],
            &[1],
        );

        let host_controlled = read_turret_lock(0);
        assert_eq!(
            host_controlled.0, 201,
            "host-overridden turret lock id must mirror the host order through LOS obstruction",
        );
        assert_eq!(
            host_controlled.1, CT_TURRET_STATE_TRACKING,
            "blocked host target must be tracked without firing",
        );
    }

    #[test]
    pub(crate) fn incompatible_priority_mount_acquires_its_own_fallback() {
        let _guard = lock_tests();

        reset_pools();
        stamp_entity(
            SOURCE_SLOT,
            SOURCE_ID,
            PLAYER_1,
            0.0,
            CT_ENTITY_FAMILY_UNIT,
            SOURCE_UNIT_CODE,
            2,
            201,
        );
        stamp_turret(
            SOURCE_SLOT,
            0,
            TurretSpec {
                unit_mask: 1 << BODY_UNIT_CODE_A,
                ..TurretSpec::default()
            },
        );
        stamp_turret(
            SOURCE_SLOT,
            1,
            TurretSpec {
                unit_mask: 1 << BODY_UNIT_CODE_B,
                ..TurretSpec::default()
            },
        );
        stamp_body_target(
            1,
            201,
            PLAYER_2,
            20.0,
            CT_ENTITY_FAMILY_UNIT,
            BODY_UNIT_CODE_A,
        );
        stamp_body_target(
            2,
            202,
            PLAYER_2,
            30.0,
            CT_ENTITY_FAMILY_UNIT,
            BODY_UNIT_CODE_B,
        );

        let (_, _, mode) = run_schedule_tick(1);
        assert_eq!(mode, CT_TARGETING_TICK_MODE_PRIORITY_TARGET);
        assert_eq!(read_turret_lock(0).0, 201);
        assert_eq!(
            read_turret_lock(1).0,
            202,
            "a sibling that rejects the host task must auto-acquire independently",
        );
    }

    #[test]
    pub(crate) fn slaved_mount_inherits_master_target_but_runs_its_own_gates() {
        let _guard = lock_tests();
        reset_pools();
        stamp_entity(
            SOURCE_SLOT,
            SOURCE_ID,
            PLAYER_1,
            0.0,
            CT_ENTITY_FAMILY_UNIT,
            SOURCE_UNIT_CODE,
            3,
            -1,
        );
        stamp_turret(
            SOURCE_SLOT,
            0,
            TurretSpec {
                state: CT_TURRET_STATE_ENGAGED,
                target_id: 201,
                flags: 0,
                ..TurretSpec::default()
            },
        );
        stamp_turret(
            SOURCE_SLOT,
            1,
            TurretSpec {
                flags: CT_TURRET_CFG_NO_AUTO_ACQUIRE,
                slaved_to_mount_index: 0,
                ..TurretSpec::default()
            },
        );
        stamp_turret(
            SOURCE_SLOT,
            2,
            TurretSpec {
                flags: CT_TURRET_CFG_NO_AUTO_ACQUIRE,
                family_mask: CT_LOCK_ON_FAM_INCLUDE_BUILDINGS,
                slaved_to_mount_index: 0,
                ..TurretSpec::default()
            },
        );
        stamp_body_target(
            1,
            201,
            PLAYER_2,
            20.0,
            CT_ENTITY_FAMILY_UNIT,
            BODY_UNIT_CODE_A,
        );

        let (_, _, mode) = run_schedule_tick(1);
        assert_eq!(mode, CT_TARGETING_TICK_MODE_AUTO);
        assert_eq!(
            read_turret_lock(1).0,
            201,
            "compatible slave must inherit the master's selected entity"
        );
        assert_eq!(
            read_turret_lock(2),
            (-1, CT_TURRET_STATE_IDLE),
            "slave intent must still pass the slave mount's own lock-on gates"
        );
    }

    #[test]
    pub(crate) fn host_only_mount_has_no_autonomous_fallback() {
        let _guard = lock_tests();
        reset_pools();
        stamp_source(201);
        stamp_turret(
            SOURCE_SLOT,
            0,
            TurretSpec {
                flags: CT_TURRET_CFG_HOST_CONTROLLED | CT_TURRET_CFG_NO_AUTO_ACQUIRE,
                unit_mask: 1 << BODY_UNIT_CODE_B,
                ..TurretSpec::default()
            },
        );
        stamp_body_target(
            1,
            201,
            PLAYER_2,
            20.0,
            CT_ENTITY_FAMILY_UNIT,
            BODY_UNIT_CODE_A,
        );
        stamp_body_target(
            2,
            202,
            PLAYER_2,
            30.0,
            CT_ENTITY_FAMILY_UNIT,
            BODY_UNIT_CODE_B,
        );

        let (target_id, state, mode) = run_schedule_tick(1);
        assert_eq!(mode, CT_TARGETING_TICK_MODE_AUTO);
        assert_eq!(target_id, -1);
        assert_eq!(
            state, CT_TURRET_STATE_IDLE,
            "hostOnly must idle when its host task is ineligible, even when an eligible fallback exists"
        );
    }

    #[test]
    pub(crate) fn underwater_to_air_emission_uses_team_air_radar_or_sight() {
        let _guard = lock_tests();
        for (requires_full_sight, label) in [(false, "radar"), (true, "full sight")] {
            reset_pools();
            stamp_entity_at_z(
                SOURCE_SLOT,
                SOURCE_ID,
                PLAYER_1,
                0.0,
                TERRAIN_WATER_LEVEL - 10.0,
                CT_ENTITY_FAMILY_UNIT,
                SOURCE_UNIT_CODE,
                1,
                -1,
            );
            stamp_turret(
                SOURCE_SLOT,
                0,
                TurretSpec {
                    flags: CT_TURRET_CFG_HOST_CONTROLLED
                        | if requires_full_sight {
                            CT_TURRET_CFG_REQUIRES_FULL_SIGHT
                        } else {
                            0
                        },
                    relationship_mask: CT_LOCK_ON_REL_INCLUDE_ENEMY,
                    ..TurretSpec::default()
                },
            );
            stamp_body_target_at_z(
                1,
                201,
                PLAYER_2,
                100.0,
                TERRAIN_WATER_LEVEL + 3.0,
                CT_ENTITY_FAMILY_UNIT,
                BODY_UNIT_CODE_A,
            );
            // An allied observer above water supplies the relevant team-air
            // fact. The underwater weapon host has no local sensor coverage.
            stamp_entity_at_z(
                2,
                301,
                PLAYER_1,
                90.0,
                TERRAIN_WATER_LEVEL + 10.0,
                CT_ENTITY_FAMILY_UNIT,
                BODY_UNIT_CODE_B,
                0,
                -1,
            );
            {
                let pool = combat_targeting_pool();
                for slot in [SOURCE_SLOT as usize, 2] {
                    pool.entity_full_vision_above_water_radius[slot] = 0.0;
                    pool.entity_full_vision_underwater_radius[slot] = 0.0;
                    pool.entity_radar_radius[slot] = 0.0;
                    pool.entity_sonar_radius[slot] = 0.0;
                }
                if requires_full_sight {
                    pool.entity_full_vision_above_water_radius[2] = 30.0;
                } else {
                    pool.entity_radar_radius[2] = 30.0;
                }
                let turret_idx = combat_targeting_turret_global_idx(SOURCE_SLOT, 0);
                pool.turret_config_flags[turret_idx] = (pool.turret_config_flags[turret_idx]
                    & !CT_TURRET_CFG_ROUTE_MASK)
                    | CT_TURRET_CFG_ROUTE_UNDERWATER_TO_ABOVE;
            }

            let (target_id, state, _) = run_schedule_tick(1);
            assert_eq!(target_id, 201, "W->A must accept allied team-air {label}");
            assert_ne!(state, CT_TURRET_STATE_IDLE);
            let pool = combat_targeting_pool();
            let owner_bit = combat_targeting_player_bit(PLAYER_1);
            if requires_full_sight {
                assert_ne!(pool.entity_team_air_sight_mask[1] & owner_bit, 0);
                assert_eq!(pool.entity_team_air_radar_mask[1] & owner_bit, 0);
            } else {
                assert_ne!(pool.entity_team_air_radar_mask[1] & owner_bit, 0);
                assert_eq!(pool.entity_team_air_sight_mask[1] & owner_bit, 0);
            }
            assert_eq!(pool.entity_team_water_sight_mask[1] & owner_bit, 0);
            assert_eq!(pool.entity_team_water_sonar_mask[1] & owner_bit, 0);
        }
    }

    #[test]
    pub(crate) fn full_sight_weapon_can_engage_from_allied_sensor_intelligence() {
        let _guard = lock_tests();
        reset_pools();
        stamp_source(-1);
        stamp_turret(
            SOURCE_SLOT,
            0,
            TurretSpec {
                flags: CT_TURRET_CFG_REQUIRES_FULL_SIGHT,
                relationship_mask: CT_LOCK_ON_REL_INCLUDE_ENEMY,
                ..TurretSpec::default()
            },
        );
        stamp_body_target(
            1,
            201,
            PLAYER_2,
            100.0,
            CT_ENTITY_FAMILY_UNIT,
            BODY_UNIT_CODE_A,
        );
        stamp_entity(
            2,
            301,
            PLAYER_1,
            90.0,
            CT_ENTITY_FAMILY_UNIT,
            BODY_UNIT_CODE_B,
            0,
            -1,
        );
        {
            let pool = combat_targeting_pool();
            // The weapon host cannot see the target itself. The allied scout
            // supplies the full-sight bit to the same team view mask.
            pool.entity_full_vision_above_water_radius[SOURCE_SLOT as usize] = 10.0;
            pool.entity_full_vision_underwater_radius[SOURCE_SLOT as usize] = 10.0;
            pool.entity_radar_radius[SOURCE_SLOT as usize] = 0.0;
            pool.entity_sonar_radius[SOURCE_SLOT as usize] = 0.0;
            pool.entity_full_vision_above_water_radius[2] = 30.0;
            pool.entity_full_vision_underwater_radius[2] = 30.0;
        }

        let (target_id, state, _) = run_schedule_tick(1);
        assert_eq!(target_id, 201);
        assert_ne!(
            state, CT_TURRET_STATE_IDLE,
            "engagement range and local observation range are independent; allied full sight may authorize the shot"
        );
    }

    #[test]
    pub(crate) fn radar_contact_authorizes_contact_weapon_but_not_full_sight_weapon() {
        let _guard = lock_tests();

        reset_pools();
        stamp_source(-1);
        stamp_turret(SOURCE_SLOT, 0, TurretSpec::default());
        stamp_body_target(
            1,
            201,
            PLAYER_2,
            100.0,
            CT_ENTITY_FAMILY_UNIT,
            BODY_UNIT_CODE_A,
        );
        {
            let pool = combat_targeting_pool();
            pool.entity_full_vision_underwater_radius[SOURCE_SLOT as usize] = 10.0;
            pool.entity_sonar_radius[SOURCE_SLOT as usize] = 120.0;
        }
        let contact_lock = run_schedule_tick(1);
        assert_eq!(
            contact_lock.0, 201,
            "contactSight weapons may fire from the team's radar/sonar-quality contact"
        );

        reset_pools();
        stamp_source(-1);
        stamp_turret(
            SOURCE_SLOT,
            0,
            TurretSpec {
                flags: CT_TURRET_CFG_REQUIRES_FULL_SIGHT,
                ..TurretSpec::default()
            },
        );
        stamp_body_target(
            1,
            201,
            PLAYER_2,
            100.0,
            CT_ENTITY_FAMILY_UNIT,
            BODY_UNIT_CODE_A,
        );
        {
            let pool = combat_targeting_pool();
            pool.entity_full_vision_underwater_radius[SOURCE_SLOT as usize] = 10.0;
            pool.entity_sonar_radius[SOURCE_SLOT as usize] = 120.0;
        }
        let full_sight_lock = run_schedule_tick(1);
        assert_eq!(full_sight_lock.0, -1);
        assert_eq!(
            full_sight_lock.1, CT_TURRET_STATE_IDLE,
            "fullSight weapons must not promote a radar/sonar contact into visual identification"
        );
    }
}

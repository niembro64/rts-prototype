use super::*;

#[cfg(test)]
mod sim_kernel_tests {
    use super::*;
    use std::sync::MutexGuard;

    pub(crate) fn lock_tests() -> MutexGuard<'static, ()> {
        match super::COMBAT_TARGETING_TEST_LOCK.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        }
    }

    #[test]
    pub(crate) fn emission_medium_routes_exhaustively_gate_source_and_target_media() {
        let above_source = TERRAIN_WATER_LEVEL + 0.001;
        let underwater_source = TERRAIN_WATER_LEVEL;
        let above_body = CombatTargetingCylinderTarget {
            horizontal_dist_sq: 0.0,
            horizontal_radius: 1.0,
            bottom_z: TERRAIN_WATER_LEVEL,
            top_z: TERRAIN_WATER_LEVEL + 20.0,
            is_point: false,
        };
        let underwater_body = CombatTargetingCylinderTarget {
            bottom_z: TERRAIN_WATER_LEVEL - 20.0,
            top_z: TERRAIN_WATER_LEVEL,
            ..above_body
        };
        let straddling_body = CombatTargetingCylinderTarget {
            bottom_z: TERRAIN_WATER_LEVEL - 10.0,
            top_z: TERRAIN_WATER_LEVEL + 10.0,
            ..above_body
        };
        let surface_point = CombatTargetingCylinderTarget {
            bottom_z: TERRAIN_WATER_LEVEL,
            top_z: TERRAIN_WATER_LEVEL,
            is_point: true,
            ..above_body
        };

        let cases = [
            (
                CT_TURRET_CFG_ROUTE_ABOVE_TO_ABOVE,
                above_source,
                above_body,
                "A->A",
            ),
            (
                CT_TURRET_CFG_ROUTE_ABOVE_TO_UNDERWATER,
                above_source,
                underwater_body,
                "A->W",
            ),
            (
                CT_TURRET_CFG_ROUTE_UNDERWATER_TO_ABOVE,
                underwater_source,
                above_body,
                "W->A",
            ),
            (
                CT_TURRET_CFG_ROUTE_UNDERWATER_TO_UNDERWATER,
                underwater_source,
                underwater_body,
                "W->W",
            ),
        ];
        for (route, source_z, target, label) in cases {
            assert!(
                combat_targeting_flags_allow_target_medium(route, source_z, target),
                "{label} must admit its exact authored cell",
            );
            assert!(
                combat_targeting_flags_allow_target_medium(route, source_z, straddling_body),
                "{label} must admit a unit/building occupying both target media",
            );
            for (other_route, _, _, other_label) in cases {
                if route == other_route {
                    continue;
                }
                assert!(
                    !combat_targeting_flags_allow_target_medium(
                        route,
                        if other_label.starts_with('A') {
                            above_source
                        } else {
                            underwater_source
                        },
                        if other_label.ends_with('A') {
                            above_body
                        } else {
                            underwater_body
                        },
                    ),
                    "{label} must not imply {other_label}",
                );
            }
        }
        assert!(!combat_targeting_flags_allow_target_medium(
            0,
            above_source,
            straddling_body,
        ));
        assert!(combat_targeting_flags_allow_target_medium(
            CT_TURRET_CFG_ROUTE_UNDERWATER_TO_UNDERWATER,
            underwater_source,
            surface_point,
        ));
        assert!(!combat_targeting_flags_allow_target_medium(
            CT_TURRET_CFG_ROUTE_UNDERWATER_TO_ABOVE,
            underwater_source,
            surface_point,
        ));
        assert_eq!(
            combat_targeting_target_underwater_fraction(
                CT_ENTITY_FAMILY_SHOT,
                TERRAIN_WATER_LEVEL + 0.001,
                100.0,
                0.0,
            ),
            0.0,
            "a shot is an above-water point even when its collision radius crosses the surface",
        );
        assert_eq!(
            combat_targeting_target_underwater_fraction(
                CT_ENTITY_FAMILY_SHOT,
                TERRAIN_WATER_LEVEL,
                100.0,
                0.0,
            ),
            1.0,
            "a shot point exactly on the surface is underwater",
        );
        let partial_unit_fraction = combat_targeting_target_underwater_fraction(
            CT_ENTITY_FAMILY_UNIT,
            TERRAIN_WATER_LEVEL,
            10.0,
            0.0,
        );
        assert!(
            partial_unit_fraction > 0.0 && partial_unit_fraction < 1.0,
            "a unit body crossing the surface must occupy both media",
        );
    }

    #[test]
    pub(crate) fn wind_sample_state_writes_deterministic_vector() {
        let mut a = [0.0; 5];
        let mut b = [0.0; 5];
        assert_eq!(wind_sample_state(12_345.0, &mut a), 1);
        assert_eq!(wind_sample_state(12_345.0, &mut b), 1);
        assert_eq!(a, b);
        assert!(a[3] >= WIND_SPEED_MIN);
        assert!(
            a[3] <= WIND_SPEED_MAX
                * (1.0
                    + WIND_VERTICAL_MAX_FRACTION_OF_HORIZONTAL_SPEED
                        * WIND_VERTICAL_MAX_FRACTION_OF_HORIZONTAL_SPEED)
                    .sqrt()
        );

        let mut short = [0.0; 4];
        assert_eq!(wind_sample_state(0.0, &mut short), 0);
        assert_eq!(wind_sample_state(f64::NAN, &mut a), 0);
    }

    #[test]
    pub(crate) fn projectile_reflection_response_preserves_speed_and_advances_remainder() {
        let enabled = [1_u8];
        let hit_t = [0.25];
        let hit_x = [10.0];
        let hit_y = [20.0];
        let hit_z = [5.0];
        let velocity_x = [4.0];
        let velocity_y = [-3.0];
        let velocity_z = [0.0];
        let normal_x = [0.0];
        let normal_y = [1.0];
        let normal_z = [0.0];
        let surface_velocity_x = [0.0];
        let surface_velocity_y = [0.0];
        let surface_velocity_z = [0.0];
        let radius = [4.0];
        let mut reflected = [0_u8];
        let mut out_x = [0.0];
        let mut out_y = [0.0];
        let mut out_z = [0.0];
        let mut out_vx = [0.0];
        let mut out_vy = [0.0];
        let mut out_vz = [0.0];
        let mut rotation_changed = [0_u8];
        let mut rotation = [0.0];

        assert_eq!(
            projectile_reflection_response_batch(
                1,
                &enabled,
                &hit_t,
                &hit_x,
                &hit_y,
                &hit_z,
                &velocity_x,
                &velocity_y,
                &velocity_z,
                &normal_x,
                &normal_y,
                &normal_z,
                &surface_velocity_x,
                &surface_velocity_y,
                &surface_velocity_z,
                &radius,
                100.0,
                1.0,
                &mut reflected,
                &mut out_x,
                &mut out_y,
                &mut out_z,
                &mut out_vx,
                &mut out_vy,
                &mut out_vz,
                &mut rotation_changed,
                &mut rotation,
            ),
            1,
        );

        assert_eq!(reflected[0], 1);
        assert!((out_vx[0] - 4.0).abs() < 1e-12);
        assert!((out_vy[0] - 3.0).abs() < 1e-12);
        assert!(out_vz[0].abs() < 1e-12);
        assert!((out_x[0] - 10.3).abs() < 1e-12);
        assert!((out_y[0] - 21.225).abs() < 1e-12);
        assert!((out_z[0] - 5.0).abs() < 1e-12);
        assert_eq!(rotation_changed[0], 1);
        assert!((rotation[0] - 3.0_f64.atan2(4.0)).abs() < 1e-12);
    }

    #[test]
    pub(crate) fn projectile_reflection_response_uses_surface_relative_velocity() {
        let enabled = [1_u8];
        let hit_t = [0.5];
        let hit_x = [0.0];
        let hit_y = [0.0];
        let hit_z = [0.0];
        let velocity_x = [0.0];
        let velocity_y = [0.0];
        let velocity_z = [0.0];
        let normal_x = [0.0];
        let normal_y = [1.0];
        let normal_z = [0.0];
        let surface_velocity_x = [0.0];
        let surface_velocity_y = [10.0];
        let surface_velocity_z = [0.0];
        let radius = [0.0];
        let mut reflected = [0_u8];
        let mut out_x = [0.0];
        let mut out_y = [0.0];
        let mut out_z = [0.0];
        let mut out_vx = [0.0];
        let mut out_vy = [0.0];
        let mut out_vz = [0.0];
        let mut rotation_changed = [0_u8];
        let mut rotation = [0.0];

        assert_eq!(
            projectile_reflection_response_batch(
                1,
                &enabled,
                &hit_t,
                &hit_x,
                &hit_y,
                &hit_z,
                &velocity_x,
                &velocity_y,
                &velocity_z,
                &normal_x,
                &normal_y,
                &normal_z,
                &surface_velocity_x,
                &surface_velocity_y,
                &surface_velocity_z,
                &radius,
                100.0,
                1.0,
                &mut reflected,
                &mut out_x,
                &mut out_y,
                &mut out_z,
                &mut out_vx,
                &mut out_vy,
                &mut out_vz,
                &mut rotation_changed,
                &mut rotation,
            ),
            1,
        );

        assert_eq!(reflected[0], 1);
        assert!(out_vx[0].abs() < 1e-12);
        assert!((out_vy[0] - 20.0).abs() < 1e-12);
        assert!(out_vz[0].abs() < 1e-12);
        assert!((out_x[0]).abs() < 1e-12);
        assert!((out_y[0] - 1.5).abs() < 1e-12);
        assert!((out_z[0]).abs() < 1e-12);
    }

    #[test]
    pub(crate) fn projectile_submunition_launch_velocity_reflects_surface_velocity() {
        let mut out_x = [0.0; 2];
        let mut out_y = [0.0; 2];
        let mut out_z = [0.0; 2];

        assert_eq!(
            projectile_submunition_launch_velocity_batch(
                2, 123, 10.0, -2.0, 1.0, 0.0, 1.0, 0.0, 1, 0.5, 0.0, 0.0, &mut out_x, &mut out_y,
                &mut out_z,
            ),
            2,
        );

        assert_eq!(out_x, [5.0, 5.0]);
        assert_eq!(out_y, [1.0, 1.0]);
        assert_eq!(out_z, [0.5, 0.5]);
    }

    #[test]
    pub(crate) fn projectile_submunition_launch_velocity_is_seed_deterministic() {
        let mut ax = [0.0; 4];
        let mut ay = [0.0; 4];
        let mut az = [0.0; 4];
        let mut bx = [0.0; 4];
        let mut by = [0.0; 4];
        let mut bz = [0.0; 4];

        assert_eq!(
            projectile_submunition_launch_velocity_batch(
                4, 0xC1C0FFEE, 3.0, 4.0, 5.0, 0.0, 0.0, 0.0, 0, 1.0, 160.0, 50.0, &mut ax, &mut ay,
                &mut az,
            ),
            4,
        );
        assert_eq!(
            projectile_submunition_launch_velocity_batch(
                4, 0xC1C0FFEE, 3.0, 4.0, 5.0, 0.0, 0.0, 0.0, 0, 1.0, 160.0, 50.0, &mut bx, &mut by,
                &mut bz,
            ),
            4,
        );

        assert_eq!(ax, bx);
        assert_eq!(ay, by);
        assert_eq!(az, bz);
        assert_ne!(ax, [3.0; 4]);
    }

    #[test]
    pub(crate) fn damage_area_overlap_batch_classifies_spheres_and_ignores_projectile_slice() {
        let enabled = [1_u8, 1, 1];
        let kind = [
            DAMAGE_TARGET_KIND_UNIT,
            DAMAGE_TARGET_KIND_UNIT,
            DAMAGE_TARGET_KIND_PROJECTILE,
        ];
        let x = [3.0, 0.0, -3.0];
        let y = [4.0, -8.0, 0.0];
        let z = [0.0, 0.0, 0.0];
        let r = [1.0, 1.0, 0.5];
        let zero = [0.0; 3];
        let mut flags = [0_u8; 3];
        let mut dir_x = [0.0; 3];
        let mut dir_y = [0.0; 3];
        let mut dir_z = [0.0; 3];
        let mut dist = [0.0; 3];

        assert_eq!(
            damage_area_overlap_batch(
                3,
                &enabled,
                &kind,
                0.0,
                0.0,
                0.0,
                5.0,
                1,
                0.0,
                core::f64::consts::FRAC_PI_4,
                &x,
                &y,
                &z,
                &r,
                &zero,
                &zero,
                &zero,
                &mut flags,
                &mut dir_x,
                &mut dir_y,
                &mut dir_z,
                &mut dist,
            ),
            3,
        );

        assert_eq!(
            flags[0],
            DAMAGE_AREA_FLAG_SLICE_PASS | DAMAGE_AREA_FLAG_OVERLAP,
        );
        assert_eq!(flags[1], 0);
        assert_eq!(
            flags[2],
            DAMAGE_AREA_FLAG_SLICE_PASS | DAMAGE_AREA_FLAG_OVERLAP
        );
        assert!((dir_x[0] - 0.6).abs() < 1e-12);
        assert!((dir_y[0] - 0.8).abs() < 1e-12);
        assert_eq!(dir_z[0], 0.0);
        assert_eq!(dist[0], 5.0);
    }

    #[test]
    pub(crate) fn damage_area_candidates_batch_matches_overlap_batch() {
        let _guard = lock_tests();

        // Reference: pack geometry the way TypeScript used to, for the
        // authoritative array-based classifier.
        let kind = [
            DAMAGE_TARGET_KIND_UNIT,
            DAMAGE_TARGET_KIND_UNIT,
            DAMAGE_TARGET_KIND_PROJECTILE,
            DAMAGE_TARGET_KIND_BUILDING,
        ];
        let enabled = [1_u8; 4];
        let tx = [3.0, 0.0, -3.0, 4.0];
        let ty = [4.0, -8.0, 0.0, 0.0];
        let tz = [0.0, 0.0, 0.0, 0.0];
        let tr = [1.0, 1.0, 0.5, 1.5];
        let hx = [0.0, 0.0, 0.0, 1.0];
        let hy = [0.0, 0.0, 0.0, 1.0];
        let hz = [0.0, 0.0, 0.0, 1.0];
        let (cx, cy, cz, radius) = (0.0, 0.0, 0.0, 5.0);
        let (has_slice, slice_dir, slice_half) = (1_u8, 0.0, core::f64::consts::FRAC_PI_4);

        let mut ref_flags = [0_u8; 4];
        let mut ref_dx = [0.0; 4];
        let mut ref_dy = [0.0; 4];
        let mut ref_dz = [0.0; 4];
        let mut ref_dist = [0.0; 4];
        damage_area_overlap_batch(
            4,
            &enabled,
            &kind,
            cx,
            cy,
            cz,
            radius,
            has_slice,
            slice_dir,
            slice_half,
            &tx,
            &ty,
            &tz,
            &tr,
            &hx,
            &hy,
            &hz,
            &mut ref_flags,
            &mut ref_dx,
            &mut ref_dy,
            &mut ref_dz,
            &mut ref_dist,
        );

        // Stamp the same four targets into the slab at slots 0..3 and run the
        // slab-driven kernel over those slots. UNIT/BUILDING radius rides
        // entity_radius_hitbox; SHOT radius rides entity_radius_collision.
        let pool = combat_targeting_pool();
        pool.ensure_entity_capacity(3);
        let families = [
            CT_ENTITY_FAMILY_UNIT,
            CT_ENTITY_FAMILY_UNIT,
            CT_ENTITY_FAMILY_SHOT,
            CT_ENTITY_FAMILY_BUILDING,
        ];
        for s in 0..4 {
            pool.entity_id[s] = s as i32;
            pool.entity_family[s] = families[s];
            pool.entity_pos_x[s] = tx[s];
            pool.entity_pos_y[s] = ty[s];
            pool.entity_pos_z[s] = tz[s];
            pool.entity_radius_hitbox[s] = tr[s];
            pool.entity_radius_collision[s] = tr[s];
            pool.entity_aabb_half_x[s] = hx[s];
            pool.entity_aabb_half_y[s] = hy[s];
            pool.entity_aabb_half_z[s] = hz[s];
        }

        let slots = [0_u32, 1, 2, 3];
        let mut got_flags = [0_u8; 4];
        let mut got_dx = [0.0; 4];
        let mut got_dy = [0.0; 4];
        let mut got_dz = [0.0; 4];
        let mut got_dist = [0.0; 4];
        let processed = damage_area_candidates_batch(
            4,
            &slots,
            cx,
            cy,
            cz,
            radius,
            has_slice,
            slice_dir,
            slice_half,
            &mut got_flags,
            &mut got_dx,
            &mut got_dy,
            &mut got_dz,
            &mut got_dist,
        );

        assert_eq!(processed, 4);
        assert_eq!(got_flags, ref_flags);
        assert_eq!(got_dx, ref_dx);
        assert_eq!(got_dy, ref_dy);
        assert_eq!(got_dz, ref_dz);
        assert_eq!(got_dist, ref_dist);

        // Sanity: the near unit overlapped and the projectile auto-passed slice.
        assert_ne!(ref_flags[0] & DAMAGE_AREA_FLAG_OVERLAP, 0);
        assert_ne!(ref_flags[2] & DAMAGE_AREA_FLAG_SLICE_PASS, 0);
    }

    #[test]
    pub(crate) fn damage_area_turret_candidates_batch_classifies_slab_mounts() {
        let _guard = lock_tests();

        let pool = combat_targeting_pool();
        pool.ensure_entity_capacity(0);
        pool.entity_id[0] = 100;
        pool.entity_family[0] = CT_ENTITY_FAMILY_UNIT;
        pool.entity_pos_x[0] = 0.0;
        pool.entity_pos_y[0] = 0.0;
        pool.entity_pos_z[0] = 0.0;
        pool.entity_ground_z[0] = 0.0;
        pool.entity_rot_cos[0] = 1.0;
        pool.entity_rot_sin[0] = 0.0;
        pool.entity_surface_nx[0] = 0.0;
        pool.entity_surface_ny[0] = 0.0;
        pool.entity_surface_nz[0] = 1.0;
        pool.entity_suspension_offset_x[0] = 0.0;
        pool.entity_suspension_offset_y[0] = 0.0;
        pool.entity_suspension_offset_z[0] = 0.0;
        pool.turret_count_per_entity[0] = 2;
        let near_idx = combat_targeting_turret_global_idx(0, 0);
        pool.turret_mount_x[near_idx] = 4.0;
        pool.turret_mount_y[near_idx] = 0.0;
        pool.turret_mount_z[near_idx] = 0.0;
        pool.turret_local_mount_x[near_idx] = 9.0;
        pool.turret_local_mount_y[near_idx] = 0.0;
        pool.turret_local_mount_z[near_idx] = 0.0;
        pool.turret_radius_hitbox[near_idx] = 1.25;
        pool.turret_world_pos_tick[near_idx] = 7;
        let far_idx = combat_targeting_turret_global_idx(0, 1);
        pool.turret_mount_x[far_idx] = -99.0;
        pool.turret_world_pos_tick[far_idx] = -1;
        pool.turret_local_mount_x[far_idx] = 9.0;
        pool.turret_local_mount_y[far_idx] = 0.0;
        pool.turret_local_mount_z[far_idx] = 0.0;
        pool.turret_radius_hitbox[far_idx] = 0.5;

        let slots = [0_u32, 0, 0];
        let turret_idx = [0_i32, 1, 2];
        let mut flags = [99_u8; 3];
        let processed = damage_area_turret_candidates_batch(
            3,
            &slots,
            &turret_idx,
            7,
            0.0,
            0.0,
            0.0,
            3.0,
            &mut flags,
        );

        assert_eq!(processed, 3);
        assert_eq!(flags[0], DAMAGE_AREA_FLAG_OVERLAP);
        assert_eq!(flags[1], 0);
        assert_eq!(flags[2], 0);
    }

    #[test]
    pub(crate) fn damage_death_explosion_candidates_batch_queries_and_classifies_slab_rows() {
        let _guard = lock_tests();

        spatial_init(200.0, 64);
        combat_targeting_init(64);

        let pool = combat_targeting_pool();
        pool.ensure_entity_capacity(3);

        pool.entity_id[0] = 100;
        pool.entity_family[0] = CT_ENTITY_FAMILY_UNIT;
        pool.entity_pos_x[0] = 3.0;
        pool.entity_pos_y[0] = 0.0;
        pool.entity_pos_z[0] = 0.0;
        pool.entity_radius_hitbox[0] = 1.0;
        spatial_set_entity_id(0, 100);
        spatial_set_unit(0, 3.0, 0.0, 0.0, 1.0, 1.0, 1, 1);

        pool.entity_id[1] = 101;
        pool.entity_family[1] = CT_ENTITY_FAMILY_UNIT;
        pool.entity_pos_x[1] = 20.0;
        pool.entity_pos_y[1] = 0.0;
        pool.entity_pos_z[1] = 0.0;
        pool.entity_ground_z[1] = 0.0;
        pool.entity_rot_cos[1] = 1.0;
        pool.entity_rot_sin[1] = 0.0;
        pool.entity_surface_nx[1] = 0.0;
        pool.entity_surface_ny[1] = 0.0;
        pool.entity_surface_nz[1] = 1.0;
        pool.entity_radius_hitbox[1] = 1.0;
        pool.turret_count_per_entity[1] = 1;
        let turret_idx = combat_targeting_turret_global_idx(1, 0);
        pool.turret_entity_id[turret_idx] = 401;
        pool.turret_local_mount_x[turret_idx] = -16.0;
        pool.turret_local_mount_y[turret_idx] = 0.0;
        pool.turret_local_mount_z[turret_idx] = 0.0;
        pool.turret_radius_hitbox[turret_idx] = 1.0;
        spatial_set_entity_id(1, 101);
        spatial_set_unit(1, 20.0, 0.0, 0.0, 1.0, 1.0, 2, 1);

        pool.entity_id[2] = 200;
        pool.entity_family[2] = CT_ENTITY_FAMILY_BUILDING;
        pool.entity_pos_x[2] = 6.0;
        pool.entity_pos_y[2] = 0.0;
        pool.entity_pos_z[2] = 0.0;
        pool.entity_radius_hitbox[2] = 2.0;
        pool.entity_aabb_half_x[2] = 1.0;
        pool.entity_aabb_half_y[2] = 1.0;
        pool.entity_aabb_half_z[2] = 1.0;
        spatial_set_entity_id(2, 200);
        spatial_set_building(2, 6.0, 0.0, 0.0, 1.0, 1.0, 1.0, 2, 1, 1);

        pool.entity_id[3] = 300;
        pool.entity_family[3] = CT_ENTITY_FAMILY_UNIT;
        pool.entity_pos_x[3] = 160.0;
        pool.entity_pos_y[3] = 0.0;
        pool.entity_pos_z[3] = 0.0;
        pool.entity_radius_hitbox[3] = 1.0;
        spatial_set_entity_id(3, 300);
        spatial_set_unit(3, 160.0, 0.0, 0.0, 1.0, 1.0, 1, 1);

        let mut short_slots = [0_u32; 1];
        let mut short_kind = [0_u8; 1];
        let mut short_flags = [0_u8; 1];
        let mut short_dir_x = [0.0; 1];
        let mut short_dir_y = [0.0; 1];
        let mut short_dir_z = [0.0; 1];
        let mut short_distance = [0.0; 1];
        let mut out_count = [0_u32; 1];
        assert_eq!(
            damage_death_explosion_candidates_batch(
                0.0,
                0.0,
                0.0,
                5.0,
                105.0,
                -1,
                1,
                &mut short_slots,
                &mut short_kind,
                &mut short_flags,
                &mut short_dir_x,
                &mut short_dir_y,
                &mut short_dir_z,
                &mut short_distance,
                &mut out_count,
            ),
            0,
        );
        assert_eq!(out_count[0], 3);

        let mut slots = [0_u32; 3];
        let mut kind = [0_u8; 3];
        let mut flags = [0_u8; 3];
        let mut dir_x = [0.0; 3];
        let mut dir_y = [0.0; 3];
        let mut dir_z = [0.0; 3];
        let mut distance = [0.0; 3];
        assert_eq!(
            damage_death_explosion_candidates_batch(
                0.0,
                0.0,
                0.0,
                5.0,
                105.0,
                -1,
                3,
                &mut slots,
                &mut kind,
                &mut flags,
                &mut dir_x,
                &mut dir_y,
                &mut dir_z,
                &mut distance,
                &mut out_count,
            ),
            3,
        );

        assert_eq!(out_count[0], 3);
        assert_eq!(slots, [0, 1, 2]);
        assert_eq!(
            kind,
            [
                DAMAGE_TARGET_KIND_UNIT,
                DAMAGE_TARGET_KIND_UNIT,
                DAMAGE_TARGET_KIND_BUILDING,
            ],
        );
        assert_eq!(
            flags[0],
            DAMAGE_AREA_FLAG_SLICE_PASS
                | DAMAGE_AREA_FLAG_OVERLAP
                | DAMAGE_DEATH_EXPLOSION_ROW_FLAG_BODY_HIT,
        );
        assert_eq!(
            flags[1],
            DAMAGE_AREA_FLAG_SLICE_PASS | DAMAGE_AREA_FLAG_OVERLAP,
        );
        assert_eq!(
            flags[2],
            DAMAGE_AREA_FLAG_SLICE_PASS
                | DAMAGE_AREA_FLAG_OVERLAP
                | DAMAGE_DEATH_EXPLOSION_ROW_FLAG_BODY_HIT,
        );
        assert_eq!(dir_x, [1.0, 1.0, 1.0]);
        assert_eq!(dir_y, [0.0, 0.0, 0.0]);
        assert_eq!(dir_z, [0.0, 0.0, 0.0]);
        assert_eq!(distance, [3.0, 20.0, 6.0]);
    }

    #[test]
    pub(crate) fn death_explosion_planner_preserves_legacy_breadth_first_chain_order() {
        let _guard = lock_tests();

        death_explosion_planner_reset();

        assert_eq!(death_explosion_planner_seed(&[1, 2], &[10]), 3);

        let mut out_ids = [0_i32; 1];
        let mut out_kind = [0_u8; 1];
        assert_eq!(death_explosion_planner_next(&mut out_ids, &mut out_kind), 1);
        assert_eq!(out_ids[0], 1);
        assert_eq!(out_kind[0], DEATH_EXPLOSION_WORK_KIND_UNIT);

        // Legacy chain order appends the new unit set before the new
        // building set, but skips ids already queued or detonated.
        assert_eq!(death_explosion_planner_append_kills(&[2, 3], &[10, 11]), 2);
        assert_eq!(death_explosion_planner_append_kills(&[1], &[]), 0);

        let mut got = Vec::new();
        while death_explosion_planner_next(&mut out_ids, &mut out_kind) != 0 {
            got.push((out_ids[0], out_kind[0]));
        }

        assert_eq!(
            got,
            vec![
                (2, DEATH_EXPLOSION_WORK_KIND_UNIT),
                (10, DEATH_EXPLOSION_WORK_KIND_BUILDING),
                (3, DEATH_EXPLOSION_WORK_KIND_UNIT),
                (11, DEATH_EXPLOSION_WORK_KIND_BUILDING),
            ],
        );
        assert_eq!(death_explosion_planner_next(&mut out_ids, &mut out_kind), 0);

        death_explosion_planner_reset();
        assert_eq!(death_explosion_planner_seed(&[1], &[]), 1);
        assert_eq!(death_explosion_planner_next(&mut out_ids, &mut out_kind), 1);
        assert_eq!(out_ids[0], 1);
    }

    #[test]
    pub(crate) fn damage_area_overlap_batch_does_not_prefilter_units_when_slice_disabled() {
        let enabled = [1_u8];
        let kind = [DAMAGE_TARGET_KIND_UNIT];
        let x = [20.0];
        let y = [0.0];
        let z = [0.0];
        let r = [1.0];
        let zero = [0.0];
        let mut flags = [0_u8];
        let mut dir_x = [0.0];
        let mut dir_y = [0.0];
        let mut dir_z = [0.0];
        let mut dist = [0.0];

        assert_eq!(
            damage_area_overlap_batch(
                1,
                &enabled,
                &kind,
                0.0,
                0.0,
                0.0,
                5.0,
                0,
                0.0,
                core::f64::consts::FRAC_PI_4,
                &x,
                &y,
                &z,
                &r,
                &zero,
                &zero,
                &zero,
                &mut flags,
                &mut dir_x,
                &mut dir_y,
                &mut dir_z,
                &mut dist,
            ),
            1,
        );

        assert_eq!(flags[0], DAMAGE_AREA_FLAG_SLICE_PASS);
        assert_eq!(dir_x[0], 1.0);
        assert_eq!(dist[0], 20.0);
    }

    #[test]
    pub(crate) fn damage_area_overlap_batch_classifies_building_aabb_and_horizontal_direction() {
        let enabled = [1_u8, 1];
        let kind = [DAMAGE_TARGET_KIND_BUILDING, DAMAGE_TARGET_KIND_BUILDING];
        let x = [6.0, 0.0];
        let y = [8.0, -8.0];
        let z = [0.0, 0.0];
        let footprint_r = [5.0, 5.0];
        let half_x = [3.0, 1.0];
        let half_y = [4.0, 1.0];
        let half_z = [4.0, 1.0];
        let mut flags = [0_u8; 2];
        let mut dir_x = [0.0; 2];
        let mut dir_y = [0.0; 2];
        let mut dir_z = [99.0; 2];
        let mut dist = [0.0; 2];

        assert_eq!(
            damage_area_overlap_batch(
                2,
                &enabled,
                &kind,
                0.0,
                0.0,
                0.0,
                5.0,
                1,
                0.0,
                core::f64::consts::FRAC_PI_4,
                &x,
                &y,
                &z,
                &footprint_r,
                &half_x,
                &half_y,
                &half_z,
                &mut flags,
                &mut dir_x,
                &mut dir_y,
                &mut dir_z,
                &mut dist,
            ),
            2,
        );

        assert_eq!(
            flags[0],
            DAMAGE_AREA_FLAG_SLICE_PASS | DAMAGE_AREA_FLAG_OVERLAP,
        );
        assert_eq!(flags[1], 0);
        assert!((dir_x[0] - 0.6).abs() < 1e-12);
        assert!((dir_y[0] - 0.8).abs() < 1e-12);
        assert_eq!(dir_z[0], 0.0);
        assert_eq!(dist[0], 10.0);
    }

    #[test]
    pub(crate) fn damage_segment_hits_batch_classifies_spheres_and_aabbs() {
        let enabled = [1_u8, 1, 1, 1];
        let kind = [
            DAMAGE_TARGET_KIND_UNIT,
            DAMAGE_TARGET_KIND_PROJECTILE,
            DAMAGE_TARGET_KIND_BUILDING,
            DAMAGE_TARGET_KIND_UNIT,
        ];
        let x = [5.0, 0.0, 8.0, 20.0];
        let y = [0.0, 0.0, 0.0, 4.0];
        let z = [0.0, 0.0, 0.0, 0.0];
        let radius = [1.0, 2.0, 0.0, 1.0];
        let half_x = [0.0, 0.0, 1.0, 0.0];
        let half_y = [0.0, 0.0, 1.0, 0.0];
        let half_z = [0.0, 0.0, 1.0, 0.0];
        let mut flags = [0_u8; 4];
        let mut t = [99.0; 4];

        assert_eq!(
            damage_segment_hits_batch(
                4, &enabled, &kind, 0.0, 0.0, 0.0, 10.0, 0.0, 0.0, &x, &y, &z, &radius, &half_x,
                &half_y, &half_z, &mut flags, &mut t,
            ),
            4,
        );

        assert_eq!(flags[0], DAMAGE_SEGMENT_HIT_FLAG_HIT);
        assert!((t[0] - 0.4).abs() < 1e-12);
        assert_eq!(flags[1], DAMAGE_SEGMENT_HIT_FLAG_HIT);
        assert_eq!(t[1], 0.0);
        assert_eq!(flags[2], DAMAGE_SEGMENT_HIT_FLAG_HIT);
        assert!((t[2] - 0.7).abs() < 1e-12);
        assert_eq!(flags[3], 0);
    }

    #[test]
    pub(crate) fn damage_segment_hits_batch_rejects_degenerate_segment_misses() {
        let enabled = [1_u8];
        let kind = [DAMAGE_TARGET_KIND_UNIT];
        let x = [5.0];
        let y = [0.0];
        let z = [0.0];
        let radius = [1.0];
        let zero = [0.0];
        let mut flags = [99_u8];
        let mut t = [99.0];

        assert_eq!(
            damage_segment_hits_batch(
                1, &enabled, &kind, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, &x, &y, &z, &radius, &zero,
                &zero, &zero, &mut flags, &mut t,
            ),
            1,
        );

        assert_eq!(flags[0], 0);
        assert_eq!(t[0], 0.0);
    }

    #[test]
    pub(crate) fn damage_segment_candidates_batch_matches_segment_hits_batch() {
        let _guard = lock_tests();

        // Reference rows: a unit body sphere, that unit's turret sub-hitbox
        // sphere, and a building AABB — packed the way TypeScript does today.
        let kind = [
            DAMAGE_TARGET_KIND_UNIT,
            DAMAGE_TARGET_KIND_UNIT,
            DAMAGE_TARGET_KIND_BUILDING,
        ];
        let enabled = [1_u8; 3];
        let tx = [0.0, 5.0, 10.0];
        let ty = [0.0, 0.0, 0.0];
        let tz = [0.0, 0.0, 0.0];
        // Raw slab radii; the per-call inflations below are what the caller
        // passes (beam width/2, swept radius) and the kernel adds.
        let tr = [1.5, 1.0, 0.0];
        let hx = [0.0, 0.0, 1.0];
        let hy = [0.0, 0.0, 1.0];
        let hz = [0.0, 0.0, 1.0];
        let sphere_inflation = 0.5;
        let aabb_inflation = 0.25;
        let (sx, sy, sz) = (-5.0, 0.0, 0.0);
        let (ex, ey, ez) = (15.0, 0.0, 0.0);

        // Reference packs the inflated geometry, the way TypeScript does today.
        let ref_tr = [tr[0] + sphere_inflation, tr[1] + sphere_inflation, 0.0];
        let ref_hx = [0.0, 0.0, hx[2] + aabb_inflation];
        let ref_hy = [0.0, 0.0, hy[2] + aabb_inflation];
        let ref_hz = [0.0, 0.0, hz[2] + aabb_inflation];
        let mut ref_flags = [0_u8; 3];
        let mut ref_t = [0.0; 3];
        damage_segment_hits_batch(
            3,
            &enabled,
            &kind,
            sx,
            sy,
            sz,
            ex,
            ey,
            ez,
            &tx,
            &ty,
            &tz,
            &ref_tr,
            &ref_hx,
            &ref_hy,
            &ref_hz,
            &mut ref_flags,
            &mut ref_t,
        );

        // Stamp the unit (slot 0, one turret) and building (slot 1) into the slab.
        let pool = combat_targeting_pool();
        pool.ensure_entity_capacity(1);
        pool.entity_id[0] = 100;
        pool.entity_family[0] = CT_ENTITY_FAMILY_UNIT;
        pool.entity_pos_x[0] = tx[0];
        pool.entity_pos_y[0] = ty[0];
        pool.entity_pos_z[0] = tz[0];
        pool.entity_ground_z[0] = 0.0;
        pool.entity_rot_cos[0] = 1.0;
        pool.entity_rot_sin[0] = 0.0;
        pool.entity_surface_nx[0] = 0.0;
        pool.entity_surface_ny[0] = 0.0;
        pool.entity_surface_nz[0] = 1.0;
        pool.entity_radius_hitbox[0] = tr[0];
        pool.turret_count_per_entity[0] = 1;
        let g0 = combat_targeting_turret_global_idx(0, 0);
        pool.turret_mount_x[g0] = -99.0;
        pool.turret_local_mount_x[g0] = tx[1];
        pool.turret_local_mount_y[g0] = ty[1];
        pool.turret_local_mount_z[g0] = tz[1];
        pool.turret_radius_hitbox[g0] = tr[1];
        pool.entity_id[1] = 200;
        pool.entity_family[1] = CT_ENTITY_FAMILY_BUILDING;
        pool.entity_pos_x[1] = tx[2];
        pool.entity_pos_y[1] = ty[2];
        pool.entity_pos_z[1] = tz[2];
        pool.entity_aabb_half_x[1] = hx[2];
        pool.entity_aabb_half_y[1] = hy[2];
        pool.entity_aabb_half_z[1] = hz[2];

        // rows: unit body (slot 0), that unit's turret 0, building (slot 1).
        let slots = [0_u32, 0, 1];
        let turret_idx = [-1_i32, 0, -1];
        let mut got_flags = [0_u8; 3];
        let mut got_t = [0.0; 3];
        let processed = damage_segment_candidates_batch(
            3,
            &slots,
            &turret_idx,
            -1,
            sx,
            sy,
            sz,
            ex,
            ey,
            ez,
            sphere_inflation,
            aabb_inflation,
            &mut got_flags,
            &mut got_t,
        );

        assert_eq!(processed, 3);
        assert_eq!(got_flags, ref_flags);
        assert_eq!(got_t, ref_t);
        // Sanity: the axis-aligned beam clipped body, turret, and building.
        assert_eq!(ref_flags, [DAMAGE_SEGMENT_HIT_FLAG_HIT; 3]);
    }

    #[test]
    pub(crate) fn damage_closest_body_segment_hit_fuses_spatial_query_and_shape_tests() {
        let _guard = lock_tests();
        spatial_init(10.0, 16);

        spatial_set_entity_id(0, 100);
        spatial_set_unit(0, 3.0, 0.0, 0.0, 1.0, 1.0, 1, 1);
        spatial_set_entity_id(1, 101);
        spatial_set_unit(1, 9.0, 0.0, 0.0, 1.0, 1.0, 2, 1);
        spatial_set_entity_id(2, 200);
        spatial_set_building(2, 6.0, 0.0, 0.0, 1.0, 1.0, 1.0, 2, 1, 1);

        assert_eq!(
            damage_find_closest_body_segment_hit(0.0, 0.0, 0.0, 12.0, 0.0, 0.0, 4.0, 0.0, -1, -1,),
            100,
        );
        assert!((damage_closest_body_segment_hit_t() - (2.0 / 12.0)).abs() < 1e-12);

        // Launch-style exclusion skips the unit body, exposing the nearer
        // building before the second unit.
        assert_eq!(
            damage_find_closest_body_segment_hit(0.0, 0.0, 0.0, 12.0, 0.0, 0.0, 4.0, 0.0, 100, -1,),
            200,
        );
        assert!((damage_closest_body_segment_hit_t() - (5.0 / 12.0)).abs() < 1e-12);

        // A panel index makes the reflected unit host eligible again.
        assert_eq!(
            damage_find_closest_body_segment_hit(0.0, 0.0, 0.0, 12.0, 0.0, 0.0, 4.0, 0.0, 100, 0,),
            100,
        );

        // Buildings remain excluded after a panel reflection.
        spatial_unset_slot(0);
        assert_eq!(
            damage_find_closest_body_segment_hit(0.0, 0.0, 0.0, 12.0, 0.0, 0.0, 4.0, 0.0, 200, 0,),
            101,
        );
    }

    #[test]
    pub(crate) fn damage_apply_batch_applies_unit_projectile_and_fortified_building_damage() {
        let enabled = [1_u8, 1, 1, 1];
        let kind = [
            DAMAGE_TARGET_KIND_UNIT,
            DAMAGE_TARGET_KIND_BUILDING,
            DAMAGE_TARGET_KIND_PROJECTILE,
            DAMAGE_TARGET_KIND_BUILDING,
        ];
        let hp = [100.0, 100.0, 12.0, 100.0];
        let damage = [40.0, 40.0, 20.0, 40.0];
        let fortified = [0_u8, 1, 0, 0];
        let mut out_hp = [0.0; 4];
        let mut out_effective_damage = [0.0; 4];
        let mut out_flags = [0_u8; 4];

        assert_eq!(
            damage_apply_batch(
                4,
                &enabled,
                &kind,
                &hp,
                &damage,
                &fortified,
                0.1,
                &mut out_hp,
                &mut out_effective_damage,
                &mut out_flags,
            ),
            4,
        );

        assert_eq!(out_hp, [60.0, 96.0, -8.0, 60.0]);
        assert_eq!(out_effective_damage, [40.0, 4.0, 20.0, 40.0]);
        assert_eq!(out_flags[0], DAMAGE_APPLY_FLAG_APPLIED);
        assert_eq!(out_flags[1], DAMAGE_APPLY_FLAG_APPLIED);
        assert_eq!(
            out_flags[2],
            DAMAGE_APPLY_FLAG_APPLIED | DAMAGE_APPLY_FLAG_KILLED,
        );
        assert_eq!(out_flags[3], DAMAGE_APPLY_FLAG_APPLIED);
    }

    #[test]
    pub(crate) fn damage_apply_batch_preserves_disabled_dead_and_negative_damage_rows() {
        let enabled = [0_u8, 1, 1];
        let kind = [
            DAMAGE_TARGET_KIND_UNIT,
            DAMAGE_TARGET_KIND_UNIT,
            DAMAGE_TARGET_KIND_UNIT,
        ];
        let hp = [25.0, 0.0, 10.0];
        let damage = [5.0, 5.0, -4.0];
        let fortified = [0_u8; 3];
        let mut out_hp = [99.0; 3];
        let mut out_effective_damage = [99.0; 3];
        let mut out_flags = [99_u8; 3];

        assert_eq!(
            damage_apply_batch(
                3,
                &enabled,
                &kind,
                &hp,
                &damage,
                &fortified,
                0.1,
                &mut out_hp,
                &mut out_effective_damage,
                &mut out_flags,
            ),
            1,
        );

        assert_eq!(out_hp, [25.0, 0.0, 14.0]);
        assert_eq!(out_effective_damage, [0.0, 0.0, -4.0]);
        assert_eq!(out_flags, [0, 0, DAMAGE_APPLY_FLAG_APPLIED]);
    }

    #[test]
    pub(crate) fn death_cleanup_diff_batch_emits_dead_materialized_units_and_buildings() {
        let enabled = [1_u8, 1, 1, 1];
        let entity_ids = [10_i32, 11, 12, 13];
        let kind = [
            DEATH_CLEANUP_KIND_UNIT,
            DEATH_CLEANUP_KIND_UNIT,
            DEATH_CLEANUP_KIND_BUILDING,
            DEATH_CLEANUP_KIND_BUILDING,
        ];
        let hp = [0.0, -4.0, 0.0, 12.0];
        let materialized = [1_u8, 0, 0, 0];
        let mut out_dead_entity_ids = [0_i32; 4];
        let mut out_dead_kind = [0_u8; 4];
        let mut out_dead_count = [99_u32; 1];

        assert_eq!(
            death_cleanup_diff_batch(
                4,
                &enabled,
                &entity_ids,
                &kind,
                &hp,
                &materialized,
                &mut out_dead_entity_ids,
                &mut out_dead_kind,
                &mut out_dead_count,
            ),
            4,
        );

        assert_eq!(out_dead_count[0], 2);
        assert_eq!(&out_dead_entity_ids[..2], [10, 12]);
        assert_eq!(
            &out_dead_kind[..2],
            [DEATH_CLEANUP_KIND_UNIT, DEATH_CLEANUP_KIND_BUILDING],
        );
    }

    #[test]
    pub(crate) fn death_cleanup_diff_batch_ignores_disabled_and_unknown_rows() {
        let enabled = [0_u8, 1, 1];
        let entity_ids = [10_i32, 11, 12];
        let kind = [DEATH_CLEANUP_KIND_UNIT, 99, DEATH_CLEANUP_KIND_UNIT];
        let hp = [-10.0, -10.0, 10.0];
        let materialized = [1_u8, 1, 1];
        let mut out_dead_entity_ids = [0_i32; 3];
        let mut out_dead_kind = [0_u8; 3];
        let mut out_dead_count = [99_u32; 1];

        assert_eq!(
            death_cleanup_diff_batch(
                3,
                &enabled,
                &entity_ids,
                &kind,
                &hp,
                &materialized,
                &mut out_dead_entity_ids,
                &mut out_dead_kind,
                &mut out_dead_count,
            ),
            1,
        );

        assert_eq!(out_dead_count[0], 0);
        assert_eq!(out_dead_entity_ids, [0, 0, 0]);
        assert_eq!(out_dead_kind, [0, 0, 0]);
    }

    #[test]
    pub(crate) fn projectile_terminal_consequence_classifies_water_as_silent_remove() {
        let enabled = [1_u8];
        let is_projectile_type = [1_u8];
        let is_armed = [1_u8];
        let has_exploded = [0_u8];
        let detonate_on_expiry = [0_u8];
        let has_payload = [1_u8];
        let direct_hit = [0_u8];
        let reflected = [0_u8];
        let hit_shield = [0_u8];
        let terminal_reflector = [0_u8];
        let water = [1_u8];
        let zero = [0_u8];
        let x = [20.0];
        let y = [30.0];
        let z = [-2.0];
        let ground_z = [0.0];
        let hp = [10.0];
        let time_alive = [100.0];
        let max_life = [1000.0];
        let mut reason = [99_u8];
        let mut flags = [0_u32];
        let mut out_z = [99.0];
        let mut out_hp = [99.0];

        assert_eq!(
            projectile_terminal_consequence_batch(
                1,
                &enabled,
                &is_projectile_type,
                &is_armed,
                &has_exploded,
                &zero,
                &zero,
                &detonate_on_expiry,
                &zero,
                &zero,
                &zero,
                &has_payload,
                &direct_hit,
                &reflected,
                &hit_shield,
                &terminal_reflector,
                &water,
                &zero,
                &zero,
                &x,
                &y,
                &z,
                &ground_z,
                &hp,
                &time_alive,
                &max_life,
                100.0,
                100.0,
                10.0,
                &mut reason,
                &mut flags,
                &mut out_z,
                &mut out_hp,
            ),
            1,
        );

        assert_eq!(reason[0], PROJECTILE_TERMINAL_REASON_WATER);
        assert_eq!(
            flags[0],
            PROJECTILE_TERMINAL_FLAG_REMOVE
                | PROJECTILE_TERMINAL_FLAG_SET_HP_ZERO
                | PROJECTILE_TERMINAL_FLAG_CLAMP_Z
                | PROJECTILE_TERMINAL_FLAG_WATER_SPLASH,
        );
        assert_eq!(out_z[0], 0.0);
        assert_eq!(out_hp[0], 0.0);
    }

    #[test]
    pub(crate) fn projectile_terminal_consequence_stops_air_shot_at_water_surface() {
        let one = [1_u8];
        let zero = [0_u8];
        let x = [20.0];
        let y = [30.0];
        let z = [10.0];
        let ground_z = [-40.0];
        let hp = [10.0];
        let time_alive = [100.0];
        let max_life = [1000.0];
        let mut reason = [0_u8];
        let mut flags = [0_u32];
        let mut out_z = [0.0];
        let mut out_hp = [0.0];

        assert_eq!(
            projectile_terminal_consequence_batch(
                1,
                &one,
                &one,
                &one,
                &zero,
                &zero,
                &zero,
                &zero,
                &zero,
                &zero,
                &zero,
                &one,
                &zero,
                &zero,
                &zero,
                &zero,
                &one,
                &one,
                &zero,
                &x,
                &y,
                &z,
                &ground_z,
                &hp,
                &time_alive,
                &max_life,
                100.0,
                100.0,
                10.0,
                &mut reason,
                &mut flags,
                &mut out_z,
                &mut out_hp,
            ),
            1,
        );
        assert_eq!(reason[0], PROJECTILE_TERMINAL_REASON_WATER);
        assert_eq!(
            flags[0],
            PROJECTILE_TERMINAL_FLAG_REMOVE
                | PROJECTILE_TERMINAL_FLAG_SET_HP_ZERO
                | PROJECTILE_TERMINAL_FLAG_WATER_SPLASH,
        );
        assert_eq!(out_hp[0], 0.0);
    }

    #[test]
    pub(crate) fn projectile_terminal_consequence_can_detonate_on_water_transition() {
        let one = [1_u8];
        let zero = [0_u8];
        let x = [20.0];
        let y = [30.0];
        let z = [0.0];
        let ground_z = [-40.0];
        let hp = [10.0];
        let time_alive = [100.0];
        let max_life = [1000.0];
        let mut reason = [0_u8];
        let mut flags = [0_u32];
        let mut out_z = [0.0];
        let mut out_hp = [0.0];

        assert_eq!(
            projectile_terminal_consequence_batch(
                1,
                &one,
                &one,
                &one,
                &zero,
                &zero,
                &zero,
                &zero,
                &zero,
                &zero,
                &one,
                &one,
                &zero,
                &zero,
                &zero,
                &zero,
                &one,
                &one,
                &zero,
                &x,
                &y,
                &z,
                &ground_z,
                &hp,
                &time_alive,
                &max_life,
                100.0,
                100.0,
                10.0,
                &mut reason,
                &mut flags,
                &mut out_z,
                &mut out_hp,
            ),
            1,
        );
        assert_eq!(reason[0], PROJECTILE_TERMINAL_REASON_WATER);
        assert_eq!(
            flags[0],
            PROJECTILE_TERMINAL_FLAG_REMOVE
                | PROJECTILE_TERMINAL_FLAG_SET_HP_ZERO
                | PROJECTILE_TERMINAL_FLAG_DETONATE,
        );
    }

    #[test]
    pub(crate) fn projectile_terminal_consequence_water_compatible_shot_detonates_on_seabed() {
        let one = [1_u8];
        let zero = [0_u8];
        let x = [20.0];
        let y = [30.0];
        let z = [-42.0];
        let ground_z = [-40.0];
        let hp = [10.0];
        let time_alive = [100.0];
        let max_life = [1000.0];
        let mut reason = [0_u8];
        let mut flags = [0_u32];
        let mut out_z = [0.0];
        let mut out_hp = [0.0];

        assert_eq!(
            projectile_terminal_consequence_batch(
                1,
                &one,
                &one,
                &one,
                &zero,
                &zero,
                &one,
                &zero,
                &zero,
                &zero,
                &zero,
                &one,
                &zero,
                &zero,
                &zero,
                &zero,
                &one,
                &zero,
                &one,
                &x,
                &y,
                &z,
                &ground_z,
                &hp,
                &time_alive,
                &max_life,
                100.0,
                100.0,
                10.0,
                &mut reason,
                &mut flags,
                &mut out_z,
                &mut out_hp,
            ),
            1,
        );
        assert_eq!(reason[0], PROJECTILE_TERMINAL_REASON_GROUND);
        assert_eq!(
            flags[0],
            PROJECTILE_TERMINAL_FLAG_REMOVE
                | PROJECTILE_TERMINAL_FLAG_SET_HP_ZERO
                | PROJECTILE_TERMINAL_FLAG_CLAMP_Z
                | PROJECTILE_TERMINAL_FLAG_DETONATE,
        );
        assert_eq!(out_z[0], -40.0);
        assert_eq!(out_hp[0], 0.0);
    }

    #[test]
    pub(crate) fn projectile_terminal_consequence_expires_with_detonation_payload() {
        let enabled = [1_u8];
        let is_projectile_type = [1_u8];
        let is_armed = [1_u8];
        let has_exploded = [0_u8];
        let detonate_on_expiry = [1_u8];
        let has_payload = [1_u8];
        let zero = [0_u8];
        let water = [0_u8];
        let x = [20.0];
        let y = [30.0];
        let z = [40.0];
        let ground_z = [0.0];
        let hp = [10.0];
        let time_alive = [1000.0];
        let max_life = [1000.0];
        let mut reason = [0_u8];
        let mut flags = [0_u32];
        let mut out_z = [0.0];
        let mut out_hp = [0.0];

        assert_eq!(
            projectile_terminal_consequence_batch(
                1,
                &enabled,
                &is_projectile_type,
                &is_armed,
                &has_exploded,
                &zero,
                &zero,
                &detonate_on_expiry,
                &zero,
                &zero,
                &zero,
                &has_payload,
                &zero,
                &zero,
                &zero,
                &zero,
                &water,
                &zero,
                &zero,
                &x,
                &y,
                &z,
                &ground_z,
                &hp,
                &time_alive,
                &max_life,
                100.0,
                100.0,
                10.0,
                &mut reason,
                &mut flags,
                &mut out_z,
                &mut out_hp,
            ),
            1,
        );

        assert_eq!(reason[0], PROJECTILE_TERMINAL_REASON_EXPIRED);
        assert_eq!(
            flags[0],
            PROJECTILE_TERMINAL_FLAG_REMOVE
                | PROJECTILE_TERMINAL_FLAG_SET_HP_ZERO
                | PROJECTILE_TERMINAL_FLAG_DETONATE,
        );
        assert_eq!(out_z[0], 40.0);
        assert_eq!(out_hp[0], 0.0);
    }

    #[test]
    pub(crate) fn projectile_terminal_consequence_expires_without_payload_as_fx() {
        let enabled = [1_u8];
        let is_projectile_type = [1_u8];
        let is_armed = [1_u8];
        let has_exploded = [0_u8];
        let detonate_on_expiry = [0_u8];
        let has_payload = [0_u8];
        let zero = [0_u8];
        let water = [0_u8];
        let x = [20.0];
        let y = [30.0];
        let z = [40.0];
        let ground_z = [0.0];
        let hp = [10.0];
        let time_alive = [1000.0];
        let max_life = [1000.0];
        let mut reason = [0_u8];
        let mut flags = [0_u32];
        let mut out_z = [0.0];
        let mut out_hp = [0.0];

        assert_eq!(
            projectile_terminal_consequence_batch(
                1,
                &enabled,
                &is_projectile_type,
                &is_armed,
                &has_exploded,
                &zero,
                &zero,
                &detonate_on_expiry,
                &zero,
                &zero,
                &zero,
                &has_payload,
                &zero,
                &zero,
                &zero,
                &zero,
                &water,
                &zero,
                &zero,
                &x,
                &y,
                &z,
                &ground_z,
                &hp,
                &time_alive,
                &max_life,
                100.0,
                100.0,
                10.0,
                &mut reason,
                &mut flags,
                &mut out_z,
                &mut out_hp,
            ),
            1,
        );

        assert_eq!(reason[0], PROJECTILE_TERMINAL_REASON_EXPIRED);
        assert_eq!(
            flags[0],
            PROJECTILE_TERMINAL_FLAG_REMOVE | PROJECTILE_TERMINAL_FLAG_EXPIRE_EVENT,
        );
        assert_eq!(out_hp[0], 10.0);
    }

    #[test]
    pub(crate) fn projectile_terminal_consequence_removes_out_of_bounds() {
        let enabled = [1_u8];
        let is_projectile_type = [1_u8];
        let is_armed = [1_u8];
        let zero = [0_u8];
        let water = [0_u8];
        let x = [115.0];
        let y = [30.0];
        let z = [40.0];
        let ground_z = [0.0];
        let hp = [10.0];
        let time_alive = [100.0];
        let max_life = [1000.0];
        let mut reason = [0_u8];
        let mut flags = [0_u32];
        let mut out_z = [0.0];
        let mut out_hp = [0.0];

        assert_eq!(
            projectile_terminal_consequence_batch(
                1,
                &enabled,
                &is_projectile_type,
                &is_armed,
                &zero,
                &zero,
                &zero,
                &zero,
                &zero,
                &zero,
                &zero,
                &zero,
                &zero,
                &zero,
                &zero,
                &zero,
                &water,
                &zero,
                &zero,
                &x,
                &y,
                &z,
                &ground_z,
                &hp,
                &time_alive,
                &max_life,
                100.0,
                100.0,
                10.0,
                &mut reason,
                &mut flags,
                &mut out_z,
                &mut out_hp,
            ),
            1,
        );

        assert_eq!(reason[0], PROJECTILE_TERMINAL_REASON_OUT_OF_BOUNDS);
        assert_eq!(flags[0], PROJECTILE_TERMINAL_FLAG_REMOVE);
        assert_eq!(out_hp[0], 10.0);
    }

    #[test]
    pub(crate) fn projectile_terminal_effect_plan_emits_water_despawn_only() {
        let enabled = [1_u8];
        let terminal = [PROJECTILE_TERMINAL_FLAG_REMOVE | PROJECTILE_TERMINAL_FLAG_WATER_SPLASH];
        let reflector = [1_u8];
        let has_explosion = [1_u8];
        let has_submunitions = [1_u8];
        let mut effects = [0_u32];

        assert_eq!(
            projectile_terminal_effect_plan_batch(
                1,
                &enabled,
                &terminal,
                &reflector,
                &has_explosion,
                &has_submunitions,
                &mut effects,
            ),
            1,
        );

        assert_eq!(
            effects[0],
            PROJECTILE_TERMINAL_EFFECT_FLAG_QUEUE_DESPAWN
                | PROJECTILE_TERMINAL_EFFECT_FLAG_EMIT_WATER_SPLASH_EVENT,
        );
    }

    #[test]
    pub(crate) fn projectile_terminal_effect_plan_splits_payload_bits() {
        let enabled = [1_u8, 1, 1];
        let terminal = [
            PROJECTILE_TERMINAL_FLAG_REMOVE | PROJECTILE_TERMINAL_FLAG_DETONATE,
            PROJECTILE_TERMINAL_FLAG_REMOVE | PROJECTILE_TERMINAL_FLAG_DETONATE,
            PROJECTILE_TERMINAL_FLAG_REMOVE | PROJECTILE_TERMINAL_FLAG_DETONATE,
        ];
        let reflector = [0_u8, 1, 0];
        let has_explosion = [1_u8, 0, 0];
        let has_submunitions = [0_u8, 1, 0];
        let mut effects = [0_u32; 3];

        assert_eq!(
            projectile_terminal_effect_plan_batch(
                3,
                &enabled,
                &terminal,
                &reflector,
                &has_explosion,
                &has_submunitions,
                &mut effects,
            ),
            3,
        );

        assert_eq!(
            effects[0],
            PROJECTILE_TERMINAL_EFFECT_FLAG_QUEUE_DESPAWN
                | PROJECTILE_TERMINAL_EFFECT_FLAG_SET_EXPLODED
                | PROJECTILE_TERMINAL_EFFECT_FLAG_APPLY_SPLASH
                | PROJECTILE_TERMINAL_EFFECT_FLAG_EMIT_HIT_EVENT,
        );
        assert_eq!(
            effects[1],
            PROJECTILE_TERMINAL_EFFECT_FLAG_QUEUE_DESPAWN
                | PROJECTILE_TERMINAL_EFFECT_FLAG_SET_EXPLODED
                | PROJECTILE_TERMINAL_EFFECT_FLAG_SPAWN_SUBMUNITIONS
                | PROJECTILE_TERMINAL_EFFECT_FLAG_EMIT_HIT_EVENT
                | PROJECTILE_TERMINAL_EFFECT_FLAG_EMIT_REFLECTOR_IMPACT_EVENT,
        );
        assert_eq!(effects[2], PROJECTILE_TERMINAL_EFFECT_FLAG_QUEUE_DESPAWN);
    }

    #[test]
    pub(crate) fn projectile_terminal_effect_plan_keeps_expire_and_nonterminal_distinct() {
        let enabled = [1_u8, 1, 0];
        let terminal = [
            PROJECTILE_TERMINAL_FLAG_REMOVE | PROJECTILE_TERMINAL_FLAG_EXPIRE_EVENT,
            0,
            PROJECTILE_TERMINAL_FLAG_REMOVE | PROJECTILE_TERMINAL_FLAG_EXPIRE_EVENT,
        ];
        let zero = [0_u8; 3];
        let mut effects = [99_u32; 3];

        assert_eq!(
            projectile_terminal_effect_plan_batch(
                3,
                &enabled,
                &terminal,
                &zero,
                &zero,
                &zero,
                &mut effects,
            ),
            2,
        );

        assert_eq!(
            effects[0],
            PROJECTILE_TERMINAL_EFFECT_FLAG_QUEUE_DESPAWN
                | PROJECTILE_TERMINAL_EFFECT_FLAG_EMIT_EXPIRE_EVENT,
        );
        assert_eq!(effects[1], 0);
        assert_eq!(effects[2], 0);
    }

    #[test]
    pub(crate) fn ring_static_blocks_the_annulus_but_not_the_hole() {
        let _guard = lock_tests();
        pool_init();
        let dyn_slot = pool_alloc_slot() as usize;
        let ring_slot = pool_alloc_slot() as usize;
        {
            let p = pool();
            // Ring: outer 130, inner 90, tube half-height 20, centered at z=0.
            p.pos_x[ring_slot] = 0.0;
            p.pos_y[ring_slot] = 0.0;
            p.pos_z[ring_slot] = 0.0;
            p.half_x[ring_slot] = 130.0;
            p.half_y[ring_slot] = 130.0;
            p.radius[ring_slot] = 90.0;
            p.half_z[ring_slot] = 20.0;
            p.flags[ring_slot] = BODY_FLAG_OCCUPIED | BODY_FLAG_IS_STATIC | BODY_FLAG_SHAPE_RING;

            p.pos_x[dyn_slot] = 0.0;
            p.pos_y[dyn_slot] = 0.0;
            p.pos_z[dyn_slot] = 0.0;
            p.radius[dyn_slot] = 10.0;
            p.flags[dyn_slot] = BODY_FLAG_OCCUPIED;
        }
        let p = pool();
        // A released production shell falling through the center hole never
        // touches the ring (axis distance 0, inner radius 90).
        assert!(!resolve_sphere_ring_pair_in_pool(p, dyn_slot, ring_slot));

        // A body inside the solid annulus is projected out radially.
        p.pos_x[dyn_slot] = 110.0;
        assert!(resolve_sphere_ring_pair_in_pool(p, dyn_slot, ring_slot));
        assert!(
            p.pos_x[dyn_slot] >= 130.0 + 10.0 - 1e-9,
            "expected radial expulsion past the outer wall, got {}",
            p.pos_x[dyn_slot]
        );

        // A plane skimming the tube from above is pushed back up and its
        // downward velocity reflects off the top face.
        p.pos_x[dyn_slot] = 110.0;
        p.pos_z[dyn_slot] = 28.0;
        p.vel_z[dyn_slot] = -40.0;
        p.restitution[dyn_slot] = 0.0;
        assert!(resolve_sphere_ring_pair_in_pool(p, dyn_slot, ring_slot));
        assert!(
            (p.pos_z[dyn_slot] - 30.0).abs() < 1e-9,
            "got {}",
            p.pos_z[dyn_slot]
        );
        assert!(
            p.vel_z[dyn_slot] >= 0.0,
            "downward velocity must not survive"
        );

        // Well clear of the tube: no contact.
        p.pos_x[dyn_slot] = 200.0;
        p.pos_z[dyn_slot] = 0.0;
        assert!(!resolve_sphere_ring_pair_in_pool(p, dyn_slot, ring_slot));
    }

    #[test]
    pub(crate) fn pool_dynamic_step_prepares_collects_and_finalizes_body_slots() {
        let _guard = lock_tests();
        pool_init();
        let awake_slot = pool_alloc_slot();
        let boundary_slot = pool_alloc_slot();

        {
            let p = pool();
            let awake = awake_slot as usize;
            p.pos_x[awake] = 50.0;
            p.pos_y[awake] = 50.0;
            p.radius[awake] = 5.0;
            p.entity_id[awake] = 101;

            let boundary = boundary_slot as usize;
            p.pos_x[boundary] = 2.0;
            p.pos_y[boundary] = 50.0;
            p.radius[boundary] = 5.0;
            p.entity_id[boundary] = 202;
            p.flags[boundary] = BODY_FLAG_OCCUPIED | BODY_FLAG_SLEEPING;
            p.sleep_ticks[boundary] = SLEEP_TICKS;
        }

        let slots = [awake_slot, boundary_slot];
        let mut awake_slots = [0_u32; 2];
        let mut sync_body_slots = [0_u32; 2];
        let mut stats = [99_u32; 3];
        assert_eq!(
            pool_prepare_dynamic_step(
                &slots,
                &mut awake_slots,
                &mut sync_body_slots,
                &mut stats,
                100.0,
                100.0,
                10.0,
                0.0,
            ),
            2,
        );
        assert_eq!(stats, [2, 1, 2]);
        assert_eq!(awake_slots, slots);
        assert_eq!(sync_body_slots, slots);

        let mut collected = [0_i32; 2];
        assert_eq!(pool_collect_awake_entity_ids(&slots, &mut collected), 2);
        assert_eq!(collected, [101, 202]);

        entity_state_init(8);
        entity_state_set_lifecycle(3, 101, ENTITY_STATE_KIND_UNIT, 1, 1, 0);
        entity_state_set_body_slot(3, awake_slot as i32);
        entity_state_set_lifecycle(4, 202, ENTITY_STATE_KIND_UNIT, 1, 1, 0);
        entity_state_set_body_slot(4, boundary_slot as i32);
        entity_state_set_lifecycle(5, 999, ENTITY_STATE_KIND_UNIT, 1, 1, 0);
        entity_state_set_body_slot(5, awake_slot as i32);

        let mut undersized_entity_slots = [0_u32; 1];
        assert_eq!(
            entity_state_collect_awake_body_entity_slots(&mut undersized_entity_slots),
            -2,
        );
        let mut collected_entity_slots = [0_u32; 3];
        assert_eq!(
            entity_state_collect_awake_body_entity_slots(&mut collected_entity_slots),
            2,
        );
        assert_eq!(&collected_entity_slots[..2], &[3, 4]);
        let mut undersized_body_entity_slots = [0_u32; 1];
        assert_eq!(
            entity_state_collect_body_entity_slots(&slots, &mut undersized_body_entity_slots),
            -2,
        );
        let mut collected_body_entity_slots = [0_u32; 2];
        assert_eq!(
            entity_state_collect_body_entity_slots(&slots, &mut collected_body_entity_slots),
            2,
        );
        assert_eq!(collected_body_entity_slots, [3, 4]);
        entity_state_unset_slot(3);
        assert_eq!(
            entity_state_collect_body_entity_slots(&slots, &mut collected_body_entity_slots),
            1,
        );
        assert_eq!(collected_body_entity_slots[0], 4);
        entity_state_clear();

        {
            let p = pool();
            let boundary = boundary_slot as usize;
            assert_eq!(p.flags[boundary] & BODY_FLAG_SLEEPING, 0);
            assert!(p.accel_x[boundary] > 0.0);
            assert_eq!(p.sleep_ticks[boundary], 0.0);
        }

        let mut final_sync = [0_u32; 2];
        assert_eq!(pool_finalize_dynamic_step(&slots, &mut final_sync), 2);
        assert_eq!(final_sync, slots);
        {
            let p = pool();
            for &slot in &slots {
                let i = slot as usize;
                assert_eq!(p.accel_x[i], 0.0);
                assert_eq!(p.accel_y[i], 0.0);
                assert_eq!(p.accel_z[i], 0.0);
                assert_eq!(p.launch_x[i], 0.0);
                assert_eq!(p.launch_y[i], 0.0);
                assert_eq!(p.launch_z[i], 0.0);
            }
        }

        pool_free_slot(awake_slot);
        pool_free_slot(boundary_slot);
    }

    #[test]
    pub(crate) fn world_boundary_constraint_removes_outward_velocity_without_bounce() {
        let _guard = lock_tests();
        pool_init();
        let slot = pool_alloc_slot();

        {
            let p = pool();
            let i = slot as usize;
            p.pos_x[i] = 6.0;
            p.pos_y[i] = 50.0;
            p.pos_z[i] = 20.0;
            p.vel_x[i] = -200.0;
            p.vel_y[i] = 40.0;
            p.vel_z[i] = 0.0;
            p.radius[i] = 5.0;
            p.inv_mass[i] = 1.0;
            p.ground_offset[i] = 0.0;
            p.entity_id[i] = 303;
        }

        let slots = [slot];
        let ground_z = [-1000.0];
        let ground_normals = [0.0, 0.0, 1.0];
        let mut transitions = [0_u32; 1];
        let before_speed_sq = 200.0 * 200.0 + 40.0 * 40.0;

        assert_eq!(
            pool_step_integrate(
                &slots,
                &ground_z,
                &ground_normals,
                &mut transitions,
                1.0 / 60.0,
                0.0,
                0.0,
                0.0,
                100.0,
                100.0,
            ),
            0,
        );

        {
            let p = pool();
            let i = slot as usize;
            assert_eq!(p.pos_x[i], 5.0);
            assert_eq!(p.vel_x[i], 0.0);
            assert_eq!(p.vel_y[i], 40.0);
            let after_speed_sq =
                p.vel_x[i] * p.vel_x[i] + p.vel_y[i] * p.vel_y[i] + p.vel_z[i] * p.vel_z[i];
            assert!(
                after_speed_sq <= before_speed_sq,
                "world boundary must not add kinetic energy"
            );
        }

        pool_free_slot(slot);
    }

    #[test]
    pub(crate) fn build_target_horizontal_distance_handles_buildings_units_and_points() {
        assert_eq!(
            build_target_horizontal_distance(
                5.0,
                0.0,
                0.0,
                0.0,
                BUILD_TARGET_KIND_BUILDING,
                10.0,
                10.0,
                0.0,
            ),
            0.0,
            "builder inside a building footprint is already in contact",
        );
        assert_eq!(
            build_target_horizontal_distance(
                20.0,
                0.0,
                0.0,
                0.0,
                BUILD_TARGET_KIND_BUILDING,
                10.0,
                10.0,
                0.0,
            ),
            15.0,
        );
        assert_eq!(
            build_target_horizontal_distance(
                0.0,
                0.0,
                10.0,
                0.0,
                BUILD_TARGET_KIND_UNIT,
                0.0,
                0.0,
                3.0,
            ),
            7.0,
        );
        assert_eq!(
            build_target_horizontal_distance(0.0, 0.0, 3.0, 4.0, 0, 0.0, 0.0, 99.0,),
            5.0,
        );
    }

    #[test]
    pub(crate) fn commander_apply_reclaim_tick_computes_hp_and_refund() {
        let mut out = [0.0; 5];
        assert_eq!(
            commander_apply_reclaim_tick(80.0, 100.0, 20.0, 0.5, 300.0, 120.0, 0.5, &mut out),
            1,
        );
        assert_eq!(out[0], 70.0);
        assert_eq!(out[1], 10.0);
        assert_eq!(out[2], 15.0);
        assert_eq!(out[3], 6.0);
        assert_eq!(out[4], 0.0);

        assert_eq!(
            commander_apply_reclaim_tick(8.0, 100.0, 20.0, 0.5, 300.0, 120.0, 0.5, &mut out),
            1,
        );
        assert_eq!(out[0], 0.0);
        assert_eq!(out[1], 8.0);
        assert_eq!(out[4], 1.0);

        assert_eq!(
            commander_apply_reclaim_tick(8.0, 100.0, 20.0, 0.0, 300.0, 120.0, 0.5, &mut out),
            1,
        );
        assert_eq!(out[0], 8.0);
        assert_eq!(out[1], 0.0);

        let mut short = [0.0; 4];
        assert_eq!(
            commander_apply_reclaim_tick(8.0, 100.0, 20.0, 0.5, 300.0, 120.0, 0.5, &mut short),
            0,
        );
    }

    #[test]
    pub(crate) fn building_active_state_step_batch_updates_open_close_lifecycle() {
        let mut open = [1, 1, 0, 1, 0];
        let active = [1, 1, 1, 0, 1];
        // Every host switched ON: this case is about the automatic damage
        // flap, so the player's ON/OFF switch must not interfere with it.
        let want_open = [1, 1, 1, 1, 1];
        let mut damage_delay = [200.0, 0.0, 0.0, 250.0, 0.0];
        let mut reopen_delay = [0.0, 0.0, 200.0, 400.0, 700.0];
        let mut changed = [0; 5];

        assert_eq!(
            building_active_state_step_batch(
                &mut open,
                &active,
                &want_open,
                &mut damage_delay,
                &mut reopen_delay,
                5,
                250.0,
                5000.0,
                &mut changed,
            ),
            1,
        );

        assert_eq!(open, [0, 1, 1, 0, 0]);
        assert_eq!(damage_delay, [0.0, 0.0, 0.0, 250.0, 0.0]);
        assert_eq!(reopen_delay, [5000.0, 0.0, 0.0, 400.0, 450.0]);
        assert_eq!(changed, [1, 0, 1, 1, 0]);

        let mut short_changed = [0; 4];
        assert_eq!(
            building_active_state_step_batch(
                &mut open,
                &active,
                &want_open,
                &mut damage_delay,
                &mut reopen_delay,
                5,
                250.0,
                5000.0,
                &mut short_changed,
            ),
            0,
        );
    }

    #[test]
    pub(crate) fn factory_build_spot_projects_outside_footprint_and_clamps_map() {
        let mut out = [0.0; 7];
        assert_eq!(
            factory_build_spot(
                100.0,
                50.0,
                200.0,
                50.0,
                0.0,
                1.0,
                8.0,
                96.0,
                64.0,
                192.0,
                16.0,
                0.72,
                125.0,
                f64::NAN,
                8.0,
                &mut out,
            ),
            1
        );
        assert_eq!(out[0], 117.0);
        assert_eq!(out[1], 50.0);
        assert_eq!(out[2], 17.0);
        assert_eq!(out[3], 0.0);
        assert_eq!(out[4], 1.0);
        assert_eq!(out[5], 0.0);
        assert!((out[6] - 138.24).abs() < 1.0e-9);

        let mut fallback = [0.0; 7];
        assert_eq!(
            factory_build_spot(
                10.0,
                10.0,
                10.0,
                10.0,
                0.0,
                -2.0,
                0.0,
                20.0,
                20.0,
                30.0,
                1.0,
                0.5,
                f64::NAN,
                f64::NAN,
                0.0,
                &mut fallback,
            ),
            1
        );
        assert_eq!(fallback[4], 0.0);
        assert_eq!(fallback[5], -1.0);
        assert_eq!(fallback[6], 15.0);

        let mut short = [0.0; 6];
        assert_eq!(
            factory_build_spot(
                0.0,
                0.0,
                1.0,
                0.0,
                1.0,
                0.0,
                0.0,
                1.0,
                1.0,
                1.0,
                0.0,
                1.0,
                f64::NAN,
                f64::NAN,
                0.0,
                &mut short,
            ),
            0
        );
    }

    #[test]
    pub(crate) fn factory_build_spot_blocked_uses_packed_obstacle_radii() {
        let obstacle_x = [30.0, 45.0, 60.0];
        let obstacle_y = [10.0, 10.0, 10.0];
        let obstacle_radius = [4.0, 6.0, 8.0];

        assert_eq!(
            factory_build_spot_blocked(
                20.0,
                10.0,
                6.0,
                &obstacle_x,
                &obstacle_y,
                &obstacle_radius,
                3,
            ),
            0,
            "touching at exactly radius sum is clear, matching the old TS '<' check",
        );
        assert_eq!(
            factory_build_spot_blocked(
                20.1,
                10.0,
                6.0,
                &obstacle_x,
                &obstacle_y,
                &obstacle_radius,
                3,
            ),
            1,
        );
        assert_eq!(
            factory_build_spot_blocked(
                20.1,
                10.0,
                6.0,
                &obstacle_x,
                &obstacle_y,
                &obstacle_radius,
                4,
            ),
            2,
        );
    }

    #[test]
    pub(crate) fn pathfinder_build_reservations_do_not_change_locomotion_surface() {
        let _guard = lock_tests();
        terrain_clear();
        pathfinder_init(400.0, 400.0);

        // Construction reservations are deliberately absent from the
        // locomotion surface. A hovered factory's build footprint cannot
        // change this flat-terrain route.
        pathfinder_rebuild_terrain_mask_and_cc(10_001);
        let count = pathfinder_find_path(
            210.0, 210.0, 320.0, 210.0, 0.0, false, 0.0, true, false, false, true, false, false,
            0.0, 0.0, 0.0, 0.0, 0.0, 0.0, false,
        );
        assert_eq!(count, 1);

        let waypoints =
            unsafe { std::slice::from_raw_parts(pathfinder_waypoints_ptr(), (count as usize) * 2) };
        assert!((waypoints[0] - 320.0).abs() < 1.0e-9);
        assert!((waypoints[1] - 210.0).abs() < 1.0e-9);
    }

    #[test]
    pub(crate) fn pathfinder_does_not_rescue_a_map_edge_start() {
        let _guard = lock_tests();
        terrain_clear();
        pathfinder_init(400.0, 400.0);

        // The current cell is in the map-edge buffer. It used to be snapped
        // toward the goal; an invalid start now remains stranded.
        pathfinder_rebuild_terrain_mask_and_cc(10_002);
        let count = pathfinder_find_path(
            30.0, 210.0, 80.0, 210.0, 0.0, false, 0.0, true, false, false, true, false, false, 0.0,
            0.0, 0.0, 0.0, 0.0, 0.0, false,
        );
        assert_eq!(count, 1);

        let waypoints =
            unsafe { std::slice::from_raw_parts(pathfinder_waypoints_ptr(), (count as usize) * 2) };
        assert!((waypoints[0] - 30.0).abs() < 1.0e-9);
        assert!((waypoints[1] - 210.0).abs() < 1.0e-9);
    }

    #[test]
    pub(crate) fn pathfinder_routes_through_build_reservation_space() {
        let _guard = lock_tests();
        terrain_clear();
        pathfinder_init(400.0, 400.0);

        pathfinder_rebuild_terrain_mask_and_cc(10_003);
        let count = pathfinder_find_path(
            160.0, 210.0, 240.0, 210.0, 0.5, false, 0.0, true, false, false, true, false, false,
            0.0, 0.0, 0.0, 0.0, 0.0, 0.0, false,
        );
        assert_eq!(count, 1);

        let waypoints =
            unsafe { std::slice::from_raw_parts(pathfinder_waypoints_ptr(), (count as usize) * 2) };
        let last = (count as usize - 1) * 2;
        assert!((waypoints[last + 1] - 210.0).abs() < 1.0e-9);
        assert!((waypoints[last] - 240.0).abs() < 1.0e-9);
    }

    fn install_pathfinder_water_strip_test_terrain() {
        const CELLS_X: i32 = 16;
        const CELLS_Y: i32 = 9;
        const CELL_SIZE: f64 = 20.0;
        const WATER_GX: i32 = 8;
        const SHORE_GX: i32 = WATER_GX + 1;

        let cell_count = (CELLS_X * CELLS_Y) as usize;
        let mut vertex_coords: Vec<f64> = Vec::new();
        let mut vertex_heights: Vec<f64> = Vec::new();
        let mut triangle_indices: Vec<i32> = Vec::new();
        let mut triangle_levels: Vec<i32> = Vec::new();
        let mut cell_triangle_offsets: Vec<i32> = Vec::with_capacity(cell_count + 1);
        let mut cell_triangle_indices: Vec<i32> = Vec::new();

        fn push_vertex(
            vertex_coords: &mut Vec<f64>,
            vertex_heights: &mut Vec<f64>,
            x: f64,
            y: f64,
            h: f64,
        ) -> i32 {
            let idx = vertex_heights.len() as i32;
            vertex_coords.push(x);
            vertex_coords.push(y);
            vertex_heights.push(h);
            idx
        }

        fn push_triangle(
            triangle_indices: &mut Vec<i32>,
            triangle_levels: &mut Vec<i32>,
            a: i32,
            b: i32,
            c: i32,
        ) -> i32 {
            let tri = (triangle_indices.len() / 3) as i32;
            triangle_indices.push(a);
            triangle_indices.push(b);
            triangle_indices.push(c);
            triangle_levels.push(0);
            tri
        }

        for gy in 0..CELLS_Y {
            for gx in 0..CELLS_X {
                cell_triangle_offsets.push(cell_triangle_indices.len() as i32);
                let below_water = TERRAIN_WATER_LEVEL - 10.0;
                let above_water = TERRAIN_WATER_LEVEL + 10.0;
                let (h00, h10, h01, h11) = if gx == WATER_GX {
                    (below_water, below_water, below_water, below_water)
                } else if gx == SHORE_GX {
                    // A cell with a real wet-to-dry incline. It must be
                    // a broad water-contact cell for ground avoidance, but it
                    // must never be a pure-water destination.
                    (below_water, above_water, below_water, above_water)
                } else {
                    (above_water, above_water, above_water, above_water)
                };
                let x0 = gx as f64 * CELL_SIZE;
                let y0 = gy as f64 * CELL_SIZE;
                let x1 = x0 + CELL_SIZE;
                let y1 = y0 + CELL_SIZE;
                let v00 = push_vertex(&mut vertex_coords, &mut vertex_heights, x0, y0, h00);
                let v10 = push_vertex(&mut vertex_coords, &mut vertex_heights, x1, y0, h10);
                let v01 = push_vertex(&mut vertex_coords, &mut vertex_heights, x0, y1, h01);
                let v11 = push_vertex(&mut vertex_coords, &mut vertex_heights, x1, y1, h11);
                let t0 = push_triangle(&mut triangle_indices, &mut triangle_levels, v00, v10, v11);
                let t1 = push_triangle(&mut triangle_indices, &mut triangle_levels, v00, v11, v01);
                cell_triangle_indices.push(t0);
                cell_triangle_indices.push(t1);
            }
        }
        cell_triangle_offsets.push(cell_triangle_indices.len() as i32);

        let neighbor_indices = vec![-1; triangle_indices.len()];
        let neighbor_levels = vec![-1; triangle_indices.len()];
        terrain_clear();
        terrain_install_mesh(
            &vertex_coords,
            &vertex_heights,
            &triangle_indices,
            &triangle_levels,
            &neighbor_indices,
            &neighbor_levels,
            &cell_triangle_offsets,
            &cell_triangle_indices,
            CELLS_X as f64 * CELL_SIZE,
            CELLS_Y as f64 * CELL_SIZE,
            CELL_SIZE,
            1,
            CELLS_X,
            CELLS_Y,
        );
    }

    #[test]
    pub(crate) fn pathfinder_medium_permissions_intersect_on_mixed_water_squares() {
        let _guard = lock_tests();
        install_pathfinder_water_strip_test_terrain();
        pathfinder_init(320.0, 180.0);
        pathfinder_rebuild_terrain_mask_and_cc(10_031);

        let ground_only_count = pathfinder_find_path(
            70.0, 90.0, 250.0, 90.0, 0.0, false, 0.0, true, false, false, true, true, false, 0.0,
            0.0, 0.0, 0.0, 0.0, 0.0, false,
        );
        let ground_only_waypoints = unsafe {
            std::slice::from_raw_parts(pathfinder_waypoints_ptr(), (ground_only_count as usize) * 2)
        };
        let mut exact_ground_polyline = vec![70.0, 90.0];
        exact_ground_polyline.extend_from_slice(ground_only_waypoints);
        let ground_only_last = (ground_only_count as usize - 1) * 2;
        assert!(
            (ground_only_waypoints[ground_only_last] - 250.0).abs() > 1.0e-9,
            "ground-only routes should not cross a water-containing strip"
        );
        assert_eq!(pathfinder_last_result_status(), PATHFINDER_RESULT_SNAPPED);
        assert_eq!(
            pathfinder_validate_path(
                &exact_ground_polyline,
                0.0,
                false,
                0.0,
                true,
                false,
                false,
                true,
                true,
                false,
                0.0,
                0.0,
                0.0,
                0.0,
                false,
            ),
            1,
            "the exact snapped route must remain legal",
        );
        exact_ground_polyline.push(250.0);
        exact_ground_polyline.push(90.0);
        assert_eq!(
            pathfinder_validate_path(
                &exact_ground_polyline,
                0.0,
                false,
                0.0,
                true,
                false,
                false,
                true,
                true,
                false,
                0.0,
                0.0,
                0.0,
                0.0,
                false,
            ),
            0,
            "inventing a connector from the snapped endpoint to the click crosses water",
        );

        assert_eq!(
            pathfinder_validate_path(
                &[50.0, 50.0, 90.0, 50.0],
                0.0,
                false,
                0.0,
                true,
                false,
                false,
                true,
                true,
                false,
                0.0,
                0.0,
                0.0,
                0.0,
                false,
            ),
            1,
            "an anchor formation segment on legal ground should validate",
        );
        assert_eq!(
            pathfinder_validate_path(
                &[130.0, 50.0, 170.0, 50.0],
                0.0,
                false,
                0.0,
                true,
                false,
                false,
                true,
                true,
                false,
                0.0,
                0.0,
                0.0,
                0.0,
                false,
            ),
            0,
            "translating that formation segment across the water cell must be rejected",
        );

        let recovered_land_count = pathfinder_find_path(
            150.0, 90.0, 250.0, 90.0, 0.0, false, 0.0, true, false, false, true, true, false, 0.0,
            0.0, 0.0, 0.0, 0.0, 0.0, false,
        );
        assert!(recovered_land_count >= 1);
        assert_eq!(pathfinder_last_result_status(), PATHFINDER_RESULT_SNAPPED);
        let recovered_land_waypoints = unsafe {
            std::slice::from_raw_parts(
                pathfinder_waypoints_ptr(),
                (recovered_land_count as usize) * 2,
            )
        };
        let recovered_last = (recovered_land_count as usize - 1) * 2;
        assert!(
            (recovered_land_waypoints[recovered_last] - 250.0).abs() > 1.0e-9,
            "a now-valid dry start may not enter its recovery-only water MOVE domain",
        );

        let stranded_water_count = pathfinder_find_path(
            70.0, 90.0, 250.0, 90.0, 0.0, false, 0.0, false, true, false, false, true, false, 0.0,
            0.0, 0.0, 0.0, 0.0, 0.0, false,
        );
        assert_eq!(stranded_water_count, 1);
        assert_eq!(
            pathfinder_last_result_status(),
            PATHFINDER_RESULT_UNREACHABLE
        );
        let stranded_water_waypoints = unsafe {
            std::slice::from_raw_parts(
                pathfinder_waypoints_ptr(),
                (stranded_water_count as usize) * 2,
            )
        };
        assert_eq!(stranded_water_waypoints, &[70.0, 90.0]);

        // This strip contains one fully submerged cell beside one mixed cell.
        // With no shoreline band, the fully wet cell is valid; the mixed goal
        // still fails because its exposed case is invalid for a water-only
        // unit, so the click snaps back to the wet cell.
        let shore_goal_count = pathfinder_find_path(
            170.0, 90.0, 190.0, 90.0, 0.0, false, 0.0, false, true, false, false, true, false, 0.0,
            0.0, 0.0, 0.0, 0.0, 0.0, false,
        );
        assert_eq!(shore_goal_count, 1);
        assert_eq!(pathfinder_last_result_status(), PATHFINDER_RESULT_SNAPPED);
        let shore_goal_waypoints = unsafe {
            std::slice::from_raw_parts(pathfinder_waypoints_ptr(), (shore_goal_count as usize) * 2)
        };
        assert_eq!(shore_goal_waypoints, &[170.0, 90.0]);
        assert_eq!(
            pathfinder_validate_path(
                &[170.0, 90.0, 190.0, 90.0],
                0.0,
                false,
                0.0,
                false,
                true,
                false,
                false,
                true,
                false,
                0.0,
                0.0,
                0.0,
                0.0,
                false,
            ),
            0,
            "a water-only segment must reject the partly dry shoreline cell",
        );

        let amphibious_count = pathfinder_find_path(
            70.0, 90.0, 250.0, 90.0, 0.0, false, 0.0, true, true, false, true, true, false, 0.0,
            0.0, 0.0, 0.0, 0.0, 0.0, false,
        );
        assert_eq!(amphibious_count, 1);
        assert_eq!(pathfinder_last_result_status(), PATHFINDER_RESULT_COMPLETE);
        let amphibious_waypoints = unsafe {
            std::slice::from_raw_parts(pathfinder_waypoints_ptr(), (amphibious_count as usize) * 2)
        };
        assert!(
            (amphibious_waypoints[0] - 250.0).abs() < 1.0e-9,
            "amphibious route should reach goal x, got {}",
            amphibious_waypoints[0]
        );
        assert!(
            (amphibious_waypoints[1] - 90.0).abs() < 1.0e-9,
            "amphibious route should reach goal y, got {}",
            amphibious_waypoints[1]
        );
    }

    fn install_pathfinder_cliff_test_terrain() {
        const CELLS_X: i32 = 10;
        const CELLS_Y: i32 = 5;
        const CELL_SIZE: f64 = 20.0;
        const CLIFF_X: i32 = 5;
        const HIGH: f64 = 10.0;
        const LOW: f64 = 0.0;

        let cell_count = (CELLS_X * CELLS_Y) as usize;
        let mut vertex_coords: Vec<f64> = Vec::new();
        let mut vertex_heights: Vec<f64> = Vec::new();
        let mut triangle_indices: Vec<i32> = Vec::new();
        let mut triangle_levels: Vec<i32> = Vec::new();
        let mut cell_refs: Vec<Vec<i32>> = vec![Vec::new(); cell_count];

        fn push_vertex(
            vertex_coords: &mut Vec<f64>,
            vertex_heights: &mut Vec<f64>,
            x: f64,
            y: f64,
            h: f64,
        ) -> i32 {
            let idx = vertex_heights.len() as i32;
            vertex_coords.push(x);
            vertex_coords.push(y);
            vertex_heights.push(h);
            idx
        }

        fn push_triangle(
            triangle_indices: &mut Vec<i32>,
            triangle_levels: &mut Vec<i32>,
            a: i32,
            b: i32,
            c: i32,
        ) -> i32 {
            let tri = (triangle_indices.len() / 3) as i32;
            triangle_indices.push(a);
            triangle_indices.push(b);
            triangle_indices.push(c);
            triangle_levels.push(0);
            tri
        }

        for gy in 0..CELLS_Y {
            for gx in 0..CELLS_X {
                let h = if gx < CLIFF_X { HIGH } else { LOW };
                let x0 = gx as f64 * CELL_SIZE;
                let y0 = gy as f64 * CELL_SIZE;
                let x1 = x0 + CELL_SIZE;
                let y1 = y0 + CELL_SIZE;
                let v00 = push_vertex(&mut vertex_coords, &mut vertex_heights, x0, y0, h);
                let v10 = push_vertex(&mut vertex_coords, &mut vertex_heights, x1, y0, h);
                let v01 = push_vertex(&mut vertex_coords, &mut vertex_heights, x0, y1, h);
                let v11 = push_vertex(&mut vertex_coords, &mut vertex_heights, x1, y1, h);
                let t0 = push_triangle(&mut triangle_indices, &mut triangle_levels, v00, v10, v11);
                let t1 = push_triangle(&mut triangle_indices, &mut triangle_levels, v00, v11, v01);
                let cell_idx = (gy * CELLS_X + gx) as usize;
                cell_refs[cell_idx].push(t0);
                cell_refs[cell_idx].push(t1);
            }
        }

        for gy in 0..CELLS_Y {
            let x = CLIFF_X as f64 * CELL_SIZE;
            let y0 = gy as f64 * CELL_SIZE;
            let y1 = y0 + CELL_SIZE;
            let top0 = push_vertex(&mut vertex_coords, &mut vertex_heights, x, y0, HIGH);
            let top1 = push_vertex(&mut vertex_coords, &mut vertex_heights, x, y1, HIGH);
            let low0 = push_vertex(&mut vertex_coords, &mut vertex_heights, x, y0, LOW);
            let low1 = push_vertex(&mut vertex_coords, &mut vertex_heights, x, y1, LOW);
            let t0 = push_triangle(
                &mut triangle_indices,
                &mut triangle_levels,
                top0,
                top1,
                low0,
            );
            let t1 = push_triangle(
                &mut triangle_indices,
                &mut triangle_levels,
                low0,
                top1,
                low1,
            );
            let left_idx = (gy * CELLS_X + CLIFF_X - 1) as usize;
            let right_idx = (gy * CELLS_X + CLIFF_X) as usize;
            cell_refs[left_idx].push(t0);
            cell_refs[left_idx].push(t1);
            cell_refs[right_idx].push(t0);
            cell_refs[right_idx].push(t1);
        }

        let mut cell_triangle_offsets: Vec<i32> = Vec::with_capacity(cell_count + 1);
        let mut cell_triangle_indices: Vec<i32> = Vec::new();
        for refs in &cell_refs {
            cell_triangle_offsets.push(cell_triangle_indices.len() as i32);
            cell_triangle_indices.extend(refs.iter().copied());
        }
        cell_triangle_offsets.push(cell_triangle_indices.len() as i32);

        let neighbor_indices = vec![-1; triangle_indices.len()];
        let neighbor_levels = vec![-1; triangle_indices.len()];
        terrain_clear();
        terrain_install_mesh(
            &vertex_coords,
            &vertex_heights,
            &triangle_indices,
            &triangle_levels,
            &neighbor_indices,
            &neighbor_levels,
            &cell_triangle_offsets,
            &cell_triangle_indices,
            CELLS_X as f64 * CELL_SIZE,
            CELLS_Y as f64 * CELL_SIZE,
            CELL_SIZE,
            1,
            CELLS_X,
            CELLS_Y,
        );
    }

    #[test]
    pub(crate) fn pathfinder_can_disable_ground_slope_gates_for_unfiltered_queries() {
        let _guard = lock_tests();
        install_pathfinder_cliff_test_terrain();
        pathfinder_init(200.0, 100.0);
        pathfinder_rebuild_terrain_mask_and_cc(10_004);

        let count = pathfinder_find_path(
            90.0, 50.0, 110.0, 50.0, 0.0, false, 0.0, true, false, false, true, false, false, 0.0,
            0.0, 0.0, 0.0, 0.0, 0.0, false,
        );
        assert_eq!(count, 1);

        let waypoints =
            unsafe { std::slice::from_raw_parts(pathfinder_waypoints_ptr(), (count as usize) * 2) };
        assert!((waypoints[0] - 110.0).abs() < 1.0e-9);
        assert!((waypoints[1] - 50.0).abs() < 1.0e-9);
    }

    #[test]
    pub(crate) fn pathfinder_rejects_uphill_cliff_climb() {
        let _guard = lock_tests();
        install_pathfinder_cliff_test_terrain();
        pathfinder_init(200.0, 100.0);
        pathfinder_rebuild_terrain_mask_and_cc(10_005);

        let mut waypoint_valid = [0u8; 50];
        let mut move_valid = [0u8; 50];
        assert_eq!(
            pathfinder_bake_traversability_grid(
                0.5,
                false,
                0.0,
                true,
                false,
                false,
                true,
                false,
                false,
                0.0,
                0.0,
                0.0,
                0.0,
                &mut waypoint_valid,
                &mut move_valid,
            ),
            1,
        );
        let high_flat = 2 * 10 + 4;
        let low_flat = 2 * 10 + 5;
        assert_eq!(waypoint_valid[high_flat], 1);
        assert_eq!(move_valid[high_flat], 1);
        assert_eq!(waypoint_valid[low_flat], 1);
        assert_eq!(move_valid[low_flat], 1);

        let count = pathfinder_find_path(
            110.0, 50.0, 90.0, 50.0, 0.5, false, 0.0, true, false, false, true, false, false, 0.0,
            0.0, 0.0, 0.0, 0.0, 0.0, false,
        );
        assert_eq!(count, 1);

        let waypoints =
            unsafe { std::slice::from_raw_parts(pathfinder_waypoints_ptr(), (count as usize) * 2) };
        assert!((waypoints[0] - 110.0).abs() < 1.0e-9);
        assert!((waypoints[1] - 50.0).abs() < 1.0e-9);
    }

    fn install_pathfinder_sloped_wall_escape_test_terrain() {
        const CELLS_X: i32 = 10;
        const CELLS_Y: i32 = 5;
        const CELL_SIZE: f64 = 20.0;
        const WALL_TOP_X: f64 = 80.0;
        const WALL_BOTTOM_X: f64 = 120.0;
        const HIGH: f64 = 120.0;
        const LOW: f64 = 0.0;

        fn wall_height_at_x(x: f64) -> f64 {
            if x <= WALL_TOP_X {
                HIGH
            } else if x >= WALL_BOTTOM_X {
                LOW
            } else {
                HIGH * (WALL_BOTTOM_X - x) / (WALL_BOTTOM_X - WALL_TOP_X)
            }
        }

        let cell_count = (CELLS_X * CELLS_Y) as usize;
        let mut vertex_coords: Vec<f64> = Vec::new();
        let mut vertex_heights: Vec<f64> = Vec::new();
        let mut triangle_indices: Vec<i32> = Vec::new();
        let mut triangle_levels: Vec<i32> = Vec::new();
        let mut cell_triangle_offsets: Vec<i32> = Vec::with_capacity(cell_count + 1);
        let mut cell_triangle_indices: Vec<i32> = Vec::new();

        fn push_vertex(
            vertex_coords: &mut Vec<f64>,
            vertex_heights: &mut Vec<f64>,
            x: f64,
            y: f64,
            h: f64,
        ) -> i32 {
            let idx = vertex_heights.len() as i32;
            vertex_coords.push(x);
            vertex_coords.push(y);
            vertex_heights.push(h);
            idx
        }

        fn push_triangle(
            triangle_indices: &mut Vec<i32>,
            triangle_levels: &mut Vec<i32>,
            a: i32,
            b: i32,
            c: i32,
        ) -> i32 {
            let tri = (triangle_indices.len() / 3) as i32;
            triangle_indices.push(a);
            triangle_indices.push(b);
            triangle_indices.push(c);
            triangle_levels.push(0);
            tri
        }

        for gy in 0..CELLS_Y {
            for gx in 0..CELLS_X {
                cell_triangle_offsets.push(cell_triangle_indices.len() as i32);
                let x0 = gx as f64 * CELL_SIZE;
                let y0 = gy as f64 * CELL_SIZE;
                let x1 = x0 + CELL_SIZE;
                let y1 = y0 + CELL_SIZE;
                let h0 = wall_height_at_x(x0);
                let h1 = wall_height_at_x(x1);
                let v00 = push_vertex(&mut vertex_coords, &mut vertex_heights, x0, y0, h0);
                let v10 = push_vertex(&mut vertex_coords, &mut vertex_heights, x1, y0, h1);
                let v01 = push_vertex(&mut vertex_coords, &mut vertex_heights, x0, y1, h0);
                let v11 = push_vertex(&mut vertex_coords, &mut vertex_heights, x1, y1, h1);
                let t0 = push_triangle(&mut triangle_indices, &mut triangle_levels, v00, v10, v11);
                let t1 = push_triangle(&mut triangle_indices, &mut triangle_levels, v00, v11, v01);
                cell_triangle_indices.push(t0);
                cell_triangle_indices.push(t1);
            }
        }
        cell_triangle_offsets.push(cell_triangle_indices.len() as i32);

        let neighbor_indices = vec![-1; triangle_indices.len()];
        let neighbor_levels = vec![-1; triangle_indices.len()];
        terrain_clear();
        terrain_install_mesh(
            &vertex_coords,
            &vertex_heights,
            &triangle_indices,
            &triangle_levels,
            &neighbor_indices,
            &neighbor_levels,
            &cell_triangle_offsets,
            &cell_triangle_indices,
            CELLS_X as f64 * CELL_SIZE,
            CELLS_Y as f64 * CELL_SIZE,
            CELL_SIZE,
            1,
            CELLS_X,
            CELLS_Y,
        );
    }

    #[test]
    pub(crate) fn pathfinder_strands_a_steep_wall_start() {
        let _guard = lock_tests();
        install_pathfinder_sloped_wall_escape_test_terrain();
        pathfinder_init(200.0, 100.0);
        pathfinder_rebuild_terrain_mask_and_cc(10_006);

        let mut waypoint_valid = [0u8; 50];
        let mut move_valid = [0u8; 50];
        assert_eq!(
            pathfinder_bake_traversability_grid(
                0.5,
                false,
                0.0,
                true,
                false,
                false,
                true,
                false,
                false,
                0.0,
                0.0,
                0.0,
                0.0,
                &mut waypoint_valid,
                &mut move_valid,
            ),
            1,
        );
        let flat_cell = 2 * 10 + 2;
        let steep_cell = 2 * 10 + 5;
        assert_eq!(waypoint_valid[flat_cell], 1);
        assert_eq!(move_valid[flat_cell], 1);
        assert_eq!(waypoint_valid[steep_cell], 0);
        assert_eq!(move_valid[steep_cell], 0);

        let count = pathfinder_find_path(
            100.0, 50.0, 50.0, 50.0, 0.5, false, 0.0, true, false, false, true, false, false, 0.0,
            0.0, 0.0, 0.0, 0.0, 0.0, false,
        );
        let waypoints =
            unsafe { std::slice::from_raw_parts(pathfinder_waypoints_ptr(), (count as usize) * 2) };
        assert_eq!(count, 1);
        assert!((waypoints[0] - 100.0).abs() < 1.0e-9);
        assert!((waypoints[1] - 50.0).abs() < 1.0e-9);
    }

    #[test]
    pub(crate) fn pathfinder_walks_a_body_out_of_a_pocket_tighter_than_its_clearance() {
        let _guard = lock_tests();
        terrain_clear();
        pathfinder_init(400.0, 400.0);
        pathfinder_rebuild_terrain_mask_and_cc(10_007);

        // Two structure walls two cells apart. Every cell of the corridor
        // between them sits closer to a building than a radius-20 body's hard
        // clearance asks for — the ordinary shape of "a commander finished a
        // building and is now standing beside it". The body must still be able
        // to walk out of the open south end.
        let mut cell_gx: Vec<i32> = Vec::new();
        let mut cell_gy: Vec<i32> = Vec::new();
        for gy in 3..=9 {
            cell_gx.push(4);
            cell_gy.push(gy);
            cell_gx.push(7);
            cell_gy.push(gy);
        }
        assert_eq!(pathfinder_sync_building_occupancy(&cell_gx, &cell_gy, 7), 1);

        let count = pathfinder_find_path(
            110.0, 90.0, 300.0, 300.0, 0.0, false, 0.0, true, false, false, true, false, false,
            20.0, 0.0, 0.0, 0.0, 0.0, 0.0, false,
        );
        assert!(count >= 1);
        let waypoints =
            unsafe { std::slice::from_raw_parts(pathfinder_waypoints_ptr(), (count as usize) * 2) };
        let stranded = count == 1
            && (waypoints[0] - 110.0).abs() < 1.0
            && (waypoints[1] - 90.0).abs() < 1.0;
        assert!(
            !stranded,
            "a body in a pocket tighter than its clearance must still route out"
        );
        let last_x = waypoints[(count as usize - 1) * 2];
        let last_y = waypoints[(count as usize - 1) * 2 + 1];
        assert!(
            last_y > 200.0,
            "the route must leave the corridor, ended at ({last_x}, {last_y})"
        );
    }

    #[test]
    pub(crate) fn factory_plan_production_actions_handles_shell_and_selection_states() {
        let has_shell = [1, 1, 1, 0, 0, 0, 0, 0];
        let shell_exists = [0, 1, 1, 0, 0, 0, 0, 0];
        let shell_has_buildable = [0, 0, 1, 0, 0, 0, 0, 0];
        let shell_buildable_complete = [0, 0, 0, 0, 0, 0, 0, 0];
        let shell_interrupted = [0, 0, 0, 0, 0, 0, 0, 0];
        let shell_paid_energy = [0.0, 0.0, 25.0, 0.0, 0.0, 0.0, 0.0, 0.0];
        let shell_paid_metal = [0.0, 0.0, 80.0, 0.0, 0.0, 0.0, 0.0, 0.0];
        let shell_required_energy = [0.0, 0.0, 100.0, 0.0, 0.0, 0.0, 0.0, 0.0];
        let shell_required_metal = [0.0, 0.0, 100.0, 0.0, 0.0, 0.0, 0.0, 0.0];
        let selected_state = [
            FACTORY_PRODUCTION_SELECTED_NONE_CODE,
            FACTORY_PRODUCTION_SELECTED_NONE_CODE,
            FACTORY_PRODUCTION_SELECTED_NONE_CODE,
            FACTORY_PRODUCTION_SELECTED_NONE_CODE,
            FACTORY_PRODUCTION_SELECTED_INVALID_CODE,
            FACTORY_PRODUCTION_SELECTED_VALID_CODE,
            FACTORY_PRODUCTION_SELECTED_VALID_CODE,
            99,
        ];
        let can_build_unit = [0, 0, 0, 0, 0, 0, 1, 1];
        let is_producing = [0, 0, 0, 1, 0, 1, 0, 0];
        let mut action = [99u8; 8];
        let mut progress = [99.0; 8];

        assert_eq!(
            factory_plan_production_actions(
                &has_shell,
                &shell_exists,
                &shell_has_buildable,
                &shell_buildable_complete,
                &shell_interrupted,
                &shell_paid_energy,
                &shell_paid_metal,
                &shell_required_energy,
                &shell_required_metal,
                &selected_state,
                &can_build_unit,
                &is_producing,
                8,
                &mut action,
                &mut progress,
            ),
            1,
        );

        assert_eq!(
            action,
            [
                FACTORY_PRODUCTION_ACTION_RESET_SHELL_CODE,
                FACTORY_PRODUCTION_ACTION_COMPLETE_SHELL_CODE,
                FACTORY_PRODUCTION_ACTION_NONE_CODE,
                FACTORY_PRODUCTION_ACTION_STOP_PRODUCING_CODE,
                FACTORY_PRODUCTION_ACTION_CLEAR_INVALID_SELECTION_CODE,
                FACTORY_PRODUCTION_ACTION_STOP_PRODUCING_CODE,
                FACTORY_PRODUCTION_ACTION_SPAWN_SHELL_CODE,
                FACTORY_PRODUCTION_ACTION_CLEAR_INVALID_SELECTION_CODE,
            ],
        );
        assert!((progress[2] - 0.25).abs() < 1.0e-9);
    }

    #[test]
    pub(crate) fn factory_plan_production_actions_rejects_short_buffers() {
        let mut action = [0u8; 1];
        let mut progress = [0.0; 1];

        assert_eq!(
            factory_plan_production_actions(
                &[0, 0],
                &[0, 0],
                &[0, 0],
                &[0, 0],
                &[0, 0],
                &[0.0, 0.0],
                &[0.0, 0.0],
                &[0.0, 0.0],
                &[0.0, 0.0],
                &[0, 0],
                &[0, 0],
                &[0, 0],
                2,
                &mut action,
                &mut progress,
            ),
            0,
        );
    }

    #[test]
    pub(crate) fn economy_accumulate_player_rates_groups_by_player_and_clears_output() {
        let players = [2, 1, 2, 0, 7];
        let rates = [3.5, 2.0, 4.5, 12.0, 9.0];
        let mut out = [99.0; 5];

        assert_eq!(
            economy_accumulate_player_rates(&players, &rates, 5, &mut out),
            3
        );
        assert_eq!(out, [0.0, 2.0, 8.0, 0.0, 0.0]);

        assert_eq!(
            economy_accumulate_player_rates(&players, &rates, 0, &mut out),
            0
        );
        assert_eq!(out, [0.0; 5]);
    }

    #[test]
    pub(crate) fn economy_stockpile_credit_debit_clamp_and_normalize_amounts() {
        let mut out = [0.0; 2];

        assert_eq!(economy_credit_stockpile(95.0, 100.0, 20.0, &mut out), 1);
        assert_eq!(out, [5.0, 100.0]);

        assert_eq!(economy_credit_stockpile(20.0, 100.0, f64::NAN, &mut out), 1);
        assert_eq!(out, [0.0, 20.0]);

        assert_eq!(economy_debit_stockpile(12.0, 20.0, &mut out), 1);
        assert_eq!(out, [12.0, 0.0]);

        assert_eq!(economy_debit_stockpile(12.0, -4.0, &mut out), 1);
        assert_eq!(out, [0.0, 12.0]);

        let mut short = [0.0; 1];
        assert_eq!(economy_credit_stockpile(1.0, 2.0, 1.0, &mut short), 0);
        assert_eq!(economy_debit_stockpile(1.0, 1.0, &mut short), 0);
    }

    #[test]
    pub(crate) fn economy_apply_equal_consumer_debits_splits_by_lane_share() {
        let remaining = [50.0, 3.0, 20.0, 0.0];
        let caps = [8.0, f64::INFINITY, 12.0, 5.0];
        let mut spent = [99.0; 4];
        let mut totals = [99.0; 2];

        assert_eq!(
            economy_apply_equal_consumer_debits(
                &remaining,
                &caps,
                4,
                3,
                30.0,
                &mut spent,
                &mut totals,
            ),
            1
        );
        assert_eq!(spent, [8.0, 3.0, 10.0, 0.0]);
        assert_eq!(totals, [21.0, 9.0]);

        assert_eq!(
            economy_apply_equal_consumer_debits(
                &remaining,
                &caps,
                4,
                0,
                30.0,
                &mut spent,
                &mut totals,
            ),
            1
        );
        assert_eq!(spent, [0.0; 4]);
        assert_eq!(totals, [0.0, 30.0]);

        let mut short = [0.0; 3];
        assert_eq!(
            economy_apply_equal_consumer_debits(
                &remaining,
                &caps,
                4,
                3,
                30.0,
                &mut short,
                &mut totals,
            ),
            0
        );
    }

    #[test]
    pub(crate) fn construction_coupled_debits_scale_both_resources_by_the_limiting_stockpile() {
        let paid_energy = [0.0, 0.0];
        let paid_metal = [0.0, 0.0];
        let required_energy = [100.0, 20.0];
        let required_metal = [50.0, 100.0];
        let caps = [20.0, 20.0];
        let mut spent_energy = [99.0; 2];
        let mut spent_metal = [99.0; 2];
        let mut totals = [99.0; 4];

        assert_eq!(
            construction_apply_coupled_consumer_debits(
                &paid_energy,
                &paid_metal,
                &required_energy,
                &required_metal,
                &caps,
                2,
                100.0,
                10.0,
                &mut spent_energy,
                &mut spent_metal,
                &mut totals,
            ),
            1
        );
        assert!((spent_energy[0] - 20.0 / 3.0).abs() < 1e-12);
        assert!((spent_energy[1] - 4.0 / 3.0).abs() < 1e-12);
        assert!((spent_metal[0] - 10.0 / 3.0).abs() < 1e-12);
        assert!((spent_metal[1] - 20.0 / 3.0).abs() < 1e-12);
        assert!((totals[0] - 8.0).abs() < 1e-12);
        assert!((totals[1] - 10.0).abs() < 1e-12);
        assert!((totals[2] - 92.0).abs() < 1e-12);
        assert_eq!(totals[3], 0.0);

        assert_eq!(
            construction_apply_coupled_consumer_debits(
                &paid_energy,
                &paid_metal,
                &required_energy,
                &required_metal,
                &caps,
                2,
                0.0,
                100.0,
                &mut spent_energy,
                &mut spent_metal,
                &mut totals,
            ),
            1
        );
        assert_eq!(spent_energy, [0.0; 2]);
        assert_eq!(spent_metal, [0.0; 2]);
    }

    #[test]
    pub(crate) fn construction_apply_consumer_spends_updates_paid_hp_and_progress() {
        let consumer_types = [
            CONSTRUCTION_CONSUMER_BUILD_CODE,
            CONSTRUCTION_CONSUMER_HEAL_CODE,
            CONSTRUCTION_CONSUMER_BUILD_CODE,
            0,
        ];
        let mut paid_energy = [10.0, 0.0, 20.0, 5.0];
        let mut paid_metal = [0.0, 0.0, 1.0, 5.0];
        let required_energy = [20.0, 0.0, 20.0, 0.0];
        let required_metal = [10.0, 0.0, 5.0, 0.0];
        let mut hp = [0.0, 8.0, 0.0, 0.0];
        let max_hp = [0.0, 10.0, 0.0, 0.0];
        let spend_energy = [5.0, 2.0, 0.0, 99.0];
        let spend_metal = [3.0, 0.0, 4.0, 99.0];
        let caps = [10.0, 4.0, f64::INFINITY, 1.0];
        let mut build_progress = [99.0; 4];
        let mut energy_rate_fraction = [99.0; 4];
        let mut metal_rate_fraction = [99.0; 4];
        let mut changed_mask = [99; 4];

        assert_eq!(
            construction_apply_consumer_spends(
                &consumer_types,
                &mut paid_energy,
                &mut paid_metal,
                &required_energy,
                &required_metal,
                &mut hp,
                &max_hp,
                &spend_energy,
                &spend_metal,
                &caps,
                4,
                0.5,
                &mut build_progress,
                &mut energy_rate_fraction,
                &mut metal_rate_fraction,
                &mut changed_mask,
            ),
            1
        );

        assert_eq!(paid_energy, [15.0, 0.0, 20.0, 5.0]);
        assert_eq!(paid_metal, [3.0, 0.0, 5.0, 5.0]);
        assert_eq!(hp, [0.0, 10.0, 0.0, 0.0]);
        assert!((build_progress[0] - 0.3).abs() < 1e-12);
        assert_eq!(build_progress[1], 0.0);
        assert_eq!(build_progress[2], 1.0);
        assert_eq!(energy_rate_fraction, [0.5, 0.0, 0.0, 0.0]);
        assert_eq!(metal_rate_fraction, [0.3, 0.0, 0.0, 0.0]);
        assert_eq!(
            changed_mask,
            [
                CONSTRUCTION_CONSUMER_CHANGED_BUILD_CODE,
                CONSTRUCTION_CONSUMER_CHANGED_HP_CODE,
                CONSTRUCTION_CONSUMER_CHANGED_BUILD_CODE,
                0,
            ]
        );

        let mut short = [0.0; 3];
        assert_eq!(
            construction_apply_consumer_spends(
                &consumer_types,
                &mut paid_energy,
                &mut paid_metal,
                &required_energy,
                &required_metal,
                &mut hp,
                &max_hp,
                &spend_energy,
                &spend_metal,
                &caps,
                4,
                0.5,
                &mut short,
                &mut energy_rate_fraction,
                &mut metal_rate_fraction,
                &mut changed_mask,
            ),
            0
        );
    }

    #[test]
    pub(crate) fn construction_reconcile_and_grow_pieces_allocates_paid_and_grows_hp() {
        let required_energy = [4.0, 4.0, 4.0];
        let required_metal = [0.0, 2.0, 0.0];
        let max_hp = [10.0, 20.0, 30.0];
        let current_hp = [0.0, 2.0, 5.0];
        let previous_progress = [0.0, 0.1, 0.2];
        let starts = [1, 0, 0];
        let alive = [1, 1, 1];
        let mut paid_energy = [99.0; 3];
        let mut paid_metal = [99.0; 3];
        let mut complete = [99; 3];
        let mut active = [99; 3];
        let mut hp = [99.0; 3];
        let mut progress = [99.0; 3];

        assert_eq!(
            construction_reconcile_and_grow_pieces(
                10.0,
                1.0,
                &required_energy,
                &required_metal,
                &max_hp,
                &current_hp,
                &previous_progress,
                &starts,
                &alive,
                3,
                &mut paid_energy,
                &mut paid_metal,
                &mut complete,
                &mut active,
                &mut hp,
                &mut progress,
            ),
            1
        );

        assert_eq!(paid_energy, [4.0, 4.0, 2.0]);
        assert_eq!(paid_metal, [0.0, 1.0, 0.0]);
        assert_eq!(complete, [1, 0, 0]);
        assert_eq!(active, [1, 1, 0]);
        assert_eq!(hp[0], 10.0);
        assert!((hp[1] - 10.0).abs() < 1e-12);
        assert_eq!(hp[2], 5.0);
        assert_eq!(progress[0], 1.0);
        assert_eq!(progress[1], 0.5);
        assert_eq!(progress[2], 0.0);

        let mut short = [0.0; 2];
        assert_eq!(
            construction_reconcile_and_grow_pieces(
                10.0,
                1.0,
                &required_energy,
                &required_metal,
                &max_hp,
                &current_hp,
                &previous_progress,
                &starts,
                &alive,
                3,
                &mut short,
                &mut paid_metal,
                &mut complete,
                &mut active,
                &mut hp,
                &mut progress,
            ),
            0
        );
    }

    #[test]
    pub(crate) fn economy_apply_income_credits_batches_by_resource_and_caps_in_order() {
        let players = [1, 1, 2, 1, 0];
        let resources = [
            ECONOMY_RESOURCE_ENERGY_CODE,
            ECONOMY_RESOURCE_ENERGY_CODE,
            ECONOMY_RESOURCE_METAL_CODE,
            ECONOMY_RESOURCE_METAL_CODE,
            ECONOMY_RESOURCE_ENERGY_CODE,
        ];
        let rates = [4.0, 4.0, 3.0, 8.0, 99.0];
        let mut energy_curr = [0.0, 95.0, 10.0];
        let energy_max = [0.0, 100.0, 100.0];
        let mut metal_curr = [0.0, 20.0, 48.0];
        let metal_max = [0.0, 50.0, 50.0];
        let mut accepted = [99.0; 5];

        assert_eq!(
            economy_apply_income_credits(
                &players,
                &resources,
                &rates,
                5,
                1.0,
                &mut energy_curr,
                &energy_max,
                &mut metal_curr,
                &metal_max,
                &mut accepted,
            ),
            3
        );
        assert_eq!(accepted, [4.0, 1.0, 2.0, 8.0, 0.0]);
        assert_eq!(energy_curr, [0.0, 100.0, 10.0]);
        assert_eq!(metal_curr, [0.0, 28.0, 50.0]);

        let mut short = [0.0; 4];
        assert_eq!(
            economy_apply_income_credits(
                &players,
                &resources,
                &rates,
                5,
                1.0,
                &mut energy_curr,
                &energy_max,
                &mut metal_curr,
                &metal_max,
                &mut short,
            ),
            0
        );
    }

    #[test]
    pub(crate) fn economy_converter_transfer_consumes_energy_and_caps_by_metal_headroom() {
        let mut out = [0.0; 4];

        // (energy_convert_at = 0, metal_convert_at = 1) is the historical
        // one-way energy -> metal behavior; these are the legacy vectors.
        assert_eq!(
            economy_compute_converter_transfer(
                10.0, 100.0, 80.0, 100.0, 25.0, 1.0, 0.2, 0.0, 1.0, &mut out
            ),
            1
        );
        assert!((out[0] - 10.0).abs() < 1e-12);
        assert!((out[1] - 8.0).abs() < 1e-12);
        assert_eq!(out[2], ECONOMY_RESOURCE_ENERGY_CODE as f64);
        assert_eq!(out[3], ECONOMY_RESOURCE_METAL_CODE as f64);

        assert_eq!(
            economy_compute_converter_transfer(
                80.0, 100.0, 10.0, 25.0, 50.0, 1.0, 0.5, 0.0, 1.0, &mut out
            ),
            1
        );
        assert!((out[0] - 30.0).abs() < 1e-12);
        assert!((out[1] - 15.0).abs() < 1e-12);
        assert_eq!(out[2], ECONOMY_RESOURCE_ENERGY_CODE as f64);
        assert_eq!(out[3], ECONOMY_RESOURCE_METAL_CODE as f64);

        assert_eq!(
            economy_compute_converter_transfer(
                50.0, 100.0, 50.0, 100.0, 25.0, 1.0, 0.2, 0.0, 1.0, &mut out
            ),
            1
        );
        assert!((out[0] - 25.0).abs() < 1e-12);
        assert!((out[1] - 20.0).abs() < 1e-12);
        assert_eq!(out[2], ECONOMY_RESOURCE_ENERGY_CODE as f64);
        assert_eq!(out[3], ECONOMY_RESOURCE_METAL_CODE as f64);

        let mut short = [0.0; 3];
        assert_eq!(
            economy_compute_converter_transfer(
                10.0, 100.0, 80.0, 100.0, 25.0, 1.0, 0.2, 0.0, 1.0, &mut short
            ),
            0
        );
    }

    #[test]
    pub(crate) fn economy_converter_transfer_is_bidirectional_around_slider_points() {
        let mut out = [0.0; 4];

        // Energy above its point, metal below its point: energy -> metal.
        // Source excess = 90 - 0.75*100 = 15 caps the transfer under the
        // rate; output = 15 * (1 - 0.2) = 12 fits under metal's point.
        assert_eq!(
            economy_compute_converter_transfer(
                90.0, 100.0, 10.0, 100.0, 25.0, 1.0, 0.2, 0.75, 0.75, &mut out
            ),
            1
        );
        assert!((out[0] - 15.0).abs() < 1e-12);
        assert!((out[1] - 12.0).abs() < 1e-12);
        assert_eq!(out[2], ECONOMY_RESOURCE_ENERGY_CODE as f64);
        assert_eq!(out[3], ECONOMY_RESOURCE_METAL_CODE as f64);

        // Metal maxed, energy low: metal -> energy (the direction the old
        // kernel could never take — it returned zeros here).
        assert_eq!(
            economy_compute_converter_transfer(
                10.0, 100.0, 100.0, 100.0, 20.0, 1.0, 0.2, 0.75, 0.75, &mut out
            ),
            1
        );
        assert!((out[0] - 20.0).abs() < 1e-12);
        assert!((out[1] - 16.0).abs() < 1e-12);
        assert_eq!(out[2], ECONOMY_RESOURCE_METAL_CODE as f64);
        assert_eq!(out[3], ECONOMY_RESOURCE_ENERGY_CODE as f64);

        // Destination fills only to ITS slider point, never to storage max:
        // energy 100/100 -> metal 70/100 with metal point 0.75 accepts 5.
        assert_eq!(
            economy_compute_converter_transfer(
                100.0, 100.0, 70.0, 100.0, 50.0, 1.0, 0.2, 0.5, 0.75, &mut out
            ),
            1
        );
        assert!((out[1] - 5.0).abs() < 1e-12);
        assert!((out[0] - 6.25).abs() < 1e-12);
        assert_eq!(out[2], ECONOMY_RESOURCE_ENERGY_CODE as f64);
        assert_eq!(out[3], ECONOMY_RESOURCE_METAL_CODE as f64);

        // Both resources above their points: each destination is at or past
        // its own convert-away point, so NEITHER direction runs (no churn).
        assert_eq!(
            economy_compute_converter_transfer(
                90.0, 100.0, 90.0, 100.0, 25.0, 1.0, 0.2, 0.75, 0.75, &mut out
            ),
            1
        );
        assert_eq!(out[0], 0.0);
        assert_eq!(out[1], 0.0);
        assert_eq!(out[2], ECONOMY_RESOURCE_NONE_CODE as f64);
        assert_eq!(out[3], ECONOMY_RESOURCE_NONE_CODE as f64);

        // Both below their points: nothing is in surplus, nothing converts.
        assert_eq!(
            economy_compute_converter_transfer(
                50.0, 100.0, 50.0, 100.0, 25.0, 1.0, 0.2, 0.75, 0.75, &mut out
            ),
            1
        );
        assert_eq!(out[2], ECONOMY_RESOURCE_NONE_CODE as f64);
        assert_eq!(out[3], ECONOMY_RESOURCE_NONE_CODE as f64);

        // Non-finite slider input fails CLOSED (treated as 1.0 = never).
        assert_eq!(
            economy_compute_converter_transfer(
                100.0,
                100.0,
                10.0,
                100.0,
                25.0,
                1.0,
                0.2,
                f64::NAN,
                0.75,
                &mut out
            ),
            1
        );
        assert_eq!(out[2], ECONOMY_RESOURCE_NONE_CODE as f64);
        assert_eq!(out[3], ECONOMY_RESOURCE_NONE_CODE as f64);
    }

    #[test]
    pub(crate) fn economy_apply_converter_transfers_mutates_stockpiles_and_splits_rows() {
        let players = [1, 1, 2, 1, 0];
        let rates = [10.0, 30.0, 50.0, 10.0, 99.0];
        let mut energy_curr = [0.0, 90.0, 10.0];
        let energy_max = [0.0, 100.0, 100.0];
        let mut metal_curr = [0.0, 10.0, 80.0];
        let metal_max = [0.0, 100.0, 100.0];
        let mut rates_by_player = [77.0; 3];
        let mut consumed_by_player = [77.0; 3];
        let mut output_by_player = [77.0; 3];
        let mut consumed_resource_by_player = [7; 3];
        let mut output_resource_by_player = [7; 3];
        let mut out_consumed = [99.0; 5];
        let mut out_output = [99.0; 5];
        let mut out_consumed_resource = [9; 5];
        let mut out_output_resource = [9; 5];
        // Legacy one-way thresholds: convert energy away from any level,
        // fill metal to storage max.
        let energy_convert_at = [0.0; 3];
        let metal_convert_at = [1.0; 3];

        assert_eq!(
            economy_apply_converter_transfers(
                &players,
                &rates,
                5,
                1.0,
                0.2,
                &energy_convert_at,
                &metal_convert_at,
                &mut energy_curr,
                &energy_max,
                &mut metal_curr,
                &metal_max,
                &mut rates_by_player,
                &mut consumed_by_player,
                &mut output_by_player,
                &mut consumed_resource_by_player,
                &mut output_resource_by_player,
                &mut out_consumed,
                &mut out_output,
                &mut out_consumed_resource,
                &mut out_output_resource,
            ),
            3
        );

        assert_eq!(energy_curr, [0.0, 40.0, 0.0]);
        assert_eq!(metal_curr, [0.0, 50.0, 88.0]);
        assert_eq!(out_consumed, [10.0, 30.0, 10.0, 10.0, 0.0]);
        assert_eq!(out_output, [8.0, 24.0, 8.0, 8.0, 0.0]);
        assert_eq!(
            out_consumed_resource,
            [
                ECONOMY_RESOURCE_ENERGY_CODE,
                ECONOMY_RESOURCE_ENERGY_CODE,
                ECONOMY_RESOURCE_ENERGY_CODE,
                ECONOMY_RESOURCE_ENERGY_CODE,
                ECONOMY_RESOURCE_NONE_CODE,
            ]
        );
        assert_eq!(
            out_output_resource,
            [
                ECONOMY_RESOURCE_METAL_CODE,
                ECONOMY_RESOURCE_METAL_CODE,
                ECONOMY_RESOURCE_METAL_CODE,
                ECONOMY_RESOURCE_METAL_CODE,
                ECONOMY_RESOURCE_NONE_CODE,
            ]
        );

        let mut short = [0.0; 4];
        assert_eq!(
            economy_apply_converter_transfers(
                &players,
                &rates,
                5,
                1.0,
                0.2,
                &energy_convert_at,
                &metal_convert_at,
                &mut energy_curr,
                &energy_max,
                &mut metal_curr,
                &metal_max,
                &mut rates_by_player,
                &mut consumed_by_player,
                &mut output_by_player,
                &mut consumed_resource_by_player,
                &mut output_resource_by_player,
                &mut short,
                &mut out_output,
                &mut out_consumed_resource,
                &mut out_output_resource,
            ),
            0
        );
    }

    /// An inactive mapBoundary stage has to switch off BOTH halves of the
    /// map-edge treatment: the ring override and the divider ridges'
    /// fade-to-flat that only exists to feed it. Otherwise "ring off" is
    /// indistinguishable from a ground-level ring — the divider ridges
    /// still get flattened just short of the map edge.
    #[test]
    pub(crate) fn terrain_inactive_map_boundary_runs_the_divider_ridges_to_the_map_edge() {
        // Ridges only (no CENTER dome, no RING annulus), so any height at
        // the sample point is the DIVIDERS contribution and nothing else.
        let base_config = [
            0.0,     // center_magnitude
            300.0,   // dividers_magnitude
            0.0,     // terrain_d_terrain (plateau off)
            0.0,     // perimeter_magnitude (ground-level ring)
            2.0,     // team_count
            -1200.0, // tile_floor_y
            0.5,     // perimeter_outer_radius_fraction
            0.4,     // perimeter_inner_radius_fraction
            0.01,    // generation_edge_transition_width_fraction
            0.99,    // plateau_shelf_fraction_of_step
            1.0,     // plateau_ramp_edge_sharpness
            0.4,     // center_radius_fraction
            0.0,     // ring_magnitude
            0.2,     // ring_crest_radius_fraction
            0.4,     // ring_outer_radius_fraction
            0.1, 0.4, 0.08, // ridge inner/outer/half-width fractions
            89.0, // plateau_wall_slope_degrees
            // Pipeline stage order (PERIMETER precedence: dividerRidges
            // before mapBoundary), all active.
            0.0, 7.0, 6.0, 1.0, 2.0, 3.0, 4.0, 5.0,
        ];
        // Same slice with the mapBoundary stage (code 1, slot 3) marked
        // inactive — what an authored `active: false` packs to.
        let mut none_config = base_config;
        none_config[22] = 1.0 + 8.0;

        let map = 2048.0;
        let flat_zones: [f64; 0] = [];
        // On the first ridge, far outside the perimeter band: a point on the
        // +x axis is halfway between the two team sides of a 2-team layout.
        let sample = [map * 0.99, map * 0.5, f64::NAN];

        let mut ring_height = [0.0f64; 1];
        assert_eq!(
            metal_deposit_resolve_terrain_heights(
                map,
                map,
                0.85,
                &base_config,
                &flat_zones,
                &sample,
                &mut ring_height,
            ),
            1
        );
        let mut none_height = [0.0f64; 1];
        assert_eq!(
            metal_deposit_resolve_terrain_heights(
                map,
                map,
                0.85,
                &none_config,
                &flat_zones,
                &sample,
                &mut none_height,
            ),
            1
        );

        // A ground-level ring flattens the ridge away at the map edge...
        assert!(
            ring_height[0].abs() < 1e-9,
            "PERIMETER 0 must flatten the map edge to the ring altitude; got {}",
            ring_height[0],
        );
        // ...while an inactive ring stage carries the full DIVIDERS
        // amplitude out to it.
        assert!(
            (none_height[0] - 300.0).abs() < 1e-9,
            "an inactive mapBoundary stage must run the divider ridge to the \
             map edge at full amplitude; got {}",
            none_height[0],
        );
    }

    /// DIVIDERS precedence (dividerRidges ordered after mapBoundary) must run
    /// a ridge out to the map edge at its own full amplitude — suppressing the
    /// ring across the ridge width — while the ring keeps full effect between
    /// the ridges.
    #[test]
    pub(crate) fn terrain_dividers_precedence_punches_the_ridge_through_the_ring() {
        let config = [
            0.0,     // center_magnitude
            300.0,   // dividers_magnitude
            0.0,     // terrain_d_terrain (plateau off)
            -400.0,  // perimeter_magnitude (below-water ring)
            2.0,     // team_count
            -1200.0, // tile_floor_y
            0.5,     // perimeter_outer_radius_fraction
            0.4,     // perimeter_inner_radius_fraction
            0.01,    // generation_edge_transition_width_fraction
            0.99,    // plateau_shelf_fraction_of_step
            1.0,     // plateau_ramp_edge_sharpness
            0.4,     // center_radius_fraction
            0.0,     // ring_magnitude
            0.2,     // ring_crest_radius_fraction
            0.4,     // ring_outer_radius_fraction
            0.1, 0.4, 0.08, // ridge inner/outer/half-width fractions
            89.0, // plateau_wall_slope_degrees
            // Pipeline stage order (DIVIDERS precedence: dividerRidges
            // after mapBoundary), all active.
            0.0, 7.0, 1.0, 2.0, 3.0, 4.0, 5.0, 6.0,
        ];

        let map = 2048.0;
        let flat_zones: [f64; 0] = [];
        // Ridge centreline at the map edge (2-team layout: the +x axis is
        // halfway between the two sides), and an off-ridge edge point on a
        // side centreline (straight up the -y axis).
        let samples = [
            map * 0.99,
            map * 0.5,
            f64::NAN,
            map * 0.5,
            map * 0.01,
            f64::NAN,
        ];
        let mut heights = [0.0f64; 2];
        assert_eq!(
            metal_deposit_resolve_terrain_heights(
                map,
                map,
                0.85,
                &config,
                &flat_zones,
                &samples,
                &mut heights,
            ),
            2
        );

        assert!(
            (heights[0] - 300.0).abs() < 1e-9,
            "DIVIDERS precedence must run the ridge to the map edge at full \
             amplitude through the ring; got {}",
            heights[0],
        );
        assert!(
            (heights[1] - -400.0).abs() < 1e-9,
            "between the ridges the ring must keep its full override; got {}",
            heights[1],
        );
    }

    /// CENTER is a single cosine dome anchored at the map centre (whose
    /// height IS the bar magnitude) and returning to baseline at the dome
    /// radius; RING is two cosine shoulders — baseline at the centre, full
    /// magnitude at crest radius A, baseline again at outer radius B. The
    /// two sum independently.
    #[test]
    pub(crate) fn terrain_center_dome_and_ring_annulus_compose() {
        let config = [
            500.0,   // center_magnitude
            0.0,     // dividers_magnitude
            0.0,     // terrain_d_terrain (plateau off)
            0.0,     // perimeter_magnitude (ground-level ring)
            2.0,     // team_count
            -1200.0, // tile_floor_y
            0.5,     // perimeter_outer_radius_fraction
            0.4,     // perimeter_inner_radius_fraction
            0.01,    // generation_edge_transition_width_fraction
            0.99,    // plateau_shelf_fraction_of_step
            1.0,     // plateau_ramp_edge_sharpness
            0.3,     // center_radius_fraction
            200.0,   // ring_magnitude
            0.2,     // ring_crest_radius_fraction (A)
            0.4,     // ring_outer_radius_fraction (B)
            0.1, 0.4, 0.08, // ridge inner/outer/half-width fractions
            89.0, // plateau_wall_slope_degrees
            // Pipeline stage order (PERIMETER precedence), all active.
            0.0, 7.0, 6.0, 1.0, 2.0, 3.0, 4.0, 5.0,
        ];

        let map = 2048.0;
        let extent = 0.85;
        let min_dim = map * extent;
        let cx = map * 0.5;
        let flat_zones: [f64; 0] = [];
        // Off the divider centrelines (2-team ridges run along +x/-x): sample
        // straight up the -y axis where dividers contribute nothing anyway
        // (dividers_magnitude is 0 here regardless).
        let samples = [
            cx,
            cx, // map centre
            f64::NAN,
            cx,
            cx - min_dim * 0.2, // ring crest (A)
            f64::NAN,
            cx,
            cx - min_dim * 0.3, // dome edge + ring outer-shoulder midpoint
            f64::NAN,
            cx,
            cx - min_dim * 0.45, // beyond B: baseline
            f64::NAN,
        ];
        let mut heights = [0.0f64; 4];
        assert_eq!(
            metal_deposit_resolve_terrain_heights(
                map,
                map,
                extent,
                &config,
                &flat_zones,
                &samples,
                &mut heights,
            ),
            4
        );

        assert!(
            (heights[0] - 500.0).abs() < 1e-6,
            "map centre must sit at the CENTER magnitude; got {}",
            heights[0],
        );
        // At the crest (r = 2/3 of the dome radius) the dome contributes
        // 500 * (1 + cos(2*pi/3)) / 2 = 125, the ring its full 200.
        assert!(
            (heights[1] - 325.0).abs() < 1e-6,
            "ring crest must add full RING magnitude onto the dome; got {}",
            heights[1],
        );
        // At r = dome radius the dome is back to baseline; the ring's outer
        // shoulder midpoint is at half magnitude.
        assert!(
            (heights[2] - 100.0).abs() < 1e-6,
            "ring outer-shoulder midpoint must be half the RING magnitude; got {}",
            heights[2],
        );
        assert!(
            heights[3].abs() < 1e-6,
            "beyond the ring's outer radius the surface must be baseline; got {}",
            heights[3],
        );
    }

    #[test]
    pub(crate) fn terrain_adaptive_mesh_build_is_deterministic_and_conforming() {
        // 27-value generation slice: round-island perimeter (negative
        // magnitude), 2 teams, CENTER dome + RING annulus + divider ridge
        // so the LOD walk actually varies triangle sizes.
        let terrain_config = [
            40.0,    // center_magnitude
            30.0,    // dividers_magnitude
            0.0,     // terrain_d_terrain (plateau off)
            -400.0,  // perimeter_magnitude (negative = below-water rim)
            2.0,     // team_count
            -1200.0, // tile_floor_y
            0.49,    // perimeter_outer_radius_fraction
            0.39,    // perimeter_inner_radius_fraction
            0.04,    // generation_edge_transition_width_fraction
            0.99,    // plateau_shelf_fraction_of_step
            1.0,     // plateau_ramp_edge_sharpness
            0.25,    // center_radius_fraction
            30.0,    // ring_magnitude
            0.2,     // ring_crest_radius_fraction
            0.38,    // ring_outer_radius_fraction
            0.1, 0.4, 0.08, // ridge inner/outer/half-width fractions
            89.0, // plateau_wall_slope_degrees
            // Pipeline stage order (PERIMETER precedence), all active.
            0.0, 7.0, 6.0, 1.0, 2.0, 3.0, 4.0, 5.0,
        ];
        // 10-value LOD slice mirroring terrainConfig.json defaults.
        let lod_config = [
            0.0,    // max_surface_error
            0.951,  // min_normal_dot (~18 deg)
            1.0,    // max_neighbor_level_delta
            1.0,    // preserve_waterline
            1.0,    // sample_centroid
            -120.0, // water_level
            1000.0, // vertex_key_scale
            3.0,    // final_repair_max_passes
            0.0,    // smoothing_steps
            0.5,    // smoothing_amount
        ];
        let flat_zones: [f64; 0] = [];
        let cells = 12i32;
        let cell_size = 64.0;
        let map = cells as f64 * cell_size;
        let extent = 0.92;

        let a = terrain_build_adaptive_mesh(
            map,
            map,
            cell_size,
            cells,
            cells,
            4,
            extent,
            &terrain_config,
            &flat_zones,
            &lod_config,
        );
        let b = terrain_build_adaptive_mesh(
            map,
            map,
            cell_size,
            cells,
            cells,
            4,
            extent,
            &terrain_config,
            &flat_zones,
            &lod_config,
        );

        assert_eq!(a[0], 1.0, "build reports success");
        assert_eq!(a, b, "mesh build is deterministic across runs");

        let v = a[1] as usize;
        let t = a[2] as usize;
        let cell_offsets_len = a[3] as usize;
        let refs = a[4] as usize;
        assert!(v >= 3, "produced vertices");
        assert!(t >= 1, "produced triangles");
        assert_eq!(cell_offsets_len, (cells * cells) as usize + 1);

        let header = 5usize;
        let coords_start = header;
        let heights_start = coords_start + 2 * v;
        let tri_start = heights_start + v;
        let levels_start = tri_start + 3 * t;
        let wall_flags_start = levels_start + t;
        let neighbor_idx_start = wall_flags_start + t;
        let neighbor_lvl_start = neighbor_idx_start + 3 * t;
        let cell_off_start = neighbor_lvl_start + 3 * t;
        let cell_idx_start = cell_off_start + cell_offsets_len;
        assert_eq!(
            a.len(),
            cell_idx_start + refs,
            "packed buffer length matches header",
        );

        for k in 0..v {
            assert!(a[heights_start + k].is_finite(), "vertex height finite");
        }
        for k in 0..(3 * t) {
            let idx = a[tri_start + k] as i64;
            assert!(idx >= 0 && (idx as usize) < v, "triangle index in range");
        }
        for k in 0..t {
            let wall_flag = a[wall_flags_start + k] as i64;
            assert!(
                wall_flag == 0 || wall_flag == 1,
                "triangle wall flag is boolean"
            );
        }
        // Every cell-triangle ref points at a real triangle.
        for k in 0..refs {
            let tri = a[cell_idx_start + k] as i64;
            assert!(tri >= 0 && (tri as usize) < t, "cell triangle ref in range");
        }
    }

    #[test]
    pub(crate) fn terrain_water_probe_masks_mark_center_water_and_compass_dry_bits() {
        let _guard = lock_tests();
        let cell_size = 100.0;
        let cells_x = 2;
        let cells_y = 1;
        let vertex_coords = [
            0.0, 0.0, 100.0, 0.0, 200.0, 0.0, 0.0, 100.0, 100.0, 100.0, 200.0, 100.0,
        ];
        let vertex_heights = [-200.0, -200.0, 0.0, -200.0, -200.0, 0.0];
        let triangle_indices = [0, 1, 4, 0, 4, 3, 1, 2, 5, 1, 5, 4];
        let triangle_levels = [0, 0, 0, 0];
        let neighbor_indices = vec![-1; triangle_indices.len()];
        let neighbor_levels = vec![-1; triangle_indices.len()];
        let cell_triangle_offsets = [0, 2, 4];
        let cell_triangle_indices = [0, 1, 2, 3];
        terrain_clear();
        terrain_install_mesh(
            &vertex_coords,
            &vertex_heights,
            &triangle_indices,
            &triangle_levels,
            &neighbor_indices,
            &neighbor_levels,
            &cell_triangle_offsets,
            &cell_triangle_indices,
            200.0,
            100.0,
            cell_size,
            1,
            cells_x,
            cells_y,
        );

        let centers_x = [75.0];
        let centers_y = [50.0];
        let probe_radii = [130.0];
        let mut center_water = [0_u32];
        let mut dry_masks = [0_u32];

        assert_eq!(
            terrain_sample_water_probe_masks(
                &centers_x,
                &centers_y,
                &probe_radii,
                &mut center_water,
                &mut dry_masks,
            ),
            1,
        );
        assert_eq!(center_water[0], 1);
        assert_ne!(dry_masks[0] & 0b0000_0001, 0, "east probe reaches dry land");
        assert_eq!(dry_masks[0] & 0b0001_0000, 0, "west probe remains water");
    }

    #[test]
    pub(crate) fn blueprint_manifest_includes_authored_tables() {
        assert!(blueprint_tables::BLUEPRINT_UNITS_COUNT > 0);
        assert!(blueprint_tables::BLUEPRINT_BUILDINGS_COUNT > 0);
        assert!(blueprint_tables::BLUEPRINT_TURRETS_COUNT > 0);
        assert!(blueprint_tables::BLUEPRINT_SHOTS_COUNT > 0);
        assert!(blueprint_tables::BLUEPRINT_BUILDABLE_UNIT_COUNT > 0);
        assert!(blueprint_tables::BLUEPRINT_UNIT_IDS.contains(&"unitJackal"));
        assert!(blueprint_tables::BLUEPRINT_BUILDING_IDS.contains(&"buildingSolar"));
        assert!(blueprint_tables::BLUEPRINT_BUILDING_IDS.contains(&"towerFabricator"));
        assert!(blueprint_tables::BLUEPRINT_TURRET_BLUEPRINT_IDS.contains(&"turretGunLight"));
    }

    #[test]
    pub(crate) fn intermediate_waypoints_use_normalized_thrust() {
        let (x, y, active) = compute_arrival_control_thrust(
            3.0,
            4.0,
            5.0,
            100.0,
            0.0,
            0.0,
            0.0,
            10.0,
            100.0,
            1_000_000.0,
            0,
            1.0 / 30.0,
            20.0,
            0.22,
            0.001,
            1.0,
            10.0,
        );
        assert_eq!(active, 1);
        assert!((x - 0.6).abs() < 1e-12);
        assert!((y - 0.8).abs() < 1e-12);
    }

    #[test]
    pub(crate) fn final_waypoint_pd_tracks_a_nonzero_guard_velocity() {
        let (x, y, active) = compute_arrival_control_thrust(
            10.0,
            0.0,
            10.0,
            0.0,
            10.0,
            0.0,
            10.0,
            10.0,
            100.0,
            1_000_000.0,
            ARRIVAL_FLAG_LAST_ACTION,
            1.0 / 30.0,
            20.0,
            0.22,
            0.001,
            1.0,
            10.0,
        );
        assert_eq!(active, 1);
        assert!(
            x > 0.0,
            "position error must still pull toward the moving formation goal"
        );
        assert!(
            y.abs() < 1e-12,
            "matching the target velocity must not brake that velocity"
        );
    }

    #[test]
    pub(crate) fn sharp_corner_brakes_an_overspeed_approach() {
        // 90° bend (cos 0), corridor 10, max_accel = 100·1e6/1e6 = 100:
        // corner speed = sqrt(2·100·10/1) ≈ 44.7; allowed at distance 5 is
        // sqrt(2000 + 1000) ≈ 54.8. Closing at 200 → full reverse brake.
        let (x, y, active) = compute_arrival_control_thrust(
            5.0,
            0.0,
            5.0,
            200.0,
            0.0,
            0.0,
            0.0,
            10.0,
            100.0,
            1_000_000.0,
            0,
            1.0 / 30.0,
            20.0,
            0.22,
            0.001,
            0.0,
            10.0,
        );
        assert_eq!(active, 1);
        assert!((x - -1.0).abs() < 1e-12, "brakes against velocity, got {x}");
        assert!(y.abs() < 1e-12);
    }

    #[test]
    pub(crate) fn sharp_corner_keeps_full_thrust_below_the_cap() {
        // Same corner, closing at 30 < 0.9·allowed → full thrust toward it.
        let (x, y, active) = compute_arrival_control_thrust(
            5.0,
            0.0,
            5.0,
            30.0,
            0.0,
            0.0,
            0.0,
            10.0,
            100.0,
            1_000_000.0,
            0,
            1.0 / 30.0,
            20.0,
            0.22,
            0.001,
            0.0,
            10.0,
        );
        assert_eq!(active, 1);
        assert!((x - 1.0).abs() < 1e-12);
        assert!(y.abs() < 1e-12);
    }

    #[test]
    pub(crate) fn shallow_bends_never_engage_corner_shaping() {
        // cos(bend) = 0.95 (≈18°) is gentler than the shaping threshold:
        // even a hot approach keeps full thrust.
        let (x, _y, active) = compute_arrival_control_thrust(
            5.0,
            0.0,
            5.0,
            500.0,
            0.0,
            0.0,
            0.0,
            10.0,
            100.0,
            1_000_000.0,
            0,
            1.0 / 30.0,
            20.0,
            0.22,
            0.001,
            0.95,
            10.0,
        );
        assert_eq!(active, 1);
        assert!((x - 1.0).abs() < 1e-12);
    }

    #[test]
    pub(crate) fn water_surface_support_scales_with_medium_occupancy() {
        let inverse_force = 120.0_f64;
        let proportional_force = 80.0_f64;
        let full_force = inverse_force + proportional_force;
        assert!((full_force - 200.0).abs() < 1e-12);
        assert!((full_force * 0.5 - 100.0).abs() < 1e-12);
    }

    #[test]
    pub(crate) fn stuck_replan_step_resets_when_body_is_moving() {
        let (ticks, should_replan) =
            compute_stuck_replan_step(5.0, 0.0, 31, 100.0, 0.0, 0, 5.0, 30, 30.0);
        assert_eq!(ticks, 0);
        assert_eq!(should_replan, 0);
    }

    #[test]
    pub(crate) fn stuck_replan_step_counts_down_cooldown_before_motion_reset() {
        let (ticks, should_replan) =
            compute_stuck_replan_step(5.0, 0.0, -150, 100.0, 0.0, 0, 5.0, 30, 30.0);
        assert_eq!(ticks, -149);
        assert_eq!(should_replan, 0);
    }

    #[test]
    pub(crate) fn stuck_replan_step_resets_when_settling_at_final_waypoint() {
        let (ticks, should_replan) = compute_stuck_replan_step(
            0.0,
            0.0,
            31,
            10.0,
            0.0,
            STUCK_REPLAN_FLAG_SETTLING_CHECK,
            5.0,
            30,
            30.0,
        );
        assert_eq!(ticks, 0);
        assert_eq!(should_replan, 0);
    }

    #[test]
    pub(crate) fn stuck_replan_step_increments_and_flags_after_threshold() {
        let (ticks, should_replan) =
            compute_stuck_replan_step(0.0, 0.0, 30, 100.0, 0.0, 0, 5.0, 30, 30.0);
        assert_eq!(ticks, 31);
        assert_eq!(should_replan, 1);
    }

    #[test]
    pub(crate) fn ground_normal_step_blends_and_renormalizes() {
        let (nx, ny, nz) = compute_unit_ground_normal_step(0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 0.5);
        let inv_sqrt_2 = 1.0 / 2.0_f64.sqrt();
        assert!((nx - inv_sqrt_2).abs() < 1e-12);
        assert!(ny.abs() < 1e-12);
        assert!((nz - inv_sqrt_2).abs() < 1e-12);
    }

    #[test]
    pub(crate) fn ground_normal_step_snaps_at_full_alpha() {
        let (nx, ny, nz) = compute_unit_ground_normal_step(0.0, 0.0, 1.0, 0.25, 0.5, 0.75, 1.0);
        assert_eq!((nx, ny, nz), (0.25, 0.5, 0.75));
    }
}

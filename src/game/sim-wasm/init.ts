// rts-sim-wasm init — singleton loader.
//
// This module is the ONLY place either the server tick or the
// renderer should obtain the WASM handle from.
// Both await `initSimWasm()`; concurrent awaiters share one fetch
// + compile via the module-scope Promise cache below.
//
// The WASM artifacts under `./pkg/` are produced by
// `npm run build:wasm` (which calls `wasm-pack build --release
// --target web --out-dir ../src/game/sim-wasm/pkg` from the
// `rts-sim-wasm/` crate at the repo root). They are gitignored —
// `npm run build` runs the wasm build first; `npm run dev`
// reuses whatever pkg/ already contains, so run `build:wasm`
// once after a fresh clone and re-run after any Rust edit.

import __wbg_init, {
  type InitInput,
  version,
  deterministic_math_sin,
  deterministic_math_cos,
  deterministic_math_atan2,
  deterministic_math_sqrt,
  deterministic_math_exp,
  deterministic_math_hypot2,
  deterministic_math_hypot3,
  deterministic_math_pow,
  deterministic_math_ln,
  deterministic_math_log2,
  deterministic_math_tan,
  deterministic_math_asin,
  wind_sample_state,
  build_target_horizontal_distance,
  commander_apply_reclaim_tick,
  factory_build_spot,
  factory_build_spot_blocked,
  factory_plan_production_actions,
  building_active_state_step_batch,
  economy_accumulate_player_rates,
  economy_compute_converter_transfer,
  economy_credit_stockpile,
  economy_debit_stockpile,
  economy_apply_equal_consumer_debits,
  construction_apply_coupled_consumer_debits,
  construction_reconcile_and_grow_pieces,
  construction_apply_consumer_spends,
  construction_decay_step,
  damage_area_overlap_batch,
  damage_area_candidates_batch,
  damage_area_turret_candidates_batch,
  damage_death_explosion_candidates_batch,
  death_explosion_planner_reset,
  death_explosion_planner_seed,
  death_explosion_planner_append_kills,
  death_explosion_planner_next,
  damage_apply_batch,
  damage_closest_body_segment_hit_t,
  damage_find_closest_body_segment_hit,
  damage_segment_candidates_batch,
  damage_segment_hits_batch,
  death_cleanup_diff_batch,
  economy_apply_income_credits,
  economy_apply_converter_transfers,
  arrival_completion_step_batch,
  unit_effective_drive_acceleration,
  airborne_loiter_step_batch,
  waypoint_orbit_steer_batch,
  stuck_replan_step_batch,
  unit_action_plan_batch,
  unit_action_movement_batch,
  articulation_joint_step_batch,
  articulation_yaw_step_batch,
  pool_init,
  pool_capacity,
  pool_alloc_slot,
  pool_live_count,
  pool_free_slot,
  pool_prepare_dynamic_step,
  pool_collect_awake_entity_ids,
  pool_finalize_dynamic_step,
  pool_step_integrate,
  pool_resolve_sphere_sphere,
  pool_resolve_sphere_sphere_active,
  engine_statics_create,
  engine_statics_destroy,
  engine_statics_add,
  engine_statics_remove,
  pool_resolve_sphere_cuboid_full,
  unit_force_surface_lift_inverse_distance_response,
  unit_force_water_surface_depth_world,
  unit_force_water_fraction,
  unit_force_runtime_clear,
  unit_water_damage_step_pool,
  unit_water_damaged_entity_slots_ptr,
  render_unit_pose_compute,
  render_unit_pose_input_scratch_ptr,
  render_unit_pose_output_scratch_ptr,
  render_unit_pose_scratch_ensure,
  presentation_clear,
  presentation_capture_tick,
  presentation_latest_tick,
  presentation_has_history,
  presentation_slot_input_scratch_ptr,
  presentation_pose_output_scratch_ptr,
  presentation_turret_output_scratch_ptr,
  presentation_scratch_ensure,
  presentation_interpolate,
  render_projectile_axis_compute,
  render_projectile_axis_input_scratch_ptr,
  render_projectile_axis_output_scratch_ptr,
  render_projectile_axis_scratch_ensure,
  render_plasma_arc_pose_compute,
  render_plasma_arc_pose_input_scratch_ptr,
  render_plasma_arc_pose_output_scratch_ptr,
  render_plasma_arc_pose_scratch_ensure,
  render_airborne_emitter_compute,
  render_airborne_emitter_input_scratch_ptr,
  render_airborne_emitter_output_scratch_ptr,
  render_airborne_emitter_scratch_ensure,
  render_building_pose_compute,
  render_building_pose_input_scratch_ptr,
  render_building_pose_output_scratch_ptr,
  render_building_pose_scratch_ensure,
  render_chassis_part_compute,
  render_chassis_part_input_scratch_ptr,
  render_chassis_part_output_scratch_ptr,
  render_chassis_part_scratch_ensure,
  render_shield_panel_compute,
  render_shield_panel_input_scratch_ptr,
  render_shield_panel_output_scratch_ptr,
  render_shield_panel_scratch_ensure,
  render_turret_barrel_compute,
  render_turret_barrel_input_scratch_ptr,
  render_turret_barrel_output_scratch_ptr,
  render_turret_barrel_scratch_ensure,
  render_turret_head_compute,
  render_turret_head_input_scratch_ptr,
  render_turret_head_output_scratch_ptr,
  render_turret_head_scratch_ensure,
  render_turret_aim_compute,
  render_turret_aim_input_scratch_ptr,
  render_turret_aim_output_scratch_ptr,
  render_turret_aim_scratch_ensure,
  unit_force_step_batch,
  unit_force_staging_ensure,
  unit_force_staging_slots_ptr,
  unit_force_staging_flags_ptr,
  unit_force_staging_rows_ptr,
  unit_force_staging_out_flags_ptr,
  unit_force_step_batch_staged,
  unit_force_profile_ensure,
  unit_force_profile_values_ptr,
  unit_force_profile_flags_ptr,
  projectile_pool_init,
  projectile_pool_capacity,
  projectile_pool_pos_x_ptr,
  projectile_pool_pos_y_ptr,
  projectile_pool_pos_z_ptr,
  projectile_pool_vel_x_ptr,
  projectile_pool_vel_y_ptr,
  projectile_pool_vel_z_ptr,
  projectile_pool_time_alive_ptr,
  projectile_pool_source_turret_entity_id_ptr,
  projectile_pool_source_host_id_ptr,
  projectile_pool_source_root_id_ptr,
  projectile_pool_source_player_id_ptr,
  projectile_pool_source_team_id_ptr,
  projectile_pool_source_turret_blueprint_code_ptr,
  projectile_pool_source_shot_blueprint_code_ptr,
  projectile_pool_spawn_tick_ptr,
  projectile_pool_parent_shot_entity_id_ptr,
  pool_step_packed_projectiles_batch,
  projectile_integrate_step_batch,
  projectile_homing_guidance_batch,
  projectile_homing_guidance_apply_batch,
  line_shot_distance_to_range_volume,
  line_shot_range_endpoint,
  terrain_follow_vertical_thrust_accel,
  solve_kinematic_intercept,
  compute_homing_thrust,
  compute_constant_speed_homing_velocity,
  metal_deposit_count_placements,
  metal_deposit_generate_placements,
  metal_deposit_resolve_terrain_heights,
  metal_deposit_count_placement_candidates,
  metal_deposit_grow_metal_cells,
  metal_deposit_scatter_metal_cells,
  metal_deposit_bake_surface_field,
  terrain_sample_map_boundary_fades,
  vegetation_clear,
  vegetation_generate,
  vegetation_count,
  vegetation_read_props,
  vegetation_prop_state,
  vegetation_query_circle,
  vegetation_raycast,
  vegetation_apply_reclaim_tick,
  vegetation_removed_count,
  vegetation_read_removed,
  vegetation_state_hash,
  terrain_install_mesh,
  terrain_clear,
  terrain_is_installed,
  terrain_count_cell_triangle_refs,
  terrain_fill_cell_triangle_indices,
  terrain_build_adaptive_mesh,
  terrain_get_bed_height,
  terrain_get_bed_normal,
  terrain_get_surface_height,
  terrain_get_surface_normal,
  terrain_sample_bed_heights,
  terrain_sample_ground_for_slots,
  terrain_sample_force_support_for_slots,
  terrain_sample_water_probe_masks,
  terrain_bake_buildability_grid,
  terrain_has_line_of_sight,
  fog_mark_circle_scanline,
  fog_mark_circle_scanline_rgba,
  combat_has_line_of_sight,
  entity_state_init,
  entity_state_clear,
  entity_state_ensure_capacity,
  entity_state_unset_slot,
  entity_state_capacity,
  entity_state_set_lifecycle,
  entity_state_set_transform,
  entity_state_set_velocity,
  entity_state_set_unit_motion,
  entity_state_set_unit_drive_input,
  entity_state_set_ownership,
  entity_state_set_hp_build,
  entity_state_set_static_shape,
  entity_state_set_body_slot,
  entity_state_collect_body_entity_slots,
  entity_state_sync_body_motion,
  entity_state_sync_entity_body_motion,
  entity_state_set_blueprints,
  entity_state_mark_dirty,
  entity_state_clear_dirty,
  entity_state_collect_dirty_slots,
  entity_state_collect_awake_body_entity_slots,
  entity_state_collect_awake_unit_body_entity_slots,
  entity_state_sort_slots_by_entity_id,
  entity_state_set_projectiles_hot_batch,
  entity_state_entity_id_ptr,
  entity_state_kind_ptr,
  entity_state_flags_ptr,
  entity_state_owner_player_id_ptr,
  entity_state_team_id_ptr,
  entity_state_pos_x_ptr,
  entity_state_pos_y_ptr,
  entity_state_pos_z_ptr,
  entity_state_rotation_ptr,
  entity_state_vel_x_ptr,
  entity_state_vel_y_ptr,
  entity_state_vel_z_ptr,
  entity_state_surface_normal_x_ptr,
  entity_state_surface_normal_y_ptr,
  entity_state_surface_normal_z_ptr,
  entity_state_orientation_x_ptr,
  entity_state_orientation_y_ptr,
  entity_state_orientation_z_ptr,
  entity_state_orientation_w_ptr,
  entity_state_angular_velocity_x_ptr,
  entity_state_angular_velocity_y_ptr,
  entity_state_angular_velocity_z_ptr,
  entity_state_unit_motion_flags_ptr,
  entity_state_unit_thrust_dir_x_ptr,
  entity_state_unit_thrust_dir_y_ptr,
  entity_state_unit_heading_dir_x_ptr,
  entity_state_unit_heading_dir_y_ptr,
  entity_state_hp_ptr,
  entity_state_max_hp_ptr,
  entity_state_radius_collision_ptr,
  entity_state_radius_hitbox_ptr,
  entity_state_radius_other_ptr,
  entity_state_aabb_hx_ptr,
  entity_state_aabb_hy_ptr,
  entity_state_aabb_hz_ptr,
  entity_state_body_slot_ptr,
  entity_state_unit_blueprint_code_ptr,
  entity_state_building_blueprint_code_ptr,
  entity_state_shot_blueprint_code_ptr,
  entity_state_projectile_type_code_ptr,
  entity_state_build_progress_ptr,
  entity_state_build_paid_energy_ptr,
  entity_state_build_paid_metal_ptr,
  entity_state_build_flags_ptr,
  entity_state_dirty_mask_ptr,
  spatial_init,
  spatial_clear,
  spatial_alloc_slot,
  spatial_free_slot,
  spatial_set_entity_id,
  spatial_set_unit,
  spatial_set_projectile,
  spatial_set_projectiles_batch,
  spatial_set_building,
  spatial_unset_slot,
  spatial_query_units_in_radius,
  spatial_query_buildings_in_radius,
  spatial_query_units_and_buildings_in_radius,
  spatial_query_units_and_buildings_in_rect_2d,
  spatial_query_enemy_entities_in_radius,
  spatial_query_enemy_entities_in_circle_2d,
  spatial_query_units_along_line,
  spatial_query_buildings_along_line,
  spatial_query_projectiles_along_line,
  spatial_query_entities_along_line,
  spatial_query_enemy_units_in_radius,
  spatial_query_enemy_projectiles_in_radius,
  spatial_query_enemy_units_and_projectiles_in_radius,
  spatial_scratch_ptr,
  spatial_scratch_len,
  spatial_slot_kind,
  pathfinder_init,
  pathfinder_compute_locomotion_climb_profile,
  pathfinder_rebuild_terrain_mask_and_cc,
  pathfinder_bake_traversability_grid,
  pathfinder_sync_building_occupancy,
  pathfinder_building_occupancy_version,
  pathfinder_find_path,
  pathfinder_find_path_slice,
  pathfinder_cancel_path_slice,
  pathfinder_cancel_all_path_slices,
  pathfinder_last_result_status,
  pathfinder_last_search_strategy,
  pathfinder_last_fine_expanded_nodes,
  pathfinder_last_fine_expanded_nodes_this_slice,
  pathfinder_last_coarse_expanded_nodes,
  pathfinder_last_coarse_refinement_passes,
  pathfinder_last_coarse_exact_edge_checks,
  pathfinder_last_coarse_full_cluster_scans,
  pathfinder_last_fine_hit_node_limit,
  pathfinder_last_smoothing_line_checks,
  pathfinder_last_direct_cost_ratio,
  pathfinder_validate_path,
  pathfinder_waypoints_ptr,
  pathfinder_grid_size_w,
  pathfinder_grid_size_h,
  messagepack_self_test,
  turret_pool_init,
  turret_pool_clear,
  turret_pool_max_per_entity,
  turret_pool_set_count,
  turret_pool_set_turret,
  turret_pool_unset_entity,
  turret_pool_count,
  turret_pool_entity_capacity,
  turret_pool_count_per_entity_ptr,
  turret_pool_entity_id_ptr,
  turret_pool_parent_id_ptr,
  turret_pool_root_host_id_ptr,
  turret_pool_mount_index_ptr,
  turret_pool_rotation_ptr,
  turret_pool_angular_velocity_ptr,
  turret_pool_angular_acceleration_ptr,
  turret_pool_pitch_ptr,
  turret_pool_pitch_velocity_ptr,
  turret_pool_pitch_acceleration_ptr,
  turret_pool_shield_range_ptr,
  turret_pool_target_id_ptr,
  combat_targeting_init,
  combat_targeting_clear,
  combat_targeting_begin_stamp,
  combat_targeting_max_turrets_per_entity,
  combat_targeting_entity_capacity,
  combat_targeting_set_entity,
  combat_targeting_unset_entity,
  combat_targeting_rebuild_observation_masks,
  combat_targeting_rebuild_observation_masks_for_sources,
  combat_targeting_collect_observation_visibility,
  combat_targeting_add_sensor_observation_circle,
  combat_targeting_set_wind,
  combat_targeting_set_turret,
  combat_targeting_update_mount_kinematics,
  combat_targeting_update_mount_kinematics_batch,
  combat_targeting_entity_flags,
  combat_targeting_turret_count,
  combat_targeting_can_player_observe_entity,
  combat_targeting_halt_decision_batch,
  combat_targeting_entity_id_ptr,
  combat_targeting_entity_owner_player_id_ptr,
  combat_targeting_entity_pos_x_ptr,
  combat_targeting_entity_pos_y_ptr,
  combat_targeting_entity_pos_z_ptr,
  combat_targeting_entity_vel_x_ptr,
  combat_targeting_entity_vel_y_ptr,
  combat_targeting_entity_vel_z_ptr,
  combat_targeting_entity_radius_hitbox_ptr,
  combat_targeting_entity_hp_ptr,
  combat_targeting_entity_flags_ptr,
  combat_targeting_entity_active_turret_mask_ptr,
  combat_targeting_entity_firing_turret_mask_ptr,
  combat_targeting_entity_team_air_sight_mask_ptr,
  combat_targeting_entity_team_water_sight_mask_ptr,
  combat_targeting_entity_team_air_radar_mask_ptr,
  combat_targeting_entity_team_water_sonar_mask_ptr,
  combat_targeting_entity_sensor_coverage_mask_ptr,
  combat_targeting_entity_full_sight_coverage_mask_ptr,
  combat_targeting_entity_detector_coverage_mask_ptr,
  combat_targeting_turret_count_per_entity_ptr,
  combat_targeting_turret_entity_id_ptr,
  combat_targeting_turret_parent_id_ptr,
  combat_targeting_turret_root_host_id_ptr,
  combat_targeting_turret_mount_index_ptr,
  combat_targeting_turret_mount_x_ptr,
  combat_targeting_turret_mount_y_ptr,
  combat_targeting_turret_mount_z_ptr,
  combat_targeting_turret_mount_vx_ptr,
  combat_targeting_turret_mount_vy_ptr,
  combat_targeting_turret_mount_vz_ptr,
  combat_targeting_turret_world_pos_tick_ptr,
  combat_targeting_turret_rotation_ptr,
  combat_targeting_turret_pitch_ptr,
  combat_targeting_turret_angular_velocity_ptr,
  combat_targeting_turret_pitch_velocity_ptr,
  combat_targeting_turret_host_piece_yaw_ptr,
  combat_targeting_turret_host_piece_yaw_velocity_ptr,
  combat_targeting_turret_state_ptr,
  combat_targeting_refresh_activity_masks_for_entity,
  combat_targeting_refresh_activity_masks_batch,
  combat_targeting_clear_turret_fsm,
  combat_targeting_turret_target_id_ptr,
  combat_targeting_turret_cooldown_ptr,
  combat_targeting_turret_burst_cooldown_ptr,
  combat_targeting_turret_fire_max_acquire_sq_ptr,
  combat_targeting_turret_fire_max_release_sq_ptr,
  combat_targeting_turret_fire_min_acquire_sq_ptr,
  combat_targeting_turret_fire_min_release_sq_ptr,
  combat_targeting_turret_tracking_acquire_sq_ptr,
  combat_targeting_turret_tracking_release_sq_ptr,
  combat_targeting_turret_outermost_acquire_ptr,
  combat_targeting_turret_los_blocked_ticks_ptr,
  combat_targeting_turret_config_flags_ptr,
  combat_targeting_turret_ballistic_has_solution_ptr,
  combat_targeting_turret_ballistic_flight_time_ptr,
  combat_targeting_turret_ballistic_launch_vx_ptr,
  combat_targeting_turret_ballistic_launch_vy_ptr,
  combat_targeting_turret_ballistic_launch_vz_ptr,
  combat_targeting_turret_ballistic_yaw_ptr,
  combat_targeting_turret_ballistic_pitch_ptr,
  combat_targeting_turret_ballistic_aim_x_ptr,
  combat_targeting_turret_ballistic_aim_y_ptr,
  combat_targeting_turret_ballistic_aim_z_ptr,
  combat_targeting_solve_ballistic_aim,
  combat_targeting_prepare_auto_scan,
  combat_targeting_prepare_fire_choice_fsm_inputs,
  combat_targeting_prepare_acquisition_choice_fsm_inputs,
  combat_targeting_rank_target,
  combat_targeting_compute_and_choose_best_candidates_batch,
  combat_targeting_clear_turret_lock,
  combat_targeting_clear_entity_locks,
  combat_targeting_apply_priority_point_fsm_batch,
  combat_targeting_compute_and_apply_priority_point_fsm_batch,
  combat_targeting_apply_priority_target_fsm_batch,
  combat_targeting_compute_and_apply_priority_target_fsm_batch,
  combat_targeting_validate_existing_lock_fsm_batch,
  combat_targeting_compute_and_apply_validate_existing_lock_fsm_batch,
  combat_targeting_apply_fire_choice_fsm_batch,
  combat_targeting_apply_acquisition_choice_fsm_batch,
  combat_targeting_auto_mode_candidate_tick,
  combat_targeting_auto_mode_spatial_candidate_tick,
  combat_targeting_auto_mode_spatial_candidate_tick_batch,
  combat_targeting_tick_batch,
  combat_targeting_schedule_and_tick_batch,
  combat_targeting_existing_lock_and_auto_scan_tick,
  shield_pool_clear,
  shield_pool_count,
  shield_pool_set_count,
  shield_pool_set_field,
  shield_pool_id_ptr,
  shield_pool_owner_entity_id_ptr,
  shield_pool_center_x_ptr,
  shield_pool_center_y_ptr,
  shield_pool_center_z_ptr,
  shield_pool_radius_ptr,
  shield_clearance_segment,
  shield_clearance_arc,
  shield_panel_pool_set_unit_count,
  shield_panel_pool_set_panel_count,
  shield_panel_pool_set_unit,
  shield_panel_pool_set_panel,
  shield_panel_pool_set_material_mode,
  projectile_reflector_intersections_batch,
  projectile_reflection_response_batch,
  projectile_submunition_launch_velocity_batch,
  projectile_terminal_single,
  projectile_hitbox_sweep_prefix_commit,
  projectile_hitbox_sweep_staging_ensure,
  projectile_hitbox_sweep_exclude_ids_ptr,
  projectile_hitbox_sweep_removed_ids_ptr,
  projectile_hitbox_sweep_out_kind_ptr,
  projectile_hitbox_sweep_out_slot_ptr,
  projectile_hitbox_sweep_out_entity_id_ptr,
  projectile_hitbox_sweep_out_t_ptr,
  projectile_hitbox_sweep_out_normal_ptr,
  projectile_hitbox_sweep_single,
  snapshot_encode_entity_basic,
  snapshot_encode_entity_unit,
  snapshot_encode_entity_building,
  snapshot_encode_envelope_begin,
  snapshot_encode_envelope_begin_packed_entities,
  snapshot_encode_envelope_continue,
  snapshot_encode_envelope_emit_economy,
  snapshot_encode_envelope_emit_minimap,
  snapshot_encode_envelope_emit_packed_minimap,
  snapshot_encode_envelope_emit_projectiles,
  snapshot_encode_envelope_emit_packed_projectiles,
  snapshot_encode_minimap_scratch_ptr,
  snapshot_encode_minimap_scratch_ensure,
  snapshot_encode_beam_update_scratch_ptr,
  snapshot_encode_beam_update_scratch_ensure,
  snapshot_encode_beam_point_scratch_ptr,
  snapshot_encode_beam_point_scratch_ensure,
  snapshot_encode_envelope_emit_scan_pulses,
  snapshot_encode_scan_pulse_scratch_ptr,
  snapshot_encode_scan_pulse_scratch_ensure,
  snapshot_encode_envelope_emit_packed_terrain,
  snapshot_encode_envelope_emit_terrain,
  snapshot_encode_envelope_emit_packed_buildability,
  snapshot_encode_envelope_emit_buildability,
  snapshot_encode_number_scratch_ptr,
  snapshot_encode_number_scratch_ensure,
  snapshot_encode_envelope_emit_spray_targets,
  snapshot_encode_spray_scratch_ptr,
  snapshot_encode_spray_scratch_ensure,
  snapshot_encode_economy_scratch_ptr,
  snapshot_encode_economy_scratch_ensure,
  snapshot_encode_envelope_emit_resource_movements,
  snapshot_encode_resource_movement_scratch_ptr,
  snapshot_encode_resource_movement_scratch_ensure,
  snapshot_encode_envelope_emit_audio_events,
  snapshot_encode_envelope_emit_packed_audio_events,
  snapshot_encode_audio_event_scratch_ptr,
  snapshot_encode_audio_event_scratch_ensure,
  snapshot_encode_death_context_scratch_ptr,
  snapshot_encode_death_context_scratch_ensure,
  snapshot_encode_turret_pose_scratch_ptr,
  snapshot_encode_turret_pose_scratch_ensure,
  snapshot_encode_impact_context_scratch_ptr,
  snapshot_encode_impact_context_scratch_ensure,
  snapshot_encode_proj_despawn_scratch_ptr,
  snapshot_encode_proj_despawn_scratch_ensure,
  snapshot_encode_proj_spawn_scratch_ptr,
  snapshot_encode_proj_spawn_scratch_ensure,
  snapshot_encode_proj_vel_scratch_ptr,
  snapshot_encode_proj_vel_scratch_ensure,
  snapshot_encode_removed_ids_scratch_ptr,
  snapshot_encode_removed_ids_scratch_ensure,
  snapshot_encode_turret_scratch_ptr,
  snapshot_encode_turret_scratch_ensure,
  snapshot_encode_action_scratch_ptr,
  snapshot_encode_action_scratch_ensure,
  snapshot_encode_emit_entities_v6,
  snapshot_encode_v6_kinds_scratch_ptr,
  snapshot_encode_v6_kinds_scratch_ensure,
  snapshot_encode_v6_row_indices_scratch_ptr,
  snapshot_encode_v6_row_indices_scratch_ensure,
  snapshot_encode_v6_basic_scratch_ptr,
  snapshot_encode_v6_basic_scratch_ensure,
  snapshot_encode_v6_unit_scratch_ptr,
  snapshot_encode_v6_unit_scratch_ensure,
  snapshot_encode_v6_building_scratch_ptr,
  snapshot_encode_v6_building_scratch_ensure,
  snapshot_encode_v6_raw_bytes_scratch_ptr,
  snapshot_encode_v6_raw_bytes_scratch_ensure,
  snapshot_encode_v6_raw_spans_scratch_ptr,
  snapshot_encode_v6_raw_spans_scratch_ensure,
  snapshot_encode_string_scratch_bytes_ptr,
  snapshot_encode_string_scratch_table_ptr,
  snapshot_encode_string_scratch_ensure_bytes,
  snapshot_encode_string_scratch_ensure_table,
  snapshot_encode_factory_queue_scratch_ptr,
  snapshot_encode_factory_queue_scratch_ensure,
  snapshot_encode_waypoint_scratch_ptr,
  snapshot_encode_waypoint_scratch_ensure,
  snapshot_encode_envelope_emit_server_meta,
  snapshot_encode_envelope_emit_raw_key_value,
  messagepack_writer_append_raw_value,
  messagepack_writer_ptr,
  messagepack_writer_len,
  messagepack_writer_clear,
  arrival_control_step_batch,
  unit_ground_normal_step_pool,
  body_pool_collect_nonfinite_kinematics,
  pool_pos_x_ptr,
  pool_pos_y_ptr,
  pool_pos_z_ptr,
  pool_vel_x_ptr,
  pool_vel_y_ptr,
  pool_vel_z_ptr,
  pool_accel_x_ptr,
  pool_accel_y_ptr,
  pool_accel_z_ptr,
  pool_launch_x_ptr,
  pool_launch_y_ptr,
  pool_launch_z_ptr,
  pool_surface_normal_x_ptr,
  pool_surface_normal_y_ptr,
  pool_surface_normal_z_ptr,
  pool_radius_ptr,
  pool_half_x_ptr,
  pool_half_y_ptr,
  pool_half_z_ptr,
  pool_inv_mass_ptr,
  pool_restitution_ptr,
  pool_ground_offset_ptr,
  pool_linear_drag_coefficient_ptr,
  pool_ground_tangential_damping_rate_ptr,
  pool_sleep_ticks_ptr,
  pool_flags_ptr,
  pool_entity_id_ptr,
} from './pkg/rts_sim_wasm';
import {
  type SimWasm,
  type ProjectilePoolViews,
  type BodyPoolViews,
} from './api';
export * from './api';

let cached: Promise<SimWasm> | undefined;
let resolvedHandle: SimWasm | undefined;

/** Explicit opt-in gate for the boot-time contract-test harnesses.
 *  Bare DEV mode used to import and run every harness on every boot
 *  (~20 suites, 100ms+); now they run only on request: append
 *  `?contractTests=1` to the URL or set localStorage
 *  BA_RUN_CONTRACT_TESTS = "1". Call sites must keep the literal
 *  `import.meta.env.DEV &&` prefix so production builds tree-shake
 *  the dynamic test imports away entirely. */
function shouldRunBootContractTests(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    if (new URLSearchParams(window.location.search).get('contractTests') === '1') return true;
    return window.localStorage.getItem('BA_RUN_CONTRACT_TESTS') === '1';
  } catch {
    return false;
  }
}

/** Idempotent. Concurrent callers share one fetch + compile of
 *  the wasm module. Resolves once the WASM is instantiated and
 *  the auto-init (#[wasm_bindgen(start)]) panic hook has run. */
export function initSimWasm(moduleOrPath?: InitInput | Promise<InitInput>): Promise<SimWasm> {
  if (cached === undefined) {
    cached = (async () => {
      const initOutput = await __wbg_init(
        moduleOrPath === undefined ? undefined : { module_or_path: moduleOrPath },
      );

      // Pre-grow WASM linear memory BEFORE pool_init() so the
      // BodyPool's Vec allocations land in a comfortably-sized
      // memory region. Subsequent per-tick Rust allocations
      // (HashMap rebuilds in the sphere-sphere resolver, per-cell
      // Vec growths in the static broadphase) then fit without
      // triggering memory.grow() — which would detach every typed-
      // array view JS holds over linear memory and cause the
      // "Aw, Snap!" renderer crash on the next view access.
      //
      // 32 MB upper-bounds steady-state allocations comfortably:
      // pool ~720 KB + per-engine static cells + transient
      // HashMaps. Memory still grows on demand if we exceed this,
      // but refreshViews below catches that case too.
      const PRE_GROW_TARGET_PAGES = 512;  // 64 KiB/page * 512 = 32 MiB
      const currentPages = initOutput.memory.buffer.byteLength / 65536;
      const growBy = PRE_GROW_TARGET_PAGES - currentPages;
      if (growBy > 0) {
        initOutput.memory.grow(growBy);
      }

      pool_init();
      projectile_pool_init();
      // Phase 7 — initialize SpatialGrid singleton. Cell size mirrors
      // CANONICAL_LAND_CELL_SIZE in landGrid.ts; the grid auto-grows
      // its per-slot SoA arrays past the initial capacity hint.
      spatial_init(200, 1024);
      // [23] Canonical entity state slab. Same initial slot capacity
      // hint as SpatialGrid since the slot spaces are shared.
      entity_state_init(1024);
      // Phase 10 D.1b — turret sub-pool. Per-entity turret arrays
      // indexed at fixed offsets up to MAX_TURRETS_PER_ENTITY = 8.
      turret_pool_init(1024);
      // AIM-08.1 — targeting input slabs. Same 1024-slot hint as the
      // other pools; auto-grows past it.
      combat_targeting_init(1024);
      // Phase 10 D.2 — verify the hand-rolled MessagePack encoder
      // matches its expected byte output across representative fixture cases.
      // Returns a bitmask of failed cases (0 = all pass). Future
      // Phase 10 sub-commits depend on byte-equality with the JS
      // @msgpack/msgpack output, so a regression here is fatal.
      const mpFailures = messagepack_self_test();
      if (mpFailures !== 0) {
        throw new Error(
          `(rust) rts-sim-wasm MessagePack encoder self-test failed: 0x${mpFailures.toString(16)}`,
        );
      }
      const memory = initOutput.memory;
      // Phase 10 D.3j — verify the entity-DTO encoder is byte-equal
      // with @msgpack/msgpack on a representative set of envelopes.
      // Opt-in (see shouldRunBootContractTests): a regression here means
      // the production encoder would diverge from the wire format as we
      // land more fields.
      if (import.meta.env.DEV && shouldRunBootContractTests()) {
        const { runSnapshotEncoderByteEqualityTest } = await import('./snapshotEncoderTest');
        await runSnapshotEncoderByteEqualityTest(memory);
      }
      const capacity = pool_capacity();
      const projCapacity = projectile_pool_capacity();

      const f64View = (ptr: number): Float64Array =>
        new Float64Array(memory.buffer, ptr, capacity);
      const u8View = (ptr: number): Uint8Array =>
        new Uint8Array(memory.buffer, ptr, capacity);
      const i32View = (ptr: number): Int32Array =>
        new Int32Array(memory.buffer, ptr, capacity);

      // Hold field pointers so refreshViews() can rebuild the
      // typed-array views over potentially-detached WASM memory
      // (linear memory grow detaches all existing views).
      const ptrs = {
        posX: pool_pos_x_ptr(),
        posY: pool_pos_y_ptr(),
        posZ: pool_pos_z_ptr(),
        velX: pool_vel_x_ptr(),
        velY: pool_vel_y_ptr(),
        velZ: pool_vel_z_ptr(),
        accelX: pool_accel_x_ptr(),
        accelY: pool_accel_y_ptr(),
        accelZ: pool_accel_z_ptr(),
        launchX: pool_launch_x_ptr(),
        launchY: pool_launch_y_ptr(),
        launchZ: pool_launch_z_ptr(),
        surfaceNormalX: pool_surface_normal_x_ptr(),
        surfaceNormalY: pool_surface_normal_y_ptr(),
        surfaceNormalZ: pool_surface_normal_z_ptr(),
        radius: pool_radius_ptr(),
        halfX: pool_half_x_ptr(),
        halfY: pool_half_y_ptr(),
        halfZ: pool_half_z_ptr(),
        invMass: pool_inv_mass_ptr(),
        restitution: pool_restitution_ptr(),
        groundOffset: pool_ground_offset_ptr(),
        linearDragCoefficient: pool_linear_drag_coefficient_ptr(),
        groundTangentialDampingRate: pool_ground_tangential_damping_rate_ptr(),
        sleepTicks: pool_sleep_ticks_ptr(),
        flags: pool_flags_ptr(),
        entityId: pool_entity_id_ptr(),
      };

      let bodyPoolBuffer: ArrayBuffer = memory.buffer;
      const pool: BodyPoolViews = {
        capacity,
        allocSlot: pool_alloc_slot,
        liveCount: pool_live_count,
        freeSlot: pool_free_slot,
        refreshViews: () => {
          const buffer = memory.buffer;
          if (bodyPoolBuffer === buffer && pool.posX.byteLength !== 0) return;
          bodyPoolBuffer = buffer;
          pool.posX = f64View(ptrs.posX);
          pool.posY = f64View(ptrs.posY);
          pool.posZ = f64View(ptrs.posZ);
          pool.velX = f64View(ptrs.velX);
          pool.velY = f64View(ptrs.velY);
          pool.velZ = f64View(ptrs.velZ);
          pool.accelX = f64View(ptrs.accelX);
          pool.accelY = f64View(ptrs.accelY);
          pool.accelZ = f64View(ptrs.accelZ);
          pool.launchX = f64View(ptrs.launchX);
          pool.launchY = f64View(ptrs.launchY);
          pool.launchZ = f64View(ptrs.launchZ);
          pool.surfaceNormalX = f64View(ptrs.surfaceNormalX);
          pool.surfaceNormalY = f64View(ptrs.surfaceNormalY);
          pool.surfaceNormalZ = f64View(ptrs.surfaceNormalZ);
          pool.radius = f64View(ptrs.radius);
          pool.halfX = f64View(ptrs.halfX);
          pool.halfY = f64View(ptrs.halfY);
          pool.halfZ = f64View(ptrs.halfZ);
          pool.invMass = f64View(ptrs.invMass);
          pool.restitution = f64View(ptrs.restitution);
          pool.groundOffset = f64View(ptrs.groundOffset);
          pool.linearDragCoefficient = f64View(ptrs.linearDragCoefficient);
          pool.groundTangentialDampingRate = f64View(ptrs.groundTangentialDampingRate);
          pool.sleepTicks = f64View(ptrs.sleepTicks);
          pool.flags = u8View(ptrs.flags);
          pool.entityId = i32View(ptrs.entityId);
        },
        // Initialised below; the explicit assignments make the
        // type narrowing happy.
        posX: f64View(ptrs.posX),
        posY: f64View(ptrs.posY),
        posZ: f64View(ptrs.posZ),
        velX: f64View(ptrs.velX),
        velY: f64View(ptrs.velY),
        velZ: f64View(ptrs.velZ),
        accelX: f64View(ptrs.accelX),
        accelY: f64View(ptrs.accelY),
        accelZ: f64View(ptrs.accelZ),
        launchX: f64View(ptrs.launchX),
        launchY: f64View(ptrs.launchY),
        launchZ: f64View(ptrs.launchZ),
        surfaceNormalX: f64View(ptrs.surfaceNormalX),
        surfaceNormalY: f64View(ptrs.surfaceNormalY),
        surfaceNormalZ: f64View(ptrs.surfaceNormalZ),
        radius: f64View(ptrs.radius),
        halfX: f64View(ptrs.halfX),
        halfY: f64View(ptrs.halfY),
        halfZ: f64View(ptrs.halfZ),
        invMass: f64View(ptrs.invMass),
        restitution: f64View(ptrs.restitution),
        groundOffset: f64View(ptrs.groundOffset),
        linearDragCoefficient: f64View(ptrs.linearDragCoefficient),
        groundTangentialDampingRate: f64View(ptrs.groundTangentialDampingRate),
        sleepTicks: f64View(ptrs.sleepTicks),
        flags: u8View(ptrs.flags),
        entityId: i32View(ptrs.entityId),
      };

      // Phase 5a — projectile pool views over the WASM linear
      // memory. Same lifetime/refresh pattern as the body pool.
      const projF64View = (ptr: number): Float64Array =>
        new Float64Array(memory.buffer, ptr, projCapacity);
      const projI32View = (ptr: number): Int32Array =>
        new Int32Array(memory.buffer, ptr, projCapacity);
      const projU32View = (ptr: number): Uint32Array =>
        new Uint32Array(memory.buffer, ptr, projCapacity);
      const projPtrs = {
        posX: projectile_pool_pos_x_ptr(),
        posY: projectile_pool_pos_y_ptr(),
        posZ: projectile_pool_pos_z_ptr(),
        velX: projectile_pool_vel_x_ptr(),
        velY: projectile_pool_vel_y_ptr(),
        velZ: projectile_pool_vel_z_ptr(),
        timeAlive: projectile_pool_time_alive_ptr(),
        sourceTurretEntityId: projectile_pool_source_turret_entity_id_ptr(),
        sourceHostEntityId: projectile_pool_source_host_id_ptr(),
        sourceRootEntityId: projectile_pool_source_root_id_ptr(),
        sourcePlayerId: projectile_pool_source_player_id_ptr(),
        sourceTeamId: projectile_pool_source_team_id_ptr(),
        sourceTurretBlueprintCode: projectile_pool_source_turret_blueprint_code_ptr(),
        sourceShotBlueprintCode: projectile_pool_source_shot_blueprint_code_ptr(),
        spawnTick: projectile_pool_spawn_tick_ptr(),
        parentShotEntityId: projectile_pool_parent_shot_entity_id_ptr(),
      };
      let projectilePoolBuffer: ArrayBuffer = memory.buffer;
      const projectilePool: ProjectilePoolViews = {
        capacity: projCapacity,
        refreshViews: () => {
          const buffer = memory.buffer;
          if (projectilePoolBuffer === buffer && projectilePool.posX.byteLength !== 0) return;
          projectilePoolBuffer = buffer;
          projectilePool.posX = projF64View(projPtrs.posX);
          projectilePool.posY = projF64View(projPtrs.posY);
          projectilePool.posZ = projF64View(projPtrs.posZ);
          projectilePool.velX = projF64View(projPtrs.velX);
          projectilePool.velY = projF64View(projPtrs.velY);
          projectilePool.velZ = projF64View(projPtrs.velZ);
          projectilePool.timeAlive = projF64View(projPtrs.timeAlive);
          projectilePool.sourceTurretEntityId = projI32View(projPtrs.sourceTurretEntityId);
          projectilePool.sourceHostEntityId = projI32View(projPtrs.sourceHostEntityId);
          projectilePool.sourceRootEntityId = projI32View(projPtrs.sourceRootEntityId);
          projectilePool.sourcePlayerId = projI32View(projPtrs.sourcePlayerId);
          projectilePool.sourceTeamId = projI32View(projPtrs.sourceTeamId);
          projectilePool.sourceTurretBlueprintCode =
            projU32View(projPtrs.sourceTurretBlueprintCode);
          projectilePool.sourceShotBlueprintCode = projU32View(projPtrs.sourceShotBlueprintCode);
          projectilePool.spawnTick = projU32View(projPtrs.spawnTick);
          projectilePool.parentShotEntityId = projI32View(projPtrs.parentShotEntityId);
        },
        clear: () => {
          projectilePool.refreshViews();
          projectilePool.posX.fill(0);
          projectilePool.posY.fill(0);
          projectilePool.posZ.fill(0);
          projectilePool.velX.fill(0);
          projectilePool.velY.fill(0);
          projectilePool.velZ.fill(0);
          projectilePool.timeAlive.fill(0);
          projectilePool.sourceTurretEntityId.fill(-1);
          projectilePool.sourceHostEntityId.fill(-1);
          projectilePool.sourceRootEntityId.fill(-1);
          projectilePool.sourcePlayerId.fill(-1);
          projectilePool.sourceTeamId.fill(-1);
          projectilePool.sourceTurretBlueprintCode.fill(0xffff_ffff);
          projectilePool.sourceShotBlueprintCode.fill(0xffff_ffff);
          projectilePool.spawnTick.fill(0);
          projectilePool.parentShotEntityId.fill(-1);
        },
        posX: projF64View(projPtrs.posX),
        posY: projF64View(projPtrs.posY),
        posZ: projF64View(projPtrs.posZ),
        velX: projF64View(projPtrs.velX),
        velY: projF64View(projPtrs.velY),
        velZ: projF64View(projPtrs.velZ),
        timeAlive: projF64View(projPtrs.timeAlive),
        sourceTurretEntityId: projI32View(projPtrs.sourceTurretEntityId),
        sourceHostEntityId: projI32View(projPtrs.sourceHostEntityId),
        sourceRootEntityId: projI32View(projPtrs.sourceRootEntityId),
        sourcePlayerId: projI32View(projPtrs.sourcePlayerId),
        sourceTeamId: projI32View(projPtrs.sourceTeamId),
        sourceTurretBlueprintCode: projU32View(projPtrs.sourceTurretBlueprintCode),
        sourceShotBlueprintCode: projU32View(projPtrs.sourceShotBlueprintCode),
        spawnTick: projU32View(projPtrs.spawnTick),
        parentShotEntityId: projI32View(projPtrs.parentShotEntityId),
      };

      const handle: SimWasm = {
        version: version(),
        deterministicMath: {
          sin: deterministic_math_sin,
          cos: deterministic_math_cos,
          atan2: deterministic_math_atan2,
          sqrt: deterministic_math_sqrt,
          exp: deterministic_math_exp,
          hypot2: deterministic_math_hypot2,
          hypot3: deterministic_math_hypot3,
          pow: deterministic_math_pow,
          ln: deterministic_math_ln,
          log2: deterministic_math_log2,
          tan: deterministic_math_tan,
          asin: deterministic_math_asin,
        },
        windSampleState: wind_sample_state,
        buildTargetHorizontalDistance: build_target_horizontal_distance,
        commanderApplyReclaimTick: commander_apply_reclaim_tick,
        factoryBuildSpot: factory_build_spot,
        factoryBuildSpotBlocked: factory_build_spot_blocked,
        factoryPlanProductionActions: factory_plan_production_actions,
        buildingActiveStateStepBatch: building_active_state_step_batch,
        economyAccumulatePlayerRates: economy_accumulate_player_rates,
        economyComputeConverterTransfer: economy_compute_converter_transfer,
        economyCreditStockpile: economy_credit_stockpile,
        economyDebitStockpile: economy_debit_stockpile,
        economyApplyEqualConsumerDebits: economy_apply_equal_consumer_debits,
        constructionApplyCoupledConsumerDebits: construction_apply_coupled_consumer_debits,
        constructionReconcileAndGrowPieces: construction_reconcile_and_grow_pieces,
        constructionApplyConsumerSpends: construction_apply_consumer_spends,
        constructionDecayStep: construction_decay_step,
        economyApplyIncomeCredits: economy_apply_income_credits,
        economyApplyConverterTransfers: economy_apply_converter_transfers,
        arrivalCompletionStepBatch: arrival_completion_step_batch,
        airborneLoiterStepBatch: airborne_loiter_step_batch,
        waypointOrbitSteerBatch: waypoint_orbit_steer_batch,
        stuckReplanStepBatch: stuck_replan_step_batch,
        unitActionPlanBatch: unit_action_plan_batch,
        unitActionMovementBatch: unit_action_movement_batch,
        articulationJointStepBatch: articulation_joint_step_batch,
        articulationYawStepBatch: articulation_yaw_step_batch,
        pool,
        poolPrepareDynamicStep: pool_prepare_dynamic_step,
        poolCollectAwakeEntityIds: pool_collect_awake_entity_ids,
        poolFinalizeDynamicStep: pool_finalize_dynamic_step,
        poolStepIntegrate: pool_step_integrate,
        poolResolveSphereSphere: pool_resolve_sphere_sphere,
        poolResolveSphereSphereActive: pool_resolve_sphere_sphere_active,
        engineStaticsCreate: engine_statics_create,
        engineStaticsDestroy: engine_statics_destroy,
        engineStaticsAdd: engine_statics_add,
        engineStaticsRemove: engine_statics_remove,
        poolResolveSphereCuboidFull: pool_resolve_sphere_cuboid_full,
        arrivalControlStepBatch: arrival_control_step_batch,
        unitEffectiveDriveAcceleration: unit_effective_drive_acceleration,
        unitGroundNormalStepPool: unit_ground_normal_step_pool,
        bodyPoolCollectNonfiniteKinematics: body_pool_collect_nonfinite_kinematics,
        unitForceStepBatch: unit_force_step_batch,
        unitForceStagingEnsure: unit_force_staging_ensure,
        unitForceStagingSlotsPtr: unit_force_staging_slots_ptr,
        unitForceStagingFlagsPtr: unit_force_staging_flags_ptr,
        unitForceStagingRowsPtr: unit_force_staging_rows_ptr,
        unitForceStagingOutFlagsPtr: unit_force_staging_out_flags_ptr,
        unitForceStepBatchStaged: unit_force_step_batch_staged,
        unitForceSurfaceLiftInverseDistanceResponse: unit_force_surface_lift_inverse_distance_response,
        unitForceWaterSurfaceDepthWorld: unit_force_water_surface_depth_world,
        unitForceWaterFraction: unit_force_water_fraction,
        unitForceProfileEnsure: unit_force_profile_ensure,
        unitForceProfileValuesPtr: unit_force_profile_values_ptr,
        unitForceProfileFlagsPtr: unit_force_profile_flags_ptr,
        unitForceRuntimeClear: unit_force_runtime_clear,
        unitWaterDamageStepPool: unit_water_damage_step_pool,
        unitWaterDamagedEntitySlotsPtr: unit_water_damaged_entity_slots_ptr,
        damageAreaOverlapBatch: damage_area_overlap_batch,
        damageAreaCandidatesBatch: damage_area_candidates_batch,
        damageAreaTurretCandidatesBatch: damage_area_turret_candidates_batch,
        damageDeathExplosionCandidatesBatch: damage_death_explosion_candidates_batch,
        deathExplosionPlannerReset: death_explosion_planner_reset,
        deathExplosionPlannerSeed: death_explosion_planner_seed,
        deathExplosionPlannerAppendKills: death_explosion_planner_append_kills,
        deathExplosionPlannerNext: death_explosion_planner_next,
        damageApplyBatch: damage_apply_batch,
        damageClosestBodySegmentHitT: damage_closest_body_segment_hit_t,
        damageFindClosestBodySegmentHit: damage_find_closest_body_segment_hit,
        damageSegmentCandidatesBatch: damage_segment_candidates_batch,
        damageSegmentHitsBatch: damage_segment_hits_batch,
        deathCleanupDiffBatch: death_cleanup_diff_batch,
        projectilePool,
        projectileReflectorIntersectionsBatch: projectile_reflector_intersections_batch,
        projectileReflectionResponseBatch: projectile_reflection_response_batch,
        projectileSubmunitionLaunchVelocityBatch: projectile_submunition_launch_velocity_batch,
        projectileTerminalSingle: projectile_terminal_single,
        projectileHitboxSweepPrefixCommit: projectile_hitbox_sweep_prefix_commit,
        projectileHitboxSweepStagingEnsure: projectile_hitbox_sweep_staging_ensure,
        projectileHitboxSweepExcludeIdsPtr: projectile_hitbox_sweep_exclude_ids_ptr,
        projectileHitboxSweepRemovedIdsPtr: projectile_hitbox_sweep_removed_ids_ptr,
        projectileHitboxSweepOutKindPtr: projectile_hitbox_sweep_out_kind_ptr,
        projectileHitboxSweepOutSlotPtr: projectile_hitbox_sweep_out_slot_ptr,
        projectileHitboxSweepOutEntityIdPtr: projectile_hitbox_sweep_out_entity_id_ptr,
        projectileHitboxSweepOutTPtr: projectile_hitbox_sweep_out_t_ptr,
        projectileHitboxSweepOutNormalPtr: projectile_hitbox_sweep_out_normal_ptr,
        projectileHitboxSweepSingle: projectile_hitbox_sweep_single,
        poolStepPackedProjectilesBatch: pool_step_packed_projectiles_batch,
        projectileIntegrateStepBatch: projectile_integrate_step_batch,
        projectileHomingGuidanceBatch: projectile_homing_guidance_batch,
        projectileHomingGuidanceApplyBatch: projectile_homing_guidance_apply_batch,
        lineShotDistanceToRangeVolume: line_shot_distance_to_range_volume,
        lineShotRangeEndpoint: line_shot_range_endpoint,
        terrainFollowVerticalThrustAccel: terrain_follow_vertical_thrust_accel,
        solveKinematicIntercept: solve_kinematic_intercept,
        computeHomingThrust: compute_homing_thrust,
        computeConstantSpeedHomingVelocity: compute_constant_speed_homing_velocity,
        metalDepositCountPlacements: metal_deposit_count_placements,
        metalDepositGeneratePlacements: metal_deposit_generate_placements,
        metalDepositResolveTerrainHeights: metal_deposit_resolve_terrain_heights,
        metalDepositCountPlacementCandidates: metal_deposit_count_placement_candidates,
        metalDepositScatterMetalCells: metal_deposit_scatter_metal_cells,
        metalDepositGrowMetalCells: metal_deposit_grow_metal_cells,
        metalDepositBakeSurfaceField: metal_deposit_bake_surface_field,
        terrainSampleMapBoundaryFades: terrain_sample_map_boundary_fades,
        vegetationClear: vegetation_clear,
        vegetationGenerate: vegetation_generate,
        vegetationCount: vegetation_count,
        vegetationReadProps: vegetation_read_props,
        vegetationPropState: vegetation_prop_state,
        vegetationQueryCircle: vegetation_query_circle,
        vegetationRaycast: vegetation_raycast,
        vegetationApplyReclaimTick: vegetation_apply_reclaim_tick,
        vegetationRemovedCount: vegetation_removed_count,
        vegetationReadRemoved: vegetation_read_removed,
        vegetationStateHash: vegetation_state_hash,
        terrainInstallMesh: terrain_install_mesh,
        terrainClear: terrain_clear,
        terrainIsInstalled: terrain_is_installed,
        terrainCountCellTriangleRefs: terrain_count_cell_triangle_refs,
        terrainFillCellTriangleIndices: terrain_fill_cell_triangle_indices,
        terrainBuildAdaptiveMesh: terrain_build_adaptive_mesh,
        terrainGetBedHeight: terrain_get_bed_height,
        terrainSampleBedHeights: terrain_sample_bed_heights,
        terrainGetBedNormal: terrain_get_bed_normal,
        terrainGetSurfaceHeight: terrain_get_surface_height,
        terrainGetSurfaceNormal: terrain_get_surface_normal,
        terrainSampleGroundForSlots: terrain_sample_ground_for_slots,
        terrainSampleForceSupportForSlots: terrain_sample_force_support_for_slots,
        terrainSampleWaterProbeMasks: terrain_sample_water_probe_masks,
        terrainBakeBuildabilityGrid: terrain_bake_buildability_grid,
        terrainHasLineOfSight: terrain_has_line_of_sight,
        fogMarkCircleScanline: fog_mark_circle_scanline,
        fogMarkCircleScanlineRgba: fog_mark_circle_scanline_rgba,
        combatHasLineOfSight: combat_has_line_of_sight,
        memory,
        pathfinder: {
          init: pathfinder_init,
          computeLocomotionClimbProfile: pathfinder_compute_locomotion_climb_profile,
          rebuildTerrainMaskAndCc: pathfinder_rebuild_terrain_mask_and_cc,
          bakeTraversabilityGrid: pathfinder_bake_traversability_grid,
          syncBuildingOccupancy: pathfinder_sync_building_occupancy,
          buildingOccupancyVersion: pathfinder_building_occupancy_version,
          findPath: pathfinder_find_path,
          findPathSlice: pathfinder_find_path_slice,
          cancelPathSlice: pathfinder_cancel_path_slice,
          cancelAllPathSlices: pathfinder_cancel_all_path_slices,
          lastResultStatus: pathfinder_last_result_status,
          lastSearchStrategy: pathfinder_last_search_strategy,
          lastFineExpandedNodes: pathfinder_last_fine_expanded_nodes,
          lastFineExpandedNodesThisSlice: pathfinder_last_fine_expanded_nodes_this_slice,
          lastCoarseExpandedNodes: pathfinder_last_coarse_expanded_nodes,
          lastCoarseRefinementPasses: pathfinder_last_coarse_refinement_passes,
          lastCoarseExactEdgeChecks: pathfinder_last_coarse_exact_edge_checks,
          lastCoarseFullClusterScans: pathfinder_last_coarse_full_cluster_scans,
          lastFineHitNodeLimit: pathfinder_last_fine_hit_node_limit,
          lastSmoothingLineChecks: pathfinder_last_smoothing_line_checks,
          lastDirectCostRatio: pathfinder_last_direct_cost_ratio,
          validatePath: pathfinder_validate_path,
          waypointsPtr: pathfinder_waypoints_ptr,
          gridWidth: pathfinder_grid_size_w,
          gridHeight: pathfinder_grid_size_h,
        },
        turretPool: {
          init: turret_pool_init,
          clear: turret_pool_clear,
          maxPerEntity: turret_pool_max_per_entity,
          setCount: turret_pool_set_count,
          setTurret: turret_pool_set_turret,
          unsetEntity: turret_pool_unset_entity,
          count: turret_pool_count,
          entityCapacity: turret_pool_entity_capacity,
          countPerEntityPtr: turret_pool_count_per_entity_ptr,
          entityIdPtr: turret_pool_entity_id_ptr,
          parentIdPtr: turret_pool_parent_id_ptr,
          rootHostIdPtr: turret_pool_root_host_id_ptr,
          mountIndexPtr: turret_pool_mount_index_ptr,
          rotationPtr: turret_pool_rotation_ptr,
          angularVelocityPtr: turret_pool_angular_velocity_ptr,
          angularAccelerationPtr: turret_pool_angular_acceleration_ptr,
          pitchPtr: turret_pool_pitch_ptr,
          pitchVelocityPtr: turret_pool_pitch_velocity_ptr,
          pitchAccelerationPtr: turret_pool_pitch_acceleration_ptr,
          shieldRangePtr: turret_pool_shield_range_ptr,
          targetIdPtr: turret_pool_target_id_ptr,
        },
        combatTargeting: {
          init: combat_targeting_init,
          clear: combat_targeting_clear,
          beginStamp: combat_targeting_begin_stamp,
          maxTurretsPerEntity: combat_targeting_max_turrets_per_entity,
          entityCapacity: combat_targeting_entity_capacity,
          setEntity: combat_targeting_set_entity,
          unsetEntity: combat_targeting_unset_entity,
          rebuildObservationMasks: combat_targeting_rebuild_observation_masks,
          rebuildObservationMasksForSources: combat_targeting_rebuild_observation_masks_for_sources,
          collectObservationVisibility: combat_targeting_collect_observation_visibility,
          addSensorObservationCircle: combat_targeting_add_sensor_observation_circle,
          setWind: combat_targeting_set_wind,
          setTurret: combat_targeting_set_turret,
          updateMountKinematics: combat_targeting_update_mount_kinematics,
          updateMountKinematicsBatch: combat_targeting_update_mount_kinematics_batch,
          entityFlags: combat_targeting_entity_flags,
          turretCount: combat_targeting_turret_count,
          canPlayerObserveEntity: combat_targeting_can_player_observe_entity,
          haltDecisionBatch: combat_targeting_halt_decision_batch,
          entityIdPtr: combat_targeting_entity_id_ptr,
          entityOwnerPlayerIdPtr: combat_targeting_entity_owner_player_id_ptr,
          entityPosXPtr: combat_targeting_entity_pos_x_ptr,
          entityPosYPtr: combat_targeting_entity_pos_y_ptr,
          entityPosZPtr: combat_targeting_entity_pos_z_ptr,
          entityVelXPtr: combat_targeting_entity_vel_x_ptr,
          entityVelYPtr: combat_targeting_entity_vel_y_ptr,
          entityVelZPtr: combat_targeting_entity_vel_z_ptr,
          entityRadiusHitboxPtr: combat_targeting_entity_radius_hitbox_ptr,
          entityHpPtr: combat_targeting_entity_hp_ptr,
          entityFlagsPtr: combat_targeting_entity_flags_ptr,
          entityActiveTurretMaskPtr: combat_targeting_entity_active_turret_mask_ptr,
          entityFiringTurretMaskPtr: combat_targeting_entity_firing_turret_mask_ptr,
          entityTeamAirSightMaskPtr: combat_targeting_entity_team_air_sight_mask_ptr,
          entityTeamWaterSightMaskPtr: combat_targeting_entity_team_water_sight_mask_ptr,
          entityTeamAirRadarMaskPtr: combat_targeting_entity_team_air_radar_mask_ptr,
          entityTeamWaterSonarMaskPtr: combat_targeting_entity_team_water_sonar_mask_ptr,
          entitySensorCoverageMaskPtr: combat_targeting_entity_sensor_coverage_mask_ptr,
          entityFullSightCoverageMaskPtr: combat_targeting_entity_full_sight_coverage_mask_ptr,
          entityDetectorCoverageMaskPtr: combat_targeting_entity_detector_coverage_mask_ptr,
          turretCountPerEntityPtr: combat_targeting_turret_count_per_entity_ptr,
          turretEntityIdPtr: combat_targeting_turret_entity_id_ptr,
          turretParentIdPtr: combat_targeting_turret_parent_id_ptr,
          turretRootHostIdPtr: combat_targeting_turret_root_host_id_ptr,
          turretMountIndexPtr: combat_targeting_turret_mount_index_ptr,
          turretMountXPtr: combat_targeting_turret_mount_x_ptr,
          turretMountYPtr: combat_targeting_turret_mount_y_ptr,
          turretMountZPtr: combat_targeting_turret_mount_z_ptr,
          turretMountVxPtr: combat_targeting_turret_mount_vx_ptr,
          turretMountVyPtr: combat_targeting_turret_mount_vy_ptr,
          turretMountVzPtr: combat_targeting_turret_mount_vz_ptr,
          turretWorldPosTickPtr: combat_targeting_turret_world_pos_tick_ptr,
          turretRotationPtr: combat_targeting_turret_rotation_ptr,
          turretPitchPtr: combat_targeting_turret_pitch_ptr,
          turretAngularVelocityPtr: combat_targeting_turret_angular_velocity_ptr,
          turretPitchVelocityPtr: combat_targeting_turret_pitch_velocity_ptr,
          turretHostPieceYawPtr: combat_targeting_turret_host_piece_yaw_ptr,
          turretHostPieceYawVelocityPtr: combat_targeting_turret_host_piece_yaw_velocity_ptr,
          turretStatePtr: combat_targeting_turret_state_ptr,
          refreshActivityMasksForEntity: combat_targeting_refresh_activity_masks_for_entity,
          refreshActivityMasksBatch: combat_targeting_refresh_activity_masks_batch,
          clearTurretFsm: combat_targeting_clear_turret_fsm,
          turretTargetIdPtr: combat_targeting_turret_target_id_ptr,
          turretCooldownPtr: combat_targeting_turret_cooldown_ptr,
          turretBurstCooldownPtr: combat_targeting_turret_burst_cooldown_ptr,
          turretFireMaxAcquireSqPtr: combat_targeting_turret_fire_max_acquire_sq_ptr,
          turretFireMaxReleaseSqPtr: combat_targeting_turret_fire_max_release_sq_ptr,
          turretFireMinAcquireSqPtr: combat_targeting_turret_fire_min_acquire_sq_ptr,
          turretFireMinReleaseSqPtr: combat_targeting_turret_fire_min_release_sq_ptr,
          turretTrackingAcquireSqPtr: combat_targeting_turret_tracking_acquire_sq_ptr,
          turretTrackingReleaseSqPtr: combat_targeting_turret_tracking_release_sq_ptr,
          turretOutermostAcquirePtr: combat_targeting_turret_outermost_acquire_ptr,
          turretLosBlockedTicksPtr: combat_targeting_turret_los_blocked_ticks_ptr,
          turretConfigFlagsPtr: combat_targeting_turret_config_flags_ptr,
          turretBallisticHasSolutionPtr: combat_targeting_turret_ballistic_has_solution_ptr,
          turretBallisticFlightTimePtr: combat_targeting_turret_ballistic_flight_time_ptr,
          turretBallisticLaunchVxPtr: combat_targeting_turret_ballistic_launch_vx_ptr,
          turretBallisticLaunchVyPtr: combat_targeting_turret_ballistic_launch_vy_ptr,
          turretBallisticLaunchVzPtr: combat_targeting_turret_ballistic_launch_vz_ptr,
          turretBallisticYawPtr: combat_targeting_turret_ballistic_yaw_ptr,
          turretBallisticPitchPtr: combat_targeting_turret_ballistic_pitch_ptr,
          turretBallisticAimXPtr: combat_targeting_turret_ballistic_aim_x_ptr,
          turretBallisticAimYPtr: combat_targeting_turret_ballistic_aim_y_ptr,
          turretBallisticAimZPtr: combat_targeting_turret_ballistic_aim_z_ptr,
          solveBallisticAim: combat_targeting_solve_ballistic_aim,
          prepareAutoScan: combat_targeting_prepare_auto_scan,
          prepareFireChoiceFsmInputs: combat_targeting_prepare_fire_choice_fsm_inputs,
          prepareAcquisitionChoiceFsmInputs: combat_targeting_prepare_acquisition_choice_fsm_inputs,
          rankTarget: combat_targeting_rank_target,
          computeAndChooseBestCandidatesBatch: combat_targeting_compute_and_choose_best_candidates_batch,
          clearTurretLock: combat_targeting_clear_turret_lock,
          clearEntityLocks: combat_targeting_clear_entity_locks,
          applyPriorityPointFsmBatch: combat_targeting_apply_priority_point_fsm_batch,
          computeAndApplyPriorityPointFsmBatch: combat_targeting_compute_and_apply_priority_point_fsm_batch,
          applyPriorityTargetFsmBatch: combat_targeting_apply_priority_target_fsm_batch,
          computeAndApplyPriorityTargetFsmBatch: combat_targeting_compute_and_apply_priority_target_fsm_batch,
          validateExistingLockFsmBatch: combat_targeting_validate_existing_lock_fsm_batch,
          computeAndApplyValidateExistingLockFsmBatch: combat_targeting_compute_and_apply_validate_existing_lock_fsm_batch,
          applyFireChoiceFsmBatch: combat_targeting_apply_fire_choice_fsm_batch,
          applyAcquisitionChoiceFsmBatch: combat_targeting_apply_acquisition_choice_fsm_batch,
          existingLockAndAutoScanTick: combat_targeting_existing_lock_and_auto_scan_tick,
          autoModeCandidateTick: combat_targeting_auto_mode_candidate_tick,
          autoModeSpatialCandidateTick: combat_targeting_auto_mode_spatial_candidate_tick,
          autoModeSpatialCandidateTickBatch: combat_targeting_auto_mode_spatial_candidate_tick_batch,
          tickBatch: combat_targeting_tick_batch,
          scheduleAndTickBatch: combat_targeting_schedule_and_tick_batch,
        },
        shieldSurfacePool: {
          clear: shield_pool_clear,
          count: shield_pool_count,
          setField: shield_pool_set_field,
          setFieldCount: shield_pool_set_count,
          idPtr: shield_pool_id_ptr,
          ownerEntityIdPtr: shield_pool_owner_entity_id_ptr,
          centerXPtr: shield_pool_center_x_ptr,
          centerYPtr: shield_pool_center_y_ptr,
          centerZPtr: shield_pool_center_z_ptr,
          radiusPtr: shield_pool_radius_ptr,
          setUnitCount: shield_panel_pool_set_unit_count,
          setPanelCount: shield_panel_pool_set_panel_count,
          setUnit: shield_panel_pool_set_unit,
          setPanel: shield_panel_pool_set_panel,
          setPanelMaterialMode: shield_panel_pool_set_material_mode,
          clearanceSegment: shield_clearance_segment,
          clearanceArc: shield_clearance_arc,
        },
        renderPose: {
          unitInputScratchPtr: render_unit_pose_input_scratch_ptr,
          unitOutputScratchPtr: render_unit_pose_output_scratch_ptr,
          unitScratchEnsure: render_unit_pose_scratch_ensure,
          unitCompute: render_unit_pose_compute,
          unitInputStride: 23,
          unitOutputStride: 34,
          projectileAxisInputScratchPtr: render_projectile_axis_input_scratch_ptr,
          projectileAxisOutputScratchPtr: render_projectile_axis_output_scratch_ptr,
          projectileAxisScratchEnsure: render_projectile_axis_scratch_ensure,
          projectileAxisCompute: render_projectile_axis_compute,
          projectileAxisInputStride: 4,
          projectileAxisOutputStride: 7,
          plasmaArcPoseInputScratchPtr: render_plasma_arc_pose_input_scratch_ptr,
          plasmaArcPoseOutputScratchPtr: render_plasma_arc_pose_output_scratch_ptr,
          plasmaArcPoseScratchEnsure: render_plasma_arc_pose_scratch_ensure,
          plasmaArcPoseCompute: render_plasma_arc_pose_compute,
          plasmaArcPoseInputStride: 7,
          plasmaArcPoseOutputStride: 16,
          airborneEmitterInputScratchPtr: render_airborne_emitter_input_scratch_ptr,
          airborneEmitterOutputScratchPtr: render_airborne_emitter_output_scratch_ptr,
          airborneEmitterScratchEnsure: render_airborne_emitter_scratch_ensure,
          airborneEmitterCompute: render_airborne_emitter_compute,
          airborneEmitterInputStride: 24,
          airborneEmitterOutputStride: 6,
          buildingInputScratchPtr: render_building_pose_input_scratch_ptr,
          buildingOutputScratchPtr: render_building_pose_output_scratch_ptr,
          buildingScratchEnsure: render_building_pose_scratch_ensure,
          buildingCompute: render_building_pose_compute,
          buildingInputStride: 8,
          buildingOutputStride: 32,
          chassisPartInputScratchPtr: render_chassis_part_input_scratch_ptr,
          chassisPartOutputScratchPtr: render_chassis_part_output_scratch_ptr,
          chassisPartScratchEnsure: render_chassis_part_scratch_ensure,
          chassisPartCompute: render_chassis_part_compute,
          chassisPartInputStride: 15,
          chassisPartOutputStride: 16,
          shieldPanelInputScratchPtr: render_shield_panel_input_scratch_ptr,
          shieldPanelOutputScratchPtr: render_shield_panel_output_scratch_ptr,
          shieldPanelScratchEnsure: render_shield_panel_scratch_ensure,
          shieldPanelCompute: render_shield_panel_compute,
          shieldPanelInputStride: 24,
          shieldPanelOutputStride: 16,
          turretBarrelInputScratchPtr: render_turret_barrel_input_scratch_ptr,
          turretBarrelOutputScratchPtr: render_turret_barrel_output_scratch_ptr,
          turretBarrelScratchEnsure: render_turret_barrel_scratch_ensure,
          turretBarrelCompute: render_turret_barrel_compute,
          turretBarrelInputStride: 38,
          turretBarrelOutputStride: 16,
          turretHeadInputScratchPtr: render_turret_head_input_scratch_ptr,
          turretHeadOutputScratchPtr: render_turret_head_output_scratch_ptr,
          turretHeadScratchEnsure: render_turret_head_scratch_ensure,
          turretHeadCompute: render_turret_head_compute,
          turretHeadInputStride: 15,
          turretHeadOutputStride: 16,
          turretAimInputScratchPtr: render_turret_aim_input_scratch_ptr,
          turretAimOutputScratchPtr: render_turret_aim_output_scratch_ptr,
          turretAimScratchEnsure: render_turret_aim_scratch_ensure,
          turretAimCompute: render_turret_aim_compute,
          turretAimInputStride: 12,
          turretAimOutputStride: 2,
        },
        snapshotEncode: {
          encodeEntityBasic: snapshot_encode_entity_basic,
          encodeEntityUnit: snapshot_encode_entity_unit,
          encodeEntityBuilding: snapshot_encode_entity_building,
          envelopeBegin: snapshot_encode_envelope_begin,
          envelopeBeginPackedEntities: snapshot_encode_envelope_begin_packed_entities,
          envelopeContinue: snapshot_encode_envelope_continue,
          emitEconomy: snapshot_encode_envelope_emit_economy,
          emitMinimap: snapshot_encode_envelope_emit_minimap,
          emitPackedMinimap: snapshot_encode_envelope_emit_packed_minimap,
          emitProjectiles: snapshot_encode_envelope_emit_projectiles,
          emitPackedProjectiles: snapshot_encode_envelope_emit_packed_projectiles,
          minimapScratchPtr: snapshot_encode_minimap_scratch_ptr,
          minimapScratchEnsure: snapshot_encode_minimap_scratch_ensure,
          minimapScratchStride: 7,
          beamUpdateScratchPtr: snapshot_encode_beam_update_scratch_ptr,
          beamUpdateScratchEnsure: snapshot_encode_beam_update_scratch_ensure,
          beamUpdateScratchStride: 4,
          beamPointScratchPtr: snapshot_encode_beam_point_scratch_ptr,
          beamPointScratchEnsure: snapshot_encode_beam_point_scratch_ensure,
          beamPointScratchStride: 12,
          emitScanPulses: snapshot_encode_envelope_emit_scan_pulses,
          scanPulseScratchPtr: snapshot_encode_scan_pulse_scratch_ptr,
          scanPulseScratchEnsure: snapshot_encode_scan_pulse_scratch_ensure,
          scanPulseScratchStride: 6,
          emitPackedTerrain: snapshot_encode_envelope_emit_packed_terrain,
          emitTerrain: snapshot_encode_envelope_emit_terrain,
          emitPackedBuildability: snapshot_encode_envelope_emit_packed_buildability,
          emitBuildability: snapshot_encode_envelope_emit_buildability,
          numberScratchPtr: snapshot_encode_number_scratch_ptr,
          numberScratchEnsure: snapshot_encode_number_scratch_ensure,
          emitSprayTargets: snapshot_encode_envelope_emit_spray_targets,
          sprayScratchPtr: snapshot_encode_spray_scratch_ptr,
          sprayScratchEnsure: snapshot_encode_spray_scratch_ensure,
          sprayScratchStride: 17,
          economyScratchPtr: snapshot_encode_economy_scratch_ptr,
          economyScratchEnsure: snapshot_encode_economy_scratch_ensure,
          economyScratchStride: 11,
          emitResourceMovements: snapshot_encode_envelope_emit_resource_movements,
          resourceMovementScratchPtr: snapshot_encode_resource_movement_scratch_ptr,
          resourceMovementScratchEnsure: snapshot_encode_resource_movement_scratch_ensure,
          resourceMovementScratchStride: 7,
          emitAudioEvents: snapshot_encode_envelope_emit_audio_events,
          emitPackedAudioEvents: snapshot_encode_envelope_emit_packed_audio_events,
          audioEventScratchPtr: snapshot_encode_audio_event_scratch_ptr,
          audioEventScratchEnsure: snapshot_encode_audio_event_scratch_ensure,
          audioEventScratchStride: 20,
          deathContextScratchPtr: snapshot_encode_death_context_scratch_ptr,
          deathContextScratchEnsure: snapshot_encode_death_context_scratch_ensure,
          deathContextScratchStride: 17,
          turretPoseScratchPtr: snapshot_encode_turret_pose_scratch_ptr,
          turretPoseScratchEnsure: snapshot_encode_turret_pose_scratch_ensure,
          turretPoseScratchStride: 2,
          impactContextScratchPtr: snapshot_encode_impact_context_scratch_ptr,
          impactContextScratchEnsure: snapshot_encode_impact_context_scratch_ensure,
          impactContextScratchStride: 11,
          projDespawnScratchPtr: snapshot_encode_proj_despawn_scratch_ptr,
          projDespawnScratchEnsure: snapshot_encode_proj_despawn_scratch_ensure,
          projSpawnScratchPtr: snapshot_encode_proj_spawn_scratch_ptr,
          projSpawnScratchEnsure: snapshot_encode_proj_spawn_scratch_ensure,
          projSpawnScratchStride: 32,
          projVelScratchPtr: snapshot_encode_proj_vel_scratch_ptr,
          projVelScratchEnsure: snapshot_encode_proj_vel_scratch_ensure,
          projVelScratchStride: 9,
          removedIdsScratchPtr: snapshot_encode_removed_ids_scratch_ptr,
          removedIdsScratchEnsure: snapshot_encode_removed_ids_scratch_ensure,
          appendRawValue: messagepack_writer_append_raw_value,
          emitServerMeta: snapshot_encode_envelope_emit_server_meta,
          emitRawKeyValue: snapshot_encode_envelope_emit_raw_key_value,
          emitEntitiesV6: snapshot_encode_emit_entities_v6,
          v6KindsScratchPtr: snapshot_encode_v6_kinds_scratch_ptr,
          v6KindsScratchEnsure: snapshot_encode_v6_kinds_scratch_ensure,
          v6RowIndicesScratchPtr: snapshot_encode_v6_row_indices_scratch_ptr,
          v6RowIndicesScratchEnsure: snapshot_encode_v6_row_indices_scratch_ensure,
          v6BasicScratchPtr: snapshot_encode_v6_basic_scratch_ptr,
          v6BasicScratchEnsure: snapshot_encode_v6_basic_scratch_ensure,
          v6BasicScratchStride: 9,
          v6UnitScratchPtr: snapshot_encode_v6_unit_scratch_ptr,
          v6UnitScratchEnsure: snapshot_encode_v6_unit_scratch_ensure,
          v6UnitScratchStride: 77,
          v6BuildingScratchPtr: snapshot_encode_v6_building_scratch_ptr,
          v6BuildingScratchEnsure: snapshot_encode_v6_building_scratch_ensure,
          v6BuildingScratchStride: 50,
          v6RawBytesScratchPtr: snapshot_encode_v6_raw_bytes_scratch_ptr,
          v6RawBytesScratchEnsure: snapshot_encode_v6_raw_bytes_scratch_ensure,
          v6RawSpansScratchPtr: snapshot_encode_v6_raw_spans_scratch_ptr,
          v6RawSpansScratchEnsure: snapshot_encode_v6_raw_spans_scratch_ensure,
          writerPtr: messagepack_writer_ptr,
          writerLen: messagepack_writer_len,
          writerClear: messagepack_writer_clear,
          turretScratchPtr: snapshot_encode_turret_scratch_ptr,
          turretScratchEnsure: snapshot_encode_turret_scratch_ensure,
          turretScratchStride: 13,
          actionScratchPtr: snapshot_encode_action_scratch_ptr,
          actionScratchEnsure: snapshot_encode_action_scratch_ensure,
          actionScratchStride: 21,
          stringScratchBytesPtr: snapshot_encode_string_scratch_bytes_ptr,
          stringScratchTablePtr: snapshot_encode_string_scratch_table_ptr,
          stringScratchEnsureBytes: snapshot_encode_string_scratch_ensure_bytes,
          stringScratchEnsureTable: snapshot_encode_string_scratch_ensure_table,
          factorySelectedUnitScratchPtr: snapshot_encode_factory_queue_scratch_ptr,
          factorySelectedUnitScratchEnsure: snapshot_encode_factory_queue_scratch_ensure,
          waypointScratchPtr: snapshot_encode_waypoint_scratch_ptr,
          waypointScratchEnsure: snapshot_encode_waypoint_scratch_ensure,
          waypointScratchStride: 5,
        },
        presentation: {
          clear: presentation_clear,
          captureTick: presentation_capture_tick,
          latestTick: presentation_latest_tick,
          hasHistory: presentation_has_history,
          slotInputScratchPtr: presentation_slot_input_scratch_ptr,
          poseOutputScratchPtr: presentation_pose_output_scratch_ptr,
          turretOutputScratchPtr: presentation_turret_output_scratch_ptr,
          scratchEnsure: presentation_scratch_ensure,
          interpolate: presentation_interpolate,
      poseOutputStride: 20,
          turretOutputStride: 8,
          maxTurretsPerEntity: 8,
        },
        spatial: {
          init: spatial_init,
          clear: spatial_clear,
          allocSlot: spatial_alloc_slot,
          freeSlot: spatial_free_slot,
          setEntityId: spatial_set_entity_id,
          setUnit: spatial_set_unit,
          setProjectile: spatial_set_projectile,
          setProjectilesBatch: spatial_set_projectiles_batch,
          setBuilding: spatial_set_building,
          unsetSlot: spatial_unset_slot,
          queryUnitsInRadius: spatial_query_units_in_radius,
          queryBuildingsInRadius: spatial_query_buildings_in_radius,
          queryUnitsAndBuildingsInRadius: spatial_query_units_and_buildings_in_radius,
          queryUnitsAndBuildingsInRect2D: spatial_query_units_and_buildings_in_rect_2d,
          queryEnemyEntitiesInRadius: spatial_query_enemy_entities_in_radius,
          queryEnemyEntitiesInCircle2D: spatial_query_enemy_entities_in_circle_2d,
          queryUnitsAlongLine: spatial_query_units_along_line,
          queryBuildingsAlongLine: spatial_query_buildings_along_line,
          queryProjectilesAlongLine: spatial_query_projectiles_along_line,
          queryEntitiesAlongLine: spatial_query_entities_along_line,
          queryEnemyUnitsInRadius: spatial_query_enemy_units_in_radius,
          queryEnemyProjectilesInRadius: spatial_query_enemy_projectiles_in_radius,
          queryEnemyUnitsAndProjectilesInRadius: spatial_query_enemy_units_and_projectiles_in_radius,
          scratchPtr: spatial_scratch_ptr,
          scratchLen: spatial_scratch_len,
          slotKind: spatial_slot_kind,
        },
        entityState: {
          init: entity_state_init,
          clear: entity_state_clear,
          ensureCapacity: entity_state_ensure_capacity,
          unsetSlot: entity_state_unset_slot,
          capacity: entity_state_capacity,
          setLifecycle: entity_state_set_lifecycle,
          setTransform: entity_state_set_transform,
          setVelocity: entity_state_set_velocity,
          setUnitMotion: entity_state_set_unit_motion,
          setUnitDriveInput: entity_state_set_unit_drive_input,
          setOwnership: entity_state_set_ownership,
          setHpBuild: entity_state_set_hp_build,
          setStaticShape: entity_state_set_static_shape,
          setBodySlot: entity_state_set_body_slot,
          collectBodyEntitySlots: entity_state_collect_body_entity_slots,
          syncBodyMotion: entity_state_sync_body_motion,
          syncEntityBodyMotion: entity_state_sync_entity_body_motion,
          setBlueprints: entity_state_set_blueprints,
          markDirty: entity_state_mark_dirty,
          clearDirty: entity_state_clear_dirty,
          collectDirtySlots: entity_state_collect_dirty_slots,
          collectAwakeBodyEntitySlots: entity_state_collect_awake_body_entity_slots,
          collectAwakeUnitBodyEntitySlots: entity_state_collect_awake_unit_body_entity_slots,
          sortSlotsByEntityId: entity_state_sort_slots_by_entity_id,
          setProjectilesHotBatch: entity_state_set_projectiles_hot_batch,
          entityIdPtr: entity_state_entity_id_ptr,
          kindPtr: entity_state_kind_ptr,
          flagsPtr: entity_state_flags_ptr,
          ownerPlayerIdPtr: entity_state_owner_player_id_ptr,
          teamIdPtr: entity_state_team_id_ptr,
          posXPtr: entity_state_pos_x_ptr,
          posYPtr: entity_state_pos_y_ptr,
          posZPtr: entity_state_pos_z_ptr,
          rotationPtr: entity_state_rotation_ptr,
          velXPtr: entity_state_vel_x_ptr,
          velYPtr: entity_state_vel_y_ptr,
          velZPtr: entity_state_vel_z_ptr,
          surfaceNormalXPtr: entity_state_surface_normal_x_ptr,
          surfaceNormalYPtr: entity_state_surface_normal_y_ptr,
          surfaceNormalZPtr: entity_state_surface_normal_z_ptr,
          orientationXPtr: entity_state_orientation_x_ptr,
          orientationYPtr: entity_state_orientation_y_ptr,
          orientationZPtr: entity_state_orientation_z_ptr,
          orientationWPtr: entity_state_orientation_w_ptr,
          angularVelocityXPtr: entity_state_angular_velocity_x_ptr,
          angularVelocityYPtr: entity_state_angular_velocity_y_ptr,
          angularVelocityZPtr: entity_state_angular_velocity_z_ptr,
          unitMotionFlagsPtr: entity_state_unit_motion_flags_ptr,
          unitThrustDirXPtr: entity_state_unit_thrust_dir_x_ptr,
          unitThrustDirYPtr: entity_state_unit_thrust_dir_y_ptr,
          unitHeadingDirXPtr: entity_state_unit_heading_dir_x_ptr,
          unitHeadingDirYPtr: entity_state_unit_heading_dir_y_ptr,
          hpPtr: entity_state_hp_ptr,
          maxHpPtr: entity_state_max_hp_ptr,
          radiusCollisionPtr: entity_state_radius_collision_ptr,
          radiusHitboxPtr: entity_state_radius_hitbox_ptr,
          radiusOtherPtr: entity_state_radius_other_ptr,
          aabbHxPtr: entity_state_aabb_hx_ptr,
          aabbHyPtr: entity_state_aabb_hy_ptr,
          aabbHzPtr: entity_state_aabb_hz_ptr,
          bodySlotPtr: entity_state_body_slot_ptr,
          unitBlueprintCodePtr: entity_state_unit_blueprint_code_ptr,
          buildingBlueprintCodePtr: entity_state_building_blueprint_code_ptr,
          shotBlueprintCodePtr: entity_state_shot_blueprint_code_ptr,
          projectileTypeCodePtr: entity_state_projectile_type_code_ptr,
          buildProgressPtr: entity_state_build_progress_ptr,
          buildPaidEnergyPtr: entity_state_build_paid_energy_ptr,
          buildPaidMetalPtr: entity_state_build_paid_metal_ptr,
          buildFlagsPtr: entity_state_build_flags_ptr,
          dirtyMaskPtr: entity_state_dirty_mask_ptr,
        },
      };
      resolvedHandle = handle;
      // Blueprint modules are allowed to load while the WASM request is still
      // in flight. Run validation that derives geometry through authoritative
      // deterministic math only after publishing the initialized handle.
      const { validateFabricatorProgressionGeometry } = await import(
        '../sim/blueprints/buildings'
      );
      validateFabricatorProgressionGeometry();
      const { warmPathfindingMobilityCache } = await import('../sim/pathfindingMobilityCache');
      warmPathfindingMobilityCache();
      if (import.meta.env.DEV && !shouldRunBootContractTests()) {
        console.info(
          '(dev) boot contract tests skipped — opt in with ?contractTests=1 or localStorage BA_RUN_CONTRACT_TESTS="1"',
        );
      }
      if (import.meta.env.DEV && shouldRunBootContractTests()) {
        const { runServerBarConfigContractTest } = await import('../../serverBarConfigContractTest');
        runServerBarConfigContractTest();
        const { runDemoBuildingRosterContractTest } = await import('../../demoBuildingRosterContractTest');
        runDemoBuildingRosterContractTest();
        const { runUnitCapPolicyContractTest } = await import('../../unitCapPolicyContractTest');
        runUnitCapPolicyContractTest();
        const { runRealBattleSettingsDeterminismContractTest } = await import('../../realBattleSettingsDeterminismContractTest');
        runRealBattleSettingsDeterminismContractTest();
        const { runDeterministicLockstepBackendContractTest } = await import('../../components/gameCanvasDeterministicLockstepBackendContractTest');
        await runDeterministicLockstepBackendContractTest();
        const { runCommandSanitizerContractTest } = await import('../server/commandSanitizerContractTest');
        runCommandSanitizerContractTest();
        const { runCaptureControllerContractTest } = await import('../capture/CaptureControllerContractTest');
        runCaptureControllerContractTest();
        const { runServerSnapshotPublisherContractTest } = await import('../server/ServerSnapshotPublisherContractTest');
        runServerSnapshotPublisherContractTest();
        const { runLockstepCommandProtocolContractTest } = await import('../architecture/LockstepCommandProtocolContractTest');
        runLockstepCommandProtocolContractTest();
        const { runLockstepFrameSchedulerContractTest } = await import('../architecture/LockstepFrameSchedulerContractTest');
        runLockstepFrameSchedulerContractTest();
        const { runLockstepDesyncMonitorContractTest } = await import('../architecture/LockstepDesyncMonitorContractTest');
        runLockstepDesyncMonitorContractTest();
        const { runLockstepSupportPolicyContractTest } = await import('../architecture/LockstepSupportPolicyContractTest');
        runLockstepSupportPolicyContractTest();
        const { runLockstepFlowControlContractTest } = await import('../architecture/LockstepFlowControlContractTest');
        runLockstepFlowControlContractTest();
        const { runMatchCatchUpContractTest } = await import('../architecture/MatchCatchUpContractTest');
        runMatchCatchUpContractTest();
        const { runLockstepDiagnosticsContractTest } = await import('../architecture/LockstepDiagnosticsContractTest');
        runLockstepDiagnosticsContractTest();
        const { runCanonicalCheckpointContractTest } = await import('../architecture/CanonicalCheckpointContractTest');
        runCanonicalCheckpointContractTest();
        const { runMatchArchiveReplayContractTest } = await import('../architecture/MatchArchiveReplayContractTest');
        runMatchArchiveReplayContractTest();
        const { runReplayRecorderContractTest } = await import('../server/ReplayRecorderContractTest');
        runReplayRecorderContractTest();
        const { runForceAccumulatorContractTest } = await import('../sim/ForceAccumulatorContractTest');
        runForceAccumulatorContractTest();
        const { runSeededRNGContractTest } = await import('../sim/SeededRNGContractTest');
        runSeededRNGContractTest();
        const { runSnapshotEntityWirePackContractTest } = await import('../network/snapshotEntityWirePackContractTest');
        runSnapshotEntityWirePackContractTest();
        const { runNetworkLockstepTransportContractTest } = await import('../network/NetworkLockstepTransportContractTest');
        runNetworkLockstepTransportContractTest();
        const { runNetworkManagerLockstepBufferContractTest } = await import('../network/NetworkManagerLockstepBufferContractTest');
        runNetworkManagerLockstepBufferContractTest();
        const { runLobbySettingsContractTest } = await import('../network/LobbySettingsContractTest');
        runLobbySettingsContractTest();
        const { runNetworkLobbySeatingContractTest } = await import('../network/NetworkLobbySeatingContractTest');
        runNetworkLobbySeatingContractTest();
        const { runStateMachineContractTest } = await import('../state/StateMachineContractTest');
        runStateMachineContractTest();
        const { runAppSurfaceMachineContractTest } = await import('../../appSurfaceMachineContractTest');
        runAppSurfaceMachineContractTest();
        const { runClientSnapshotApplierContractTest } = await import('../network/ClientSnapshotApplierContractTest');
        runClientSnapshotApplierContractTest();
        const { runShieldFarLodRenderPacketContractTest, runTypedSensorHydrationContractTest } = await import('../network/ClientSnapshotApplierContractTest');
        runShieldFarLodRenderPacketContractTest();
        runTypedSensorHydrationContractTest();
        const { runShieldFieldDetailLevel3DContractTest } = await import('../render3d/ShieldFieldDetailLevel3DContractTest');
        runShieldFieldDetailLevel3DContractTest();
        const { runClientEntityStoreContractTest } = await import('../network/ClientEntityStoreContractTest');
        runClientEntityStoreContractTest();
        const { runClientEntityIdSetContractTest } = await import('../network/ClientEntityIdSetContractTest');
        runClientEntityIdSetContractTest();
        const { runClientServerTargetStoreContractTest } = await import('../network/ClientServerTargetStoreContractTest');
        runClientServerTargetStoreContractTest();
        const { runChatPolicyContractTest } = await import('../network/ChatPolicyContractTest');
        runChatPolicyContractTest();
        const { runSnapshotVisibilityContractTest } = await import('../network/SnapshotVisibilityContractTest');
        runSnapshotVisibilityContractTest();
        const { runSensorSharingContractTest } = await import('../network/sensorSharingContractTest');
        runSensorSharingContractTest();
        const { runSnapshotBufferContractTest } = await import('../scenes/helpers/SnapshotBufferContractTest');
        runSnapshotBufferContractTest();
        const { runCommandHotkeysContractTest } = await import('../input/commandHotkeysContractTest');
        runCommandHotkeysContractTest();
        const { runRosterCommandSurfaceContractTest } = await import('../sim/blueprints/rosterCommandSurfaceContractTest');
        runRosterCommandSurfaceContractTest();
        const { runFullUtilizationRosterContractTest } = await import('../sim/blueprints/fullUtilizationRosterContractTest');
        runFullUtilizationRosterContractTest();
        const { runBarCommandParityContractTest } = await import('../sim/blueprints/barCommandParityContractTest');
        runBarCommandParityContractTest();
        // Command-surface gates. These enforce that every button, hotkey, and
        // order the player can reach has an authoritative system behind it
        // (budget_design_philosophy.html "Commands require real systems").
        const { runSelectionPanelCommandSurfaceContractTest } = await import('../../components/SelectionPanelCommandSurfaceContractTest');
        runSelectionPanelCommandSurfaceContractTest();
        const { runEntityPreviewWarmupContractTest } = await import('../../components/entityPreviewWarmupContractTest');
        runEntityPreviewWarmupContractTest();
        const { runServerCommandAuthorizerContractTest } = await import('../server/ServerCommandAuthorizerContractTest');
        runServerCommandAuthorizerContractTest();
        const { runInputSelectedCommandsContractTest } = await import('../input/helpers/InputSelectedCommandsContractTest');
        runInputSelectedCommandsContractTest();
        const { runFactoryProductionPresetsContractTest } = await import('../input/factoryProductionPresetsContractTest');
        runFactoryProductionPresetsContractTest();
        const { runUIUpdateManagerContractTest } = await import('../scenes/helpers/UIUpdateManagerContractTest');
        runUIUpdateManagerContractTest();
        const { runSimulationIdleBuilderAutoRepairContractTest } = await import('../sim/SimulationIdleBuilderAutoRepairContractTest');
        runSimulationIdleBuilderAutoRepairContractTest();
        const { runBackgroundBattleStandaloneContractTest } = await import('../server/BackgroundBattleStandaloneContractTest');
        runBackgroundBattleStandaloneContractTest();
        const { runUnitLocomotionContractTest } = await import('../sim/blueprints/unitLocomotionContractTest');
        runUnitLocomotionContractTest();
        const { runWaterLocomotionSeparationContractTest } = await import('../sim/blueprints/waterLocomotionSeparationContractTest');
        runWaterLocomotionSeparationContractTest();
        const { runPathfindingMobilityContractTest } = await import('../sim/pathfindingMobilityContractTest');
        runPathfindingMobilityContractTest();
        const { runPathfindingDebugGridContractTest } = await import('../sim/pathfindingDebugGridContractTest');
        runPathfindingDebugGridContractTest();
        const { runUnitWaterLiftLocomotionContractTest } = await import('../sim/blueprints/unitWaterLiftLocomotionContractTest');
        runUnitWaterLiftLocomotionContractTest();
        const { runShotLocomotionContractTest } = await import('../sim/shotLocomotionContractTest');
        runShotLocomotionContractTest();
        const { runEmissionMediumContractTest } = await import('../sim/emissionMediumContractTest');
        runEmissionMediumContractTest();
        const { runShotArmingContractTest } = await import('../sim/combat/shotArmingContractTest');
        runShotArmingContractTest();
        const { runBoxSelectionContractTest } = await import('../input/helpers/BoxSelectionContractTest');
        runBoxSelectionContractTest();
        const { runAreaMexPlacementContractTest } = await import('../render3d/AreaMexPlacementContractTest');
        runAreaMexPlacementContractTest();
        const { runRightClickCommandsContractTest } = await import('../input/helpers/RightClickCommandsContractTest');
        runRightClickCommandsContractTest();
        const { runBarDefaultPointerActionContractTest } = await import('../input/helpers/BarDefaultPointerActionContractTest');
        runBarDefaultPointerActionContractTest();
        const { runGuardFollowContractTest } = await import('../sim/guardFollowContractTest');
        runGuardFollowContractTest();
        const { runGuardParityContractTest } = await import('../sim/guardParityContractTest');
        runGuardParityContractTest();
        const { runCommandExecutionContractTest } = await import('../sim/commandExecutionContractTest');
        runCommandExecutionContractTest();
        const { runCommandCoverageContractTest } = await import('../sim/commandCoverageContractTest');
        runCommandCoverageContractTest();
        const { runSimulationGameOverContractTest } = await import('../sim/SimulationGameOverContractTest');
        runSimulationGameOverContractTest();
        const { runSimulationUnitActionPlannerContractTest } = await import('../sim/SimulationUnitActionPlannerContractTest');
        runSimulationUnitActionPlannerContractTest();
        const { runEntityCacheManagerContractTest } = await import('../sim/EntityCacheManagerContractTest');
        runEntityCacheManagerContractTest();
        const { runEntitySlotRegistryContractTest } = await import('../sim/EntitySlotRegistryContractTest');
        runEntitySlotRegistryContractTest();
        const { runClientRenderEntityStateSlabContractTest } = await import('../render3d/ClientRenderEntityStateSlabContractTest');
        runClientRenderEntityStateSlabContractTest();
        const { runTransparentRenderOrder3DContractTest } = await import('../render3d/TransparentRenderOrder3DContractTest');
        runTransparentRenderOrder3DContractTest();
        const { runWaterRenderer3DContractTest } = await import('../render3d/WaterRenderer3DContractTest');
        runWaterRenderer3DContractTest();
        const { runWorldBoundaryShaderContractTest } = await import('../render3d/WorldBoundaryShaderContractTest');
        runWorldBoundaryShaderContractTest();
        const { runParallaxBackdropRenderer3DContractTest } = await import('../render3d/ParallaxBackdropRenderer3DContractTest');
        runParallaxBackdropRenderer3DContractTest();
        const { runMapInfoAnnex3DContractTest } = await import('../render3d/MapInfoAnnex3DContractTest');
        runMapInfoAnnex3DContractTest();
        const { runMapPresetLabel3DContractTest } = await import('../render3d/MapPresetLabel3DContractTest');
        runMapPresetLabel3DContractTest();
        const { runGameCanvasWorldSurfaceSelectionContractTest } = await import('../../components/gameCanvasWorldSurfaceSelectionContractTest');
        runGameCanvasWorldSurfaceSelectionContractTest();
        const { runClientRenderSpatialIndexContractTest } = await import('../network/ClientRenderSpatialIndexContractTest');
        runClientRenderSpatialIndexContractTest();
        const { runClientProjectileRenderStateSlabContractTest } = await import('../network/ClientProjectileRenderStateSlabContractTest');
        runClientProjectileRenderStateSlabContractTest();
        const { runTurretSnapshotDirtyContractTest } = await import('../network/turretSnapshotDirtyContractTest');
        runTurretSnapshotDirtyContractTest();
        const { runPrimitiveGeometryQuality3DContractTest } = await import('../render3d/PrimitiveGeometryQuality3DContractTest');
        runPrimitiveGeometryQuality3DContractTest();
        const { runProjectileTrailHistory3DContractTest } = await import('../render3d/ProjectileTrailHistory3DContractTest');
        runProjectileTrailHistory3DContractTest();
        const { runEntityLodGeometry3DContractTest } = await import('../render3d/EntityLodGeometry3DContractTest');
        runEntityLodGeometry3DContractTest();
        const { runGroundSilhouetteShadow3DContractTest } = await import('../render3d/GroundSilhouetteShadow3DContractTest');
        runGroundSilhouetteShadow3DContractTest();
        const { runRtsScene3DVisualEventDispatcherContractTest } = await import('../scenes/helpers/RtsScene3DVisualEventDispatcherContractTest');
        runRtsScene3DVisualEventDispatcherContractTest();
        const { runHostTurretPresentationGeometry3DContractTest } = await import('../render3d/EntityLodGeometry3DContractTest');
        runHostTurretPresentationGeometry3DContractTest();
        const { runTeamOrnament3DContractTest } = await import('../render3d/TeamOrnament3DContractTest');
        runTeamOrnament3DContractTest();
        const { runBuildingTeamOrnament3DContractTest } = await import('../render3d/BuildingTeamOrnament3DContractTest');
        runBuildingTeamOrnament3DContractTest();
        const { runBuildingOperationalVisual3DContractTest } = await import('../render3d/BuildingOperationalVisual3DContractTest');
        runBuildingOperationalVisual3DContractTest();
        const { runSurfaceChart3DContractTest } = await import('../render3d/SurfaceChart3DContractTest');
        runSurfaceChart3DContractTest();
        const { runDirectionalTravelSlotSurfaceChart3DContractTest } = await import('../render3d/SurfaceChart3DContractTest');
        runDirectionalTravelSlotSurfaceChart3DContractTest();
        const { runTurretAimPose3DContractTest } = await import('../render3d/TurretAimPose3DContractTest');
        runTurretAimPose3DContractTest();
        const { runBotHostTurretAim3DContractTest } = await import('../render3d/BotHostTurretAim3DContractTest');
        runBotHostTurretAim3DContractTest();
        const { runAuthoritativeTurretSocketContractTest } = await import('../sim/authoritativeTurretSocketContractTest');
        runAuthoritativeTurretSocketContractTest();
        const { runCommanderGeometry3DContractTest } = await import('../render3d/CommanderGeometry3DContractTest');
        runCommanderGeometry3DContractTest();
        const { runBuildingTurretPresentation3DContractTest } = await import('../render3d/BuildingTurretPresentation3DContractTest');
        runBuildingTurretPresentation3DContractTest();
        const { runQueenArmamentContractTest } = await import('../sim/blueprints/queenArmamentContractTest');
        runQueenArmamentContractTest();
        const { runDroneFanPlacement3DContractTest } = await import('../render3d/DroneFanPlacement3DContractTest');
        runDroneFanPlacement3DContractTest();
        const { runEntityDeathDisassembly3DContractTest } = await import('../render3d/EntityDeathDisassembly3DContractTest');
        runEntityDeathDisassembly3DContractTest();
        const { runShotArmingOverlay3DContractTest } = await import('../render3d/ShotArmingOverlay3DContractTest');
        runShotArmingOverlay3DContractTest();
        const { runHostVolumeOverlay3DContractTest } = await import('../render3d/HostVolumeOverlay3DContractTest');
        runHostVolumeOverlay3DContractTest();
        const { runTurretLockOnVolume3DContractTest } = await import('../render3d/TurretLockOnVolume3DContractTest');
        runTurretLockOnVolume3DContractTest();
        const { runEntityLod3DContractTest } = await import('../render3d/EntityLod3DContractTest');
        runEntityLod3DContractTest();
        const { runEntityDetailLevel3DContractTest } = await import('../render3d/EntityDetailLevel3DContractTest');
        runEntityDetailLevel3DContractTest();
        const { runRollingLocomotionContractTest } = await import('../render3d/RollingLocomotionContractTest');
        runRollingLocomotionContractTest();
        const { runCrawlerRig3DContractTest } = await import('../render3d/CrawlerRig3DContractTest');
        runCrawlerRig3DContractTest();
        const { runInputControlGroupsContractTest } = await import('../input/helpers/InputControlGroupsContractTest');
        runInputControlGroupsContractTest();
        const { runInput3DKeyboardControllerContractTest } = await import('../render3d/Input3DKeyboardControllerContractTest');
        runInput3DKeyboardControllerContractTest();
        const { runOrbitCameraContractTest } = await import('../render3d/OrbitCameraContractTest');
        runOrbitCameraContractTest();
        const { runInput3DModeClickControllerContractTest } = await import('../render3d/Input3DModeClickControllerContractTest');
        runInput3DModeClickControllerContractTest();
        const { runInput3DTargetTypeTrackerContractTest } = await import('../render3d/Input3DTargetTypeTrackerContractTest');
        runInput3DTargetTypeTrackerContractTest();
        const { runBuildGhost3DContractTest } = await import('../render3d/BuildGhost3DContractTest');
        runBuildGhost3DContractTest();
        const { runBuildGridAvailability3DContractTest } = await import('../render3d/BuildGridAvailability3DContractTest');
        runBuildGridAvailability3DContractTest();
        const { runResourcePylonFlowController3DContractTest } = await import('../render3d/ResourcePylonFlowController3DContractTest');
        runResourcePylonFlowController3DContractTest();
        const { runSprayRenderer3DContractTest } = await import('../render3d/SprayRenderer3DContractTest');
        runSprayRenderer3DContractTest();
        const { runMetalDepositSurfaceField3DContractTest } = await import('../render3d/MetalDepositSurfaceField3DContractTest');
        runMetalDepositSurfaceField3DContractTest();
        const { runTerrainWallWear3DContractTest } = await import('../render3d/TerrainWallWear3DContractTest');
        runTerrainWallWear3DContractTest();
        const { runVegetationWeathering3DContractTest } = await import('../render3d/VegetationWeathering3DContractTest');
        runVegetationWeathering3DContractTest();
        const { runProjectileGuidanceCadenceContractTest, runTurretHostIntegrationContractTest } = await import('../sim/turretHostIntegrationTest');
        runProjectileGuidanceCadenceContractTest();
        runTurretHostIntegrationContractTest();
        const { runPrecisionFireContractTest } = await import('../sim/combat/precisionFireContractTest');
        runPrecisionFireContractTest();
        const { runBallisticHitContractTest } = await import('../sim/combat/ballisticHitContractTest');
        runBallisticHitContractTest();
        const { runResourceMovementConformanceContractTest } = await import('../sim/resourceMovementConformanceContractTest');
        runResourceMovementConformanceContractTest();
        const { runBuildingFootprintContractTest } = await import('../sim/buildingFootprintContractTest');
        runBuildingFootprintContractTest();
        const { runUnfinishedBuildDecayContractTest } = await import('../sim/unfinishedBuildDecayContractTest');
        runUnfinishedBuildDecayContractTest();
        const { runBuildingTurretRestContractTest } = await import('../sim/buildingTurretRestContractTest');
        runBuildingTurretRestContractTest();
        const { runGameplaySettingCommandContractTest } = await import('../sim/gameplaySettingCommandContractTest');
        runGameplaySettingCommandContractTest();
        const { runBuildingCollisionSpawnContractTest } = await import('../sim/buildingCollisionSpawnContractTest');
        runBuildingCollisionSpawnContractTest();
        const { runSupportSurfaceContractTest } = await import('../sim/supportSurfaceContractTest');
        runSupportSurfaceContractTest();
        const { runFabricatorProductionRingContractTest, runQueenFactoryProductionContractTest } = await import('../sim/supportSurfaceContractTest');
        runFabricatorProductionRingContractTest();
        runQueenFactoryProductionContractTest();
        const { runWaterSurfaceBuildingContractTest } = await import('../sim/waterSurfaceBuildingContractTest');
        runWaterSurfaceBuildingContractTest();
        const { runMapSurfaceRosterContractTest } = await import('../sim/mapSurfaceRosterContractTest');
        runMapSurfaceRosterContractTest();
        const { runBuildingUtilityStructuresContractTest } = await import('../sim/buildingUtilityStructuresContractTest');
        runBuildingUtilityStructuresContractTest();
        const { runDemoMetalExtractorSpawnContractTest } = await import('../sim/demoMetalExtractorSpawnContractTest');
        runDemoMetalExtractorSpawnContractTest();
        const { runMetalCoverageContractTest } = await import('../sim/metalCoverageContractTest');
        runMetalCoverageContractTest();
        const { runDemoInitialBaseActiveStateContractTest } = await import('../sim/demoInitialBaseActiveStateContractTest');
        runDemoInitialBaseActiveStateContractTest();
        const { runTeamRosterContractTest } = await import('../sim/teamRosterContractTest');
        runTeamRosterContractTest();
        const { runSimulationPathPlanSchedulerContractTest } = await import('../sim/SimulationPathPlanSchedulerContractTest');
        runSimulationPathPlanSchedulerContractTest();
        const { runPathfindingTraversalContractTest } = await import('../sim/pathfindingTraversalContractTest');
        runPathfindingTraversalContractTest();
        const { runPathPlanSafetyContractTest } = await import('../sim/pathPlanSafetyContractTest');
        runPathPlanSafetyContractTest();
        const { runTeamColorContractTest } = await import('../sim/teamColorContractTest');
        runTeamColorContractTest();
        const { runTerrainUnderwaterDarkeningContractTest } = await import('../sim/terrain/terrainUnderwaterDarkeningContractTest');
        runTerrainUnderwaterDarkeningContractTest();
      }
      return handle;
    })();
  }
  return cached;
}

/** Synchronous accessor for the loaded WASM handle. Returns
 *  undefined if `initSimWasm()` hasn't resolved yet. Hot paths
 *  call this once at construction (or use the awaited handle)
 *  and cache it locally to avoid per-tick lookup overhead. */
export function getSimWasm(): SimWasm | undefined {
  return resolvedHandle;
}

/** Synchronous accessor for code paths whose owning lifecycle guarantees that
 * initialization has completed. */
export function requireSimWasm(context: string): SimWasm {
  const sim = getSimWasm();
  if (sim === undefined) {
    throw new Error(`${context}: sim-wasm is not initialized`);
  }
  return sim;
}

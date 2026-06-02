// rts-sim-wasm init — singleton loader.
//
// This module is the ONLY place either the server tick or the
// client prediction stepper should obtain the WASM handle from.
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

// Single source of truth for the wire codes TS and Rust must agree on; the
// Rust crate generates its CT_TURRET_STATE_* constants from this same file.
import wireEnums from '../../wireEnums.json';
import __wbg_init, {
  type InitInput,
  version,
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
  construction_reconcile_and_grow_pieces,
  construction_apply_consumer_spends,
  economy_apply_income_credits,
  economy_apply_converter_transfers,
  arrival_completion_step_batch,
  flying_loiter_step_batch,
  stuck_replan_step_batch,
  turret_rotation_step_batch,
  step_unit_motion,
  client_predict_unit_motion_batch,
  pool_init,
  pool_capacity,
  pool_alloc_slot,
  pool_free_slot,
  pool_prepare_dynamic_step,
  pool_collect_awake_entity_ids,
  pool_finalize_dynamic_step,
  pool_step_integrate,
  pool_resolve_sphere_sphere,
  engine_statics_create,
  engine_statics_destroy,
  engine_statics_add,
  engine_statics_remove,
  pool_resolve_sphere_cuboid_full,
  quat_hover_orientation_step_batch,
  unit_force_step_batch,
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
  terrain_follow_vertical_thrust_accel,
  solve_kinematic_intercept,
  compute_homing_thrust,
  integrate_damped_rotation,
  metal_deposit_count_placements,
  metal_deposit_generate_placements,
  metal_deposit_resolve_terrain_heights,
  metal_deposit_count_resource_candidates,
  metal_deposit_grow_resource_cells,
  terrain_install_mesh,
  terrain_clear,
  terrain_is_installed,
  terrain_count_cell_triangle_refs,
  terrain_fill_cell_triangle_indices,
  terrain_build_adaptive_mesh,
  terrain_get_surface_height,
  terrain_get_surface_normal,
  terrain_sample_ground_for_slots,
  terrain_bake_buildability_grid,
  terrain_has_line_of_sight,
  fog_mark_circle_scanline,
  fog_mark_circle_scanline_rgba,
  combat_has_line_of_sight,
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
  spatial_query_occupied_cells_debug,
  spatial_scratch_ptr,
  spatial_scratch_len,
  spatial_slot_kind,
  pathfinder_init,
  pathfinder_rebuild_mask_and_cc,
  pathfinder_find_path,
  pathfinder_waypoints_ptr,
  pathfinder_grid_size_w,
  pathfinder_grid_size_h,
  messagepack_self_test,
  entity_meta_init,
  entity_meta_clear,
  entity_meta_register,
  entity_meta_unregister,
  entity_meta_unregister_root,
  entity_meta_resolve_row,
  entity_meta_generation,
  entity_meta_resolve_storage_slot,
  entity_meta_set_unit,
  entity_meta_set_building,
  entity_meta_set_tower,
  entity_meta_unset,
  entity_meta_type,
  entity_meta_type_ptr,
  entity_meta_player_id_ptr,
  entity_meta_hp_curr_ptr,
  entity_meta_hp_max_ptr,
  entity_meta_combat_mode_ptr,
  entity_meta_is_commander_ptr,
  entity_meta_build_complete_ptr,
  entity_meta_build_paid_energy_ptr,
  entity_meta_build_paid_metal_ptr,
  entity_meta_build_target_id_ptr,
  entity_meta_suspension_spring_offset_ptr,
  entity_meta_suspension_spring_velocity_ptr,
  entity_meta_factory_is_producing_ptr,
  entity_meta_factory_build_queue_len_ptr,
  entity_meta_factory_progress_ptr,
  entity_meta_solar_open_ptr,
  entity_meta_build_progress_ptr,
  entity_meta_capacity,
  entity_meta_registry_entity_id_ptr,
  entity_meta_registry_kind_ptr,
  entity_meta_registry_blueprint_kind_ptr,
  entity_meta_registry_blueprint_code_ptr,
  entity_meta_registry_owner_player_id_ptr,
  entity_meta_registry_team_id_ptr,
  entity_meta_registry_parent_id_ptr,
  entity_meta_registry_root_host_id_ptr,
  entity_meta_registry_mount_index_ptr,
  entity_meta_registry_storage_pool_ptr,
  entity_meta_registry_storage_slot_ptr,
  entity_meta_registry_generation_ptr,
  entity_meta_registry_alive_ptr,
  entity_meta_registry_targetable_ptr,
  entity_meta_registry_capacity,
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
  combat_targeting_max_turrets_per_entity,
  combat_targeting_entity_capacity,
  combat_targeting_set_entity,
  combat_targeting_unset_entity,
  combat_targeting_rebuild_observation_masks,
  combat_targeting_rebuild_observation_masks_for_sources,
  combat_targeting_add_sensor_observation_circle,
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
  projectile_hitbox_sweep_batch,
  snapshot_baseline_create,
  snapshot_baseline_destroy,
  snapshot_baseline_clear,
  snapshot_baseline_unset_slot,
  snapshot_baseline_ensure_capacity,
  snapshot_baseline_live_count,
  snapshot_baseline_capture_unit_slot,
  snapshot_baseline_capture_building_slot,
  snapshot_baseline_slot_used,
  snapshot_baseline_slot_last_tick,
  snapshot_baseline_diff_slot,
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
  snapshot_encode_envelope_emit_shroud,
  snapshot_encode_shroud_scratch_ptr,
  snapshot_encode_shroud_scratch_ensure,
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
  pool_ground_friction_scale_ptr,
  pool_sleep_ticks_ptr,
  pool_flags_ptr,
  pool_entity_id_ptr,
} from './pkg/rts_sim_wasm';


/** Public handle to the loaded WASM module. Re-exported kernels
 *  + the Body3D pool views + per-engine static-cuboid handles all
 *  hang off this. */
export interface SimWasm {
  /** Build-stamp from the Rust crate (CARGO_PKG_VERSION).
   *  Useful in dev / startup logs to confirm a fresh wasm-pack
   *  build is being served. */
  readonly version: string;
  readonly windSampleState: (nowMs: number, out: Float64Array) => number;
  readonly buildTargetHorizontalDistance: (
    builderX: number,
    builderY: number,
    targetX: number,
    targetY: number,
    targetKind: number,
    targetWidth: number,
    targetHeight: number,
    targetRadius: number,
  ) => number;
  readonly commanderApplyReclaimTick: (
    hpCurr: number,
    hpMax: number,
    constructionRate: number,
    dtSec: number,
    valueEnergy: number,
    valueMetal: number,
    refundFraction: number,
    out: Float64Array,
  ) => number;
  readonly factoryBuildSpot: (
    factoryX: number,
    factoryY: number,
    rallyX: number,
    rallyY: number,
    fallbackDirX: number,
    fallbackDirY: number,
    unitRadius: number,
    footprintWidth: number,
    footprintHeight: number,
    constructionRadius: number,
    buildClearance: number,
    buildRadiusFraction: number,
    mapWidth: number,
    mapHeight: number,
    clampRadius: number,
    out: Float64Array,
  ) => number;
  readonly factoryBuildSpotBlocked: (
    x: number,
    y: number,
    radius: number,
    obstacleX: Float64Array,
    obstacleY: Float64Array,
    obstacleRadius: Float64Array,
    count: number,
  ) => number;
  readonly factoryPlanProductionActions: (
    hasShell: Uint8Array,
    shellExists: Uint8Array,
    shellHasBuildable: Uint8Array,
    shellBuildableComplete: Uint8Array,
    shellInterrupted: Uint8Array,
    shellPaidEnergy: Float64Array,
    shellPaidMetal: Float64Array,
    shellRequiredEnergy: Float64Array,
    shellRequiredMetal: Float64Array,
    selectedState: Uint8Array,
    canBuildUnit: Uint8Array,
    isProducing: Uint8Array,
    count: number,
    outAction: Uint8Array,
    outProgress: Float64Array,
  ) => number;
  readonly buildingActiveStateStepBatch: (
    open: Uint8Array,
    active: Uint8Array,
    damageDelayMs: Float64Array,
    reopenDelayMs: Float64Array,
    count: number,
    dtMs: number,
    reopenDelayResetMs: number,
    outOpenChanged: Uint8Array,
  ) => number;
  readonly economyAccumulatePlayerRates: (
    playerIds: Uint32Array,
    rates: Float64Array,
    count: number,
    outRatesByPlayer: Float64Array,
  ) => number;
  readonly economyComputeConverterTransfer: (
    energyCurr: number,
    energyMax: number,
    metalCurr: number,
    metalMax: number,
    totalRatePerSec: number,
    dtSec: number,
    tax: number,
    out: Float64Array,
  ) => number;
  readonly economyCreditStockpile: (
    curr: number,
    max: number,
    amount: number,
    out: Float64Array,
  ) => number;
  readonly economyDebitStockpile: (
    curr: number,
    amount: number,
    out: Float64Array,
  ) => number;
  readonly economyApplyEqualConsumerDebits: (
    remaining: Float64Array,
    caps: Float64Array,
    count: number,
    participantCount: number,
    stockpileCurr: number,
    outSpent: Float64Array,
    outTotals: Float64Array,
  ) => number;
  readonly constructionApplyConsumerSpends: (
    consumerTypes: Uint8Array,
    paidEnergy: Float64Array,
    paidMetal: Float64Array,
    requiredEnergy: Float64Array,
    requiredMetal: Float64Array,
    hp: Float64Array,
    maxHp: Float64Array,
    spendEnergy: Float64Array,
    spendMetal: Float64Array,
    caps: Float64Array,
    count: number,
    healCostPerHp: number,
    outBuildProgress: Float64Array,
    outEnergyRateFraction: Float64Array,
    outMetalRateFraction: Float64Array,
    outChangedMask: Uint8Array,
  ) => number;
  readonly constructionReconcileAndGrowPieces: (
    totalPaidEnergy: number,
    totalPaidMetal: number,
    requiredEnergy: Float64Array,
    requiredMetal: Float64Array,
    maxHp: Float64Array,
    currentHp: Float64Array,
    previousProgress: Float64Array,
    startsAtFrameOne: Uint8Array,
    alive: Uint8Array,
    count: number,
    outPaidEnergy: Float64Array,
    outPaidMetal: Float64Array,
    outComplete: Uint8Array,
    outActive: Uint8Array,
    outHp: Float64Array,
    outProgress: Float64Array,
  ) => number;
  readonly economyApplyIncomeCredits: (
    playerIds: Uint32Array,
    resourceCodes: Uint32Array,
    ratesPerSec: Float64Array,
    count: number,
    dtSec: number,
    energyCurrByPlayer: Float64Array,
    energyMaxByPlayer: Float64Array,
    metalCurrByPlayer: Float64Array,
    metalMaxByPlayer: Float64Array,
    outAccepted: Float64Array,
  ) => number;
  readonly economyApplyConverterTransfers: (
    playerIds: Uint32Array,
    ratesPerSec: Float64Array,
    count: number,
    dtSec: number,
    tax: number,
    energyCurrByPlayer: Float64Array,
    energyMaxByPlayer: Float64Array,
    metalCurrByPlayer: Float64Array,
    metalMaxByPlayer: Float64Array,
    ratesByPlayer: Float64Array,
    consumedByPlayer: Float64Array,
    outputByPlayer: Float64Array,
    consumedResourceByPlayer: Uint32Array,
    outputResourceByPlayer: Uint32Array,
    outConsumed: Float64Array,
    outOutput: Float64Array,
    outConsumedResource: Uint32Array,
    outOutputResource: Uint32Array,
  ) => number;
  readonly arrivalCompletionStepBatch: (
    slots: Uint32Array,
    dx: Float64Array,
    dy: Float64Array,
    fallbackVelocityX: Float64Array,
    fallbackVelocityY: Float64Array,
    flags: Uint8Array,
    outDistance: Float64Array,
    outArrived: Uint8Array,
    arrivalRadius: number,
    finalRadius: number,
    finalStopSpeed: number,
  ) => number;
  readonly flyingLoiterStepBatch: (
    slots: Uint32Array,
    dx: Float64Array,
    dy: Float64Array,
    distance: Float64Array,
    rotation: Float64Array,
    radiusCollision: Float64Array,
    existingTurnSign: Float64Array,
    fallbackVelocityX: Float64Array,
    fallbackVelocityY: Float64Array,
    outThrustX: Float64Array,
    outThrustY: Float64Array,
    outTurnSign: Float64Array,
    outActive: Uint8Array,
    minRadius: number,
    radiusMult: number,
    radialGain: number,
  ) => number;
  readonly stuckReplanStepBatch: (
    slots: Uint32Array,
    currentStuckTicks: Int32Array,
    settlingDx: Float64Array,
    settlingDy: Float64Array,
    settlingFlags: Uint8Array,
    outStuckTicks: Int32Array,
    outShouldReplan: Uint8Array,
    stuckVelocityThreshold: number,
    stuckTickThreshold: number,
    arrivalRadius: number,
  ) => number;
  readonly turretRotationStepBatch: (
    currentYaw: Float64Array,
    yawVelocity: Float64Array,
    targetYaw: Float64Array,
    currentPitch: Float64Array,
    pitchVelocity: Float64Array,
    targetPitch: Float64Array,
    turnAccel: Float64Array,
    drag: Float64Array,
    outYaw: Float64Array,
    outYawVelocity: Float64Array,
    outYawAcceleration: Float64Array,
    outPitch: Float64Array,
    outPitchVelocity: Float64Array,
    outPitchAcceleration: Float64Array,
    outAimErrorYaw: Float64Array,
    outAimErrorPitch: Float64Array,
    count: number,
    dtSec: number,
    pitchMin: number,
    pitchMax: number,
  ) => number;
  /** Shared single-body unit integrator (Phase 2). Kept for
   *  diagnostics and one-off callers; the server hot path uses
   *  poolStepIntegrate and the client prediction hot path uses
   *  clientPredictUnitMotionBatch.
   *
   *  `motion` is a Float64Array of length 6: [x, y, z, vx, vy, vz]
   *  read AND written in place. Caller pre-samples ground state
   *  (groundZ, normal[X/Y/Z]) so the kernel never re-enters JS
   *  during a step. The normal is only consulted when penetration
   *  is in contact, so passing zero/up for the normal is safe
   *  when the caller knows the body is airborne. */
  readonly stepUnitMotion: (
    motion: Float64Array,
    dtSec: number,
    groundOffset: number,
    ax: number,
    ay: number,
    az: number,
    airDamp: number,
    groundDamp: number,
    launchAx: number,
    launchAy: number,
    launchAz: number,
    groundZ: number,
    normalX: number,
    normalY: number,
    normalZ: number,
  ) => void;
  /** Client visual-prediction unit-motion batch. Runs the same
   *  velocity-only motion contract that ClientUnitPrediction used to
   *  execute one body at a time: zero authored acceleration, no
   *  launch impulse, and the client-side rest snap before integration.
   *  JS still samples terrain because terrain baking has not moved to
   *  WASM yet, but all predicted units cross the boundary in one call
   *  for target extrapolation and one call for rendered entity motion. */
  readonly clientPredictUnitMotionBatch: (
    count: number,
    motions: Float64Array,
    groundOffsets: Float64Array,
    groundZ: Float64Array,
    groundNormals: Float64Array,
    dtSec: number,
    airDamp: number,
    groundDamp: number,
    restPenetrationEpsilon: number,
    restSpeedSq: number,
  ) => void;
  /** Body3D SoA pool — Phase 3d. Linear-memory-backed storage
   *  for every numeric body field. Slots are stable for a body's
   *  lifetime; `allocSlot()` returns the next free slot, `freeSlot`
   *  returns it. The view properties expose Float64Array /
   *  Uint8Array views over the pool's underlying storage so JS
   *  can read/write any body's field in O(1) without crossing
   *  the WASM boundary per access. Pool is initialized
   *  automatically at WASM load (one-time call to pool_init). */
  readonly pool: BodyPoolViews;
  /** Pool-backed integrate kernel — Phase 3d-2. Runs the per-tick
   *  integrate loop over every awake dynamic sphere by SLOT INDEX,
   *  reading body state directly from the pool. The Float64Array
   *  for body state is no longer marshalled per call; only the
   *  slot index list, pre-sampled ground state (terrain sampler
   *  is still JS-side until Phase 8), and a sleep-transitions
   *  output buffer cross the boundary. Returns the count of
   *  bodies that just slept this call (slot ids are written into
   *  sleep_transitions_out[0..return_value]). */
  readonly poolStepIntegrate: (
    awakeSlots: Uint32Array,
    groundZ: Float64Array,
    groundNormals: Float64Array,
    sleepTransitionsOut: Uint32Array,
    dtSec: number,
    airDamp: number,
    groundDamp: number,
  ) => number;
  /** Pool-backed PhysicsEngine3D step prep. Rust clears per-step
   *  upward-contact flags, applies map-boundary acceleration, wakes
   *  boundary-pushed sleepers, and emits both awake slot ids and
   *  pre-step sync entity ids. statsOut = [awakeCount, wakeCount,
   *  syncCount]. */
  readonly poolPrepareDynamicStep: (
    dynamicSlots: Uint32Array,
    awakeSlotsOut: Uint32Array,
    syncEntityIdsOut: Int32Array,
    statsOut: Uint32Array,
    mapWidth: number,
    mapHeight: number,
    boundarySpringAccel: number,
    boundaryDampingAccelPerSpeed: number,
  ) => number;
  /** Collect awake unit EntityIds from BodyPool flags without a JS
   *  dynamic-body scan. */
  readonly poolCollectAwakeEntityIds: (
    dynamicSlots: Uint32Array,
    entityIdsOut: Int32Array,
  ) => number;
  /** Final per-step sync collection and accumulator clear over packed
   *  BodyPool slots. */
  readonly poolFinalizeDynamicStep: (
    dynamicSlots: Uint32Array,
    syncEntityIdsOut: Int32Array,
  ) => number;
  /** Pool-backed sphere-sphere resolver — Phase 3d-2. Iterates
   *  the broadphase + N sub-passes over body slots. State read /
   *  written via the pool; only the slot list, scalar params,
   *  and a wake-transitions output buffer cross the boundary.
   *  Upward-contact flag is set on the pool flags byte directly.
   *  Returns the count of bodies that need wake bookkeeping
   *  (slot ids are written into wake_transitions_out[0..return_value]). */
  readonly poolResolveSphereSphere: (
    sphereSlots: Uint32Array,
    iterations: number,
    cellSize: number,
    wakeTransitionsOut: Uint32Array,
  ) => number;
  /** Phase 3f — per-engine static-cuboid broadphase. Each
   *  PhysicsEngine3D constructs its own handle at startup so the
   *  foreground game and the LobbyManager background battle's
   *  static cells stay isolated even though they share the global
   *  BodyPool. */
  readonly engineStaticsCreate: () => number;
  /** Release a handle previously returned by `engineStaticsCreate`.
   *  Drops the per-engine cell HashMap + visit-stamp vec so the
   *  memory comes back to Rust's allocator, and returns the slot
   *  to a free list for the next create() to recycle. Call from
   *  PhysicsEngine3D teardown (GameServer.stop -> dispose).
   *  Using the handle afterwards panics — the caller must drop
   *  every reference to it before destroy is invoked. */
  readonly engineStaticsDestroy: (handle: number) => void;
  /** Insert a cuboid (by pool slot) into this engine's static
   *  broadphase. Reads pos + half-extents from the pool, walks
   *  every overlapping cell, and pushes the slot id onto each
   *  cell's bucket. Idempotent only in the sense that a removed
   *  slot can be re-added — calling add twice for the same slot
   *  WILL produce duplicates in the cell buckets. */
  readonly engineStaticsAdd: (handle: number, slot: number, cellSize: number) => void;
  /** Remove a cuboid from this engine's static broadphase, using
   *  the same pos + half-extent walk as `engineStaticsAdd`. The
   *  caller must invoke this BEFORE freeing the pool slot or
   *  changing the cuboid's geometry, otherwise the broadphase
   *  state diverges from the pool. */
  readonly engineStaticsRemove: (handle: number, slot: number, cellSize: number) => void;
  /** Phase 3f unified sphere-vs-cuboid kernel. JS passes:
   *    - dynSlots: the dyn sphere slot ids to test (typically every
   *      `shouldProcessBodyThisStep` sphere this tick)
   *    - ignoredStaticSlots: parallel u32 array, value u32::MAX
   *      (= 0xFFFFFFFF) meaning "no ignore" for that dyn; otherwise
   *      the static slot id to skip (one-per-dyn ignore matches
   *      the JS Map<dyn,static> semantics from `setIgnoreStatic`).
   *    - cellSize: PhysicsEngine3D's CONTACT_CELL_SIZE.
   *    - wakeTransitionsOut: written with the slot ids of dyn
   *      bodies that resolved at least one pair (one entry per
   *      dyn that hit any cuboid).
   *  Returns the count of wake transitions written. */
  readonly poolResolveSphereCuboidFull: (
    handle: number,
    dynSlots: Uint32Array,
    ignoredStaticSlots: Uint32Array,
    cellSize: number,
    wakeTransitionsOut: Uint32Array,
  ) => number;
  /** TS-WASM-01A — batched arrival controller. TypeScript action
   *  orchestration packs one row per unit that wants waypoint thrust;
   *  the Rust kernel reads body velocity from the BodyPool and writes
   *  normalized/scaled thrust requests for UnitForceSystem to consume. */
  readonly arrivalControlStepBatch: (
    slots: Uint32Array,
    dx: Float64Array,
    dy: Float64Array,
    distance: Float64Array,
    radiusCollision: Float64Array,
    driveForce: Float64Array,
    traction: Float64Array,
    mass: Float64Array,
    flags: Uint8Array,
    outThrustX: Float64Array,
    outThrustY: Float64Array,
    outActive: Uint8Array,
    dtSec: number,
    thrustMultiplier: number,
    forceScale: number,
    unitMassMultiplier: number,
    controlRadiusMin: number,
    responseTimeSec: number,
    minAccel: number,
  ) => number;
  /** TS-WASM-01B2 — body-pool-backed per-unit ground-normal EMA.
   *  Rust walks occupied dynamic body slots, samples the installed
   *  terrain mesh, updates the WASM-owned normal SoA, and writes the
   *  EntityIds whose normal crossed the dirty threshold. */
  readonly unitGroundNormalStepPool: (
    dirtyEntityIdsOut: Uint32Array,
    alpha: number,
    dirtyEpsilon: number,
  ) => number;
  /** Phase 4 + 3e — batched hover orientation kernel. UnitForceSystem
   *  builds a per-tick scratch with one entry per hover entity:
   *  orientation (in/out), omega (in/out), target yaw/pitch/roll
   *  (in), then the kernel writes alpha (out) and the extracted yaw
   *  of the new orientation (out). Per entity stride =
   *  QUAT_HOVER_BATCH_STRIDE f64s. JS scatters back to
   *  entity.unit.orientation / .angularVelocity3 / .angularAcceleration3
   *  and entity.transform.rotation in a post-call pass. */
  readonly quatHoverOrientationStepBatch: (
    buf: Float64Array,
    count: number,
    k: number,
    c: number,
    dtSec: number,
  ) => void;
  /** Server authoritative unit-force batch. TypeScript gathers active
   *  unit rows, pre-sampled terrain/water data, and external force
   *  inputs; Rust computes drive/lift/brake/water-wall force outputs,
   *  writes BodyPool accelerations directly, and returns row flags for
   *  Unit/Entity scatter plus body wake bookkeeping. */
  readonly unitForceStepBatch: (
    slots: Uint32Array,
    flags: Uint32Array,
    rows: Float64Array,
    outFlags: Uint32Array,
    count: number,
    dtSec: number,
    thrustMultiplier: number,
    forceScale: number,
    hoverOrientationK: number,
    hoverOrientationC: number,
  ) => number;
  /** Phase 5a — Packed projectile SoA pool. Same lifetime / view
   *  semantics as `pool` (BodyPool): fixed capacity, views captured
   *  once, refresh on memory.grow via `refreshViews`. JS-side slot
   *  management (swap-remove on unregister) writes through these
   *  views directly; per-tick ballistic integrate runs in
   *  `poolStepPackedProjectilesBatch`. */
  readonly projectilePool: ProjectilePoolViews;
  /** WASM-PROJ-01/02 — nearest shield-panel / shield reflector
   *  hit for a batch of projectile sweeps. Reads the current reflector
   *  slabs; TypeScript only compacts inputs and consumes outputs. */
  readonly projectileReflectorIntersectionsBatch: (
    count: number,
    enabled: Uint8Array,
    startX: Float64Array,
    startY: Float64Array,
    startZ: Float64Array,
    endX: Float64Array,
    endY: Float64Array,
    endZ: Float64Array,
    projectileRadius: Float64Array,
    excludeEntityId: Int32Array,
    turretShieldPanelsEnabled: number,
    turretShieldSpheresEnabled: number,
    mirrorQueryPad: number,
    outKind: Uint8Array,
    outEntityId: Int32Array,
    outT: Float64Array,
    outX: Float64Array,
    outY: Float64Array,
    outZ: Float64Array,
    outNormalX: Float64Array,
    outNormalY: Float64Array,
    outNormalZ: Float64Array,
  ) => void;
  /** C1 — nearest swept hitbox contact for projectile bodies. Rust
   *  reads unit/building/projectile colliders from the spatial slab,
   *  includes current-tick turret sub-hitboxes from the combat-targeting
   *  slab, and writes one nearest hit per row. */
  readonly projectileHitboxSweepBatch: (
    count: number,
    enabled: Uint8Array,
    startX: Float64Array,
    startY: Float64Array,
    startZ: Float64Array,
    endX: Float64Array,
    endY: Float64Array,
    endZ: Float64Array,
    projectileRadius: Float64Array,
    excludeOffsets: Uint32Array,
    excludeCounts: Uint32Array,
    excludeEntityIds: Int32Array,
    removedProjectileEntityIds: Int32Array,
    maxTargetableRadius: number,
    queryExtra: number,
    currentTick: number,
    outKind: Uint8Array,
    outSlot: Uint32Array,
    outEntityId: Int32Array,
    outT: Float64Array,
    outNormalX: Float64Array,
    outNormalY: Float64Array,
    outNormalZ: Float64Array,
  ) => number;
  /** Per-tick ballistic integrator for slots 0..count of the
   *  projectile pool. Applies gravity with exact constant-acceleration
   *  position integration.
   *  Same math as the inner loop in
   *  projectileSystem._updatePackedProjectilesJS but runs entirely
   *  in WASM with no per-projectile boundary call. */
  readonly poolStepPackedProjectilesBatch: (count: number, dtSec: number) => void;
  /** C1 — non-packed projectile/body constant-acceleration integrator.
   *  TypeScript packs guided/D-gun projectile state and acceleration,
   *  this kernel advances position and velocity in one batch. */
  readonly projectileIntegrateStepBatch: (
    count: number,
    posX: Float64Array,
    posY: Float64Array,
    posZ: Float64Array,
    velX: Float64Array,
    velY: Float64Array,
    velZ: Float64Array,
    accelX: Float64Array,
    accelY: Float64Array,
    accelZ: Float64Array,
    dtSec: number,
  ) => number;
  /** C1 — batched server homing guidance for non-packed projectiles.
   *  Each row contains current projectile kinematics, target kinematics,
   *  gravity/thrust config, and an optional intercept-solve flag. Rust
   *  writes thrust acceleration outputs into the same row. */
  readonly projectileHomingGuidanceBatch: (
    rows: Float64Array,
    count: number,
    dtSec: number,
  ) => number;
  /** C1 — terrain-follow vertical thrust acceleration for D-gun waves
   *  and matching client prediction. Gravity remains caller-owned. */
  readonly terrainFollowVerticalThrustAccel: (
    positionZ: number,
    velocityZ: number,
    targetZ: number,
    mass: number,
    gravity: number,
    springAccelPerWorldUnit: number,
    dampingRatio: number,
    maxThrustForce: number,
  ) => number;
  /** Phase 5b — kinematic intercept solver. Per-call (not batched —
   *  call sites are scattered across server/client/render code).
   *
   *  `input` is a Float64Array of 22 elements:
   *    0..3   origin.position             (x, y, z)
   *    3..6   origin.velocity
   *    6..9   origin.acceleration
   *    9..12  target.position
   *    12..15 target.velocity
   *    15..18 target.acceleration
   *    18..21 projectile_acceleration
   *    21     projectile_speed
   *  The public TypeScript targeting API derives projectile_acceleration
   *  from the required gravity parameter as (0, 0, -gravity); callers do
   *  not pass air resistance or entity ids into the calculation.
   *  `out` is a Float64Array of 7 elements:
   *    0      time
   *    1..4   aim_point
   *    4..7   launch_velocity
   *  `preferLateSolution` is 1 to keep scanning past the first root,
   *  0 to take the earliest. `maxTimeSecOrZero` overrides the auto
   *  search horizon when nonzero (clamped to [1/120, 30]).
   *  Returns 1 if a solution was written, 0 otherwise. */
  readonly solveKinematicIntercept: (
    input: Float64Array,
    out: Float64Array,
    preferLateSolution: number,
    maxTimeSecOrZero: number,
  ) => number;
  /** AIM-05 — homing thrust acceleration. Per-call (call sites loop
   *  per-projectile already). Writes (thrustX, thrustY, thrustZ) into
   *  out[0..3]. Caller integrates `thrust + (0, 0, -gravity)` into
   *  position and velocity; the kernel never opts out of gravity, it
   *  just decides how much engine thrust to spend cancelling it. */
  readonly computeHomingThrust: (
    out: Float64Array,
    velX: number, velY: number, velZ: number,
    targetX: number, targetY: number, targetZ: number,
    currentX: number, currentY: number, currentZ: number,
    homingTurnRate: number,
    maxThrustAccel: number,
    gravity: number,
    dtSec: number,
  ) => void;
  /** Phase 6a — damped-spring single-axis rotation integrator. Per-
   *  call (call sites already loop per-turret-axis). `flags` packs
   *  the options object: bit 0 = wrap, bit 1 = has_min, bit 2 = has_max.
   *  Writes (newAngle, newAngularVel, angularAcc) into out[0..3]. */
  readonly integrateDampedRotation: (
    out: Float64Array,
    angle: number,
    angularVel: number,
    targetAngle: number,
    k: number,
    c: number,
    dtSec: number,
    flags: number,
    minAngle: number,
    maxAngle: number,
  ) => void;
  /** C16 — deterministic metal-deposit placement and connected
   *  resource footprint. TS owns config validation and object
   *  assembly; Rust owns oval/ring layout, snapped grid placement,
   *  explicit-height derivation, null-height terrain anchoring,
   *  candidate counting, and seeded frontier growth. */
  readonly metalDepositCountPlacements: (playerCount: number, rings: Float64Array) => number;
  readonly metalDepositGeneratePlacements: (
    mapWidth: number,
    mapHeight: number,
    playerCount: number,
    extentFraction: number,
    edgeMarginPx: number,
    buildGridCellSize: number,
    metalDepositStep: number,
    resourceCells: number,
    resourceRadiusCells: number,
    rings: Float64Array,
    outPlacements: Float64Array,
  ) => number;
  readonly metalDepositResolveTerrainHeights: (
    mapWidth: number,
    mapHeight: number,
    extentFraction: number,
    terrainConfig: Float64Array,
    explicitFlatZones: Float64Array,
    heightInputs: Float64Array,
    outHeights: Float64Array,
  ) => number;
  readonly metalDepositCountResourceCandidates: (radiusCells: number) => number;
  readonly metalDepositGrowResourceCells: (
    originGx: number,
    originGy: number,
    targetCellCount: number,
    radiusCells: number,
    seed: number,
    outCells: Int32Array,
  ) => number;
  /** Phase 8 — terrain heightmap installed in WASM linear memory.
   *  Called once at world-load (or any time setAuthoritativeTerrainTileMap
   *  receives a new map) from the JS-side terrain state. Arrays are
   *  copied into Rust-side Vecs; further mutation on the JS side has
   *  no effect on the installed mesh. */
  readonly terrainInstallMesh: (
    vertexCoords: Float64Array,
    vertexHeights: Float64Array,
    triangleIndices: Int32Array,
    triangleLevels: Int32Array,
    neighborIndices: Int32Array,
    neighborLevels: Int32Array,
    cellTriangleOffsets: Int32Array,
    cellTriangleIndices: Int32Array,
    mapWidth: number,
    mapHeight: number,
    cellSize: number,
    subdiv: number,
    cellsX: number,
    cellsY: number,
  ) => void;
  /** Drop the installed mesh — Vecs come back to Rust's allocator
   *  and `terrainIsInstalled` returns 0. Sampling falls back to the
   *  TS path until the next install. */
  readonly terrainClear: () => void;
  /** 1 if a mesh is currently installed, 0 otherwise. */
  readonly terrainIsInstalled: () => number;
  /** C16 — first pass for terrain mesh cell->triangle index baking.
   *  Fills prefix offsets and returns the required flat ref count,
   *  or -1 when TS should keep the compatibility path. */
  readonly terrainCountCellTriangleRefs: (
    cellsX: number,
    cellsY: number,
    cellSize: number,
    vertexCoords: Float64Array,
    triangleIndices: Int32Array,
    cellTriangleOffsetsOut: Int32Array,
  ) => number;
  /** C16 — second pass for terrain mesh cell->triangle index baking. */
  readonly terrainFillCellTriangleIndices: (
    cellsX: number,
    cellsY: number,
    cellSize: number,
    vertexCoords: Float64Array,
    triangleIndices: Int32Array,
    cellTriangleOffsets: Int32Array,
    cellTriangleIndicesOut: Int32Array,
  ) => number;
  /** C16 — full adaptive equilateral terrain mesh build. Rust owns the
   *  entire topology generation + crack-repair loop; TypeScript only
   *  assembles the config slice and splats the returned flat buffer into
   *  a TerrainTileMap. Returns `[status, vertexCount, triangleCount,
   *  cellOffsetsLen, cellRefsCount, ...sections]`; `[0]` on failure. */
  readonly terrainBuildAdaptiveMesh: (
    mapWidth: number,
    mapHeight: number,
    cellSize: number,
    cellsX: number,
    cellsY: number,
    maxSubdiv: number,
    extentFraction: number,
    terrainConfig: Float64Array,
    flatZones: Float64Array,
    lodConfig: Float64Array,
  ) => Float64Array;
  /** Sample terrain surface height at world-space (x, z). Returns
   *  NaN if no mesh is installed or the triangle walk degenerates;
   *  JS callers treat NaN as "fall back to TS sampler" since that
   *  handles the bilinear-quad-over-noise path. The mesh-installed
   *  return is max(WATER_LEVEL, triangle_height). */
  readonly terrainGetSurfaceHeight: (x: number, z: number) => number;
  /** Sample terrain surface normal at world-space (x, z). Writes
   *  (nx, ny, nz) into out[0..3] and returns 1 on success, 0 if no
   *  mesh is installed or the triangle walk fails. Below-water
   *  samples return (0, 0, 1) — flat water surface normal. */
  readonly terrainGetSurfaceNormal: (x: number, z: number, out: Float64Array) => number;
  /** Batch terrain ground sampling for pool-backed body slots.
   *  Writes groundZ[i] and groundNormals[i * 3..i * 3 + 3] for
   *  each awake body slot, using body positions from the WASM
   *  BodyPool. Normals are only computed for near-ground slots.
   *  Returns 1 on complete WASM sampling, 0 when JS should fall
   *  back to the compatibility terrain sampler. */
  readonly terrainSampleGroundForSlots: (
    bodySlots: Uint32Array,
    groundZ: Float64Array,
    groundNormals: Float64Array,
  ) => number;
  /** C16 — bake the static terrain-buildability grid from the
   *  installed authoritative terrain mesh. TypeScript supplies
   *  config scalars + flat-zone rows and assembles the public object. */
  readonly terrainBakeBuildabilityGrid: (
    mapWidth: number,
    mapHeight: number,
    buildCellSize: number,
    terrainDTerrain: number,
    shelfHeightTolerance: number,
    minNormalUp: number,
    flatZones: Float64Array,
    flagsOut: Uint8Array,
    levelsOut: Int32Array,
  ) => number;
  /** Phase 6c — segment-vs-terrain line-of-sight test. Returns:
   *    0 = ground blocks the ray
   *    1 = segment clears terrain end to end
   *    2 = no mesh installed → caller falls back to TS path
   *  Same step-walk algorithm as hasTerrainLineOfSight in
   *  terrainLineOfSight.ts. Replaces N JS↔WASM groundZ samples with a
   *  single WASM call (saves boundary cost on long LOS rays). */
  readonly terrainHasLineOfSight: (
    sx: number, sy: number, sz: number,
    tx: number, ty: number, tz: number,
    stepLen: number,
  ) => number;
  /** FOW-OPT-WASM — shared scanline circle fill for server shroud
   *  bitmaps and client reveal alpha maps. Returns 1 if any byte flipped
   *  0 -> 1. TypeScript keeps only orchestration/fallback. */
  readonly fogMarkCircleScanline: (
    bitmap: Uint8Array,
    gridW: number,
    gridH: number,
    cx: number,
    cy: number,
    radius: number,
    cellAnchor: number,
  ) => number;
  readonly fogMarkCircleScanlineRgba: (
    bitmap: Uint8Array,
    rgba: Uint8Array,
    gridW: number,
    gridH: number,
    cx: number,
    cy: number,
    radius: number,
    cellAnchor: number,
    rgbValue: number,
  ) => number;
  /** AIM-08.LOS — one-kernel combat sightline gate. Returns 1 when
   *  terrain plus live unit/building blockers all clear, 0 when any
   *  blocker intersects. Source/target entity ids are excluded so
   *  the ray may start/end inside their colliders. */
  readonly combatHasLineOfSight: (
    sx: number, sy: number, sz: number,
    tx: number, ty: number, tz: number,
    terrainStepLen: number,
    entityLineWidth: number,
    sourceEntityId: number,
    targetEntityId: number,
  ) => number;
  /** Phase 7 — SpatialGrid 3D voxel hash in WASM linear memory.
   *  Big-bang replacement for SpatialGrid.ts. Same public API on
   *  the JS wrapper; per-query traffic is one WASM call + one
   *  Uint32Array view over the scratch buffer. EntityId↔slot map
   *  is JS-side; Rust only sees u32 slot ids. */
  readonly spatial: SpatialApi;
  /** Phase 9 — Pathfinder A* over the build/walk grid. Mask + CC +
   *  A* + LOS smoothing all in one WASM call. */
  readonly pathfinder: PathfinderApi;
  /** Phase 10 D.1 — Entity-meta SoA pool. Foundation for future
   *  D.3 quantize/delta-encode kernel; JS-side population lands in
   *  D.3 when there's a consumer. */
  readonly entityMeta: EntityMetaApi;
  /** Phase 10 D.1b — Turret sub-pool. Per-entity turret arrays
   *  indexed at fixed offsets. JS-side population lands with D.3
   *  alongside the entity-meta capture pass. */
  readonly turretPool: TurretPoolApi;
  /** AIM-08.1 — Targeting input slabs, stamped from JS each tick.
   *  Source of truth for the scheduled Rust targeting kernels. JS
   *  still mirrors slab results back to Turret objects for downstream
   *  rendering/firing/snapshot consumers. */
  readonly combatTargeting: CombatTargetingApi;
  /** Materials Are Independent Of Shape — one pool holds every active
   *  shield surface, sphere and flat-panel alike, rebuilt each tick.
   *  Spheres come from getActiveShields(); flat panels are stamped
   *  through the per-unit + per-panel arrays. The clearance / projectile
   *  kernels read both shapes and apply the same material policy. */
  readonly shieldSurfacePool: ShieldSurfacePoolApi;
  /** Phase 10 D.3b — Per-recipient snapshot baseline registry.
   *  Foundation for the D.3c quantize + D.3d delta-encode kernels;
   *  no consumer reads from it yet. */
  readonly snapshotBaseline: SnapshotBaselineApi;
  /** Phase 10 D.3j — Entity-DTO encoder kernels. Each successive
   *  commit handles one more field group of the snapshot DTO; the
   *  ported portion is verified byte-equal against
   *  @msgpack/msgpack's `ignoreUndefined: true` output on every
   *  dev build. No consumer reads the bytes yet. */
  readonly snapshotEncode: SnapshotEncodeApi;
  /** The WASM linear memory — JS wrapper code constructs typed-array
   *  views over this for zero-copy result reads. Re-bind views after
   *  any operation that might grow the memory (rare). */
  readonly memory: WebAssembly.Memory;
}

/** Constants exposed alongside the SpatialGrid API. Mirrors the
 *  SPATIAL_KIND_* values in rts-sim-wasm/src/lib.rs. */
export const SPATIAL_KIND_UNSET = 0;
export const SPATIAL_KIND_UNIT = 1;
export const SPATIAL_KIND_BUILDING = 2;
export const SPATIAL_KIND_PROJECTILE = 3;

/** Public surface of the WASM-backed spatial grid. Each query returns
 *  a count; the result slot ids land in the shared scratch buffer
 *  accessed via `scratchPtr()` and `scratchLen()`. JS-side wrappers
 *  build a `Uint32Array(memory.buffer, scratchPtr(), count)` view
 *  per call. The view is invalidated by the NEXT call (the scratch
 *  Vec is re-written), so consume results synchronously. */
export interface SpatialApi {
  /** Initialize the grid. Must be called once before any other
   *  spatial.* method. Cell size matches the JS LAND_CELL_SIZE
   *  constant. `initialSlotCapacity` is a hint — pools grow on
   *  demand if exceeded. */
  init: (cellSize: number, initialSlotCapacity: number) => void;
  /** Drop all cells and slot kind tags. Slot storage is retained
   *  (free list reset). */
  clear: () => void;
  /** Allocate a new slot or pop one off the free list. Returns the
   *  slot id; the JS-side wrapper stores `Map<EntityId, slot>`. */
  allocSlot: () => number;
  /** Return a slot to the free list. Unsets bucket membership. */
  freeSlot: (slot: number) => void;
  /** Store the stable JS entity id for source/target exclusion in
   *  Rust-side blocker kernels that only see spatial slots. */
  setEntityId: (slot: number, entityId: number) => void;
  /** Insert or update a unit at slot. owner_player=0 means "no owner".
   *  hp_alive=0 unsets the slot from the grid (matches updateUnit's
   *  dead-unit fast path). radius_collision is currently unused by queries
   *  but kept in the per-slot SoA for future use. */
  setUnit: (
    slot: number,
    x: number, y: number, z: number,
    radiusCollision: number, radiusHitbox: number,
    ownerPlayer: number,
    hpAlive: number,
  ) => void;
  /** Insert or update a projectile at slot. isProjectileType=1 if
   *  proj.projectileType === 'projectile' (the only kind queries
   *  return via queryEnemyProjectilesInRadius). */
  setProjectile: (
    slot: number,
    x: number, y: number, z: number,
    ownerPlayer: number,
    isProjectileType: number,
    radiusCollision: number,
    radiusHitbox: number,
  ) => void;
  /** Batch insert/update projectile slots. All arrays must contain at
   *  least `count` rows; returns `count` when applied. */
  setProjectilesBatch: (
    count: number,
    slots: Uint32Array,
    xs: Float64Array,
    ys: Float64Array,
    zs: Float64Array,
    ownerPlayers: Uint8Array,
    projectileTypeFlags: Uint8Array,
    radiusCollision: Float64Array,
    radiusHitbox: Float64Array,
  ) => number;
  /** Insert / re-insert a building at slot. The grid buckets the
   *  building into every cell its (hx, hy, hz) half-extents touch. */
  setBuilding: (
    slot: number,
    x: number, y: number, z: number,
    hx: number, hy: number, hz: number,
    ownerPlayer: number,
    hpAlive: number,
    entityActive: number,
  ) => void;
  /** Drop the slot from any cell bucket it currently holds. Marks
   *  the slot kind as UNSET so future queries skip it. */
  unsetSlot: (slot: number) => void;

  // ---------- Queries (return slot-id counts) ----------

  /** Units in a 3D sphere. exclude_player=0 disables the filter. */
  queryUnitsInRadius: (
    x: number, y: number, z: number, r: number,
    excludePlayer: number,
    requireAlive: number,
  ) => number;
  /** Buildings whose AABB closest-point ≤ r from (x, y, z). */
  queryBuildingsInRadius: (
    x: number, y: number, z: number, r: number,
    excludePlayer: number,
    requireAlive: number,
  ) => number;
  /** Combined: writes [nUnits, nBuildings, unit_slots..., building_slots...]. */
  queryUnitsAndBuildingsInRadius: (
    x: number, y: number, z: number, r: number,
  ) => number;
  /** 2D rect query: [nUnits, nBuildings, unit_slots..., building_slots...]. */
  queryUnitsAndBuildingsInRect2D: (
    minX: number, maxX: number, minY: number, maxY: number,
  ) => number;
  /** Enemy units + buildings in a 3D sphere. shotRadius padding +
   *  hp>0 + AABB filter. Output: [nUnits, nBuildings, ...]. */
  queryEnemyEntitiesInRadius: (
    x: number, y: number, z: number, r: number,
    excludePlayer: number,
  ) => number;
  /** Enemy units + buildings in a 2D ground-plane circle. */
  queryEnemyEntitiesInCircle2D: (
    x: number, y: number, r: number,
    excludePlayer: number,
    zMin: number, zMax: number,
  ) => number;
  /** Units whose cell overlaps the line's swept AABB (line + lineWidth). */
  queryUnitsAlongLine: (
    sx: number, sy: number, sz: number,
    tx: number, ty: number, tz: number,
    lineWidth: number,
  ) => number;
  /** Buildings whose cell overlaps the line's swept AABB. */
  queryBuildingsAlongLine: (
    sx: number, sy: number, sz: number,
    tx: number, ty: number, tz: number,
    lineWidth: number,
  ) => number;
  /** Travelling projectiles whose cell overlaps the line's swept AABB. */
  queryProjectilesAlongLine: (
    sx: number, sy: number, sz: number,
    tx: number, ty: number, tz: number,
    lineWidth: number,
  ) => number;
  /** Combined: [nUnits, nBuildings, unit_slots..., building_slots...]. */
  queryEntitiesAlongLine: (
    sx: number, sy: number, sz: number,
    tx: number, ty: number, tz: number,
    lineWidth: number,
  ) => number;
  /** Enemy units in a 3D sphere (no shot-radius pad, no alive filter). */
  queryEnemyUnitsInRadius: (
    x: number, y: number, z: number, r: number,
    excludePlayer: number,
  ) => number;
  /** Enemy projectiles in a 3D sphere (only `proj.projectileType==='projectile'`). */
  queryEnemyProjectilesInRadius: (
    x: number, y: number, z: number, r: number,
    excludePlayer: number,
  ) => number;
  /** Combined: [nUnits, nProjectiles, unit_slots..., projectile_slots...]. */
  queryEnemyUnitsAndProjectilesInRadius: (
    x: number, y: number, z: number, r: number,
    excludePlayer: number,
  ) => number;
  /** Debug: per-cell unique-player listing. Output: [nCells, per
   *  cell: (cx: i32, cy: i32, cz: i32, nPlayers, p0, p1, ...)]. */
  queryOccupiedCellsDebug: () => number;

  // ---------- Scratch buffer access ----------

  /** Raw pointer to the start of the scratch_u32 Vec. Build a fresh
   *  Uint32Array(memory.buffer, ptr, count) view per query and
   *  consume immediately — the Vec relocates on growth. */
  scratchPtr: () => number;
  /** Current scratch buffer length (== last query's return value). */
  scratchLen: () => number;
  /** Read a slot's kind tag. Useful when consuming combined query
   *  results that intermix units / buildings / projectiles. */
  slotKind: (slot: number) => number;
}

/** Phase 10 D.1 — Entity-meta SoA pool. Per-entity scalar fields
 *  the snapshot serializer reads (HP, build state, combat mode,
 *  suspension, factory/solar booleans). Slot space is shared with
 *  SpatialGrid — JS calls `setUnit(slot, ...)` /
 *  `setBuilding(slot, ...)` once per dirty entity per snapshot
 *  tick. Position / velocity / orientation continue to live in
 *  BodyPool (Phase 3d). Variable-length arrays (turrets, actions)
 *  will land in a follow-up sub-pool. */
export interface EntityMetaApi {
  init: (initialCapacity: number) => void;
  clear: () => void;
  /** Register/refresh a runtime EntityId metadata row. Returns the
   *  row generation; (id,generation) is the stale-ref checked handle. */
  register: (
    id: number,
    kind: number,
    blueprintKind: number,
    blueprintCode: number,
    ownerPlayerId: number,
    teamId: number,
    parentId: number,
    rootHostId: number,
    mountIndex: number,
    storagePool: number,
    storageSlot: number,
    targetable: number,
  ) => number;
  unregister: (id: number) => void;
  unregisterRoot: (rootId: number) => void;
  resolveRow: (id: number, generation: number) => number;
  generation: (id: number) => number;
  resolveStorageSlot: (id: number, generation: number) => number;
  setUnit: (
    slot: number,
    playerId: number,
    hpCurr: number, hpMax: number,
    combatMode: number,
    isCommander: number,
    buildComplete: number,
    buildPaidEnergy: number, buildPaidMetal: number,
    buildTargetId: number,
    suspensionSpringOffset: number, suspensionSpringVelocity: number,
    buildProgress: number,
  ) => void;
  setBuilding: (
    slot: number,
    playerId: number,
    hpCurr: number, hpMax: number,
    factoryIsProducing: number, factoryBuildQueueLen: number, factoryProgress: number,
    solarOpen: number,
    buildProgress: number,
  ) => void;
  setTower: (
    slot: number,
    playerId: number,
    hpCurr: number, hpMax: number,
    factoryIsProducing: number, factoryBuildQueueLen: number, factoryProgress: number,
    solarOpen: number,
    buildProgress: number,
  ) => void;
  unset: (slot: number) => void;
  /** Returns 0 (unset) / 1 (unit) / 2 (building) / 3 (tower) for the slot. */
  type: (slot: number) => number;
  /** Current per-slot SoA capacity (auto-grows on set*). */
  capacity: () => number;
  /** Per-field raw pointers — JS builds typed-array views once and
   *  re-builds them if `memory.grow` ever detaches them. Same
   *  pattern as BodyPool / ProjectilePool. */
  readonly typePtr: () => number;
  readonly playerIdPtr: () => number;
  readonly hpCurrPtr: () => number;
  readonly hpMaxPtr: () => number;
  readonly combatModePtr: () => number;
  readonly isCommanderPtr: () => number;
  readonly buildCompletePtr: () => number;
  readonly buildPaidEnergyPtr: () => number;
  readonly buildPaidMetalPtr: () => number;
  readonly buildTargetIdPtr: () => number;
  readonly suspensionSpringOffsetPtr: () => number;
  readonly suspensionSpringVelocityPtr: () => number;
  readonly factoryIsProducingPtr: () => number;
  readonly factoryBuildQueueLenPtr: () => number;
  readonly factoryProgressPtr: () => number;
  readonly solarOpenPtr: () => number;
  readonly buildProgressPtr: () => number;
  readonly registryEntityIdPtr: () => number;
  readonly registryKindPtr: () => number;
  readonly registryBlueprintKindPtr: () => number;
  readonly registryBlueprintCodePtr: () => number;
  readonly registryOwnerPlayerIdPtr: () => number;
  readonly registryTeamIdPtr: () => number;
  readonly registryParentIdPtr: () => number;
  readonly registryRootHostIdPtr: () => number;
  readonly registryMountIndexPtr: () => number;
  readonly registryStoragePoolPtr: () => number;
  readonly registryStorageSlotPtr: () => number;
  readonly registryGenerationPtr: () => number;
  readonly registryAlivePtr: () => number;
  readonly registryTargetablePtr: () => number;
  readonly registryCapacity: () => number;
}

/** Entity-meta type tag values (mirrors lib.rs ENTITY_META_TYPE_*). */
export const ENTITY_META_TYPE_UNSET = 0;
export const ENTITY_META_TYPE_UNIT = 1;
export const ENTITY_META_TYPE_BUILDING = 2;
export const ENTITY_META_TYPE_TOWER = 3;
export const ENTITY_META_KIND_NONE = 0;
export const ENTITY_META_KIND_UNIT = 1;
export const ENTITY_META_KIND_TOWER = 2;
export const ENTITY_META_KIND_BUILDING = 3;
export const ENTITY_META_KIND_SHOT = 4;
export const ENTITY_META_KIND_TURRET = 5;
export const ENTITY_META_BLUEPRINT_KIND_NONE = 0;
export const ENTITY_META_BLUEPRINT_KIND_UNIT = 1;
export const ENTITY_META_BLUEPRINT_KIND_TOWER = 2;
export const ENTITY_META_BLUEPRINT_KIND_BUILDING = 3;
export const ENTITY_META_BLUEPRINT_KIND_TURRET = 4;
export const ENTITY_META_BLUEPRINT_KIND_SHOT = 5;
export const ENTITY_META_STORAGE_NONE = 0;
export const ENTITY_META_STORAGE_ENTITIES = 1;
export const ENTITY_META_STORAGE_COMBAT_TURRETS = 2;

/** Phase 10 D.1b — Turret sub-pool. Up to 8 turrets per entity at
 *  fixed offset `entity_slot * MAX + turret_idx` in a flat SoA.
 *  Per-entity count gates which indices are live. Used by the
 *  future D.3 quantize/delta-encode kernel when serializing the
 *  turrets array in a unit snapshot DTO. */
export interface TurretPoolApi {
  init: (initialEntityCapacity: number) => void;
  clear: () => void;
  /** Max turret count per entity (mirrors TURRET_POOL_MAX_PER_ENTITY = 8). */
  maxPerEntity: () => number;
  setCount: (entitySlot: number, count: number) => void;
  setTurret: (
    entitySlot: number,
    turretIdx: number,
    entityId: number,
    parentId: number,
    rootHostId: number,
    mountIndex: number,
    rotation: number,
    angularVelocity: number,
    angularAcceleration: number,
    pitch: number,
    pitchVelocity: number,
    pitchAcceleration: number,
    shieldRange: number,
    targetId: number,
  ) => void;
  unsetEntity: (entitySlot: number) => void;
  count: (entitySlot: number) => number;
  entityCapacity: () => number;
  readonly countPerEntityPtr: () => number;
  readonly entityIdPtr: () => number;
  readonly parentIdPtr: () => number;
  readonly rootHostIdPtr: () => number;
  readonly mountIndexPtr: () => number;
  readonly rotationPtr: () => number;
  readonly angularVelocityPtr: () => number;
  readonly angularAccelerationPtr: () => number;
  readonly pitchPtr: () => number;
  readonly pitchVelocityPtr: () => number;
  readonly pitchAccelerationPtr: () => number;
  readonly shieldRangePtr: () => number;
  readonly targetIdPtr: () => number;
}

/** AIM-08.1 — Entity-flag bits packed into the combat-targeting entity
 *  slab's `flags` field. Mirrors `CT_ENTITY_FLAG_*` in lib.rs. */
export const CT_ENTITY_FLAG_ALIVE = 1 << 0;
export const CT_ENTITY_FLAG_HAS_COMBAT = 1 << 1;
export const CT_ENTITY_FLAG_FIRE_ENABLED = 1 << 2;
export const CT_ENTITY_FLAG_BUILDABLE_COMPLETE = 1 << 3;

/** AIM-08.1 — Turret-config-flag bits packed into the combat-targeting
 *  turret slab's `configFlags` field. Mirrors `CT_TURRET_CFG_*`. */
export const CT_TURRET_CFG_REQUIRES_NON_OBSTRUCTED_LOS = 1 << 0;
export const CT_TURRET_CFG_NEEDS_BALLISTIC = 1 << 1;
export const CT_TURRET_CFG_VERTICAL_LAUNCHER = 1 << 2;
export const CT_TURRET_CFG_IS_MANUAL_FIRE = 1 << 3;
export const CT_TURRET_CFG_PASSIVE = 1 << 4;
export const CT_TURRET_CFG_VISUAL_ONLY = 1 << 5;
export const CT_TURRET_CFG_SHOT_IS_FORCE = 1 << 6;
export const CT_TURRET_CFG_HAS_TRACKING_RANGE = 1 << 7;
export const CT_TURRET_CFG_HOST_DIRECTED = 1 << 8;

/** AIM-08.1 — FSM state encodings. Single-sourced from wireEnums.json (the
 *  same file Rust generates its CT_TURRET_STATE_* constants from), so the
 *  TS sim-wasm bridge, the network wire codes, and the Rust kernels can't
 *  drift. */
export const CT_TURRET_STATE_IDLE = wireEnums.turretState.idle;
export const CT_TURRET_STATE_TRACKING = wireEnums.turretState.tracking;
export const CT_TURRET_STATE_ENGAGED = wireEnums.turretState.engaged;

/** C1 movement/combat halt modes. Single-sourced from wireEnums.json
 *  because the mode byte crosses the JS/WASM boundary. */
export const CT_COMBAT_HALT_MODE_ANY_ENGAGED = wireEnums.combatHaltMode.anyEngaged;
export const CT_COMBAT_HALT_MODE_FIGHT_RATIO = wireEnums.combatHaltMode.fightRatio;

/** LOCK-ON-03 — Per-turret lock-on exclusion masks compiled from each
 *  turret blueprint's authored exclusion arrays. Mirrors
 *  `CT_LOCK_ON_REL_INCLUDE_*` and `CT_LOCK_ON_FAM_INCLUDE_*` in Rust. */
export const CT_LOCK_ON_REL_INCLUDE_FRIENDLY = 1 << 0;
export const CT_LOCK_ON_REL_INCLUDE_ENEMY = 1 << 1;
export const CT_LOCK_ON_FAM_INCLUDE_BUILDINGS = 1 << 0;
export const CT_LOCK_ON_FAM_INCLUDE_UNITS = 1 << 1;
export const CT_LOCK_ON_FAM_INCLUDE_TURRETS = 1 << 2;
export const CT_LOCK_ON_FAM_INCLUDE_TOWERS = 1 << 3;
export const CT_LOCK_ON_FAM_INCLUDE_SHOTS = 1 << 5;

/** LOCK-ON-03 — Per-entity family encoding. Mirrors
 *  `CT_ENTITY_FAMILY_*` in Rust. NONE is the cleared/unstamped sentinel
 *  used after `clear()` so a stale row never matches a real family. */
export const CT_ENTITY_FAMILY_NONE = 0;
export const CT_ENTITY_FAMILY_BUILDING = 1;
export const CT_ENTITY_FAMILY_UNIT = 2;
export const CT_ENTITY_FAMILY_TOWER = 3;
export const CT_ENTITY_FAMILY_SHOT = 4;

/** LOCK-ON-03 — Sentinel for `entity_blueprint_code` when the family is
 *  NONE. Mirrors `CT_BLUEPRINT_CODE_NONE` in Rust. */
export const CT_BLUEPRINT_CODE_NONE = 0xff;

/** LOCK-ON-03 — Maximum blueprint count that can be addressed by the
 *  per-turret level-1 bitmask (one bit per blueprint code). Widening
 *  this requires upgrading the masks to u64 / multi-word arrays on
 *  both sides. */
export const CT_LOCK_ON_LEVEL1_MASK_CAPACITY = 32;

/** AIM-08.5 — `out_modes` byte the scheduler writes per queued entity.
 *  Mirrors `CT_TARGETING_TICK_MODE_*` in Rust. The writeback path uses
 *  these to dispatch JS-only bookkeeping (activity flags, priority
 *  command cleanup) after the slab is authoritative for the FSM. */
export const CT_TARGETING_TICK_MODE_AUTO = 0;
export const CT_TARGETING_TICK_MODE_PRIORITY_POINT = 1;
export const CT_TARGETING_TICK_MODE_PRIORITY_TARGET = 2;
export const CT_TARGETING_TICK_MODE_CLEAR_LOCKS = 3;
export const CT_TARGETING_TICK_MODE_SKIP = 255;

/** AIM-08.1 — Targeting input slabs. The JS stamping pass populates
 *  these once per tick before the scheduled Rust targeting batch
 *  runs; AIM-08.2..5 added the SoA kernels that read from them, and
 *  the slab is now authoritative for targeting FSM state.
 *  Ranges land pre-squared as authored radii. Targeting kernels apply
 *  them as vertical cylinders: horizontal radius R, top cap mount.z + R,
 *  no lower cap; `outermostAcquire` is the raw radius the broadphase
 *  spatial query wants. */
export interface CombatTargetingApi {
  init: (initialEntityCapacity: number) => void;
  clear: () => void;
  /** Mirrors `COMBAT_TARGETING_MAX_TURRETS_PER_ENTITY` (= 8). */
  maxTurretsPerEntity: () => number;
  entityCapacity: () => number;
  setEntity: (
    entitySlot: number,
    entityId: number,
    ownerPlayerId: number,
    viewMask: number,
    posX: number,
    posY: number,
    posZ: number,
    velX: number,
    velY: number,
    velZ: number,
    groundZ: number,
    rotCos: number,
    rotSin: number,
    surfaceNx: number,
    surfaceNy: number,
    surfaceNz: number,
    suspensionOffsetX: number,
    suspensionOffsetY: number,
    suspensionOffsetZ: number,
    radiusHitbox: number,
    aabbHalfX: number,
    aabbHalfY: number,
    aabbHalfZ: number,
    hp: number,
    flags: number,
    family: number,
    blueprintCode: number,
    lockOnRelationshipIncludeMask: number,
    lockOnEntityFamilyIncludeMask: number,
    lockOnBuildingIncludeMask: number,
    lockOnTowerIncludeMask: number,
    lockOnUnitIncludeMask: number,
    lockOnTurretIncludeMask: number,
    lockOnShotIncludeMask: number,
    fullVisionRadius: number,
    radarRadius: number,
    detectionPadding: number,
    priorityTargetId: number,
    priorityPointPresent: number,
    priorityPointX: number,
    priorityPointY: number,
    priorityPointZ: number,
    scheduledProbeTick: number,
    turretCount: number,
  ) => void;
  unsetEntity: (entitySlot: number) => void;
  /** Rebuilds targeting observability masks from stamped sight/radar
   *  sources. Must run after all entities are stamped and before any
   *  targeting scheduler tick. */
  rebuildObservationMasks: () => void;
  /** Same as rebuildObservationMasks, but walks only the stamped source
   *  slots supplied by JS. The caller must have cleared the targeting
   *  pool earlier in the tick. */
  rebuildObservationMasksForSources: (sourceSlots: Uint32Array) => void;
  /** Adds a temporary full-sight source, currently scan pulses. Full
   *  sight is included in radar-level coverage. */
  addSensorObservationCircle: (
    ownerPlayerId: number,
    x: number,
    y: number,
    radius: number,
  ) => void;
  setTurret: (
    entitySlot: number,
    turretIdx: number,
    turretEntityId: number,
    turretParentId: number,
    turretRootHostId: number,
    turretMountIndex: number,
    mountX: number,
    mountY: number,
    mountZ: number,
    radiusHitbox: number,
    mountVx: number,
    mountVy: number,
    mountVz: number,
    rotation: number,
    pitch: number,
    angularVelocity: number,
    pitchVelocity: number,
    state: number,
    targetId: number,
    cooldown: number,
    burstCooldown: number,
    fireMaxAcquireSq: number,
    fireMaxReleaseSq: number,
    fireMinAcquireSq: number,
    fireMinReleaseSq: number,
    trackingAcquireSq: number,
    trackingReleaseSq: number,
    outermostAcquire: number,
    mountOffset2d: number,
    localMountX: number,
    localMountY: number,
    localMountZ: number,
    worldPosTick: number,
    losBlockedTicks: number,
    configFlags: number,
    dps: number,
    projectileSpeed: number,
    arcPreference: number,
    maxTimeSec: number,
    groundAimFraction: number,
    underOnly: number,
    turretBlueprintCode: number,
    lockonRelationshipMask: number,
    lockonEntityFamilyMask: number,
    lockonBuildingMask: number,
    lockonTowerMask: number,
    lockonUnitMask: number,
    lockonTurretMask: number,
    lockonShotMask: number,
  ) => void;
  /** AIM-08.5 — Refresh the slab's per-entity active/firing turret
   *  masks for `entitySlot`. Reads slab FSM target/state + angular/
   *  pitch velocity + config flags inline; downstream readers
   *  (turretSystem, projectileSystem) consume the result via the
   *  entityActiveTurretMask / entityFiringTurretMask views. */
  refreshActivityMasksForEntity: (entitySlot: number) => void;
  /** AIM-08.5 — Batch activity-mask refresh. Same per-entity logic as
   *  refreshActivityMasksForEntity, walked over a Uint32Array of slot
   *  indices in one boundary call. */
  refreshActivityMasksBatch: (entitySlots: Uint32Array) => void;
  /** AIM-08.5 — Slab-side mid-tick turret state clear. JS calls this
   *  when the rotation pass discovers a ballistic-fail or other reason
   *  to drop a turret's lock, so the next activity-mask refresh sees
   *  the cleared state. Mirrors `weapon.state = 'idle'` plus
   *  `weapon.target = null` for the slab. */
  clearTurretFsm: (entitySlot: number, turretIdx: number) => void;
  entityFlags: (entitySlot: number) => number;
  turretCount: (entitySlot: number) => number;
  /** AIM-08.5 — Rust Pass 0 mount kinematics. Updates the slab's
   *  turret world mount position/velocity for one stamped entity. */
  updateMountKinematics: (
    entitySlot: number,
    currentTick: number,
    dtMs: number,
    turretShieldPanelsEnabled: number,
    turretShieldSpheresEnabled: number,
  ) => void;
  /** AIM-08.5 — batch Pass 0 mount kinematics over a world-order run
   *  of armed entities. Same slab mutation as updateMountKinematics,
   *  but with one boundary crossing for the run. */
  updateMountKinematicsBatch: (
    entitySlots: Uint32Array,
    currentTick: number,
    dtMs: number,
    turretShieldPanelsEnabled: number,
    turretShieldSpheresEnabled: number,
  ) => void;
  /** AIM-08.5 — slab-backed observability check. Returns 1 if
   *  `viewerPlayerId` can observe the entity addressed by `targetId`
   *  (alive + (own-team OR covered by the viewer's sight/radar)),
   *  0 otherwise. */
  canPlayerObserveEntity: (
    targetId: number,
    viewerPlayerId: number,
  ) => number;
  /** C1 — Rust-owned per-turret combat halt classifier for movement.
   *  Mode anyEngaged covers attack / attack-ground / guard; mode
   *  fightRatio covers fight / patrol with the per-unit halt ratio. */
  haltDecisionBatch: (
    entitySlots: Uint32Array,
    modes: Uint8Array,
    ratios: Float64Array,
    priorityPointPresent: Uint8Array,
    outShouldHalt: Uint8Array,
  ) => number;
  readonly entityIdPtr: () => number;
  readonly entityOwnerPlayerIdPtr: () => number;
  readonly entityPosXPtr: () => number;
  readonly entityPosYPtr: () => number;
  readonly entityPosZPtr: () => number;
  readonly entityVelXPtr: () => number;
  readonly entityVelYPtr: () => number;
  readonly entityVelZPtr: () => number;
  readonly entityRadiusHitboxPtr: () => number;
  readonly entityHpPtr: () => number;
  readonly entityFlagsPtr: () => number;
  readonly entityActiveTurretMaskPtr: () => number;
  readonly entityFiringTurretMaskPtr: () => number;
  readonly turretCountPerEntityPtr: () => number;
  readonly turretEntityIdPtr: () => number;
  readonly turretParentIdPtr: () => number;
  readonly turretRootHostIdPtr: () => number;
  readonly turretMountIndexPtr: () => number;
  readonly turretMountXPtr: () => number;
  readonly turretMountYPtr: () => number;
  readonly turretMountZPtr: () => number;
  readonly turretMountVxPtr: () => number;
  readonly turretMountVyPtr: () => number;
  readonly turretMountVzPtr: () => number;
  readonly turretWorldPosTickPtr: () => number;
  readonly turretRotationPtr: () => number;
  readonly turretPitchPtr: () => number;
  readonly turretAngularVelocityPtr: () => number;
  readonly turretPitchVelocityPtr: () => number;
  readonly turretStatePtr: () => number;
  readonly turretTargetIdPtr: () => number;
  readonly turretCooldownPtr: () => number;
  readonly turretBurstCooldownPtr: () => number;
  readonly turretFireMaxAcquireSqPtr: () => number;
  readonly turretFireMaxReleaseSqPtr: () => number;
  readonly turretFireMinAcquireSqPtr: () => number;
  readonly turretFireMinReleaseSqPtr: () => number;
  readonly turretTrackingAcquireSqPtr: () => number;
  readonly turretTrackingReleaseSqPtr: () => number;
  readonly turretOutermostAcquirePtr: () => number;
  readonly turretLosBlockedTicksPtr: () => number;
  readonly turretConfigFlagsPtr: () => number;
  readonly turretBallisticHasSolutionPtr: () => number;
  readonly turretBallisticFlightTimePtr: () => number;
  readonly turretBallisticLaunchVxPtr: () => number;
  readonly turretBallisticLaunchVyPtr: () => number;
  readonly turretBallisticLaunchVzPtr: () => number;
  readonly turretBallisticYawPtr: () => number;
  readonly turretBallisticPitchPtr: () => number;
  readonly turretBallisticAimXPtr: () => number;
  readonly turretBallisticAimYPtr: () => number;
  readonly turretBallisticAimZPtr: () => number;
  /** AIM-08.4 — solve ballistic turret aim by reading the turret
   *  mount kinematics from the combat-targeting slab at
   *  (entitySlot, turretIdx), then writing reusable outputs back to
   *  the same slab. `arcPreference`: 0 = low, 1 = high. Returns 1
   *  when a real solution was written, 0 when the fallback pose was
   *  written as a no-solution result. */
  readonly solveBallisticAim: (
    entitySlot: number,
    turretIdx: number,
    targetX: number,
    targetY: number,
    targetZ: number,
    targetVx: number,
    targetVy: number,
    targetVz: number,
    targetAx: number,
    targetAy: number,
    targetAz: number,
    originAx: number,
    originAy: number,
    originAz: number,
    projectileSpeed: number,
    gravity: number,
    arcPreference: number,
    maxTimeSecOrZero: number,
    fallbackYaw: number,
    fallbackPitch: number,
  ) => number;
  /** AIM-08.5 — Rust auto-targeting pre-scan. Writes
   *  cachedFireRanks[i], cachedFireDistSqs[i], and outF64[0..2] =
   *  [maxAcquireRange, maxWeaponOffset]. Returns 1 when any turret
   *  needs a batched enemy query. */
  readonly prepareAutoScan: (
    entitySlot: number,
    turretShieldPanelsEnabled: number,
    turretShieldSpheresEnabled: number,
    cachedFireRanks: Uint8Array,
    cachedFireDistSqs: Float64Array,
    outF64: Float64Array,
  ) => number;
  /** AIM-08.5 — Rust-owned candidate-pass gate prep. Return flags:
   *  bit 0 = at least one turret should scan candidates, bit 1 = at
   *  least one passive turret needs shield-panel candidate scores. */
  readonly prepareFireChoiceFsmInputs: (
    entitySlot: number,
    sourceEntityId: number,
    turretShieldPanelsEnabled: number,
    turretShieldSpheresEnabled: number,
    cachedFireRanks: Uint8Array,
    cachedFireDistSqs: Float64Array,
    applyMask: Uint8Array,
    seedRanks: Uint8Array,
    seedDistSqs: Float64Array,
    seedShieldPanelScores: Float64Array,
  ) => number;
  readonly prepareAcquisitionChoiceFsmInputs: (
    entitySlot: number,
    turretShieldPanelsEnabled: number,
    turretShieldSpheresEnabled: number,
    applyMask: Uint8Array,
    seedRanks: Uint8Array,
    seedDistSqs: Float64Array,
    seedShieldPanelScores: Float64Array,
  ) => number;
  /** AIM-08.3 — Rust target preference rank helper. `rankMode`: 0 =
   *  fire-only, 1 = acquisition; `edge`: 0 = acquire, 1 = release.
   *  `distSq` is horizontal distance squared; this compatibility helper
   *  assumes the target is inside the cylinder top cap. */
  readonly rankTarget: (
    rankMode: number,
    edge: number,
    fireMaxAcquire: number,
    fireMaxRelease: number,
    hasFireMin: number,
    fireMinAcquire: number,
    fireMinRelease: number,
    hasTracking: number,
    trackingAcquire: number,
    trackingRelease: number,
    distSq: number,
    targetRadius: number,
  ) => number;
  /** AIM-08.5 — Batch target candidate score/ranking kernel with
   *  internal fire-gate evaluation. Replaces the legacy callback-
   *  based version. Candidate aim points are resolved from the slab
   *  AABB; LOS / ballistic / FF / shield-panel gates all run in Rust
   *  via the shared `compute_turret_gates_for_aim_point` helper. */
  readonly computeAndChooseBestCandidatesBatch: (
    entitySlot: number,
    rankMode: number,
    minimumRank: number,
    applyMask: Uint8Array,
    seedRanks: Uint8Array,
    seedDistSqs: Float64Array,
    seedShieldPanelScores: Float64Array,
    candidateCount: number,
    candidateIds: Int32Array,
    candidatePosX: Float64Array,
    candidatePosY: Float64Array,
    candidatePosZ: Float64Array,
    candidateRadius: Float64Array,
    candidateShieldPanelScore: Float64Array,
    sourceEntityId: number,
    turretShieldPanelsEnabled: number,
    turretShieldSpheresEnabled: number,
    shieldObstructionActive: number,
    terrainStepLen: number,
    entityLineWidth: number,
    gravity: number,
    outTargetIds: Int32Array,
    outRanks: Uint8Array,
  ) => void;
  /** AIM-08.5 — Rust-owned targeting FSM transition writes. JS still
   *  supplies object-owned expensive gates during migration; these
   *  calls mutate the combat-targeting slab's target/state/LOS tuple. */
  readonly clearTurretLock: (entitySlot: number, turretIdx: number) => void;
  readonly clearEntityLocks: (entitySlot: number) => void;
  readonly applyPriorityPointFsmBatch: (
    entitySlot: number,
    targetX: number,
    targetY: number,
    targetZ: number,
    applyMask: Uint8Array,
    losClear: Uint8Array,
    ballisticClear: Uint8Array,
    shieldClear: Uint8Array,
  ) => void;
  /** AIM-08.5 — unified priority-point gate compute + FSM apply for one
   *  entity. Rust iterates the slab turrets, computes LOS / ballistic /
   *  shield / shield-panel gates (calling the existing kernels in-
   *  process), and applies the priority-point FSM transition in the
   *  same pass. Saves ~3 cross-boundary calls per weapon vs the legacy
   *  per-turret path.
   *
   *  Per-turret ballistic gate config is read from the targeting slab. */
  readonly computeAndApplyPriorityPointFsmBatch: (
    entitySlot: number,
    pointX: number,
    pointY: number,
    pointZ: number,
    sourceEntityId: number,
    turretShieldPanelsEnabled: number,
    turretShieldSpheresEnabled: number,
    shieldObstructionActive: number,
    terrainStepLen: number,
    entityLineWidth: number,
    gravity: number,
  ) => void;
  /** AIM-08.5 — unified attack-entity priority gate compute + FSM
   *  apply. TS resolves compatibility-wrapper aim points; the scheduled
   *  Rust path resolves body/AABB/turret-family aim points from the slab and does LOS /
   *  ballistic / FF / shield-panel / FSM. Passive-mirror `mirror_valid`
   *  is computed in Rust by walking the target's turrets via the slab —
   *  no JS pre-pass needed. */
  readonly computeAndApplyPriorityTargetFsmBatch: (
    entitySlot: number,
    targetId: number,
    sourceEntityId: number,
    turretShieldPanelsEnabled: number,
    turretShieldSpheresEnabled: number,
    shieldObstructionActive: number,
    terrainStepLen: number,
    entityLineWidth: number,
    gravity: number,
    aimX: Float64Array,
    aimY: Float64Array,
    aimZ: Float64Array,
  ) => void;
  /** AIM-08.5 — unified existing-lock gate compute + FSM apply. Each
   *  turret's current target is read from the slab; TS supplies only
   *  the per-turret aim point. Rust computes observability +
   *  passive shield-panel_valid + shield-panel clearance + LOS / FF /
   *  ballistic from slab data and derives sight_blocked internally. */
  readonly computeAndApplyValidateExistingLockFsmBatch: (
    entitySlot: number,
    sourceEntityId: number,
    turretShieldPanelsEnabled: number,
    turretShieldSpheresEnabled: number,
    shieldObstructionActive: number,
    terrainStepLen: number,
    entityLineWidth: number,
    gravity: number,
    losDropGraceTicks: number,
    aimX: Float64Array,
    aimY: Float64Array,
    aimZ: Float64Array,
  ) => void;
  readonly applyPriorityTargetFsmBatch: (
    entitySlot: number,
    targetId: number,
    applyMask: Uint8Array,
    mirrorValid: Uint8Array,
    losClear: Uint8Array,
    ballisticClear: Uint8Array,
    shieldClear: Uint8Array,
  ) => void;
  readonly validateExistingLockFsmBatch: (
    entitySlot: number,
    applyMask: Uint8Array,
    targetObservable: Uint8Array,
    mirrorValid: Uint8Array,
    ballisticClear: Uint8Array,
    losBlocked: Uint8Array,
    losDropGraceTicks: number,
  ) => void;
  readonly applyFireChoiceFsmBatch: (
    entitySlot: number,
    applyMask: Uint8Array,
    targetIds: Int32Array,
  ) => void;
  readonly applyAcquisitionChoiceFsmBatch: (
    entitySlot: number,
    applyMask: Uint8Array,
    targetIds: Int32Array,
    ranks: Uint8Array,
  ) => void;
  /** AIM-08.5 — combined existing-lock validation + auto-scan tick.
   *  Replaces `computeAndApplyValidateExistingLockFsmBatch` →
   *  `prepareAutoScan` with one boundary call. Returns 1 when at
   *  least one turret still wants the spatial candidate scan, 0
   *  otherwise; `outF64[0..2]` receives `[maxAcquireRange,
   *  maxWeaponOffset]` and `cachedFireRanks` / `cachedFireDistSqs`
   *  are filled for the auto-mode candidate tick. */
  readonly existingLockAndAutoScanTick: (
    entitySlot: number,
    sourceEntityId: number,
    turretShieldPanelsEnabled: number,
    turretShieldSpheresEnabled: number,
    shieldObstructionActive: number,
    terrainStepLen: number,
    entityLineWidth: number,
    gravity: number,
    losDropGraceTicks: number,
    aimX: Float64Array,
    aimY: Float64Array,
    aimZ: Float64Array,
    cachedFireRanks: Uint8Array,
    cachedFireDistSqs: Float64Array,
    outF64: Float64Array,
  ) => number;
  /** AIM-08.5 — collapses the fire-choice + acquisition pair (six
   *  per-entity boundary calls in the legacy flow) into a single Rust
   *  tick. Scratch buffers for apply mask / seed ranks / choose-best
   *  outputs live on the kernel's stack; per-turret ballistic config
   *  is read from the targeting slab. */
  readonly autoModeCandidateTick: (
    entitySlot: number,
    sourceEntityId: number,
    turretShieldPanelsEnabled: number,
    turretShieldSpheresEnabled: number,
    shieldObstructionActive: number,
    terrainStepLen: number,
    entityLineWidth: number,
    gravity: number,
    cachedFireRanks: Uint8Array,
    cachedFireDistSqs: Float64Array,
    candidateCount: number,
    candidateIds: Int32Array,
    candidatePosX: Float64Array,
    candidatePosY: Float64Array,
    candidatePosZ: Float64Array,
    candidateRadius: Float64Array,
    candidateShieldPanelScore: Float64Array,
  ) => void;
  /** AIM-08.5 — auto-mode candidate tick with Rust-owned spatial
   *  broadphase. JS passes the auto-scan radius result and the kernel
   *  queries the WASM spatial grid, stamps candidate SoA from the
   *  combat slab, then runs autoModeCandidateTick internally. */
  readonly autoModeSpatialCandidateTick: (
    entitySlot: number,
    sourceEntityId: number,
    turretShieldPanelsEnabled: number,
    turretShieldSpheresEnabled: number,
    shieldObstructionActive: number,
    terrainStepLen: number,
    entityLineWidth: number,
    gravity: number,
    cachedFireRanks: Uint8Array,
    cachedFireDistSqs: Float64Array,
    needsSpatialQuery: number,
    maxAcquireRange: number,
    maxWeaponOffset: number,
    maxTargetableRadius: number,
  ) => void;
  /** AIM-08.5 — multi-entity auto-mode batch. Entity slots and source
   *  IDs are one row per queued entity; aim/cached arrays are flat
   *  entity-major rows of maxTurretsPerEntity entries. */
  readonly autoModeSpatialCandidateTickBatch: (
    entitySlots: Uint32Array,
    sourceEntityIds: Int32Array,
    turretShieldPanelsEnabled: number,
    turretShieldSpheresEnabled: number,
    shieldObstructionActive: number,
    terrainStepLen: number,
    entityLineWidth: number,
    gravity: number,
    losDropGraceTicks: number,
    aimX: Float64Array,
    aimY: Float64Array,
    aimZ: Float64Array,
    cachedFireRanks: Uint8Array,
    cachedFireDistSqs: Float64Array,
    maxTargetableRadius: number,
  ) => void;
  /** AIM-08.5 — mixed-mode world-order FSM batch. TS still prepares
   *  object-owned command/cooldown state; Rust resolves per-turret
   *  aim points and dispatches auto-mode, priority-point, and
   *  priority-target targeting work across the queued entities. */
  readonly tickBatch: (
    entitySlots: Uint32Array,
    sourceEntityIds: Int32Array,
    modes: Uint8Array,
    priorityTargetIds: Int32Array,
    priorityPointX: Float64Array,
    priorityPointY: Float64Array,
    priorityPointZ: Float64Array,
    turretShieldPanelsEnabled: number,
    turretShieldSpheresEnabled: number,
    shieldObstructionActive: number,
    terrainStepLen: number,
    entityLineWidth: number,
    gravity: number,
    losDropGraceTicks: number,
    cachedFireRanks: Uint8Array,
    cachedFireDistSqs: Float64Array,
    maxTargetableRadius: number,
  ) => void;
  /** AIM-08.5 — scheduled mixed-mode world-order targeting batch.
   *  Rust chooses skip / hold-fire clear / priority-point /
   *  priority-target / auto from slab-backed state after resolving
   *  source entity IDs to slab slots, reading per-entity priority +
   *  probe-tick inputs from the slab, updating mount kinematics for
   *  processed rows, refreshing activity masks inline, and writing
   *  compact mode / active-work outputs for the JS bookkeeping pass. */
  readonly scheduleAndTickBatch: (
    sourceEntityIds: Int32Array,
    currentTick: number,
    dtMs: number,
    turretShieldPanelsEnabled: number,
    turretShieldSpheresEnabled: number,
    shieldObstructionActive: number,
    terrainStepLen: number,
    entityLineWidth: number,
    gravity: number,
    losDropGraceTicks: number,
    cachedFireRanks: Uint8Array,
    cachedFireDistSqs: Float64Array,
    maxTargetableRadius: number,
    outHadCooldown: Uint8Array,
    outModes: Uint8Array,
    outHasActiveWork: Uint8Array,
  ) => void;
}

/** AIM-08.1 — Shield input slab. Compact list of `count` active
 *  fields, rebuilt from scratch each tick from the JS-side
 *  getActiveShields(). Owner entity id sentinels: -1 means the
 *  field is not tied to a stamped entity. */
/** Materials Are Independent Of Shape — one pool, one material, two shapes.
 *  Sphere surfaces live in the flat per-field arrays (`setField` /
 *  `setFieldCount`); flat-panel surfaces live in the per-unit + per-panel
 *  arrays (`setUnit` / `setPanel`). The clearance + projectile kernels read
 *  both groups and apply the same reflection / occlusion policy. */
export interface ShieldSurfacePoolApi {
  /** Reset all surfaces (sphere fields + panel units + panels). */
  clear: () => void;
  /** Number of sphere surfaces currently stamped. */
  count: () => number;
  /** ── Sphere shape ── */
  setFieldCount: (count: number) => void;
  setField: (
    idx: number,
    id: number,
    ownerEntityId: number,
    centerX: number,
    centerY: number,
    centerZ: number,
    radius: number,
    reflectionMode: number,
  ) => void;
  readonly idPtr: () => number;
  readonly ownerEntityIdPtr: () => number;
  readonly centerXPtr: () => number;
  readonly centerYPtr: () => number;
  readonly centerZPtr: () => number;
  readonly radiusPtr: () => number;
  /** ── Rect-panel shape ── per-mirror-unit pose + broad radius +
   *  slope-aware pivot + [panel_start, panel_count) range; per-panel
   *  arm-length, lateral offset, panel yaw offset, base/top Y in
   *  chassis-local space, and half-width. The Rust kernels walk these
   *  so TS no longer precomputes a per-(turret, candidate) mask. */
  setUnitCount: (count: number) => void;
  setPanelCount: (count: number) => void;
  setUnit: (
    idx: number,
    unitEntityId: number,
    unitX: number,
    unitY: number,
    unitZ: number,
    unitGroundZ: number,
    unitBroadRadius: number,
    shieldPanelYaw: number,
    shieldPanelPitch: number,
    pivotX: number,
    pivotY: number,
    pivotZ: number,
    panelStart: number,
    panelCount: number,
  ) => void;
  setPanel: (
    idx: number,
    armLength: number,
    offsetY: number,
    panelAngle: number,
    baseY: number,
    topY: number,
    halfWidth: number,
  ) => void;
  setPanelMaterialMode: (reflectionMode: number) => void;
  /** AIM-08.2 — direct-segment shield clearance. Returns 1 if the
   *  segment (sx,sy,sz)→(tx,ty,tz) crosses at most `maxCrossings` shield
   *  surface boundaries, 0 otherwise. `includeSpheres` / `includePanels`
   *  restrict the query to one shape (e.g. a passive panel turret skips
   *  panels so it can't block its own sightline class). Pass -1 as
   *  `excludeOwnerEntityId` to consider every surface. Endpoint grazes
   *  within SHIELD_GRAZE_EPS don't count. */
  readonly clearanceSegment: (
    sx: number, sy: number, sz: number,
    tx: number, ty: number, tz: number,
    excludeOwnerEntityId: number,
    maxCrossings: number,
    includeSpheres: number,
    includePanels: number,
  ) => number;
  /** AIM-08.2 — ballistic-arc shield clearance against sphere surfaces.
   *  Approximates the parabola `pos = launch + v·t − 0.5·g·ẑ·t²` from
   *  0..flightTime, with the same boundary-crossing rule as the segment
   *  kernel. Returns 1 if total crossings ≤ `maxCrossings`, 0 otherwise. */
  readonly clearanceArc: (
    launchX: number, launchY: number, launchZ: number,
    launchVx: number, launchVy: number, launchVz: number,
    flightTime: number,
    excludeOwnerEntityId: number,
    maxCrossings: number,
  ) => number;
}

/** Phase 10 D.3b — Per-recipient snapshot baseline registry. Each
 *  network listener registers once at session start via `create()`
 *  and is freed at session end via `destroy()`. The handle is the
 *  u32 index used by the (future) D.3c quantize + D.3d delta-encode
 *  kernels to look up that listener's last-shipped scalars. Storage
 *  is the parallel-SoA mirror of stateSerializerEntityDelta.ts's
 *  PrevEntityState — fields auto-grow as `ensureCapacity` is called
 *  with larger slot ids. */
export interface SnapshotBaselineApi {
  /** Allocate a baseline slot, returning its u32 handle. Reuses any
   *  freed handle from `destroy()` via the registry's free list. */
  create: () => number;
  /** Free a baseline by handle; the handle is recycled on next create. */
  destroy: (handle: number) => void;
  /** Mark every slot's `used` flag back to 0 without dropping
   *  capacity — used on session reset / keyframe forced re-emit. */
  clear: (handle: number) => void;
  /** Drop the baseline for one slot (entity removed / out of vision). */
  unsetSlot: (handle: number, slot: number) => void;
  /** Pre-grow the per-slot arrays to cover at least `slot`. Optional
   *  hint — kernels that write a slot auto-grow as needed. */
  ensureCapacity: (handle: number, slot: number) => void;
  /** How many baselines are currently live (created minus destroyed). */
  liveCount: () => number;
  /** D.3c — capture one unit slot's current state into the baseline.
   *  Pulls HP / build / suspension from the entity-meta pool and
   *  per-turret state from the turret pool; takes transform,
   *  velocity, normal, action hash, and turret engagement / target
   *  bits as parameters. Auto-grows. */
  captureUnitSlot: (
    handle: number,
    slot: number,
    tick: number,
    changedFields: number,
    x: number, y: number, z: number,
    rotation: number,
    velocityX: number, velocityY: number, velocityZ: number,
    normalX: number, normalY: number, normalZ: number,
    actionCount: number,
    actionHash: number,
    isEngagedBits: number,
    targetBits: number,
  ) => void;
  /** D.3c — capture one building slot's current state into the
   *  baseline. Pulls HP + factory/solar/build progress from the
   *  entity-meta pool and turret state from the turret pool (for
   *  defense-turret buildings); takes transform plus engagement /
   *  target bits as parameters. Auto-grows. Zeros velocity so a
   *  stray emit can't pick up stale unit data from a slot recycle. */
  captureBuildingSlot: (
    handle: number,
    slot: number,
    tick: number,
    changedFields: number,
    x: number, y: number, z: number,
    rotation: number,
    isEngagedBits: number,
    targetBits: number,
  ) => void;
  /** Per-slot used flag (0 = unset, 1 = baseline captured). */
  slotUsed: (handle: number, slot: number) => number;
  /** Tick at which a slot's baseline was last captured (0 if unset). */
  slotLastTick: (handle: number, slot: number) => number;
  /** D.3d — compute the ENTITY_CHANGED_* bitmask between the
   *  caller-supplied current scalars (plus the pool-resident hp /
   *  turret / build / factory / solar state) and this recipient's
   *  stored baseline. Returns 0 when the baseline is unset (caller
   *  should treat that case as "emit full DTO" — matches the
   *  isNew branch in serializer.ts). Threshold math mirrors
   *  stateSerializerEntityDelta.ts:getEntityDeltaChangedFields. */
  diffSlot: (
    handle: number,
    slot: number,
    kind: number,
    x: number, y: number, z: number,
    rotation: number,
    velocityX: number, velocityY: number, velocityZ: number,
    normalX: number, normalY: number, normalZ: number,
    actionCount: number,
    actionHash: number,
    isEngagedBits: number,
    targetBits: number,
    posThresholdWorldUnits: number,
    rotPosThresholdRadians: number,
    movementVelMagnitudeThresholdRatio: number,
    movementVelDirectionThresholdRadians: number,
    rotVelMagnitudeThresholdRatio: number,
    rotVelDirectionThresholdRadians: number,
    hasBuildable: number,
    hasCombat: number,
    hasFactory: number,
  ) => number;
}

/** Kind tags for SnapshotBaselineApi.diffSlot. Mirrors
 *  SNAPSHOT_DIFF_KIND_* in lib.rs. */
export const SNAPSHOT_DIFF_KIND_UNIT = 1;
export const SNAPSHOT_DIFF_KIND_BUILDING = 2;
export const SNAPSHOT_DIFF_KIND_TOWER = 3;

/** Phase 10 D.3j — entity-DTO encoder kernels. Byte-equal port of
 *  stateSerializerEntities.ts:serializeEntitySnapshot's output as
 *  encoded by @msgpack/msgpack with `ignoreUndefined: true`. The
 *  port lands one field group per commit; basic envelope here is
 *  the always-present `{id, type, pos, rotation, playerId}` plus
 *  the optional `changedFields` delta mask. Output lands in the
 *  shared D.2 MessagePack writer scratch; read via writerPtr/Len. */
export interface SnapshotEncodeApi {
  /** Encode the basic entity envelope into the D.2 scratch. Returns
   *  the byte count; caller reads via writerPtr() + writerLen(). */
  encodeEntityBasic: (
    id: number,
    typeTag: number,
    qposX: number, qposY: number, qposZ: number,
    qrot: number,
    playerId: number,
    hasChangedFields: number,
    changedFields: number,
  ) => number;
  /** Encode envelope + the unit sub-object. Numeric vector components
   *  are pre-quantized JS numbers (caller does qVel / qNormal).
   *  Optional static fields cover full keyframes; delta-only fields
   *  stay gated by their has* flags. */
  encodeEntityUnit: (
    id: number,
    typeTag: number,
    qposX: number, qposY: number, qposZ: number,
    qrot: number,
    playerId: number,
    hasChangedFields: number,
    changedFields: number,
    hpCurr: number,
    hpMax: number,
    qvelX: number, qvelY: number, qvelZ: number,
    hasUnitType: number,
    unitTypeCode: number,
    hasRadius: number,
    radiusVisual: number,
    radiusHitbox: number,
    radiusCollision: number,
    hasBodyCenterHeight: number,
    bodyCenterHeight: number,
    hasMass: number,
    mass: number,
    hasSurfaceNormal: number,
    qnormalX: number, qnormalY: number, qnormalZ: number,
    hasOrientation: number,
    qorientX: number, qorientY: number, qorientZ: number, qorientW: number,
    hasAngularVelocity3: number,
    qangvelX: number, qangvelY: number, qangvelZ: number,
    hasFireEnabled: number,
    hasIsCommander: number,
    hasBuildTargetId: number,
    buildTargetIdIsNull: number,
    buildTargetId: number,
    hasActions: number,
    actionCount: number,
    hasTurrets: number,
    turretCount: number,
    hasBuild: number,
    buildComplete: number,
    buildPaidEnergy: number,
    buildPaidMetal: number,
  ) => number;
  /** Raw pointer to the D.2 MessagePack writer scratch. Refreshed
   *  by every encoder call. */
  writerPtr: () => number;
  /** Bytes currently in the D.2 scratch (matches the last encoder
   *  call's return value). */
  writerLen: () => number;
  /** Clear the MessagePack writer scratch (length back to 0). */
  writerClear: () => void;
  /** Append an already MessagePack-encoded value to the writer. Used
   *  by the DP-02 parity flag as a temporary fallback for DTO shapes
   *  that are not fully ported to Rust yet. */
  appendRawValue: (bytes: Uint8Array) => number;
  /** Raw pointer to the turret scratch buffer. JS fills 10 f64 per
   *  turret (see lib.rs SNAPSHOT_ENCODE_TURRET_STRIDE layout)
   *  before calling encodeEntityUnit with hasTurrets=1. */
  turretScratchPtr: () => number;
  /** Pre-grow the turret scratch to fit `count` turrets (10 f64 each). */
  turretScratchEnsure: (count: number) => void;
  /** Stride per turret in the scratch buffer (f64 count). */
  readonly turretScratchStride: number;
  /** Encode a building entity DTO (envelope + building sub-object
   *  with numeric type / dim / hp / build / metalExtractionRate / solar /
   *  turrets). Turrets reuse the same scratch as unit turrets.
   *  Factory sub-object not yet supported. */
  encodeEntityBuilding: (
    id: number,
    qposX: number, qposY: number, qposZ: number,
    qrot: number,
    playerId: number,
    hasChangedFields: number,
    changedFields: number,
    hasType: number,
    typeCode: number,
    hasDim: number,
    dimX: number, dimY: number,
    hpCurr: number,
    hpMax: number,
    buildComplete: number,
    buildPaidEnergy: number,
    buildPaidMetal: number,
    hasMetalExtractionRate: number,
    metalExtractionRate: number,
    hasSolar: number,
    solarOpen: number,
    hasTurrets: number,
    turretCount: number,
    hasFactory: number,
    factorySelectedUnitCount: number,
    factoryProgress: number,
    factoryProducing: number,
    factoryEnergyRate: number,
    factoryMetalRate: number,
    factoryWaypointCount: number,
  ) => number;
  /** Raw pointer to the action scratch buffer. JS fills 16 f64 per
   *  action (see lib.rs SNAPSHOT_ENCODE_ACTION_STRIDE layout)
   *  before calling encodeEntityUnit with hasActions=1. */
  actionScratchPtr: () => number;
  /** Pre-grow the action scratch to fit `count` actions (16 f64 each). */
  actionScratchEnsure: (count: number) => void;
  /** Stride per action in the scratch buffer (f64 count). */
  readonly actionScratchStride: number;
  /** Raw pointer to the string-scratch UTF-8 byte buffer. JS writes
   *  the concatenated UTF-8 bytes of every string field here. */
  stringScratchBytesPtr: () => number;
  /** Raw pointer to the string-scratch offset/length table (Uint32Array).
   *  table[2i] is the byte offset, table[2i+1] is the byte length for
   *  string slot `i`. */
  stringScratchTablePtr: () => number;
  /** Pre-grow the byte buffer to hold at least `byteCount` bytes. */
  stringScratchEnsureBytes: (byteCount: number) => void;
  /** Pre-grow the offset/length table to fit `slotCount` strings. */
  stringScratchEnsureTable: (slotCount: number) => void;
  /** Raw pointer to the factory selected-unit scratch (Uint32Array with
   *  one unit type code when production is on). JS fills before
   *  encodeEntityBuilding with hasFactory=1; encoder reads
   *  factorySelectedUnitCount entries. */
  factorySelectedUnitScratchPtr: () => number;
  /** Pre-grow the factory selected-unit scratch to hold `count` codes. */
  factorySelectedUnitScratchEnsure: (count: number) => void;
  /** Raw pointer to the waypoint scratch (Float64Array, 5 f64
   *  per waypoint — see SNAPSHOT_ENCODE_WAYPOINT_STRIDE in lib.rs).
   *  type field is a string-scratch slot index. */
  waypointScratchPtr: () => number;
  /** Pre-grow the waypoint scratch to hold `count` waypoints. */
  waypointScratchEnsure: (count: number) => void;
  /** Stride per waypoint in the scratch buffer (f64 count). */
  readonly waypointScratchStride: number;
  /** Open the snapshot envelope: clear writer, emit map header with
   *  totalKeyCount (caller-tallied), then tick + entities array
   *  header. Per-entity encodeEntityUnit/encodeEntityBuilding calls
   *  follow, then emitMinimap/emitEconomy/emitProjectiles in pool
   *  order, then envelopeContinue closes the envelope. */
  envelopeBegin: (tick: number, entityCount: number, totalKeyCount: number) => void;
  /** Open the snapshot envelope for a pre-packed `entities` value.
   *  Caller must emit the entities key next with emitRawKeyValue. */
  envelopeBeginPackedEntities: (tick: number, totalKeyCount: number) => void;
  /** Append a top-level key and an already MessagePack-encoded value.
   *  Transitional DP-02 bridge for low-frequency fields such as
   *  debug grids while their dedicated Rust encoders are still pending. */
  emitRawKeyValue: (key: string, value: Uint8Array) => number;
  /** Emit the `entities` key + compact V6 `{v,m,t,e}` value (issue A5).
   *  Caller must first bulk-fill the V6 input scratches (kinds /
   *  rowIndices / basic / unit / building) + the shared turret / action /
   *  waypoint / factory selected-unit / string scratches from entityWireSource.
   *  `waypointStringBase` is the slot where waypoint-type strings begin in
   *  the (action ++ waypoint) ordered string scratch. Returns the writer
   *  length, or 0xFFFFFFFF if a RAW entity kind is present (caller falls
   *  back to the TS packer). */
  emitEntitiesV6: (entityCount: number, waypointStringBase: number) => number;
  v6KindsScratchPtr: () => number;
  v6KindsScratchEnsure: (count: number) => void;
  v6RowIndicesScratchPtr: () => number;
  v6RowIndicesScratchEnsure: (count: number) => void;
  v6BasicScratchPtr: () => number;
  v6BasicScratchEnsure: (rowCount: number) => void;
  readonly v6BasicScratchStride: number;
  v6UnitScratchPtr: () => number;
  v6UnitScratchEnsure: (rowCount: number) => void;
  readonly v6UnitScratchStride: number;
  v6BuildingScratchPtr: () => number;
  v6BuildingScratchEnsure: (rowCount: number) => void;
  readonly v6BuildingScratchStride: number;
  /** Emit `serverMeta: {...}` in ServerSnapshotMetaBuilder field
   *  order. String values must already be packed into string scratch;
   *  the `units.allowed` array uses contiguous string slots beginning
   *  at `unitsAllowedSlotStart`. */
  emitServerMeta: (
    ticksAvg: number,
    ticksLow: number,
    ticksRate: number,
    snapsRateIsString: number,
    snapsRate: number,
    snapsRateSlot: number,
    snapsKeyframesIsString: number,
    snapsKeyframes: number,
    snapsKeyframesSlot: number,
    serverTimeSlot: number,
    serverIpSlot: number,
    gridEnabled: number,
    hasUnitsAllowed: number,
    unitsAllowedSlotStart: number,
    unitsAllowedCount: number,
    hasUnitsMax: number,
    unitsMax: number,
    hasUnitsCount: number,
    unitsCount: number,
    hasMirrorsEnabled: number,
    turretShieldPanelsEnabled: number,
    hasShieldsEnabled: number,
    turretShieldSpheresEnabled: number,
    hasShieldsObstructSight: number,
    shieldsObstructSight: number,
    hasShieldReflectionMode: number,
    shieldReflectionModeSlot: number,
    hasFogOfWarEnabled: number,
    fogOfWarEnabled: number,
    cpuAvg: number,
    cpuHi: number,
    windX: number,
    windY: number,
    windSpeed: number,
    windAngle: number,
    unitGroundNormalEmaSlot: number,
  ) => number;
  /** Close the envelope. Emits gameState (if hasGameState), isDelta,
   *  removedEntityIds (if hasRemovedIds), visibilityFiltered (if
   *  hasVisibilityFiltered) in that order. Returns total bytes
   *  written. */
  envelopeContinue: (
    hasGameState: number,
    gameStatePhaseSlot: number,
    hasWinnerId: number,
    winnerId: number,
    isDelta: number,
    hasRemovedEntityIds: number,
    removedEntityIdCount: number,
    hasVisibilityFiltered: number,
    visibilityFiltered: number,
  ) => number;
  /** Emit `economy: { [playerId]: EconomyDTO }`. Caller pre-packs the
   *  economy scratch (16 f64 per player, ASC by playerId) and passes
   *  the player count. Pass 0 to emit an empty economy map. */
  emitEconomy: (playerCount: number) => number;
  /** Emit `minimapEntities: [...]`. Reads `count` entries from the
   *  minimap scratch (6 f64 per entry). */
  emitMinimap: (count: number) => void;
  /** Emit packed `minimapEntities: { v: 2, b }`. Reads `count`
   *  entries from the minimap scratch and writes the compact binary
   *  wire shape used by snapshotMinimapWirePack.ts. */
  emitPackedMinimap: (count: number) => number;
  /** Emit `projectiles: { spawns?, despawns?, velocityUpdates?,
   *  beamUpdates? }`. Reads spawn DTOs from projSpawnScratch (27 f64
   *  each), despawn ids from projDespawnScratch, velocity-update
   *  tuples from projVelScratch (7 f64 each), beam-update headers
   *  from beamUpdateScratch (4 f64 each, with point_count[3] driving
   *  the per-update slice of beamPointScratch (12 f64 each)). */
  emitProjectiles: (
    hasSpawns: number,
    spawnCount: number,
    hasDespawns: number,
    despawnCount: number,
    hasVelocityUpdates: number,
    velocityUpdateCount: number,
    hasBeamUpdates: number,
    beamUpdateCount: number,
  ) => void;
  /** Emit packed `projectiles: { v: 3, s?, d?, u?, b? }`. Reads the
   *  same projectile scratches as emitProjectiles, but writes the
   *  compact binary wire shape used by snapshotProjectileWirePack.ts. */
  emitPackedProjectiles: (
    hasSpawns: number,
    spawnCount: number,
    hasDespawns: number,
    despawnCount: number,
    hasVelocityUpdates: number,
    velocityUpdateCount: number,
    hasBeamUpdates: number,
    beamUpdateCount: number,
    beamPointCount: number,
  ) => number;
  /** Raw pointer to the minimap scratch (Float64Array, 6 f64 per
   *  entry: id, posX, posY, typeTag, playerId, radarPacked). */
  minimapScratchPtr: () => number;
  /** Pre-grow the minimap scratch to hold `count` entries. */
  minimapScratchEnsure: (count: number) => void;
  /** Stride per minimap entry (f64 count). */
  readonly minimapScratchStride: number;
  /** Emit `scanPulses: [...]`. Sits AFTER visibilityFiltered in
   *  pool-iteration order (lazy-added to _snapshotBuf). Reads
   *  `count` entries (6 f64 each) from the scan-pulse scratch. */
  emitScanPulses: (count: number) => number;
  /** Raw pointer to the scan-pulse scratch (Float64Array, 6 f64 per
   *  pulse: playerId, x, y, z, radius, expiresAtTick). */
  scanPulseScratchPtr: () => number;
  /** Pre-grow the scan-pulse scratch to hold `count` pulses. */
  scanPulseScratchEnsure: (count: number) => void;
  /** Stride per scan-pulse entry (f64 count). */
  readonly scanPulseScratchStride: number;
  /** Emit `shroud: { gridW, gridH, cellSize, bitmap }`. The bitmap
   *  bytes come from the shroud scratch (caller pre-fills `bytes`
   *  bytes); the wrapper map is emitted with the gridW/gridH/cellSize
   *  args. */
  emitShroud: (gridW: number, gridH: number, cellSize: number, bitmapBytes: number) => number;
  /** Raw pointer to the shroud-bitmap scratch (Uint8Array). */
  shroudScratchPtr: () => number;
  /** Pre-grow the shroud scratch to hold `byteCount` bytes. */
  shroudScratchEnsure: (byteCount: number) => void;
  /** Emit compact `terrain: {v,m,vc,vh,ti}` from raw TerrainTileMap
   *  arrays copied into number scratch. */
  emitPackedTerrain: (
    mapWidth: number,
    mapHeight: number,
    cellSize: number,
    subdiv: number,
    cellsX: number,
    cellsY: number,
    verticesX: number,
    verticesY: number,
    version: number,
    meshVertexCoordsOffset: number,
    meshVertexCoordsCount: number,
    meshVertexHeightsOffset: number,
    meshVertexHeightsCount: number,
    meshTriangleIndicesOffset: number,
    meshTriangleIndicesCount: number,
  ) => number;
  /** Emit full `terrain: TerrainTileMap`. Retained for byte-parity
   *  fixtures and raw DTO fallback diagnostics. */
  emitTerrain: (
    mapWidth: number,
    mapHeight: number,
    cellSize: number,
    subdiv: number,
    cellsX: number,
    cellsY: number,
    verticesX: number,
    verticesY: number,
    version: number,
    meshVertexCoordsOffset: number,
    meshVertexCoordsCount: number,
    meshVertexHeightsOffset: number,
    meshVertexHeightsCount: number,
    meshTriangleIndicesOffset: number,
    meshTriangleIndicesCount: number,
    meshTriangleLevelsOffset: number,
    meshTriangleLevelsCount: number,
    meshTriangleNeighborIndicesOffset: number,
    meshTriangleNeighborIndicesCount: number,
    meshTriangleNeighborLevelsOffset: number,
    meshTriangleNeighborLevelsCount: number,
    meshCellTriangleOffsetsOffset: number,
    meshCellTriangleOffsetsCount: number,
    meshCellTriangleIndicesOffset: number,
    meshCellTriangleIndicesCount: number,
  ) => number;
  /** Emit compact `buildability: {v,m,k,r}` from raw flags/levels
   *  copied into number scratch. */
  emitPackedBuildability: (
    mapWidth: number,
    mapHeight: number,
    cellSize: number,
    cellsX: number,
    cellsY: number,
    version: number,
    configKeySlot: number,
    flagsOffset: number,
    flagsCount: number,
    levelsOffset: number,
    levelsCount: number,
  ) => number;
  /** Emit full `buildability: TerrainBuildabilityGrid`. Retained for
   *  byte-parity fixtures and raw DTO fallback diagnostics. */
  emitBuildability: (
    mapWidth: number,
    mapHeight: number,
    cellSize: number,
    cellsX: number,
    cellsY: number,
    version: number,
    configKeySlot: number,
    flagsOffset: number,
    flagsCount: number,
    levelsOffset: number,
    levelsCount: number,
  ) => number;
  /** Shared Float64 scratch for top-level numeric arrays. */
  numberScratchPtr: () => number;
  /** Pre-grow the shared numeric scratch to hold `numberCount` f64s. */
  numberScratchEnsure: (numberCount: number) => void;
  /** Emit `sprayTargets: [...]`. Sits between economy and projectiles
   *  in iteration order. Reads `count` entries (17 f64 each) from the
   *  spray scratch. */
  emitSprayTargets: (count: number) => number;
  /** Raw pointer to the spray-target scratch (Float64Array, 17 f64
   *  per spray — see lib.rs SNAPSHOT_ENCODE_SPRAY_STRIDE for layout). */
  sprayScratchPtr: () => number;
  /** Pre-grow the spray scratch to hold `count` sprays. */
  sprayScratchEnsure: (count: number) => void;
  /** Stride per spray entry (f64 count). */
  readonly sprayScratchStride: number;
  /** Raw pointer to the economy scratch (Float64Array, 16 f64 per
   *  player — see lib.rs SNAPSHOT_ENCODE_ECONOMY_STRIDE for layout).
   *  Caller must sort entries ASCENDING by playerId. */
  economyScratchPtr: () => number;
  /** Pre-grow the economy scratch to hold `count` players. */
  economyScratchEnsure: (count: number) => void;
  /** Stride per economy entry (f64 count). */
  readonly economyScratchStride: number;
  /** Emit `audioEvents: [...]`. D.3j-26 covers everything except
   *  deathContext + impactContext (large nested objects deferred to
   *  later commits). Caller pre-packs strings into the shared string
   *  scratch and stores their slot indices in the audio scratch. */
  emitAudioEvents: (count: number) => number;
  /** Emit compact `audioEvents: {v,s,e,d?,i?,t?}` from pre-packed
   *  audio/death/impact/turret-pose scratches. */
  emitPackedAudioEvents: (
    count: number,
    stringCount: number,
    deathContextCount: number,
    impactContextCount: number,
    turretPoseCount: number,
  ) => number;
  /** Raw pointer to the audio-event scratch (Float64Array, 16 f64
   *  per event — see lib.rs SNAPSHOT_ENCODE_AUDIO_EVENT_STRIDE). */
  audioEventScratchPtr: () => number;
  /** Pre-grow the audio-event scratch to hold `count` events. */
  audioEventScratchEnsure: (count: number) => void;
  /** Stride per audio-event entry (f64 count). */
  readonly audioEventScratchStride: number;
  /** Raw pointer to the death-context scratch (16 f64 per
   *  deathContext, one per audio event with the has_deathContext
   *  flag set). Caller packs in audio-event order. */
  deathContextScratchPtr: () => number;
  /** Pre-grow the death-context scratch to hold `count` contexts. */
  deathContextScratchEnsure: (count: number) => void;
  /** Stride per death-context entry (f64 count). */
  readonly deathContextScratchStride: number;
  /** Raw pointer to the turret-pose scratch (2 f64 per pose: rotation,
   *  pitch — flat across all deathContexts in pack order). */
  turretPoseScratchPtr: () => number;
  /** Pre-grow the turret-pose scratch to hold `count` total poses. */
  turretPoseScratchEnsure: (count: number) => void;
  /** Stride per turret-pose entry (f64 count). */
  readonly turretPoseScratchStride: number;
  /** Raw pointer to the impact-context scratch (11 f64 per
   *  impactContext, one per audio event with the has_impactContext
   *  flag set). All fields required (no optionals). */
  impactContextScratchPtr: () => number;
  /** Pre-grow the impact-context scratch to hold `count` contexts. */
  impactContextScratchEnsure: (count: number) => void;
  /** Stride per impact-context entry (f64 count). */
  readonly impactContextScratchStride: number;
  /** Raw pointer to the beam-update header scratch (Float64Array,
   *  4 f64 per update: id, flags, obstructionT, point_count). */
  beamUpdateScratchPtr: () => number;
  /** Pre-grow the beam-update header scratch to hold `count` updates. */
  beamUpdateScratchEnsure: (count: number) => void;
  /** Stride per beam-update header (f64 count). */
  readonly beamUpdateScratchStride: number;
  /** Raw pointer to the beam-point scratch (Float64Array, 12 f64 per
   *  point — flat across all beam updates in pool order). */
  beamPointScratchPtr: () => number;
  /** Pre-grow the beam-point scratch to hold `count` total points. */
  beamPointScratchEnsure: (count: number) => void;
  /** Stride per beam-point (f64 count). */
  readonly beamPointScratchStride: number;
  /** Raw pointer to the projectile-despawn scratch (Uint32Array of
   *  ids). */
  projDespawnScratchPtr: () => number;
  /** Pre-grow the proj-despawn scratch to hold `count` ids. */
  projDespawnScratchEnsure: (count: number) => void;
  /** Raw pointer to the projectile-spawn scratch (Float64Array,
   *  SNAPSHOT_ENCODE_PROJ_SPAWN_STRIDE f64 per entry — see lib.rs
   *  layout comment for field offsets and the optional-presence
   *  bitmask at offset 26). */
  projSpawnScratchPtr: () => number;
  /** Pre-grow the proj-spawn scratch to hold `count` entries. */
  projSpawnScratchEnsure: (count: number) => void;
  /** Stride per proj-spawn entry (f64 count). */
  readonly projSpawnScratchStride: number;
  /** Raw pointer to the projectile-velocity-update scratch
   *  (Float64Array, 8 f64 per entry: id, pos.x/y/z, vel.x/y/z,
   *  clearHomingTarget flag). */
  projVelScratchPtr: () => number;
  /** Pre-grow the proj-vel scratch to hold `count` entries. */
  projVelScratchEnsure: (count: number) => void;
  /** Stride per proj-vel entry (f64 count). */
  readonly projVelScratchStride: number;
  /** Raw pointer to the removed-entity-ids scratch (Uint32Array). */
  removedIdsScratchPtr: () => number;
  /** Pre-grow the removed-ids scratch to hold `count` ids. */
  removedIdsScratchEnsure: (count: number) => void;
}

/** Entity-type tags for SnapshotEncodeApi.encodeEntityBasic. Mirrors
 *  SNAPSHOT_ENTITY_TYPE_* in lib.rs. */
export const SNAPSHOT_ENTITY_TYPE_UNIT = 1;
export const SNAPSHOT_ENTITY_TYPE_BUILDING = 2;
export const SNAPSHOT_ENTITY_TYPE_TOWER = 3;

/** Phase 9 — Pathfinder. Mirror of Pathfinder.ts findPath. Full
 *  pipeline (mask + CC + A* + LOS smoothing) runs inside a single
 *  WASM call. Caller passes the building-occupied cells list per
 *  rebuild; the Rust side caches mask + CC by version pair. */
export interface PathfinderApi {
  /** Allocate the per-cell SoA arrays for the given map dimensions.
   *  Idempotent if map size is unchanged. Recomputes cell counts as
   *  `ceil(mapW/20), ceil(mapH/20)`. */
  init: (mapWidth: number, mapHeight: number) => void;
  /** Rebuild blocked mask + CC labels from `buildingCells` (flat
   *  Uint32Array of interleaved gx, gy pairs). The terrain mask is
   *  cached by `terrainVersion`; full mask + CC by terrain/building
   *  versions plus the JS-side building-grid identity — no-op when
   *  nothing has changed. */
  rebuildMaskAndCc: (
    buildingCells: Uint32Array,
    terrainVersion: number,
    buildingVersion: number,
    buildingGridId: number,
  ) => void;
  /** Run findPath. Writes smoothed waypoints into the WASM-side
   *  scratch buffer as interleaved (x, y) f64 pairs; returns the
   *  waypoint COUNT (not the f64 element count). `ignoreTerrainBlocking`
   *  is used by airborne locomotion to ignore water/slope/terrain
   *  inflation while still respecting map bounds and buildings. */
  findPath: (
    startX: number, startY: number,
    goalX: number, goalY: number,
    minNormalZ: number,
    ignoreTerrainBlocking: boolean,
  ) => number;
  /** Raw pointer to the waypoint scratch buffer. Build a fresh
   *  Float64Array(memory.buffer, ptr, count * 2) view per call. */
  waypointsPtr: () => number;
  /** Current grid dimensions (refreshed by init). */
  gridWidth: () => number;
  gridHeight: () => number;
}

/** Bit flags for `integrateDampedRotation`. Mirrors the
 *  DAMPED_ROTATION_FLAG_* constants in rts-sim-wasm/src/lib.rs. */
export const DAMPED_ROTATION_FLAG_WRAP = 1 << 0;
export const DAMPED_ROTATION_FLAG_HAS_MIN = 1 << 1;
export const DAMPED_ROTATION_FLAG_HAS_MAX = 1 << 2;

/** Views over the projectile SoA pool. Indexed by slot id (0..count
 *  where count is JS-managed in projectileSystem.ts). All views
 *  share the same WASM linear memory and detach together if memory
 *  grows — `refreshViews` rebuilds them. */
export interface ProjectilePoolViews {
  readonly capacity: number;
  refreshViews: () => void;
  clear: () => void;
  posX: Float64Array;
  posY: Float64Array;
  posZ: Float64Array;
  velX: Float64Array;
  velY: Float64Array;
  velZ: Float64Array;
  timeAlive: Float64Array;
  sourceTurretEntityId: Int32Array;
  sourceHostEntityId: Int32Array;
  sourceRootEntityId: Int32Array;
  sourcePlayerId: Int32Array;
  sourceTeamId: Int32Array;
  sourceTurretBlueprintCode: Uint32Array;
  sourceShotBlueprintCode: Uint32Array;
  spawnTick: Uint32Array;
  parentShotEntityId: Int32Array;
}

/** Layout stride for `quatHoverOrientationStepBatch`. Mirrors
 *  QUAT_HOVER_BATCH_STRIDE in rts-sim-wasm/src/lib.rs. */
export const QUAT_HOVER_BATCH_STRIDE = 14;

/** Layout stride for `unitForceStepBatch`. Mirrors
 *  UNIT_FORCE_BATCH_STRIDE in rts-sim-wasm/src/lib.rs. */
export const UNIT_FORCE_BATCH_STRIDE = 36;

/** Bit flags packed into BodyPoolViews.flags[slot]. Mirrors the
 *  BODY_FLAG_* constants in rts-sim-wasm/src/lib.rs. */
export const BODY_FLAG_SLEEPING = 1 << 0;
export const BODY_FLAG_IS_STATIC = 1 << 1;
export const BODY_FLAG_UPWARD_CONTACT = 1 << 2;
export const BODY_FLAG_SHAPE_CUBOID = 1 << 3;
export const BODY_FLAG_OCCUPIED = 1 << 4;

/** Typed-array views over the WASM-side BodyPool. All views are
 *  indexed by slot id (returned by allocSlot()). Capacity is
 *  fixed at pool_init() so views never need to be refreshed
 *  unless the WASM linear memory itself grows underneath us;
 *  call `refreshViews()` after any operation that might trigger
 *  memory growth (rare under our usage pattern). */
export interface BodyPoolViews {
  readonly capacity: number;
  /** Allocate the next free slot; throws if pool is exhausted. */
  allocSlot: () => number;
  /** Return a slot to the free list. Caller must clear any
   *  pool-managed fields the slot held to sensible defaults if
   *  it's reused later (alloc_slot zeros all fields, so explicit
   *  cleanup isn't required for correctness — just for clarity). */
  freeSlot: (slot: number) => void;
  /** Re-construct all views over the WASM linear memory. Call after
   *  any operation that may have grown WASM memory and detached
   *  existing views. In practice the fixed-capacity pool means
   *  growth is very rare — call defensively at the start of each
   *  tick if you're paranoid, or rely on the views' detachment
   *  check (`view.byteLength === 0`) to detect stale views. */
  refreshViews: () => void;

  posX: Float64Array;
  posY: Float64Array;
  posZ: Float64Array;
  velX: Float64Array;
  velY: Float64Array;
  velZ: Float64Array;
  accelX: Float64Array;
  accelY: Float64Array;
  accelZ: Float64Array;
  launchX: Float64Array;
  launchY: Float64Array;
  launchZ: Float64Array;
  surfaceNormalX: Float64Array;
  surfaceNormalY: Float64Array;
  surfaceNormalZ: Float64Array;
  radius: Float64Array;
  halfX: Float64Array;
  halfY: Float64Array;
  halfZ: Float64Array;
  invMass: Float64Array;
  restitution: Float64Array;
  groundOffset: Float64Array;
  groundFrictionScale: Float64Array;
  sleepTicks: Float64Array;
  flags: Uint8Array;
  entityId: Int32Array;
}

let cached: Promise<SimWasm> | undefined;
let resolvedHandle: SimWasm | undefined;

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
      // Phase 10 D.1 — entity-meta SoA pool. Same initial slot
      // capacity hint as SpatialGrid since the slot spaces are
      // shared (one EntityId<->slot map JS-side).
      entity_meta_init(1024);
      // Phase 10 D.1b — turret sub-pool. Per-entity turret arrays
      // indexed at fixed offsets up to MAX_TURRETS_PER_ENTITY = 8.
      turret_pool_init(1024);
      // AIM-08.1 — targeting input slabs. Same 1024-slot hint as the
      // other pools; auto-grows past it.
      combat_targeting_init(1024);
      // Phase 10 D.2 — verify the hand-rolled MessagePack encoder
      // matches its expected byte output across 21 fixture cases.
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
      // Dev-only: a regression here means the production encoder
      // would diverge from the wire format as we land more fields.
      if (import.meta.env.DEV) {
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
        groundFrictionScale: pool_ground_friction_scale_ptr(),
        sleepTicks: pool_sleep_ticks_ptr(),
        flags: pool_flags_ptr(),
        entityId: pool_entity_id_ptr(),
      };

      const pool: BodyPoolViews = {
        capacity,
        allocSlot: pool_alloc_slot,
        freeSlot: pool_free_slot,
        refreshViews: () => {
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
          pool.groundFrictionScale = f64View(ptrs.groundFrictionScale);
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
        groundFrictionScale: f64View(ptrs.groundFrictionScale),
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
      const projectilePool: ProjectilePoolViews = {
        capacity: projCapacity,
        refreshViews: () => {
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
        constructionReconcileAndGrowPieces: construction_reconcile_and_grow_pieces,
        constructionApplyConsumerSpends: construction_apply_consumer_spends,
        economyApplyIncomeCredits: economy_apply_income_credits,
        economyApplyConverterTransfers: economy_apply_converter_transfers,
        arrivalCompletionStepBatch: arrival_completion_step_batch,
        flyingLoiterStepBatch: flying_loiter_step_batch,
        stuckReplanStepBatch: stuck_replan_step_batch,
        turretRotationStepBatch: turret_rotation_step_batch,
        stepUnitMotion: step_unit_motion,
        clientPredictUnitMotionBatch: client_predict_unit_motion_batch,
        pool,
        poolPrepareDynamicStep: pool_prepare_dynamic_step,
        poolCollectAwakeEntityIds: pool_collect_awake_entity_ids,
        poolFinalizeDynamicStep: pool_finalize_dynamic_step,
        poolStepIntegrate: pool_step_integrate,
        poolResolveSphereSphere: pool_resolve_sphere_sphere,
        engineStaticsCreate: engine_statics_create,
        engineStaticsDestroy: engine_statics_destroy,
        engineStaticsAdd: engine_statics_add,
        engineStaticsRemove: engine_statics_remove,
        poolResolveSphereCuboidFull: pool_resolve_sphere_cuboid_full,
        arrivalControlStepBatch: arrival_control_step_batch,
        unitGroundNormalStepPool: unit_ground_normal_step_pool,
        quatHoverOrientationStepBatch: quat_hover_orientation_step_batch,
        unitForceStepBatch: unit_force_step_batch,
        projectilePool,
        projectileReflectorIntersectionsBatch: projectile_reflector_intersections_batch,
        projectileHitboxSweepBatch: projectile_hitbox_sweep_batch,
        poolStepPackedProjectilesBatch: pool_step_packed_projectiles_batch,
        projectileIntegrateStepBatch: projectile_integrate_step_batch,
        projectileHomingGuidanceBatch: projectile_homing_guidance_batch,
        terrainFollowVerticalThrustAccel: terrain_follow_vertical_thrust_accel,
        solveKinematicIntercept: solve_kinematic_intercept,
        computeHomingThrust: compute_homing_thrust,
        integrateDampedRotation: integrate_damped_rotation,
        metalDepositCountPlacements: metal_deposit_count_placements,
        metalDepositGeneratePlacements: metal_deposit_generate_placements,
        metalDepositResolveTerrainHeights: metal_deposit_resolve_terrain_heights,
        metalDepositCountResourceCandidates: metal_deposit_count_resource_candidates,
        metalDepositGrowResourceCells: metal_deposit_grow_resource_cells,
        terrainInstallMesh: terrain_install_mesh,
        terrainClear: terrain_clear,
        terrainIsInstalled: terrain_is_installed,
        terrainCountCellTriangleRefs: terrain_count_cell_triangle_refs,
        terrainFillCellTriangleIndices: terrain_fill_cell_triangle_indices,
        terrainBuildAdaptiveMesh: terrain_build_adaptive_mesh,
        terrainGetSurfaceHeight: terrain_get_surface_height,
        terrainGetSurfaceNormal: terrain_get_surface_normal,
        terrainSampleGroundForSlots: terrain_sample_ground_for_slots,
        terrainBakeBuildabilityGrid: terrain_bake_buildability_grid,
        terrainHasLineOfSight: terrain_has_line_of_sight,
        fogMarkCircleScanline: fog_mark_circle_scanline,
        fogMarkCircleScanlineRgba: fog_mark_circle_scanline_rgba,
        combatHasLineOfSight: combat_has_line_of_sight,
        memory,
        pathfinder: {
          init: pathfinder_init,
          rebuildMaskAndCc: pathfinder_rebuild_mask_and_cc,
          findPath: pathfinder_find_path,
          waypointsPtr: pathfinder_waypoints_ptr,
          gridWidth: pathfinder_grid_size_w,
          gridHeight: pathfinder_grid_size_h,
        },
        entityMeta: {
          init: entity_meta_init,
          clear: entity_meta_clear,
          register: entity_meta_register,
          unregister: entity_meta_unregister,
          unregisterRoot: entity_meta_unregister_root,
          resolveRow: entity_meta_resolve_row,
          generation: entity_meta_generation,
          resolveStorageSlot: entity_meta_resolve_storage_slot,
          setUnit: entity_meta_set_unit,
          setBuilding: entity_meta_set_building,
          setTower: entity_meta_set_tower,
          unset: entity_meta_unset,
          type: entity_meta_type,
          capacity: entity_meta_capacity,
          typePtr: entity_meta_type_ptr,
          playerIdPtr: entity_meta_player_id_ptr,
          hpCurrPtr: entity_meta_hp_curr_ptr,
          hpMaxPtr: entity_meta_hp_max_ptr,
          combatModePtr: entity_meta_combat_mode_ptr,
          isCommanderPtr: entity_meta_is_commander_ptr,
          buildCompletePtr: entity_meta_build_complete_ptr,
          buildPaidEnergyPtr: entity_meta_build_paid_energy_ptr,
          buildPaidMetalPtr: entity_meta_build_paid_metal_ptr,
          buildTargetIdPtr: entity_meta_build_target_id_ptr,
          suspensionSpringOffsetPtr: entity_meta_suspension_spring_offset_ptr,
          suspensionSpringVelocityPtr: entity_meta_suspension_spring_velocity_ptr,
          factoryIsProducingPtr: entity_meta_factory_is_producing_ptr,
          factoryBuildQueueLenPtr: entity_meta_factory_build_queue_len_ptr,
          factoryProgressPtr: entity_meta_factory_progress_ptr,
          solarOpenPtr: entity_meta_solar_open_ptr,
          buildProgressPtr: entity_meta_build_progress_ptr,
          registryEntityIdPtr: entity_meta_registry_entity_id_ptr,
          registryKindPtr: entity_meta_registry_kind_ptr,
          registryBlueprintKindPtr: entity_meta_registry_blueprint_kind_ptr,
          registryBlueprintCodePtr: entity_meta_registry_blueprint_code_ptr,
          registryOwnerPlayerIdPtr: entity_meta_registry_owner_player_id_ptr,
          registryTeamIdPtr: entity_meta_registry_team_id_ptr,
          registryParentIdPtr: entity_meta_registry_parent_id_ptr,
          registryRootHostIdPtr: entity_meta_registry_root_host_id_ptr,
          registryMountIndexPtr: entity_meta_registry_mount_index_ptr,
          registryStoragePoolPtr: entity_meta_registry_storage_pool_ptr,
          registryStorageSlotPtr: entity_meta_registry_storage_slot_ptr,
          registryGenerationPtr: entity_meta_registry_generation_ptr,
          registryAlivePtr: entity_meta_registry_alive_ptr,
          registryTargetablePtr: entity_meta_registry_targetable_ptr,
          registryCapacity: entity_meta_registry_capacity,
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
          maxTurretsPerEntity: combat_targeting_max_turrets_per_entity,
          entityCapacity: combat_targeting_entity_capacity,
          setEntity: combat_targeting_set_entity,
          unsetEntity: combat_targeting_unset_entity,
          rebuildObservationMasks: combat_targeting_rebuild_observation_masks,
          rebuildObservationMasksForSources: combat_targeting_rebuild_observation_masks_for_sources,
          addSensorObservationCircle: combat_targeting_add_sensor_observation_circle,
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
        snapshotBaseline: {
          create: snapshot_baseline_create,
          destroy: snapshot_baseline_destroy,
          clear: snapshot_baseline_clear,
          unsetSlot: snapshot_baseline_unset_slot,
          ensureCapacity: snapshot_baseline_ensure_capacity,
          liveCount: snapshot_baseline_live_count,
          captureUnitSlot: snapshot_baseline_capture_unit_slot,
          captureBuildingSlot: snapshot_baseline_capture_building_slot,
          slotUsed: snapshot_baseline_slot_used,
          slotLastTick: snapshot_baseline_slot_last_tick,
          diffSlot: snapshot_baseline_diff_slot,
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
          minimapScratchStride: 6,
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
          emitShroud: snapshot_encode_envelope_emit_shroud,
          shroudScratchPtr: snapshot_encode_shroud_scratch_ptr,
          shroudScratchEnsure: snapshot_encode_shroud_scratch_ensure,
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
          emitAudioEvents: snapshot_encode_envelope_emit_audio_events,
          emitPackedAudioEvents: snapshot_encode_envelope_emit_packed_audio_events,
          audioEventScratchPtr: snapshot_encode_audio_event_scratch_ptr,
          audioEventScratchEnsure: snapshot_encode_audio_event_scratch_ensure,
          audioEventScratchStride: 16,
          deathContextScratchPtr: snapshot_encode_death_context_scratch_ptr,
          deathContextScratchEnsure: snapshot_encode_death_context_scratch_ensure,
          deathContextScratchStride: 16,
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
          projVelScratchStride: 8,
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
          v6UnitScratchStride: 51,
          v6BuildingScratchPtr: snapshot_encode_v6_building_scratch_ptr,
          v6BuildingScratchEnsure: snapshot_encode_v6_building_scratch_ensure,
          v6BuildingScratchStride: 34,
          writerPtr: messagepack_writer_ptr,
          writerLen: messagepack_writer_len,
          writerClear: messagepack_writer_clear,
          turretScratchPtr: snapshot_encode_turret_scratch_ptr,
          turretScratchEnsure: snapshot_encode_turret_scratch_ensure,
          turretScratchStride: 10,
          actionScratchPtr: snapshot_encode_action_scratch_ptr,
          actionScratchEnsure: snapshot_encode_action_scratch_ensure,
          actionScratchStride: 16,
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
          queryOccupiedCellsDebug: spatial_query_occupied_cells_debug,
          scratchPtr: spatial_scratch_ptr,
          scratchLen: spatial_scratch_len,
          slotKind: spatial_slot_kind,
        },
      };
      resolvedHandle = handle;
      if (import.meta.env.DEV) {
        const { runTurretHostIntegrationContractTest } = await import('../sim/turretHostIntegrationTest');
        runTurretHostIntegrationContractTest();
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

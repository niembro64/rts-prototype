// combat_targeting — extracted from lib.rs (pure code motion).

#[allow(unused_imports)]
use crate::*;
use std::cell::Cell;
#[allow(unused_imports)]
use wasm_bindgen::prelude::*;

// ─────────────────────────────────────────────────────────────────
// AIM-08.1 — Targeting input slabs
//
// Per-tick stamping from JS state of every input the upcoming
// targeting kernels (AIM-08.2..5) will read. The TS targeting FSM in
// targetingSystem.ts remains authoritative until AIM-08.5; the slabs
// are a non-authoritative shadow today. AIM-08.6 deletes the JS path
// and the slab becomes the source of truth.
//
// Layout:
//   - Entity slab (keyed by spatial-grid entity slot): hp, owner,
//     position, velocity, shot radius, flags.
//   - Turret slab (keyed by entity_slot * MAX_PER_ENTITY + turret_idx):
//     world mount kinematics, rotation/pitch, FSM state, target,
//     pre-squared range envelopes (fire max + min + tracking),
//     losBlockedTicks, packed config flags.
//   - Field slab (compact list of `count` active shields): id,
//     owner entity id, center, radius. Rebuilt from scratch each tick.
// ─────────────────────────────────────────────────────────────────

pub const COMBAT_TARGETING_MAX_TURRETS_PER_ENTITY: u32 = TURRET_POOL_MAX_PER_ENTITY;

// Entity-flag bits — packed into `entity_flags`.
pub const CT_ENTITY_FLAG_ALIVE: u8 = 1 << 0;
pub const CT_ENTITY_FLAG_HAS_COMBAT: u8 = 1 << 1;
pub const CT_ENTITY_FLAG_FIRE_ENABLED: u8 = 1 << 2;
pub const CT_ENTITY_FLAG_BUILDABLE_COMPLETE: u8 = 1 << 3;
pub const CT_ENTITY_FLAG_CLOAKED: u8 = 1 << 4;
/// When set, this entity (a unit or tower host) refuses every lock-on while
/// a friendly entity is positioned directly above it, so a freshly-spawned
/// host does not fire up through the teammate (e.g. the fabricator) that is
/// hovering over it. Stamped from the host blueprint's
/// `preventLockOnIfMyTeamIsAboveMe`.
pub const CT_ENTITY_FLAG_PREVENT_LOCKON_IF_TEAM_ABOVE: u8 = 1 << 5;

// Turret-config-flag bits — packed into `turret_config_flags`.
pub const CT_TURRET_CFG_REQUIRES_NON_OBSTRUCTED_LOS: u32 = 1 << 0;
pub const CT_TURRET_CFG_NEEDS_BALLISTIC: u32 = 1 << 1;
pub const CT_TURRET_CFG_VERTICAL_LAUNCHER: u32 = 1 << 2;
pub const CT_TURRET_CFG_IS_MANUAL_FIRE: u32 = 1 << 3;
pub const CT_TURRET_CFG_PASSIVE: u32 = 1 << 4;
pub const CT_TURRET_CFG_VISUAL_ONLY: u32 = 1 << 5;
pub const CT_TURRET_CFG_SHOT_IS_FORCE: u32 = 1 << 6;
pub const CT_TURRET_CFG_HAS_TRACKING_RANGE: u32 = 1 << 7;
/// When set, the turret inherits the host entity's priority target /
/// priority point. When clear (fully-autonomous), priority FSM batches
/// must skip this turret entirely so it keeps running its own
/// independent acquisition.
pub const CT_TURRET_CFG_HOST_DIRECTED: u32 = 1 << 8;
pub const CT_TURRET_CFG_RANGE_BOTTOM_UNBOUNDED: u32 = 1 << 9;
pub const CT_TURRET_CFG_RANGE_TOP_UNBOUNDED: u32 = 1 << 10;
/// Packed range-mode value for a cylinder capped at the water surface and
/// unbounded below. Bit 10 alone was previously unused; bits 9+10 retain the
/// existing top-and-bottom-unbounded mode.
#[allow(dead_code)]
pub const CT_TURRET_CFG_RANGE_TOP_WATER_AND_BOTTOM_UNBOUNDED: u32 = 1 << 10;
pub const CT_TURRET_CFG_RANGE_SPHERE: u32 = 1 << 11;
pub const CT_TURRET_CFG_REQUIRED_ENGAGED_FOR_FIGHT_STOP: u32 = 1 << 12;
/// Shield-only emitters maintain force material and may keep targeting
/// through that material. Offensive shield emitters with submunitions do
/// not set this; their damaging fire uses the normal shield-aware
/// targeting gate.
pub const CT_TURRET_CFG_IGNORES_FORCE_MATERIAL_SIGHT_OBSTRUCTION: u32 = 1 << 13;
/// Passive shield panels aim between the incoming enemy turret and the
/// enemy body so reflections return toward the source of fire.
pub const CT_TURRET_CFG_RAY_BISECT_TURRET_AND_BODY: u32 = 1 << 14;
/// When set, this turret may only lock an enemy the player/team sees with
/// FULL sight (not radar-only). Direct beams and precision line weapons set
/// it; artillery / missiles that author radar fire leave it clear.
pub const CT_TURRET_CFG_REQUIRES_FULL_SIGHT: u32 = 1 << 15;
/// The emitted projectile operates in air but not water, so this turret may
/// only acquire a target whose physical volume is exposed above the waterline.
/// This is stamped from shot-medium configuration, not a unit/chassis type.
pub const CT_TURRET_CFG_REQUIRES_AIR_TARGET: u32 = 1 << 16;

// FSM state encodings (CT_TURRET_STATE_*) are generated from
// src/wireEnums.json — see the include! near the top of this file.

// LOCK-ON-03 — Per-turret lock-on inclusion masks. Authored on each
// turret blueprint; JS compiles the inclusion sets into bitmasks and
// stamps them onto the slab. Lock-on is off by default: an empty mask
// (= 0) includes nothing, so the locker can lock onto nothing. A bit
// set marks that relationship/family as eligible. Kernels read these
// alongside per-entity family/blueprint metadata to admit only included
// candidates without crossing back into JS.
pub const CT_LOCK_ON_REL_INCLUDE_FRIENDLY: u8 = 1 << 0;
pub const CT_LOCK_ON_REL_INCLUDE_ENEMY: u8 = 1 << 1;
pub const CT_LOCK_ON_FAM_INCLUDE_BUILDINGS: u8 = 1 << 0;
pub const CT_LOCK_ON_FAM_INCLUDE_UNITS: u8 = 1 << 1;
pub const CT_LOCK_ON_FAM_INCLUDE_TURRETS: u8 = 1 << 2;
pub const CT_LOCK_ON_FAM_INCLUDE_TOWERS: u8 = 1 << 3;
pub const CT_LOCK_ON_FAM_INCLUDE_SHOTS: u8 = 1 << 5;

// LOCK-ON-04 — Reciprocal lock-on candidacy modes. Stamped from the
// normalized blueprint inclusion object. `REQUIRE` admits only enemy
// candidates that were locked onto this turret/host in the prior
// committed targeting state. Both preference modes keep ordinary
// candidacy but rank those threats in a strict higher tier; `REACQUIRE`
// also schedules a scan when the current target stops reciprocating.
pub const CT_LOCK_ON_RECIPROCAL_IGNORE: u8 = 0;
pub const CT_LOCK_ON_RECIPROCAL_REQUIRE: u8 = 1;
pub const CT_LOCK_ON_RECIPROCAL_PREFER_REACQUIRE: u8 = 2;
pub const CT_LOCK_ON_RECIPROCAL_PREFER_HOLD: u8 = 3;

// LOCK-ON-03 — Per-entity family encoding stamped on entity slab rows.
// Zero is the cleared/unstamped sentinel so a stale row from
// `clear_all` cannot match a real family in the exclusion check.
pub const CT_ENTITY_FAMILY_NONE: u8 = 0;
pub const CT_ENTITY_FAMILY_BUILDING: u8 = 1;
pub const CT_ENTITY_FAMILY_UNIT: u8 = 2;
pub const CT_ENTITY_FAMILY_TOWER: u8 = 3;
pub const CT_ENTITY_FAMILY_SHOT: u8 = 4;

// LOCK-ON-03 — Sentinel for `entity_blueprint_code` when the entity has
// no stamped blueprint id (unstamped row, or family == NONE). Kernels
// short-circuit on this before applying the level-1 mask check.
pub const CT_BLUEPRINT_CODE_NONE: u8 = 0xff;

#[derive(Default)]
pub(crate) struct CombatTargetingObservationCell {
    pub(crate) slots: Vec<u32>,
    pub(crate) owner_bits: u32,
}

pub(crate) struct CombatTargetingPool {
    pub(crate) wind_x: f64,
    pub(crate) wind_y: f64,
    pub(crate) wind_z: f64,
    // Per-entity, indexed by spatial-grid slot.
    pub(crate) entity_id: Vec<i32>,
    pub(crate) entity_owner_player_id: Vec<u8>,
    pub(crate) entity_owner_bit: Vec<u32>,
    pub(crate) entity_view_mask: Vec<u32>,
    pub(crate) entity_pos_x: Vec<f64>,
    pub(crate) entity_pos_y: Vec<f64>,
    pub(crate) entity_pos_z: Vec<f64>,
    pub(crate) entity_vel_x: Vec<f64>,
    pub(crate) entity_vel_y: Vec<f64>,
    pub(crate) entity_vel_z: Vec<f64>,
    // Per-entity pose inputs used by the Rust Pass 0 mount-kinematics
    // update. Stamped from JS because terrain/base-height and
    // suspension still live on Entity objects during AIM-08.5.
    pub(crate) entity_ground_z: Vec<f64>,
    pub(crate) entity_rot_cos: Vec<f64>,
    pub(crate) entity_rot_sin: Vec<f64>,
    pub(crate) entity_surface_nx: Vec<f64>,
    pub(crate) entity_surface_ny: Vec<f64>,
    pub(crate) entity_surface_nz: Vec<f64>,
    pub(crate) entity_suspension_offset_x: Vec<f64>,
    pub(crate) entity_suspension_offset_y: Vec<f64>,
    pub(crate) entity_suspension_offset_z: Vec<f64>,
    pub(crate) entity_radius_hitbox: Vec<f64>,
    // Body-vs-body collision radius. The hitbox radius above is the
    // damage-receiving hurtbox; this is the contact radius. Splash/segment
    // damage against travelling shots tests the collision radius (a shot's
    // collision body is what an explosion or beam sweep clips), so the
    // damage candidate kernels read this column for SHOT-family rows while
    // unit/building rows keep using entity_radius_hitbox.
    pub(crate) entity_radius_collision: Vec<f64>,
    // AABB half-extents for AABB-shaped targets (buildings). Zero on
    // sphere-shaped targets (units / projectiles) so aim-point
    // resolution can clamp uniformly without branching on entity
    // shape: a zero half-extent collapses the clamp to the entity
    // center, matching the sphere behaviour.
    pub(crate) entity_aabb_half_x: Vec<f64>,
    pub(crate) entity_aabb_half_y: Vec<f64>,
    pub(crate) entity_aabb_half_z: Vec<f64>,
    pub(crate) entity_hp: Vec<f32>,
    pub(crate) entity_flags: Vec<u8>,
    // LOCK-ON-03 — Per-entity family + blueprint id stamped on entity
    // rows so kernels can apply level-0 entity-family and level-1 named
    // exclusions without crossing the boundary. Family is one of
    // CT_ENTITY_FAMILY_*; blueprint code is the network wire code for
    // the unit/building blueprint, or CT_BLUEPRINT_CODE_NONE when the
    // family is NONE. The wire codes for units and buildings fit in
    // u8 today (UNIT_BLUEPRINT_CODE_UNKNOWN = BUILDING_BLUEPRINT_CODE_UNKNOWN = 0xff).
    pub(crate) entity_family: Vec<u8>,
    pub(crate) entity_blueprint_code: Vec<u8>,
    // LOCK-ON-04 — Per-host lock-on exclusion masks compiled from
    // unit/tower blueprints. These gate host priority targets before
    // host-directed turrets apply their own per-turret policy.
    pub(crate) entity_lockon_relationship_mask: Vec<u8>,
    pub(crate) entity_lockon_entity_family_mask: Vec<u8>,
    pub(crate) entity_lockon_building_mask: Vec<u32>,
    pub(crate) entity_lockon_tower_mask: Vec<u32>,
    pub(crate) entity_lockon_unit_mask: Vec<u32>,
    pub(crate) entity_lockon_turret_mask: Vec<u32>,
    pub(crate) entity_lockon_shot_mask: Vec<u32>,
    // Per-entity full-sight and radar-level source radii. Full sight
    // also counts as radar-level coverage because sight is the
    // stronger information tier. Stamped from shared sensor coverage
    // helpers; zero means the entity provides no source for that tier.
    pub(crate) entity_full_vision_radius: Vec<f32>,
    pub(crate) entity_radar_radius: Vec<f32>,
    pub(crate) entity_detector_radius: Vec<f32>,
    // Per-target player masks rebuilt once after entity stamping.
    // A bit is set when that player's radar-level aggregate covers
    // this target. Radar-level aggregate is sight OR radar.
    pub(crate) entity_sensor_coverage_mask: Vec<u32>,
    // Coverage by FULL-SIGHT sources only (excludes radar-only sensors). A
    // subset of entity_sensor_coverage_mask. Turrets that require full sight
    // (direct beams / precision line weapons) gate enemy lock-on on this mask
    // so radar-only contacts are eligible only for radar-fire weapons.
    pub(crate) entity_full_sight_coverage_mask: Vec<u32>,
    pub(crate) entity_detector_coverage_mask: Vec<u32>,
    pub(crate) observation_cells: HashMap<u64, CombatTargetingObservationCell>,
    pub(crate) observation_cell_keys: Vec<u64>,
    pub(crate) observation_max_detection_padding: f64,
    // Per-entity visibility padding the observability walk adds when
    // this entity is the *target*, so a target counts as observed when
    // its edge (not just its center) falls inside a vision/radar
    // circle. Matches the JS `getEntityVisibilityPadding` value (max
    // body/shot/collision radius for units; max half-extent for
    // buildings).
    pub(crate) entity_detection_padding: Vec<f32>,
    // Per-entity targeting inputs that were JS scratch arrays before
    // AIM-08.5's slab-only scheduler. Stamped from CombatComponent
    // every tick so the kernel can walk the slab instead of accepting
    // priority/probe arrays at the boundary.
    pub(crate) entity_priority_target_id: Vec<i32>,
    pub(crate) entity_priority_point_present: Vec<u8>,
    pub(crate) entity_priority_point_x: Vec<f64>,
    pub(crate) entity_priority_point_y: Vec<f64>,
    pub(crate) entity_priority_point_z: Vec<f64>,
    pub(crate) entity_scheduled_probe_tick: Vec<i32>,
    // AIM-08.5 — per-entity activity masks computed by the Rust mask
    // refresh kernel. Bit i set means turret i is active (FSM in
    // tracking/engaged, or angular/pitch velocity above the rotation-
    // work epsilon). The firing mask additionally requires turret i to
    // be ENGAGED and not passive / force-shot. JS readers (turretSystem,
    // projectileSystem) consume these directly via the slab views; the
    // JS readers consume these directly via slab views or scheduler
    // output flags; there is no parallel JS-side mask mirror.
    pub(crate) entity_active_turret_mask: Vec<u32>,
    pub(crate) entity_firing_turret_mask: Vec<u32>,
    pub(crate) entity_slot_by_id: HashMap<i32, u32>,
    pub(crate) active_entity_slots: Vec<u32>,
    pub(crate) entity_stamp_epoch: Vec<u32>,
    pub(crate) stamp_epoch: u32,
    // Per-source memo for the "friendly directly above me" lock-on shelter
    // gate (CT_ENTITY_FLAG_PREVENT_LOCKON_IF_TEAM_ABOVE). Computed once per
    // source per stamp epoch and reused across that source's per-candidate
    // lock-on checks. Cell interior mutability lets the immutable per-candidate
    // gate populate the cache (single-threaded wasm).
    pub(crate) entity_shelter_memo_epoch: Vec<Cell<u32>>,
    pub(crate) entity_shelter_memo_value: Vec<Cell<u8>>,
    // Transient per-stamp flag written by set_entity and consumed by the
    // set_turret calls that follow it in the same stamping pass: 1 when
    // the slot still holds the same entity it held last stamp, so the
    // slab-owned FSM tuple (state, target, committed target, cooldowns,
    // losBlockedTicks) must be preserved; 0 on slot reuse, which seeds
    // those columns to the fresh-turret constants instead. This is what
    // lets the slab own FSM persistence without a JS read-back loop.
    pub(crate) entity_stamp_same_entity: Vec<u8>,

    // Per-turret, indexed by entity_slot * MAX_PER_ENTITY + turret_idx.
    // Runtime EntityIds make the turret addressable; slot/index remain
    // cached storage coordinates only.
    pub(crate) turret_count_per_entity: Vec<u8>,
    pub(crate) turret_entity_id: Vec<i32>,
    pub(crate) turret_parent_id: Vec<i32>,
    pub(crate) turret_root_host_id: Vec<i32>,
    pub(crate) turret_mount_index: Vec<i32>,
    pub(crate) turret_mount_x: Vec<f64>,
    pub(crate) turret_mount_y: Vec<f64>,
    pub(crate) turret_mount_z: Vec<f64>,
    pub(crate) turret_radius_hitbox: Vec<f64>,
    pub(crate) turret_mount_vx: Vec<f64>,
    pub(crate) turret_mount_vy: Vec<f64>,
    pub(crate) turret_mount_vz: Vec<f64>,
    pub(crate) turret_local_mount_x: Vec<f64>,
    pub(crate) turret_local_mount_y: Vec<f64>,
    pub(crate) turret_local_mount_z: Vec<f64>,
    pub(crate) turret_world_pos_tick: Vec<i32>,
    pub(crate) turret_rotation: Vec<f32>,
    pub(crate) turret_pitch: Vec<f32>,
    // AIM-08.5 — per-turret angular/pitch velocity. Stamped from JS
    // Turret at the start of each tick and re-synced after the JS
    // turretSystem rotation pass; the activity-mask kernel reads these
    // to compute hasTurretRotationWork without crossing back into JS.
    pub(crate) turret_angular_velocity: Vec<f32>,
    pub(crate) turret_pitch_velocity: Vec<f32>,
    pub(crate) turret_state: Vec<u8>,
    pub(crate) turret_target_id: Vec<i32>,
    // Prior committed target id stamped at the start of the current
    // targeting tick. Current-tick FSM writes mutate `turret_target_id`;
    // reciprocal lock-on reads this frozen column so world-order updates
    // cannot create intra-tick target cycles.
    pub(crate) turret_committed_target_id: Vec<i32>,
    // Transitional AIM-08.5 runtime timers. Firing still writes these
    // on JS Turret objects after projectile emission, then the next
    // targeting stamp copies them into the slab so the scheduled Rust
    // targeting batch owns per-tick cooldown decrement.
    pub(crate) turret_cooldown: Vec<f64>,
    pub(crate) turret_burst_cooldown: Vec<f64>,
    // Pre-squared turret range radii. Runtime membership treats these
    // as vertical cylinders: horizontal radius R, top cap mount.z + R,
    // and either bounded or unbounded vertical caps depending
    // on the turret blueprint. Sentinels: fire_min_*_sq <= 0 means
    // "no min preference"; tracking_*_sq <= 0 and the
    // HAS_TRACKING_RANGE flag together encode "no separate tracking
    // shell — fire.max is the outermost release boundary".
    pub(crate) turret_fire_max_acquire_sq: Vec<f64>,
    pub(crate) turret_fire_max_release_sq: Vec<f64>,
    pub(crate) turret_fire_min_acquire_sq: Vec<f64>,
    pub(crate) turret_fire_min_release_sq: Vec<f64>,
    pub(crate) turret_tracking_acquire_sq: Vec<f64>,
    pub(crate) turret_tracking_release_sq: Vec<f64>,
    // Raw acquire distance for the outermost shell (tracking when
    // present, fire.max otherwise) — used by the broadphase spatial
    // query, which wants the un-squared radius.
    pub(crate) turret_outermost_acquire: Vec<f64>,
    // Raw 2D local-mount distance from the host entity origin. Used by
    // the auto-targeting pre-scan to widen one unit-centered
    // broadphase query enough to cover every turret-centered range.
    pub(crate) turret_mount_offset_2d: Vec<f64>,
    // Per-turret sustained DPS. Static per shot blueprint
    // (cooldown + shot damage / dps). Zero for visualOnly /
    // force-shot / missing-shot turrets. Used by the Rust passive-
    // shield-panel target check to walk a target's turrets and score them.
    pub(crate) turret_dps: Vec<f32>,
    // Static per-turret ballistic gate config, stamped once alongside
    // the turret blueprint data. AIM-08.5 kernels read these from the
    // slab instead of accepting per-entity JS scratch arrays.
    pub(crate) turret_projectile_speed: Vec<f64>,
    pub(crate) turret_projectile_mass: Vec<f64>,
    pub(crate) turret_projectile_air_friction_per_60hz_frame: Vec<f64>,
    pub(crate) turret_arc_preference: Vec<u8>,
    pub(crate) turret_max_time_sec: Vec<f64>,
    pub(crate) turret_ground_aim_fraction: Vec<f64>,
    pub(crate) turret_under_only: Vec<u8>,
    pub(crate) turret_blueprint_code: Vec<u8>,
    pub(crate) turret_los_blocked_ticks: Vec<u16>,
    pub(crate) turret_config_flags: Vec<u32>,
    // LOCK-ON-03 — Per-turret lock-on inclusion masks compiled from
    // each turret blueprint's authored inclusion arrays. Lock-on is off
    // by default: an empty level-0 mask includes nothing.
    //   relationship_mask:   CT_LOCK_ON_REL_INCLUDE_*  (friendly / enemy)
    //   entity_family_mask:  CT_LOCK_ON_FAM_INCLUDE_*  (buildings / towers / units / turrets / shots)
    //   building / tower / unit / turret named masks: bit (1 << wire_code)
    //     set means "include only the named blueprints with these wire
    //     codes within an already-included family"; an empty named mask
    //     applies no name restriction. With u32 bitmasks the per-family
    //     blueprint table is capped at 32 ids; the JS loader rejects new
    //     ids past that limit at startup.
    pub(crate) turret_lockon_relationship_mask: Vec<u8>,
    pub(crate) turret_lockon_entity_family_mask: Vec<u8>,
    pub(crate) turret_lockon_building_mask: Vec<u32>,
    // Towers share the static-structure wire-code space with buildings,
    // so the tower mask uses the same `entity_blueprint_code` lookup.
    // The kernel picks which mask to consult based on the candidate's
    // `entity_family`.
    pub(crate) turret_lockon_tower_mask: Vec<u32>,
    pub(crate) turret_lockon_unit_mask: Vec<u32>,
    pub(crate) turret_lockon_turret_mask: Vec<u32>,
    pub(crate) turret_lockon_shot_mask: Vec<u32>,
    pub(crate) turret_lockon_reciprocal_mode: Vec<u8>,
    // AIM-08.4 ballistic solver outputs. Written by the Rust solver
    // using turret mount data from the slab; JS reads these outputs
    // for transitional targeting gates and turret pose until AIM-08.5
    // consumes them directly inside the FSM kernel.
    pub(crate) turret_ballistic_has_solution: Vec<u8>,
    pub(crate) turret_ballistic_flight_time: Vec<f64>,
    pub(crate) turret_ballistic_launch_vx: Vec<f64>,
    pub(crate) turret_ballistic_launch_vy: Vec<f64>,
    pub(crate) turret_ballistic_launch_vz: Vec<f64>,
    pub(crate) turret_ballistic_yaw: Vec<f32>,
    pub(crate) turret_ballistic_pitch: Vec<f32>,
    pub(crate) turret_ballistic_aim_x: Vec<f64>,
    pub(crate) turret_ballistic_aim_y: Vec<f64>,
    pub(crate) turret_ballistic_aim_z: Vec<f64>,
}

impl CombatTargetingPool {
    pub(crate) fn empty() -> Self {
        Self {
            wind_x: 0.0,
            wind_y: 0.0,
            wind_z: 0.0,
            entity_id: Vec::new(),
            entity_owner_player_id: Vec::new(),
            entity_owner_bit: Vec::new(),
            entity_view_mask: Vec::new(),
            entity_pos_x: Vec::new(),
            entity_pos_y: Vec::new(),
            entity_pos_z: Vec::new(),
            entity_vel_x: Vec::new(),
            entity_vel_y: Vec::new(),
            entity_vel_z: Vec::new(),
            entity_ground_z: Vec::new(),
            entity_rot_cos: Vec::new(),
            entity_rot_sin: Vec::new(),
            entity_surface_nx: Vec::new(),
            entity_surface_ny: Vec::new(),
            entity_surface_nz: Vec::new(),
            entity_suspension_offset_x: Vec::new(),
            entity_suspension_offset_y: Vec::new(),
            entity_suspension_offset_z: Vec::new(),
            entity_radius_hitbox: Vec::new(),
            entity_radius_collision: Vec::new(),
            entity_aabb_half_x: Vec::new(),
            entity_aabb_half_y: Vec::new(),
            entity_aabb_half_z: Vec::new(),
            entity_hp: Vec::new(),
            entity_flags: Vec::new(),
            entity_family: Vec::new(),
            entity_blueprint_code: Vec::new(),
            entity_lockon_relationship_mask: Vec::new(),
            entity_lockon_entity_family_mask: Vec::new(),
            entity_lockon_building_mask: Vec::new(),
            entity_lockon_tower_mask: Vec::new(),
            entity_lockon_unit_mask: Vec::new(),
            entity_lockon_turret_mask: Vec::new(),
            entity_lockon_shot_mask: Vec::new(),
            entity_full_vision_radius: Vec::new(),
            entity_radar_radius: Vec::new(),
            entity_detector_radius: Vec::new(),
            entity_sensor_coverage_mask: Vec::new(),
            entity_full_sight_coverage_mask: Vec::new(),
            entity_detector_coverage_mask: Vec::new(),
            observation_cells: HashMap::default(),
            observation_cell_keys: Vec::new(),
            observation_max_detection_padding: 0.0,
            entity_detection_padding: Vec::new(),
            entity_priority_target_id: Vec::new(),
            entity_priority_point_present: Vec::new(),
            entity_priority_point_x: Vec::new(),
            entity_priority_point_y: Vec::new(),
            entity_priority_point_z: Vec::new(),
            entity_scheduled_probe_tick: Vec::new(),
            entity_active_turret_mask: Vec::new(),
            entity_firing_turret_mask: Vec::new(),
            entity_slot_by_id: HashMap::default(),
            active_entity_slots: Vec::new(),
            entity_stamp_epoch: Vec::new(),
            stamp_epoch: 1,
            entity_shelter_memo_epoch: Vec::new(),
            entity_shelter_memo_value: Vec::new(),
            entity_stamp_same_entity: Vec::new(),
            turret_count_per_entity: Vec::new(),
            turret_entity_id: Vec::new(),
            turret_parent_id: Vec::new(),
            turret_root_host_id: Vec::new(),
            turret_mount_index: Vec::new(),
            turret_mount_x: Vec::new(),
            turret_mount_y: Vec::new(),
            turret_mount_z: Vec::new(),
            turret_radius_hitbox: Vec::new(),
            turret_mount_vx: Vec::new(),
            turret_mount_vy: Vec::new(),
            turret_mount_vz: Vec::new(),
            turret_local_mount_x: Vec::new(),
            turret_local_mount_y: Vec::new(),
            turret_local_mount_z: Vec::new(),
            turret_world_pos_tick: Vec::new(),
            turret_rotation: Vec::new(),
            turret_pitch: Vec::new(),
            turret_angular_velocity: Vec::new(),
            turret_pitch_velocity: Vec::new(),
            turret_state: Vec::new(),
            turret_target_id: Vec::new(),
            turret_committed_target_id: Vec::new(),
            turret_cooldown: Vec::new(),
            turret_burst_cooldown: Vec::new(),
            turret_fire_max_acquire_sq: Vec::new(),
            turret_fire_max_release_sq: Vec::new(),
            turret_fire_min_acquire_sq: Vec::new(),
            turret_fire_min_release_sq: Vec::new(),
            turret_tracking_acquire_sq: Vec::new(),
            turret_tracking_release_sq: Vec::new(),
            turret_outermost_acquire: Vec::new(),
            turret_mount_offset_2d: Vec::new(),
            turret_dps: Vec::new(),
            turret_projectile_speed: Vec::new(),
            turret_projectile_mass: Vec::new(),
            turret_projectile_air_friction_per_60hz_frame: Vec::new(),
            turret_arc_preference: Vec::new(),
            turret_max_time_sec: Vec::new(),
            turret_ground_aim_fraction: Vec::new(),
            turret_under_only: Vec::new(),
            turret_blueprint_code: Vec::new(),
            turret_los_blocked_ticks: Vec::new(),
            turret_config_flags: Vec::new(),
            turret_lockon_relationship_mask: Vec::new(),
            turret_lockon_entity_family_mask: Vec::new(),
            turret_lockon_building_mask: Vec::new(),
            turret_lockon_tower_mask: Vec::new(),
            turret_lockon_unit_mask: Vec::new(),
            turret_lockon_turret_mask: Vec::new(),
            turret_lockon_shot_mask: Vec::new(),
            turret_lockon_reciprocal_mode: Vec::new(),
            turret_ballistic_has_solution: Vec::new(),
            turret_ballistic_flight_time: Vec::new(),
            turret_ballistic_launch_vx: Vec::new(),
            turret_ballistic_launch_vy: Vec::new(),
            turret_ballistic_launch_vz: Vec::new(),
            turret_ballistic_yaw: Vec::new(),
            turret_ballistic_pitch: Vec::new(),
            turret_ballistic_aim_x: Vec::new(),
            turret_ballistic_aim_y: Vec::new(),
            turret_ballistic_aim_z: Vec::new(),
        }
    }

    pub(crate) fn ensure_entity_capacity(&mut self, entity_slot: u32) {
        let entity_needed = (entity_slot as usize) + 1;
        if self.entity_id.len() < entity_needed {
            self.entity_id.resize(entity_needed, -1);
            self.entity_owner_player_id.resize(entity_needed, 0);
            self.entity_owner_bit.resize(entity_needed, 0);
            self.entity_view_mask.resize(entity_needed, 0);
            self.entity_pos_x.resize(entity_needed, 0.0);
            self.entity_pos_y.resize(entity_needed, 0.0);
            self.entity_pos_z.resize(entity_needed, 0.0);
            self.entity_vel_x.resize(entity_needed, 0.0);
            self.entity_vel_y.resize(entity_needed, 0.0);
            self.entity_vel_z.resize(entity_needed, 0.0);
            self.entity_ground_z.resize(entity_needed, 0.0);
            self.entity_rot_cos.resize(entity_needed, 1.0);
            self.entity_rot_sin.resize(entity_needed, 0.0);
            self.entity_surface_nx.resize(entity_needed, 0.0);
            self.entity_surface_ny.resize(entity_needed, 0.0);
            self.entity_surface_nz.resize(entity_needed, 1.0);
            self.entity_suspension_offset_x.resize(entity_needed, 0.0);
            self.entity_suspension_offset_y.resize(entity_needed, 0.0);
            self.entity_suspension_offset_z.resize(entity_needed, 0.0);
            self.entity_radius_hitbox.resize(entity_needed, 0.0);
            self.entity_radius_collision.resize(entity_needed, 0.0);
            self.entity_aabb_half_x.resize(entity_needed, 0.0);
            self.entity_aabb_half_y.resize(entity_needed, 0.0);
            self.entity_aabb_half_z.resize(entity_needed, 0.0);
            self.entity_hp.resize(entity_needed, 0.0);
            self.entity_flags.resize(entity_needed, 0);
            self.entity_family
                .resize(entity_needed, CT_ENTITY_FAMILY_NONE);
            self.entity_blueprint_code
                .resize(entity_needed, CT_BLUEPRINT_CODE_NONE);
            self.entity_lockon_relationship_mask
                .resize(entity_needed, 0);
            self.entity_lockon_entity_family_mask
                .resize(entity_needed, 0);
            self.entity_lockon_building_mask.resize(entity_needed, 0);
            self.entity_lockon_tower_mask.resize(entity_needed, 0);
            self.entity_lockon_unit_mask.resize(entity_needed, 0);
            self.entity_lockon_turret_mask.resize(entity_needed, 0);
            self.entity_lockon_shot_mask.resize(entity_needed, 0);
            self.entity_full_vision_radius.resize(entity_needed, 0.0);
            self.entity_radar_radius.resize(entity_needed, 0.0);
            self.entity_detector_radius.resize(entity_needed, 0.0);
            self.entity_sensor_coverage_mask.resize(entity_needed, 0);
            self.entity_full_sight_coverage_mask
                .resize(entity_needed, 0);
            self.entity_detector_coverage_mask.resize(entity_needed, 0);
            self.entity_detection_padding.resize(entity_needed, 0.0);
            self.entity_priority_target_id.resize(entity_needed, -1);
            self.entity_priority_point_present.resize(entity_needed, 0);
            self.entity_priority_point_x.resize(entity_needed, 0.0);
            self.entity_priority_point_y.resize(entity_needed, 0.0);
            self.entity_priority_point_z.resize(entity_needed, 0.0);
            self.entity_scheduled_probe_tick.resize(entity_needed, -1);
            self.entity_active_turret_mask.resize(entity_needed, 0);
            self.entity_firing_turret_mask.resize(entity_needed, 0);
            self.entity_stamp_epoch.resize(entity_needed, 0);
            self.entity_shelter_memo_epoch
                .resize_with(entity_needed, || Cell::new(0));
            self.entity_shelter_memo_value
                .resize_with(entity_needed, || Cell::new(0));
            self.entity_stamp_same_entity.resize(entity_needed, 0);
            self.turret_count_per_entity.resize(entity_needed, 0);
        }
        let turret_needed = entity_needed * (COMBAT_TARGETING_MAX_TURRETS_PER_ENTITY as usize);
        if self.turret_mount_x.len() < turret_needed {
            self.turret_entity_id
                .resize(turret_needed, ENTITY_META_NO_ID);
            self.turret_parent_id
                .resize(turret_needed, ENTITY_META_NO_ID);
            self.turret_root_host_id
                .resize(turret_needed, ENTITY_META_NO_ID);
            self.turret_mount_index
                .resize(turret_needed, ENTITY_META_NO_INDEX);
            self.turret_mount_x.resize(turret_needed, 0.0);
            self.turret_mount_y.resize(turret_needed, 0.0);
            self.turret_mount_z.resize(turret_needed, 0.0);
            self.turret_radius_hitbox.resize(turret_needed, 0.0);
            self.turret_mount_vx.resize(turret_needed, 0.0);
            self.turret_mount_vy.resize(turret_needed, 0.0);
            self.turret_mount_vz.resize(turret_needed, 0.0);
            self.turret_local_mount_x.resize(turret_needed, 0.0);
            self.turret_local_mount_y.resize(turret_needed, 0.0);
            self.turret_local_mount_z.resize(turret_needed, 0.0);
            self.turret_world_pos_tick.resize(turret_needed, -1);
            self.turret_rotation.resize(turret_needed, 0.0);
            self.turret_pitch.resize(turret_needed, 0.0);
            self.turret_angular_velocity.resize(turret_needed, 0.0);
            self.turret_pitch_velocity.resize(turret_needed, 0.0);
            self.turret_state
                .resize(turret_needed, CT_TURRET_STATE_IDLE);
            self.turret_target_id.resize(turret_needed, -1);
            self.turret_committed_target_id.resize(turret_needed, -1);
            self.turret_cooldown.resize(turret_needed, 0.0);
            self.turret_burst_cooldown.resize(turret_needed, 0.0);
            self.turret_fire_max_acquire_sq.resize(turret_needed, 0.0);
            self.turret_fire_max_release_sq.resize(turret_needed, 0.0);
            self.turret_fire_min_acquire_sq.resize(turret_needed, 0.0);
            self.turret_fire_min_release_sq.resize(turret_needed, 0.0);
            self.turret_tracking_acquire_sq.resize(turret_needed, 0.0);
            self.turret_tracking_release_sq.resize(turret_needed, 0.0);
            self.turret_outermost_acquire.resize(turret_needed, 0.0);
            self.turret_mount_offset_2d.resize(turret_needed, 0.0);
            self.turret_dps.resize(turret_needed, 0.0);
            self.turret_projectile_speed.resize(turret_needed, 0.0);
            self.turret_projectile_mass.resize(turret_needed, 0.0);
            self.turret_projectile_air_friction_per_60hz_frame
                .resize(turret_needed, 0.0);
            self.turret_arc_preference.resize(turret_needed, 0);
            self.turret_max_time_sec.resize(turret_needed, 0.0);
            self.turret_ground_aim_fraction.resize(turret_needed, 0.0);
            self.turret_under_only.resize(turret_needed, 0);
            self.turret_blueprint_code
                .resize(turret_needed, CT_BLUEPRINT_CODE_NONE);
            self.turret_los_blocked_ticks.resize(turret_needed, 0);
            self.turret_config_flags.resize(turret_needed, 0);
            self.turret_lockon_relationship_mask
                .resize(turret_needed, 0);
            self.turret_lockon_entity_family_mask
                .resize(turret_needed, 0);
            self.turret_lockon_building_mask.resize(turret_needed, 0);
            self.turret_lockon_tower_mask.resize(turret_needed, 0);
            self.turret_lockon_unit_mask.resize(turret_needed, 0);
            self.turret_lockon_turret_mask.resize(turret_needed, 0);
            self.turret_lockon_shot_mask.resize(turret_needed, 0);
            self.turret_lockon_reciprocal_mode
                .resize(turret_needed, CT_LOCK_ON_RECIPROCAL_IGNORE);
            self.turret_ballistic_has_solution.resize(turret_needed, 0);
            self.turret_ballistic_flight_time.resize(turret_needed, 0.0);
            self.turret_ballistic_launch_vx.resize(turret_needed, 0.0);
            self.turret_ballistic_launch_vy.resize(turret_needed, 0.0);
            self.turret_ballistic_launch_vz.resize(turret_needed, 0.0);
            self.turret_ballistic_yaw.resize(turret_needed, 0.0);
            self.turret_ballistic_pitch.resize(turret_needed, 0.0);
            self.turret_ballistic_aim_x.resize(turret_needed, 0.0);
            self.turret_ballistic_aim_y.resize(turret_needed, 0.0);
            self.turret_ballistic_aim_z.resize(turret_needed, 0.0);
        }
    }

    pub(crate) fn clear_all(&mut self) {
        let max_turrets = COMBAT_TARGETING_MAX_TURRETS_PER_ENTITY as usize;
        let active_len = self.active_entity_slots.len();
        for i in 0..active_len {
            let s = self.active_entity_slots[i] as usize;
            if s >= self.entity_flags.len() {
                continue;
            }
            self.entity_flags[s] = 0;
            self.entity_sensor_coverage_mask[s] = 0;
            self.entity_full_sight_coverage_mask[s] = 0;
            self.entity_detector_coverage_mask[s] = 0;
            self.entity_active_turret_mask[s] = 0;
            self.entity_firing_turret_mask[s] = 0;

            let turret_count = (self.turret_count_per_entity[s] as usize).min(max_turrets);
            self.turret_count_per_entity[s] = 0;
            let base = s * max_turrets;
            for t in 0..turret_count {
                let idx = base + t;
                if idx >= self.turret_entity_id.len() {
                    break;
                }
                self.turret_entity_id[idx] = ENTITY_META_NO_ID;
                self.turret_parent_id[idx] = ENTITY_META_NO_ID;
                self.turret_root_host_id[idx] = ENTITY_META_NO_ID;
                self.turret_mount_index[idx] = ENTITY_META_NO_INDEX;
                self.turret_committed_target_id[idx] = -1;
                self.turret_lockon_reciprocal_mode[idx] = CT_LOCK_ON_RECIPROCAL_IGNORE;
                self.turret_ballistic_has_solution[idx] = 0;
            }
        }
        self.active_entity_slots.clear();
        self.stamp_epoch = self.stamp_epoch.wrapping_add(1);
        if self.stamp_epoch == 0 {
            for epoch in self.entity_stamp_epoch.iter_mut() {
                *epoch = 0;
            }
            self.stamp_epoch = 1;
        }
        self.entity_slot_by_id.clear();
        combat_targeting_clear_observation_index(self);
    }

    pub(crate) fn unset_entity(&mut self, entity_slot: u32) {
        let s = entity_slot as usize;
        if s >= self.entity_flags.len() {
            return;
        }
        let old_entity_id = self.entity_id[s];
        if old_entity_id >= 0 {
            self.entity_slot_by_id.remove(&old_entity_id);
        }
        self.entity_flags[s] = 0;
        self.entity_sensor_coverage_mask[s] = 0;
        self.entity_full_sight_coverage_mask[s] = 0;
        self.entity_detector_coverage_mask[s] = 0;
        self.turret_count_per_entity[s] = 0;
        let base = s * (COMBAT_TARGETING_MAX_TURRETS_PER_ENTITY as usize);
        for t in 0..(COMBAT_TARGETING_MAX_TURRETS_PER_ENTITY as usize) {
            let idx = base + t;
            if idx >= self.turret_entity_id.len() {
                break;
            }
            self.turret_entity_id[idx] = ENTITY_META_NO_ID;
            self.turret_parent_id[idx] = ENTITY_META_NO_ID;
            self.turret_root_host_id[idx] = ENTITY_META_NO_ID;
            self.turret_mount_index[idx] = ENTITY_META_NO_INDEX;
            self.turret_committed_target_id[idx] = -1;
            self.turret_lockon_reciprocal_mode[idx] = CT_LOCK_ON_RECIPROCAL_IGNORE;
        }
    }
}

#[inline]
pub(crate) fn combat_targeting_turret_global_idx(entity_slot: u32, turret_idx: u32) -> usize {
    (entity_slot as usize) * (COMBAT_TARGETING_MAX_TURRETS_PER_ENTITY as usize)
        + (turret_idx as usize)
}

#[inline]
pub(crate) fn combat_targeting_write_no_ballistic_solution(
    pool: &mut CombatTargetingPool,
    idx: usize,
    mount_x: f64,
    mount_y: f64,
    mount_z: f64,
    fallback_yaw: f64,
    fallback_pitch: f64,
) {
    let yaw = if fallback_yaw.is_finite() {
        fallback_yaw
    } else {
        0.0
    };
    let pitch = if fallback_pitch.is_finite() {
        fallback_pitch
    } else {
        0.0
    };
    let cos_pitch = pitch.cos();
    pool.turret_ballistic_has_solution[idx] = 0;
    pool.turret_ballistic_flight_time[idx] = 0.0;
    pool.turret_ballistic_launch_vx[idx] = 0.0;
    pool.turret_ballistic_launch_vy[idx] = 0.0;
    pool.turret_ballistic_launch_vz[idx] = 0.0;
    pool.turret_ballistic_yaw[idx] = yaw as f32;
    pool.turret_ballistic_pitch[idx] = pitch as f32;
    pool.turret_ballistic_aim_x[idx] = mount_x + yaw.cos() * cos_pitch;
    pool.turret_ballistic_aim_y[idx] = mount_y + yaw.sin() * cos_pitch;
    pool.turret_ballistic_aim_z[idx] = mount_z + pitch.sin();
}

#[inline]
pub(crate) fn combat_targeting_write_direct_aim_solution(
    pool: &mut CombatTargetingPool,
    idx: usize,
    mount_x: f64,
    mount_y: f64,
    mount_z: f64,
    aim_x: f64,
    aim_y: f64,
    aim_z: f64,
) {
    let dx = aim_x - mount_x;
    let dy = aim_y - mount_y;
    let dz = aim_z - mount_z;
    let horizontal = (dx * dx + dy * dy).sqrt();
    let yaw = dy.atan2(dx);
    let pitch = dz.atan2(horizontal);
    pool.turret_ballistic_has_solution[idx] = 1;
    pool.turret_ballistic_flight_time[idx] = 0.0;
    pool.turret_ballistic_launch_vx[idx] = 0.0;
    pool.turret_ballistic_launch_vy[idx] = 0.0;
    pool.turret_ballistic_launch_vz[idx] = 0.0;
    pool.turret_ballistic_yaw[idx] = yaw as f32;
    pool.turret_ballistic_pitch[idx] = pitch as f32;
    pool.turret_ballistic_aim_x[idx] = aim_x;
    pool.turret_ballistic_aim_y[idx] = aim_y;
    pool.turret_ballistic_aim_z[idx] = aim_z;
}

pub(crate) struct CombatTargetingPoolHolder(UnsafeCell<Option<CombatTargetingPool>>);
unsafe impl Sync for CombatTargetingPoolHolder {}
pub(crate) static COMBAT_TARGETING: CombatTargetingPoolHolder =
    CombatTargetingPoolHolder(UnsafeCell::new(None));

#[inline]
pub(crate) fn combat_targeting_pool() -> &'static mut CombatTargetingPool {
    unsafe {
        let cell = &mut *COMBAT_TARGETING.0.get();
        if cell.is_none() {
            *cell = Some(CombatTargetingPool::empty());
        }
        cell.as_mut().unwrap()
    }
}

// AIM-08.5 — per-candidate observability scratch buffer used by the
// candidate-batch kernel. Lives outside the pool so the kernel can
// borrow the pool mutably for ballistic-solver writes while reading
// the observability mask as a separate slice. Resized in-place per
// call; never freed.
pub(crate) struct CombatTargetingScratchHolder(UnsafeCell<Vec<u8>>);
unsafe impl Sync for CombatTargetingScratchHolder {}
pub(crate) static COMBAT_TARGETING_CANDIDATE_OBSERVABLE_SCRATCH: CombatTargetingScratchHolder =
    CombatTargetingScratchHolder(UnsafeCell::new(Vec::new()));

#[inline]
pub(crate) fn combat_targeting_candidate_observable_scratch() -> &'static mut Vec<u8> {
    unsafe { &mut *COMBAT_TARGETING_CANDIDATE_OBSERVABLE_SCRATCH.0.get() }
}

pub(crate) struct CombatTargetingSlotScratchHolder(UnsafeCell<Vec<u32>>);
unsafe impl Sync for CombatTargetingSlotScratchHolder {}
pub(crate) static COMBAT_TARGETING_CANDIDATE_SLOT_SCRATCH: CombatTargetingSlotScratchHolder =
    CombatTargetingSlotScratchHolder(UnsafeCell::new(Vec::new()));

#[inline]
pub(crate) fn combat_targeting_candidate_slot_scratch() -> &'static mut Vec<u32> {
    unsafe { &mut *COMBAT_TARGETING_CANDIDATE_SLOT_SCRATCH.0.get() }
}

// AIM-08.5 — reusable candidate SoA populated directly from the WASM
// spatial grid for auto-mode targeting. This removes the transitional
// TS path that resolved spatial query slots back into Entity objects
// and then re-stamped them into parallel candidate arrays.
#[derive(Default)]
pub(crate) struct CombatTargetingSpatialCandidateScratch {
    pub(crate) ids: Vec<i32>,
    pub(crate) slots: Vec<u32>,
    pub(crate) observable: Vec<u8>,
    pub(crate) eligible_turret_mask: Vec<u32>,
    pub(crate) pos_x: Vec<f64>,
    pub(crate) pos_y: Vec<f64>,
    pub(crate) pos_z: Vec<f64>,
    pub(crate) radius: Vec<f64>,
    pub(crate) shield_panel_score: Vec<f64>,
}

impl CombatTargetingSpatialCandidateScratch {
    pub(crate) fn clear(&mut self) {
        self.ids.clear();
        self.slots.clear();
        self.observable.clear();
        self.eligible_turret_mask.clear();
        self.pos_x.clear();
        self.pos_y.clear();
        self.pos_z.clear();
        self.radius.clear();
        self.shield_panel_score.clear();
    }
}

pub(crate) struct CombatTargetingSpatialCandidateScratchHolder(
    UnsafeCell<CombatTargetingSpatialCandidateScratch>,
);
unsafe impl Sync for CombatTargetingSpatialCandidateScratchHolder {}
pub(crate) static COMBAT_TARGETING_SPATIAL_CANDIDATE_SCRATCH:
    CombatTargetingSpatialCandidateScratchHolder = CombatTargetingSpatialCandidateScratchHolder(
    UnsafeCell::new(CombatTargetingSpatialCandidateScratch {
        ids: Vec::new(),
        slots: Vec::new(),
        observable: Vec::new(),
        eligible_turret_mask: Vec::new(),
        pos_x: Vec::new(),
        pos_y: Vec::new(),
        pos_z: Vec::new(),
        radius: Vec::new(),
        shield_panel_score: Vec::new(),
    }),
);

#[inline]
pub(crate) fn combat_targeting_spatial_candidate_scratch(
) -> &'static mut CombatTargetingSpatialCandidateScratch {
    unsafe { &mut *COMBAT_TARGETING_SPATIAL_CANDIDATE_SCRATCH.0.get() }
}

#[wasm_bindgen]
pub fn combat_targeting_init(initial_entity_capacity: u32) {
    let pool = combat_targeting_pool();
    pool.ensure_entity_capacity(initial_entity_capacity);
    pool.clear_all();
}

#[wasm_bindgen]
pub fn combat_targeting_clear() {
    combat_targeting_pool().clear_all();
}

#[wasm_bindgen]
pub fn combat_targeting_set_wind(x: f64, y: f64, z: f64) {
    let pool = combat_targeting_pool();
    pool.wind_x = if x.is_finite() { x } else { 0.0 };
    pool.wind_y = if y.is_finite() { y } else { 0.0 };
    pool.wind_z = if z.is_finite() { z } else { 0.0 };
}

#[wasm_bindgen]
pub fn combat_targeting_max_turrets_per_entity() -> u32 {
    COMBAT_TARGETING_MAX_TURRETS_PER_ENTITY
}

#[wasm_bindgen]
pub fn combat_targeting_entity_capacity() -> u32 {
    combat_targeting_pool().entity_id.len() as u32
}

/// Bulk per-entity stamp. Called once per armed entity per tick by the
/// JS stamping pass. `flags` is the OR'd `CT_ENTITY_FLAG_*` bits.
/// `turret_count` advertises how many `combat_targeting_set_turret`
/// calls will follow for this slot — past the count, slots hold stale
/// data and the kernel gates on `turret_count_per_entity`.
#[wasm_bindgen]
pub fn combat_targeting_set_entity(
    entity_slot: u32,
    entity_id: i32,
    owner_player_id: u8,
    view_mask: u32,
    pos_x: f64,
    pos_y: f64,
    pos_z: f64,
    vel_x: f64,
    vel_y: f64,
    vel_z: f64,
    ground_z: f64,
    rot_cos: f64,
    rot_sin: f64,
    surface_nx: f64,
    surface_ny: f64,
    surface_nz: f64,
    suspension_offset_x: f64,
    suspension_offset_y: f64,
    suspension_offset_z: f64,
    radius_hitbox: f64,
    aabb_half_x: f64,
    aabb_half_y: f64,
    aabb_half_z: f64,
    hp: f32,
    flags: u8,
    family: u8,
    blueprint_code: u8,
    lockon_relationship_mask: u8,
    lockon_entity_family_mask: u8,
    lockon_building_mask: u32,
    lockon_tower_mask: u32,
    lockon_unit_mask: u32,
    lockon_turret_mask: u32,
    lockon_shot_mask: u32,
    full_vision_radius: f32,
    radar_radius: f32,
    detector_radius: f32,
    detection_padding: f32,
    priority_target_id: i32,
    priority_point_present: u8,
    priority_point_x: f64,
    priority_point_y: f64,
    priority_point_z: f64,
    scheduled_probe_tick: i32,
    turret_count: u8,
) {
    let pool = combat_targeting_pool();
    pool.ensure_entity_capacity(entity_slot);
    let s = entity_slot as usize;
    if pool.entity_stamp_epoch[s] != pool.stamp_epoch {
        pool.entity_stamp_epoch[s] = pool.stamp_epoch;
        pool.active_entity_slots.push(entity_slot);
    }
    let old_entity_id = pool.entity_id[s];
    if old_entity_id >= 0 && old_entity_id != entity_id {
        pool.entity_slot_by_id.remove(&old_entity_id);
    }
    // Same-entity restamps preserve the slab-owned FSM tuple in the
    // turret rows that follow; slot reuse re-seeds it (see set_turret).
    pool.entity_stamp_same_entity[s] = (old_entity_id == entity_id) as u8;
    pool.entity_id[s] = entity_id;
    if entity_id >= 0 {
        pool.entity_slot_by_id.insert(entity_id, entity_slot);
    }
    pool.entity_owner_player_id[s] = owner_player_id;
    pool.entity_owner_bit[s] = combat_targeting_player_bit(owner_player_id);
    pool.entity_view_mask[s] = view_mask;
    pool.entity_pos_x[s] = pos_x;
    pool.entity_pos_y[s] = pos_y;
    pool.entity_pos_z[s] = pos_z;
    pool.entity_vel_x[s] = vel_x;
    pool.entity_vel_y[s] = vel_y;
    pool.entity_vel_z[s] = vel_z;
    pool.entity_ground_z[s] = ground_z;
    pool.entity_rot_cos[s] = rot_cos;
    pool.entity_rot_sin[s] = rot_sin;
    pool.entity_surface_nx[s] = surface_nx;
    pool.entity_surface_ny[s] = surface_ny;
    pool.entity_surface_nz[s] = surface_nz;
    pool.entity_suspension_offset_x[s] = suspension_offset_x;
    pool.entity_suspension_offset_y[s] = suspension_offset_y;
    pool.entity_suspension_offset_z[s] = suspension_offset_z;
    pool.entity_radius_hitbox[s] = radius_hitbox;
    pool.entity_aabb_half_x[s] = aabb_half_x;
    pool.entity_aabb_half_y[s] = aabb_half_y;
    pool.entity_aabb_half_z[s] = aabb_half_z;
    pool.entity_hp[s] = hp;
    pool.entity_flags[s] = flags;
    pool.entity_family[s] = family;
    pool.entity_blueprint_code[s] = blueprint_code;
    pool.entity_lockon_relationship_mask[s] = lockon_relationship_mask;
    pool.entity_lockon_entity_family_mask[s] = lockon_entity_family_mask;
    pool.entity_lockon_building_mask[s] = lockon_building_mask;
    pool.entity_lockon_tower_mask[s] = lockon_tower_mask;
    pool.entity_lockon_unit_mask[s] = lockon_unit_mask;
    pool.entity_lockon_turret_mask[s] = lockon_turret_mask;
    pool.entity_lockon_shot_mask[s] = lockon_shot_mask;
    pool.entity_full_vision_radius[s] = full_vision_radius;
    pool.entity_radar_radius[s] = radar_radius;
    pool.entity_detector_radius[s] = detector_radius;
    pool.entity_detection_padding[s] = detection_padding;
    pool.entity_priority_target_id[s] = priority_target_id;
    pool.entity_priority_point_present[s] = priority_point_present;
    pool.entity_priority_point_x[s] = priority_point_x;
    pool.entity_priority_point_y[s] = priority_point_y;
    pool.entity_priority_point_z[s] = priority_point_z;
    pool.entity_scheduled_probe_tick[s] = scheduled_probe_tick;
    let max = COMBAT_TARGETING_MAX_TURRETS_PER_ENTITY as u8;
    pool.turret_count_per_entity[s] = if turret_count > max {
        max
    } else {
        turret_count
    };
    combat_targeting_insert_observation_index_slot(pool, s);
}

#[wasm_bindgen]
pub fn combat_targeting_unset_entity(entity_slot: u32) {
    combat_targeting_pool().unset_entity(entity_slot);
}

/// Bulk per-turret stamp. The range arguments are pre-squared authored
/// radii; targeting kernels sqrt them when applying cylinder vertical caps.
/// `outermost_acquire` is the raw (un-squared) outermost-shell acquire
/// distance — the broadphase spatial query wants a radius, not a
/// squared radius, so storing it lets the kernel avoid sqrt.
/// `mount_offset_2d` is the raw local XY distance from host origin to
/// turret mount, matching the TypeScript pre-scan's `hypot(mount.x,
/// mount.y)` broadphase padding.
/// Ballistic gate config is static per turret blueprint and is stamped
/// here so targeting kernels do not need per-entity JS config arrays.
///
/// The slab-owned FSM tuple — state, target, committed target, cooldown,
/// burst cooldown, losBlockedTicks — is NOT an input. When the slot still
/// holds the same entity it held last stamp (per set_entity's reuse flag)
/// those columns are left exactly as the kernels and direct slab writers
/// left them; on slot reuse they are seeded to the fresh-turret constants
/// (idle, no target, zero cooldowns). The committed target re-seeds from
/// the surviving target each stamp because clear_all drops it.
#[wasm_bindgen]
pub fn combat_targeting_set_turret(
    entity_slot: u32,
    turret_idx: u32,
    turret_entity_id: i32,
    turret_parent_id: i32,
    turret_root_host_id: i32,
    turret_mount_index: i32,
    mount_x: f64,
    mount_y: f64,
    mount_z: f64,
    radius_hitbox: f64,
    mount_vx: f64,
    mount_vy: f64,
    mount_vz: f64,
    rotation: f32,
    pitch: f32,
    angular_velocity: f32,
    pitch_velocity: f32,
    fire_max_acquire_sq: f64,
    fire_max_release_sq: f64,
    fire_min_acquire_sq: f64,
    fire_min_release_sq: f64,
    tracking_acquire_sq: f64,
    tracking_release_sq: f64,
    outermost_acquire: f64,
    mount_offset_2d: f64,
    local_mount_x: f64,
    local_mount_y: f64,
    local_mount_z: f64,
    world_pos_tick: i32,
    config_flags: u32,
    dps: f32,
    projectile_speed: f64,
    projectile_mass: f64,
    projectile_air_friction_per_60hz_frame: f64,
    arc_preference: u8,
    max_time_sec: f64,
    ground_aim_fraction: f64,
    under_only: u8,
    turret_blueprint_code: u8,
    lockon_relationship_mask: u8,
    lockon_entity_family_mask: u8,
    lockon_building_mask: u32,
    lockon_tower_mask: u32,
    lockon_unit_mask: u32,
    lockon_turret_mask: u32,
    lockon_shot_mask: u32,
    lockon_reciprocal_mode: u8,
) {
    let pool = combat_targeting_pool();
    pool.ensure_entity_capacity(entity_slot);
    debug_assert!(turret_idx < COMBAT_TARGETING_MAX_TURRETS_PER_ENTITY);
    let global_idx = combat_targeting_turret_global_idx(entity_slot, turret_idx);
    pool.turret_entity_id[global_idx] = turret_entity_id;
    pool.turret_parent_id[global_idx] = turret_parent_id;
    pool.turret_root_host_id[global_idx] = turret_root_host_id;
    pool.turret_mount_index[global_idx] = turret_mount_index;
    pool.turret_mount_x[global_idx] = mount_x;
    pool.turret_mount_y[global_idx] = mount_y;
    pool.turret_mount_z[global_idx] = mount_z;
    pool.turret_radius_hitbox[global_idx] = radius_hitbox.max(0.0);
    pool.turret_mount_vx[global_idx] = mount_vx;
    pool.turret_mount_vy[global_idx] = mount_vy;
    pool.turret_mount_vz[global_idx] = mount_vz;
    pool.turret_rotation[global_idx] = rotation;
    pool.turret_pitch[global_idx] = pitch;
    pool.turret_angular_velocity[global_idx] = angular_velocity;
    pool.turret_pitch_velocity[global_idx] = pitch_velocity;
    if pool.entity_stamp_same_entity[entity_slot as usize] != 0 {
        // Same entity in this slot: state, target, cooldowns, and
        // losBlockedTicks survive untouched (clear_all never resets
        // them; kernels and direct slab writers own their evolution).
        // committed_target_id was dropped by clear_all, so re-seed it
        // from the surviving target for the reciprocal lock-on read.
        pool.turret_committed_target_id[global_idx] = pool.turret_target_id[global_idx];
    } else {
        // Slot reuse: a newly stamped turret starts idle, untargeted,
        // and off cooldown.
        pool.turret_state[global_idx] = CT_TURRET_STATE_IDLE;
        pool.turret_target_id[global_idx] = -1;
        pool.turret_committed_target_id[global_idx] = -1;
        pool.turret_cooldown[global_idx] = 0.0;
        pool.turret_burst_cooldown[global_idx] = 0.0;
        pool.turret_los_blocked_ticks[global_idx] = 0;
    }
    pool.turret_fire_max_acquire_sq[global_idx] = fire_max_acquire_sq;
    pool.turret_fire_max_release_sq[global_idx] = fire_max_release_sq;
    pool.turret_fire_min_acquire_sq[global_idx] = fire_min_acquire_sq;
    pool.turret_fire_min_release_sq[global_idx] = fire_min_release_sq;
    pool.turret_tracking_acquire_sq[global_idx] = tracking_acquire_sq;
    pool.turret_tracking_release_sq[global_idx] = tracking_release_sq;
    pool.turret_outermost_acquire[global_idx] = outermost_acquire;
    pool.turret_mount_offset_2d[global_idx] = mount_offset_2d;
    pool.turret_local_mount_x[global_idx] = local_mount_x;
    pool.turret_local_mount_y[global_idx] = local_mount_y;
    pool.turret_local_mount_z[global_idx] = local_mount_z;
    pool.turret_world_pos_tick[global_idx] = world_pos_tick;
    pool.turret_config_flags[global_idx] = config_flags;
    pool.turret_dps[global_idx] = dps;
    pool.turret_projectile_speed[global_idx] = projectile_speed;
    pool.turret_projectile_mass[global_idx] = projectile_mass;
    pool.turret_projectile_air_friction_per_60hz_frame[global_idx] =
        projectile_air_friction_per_60hz_frame;
    pool.turret_arc_preference[global_idx] = arc_preference;
    pool.turret_max_time_sec[global_idx] = max_time_sec;
    pool.turret_ground_aim_fraction[global_idx] = ground_aim_fraction;
    pool.turret_under_only[global_idx] = under_only;
    pool.turret_blueprint_code[global_idx] = turret_blueprint_code;
    pool.turret_lockon_relationship_mask[global_idx] = lockon_relationship_mask;
    pool.turret_lockon_entity_family_mask[global_idx] = lockon_entity_family_mask;
    pool.turret_lockon_building_mask[global_idx] = lockon_building_mask;
    pool.turret_lockon_tower_mask[global_idx] = lockon_tower_mask;
    pool.turret_lockon_unit_mask[global_idx] = lockon_unit_mask;
    pool.turret_lockon_turret_mask[global_idx] = lockon_turret_mask;
    pool.turret_lockon_shot_mask[global_idx] = lockon_shot_mask;
    pool.turret_lockon_reciprocal_mode[global_idx] = match lockon_reciprocal_mode {
        CT_LOCK_ON_RECIPROCAL_REQUIRE
        | CT_LOCK_ON_RECIPROCAL_PREFER_REACQUIRE
        | CT_LOCK_ON_RECIPROCAL_PREFER_HOLD => lockon_reciprocal_mode,
        _ => CT_LOCK_ON_RECIPROCAL_IGNORE,
    };
    combat_targeting_write_no_ballistic_solution(
        pool,
        global_idx,
        mount_x,
        mount_y,
        mount_z,
        rotation as f64,
        pitch as f64,
    );
}

#[inline]
pub(crate) fn combat_targeting_apply_surface_tilt(
    vx: f64,
    vy: f64,
    vz: f64,
    nx: f64,
    ny: f64,
    nz: f64,
) -> (f64, f64, f64) {
    let sin_t2 = nx * nx + ny * ny;
    if sin_t2 < 1e-12 {
        return (vx, vy, vz);
    }
    let sin_t = sin_t2.sqrt();
    let cos_t = nz;
    let kx = -ny / sin_t;
    let ky = nx / sin_t;
    let kdotv = kx * vx + ky * vy;
    let cross_x = ky * vz;
    let cross_y = -kx * vz;
    let cross_z = kx * vy - ky * vx;
    let one_minus_cos = 1.0 - cos_t;
    (
        vx * cos_t + cross_x * sin_t + kx * kdotv * one_minus_cos,
        vy * cos_t + cross_y * sin_t + ky * kdotv * one_minus_cos,
        vz * cos_t + cross_z * sin_t,
    )
}

#[inline]
pub(crate) fn combat_targeting_world_mount(
    unit_x: f64,
    unit_y: f64,
    unit_ground_z: f64,
    cos: f64,
    sin: f64,
    offset_x: f64,
    offset_y: f64,
    mount_height: f64,
    surface_nx: f64,
    surface_ny: f64,
    surface_nz: f64,
) -> (f64, f64, f64) {
    let yawed_x = cos * offset_x - sin * offset_y;
    let yawed_y = sin * offset_x + cos * offset_y;
    let (tilted_x, tilted_y, tilted_z) = combat_targeting_apply_surface_tilt(
        yawed_x,
        yawed_y,
        mount_height,
        surface_nx,
        surface_ny,
        surface_nz,
    );
    (
        unit_x + tilted_x,
        unit_y + tilted_y,
        unit_ground_z + tilted_z,
    )
}

/// AIM-08.5 Pass 0 — compute current per-turret world mount
/// kinematics inside the combat-targeting slab. This ports the
/// targetingSystem.ts updateWeaponWorldKinematics loop to Rust while
/// JS still owns the outer armed-entity traversal and writes the slab
/// result back to Turret objects for turret rotation / firing.
#[wasm_bindgen]
pub fn combat_targeting_update_mount_kinematics(
    entity_slot: u32,
    current_tick: i32,
    dt_ms: f64,
    turret_shield_panels_enabled: u8,
    turret_shield_spheres_enabled: u8,
) {
    let pool = combat_targeting_pool();
    let s = entity_slot as usize;
    if s >= pool.turret_count_per_entity.len() {
        return;
    }
    let turret_count = pool.turret_count_per_entity[s] as usize;
    if turret_count == 0 {
        return;
    }

    let unit_x = pool.entity_pos_x[s];
    let unit_y = pool.entity_pos_y[s];
    let unit_ground_z = pool.entity_ground_z[s];
    let cos = pool.entity_rot_cos[s];
    let sin = pool.entity_rot_sin[s];
    let surface_nx = pool.entity_surface_nx[s];
    let surface_ny = pool.entity_surface_ny[s];
    let surface_nz = pool.entity_surface_nz[s];
    let suspension_x = pool.entity_suspension_offset_x[s];
    let suspension_y = pool.entity_suspension_offset_y[s];
    let suspension_z = pool.entity_suspension_offset_z[s];
    let inv_elapsed_sec = if dt_ms > 0.0 { 1000.0 / dt_ms } else { 0.0 };

    for turret_idx in 0..turret_count {
        let idx = combat_targeting_turret_global_idx(entity_slot, turret_idx as u32);
        let flags = pool.turret_config_flags[idx];
        if combat_targeting_weapon_system_disabled(
            pool,
            idx,
            turret_shield_panels_enabled,
            turret_shield_spheres_enabled,
        ) {
            continue;
        }
        if (flags & CT_TURRET_CFG_IS_MANUAL_FIRE) != 0 {
            pool.turret_state[idx] = CT_TURRET_STATE_IDLE;
        }
        if pool.turret_world_pos_tick[idx] == current_tick {
            continue;
        }

        let prev_x = pool.turret_mount_x[idx];
        let prev_y = pool.turret_mount_y[idx];
        let prev_z = pool.turret_mount_z[idx];
        let prev_tick = pool.turret_world_pos_tick[idx];
        let local_x = pool.turret_local_mount_x[idx] + suspension_x;
        let local_y = pool.turret_local_mount_y[idx] + suspension_y;
        let local_z = pool.turret_local_mount_z[idx] + suspension_z;
        let (mount_x, mount_y, mount_z) = combat_targeting_world_mount(
            unit_x,
            unit_y,
            unit_ground_z,
            cos,
            sin,
            local_x,
            local_y,
            local_z,
            surface_nx,
            surface_ny,
            surface_nz,
        );

        if prev_tick >= 0 && current_tick - prev_tick == 1 && inv_elapsed_sec > 0.0 {
            pool.turret_mount_vx[idx] = (mount_x - prev_x) * inv_elapsed_sec;
            pool.turret_mount_vy[idx] = (mount_y - prev_y) * inv_elapsed_sec;
            pool.turret_mount_vz[idx] = (mount_z - prev_z) * inv_elapsed_sec;
        } else {
            pool.turret_mount_vx[idx] = pool.entity_vel_x[s];
            pool.turret_mount_vy[idx] = pool.entity_vel_y[s];
            pool.turret_mount_vz[idx] = pool.entity_vel_z[s];
        }
        pool.turret_mount_x[idx] = mount_x;
        pool.turret_mount_y[idx] = mount_y;
        pool.turret_mount_z[idx] = mount_z;
        pool.turret_world_pos_tick[idx] = current_tick;
    }
}

/// AIM-08.5 — batch the Pass 0 mount-kinematics step across a run of
/// armed entities. This keeps the same per-entity kernel as the
/// reference path while removing one JS/WASM boundary crossing per
/// auto-mode entity in the TypeScript orchestration.
#[wasm_bindgen]
pub fn combat_targeting_update_mount_kinematics_batch(
    entity_slots: &[u32],
    current_tick: i32,
    dt_ms: f64,
    turret_shield_panels_enabled: u8,
    turret_shield_spheres_enabled: u8,
) {
    for &entity_slot in entity_slots {
        combat_targeting_update_mount_kinematics(
            entity_slot,
            current_tick,
            dt_ms,
            turret_shield_panels_enabled,
            turret_shield_spheres_enabled,
        );
    }
}

#[wasm_bindgen]
pub fn combat_targeting_entity_flags(entity_slot: u32) -> u8 {
    let pool = combat_targeting_pool();
    let s = entity_slot as usize;
    if s >= pool.entity_flags.len() {
        return 0;
    }
    pool.entity_flags[s]
}

#[wasm_bindgen]
pub fn combat_targeting_turret_count(entity_slot: u32) -> u8 {
    let pool = combat_targeting_pool();
    let s = entity_slot as usize;
    if s >= pool.turret_count_per_entity.len() {
        return 0;
    }
    pool.turret_count_per_entity[s]
}

/// AIM-08.5 — JS-callable wrapper around the internal observability
/// helper. Returns 1 when `viewer_player_id` can observe the entity
/// addressed by `target_id` (alive + (own-team OR covered by the
/// viewer's sight/radar)), 0 otherwise. Used by the priority-target
/// path to fall through to auto-targeting when the command target is
/// dead or has slipped out of vision.
#[wasm_bindgen]
pub fn combat_targeting_can_player_observe_entity(target_id: i32, viewer_player_id: u8) -> u8 {
    let pool = combat_targeting_pool();
    if combat_targeting_player_observes_entity_id(pool, target_id, viewer_player_id) {
        1
    } else {
        0
    }
}

#[inline]
fn combat_targeting_player_mask_includes_owner(view_mask: u32, owner_player_id: u32) -> bool {
    (1..=32).contains(&owner_player_id) && (view_mask & (1_u32 << (owner_player_id - 1))) != 0
}

#[inline]
fn combat_targeting_entity_state_kind_is_observable(kind: u8) -> bool {
    kind == crate::entity_state::ENTITY_STATE_KIND_UNIT
        || kind == crate::entity_state::ENTITY_STATE_KIND_BUILDING
        || kind == crate::entity_state::ENTITY_STATE_KIND_TOWER
}

/// Snapshot-visibility bridge over the targeting observation masks.
///
/// JS still owns terrain/material LOS, so rows covered by full-sight sources
/// are returned as slots in `los_slots_out`. Owned and detector-visible
/// cloaked rows can be materialized immediately as visible ids, while radar
/// contacts are returned as ids for the minimap/radar serializer.
///
/// `counts_out` receives [handled_rows, visible_count, radar_count, los_count].
/// A negative return means one of the output buffers was too small; its
/// absolute value is the required row capacity.
#[wasm_bindgen]
pub fn combat_targeting_collect_observation_visibility(
    view_mask: u32,
    target_slots: &[u32],
    visible_ids_out: &mut [i32],
    visible_slots_out: &mut [u32],
    radar_ids_out: &mut [i32],
    radar_slots_out: &mut [u32],
    los_slots_out: &mut [u32],
    counts_out: &mut [u32],
) -> i32 {
    if counts_out.len() < 4 || view_mask == 0 {
        return 0;
    }

    let pool = combat_targeting_pool();
    let state = crate::entity_state::entity_state();
    let capacity = pool
        .entity_id
        .len()
        .min(pool.entity_flags.len())
        .min(pool.entity_sensor_coverage_mask.len())
        .min(pool.entity_full_sight_coverage_mask.len())
        .min(pool.entity_detector_coverage_mask.len())
        .min(state.entity_id.len())
        .min(state.kind.len())
        .min(state.owner_player_id.len());

    let mut handled_rows = 0_usize;
    let mut visible_count = 0_usize;
    let mut radar_count = 0_usize;
    let mut los_count = 0_usize;

    let mut collect_slot = |slot: usize| {
        if slot >= capacity {
            return;
        }

        let id = state.entity_id[slot];
        if id < 0 || pool.entity_id[slot] != id {
            return;
        }

        let kind = state.kind[slot];
        if !combat_targeting_entity_state_kind_is_observable(kind) {
            return;
        }

        handled_rows += 1;
        if combat_targeting_player_mask_includes_owner(view_mask, state.owner_player_id[slot]) {
            if visible_count < visible_ids_out.len() {
                visible_ids_out[visible_count] = id;
            }
            if visible_count < visible_slots_out.len() {
                visible_slots_out[visible_count] = slot as u32;
            }
            visible_count += 1;
            if radar_count < radar_ids_out.len() {
                radar_ids_out[radar_count] = id;
            }
            if radar_count < radar_slots_out.len() {
                radar_slots_out[radar_count] = slot as u32;
            }
            radar_count += 1;
            return;
        }

        let flags = pool.entity_flags[slot];
        if (flags & CT_ENTITY_FLAG_ALIVE) == 0 {
            return;
        }

        let detector_covered = (pool.entity_detector_coverage_mask[slot] & view_mask) != 0;
        if (flags & CT_ENTITY_FLAG_CLOAKED) != 0 {
            if detector_covered {
                if visible_count < visible_ids_out.len() {
                    visible_ids_out[visible_count] = id;
                }
                if visible_count < visible_slots_out.len() {
                    visible_slots_out[visible_count] = slot as u32;
                }
                visible_count += 1;
                if radar_count < radar_ids_out.len() {
                    radar_ids_out[radar_count] = id;
                }
                if radar_count < radar_slots_out.len() {
                    radar_slots_out[radar_count] = slot as u32;
                }
                radar_count += 1;
            }
            return;
        }

        let full_sight_covered = (pool.entity_full_sight_coverage_mask[slot] & view_mask) != 0;
        let radar_covered =
            (pool.entity_sensor_coverage_mask[slot] & view_mask) != 0 || full_sight_covered;
        if full_sight_covered {
            if los_count < los_slots_out.len() {
                los_slots_out[los_count] = slot as u32;
            }
            los_count += 1;
        }
        if radar_covered || detector_covered {
            if radar_count < radar_ids_out.len() {
                radar_ids_out[radar_count] = id;
            }
            if radar_count < radar_slots_out.len() {
                radar_slots_out[radar_count] = slot as u32;
            }
            radar_count += 1;
        }
    };

    if target_slots.is_empty() {
        for slot in 0..capacity {
            collect_slot(slot);
        }
    } else {
        for &slot in target_slots {
            collect_slot(slot as usize);
        }
    }

    counts_out[0] = handled_rows as u32;
    counts_out[1] = visible_count as u32;
    counts_out[2] = radar_count as u32;
    counts_out[3] = los_count as u32;

    let required = visible_count.max(radar_count).max(los_count);
    if visible_count > visible_ids_out.len()
        || visible_count > visible_slots_out.len()
        || radar_count > radar_ids_out.len()
        || radar_count > radar_slots_out.len()
        || los_count > los_slots_out.len()
    {
        return -(required as i32);
    }

    handled_rows as i32
}

macro_rules! combat_targeting_ptr_export {
    ($name:ident, $field:ident, $ty:ty) => {
        #[wasm_bindgen]
        pub fn $name() -> *const $ty {
            combat_targeting_pool().$field.as_ptr()
        }
    };
}

combat_targeting_ptr_export!(combat_targeting_entity_id_ptr, entity_id, i32);
combat_targeting_ptr_export!(
    combat_targeting_entity_owner_player_id_ptr,
    entity_owner_player_id,
    u8
);
combat_targeting_ptr_export!(combat_targeting_entity_pos_x_ptr, entity_pos_x, f64);
combat_targeting_ptr_export!(combat_targeting_entity_pos_y_ptr, entity_pos_y, f64);
combat_targeting_ptr_export!(combat_targeting_entity_pos_z_ptr, entity_pos_z, f64);
combat_targeting_ptr_export!(combat_targeting_entity_vel_x_ptr, entity_vel_x, f64);
combat_targeting_ptr_export!(combat_targeting_entity_vel_y_ptr, entity_vel_y, f64);
combat_targeting_ptr_export!(combat_targeting_entity_vel_z_ptr, entity_vel_z, f64);
combat_targeting_ptr_export!(
    combat_targeting_entity_radius_hitbox_ptr,
    entity_radius_hitbox,
    f64
);
combat_targeting_ptr_export!(
    combat_targeting_entity_aabb_half_x_ptr,
    entity_aabb_half_x,
    f64
);
combat_targeting_ptr_export!(
    combat_targeting_entity_aabb_half_y_ptr,
    entity_aabb_half_y,
    f64
);
combat_targeting_ptr_export!(
    combat_targeting_entity_aabb_half_z_ptr,
    entity_aabb_half_z,
    f64
);
combat_targeting_ptr_export!(combat_targeting_entity_hp_ptr, entity_hp, f32);
combat_targeting_ptr_export!(combat_targeting_entity_flags_ptr, entity_flags, u8);
combat_targeting_ptr_export!(
    combat_targeting_entity_active_turret_mask_ptr,
    entity_active_turret_mask,
    u32
);
combat_targeting_ptr_export!(
    combat_targeting_entity_firing_turret_mask_ptr,
    entity_firing_turret_mask,
    u32
);
combat_targeting_ptr_export!(
    combat_targeting_entity_sensor_coverage_mask_ptr,
    entity_sensor_coverage_mask,
    u32
);
combat_targeting_ptr_export!(
    combat_targeting_entity_full_sight_coverage_mask_ptr,
    entity_full_sight_coverage_mask,
    u32
);
combat_targeting_ptr_export!(
    combat_targeting_entity_detector_coverage_mask_ptr,
    entity_detector_coverage_mask,
    u32
);
combat_targeting_ptr_export!(
    combat_targeting_turret_count_per_entity_ptr,
    turret_count_per_entity,
    u8
);
combat_targeting_ptr_export!(combat_targeting_turret_entity_id_ptr, turret_entity_id, i32);
combat_targeting_ptr_export!(combat_targeting_turret_parent_id_ptr, turret_parent_id, i32);
combat_targeting_ptr_export!(
    combat_targeting_turret_root_host_id_ptr,
    turret_root_host_id,
    i32
);
combat_targeting_ptr_export!(
    combat_targeting_turret_mount_index_ptr,
    turret_mount_index,
    i32
);
combat_targeting_ptr_export!(combat_targeting_turret_mount_x_ptr, turret_mount_x, f64);
combat_targeting_ptr_export!(combat_targeting_turret_mount_y_ptr, turret_mount_y, f64);
combat_targeting_ptr_export!(combat_targeting_turret_mount_z_ptr, turret_mount_z, f64);
combat_targeting_ptr_export!(combat_targeting_turret_mount_vx_ptr, turret_mount_vx, f64);
combat_targeting_ptr_export!(combat_targeting_turret_mount_vy_ptr, turret_mount_vy, f64);
combat_targeting_ptr_export!(combat_targeting_turret_mount_vz_ptr, turret_mount_vz, f64);
combat_targeting_ptr_export!(
    combat_targeting_turret_world_pos_tick_ptr,
    turret_world_pos_tick,
    i32
);
combat_targeting_ptr_export!(combat_targeting_turret_rotation_ptr, turret_rotation, f32);
combat_targeting_ptr_export!(combat_targeting_turret_pitch_ptr, turret_pitch, f32);
combat_targeting_ptr_export!(
    combat_targeting_turret_angular_velocity_ptr,
    turret_angular_velocity,
    f32
);
combat_targeting_ptr_export!(
    combat_targeting_turret_pitch_velocity_ptr,
    turret_pitch_velocity,
    f32
);
combat_targeting_ptr_export!(combat_targeting_turret_state_ptr, turret_state, u8);
combat_targeting_ptr_export!(combat_targeting_turret_target_id_ptr, turret_target_id, i32);
combat_targeting_ptr_export!(combat_targeting_turret_cooldown_ptr, turret_cooldown, f64);
combat_targeting_ptr_export!(
    combat_targeting_turret_burst_cooldown_ptr,
    turret_burst_cooldown,
    f64
);
combat_targeting_ptr_export!(
    combat_targeting_turret_fire_max_acquire_sq_ptr,
    turret_fire_max_acquire_sq,
    f64
);
combat_targeting_ptr_export!(
    combat_targeting_turret_fire_max_release_sq_ptr,
    turret_fire_max_release_sq,
    f64
);
combat_targeting_ptr_export!(
    combat_targeting_turret_fire_min_acquire_sq_ptr,
    turret_fire_min_acquire_sq,
    f64
);
combat_targeting_ptr_export!(
    combat_targeting_turret_fire_min_release_sq_ptr,
    turret_fire_min_release_sq,
    f64
);
combat_targeting_ptr_export!(
    combat_targeting_turret_tracking_acquire_sq_ptr,
    turret_tracking_acquire_sq,
    f64
);
combat_targeting_ptr_export!(
    combat_targeting_turret_tracking_release_sq_ptr,
    turret_tracking_release_sq,
    f64
);
combat_targeting_ptr_export!(
    combat_targeting_turret_outermost_acquire_ptr,
    turret_outermost_acquire,
    f64
);
combat_targeting_ptr_export!(
    combat_targeting_turret_los_blocked_ticks_ptr,
    turret_los_blocked_ticks,
    u16
);
combat_targeting_ptr_export!(
    combat_targeting_turret_config_flags_ptr,
    turret_config_flags,
    u32
);
combat_targeting_ptr_export!(
    combat_targeting_turret_ballistic_has_solution_ptr,
    turret_ballistic_has_solution,
    u8
);
combat_targeting_ptr_export!(
    combat_targeting_turret_ballistic_flight_time_ptr,
    turret_ballistic_flight_time,
    f64
);
combat_targeting_ptr_export!(
    combat_targeting_turret_ballistic_launch_vx_ptr,
    turret_ballistic_launch_vx,
    f64
);
combat_targeting_ptr_export!(
    combat_targeting_turret_ballistic_launch_vy_ptr,
    turret_ballistic_launch_vy,
    f64
);
combat_targeting_ptr_export!(
    combat_targeting_turret_ballistic_launch_vz_ptr,
    turret_ballistic_launch_vz,
    f64
);
combat_targeting_ptr_export!(
    combat_targeting_turret_ballistic_yaw_ptr,
    turret_ballistic_yaw,
    f32
);
combat_targeting_ptr_export!(
    combat_targeting_turret_ballistic_pitch_ptr,
    turret_ballistic_pitch,
    f32
);
combat_targeting_ptr_export!(
    combat_targeting_turret_ballistic_aim_x_ptr,
    turret_ballistic_aim_x,
    f64
);
combat_targeting_ptr_export!(
    combat_targeting_turret_ballistic_aim_y_ptr,
    turret_ballistic_aim_y,
    f64
);
combat_targeting_ptr_export!(
    combat_targeting_turret_ballistic_aim_z_ptr,
    turret_ballistic_aim_z,
    f64
);

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

#[inline]
pub(crate) fn combat_targeting_mark_observed_slot(
    target_slot: usize,
    entity_owner_bit: &[u32],
    entity_pos_x: &[f64],
    entity_pos_y: &[f64],
    entity_detection_padding: &[f32],
    coverage_mask: &mut [u32],
    source_x: f64,
    source_y: f64,
    radius: f64,
    owner_bit: u32,
) {
    let target_owner_bit = entity_owner_bit[target_slot];
    if target_owner_bit == owner_bit {
        return;
    }
    if (coverage_mask[target_slot] & owner_bit) != 0 {
        return;
    }
    let padding = entity_detection_padding[target_slot] as f64;
    let r = radius + padding;
    if r <= 0.0 || !r.is_finite() {
        return;
    }
    let dx = entity_pos_x[target_slot] - source_x;
    let dy = entity_pos_y[target_slot] - source_y;
    if dx * dx + dy * dy > r * r {
        return;
    }
    coverage_mask[target_slot] |= owner_bit;
}

#[inline]
pub(crate) fn combat_targeting_mark_observation_cell(
    cell: &CombatTargetingObservationCell,
    entity_owner_bit: &[u32],
    entity_pos_x: &[f64],
    entity_pos_y: &[f64],
    entity_detection_padding: &[f32],
    coverage_mask: &mut [u32],
    source_x: f64,
    source_y: f64,
    radius: f64,
    owner_bit: u32,
) {
    if cell.owner_bits != 0 && (cell.owner_bits & !owner_bit) == 0 {
        return;
    }
    for &slot in &cell.slots {
        combat_targeting_mark_observed_slot(
            slot as usize,
            entity_owner_bit,
            entity_pos_x,
            entity_pos_y,
            entity_detection_padding,
            coverage_mask,
            source_x,
            source_y,
            radius,
            owner_bit,
        );
    }
}

// Observation mask selector for combat_targeting_mark_observation_circle.
pub(crate) const CT_OBSERVATION_MASK_SENSOR: u8 = 0;
pub(crate) const CT_OBSERVATION_MASK_DETECTOR: u8 = 1;
pub(crate) const CT_OBSERVATION_MASK_FULL_SIGHT: u8 = 2;

pub(crate) fn combat_targeting_mark_observation_circle(
    pool: &mut CombatTargetingPool,
    source_x: f64,
    source_y: f64,
    radius: f64,
    owner_bit: u32,
    mask_kind: u8,
) {
    if owner_bit == 0 || !source_x.is_finite() || !source_y.is_finite() || !radius.is_finite() {
        return;
    }
    if radius <= 0.0 {
        return;
    }

    let query_radius = radius
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
    let entity_detection_padding = &pool.entity_detection_padding;
    let observation_cells = &pool.observation_cells;
    let observation_cell_keys = &pool.observation_cell_keys;
    let coverage_mask = match mask_kind {
        CT_OBSERVATION_MASK_DETECTOR => &mut pool.entity_detector_coverage_mask,
        CT_OBSERVATION_MASK_FULL_SIGHT => &mut pool.entity_full_sight_coverage_mask,
        _ => &mut pool.entity_sensor_coverage_mask,
    };
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
            let Some(cell) = observation_cells.get(&key) else {
                continue;
            };
            combat_targeting_mark_observation_cell(
                cell,
                entity_owner_bit,
                entity_pos_x,
                entity_pos_y,
                entity_detection_padding,
                coverage_mask,
                source_x,
                source_y,
                radius,
                owner_bit,
            );
        }
        return;
    }
    for cx in min_cx..=max_cx {
        for cy in min_cy..=max_cy {
            let key = combat_targeting_observation_cell_key(cx, cy);
            let cell = match observation_cells.get(&key) {
                Some(cell) => cell,
                None => continue,
            };
            combat_targeting_mark_observation_cell(
                cell,
                entity_owner_bit,
                entity_pos_x,
                entity_pos_y,
                entity_detection_padding,
                coverage_mask,
                source_x,
                source_y,
                radius,
                owner_bit,
            );
        }
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
    let source_x = pool.entity_pos_x[source_slot];
    let source_y = pool.entity_pos_y[source_slot];

    let full_radius = pool.entity_full_vision_radius[source_slot] as f64;
    let radar_radius = pool.entity_radar_radius[source_slot] as f64;
    let detector_radius = pool.entity_detector_radius[source_slot] as f64;
    let sensor_radius = if full_radius > radar_radius {
        full_radius
    } else {
        radar_radius
    };
    if sensor_radius > 0.0 {
        combat_targeting_mark_observation_circle(
            pool,
            source_x,
            source_y,
            sensor_radius,
            owner_bit,
            CT_OBSERVATION_MASK_SENSOR,
        );
    }
    // Full-sight sources additionally seed the full-sight-only mask (radar
    // sources do not). Full sight already supplies radar-level location via
    // the merged sensor mask above, so this is a strict subset.
    if full_radius > 0.0 {
        combat_targeting_mark_observation_circle(
            pool,
            source_x,
            source_y,
            full_radius,
            owner_bit,
            CT_OBSERVATION_MASK_FULL_SIGHT,
        );
    }
    if detector_radius > 0.0 {
        combat_targeting_mark_observation_circle(
            pool,
            source_x,
            source_y,
            detector_radius,
            owner_bit,
            CT_OBSERVATION_MASK_DETECTOR,
        );
    }
}

/// Rebuilds per-target radar-level coverage masks from stamped sensor
/// sources using the spatial grid. This is the hot-path
/// targeting equivalent of the snapshot visibility aggregate: do the
/// source-radius work once per tick, then every turret candidate can
/// test observability with a bitmask instead of scanning all units.
#[wasm_bindgen]
pub fn combat_targeting_rebuild_observation_masks() {
    let pool = combat_targeting_pool();
    for mask in pool.entity_sensor_coverage_mask.iter_mut() {
        *mask = 0;
    }
    for mask in pool.entity_full_sight_coverage_mask.iter_mut() {
        *mask = 0;
    }
    for mask in pool.entity_detector_coverage_mask.iter_mut() {
        *mask = 0;
    }

    combat_targeting_rebuild_observation_index(pool);
    let n = pool.entity_flags.len();
    for source_slot in 0..n {
        combat_targeting_mark_observation_from_source_slot(pool, source_slot);
    }
}

/// Hot-path variant used by JS stamping: entity/turret rows have just
/// been cleared and stamped, and JS has compacted the actual sensor source
/// slots while walking live entities. This avoids scanning the whole slot
/// capacity, which can include projectile-created high-water slots.
#[wasm_bindgen]
pub fn combat_targeting_rebuild_observation_masks_for_sources(source_slots: &[u32]) {
    let pool = combat_targeting_pool();
    for &source_slot in source_slots {
        combat_targeting_mark_observation_from_source_slot(pool, source_slot as usize);
    }
}

/// Adds a temporary full-sight source such as a scan pulse after the
/// entity-source masks have been rebuilt. Full sight is radar-level
/// coverage for targeting, so this marks the same aggregate mask used
/// by radar and normal sight sources.
#[wasm_bindgen]
pub fn combat_targeting_add_sensor_observation_circle(
    owner_player_id: u8,
    x: f64,
    y: f64,
    radius: f64,
) {
    let owner_bit = combat_targeting_player_bit(owner_player_id);
    let pool = combat_targeting_pool();
    // A scan pulse is a full-sight source: it reveals identity in its area, so
    // it seeds the merged sensor mask (radar-level), the full-sight-only mask,
    // and the detector mask.
    combat_targeting_mark_observation_circle(
        pool,
        x,
        y,
        radius,
        owner_bit,
        CT_OBSERVATION_MASK_SENSOR,
    );
    combat_targeting_mark_observation_circle(
        pool,
        x,
        y,
        radius,
        owner_bit,
        CT_OBSERVATION_MASK_FULL_SIGHT,
    );
    combat_targeting_mark_observation_circle(
        pool,
        x,
        y,
        radius,
        owner_bit,
        CT_OBSERVATION_MASK_DETECTOR,
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

/// Targeting observability for one recipient/team view. Radar-level
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
    if source_entity_slot >= pool.entity_owner_player_id.len()
        || target_entity_slot >= pool.entity_owner_player_id.len()
    {
        return false;
    }
    let source_owner = pool.entity_owner_player_id[source_entity_slot];
    let target_owner = pool.entity_owner_player_id[target_entity_slot];
    let relationship = if source_owner == target_owner {
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
            || (flags & CT_TURRET_CFG_VISUAL_ONLY) != 0
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
    pool.entity_slot_by_id
        .get(&pool.turret_target_id[source_turret_idx])
        .map(|slot| {
            !combat_targeting_target_slot_locked_onto_source(
                pool,
                source_entity_slot,
                source_entity_id,
                source_turret_idx,
                *slot as usize,
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
    let source_owner = pool.entity_owner_player_id[source_entity_slot];
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
                // "My team" is same-owner — the kernel's notion of friendly,
                // and the spawn case (host + the fabricator that made it share
                // a player).
                if pool.entity_owner_player_id[slot] != source_owner {
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

    let base_allowed = if combat_targeting_turret_lockon_allows_body_entity(
        pool,
        source_turret_idx,
        target_entity_slot,
    ) {
        true
    } else if combat_targeting_turret_lockon_includes_turret_family(pool, source_turret_idx) {
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
        CT_TURRET_CFG_PASSIVE | CT_TURRET_CFG_VISUAL_ONLY | CT_TURRET_CFG_IS_MANUAL_FIRE;
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
        CT_TURRET_CFG_PASSIVE | CT_TURRET_CFG_VISUAL_ONLY | CT_TURRET_CFG_IS_MANUAL_FIRE;
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
) -> (f64, f64, f64) {
    let idx = combat_targeting_turret_global_idx(entity_slot, turret_idx);
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
    let body_point = combat_targeting_resolve_body_aim_point_from_slot(
        pool,
        target_entity_slot,
        mount_x,
        mount_y,
        mount_z,
    );
    let Some(target_turret_idx) = target_turret_idx else {
        return body_point;
    };

    let turret_point = combat_targeting_resolve_turret_mount_from_slab(
        pool,
        target_entity_slot,
        target_turret_idx,
    );
    if (pool.turret_config_flags[idx] & CT_TURRET_CFG_RAY_BISECT_TURRET_AND_BODY) == 0 {
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
    }
}

#[inline]
pub(crate) fn combat_targeting_target_vertical_extent(
    pool: &CombatTargetingPool,
    entity_slot: usize,
) -> f64 {
    if entity_slot >= pool.entity_radius_hitbox.len() {
        return 0.0;
    }
    let hitbox = combat_targeting_nonnegative_finite(pool.entity_radius_hitbox[entity_slot]);
    let half_z = if entity_slot < pool.entity_aabb_half_z.len() {
        combat_targeting_nonnegative_finite(pool.entity_aabb_half_z[entity_slot])
    } else {
        0.0
    };
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
pub(crate) fn combat_targeting_flags_allow_target_medium(
    flags: u32,
    target: CombatTargetingCylinderTarget,
) -> bool {
    (flags & CT_TURRET_CFG_REQUIRES_AIR_TARGET) == 0 || target.top_z > TERRAIN_WATER_LEVEL
}

#[inline]
pub(crate) fn combat_targeting_turret_allows_target_medium(
    pool: &CombatTargetingPool,
    idx: usize,
    target: CombatTargetingCylinderTarget,
) -> bool {
    combat_targeting_flags_allow_target_medium(pool.turret_config_flags[idx], target)
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
    combat_targeting_turret_allows_target_medium(pool, idx, target)
        && combat_targeting_range_volume_contains(
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
    combat_targeting_turret_allows_target_medium(pool, idx, target)
        && combat_targeting_range_volume_contains(
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
    if slot >= pool.entity_id.len() || pool.entity_id[slot] != entity_id {
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
    (flags & CT_TURRET_CFG_VISUAL_ONLY) != 0
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
/// `visualOnly` turrets are skipped exactly like the JS path.
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
        if (flags & CT_TURRET_CFG_VISUAL_ONLY) != 0 {
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
) -> bool {
    pool.turret_state[idx] == CT_TURRET_STATE_ENGAGED
        && (pool.turret_target_id[idx] >= 0 || priority_point_present)
}

/// C1 movement/combat bridge — classify whether the current movement
/// action should halt because the host's combat slab is engaged.
///
/// Mode `anyEngaged` mirrors attack / attack-ground / guard: any
/// non-visual turret in ENGAGED state with a target, or with an active
/// priority point, pins the unit. Mode `fightRequired` mirrors fight /
/// patrol: every non-visual turret whose mount is flagged as required
/// for fight-stop must be engaged.
#[wasm_bindgen]
pub fn combat_targeting_halt_decision_batch(
    entity_slots: &[u32],
    modes: &[u8],
    priority_point_present: &[u8],
    out_should_halt: &mut [u8],
) -> u32 {
    let count = entity_slots
        .len()
        .min(modes.len())
        .min(priority_point_present.len())
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
        if modes[i] == CT_COMBAT_HALT_MODE_ANY_ENGAGED {
            for turret_idx in 0..turret_count {
                let idx = combat_targeting_turret_global_idx(entity_slots[i], turret_idx as u32);
                let flags = pool.turret_config_flags[idx];
                if (flags & CT_TURRET_CFG_VISUAL_ONLY) != 0 {
                    continue;
                }
                if combat_targeting_turret_halts_host(pool, idx, has_priority_point) {
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
            if (flags & CT_TURRET_CFG_VISUAL_ONLY) != 0 {
                continue;
            }
            if (flags & CT_TURRET_CFG_REQUIRED_ENGAGED_FOR_FIGHT_STOP) == 0 {
                continue;
            }
            required += 1;
            if combat_targeting_turret_halts_host(pool, idx, has_priority_point) {
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
/// disabled (visualOnly, passive without shield panels enabled, force without force
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
#[wasm_bindgen]
pub fn combat_targeting_prepare_auto_scan(
    entity_slot: u32,
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

        let acquire = pool.turret_outermost_acquire[idx];
        if acquire > max_acquire_range {
            max_acquire_range = acquire;
        }
        let offset = pool.turret_mount_offset_2d[idx];
        if offset > max_weapon_offset {
            max_weapon_offset = offset;
        }

        let mut cached_rank = CT_TARGET_RANK_NONE;
        if pool.turret_state[idx] == CT_TURRET_STATE_ENGAGED
            && pool.turret_fire_min_release_sq[idx] > 0.0
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
        if pool.turret_state[idx] != CT_TURRET_STATE_TRACKING
            && cached_rank != CT_TARGET_RANK_FIRE_FALLBACK
            && !prefer_non_threat_current_target
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
            if let Some(&target_slot) = pool.entity_slot_by_id.get(&target_id) {
                seed_shield_panel_scores[turret_idx] =
                    combat_targeting_shield_panel_target_score_for_slot(
                        pool,
                        target_slot as usize,
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

mod fsm;
pub(crate) use fsm::*;

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
    source_player: u8,
    source_owner_bit: u32,
    source_view_mask: u32,
    relationship_mask: u8,
    enabled_turret_mask: u32,
    wants_friendly: bool,
    wants_enemy: bool,
    batch_radius: f64,
    scratch: &mut CombatTargetingSpatialCandidateScratch,
) {
    if source_owner_bit != 0 {
        let bucket_owner_bits = cell.owner_bits;
        if bucket_owner_bits != 0 {
            if wants_enemy && !wants_friendly {
                if (bucket_owner_bits & !source_owner_bit) == 0 {
                    return;
                }
            } else if wants_friendly && !wants_enemy {
                if (bucket_owner_bits & source_owner_bit) == 0 {
                    return;
                }
            }
        }
    }

    for &slot_u32 in &cell.slots {
        let slot = slot_u32 as usize;
        if slot == source_slot {
            continue;
        }
        let relationship = if pool.entity_owner_player_id[slot] == source_player {
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
    let source_player = pool.entity_owner_player_id[source_slot];
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
                source_player,
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
                source_player,
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
    let mut out_f64 = [0.0f64; 2];
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
    let needs_spatial_query = combat_targeting_prepare_auto_scan(
        entity_slot,
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
#[wasm_bindgen]
pub fn combat_targeting_schedule_and_tick_batch(
    source_slots: &[u32],
    current_tick: i32,
    dt_ms: f64,
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
            has_enabled_weapon,
            priority_target_id,
            priority_point_present_val,
            priority_point_x,
            priority_point_y,
            priority_point_z,
            scheduled_probe_tick,
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
                    false,
                    -1i32,
                    0u8,
                    0.0,
                    0.0,
                    0.0,
                    -1i32,
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
                        false,
                        -1i32,
                        0u8,
                        0.0,
                        0.0,
                        0.0,
                        -1i32,
                    )
                } else {
                    let flags = pool.entity_flags[entity_idx];
                    let ready = (flags & CT_ENTITY_FLAG_HAS_COMBAT) != 0
                        && (flags & CT_ENTITY_FLAG_ALIVE) != 0
                        && (flags & CT_ENTITY_FLAG_BUILDABLE_COMPLETE) != 0;
                    let enabled = (flags & CT_ENTITY_FLAG_FIRE_ENABLED) != 0;
                    let has_weapon = combat_targeting_entity_has_enabled_weapon(
                        pool,
                        entity_slot,
                        turret_shield_panels_enabled,
                        turret_shield_spheres_enabled,
                    );
                    (
                        source_entity_id,
                        entity_slot,
                        ready,
                        enabled,
                        pool.entity_view_mask[entity_idx],
                        has_weapon,
                        pool.entity_priority_target_id[entity_idx],
                        pool.entity_priority_point_present[entity_idx],
                        pool.entity_priority_point_x[entity_idx],
                        pool.entity_priority_point_y[entity_idx],
                        pool.entity_priority_point_z[entity_idx],
                        pool.entity_scheduled_probe_tick[entity_idx],
                    )
                }
            }
        };

        if !entity_ready {
            continue;
        }

        {
            let pool = combat_targeting_pool();
            combat_targeting_reset_disabled_weapons_for_entity(
                pool,
                entity_slot,
                turret_shield_panels_enabled,
                turret_shield_spheres_enabled,
            );
        }

        if !fire_enabled {
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
            continue;
        }

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
            );
            out_modes[entity_i] = CT_TARGETING_TICK_MODE_PRIORITY_TARGET;
            out_has_active_work[entity_i] =
                combat_targeting_refresh_activity_masks_for_entity_and_read_active(entity_slot);
            continue;
        }

        combat_targeting_auto_mode_tick_from_slab(
            entity_slot,
            source_entity_id,
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
    config_flags: u32,
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
    };
    if !combat_targeting_flags_allow_target_medium(config_flags, target) {
        return None;
    }
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
            pool.turret_config_flags[source_turret_idx],
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
                pool.turret_config_flags[source_turret_idx],
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

// ─────────────────────────────────────────────────────────────────
// AIM-08.1 — Shield input slab
//
// Compact list of `count` active shields, rebuilt from scratch
// each tick from the JS-side getActiveShields(). Owner entity id
// is the entity that emits the field (sentinel -1 if not tied to one).
// ─────────────────────────────────────────────────────────────────

// Materials Are Independent Of Shape: a single shield surface pool holds
// every active piece of shield material in the world, regardless of the
// geometry that carries it. Spheres and infinite cylinders live in the flat
// per-field arrays; flat panels live in the per-unit + per-panel arrays. One
// material, multiple shapes — the clearance and projectile kernels read both
// groups and apply the same reflection / occlusion policy.
pub(crate) struct ShieldSurfacePool {
    // ── Sphere / infinite-cylinder shapes (flat per-field) ──
    count: u32,
    id: Vec<i32>,
    owner_entity_id: Vec<i32>,
    prev_center_x: Vec<f64>,
    prev_center_y: Vec<f64>,
    prev_center_z: Vec<f64>,
    prev_axis_end_x: Vec<f64>,
    prev_axis_end_y: Vec<f64>,
    prev_axis_end_z: Vec<f64>,
    center_x: Vec<f64>,
    center_y: Vec<f64>,
    center_z: Vec<f64>,
    axis_end_x: Vec<f64>,
    axis_end_y: Vec<f64>,
    axis_end_z: Vec<f64>,
    radius: Vec<f64>,
    field_shape: Vec<u8>,
    field_reflection_mode_plasma: Vec<u8>,
    field_reflection_mode_rocket: Vec<u8>,
    field_reflection_mode_beam: Vec<u8>,
    field_reflection_mode_laser: Vec<u8>,
    field_reflection_entity_mask: u8,

    // ── Rect-panel shape (per-unit) ──
    // Counts are tracked separately so the backing Vecs can be reused across
    // ticks; the kernels read only `unit_count` rows.
    unit_count: u32,
    unit_id: Vec<i32>,
    unit_x: Vec<f64>,
    unit_y: Vec<f64>,
    unit_z: Vec<f64>,
    unit_ground_z: Vec<f64>,
    unit_broad_radius: Vec<f32>,
    mirror_yaw: Vec<f32>,
    mirror_pitch: Vec<f32>,
    pivot_x: Vec<f64>,
    pivot_y: Vec<f64>,
    pivot_z: Vec<f64>,
    panel_start: Vec<u32>,
    panel_count: Vec<u8>,

    // ── Rect-panel shape (per-panel) ──
    total_panels: u32,
    panel_arm_length: Vec<f32>,
    panel_offset_y: Vec<f32>,
    panel_angle: Vec<f32>,
    panel_base_y: Vec<f32>,
    panel_top_y: Vec<f32>,
    panel_half_width: Vec<f32>,
    panel_reflection_mode_plasma: Vec<u8>,
    panel_reflection_mode_rocket: Vec<u8>,
    panel_reflection_mode_beam: Vec<u8>,
    panel_reflection_mode_laser: Vec<u8>,
    panel_reflection_entity_mask: u8,
}

impl ShieldSurfacePool {
    pub(crate) fn empty() -> Self {
        Self {
            count: 0,
            id: Vec::new(),
            owner_entity_id: Vec::new(),
            prev_center_x: Vec::new(),
            prev_center_y: Vec::new(),
            prev_center_z: Vec::new(),
            prev_axis_end_x: Vec::new(),
            prev_axis_end_y: Vec::new(),
            prev_axis_end_z: Vec::new(),
            center_x: Vec::new(),
            center_y: Vec::new(),
            center_z: Vec::new(),
            axis_end_x: Vec::new(),
            axis_end_y: Vec::new(),
            axis_end_z: Vec::new(),
            radius: Vec::new(),
            field_shape: Vec::new(),
            field_reflection_mode_plasma: Vec::new(),
            field_reflection_mode_rocket: Vec::new(),
            field_reflection_mode_beam: Vec::new(),
            field_reflection_mode_laser: Vec::new(),
            field_reflection_entity_mask: 0,
            unit_count: 0,
            unit_id: Vec::new(),
            unit_x: Vec::new(),
            unit_y: Vec::new(),
            unit_z: Vec::new(),
            unit_ground_z: Vec::new(),
            unit_broad_radius: Vec::new(),
            mirror_yaw: Vec::new(),
            mirror_pitch: Vec::new(),
            pivot_x: Vec::new(),
            pivot_y: Vec::new(),
            pivot_z: Vec::new(),
            panel_start: Vec::new(),
            panel_count: Vec::new(),
            total_panels: 0,
            panel_arm_length: Vec::new(),
            panel_offset_y: Vec::new(),
            panel_angle: Vec::new(),
            panel_base_y: Vec::new(),
            panel_top_y: Vec::new(),
            panel_half_width: Vec::new(),
            panel_reflection_mode_plasma: Vec::new(),
            panel_reflection_mode_rocket: Vec::new(),
            panel_reflection_mode_beam: Vec::new(),
            panel_reflection_mode_laser: Vec::new(),
            panel_reflection_entity_mask: 0,
        }
    }

    pub(crate) fn ensure_capacity(&mut self, count: u32) {
        let needed = count as usize;
        if self.id.len() < needed {
            self.id.resize(needed, -1);
            self.owner_entity_id.resize(needed, -1);
            self.prev_center_x.resize(needed, 0.0);
            self.prev_center_y.resize(needed, 0.0);
            self.prev_center_z.resize(needed, 0.0);
            self.prev_axis_end_x.resize(needed, 0.0);
            self.prev_axis_end_y.resize(needed, 0.0);
            self.prev_axis_end_z.resize(needed, 0.0);
            self.center_x.resize(needed, 0.0);
            self.center_y.resize(needed, 0.0);
            self.center_z.resize(needed, 0.0);
            self.axis_end_x.resize(needed, 0.0);
            self.axis_end_y.resize(needed, 0.0);
            self.axis_end_z.resize(needed, 0.0);
            self.radius.resize(needed, 0.0);
            self.field_shape.resize(needed, SHIELD_FIELD_SHAPE_SPHERE);
            self.field_reflection_mode_plasma
                .resize(needed, SHIELD_REFLECTION_MODE_NONE);
            self.field_reflection_mode_rocket
                .resize(needed, SHIELD_REFLECTION_MODE_NONE);
            self.field_reflection_mode_beam
                .resize(needed, SHIELD_REFLECTION_MODE_NONE);
            self.field_reflection_mode_laser
                .resize(needed, SHIELD_REFLECTION_MODE_NONE);
        }
    }

    pub(crate) fn ensure_unit_capacity(&mut self, count: u32) {
        let needed = count as usize;
        if self.unit_id.len() < needed {
            self.unit_id.resize(needed, -1);
            self.unit_x.resize(needed, 0.0);
            self.unit_y.resize(needed, 0.0);
            self.unit_z.resize(needed, 0.0);
            self.unit_ground_z.resize(needed, 0.0);
            self.unit_broad_radius.resize(needed, 0.0);
            self.mirror_yaw.resize(needed, 0.0);
            self.mirror_pitch.resize(needed, 0.0);
            self.pivot_x.resize(needed, 0.0);
            self.pivot_y.resize(needed, 0.0);
            self.pivot_z.resize(needed, 0.0);
            self.panel_start.resize(needed, 0);
            self.panel_count.resize(needed, 0);
        }
    }

    pub(crate) fn ensure_panel_capacity(&mut self, count: u32) {
        let needed = count as usize;
        if self.panel_arm_length.len() < needed {
            self.panel_arm_length.resize(needed, 0.0);
            self.panel_offset_y.resize(needed, 0.0);
            self.panel_angle.resize(needed, 0.0);
            self.panel_base_y.resize(needed, 0.0);
            self.panel_top_y.resize(needed, 0.0);
            self.panel_half_width.resize(needed, 0.0);
            self.panel_reflection_mode_plasma
                .resize(needed, SHIELD_REFLECTION_MODE_NONE);
            self.panel_reflection_mode_rocket
                .resize(needed, SHIELD_REFLECTION_MODE_NONE);
            self.panel_reflection_mode_beam
                .resize(needed, SHIELD_REFLECTION_MODE_NONE);
            self.panel_reflection_mode_laser
                .resize(needed, SHIELD_REFLECTION_MODE_NONE);
        }
    }
}

pub(crate) struct ShieldSurfacePoolHolder(UnsafeCell<Option<ShieldSurfacePool>>);
unsafe impl Sync for ShieldSurfacePoolHolder {}
pub(crate) static SHIELD_POOL: ShieldSurfacePoolHolder =
    ShieldSurfacePoolHolder(UnsafeCell::new(None));

#[inline]
pub(crate) fn shield_pool() -> &'static mut ShieldSurfacePool {
    unsafe {
        let cell = &mut *SHIELD_POOL.0.get();
        if cell.is_none() {
            *cell = Some(ShieldSurfacePool::empty());
        }
        cell.as_mut().unwrap()
    }
}

#[wasm_bindgen]
pub fn shield_pool_clear() {
    let pool = shield_pool();
    pool.count = 0;
    pool.unit_count = 0;
    pool.total_panels = 0;
    pool.field_reflection_entity_mask = 0;
    pool.panel_reflection_entity_mask = 0;
}

#[wasm_bindgen]
pub fn shield_pool_count() -> u32 {
    shield_pool().count
}

#[wasm_bindgen]
pub fn shield_pool_set_count(count: u32) {
    let pool = shield_pool();
    pool.ensure_capacity(count);
    pool.count = count;
    pool.field_reflection_entity_mask = 0;
}

#[wasm_bindgen]
pub fn shield_pool_set_field(
    idx: u32,
    id: i32,
    owner_entity_id: i32,
    prev_center_x: f64,
    prev_center_y: f64,
    prev_center_z: f64,
    prev_axis_end_x: f64,
    prev_axis_end_y: f64,
    prev_axis_end_z: f64,
    center_x: f64,
    center_y: f64,
    center_z: f64,
    axis_end_x: f64,
    axis_end_y: f64,
    axis_end_z: f64,
    radius: f64,
    shape: u8,
    reflection_mode_plasma: u8,
    reflection_mode_rocket: u8,
    reflection_mode_beam: u8,
    reflection_mode_laser: u8,
) {
    let pool = shield_pool();
    pool.ensure_capacity(idx + 1);
    let i = idx as usize;
    pool.id[i] = id;
    pool.owner_entity_id[i] = owner_entity_id;
    pool.prev_center_x[i] = prev_center_x;
    pool.prev_center_y[i] = prev_center_y;
    pool.prev_center_z[i] = prev_center_z;
    pool.prev_axis_end_x[i] = prev_axis_end_x;
    pool.prev_axis_end_y[i] = prev_axis_end_y;
    pool.prev_axis_end_z[i] = prev_axis_end_z;
    pool.center_x[i] = center_x;
    pool.center_y[i] = center_y;
    pool.center_z[i] = center_z;
    pool.axis_end_x[i] = axis_end_x;
    pool.axis_end_y[i] = axis_end_y;
    pool.axis_end_z[i] = axis_end_z;
    pool.radius[i] = radius;
    pool.field_shape[i] = shape;
    pool.field_reflection_mode_plasma[i] = reflection_mode_plasma;
    pool.field_reflection_mode_rocket[i] = reflection_mode_rocket;
    pool.field_reflection_mode_beam[i] = reflection_mode_beam;
    pool.field_reflection_mode_laser[i] = reflection_mode_laser;
    pool.field_reflection_entity_mask |= shield_reflection_entity_mask_from_modes(
        reflection_mode_plasma,
        reflection_mode_rocket,
        reflection_mode_beam,
        reflection_mode_laser,
    );
}

macro_rules! shield_pool_ptr_export {
    ($name:ident, $field:ident, $ty:ty) => {
        #[wasm_bindgen]
        pub fn $name() -> *const $ty {
            shield_pool().$field.as_ptr()
        }
    };
}

shield_pool_ptr_export!(shield_pool_id_ptr, id, i32);
shield_pool_ptr_export!(shield_pool_owner_entity_id_ptr, owner_entity_id, i32);
shield_pool_ptr_export!(shield_pool_center_x_ptr, center_x, f64);
shield_pool_ptr_export!(shield_pool_center_y_ptr, center_y, f64);
shield_pool_ptr_export!(shield_pool_center_z_ptr, center_z, f64);
shield_pool_ptr_export!(shield_pool_radius_ptr, radius, f64);

// ─────────────────────────────────────────────────────────────────
// AIM-08.2 — Shield clearance kernels.
//
// Both kernels read the SHIELD_POOL slab rebuilt per tick by the
// JS-side stampShieldPool pass. They replace the JS-side
// hasShieldClearance / hasArcShieldClearance in
// lineOfSight.ts; the JS wrappers are now thin dispatchers.
//
// `exclude_owner_entity_id` is a legacy per-call exemption hook. The
// current shield-aware targeting path passes sentinel -1 so every active
// boundary is considered, including a shooter's own field.
//
// Graze epsilon: crossings within SHIELD_GRAZE_EPS of the segment
// endpoints don't count, matching the JS path's behaviour so a turret
// or target sitting on a shield edge doesn't flicker between locked
// and unlocked.
// ─────────────────────────────────────────────────────────────────

pub(crate) const SHIELD_GRAZE_EPS: f64 = 1e-6;
pub(crate) const ARC_FF_CLEARANCE_SAMPLES: u32 = 16;
pub(crate) const SHIELD_MOVING_FIELD_TOI_STEPS: usize = 8;
pub(crate) const SHIELD_REFLECTION_MODE_OUTSIDE_IN: u8 = 0;
pub(crate) const SHIELD_REFLECTION_MODE_INSIDE_OUT: u8 = 1;
pub(crate) const SHIELD_REFLECTION_MODE_BOTH: u8 = 2;
pub(crate) const SHIELD_REFLECTION_MODE_NONE: u8 = 3;
pub(crate) const SHIELD_REFLECTION_ENTITY_PLASMA: u8 = 0;
pub(crate) const SHIELD_REFLECTION_ENTITY_ROCKET: u8 = 1;
pub(crate) const SHIELD_REFLECTION_ENTITY_BEAM: u8 = 2;
pub(crate) const SHIELD_REFLECTION_ENTITY_LASER: u8 = 3;
pub(crate) const SHIELD_REFLECTION_ENTITY_BIT_PLASMA: u8 = 1 << SHIELD_REFLECTION_ENTITY_PLASMA;
pub(crate) const SHIELD_REFLECTION_ENTITY_BIT_ROCKET: u8 = 1 << SHIELD_REFLECTION_ENTITY_ROCKET;
pub(crate) const SHIELD_REFLECTION_ENTITY_BIT_BEAM: u8 = 1 << SHIELD_REFLECTION_ENTITY_BEAM;
pub(crate) const SHIELD_REFLECTION_ENTITY_BIT_LASER: u8 = 1 << SHIELD_REFLECTION_ENTITY_LASER;
pub(crate) const SHIELD_FIELD_SHAPE_SPHERE: u8 = 0;
pub(crate) const SHIELD_FIELD_SHAPE_INFINITE_VERTICAL_CYLINDER: u8 = 1;
pub(crate) const SHIELD_FIELD_SHAPE_AIMED_CYLINDER: u8 = 2;
pub(crate) const REFLECTOR_HIT_KIND_NONE: u8 = 0;
// Materials Are Independent Of Shape: the shield-panel's flat panels and
// the shield-sphere's sphere are the EXACT SAME material. A projectile
// reflecting off either reports one kind; the shape only decided where the
// hit was and what the normal looks like.
pub(crate) const REFLECTOR_HIT_KIND_SHIELD: u8 = 1;

pub(crate) struct ProjectileReflectorHit {
    kind: u8,
    entity_id: i32,
    /// Panel index within the mirror unit's panel array; -1 for
    /// field (sphere/cylinder) surfaces.
    panel_index: i32,
    t: f64,
    x: f64,
    y: f64,
    z: f64,
    normal_x: f64,
    normal_y: f64,
    normal_z: f64,
    surface_velocity_x: f64,
    surface_velocity_y: f64,
    surface_velocity_z: f64,
}

/// THE one mirror-reflection formula, shared by every emission kind:
/// beam traces reflect their segment direction through it, and the
/// plasma/rocket reflection response reflects its surface-relative
/// velocity through it. Normalizes `n_raw`, mirrors `d` about it, and
/// returns None when either vector is degenerate.
#[inline]
pub(crate) fn reflect_about_normal(
    dx: f64,
    dy: f64,
    dz: f64,
    nx_raw: f64,
    ny_raw: f64,
    nz_raw: f64,
) -> Option<(f64, f64, f64)> {
    let normal_len_sq = nx_raw * nx_raw + ny_raw * ny_raw + nz_raw * nz_raw;
    let d_len_sq = dx * dx + dy * dy + dz * dz;
    if normal_len_sq <= 1e-18 || d_len_sq <= 1e-18 {
        return None;
    }
    let inv_normal_len = 1.0 / normal_len_sq.sqrt();
    let nx = nx_raw * inv_normal_len;
    let ny = ny_raw * inv_normal_len;
    let nz = nz_raw * inv_normal_len;
    let dot = dx * nx + dy * ny + dz * nz;
    Some((
        dx - 2.0 * dot * nx,
        dy - 2.0 * dot * ny,
        dz - 2.0 * dot * nz,
    ))
}

pub(crate) struct ShieldFieldContact {
    t: f64,
    threshold: f64,
}

#[inline]
pub(crate) fn shield_reflection_mode_for_entity(
    reflection_entity: u8,
    plasma_mode: u8,
    rocket_mode: u8,
    beam_mode: u8,
    laser_mode: u8,
) -> u8 {
    match reflection_entity {
        SHIELD_REFLECTION_ENTITY_PLASMA => plasma_mode,
        SHIELD_REFLECTION_ENTITY_ROCKET => rocket_mode,
        SHIELD_REFLECTION_ENTITY_BEAM => beam_mode,
        SHIELD_REFLECTION_ENTITY_LASER => laser_mode,
        _ => SHIELD_REFLECTION_MODE_NONE,
    }
}

#[inline]
pub(crate) fn shield_reflection_entity_bit(reflection_entity: u8) -> u8 {
    match reflection_entity {
        SHIELD_REFLECTION_ENTITY_PLASMA => SHIELD_REFLECTION_ENTITY_BIT_PLASMA,
        SHIELD_REFLECTION_ENTITY_ROCKET => SHIELD_REFLECTION_ENTITY_BIT_ROCKET,
        SHIELD_REFLECTION_ENTITY_BEAM => SHIELD_REFLECTION_ENTITY_BIT_BEAM,
        SHIELD_REFLECTION_ENTITY_LASER => SHIELD_REFLECTION_ENTITY_BIT_LASER,
        _ => 0,
    }
}

#[inline]
pub(crate) fn shield_reflection_entity_mask_from_modes(
    plasma_mode: u8,
    rocket_mode: u8,
    beam_mode: u8,
    laser_mode: u8,
) -> u8 {
    let mut mask = 0;
    if plasma_mode != SHIELD_REFLECTION_MODE_NONE {
        mask |= SHIELD_REFLECTION_ENTITY_BIT_PLASMA;
    }
    if rocket_mode != SHIELD_REFLECTION_MODE_NONE {
        mask |= SHIELD_REFLECTION_ENTITY_BIT_ROCKET;
    }
    if beam_mode != SHIELD_REFLECTION_MODE_NONE {
        mask |= SHIELD_REFLECTION_ENTITY_BIT_BEAM;
    }
    if laser_mode != SHIELD_REFLECTION_MODE_NONE {
        mask |= SHIELD_REFLECTION_ENTITY_BIT_LASER;
    }
    mask
}

#[inline]
pub(crate) fn shield_segment_crosses_sphere(
    sx: f64,
    sy: f64,
    sz: f64,
    tx: f64,
    ty: f64,
    tz: f64,
    cx: f64,
    cy: f64,
    cz: f64,
    r: f64,
    lo: f64,
    hi: f64,
) -> bool {
    if sx.max(tx) < cx - r || sx.min(tx) > cx + r {
        return false;
    }
    if sy.max(ty) < cy - r || sy.min(ty) > cy + r {
        return false;
    }
    if sz.max(tz) < cz - r || sz.min(tz) > cz + r {
        return false;
    }
    let dx = tx - sx;
    let dy = ty - sy;
    let dz = tz - sz;
    let a = dx * dx + dy * dy + dz * dz;
    if a < 1e-9 {
        return false;
    }
    let fx = sx - cx;
    let fy = sy - cy;
    let fz = sz - cz;
    let b = 2.0 * (fx * dx + fy * dy + fz * dz);
    let c = fx * fx + fy * fy + fz * fz - r * r;
    let disc = b * b - 4.0 * a * c;
    if disc < 0.0 {
        return false;
    }
    let sqrt_disc = disc.sqrt();
    let inv_denom = 1.0 / (2.0 * a);
    let t1 = (-b - sqrt_disc) * inv_denom;
    let t2 = (-b + sqrt_disc) * inv_denom;
    (t1 > lo && t1 < hi) || (t2 > lo && t2 < hi)
}

#[inline]
pub(crate) fn shield_segment_crosses_infinite_vertical_cylinder(
    sx: f64,
    sy: f64,
    tx: f64,
    ty: f64,
    cx: f64,
    cy: f64,
    r: f64,
    lo: f64,
    hi: f64,
) -> bool {
    if sx.max(tx) < cx - r || sx.min(tx) > cx + r {
        return false;
    }
    if sy.max(ty) < cy - r || sy.min(ty) > cy + r {
        return false;
    }
    let dx = tx - sx;
    let dy = ty - sy;
    let a = dx * dx + dy * dy;
    if a < 1e-9 {
        return false;
    }
    let fx = sx - cx;
    let fy = sy - cy;
    let b = 2.0 * (fx * dx + fy * dy);
    let c = fx * fx + fy * fy - r * r;
    let disc = b * b - 4.0 * a * c;
    if disc < 0.0 {
        return false;
    }
    let sqrt_disc = disc.sqrt();
    let inv_denom = 1.0 / (2.0 * a);
    let t1 = (-b - sqrt_disc) * inv_denom;
    let t2 = (-b + sqrt_disc) * inv_denom;
    (t1 > lo && t1 < hi) || (t2 > lo && t2 < hi)
}

#[inline]
pub(crate) fn shield_segment_crosses_aimed_cylinder(
    sx: f64,
    sy: f64,
    sz: f64,
    tx: f64,
    ty: f64,
    tz: f64,
    ax: f64,
    ay: f64,
    az: f64,
    bx: f64,
    by: f64,
    bz: f64,
    r: f64,
    lo: f64,
    hi: f64,
) -> bool {
    let axis_x = bx - ax;
    let axis_y = by - ay;
    let axis_z = bz - az;
    let axis_len = (axis_x * axis_x + axis_y * axis_y + axis_z * axis_z).sqrt();
    if axis_len <= 1e-6 || r <= 0.0 {
        return false;
    }

    let ux = axis_x / axis_len;
    let uy = axis_y / axis_len;
    let uz = axis_z / axis_len;
    let dx = tx - sx;
    let dy = ty - sy;
    let dz = tz - sz;
    let wx = sx - ax;
    let wy = sy - ay;
    let wz = sz - az;
    let d_dot_axis = dx * ux + dy * uy + dz * uz;
    let w_dot_axis = wx * ux + wy * uy + wz * uz;
    let mx = dx - ux * d_dot_axis;
    let my = dy - uy * d_dot_axis;
    let mz = dz - uz * d_dot_axis;
    let nx = wx - ux * w_dot_axis;
    let ny = wy - uy * w_dot_axis;
    let nz = wz - uz * w_dot_axis;
    let qa = mx * mx + my * my + mz * mz;
    if qa <= 1e-9 {
        return false;
    }
    let qb = 2.0 * (nx * mx + ny * my + nz * mz);
    let qc = nx * nx + ny * ny + nz * nz - r * r;
    let disc = qb * qb - 4.0 * qa * qc;
    if disc < 0.0 {
        return false;
    }
    let sqrt_disc = disc.sqrt();
    let inv_denom = 1.0 / (2.0 * qa);
    let t1 = (-qb - sqrt_disc) * inv_denom;
    let t2 = (-qb + sqrt_disc) * inv_denom;

    let crosses_at = |t: f64| -> bool {
        if t <= lo || t >= hi {
            return false;
        }
        true
    };
    crosses_at(t1) || crosses_at(t2)
}

#[inline]
pub(crate) fn shield_segment_crosses_field(
    sx: f64,
    sy: f64,
    sz: f64,
    tx: f64,
    ty: f64,
    tz: f64,
    cx: f64,
    cy: f64,
    cz: f64,
    axis_end_x: f64,
    axis_end_y: f64,
    axis_end_z: f64,
    r: f64,
    shape: u8,
    lo: f64,
    hi: f64,
) -> bool {
    if shape == SHIELD_FIELD_SHAPE_INFINITE_VERTICAL_CYLINDER {
        return shield_segment_crosses_infinite_vertical_cylinder(
            sx, sy, tx, ty, cx, cy, r, lo, hi,
        );
    }
    if shape == SHIELD_FIELD_SHAPE_AIMED_CYLINDER {
        return shield_segment_crosses_aimed_cylinder(
            sx, sy, sz, tx, ty, tz, cx, cy, cz, axis_end_x, axis_end_y, axis_end_z, r, lo, hi,
        );
    }
    shield_segment_crosses_sphere(sx, sy, sz, tx, ty, tz, cx, cy, cz, r, lo, hi)
}

#[inline]
pub(crate) fn shield_reflection_mode_allows_crossing(mode: u8, radial_velocity: f64) -> bool {
    if mode == SHIELD_REFLECTION_MODE_NONE {
        return false;
    }
    let eps = 1e-6;
    if radial_velocity < -eps {
        return mode == SHIELD_REFLECTION_MODE_OUTSIDE_IN || mode == SHIELD_REFLECTION_MODE_BOTH;
    }
    if radial_velocity > eps {
        return mode == SHIELD_REFLECTION_MODE_INSIDE_OUT || mode == SHIELD_REFLECTION_MODE_BOTH;
    }
    false
}

#[inline]
pub(crate) fn shield_projectile_intersection_t_infinite_vertical_cylinder(
    start_x: f64,
    start_y: f64,
    end_x: f64,
    end_y: f64,
    center_x: f64,
    center_y: f64,
    radius: f64,
    reflection_mode: u8,
) -> Option<f64> {
    let sx = start_x - center_x;
    let sy = start_y - center_y;
    if start_x.max(end_x) < center_x - radius || start_x.min(end_x) > center_x + radius {
        return None;
    }
    if start_y.max(end_y) < center_y - radius || start_y.min(end_y) > center_y + radius {
        return None;
    }

    let dx = end_x - start_x;
    let dy = end_y - start_y;
    let a = dx * dx + dy * dy;
    if a <= 1e-9 {
        return None;
    }

    let radius_sq = radius * radius;
    let start_dist_sq = sx * sx + sy * sy;
    let start_dot_velocity = sx * dx + sy * dy;
    let b = 2.0 * start_dot_velocity;
    let c = start_dist_sq - radius_sq;
    let disc = b * b - 4.0 * a * c;
    if disc < 0.0 {
        return None;
    }

    let sqrt_disc = disc.sqrt();
    let inv_denom = 1.0 / (2.0 * a);
    let t0 = (-b - sqrt_disc) * inv_denom;
    let t1 = (-b + sqrt_disc) * inv_denom;
    let first_t = t0.min(t1);
    let second_t = t0.max(t1);

    if first_t > SHIELD_GRAZE_EPS && first_t <= 1.0 {
        let hit_x = start_x + dx * first_t - center_x;
        let hit_y = start_y + dy * first_t - center_y;
        let radial_velocity = dx * hit_x + dy * hit_y;
        if shield_reflection_mode_allows_crossing(reflection_mode, radial_velocity) {
            return Some(first_t);
        }
    }

    if second_t > SHIELD_GRAZE_EPS && second_t <= 1.0 && second_t != first_t {
        let hit_x = start_x + dx * second_t - center_x;
        let hit_y = start_y + dy * second_t - center_y;
        let radial_velocity = dx * hit_x + dy * hit_y;
        if shield_reflection_mode_allows_crossing(reflection_mode, radial_velocity) {
            return Some(second_t);
        }
    }

    None
}

#[inline]
pub(crate) fn shield_projectile_intersection_t_aimed_cylinder(
    start_x: f64,
    start_y: f64,
    start_z: f64,
    end_x: f64,
    end_y: f64,
    end_z: f64,
    axis_start_x: f64,
    axis_start_y: f64,
    axis_start_z: f64,
    axis_end_x: f64,
    axis_end_y: f64,
    axis_end_z: f64,
    radius: f64,
    reflection_mode: u8,
) -> Option<f64> {
    let axis_x = axis_end_x - axis_start_x;
    let axis_y = axis_end_y - axis_start_y;
    let axis_z = axis_end_z - axis_start_z;
    let axis_len = (axis_x * axis_x + axis_y * axis_y + axis_z * axis_z).sqrt();
    if axis_len <= 1e-6 || radius <= 0.0 {
        return None;
    }

    let ux = axis_x / axis_len;
    let uy = axis_y / axis_len;
    let uz = axis_z / axis_len;
    let dx = end_x - start_x;
    let dy = end_y - start_y;
    let dz = end_z - start_z;
    let wx = start_x - axis_start_x;
    let wy = start_y - axis_start_y;
    let wz = start_z - axis_start_z;
    let d_dot_axis = dx * ux + dy * uy + dz * uz;
    let w_dot_axis = wx * ux + wy * uy + wz * uz;
    let mx = dx - ux * d_dot_axis;
    let my = dy - uy * d_dot_axis;
    let mz = dz - uz * d_dot_axis;
    let nx = wx - ux * w_dot_axis;
    let ny = wy - uy * w_dot_axis;
    let nz = wz - uz * w_dot_axis;
    let qa = mx * mx + my * my + mz * mz;
    if qa <= 1e-9 {
        return None;
    }
    let qb = 2.0 * (nx * mx + ny * my + nz * mz);
    let qc = nx * nx + ny * ny + nz * nz - radius * radius;
    let disc = qb * qb - 4.0 * qa * qc;
    if disc < 0.0 {
        return None;
    }
    let sqrt_disc = disc.sqrt();
    let inv_denom = 1.0 / (2.0 * qa);
    let t0 = (-qb - sqrt_disc) * inv_denom;
    let t1 = (-qb + sqrt_disc) * inv_denom;
    let first_t = t0.min(t1);
    let second_t = t0.max(t1);

    let accepts = |t: f64| -> bool {
        if t <= SHIELD_GRAZE_EPS || t > 1.0 {
            return false;
        }
        let hit_perp_x = nx + mx * t;
        let hit_perp_y = ny + my * t;
        let hit_perp_z = nz + mz * t;
        let radial_velocity = mx * hit_perp_x + my * hit_perp_y + mz * hit_perp_z;
        shield_reflection_mode_allows_crossing(reflection_mode, radial_velocity)
    };

    if accepts(first_t) {
        return Some(first_t);
    }
    if second_t != first_t && accepts(second_t) {
        return Some(second_t);
    }
    None
}

#[inline]
pub(crate) fn shield_projectile_intersection_t(
    start_x: f64,
    start_y: f64,
    start_z: f64,
    end_x: f64,
    end_y: f64,
    end_z: f64,
    center_x: f64,
    center_y: f64,
    center_z: f64,
    axis_end_x: f64,
    axis_end_y: f64,
    axis_end_z: f64,
    radius: f64,
    shape: u8,
    reflection_mode: u8,
) -> Option<f64> {
    if shape == SHIELD_FIELD_SHAPE_INFINITE_VERTICAL_CYLINDER {
        return shield_projectile_intersection_t_infinite_vertical_cylinder(
            start_x,
            start_y,
            end_x,
            end_y,
            center_x,
            center_y,
            radius,
            reflection_mode,
        );
    }
    if shape == SHIELD_FIELD_SHAPE_AIMED_CYLINDER {
        return shield_projectile_intersection_t_aimed_cylinder(
            start_x,
            start_y,
            start_z,
            end_x,
            end_y,
            end_z,
            center_x,
            center_y,
            center_z,
            axis_end_x,
            axis_end_y,
            axis_end_z,
            radius,
            reflection_mode,
        );
    }

    let sx = start_x - center_x;
    let sy = start_y - center_y;
    let sz = start_z - center_z;
    if start_x.max(end_x) < center_x - radius || start_x.min(end_x) > center_x + radius {
        return None;
    }
    if start_y.max(end_y) < center_y - radius || start_y.min(end_y) > center_y + radius {
        return None;
    }
    if start_z.max(end_z) < center_z - radius || start_z.min(end_z) > center_z + radius {
        return None;
    }

    let dx = end_x - start_x;
    let dy = end_y - start_y;
    let dz = end_z - start_z;
    let a = dx * dx + dy * dy + dz * dz;
    if a <= 1e-9 {
        return None;
    }

    let radius_sq = radius * radius;
    let start_dist_sq = sx * sx + sy * sy + sz * sz;
    let start_dot_velocity = sx * dx + sy * dy + sz * dz;
    let b = 2.0 * start_dot_velocity;
    let c = start_dist_sq - radius_sq;
    let disc = b * b - 4.0 * a * c;
    if disc < 0.0 {
        return None;
    }

    let sqrt_disc = disc.sqrt();
    let inv_denom = 1.0 / (2.0 * a);
    let t0 = (-b - sqrt_disc) * inv_denom;
    let t1 = (-b + sqrt_disc) * inv_denom;
    let first_t = t0.min(t1);
    let second_t = t0.max(t1);

    if first_t > SHIELD_GRAZE_EPS && first_t <= 1.0 {
        let hit_x = start_x + dx * first_t - center_x;
        let hit_y = start_y + dy * first_t - center_y;
        let hit_z = start_z + dz * first_t - center_z;
        let radial_velocity = dx * hit_x + dy * hit_y + dz * hit_z;
        if shield_reflection_mode_allows_crossing(reflection_mode, radial_velocity) {
            return Some(first_t);
        }
    }

    if second_t > SHIELD_GRAZE_EPS && second_t <= 1.0 && second_t != first_t {
        let hit_x = start_x + dx * second_t - center_x;
        let hit_y = start_y + dy * second_t - center_y;
        let hit_z = start_z + dz * second_t - center_z;
        let radial_velocity = dx * hit_x + dy * hit_y + dz * hit_z;
        if shield_reflection_mode_allows_crossing(reflection_mode, radial_velocity) {
            return Some(second_t);
        }
    }

    None
}

#[inline]
pub(crate) fn shield_projectile_intersection_contact(
    start_x: f64,
    start_y: f64,
    start_z: f64,
    end_x: f64,
    end_y: f64,
    end_z: f64,
    center_x: f64,
    center_y: f64,
    center_z: f64,
    axis_end_x: f64,
    axis_end_y: f64,
    axis_end_z: f64,
    radius: f64,
    projectile_radius: f64,
    shape: u8,
    reflection_mode: u8,
) -> Option<ShieldFieldContact> {
    let projectile_radius = projectile_radius.max(0.0);
    let mut best: Option<ShieldFieldContact> = None;

    let mut try_radius = |effective_radius: f64, threshold: f64| {
        if effective_radius <= SHIELD_GRAZE_EPS {
            return;
        }
        let Some(t) = shield_projectile_intersection_t(
            start_x,
            start_y,
            start_z,
            end_x,
            end_y,
            end_z,
            center_x,
            center_y,
            center_z,
            axis_end_x,
            axis_end_y,
            axis_end_z,
            effective_radius,
            shape,
            reflection_mode,
        ) else {
            return;
        };
        if best.as_ref().map(|hit| t < hit.t).unwrap_or(true) {
            best = Some(ShieldFieldContact { t, threshold });
        }
    };

    if projectile_radius > SHIELD_GRAZE_EPS {
        try_radius(radius - projectile_radius, -projectile_radius);
        try_radius(radius + projectile_radius, projectile_radius);
    } else {
        try_radius(radius, 0.0);
    }

    best
}

#[inline]
pub(crate) fn shield_field_signed_distance_and_normal(
    px: f64,
    py: f64,
    pz: f64,
    center_x: f64,
    center_y: f64,
    center_z: f64,
    axis_end_x: f64,
    axis_end_y: f64,
    axis_end_z: f64,
    radius: f64,
    shape: u8,
) -> Option<(f64, f64, f64, f64)> {
    if radius <= 0.0 {
        return None;
    }
    if shape == SHIELD_FIELD_SHAPE_INFINITE_VERTICAL_CYLINDER {
        let dx = px - center_x;
        let dy = py - center_y;
        let len = (dx * dx + dy * dy).sqrt();
        if len <= 1e-9 {
            return Some((-radius, 1.0, 0.0, 0.0));
        }
        let inv_len = 1.0 / len;
        return Some((len - radius, dx * inv_len, dy * inv_len, 0.0));
    }
    if shape == SHIELD_FIELD_SHAPE_AIMED_CYLINDER {
        let axis_x = axis_end_x - center_x;
        let axis_y = axis_end_y - center_y;
        let axis_z = axis_end_z - center_z;
        let axis_len = (axis_x * axis_x + axis_y * axis_y + axis_z * axis_z).sqrt();
        if axis_len <= 1e-6 {
            return None;
        }
        let ux = axis_x / axis_len;
        let uy = axis_y / axis_len;
        let uz = axis_z / axis_len;
        let rel_x = px - center_x;
        let rel_y = py - center_y;
        let rel_z = pz - center_z;
        let axial = rel_x * ux + rel_y * uy + rel_z * uz;
        let perp_x = rel_x - ux * axial;
        let perp_y = rel_y - uy * axial;
        let perp_z = rel_z - uz * axial;
        let len = (perp_x * perp_x + perp_y * perp_y + perp_z * perp_z).sqrt();
        if len <= 1e-9 {
            let fallback_x = -uy;
            let fallback_y = ux;
            let fallback_len = (fallback_x * fallback_x + fallback_y * fallback_y).sqrt();
            if fallback_len > 1e-9 {
                let inv = 1.0 / fallback_len;
                return Some((-radius, fallback_x * inv, fallback_y * inv, 0.0));
            }
            return Some((-radius, 1.0, 0.0, 0.0));
        }
        let inv_len = 1.0 / len;
        return Some((
            len - radius,
            perp_x * inv_len,
            perp_y * inv_len,
            perp_z * inv_len,
        ));
    }

    let dx = px - center_x;
    let dy = py - center_y;
    let dz = pz - center_z;
    let len = (dx * dx + dy * dy + dz * dz).sqrt();
    if len <= 1e-9 {
        return Some((-radius, 1.0, 0.0, 0.0));
    }
    let inv_len = 1.0 / len;
    Some((len - radius, dx * inv_len, dy * inv_len, dz * inv_len))
}

#[inline]
pub(crate) fn lerp_f64(a: f64, b: f64, t: f64) -> f64 {
    a + (b - a) * t
}

#[inline]
pub(crate) fn shield_field_sample_at_t(
    start_x: f64,
    start_y: f64,
    start_z: f64,
    end_x: f64,
    end_y: f64,
    end_z: f64,
    prev_center_x: f64,
    prev_center_y: f64,
    prev_center_z: f64,
    prev_axis_end_x: f64,
    prev_axis_end_y: f64,
    prev_axis_end_z: f64,
    center_x: f64,
    center_y: f64,
    center_z: f64,
    axis_end_x: f64,
    axis_end_y: f64,
    axis_end_z: f64,
    radius: f64,
    shape: u8,
    t: f64,
) -> Option<(f64, f64, f64, f64, f64, f64, f64)> {
    let px = lerp_f64(start_x, end_x, t);
    let py = lerp_f64(start_y, end_y, t);
    let pz = lerp_f64(start_z, end_z, t);
    let cx = lerp_f64(prev_center_x, center_x, t);
    let cy = lerp_f64(prev_center_y, center_y, t);
    let cz = lerp_f64(prev_center_z, center_z, t);
    let ax = lerp_f64(prev_axis_end_x, axis_end_x, t);
    let ay = lerp_f64(prev_axis_end_y, axis_end_y, t);
    let az = lerp_f64(prev_axis_end_z, axis_end_z, t);
    let (dist, nx, ny, nz) =
        shield_field_signed_distance_and_normal(px, py, pz, cx, cy, cz, ax, ay, az, radius, shape)?;
    Some((dist, nx, ny, nz, px, py, pz))
}

#[inline]
pub(crate) fn shield_field_surface_velocity(
    hit_x: f64,
    hit_y: f64,
    hit_z: f64,
    normal_x: f64,
    normal_y: f64,
    normal_z: f64,
    threshold: f64,
    prev_center_x: f64,
    prev_center_y: f64,
    prev_center_z: f64,
    prev_axis_end_x: f64,
    prev_axis_end_y: f64,
    prev_axis_end_z: f64,
    center_x: f64,
    center_y: f64,
    center_z: f64,
    axis_end_x: f64,
    axis_end_y: f64,
    axis_end_z: f64,
    radius: f64,
    shape: u8,
    dt_sec: f64,
) -> (f64, f64, f64) {
    if dt_sec <= 1e-9 || !dt_sec.is_finite() {
        return (0.0, 0.0, 0.0);
    }
    let effective_radius = (radius + threshold).max(0.0);
    let (prev_x, prev_y, prev_z, curr_x, curr_y, curr_z) = if shape
        == SHIELD_FIELD_SHAPE_INFINITE_VERTICAL_CYLINDER
    {
        (
            prev_center_x + normal_x * effective_radius,
            prev_center_y + normal_y * effective_radius,
            hit_z,
            center_x + normal_x * effective_radius,
            center_y + normal_y * effective_radius,
            hit_z,
        )
    } else if shape == SHIELD_FIELD_SHAPE_AIMED_CYLINDER {
        let cur_axis_x = axis_end_x - center_x;
        let cur_axis_y = axis_end_y - center_y;
        let cur_axis_z = axis_end_z - center_z;
        let prev_axis_x = prev_axis_end_x - prev_center_x;
        let prev_axis_y = prev_axis_end_y - prev_center_y;
        let prev_axis_z = prev_axis_end_z - prev_center_z;
        let cur_axis_len =
            (cur_axis_x * cur_axis_x + cur_axis_y * cur_axis_y + cur_axis_z * cur_axis_z).sqrt();
        let prev_axis_len =
            (prev_axis_x * prev_axis_x + prev_axis_y * prev_axis_y + prev_axis_z * prev_axis_z)
                .sqrt();
        if cur_axis_len <= 1e-9 || prev_axis_len <= 1e-9 {
            return (0.0, 0.0, 0.0);
        }
        let cux = cur_axis_x / cur_axis_len;
        let cuy = cur_axis_y / cur_axis_len;
        let cuz = cur_axis_z / cur_axis_len;
        let pux = prev_axis_x / prev_axis_len;
        let puy = prev_axis_y / prev_axis_len;
        let puz = prev_axis_z / prev_axis_len;
        let rel_x = hit_x - center_x;
        let rel_y = hit_y - center_y;
        let rel_z = hit_z - center_z;
        let axial = rel_x * cux + rel_y * cuy + rel_z * cuz;
        let prev_normal_dot = normal_x * pux + normal_y * puy + normal_z * puz;
        let mut pnx = normal_x - pux * prev_normal_dot;
        let mut pny = normal_y - puy * prev_normal_dot;
        let mut pnz = normal_z - puz * prev_normal_dot;
        let prev_normal_len = (pnx * pnx + pny * pny + pnz * pnz).sqrt();
        if prev_normal_len <= 1e-9 {
            pnx = normal_x;
            pny = normal_y;
            pnz = normal_z;
        } else {
            let inv = 1.0 / prev_normal_len;
            pnx *= inv;
            pny *= inv;
            pnz *= inv;
        }
        (
            prev_center_x + pux * axial + pnx * effective_radius,
            prev_center_y + puy * axial + pny * effective_radius,
            prev_center_z + puz * axial + pnz * effective_radius,
            center_x + cux * axial + normal_x * effective_radius,
            center_y + cuy * axial + normal_y * effective_radius,
            center_z + cuz * axial + normal_z * effective_radius,
        )
    } else {
        (
            prev_center_x + normal_x * effective_radius,
            prev_center_y + normal_y * effective_radius,
            prev_center_z + normal_z * effective_radius,
            center_x + normal_x * effective_radius,
            center_y + normal_y * effective_radius,
            center_z + normal_z * effective_radius,
        )
    };

    (
        (curr_x - prev_x) / dt_sec,
        (curr_y - prev_y) / dt_sec,
        (curr_z - prev_z) / dt_sec,
    )
}

#[inline]
pub(crate) fn shield_projectile_moving_field_hit(
    start_x: f64,
    start_y: f64,
    start_z: f64,
    end_x: f64,
    end_y: f64,
    end_z: f64,
    prev_center_x: f64,
    prev_center_y: f64,
    prev_center_z: f64,
    prev_axis_end_x: f64,
    prev_axis_end_y: f64,
    prev_axis_end_z: f64,
    center_x: f64,
    center_y: f64,
    center_z: f64,
    axis_end_x: f64,
    axis_end_y: f64,
    axis_end_z: f64,
    radius: f64,
    projectile_radius: f64,
    shape: u8,
    reflection_mode: u8,
    owner_entity_id: i32,
    dt_sec: f64,
) -> Option<ProjectileReflectorHit> {
    let projectile_radius = projectile_radius.max(0.0);
    let mut contact: Option<ShieldFieldContact> = None;
    let mut try_threshold = |candidate: f64, fallback_only: bool| {
        if fallback_only && contact.is_some() {
            return;
        }
        if contact
            .as_ref()
            .map(|hit| hit.t <= SHIELD_GRAZE_EPS)
            .unwrap_or(false)
        {
            return;
        }
        let mut lo_t = 0.0;
        let Some((lo_dist, _, _, _, _, _, _)) = shield_field_sample_at_t(
            start_x,
            start_y,
            start_z,
            end_x,
            end_y,
            end_z,
            prev_center_x,
            prev_center_y,
            prev_center_z,
            prev_axis_end_x,
            prev_axis_end_y,
            prev_axis_end_z,
            center_x,
            center_y,
            center_z,
            axis_end_x,
            axis_end_y,
            axis_end_z,
            radius,
            shape,
            lo_t,
        ) else {
            return;
        };
        let mut lo_side = lo_dist - candidate;

        for step in 1..=SHIELD_MOVING_FIELD_TOI_STEPS {
            let sample_t = step as f64 / SHIELD_MOVING_FIELD_TOI_STEPS as f64;
            let Some((sample_dist, _, _, _, _, _, _)) = shield_field_sample_at_t(
                start_x,
                start_y,
                start_z,
                end_x,
                end_y,
                end_z,
                prev_center_x,
                prev_center_y,
                prev_center_z,
                prev_axis_end_x,
                prev_axis_end_y,
                prev_axis_end_z,
                center_x,
                center_y,
                center_z,
                axis_end_x,
                axis_end_y,
                axis_end_z,
                radius,
                shape,
                sample_t,
            ) else {
                return;
            };
            let sample_side = sample_dist - candidate;
            let exact_sample = sample_side.abs() <= SHIELD_GRAZE_EPS
                && lo_side.abs() > SHIELD_GRAZE_EPS
                && shield_reflection_mode_allows_crossing(reflection_mode, sample_side - lo_side);
            if exact_sample {
                if contact.as_ref().map(|hit| sample_t < hit.t).unwrap_or(true) {
                    contact = Some(ShieldFieldContact {
                        t: sample_t,
                        threshold: candidate,
                    });
                }
                return;
            }

            let crossed = (lo_side <= SHIELD_GRAZE_EPS && sample_side > SHIELD_GRAZE_EPS)
                || (lo_side >= -SHIELD_GRAZE_EPS && sample_side < -SHIELD_GRAZE_EPS);
            if crossed
                && shield_reflection_mode_allows_crossing(reflection_mode, sample_side - lo_side)
            {
                let mut root_lo_t = lo_t;
                let mut root_hi_t = sample_t;
                let mut root_lo_side = lo_side;
                for _ in 0..18 {
                    let mid = (root_lo_t + root_hi_t) * 0.5;
                    let Some((mid_dist, _, _, _, _, _, _)) = shield_field_sample_at_t(
                        start_x,
                        start_y,
                        start_z,
                        end_x,
                        end_y,
                        end_z,
                        prev_center_x,
                        prev_center_y,
                        prev_center_z,
                        prev_axis_end_x,
                        prev_axis_end_y,
                        prev_axis_end_z,
                        center_x,
                        center_y,
                        center_z,
                        axis_end_x,
                        axis_end_y,
                        axis_end_z,
                        radius,
                        shape,
                        mid,
                    ) else {
                        return;
                    };
                    let mid_side = mid_dist - candidate;
                    if mid_side.abs() <= SHIELD_GRAZE_EPS {
                        root_hi_t = mid;
                        break;
                    }
                    if (root_lo_side < 0.0 && mid_side < 0.0)
                        || (root_lo_side > 0.0 && mid_side > 0.0)
                    {
                        root_lo_t = mid;
                        root_lo_side = mid_side;
                    } else {
                        root_hi_t = mid;
                    }
                }
                if contact
                    .as_ref()
                    .map(|hit| root_hi_t < hit.t)
                    .unwrap_or(true)
                {
                    contact = Some(ShieldFieldContact {
                        t: root_hi_t,
                        threshold: candidate,
                    });
                }
                return;
            }

            lo_t = sample_t;
            lo_side = sample_side;
        }
    };

    if projectile_radius > SHIELD_GRAZE_EPS {
        try_threshold(-projectile_radius, false);
        try_threshold(projectile_radius, false);
        try_threshold(0.0, true);
    } else {
        try_threshold(0.0, false);
    }
    let Some(contact) = contact else {
        return None;
    };
    let t = contact.t;
    let threshold = contact.threshold;
    let Some((_, normal_x, normal_y, normal_z, hit_x, hit_y, hit_z)) = shield_field_sample_at_t(
        start_x,
        start_y,
        start_z,
        end_x,
        end_y,
        end_z,
        prev_center_x,
        prev_center_y,
        prev_center_z,
        prev_axis_end_x,
        prev_axis_end_y,
        prev_axis_end_z,
        center_x,
        center_y,
        center_z,
        axis_end_x,
        axis_end_y,
        axis_end_z,
        radius,
        shape,
        t,
    ) else {
        return None;
    };
    let (surface_velocity_x, surface_velocity_y, surface_velocity_z) =
        shield_field_surface_velocity(
            hit_x,
            hit_y,
            hit_z,
            normal_x,
            normal_y,
            normal_z,
            threshold,
            prev_center_x,
            prev_center_y,
            prev_center_z,
            prev_axis_end_x,
            prev_axis_end_y,
            prev_axis_end_z,
            center_x,
            center_y,
            center_z,
            axis_end_x,
            axis_end_y,
            axis_end_z,
            radius,
            shape,
            dt_sec,
        );

    Some(ProjectileReflectorHit {
        kind: REFLECTOR_HIT_KIND_SHIELD,
        entity_id: owner_entity_id,
        panel_index: -1,
        t,
        x: hit_x,
        y: hit_y,
        z: hit_z,
        normal_x,
        normal_y,
        normal_z,
        surface_velocity_x,
        surface_velocity_y,
        surface_velocity_z,
    })
}

#[inline]
pub(crate) fn shield_projectile_intersection(
    start_x: f64,
    start_y: f64,
    start_z: f64,
    end_x: f64,
    end_y: f64,
    end_z: f64,
    exclude_entity_id: i32,
    exclude_panel_index: i32,
    projectile_radius: f64,
    reflection_entity: u8,
    dt_sec: f64,
    instantaneous: bool,
    max_t: f64,
) -> Option<ProjectileReflectorHit> {
    let pool = shield_pool();
    let count = pool.count as usize;
    if count == 0 {
        return None;
    }

    let mut best_t = max_t;
    let mut best: Option<ProjectileReflectorHit> = None;
    for i in 0..count {
        // Whole-entity exclusion (exclude_panel_index < 0): callers use
        // this after a field bounce so the next segment does not
        // immediately re-resolve against that same field. Beam launch
        // does not pass the source entity here; it excludes only the
        // firing body on the TypeScript side, so a turret inside its own
        // active field still reflects when the ray exits that field.
        // A panel-scoped exclusion (>= 0) leaves the entity's field
        // surfaces testable.
        if exclude_panel_index < 0 && pool.owner_entity_id[i] == exclude_entity_id {
            continue;
        }
        let reflection_mode = shield_reflection_mode_for_entity(
            reflection_entity,
            pool.field_reflection_mode_plasma[i],
            pool.field_reflection_mode_rocket[i],
            pool.field_reflection_mode_beam[i],
            pool.field_reflection_mode_laser[i],
        );
        let static_contact = shield_projectile_intersection_contact(
            start_x,
            start_y,
            start_z,
            end_x,
            end_y,
            end_z,
            pool.center_x[i],
            pool.center_y[i],
            pool.center_z[i],
            pool.axis_end_x[i],
            pool.axis_end_y[i],
            pool.axis_end_z[i],
            pool.radius[i],
            projectile_radius,
            pool.field_shape[i],
            reflection_mode,
        );
        let candidate = if let Some(contact) = static_contact {
            if contact.t >= best_t {
                None
            } else {
                let t = contact.t;
                let dx = end_x - start_x;
                let dy = end_y - start_y;
                let dz = end_z - start_z;
                let hit_x = start_x + dx * t;
                let hit_y = start_y + dy * t;
                let hit_z = start_z + dz * t;
                let mut normal_x = hit_x - pool.center_x[i];
                let mut normal_y = hit_y - pool.center_y[i];
                let mut normal_z =
                    if pool.field_shape[i] == SHIELD_FIELD_SHAPE_INFINITE_VERTICAL_CYLINDER {
                        0.0
                    } else {
                        hit_z - pool.center_z[i]
                    };
                if pool.field_shape[i] == SHIELD_FIELD_SHAPE_AIMED_CYLINDER {
                    let axis_x = pool.axis_end_x[i] - pool.center_x[i];
                    let axis_y = pool.axis_end_y[i] - pool.center_y[i];
                    let axis_z = pool.axis_end_z[i] - pool.center_z[i];
                    let axis_len = (axis_x * axis_x + axis_y * axis_y + axis_z * axis_z).sqrt();
                    if axis_len > 1e-9 {
                        let ux = axis_x / axis_len;
                        let uy = axis_y / axis_len;
                        let uz = axis_z / axis_len;
                        let rel_x = hit_x - pool.center_x[i];
                        let rel_y = hit_y - pool.center_y[i];
                        let rel_z = hit_z - pool.center_z[i];
                        let axial = rel_x * ux + rel_y * uy + rel_z * uz;
                        normal_x = rel_x - ux * axial;
                        normal_y = rel_y - uy * axial;
                        normal_z = rel_z - uz * axial;
                    }
                }
                let normal_len =
                    (normal_x * normal_x + normal_y * normal_y + normal_z * normal_z).sqrt();
                let inv_normal_len = if normal_len > 1e-9 {
                    1.0 / normal_len
                } else {
                    1.0
                };
                normal_x *= inv_normal_len;
                normal_y *= inv_normal_len;
                normal_z *= inv_normal_len;
                let (surface_velocity_x, surface_velocity_y, surface_velocity_z) =
                    shield_field_surface_velocity(
                        hit_x,
                        hit_y,
                        hit_z,
                        normal_x,
                        normal_y,
                        normal_z,
                        contact.threshold,
                        pool.prev_center_x[i],
                        pool.prev_center_y[i],
                        pool.prev_center_z[i],
                        pool.prev_axis_end_x[i],
                        pool.prev_axis_end_y[i],
                        pool.prev_axis_end_z[i],
                        pool.center_x[i],
                        pool.center_y[i],
                        pool.center_z[i],
                        pool.axis_end_x[i],
                        pool.axis_end_y[i],
                        pool.axis_end_z[i],
                        pool.radius[i],
                        pool.field_shape[i],
                        dt_sec,
                    );
                Some(ProjectileReflectorHit {
                    kind: REFLECTOR_HIT_KIND_SHIELD,
                    entity_id: pool.owner_entity_id[i],
                    panel_index: -1,
                    t,
                    x: hit_x,
                    y: hit_y,
                    z: hit_z,
                    normal_x,
                    normal_y,
                    normal_z,
                    surface_velocity_x,
                    surface_velocity_y,
                    surface_velocity_z,
                })
            }
        } else if instantaneous {
            // Instantaneous rays (beams/lasers) resolve against the
            // current pose only. The swept prev->cur fallback below
            // exists for traveling projectiles that cross the tick; for
            // a ray it would evaluate the shield at last tick's pose
            // along the path and has no start-graze rejection, so a
            // bounced segment starting on the surface could spuriously
            // re-reflect — a second interaction that alternates with
            // the static reflect.
            None
        } else {
            shield_projectile_moving_field_hit(
                start_x,
                start_y,
                start_z,
                end_x,
                end_y,
                end_z,
                pool.prev_center_x[i],
                pool.prev_center_y[i],
                pool.prev_center_z[i],
                pool.prev_axis_end_x[i],
                pool.prev_axis_end_y[i],
                pool.prev_axis_end_z[i],
                pool.center_x[i],
                pool.center_y[i],
                pool.center_z[i],
                pool.axis_end_x[i],
                pool.axis_end_y[i],
                pool.axis_end_z[i],
                pool.radius[i],
                projectile_radius,
                pool.field_shape[i],
                reflection_mode,
                pool.owner_entity_id[i],
                dt_sec,
            )
        };
        let Some(hit) = candidate else {
            continue;
        };
        if hit.t >= best_t {
            continue;
        }
        best_t = hit.t;
        best = Some(hit);
    }
    best
}

/// Direct-segment shield clearance. Returns 1 if the segment
/// (sx, sy, sz) → (tx, ty, tz) crosses at most `max_crossings` shield
/// surface boundaries, 0 otherwise. Endpoint grazes (within
/// SHIELD_GRAZE_EPS) don't count.
///
/// Materials Are Independent Of Shape: this one kernel checks both
/// shield shapes against a single crossing budget. Spheres and flat
/// panels are the same material, so a crossing of either counts the same.
/// `include_spheres` / `include_panels` let a caller restrict the query to
/// shapes currently enabled by battle toggles.
#[wasm_bindgen]
pub fn shield_clearance_segment(
    sx: f64,
    sy: f64,
    sz: f64,
    tx: f64,
    ty: f64,
    tz: f64,
    exclude_owner_entity_id: i32,
    max_crossings: u32,
    include_spheres: u8,
    include_panels: u8,
) -> u32 {
    let pool = shield_pool();
    let mut crossings: u32 = 0;

    // ── Sphere surfaces ──
    if include_spheres != 0 {
        let count = pool.count as usize;
        let lo = SHIELD_GRAZE_EPS;
        let hi = 1.0 - SHIELD_GRAZE_EPS;
        for i in 0..count {
            if pool.owner_entity_id[i] == exclude_owner_entity_id {
                continue;
            }
            if shield_segment_crosses_field(
                sx,
                sy,
                sz,
                tx,
                ty,
                tz,
                pool.center_x[i],
                pool.center_y[i],
                pool.center_z[i],
                pool.axis_end_x[i],
                pool.axis_end_y[i],
                pool.axis_end_z[i],
                pool.radius[i],
                pool.field_shape[i],
                lo,
                hi,
            ) {
                crossings += 1;
                if crossings > max_crossings {
                    return 0;
                }
            }
        }
    }

    // ── Rect-panel surfaces ──
    if include_panels != 0 {
        let unit_count = pool.unit_count as usize;
        for u in 0..unit_count {
            if pool.unit_id[u] == exclude_owner_entity_id {
                continue;
            }
            let panel_count = pool.panel_count[u] as usize;
            if panel_count == 0 {
                continue;
            }
            let ux = pool.unit_x[u];
            let uy = pool.unit_y[u];
            let uz = pool.unit_z[u];
            let broad_r = pool.unit_broad_radius[u] as f64;
            if point_segment_dist_sq3(ux, uy, uz, sx, sy, sz, tx, ty, tz) > broad_r * broad_r {
                continue;
            }

            let mirror_yaw = pool.mirror_yaw[u] as f64;
            let mirror_pitch = pool.mirror_pitch[u] as f64;
            let cos_yaw = mirror_yaw.cos();
            let sin_yaw = mirror_yaw.sin();
            let cos_pitch = mirror_pitch.cos();
            let sin_pitch = mirror_pitch.sin();

            let pivot_x = pool.pivot_x[u];
            let pivot_y = pool.pivot_y[u];
            let pivot_z = pool.pivot_z[u];

            let panel_start = pool.panel_start[u] as usize;
            for pi in panel_start..panel_start + panel_count {
                // Panel arm extends from pivot along the panel-yaw / pitch
                // direction (same `a(α, β)` formula MirrorPanelHit.ts uses).
                // Per-panel lateral pivot offset goes along the chassis-
                // perpendicular axis, derived from the mirror's yaw on
                // tick (matches JS `perpX = -sinRot; perpY = cosRot`).
                let perp_x = -sin_yaw;
                let perp_y = cos_yaw;
                let offset_y = pool.panel_offset_y[pi] as f64;
                let panel_pivot_x = pivot_x + perp_x * offset_y;
                let panel_pivot_y = pivot_y + perp_y * offset_y;
                let panel_pivot_z = pivot_z;

                // Per-panel yaw composes the mirror turret yaw with the
                // panel's authored angle (typically 0).
                let panel_angle = pool.panel_angle[pi] as f64;
                let panel_yaw = mirror_yaw + panel_angle;
                let panel_cos_yaw = panel_yaw.cos();
                let panel_sin_yaw = panel_yaw.sin();

                let arm_length = pool.panel_arm_length[pi] as f64;
                let pcx = panel_pivot_x + cos_yaw * cos_pitch * arm_length;
                let pcy = panel_pivot_y + sin_yaw * cos_pitch * arm_length;
                let pcz = panel_pivot_z + sin_pitch * arm_length;

                // Panel face normal = arm direction. Using the panel's
                // composed yaw + the mirror pitch matches getMirrorArmDirection.
                let nx = panel_cos_yaw * cos_pitch;
                let ny = panel_sin_yaw * cos_pitch;
                let nz = sin_pitch;

                // Horizontal perpendicular to panel yaw (edge axis); pitch
                // rotates around this axis so it stays in the XY plane.
                let edx = -panel_sin_yaw;
                let edy = panel_cos_yaw;
                let edz = 0.0;

                let half_w = pool.panel_half_width[pi] as f64;
                let base_y = pool.panel_base_y[pi] as f64;
                let top_y = pool.panel_top_y[pi] as f64;
                let half_h = (top_y - base_y) * 0.5;

                let hit_t = ray_tilted_rect_intersection_t(
                    sx, sy, sz, tx, ty, tz, pcx, pcy, pcz, nx, ny, nz, edx, edy, edz, half_w,
                    half_h,
                );
                if let Some(t) = hit_t {
                    if t > FORCE_MATERIAL_GRAZE_EPS && t < 1.0 - FORCE_MATERIAL_GRAZE_EPS {
                        crossings += 1;
                        if crossings > max_crossings {
                            return 0;
                        }
                    }
                }
            }
        }
    }

    1
}

/// Ballistic-arc shield clearance. Approximates the parabola
/// `pos = launch + v·t − 0.5·GRAVITY·ẑ·t²` with
/// ARC_FF_CLEARANCE_SAMPLES chords and reports the same boundary-
/// crossing budget as the segment kernel. Staying inside one field for
/// the whole arc is clear; only crossing a boundary is blocked.
#[wasm_bindgen]
pub fn shield_clearance_arc(
    launch_x: f64,
    launch_y: f64,
    launch_z: f64,
    launch_vx: f64,
    launch_vy: f64,
    launch_vz: f64,
    flight_time: f64,
    exclude_owner_entity_id: i32,
    max_crossings: u32,
) -> u32 {
    let pool = shield_pool();
    let count = pool.count as usize;
    if count == 0 {
        return 1;
    }
    if !flight_time.is_finite() || flight_time <= 0.0 {
        return 1;
    }
    let inv_n = 1.0 / ARC_FF_CLEARANCE_SAMPLES as f64;
    let mut crossings: u32 = 0;
    for f in 0..count {
        if pool.owner_entity_id[f] == exclude_owner_entity_id {
            continue;
        }
        let cx = pool.center_x[f];
        let cy = pool.center_y[f];
        let cz = pool.center_z[f];
        let r = pool.radius[f];
        let mut crossed = false;
        let mut prev_x = launch_x;
        let mut prev_y = launch_y;
        let mut prev_z = launch_z;
        for i in 1..=ARC_FF_CLEARANCE_SAMPLES {
            let t_norm = i as f64 * inv_n;
            let t = t_norm * flight_time;
            let x = launch_x + launch_vx * t;
            let y = launch_y + launch_vy * t;
            let z = launch_z + launch_vz * t - 0.5 * GRAVITY * t * t;
            let lo = if i == 1 {
                SHIELD_GRAZE_EPS
            } else {
                -SHIELD_GRAZE_EPS
            };
            let hi = if i == ARC_FF_CLEARANCE_SAMPLES {
                1.0 - SHIELD_GRAZE_EPS
            } else {
                1.0 + SHIELD_GRAZE_EPS
            };
            if shield_segment_crosses_field(
                prev_x,
                prev_y,
                prev_z,
                x,
                y,
                z,
                cx,
                cy,
                cz,
                pool.axis_end_x[f],
                pool.axis_end_y[f],
                pool.axis_end_z[f],
                r,
                pool.field_shape[f],
                lo,
                hi,
            ) {
                crossed = true;
                break;
            }
            prev_x = x;
            prev_y = y;
            prev_z = z;
        }
        if crossed {
            crossings += 1;
            if crossings > max_crossings {
                return 0;
            }
        }
    }
    1
}

// ─────────────────────────────────────────────────────────────────
// AIM-08.5 — Rect-panel surface setters
//
// The flat-panel shield shape is stamped into the same
// ShieldSurfacePool the sphere shape uses, through the per-unit +
// per-panel arrays:
//
//   Per-mirror-unit data: world pose, broadphase radius, slope-aware
//   mirror turret pivot, and a [panel_start, panel_count) range into
//   the per-panel data.
//
//   Per-panel data: panel geometry (arm length, lateral offset, panel
//   yaw offset, base/top Y in chassis-local space, half-width).
//
// The clearance kernel walks every unit's broadphase first, then
// dispatches to the per-panel ray-tilted-rect test for each panel.
// Crossings within FORCE_MATERIAL_GRAZE_EPS of either segment endpoint
// don't count, matching the JS-side `hasForceMirrorPanelClearance`
// behaviour so turret pose and lock-on point flicker the same way
// regardless of which path computed the gate.
// ─────────────────────────────────────────────────────────────────

pub(crate) const FORCE_MATERIAL_GRAZE_EPS: f64 = 1e-6;

#[wasm_bindgen]
pub fn shield_panel_pool_set_unit_count(count: u32) {
    let pool = shield_pool();
    pool.ensure_unit_capacity(count);
    pool.unit_count = count;
}

#[wasm_bindgen]
pub fn shield_panel_pool_set_panel_count(count: u32) {
    let pool = shield_pool();
    pool.ensure_panel_capacity(count);
    pool.total_panels = count;
    pool.panel_reflection_entity_mask = 0;
}

#[wasm_bindgen]
pub fn shield_panel_pool_set_unit(
    idx: u32,
    unit_id: i32,
    unit_x: f64,
    unit_y: f64,
    unit_z: f64,
    unit_ground_z: f64,
    unit_broad_radius: f32,
    mirror_yaw: f32,
    mirror_pitch: f32,
    pivot_x: f64,
    pivot_y: f64,
    pivot_z: f64,
    panel_start: u32,
    panel_count: u8,
) {
    let pool = shield_pool();
    pool.ensure_unit_capacity(idx + 1);
    let i = idx as usize;
    pool.unit_id[i] = unit_id;
    pool.unit_x[i] = unit_x;
    pool.unit_y[i] = unit_y;
    pool.unit_z[i] = unit_z;
    pool.unit_ground_z[i] = unit_ground_z;
    pool.unit_broad_radius[i] = unit_broad_radius;
    pool.mirror_yaw[i] = mirror_yaw;
    pool.mirror_pitch[i] = mirror_pitch;
    pool.pivot_x[i] = pivot_x;
    pool.pivot_y[i] = pivot_y;
    pool.pivot_z[i] = pivot_z;
    pool.panel_start[i] = panel_start;
    pool.panel_count[i] = panel_count;
}

#[wasm_bindgen]
pub fn shield_panel_pool_set_panel(
    idx: u32,
    arm_length: f32,
    offset_y: f32,
    panel_angle: f32,
    base_y: f32,
    top_y: f32,
    half_width: f32,
    reflection_mode_plasma: u8,
    reflection_mode_rocket: u8,
    reflection_mode_beam: u8,
    reflection_mode_laser: u8,
) {
    let pool = shield_pool();
    pool.ensure_panel_capacity(idx + 1);
    let i = idx as usize;
    pool.panel_arm_length[i] = arm_length;
    pool.panel_offset_y[i] = offset_y;
    pool.panel_angle[i] = panel_angle;
    pool.panel_base_y[i] = base_y;
    pool.panel_top_y[i] = top_y;
    pool.panel_half_width[i] = half_width;
    pool.panel_reflection_mode_plasma[i] = reflection_mode_plasma;
    pool.panel_reflection_mode_rocket[i] = reflection_mode_rocket;
    pool.panel_reflection_mode_beam[i] = reflection_mode_beam;
    pool.panel_reflection_mode_laser[i] = reflection_mode_laser;
    pool.panel_reflection_entity_mask |= shield_reflection_entity_mask_from_modes(
        reflection_mode_plasma,
        reflection_mode_rocket,
        reflection_mode_beam,
        reflection_mode_laser,
    );
}

#[wasm_bindgen]
pub fn shield_panel_pool_set_material_mode(reflection_mode: u8) {
    let pool = shield_pool();
    let count = pool.total_panels as usize;
    pool.panel_reflection_entity_mask = if reflection_mode == SHIELD_REFLECTION_MODE_NONE {
        0
    } else {
        SHIELD_REFLECTION_ENTITY_BIT_PLASMA
            | SHIELD_REFLECTION_ENTITY_BIT_ROCKET
            | SHIELD_REFLECTION_ENTITY_BIT_BEAM
            | SHIELD_REFLECTION_ENTITY_BIT_LASER
    };
    for i in 0..count {
        pool.panel_reflection_mode_plasma[i] = reflection_mode;
        pool.panel_reflection_mode_rocket[i] = reflection_mode;
        pool.panel_reflection_mode_beam[i] = reflection_mode;
        pool.panel_reflection_mode_laser[i] = reflection_mode;
    }
}

/// Squared distance from a point to a 3D segment, used by the
/// mirror-panel broadphase. Mirrors `pointSegmentDistanceSq3` in
/// lineOfSight.ts byte-for-byte.
#[inline]
pub(crate) fn point_segment_dist_sq3(
    px: f64,
    py: f64,
    pz: f64,
    ax: f64,
    ay: f64,
    az: f64,
    bx: f64,
    by: f64,
    bz: f64,
) -> f64 {
    let abx = bx - ax;
    let aby = by - ay;
    let abz = bz - az;
    let len_sq = abx * abx + aby * aby + abz * abz;
    if len_sq <= 1e-9 {
        let dx = px - ax;
        let dy = py - ay;
        let dz = pz - az;
        return dx * dx + dy * dy + dz * dz;
    }
    let t = (((px - ax) * abx + (py - ay) * aby + (pz - az) * abz) / len_sq)
        .max(0.0)
        .min(1.0);
    let cx = ax + abx * t;
    let cy = ay + aby * t;
    let cz = az + abz * t;
    let dx = px - cx;
    let dy = py - cy;
    let dz = pz - cz;
    dx * dx + dy * dy + dz * dz
}

/// Ray-vs-tilted-rectangle intersection T (CollisionHelpers.ts port).
/// Returns `Some(t)` in [0, 1] for the first hit, or `None`.
#[inline]
pub(crate) fn ray_tilted_rect_intersection_t(
    sx: f64,
    sy: f64,
    sz: f64,
    ex: f64,
    ey: f64,
    ez: f64,
    pcx: f64,
    pcy: f64,
    pcz: f64,
    nx: f64,
    ny: f64,
    nz: f64,
    edx: f64,
    edy: f64,
    edz: f64,
    half_w: f64,
    half_h: f64,
) -> Option<f64> {
    let dx = ex - sx;
    let dy = ey - sy;
    let dz = ez - sz;
    let denom = dx * nx + dy * ny + dz * nz;
    if denom.abs() < 1e-9 {
        return None;
    }
    let t = ((pcx - sx) * nx + (pcy - sy) * ny + (pcz - sz) * nz) / denom;
    if !(0.0..=1.0).contains(&t) {
        return None;
    }
    let hx = sx + t * dx;
    let hy = sy + t * dy;
    let hz = sz + t * dz;
    let lx = hx - pcx;
    let ly = hy - pcy;
    let lz = hz - pcz;
    let along = lx * edx + ly * edy + lz * edz;
    if along < -half_w || along > half_w {
        return None;
    }
    // up-in-plane axis = n × ed
    let ux = ny * edz - nz * edy;
    let uy = nz * edx - nx * edz;
    let uz = nx * edy - ny * edx;
    let up = lx * ux + ly * uy + lz * uz;
    if up < -half_h || up > half_h {
        return None;
    }
    Some(t)
}

// The rect-panel sightline walk now lives inside the unified
// `shield_clearance_segment` (gated by `include_panels`); the
// `point_segment_dist_sq3` + `ray_tilted_rect_intersection_t` helpers above
// are shared by that kernel and the projectile-intersection kernel below.

#[inline]
pub(crate) fn shield_panel_projectile_intersection(
    sx: f64,
    sy: f64,
    sz: f64,
    tx: f64,
    ty: f64,
    tz: f64,
    exclude_unit_id: i32,
    exclude_panel_index: i32,
    _projectile_radius: f64,
    reflection_entity: u8,
    query_pad: f64,
    max_t: f64,
) -> Option<ProjectileReflectorHit> {
    let pool = shield_pool();
    let unit_count = pool.unit_count as usize;
    if unit_count == 0 {
        return None;
    }

    let dx = tx - sx;
    let dy = ty - sy;
    let dz = tz - sz;
    let extra_broad_radius = query_pad.max(0.0);
    let mut best_t = max_t;
    let mut best: Option<ProjectileReflectorHit> = None;

    for u in 0..unit_count {
        // exclude_panel_index < 0 excludes the whole unit (a projectile
        // ignoring its last reflector). >= 0 excludes only that panel,
        // so a reflected beam can still strike the mirror's other
        // panels — matching the beam tracer's re-hit semantics.
        let unit_excluded = pool.unit_id[u] == exclude_unit_id;
        if unit_excluded && exclude_panel_index < 0 {
            continue;
        }
        let panel_count = pool.panel_count[u] as usize;
        if panel_count == 0 {
            continue;
        }
        let ux = pool.unit_x[u];
        let uy = pool.unit_y[u];
        let uz = pool.unit_z[u];
        let broad_r = pool.unit_broad_radius[u] as f64 + extra_broad_radius;
        if point_segment_dist_sq3(ux, uy, uz, sx, sy, sz, tx, ty, tz) > broad_r * broad_r {
            continue;
        }

        let mirror_yaw = pool.mirror_yaw[u] as f64;
        let mirror_pitch = pool.mirror_pitch[u] as f64;
        let cos_yaw = mirror_yaw.cos();
        let sin_yaw = mirror_yaw.sin();
        let cos_pitch = mirror_pitch.cos();
        let sin_pitch = mirror_pitch.sin();
        let perp_x = -sin_yaw;
        let perp_y = cos_yaw;
        let pivot_x = pool.pivot_x[u];
        let pivot_y = pool.pivot_y[u];
        let pivot_z = pool.pivot_z[u];

        let panel_start = pool.panel_start[u] as usize;
        for pi in panel_start..panel_start + panel_count {
            if unit_excluded && (pi - panel_start) as i32 == exclude_panel_index {
                continue;
            }
            let offset_y = pool.panel_offset_y[pi] as f64;
            let panel_pivot_x = pivot_x + perp_x * offset_y;
            let panel_pivot_y = pivot_y + perp_y * offset_y;
            let panel_pivot_z = pivot_z;

            let panel_angle = pool.panel_angle[pi] as f64;
            let panel_yaw = mirror_yaw + panel_angle;
            let panel_cos_yaw = panel_yaw.cos();
            let panel_sin_yaw = panel_yaw.sin();

            let arm_length = pool.panel_arm_length[pi] as f64;
            let pcx = panel_pivot_x + cos_yaw * cos_pitch * arm_length;
            let pcy = panel_pivot_y + sin_yaw * cos_pitch * arm_length;
            let pcz = panel_pivot_z + sin_pitch * arm_length;

            let nx = panel_cos_yaw * cos_pitch;
            let ny = panel_sin_yaw * cos_pitch;
            let nz = sin_pitch;

            let edx = -panel_sin_yaw;
            let edy = panel_cos_yaw;
            let edz = 0.0;

            let half_w = pool.panel_half_width[pi] as f64;
            let base_y = pool.panel_base_y[pi] as f64;
            let top_y = pool.panel_top_y[pi] as f64;
            let half_h = (top_y - base_y) * 0.5;

            let normal_velocity = dx * nx + dy * ny + dz * nz;
            let reflection_mode = shield_reflection_mode_for_entity(
                reflection_entity,
                pool.panel_reflection_mode_plasma[pi],
                pool.panel_reflection_mode_rocket[pi],
                pool.panel_reflection_mode_beam[pi],
                pool.panel_reflection_mode_laser[pi],
            );
            if !shield_reflection_mode_allows_crossing(reflection_mode, normal_velocity) {
                continue;
            }
            let Some(t) = ray_tilted_rect_intersection_t(
                sx, sy, sz, tx, ty, tz, pcx, pcy, pcz, nx, ny, nz, edx, edy, edz, half_w, half_h,
            ) else {
                continue;
            };
            if t >= best_t {
                continue;
            }
            best_t = t;
            best = Some(ProjectileReflectorHit {
                kind: REFLECTOR_HIT_KIND_SHIELD,
                entity_id: pool.unit_id[u],
                panel_index: (pi - panel_start) as i32,
                t,
                x: sx + t * dx,
                y: sy + t * dy,
                z: sz + t * dz,
                normal_x: nx,
                normal_y: ny,
                normal_z: nz,
                surface_velocity_x: 0.0,
                surface_velocity_y: 0.0,
                surface_velocity_z: 0.0,
            });
        }
    }

    best
}

/// WASM-PROJ-01/02 — batch projectile reflector intersections.
///
/// TypeScript compacts projectile sweeps into parallel arrays, calls this
/// once, then consumes the nearest reflector hit for each projectile. The
/// kernel reads the current mirror-panel and shield slabs, so the JS
/// collision path no longer walks every mirror unit or shield sphere per
/// projectile.
#[wasm_bindgen]
pub fn projectile_reflector_intersections_batch(
    count: u32,
    enabled: &[u8],
    start_x: &[f64],
    start_y: &[f64],
    start_z: &[f64],
    end_x: &[f64],
    end_y: &[f64],
    end_z: &[f64],
    projectile_radius: &[f64],
    reflection_entity: &[u8],
    exclude_entity_id: &[i32],
    exclude_panel_index: &[i32],
    turret_shield_panels_enabled: u8,
    turret_shield_spheres_enabled: u8,
    instantaneous_rays: u8,
    shield_panel_query_pad: f64,
    dt_ms: f64,
    out_kind: &mut [u8],
    out_entity_id: &mut [i32],
    out_panel_index: &mut [i32],
    out_t: &mut [f64],
    out_x: &mut [f64],
    out_y: &mut [f64],
    out_z: &mut [f64],
    out_normal_x: &mut [f64],
    out_normal_y: &mut [f64],
    out_normal_z: &mut [f64],
    out_reflect_dir_x: &mut [f64],
    out_reflect_dir_y: &mut [f64],
    out_reflect_dir_z: &mut [f64],
    out_surface_velocity_x: &mut [f64],
    out_surface_velocity_y: &mut [f64],
    out_surface_velocity_z: &mut [f64],
) {
    let n = count as usize;
    debug_assert!(enabled.len() >= n);
    debug_assert!(start_x.len() >= n);
    debug_assert!(start_y.len() >= n);
    debug_assert!(start_z.len() >= n);
    debug_assert!(end_x.len() >= n);
    debug_assert!(end_y.len() >= n);
    debug_assert!(end_z.len() >= n);
    debug_assert!(projectile_radius.len() >= n);
    debug_assert!(reflection_entity.len() >= n);
    debug_assert!(exclude_entity_id.len() >= n);
    debug_assert!(exclude_panel_index.len() >= n);
    debug_assert!(out_kind.len() >= n);
    debug_assert!(out_entity_id.len() >= n);
    debug_assert!(out_panel_index.len() >= n);
    debug_assert!(out_t.len() >= n);
    debug_assert!(out_reflect_dir_x.len() >= n);
    debug_assert!(out_reflect_dir_y.len() >= n);
    debug_assert!(out_reflect_dir_z.len() >= n);
    debug_assert!(out_x.len() >= n);
    debug_assert!(out_y.len() >= n);
    debug_assert!(out_z.len() >= n);
    debug_assert!(out_normal_x.len() >= n);
    debug_assert!(out_normal_y.len() >= n);
    debug_assert!(out_normal_z.len() >= n);
    debug_assert!(out_surface_velocity_x.len() >= n);
    debug_assert!(out_surface_velocity_y.len() >= n);
    debug_assert!(out_surface_velocity_z.len() >= n);

    let dt_sec = if dt_ms.is_finite() {
        dt_ms.max(0.0) / 1000.0
    } else {
        0.0
    };
    let (panel_reflection_entity_mask, field_reflection_entity_mask) = {
        let pool = shield_pool();
        (
            pool.panel_reflection_entity_mask,
            pool.field_reflection_entity_mask,
        )
    };

    for i in 0..n {
        out_kind[i] = REFLECTOR_HIT_KIND_NONE;
        out_entity_id[i] = -1;
        out_panel_index[i] = -1;
        out_t[i] = f64::INFINITY;
        out_x[i] = 0.0;
        out_y[i] = 0.0;
        out_z[i] = 0.0;
        out_normal_x[i] = 0.0;
        out_normal_y[i] = 0.0;
        out_normal_z[i] = 0.0;
        out_reflect_dir_x[i] = 0.0;
        out_reflect_dir_y[i] = 0.0;
        out_reflect_dir_z[i] = 0.0;
        out_surface_velocity_x[i] = 0.0;
        out_surface_velocity_y[i] = 0.0;
        out_surface_velocity_z[i] = 0.0;

        if enabled[i] == 0 {
            continue;
        }

        let sx = start_x[i];
        let sy = start_y[i];
        let sz = start_z[i];
        let tx = end_x[i];
        let ty = end_y[i];
        let tz = end_z[i];
        let radius = projectile_radius[i];
        let reflection_entity = reflection_entity[i];
        if !(sx.is_finite()
            && sy.is_finite()
            && sz.is_finite()
            && tx.is_finite()
            && ty.is_finite()
            && tz.is_finite()
            && radius.is_finite())
        {
            continue;
        }

        let reflection_entity_bit = shield_reflection_entity_bit(reflection_entity);
        if reflection_entity_bit == 0 {
            continue;
        }
        let panels_reflect_entity = turret_shield_panels_enabled != 0
            && (panel_reflection_entity_mask & reflection_entity_bit) != 0;
        let fields_reflect_entity = turret_shield_spheres_enabled != 0
            && (field_reflection_entity_mask & reflection_entity_bit) != 0;
        if !panels_reflect_entity && !fields_reflect_entity {
            continue;
        }

        let mut best: Option<ProjectileReflectorHit> = None;
        if panels_reflect_entity {
            best = shield_panel_projectile_intersection(
                sx,
                sy,
                sz,
                tx,
                ty,
                tz,
                exclude_entity_id[i],
                exclude_panel_index[i],
                radius,
                reflection_entity,
                shield_panel_query_pad,
                f64::INFINITY,
            );
        }
        let max_t = best.as_ref().map(|hit| hit.t).unwrap_or(f64::INFINITY);
        if fields_reflect_entity {
            if let Some(force_hit) = shield_projectile_intersection(
                sx,
                sy,
                sz,
                tx,
                ty,
                tz,
                exclude_entity_id[i],
                exclude_panel_index[i],
                radius,
                reflection_entity,
                dt_sec,
                instantaneous_rays != 0,
                max_t,
            ) {
                best = Some(force_hit);
            }
        }

        let Some(hit) = best else {
            continue;
        };
        out_kind[i] = hit.kind;
        out_entity_id[i] = hit.entity_id;
        out_panel_index[i] = hit.panel_index;
        out_t[i] = hit.t;
        out_x[i] = hit.x;
        out_y[i] = hit.y;
        out_z[i] = hit.z;
        out_normal_x[i] = hit.normal_x;
        out_normal_y[i] = hit.normal_y;
        out_normal_z[i] = hit.normal_z;
        // Reflected SEGMENT direction (unnormalized scale carried by the
        // caller): the one shared mirror formula, so beams and shots can
        // never disagree on the bounce.
        if let Some((rdx, rdy, rdz)) = reflect_about_normal(
            tx - sx,
            ty - sy,
            tz - sz,
            hit.normal_x,
            hit.normal_y,
            hit.normal_z,
        ) {
            let len = (rdx * rdx + rdy * rdy + rdz * rdz).sqrt();
            if len > 1e-12 {
                out_reflect_dir_x[i] = rdx / len;
                out_reflect_dir_y[i] = rdy / len;
                out_reflect_dir_z[i] = rdz / len;
            }
        }
        out_surface_velocity_x[i] = hit.surface_velocity_x;
        out_surface_velocity_y[i] = hit.surface_velocity_y;
        out_surface_velocity_z[i] = hit.surface_velocity_z;
    }
}

/// C1 projectile migration — reflection response for projectile bodies.
///
/// TypeScript still owns entity/event write-back, but the authoritative
/// numeric consequence of a reflector hit lives here: reflected velocity,
/// post-reflection position for the unused portion of the tick, and optional
/// facing rotation. Rows with invalid input or zero-length velocity/normal
/// report `out_reflected = 0`.
#[wasm_bindgen]
pub fn projectile_reflection_response_batch(
    count: u32,
    enabled: &[u8],
    hit_t: &[f64],
    hit_x: &[f64],
    hit_y: &[f64],
    hit_z: &[f64],
    velocity_x: &[f64],
    velocity_y: &[f64],
    velocity_z: &[f64],
    normal_x: &[f64],
    normal_y: &[f64],
    normal_z: &[f64],
    surface_velocity_x: &[f64],
    surface_velocity_y: &[f64],
    surface_velocity_z: &[f64],
    projectile_radius: &[f64],
    dt_ms: f64,
    reflectivity: f64,
    out_reflected: &mut [u8],
    out_pos_x: &mut [f64],
    out_pos_y: &mut [f64],
    out_pos_z: &mut [f64],
    out_velocity_x: &mut [f64],
    out_velocity_y: &mut [f64],
    out_velocity_z: &mut [f64],
    out_rotation_changed: &mut [u8],
    out_rotation: &mut [f64],
) -> u32 {
    let n = count as usize;
    if enabled.len() < n
        || hit_t.len() < n
        || hit_x.len() < n
        || hit_y.len() < n
        || hit_z.len() < n
        || velocity_x.len() < n
        || velocity_y.len() < n
        || velocity_z.len() < n
        || normal_x.len() < n
        || normal_y.len() < n
        || normal_z.len() < n
        || surface_velocity_x.len() < n
        || surface_velocity_y.len() < n
        || surface_velocity_z.len() < n
        || projectile_radius.len() < n
        || out_reflected.len() < n
        || out_pos_x.len() < n
        || out_pos_y.len() < n
        || out_pos_z.len() < n
        || out_velocity_x.len() < n
        || out_velocity_y.len() < n
        || out_velocity_z.len() < n
        || out_rotation_changed.len() < n
        || out_rotation.len() < n
    {
        return 0;
    }
    if !(dt_ms.is_finite() && reflectivity.is_finite()) {
        return 0;
    }

    let dt_sec = dt_ms.max(0.0) / 1000.0;
    let reflectivity = reflectivity.max(0.0);
    let mut processed = 0u32;

    for i in 0..n {
        out_reflected[i] = 0;
        out_pos_x[i] = 0.0;
        out_pos_y[i] = 0.0;
        out_pos_z[i] = 0.0;
        out_velocity_x[i] = 0.0;
        out_velocity_y[i] = 0.0;
        out_velocity_z[i] = 0.0;
        out_rotation_changed[i] = 0;
        out_rotation[i] = 0.0;

        if enabled[i] == 0 {
            continue;
        }

        let t = hit_t[i];
        let hx = hit_x[i];
        let hy = hit_y[i];
        let hz = hit_z[i];
        let vx = velocity_x[i];
        let vy = velocity_y[i];
        let vz = velocity_z[i];
        let nx_raw = normal_x[i];
        let ny_raw = normal_y[i];
        let nz_raw = normal_z[i];
        let svx = surface_velocity_x[i];
        let svy = surface_velocity_y[i];
        let svz = surface_velocity_z[i];
        let radius = projectile_radius[i];
        if !(t.is_finite()
            && hx.is_finite()
            && hy.is_finite()
            && hz.is_finite()
            && vx.is_finite()
            && vy.is_finite()
            && vz.is_finite()
            && nx_raw.is_finite()
            && ny_raw.is_finite()
            && nz_raw.is_finite()
            && svx.is_finite()
            && svy.is_finite()
            && svz.is_finite()
            && radius.is_finite())
        {
            continue;
        }

        let rel_vx = vx - svx;
        let rel_vy = vy - svy;
        let rel_vz = vz - svz;
        let rel_speed_sq = rel_vx * rel_vx + rel_vy * rel_vy + rel_vz * rel_vz;
        // Same shared mirror formula the beam tracer uses — beams,
        // plasma, and rockets cannot drift apart on reflection math.
        let Some((mut reflected_rel_x, mut reflected_rel_y, mut reflected_rel_z)) =
            reflect_about_normal(rel_vx, rel_vy, rel_vz, nx_raw, ny_raw, nz_raw)
        else {
            continue;
        };
        // Unit normal for the surface-offset push below (the helper
        // returning Some guarantees the normal is non-degenerate).
        let inv_normal_len = 1.0 / (nx_raw * nx_raw + ny_raw * ny_raw + nz_raw * nz_raw).sqrt();
        let nx = nx_raw * inv_normal_len;
        let ny = ny_raw * inv_normal_len;
        let nz = nz_raw * inv_normal_len;
        let reflected_len_sq = reflected_rel_x * reflected_rel_x
            + reflected_rel_y * reflected_rel_y
            + reflected_rel_z * reflected_rel_z;
        if reflected_len_sq <= 1e-18 {
            continue;
        }

        let scale = rel_speed_sq.sqrt() * reflectivity / reflected_len_sq.sqrt();
        reflected_rel_x *= scale;
        reflected_rel_y *= scale;
        reflected_rel_z *= scale;
        let rx = svx + reflected_rel_x;
        let ry = svy + reflected_rel_y;
        let rz = svz + reflected_rel_z;

        let remaining_sec = (dt_sec * (1.0 - t)).max(0.0);
        let surface_offset = 0.5_f64.max(radius.max(0.0) * 0.25);
        let reflected_normal_dot =
            reflected_rel_x * nx + reflected_rel_y * ny + reflected_rel_z * nz;
        let offset_sign = if reflected_normal_dot >= 0.0 {
            1.0
        } else {
            -1.0
        };

        out_reflected[i] = 1;
        out_velocity_x[i] = rx;
        out_velocity_y[i] = ry;
        out_velocity_z[i] = rz;
        out_pos_x[i] = hx + nx * surface_offset * offset_sign + rx * remaining_sec;
        out_pos_y[i] = hy + ny * surface_offset * offset_sign + ry * remaining_sec;
        out_pos_z[i] = hz + nz * surface_offset * offset_sign + rz * remaining_sec;

        if (rx * rx + ry * ry).sqrt() > 1e-6 {
            out_rotation_changed[i] = 1;
            out_rotation[i] = ry.atan2(rx);
        }
        processed += 1;
    }

    processed
}

#[inline]
pub(crate) fn projectile_submunition_rng_next(seed: &mut u32) -> f64 {
    *seed = seed.wrapping_add(0x6D2B79F5);
    let mut t = *seed;
    t = (t ^ (t >> 15)).wrapping_mul(t | 1);
    t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
    ((t ^ (t >> 14)) as f64) / 4294967296.0
}

pub(crate) fn projectile_submunition_unit_jitter(seed: &mut u32) -> (f64, f64, f64) {
    for _ in 0..64 {
        let mut x = projectile_submunition_rng_next(seed) * 2.0 - 1.0;
        let mut y = projectile_submunition_rng_next(seed) * 2.0 - 1.0;
        let mut z = projectile_submunition_rng_next(seed) * 2.0 - 1.0;
        let len_sq = x * x + y * y + z * z;
        if len_sq <= 1.0 && len_sq > 1e-6 {
            let inv = 1.0 / len_sq.sqrt();
            x *= inv;
            y *= inv;
            z *= inv;
            return (x, y, z);
        }
    }

    // Degenerate deterministic fallback. The rejection loop should almost
    // never exhaust, but gameplay code must not spin forever on pathological
    // seeds or future RNG changes.
    let angle = projectile_submunition_rng_next(seed) * core::f64::consts::PI * 2.0;
    (angle.cos(), angle.sin(), 0.0)
}

/// C1 projectile migration — deterministic launch velocities for
/// submunition consequences emitted by a parent projectile detonation.
///
/// TypeScript still materializes child projectile entities and network spawn
/// events, but the authoritative numeric consequence (surface reflection,
/// deterministic scatter, and child launch velocities) lives in Rust.
///
/// Two formal direction modes, selected by `has_surface_normal`:
///
/// * **Surface impact** (normal supplied) — the parent hit something. The
///   base velocity is the parent velocity reflected across the surface and
///   damped; each child then adds its scatter jitter and is folded into the
///   outgoing half-space (`v . n >= 0`) by mirroring any into-surface
///   component. Every fragment visibly bounces OFF the surface — none
///   tunnel back into the thing the parent hit.
/// * **In-flight death** (no normal) — the parent was shot down or expired
///   mid-air. The base velocity is the parent velocity unchanged; each
///   child adds its scatter jitter and is folded into the forward
///   half-space about the parent's direction of travel, so the cluster
///   carries the parent's momentum "more or less" while still spreading.
///   A near-stationary parent skips the fold (pure sphere burst).
///
/// The half-space folds mirror the velocity component rather than clamping
/// it, preserving each fragment's speed and the spread's shape.
#[wasm_bindgen]
pub fn projectile_submunition_launch_velocity_batch(
    count: u32,
    seed: u32,
    parent_velocity_x: f64,
    parent_velocity_y: f64,
    parent_velocity_z: f64,
    surface_normal_x: f64,
    surface_normal_y: f64,
    surface_normal_z: f64,
    has_surface_normal: u8,
    reflected_velocity_damper: f64,
    spread_speed_horizontal: f64,
    spread_speed_vertical: f64,
    out_velocity_x: &mut [f64],
    out_velocity_y: &mut [f64],
    out_velocity_z: &mut [f64],
) -> u32 {
    let n = count as usize;
    if out_velocity_x.len() < n || out_velocity_y.len() < n || out_velocity_z.len() < n {
        return 0;
    }
    if !(parent_velocity_x.is_finite()
        && parent_velocity_y.is_finite()
        && parent_velocity_z.is_finite()
        && surface_normal_x.is_finite()
        && surface_normal_y.is_finite()
        && surface_normal_z.is_finite()
        && reflected_velocity_damper.is_finite()
        && spread_speed_horizontal.is_finite()
        && spread_speed_vertical.is_finite())
    {
        return 0;
    }

    // Resolve the mode: a usable surface normal selects the reflection
    // model; otherwise (including a degenerate zero-length normal) the
    // cluster runs the momentum-continuation model.
    let mut fold_x = 0.0;
    let mut fold_y = 0.0;
    let mut fold_z = 0.0;
    let mut has_fold_axis = false;

    let mut bounce_x = parent_velocity_x;
    let mut bounce_y = parent_velocity_y;
    let mut bounce_z = parent_velocity_z;
    if has_surface_normal != 0 {
        let normal_len_sq = surface_normal_x * surface_normal_x
            + surface_normal_y * surface_normal_y
            + surface_normal_z * surface_normal_z;
        if normal_len_sq > 1e-9 {
            let normal_inv = 1.0 / normal_len_sq.sqrt();
            let nx = surface_normal_x * normal_inv;
            let ny = surface_normal_y * normal_inv;
            let nz = surface_normal_z * normal_inv;
            let velocity_dot_normal =
                parent_velocity_x * nx + parent_velocity_y * ny + parent_velocity_z * nz;
            let damper = reflected_velocity_damper.max(0.0);
            bounce_x = (parent_velocity_x - 2.0 * velocity_dot_normal * nx) * damper;
            bounce_y = (parent_velocity_y - 2.0 * velocity_dot_normal * ny) * damper;
            bounce_z = (parent_velocity_z - 2.0 * velocity_dot_normal * nz) * damper;
            fold_x = nx;
            fold_y = ny;
            fold_z = nz;
            has_fold_axis = true;
        }
    }
    if !has_fold_axis {
        let parent_speed_sq = parent_velocity_x * parent_velocity_x
            + parent_velocity_y * parent_velocity_y
            + parent_velocity_z * parent_velocity_z;
        if parent_speed_sq > 1e-9 {
            let inv = 1.0 / parent_speed_sq.sqrt();
            fold_x = parent_velocity_x * inv;
            fold_y = parent_velocity_y * inv;
            fold_z = parent_velocity_z * inv;
            has_fold_axis = true;
        }
    }

    let mut rng_seed = seed;
    let horizontal = spread_speed_horizontal.max(0.0);
    let vertical = spread_speed_vertical.max(0.0);
    for i in 0..n {
        let (jx, jy, jz) = projectile_submunition_unit_jitter(&mut rng_seed);
        let mut vx = bounce_x + horizontal * jx;
        let mut vy = bounce_y + horizontal * jy;
        let mut vz = bounce_z + vertical * jz;
        if has_fold_axis {
            let along = vx * fold_x + vy * fold_y + vz * fold_z;
            if along < 0.0 {
                vx -= 2.0 * along * fold_x;
                vy -= 2.0 * along * fold_y;
                vz -= 2.0 * along * fold_z;
            }
        }
        out_velocity_x[i] = vx;
        out_velocity_y[i] = vy;
        out_velocity_z[i] = vz;
    }

    count
}

pub(crate) const PROJECTILE_TERMINAL_REASON_NONE: u8 = 0;
pub(crate) const PROJECTILE_TERMINAL_REASON_EXPIRED: u8 = 1;
pub(crate) const PROJECTILE_TERMINAL_REASON_GROUND: u8 = 2;
pub(crate) const PROJECTILE_TERMINAL_REASON_WATER: u8 = 3;
pub(crate) const PROJECTILE_TERMINAL_REASON_REFLECTOR: u8 = 4;
pub(crate) const PROJECTILE_TERMINAL_REASON_HEALTH_ZERO: u8 = 5;
pub(crate) const PROJECTILE_TERMINAL_REASON_OUT_OF_BOUNDS: u8 = 6;

pub(crate) const PROJECTILE_TERMINAL_FLAG_REMOVE: u32 = 1 << 0;
pub(crate) const PROJECTILE_TERMINAL_FLAG_SET_HP_ZERO: u32 = 1 << 1;
pub(crate) const PROJECTILE_TERMINAL_FLAG_CLAMP_Z: u32 = 1 << 2;
pub(crate) const PROJECTILE_TERMINAL_FLAG_WATER_SPLASH: u32 = 1 << 3;
pub(crate) const PROJECTILE_TERMINAL_FLAG_DETONATE: u32 = 1 << 4;
pub(crate) const PROJECTILE_TERMINAL_FLAG_EXPIRE_EVENT: u32 = 1 << 5;

pub(crate) const PROJECTILE_TERMINAL_EFFECT_FLAG_QUEUE_DESPAWN: u32 = 1 << 0;
pub(crate) const PROJECTILE_TERMINAL_EFFECT_FLAG_SET_EXPLODED: u32 = 1 << 1;
pub(crate) const PROJECTILE_TERMINAL_EFFECT_FLAG_APPLY_SPLASH: u32 = 1 << 2;
pub(crate) const PROJECTILE_TERMINAL_EFFECT_FLAG_SPAWN_SUBMUNITIONS: u32 = 1 << 3;
pub(crate) const PROJECTILE_TERMINAL_EFFECT_FLAG_EMIT_HIT_EVENT: u32 = 1 << 4;
pub(crate) const PROJECTILE_TERMINAL_EFFECT_FLAG_EMIT_EXPIRE_EVENT: u32 = 1 << 5;
pub(crate) const PROJECTILE_TERMINAL_EFFECT_FLAG_EMIT_WATER_SPLASH_EVENT: u32 = 1 << 6;
pub(crate) const PROJECTILE_TERMINAL_EFFECT_FLAG_EMIT_REFLECTOR_IMPACT_EVENT: u32 = 1 << 7;

/// C1 projectile migration — classify terminal projectile consequences.
///
/// TypeScript still samples terrain/water inputs and applies returned entity,
/// damage, and event diffs. This kernel owns the authoritative branching for
/// timeout, ground/water impact, terminal reflector contacts, HP-zero stops,
/// detonation eligibility, expire FX eligibility, and out-of-bounds removal.
#[wasm_bindgen]
pub fn projectile_terminal_consequence_batch(
    count: u32,
    enabled: &[u8],
    is_projectile_type: &[u8],
    is_armed: &[u8],
    has_exploded: &[u8],
    detonate_on_entity_impact: &[u8],
    detonate_on_ground_contact: &[u8],
    detonate_on_expiry: &[u8],
    detonate_on_destroyed: &[u8],
    detonate_on_reflector_impact: &[u8],
    detonate_on_water_transition: &[u8],
    has_detonation_payload: &[u8],
    direct_hit_this_tick: &[u8],
    reflected_projectile: &[u8],
    hit_shield: &[u8],
    terminal_reflector_hit: &[u8],
    water_at_impact: &[u8],
    water_surface_impact: &[u8],
    water_compatible: &[u8],
    pos_x: &[f64],
    pos_y: &[f64],
    pos_z: &[f64],
    ground_z: &[f64],
    hp: &[f64],
    time_alive_ms: &[f64],
    max_lifespan_ms: &[f64],
    map_width: f64,
    map_height: f64,
    margin: f64,
    out_reason: &mut [u8],
    out_flags: &mut [u32],
    out_z: &mut [f64],
    out_hp: &mut [f64],
) -> u32 {
    let n = count as usize;
    if enabled.len() < n
        || is_projectile_type.len() < n
        || is_armed.len() < n
        || has_exploded.len() < n
        || detonate_on_entity_impact.len() < n
        || detonate_on_ground_contact.len() < n
        || detonate_on_expiry.len() < n
        || detonate_on_destroyed.len() < n
        || detonate_on_reflector_impact.len() < n
        || detonate_on_water_transition.len() < n
        || has_detonation_payload.len() < n
        || direct_hit_this_tick.len() < n
        || reflected_projectile.len() < n
        || hit_shield.len() < n
        || terminal_reflector_hit.len() < n
        || water_at_impact.len() < n
        || water_surface_impact.len() < n
        || water_compatible.len() < n
        || pos_x.len() < n
        || pos_y.len() < n
        || pos_z.len() < n
        || ground_z.len() < n
        || hp.len() < n
        || time_alive_ms.len() < n
        || max_lifespan_ms.len() < n
        || out_reason.len() < n
        || out_flags.len() < n
        || out_z.len() < n
        || out_hp.len() < n
    {
        return 0;
    }

    let bounds_margin = if margin.is_finite() {
        margin.max(0.0)
    } else {
        0.0
    };
    let mut processed = 0_u32;
    for i in 0..n {
        out_reason[i] = PROJECTILE_TERMINAL_REASON_NONE;
        out_flags[i] = 0;
        out_z[i] = pos_z[i];
        out_hp[i] = hp[i];

        if enabled[i] == 0 {
            continue;
        }

        let projectile_body = is_projectile_type[i] != 0;
        let armed = is_armed[i] != 0;
        let already_exploded = has_exploded[i] != 0;
        let expired = time_alive_ms[i] >= max_lifespan_ms[i];

        if projectile_body {
            let terminal_reflector = terminal_reflector_hit[i] != 0;
            let hit_ground = direct_hit_this_tick[i] == 0
                && reflected_projectile[i] == 0
                && hit_shield[i] == 0
                && armed
                && pos_z[i] <= ground_z[i];

            let mut next_hp = hp[i];
            let mut flags = 0_u32;
            let mut next_z = pos_z[i];
            let terminal_water_entry = water_surface_impact[i] != 0;
            if terminal_water_entry && detonate_on_water_transition[i] == 0 {
                next_hp = 0.0;
                flags |= PROJECTILE_TERMINAL_FLAG_SET_HP_ZERO
                    | PROJECTILE_TERMINAL_FLAG_REMOVE
                    | PROJECTILE_TERMINAL_FLAG_WATER_SPLASH;
                out_hp[i] = next_hp;
                out_reason[i] = PROJECTILE_TERMINAL_REASON_WATER;
                out_flags[i] = flags;
                processed += 1;
                continue;
            }
            if terminal_water_entry {
                next_hp = 0.0;
                flags |= PROJECTILE_TERMINAL_FLAG_SET_HP_ZERO;
            }
            if hit_ground {
                next_hp = 0.0;
                next_z = ground_z[i];
                flags |= PROJECTILE_TERMINAL_FLAG_SET_HP_ZERO | PROJECTILE_TERMINAL_FLAG_CLAMP_Z;
            }
            if terminal_reflector || (expired && detonate_on_expiry[i] != 0) {
                next_hp = 0.0;
                flags |= PROJECTILE_TERMINAL_FLAG_SET_HP_ZERO;
            }
            let health_zero = next_hp <= 0.0;

            out_hp[i] = next_hp;
            out_z[i] = next_z;

            if hit_ground
                && water_at_impact[i] != 0
                && water_compatible[i] == 0
                && detonate_on_water_transition[i] == 0
            {
                flags |= PROJECTILE_TERMINAL_FLAG_REMOVE | PROJECTILE_TERMINAL_FLAG_WATER_SPLASH;
                out_reason[i] = PROJECTILE_TERMINAL_REASON_WATER;
                out_flags[i] = flags;
                processed += 1;
                continue;
            }

            if expired || hit_ground || terminal_reflector || terminal_water_entry || health_zero {
                flags |= PROJECTILE_TERMINAL_FLAG_REMOVE;
                out_reason[i] = if terminal_water_entry {
                    PROJECTILE_TERMINAL_REASON_WATER
                } else if terminal_reflector {
                    PROJECTILE_TERMINAL_REASON_REFLECTOR
                } else if hit_ground {
                    PROJECTILE_TERMINAL_REASON_GROUND
                } else if expired {
                    PROJECTILE_TERMINAL_REASON_EXPIRED
                } else {
                    PROJECTILE_TERMINAL_REASON_HEALTH_ZERO
                };

                let policy_detonates = if terminal_water_entry {
                    detonate_on_water_transition[i] != 0
                } else if terminal_reflector {
                    detonate_on_reflector_impact[i] != 0
                } else if hit_ground {
                    detonate_on_ground_contact[i] != 0
                } else if expired {
                    detonate_on_expiry[i] != 0
                } else if direct_hit_this_tick[i] != 0 {
                    detonate_on_entity_impact[i] != 0
                } else {
                    detonate_on_destroyed[i] != 0
                };
                let will_detonate = health_zero
                    && policy_detonates
                    && armed
                    && !already_exploded
                    && has_detonation_payload[i] != 0;
                if will_detonate {
                    flags |= PROJECTILE_TERMINAL_FLAG_DETONATE;
                } else if armed && !already_exploded {
                    flags |= PROJECTILE_TERMINAL_FLAG_EXPIRE_EVENT;
                }

                out_flags[i] = flags;
                processed += 1;
                continue;
            }
        } else if expired {
            out_reason[i] = PROJECTILE_TERMINAL_REASON_EXPIRED;
            out_flags[i] = PROJECTILE_TERMINAL_FLAG_REMOVE;
            processed += 1;
            continue;
        }

        let x = pos_x[i];
        let y = pos_y[i];
        if x < -bounds_margin
            || x > map_width + bounds_margin
            || y < -bounds_margin
            || y > map_height + bounds_margin
        {
            out_reason[i] = PROJECTILE_TERMINAL_REASON_OUT_OF_BOUNDS;
            out_flags[i] = PROJECTILE_TERMINAL_FLAG_REMOVE;
            processed += 1;
        }
    }

    processed
}

/// C1 projectile migration — plan terminal side effects from classified
/// projectile terminal flags and authored payload booleans.
///
/// TypeScript still materializes events, child projectile entities, and JS graph
/// removals, but it no longer re-derives the detonation/splash/submunition/FX
/// consequence shape from a second set of branch conditions. This kernel emits a
/// compact effect bitset for each terminal row.
#[wasm_bindgen]
pub fn projectile_terminal_effect_plan_batch(
    count: u32,
    enabled: &[u8],
    terminal_flags: &[u32],
    terminal_reflector_hit: &[u8],
    has_explosion: &[u8],
    has_submunitions: &[u8],
    out_effect_flags: &mut [u32],
) -> u32 {
    let n = count as usize;
    if enabled.len() < n
        || terminal_flags.len() < n
        || terminal_reflector_hit.len() < n
        || has_explosion.len() < n
        || has_submunitions.len() < n
        || out_effect_flags.len() < n
    {
        return 0;
    }

    let mut processed = 0_u32;
    for i in 0..n {
        out_effect_flags[i] = 0;
        if enabled[i] == 0 {
            continue;
        }

        let terminal = terminal_flags[i];
        if terminal & PROJECTILE_TERMINAL_FLAG_REMOVE == 0 {
            processed += 1;
            continue;
        }

        let mut effects = PROJECTILE_TERMINAL_EFFECT_FLAG_QUEUE_DESPAWN;
        if terminal & PROJECTILE_TERMINAL_FLAG_WATER_SPLASH != 0 {
            effects |= PROJECTILE_TERMINAL_EFFECT_FLAG_EMIT_WATER_SPLASH_EVENT;
            out_effect_flags[i] = effects;
            processed += 1;
            continue;
        }

        if terminal_reflector_hit[i] != 0 {
            effects |= PROJECTILE_TERMINAL_EFFECT_FLAG_EMIT_REFLECTOR_IMPACT_EVENT;
        }

        if terminal & PROJECTILE_TERMINAL_FLAG_DETONATE != 0 {
            let splash = has_explosion[i] != 0;
            let submunitions = has_submunitions[i] != 0;
            if splash || submunitions {
                effects |= PROJECTILE_TERMINAL_EFFECT_FLAG_SET_EXPLODED
                    | PROJECTILE_TERMINAL_EFFECT_FLAG_EMIT_HIT_EVENT;
                if splash {
                    effects |= PROJECTILE_TERMINAL_EFFECT_FLAG_APPLY_SPLASH;
                }
                if submunitions {
                    effects |= PROJECTILE_TERMINAL_EFFECT_FLAG_SPAWN_SUBMUNITIONS;
                }
            }
        }

        if terminal & PROJECTILE_TERMINAL_FLAG_EXPIRE_EVENT != 0 {
            effects |= PROJECTILE_TERMINAL_EFFECT_FLAG_EMIT_EXPIRE_EVENT;
        }

        out_effect_flags[i] = effects;
        processed += 1;
    }

    processed
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_close(actual: f64, expected: f64) {
        assert!(
            (actual - expected).abs() <= 1e-9,
            "expected {expected}, got {actual}"
        );
    }

    #[test]
    fn observation_visibility_collector_compacts_visible_radar_and_los_rows() {
        let _guard = match crate::COMBAT_TARGETING_TEST_LOCK.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        {
            let state = crate::entity_state::entity_state();
            *state = crate::entity_state::EntityStateSlab::empty();
            state.ensure_capacity(3);
            state.entity_id[0] = 10;
            state.kind[0] = crate::entity_state::ENTITY_STATE_KIND_UNIT;
            state.owner_player_id[0] = 1;
            state.entity_id[1] = 11;
            state.kind[1] = crate::entity_state::ENTITY_STATE_KIND_UNIT;
            state.owner_player_id[1] = 2;
            state.entity_id[2] = 12;
            state.kind[2] = crate::entity_state::ENTITY_STATE_KIND_UNIT;
            state.owner_player_id[2] = 2;
            state.entity_id[3] = 13;
            state.kind[3] = crate::entity_state::ENTITY_STATE_KIND_SHOT;
            state.owner_player_id[3] = 2;
        }
        {
            let pool = combat_targeting_pool();
            *pool = CombatTargetingPool::empty();
            pool.ensure_entity_capacity(3);
            pool.entity_id[0] = 10;
            pool.entity_flags[0] = CT_ENTITY_FLAG_ALIVE;
            pool.entity_id[1] = 11;
            pool.entity_flags[1] = CT_ENTITY_FLAG_ALIVE;
            pool.entity_full_sight_coverage_mask[1] = 1;
            pool.entity_id[2] = 12;
            pool.entity_flags[2] = CT_ENTITY_FLAG_ALIVE | CT_ENTITY_FLAG_CLOAKED;
            pool.entity_detector_coverage_mask[2] = 1;
            pool.entity_id[3] = 13;
            pool.entity_flags[3] = CT_ENTITY_FLAG_ALIVE;
            pool.entity_sensor_coverage_mask[3] = 1;
        }

        let mut visible = [0_i32; 4];
        let mut visible_slots = [0_u32; 4];
        let mut radar = [0_i32; 4];
        let mut radar_slots = [0_u32; 4];
        let mut los = [0_u32; 4];
        let mut counts = [0_u32; 4];
        let handled = combat_targeting_collect_observation_visibility(
            1,
            &[],
            &mut visible,
            &mut visible_slots,
            &mut radar,
            &mut radar_slots,
            &mut los,
            &mut counts,
        );

        assert_eq!(handled, 3);
        assert_eq!(counts, [3, 2, 3, 1]);
        assert_eq!(&visible[..2], &[10, 12]);
        assert_eq!(&visible_slots[..2], &[0, 2]);
        assert_eq!(&radar[..3], &[10, 11, 12]);
        assert_eq!(&radar_slots[..3], &[0, 1, 2]);
        assert_eq!(los[0], 1);
    }

    #[test]
    fn panel_centerline_intersection_still_hits_plane() {
        let t = ray_tilted_rect_intersection_t(
            -5.0, 0.0, 0.0, 5.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 1.0, 1.0,
        )
        .unwrap();
        assert_close(t, 0.5);
    }

    #[test]
    fn panel_intersection_ignores_radius_edge_overlap() {
        let centerline = ray_tilted_rect_intersection_t(
            -5.0, 1.4, 0.0, 5.0, 1.4, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 1.0, 1.0,
        );
        assert!(centerline.is_none());
    }

    #[test]
    fn reflection_policy_can_make_plasma_outside_only() {
        let plasma_mode = shield_reflection_mode_for_entity(
            SHIELD_REFLECTION_ENTITY_PLASMA,
            SHIELD_REFLECTION_MODE_OUTSIDE_IN,
            SHIELD_REFLECTION_MODE_BOTH,
            SHIELD_REFLECTION_MODE_BOTH,
            SHIELD_REFLECTION_MODE_BOTH,
        );
        assert!(shield_reflection_mode_allows_crossing(plasma_mode, -1.0));
        assert!(!shield_reflection_mode_allows_crossing(plasma_mode, 1.0));

        let beam_mode = shield_reflection_mode_for_entity(
            SHIELD_REFLECTION_ENTITY_BEAM,
            SHIELD_REFLECTION_MODE_OUTSIDE_IN,
            SHIELD_REFLECTION_MODE_BOTH,
            SHIELD_REFLECTION_MODE_BOTH,
            SHIELD_REFLECTION_MODE_BOTH,
        );
        assert!(shield_reflection_mode_allows_crossing(beam_mode, -1.0));
        assert!(shield_reflection_mode_allows_crossing(beam_mode, 1.0));
    }

    #[test]
    fn reflection_entity_mask_omits_reflect_none_families() {
        let mask = shield_reflection_entity_mask_from_modes(
            SHIELD_REFLECTION_MODE_OUTSIDE_IN,
            SHIELD_REFLECTION_MODE_NONE,
            SHIELD_REFLECTION_MODE_BOTH,
            SHIELD_REFLECTION_MODE_NONE,
        );
        assert_ne!(mask & SHIELD_REFLECTION_ENTITY_BIT_PLASMA, 0);
        assert_eq!(mask & SHIELD_REFLECTION_ENTITY_BIT_ROCKET, 0);
        assert_ne!(mask & SHIELD_REFLECTION_ENTITY_BIT_BEAM, 0);
        assert_eq!(mask & SHIELD_REFLECTION_ENTITY_BIT_LASER, 0);
    }

    #[test]
    fn reflect_none_disables_field_contact_for_selected_entity() {
        let laser_mode = shield_reflection_mode_for_entity(
            SHIELD_REFLECTION_ENTITY_LASER,
            SHIELD_REFLECTION_MODE_OUTSIDE_IN,
            SHIELD_REFLECTION_MODE_OUTSIDE_IN,
            SHIELD_REFLECTION_MODE_OUTSIDE_IN,
            SHIELD_REFLECTION_MODE_NONE,
        );
        let laser_hit = shield_projectile_intersection_contact(
            -10.0,
            0.0,
            0.0,
            10.0,
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
            1.0,
            5.0,
            0.0,
            SHIELD_FIELD_SHAPE_SPHERE,
            laser_mode,
        );
        assert!(laser_hit.is_none());

        let beam_mode = shield_reflection_mode_for_entity(
            SHIELD_REFLECTION_ENTITY_BEAM,
            SHIELD_REFLECTION_MODE_NONE,
            SHIELD_REFLECTION_MODE_NONE,
            SHIELD_REFLECTION_MODE_OUTSIDE_IN,
            SHIELD_REFLECTION_MODE_NONE,
        );
        let beam_hit = shield_projectile_intersection_contact(
            -10.0,
            0.0,
            0.0,
            10.0,
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
            1.0,
            5.0,
            0.0,
            SHIELD_FIELD_SHAPE_SPHERE,
            beam_mode,
        )
        .unwrap();
        assert_close(beam_hit.t, 0.25);
    }
}

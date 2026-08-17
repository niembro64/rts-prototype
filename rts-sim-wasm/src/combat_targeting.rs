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
pub const CT_TURRET_CFG_NON_ATTACK_EMITTER: u32 = 1 << 5;
pub const CT_TURRET_CFG_SHOT_IS_FORCE: u32 = 1 << 6;
pub const CT_TURRET_CFG_HAS_TRACKING_RANGE: u32 = 1 << 7;
/// When set, the turret inherits the host entity's priority target /
/// priority point. When clear (autonomous), priority FSM batches
/// must skip this turret entirely so it keeps running its own
/// independent acquisition.
pub const CT_TURRET_CFG_HOST_CONTROLLED: u32 = 1 << 8;
pub const CT_TURRET_CFG_RANGE_BOTTOM_UNBOUNDED: u32 = 1 << 9;
pub const CT_TURRET_CFG_RANGE_TOP_UNBOUNDED: u32 = 1 << 10;
/// Packed range-mode value for a cylinder capped at the water surface and
/// unbounded below. Bit 10 alone was previously unused; bits 9+10 retain the
/// existing top-and-bottom-unbounded mode.
#[cfg(test)]
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
/// The station's local yaw joint has no hard stops. When clear, targeting
/// must prove the solved world yaw lies inside the authored local envelope.
pub const CT_TURRET_CFG_YAW_CONTINUOUS: u32 = 1 << 16;
/// Host-only and slaved mounts may retain/validate an assigned task but never
/// enter independent auto-acquisition when that task is absent or rejected.
pub const CT_TURRET_CFG_NO_AUTO_ACQUIRE: u32 = 1 << 17;
/// Constant-speed guided munitions solve a velocity intercept before launch.
/// Unlike ballistic aim this uses no gravity or drag, but writes through the
/// same reusable aim-pose fields consumed by turret rotation and firing.
pub const CT_TURRET_CFG_CONSTANT_SPEED_LEAD: u32 = 1 << 18;
/// A bounded local-yaw station may ask a mobile parent joint to absorb its
/// residual yaw, making targets outside the child's initial traverse reachable.
pub const CT_TURRET_CFG_HOST_YAW_ASSIST: u32 = 1 << 19;
/// Exhaustive emission trajectory routes. The source row is selected from the
/// turret mount point each tick; unit/building targets may occupy both columns,
/// while shots and target turrets occupy exactly one. True cells are an
/// unordered set: there is no same-medium preference.
pub const CT_TURRET_CFG_ROUTE_ABOVE_TO_ABOVE: u32 = 1 << 20;
pub const CT_TURRET_CFG_ROUTE_ABOVE_TO_UNDERWATER: u32 = 1 << 21;
pub const CT_TURRET_CFG_ROUTE_UNDERWATER_TO_ABOVE: u32 = 1 << 22;
pub const CT_TURRET_CFG_ROUTE_UNDERWATER_TO_UNDERWATER: u32 = 1 << 23;
pub const CT_TURRET_CFG_ROUTE_MASK: u32 = CT_TURRET_CFG_ROUTE_ABOVE_TO_ABOVE
    | CT_TURRET_CFG_ROUTE_ABOVE_TO_UNDERWATER
    | CT_TURRET_CFG_ROUTE_UNDERWATER_TO_ABOVE
    | CT_TURRET_CFG_ROUTE_UNDERWATER_TO_UNDERWATER;

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
/// Reserved compatibility bit for snapshots authored before static hosts were
/// unified as buildings. New blueprint policy never emits it.
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
/// Reserved compatibility tag. New runtime stamping uses BUILDING.
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
    /// Per-(owner, fact-lane) saturation bits for THIS tick's marking
    /// pass. Bit `owner_index * 6 + lane` set means a completed walk
    /// proved every slot in the cell is already marked-or-impossible
    /// for that owner's lane, so later same-owner sources skip the
    /// whole cell with one mask test. Masks only GAIN bits within a
    /// tick, so saturation is monotone-safe and the final masks are
    /// bit-identical with or without the skip. Lanes: 0 contact@air,
    /// 1 sight@air, 2 detector@air, 3 contact@water, 4 sight@water,
    /// 5 detector@water. Owners past index 7 don't fit and simply
    /// never use the fast path. Reset with the cell each rebuild.
    pub(crate) saturated_fact_bits: u64,
}

pub(crate) struct CombatTargetingPool {
    pub(crate) wind_x: f64,
    pub(crate) wind_y: f64,
    pub(crate) wind_z: f64,
    // Per-entity, indexed by spatial-grid slot.
    pub(crate) entity_id: Vec<i32>,
    pub(crate) entity_owner_player_id: Vec<u8>,
    pub(crate) entity_team_id: Vec<u8>,
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
    // Complementary medium occupancy for every targetable entity. Buildings
    // use their cuboid height and units use their spherical-cap volume. Shots
    // are points and therefore occupy exactly the medium containing pos_z.
    // Mounted turrets are also points and use their turret mount row directly.
    pub(crate) entity_above_water_fraction: Vec<f32>,
    pub(crate) entity_underwater_fraction: Vec<f32>,
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
    // unit/building blueprints. These gate host priority targets before
    // host-controlled turrets apply their own per-turret policy.
    pub(crate) entity_lockon_relationship_mask: Vec<u8>,
    pub(crate) entity_lockon_entity_family_mask: Vec<u8>,
    pub(crate) entity_lockon_building_mask: Vec<u32>,
    pub(crate) entity_lockon_tower_mask: Vec<u32>,
    pub(crate) entity_lockon_unit_mask: Vec<u32>,
    pub(crate) entity_lockon_turret_mask: Vec<u32>,
    pub(crate) entity_lockon_shot_mask: Vec<u32>,
    // Per-host mounted sensor origin plus full-sight/contact radii. The source
    // point is the owning turret mount, never the host body center.
    pub(crate) entity_sensor_source_x: Vec<f64>,
    pub(crate) entity_sensor_source_y: Vec<f64>,
    // Full sight
    // also counts as contact-level coverage because sight is the
    // stronger information tier. Stamped from shared sensor coverage
    // helpers; zero means the entity provides no source for that tier.
    pub(crate) entity_full_vision_above_water_radius: Vec<f32>,
    pub(crate) entity_full_vision_underwater_radius: Vec<f32>,
    pub(crate) entity_radar_radius: Vec<f32>,
    pub(crate) entity_sonar_radius: Vec<f32>,
    pub(crate) entity_detector_above_water_radius: Vec<f32>,
    pub(crate) entity_detector_underwater_radius: Vec<f32>,
    // Four exhaustive, orthogonal team-knowledge facts. These retain the
    // target medium that earned knowledge while remaining independent from
    // every weapon emission's source->target trajectory matrix.
    pub(crate) entity_team_air_sight_mask: Vec<u32>,
    pub(crate) entity_team_water_sight_mask: Vec<u32>,
    pub(crate) entity_team_air_radar_mask: Vec<u32>,
    pub(crate) entity_team_water_sonar_mask: Vec<u32>,
    // Derived unions retained for hot targeting/snapshot consumers.
    pub(crate) entity_sensor_coverage_mask: Vec<u32>,
    // Coverage by FULL-SIGHT sources only (excludes radar/sonar-only sensors). A
    // subset of entity_sensor_coverage_mask. Turrets that require full sight
    // (direct beams / precision line weapons) gate enemy lock-on on this mask
    // so contact-only targets are eligible only for radar-fire weapons.
    pub(crate) entity_full_sight_coverage_mask: Vec<u32>,
    pub(crate) entity_detector_coverage_mask: Vec<u32>,
    pub(crate) observation_cells: HashMap<u64, CombatTargetingObservationCell>,
    pub(crate) observation_cell_keys: Vec<u64>,
    pub(crate) observation_max_detection_padding: f64,
    // Retained in the slab ABI as zero. Visibility is center-only, so
    // target footprint never extends a sight/radar/sonar envelope.
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
    // Mechanical target-admission envelope. Parent yaw is stamped from the
    // same host-piece resolver the child motor consumes.
    pub(crate) turret_parent_yaw: Vec<f64>,
    pub(crate) turret_yaw_min: Vec<f64>,
    pub(crate) turret_yaw_max: Vec<f64>,
    pub(crate) turret_pitch_min: Vec<f64>,
    pub(crate) turret_pitch_max: Vec<f64>,
    // Authoritative host-piece pose carried beside the owning turret. Bot
    // waists use this independently from the faster logical turret axes so
    // presentation can interpolate the exact combat socket between ticks.
    pub(crate) turret_host_piece_yaw: Vec<f32>,
    pub(crate) turret_host_piece_yaw_velocity: Vec<f32>,
    pub(crate) turret_state: Vec<u8>,
    pub(crate) turret_target_id: Vec<i32>,
    // Host-authored attack task for this mount. A failed task lock falls back
    // through normal acquisition without affecting sibling mounts.
    pub(crate) turret_task_target_id: Vec<i32>,
    pub(crate) turret_task_point_active: Vec<u8>,
    // Runtime mount index of the sibling this mount follows, or -1 when the
    // mount is not slaved. Authored ids are resolved to indices by the
    // blueprint/runtime bridge so the deterministic kernel never compares
    // strings.
    pub(crate) turret_slaved_to_mount_index: Vec<i32>,
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
    // (cooldown + shot damage / dps). Zero for non-attack emitter /
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
    // Optional deterministic cadence for a specialist profile to compare a
    // still-valid current target against newly eligible candidates. Zero
    // means ordinary sticky targeting with no periodic rescore.
    pub(crate) turret_target_rescore_period_ticks: Vec<u16>,
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
    /// Distance from the turret pivot to the point the shot is actually
    /// released, measured along the aim direction. The ballistic solve is a
    /// solve for where the projectile LEAVES, and a barrel puts that tens of
    /// units downrange of the pivot the arc used to be solved from — a shell
    /// released that far along its own arc has not fallen yet when it reaches
    /// the target, and passes over the top of it.
    pub(crate) turret_muzzle_forward_offset: Vec<f64>,
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
            entity_team_id: Vec::new(),
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
            entity_above_water_fraction: Vec::new(),
            entity_underwater_fraction: Vec::new(),
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
            entity_sensor_source_x: Vec::new(),
            entity_sensor_source_y: Vec::new(),
            entity_full_vision_above_water_radius: Vec::new(),
            entity_full_vision_underwater_radius: Vec::new(),
            entity_radar_radius: Vec::new(),
            entity_sonar_radius: Vec::new(),
            entity_detector_above_water_radius: Vec::new(),
            entity_detector_underwater_radius: Vec::new(),
            entity_team_air_sight_mask: Vec::new(),
            entity_team_water_sight_mask: Vec::new(),
            entity_team_air_radar_mask: Vec::new(),
            entity_team_water_sonar_mask: Vec::new(),
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
            turret_parent_yaw: Vec::new(),
            turret_yaw_min: Vec::new(),
            turret_yaw_max: Vec::new(),
            turret_pitch_min: Vec::new(),
            turret_pitch_max: Vec::new(),
            turret_host_piece_yaw: Vec::new(),
            turret_host_piece_yaw_velocity: Vec::new(),
            turret_state: Vec::new(),
            turret_target_id: Vec::new(),
            turret_task_target_id: Vec::new(),
            turret_task_point_active: Vec::new(),
            turret_slaved_to_mount_index: Vec::new(),
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
            turret_target_rescore_period_ticks: Vec::new(),
            turret_lockon_relationship_mask: Vec::new(),
            turret_lockon_entity_family_mask: Vec::new(),
            turret_lockon_building_mask: Vec::new(),
            turret_lockon_tower_mask: Vec::new(),
            turret_lockon_unit_mask: Vec::new(),
            turret_lockon_turret_mask: Vec::new(),
            turret_lockon_shot_mask: Vec::new(),
            turret_lockon_reciprocal_mode: Vec::new(),
            turret_muzzle_forward_offset: Vec::new(),
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
            self.entity_team_id.resize(entity_needed, 0);
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
            self.entity_above_water_fraction.resize(entity_needed, 1.0);
            self.entity_underwater_fraction.resize(entity_needed, 0.0);
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
            self.entity_sensor_source_x.resize(entity_needed, 0.0);
            self.entity_sensor_source_y.resize(entity_needed, 0.0);
            self.entity_full_vision_above_water_radius
                .resize(entity_needed, 0.0);
            self.entity_full_vision_underwater_radius
                .resize(entity_needed, 0.0);
            self.entity_radar_radius.resize(entity_needed, 0.0);
            self.entity_sonar_radius.resize(entity_needed, 0.0);
            self.entity_detector_above_water_radius
                .resize(entity_needed, 0.0);
            self.entity_detector_underwater_radius
                .resize(entity_needed, 0.0);
            self.entity_team_air_sight_mask.resize(entity_needed, 0);
            self.entity_team_water_sight_mask.resize(entity_needed, 0);
            self.entity_team_air_radar_mask.resize(entity_needed, 0);
            self.entity_team_water_sonar_mask.resize(entity_needed, 0);
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
            self.turret_parent_yaw.resize(turret_needed, 0.0);
            self.turret_yaw_min
                .resize(turret_needed, -core::f64::consts::PI);
            self.turret_yaw_max
                .resize(turret_needed, core::f64::consts::PI);
            self.turret_pitch_min
                .resize(turret_needed, -core::f64::consts::FRAC_PI_2);
            self.turret_pitch_max
                .resize(turret_needed, core::f64::consts::FRAC_PI_2);
            self.turret_host_piece_yaw.resize(turret_needed, 0.0);
            self.turret_host_piece_yaw_velocity
                .resize(turret_needed, 0.0);
            self.turret_state
                .resize(turret_needed, CT_TURRET_STATE_IDLE);
            self.turret_target_id.resize(turret_needed, -1);
            self.turret_task_target_id.resize(turret_needed, -1);
            self.turret_task_point_active.resize(turret_needed, 0);
            self.turret_slaved_to_mount_index.resize(turret_needed, -1);
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
            self.turret_target_rescore_period_ticks
                .resize(turret_needed, 0);
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
            self.turret_muzzle_forward_offset.resize(turret_needed, 0.0);
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

    pub(crate) fn begin_stamp(&mut self) {
        let max_turrets = COMBAT_TARGETING_MAX_TURRETS_PER_ENTITY as usize;
        let active_len = self.active_entity_slots.len();
        for i in 0..active_len {
            let s = self.active_entity_slots[i] as usize;
            if s >= self.entity_flags.len() {
                continue;
            }
            self.entity_flags[s] = 0;
            self.entity_team_air_sight_mask[s] = 0;
            self.entity_team_water_sight_mask[s] = 0;
            self.entity_team_air_radar_mask[s] = 0;
            self.entity_team_water_sonar_mask[s] = 0;
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
                self.turret_target_rescore_period_ticks[idx] = 0;
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
        combat_targeting_clear_observation_index(self);
    }

    pub(crate) fn clear_all(&mut self) {
        self.begin_stamp();
        self.entity_slot_by_id.clear();
    }

    pub(crate) fn unset_entity(&mut self, entity_slot: u32) {
        let s = entity_slot as usize;
        if s >= self.entity_flags.len() {
            return;
        }
        let old_entity_id = self.entity_id[s];
        if old_entity_id >= 0
            && self.entity_slot_by_id.get(&old_entity_id).copied() == Some(entity_slot)
        {
            self.entity_slot_by_id.remove(&old_entity_id);
        }
        self.entity_flags[s] = 0;
        self.entity_team_air_sight_mask[s] = 0;
        self.entity_team_water_sight_mask[s] = 0;
        self.entity_team_air_radar_mask[s] = 0;
        self.entity_team_water_sonar_mask[s] = 0;
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
            self.turret_target_rescore_period_ticks[idx] = 0;
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

pub(crate) static COMBAT_TARGETING: WasmLazy<CombatTargetingPool> = WasmLazy::new();

#[inline]
pub(crate) fn combat_targeting_pool() -> &'static mut CombatTargetingPool {
    COMBAT_TARGETING.get_or_init(CombatTargetingPool::empty)
}

// AIM-08.5 — per-candidate observability scratch buffer used by the
// candidate-batch kernel. Lives outside the pool so the kernel can
// borrow the pool mutably for ballistic-solver writes while reading
// the observability mask as a separate slice. Resized in-place per
// call; never freed.
pub(crate) static COMBAT_TARGETING_CANDIDATE_OBSERVABLE_SCRATCH: WasmGlobal<Vec<u8>> =
    WasmGlobal::new(Vec::new());

#[inline]
pub(crate) fn combat_targeting_candidate_observable_scratch() -> &'static mut Vec<u8> {
    COMBAT_TARGETING_CANDIDATE_OBSERVABLE_SCRATCH.get()
}

pub(crate) static COMBAT_TARGETING_CANDIDATE_SLOT_SCRATCH: WasmGlobal<Vec<u32>> =
    WasmGlobal::new(Vec::new());

#[inline]
pub(crate) fn combat_targeting_candidate_slot_scratch() -> &'static mut Vec<u32> {
    COMBAT_TARGETING_CANDIDATE_SLOT_SCRATCH.get()
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

pub(crate) static COMBAT_TARGETING_SPATIAL_CANDIDATE_SCRATCH: WasmGlobal<
    CombatTargetingSpatialCandidateScratch,
> = WasmGlobal::new(CombatTargetingSpatialCandidateScratch {
    ids: Vec::new(),
    slots: Vec::new(),
    observable: Vec::new(),
    eligible_turret_mask: Vec::new(),
    pos_x: Vec::new(),
    pos_y: Vec::new(),
    pos_z: Vec::new(),
    radius: Vec::new(),
    shield_panel_score: Vec::new(),
});

#[inline]
pub(crate) fn combat_targeting_spatial_candidate_scratch(
) -> &'static mut CombatTargetingSpatialCandidateScratch {
    COMBAT_TARGETING_SPATIAL_CANDIDATE_SCRATCH.get()
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

/// Begins a new per-tick targeting input stamp while retaining the stable
/// entity-id-to-slot index. Stale entries are excluded by `stamp_epoch`, and
/// slot reuse repairs the index in `combat_targeting_set_entity`.
#[wasm_bindgen]
pub fn combat_targeting_begin_stamp() {
    combat_targeting_pool().begin_stamp();
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
#[inline]
fn combat_targeting_underwater_fraction(pos_z: f64, radius_hitbox: f64, aabb_half_z: f64) -> f32 {
    if !pos_z.is_finite() {
        return 0.0;
    }
    let fraction = if aabb_half_z.is_finite() && aabb_half_z > 0.0 {
        let full_height = 2.0 * aabb_half_z;
        let bottom_z = pos_z - aabb_half_z;
        (TERRAIN_WATER_LEVEL - bottom_z).max(0.0).min(full_height) / full_height
    } else if radius_hitbox.is_finite() && radius_hitbox > 0.0 {
        let submerged_height = (TERRAIN_WATER_LEVEL - (pos_z - radius_hitbox))
            .max(0.0)
            .min(2.0 * radius_hitbox);
        if submerged_height <= 0.0 {
            0.0
        } else if submerged_height >= 2.0 * radius_hitbox {
            1.0
        } else {
            submerged_height * submerged_height * (3.0 * radius_hitbox - submerged_height)
                / (4.0 * radius_hitbox * radius_hitbox * radius_hitbox)
        }
    } else if pos_z <= TERRAIN_WATER_LEVEL {
        1.0
    } else {
        0.0
    };
    fraction.clamp(0.0, 1.0) as f32
}

#[inline]
pub(crate) fn combat_targeting_target_underwater_fraction(
    family: u8,
    pos_z: f64,
    radius_hitbox: f64,
    aabb_half_z: f64,
) -> f32 {
    if family == CT_ENTITY_FAMILY_SHOT {
        if pos_z <= TERRAIN_WATER_LEVEL {
            1.0
        } else {
            0.0
        }
    } else {
        combat_targeting_underwater_fraction(pos_z, radius_hitbox, aabb_half_z)
    }
}

#[wasm_bindgen]
pub fn combat_targeting_set_entity(
    entity_slot: u32,
    entity_id: i32,
    owner_player_id: u8,
    team_id: u8,
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
    sensor_source_x: f64,
    sensor_source_y: f64,
    full_vision_above_water_radius: f32,
    full_vision_underwater_radius: f32,
    radar_radius: f32,
    sonar_radius: f32,
    detector_above_water_radius: f32,
    detector_underwater_radius: f32,
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
    let same_entity = old_entity_id == entity_id;
    if !same_entity {
        if old_entity_id >= 0
            && pool.entity_slot_by_id.get(&old_entity_id).copied() == Some(entity_slot)
        {
            pool.entity_slot_by_id.remove(&old_entity_id);
        }
        if entity_id >= 0 {
            pool.entity_slot_by_id.insert(entity_id, entity_slot);
        }
    } else if entity_id >= 0 && pool.entity_slot_by_id.get(&entity_id).copied() != Some(entity_slot)
    {
        // Rebuild the entry after a hard clear without paying an insertion on
        // every stable restamp.
        pool.entity_slot_by_id.insert(entity_id, entity_slot);
    }
    // Same-entity restamps preserve the slab-owned FSM tuple in the
    // turret rows that follow; slot reuse re-seeds it (see set_turret).
    pool.entity_stamp_same_entity[s] = same_entity as u8;
    pool.entity_id[s] = entity_id;
    pool.entity_owner_player_id[s] = owner_player_id;
    pool.entity_team_id[s] = team_id;
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
    let underwater_fraction =
        combat_targeting_target_underwater_fraction(family, pos_z, radius_hitbox, aabb_half_z);
    pool.entity_underwater_fraction[s] = underwater_fraction;
    pool.entity_above_water_fraction[s] = 1.0 - underwater_fraction;
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
    pool.entity_sensor_source_x[s] = sensor_source_x;
    pool.entity_sensor_source_y[s] = sensor_source_y;
    pool.entity_full_vision_above_water_radius[s] = full_vision_above_water_radius;
    pool.entity_full_vision_underwater_radius[s] = full_vision_underwater_radius;
    pool.entity_radar_radius[s] = radar_radius;
    pool.entity_sonar_radius[s] = sonar_radius;
    pool.entity_detector_above_water_radius[s] = detector_above_water_radius;
    pool.entity_detector_underwater_radius[s] = detector_underwater_radius;
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
    parent_yaw: f64,
    yaw_min: f64,
    yaw_max: f64,
    pitch_min: f64,
    pitch_max: f64,
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
    target_rescore_period_ticks: u16,
    dps: f32,
    projectile_speed: f64,
    projectile_mass: f64,
    projectile_air_friction_per_60hz_frame: f64,
    muzzle_forward_offset: f64,
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
    task_target_id: i32,
    task_point_active: u8,
    slaved_to_mount_index: i32,
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
    pool.turret_parent_yaw[global_idx] = parent_yaw;
    pool.turret_yaw_min[global_idx] = yaw_min;
    pool.turret_yaw_max[global_idx] = yaw_max;
    pool.turret_pitch_min[global_idx] = pitch_min;
    pool.turret_pitch_max[global_idx] = pitch_max;
    pool.turret_task_target_id[global_idx] = task_target_id;
    pool.turret_task_point_active[global_idx] = task_point_active;
    pool.turret_slaved_to_mount_index[global_idx] = slaved_to_mount_index;
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
    pool.turret_target_rescore_period_ticks[global_idx] = target_rescore_period_ticks;
    pool.turret_dps[global_idx] = dps;
    pool.turret_projectile_speed[global_idx] = projectile_speed;
    pool.turret_projectile_mass[global_idx] = projectile_mass;
    pool.turret_muzzle_forward_offset[global_idx] = muzzle_forward_offset;
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

/// Authoritative full body orientation for an entity slot, when the
/// unit-force attitude step owns one. The combat pool does not carry the
/// quaternion; it lives in the canonical entity_state slab, which shares
/// the same slot space. The entity-id parity check rejects recycled slots.
#[inline]
pub(crate) fn combat_targeting_entity_mount_orientation(
    pool: &CombatTargetingPool,
    entity_slot: usize,
) -> Option<[f64; 4]> {
    let state = crate::entity_state::entity_state();
    if entity_slot >= state.entity_id.len() || entity_slot >= pool.entity_id.len() {
        return None;
    }
    let id = state.entity_id[entity_slot];
    if id < 0 || pool.entity_id[entity_slot] != id {
        return None;
    }
    if state.unit_motion_flags[entity_slot] & ENTITY_SLOT_UNIT_MOTION_HAS_ORIENTATION == 0 {
        return None;
    }
    Some([
        state.orientation_x[entity_slot],
        state.orientation_y[entity_slot],
        state.orientation_z[entity_slot],
        state.orientation_w[entity_slot],
    ])
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
    orientation: Option<[f64; 4]>,
) -> (f64, f64, f64) {
    // Full-orientation hosts: the renderer's chassis parent IS this
    // quaternion (yaw included), so emissions must ride it too or shots
    // detach from the drawn turret whenever the body's attitude diverges
    // from the yaw+surface-tilt approximation (steep slopes, buoyancy).
    if let Some(q) = orientation {
        let rotated = quat_rotate_vec(q, [offset_x, offset_y, mount_height]);
        return (
            unit_x + rotated[0],
            unit_y + rotated[1],
            unit_ground_z + rotated[2],
        );
    }
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
    let orientation = combat_targeting_entity_mount_orientation(pool, s);
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
            orientation,
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
        .min(pool.entity_stamp_epoch.len())
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

        // clear_all() advances the stamp epoch instead of rewriting every
        // identity row. Observation queries between clear and the next stamp
        // must not mistake an old entity id in a reused slot for current
        // world state.
        if pool.entity_stamp_epoch[slot] != pool.stamp_epoch {
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
    combat_targeting_entity_team_air_sight_mask_ptr,
    entity_team_air_sight_mask,
    u32
);
combat_targeting_ptr_export!(
    combat_targeting_entity_team_water_sight_mask_ptr,
    entity_team_water_sight_mask,
    u32
);
combat_targeting_ptr_export!(
    combat_targeting_entity_team_air_radar_mask_ptr,
    entity_team_air_radar_mask,
    u32
);
combat_targeting_ptr_export!(
    combat_targeting_entity_team_water_sonar_mask_ptr,
    entity_team_water_sonar_mask,
    u32
);
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
combat_targeting_ptr_export!(
    combat_targeting_turret_host_piece_yaw_ptr,
    turret_host_piece_yaw,
    f32
);
combat_targeting_ptr_export!(
    combat_targeting_turret_host_piece_yaw_velocity_ptr,
    turret_host_piece_yaw_velocity,
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

mod fsm;
pub(crate) use fsm::*;
mod targeting;
pub(crate) use targeting::*;
mod projectile_interactions;
pub(crate) use projectile_interactions::*;
#[cfg(test)]
mod tests {
    use super::*;

    fn assert_close(actual: f64, expected: f64) {
        assert!(
            (actual - expected).abs() <= 1e-9,
            "expected {expected}, got {actual}"
        );
    }

    /// The mirror contract: reflecting the predicted incoming arrival
    /// velocity about the ballistic-mirror panel normal must yield
    /// exactly the return-arc launch velocity, and that launch velocity
    /// must land the shot on the turret/host midpoint under the same
    /// flight model. Checked with and without drag.
    fn assert_ballistic_mirror_round_trip(air_friction: f64, projectile_mass: f64) {
        let mut pool = CombatTargetingPool::empty();
        pool.ensure_entity_capacity(0);
        let threat_idx = combat_targeting_turret_global_idx(0, 0);
        pool.turret_projectile_speed[threat_idx] = 600.0;
        pool.turret_projectile_mass[threat_idx] = projectile_mass;
        pool.turret_projectile_air_friction_per_60hz_frame[threat_idx] = air_friction;
        pool.turret_arc_preference[threat_idx] = 0;
        pool.turret_max_time_sec[threat_idx] = 0.0;

        let gravity = 400.0;
        let turret_point = (600.0, 100.0, 120.0);
        let body_point = (600.0, 100.0, 60.0);
        let (mount_x, mount_y, mount_z) = (0.0, 0.0, 50.0);

        let (normal_x, normal_y, normal_z) = combat_targeting_ballistic_mirror_panel_dir(
            &pool,
            threat_idx,
            turret_point,
            body_point,
            mount_x,
            mount_y,
            mount_z,
            gravity,
        )
        .expect("ballistic mirror must solve for an in-range threat");
        let normal_len =
            (normal_x * normal_x + normal_y * normal_y + normal_z * normal_z).sqrt();
        assert!((normal_len - 1.0).abs() <= 1e-9, "panel normal must be unit");

        // Re-derive the two arcs with the same pure pieces the mirror used.
        let (incoming_time, in_vx, in_vy, in_vz) = combat_targeting_solve_static_arc(
            &pool,
            turret_point,
            (mount_x, mount_y, mount_z),
            600.0,
            projectile_mass,
            air_friction,
            gravity,
            0,
            0.0,
        )
        .expect("incoming arc must solve");
        let (arr_vx, arr_vy, arr_vz) = combat_targeting_arc_velocity_at_time(
            &pool,
            in_vx,
            in_vy,
            in_vz,
            incoming_time,
            projectile_mass,
            air_friction,
            gravity,
        );
        let arrival_speed = (arr_vx * arr_vx + arr_vy * arr_vy + arr_vz * arr_vz).sqrt();
        let mid = (
            (turret_point.0 + body_point.0) * 0.5,
            (turret_point.1 + body_point.1) * 0.5,
            (turret_point.2 + body_point.2) * 0.5,
        );
        let (return_time, out_vx, out_vy, out_vz) = combat_targeting_solve_static_arc(
            &pool,
            (mount_x, mount_y, mount_z),
            mid,
            arrival_speed,
            projectile_mass,
            air_friction,
            gravity,
            0,
            0.0,
        )
        .expect("return arc must solve");

        // Specular bounce of the arriving velocity = return launch
        // velocity. The bounce preserves |arrival| exactly while the
        // solver's launch speed matches it only to root-finding
        // tolerance, so compare to that tolerance, not to 1e-9.
        let (r_vx, r_vy, r_vz) =
            reflect_about_normal(arr_vx, arr_vy, arr_vz, normal_x, normal_y, normal_z)
                .expect("arrival velocity must reflect");
        assert!(
            (r_vx - out_vx).abs() <= 1e-4 * arrival_speed
                && (r_vy - out_vy).abs() <= 1e-4 * arrival_speed
                && (r_vz - out_vz).abs() <= 1e-4 * arrival_speed,
            "reflected arrival {r_vx},{r_vy},{r_vz} must equal return launch {out_vx},{out_vy},{out_vz}"
        );

        // The return launch velocity really lands on the midpoint under
        // the same flight model the solver assumes.
        let drag_k = projectile_air_drag_rate_from_friction_per_60hz_frame(
            air_friction,
            projectile_mass,
        );
        let (land_x, land_y, land_z) = if drag_k.is_finite() && drag_k > 1e-9 {
            let retention = (1.0 - (-drag_k * return_time).exp()) / drag_k;
            let terminal_z = -gravity / drag_k;
            (
                mount_x + out_vx * retention,
                mount_y + out_vy * retention,
                mount_z + terminal_z * return_time + (out_vz - terminal_z) * retention,
            )
        } else {
            (
                mount_x + out_vx * return_time,
                mount_y + out_vy * return_time,
                mount_z + out_vz * return_time - 0.5 * gravity * return_time * return_time,
            )
        };
        assert!(
            (land_x - mid.0).abs() <= 1e-3
                && (land_y - mid.1).abs() <= 1e-3
                && (land_z - mid.2).abs() <= 1e-3,
            "return arc lands at {land_x},{land_y},{land_z}, expected midpoint {:?}",
            mid
        );
    }

    #[test]
    fn ballistic_mirror_reflects_arrival_onto_return_arc() {
        assert_ballistic_mirror_round_trip(0.0, 1.0);
    }

    #[test]
    fn ballistic_mirror_reflects_arrival_onto_return_arc_with_drag() {
        assert_ballistic_mirror_round_trip(0.002, 2.0);
    }

    #[test]
    fn constant_speed_turret_aim_leads_target_velocity() {
        let mut pool = CombatTargetingPool::empty();
        pool.ensure_entity_capacity(0);
        pool.turret_count_per_entity[0] = 1;
        let idx = combat_targeting_turret_global_idx(0, 0);

        let (los_clear, intercept_clear, shield_clear) = compute_turret_gates_for_aim_point(
            &mut pool,
            0,
            0,
            idx,
            CT_TURRET_CFG_CONSTANT_SPEED_LEAD,
            0.0,
            0.0,
            0.0,
            1000.0,
            0.0,
            0.0,
            0.0,
            50.0,
            0.0,
            -1,
            -1,
            10.0,
            0.0,
            0,
            0,
            0,
            100.0,
            1.0,
            0.2,
            0,
            30.0,
            0.0,
            false,
            9.81,
        );

        assert_eq!((los_clear, intercept_clear, shield_clear), (1, 1, 1));
        assert_eq!(pool.turret_ballistic_has_solution[idx], 1);
        assert!(pool.turret_ballistic_flight_time[idx] > 11.5);
        assert!((pool.turret_ballistic_yaw[idx] as f64 - std::f64::consts::FRAC_PI_6).abs() < 1e-3);
        assert_close(pool.turret_ballistic_pitch[idx] as f64, 0.0);
        assert!(pool.turret_ballistic_aim_y[idx] > 0.0);
    }

    /// A target is handed to the cylindrical range shells as the DAMAGE
    /// volume re-expressed, never as a looser second volume. A structure's
    /// `radius_hitbox` is its footprint half-diagonal — horizontal — so it
    /// must not floor the vertical reach of a flat building.
    #[test]
    fn target_vertical_extent_is_the_body_reach_for_each_family() {
        let mut pool = CombatTargetingPool::empty();
        pool.entity_radius_hitbox = vec![42.426, 42.426, 6.0, 6.0];
        pool.entity_aabb_half_z = vec![10.0, 70.0, 5.68, 24.0];
        pool.entity_family = vec![
            CT_ENTITY_FAMILY_BUILDING,
            CT_ENTITY_FAMILY_TOWER,
            CT_ENTITY_FAMILY_UNIT,
            CT_ENTITY_FAMILY_UNIT,
        ];

        // 60x60x20 solar panel: 10, NOT max(42.426, 10). Before the fix it
        // was handed over as ~85 units tall instead of 20.
        assert_close(combat_targeting_target_vertical_extent(&pool, 0), 10.0);
        // A tall tower is unchanged: its own half-depth already dominated.
        assert_close(combat_targeting_target_vertical_extent(&pool, 1), 70.0);
        // Units are spheres at their body center, so the hitbox radius IS
        // their vertical reach; the support-point offset only extends a
        // legged body downward toward its footing, so the max stays.
        assert_close(combat_targeting_target_vertical_extent(&pool, 2), 6.0);
        assert_close(combat_targeting_target_vertical_extent(&pool, 3), 24.0);
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
            pool.entity_stamp_epoch[0] = pool.stamp_epoch;
            pool.entity_flags[0] = CT_ENTITY_FLAG_ALIVE;
            pool.entity_id[1] = 11;
            pool.entity_stamp_epoch[1] = pool.stamp_epoch;
            pool.entity_flags[1] = CT_ENTITY_FLAG_ALIVE;
            pool.entity_full_sight_coverage_mask[1] = 1;
            pool.entity_id[2] = 12;
            pool.entity_stamp_epoch[2] = pool.stamp_epoch;
            pool.entity_flags[2] = CT_ENTITY_FLAG_ALIVE | CT_ENTITY_FLAG_CLOAKED;
            pool.entity_detector_coverage_mask[2] = 1;
            pool.entity_id[3] = 13;
            pool.entity_stamp_epoch[3] = pool.stamp_epoch;
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

        combat_targeting_clear();
        counts.fill(u32::MAX);
        let handled_after_clear = combat_targeting_collect_observation_visibility(
            1,
            &[],
            &mut visible,
            &mut visible_slots,
            &mut radar,
            &mut radar_slots,
            &mut los,
            &mut counts,
        );
        assert_eq!(handled_after_clear, 0);
        assert_eq!(counts, [0, 0, 0, 0]);
    }

    #[test]
    fn contact_sensors_include_every_medium_with_nonzero_volume_occupancy() {
        let _guard = match crate::COMBAT_TARGETING_TEST_LOCK.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        let pool = combat_targeting_pool();
        *pool = CombatTargetingPool::empty();
        pool.ensure_entity_capacity(3);

        let online = CT_ENTITY_FLAG_ALIVE | CT_ENTITY_FLAG_BUILDABLE_COMPLETE;
        pool.entity_id[0] = 100;
        pool.entity_flags[0] = online;
        pool.entity_owner_bit[0] = combat_targeting_player_bit(1);
        pool.entity_pos_x[0] = 0.0;
        pool.entity_pos_y[0] = 0.0;

        for slot in 1..=3 {
            pool.entity_id[slot] = 100 + slot as i32;
            pool.entity_flags[slot] = online;
            pool.entity_owner_bit[slot] = combat_targeting_player_bit(2);
            pool.entity_pos_y[slot] = 0.0;
        }
        pool.entity_pos_x[1] = 50.0;
        pool.entity_pos_z[1] = TERRAIN_WATER_LEVEL + 0.001;
        pool.entity_above_water_fraction[1] = 1.0;
        pool.entity_underwater_fraction[1] = 0.0;
        pool.entity_pos_x[2] = 50.0;
        pool.entity_pos_z[2] = TERRAIN_WATER_LEVEL;
        pool.entity_above_water_fraction[2] = 0.5;
        pool.entity_underwater_fraction[2] = 0.5;
        pool.entity_pos_x[3] = 100.001;
        pool.entity_pos_z[3] = TERRAIN_WATER_LEVEL + 0.001;
        pool.entity_above_water_fraction[3] = 1.0;
        pool.entity_underwater_fraction[3] = 0.0;
        pool.entity_detection_padding[3] = 1000.0;

        pool.entity_radar_radius[0] = 100.0;
        combat_targeting_rebuild_observation_masks();
        assert_ne!(pool.entity_team_air_radar_mask[1] & 1, 0);
        assert_ne!(pool.entity_team_air_radar_mask[2] & 1, 0);
        assert_eq!(pool.entity_team_water_sonar_mask[2] & 1, 0);
        assert_eq!(pool.entity_team_air_sight_mask[2] & 1, 0);
        assert_eq!(pool.entity_team_water_sight_mask[2] & 1, 0);
        assert_ne!(pool.entity_sensor_coverage_mask[1] & 1, 0);
        assert_ne!(pool.entity_sensor_coverage_mask[2] & 1, 0);
        assert_eq!(pool.entity_sensor_coverage_mask[3] & 1, 0);

        pool.entity_radar_radius[0] = 0.0;
        pool.entity_sonar_radius[0] = 100.0;
        combat_targeting_rebuild_observation_masks();
        assert_eq!(pool.entity_team_air_radar_mask[2] & 1, 0);
        assert_ne!(pool.entity_team_water_sonar_mask[2] & 1, 0);
        assert_eq!(pool.entity_team_air_sight_mask[2] & 1, 0);
        assert_eq!(pool.entity_team_water_sight_mask[2] & 1, 0);
        assert_eq!(pool.entity_sensor_coverage_mask[1] & 1, 0);
        assert_ne!(pool.entity_sensor_coverage_mask[2] & 1, 0);
        assert_eq!(pool.entity_sensor_coverage_mask[3] & 1, 0);

        pool.entity_sonar_radius[0] = 0.0;
        pool.entity_full_vision_above_water_radius[0] = 100.0;
        combat_targeting_rebuild_observation_masks();
        assert_ne!(pool.entity_team_air_sight_mask[1] & 1, 0);
        assert_ne!(pool.entity_team_air_sight_mask[2] & 1, 0);
        assert_eq!(pool.entity_team_water_sight_mask[2] & 1, 0);
        assert_eq!(pool.entity_team_air_radar_mask[2] & 1, 0);
        assert_eq!(pool.entity_team_water_sonar_mask[2] & 1, 0);
        assert_ne!(pool.entity_full_sight_coverage_mask[1] & 1, 0);
        assert_ne!(pool.entity_full_sight_coverage_mask[2] & 1, 0);

        pool.entity_full_vision_above_water_radius[0] = 0.0;
        pool.entity_full_vision_underwater_radius[0] = 100.0;
        combat_targeting_rebuild_observation_masks();
        assert_eq!(pool.entity_team_air_sight_mask[2] & 1, 0);
        assert_ne!(pool.entity_team_water_sight_mask[2] & 1, 0);
        assert_eq!(pool.entity_team_air_radar_mask[2] & 1, 0);
        assert_eq!(pool.entity_team_water_sonar_mask[2] & 1, 0);
        assert_eq!(pool.entity_full_sight_coverage_mask[1] & 1, 0);
        assert_ne!(pool.entity_full_sight_coverage_mask[2] & 1, 0);
    }

    #[test]
    fn team_knowledge_is_orthogonal_to_emission_source_routes() {
        let owner_bit = combat_targeting_player_bit(1);
        let above_target = CombatTargetingCylinderTarget {
            horizontal_dist_sq: 0.0,
            horizontal_radius: 1.0,
            bottom_z: TERRAIN_WATER_LEVEL + 1.0,
            top_z: TERRAIN_WATER_LEVEL + 3.0,
            is_point: false,
        };
        assert!(combat_targeting_flags_allow_target_medium(
            CT_TURRET_CFG_ROUTE_UNDERWATER_TO_ABOVE,
            TERRAIN_WATER_LEVEL,
            above_target,
        ));

        let mut pool = CombatTargetingPool::empty();
        pool.ensure_entity_capacity(1);
        pool.entity_owner_bit[1] = combat_targeting_player_bit(2);
        pool.entity_flags[1] = CT_ENTITY_FLAG_ALIVE;

        // Team-air-radar provides knowledge to the underwater launcher; it
        // does not need to share the emission's source row.
        pool.entity_team_air_radar_mask[1] = owner_bit;
        pool.entity_sensor_coverage_mask[1] = pool.entity_team_air_radar_mask[1];
        assert!(combat_targeting_view_mask_observes_entity(
            &pool, 1, owner_bit
        ));

        // Team-air-sight is an independent stronger knowledge fact and reaches
        // the same W->A-capable launcher through the full-sight union.
        pool.entity_team_air_radar_mask[1] = 0;
        pool.entity_team_air_sight_mask[1] = owner_bit;
        pool.entity_sensor_coverage_mask[1] = pool.entity_team_air_sight_mask[1];
        pool.entity_full_sight_coverage_mask[1] = pool.entity_team_air_sight_mask[1];
        assert!(combat_targeting_view_mask_observes_entity(
            &pool, 1, owner_bit
        ));
        assert_ne!(pool.entity_full_sight_coverage_mask[1] & owner_bit, 0);
    }

    #[test]
    fn combined_observation_walk_preserves_independent_mask_radii() {
        let _guard = match crate::COMBAT_TARGETING_TEST_LOCK.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        let pool = combat_targeting_pool();
        *pool = CombatTargetingPool::empty();
        pool.ensure_entity_capacity(3);

        let online = CT_ENTITY_FLAG_ALIVE | CT_ENTITY_FLAG_BUILDABLE_COMPLETE;
        let owner_bit = combat_targeting_player_bit(1);
        pool.entity_id[0] = 100;
        pool.entity_flags[0] = online;
        pool.entity_owner_bit[0] = owner_bit;
        pool.entity_sensor_source_x[0] = 0.0;
        pool.entity_sensor_source_y[0] = 0.0;
        pool.entity_full_vision_above_water_radius[0] = 30.0;
        pool.entity_radar_radius[0] = 70.0;
        pool.entity_detector_above_water_radius[0] = 50.0;

        for (slot, distance) in [(1, 20.0), (2, 40.0), (3, 60.0)] {
            pool.entity_id[slot] = 100 + slot as i32;
            pool.entity_flags[slot] = online;
            pool.entity_owner_bit[slot] = combat_targeting_player_bit(2);
            pool.entity_pos_x[slot] = distance;
            pool.entity_pos_y[slot] = 0.0;
            pool.entity_above_water_fraction[slot] = 1.0;
        }

        combat_targeting_rebuild_observation_masks();
        assert_ne!(pool.entity_sensor_coverage_mask[1] & owner_bit, 0);
        assert_ne!(pool.entity_sensor_coverage_mask[2] & owner_bit, 0);
        assert_ne!(pool.entity_sensor_coverage_mask[3] & owner_bit, 0);
        assert_ne!(pool.entity_full_sight_coverage_mask[1] & owner_bit, 0);
        assert_eq!(pool.entity_full_sight_coverage_mask[2] & owner_bit, 0);
        assert_eq!(pool.entity_full_sight_coverage_mask[3] & owner_bit, 0);
        assert_ne!(pool.entity_detector_coverage_mask[1] & owner_bit, 0);
        assert_ne!(pool.entity_detector_coverage_mask[2] & owner_bit, 0);
        assert_eq!(pool.entity_detector_coverage_mask[3] & owner_bit, 0);

        pool.entity_sensor_coverage_mask.fill(0);
        pool.entity_full_sight_coverage_mask.fill(0);
        pool.entity_detector_coverage_mask.fill(0);
        pool.entity_team_air_sight_mask.fill(0);
        pool.entity_team_water_sight_mask.fill(0);
        pool.entity_team_air_radar_mask.fill(0);
        pool.entity_team_water_sonar_mask.fill(0);
        combat_targeting_add_sensor_observation_circle(1, 0.0, 0.0, 45.0);
        for slot in [1, 2] {
            assert_ne!(pool.entity_sensor_coverage_mask[slot] & owner_bit, 0);
            assert_ne!(pool.entity_full_sight_coverage_mask[slot] & owner_bit, 0);
            assert_ne!(pool.entity_detector_coverage_mask[slot] & owner_bit, 0);
        }
        assert_eq!(pool.entity_sensor_coverage_mask[3] & owner_bit, 0);
        assert_eq!(pool.entity_full_sight_coverage_mask[3] & owner_bit, 0);
        assert_eq!(pool.entity_detector_coverage_mask[3] & owner_bit, 0);
    }

    /// Sight obstruction has to agree with what the barrier does to a shot.
    /// Every barrier authors `reflect-outside`, so the only case that may be
    /// blocked is the sightline coming IN. Outbound is clear, which is what
    /// lets a gunner shoot out of the dome it is standing under; a line that
    /// passes clean through is still blocked, by its inbound half.
    #[test]
    fn sphere_sight_obstruction_is_outside_in_only() {
        let (cx, cy, cz, r) = (0.0, 0.0, 0.0, 5.0);
        let lo = 1e-6;
        let hi = 1.0 - 1e-6;
        assert!(
            shield_segment_enters_sphere(-10.0, 0.0, 0.0, 0.0, 0.0, 0.0, cx, cy, cz, r, lo, hi),
            "a sightline from outside into the dome must be blocked",
        );
        assert!(
            !shield_segment_enters_sphere(0.0, 0.0, 0.0, -10.0, 0.0, 0.0, cx, cy, cz, r, lo, hi),
            "a sightline from inside the dome out of it must be clear",
        );
        assert!(
            shield_segment_enters_sphere(-10.0, 0.0, 0.0, 10.0, 0.0, 0.0, cx, cy, cz, r, lo, hi),
            "a sightline passing through the dome is still blocked by its inbound half",
        );
        assert!(
            !shield_segment_enters_sphere(1.0, 0.0, 0.0, -1.0, 0.0, 0.0, cx, cy, cz, r, lo, hi),
            "both endpoints inside one dome must be clear",
        );
        assert!(
            !shield_segment_enters_sphere(-10.0, 20.0, 0.0, 10.0, 20.0, 0.0, cx, cy, cz, r, lo, hi),
            "a sightline that misses the dome entirely must be clear",
        );
    }

    #[test]
    fn cylinder_sight_obstruction_is_outside_in_only() {
        let lo = 1e-6;
        let hi = 1.0 - 1e-6;
        assert!(
            shield_segment_enters_infinite_vertical_cylinder(
                -10.0, 0.0, 0.0, 0.0, 0.0, 0.0, 5.0, lo, hi
            ),
            "a sightline entering the column must be blocked",
        );
        assert!(
            !shield_segment_enters_infinite_vertical_cylinder(
                0.0, 0.0, -10.0, 0.0, 0.0, 0.0, 5.0, lo, hi
            ),
            "a sightline leaving the column must be clear",
        );
        // Aimed tube along +X, radius 2, spanning the origin.
        assert!(
            shield_segment_enters_aimed_cylinder(
                0.0, -10.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 10.0, 0.0, 0.0, 2.0, lo, hi
            ),
            "a sightline entering the aimed tube must be blocked",
        );
        assert!(
            !shield_segment_enters_aimed_cylinder(
                0.0, 0.0, 0.0, 0.0, -10.0, 0.0, 0.0, 0.0, 0.0, 10.0, 0.0, 0.0, 2.0, lo, hi
            ),
            "a sightline leaving the aimed tube must be clear",
        );
    }

    /// The rule the sight gate now follows is the one the projectile gate
    /// already followed. If a barrier's authored policy ever stops being
    /// outside-in, these two stop agreeing and the sight kernel needs to read
    /// the policy rather than assume it.
    #[test]
    fn sight_obstruction_direction_matches_projectile_reflection() {
        let mode = SHIELD_REFLECTION_MODE_OUTSIDE_IN;
        // radial_velocity < 0 is inbound, > 0 outbound.
        assert!(shield_reflection_mode_allows_crossing(mode, -1.0));
        assert!(!shield_reflection_mode_allows_crossing(mode, 1.0));

        let lo = 1e-6;
        let hi = 1.0 - 1e-6;
        let inbound_blocked =
            shield_segment_enters_sphere(-10.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 5.0, lo, hi);
        let outbound_blocked =
            shield_segment_enters_sphere(0.0, 0.0, 0.0, -10.0, 0.0, 0.0, 0.0, 0.0, 0.0, 5.0, lo, hi);
        assert_eq!(
            inbound_blocked,
            shield_reflection_mode_allows_crossing(mode, -1.0),
            "sight must block inbound exactly when the barrier intercepts inbound",
        );
        assert_eq!(
            outbound_blocked,
            shield_reflection_mode_allows_crossing(mode, 1.0),
            "sight must clear outbound exactly when the barrier lets outbound through",
        );
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

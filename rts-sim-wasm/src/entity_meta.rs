// entity_meta — extracted from lib.rs (pure code motion).

#[allow(unused_imports)]
use crate::*;
#[allow(unused_imports)]
use wasm_bindgen::prelude::*;

// ─────────────────────────────────────────────────────────────────
//  Entity-meta sentinels
//
//  The Phase 10 D.1 entity-meta SoA pool + runtime registry that used to
//  live here was never populated or read by any production path: the JS-side
//  per-tick population never landed, so the registry rows, the slot-indexed
//  snapshot slab, every wasm_bindgen export, and all the *_ptr accessors were
//  a dead parallel source of truth beside the live TS WorldEntityMetadata
//  (WorldState drives that map; SpatialGrid called only the now-removed
//  no-op cleanup hooks). Deleted per Delete The Old Path / Single Source Of
//  Truth. Only the two id sentinels survive — still used by the combat-
//  targeting SoA columns and the turret sub-pool below.
// ─────────────────────────────────────────────────────────────────

pub(crate) const ENTITY_META_NO_ID: i32 = -1;
pub(crate) const ENTITY_META_NO_INDEX: i32 = -1;

// ─────────────────────────────────────────────────────────────────
//  Phase 10 D.1b — Turret sub-pool
//
//  Each entity can have up to MAX_TURRETS_PER_ENTITY = 8 turrets
//  (matches MAX_WEAPONS_PER_ENTITY in stateSerializerEntities.ts).
//  Per-turret state lives at index `entity_slot * MAX + turret_idx`
//  in a flat SoA. Per-entity turret count gates which indices are
//  live. Indexes for inactive slots stay at their defaults; consumers
//  only read the first `count` entries for an entity.
//
//  Fields cover the snapshot turret DTO: rotation, angularVelocity,
//  angularAcceleration, pitch, pitchVelocity, pitchAcceleration,
//  shieldRange, plus a target_id reference (-1 = none).
//
//  Variable-length action sub-pool is a follow-up (D.1c) — action
//  ActionType is a JS string enum that needs a stable u8 mapping
//  before it can be ported.
// ─────────────────────────────────────────────────────────────────

pub const TURRET_POOL_MAX_PER_ENTITY: u32 = 8;

pub(crate) struct TurretPool {
    // count_per_entity[i] = number of turrets used by entity slot i.
    pub(crate) count_per_entity: Vec<u8>,
    // Per-turret state, indexed by (entity_slot * MAX + turret_idx).
    pub(crate) entity_id: Vec<i32>,
    pub(crate) parent_id: Vec<i32>,
    pub(crate) root_host_id: Vec<i32>,
    pub(crate) mount_index: Vec<i32>,
    pub(crate) rotation: Vec<f32>,
    pub(crate) angular_velocity: Vec<f32>,
    pub(crate) angular_acceleration: Vec<f32>,
    pub(crate) pitch: Vec<f32>,
    pub(crate) pitch_velocity: Vec<f32>,
    pub(crate) pitch_acceleration: Vec<f32>,
    pub(crate) shield_range: Vec<f32>,
    pub(crate) target_id: Vec<i32>,
}

impl TurretPool {
    pub(crate) fn empty() -> Self {
        Self {
            count_per_entity: Vec::new(),
            entity_id: Vec::new(),
            parent_id: Vec::new(),
            root_host_id: Vec::new(),
            mount_index: Vec::new(),
            rotation: Vec::new(),
            angular_velocity: Vec::new(),
            angular_acceleration: Vec::new(),
            pitch: Vec::new(),
            pitch_velocity: Vec::new(),
            pitch_acceleration: Vec::new(),
            shield_range: Vec::new(),
            target_id: Vec::new(),
        }
    }

    pub(crate) fn ensure_entity_capacity(&mut self, entity_slot: u32) {
        let entity_needed = (entity_slot as usize) + 1;
        if self.count_per_entity.len() < entity_needed {
            self.count_per_entity.resize(entity_needed, 0);
        }
        let turret_needed = entity_needed * (TURRET_POOL_MAX_PER_ENTITY as usize);
        if self.rotation.len() < turret_needed {
            self.entity_id.resize(turret_needed, ENTITY_META_NO_ID);
            self.parent_id.resize(turret_needed, ENTITY_META_NO_ID);
            self.root_host_id.resize(turret_needed, ENTITY_META_NO_ID);
            self.mount_index.resize(turret_needed, ENTITY_META_NO_INDEX);
            self.rotation.resize(turret_needed, 0.0);
            self.angular_velocity.resize(turret_needed, 0.0);
            self.angular_acceleration.resize(turret_needed, 0.0);
            self.pitch.resize(turret_needed, 0.0);
            self.pitch_velocity.resize(turret_needed, 0.0);
            self.pitch_acceleration.resize(turret_needed, 0.0);
            self.shield_range.resize(turret_needed, 0.0);
            self.target_id.resize(turret_needed, -1);
        }
    }

    pub(crate) fn unset_entity(&mut self, entity_slot: u32) {
        let s = entity_slot as usize;
        if s >= self.count_per_entity.len() {
            return;
        }
        self.count_per_entity[s] = 0;
        let base = s * (TURRET_POOL_MAX_PER_ENTITY as usize);
        for t in 0..(TURRET_POOL_MAX_PER_ENTITY as usize) {
            let idx = base + t;
            if idx >= self.entity_id.len() {
                break;
            }
            self.entity_id[idx] = ENTITY_META_NO_ID;
            self.parent_id[idx] = ENTITY_META_NO_ID;
            self.root_host_id[idx] = ENTITY_META_NO_ID;
            self.mount_index[idx] = ENTITY_META_NO_INDEX;
        }
        // Other per-turret fields stay at last value; consumers gate on count.
    }
}

pub(crate) struct TurretPoolHolder(UnsafeCell<Option<TurretPool>>);
unsafe impl Sync for TurretPoolHolder {}
pub(crate) static TURRET_POOL: TurretPoolHolder = TurretPoolHolder(UnsafeCell::new(None));

#[inline]
pub(crate) fn turret_pool() -> &'static mut TurretPool {
    unsafe {
        let cell = &mut *TURRET_POOL.0.get();
        if cell.is_none() {
            *cell = Some(TurretPool::empty());
        }
        cell.as_mut().unwrap()
    }
}

#[wasm_bindgen]
pub fn turret_pool_init(initial_entity_capacity: u32) {
    let pool = turret_pool();
    pool.ensure_entity_capacity(initial_entity_capacity);
    for c in pool.count_per_entity.iter_mut() {
        *c = 0;
    }
}

#[wasm_bindgen]
pub fn turret_pool_clear() {
    let pool = turret_pool();
    for c in pool.count_per_entity.iter_mut() {
        *c = 0;
    }
}

#[wasm_bindgen]
pub fn turret_pool_max_per_entity() -> u32 {
    TURRET_POOL_MAX_PER_ENTITY
}

/// Set the number of live turrets for an entity. Caller is responsible
/// for calling turret_pool_set_turret for each of the first `count`
/// turret indices. Counts past TURRET_POOL_MAX_PER_ENTITY are clamped.
#[wasm_bindgen]
pub fn turret_pool_set_count(entity_slot: u32, count: u8) {
    let pool = turret_pool();
    pool.ensure_entity_capacity(entity_slot);
    let max = TURRET_POOL_MAX_PER_ENTITY as u8;
    let clamped = if count > max { max } else { count };
    let s = entity_slot as usize;
    let previous = pool.count_per_entity[s];
    if clamped < previous {
        let base = s * (TURRET_POOL_MAX_PER_ENTITY as usize);
        for t in (clamped as usize)..(previous as usize) {
            let idx = base + t;
            pool.entity_id[idx] = ENTITY_META_NO_ID;
            pool.parent_id[idx] = ENTITY_META_NO_ID;
            pool.root_host_id[idx] = ENTITY_META_NO_ID;
            pool.mount_index[idx] = ENTITY_META_NO_INDEX;
        }
    }
    pool.count_per_entity[entity_slot as usize] = clamped;
}

/// Bulk per-turret setter. `target_id` of -1 means "no target".
#[wasm_bindgen]
pub fn turret_pool_set_turret(
    entity_slot: u32,
    turret_idx: u32,
    entity_id: i32,
    parent_id: i32,
    root_host_id: i32,
    mount_index: i32,
    rotation: f32,
    angular_velocity: f32,
    angular_acceleration: f32,
    pitch: f32,
    pitch_velocity: f32,
    pitch_acceleration: f32,
    shield_range: f32,
    target_id: i32,
) {
    let pool = turret_pool();
    pool.ensure_entity_capacity(entity_slot);
    debug_assert!(turret_idx < TURRET_POOL_MAX_PER_ENTITY);
    let global_idx =
        (entity_slot as usize) * (TURRET_POOL_MAX_PER_ENTITY as usize) + (turret_idx as usize);
    pool.entity_id[global_idx] = entity_id;
    pool.parent_id[global_idx] = parent_id;
    pool.root_host_id[global_idx] = root_host_id;
    pool.mount_index[global_idx] = mount_index;
    pool.rotation[global_idx] = rotation;
    pool.angular_velocity[global_idx] = angular_velocity;
    pool.angular_acceleration[global_idx] = angular_acceleration;
    pool.pitch[global_idx] = pitch;
    pool.pitch_velocity[global_idx] = pitch_velocity;
    pool.pitch_acceleration[global_idx] = pitch_acceleration;
    pool.shield_range[global_idx] = shield_range;
    pool.target_id[global_idx] = target_id;
}

#[wasm_bindgen]
pub fn turret_pool_unset_entity(entity_slot: u32) {
    turret_pool().unset_entity(entity_slot);
}

#[wasm_bindgen]
pub fn turret_pool_count(entity_slot: u32) -> u8 {
    let pool = turret_pool();
    if (entity_slot as usize) >= pool.count_per_entity.len() {
        return 0;
    }
    pool.count_per_entity[entity_slot as usize]
}

macro_rules! turret_pool_ptr_export {
    ($name:ident, $field:ident, $ty:ty) => {
        #[wasm_bindgen]
        pub fn $name() -> *const $ty {
            turret_pool().$field.as_ptr()
        }
    };
}

turret_pool_ptr_export!(turret_pool_count_per_entity_ptr, count_per_entity, u8);
turret_pool_ptr_export!(turret_pool_entity_id_ptr, entity_id, i32);
turret_pool_ptr_export!(turret_pool_parent_id_ptr, parent_id, i32);
turret_pool_ptr_export!(turret_pool_root_host_id_ptr, root_host_id, i32);
turret_pool_ptr_export!(turret_pool_mount_index_ptr, mount_index, i32);
turret_pool_ptr_export!(turret_pool_rotation_ptr, rotation, f32);
turret_pool_ptr_export!(turret_pool_angular_velocity_ptr, angular_velocity, f32);
turret_pool_ptr_export!(
    turret_pool_angular_acceleration_ptr,
    angular_acceleration,
    f32
);
turret_pool_ptr_export!(turret_pool_pitch_ptr, pitch, f32);
turret_pool_ptr_export!(turret_pool_pitch_velocity_ptr, pitch_velocity, f32);
turret_pool_ptr_export!(turret_pool_pitch_acceleration_ptr, pitch_acceleration, f32);
turret_pool_ptr_export!(turret_pool_shield_range_ptr, shield_range, f32);
turret_pool_ptr_export!(turret_pool_target_id_ptr, target_id, i32);

#[wasm_bindgen]
pub fn turret_pool_entity_capacity() -> u32 {
    turret_pool().count_per_entity.len() as u32
}

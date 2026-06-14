// snapshot — extracted from lib.rs (pure code motion).

#[allow(unused_imports)]
use wasm_bindgen::prelude::*;
#[allow(unused_imports)]
use crate::*;
// ─────────────────────────────────────────────────────────────────
// Snapshot baselines (Phase 10 D.3b)
//
// Per-recipient snapshot of the last-shipped entity state. Mirrors
// the JS-side DeltaTrackingState.prevStates map: parallel SoA arrays
// keyed by entity slot (the SpatialGrid slot space). Fields are
// stored as floats — the quantize/diff/encode kernels (D.3c+) read
// from this and the entity-meta / turret / body pools, and emit
// MessagePack bytes via the D.2 writer.
//
// Each listener registers once at session start via
// `snapshot_baseline_create()` and is freed at session end via
// `snapshot_baseline_destroy(handle)`. Handles are u32 indices into
// a registry with free-list reuse.
// ─────────────────────────────────────────────────────────────────

pub const SNAPSHOT_BASELINE_MAX_TURRETS_PER_ENTITY: u32 = TURRET_POOL_MAX_PER_ENTITY;

pub(crate) struct SnapshotBaseline {
    used: Vec<u8>,
    last_tick: Vec<u32>,
    // f64 to match JS PrevEntityState's Number precision exactly.
    // f32 storage triggered a divergence when JS f64 values straddled
    // an f32 rounding step that the baseline read flipped on threshold
    // compare.
    x: Vec<f64>,
    y: Vec<f64>,
    z: Vec<f64>,
    rotation: Vec<f64>,
    velocity_x: Vec<f64>,
    velocity_y: Vec<f64>,
    velocity_z: Vec<f64>,
    hp: Vec<f32>,
    action_count: Vec<u16>,
    action_hash: Vec<u32>,
    is_engaged_bits: Vec<u32>,
    target_bits: Vec<u32>,
    weapon_count: Vec<u8>,
    turret_rots: Vec<f32>,
    turret_ang_vels: Vec<f32>,
    turret_pitches: Vec<f32>,
    // Per-turret pitch velocity baseline. Compared with rot_vel_threshold
    // so pitch-only motion (and zero-edge transitions) dirties the turret
    // independently from yaw velocity.
    turret_pitch_vels: Vec<f32>,
    // Per-turret target ID baseline (-1 = no target). Replaces the
    // target_bits aggregate as the source of truth for "target switched":
    // a same-presence A→B switch with both IDs non-null is invisible to
    // the bitmask but must still dirty the turret.
    turret_target_ids: Vec<i32>,
    shield_ranges: Vec<f32>,
    normal_x: Vec<f64>,
    normal_y: Vec<f64>,
    normal_z: Vec<f64>,
    build_progress: Vec<f32>,
    solar_open: Vec<u8>,
    factory_progress: Vec<f32>,
    is_producing: Vec<u8>,
    build_queue_len: Vec<u8>,
}

impl SnapshotBaseline {
    pub(crate) fn new() -> Self {
        Self {
            used: Vec::new(),
            last_tick: Vec::new(),
            x: Vec::new(),
            y: Vec::new(),
            z: Vec::new(),
            rotation: Vec::new(),
            velocity_x: Vec::new(),
            velocity_y: Vec::new(),
            velocity_z: Vec::new(),
            hp: Vec::new(),
            action_count: Vec::new(),
            action_hash: Vec::new(),
            is_engaged_bits: Vec::new(),
            target_bits: Vec::new(),
            weapon_count: Vec::new(),
            turret_rots: Vec::new(),
            turret_ang_vels: Vec::new(),
            turret_pitches: Vec::new(),
            turret_pitch_vels: Vec::new(),
            turret_target_ids: Vec::new(),
            shield_ranges: Vec::new(),
            normal_x: Vec::new(),
            normal_y: Vec::new(),
            normal_z: Vec::new(),
            build_progress: Vec::new(),
            solar_open: Vec::new(),
            factory_progress: Vec::new(),
            is_producing: Vec::new(),
            build_queue_len: Vec::new(),
        }
    }

    pub(crate) fn ensure_capacity(&mut self, slot: u32) {
        let needed = (slot as usize) + 1;
        if self.used.len() < needed {
            self.used.resize(needed, 0);
        }
        if self.last_tick.len() < needed {
            self.last_tick.resize(needed, 0);
        }
        if self.x.len() < needed {
            self.x.resize(needed, 0.0);
        }
        if self.y.len() < needed {
            self.y.resize(needed, 0.0);
        }
        if self.z.len() < needed {
            self.z.resize(needed, 0.0);
        }
        if self.rotation.len() < needed {
            self.rotation.resize(needed, 0.0);
        }
        if self.velocity_x.len() < needed {
            self.velocity_x.resize(needed, 0.0);
        }
        if self.velocity_y.len() < needed {
            self.velocity_y.resize(needed, 0.0);
        }
        if self.velocity_z.len() < needed {
            self.velocity_z.resize(needed, 0.0);
        }
        if self.hp.len() < needed {
            self.hp.resize(needed, 0.0);
        }
        if self.action_count.len() < needed {
            self.action_count.resize(needed, 0);
        }
        if self.action_hash.len() < needed {
            self.action_hash.resize(needed, 0);
        }
        if self.is_engaged_bits.len() < needed {
            self.is_engaged_bits.resize(needed, 0);
        }
        if self.target_bits.len() < needed {
            self.target_bits.resize(needed, 0);
        }
        if self.weapon_count.len() < needed {
            self.weapon_count.resize(needed, 0);
        }
        let turret_needed = needed * (SNAPSHOT_BASELINE_MAX_TURRETS_PER_ENTITY as usize);
        if self.turret_rots.len() < turret_needed {
            self.turret_rots.resize(turret_needed, 0.0);
        }
        if self.turret_ang_vels.len() < turret_needed {
            self.turret_ang_vels.resize(turret_needed, 0.0);
        }
        if self.turret_pitches.len() < turret_needed {
            self.turret_pitches.resize(turret_needed, 0.0);
        }
        if self.turret_pitch_vels.len() < turret_needed {
            self.turret_pitch_vels.resize(turret_needed, 0.0);
        }
        if self.turret_target_ids.len() < turret_needed {
            self.turret_target_ids.resize(turret_needed, -1);
        }
        if self.shield_ranges.len() < turret_needed {
            self.shield_ranges.resize(turret_needed, 0.0);
        }
        if self.normal_x.len() < needed {
            self.normal_x.resize(needed, 0.0);
        }
        if self.normal_y.len() < needed {
            self.normal_y.resize(needed, 0.0);
        }
        if self.normal_z.len() < needed {
            self.normal_z.resize(needed, 1.0);
        }
        if self.build_progress.len() < needed {
            self.build_progress.resize(needed, 0.0);
        }
        if self.solar_open.len() < needed {
            self.solar_open.resize(needed, 1);
        }
        if self.factory_progress.len() < needed {
            self.factory_progress.resize(needed, 0.0);
        }
        if self.is_producing.len() < needed {
            self.is_producing.resize(needed, 0);
        }
        if self.build_queue_len.len() < needed {
            self.build_queue_len.resize(needed, 0);
        }
    }

    pub(crate) fn unset_slot(&mut self, slot: u32) {
        let s = slot as usize;
        if s >= self.used.len() {
            return;
        }
        self.used[s] = 0;
    }

    pub(crate) fn clear(&mut self) {
        for u in self.used.iter_mut() {
            *u = 0;
        }
    }
}

pub(crate) struct SnapshotBaselineRegistry {
    baselines: Vec<Option<SnapshotBaseline>>,
    free_list: Vec<u32>,
}

impl SnapshotBaselineRegistry {
    pub(crate) fn new() -> Self {
        Self {
            baselines: Vec::new(),
            free_list: Vec::new(),
        }
    }

    pub(crate) fn create(&mut self) -> u32 {
        if let Some(handle) = self.free_list.pop() {
            self.baselines[handle as usize] = Some(SnapshotBaseline::new());
            return handle;
        }
        let handle = self.baselines.len() as u32;
        self.baselines.push(Some(SnapshotBaseline::new()));
        handle
    }

    pub(crate) fn destroy(&mut self, handle: u32) {
        let h = handle as usize;
        if h >= self.baselines.len() {
            return;
        }
        if self.baselines[h].is_some() {
            self.baselines[h] = None;
            self.free_list.push(handle);
        }
    }

    #[allow(dead_code)]
    pub(crate) fn get_mut(&mut self, handle: u32) -> Option<&mut SnapshotBaseline> {
        self.baselines.get_mut(handle as usize)?.as_mut()
    }

    pub(crate) fn live_count(&self) -> u32 {
        (self.baselines.len() - self.free_list.len()) as u32
    }
}

pub(crate) struct SnapshotBaselineRegistryHolder(UnsafeCell<Option<SnapshotBaselineRegistry>>);
unsafe impl Sync for SnapshotBaselineRegistryHolder {}
pub(crate) static SNAPSHOT_BASELINE_REGISTRY: SnapshotBaselineRegistryHolder =
    SnapshotBaselineRegistryHolder(UnsafeCell::new(None));

#[inline]
pub(crate) fn snapshot_baseline_registry() -> &'static mut SnapshotBaselineRegistry {
    unsafe {
        let cell = &mut *SNAPSHOT_BASELINE_REGISTRY.0.get();
        if cell.is_none() {
            *cell = Some(SnapshotBaselineRegistry::new());
        }
        cell.as_mut().unwrap()
    }
}

#[wasm_bindgen]
pub fn snapshot_baseline_create() -> u32 {
    snapshot_baseline_registry().create()
}

#[wasm_bindgen]
pub fn snapshot_baseline_destroy(handle: u32) {
    snapshot_baseline_registry().destroy(handle);
}

#[wasm_bindgen]
pub fn snapshot_baseline_clear(handle: u32) {
    if let Some(b) = snapshot_baseline_registry().get_mut(handle) {
        b.clear();
    }
}

#[wasm_bindgen]
pub fn snapshot_baseline_unset_slot(handle: u32, slot: u32) {
    if let Some(b) = snapshot_baseline_registry().get_mut(handle) {
        b.unset_slot(slot);
    }
}

#[wasm_bindgen]
pub fn snapshot_baseline_ensure_capacity(handle: u32, slot: u32) {
    if let Some(b) = snapshot_baseline_registry().get_mut(handle) {
        b.ensure_capacity(slot);
    }
}

#[wasm_bindgen]
pub fn snapshot_baseline_live_count() -> u32 {
    snapshot_baseline_registry().live_count()
}

// Per-slot capture kernels (Phase 10 D.3c). Mirror
// stateSerializerEntityDelta.ts:captureEntityState + copyPrevState
// into the per-recipient baseline. Transform / velocity / normal /
// action data come in as parameters (the JS-side authoritative
// source is the entity object); HP and the variable-shape fields
// (turrets, build/factory/solar state, suspension) come from the
// already-populated entity-meta + turret pools.

#[wasm_bindgen]
pub fn snapshot_baseline_capture_unit_slot(
    handle: u32,
    slot: u32,
    tick: u32,
    changed_fields: u32,
    x: f64,
    y: f64,
    z: f64,
    rotation: f64,
    velocity_x: f64,
    velocity_y: f64,
    velocity_z: f64,
    normal_x: f64,
    normal_y: f64,
    normal_z: f64,
    action_count: u16,
    action_hash: u32,
    is_engaged_bits: u32,
    target_bits: u32,
) {
    let registry = snapshot_baseline_registry();
    let Some(b) = registry.get_mut(handle) else {
        return;
    };
    b.ensure_capacity(slot);
    let s = slot as usize;
    let is_full = b.used[s] == 0 || changed_fields == SNAPSHOT_BASELINE_CAPTURE_FULL;
    b.used[s] = 1;
    b.last_tick[s] = tick;
    if is_full || (changed_fields & ENTITY_CHANGED_POS) != 0 {
        b.x[s] = x;
        b.y[s] = y;
        b.z[s] = z;
    }
    if is_full || (changed_fields & ENTITY_CHANGED_ROT) != 0 {
        b.rotation[s] = rotation;
    }
    if is_full || (changed_fields & ENTITY_CHANGED_VEL) != 0 {
        b.velocity_x[s] = velocity_x;
        b.velocity_y[s] = velocity_y;
        b.velocity_z[s] = velocity_z;
    }
    if is_full || (changed_fields & (ENTITY_CHANGED_POS | ENTITY_CHANGED_NORMAL)) != 0 {
        b.normal_x[s] = normal_x;
        b.normal_y[s] = normal_y;
        b.normal_z[s] = normal_z;
    }
    if is_full || (changed_fields & ENTITY_CHANGED_ACTIONS) != 0 {
        b.action_count[s] = action_count;
        b.action_hash[s] = action_hash;
    }

    // HP + build/suspension from the entity-meta pool.
    let meta = entity_meta_pool();
    if s < meta.hp_curr.len() {
        if is_full || (changed_fields & ENTITY_CHANGED_HP) != 0 {
            b.hp[s] = meta.hp_curr[s];
        }
        if is_full || (changed_fields & ENTITY_CHANGED_BUILDING) != 0 {
            b.build_progress[s] = if s < meta.build_progress.len() {
                meta.build_progress[s]
            } else {
                0.0
            };
        }
    }

    // Turret state from the turret pool.
    if is_full || (changed_fields & ENTITY_CHANGED_TURRETS) != 0 {
        b.is_engaged_bits[s] = is_engaged_bits;
        b.target_bits[s] = target_bits;
        let turret = turret_pool();
        if s < turret.count_per_entity.len() {
            let count = turret.count_per_entity[s];
            b.weapon_count[s] = count;
            let base = s * (SNAPSHOT_BASELINE_MAX_TURRETS_PER_ENTITY as usize);
            for t in 0..(count as usize) {
                let src = base + t;
                let dst = base + t;
                b.turret_rots[dst] = turret.rotation[src];
                b.turret_ang_vels[dst] = turret.angular_velocity[src];
                b.turret_pitches[dst] = turret.pitch[src];
                b.turret_pitch_vels[dst] = turret.pitch_velocity[src];
                b.turret_target_ids[dst] = turret.target_id[src];
                b.shield_ranges[dst] = turret.shield_range[src];
            }
        } else {
            b.weapon_count[s] = 0;
        }
    }
}

#[wasm_bindgen]
pub fn snapshot_baseline_capture_building_slot(
    handle: u32,
    slot: u32,
    tick: u32,
    changed_fields: u32,
    x: f64,
    y: f64,
    z: f64,
    rotation: f64,
    is_engaged_bits: u32,
    target_bits: u32,
) {
    let registry = snapshot_baseline_registry();
    let Some(b) = registry.get_mut(handle) else {
        return;
    };
    b.ensure_capacity(slot);
    let s = slot as usize;
    let is_full = b.used[s] == 0 || changed_fields == SNAPSHOT_BASELINE_CAPTURE_FULL;
    b.used[s] = 1;
    b.last_tick[s] = tick;
    if is_full || (changed_fields & ENTITY_CHANGED_POS) != 0 {
        b.x[s] = x;
        b.y[s] = y;
        b.z[s] = z;
    }
    if is_full || (changed_fields & ENTITY_CHANGED_ROT) != 0 {
        b.rotation[s] = rotation;
    }
    if is_full {
        // Buildings don't move — clear physics-fields so a stray emit can't
        // pick up stale unit data left over from a slot recycle.
        b.velocity_x[s] = 0.0;
        b.velocity_y[s] = 0.0;
        b.velocity_z[s] = 0.0;
    }

    // HP + factory/solar/build progress from the entity-meta pool.
    let meta = entity_meta_pool();
    if s < meta.hp_curr.len() {
        if is_full || (changed_fields & ENTITY_CHANGED_HP) != 0 {
            b.hp[s] = meta.hp_curr[s];
        }
        if is_full || (changed_fields & ENTITY_CHANGED_BUILDING) != 0 {
            b.build_progress[s] = if s < meta.build_progress.len() {
                meta.build_progress[s]
            } else {
                1.0
            };
            b.solar_open[s] = if s < meta.solar_open.len() {
                meta.solar_open[s]
            } else {
                1
            };
        }
        if is_full || (changed_fields & ENTITY_CHANGED_FACTORY) != 0 {
            b.factory_progress[s] = if s < meta.factory_progress.len() {
                meta.factory_progress[s]
            } else {
                0.0
            };
            b.is_producing[s] = if s < meta.factory_is_producing.len() {
                meta.factory_is_producing[s]
            } else {
                0
            };
            b.build_queue_len[s] = if s < meta.factory_build_queue_len.len() {
                meta.factory_build_queue_len[s]
            } else {
                0
            };
        }
    }

    // Turret state — buildings with defense turrets (combat) need
    // weapon_count + per-turret state captured the same as units, or
    // the diff kernel would see ENTITY_CHANGED_TURRETS divergence
    // every tick.
    if is_full || (changed_fields & ENTITY_CHANGED_TURRETS) != 0 {
        b.is_engaged_bits[s] = is_engaged_bits;
        b.target_bits[s] = target_bits;
        let turret = turret_pool();
        if s < turret.count_per_entity.len() {
            let count = turret.count_per_entity[s];
            b.weapon_count[s] = count;
            let base = s * (SNAPSHOT_BASELINE_MAX_TURRETS_PER_ENTITY as usize);
            for t in 0..(count as usize) {
                let src = base + t;
                let dst = base + t;
                b.turret_rots[dst] = turret.rotation[src];
                b.turret_ang_vels[dst] = turret.angular_velocity[src];
                b.turret_pitches[dst] = turret.pitch[src];
                b.turret_pitch_vels[dst] = turret.pitch_velocity[src];
                b.turret_target_ids[dst] = turret.target_id[src];
                b.shield_ranges[dst] = turret.shield_range[src];
            }
        } else {
            b.weapon_count[s] = 0;
        }
    }
}

/// Read-back accessor used by the (future) D.3d diff kernel and by
/// invariant checks. Returns 0 (unset) or 1 (used).
#[wasm_bindgen]
pub fn snapshot_baseline_slot_used(handle: u32, slot: u32) -> u8 {
    let registry = snapshot_baseline_registry();
    let Some(b) = registry.get_mut(handle) else {
        return 0;
    };
    let s = slot as usize;
    if s >= b.used.len() {
        return 0;
    }
    b.used[s]
}

/// Read-back accessor for the last tick at which the baseline was
/// captured for `slot`. Returns 0 if the slot is unset.
#[wasm_bindgen]
pub fn snapshot_baseline_slot_last_tick(handle: u32, slot: u32) -> u32 {
    let registry = snapshot_baseline_registry();
    let Some(b) = registry.get_mut(handle) else {
        return 0;
    };
    let s = slot as usize;
    if s >= b.last_tick.len() {
        return 0;
    }
    b.last_tick[s]
}

// Changed-fields bit constants (ENTITY_CHANGED_*) are generated from
// src/wireEnums.json — see the include! near the top of this file.

pub(crate) const SNAPSHOT_BASELINE_CAPTURE_FULL: u32 = u32::MAX;
pub(crate) const SNAPSHOT_NORMAL_THRESHOLD: f64 = 0.001;
pub(crate) const SNAPSHOT_SHIELD_RANGE_THRESHOLD: f32 = 0.001;
pub(crate) const SNAPSHOT_FULL_ROTATION_RADIANS: f64 = std::f64::consts::PI * 2.0;
pub(crate) const SNAPSHOT_RATIO_DELTA_EPSILON: f64 = 1e-9;

// Kind tags for snapshot_baseline_diff_slot (mirror EntityType strings
// 'unit' / 'building' / 'tower' — kept separate from ENTITY_META_TYPE_*
// because callers may want to diff a unit slot without populating the
// entity-meta pool first). TOWER currently diffs through the same path
// as BUILDING (they share the static wire shape), but the kind is
// distinct so future wire-format divergence has a place to land
// without churning every caller.
pub const SNAPSHOT_DIFF_KIND_UNIT: u8 = 1;
pub const SNAPSHOT_DIFF_KIND_BUILDING: u8 = 2;
pub const SNAPSHOT_DIFF_KIND_TOWER: u8 = 3;

pub(crate) fn snapshot_finite_non_negative(value: f64) -> f64 {
    if value.is_finite() && value > 0.0 {
        value
    } else {
        0.0
    }
}

pub(crate) fn snapshot_position_delta_exceeded(
    x: f64,
    y: f64,
    z: f64,
    prev_x: f64,
    prev_y: f64,
    prev_z: f64,
    threshold: f64,
) -> bool {
    let dx = x - prev_x;
    let dy = y - prev_y;
    let dz = z - prev_z;
    (dx * dx + dy * dy + dz * dz).sqrt() > threshold
}

pub(crate) fn snapshot_angular_distance_radians(next: f64, prev: f64) -> f64 {
    let raw = (next - prev).abs() % SNAPSHOT_FULL_ROTATION_RADIANS;
    if raw > std::f64::consts::PI {
        SNAPSHOT_FULL_ROTATION_RADIANS - raw
    } else {
        raw
    }
}

pub(crate) fn snapshot_rotation_delta_exceeded(next: f64, prev: f64, threshold: f64) -> bool {
    snapshot_angular_distance_radians(next, prev) > threshold
}

pub(crate) fn snapshot_vector_magnitude_ratio_delta_exceeded(
    next_x: f64,
    next_y: f64,
    next_z: f64,
    prev_x: f64,
    prev_y: f64,
    prev_z: f64,
    ratio: f64,
) -> bool {
    let next_magnitude = (next_x * next_x + next_y * next_y + next_z * next_z).sqrt();
    let baseline = (prev_x * prev_x + prev_y * prev_y + prev_z * prev_z).sqrt();
    let delta = (next_magnitude - baseline).abs();
    delta > SNAPSHOT_RATIO_DELTA_EPSILON && delta > baseline * snapshot_finite_non_negative(ratio)
}

pub(crate) fn snapshot_vector_direction_delta_exceeded(
    next_x: f64,
    next_y: f64,
    next_z: f64,
    prev_x: f64,
    prev_y: f64,
    prev_z: f64,
    threshold_radians: f64,
) -> bool {
    let next_magnitude = (next_x * next_x + next_y * next_y + next_z * next_z).sqrt();
    let prev_magnitude = (prev_x * prev_x + prev_y * prev_y + prev_z * prev_z).sqrt();
    if next_magnitude <= SNAPSHOT_RATIO_DELTA_EPSILON
        || prev_magnitude <= SNAPSHOT_RATIO_DELTA_EPSILON
    {
        return false;
    }

    let threshold = snapshot_finite_non_negative(threshold_radians);
    if threshold >= std::f64::consts::PI {
        return false;
    }

    let normalized_dot = ((next_x * prev_x + next_y * prev_y + next_z * prev_z)
        / (next_magnitude * prev_magnitude))
        .clamp(-1.0, 1.0);
    normalized_dot < threshold.cos()
}

pub(crate) fn snapshot_vector_velocity_delta_exceeded(
    next_x: f64,
    next_y: f64,
    next_z: f64,
    prev_x: f64,
    prev_y: f64,
    prev_z: f64,
    magnitude_ratio: f64,
    direction_threshold_radians: f64,
) -> bool {
    snapshot_vector_magnitude_ratio_delta_exceeded(
        next_x,
        next_y,
        next_z,
        prev_x,
        prev_y,
        prev_z,
        magnitude_ratio,
    ) || snapshot_vector_direction_delta_exceeded(
        next_x,
        next_y,
        next_z,
        prev_x,
        prev_y,
        prev_z,
        direction_threshold_radians,
    )
}

/// Phase 10 D.3d — diff kernel. Returns the CHANGED-FIELDS mask for
/// one slot by comparing the caller-supplied `current` scalars (and
/// the pool-resident hp / turret / build / factory / solar state)
/// against the per-recipient baseline. Caller is responsible for
/// skipping this call entirely when the baseline is unset
/// (snapshot_baseline_slot_used returns 0 — emit full DTO in that
/// case to match getEntityDeltaChangedFields's isNew path).
///
/// Threshold math is byte-equivalent with
/// stateSerializerEntityDelta.ts:getEntityDeltaChangedFields:
/// position and rotation position thresholds arrive as absolute
/// world/radian values; velocity magnitude thresholds arrive as ratios
/// of their baseline speeds, and velocity direction thresholds arrive
/// as angular thresholds in radians.
#[wasm_bindgen]
pub fn snapshot_baseline_diff_slot(
    handle: u32,
    slot: u32,
    kind: u8,
    x: f64,
    y: f64,
    z: f64,
    rotation: f64,
    velocity_x: f64,
    velocity_y: f64,
    velocity_z: f64,
    normal_x: f64,
    normal_y: f64,
    normal_z: f64,
    action_count: u16,
    action_hash: u32,
    is_engaged_bits: u32,
    target_bits: u32,
    pos_threshold: f64,
    rot_pos_threshold: f64,
    movement_vel_magnitude_threshold_ratio: f64,
    movement_vel_direction_threshold_radians: f64,
    rot_vel_magnitude_threshold_ratio: f64,
    rot_vel_direction_threshold_radians: f64,
    has_buildable: u8,
    has_combat: u8,
    has_factory: u8,
) -> u32 {
    let registry = snapshot_baseline_registry();
    let Some(b) = registry.get_mut(handle) else {
        return 0;
    };
    let s = slot as usize;
    if s >= b.used.len() || b.used[s] == 0 {
        return 0;
    }

    let mut mask: u32 = 0;

    if snapshot_position_delta_exceeded(x, y, z, b.x[s], b.y[s], b.z[s], pos_threshold) {
        mask |= ENTITY_CHANGED_POS;
    }
    if snapshot_rotation_delta_exceeded(rotation, b.rotation[s], rot_pos_threshold) {
        mask |= ENTITY_CHANGED_ROT;
    }

    if kind == SNAPSHOT_DIFF_KIND_UNIT {
        if snapshot_vector_velocity_delta_exceeded(
            velocity_x,
            velocity_y,
            velocity_z,
            b.velocity_x[s],
            b.velocity_y[s],
            b.velocity_z[s],
            movement_vel_magnitude_threshold_ratio,
            movement_vel_direction_threshold_radians,
        ) {
            mask |= ENTITY_CHANGED_VEL;
        }
        let cur_hp = {
            let meta = entity_meta_pool();
            if s < meta.hp_curr.len() {
                meta.hp_curr[s]
            } else {
                0.0
            }
        };
        if cur_hp != b.hp[s] {
            mask |= ENTITY_CHANGED_HP;
        }
        if action_count != b.action_count[s] || action_hash != b.action_hash[s] {
            mask |= ENTITY_CHANGED_ACTIONS;
        }
        if (normal_x - b.normal_x[s]).abs() > SNAPSHOT_NORMAL_THRESHOLD
            || (normal_y - b.normal_y[s]).abs() > SNAPSHOT_NORMAL_THRESHOLD
            || (normal_z - b.normal_z[s]).abs() > SNAPSHOT_NORMAL_THRESHOLD
        {
            mask |= ENTITY_CHANGED_NORMAL;
        }
        if has_buildable != 0 {
            let cur_build = {
                let meta = entity_meta_pool();
                if s < meta.build_progress.len() {
                    meta.build_progress[s]
                } else {
                    0.0
                }
            };
            if cur_build != b.build_progress[s] {
                mask |= ENTITY_CHANGED_BUILDING;
            }
        }
    }

    if has_combat != 0 {
        let turret = turret_pool();
        let cur_weapon_count = if s < turret.count_per_entity.len() {
            turret.count_per_entity[s]
        } else {
            0
        };
        if cur_weapon_count != b.weapon_count[s] {
            mask |= ENTITY_CHANGED_TURRETS;
        } else if cur_weapon_count > 0 {
            let base = s * (SNAPSHOT_BASELINE_MAX_TURRETS_PER_ENTITY as usize);
            let mut turrets_changed = false;
            for t in 0..(cur_weapon_count as usize) {
                let idx = base + t;
                let angular_velocity_changed = snapshot_vector_velocity_delta_exceeded(
                    turret.angular_velocity[idx] as f64,
                    turret.pitch_velocity[idx] as f64,
                    0.0,
                    b.turret_ang_vels[idx] as f64,
                    b.turret_pitch_vels[idx] as f64,
                    0.0,
                    rot_vel_magnitude_threshold_ratio,
                    rot_vel_direction_threshold_radians,
                );
                if snapshot_rotation_delta_exceeded(
                    turret.rotation[idx] as f64,
                    b.turret_rots[idx] as f64,
                    rot_pos_threshold,
                ) || angular_velocity_changed
                    || snapshot_rotation_delta_exceeded(
                        turret.pitch[idx] as f64,
                        b.turret_pitches[idx] as f64,
                        rot_pos_threshold,
                    )
                    || turret.target_id[idx] != b.turret_target_ids[idx]
                    || (turret.shield_range[idx] - b.shield_ranges[idx]).abs()
                        > SNAPSHOT_SHIELD_RANGE_THRESHOLD
                {
                    turrets_changed = true;
                    break;
                }
            }
            if turrets_changed {
                mask |= ENTITY_CHANGED_TURRETS;
            }
        }
        if is_engaged_bits != b.is_engaged_bits[s] || target_bits != b.target_bits[s] {
            mask |= ENTITY_CHANGED_TURRETS;
        }
    }

    if kind == SNAPSHOT_DIFF_KIND_BUILDING || kind == SNAPSHOT_DIFF_KIND_TOWER {
        let meta = entity_meta_pool();
        let cur_hp = if s < meta.hp_curr.len() {
            meta.hp_curr[s]
        } else {
            0.0
        };
        if cur_hp != b.hp[s] {
            mask |= ENTITY_CHANGED_HP;
        }
        let cur_build = if s < meta.build_progress.len() {
            meta.build_progress[s]
        } else {
            0.0
        };
        let cur_solar = if s < meta.solar_open.len() {
            meta.solar_open[s]
        } else {
            1
        };
        if cur_build != b.build_progress[s] || cur_solar != b.solar_open[s] {
            mask |= ENTITY_CHANGED_BUILDING;
        }
        if has_factory != 0 {
            let cur_fp = if s < meta.factory_progress.len() {
                meta.factory_progress[s]
            } else {
                0.0
            };
            let cur_ip = if s < meta.factory_is_producing.len() {
                meta.factory_is_producing[s]
            } else {
                0
            };
            let cur_bql = if s < meta.factory_build_queue_len.len() {
                meta.factory_build_queue_len[s]
            } else {
                0
            };
            if cur_fp != b.factory_progress[s]
                || cur_ip != b.is_producing[s]
                || cur_bql != b.build_queue_len[s]
            {
                mask |= ENTITY_CHANGED_FACTORY;
            }
        }
    }

    mask
}

// ─────────────────────────────────────────────────────────────────
// Snapshot entity encoder (Phase 10 D.3j)
//
// Byte-equal port of stateSerializerEntities.ts:serializeEntitySnapshot's
// output AS msgpack-encoded via @msgpack/msgpack with ignoreUndefined:
// true. Each `snapshot_encode_entity_*` function emits one entity's
// MessagePack bytes into the D.2 writer's scratch buffer; JS reads
// via messagepack_writer_ptr() / _len().
//
// The port lands incrementally — each successive commit handles one
// more field group (envelope → unit sub-object → turret array →
// building sub-object → factory/solar/build/...). Until the full
// kernel exists, callers that need the OUTGOING wire bytes still go
// through the JS path; the Rust path is verified against the JS
// path on every dev build via the (D.3j) byte-equality test runner.
// ─────────────────────────────────────────────────────────────────

/// Entity-type tag for the encoder kernels. Mirrors EntityType
/// strings used in the JS NetworkServerSnapshotEntity DTO.
pub const SNAPSHOT_ENTITY_TYPE_UNIT: u8 = 1;
pub const SNAPSHOT_ENTITY_TYPE_BUILDING: u8 = 2;
pub const SNAPSHOT_ENTITY_TYPE_TOWER: u8 = 3;

/// Encoder turret scratch — JS pre-fills with already-quantized
/// turret values, then the encoder reads from it when emitting the
/// turrets array. Layout per turret (10 f64 = 80 bytes):
///   [0..4]  qRot(rotation, vel, pitch, pitchVel)
///   [4]     turretBlueprintCode (TurretBlueprintCode as f64)
///   [5]     state code (TurretStateCode as f64)
///   [6]     has_target_id (0 or 1)
///   [7]     target_id (raw entity id as f64; ignored when has_target_id==0)
///   [8]     has_shield_range (0 or 1)
///   [9]     shield_range (raw value; ignored when has_ff_range==0)
///
/// Capacity grown on demand by snapshot_encode_turret_scratch_ensure.
pub(crate) const SNAPSHOT_ENCODE_TURRET_STRIDE: usize = 11;

pub(crate) struct SnapshotEncodeTurretScratch {
    buf: Vec<f64>,
}

pub(crate) struct SnapshotEncodeTurretScratchHolder(UnsafeCell<Option<SnapshotEncodeTurretScratch>>);
unsafe impl Sync for SnapshotEncodeTurretScratchHolder {}
pub(crate) static SNAPSHOT_ENCODE_TURRET_SCRATCH: SnapshotEncodeTurretScratchHolder =
    SnapshotEncodeTurretScratchHolder(UnsafeCell::new(None));

#[inline]
pub(crate) fn snapshot_encode_turret_scratch() -> &'static mut SnapshotEncodeTurretScratch {
    unsafe {
        let cell = &mut *SNAPSHOT_ENCODE_TURRET_SCRATCH.0.get();
        if cell.is_none() {
            *cell = Some(SnapshotEncodeTurretScratch {
                buf: vec![0.0; SNAPSHOT_ENCODE_TURRET_STRIDE * 8],
            });
        }
        cell.as_mut().unwrap()
    }
}

#[wasm_bindgen]
pub fn snapshot_encode_turret_scratch_ptr() -> *const f64 {
    snapshot_encode_turret_scratch().buf.as_ptr()
}

#[wasm_bindgen]
pub fn snapshot_encode_turret_scratch_ensure(turret_count: u32) {
    let needed = (turret_count as usize) * SNAPSHOT_ENCODE_TURRET_STRIDE;
    let s = snapshot_encode_turret_scratch();
    if s.buf.len() < needed {
        s.buf.resize(needed, 0.0);
    }
}

/// Encoder action scratch — JS pre-fills with action data, then the
/// encoder reads when emitting the actions array. Layout per action
/// (16 f64 = 128 bytes):
///   [0]   action type code (u8 ActionTypeCode as f64)
///   [1]   has_pos (0 or 1)
///   [2..4] pos.x, pos.y (when has_pos)
///   [4]   has_pos_z (0 or 1)
///   [5]   pos_z (when has_pos_z)
///   [6]   path_exp (1 emits `true`, 0 omits the key)
///   [7]   has_target_id (0 or 1)
///   [8]   target_id (when has_target_id)
///   [9]   has_building_type (0 or 1)
///   [10]  building_type_string_slot (when has_building_type)
///   [11]  has_grid (0 or 1)
///   [12..14] grid.x, grid.y (when has_grid)
///   [14]  has_building_id (0 or 1)
///   [15]  building_id (when has_building_id)
pub(crate) const SNAPSHOT_ENCODE_ACTION_STRIDE: usize = 19;

pub(crate) struct SnapshotEncodeActionScratch {
    buf: Vec<f64>,
}

pub(crate) struct SnapshotEncodeActionScratchHolder(UnsafeCell<Option<SnapshotEncodeActionScratch>>);
unsafe impl Sync for SnapshotEncodeActionScratchHolder {}
pub(crate) static SNAPSHOT_ENCODE_ACTION_SCRATCH: SnapshotEncodeActionScratchHolder =
    SnapshotEncodeActionScratchHolder(UnsafeCell::new(None));

#[inline]
pub(crate) fn snapshot_encode_action_scratch() -> &'static mut SnapshotEncodeActionScratch {
    unsafe {
        let cell = &mut *SNAPSHOT_ENCODE_ACTION_SCRATCH.0.get();
        if cell.is_none() {
            *cell = Some(SnapshotEncodeActionScratch {
                buf: vec![0.0; SNAPSHOT_ENCODE_ACTION_STRIDE * 16],
            });
        }
        cell.as_mut().unwrap()
    }
}

#[wasm_bindgen]
pub fn snapshot_encode_action_scratch_ptr() -> *const f64 {
    snapshot_encode_action_scratch().buf.as_ptr()
}

#[wasm_bindgen]
pub fn snapshot_encode_action_scratch_ensure(action_count: u32) {
    let needed = (action_count as usize) * SNAPSHOT_ENCODE_ACTION_STRIDE;
    let s = snapshot_encode_action_scratch();
    if s.buf.len() < needed {
        s.buf.resize(needed, 0.0);
    }
}

/// String scratch — UTF-8 byte buffer plus an offset/length table
/// indexed by string slot. JS pre-fills both before any encoder
/// call that emits a string field; the kernel reads via the table.
///
/// `bytes` holds the concatenated UTF-8 of every string; `table[2i]`
/// is the byte offset, `table[2i+1]` is the byte length. A slot
/// with length 0 emits the empty string `""`.
pub(crate) struct SnapshotEncodeStringScratch {
    bytes: Vec<u8>,
    table: Vec<u32>,
}

pub(crate) struct SnapshotEncodeStringScratchHolder(UnsafeCell<Option<SnapshotEncodeStringScratch>>);
unsafe impl Sync for SnapshotEncodeStringScratchHolder {}
pub(crate) static SNAPSHOT_ENCODE_STRING_SCRATCH: SnapshotEncodeStringScratchHolder =
    SnapshotEncodeStringScratchHolder(UnsafeCell::new(None));

#[inline]
pub(crate) fn snapshot_encode_string_scratch() -> &'static mut SnapshotEncodeStringScratch {
    unsafe {
        let cell = &mut *SNAPSHOT_ENCODE_STRING_SCRATCH.0.get();
        if cell.is_none() {
            *cell = Some(SnapshotEncodeStringScratch {
                bytes: vec![0u8; 256],
                table: vec![0u32; 16],
            });
        }
        cell.as_mut().unwrap()
    }
}

#[wasm_bindgen]
pub fn snapshot_encode_string_scratch_bytes_ptr() -> *const u8 {
    snapshot_encode_string_scratch().bytes.as_ptr()
}

#[wasm_bindgen]
pub fn snapshot_encode_string_scratch_table_ptr() -> *const u32 {
    snapshot_encode_string_scratch().table.as_ptr()
}

#[wasm_bindgen]
pub fn snapshot_encode_string_scratch_ensure_bytes(byte_count: u32) {
    let s = snapshot_encode_string_scratch();
    let needed = byte_count as usize;
    if s.bytes.len() < needed {
        s.bytes.resize(needed, 0);
    }
}

#[wasm_bindgen]
pub fn snapshot_encode_string_scratch_ensure_table(slot_count: u32) {
    let s = snapshot_encode_string_scratch();
    let needed = (slot_count as usize) * 2; // pairs of (offset, length)
    if s.table.len() < needed {
        s.table.resize(needed, 0);
    }
}

/// Factory selected-unit scratch — one unit-type code when the factory
/// has a repeat-build selection. JS pre-fills before calling
/// encode_entity_building with has_factory=1.
pub(crate) struct SnapshotEncodeFactoryQueueScratch {
    buf: Vec<u32>,
}

pub(crate) struct SnapshotEncodeFactoryQueueScratchHolder(
    UnsafeCell<Option<SnapshotEncodeFactoryQueueScratch>>,
);
unsafe impl Sync for SnapshotEncodeFactoryQueueScratchHolder {}
pub(crate) static SNAPSHOT_ENCODE_FACTORY_QUEUE_SCRATCH: SnapshotEncodeFactoryQueueScratchHolder =
    SnapshotEncodeFactoryQueueScratchHolder(UnsafeCell::new(None));

#[inline]
pub(crate) fn snapshot_encode_factory_queue_scratch() -> &'static mut SnapshotEncodeFactoryQueueScratch {
    unsafe {
        let cell = &mut *SNAPSHOT_ENCODE_FACTORY_QUEUE_SCRATCH.0.get();
        if cell.is_none() {
            *cell = Some(SnapshotEncodeFactoryQueueScratch {
                buf: vec![0u32; 16],
            });
        }
        cell.as_mut().unwrap()
    }
}

#[wasm_bindgen]
pub fn snapshot_encode_factory_queue_scratch_ptr() -> *const u32 {
    snapshot_encode_factory_queue_scratch().buf.as_ptr()
}

#[wasm_bindgen]
pub fn snapshot_encode_factory_queue_scratch_ensure(count: u32) {
    let s = snapshot_encode_factory_queue_scratch();
    if s.buf.len() < count as usize {
        s.buf.resize(count as usize, 0);
    }
}

/// Factory waypoint scratch — 5 f64 per waypoint:
///   [0..2]  pos.x, pos.y
///   [2]     has_pos_z (0 or 1)
///   [3]     pos_z (when has_pos_z)
///   [4]     type_string_slot (index into string scratch)
pub(crate) const SNAPSHOT_ENCODE_WAYPOINT_STRIDE: usize = 5;

pub(crate) struct SnapshotEncodeWaypointScratch {
    buf: Vec<f64>,
}

pub(crate) struct SnapshotEncodeWaypointScratchHolder(UnsafeCell<Option<SnapshotEncodeWaypointScratch>>);
unsafe impl Sync for SnapshotEncodeWaypointScratchHolder {}
pub(crate) static SNAPSHOT_ENCODE_WAYPOINT_SCRATCH: SnapshotEncodeWaypointScratchHolder =
    SnapshotEncodeWaypointScratchHolder(UnsafeCell::new(None));

#[inline]
pub(crate) fn snapshot_encode_waypoint_scratch() -> &'static mut SnapshotEncodeWaypointScratch {
    unsafe {
        let cell = &mut *SNAPSHOT_ENCODE_WAYPOINT_SCRATCH.0.get();
        if cell.is_none() {
            *cell = Some(SnapshotEncodeWaypointScratch {
                buf: vec![0.0; SNAPSHOT_ENCODE_WAYPOINT_STRIDE * 16],
            });
        }
        cell.as_mut().unwrap()
    }
}

#[wasm_bindgen]
pub fn snapshot_encode_waypoint_scratch_ptr() -> *const f64 {
    snapshot_encode_waypoint_scratch().buf.as_ptr()
}

#[wasm_bindgen]
pub fn snapshot_encode_waypoint_scratch_ensure(count: u32) {
    let needed = (count as usize) * SNAPSHOT_ENCODE_WAYPOINT_STRIDE;
    let s = snapshot_encode_waypoint_scratch();
    if s.buf.len() < needed {
        s.buf.resize(needed, 0.0);
    }
}

/// Write a string slot's bytes to the MessagePack writer. Returns
/// silently for out-of-bounds slots (caller is responsible for
/// having populated the slot via the byte+table buffers).
pub(crate) fn write_string_from_scratch(w: &mut MessagePackWriter, slot: u32) {
    let scratch = snapshot_encode_string_scratch();
    let s = slot as usize;
    let i = s * 2;
    if i + 1 >= scratch.table.len() {
        w.write_str("");
        return;
    }
    let offset = scratch.table[i] as usize;
    let length = scratch.table[i + 1] as usize;
    if offset + length > scratch.bytes.len() {
        w.write_str("");
        return;
    }
    // SAFETY: caller wrote valid UTF-8 into this region. Skip the
    // UTF-8 check (from_utf8 + unwrap) — wasm-bindgen guarantees
    // valid UTF-8 from the JS TextEncoder source.
    let bytes = &scratch.bytes[offset..offset + length];
    let s = unsafe { core::str::from_utf8_unchecked(bytes) };
    w.write_str(s);
}

/// Write the sparse envelope key-value pairs (id, type, optional pos,
/// optional rotation, playerId, changedFields) shared by every encoder kernel. Caller
/// is responsible for writing the parent map header with the right
/// key count (envelope keys + sub-object keys). `changed_fields` is
/// emitted only when `has_changed_fields != 0` so the full-snapshot
/// path can omit the key entirely.
pub(crate) fn write_entity_envelope_keys(
    w: &mut MessagePackWriter,
    id: u32,
    type_tag: u8,
    qpos_x: f64,
    qpos_y: f64,
    qpos_z: f64,
    qrot: f64,
    player_id: u8,
    has_changed_fields: u8,
    changed_fields: u32,
) {
    let is_full = has_changed_fields == 0;
    let has_pos = is_full || (changed_fields & ENTITY_CHANGED_POS) != 0;
    let has_rotation = is_full || (changed_fields & ENTITY_CHANGED_ROT) != 0;

    w.write_str("id");
    w.write_uint(id as u64);

    w.write_str("type");
    match type_tag {
        SNAPSHOT_ENTITY_TYPE_UNIT => w.write_str("unit"),
        SNAPSHOT_ENTITY_TYPE_BUILDING => w.write_str("building"),
        SNAPSHOT_ENTITY_TYPE_TOWER => w.write_str("tower"),
        _ => w.write_str(""),
    }

    if has_pos {
        w.write_str("pos");
        w.write_map_header(3);
        w.write_str("x");
        w.write_number(qpos_x);
        w.write_str("y");
        w.write_number(qpos_y);
        w.write_str("z");
        w.write_number(qpos_z);
    }

    if has_rotation {
        w.write_str("rotation");
        w.write_number(qrot);
    }

    w.write_str("playerId");
    w.write_uint(player_id as u64);

    if has_changed_fields != 0 {
        w.write_str("changedFields");
        w.write_uint(changed_fields as u64);
    }
}

pub(crate) fn entity_envelope_key_count(has_changed_fields: u8, changed_fields: u32) -> usize {
    let is_full = has_changed_fields == 0;
    let mut key_count: usize = 3; // id, type, playerId
    if is_full || (changed_fields & ENTITY_CHANGED_POS) != 0 {
        key_count += 1;
    }
    if is_full || (changed_fields & ENTITY_CHANGED_ROT) != 0 {
        key_count += 1;
    }
    if has_changed_fields != 0 {
        key_count += 1;
    }
    key_count
}

/// Encode the entity envelope: `{id, type, [pos,] [rotation,] playerId
/// [, changedFields]}` — the base fields every
/// NetworkServerSnapshotEntity carries plus the optional delta mask.
/// Output written to the D.2 writer; returns the number of bytes.
///
/// Field order matches the JS DTO's property insertion order so the
/// MessagePack key sequence is identical: id → type → pos → rotation
/// → playerId → changedFields. Quantized numbers are passed in as
/// f64 (caller does qPos / qRot conversion).
#[wasm_bindgen]
pub fn snapshot_encode_entity_basic(
    id: u32,
    type_tag: u8,
    qpos_x: f64,
    qpos_y: f64,
    qpos_z: f64,
    qrot: f64,
    player_id: u8,
    has_changed_fields: u8,
    changed_fields: u32,
) -> u32 {
    let w = messagepack_writer();
    let start = w.buf.len();

    let key_count = entity_envelope_key_count(has_changed_fields, changed_fields);
    w.write_map_header(key_count);
    write_entity_envelope_keys(
        w,
        id,
        type_tag,
        qpos_x,
        qpos_y,
        qpos_z,
        qrot,
        player_id,
        has_changed_fields,
        changed_fields,
    );
    (w.buf.len() - start) as u32
}

/// Encode an entity with a unit sub-object. Delta records only emit
/// `hp` and `velocity` when the corresponding changedFields bit is set.
/// Optional keys gated by `has_*` flags include surfaceNormal,
/// orientation, angularVelocity3, actions, turrets, and build state.
///
/// Field order inside `unit` mirrors the pooled DTO's runtime
/// insertion order in stateSerializerEntities.ts.
#[wasm_bindgen]
pub fn snapshot_encode_entity_unit(
    id: u32,
    type_tag: u8,
    qpos_x: f64,
    qpos_y: f64,
    qpos_z: f64,
    qrot: f64,
    player_id: u8,
    has_changed_fields: u8,
    changed_fields: u32,
    hp_curr: f64,
    hp_max: f64,
    qvel_x: f64,
    qvel_y: f64,
    qvel_z: f64,
    has_unit_type: u8,
    unit_type_code: u32,
    has_radius: u8,
    radius_visual: f64,
    radius_hitbox: f64,
    radius_collision: f64,
    has_body_center_height: u8,
    body_center_height: f64,
    has_mass: u8,
    mass: f64,
    has_surface_normal: u8,
    qnormal_x: f64,
    qnormal_y: f64,
    qnormal_z: f64,
    has_orientation: u8,
    qorient_x: f64,
    qorient_y: f64,
    qorient_z: f64,
    qorient_w: f64,
    has_angular_velocity3: u8,
    qangvel_x: f64,
    qangvel_y: f64,
    qangvel_z: f64,
    has_fire_enabled: u8,
    has_is_commander: u8,
    has_build_target_id: u8,
    build_target_id_is_null: u8,
    build_target_id: u32,
    has_actions: u8,
    action_count: u8,
    has_turrets: u8,
    turret_count: u8,
    has_build: u8,
    build_complete: u8,
    build_paid_energy: f64,
    build_paid_metal: f64,
) -> u32 {
    let w = messagepack_writer();
    let start = w.buf.len();

    let mut key_count = entity_envelope_key_count(has_changed_fields, changed_fields);
    key_count += 1; // unit
    w.write_map_header(key_count);
    write_entity_envelope_keys(
        w,
        id,
        type_tag,
        qpos_x,
        qpos_y,
        qpos_z,
        qrot,
        player_id,
        has_changed_fields,
        changed_fields,
    );

    let is_full = has_changed_fields == 0;
    let has_hp = is_full || (changed_fields & ENTITY_CHANGED_HP) != 0;
    let has_velocity = is_full || (changed_fields & ENTITY_CHANGED_VEL) != 0;
    let mut unit_field_count: usize = 0;
    if has_hp {
        unit_field_count += 1;
    }
    if has_velocity {
        unit_field_count += 1;
    }
    if has_unit_type != 0 {
        unit_field_count += 1;
    }
    if has_radius != 0 {
        unit_field_count += 1;
    }
    if has_body_center_height != 0 {
        unit_field_count += 1;
    }
    if has_mass != 0 {
        unit_field_count += 1;
    }
    if has_is_commander != 0 {
        unit_field_count += 1;
    }
    if has_surface_normal != 0 {
        unit_field_count += 1;
    }
    if has_orientation != 0 {
        unit_field_count += 1;
    }
    if has_angular_velocity3 != 0 {
        unit_field_count += 1;
    }
    if has_fire_enabled != 0 {
        unit_field_count += 2; // fireEnabled + fireState
    }
    if has_build != 0 {
        unit_field_count += 1;
    }
    if has_actions != 0 {
        unit_field_count += 1;
    }
    if has_turrets != 0 {
        unit_field_count += 1;
    }
    if has_build_target_id != 0 {
        unit_field_count += 1;
    }

    w.write_str("unit");
    w.write_map_header(unit_field_count);

    if has_hp {
        w.write_str("hp");
        w.write_map_header(2);
        w.write_str("curr");
        w.write_number(hp_curr);
        w.write_str("max");
        w.write_number(hp_max);
    }

    if has_velocity {
        w.write_str("velocity");
        w.write_map_header(3);
        w.write_str("x");
        w.write_number(qvel_x);
        w.write_str("y");
        w.write_number(qvel_y);
        w.write_str("z");
        w.write_number(qvel_z);
    }

    if has_unit_type != 0 {
        w.write_str("unitBlueprintCode");
        w.write_uint(unit_type_code as u64);
    }

    if has_radius != 0 {
        w.write_str("radius");
        w.write_map_header(3);
        w.write_str("visual");
        w.write_number(radius_visual);
        w.write_str("hitbox");
        w.write_number(radius_hitbox);
        w.write_str("collision");
        w.write_number(radius_collision);
    }

    if has_body_center_height != 0 {
        w.write_str("bodyCenterHeight");
        w.write_number(body_center_height);
    }

    if has_mass != 0 {
        w.write_str("mass");
        w.write_number(mass);
    }

    if has_is_commander != 0 {
        w.write_str("isCommander");
        w.write_bool(true);
    }

    if has_surface_normal != 0 {
        w.write_str("surfaceNormal");
        w.write_map_header(3);
        w.write_str("nx");
        w.write_number(qnormal_x);
        w.write_str("ny");
        w.write_number(qnormal_y);
        w.write_str("nz");
        w.write_number(qnormal_z);
    }

    if has_orientation != 0 {
        w.write_str("orientation");
        w.write_map_header(4);
        w.write_str("x");
        w.write_number(qorient_x);
        w.write_str("y");
        w.write_number(qorient_y);
        w.write_str("z");
        w.write_number(qorient_z);
        w.write_str("w");
        w.write_number(qorient_w);
    }

    if has_angular_velocity3 != 0 {
        w.write_str("angularVelocity3");
        w.write_map_header(3);
        w.write_str("x");
        w.write_number(qangvel_x);
        w.write_str("y");
        w.write_number(qangvel_y);
        w.write_str("z");
        w.write_number(qangvel_z);
    }

    // Tri-state scalar/boolean optionals — JS emits them as
    // `false`/`true`/`number|null` or undefined (omitted). Each
    // `has_*` flag gates the key-value pair entirely.
    if has_fire_enabled != 0 {
        w.write_str("fireEnabled");
        w.write_bool(false);
        w.write_str("fireState");
        w.write_str("holdFire");
    }

    if has_build != 0 {
        w.write_str("build");
        w.write_map_header(2); // complete + paid
        w.write_str("complete");
        w.write_bool(build_complete != 0);
        w.write_str("paid");
        w.write_map_header(2);
        w.write_str("energy");
        w.write_number(build_paid_energy);
        w.write_str("metal");
        w.write_number(build_paid_metal);
    }

    if has_actions != 0 {
        let count = action_count as usize;
        let scratch = snapshot_encode_action_scratch();
        w.write_str("actions");
        w.write_array_header(count);
        for a in 0..count {
            let base = a * SNAPSHOT_ENCODE_ACTION_STRIDE;
            let type_code = scratch.buf[base];
            let has_pos = scratch.buf[base + 1] != 0.0;
            let pos_x = scratch.buf[base + 2];
            let pos_y = scratch.buf[base + 3];
            let has_pos_z = scratch.buf[base + 4] != 0.0;
            let pos_z = scratch.buf[base + 5];
            let path_exp = scratch.buf[base + 6] != 0.0;
            let has_target_id = scratch.buf[base + 7] != 0.0;
            let target_id = scratch.buf[base + 8];
            let has_building_type = scratch.buf[base + 9] != 0.0;
            let building_type_string_slot = scratch.buf[base + 10] as u32;
            let has_grid = scratch.buf[base + 11] != 0.0;
            let grid_x = scratch.buf[base + 12];
            let grid_y = scratch.buf[base + 13];
            let has_building_id = scratch.buf[base + 14] != 0.0;
            let building_id = scratch.buf[base + 15];

            // Insertion order in createActionDto: type, pos, posZ,
            // pathExp, targetId, buildingBlueprintId, grid, buildingId.
            // ignoreUndefined drops absent keys.
            let mut action_field_count: usize = 1; // type (always present)
            if has_pos {
                action_field_count += 1;
            }
            if has_pos_z {
                action_field_count += 1;
            }
            if path_exp {
                action_field_count += 1;
            }
            if has_target_id {
                action_field_count += 1;
            }
            if has_building_type {
                action_field_count += 1;
            }
            if has_grid {
                action_field_count += 1;
            }
            if has_building_id {
                action_field_count += 1;
            }
            w.write_map_header(action_field_count);

            w.write_str("type");
            w.write_number(type_code);

            if has_pos {
                w.write_str("pos");
                w.write_map_header(2);
                w.write_str("x");
                w.write_number(pos_x);
                w.write_str("y");
                w.write_number(pos_y);
            }
            if has_pos_z {
                w.write_str("posZ");
                w.write_number(pos_z);
            }
            if path_exp {
                w.write_str("pathExp");
                w.write_bool(true);
            }
            if has_target_id {
                w.write_str("targetId");
                w.write_number(target_id);
            }
            if has_building_type {
                w.write_str("buildingBlueprintId");
                write_string_from_scratch(w, building_type_string_slot);
            }
            if has_grid {
                w.write_str("grid");
                w.write_map_header(2);
                w.write_str("x");
                w.write_number(grid_x);
                w.write_str("y");
                w.write_number(grid_y);
            }
            if has_building_id {
                w.write_str("buildingId");
                w.write_number(building_id);
            }
        }
    }

    if has_turrets != 0 {
        let count = turret_count as usize;
        let scratch = snapshot_encode_turret_scratch();
        w.write_str("turrets");
        w.write_array_header(count);
        for t in 0..count {
            let base = t * SNAPSHOT_ENCODE_TURRET_STRIDE;
            let qrot = scratch.buf[base];
            let qvel = scratch.buf[base + 1];
            let qpitch = scratch.buf[base + 2];
            let qpitch_vel = scratch.buf[base + 3];
            let turret_blueprint_code = scratch.buf[base + 4];
            let state_code = scratch.buf[base + 5];
            let has_target = scratch.buf[base + 6] != 0.0;
            let target_id_raw = scratch.buf[base + 7];
            let has_ff_range = scratch.buf[base + 8] != 0.0;
            let ff_range_raw = scratch.buf[base + 9];

            // turret DTO: { turret: { turretBlueprintCode, angular: {4 fields} }, [targetId,]
            // state, [currentShieldRange] }
            let mut turret_field_count: usize = 2; // turret + state
            if has_target {
                turret_field_count += 1;
            }
            if has_ff_range {
                turret_field_count += 1;
            }
            w.write_map_header(turret_field_count);

            w.write_str("turret");
            w.write_map_header(2); // turretBlueprintCode + angular
            w.write_str("turretBlueprintCode");
            w.write_number(turret_blueprint_code);
            w.write_str("angular");
            w.write_map_header(4);
            w.write_str("rot");
            w.write_number(qrot);
            w.write_str("vel");
            w.write_number(qvel);
            w.write_str("pitch");
            w.write_number(qpitch);
            w.write_str("pitchVel");
            w.write_number(qpitch_vel);

            if has_target {
                w.write_str("targetId");
                w.write_number(target_id_raw);
            }

            w.write_str("state");
            w.write_number(state_code);

            if has_ff_range {
                w.write_str("currentShieldRange");
                w.write_number(ff_range_raw);
            }
        }
    }

    if has_build_target_id != 0 {
        w.write_str("buildTargetId");
        if build_target_id_is_null != 0 {
            w.write_nil();
        } else {
            w.write_uint(build_target_id as u64);
        }
    }

    (w.buf.len() - start) as u32
}

/// Encode a building entity DTO: `{...envelope, building: {
///   [type,] [dim,] [hp,] [build,] [metalExtractionRate,] [solar,] [turrets]
/// }}` — covers everything except the factory sub-object (next commit).
///
/// hp + build are sparse on delta records and are emitted only when
/// their changedFields group is set. Other building-sub fields are gated
/// by their `has_*` flags. Turrets reuse the same scratch as units
/// (D.3j-9).
#[wasm_bindgen]
pub fn snapshot_encode_entity_building(
    id: u32,
    qpos_x: f64,
    qpos_y: f64,
    qpos_z: f64,
    qrot: f64,
    player_id: u8,
    has_changed_fields: u8,
    changed_fields: u32,
    has_type: u8,
    type_code: f64,
    has_dim: u8,
    dim_x: f64,
    dim_y: f64,
    hp_curr: f64,
    hp_max: f64,
    build_complete: u8,
    build_paid_energy: f64,
    build_paid_metal: f64,
    has_metal_extraction_rate: u8,
    metal_extraction_rate: f64,
    has_solar: u8,
    solar_open: u8,
    has_turrets: u8,
    turret_count: u8,
    has_factory: u8,
    factory_queue_count: u32,
    factory_progress: f64,
    factory_producing: u8,
    factory_energy_rate: f64,
    factory_metal_rate: f64,
    factory_waypoint_count: u32,
) -> u32 {
    let w = messagepack_writer();
    let start = w.buf.len();

    let mut key_count = entity_envelope_key_count(has_changed_fields, changed_fields);
    key_count += 1; // building
    w.write_map_header(key_count);
    write_entity_envelope_keys(
        w,
        id,
        SNAPSHOT_ENTITY_TYPE_BUILDING,
        qpos_x,
        qpos_y,
        qpos_z,
        qrot,
        player_id,
        has_changed_fields,
        changed_fields,
    );

    let is_full = has_changed_fields == 0;
    let has_hp = is_full || (changed_fields & ENTITY_CHANGED_HP) != 0;
    let has_build = is_full || (changed_fields & ENTITY_CHANGED_BUILDING) != 0;
    let mut building_field_count: usize = 0;
    if has_hp {
        building_field_count += 1;
    }
    if has_build {
        building_field_count += 1;
    }
    if has_type != 0 {
        building_field_count += 1;
    }
    if has_dim != 0 {
        building_field_count += 1;
    }
    if has_metal_extraction_rate != 0 {
        building_field_count += 1;
    }
    if has_solar != 0 {
        building_field_count += 1;
    }
    if has_turrets != 0 {
        building_field_count += 1;
    }
    if has_factory != 0 {
        building_field_count += 1;
    }

    w.write_str("building");
    w.write_map_header(building_field_count);

    if has_type != 0 {
        w.write_str("buildingBlueprintCode");
        w.write_number(type_code);
    }
    if has_dim != 0 {
        w.write_str("dim");
        w.write_map_header(2);
        w.write_str("x");
        w.write_number(dim_x);
        w.write_str("y");
        w.write_number(dim_y);
    }

    if has_hp {
        w.write_str("hp");
        w.write_map_header(2);
        w.write_str("curr");
        w.write_number(hp_curr);
        w.write_str("max");
        w.write_number(hp_max);
    }

    if has_build {
        w.write_str("build");
        w.write_map_header(2);
        w.write_str("complete");
        w.write_bool(build_complete != 0);
        w.write_str("paid");
        w.write_map_header(2);
        w.write_str("energy");
        w.write_number(build_paid_energy);
        w.write_str("metal");
        w.write_number(build_paid_metal);
    }

    if has_metal_extraction_rate != 0 {
        w.write_str("metalExtractionRate");
        w.write_number(metal_extraction_rate);
    }
    if has_solar != 0 {
        w.write_str("solar");
        w.write_map_header(1);
        w.write_str("open");
        w.write_bool(solar_open != 0);
    }
    if has_turrets != 0 {
        let count = turret_count as usize;
        let scratch = snapshot_encode_turret_scratch();
        w.write_str("turrets");
        w.write_array_header(count);
        for t in 0..count {
            let base = t * SNAPSHOT_ENCODE_TURRET_STRIDE;
            let qrot_t = scratch.buf[base];
            let qvel = scratch.buf[base + 1];
            let qpitch = scratch.buf[base + 2];
            let qpitch_vel = scratch.buf[base + 3];
            let turret_blueprint_code = scratch.buf[base + 4];
            let state_code = scratch.buf[base + 5];
            let has_target = scratch.buf[base + 6] != 0.0;
            let target_id_raw = scratch.buf[base + 7];
            let has_ff_range = scratch.buf[base + 8] != 0.0;
            let ff_range_raw = scratch.buf[base + 9];

            let mut turret_field_count: usize = 2; // turret + state
            if has_target {
                turret_field_count += 1;
            }
            if has_ff_range {
                turret_field_count += 1;
            }
            w.write_map_header(turret_field_count);

            w.write_str("turret");
            w.write_map_header(2);
            w.write_str("turretBlueprintCode");
            w.write_number(turret_blueprint_code);
            w.write_str("angular");
            w.write_map_header(4);
            w.write_str("rot");
            w.write_number(qrot_t);
            w.write_str("vel");
            w.write_number(qvel);
            w.write_str("pitch");
            w.write_number(qpitch);
            w.write_str("pitchVel");
            w.write_number(qpitch_vel);

            if has_target {
                w.write_str("targetId");
                w.write_number(target_id_raw);
            }
            w.write_str("state");
            w.write_number(state_code);
            if has_ff_range {
                w.write_str("currentShieldRange");
                w.write_number(ff_range_raw);
            }
        }
    }

    if has_factory != 0 {
        w.write_str("factory");
        w.write_map_header(6); // selectedUnitBlueprintCode, progress, producing, energyRate, metalRate, rally

        let qc = factory_queue_count as usize;
        w.write_str("selectedUnitBlueprintCode");
        if qc > 0 {
            let q = snapshot_encode_factory_queue_scratch();
            w.write_uint(q.buf[0] as u64);
        } else {
            w.write_nil();
        }

        w.write_str("progress");
        w.write_number(factory_progress);

        w.write_str("producing");
        w.write_bool(factory_producing != 0);

        w.write_str("energyRate");
        w.write_number(factory_energy_rate);

        w.write_str("metalRate");
        w.write_number(factory_metal_rate);

        let wpc = factory_waypoint_count as usize;
        w.write_str("rally");
        if wpc > 0 {
            let wp = snapshot_encode_waypoint_scratch();
            let base = 0;
            let pos_x = wp.buf[base];
            let pos_y = wp.buf[base + 1];
            let has_pos_z = wp.buf[base + 2] != 0.0;
            let pos_z = wp.buf[base + 3];
            let type_slot = wp.buf[base + 4] as u32;

            let wp_field_count = if has_pos_z { 3 } else { 2 };
            w.write_map_header(wp_field_count);
            w.write_str("pos");
            w.write_map_header(2);
            w.write_str("x");
            w.write_number(pos_x);
            w.write_str("y");
            w.write_number(pos_y);
            if has_pos_z {
                w.write_str("posZ");
                w.write_number(pos_z);
            }
            w.write_str("type");
            write_string_from_scratch(w, type_slot);
        } else {
            w.write_nil();
        }
    }

    (w.buf.len() - start) as u32
}

/// Phase 10 D.3j-15: snapshot envelope encoder.
///
/// Mirrors stateSerializer.ts's `_snapshotBuf` pool entry layout:
/// the entries are inserted in declaration order at pool creation
/// (tick, entities, minimapEntities, economy, sprayTargets,
/// audioEvents, projectiles, gameState, grid, isDelta,
/// removedEntityIds, visibilityFiltered). msgpack-with-
/// ignoreUndefined emits ONLY the keys whose values are not
/// undefined.
///
/// This commit covers the always-present minimum subset:
///   - tick (uint)
///   - entities[] (array of unit/building DTOs appended between
///     `_begin` and `_continue` via the per-entity encoders)
///   - economy (empty map for now)
///   - isDelta (bool)
///
/// Other envelope fields (audioEvents, projectiles, gameState,
/// economy contents, etc.) come in follow-up commits.
///
/// API:
///   1. `snapshot_encode_envelope_begin(tick, entity_count)`
///      → clears the writer, writes the envelope map header + tick
///      key + entities key + array16 header.
///   2. For each entity: JS packs scratches and calls one of the
///      existing entity encoders. They APPEND now (no auto-clear).
///   3. `snapshot_encode_envelope_continue(is_delta)`
///      → writes economy = {} + isDelta key. Returns total
///      written bytes.
/// Minimap-entities scratch — 6 f64 per entry:
///   [0]   id (entity id)
///   [1]   pos.x
///   [2]   pos.y
///   [3]   type_tag (1 = unit, 2 = building, 3 = tower, matches SNAPSHOT_ENTITY_TYPE_*)
///   [4]   playerId
///   [5]   has_radar_only + (radar_only << 1) packed: 0 = omit, 2 = emit
///         false (rare), 3 = emit true. Practically only 0 or 3 appear.
pub(crate) const SNAPSHOT_ENCODE_MINIMAP_STRIDE: usize = 6;

pub(crate) struct SnapshotEncodeMinimapScratch {
    buf: Vec<f64>,
}

pub(crate) struct SnapshotEncodeMinimapScratchHolder(UnsafeCell<Option<SnapshotEncodeMinimapScratch>>);
unsafe impl Sync for SnapshotEncodeMinimapScratchHolder {}
pub(crate) static SNAPSHOT_ENCODE_MINIMAP_SCRATCH: SnapshotEncodeMinimapScratchHolder =
    SnapshotEncodeMinimapScratchHolder(UnsafeCell::new(None));

#[inline]
pub(crate) fn snapshot_encode_minimap_scratch() -> &'static mut SnapshotEncodeMinimapScratch {
    unsafe {
        let cell = &mut *SNAPSHOT_ENCODE_MINIMAP_SCRATCH.0.get();
        if cell.is_none() {
            *cell = Some(SnapshotEncodeMinimapScratch {
                buf: vec![0.0; SNAPSHOT_ENCODE_MINIMAP_STRIDE * 16],
            });
        }
        cell.as_mut().unwrap()
    }
}

#[wasm_bindgen]
pub fn snapshot_encode_minimap_scratch_ptr() -> *const f64 {
    snapshot_encode_minimap_scratch().buf.as_ptr()
}

#[wasm_bindgen]
pub fn snapshot_encode_minimap_scratch_ensure(count: u32) {
    let needed = (count as usize) * SNAPSHOT_ENCODE_MINIMAP_STRIDE;
    let s = snapshot_encode_minimap_scratch();
    if s.buf.len() < needed {
        s.buf.resize(needed, 0.0);
    }
}

/// Projectile-despawn scratch — Uint32Array of projectile ids
/// (one u32 per despawn entry).
pub(crate) struct SnapshotEncodeProjDespawnScratch {
    buf: Vec<u32>,
}

pub(crate) struct SnapshotEncodeProjDespawnScratchHolder(UnsafeCell<Option<SnapshotEncodeProjDespawnScratch>>);
unsafe impl Sync for SnapshotEncodeProjDespawnScratchHolder {}
pub(crate) static SNAPSHOT_ENCODE_PROJ_DESPAWN_SCRATCH: SnapshotEncodeProjDespawnScratchHolder =
    SnapshotEncodeProjDespawnScratchHolder(UnsafeCell::new(None));

#[inline]
pub(crate) fn snapshot_encode_proj_despawn_scratch() -> &'static mut SnapshotEncodeProjDespawnScratch {
    unsafe {
        let cell = &mut *SNAPSHOT_ENCODE_PROJ_DESPAWN_SCRATCH.0.get();
        if cell.is_none() {
            *cell = Some(SnapshotEncodeProjDespawnScratch {
                buf: vec![0u32; 32],
            });
        }
        cell.as_mut().unwrap()
    }
}

#[wasm_bindgen]
pub fn snapshot_encode_proj_despawn_scratch_ptr() -> *const u32 {
    snapshot_encode_proj_despawn_scratch().buf.as_ptr()
}

#[wasm_bindgen]
pub fn snapshot_encode_proj_despawn_scratch_ensure(count: u32) {
    let s = snapshot_encode_proj_despawn_scratch();
    if s.buf.len() < count as usize {
        s.buf.resize(count as usize, 0);
    }
}

/// Projectile velocity-update scratch — 8 f64 per entry:
///   [0]   id
///   [1..4] pos.x, pos.y, pos.z
///   [4..7] velocity.x, velocity.y, velocity.z
///   [7]   clearHomingTarget flag
pub(crate) const SNAPSHOT_ENCODE_PROJ_VEL_STRIDE: usize = 8;

pub(crate) struct SnapshotEncodeProjVelScratch {
    buf: Vec<f64>,
}

pub(crate) struct SnapshotEncodeProjVelScratchHolder(UnsafeCell<Option<SnapshotEncodeProjVelScratch>>);
unsafe impl Sync for SnapshotEncodeProjVelScratchHolder {}
pub(crate) static SNAPSHOT_ENCODE_PROJ_VEL_SCRATCH: SnapshotEncodeProjVelScratchHolder =
    SnapshotEncodeProjVelScratchHolder(UnsafeCell::new(None));

#[inline]
pub(crate) fn snapshot_encode_proj_vel_scratch() -> &'static mut SnapshotEncodeProjVelScratch {
    unsafe {
        let cell = &mut *SNAPSHOT_ENCODE_PROJ_VEL_SCRATCH.0.get();
        if cell.is_none() {
            *cell = Some(SnapshotEncodeProjVelScratch {
                buf: vec![0.0; SNAPSHOT_ENCODE_PROJ_VEL_STRIDE * 32],
            });
        }
        cell.as_mut().unwrap()
    }
}

#[wasm_bindgen]
pub fn snapshot_encode_proj_vel_scratch_ptr() -> *const f64 {
    snapshot_encode_proj_vel_scratch().buf.as_ptr()
}

#[wasm_bindgen]
pub fn snapshot_encode_proj_vel_scratch_ensure(count: u32) {
    let needed = (count as usize) * SNAPSHOT_ENCODE_PROJ_VEL_STRIDE;
    let s = snapshot_encode_proj_vel_scratch();
    if s.buf.len() < needed {
        s.buf.resize(needed, 0.0);
    }
}

/// Projectile spawn scratch — 32 f64 per entry. Field order matches
/// `createPooledProjectileSpawn` in stateSerializerProjectiles.ts so
/// the emit loop walks the slots in DTO insertion order.
///   [0]    id
///   [1..4] pos.x, pos.y, pos.z
///   [4]    rotation
///   [5..8] velocity.x, velocity.y, velocity.z
///   [8]    projectileType (code)
///   [9]    maxLifespan (gated by flag bit 0)
///   [10]   turretBlueprintCode
///   [11]   shotBlueprintCode (gated by flag bit 1)
///   [12]   sourceTurretBlueprintCode (gated by flag bit 2)
///   [13]   playerId
///   [14]   sourceEntityId
///   [15]   turretIndex
///   [16]   barrelIndex
///   [17..20] beam.start.x/y/z (gated by flag bit 5)
///   [20..23] beam.end.x/y/z (gated by flag bit 5)
///   [23]   targetEntityId (gated by flag bit 6)
///   [24]   homingTurnRate (gated by flag bit 7)
///   [25]   sourceTurretEntityId (gated by flag bit 10)
///   [26]   sourceHostEntityId
///   [27]   sourceRootEntityId
///   [28]   sourceTeamId
///   [29]   spawnTick
///   [30]   parentShotEntityId (gated by flag bit 11)
///   [31]   flags: bit 0 maxLifespan, 1 shotBlueprintCode, 2 sourceTurretBlueprintCode,
///          3 isDGun(true), 4 fromParentDetonation(true), 5 beam,
///          6 targetEntityId, 7 homingTurnRate, 8 isDGun(false),
///          9 fromParentDetonation(false), 10 sourceTurretEntityId,
///          11 parentShotEntityId.
pub(crate) const SNAPSHOT_ENCODE_PROJ_SPAWN_STRIDE: usize = 32;

pub(crate) struct SnapshotEncodeProjSpawnScratch {
    buf: Vec<f64>,
}

pub(crate) struct SnapshotEncodeProjSpawnScratchHolder(UnsafeCell<Option<SnapshotEncodeProjSpawnScratch>>);
unsafe impl Sync for SnapshotEncodeProjSpawnScratchHolder {}
pub(crate) static SNAPSHOT_ENCODE_PROJ_SPAWN_SCRATCH: SnapshotEncodeProjSpawnScratchHolder =
    SnapshotEncodeProjSpawnScratchHolder(UnsafeCell::new(None));

#[inline]
pub(crate) fn snapshot_encode_proj_spawn_scratch() -> &'static mut SnapshotEncodeProjSpawnScratch {
    unsafe {
        let cell = &mut *SNAPSHOT_ENCODE_PROJ_SPAWN_SCRATCH.0.get();
        if cell.is_none() {
            *cell = Some(SnapshotEncodeProjSpawnScratch {
                buf: vec![0.0; SNAPSHOT_ENCODE_PROJ_SPAWN_STRIDE * 16],
            });
        }
        cell.as_mut().unwrap()
    }
}

#[wasm_bindgen]
pub fn snapshot_encode_proj_spawn_scratch_ptr() -> *const f64 {
    snapshot_encode_proj_spawn_scratch().buf.as_ptr()
}

#[wasm_bindgen]
pub fn snapshot_encode_proj_spawn_scratch_ensure(count: u32) {
    let needed = (count as usize) * SNAPSHOT_ENCODE_PROJ_SPAWN_STRIDE;
    let s = snapshot_encode_proj_spawn_scratch();
    if s.buf.len() < needed {
        s.buf.resize(needed, 0.0);
    }
}

/// Beam-update header scratch — 4 f64 per update:
///   [0]   id
///   [1]   flags: bit 0 has_obstructionT, bit 1 has_endpointDamageable_false,
///         bit 2 has_endpointDamageable_true
///   [2]   obstructionT (qRot value, only valid if flag set)
///   [3]   point_count (u32 as f64, points come from beam_point_scratch
///         in order — first update's points then next update's, etc.)
pub(crate) const SNAPSHOT_ENCODE_BEAM_UPDATE_STRIDE: usize = 4;

pub(crate) struct SnapshotEncodeBeamUpdateScratch {
    buf: Vec<f64>,
}

pub(crate) struct SnapshotEncodeBeamUpdateScratchHolder(UnsafeCell<Option<SnapshotEncodeBeamUpdateScratch>>);
unsafe impl Sync for SnapshotEncodeBeamUpdateScratchHolder {}
pub(crate) static SNAPSHOT_ENCODE_BEAM_UPDATE_SCRATCH: SnapshotEncodeBeamUpdateScratchHolder =
    SnapshotEncodeBeamUpdateScratchHolder(UnsafeCell::new(None));

#[inline]
pub(crate) fn snapshot_encode_beam_update_scratch() -> &'static mut SnapshotEncodeBeamUpdateScratch {
    unsafe {
        let cell = &mut *SNAPSHOT_ENCODE_BEAM_UPDATE_SCRATCH.0.get();
        if cell.is_none() {
            *cell = Some(SnapshotEncodeBeamUpdateScratch {
                buf: vec![0.0; SNAPSHOT_ENCODE_BEAM_UPDATE_STRIDE * 16],
            });
        }
        cell.as_mut().unwrap()
    }
}

#[wasm_bindgen]
pub fn snapshot_encode_beam_update_scratch_ptr() -> *const f64 {
    snapshot_encode_beam_update_scratch().buf.as_ptr()
}

#[wasm_bindgen]
pub fn snapshot_encode_beam_update_scratch_ensure(count: u32) {
    let needed = (count as usize) * SNAPSHOT_ENCODE_BEAM_UPDATE_STRIDE;
    let s = snapshot_encode_beam_update_scratch();
    if s.buf.len() < needed {
        s.buf.resize(needed, 0.0);
    }
}

/// Beam-point scratch — flat 12 f64 per point across ALL beam updates
/// (first update's N1 points, then next update's N2 points, etc.).
///   [0..3]  x, y, z
///   [3..6]  vx, vy, vz
///   [6]     flags: bit 0 has_reflectorEntityId, bit 1 has_reflectorKind
///           (shield material; bit 2 unused), bit 3 has_reflectorPlayerId,
///           bit 4 has_normalX, bit 5 has_normalY, bit 6 has_normalZ.
///   [7]     reflectorEntityId
///   [8]     reflectorPlayerId
///   [9..12] normalX, normalY, normalZ
pub(crate) const SNAPSHOT_ENCODE_BEAM_POINT_STRIDE: usize = 12;

pub(crate) struct SnapshotEncodeBeamPointScratch {
    buf: Vec<f64>,
}

pub(crate) struct SnapshotEncodeBeamPointScratchHolder(UnsafeCell<Option<SnapshotEncodeBeamPointScratch>>);
unsafe impl Sync for SnapshotEncodeBeamPointScratchHolder {}
pub(crate) static SNAPSHOT_ENCODE_BEAM_POINT_SCRATCH: SnapshotEncodeBeamPointScratchHolder =
    SnapshotEncodeBeamPointScratchHolder(UnsafeCell::new(None));

#[inline]
pub(crate) fn snapshot_encode_beam_point_scratch() -> &'static mut SnapshotEncodeBeamPointScratch {
    unsafe {
        let cell = &mut *SNAPSHOT_ENCODE_BEAM_POINT_SCRATCH.0.get();
        if cell.is_none() {
            *cell = Some(SnapshotEncodeBeamPointScratch {
                buf: vec![0.0; SNAPSHOT_ENCODE_BEAM_POINT_STRIDE * 64],
            });
        }
        cell.as_mut().unwrap()
    }
}

#[wasm_bindgen]
pub fn snapshot_encode_beam_point_scratch_ptr() -> *const f64 {
    snapshot_encode_beam_point_scratch().buf.as_ptr()
}

#[wasm_bindgen]
pub fn snapshot_encode_beam_point_scratch_ensure(count: u32) {
    let needed = (count as usize) * SNAPSHOT_ENCODE_BEAM_POINT_STRIDE;
    let s = snapshot_encode_beam_point_scratch();
    if s.buf.len() < needed {
        s.buf.resize(needed, 0.0);
    }
}

pub(crate) const PACKED_BINARY_ROW_COUNT_BYTES: usize = 4;
pub(crate) const PACKED_MINIMAP_ENTITIES_VERSION: u64 = 2;
pub(crate) const PACKED_MINIMAP_ENTITY_FLAG_RADAR_ONLY: u32 = 0x01;
pub(crate) const PACKED_PROJECTILES_VERSION: u64 = 3;
pub(crate) const PROJECTILE_SPAWN_FLAG_MAX_LIFESPAN: u32 = 0x001;
pub(crate) const PROJECTILE_SPAWN_FLAG_SHOT_BLUEPRINT_CODE: u32 = 0x002;
pub(crate) const PROJECTILE_SPAWN_FLAG_SOURCE_TURRET_BLUEPRINT_CODE: u32 = 0x004;
pub(crate) const PROJECTILE_SPAWN_FLAG_BEAM: u32 = 0x020;
pub(crate) const PROJECTILE_SPAWN_FLAG_TARGET_ENTITY_ID: u32 = 0x040;
pub(crate) const PROJECTILE_SPAWN_FLAG_HOMING_TURN_RATE: u32 = 0x080;
pub(crate) const PROJECTILE_SPAWN_FLAG_SOURCE_TURRET_ENTITY_ID: u32 = 0x400;
pub(crate) const PROJECTILE_SPAWN_FLAG_PARENT_SHOT_ENTITY_ID: u32 = 0x800;
pub(crate) const PROJECTILE_BEAM_UPDATE_FLAG_OBSTRUCTION_T: u32 = 0x01;
pub(crate) const PROJECTILE_BEAM_POINT_FLAG_MIRROR_ENTITY_ID: u32 = 0x01;
pub(crate) const PROJECTILE_BEAM_POINT_FLAG_REFLECTOR_PLAYER_ID: u32 = 0x08;
pub(crate) const PROJECTILE_BEAM_POINT_FLAG_NORMAL_X: u32 = 0x10;
pub(crate) const PROJECTILE_BEAM_POINT_FLAG_NORMAL_Y: u32 = 0x20;
pub(crate) const PROJECTILE_BEAM_POINT_FLAG_NORMAL_Z: u32 = 0x40;
pub(crate) const PROJECTILE_VELOCITY_FLAG_CLEAR_HOMING: u32 = 0x01;

#[derive(Default)]
pub(crate) struct PackedBinaryWriter {
    buf: Vec<u8>,
}

impl PackedBinaryWriter {
    pub(crate) fn reset(&mut self, initial_len: usize) {
        self.buf.clear();
        self.buf.resize(initial_len, 0);
    }

    pub(crate) fn as_slice(&self) -> &[u8] {
        self.buf.as_slice()
    }

    pub(crate) fn write_var_uint(&mut self, value: u64) {
        let mut v = value;
        while v >= 0x80 {
            self.buf.push(((v % 0x80) as u8) | 0x80);
            v /= 0x80;
        }
        self.buf.push(v as u8);
    }

    pub(crate) fn write_var_uint_from_f64(&mut self, value: f64) {
        self.write_var_uint(f64_floor_u64(value));
    }

    pub(crate) fn write_var_int(&mut self, value: i64) {
        let zigzag = if value < 0 {
            ((-value) as u64).saturating_mul(2).saturating_sub(1)
        } else {
            (value as u64).saturating_mul(2)
        };
        self.write_var_uint(zigzag);
    }

    pub(crate) fn write_var_int_from_f64(&mut self, value: f64) {
        self.write_var_int(f64_round_i64(value));
    }

    pub(crate) fn write_bytes(&mut self, bytes: &[u8]) {
        self.buf.extend_from_slice(bytes);
    }

    /// Little-endian f64, matching TS PackedBinaryWriter.writeFloat64
    /// (DataView.setFloat64(..., true)).
    pub(crate) fn write_f64_le(&mut self, value: f64) {
        self.buf.extend_from_slice(&value.to_le_bytes());
    }

    pub(crate) fn set_u32_le(&mut self, offset: usize, value: u32) {
        if offset + 4 > self.buf.len() {
            self.buf.resize(offset + 4, 0);
        }
        self.buf[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
    }
}

#[derive(Default)]
pub(crate) struct PackedMinimapGroup {
    type_tag: u32,
    player_id: u32,
    flags: u32,
    count: u32,
    last_id: i64,
    writer: PackedBinaryWriter,
}

impl PackedMinimapGroup {
    pub(crate) fn reset(&mut self, type_tag: u32, player_id: u32, flags: u32) {
        self.type_tag = type_tag;
        self.player_id = player_id;
        self.flags = flags;
        self.count = 0;
        self.last_id = 0;
        self.writer.reset(0);
    }
}

#[derive(Default)]
pub(crate) struct SnapshotEncodePackedMinimapScratch {
    out: PackedBinaryWriter,
    groups: Vec<PackedMinimapGroup>,
    group_count: usize,
}

impl SnapshotEncodePackedMinimapScratch {
    pub(crate) fn reset_groups(&mut self) {
        self.group_count = 0;
    }

    pub(crate) fn group_index(&mut self, type_tag: u32, player_id: u32, flags: u32) -> usize {
        for i in 0..self.group_count {
            let group = &self.groups[i];
            if group.type_tag == type_tag && group.player_id == player_id && group.flags == flags {
                return i;
            }
        }
        let index = self.group_count;
        if index == self.groups.len() {
            self.groups.push(PackedMinimapGroup::default());
        }
        self.groups[index].reset(type_tag, player_id, flags);
        self.group_count += 1;
        index
    }
}

pub(crate) struct SnapshotEncodePackedMinimapScratchHolder(
    UnsafeCell<Option<SnapshotEncodePackedMinimapScratch>>,
);
unsafe impl Sync for SnapshotEncodePackedMinimapScratchHolder {}
pub(crate) static SNAPSHOT_ENCODE_PACKED_MINIMAP_SCRATCH: SnapshotEncodePackedMinimapScratchHolder =
    SnapshotEncodePackedMinimapScratchHolder(UnsafeCell::new(None));

#[inline]
pub(crate) fn snapshot_encode_packed_minimap_scratch() -> &'static mut SnapshotEncodePackedMinimapScratch {
    unsafe {
        let cell = &mut *SNAPSHOT_ENCODE_PACKED_MINIMAP_SCRATCH.0.get();
        if cell.is_none() {
            *cell = Some(SnapshotEncodePackedMinimapScratch::default());
        }
        cell.as_mut().unwrap()
    }
}

pub(crate) fn pack_minimap_entities_v2(count: usize) {
    let rows = snapshot_encode_minimap_scratch();
    let scratch = snapshot_encode_packed_minimap_scratch();
    scratch.out.reset(PACKED_BINARY_ROW_COUNT_BYTES);
    scratch.reset_groups();

    for i in 0..count {
        let base = i * SNAPSHOT_ENCODE_MINIMAP_STRIDE;
        let type_tag = f64_floor_u64(rows.buf[base + 3]) as u32;
        let player_id = f64_floor_u64(rows.buf[base + 4]) as u32;
        let scratch_flags = f64_floor_u64(rows.buf[base + 5]) as u32;
        let flags = if (scratch_flags & 0x02) != 0 {
            PACKED_MINIMAP_ENTITY_FLAG_RADAR_ONLY
        } else {
            0
        };
        let group_index = scratch.group_index(type_tag, player_id, flags);
        let group = &mut scratch.groups[group_index];
        let id = f64_round_i64(rows.buf[base]);
        group.writer.write_var_int(id - group.last_id);
        group.last_id = id;
        group.writer.write_var_int_from_f64(rows.buf[base + 1]);
        group.writer.write_var_int_from_f64(rows.buf[base + 2]);
        group.count += 1;
    }

    let group_count = scratch.group_count;
    let out = &mut scratch.out;
    let groups = &scratch.groups;
    out.write_var_uint(group_count as u64);
    for group in groups.iter().take(group_count) {
        out.write_var_uint(group.type_tag as u64);
        out.write_var_uint(group.player_id as u64);
        out.write_var_uint(group.flags as u64);
        out.write_var_uint(group.count as u64);
        out.write_bytes(group.writer.as_slice());
    }
    out.set_u32_le(0, count as u32);
}

#[derive(Default)]
pub(crate) struct PackedProjectileGroup {
    flags: u32,
    count: u32,
    last_id: i64,
    writer: PackedBinaryWriter,
}

impl PackedProjectileGroup {
    pub(crate) fn reset(&mut self, flags: u32) {
        self.flags = flags;
        self.count = 0;
        self.last_id = 0;
        self.writer.reset(0);
    }
}

#[derive(Default)]
pub(crate) struct SnapshotEncodePackedProjectileScratch {
    out: PackedBinaryWriter,
    spawn_groups: Vec<PackedProjectileGroup>,
    spawn_group_count: usize,
    velocity_groups: Vec<PackedProjectileGroup>,
    velocity_group_count: usize,
}

impl SnapshotEncodePackedProjectileScratch {
    pub(crate) fn reset_spawn_groups(&mut self) {
        self.spawn_group_count = 0;
    }

    pub(crate) fn reset_velocity_groups(&mut self) {
        self.velocity_group_count = 0;
    }

    pub(crate) fn spawn_group_index(&mut self, flags: u32) -> usize {
        find_or_create_packed_group(&mut self.spawn_groups, &mut self.spawn_group_count, flags)
    }

    pub(crate) fn velocity_group_index(&mut self, flags: u32) -> usize {
        find_or_create_packed_group(
            &mut self.velocity_groups,
            &mut self.velocity_group_count,
            flags,
        )
    }
}

pub(crate) struct SnapshotEncodePackedProjectileScratchHolder(
    UnsafeCell<Option<SnapshotEncodePackedProjectileScratch>>,
);
unsafe impl Sync for SnapshotEncodePackedProjectileScratchHolder {}
pub(crate) static SNAPSHOT_ENCODE_PACKED_PROJECTILE_SCRATCH: SnapshotEncodePackedProjectileScratchHolder =
    SnapshotEncodePackedProjectileScratchHolder(UnsafeCell::new(None));

#[inline]
pub(crate) fn snapshot_encode_packed_projectile_scratch() -> &'static mut SnapshotEncodePackedProjectileScratch
{
    unsafe {
        let cell = &mut *SNAPSHOT_ENCODE_PACKED_PROJECTILE_SCRATCH.0.get();
        if cell.is_none() {
            *cell = Some(SnapshotEncodePackedProjectileScratch::default());
        }
        cell.as_mut().unwrap()
    }
}

pub(crate) fn find_or_create_packed_group(
    groups: &mut Vec<PackedProjectileGroup>,
    active_count: &mut usize,
    flags: u32,
) -> usize {
    for i in 0..*active_count {
        if groups[i].flags == flags {
            return i;
        }
    }
    let index = *active_count;
    if index == groups.len() {
        groups.push(PackedProjectileGroup::default());
    }
    groups[index].reset(flags);
    *active_count += 1;
    index
}

pub(crate) fn f64_round_i64(value: f64) -> i64 {
    if value.is_finite() {
        value.round() as i64
    } else {
        0
    }
}

pub(crate) fn f64_floor_u64(value: f64) -> u64 {
    if value.is_finite() && value > 0.0 {
        value.floor() as u64
    } else {
        0
    }
}

pub(crate) fn pack_projectile_spawns_v2(count: usize) {
    let rows = snapshot_encode_proj_spawn_scratch();
    let scratch = snapshot_encode_packed_projectile_scratch();
    scratch.out.reset(PACKED_BINARY_ROW_COUNT_BYTES);
    if count == 0 {
        scratch.out.write_var_uint(0);
        scratch.out.set_u32_le(0, 0);
        return;
    }

    scratch.reset_spawn_groups();
    for i in 0..count {
        let base = i * SNAPSHOT_ENCODE_PROJ_SPAWN_STRIDE;
        let flags = rows.buf[base + 31] as u32;
        let group_index = scratch.spawn_group_index(flags);
        let group = &mut scratch.spawn_groups[group_index];
        let id = f64_round_i64(rows.buf[base]);
        group.writer.write_var_int(id - group.last_id);
        group.last_id = id;
        group.writer.write_var_int_from_f64(rows.buf[base + 1]);
        group.writer.write_var_int_from_f64(rows.buf[base + 2]);
        group.writer.write_var_int_from_f64(rows.buf[base + 3]);
        group.writer.write_var_int_from_f64(rows.buf[base + 4]);
        group.writer.write_var_int_from_f64(rows.buf[base + 5]);
        group.writer.write_var_int_from_f64(rows.buf[base + 6]);
        group.writer.write_var_int_from_f64(rows.buf[base + 7]);
        group.writer.write_var_uint_from_f64(rows.buf[base + 8]);
        group.writer.write_var_uint_from_f64(rows.buf[base + 10]);
        group.writer.write_var_uint_from_f64(rows.buf[base + 13]);
        group.writer.write_var_uint_from_f64(rows.buf[base + 14]);
        group.writer.write_var_uint_from_f64(rows.buf[base + 26]);
        group.writer.write_var_uint_from_f64(rows.buf[base + 27]);
        group.writer.write_var_uint_from_f64(rows.buf[base + 28]);
        group.writer.write_var_uint_from_f64(rows.buf[base + 29]);
        group.writer.write_var_uint_from_f64(rows.buf[base + 15]);
        group.writer.write_var_uint_from_f64(rows.buf[base + 16]);
        if (flags & PROJECTILE_SPAWN_FLAG_MAX_LIFESPAN) != 0 {
            group.writer.write_var_uint_from_f64(rows.buf[base + 9]);
        }
        if (flags & PROJECTILE_SPAWN_FLAG_SHOT_BLUEPRINT_CODE) != 0 {
            group.writer.write_var_uint_from_f64(rows.buf[base + 11]);
        }
        if (flags & PROJECTILE_SPAWN_FLAG_SOURCE_TURRET_BLUEPRINT_CODE) != 0 {
            group.writer.write_var_uint_from_f64(rows.buf[base + 12]);
        }
        if (flags & PROJECTILE_SPAWN_FLAG_SOURCE_TURRET_ENTITY_ID) != 0 {
            group.writer.write_var_uint_from_f64(rows.buf[base + 25]);
        }
        if (flags & PROJECTILE_SPAWN_FLAG_PARENT_SHOT_ENTITY_ID) != 0 {
            group.writer.write_var_uint_from_f64(rows.buf[base + 30]);
        }
        if (flags & PROJECTILE_SPAWN_FLAG_BEAM) != 0 {
            group.writer.write_var_int_from_f64(rows.buf[base + 17]);
            group.writer.write_var_int_from_f64(rows.buf[base + 18]);
            group.writer.write_var_int_from_f64(rows.buf[base + 19]);
            group.writer.write_var_int_from_f64(rows.buf[base + 20]);
            group.writer.write_var_int_from_f64(rows.buf[base + 21]);
            group.writer.write_var_int_from_f64(rows.buf[base + 22]);
        }
        if (flags & PROJECTILE_SPAWN_FLAG_TARGET_ENTITY_ID) != 0 {
            group.writer.write_var_uint_from_f64(rows.buf[base + 23]);
        }
        if (flags & PROJECTILE_SPAWN_FLAG_HOMING_TURN_RATE) != 0 {
            group.writer.write_var_int_from_f64(rows.buf[base + 24]);
        }
        group.count += 1;
    }

    let group_count = scratch.spawn_group_count;
    let out = &mut scratch.out;
    let groups = &scratch.spawn_groups;
    out.reset(PACKED_BINARY_ROW_COUNT_BYTES);
    out.write_var_uint(group_count as u64);
    for group in groups.iter().take(group_count) {
        out.write_var_uint(group.flags as u64);
        out.write_var_uint(group.count as u64);
        out.write_bytes(group.writer.as_slice());
    }
    out.set_u32_le(0, count as u32);
}

pub(crate) fn pack_projectile_despawns_v2(count: usize) {
    let rows = snapshot_encode_proj_despawn_scratch();
    let scratch = snapshot_encode_packed_projectile_scratch();
    let out = &mut scratch.out;
    out.reset(PACKED_BINARY_ROW_COUNT_BYTES);
    let mut last_id: i64 = 0;
    for i in 0..count {
        let id = rows.buf[i] as i64;
        out.write_var_int(id - last_id);
        last_id = id;
    }
    out.set_u32_le(0, count as u32);
}

pub(crate) fn pack_projectile_velocity_updates_v2(count: usize) {
    let rows = snapshot_encode_proj_vel_scratch();
    let scratch = snapshot_encode_packed_projectile_scratch();
    scratch.out.reset(PACKED_BINARY_ROW_COUNT_BYTES);
    if count == 0 {
        scratch.out.write_var_uint(0);
        scratch.out.set_u32_le(0, 0);
        return;
    }

    scratch.reset_velocity_groups();
    for i in 0..count {
        let base = i * SNAPSHOT_ENCODE_PROJ_VEL_STRIDE;
        let flags = if rows.buf[base + 7] != 0.0 {
            PROJECTILE_VELOCITY_FLAG_CLEAR_HOMING
        } else {
            0
        };
        let group_index = scratch.velocity_group_index(flags);
        let group = &mut scratch.velocity_groups[group_index];
        let id = f64_round_i64(rows.buf[base]);
        group.writer.write_var_int(id - group.last_id);
        group.last_id = id;
        group.writer.write_var_int_from_f64(rows.buf[base + 1]);
        group.writer.write_var_int_from_f64(rows.buf[base + 2]);
        group.writer.write_var_int_from_f64(rows.buf[base + 3]);
        group.writer.write_var_int_from_f64(rows.buf[base + 4]);
        group.writer.write_var_int_from_f64(rows.buf[base + 5]);
        group.writer.write_var_int_from_f64(rows.buf[base + 6]);
        group.count += 1;
    }

    let group_count = scratch.velocity_group_count;
    let out = &mut scratch.out;
    let groups = &scratch.velocity_groups;
    out.reset(PACKED_BINARY_ROW_COUNT_BYTES);
    out.write_var_uint(group_count as u64);
    for group in groups.iter().take(group_count) {
        out.write_var_uint(group.flags as u64);
        out.write_var_uint(group.count as u64);
        out.write_bytes(group.writer.as_slice());
    }
    out.set_u32_le(0, count as u32);
}

pub(crate) fn pack_beam_point_v2(writer: &mut PackedBinaryWriter, point_base: usize) {
    let points = snapshot_encode_beam_point_scratch();
    let flags = points.buf[point_base + 6] as u32;
    writer.write_var_uint(flags as u64);
    writer.write_var_int_from_f64(points.buf[point_base]);
    writer.write_var_int_from_f64(points.buf[point_base + 1]);
    writer.write_var_int_from_f64(points.buf[point_base + 2]);
    writer.write_var_int_from_f64(points.buf[point_base + 3]);
    writer.write_var_int_from_f64(points.buf[point_base + 4]);
    writer.write_var_int_from_f64(points.buf[point_base + 5]);
    if (flags & PROJECTILE_BEAM_POINT_FLAG_MIRROR_ENTITY_ID) != 0 {
        writer.write_var_uint_from_f64(points.buf[point_base + 7]);
    }
    if (flags & PROJECTILE_BEAM_POINT_FLAG_REFLECTOR_PLAYER_ID) != 0 {
        writer.write_var_uint_from_f64(points.buf[point_base + 8]);
    }
    if (flags & PROJECTILE_BEAM_POINT_FLAG_NORMAL_X) != 0 {
        writer.write_var_int_from_f64(points.buf[point_base + 9]);
    }
    if (flags & PROJECTILE_BEAM_POINT_FLAG_NORMAL_Y) != 0 {
        writer.write_var_int_from_f64(points.buf[point_base + 10]);
    }
    if (flags & PROJECTILE_BEAM_POINT_FLAG_NORMAL_Z) != 0 {
        writer.write_var_int_from_f64(points.buf[point_base + 11]);
    }
}

pub(crate) fn pack_projectile_beam_updates_v2(count: usize, beam_point_count: usize) {
    let updates = snapshot_encode_beam_update_scratch();
    let scratch = snapshot_encode_packed_projectile_scratch();
    let out = &mut scratch.out;
    out.reset(PACKED_BINARY_ROW_COUNT_BYTES);
    let mut last_beam_id: i64 = 0;
    let mut point_offset: usize = 0;
    for i in 0..count {
        let base = i * SNAPSHOT_ENCODE_BEAM_UPDATE_STRIDE;
        let id = f64_round_i64(updates.buf[base]);
        let flags = updates.buf[base + 1] as u32;
        out.write_var_int(id - last_beam_id);
        last_beam_id = id;
        out.write_var_uint(flags as u64);
        if (flags & PROJECTILE_BEAM_UPDATE_FLAG_OBSTRUCTION_T) != 0 {
            out.write_var_int_from_f64(updates.buf[base + 2]);
        }

        let requested_point_count = f64_floor_u64(updates.buf[base + 3]) as usize;
        let available = beam_point_count.saturating_sub(point_offset);
        let point_count = requested_point_count.min(available);
        out.write_var_uint(point_count as u64);
        for p in 0..point_count {
            pack_beam_point_v2(out, (point_offset + p) * SNAPSHOT_ENCODE_BEAM_POINT_STRIDE);
        }
        point_offset += requested_point_count;
    }
    out.set_u32_le(0, count as u32);
}

/// Death-context scratch — 16 f64 per deathContext (one per audio
/// event that has the has_deathContext flag set). Caller packs in
/// the same order as the audio events appear; Rust walks audio
/// events and uses a local offset to pull the next deathContext.
///   [0..2]  unitVel.x, unitVel.y
///   [2..4]  hitDir.x, hitDir.y
///   [4..6]  projectileVel.x, projectileVel.y
///   [6]     attackMagnitude
///   [7]     radius
///   [8]     color
///   [9]     visualRadius (gated by flags bit 0)
///   [10]    collisionRadius (gated by flags bit 1)
///   [11]    baseZ (gated by flags bit 2)
///   [12]    rotation (gated by flags bit 4)
///   [13]    unitBlueprintId string-scratch slot (gated by flags bit 3)
///   [14]    turretPoses_count (gated by flags bit 5)
///   [15]    flags: bit 0 has_visualRadius, bit 1 has_collisionRadius,
///            bit 2 has_baseZ, bit 3 has_unitType, bit 4 has_rotation,
///            bit 5 has_turretPoses
pub(crate) const SNAPSHOT_ENCODE_DEATH_CONTEXT_STRIDE: usize = 16;

pub(crate) struct SnapshotEncodeDeathContextScratch {
    buf: Vec<f64>,
}

pub(crate) struct SnapshotEncodeDeathContextScratchHolder(
    UnsafeCell<Option<SnapshotEncodeDeathContextScratch>>,
);
unsafe impl Sync for SnapshotEncodeDeathContextScratchHolder {}
pub(crate) static SNAPSHOT_ENCODE_DEATH_CONTEXT_SCRATCH: SnapshotEncodeDeathContextScratchHolder =
    SnapshotEncodeDeathContextScratchHolder(UnsafeCell::new(None));

#[inline]
pub(crate) fn snapshot_encode_death_context_scratch() -> &'static mut SnapshotEncodeDeathContextScratch {
    unsafe {
        let cell = &mut *SNAPSHOT_ENCODE_DEATH_CONTEXT_SCRATCH.0.get();
        if cell.is_none() {
            *cell = Some(SnapshotEncodeDeathContextScratch {
                buf: vec![0.0; SNAPSHOT_ENCODE_DEATH_CONTEXT_STRIDE * 4],
            });
        }
        cell.as_mut().unwrap()
    }
}

#[wasm_bindgen]
pub fn snapshot_encode_death_context_scratch_ptr() -> *const f64 {
    snapshot_encode_death_context_scratch().buf.as_ptr()
}

#[wasm_bindgen]
pub fn snapshot_encode_death_context_scratch_ensure(count: u32) {
    let needed = (count as usize) * SNAPSHOT_ENCODE_DEATH_CONTEXT_STRIDE;
    let s = snapshot_encode_death_context_scratch();
    if s.buf.len() < needed {
        s.buf.resize(needed, 0.0);
    }
}

/// Turret-pose scratch (for deathContext.turretPoses arrays) — flat
/// across all deathContexts in pack order; stride 2 (rotation, pitch).
pub(crate) const SNAPSHOT_ENCODE_TURRET_POSE_STRIDE: usize = 2;

pub(crate) struct SnapshotEncodeTurretPoseScratch {
    buf: Vec<f64>,
}

pub(crate) struct SnapshotEncodeTurretPoseScratchHolder(UnsafeCell<Option<SnapshotEncodeTurretPoseScratch>>);
unsafe impl Sync for SnapshotEncodeTurretPoseScratchHolder {}
pub(crate) static SNAPSHOT_ENCODE_TURRET_POSE_SCRATCH: SnapshotEncodeTurretPoseScratchHolder =
    SnapshotEncodeTurretPoseScratchHolder(UnsafeCell::new(None));

#[inline]
pub(crate) fn snapshot_encode_turret_pose_scratch() -> &'static mut SnapshotEncodeTurretPoseScratch {
    unsafe {
        let cell = &mut *SNAPSHOT_ENCODE_TURRET_POSE_SCRATCH.0.get();
        if cell.is_none() {
            *cell = Some(SnapshotEncodeTurretPoseScratch {
                buf: vec![0.0; SNAPSHOT_ENCODE_TURRET_POSE_STRIDE * 16],
            });
        }
        cell.as_mut().unwrap()
    }
}

#[wasm_bindgen]
pub fn snapshot_encode_turret_pose_scratch_ptr() -> *const f64 {
    snapshot_encode_turret_pose_scratch().buf.as_ptr()
}

#[wasm_bindgen]
pub fn snapshot_encode_turret_pose_scratch_ensure(count: u32) {
    let needed = (count as usize) * SNAPSHOT_ENCODE_TURRET_POSE_STRIDE;
    let s = snapshot_encode_turret_pose_scratch();
    if s.buf.len() < needed {
        s.buf.resize(needed, 0.0);
    }
}

/// Impact-context scratch — 11 f64 per impactContext (one per audio
/// event with has_impactContext flag set). All fields are required
/// in the source DTO (no optionals).
///   [0]    radiusCollision
///   [1]    deathExplosionRadius
///   [2..4] projectile.pos.x, projectile.pos.y
///   [4..6] projectile.vel.x, projectile.vel.y
///   [6..8] entity.vel.x, entity.vel.y
///   [8]    entity.radiusCollision
///   [9..11] penetrationDir.x, penetrationDir.y
pub(crate) const SNAPSHOT_ENCODE_IMPACT_CONTEXT_STRIDE: usize = 11;

pub(crate) struct SnapshotEncodeImpactContextScratch {
    buf: Vec<f64>,
}

pub(crate) struct SnapshotEncodeImpactContextScratchHolder(
    UnsafeCell<Option<SnapshotEncodeImpactContextScratch>>,
);
unsafe impl Sync for SnapshotEncodeImpactContextScratchHolder {}
pub(crate) static SNAPSHOT_ENCODE_IMPACT_CONTEXT_SCRATCH: SnapshotEncodeImpactContextScratchHolder =
    SnapshotEncodeImpactContextScratchHolder(UnsafeCell::new(None));

#[inline]
pub(crate) fn snapshot_encode_impact_context_scratch() -> &'static mut SnapshotEncodeImpactContextScratch {
    unsafe {
        let cell = &mut *SNAPSHOT_ENCODE_IMPACT_CONTEXT_SCRATCH.0.get();
        if cell.is_none() {
            *cell = Some(SnapshotEncodeImpactContextScratch {
                buf: vec![0.0; SNAPSHOT_ENCODE_IMPACT_CONTEXT_STRIDE * 4],
            });
        }
        cell.as_mut().unwrap()
    }
}

#[wasm_bindgen]
pub fn snapshot_encode_impact_context_scratch_ptr() -> *const f64 {
    snapshot_encode_impact_context_scratch().buf.as_ptr()
}

#[wasm_bindgen]
pub fn snapshot_encode_impact_context_scratch_ensure(count: u32) {
    let needed = (count as usize) * SNAPSHOT_ENCODE_IMPACT_CONTEXT_STRIDE;
    let s = snapshot_encode_impact_context_scratch();
    if s.buf.len() < needed {
        s.buf.resize(needed, 0.0);
    }
}

/// Audio-event scratch — 16 f64 per event (NetworkServerSnapshotSimEvent
/// minus deathContext / impactContext, which arrive in follow-ups).
///   [0]    type_code (0='fire', 1='hit', 2='death', 3='laserStart',
///           4='laserStop', 5='shieldStart', 6='shieldStop',
///           7='shieldImpact', 8='ping', 9='attackAlert',
///           10='projectileExpire', 11='waterSplash')
///   [1..3] pos.x, pos.y, pos.z (always present)
///   [4]    playerId (gated by flags bit 2)
///   [5]    entityId (gated by flags bit 3)
///   [6]    killerPlayerId (gated by flags bit 5)
///   [7]    victimPlayerId (gated by flags bit 6)
///   [8..10] shieldImpact.normal.x/y/z (gated by flags bit 4)
///   [11]   shieldImpact.playerId
///   [12]   sourceType_code (gated by flags bit 0; 0='turret', 1='unit',
///           2='building', 3='system')
///   [13]   turretBlueprintId string-scratch slot (always present — empty
///           string is a valid value, encoded as fixstr 0xA0)
///   [14]   sourceKey string-scratch slot (gated by flags bit 1)
///   [15]   flags: bit 0 has_sourceType, bit 1 has_sourceKey,
///           bit 2 has_playerId, bit 3 has_entityId,
///           bit 4 has_shieldImpact, bit 5 has_killerPlayerId,
///           bit 6 has_victimPlayerId, bit 7 has_audioOnly,
///           bit 8 audioOnly_value, bit 9 has_deathContext (TBD),
///           bit 10 has_impactContext (TBD),
///           bit 11 has_waterSplash.
///   [16..18] waterSplash.velocity.x/y/z (gated by flags bit 11)
///   [19]   waterSplash.mass (gated by flags bit 11)
pub(crate) const SNAPSHOT_ENCODE_AUDIO_EVENT_STRIDE: usize = 20;

pub(crate) struct SnapshotEncodeAudioEventScratch {
    buf: Vec<f64>,
}

pub(crate) struct SnapshotEncodeAudioEventScratchHolder(UnsafeCell<Option<SnapshotEncodeAudioEventScratch>>);
unsafe impl Sync for SnapshotEncodeAudioEventScratchHolder {}
pub(crate) static SNAPSHOT_ENCODE_AUDIO_EVENT_SCRATCH: SnapshotEncodeAudioEventScratchHolder =
    SnapshotEncodeAudioEventScratchHolder(UnsafeCell::new(None));

#[inline]
pub(crate) fn snapshot_encode_audio_event_scratch() -> &'static mut SnapshotEncodeAudioEventScratch {
    unsafe {
        let cell = &mut *SNAPSHOT_ENCODE_AUDIO_EVENT_SCRATCH.0.get();
        if cell.is_none() {
            *cell = Some(SnapshotEncodeAudioEventScratch {
                buf: vec![0.0; SNAPSHOT_ENCODE_AUDIO_EVENT_STRIDE * 16],
            });
        }
        cell.as_mut().unwrap()
    }
}

#[wasm_bindgen]
pub fn snapshot_encode_audio_event_scratch_ptr() -> *const f64 {
    snapshot_encode_audio_event_scratch().buf.as_ptr()
}

#[wasm_bindgen]
pub fn snapshot_encode_audio_event_scratch_ensure(count: u32) {
    let needed = (count as usize) * SNAPSHOT_ENCODE_AUDIO_EVENT_STRIDE;
    let s = snapshot_encode_audio_event_scratch();
    if s.buf.len() < needed {
        s.buf.resize(needed, 0.0);
    }
}

#[inline]
pub(crate) fn audio_event_type_str(code: u8) -> &'static str {
    match code {
        0 => "fire",
        1 => "hit",
        2 => "death",
        3 => "laserStart",
        4 => "laserStop",
        5 => "shieldStart",
        6 => "shieldStop",
        7 => "shieldImpact",
        8 => "ping",
        9 => "attackAlert",
        10 => "projectileExpire",
        11 => "waterSplash",
        _ => "",
    }
}

#[inline]
pub(crate) fn audio_event_source_type_str(code: u8) -> &'static str {
    match code {
        0 => "turret",
        1 => "unit",
        2 => "building",
        3 => "system",
        _ => "",
    }
}

/// Economy scratch — 11 f64 per player (caller must pack in ASCENDING
/// playerId order to match @msgpack/msgpack's iteration of a JS
/// object with integer-string keys).
///   [0]   playerId (becomes the outer-map string key)
///   [1..3] stockpile.curr, stockpile.max
///   [3..5] income.base, income.production
///   [5]   expenditure
///   [6..8] metal.stockpile.curr, metal.stockpile.max
///   [8..10] metal.income.base, metal.income.extraction
///   [10]  metal.expenditure
pub(crate) const SNAPSHOT_ENCODE_ECONOMY_STRIDE: usize = 11;

pub(crate) struct SnapshotEncodeEconomyScratch {
    buf: Vec<f64>,
}

pub(crate) struct SnapshotEncodeEconomyScratchHolder(UnsafeCell<Option<SnapshotEncodeEconomyScratch>>);
unsafe impl Sync for SnapshotEncodeEconomyScratchHolder {}
pub(crate) static SNAPSHOT_ENCODE_ECONOMY_SCRATCH: SnapshotEncodeEconomyScratchHolder =
    SnapshotEncodeEconomyScratchHolder(UnsafeCell::new(None));

#[inline]
pub(crate) fn snapshot_encode_economy_scratch() -> &'static mut SnapshotEncodeEconomyScratch {
    unsafe {
        let cell = &mut *SNAPSHOT_ENCODE_ECONOMY_SCRATCH.0.get();
        if cell.is_none() {
            *cell = Some(SnapshotEncodeEconomyScratch {
                buf: vec![0.0; SNAPSHOT_ENCODE_ECONOMY_STRIDE * 8],
            });
        }
        cell.as_mut().unwrap()
    }
}

#[wasm_bindgen]
pub fn snapshot_encode_economy_scratch_ptr() -> *const f64 {
    snapshot_encode_economy_scratch().buf.as_ptr()
}

#[wasm_bindgen]
pub fn snapshot_encode_economy_scratch_ensure(count: u32) {
    let needed = (count as usize) * SNAPSHOT_ENCODE_ECONOMY_STRIDE;
    let s = snapshot_encode_economy_scratch();
    if s.buf.len() < needed {
        s.buf.resize(needed, 0.0);
    }
}

/// Resource-movement scratch — 7 f64 per movement.
///   [0] playerId
///   [1] sourceEntityId
///   [2] targetEntityId (gated by has_target flag)
///   [3] resource code
///   [4] amountPerSecond
///   [5] direction code
///   [6] has_target flag
pub(crate) const SNAPSHOT_ENCODE_RESOURCE_MOVEMENT_STRIDE: usize = 7;

pub(crate) struct SnapshotEncodeResourceMovementScratch {
    buf: Vec<f64>,
}

pub(crate) struct SnapshotEncodeResourceMovementScratchHolder(
    UnsafeCell<Option<SnapshotEncodeResourceMovementScratch>>,
);
unsafe impl Sync for SnapshotEncodeResourceMovementScratchHolder {}
pub(crate) static SNAPSHOT_ENCODE_RESOURCE_MOVEMENT_SCRATCH: SnapshotEncodeResourceMovementScratchHolder =
    SnapshotEncodeResourceMovementScratchHolder(UnsafeCell::new(None));

#[inline]
pub(crate) fn snapshot_encode_resource_movement_scratch() -> &'static mut SnapshotEncodeResourceMovementScratch {
    unsafe {
        let cell = &mut *SNAPSHOT_ENCODE_RESOURCE_MOVEMENT_SCRATCH.0.get();
        if cell.is_none() {
            *cell = Some(SnapshotEncodeResourceMovementScratch {
                buf: vec![0.0; SNAPSHOT_ENCODE_RESOURCE_MOVEMENT_STRIDE * 16],
            });
        }
        cell.as_mut().unwrap()
    }
}

#[wasm_bindgen]
pub fn snapshot_encode_resource_movement_scratch_ptr() -> *const f64 {
    snapshot_encode_resource_movement_scratch().buf.as_ptr()
}

#[wasm_bindgen]
pub fn snapshot_encode_resource_movement_scratch_ensure(count: u32) {
    let needed = (count as usize) * SNAPSHOT_ENCODE_RESOURCE_MOVEMENT_STRIDE;
    let s = snapshot_encode_resource_movement_scratch();
    if s.buf.len() < needed {
        s.buf.resize(needed, 0.0);
    }
}

/// Spray-target scratch — 17 f64 per spray (NetworkServerSnapshotSprayTarget).
///   [0]    source.id
///   [1..3] source.pos.x, source.pos.y
///   [3]    source.z (gated by flags bit 1)
///   [4]    source.playerId
///   [5]    target.id
///   [6..8] target.pos.x, target.pos.y
///   [8]    target.z (gated by flags bit 2)
///   [9..11] target.dim.x, target.dim.y (gated by flags bit 3)
///   [11]   target.radius (gated by flags bit 4)
///   [12]   intensity
///   [13]   speed (gated by flags bit 5)
///   [14]   particleRadius (gated by flags bit 6)
///   [15]   ballSpawnRate (gated by flags bit 7)
///   [16]   flags: bit 0 type_is_heal (else 'build'), bit 1 has_source_z,
///          bit 2 has_target_z, bit 3 has_target_dim, bit 4 has_target_radius,
///          bit 5 has_speed, bit 6 has_particleRadius, bit 7 hasBallSpawnRate.
pub(crate) const SNAPSHOT_ENCODE_SPRAY_STRIDE: usize = 17;

pub(crate) struct SnapshotEncodeSprayScratch {
    buf: Vec<f64>,
}

pub(crate) struct SnapshotEncodeSprayScratchHolder(UnsafeCell<Option<SnapshotEncodeSprayScratch>>);
unsafe impl Sync for SnapshotEncodeSprayScratchHolder {}
pub(crate) static SNAPSHOT_ENCODE_SPRAY_SCRATCH: SnapshotEncodeSprayScratchHolder =
    SnapshotEncodeSprayScratchHolder(UnsafeCell::new(None));

#[inline]
pub(crate) fn snapshot_encode_spray_scratch() -> &'static mut SnapshotEncodeSprayScratch {
    unsafe {
        let cell = &mut *SNAPSHOT_ENCODE_SPRAY_SCRATCH.0.get();
        if cell.is_none() {
            *cell = Some(SnapshotEncodeSprayScratch {
                buf: vec![0.0; SNAPSHOT_ENCODE_SPRAY_STRIDE * 16],
            });
        }
        cell.as_mut().unwrap()
    }
}

#[wasm_bindgen]
pub fn snapshot_encode_spray_scratch_ptr() -> *const f64 {
    snapshot_encode_spray_scratch().buf.as_ptr()
}

#[wasm_bindgen]
pub fn snapshot_encode_spray_scratch_ensure(count: u32) {
    let needed = (count as usize) * SNAPSHOT_ENCODE_SPRAY_STRIDE;
    let s = snapshot_encode_spray_scratch();
    if s.buf.len() < needed {
        s.buf.resize(needed, 0.0);
    }
}

/// Shroud-bitmap scratch — flat Uint8Array of explored-tile bits. JS
/// fills before calling snapshot_encode_envelope_emit_shroud which
/// emits the wrapper map (gridW, gridH, cellSize, bitmap) using the
/// MessagePack writer's `write_bin` for the bitmap payload.
pub(crate) struct SnapshotEncodeShroudScratch {
    buf: Vec<u8>,
}

pub(crate) struct SnapshotEncodeShroudScratchHolder(UnsafeCell<Option<SnapshotEncodeShroudScratch>>);
unsafe impl Sync for SnapshotEncodeShroudScratchHolder {}
pub(crate) static SNAPSHOT_ENCODE_SHROUD_SCRATCH: SnapshotEncodeShroudScratchHolder =
    SnapshotEncodeShroudScratchHolder(UnsafeCell::new(None));

#[inline]
pub(crate) fn snapshot_encode_shroud_scratch() -> &'static mut SnapshotEncodeShroudScratch {
    unsafe {
        let cell = &mut *SNAPSHOT_ENCODE_SHROUD_SCRATCH.0.get();
        if cell.is_none() {
            *cell = Some(SnapshotEncodeShroudScratch {
                buf: vec![0u8; 4096],
            });
        }
        cell.as_mut().unwrap()
    }
}

#[wasm_bindgen]
pub fn snapshot_encode_shroud_scratch_ptr() -> *const u8 {
    snapshot_encode_shroud_scratch().buf.as_ptr()
}

#[wasm_bindgen]
pub fn snapshot_encode_shroud_scratch_ensure(byte_count: u32) {
    let s = snapshot_encode_shroud_scratch();
    if s.buf.len() < byte_count as usize {
        s.buf.resize(byte_count as usize, 0);
    }
}

/// Shared numeric scratch for low-frequency top-level snapshot
/// payloads such as terrain and buildability. JS packs one or more
/// number arrays back-to-back, then passes offsets/counts into the
/// dedicated envelope emitters below.
pub(crate) struct SnapshotEncodeNumberScratch {
    buf: Vec<f64>,
}

pub(crate) struct SnapshotEncodeNumberScratchHolder(UnsafeCell<Option<SnapshotEncodeNumberScratch>>);
unsafe impl Sync for SnapshotEncodeNumberScratchHolder {}
pub(crate) static SNAPSHOT_ENCODE_NUMBER_SCRATCH: SnapshotEncodeNumberScratchHolder =
    SnapshotEncodeNumberScratchHolder(UnsafeCell::new(None));

#[inline]
pub(crate) fn snapshot_encode_number_scratch() -> &'static mut SnapshotEncodeNumberScratch {
    unsafe {
        let cell = &mut *SNAPSHOT_ENCODE_NUMBER_SCRATCH.0.get();
        if cell.is_none() {
            *cell = Some(SnapshotEncodeNumberScratch {
                buf: vec![0.0; 4096],
            });
        }
        cell.as_mut().unwrap()
    }
}

#[wasm_bindgen]
pub fn snapshot_encode_number_scratch_ptr() -> *const f64 {
    snapshot_encode_number_scratch().buf.as_ptr()
}

#[wasm_bindgen]
pub fn snapshot_encode_number_scratch_ensure(number_count: u32) {
    let s = snapshot_encode_number_scratch();
    if s.buf.len() < number_count as usize {
        s.buf.resize(number_count as usize, 0.0);
    }
}

pub(crate) struct SnapshotEncodePackedStaticScratch {
    bytes: Vec<u8>,
}

pub(crate) struct SnapshotEncodePackedStaticScratchHolder(
    UnsafeCell<Option<SnapshotEncodePackedStaticScratch>>,
);
unsafe impl Sync for SnapshotEncodePackedStaticScratchHolder {}
pub(crate) static SNAPSHOT_ENCODE_PACKED_STATIC_SCRATCH: SnapshotEncodePackedStaticScratchHolder =
    SnapshotEncodePackedStaticScratchHolder(UnsafeCell::new(None));

#[inline]
pub(crate) fn snapshot_encode_packed_static_scratch() -> &'static mut SnapshotEncodePackedStaticScratch {
    unsafe {
        let cell = &mut *SNAPSHOT_ENCODE_PACKED_STATIC_SCRATCH.0.get();
        if cell.is_none() {
            *cell = Some(SnapshotEncodePackedStaticScratch {
                bytes: Vec::with_capacity(4096),
            });
        }
        cell.as_mut().unwrap()
    }
}

#[inline]
pub(crate) fn packed_static_write_var_uint(bytes: &mut Vec<u8>, mut value: u64) {
    while value >= 0x80 {
        bytes.push(((value % 0x80) as u8) | 0x80);
        value /= 0x80;
    }
    bytes.push(value as u8);
}

#[inline]
pub(crate) fn packed_static_write_var_int(bytes: &mut Vec<u8>, value: f64) {
    let v = value.round() as i64;
    let encoded = if v < 0 {
        ((-v) as u64 * 2) - 1
    } else {
        (v as u64) * 2
    };
    packed_static_write_var_uint(bytes, encoded);
}

pub(crate) fn write_number_scratch_float32_bin(w: &mut MessagePackWriter, offset: u32, count: u32) {
    let numbers = snapshot_encode_number_scratch();
    let scratch = snapshot_encode_packed_static_scratch();
    let start = offset as usize;
    let n = count as usize;
    scratch.bytes.clear();
    scratch.bytes.reserve(n * 4);
    for i in 0..n {
        let value = numbers.buf.get(start + i).copied().unwrap_or(0.0) as f32;
        scratch.bytes.extend_from_slice(&value.to_le_bytes());
    }
    w.write_bin(&scratch.bytes);
}

pub(crate) fn write_triangle_index_delta_bin(w: &mut MessagePackWriter, offset: u32, count: u32) {
    let numbers = snapshot_encode_number_scratch();
    let scratch = snapshot_encode_packed_static_scratch();
    let start = offset as usize;
    let triangle_count = (count as usize) / 3;
    scratch.bytes.clear();
    scratch.bytes.reserve(1 + triangle_count * 4);
    packed_static_write_var_uint(&mut scratch.bytes, triangle_count as u64);

    let mut previous_base = 0.0;
    for tri in 0..triangle_count {
        let base = start + tri * 3;
        let a = numbers.buf.get(base).copied().unwrap_or(0.0);
        let b = numbers.buf.get(base + 1).copied().unwrap_or(0.0);
        let c = numbers.buf.get(base + 2).copied().unwrap_or(0.0);
        packed_static_write_var_int(&mut scratch.bytes, a - previous_base);
        packed_static_write_var_int(&mut scratch.bytes, b - a);
        packed_static_write_var_int(&mut scratch.bytes, c - a);
        previous_base = a;
    }

    w.write_bin(&scratch.bytes);
}

#[inline]
pub(crate) fn number_scratch_i32(index: usize) -> i32 {
    snapshot_encode_number_scratch()
        .buf
        .get(index)
        .copied()
        .unwrap_or(0.0) as i32
}

pub(crate) fn buildability_run_count(
    flags_offset: u32,
    flags_count: u32,
    levels_offset: u32,
    levels_count: u32,
) -> usize {
    let count = (flags_count as usize).min(levels_count as usize);
    if count == 0 {
        return 0;
    }
    let flags_start = flags_offset as usize;
    let levels_start = levels_offset as usize;
    let mut runs = 0usize;
    let mut i = 0usize;
    while i < count {
        runs += 1;
        let flag = number_scratch_i32(flags_start + i);
        let level = number_scratch_i32(levels_start + i);
        i += 1;
        while i < count
            && number_scratch_i32(flags_start + i) == flag
            && number_scratch_i32(levels_start + i) == level
        {
            i += 1;
        }
    }
    runs
}

#[inline]
pub(crate) fn write_number_array_from_scratch(w: &mut MessagePackWriter, offset: u32, count: u32) {
    let scratch = snapshot_encode_number_scratch();
    let start = offset as usize;
    let n = count as usize;
    w.write_array_header(n);
    for i in 0..n {
        w.write_number(scratch.buf[start + i]);
    }
}

/// Scan-pulse scratch — 6 f64 per pulse:
///   [0] playerId   [1] x   [2] y   [3] z
///   [4] radius     [5] expiresAtTick
/// Field count is fixed (no optionals on NetworkServerSnapshotScanPulse).
pub(crate) const SNAPSHOT_ENCODE_SCAN_PULSE_STRIDE: usize = 6;

pub(crate) struct SnapshotEncodeScanPulseScratch {
    buf: Vec<f64>,
}

pub(crate) struct SnapshotEncodeScanPulseScratchHolder(UnsafeCell<Option<SnapshotEncodeScanPulseScratch>>);
unsafe impl Sync for SnapshotEncodeScanPulseScratchHolder {}
pub(crate) static SNAPSHOT_ENCODE_SCAN_PULSE_SCRATCH: SnapshotEncodeScanPulseScratchHolder =
    SnapshotEncodeScanPulseScratchHolder(UnsafeCell::new(None));

#[inline]
pub(crate) fn snapshot_encode_scan_pulse_scratch() -> &'static mut SnapshotEncodeScanPulseScratch {
    unsafe {
        let cell = &mut *SNAPSHOT_ENCODE_SCAN_PULSE_SCRATCH.0.get();
        if cell.is_none() {
            *cell = Some(SnapshotEncodeScanPulseScratch {
                buf: vec![0.0; SNAPSHOT_ENCODE_SCAN_PULSE_STRIDE * 8],
            });
        }
        cell.as_mut().unwrap()
    }
}

#[wasm_bindgen]
pub fn snapshot_encode_scan_pulse_scratch_ptr() -> *const f64 {
    snapshot_encode_scan_pulse_scratch().buf.as_ptr()
}

#[wasm_bindgen]
pub fn snapshot_encode_scan_pulse_scratch_ensure(count: u32) {
    let needed = (count as usize) * SNAPSHOT_ENCODE_SCAN_PULSE_STRIDE;
    let s = snapshot_encode_scan_pulse_scratch();
    if s.buf.len() < needed {
        s.buf.resize(needed, 0.0);
    }
}

/// Debug-grid scratch — 4 f64 per cell:
///   [0] x   [1] y   [2] z   [3] playerId bitmask (players 1..31).
pub(crate) const SNAPSHOT_ENCODE_GRID_CELL_STRIDE: usize = 4;

pub(crate) struct SnapshotEncodeGridScratch {
    cells: Vec<f64>,
    search_cells: Vec<f64>,
}

pub(crate) struct SnapshotEncodeGridScratchHolder(UnsafeCell<Option<SnapshotEncodeGridScratch>>);
unsafe impl Sync for SnapshotEncodeGridScratchHolder {}
pub(crate) static SNAPSHOT_ENCODE_GRID_SCRATCH: SnapshotEncodeGridScratchHolder =
    SnapshotEncodeGridScratchHolder(UnsafeCell::new(None));

#[inline]
pub(crate) fn snapshot_encode_grid_scratch() -> &'static mut SnapshotEncodeGridScratch {
    unsafe {
        let cell = &mut *SNAPSHOT_ENCODE_GRID_SCRATCH.0.get();
        if cell.is_none() {
            *cell = Some(SnapshotEncodeGridScratch {
                cells: vec![0.0; SNAPSHOT_ENCODE_GRID_CELL_STRIDE * 8],
                search_cells: vec![0.0; SNAPSHOT_ENCODE_GRID_CELL_STRIDE * 8],
            });
        }
        cell.as_mut().unwrap()
    }
}

#[wasm_bindgen]
pub fn snapshot_encode_grid_cell_scratch_ptr() -> *const f64 {
    snapshot_encode_grid_scratch().cells.as_ptr()
}

#[wasm_bindgen]
pub fn snapshot_encode_grid_cell_scratch_ensure(count: u32) {
    let needed = (count as usize) * SNAPSHOT_ENCODE_GRID_CELL_STRIDE;
    let s = snapshot_encode_grid_scratch();
    if s.cells.len() < needed {
        s.cells.resize(needed, 0.0);
    }
}

#[wasm_bindgen]
pub fn snapshot_encode_grid_search_cell_scratch_ptr() -> *const f64 {
    snapshot_encode_grid_scratch().search_cells.as_ptr()
}

#[wasm_bindgen]
pub fn snapshot_encode_grid_search_cell_scratch_ensure(count: u32) {
    let needed = (count as usize) * SNAPSHOT_ENCODE_GRID_CELL_STRIDE;
    let s = snapshot_encode_grid_scratch();
    if s.search_cells.len() < needed {
        s.search_cells.resize(needed, 0.0);
    }
}

/// Removed-entity-IDs scratch — Uint32Array of EntityId values for
/// the envelope's removedEntityIds field. JS pre-fills before
/// calling snapshot_encode_envelope_continue with
/// has_removed_entity_ids=1.
pub(crate) struct SnapshotEncodeRemovedIdsScratch {
    buf: Vec<u32>,
}

pub(crate) struct SnapshotEncodeRemovedIdsScratchHolder(UnsafeCell<Option<SnapshotEncodeRemovedIdsScratch>>);
unsafe impl Sync for SnapshotEncodeRemovedIdsScratchHolder {}
pub(crate) static SNAPSHOT_ENCODE_REMOVED_IDS_SCRATCH: SnapshotEncodeRemovedIdsScratchHolder =
    SnapshotEncodeRemovedIdsScratchHolder(UnsafeCell::new(None));

#[inline]
pub(crate) fn snapshot_encode_removed_ids_scratch() -> &'static mut SnapshotEncodeRemovedIdsScratch {
    unsafe {
        let cell = &mut *SNAPSHOT_ENCODE_REMOVED_IDS_SCRATCH.0.get();
        if cell.is_none() {
            *cell = Some(SnapshotEncodeRemovedIdsScratch {
                buf: vec![0u32; 16],
            });
        }
        cell.as_mut().unwrap()
    }
}

#[wasm_bindgen]
pub fn snapshot_encode_removed_ids_scratch_ptr() -> *const u32 {
    snapshot_encode_removed_ids_scratch().buf.as_ptr()
}

#[wasm_bindgen]
pub fn snapshot_encode_removed_ids_scratch_ensure(count: u32) {
    let s = snapshot_encode_removed_ids_scratch();
    if s.buf.len() < count as usize {
        s.buf.resize(count as usize, 0);
    }
}

// ===========================================================================
// Entity wire packer. Rust owns the compact `{v,m,t,e}` entity wire format.
// Movement-only unit deltas and split unit-turret deltas pack into grouped
// varint slabs (`m` / `t`); every other entity packs as a flat-array detail row
// (`e`). Reads the entity SoA the TS serializer already builds
// (stateSerializerEntities.ts), bulk-copied into scratch by the bridge — no
// per-entity JS->WASM crossing.
//
// SoA row layouts (must match stateSerializerEntities.ts strides/slots):
//   basic[9], unit[64], building[42], action[19], turret[11], waypoint[5].
// hp/velocity (unit) and hp/build (building) presence is NOT stored in the SoA
// (the legacy verbose encoder always emitted them); it is re-derived here as
// `isFull || (changedFields & bit)`, exactly how serializeEntitySnapshot sets
// the DTO sub-fields.
pub(crate) const V6_PACKED_ENTITIES_VERSION: u64 = 11;

pub(crate) const V6_ENTITY_FLAG_HAS_POS: u32 = 1 << 0;
pub(crate) const V6_ENTITY_FLAG_HAS_ROTATION: u32 = 1 << 1;
pub(crate) const V6_ENTITY_FLAG_HAS_CHANGED_FIELDS: u32 = 1 << 2;
pub(crate) const V6_ENTITY_FLAG_TYPE_BUILDING: u32 = 1 << 3;
pub(crate) const V6_ENTITY_FLAG_HAS_UNIT: u32 = 1 << 4;
pub(crate) const V6_ENTITY_FLAG_HAS_BUILDING: u32 = 1 << 5;

pub(crate) const V6_UNIT_FLAG_HP: u32 = 1 << 0;
pub(crate) const V6_UNIT_FLAG_VELOCITY: u32 = 1 << 1;
pub(crate) const V6_UNIT_FLAG_BLUEPRINT_CODE: u32 = 1 << 2;
pub(crate) const V6_UNIT_FLAG_RADIUS: u32 = 1 << 3;
pub(crate) const V6_UNIT_FLAG_BODY_CENTER_HEIGHT: u32 = 1 << 4;
pub(crate) const V6_UNIT_FLAG_MASS: u32 = 1 << 5;
pub(crate) const V6_UNIT_FLAG_SURFACE_NORMAL: u32 = 1 << 6;
pub(crate) const V6_UNIT_FLAG_CLOAK_STATE_PRESENT: u32 = 1 << 8;
pub(crate) const V6_UNIT_FLAG_ORIENTATION: u32 = 1 << 9;
pub(crate) const V6_UNIT_FLAG_ANGULAR_VELOCITY: u32 = 1 << 10;
pub(crate) const V6_UNIT_FLAG_FIRE_DISABLED: u32 = 1 << 11;
pub(crate) const V6_UNIT_FLAG_IS_COMMANDER: u32 = 1 << 12;
pub(crate) const V6_UNIT_FLAG_BUILD_TARGET_ID: u32 = 1 << 13;
pub(crate) const V6_UNIT_FLAG_BUILD_TARGET_NULL: u32 = 1 << 14;
pub(crate) const V6_UNIT_FLAG_ACTIONS: u32 = 1 << 15;
pub(crate) const V6_UNIT_FLAG_TURRETS: u32 = 1 << 16;
pub(crate) const V6_UNIT_FLAG_BUILD: u32 = 1 << 17;
pub(crate) const V6_UNIT_FLAG_BUILD_COMPLETE: u32 = 1 << 18;
pub(crate) const V6_UNIT_FLAG_BUILD_INTERRUPTED: u32 = 1 << 19;
pub(crate) const V6_UNIT_FLAG_REPEAT_PRESENT: u32 = 1 << 20;
pub(crate) const V6_UNIT_FLAG_REPEAT_ENABLED: u32 = 1 << 21;
pub(crate) const V6_UNIT_FLAG_HOLD_POSITION_PRESENT: u32 = 1 << 22;
pub(crate) const V6_UNIT_FLAG_HOLD_POSITION_ENABLED: u32 = 1 << 23;
pub(crate) const V6_UNIT_FLAG_TRAJECTORY_PRESENT: u32 = 1 << 24;
pub(crate) const V6_UNIT_FLAG_TRAJECTORY_HIGH: u32 = 1 << 25;
pub(crate) const V6_UNIT_FLAG_TRAJECTORY_AUTO: u32 = 1 << 26;
pub(crate) const V6_UNIT_FLAG_MOVE_STATE_PRESENT: u32 = 1 << 27;
pub(crate) const V6_UNIT_FLAG_MOVE_STATE_HOLD: u32 = 1 << 28;
pub(crate) const V6_UNIT_FLAG_MOVE_STATE_ROAM: u32 = 1 << 29;
pub(crate) const V6_UNIT_FLAG_FIRE_STATE_PRESENT: u32 = 1 << 30;

pub(crate) const V6_BUILDING_FLAG_BLUEPRINT_CODE: u32 = 1 << 0;
pub(crate) const V6_BUILDING_FLAG_DIM: u32 = 1 << 1;
pub(crate) const V6_BUILDING_FLAG_HP: u32 = 1 << 2;
pub(crate) const V6_BUILDING_FLAG_BUILD: u32 = 1 << 3;
pub(crate) const V6_BUILDING_FLAG_BUILD_COMPLETE: u32 = 1 << 4;
pub(crate) const V6_BUILDING_FLAG_METAL_EXTRACTION_RATE: u32 = 1 << 5;
pub(crate) const V6_BUILDING_FLAG_SOLAR: u32 = 1 << 6;
pub(crate) const V6_BUILDING_FLAG_SOLAR_OPEN: u32 = 1 << 7;
pub(crate) const V6_BUILDING_FLAG_TURRETS: u32 = 1 << 8;
pub(crate) const V6_BUILDING_FLAG_FACTORY: u32 = 1 << 9;
pub(crate) const V6_BUILDING_FLAG_FACTORY_PRODUCING: u32 = 1 << 10;
pub(crate) const V6_BUILDING_FLAG_BUILD_INTERRUPTED: u32 = 1 << 11;

pub(crate) const V6_MOVEMENT_FLAG_POS: u32 = 1 << 0;
pub(crate) const V6_MOVEMENT_FLAG_ROTATION: u32 = 1 << 1;
pub(crate) const V6_MOVEMENT_FLAG_VELOCITY: u32 = 1 << 2;
pub(crate) const V6_MOVEMENT_FLAG_ORIENTATION: u32 = 1 << 3;
pub(crate) const V6_MOVEMENT_FLAG_ANGULAR_VELOCITY: u32 = 1 << 4;
pub(crate) const V6_MOVEMENT_FLAG_YAW_ORIENTATION: u32 = 1 << 5;
pub(crate) const V6_MOVEMENT_FLAG_YAW_ANGULAR_VELOCITY: u32 = 1 << 6;

pub(crate) const V6_ACTION_FLAG_POS: u32 = 1 << 0;
pub(crate) const V6_ACTION_FLAG_POS_Z: u32 = 1 << 1;
pub(crate) const V6_ACTION_FLAG_PATH_EXP: u32 = 1 << 2;
pub(crate) const V6_ACTION_FLAG_TARGET_ID: u32 = 1 << 3;
pub(crate) const V6_ACTION_FLAG_BUILDING_BLUEPRINT_ID: u32 = 1 << 4;
pub(crate) const V6_ACTION_FLAG_GRID: u32 = 1 << 5;
pub(crate) const V6_ACTION_FLAG_BUILDING_ID: u32 = 1 << 6;
pub(crate) const V6_ACTION_FLAG_WAIT_GATHER: u32 = 1 << 7;
pub(crate) const V6_ACTION_FLAG_WAIT_GROUP_ID: u32 = 1 << 8;

pub(crate) const V6_TURRET_FLAG_TARGET_ID: u32 = 1 << 0;
pub(crate) const V6_TURRET_FLAG_SHIELD_RANGE: u32 = 1 << 1;
pub(crate) const V6_TURRET_FLAG_INACTIVE: u32 = 1 << 2;

pub(crate) const V6_WAYPOINT_FLAG_POS_Z: u32 = 1 << 0;

pub(crate) const V6_BASIC_STRIDE: usize = 9;
pub(crate) const V6_UNIT_STRIDE: usize = 64;
pub(crate) const V6_BUILDING_STRIDE: usize = 42;

pub(crate) const V6_KIND_RAW: u32 = 0;
pub(crate) const V6_KIND_BASIC: u32 = 1;
pub(crate) const V6_KIND_UNIT: u32 = 2;
pub(crate) const V6_KIND_BUILDING: u32 = 3;
pub(crate) const V6_WIRE_TYPE_UNIT: f64 = 1.0;

#[inline]
pub(crate) fn v6_movement_changed_mask() -> u32 {
    ENTITY_CHANGED_POS | ENTITY_CHANGED_ROT | ENTITY_CHANGED_VEL
}

// --- Input scratch (bulk-filled by the TS bridge from entityWireSource) ---
#[derive(Default)]
pub(crate) struct SnapshotEncodeV6InputScratch {
    kinds: Vec<u32>,
    row_indices: Vec<u32>,
    basic: Vec<f64>,
    unit: Vec<f64>,
    building: Vec<f64>,
}

pub(crate) struct SnapshotEncodeV6InputScratchHolder(UnsafeCell<Option<SnapshotEncodeV6InputScratch>>);
unsafe impl Sync for SnapshotEncodeV6InputScratchHolder {}
pub(crate) static SNAPSHOT_ENCODE_V6_INPUT_SCRATCH: SnapshotEncodeV6InputScratchHolder =
    SnapshotEncodeV6InputScratchHolder(UnsafeCell::new(None));

#[inline]
pub(crate) fn snapshot_encode_v6_input_scratch() -> &'static mut SnapshotEncodeV6InputScratch {
    unsafe {
        let cell = &mut *SNAPSHOT_ENCODE_V6_INPUT_SCRATCH.0.get();
        if cell.is_none() {
            *cell = Some(SnapshotEncodeV6InputScratch::default());
        }
        cell.as_mut().unwrap()
    }
}

#[wasm_bindgen]
pub fn snapshot_encode_v6_kinds_scratch_ptr() -> *const u32 {
    snapshot_encode_v6_input_scratch().kinds.as_ptr()
}
#[wasm_bindgen]
pub fn snapshot_encode_v6_kinds_scratch_ensure(count: u32) {
    let s = snapshot_encode_v6_input_scratch();
    if s.kinds.len() < count as usize {
        s.kinds.resize(count as usize, 0);
    }
}
#[wasm_bindgen]
pub fn snapshot_encode_v6_row_indices_scratch_ptr() -> *const u32 {
    snapshot_encode_v6_input_scratch().row_indices.as_ptr()
}
#[wasm_bindgen]
pub fn snapshot_encode_v6_row_indices_scratch_ensure(count: u32) {
    let s = snapshot_encode_v6_input_scratch();
    if s.row_indices.len() < count as usize {
        s.row_indices.resize(count as usize, 0);
    }
}
#[wasm_bindgen]
pub fn snapshot_encode_v6_basic_scratch_ptr() -> *const f64 {
    snapshot_encode_v6_input_scratch().basic.as_ptr()
}
#[wasm_bindgen]
pub fn snapshot_encode_v6_basic_scratch_ensure(row_count: u32) {
    let s = snapshot_encode_v6_input_scratch();
    let needed = row_count as usize * V6_BASIC_STRIDE;
    if s.basic.len() < needed {
        s.basic.resize(needed, 0.0);
    }
}
#[wasm_bindgen]
pub fn snapshot_encode_v6_unit_scratch_ptr() -> *const f64 {
    snapshot_encode_v6_input_scratch().unit.as_ptr()
}
#[wasm_bindgen]
pub fn snapshot_encode_v6_unit_scratch_ensure(row_count: u32) {
    let s = snapshot_encode_v6_input_scratch();
    let needed = row_count as usize * V6_UNIT_STRIDE;
    if s.unit.len() < needed {
        s.unit.resize(needed, 0.0);
    }
}
#[wasm_bindgen]
pub fn snapshot_encode_v6_building_scratch_ptr() -> *const f64 {
    snapshot_encode_v6_input_scratch().building.as_ptr()
}
#[wasm_bindgen]
pub fn snapshot_encode_v6_building_scratch_ensure(row_count: u32) {
    let s = snapshot_encode_v6_input_scratch();
    let needed = row_count as usize * V6_BUILDING_STRIDE;
    if s.building.len() < needed {
        s.building.resize(needed, 0.0);
    }
}

// --- Work scratch (grouped slab builders + detail-row index list) ---
#[derive(Default)]
pub(crate) struct V6MovementGroup {
    flags: u32,
    player_id: u32,
    count: u32,
    last_id: i64,
    writer: PackedBinaryWriter,
}

#[derive(Default)]
pub(crate) struct V6TurretGroup {
    player_id: u32,
    turret_count: u32,
    count: u32,
    last_id: i64,
    writer: PackedBinaryWriter,
}

#[derive(Default)]
pub(crate) struct SnapshotEncodeV6WorkScratch {
    movement_groups: Vec<V6MovementGroup>,
    movement_group_count: usize,
    movement_row_count: u32,
    turret_groups: Vec<V6TurretGroup>,
    turret_group_count: usize,
    turret_row_count: u32,
    m_out: PackedBinaryWriter,
    t_out: PackedBinaryWriter,
    detail: Vec<u32>,
}

impl SnapshotEncodeV6WorkScratch {
    pub(crate) fn reset(&mut self) {
        self.movement_group_count = 0;
        self.movement_row_count = 0;
        self.turret_group_count = 0;
        self.turret_row_count = 0;
        self.detail.clear();
    }

    pub(crate) fn movement_group_index(&mut self, flags: u32, player_id: u32) -> usize {
        for i in 0..self.movement_group_count {
            let g = &self.movement_groups[i];
            if g.flags == flags && g.player_id == player_id {
                return i;
            }
        }
        let index = self.movement_group_count;
        if index == self.movement_groups.len() {
            self.movement_groups.push(V6MovementGroup::default());
        }
        let g = &mut self.movement_groups[index];
        g.flags = flags;
        g.player_id = player_id;
        g.count = 0;
        g.last_id = 0;
        g.writer.reset(0);
        self.movement_group_count += 1;
        index
    }

    pub(crate) fn turret_group_index(&mut self, player_id: u32, turret_count: u32) -> usize {
        for i in 0..self.turret_group_count {
            let g = &self.turret_groups[i];
            if g.player_id == player_id && g.turret_count == turret_count {
                return i;
            }
        }
        let index = self.turret_group_count;
        if index == self.turret_groups.len() {
            self.turret_groups.push(V6TurretGroup::default());
        }
        let g = &mut self.turret_groups[index];
        g.player_id = player_id;
        g.turret_count = turret_count;
        g.count = 0;
        g.last_id = 0;
        g.writer.reset(0);
        self.turret_group_count += 1;
        index
    }
}

pub(crate) struct SnapshotEncodeV6WorkScratchHolder(UnsafeCell<Option<SnapshotEncodeV6WorkScratch>>);
unsafe impl Sync for SnapshotEncodeV6WorkScratchHolder {}
pub(crate) static SNAPSHOT_ENCODE_V6_WORK_SCRATCH: SnapshotEncodeV6WorkScratchHolder =
    SnapshotEncodeV6WorkScratchHolder(UnsafeCell::new(None));

#[inline]
pub(crate) fn snapshot_encode_v6_work_scratch() -> &'static mut SnapshotEncodeV6WorkScratch {
    unsafe {
        let cell = &mut *SNAPSHOT_ENCODE_V6_WORK_SCRATCH.0.get();
        if cell.is_none() {
            *cell = Some(SnapshotEncodeV6WorkScratch::default());
        }
        cell.as_mut().unwrap()
    }
}

#[inline]
pub(crate) fn v6_present(is_full: bool, cf: u32, bit: u32) -> bool {
    is_full || (cf & bit) != 0
}

pub(crate) fn v6_is_movement_only(input: &SnapshotEncodeV6InputScratch, kind: u32, row: usize) -> bool {
    let mask = v6_movement_changed_mask();
    if kind == V6_KIND_BASIC {
        let base = row * V6_BASIC_STRIDE;
        if input.basic[base + 1] != V6_WIRE_TYPE_UNIT {
            return false;
        }
        if input.basic[base + 7] == 0.0 {
            return false; // full snapshot: not a movement-only delta
        }
        let cf = input.basic[base + 8] as u32;
        if cf == 0 || (cf & !mask) != 0 {
            return false;
        }
        return true;
    }
    if kind == V6_KIND_UNIT {
        let base = row * V6_UNIT_STRIDE;
        if input.unit[base + 6] == 0.0 {
            return false;
        }
        let cf = input.unit[base + 7] as u32;
        if cf == 0 || (cf & !mask) != 0 {
            return false;
        }
        // All non-movement unit sub-fields must be absent.
        if input.unit[base + 13] != 0.0
            || input.unit[base + 15] != 0.0
            || input.unit[base + 19] != 0.0
            || input.unit[base + 21] != 0.0
            || input.unit[base + 23] != 0.0
            || input.unit[base + 36] != 0.0
            || input.unit[base + 37] != 0.0
            || input.unit[base + 38] != 0.0
            || input.unit[base + 41] != 0.0
            || input.unit[base + 43] != 0.0
            || input.unit[base + 45] != 0.0
            || input.unit[base + 51] != 0.0
            || input.unit[base + 53] != 0.0
            || input.unit[base + 55] != 0.0
            || input.unit[base + 57] != 0.0
            || input.unit[base + 59] != 0.0
            || input.unit[base + 61] != 0.0
            || input.unit[base + 63] != 0.0
        {
            return false;
        }
        if input.unit[base + 27] != 0.0 && (cf & ENTITY_CHANGED_ROT) == 0 {
            return false;
        }
        if input.unit[base + 32] != 0.0 && (cf & ENTITY_CHANGED_VEL) == 0 {
            return false;
        }
        return true;
    }
    false
}

pub(crate) fn v6_is_split_turret(input: &SnapshotEncodeV6InputScratch, kind: u32, row: usize) -> bool {
    if kind != V6_KIND_UNIT {
        return false;
    }
    let base = row * V6_UNIT_STRIDE;
    if input.unit[base + 6] == 0.0 {
        return false;
    }
    let cf = input.unit[base + 7] as u32;
    if cf == 0 || (cf & ENTITY_CHANGED_TURRETS) == 0 {
        return false;
    }
    let mask = v6_movement_changed_mask() | ENTITY_CHANGED_TURRETS;
    if (cf & !mask) != 0 {
        return false;
    }
    if input.unit[base + 43] == 0.0 {
        return false; // turrets must be present
    }
    if input.unit[base + 13] != 0.0
        || input.unit[base + 15] != 0.0
        || input.unit[base + 19] != 0.0
        || input.unit[base + 21] != 0.0
        || input.unit[base + 23] != 0.0
        || input.unit[base + 36] != 0.0
        || input.unit[base + 37] != 0.0
        || input.unit[base + 38] != 0.0
        || input.unit[base + 41] != 0.0
        || input.unit[base + 45] != 0.0
        || input.unit[base + 51] != 0.0
        || input.unit[base + 53] != 0.0
        || input.unit[base + 55] != 0.0
        || input.unit[base + 57] != 0.0
        || input.unit[base + 59] != 0.0
        || input.unit[base + 61] != 0.0
        || input.unit[base + 63] != 0.0
    {
        return false;
    }
    if input.unit[base + 27] != 0.0 && (cf & ENTITY_CHANGED_ROT) == 0 {
        return false;
    }
    if input.unit[base + 32] != 0.0 && (cf & ENTITY_CHANGED_VEL) == 0 {
        return false;
    }
    true
}

pub(crate) fn v6_has_movement_fields(input: &SnapshotEncodeV6InputScratch, row: usize) -> bool {
    let base = row * V6_UNIT_STRIDE;
    let cf = input.unit[base + 7] as u32;
    (cf & ENTITY_CHANGED_POS) != 0
        || (cf & ENTITY_CHANGED_ROT) != 0
        || (cf & ENTITY_CHANGED_VEL) != 0
        || input.unit[base + 27] != 0.0
        || input.unit[base + 32] != 0.0
}

#[inline]
pub(crate) fn v6_can_compact_yaw_orientation(rot_present: bool, x: f64, y: f64, z: f64, w: f64) -> bool {
    rot_present
        && x == 0.0
        && y == 0.0
        && z.is_finite()
        && w.is_finite()
        && z.abs() <= 1.000001
        && w.abs() <= 1.000001
}

pub(crate) fn v6_movement_flags(input: &SnapshotEncodeV6InputScratch, kind: u32, row: usize) -> u32 {
    let mut flags = 0u32;
    if kind == V6_KIND_BASIC {
        let base = row * V6_BASIC_STRIDE;
        let is_full = input.basic[base + 7] == 0.0;
        let cf = input.basic[base + 8] as u32;
        if v6_present(is_full, cf, ENTITY_CHANGED_POS) {
            flags |= V6_MOVEMENT_FLAG_POS;
        }
        if v6_present(is_full, cf, ENTITY_CHANGED_ROT) {
            flags |= V6_MOVEMENT_FLAG_ROTATION;
        }
        return flags;
    }
    let base = row * V6_UNIT_STRIDE;
    let is_full = input.unit[base + 6] == 0.0;
    let cf = input.unit[base + 7] as u32;
    let rot_present = v6_present(is_full, cf, ENTITY_CHANGED_ROT);
    if v6_present(is_full, cf, ENTITY_CHANGED_POS) {
        flags |= V6_MOVEMENT_FLAG_POS;
    }
    if rot_present {
        flags |= V6_MOVEMENT_FLAG_ROTATION;
    }
    if v6_present(is_full, cf, ENTITY_CHANGED_VEL) {
        flags |= V6_MOVEMENT_FLAG_VELOCITY;
    }
    if input.unit[base + 27] != 0.0 {
        let compact = v6_can_compact_yaw_orientation(
            rot_present,
            input.unit[base + 28],
            input.unit[base + 29],
            input.unit[base + 30],
            input.unit[base + 31],
        );
        flags |= if compact {
            V6_MOVEMENT_FLAG_YAW_ORIENTATION
        } else {
            V6_MOVEMENT_FLAG_ORIENTATION
        };
    }
    if input.unit[base + 32] != 0.0 {
        let compact = input.unit[base + 33] == 0.0 && input.unit[base + 34] == 0.0;
        flags |= if compact {
            V6_MOVEMENT_FLAG_YAW_ANGULAR_VELOCITY
        } else {
            V6_MOVEMENT_FLAG_ANGULAR_VELOCITY
        };
    }
    flags
}

pub(crate) fn v6_write_movement_payload(
    writer: &mut PackedBinaryWriter,
    input: &SnapshotEncodeV6InputScratch,
    kind: u32,
    row: usize,
    flags: u32,
) {
    if kind == V6_KIND_BASIC {
        let base = row * V6_BASIC_STRIDE;
        if (flags & V6_MOVEMENT_FLAG_POS) != 0 {
            writer.write_var_int_from_f64(input.basic[base + 2]);
            writer.write_var_int_from_f64(input.basic[base + 3]);
            writer.write_var_int_from_f64(input.basic[base + 4]);
        }
        if (flags & V6_MOVEMENT_FLAG_ROTATION) != 0 {
            writer.write_var_int_from_f64(input.basic[base + 5]);
        }
        return;
    }
    let base = row * V6_UNIT_STRIDE;
    if (flags & V6_MOVEMENT_FLAG_POS) != 0 {
        writer.write_var_int_from_f64(input.unit[base + 1]);
        writer.write_var_int_from_f64(input.unit[base + 2]);
        writer.write_var_int_from_f64(input.unit[base + 3]);
    }
    if (flags & V6_MOVEMENT_FLAG_ROTATION) != 0 {
        writer.write_var_int_from_f64(input.unit[base + 4]);
    }
    if (flags & V6_MOVEMENT_FLAG_VELOCITY) != 0 {
        writer.write_var_int_from_f64(input.unit[base + 10]);
        writer.write_var_int_from_f64(input.unit[base + 11]);
        writer.write_var_int_from_f64(input.unit[base + 12]);
    }
    if (flags & V6_MOVEMENT_FLAG_ORIENTATION) != 0 {
        writer.write_f64_le(input.unit[base + 28]);
        writer.write_f64_le(input.unit[base + 29]);
        writer.write_f64_le(input.unit[base + 30]);
        writer.write_f64_le(input.unit[base + 31]);
    }
    if (flags & V6_MOVEMENT_FLAG_ANGULAR_VELOCITY) != 0 {
        writer.write_f64_le(input.unit[base + 33]);
        writer.write_f64_le(input.unit[base + 34]);
        writer.write_f64_le(input.unit[base + 35]);
    }
    if (flags & V6_MOVEMENT_FLAG_YAW_ANGULAR_VELOCITY) != 0 {
        writer.write_f64_le(input.unit[base + 35]);
    }
}

pub(crate) fn v6_write_turret_payload(
    writer: &mut PackedBinaryWriter,
    turret_buf: &[f64],
    turret_offset: usize,
    turret_count: usize,
) {
    for t in 0..turret_count {
        let tb = (turret_offset + t) * SNAPSHOT_ENCODE_TURRET_STRIDE;
        let has_target = turret_buf[tb + 6] != 0.0;
        let has_ffr = turret_buf[tb + 8] != 0.0;
        let inactive = turret_buf[tb + 10] != 0.0;
        let mut flags = 0u32;
        if has_target {
            flags |= V6_TURRET_FLAG_TARGET_ID;
        }
        if has_ffr {
            flags |= V6_TURRET_FLAG_SHIELD_RANGE;
        }
        if inactive {
            flags |= V6_TURRET_FLAG_INACTIVE;
        }
        writer.write_var_uint(flags as u64);
        writer.write_var_uint(turret_buf[tb + 4] as u64); // id
        writer.write_var_uint(turret_buf[tb + 5] as u64); // state
        writer.write_var_int_from_f64(turret_buf[tb + 0]); // rot
        writer.write_var_int_from_f64(turret_buf[tb + 1]); // vel
        writer.write_var_int_from_f64(turret_buf[tb + 2]); // pitch
        writer.write_var_int_from_f64(turret_buf[tb + 3]); // pitchVel
        if has_target {
            writer.write_var_uint(turret_buf[tb + 7] as u64);
        }
        if has_ffr {
            writer.write_f64_le(turret_buf[tb + 9]);
        }
    }
}

pub(crate) fn v6_write_detail_action(w: &mut MessagePackWriter, action_buf: &[f64], a_row: usize) {
    let base = a_row * SNAPSHOT_ENCODE_ACTION_STRIDE;
    let has_pos = action_buf[base + 1] != 0.0;
    let has_pos_z = action_buf[base + 4] != 0.0;
    let path_exp = action_buf[base + 6] != 0.0;
    let has_target = action_buf[base + 7] != 0.0;
    let has_building_type = action_buf[base + 9] != 0.0;
    let has_grid = action_buf[base + 11] != 0.0;
    let has_building_id = action_buf[base + 14] != 0.0;
    let wait_gather = action_buf[base + 16] != 0.0;
    let has_wait_group_id = action_buf[base + 17] != 0.0;
    let mut flags = 0u32;
    if has_pos {
        flags |= V6_ACTION_FLAG_POS;
    }
    if has_pos_z {
        flags |= V6_ACTION_FLAG_POS_Z;
    }
    if path_exp {
        flags |= V6_ACTION_FLAG_PATH_EXP;
    }
    if has_target {
        flags |= V6_ACTION_FLAG_TARGET_ID;
    }
    if has_building_type {
        flags |= V6_ACTION_FLAG_BUILDING_BLUEPRINT_ID;
    }
    if has_grid {
        flags |= V6_ACTION_FLAG_GRID;
    }
    if has_building_id {
        flags |= V6_ACTION_FLAG_BUILDING_ID;
    }
    if wait_gather {
        flags |= V6_ACTION_FLAG_WAIT_GATHER;
    }
    if has_wait_group_id {
        flags |= V6_ACTION_FLAG_WAIT_GROUP_ID;
    }
    let mut len = 2usize; // flags, type
    if has_pos {
        len += 2;
    }
    if has_pos_z {
        len += 1;
    }
    if has_target {
        len += 1;
    }
    if has_building_type {
        len += 1;
    }
    if has_grid {
        len += 2;
    }
    if has_building_id {
        len += 1;
    }
    if has_wait_group_id {
        len += 1;
    }
    w.write_array_header(len);
    w.write_number(flags as f64);
    w.write_number(action_buf[base + 0]); // type
    if has_pos {
        w.write_number(action_buf[base + 2]);
        w.write_number(action_buf[base + 3]);
    }
    if has_pos_z {
        w.write_number(action_buf[base + 5]);
    }
    if has_target {
        w.write_number(action_buf[base + 8]);
    }
    if has_building_type {
        write_string_from_scratch(w, action_buf[base + 10] as u32);
    }
    if has_grid {
        w.write_number(action_buf[base + 12]);
        w.write_number(action_buf[base + 13]);
    }
    if has_building_id {
        w.write_number(action_buf[base + 15]);
    }
    if has_wait_group_id {
        w.write_number(action_buf[base + 18]);
    }
}

pub(crate) fn v6_write_detail_turret(w: &mut MessagePackWriter, turret_buf: &[f64], t_row: usize) {
    let base = t_row * SNAPSHOT_ENCODE_TURRET_STRIDE;
    let has_target = turret_buf[base + 6] != 0.0;
    let has_ffr = turret_buf[base + 8] != 0.0;
    let inactive = turret_buf[base + 10] != 0.0;
    let mut flags = 0u32;
    if has_target {
        flags |= V6_TURRET_FLAG_TARGET_ID;
    }
    if has_ffr {
        flags |= V6_TURRET_FLAG_SHIELD_RANGE;
    }
    if inactive {
        flags |= V6_TURRET_FLAG_INACTIVE;
    }
    let mut len = 7usize; // flags, id, state, rot, vel, pitch, pitchVel
    if has_target {
        len += 1;
    }
    if has_ffr {
        len += 1;
    }
    w.write_array_header(len);
    w.write_number(flags as f64);
    w.write_number(turret_buf[base + 4]); // id
    w.write_number(turret_buf[base + 5]); // state
    w.write_number(turret_buf[base + 0]); // rot
    w.write_number(turret_buf[base + 1]); // vel
    w.write_number(turret_buf[base + 2]); // pitch
    w.write_number(turret_buf[base + 3]); // pitchVel
    if has_target {
        w.write_number(turret_buf[base + 7]);
    }
    if has_ffr {
        w.write_number(turret_buf[base + 9]);
    }
}

pub(crate) fn v6_write_detail_waypoint(
    w: &mut MessagePackWriter,
    waypoint_buf: &[f64],
    wp_row: usize,
    waypoint_string_base: u32,
) {
    let base = wp_row * SNAPSHOT_ENCODE_WAYPOINT_STRIDE;
    let has_pos_z = waypoint_buf[base + 2] != 0.0;
    let mut len = 4usize;
    if has_pos_z {
        len += 1;
    }
    w.write_array_header(len);
    w.write_number(if has_pos_z {
        V6_WAYPOINT_FLAG_POS_Z as f64
    } else {
        0.0
    });
    w.write_number(waypoint_buf[base + 0]); // pos.x
    w.write_number(waypoint_buf[base + 1]); // pos.y
    write_string_from_scratch(w, waypoint_string_base + waypoint_buf[base + 4] as u32);
    if has_pos_z {
        w.write_number(waypoint_buf[base + 3]);
    }
}

pub(crate) fn v6_write_detail_factory(
    w: &mut MessagePackWriter,
    building_buf: &[f64],
    base: usize,
    queue_buf: &[u32],
    waypoint_buf: &[f64],
    waypoint_string_base: u32,
) {
    w.write_array_header(9);
    // selectedUnitBlueprintCode: code or nil
    let selected_count = building_buf[base + 25] as usize;
    let selected_offset = building_buf[base + 32] as i64;
    if selected_count > 0 && selected_offset >= 0 {
        let off = selected_offset as usize;
        w.write_number(queue_buf[off] as f64);
    } else {
        w.write_nil();
    }
    w.write_number(building_buf[base + 26]); // progress
    w.write_number(building_buf[base + 28]); // energyRate
    w.write_number(building_buf[base + 29]); // metalRate
                                             // rally
    let wp_count = building_buf[base + 30] as usize;
    let wp_offset = building_buf[base + 33] as i64;
    if wp_count > 0 && wp_offset >= 0 {
        let off = wp_offset as usize;
        v6_write_detail_waypoint(w, waypoint_buf, off, waypoint_string_base);
    } else {
        w.write_nil();
    }

    let route_count = building_buf[base + 41] as i64;
    let route_offset = building_buf[base + 40] as i64;
    if route_count >= 0 {
        let count = route_count as usize;
        w.write_array_header(count);
        if route_offset >= 0 {
            let off = route_offset as usize;
            for r in 0..count {
                v6_write_detail_waypoint(w, waypoint_buf, off + r, waypoint_string_base);
            }
        }
    } else {
        w.write_nil();
    }

    if building_buf[base + 35] != 0.0 {
        w.write_number(building_buf[base + 36]);
    } else {
        w.write_nil();
    }

    w.write_number(building_buf[base + 37]);

    let finite_queue_count = building_buf[base + 39] as i64;
    let finite_queue_offset = building_buf[base + 38] as i64;
    if finite_queue_count >= 0 {
        let count = finite_queue_count as usize;
        w.write_array_header(count);
        if finite_queue_offset >= 0 {
            let off = finite_queue_offset as usize;
            for q in 0..count {
                w.write_number(queue_buf[off + q] as f64);
            }
        }
    } else {
        w.write_nil();
    }
}

pub(crate) fn v6_write_detail_unit(
    w: &mut MessagePackWriter,
    unit_buf: &[f64],
    base: usize,
    turret_buf: &[f64],
    action_buf: &[f64],
) {
    let is_full = unit_buf[base + 6] == 0.0;
    let cf = unit_buf[base + 7] as u32;
    let hp_present = v6_present(is_full, cf, ENTITY_CHANGED_HP);
    let vel_present = v6_present(is_full, cf, ENTITY_CHANGED_VEL);
    let has_unit_type = unit_buf[base + 13] != 0.0;
    let has_radius = unit_buf[base + 15] != 0.0;
    let has_bch = unit_buf[base + 19] != 0.0;
    let has_mass = unit_buf[base + 21] != 0.0;
    let has_surface_normal = unit_buf[base + 23] != 0.0;
    let has_orientation = unit_buf[base + 27] != 0.0;
    let has_angular_velocity = unit_buf[base + 32] != 0.0;
    let fire_disabled = unit_buf[base + 36] != 0.0;
    let is_commander = unit_buf[base + 37] != 0.0;
    let build_target_present = unit_buf[base + 38] != 0.0;
    let build_target_null = unit_buf[base + 39] != 0.0;
    let has_actions = unit_buf[base + 41] != 0.0;
    let has_turrets = unit_buf[base + 43] != 0.0;
    let has_build = unit_buf[base + 45] != 0.0;
    let build_complete = unit_buf[base + 46] != 0.0;
    let has_fire_state = unit_buf[base + 51] != 0.0;
    let repeat_present = unit_buf[base + 53] != 0.0;
    let repeat_enabled = unit_buf[base + 54] != 0.0;
    let hold_present = unit_buf[base + 55] != 0.0;
    let hold_enabled = unit_buf[base + 56] != 0.0;
    let trajectory_present = unit_buf[base + 57] != 0.0;
    let trajectory_code = unit_buf[base + 58] as u32;
    let move_state_present = unit_buf[base + 59] != 0.0;
    let move_state_code = unit_buf[base + 60] as u32;
    let cloak_present = unit_buf[base + 61] != 0.0;
    let build_interrupted = unit_buf[base + 63] != 0.0;

    let mut flags = 0u32;
    if hp_present {
        flags |= V6_UNIT_FLAG_HP;
    }
    if vel_present {
        flags |= V6_UNIT_FLAG_VELOCITY;
    }
    if has_unit_type {
        flags |= V6_UNIT_FLAG_BLUEPRINT_CODE;
    }
    if has_radius {
        flags |= V6_UNIT_FLAG_RADIUS;
    }
    if has_bch {
        flags |= V6_UNIT_FLAG_BODY_CENTER_HEIGHT;
    }
    if has_mass {
        flags |= V6_UNIT_FLAG_MASS;
    }
    if has_surface_normal {
        flags |= V6_UNIT_FLAG_SURFACE_NORMAL;
    }
    if has_orientation {
        flags |= V6_UNIT_FLAG_ORIENTATION;
    }
    if has_angular_velocity {
        flags |= V6_UNIT_FLAG_ANGULAR_VELOCITY;
    }
    if fire_disabled {
        flags |= V6_UNIT_FLAG_FIRE_DISABLED;
    }
    if has_fire_state {
        flags |= V6_UNIT_FLAG_FIRE_STATE_PRESENT;
    }
    if trajectory_present {
        flags |= V6_UNIT_FLAG_TRAJECTORY_PRESENT;
        if trajectory_code == 1 {
            flags |= V6_UNIT_FLAG_TRAJECTORY_HIGH;
        } else if trajectory_code == 2 {
            flags |= V6_UNIT_FLAG_TRAJECTORY_AUTO;
        }
    }
    if repeat_present {
        flags |= V6_UNIT_FLAG_REPEAT_PRESENT;
        if repeat_enabled {
            flags |= V6_UNIT_FLAG_REPEAT_ENABLED;
        }
    }
    if hold_present {
        flags |= V6_UNIT_FLAG_HOLD_POSITION_PRESENT;
        if hold_enabled {
            flags |= V6_UNIT_FLAG_HOLD_POSITION_ENABLED;
        }
    }
    if move_state_present {
        flags |= V6_UNIT_FLAG_MOVE_STATE_PRESENT;
        if move_state_code == 1 {
            flags |= V6_UNIT_FLAG_MOVE_STATE_HOLD;
        } else if move_state_code == 2 {
            flags |= V6_UNIT_FLAG_MOVE_STATE_ROAM;
        }
    }
    if cloak_present {
        flags |= V6_UNIT_FLAG_CLOAK_STATE_PRESENT;
    }
    if is_commander {
        flags |= V6_UNIT_FLAG_IS_COMMANDER;
    }
    if build_target_present {
        flags |= V6_UNIT_FLAG_BUILD_TARGET_ID;
        if build_target_null {
            flags |= V6_UNIT_FLAG_BUILD_TARGET_NULL;
        }
    }
    if has_actions {
        flags |= V6_UNIT_FLAG_ACTIONS;
    }
    if has_turrets {
        flags |= V6_UNIT_FLAG_TURRETS;
    }
    if has_build {
        flags |= V6_UNIT_FLAG_BUILD;
        if build_complete {
            flags |= V6_UNIT_FLAG_BUILD_COMPLETE;
        }
        if build_interrupted {
            flags |= V6_UNIT_FLAG_BUILD_INTERRUPTED;
        }
    }

    let mut len = 1usize;
    if hp_present {
        len += 2;
    }
    if vel_present {
        len += 3;
    }
    if has_unit_type {
        len += 1;
    }
    if has_radius {
        len += 3;
    }
    if has_bch {
        len += 1;
    }
    if has_mass {
        len += 1;
    }
    if has_surface_normal {
        len += 3;
    }
    if has_orientation {
        len += 4;
    }
    if has_angular_velocity {
        len += 3;
    }
    if has_fire_state {
        len += 1;
    }
    if cloak_present {
        len += 1;
    }
    if build_target_present && !build_target_null {
        len += 1;
    }
    if has_actions {
        len += 1;
    }
    if has_turrets {
        len += 1;
    }
    if has_build {
        len += 2;
    }

    w.write_array_header(len);
    w.write_number(flags as f64);
    if hp_present {
        w.write_number(unit_buf[base + 8]);
        w.write_number(unit_buf[base + 9]);
    }
    if vel_present {
        w.write_number(unit_buf[base + 10]);
        w.write_number(unit_buf[base + 11]);
        w.write_number(unit_buf[base + 12]);
    }
    if has_unit_type {
        w.write_number(unit_buf[base + 14]);
    }
    if has_radius {
        w.write_number(unit_buf[base + 16]);
        w.write_number(unit_buf[base + 17]);
        w.write_number(unit_buf[base + 18]);
    }
    if has_bch {
        w.write_number(unit_buf[base + 20]);
    }
    if has_mass {
        w.write_number(unit_buf[base + 22]);
    }
    if has_surface_normal {
        w.write_number(unit_buf[base + 24]);
        w.write_number(unit_buf[base + 25]);
        w.write_number(unit_buf[base + 26]);
    }
    if has_orientation {
        w.write_number(unit_buf[base + 28]);
        w.write_number(unit_buf[base + 29]);
        w.write_number(unit_buf[base + 30]);
        w.write_number(unit_buf[base + 31]);
    }
    if has_angular_velocity {
        w.write_number(unit_buf[base + 33]);
        w.write_number(unit_buf[base + 34]);
        w.write_number(unit_buf[base + 35]);
    }
    if has_fire_state {
        w.write_number(unit_buf[base + 52]);
    }
    if cloak_present {
        w.write_number(unit_buf[base + 62]);
    }
    if build_target_present && !build_target_null {
        w.write_number(unit_buf[base + 40]);
    }
    if has_actions {
        let action_count = unit_buf[base + 42] as usize;
        let action_offset = unit_buf[base + 50] as i64;
        w.write_array_header(action_count);
        if action_offset >= 0 {
            let off = action_offset as usize;
            for a in 0..action_count {
                v6_write_detail_action(w, action_buf, off + a);
            }
        }
    }
    if has_turrets {
        let turret_count = unit_buf[base + 44] as usize;
        let turret_offset = unit_buf[base + 49] as i64;
        w.write_array_header(turret_count);
        if turret_offset >= 0 {
            let off = turret_offset as usize;
            for t in 0..turret_count {
                v6_write_detail_turret(w, turret_buf, off + t);
            }
        }
    }
    if has_build {
        w.write_number(unit_buf[base + 47]);
        w.write_number(unit_buf[base + 48]);
    }
}

pub(crate) fn v6_write_detail_building(
    w: &mut MessagePackWriter,
    building_buf: &[f64],
    base: usize,
    turret_buf: &[f64],
    queue_buf: &[u32],
    waypoint_buf: &[f64],
    waypoint_string_base: u32,
) {
    let is_full = building_buf[base + 6] == 0.0;
    let cf = building_buf[base + 7] as u32;
    let has_type = building_buf[base + 8] != 0.0;
    let has_dim = building_buf[base + 10] != 0.0;
    let hp_present = v6_present(is_full, cf, ENTITY_CHANGED_HP);
    let build_present = v6_present(is_full, cf, ENTITY_CHANGED_BUILDING);
    let build_complete = building_buf[base + 15] != 0.0;
    let build_interrupted = building_buf[base + 34] != 0.0;
    let has_metal_extraction = building_buf[base + 18] != 0.0;
    let has_solar = building_buf[base + 20] != 0.0;
    let solar_open = building_buf[base + 21] != 0.0;
    let has_turrets = building_buf[base + 22] != 0.0;
    let has_factory = building_buf[base + 24] != 0.0;
    let factory_producing = building_buf[base + 27] != 0.0;

    let mut flags = 0u32;
    if has_type {
        flags |= V6_BUILDING_FLAG_BLUEPRINT_CODE;
    }
    if has_dim {
        flags |= V6_BUILDING_FLAG_DIM;
    }
    if hp_present {
        flags |= V6_BUILDING_FLAG_HP;
    }
    if build_present {
        flags |= V6_BUILDING_FLAG_BUILD;
        if build_complete {
            flags |= V6_BUILDING_FLAG_BUILD_COMPLETE;
        }
        if build_interrupted {
            flags |= V6_BUILDING_FLAG_BUILD_INTERRUPTED;
        }
    }
    if has_metal_extraction {
        flags |= V6_BUILDING_FLAG_METAL_EXTRACTION_RATE;
    }
    if has_solar {
        flags |= V6_BUILDING_FLAG_SOLAR;
        if solar_open {
            flags |= V6_BUILDING_FLAG_SOLAR_OPEN;
        }
    }
    if has_turrets {
        flags |= V6_BUILDING_FLAG_TURRETS;
    }
    if has_factory {
        flags |= V6_BUILDING_FLAG_FACTORY;
        if factory_producing {
            flags |= V6_BUILDING_FLAG_FACTORY_PRODUCING;
        }
    }

    let mut len = 1usize;
    if has_type {
        len += 1;
    }
    if has_dim {
        len += 2;
    }
    if hp_present {
        len += 2;
    }
    if build_present {
        len += 2;
    }
    if has_metal_extraction {
        len += 1;
    }
    if has_turrets {
        len += 1;
    }
    if has_factory {
        len += 1;
    }

    w.write_array_header(len);
    w.write_number(flags as f64);
    if has_type {
        w.write_number(building_buf[base + 9]);
    }
    if has_dim {
        w.write_number(building_buf[base + 11]);
        w.write_number(building_buf[base + 12]);
    }
    if hp_present {
        w.write_number(building_buf[base + 13]);
        w.write_number(building_buf[base + 14]);
    }
    if build_present {
        w.write_number(building_buf[base + 16]);
        w.write_number(building_buf[base + 17]);
    }
    if has_metal_extraction {
        w.write_number(building_buf[base + 19]);
    }
    if has_turrets {
        let turret_count = building_buf[base + 23] as usize;
        let turret_offset = building_buf[base + 31] as i64;
        w.write_array_header(turret_count);
        if turret_offset >= 0 {
            let off = turret_offset as usize;
            for t in 0..turret_count {
                v6_write_detail_turret(w, turret_buf, off + t);
            }
        }
    }
    if has_factory {
        v6_write_detail_factory(
            w,
            building_buf,
            base,
            queue_buf,
            waypoint_buf,
            waypoint_string_base,
        );
    }
}

pub(crate) fn v6_write_detail_row(
    w: &mut MessagePackWriter,
    input: &SnapshotEncodeV6InputScratch,
    kind: u32,
    row: usize,
    turret_buf: &[f64],
    action_buf: &[f64],
    queue_buf: &[u32],
    waypoint_buf: &[f64],
    waypoint_string_base: u32,
) {
    if kind == V6_KIND_UNIT {
        let base = row * V6_UNIT_STRIDE;
        let is_full = input.unit[base + 6] == 0.0;
        let cf = input.unit[base + 7] as u32;
        let pos_present = v6_present(is_full, cf, ENTITY_CHANGED_POS);
        let rot_present = v6_present(is_full, cf, ENTITY_CHANGED_ROT);
        let mut flags = V6_ENTITY_FLAG_HAS_UNIT;
        if pos_present {
            flags |= V6_ENTITY_FLAG_HAS_POS;
        }
        if rot_present {
            flags |= V6_ENTITY_FLAG_HAS_ROTATION;
        }
        if !is_full {
            flags |= V6_ENTITY_FLAG_HAS_CHANGED_FIELDS;
        }
        let mut len = 3usize;
        if pos_present {
            len += 3;
        }
        if rot_present {
            len += 1;
        }
        if !is_full {
            len += 1;
        }
        len += 1; // unit sub-array
        w.write_array_header(len);
        w.write_number(flags as f64);
        w.write_number(input.unit[base + 0]); // id
        w.write_number(input.unit[base + 5]); // playerId
        if pos_present {
            w.write_number(input.unit[base + 1]);
            w.write_number(input.unit[base + 2]);
            w.write_number(input.unit[base + 3]);
        }
        if rot_present {
            w.write_number(input.unit[base + 4]);
        }
        if !is_full {
            w.write_number(cf as f64);
        }
        v6_write_detail_unit(w, &input.unit, base, turret_buf, action_buf);
        return;
    }
    if kind == V6_KIND_BUILDING {
        let base = row * V6_BUILDING_STRIDE;
        let is_full = input.building[base + 6] == 0.0;
        let cf = input.building[base + 7] as u32;
        let pos_present = v6_present(is_full, cf, ENTITY_CHANGED_POS);
        let rot_present = v6_present(is_full, cf, ENTITY_CHANGED_ROT);
        let mut flags = V6_ENTITY_FLAG_TYPE_BUILDING | V6_ENTITY_FLAG_HAS_BUILDING;
        if pos_present {
            flags |= V6_ENTITY_FLAG_HAS_POS;
        }
        if rot_present {
            flags |= V6_ENTITY_FLAG_HAS_ROTATION;
        }
        if !is_full {
            flags |= V6_ENTITY_FLAG_HAS_CHANGED_FIELDS;
        }
        let mut len = 3usize;
        if pos_present {
            len += 3;
        }
        if rot_present {
            len += 1;
        }
        if !is_full {
            len += 1;
        }
        len += 1; // building sub-array
        w.write_array_header(len);
        w.write_number(flags as f64);
        w.write_number(input.building[base + 0]); // id
        w.write_number(input.building[base + 5]); // playerId
        if pos_present {
            w.write_number(input.building[base + 1]);
            w.write_number(input.building[base + 2]);
            w.write_number(input.building[base + 3]);
        }
        if rot_present {
            w.write_number(input.building[base + 4]);
        }
        if !is_full {
            w.write_number(cf as f64);
        }
        v6_write_detail_building(
            w,
            &input.building,
            base,
            turret_buf,
            queue_buf,
            waypoint_buf,
            waypoint_string_base,
        );
        return;
    }
    // V6_KIND_BASIC (no unit/building sub-array)
    let base = row * V6_BASIC_STRIDE;
    let is_unit = input.basic[base + 1] == V6_WIRE_TYPE_UNIT;
    let is_full = input.basic[base + 7] == 0.0;
    let cf = input.basic[base + 8] as u32;
    let pos_present = v6_present(is_full, cf, ENTITY_CHANGED_POS);
    let rot_present = v6_present(is_full, cf, ENTITY_CHANGED_ROT);
    let mut flags = 0u32;
    if pos_present {
        flags |= V6_ENTITY_FLAG_HAS_POS;
    }
    if rot_present {
        flags |= V6_ENTITY_FLAG_HAS_ROTATION;
    }
    if !is_full {
        flags |= V6_ENTITY_FLAG_HAS_CHANGED_FIELDS;
    }
    if !is_unit {
        flags |= V6_ENTITY_FLAG_TYPE_BUILDING;
    }
    let mut len = 3usize;
    if pos_present {
        len += 3;
    }
    if rot_present {
        len += 1;
    }
    if !is_full {
        len += 1;
    }
    w.write_array_header(len);
    w.write_number(flags as f64);
    w.write_number(input.basic[base + 0]); // id
    w.write_number(input.basic[base + 6]); // playerId
    if pos_present {
        w.write_number(input.basic[base + 2]);
        w.write_number(input.basic[base + 3]);
        w.write_number(input.basic[base + 4]);
    }
    if rot_present {
        w.write_number(input.basic[base + 5]);
    }
    if !is_full {
        w.write_number(cf as f64);
    }
}

/// Emit the `entities` key + the compact V6 `{v,m,t,e}` value. The caller must
/// have opened the envelope via snapshot_encode_envelope_begin_packed_entities
/// and bulk-filled the V6 input scratch + the shared
/// turret/action/waypoint/factory-queue/string scratches. `entity_count` is the
/// number of kinds/row_indices entries; `waypoint_string_base` is the slot
/// offset where waypoint-type strings begin in the (action ++ waypoint) ordered
/// string scratch. Returns the writer length, or u32::MAX if a RAW
/// (un-encodable) entity kind is present, in which case the caller emits raw
/// entity DTOs.
#[wasm_bindgen]
pub fn snapshot_encode_emit_entities_v6(entity_count: u32, waypoint_string_base: u32) -> u32 {
    let entity_count = entity_count as usize;
    let input = snapshot_encode_v6_input_scratch();
    let work = snapshot_encode_v6_work_scratch();
    work.reset();
    work.m_out.reset(PACKED_BINARY_ROW_COUNT_BYTES);
    work.t_out.reset(PACKED_BINARY_ROW_COUNT_BYTES);

    // Pass 1: classify + accumulate movement/turret slabs, collect detail rows.
    for i in 0..entity_count {
        let kind = input.kinds[i];
        if kind == V6_KIND_RAW {
            return u32::MAX;
        }
        let row = input.row_indices[i] as usize;

        if v6_is_movement_only(input, kind, row) {
            let flags = v6_movement_flags(input, kind, row);
            let player_id = if kind == V6_KIND_BASIC {
                input.basic[row * V6_BASIC_STRIDE + 6] as u32
            } else {
                input.unit[row * V6_UNIT_STRIDE + 5] as u32
            };
            let id = if kind == V6_KIND_BASIC {
                input.basic[row * V6_BASIC_STRIDE] as i64
            } else {
                input.unit[row * V6_UNIT_STRIDE] as i64
            };
            let gi = work.movement_group_index(flags, player_id);
            let delta = id - work.movement_groups[gi].last_id;
            work.movement_groups[gi].writer.write_var_int(delta);
            work.movement_groups[gi].last_id = id;
            // Borrow the group writer + input together (disjoint statics).
            {
                let group_writer = &mut work.movement_groups[gi].writer;
                v6_write_movement_payload(group_writer, input, kind, row, flags);
            }
            work.movement_groups[gi].count += 1;
            work.movement_row_count += 1;
            continue;
        }

        if v6_is_split_turret(input, kind, row) {
            // KIND_UNIT only.
            if v6_has_movement_fields(input, row) {
                let flags = v6_movement_flags(input, kind, row);
                let player_id = input.unit[row * V6_UNIT_STRIDE + 5] as u32;
                let id = input.unit[row * V6_UNIT_STRIDE] as i64;
                let gi = work.movement_group_index(flags, player_id);
                let delta = id - work.movement_groups[gi].last_id;
                work.movement_groups[gi].writer.write_var_int(delta);
                work.movement_groups[gi].last_id = id;
                {
                    let group_writer = &mut work.movement_groups[gi].writer;
                    v6_write_movement_payload(group_writer, input, kind, row, flags);
                }
                work.movement_groups[gi].count += 1;
                work.movement_row_count += 1;
            }
            let base = row * V6_UNIT_STRIDE;
            let player_id = input.unit[base + 5] as u32;
            let turret_count = input.unit[base + 44] as u32;
            let turret_offset = input.unit[base + 49] as usize;
            let id = input.unit[base] as i64;
            let gi = work.turret_group_index(player_id, turret_count);
            let delta = id - work.turret_groups[gi].last_id;
            work.turret_groups[gi].writer.write_var_int(delta);
            work.turret_groups[gi].last_id = id;
            {
                let turret_buf = &snapshot_encode_turret_scratch().buf;
                let group_writer = &mut work.turret_groups[gi].writer;
                v6_write_turret_payload(
                    group_writer,
                    turret_buf,
                    turret_offset,
                    turret_count as usize,
                );
            }
            work.turret_groups[gi].count += 1;
            work.turret_row_count += 1;
            continue;
        }

        work.detail.push(i as u32);
    }

    // Finish the movement slab.
    if work.movement_row_count > 0 {
        let group_count = work.movement_group_count;
        work.m_out.write_var_uint(group_count as u64);
        for i in 0..group_count {
            let flags = work.movement_groups[i].flags;
            let player_id = work.movement_groups[i].player_id;
            let count = work.movement_groups[i].count;
            work.m_out.write_var_uint(flags as u64);
            work.m_out.write_var_uint(player_id as u64);
            work.m_out.write_var_uint(count as u64);
            let bytes_len = work.movement_groups[i].writer.as_slice().len();
            // Copy group bytes into m_out (separate borrows of the same struct).
            for b in 0..bytes_len {
                let byte = work.movement_groups[i].writer.as_slice()[b];
                work.m_out.buf.push(byte);
            }
        }
        let row_count = work.movement_row_count;
        work.m_out.set_u32_le(0, row_count);
    }

    // Finish the turret slab.
    if work.turret_row_count > 0 {
        let group_count = work.turret_group_count;
        work.t_out.write_var_uint(group_count as u64);
        for i in 0..group_count {
            let player_id = work.turret_groups[i].player_id;
            let turret_count = work.turret_groups[i].turret_count;
            let count = work.turret_groups[i].count;
            work.t_out.write_var_uint(player_id as u64);
            work.t_out.write_var_uint(turret_count as u64);
            work.t_out.write_var_uint(count as u64);
            let bytes_len = work.turret_groups[i].writer.as_slice().len();
            for b in 0..bytes_len {
                let byte = work.turret_groups[i].writer.as_slice()[b];
                work.t_out.buf.push(byte);
            }
        }
        let row_count = work.turret_row_count;
        work.t_out.set_u32_le(0, row_count);
    }

    let has_m = work.movement_row_count > 0;
    let has_t = work.turret_row_count > 0;
    let detail_count = work.detail.len();
    // `e` is present if there are detail rows, or if there is no other section
    // (so an empty entities array still emits `e: []`).
    let has_e = detail_count > 0 || (!has_m && !has_t);

    let mut map_size = 1usize; // v
    if has_m {
        map_size += 1;
    }
    if has_t {
        map_size += 1;
    }
    if has_e {
        map_size += 1;
    }

    let turret_buf = &snapshot_encode_turret_scratch().buf;
    let action_buf = &snapshot_encode_action_scratch().buf;
    let queue_buf = &snapshot_encode_factory_queue_scratch().buf;
    let waypoint_buf = &snapshot_encode_waypoint_scratch().buf;
    let w = messagepack_writer();
    w.write_str("entities");
    w.write_map_header(map_size);
    w.write_str("v");
    w.write_uint(V6_PACKED_ENTITIES_VERSION);
    if has_m {
        w.write_str("m");
        w.write_bin(work.m_out.as_slice());
    }
    if has_t {
        w.write_str("t");
        w.write_bin(work.t_out.as_slice());
    }
    if has_e {
        w.write_str("e");
        w.write_array_header(detail_count);
        for d in 0..detail_count {
            let i = work.detail[d] as usize;
            let kind = input.kinds[i];
            let row = input.row_indices[i] as usize;
            v6_write_detail_row(
                w,
                input,
                kind,
                row,
                turret_buf,
                action_buf,
                queue_buf,
                waypoint_buf,
                waypoint_string_base,
            );
        }
    }
    w.len() as u32
}

/// Open the envelope: clear writer, emit map header with the
/// caller-computed total_key_count, emit tick key + entities array
/// header. `total_key_count` includes tick + entities + every
/// optional envelope key the caller will subsequently emit (the
/// continue function counts only the ones it's about to write).
#[wasm_bindgen]
pub fn snapshot_encode_envelope_begin(tick: u32, entity_count: u32, total_key_count: u32) {
    let w = messagepack_writer();
    w.buf.clear();
    w.write_map_header(total_key_count as usize);
    w.write_str("tick");
    w.write_uint(tick as u64);
    w.write_str("entities");
    w.write_array_header(entity_count as usize);
}

/// Open the envelope when the `entities` value is already in a compact
/// packed wire shape. The caller must emit the `entities` key next via
/// snapshot_encode_envelope_emit_raw_key_value so key order stays
/// byte-identical with the JS encoder.
#[wasm_bindgen]
pub fn snapshot_encode_envelope_begin_packed_entities(tick: u32, total_key_count: u32) {
    let w = messagepack_writer();
    w.buf.clear();
    w.write_map_header(total_key_count as usize);
    w.write_str("tick");
    w.write_uint(tick as u64);
}

/// Append a top-level snapshot key whose value has already been
/// MessagePack-encoded by a transitional JS fallback. This keeps the
/// envelope writer authoritative for key ordering while DP-02 ports
/// the remaining low-frequency DTO fields.
#[wasm_bindgen]
pub fn snapshot_encode_envelope_emit_raw_key_value(key: &str, value: &[u8]) -> u32 {
    let w = messagepack_writer();
    w.write_str(key);
    w.append_raw_value(value);
    w.buf.len() as u32
}

/// Append the `serverMeta` top-level snapshot key. This mirrors the
/// ServerSnapshotMetaBuilder object-literal insertion order so the
/// Rust envelope remains byte-identical with @msgpack/msgpack while
/// removing one always-present raw fallback from the DP-02 hot path.
#[wasm_bindgen]
pub fn snapshot_encode_envelope_emit_server_meta(
    ticks_avg: f64,
    ticks_low: f64,
    ticks_rate: f64,
    snaps_rate_is_string: u8,
    snaps_rate: f64,
    snaps_rate_slot: u32,
    snaps_keyframes_is_string: u8,
    snaps_keyframes: f64,
    snaps_keyframes_slot: u32,
    server_time_slot: u32,
    server_ip_slot: u32,
    grid_enabled: u8,
    has_units_allowed: u8,
    units_allowed_slot_start: u32,
    units_allowed_count: u32,
    has_units_max: u8,
    units_max: f64,
    has_units_count: u8,
    units_count: f64,
    has_turret_shield_panels_enabled: u8,
    turret_shield_panels_enabled: u8,
    has_turret_shield_spheres_enabled: u8,
    turret_shield_spheres_enabled: u8,
    has_force_fields_visible: u8,
    force_fields_visible: u8,
    has_shields_obstruct_sight: u8,
    shields_obstruct_sight: u8,
    has_shield_reflection_mode: u8,
    shield_reflection_mode_slot: u32,
    has_fog_of_war_enabled: u8,
    fog_of_war_enabled: u8,
    cpu_avg: f64,
    cpu_hi: f64,
    wind_x: f64,
    wind_y: f64,
    wind_speed: f64,
    wind_angle: f64,
    tilt_ema_slot: u32,
) -> u32 {
    let w = messagepack_writer();

    let mut field_count: usize = 8; // ticks, snaps, server, grid, units, cpu, wind, unitGroundNormalEma
    if has_turret_shield_panels_enabled != 0 {
        field_count += 1;
    }
    if has_turret_shield_spheres_enabled != 0 {
        field_count += 1;
    }
    if has_force_fields_visible != 0 {
        field_count += 1;
    }
    if has_shields_obstruct_sight != 0 {
        field_count += 1;
    }
    if has_shield_reflection_mode != 0 {
        field_count += 1;
    }
    if has_fog_of_war_enabled != 0 {
        field_count += 1;
    }

    w.write_str("serverMeta");
    w.write_map_header(field_count);

    w.write_str("ticks");
    w.write_map_header(3);
    w.write_str("avg");
    w.write_number(ticks_avg);
    w.write_str("low");
    w.write_number(ticks_low);
    w.write_str("rate");
    w.write_number(ticks_rate);

    w.write_str("snaps");
    w.write_map_header(2);
    w.write_str("rate");
    if snaps_rate_is_string != 0 {
        write_string_from_scratch(w, snaps_rate_slot);
    } else {
        w.write_number(snaps_rate);
    }
    w.write_str("keyframes");
    if snaps_keyframes_is_string != 0 {
        write_string_from_scratch(w, snaps_keyframes_slot);
    } else {
        w.write_number(snaps_keyframes);
    }

    w.write_str("server");
    w.write_map_header(2);
    w.write_str("time");
    write_string_from_scratch(w, server_time_slot);
    w.write_str("ip");
    write_string_from_scratch(w, server_ip_slot);

    w.write_str("grid");
    w.write_bool(grid_enabled != 0);

    let mut units_field_count: usize = 0;
    if has_units_allowed != 0 {
        units_field_count += 1;
    }
    if has_units_max != 0 {
        units_field_count += 1;
    }
    if has_units_count != 0 {
        units_field_count += 1;
    }
    w.write_str("units");
    w.write_map_header(units_field_count);
    if has_units_allowed != 0 {
        w.write_str("allowed");
        let count = units_allowed_count as usize;
        w.write_array_header(count);
        for i in 0..count {
            write_string_from_scratch(w, units_allowed_slot_start + i as u32);
        }
    }
    if has_units_max != 0 {
        w.write_str("max");
        w.write_number(units_max);
    }
    if has_units_count != 0 {
        w.write_str("count");
        w.write_number(units_count);
    }

    if has_turret_shield_panels_enabled != 0 {
        w.write_str("mirrorsEnabled");
        w.write_bool(turret_shield_panels_enabled != 0);
    }
    if has_turret_shield_spheres_enabled != 0 {
        w.write_str("shieldsEnabled");
        w.write_bool(turret_shield_spheres_enabled != 0);
    }
    if has_force_fields_visible != 0 {
        w.write_str("forceFieldsVisible");
        w.write_bool(force_fields_visible != 0);
    }
    if has_shields_obstruct_sight != 0 {
        w.write_str("shieldsObstructSight");
        w.write_bool(shields_obstruct_sight != 0);
    }
    if has_shield_reflection_mode != 0 {
        w.write_str("shieldReflectionMode");
        write_string_from_scratch(w, shield_reflection_mode_slot);
    }
    if has_fog_of_war_enabled != 0 {
        w.write_str("fogOfWarEnabled");
        w.write_bool(fog_of_war_enabled != 0);
    }

    w.write_str("cpu");
    w.write_map_header(2);
    w.write_str("avg");
    w.write_number(cpu_avg);
    w.write_str("hi");
    w.write_number(cpu_hi);

    w.write_str("wind");
    w.write_map_header(4);
    w.write_str("x");
    w.write_number(wind_x);
    w.write_str("y");
    w.write_number(wind_y);
    w.write_str("speed");
    w.write_number(wind_speed);
    w.write_str("angle");
    w.write_number(wind_angle);

    w.write_str("unitGroundNormalEma");
    write_string_from_scratch(w, tilt_ema_slot);

    w.buf.len() as u32
}

/// Append the envelope's `projectiles: {...}` nested object.
/// Supports `spawns`, `despawns`, `velocityUpdates`, `beamUpdates`.
/// Called between emit_economy and _continue (pool order: projectiles
/// sits after economy and before gameState).
#[wasm_bindgen]
pub fn snapshot_encode_envelope_emit_projectiles(
    has_spawns: u8,
    spawn_count: u32,
    has_despawns: u8,
    despawn_count: u32,
    has_velocity_updates: u8,
    velocity_update_count: u32,
    has_beam_updates: u8,
    beam_update_count: u32,
) {
    let w = messagepack_writer();
    let mut nested_count: usize = 0;
    if has_spawns != 0 {
        nested_count += 1;
    }
    if has_despawns != 0 {
        nested_count += 1;
    }
    if has_velocity_updates != 0 {
        nested_count += 1;
    }
    if has_beam_updates != 0 {
        nested_count += 1;
    }
    if nested_count == 0 {
        return;
    }

    w.write_str("projectiles");
    w.write_map_header(nested_count);

    // Sub-key order in ProjectileSnapshot (stateSerializerProjectiles.ts
    // _projectilesBuf pool init): spawns, despawns, velocityUpdates,
    // beamUpdates. We emit only the present subset.
    if has_spawns != 0 {
        let n = spawn_count as usize;
        let scratch = snapshot_encode_proj_spawn_scratch();
        w.write_str("spawns");
        w.write_array_header(n);
        for i in 0..n {
            let base = i * SNAPSHOT_ENCODE_PROJ_SPAWN_STRIDE;
            let flags = scratch.buf[base + 31] as u32;
            let has_max_lifespan = (flags & 0x01) != 0;
            let has_shot_blueprint_code = (flags & 0x02) != 0;
            let has_source_turret_blueprint_code = (flags & 0x04) != 0;
            let has_is_dgun_true = (flags & 0x08) != 0;
            let has_from_parent_true = (flags & 0x10) != 0;
            let has_beam = (flags & 0x20) != 0;
            let has_target = (flags & 0x40) != 0;
            let has_homing = (flags & 0x80) != 0;
            let has_is_dgun_false = (flags & 0x100) != 0;
            let has_from_parent_false = (flags & 0x200) != 0;
            let has_source_turret_entity_id =
                (flags & PROJECTILE_SPAWN_FLAG_SOURCE_TURRET_ENTITY_ID) != 0;
            let has_parent_shot_entity_id =
                (flags & PROJECTILE_SPAWN_FLAG_PARENT_SHOT_ENTITY_ID) != 0;
            let has_is_dgun = has_is_dgun_true || has_is_dgun_false;
            let has_from_parent = has_from_parent_true || has_from_parent_false;

            // Field count = always-present 14 (id, pos, rotation,
            // velocity, projectileType, turretBlueprintCode, playerId,
            // sourceEntityId, sourceHostEntityId, sourceRootEntityId,
            // sourceTeamId, spawnTick, turretIndex, barrelIndex).
            let mut field_count: usize = 14;
            if has_max_lifespan {
                field_count += 1;
            }
            if has_shot_blueprint_code {
                field_count += 1;
            }
            if has_source_turret_blueprint_code {
                field_count += 1;
            }
            if has_source_turret_entity_id {
                field_count += 1;
            }
            if has_parent_shot_entity_id {
                field_count += 1;
            }
            if has_is_dgun {
                field_count += 1;
            }
            if has_from_parent {
                field_count += 1;
            }
            if has_beam {
                field_count += 1;
            }
            if has_target {
                field_count += 1;
            }
            if has_homing {
                field_count += 1;
            }
            w.write_map_header(field_count);

            // Pool order from createPooledProjectileSpawn.
            w.write_str("id");
            w.write_uint(scratch.buf[base] as u64);
            w.write_str("pos");
            w.write_map_header(3);
            w.write_str("x");
            w.write_number(scratch.buf[base + 1]);
            w.write_str("y");
            w.write_number(scratch.buf[base + 2]);
            w.write_str("z");
            w.write_number(scratch.buf[base + 3]);
            w.write_str("rotation");
            w.write_number(scratch.buf[base + 4]);
            w.write_str("velocity");
            w.write_map_header(3);
            w.write_str("x");
            w.write_number(scratch.buf[base + 5]);
            w.write_str("y");
            w.write_number(scratch.buf[base + 6]);
            w.write_str("z");
            w.write_number(scratch.buf[base + 7]);
            w.write_str("projectileType");
            w.write_uint(scratch.buf[base + 8] as u64);
            if has_max_lifespan {
                w.write_str("maxLifespan");
                w.write_number(scratch.buf[base + 9]);
            }
            w.write_str("turretBlueprintCode");
            w.write_uint(scratch.buf[base + 10] as u64);
            if has_shot_blueprint_code {
                w.write_str("shotBlueprintCode");
                w.write_uint(scratch.buf[base + 11] as u64);
            }
            if has_source_turret_blueprint_code {
                w.write_str("sourceTurretBlueprintCode");
                w.write_uint(scratch.buf[base + 12] as u64);
            }
            if has_source_turret_entity_id {
                w.write_str("sourceTurretEntityId");
                w.write_uint(scratch.buf[base + 25] as u64);
            }
            w.write_str("playerId");
            w.write_uint(scratch.buf[base + 13] as u64);
            w.write_str("sourceEntityId");
            w.write_uint(scratch.buf[base + 14] as u64);
            w.write_str("sourceHostEntityId");
            w.write_uint(scratch.buf[base + 26] as u64);
            w.write_str("sourceRootEntityId");
            w.write_uint(scratch.buf[base + 27] as u64);
            w.write_str("sourceTeamId");
            w.write_uint(scratch.buf[base + 28] as u64);
            w.write_str("spawnTick");
            w.write_uint(scratch.buf[base + 29] as u64);
            if has_parent_shot_entity_id {
                w.write_str("parentShotEntityId");
                w.write_uint(scratch.buf[base + 30] as u64);
            }
            w.write_str("turretIndex");
            w.write_uint(scratch.buf[base + 15] as u64);
            w.write_str("barrelIndex");
            w.write_uint(scratch.buf[base + 16] as u64);
            if has_is_dgun {
                w.write_str("isDGun");
                w.write_bool(has_is_dgun_true);
            }
            if has_from_parent {
                w.write_str("fromParentDetonation");
                w.write_bool(has_from_parent_true);
            }
            if has_beam {
                w.write_str("beam");
                w.write_map_header(2);
                w.write_str("start");
                w.write_map_header(3);
                w.write_str("x");
                w.write_number(scratch.buf[base + 17]);
                w.write_str("y");
                w.write_number(scratch.buf[base + 18]);
                w.write_str("z");
                w.write_number(scratch.buf[base + 19]);
                w.write_str("end");
                w.write_map_header(3);
                w.write_str("x");
                w.write_number(scratch.buf[base + 20]);
                w.write_str("y");
                w.write_number(scratch.buf[base + 21]);
                w.write_str("z");
                w.write_number(scratch.buf[base + 22]);
            }
            if has_target {
                w.write_str("targetEntityId");
                w.write_uint(scratch.buf[base + 23] as u64);
            }
            if has_homing {
                w.write_str("homingTurnRate");
                w.write_number(scratch.buf[base + 24]);
            }
        }
    }
    if has_despawns != 0 {
        let n = despawn_count as usize;
        let scratch = snapshot_encode_proj_despawn_scratch();
        w.write_str("despawns");
        w.write_array_header(n);
        for i in 0..n {
            // Despawn DTO: {id: number}
            w.write_map_header(1);
            w.write_str("id");
            w.write_uint(scratch.buf[i] as u64);
        }
    }
    if has_velocity_updates != 0 {
        let n = velocity_update_count as usize;
        let scratch = snapshot_encode_proj_vel_scratch();
        w.write_str("velocityUpdates");
        w.write_array_header(n);
        for i in 0..n {
            let base = i * SNAPSHOT_ENCODE_PROJ_VEL_STRIDE;
            let id = scratch.buf[base] as u32;
            let px = scratch.buf[base + 1];
            let py = scratch.buf[base + 2];
            let pz = scratch.buf[base + 3];
            let vx = scratch.buf[base + 4];
            let vy = scratch.buf[base + 5];
            let vz = scratch.buf[base + 6];
            let clear_homing_target = scratch.buf[base + 7] != 0.0;
            // velocityUpdate DTO: {id, pos: {x, y, z}, velocity: {x, y, z}, clearHomingTarget?}
            w.write_map_header(if clear_homing_target { 4 } else { 3 });
            w.write_str("id");
            w.write_uint(id as u64);
            w.write_str("pos");
            w.write_map_header(3);
            w.write_str("x");
            w.write_number(px);
            w.write_str("y");
            w.write_number(py);
            w.write_str("z");
            w.write_number(pz);
            w.write_str("velocity");
            w.write_map_header(3);
            w.write_str("x");
            w.write_number(vx);
            w.write_str("y");
            w.write_number(vy);
            w.write_str("z");
            w.write_number(vz);
            if clear_homing_target {
                w.write_str("clearHomingTarget");
                w.write_bool(true);
            }
        }
    }
    if has_beam_updates != 0 {
        let n = beam_update_count as usize;
        let header_scratch = snapshot_encode_beam_update_scratch();
        let point_scratch = snapshot_encode_beam_point_scratch();
        w.write_str("beamUpdates");
        w.write_array_header(n);
        let mut point_offset: usize = 0;
        for i in 0..n {
            let h = i * SNAPSHOT_ENCODE_BEAM_UPDATE_STRIDE;
            let id = header_scratch.buf[h] as u32;
            let flags = header_scratch.buf[h + 1] as u32;
            let has_obstruction_t = (flags & 0x01) != 0;
            let has_endpoint_damageable_false = (flags & 0x02) != 0;
            let has_endpoint_damageable_true = (flags & 0x04) != 0;
            let has_endpoint_damageable =
                has_endpoint_damageable_false || has_endpoint_damageable_true;
            let obstruction_t = header_scratch.buf[h + 2];
            let point_count = header_scratch.buf[h + 3] as usize;

            // BeamUpdate DTO field count = always 2 (id + points) +
            // optional obstructionT + optional endpointDamageable.
            let mut field_count: usize = 2;
            if has_obstruction_t {
                field_count += 1;
            }
            if has_endpoint_damageable {
                field_count += 1;
            }
            w.write_map_header(field_count);

            // Pool order in createPooledBeamUpdate: id, points,
            // obstructionT, endpointDamageable.
            w.write_str("id");
            w.write_uint(id as u64);
            w.write_str("points");
            w.write_array_header(point_count);
            for p in 0..point_count {
                let pb = (point_offset + p) * SNAPSHOT_ENCODE_BEAM_POINT_STRIDE;
                let x = point_scratch.buf[pb];
                let y = point_scratch.buf[pb + 1];
                let z = point_scratch.buf[pb + 2];
                let vx = point_scratch.buf[pb + 3];
                let vy = point_scratch.buf[pb + 4];
                let vz = point_scratch.buf[pb + 5];
                let pflags = point_scratch.buf[pb + 6] as u32;
                let has_reflector_entity_id = (pflags & 0x01) != 0;
                let has_reflector_kind = (pflags & 0x02) != 0;
                let has_reflector_player = (pflags & 0x08) != 0;
                let has_normal_x = (pflags & 0x10) != 0;
                let has_normal_y = (pflags & 0x20) != 0;
                let has_normal_z = (pflags & 0x40) != 0;
                let reflector_entity_id = point_scratch.buf[pb + 7] as u32;
                let reflector_player = point_scratch.buf[pb + 8] as u32;
                let nx = point_scratch.buf[pb + 9];
                let ny = point_scratch.buf[pb + 10];
                let nz = point_scratch.buf[pb + 11];

                // BeamPoint DTO field count = always 6 (x,y,z,vx,vy,vz)
                // + optional reflector + normal fields. Acceleration is
                // intentionally not on the wire; clients extrapolate from
                // velocity only between path corrections.
                let mut pf_count: usize = 6;
                if has_reflector_entity_id {
                    pf_count += 1;
                }
                if has_reflector_kind {
                    pf_count += 1;
                }
                if has_reflector_player {
                    pf_count += 1;
                }
                if has_normal_x {
                    pf_count += 1;
                }
                if has_normal_y {
                    pf_count += 1;
                }
                if has_normal_z {
                    pf_count += 1;
                }
                w.write_map_header(pf_count);

                // Pool order from createPooledBeamPoint: x, y, z,
                // vx, vy, vz, [reflectorEntityId,
                // reflectorKind, reflectorPlayerId, normalX/Y/Z].
                w.write_str("x");
                w.write_number(x);
                w.write_str("y");
                w.write_number(y);
                w.write_str("z");
                w.write_number(z);
                w.write_str("vx");
                w.write_number(vx);
                w.write_str("vy");
                w.write_number(vy);
                w.write_str("vz");
                w.write_number(vz);
                if has_reflector_entity_id {
                    w.write_str("reflectorEntityId");
                    w.write_uint(reflector_entity_id as u64);
                }
                if has_reflector_kind {
                    w.write_str("reflectorKind");
                    w.write_str("shield");
                }
                if has_reflector_player {
                    w.write_str("reflectorPlayerId");
                    w.write_uint(reflector_player as u64);
                }
                if has_normal_x {
                    w.write_str("normalX");
                    w.write_number(nx);
                }
                if has_normal_y {
                    w.write_str("normalY");
                    w.write_number(ny);
                }
                if has_normal_z {
                    w.write_str("normalZ");
                    w.write_number(nz);
                }
            }
            point_offset += point_count;
            if has_obstruction_t {
                w.write_str("obstructionT");
                w.write_number(obstruction_t);
            }
            if has_endpoint_damageable {
                w.write_str("endpointDamageable");
                w.write_bool(has_endpoint_damageable_true);
            }
        }
    }
}

/// Append compact `projectiles: { v: 3, s?, d?, u?, b? }` from the
/// caller-filled projectile scratches. Matches
/// snapshotProjectileWirePack.ts V3 while keeping the Rust send path
/// out of the TypeScript packed-binary writer.
#[wasm_bindgen]
pub fn snapshot_encode_envelope_emit_packed_projectiles(
    has_spawns: u8,
    spawn_count: u32,
    has_despawns: u8,
    despawn_count: u32,
    has_velocity_updates: u8,
    velocity_update_count: u32,
    has_beam_updates: u8,
    beam_update_count: u32,
    beam_point_count: u32,
) -> u32 {
    let w = messagepack_writer();
    let mut packed_key_count: usize = 1; // v
    if has_spawns != 0 {
        packed_key_count += 1;
    }
    if has_despawns != 0 {
        packed_key_count += 1;
    }
    if has_velocity_updates != 0 {
        packed_key_count += 1;
    }
    if has_beam_updates != 0 {
        packed_key_count += 1;
    }

    w.write_str("projectiles");
    w.write_map_header(packed_key_count);
    w.write_str("v");
    w.write_uint(PACKED_PROJECTILES_VERSION);

    if has_spawns != 0 {
        pack_projectile_spawns_v2(spawn_count as usize);
        let packed = snapshot_encode_packed_projectile_scratch();
        w.write_str("s");
        w.write_bin(packed.out.as_slice());
    }
    if has_despawns != 0 {
        pack_projectile_despawns_v2(despawn_count as usize);
        let packed = snapshot_encode_packed_projectile_scratch();
        w.write_str("d");
        w.write_bin(packed.out.as_slice());
    }
    if has_velocity_updates != 0 {
        pack_projectile_velocity_updates_v2(velocity_update_count as usize);
        let packed = snapshot_encode_packed_projectile_scratch();
        w.write_str("u");
        w.write_bin(packed.out.as_slice());
    }
    if has_beam_updates != 0 {
        pack_projectile_beam_updates_v2(beam_update_count as usize, beam_point_count as usize);
        let packed = snapshot_encode_packed_projectile_scratch();
        w.write_str("b");
        w.write_bin(packed.out.as_slice());
    }

    w.buf.len() as u32
}

/// Append the minimapEntities array. Called after the last
/// entity in the envelope's `entities[]` is written and BEFORE
/// snapshot_encode_envelope_continue runs (minimapEntities sits
/// between entities and economy in the pool insertion order).
/// Reads count entries from the minimap scratch.
#[wasm_bindgen]
pub fn snapshot_encode_envelope_emit_minimap(count: u32) {
    let w = messagepack_writer();
    let scratch = snapshot_encode_minimap_scratch();
    let n = count as usize;
    w.write_str("minimapEntities");
    w.write_array_header(n);
    for i in 0..n {
        let base = i * SNAPSHOT_ENCODE_MINIMAP_STRIDE;
        let id = scratch.buf[base] as u32;
        let pos_x = scratch.buf[base + 1];
        let pos_y = scratch.buf[base + 2];
        let type_tag = scratch.buf[base + 3] as u8;
        let player_id = scratch.buf[base + 4] as u8;
        let radar_packed = scratch.buf[base + 5] as u8;
        let has_radar = (radar_packed & 0x01) != 0;
        let radar_value = (radar_packed & 0x02) != 0;

        // Pool insertion order for the minimap DTO: id, pos, type,
        // playerId, radarOnly.
        let field_count = if has_radar { 5 } else { 4 };
        w.write_map_header(field_count);
        w.write_str("id");
        w.write_uint(id as u64);
        w.write_str("pos");
        w.write_map_header(2);
        w.write_str("x");
        w.write_number(pos_x);
        w.write_str("y");
        w.write_number(pos_y);
        w.write_str("type");
        match type_tag {
            SNAPSHOT_ENTITY_TYPE_UNIT => w.write_str("unit"),
            SNAPSHOT_ENTITY_TYPE_BUILDING => w.write_str("building"),
            SNAPSHOT_ENTITY_TYPE_TOWER => w.write_str("tower"),
            _ => w.write_str(""),
        }
        w.write_str("playerId");
        w.write_uint(player_id as u64);
        if has_radar {
            w.write_str("radarOnly");
            w.write_bool(radar_value);
        }
    }
}

/// Append compact `minimapEntities: { v: 2, b }` from the minimap
/// scratch. Matches snapshotMinimapWirePack.ts V2 while keeping the
/// Rust snapshot send path out of the TypeScript packed-binary writer.
#[wasm_bindgen]
pub fn snapshot_encode_envelope_emit_packed_minimap(count: u32) -> u32 {
    let w = messagepack_writer();
    pack_minimap_entities_v2(count as usize);
    let packed = snapshot_encode_packed_minimap_scratch();

    w.write_str("minimapEntities");
    w.write_map_header(2);
    w.write_str("v");
    w.write_uint(PACKED_MINIMAP_ENTITIES_VERSION);
    w.write_str("b");
    w.write_bin(packed.out.as_slice());
    w.buf.len() as u32
}

/// Append the economy key. Sits between minimapEntities and
/// sprayTargets in pool insertion order. Body is a Record<PlayerId,
/// EconomySnapshot>; the caller pre-packs the economy scratch with
/// per-player data sorted ASC by playerId (so msgpack key iteration
/// matches @msgpack/msgpack on a JS object with integer-string keys),
/// then passes the player count.
#[wasm_bindgen]
pub fn snapshot_encode_envelope_emit_economy(player_count: u32) -> u32 {
    let w = messagepack_writer();
    let n = player_count as usize;
    w.write_str("economy");
    w.write_map_header(n);
    if n == 0 {
        return w.buf.len() as u32;
    }
    let scratch = snapshot_encode_economy_scratch();
    let mut key_buf = [0u8; 12];
    for i in 0..n {
        let base = i * SNAPSHOT_ENCODE_ECONOMY_STRIDE;
        let player_id = scratch.buf[base] as u32;
        let key_str = u32_to_decimal(&mut key_buf, player_id);
        w.write_str(key_str);

        // Per-player DTO field count = 4 (stockpile, income,
        // expenditure, metal — all required).
        w.write_map_header(4);
        // stockpile: { curr, max }
        w.write_str("stockpile");
        w.write_map_header(2);
        w.write_str("curr");
        w.write_number(scratch.buf[base + 1]);
        w.write_str("max");
        w.write_number(scratch.buf[base + 2]);
        // income: { base, production }
        w.write_str("income");
        w.write_map_header(2);
        w.write_str("base");
        w.write_number(scratch.buf[base + 3]);
        w.write_str("production");
        w.write_number(scratch.buf[base + 4]);
        // expenditure
        w.write_str("expenditure");
        w.write_number(scratch.buf[base + 5]);
        // metal: { stockpile, income, expenditure }
        w.write_str("metal");
        w.write_map_header(3);
        w.write_str("stockpile");
        w.write_map_header(2);
        w.write_str("curr");
        w.write_number(scratch.buf[base + 6]);
        w.write_str("max");
        w.write_number(scratch.buf[base + 7]);
        w.write_str("income");
        w.write_map_header(2);
        w.write_str("base");
        w.write_number(scratch.buf[base + 8]);
        w.write_str("extraction");
        w.write_number(scratch.buf[base + 9]);
        w.write_str("expenditure");
        w.write_number(scratch.buf[base + 10]);
    }
    w.buf.len() as u32
}

/// Append `resourceMovements: [...]`. Sits between economy and
/// sprayTargets in pool insertion order. Each movement is emitted as
/// the full DTO map; targetEntityId is null when the row's has-target
/// flag is unset.
#[wasm_bindgen]
pub fn snapshot_encode_envelope_emit_resource_movements(count: u32) -> u32 {
    let w = messagepack_writer();
    let n = count as usize;
    w.write_str("resourceMovements");
    w.write_array_header(n);
    if n == 0 {
        return w.buf.len() as u32;
    }

    let scratch = snapshot_encode_resource_movement_scratch();
    for i in 0..n {
        let base = i * SNAPSHOT_ENCODE_RESOURCE_MOVEMENT_STRIDE;
        w.write_map_header(6);

        w.write_str("playerId");
        w.write_uint(scratch.buf[base] as u64);

        w.write_str("sourceEntityId");
        w.write_uint(scratch.buf[base + 1] as u64);

        w.write_str("targetEntityId");
        if scratch.buf[base + 6] != 0.0 {
            w.write_uint(scratch.buf[base + 2] as u64);
        } else {
            w.write_nil();
        }

        w.write_str("resource");
        w.write_uint(scratch.buf[base + 3] as u64);

        w.write_str("amountPerSecond");
        w.write_number(scratch.buf[base + 4]);

        w.write_str("direction");
        w.write_uint(scratch.buf[base + 5] as u64);
    }
    w.buf.len() as u32
}

/// Append `audioEvents: [...]`. Sits between sprayTargets and
/// projectiles in iteration order. Per-event pool-iteration order
/// matches NetworkServerSnapshotSimEvent / createPooledSimEvent:
/// type, turretBlueprintId, sourceType, sourceKey, pos, playerId, entityId,
/// deathContext, impactContext, waterSplash, shieldImpact,
/// killerPlayerId, victimPlayerId, audioOnly.
///
/// D.3j-27 adds deathContext + impactContext support. Caller pre-packs
/// per-context scratches in event order; the encoder walks audio
/// events with local offsets into each context scratch.
#[wasm_bindgen]
pub fn snapshot_encode_envelope_emit_audio_events(count: u32) -> u32 {
    let w = messagepack_writer();
    let n = count as usize;
    let scratch = snapshot_encode_audio_event_scratch();
    let death_scratch = snapshot_encode_death_context_scratch();
    let pose_scratch = snapshot_encode_turret_pose_scratch();
    let impact_scratch = snapshot_encode_impact_context_scratch();
    w.write_str("audioEvents");
    w.write_array_header(n);
    let mut death_offset: usize = 0;
    let mut pose_offset: usize = 0;
    let mut impact_offset: usize = 0;
    for i in 0..n {
        let base = i * SNAPSHOT_ENCODE_AUDIO_EVENT_STRIDE;
        let type_code = scratch.buf[base] as u8;
        let pos_x = scratch.buf[base + 1];
        let pos_y = scratch.buf[base + 2];
        let pos_z = scratch.buf[base + 3];
        let player_id = scratch.buf[base + 4] as u32;
        let entity_id = scratch.buf[base + 5] as u32;
        let killer_player_id = scratch.buf[base + 6] as u32;
        let victim_player_id = scratch.buf[base + 7] as u32;
        let ff_nx = scratch.buf[base + 8];
        let ff_ny = scratch.buf[base + 9];
        let ff_nz = scratch.buf[base + 10];
        let ff_player_id = scratch.buf[base + 11] as u32;
        let source_type_code = scratch.buf[base + 12] as u8;
        let turret_id_slot = scratch.buf[base + 13] as u32;
        let source_key_slot = scratch.buf[base + 14] as u32;
        let flags = scratch.buf[base + 15] as u32;

        let has_source_type = (flags & 0x001) != 0;
        let has_source_key = (flags & 0x002) != 0;
        let has_player_id = (flags & 0x004) != 0;
        let has_entity_id = (flags & 0x008) != 0;
        let has_ff_impact = (flags & 0x010) != 0;
        let has_killer = (flags & 0x020) != 0;
        let has_victim = (flags & 0x040) != 0;
        let has_audio_only = (flags & 0x080) != 0;
        let audio_only_value = (flags & 0x100) != 0;
        let has_death_context = (flags & 0x200) != 0;
        let has_impact_context = (flags & 0x400) != 0;
        let has_water_splash = (flags & 0x800) != 0;

        // Per-event field count: 3 always (type, turretBlueprintId, pos) +
        // optionals.
        let mut field_count: usize = 3;
        if has_source_type {
            field_count += 1;
        }
        if has_source_key {
            field_count += 1;
        }
        if has_player_id {
            field_count += 1;
        }
        if has_entity_id {
            field_count += 1;
        }
        if has_death_context {
            field_count += 1;
        }
        if has_impact_context {
            field_count += 1;
        }
        if has_water_splash {
            field_count += 1;
        }
        if has_ff_impact {
            field_count += 1;
        }
        if has_killer {
            field_count += 1;
        }
        if has_victim {
            field_count += 1;
        }
        if has_audio_only {
            field_count += 1;
        }
        w.write_map_header(field_count);

        // Pool-iteration order as documented above.
        w.write_str("type");
        w.write_str(audio_event_type_str(type_code));
        w.write_str("turretBlueprintId");
        write_string_from_scratch(w, turret_id_slot);
        if has_source_type {
            w.write_str("sourceType");
            w.write_str(audio_event_source_type_str(source_type_code));
        }
        if has_source_key {
            w.write_str("sourceKey");
            write_string_from_scratch(w, source_key_slot);
        }
        w.write_str("pos");
        w.write_map_header(3);
        w.write_str("x");
        w.write_number(pos_x);
        w.write_str("y");
        w.write_number(pos_y);
        w.write_str("z");
        w.write_number(pos_z);
        if has_player_id {
            w.write_str("playerId");
            w.write_uint(player_id as u64);
        }
        if has_entity_id {
            w.write_str("entityId");
            w.write_uint(entity_id as u64);
        }
        if has_death_context {
            let db = death_offset * SNAPSHOT_ENCODE_DEATH_CONTEXT_STRIDE;
            let unit_vel_x = death_scratch.buf[db];
            let unit_vel_y = death_scratch.buf[db + 1];
            let hit_dir_x = death_scratch.buf[db + 2];
            let hit_dir_y = death_scratch.buf[db + 3];
            let proj_vel_x = death_scratch.buf[db + 4];
            let proj_vel_y = death_scratch.buf[db + 5];
            let attack_magnitude = death_scratch.buf[db + 6];
            let radius = death_scratch.buf[db + 7];
            let color = death_scratch.buf[db + 8];
            let visual_radius = death_scratch.buf[db + 9];
            let death_collision_radius = death_scratch.buf[db + 10];
            let base_z = death_scratch.buf[db + 11];
            let rotation = death_scratch.buf[db + 12];
            let unit_type_slot = death_scratch.buf[db + 13] as u32;
            let turret_pose_count = death_scratch.buf[db + 14] as usize;
            let dflags = death_scratch.buf[db + 15] as u32;

            let has_visual_radius = (dflags & 0x01) != 0;
            let has_collision_radius = (dflags & 0x02) != 0;
            let has_base_z = (dflags & 0x04) != 0;
            let has_unit_type = (dflags & 0x08) != 0;
            let has_rotation = (dflags & 0x10) != 0;
            let has_turret_poses = (dflags & 0x20) != 0;

            // Field count: 6 always (unitVel, hitDir, projectileVel,
            // attackMagnitude, radius, color) + optionals.
            let mut dc_field_count: usize = 6;
            if has_visual_radius {
                dc_field_count += 1;
            }
            if has_collision_radius {
                dc_field_count += 1;
            }
            if has_base_z {
                dc_field_count += 1;
            }
            if has_unit_type {
                dc_field_count += 1;
            }
            if has_rotation {
                dc_field_count += 1;
            }
            if has_turret_poses {
                dc_field_count += 1;
            }

            w.write_str("deathContext");
            w.write_map_header(dc_field_count);

            // Literal order from damageHelpers.ts: unitVel, hitDir,
            // projectileVel, attackMagnitude, radius, visualRadius,
            // collisionRadius, baseZ, color, unitBlueprintId, rotation, turretPoses.
            w.write_str("unitVel");
            w.write_map_header(2);
            w.write_str("x");
            w.write_number(unit_vel_x);
            w.write_str("y");
            w.write_number(unit_vel_y);
            w.write_str("hitDir");
            w.write_map_header(2);
            w.write_str("x");
            w.write_number(hit_dir_x);
            w.write_str("y");
            w.write_number(hit_dir_y);
            w.write_str("projectileVel");
            w.write_map_header(2);
            w.write_str("x");
            w.write_number(proj_vel_x);
            w.write_str("y");
            w.write_number(proj_vel_y);
            w.write_str("attackMagnitude");
            w.write_number(attack_magnitude);
            w.write_str("radius");
            w.write_number(radius);
            if has_visual_radius {
                w.write_str("visualRadius");
                w.write_number(visual_radius);
            }
            if has_collision_radius {
                w.write_str("collisionRadius");
                w.write_number(death_collision_radius);
            }
            if has_base_z {
                w.write_str("baseZ");
                w.write_number(base_z);
            }
            w.write_str("color");
            w.write_number(color);
            if has_unit_type {
                w.write_str("unitBlueprintId");
                write_string_from_scratch(w, unit_type_slot);
            }
            if has_rotation {
                w.write_str("rotation");
                w.write_number(rotation);
            }
            if has_turret_poses {
                w.write_str("turretPoses");
                w.write_array_header(turret_pose_count);
                for p in 0..turret_pose_count {
                    let pb = (pose_offset + p) * SNAPSHOT_ENCODE_TURRET_POSE_STRIDE;
                    let rot = pose_scratch.buf[pb];
                    let pitch = pose_scratch.buf[pb + 1];
                    // Inner pose DTO: {rotation, pitch}
                    w.write_map_header(2);
                    w.write_str("rotation");
                    w.write_number(rot);
                    w.write_str("pitch");
                    w.write_number(pitch);
                }
                pose_offset += turret_pose_count;
            }
            death_offset += 1;
        }
        if has_impact_context {
            let ib = impact_offset * SNAPSHOT_ENCODE_IMPACT_CONTEXT_STRIDE;
            let radius_collision = impact_scratch.buf[ib];
            let death_explosion_radius = impact_scratch.buf[ib + 1];
            let proj_pos_x = impact_scratch.buf[ib + 2];
            let proj_pos_y = impact_scratch.buf[ib + 3];
            let proj_vel_x = impact_scratch.buf[ib + 4];
            let proj_vel_y = impact_scratch.buf[ib + 5];
            let entity_vel_x = impact_scratch.buf[ib + 6];
            let entity_vel_y = impact_scratch.buf[ib + 7];
            let entity_radius = impact_scratch.buf[ib + 8];
            let pen_dir_x = impact_scratch.buf[ib + 9];
            let pen_dir_y = impact_scratch.buf[ib + 10];

            w.write_str("impactContext");
            // Per the ImpactContext type def, all 5 fields are
            // required: radiusCollision, deathExplosionRadius, projectile,
            // entity, penetrationDir.
            w.write_map_header(5);
            w.write_str("radiusCollision");
            w.write_number(radius_collision);
            w.write_str("deathExplosionRadius");
            w.write_number(death_explosion_radius);
            w.write_str("projectile");
            w.write_map_header(2);
            w.write_str("pos");
            w.write_map_header(2);
            w.write_str("x");
            w.write_number(proj_pos_x);
            w.write_str("y");
            w.write_number(proj_pos_y);
            w.write_str("vel");
            w.write_map_header(2);
            w.write_str("x");
            w.write_number(proj_vel_x);
            w.write_str("y");
            w.write_number(proj_vel_y);
            w.write_str("entity");
            w.write_map_header(2);
            w.write_str("vel");
            w.write_map_header(2);
            w.write_str("x");
            w.write_number(entity_vel_x);
            w.write_str("y");
            w.write_number(entity_vel_y);
            w.write_str("radiusCollision");
            w.write_number(entity_radius);
            w.write_str("penetrationDir");
            w.write_map_header(2);
            w.write_str("x");
            w.write_number(pen_dir_x);
            w.write_str("y");
            w.write_number(pen_dir_y);
            impact_offset += 1;
        }
        if has_water_splash {
            w.write_str("waterSplash");
            w.write_map_header(2);
            w.write_str("velocity");
            w.write_map_header(3);
            w.write_str("x");
            w.write_number(scratch.buf[base + 16]);
            w.write_str("y");
            w.write_number(scratch.buf[base + 17]);
            w.write_str("z");
            w.write_number(scratch.buf[base + 18]);
            w.write_str("mass");
            w.write_number(scratch.buf[base + 19]);
        }
        if has_ff_impact {
            w.write_str("shieldImpact");
            // Pool order: normal, playerId (from copySimEventInto's
            // defensive literal).
            w.write_map_header(2);
            w.write_str("normal");
            w.write_map_header(3);
            w.write_str("x");
            w.write_number(ff_nx);
            w.write_str("y");
            w.write_number(ff_ny);
            w.write_str("z");
            w.write_number(ff_nz);
            w.write_str("playerId");
            w.write_uint(ff_player_id as u64);
        }
        if has_killer {
            w.write_str("killerPlayerId");
            w.write_uint(killer_player_id as u64);
        }
        if has_victim {
            w.write_str("victimPlayerId");
            w.write_uint(victim_player_id as u64);
        }
        if has_audio_only {
            w.write_str("audioOnly");
            w.write_bool(audio_only_value);
        }
    }
    w.buf.len() as u32
}

/// Append compact `audioEvents: { v, s, e, d?, i?, t? }` from the
/// caller-filled scratch buffers. This matches snapshotAudioWirePack.ts
/// byte-for-byte while avoiding transient nested JS row arrays on the
/// Rust snapshot send path.
#[wasm_bindgen]
pub fn snapshot_encode_envelope_emit_packed_audio_events(
    count: u32,
    string_count: u32,
    death_context_count: u32,
    impact_context_count: u32,
    turret_pose_count: u32,
) -> u32 {
    let w = messagepack_writer();
    let n = count as usize;
    let string_n = string_count as usize;
    let death_n = death_context_count as usize;
    let impact_n = impact_context_count as usize;
    let pose_n = turret_pose_count as usize;
    let scratch = snapshot_encode_audio_event_scratch();
    let death_scratch = snapshot_encode_death_context_scratch();
    let impact_scratch = snapshot_encode_impact_context_scratch();
    let pose_scratch = snapshot_encode_turret_pose_scratch();

    w.write_str("audioEvents");
    let mut packed_key_count = 3usize; // v, s, e
    if death_n > 0 {
        packed_key_count += 1;
    }
    if impact_n > 0 {
        packed_key_count += 1;
    }
    if pose_n > 0 {
        packed_key_count += 1;
    }
    w.write_map_header(packed_key_count);

    w.write_str("v");
    w.write_uint(2);

    w.write_str("s");
    w.write_array_header(string_n);
    for slot in 0..string_n {
        write_string_from_scratch(w, slot as u32);
    }

    w.write_str("e");
    w.write_array_header(n);
    for i in 0..n {
        let base = i * SNAPSHOT_ENCODE_AUDIO_EVENT_STRIDE;
        let flags = scratch.buf[base + 15] as u32;
        let mut row_len = 6usize;
        if (flags & 0x001) != 0 {
            row_len += 1;
        }
        if (flags & 0x002) != 0 {
            row_len += 1;
        }
        if (flags & 0x004) != 0 {
            row_len += 1;
        }
        if (flags & 0x008) != 0 {
            row_len += 1;
        }
        if (flags & 0x010) != 0 {
            row_len += 4;
        }
        if (flags & 0x020) != 0 {
            row_len += 1;
        }
        if (flags & 0x040) != 0 {
            row_len += 1;
        }
        if (flags & 0x080) != 0 {
            row_len += 1;
        }
        if (flags & 0x800) != 0 {
            row_len += 4;
        }

        w.write_array_header(row_len);
        w.write_number(scratch.buf[base]);
        w.write_number(flags as f64);
        w.write_number(scratch.buf[base + 13]);
        w.write_number(scratch.buf[base + 1]);
        w.write_number(scratch.buf[base + 2]);
        w.write_number(scratch.buf[base + 3]);
        if (flags & 0x001) != 0 {
            w.write_number(scratch.buf[base + 12]);
        }
        if (flags & 0x002) != 0 {
            w.write_number(scratch.buf[base + 14]);
        }
        if (flags & 0x004) != 0 {
            w.write_number(scratch.buf[base + 4]);
        }
        if (flags & 0x008) != 0 {
            w.write_number(scratch.buf[base + 5]);
        }
        if (flags & 0x010) != 0 {
            w.write_number(scratch.buf[base + 8]);
            w.write_number(scratch.buf[base + 9]);
            w.write_number(scratch.buf[base + 10]);
            w.write_number(scratch.buf[base + 11]);
        }
        if (flags & 0x020) != 0 {
            w.write_number(scratch.buf[base + 6]);
        }
        if (flags & 0x040) != 0 {
            w.write_number(scratch.buf[base + 7]);
        }
        if (flags & 0x080) != 0 {
            w.write_number(if (flags & 0x100) != 0 { 1.0 } else { 0.0 });
        }
        if (flags & 0x800) != 0 {
            w.write_number(scratch.buf[base + 16]);
            w.write_number(scratch.buf[base + 17]);
            w.write_number(scratch.buf[base + 18]);
            w.write_number(scratch.buf[base + 19]);
        }
    }

    if death_n > 0 {
        w.write_str("d");
        w.write_array_header(death_n);
        for i in 0..death_n {
            let base = i * SNAPSHOT_ENCODE_DEATH_CONTEXT_STRIDE;
            let flags = death_scratch.buf[base] as u32;
            let mut row_len = 10usize;
            if (flags & 0x01) != 0 {
                row_len += 1;
            }
            if (flags & 0x02) != 0 {
                row_len += 1;
            }
            if (flags & 0x04) != 0 {
                row_len += 1;
            }
            if (flags & 0x08) != 0 {
                row_len += 1;
            }
            if (flags & 0x10) != 0 {
                row_len += 1;
            }
            if (flags & 0x20) != 0 {
                row_len += 1;
            }

            w.write_array_header(row_len);
            w.write_number(flags as f64);
            for offset in 1..=9 {
                w.write_number(death_scratch.buf[base + offset]);
            }
            if (flags & 0x01) != 0 {
                w.write_number(death_scratch.buf[base + 10]);
            }
            if (flags & 0x02) != 0 {
                w.write_number(death_scratch.buf[base + 11]);
            }
            if (flags & 0x04) != 0 {
                w.write_number(death_scratch.buf[base + 12]);
            }
            if (flags & 0x08) != 0 {
                w.write_number(death_scratch.buf[base + 13]);
            }
            if (flags & 0x10) != 0 {
                w.write_number(death_scratch.buf[base + 14]);
            }
            if (flags & 0x20) != 0 {
                w.write_number(death_scratch.buf[base + 15]);
            }
        }
    }

    if impact_n > 0 {
        w.write_str("i");
        w.write_array_header(impact_n);
        for i in 0..impact_n {
            let base = i * SNAPSHOT_ENCODE_IMPACT_CONTEXT_STRIDE;
            w.write_array_header(SNAPSHOT_ENCODE_IMPACT_CONTEXT_STRIDE);
            for offset in 0..SNAPSHOT_ENCODE_IMPACT_CONTEXT_STRIDE {
                w.write_number(impact_scratch.buf[base + offset]);
            }
        }
    }

    if pose_n > 0 {
        w.write_str("t");
        w.write_array_header(pose_n);
        for i in 0..pose_n {
            let base = i * SNAPSHOT_ENCODE_TURRET_POSE_STRIDE;
            w.write_array_header(SNAPSHOT_ENCODE_TURRET_POSE_STRIDE);
            w.write_number(pose_scratch.buf[base]);
            w.write_number(pose_scratch.buf[base + 1]);
        }
    }

    w.buf.len() as u32
}

/// Append `sprayTargets: [...]`. Sits between economy and projectiles
/// in iteration order (sprayTargets is in the _snapshotBuf static
/// init). Reads `count` entries (17 f64 each) from the spray scratch.
#[wasm_bindgen]
pub fn snapshot_encode_envelope_emit_spray_targets(count: u32) -> u32 {
    let w = messagepack_writer();
    let n = count as usize;
    let scratch = snapshot_encode_spray_scratch();
    w.write_str("sprayTargets");
    w.write_array_header(n);
    for i in 0..n {
        let base = i * SNAPSHOT_ENCODE_SPRAY_STRIDE;
        let flags = scratch.buf[base + 16] as u32;
        let type_is_heal = (flags & 0x01) != 0;
        let has_source_z = (flags & 0x02) != 0;
        let has_target_z = (flags & 0x04) != 0;
        let has_target_dim = (flags & 0x08) != 0;
        let has_target_radius = (flags & 0x10) != 0;
        let has_speed = (flags & 0x20) != 0;
        let has_particle_radius = (flags & 0x40) != 0;
        let has_ball_spawn_rate = (flags & 0x80) != 0;

        // Outer field count: source, target, type, intensity always +
        // optional speed + particleRadius + ballSpawnRate.
        let mut field_count: usize = 4;
        if has_speed {
            field_count += 1;
        }
        if has_particle_radius {
            field_count += 1;
        }
        if has_ball_spawn_rate {
            field_count += 1;
        }
        w.write_map_header(field_count);

        // source: { id, pos: {x, y}, [z], playerId } in pool order.
        w.write_str("source");
        let src_field_count = if has_source_z { 4 } else { 3 };
        w.write_map_header(src_field_count);
        w.write_str("id");
        w.write_uint(scratch.buf[base] as u64);
        w.write_str("pos");
        w.write_map_header(2);
        w.write_str("x");
        w.write_number(scratch.buf[base + 1]);
        w.write_str("y");
        w.write_number(scratch.buf[base + 2]);
        if has_source_z {
            w.write_str("z");
            w.write_number(scratch.buf[base + 3]);
        }
        w.write_str("playerId");
        w.write_uint(scratch.buf[base + 4] as u64);

        // target: { id, pos: {x, y}, [z], [dim], [radius] } in pool order.
        w.write_str("target");
        let mut tgt_field_count: usize = 2;
        if has_target_z {
            tgt_field_count += 1;
        }
        if has_target_dim {
            tgt_field_count += 1;
        }
        if has_target_radius {
            tgt_field_count += 1;
        }
        w.write_map_header(tgt_field_count);
        w.write_str("id");
        w.write_uint(scratch.buf[base + 5] as u64);
        w.write_str("pos");
        w.write_map_header(2);
        w.write_str("x");
        w.write_number(scratch.buf[base + 6]);
        w.write_str("y");
        w.write_number(scratch.buf[base + 7]);
        if has_target_z {
            w.write_str("z");
            w.write_number(scratch.buf[base + 8]);
        }
        if has_target_dim {
            w.write_str("dim");
            w.write_map_header(2);
            w.write_str("x");
            w.write_number(scratch.buf[base + 9]);
            w.write_str("y");
            w.write_number(scratch.buf[base + 10]);
        }
        if has_target_radius {
            w.write_str("radius");
            w.write_number(scratch.buf[base + 11]);
        }

        w.write_str("type");
        if type_is_heal {
            w.write_str("heal");
        } else {
            w.write_str("build");
        }
        w.write_str("intensity");
        w.write_number(scratch.buf[base + 12]);
        if has_speed {
            w.write_str("speed");
            w.write_number(scratch.buf[base + 13]);
        }
        if has_particle_radius {
            w.write_str("particleRadius");
            w.write_number(scratch.buf[base + 14]);
        }
        if has_ball_spawn_rate {
            w.write_str("ballSpawnRate");
            w.write_number(scratch.buf[base + 15]);
        }
    }
    w.buf.len() as u32
}

/// Close the envelope. Emits the post-projectiles optional keys in
/// stateSerializer.ts pool-insertion order: gameState, isDelta,
/// removedEntityIds, visibilityFiltered. Caller flags gate which
/// appear; map-header count in _begin must match.
#[wasm_bindgen]
pub fn snapshot_encode_envelope_continue(
    has_game_state: u8,
    game_state_phase_slot: u32,
    has_winner_id: u8,
    winner_id: u8,
    is_delta: u8,
    has_removed_entity_ids: u8,
    removed_entity_id_count: u32,
    has_visibility_filtered: u8,
    visibility_filtered: u8,
) -> u32 {
    let w = messagepack_writer();
    if has_game_state != 0 {
        w.write_str("gameState");
        let gs_field_count = if has_winner_id != 0 { 2 } else { 1 };
        w.write_map_header(gs_field_count);
        w.write_str("phase");
        write_string_from_scratch(w, game_state_phase_slot);
        if has_winner_id != 0 {
            w.write_str("winnerId");
            w.write_uint(winner_id as u64);
        }
    }
    w.write_str("isDelta");
    w.write_bool(is_delta != 0);
    if has_removed_entity_ids != 0 {
        let count = removed_entity_id_count as usize;
        let scratch = snapshot_encode_removed_ids_scratch();
        w.write_str("removedEntityIds");
        w.write_array_header(count);
        for i in 0..count {
            w.write_uint(scratch.buf[i] as u64);
        }
    }
    if has_visibility_filtered != 0 {
        w.write_str("visibilityFiltered");
        w.write_bool(visibility_filtered != 0);
    }
    w.buf.len() as u32
}

/// Append the shroud wrapper. Sits AFTER scanPulses in iteration
/// order — both lazily added to _snapshotBuf, scanPulses first then
/// shroud. The bitmap bytes come from the shroud scratch (caller
/// pre-fills + supplies byte length).
#[wasm_bindgen]
pub fn snapshot_encode_envelope_emit_shroud(
    grid_w: u32,
    grid_h: u32,
    cell_size: f64,
    bitmap_byte_count: u32,
) -> u32 {
    let w = messagepack_writer();
    let scratch = snapshot_encode_shroud_scratch();
    let n = bitmap_byte_count as usize;
    w.write_str("shroud");
    // Pool order from createShroudDto: gridW, gridH, cellSize, bitmap.
    w.write_map_header(4);
    w.write_str("gridW");
    w.write_uint(grid_w as u64);
    w.write_str("gridH");
    w.write_uint(grid_h as u64);
    w.write_str("cellSize");
    w.write_number(cell_size);
    w.write_str("bitmap");
    w.write_bin(&scratch.buf[0..n]);
    w.buf.len() as u32
}

/// Append compact `terrain: { v: 4, m, vc, vh, ti }` from raw
/// TerrainTileMap arrays already copied into number scratch. This
/// mirrors snapshotStaticWirePack.ts without running its large JS
/// packing loops on the Rust send path.
#[wasm_bindgen]
pub fn snapshot_encode_envelope_emit_packed_terrain(
    map_width: f64,
    map_height: f64,
    cell_size: f64,
    subdiv: f64,
    cells_x: f64,
    cells_y: f64,
    vertices_x: f64,
    vertices_y: f64,
    version: f64,
    mesh_vertex_coords_offset: u32,
    mesh_vertex_coords_count: u32,
    mesh_vertex_heights_offset: u32,
    mesh_vertex_heights_count: u32,
    mesh_triangle_indices_offset: u32,
    mesh_triangle_indices_count: u32,
) -> u32 {
    const PACKED_TERRAIN_VERSION: u64 = 4;
    const TERRAIN_TRIANGLE_INDICES_DELTA: f64 = 4.0;

    let w = messagepack_writer();
    w.write_str("terrain");
    w.write_map_header(5);

    w.write_str("v");
    w.write_uint(PACKED_TERRAIN_VERSION);

    w.write_str("m");
    w.write_array_header(10);
    w.write_number(map_width);
    w.write_number(map_height);
    w.write_number(cell_size);
    w.write_number(subdiv);
    w.write_number(cells_x);
    w.write_number(cells_y);
    w.write_number(vertices_x);
    w.write_number(vertices_y);
    w.write_number(version);
    w.write_number(TERRAIN_TRIANGLE_INDICES_DELTA);

    w.write_str("vc");
    write_number_scratch_float32_bin(w, mesh_vertex_coords_offset, mesh_vertex_coords_count);

    w.write_str("vh");
    write_number_scratch_float32_bin(w, mesh_vertex_heights_offset, mesh_vertex_heights_count);

    w.write_str("ti");
    write_triangle_index_delta_bin(w, mesh_triangle_indices_offset, mesh_triangle_indices_count);

    w.buf.len() as u32
}

/// Append the static `terrain` top-level snapshot key. Full keyframes
/// use this to ship the authoritative TerrainTileMap without falling
/// back to JS object MessagePack encoding.
#[wasm_bindgen]
pub fn snapshot_encode_envelope_emit_terrain(
    map_width: f64,
    map_height: f64,
    cell_size: f64,
    subdiv: f64,
    cells_x: f64,
    cells_y: f64,
    vertices_x: f64,
    vertices_y: f64,
    version: f64,
    mesh_vertex_coords_offset: u32,
    mesh_vertex_coords_count: u32,
    mesh_vertex_heights_offset: u32,
    mesh_vertex_heights_count: u32,
    mesh_triangle_indices_offset: u32,
    mesh_triangle_indices_count: u32,
    mesh_triangle_levels_offset: u32,
    mesh_triangle_levels_count: u32,
    mesh_triangle_neighbor_indices_offset: u32,
    mesh_triangle_neighbor_indices_count: u32,
    mesh_triangle_neighbor_levels_offset: u32,
    mesh_triangle_neighbor_levels_count: u32,
    mesh_cell_triangle_offsets_offset: u32,
    mesh_cell_triangle_offsets_count: u32,
    mesh_cell_triangle_indices_offset: u32,
    mesh_cell_triangle_indices_count: u32,
) -> u32 {
    let w = messagepack_writer();
    w.write_str("terrain");
    w.write_map_header(17);

    w.write_str("mapWidth");
    w.write_number(map_width);
    w.write_str("mapHeight");
    w.write_number(map_height);
    w.write_str("cellSize");
    w.write_number(cell_size);
    w.write_str("subdiv");
    w.write_number(subdiv);
    w.write_str("cellsX");
    w.write_number(cells_x);
    w.write_str("cellsY");
    w.write_number(cells_y);
    w.write_str("verticesX");
    w.write_number(vertices_x);
    w.write_str("verticesY");
    w.write_number(vertices_y);
    w.write_str("version");
    w.write_number(version);

    w.write_str("meshVertexCoords");
    write_number_array_from_scratch(w, mesh_vertex_coords_offset, mesh_vertex_coords_count);
    w.write_str("meshVertexHeights");
    write_number_array_from_scratch(w, mesh_vertex_heights_offset, mesh_vertex_heights_count);
    w.write_str("meshTriangleIndices");
    write_number_array_from_scratch(w, mesh_triangle_indices_offset, mesh_triangle_indices_count);
    w.write_str("meshTriangleLevels");
    write_number_array_from_scratch(w, mesh_triangle_levels_offset, mesh_triangle_levels_count);
    w.write_str("meshTriangleNeighborIndices");
    write_number_array_from_scratch(
        w,
        mesh_triangle_neighbor_indices_offset,
        mesh_triangle_neighbor_indices_count,
    );
    w.write_str("meshTriangleNeighborLevels");
    write_number_array_from_scratch(
        w,
        mesh_triangle_neighbor_levels_offset,
        mesh_triangle_neighbor_levels_count,
    );
    w.write_str("meshCellTriangleOffsets");
    write_number_array_from_scratch(
        w,
        mesh_cell_triangle_offsets_offset,
        mesh_cell_triangle_offsets_count,
    );
    w.write_str("meshCellTriangleIndices");
    write_number_array_from_scratch(
        w,
        mesh_cell_triangle_indices_offset,
        mesh_cell_triangle_indices_count,
    );

    w.buf.len() as u32
}

/// Append compact `buildability: { v: 1, m, k, r }` from raw
/// TerrainBuildabilityGrid flags/levels copied into number scratch.
#[wasm_bindgen]
pub fn snapshot_encode_envelope_emit_packed_buildability(
    map_width: f64,
    map_height: f64,
    cell_size: f64,
    cells_x: f64,
    cells_y: f64,
    version: f64,
    config_key_slot: u32,
    flags_offset: u32,
    flags_count: u32,
    levels_offset: u32,
    levels_count: u32,
) -> u32 {
    let w = messagepack_writer();
    w.write_str("buildability");
    w.write_map_header(4);

    w.write_str("v");
    w.write_uint(1);

    w.write_str("m");
    w.write_array_header(6);
    w.write_number(map_width);
    w.write_number(map_height);
    w.write_number(cell_size);
    w.write_number(cells_x);
    w.write_number(cells_y);
    w.write_number(version);

    w.write_str("k");
    write_string_from_scratch(w, config_key_slot);

    w.write_str("r");
    let count = (flags_count as usize).min(levels_count as usize);
    let flags_start = flags_offset as usize;
    let levels_start = levels_offset as usize;
    let run_count = buildability_run_count(flags_offset, flags_count, levels_offset, levels_count);
    w.write_array_header(run_count * 3);

    let mut i = 0usize;
    while i < count {
        let flag = number_scratch_i32(flags_start + i);
        let level = number_scratch_i32(levels_start + i);
        let mut run_length = 1usize;
        i += 1;
        while i < count
            && number_scratch_i32(flags_start + i) == flag
            && number_scratch_i32(levels_start + i) == level
        {
            run_length += 1;
            i += 1;
        }
        w.write_number(run_length as f64);
        w.write_number(flag as f64);
        w.write_number(level as f64);
    }

    w.buf.len() as u32
}

/// Append the static `buildability` top-level snapshot key. The
/// configKey string is read from string scratch; flags/levels are read
/// from the shared numeric scratch as JS-number arrays so MessagePack
/// integer/float selection stays byte-identical with @msgpack/msgpack.
#[wasm_bindgen]
pub fn snapshot_encode_envelope_emit_buildability(
    map_width: f64,
    map_height: f64,
    cell_size: f64,
    cells_x: f64,
    cells_y: f64,
    version: f64,
    config_key_slot: u32,
    flags_offset: u32,
    flags_count: u32,
    levels_offset: u32,
    levels_count: u32,
) -> u32 {
    let w = messagepack_writer();
    w.write_str("buildability");
    w.write_map_header(9);

    w.write_str("mapWidth");
    w.write_number(map_width);
    w.write_str("mapHeight");
    w.write_number(map_height);
    w.write_str("cellSize");
    w.write_number(cell_size);
    w.write_str("cellsX");
    w.write_number(cells_x);
    w.write_str("cellsY");
    w.write_number(cells_y);
    w.write_str("version");
    w.write_number(version);
    w.write_str("configKey");
    write_string_from_scratch(w, config_key_slot);
    w.write_str("flags");
    write_number_array_from_scratch(w, flags_offset, flags_count);
    w.write_str("levels");
    write_number_array_from_scratch(w, levels_offset, levels_count);

    w.buf.len() as u32
}

/// Write `value` in base-10 ASCII into the END of `buf`, return the
/// &str slice covering the digits. Avoids std::fmt allocation in WASM.
#[inline]
pub(crate) fn u32_to_decimal<'a>(buf: &'a mut [u8; 12], mut value: u32) -> &'a str {
    if value == 0 {
        buf[11] = b'0';
        return core::str::from_utf8(&buf[11..12]).unwrap();
    }
    let mut idx = 12;
    while value > 0 {
        idx -= 1;
        buf[idx] = b'0' + (value % 10) as u8;
        value /= 10;
    }
    core::str::from_utf8(&buf[idx..12]).unwrap()
}

/// Append the scanPulses array. Sits AFTER visibilityFiltered in
/// pool-insertion order because scanPulses is added to _snapshotBuf
/// (stateSerializer.ts) lazily on its first non-undefined assignment,
/// not in the static init — so its property slot lands at the end of
/// the iteration order. Reads `count` entries (6 f64 each) from the
/// scan-pulse scratch.
#[wasm_bindgen]
pub fn snapshot_encode_envelope_emit_scan_pulses(count: u32) -> u32 {
    let w = messagepack_writer();
    let n = count as usize;
    let scratch = snapshot_encode_scan_pulse_scratch();
    w.write_str("scanPulses");
    w.write_array_header(n);
    for i in 0..n {
        let base = i * SNAPSHOT_ENCODE_SCAN_PULSE_STRIDE;
        let player_id = scratch.buf[base] as u32;
        let x = scratch.buf[base + 1];
        let y = scratch.buf[base + 2];
        let z = scratch.buf[base + 3];
        let radius = scratch.buf[base + 4];
        let expires_at_tick = scratch.buf[base + 5] as u32;

        // Pool order from createScanPulseDto: playerId, x, y, z,
        // radius, expiresAtTick. All 6 fields always present.
        w.write_map_header(6);
        w.write_str("playerId");
        w.write_uint(player_id as u64);
        w.write_str("x");
        w.write_number(x);
        w.write_str("y");
        w.write_number(y);
        w.write_str("z");
        w.write_number(z);
        w.write_str("radius");
        w.write_number(radius);
        w.write_str("expiresAtTick");
        w.write_uint(expires_at_tick as u64);
    }
    w.buf.len() as u32
}

#[inline]
pub(crate) fn snapshot_encode_write_grid_cell_array(w: &mut MessagePackWriter, rows: &[f64], count: usize) {
    w.write_array_header(count);
    for i in 0..count {
        let base = i * SNAPSHOT_ENCODE_GRID_CELL_STRIDE;
        let x = rows[base];
        let y = rows[base + 1];
        let z = rows[base + 2];
        let players_mask = rows[base + 3] as u32;
        let player_count = players_mask.count_ones() as usize;

        w.write_map_header(2);
        w.write_str("cell");
        w.write_map_header(3);
        w.write_str("x");
        w.write_number(x);
        w.write_str("y");
        w.write_number(y);
        w.write_str("z");
        w.write_number(z);

        w.write_str("players");
        w.write_array_header(player_count);
        for player_id in 1..=31u32 {
            if (players_mask & (1 << (player_id - 1))) != 0 {
                w.write_uint(player_id as u64);
            }
        }
    }
}

/// Emit the spatial debug grid DTO shape from compact row scratch:
/// `grid: { cells, searchCells, cellSize }`.
#[wasm_bindgen]
pub fn snapshot_encode_envelope_emit_grid(
    cell_count: u32,
    search_cell_count: u32,
    cell_size: f64,
) -> u32 {
    let w = messagepack_writer();
    let scratch = snapshot_encode_grid_scratch();

    w.write_str("grid");
    w.write_map_header(3);
    w.write_str("cells");
    snapshot_encode_write_grid_cell_array(w, &scratch.cells, cell_count as usize);
    w.write_str("searchCells");
    snapshot_encode_write_grid_cell_array(w, &scratch.search_cells, search_cell_count as usize);
    w.write_str("cellSize");
    w.write_number(cell_size);

    w.buf.len() as u32
}

// Shared across all test modules: the combat-targeting pool is a process-global
// static, so every test that stamps or reads it must serialize on ONE lock
// regardless of which test module it lives in.
#[cfg(test)]
pub(crate) static COMBAT_TARGETING_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

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
    pub(crate) fn wind_sample_state_writes_deterministic_vector() {
        let mut a = [0.0; 4];
        let mut b = [0.0; 4];
        assert_eq!(wind_sample_state(12_345.0, &mut a), 1);
        assert_eq!(wind_sample_state(12_345.0, &mut b), 1);
        assert_eq!(a, b);
        assert!(a[2] >= WIND_SPEED_MIN);
        assert!(a[2] <= WIND_SPEED_MAX);

        let mut short = [0.0; 3];
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
        pool.turret_mount_x[near_idx] = -99.0;
        pool.turret_local_mount_x[near_idx] = 4.0;
        pool.turret_local_mount_y[near_idx] = 0.0;
        pool.turret_local_mount_z[near_idx] = 0.0;
        pool.turret_radius_hitbox[near_idx] = 1.25;
        let far_idx = combat_targeting_turret_global_idx(0, 1);
        pool.turret_mount_x[far_idx] = -99.0;
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
                &detonate_on_expiry,
                &has_payload,
                &direct_hit,
                &reflected,
                &hit_shield,
                &terminal_reflector,
                &water,
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
                &detonate_on_expiry,
                &has_payload,
                &zero,
                &zero,
                &zero,
                &zero,
                &water,
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
                &detonate_on_expiry,
                &has_payload,
                &zero,
                &zero,
                &zero,
                &zero,
                &water,
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
                &water,
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
        let mut sync_ids = [0_i32; 2];
        let mut stats = [99_u32; 3];
        assert_eq!(
            pool_prepare_dynamic_step(
                &slots,
                &mut awake_slots,
                &mut sync_ids,
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
        assert_eq!(sync_ids, [101, 202]);

        let mut collected = [0_i32; 2];
        assert_eq!(pool_collect_awake_entity_ids(&slots, &mut collected), 2);
        assert_eq!(collected, [101, 202]);

        {
            let p = pool();
            let boundary = boundary_slot as usize;
            assert_eq!(p.flags[boundary] & BODY_FLAG_SLEEPING, 0);
            assert!(p.accel_x[boundary] > 0.0);
            assert_eq!(p.sleep_ticks[boundary], 0.0);
        }

        let mut final_sync = [0_i32; 2];
        assert_eq!(pool_finalize_dynamic_step(&slots, &mut final_sync), 2);
        assert_eq!(final_sync, [101, 202]);
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
    pub(crate) fn turret_rotation_batch_wraps_yaw_and_clamps_pitch() {
        let current_yaw = [3.10];
        let yaw_velocity = [0.0];
        let target_yaw = [-3.10];
        let current_pitch = [2.0];
        let pitch_velocity = [8.0];
        let target_pitch = [2.0];
        let turn_accel = [64.0];
        let drag = [0.0];
        let mut out_yaw = [0.0];
        let mut out_yaw_velocity = [0.0];
        let mut out_yaw_acceleration = [0.0];
        let mut out_pitch = [0.0];
        let mut out_pitch_velocity = [0.0];
        let mut out_pitch_acceleration = [0.0];
        let mut out_aim_error_yaw = [0.0];
        let mut out_aim_error_pitch = [0.0];
        let pitch_min = -core::f64::consts::PI / 2.0;
        let pitch_max = core::f64::consts::PI / 2.0;

        assert_eq!(
            turret_rotation_step_batch(
                &current_yaw,
                &yaw_velocity,
                &target_yaw,
                &current_pitch,
                &pitch_velocity,
                &target_pitch,
                &turn_accel,
                &drag,
                &mut out_yaw,
                &mut out_yaw_velocity,
                &mut out_yaw_acceleration,
                &mut out_pitch,
                &mut out_pitch_velocity,
                &mut out_pitch_acceleration,
                &mut out_aim_error_yaw,
                &mut out_aim_error_pitch,
                1,
                1.0 / 30.0,
                pitch_min,
                pitch_max,
            ),
            1,
        );

        assert!(out_yaw[0].is_finite());
        assert!(out_aim_error_yaw[0].abs() < 0.09);
        assert_eq!(out_pitch[0], pitch_max);
        assert_eq!(out_pitch_velocity[0], 0.0);
        assert_eq!(out_pitch_acceleration[0], 0.0);
        assert!((out_aim_error_pitch[0] - (target_pitch[0] - pitch_max)).abs() < 1e-12);
    }

    #[test]
    pub(crate) fn turret_rotation_batch_preserves_sub_one_turn_accel() {
        let current_yaw = [0.0];
        let yaw_velocity = [0.0];
        let target_yaw = [1.0];
        let current_pitch = [0.0];
        let pitch_velocity = [0.0];
        let target_pitch = [0.0];
        let drag = [0.0];
        let mut low_out_yaw = [0.0];
        let mut low_out_yaw_velocity = [0.0];
        let mut low_out_yaw_acceleration = [0.0];
        let mut low_out_pitch = [0.0];
        let mut low_out_pitch_velocity = [0.0];
        let mut low_out_pitch_acceleration = [0.0];
        let mut low_out_aim_error_yaw = [0.0];
        let mut low_out_aim_error_pitch = [0.0];
        let mut one_out_yaw = [0.0];
        let mut one_out_yaw_velocity = [0.0];
        let mut one_out_yaw_acceleration = [0.0];
        let mut one_out_pitch = [0.0];
        let mut one_out_pitch_velocity = [0.0];
        let mut one_out_pitch_acceleration = [0.0];
        let mut one_out_aim_error_yaw = [0.0];
        let mut one_out_aim_error_pitch = [0.0];
        let pitch_min = -core::f64::consts::PI / 2.0;
        let pitch_max = core::f64::consts::PI / 2.0;

        assert_eq!(
            turret_rotation_step_batch(
                &current_yaw,
                &yaw_velocity,
                &target_yaw,
                &current_pitch,
                &pitch_velocity,
                &target_pitch,
                &[0.1],
                &drag,
                &mut low_out_yaw,
                &mut low_out_yaw_velocity,
                &mut low_out_yaw_acceleration,
                &mut low_out_pitch,
                &mut low_out_pitch_velocity,
                &mut low_out_pitch_acceleration,
                &mut low_out_aim_error_yaw,
                &mut low_out_aim_error_pitch,
                1,
                1.0 / 30.0,
                pitch_min,
                pitch_max,
            ),
            1,
        );
        assert_eq!(
            turret_rotation_step_batch(
                &current_yaw,
                &yaw_velocity,
                &target_yaw,
                &current_pitch,
                &pitch_velocity,
                &target_pitch,
                &[1.0],
                &drag,
                &mut one_out_yaw,
                &mut one_out_yaw_velocity,
                &mut one_out_yaw_acceleration,
                &mut one_out_pitch,
                &mut one_out_pitch_velocity,
                &mut one_out_pitch_acceleration,
                &mut one_out_aim_error_yaw,
                &mut one_out_aim_error_pitch,
                1,
                1.0 / 30.0,
                pitch_min,
                pitch_max,
            ),
            1,
        );

        assert!(low_out_yaw[0] > 0.0);
        assert!(one_out_yaw[0] > low_out_yaw[0] * 5.0);
        assert!(one_out_yaw_velocity[0] > low_out_yaw_velocity[0] * 5.0);
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
        let mut damage_delay = [200.0, 0.0, 0.0, 250.0, 0.0];
        let mut reopen_delay = [0.0, 0.0, 200.0, 400.0, 700.0];
        let mut changed = [0; 5];

        assert_eq!(
            building_active_state_step_batch(
                &mut open,
                &active,
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
    pub(crate) fn pathfinder_building_roof_cells_are_walkable() {
        let _guard = lock_tests();
        terrain_clear();
        pathfinder_init(400.0, 400.0);

        // Factory-spawned units can begin on the factory's occupied
        // footprint. The footprint is a valid roof/support cell, not
        // a blocker that should force an origin-side escape point.
        let building_cells = [10_u32, 10_u32];
        pathfinder_rebuild_mask_and_cc(&building_cells, 10_001, 20_001, 30_001);
        let count = pathfinder_find_path(210.0, 210.0, 320.0, 210.0, 0.0, false);
        assert_eq!(count, 1);

        let waypoints =
            unsafe { std::slice::from_raw_parts(pathfinder_waypoints_ptr(), (count as usize) * 2) };
        assert!((waypoints[0] - 320.0).abs() < 1.0e-9);
        assert!((waypoints[1] - 210.0).abs() < 1.0e-9);
    }

    #[test]
    pub(crate) fn pathfinder_building_roof_overrides_blocked_terrain_below() {
        let _guard = lock_tests();
        terrain_clear();
        pathfinder_init(400.0, 400.0);

        // Terrain inflation blocks edge cells, but a building top at
        // that XY is still valid terrain for movement: units standing
        // there can always move/fall down from it.
        let building_cells = [1_u32, 10_u32];
        pathfinder_rebuild_mask_and_cc(&building_cells, 10_002, 20_002, 30_002);
        let count = pathfinder_find_path(30.0, 210.0, 80.0, 210.0, 0.0, false);
        assert_eq!(count, 1);

        let waypoints =
            unsafe { std::slice::from_raw_parts(pathfinder_waypoints_ptr(), (count as usize) * 2) };
        assert!((waypoints[0] - 80.0).abs() < 1.0e-9);
        assert!((waypoints[1] - 210.0).abs() < 1.0e-9);
    }

    #[test]
    pub(crate) fn pathfinder_ground_units_do_not_climb_onto_roofs() {
        let _guard = lock_tests();
        terrain_clear();
        pathfinder_init(400.0, 400.0);

        let building_cells = [1_u32, 10_u32];
        pathfinder_rebuild_mask_and_cc(&building_cells, 10_003, 20_003, 30_003);
        let count = pathfinder_find_path(80.0, 210.0, 30.0, 210.0, 0.0, false);
        assert_eq!(count, 1);

        let waypoints =
            unsafe { std::slice::from_raw_parts(pathfinder_waypoints_ptr(), (count as usize) * 2) };
        assert!((waypoints[0] - 50.0).abs() < 1.0e-9);
        assert!((waypoints[1] - 210.0).abs() < 1.0e-9);
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
        assert!((progress[2] - 0.525).abs() < 1.0e-9);
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
        assert!((build_progress[0] - 0.525).abs() < 1e-12);
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
        assert!((hp[1] - 15.0).abs() < 1e-12);
        assert_eq!(hp[2], 5.0);
        assert_eq!(progress[0], 1.0);
        assert_eq!(progress[1], 0.75);
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
    pub(crate) fn economy_converter_transfer_picks_richer_pool_and_caps_by_output_headroom() {
        let mut out = [0.0; 4];

        assert_eq!(
            economy_compute_converter_transfer(10.0, 100.0, 80.0, 100.0, 25.0, 1.0, 0.2, &mut out),
            1
        );
        assert!((out[0] - 25.0).abs() < 1e-12);
        assert!((out[1] - 20.0).abs() < 1e-12);
        assert_eq!(out[2], ECONOMY_RESOURCE_METAL_CODE as f64);
        assert_eq!(out[3], ECONOMY_RESOURCE_ENERGY_CODE as f64);

        assert_eq!(
            economy_compute_converter_transfer(80.0, 100.0, 10.0, 25.0, 50.0, 1.0, 0.5, &mut out),
            1
        );
        assert!((out[0] - 30.0).abs() < 1e-12);
        assert!((out[1] - 15.0).abs() < 1e-12);
        assert_eq!(out[2], ECONOMY_RESOURCE_ENERGY_CODE as f64);
        assert_eq!(out[3], ECONOMY_RESOURCE_METAL_CODE as f64);

        assert_eq!(
            economy_compute_converter_transfer(50.0, 100.0, 50.0, 100.0, 25.0, 1.0, 0.2, &mut out),
            1
        );
        assert_eq!(
            out,
            [
                0.0,
                0.0,
                ECONOMY_RESOURCE_NONE_CODE as f64,
                ECONOMY_RESOURCE_NONE_CODE as f64,
            ]
        );

        let mut short = [0.0; 3];
        assert_eq!(
            economy_compute_converter_transfer(
                10.0, 100.0, 80.0, 100.0, 25.0, 1.0, 0.2, &mut short
            ),
            0
        );
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

        assert_eq!(
            economy_apply_converter_transfers(
                &players,
                &rates,
                5,
                1.0,
                0.2,
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

        assert_eq!(energy_curr, [0.0, 40.0, 50.0]);
        assert_eq!(metal_curr, [0.0, 50.0, 30.0]);
        assert_eq!(out_consumed, [10.0, 30.0, 50.0, 10.0, 0.0]);
        assert_eq!(out_output, [8.0, 24.0, 40.0, 8.0, 0.0]);
        assert_eq!(
            out_consumed_resource,
            [
                ECONOMY_RESOURCE_ENERGY_CODE,
                ECONOMY_RESOURCE_ENERGY_CODE,
                ECONOMY_RESOURCE_METAL_CODE,
                ECONOMY_RESOURCE_ENERGY_CODE,
                ECONOMY_RESOURCE_NONE_CODE,
            ]
        );
        assert_eq!(
            out_output_resource,
            [
                ECONOMY_RESOURCE_METAL_CODE,
                ECONOMY_RESOURCE_METAL_CODE,
                ECONOMY_RESOURCE_ENERGY_CODE,
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

    #[test]
    pub(crate) fn terrain_adaptive_mesh_build_is_deterministic_and_conforming() {
        // 22-value generation slice: circular island, 2 teams, ripple + ridge
        // so the LOD walk actually varies triangle sizes.
        let terrain_config = [
            40.0,    // center_magnitude
            30.0,    // dividers_magnitude
            0.0,     // terrain_d_terrain (plateau off)
            1.0,     // map_shape_circle
            2.0,     // team_count
            -1200.0, // tile_floor_y
            0.49,    // circle_edge_fraction
            0.1,     // circle_transition_width_fraction
            0.04,    // generation_edge_transition_width_fraction
            0.99,    // plateau_shelf_fraction_of_step
            0.0,     // plateau_ramp_edge_sharpness
            0.4,     // ripple_radius_fraction
            1.7,     // ripple_phase
            700.0, 0.9, // ripple component 0 wavelength/magnitude
            600.0, 0.0, // ripple component 1
            600.0, 0.0, // ripple component 2
            0.1, 0.4, 0.08, // ridge inner/outer/half-width fractions
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
        let neighbor_idx_start = levels_start + t;
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
        // Every cell-triangle ref points at a real triangle.
        for k in 0..refs {
            let tri = a[cell_idx_start + k] as i64;
            assert!(tri >= 0 && (tri as usize) < t, "cell triangle ref in range");
        }
    }

    #[test]
    pub(crate) fn blueprint_manifest_includes_authored_tables() {
        assert!(blueprint_tables::BLUEPRINT_UNITS_COUNT > 0);
        assert!(blueprint_tables::BLUEPRINT_BUILDINGS_COUNT > 0);
        assert!(blueprint_tables::BLUEPRINT_TOWERS_COUNT > 0);
        assert!(blueprint_tables::BLUEPRINT_TURRETS_COUNT > 0);
        assert!(blueprint_tables::BLUEPRINT_SHOTS_COUNT > 0);
        assert!(blueprint_tables::BLUEPRINT_PATHFINDING_COUNT > 0);
        assert!(blueprint_tables::BLUEPRINT_BUILDABLE_UNIT_COUNT > 0);
        assert!(blueprint_tables::BLUEPRINT_UNIT_IDS.contains(&"unitJackal"));
        assert!(blueprint_tables::BLUEPRINT_BUILDING_IDS.contains(&"buildingSolar"));
        assert!(blueprint_tables::BLUEPRINT_TOWER_IDS.contains(&"towerFabricator"));
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
            10.0,
            100.0,
            1.0,
            100.0,
            0,
            1.0 / 30.0,
            8.0,
            150_000.0,
            50.0,
            20.0,
            0.22,
            0.001,
        );
        assert_eq!(active, 1);
        assert!((x - 0.6).abs() < 1e-12);
        assert!((y - 0.8).abs() < 1e-12);
    }

    #[test]
    pub(crate) fn final_waypoints_brake_against_current_velocity() {
        let (x, y, active) = compute_arrival_control_thrust(
            10.0,
            0.0,
            10.0,
            20.0,
            0.0,
            10.0,
            100.0,
            1.0,
            100.0,
            ARRIVAL_FLAG_LAST_ACTION,
            1.0 / 30.0,
            8.0,
            150_000.0,
            50.0,
            20.0,
            0.22,
            0.001,
        );
        assert_eq!(active, 1);
        assert!(x < 0.0, "arrival should thrust opposite overshoot velocity");
        assert!(y.abs() < 1e-12);
    }

    #[test]
    pub(crate) fn flying_final_waypoints_use_velocity_aware_arrival() {
        let legacy_flying_flag = 1 << 0;
        let (x, y, active) = compute_arrival_control_thrust(
            10.0,
            0.0,
            10.0,
            20.0,
            0.0,
            10.0,
            100.0,
            1.0,
            100.0,
            legacy_flying_flag | ARRIVAL_FLAG_LAST_ACTION,
            1.0 / 30.0,
            8.0,
            150_000.0,
            50.0,
            20.0,
            0.22,
            0.001,
        );
        assert_eq!(active, 1);
        assert!(
            x < 0.0,
            "flying arrival should brake against overshoot velocity"
        );
        assert!(y.abs() < 1e-12);
    }

    #[test]
    pub(crate) fn arrival_completion_distinguishes_intermediate_and_final_stops() {
        let (_distance, arrived) =
            compute_arrival_completion(10.0, 0.0, 100.0, 0.0, 0, 30.0, 15.0, 10.0);
        assert_eq!(arrived, 1, "intermediate waypoint ignores stop speed");

        let (_distance, arrived) = compute_arrival_completion(
            10.0,
            0.0,
            100.0,
            0.0,
            ARRIVAL_FLAG_LAST_ACTION,
            30.0,
            15.0,
            10.0,
        );
        assert_eq!(arrived, 0, "ground final waypoint waits for braking");

        let (_distance, arrived) = compute_arrival_completion(
            10.0,
            0.0,
            100.0,
            0.0,
            ARRIVAL_FLAG_LAST_ACTION | ARRIVAL_COMPLETION_FLAG_FLYING,
            30.0,
            15.0,
            10.0,
        );
        assert_eq!(
            arrived, 1,
            "flying final waypoint keeps legacy immediate completion"
        );
    }

    #[test]
    pub(crate) fn flying_loiter_chooses_turn_sign_from_velocity() {
        let (x, y, turn_sign, active) = compute_flying_loiter_thrust(
            0.0, 100.0, 100.0, 0.0, 1.0, 0.0, 10.0, 0.0, 80.0, 8.0, 0.65,
        );
        assert_eq!(active, 1);
        assert_eq!(turn_sign, -1.0);
        assert!(x > 0.0, "negative orbit should steer right of the center");
        assert!(y > 0.0, "loiter should still correct outward radius error");
    }

    #[test]
    pub(crate) fn flying_loiter_preserves_existing_turn_sign() {
        let (_x, y, turn_sign, active) = compute_flying_loiter_thrust(
            100.0, 0.0, 100.0, 0.0, 100.0, 0.0, 10.0, 1.0, 80.0, 8.0, 0.65,
        );
        assert_eq!(active, 1);
        assert_eq!(turn_sign, 1.0);
        assert!(y > 0.0, "existing positive orbit should win over velocity");
    }

    #[test]
    pub(crate) fn stuck_replan_step_resets_when_body_is_moving() {
        let (ticks, should_replan) =
            compute_stuck_replan_step(5.0, 0.0, 31, 100.0, 0.0, 0, 5.0, 30, 30.0);
        assert_eq!(ticks, 0);
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

    #[test]
    pub(crate) fn client_prediction_batch_matches_inline_motion_step() {
        let dt = 1.0 / 60.0;
        let mut expected = [10.0, 20.0, 8.0, 30.0, -10.0, 2.0];
        integrate_unit_motion_inline(
            &mut expected,
            dt,
            3.0,
            0.0,
            0.0,
            0.0,
            0.98,
            0.85,
            0.0,
            0.0,
            0.0,
            4.0,
            0.0,
            0.0,
            1.0,
        );

        let mut motions = vec![10.0, 20.0, 8.0, 30.0, -10.0, 2.0];
        let ground_offsets = vec![3.0];
        let ground_z = vec![4.0];
        let ground_normals = vec![0.0, 0.0, 1.0];
        client_predict_unit_motion_batch(
            1,
            &mut motions,
            &ground_offsets,
            &ground_z,
            &ground_normals,
            dt,
            0.98,
            0.85,
            0.1,
            0.0001,
        );

        for i in 0..6 {
            assert!((motions[i] - expected[i]).abs() < 1e-12);
        }
    }

    #[test]
    pub(crate) fn client_prediction_batch_snaps_settled_ground_contacts() {
        let mut motions = vec![0.0, 0.0, 1.0005, 0.001, 0.0, 0.0];
        let ground_offsets = vec![1.0];
        let ground_z = vec![0.0];
        let ground_normals = vec![0.0, 0.0, 1.0];
        client_predict_unit_motion_batch(
            1,
            &mut motions,
            &ground_offsets,
            &ground_z,
            &ground_normals,
            1.0 / 60.0,
            0.98,
            0.85,
            0.1,
            0.0001,
        );

        assert_eq!(motions, vec![0.0, 0.0, 1.0, 0.0, 0.0, 0.0]);
    }

    #[test]
    pub(crate) fn snapshot_baseline_capacity_repairs_lagging_columns() {
        let mut baseline = SnapshotBaseline::new();
        baseline.ensure_capacity(20);

        baseline.build_progress.truncate(20);
        baseline.solar_open.truncate(20);
        baseline
            .turret_rots
            .truncate(20 * (SNAPSHOT_BASELINE_MAX_TURRETS_PER_ENTITY as usize));

        baseline.ensure_capacity(20);

        assert_eq!(baseline.used.len(), 21);
        assert_eq!(baseline.build_progress.len(), 21);
        assert_eq!(baseline.solar_open.len(), 21);
        assert_eq!(
            baseline.turret_rots.len(),
            21 * (SNAPSHOT_BASELINE_MAX_TURRETS_PER_ENTITY as usize),
        );
    }
}

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
        flags: u16,
        dps: f32,
        blueprint_code: u8,
        relationship_mask: u8,
        family_mask: u8,
        building_mask: u32,
        unit_mask: u32,
        turret_mask: u32,
        shot_mask: u32,
        reciprocal_mode: u8,
    }

    impl Default for TurretSpec {
        fn default() -> Self {
            Self {
                state: CT_TURRET_STATE_IDLE,
                target_id: -1,
                flags: CT_TURRET_CFG_HOST_DIRECTED,
                dps: 10.0,
                blueprint_code: TURRET_CODE_A,
                relationship_mask: REL_ALL,
                family_mask: FAM_ALL,
                building_mask: 0,
                unit_mask: 0,
                turret_mask: 0,
                shot_mask: 0,
                reciprocal_mode: CT_LOCK_ON_RECIPROCAL_IGNORE,
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
        entity_meta_init(64);
        combat_targeting_init(64);
        shield_pool_clear();
        terrain_clear();
    }

    #[test]
    pub(crate) fn entity_meta_registry_generation_guards_storage_reuse() {
        let _guard = lock_tests();
        entity_meta_init(8);

        let gen_a = entity_meta_register(
            10,
            ENTITY_META_KIND_UNIT,
            ENTITY_META_BLUEPRINT_KIND_UNIT,
            3,
            1,
            ENTITY_META_NO_ID,
            ENTITY_META_NO_ID,
            10,
            ENTITY_META_NO_INDEX,
            ENTITY_META_STORAGE_ENTITIES,
            2,
            1,
        );
        assert!(gen_a > 0);
        assert!(entity_meta_resolve_row(10, gen_a) >= 0);
        assert_eq!(entity_meta_resolve_storage_slot(10, gen_a), 2);

        entity_meta_unregister(10);
        assert_eq!(entity_meta_resolve_row(10, gen_a), -1);

        let gen_b = entity_meta_register(
            11,
            ENTITY_META_KIND_UNIT,
            ENTITY_META_BLUEPRINT_KIND_UNIT,
            4,
            1,
            ENTITY_META_NO_ID,
            ENTITY_META_NO_ID,
            11,
            ENTITY_META_NO_INDEX,
            ENTITY_META_STORAGE_ENTITIES,
            2,
            1,
        );
        assert!(gen_b > gen_a);
        assert_eq!(entity_meta_resolve_row(10, gen_a), -1);
        assert_eq!(entity_meta_resolve_storage_slot(11, gen_a), -1);
        assert_eq!(entity_meta_resolve_storage_slot(11, gen_b), 2);
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
            0.0,
            200.0,
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

    pub(crate) fn stamp_source(priority_target_id: i32) {
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

    pub(crate) fn stamp_turret(entity_slot: u32, turret_idx: u32, spec: TurretSpec) {
        let range = 120.0;
        let (parent_id, parent_z) = {
            let pool = combat_targeting_pool();
            let s = entity_slot as usize;
            if s < pool.entity_id.len() {
                (pool.entity_id[s], pool.entity_pos_z[s])
            } else {
                (ENTITY_META_NO_ID, 0.0)
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
            spec.flags,
            spec.dps,
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

    pub(crate) fn run_schedule_tick(turret_shield_panels_enabled: u8) -> (i32, u8, u8) {
        combat_targeting_rebuild_observation_masks();
        let source_slots = [SOURCE_SLOT];
        let mut cached_fire_ranks = [0u8; MAX];
        let mut cached_fire_dist_sqs = [0.0f64; MAX];
        let mut out_had_cooldown = [0u8; 1];
        let mut out_modes = [CT_TARGETING_TICK_MODE_SKIP; 1];
        let mut out_has_active_work = [0u8; 1];
        combat_targeting_schedule_and_tick_batch(
            &source_slots,
            10,
            16.0,
            turret_shield_panels_enabled,
            1,
            0,
            10.0,
            0.0,
            9.81,
            2,
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
                flags: CT_TURRET_CFG_HOST_DIRECTED | CT_TURRET_CFG_PASSIVE,
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
            1.0,
            10.0,
            0.0,
            0.0,
            10.0,
            0.0,
            1.0,
            5.0,
            SHIELD_FIELD_SHAPE_SPHERE,
            SHIELD_REFLECTION_MODE_BOTH,
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

    pub(crate) fn stamp_body_target(slot: u32, entity_id: i32, owner: u8, x: f64, family: u8, code: u8) {
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
    pub(crate) fn combat_halt_any_engaged_uses_priority_point_and_skips_visual_turrets() {
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
        combat_targeting_halt_decision_batch(&slots, &modes, &[0], &mut out);
        assert_eq!(
            out[0], 0,
            "engaged priority-point turret needs an active point"
        );
        combat_targeting_halt_decision_batch(&slots, &modes, &[1], &mut out);
        assert_eq!(out[0], 1);

        reset_pools();
        stamp_source(-1);
        stamp_turret(
            SOURCE_SLOT,
            0,
            TurretSpec {
                state: CT_TURRET_STATE_ENGAGED,
                target_id: 201,
                flags: CT_TURRET_CFG_HOST_DIRECTED | CT_TURRET_CFG_VISUAL_ONLY,
                ..TurretSpec::default()
            },
        );
        combat_targeting_halt_decision_batch(&slots, &modes, &[0], &mut out);
        assert_eq!(out[0], 0, "visual-only turrets must not halt movement");
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
                flags: CT_TURRET_CFG_HOST_DIRECTED,
                ..TurretSpec::default()
            },
        );

        let slots = [SOURCE_SLOT];
        let modes = [CT_COMBAT_HALT_MODE_FIGHT_REQUIRED];
        let mut out = [0u8];
        combat_targeting_halt_decision_batch(&slots, &modes, &[0], &mut out);
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
        combat_targeting_halt_decision_batch(&slots, &modes, &[0], &mut out);
        assert_eq!(
            out[0], 1,
            "host-directed turrets do not matter unless their mount is marked required"
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
                flags: CT_TURRET_CFG_HOST_DIRECTED | CT_TURRET_CFG_RANGE_BOTTOM_UNBOUNDED,
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
                flags: CT_TURRET_CFG_HOST_DIRECTED | CT_TURRET_CFG_RANGE_BOTTOM_UNBOUNDED,
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
                flags: CT_TURRET_CFG_HOST_DIRECTED
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
    pub(crate) fn sphere_turret_range_rejects_targets_inside_cylinder_but_outside_sphere() {
        let _guard = lock_tests();
        reset_pools();
        stamp_source(-1);
        stamp_turret(
            SOURCE_SLOT,
            0,
            TurretSpec {
                flags: CT_TURRET_CFG_HOST_DIRECTED | CT_TURRET_CFG_RANGE_SPHERE,
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
    pub(crate) fn priority_target_overwrites_host_directed_but_not_fully_autonomous() {
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
            "fully-autonomous turret must keep its independent lock"
        );
        assert_ne!(autonomous.1, CT_TURRET_STATE_IDLE);

        let host_directed = read_turret_lock(1);
        assert_eq!(
            host_directed.0, 201,
            "host-directed turret must inherit the host priority target"
        );
        assert_ne!(host_directed.1, CT_TURRET_STATE_IDLE);
    }
}

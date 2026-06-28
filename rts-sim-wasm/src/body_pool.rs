// body_pool — extracted from lib.rs (pure code motion).

#[allow(unused_imports)]
use crate::*;
#[allow(unused_imports)]
use wasm_bindgen::prelude::*;

// ─────────────────────────────────────────────────────────────────
//  Phase 3d — Body3D SoA pool in WASM linear memory
//
//  Foundational data structure for the bespoke physics engine. All
//  per-body state lives here as parallel SoA arrays; JS gets
//  Float64Array / Uint8Array views over linear memory and reads/
//  writes body fields by slot index. Future phases route every
//  Rust kernel directly through these arrays — eliminating per-
//  tick marshalling between JS Body3D structs and Rust scratch
//  buffers (Phase 3a's _integrateBatchBuf, Phase 3c's
//  _sphereSphereBatchBuf). Slot indices are STABLE for the body's
//  lifetime — they're handed back to JS at create time and used
//  for every subsequent operation.
//
//  Capacity is fixed at POOL_CAPACITY at init time. Vecs never
//  reallocate, so the typed-array views JS holds remain valid
//  forever (no per-tick view refresh). Sized for the current scale
//  target: 5k active units plus commanders, buildings, and headroom
//  for short-lived bodies during stress captures.
//
//  Free-slot management: a free-list Vec drains last-allocated
//  first. `next_unused_slot` tracks the high-water mark for the
//  initial allocation walk before any body is removed.
//
//  Field set chosen to cover Body3D in PhysicsEngine3D.ts. Cold
//  fields (label string, EntityId, shape category) stay JS-side —
//  Rust doesn't need them and crossing them across the boundary
//  every step would waste cycles.
// ─────────────────────────────────────────────────────────────────

pub const POOL_CAPACITY: u32 = 8192;
pub(crate) const POOL_CAPACITY_USIZE: usize = POOL_CAPACITY as usize;

// Bit positions inside the per-body `flags: Vec<u8>`. Mirrors the
// JS-side BODY_FLAG_* constants in src/game/server/Body3DPool.ts.
pub const BODY_FLAG_SLEEPING: u8 = 1 << 0;
pub const BODY_FLAG_IS_STATIC: u8 = 1 << 1;
pub const BODY_FLAG_UPWARD_CONTACT: u8 = 1 << 2;
pub const BODY_FLAG_SHAPE_CUBOID: u8 = 1 << 3;
pub const BODY_FLAG_OCCUPIED: u8 = 1 << 4;

pub(crate) struct BodyPool {
    // Position + velocity + per-step accumulator. The hot integrator
    // path mutates these every tick.
    pub(crate) pos_x: Vec<f64>,
    pub(crate) pos_y: Vec<f64>,
    pub(crate) pos_z: Vec<f64>,
    pub(crate) vel_x: Vec<f64>,
    pub(crate) vel_y: Vec<f64>,
    pub(crate) vel_z: Vec<f64>,
    pub(crate) accel_x: Vec<f64>,
    pub(crate) accel_y: Vec<f64>,
    pub(crate) accel_z: Vec<f64>,
    pub(crate) launch_x: Vec<f64>,
    pub(crate) launch_y: Vec<f64>,
    pub(crate) launch_z: Vec<f64>,
    pub(crate) surface_normal_x: Vec<f64>,
    pub(crate) surface_normal_y: Vec<f64>,
    pub(crate) surface_normal_z: Vec<f64>,

    // Geometry / mass — set at body creation, rarely changed after.
    pub(crate) radius: Vec<f64>,
    pub(crate) half_x: Vec<f64>,
    pub(crate) half_y: Vec<f64>,
    pub(crate) half_z: Vec<f64>,
    pub(crate) inv_mass: Vec<f64>,
    pub(crate) restitution: Vec<f64>,
    pub(crate) ground_offset: Vec<f64>,
    // Per-body wind-relative air drag coefficient. Dynamic units author
    // airFrictionPer60HzFrame, then JS converts that value plus mass into
    // this coefficient before allocation. 0.0 = no wind/air coupling.
    pub(crate) air_drag_coefficient: Vec<f64>,
    // Per-body ground-friction multiplier. 1.0 = the full global
    // ground-contact tangential damping; 0.0 = frictionless (keeps all
    // tangential velocity on contact). Default 1.0 so every body that
    // doesn't opt out behaves exactly as before.
    pub(crate) ground_friction_scale: Vec<f64>,

    // Sleep state. `sleep_ticks` is f64 to match the JS side's
    // numeric counter and sit on a single ptr export.
    pub(crate) sleep_ticks: Vec<f64>,

    // Bitfield: see BODY_FLAG_* constants.
    pub(crate) flags: Vec<u8>,

    // Owning simulation entity ID for dynamic unit bodies. `-1`
    // means the slot is static, free, or not associated with an
    // entity that participates in snapshot dirtying.
    pub(crate) entity_id: Vec<i32>,

    // Free-list + high-water mark for slot allocation.
    pub(crate) free_slots: Vec<u32>,
    pub(crate) next_unused_slot: u32,
}

impl BodyPool {
    pub(crate) fn new() -> Self {
        let cap = POOL_CAPACITY_USIZE;
        Self {
            pos_x: vec![0.0; cap],
            pos_y: vec![0.0; cap],
            pos_z: vec![0.0; cap],
            vel_x: vec![0.0; cap],
            vel_y: vec![0.0; cap],
            vel_z: vec![0.0; cap],
            accel_x: vec![0.0; cap],
            accel_y: vec![0.0; cap],
            accel_z: vec![0.0; cap],
            launch_x: vec![0.0; cap],
            launch_y: vec![0.0; cap],
            launch_z: vec![0.0; cap],
            surface_normal_x: vec![0.0; cap],
            surface_normal_y: vec![0.0; cap],
            surface_normal_z: vec![1.0; cap],
            radius: vec![0.0; cap],
            half_x: vec![0.0; cap],
            half_y: vec![0.0; cap],
            half_z: vec![0.0; cap],
            inv_mass: vec![0.0; cap],
            restitution: vec![0.0; cap],
            ground_offset: vec![0.0; cap],
            air_drag_coefficient: vec![0.0; cap],
            ground_friction_scale: vec![1.0; cap],
            sleep_ticks: vec![0.0; cap],
            flags: vec![0u8; cap],
            entity_id: vec![-1; cap],
            free_slots: Vec::with_capacity(64),
            next_unused_slot: 0,
        }
    }

    pub(crate) fn alloc_slot(&mut self) -> u32 {
        let slot = if let Some(s) = self.free_slots.pop() {
            s
        } else {
            let s = self.next_unused_slot;
            self.next_unused_slot += 1;
            s
        };
        debug_assert!(
            (slot as usize) < POOL_CAPACITY_USIZE,
            "BodyPool exhausted (capacity {})",
            POOL_CAPACITY_USIZE
        );
        // Zero the slot in case it's being reused.
        let i = slot as usize;
        self.pos_x[i] = 0.0;
        self.pos_y[i] = 0.0;
        self.pos_z[i] = 0.0;
        self.vel_x[i] = 0.0;
        self.vel_y[i] = 0.0;
        self.vel_z[i] = 0.0;
        self.accel_x[i] = 0.0;
        self.accel_y[i] = 0.0;
        self.accel_z[i] = 0.0;
        self.launch_x[i] = 0.0;
        self.launch_y[i] = 0.0;
        self.launch_z[i] = 0.0;
        self.surface_normal_x[i] = 0.0;
        self.surface_normal_y[i] = 0.0;
        self.surface_normal_z[i] = 1.0;
        self.radius[i] = 0.0;
        self.half_x[i] = 0.0;
        self.half_y[i] = 0.0;
        self.half_z[i] = 0.0;
        self.inv_mass[i] = 0.0;
        self.restitution[i] = 0.0;
        self.ground_offset[i] = 0.0;
        self.air_drag_coefficient[i] = 0.0;
        self.ground_friction_scale[i] = 1.0;
        self.sleep_ticks[i] = 0.0;
        self.flags[i] = BODY_FLAG_OCCUPIED;
        self.entity_id[i] = -1;
        slot
    }

    pub(crate) fn free_slot(&mut self, slot: u32) {
        let i = slot as usize;
        debug_assert!(i < POOL_CAPACITY_USIZE);
        debug_assert_ne!(
            self.flags[i] & BODY_FLAG_OCCUPIED,
            0,
            "freeing already-free slot"
        );
        self.flags[i] = 0;
        self.entity_id[i] = -1;
        self.free_slots.push(slot);
    }
}

// Single-threaded WASM, so an UnsafeCell-wrapped static is safe.
// Rust doesn't have a true single-threaded global without unsafe;
// the OnceCell + UnsafeCell pattern keeps the unsafety contained.
pub(crate) struct PoolHolder(UnsafeCell<Option<BodyPool>>);

unsafe impl Sync for PoolHolder {}

pub(crate) static POOL: PoolHolder = PoolHolder(UnsafeCell::new(None));

#[inline]
pub(crate) fn pool() -> &'static mut BodyPool {
    // SAFETY: WASM is single-threaded; there's no concurrent access.
    // pool_init must have been called before any pool_* function.
    unsafe {
        (*POOL.0.get())
            .as_mut()
            .expect("pool_init() not called before pool access")
    }
}

#[wasm_bindgen]
pub fn pool_init() {
    // SAFETY: see `pool()`.
    unsafe {
        let cell = POOL.0.get();
        if (*cell).is_none() {
            *cell = Some(BodyPool::new());
        }
    }
}

#[wasm_bindgen]
pub fn pool_capacity() -> u32 {
    POOL_CAPACITY
}

#[wasm_bindgen]
pub fn pool_alloc_slot() -> u32 {
    pool().alloc_slot()
}

#[wasm_bindgen]
pub fn pool_free_slot(slot: u32) {
    pool().free_slot(slot);
}

// Per-field raw pointer exports. JS constructs Float64Array /
// Uint8Array views once after pool_init(); pointers stay stable
// because the underlying Vecs were sized to POOL_CAPACITY at init
// and never reallocate.
//
// One ptr per field rather than a single struct-of-arrays handle
// — wasm-bindgen doesn't have first-class ptr-to-struct support
// and per-field access keeps the JS view code straightforward.

macro_rules! pool_ptr_export {
    ($name:ident, $field:ident, $ty:ty) => {
        #[wasm_bindgen]
        pub fn $name() -> *const $ty {
            pool().$field.as_ptr()
        }
    };
}

pool_ptr_export!(pool_pos_x_ptr, pos_x, f64);
pool_ptr_export!(pool_pos_y_ptr, pos_y, f64);
pool_ptr_export!(pool_pos_z_ptr, pos_z, f64);
pool_ptr_export!(pool_vel_x_ptr, vel_x, f64);
pool_ptr_export!(pool_vel_y_ptr, vel_y, f64);
pool_ptr_export!(pool_vel_z_ptr, vel_z, f64);
pool_ptr_export!(pool_accel_x_ptr, accel_x, f64);
pool_ptr_export!(pool_accel_y_ptr, accel_y, f64);
pool_ptr_export!(pool_accel_z_ptr, accel_z, f64);
pool_ptr_export!(pool_launch_x_ptr, launch_x, f64);
pool_ptr_export!(pool_launch_y_ptr, launch_y, f64);
pool_ptr_export!(pool_launch_z_ptr, launch_z, f64);
pool_ptr_export!(pool_surface_normal_x_ptr, surface_normal_x, f64);
pool_ptr_export!(pool_surface_normal_y_ptr, surface_normal_y, f64);
pool_ptr_export!(pool_surface_normal_z_ptr, surface_normal_z, f64);
pool_ptr_export!(pool_radius_ptr, radius, f64);
pool_ptr_export!(pool_half_x_ptr, half_x, f64);
pool_ptr_export!(pool_half_y_ptr, half_y, f64);
pool_ptr_export!(pool_half_z_ptr, half_z, f64);
pool_ptr_export!(pool_inv_mass_ptr, inv_mass, f64);
pool_ptr_export!(pool_restitution_ptr, restitution, f64);
pool_ptr_export!(pool_ground_offset_ptr, ground_offset, f64);
pool_ptr_export!(pool_air_drag_coefficient_ptr, air_drag_coefficient, f64);
pool_ptr_export!(pool_ground_friction_scale_ptr, ground_friction_scale, f64);
pool_ptr_export!(pool_sleep_ticks_ptr, sleep_ticks, f64);
pool_ptr_export!(pool_flags_ptr, flags, u8);
pool_ptr_export!(pool_entity_id_ptr, entity_id, i32);

pub(crate) const ARRIVAL_FLAG_LAST_ACTION: u8 = 1 << 1;
pub(crate) const ARRIVAL_COMPLETION_FLAG_FLYING: u8 = 1 << 2;

#[inline]
pub(crate) fn arrival_horizontal_drive_accel(
    drive_force: f64,
    traction: f64,
    mass: f64,
    thrust_multiplier: f64,
    force_scale: f64,
    reference_mass: f64,
    unit_mass_multiplier: f64,
) -> f64 {
    let physics_mass = mass * unit_mass_multiplier;
    if !physics_mass.is_finite()
        || physics_mass <= 0.0
        || !reference_mass.is_finite()
        || reference_mass <= 0.0
        || force_scale <= 0.0
    {
        return 0.0;
    }

    let traction_force_magnitude =
        drive_force * thrust_multiplier * traction * reference_mass / force_scale;
    traction_force_magnitude * 1_000_000.0 / physics_mass
}

#[inline]
pub(crate) fn compute_arrival_control_thrust(
    dx: f64,
    dy: f64,
    distance: f64,
    body_vx: f64,
    body_vy: f64,
    radius_collision: f64,
    drive_force: f64,
    traction: f64,
    mass: f64,
    flags: u8,
    dt_sec: f64,
    thrust_multiplier: f64,
    force_scale: f64,
    reference_mass: f64,
    unit_mass_multiplier: f64,
    control_radius_min: f64,
    response_time_sec: f64,
    min_accel: f64,
) -> (f64, f64, u8) {
    if distance <= 0.0001 || !distance.is_finite() {
        return (0.0, 0.0, 0);
    }

    let inv_distance = 1.0 / distance;
    if flags & ARRIVAL_FLAG_LAST_ACTION == 0 {
        return (dx * inv_distance, dy * inv_distance, 1);
    }

    let max_accel = arrival_horizontal_drive_accel(
        drive_force,
        traction,
        mass,
        thrust_multiplier,
        force_scale,
        reference_mass,
        unit_mass_multiplier,
    );
    if max_accel <= min_accel || !max_accel.is_finite() {
        return (dx * inv_distance, dy * inv_distance, 1);
    }

    let control_radius = control_radius_min.max(radius_collision * 8.0);
    let position_gain = max_accel / control_radius;
    let velocity_gain = 2.0 * position_gain.sqrt();
    let response_gain = if dt_sec > 0.0 {
        (1.0 / response_time_sec).min(1.0 / dt_sec)
    } else {
        1.0 / response_time_sec
    };
    let damping_gain = velocity_gain.max(response_gain);

    let accel_x = dx * position_gain - body_vx * damping_gain;
    let accel_y = dy * position_gain - body_vy * damping_gain;
    if !accel_x.is_finite() || !accel_y.is_finite() {
        return (0.0, 0.0, 0);
    }

    let accel_len = (accel_x * accel_x + accel_y * accel_y).sqrt();
    if accel_len <= min_accel {
        return (0.0, 0.0, 0);
    }

    let thrust_scale = (accel_len / max_accel).min(1.0);
    let out_scale = thrust_scale / accel_len;
    (accel_x * out_scale, accel_y * out_scale, 1)
}

#[wasm_bindgen]
pub fn arrival_control_step_batch(
    slots: &[u32],
    dx: &[f64],
    dy: &[f64],
    distance: &[f64],
    radius_collision: &[f64],
    drive_force: &[f64],
    traction: &[f64],
    mass: &[f64],
    flags: &[u8],
    out_thrust_x: &mut [f64],
    out_thrust_y: &mut [f64],
    out_active: &mut [u8],
    dt_sec: f64,
    thrust_multiplier: f64,
    force_scale: f64,
    reference_mass: f64,
    unit_mass_multiplier: f64,
    control_radius_min: f64,
    response_time_sec: f64,
    min_accel: f64,
) -> u32 {
    let count = slots.len();
    debug_assert!(dx.len() >= count);
    debug_assert!(dy.len() >= count);
    debug_assert!(distance.len() >= count);
    debug_assert!(radius_collision.len() >= count);
    debug_assert!(drive_force.len() >= count);
    debug_assert!(traction.len() >= count);
    debug_assert!(mass.len() >= count);
    debug_assert!(flags.len() >= count);
    debug_assert!(out_thrust_x.len() >= count);
    debug_assert!(out_thrust_y.len() >= count);
    debug_assert!(out_active.len() >= count);

    let p = pool();
    let mut active_count = 0_u32;
    for i in 0..count {
        let slot = slots[i] as usize;
        let (thrust_x, thrust_y, active) = compute_arrival_control_thrust(
            dx[i],
            dy[i],
            distance[i],
            p.vel_x[slot],
            p.vel_y[slot],
            radius_collision[i],
            drive_force[i],
            traction[i],
            mass[i],
            flags[i],
            dt_sec,
            thrust_multiplier,
            force_scale,
            reference_mass,
            unit_mass_multiplier,
            control_radius_min,
            response_time_sec,
            min_accel,
        );
        out_thrust_x[i] = thrust_x;
        out_thrust_y[i] = thrust_y;
        out_active[i] = active;
        active_count += active as u32;
    }
    active_count
}

#[inline]
pub(crate) fn compute_arrival_completion(
    dx: f64,
    dy: f64,
    body_vx: f64,
    body_vy: f64,
    flags: u8,
    arrival_radius: f64,
    final_radius: f64,
    final_stop_speed: f64,
) -> (f64, u8) {
    let distance = (dx * dx + dy * dy).sqrt();
    if !distance.is_finite() {
        return (distance, 0);
    }

    let is_last_action = flags & ARRIVAL_FLAG_LAST_ACTION != 0;
    let radius = if is_last_action {
        final_radius
    } else {
        arrival_radius
    };
    if distance >= radius {
        return (distance, 0);
    }

    if flags & ARRIVAL_COMPLETION_FLAG_FLYING != 0 || !is_last_action {
        return (distance, 1);
    }

    let speed_sq = body_vx * body_vx + body_vy * body_vy;
    let stop_speed_sq = final_stop_speed * final_stop_speed;
    if speed_sq <= stop_speed_sq {
        (distance, 1)
    } else {
        (distance, 0)
    }
}

#[wasm_bindgen]
pub fn arrival_completion_step_batch(
    slots: &[u32],
    dx: &[f64],
    dy: &[f64],
    fallback_velocity_x: &[f64],
    fallback_velocity_y: &[f64],
    flags: &[u8],
    out_distance: &mut [f64],
    out_arrived: &mut [u8],
    arrival_radius: f64,
    final_radius: f64,
    final_stop_speed: f64,
) -> u32 {
    let count = slots.len();
    debug_assert!(dx.len() >= count);
    debug_assert!(dy.len() >= count);
    debug_assert!(fallback_velocity_x.len() >= count);
    debug_assert!(fallback_velocity_y.len() >= count);
    debug_assert!(flags.len() >= count);
    debug_assert!(out_distance.len() >= count);
    debug_assert!(out_arrived.len() >= count);

    let p = pool();
    let mut arrived_count = 0_u32;
    for i in 0..count {
        let slot = slots[i] as usize;
        let has_pool_velocity = slot < p.vel_x.len() && p.flags[slot] & BODY_FLAG_OCCUPIED != 0;
        let velocity_x = if has_pool_velocity {
            p.vel_x[slot]
        } else {
            fallback_velocity_x[i]
        };
        let velocity_y = if has_pool_velocity {
            p.vel_y[slot]
        } else {
            fallback_velocity_y[i]
        };
        let (distance, arrived) = compute_arrival_completion(
            dx[i],
            dy[i],
            velocity_x,
            velocity_y,
            flags[i],
            arrival_radius,
            final_radius,
            final_stop_speed,
        );
        out_distance[i] = distance;
        out_arrived[i] = arrived;
        arrived_count += arrived as u32;
    }
    arrived_count
}

pub(crate) const FLYING_LOITER_INVALID_SLOT: u32 = u32::MAX;

#[inline]
pub(crate) fn compute_flying_loiter_thrust(
    dx: f64,
    dy: f64,
    distance: f64,
    rotation: f64,
    velocity_x: f64,
    velocity_y: f64,
    radius_collision: f64,
    existing_turn_sign: f64,
    min_radius: f64,
    radius_mult: f64,
    radial_gain: f64,
) -> (f64, f64, f64, u8) {
    let forward_x = rotation.cos();
    let forward_y = rotation.sin();
    if distance <= 0.0001 || !distance.is_finite() {
        return (forward_x, forward_y, existing_turn_sign, 1);
    }

    let inv_distance = 1.0 / distance;
    let radial_x = dx * inv_distance;
    let radial_y = dy * inv_distance;
    let tangent_x = -radial_y;
    let tangent_y = radial_x;
    let turn_sign = if existing_turn_sign == 1.0 || existing_turn_sign == -1.0 {
        existing_turn_sign
    } else {
        let vx = if velocity_x.is_finite() {
            velocity_x
        } else {
            forward_x
        };
        let vy = if velocity_y.is_finite() {
            velocity_y
        } else {
            forward_y
        };
        if vx * tangent_x + vy * tangent_y >= 0.0 {
            1.0
        } else {
            -1.0
        }
    };

    let radius = min_radius.max(radius_collision * radius_mult).max(0.0001);
    let radial_correction = (((distance - radius) / radius) * radial_gain)
        .max(-1.25)
        .min(1.25);
    let mut steer_x = tangent_x * turn_sign + radial_x * radial_correction;
    let mut steer_y = tangent_y * turn_sign + radial_y * radial_correction;
    let steer_mag = (steer_x * steer_x + steer_y * steer_y).sqrt();
    if steer_mag <= 0.0001 || !steer_mag.is_finite() {
        steer_x = forward_x;
        steer_y = forward_y;
    } else {
        steer_x /= steer_mag;
        steer_y /= steer_mag;
    }

    (steer_x, steer_y, turn_sign, 1)
}

#[wasm_bindgen]
pub fn flying_loiter_step_batch(
    slots: &[u32],
    dx: &[f64],
    dy: &[f64],
    distance: &[f64],
    rotation: &[f64],
    radius_collision: &[f64],
    existing_turn_sign: &[f64],
    fallback_velocity_x: &[f64],
    fallback_velocity_y: &[f64],
    out_thrust_x: &mut [f64],
    out_thrust_y: &mut [f64],
    out_turn_sign: &mut [f64],
    out_active: &mut [u8],
    min_radius: f64,
    radius_mult: f64,
    radial_gain: f64,
) -> u32 {
    let count = slots.len();
    debug_assert!(dx.len() >= count);
    debug_assert!(dy.len() >= count);
    debug_assert!(distance.len() >= count);
    debug_assert!(rotation.len() >= count);
    debug_assert!(radius_collision.len() >= count);
    debug_assert!(existing_turn_sign.len() >= count);
    debug_assert!(fallback_velocity_x.len() >= count);
    debug_assert!(fallback_velocity_y.len() >= count);
    debug_assert!(out_thrust_x.len() >= count);
    debug_assert!(out_thrust_y.len() >= count);
    debug_assert!(out_turn_sign.len() >= count);
    debug_assert!(out_active.len() >= count);

    let p = pool();
    let mut active_count = 0_u32;
    for i in 0..count {
        let slot = slots[i];
        let slot_index = slot as usize;
        let has_pool_velocity = slot != FLYING_LOITER_INVALID_SLOT && slot_index < p.vel_x.len();
        let velocity_x = if has_pool_velocity {
            p.vel_x[slot_index]
        } else {
            fallback_velocity_x[i]
        };
        let velocity_y = if has_pool_velocity {
            p.vel_y[slot_index]
        } else {
            fallback_velocity_y[i]
        };
        let (thrust_x, thrust_y, turn_sign, active) = compute_flying_loiter_thrust(
            dx[i],
            dy[i],
            distance[i],
            rotation[i],
            velocity_x,
            velocity_y,
            radius_collision[i],
            existing_turn_sign[i],
            min_radius,
            radius_mult,
            radial_gain,
        );
        out_thrust_x[i] = thrust_x;
        out_thrust_y[i] = thrust_y;
        out_turn_sign[i] = turn_sign;
        out_active[i] = active;
        active_count += active as u32;
    }
    active_count
}

pub(crate) const STUCK_REPLAN_FLAG_SETTLING_CHECK: u8 = 1 << 0;

#[inline]
pub(crate) fn compute_stuck_replan_step(
    body_vx: f64,
    body_vy: f64,
    current_stuck_ticks: i32,
    settling_dx: f64,
    settling_dy: f64,
    settling_flags: u8,
    stuck_velocity_threshold: f64,
    stuck_tick_threshold: i32,
    arrival_radius: f64,
) -> (i32, u8) {
    let speed_sq = body_vx * body_vx + body_vy * body_vy;
    let stuck_velocity_threshold_sq = stuck_velocity_threshold * stuck_velocity_threshold;
    if speed_sq >= stuck_velocity_threshold_sq {
        return (0, 0);
    }

    if settling_flags & STUCK_REPLAN_FLAG_SETTLING_CHECK != 0 {
        let distance_sq = settling_dx * settling_dx + settling_dy * settling_dy;
        let arrival_radius_sq = arrival_radius * arrival_radius;
        if distance_sq < arrival_radius_sq {
            return (0, 0);
        }
    }

    let next_stuck_ticks = current_stuck_ticks.saturating_add(1);
    let should_replan = if next_stuck_ticks > stuck_tick_threshold {
        1
    } else {
        0
    };
    (next_stuck_ticks, should_replan)
}

#[wasm_bindgen]
pub fn stuck_replan_step_batch(
    slots: &[u32],
    current_stuck_ticks: &[i32],
    settling_dx: &[f64],
    settling_dy: &[f64],
    settling_flags: &[u8],
    out_stuck_ticks: &mut [i32],
    out_should_replan: &mut [u8],
    stuck_velocity_threshold: f64,
    stuck_tick_threshold: i32,
    arrival_radius: f64,
) -> u32 {
    let count = slots.len();
    debug_assert!(current_stuck_ticks.len() >= count);
    debug_assert!(settling_dx.len() >= count);
    debug_assert!(settling_dy.len() >= count);
    debug_assert!(settling_flags.len() >= count);
    debug_assert!(out_stuck_ticks.len() >= count);
    debug_assert!(out_should_replan.len() >= count);

    let p = pool();
    let mut replan_count = 0_u32;
    for i in 0..count {
        let slot = slots[i] as usize;
        let (body_vx, body_vy) = if slot < p.vel_x.len() && p.flags[slot] & BODY_FLAG_OCCUPIED != 0
        {
            (p.vel_x[slot], p.vel_y[slot])
        } else {
            (0.0, 0.0)
        };
        let (stuck_ticks, should_replan) = compute_stuck_replan_step(
            body_vx,
            body_vy,
            current_stuck_ticks[i],
            settling_dx[i],
            settling_dy[i],
            settling_flags[i],
            stuck_velocity_threshold,
            stuck_tick_threshold,
            arrival_radius,
        );
        out_stuck_ticks[i] = stuck_ticks;
        out_should_replan[i] = should_replan;
        replan_count += should_replan as u32;
    }
    replan_count
}

#[inline]
pub(crate) fn compute_unit_ground_normal_step(
    stored_x: f64,
    stored_y: f64,
    stored_z: f64,
    raw_x: f64,
    raw_y: f64,
    raw_z: f64,
    alpha: f64,
) -> (f64, f64, f64) {
    if alpha >= 1.0 {
        return (raw_x, raw_y, raw_z);
    }

    let nx = stored_x + (raw_x - stored_x) * alpha;
    let ny = stored_y + (raw_y - stored_y) * alpha;
    let nz = stored_z + (raw_z - stored_z) * alpha;
    let len = (nx * nx + ny * ny + nz * nz).sqrt();
    if len > 1e-6 {
        let inv = 1.0 / len;
        (nx * inv, ny * inv, nz * inv)
    } else {
        (raw_x, raw_y, raw_z)
    }
}

#[wasm_bindgen]
pub fn unit_ground_normal_step_pool(
    out_dirty_entity_ids: &mut [u32],
    alpha: f64,
    dirty_epsilon: f64,
) -> u32 {
    let terrain = terrain_grid();
    if !terrain.installed {
        return 0;
    }
    let p = pool();
    let mut dirty_count = 0_u32;
    let end = p.next_unused_slot as usize;
    debug_assert!(out_dirty_entity_ids.len() >= POOL_CAPACITY_USIZE);
    for slot in 0..end {
        let flags = p.flags[slot];
        if flags & BODY_FLAG_OCCUPIED == 0
            || flags & BODY_FLAG_IS_STATIC != 0
            || flags & BODY_FLAG_SHAPE_CUBOID != 0
        {
            continue;
        }
        let entity_id = p.entity_id[slot];
        if entity_id < 0 {
            continue;
        }
        let (raw_x, raw_y, raw_z) =
            match terrain_surface_normal_at(terrain, p.pos_x[slot], p.pos_y[slot]) {
                Some(normal) => normal,
                None => continue,
            };
        let before_x = p.surface_normal_x[slot];
        let before_y = p.surface_normal_y[slot];
        let before_z = p.surface_normal_z[slot];
        let (nx, ny, nz) = compute_unit_ground_normal_step(
            before_x, before_y, before_z, raw_x, raw_y, raw_z, alpha,
        );
        p.surface_normal_x[slot] = nx;
        p.surface_normal_y[slot] = ny;
        p.surface_normal_z[slot] = nz;
        let dirty = (nx - before_x).abs() > dirty_epsilon
            || (ny - before_y).abs() > dirty_epsilon
            || (nz - before_z).abs() > dirty_epsilon;
        if dirty {
            out_dirty_entity_ids[dirty_count as usize] = entity_id as u32;
            dirty_count += 1;
        }
    }
    dirty_count
}

// ─────────────────────────────────────────────────────────────────
//  Phase 3d-2 — Pool-backed integrate + sphere-sphere kernels
//
//  The per-tick "scratch buffer + pack + call + unpack" pattern of
//  Phase 3a's `step_unit_motions_batch` and Phase 3c's
//  `resolve_sphere_sphere_contacts` is replaced by direct pool
//  reads/writes via slot indices. JS only marshals:
//    - the slot-index list (4 bytes per active body)
//    - per-body pre-sampled ground state (groundZ + normal —
//      terrain sampler is still JS-side until Phase 8)
//    - sleep / wake transition output buffers (slot ids of bodies
//      whose sleep state flipped this call; JS handles the awake-
//      count bookkeeping)
//  All body fields (motion, velocity, accumulators, geometry,
//  flags) live in linear memory and are read directly. Per-tick
//  marshal drops from O(N · 19 + N · 13) f64s to O(N · 4 + 4N)
//  f64s — about a 6x reduction at typical unit counts.
// ─────────────────────────────────────────────────────────────────

#[inline]
pub(crate) fn pool_is_dynamic_sphere(p: &BodyPool, slot: usize) -> bool {
    let flags = p.flags[slot];
    flags & BODY_FLAG_OCCUPIED != 0
        && flags & BODY_FLAG_IS_STATIC == 0
        && flags & BODY_FLAG_SHAPE_CUBOID == 0
}

#[inline]
pub(crate) fn pool_boundary_accel(
    penetration: f64,
    inward_velocity: f64,
    spring_accel: f64,
    damping: f64,
) -> f64 {
    let spring = spring_accel * penetration.max(0.0);
    let damped = spring - damping * inward_velocity;
    if damped.is_finite() {
        damped.max(0.0)
    } else {
        0.0
    }
}

#[inline]
fn pool_boundary_axis_limits(map_extent: f64, radius: f64) -> Option<(f64, f64)> {
    if !map_extent.is_finite() || map_extent <= 0.0 {
        return None;
    }
    let safe_radius = if radius.is_finite() && radius > 0.0 {
        radius.min(map_extent * 0.5)
    } else {
        0.0
    };
    Some((safe_radius, map_extent - safe_radius))
}

#[inline]
fn constrain_boundary_axis(pos: &mut f64, vel: &mut f64, min: f64, max: f64) -> bool {
    let mut changed = false;
    if !pos.is_finite() {
        *pos = (min + max) * 0.5;
        changed = true;
    }
    if !vel.is_finite() {
        *vel = 0.0;
        changed = true;
    }
    if *pos < min {
        *pos = min;
        if *vel < 0.0 {
            *vel = 0.0;
        }
        changed = true;
    } else if *pos > max {
        *pos = max;
        if *vel > 0.0 {
            *vel = 0.0;
        }
        changed = true;
    }
    changed
}

#[inline]
fn constrain_motion_to_world_boundary(
    motion: &mut [f64; 6],
    radius: f64,
    map_width: f64,
    map_height: f64,
) -> bool {
    let mut changed = false;
    if let Some((min_x, max_x)) = pool_boundary_axis_limits(map_width, radius) {
        let mut x = motion[0];
        let mut vx = motion[3];
        if constrain_boundary_axis(&mut x, &mut vx, min_x, max_x) {
            motion[0] = x;
            motion[3] = vx;
            changed = true;
        }
    }
    if let Some((min_y, max_y)) = pool_boundary_axis_limits(map_height, radius) {
        let mut y = motion[1];
        let mut vy = motion[4];
        if constrain_boundary_axis(&mut y, &mut vy, min_y, max_y) {
            motion[1] = y;
            motion[4] = vy;
            changed = true;
        }
    }
    changed
}

#[inline]
pub(crate) fn pool_wake_body(p: &mut BodyPool, slot: usize) -> bool {
    let was_sleeping = p.flags[slot] & BODY_FLAG_SLEEPING != 0;
    if was_sleeping {
        p.flags[slot] &= !BODY_FLAG_SLEEPING;
    }
    p.sleep_ticks[slot] = 0.0;
    was_sleeping
}

/// PhysicsEngine3D step preparation over BodyPool slots.
///
/// Clears the per-step upward-contact flag, applies map-boundary
/// spring/damping acceleration in Rust, wakes boundary-pushed bodies,
/// and emits the awake slot list used by `pool_step_integrate`.
///
/// stats_out layout:
///   [0] awake slot count
///   [1] boundary wake count
///   [2] sync body slot count
#[wasm_bindgen]
pub fn pool_prepare_dynamic_step(
    dynamic_slots: &[u32],
    awake_slots_out: &mut [u32],
    sync_body_slots_out: &mut [u32],
    stats_out: &mut [u32],
    map_width: f64,
    map_height: f64,
    boundary_spring_accel: f64,
    boundary_damping_accel_per_speed: f64,
) -> u32 {
    if stats_out.len() < 3 {
        return 0;
    }
    stats_out[0] = 0;
    stats_out[1] = 0;
    stats_out[2] = 0;
    if awake_slots_out.len() < dynamic_slots.len()
        || sync_body_slots_out.len() < dynamic_slots.len()
    {
        return 0;
    }

    let p = pool();
    let mut awake_count = 0_u32;
    let mut wake_count = 0_u32;
    let mut sync_count = 0_u32;
    let boundary_enabled = boundary_spring_accel > 0.0
        && map_width.is_finite()
        && map_height.is_finite()
        && map_width > 0.0
        && map_height > 0.0;

    for &slot_u32 in dynamic_slots {
        let slot = slot_u32 as usize;
        if slot >= POOL_CAPACITY_USIZE || !pool_is_dynamic_sphere(p, slot) {
            continue;
        }

        p.flags[slot] &= !BODY_FLAG_UPWARD_CONTACT;

        if boundary_enabled {
            let radius = p.radius[slot];
            let mut ax = 0.0;
            let mut ay = 0.0;
            let x = p.pos_x[slot];
            let y = p.pos_y[slot];

            if let Some((min_x, max_x)) = pool_boundary_axis_limits(map_width, radius) {
                if x < min_x {
                    ax += pool_boundary_accel(
                        min_x - x,
                        p.vel_x[slot],
                        boundary_spring_accel,
                        boundary_damping_accel_per_speed,
                    );
                } else if x > max_x {
                    ax -= pool_boundary_accel(
                        x - max_x,
                        -p.vel_x[slot],
                        boundary_spring_accel,
                        boundary_damping_accel_per_speed,
                    );
                }
            }

            if let Some((min_y, max_y)) = pool_boundary_axis_limits(map_height, radius) {
                if y < min_y {
                    ay += pool_boundary_accel(
                        min_y - y,
                        p.vel_y[slot],
                        boundary_spring_accel,
                        boundary_damping_accel_per_speed,
                    );
                } else if y > max_y {
                    ay -= pool_boundary_accel(
                        y - max_y,
                        -p.vel_y[slot],
                        boundary_spring_accel,
                        boundary_damping_accel_per_speed,
                    );
                }
            }

            if ax != 0.0 || ay != 0.0 {
                if pool_wake_body(p, slot) {
                    wake_count += 1;
                }
                p.accel_x[slot] += ax;
                p.accel_y[slot] += ay;
            }
        }

        if p.flags[slot] & BODY_FLAG_SLEEPING == 0 {
            awake_slots_out[awake_count as usize] = slot_u32;
            awake_count += 1;
            if p.entity_id[slot] >= 0 {
                sync_body_slots_out[sync_count as usize] = slot_u32;
                sync_count += 1;
            }
        }
    }

    stats_out[0] = awake_count;
    stats_out[1] = wake_count;
    stats_out[2] = sync_count;
    awake_count
}

/// Collect awake entity IDs directly from BodyPool flags.
#[wasm_bindgen]
pub fn pool_collect_awake_entity_ids(dynamic_slots: &[u32], entity_ids_out: &mut [i32]) -> u32 {
    if entity_ids_out.len() < dynamic_slots.len() {
        return 0;
    }

    let p = pool();
    let mut count = 0_u32;
    for &slot_u32 in dynamic_slots {
        let slot = slot_u32 as usize;
        if slot >= POOL_CAPACITY_USIZE || !pool_is_dynamic_sphere(p, slot) {
            continue;
        }
        if p.flags[slot] & BODY_FLAG_SLEEPING != 0 {
            continue;
        }
        let entity_id = p.entity_id[slot];
        if entity_id < 0 {
            continue;
        }
        entity_ids_out[count as usize] = entity_id;
        count += 1;
    }
    count
}

/// Final per-step sync body-slot collection and accumulator clear.
#[wasm_bindgen]
pub fn pool_finalize_dynamic_step(dynamic_slots: &[u32], sync_body_slots_out: &mut [u32]) -> u32 {
    if sync_body_slots_out.len() < dynamic_slots.len() {
        return 0;
    }

    let p = pool();
    let mut sync_count = 0_u32;
    for &slot_u32 in dynamic_slots {
        let slot = slot_u32 as usize;
        if slot >= POOL_CAPACITY_USIZE || !pool_is_dynamic_sphere(p, slot) {
            continue;
        }
        if p.flags[slot] & BODY_FLAG_SLEEPING == 0 {
            if p.entity_id[slot] >= 0 {
                sync_body_slots_out[sync_count as usize] = slot_u32;
                sync_count += 1;
            }
        }
        p.accel_x[slot] = 0.0;
        p.accel_y[slot] = 0.0;
        p.accel_z[slot] = 0.0;
        p.launch_x[slot] = 0.0;
        p.launch_y[slot] = 0.0;
        p.launch_z[slot] = 0.0;
    }
    sync_count
}

#[inline]
fn scale_body_motion_damp(damp: f64, scale: f64) -> f64 {
    if !damp.is_finite() {
        return 1.0;
    }
    let base = damp.max(0.0).min(1.0);
    if base >= 1.0 {
        return 1.0;
    }
    if base <= 0.0 {
        return if scale <= 0.0 { 1.0 } else { 0.0 };
    }
    if !scale.is_finite() {
        return base;
    }
    let clamped_scale = scale.max(0.0);
    if clamped_scale <= 0.0 {
        return 1.0;
    }
    base.powf(clamped_scale).max(0.0).min(1.0)
}

#[wasm_bindgen]
pub fn pool_step_integrate(
    awake_slots: &[u32],
    ground_z: &[f64],
    ground_normals: &[f64],
    sleep_transitions_out: &mut [u32],
    dt_sec: f64,
    ground_damp: f64,
    wind_x: f64,
    wind_y: f64,
    wind_z: f64,
    map_width: f64,
    map_height: f64,
) -> u32 {
    let count = awake_slots.len();
    debug_assert!(ground_z.len() >= count);
    debug_assert!(ground_normals.len() >= 3 * count);
    debug_assert!(sleep_transitions_out.len() >= count);
    if !wind_x.is_finite() || !wind_y.is_finite() || !wind_z.is_finite() {
        return 0;
    }

    let p = pool();
    let mut transitions = 0_u32;
    for i in 0..count {
        let slot_u32 = awake_slots[i];
        let slot = slot_u32 as usize;
        let g_z = ground_z[i];
        let n_x = ground_normals[i * 3];
        let n_y = ground_normals[i * 3 + 1];
        let n_z = ground_normals[i * 3 + 2];

        let ground_offset = p.ground_offset[slot];

        // authored_accel is the input force BEFORE gravity is added.
        // Mirrors PhysicsEngine3D.integrate's authoredAccelSq
        // computation (used for the sleep gate).
        let authored_ax = p.accel_x[slot];
        let authored_ay = p.accel_y[slot];
        let authored_az = p.accel_z[slot];
        let authored_accel_sq =
            authored_ax * authored_ax + authored_ay * authored_ay + authored_az * authored_az;

        let launch_ax = p.launch_x[slot];
        let launch_ay = p.launch_y[slot];
        let launch_az = p.launch_z[slot];

        // Per-body air drag is a physical force:
        //   F = drag_coefficient * (wind_velocity - body_velocity)
        // and acceleration comes from F / mass via the pool's inv_mass.
        // Ground contact friction remains a tangent damping term.
        let ground_scale = p.ground_friction_scale[slot];
        let air_drag_coefficient = p.air_drag_coefficient[slot];
        let eff_air_drag_coefficient =
            if air_drag_coefficient.is_finite() && air_drag_coefficient > 0.0 {
                air_drag_coefficient
            } else {
                0.0
            };
        let eff_ground_damp = scale_body_motion_damp(ground_damp, ground_scale);

        // Run the integrator on a 6-element scratch — the inline
        // helper is shared with the per-body / batched buffer paths
        // so all branches stay numerically identical.
        let mut motion = [
            p.pos_x[slot],
            p.pos_y[slot],
            p.pos_z[slot],
            p.vel_x[slot],
            p.vel_y[slot],
            p.vel_z[slot],
        ];
        integrate_unit_motion_inline(
            &mut motion,
            dt_sec,
            ground_offset,
            authored_ax,
            authored_ay,
            authored_az - GRAVITY,
            eff_air_drag_coefficient,
            p.inv_mass[slot],
            eff_ground_damp,
            wind_x,
            wind_y,
            wind_z,
            launch_ax,
            launch_ay,
            launch_az,
            g_z,
            n_x,
            n_y,
            n_z,
        );
        constrain_motion_to_world_boundary(&mut motion, p.radius[slot], map_width, map_height);
        p.pos_x[slot] = motion[0];
        p.pos_y[slot] = motion[1];
        p.pos_z[slot] = motion[2];
        p.vel_x[slot] = motion[3];
        p.vel_y[slot] = motion[4];
        p.vel_z[slot] = motion[5];

        // Sleep heuristic — same constants + check order as Phase 3a.
        let speed_sq = motion[3] * motion[3] + motion[4] * motion[4] + motion[5] * motion[5];
        let mut sleep_ticks = p.sleep_ticks[slot];
        let mut just_slept = false;
        if authored_accel_sq <= SLEEP_ACCEL_SQ && speed_sq <= SLEEP_SPEED_SQ {
            let next_penetration = g_z - (motion[2] - ground_offset);
            if is_in_contact(next_penetration) && next_penetration <= SLEEP_GROUND_PENETRATION_EPS {
                sleep_ticks += 1.0;
                if sleep_ticks >= SLEEP_TICKS {
                    p.pos_z[slot] = g_z + ground_offset;
                    p.vel_x[slot] = 0.0;
                    p.vel_y[slot] = 0.0;
                    p.vel_z[slot] = 0.0;
                    sleep_ticks = SLEEP_TICKS;
                    p.flags[slot] |= BODY_FLAG_SLEEPING;
                    just_slept = true;
                }
            } else {
                sleep_ticks = 0.0;
            }
        } else {
            sleep_ticks = 0.0;
        }
        p.sleep_ticks[slot] = sleep_ticks;
        if just_slept {
            sleep_transitions_out[transitions as usize] = slot_u32;
            transitions += 1;
        }
    }
    transitions
}

// Persistent scratch for `pool_resolve_sphere_sphere`. The dynamic-body
// bucket grid must be rebuilt every physics step (positions change every
// step), but the *allocations* are reused across calls instead of being
// freshly made. Buckets are generation-stamped rather than emptied: a
// bucket whose `gen` doesn't match the current build generation is treated
// as empty, so the inner `items` Vecs keep their capacity and steady-state
// allocation is zero. Mirrors the allocation-free persistent-grid
// discipline of the sphere-vs-cuboid resolver (EngineStatics) — the prior
// `HashMap::new()` + `vec![false; count]` per call was the only per-step
// allocation in the contact solver, and it could trigger memory.grow()
// (which detaches every JS typed-array view and forces a refreshViews()).
pub(crate) struct SphereContactBucket {
    pub(crate) gen: u32,
    pub(crate) items: Vec<u32>,
}

pub(crate) struct SphereResolveScratch {
    pub(crate) cells: HashMap<u64, SphereContactBucket>,
    pub(crate) gen: u32,
    pub(crate) woke: Vec<bool>,
}

pub(crate) struct SphereResolveScratchHolder(UnsafeCell<Option<SphereResolveScratch>>);
unsafe impl Sync for SphereResolveScratchHolder {}
pub(crate) static SPHERE_RESOLVE_SCRATCH: SphereResolveScratchHolder =
    SphereResolveScratchHolder(UnsafeCell::new(None));

#[inline]
pub(crate) fn sphere_resolve_scratch() -> &'static mut SphereResolveScratch {
    // SAFETY: WASM is single-threaded; no concurrent access, and only one
    // pool_resolve_sphere_sphere call is ever active at a time.
    unsafe {
        let cell = SPHERE_RESOLVE_SCRATCH.0.get();
        if (*cell).is_none() {
            *cell = Some(SphereResolveScratch {
                cells: HashMap::default(),
                gen: 0,
                woke: Vec::new(),
            });
        }
        (*cell).as_mut().unwrap()
    }
}

#[wasm_bindgen]
pub fn pool_resolve_sphere_sphere(
    sphere_slots: &[u32],
    iterations: u32,
    cell_size: f64,
    wake_transitions_out: &mut [u32],
) -> u32 {
    let count = sphere_slots.len();
    debug_assert!(wake_transitions_out.len() >= count);
    if count == 0 || iterations == 0 || cell_size <= 0.0 {
        return 0;
    }

    let p = pool();
    let half_cs = cell_size * 0.5;

    // Bucket bodies by center cell; reused across all sub-iterations
    // — same as PhysicsEngine3D.rebuildContactCells / Phase 3c. The grid
    // and the woke buffer live in persistent scratch (see
    // SphereResolveScratch): bump the generation and stamp each touched
    // bucket so stale buckets read as empty without freeing their Vecs.
    let scratch = sphere_resolve_scratch();
    scratch.gen = scratch.gen.wrapping_add(1);
    let gen = scratch.gen;
    let cells = &mut scratch.cells;
    let mut max_radius = 0.0_f64;
    let mut min_cx = i32::MAX;
    let mut min_cy = i32::MAX;
    let mut min_cz = i32::MAX;
    let mut max_cx = i32::MIN;
    let mut max_cy = i32::MIN;
    let mut max_cz = i32::MIN;
    for i in 0..count {
        let slot = sphere_slots[i] as usize;
        let x = p.pos_x[slot];
        let y = p.pos_y[slot];
        let z = p.pos_z[slot];
        let r = p.radius[slot];
        if r > max_radius {
            max_radius = r;
        }
        let cx = (x / cell_size).floor() as i32;
        let cy = (y / cell_size).floor() as i32;
        let cz = ((z + half_cs) / cell_size).floor() as i32;
        if cx < min_cx {
            min_cx = cx;
        }
        if cy < min_cy {
            min_cy = cy;
        }
        if cz < min_cz {
            min_cz = cz;
        }
        if cx > max_cx {
            max_cx = cx;
        }
        if cy > max_cy {
            max_cy = cy;
        }
        if cz > max_cz {
            max_cz = cz;
        }
        let key = pack_contact_cell_key(cx, cy, cz);
        let bucket = cells.entry(key).or_insert_with(|| SphereContactBucket {
            gen,
            items: Vec::new(),
        });
        if bucket.gen != gen {
            bucket.gen = gen;
            bucket.items.clear();
        }
        bucket.items.push(i as u32);
    }
    // Track "got pushed" per local index so JS can fire wakeBody on
    // exactly the bodies whose state flipped. Reused across calls; only
    // [0, count) is touched, so a longer buffer from a prior call is fine.
    let woke = &mut scratch.woke;
    if woke.len() < count {
        woke.resize(count, false);
    }
    for k in 0..count {
        woke[k] = false;
    }

    for _iter in 0..iterations {
        for i in 0..count {
            let slot_a = sphere_slots[i] as usize;
            let ar = p.radius[slot_a];
            let a_inv_mass = p.inv_mass[slot_a];
            let a_restitution = p.restitution[slot_a];
            // A global `max_radius * 2` range is correct but expensive:
            // one queen-class body makes every small unit scan a 5x5x5
            // neighborhood. For body A, any possible B has radius <=
            // max_radius, so `ar + max_radius` is the same conservative
            // broadphase bound with fewer impossible bucket probes.
            let range = (((ar + max_radius) / cell_size).ceil() as i32).max(1);

            let acx = (p.pos_x[slot_a] / cell_size).floor() as i32;
            let acy = (p.pos_y[slot_a] / cell_size).floor() as i32;
            let acz = ((p.pos_z[slot_a] + half_cs) / cell_size).floor() as i32;

            let query_min_cx = (acx - range).max(min_cx);
            let query_max_cx = (acx + range).min(max_cx);
            let query_min_cy = (acy - range).max(min_cy);
            let query_max_cy = (acy + range).min(max_cy);
            let query_min_cz = (acz - range).max(min_cz);
            let query_max_cz = (acz + range).min(max_cz);

            for cz in query_min_cz..=query_max_cz {
                for cy in query_min_cy..=query_max_cy {
                    for cx in query_min_cx..=query_max_cx {
                        let key = pack_contact_cell_key(cx, cy, cz);
                        let bucket = match cells.get(&key) {
                            Some(b) if b.gen == gen => b,
                            _ => continue,
                        };
                        for &j_u32 in bucket.items.iter() {
                            let j = j_u32 as usize;
                            if j <= i {
                                continue;
                            }
                            let slot_b = sphere_slots[j] as usize;
                            let br = p.radius[slot_b];

                            let ax = p.pos_x[slot_a];
                            let ay = p.pos_y[slot_a];
                            let az = p.pos_z[slot_a];
                            let bx = p.pos_x[slot_b];
                            let by = p.pos_y[slot_b];
                            let bz = p.pos_z[slot_b];

                            let ddx = bx - ax;
                            let ddy = by - ay;
                            let ddz = bz - az;
                            let r_sum = ar + br;
                            let dist_sq = ddx * ddx + ddy * ddy + ddz * ddz;
                            if dist_sq >= r_sum * r_sum {
                                continue;
                            }

                            woke[i] = true;
                            woke[j] = true;

                            let dist: f64;
                            let nx: f64;
                            let ny: f64;
                            let nz: f64;
                            if dist_sq < 1e-12 {
                                // Degenerate: deterministic random direction.
                                // Using slot ids (stable for body lifetime) as
                                // the seed source — slightly different from the
                                // Phase 3c buffer-based version (which used the
                                // entityId), but functionally equivalent for the
                                // tie-break case (centers exactly coincident).
                                let a_id = slot_a as u64;
                                let b_id = slot_b as u64;
                                let seed = (a_id.wrapping_mul(73856093)
                                    ^ b_id.wrapping_mul(19349663))
                                    as u32;
                                let angle =
                                    (seed as f64 / 4294967296.0) * core::f64::consts::PI * 2.0;
                                dist = 1e-6;
                                nx = angle.cos();
                                ny = angle.sin();
                                nz = 0.0;
                            } else {
                                dist = dist_sq.sqrt();
                                let inv_dist = 1.0 / dist;
                                nx = ddx * inv_dist;
                                ny = ddy * inv_dist;
                                nz = ddz * inv_dist;
                            }
                            let penetration = r_sum - dist;
                            let b_inv_mass = p.inv_mass[slot_b];
                            let inv_mass_sum_inv = 1.0 / (a_inv_mass + b_inv_mass);
                            let w_a = a_inv_mass * inv_mass_sum_inv;
                            let w_b = b_inv_mass * inv_mass_sum_inv;
                            p.pos_x[slot_a] = ax - nx * penetration * w_a;
                            p.pos_y[slot_a] = ay - ny * penetration * w_a;
                            p.pos_z[slot_a] = az - nz * penetration * w_a;
                            p.pos_x[slot_b] = bx + nx * penetration * w_b;
                            p.pos_y[slot_b] = by + ny * penetration * w_b;
                            p.pos_z[slot_b] = bz + nz * penetration * w_b;

                            // Upward contact flag — set directly in pool;
                            // JS reads via the body.upwardSurfaceContact getter.
                            if nz > 0.35 {
                                p.flags[slot_b] |= BODY_FLAG_UPWARD_CONTACT;
                            } else if nz < -0.35 {
                                p.flags[slot_a] |= BODY_FLAG_UPWARD_CONTACT;
                            }

                            let a_vx = p.vel_x[slot_a];
                            let a_vy = p.vel_y[slot_a];
                            let a_vz = p.vel_z[slot_a];
                            let b_vx = p.vel_x[slot_b];
                            let b_vy = p.vel_y[slot_b];
                            let b_vz = p.vel_z[slot_b];
                            let rvx = b_vx - a_vx;
                            let rvy = b_vy - a_vy;
                            let rvz = b_vz - a_vz;
                            let v_dot_n = rvx * nx + rvy * ny + rvz * nz;
                            if v_dot_n >= 0.0 {
                                continue;
                            }
                            let b_restitution = p.restitution[slot_b];
                            let e = a_restitution.min(b_restitution);
                            let j_mag = -(1.0 + e) * v_dot_n * inv_mass_sum_inv;
                            let ix = j_mag * nx;
                            let iy = j_mag * ny;
                            let iz = j_mag * nz;
                            p.vel_x[slot_a] = a_vx - ix * a_inv_mass;
                            p.vel_y[slot_a] = a_vy - iy * a_inv_mass;
                            p.vel_z[slot_a] = a_vz - iz * a_inv_mass;
                            p.vel_x[slot_b] = b_vx + ix * b_inv_mass;
                            p.vel_y[slot_b] = b_vy + iy * b_inv_mass;
                            p.vel_z[slot_b] = b_vz + iz * b_inv_mass;
                        }
                    }
                }
            }
        }
    }

    let mut transitions = 0_u32;
    for i in 0..count {
        if woke[i] {
            wake_transitions_out[transitions as usize] = sphere_slots[i];
            transitions += 1;
        }
    }
    transitions
}

// ─────────────────────────────────────────────────────────────────
//  Phase 3b — Pool-backed sphere-vs-cuboid pair resolver
//
//  Ports PhysicsEngine3D.ts `resolveSphereCuboidPair` into a single
//  batched WASM call. JS's existing broadphase (the `staticCells`
//  Map keyed by AABB cell) iterates per dynamic sphere, does the
//  ignoreStatic + staticQueryStamp dedup, and accumulates a flat
//  pair list (dyn_slot, static_slot interleaved). One WASM call
//  resolves every pair; both bodies' state lives in the BodyPool
//  so nothing else crosses the boundary.
//
//  Sleep-wake rule mirrors the TS path: every pair that pushes a
//  dynamic body emits a wake transition. JS calls wakeBody() on
//  each — idempotent on already-awake bodies, so the wake-count
//  bookkeeping is correct regardless of duplicates from a single
//  dyn body that hits multiple cuboids in one tick.
//
//  Upward contact: BODY_FLAG_UPWARD_CONTACT set directly on the
//  dyn body's pool flags byte when contact normal nz > 0.35.
// ─────────────────────────────────────────────────────────────────

/// Internal sphere-vs-cuboid pair resolver (single pair). Reads
/// dyn body geometry + cuboid extents from the pool, mutates dyn
/// pos/vel/flags in place. Returns true iff the pair overlapped
/// (so the caller can mark a wake transition / set upward-contact).
#[inline]
pub(crate) fn resolve_sphere_cuboid_pair_in_pool(
    p: &mut BodyPool,
    dyn_slot: usize,
    st_slot: usize,
) -> bool {
    let dyn_x = p.pos_x[dyn_slot];
    let dyn_y = p.pos_y[dyn_slot];
    let dyn_z = p.pos_z[dyn_slot];
    let dyn_r = p.radius[dyn_slot];
    let st_x = p.pos_x[st_slot];
    let st_y = p.pos_y[st_slot];
    let st_z = p.pos_z[st_slot];
    let st_hx = p.half_x[st_slot];
    let st_hy = p.half_y[st_slot];
    let st_hz = p.half_z[st_slot];

    let dx = dyn_x - st_x;
    let dy = dyn_y - st_y;
    let dz = dyn_z - st_z;
    let cx = dx.max(-st_hx).min(st_hx);
    let cy = dy.max(-st_hy).min(st_hy);
    let cz = dz.max(-st_hz).min(st_hz);
    let sep_x = dx - cx;
    let sep_y = dy - cy;
    let sep_z = dz - cz;
    let dist_sq = sep_x * sep_x + sep_y * sep_y + sep_z * sep_z;
    if dist_sq >= dyn_r * dyn_r {
        return false;
    }
    let dist = dist_sq.sqrt();

    let nx: f64;
    let ny: f64;
    let nz: f64;
    let penetration: f64;
    if dist < 1e-6 {
        let over_x = st_hx - dx.abs();
        let over_y = st_hy - dy.abs();
        let over_z = st_hz - dz.abs();
        if over_x <= over_y && over_x <= over_z {
            nx = if dx >= 0.0 { 1.0 } else { -1.0 };
            ny = 0.0;
            nz = 0.0;
            penetration = over_x + dyn_r;
        } else if over_y <= over_z {
            nx = 0.0;
            ny = if dy >= 0.0 { 1.0 } else { -1.0 };
            nz = 0.0;
            penetration = over_y + dyn_r;
        } else {
            nx = 0.0;
            ny = 0.0;
            nz = if dz >= 0.0 { 1.0 } else { -1.0 };
            penetration = over_z + dyn_r;
        }
    } else {
        let inv_dist = 1.0 / dist;
        nx = sep_x * inv_dist;
        ny = sep_y * inv_dist;
        nz = sep_z * inv_dist;
        penetration = dyn_r - dist;
    }

    p.pos_x[dyn_slot] = dyn_x + nx * penetration;
    p.pos_y[dyn_slot] = dyn_y + ny * penetration;
    p.pos_z[dyn_slot] = dyn_z + nz * penetration;

    if nz > 0.35 {
        p.flags[dyn_slot] |= BODY_FLAG_UPWARD_CONTACT;
    }

    let dyn_vx = p.vel_x[dyn_slot];
    let dyn_vy = p.vel_y[dyn_slot];
    let dyn_vz = p.vel_z[dyn_slot];
    let v_dot_n = dyn_vx * nx + dyn_vy * ny + dyn_vz * nz;
    if v_dot_n < 0.0 {
        let restitution = p.restitution[dyn_slot];
        let j = (1.0 + restitution) * v_dot_n;
        p.vel_x[dyn_slot] = dyn_vx - j * nx;
        p.vel_y[dyn_slot] = dyn_vy - j * ny;
        p.vel_z[dyn_slot] = dyn_vz - j * nz;
    }
    true
}

// ─────────────────────────────────────────────────────────────────
//  Phase 3f — Static cuboid broadphase in WASM linear memory
//
//  Per-engine state. The foreground game and the LobbyManager
//  background battle each construct their own PhysicsEngine3D in
//  the same JS context, so a shared global static-cell map would
//  conflate cuboids from both engines. Instead each engine creates
//  its own EngineStatics handle at construction time and uses it
//  for every static_add / static_remove / resolve call.
//
//  EngineStatics holds:
//    - cells: HashMap<packed_cell_key, Vec<slot_id>>
//    - visit_stamps: per-slot u32 marker for per-query dedup (a
//      static body that spans multiple cells gets visited from
//      every overlapping cell in a sphere's query window — without
//      dedup we'd run the resolver math against the same pair
//      multiple times in one tick).
// ─────────────────────────────────────────────────────────────────

pub(crate) struct EngineStatics {
    pub(crate) cells: HashMap<u64, Vec<u32>>,
    pub(crate) visit_stamps: Vec<u32>,
    pub(crate) next_stamp: u32,
}

impl EngineStatics {
    pub(crate) fn new() -> Self {
        Self {
            cells: HashMap::default(),
            visit_stamps: vec![0u32; POOL_CAPACITY_USIZE],
            next_stamp: 0,
        }
    }
}

pub(crate) struct EngineStaticsTable {
    pub(crate) handles: Vec<Option<EngineStatics>>,
    pub(crate) free_list: Vec<u32>,
}

pub(crate) struct EngineStaticsHolder(UnsafeCell<EngineStaticsTable>);
unsafe impl Sync for EngineStaticsHolder {}
pub(crate) static ENGINE_STATICS: EngineStaticsHolder =
    EngineStaticsHolder(UnsafeCell::new(EngineStaticsTable {
        handles: Vec::new(),
        free_list: Vec::new(),
    }));

#[inline]
pub(crate) fn engine_statics(handle: u32) -> &'static mut EngineStatics {
    // SAFETY: WASM is single-threaded; only one Rust call active at a
    // time, so no aliasing &mut refs ever co-exist. The `handles` Vec
    // never shrinks (destroy nulls the slot but keeps the index live),
    // so the address backing a `Some(_)` stays stable for the slot's
    // lifetime.
    //
    // The handle is NOT remote input: it is the u32 the JS engine got
    // back from engine-create and stores for its own lifetime, so an
    // out-of-range or destroyed handle is an engine-lifecycle bug.
    // Panicking with a clear message (instead of indexing UB-adjacent
    // paths) is the intended behavior; `get_mut` keeps the
    // out-of-range case on the same explicit panic instead of a raw
    // index panic.
    unsafe {
        let v = &mut *ENGINE_STATICS.0.get();
        v.handles
            .get_mut(handle as usize)
            .and_then(|slot| slot.as_mut())
            .expect("engine_statics: stale or destroyed engine handle")
    }
}

#[inline]
pub(crate) fn cell_xy(v: f64, cs: f64) -> i32 {
    (v / cs).floor() as i32
}

#[inline]
pub(crate) fn cell_z_with_bias(v: f64, cs: f64) -> i32 {
    ((v + cs * 0.5) / cs).floor() as i32
}

#[wasm_bindgen]
pub fn engine_statics_create() -> u32 {
    // SAFETY: see `engine_statics`.
    unsafe {
        let v = &mut *ENGINE_STATICS.0.get();
        if let Some(handle) = v.free_list.pop() {
            v.handles[handle as usize] = Some(EngineStatics::new());
            handle
        } else {
            let handle = v.handles.len() as u32;
            v.handles.push(Some(EngineStatics::new()));
            handle
        }
    }
}

/// Release a handle previously returned by `engine_statics_create`.
/// Drops the underlying HashMap + visit_stamps Vec and returns the
/// slot to a free list so the next create() can recycle it. Calling
/// destroy twice on the same handle, or using a destroyed handle
/// afterwards, will panic (caught by the .expect() in
/// `engine_statics`).
#[wasm_bindgen]
pub fn engine_statics_destroy(handle: u32) {
    // SAFETY: see `engine_statics`.
    unsafe {
        let v = &mut *ENGINE_STATICS.0.get();
        let idx = handle as usize;
        debug_assert!(
            idx < v.handles.len(),
            "engine_statics_destroy: handle out of range"
        );
        debug_assert!(
            v.handles[idx].is_some(),
            "engine_statics_destroy: handle already destroyed"
        );
        v.handles[idx] = None;
        v.free_list.push(handle);
    }
}

#[wasm_bindgen]
pub fn engine_statics_add(handle: u32, slot: u32, cell_size: f64) {
    let p = pool();
    let s = engine_statics(handle);
    let slot_usize = slot as usize;
    let x = p.pos_x[slot_usize];
    let y = p.pos_y[slot_usize];
    let z = p.pos_z[slot_usize];
    let hx = p.half_x[slot_usize];
    let hy = p.half_y[slot_usize];
    let hz = p.half_z[slot_usize];
    let min_cx = cell_xy(x - hx, cell_size);
    let max_cx = cell_xy(x + hx, cell_size);
    let min_cy = cell_xy(y - hy, cell_size);
    let max_cy = cell_xy(y + hy, cell_size);
    let min_cz = cell_z_with_bias(z - hz, cell_size);
    let max_cz = cell_z_with_bias(z + hz, cell_size);
    for cz in min_cz..=max_cz {
        for cy in min_cy..=max_cy {
            for cx in min_cx..=max_cx {
                let key = pack_contact_cell_key(cx, cy, cz);
                s.cells.entry(key).or_default().push(slot);
            }
        }
    }
}

#[wasm_bindgen]
pub fn engine_statics_remove(handle: u32, slot: u32, cell_size: f64) {
    let p = pool();
    let s = engine_statics(handle);
    let slot_usize = slot as usize;
    let x = p.pos_x[slot_usize];
    let y = p.pos_y[slot_usize];
    let z = p.pos_z[slot_usize];
    let hx = p.half_x[slot_usize];
    let hy = p.half_y[slot_usize];
    let hz = p.half_z[slot_usize];
    let min_cx = cell_xy(x - hx, cell_size);
    let max_cx = cell_xy(x + hx, cell_size);
    let min_cy = cell_xy(y - hy, cell_size);
    let max_cy = cell_xy(y + hy, cell_size);
    let min_cz = cell_z_with_bias(z - hz, cell_size);
    let max_cz = cell_z_with_bias(z + hz, cell_size);
    for cz in min_cz..=max_cz {
        for cy in min_cy..=max_cy {
            for cx in min_cx..=max_cx {
                let key = pack_contact_cell_key(cx, cy, cz);
                if let Some(bucket) = s.cells.get_mut(&key) {
                    if let Some(pos) = bucket.iter().position(|&v| v == slot) {
                        bucket.swap_remove(pos);
                    }
                    if bucket.is_empty() {
                        s.cells.remove(&key);
                    }
                }
            }
        }
    }
}

/// Phase 3f unified broadphase + sphere-cuboid resolver. JS hands
/// over a flat list of dynamic sphere slots to test, plus a parallel
/// `ignored_static_slots` array (u32::MAX = no ignore for this dyn).
/// Rust walks each dyn body's overlapping cells, dedups via the
/// per-static visit-stamp counter, runs the per-pair resolver in
/// place. wake_transitions_out is filled with slot ids of dyn
/// bodies that got pushed (one entry per dyn that hit any cuboid).
#[wasm_bindgen]
pub fn pool_resolve_sphere_cuboid_full(
    handle: u32,
    dyn_slots: &[u32],
    ignored_static_slots: &[u32],
    cell_size: f64,
    wake_transitions_out: &mut [u32],
) -> u32 {
    debug_assert_eq!(dyn_slots.len(), ignored_static_slots.len());
    debug_assert!(wake_transitions_out.len() >= dyn_slots.len());
    if dyn_slots.is_empty() || cell_size <= 0.0 {
        return 0;
    }

    let p = pool();
    let s = engine_statics(handle);
    let mut wake_count = 0_u32;

    for i in 0..dyn_slots.len() {
        let dyn_slot_u32 = dyn_slots[i];
        let dyn_slot = dyn_slot_u32 as usize;
        let ignored = ignored_static_slots[i];

        let dyn_x = p.pos_x[dyn_slot];
        let dyn_y = p.pos_y[dyn_slot];
        let dyn_z = p.pos_z[dyn_slot];
        let dyn_r = p.radius[dyn_slot];

        let min_cx = cell_xy(dyn_x - dyn_r, cell_size);
        let max_cx = cell_xy(dyn_x + dyn_r, cell_size);
        let min_cy = cell_xy(dyn_y - dyn_r, cell_size);
        let max_cy = cell_xy(dyn_y + dyn_r, cell_size);
        let min_cz = cell_z_with_bias(dyn_z - dyn_r, cell_size);
        let max_cz = cell_z_with_bias(dyn_z + dyn_r, cell_size);

        // Bump the per-static visit stamp for this dyn body's query;
        // wrapping_add handles the (vanishingly unlikely) u32 overflow
        // — old visit_stamps will just look stale across the rollover.
        s.next_stamp = s.next_stamp.wrapping_add(1);
        let stamp = s.next_stamp;
        let mut hit = false;

        for cz in min_cz..=max_cz {
            for cy in min_cy..=max_cy {
                for cx in min_cx..=max_cx {
                    let key = pack_contact_cell_key(cx, cy, cz);
                    let bucket = match s.cells.get(&key) {
                        Some(b) => b,
                        None => continue,
                    };
                    for &st_slot_u32 in bucket.iter() {
                        let st_slot = st_slot_u32 as usize;
                        if s.visit_stamps[st_slot] == stamp {
                            continue;
                        }
                        s.visit_stamps[st_slot] = stamp;
                        if st_slot_u32 == ignored {
                            continue;
                        }
                        if resolve_sphere_cuboid_pair_in_pool(p, dyn_slot, st_slot) {
                            hit = true;
                        }
                    }
                }
            }
        }

        if hit {
            wake_transitions_out[wake_count as usize] = dyn_slot_u32;
            wake_count += 1;
        }
    }

    wake_count
}

// unit_kinetics — extracted from lib.rs (pure code motion).

#[allow(unused_imports)]
use crate::*;
#[allow(unused_imports)]
use wasm_bindgen::prelude::*;

// ─────────────────────────────────────────────────────────────────
//  Phase 3e — Batched hover orientation kernel
//
//  Replaces the per-entity quatFromYawPitchRoll + quatDampedSpringStep
//  + quatYaw chain in UnitForceSystem.ts (hover branch). One WASM
//  call processes every hover entity this tick.
//
//  Buffer layout per entity (QUAT_HOVER_BATCH_STRIDE = 14 f64s):
//    0..4   orientation (x, y, z, w)             in/out
//    4..7   omega (x, y, z)                      in/out
//    7..10  target_yaw, target_pitch, target_roll  in
//    10..13 alpha (x, y, z)                      out
//    13     yaw extracted from new orientation   out
//
//  Caller responsibility: build target_yaw/pitch/roll JS-side from
//  thrust direction + body-frame velocity (as the existing TS code
//  does). The force kernel owns alpha internally, writes yaw into
//  entity.transform.rotation, and pushes snapshot dirty.
// ─────────────────────────────────────────────────────────────────

pub const QUAT_HOVER_BATCH_STRIDE: usize = 14;

#[wasm_bindgen]
pub fn quat_hover_orientation_step_batch(
    buf: &mut [f64],
    count: usize,
    k: f64,
    c: f64,
    dt_sec: f64,
) {
    debug_assert!(buf.len() >= count * QUAT_HOVER_BATCH_STRIDE);
    for i in 0..count {
        let base = i * QUAT_HOVER_BATCH_STRIDE;
        let mut orientation = [buf[base], buf[base + 1], buf[base + 2], buf[base + 3]];
        let mut omega = [buf[base + 4], buf[base + 5], buf[base + 6]];
        let target_yaw = buf[base + 7];
        let target_pitch = buf[base + 8];
        let target_roll = buf[base + 9];

        let target = quat_from_yaw_pitch_roll(target_yaw, target_pitch, target_roll);

        // Spring law: α = k · (axis·angle) − c · ω.
        let axis_angle = quat_shortest_axis_angle(orientation, target);
        let alpha_x = axis_angle[0] * k - omega[0] * c;
        let alpha_y = axis_angle[1] * k - omega[1] * c;
        let alpha_z = axis_angle[2] * k - omega[2] * c;
        omega[0] += alpha_x * dt_sec;
        omega[1] += alpha_y * dt_sec;
        omega[2] += alpha_z * dt_sec;
        quat_integrate_inplace(&mut orientation, omega, dt_sec);

        buf[base] = orientation[0];
        buf[base + 1] = orientation[1];
        buf[base + 2] = orientation[2];
        buf[base + 3] = orientation[3];
        buf[base + 4] = omega[0];
        buf[base + 5] = omega[1];
        buf[base + 6] = omega[2];
        buf[base + 10] = alpha_x;
        buf[base + 11] = alpha_y;
        buf[base + 12] = alpha_z;
        buf[base + 13] = quat_yaw(orientation);
    }
}

// ─────────────────────────────────────────────────────────────────
//  Server unit-force kernel
//
//  TypeScript gathers unit/body/terrain rows and Rust owns the per-row
//  force decisions: airborne lift, drive thrust, water-wall response,
//  idle braking, movement-acceleration output, hover orientation, and
//  BodyPool acceleration writes. TS only scatters gameplay-facing
//  state that still lives on Entity/Unit objects.
// ─────────────────────────────────────────────────────────────────

pub const UNIT_FORCE_BATCH_STRIDE: usize = 57;

// ─────────────────────────────────────────────────────────────────
//  Blueprint locomotion force profile table
//
//  The per-blueprint locomotion constants the JS pack loop used to
//  copy into every unit's force row every tick live here instead,
//  indexed by unit blueprint code. JS uploads the table once when the
//  blueprints are ready (see UnitForceSystem); the kernel resolves
//  body slot → entity slot → blueprint code and fills the constant row
//  slots before the (unchanged) force math reads them. Flags carry the
//  per-blueprint UF_FLAG facing bits. The flag table also carries
//  TypeScript-side profile metadata in higher bits; the kernel masks
//  those out before OR-ing runtime flags.
// ─────────────────────────────────────────────────────────────────

/** Direct, SI-style values: force is converted to the simulator's mass scale
 * only at F = ma. There are no hidden force multipliers or coupling factors. */
pub const UF_PROFILE_STRIDE: usize = 16;
pub(crate) const UF_PROFILE_GROUND_MAX_PROPULSIVE_FORCE: usize = 0;
pub(crate) const UF_PROFILE_GROUND_STATIC_FRICTION_COEFFICIENT: usize = 1;
pub(crate) const UF_PROFILE_GROUND_TANGENTIAL_DAMPING_RATE: usize = 2;
pub(crate) const UF_PROFILE_AIR_MAX_PROPULSIVE_FORCE: usize = 3;
pub(crate) const UF_PROFILE_AIR_BUOYANCY_RATIO: usize = 4;
pub(crate) const UF_PROFILE_AIR_SURFACE_FOLLOWING_FORCE_FROM_GROUND: usize = 5;
pub(crate) const UF_PROFILE_AIR_SURFACE_FOLLOWING_FORCE_FROM_WATER: usize = 6;
pub(crate) const UF_PROFILE_AIR_LINEAR_DAMPING_RATE: usize = 7;
pub(crate) const UF_PROFILE_AIR_ANGULAR_DAMPING_RATE: usize = 8;
pub(crate) const UF_PROFILE_WATER_MAX_PROPULSIVE_FORCE: usize = 9;
pub(crate) const UF_PROFILE_WATER_BUOYANCY_RATIO: usize = 10;
pub(crate) const UF_PROFILE_WATER_SURFACE_FOLLOWING_FORCE_FROM_GROUND: usize = 11;
pub(crate) const UF_PROFILE_WATER_LINEAR_DAMPING_RATE: usize = 12;
pub(crate) const UF_PROFILE_WATER_ANGULAR_DAMPING_RATE: usize = 13;
pub(crate) const UF_PROFILE_FATAL_WATER_FRACTION: usize = 14;
pub(crate) const UF_PROFILE_FATAL_WATER_SECONDS: usize = 15;

pub(crate) struct UnitForceProfileTable {
    pub(crate) values: Vec<f64>,
    pub(crate) flags: Vec<u32>,
    pub(crate) count: usize,
}

pub(crate) struct UnitForceRuntimeTable {
    pub(crate) entity_id: Vec<i32>,
    pub(crate) air_fraction: Vec<f64>,
    pub(crate) water_fraction: Vec<f64>,
    pub(crate) ground_contact: Vec<u8>,
    pub(crate) water_exposure_seconds: Vec<f64>,
    pub(crate) fatal_water_entity_slots: Vec<u32>,
}

pub(crate) struct UnitForceProfileTableHolder(
    ::core::cell::UnsafeCell<Option<UnitForceProfileTable>>,
);
unsafe impl Sync for UnitForceProfileTableHolder {}
pub(crate) static UNIT_FORCE_PROFILE_TABLE: UnitForceProfileTableHolder =
    UnitForceProfileTableHolder(::core::cell::UnsafeCell::new(None));
pub(crate) struct UnitForceRuntimeTableHolder(
    ::core::cell::UnsafeCell<Option<UnitForceRuntimeTable>>,
);
unsafe impl Sync for UnitForceRuntimeTableHolder {}
pub(crate) static UNIT_FORCE_RUNTIME_TABLE: UnitForceRuntimeTableHolder =
    UnitForceRuntimeTableHolder(::core::cell::UnsafeCell::new(None));

#[inline]
pub(crate) fn unit_force_profile_table() -> &'static mut UnitForceProfileTable {
    unsafe {
        let cell = &mut *UNIT_FORCE_PROFILE_TABLE.0.get();
        if cell.is_none() {
            *cell = Some(UnitForceProfileTable {
                values: Vec::new(),
                flags: Vec::new(),
                count: 0,
            });
        }
        cell.as_mut().unwrap()
    }
}

#[inline]
pub(crate) fn unit_force_runtime_table() -> &'static mut UnitForceRuntimeTable {
    unsafe {
        let cell = &mut *UNIT_FORCE_RUNTIME_TABLE.0.get();
        if cell.is_none() {
            *cell = Some(UnitForceRuntimeTable {
                entity_id: Vec::new(),
                air_fraction: Vec::new(),
                water_fraction: Vec::new(),
                ground_contact: Vec::new(),
                water_exposure_seconds: Vec::new(),
                fatal_water_entity_slots: Vec::new(),
            });
        }
        cell.as_mut().unwrap()
    }
}

#[inline]
fn unit_force_runtime_slot(
    runtime: &mut UnitForceRuntimeTable,
    es: &EntityStateSlab,
    entity_slot: Option<usize>,
) -> Option<usize> {
    let slot = entity_slot?;
    if slot >= es.entity_id.len() || es.entity_id[slot] < 0 {
        return None;
    }
    let needed = slot + 1;
    if runtime.entity_id.len() < needed {
        runtime.entity_id.resize(needed, ENTITY_STATE_NO_ENTITY_ID);
        runtime.air_fraction.resize(needed, 1.0);
        runtime.water_fraction.resize(needed, 0.0);
        runtime.ground_contact.resize(needed, 0);
        runtime.water_exposure_seconds.resize(needed, 0.0);
    }
    if runtime.entity_id[slot] != es.entity_id[slot] {
        runtime.entity_id[slot] = es.entity_id[slot];
        runtime.air_fraction[slot] = 1.0;
        runtime.water_fraction[slot] = 0.0;
        runtime.ground_contact[slot] = 0;
        runtime.water_exposure_seconds[slot] = 0.0;
    }
    Some(slot)
}

#[wasm_bindgen]
pub fn unit_force_profile_ensure(code_count: u32) {
    let table = unit_force_profile_table();
    let count = code_count as usize;
    let needed = count * UF_PROFILE_STRIDE;
    if table.values.len() < needed {
        table.values.resize(needed, 0.0);
    }
    if table.flags.len() < count {
        table.flags.resize(count, 0);
    }
    table.count = count;
}

#[wasm_bindgen]
pub fn unit_force_profile_values_ptr() -> *const f64 {
    unit_force_profile_table().values.as_ptr()
}

#[wasm_bindgen]
pub fn unit_force_profile_flags_ptr() -> *const u32 {
    unit_force_profile_table().flags.as_ptr()
}

#[wasm_bindgen]
pub fn unit_force_runtime_clear() {
    let runtime = unit_force_runtime_table();
    runtime.entity_id.fill(ENTITY_STATE_NO_ENTITY_ID);
    runtime.air_fraction.fill(1.0);
    runtime.water_fraction.fill(0.0);
    runtime.ground_contact.fill(0);
    runtime.water_exposure_seconds.fill(0.0);
    runtime.fatal_water_entity_slots.clear();
}

/// Advance fatal-water exposure for every live unit body, including sleeping
/// and otherwise inactive bodies. Returns a count into the Rust-owned entity
/// slot scratch exposed by `unit_fatal_water_entity_slots_ptr`.
#[wasm_bindgen]
pub fn unit_fatal_water_step_pool(dt_sec: f64) -> u32 {
    let p = pool();
    let es = entity_state();
    let profile = unit_force_profile_table();
    let runtime = unit_force_runtime_table();
    runtime.fatal_water_entity_slots.clear();

    for entity_slot in 0..es.entity_id.len() {
        if es.entity_id[entity_slot] < 0
            || es.kind[entity_slot] != ENTITY_STATE_KIND_UNIT
            || es.hp[entity_slot] <= 0.0
        {
            continue;
        }
        let body_slot_i32 = es.body_slot[entity_slot];
        if body_slot_i32 < 0 {
            continue;
        }
        let body_slot = body_slot_i32 as usize;
        if body_slot >= POOL_CAPACITY_USIZE
            || !pool_is_dynamic_sphere(p, body_slot)
            || unit_force_entity_slot_for_body(es, p, body_slot) != Some(entity_slot)
        {
            continue;
        }
        let code = es.unit_blueprint_code[entity_slot] as usize;
        if code >= profile.count {
            continue;
        }
        let runtime_slot = match unit_force_runtime_slot(runtime, es, Some(entity_slot)) {
            Some(slot) => slot,
            None => continue,
        };
        let pbase = code * UF_PROFILE_STRIDE;
        let water_fraction = unit_force_water_fraction(p.pos_z[body_slot], p.radius[body_slot]);
        runtime.water_fraction[runtime_slot] = water_fraction;
        runtime.air_fraction[runtime_slot] = 1.0 - water_fraction;
        let (exposure_seconds, fatal_now) = unit_force_update_water_exposure(
            runtime.water_exposure_seconds[runtime_slot],
            profile.flags[code] & UF_PROFILE_FLAG_WATER_FATAL != 0,
            water_fraction,
            profile.values[pbase + UF_PROFILE_FATAL_WATER_FRACTION],
            profile.values[pbase + UF_PROFILE_FATAL_WATER_SECONDS],
            dt_sec,
        );
        runtime.water_exposure_seconds[runtime_slot] = exposure_seconds;
        if fatal_now {
            es.hp[entity_slot] = 0.0;
            es.dirty_mask[entity_slot] |= ENTITY_CHANGED_HP;
            runtime.fatal_water_entity_slots.push(entity_slot as u32);
        }
    }
    runtime.fatal_water_entity_slots.len() as u32
}

#[wasm_bindgen]
pub fn unit_fatal_water_entity_slots_ptr() -> *const u32 {
    unit_force_runtime_table().fatal_water_entity_slots.as_ptr()
}

pub(crate) const UF_ROW_DIR_X: usize = 0;
pub(crate) const UF_ROW_DIR_Y: usize = 1;
pub(crate) const UF_ROW_ROTATION: usize = 2;
// Row 3 reserved: unit mass now comes from BodyPool inv_mass so propulsion
// cannot accidentally cancel the unit's actual physics mass.
pub(crate) const UF_ROW_GROUND_MAX_PROPULSIVE_FORCE: usize = 4;
// Passive gravity-counter ratios are constrained to [0, 1]. Their upward
// force is mass * G * ratio * fraction-of-body-in-medium.
pub(crate) const UF_ROW_AIR_BUOYANCY_RATIO: usize = 6;
pub(crate) const UF_ROW_AIR_SURFACE_FOLLOWING_FORCE_FROM_GROUND: usize = 7;
pub(crate) const UF_ROW_GROUND_Z: usize = 12;
pub(crate) const UF_ROW_NORMAL_X: usize = 13;
pub(crate) const UF_ROW_NORMAL_Y: usize = 14;
pub(crate) const UF_ROW_NORMAL_Z: usize = 15;
pub(crate) const UF_ROW_EXTERNAL_FX: usize = 16;
pub(crate) const UF_ROW_EXTERNAL_FY: usize = 17;
pub(crate) const UF_ROW_EXTERNAL_FZ: usize = 18;
pub(crate) const UF_ROW_ORIENTATION_X: usize = 19;
pub(crate) const UF_ROW_ORIENTATION_Y: usize = 20;
pub(crate) const UF_ROW_ORIENTATION_Z: usize = 21;
pub(crate) const UF_ROW_ORIENTATION_W: usize = 22;
pub(crate) const UF_ROW_OMEGA_X: usize = 23;
pub(crate) const UF_ROW_OMEGA_Y: usize = 24;
pub(crate) const UF_ROW_OMEGA_Z: usize = 25;
// Rows 26..29 are reserved by the stable JS/WASM row ABI.
pub(crate) const UF_ROW_MOVEMENT_ACCEL_X: usize = 30;
pub(crate) const UF_ROW_MOVEMENT_ACCEL_Y: usize = 31;
pub(crate) const UF_ROW_MOVEMENT_ACCEL_Z: usize = 32;
pub(crate) const UF_ROW_ANGULAR_ACCEL_X: usize = 33;
pub(crate) const UF_ROW_ANGULAR_ACCEL_Y: usize = 34;
pub(crate) const UF_ROW_ANGULAR_ACCEL_Z: usize = 35;
// ── Fully-abstracted medium force profile (appended) ──
// Rows 0..36 are unchanged. The kernel consumes these by active medium:
// ground contact, plus air/water fractions sampled from the water line.
pub(crate) const UF_ROW_GROUND_STATIC_FRICTION_COEFFICIENT: usize = 36;
pub(crate) const UF_ROW_AIR_LINEAR_DAMPING_RATE: usize = 37;
pub(crate) const UF_ROW_WATER_MAX_PROPULSIVE_FORCE: usize = 38;
pub(crate) const UF_ROW_WATER_LINEAR_DAMPING_RATE: usize = 40;
pub(crate) const UF_ROW_WATER_BUOYANCY_RATIO: usize = 41;
pub(crate) const UF_ROW_WATER_SURFACE_FOLLOWING_FORCE_FROM_GROUND: usize = 42;
pub(crate) const UF_ROW_HEADING_X: usize = 47;
pub(crate) const UF_ROW_HEADING_Y: usize = 48;
pub(crate) const UF_ROW_AIR_MAX_PROPULSIVE_FORCE: usize = 49;
pub(crate) const UF_ROW_AIR_SURFACE_FOLLOWING_FORCE_FROM_WATER: usize = 53;
pub(crate) const UF_ROW_AIR_SURFACE_FOLLOWING_PROPOSED_FORCE: usize = 55;
pub(crate) const UF_ROW_WATER_SURFACE_FOLLOWING_PROPOSED_FORCE: usize = 56;

pub(crate) const UF_FLAG_HAS_THRUST: u32 = 1 << 0;
pub(crate) const UF_FLAG_IS_FLYING: u32 = 1 << 1;
pub(crate) const UF_FLAG_IS_AIRBORNE: u32 = 1 << 2;
pub(crate) const UF_FLAG_BLOCKED_OR_DEAD: u32 = 1 << 3;
pub(crate) const UF_FLAG_HAS_EXTERNAL_FORCE: u32 = 1 << 4;
// Bits 5..6 are reserved by the stable JS/WASM flag ABI.
pub(crate) const UF_FLAG_HAS_ORIENTATION: u32 = 1 << 7;
pub(crate) const UF_FLAG_PROPULSION_BODY_FORWARD: u32 = 1 << 8;
pub(crate) const UF_FLAG_ON_GROUND: u32 = 1 << 10;
pub(crate) const UF_FLAG_HAS_AIR_SURFACE_FOLLOWING_PROPOSED_FORCE: u32 = 1 << 14;
pub(crate) const UF_FLAG_HAS_WATER_SURFACE_FOLLOWING_PROPOSED_FORCE: u32 = 1 << 15;
pub(crate) const UF_PROFILE_KERNEL_FLAG_MASK: u32 = UF_FLAG_PROPULSION_BODY_FORWARD;

pub(crate) const UF_PROFILE_FLAG_CRUISE_WHEN_UNCOMMANDED: u32 = 1 << 16;
pub(crate) const UF_PROFILE_FLAG_WATER_FATAL: u32 = 1 << 20;

pub(crate) const UF_OUT_MOVEMENT_ACCEL: u32 = 1 << 0;
pub(crate) const UF_OUT_CLEAR_COMBAT: u32 = 1 << 1;
pub(crate) const UF_OUT_ROTATION_DIRTY: u32 = 1 << 2;
pub(crate) const UF_OUT_HOVER_ORIENTATION: u32 = 1 << 3;
pub(crate) const UF_OUT_WOKE_BODY: u32 = 1 << 4;
pub(crate) const UF_OUT_ENTITY_STATE_SYNCED: u32 = 1 << 5;

const ENTITY_SLOT_UNIT_MOTION_HAS_ORIENTATION: u32 = 1 << 1;
const ENTITY_SLOT_UNIT_MOTION_HAS_ANGULAR_VELOCITY: u32 = 1 << 2;

#[inline]
pub(crate) fn unit_force_entity_slot_for_body(
    es: &EntityStateSlab,
    p: &BodyPool,
    body_slot: usize,
) -> Option<usize> {
    if body_slot >= POOL_CAPACITY_USIZE || body_slot >= es.entity_slot_by_body_slot.len() {
        return None;
    }
    let entity_slot_i32 = es.entity_slot_by_body_slot[body_slot];
    if entity_slot_i32 < 0 {
        return None;
    }
    let entity_slot = entity_slot_i32 as usize;
    if entity_slot >= es.entity_id.len() {
        return None;
    }
    if es.body_slot[entity_slot] != body_slot as i32 {
        return None;
    }
    if p.entity_id[body_slot] != es.entity_id[entity_slot] {
        return None;
    }
    Some(entity_slot)
}

const UNIT_ATTITUDE_INERTIA_FACTOR: f64 = 0.25;
const UNIT_ATTITUDE_TURN_AUTHORITY_SCALE: f64 = 1.0;
const UNIT_ATTITUDE_MAX_ANGULAR_SPEED: f64 = 2.5;
const UNIT_ATTITUDE_MIN_RADIUS: f64 = 1.0;
const UNIT_ATTITUDE_SLEEP_EPSILON_SQ: f64 = 1e-12;

#[inline]
fn unit_force_full_medium_surface_lift(
    proposed_force: f64,
) -> f64 {
    // Probes aggregate direct authored forces. Surface response is deliberately
    // deterministic: the config fixes randomization and EMA to zero.
    if proposed_force.is_finite() && proposed_force > 0.0 {
        proposed_force
    } else {
        0.0
    }
}

/** Canonical reciprocal-distance response shared by air and water surface
 * lift. Force magnitude is deliberately not an input: authored force strength
 * and distance response are independent physical quantities. */
#[wasm_bindgen]
pub fn unit_force_surface_lift_distance_response(
    distance_to_surface_world: f64,
    minimum_distance_world: f64,
) -> f64 {
    if !minimum_distance_world.is_finite() || minimum_distance_world <= 0.0 {
        return 0.0;
    }
    // Every resolved probe owns a positive distance. Points at/below the
    // surface and defensive non-finite inputs use the authored floor instead
    // of becoming zero/ignored samples.
    let raw_distance = if distance_to_surface_world.is_finite() {
        distance_to_surface_world
    } else {
        minimum_distance_world
    };
    let distance = raw_distance.max(minimum_distance_world);
    let response = 1.0 / distance;
    if response.is_finite() && response > 0.0 {
        response
    } else {
        0.0
    }
}

#[wasm_bindgen]
pub fn unit_force_water_fraction(pos_z: f64, body_radius: f64) -> f64 {
    if !pos_z.is_finite() {
        return 0.0;
    }
    let radius = if body_radius.is_finite() && body_radius > 0.0 {
        body_radius
    } else {
        0.5
    };
    let submerged_height = (TERRAIN_WATER_LEVEL - (pos_z - radius))
        .max(0.0)
        .min(2.0 * radius);
    if submerged_height <= 0.0 {
        return 0.0;
    }
    if submerged_height >= 2.0 * radius {
        return 1.0;
    }
    // Spherical-cap volume divided by total sphere volume:
    // Vcap = pi*h^2*(3r-h)/3; Vsphere = 4*pi*r^3/3.
    let fraction = submerged_height * submerged_height * (3.0 * radius - submerged_height)
        / (4.0 * radius * radius * radius);
    fraction.max(0.0).min(1.0)
}

#[inline]
fn unit_force_update_water_exposure(
    current_seconds: f64,
    water_fatal: bool,
    water_fraction: f64,
    fatal_fraction: f64,
    fatal_seconds: f64,
    dt_sec: f64,
) -> (f64, bool) {
    if !water_fatal || water_fraction < fatal_fraction.clamp(0.0, 1.0) {
        return (0.0, false);
    }
    let next_seconds = current_seconds.max(0.0) + dt_sec.max(0.0);
    (next_seconds, next_seconds >= fatal_seconds.max(0.0))
}

#[inline]
fn unit_force_fluid_drag(
    rel_vx: f64,
    rel_vy: f64,
    rel_vz: f64,
    linear_damping_rate: f64,
    occupied_fraction: f64,
    body_mass: f64,
) -> (f64, f64, f64) {
    if occupied_fraction <= 0.0 || body_mass <= 0.0 {
        return (0.0, 0.0, 0.0);
    }
    let scale = -linear_damping_rate.max(0.0) * occupied_fraction * body_mass / 1_000_000.0;
    (scale * rel_vx, scale * rel_vy, scale * rel_vz)
}

#[inline]
pub(crate) fn unit_force_project_horizontal_onto_slope(
    hx: f64,
    hy: f64,
    nx: f64,
    ny: f64,
    nz: f64,
) -> (f64, f64, f64) {
    let dot = hx * nx + hy * ny;
    let tx = hx - dot * nx;
    let ty = hy - dot * ny;
    let tz = -dot * nz;
    let mag = (tx * tx + ty * ty + tz * tz).sqrt();
    let inv = if mag > 0.0 && mag.is_finite() {
        1.0 / mag
    } else {
        1.0
    };
    (tx * inv, ty * inv, tz * inv)
}

#[inline]
pub(crate) fn unit_force_idle_brake(
    body_mass: f64,
    vx: f64,
    vy: f64,
    vz: f64,
    nx: f64,
    ny: f64,
    nz: f64,
    max_force: f64,
    dt_sec: f64,
) -> (f64, f64, f64) {
    if dt_sec <= 0.0 || max_force <= 0.0 || body_mass <= 0.0 {
        return (0.0, 0.0, 0.0);
    }

    let v_dot_n = vx * nx + vy * ny + vz * nz;
    let tangent_vx = vx - v_dot_n * nx;
    let tangent_vy = vy - v_dot_n * ny;
    let tangent_vz = vz - v_dot_n * nz;

    let slope_gravity_x = GRAVITY * nz * nx;
    let slope_gravity_y = GRAVITY * nz * ny;
    let slope_gravity_z = -GRAVITY + GRAVITY * nz * nz;

    let desired_ax = -slope_gravity_x - tangent_vx / dt_sec;
    let desired_ay = -slope_gravity_y - tangent_vy / dt_sec;
    let desired_az = -slope_gravity_z - tangent_vz / dt_sec;
    let desired_accel_mag =
        (desired_ax * desired_ax + desired_ay * desired_ay + desired_az * desired_az).sqrt();
    if desired_accel_mag <= 1e-6 || !desired_accel_mag.is_finite() {
        return (0.0, 0.0, 0.0);
    }

    let desired_force = desired_accel_mag * body_mass / 1_000_000.0;
    let scale = if desired_force > max_force {
        max_force / desired_force
    } else {
        1.0
    };
    let force_scale = body_mass / 1_000_000.0 * scale;
    (
        desired_ax * force_scale,
        desired_ay * force_scale,
        desired_az * force_scale,
    )
}

#[inline]
fn unit_force_normalize3(x: f64, y: f64, z: f64) -> Option<[f64; 3]> {
    let m = (x * x + y * y + z * z).sqrt();
    if m > 1e-9 && m.is_finite() {
        Some([x / m, y / m, z / m])
    } else {
        None
    }
}

#[inline]
fn unit_force_cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

#[inline]
fn unit_force_clamp_magnitude3(v: &mut [f64; 3], max_mag: f64) {
    if max_mag <= 0.0 || !max_mag.is_finite() {
        return;
    }
    let mag_sq = v[0] * v[0] + v[1] * v[1] + v[2] * v[2];
    let max_sq = max_mag * max_mag;
    if mag_sq > max_sq && mag_sq.is_finite() {
        let scale = max_mag / mag_sq.sqrt();
        v[0] *= scale;
        v[1] *= scale;
        v[2] *= scale;
    }
}

#[inline]
fn unit_force_water_surface_lift_distance_response(
    pos_z: f64,
    ground_z: f64,
    sampled_distance_response: f64,
    has_sampled_distance_response: bool,
    minimum_distance_world: f64,
) -> f64 {
    if has_sampled_distance_response && sampled_distance_response.is_finite() {
        return sampled_distance_response.max(0.0);
    }
    if ground_z >= TERRAIN_WATER_LEVEL {
        return 0.0;
    }
    unit_force_surface_lift_distance_response(
        pos_z - TERRAIN_WATER_LEVEL,
        minimum_distance_world,
    )
}

#[inline]
fn unit_force_quat_from_forward_up(mut forward: [f64; 3], up_raw: [f64; 3]) -> [f64; 4] {
    let up = unit_force_normalize3(up_raw[0], up_raw[1], up_raw[2]).unwrap_or([0.0, 0.0, 1.0]);
    let dot = forward[0] * up[0] + forward[1] * up[1] + forward[2] * up[2];
    forward[0] -= up[0] * dot;
    forward[1] -= up[1] * dot;
    forward[2] -= up[2] * dot;
    let x_axis = if let Some(n) = unit_force_normalize3(forward[0], forward[1], forward[2]) {
        n
    } else if up[2].abs() < 0.9 {
        unit_force_normalize3(up[1], -up[0], 0.0).unwrap_or([1.0, 0.0, 0.0])
    } else {
        [1.0, 0.0, 0.0]
    };
    let y_axis = unit_force_normalize3(
        up[1] * x_axis[2] - up[2] * x_axis[1],
        up[2] * x_axis[0] - up[0] * x_axis[2],
        up[0] * x_axis[1] - up[1] * x_axis[0],
    )
    .unwrap_or([0.0, 1.0, 0.0]);
    let z_axis = unit_force_cross(x_axis, y_axis);

    // Rotation matrix columns are local +X forward, +Y left, +Z up.
    let m00 = x_axis[0];
    let m01 = y_axis[0];
    let m02 = z_axis[0];
    let m10 = x_axis[1];
    let m11 = y_axis[1];
    let m12 = z_axis[1];
    let m20 = x_axis[2];
    let m21 = y_axis[2];
    let m22 = z_axis[2];
    let trace = m00 + m11 + m22;
    let mut q = if trace > 0.0 {
        let s = (trace + 1.0).sqrt() * 2.0;
        [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, 0.25 * s]
    } else if m00 > m11 && m00 > m22 {
        let s = (1.0 + m00 - m11 - m22).sqrt() * 2.0;
        [0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s]
    } else if m11 > m22 {
        let s = (1.0 + m11 - m00 - m22).sqrt() * 2.0;
        [(m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s]
    } else {
        let s = (1.0 + m22 - m00 - m11).sqrt() * 2.0;
        [(m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s]
    };
    quat_normalize_inplace(&mut q);
    q
}

#[inline]
fn unit_force_attitude_step(
    rows: &mut [f64],
    base: usize,
    body_mass: f64,
    radius: f64,
    coupled_force_mag: f64,
    target_up: [f64; 3],
    medium_angular_damping: f64,
    dt_sec: f64,
) -> bool {
    if dt_sec <= 0.0 || body_mass <= 0.0 {
        return false;
    }
    let mut orientation = [
        rows[base + UF_ROW_ORIENTATION_X],
        rows[base + UF_ROW_ORIENTATION_Y],
        rows[base + UF_ROW_ORIENTATION_Z],
        rows[base + UF_ROW_ORIENTATION_W],
    ];
    quat_normalize_inplace(&mut orientation);
    let mut omega = [
        rows[base + UF_ROW_OMEGA_X],
        rows[base + UF_ROW_OMEGA_Y],
        rows[base + UF_ROW_OMEGA_Z],
    ];
    let current_yaw = quat_yaw(orientation);
    let heading_x = rows[base + UF_ROW_HEADING_X];
    let heading_y = rows[base + UF_ROW_HEADING_Y];
    let heading_mag_sq = heading_x * heading_x + heading_y * heading_y;
    let (forward_x, forward_y) = if heading_mag_sq > 1e-9 && heading_mag_sq.is_finite() {
        let inv = 1.0 / heading_mag_sq.sqrt();
        (heading_x * inv, heading_y * inv)
    } else {
        (current_yaw.cos(), current_yaw.sin())
    };
    let target = unit_force_quat_from_forward_up([forward_x, forward_y, 0.0], target_up);
    let axis_angle = quat_shortest_axis_angle(orientation, target);

    let r = radius.max(UNIT_ATTITUDE_MIN_RADIUS);
    let inertia = body_mass * r * r * UNIT_ATTITUDE_INERTIA_FACTOR;
    if inertia <= 1e-9 || !inertia.is_finite() {
        return false;
    }
    let torque = coupled_force_mag.max(0.0) * r;
    let max_alpha = torque * 1_000_000.0 / inertia * UNIT_ATTITUDE_TURN_AUTHORITY_SCALE;
    if max_alpha <= 1e-9 || !max_alpha.is_finite() {
        let damp = if medium_angular_damping.is_finite() {
            (-medium_angular_damping.max(0.0) * dt_sec).exp()
        } else {
            1.0
        };
        omega[0] *= damp;
        omega[1] *= damp;
        omega[2] *= damp;
        unit_force_clamp_magnitude3(&mut omega, UNIT_ATTITUDE_MAX_ANGULAR_SPEED);
        quat_integrate_inplace(&mut orientation, omega, dt_sec);
        rows[base + UF_ROW_ORIENTATION_X] = orientation[0];
        rows[base + UF_ROW_ORIENTATION_Y] = orientation[1];
        rows[base + UF_ROW_ORIENTATION_Z] = orientation[2];
        rows[base + UF_ROW_ORIENTATION_W] = orientation[3];
        rows[base + UF_ROW_OMEGA_X] = omega[0];
        rows[base + UF_ROW_OMEGA_Y] = omega[1];
        rows[base + UF_ROW_OMEGA_Z] = omega[2];
        rows[base + UF_ROW_ANGULAR_ACCEL_X] = 0.0;
        rows[base + UF_ROW_ANGULAR_ACCEL_Y] = 0.0;
        rows[base + UF_ROW_ANGULAR_ACCEL_Z] = 0.0;
        return true;
    }

    let k = max_alpha / core::f64::consts::PI;
    let c = 2.0 * k.sqrt() + medium_angular_damping.max(0.0);
    let mut alpha = [
        axis_angle[0] * k - omega[0] * c,
        axis_angle[1] * k - omega[1] * c,
        axis_angle[2] * k - omega[2] * c,
    ];
    let alpha_mag = (alpha[0] * alpha[0] + alpha[1] * alpha[1] + alpha[2] * alpha[2]).sqrt();
    if alpha_mag > max_alpha && alpha_mag.is_finite() {
        let scale = max_alpha / alpha_mag;
        alpha[0] *= scale;
        alpha[1] *= scale;
        alpha[2] *= scale;
    }

    omega[0] += alpha[0] * dt_sec;
    omega[1] += alpha[1] * dt_sec;
    omega[2] += alpha[2] * dt_sec;
    unit_force_clamp_magnitude3(&mut omega, UNIT_ATTITUDE_MAX_ANGULAR_SPEED);
    quat_integrate_inplace(&mut orientation, omega, dt_sec);

    rows[base + UF_ROW_ORIENTATION_X] = orientation[0];
    rows[base + UF_ROW_ORIENTATION_Y] = orientation[1];
    rows[base + UF_ROW_ORIENTATION_Z] = orientation[2];
    rows[base + UF_ROW_ORIENTATION_W] = orientation[3];
    rows[base + UF_ROW_OMEGA_X] = omega[0];
    rows[base + UF_ROW_OMEGA_Y] = omega[1];
    rows[base + UF_ROW_OMEGA_Z] = omega[2];
    rows[base + UF_ROW_ANGULAR_ACCEL_X] = alpha[0];
    rows[base + UF_ROW_ANGULAR_ACCEL_Y] = alpha[1];
    rows[base + UF_ROW_ANGULAR_ACCEL_Z] = alpha[2];
    true
}

#[wasm_bindgen]
pub fn unit_force_step_batch(
    slots: &[u32],
    flags: &[u32],
    rows: &mut [f64],
    out_flags: &mut [u32],
    count: usize,
    dt_sec: f64,
    wind_x: f64,
    wind_y: f64,
    wind_z: f64,
    surface_lift_minimum_distance_world: f64,
) -> u32 {
    if slots.len() < count
        || flags.len() < count
        || out_flags.len() < count
        || rows.len() < count * UNIT_FORCE_BATCH_STRIDE
    {
        return 0;
    }

    let p = pool();
    let es = entity_state();
    let profile = unit_force_profile_table();
    let runtime = unit_force_runtime_table();
    let mut processed = 0_u32;
    let wind_x = if wind_x.is_finite() { wind_x } else { 0.0 };
    let wind_y = if wind_y.is_finite() { wind_y } else { 0.0 };
    let wind_z = if wind_z.is_finite() { wind_z } else { 0.0 };

    for i in 0..count {
        out_flags[i] = 0;
        let slot = slots[i] as usize;
        if slot >= POOL_CAPACITY_USIZE || !pool_is_dynamic_sphere(p, slot) {
            continue;
        }
        let entity_slot = unit_force_entity_slot_for_body(es, p, slot);
        let runtime_slot = unit_force_runtime_slot(runtime, es, entity_slot);

        let base = i * UNIT_FORCE_BATCH_STRIDE;
        rows[base + UF_ROW_MOVEMENT_ACCEL_X] = 0.0;
        rows[base + UF_ROW_MOVEMENT_ACCEL_Y] = 0.0;
        rows[base + UF_ROW_MOVEMENT_ACCEL_Z] = 0.0;
        rows[base + UF_ROW_ANGULAR_ACCEL_X] = 0.0;
        rows[base + UF_ROW_ANGULAR_ACCEL_Y] = 0.0;
        rows[base + UF_ROW_ANGULAR_ACCEL_Z] = 0.0;

        let mut flag = flags[i];
        let mut profile_flags = 0_u32;
        let mut air_angular_damping_rate = 0.0;
        let mut water_angular_damping_rate = 0.0;
        if flag & UF_FLAG_BLOCKED_OR_DEAD != 0 {
            out_flags[i] |= UF_OUT_MOVEMENT_ACCEL | UF_OUT_CLEAR_COMBAT;
            processed += 1;
            continue;
        }

        // Fill slab-owned input rows before the force math reads them. The
        // TypeScript pack loop still supplies terrain/support/probe rows, but
        // movement intent and blueprint constants live on native state now.
        {
            if let Some(entity_slot) = entity_slot {
                rows[base + UF_ROW_DIR_X] = es.unit_thrust_dir_x[entity_slot];
                rows[base + UF_ROW_DIR_Y] = es.unit_thrust_dir_y[entity_slot];
                rows[base + UF_ROW_HEADING_X] = es.unit_heading_dir_x[entity_slot];
                rows[base + UF_ROW_HEADING_Y] = es.unit_heading_dir_y[entity_slot];
                let code = es.unit_blueprint_code[entity_slot] as usize;
                if code < profile.count {
                    let pbase = code * UF_PROFILE_STRIDE;
                    profile_flags = profile.flags[code];
                    rows[base + UF_ROW_GROUND_MAX_PROPULSIVE_FORCE] =
                        profile.values[pbase + UF_PROFILE_GROUND_MAX_PROPULSIVE_FORCE];
                    rows[base + UF_ROW_AIR_BUOYANCY_RATIO] =
                        profile.values[pbase + UF_PROFILE_AIR_BUOYANCY_RATIO];
                    rows[base + UF_ROW_AIR_SURFACE_FOLLOWING_FORCE_FROM_GROUND] =
                        profile.values[pbase + UF_PROFILE_AIR_SURFACE_FOLLOWING_FORCE_FROM_GROUND];
                    rows[base + UF_ROW_AIR_SURFACE_FOLLOWING_FORCE_FROM_WATER] =
                        profile.values[pbase + UF_PROFILE_AIR_SURFACE_FOLLOWING_FORCE_FROM_WATER];
                    rows[base + UF_ROW_GROUND_STATIC_FRICTION_COEFFICIENT] =
                        profile.values[pbase + UF_PROFILE_GROUND_STATIC_FRICTION_COEFFICIENT];
                    rows[base + UF_ROW_AIR_LINEAR_DAMPING_RATE] =
                        profile.values[pbase + UF_PROFILE_AIR_LINEAR_DAMPING_RATE];
                    rows[base + UF_ROW_WATER_MAX_PROPULSIVE_FORCE] =
                        profile.values[pbase + UF_PROFILE_WATER_MAX_PROPULSIVE_FORCE];
                    rows[base + UF_ROW_WATER_LINEAR_DAMPING_RATE] =
                        profile.values[pbase + UF_PROFILE_WATER_LINEAR_DAMPING_RATE];
                    rows[base + UF_ROW_WATER_BUOYANCY_RATIO] =
                        profile.values[pbase + UF_PROFILE_WATER_BUOYANCY_RATIO];
                    rows[base + UF_ROW_WATER_SURFACE_FOLLOWING_FORCE_FROM_GROUND] =
                        profile.values[pbase + UF_PROFILE_WATER_SURFACE_FOLLOWING_FORCE_FROM_GROUND];
                    rows[base + UF_ROW_AIR_MAX_PROPULSIVE_FORCE] =
                        profile.values[pbase + UF_PROFILE_AIR_MAX_PROPULSIVE_FORCE];
                    air_angular_damping_rate =
                        profile.values[pbase + UF_PROFILE_AIR_ANGULAR_DAMPING_RATE];
                    water_angular_damping_rate =
                        profile.values[pbase + UF_PROFILE_WATER_ANGULAR_DAMPING_RATE];
                    p.ground_tangential_damping_rate[slot] =
                        profile.values[pbase + UF_PROFILE_GROUND_TANGENTIAL_DAMPING_RATE].max(0.0);
                    flag |= profile_flags & UF_PROFILE_KERNEL_FLAG_MASK;
                }
            }
        }

        let input_dir_len_sq = rows[base + UF_ROW_DIR_X] * rows[base + UF_ROW_DIR_X]
            + rows[base + UF_ROW_DIR_Y] * rows[base + UF_ROW_DIR_Y];
        if input_dir_len_sq > 0.0001 {
            flag |= UF_FLAG_HAS_THRUST;
        } else {
            flag &= !UF_FLAG_HAS_THRUST;
        }

        let has_thrust = flag & UF_FLAG_HAS_THRUST != 0;
        let cruise_when_uncommanded =
            profile_flags & UF_PROFILE_FLAG_CRUISE_WHEN_UNCOMMANDED != 0 || flag & UF_FLAG_IS_FLYING != 0;
        let medium_lift_enabled = flag & UF_FLAG_IS_AIRBORNE != 0;
        let has_external = flag & UF_FLAG_HAS_EXTERNAL_FORCE != 0;
        let has_orientation = flag & UF_FLAG_HAS_ORIENTATION != 0;
        let propulsion_body_forward = flag & UF_FLAG_PROPULSION_BODY_FORWARD != 0;
        let omega_sq = if has_orientation {
            rows[base + UF_ROW_OMEGA_X] * rows[base + UF_ROW_OMEGA_X]
                + rows[base + UF_ROW_OMEGA_Y] * rows[base + UF_ROW_OMEGA_Y]
                + rows[base + UF_ROW_OMEGA_Z] * rows[base + UF_ROW_OMEGA_Z]
        } else {
            0.0
        };
        let has_angular_motion = omega_sq > UNIT_ATTITUDE_SLEEP_EPSILON_SQ;
        let water_fraction = unit_force_water_fraction(p.pos_z[slot], p.radius[slot]);
        let air_fraction = 1.0 - water_fraction;
        if let Some(runtime_slot) = runtime_slot {
            runtime.air_fraction[runtime_slot] = air_fraction;
            runtime.water_fraction[runtime_slot] = water_fraction;
        }
        // Gravity countering is passive: it keeps a body awake in its
        // medium whether or not powered surface lift is enabled.
        let air_lift_force_active = air_fraction > 0.0
            && ((medium_lift_enabled
                && (rows[base + UF_ROW_AIR_SURFACE_FOLLOWING_FORCE_FROM_GROUND] > 0.0
                    || rows[base + UF_ROW_AIR_SURFACE_FOLLOWING_FORCE_FROM_WATER] > 0.0))
                || rows[base + UF_ROW_AIR_BUOYANCY_RATIO] > 0.0);
        let water_lift_force_active = water_fraction > 0.0
            && ((medium_lift_enabled
                && rows[base + UF_ROW_WATER_SURFACE_FOLLOWING_FORCE_FROM_GROUND] > 0.0)
                || rows[base + UF_ROW_WATER_BUOYANCY_RATIO] > 0.0);

        if p.flags[slot] & BODY_FLAG_SLEEPING != 0
            && !cruise_when_uncommanded
            && !has_thrust
            && !has_external
            && !has_angular_motion
            && !air_lift_force_active
            && !water_lift_force_active
        {
            continue;
        }

        let body_mass = if p.inv_mass[slot] > 0.0 {
            1.0 / p.inv_mass[slot]
        } else {
            0.0
        };
        let ground_max_propulsive_force =
            rows[base + UF_ROW_GROUND_MAX_PROPULSIVE_FORCE].max(0.0);
        let air_max_propulsive_force =
            rows[base + UF_ROW_AIR_MAX_PROPULSIVE_FORCE].max(0.0);
        let water_max_propulsive_force =
            rows[base + UF_ROW_WATER_MAX_PROPULSIVE_FORCE].max(0.0);

        let dir_x = rows[base + UF_ROW_DIR_X];
        let dir_y = rows[base + UF_ROW_DIR_Y];
        let dir_len_sq = dir_x * dir_x + dir_y * dir_y;
        let thrust_input_mag = if has_thrust && dir_len_sq > 0.0 {
            dir_len_sq.sqrt()
        } else {
            0.0
        };
        let thrust_scale = thrust_input_mag.min(1.0);
        let rotation = if rows[base + UF_ROW_ROTATION].is_finite() {
            rows[base + UF_ROW_ROTATION]
        } else {
            0.0
        };
        let forward_x = rotation.cos();
        let forward_y = rotation.sin();
        let (requested_dir_x, requested_dir_y) = if has_thrust && thrust_input_mag > 0.0 {
            let inv_dir_mag = 1.0 / thrust_input_mag;
            (dir_x * inv_dir_mag, dir_y * inv_dir_mag)
        } else {
            (0.0, 0.0)
        };
        let (drive_dir_x, drive_dir_y, has_drive_dir) = if has_thrust && thrust_input_mag > 0.0 {
            if propulsion_body_forward {
                (forward_x, forward_y, true)
            } else {
                (requested_dir_x, requested_dir_y, true)
            }
        } else {
            (0.0, 0.0, false)
        };

        let mut thrust_force_x = 0.0;
        let mut thrust_force_y = 0.0;
        let mut thrust_force_z = 0.0;
        let ground_z = rows[base + UF_ROW_GROUND_Z];
        let computed_ground_contact =
            is_in_contact(ground_z - (p.pos_z[slot] - p.ground_offset[slot]));
        let ground_contact = flag & UF_FLAG_ON_GROUND != 0 || computed_ground_contact;
        if let Some(runtime_slot) = runtime_slot {
            runtime.ground_contact[runtime_slot] = if ground_contact { 1 } else { 0 };
        }
        let air_medium_active = air_fraction > 0.0
            && (rows[base + UF_ROW_AIR_MAX_PROPULSIVE_FORCE] > 0.0
                || rows[base + UF_ROW_AIR_SURFACE_FOLLOWING_FORCE_FROM_GROUND] > 0.0
                || rows[base + UF_ROW_AIR_SURFACE_FOLLOWING_FORCE_FROM_WATER] > 0.0
                || rows[base + UF_ROW_AIR_BUOYANCY_RATIO] > 0.0
                || rows[base + UF_ROW_AIR_LINEAR_DAMPING_RATE] > 0.0);
        let water_medium_active = water_fraction > 0.0
            && (rows[base + UF_ROW_WATER_MAX_PROPULSIVE_FORCE] > 0.0
                || rows[base + UF_ROW_WATER_SURFACE_FOLLOWING_FORCE_FROM_GROUND] > 0.0
                || rows[base + UF_ROW_WATER_BUOYANCY_RATIO] > 0.0
                || rows[base + UF_ROW_WATER_LINEAR_DAMPING_RATE] > 0.0);

        if air_medium_active {
            let mut air_target_dir_x = 0.0;
            let mut air_target_dir_y = 0.0;
            let mut air_has_target_dir = false;
            let air_thrust_scale = if has_thrust {
                thrust_scale
            } else if cruise_when_uncommanded {
                1.0
            } else {
                0.0
            };
            if has_drive_dir {
                air_target_dir_x = drive_dir_x;
                air_target_dir_y = drive_dir_y;
                air_has_target_dir = true;
            } else if cruise_when_uncommanded {
                air_target_dir_x = forward_x;
                air_target_dir_y = forward_y;
                air_has_target_dir = true;
            }

            let proposed_force = if flag & UF_FLAG_HAS_AIR_SURFACE_FOLLOWING_PROPOSED_FORCE != 0
                && rows[base + UF_ROW_AIR_SURFACE_FOLLOWING_PROPOSED_FORCE].is_finite()
            {
                rows[base + UF_ROW_AIR_SURFACE_FOLLOWING_PROPOSED_FORCE].max(0.0)
            } else {
                let ground_response = unit_force_surface_lift_distance_response(
                    p.pos_z[slot] - ground_z,
                    surface_lift_minimum_distance_world,
                );
                let water_response = unit_force_water_surface_lift_distance_response(
                    p.pos_z[slot],
                    ground_z,
                    f64::NAN,
                    false,
                    surface_lift_minimum_distance_world,
                );
                rows[base + UF_ROW_AIR_SURFACE_FOLLOWING_FORCE_FROM_GROUND].max(0.0) * ground_response
                    + rows[base + UF_ROW_AIR_SURFACE_FOLLOWING_FORCE_FROM_WATER].max(0.0) * water_response
            };
            let full_medium_surface_lift = unit_force_full_medium_surface_lift(proposed_force);
            if medium_lift_enabled && full_medium_surface_lift > 0.0 {
                thrust_force_z += air_fraction * full_medium_surface_lift;
            }

            if air_has_target_dir {
                let thrust_mag =
                    air_max_propulsive_force * air_fraction * air_thrust_scale;
                if cruise_when_uncommanded || propulsion_body_forward {
                    // Aircraft-style locomotion: engine thrust follows the nose, while
                    // the requested movement direction is only the yaw target below.
                    thrust_force_x += forward_x * thrust_mag;
                    thrust_force_y += forward_y * thrust_mag;
                } else {
                    thrust_force_x += air_target_dir_x * thrust_mag;
                    thrust_force_y += air_target_dir_y * thrust_mag;
                }
            }
            let air_gravity_counter_ratio =
                rows[base + UF_ROW_AIR_BUOYANCY_RATIO].clamp(0.0, 1.0);
            if air_gravity_counter_ratio > 0.0 && body_mass > 0.0 {
                thrust_force_z +=
                    body_mass * GRAVITY * air_gravity_counter_ratio * air_fraction / 1_000_000.0;
            }

            let air_linear_damping_rate = rows[base + UF_ROW_AIR_LINEAR_DAMPING_RATE];
            if air_linear_damping_rate > 0.0 && body_mass > 0.0 {
                // Wind belongs exclusively to the occupied air volume. The
                // drag helper weights this air-relative velocity by
                // air_fraction, so the wind contribution fades continuously
                // at the waterline and is exactly zero when submerged.
                let (fx, fy, fz) = unit_force_fluid_drag(
                    p.vel_x[slot] - wind_x,
                    p.vel_y[slot] - wind_y,
                    p.vel_z[slot] - wind_z,
                    air_linear_damping_rate,
                    air_fraction,
                    body_mass,
                );
                thrust_force_x += fx;
                thrust_force_y += fy;
                thrust_force_z += fz;
            }
        }

        if water_medium_active {
            if has_drive_dir && water_max_propulsive_force > 0.0 {
                let mag =
                    water_max_propulsive_force * water_fraction * thrust_scale;
                thrust_force_x += drive_dir_x * mag;
                thrust_force_y += drive_dir_y * mag;
            }

            let lift_force_from_ground_surface =
                rows[base + UF_ROW_WATER_SURFACE_FOLLOWING_FORCE_FROM_GROUND];
            if medium_lift_enabled && lift_force_from_ground_surface > 0.0 {
                let proposed_force = if flag & UF_FLAG_HAS_WATER_SURFACE_FOLLOWING_PROPOSED_FORCE != 0
                    && rows[base + UF_ROW_WATER_SURFACE_FOLLOWING_PROPOSED_FORCE].is_finite()
                {
                    rows[base + UF_ROW_WATER_SURFACE_FOLLOWING_PROPOSED_FORCE].max(0.0)
                } else {
                    lift_force_from_ground_surface.max(0.0)
                        * unit_force_surface_lift_distance_response(
                            p.pos_z[slot] - ground_z,
                            surface_lift_minimum_distance_world,
                        )
                };
                let full_medium_surface_lift = unit_force_full_medium_surface_lift(proposed_force);
                if full_medium_surface_lift > 0.0 {
                    thrust_force_z += water_fraction * full_medium_surface_lift;
                }
            }

            let water_gravity_counter_ratio =
                rows[base + UF_ROW_WATER_BUOYANCY_RATIO].clamp(0.0, 1.0);
            if water_gravity_counter_ratio > 0.0 && body_mass > 0.0 {
                thrust_force_z +=
                    body_mass * GRAVITY * water_gravity_counter_ratio * water_fraction
                        / 1_000_000.0;
            }

            let water_linear_damping_rate = rows[base + UF_ROW_WATER_LINEAR_DAMPING_RATE];
            if water_linear_damping_rate > 0.0 && body_mass > 0.0 {
                // Water is currently a still medium. Never feed atmospheric
                // wind into this relative velocity; future currents belong in
                // a separate water-medium velocity field.
                let (fx, fy, fz) = unit_force_fluid_drag(
                    p.vel_x[slot],
                    p.vel_y[slot],
                    p.vel_z[slot],
                    water_linear_damping_rate,
                    water_fraction,
                    body_mass,
                );
                thrust_force_x += fx;
                thrust_force_y += fy;
                thrust_force_z += fz;
            }
        }

        if ground_contact {
            // Contact drive is constrained by Coulomb grip and the effective
            // normal load. Passive gravity countering unloads a submerged
            // contact patch, so a neutral bottom-walker has no dry-land grip.
            let passive_gravity_counter_ratio = air_fraction
                * rows[base + UF_ROW_AIR_BUOYANCY_RATIO].clamp(0.0, 1.0)
                + water_fraction * rows[base + UF_ROW_WATER_BUOYANCY_RATIO].clamp(0.0, 1.0);
            let normal_load =
                body_mass * GRAVITY * (1.0 - passive_gravity_counter_ratio).max(0.0) / 1_000_000.0;
            let contact_force_limit = normal_load
                * rows[base + UF_ROW_GROUND_STATIC_FRICTION_COEFFICIENT].max(0.0);
            let available_ground_force = ground_max_propulsive_force.min(contact_force_limit);
            if has_drive_dir {
                let thrust_mag = available_ground_force * thrust_scale;
                let (tx, ty, tz) = unit_force_project_horizontal_onto_slope(
                    drive_dir_x,
                    drive_dir_y,
                    rows[base + UF_ROW_NORMAL_X],
                    rows[base + UF_ROW_NORMAL_Y],
                    rows[base + UF_ROW_NORMAL_Z],
                );
                thrust_force_x += tx * thrust_mag;
                thrust_force_y += ty * thrust_mag;
                thrust_force_z += tz * thrust_mag;
            } else {
                let (fx, fy, fz) = unit_force_idle_brake(
                    body_mass,
                    p.vel_x[slot],
                    p.vel_y[slot],
                    p.vel_z[slot],
                    rows[base + UF_ROW_NORMAL_X],
                    rows[base + UF_ROW_NORMAL_Y],
                    rows[base + UF_ROW_NORMAL_Z],
                    available_ground_force,
                    dt_sec,
                );
                thrust_force_x += fx;
                thrust_force_y += fy;
                thrust_force_z += fz;
            }
        }

        if flag & UF_FLAG_HAS_ORIENTATION != 0 {
            let attitude_ground_contact = ground_contact;
            let prev_omega_x = rows[base + UF_ROW_OMEGA_X];
            let prev_omega_y = rows[base + UF_ROW_OMEGA_Y];
            let prev_omega_z = rows[base + UF_ROW_OMEGA_Z];
            let target_up = if attitude_ground_contact {
                [
                    rows[base + UF_ROW_NORMAL_X],
                    rows[base + UF_ROW_NORMAL_Y],
                    rows[base + UF_ROW_NORMAL_Z],
                ]
            } else {
                [0.0, 0.0, 1.0]
            };
            let mut angular_damping = 0.0;
            if attitude_ground_contact {
                angular_damping += rows[base + UF_ROW_GROUND_STATIC_FRICTION_COEFFICIENT].max(0.0);
            }
            angular_damping += air_fraction * air_angular_damping_rate.max(0.0);
            angular_damping += water_fraction * water_angular_damping_rate.max(0.0);
            let attitude_max_propulsive_force = (if attitude_ground_contact {
                ground_max_propulsive_force
            } else {
                0.0
            }) + air_fraction * air_max_propulsive_force
                + water_fraction * water_max_propulsive_force;

            if unit_force_attitude_step(
                rows,
                base,
                body_mass,
                p.radius[slot],
                attitude_max_propulsive_force,
                target_up,
                angular_damping,
                dt_sec,
            ) {
                out_flags[i] |= UF_OUT_HOVER_ORIENTATION;
                let omega_changed = (prev_omega_x - rows[base + UF_ROW_OMEGA_X]).abs() > 1e-9
                    || (prev_omega_y - rows[base + UF_ROW_OMEGA_Y]).abs() > 1e-9
                    || (prev_omega_z - rows[base + UF_ROW_OMEGA_Z]).abs() > 1e-9;
                let next_omega_sq = rows[base + UF_ROW_OMEGA_X] * rows[base + UF_ROW_OMEGA_X]
                    + rows[base + UF_ROW_OMEGA_Y] * rows[base + UF_ROW_OMEGA_Y]
                    + rows[base + UF_ROW_OMEGA_Z] * rows[base + UF_ROW_OMEGA_Z];
                let angular_accel_sq = rows[base + UF_ROW_ANGULAR_ACCEL_X]
                    * rows[base + UF_ROW_ANGULAR_ACCEL_X]
                    + rows[base + UF_ROW_ANGULAR_ACCEL_Y] * rows[base + UF_ROW_ANGULAR_ACCEL_Y]
                    + rows[base + UF_ROW_ANGULAR_ACCEL_Z] * rows[base + UF_ROW_ANGULAR_ACCEL_Z];
                if next_omega_sq > UNIT_ATTITUDE_SLEEP_EPSILON_SQ
                    || angular_accel_sq > UNIT_ATTITUDE_SLEEP_EPSILON_SQ
                {
                    if p.flags[slot] & BODY_FLAG_SLEEPING != 0 {
                        out_flags[i] |= UF_OUT_WOKE_BODY;
                    } else {
                        p.sleep_ticks[slot] = 0.0;
                    }
                }
                let next_rotation = quat_yaw([
                    rows[base + UF_ROW_ORIENTATION_X],
                    rows[base + UF_ROW_ORIENTATION_Y],
                    rows[base + UF_ROW_ORIENTATION_Z],
                    rows[base + UF_ROW_ORIENTATION_W],
                ]);
                let mut synced_dirty_mask = if omega_changed { ENTITY_CHANGED_VEL } else { 0 };
                if next_rotation != rows[base + UF_ROW_ROTATION] {
                    rows[base + UF_ROW_ROTATION] = next_rotation;
                    out_flags[i] |= UF_OUT_ROTATION_DIRTY;
                    synced_dirty_mask |= ENTITY_CHANGED_ROT;
                }
                if let Some(entity_slot) = entity_slot {
                    es.orientation_x[entity_slot] = rows[base + UF_ROW_ORIENTATION_X];
                    es.orientation_y[entity_slot] = rows[base + UF_ROW_ORIENTATION_Y];
                    es.orientation_z[entity_slot] = rows[base + UF_ROW_ORIENTATION_Z];
                    es.orientation_w[entity_slot] = rows[base + UF_ROW_ORIENTATION_W];
                    es.angular_velocity_x[entity_slot] = rows[base + UF_ROW_OMEGA_X];
                    es.angular_velocity_y[entity_slot] = rows[base + UF_ROW_OMEGA_Y];
                    es.angular_velocity_z[entity_slot] = rows[base + UF_ROW_OMEGA_Z];
                    es.rotation[entity_slot] = rows[base + UF_ROW_ROTATION];
                    es.unit_motion_flags[entity_slot] |= ENTITY_SLOT_UNIT_MOTION_HAS_ORIENTATION
                        | ENTITY_SLOT_UNIT_MOTION_HAS_ANGULAR_VELOCITY;
                    if synced_dirty_mask != 0 {
                        es.dirty_mask[entity_slot] |= synced_dirty_mask;
                        out_flags[i] |= UF_OUT_ENTITY_STATE_SYNCED;
                    }
                }
            }
        }

        let external_fx = if has_external {
            rows[base + UF_ROW_EXTERNAL_FX] / 3600.0
        } else {
            0.0
        };
        let external_fy = if has_external {
            rows[base + UF_ROW_EXTERNAL_FY] / 3600.0
        } else {
            0.0
        };
        let external_fz = if has_external {
            rows[base + UF_ROW_EXTERNAL_FZ] / 3600.0
        } else {
            0.0
        };
        let total_force_x = thrust_force_x + external_fx;
        let total_force_y = thrust_force_y + external_fy;
        let total_force_z = thrust_force_z + external_fz;

        if !total_force_x.is_finite() || !total_force_y.is_finite() || !total_force_z.is_finite() {
            continue;
        }

        let movement_accel_scale = p.inv_mass[slot] * 1_000_000.0;
        rows[base + UF_ROW_MOVEMENT_ACCEL_X] = thrust_force_x * movement_accel_scale;
        rows[base + UF_ROW_MOVEMENT_ACCEL_Y] = thrust_force_y * movement_accel_scale;
        rows[base + UF_ROW_MOVEMENT_ACCEL_Z] = thrust_force_z * movement_accel_scale;
        out_flags[i] |= UF_OUT_MOVEMENT_ACCEL;
        if total_force_x != 0.0 || total_force_y != 0.0 || total_force_z != 0.0 {
            if p.flags[slot] & BODY_FLAG_SLEEPING != 0 {
                out_flags[i] |= UF_OUT_WOKE_BODY;
            } else {
                p.sleep_ticks[slot] = 0.0;
            }
            p.accel_x[slot] += total_force_x * 1_000_000.0 * p.inv_mass[slot];
            p.accel_y[slot] += total_force_y * 1_000_000.0 * p.inv_mass[slot];
            p.accel_z[slot] += total_force_z * 1_000_000.0 * p.inv_mass[slot];
        }

        processed += 1;
    }

    processed
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_near(actual: f64, expected: f64) {
        assert!(
            (actual - expected).abs() <= 1e-9,
            "expected {expected}, got {actual}"
        );
    }

    #[test]
    fn surface_following_uses_the_direct_aggregate() {
        assert_near(unit_force_full_medium_surface_lift(25.0), 25.0);
        assert_near(unit_force_full_medium_surface_lift(-1.0), 0.0);
        let minimum_response = 1.0 / 0.5;
        assert_near(
            unit_force_surface_lift_distance_response(-10.0, 0.5),
            minimum_response,
        );
        assert_near(
            unit_force_surface_lift_distance_response(f64::NAN, 0.5),
            minimum_response,
        );
    }

    #[test]
    fn water_surface_lift_distance_response_requires_exposed_water() {
        assert_near(
            unit_force_water_surface_lift_distance_response(
                TERRAIN_WATER_LEVEL + 10.0,
                TERRAIN_WATER_LEVEL - 20.0,
                f64::NAN,
                false,
                0.5,
            ),
            1.0 / 10.0,
        );
        assert_near(
            unit_force_water_surface_lift_distance_response(
                TERRAIN_WATER_LEVEL + 10.0,
                TERRAIN_WATER_LEVEL + 1.0,
                f64::NAN,
                false,
                0.5,
            ),
            0.0,
        );
    }

    #[test]
    fn spherical_water_fraction_uses_displaced_volume() {
        let radius = 10.0;
        assert_near(
            unit_force_water_fraction(TERRAIN_WATER_LEVEL + radius, radius),
            0.0,
        );
        assert_near(unit_force_water_fraction(TERRAIN_WATER_LEVEL, radius), 0.5);
        assert_near(
            unit_force_water_fraction(
                TERRAIN_WATER_LEVEL + radius * 0.347_296_355_333_860_6,
                radius,
            ),
            0.25,
        );
        assert_near(
            unit_force_water_fraction(TERRAIN_WATER_LEVEL - radius, radius),
            1.0,
        );
        // A cap half a radius deep occupies 5/32 of a sphere. This catches
        // regressions to the old linear depth fraction.
        assert_near(
            unit_force_water_fraction(TERRAIN_WATER_LEVEL + radius * 0.5, radius),
            5.0 / 32.0,
        );
    }

    #[test]
    fn fluid_drag_is_isotropic_and_occupancy_weighted() {
        let full = unit_force_fluid_drag(10.0, -5.0, 2.0, 3.0, 1.0, 1_000.0);
        let half = unit_force_fluid_drag(10.0, -5.0, 2.0, 3.0, 0.5, 1_000.0);
        assert_near(full.0, -0.03);
        assert_near(full.1, 0.015);
        assert_near(full.2, -0.006);
        assert_near(half.0, full.0 * 0.5);
    }

    #[test]
    fn fatal_water_exposure_has_grace_and_resets_below_threshold() {
        let (first, fatal_first) =
            unit_force_update_water_exposure(0.0, true, 0.75, 0.65, 2.0, 1.25);
        assert_near(first, 1.25);
        assert!(!fatal_first);

        let (reset, fatal_reset) =
            unit_force_update_water_exposure(first, true, 0.5, 0.65, 2.0, 0.5);
        assert_near(reset, 0.0);
        assert!(!fatal_reset);

        let (fatal_elapsed, fatal_now) =
            unit_force_update_water_exposure(1.25, true, 0.75, 0.65, 2.0, 0.75);
        assert_near(fatal_elapsed, 2.0);
        assert!(fatal_now);
    }
}

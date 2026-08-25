// unit_kinetics — extracted from lib.rs (pure code motion).

#[allow(unused_imports)]
use crate::*;
#[allow(unused_imports)]
use wasm_bindgen::prelude::*;

// ─────────────────────────────────────────────────────────────────
//  Server unit-force kernel
//
//  TypeScript gathers unit/body/terrain rows and Rust owns the per-row
//  force decisions: airborne lift, drive thrust, water-wall response,
//  idle braking, movement-acceleration output, hover orientation, and
//  BodyPool acceleration writes. TS only scatters gameplay-facing
//  state that still lives on Entity/Unit objects.
// ─────────────────────────────────────────────────────────────────

pub const UNIT_FORCE_BATCH_STRIDE: usize = 59;

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
pub(crate) const UF_PROFILE_AIR_SURFACE_FOLLOWING_INVERSE_FORCE_FROM_GROUND: usize = 4;
pub(crate) const UF_PROFILE_AIR_SURFACE_FOLLOWING_INVERSE_FORCE_FROM_WATER: usize = 5;
pub(crate) const UF_PROFILE_AIR_LINEAR_DAMPING_RATE: usize = 6;
pub(crate) const UF_PROFILE_AIR_ANGULAR_DAMPING_RATE: usize = 7;
pub(crate) const UF_PROFILE_WATER_MAX_PROPULSIVE_FORCE: usize = 8;
pub(crate) const UF_PROFILE_WATER_SURFACE_FOLLOWING_INVERSE_FORCE_FROM_GROUND: usize = 9;
pub(crate) const UF_PROFILE_WATER_SURFACE_FOLLOWING_PROPORTIONAL_FORCE_FROM_WATER: usize = 10;
pub(crate) const UF_PROFILE_WATER_LINEAR_DAMPING_RATE: usize = 11;
pub(crate) const UF_PROFILE_WATER_ANGULAR_DAMPING_RATE: usize = 12;
pub(crate) const UF_PROFILE_WATER_DAMAGE_PER_SECOND: usize = 13;
/// Authored constant-rate yaw slew (rad/s) for `alwaysForward` chassis; 0 for
/// every other actuator, which keeps the critically damped attitude servo.
pub(crate) const UF_PROFILE_TURN_RATE_RAD_PER_SEC: usize = 14;
pub(crate) const UF_PROFILE_GROUND_ANGULAR_DAMPING_RATE: usize = 15;

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
    /// Previous force-kernel tick's actual Coulomb-clamped ground authority.
    /// Arrival steering consumes this instead of reconstructing `mu*m*g` on
    /// a fictitious level surface.
    pub(crate) available_ground_force: Vec<f64>,
    pub(crate) water_damaged_entity_slots: Vec<u32>,
}

pub(crate) static UNIT_FORCE_PROFILE_TABLE: WasmLazy<UnitForceProfileTable> = WasmLazy::new();
pub(crate) static UNIT_FORCE_RUNTIME_TABLE: WasmLazy<UnitForceRuntimeTable> = WasmLazy::new();

#[inline]
pub(crate) fn unit_force_profile_table() -> &'static mut UnitForceProfileTable {
    UNIT_FORCE_PROFILE_TABLE.get_or_init(|| UnitForceProfileTable {
        values: Vec::new(),
        flags: Vec::new(),
        count: 0,
    })
}

#[inline]
pub(crate) fn unit_force_runtime_table() -> &'static mut UnitForceRuntimeTable {
    UNIT_FORCE_RUNTIME_TABLE.get_or_init(|| UnitForceRuntimeTable {
        entity_id: Vec::new(),
        air_fraction: Vec::new(),
        water_fraction: Vec::new(),
        ground_contact: Vec::new(),
        available_ground_force: Vec::new(),
        water_damaged_entity_slots: Vec::new(),
    })
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
        runtime.available_ground_force.resize(needed, 0.0);
    }
    if runtime.entity_id[slot] != es.entity_id[slot] {
        runtime.entity_id[slot] = es.entity_id[slot];
        runtime.air_fraction[slot] = 1.0;
        runtime.water_fraction[slot] = 0.0;
        runtime.ground_contact[slot] = 0;
        runtime.available_ground_force[slot] = 0.0;
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
    runtime.available_ground_force.fill(0.0);
    runtime.water_damaged_entity_slots.clear();
}

/// Apply authored water damage to every live unit body, including sleeping
/// and otherwise inactive bodies. The sole hazard sample is the authoritative
/// body origin: any origin strictly below the water plane is submerged.
#[wasm_bindgen]
pub fn unit_water_damage_step_pool(dt_sec: f64) -> u32 {
    let p = pool();
    let es = entity_state();
    let profile = unit_force_profile_table();
    let runtime = unit_force_runtime_table();
    runtime.water_damaged_entity_slots.clear();

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
        // P1-17: the immersion fractions above are load-bearing side outputs
        // (buoyancy reads them), so every live unit keeps its fraction
        // write — but water-safe profiles (zero authored rate) skip the
        // damage math entirely.
        let rate = profile.values[pbase + UF_PROFILE_WATER_DAMAGE_PER_SECOND];
        if rate <= 0.0 {
            continue;
        }
        let damage = unit_water_damage_for_step(p.pos_z[body_slot], rate, dt_sec);
        if damage > 0.0 {
            es.hp[entity_slot] = (es.hp[entity_slot] - damage).max(0.0);
            es.dirty_mask[entity_slot] |= ENTITY_CHANGED_HP;
            runtime.water_damaged_entity_slots.push(entity_slot as u32);
        }
    }
    runtime.water_damaged_entity_slots.len() as u32
}

#[wasm_bindgen]
pub fn unit_water_damaged_entity_slots_ptr() -> *const u32 {
    unit_force_runtime_table()
        .water_damaged_entity_slots
        .as_ptr()
}

pub(crate) const UF_ROW_DIR_X: usize = 0;
pub(crate) const UF_ROW_DIR_Y: usize = 1;
pub(crate) const UF_ROW_ROTATION: usize = 2;
// Row 3 reserved: unit mass now comes from BodyPool inv_mass so propulsion
// cannot accidentally cancel the unit's actual physics mass.
pub(crate) const UF_ROW_GROUND_MAX_PROPULSIVE_FORCE: usize = 4;
pub(crate) const UF_ROW_AIR_SURFACE_FOLLOWING_INVERSE_FORCE_FROM_GROUND: usize = 7;
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
pub(crate) const UF_ROW_WATER_SURFACE_FOLLOWING_INVERSE_FORCE_FROM_GROUND: usize = 42;
pub(crate) const UF_ROW_HEADING_X: usize = 47;
pub(crate) const UF_ROW_HEADING_Y: usize = 48;
pub(crate) const UF_ROW_AIR_MAX_PROPULSIVE_FORCE: usize = 49;
pub(crate) const UF_ROW_AIR_SURFACE_FOLLOWING_INVERSE_FORCE_FROM_WATER: usize = 53;
pub(crate) const UF_ROW_AIR_SURFACE_FOLLOWING_INVERSE_PROPOSED_FORCE: usize = 55;
pub(crate) const UF_ROW_WATER_SURFACE_FOLLOWING_INVERSE_PROPOSED_FORCE: usize = 56;
pub(crate) const UF_ROW_WATER_SURFACE_FOLLOWING_PROPORTIONAL_FORCE_FROM_WATER: usize = 57;
pub(crate) const UF_ROW_WATER_SURFACE_FOLLOWING_PROPORTIONAL_PROPOSED_FORCE: usize = 58;

pub(crate) const UF_FLAG_HAS_THRUST: u32 = 1 << 0;
pub(crate) const UF_FLAG_IS_AIRBORNE_CRUISING: u32 = 1 << 1;
pub(crate) const UF_FLAG_IS_AIRBORNE: u32 = 1 << 2;
pub(crate) const UF_FLAG_BLOCKED_OR_DEAD: u32 = 1 << 3;
pub(crate) const UF_FLAG_HAS_EXTERNAL_FORCE: u32 = 1 << 4;
// Bits 5..6 are reserved by the stable JS/WASM flag ABI.
pub(crate) const UF_FLAG_HAS_ORIENTATION: u32 = 1 << 7;
pub(crate) const UF_FLAG_PROPULSION_BODY_FORWARD: u32 = 1 << 8;
pub(crate) const UF_FLAG_PROPULSION_FORWARD_ONLY: u32 = 1 << 9;
pub(crate) const UF_FLAG_ON_GROUND: u32 = 1 << 10;
/// `alwaysForward` actuator (plane, aerosub): full throttle along the nose
/// every tick — the request only aims the yaw servo. Forward flight may
/// turn, but it may never stop accelerating forward.
pub(crate) const UF_FLAG_PROPULSION_ALWAYS_FORWARD: u32 = 1 << 11;
pub(crate) const UF_FLAG_HAS_AIR_SURFACE_FOLLOWING_INVERSE_PROPOSED_FORCE: u32 = 1 << 14;
pub(crate) const UF_FLAG_HAS_WATER_SURFACE_FOLLOWING_INVERSE_PROPOSED_FORCE: u32 = 1 << 15;
pub(crate) const UF_FLAG_HAS_WATER_SURFACE_FOLLOWING_PROPORTIONAL_PROPOSED_FORCE: u32 = 1 << 17;
pub(crate) const UF_PROFILE_KERNEL_FLAG_MASK: u32 = UF_FLAG_PROPULSION_BODY_FORWARD
    | UF_FLAG_PROPULSION_FORWARD_ONLY
    | UF_FLAG_PROPULSION_ALWAYS_FORWARD;

pub(crate) const UF_PROFILE_FLAG_CRUISE_WHEN_UNCOMMANDED: u32 = 1 << 16;

pub(crate) const UF_OUT_MOVEMENT_ACCEL: u32 = 1 << 0;
pub(crate) const UF_OUT_CLEAR_COMBAT: u32 = 1 << 1;
pub(crate) const UF_OUT_ROTATION_DIRTY: u32 = 1 << 2;
pub(crate) const UF_OUT_HOVER_ORIENTATION: u32 = 1 << 3;
pub(crate) const UF_OUT_WOKE_BODY: u32 = 1 << 4;
pub(crate) const UF_OUT_ENTITY_STATE_SYNCED: u32 = 1 << 5;

pub(crate) const ENTITY_SLOT_UNIT_MOTION_HAS_ORIENTATION: u32 = 1 << 1;
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

// Dynamic unit bodies are modeled as solid spheres. Their attitude servo uses
// that body's actual moment of inertia instead of an independently tuned turn
// rate: I = 2/5 m r^2.
const UNIT_ATTITUDE_INERTIA_FACTOR: f64 = 2.0 / 5.0;
// Closed-loop response time relative to the fastest critically damped response
// the available steering torque could support. Doubling time halves every
// angular rate while preserving force/mass/radius ordering and no speed cap.
const UNIT_ATTITUDE_RESPONSE_TIME_SCALE: f64 = 2.0;
const UNIT_ATTITUDE_MIN_RADIUS: f64 = 1.0;
const UNIT_ATTITUDE_SLEEP_EPSILON_SQ: f64 = 1e-12;

#[inline]
fn unit_force_full_medium_surface_lift(proposed_force: f64) -> f64 {
    // Probes aggregate direct authored forces. Surface response is deliberately
    // deterministic: the config fixes randomization and EMA to zero.
    if proposed_force.is_finite() && proposed_force > 0.0 {
        proposed_force
    } else {
        0.0
    }
}

/// Apply a positive full-medium physics value to the part of a body that
/// occupies that medium. Air and water are complementary volume fractions,
/// not mutually exclusive modes, so this is shared by propulsion, lift, and
/// angular resistance.
#[inline]
pub(crate) fn unit_force_occupancy_weighted_positive_value(
    full_medium_value: f64,
    occupied_fraction: f64,
) -> f64 {
    if !full_medium_value.is_finite() || !occupied_fraction.is_finite() {
        return 0.0;
    }
    full_medium_value.max(0.0) * occupied_fraction.clamp(0.0, 1.0)
}

/** Canonical reciprocal-distance response shared by air and water surface
 * lift. Force magnitude is deliberately not an input: authored force strength
 * and distance response are independent physical quantities. */
#[wasm_bindgen]
pub fn unit_force_surface_lift_inverse_distance_response(
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

/** Canonical proportional water-surface response. It is depth below the
 * water plane, so it is zero at/above the plane and has no artificial floor. */
#[wasm_bindgen]
pub fn unit_force_water_surface_depth_world(pos_z: f64) -> f64 {
    if !pos_z.is_finite() {
        return 0.0;
    }
    let depth = TERRAIN_WATER_LEVEL - pos_z;
    if depth.is_finite() && depth > 0.0 {
        depth
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
fn unit_water_damage_for_step(origin_z: f64, damage_per_second: f64, dt_sec: f64) -> f64 {
    if !origin_z.is_finite() || origin_z >= TERRAIN_WATER_LEVEL {
        return 0.0;
    }
    damage_per_second.max(0.0) * dt_sec.max(0.0)
}

#[inline]
fn unit_force_fluid_damping_force(
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

/// A directed air or water force that meets a supporting surface cannot keep
/// pushing through that surface. Resolve its horizontal drive direction along
/// the contact tangent, exactly as ground drive does; this gives an
/// amphibious unit an uphill component while it still has fluid drive at the
/// shoreline.
#[inline]
fn unit_force_planar_drive_direction_for_contact(
    ground_contact: bool,
    dir_x: f64,
    dir_y: f64,
    normal_x: f64,
    normal_y: f64,
    normal_z: f64,
) -> (f64, f64, f64) {
    if ground_contact {
        unit_force_project_horizontal_onto_slope(dir_x, dir_y, normal_x, normal_y, normal_z)
    } else {
        (dir_x, dir_y, 0.0)
    }
}

/// Static contact load from the component of weight and all already-known
/// non-contact forces normal to the support. This is the Coulomb `N` used by
/// both physical traction and the pathfinder's force envelope: on a slope the
/// weight contribution is `m g cos(theta)`, upward lift unloads the contact,
/// and a force into the surface increases it.
#[inline]
pub(crate) fn unit_force_contact_normal_load(
    gravity_force: f64,
    normal_x: f64,
    normal_y: f64,
    normal_z: f64,
    non_contact_force_x: f64,
    non_contact_force_y: f64,
    non_contact_force_z: f64,
) -> f64 {
    if !gravity_force.is_finite()
        || !normal_x.is_finite()
        || !normal_y.is_finite()
        || !normal_z.is_finite()
        || !non_contact_force_x.is_finite()
        || !non_contact_force_y.is_finite()
        || !non_contact_force_z.is_finite()
    {
        return 0.0;
    }
    let weight_into_surface = gravity_force.max(0.0) * normal_z.max(0.0);
    let force_out_of_surface = non_contact_force_x * normal_x
        + non_contact_force_y * normal_y
        + non_contact_force_z * normal_z;
    (weight_into_surface - force_out_of_surface).max(0.0)
}

/// Ground's occupancy: the fraction of the body's weight the contact actually
/// carries. This is the ground analogue of the air/water displaced-volume
/// fractions, so every medium contributes an additive, continuously weighted
/// term instead of one medium switching another off. Upward medium support
/// already unloads `normal_load`, so a neutrally buoyant hull grazing a slope
/// lands at ~0 and a body resting its full weight on the surface lands at 1.
#[inline]
pub(crate) fn unit_force_ground_occupancy(normal_load: f64, gravity_force: f64) -> f64 {
    if !normal_load.is_finite() || !gravity_force.is_finite() || gravity_force <= 0.0 {
        return 0.0;
    }
    (normal_load / gravity_force).clamp(0.0, 1.0)
}

/// Occupancy-weighted leveling target: the contact normal at full ground
/// occupancy, world up at zero, and the normalized sum in between. Falls back
/// to world up when the blend degenerates.
#[inline]
pub(crate) fn unit_force_attitude_target_up(
    normal_x: f64,
    normal_y: f64,
    normal_z: f64,
    ground_occupancy: f64,
) -> [f64; 3] {
    let w = ground_occupancy.clamp(0.0, 1.0);
    if w <= 0.0 || !normal_x.is_finite() || !normal_y.is_finite() || !normal_z.is_finite() {
        return [0.0, 0.0, 1.0];
    }
    let x = normal_x * w;
    let y = normal_y * w;
    let z = normal_z * w + (1.0 - w);
    unit_force_normalize3(x, y, z).unwrap_or([0.0, 0.0, 1.0])
}

/// Split the Coulomb-limited ground drive budget between cross-track slope
/// hold and along-track propulsion. The lateral (perpendicular-to-command)
/// component of slope gravity is cancelled first, at full authority — a
/// tracked or legged contact patch resists sideways sliding with the same
/// grip it drives with, and neither a formation speed factor nor a
/// body-forward cos-throttle should surrender that grip. Whatever authority
/// remains in quadrature drives along the commanded tangent, scaled by the
/// throttle. Along-track gravity is deliberately NOT compensated: climbing
/// spends it and descending keeps it, exactly as the pathfinder's edge-cost
/// model prices legs (lateral hold reserved, longitudinal = sqrt(B² − L²),
/// uphill minus g·sinθ).
#[inline]
pub(crate) fn unit_force_ground_drive_forces(
    drive_dir_x: f64,
    drive_dir_y: f64,
    throttle: f64,
    nx: f64,
    ny: f64,
    nz: f64,
    available_ground_force: f64,
    body_mass: f64,
) -> (f64, f64, f64) {
    let (tx, ty, tz) =
        unit_force_project_horizontal_onto_slope(drive_dir_x, drive_dir_y, nx, ny, nz);
    // Tangential (downslope) component of gravity, as acceleration.
    let sg_x = GRAVITY * nz * nx;
    let sg_y = GRAVITY * nz * ny;
    let sg_z = -GRAVITY + GRAVITY * nz * nz;
    // Cross-track share of that acceleration.
    let sg_dot_t = sg_x * tx + sg_y * ty + sg_z * tz;
    let lat_x = sg_x - sg_dot_t * tx;
    let lat_y = sg_y - sg_dot_t * ty;
    let lat_z = sg_z - sg_dot_t * tz;
    let lat_accel = (lat_x * lat_x + lat_y * lat_y + lat_z * lat_z).sqrt();
    let budget = available_ground_force.max(0.0);
    let hold_force = if lat_accel > 1.0e-12 && body_mass > 0.0 && lat_accel.is_finite() {
        (lat_accel * body_mass / 1_000_000.0).min(budget)
    } else {
        0.0
    };
    let longitudinal_budget = (budget * budget - hold_force * hold_force).max(0.0).sqrt();
    let thrust_mag = longitudinal_budget * throttle;
    let mut fx = tx * thrust_mag;
    let mut fy = ty * thrust_mag;
    let mut fz = tz * thrust_mag;
    if hold_force > 0.0 {
        let inv = 1.0 / lat_accel;
        fx -= lat_x * inv * hold_force;
        fy -= lat_y * inv * hold_force;
        fz -= lat_z * inv * hold_force;
    }
    (fx, fy, fz)
}

/// Convert a world-space movement request into a body-forward drive decision.
/// Bidirectional actuators use signed throttle, so a request opposite the nose
/// supplies reverse thrust. Forward-only actuators instead disable powered
/// drive at and behind the lateral plane. On ground that hands the tick to the
/// bounded idle brake while the attitude servo turns toward the requested
/// heading; it can stop existing motion but cannot accelerate into reverse.
#[inline]
fn unit_force_body_forward_drive_request(
    requested_dir_x: f64,
    requested_dir_y: f64,
    forward_x: f64,
    forward_y: f64,
    thrust_scale: f64,
    forward_only: bool,
) -> (bool, f64) {
    let projection = requested_dir_x * forward_x + requested_dir_y * forward_y;
    let throttle = projection.clamp(-1.0, 1.0) * thrust_scale.clamp(0.0, 1.0);
    if forward_only && throttle <= 0.0 {
        (false, 0.0)
    } else {
        (true, throttle)
    }
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
fn unit_force_air_water_surface_inverse_distance_response(
    support_z: f64,
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
    unit_force_surface_lift_inverse_distance_response(
        support_z - TERRAIN_WATER_LEVEL,
        minimum_distance_world,
    )
}

/// Steering is allowed to redirect only force the active locomotion media can
/// actually supply. One body-weight is the conservative upper bound for that
/// lateral control force; this bounds angular acceleration without imposing a
/// shared angular-speed ceiling. Large bodies remain slow because the same
/// edge force must rotate a moment of inertia proportional to m*r^2.
#[inline]
pub(crate) fn unit_force_attitude_control_force(body_mass: f64, available_force: f64) -> f64 {
    if !body_mass.is_finite() || body_mass <= 0.0 || !available_force.is_finite() {
        return 0.0;
    }
    let body_weight_force = body_mass * GRAVITY / 1_000_000.0;
    available_force.max(0.0).min(body_weight_force)
}

#[inline]
pub(crate) fn unit_force_attitude_max_angular_acceleration(
    body_mass: f64,
    radius: f64,
    control_force: f64,
) -> f64 {
    if !body_mass.is_finite() || body_mass <= 0.0 || !control_force.is_finite() {
        return 0.0;
    }
    let r = radius.max(UNIT_ATTITUDE_MIN_RADIUS);
    let inertia = body_mass * r * r * UNIT_ATTITUDE_INERTIA_FACTOR;
    let torque = control_force.max(0.0) * r;
    let alpha = torque * 1_000_000.0 / inertia;
    if alpha.is_finite() {
        alpha
    } else {
        0.0
    }
}

#[inline]
pub(crate) fn unit_force_attitude_spring_gain(max_alpha: f64) -> f64 {
    max_alpha.max(0.0)
        / (core::f64::consts::PI
            * UNIT_ATTITUDE_RESPONSE_TIME_SCALE
            * UNIT_ATTITUDE_RESPONSE_TIME_SCALE)
}

/// Exact integration of one component of the body's damped attitude error.
///
/// This is deliberately local to the body-attitude controller. Weapon and work
/// joints use the bounded articulation motor in `articulation.rs`; preserving
/// this oscillator here does not reintroduce the retired turret-spring path.
#[inline]
fn unit_force_damped_attitude_component(
    angle: f64,
    angular_velocity: f64,
    spring_gain: f64,
    damping: f64,
    dt_sec: f64,
) -> (f64, f64) {
    let safe_dt = if dt_sec.is_finite() { dt_sec.max(0.0) } else { 0.0 };
    let safe_gain = if spring_gain.is_finite() {
        spring_gain.max(0.0)
    } else {
        0.0
    };
    let safe_damping = if damping.is_finite() {
        damping.max(0.0)
    } else {
        0.0
    };
    let angle = if angle.is_finite() { angle } else { 0.0 };
    let velocity = if angular_velocity.is_finite() {
        angular_velocity
    } else {
        0.0
    };

    if safe_dt <= 0.0 {
        return (angle, velocity);
    }
    if safe_gain <= 0.0 {
        if safe_damping <= 0.0 {
            return (angle + velocity * safe_dt, velocity);
        }
        let decay = (-safe_damping * safe_dt).exp();
        return (
            angle + velocity * (1.0 - decay) / safe_damping,
            velocity * decay,
        );
    }

    let discriminant = safe_damping * safe_damping - 4.0 * safe_gain;
    if discriminant.abs() <= 1e-9 {
        let root = -safe_damping / 2.0;
        let b = velocity - root * angle;
        let decay = (root * safe_dt).exp();
        let next_angle = (angle + b * safe_dt) * decay;
        let next_velocity = (b + root * (angle + b * safe_dt)) * decay;
        return (next_angle, next_velocity);
    }
    if discriminant > 0.0 {
        let root = discriminant.sqrt();
        let r1 = (-safe_damping + root) / 2.0;
        let r2 = (-safe_damping - root) / 2.0;
        let denominator = r1 - r2;
        let a = if denominator != 0.0 {
            (velocity - r2 * angle) / denominator
        } else {
            angle
        };
        let b = angle - a;
        let e1 = (r1 * safe_dt).exp();
        let e2 = (r2 * safe_dt).exp();
        return (a * e1 + b * e2, a * r1 * e1 + b * r2 * e2);
    }

    let decay_rate = -safe_damping / 2.0;
    let frequency = (-discriminant).sqrt() / 2.0;
    let a = angle;
    let b = if frequency > 0.0 {
        (velocity - decay_rate * angle) / frequency
    } else {
        0.0
    };
    let decay = (decay_rate * safe_dt).exp();
    let cosine = (frequency * safe_dt).cos();
    let sine = (frequency * safe_dt).sin();
    let basis = a * cosine + b * sine;
    (
        decay * basis,
        decay
            * (decay_rate * basis
                + (-a * frequency * sine + b * frequency * cosine)),
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
    control_force_mag: f64,
    target_up: [f64; 3],
    medium_angular_damping: f64,
    slew_yaw_rate: f64,
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

    // alwaysForward chassis (plane, aerosub) turn as a constant-rate slew —
    // the circle turn. A damped spring's rate collapses with the remaining
    // error, so the nose eases off as it closes on a moving bearing and
    // never actually aligns; the slew turns at the full authored rate until
    // aligned, then snaps exactly onto the bearing.
    if slew_yaw_rate > 0.0 && slew_yaw_rate.is_finite() {
        let target_yaw = forward_y.atan2(forward_x);
        let mut yaw_error = target_yaw - current_yaw;
        while yaw_error > core::f64::consts::PI {
            yaw_error -= core::f64::consts::TAU;
        }
        while yaw_error < -core::f64::consts::PI {
            yaw_error += core::f64::consts::TAU;
        }
        let max_step = slew_yaw_rate * dt_sec;
        let step = yaw_error.clamp(-max_step, max_step);
        let next_yaw = current_yaw + step;
        let next_orientation = unit_force_quat_from_forward_up(
            [next_yaw.cos(), next_yaw.sin(), 0.0],
            target_up,
        );
        let next_omega_z = step / dt_sec;
        rows[base + UF_ROW_ORIENTATION_X] = next_orientation[0];
        rows[base + UF_ROW_ORIENTATION_Y] = next_orientation[1];
        rows[base + UF_ROW_ORIENTATION_Z] = next_orientation[2];
        rows[base + UF_ROW_ORIENTATION_W] = next_orientation[3];
        rows[base + UF_ROW_OMEGA_X] = 0.0;
        rows[base + UF_ROW_OMEGA_Y] = 0.0;
        rows[base + UF_ROW_OMEGA_Z] = next_omega_z;
        rows[base + UF_ROW_ANGULAR_ACCEL_X] = 0.0;
        rows[base + UF_ROW_ANGULAR_ACCEL_Y] = 0.0;
        rows[base + UF_ROW_ANGULAR_ACCEL_Z] = (next_omega_z - omega[2]) / dt_sec;
        return true;
    }

    let axis_angle = quat_shortest_axis_angle(orientation, target);

    let max_alpha =
        unit_force_attitude_max_angular_acceleration(body_mass, radius, control_force_mag);
    if max_alpha <= 1e-9 || !max_alpha.is_finite() {
        let damp = if medium_angular_damping.is_finite() {
            (-medium_angular_damping.max(0.0) * dt_sec).exp()
        } else {
            1.0
        };
        omega[0] *= damp;
        omega[1] *= damp;
        omega[2] *= damp;
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

    // The old path integrated this spring with semi-implicit Euler. Its
    // continuous coefficient was critical, but light units can have
    // sqrt(k) * dt > 1 at 60 Hz, where the discrete update oscillates around
    // the heading. Solve the linear damped oscillator exactly over this tick
    // instead. `axis_angle` is target minus current orientation, while the
    // solver stores current minus target, hence the negation below.
    //
    // The active servo owns a critically damped closed-loop response. Medium
    // damping governs unpowered spin in the branch above; while steering, the
    // controller compensates that predictable resistance so air/water damping
    // cannot turn a conservative force budget into a minute-long yaw.
    let k = unit_force_attitude_spring_gain(max_alpha);
    let damping = 2.0 * k.sqrt();
    let (relative_x, next_omega_x) = unit_force_damped_attitude_component(
        -axis_angle[0],
        omega[0],
        k,
        damping,
        dt_sec,
    );
    let (relative_y, next_omega_y) = unit_force_damped_attitude_component(
        -axis_angle[1],
        omega[1],
        k,
        damping,
        dt_sec,
    );
    let (relative_z, next_omega_z) = unit_force_damped_attitude_component(
        -axis_angle[2],
        omega[2],
        k,
        damping,
        dt_sec,
    );
    let next_axis_angle = [-relative_x, -relative_y, -relative_z];
    let previous_omega = omega;
    omega = [next_omega_x, next_omega_y, next_omega_z];
    let error = unit_force_quat_from_axis_angle(next_axis_angle);
    orientation = quat_mul(unit_force_quat_conjugate(error), target);
    quat_normalize_inplace(&mut orientation);
    let alpha = [
        (omega[0] - previous_omega[0]) / dt_sec,
        (omega[1] - previous_omega[1]) / dt_sec,
        (omega[2] - previous_omega[2]) / dt_sec,
    ];

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

#[inline]
fn unit_force_quat_conjugate(q: [f64; 4]) -> [f64; 4] {
    [-q[0], -q[1], -q[2], q[3]]
}

#[inline]
fn unit_force_quat_from_axis_angle(axis_angle: [f64; 3]) -> [f64; 4] {
    let angle_sq = axis_angle[0] * axis_angle[0]
        + axis_angle[1] * axis_angle[1]
        + axis_angle[2] * axis_angle[2];
    if !angle_sq.is_finite() || angle_sq <= 1e-24 {
        // sin(theta / 2) / theta tends to 1/2 at zero.
        return [
            axis_angle[0] * 0.5,
            axis_angle[1] * 0.5,
            axis_angle[2] * 0.5,
            1.0,
        ];
    }
    let angle = angle_sq.sqrt();
    let scale = (angle * 0.5).sin() / angle;
    [
        axis_angle[0] * scale,
        axis_angle[1] * scale,
        axis_angle[2] * scale,
        (angle * 0.5).cos(),
    ]
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
    unit_force_step_batch_core(
        slots,
        flags,
        rows,
        out_flags,
        count,
        dt_sec,
        wind_x,
        wind_y,
        wind_z,
        surface_lift_minimum_distance_world,
    )
}

// ── JS↔WASM staging for the per-tick force batch (ledger [25]) ──────
// The slice-taking export above costs wasm-bindgen a malloc + copy-in
// AND a copy-back-out per call — 59 f64 per unit per tick in both
// directions. These staging arrays live in WASM linear memory instead:
// JS fills them through typed-array views over the exported pointers
// and the batch reads/writes them in place. Growth (staging_ensure) or
// any wasm memory growth invalidates the pointers, so JS re-derives its
// views whenever the memory buffer identity changes or capacity grows.
pub(crate) struct UnitForceStaging {
    slots: Vec<u32>,
    flags: Vec<u32>,
    rows: Vec<f64>,
    out_flags: Vec<u32>,
}

pub(crate) static UNIT_FORCE_STAGING: WasmLazy<UnitForceStaging> = WasmLazy::new();

fn unit_force_staging() -> &'static mut UnitForceStaging {
    UNIT_FORCE_STAGING.get_or_init(|| UnitForceStaging {
        slots: Vec::new(),
        flags: Vec::new(),
        rows: Vec::new(),
        out_flags: Vec::new(),
    })
}

/// Grow (never shrink) the staging arrays to hold `count` batch entries.
/// Call before writing through the pointer views; growth may move the
/// arrays, so pointers must be re-fetched afterwards.
#[wasm_bindgen]
pub fn unit_force_staging_ensure(count: u32) {
    let staging = unit_force_staging();
    let count = count as usize;
    if staging.slots.len() < count {
        staging.slots.resize(count, 0);
        staging.flags.resize(count, 0);
        staging.out_flags.resize(count, 0);
    }
    let rows_len = count * UNIT_FORCE_BATCH_STRIDE;
    if staging.rows.len() < rows_len {
        staging.rows.resize(rows_len, 0.0);
    }
}

#[wasm_bindgen]
pub fn unit_force_staging_slots_ptr() -> *const u32 {
    unit_force_staging().slots.as_ptr()
}

#[wasm_bindgen]
pub fn unit_force_staging_flags_ptr() -> *const u32 {
    unit_force_staging().flags.as_ptr()
}

#[wasm_bindgen]
pub fn unit_force_staging_rows_ptr() -> *mut f64 {
    unit_force_staging().rows.as_mut_ptr()
}

#[wasm_bindgen]
pub fn unit_force_staging_out_flags_ptr() -> *mut u32 {
    unit_force_staging().out_flags.as_mut_ptr()
}

/// The force batch reading its inputs from (and writing its outputs to)
/// the WASM-resident staging arrays — no boundary copies. Identical
/// math to `unit_force_step_batch`; both delegate to the same core.
#[wasm_bindgen]
pub fn unit_force_step_batch_staged(
    count: u32,
    dt_sec: f64,
    wind_x: f64,
    wind_y: f64,
    wind_z: f64,
    surface_lift_minimum_distance_world: f64,
) -> u32 {
    let staging = unit_force_staging();
    let count = count as usize;
    if staging.slots.len() < count || staging.rows.len() < count * UNIT_FORCE_BATCH_STRIDE {
        return 0;
    }
    let UnitForceStaging {
        slots,
        flags,
        rows,
        out_flags,
    } = staging;
    unit_force_step_batch_core(
        slots,
        flags,
        rows,
        out_flags,
        count,
        dt_sec,
        wind_x,
        wind_y,
        wind_z,
        surface_lift_minimum_distance_world,
    )
}

fn unit_force_step_batch_core(
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
        let mut ground_angular_damping_rate = 0.0;
        let mut cruise_slew_yaw_rate = 0.0;
        let mut water_angular_damping_rate = 0.0;
        let mut authored_ground_tangential_damping_rate = 0.0;
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
                    rows[base + UF_ROW_AIR_SURFACE_FOLLOWING_INVERSE_FORCE_FROM_GROUND] = profile
                        .values[pbase + UF_PROFILE_AIR_SURFACE_FOLLOWING_INVERSE_FORCE_FROM_GROUND];
                    rows[base + UF_ROW_AIR_SURFACE_FOLLOWING_INVERSE_FORCE_FROM_WATER] = profile
                        .values[pbase + UF_PROFILE_AIR_SURFACE_FOLLOWING_INVERSE_FORCE_FROM_WATER];
                    rows[base + UF_ROW_GROUND_STATIC_FRICTION_COEFFICIENT] =
                        profile.values[pbase + UF_PROFILE_GROUND_STATIC_FRICTION_COEFFICIENT];
                    rows[base + UF_ROW_AIR_LINEAR_DAMPING_RATE] =
                        profile.values[pbase + UF_PROFILE_AIR_LINEAR_DAMPING_RATE];
                    rows[base + UF_ROW_WATER_MAX_PROPULSIVE_FORCE] =
                        profile.values[pbase + UF_PROFILE_WATER_MAX_PROPULSIVE_FORCE];
                    rows[base + UF_ROW_WATER_LINEAR_DAMPING_RATE] =
                        profile.values[pbase + UF_PROFILE_WATER_LINEAR_DAMPING_RATE];
                    rows[base + UF_ROW_WATER_SURFACE_FOLLOWING_INVERSE_FORCE_FROM_GROUND] = profile
                        .values
                        [pbase + UF_PROFILE_WATER_SURFACE_FOLLOWING_INVERSE_FORCE_FROM_GROUND];
                    rows[base + UF_ROW_WATER_SURFACE_FOLLOWING_PROPORTIONAL_FORCE_FROM_WATER] =
                        profile.values[pbase
                            + UF_PROFILE_WATER_SURFACE_FOLLOWING_PROPORTIONAL_FORCE_FROM_WATER];
                    rows[base + UF_ROW_AIR_MAX_PROPULSIVE_FORCE] =
                        profile.values[pbase + UF_PROFILE_AIR_MAX_PROPULSIVE_FORCE];
                    air_angular_damping_rate =
                        profile.values[pbase + UF_PROFILE_AIR_ANGULAR_DAMPING_RATE];
                    water_angular_damping_rate =
                        profile.values[pbase + UF_PROFILE_WATER_ANGULAR_DAMPING_RATE];
                    ground_angular_damping_rate =
                        profile.values[pbase + UF_PROFILE_GROUND_ANGULAR_DAMPING_RATE];
                    // Authored rate; the contact block below scales it by the
                    // load this contact actually carries so ground damping adds
                    // to fluid damping instead of replacing it.
                    authored_ground_tangential_damping_rate =
                        profile.values[pbase + UF_PROFILE_GROUND_TANGENTIAL_DAMPING_RATE].max(0.0);
                    cruise_slew_yaw_rate =
                        profile.values[pbase + UF_PROFILE_TURN_RATE_RAD_PER_SEC].max(0.0);
                    p.ground_tangential_damping_rate[slot] = 0.0;
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
        let cruise_when_uncommanded = profile_flags & UF_PROFILE_FLAG_CRUISE_WHEN_UNCOMMANDED != 0
            || flag & UF_FLAG_IS_AIRBORNE_CRUISING != 0;
        let medium_lift_enabled = flag & UF_FLAG_IS_AIRBORNE != 0;
        let has_external = flag & UF_FLAG_HAS_EXTERNAL_FORCE != 0;
        let has_orientation = flag & UF_FLAG_HAS_ORIENTATION != 0;
        let propulsion_body_forward = flag & UF_FLAG_PROPULSION_BODY_FORWARD != 0;
        let propulsion_forward_only = flag & UF_FLAG_PROPULSION_FORWARD_ONLY != 0;
        let propulsion_always_forward = flag & UF_FLAG_PROPULSION_ALWAYS_FORWARD != 0;
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
        let air_lift_force_active = air_fraction > 0.0
            && medium_lift_enabled
            && (rows[base + UF_ROW_AIR_SURFACE_FOLLOWING_INVERSE_FORCE_FROM_GROUND] > 0.0
                || rows[base + UF_ROW_AIR_SURFACE_FOLLOWING_INVERSE_FORCE_FROM_WATER] > 0.0);
        let water_lift_force_active = water_fraction > 0.0
            && medium_lift_enabled
            && (rows[base + UF_ROW_WATER_SURFACE_FOLLOWING_INVERSE_FORCE_FROM_GROUND] > 0.0
                || rows[base + UF_ROW_WATER_SURFACE_FOLLOWING_PROPORTIONAL_FORCE_FROM_WATER] > 0.0);

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
        let ground_max_propulsive_force = rows[base + UF_ROW_GROUND_MAX_PROPULSIVE_FORCE].max(0.0);
        let air_max_propulsive_force = rows[base + UF_ROW_AIR_MAX_PROPULSIVE_FORCE].max(0.0);
        let water_max_propulsive_force = rows[base + UF_ROW_WATER_MAX_PROPULSIVE_FORCE].max(0.0);

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
        let (drive_dir_x, drive_dir_y, has_drive_dir, drive_thrust_scale) =
            if has_thrust && thrust_input_mag > 0.0 {
                if propulsion_always_forward {
                    // The gas is always on along the nose: the requested
                    // direction only aims the yaw servo, never modulates
                    // throttle. A turning plane keeps full forward drive
                    // instead of bleeding speed by the off-nose projection.
                    (forward_x, forward_y, true, thrust_scale)
                } else if propulsion_body_forward {
                    let (body_forward_has_drive, body_forward_throttle) =
                        unit_force_body_forward_drive_request(
                            requested_dir_x,
                            requested_dir_y,
                            forward_x,
                            forward_y,
                            thrust_scale,
                            propulsion_forward_only,
                        );
                    (
                        forward_x,
                        forward_y,
                        body_forward_has_drive,
                        body_forward_throttle,
                    )
                } else {
                    (requested_dir_x, requested_dir_y, true, thrust_scale)
                }
            } else {
                (0.0, 0.0, false, 0.0)
            };

        let mut thrust_force_x = 0.0;
        let mut thrust_force_y = 0.0;
        let mut thrust_force_z = 0.0;
        let ground_z = rows[base + UF_ROW_GROUND_Z];
        // One canonical locomotion datum serves contact and every authored
        // surface-following response. The body origin remains the volume/COM
        // datum used above for medium occupancy and environmental hazards.
        let support_z = p.pos_z[slot] - p.ground_offset[slot];
        let computed_ground_contact = is_in_locomotion_contact(
            ground_z - support_z,
            p.radius[slot],
        );
        let ground_contact = flag & UF_FLAG_ON_GROUND != 0 || computed_ground_contact;
        if let Some(runtime_slot) = runtime_slot {
            runtime.ground_contact[runtime_slot] = if ground_contact { 1 } else { 0 };
            runtime.available_ground_force[runtime_slot] = 0.0;
        }
        let air_medium_active = air_fraction > 0.0
            && (rows[base + UF_ROW_AIR_MAX_PROPULSIVE_FORCE] > 0.0
                || rows[base + UF_ROW_AIR_SURFACE_FOLLOWING_INVERSE_FORCE_FROM_GROUND] > 0.0
                || rows[base + UF_ROW_AIR_SURFACE_FOLLOWING_INVERSE_FORCE_FROM_WATER] > 0.0
                || rows[base + UF_ROW_AIR_LINEAR_DAMPING_RATE] > 0.0);
        let water_medium_active = water_fraction > 0.0
            && (rows[base + UF_ROW_WATER_MAX_PROPULSIVE_FORCE] > 0.0
                || rows[base + UF_ROW_WATER_SURFACE_FOLLOWING_INVERSE_FORCE_FROM_GROUND] > 0.0
                || rows[base + UF_ROW_WATER_SURFACE_FOLLOWING_PROPORTIONAL_FORCE_FROM_WATER] > 0.0
                || rows[base + UF_ROW_WATER_LINEAR_DAMPING_RATE] > 0.0);

        if air_medium_active {
            let mut air_target_dir_x = 0.0;
            let mut air_target_dir_y = 0.0;
            let mut air_has_target_dir = false;
            let air_thrust_scale = if has_thrust {
                drive_thrust_scale
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

            let proposed_force = if flag & UF_FLAG_HAS_AIR_SURFACE_FOLLOWING_INVERSE_PROPOSED_FORCE
                != 0
                && rows[base + UF_ROW_AIR_SURFACE_FOLLOWING_INVERSE_PROPOSED_FORCE].is_finite()
            {
                rows[base + UF_ROW_AIR_SURFACE_FOLLOWING_INVERSE_PROPOSED_FORCE].max(0.0)
            } else {
                let ground_response = unit_force_surface_lift_inverse_distance_response(
                    support_z - ground_z,
                    surface_lift_minimum_distance_world,
                );
                let water_response = unit_force_air_water_surface_inverse_distance_response(
                    support_z,
                    ground_z,
                    f64::NAN,
                    false,
                    surface_lift_minimum_distance_world,
                );
                rows[base + UF_ROW_AIR_SURFACE_FOLLOWING_INVERSE_FORCE_FROM_GROUND].max(0.0)
                    * ground_response
                    + rows[base + UF_ROW_AIR_SURFACE_FOLLOWING_INVERSE_FORCE_FROM_WATER].max(0.0)
                        * water_response
            };
            let full_medium_surface_lift = unit_force_full_medium_surface_lift(proposed_force);
            if medium_lift_enabled && full_medium_surface_lift > 0.0 {
                thrust_force_z += unit_force_occupancy_weighted_positive_value(
                    full_medium_surface_lift,
                    air_fraction,
                );
            }

            if air_has_target_dir {
                let thrust_mag = unit_force_occupancy_weighted_positive_value(
                    air_max_propulsive_force,
                    air_fraction,
                ) * air_thrust_scale;
                let (air_drive_dir_x, air_drive_dir_y) =
                    if cruise_when_uncommanded || propulsion_body_forward {
                        // Aircraft-style locomotion: engine thrust follows the nose, while
                        // the requested movement direction is only the yaw target below.
                        (forward_x, forward_y)
                    } else {
                        (air_target_dir_x, air_target_dir_y)
                    };
                let (tx, ty, tz) = unit_force_planar_drive_direction_for_contact(
                    ground_contact,
                    air_drive_dir_x,
                    air_drive_dir_y,
                    rows[base + UF_ROW_NORMAL_X],
                    rows[base + UF_ROW_NORMAL_Y],
                    rows[base + UF_ROW_NORMAL_Z],
                );
                thrust_force_x += tx * thrust_mag;
                thrust_force_y += ty * thrust_mag;
                thrust_force_z += tz * thrust_mag;
            }
            let air_linear_damping_rate = rows[base + UF_ROW_AIR_LINEAR_DAMPING_RATE];
            if air_linear_damping_rate > 0.0 && body_mass > 0.0 {
                // Wind belongs exclusively to the occupied air volume. The
                // damping helper weights this air-relative velocity by
                // air_fraction, so the wind contribution fades continuously
                // at the waterline and is exactly zero when submerged.
                let (fx, fy, fz) = unit_force_fluid_damping_force(
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
                let mag = unit_force_occupancy_weighted_positive_value(
                    water_max_propulsive_force,
                    water_fraction,
                ) * drive_thrust_scale;
                let (tx, ty, tz) = unit_force_planar_drive_direction_for_contact(
                    ground_contact,
                    drive_dir_x,
                    drive_dir_y,
                    rows[base + UF_ROW_NORMAL_X],
                    rows[base + UF_ROW_NORMAL_Y],
                    rows[base + UF_ROW_NORMAL_Z],
                );
                thrust_force_x += tx * mag;
                thrust_force_y += ty * mag;
                thrust_force_z += tz * mag;
            }

            let inverse_lift_force_from_ground_surface =
                rows[base + UF_ROW_WATER_SURFACE_FOLLOWING_INVERSE_FORCE_FROM_GROUND];
            if medium_lift_enabled && inverse_lift_force_from_ground_surface > 0.0 {
                let proposed_force =
                    if flag & UF_FLAG_HAS_WATER_SURFACE_FOLLOWING_INVERSE_PROPOSED_FORCE != 0
                        && rows[base + UF_ROW_WATER_SURFACE_FOLLOWING_INVERSE_PROPOSED_FORCE]
                            .is_finite()
                    {
                        rows[base + UF_ROW_WATER_SURFACE_FOLLOWING_INVERSE_PROPOSED_FORCE].max(0.0)
                    } else {
                        inverse_lift_force_from_ground_surface.max(0.0)
                            * unit_force_surface_lift_inverse_distance_response(
                                support_z - ground_z,
                                surface_lift_minimum_distance_world,
                            )
                    };
                let full_medium_surface_lift = unit_force_full_medium_surface_lift(proposed_force);
                if full_medium_surface_lift > 0.0 {
                    thrust_force_z += unit_force_occupancy_weighted_positive_value(
                        full_medium_surface_lift,
                        water_fraction,
                    );
                }
            }

            let proportional_lift_force_from_water_surface =
                rows[base + UF_ROW_WATER_SURFACE_FOLLOWING_PROPORTIONAL_FORCE_FROM_WATER];
            if medium_lift_enabled && proportional_lift_force_from_water_surface > 0.0 {
                let proposed_force = if flag
                    & UF_FLAG_HAS_WATER_SURFACE_FOLLOWING_PROPORTIONAL_PROPOSED_FORCE
                    != 0
                    && rows[base + UF_ROW_WATER_SURFACE_FOLLOWING_PROPORTIONAL_PROPOSED_FORCE]
                        .is_finite()
                {
                    rows[base + UF_ROW_WATER_SURFACE_FOLLOWING_PROPORTIONAL_PROPOSED_FORCE].max(0.0)
                } else if ground_z < TERRAIN_WATER_LEVEL {
                    proportional_lift_force_from_water_surface.max(0.0)
                        * unit_force_water_surface_depth_world(support_z)
                } else {
                    0.0
                };
                let full_medium_surface_lift = unit_force_full_medium_surface_lift(proposed_force);
                if full_medium_surface_lift > 0.0 {
                    thrust_force_z += unit_force_occupancy_weighted_positive_value(
                        full_medium_surface_lift,
                        water_fraction,
                    );
                }
            }

            let water_linear_damping_rate = rows[base + UF_ROW_WATER_LINEAR_DAMPING_RATE];
            if water_linear_damping_rate > 0.0 && body_mass > 0.0 {
                // Water is currently a still medium. Never feed atmospheric
                // wind into this relative velocity; future currents belong in
                // a separate water-medium velocity field.
                let (fx, fy, fz) = unit_force_fluid_damping_force(
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

        let mut attitude_ground_control_force = 0.0;
        // Ground occupancy: the share of the body's weight this contact
        // actually carries. Air and water are weighted by displaced volume;
        // ground is weighted by carried load, so every medium contributes an
        // additive term and none of them switches the others off.
        let mut ground_occupancy = 0.0;
        if ground_contact {
            // Contact drive is constrained by Coulomb grip and the effective
            // normal load. Any already-applied upward medium support unloads
            // the contact patch by its actual force; no passive gravity
            // counter is hidden in the traction calculation.
            let gravity_force = body_mass * GRAVITY / 1_000_000.0;
            let normal_load = unit_force_contact_normal_load(
                gravity_force,
                rows[base + UF_ROW_NORMAL_X],
                rows[base + UF_ROW_NORMAL_Y],
                rows[base + UF_ROW_NORMAL_Z],
                thrust_force_x + external_fx,
                thrust_force_y + external_fy,
                thrust_force_z + external_fz,
            );
            ground_occupancy = unit_force_ground_occupancy(normal_load, gravity_force);
            p.ground_tangential_damping_rate[slot] =
                authored_ground_tangential_damping_rate * ground_occupancy;
            let contact_force_limit =
                normal_load * rows[base + UF_ROW_GROUND_STATIC_FRICTION_COEFFICIENT].max(0.0);
            let available_ground_force = ground_max_propulsive_force.min(contact_force_limit);
            attitude_ground_control_force = available_ground_force;
            if let Some(runtime_slot) = runtime_slot {
                runtime.available_ground_force[runtime_slot] = available_ground_force;
            }
            if has_drive_dir {
                let (fx, fy, fz) = unit_force_ground_drive_forces(
                    drive_dir_x,
                    drive_dir_y,
                    drive_thrust_scale,
                    rows[base + UF_ROW_NORMAL_X],
                    rows[base + UF_ROW_NORMAL_Y],
                    rows[base + UF_ROW_NORMAL_Z],
                    available_ground_force,
                    body_mass,
                );
                thrust_force_x += fx;
                thrust_force_y += fy;
                thrust_force_z += fz;
            } else {
                let (fx, fy, fz) = unit_force_idle_brake(
                    body_mass,
                    p.vel_x[slot],
                    p.vel_y[slot],
                    p.vel_z[slot],
                    rows[base + UF_ROW_NORMAL_X],
                    rows[base + UF_ROW_NORMAL_Y],
                    rows[base + UF_ROW_NORMAL_Z],
                    // Passive static friction is a contact property, not a
                    // motor rating. A weak drivetrain may be unable to climb
                    // a slope that the uncommanded body can nevertheless
                    // hold on without sliding.
                    contact_force_limit,
                    dt_sec,
                );
                thrust_force_x += fx;
                thrust_force_y += fy;
                thrust_force_z += fz;
            }
        }

        if flag & UF_FLAG_HAS_ORIENTATION != 0 {
            let prev_omega_x = rows[base + UF_ROW_OMEGA_X];
            let prev_omega_y = rows[base + UF_ROW_OMEGA_Y];
            let prev_omega_z = rows[base + UF_ROW_OMEGA_Z];
            // The leveling target is the occupancy-weighted sum of the contact
            // normal and the fluid's level up. A body whose weight rests on the
            // surface lies on the surface; a neutrally supported body grazing a
            // steep lakebed wall stays level, because the wall carries none of
            // its weight.
            let target_up = unit_force_attitude_target_up(
                rows[base + UF_ROW_NORMAL_X],
                rows[base + UF_ROW_NORMAL_Y],
                rows[base + UF_ROW_NORMAL_Z],
                ground_occupancy,
            );
            let mut angular_damping = 0.0;
            if ground_occupancy > 0.0 {
                angular_damping += ground_angular_damping_rate.max(0.0) * ground_occupancy;
            }
            angular_damping += unit_force_occupancy_weighted_positive_value(
                air_angular_damping_rate,
                air_fraction,
            );
            angular_damping += unit_force_occupancy_weighted_positive_value(
                water_angular_damping_rate,
                water_fraction,
            );
            let available_attitude_force = attitude_ground_control_force
                + unit_force_occupancy_weighted_positive_value(
                    air_max_propulsive_force,
                    air_fraction,
                )
                + unit_force_occupancy_weighted_positive_value(
                    water_max_propulsive_force,
                    water_fraction,
                );
            let attitude_control_force =
                unit_force_attitude_control_force(body_mass, available_attitude_force);

            if unit_force_attitude_step(
                rows,
                base,
                body_mass,
                p.radius[slot],
                attitude_control_force,
                target_up,
                angular_damping,
                if propulsion_always_forward {
                    cruise_slew_yaw_rate
                } else {
                    0.0
                },
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
    fn ground_occupancy_is_the_share_of_weight_the_contact_carries() {
        // Resting body: the contact carries everything.
        assert_near(unit_force_ground_occupancy(10.0, 10.0), 1.0);
        // Half the weight held by medium support.
        assert_near(unit_force_ground_occupancy(5.0, 10.0), 0.5);
        // Neutrally supported hull grazing a surface: the contact carries none.
        assert_near(unit_force_ground_occupancy(0.0, 10.0), 0.0);
        // Never exceeds one, and a massless/degenerate body contributes nothing.
        assert_near(unit_force_ground_occupancy(40.0, 10.0), 1.0);
        assert_near(unit_force_ground_occupancy(10.0, 0.0), 0.0);
    }

    #[test]
    fn attitude_target_up_blends_contact_normal_by_ground_occupancy() {
        let theta: f64 = 30.0_f64.to_radians();
        let (nx, ny, nz) = (0.0, -theta.sin(), theta.cos());
        // Full contact load: lie on the surface.
        let full = unit_force_attitude_target_up(nx, ny, nz, 1.0);
        assert_near(full[0], nx);
        assert_near(full[1], ny);
        assert_near(full[2], nz);
        // No contact load: stay level, even though the surface is right there.
        let none = unit_force_attitude_target_up(nx, ny, nz, 0.0);
        assert_near(none[0], 0.0);
        assert_near(none[1], 0.0);
        assert_near(none[2], 1.0);
        // Partial support tilts partway and stays a unit vector.
        let half = unit_force_attitude_target_up(nx, ny, nz, 0.5);
        let mag = (half[0] * half[0] + half[1] * half[1] + half[2] * half[2]).sqrt();
        assert_near(mag, 1.0);
        assert!(
            half[1] < 0.0 && half[1] > ny,
            "half support leans toward the slope without reaching it"
        );
    }

    #[test]
    fn flat_ground_drive_spends_the_full_budget_along_the_command() {
        let budget = 2.0;
        let (fx, fy, fz) =
            unit_force_ground_drive_forces(1.0, 0.0, 1.0, 0.0, 0.0, 1.0, budget, 40_000.0);
        assert_near(fx, budget);
        assert_near(fy, 0.0);
        assert_near(fz, 0.0);
    }

    #[test]
    fn straight_fall_line_drive_reserves_no_hold() {
        // 20° incline rising toward +y: normal tilts toward -y.
        let theta: f64 = 20.0_f64.to_radians();
        let (nx, ny, nz) = (0.0, -theta.sin(), theta.cos());
        let budget = 2.0;
        // Commanded straight uphill (+y): lateral gravity is zero, so the
        // whole budget goes along the climb tangent, matching the old model.
        let (fx, fy, fz) =
            unit_force_ground_drive_forces(0.0, 1.0, 1.0, nx, ny, nz, budget, 40_000.0);
        let mag = (fx * fx + fy * fy + fz * fz).sqrt();
        assert_near(fx, 0.0);
        assert_near(mag, budget);
        assert!(fy > 0.0 && fz > 0.0, "climb tangent has +y and +z parts");
    }

    #[test]
    fn cross_slope_drive_cancels_lateral_gravity_before_driving() {
        let theta: f64 = 20.0_f64.to_radians();
        let (nx, ny, nz) = (0.0, -theta.sin(), theta.cos());
        let body_mass = 40_000.0;
        let budget = 8.0;
        // Commanded along the contour (+x). Lateral slope gravity is
        // g·sinθ toward -y (with a tangent-plane z part).
        let (fx, fy, fz) =
            unit_force_ground_drive_forces(1.0, 0.0, 1.0, nx, ny, nz, budget, body_mass);
        let hold_force = GRAVITY * theta.sin() * body_mass / 1_000_000.0;
        assert!(hold_force < budget, "test premise: hold fits in budget");
        let longitudinal = (budget * budget - hold_force * hold_force).sqrt();
        // Along-track (+x) share is the reduced longitudinal budget.
        assert_near(fx, longitudinal);
        // Cross-track share exactly opposes the lateral gravity force:
        // gravity tangent is (0, -g·sinθ·cosθ, -g·sin²θ)·m, so the hold
        // force is its negation.
        assert_near(
            fy,
            GRAVITY * theta.sin() * theta.cos() * body_mass / 1_000_000.0,
        );
        assert_near(
            fz,
            GRAVITY * theta.sin() * theta.sin() * body_mass / 1_000_000.0,
        );
    }

    #[test]
    fn unholdable_cross_slope_saturates_the_budget_on_hold() {
        let theta: f64 = 60.0_f64.to_radians();
        let (nx, ny, nz) = (0.0, -theta.sin(), theta.cos());
        let body_mass = 40_000.0;
        // Budget far below m·g·sinθ/1e6 ≈ 10.39.
        let budget = 2.0;
        let (fx, fy, fz) =
            unit_force_ground_drive_forces(1.0, 0.0, 1.0, nx, ny, nz, budget, body_mass);
        // Zero longitudinal drive; the entire budget pushes against the
        // lateral slide direction.
        assert_near(fx, 0.0);
        let mag = (fx * fx + fy * fy + fz * fz).sqrt();
        assert_near(mag, budget);
        assert!(fy > 0.0, "hold pushes back uphill (+y)");
    }

    #[test]
    fn zero_throttle_drive_still_holds_the_slope() {
        // A body-forward unit mid-yaw (cos throttle ≈ 0) must not surrender
        // its cross-slope grip while it turns.
        let theta: f64 = 20.0_f64.to_radians();
        let (nx, ny, nz) = (0.0, -theta.sin(), theta.cos());
        let body_mass = 40_000.0;
        let budget = 8.0;
        let (fx, fy, _fz) =
            unit_force_ground_drive_forces(1.0, 0.0, 0.0, nx, ny, nz, budget, body_mass);
        assert_near(fx, 0.0);
        assert_near(
            fy,
            GRAVITY * theta.sin() * theta.cos() * body_mass / 1_000_000.0,
        );
    }

    #[test]
    fn surface_following_uses_the_aggregated_force_and_explicit_responses() {
        assert_near(unit_force_full_medium_surface_lift(25.0), 25.0);
        assert_near(unit_force_full_medium_surface_lift(-1.0), 0.0);
        let minimum_response = 1.0 / 0.5;
        assert_near(
            unit_force_surface_lift_inverse_distance_response(-10.0, 0.5),
            minimum_response,
        );
        assert_near(
            unit_force_surface_lift_inverse_distance_response(f64::NAN, 0.5),
            minimum_response,
        );
        assert_near(
            unit_force_water_surface_depth_world(TERRAIN_WATER_LEVEL + 10.0),
            0.0,
        );
        assert_near(
            unit_force_water_surface_depth_world(TERRAIN_WATER_LEVEL),
            0.0,
        );
        assert_near(
            unit_force_water_surface_depth_world(TERRAIN_WATER_LEVEL - 10.0),
            10.0,
        );
        assert_near(unit_force_water_surface_depth_world(f64::NAN), 0.0);
    }

    #[test]
    fn air_water_surface_inverse_distance_requires_exposed_water() {
        assert_near(
            unit_force_air_water_surface_inverse_distance_response(
                TERRAIN_WATER_LEVEL + 10.0,
                TERRAIN_WATER_LEVEL - 20.0,
                f64::NAN,
                false,
                0.5,
            ),
            1.0 / 10.0,
        );
        assert_near(
            unit_force_air_water_surface_inverse_distance_response(
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
    fn locomotion_contact_reaches_one_collision_radius_above_support() {
        // This threshold is shared by every locomotion profile: a body can
        // take the slope and use ground drive while its physical contact
        // spring is still closing the final collision-radius gap.
        assert!(is_in_locomotion_contact(-40.0, 40.0));
        assert!(is_in_locomotion_contact(-39.999, 40.0));
        assert!(!is_in_locomotion_contact(-40.001, 40.0));

        // An invalid radius keeps the old near-touching fallback instead of
        // accidentally marking an unbounded gap as locomotion contact.
        assert!(is_in_locomotion_contact(-UNIT_GROUND_CONTACT_EPSILON, 0.0));
        assert!(!is_in_locomotion_contact(-0.01, f64::NAN));
    }

    #[test]
    fn contact_normal_load_tracks_slope_lift_and_inward_force() {
        assert_near(
            unit_force_contact_normal_load(10.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0),
            10.0,
        );
        let nx = 3.0_f64.sqrt() * 0.5;
        let nz = 0.5;
        assert_near(
            unit_force_contact_normal_load(10.0, nx, 0.0, nz, 0.0, 0.0, 0.0),
            5.0,
        );
        assert_near(
            unit_force_contact_normal_load(10.0, nx, 0.0, nz, 2.0 * nx, 0.0, 2.0 * nz),
            3.0,
        );
        assert_near(
            unit_force_contact_normal_load(10.0, nx, 0.0, nz, -2.0 * nx, 0.0, -2.0 * nz),
            7.0,
        );
    }

    #[test]
    fn positive_medium_values_are_weighted_by_occupied_volume() {
        assert_near(unit_force_occupancy_weighted_positive_value(8.0, 0.0), 0.0);
        assert_near(unit_force_occupancy_weighted_positive_value(8.0, 0.25), 2.0);
        assert_near(unit_force_occupancy_weighted_positive_value(8.0, 0.75), 6.0);
        assert_near(
            unit_force_occupancy_weighted_positive_value(8.0, 0.25)
                + unit_force_occupancy_weighted_positive_value(8.0, 0.75),
            8.0,
        );
        assert_near(unit_force_occupancy_weighted_positive_value(-8.0, 0.5), 0.0);
        assert_near(
            unit_force_occupancy_weighted_positive_value(8.0, f64::NAN),
            0.0,
        );
    }

    #[test]
    fn fluid_drive_uses_the_supported_slope_tangent_at_a_shoreline() {
        let slope_normal_z = 3.0_f64.sqrt() * 0.5;
        let (airborne_x, airborne_y, airborne_z) = unit_force_planar_drive_direction_for_contact(
            false,
            1.0,
            0.0,
            -0.5,
            0.0,
            slope_normal_z,
        );
        assert_near(airborne_x, 1.0);
        assert_near(airborne_y, 0.0);
        assert_near(airborne_z, 0.0);

        let (contact_x, contact_y, contact_z) = unit_force_planar_drive_direction_for_contact(
            true,
            1.0,
            0.0,
            -0.5,
            0.0,
            slope_normal_z,
        );
        assert_near(contact_x, slope_normal_z);
        assert_near(contact_y, 0.0);
        assert_near(contact_z, 0.5);
    }

    #[test]
    fn body_forward_drive_allows_arrival_control_to_reverse_brake() {
        let forward = unit_force_body_forward_drive_request(1.0, 0.0, 1.0, 0.0, 1.0, false);
        assert!(forward.0);
        assert_near(forward.1, 1.0);
        let reverse = unit_force_body_forward_drive_request(-1.0, 0.0, 1.0, 0.0, 1.0, false);
        assert!(reverse.0);
        assert_near(reverse.1, -1.0);
        let lateral = unit_force_body_forward_drive_request(0.0, 1.0, 1.0, 0.0, 1.0, false);
        assert!(lateral.0);
        assert_near(lateral.1, 0.0);
        let partial = unit_force_body_forward_drive_request(-1.0, 0.0, 1.0, 0.0, 0.4, false);
        assert!(partial.0);
        assert_near(partial.1, -0.4);
    }

    #[test]
    fn body_forward_only_drive_waits_for_the_forward_hemisphere() {
        let forward = unit_force_body_forward_drive_request(1.0, 0.0, 1.0, 0.0, 1.0, true);
        assert!(forward.0);
        assert_near(forward.1, 1.0);

        let reverse = unit_force_body_forward_drive_request(-1.0, 0.0, 1.0, 0.0, 1.0, true);
        assert!(!reverse.0);
        assert_near(reverse.1, 0.0);

        let lateral = unit_force_body_forward_drive_request(0.0, 1.0, 1.0, 0.0, 1.0, true);
        assert!(!lateral.0);
        assert_near(lateral.1, 0.0);
    }

    #[test]
    fn fluid_damping_is_isotropic_and_occupancy_weighted() {
        let full = unit_force_fluid_damping_force(10.0, -5.0, 2.0, 3.0, 1.0, 1_000.0);
        let half = unit_force_fluid_damping_force(10.0, -5.0, 2.0, 3.0, 0.5, 1_000.0);
        assert_near(full.0, -0.03);
        assert_near(full.1, 0.015);
        assert_near(full.2, -0.006);
        assert_near(half.0, full.0 * 0.5);
    }

    #[test]
    fn attitude_control_uses_available_force_with_a_one_body_weight_ceiling() {
        let body_mass = 6_500.0;
        let body_weight = body_mass * GRAVITY / 1_000_000.0;
        assert_near(
            unit_force_attitude_control_force(body_mass, body_weight * 0.25),
            body_weight * 0.25,
        );
        assert_near(
            unit_force_attitude_control_force(body_mass, body_weight * 100.0),
            body_weight,
        );
    }

    #[test]
    fn attitude_authority_falls_with_mass_and_radius() {
        let force = 0.05;
        let base = unit_force_attitude_max_angular_acceleration(1_000.0, 10.0, force);
        let heavier = unit_force_attitude_max_angular_acceleration(2_000.0, 10.0, force);
        let larger = unit_force_attitude_max_angular_acceleration(1_000.0, 20.0, force);
        let heavier_and_larger = unit_force_attitude_max_angular_acceleration(2_000.0, 20.0, force);
        assert_near(heavier, base * 0.5);
        assert_near(larger, base * 0.5);
        assert_near(heavier_and_larger, base * 0.25);
    }

    #[test]
    fn attitude_response_time_scale_halves_the_turn_rate() {
        let max_alpha = 8.0;
        assert_near(
            unit_force_attitude_spring_gain(max_alpha),
            max_alpha / (core::f64::consts::PI * 4.0),
        );
    }

    #[test]
    fn always_forward_slew_turns_at_a_constant_rate_and_snaps_onto_the_bearing() {
        // 90-degree bearing change at 1 rad/s, 20 Hz ticks: every full tick
        // turns exactly 0.05 rad (no easing as the error shrinks), and the
        // final partial tick lands exactly on the bearing.
        let mut rows = vec![0.0; UNIT_FORCE_BATCH_STRIDE];
        rows[UF_ROW_ORIENTATION_W] = 1.0;
        rows[UF_ROW_HEADING_X] = 0.0;
        rows[UF_ROW_HEADING_Y] = 1.0;
        let dt = 1.0 / 20.0;
        let mut previous_yaw = 0.0_f64;
        for _ in 0..33 {
            assert!(unit_force_attitude_step(
                &mut rows,
                0,
                450.0,
                9.6,
                26.666_666_666_667,
                [0.0, 0.0, 1.0],
                0.0,
                1.0,
                dt,
            ));
            let yaw = quat_yaw([
                rows[UF_ROW_ORIENTATION_X],
                rows[UF_ROW_ORIENTATION_Y],
                rows[UF_ROW_ORIENTATION_Z],
                rows[UF_ROW_ORIENTATION_W],
            ]);
            let step = yaw - previous_yaw;
            let remaining = core::f64::consts::FRAC_PI_2 - previous_yaw;
            if remaining > dt {
                assert_near(step, dt);
                assert_near(rows[UF_ROW_OMEGA_Z], 1.0);
            } else {
                assert_near(yaw, core::f64::consts::FRAC_PI_2);
            }
            previous_yaw = yaw;
        }
        // Aligned and holding: zero turn, zero yaw rate.
        assert_near(previous_yaw, core::f64::consts::FRAC_PI_2);
        assert_near(rows[UF_ROW_OMEGA_Z], 0.0);
    }

    #[test]
    fn attitude_servo_does_not_impose_an_angular_speed_ceiling() {
        let mut rows = vec![0.0; UNIT_FORCE_BATCH_STRIDE];
        rows[UF_ROW_ORIENTATION_W] = 1.0;
        rows[UF_ROW_OMEGA_Z] = 4.0;
        assert!(unit_force_attitude_step(
            &mut rows,
            0,
            1_000.0,
            10.0,
            0.0,
            [0.0, 0.0, 1.0],
            0.0,
            0.0,
            0.1,
        ));
        assert_near(rows[UF_ROW_OMEGA_Z], 4.0);
    }

    #[test]
    fn high_authority_attitude_servo_converges_without_heading_overshoot() {
        // Jackal-class force/mass/radius values make sqrt(k) * dt greater
        // than one. The previous semi-implicit update entered a visible
        // left/right yaw limit cycle in exactly this regime.
        let mut rows = vec![0.0; UNIT_FORCE_BATCH_STRIDE];
        rows[UF_ROW_ORIENTATION_W] = 1.0;
        rows[UF_ROW_HEADING_X] = 0.0;
        rows[UF_ROW_HEADING_Y] = 1.0;
        let target_yaw = core::f64::consts::FRAC_PI_2;
        let mut previous_error = target_yaw;

        for _ in 0..240 {
            assert!(unit_force_attitude_step(
                &mut rows,
                0,
                450.0,
                9.6,
                26.666_666_666_667,
                [0.0, 0.0, 1.0],
                0.0,
                0.0,
                1.0 / 60.0,
            ));
            let orientation = [
                rows[UF_ROW_ORIENTATION_X],
                rows[UF_ROW_ORIENTATION_Y],
                rows[UF_ROW_ORIENTATION_Z],
                rows[UF_ROW_ORIENTATION_W],
            ];
            let error = normalize_angle_ts(target_yaw - quat_yaw(orientation));
            assert!(
                error >= -1.0e-9,
                "a critically damped heading must not cross the target: {error}"
            );
            assert!(
                error <= previous_error + 1.0e-9,
                "heading error must decay monotonically: previous={previous_error}, next={error}"
            );
            previous_error = error;
        }
        assert!(previous_error < 1.0e-6);
    }

    #[test]
    fn water_damage_samples_only_the_body_origin() {
        assert_near(
            unit_water_damage_for_step(TERRAIN_WATER_LEVEL - 0.001, 55.0, 0.5),
            27.5,
        );
        assert_near(
            unit_water_damage_for_step(TERRAIN_WATER_LEVEL, 55.0, 0.5),
            0.0,
        );
        assert_near(
            unit_water_damage_for_step(TERRAIN_WATER_LEVEL - 100.0, 0.0, 10.0),
            0.0,
        );
    }
}

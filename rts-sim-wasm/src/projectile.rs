// projectile — extracted from lib.rs (pure code motion).

use crate::air_drag::{
    drag_rate_from_coefficient, drag_rate_from_friction_per_60hz_frame, integrate_linear_drag_axis,
};
#[allow(unused_imports)]
use crate::*;
#[allow(unused_imports)]
use wasm_bindgen::prelude::*;

// ─────────────────────────────────────────────────────────────────
//  Phase 5a — Packed projectile SoA pool in WASM linear memory
//
//  Mirrors the dense parallel arrays projectileSystem.ts already
//  maintains for projectiles eligible for the "packed" fast path
//  (no homing, single-hit, ballistic). Slots are JS-managed via
//  swap-remove on unregister; Rust just owns the storage and runs
//  the per-tick ballistic integrate kernel.
//
//  Single pool (not per-engine). Background battles don't fire
//  projectiles in current scope so multi-engine isolation isn't
//  needed today; if/when that changes the engine-handle pattern
//  from EngineStatics is the migration path.
//
//  Capacity is fixed at PROJECTILE_POOL_CAPACITY so the typed-
//  array views JS holds stay valid (no Vec realloc → no view
//  detachment from memory.grow). 8192 covers steady-state busy
//  combat well; allocator pre-grow at initSimWasm sizes the
//  WASM linear memory comfortably above this.
// ─────────────────────────────────────────────────────────────────

pub const PROJECTILE_POOL_CAPACITY: u32 = 8192;
pub(crate) const PROJECTILE_POOL_CAPACITY_USIZE: usize = PROJECTILE_POOL_CAPACITY as usize;

pub(crate) struct ProjectilePool {
    pos_x: Vec<f64>,
    pos_y: Vec<f64>,
    pos_z: Vec<f64>,
    vel_x: Vec<f64>,
    vel_y: Vec<f64>,
    vel_z: Vec<f64>,
    time_alive: Vec<f64>,
    source_turret_entity_id: Vec<i32>,
    source_host_id: Vec<i32>,
    source_root_id: Vec<i32>,
    source_player_id: Vec<i32>,
    source_team_id: Vec<i32>,
    source_turret_blueprint_code: Vec<u32>,
    source_shot_blueprint_code: Vec<u32>,
    spawn_tick: Vec<u32>,
    parent_shot_entity_id: Vec<i32>,
}

impl ProjectilePool {
    pub(crate) fn new() -> Self {
        let cap = PROJECTILE_POOL_CAPACITY_USIZE;
        Self {
            pos_x: vec![0.0; cap],
            pos_y: vec![0.0; cap],
            pos_z: vec![0.0; cap],
            vel_x: vec![0.0; cap],
            vel_y: vec![0.0; cap],
            vel_z: vec![0.0; cap],
            time_alive: vec![0.0; cap],
            source_turret_entity_id: vec![-1; cap],
            source_host_id: vec![-1; cap],
            source_root_id: vec![-1; cap],
            source_player_id: vec![-1; cap],
            source_team_id: vec![-1; cap],
            source_turret_blueprint_code: vec![u32::MAX; cap],
            source_shot_blueprint_code: vec![u32::MAX; cap],
            spawn_tick: vec![0; cap],
            parent_shot_entity_id: vec![-1; cap],
        }
    }
}

pub(crate) struct ProjectilePoolHolder(UnsafeCell<Option<ProjectilePool>>);
unsafe impl Sync for ProjectilePoolHolder {}
pub(crate) static PROJECTILE_POOL: ProjectilePoolHolder =
    ProjectilePoolHolder(UnsafeCell::new(None));

#[inline]
pub(crate) fn projectile_pool() -> &'static mut ProjectilePool {
    // SAFETY: WASM is single-threaded; pool_init() is the unique
    // initialiser. Consumers must call projectile_pool_init() before
    // any pool access.
    unsafe {
        (*PROJECTILE_POOL.0.get())
            .as_mut()
            .expect("projectile_pool_init() not called before access")
    }
}

#[wasm_bindgen]
pub fn projectile_pool_init() {
    unsafe {
        let cell = PROJECTILE_POOL.0.get();
        if (*cell).is_none() {
            *cell = Some(ProjectilePool::new());
        }
    }
}

#[wasm_bindgen]
pub fn projectile_pool_capacity() -> u32 {
    PROJECTILE_POOL_CAPACITY
}

macro_rules! projectile_pool_ptr_export {
    ($name:ident, $field:ident, $ty:ty) => {
        #[wasm_bindgen]
        pub fn $name() -> *const $ty {
            projectile_pool().$field.as_ptr()
        }
    };
}

projectile_pool_ptr_export!(projectile_pool_pos_x_ptr, pos_x, f64);
projectile_pool_ptr_export!(projectile_pool_pos_y_ptr, pos_y, f64);
projectile_pool_ptr_export!(projectile_pool_pos_z_ptr, pos_z, f64);
projectile_pool_ptr_export!(projectile_pool_vel_x_ptr, vel_x, f64);
projectile_pool_ptr_export!(projectile_pool_vel_y_ptr, vel_y, f64);
projectile_pool_ptr_export!(projectile_pool_vel_z_ptr, vel_z, f64);
projectile_pool_ptr_export!(projectile_pool_time_alive_ptr, time_alive, f64);
projectile_pool_ptr_export!(
    projectile_pool_source_turret_entity_id_ptr,
    source_turret_entity_id,
    i32
);
projectile_pool_ptr_export!(projectile_pool_source_host_id_ptr, source_host_id, i32);
projectile_pool_ptr_export!(projectile_pool_source_root_id_ptr, source_root_id, i32);
projectile_pool_ptr_export!(projectile_pool_source_player_id_ptr, source_player_id, i32);
projectile_pool_ptr_export!(projectile_pool_source_team_id_ptr, source_team_id, i32);
projectile_pool_ptr_export!(
    projectile_pool_source_turret_blueprint_code_ptr,
    source_turret_blueprint_code,
    u32
);
projectile_pool_ptr_export!(
    projectile_pool_source_shot_blueprint_code_ptr,
    source_shot_blueprint_code,
    u32
);
projectile_pool_ptr_export!(projectile_pool_spawn_tick_ptr, spawn_tick, u32);
projectile_pool_ptr_export!(
    projectile_pool_parent_shot_entity_id_ptr,
    parent_shot_entity_id,
    i32
);

// ─────────────────────────────────────────────────────────────────
//  Phase 5b — Kinematic intercept solver
//
//  Mirrors src/game/math/Ballistics.ts solveKinematicIntercept.
//  Sample-and-bisect search for the time t at which a projectile
//  launched from `origin` at constant speed `projectile_speed`
//  would intercept `target` (both are full kinematic states with
//  position + velocity + acceleration). Bit-identical to the TS
//  path — same constants, same evaluation count, same epsilon.
//
//  Used per-tick by:
//    - server homing projectiles (projectileSystem)
//    - server turret aim (combat targeting scheduler)
//    - client homing prediction (ClientProjectilePrediction)
//    - render-time range envelope (ProjectileRangeEnvelope3D)
//
//  Input buffer layout (22 f64s — caller fills a module-scope
//  scratch and passes by reference):
//    0..3   origin.position                  (x, y, z)
//    3..6   origin.velocity
//    6..9   origin.acceleration
//    9..12  target.position
//    12..15 target.velocity
//    15..18 target.acceleration
//    18..21 projectile_acceleration
//    21     projectile_speed
//
//  The public TypeScript targeting API derives projectile_acceleration
//  from its required gravity parameter as (0, 0, -gravity). It does not
//  pass air resistance or entity ids into this calculation.
//
//  Output buffer (7 f64s):
//    0      time
//    1..4   aim_point
//    4..7   launch_velocity
//
//  Returns 1 if a solution was found and out_buf was written, 0
//  otherwise (out_buf untouched).
// ─────────────────────────────────────────────────────────────────

pub(crate) const INTERCEPT_SAMPLE_COUNT: usize = 64;
pub(crate) const INTERCEPT_BISECT_STEPS: usize = 14;
pub(crate) const INTERCEPT_MIN_TIME: f64 = 1.0 / 120.0;
pub(crate) const INTERCEPT_MAX_TIME_DEFAULT: f64 = 30.0;
pub(crate) const INTERCEPT_ROOT_EPSILON: f64 = 1e-5;

#[inline]
pub(crate) fn intercept_input_finite(input: &[f64; 22]) -> bool {
    // All 22 fields finite; speed must be > 1e-6.
    for v in input.iter() {
        if !v.is_finite() {
            return false;
        }
    }
    input[21] > 1e-6
}

#[inline]
pub(crate) fn intercept_clamp_time(t: f64) -> f64 {
    t.max(INTERCEPT_MIN_TIME).min(INTERCEPT_MAX_TIME_DEFAULT)
}

#[inline]
pub(crate) fn intercept_default_max_time(input: &[f64; 22]) -> f64 {
    let dx = input[9] - input[0];
    let dy = input[10] - input[1];
    let dz = input[11] - input[2];
    let dist = (dx * dx + dy * dy + dz * dz).sqrt();
    let speed = input[21];
    let base_time = if speed > 1e-6 { dist / speed } else { 0.0 };
    let rel_ax = input[15] - input[18];
    let rel_ay = input[16] - input[19];
    let rel_az = input[17] - input[20];
    let rel_accel = (rel_ax * rel_ax + rel_ay * rel_ay + rel_az * rel_az).sqrt();
    let accel_time = if rel_accel > 1e-6 {
        2.0 * speed / rel_accel
    } else {
        0.0
    };
    intercept_clamp_time(
        (2.0_f64)
            .max(base_time * 8.0 + 4.0)
            .max(accel_time * 2.0 + 1.0),
    )
}

#[inline]
pub(crate) fn intercept_function(input: &[f64; 22], t: f64) -> f64 {
    let rel_x =
        input[9] - input[0] + (input[12] - input[3]) * t + 0.5 * (input[15] - input[18]) * t * t;
    let rel_y =
        input[10] - input[1] + (input[13] - input[4]) * t + 0.5 * (input[16] - input[19]) * t * t;
    let rel_z =
        input[11] - input[2] + (input[14] - input[5]) * t + 0.5 * (input[17] - input[20]) * t * t;
    (rel_x * rel_x + rel_y * rel_y + rel_z * rel_z).sqrt() - input[21] * t
}

#[inline]
pub(crate) fn intercept_bisect_root(input: &[f64; 22], lo_t: f64, hi_t: f64) -> f64 {
    let mut lo = lo_t;
    let mut hi = hi_t;
    let mut lo_f = intercept_function(input, lo);
    for _ in 0..INTERCEPT_BISECT_STEPS {
        let mid = (lo + hi) * 0.5;
        let mid_f = intercept_function(input, mid);
        if mid_f.abs() <= INTERCEPT_ROOT_EPSILON {
            return mid;
        }
        if (lo_f <= 0.0 && mid_f <= 0.0) || (lo_f >= 0.0 && mid_f >= 0.0) {
            lo = mid;
            lo_f = mid_f;
        } else {
            hi = mid;
        }
    }
    (lo + hi) * 0.5
}

#[inline]
pub(crate) fn projectile_air_drag_rate_from_friction_per_60hz_frame(
    friction_per_60hz_frame: f64,
    projectile_mass: f64,
) -> f64 {
    drag_rate_from_friction_per_60hz_frame(friction_per_60hz_frame, 1.0, projectile_mass)
}

#[inline]
fn damped_required_world_velocity_axis(
    displacement: f64,
    acceleration: f64,
    time: f64,
    drag_k: f64,
) -> f64 {
    let damp = (-drag_k * time).exp();
    let retention_loss = 1.0 - damp;
    if !retention_loss.is_finite() || retention_loss <= 1e-12 {
        return f64::NAN;
    }
    let terminal = acceleration / drag_k;
    terminal + (displacement - terminal * time) * drag_k / retention_loss
}

#[inline]
fn damped_intercept_function(
    input: &[f64; 22],
    time: f64,
    drag_k: f64,
    wind_x: f64,
    wind_y: f64,
    wind_z: f64,
) -> f64 {
    let aim_x = input[9] + input[12] * time + 0.5 * input[15] * time * time;
    let aim_y = input[10] + input[13] * time + 0.5 * input[16] * time * time;
    let aim_z = input[11] + input[14] * time + 0.5 * input[17] * time * time;

    let world_vx = wind_x
        + damped_required_world_velocity_axis(
            aim_x - input[0] - wind_x * time,
            input[18],
            time,
            drag_k,
        );
    let world_vy = wind_y
        + damped_required_world_velocity_axis(
            aim_y - input[1] - wind_y * time,
            input[19],
            time,
            drag_k,
        );
    let world_vz = wind_z
        + damped_required_world_velocity_axis(
            aim_z - input[2] - wind_z * time,
            input[20],
            time,
            drag_k,
        );
    if !world_vx.is_finite() || !world_vy.is_finite() || !world_vz.is_finite() {
        return f64::INFINITY;
    }

    let rel_vx = world_vx - input[3];
    let rel_vy = world_vy - input[4];
    let rel_vz = world_vz - input[5];
    (rel_vx * rel_vx + rel_vy * rel_vy + rel_vz * rel_vz).sqrt() - input[21]
}

#[inline]
fn damped_intercept_bisect_root(
    input: &[f64; 22],
    drag_k: f64,
    lo_t: f64,
    hi_t: f64,
    wind_x: f64,
    wind_y: f64,
    wind_z: f64,
) -> f64 {
    let mut lo = lo_t;
    let mut hi = hi_t;
    let mut lo_f = damped_intercept_function(input, lo, drag_k, wind_x, wind_y, wind_z);
    for _ in 0..INTERCEPT_BISECT_STEPS {
        let mid = (lo + hi) * 0.5;
        let mid_f = damped_intercept_function(input, mid, drag_k, wind_x, wind_y, wind_z);
        if mid_f.abs() <= INTERCEPT_ROOT_EPSILON {
            return mid;
        }
        if (lo_f <= 0.0 && mid_f <= 0.0) || (lo_f >= 0.0 && mid_f >= 0.0) {
            lo = mid;
            lo_f = mid_f;
        } else {
            hi = mid;
        }
    }
    (lo + hi) * 0.5
}

#[inline]
fn write_damped_intercept_solution(
    input: &[f64; 22],
    time: f64,
    drag_k: f64,
    wind_x: f64,
    wind_y: f64,
    wind_z: f64,
    out_buf: &mut [f64],
) -> bool {
    let aim_x = input[9] + input[12] * time + 0.5 * input[15] * time * time;
    let aim_y = input[10] + input[13] * time + 0.5 * input[16] * time * time;
    let aim_z = input[11] + input[14] * time + 0.5 * input[17] * time * time;
    let world_vx = wind_x
        + damped_required_world_velocity_axis(
            aim_x - input[0] - wind_x * time,
            input[18],
            time,
            drag_k,
        );
    let world_vy = wind_y
        + damped_required_world_velocity_axis(
            aim_y - input[1] - wind_y * time,
            input[19],
            time,
            drag_k,
        );
    let world_vz = wind_z
        + damped_required_world_velocity_axis(
            aim_z - input[2] - wind_z * time,
            input[20],
            time,
            drag_k,
        );
    if !world_vx.is_finite() || !world_vy.is_finite() || !world_vz.is_finite() {
        return false;
    }

    out_buf[0] = time;
    out_buf[1] = aim_x;
    out_buf[2] = aim_y;
    out_buf[3] = aim_z;
    out_buf[4] = world_vx - input[3];
    out_buf[5] = world_vy - input[4];
    out_buf[6] = world_vz - input[5];
    true
}

#[inline]
pub(crate) fn solve_damped_kinematic_intercept_inline(
    inp: &[f64; 22],
    out_buf: &mut [f64],
    prefer_late_solution: u8,
    max_time_sec_or_zero: f64,
    air_friction_per_60hz_frame: f64,
    projectile_mass: f64,
    wind_x: f64,
    wind_y: f64,
    wind_z: f64,
) -> bool {
    if !intercept_input_finite(inp)
        || !air_friction_per_60hz_frame.is_finite()
        || !projectile_mass.is_finite()
        || !wind_x.is_finite()
        || !wind_y.is_finite()
        || !wind_z.is_finite()
    {
        return false;
    }
    if air_friction_per_60hz_frame <= 0.0 {
        return solve_kinematic_intercept_inline(
            inp,
            out_buf,
            prefer_late_solution,
            max_time_sec_or_zero,
        );
    }
    if air_friction_per_60hz_frame >= 1.0 {
        return false;
    }
    if projectile_mass <= 1e-6 {
        return false;
    }
    let drag_k = projectile_air_drag_rate_from_friction_per_60hz_frame(
        air_friction_per_60hz_frame,
        projectile_mass,
    );
    if !drag_k.is_finite() || drag_k <= 1e-9 {
        return solve_kinematic_intercept_inline(
            inp,
            out_buf,
            prefer_late_solution,
            max_time_sec_or_zero,
        );
    }

    let max_time = if max_time_sec_or_zero > 0.0 && max_time_sec_or_zero.is_finite() {
        intercept_clamp_time(max_time_sec_or_zero)
    } else {
        intercept_default_max_time(inp)
    };
    if max_time <= INTERCEPT_MIN_TIME {
        return false;
    }

    let mut selected_root = 0.0_f64;
    let mut prev_t = INTERCEPT_MIN_TIME;
    let mut prev_f = damped_intercept_function(inp, prev_t, drag_k, wind_x, wind_y, wind_z);
    let want_late = prefer_late_solution != 0;
    if prev_f.abs() <= INTERCEPT_ROOT_EPSILON {
        selected_root = prev_t;
    }

    for i in 1..=INTERCEPT_SAMPLE_COUNT {
        let t = INTERCEPT_MIN_TIME
            + (max_time - INTERCEPT_MIN_TIME) * (i as f64) / (INTERCEPT_SAMPLE_COUNT as f64);
        let f = damped_intercept_function(inp, t, drag_k, wind_x, wind_y, wind_z);
        if !f.is_finite() || !prev_f.is_finite() {
            prev_t = t;
            prev_f = f;
            continue;
        }

        let mut root = 0.0_f64;
        if f.abs() <= INTERCEPT_ROOT_EPSILON {
            root = t;
        } else if (prev_f > 0.0 && f < 0.0) || (prev_f < 0.0 && f > 0.0) {
            root = damped_intercept_bisect_root(inp, drag_k, prev_t, t, wind_x, wind_y, wind_z);
        }
        if root > 0.0 {
            selected_root = root;
            if !want_late {
                break;
            }
        }
        prev_t = t;
        prev_f = f;
    }

    if selected_root <= INTERCEPT_MIN_TIME {
        return false;
    }
    write_damped_intercept_solution(inp, selected_root, drag_k, wind_x, wind_y, wind_z, out_buf)
}

#[inline]
pub(crate) fn solve_kinematic_intercept_inline(
    inp: &[f64; 22],
    out_buf: &mut [f64],
    prefer_late_solution: u8,
    max_time_sec_or_zero: f64,
) -> bool {
    if !intercept_input_finite(inp) {
        return false;
    }
    let max_time = if max_time_sec_or_zero > 0.0 && max_time_sec_or_zero.is_finite() {
        intercept_clamp_time(max_time_sec_or_zero)
    } else {
        intercept_default_max_time(inp)
    };

    let mut selected_root = 0.0_f64;
    let mut prev_t = 0.0_f64;
    let mut prev_f = intercept_function(inp, prev_t);
    let want_late = prefer_late_solution != 0;

    for i in 1..=INTERCEPT_SAMPLE_COUNT {
        let t = (max_time * (i as f64)) / (INTERCEPT_SAMPLE_COUNT as f64);
        let f = intercept_function(inp, t);
        let mut root = 0.0_f64;
        if f.abs() <= INTERCEPT_ROOT_EPSILON {
            root = t;
        } else if (prev_f > 0.0 && f < 0.0) || (prev_f < 0.0 && f > 0.0) {
            root = intercept_bisect_root(inp, prev_t, t);
        }
        if root > 0.0 {
            selected_root = root;
            if !want_late {
                break;
            }
        }
        prev_t = t;
        prev_f = f;
    }

    if selected_root <= INTERCEPT_MIN_TIME {
        return false;
    }

    // Write solution. Aim point = target's position at intercept time.
    let t = selected_root;
    let aim_x = inp[9] + inp[12] * t + 0.5 * inp[15] * t * t;
    let aim_y = inp[10] + inp[13] * t + 0.5 * inp[16] * t * t;
    let aim_z = inp[11] + inp[14] * t + 0.5 * inp[17] * t * t;

    // Origin at intercept time + projectile-relative acceleration → launch velocity.
    let origin_at_t_x = inp[0] + inp[3] * t + 0.5 * inp[6] * t * t;
    let origin_at_t_y = inp[1] + inp[4] * t + 0.5 * inp[7] * t * t;
    let origin_at_t_z = inp[2] + inp[5] * t + 0.5 * inp[8] * t * t;
    let proj_rel_ax = inp[18] - inp[6];
    let proj_rel_ay = inp[19] - inp[7];
    let proj_rel_az = inp[20] - inp[8];
    let inv_t = 1.0 / t;
    let lv_x = (aim_x - origin_at_t_x - 0.5 * proj_rel_ax * t * t) * inv_t;
    let lv_y = (aim_y - origin_at_t_y - 0.5 * proj_rel_ay * t * t) * inv_t;
    let lv_z = (aim_z - origin_at_t_z - 0.5 * proj_rel_az * t * t) * inv_t;

    out_buf[0] = t;
    out_buf[1] = aim_x;
    out_buf[2] = aim_y;
    out_buf[3] = aim_z;
    out_buf[4] = lv_x;
    out_buf[5] = lv_y;
    out_buf[6] = lv_z;
    true
}

#[wasm_bindgen]
pub fn solve_kinematic_intercept(
    input: &[f64],
    out_buf: &mut [f64],
    prefer_late_solution: u8,
    max_time_sec_or_zero: f64,
) -> u32 {
    debug_assert!(input.len() >= 22, "intercept input buffer too small");
    debug_assert!(out_buf.len() >= 7, "intercept output buffer too small");
    // Release builds: a malformed buffer reports "no solution" instead
    // of panicking the authoritative sim.
    if input.len() < 22 || out_buf.len() < 7 {
        return 0;
    }
    let inp: &[f64; 22] = (&input[0..22]).try_into().unwrap();
    if solve_kinematic_intercept_inline(inp, out_buf, prefer_late_solution, max_time_sec_or_zero) {
        1
    } else {
        0
    }
}

// ─────────────────────────────────────────────────────────────────
//  AIM-05 — Homing thrust acceleration
//
//  Mirrors src/game/math/HomingSteering.ts computeHomingThrust.
//  Returns the bounded steering acceleration a guided projectile
//  applies this tick: lateral guidance toward the predicted intercept
//  plus optional gravity compensation, clamped to the projectile's
//  available thrust acceleration. Rocket-class callers pass universal
//  gravity, so their engine budget pays for steering and holding altitude.
//
//  Output buffer (3 f64s): thrustX, thrustY, thrustZ.
//
//  Kept as a single-row export for client prediction and scattered
//  diagnostic callers. The local server projectile path uses
//  projectile_homing_guidance_batch below.
// ─────────────────────────────────────────────────────────────────

#[inline]
pub(crate) fn compute_homing_thrust_inline(
    vel_x: f64,
    vel_y: f64,
    vel_z: f64,
    target_x: f64,
    target_y: f64,
    target_z: f64,
    current_x: f64,
    current_y: f64,
    current_z: f64,
    homing_turn_rate: f64,
    max_thrust_accel: f64,
    gravity: f64,
    dt_sec: f64,
) -> (f64, f64, f64) {
    // Spent / failed guidance: no thrust this tick. The caller still
    // integrates whatever projectile gravity applies to this shot.
    if max_thrust_accel <= 0.0 || dt_sec <= 0.0 {
        return (0.0, 0.0, 0.0);
    }

    let dx = target_x - current_x;
    let dy = target_y - current_y;
    let dz = target_z - current_z;
    let d_mag = (dx * dx + dy * dy + dz * dz).sqrt();
    let speed = (vel_x * vel_x + vel_y * vel_y + vel_z * vel_z).sqrt();

    // Lateral steering direction (unit vector perpendicular to v in the
    // plane of v and d, pointing toward d) and magnitude (ω · |v|,
    // bounded by θ / dt so we don't overshoot the angle this tick).
    let mut perp_x = 0.0;
    let mut perp_y = 0.0;
    let mut perp_z = 0.0;
    let mut theta = 0.0;

    if d_mag > 1e-6 {
        let inv_d_mag = 1.0 / d_mag;
        let dxn = dx * inv_d_mag;
        // `dyn` is reserved in Rust — use `dyn_` for the y-direction unit.
        let dyn_ = dy * inv_d_mag;
        let dzn = dz * inv_d_mag;

        if speed > 1e-6 {
            let inv_speed = 1.0 / speed;
            let vxn = vel_x * inv_speed;
            let vyn = vel_y * inv_speed;
            let vzn = vel_z * inv_speed;
            let mut cos_a = vxn * dxn + vyn * dyn_ + vzn * dzn;
            if cos_a > 1.0 {
                cos_a = 1.0;
            } else if cos_a < -1.0 {
                cos_a = -1.0;
            }
            theta = cos_a.acos();

            // perp = d̂ − (d̂·v̂)·v̂, normalized
            let p_x = dxn - cos_a * vxn;
            let p_y = dyn_ - cos_a * vyn;
            let p_z = dzn - cos_a * vzn;
            let p_mag = (p_x * p_x + p_y * p_y + p_z * p_z).sqrt();
            if p_mag > 1e-6 {
                let inv = 1.0 / p_mag;
                perp_x = p_x * inv;
                perp_y = p_y * inv;
                perp_z = p_z * inv;
            } else if cos_a < 0.0 {
                // v̂ and d̂ are (nearly) anti-parallel — Gram-Schmidt
                // residual collapses. Pick a stable horizontal
                // perpendicular (rotate v in the xy-plane) so the
                // rocket starts pivoting instead of sitting on the
                // anti-parallel axis.
                let xy_mag = (vxn * vxn + vyn * vyn).sqrt();
                if xy_mag > 0.05 {
                    perp_x = -vyn / xy_mag;
                    perp_y = vxn / xy_mag;
                    perp_z = 0.0;
                } else {
                    // Velocity is essentially vertical — fall back to world +x.
                    perp_x = 1.0;
                    perp_y = 0.0;
                    perp_z = 0.0;
                }
                theta = core::f64::consts::PI;
            }
            // (cos_a ≈ +1: already aligned, theta ≈ 0, no lateral thrust needed.)
        }
        // Zero-velocity edge case: leave perp = 0 and let any caller-
        // provided gravity compensation define the thrust direction.
    }

    let omega_eff = if theta / dt_sec < homing_turn_rate {
        theta / dt_sec
    } else {
        homing_turn_rate
    };
    let a_lateral_mag = omega_eff * speed;

    // Desired thrust: lateral steering plus optional vertical gravity
    // compensation. The clamp below decides how much of that the
    // projectile's engine can actually deliver.
    let mut a_x = perp_x * a_lateral_mag;
    let mut a_y = perp_y * a_lateral_mag;
    let mut a_z = perp_z * a_lateral_mag + gravity;

    let a_mag = (a_x * a_x + a_y * a_y + a_z * a_z).sqrt();
    if a_mag > max_thrust_accel {
        let scale = max_thrust_accel / a_mag;
        a_x *= scale;
        a_y *= scale;
        a_z *= scale;
    }

    (a_x, a_y, a_z)
}

#[wasm_bindgen]
pub fn compute_homing_thrust(
    out_buf: &mut [f64],
    vel_x: f64,
    vel_y: f64,
    vel_z: f64,
    target_x: f64,
    target_y: f64,
    target_z: f64,
    current_x: f64,
    current_y: f64,
    current_z: f64,
    homing_turn_rate: f64,
    max_thrust_accel: f64,
    gravity: f64,
    dt_sec: f64,
) {
    debug_assert!(out_buf.len() >= 3);
    let (a_x, a_y, a_z) = compute_homing_thrust_inline(
        vel_x,
        vel_y,
        vel_z,
        target_x,
        target_y,
        target_z,
        current_x,
        current_y,
        current_z,
        homing_turn_rate,
        max_thrust_accel,
        gravity,
        dt_sec,
    );
    out_buf[0] = a_x;
    out_buf[1] = a_y;
    out_buf[2] = a_z;
}

pub const PROJECTILE_HOMING_GUIDANCE_STRIDE: usize = 33;

pub(crate) const PHG_ROW_VEL_X: usize = 0;
pub(crate) const PHG_ROW_VEL_Y: usize = 1;
pub(crate) const PHG_ROW_VEL_Z: usize = 2;
pub(crate) const PHG_ROW_STEER_X: usize = 3;
pub(crate) const PHG_ROW_STEER_Y: usize = 4;
pub(crate) const PHG_ROW_STEER_Z: usize = 5;
pub(crate) const PHG_ROW_CURRENT_X: usize = 6;
pub(crate) const PHG_ROW_CURRENT_Y: usize = 7;
pub(crate) const PHG_ROW_CURRENT_Z: usize = 8;
pub(crate) const PHG_ROW_TARGET_VEL_X: usize = 9;
pub(crate) const PHG_ROW_TARGET_VEL_Y: usize = 10;
pub(crate) const PHG_ROW_TARGET_VEL_Z: usize = 11;
pub(crate) const PHG_ROW_TARGET_ACCEL_X: usize = 12;
pub(crate) const PHG_ROW_TARGET_ACCEL_Y: usize = 13;
pub(crate) const PHG_ROW_TARGET_ACCEL_Z: usize = 14;
pub(crate) const PHG_ROW_ORIGIN_VEL_X: usize = 15;
pub(crate) const PHG_ROW_ORIGIN_VEL_Y: usize = 16;
pub(crate) const PHG_ROW_ORIGIN_VEL_Z: usize = 17;
pub(crate) const PHG_ROW_ORIGIN_ACCEL_X: usize = 18;
pub(crate) const PHG_ROW_ORIGIN_ACCEL_Y: usize = 19;
pub(crate) const PHG_ROW_ORIGIN_ACCEL_Z: usize = 20;
pub(crate) const PHG_ROW_PROJECTILE_SPEED: usize = 21;
pub(crate) const PHG_ROW_PROJECTILE_GRAVITY: usize = 22;
pub(crate) const PHG_ROW_MAX_TIME_SEC: usize = 23;
pub(crate) const PHG_ROW_HOMING_TURN_RATE: usize = 24;
pub(crate) const PHG_ROW_MAX_THRUST_ACCEL: usize = 25;
pub(crate) const PHG_ROW_SOLVE_INTERCEPT: usize = 26;
pub(crate) const PHG_ROW_PROJECTILE_AIR_FRICTION_PER_60HZ_FRAME: usize = 27;
pub(crate) const PHG_ROW_PROJECTILE_MASS: usize = 28;
pub(crate) const PHG_ROW_OUT_THRUST_X: usize = 29;
pub(crate) const PHG_ROW_OUT_THRUST_Y: usize = 30;
pub(crate) const PHG_ROW_OUT_THRUST_Z: usize = 31;
pub(crate) const PHG_ROW_OUT_INTERCEPT_FOUND: usize = 32;

#[wasm_bindgen]
pub fn projectile_homing_guidance_batch(
    rows: &mut [f64],
    count: usize,
    dt_sec: f64,
    wind_x: f64,
    wind_y: f64,
    wind_z: f64,
) -> u32 {
    let required = match count.checked_mul(PROJECTILE_HOMING_GUIDANCE_STRIDE) {
        Some(value) => value,
        None => return 0,
    };
    if rows.len() < required {
        return 0;
    }

    let mut processed = 0_u32;
    for i in 0..count {
        let base = i * PROJECTILE_HOMING_GUIDANCE_STRIDE;
        rows[base + PHG_ROW_OUT_THRUST_X] = 0.0;
        rows[base + PHG_ROW_OUT_THRUST_Y] = 0.0;
        rows[base + PHG_ROW_OUT_THRUST_Z] = 0.0;
        rows[base + PHG_ROW_OUT_INTERCEPT_FOUND] = 0.0;

        let mut steer_x = rows[base + PHG_ROW_STEER_X];
        let mut steer_y = rows[base + PHG_ROW_STEER_Y];
        let mut steer_z = rows[base + PHG_ROW_STEER_Z];
        let gravity = rows[base + PHG_ROW_PROJECTILE_GRAVITY];

        if rows[base + PHG_ROW_SOLVE_INTERCEPT] != 0.0 {
            let input = [
                rows[base + PHG_ROW_CURRENT_X],
                rows[base + PHG_ROW_CURRENT_Y],
                rows[base + PHG_ROW_CURRENT_Z],
                rows[base + PHG_ROW_ORIGIN_VEL_X],
                rows[base + PHG_ROW_ORIGIN_VEL_Y],
                rows[base + PHG_ROW_ORIGIN_VEL_Z],
                rows[base + PHG_ROW_ORIGIN_ACCEL_X],
                rows[base + PHG_ROW_ORIGIN_ACCEL_Y],
                rows[base + PHG_ROW_ORIGIN_ACCEL_Z],
                steer_x,
                steer_y,
                steer_z,
                rows[base + PHG_ROW_TARGET_VEL_X],
                rows[base + PHG_ROW_TARGET_VEL_Y],
                rows[base + PHG_ROW_TARGET_VEL_Z],
                rows[base + PHG_ROW_TARGET_ACCEL_X],
                rows[base + PHG_ROW_TARGET_ACCEL_Y],
                rows[base + PHG_ROW_TARGET_ACCEL_Z],
                0.0,
                0.0,
                -gravity,
                rows[base + PHG_ROW_PROJECTILE_SPEED],
            ];
            let mut intercept_out = [0.0_f64; 7];
            if solve_damped_kinematic_intercept_inline(
                &input,
                &mut intercept_out,
                0,
                rows[base + PHG_ROW_MAX_TIME_SEC],
                rows[base + PHG_ROW_PROJECTILE_AIR_FRICTION_PER_60HZ_FRAME],
                rows[base + PHG_ROW_PROJECTILE_MASS],
                wind_x,
                wind_y,
                wind_z,
            ) {
                steer_x = intercept_out[1];
                steer_y = intercept_out[2];
                steer_z = intercept_out[3];
                rows[base + PHG_ROW_OUT_INTERCEPT_FOUND] = 1.0;
            }
        }

        let (thrust_x, thrust_y, thrust_z) = compute_homing_thrust_inline(
            rows[base + PHG_ROW_VEL_X],
            rows[base + PHG_ROW_VEL_Y],
            rows[base + PHG_ROW_VEL_Z],
            steer_x,
            steer_y,
            steer_z,
            rows[base + PHG_ROW_CURRENT_X],
            rows[base + PHG_ROW_CURRENT_Y],
            rows[base + PHG_ROW_CURRENT_Z],
            rows[base + PHG_ROW_HOMING_TURN_RATE],
            rows[base + PHG_ROW_MAX_THRUST_ACCEL],
            gravity,
            dt_sec,
        );
        rows[base + PHG_ROW_OUT_THRUST_X] = thrust_x;
        rows[base + PHG_ROW_OUT_THRUST_Y] = thrust_y;
        rows[base + PHG_ROW_OUT_THRUST_Z] = thrust_z;
        processed += 1;
    }

    processed
}

#[wasm_bindgen]
pub fn projectile_homing_guidance_apply_batch(
    rows: &mut [f64],
    projectile_indices: &[i32],
    accel_x: &mut [f64],
    accel_y: &mut [f64],
    accel_z: &mut [f64],
    count: usize,
    dt_sec: f64,
    wind_x: f64,
    wind_y: f64,
    wind_z: f64,
) -> u32 {
    let required = match count.checked_mul(PROJECTILE_HOMING_GUIDANCE_STRIDE) {
        Some(value) => value,
        None => return 0,
    };
    if rows.len() < required || projectile_indices.len() < count {
        return 0;
    }

    for &projectile_index in projectile_indices.iter().take(count) {
        if projectile_index < 0 {
            return 0;
        }
        let i = projectile_index as usize;
        if i >= accel_x.len() || i >= accel_y.len() || i >= accel_z.len() {
            return 0;
        }
    }

    let processed = projectile_homing_guidance_batch(rows, count, dt_sec, wind_x, wind_y, wind_z);
    if processed as usize != count {
        return processed;
    }

    for (row_index, &projectile_index) in projectile_indices.iter().take(count).enumerate() {
        let projectile_index = projectile_index as usize;
        let base = row_index * PROJECTILE_HOMING_GUIDANCE_STRIDE;
        accel_x[projectile_index] += rows[base + PHG_ROW_OUT_THRUST_X];
        accel_y[projectile_index] += rows[base + PHG_ROW_OUT_THRUST_Y];
        accel_z[projectile_index] += rows[base + PHG_ROW_OUT_THRUST_Z];
    }

    processed
}

const LINE_SHOT_RANGE_EPSILON: f64 = 1e-9;
const LINE_SHOT_RANGE_VOLUME_CYLINDER_NORMAL: u32 = 0;
const LINE_SHOT_RANGE_VOLUME_BOTTOM_UNBOUNDED: u32 = 1;
const LINE_SHOT_RANGE_VOLUME_TOP_AND_BOTTOM_UNBOUNDED: u32 = 2;
const LINE_SHOT_RANGE_VOLUME_SPHERE: u32 = 3;

#[inline]
fn line_shot_distance_to_range_volume_inline(
    start_x: f64,
    start_y: f64,
    start_z: f64,
    dir_x: f64,
    dir_y: f64,
    dir_z: f64,
    center_x: f64,
    center_y: f64,
    center_z: f64,
    radius: f64,
    range_volume: u32,
) -> Option<f64> {
    let dir_len = (dir_x * dir_x + dir_y * dir_y + dir_z * dir_z).sqrt();
    if dir_len <= LINE_SHOT_RANGE_EPSILON
        || !center_x.is_finite()
        || !center_y.is_finite()
        || !center_z.is_finite()
        || !radius.is_finite()
        || radius < 0.0
    {
        return None;
    }

    let ux = dir_x / dir_len;
    let uy = dir_y / dir_len;
    let uz = dir_z / dir_len;
    let ox = start_x - center_x;
    let oy = start_y - center_y;
    let oz = start_z - center_z;

    if range_volume == LINE_SHOT_RANGE_VOLUME_SPHERE {
        let sphere_b = 2.0 * (ox * ux + oy * uy + oz * uz);
        let sphere_c = ox * ox + oy * oy + oz * oz - radius * radius;
        let disc = sphere_b * sphere_b - 4.0 * sphere_c;
        if disc < 0.0 {
            return None;
        }
        let sqrt_disc = disc.sqrt();
        let t0 = (-sphere_b - sqrt_disc) * 0.5;
        let t1 = (-sphere_b + sqrt_disc) * 0.5;
        let t = if sphere_c <= LINE_SHOT_RANGE_EPSILON {
            t0.max(t1)
        } else {
            let p0 = if t0 >= 0.0 { t0 } else { f64::INFINITY };
            let p1 = if t1 >= 0.0 { t1 } else { f64::INFINITY };
            p0.min(p1)
        };
        return if t >= 0.0 && t.is_finite() {
            Some(t)
        } else {
            None
        };
    }

    let bottom_bounded = match range_volume {
        LINE_SHOT_RANGE_VOLUME_CYLINDER_NORMAL => true,
        LINE_SHOT_RANGE_VOLUME_BOTTOM_UNBOUNDED
        | LINE_SHOT_RANGE_VOLUME_TOP_AND_BOTTOM_UNBOUNDED => false,
        _ => false,
    };
    let mut best = f64::INFINITY;
    let horizontal_a = ux * ux + uy * uy;
    let horizontal_c = ox * ox + oy * oy - radius * radius;
    if horizontal_a > LINE_SHOT_RANGE_EPSILON {
        let horizontal_b = 2.0 * (ox * ux + oy * uy);
        let disc = horizontal_b * horizontal_b - 4.0 * horizontal_a * horizontal_c;
        if disc >= 0.0 {
            let sqrt_disc = disc.sqrt();
            let inv_denom = 1.0 / (2.0 * horizontal_a);
            let t0 = (-horizontal_b - sqrt_disc) * inv_denom;
            let t1 = (-horizontal_b + sqrt_disc) * inv_denom;
            let t = if horizontal_c <= LINE_SHOT_RANGE_EPSILON {
                t0.max(t1)
            } else {
                let p0 = if t0 >= 0.0 { t0 } else { f64::INFINITY };
                let p1 = if t1 >= 0.0 { t1 } else { f64::INFINITY };
                p0.min(p1)
            };
            if t >= 0.0 && t.is_finite() {
                best = best.min(t);
            }
        }
    }

    if range_volume != LINE_SHOT_RANGE_VOLUME_TOP_AND_BOTTOM_UNBOUNDED
        && uz > LINE_SHOT_RANGE_EPSILON
    {
        let top_z = center_z + radius;
        let top_distance = (top_z - start_z) / uz;
        if top_distance >= 0.0 && top_distance.is_finite() {
            best = best.min(top_distance);
        }
    }
    if bottom_bounded && uz < -LINE_SHOT_RANGE_EPSILON {
        let bottom_z = center_z - radius;
        let bottom_distance = (bottom_z - start_z) / uz;
        if bottom_distance >= 0.0 && bottom_distance.is_finite() {
            best = best.min(bottom_distance);
        }
    }

    if best.is_finite() {
        Some(best)
    } else {
        None
    }
}

#[wasm_bindgen]
pub fn line_shot_distance_to_range_volume(
    start_x: f64,
    start_y: f64,
    start_z: f64,
    dir_x: f64,
    dir_y: f64,
    dir_z: f64,
    center_x: f64,
    center_y: f64,
    center_z: f64,
    radius: f64,
    range_volume: u32,
) -> f64 {
    line_shot_distance_to_range_volume_inline(
        start_x,
        start_y,
        start_z,
        dir_x,
        dir_y,
        dir_z,
        center_x,
        center_y,
        center_z,
        radius,
        range_volume,
    )
    .unwrap_or(-1.0)
}

#[wasm_bindgen]
pub fn line_shot_range_endpoint(
    out_buf: &mut [f64],
    start_x: f64,
    start_y: f64,
    start_z: f64,
    dir_x: f64,
    dir_y: f64,
    dir_z: f64,
    center_x: f64,
    center_y: f64,
    center_z: f64,
    radius: f64,
    range_volume: u32,
) -> u32 {
    if out_buf.len() < 3 {
        return 0;
    }

    let dir_len = (dir_x * dir_x + dir_y * dir_y + dir_z * dir_z).sqrt();
    let distance = line_shot_distance_to_range_volume_inline(
        start_x,
        start_y,
        start_z,
        dir_x,
        dir_y,
        dir_z,
        center_x,
        center_y,
        center_z,
        radius,
        range_volume,
    );
    if dir_len <= LINE_SHOT_RANGE_EPSILON || distance.is_none() {
        out_buf[0] = start_x;
        out_buf[1] = start_y;
        out_buf[2] = start_z;
        return 1;
    }

    let inv_dir_len = 1.0 / dir_len;
    let distance = distance.unwrap();
    out_buf[0] = start_x + dir_x * inv_dir_len * distance;
    out_buf[1] = start_y + dir_y * inv_dir_len * distance;
    out_buf[2] = start_z + dir_z * inv_dir_len * distance;
    1
}

/// Upward engine acceleration for a terrain-following projectile/body.
///
/// Mirrors the former TypeScript TerrainFollowThrust helper. Gravity is
/// still integrated by the caller; this returns the bounded thrust that
/// tries to cancel gravity and close the vertical terrain error.
#[wasm_bindgen]
pub fn terrain_follow_vertical_thrust_accel(
    position_z: f64,
    velocity_z: f64,
    target_z: f64,
    mass: f64,
    gravity: f64,
    spring_accel_per_world_unit: f64,
    damping_ratio: f64,
    max_thrust_force: f64,
) -> f64 {
    let safe_mass = if mass > 1e-6 { mass } else { 1e-6 };
    let max_thrust_accel = js_max(0.0, max_thrust_force) / safe_mass;
    if max_thrust_accel <= 0.0 {
        return 0.0;
    }

    let spring_accel = js_max(0.0, spring_accel_per_world_unit);
    let damping_ratio = js_max(0.0, damping_ratio);
    let damping_accel_per_speed = if spring_accel > 0.0 {
        2.0 * spring_accel.sqrt() * damping_ratio
    } else {
        0.0
    };
    let height_error = target_z - position_z;
    let desired_thrust_accel =
        gravity + spring_accel * height_error - damping_accel_per_speed * velocity_z;
    js_max(0.0, js_min(max_thrust_accel, desired_thrust_accel))
}

/// Batched projectile/body integrator with constant authored acceleration
/// and optional wind-relative linear air-drag force.
///
/// When drag coefficient or inverse mass is zero, this reduces to exact
/// constant-acceleration integration. Otherwise the kernel integrates the
/// continuous force model
/// matching the ballistic solver:
///   F_drag = drag_coefficient * (wind_velocity - projectile_velocity)
///   a_drag = F_drag / projectile_mass
/// TypeScript still owns projectile lifecycle and target policy, but all
/// non-packed guided/D-gun projectile integration now crosses this kernel in
/// one batch per tick.
#[wasm_bindgen]
pub fn projectile_integrate_step_batch(
    count: u32,
    pos_x: &mut [f64],
    pos_y: &mut [f64],
    pos_z: &mut [f64],
    vel_x: &mut [f64],
    vel_y: &mut [f64],
    vel_z: &mut [f64],
    accel_x: &[f64],
    accel_y: &[f64],
    accel_z: &[f64],
    air_drag_coefficient: &[f64],
    inv_mass: &[f64],
    wind_x: f64,
    wind_y: f64,
    wind_z: f64,
    dt_sec: f64,
) -> u32 {
    let n = count as usize;
    if pos_x.len() < n
        || pos_y.len() < n
        || pos_z.len() < n
        || vel_x.len() < n
        || vel_y.len() < n
        || vel_z.len() < n
        || accel_x.len() < n
        || accel_y.len() < n
        || accel_z.len() < n
        || air_drag_coefficient.len() < n
        || inv_mass.len() < n
        || !dt_sec.is_finite()
        || !wind_x.is_finite()
        || !wind_y.is_finite()
        || !wind_z.is_finite()
    {
        return 0;
    }

    for i in 0..n {
        let drag_rate = drag_rate_from_coefficient(air_drag_coefficient[i], inv_mass[i]);
        integrate_linear_damped_axis(
            &mut pos_x[i],
            &mut vel_x[i],
            accel_x[i],
            dt_sec,
            drag_rate,
            wind_x,
        );
        integrate_linear_damped_axis(
            &mut pos_y[i],
            &mut vel_y[i],
            accel_y[i],
            dt_sec,
            drag_rate,
            wind_y,
        );
        integrate_linear_damped_axis(
            &mut pos_z[i],
            &mut vel_z[i],
            accel_z[i],
            dt_sec,
            drag_rate,
            wind_z,
        );
    }
    count
}

#[inline]
pub(crate) fn integrate_linear_damped_axis(
    pos: &mut f64,
    vel: &mut f64,
    accel: f64,
    dt_sec: f64,
    drag_rate: f64,
    wind_velocity: f64,
) {
    integrate_linear_drag_axis(pos, vel, accel, dt_sec, drag_rate, wind_velocity);
}

/// Per-tick ballistic integrator. For slots 0..count, advances with the
/// same constant-acceleration equation the ballistic aim solver uses:
///   pos_x[i] += vel_x[i] * dt_sec
///   pos_y[i] += vel_y[i] * dt_sec
///   pos_z[i] += vel_z[i] * dt_sec - 0.5 * GRAVITY * dt_sec^2
///   vel_z[i] -= GRAVITY * dt_sec
///   time_alive[i] += dt_ms
/// Same motion math as the packed projectile update loop in projectileSystem,
/// with pool-owned lifetime advanced in the same Rust pass.
#[wasm_bindgen]
pub fn pool_step_packed_projectiles_batch(count: u32, dt_sec: f64, dt_ms: f64) {
    let p = projectile_pool();
    let n = count as usize;
    debug_assert!(n <= PROJECTILE_POOL_CAPACITY_USIZE);
    let half_dt_sq = 0.5 * dt_sec * dt_sec;
    for i in 0..n {
        p.pos_x[i] += p.vel_x[i] * dt_sec;
        p.pos_y[i] += p.vel_y[i] * dt_sec;
        p.pos_z[i] += p.vel_z[i] * dt_sec - GRAVITY * half_dt_sq;
        p.vel_z[i] -= GRAVITY * dt_sec;
        p.time_alive[i] += dt_ms;
    }
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
    fn line_shot_range_cylinder_clips_side_and_caps() {
        let side = line_shot_distance_to_range_volume_inline(
            0.0,
            0.0,
            0.0,
            1.0,
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
            10.0,
            LINE_SHOT_RANGE_VOLUME_CYLINDER_NORMAL,
        )
        .unwrap();
        assert_close(side, 10.0);

        let top = line_shot_distance_to_range_volume_inline(
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
            1.0,
            0.0,
            0.0,
            0.0,
            10.0,
            LINE_SHOT_RANGE_VOLUME_CYLINDER_NORMAL,
        )
        .unwrap();
        assert_close(top, 10.0);

        let bottom = line_shot_distance_to_range_volume_inline(
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
            -1.0,
            0.0,
            0.0,
            0.0,
            10.0,
            LINE_SHOT_RANGE_VOLUME_CYLINDER_NORMAL,
        )
        .unwrap();
        assert_close(bottom, 10.0);
    }

    #[test]
    fn line_shot_range_respects_unbounded_modes() {
        let bottom_unbounded = line_shot_distance_to_range_volume_inline(
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
            -1.0,
            0.0,
            0.0,
            0.0,
            10.0,
            LINE_SHOT_RANGE_VOLUME_BOTTOM_UNBOUNDED,
        );
        assert!(bottom_unbounded.is_none());

        let fully_unbounded = line_shot_distance_to_range_volume_inline(
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
            1.0,
            0.0,
            0.0,
            0.0,
            10.0,
            LINE_SHOT_RANGE_VOLUME_TOP_AND_BOTTOM_UNBOUNDED,
        );
        assert!(fully_unbounded.is_none());
    }

    #[test]
    fn line_shot_range_sphere_uses_nearest_forward_hit_or_exit() {
        let exit_from_inside = line_shot_distance_to_range_volume_inline(
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
            1.0,
            0.0,
            0.0,
            0.0,
            10.0,
            LINE_SHOT_RANGE_VOLUME_SPHERE,
        )
        .unwrap();
        assert_close(exit_from_inside, 10.0);

        let entry_from_outside = line_shot_distance_to_range_volume_inline(
            20.0,
            0.0,
            0.0,
            -1.0,
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
            10.0,
            LINE_SHOT_RANGE_VOLUME_SPHERE,
        )
        .unwrap();
        assert_close(entry_from_outside, 10.0);

        let miss = line_shot_distance_to_range_volume_inline(
            20.0,
            0.0,
            0.0,
            1.0,
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
            10.0,
            LINE_SHOT_RANGE_VOLUME_SPHERE,
        );
        assert!(miss.is_none());
    }

    #[test]
    fn line_shot_range_endpoint_writes_normalized_exit_point() {
        let mut out = [0.0_f64; 3];
        let written = line_shot_range_endpoint(
            &mut out,
            0.0,
            0.0,
            0.0,
            2.0,
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
            10.0,
            LINE_SHOT_RANGE_VOLUME_CYLINDER_NORMAL,
        );
        assert_eq!(written, 1);
        assert_close(out[0], 10.0);
        assert_close(out[1], 0.0);
        assert_close(out[2], 0.0);
    }
}

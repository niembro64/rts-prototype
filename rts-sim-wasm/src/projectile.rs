// projectile — extracted from lib.rs (pure code motion).

use crate::linear_damping::integrate_linear_damping_axis;
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

pub(crate) static PROJECTILE_POOL: WasmLazy<ProjectilePool> = WasmLazy::new();

#[inline]
pub(crate) fn projectile_pool() -> &'static mut ProjectilePool {
    PROJECTILE_POOL.get_initialized("projectile_pool_init() not called before access")
}

#[wasm_bindgen]
pub fn projectile_pool_init() {
    PROJECTILE_POOL.init_if_empty(ProjectilePool::new);
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
//    - render-time range envelope (ProjectileRangeEnvelope3D)
//
//  Input buffer layout (22 f64s — caller fills a module-scope
//  scratch and passes by reference):
//    0..3   origin.position                  (x, y, z)
//    3..6   origin.velocity
//    6..9   reserved (origin acceleration is deliberately not predicted)
//    9..12  target.position
//    12..15 target.velocity
//    15..18 reserved (target acceleration is deliberately not predicted)
//    18..21 projectile_acceleration
//    21     projectile_speed
//
//  The public TypeScript targeting API derives projectile_acceleration
//  from its required gravity parameter as (0, 0, -gravity). It does not
//  pass medium damping or entity ids into this calculation.
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
    let rel_ax = -input[18];
    let rel_ay = -input[19];
    let rel_az = -input[20];
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
        input[9] - input[0] + (input[12] - input[3]) * t - 0.5 * input[18] * t * t;
    let rel_y =
        input[10] - input[1] + (input[13] - input[4]) * t - 0.5 * input[19] * t * t;
    let rel_z =
        input[11] - input[2] + (input[14] - input[5]) * t - 0.5 * input[20] * t * t;
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
fn damped_required_world_velocity_axis(
    displacement: f64,
    acceleration: f64,
    time: f64,
    damping_rate: f64,
) -> f64 {
    let damp = (-damping_rate * time).exp();
    let retention_loss = 1.0 - damp;
    if !retention_loss.is_finite() || retention_loss <= 1e-12 {
        return f64::NAN;
    }
    let terminal = acceleration / damping_rate;
    terminal + (displacement - terminal * time) * damping_rate / retention_loss
}

#[inline]
fn damped_intercept_function(
    input: &[f64; 22],
    time: f64,
    damping_rate: f64,
    medium_velocity_x: f64,
    medium_velocity_y: f64,
    medium_velocity_z: f64,
) -> f64 {
    let aim_x = input[9] + input[12] * time;
    let aim_y = input[10] + input[13] * time;
    let aim_z = input[11] + input[14] * time;

    let world_vx = medium_velocity_x
        + damped_required_world_velocity_axis(
            aim_x - input[0] - medium_velocity_x * time,
            input[18],
            time,
            damping_rate,
        );
    let world_vy = medium_velocity_y
        + damped_required_world_velocity_axis(
            aim_y - input[1] - medium_velocity_y * time,
            input[19],
            time,
            damping_rate,
        );
    let world_vz = medium_velocity_z
        + damped_required_world_velocity_axis(
            aim_z - input[2] - medium_velocity_z * time,
            input[20],
            time,
            damping_rate,
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
    damping_rate: f64,
    lo_t: f64,
    hi_t: f64,
    medium_velocity_x: f64,
    medium_velocity_y: f64,
    medium_velocity_z: f64,
) -> f64 {
    let mut lo = lo_t;
    let mut hi = hi_t;
    let mut lo_f = damped_intercept_function(
        input,
        lo,
        damping_rate,
        medium_velocity_x,
        medium_velocity_y,
        medium_velocity_z,
    );
    for _ in 0..INTERCEPT_BISECT_STEPS {
        let mid = (lo + hi) * 0.5;
        let mid_f = damped_intercept_function(
            input,
            mid,
            damping_rate,
            medium_velocity_x,
            medium_velocity_y,
            medium_velocity_z,
        );
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
    damping_rate: f64,
    medium_velocity_x: f64,
    medium_velocity_y: f64,
    medium_velocity_z: f64,
    out_buf: &mut [f64],
) -> bool {
    let aim_x = input[9] + input[12] * time;
    let aim_y = input[10] + input[13] * time;
    let aim_z = input[11] + input[14] * time;
    let world_vx = medium_velocity_x
        + damped_required_world_velocity_axis(
            aim_x - input[0] - medium_velocity_x * time,
            input[18],
            time,
            damping_rate,
        );
    let world_vy = medium_velocity_y
        + damped_required_world_velocity_axis(
            aim_y - input[1] - medium_velocity_y * time,
            input[19],
            time,
            damping_rate,
        );
    let world_vz = medium_velocity_z
        + damped_required_world_velocity_axis(
            aim_z - input[2] - medium_velocity_z * time,
            input[20],
            time,
            damping_rate,
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
    linear_damping_rate: f64,
    medium_velocity_x: f64,
    medium_velocity_y: f64,
    medium_velocity_z: f64,
) -> bool {
    if !intercept_input_finite(inp)
        || !linear_damping_rate.is_finite()
        || !medium_velocity_x.is_finite()
        || !medium_velocity_y.is_finite()
        || !medium_velocity_z.is_finite()
    {
        return false;
    }
    if linear_damping_rate <= 0.0 {
        return solve_kinematic_intercept_inline(
            inp,
            out_buf,
            prefer_late_solution,
            max_time_sec_or_zero,
        );
    }
    let damping_rate = linear_damping_rate;
    if !damping_rate.is_finite() || damping_rate <= 1e-9 {
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
    let mut prev_f = damped_intercept_function(
        inp,
        prev_t,
        damping_rate,
        medium_velocity_x,
        medium_velocity_y,
        medium_velocity_z,
    );
    let want_late = prefer_late_solution != 0;
    if prev_f.abs() <= INTERCEPT_ROOT_EPSILON {
        selected_root = prev_t;
    }

    for i in 1..=INTERCEPT_SAMPLE_COUNT {
        let t = INTERCEPT_MIN_TIME
            + (max_time - INTERCEPT_MIN_TIME) * (i as f64) / (INTERCEPT_SAMPLE_COUNT as f64);
        let f = damped_intercept_function(
            inp,
            t,
            damping_rate,
            medium_velocity_x,
            medium_velocity_y,
            medium_velocity_z,
        );
        if !f.is_finite() || !prev_f.is_finite() {
            prev_t = t;
            prev_f = f;
            continue;
        }

        let mut root = 0.0_f64;
        if f.abs() <= INTERCEPT_ROOT_EPSILON {
            root = t;
        } else if (prev_f > 0.0 && f < 0.0) || (prev_f < 0.0 && f > 0.0) {
            root = damped_intercept_bisect_root(
                inp,
                damping_rate,
                prev_t,
                t,
                medium_velocity_x,
                medium_velocity_y,
                medium_velocity_z,
            );
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
    write_damped_intercept_solution(
        inp,
        selected_root,
        damping_rate,
        medium_velocity_x,
        medium_velocity_y,
        medium_velocity_z,
        out_buf,
    )
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
    let aim_x = inp[9] + inp[12] * t;
    let aim_y = inp[10] + inp[13] * t;
    let aim_z = inp[11] + inp[14] * t;

    // Launch velocity is relative to the origin's current world velocity.
    // Entity acceleration is noisy control state and is not extrapolated.
    let inv_t = 1.0 / t;
    let lv_x = (aim_x - inp[0] - 0.5 * inp[18] * t * t) * inv_t - inp[3];
    let lv_y = (aim_y - inp[1] - 0.5 * inp[19] * t * t) * inv_t - inp[4];
    let lv_z = (aim_z - inp[2] - 0.5 * inp[20] * t * t) * inv_t - inp[5];

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
//  Kept as a single-row export for scattered diagnostic callers.
//  The local server projectile path uses
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

#[inline]
pub(crate) fn compute_constant_speed_homing_velocity_inline(
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
    dt_sec: f64,
) -> (f64, f64, f64) {
    if homing_turn_rate <= 0.0 || dt_sec <= 0.0 {
        return (vel_x, vel_y, vel_z);
    }

    let speed = (vel_x * vel_x + vel_y * vel_y + vel_z * vel_z).sqrt();
    if !speed.is_finite() || speed <= 1e-6 {
        return (vel_x, vel_y, vel_z);
    }

    let dx = target_x - current_x;
    let dy = target_y - current_y;
    let dz = target_z - current_z;
    let d_mag = (dx * dx + dy * dy + dz * dz).sqrt();
    if !d_mag.is_finite() || d_mag <= 1e-6 {
        return (vel_x, vel_y, vel_z);
    }

    let inv_speed = 1.0 / speed;
    let vxn = vel_x * inv_speed;
    let vyn = vel_y * inv_speed;
    let vzn = vel_z * inv_speed;
    let inv_d_mag = 1.0 / d_mag;
    let dxn = dx * inv_d_mag;
    let dyn_ = dy * inv_d_mag;
    let dzn = dz * inv_d_mag;
    let mut cos_a = vxn * dxn + vyn * dyn_ + vzn * dzn;
    if cos_a > 1.0 {
        cos_a = 1.0;
    } else if cos_a < -1.0 {
        cos_a = -1.0;
    }

    let theta = cos_a.acos();
    if !theta.is_finite() || theta <= 1e-9 {
        return (vel_x, vel_y, vel_z);
    }
    let max_turn = homing_turn_rate * dt_sec;
    if !max_turn.is_finite() || max_turn <= 0.0 {
        return (vel_x, vel_y, vel_z);
    }
    if theta <= max_turn {
        return (dxn * speed, dyn_ * speed, dzn * speed);
    }

    let t = max_turn / theta;
    let sin_theta = theta.sin();
    let (mut out_x, mut out_y, mut out_z) = if sin_theta.abs() > 1e-6 {
        let a = ((1.0 - t) * theta).sin() / sin_theta;
        let b = (t * theta).sin() / sin_theta;
        (vxn * a + dxn * b, vyn * a + dyn_ * b, vzn * a + dzn * b)
    } else if cos_a < 0.0 {
        // Anti-parallel target direction: choose the same stable
        // horizontal perpendicular as the thrust solver so the missile
        // starts turning deterministically.
        let xy_mag = (vxn * vxn + vyn * vyn).sqrt();
        let (perp_x, perp_y, perp_z) = if xy_mag > 0.05 {
            (-vyn / xy_mag, vxn / xy_mag, 0.0)
        } else {
            (1.0, 0.0, 0.0)
        };
        let c = max_turn.cos();
        let s = max_turn.sin();
        (
            vxn * c + perp_x * s,
            vyn * c + perp_y * s,
            vzn * c + perp_z * s,
        )
    } else {
        return (vel_x, vel_y, vel_z);
    };

    let out_mag = (out_x * out_x + out_y * out_y + out_z * out_z).sqrt();
    if !out_mag.is_finite() || out_mag <= 1e-9 {
        return (vel_x, vel_y, vel_z);
    }
    let scale = speed / out_mag;
    out_x *= scale;
    out_y *= scale;
    out_z *= scale;
    (out_x, out_y, out_z)
}

#[wasm_bindgen]
pub fn compute_constant_speed_homing_velocity(
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
    dt_sec: f64,
) {
    debug_assert!(out_buf.len() >= 3);
    let (out_x, out_y, out_z) = compute_constant_speed_homing_velocity_inline(
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
        dt_sec,
    );
    out_buf[0] = out_x;
    out_buf[1] = out_y;
    out_buf[2] = out_z;
}

/// Exact constant-speed interception for a target with constant velocity.
/// This is the hot path for missiles and rockets; the sampled damped solver
/// remains available for thrust-guided projectiles with acceleration/damping.
#[inline]
fn solve_constant_speed_intercept_inline(
    origin_x: f64,
    origin_y: f64,
    origin_z: f64,
    target_x: f64,
    target_y: f64,
    target_z: f64,
    target_vel_x: f64,
    target_vel_y: f64,
    target_vel_z: f64,
    projectile_speed: f64,
    max_time_sec: f64,
) -> Option<(f64, f64, f64, f64)> {
    if !projectile_speed.is_finite() || projectile_speed <= 1e-6 {
        return None;
    }
    let rx = target_x - origin_x;
    let ry = target_y - origin_y;
    let rz = target_z - origin_z;
    let c = rx * rx + ry * ry + rz * rz;
    if !c.is_finite() {
        return None;
    }
    if c <= 1e-12 {
        return Some((0.0, target_x, target_y, target_z));
    }

    let speed_sq = projectile_speed * projectile_speed;
    let a = target_vel_x * target_vel_x + target_vel_y * target_vel_y + target_vel_z * target_vel_z
        - speed_sq;
    let b = 2.0 * (rx * target_vel_x + ry * target_vel_y + rz * target_vel_z);
    let mut intercept_time = f64::INFINITY;
    if a.abs() <= 1e-12 {
        if b.abs() > 1e-12 {
            let candidate = -c / b;
            if candidate >= 0.0 {
                intercept_time = candidate;
            }
        }
    } else {
        let discriminant = b * b - 4.0 * a * c;
        if discriminant >= 0.0 && discriminant.is_finite() {
            let sqrt_discriminant = discriminant.sqrt();
            let denominator = 2.0 * a;
            let first = (-b - sqrt_discriminant) / denominator;
            let second = (-b + sqrt_discriminant) / denominator;
            if first >= 0.0 {
                intercept_time = first;
            }
            if second >= 0.0 && second < intercept_time {
                intercept_time = second;
            }
        }
    }
    if !intercept_time.is_finite()
        || (max_time_sec.is_finite() && max_time_sec > 0.0 && intercept_time > max_time_sec)
    {
        return None;
    }
    Some((
        intercept_time,
        target_x + target_vel_x * intercept_time,
        target_y + target_vel_y * intercept_time,
        target_z + target_vel_z * intercept_time,
    ))
}

pub const PROJECTILE_HOMING_GUIDANCE_STRIDE: usize = 41;

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
pub(crate) const PHG_ROW_MEDIUM_VEL_X: usize = 12;
pub(crate) const PHG_ROW_MEDIUM_VEL_Y: usize = 13;
pub(crate) const PHG_ROW_MEDIUM_VEL_Z: usize = 14;
pub(crate) const PHG_ROW_ORIGIN_VEL_X: usize = 15;
pub(crate) const PHG_ROW_ORIGIN_VEL_Y: usize = 16;
pub(crate) const PHG_ROW_ORIGIN_VEL_Z: usize = 17;
pub(crate) const PHG_ROW_PROJECTILE_SPEED: usize = 21;
pub(crate) const PHG_ROW_PROJECTILE_GRAVITY: usize = 22;
pub(crate) const PHG_ROW_MAX_TIME_SEC: usize = 23;
pub(crate) const PHG_ROW_HOMING_TURN_RATE: usize = 24;
pub(crate) const PHG_ROW_MAX_THRUST_ACCEL: usize = 25;
pub(crate) const PHG_ROW_SOLVE_INTERCEPT: usize = 26;
pub(crate) const PHG_ROW_PROJECTILE_LINEAR_DAMPING_RATE: usize = 27;
pub(crate) const PHG_ROW_CONSTANT_SPEED_MODE: usize = 29;
pub(crate) const PHG_ROW_OUT_THRUST_X: usize = 30;
pub(crate) const PHG_ROW_OUT_THRUST_Y: usize = 31;
pub(crate) const PHG_ROW_OUT_THRUST_Z: usize = 32;
pub(crate) const PHG_ROW_OUT_INTERCEPT_FOUND: usize = 33;
pub(crate) const PHG_ROW_OUT_VEL_X: usize = 34;
pub(crate) const PHG_ROW_OUT_VEL_Y: usize = 35;
pub(crate) const PHG_ROW_OUT_VEL_Z: usize = 36;
pub(crate) const PHG_ROW_OUT_STEER_X: usize = 37;
pub(crate) const PHG_ROW_OUT_STEER_Y: usize = 38;
pub(crate) const PHG_ROW_OUT_STEER_Z: usize = 39;
pub(crate) const PHG_ROW_OUT_ALIGNED: usize = 40;

#[wasm_bindgen]
pub fn projectile_homing_guidance_batch(
    rows: &mut [f64],
    count: usize,
    dt_sec: f64,
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
        rows[base + PHG_ROW_OUT_VEL_X] = rows[base + PHG_ROW_VEL_X];
        rows[base + PHG_ROW_OUT_VEL_Y] = rows[base + PHG_ROW_VEL_Y];
        rows[base + PHG_ROW_OUT_VEL_Z] = rows[base + PHG_ROW_VEL_Z];
        rows[base + PHG_ROW_OUT_ALIGNED] = 0.0;

        let mut steer_x = rows[base + PHG_ROW_STEER_X];
        let mut steer_y = rows[base + PHG_ROW_STEER_Y];
        let mut steer_z = rows[base + PHG_ROW_STEER_Z];
        let gravity = rows[base + PHG_ROW_PROJECTILE_GRAVITY];
        let constant_speed_mode = rows[base + PHG_ROW_CONSTANT_SPEED_MODE] != 0.0;

        if rows[base + PHG_ROW_SOLVE_INTERCEPT] != 0.0 {
            // A constant-speed missile is not a moving launch platform plus
            // another projectile-speed vector. Its current world-speed
            // magnitude IS the complete travel budget from its current
            // position. Feeding current velocity as origin velocity here
            // double-counted that motion and produced a false lead point.
            // Refresh the ordinary velocity intercept only when the row's
            // deterministic scheduler requests it. Guidance deliberately
            // predicts velocity, never target acceleration.
            let origin_vel_x = if constant_speed_mode {
                0.0
            } else {
                rows[base + PHG_ROW_ORIGIN_VEL_X]
            };
            let origin_vel_y = if constant_speed_mode {
                0.0
            } else {
                rows[base + PHG_ROW_ORIGIN_VEL_Y]
            };
            let origin_vel_z = if constant_speed_mode {
                0.0
            } else {
                rows[base + PHG_ROW_ORIGIN_VEL_Z]
            };
            if constant_speed_mode {
                if let Some((_, intercept_x, intercept_y, intercept_z)) =
                    solve_constant_speed_intercept_inline(
                        rows[base + PHG_ROW_CURRENT_X],
                        rows[base + PHG_ROW_CURRENT_Y],
                        rows[base + PHG_ROW_CURRENT_Z],
                        steer_x,
                        steer_y,
                        steer_z,
                        rows[base + PHG_ROW_TARGET_VEL_X],
                        rows[base + PHG_ROW_TARGET_VEL_Y],
                        rows[base + PHG_ROW_TARGET_VEL_Z],
                        rows[base + PHG_ROW_PROJECTILE_SPEED],
                        rows[base + PHG_ROW_MAX_TIME_SEC],
                    )
                {
                    steer_x = intercept_x;
                    steer_y = intercept_y;
                    steer_z = intercept_z;
                    rows[base + PHG_ROW_OUT_INTERCEPT_FOUND] = 1.0;
                }
            } else {
                let input = [
                    rows[base + PHG_ROW_CURRENT_X],
                    rows[base + PHG_ROW_CURRENT_Y],
                    rows[base + PHG_ROW_CURRENT_Z],
                    origin_vel_x,
                    origin_vel_y,
                    origin_vel_z,
                    0.0,
                    0.0,
                    0.0,
                    steer_x,
                    steer_y,
                    steer_z,
                    rows[base + PHG_ROW_TARGET_VEL_X],
                    rows[base + PHG_ROW_TARGET_VEL_Y],
                    rows[base + PHG_ROW_TARGET_VEL_Z],
                    0.0,
                    0.0,
                    0.0,
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
                    rows[base + PHG_ROW_PROJECTILE_LINEAR_DAMPING_RATE],
                    rows[base + PHG_ROW_MEDIUM_VEL_X],
                    rows[base + PHG_ROW_MEDIUM_VEL_Y],
                    rows[base + PHG_ROW_MEDIUM_VEL_Z],
                ) {
                    steer_x = intercept_out[1];
                    steer_y = intercept_out[2];
                    steer_z = intercept_out[3];
                    rows[base + PHG_ROW_OUT_INTERCEPT_FOUND] = 1.0;
                }
            }
        }

        rows[base + PHG_ROW_OUT_STEER_X] = steer_x;
        rows[base + PHG_ROW_OUT_STEER_Y] = steer_y;
        rows[base + PHG_ROW_OUT_STEER_Z] = steer_z;

        if constant_speed_mode {
            let (vel_x, vel_y, vel_z) = compute_constant_speed_homing_velocity_inline(
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
                dt_sec,
            );
            rows[base + PHG_ROW_OUT_VEL_X] = vel_x;
            rows[base + PHG_ROW_OUT_VEL_Y] = vel_y;
            rows[base + PHG_ROW_OUT_VEL_Z] = vel_z;
            let dx = steer_x - rows[base + PHG_ROW_CURRENT_X];
            let dy = steer_y - rows[base + PHG_ROW_CURRENT_Y];
            let dz = steer_z - rows[base + PHG_ROW_CURRENT_Z];
            let distance = (dx * dx + dy * dy + dz * dz).sqrt();
            let speed = (vel_x * vel_x + vel_y * vel_y + vel_z * vel_z).sqrt();
            if distance.is_finite() && distance > 1e-6 && speed.is_finite() && speed > 1e-6 {
                let cosine = (vel_x * dx + vel_y * dy + vel_z * dz) / (speed * distance);
                if cosine >= 1.0 - 1e-12 {
                    rows[base + PHG_ROW_OUT_ALIGNED] = 1.0;
                }
            }
        } else {
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
        }
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
    vel_x: &mut [f64],
    vel_y: &mut [f64],
    vel_z: &mut [f64],
    count: usize,
    dt_sec: f64,
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
        if i >= accel_x.len()
            || i >= accel_y.len()
            || i >= accel_z.len()
            || i >= vel_x.len()
            || i >= vel_y.len()
            || i >= vel_z.len()
        {
            return 0;
        }
    }

    let processed = projectile_homing_guidance_batch(rows, count, dt_sec);
    if processed as usize != count {
        return processed;
    }

    for (row_index, &projectile_index) in projectile_indices.iter().take(count).enumerate() {
        let projectile_index = projectile_index as usize;
        let base = row_index * PROJECTILE_HOMING_GUIDANCE_STRIDE;
        if rows[base + PHG_ROW_CONSTANT_SPEED_MODE] != 0.0 {
            vel_x[projectile_index] = rows[base + PHG_ROW_OUT_VEL_X];
            vel_y[projectile_index] = rows[base + PHG_ROW_OUT_VEL_Y];
            vel_z[projectile_index] = rows[base + PHG_ROW_OUT_VEL_Z];
        } else {
            accel_x[projectile_index] += rows[base + PHG_ROW_OUT_THRUST_X];
            accel_y[projectile_index] += rows[base + PHG_ROW_OUT_THRUST_Y];
            accel_z[projectile_index] += rows[base + PHG_ROW_OUT_THRUST_Z];
        }
    }

    processed
}

const LINE_SHOT_RANGE_EPSILON: f64 = 1e-9;
const LINE_SHOT_RANGE_VOLUME_CYLINDER_NORMAL: u32 = 0;
const LINE_SHOT_RANGE_VOLUME_BOTTOM_UNBOUNDED: u32 = 1;
const LINE_SHOT_RANGE_VOLUME_TOP_AND_BOTTOM_UNBOUNDED: u32 = 2;
const LINE_SHOT_RANGE_VOLUME_SPHERE: u32 = 3;
const LINE_SHOT_RANGE_VOLUME_TOP_WATER_AND_BOTTOM_UNBOUNDED: u32 = 4;

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
        | LINE_SHOT_RANGE_VOLUME_TOP_AND_BOTTOM_UNBOUNDED
        | LINE_SHOT_RANGE_VOLUME_TOP_WATER_AND_BOTTOM_UNBOUNDED => false,
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
        let top_z = if range_volume == LINE_SHOT_RANGE_VOLUME_TOP_WATER_AND_BOTTOM_UNBOUNDED {
            TERRAIN_WATER_LEVEL
        } else {
            center_z + radius
        };
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
/// and optional medium-relative linear damping.
///
/// When the damping rate is zero, this reduces to exact
/// constant-acceleration integration. Otherwise the kernel integrates the
/// continuous force model
/// matching the ballistic solver:
///   a_damping = rate * (medium_velocity - projectile_velocity)
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
    linear_damping_rate: &[f64],
    medium_velocity_x: &[f64],
    medium_velocity_y: &[f64],
    medium_velocity_z: &[f64],
    guidance_arrival_enabled: &[u8],
    guidance_arrival_x: &[f64],
    guidance_arrival_y: &[f64],
    guidance_arrival_z: &[f64],
    guidance_arrival_radius: &[f64],
    guidance_arrival_reached: &mut [u8],
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
        || linear_damping_rate.len() < n
        || medium_velocity_x.len() < n
        || medium_velocity_y.len() < n
        || medium_velocity_z.len() < n
        || guidance_arrival_enabled.len() < n
        || guidance_arrival_x.len() < n
        || guidance_arrival_y.len() < n
        || guidance_arrival_z.len() < n
        || guidance_arrival_radius.len() < n
        || guidance_arrival_reached.len() < n
        || !dt_sec.is_finite()
    {
        return 0;
    }

    for i in 0..n {
        if !linear_damping_rate[i].is_finite()
            || linear_damping_rate[i] < 0.0
            || !medium_velocity_x[i].is_finite()
            || !medium_velocity_y[i].is_finite()
            || !medium_velocity_z[i].is_finite()
        {
            return 0;
        }
    }

    for i in 0..n {
        let start_x = pos_x[i];
        let start_y = pos_y[i];
        let start_z = pos_z[i];
        guidance_arrival_reached[i] = 0;
        let damping_rate = linear_damping_rate[i];
        integrate_linear_damped_axis(
            &mut pos_x[i],
            &mut vel_x[i],
            accel_x[i],
            dt_sec,
            damping_rate,
            medium_velocity_x[i],
        );
        integrate_linear_damped_axis(
            &mut pos_y[i],
            &mut vel_y[i],
            accel_y[i],
            dt_sec,
            damping_rate,
            medium_velocity_y[i],
        );
        integrate_linear_damped_axis(
            &mut pos_z[i],
            &mut vel_z[i],
            accel_z[i],
            dt_sec,
            damping_rate,
            medium_velocity_z[i],
        );

        // Lost-target rockets terminate on a swept sphere around their cached
        // speculative intercept. Sweeping prevents a fast projectile from
        // stepping across the point between simulation ticks.
        if guidance_arrival_enabled[i] != 0 {
            let radius = guidance_arrival_radius[i];
            let center_x = guidance_arrival_x[i];
            let center_y = guidance_arrival_y[i];
            let center_z = guidance_arrival_z[i];
            if radius.is_finite()
                && radius > 0.0
                && center_x.is_finite()
                && center_y.is_finite()
                && center_z.is_finite()
            {
                let mx = start_x - center_x;
                let my = start_y - center_y;
                let mz = start_z - center_z;
                let radius_sq = radius * radius;
                let start_distance_sq = mx * mx + my * my + mz * mz;
                let mut hit_t = if start_distance_sq <= radius_sq {
                    Some(0.0)
                } else {
                    None
                };
                if hit_t.is_none() {
                    let dx = pos_x[i] - start_x;
                    let dy = pos_y[i] - start_y;
                    let dz = pos_z[i] - start_z;
                    let a = dx * dx + dy * dy + dz * dz;
                    if a > 1e-12 && a.is_finite() {
                        let b = mx * dx + my * dy + mz * dz;
                        let c = start_distance_sq - radius_sq;
                        let discriminant = b * b - a * c;
                        if discriminant >= 0.0 && discriminant.is_finite() {
                            let candidate = (-b - discriminant.sqrt()) / a;
                            if (0.0..=1.0).contains(&candidate) {
                                hit_t = Some(candidate);
                            }
                        }
                    }
                }
                if let Some(t) = hit_t {
                    pos_x[i] = start_x + (pos_x[i] - start_x) * t;
                    pos_y[i] = start_y + (pos_y[i] - start_y) * t;
                    pos_z[i] = start_z + (pos_z[i] - start_z) * t;
                    guidance_arrival_reached[i] = 1;
                }
            }
        }
    }
    count
}

#[inline]
pub(crate) fn integrate_linear_damped_axis(
    pos: &mut f64,
    vel: &mut f64,
    accel: f64,
    dt_sec: f64,
    linear_damping_rate: f64,
    medium_velocity: f64,
) {
    integrate_linear_damping_axis(
        pos,
        vel,
        accel,
        dt_sec,
        linear_damping_rate,
        medium_velocity,
    );
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
    fn projectile_zero_damping_ignores_medium_velocity() {
        let mut pos_x = vec![1.0];
        let mut pos_y = vec![-2.0];
        let mut pos_z = vec![3.0];
        let mut vel_x = vec![10.0];
        let mut vel_y = vec![-6.0];
        let mut vel_z = vec![4.0];
        let accel_x = vec![3.0];
        let accel_y = vec![5.0];
        let accel_z = vec![-9.0];
        let linear_damping_rate = vec![0.0];
        let medium_velocity_x = vec![1000.0];
        let medium_velocity_y = vec![-500.0];
        let medium_velocity_z = vec![250.0];
        let arrival_enabled = vec![0];
        let arrival_point = vec![0.0];
        let arrival_radius = vec![0.0];
        let mut arrival_reached = vec![0];
        let dt = 0.25;

        let processed = projectile_integrate_step_batch(
            1, &mut pos_x, &mut pos_y, &mut pos_z, &mut vel_x, &mut vel_y, &mut vel_z, &accel_x,
            &accel_y, &accel_z, &linear_damping_rate, &medium_velocity_x,
            &medium_velocity_y, &medium_velocity_z, &arrival_enabled, &arrival_point,
            &arrival_point, &arrival_point, &arrival_radius, &mut arrival_reached, dt,
        );

        assert_eq!(processed, 1);
        assert_close(pos_x[0], 1.0 + 10.0 * dt + 0.5 * 3.0 * dt * dt);
        assert_close(pos_y[0], -2.0 - 6.0 * dt + 0.5 * 5.0 * dt * dt);
        assert_close(pos_z[0], 3.0 + 4.0 * dt + 0.5 * -9.0 * dt * dt);
        assert_close(vel_x[0], 10.0 + 3.0 * dt);
        assert_close(vel_y[0], -6.0 + 5.0 * dt);
        assert_close(vel_z[0], 4.0 - 9.0 * dt);
    }

    #[test]
    fn projectile_linear_damping_pushes_velocity_toward_medium_velocity() {
        let mut pos_x = vec![0.0];
        let mut pos_y = vec![0.0];
        let mut pos_z = vec![0.0];
        let mut vel_x = vec![0.0];
        let mut vel_y = vec![0.0];
        let mut vel_z = vec![0.0];
        let zero = vec![0.0];
        let damping = vec![0.5];
        let medium_x = vec![30.0];
        let medium_y = vec![-20.0];
        let medium_z = vec![10.0];
        let arrival_enabled = vec![0];
        let arrival_radius = vec![0.0];
        let mut arrival_reached = vec![0];

        let processed = projectile_integrate_step_batch(
            1,
            &mut pos_x,
            &mut pos_y,
            &mut pos_z,
            &mut vel_x,
            &mut vel_y,
            &mut vel_z,
            &zero,
            &zero,
            &zero,
            &damping,
            &medium_x,
            &medium_y,
            &medium_z,
            &arrival_enabled,
            &zero,
            &zero,
            &zero,
            &arrival_radius,
            &mut arrival_reached,
            1.0,
        );

        assert_eq!(processed, 1);
        let response = 1.0 - (-0.5_f64).exp();
        assert_close(vel_x[0], medium_x[0] * response);
        assert_close(vel_y[0], medium_y[0] * response);
        assert_close(vel_z[0], medium_z[0] * response);
    }

    #[derive(Clone, Copy)]
    struct BallisticContractCase {
        origin: (f64, f64, f64),
        origin_velocity: (f64, f64, f64),
        target: (f64, f64, f64),
        target_velocity: (f64, f64, f64),
        projectile_speed: f64,
        gravity: f64,
        linear_damping_rate: f64,
        medium_velocity: (f64, f64, f64),
        prefer_late: u8,
    }

    fn solve_and_integrate_ballistic_case(case: BallisticContractCase) -> f64 {
        let input = [
            case.origin.0,
            case.origin.1,
            case.origin.2,
            case.origin_velocity.0,
            case.origin_velocity.1,
            case.origin_velocity.2,
            0.0,
            0.0,
            0.0,
            case.target.0,
            case.target.1,
            case.target.2,
            case.target_velocity.0,
            case.target_velocity.1,
            case.target_velocity.2,
            // Gameplay deliberately does not predict target acceleration.
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
            -case.gravity,
            case.projectile_speed,
        ];
        let mut solution = [0.0_f64; 7];
        assert!(solve_damped_kinematic_intercept_inline(
            &input,
            &mut solution,
            case.prefer_late,
            0.0,
            case.linear_damping_rate,
            case.medium_velocity.0,
            case.medium_velocity.1,
            case.medium_velocity.2,
        ));

        let relative_launch_speed =
            (solution[4] * solution[4] + solution[5] * solution[5] + solution[6] * solution[6])
                .sqrt();
        assert!(
            (relative_launch_speed - case.projectile_speed).abs() <= 0.01,
            "solver returned launch speed {relative_launch_speed}, expected {}",
            case.projectile_speed,
        );

        let mut pos_x = vec![case.origin.0];
        let mut pos_y = vec![case.origin.1];
        let mut pos_z = vec![case.origin.2];
        // The targeting system consumes yaw/pitch and the fire path authors
        // the exact muzzle-speed magnitude, so reproduce that handoff rather
        // than integrating the root finder's tiny speed residual.
        let launch_scale = case.projectile_speed / relative_launch_speed;
        let mut vel_x = vec![case.origin_velocity.0 + solution[4] * launch_scale];
        let mut vel_y = vec![case.origin_velocity.1 + solution[5] * launch_scale];
        let mut vel_z = vec![case.origin_velocity.2 + solution[6] * launch_scale];
        let accel_x = vec![0.0];
        let accel_y = vec![0.0];
        let accel_z = vec![-case.gravity];
        let damping = vec![case.linear_damping_rate];
        let medium_x = vec![case.medium_velocity.0];
        let medium_y = vec![case.medium_velocity.1];
        let medium_z = vec![case.medium_velocity.2];
        let arrival_enabled = vec![0];
        let arrival_point = vec![0.0];
        let arrival_radius = vec![0.0];
        let mut arrival_reached = vec![0];

        let mut remaining = solution[0];
        while remaining > 1e-12 {
            let dt = remaining.min(1.0 / 30.0);
            assert_eq!(
                projectile_integrate_step_batch(
                    1,
                    &mut pos_x,
                    &mut pos_y,
                    &mut pos_z,
                    &mut vel_x,
                    &mut vel_y,
                    &mut vel_z,
                    &accel_x,
                    &accel_y,
                    &accel_z,
                    &damping,
                    &medium_x,
                    &medium_y,
                    &medium_z,
                    &arrival_enabled,
                    &arrival_point,
                    &arrival_point,
                    &arrival_point,
                    &arrival_radius,
                    &mut arrival_reached,
                    dt,
                ),
                1,
            );
            remaining -= dt;
        }

        let target_x = case.target.0 + case.target_velocity.0 * solution[0];
        let target_y = case.target.1 + case.target_velocity.1 * solution[0];
        let target_z = case.target.2 + case.target_velocity.2 * solution[0];
        let dx = pos_x[0] - target_x;
        let dy = pos_y[0] - target_y;
        let dz = pos_z[0] - target_z;
        (dx * dx + dy * dy + dz * dz).sqrt()
    }

    #[test]
    fn ballistic_solver_hits_through_production_integrator_in_multiple_3d_winds() {
        let cases = [
            BallisticContractCase {
                origin: (20.0, -40.0, 100.0),
                origin_velocity: (12.0, -7.0, 3.0),
                target: (760.0, 220.0, 75.0),
                target_velocity: (-9.0, 14.0, 0.0),
                projectile_speed: 700.0,
                gravity: 400.0,
                linear_damping_rate: 0.180270541218,
                medium_velocity: (35.0, -18.0, 4.0),
                prefer_late: 0,
            },
            BallisticContractCase {
                origin: (-100.0, 50.0, 140.0),
                origin_velocity: (-15.0, 8.0, -2.0),
                target: (620.0, -430.0, 100.0),
                target_velocity: (20.0, 12.0, 5.0),
                projectile_speed: 780.0,
                gravity: 400.0,
                linear_damping_rate: 0.240481283852,
                medium_velocity: (-42.0, 27.0, -9.0),
                prefer_late: 0,
            },
            BallisticContractCase {
                origin: (0.0, 0.0, 100.0),
                origin_velocity: (6.0, -11.0, 1.0),
                target: (450.0, 180.0, 70.0),
                target_velocity: (-8.0, 6.0, -3.0),
                projectile_speed: 700.0,
                gravity: 400.0,
                linear_damping_rate: 0.12012016024,
                medium_velocity: (13.0, 44.0, 11.0),
                prefer_late: 1,
            },
        ];

        for case in cases {
            let miss = solve_and_integrate_ballistic_case(case);
            assert!(miss <= 0.01, "solver/integrator miss was {miss}");
        }
    }

    #[test]
    fn ballistic_contract_detects_omitted_damping() {
        let case = BallisticContractCase {
            origin: (0.0, 0.0, 100.0),
            origin_velocity: (0.0, 0.0, 0.0),
            target: (900.0, 0.0, 80.0),
            target_velocity: (0.0, 0.0, 0.0),
            projectile_speed: 750.0,
            gravity: 400.0,
            linear_damping_rate: 0.0,
            medium_velocity: (0.0, 0.0, 0.0),
            prefer_late: 0,
        };
        let input = [
            case.origin.0,
            case.origin.1,
            case.origin.2,
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
            case.target.0,
            case.target.1,
            case.target.2,
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
            -case.gravity,
            case.projectile_speed,
        ];
        let mut undamped_solution = [0.0_f64; 7];
        assert!(solve_damped_kinematic_intercept_inline(
            &input,
            &mut undamped_solution,
            0,
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
        ));

        let mismatched_case = BallisticContractCase {
            linear_damping_rate: 0.240481283852,
            medium_velocity: (35.0, -18.0, 4.0),
            ..case
        };
        let mut pos = case.origin;
        let mut vel = (
            undamped_solution[4],
            undamped_solution[5],
            undamped_solution[6],
        );
        let mut remaining = undamped_solution[0];
        while remaining > 1e-12 {
            let dt = remaining.min(1.0 / 30.0);
            integrate_linear_damped_axis(
                &mut pos.0,
                &mut vel.0,
                0.0,
                dt,
                mismatched_case.linear_damping_rate,
                mismatched_case.medium_velocity.0,
            );
            integrate_linear_damped_axis(
                &mut pos.1,
                &mut vel.1,
                0.0,
                dt,
                mismatched_case.linear_damping_rate,
                mismatched_case.medium_velocity.1,
            );
            integrate_linear_damped_axis(
                &mut pos.2,
                &mut vel.2,
                -case.gravity,
                dt,
                mismatched_case.linear_damping_rate,
                mismatched_case.medium_velocity.2,
            );
            remaining -= dt;
        }
        let dx = pos.0 - case.target.0;
        let dy = pos.1 - case.target.1;
        let dz = pos.2 - case.target.2;
        let miss = (dx * dx + dy * dy + dz * dz).sqrt();
        assert!(miss > 20.0, "negative control was too weak: miss={miss}");
    }

    #[test]
    fn projectile_guidance_arrival_sweep_clamps_at_entry() {
        let mut pos_x = vec![0.0];
        let mut pos_y = vec![0.0];
        let mut pos_z = vec![0.0];
        let mut vel_x = vec![100.0];
        let mut vel_y = vec![0.0];
        let mut vel_z = vec![0.0];
        let acceleration = vec![0.0];
        let linear_damping_rate = vec![0.0];
        let medium_velocity = vec![0.0];
        let arrival_enabled = vec![1];
        let arrival_x = vec![5.0];
        let arrival_y = vec![0.0];
        let arrival_z = vec![0.0];
        let arrival_radius = vec![1.0];
        let mut arrival_reached = vec![0];

        let processed = projectile_integrate_step_batch(
            1, &mut pos_x, &mut pos_y, &mut pos_z, &mut vel_x, &mut vel_y, &mut vel_z,
            &acceleration, &acceleration, &acceleration, &linear_damping_rate,
            &medium_velocity, &medium_velocity, &medium_velocity, &arrival_enabled, &arrival_x,
            &arrival_y, &arrival_z, &arrival_radius, &mut arrival_reached, 0.1,
        );

        assert_eq!(processed, 1);
        assert_eq!(arrival_reached[0], 1);
        assert_close(pos_x[0], 4.0);
        assert_close(pos_y[0], 0.0);
        assert_close(pos_z[0], 0.0);
    }

    #[test]
    fn constant_speed_homing_rotates_without_changing_speed() {
        let (vx, vy, vz) = compute_constant_speed_homing_velocity_inline(
            100.0, 0.0, 0.0, 0.0, 1000.0, 0.0, 0.0, 0.0, 0.0, 0.5, 0.25,
        );

        let speed = (vx * vx + vy * vy + vz * vz).sqrt();
        assert_close(speed, 100.0);
        assert!(
            vx < 100.0,
            "missile x velocity should turn away from original heading"
        );
        assert!(vy > 0.0, "missile y velocity should turn toward target");
        assert_close(vz, 0.0);
    }

    #[test]
    fn constant_speed_guidance_leads_without_double_counting_current_velocity() {
        let mut rows = vec![0.0_f64; PROJECTILE_HOMING_GUIDANCE_STRIDE];
        rows[PHG_ROW_VEL_X] = 100.0;
        rows[PHG_ROW_STEER_X] = 1000.0;
        rows[PHG_ROW_CURRENT_X] = 0.0;
        rows[PHG_ROW_CURRENT_Y] = 0.0;
        rows[PHG_ROW_CURRENT_Z] = 0.0;
        rows[PHG_ROW_TARGET_VEL_Y] = 50.0;
        // These fields must not become a second copy of missile motion or an
        // acceleration extrapolation in constant-speed mode.
        rows[PHG_ROW_ORIGIN_VEL_X] = 100.0;
        rows[PHG_ROW_MEDIUM_VEL_X] = 200.0;
        rows[PHG_ROW_MEDIUM_VEL_Y] = -100.0;
        rows[PHG_ROW_MEDIUM_VEL_Z] = 50.0;
        rows[PHG_ROW_PROJECTILE_SPEED] = 100.0;
        rows[PHG_ROW_PROJECTILE_GRAVITY] = 9.81;
        rows[PHG_ROW_MAX_TIME_SEC] = 30.0;
        rows[PHG_ROW_HOMING_TURN_RATE] = 100.0;
        rows[PHG_ROW_SOLVE_INTERCEPT] = 1.0;
        rows[PHG_ROW_PROJECTILE_LINEAR_DAMPING_RATE] = 0.2;
        rows[PHG_ROW_CONSTANT_SPEED_MODE] = 1.0;

        let processed = projectile_homing_guidance_batch(&mut rows, 1, 1.0 / 30.0);

        assert_eq!(processed, 1);
        assert_eq!(rows[PHG_ROW_OUT_INTERCEPT_FOUND], 1.0);
        assert!((rows[PHG_ROW_OUT_STEER_X] - 1000.0).abs() < 1e-6);
        assert!((rows[PHG_ROW_OUT_STEER_Y] - 577.3502691896258).abs() < 1e-3);
        // |(1000, 50t)| = 100t gives direction (sqrt(3)/2, 1/2).
        assert!((rows[PHG_ROW_OUT_VEL_X] - 86.60254037844386).abs() < 1e-3);
        assert!((rows[PHG_ROW_OUT_VEL_Y] - 50.0).abs() < 1e-3);
        assert_close(rows[PHG_ROW_OUT_VEL_Z], 0.0);
        assert_close(
            (rows[PHG_ROW_OUT_VEL_X] * rows[PHG_ROW_OUT_VEL_X]
                + rows[PHG_ROW_OUT_VEL_Y] * rows[PHG_ROW_OUT_VEL_Y]
                + rows[PHG_ROW_OUT_VEL_Z] * rows[PHG_ROW_OUT_VEL_Z])
                .sqrt(),
            100.0,
        );
    }

    #[test]
    fn constant_speed_guidance_reports_when_bounded_turn_finishes_alignment() {
        let mut rows = vec![0.0_f64; PROJECTILE_HOMING_GUIDANCE_STRIDE * 2];
        rows[PHG_ROW_VEL_X] = 100.0;
        rows[PHG_ROW_STEER_X] = 1000.0;
        rows[PHG_ROW_STEER_Y] = 1.0;
        rows[PHG_ROW_PROJECTILE_SPEED] = 100.0;
        rows[PHG_ROW_HOMING_TURN_RATE] = 1.0;
        rows[PHG_ROW_CONSTANT_SPEED_MODE] = 1.0;

        let second = PROJECTILE_HOMING_GUIDANCE_STRIDE;
        rows[second + PHG_ROW_VEL_X] = 100.0;
        rows[second + PHG_ROW_STEER_Y] = 1000.0;
        rows[second + PHG_ROW_PROJECTILE_SPEED] = 100.0;
        rows[second + PHG_ROW_HOMING_TURN_RATE] = 1.0;
        rows[second + PHG_ROW_CONSTANT_SPEED_MODE] = 1.0;

        let processed = projectile_homing_guidance_batch(&mut rows, 2, 0.05);

        assert_eq!(processed, 2);
        assert_eq!(rows[PHG_ROW_OUT_ALIGNED], 1.0);
        assert_eq!(rows[second + PHG_ROW_OUT_ALIGNED], 0.0);
    }

    #[test]
    fn damped_intercept_zero_linear_damping_rate_ignores_wind() {
        let input = [
            0.0, 0.0, 0.0, // origin position
            0.0, 0.0, 0.0, // origin velocity
            0.0, 0.0, 0.0, // reserved origin-acceleration slots
            100.0, 20.0, 5.0, // target position
            0.0, 0.0, 0.0, // target velocity
            0.0, 0.0, 0.0, // reserved target-acceleration slots
            0.0, 0.0, 0.0,  // projectile acceleration
            50.0, // projectile speed
        ];
        let mut still_air = [0.0_f64; 7];
        let mut high_wind = [0.0_f64; 7];

        let still_found = solve_damped_kinematic_intercept_inline(
            &input,
            &mut still_air,
            0,
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
        );
        let wind_found = solve_damped_kinematic_intercept_inline(
            &input,
            &mut high_wind,
            0,
            0.0,
            0.0,
            1000.0,
            -500.0,
            250.0,
        );

        assert!(still_found);
        assert!(wind_found);
        for i in 0..still_air.len() {
            assert_close(high_wind[i], still_air[i]);
        }
    }

    #[test]
    fn intercept_solvers_ignore_reserved_entity_acceleration_slots() {
        let base_input = [
            10.0, -5.0, 20.0, // origin position
            4.0, 2.0, -1.0, // origin velocity
            0.0, 0.0, 0.0, // reserved origin-acceleration slots
            180.0, 45.0, 30.0, // target position
            -3.0, 6.0, 1.0, // target velocity
            0.0, 0.0, 0.0, // reserved target-acceleration slots
            0.0, 0.0, -9.81, // projectile acceleration
            90.0, // projectile speed
        ];
        let mut noisy_input = base_input;
        noisy_input[6] = -600.0;
        noisy_input[7] = 325.0;
        noisy_input[8] = -150.0;
        noisy_input[15] = 800.0;
        noisy_input[16] = -450.0;
        noisy_input[17] = 275.0;

        let mut base_ballistic = [0.0_f64; 7];
        let mut noisy_ballistic = [0.0_f64; 7];
        assert!(solve_kinematic_intercept_inline(
            &base_input,
            &mut base_ballistic,
            0,
            0.0,
        ));
        assert!(solve_kinematic_intercept_inline(
            &noisy_input,
            &mut noisy_ballistic,
            0,
            0.0,
        ));
        assert_eq!(base_ballistic, noisy_ballistic);

        let mut base_damped = [0.0_f64; 7];
        let mut noisy_damped = [0.0_f64; 7];
        assert!(solve_damped_kinematic_intercept_inline(
            &base_input,
            &mut base_damped,
            0,
            0.0,
            0.24,
            25.0,
            -12.0,
            7.0,
        ));
        assert!(solve_damped_kinematic_intercept_inline(
            &noisy_input,
            &mut noisy_damped,
            0,
            0.0,
            0.24,
            25.0,
            -12.0,
            7.0,
        ));
        assert_eq!(base_damped, noisy_damped);
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

        let water_surface_cap = line_shot_distance_to_range_volume_inline(
            0.0,
            0.0,
            TERRAIN_WATER_LEVEL - 25.0,
            0.0,
            0.0,
            1.0,
            0.0,
            0.0,
            TERRAIN_WATER_LEVEL - 100.0,
            10.0,
            LINE_SHOT_RANGE_VOLUME_TOP_WATER_AND_BOTTOM_UNBOUNDED,
        )
        .unwrap();
        assert_close(water_surface_cap, 25.0);

        let water_depth_unbounded = line_shot_distance_to_range_volume_inline(
            0.0,
            0.0,
            TERRAIN_WATER_LEVEL - 25.0,
            0.0,
            0.0,
            -1.0,
            0.0,
            0.0,
            TERRAIN_WATER_LEVEL - 100.0,
            10.0,
            LINE_SHOT_RANGE_VOLUME_TOP_WATER_AND_BOTTOM_UNBOUNDED,
        );
        assert!(water_depth_unbounded.is_none());
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

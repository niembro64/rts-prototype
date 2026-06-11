// projectile — extracted from lib.rs (pure code motion).

#[allow(unused_imports)]
use wasm_bindgen::prelude::*;
#[allow(unused_imports)]
use crate::*;

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
pub(crate) static PROJECTILE_POOL: ProjectilePoolHolder = ProjectilePoolHolder(UnsafeCell::new(None));

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
//  diagnostic callers. The authoritative server projectile path uses
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

pub const PROJECTILE_HOMING_GUIDANCE_STRIDE: usize = 31;

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
pub(crate) const PHG_ROW_OUT_THRUST_X: usize = 27;
pub(crate) const PHG_ROW_OUT_THRUST_Y: usize = 28;
pub(crate) const PHG_ROW_OUT_THRUST_Z: usize = 29;
pub(crate) const PHG_ROW_OUT_INTERCEPT_FOUND: usize = 30;

#[wasm_bindgen]
pub fn projectile_homing_guidance_batch(rows: &mut [f64], count: usize, dt_sec: f64) -> u32 {
    if rows.len() < count * PROJECTILE_HOMING_GUIDANCE_STRIDE {
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
            if solve_kinematic_intercept_inline(
                &input,
                &mut intercept_out,
                0,
                rows[base + PHG_ROW_MAX_TIME_SEC],
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

/// Batched constant-acceleration projectile/body integrator.
///
/// Position uses the exact `p + v*t + 0.5*a*t^2` equation and velocity uses
/// `v + a*t`. TypeScript still owns projectile lifecycle and target policy,
/// but all non-packed guided/D-gun projectile integration now crosses this
/// kernel in one batch per tick.
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
        || !dt_sec.is_finite()
    {
        return 0;
    }

    let half_dt_sq = 0.5 * dt_sec * dt_sec;
    for i in 0..n {
        pos_x[i] += vel_x[i] * dt_sec + accel_x[i] * half_dt_sq;
        pos_y[i] += vel_y[i] * dt_sec + accel_y[i] * half_dt_sq;
        pos_z[i] += vel_z[i] * dt_sec + accel_z[i] * half_dt_sq;
        vel_x[i] += accel_x[i] * dt_sec;
        vel_y[i] += accel_y[i] * dt_sec;
        vel_z[i] += accel_z[i] * dt_sec;
    }
    count
}

/// Per-tick ballistic integrator. For slots 0..count, advances with the
/// same constant-acceleration equation the ballistic aim solver uses:
///   pos_x[i] += vel_x[i] * dt_sec
///   pos_y[i] += vel_y[i] * dt_sec
///   pos_z[i] += vel_z[i] * dt_sec - 0.5 * GRAVITY * dt_sec^2
///   vel_z[i] -= GRAVITY * dt_sec
/// Same math as the inner loop in projectileSystem._updatePackedProjectilesJS.
#[wasm_bindgen]
pub fn pool_step_packed_projectiles_batch(count: u32, dt_sec: f64) {
    let p = projectile_pool();
    let n = count as usize;
    debug_assert!(n <= PROJECTILE_POOL_CAPACITY_USIZE);
    let half_dt_sq = 0.5 * dt_sec * dt_sec;
    for i in 0..n {
        p.pos_x[i] += p.vel_x[i] * dt_sec;
        p.pos_y[i] += p.vel_y[i] * dt_sec;
        p.pos_z[i] += p.vel_z[i] * dt_sec - GRAVITY * half_dt_sq;
        p.vel_z[i] -= GRAVITY * dt_sec;
    }
}

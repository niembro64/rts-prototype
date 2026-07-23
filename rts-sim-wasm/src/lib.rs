// rts-sim-wasm — bespoke RTS simulation core.
//
// Compiled to WebAssembly via wasm-pack. Rust owns the authoritative
// fixed-tick simulation and retains adjacent poses for render interpolation.
//
// Phase 1 landed the scaffolding. Phase 2 ported the shared
// unit-motion integrator. Subsequent phases move the rest of the
// numerical hot path into this crate:
//   3  PhysicsEngine3D core    — Body3D SoA + resolvers + sleep
//   4  quaternion math kernel  — used by hover orientation spring
//   5  projectile motion       — ballistic + homing + beam paths
//   6  turret + targeting      — damped-spring + top-K LOS scan
//   7  spatial grid            — 3D voxel hash
//   8  terrain sampling        — heightmap in linear memory
//   9  pathfinder              — A* over the walk grid
//  10  snapshot serializer     — per-entity quantize + delta path

use rustc_hash::{FxHashMap as HashMap, FxHashSet as HashSet};
use std::cell::UnsafeCell;
use wasm_bindgen::prelude::*;

// ─────────────────────────────────────────────────────────────────
//  Module init + build stamp
// ─────────────────────────────────────────────────────────────────

/// Build-stamp string. JS calls this once on load to confirm the
/// WASM module matches the expected crate revision; mismatch
/// implies a stale wasm-pack build in src/game/sim-wasm/pkg/.
#[wasm_bindgen]
pub fn version() -> String {
    format!("rts-sim-wasm {}", env!("CARGO_PKG_VERSION"))
}

/// Scalar math kernels used by deterministic-lockstep TypeScript glue.
///
/// WebAssembly owns these functions so any remaining TS gameplay orchestration
/// can avoid browser-specific `Math.*` transcendental implementations.
#[wasm_bindgen]
pub fn deterministic_math_sin(value: f64) -> f64 {
    value.sin()
}

#[wasm_bindgen]
pub fn deterministic_math_cos(value: f64) -> f64 {
    value.cos()
}

#[wasm_bindgen]
pub fn deterministic_math_atan2(y: f64, x: f64) -> f64 {
    y.atan2(x)
}

#[wasm_bindgen]
pub fn deterministic_math_sqrt(value: f64) -> f64 {
    value.sqrt()
}

#[wasm_bindgen]
pub fn deterministic_math_hypot2(x: f64, y: f64) -> f64 {
    (x * x + y * y).sqrt()
}

#[wasm_bindgen]
pub fn deterministic_math_hypot3(x: f64, y: f64, z: f64) -> f64 {
    (x * x + y * y + z * z).sqrt()
}

#[wasm_bindgen]
pub fn deterministic_math_pow(base: f64, exponent: f64) -> f64 {
    base.powf(exponent)
}

/// Module init. wasm-bindgen calls this automatically when the
/// JS side imports the module (because of the #[wasm_bindgen(start)]
/// attribute). Installs the panic hook before any other code runs.
#[wasm_bindgen(start)]
pub fn __init() {
    console_error_panic_hook::set_once();
}

// ─────────────────────────────────────────────────────────────────
//  Unit-motion integrator constants
//
//  Cross-language tuning values that must not drift are generated
//  from src/sharedSimConstants.json by build.rs.
// ─────────────────────────────────────────────────────────────────

// Generated from src/sharedSimConstants.json by rts-sim-wasm/build.rs.
include!(concat!(env!("OUT_DIR"), "/shared_sim_constants.rs"));

// Generated from src/game/sim/pathfindingTuningConfig.json by build.rs.
include!(concat!(env!("OUT_DIR"), "/pathfinding_tuning.rs"));

// Generated from src/windConfig.json by rts-sim-wasm/build.rs.
include!(concat!(env!("OUT_DIR"), "/wind_config.rs"));

// Wire/state enum codes generated from src/wireEnums.json by build.rs.
// TypeScript imports the same JSON, so these codes can't drift across the
// JS/WASM boundary. Provides CT_TURRET_STATE_* and ENTITY_CHANGED_*.
include!(concat!(env!("OUT_DIR"), "/wire_enums.rs"));

mod blueprint_tables {
    #![allow(dead_code)]

    include!(concat!(env!("OUT_DIR"), "/blueprint_tables.rs"));
}

mod air_drag;
mod generated_blueprint_schema;

#[wasm_bindgen]
pub fn blueprint_unit_count() -> u32 {
    blueprint_tables::BLUEPRINT_UNITS_COUNT as u32
}

#[wasm_bindgen]
pub fn blueprint_building_count() -> u32 {
    blueprint_tables::BLUEPRINT_BUILDINGS_COUNT as u32
}

#[wasm_bindgen]
pub fn blueprint_turret_count() -> u32 {
    blueprint_tables::BLUEPRINT_TURRETS_COUNT as u32
}

#[wasm_bindgen]
pub fn blueprint_shot_count() -> u32 {
    blueprint_tables::BLUEPRINT_SHOTS_COUNT as u32
}

#[wasm_bindgen]
pub fn blueprint_buildable_unit_count() -> u32 {
    blueprint_tables::BLUEPRINT_BUILDABLE_UNIT_COUNT as u32
}

#[inline]
fn wind_wave(t_sec: f64, period_sec: f64, phase: f64) -> f64 {
    (t_sec / period_sec.max(1.0)) * std::f64::consts::TAU + phase
}

#[wasm_bindgen]
pub fn wind_sample_state(now_ms: f64, out: &mut [f64]) -> u32 {
    if out.len() < 5 || !now_ms.is_finite() {
        return 0;
    }

    let t = now_ms / 1000.0;
    let angle = wind_wave(t, WIND_DIRECTION_PERIOD_PRIMARY, 0.0).sin() * 1.1
        + wind_wave(t, WIND_DIRECTION_PERIOD_SECONDARY, 0.8).cos() * 0.7
        + wind_wave(t, WIND_DIRECTION_PERIOD_TERTIARY, 2.4).sin() * 0.45;
    let raw_speed = 0.92
        + wind_wave(t, WIND_SPEED_PERIOD_PRIMARY, 1.7).sin() * 0.28
        + wind_wave(t, WIND_SPEED_PERIOD_SECONDARY, 0.2).cos() * 0.22
        + wind_wave(t, WIND_SPEED_PERIOD_TERTIARY, 4.1).sin() * 0.13;
    let horizontal_speed = raw_speed.max(WIND_SPEED_MIN).min(WIND_SPEED_MAX);
    let vertical_unit = wind_wave(t, WIND_VERTICAL_PERIOD_PRIMARY, 3.2).sin() * 0.62
        + wind_wave(t, WIND_VERTICAL_PERIOD_SECONDARY, 5.1).cos() * 0.38;
    let vertical_fraction =
        vertical_unit.max(-1.0).min(1.0) * WIND_VERTICAL_MAX_FRACTION_OF_HORIZONTAL_SPEED.max(0.0);
    let z = horizontal_speed * vertical_fraction;
    let speed = (horizontal_speed * horizontal_speed + z * z).sqrt();

    out[0] = angle.cos() * horizontal_speed;
    out[1] = angle.sin() * horizontal_speed;
    out[2] = z;
    out[3] = speed;
    out[4] = angle;
    1
}

#[inline]
fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.min(b)
    }
}

#[inline]
fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.max(b)
    }
}

const BUILD_TARGET_KIND_BUILDING: u32 = 1;
const BUILD_TARGET_KIND_UNIT: u32 = 2;

/// Horizontal construction/reclaim/repair reach distance.
///
/// TypeScript supplies object-owned entity fields; Rust owns the
/// target-shape distance math so every build-range gate uses one
/// numeric kernel.
#[wasm_bindgen]
pub fn build_target_horizontal_distance(
    builder_x: f64,
    builder_y: f64,
    target_x: f64,
    target_y: f64,
    target_kind: u32,
    target_width: f64,
    target_height: f64,
    target_radius: f64,
) -> f64 {
    if target_kind == BUILD_TARGET_KIND_BUILDING {
        let half_w = target_width / 2.0;
        let half_h = target_height / 2.0;
        let min_x = target_x - half_w;
        let max_x = target_x + half_w;
        let min_y = target_y - half_h;
        let max_y = target_y + half_h;
        let closest_x = js_max(min_x, js_min(builder_x, max_x));
        let closest_y = js_max(min_y, js_min(builder_y, max_y));
        let dx = closest_x - builder_x;
        let dy = closest_y - builder_y;
        return (dx * dx + dy * dy).sqrt();
    }

    let dx = target_x - builder_x;
    let dy = target_y - builder_y;
    let distance = (dx * dx + dy * dy).sqrt();
    let radius = if target_kind == BUILD_TARGET_KIND_UNIT {
        target_radius
    } else {
        0.0
    };
    js_max(0.0, distance - radius)
}

/// Commander reclaim tick kernel.
///
/// out[0..5] = next_hp, hp_removed, refund_energy, refund_metal,
/// complete_flag. Returns 0 only when the output buffer is too short.
#[wasm_bindgen]
pub fn commander_apply_reclaim_tick(
    hp_curr: f64,
    hp_max: f64,
    construction_rate: f64,
    dt_sec: f64,
    value_energy: f64,
    value_metal: f64,
    refund_fraction: f64,
    out: &mut [f64],
) -> u32 {
    if out.len() < 5 {
        return 0;
    }

    out[0] = hp_curr;
    out[1] = 0.0;
    out[2] = 0.0;
    out[3] = 0.0;
    out[4] = 0.0;

    if !hp_curr.is_finite()
        || !hp_max.is_finite()
        || !construction_rate.is_finite()
        || !dt_sec.is_finite()
        || !value_energy.is_finite()
        || !value_metal.is_finite()
        || !refund_fraction.is_finite()
        || hp_curr <= 0.0
        || construction_rate <= 0.0
        || dt_sec <= 0.0
    {
        return 1;
    }

    let hp_removed = js_min(hp_curr, construction_rate * dt_sec);
    if hp_removed <= 0.0 {
        return 1;
    }

    let max_hp = js_max(1.0, hp_max);
    let refund_scale = refund_fraction * (hp_removed / max_hp);
    let next_hp = js_max(0.0, hp_curr - hp_removed);

    out[0] = next_hp;
    out[1] = hp_removed;
    out[2] = value_energy * refund_scale;
    out[3] = value_metal * refund_scale;
    out[4] = if next_hp <= 0.0 { 1.0 } else { 0.0 };
    1
}

mod damage;
#[allow(unused_imports)]
pub(crate) use damage::*;

mod motion;
#[allow(unused_imports)]
pub(crate) use motion::*;

mod body_pool;
#[allow(unused_imports)]
pub(crate) use body_pool::*;
mod quaternion;
#[allow(unused_imports)]
pub(crate) use quaternion::*;
mod render_pose;
#[allow(unused_imports)]
pub(crate) use render_pose::*;
mod presentation;
#[allow(unused_imports)]
pub(crate) use presentation::*;
mod unit_kinetics;
#[allow(unused_imports)]
pub(crate) use unit_kinetics::*;
mod unit_action;
#[allow(unused_imports)]
pub(crate) use unit_action::*;
mod projectile;
#[allow(unused_imports)]
pub(crate) use projectile::*;
mod turret_spring;
#[allow(unused_imports)]
pub(crate) use turret_spring::*;
mod deposits;
#[allow(unused_imports)]
pub(crate) use deposits::*;
mod terrain;
#[allow(unused_imports)]
pub(crate) use terrain::*;
mod spatial_grid;
#[allow(unused_imports)]
pub(crate) use spatial_grid::*;
mod entity_state;
#[allow(unused_imports)]
pub(crate) use entity_state::*;
mod pathfinder;
#[allow(unused_imports)]
pub(crate) use pathfinder::*;
mod messagepack;
#[allow(unused_imports)]
pub(crate) use messagepack::*;
mod entity_meta;
#[allow(unused_imports)]
pub(crate) use entity_meta::*;
mod combat_targeting;
#[allow(unused_imports)]
pub(crate) use combat_targeting::*;
mod snapshot;
#[allow(unused_imports)]
pub(crate) use snapshot::*;

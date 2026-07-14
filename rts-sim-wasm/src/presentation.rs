// presentation — Recoil-style fixed-tick render history.
//
// The deterministic simulation owns the current EntityState/TurretPool slabs.
// At the end of every 30 Hz fixed tick we retain two adjacent immutable views
// of their presentation fields. Render frames query those views with one
// shared alpha; positions/normals/velocities use linear interpolation and
// full orientations use shortest-path quaternion SLERP. Gameplay never reads
// this state.

#[allow(unused_imports)]
use crate::*;
#[allow(unused_imports)]
use wasm_bindgen::prelude::*;

pub const PRESENTATION_POSE_OUTPUT_STRIDE: usize = 20;
pub const PRESENTATION_TURRET_OUTPUT_STRIDE: usize = 6;

#[derive(Clone, Default)]
struct PoseFrame {
    entity_id: Vec<i32>,
    pos_x: Vec<f64>,
    pos_y: Vec<f64>,
    pos_z: Vec<f64>,
    rotation: Vec<f64>,
    vel_x: Vec<f64>,
    vel_y: Vec<f64>,
    vel_z: Vec<f64>,
    normal_x: Vec<f64>,
    normal_y: Vec<f64>,
    normal_z: Vec<f64>,
    orientation_x: Vec<f64>,
    orientation_y: Vec<f64>,
    orientation_z: Vec<f64>,
    orientation_w: Vec<f64>,
    angular_x: Vec<f64>,
    angular_y: Vec<f64>,
    angular_z: Vec<f64>,
    motion_flags: Vec<u32>,
    turret_count: Vec<u8>,
    turret_entity_id: Vec<i32>,
    turret_rotation: Vec<f32>,
    turret_angular_velocity: Vec<f32>,
    turret_pitch: Vec<f32>,
    turret_pitch_velocity: Vec<f32>,
}

impl PoseFrame {
    fn capture(&mut self) {
        let state = entity_state();
        self.entity_id.clone_from(&state.entity_id);
        self.pos_x.clone_from(&state.pos_x);
        self.pos_y.clone_from(&state.pos_y);
        self.pos_z.clone_from(&state.pos_z);
        self.rotation.clone_from(&state.rotation);
        self.vel_x.clone_from(&state.vel_x);
        self.vel_y.clone_from(&state.vel_y);
        self.vel_z.clone_from(&state.vel_z);
        self.normal_x.clone_from(&state.surface_normal_x);
        self.normal_y.clone_from(&state.surface_normal_y);
        self.normal_z.clone_from(&state.surface_normal_z);
        self.orientation_x.clone_from(&state.orientation_x);
        self.orientation_y.clone_from(&state.orientation_y);
        self.orientation_z.clone_from(&state.orientation_z);
        self.orientation_w.clone_from(&state.orientation_w);
        self.angular_x.clone_from(&state.angular_velocity_x);
        self.angular_y.clone_from(&state.angular_velocity_y);
        self.angular_z.clone_from(&state.angular_velocity_z);
        self.motion_flags.clone_from(&state.unit_motion_flags);

        // CombatTargetingPool is the live production turret source. The
        // entity-meta TurretPool is snapshot-era compatibility storage and is
        // not populated by the simulation tick.
        let turrets = combat_targeting_pool();
        self.turret_count
            .clone_from(&turrets.turret_count_per_entity);
        self.turret_entity_id.clone_from(&turrets.turret_entity_id);
        self.turret_rotation.clone_from(&turrets.turret_rotation);
        self.turret_angular_velocity
            .clone_from(&turrets.turret_angular_velocity);
        self.turret_pitch.clone_from(&turrets.turret_pitch);
        self.turret_pitch_velocity
            .clone_from(&turrets.turret_pitch_velocity);
    }

    fn copy_slot_from(&mut self, source: &PoseFrame, slot: usize) {
        if slot >= source.entity_id.len() || slot >= self.entity_id.len() {
            return;
        }
        self.entity_id[slot] = source.entity_id[slot];
        self.pos_x[slot] = source.pos_x[slot];
        self.pos_y[slot] = source.pos_y[slot];
        self.pos_z[slot] = source.pos_z[slot];
        self.rotation[slot] = source.rotation[slot];
        self.vel_x[slot] = source.vel_x[slot];
        self.vel_y[slot] = source.vel_y[slot];
        self.vel_z[slot] = source.vel_z[slot];
        self.normal_x[slot] = source.normal_x[slot];
        self.normal_y[slot] = source.normal_y[slot];
        self.normal_z[slot] = source.normal_z[slot];
        self.orientation_x[slot] = source.orientation_x[slot];
        self.orientation_y[slot] = source.orientation_y[slot];
        self.orientation_z[slot] = source.orientation_z[slot];
        self.orientation_w[slot] = source.orientation_w[slot];
        self.angular_x[slot] = source.angular_x[slot];
        self.angular_y[slot] = source.angular_y[slot];
        self.angular_z[slot] = source.angular_z[slot];
        self.motion_flags[slot] = source.motion_flags[slot];
        if slot < source.turret_count.len() && slot < self.turret_count.len() {
            self.turret_count[slot] = source.turret_count[slot];
            let base = slot * COMBAT_TARGETING_MAX_TURRETS_PER_ENTITY as usize;
            for turret in 0..COMBAT_TARGETING_MAX_TURRETS_PER_ENTITY as usize {
                let index = base + turret;
                if index >= source.turret_entity_id.len() || index >= self.turret_entity_id.len() {
                    break;
                }
                self.turret_entity_id[index] = source.turret_entity_id[index];
                self.turret_rotation[index] = source.turret_rotation[index];
                self.turret_angular_velocity[index] = source.turret_angular_velocity[index];
                self.turret_pitch[index] = source.turret_pitch[index];
                self.turret_pitch_velocity[index] = source.turret_pitch_velocity[index];
            }
        }
    }
}

struct PresentationHistory {
    previous: PoseFrame,
    current: PoseFrame,
    initialized: bool,
    tick: u32,
    slot_input: Vec<u32>,
    pose_output: Vec<f32>,
    turret_output: Vec<f32>,
}

impl PresentationHistory {
    fn empty() -> Self {
        Self {
            previous: PoseFrame::default(),
            current: PoseFrame::default(),
            initialized: false,
            tick: 0,
            slot_input: vec![0; 1024],
            pose_output: vec![0.0; 1024 * PRESENTATION_POSE_OUTPUT_STRIDE],
            turret_output: vec![
                0.0;
                1024 * COMBAT_TARGETING_MAX_TURRETS_PER_ENTITY as usize
                    * PRESENTATION_TURRET_OUTPUT_STRIDE
            ],
        }
    }

    fn ensure_scratch(&mut self, count: usize) {
        if self.slot_input.len() < count {
            self.slot_input.resize(count, 0);
        }
        let pose_needed = count * PRESENTATION_POSE_OUTPUT_STRIDE;
        if self.pose_output.len() < pose_needed {
            self.pose_output.resize(pose_needed, 0.0);
        }
        let turret_needed = count
            * COMBAT_TARGETING_MAX_TURRETS_PER_ENTITY as usize
            * PRESENTATION_TURRET_OUTPUT_STRIDE;
        if self.turret_output.len() < turret_needed {
            self.turret_output.resize(turret_needed, 0.0);
        }
    }
}

pub(crate) struct PresentationHistoryHolder(UnsafeCell<Option<PresentationHistory>>);
unsafe impl Sync for PresentationHistoryHolder {}
pub(crate) static PRESENTATION_HISTORY: PresentationHistoryHolder =
    PresentationHistoryHolder(UnsafeCell::new(None));

#[inline]
fn presentation_history() -> &'static mut PresentationHistory {
    unsafe {
        let cell = &mut *PRESENTATION_HISTORY.0.get();
        if cell.is_none() {
            *cell = Some(PresentationHistory::empty());
        }
        cell.as_mut().unwrap()
    }
}

#[inline]
fn lerp(a: f64, b: f64, alpha: f64) -> f64 {
    a + (b - a) * alpha
}

#[inline]
fn lerp_angle(a: f64, b: f64, alpha: f64) -> f64 {
    normalize_angle_ts(a + normalize_angle_ts(b - a) * alpha)
}

#[inline]
fn slerp_quat(a: [f64; 4], b: [f64; 4], alpha: f64) -> [f64; 4] {
    let mut qa = a;
    let mut qb = b;
    quat_normalize_inplace(&mut qa);
    quat_normalize_inplace(&mut qb);
    let mut dot = qa[0] * qb[0] + qa[1] * qb[1] + qa[2] * qb[2] + qa[3] * qb[3];
    if dot < 0.0 {
        dot = -dot;
        qb = [-qb[0], -qb[1], -qb[2], -qb[3]];
    }
    if dot > 0.9995 {
        let mut out = [
            lerp(qa[0], qb[0], alpha),
            lerp(qa[1], qb[1], alpha),
            lerp(qa[2], qb[2], alpha),
            lerp(qa[3], qb[3], alpha),
        ];
        quat_normalize_inplace(&mut out);
        return out;
    }
    let theta = dot.clamp(-1.0, 1.0).acos();
    let sin_theta = theta.sin();
    if sin_theta.abs() <= 1e-9 {
        return qa;
    }
    let wa = ((1.0 - alpha) * theta).sin() / sin_theta;
    let wb = (alpha * theta).sin() / sin_theta;
    [
        qa[0] * wa + qb[0] * wb,
        qa[1] * wa + qb[1] * wb,
        qa[2] * wa + qb[2] * wb,
        qa[3] * wa + qb[3] * wb,
    ]
}

#[wasm_bindgen]
pub fn presentation_clear() {
    *presentation_history() = PresentationHistory::empty();
}

#[wasm_bindgen]
pub fn presentation_capture_tick(tick: u32) {
    let history = presentation_history();
    if history.initialized {
        core::mem::swap(&mut history.previous, &mut history.current);
        history.current.capture();
        // A recycled stable slot is a new object, not a teleport from the old
        // occupant. Seed both endpoints from the new state.
        for slot in 0..history.current.entity_id.len() {
            if slot >= history.previous.entity_id.len()
                || history.previous.entity_id[slot] != history.current.entity_id[slot]
            {
                history.previous.copy_slot_from(&history.current, slot);
            }
        }
    } else {
        history.current.capture();
        history.previous = history.current.clone();
        history.initialized = true;
    }
    history.tick = tick;
}

#[wasm_bindgen]
pub fn presentation_latest_tick() -> u32 {
    presentation_history().tick
}

#[wasm_bindgen]
pub fn presentation_has_history() -> bool {
    presentation_history().initialized
}

#[wasm_bindgen]
pub fn presentation_slot_input_scratch_ptr() -> *mut u32 {
    presentation_history().slot_input.as_mut_ptr()
}

#[wasm_bindgen]
pub fn presentation_pose_output_scratch_ptr() -> *const f32 {
    presentation_history().pose_output.as_ptr()
}

#[wasm_bindgen]
pub fn presentation_turret_output_scratch_ptr() -> *const f32 {
    presentation_history().turret_output.as_ptr()
}

#[wasm_bindgen]
pub fn presentation_scratch_ensure(count: u32) {
    presentation_history().ensure_scratch(count as usize);
}

#[wasm_bindgen]
pub fn presentation_interpolate(count: u32, alpha: f64) -> u32 {
    let history = presentation_history();
    let count = count as usize;
    history.ensure_scratch(count);
    let t = if alpha.is_finite() {
        alpha.clamp(0.0, 1.0)
    } else {
        0.0
    };
    let mut valid_count = 0u32;
    for row in 0..count {
        let slot = history.slot_input[row] as usize;
        let ob = row * PRESENTATION_POSE_OUTPUT_STRIDE;
        history.pose_output[ob..ob + PRESENTATION_POSE_OUTPUT_STRIDE].fill(0.0);
        let turret_row_base = row
            * COMBAT_TARGETING_MAX_TURRETS_PER_ENTITY as usize
            * PRESENTATION_TURRET_OUTPUT_STRIDE;
        let turret_row_end = turret_row_base
            + COMBAT_TARGETING_MAX_TURRETS_PER_ENTITY as usize * PRESENTATION_TURRET_OUTPUT_STRIDE;
        history.turret_output[turret_row_base..turret_row_end].fill(0.0);
        if !history.initialized
            || slot >= history.current.entity_id.len()
            || history.current.entity_id[slot] < 0
        {
            continue;
        }
        let current_id = history.current.entity_id[slot];
        let same_entity = slot < history.previous.entity_id.len()
            && history.previous.entity_id[slot] == current_id;
        let prev = if same_entity {
            &history.previous
        } else {
            &history.current
        };
        let current = &history.current;
        valid_count += 1;
        history.pose_output[ob] = 1.0;
        history.pose_output[ob + 1] = lerp(prev.pos_x[slot], current.pos_x[slot], t) as f32;
        history.pose_output[ob + 2] = lerp(prev.pos_y[slot], current.pos_y[slot], t) as f32;
        history.pose_output[ob + 3] = lerp(prev.pos_z[slot], current.pos_z[slot], t) as f32;
        history.pose_output[ob + 4] =
            lerp_angle(prev.rotation[slot], current.rotation[slot], t) as f32;
        history.pose_output[ob + 5] = lerp(prev.vel_x[slot], current.vel_x[slot], t) as f32;
        history.pose_output[ob + 6] = lerp(prev.vel_y[slot], current.vel_y[slot], t) as f32;
        history.pose_output[ob + 7] = lerp(prev.vel_z[slot], current.vel_z[slot], t) as f32;
        let mut normal = [
            lerp(prev.normal_x[slot], current.normal_x[slot], t),
            lerp(prev.normal_y[slot], current.normal_y[slot], t),
            lerp(prev.normal_z[slot], current.normal_z[slot], t),
        ];
        let normal_len_sq = normal[0] * normal[0] + normal[1] * normal[1] + normal[2] * normal[2];
        if normal_len_sq > 1e-20 {
            let inv = 1.0 / normal_len_sq.sqrt();
            normal[0] *= inv;
            normal[1] *= inv;
            normal[2] *= inv;
        } else {
            normal = [0.0, 0.0, 1.0];
        }
        history.pose_output[ob + 8] = normal[0] as f32;
        history.pose_output[ob + 9] = normal[1] as f32;
        history.pose_output[ob + 10] = normal[2] as f32;
        let orientation = slerp_quat(
            [
                prev.orientation_x[slot],
                prev.orientation_y[slot],
                prev.orientation_z[slot],
                prev.orientation_w[slot],
            ],
            [
                current.orientation_x[slot],
                current.orientation_y[slot],
                current.orientation_z[slot],
                current.orientation_w[slot],
            ],
            t,
        );
        history.pose_output[ob + 11] = orientation[0] as f32;
        history.pose_output[ob + 12] = orientation[1] as f32;
        history.pose_output[ob + 13] = orientation[2] as f32;
        history.pose_output[ob + 14] = orientation[3] as f32;
        history.pose_output[ob + 15] =
            lerp(prev.angular_x[slot], current.angular_x[slot], t) as f32;
        history.pose_output[ob + 16] =
            lerp(prev.angular_y[slot], current.angular_y[slot], t) as f32;
        history.pose_output[ob + 17] =
            lerp(prev.angular_z[slot], current.angular_z[slot], t) as f32;
        history.pose_output[ob + 18] = current.motion_flags[slot] as f32;

        let turret_count = current
            .turret_count
            .get(slot)
            .copied()
            .unwrap_or(0)
            .min(COMBAT_TARGETING_MAX_TURRETS_PER_ENTITY as u8);
        history.pose_output[ob + 19] = turret_count as f32;
        let turret_base = slot * COMBAT_TARGETING_MAX_TURRETS_PER_ENTITY as usize;
        for turret in 0..turret_count as usize {
            let source_index = turret_base + turret;
            let target_index = turret_row_base + turret * PRESENTATION_TURRET_OUTPUT_STRIDE;
            if source_index >= current.turret_rotation.len() {
                break;
            }
            let same_turret = same_entity
                && source_index < prev.turret_entity_id.len()
                && prev.turret_entity_id[source_index] == current.turret_entity_id[source_index];
            let p = if same_turret { prev } else { current };
            history.turret_output[target_index] = lerp_angle(
                p.turret_rotation[source_index] as f64,
                current.turret_rotation[source_index] as f64,
                t,
            ) as f32;
            history.turret_output[target_index + 1] = lerp(
                p.turret_pitch[source_index] as f64,
                current.turret_pitch[source_index] as f64,
                t,
            ) as f32;
            history.turret_output[target_index + 2] = lerp(
                p.turret_angular_velocity[source_index] as f64,
                current.turret_angular_velocity[source_index] as f64,
                t,
            ) as f32;
            history.turret_output[target_index + 3] = lerp(
                p.turret_pitch_velocity[source_index] as f64,
                current.turret_pitch_velocity[source_index] as f64,
                t,
            ) as f32;
            // Shield radius remains snapshot-authored lifecycle state. The
            // continuous turret stream owns aim axes and their rates only.
            history.turret_output[target_index + 4] = 0.0;
            history.turret_output[target_index + 5] = 1.0;
        }
    }
    valid_count
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::MutexGuard;

    fn lock_tests() -> MutexGuard<'static, ()> {
        match crate::snapshot::COMBAT_TARGETING_TEST_LOCK.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        }
    }

    #[test]
    fn adjacent_ticks_interpolate_position_and_shortest_quaternion() {
        let _guard = lock_tests();
        entity_state_init(1);
        turret_pool_init(1);
        presentation_clear();
        entity_state_set_lifecycle(0, 77, ENTITY_STATE_KIND_UNIT, 1, 1, 1);
        entity_state_set_transform(0, 0.0, 2.0, 4.0, 0.0);
        entity_state_set_unit_motion(0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 2);
        presentation_capture_tick(1);
        entity_state_set_transform(0, 10.0, 4.0, 8.0, core::f64::consts::PI);
        entity_state_set_unit_motion(0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 2);
        presentation_capture_tick(2);
        let history = presentation_history();
        history.slot_input[0] = 0;
        assert_eq!(presentation_interpolate(1, 0.5), 1);
        let out = &presentation_history().pose_output;
        assert!((out[1] - 5.0).abs() < 1e-5);
        assert!((out[2] - 3.0).abs() < 1e-5);
        assert!((out[3] - 6.0).abs() < 1e-5);
        let q_len =
            (out[11] * out[11] + out[12] * out[12] + out[13] * out[13] + out[14] * out[14]).sqrt();
        assert!((q_len - 1.0).abs() < 1e-5);
    }

    #[test]
    fn adjacent_ticks_interpolate_live_combat_targeting_turret_pose() {
        let _guard = lock_tests();
        entity_state_init(1);
        combat_targeting_init(1);
        presentation_clear();
        entity_state_set_lifecycle(0, 77, ENTITY_STATE_KIND_UNIT, 1, 1, 1);
        entity_state_set_transform(0, 0.0, 0.0, 0.0, 0.0);
        {
            let turrets = combat_targeting_pool();
            turrets.turret_count_per_entity[0] = 1;
            turrets.turret_entity_id[0] = 700;
            turrets.turret_rotation[0] = 0.2;
            turrets.turret_pitch[0] = 0.1;
            turrets.turret_angular_velocity[0] = 0.4;
            turrets.turret_pitch_velocity[0] = 0.2;
        }
        presentation_capture_tick(1);
        {
            let turrets = combat_targeting_pool();
            turrets.turret_rotation[0] = 1.0;
            turrets.turret_pitch[0] = 0.5;
            turrets.turret_angular_velocity[0] = 0.8;
            turrets.turret_pitch_velocity[0] = 0.6;
        }
        presentation_capture_tick(2);
        presentation_history().slot_input[0] = 0;
        assert_eq!(presentation_interpolate(1, 0.5), 1);
        let out = &presentation_history().turret_output;
        assert!((out[0] - 0.6).abs() < 1e-5);
        assert!((out[1] - 0.3).abs() < 1e-5);
        assert!((out[2] - 0.6).abs() < 1e-5);
        assert!((out[3] - 0.4).abs() < 1e-5);
        assert_eq!(out[5], 1.0);
    }
}

// render_pose — extracted from lib.rs (pure code motion).

#[allow(unused_imports)]
use wasm_bindgen::prelude::*;
#[allow(unused_imports)]
use crate::*;

// ─────────────────────────────────────────────────────────────────
//  Render pose scratch — unit base chain
//
//  Computes the high-count unit render chain:
//    group tilt quaternion, inverse tilt, parent quaternion
//    (tilt · Ry(-simRotation)), lifted world position, and
//    T(liftedPos) · R(parentQuat) matrix.
//
//  This mirrors the Render3DEntities unit base-pose math. The visual
//  airborne bank intentionally stays out of the parent quaternion here,
//  matching the current instanced chassis/turret path.
// ─────────────────────────────────────────────────────────────────

pub const RENDER_UNIT_POSE_INPUT_STRIDE: usize = 11;
pub const RENDER_UNIT_POSE_OUTPUT_STRIDE: usize = 32;

pub(crate) struct RenderUnitPoseScratch {
    input: Vec<f32>,
    output: Vec<f32>,
}

pub(crate) struct RenderUnitPoseScratchHolder(UnsafeCell<Option<RenderUnitPoseScratch>>);
unsafe impl Sync for RenderUnitPoseScratchHolder {}
pub(crate) static RENDER_UNIT_POSE_SCRATCH: RenderUnitPoseScratchHolder =
    RenderUnitPoseScratchHolder(UnsafeCell::new(None));

#[inline]
pub(crate) fn render_unit_pose_scratch() -> &'static mut RenderUnitPoseScratch {
    unsafe {
        let cell = &mut *RENDER_UNIT_POSE_SCRATCH.0.get();
        if cell.is_none() {
            *cell = Some(RenderUnitPoseScratch {
                input: vec![0.0; RENDER_UNIT_POSE_INPUT_STRIDE * 512],
                output: vec![0.0; RENDER_UNIT_POSE_OUTPUT_STRIDE * 512],
            });
        }
        cell.as_mut().unwrap()
    }
}

#[wasm_bindgen]
pub fn render_unit_pose_input_scratch_ptr() -> *const f32 {
    render_unit_pose_scratch().input.as_ptr()
}

#[wasm_bindgen]
pub fn render_unit_pose_output_scratch_ptr() -> *const f32 {
    render_unit_pose_scratch().output.as_ptr()
}

#[wasm_bindgen]
pub fn render_unit_pose_scratch_ensure(count: u32) {
    let s = render_unit_pose_scratch();
    let input_needed = (count as usize) * RENDER_UNIT_POSE_INPUT_STRIDE;
    if s.input.len() < input_needed {
        s.input.resize(input_needed, 0.0);
    }
    let output_needed = (count as usize) * RENDER_UNIT_POSE_OUTPUT_STRIDE;
    if s.output.len() < output_needed {
        s.output.resize(output_needed, 0.0);
    }
}

#[inline]
pub(crate) fn quat_mul(a: [f64; 4], b: [f64; 4]) -> [f64; 4] {
    [
        a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
        a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
        a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
        a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
    ]
}

#[inline]
pub(crate) fn quat_rotate_vec(q: [f64; 4], v: [f64; 3]) -> [f64; 3] {
    let qx = q[0];
    let qy = q[1];
    let qz = q[2];
    let qw = q[3];
    let vx = v[0];
    let vy = v[1];
    let vz = v[2];

    let tx = 2.0 * (qy * vz - qz * vy);
    let ty = 2.0 * (qz * vx - qx * vz);
    let tz = 2.0 * (qx * vy - qy * vx);

    [
        vx + qw * tx + (qy * tz - qz * ty),
        vy + qw * ty + (qz * tx - qx * tz),
        vz + qw * tz + (qx * ty - qy * tx),
    ]
}

#[inline]
pub(crate) fn render_tilt_quat_from_surface_normal(
    sim_nx: f64,
    sim_ny: f64,
    sim_nz: f64,
    airborne: bool,
) -> ([f64; 4], bool) {
    if airborne || (sim_nx == 0.0 && sim_ny == 0.0) {
        return ([0.0, 0.0, 0.0, 1.0], false);
    }

    // Three.js normal = (sim.nx, sim.nz, sim.ny). Quaternion equals
    // THREE.Quaternion.setFromUnitVectors((0,1,0), threeNormal).
    let tx = sim_nx;
    let ty = sim_nz;
    let tz = sim_ny;
    let r = ty + 1.0;
    let mut q = if r < 1e-6 {
        [0.0, 0.0, 1.0, 0.0]
    } else {
        [tz, 0.0, -tx, r]
    };
    quat_normalize_inplace(&mut q);
    (q, true)
}

#[inline]
pub(crate) fn render_write_mat4_compose(out: &mut [f32], offset: usize, pos: [f64; 3], q: [f64; 4]) {
    let x = q[0];
    let y = q[1];
    let z = q[2];
    let w = q[3];
    let x2 = x + x;
    let y2 = y + y;
    let z2 = z + z;
    let xx = x * x2;
    let xy = x * y2;
    let xz = x * z2;
    let yy = y * y2;
    let yz = y * z2;
    let zz = z * z2;
    let wx = w * x2;
    let wy = w * y2;
    let wz = w * z2;

    out[offset] = (1.0 - (yy + zz)) as f32;
    out[offset + 1] = (xy + wz) as f32;
    out[offset + 2] = (xz - wy) as f32;
    out[offset + 3] = 0.0;
    out[offset + 4] = (xy - wz) as f32;
    out[offset + 5] = (1.0 - (xx + zz)) as f32;
    out[offset + 6] = (yz + wx) as f32;
    out[offset + 7] = 0.0;
    out[offset + 8] = (xz + wy) as f32;
    out[offset + 9] = (yz - wx) as f32;
    out[offset + 10] = (1.0 - (xx + yy)) as f32;
    out[offset + 11] = 0.0;
    out[offset + 12] = pos[0] as f32;
    out[offset + 13] = pos[1] as f32;
    out[offset + 14] = pos[2] as f32;
    out[offset + 15] = 1.0;
}

#[wasm_bindgen]
pub fn render_unit_pose_compute(count: u32) {
    let s = render_unit_pose_scratch();
    let count_usize = count as usize;
    debug_assert!(s.input.len() >= count_usize * RENDER_UNIT_POSE_INPUT_STRIDE);
    debug_assert!(s.output.len() >= count_usize * RENDER_UNIT_POSE_OUTPUT_STRIDE);

    for i in 0..count_usize {
        let ib = i * RENDER_UNIT_POSE_INPUT_STRIDE;
        let ob = i * RENDER_UNIT_POSE_OUTPUT_STRIDE;
        let base_x = s.input[ib] as f64;
        let base_y = s.input[ib + 1] as f64;
        let base_z = s.input[ib + 2] as f64;
        let sim_rotation = s.input[ib + 3] as f64;
        let normal_x = s.input[ib + 4] as f64;
        let normal_y = s.input[ib + 5] as f64;
        let normal_z = s.input[ib + 6] as f64;
        let lift_x = s.input[ib + 7] as f64;
        let lift_y = s.input[ib + 8] as f64;
        let lift_z = s.input[ib + 9] as f64;
        let airborne = s.input[ib + 10] != 0.0;

        let (tilt_q, chassis_tilted) =
            render_tilt_quat_from_surface_normal(normal_x, normal_y, normal_z, airborne);
        let inv_tilt_q = if chassis_tilted {
            [-tilt_q[0], -tilt_q[1], -tilt_q[2], tilt_q[3]]
        } else {
            [0.0, 0.0, 0.0, 1.0]
        };
        let yaw = -sim_rotation;
        let yaw_q = [0.0, (yaw * 0.5).sin(), 0.0, (yaw * 0.5).cos()];
        let parent_q = quat_mul(tilt_q, yaw_q);
        let lifted_offset = quat_rotate_vec(parent_q, [lift_x, lift_y, lift_z]);
        let lifted_pos = [
            base_x + lifted_offset[0],
            base_y + lifted_offset[1],
            base_z + lifted_offset[2],
        ];

        s.output[ob] = tilt_q[0] as f32;
        s.output[ob + 1] = tilt_q[1] as f32;
        s.output[ob + 2] = tilt_q[2] as f32;
        s.output[ob + 3] = tilt_q[3] as f32;
        s.output[ob + 4] = inv_tilt_q[0] as f32;
        s.output[ob + 5] = inv_tilt_q[1] as f32;
        s.output[ob + 6] = inv_tilt_q[2] as f32;
        s.output[ob + 7] = inv_tilt_q[3] as f32;
        s.output[ob + 8] = parent_q[0] as f32;
        s.output[ob + 9] = parent_q[1] as f32;
        s.output[ob + 10] = parent_q[2] as f32;
        s.output[ob + 11] = parent_q[3] as f32;
        s.output[ob + 12] = lifted_pos[0] as f32;
        s.output[ob + 13] = lifted_pos[1] as f32;
        s.output[ob + 14] = lifted_pos[2] as f32;
        s.output[ob + 15] = if chassis_tilted { 1.0 } else { 0.0 };
        render_write_mat4_compose(&mut s.output, ob + 16, lifted_pos, parent_q);
    }
}

// ─────────────────────────────────────────────────────────────────
//  Render pose helper — airborne locomotion smoke emitters
//
//  Each row composes:
//    T(parentPos) · R(parentQuat) · T(groupPos)
//    · T(childPos) · R(childQuat) · T(emitterPos)
//
//  Output is in sim coordinate order for SmokeTrail3D:
//    smoke position x/y/z, smoke velocity x/y/z.
// ─────────────────────────────────────────────────────────────────

pub const RENDER_AIRBORNE_EMITTER_INPUT_STRIDE: usize = 24;
pub const RENDER_AIRBORNE_EMITTER_OUTPUT_STRIDE: usize = 6;

pub(crate) struct RenderAirborneEmitterScratch {
    input: Vec<f32>,
    output: Vec<f32>,
}

pub(crate) struct RenderAirborneEmitterScratchHolder(UnsafeCell<Option<RenderAirborneEmitterScratch>>);
unsafe impl Sync for RenderAirborneEmitterScratchHolder {}
pub(crate) static RENDER_AIRBORNE_EMITTER_SCRATCH: RenderAirborneEmitterScratchHolder =
    RenderAirborneEmitterScratchHolder(UnsafeCell::new(None));

#[inline]
pub(crate) fn render_airborne_emitter_scratch() -> &'static mut RenderAirborneEmitterScratch {
    unsafe {
        let cell = &mut *RENDER_AIRBORNE_EMITTER_SCRATCH.0.get();
        if cell.is_none() {
            *cell = Some(RenderAirborneEmitterScratch {
                input: vec![0.0; RENDER_AIRBORNE_EMITTER_INPUT_STRIDE * 512],
                output: vec![0.0; RENDER_AIRBORNE_EMITTER_OUTPUT_STRIDE * 512],
            });
        }
        cell.as_mut().unwrap()
    }
}

#[wasm_bindgen]
pub fn render_airborne_emitter_input_scratch_ptr() -> *const f32 {
    render_airborne_emitter_scratch().input.as_ptr()
}

#[wasm_bindgen]
pub fn render_airborne_emitter_output_scratch_ptr() -> *const f32 {
    render_airborne_emitter_scratch().output.as_ptr()
}

#[wasm_bindgen]
pub fn render_airborne_emitter_scratch_ensure(count: u32) {
    let s = render_airborne_emitter_scratch();
    let input_needed = (count as usize) * RENDER_AIRBORNE_EMITTER_INPUT_STRIDE;
    if s.input.len() < input_needed {
        s.input.resize(input_needed, 0.0);
    }
    let output_needed = (count as usize) * RENDER_AIRBORNE_EMITTER_OUTPUT_STRIDE;
    if s.output.len() < output_needed {
        s.output.resize(output_needed, 0.0);
    }
}

#[wasm_bindgen]
pub fn render_airborne_emitter_compute(count: u32) {
    let s = render_airborne_emitter_scratch();
    let count_usize = count as usize;
    debug_assert!(s.input.len() >= count_usize * RENDER_AIRBORNE_EMITTER_INPUT_STRIDE);
    debug_assert!(s.output.len() >= count_usize * RENDER_AIRBORNE_EMITTER_OUTPUT_STRIDE);

    for i in 0..count_usize {
        let ib = i * RENDER_AIRBORNE_EMITTER_INPUT_STRIDE;
        let ob = i * RENDER_AIRBORNE_EMITTER_OUTPUT_STRIDE;
        let parent_pos = [
            s.input[ib] as f64,
            s.input[ib + 1] as f64,
            s.input[ib + 2] as f64,
        ];
        let parent_q = [
            s.input[ib + 3] as f64,
            s.input[ib + 4] as f64,
            s.input[ib + 5] as f64,
            s.input[ib + 6] as f64,
        ];
        let group_pos = [
            s.input[ib + 7] as f64,
            s.input[ib + 8] as f64,
            s.input[ib + 9] as f64,
        ];
        let child_pos = [
            s.input[ib + 10] as f64,
            s.input[ib + 11] as f64,
            s.input[ib + 12] as f64,
        ];
        let child_q = [
            s.input[ib + 13] as f64,
            s.input[ib + 14] as f64,
            s.input[ib + 15] as f64,
            s.input[ib + 16] as f64,
        ];
        let emitter_pos = [
            s.input[ib + 17] as f64,
            s.input[ib + 18] as f64,
            s.input[ib + 19] as f64,
        ];
        let exhaust_dir = [
            s.input[ib + 20] as f64,
            s.input[ib + 21] as f64,
            s.input[ib + 22] as f64,
        ];
        let exhaust_speed = s.input[ib + 23] as f64;

        let group_world_pos = render_compose_child_offset(parent_q, parent_pos, group_pos);
        let child_world_pos = render_compose_child_offset(parent_q, group_world_pos, child_pos);
        let child_world_q = quat_mul(parent_q, child_q);
        let emitter_world_pos =
            render_compose_child_offset(child_world_q, child_world_pos, emitter_pos);
        let world_dir = quat_rotate_vec(child_world_q, exhaust_dir);

        s.output[ob] = emitter_world_pos[0] as f32;
        s.output[ob + 1] = emitter_world_pos[2] as f32;
        s.output[ob + 2] = emitter_world_pos[1] as f32;
        s.output[ob + 3] = (world_dir[0] * exhaust_speed) as f32;
        s.output[ob + 4] = (world_dir[2] * exhaust_speed) as f32;
        s.output[ob + 5] = (world_dir[1] * exhaust_speed) as f32;
    }
}

// ─────────────────────────────────────────────────────────────────
//  Render pose helper — building group + body matrices
//
//  Each row writes:
//    group: T(sim.x, baseY, sim.y) · Ry(-simRotation)
//    body:  T(0, height / 2, 0) · S(width, height, footprintDepth)
//
//  Output uses Three.js Matrix4 column-major layout. Bodyless render
//  profiles receive an identity body matrix; visibility still lives in
//  the TS renderer because it is lifecycle/material orchestration.
// ─────────────────────────────────────────────────────────────────

pub const RENDER_BUILDING_POSE_INPUT_STRIDE: usize = 8;
pub const RENDER_BUILDING_POSE_OUTPUT_STRIDE: usize = 32;

pub(crate) struct RenderBuildingPoseScratch {
    input: Vec<f32>,
    output: Vec<f32>,
}

pub(crate) struct RenderBuildingPoseScratchHolder(UnsafeCell<Option<RenderBuildingPoseScratch>>);
unsafe impl Sync for RenderBuildingPoseScratchHolder {}
pub(crate) static RENDER_BUILDING_POSE_SCRATCH: RenderBuildingPoseScratchHolder =
    RenderBuildingPoseScratchHolder(UnsafeCell::new(None));

#[inline]
pub(crate) fn render_building_pose_scratch() -> &'static mut RenderBuildingPoseScratch {
    unsafe {
        let cell = &mut *RENDER_BUILDING_POSE_SCRATCH.0.get();
        if cell.is_none() {
            *cell = Some(RenderBuildingPoseScratch {
                input: vec![0.0; RENDER_BUILDING_POSE_INPUT_STRIDE * 512],
                output: vec![0.0; RENDER_BUILDING_POSE_OUTPUT_STRIDE * 512],
            });
        }
        cell.as_mut().unwrap()
    }
}

#[wasm_bindgen]
pub fn render_building_pose_input_scratch_ptr() -> *const f32 {
    render_building_pose_scratch().input.as_ptr()
}

#[wasm_bindgen]
pub fn render_building_pose_output_scratch_ptr() -> *const f32 {
    render_building_pose_scratch().output.as_ptr()
}

#[wasm_bindgen]
pub fn render_building_pose_scratch_ensure(count: u32) {
    let s = render_building_pose_scratch();
    let input_needed = (count as usize) * RENDER_BUILDING_POSE_INPUT_STRIDE;
    if s.input.len() < input_needed {
        s.input.resize(input_needed, 0.0);
    }
    let output_needed = (count as usize) * RENDER_BUILDING_POSE_OUTPUT_STRIDE;
    if s.output.len() < output_needed {
        s.output.resize(output_needed, 0.0);
    }
}

#[inline]
pub(crate) fn render_write_building_group_matrix(
    out: &mut [f32],
    offset: usize,
    x: f64,
    sim_y: f64,
    base_y: f64,
    sim_rotation: f64,
) {
    let yaw = -sim_rotation;
    let c = yaw.cos() as f32;
    let s = yaw.sin() as f32;
    out[offset] = c;
    out[offset + 1] = 0.0;
    out[offset + 2] = -s;
    out[offset + 3] = 0.0;
    out[offset + 4] = 0.0;
    out[offset + 5] = 1.0;
    out[offset + 6] = 0.0;
    out[offset + 7] = 0.0;
    out[offset + 8] = s;
    out[offset + 9] = 0.0;
    out[offset + 10] = c;
    out[offset + 11] = 0.0;
    out[offset + 12] = x as f32;
    out[offset + 13] = base_y as f32;
    out[offset + 14] = sim_y as f32;
    out[offset + 15] = 1.0;
}

#[inline]
pub(crate) fn render_write_building_body_matrix(
    out: &mut [f32],
    offset: usize,
    width: f64,
    height: f64,
    depth: f64,
    bodyless: bool,
) {
    let sx = (if bodyless { 1.0 } else { width }) as f32;
    let sy = (if bodyless { 1.0 } else { height }) as f32;
    let sz = (if bodyless { 1.0 } else { depth }) as f32;
    out[offset] = sx;
    out[offset + 1] = 0.0;
    out[offset + 2] = 0.0;
    out[offset + 3] = 0.0;
    out[offset + 4] = 0.0;
    out[offset + 5] = sy;
    out[offset + 6] = 0.0;
    out[offset + 7] = 0.0;
    out[offset + 8] = 0.0;
    out[offset + 9] = 0.0;
    out[offset + 10] = sz;
    out[offset + 11] = 0.0;
    out[offset + 12] = 0.0;
    out[offset + 13] = if bodyless { 0.0 } else { (height * 0.5) as f32 };
    out[offset + 14] = 0.0;
    out[offset + 15] = 1.0;
}

#[wasm_bindgen]
pub fn render_building_pose_compute(count: u32) {
    let s = render_building_pose_scratch();
    let count_usize = count as usize;
    debug_assert!(s.input.len() >= count_usize * RENDER_BUILDING_POSE_INPUT_STRIDE);
    debug_assert!(s.output.len() >= count_usize * RENDER_BUILDING_POSE_OUTPUT_STRIDE);

    for i in 0..count_usize {
        let ib = i * RENDER_BUILDING_POSE_INPUT_STRIDE;
        let ob = i * RENDER_BUILDING_POSE_OUTPUT_STRIDE;
        render_write_building_group_matrix(
            &mut s.output,
            ob,
            s.input[ib] as f64,
            s.input[ib + 1] as f64,
            s.input[ib + 2] as f64,
            s.input[ib + 3] as f64,
        );
        render_write_building_body_matrix(
            &mut s.output,
            ob + 16,
            s.input[ib + 4] as f64,
            s.input[ib + 5] as f64,
            s.input[ib + 6] as f64,
            s.input[ib + 7] != 0.0,
        );
    }
}

// ─────────────────────────────────────────────────────────────────
//  Render pose helper — unit chassis part matrices
//
//  Each row composes the already-smoothed unit parent transform with one
//  chassis-local body part:
//    T(parentPos) · R(parentQuat) · S(radius) · T(partPos)
//    · Rz(partRotZ) · S(partScale)
//
//  Output uses Three.js Matrix4/InstancedMesh column-major layout.
// ─────────────────────────────────────────────────────────────────

pub const RENDER_CHASSIS_PART_INPUT_STRIDE: usize = 15;
pub const RENDER_CHASSIS_PART_OUTPUT_STRIDE: usize = 16;

pub(crate) struct RenderChassisPartScratch {
    input: Vec<f32>,
    output: Vec<f32>,
}

pub(crate) struct RenderChassisPartScratchHolder(UnsafeCell<Option<RenderChassisPartScratch>>);
unsafe impl Sync for RenderChassisPartScratchHolder {}
pub(crate) static RENDER_CHASSIS_PART_SCRATCH: RenderChassisPartScratchHolder =
    RenderChassisPartScratchHolder(UnsafeCell::new(None));

#[inline]
pub(crate) fn render_chassis_part_scratch() -> &'static mut RenderChassisPartScratch {
    unsafe {
        let cell = &mut *RENDER_CHASSIS_PART_SCRATCH.0.get();
        if cell.is_none() {
            *cell = Some(RenderChassisPartScratch {
                input: vec![0.0; RENDER_CHASSIS_PART_INPUT_STRIDE * 1024],
                output: vec![0.0; RENDER_CHASSIS_PART_OUTPUT_STRIDE * 1024],
            });
        }
        cell.as_mut().unwrap()
    }
}

#[wasm_bindgen]
pub fn render_chassis_part_input_scratch_ptr() -> *const f32 {
    render_chassis_part_scratch().input.as_ptr()
}

#[wasm_bindgen]
pub fn render_chassis_part_output_scratch_ptr() -> *const f32 {
    render_chassis_part_scratch().output.as_ptr()
}

#[wasm_bindgen]
pub fn render_chassis_part_scratch_ensure(count: u32) {
    let s = render_chassis_part_scratch();
    let input_needed = (count as usize) * RENDER_CHASSIS_PART_INPUT_STRIDE;
    if s.input.len() < input_needed {
        s.input.resize(input_needed, 0.0);
    }
    let output_needed = (count as usize) * RENDER_CHASSIS_PART_OUTPUT_STRIDE;
    if s.output.len() < output_needed {
        s.output.resize(output_needed, 0.0);
    }
}

#[inline]
pub(crate) fn render_write_chassis_part_matrix(
    out: &mut [f32],
    offset: usize,
    parent_pos: [f64; 3],
    parent_q: [f64; 4],
    radius: f64,
    part_pos: [f64; 3],
    part_scale: [f64; 3],
    part_rot_z: f64,
) {
    let x = parent_q[0];
    let y = parent_q[1];
    let z = parent_q[2];
    let w = parent_q[3];
    let x2 = x + x;
    let y2 = y + y;
    let z2 = z + z;
    let xx = x * x2;
    let xy = x * y2;
    let xz = x * z2;
    let yy = y * y2;
    let yz = y * z2;
    let zz = z * z2;
    let wx = w * x2;
    let wy = w * y2;
    let wz = w * z2;

    // Parent linear basis columns: R(parentQuat) · uniform radius.
    let p0x = (1.0 - (yy + zz)) * radius;
    let p0y = (xy + wz) * radius;
    let p0z = (xz - wy) * radius;
    let p1x = (xy - wz) * radius;
    let p1y = (1.0 - (xx + zz)) * radius;
    let p1z = (yz + wx) * radius;
    let p2x = (xz + wy) * radius;
    let p2y = (yz - wx) * radius;
    let p2z = (1.0 - (xx + yy)) * radius;

    let c = part_rot_z.cos();
    let s = part_rot_z.sin();
    let sx = part_scale[0];
    let sy = part_scale[1];
    let sz = part_scale[2];

    // Local part rotation around +Z, then per-axis scale.
    out[offset] = ((p0x * c + p1x * s) * sx) as f32;
    out[offset + 1] = ((p0y * c + p1y * s) * sx) as f32;
    out[offset + 2] = ((p0z * c + p1z * s) * sx) as f32;
    out[offset + 3] = 0.0;
    out[offset + 4] = ((-p0x * s + p1x * c) * sy) as f32;
    out[offset + 5] = ((-p0y * s + p1y * c) * sy) as f32;
    out[offset + 6] = ((-p0z * s + p1z * c) * sy) as f32;
    out[offset + 7] = 0.0;
    out[offset + 8] = (p2x * sz) as f32;
    out[offset + 9] = (p2y * sz) as f32;
    out[offset + 10] = (p2z * sz) as f32;
    out[offset + 11] = 0.0;
    out[offset + 12] =
        (parent_pos[0] + p0x * part_pos[0] + p1x * part_pos[1] + p2x * part_pos[2]) as f32;
    out[offset + 13] =
        (parent_pos[1] + p0y * part_pos[0] + p1y * part_pos[1] + p2y * part_pos[2]) as f32;
    out[offset + 14] =
        (parent_pos[2] + p0z * part_pos[0] + p1z * part_pos[1] + p2z * part_pos[2]) as f32;
    out[offset + 15] = 1.0;
}

#[wasm_bindgen]
pub fn render_chassis_part_compute(count: u32) {
    let s = render_chassis_part_scratch();
    let count_usize = count as usize;
    debug_assert!(s.input.len() >= count_usize * RENDER_CHASSIS_PART_INPUT_STRIDE);
    debug_assert!(s.output.len() >= count_usize * RENDER_CHASSIS_PART_OUTPUT_STRIDE);

    for i in 0..count_usize {
        let ib = i * RENDER_CHASSIS_PART_INPUT_STRIDE;
        let ob = i * RENDER_CHASSIS_PART_OUTPUT_STRIDE;
        let parent_pos = [
            s.input[ib] as f64,
            s.input[ib + 1] as f64,
            s.input[ib + 2] as f64,
        ];
        let parent_q = [
            s.input[ib + 3] as f64,
            s.input[ib + 4] as f64,
            s.input[ib + 5] as f64,
            s.input[ib + 6] as f64,
        ];
        let radius = s.input[ib + 7] as f64;
        let part_pos = [
            s.input[ib + 8] as f64,
            s.input[ib + 9] as f64,
            s.input[ib + 10] as f64,
        ];
        let part_scale = [
            s.input[ib + 11] as f64,
            s.input[ib + 12] as f64,
            s.input[ib + 13] as f64,
        ];
        let part_rot_z = s.input[ib + 14] as f64;
        render_write_chassis_part_matrix(
            &mut s.output,
            ob,
            parent_pos,
            parent_q,
            radius,
            part_pos,
            part_scale,
            part_rot_z,
        );
    }
}

// ─────────────────────────────────────────────────────────────────
//  Render pose helper — unit shield-panel slab matrices
//
//  Each row composes:
//    T(parentPos) · R(parentQuat) · T(rootPos) · R(rootQuat)
//    · T(panelPos) · R(panelQuat) · S(panelScale)
//
//  Root still exists on the JS scenegraph for the small per-mesh
//  support arms; this kernel only writes the shared panel InstancedMesh
//  slab matrices.
// ─────────────────────────────────────────────────────────────────

pub const RENDER_SHIELD_PANEL_INPUT_STRIDE: usize = 24;
pub const RENDER_SHIELD_PANEL_OUTPUT_STRIDE: usize = 16;

pub(crate) struct RenderShieldPanelScratch {
    input: Vec<f32>,
    output: Vec<f32>,
}

pub(crate) struct RenderShieldPanelScratchHolder(UnsafeCell<Option<RenderShieldPanelScratch>>);
unsafe impl Sync for RenderShieldPanelScratchHolder {}
pub(crate) static RENDER_SHIELD_PANEL_SCRATCH: RenderShieldPanelScratchHolder =
    RenderShieldPanelScratchHolder(UnsafeCell::new(None));

#[inline]
pub(crate) fn render_shield_panel_scratch() -> &'static mut RenderShieldPanelScratch {
    unsafe {
        let cell = &mut *RENDER_SHIELD_PANEL_SCRATCH.0.get();
        if cell.is_none() {
            *cell = Some(RenderShieldPanelScratch {
                input: vec![0.0; RENDER_SHIELD_PANEL_INPUT_STRIDE * 256],
                output: vec![0.0; RENDER_SHIELD_PANEL_OUTPUT_STRIDE * 256],
            });
        }
        cell.as_mut().unwrap()
    }
}

#[wasm_bindgen]
pub fn render_shield_panel_input_scratch_ptr() -> *const f32 {
    render_shield_panel_scratch().input.as_ptr()
}

#[wasm_bindgen]
pub fn render_shield_panel_output_scratch_ptr() -> *const f32 {
    render_shield_panel_scratch().output.as_ptr()
}

#[wasm_bindgen]
pub fn render_shield_panel_scratch_ensure(count: u32) {
    let s = render_shield_panel_scratch();
    let input_needed = (count as usize) * RENDER_SHIELD_PANEL_INPUT_STRIDE;
    if s.input.len() < input_needed {
        s.input.resize(input_needed, 0.0);
    }
    let output_needed = (count as usize) * RENDER_SHIELD_PANEL_OUTPUT_STRIDE;
    if s.output.len() < output_needed {
        s.output.resize(output_needed, 0.0);
    }
}

#[inline]
pub(crate) fn render_write_mat4_compose_scaled(
    out: &mut [f32],
    offset: usize,
    pos: [f64; 3],
    q: [f64; 4],
    scale: [f64; 3],
) {
    let x = q[0];
    let y = q[1];
    let z = q[2];
    let w = q[3];
    let x2 = x + x;
    let y2 = y + y;
    let z2 = z + z;
    let xx = x * x2;
    let xy = x * y2;
    let xz = x * z2;
    let yy = y * y2;
    let yz = y * z2;
    let zz = z * z2;
    let wx = w * x2;
    let wy = w * y2;
    let wz = w * z2;
    let sx = scale[0];
    let sy = scale[1];
    let sz = scale[2];

    out[offset] = ((1.0 - (yy + zz)) * sx) as f32;
    out[offset + 1] = ((xy + wz) * sx) as f32;
    out[offset + 2] = ((xz - wy) * sx) as f32;
    out[offset + 3] = 0.0;
    out[offset + 4] = ((xy - wz) * sy) as f32;
    out[offset + 5] = ((1.0 - (xx + zz)) * sy) as f32;
    out[offset + 6] = ((yz + wx) * sy) as f32;
    out[offset + 7] = 0.0;
    out[offset + 8] = ((xz + wy) * sz) as f32;
    out[offset + 9] = ((yz - wx) * sz) as f32;
    out[offset + 10] = ((1.0 - (xx + yy)) * sz) as f32;
    out[offset + 11] = 0.0;
    out[offset + 12] = pos[0] as f32;
    out[offset + 13] = pos[1] as f32;
    out[offset + 14] = pos[2] as f32;
    out[offset + 15] = 1.0;
}

#[wasm_bindgen]
pub fn render_shield_panel_compute(count: u32) {
    let s = render_shield_panel_scratch();
    let count_usize = count as usize;
    debug_assert!(s.input.len() >= count_usize * RENDER_SHIELD_PANEL_INPUT_STRIDE);
    debug_assert!(s.output.len() >= count_usize * RENDER_SHIELD_PANEL_OUTPUT_STRIDE);

    for i in 0..count_usize {
        let ib = i * RENDER_SHIELD_PANEL_INPUT_STRIDE;
        let ob = i * RENDER_SHIELD_PANEL_OUTPUT_STRIDE;
        let parent_pos = [
            s.input[ib] as f64,
            s.input[ib + 1] as f64,
            s.input[ib + 2] as f64,
        ];
        let parent_q = [
            s.input[ib + 3] as f64,
            s.input[ib + 4] as f64,
            s.input[ib + 5] as f64,
            s.input[ib + 6] as f64,
        ];
        let root_pos = [
            s.input[ib + 7] as f64,
            s.input[ib + 8] as f64,
            s.input[ib + 9] as f64,
        ];
        let root_q = [
            s.input[ib + 10] as f64,
            s.input[ib + 11] as f64,
            s.input[ib + 12] as f64,
            s.input[ib + 13] as f64,
        ];
        let panel_pos = [
            s.input[ib + 14] as f64,
            s.input[ib + 15] as f64,
            s.input[ib + 16] as f64,
        ];
        let panel_q = [
            s.input[ib + 17] as f64,
            s.input[ib + 18] as f64,
            s.input[ib + 19] as f64,
            s.input[ib + 20] as f64,
        ];
        let panel_scale = [
            s.input[ib + 21] as f64,
            s.input[ib + 22] as f64,
            s.input[ib + 23] as f64,
        ];
        let root_panel_offset = quat_rotate_vec(root_q, panel_pos);
        let local_pos = [
            root_pos[0] + root_panel_offset[0],
            root_pos[1] + root_panel_offset[1],
            root_pos[2] + root_panel_offset[2],
        ];
        let world_offset = quat_rotate_vec(parent_q, local_pos);
        let world_pos = [
            parent_pos[0] + world_offset[0],
            parent_pos[1] + world_offset[1],
            parent_pos[2] + world_offset[2],
        ];
        let world_q = quat_mul(quat_mul(parent_q, root_q), panel_q);
        render_write_mat4_compose_scaled(&mut s.output, ob, world_pos, world_q, panel_scale);
    }
}

// ─────────────────────────────────────────────────────────────────
//  Render pose helper — unit turret barrel matrices
//
//  Each row composes:
//    T(parentPos) · R(parentQuat) · T(rootPos) · R(rootQuat)
//    · T(pitchPos) · R(pitchQuat) · T(spinPos) · R(spinQuat)
//    · T(barrelPos) · R(barrelQuat) · S(barrelScale)
//
//  TS still owns the semantic aim state; this kernel only turns the
//  already-written rig transforms into InstancedMesh matrices.
// ─────────────────────────────────────────────────────────────────

pub const RENDER_TURRET_BARREL_INPUT_STRIDE: usize = 38;
pub const RENDER_TURRET_BARREL_OUTPUT_STRIDE: usize = 16;

pub(crate) struct RenderTurretBarrelScratch {
    input: Vec<f32>,
    output: Vec<f32>,
}

pub(crate) struct RenderTurretBarrelScratchHolder(UnsafeCell<Option<RenderTurretBarrelScratch>>);
unsafe impl Sync for RenderTurretBarrelScratchHolder {}
pub(crate) static RENDER_TURRET_BARREL_SCRATCH: RenderTurretBarrelScratchHolder =
    RenderTurretBarrelScratchHolder(UnsafeCell::new(None));

#[inline]
pub(crate) fn render_turret_barrel_scratch() -> &'static mut RenderTurretBarrelScratch {
    unsafe {
        let cell = &mut *RENDER_TURRET_BARREL_SCRATCH.0.get();
        if cell.is_none() {
            *cell = Some(RenderTurretBarrelScratch {
                input: vec![0.0; RENDER_TURRET_BARREL_INPUT_STRIDE * 2048],
                output: vec![0.0; RENDER_TURRET_BARREL_OUTPUT_STRIDE * 2048],
            });
        }
        cell.as_mut().unwrap()
    }
}

#[wasm_bindgen]
pub fn render_turret_barrel_input_scratch_ptr() -> *const f32 {
    render_turret_barrel_scratch().input.as_ptr()
}

#[wasm_bindgen]
pub fn render_turret_barrel_output_scratch_ptr() -> *const f32 {
    render_turret_barrel_scratch().output.as_ptr()
}

#[wasm_bindgen]
pub fn render_turret_barrel_scratch_ensure(count: u32) {
    let s = render_turret_barrel_scratch();
    let input_needed = (count as usize) * RENDER_TURRET_BARREL_INPUT_STRIDE;
    if s.input.len() < input_needed {
        s.input.resize(input_needed, 0.0);
    }
    let output_needed = (count as usize) * RENDER_TURRET_BARREL_OUTPUT_STRIDE;
    if s.output.len() < output_needed {
        s.output.resize(output_needed, 0.0);
    }
}

#[inline]
pub(crate) fn render_compose_child_offset(
    parent_q: [f64; 4],
    parent_pos: [f64; 3],
    child_pos: [f64; 3],
) -> [f64; 3] {
    let rotated = quat_rotate_vec(parent_q, child_pos);
    [
        parent_pos[0] + rotated[0],
        parent_pos[1] + rotated[1],
        parent_pos[2] + rotated[2],
    ]
}

#[wasm_bindgen]
pub fn render_turret_barrel_compute(count: u32) {
    let s = render_turret_barrel_scratch();
    let count_usize = count as usize;
    debug_assert!(s.input.len() >= count_usize * RENDER_TURRET_BARREL_INPUT_STRIDE);
    debug_assert!(s.output.len() >= count_usize * RENDER_TURRET_BARREL_OUTPUT_STRIDE);

    for i in 0..count_usize {
        let ib = i * RENDER_TURRET_BARREL_INPUT_STRIDE;
        let ob = i * RENDER_TURRET_BARREL_OUTPUT_STRIDE;
        let parent_pos = [
            s.input[ib] as f64,
            s.input[ib + 1] as f64,
            s.input[ib + 2] as f64,
        ];
        let parent_q = [
            s.input[ib + 3] as f64,
            s.input[ib + 4] as f64,
            s.input[ib + 5] as f64,
            s.input[ib + 6] as f64,
        ];
        let root_pos = [
            s.input[ib + 7] as f64,
            s.input[ib + 8] as f64,
            s.input[ib + 9] as f64,
        ];
        let root_q = [
            s.input[ib + 10] as f64,
            s.input[ib + 11] as f64,
            s.input[ib + 12] as f64,
            s.input[ib + 13] as f64,
        ];
        let pitch_pos = [
            s.input[ib + 14] as f64,
            s.input[ib + 15] as f64,
            s.input[ib + 16] as f64,
        ];
        let pitch_q = [
            s.input[ib + 17] as f64,
            s.input[ib + 18] as f64,
            s.input[ib + 19] as f64,
            s.input[ib + 20] as f64,
        ];
        let spin_pos = [
            s.input[ib + 21] as f64,
            s.input[ib + 22] as f64,
            s.input[ib + 23] as f64,
        ];
        let spin_q = [
            s.input[ib + 24] as f64,
            s.input[ib + 25] as f64,
            s.input[ib + 26] as f64,
            s.input[ib + 27] as f64,
        ];
        let barrel_pos = [
            s.input[ib + 28] as f64,
            s.input[ib + 29] as f64,
            s.input[ib + 30] as f64,
        ];
        let barrel_q = [
            s.input[ib + 31] as f64,
            s.input[ib + 32] as f64,
            s.input[ib + 33] as f64,
            s.input[ib + 34] as f64,
        ];
        let barrel_scale = [
            s.input[ib + 35] as f64,
            s.input[ib + 36] as f64,
            s.input[ib + 37] as f64,
        ];

        let root_world_pos = render_compose_child_offset(parent_q, parent_pos, root_pos);
        let root_world_q = quat_mul(parent_q, root_q);
        let pitch_world_pos = render_compose_child_offset(root_world_q, root_world_pos, pitch_pos);
        let pitch_world_q = quat_mul(root_world_q, pitch_q);
        let spin_world_pos = render_compose_child_offset(pitch_world_q, pitch_world_pos, spin_pos);
        let spin_world_q = quat_mul(pitch_world_q, spin_q);
        let barrel_world_pos =
            render_compose_child_offset(spin_world_q, spin_world_pos, barrel_pos);
        let barrel_world_q = quat_mul(spin_world_q, barrel_q);

        render_write_mat4_compose_scaled(
            &mut s.output,
            ob,
            barrel_world_pos,
            barrel_world_q,
            barrel_scale,
        );
    }
}

// ─────────────────────────────────────────────────────────────────
//  Render pose helper — unit turret head/mount matrices
//
//  Each row composes the visible turret mount center:
//    parentPos + R(parentQuat) · (rootPos + (0, headRadius, 0))
//
//  The output is the head sphere's scale matrix with that translation;
//  TS also reads translation columns 12..14 back into TurretMountCache3D.
// ─────────────────────────────────────────────────────────────────

pub const RENDER_TURRET_HEAD_INPUT_STRIDE: usize = 11;
pub const RENDER_TURRET_HEAD_OUTPUT_STRIDE: usize = 16;

pub(crate) struct RenderTurretHeadScratch {
    input: Vec<f32>,
    output: Vec<f32>,
}

pub(crate) struct RenderTurretHeadScratchHolder(UnsafeCell<Option<RenderTurretHeadScratch>>);
unsafe impl Sync for RenderTurretHeadScratchHolder {}
pub(crate) static RENDER_TURRET_HEAD_SCRATCH: RenderTurretHeadScratchHolder =
    RenderTurretHeadScratchHolder(UnsafeCell::new(None));

#[inline]
pub(crate) fn render_turret_head_scratch() -> &'static mut RenderTurretHeadScratch {
    unsafe {
        let cell = &mut *RENDER_TURRET_HEAD_SCRATCH.0.get();
        if cell.is_none() {
            *cell = Some(RenderTurretHeadScratch {
                input: vec![0.0; RENDER_TURRET_HEAD_INPUT_STRIDE * 2048],
                output: vec![0.0; RENDER_TURRET_HEAD_OUTPUT_STRIDE * 2048],
            });
        }
        cell.as_mut().unwrap()
    }
}

#[wasm_bindgen]
pub fn render_turret_head_input_scratch_ptr() -> *const f32 {
    render_turret_head_scratch().input.as_ptr()
}

#[wasm_bindgen]
pub fn render_turret_head_output_scratch_ptr() -> *const f32 {
    render_turret_head_scratch().output.as_ptr()
}

#[wasm_bindgen]
pub fn render_turret_head_scratch_ensure(count: u32) {
    let s = render_turret_head_scratch();
    let input_needed = (count as usize) * RENDER_TURRET_HEAD_INPUT_STRIDE;
    if s.input.len() < input_needed {
        s.input.resize(input_needed, 0.0);
    }
    let output_needed = (count as usize) * RENDER_TURRET_HEAD_OUTPUT_STRIDE;
    if s.output.len() < output_needed {
        s.output.resize(output_needed, 0.0);
    }
}

#[wasm_bindgen]
pub fn render_turret_head_compute(count: u32) {
    let s = render_turret_head_scratch();
    let count_usize = count as usize;
    debug_assert!(s.input.len() >= count_usize * RENDER_TURRET_HEAD_INPUT_STRIDE);
    debug_assert!(s.output.len() >= count_usize * RENDER_TURRET_HEAD_OUTPUT_STRIDE);

    for i in 0..count_usize {
        let ib = i * RENDER_TURRET_HEAD_INPUT_STRIDE;
        let ob = i * RENDER_TURRET_HEAD_OUTPUT_STRIDE;
        let parent_pos = [
            s.input[ib] as f64,
            s.input[ib + 1] as f64,
            s.input[ib + 2] as f64,
        ];
        let parent_q = [
            s.input[ib + 3] as f64,
            s.input[ib + 4] as f64,
            s.input[ib + 5] as f64,
            s.input[ib + 6] as f64,
        ];
        let head_radius = s.input[ib + 10] as f64;
        let local_center = [
            s.input[ib + 7] as f64,
            s.input[ib + 8] as f64 + head_radius,
            s.input[ib + 9] as f64,
        ];
        let center = render_compose_child_offset(parent_q, parent_pos, local_center);

        s.output[ob] = head_radius as f32;
        s.output[ob + 1] = 0.0;
        s.output[ob + 2] = 0.0;
        s.output[ob + 3] = 0.0;
        s.output[ob + 4] = 0.0;
        s.output[ob + 5] = head_radius as f32;
        s.output[ob + 6] = 0.0;
        s.output[ob + 7] = 0.0;
        s.output[ob + 8] = 0.0;
        s.output[ob + 9] = 0.0;
        s.output[ob + 10] = head_radius as f32;
        s.output[ob + 11] = 0.0;
        s.output[ob + 12] = center[0] as f32;
        s.output[ob + 13] = center[1] as f32;
        s.output[ob + 14] = center[2] as f32;
        s.output[ob + 15] = 1.0;
    }
}

// ─────────────────────────────────────────────────────────────────
//  Render pose helper — unit turret aim/root pose
//
//  Converts the sim aim into the local turret rig's root yaw and pitch.
//  Mode 0 reads turret rotation/pitch. Mode 1 reads a world direction
//  vector first, matching applyTurretAimWorldDir3D's beam path.
// ─────────────────────────────────────────────────────────────────

pub const RENDER_TURRET_AIM_INPUT_STRIDE: usize = 12;
pub const RENDER_TURRET_AIM_OUTPUT_STRIDE: usize = 2;
pub(crate) const RENDER_TURRET_AIM_MODE_WORLD_DIR: f32 = 1.0;

pub(crate) struct RenderTurretAimScratch {
    input: Vec<f32>,
    output: Vec<f32>,
}

pub(crate) struct RenderTurretAimScratchHolder(UnsafeCell<Option<RenderTurretAimScratch>>);
unsafe impl Sync for RenderTurretAimScratchHolder {}
pub(crate) static RENDER_TURRET_AIM_SCRATCH: RenderTurretAimScratchHolder =
    RenderTurretAimScratchHolder(UnsafeCell::new(None));

#[inline]
pub(crate) fn render_turret_aim_scratch() -> &'static mut RenderTurretAimScratch {
    unsafe {
        let cell = &mut *RENDER_TURRET_AIM_SCRATCH.0.get();
        if cell.is_none() {
            *cell = Some(RenderTurretAimScratch {
                input: vec![0.0; RENDER_TURRET_AIM_INPUT_STRIDE * 2048],
                output: vec![0.0; RENDER_TURRET_AIM_OUTPUT_STRIDE * 2048],
            });
        }
        cell.as_mut().unwrap()
    }
}

#[wasm_bindgen]
pub fn render_turret_aim_input_scratch_ptr() -> *const f32 {
    render_turret_aim_scratch().input.as_ptr()
}

#[wasm_bindgen]
pub fn render_turret_aim_output_scratch_ptr() -> *const f32 {
    render_turret_aim_scratch().output.as_ptr()
}

#[wasm_bindgen]
pub fn render_turret_aim_scratch_ensure(count: u32) {
    let s = render_turret_aim_scratch();
    let input_needed = (count as usize) * RENDER_TURRET_AIM_INPUT_STRIDE;
    if s.input.len() < input_needed {
        s.input.resize(input_needed, 0.0);
    }
    let output_needed = (count as usize) * RENDER_TURRET_AIM_OUTPUT_STRIDE;
    if s.output.len() < output_needed {
        s.output.resize(output_needed, 0.0);
    }
}

#[wasm_bindgen]
pub fn render_turret_aim_compute(count: u32) {
    let s = render_turret_aim_scratch();
    let count_usize = count as usize;
    debug_assert!(s.input.len() >= count_usize * RENDER_TURRET_AIM_INPUT_STRIDE);
    debug_assert!(s.output.len() >= count_usize * RENDER_TURRET_AIM_OUTPUT_STRIDE);

    for i in 0..count_usize {
        let ib = i * RENDER_TURRET_AIM_INPUT_STRIDE;
        let ob = i * RENDER_TURRET_AIM_OUTPUT_STRIDE;
        let host_rotation = s.input[ib] as f64;
        let mode = s.input[ib + 1];
        let (aim_rotation, aim_pitch) = if mode == RENDER_TURRET_AIM_MODE_WORLD_DIR {
            let dir_x = s.input[ib + 4] as f64;
            let dir_y = s.input[ib + 5] as f64;
            let dir_z = s.input[ib + 6] as f64;
            (
                dir_y.atan2(dir_x),
                dir_z.atan2((dir_x * dir_x + dir_y * dir_y).sqrt()),
            )
        } else {
            (s.input[ib + 2] as f64, s.input[ib + 3] as f64)
        };

        let cos_rot = aim_rotation.cos();
        let sin_rot = aim_rotation.sin();
        let cos_pitch = aim_pitch.cos();
        let sin_pitch = aim_pitch.sin();
        let mut aim_dir = [cos_rot * cos_pitch, sin_pitch, sin_rot * cos_pitch];
        if s.input[ib + 11] != 0.0 {
            let inv_tilt = [
                s.input[ib + 7] as f64,
                s.input[ib + 8] as f64,
                s.input[ib + 9] as f64,
                s.input[ib + 10] as f64,
            ];
            aim_dir = quat_rotate_vec(inv_tilt, aim_dir);
        }

        let combined_yaw = (-aim_dir[2]).atan2(aim_dir[0]);
        let y = if aim_dir[1] < -1.0 {
            -1.0
        } else if aim_dir[1] > 1.0 {
            1.0
        } else {
            aim_dir[1]
        };
        s.output[ob] = (combined_yaw + host_rotation) as f32;
        s.output[ob + 1] = y.asin() as f32;
    }
}


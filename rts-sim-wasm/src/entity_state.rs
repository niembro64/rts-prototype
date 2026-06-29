// entity_state — canonical slot-indexed entity SoA slab.

#[allow(unused_imports)]
use crate::*;
#[allow(unused_imports)]
use wasm_bindgen::prelude::*;

pub(crate) const ENTITY_STATE_KIND_NONE: u8 = 0;
#[allow(dead_code)]
pub(crate) const ENTITY_STATE_KIND_BUILDING: u8 = 1;
#[allow(dead_code)]
pub(crate) const ENTITY_STATE_KIND_UNIT: u8 = 2;
#[allow(dead_code)]
pub(crate) const ENTITY_STATE_KIND_TOWER: u8 = 3;
pub(crate) const ENTITY_STATE_KIND_SHOT: u8 = 4;

pub(crate) const ENTITY_STATE_BLUEPRINT_NONE: u32 = 0xff;
pub(crate) const ENTITY_STATE_NO_BODY_SLOT: i32 = -1;
pub(crate) const ENTITY_STATE_NO_ENTITY_ID: i32 = -1;

pub(crate) struct EntityStateSlab {
    pub(crate) entity_id: Vec<i32>,
    pub(crate) kind: Vec<u8>,
    pub(crate) flags: Vec<u32>,
    pub(crate) owner_player_id: Vec<u32>,
    pub(crate) team_id: Vec<u32>,
    pub(crate) pos_x: Vec<f64>,
    pub(crate) pos_y: Vec<f64>,
    pub(crate) pos_z: Vec<f64>,
    pub(crate) rotation: Vec<f64>,
    pub(crate) vel_x: Vec<f64>,
    pub(crate) vel_y: Vec<f64>,
    pub(crate) vel_z: Vec<f64>,
    pub(crate) surface_normal_x: Vec<f64>,
    pub(crate) surface_normal_y: Vec<f64>,
    pub(crate) surface_normal_z: Vec<f64>,
    pub(crate) orientation_x: Vec<f64>,
    pub(crate) orientation_y: Vec<f64>,
    pub(crate) orientation_z: Vec<f64>,
    pub(crate) orientation_w: Vec<f64>,
    pub(crate) angular_velocity_x: Vec<f64>,
    pub(crate) angular_velocity_y: Vec<f64>,
    pub(crate) angular_velocity_z: Vec<f64>,
    pub(crate) unit_motion_flags: Vec<u32>,
    pub(crate) hp: Vec<f64>,
    pub(crate) max_hp: Vec<f64>,
    pub(crate) radius_collision: Vec<f64>,
    pub(crate) radius_hitbox: Vec<f64>,
    pub(crate) radius_other: Vec<f64>,
    pub(crate) aabb_hx: Vec<f64>,
    pub(crate) aabb_hy: Vec<f64>,
    pub(crate) aabb_hz: Vec<f64>,
    pub(crate) body_slot: Vec<i32>,
    pub(crate) unit_blueprint_code: Vec<u32>,
    pub(crate) building_blueprint_code: Vec<u32>,
    pub(crate) shot_blueprint_code: Vec<u32>,
    pub(crate) projectile_type_code: Vec<u32>,
    pub(crate) build_progress: Vec<f64>,
    pub(crate) build_flags: Vec<u32>,
    pub(crate) dirty_mask: Vec<u32>,
}

impl EntityStateSlab {
    pub(crate) fn empty() -> Self {
        Self {
            entity_id: Vec::new(),
            kind: Vec::new(),
            flags: Vec::new(),
            owner_player_id: Vec::new(),
            team_id: Vec::new(),
            pos_x: Vec::new(),
            pos_y: Vec::new(),
            pos_z: Vec::new(),
            rotation: Vec::new(),
            vel_x: Vec::new(),
            vel_y: Vec::new(),
            vel_z: Vec::new(),
            surface_normal_x: Vec::new(),
            surface_normal_y: Vec::new(),
            surface_normal_z: Vec::new(),
            orientation_x: Vec::new(),
            orientation_y: Vec::new(),
            orientation_z: Vec::new(),
            orientation_w: Vec::new(),
            angular_velocity_x: Vec::new(),
            angular_velocity_y: Vec::new(),
            angular_velocity_z: Vec::new(),
            unit_motion_flags: Vec::new(),
            hp: Vec::new(),
            max_hp: Vec::new(),
            radius_collision: Vec::new(),
            radius_hitbox: Vec::new(),
            radius_other: Vec::new(),
            aabb_hx: Vec::new(),
            aabb_hy: Vec::new(),
            aabb_hz: Vec::new(),
            body_slot: Vec::new(),
            unit_blueprint_code: Vec::new(),
            building_blueprint_code: Vec::new(),
            shot_blueprint_code: Vec::new(),
            projectile_type_code: Vec::new(),
            build_progress: Vec::new(),
            build_flags: Vec::new(),
            dirty_mask: Vec::new(),
        }
    }

    pub(crate) fn ensure_capacity(&mut self, slot: u32) {
        let needed = (slot as usize) + 1;
        if self.entity_id.len() >= needed {
            return;
        }
        self.entity_id.resize(needed, ENTITY_STATE_NO_ENTITY_ID);
        self.kind.resize(needed, ENTITY_STATE_KIND_NONE);
        self.flags.resize(needed, 0);
        self.owner_player_id.resize(needed, 0);
        self.team_id.resize(needed, 0);
        self.pos_x.resize(needed, 0.0);
        self.pos_y.resize(needed, 0.0);
        self.pos_z.resize(needed, 0.0);
        self.rotation.resize(needed, 0.0);
        self.vel_x.resize(needed, 0.0);
        self.vel_y.resize(needed, 0.0);
        self.vel_z.resize(needed, 0.0);
        self.surface_normal_x.resize(needed, 0.0);
        self.surface_normal_y.resize(needed, 0.0);
        self.surface_normal_z.resize(needed, 1.0);
        self.orientation_x.resize(needed, 0.0);
        self.orientation_y.resize(needed, 0.0);
        self.orientation_z.resize(needed, 0.0);
        self.orientation_w.resize(needed, 1.0);
        self.angular_velocity_x.resize(needed, 0.0);
        self.angular_velocity_y.resize(needed, 0.0);
        self.angular_velocity_z.resize(needed, 0.0);
        self.unit_motion_flags.resize(needed, 0);
        self.hp.resize(needed, 0.0);
        self.max_hp.resize(needed, 0.0);
        self.radius_collision.resize(needed, 0.0);
        self.radius_hitbox.resize(needed, 0.0);
        self.radius_other.resize(needed, 0.0);
        self.aabb_hx.resize(needed, 0.0);
        self.aabb_hy.resize(needed, 0.0);
        self.aabb_hz.resize(needed, 0.0);
        self.body_slot.resize(needed, ENTITY_STATE_NO_BODY_SLOT);
        self.unit_blueprint_code
            .resize(needed, ENTITY_STATE_BLUEPRINT_NONE);
        self.building_blueprint_code
            .resize(needed, ENTITY_STATE_BLUEPRINT_NONE);
        self.shot_blueprint_code
            .resize(needed, ENTITY_STATE_BLUEPRINT_NONE);
        self.projectile_type_code
            .resize(needed, ENTITY_STATE_BLUEPRINT_NONE);
        self.build_progress.resize(needed, 1.0);
        self.build_flags.resize(needed, 0);
        self.dirty_mask.resize(needed, 0);
    }

    pub(crate) fn clear_slot(&mut self, slot: u32) {
        let s = slot as usize;
        if s >= self.entity_id.len() {
            return;
        }
        self.entity_id[s] = ENTITY_STATE_NO_ENTITY_ID;
        self.kind[s] = ENTITY_STATE_KIND_NONE;
        self.flags[s] = 0;
        self.owner_player_id[s] = 0;
        self.team_id[s] = 0;
        self.pos_x[s] = 0.0;
        self.pos_y[s] = 0.0;
        self.pos_z[s] = 0.0;
        self.rotation[s] = 0.0;
        self.vel_x[s] = 0.0;
        self.vel_y[s] = 0.0;
        self.vel_z[s] = 0.0;
        self.surface_normal_x[s] = 0.0;
        self.surface_normal_y[s] = 0.0;
        self.surface_normal_z[s] = 1.0;
        self.orientation_x[s] = 0.0;
        self.orientation_y[s] = 0.0;
        self.orientation_z[s] = 0.0;
        self.orientation_w[s] = 1.0;
        self.angular_velocity_x[s] = 0.0;
        self.angular_velocity_y[s] = 0.0;
        self.angular_velocity_z[s] = 0.0;
        self.unit_motion_flags[s] = 0;
        self.hp[s] = 0.0;
        self.max_hp[s] = 0.0;
        self.radius_collision[s] = 0.0;
        self.radius_hitbox[s] = 0.0;
        self.radius_other[s] = 0.0;
        self.aabb_hx[s] = 0.0;
        self.aabb_hy[s] = 0.0;
        self.aabb_hz[s] = 0.0;
        self.body_slot[s] = ENTITY_STATE_NO_BODY_SLOT;
        self.unit_blueprint_code[s] = ENTITY_STATE_BLUEPRINT_NONE;
        self.building_blueprint_code[s] = ENTITY_STATE_BLUEPRINT_NONE;
        self.shot_blueprint_code[s] = ENTITY_STATE_BLUEPRINT_NONE;
        self.projectile_type_code[s] = ENTITY_STATE_BLUEPRINT_NONE;
        self.build_progress[s] = 1.0;
        self.build_flags[s] = 0;
        self.dirty_mask[s] = 0;
    }
}

pub(crate) struct EntityStateHolder(UnsafeCell<Option<EntityStateSlab>>);
unsafe impl Sync for EntityStateHolder {}
pub(crate) static ENTITY_STATE: EntityStateHolder = EntityStateHolder(UnsafeCell::new(None));

#[inline]
pub(crate) fn entity_state() -> &'static mut EntityStateSlab {
    unsafe {
        let cell = &mut *ENTITY_STATE.0.get();
        if cell.is_none() {
            *cell = Some(EntityStateSlab::empty());
        }
        cell.as_mut().unwrap()
    }
}

#[wasm_bindgen]
pub fn entity_state_init(initial_capacity: u32) {
    let slab = entity_state();
    *slab = EntityStateSlab::empty();
    if initial_capacity > 0 {
        slab.ensure_capacity(initial_capacity - 1);
    }
}

#[wasm_bindgen]
pub fn entity_state_clear() {
    let slab = entity_state();
    let len = slab.entity_id.len();
    for slot in 0..len {
        slab.clear_slot(slot as u32);
    }
}

#[wasm_bindgen]
pub fn entity_state_ensure_capacity(slot: u32) {
    entity_state().ensure_capacity(slot);
}

#[wasm_bindgen]
pub fn entity_state_unset_slot(slot: u32) {
    entity_state().clear_slot(slot);
}

#[wasm_bindgen]
pub fn entity_state_capacity() -> u32 {
    entity_state().entity_id.len() as u32
}

#[wasm_bindgen]
pub fn entity_state_set_lifecycle(
    slot: u32,
    entity_id: i32,
    kind: u8,
    owner_player_id: u32,
    team_id: u32,
    flags: u32,
) {
    let slab = entity_state();
    let s = slot as usize;
    slab.ensure_capacity(slot);
    slab.entity_id[s] = entity_id;
    slab.kind[s] = kind;
    slab.owner_player_id[s] = owner_player_id;
    slab.team_id[s] = team_id;
    slab.flags[s] = flags;
}

#[wasm_bindgen]
pub fn entity_state_set_transform(slot: u32, x: f64, y: f64, z: f64, rotation: f64) {
    let slab = entity_state();
    let s = slot as usize;
    slab.ensure_capacity(slot);
    slab.pos_x[s] = x;
    slab.pos_y[s] = y;
    slab.pos_z[s] = z;
    slab.rotation[s] = rotation;
}

#[wasm_bindgen]
pub fn entity_state_set_velocity(slot: u32, vx: f64, vy: f64, vz: f64) {
    let slab = entity_state();
    let s = slot as usize;
    slab.ensure_capacity(slot);
    slab.vel_x[s] = vx;
    slab.vel_y[s] = vy;
    slab.vel_z[s] = vz;
}

#[wasm_bindgen]
pub fn entity_state_set_unit_motion(
    slot: u32,
    surface_normal_x: f64,
    surface_normal_y: f64,
    surface_normal_z: f64,
    orientation_x: f64,
    orientation_y: f64,
    orientation_z: f64,
    orientation_w: f64,
    angular_velocity_x: f64,
    angular_velocity_y: f64,
    angular_velocity_z: f64,
    unit_motion_flags: u32,
) {
    let slab = entity_state();
    let s = slot as usize;
    slab.ensure_capacity(slot);
    slab.surface_normal_x[s] = surface_normal_x;
    slab.surface_normal_y[s] = surface_normal_y;
    slab.surface_normal_z[s] = surface_normal_z;
    slab.orientation_x[s] = orientation_x;
    slab.orientation_y[s] = orientation_y;
    slab.orientation_z[s] = orientation_z;
    slab.orientation_w[s] = orientation_w;
    slab.angular_velocity_x[s] = angular_velocity_x;
    slab.angular_velocity_y[s] = angular_velocity_y;
    slab.angular_velocity_z[s] = angular_velocity_z;
    slab.unit_motion_flags[s] = unit_motion_flags;
}

#[wasm_bindgen]
pub fn entity_state_set_ownership(slot: u32, owner_player_id: u32, team_id: u32) {
    let slab = entity_state();
    let s = slot as usize;
    slab.ensure_capacity(slot);
    slab.owner_player_id[s] = owner_player_id;
    slab.team_id[s] = team_id;
}

#[wasm_bindgen]
pub fn entity_state_set_hp_build(
    slot: u32,
    hp: f64,
    max_hp: f64,
    build_progress: f64,
    build_flags: u32,
) {
    let slab = entity_state();
    let s = slot as usize;
    slab.ensure_capacity(slot);
    slab.hp[s] = hp;
    slab.max_hp[s] = max_hp;
    slab.build_progress[s] = build_progress;
    slab.build_flags[s] = build_flags;
}

#[wasm_bindgen]
pub fn entity_state_set_static_shape(
    slot: u32,
    radius_collision: f64,
    radius_hitbox: f64,
    radius_other: f64,
    aabb_hx: f64,
    aabb_hy: f64,
    aabb_hz: f64,
) {
    let slab = entity_state();
    let s = slot as usize;
    slab.ensure_capacity(slot);
    slab.radius_collision[s] = radius_collision;
    slab.radius_hitbox[s] = radius_hitbox;
    slab.radius_other[s] = radius_other;
    slab.aabb_hx[s] = aabb_hx;
    slab.aabb_hy[s] = aabb_hy;
    slab.aabb_hz[s] = aabb_hz;
}

#[wasm_bindgen]
pub fn entity_state_set_body_slot(slot: u32, body_slot: i32) {
    let slab = entity_state();
    let s = slot as usize;
    slab.ensure_capacity(slot);
    slab.body_slot[s] = body_slot;
}

#[wasm_bindgen]
pub fn entity_state_set_blueprints(
    slot: u32,
    unit_blueprint_code: u32,
    building_blueprint_code: u32,
    shot_blueprint_code: u32,
    projectile_type_code: u32,
) {
    let slab = entity_state();
    let s = slot as usize;
    slab.ensure_capacity(slot);
    slab.unit_blueprint_code[s] = unit_blueprint_code;
    slab.building_blueprint_code[s] = building_blueprint_code;
    slab.shot_blueprint_code[s] = shot_blueprint_code;
    slab.projectile_type_code[s] = projectile_type_code;
}

#[wasm_bindgen]
pub fn entity_state_mark_dirty(slot: u32, dirty_mask: u32) {
    let slab = entity_state();
    let s = slot as usize;
    slab.ensure_capacity(slot);
    slab.dirty_mask[s] |= dirty_mask;
}

#[wasm_bindgen]
pub fn entity_state_clear_dirty(slot: u32) {
    let slab = entity_state();
    let s = slot as usize;
    if s < slab.dirty_mask.len() {
        slab.dirty_mask[s] = 0;
    }
}

#[wasm_bindgen]
pub fn entity_state_collect_dirty_slots(
    slots_out: &mut [u32],
    dirty_masks_out: &mut [u32],
    clear: bool,
) -> i32 {
    let slab = entity_state();
    let len = slab.dirty_mask.len();
    let mut required = 0_usize;
    for slot in 0..len {
        if slab.entity_id[slot] >= 0 && slab.dirty_mask[slot] != 0 {
            required += 1;
        }
    }
    if slots_out.len() < required || dirty_masks_out.len() < required {
        return -(required as i32);
    }
    let mut count = 0_usize;
    for slot in 0..len {
        let dirty_mask = slab.dirty_mask[slot];
        if slab.entity_id[slot] < 0 || dirty_mask == 0 {
            continue;
        }
        slots_out[count] = slot as u32;
        dirty_masks_out[count] = dirty_mask;
        count += 1;
        if clear {
            slab.dirty_mask[slot] = 0;
        }
    }
    count as i32
}

#[wasm_bindgen]
pub fn entity_state_set_projectiles_hot_batch(
    count: u32,
    slots: &[u32],
    xs: &[f64],
    ys: &[f64],
    zs: &[f64],
    vxs: &[f64],
    vys: &[f64],
    vzs: &[f64],
    hps: &[f64],
    max_hps: &[f64],
    flags: &[u32],
    owner_player_ids: &[u32],
    projectile_type_codes: &[u32],
    radius_collision: &[f64],
    radius_hitbox: &[f64],
) -> u32 {
    let n = count as usize;
    if slots.len() < n
        || xs.len() < n
        || ys.len() < n
        || zs.len() < n
        || vxs.len() < n
        || vys.len() < n
        || vzs.len() < n
        || hps.len() < n
        || max_hps.len() < n
        || flags.len() < n
        || owner_player_ids.len() < n
        || projectile_type_codes.len() < n
        || radius_collision.len() < n
        || radius_hitbox.len() < n
    {
        return 0;
    }

    let slab = entity_state();
    for i in 0..n {
        let slot = slots[i];
        let s = slot as usize;
        slab.ensure_capacity(slot);
        slab.kind[s] = ENTITY_STATE_KIND_SHOT;
        slab.owner_player_id[s] = owner_player_ids[i];
        slab.pos_x[s] = xs[i];
        slab.pos_y[s] = ys[i];
        slab.pos_z[s] = zs[i];
        slab.vel_x[s] = vxs[i];
        slab.vel_y[s] = vys[i];
        slab.vel_z[s] = vzs[i];
        slab.unit_motion_flags[s] = 0;
        slab.hp[s] = hps[i];
        slab.max_hp[s] = max_hps[i];
        slab.flags[s] = flags[i];
        slab.projectile_type_code[s] = projectile_type_codes[i];
        slab.radius_collision[s] = radius_collision[i];
        slab.radius_hitbox[s] = radius_hitbox[i];
        slab.radius_other[s] = radius_hitbox[i];
    }
    count
}

macro_rules! entity_state_ptr_export {
    ($name:ident, $field:ident, $ty:ty) => {
        #[wasm_bindgen]
        pub fn $name() -> *const $ty {
            entity_state().$field.as_ptr()
        }
    };
}

entity_state_ptr_export!(entity_state_entity_id_ptr, entity_id, i32);
entity_state_ptr_export!(entity_state_kind_ptr, kind, u8);
entity_state_ptr_export!(entity_state_flags_ptr, flags, u32);
entity_state_ptr_export!(entity_state_owner_player_id_ptr, owner_player_id, u32);
entity_state_ptr_export!(entity_state_team_id_ptr, team_id, u32);
entity_state_ptr_export!(entity_state_pos_x_ptr, pos_x, f64);
entity_state_ptr_export!(entity_state_pos_y_ptr, pos_y, f64);
entity_state_ptr_export!(entity_state_pos_z_ptr, pos_z, f64);
entity_state_ptr_export!(entity_state_rotation_ptr, rotation, f64);
entity_state_ptr_export!(entity_state_vel_x_ptr, vel_x, f64);
entity_state_ptr_export!(entity_state_vel_y_ptr, vel_y, f64);
entity_state_ptr_export!(entity_state_vel_z_ptr, vel_z, f64);
entity_state_ptr_export!(entity_state_surface_normal_x_ptr, surface_normal_x, f64);
entity_state_ptr_export!(entity_state_surface_normal_y_ptr, surface_normal_y, f64);
entity_state_ptr_export!(entity_state_surface_normal_z_ptr, surface_normal_z, f64);
entity_state_ptr_export!(entity_state_orientation_x_ptr, orientation_x, f64);
entity_state_ptr_export!(entity_state_orientation_y_ptr, orientation_y, f64);
entity_state_ptr_export!(entity_state_orientation_z_ptr, orientation_z, f64);
entity_state_ptr_export!(entity_state_orientation_w_ptr, orientation_w, f64);
entity_state_ptr_export!(entity_state_angular_velocity_x_ptr, angular_velocity_x, f64);
entity_state_ptr_export!(entity_state_angular_velocity_y_ptr, angular_velocity_y, f64);
entity_state_ptr_export!(entity_state_angular_velocity_z_ptr, angular_velocity_z, f64);
entity_state_ptr_export!(entity_state_unit_motion_flags_ptr, unit_motion_flags, u32);
entity_state_ptr_export!(entity_state_hp_ptr, hp, f64);
entity_state_ptr_export!(entity_state_max_hp_ptr, max_hp, f64);
entity_state_ptr_export!(entity_state_radius_collision_ptr, radius_collision, f64);
entity_state_ptr_export!(entity_state_radius_hitbox_ptr, radius_hitbox, f64);
entity_state_ptr_export!(entity_state_radius_other_ptr, radius_other, f64);
entity_state_ptr_export!(entity_state_aabb_hx_ptr, aabb_hx, f64);
entity_state_ptr_export!(entity_state_aabb_hy_ptr, aabb_hy, f64);
entity_state_ptr_export!(entity_state_aabb_hz_ptr, aabb_hz, f64);
entity_state_ptr_export!(entity_state_body_slot_ptr, body_slot, i32);
entity_state_ptr_export!(entity_state_unit_blueprint_code_ptr, unit_blueprint_code, u32);
entity_state_ptr_export!(
    entity_state_building_blueprint_code_ptr,
    building_blueprint_code,
    u32
);
entity_state_ptr_export!(entity_state_shot_blueprint_code_ptr, shot_blueprint_code, u32);
entity_state_ptr_export!(
    entity_state_projectile_type_code_ptr,
    projectile_type_code,
    u32
);
entity_state_ptr_export!(entity_state_build_progress_ptr, build_progress, f64);
entity_state_ptr_export!(entity_state_build_flags_ptr, build_flags, u32);
entity_state_ptr_export!(entity_state_dirty_mask_ptr, dirty_mask, u32);

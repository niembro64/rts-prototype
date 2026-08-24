// Shield clearance, projectile reflection, and terminal-effect kernels.

use super::*;

// ─────────────────────────────────────────────────────────────────
// AIM-08.1 — Shield input slab
//
// Compact list of `count` active shields, rebuilt from scratch
// each tick from the JS-side getActiveShields(). Owner entity id
// is the entity that emits the field (sentinel -1 if not tied to one).
// ─────────────────────────────────────────────────────────────────

// A single shield surface pool holds the authored sphere fields and flat
// panels. Both shapes share the same reflection and occlusion policy.
pub(crate) struct ShieldSurfacePool {
    // ── Sphere fields (flat per-field) ──
    count: u32,
    id: Vec<i32>,
    owner_entity_id: Vec<i32>,
    prev_center_x: Vec<f64>,
    prev_center_y: Vec<f64>,
    prev_center_z: Vec<f64>,
    center_x: Vec<f64>,
    center_y: Vec<f64>,
    center_z: Vec<f64>,
    radius: Vec<f64>,
    // P3 precompute: union bound of the prev+current pose, built once per
    // shield per tick in `shield_pool_set_field`. The per-pair reject used
    // to rebuild both pose bounds (plus a sqrt) for every
    // (projectile, shield) pair. Base radius excludes the projectile pad.
    union_center_x: Vec<f64>,
    union_center_y: Vec<f64>,
    union_center_z: Vec<f64>,
    union_base_radius: Vec<f64>,
    field_reflection_mode_plasma: Vec<u8>,
    field_reflection_mode_rocket: Vec<u8>,
    field_reflection_mode_beam: Vec<u8>,
    field_reflection_entity_mask: u8,

    // ── Rect-panel shape (per-unit) ──
    // Counts are tracked separately so the backing Vecs can be reused across
    // ticks; the kernels read only `unit_count` rows.
    unit_count: u32,
    unit_id: Vec<i32>,
    unit_x: Vec<f64>,
    unit_y: Vec<f64>,
    unit_z: Vec<f64>,
    unit_ground_z: Vec<f64>,
    unit_broad_radius: Vec<f32>,
    mirror_yaw: Vec<f32>,
    mirror_pitch: Vec<f32>,
    // P3 precompute: per-unit mirror trig, built once per unit per tick in
    // `shield_panel_pool_set_unit` (was recomputed per surviving
    // projectile x unit pair in two kernels).
    mirror_cos_yaw: Vec<f64>,
    mirror_sin_yaw: Vec<f64>,
    mirror_cos_pitch: Vec<f64>,
    mirror_sin_pitch: Vec<f64>,
    pivot_x: Vec<f64>,
    pivot_y: Vec<f64>,
    pivot_z: Vec<f64>,
    panel_start: Vec<u32>,
    panel_count: Vec<u8>,

    // ── Rect-panel shape (per-panel) ──
    total_panels: u32,
    panel_arm_length: Vec<f32>,
    panel_offset_y: Vec<f32>,
    panel_angle: Vec<f32>,
    panel_base_y: Vec<f32>,
    panel_top_y: Vec<f32>,
    panel_half_width: Vec<f32>,
    panel_reflection_mode_plasma: Vec<u8>,
    panel_reflection_mode_rocket: Vec<u8>,
    panel_reflection_mode_beam: Vec<u8>,
    panel_reflection_entity_mask: u8,
}

impl ShieldSurfacePool {
    pub(crate) fn empty() -> Self {
        Self {
            count: 0,
            id: Vec::new(),
            owner_entity_id: Vec::new(),
            prev_center_x: Vec::new(),
            prev_center_y: Vec::new(),
            prev_center_z: Vec::new(),
            center_x: Vec::new(),
            center_y: Vec::new(),
            center_z: Vec::new(),
            radius: Vec::new(),
            union_center_x: Vec::new(),
            union_center_y: Vec::new(),
            union_center_z: Vec::new(),
            union_base_radius: Vec::new(),
            field_reflection_mode_plasma: Vec::new(),
            field_reflection_mode_rocket: Vec::new(),
            field_reflection_mode_beam: Vec::new(),
            field_reflection_entity_mask: 0,
            unit_count: 0,
            unit_id: Vec::new(),
            unit_x: Vec::new(),
            unit_y: Vec::new(),
            unit_z: Vec::new(),
            unit_ground_z: Vec::new(),
            unit_broad_radius: Vec::new(),
            mirror_yaw: Vec::new(),
            mirror_pitch: Vec::new(),
            mirror_cos_yaw: Vec::new(),
            mirror_sin_yaw: Vec::new(),
            mirror_cos_pitch: Vec::new(),
            mirror_sin_pitch: Vec::new(),
            pivot_x: Vec::new(),
            pivot_y: Vec::new(),
            pivot_z: Vec::new(),
            panel_start: Vec::new(),
            panel_count: Vec::new(),
            total_panels: 0,
            panel_arm_length: Vec::new(),
            panel_offset_y: Vec::new(),
            panel_angle: Vec::new(),
            panel_base_y: Vec::new(),
            panel_top_y: Vec::new(),
            panel_half_width: Vec::new(),
            panel_reflection_mode_plasma: Vec::new(),
            panel_reflection_mode_rocket: Vec::new(),
            panel_reflection_mode_beam: Vec::new(),
            panel_reflection_entity_mask: 0,
        }
    }

    pub(crate) fn ensure_capacity(&mut self, count: u32) {
        let needed = count as usize;
        if self.id.len() < needed {
            self.id.resize(needed, -1);
            self.owner_entity_id.resize(needed, -1);
            self.prev_center_x.resize(needed, 0.0);
            self.prev_center_y.resize(needed, 0.0);
            self.prev_center_z.resize(needed, 0.0);
            self.center_x.resize(needed, 0.0);
            self.center_y.resize(needed, 0.0);
            self.center_z.resize(needed, 0.0);
            self.radius.resize(needed, 0.0);
            self.union_center_x.resize(needed, 0.0);
            self.union_center_y.resize(needed, 0.0);
            self.union_center_z.resize(needed, 0.0);
            self.union_base_radius.resize(needed, 0.0);
            self.field_reflection_mode_plasma
                .resize(needed, SHIELD_REFLECTION_MODE_NONE);
            self.field_reflection_mode_rocket
                .resize(needed, SHIELD_REFLECTION_MODE_NONE);
            self.field_reflection_mode_beam
                .resize(needed, SHIELD_REFLECTION_MODE_NONE);
        }
    }

    pub(crate) fn ensure_unit_capacity(&mut self, count: u32) {
        let needed = count as usize;
        if self.unit_id.len() < needed {
            self.unit_id.resize(needed, -1);
            self.unit_x.resize(needed, 0.0);
            self.unit_y.resize(needed, 0.0);
            self.unit_z.resize(needed, 0.0);
            self.unit_ground_z.resize(needed, 0.0);
            self.unit_broad_radius.resize(needed, 0.0);
            self.mirror_yaw.resize(needed, 0.0);
            self.mirror_cos_yaw.resize(needed, 0.0);
            self.mirror_sin_yaw.resize(needed, 0.0);
            self.mirror_cos_pitch.resize(needed, 0.0);
            self.mirror_sin_pitch.resize(needed, 0.0);
            self.mirror_pitch.resize(needed, 0.0);
            self.pivot_x.resize(needed, 0.0);
            self.pivot_y.resize(needed, 0.0);
            self.pivot_z.resize(needed, 0.0);
            self.panel_start.resize(needed, 0);
            self.panel_count.resize(needed, 0);
        }
    }

    pub(crate) fn ensure_panel_capacity(&mut self, count: u32) {
        let needed = count as usize;
        if self.panel_arm_length.len() < needed {
            self.panel_arm_length.resize(needed, 0.0);
            self.panel_offset_y.resize(needed, 0.0);
            self.panel_angle.resize(needed, 0.0);
            self.panel_base_y.resize(needed, 0.0);
            self.panel_top_y.resize(needed, 0.0);
            self.panel_half_width.resize(needed, 0.0);
            self.panel_reflection_mode_plasma
                .resize(needed, SHIELD_REFLECTION_MODE_NONE);
            self.panel_reflection_mode_rocket
                .resize(needed, SHIELD_REFLECTION_MODE_NONE);
            self.panel_reflection_mode_beam
                .resize(needed, SHIELD_REFLECTION_MODE_NONE);
        }
    }
}

pub(crate) static SHIELD_POOL: WasmLazy<ShieldSurfacePool> = WasmLazy::new();

#[inline]
pub(crate) fn shield_pool() -> &'static mut ShieldSurfacePool {
    SHIELD_POOL.get_or_init(ShieldSurfacePool::empty)
}

#[wasm_bindgen]
pub fn shield_pool_clear() {
    let pool = shield_pool();
    pool.count = 0;
    pool.unit_count = 0;
    pool.total_panels = 0;
    pool.field_reflection_entity_mask = 0;
    pool.panel_reflection_entity_mask = 0;
}

#[wasm_bindgen]
pub fn shield_pool_count() -> u32 {
    shield_pool().count
}

#[wasm_bindgen]
pub fn shield_pool_set_count(count: u32) {
    let pool = shield_pool();
    pool.ensure_capacity(count);
    pool.count = count;
    pool.field_reflection_entity_mask = 0;
}

#[wasm_bindgen]
pub fn shield_pool_set_field(
    idx: u32,
    id: i32,
    owner_entity_id: i32,
    prev_center_x: f64,
    prev_center_y: f64,
    prev_center_z: f64,
    center_x: f64,
    center_y: f64,
    center_z: f64,
    radius: f64,
    reflection_mode_plasma: u8,
    reflection_mode_rocket: u8,
    reflection_mode_beam: u8,
) {
    let pool = shield_pool();
    pool.ensure_capacity(idx + 1);
    let i = idx as usize;
    pool.id[i] = id;
    pool.owner_entity_id[i] = owner_entity_id;
    pool.prev_center_x[i] = prev_center_x;
    pool.prev_center_y[i] = prev_center_y;
    pool.prev_center_z[i] = prev_center_z;
    pool.center_x[i] = center_x;
    pool.center_y[i] = center_y;
    pool.center_z[i] = center_z;
    pool.radius[i] = radius;
    pool.field_reflection_mode_plasma[i] = reflection_mode_plasma;
    pool.field_reflection_mode_rocket[i] = reflection_mode_rocket;
    pool.field_reflection_mode_beam[i] = reflection_mode_beam;
    pool.field_reflection_entity_mask |= shield_reflection_entity_mask_from_modes(
        reflection_mode_plasma,
        reflection_mode_rocket,
        reflection_mode_beam,
    );
    let dcx = center_x - prev_center_x;
    let dcy = center_y - prev_center_y;
    let dcz = center_z - prev_center_z;
    pool.union_center_x[i] = (prev_center_x + center_x) * 0.5;
    pool.union_center_y[i] = (prev_center_y + center_y) * 0.5;
    pool.union_center_z[i] = (prev_center_z + center_z) * 0.5;
    pool.union_base_radius[i] =
        0.5 * (dcx * dcx + dcy * dcy + dcz * dcz).sqrt() + radius;
}

macro_rules! shield_pool_ptr_export {
    ($name:ident, $field:ident, $ty:ty) => {
        #[wasm_bindgen]
        pub fn $name() -> *const $ty {
            shield_pool().$field.as_ptr()
        }
    };
}

shield_pool_ptr_export!(shield_pool_id_ptr, id, i32);
shield_pool_ptr_export!(shield_pool_owner_entity_id_ptr, owner_entity_id, i32);
shield_pool_ptr_export!(shield_pool_center_x_ptr, center_x, f64);
shield_pool_ptr_export!(shield_pool_center_y_ptr, center_y, f64);
shield_pool_ptr_export!(shield_pool_center_z_ptr, center_z, f64);
shield_pool_ptr_export!(shield_pool_radius_ptr, radius, f64);

// ─────────────────────────────────────────────────────────────────
// AIM-08.2 — Shield clearance kernels.
//
// Both kernels read the SHIELD_POOL slab rebuilt per tick by the
// JS-side stampShieldPool pass. They replace the JS-side
// hasShieldClearance / hasArcShieldClearance in
// lineOfSight.ts; the JS wrappers are now thin dispatchers.
//
// `exclude_owner_entity_id` is a legacy per-call exemption hook. The
// current shield-aware targeting path passes sentinel -1 so every active
// boundary is considered, including a shooter's own field.
//
// Graze epsilon: crossings within SHIELD_GRAZE_EPS of the segment
// endpoints don't count, matching the JS path's behaviour so a turret
// or target sitting on a shield edge doesn't flicker between locked
// and unlocked.
// ─────────────────────────────────────────────────────────────────

pub(crate) const SHIELD_GRAZE_EPS: f64 = 1e-6;
pub(crate) const ARC_FF_CLEARANCE_SAMPLES: u32 = 16;
pub(crate) const SHIELD_MOVING_FIELD_TOI_STEPS: usize = 8;
pub(crate) const SHIELD_REFLECTION_MODE_OUTSIDE_IN: u8 = 0;
pub(crate) const SHIELD_REFLECTION_MODE_INSIDE_OUT: u8 = 1;
pub(crate) const SHIELD_REFLECTION_MODE_BOTH: u8 = 2;
pub(crate) const SHIELD_REFLECTION_MODE_NONE: u8 = 3;
pub(crate) const SHIELD_REFLECTION_ENTITY_PLASMA: u8 = 0;
pub(crate) const SHIELD_REFLECTION_ENTITY_ROCKET: u8 = 1;
pub(crate) const SHIELD_REFLECTION_ENTITY_BEAM: u8 = 2;
pub(crate) const SHIELD_REFLECTION_ENTITY_BIT_PLASMA: u8 = 1 << SHIELD_REFLECTION_ENTITY_PLASMA;
pub(crate) const SHIELD_REFLECTION_ENTITY_BIT_ROCKET: u8 = 1 << SHIELD_REFLECTION_ENTITY_ROCKET;
pub(crate) const SHIELD_REFLECTION_ENTITY_BIT_BEAM: u8 = 1 << SHIELD_REFLECTION_ENTITY_BEAM;
pub(crate) const REFLECTOR_HIT_KIND_NONE: u8 = 0;
// Materials Are Independent Of Shape: the shield-panel's flat panels and
// the shield-sphere's sphere are the EXACT SAME material. A projectile
// reflecting off either reports one kind; the shape only decided where the
// hit was and what the normal looks like.
pub(crate) const REFLECTOR_HIT_KIND_SHIELD: u8 = 1;

pub(crate) struct ProjectileReflectorHit {
    kind: u8,
    entity_id: i32,
    /// Panel index within the mirror unit's panel array; -1 for
    /// sphere-field surfaces.
    panel_index: i32,
    t: f64,
    x: f64,
    y: f64,
    z: f64,
    normal_x: f64,
    normal_y: f64,
    normal_z: f64,
    surface_velocity_x: f64,
    surface_velocity_y: f64,
    surface_velocity_z: f64,
}

/// THE one mirror-reflection formula, shared by every emission kind:
/// beam traces reflect their segment direction through it, and the
/// plasma/rocket reflection response reflects its surface-relative
/// velocity through it. Normalizes `n_raw`, mirrors `d` about it, and
/// returns None when either vector is degenerate.
#[inline]
pub(crate) fn reflect_about_normal(
    dx: f64,
    dy: f64,
    dz: f64,
    nx_raw: f64,
    ny_raw: f64,
    nz_raw: f64,
) -> Option<(f64, f64, f64)> {
    let normal_len_sq = nx_raw * nx_raw + ny_raw * ny_raw + nz_raw * nz_raw;
    let d_len_sq = dx * dx + dy * dy + dz * dz;
    if normal_len_sq <= 1e-18 || d_len_sq <= 1e-18 {
        return None;
    }
    let inv_normal_len = 1.0 / normal_len_sq.sqrt();
    let nx = nx_raw * inv_normal_len;
    let ny = ny_raw * inv_normal_len;
    let nz = nz_raw * inv_normal_len;
    let dot = dx * nx + dy * ny + dz * nz;
    Some((
        dx - 2.0 * dot * nx,
        dy - 2.0 * dot * ny,
        dz - 2.0 * dot * nz,
    ))
}

pub(crate) struct ShieldFieldContact {
    pub(crate) t: f64,
    pub(crate) threshold: f64,
}

#[inline]
pub(crate) fn shield_reflection_mode_for_entity(
    reflection_entity: u8,
    plasma_mode: u8,
    rocket_mode: u8,
    beam_mode: u8,
) -> u8 {
    match reflection_entity {
        SHIELD_REFLECTION_ENTITY_PLASMA => plasma_mode,
        SHIELD_REFLECTION_ENTITY_ROCKET => rocket_mode,
        SHIELD_REFLECTION_ENTITY_BEAM => beam_mode,
        _ => SHIELD_REFLECTION_MODE_NONE,
    }
}

#[inline]
pub(crate) fn shield_reflection_entity_bit(reflection_entity: u8) -> u8 {
    match reflection_entity {
        SHIELD_REFLECTION_ENTITY_PLASMA => SHIELD_REFLECTION_ENTITY_BIT_PLASMA,
        SHIELD_REFLECTION_ENTITY_ROCKET => SHIELD_REFLECTION_ENTITY_BIT_ROCKET,
        SHIELD_REFLECTION_ENTITY_BEAM => SHIELD_REFLECTION_ENTITY_BIT_BEAM,
        _ => 0,
    }
}

#[inline]
pub(crate) fn shield_reflection_entity_mask_from_modes(
    plasma_mode: u8,
    rocket_mode: u8,
    beam_mode: u8,
) -> u8 {
    let mut mask = 0;
    if plasma_mode != SHIELD_REFLECTION_MODE_NONE {
        mask |= SHIELD_REFLECTION_ENTITY_BIT_PLASMA;
    }
    if rocket_mode != SHIELD_REFLECTION_MODE_NONE {
        mask |= SHIELD_REFLECTION_ENTITY_BIT_ROCKET;
    }
    if beam_mode != SHIELD_REFLECTION_MODE_NONE {
        mask |= SHIELD_REFLECTION_ENTITY_BIT_BEAM;
    }
    mask
}

// ── Sight clearance: a closed barrier is opaque OUTSIDE-IN only ──
//
// These three tests answer "does this sightline ENTER the field from outside",
// not "does it touch the boundary at all". A barrier reflects what comes at it
// and lets its own side's fire out (every barrier in shields.json authors
// `reflect-outside` for every emission family), so a gunner standing inside a
// dome must be able to aim at what its rounds can reach. The old
// direction-agnostic crossing count blocked the outbound half too, which — with
// the clearance walk excluding nothing, not even the shooter's own field — left
// a shielded unit unable to acquire anything outside its own bubble while its
// shots left that bubble unimpeded.
//
// A segment starting strictly inside a closed shape crosses its boundary at
// most once, outward, so "start inside" settles the whole question with no
// intersection math: each test returns early on the sign of a term it already
// had to compute, BEFORE the discriminant, the square root, and two divisions.
// The directional rule is strictly cheaper than the symmetric one it replaces.
//
// Mirror panels are deliberately NOT covered by this: a flat plate has no
// inside, "outside-in" is undefined for it, and it authors `reflect-both`. The
// panel walk in shield_clearance_segment stays two-sided.

#[inline]
pub(crate) fn shield_segment_enters_sphere(
    sx: f64,
    sy: f64,
    sz: f64,
    tx: f64,
    ty: f64,
    tz: f64,
    cx: f64,
    cy: f64,
    cz: f64,
    r: f64,
    lo: f64,
    hi: f64,
) -> bool {
    if sx.max(tx) < cx - r || sx.min(tx) > cx + r {
        return false;
    }
    if sy.max(ty) < cy - r || sy.min(ty) > cy + r {
        return false;
    }
    if sz.max(tz) < cz - r || sz.min(tz) > cz + r {
        return false;
    }
    let dx = tx - sx;
    let dy = ty - sy;
    let dz = tz - sz;
    let a = dx * dx + dy * dy + dz * dz;
    if a < 1e-9 {
        return false;
    }
    let fx = sx - cx;
    let fy = sy - cy;
    let fz = sz - cz;
    let b = 2.0 * (fx * dx + fy * dy + fz * dz);
    let c = fx * fx + fy * fy + fz * fz - r * r;
    // c < 0 is exactly "the sightline starts inside this dome", so its only
    // boundary crossing is outward and the barrier does not obstruct it.
    if c < 0.0 {
        return false;
    }
    let disc = b * b - 4.0 * a * c;
    if disc < 0.0 {
        return false;
    }
    let sqrt_disc = disc.sqrt();
    let inv_denom = 1.0 / (2.0 * a);
    let t1 = (-b - sqrt_disc) * inv_denom;
    let t2 = (-b + sqrt_disc) * inv_denom;
    (t1 > lo && t1 < hi) || (t2 > lo && t2 < hi)
}

#[inline]
pub(crate) fn shield_segment_enters_field(
    sx: f64,
    sy: f64,
    sz: f64,
    tx: f64,
    ty: f64,
    tz: f64,
    cx: f64,
    cy: f64,
    cz: f64,
    r: f64,
    lo: f64,
    hi: f64,
) -> bool {
    shield_segment_enters_sphere(sx, sy, sz, tx, ty, tz, cx, cy, cz, r, lo, hi)
}

#[inline]
pub(crate) fn shield_reflection_mode_allows_crossing(mode: u8, radial_velocity: f64) -> bool {
    if mode == SHIELD_REFLECTION_MODE_NONE {
        return false;
    }
    let eps = 1e-6;
    if radial_velocity < -eps {
        return mode == SHIELD_REFLECTION_MODE_OUTSIDE_IN || mode == SHIELD_REFLECTION_MODE_BOTH;
    }
    if radial_velocity > eps {
        return mode == SHIELD_REFLECTION_MODE_INSIDE_OUT || mode == SHIELD_REFLECTION_MODE_BOTH;
    }
    false
}

#[inline]
pub(crate) fn shield_projectile_intersection_t(
    start_x: f64,
    start_y: f64,
    start_z: f64,
    end_x: f64,
    end_y: f64,
    end_z: f64,
    center_x: f64,
    center_y: f64,
    center_z: f64,
    radius: f64,
    reflection_mode: u8,
) -> Option<f64> {
    let sx = start_x - center_x;
    let sy = start_y - center_y;
    let sz = start_z - center_z;
    if start_x.max(end_x) < center_x - radius || start_x.min(end_x) > center_x + radius {
        return None;
    }
    if start_y.max(end_y) < center_y - radius || start_y.min(end_y) > center_y + radius {
        return None;
    }
    if start_z.max(end_z) < center_z - radius || start_z.min(end_z) > center_z + radius {
        return None;
    }

    let dx = end_x - start_x;
    let dy = end_y - start_y;
    let dz = end_z - start_z;
    let a = dx * dx + dy * dy + dz * dz;
    if a <= 1e-9 {
        return None;
    }

    let radius_sq = radius * radius;
    let start_dist_sq = sx * sx + sy * sy + sz * sz;
    let start_dot_velocity = sx * dx + sy * dy + sz * dz;
    let b = 2.0 * start_dot_velocity;
    let c = start_dist_sq - radius_sq;
    let disc = b * b - 4.0 * a * c;
    if disc < 0.0 {
        return None;
    }

    let sqrt_disc = disc.sqrt();
    let inv_denom = 1.0 / (2.0 * a);
    let t0 = (-b - sqrt_disc) * inv_denom;
    let t1 = (-b + sqrt_disc) * inv_denom;
    let first_t = t0.min(t1);
    let second_t = t0.max(t1);

    if first_t > SHIELD_GRAZE_EPS && first_t <= 1.0 {
        let hit_x = start_x + dx * first_t - center_x;
        let hit_y = start_y + dy * first_t - center_y;
        let hit_z = start_z + dz * first_t - center_z;
        let radial_velocity = dx * hit_x + dy * hit_y + dz * hit_z;
        if shield_reflection_mode_allows_crossing(reflection_mode, radial_velocity) {
            return Some(first_t);
        }
    }

    if second_t > SHIELD_GRAZE_EPS && second_t <= 1.0 && second_t != first_t {
        let hit_x = start_x + dx * second_t - center_x;
        let hit_y = start_y + dy * second_t - center_y;
        let hit_z = start_z + dz * second_t - center_z;
        let radial_velocity = dx * hit_x + dy * hit_y + dz * hit_z;
        if shield_reflection_mode_allows_crossing(reflection_mode, radial_velocity) {
            return Some(second_t);
        }
    }

    None
}

#[inline]
pub(crate) fn shield_projectile_intersection_contact(
    start_x: f64,
    start_y: f64,
    start_z: f64,
    end_x: f64,
    end_y: f64,
    end_z: f64,
    center_x: f64,
    center_y: f64,
    center_z: f64,
    radius: f64,
    projectile_radius: f64,
    reflection_mode: u8,
) -> Option<ShieldFieldContact> {
    let projectile_radius = projectile_radius.max(0.0);
    let mut best: Option<ShieldFieldContact> = None;

    let mut try_radius = |effective_radius: f64, threshold: f64| {
        if effective_radius <= SHIELD_GRAZE_EPS {
            return;
        }
        let Some(t) = shield_projectile_intersection_t(
            start_x,
            start_y,
            start_z,
            end_x,
            end_y,
            end_z,
            center_x,
            center_y,
            center_z,
            effective_radius,
            reflection_mode,
        ) else {
            return;
        };
        if best.as_ref().map(|hit| t < hit.t).unwrap_or(true) {
            best = Some(ShieldFieldContact { t, threshold });
        }
    };

    if projectile_radius > SHIELD_GRAZE_EPS {
        try_radius(radius - projectile_radius, -projectile_radius);
        try_radius(radius + projectile_radius, projectile_radius);
    } else {
        try_radius(radius, 0.0);
    }

    best
}

#[inline]
pub(crate) fn shield_field_signed_distance_and_normal(
    px: f64,
    py: f64,
    pz: f64,
    center_x: f64,
    center_y: f64,
    center_z: f64,
    radius: f64,
) -> Option<(f64, f64, f64, f64)> {
    if radius <= 0.0 {
        return None;
    }
    let dx = px - center_x;
    let dy = py - center_y;
    let dz = pz - center_z;
    let len = (dx * dx + dy * dy + dz * dz).sqrt();
    if len <= 1e-9 {
        return Some((-radius, 1.0, 0.0, 0.0));
    }
    let inv_len = 1.0 / len;
    Some((len - radius, dx * inv_len, dy * inv_len, dz * inv_len))
}

#[inline]
pub(crate) fn lerp_f64(a: f64, b: f64, t: f64) -> f64 {
    a + (b - a) * t
}

#[inline]
pub(crate) fn shield_field_sample_at_t(
    start_x: f64,
    start_y: f64,
    start_z: f64,
    end_x: f64,
    end_y: f64,
    end_z: f64,
    prev_center_x: f64,
    prev_center_y: f64,
    prev_center_z: f64,
    center_x: f64,
    center_y: f64,
    center_z: f64,
    radius: f64,
    t: f64,
) -> Option<(f64, f64, f64, f64, f64, f64, f64)> {
    let px = lerp_f64(start_x, end_x, t);
    let py = lerp_f64(start_y, end_y, t);
    let pz = lerp_f64(start_z, end_z, t);
    let cx = lerp_f64(prev_center_x, center_x, t);
    let cy = lerp_f64(prev_center_y, center_y, t);
    let cz = lerp_f64(prev_center_z, center_z, t);
    let (dist, nx, ny, nz) =
        shield_field_signed_distance_and_normal(px, py, pz, cx, cy, cz, radius)?;
    Some((dist, nx, ny, nz, px, py, pz))
}

#[inline]
pub(crate) fn shield_field_surface_velocity(
    _hit_x: f64,
    _hit_y: f64,
    _hit_z: f64,
    normal_x: f64,
    normal_y: f64,
    normal_z: f64,
    threshold: f64,
    prev_center_x: f64,
    prev_center_y: f64,
    prev_center_z: f64,
    center_x: f64,
    center_y: f64,
    center_z: f64,
    radius: f64,
    dt_sec: f64,
) -> (f64, f64, f64) {
    if dt_sec <= 1e-9 || !dt_sec.is_finite() {
        return (0.0, 0.0, 0.0);
    }
    let effective_radius = (radius + threshold).max(0.0);
    let (prev_x, prev_y, prev_z, curr_x, curr_y, curr_z) = (
        prev_center_x + normal_x * effective_radius,
        prev_center_y + normal_y * effective_radius,
        prev_center_z + normal_z * effective_radius,
        center_x + normal_x * effective_radius,
        center_y + normal_y * effective_radius,
        center_z + normal_z * effective_radius,
    );

    (
        (curr_x - prev_x) / dt_sec,
        (curr_y - prev_y) / dt_sec,
        (curr_z - prev_z) / dt_sec,
    )
}

#[inline]
pub(crate) fn shield_projectile_moving_field_hit(
    start_x: f64,
    start_y: f64,
    start_z: f64,
    end_x: f64,
    end_y: f64,
    end_z: f64,
    prev_center_x: f64,
    prev_center_y: f64,
    prev_center_z: f64,
    center_x: f64,
    center_y: f64,
    center_z: f64,
    radius: f64,
    projectile_radius: f64,
    reflection_mode: u8,
    owner_entity_id: i32,
    dt_sec: f64,
) -> Option<ProjectileReflectorHit> {
    let projectile_radius = projectile_radius.max(0.0);
    let mut contact: Option<ShieldFieldContact> = None;
    let mut try_threshold = |candidate: f64, fallback_only: bool| {
        if fallback_only && contact.is_some() {
            return;
        }
        if contact
            .as_ref()
            .map(|hit| hit.t <= SHIELD_GRAZE_EPS)
            .unwrap_or(false)
        {
            return;
        }
        let mut lo_t = 0.0;
        let Some((lo_dist, _, _, _, _, _, _)) = shield_field_sample_at_t(
            start_x,
            start_y,
            start_z,
            end_x,
            end_y,
            end_z,
            prev_center_x,
            prev_center_y,
            prev_center_z,
            center_x,
            center_y,
            center_z,
            radius,
            lo_t,
        ) else {
            return;
        };
        let mut lo_side = lo_dist - candidate;

        for step in 1..=SHIELD_MOVING_FIELD_TOI_STEPS {
            let sample_t = step as f64 / SHIELD_MOVING_FIELD_TOI_STEPS as f64;
            let Some((sample_dist, _, _, _, _, _, _)) = shield_field_sample_at_t(
                start_x,
                start_y,
                start_z,
                end_x,
                end_y,
                end_z,
                prev_center_x,
                prev_center_y,
                prev_center_z,
                center_x,
                center_y,
                center_z,
                radius,
                sample_t,
            ) else {
                return;
            };
            let sample_side = sample_dist - candidate;
            let exact_sample = sample_side.abs() <= SHIELD_GRAZE_EPS
                && lo_side.abs() > SHIELD_GRAZE_EPS
                && shield_reflection_mode_allows_crossing(reflection_mode, sample_side - lo_side);
            if exact_sample {
                if contact.as_ref().map(|hit| sample_t < hit.t).unwrap_or(true) {
                    contact = Some(ShieldFieldContact {
                        t: sample_t,
                        threshold: candidate,
                    });
                }
                return;
            }

            let crossed = (lo_side <= SHIELD_GRAZE_EPS && sample_side > SHIELD_GRAZE_EPS)
                || (lo_side >= -SHIELD_GRAZE_EPS && sample_side < -SHIELD_GRAZE_EPS);
            if crossed
                && shield_reflection_mode_allows_crossing(reflection_mode, sample_side - lo_side)
            {
                let mut root_lo_t = lo_t;
                let mut root_hi_t = sample_t;
                let mut root_lo_side = lo_side;
                for _ in 0..18 {
                    let mid = (root_lo_t + root_hi_t) * 0.5;
                    let Some((mid_dist, _, _, _, _, _, _)) = shield_field_sample_at_t(
                        start_x,
                        start_y,
                        start_z,
                        end_x,
                        end_y,
                        end_z,
                        prev_center_x,
                        prev_center_y,
                        prev_center_z,
                        center_x,
                        center_y,
                        center_z,
                        radius,
                        mid,
                    ) else {
                        return;
                    };
                    let mid_side = mid_dist - candidate;
                    if mid_side.abs() <= SHIELD_GRAZE_EPS {
                        root_hi_t = mid;
                        break;
                    }
                    if (root_lo_side < 0.0 && mid_side < 0.0)
                        || (root_lo_side > 0.0 && mid_side > 0.0)
                    {
                        root_lo_t = mid;
                        root_lo_side = mid_side;
                    } else {
                        root_hi_t = mid;
                    }
                }
                if contact
                    .as_ref()
                    .map(|hit| root_hi_t < hit.t)
                    .unwrap_or(true)
                {
                    contact = Some(ShieldFieldContact {
                        t: root_hi_t,
                        threshold: candidate,
                    });
                }
                return;
            }

            lo_t = sample_t;
            lo_side = sample_side;
        }
    };

    if projectile_radius > SHIELD_GRAZE_EPS {
        try_threshold(-projectile_radius, false);
        try_threshold(projectile_radius, false);
        try_threshold(0.0, true);
    } else {
        try_threshold(0.0, false);
    }
    let Some(contact) = contact else {
        return None;
    };
    let t = contact.t;
    let threshold = contact.threshold;
    let Some((_, normal_x, normal_y, normal_z, hit_x, hit_y, hit_z)) = shield_field_sample_at_t(
        start_x,
        start_y,
        start_z,
        end_x,
        end_y,
        end_z,
        prev_center_x,
        prev_center_y,
        prev_center_z,
        center_x,
        center_y,
        center_z,
        radius,
        t,
    ) else {
        return None;
    };
    let (surface_velocity_x, surface_velocity_y, surface_velocity_z) =
        shield_field_surface_velocity(
            hit_x,
            hit_y,
            hit_z,
            normal_x,
            normal_y,
            normal_z,
            threshold,
            prev_center_x,
            prev_center_y,
            prev_center_z,
            center_x,
            center_y,
            center_z,
            radius,
            dt_sec,
        );

    Some(ProjectileReflectorHit {
        kind: REFLECTOR_HIT_KIND_SHIELD,
        entity_id: owner_entity_id,
        panel_index: -1,
        t,
        x: hit_x,
        y: hit_y,
        z: hit_z,
        normal_x,
        normal_y,
        normal_z,
        surface_velocity_x,
        surface_velocity_y,
        surface_velocity_z,
    })
}

// Safety margin on the shield-field pair-rejection bound. The solvers'
// largest effective surface is radius + projectile_radius, and grazes are
// resolved within SHIELD_GRAZE_EPS; one world unit of extra slack keeps
// the rejection conservative against every epsilon in the solvers while
// still discarding the overwhelmingly common far-apart pairs.
const SHIELD_BROADPHASE_PAD: f64 = 1.0;

#[inline]
fn segment_point_dist_sq_3d(
    sx: f64,
    sy: f64,
    sz: f64,
    tx: f64,
    ty: f64,
    tz: f64,
    px: f64,
    py: f64,
    pz: f64,
) -> f64 {
    let dx = tx - sx;
    let dy = ty - sy;
    let dz = tz - sz;
    let len_sq = dx * dx + dy * dy + dz * dz;
    let mut t = if len_sq > 0.0 {
        ((px - sx) * dx + (py - sy) * dy + (pz - sz) * dz) / len_sq
    } else {
        0.0
    };
    t = t.clamp(0.0, 1.0);
    let ex = px - (sx + dx * t);
    let ey = py - (sy + dy * t);
    let ez = pz - (sz + dz * t);
    ex * ex + ey * ey + ez * ez
}

/// Conservative pair rejection for the per-(segment, shield-field)
/// solvers. Builds one sphere covering the shield surface at its
/// previous AND current pose: the moving-field solver evaluates the pose
/// lerped between the two. Returns false only when the segment stays
/// strictly outside that swept-sphere bound padded by the projectile
/// radius — a pair neither solver can hit.
#[inline]
fn shield_field_segment_near_pair(
    pool: &ShieldSurfacePool,
    i: usize,
    start_x: f64,
    start_y: f64,
    start_z: f64,
    end_x: f64,
    end_y: f64,
    end_z: f64,
    projectile_radius: f64,
) -> bool {
    let pad = projectile_radius.max(0.0) + SHIELD_BROADPHASE_PAD;
    let ur = pool.union_base_radius[i] + pad;
    segment_point_dist_sq_3d(
        start_x,
        start_y,
        start_z,
        end_x,
        end_y,
        end_z,
        pool.union_center_x[i],
        pool.union_center_y[i],
        pool.union_center_z[i],
    ) <= ur * ur
}

#[inline]
pub(crate) fn shield_projectile_intersection(
    start_x: f64,
    start_y: f64,
    start_z: f64,
    end_x: f64,
    end_y: f64,
    end_z: f64,
    exclude_entity_id: i32,
    exclude_panel_index: i32,
    projectile_radius: f64,
    reflection_entity: u8,
    dt_sec: f64,
    instantaneous: bool,
    max_t: f64,
) -> Option<ProjectileReflectorHit> {
    let pool = shield_pool();
    let count = pool.count as usize;
    if count == 0 {
        return None;
    }

    let mut best_t = max_t;
    let mut best: Option<ProjectileReflectorHit> = None;
    for i in 0..count {
        // Whole-entity exclusion (exclude_panel_index < 0): callers use
        // this after a field bounce so the next segment does not
        // immediately re-resolve against that same field. Beam launch
        // does not pass the source entity here; it excludes only the
        // firing body on the TypeScript side, so a turret inside its own
        // active field still reflects when the ray exits that field.
        // A panel-scoped exclusion (>= 0) leaves the entity's field
        // surfaces testable.
        if exclude_panel_index < 0 && pool.owner_entity_id[i] == exclude_entity_id {
            continue;
        }
        let reflection_mode = shield_reflection_mode_for_entity(
            reflection_entity,
            pool.field_reflection_mode_plasma[i],
            pool.field_reflection_mode_rocket[i],
            pool.field_reflection_mode_beam[i],
        );
        // Every crossing acceptance in both solvers routes through
        // shield_reflection_mode_allows_crossing, which is always false
        // for NONE — skipping here is result-identical.
        if reflection_mode == SHIELD_REFLECTION_MODE_NONE {
            continue;
        }
        // Conservative pair rejection before the analytic solvers: a
        // segment that stays outside the union bound of the shield's
        // previous and current pose (padded by the projectile radius)
        // can never produce a static contact or a moving-field crossing.
        if !shield_field_segment_near_pair(
            pool,
            i,
            start_x,
            start_y,
            start_z,
            end_x,
            end_y,
            end_z,
            projectile_radius,
        ) {
            continue;
        }
        let static_contact = shield_projectile_intersection_contact(
            start_x,
            start_y,
            start_z,
            end_x,
            end_y,
            end_z,
            pool.center_x[i],
            pool.center_y[i],
            pool.center_z[i],
            pool.radius[i],
            projectile_radius,
            reflection_mode,
        );
        let candidate = if let Some(contact) = static_contact {
            if contact.t >= best_t {
                None
            } else {
                let t = contact.t;
                let dx = end_x - start_x;
                let dy = end_y - start_y;
                let dz = end_z - start_z;
                let hit_x = start_x + dx * t;
                let hit_y = start_y + dy * t;
                let hit_z = start_z + dz * t;
                let mut normal_x = hit_x - pool.center_x[i];
                let mut normal_y = hit_y - pool.center_y[i];
                let mut normal_z = hit_z - pool.center_z[i];
                let normal_len =
                    (normal_x * normal_x + normal_y * normal_y + normal_z * normal_z).sqrt();
                let inv_normal_len = if normal_len > 1e-9 {
                    1.0 / normal_len
                } else {
                    1.0
                };
                normal_x *= inv_normal_len;
                normal_y *= inv_normal_len;
                normal_z *= inv_normal_len;
                let (surface_velocity_x, surface_velocity_y, surface_velocity_z) =
                    shield_field_surface_velocity(
                        hit_x,
                        hit_y,
                        hit_z,
                        normal_x,
                        normal_y,
                        normal_z,
                        contact.threshold,
                        pool.prev_center_x[i],
                        pool.prev_center_y[i],
                        pool.prev_center_z[i],
                        pool.center_x[i],
                        pool.center_y[i],
                        pool.center_z[i],
                        pool.radius[i],
                        dt_sec,
                    );
                Some(ProjectileReflectorHit {
                    kind: REFLECTOR_HIT_KIND_SHIELD,
                    entity_id: pool.owner_entity_id[i],
                    panel_index: -1,
                    t,
                    x: hit_x,
                    y: hit_y,
                    z: hit_z,
                    normal_x,
                    normal_y,
                    normal_z,
                    surface_velocity_x,
                    surface_velocity_y,
                    surface_velocity_z,
                })
            }
        } else if instantaneous {
            // Instantaneous beam rays resolve against the
            // current pose only. The swept prev->cur fallback below
            // exists for traveling projectiles that cross the tick; for
            // a ray it would evaluate the shield at last tick's pose
            // along the path and has no start-graze rejection, so a
            // bounced segment starting on the surface could spuriously
            // re-reflect — a second interaction that alternates with
            // the static reflect.
            None
        } else {
            shield_projectile_moving_field_hit(
                start_x,
                start_y,
                start_z,
                end_x,
                end_y,
                end_z,
                pool.prev_center_x[i],
                pool.prev_center_y[i],
                pool.prev_center_z[i],
                pool.center_x[i],
                pool.center_y[i],
                pool.center_z[i],
                pool.radius[i],
                projectile_radius,
                reflection_mode,
                pool.owner_entity_id[i],
                dt_sec,
            )
        };
        let Some(hit) = candidate else {
            continue;
        };
        if hit.t >= best_t {
            continue;
        }
        best_t = hit.t;
        best = Some(hit);
    }
    best
}

/// Direct-segment shield clearance. Returns 1 if the segment
/// (sx, sy, sz) → (tx, ty, tz) is obstructed by at most `max_crossings`
/// shield surfaces, 0 otherwise. Endpoint grazes (within SHIELD_GRAZE_EPS)
/// don't count.
///
/// Obstruction is directional for closed barriers and two-sided for panels,
/// matching what each shape does to a projectile: a dome only counts when the
/// segment ENTERS it from outside (see the outside-in note above
/// shield_segment_enters_sphere), while a flat mirror plate has no inside and
/// counts from either face. So a gunner inside a dome sees out of it, a gunner
/// outside cannot see in, and a sightline that passes clean through a dome is
/// still blocked by the inbound half of the crossing.
///
/// Materials Are Independent Of Shape: this one kernel checks both
/// shield shapes against a single crossing budget. Spheres and flat
/// panels are the same material, so an obstruction by either counts the same.
/// `include_spheres` / `include_panels` let a caller restrict the query to
/// shapes currently enabled by battle toggles.
#[wasm_bindgen]
pub fn shield_clearance_segment(
    sx: f64,
    sy: f64,
    sz: f64,
    tx: f64,
    ty: f64,
    tz: f64,
    exclude_owner_entity_id: i32,
    max_crossings: u32,
    include_spheres: u8,
    include_panels: u8,
) -> u32 {
    let pool = shield_pool();
    let mut crossings: u32 = 0;

    // ── Sphere surfaces ──
    if include_spheres != 0 {
        let count = pool.count as usize;
        let lo = SHIELD_GRAZE_EPS;
        let hi = 1.0 - SHIELD_GRAZE_EPS;
        for i in 0..count {
            if pool.owner_entity_id[i] == exclude_owner_entity_id {
                continue;
            }
            if shield_segment_enters_field(
                sx,
                sy,
                sz,
                tx,
                ty,
                tz,
                pool.center_x[i],
                pool.center_y[i],
                pool.center_z[i],
                pool.radius[i],
                lo,
                hi,
            ) {
                crossings += 1;
                if crossings > max_crossings {
                    return 0;
                }
            }
        }
    }

    // ── Rect-panel surfaces ──
    if include_panels != 0
        && !shield_panel_crossings_for_segment(
            sx,
            sy,
            sz,
            tx,
            ty,
            tz,
            exclude_owner_entity_id,
            FORCE_MATERIAL_GRAZE_EPS,
            1.0 - FORCE_MATERIAL_GRAZE_EPS,
            max_crossings,
            &mut crossings,
        )
    {
        return 0;
    }

    1
}

/// Walk every stamped mirror plate against one straight segment, adding a
/// crossing per plate the segment passes through between `lo` and `hi`
/// (fractions along the segment). Returns false the moment `max_crossings`
/// is exceeded, so callers can bail exactly as the inline walk used to.
///
/// A plate is two-sided: it has no inside, so it counts from either face.
/// This is the single panel-shape implementation — the straight-segment
/// gate and the ballistic-arc gate both walk it, because one material must
/// not answer two different ways depending on which kernel asked.
#[allow(clippy::too_many_arguments)]
fn shield_panel_crossings_for_segment(
    sx: f64,
    sy: f64,
    sz: f64,
    tx: f64,
    ty: f64,
    tz: f64,
    exclude_owner_entity_id: i32,
    lo: f64,
    hi: f64,
    max_crossings: u32,
    crossings: &mut u32,
) -> bool {
    let pool = shield_pool();
    let unit_count = pool.unit_count as usize;
    for u in 0..unit_count {
        if pool.unit_id[u] == exclude_owner_entity_id {
            continue;
        }
        let panel_count = pool.panel_count[u] as usize;
        if panel_count == 0 {
            continue;
        }
        let ux = pool.unit_x[u];
        let uy = pool.unit_y[u];
        let uz = pool.unit_z[u];
        let broad_r = pool.unit_broad_radius[u] as f64;
        if point_segment_dist_sq3(ux, uy, uz, sx, sy, sz, tx, ty, tz) > broad_r * broad_r {
            continue;
        }

        let mirror_yaw = pool.mirror_yaw[u] as f64;
        let cos_yaw = pool.mirror_cos_yaw[u];
        let sin_yaw = pool.mirror_sin_yaw[u];
        let cos_pitch = pool.mirror_cos_pitch[u];
        let sin_pitch = pool.mirror_sin_pitch[u];

        let pivot_x = pool.pivot_x[u];
        let pivot_y = pool.pivot_y[u];
        let pivot_z = pool.pivot_z[u];

        let panel_start = pool.panel_start[u] as usize;
        for pi in panel_start..panel_start + panel_count {
            // Panel arm extends from pivot along the panel-yaw / pitch
            // direction (same `a(α, β)` formula MirrorPanelHit.ts uses).
            // Per-panel lateral pivot offset goes along the chassis-
            // perpendicular axis, derived from the mirror's yaw on
            // tick (matches JS `perpX = -sinRot; perpY = cosRot`).
            let perp_x = -sin_yaw;
            let perp_y = cos_yaw;
            let offset_y = pool.panel_offset_y[pi] as f64;
            let panel_pivot_x = pivot_x + perp_x * offset_y;
            let panel_pivot_y = pivot_y + perp_y * offset_y;
            let panel_pivot_z = pivot_z;

            // Per-panel yaw composes the mirror turret yaw with the
            // panel's authored angle (typically 0).
            let panel_angle = pool.panel_angle[pi] as f64;
            let panel_yaw = mirror_yaw + panel_angle;
            let panel_cos_yaw = panel_yaw.cos();
            let panel_sin_yaw = panel_yaw.sin();

            let arm_length = pool.panel_arm_length[pi] as f64;
            let pcx = panel_pivot_x + cos_yaw * cos_pitch * arm_length;
            let pcy = panel_pivot_y + sin_yaw * cos_pitch * arm_length;
            let pcz = panel_pivot_z + sin_pitch * arm_length;

            // Panel face normal = arm direction. Using the panel's
            // composed yaw + the mirror pitch matches getMirrorArmDirection.
            let nx = panel_cos_yaw * cos_pitch;
            let ny = panel_sin_yaw * cos_pitch;
            let nz = sin_pitch;

            // Horizontal perpendicular to panel yaw (edge axis); pitch
            // rotates around this axis so it stays in the XY plane.
            let edx = -panel_sin_yaw;
            let edy = panel_cos_yaw;
            let edz = 0.0;

            let half_w = pool.panel_half_width[pi] as f64;
            let base_y = pool.panel_base_y[pi] as f64;
            let top_y = pool.panel_top_y[pi] as f64;
            let half_h = (top_y - base_y) * 0.5;

            let hit_t = ray_tilted_rect_intersection_t(
                sx, sy, sz, tx, ty, tz, pcx, pcy, pcz, nx, ny, nz, edx, edy, edz, half_w, half_h,
            );
            if let Some(t) = hit_t {
                if t > lo && t < hi {
                    *crossings += 1;
                    if *crossings > max_crossings {
                        return false;
                    }
                }
            }
        }
    }
    true
}

/// Ballistic-arc shield clearance. Approximates the parabola
/// `pos = launch + v·t − 0.5·GRAVITY·ẑ·t²` with
/// ARC_FF_CLEARANCE_SAMPLES chords and applies the same per-chord
/// obstruction rule and crossing budget as the segment kernel. Staying inside
/// one field for the whole arc is clear, and so is arcing OUT of one — a shell
/// lobbed from under a dome leaves it the same way a direct shot does. Only
/// entering a dome, or clipping a panel from either face, is blocked.
///
/// Both shapes of the one material are walked, through the same
/// `shield_panel_crossings_for_segment` the straight-segment gate uses; the
/// `include_spheres` / `include_panels` flags mean exactly what they mean
/// there. This is the descending-leg refinement's kernel and is not yet on
/// any live path — see budget_design_philosophy.html, "Obstructs direct
/// sight".
#[allow(clippy::too_many_arguments)]
#[wasm_bindgen]
pub fn shield_clearance_arc(
    launch_x: f64,
    launch_y: f64,
    launch_z: f64,
    launch_vx: f64,
    launch_vy: f64,
    launch_vz: f64,
    flight_time: f64,
    exclude_owner_entity_id: i32,
    max_crossings: u32,
    include_spheres: u8,
    include_panels: u8,
) -> u32 {
    let pool = shield_pool();
    let count = if include_spheres != 0 {
        pool.count as usize
    } else {
        0
    };
    let panel_unit_count = if include_panels != 0 {
        pool.unit_count as usize
    } else {
        0
    };
    if count == 0 && panel_unit_count == 0 {
        return 1;
    }
    if !flight_time.is_finite() || flight_time <= 0.0 {
        return 1;
    }
    let inv_n = 1.0 / ARC_FF_CLEARANCE_SAMPLES as f64;
    let mut crossings: u32 = 0;
    for f in 0..count {
        if pool.owner_entity_id[f] == exclude_owner_entity_id {
            continue;
        }
        let cx = pool.center_x[f];
        let cy = pool.center_y[f];
        let cz = pool.center_z[f];
        let r = pool.radius[f];
        let mut crossed = false;
        let mut prev_x = launch_x;
        let mut prev_y = launch_y;
        let mut prev_z = launch_z;
        for i in 1..=ARC_FF_CLEARANCE_SAMPLES {
            let t_norm = i as f64 * inv_n;
            let t = t_norm * flight_time;
            let x = launch_x + launch_vx * t;
            let y = launch_y + launch_vy * t;
            let z = launch_z + launch_vz * t - 0.5 * GRAVITY * t * t;
            let lo = if i == 1 {
                SHIELD_GRAZE_EPS
            } else {
                -SHIELD_GRAZE_EPS
            };
            let hi = if i == ARC_FF_CLEARANCE_SAMPLES {
                1.0 - SHIELD_GRAZE_EPS
            } else {
                1.0 + SHIELD_GRAZE_EPS
            };
            if shield_segment_enters_field(
                prev_x,
                prev_y,
                prev_z,
                x,
                y,
                z,
                cx,
                cy,
                cz,
                r,
                lo,
                hi,
            ) {
                crossed = true;
                break;
            }
            prev_x = x;
            prev_y = y;
            prev_z = z;
        }
        if crossed {
            crossings += 1;
            if crossings > max_crossings {
                return 0;
            }
        }
    }

    // Plates are flat and two-sided, so there is no "stayed inside" case to
    // collapse: every chord that clips one is a crossing, exactly as the
    // straight-segment gate counts it.
    if panel_unit_count > 0 {
        let mut prev_x = launch_x;
        let mut prev_y = launch_y;
        let mut prev_z = launch_z;
        for i in 1..=ARC_FF_CLEARANCE_SAMPLES {
            let t = i as f64 * inv_n * flight_time;
            let x = launch_x + launch_vx * t;
            let y = launch_y + launch_vy * t;
            let z = launch_z + launch_vz * t - 0.5 * GRAVITY * t * t;
            let lo = if i == 1 {
                FORCE_MATERIAL_GRAZE_EPS
            } else {
                -FORCE_MATERIAL_GRAZE_EPS
            };
            let hi = if i == ARC_FF_CLEARANCE_SAMPLES {
                1.0 - FORCE_MATERIAL_GRAZE_EPS
            } else {
                1.0 + FORCE_MATERIAL_GRAZE_EPS
            };
            if !shield_panel_crossings_for_segment(
                prev_x,
                prev_y,
                prev_z,
                x,
                y,
                z,
                exclude_owner_entity_id,
                lo,
                hi,
                max_crossings,
                &mut crossings,
            ) {
                return 0;
            }
            prev_x = x;
            prev_y = y;
            prev_z = z;
        }
    }
    1
}

// ─────────────────────────────────────────────────────────────────
// AIM-08.5 — Rect-panel surface setters
//
// The flat-panel shield shape is stamped into the same
// ShieldSurfacePool the sphere shape uses, through the per-unit +
// per-panel arrays:
//
//   Per-mirror-unit data: world pose, broadphase radius, slope-aware
//   mirror turret pivot, and a [panel_start, panel_count) range into
//   the per-panel data.
//
//   Per-panel data: panel geometry (arm length, lateral offset, panel
//   yaw offset, base/top Y in chassis-local space, half-width).
//
// The clearance kernel walks every unit's broadphase first, then
// dispatches to the per-panel ray-tilted-rect test for each panel.
// Crossings within FORCE_MATERIAL_GRAZE_EPS of either segment endpoint
// don't count, matching the JS-side `hasForceMirrorPanelClearance`
// behaviour so turret pose and lock-on point flicker the same way
// regardless of which path computed the gate.
// ─────────────────────────────────────────────────────────────────

pub(crate) const FORCE_MATERIAL_GRAZE_EPS: f64 = 1e-6;

#[wasm_bindgen]
pub fn shield_panel_pool_set_unit_count(count: u32) {
    let pool = shield_pool();
    pool.ensure_unit_capacity(count);
    pool.unit_count = count;
}

#[wasm_bindgen]
pub fn shield_panel_pool_set_panel_count(count: u32) {
    let pool = shield_pool();
    pool.ensure_panel_capacity(count);
    pool.total_panels = count;
    pool.panel_reflection_entity_mask = 0;
}

#[wasm_bindgen]
pub fn shield_panel_pool_set_unit(
    idx: u32,
    unit_id: i32,
    unit_x: f64,
    unit_y: f64,
    unit_z: f64,
    unit_ground_z: f64,
    unit_broad_radius: f32,
    mirror_yaw: f32,
    mirror_pitch: f32,
    pivot_x: f64,
    pivot_y: f64,
    pivot_z: f64,
    panel_start: u32,
    panel_count: u8,
) {
    let pool = shield_pool();
    pool.ensure_unit_capacity(idx + 1);
    let i = idx as usize;
    pool.unit_id[i] = unit_id;
    pool.unit_x[i] = unit_x;
    pool.unit_y[i] = unit_y;
    pool.unit_z[i] = unit_z;
    pool.unit_ground_z[i] = unit_ground_z;
    pool.unit_broad_radius[i] = unit_broad_radius;
    pool.mirror_yaw[i] = mirror_yaw;
    pool.mirror_pitch[i] = mirror_pitch;
    let yaw = mirror_yaw as f64;
    let pitch = mirror_pitch as f64;
    pool.mirror_cos_yaw[i] = yaw.cos();
    pool.mirror_sin_yaw[i] = yaw.sin();
    pool.mirror_cos_pitch[i] = pitch.cos();
    pool.mirror_sin_pitch[i] = pitch.sin();
    pool.pivot_x[i] = pivot_x;
    pool.pivot_y[i] = pivot_y;
    pool.pivot_z[i] = pivot_z;
    pool.panel_start[i] = panel_start;
    pool.panel_count[i] = panel_count;
}

#[wasm_bindgen]
pub fn shield_panel_pool_set_panel(
    idx: u32,
    arm_length: f32,
    offset_y: f32,
    panel_angle: f32,
    base_y: f32,
    top_y: f32,
    half_width: f32,
    reflection_mode_plasma: u8,
    reflection_mode_rocket: u8,
    reflection_mode_beam: u8,
) {
    let pool = shield_pool();
    pool.ensure_panel_capacity(idx + 1);
    let i = idx as usize;
    pool.panel_arm_length[i] = arm_length;
    pool.panel_offset_y[i] = offset_y;
    pool.panel_angle[i] = panel_angle;
    pool.panel_base_y[i] = base_y;
    pool.panel_top_y[i] = top_y;
    pool.panel_half_width[i] = half_width;
    pool.panel_reflection_mode_plasma[i] = reflection_mode_plasma;
    pool.panel_reflection_mode_rocket[i] = reflection_mode_rocket;
    pool.panel_reflection_mode_beam[i] = reflection_mode_beam;
    pool.panel_reflection_entity_mask |= shield_reflection_entity_mask_from_modes(
        reflection_mode_plasma,
        reflection_mode_rocket,
        reflection_mode_beam,
    );
}

#[wasm_bindgen]
pub fn shield_panel_pool_set_material_mode(reflection_mode: u8) {
    let pool = shield_pool();
    let count = pool.total_panels as usize;
    pool.panel_reflection_entity_mask = if reflection_mode == SHIELD_REFLECTION_MODE_NONE {
        0
    } else {
        SHIELD_REFLECTION_ENTITY_BIT_PLASMA
            | SHIELD_REFLECTION_ENTITY_BIT_ROCKET
            | SHIELD_REFLECTION_ENTITY_BIT_BEAM
    };
    for i in 0..count {
        pool.panel_reflection_mode_plasma[i] = reflection_mode;
        pool.panel_reflection_mode_rocket[i] = reflection_mode;
        pool.panel_reflection_mode_beam[i] = reflection_mode;
    }
}

/// Squared distance from a point to a 3D segment, used by the
/// mirror-panel broadphase. Mirrors `pointSegmentDistanceSq3` in
/// lineOfSight.ts byte-for-byte.
#[inline]
pub(crate) fn point_segment_dist_sq3(
    px: f64,
    py: f64,
    pz: f64,
    ax: f64,
    ay: f64,
    az: f64,
    bx: f64,
    by: f64,
    bz: f64,
) -> f64 {
    let abx = bx - ax;
    let aby = by - ay;
    let abz = bz - az;
    let len_sq = abx * abx + aby * aby + abz * abz;
    if len_sq <= 1e-9 {
        let dx = px - ax;
        let dy = py - ay;
        let dz = pz - az;
        return dx * dx + dy * dy + dz * dz;
    }
    let t = (((px - ax) * abx + (py - ay) * aby + (pz - az) * abz) / len_sq)
        .max(0.0)
        .min(1.0);
    let cx = ax + abx * t;
    let cy = ay + aby * t;
    let cz = az + abz * t;
    let dx = px - cx;
    let dy = py - cy;
    let dz = pz - cz;
    dx * dx + dy * dy + dz * dz
}

/// Ray-vs-tilted-rectangle intersection T (CollisionHelpers.ts port).
/// Returns `Some(t)` in [0, 1] for the first hit, or `None`.
#[inline]
pub(crate) fn ray_tilted_rect_intersection_t(
    sx: f64,
    sy: f64,
    sz: f64,
    ex: f64,
    ey: f64,
    ez: f64,
    pcx: f64,
    pcy: f64,
    pcz: f64,
    nx: f64,
    ny: f64,
    nz: f64,
    edx: f64,
    edy: f64,
    edz: f64,
    half_w: f64,
    half_h: f64,
) -> Option<f64> {
    let dx = ex - sx;
    let dy = ey - sy;
    let dz = ez - sz;
    let denom = dx * nx + dy * ny + dz * nz;
    if denom.abs() < 1e-9 {
        return None;
    }
    let t = ((pcx - sx) * nx + (pcy - sy) * ny + (pcz - sz) * nz) / denom;
    if !(0.0..=1.0).contains(&t) {
        return None;
    }
    let hx = sx + t * dx;
    let hy = sy + t * dy;
    let hz = sz + t * dz;
    let lx = hx - pcx;
    let ly = hy - pcy;
    let lz = hz - pcz;
    let along = lx * edx + ly * edy + lz * edz;
    if along < -half_w || along > half_w {
        return None;
    }
    // up-in-plane axis = n × ed
    let ux = ny * edz - nz * edy;
    let uy = nz * edx - nx * edz;
    let uz = nx * edy - ny * edx;
    let up = lx * ux + ly * uy + lz * uz;
    if up < -half_h || up > half_h {
        return None;
    }
    Some(t)
}

// The rect-panel sightline walk now lives inside the unified
// `shield_clearance_segment` (gated by `include_panels`); the
// `point_segment_dist_sq3` + `ray_tilted_rect_intersection_t` helpers above
// are shared by that kernel and the projectile-intersection kernel below.

#[inline]
pub(crate) fn shield_panel_projectile_intersection(
    sx: f64,
    sy: f64,
    sz: f64,
    tx: f64,
    ty: f64,
    tz: f64,
    exclude_unit_id: i32,
    exclude_panel_index: i32,
    _projectile_radius: f64,
    reflection_entity: u8,
    query_pad: f64,
    max_t: f64,
) -> Option<ProjectileReflectorHit> {
    let pool = shield_pool();
    let unit_count = pool.unit_count as usize;
    if unit_count == 0 {
        return None;
    }

    let dx = tx - sx;
    let dy = ty - sy;
    let dz = tz - sz;
    let extra_broad_radius = query_pad.max(0.0);
    let mut best_t = max_t;
    let mut best: Option<ProjectileReflectorHit> = None;

    for u in 0..unit_count {
        // exclude_panel_index < 0 excludes the whole unit (a projectile
        // ignoring its last reflector). >= 0 excludes only that panel,
        // so a reflected beam can still strike the mirror's other
        // panels — matching the beam tracer's re-hit semantics.
        let unit_excluded = pool.unit_id[u] == exclude_unit_id;
        if unit_excluded && exclude_panel_index < 0 {
            continue;
        }
        let panel_count = pool.panel_count[u] as usize;
        if panel_count == 0 {
            continue;
        }
        let ux = pool.unit_x[u];
        let uy = pool.unit_y[u];
        let uz = pool.unit_z[u];
        let broad_r = pool.unit_broad_radius[u] as f64 + extra_broad_radius;
        if point_segment_dist_sq3(ux, uy, uz, sx, sy, sz, tx, ty, tz) > broad_r * broad_r {
            continue;
        }

        let mirror_yaw = pool.mirror_yaw[u] as f64;
        let cos_yaw = pool.mirror_cos_yaw[u];
        let sin_yaw = pool.mirror_sin_yaw[u];
        let cos_pitch = pool.mirror_cos_pitch[u];
        let sin_pitch = pool.mirror_sin_pitch[u];
        let perp_x = -sin_yaw;
        let perp_y = cos_yaw;
        let pivot_x = pool.pivot_x[u];
        let pivot_y = pool.pivot_y[u];
        let pivot_z = pool.pivot_z[u];

        let panel_start = pool.panel_start[u] as usize;
        for pi in panel_start..panel_start + panel_count {
            if unit_excluded && (pi - panel_start) as i32 == exclude_panel_index {
                continue;
            }
            let offset_y = pool.panel_offset_y[pi] as f64;
            let panel_pivot_x = pivot_x + perp_x * offset_y;
            let panel_pivot_y = pivot_y + perp_y * offset_y;
            let panel_pivot_z = pivot_z;

            let panel_angle = pool.panel_angle[pi] as f64;
            let panel_yaw = mirror_yaw + panel_angle;
            let panel_cos_yaw = panel_yaw.cos();
            let panel_sin_yaw = panel_yaw.sin();

            let arm_length = pool.panel_arm_length[pi] as f64;
            let pcx = panel_pivot_x + cos_yaw * cos_pitch * arm_length;
            let pcy = panel_pivot_y + sin_yaw * cos_pitch * arm_length;
            let pcz = panel_pivot_z + sin_pitch * arm_length;

            let nx = panel_cos_yaw * cos_pitch;
            let ny = panel_sin_yaw * cos_pitch;
            let nz = sin_pitch;

            let edx = -panel_sin_yaw;
            let edy = panel_cos_yaw;
            let edz = 0.0;

            let half_w = pool.panel_half_width[pi] as f64;
            let base_y = pool.panel_base_y[pi] as f64;
            let top_y = pool.panel_top_y[pi] as f64;
            let half_h = (top_y - base_y) * 0.5;

            let normal_velocity = dx * nx + dy * ny + dz * nz;
            let reflection_mode = shield_reflection_mode_for_entity(
                reflection_entity,
                pool.panel_reflection_mode_plasma[pi],
                pool.panel_reflection_mode_rocket[pi],
                pool.panel_reflection_mode_beam[pi],
            );
            if !shield_reflection_mode_allows_crossing(reflection_mode, normal_velocity) {
                continue;
            }
            let Some(t) = ray_tilted_rect_intersection_t(
                sx, sy, sz, tx, ty, tz, pcx, pcy, pcz, nx, ny, nz, edx, edy, edz, half_w, half_h,
            ) else {
                continue;
            };
            if t >= best_t {
                continue;
            }
            best_t = t;
            best = Some(ProjectileReflectorHit {
                kind: REFLECTOR_HIT_KIND_SHIELD,
                entity_id: pool.unit_id[u],
                panel_index: (pi - panel_start) as i32,
                t,
                x: sx + t * dx,
                y: sy + t * dy,
                z: sz + t * dz,
                normal_x: nx,
                normal_y: ny,
                normal_z: nz,
                surface_velocity_x: 0.0,
                surface_velocity_y: 0.0,
                surface_velocity_z: 0.0,
            });
        }
    }

    best
}

/// WASM-PROJ-01/02 — batch projectile reflector intersections.
///
/// TypeScript compacts projectile sweeps into parallel arrays, calls this
/// once, then consumes the nearest reflector hit for each projectile. The
/// kernel reads the current mirror-panel and shield slabs, so the JS
/// collision path no longer walks every mirror unit or shield sphere per
/// projectile.
#[wasm_bindgen]
pub fn projectile_reflector_intersections_batch(
    count: u32,
    enabled: &[u8],
    start_x: &[f64],
    start_y: &[f64],
    start_z: &[f64],
    end_x: &[f64],
    end_y: &[f64],
    end_z: &[f64],
    projectile_radius: &[f64],
    reflection_entity: &[u8],
    exclude_entity_id: &[i32],
    exclude_panel_index: &[i32],
    turret_shield_panels_enabled: u8,
    turret_shield_spheres_enabled: u8,
    instantaneous_rays: u8,
    shield_panel_query_pad: f64,
    dt_ms: f64,
    out_kind: &mut [u8],
    out_entity_id: &mut [i32],
    out_panel_index: &mut [i32],
    out_t: &mut [f64],
    out_x: &mut [f64],
    out_y: &mut [f64],
    out_z: &mut [f64],
    out_normal_x: &mut [f64],
    out_normal_y: &mut [f64],
    out_normal_z: &mut [f64],
    out_reflect_dir_x: &mut [f64],
    out_reflect_dir_y: &mut [f64],
    out_reflect_dir_z: &mut [f64],
    out_surface_velocity_x: &mut [f64],
    out_surface_velocity_y: &mut [f64],
    out_surface_velocity_z: &mut [f64],
) {
    let n = count as usize;
    debug_assert!(enabled.len() >= n);
    debug_assert!(start_x.len() >= n);
    debug_assert!(start_y.len() >= n);
    debug_assert!(start_z.len() >= n);
    debug_assert!(end_x.len() >= n);
    debug_assert!(end_y.len() >= n);
    debug_assert!(end_z.len() >= n);
    debug_assert!(projectile_radius.len() >= n);
    debug_assert!(reflection_entity.len() >= n);
    debug_assert!(exclude_entity_id.len() >= n);
    debug_assert!(exclude_panel_index.len() >= n);
    debug_assert!(out_kind.len() >= n);
    debug_assert!(out_entity_id.len() >= n);
    debug_assert!(out_panel_index.len() >= n);
    debug_assert!(out_t.len() >= n);
    debug_assert!(out_reflect_dir_x.len() >= n);
    debug_assert!(out_reflect_dir_y.len() >= n);
    debug_assert!(out_reflect_dir_z.len() >= n);
    debug_assert!(out_x.len() >= n);
    debug_assert!(out_y.len() >= n);
    debug_assert!(out_z.len() >= n);
    debug_assert!(out_normal_x.len() >= n);
    debug_assert!(out_normal_y.len() >= n);
    debug_assert!(out_normal_z.len() >= n);
    debug_assert!(out_surface_velocity_x.len() >= n);
    debug_assert!(out_surface_velocity_y.len() >= n);
    debug_assert!(out_surface_velocity_z.len() >= n);

    let dt_sec = if dt_ms.is_finite() {
        dt_ms.max(0.0) / 1000.0
    } else {
        0.0
    };
    let (panel_reflection_entity_mask, field_reflection_entity_mask) = {
        let pool = shield_pool();
        (
            pool.panel_reflection_entity_mask,
            pool.field_reflection_entity_mask,
        )
    };

    for i in 0..n {
        out_kind[i] = REFLECTOR_HIT_KIND_NONE;
        out_entity_id[i] = -1;
        out_panel_index[i] = -1;
        out_t[i] = f64::INFINITY;
        out_x[i] = 0.0;
        out_y[i] = 0.0;
        out_z[i] = 0.0;
        out_normal_x[i] = 0.0;
        out_normal_y[i] = 0.0;
        out_normal_z[i] = 0.0;
        out_reflect_dir_x[i] = 0.0;
        out_reflect_dir_y[i] = 0.0;
        out_reflect_dir_z[i] = 0.0;
        out_surface_velocity_x[i] = 0.0;
        out_surface_velocity_y[i] = 0.0;
        out_surface_velocity_z[i] = 0.0;

        if enabled[i] == 0 {
            continue;
        }

        let sx = start_x[i];
        let sy = start_y[i];
        let sz = start_z[i];
        let tx = end_x[i];
        let ty = end_y[i];
        let tz = end_z[i];
        let radius = projectile_radius[i];
        let reflection_entity = reflection_entity[i];
        if !(sx.is_finite()
            && sy.is_finite()
            && sz.is_finite()
            && tx.is_finite()
            && ty.is_finite()
            && tz.is_finite()
            && radius.is_finite())
        {
            continue;
        }

        let reflection_entity_bit = shield_reflection_entity_bit(reflection_entity);
        if reflection_entity_bit == 0 {
            continue;
        }
        let panels_reflect_entity = turret_shield_panels_enabled != 0
            && (panel_reflection_entity_mask & reflection_entity_bit) != 0;
        let fields_reflect_entity = turret_shield_spheres_enabled != 0
            && (field_reflection_entity_mask & reflection_entity_bit) != 0;
        if !panels_reflect_entity && !fields_reflect_entity {
            continue;
        }

        let mut best: Option<ProjectileReflectorHit> = None;
        if panels_reflect_entity {
            best = shield_panel_projectile_intersection(
                sx,
                sy,
                sz,
                tx,
                ty,
                tz,
                exclude_entity_id[i],
                exclude_panel_index[i],
                radius,
                reflection_entity,
                shield_panel_query_pad,
                f64::INFINITY,
            );
        }
        let max_t = best.as_ref().map(|hit| hit.t).unwrap_or(f64::INFINITY);
        if fields_reflect_entity {
            if let Some(force_hit) = shield_projectile_intersection(
                sx,
                sy,
                sz,
                tx,
                ty,
                tz,
                exclude_entity_id[i],
                exclude_panel_index[i],
                radius,
                reflection_entity,
                dt_sec,
                instantaneous_rays != 0,
                max_t,
            ) {
                best = Some(force_hit);
            }
        }

        let Some(hit) = best else {
            continue;
        };
        out_kind[i] = hit.kind;
        out_entity_id[i] = hit.entity_id;
        out_panel_index[i] = hit.panel_index;
        out_t[i] = hit.t;
        out_x[i] = hit.x;
        out_y[i] = hit.y;
        out_z[i] = hit.z;
        out_normal_x[i] = hit.normal_x;
        out_normal_y[i] = hit.normal_y;
        out_normal_z[i] = hit.normal_z;
        // Reflected SEGMENT direction (unnormalized scale carried by the
        // caller): the one shared mirror formula, so beams and shots can
        // never disagree on the bounce.
        if let Some((rdx, rdy, rdz)) = reflect_about_normal(
            tx - sx,
            ty - sy,
            tz - sz,
            hit.normal_x,
            hit.normal_y,
            hit.normal_z,
        ) {
            let len = (rdx * rdx + rdy * rdy + rdz * rdz).sqrt();
            if len > 1e-12 {
                out_reflect_dir_x[i] = rdx / len;
                out_reflect_dir_y[i] = rdy / len;
                out_reflect_dir_z[i] = rdz / len;
            }
        }
        out_surface_velocity_x[i] = hit.surface_velocity_x;
        out_surface_velocity_y[i] = hit.surface_velocity_y;
        out_surface_velocity_z[i] = hit.surface_velocity_z;
    }
}

/// C1 projectile migration — reflection response for projectile bodies.
///
/// TypeScript still owns entity/event write-back, but the authoritative
/// numeric consequence of a reflector hit lives here: reflected velocity,
/// post-reflection position for the unused portion of the tick, and optional
/// facing rotation. Rows with invalid input or zero-length velocity/normal
/// report `out_reflected = 0`.
#[wasm_bindgen]
pub fn projectile_reflection_response_batch(
    count: u32,
    enabled: &[u8],
    hit_t: &[f64],
    hit_x: &[f64],
    hit_y: &[f64],
    hit_z: &[f64],
    velocity_x: &[f64],
    velocity_y: &[f64],
    velocity_z: &[f64],
    normal_x: &[f64],
    normal_y: &[f64],
    normal_z: &[f64],
    surface_velocity_x: &[f64],
    surface_velocity_y: &[f64],
    surface_velocity_z: &[f64],
    projectile_radius: &[f64],
    dt_ms: f64,
    reflectivity: f64,
    out_reflected: &mut [u8],
    out_pos_x: &mut [f64],
    out_pos_y: &mut [f64],
    out_pos_z: &mut [f64],
    out_velocity_x: &mut [f64],
    out_velocity_y: &mut [f64],
    out_velocity_z: &mut [f64],
    out_rotation_changed: &mut [u8],
    out_rotation: &mut [f64],
) -> u32 {
    let n = count as usize;
    if enabled.len() < n
        || hit_t.len() < n
        || hit_x.len() < n
        || hit_y.len() < n
        || hit_z.len() < n
        || velocity_x.len() < n
        || velocity_y.len() < n
        || velocity_z.len() < n
        || normal_x.len() < n
        || normal_y.len() < n
        || normal_z.len() < n
        || surface_velocity_x.len() < n
        || surface_velocity_y.len() < n
        || surface_velocity_z.len() < n
        || projectile_radius.len() < n
        || out_reflected.len() < n
        || out_pos_x.len() < n
        || out_pos_y.len() < n
        || out_pos_z.len() < n
        || out_velocity_x.len() < n
        || out_velocity_y.len() < n
        || out_velocity_z.len() < n
        || out_rotation_changed.len() < n
        || out_rotation.len() < n
    {
        return 0;
    }
    if !(dt_ms.is_finite() && reflectivity.is_finite()) {
        return 0;
    }

    let dt_sec = dt_ms.max(0.0) / 1000.0;
    let reflectivity = reflectivity.max(0.0);
    let mut processed = 0u32;

    for i in 0..n {
        out_reflected[i] = 0;
        out_pos_x[i] = 0.0;
        out_pos_y[i] = 0.0;
        out_pos_z[i] = 0.0;
        out_velocity_x[i] = 0.0;
        out_velocity_y[i] = 0.0;
        out_velocity_z[i] = 0.0;
        out_rotation_changed[i] = 0;
        out_rotation[i] = 0.0;

        if enabled[i] == 0 {
            continue;
        }

        let t = hit_t[i];
        let hx = hit_x[i];
        let hy = hit_y[i];
        let hz = hit_z[i];
        let vx = velocity_x[i];
        let vy = velocity_y[i];
        let vz = velocity_z[i];
        let nx_raw = normal_x[i];
        let ny_raw = normal_y[i];
        let nz_raw = normal_z[i];
        let svx = surface_velocity_x[i];
        let svy = surface_velocity_y[i];
        let svz = surface_velocity_z[i];
        let radius = projectile_radius[i];
        if !(t.is_finite()
            && hx.is_finite()
            && hy.is_finite()
            && hz.is_finite()
            && vx.is_finite()
            && vy.is_finite()
            && vz.is_finite()
            && nx_raw.is_finite()
            && ny_raw.is_finite()
            && nz_raw.is_finite()
            && svx.is_finite()
            && svy.is_finite()
            && svz.is_finite()
            && radius.is_finite())
        {
            continue;
        }

        let rel_vx = vx - svx;
        let rel_vy = vy - svy;
        let rel_vz = vz - svz;
        let rel_speed_sq = rel_vx * rel_vx + rel_vy * rel_vy + rel_vz * rel_vz;
        // Same shared mirror formula the beam tracer uses — beams,
        // plasma, and rockets cannot drift apart on reflection math.
        let Some((mut reflected_rel_x, mut reflected_rel_y, mut reflected_rel_z)) =
            reflect_about_normal(rel_vx, rel_vy, rel_vz, nx_raw, ny_raw, nz_raw)
        else {
            continue;
        };
        // Unit normal for the surface-offset push below (the helper
        // returning Some guarantees the normal is non-degenerate).
        let inv_normal_len = 1.0 / (nx_raw * nx_raw + ny_raw * ny_raw + nz_raw * nz_raw).sqrt();
        let nx = nx_raw * inv_normal_len;
        let ny = ny_raw * inv_normal_len;
        let nz = nz_raw * inv_normal_len;
        let reflected_len_sq = reflected_rel_x * reflected_rel_x
            + reflected_rel_y * reflected_rel_y
            + reflected_rel_z * reflected_rel_z;
        if reflected_len_sq <= 1e-18 {
            continue;
        }

        let scale = rel_speed_sq.sqrt() * reflectivity / reflected_len_sq.sqrt();
        reflected_rel_x *= scale;
        reflected_rel_y *= scale;
        reflected_rel_z *= scale;
        let rx = svx + reflected_rel_x;
        let ry = svy + reflected_rel_y;
        let rz = svz + reflected_rel_z;

        let remaining_sec = (dt_sec * (1.0 - t)).max(0.0);
        let surface_offset = 0.5_f64.max(radius.max(0.0) * 0.25);
        let reflected_normal_dot =
            reflected_rel_x * nx + reflected_rel_y * ny + reflected_rel_z * nz;
        let offset_sign = if reflected_normal_dot >= 0.0 {
            1.0
        } else {
            -1.0
        };

        out_reflected[i] = 1;
        out_velocity_x[i] = rx;
        out_velocity_y[i] = ry;
        out_velocity_z[i] = rz;
        out_pos_x[i] = hx + nx * surface_offset * offset_sign + rx * remaining_sec;
        out_pos_y[i] = hy + ny * surface_offset * offset_sign + ry * remaining_sec;
        out_pos_z[i] = hz + nz * surface_offset * offset_sign + rz * remaining_sec;

        if (rx * rx + ry * ry).sqrt() > 1e-6 {
            out_rotation_changed[i] = 1;
            out_rotation[i] = ry.atan2(rx);
        }
        processed += 1;
    }

    processed
}

#[inline]
pub(crate) fn projectile_submunition_rng_next(seed: &mut u32) -> f64 {
    *seed = seed.wrapping_add(0x6D2B79F5);
    let mut t = *seed;
    t = (t ^ (t >> 15)).wrapping_mul(t | 1);
    t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
    ((t ^ (t >> 14)) as f64) / 4294967296.0
}

pub(crate) fn projectile_submunition_unit_jitter(seed: &mut u32) -> (f64, f64, f64) {
    for _ in 0..64 {
        let mut x = projectile_submunition_rng_next(seed) * 2.0 - 1.0;
        let mut y = projectile_submunition_rng_next(seed) * 2.0 - 1.0;
        let mut z = projectile_submunition_rng_next(seed) * 2.0 - 1.0;
        let len_sq = x * x + y * y + z * z;
        if len_sq <= 1.0 && len_sq > 1e-6 {
            let inv = 1.0 / len_sq.sqrt();
            x *= inv;
            y *= inv;
            z *= inv;
            return (x, y, z);
        }
    }

    // Degenerate deterministic fallback. The rejection loop should almost
    // never exhaust, but gameplay code must not spin forever on pathological
    // seeds or future RNG changes.
    let angle = projectile_submunition_rng_next(seed) * core::f64::consts::PI * 2.0;
    (angle.cos(), angle.sin(), 0.0)
}

/// C1 projectile migration — deterministic launch velocities for
/// submunition consequences emitted by a parent projectile detonation.
///
/// TypeScript still materializes child projectile entities and network spawn
/// events, but the authoritative numeric consequence (surface reflection,
/// deterministic scatter, and child launch velocities) lives in Rust.
///
/// Two formal direction modes, selected by `has_surface_normal`:
///
/// * **Surface impact** (normal supplied) — the parent hit something. The
///   base velocity is the parent velocity reflected across the surface and
///   damped; each child then adds its scatter jitter and is folded into the
///   outgoing half-space (`v . n >= 0`) by mirroring any into-surface
///   component. Every fragment visibly bounces OFF the surface — none
///   tunnel back into the thing the parent hit.
/// * **In-flight death** (no normal) — the parent was shot down or expired
///   mid-air. The base velocity is the parent velocity unchanged; each
///   child adds its scatter jitter and is folded into the forward
///   half-space about the parent's direction of travel, so the cluster
///   carries the parent's momentum "more or less" while still spreading.
///   A near-stationary parent skips the fold (pure sphere burst).
///
/// The half-space folds mirror the velocity component rather than clamping
/// it, preserving each fragment's speed and the spread's shape.
#[wasm_bindgen]
pub fn projectile_submunition_launch_velocity_batch(
    count: u32,
    seed: u32,
    parent_velocity_x: f64,
    parent_velocity_y: f64,
    parent_velocity_z: f64,
    surface_normal_x: f64,
    surface_normal_y: f64,
    surface_normal_z: f64,
    has_surface_normal: u8,
    reflected_velocity_damper: f64,
    spread_speed_horizontal: f64,
    spread_speed_vertical: f64,
    out_velocity_x: &mut [f64],
    out_velocity_y: &mut [f64],
    out_velocity_z: &mut [f64],
) -> u32 {
    let n = count as usize;
    if out_velocity_x.len() < n || out_velocity_y.len() < n || out_velocity_z.len() < n {
        return 0;
    }
    if !(parent_velocity_x.is_finite()
        && parent_velocity_y.is_finite()
        && parent_velocity_z.is_finite()
        && surface_normal_x.is_finite()
        && surface_normal_y.is_finite()
        && surface_normal_z.is_finite()
        && reflected_velocity_damper.is_finite()
        && spread_speed_horizontal.is_finite()
        && spread_speed_vertical.is_finite())
    {
        return 0;
    }

    // Resolve the mode: a usable surface normal selects the reflection
    // model; otherwise (including a degenerate zero-length normal) the
    // cluster runs the momentum-continuation model.
    let mut fold_x = 0.0;
    let mut fold_y = 0.0;
    let mut fold_z = 0.0;
    let mut has_fold_axis = false;

    let mut bounce_x = parent_velocity_x;
    let mut bounce_y = parent_velocity_y;
    let mut bounce_z = parent_velocity_z;
    if has_surface_normal != 0 {
        let normal_len_sq = surface_normal_x * surface_normal_x
            + surface_normal_y * surface_normal_y
            + surface_normal_z * surface_normal_z;
        if normal_len_sq > 1e-9 {
            let normal_inv = 1.0 / normal_len_sq.sqrt();
            let nx = surface_normal_x * normal_inv;
            let ny = surface_normal_y * normal_inv;
            let nz = surface_normal_z * normal_inv;
            let velocity_dot_normal =
                parent_velocity_x * nx + parent_velocity_y * ny + parent_velocity_z * nz;
            let damper = reflected_velocity_damper.max(0.0);
            bounce_x = (parent_velocity_x - 2.0 * velocity_dot_normal * nx) * damper;
            bounce_y = (parent_velocity_y - 2.0 * velocity_dot_normal * ny) * damper;
            bounce_z = (parent_velocity_z - 2.0 * velocity_dot_normal * nz) * damper;
            fold_x = nx;
            fold_y = ny;
            fold_z = nz;
            has_fold_axis = true;
        }
    }
    if !has_fold_axis {
        let parent_speed_sq = parent_velocity_x * parent_velocity_x
            + parent_velocity_y * parent_velocity_y
            + parent_velocity_z * parent_velocity_z;
        if parent_speed_sq > 1e-9 {
            let inv = 1.0 / parent_speed_sq.sqrt();
            fold_x = parent_velocity_x * inv;
            fold_y = parent_velocity_y * inv;
            fold_z = parent_velocity_z * inv;
            has_fold_axis = true;
        }
    }

    let mut rng_seed = seed;
    let horizontal = spread_speed_horizontal.max(0.0);
    let vertical = spread_speed_vertical.max(0.0);
    for i in 0..n {
        let (jx, jy, jz) = projectile_submunition_unit_jitter(&mut rng_seed);
        let mut vx = bounce_x + horizontal * jx;
        let mut vy = bounce_y + horizontal * jy;
        let mut vz = bounce_z + vertical * jz;
        if has_fold_axis {
            let along = vx * fold_x + vy * fold_y + vz * fold_z;
            if along < 0.0 {
                vx -= 2.0 * along * fold_x;
                vy -= 2.0 * along * fold_y;
                vz -= 2.0 * along * fold_z;
            }
        }
        out_velocity_x[i] = vx;
        out_velocity_y[i] = vy;
        out_velocity_z[i] = vz;
    }

    count
}

pub(crate) const PROJECTILE_TERMINAL_REASON_NONE: u8 = 0;
pub(crate) const PROJECTILE_TERMINAL_REASON_EXPIRED: u8 = 1;
pub(crate) const PROJECTILE_TERMINAL_REASON_GROUND: u8 = 2;
pub(crate) const PROJECTILE_TERMINAL_REASON_WATER: u8 = 3;
pub(crate) const PROJECTILE_TERMINAL_REASON_REFLECTOR: u8 = 4;
pub(crate) const PROJECTILE_TERMINAL_REASON_HEALTH_ZERO: u8 = 5;
pub(crate) const PROJECTILE_TERMINAL_REASON_OUT_OF_BOUNDS: u8 = 6;

pub(crate) const PROJECTILE_TERMINAL_FLAG_REMOVE: u32 = 1 << 0;
pub(crate) const PROJECTILE_TERMINAL_FLAG_SET_HP_ZERO: u32 = 1 << 1;
pub(crate) const PROJECTILE_TERMINAL_FLAG_CLAMP_Z: u32 = 1 << 2;
pub(crate) const PROJECTILE_TERMINAL_FLAG_WATER_SPLASH: u32 = 1 << 3;
pub(crate) const PROJECTILE_TERMINAL_FLAG_DETONATE: u32 = 1 << 4;
pub(crate) const PROJECTILE_TERMINAL_FLAG_EXPIRE_EVENT: u32 = 1 << 5;

pub(crate) const PROJECTILE_TERMINAL_EFFECT_FLAG_QUEUE_DESPAWN: u32 = 1 << 0;
pub(crate) const PROJECTILE_TERMINAL_EFFECT_FLAG_SET_EXPLODED: u32 = 1 << 1;
pub(crate) const PROJECTILE_TERMINAL_EFFECT_FLAG_APPLY_SPLASH: u32 = 1 << 2;
pub(crate) const PROJECTILE_TERMINAL_EFFECT_FLAG_SPAWN_SUBMUNITIONS: u32 = 1 << 3;
pub(crate) const PROJECTILE_TERMINAL_EFFECT_FLAG_EMIT_HIT_EVENT: u32 = 1 << 4;
pub(crate) const PROJECTILE_TERMINAL_EFFECT_FLAG_EMIT_EXPIRE_EVENT: u32 = 1 << 5;
pub(crate) const PROJECTILE_TERMINAL_EFFECT_FLAG_EMIT_WATER_SPLASH_EVENT: u32 = 1 << 6;
pub(crate) const PROJECTILE_TERMINAL_EFFECT_FLAG_EMIT_REFLECTOR_IMPACT_EVENT: u32 = 1 << 7;

// Input bit layout for `projectile_terminal_single` — mirrored by name in
// ProjectileCollisionHandler.ts (TERMINAL_IN_*). Append-only.
pub(crate) const TERMINAL_IN_IS_PROJECTILE_TYPE: u32 = 1 << 0;
pub(crate) const TERMINAL_IN_IS_ARMED: u32 = 1 << 1;
pub(crate) const TERMINAL_IN_HAS_EXPLODED: u32 = 1 << 2;
pub(crate) const TERMINAL_IN_DETONATE_ON_ENTITY_IMPACT: u32 = 1 << 3;
pub(crate) const TERMINAL_IN_DETONATE_ON_GROUND_CONTACT: u32 = 1 << 4;
pub(crate) const TERMINAL_IN_DETONATE_ON_EXPIRY: u32 = 1 << 5;
pub(crate) const TERMINAL_IN_DETONATE_ON_DESTROYED: u32 = 1 << 6;
pub(crate) const TERMINAL_IN_DETONATE_ON_REFLECTOR_IMPACT: u32 = 1 << 7;
pub(crate) const TERMINAL_IN_DETONATE_ON_WATER_TRANSITION: u32 = 1 << 8;
pub(crate) const TERMINAL_IN_HAS_DETONATION_PAYLOAD: u32 = 1 << 9;
pub(crate) const TERMINAL_IN_DIRECT_HIT_THIS_TICK: u32 = 1 << 10;
pub(crate) const TERMINAL_IN_REFLECTED_PROJECTILE: u32 = 1 << 11;
pub(crate) const TERMINAL_IN_HIT_SHIELD: u32 = 1 << 12;
pub(crate) const TERMINAL_IN_TERMINAL_REFLECTOR_HIT: u32 = 1 << 13;
pub(crate) const TERMINAL_IN_WATER_AT_IMPACT: u32 = 1 << 14;
pub(crate) const TERMINAL_IN_WATER_SURFACE_IMPACT: u32 = 1 << 15;
pub(crate) const TERMINAL_IN_WATER_COMPATIBLE: u32 = 1 << 16;
pub(crate) const TERMINAL_IN_HAS_EXPLOSION: u32 = 1 << 17;
pub(crate) const TERMINAL_IN_HAS_SUBMUNITIONS: u32 = 1 << 18;

/// The ONE implementation of terminal-consequence classification. The batch
/// export and the scalar single both call this; out_z/out_hp are implied by
/// the returned flags (CLAMP_Z -> ground_z, SET_HP_ZERO -> 0.0), which is why
/// the scalar path needs no out slices. Returns (reason, terminal flags).
#[allow(clippy::too_many_arguments)]
#[inline]
fn projectile_terminal_consequence_row(
    is_projectile_type: bool,
    is_armed: bool,
    has_exploded: bool,
    detonate_on_entity_impact: bool,
    detonate_on_ground_contact: bool,
    detonate_on_expiry: bool,
    detonate_on_destroyed: bool,
    detonate_on_reflector_impact: bool,
    detonate_on_water_transition: bool,
    has_detonation_payload: bool,
    direct_hit_this_tick: bool,
    reflected_projectile: bool,
    hit_shield: bool,
    terminal_reflector_hit: bool,
    water_at_impact: bool,
    water_surface_impact: bool,
    water_compatible: bool,
    pos_x: f64,
    pos_y: f64,
    pos_z: f64,
    ground_z: f64,
    hp: f64,
    time_alive_ms: f64,
    max_lifespan_ms: f64,
    map_width: f64,
    map_height: f64,
    bounds_margin: f64,
) -> (u8, u32) {
    let expired = time_alive_ms >= max_lifespan_ms;

    if is_projectile_type {
        let terminal_reflector = terminal_reflector_hit;
        let hit_ground = !direct_hit_this_tick
            && !reflected_projectile
            && !hit_shield
            && is_armed
            && pos_z <= ground_z;

        let mut next_hp = hp;
        let mut flags = 0_u32;
        let terminal_water_entry = water_surface_impact;
        if terminal_water_entry && !detonate_on_water_transition {
            flags |= PROJECTILE_TERMINAL_FLAG_SET_HP_ZERO
                | PROJECTILE_TERMINAL_FLAG_REMOVE
                | PROJECTILE_TERMINAL_FLAG_WATER_SPLASH;
            return (PROJECTILE_TERMINAL_REASON_WATER, flags);
        }
        if terminal_water_entry {
            next_hp = 0.0;
            flags |= PROJECTILE_TERMINAL_FLAG_SET_HP_ZERO;
        }
        if hit_ground {
            next_hp = 0.0;
            flags |= PROJECTILE_TERMINAL_FLAG_SET_HP_ZERO | PROJECTILE_TERMINAL_FLAG_CLAMP_Z;
        }
        if terminal_reflector || (expired && detonate_on_expiry) {
            next_hp = 0.0;
            flags |= PROJECTILE_TERMINAL_FLAG_SET_HP_ZERO;
        }
        let health_zero = next_hp <= 0.0;

        if hit_ground && water_at_impact && !water_compatible && !detonate_on_water_transition {
            flags |= PROJECTILE_TERMINAL_FLAG_REMOVE | PROJECTILE_TERMINAL_FLAG_WATER_SPLASH;
            return (PROJECTILE_TERMINAL_REASON_WATER, flags);
        }

        if expired || hit_ground || terminal_reflector || terminal_water_entry || health_zero {
            flags |= PROJECTILE_TERMINAL_FLAG_REMOVE;
            let reason = if terminal_water_entry {
                PROJECTILE_TERMINAL_REASON_WATER
            } else if terminal_reflector {
                PROJECTILE_TERMINAL_REASON_REFLECTOR
            } else if hit_ground {
                PROJECTILE_TERMINAL_REASON_GROUND
            } else if expired {
                PROJECTILE_TERMINAL_REASON_EXPIRED
            } else {
                PROJECTILE_TERMINAL_REASON_HEALTH_ZERO
            };

            let policy_detonates = if terminal_water_entry {
                detonate_on_water_transition
            } else if terminal_reflector {
                detonate_on_reflector_impact
            } else if hit_ground {
                detonate_on_ground_contact
            } else if expired {
                detonate_on_expiry
            } else if direct_hit_this_tick {
                detonate_on_entity_impact
            } else {
                detonate_on_destroyed
            };
            let will_detonate = health_zero
                && policy_detonates
                && is_armed
                && !has_exploded
                && has_detonation_payload;
            if will_detonate {
                flags |= PROJECTILE_TERMINAL_FLAG_DETONATE;
            } else if is_armed && !has_exploded {
                flags |= PROJECTILE_TERMINAL_FLAG_EXPIRE_EVENT;
            }

            return (reason, flags);
        }
    } else if expired {
        return (
            PROJECTILE_TERMINAL_REASON_EXPIRED,
            PROJECTILE_TERMINAL_FLAG_REMOVE,
        );
    }

    if pos_x < -bounds_margin
        || pos_x > map_width + bounds_margin
        || pos_y < -bounds_margin
        || pos_y > map_height + bounds_margin
    {
        return (
            PROJECTILE_TERMINAL_REASON_OUT_OF_BOUNDS,
            PROJECTILE_TERMINAL_FLAG_REMOVE,
        );
    }

    (PROJECTILE_TERMINAL_REASON_NONE, 0)
}

/// The ONE implementation of terminal effect planning (see batch doc below).
#[inline]
fn projectile_terminal_effect_plan_row(
    terminal_flags: u32,
    terminal_reflector_hit: bool,
    has_explosion: bool,
    has_submunitions: bool,
) -> u32 {
    if terminal_flags & PROJECTILE_TERMINAL_FLAG_REMOVE == 0 {
        return 0;
    }
    let mut effects = PROJECTILE_TERMINAL_EFFECT_FLAG_QUEUE_DESPAWN;
    if terminal_flags & PROJECTILE_TERMINAL_FLAG_WATER_SPLASH != 0 {
        effects |= PROJECTILE_TERMINAL_EFFECT_FLAG_EMIT_WATER_SPLASH_EVENT;
        return effects;
    }
    if terminal_reflector_hit {
        effects |= PROJECTILE_TERMINAL_EFFECT_FLAG_EMIT_REFLECTOR_IMPACT_EVENT;
    }
    if terminal_flags & PROJECTILE_TERMINAL_FLAG_DETONATE != 0 {
        let splash = has_explosion;
        let submunitions = has_submunitions;
        if splash || submunitions {
            effects |= PROJECTILE_TERMINAL_EFFECT_FLAG_SET_EXPLODED
                | PROJECTILE_TERMINAL_EFFECT_FLAG_EMIT_HIT_EVENT;
            if splash {
                effects |= PROJECTILE_TERMINAL_EFFECT_FLAG_APPLY_SPLASH;
            }
            if submunitions {
                effects |= PROJECTILE_TERMINAL_EFFECT_FLAG_SPAWN_SUBMUNITIONS;
            }
        }
    }
    if terminal_flags & PROJECTILE_TERMINAL_FLAG_EXPIRE_EVENT != 0 {
        effects |= PROJECTILE_TERMINAL_EFFECT_FLAG_EMIT_EXPIRE_EVENT;
    }
    effects
}

/// Scalar merged classify+plan for ONE projectile. The count=1 "batch" calls
/// this replaces marshalled ~35 slices (malloc + copy + free each) per
/// projectile per tick; this takes one packed input bitfield (TERMINAL_IN_*)
/// plus scalars and returns reason (bits 0..2) | terminal flags << 3 |
/// effect flags << 9 — out_z/out_hp are implied by CLAMP_Z/SET_HP_ZERO.
#[wasm_bindgen]
pub fn projectile_terminal_single(
    input_bits: u32,
    pos_x: f64,
    pos_y: f64,
    pos_z: f64,
    ground_z: f64,
    hp: f64,
    time_alive_ms: f64,
    max_lifespan_ms: f64,
    map_width: f64,
    map_height: f64,
    margin: f64,
) -> u32 {
    let bit = |mask: u32| input_bits & mask != 0;
    let bounds_margin = if margin.is_finite() {
        margin.max(0.0)
    } else {
        0.0
    };
    let (reason, terminal_flags) = projectile_terminal_consequence_row(
        bit(TERMINAL_IN_IS_PROJECTILE_TYPE),
        bit(TERMINAL_IN_IS_ARMED),
        bit(TERMINAL_IN_HAS_EXPLODED),
        bit(TERMINAL_IN_DETONATE_ON_ENTITY_IMPACT),
        bit(TERMINAL_IN_DETONATE_ON_GROUND_CONTACT),
        bit(TERMINAL_IN_DETONATE_ON_EXPIRY),
        bit(TERMINAL_IN_DETONATE_ON_DESTROYED),
        bit(TERMINAL_IN_DETONATE_ON_REFLECTOR_IMPACT),
        bit(TERMINAL_IN_DETONATE_ON_WATER_TRANSITION),
        bit(TERMINAL_IN_HAS_DETONATION_PAYLOAD),
        bit(TERMINAL_IN_DIRECT_HIT_THIS_TICK),
        bit(TERMINAL_IN_REFLECTED_PROJECTILE),
        bit(TERMINAL_IN_HIT_SHIELD),
        bit(TERMINAL_IN_TERMINAL_REFLECTOR_HIT),
        bit(TERMINAL_IN_WATER_AT_IMPACT),
        bit(TERMINAL_IN_WATER_SURFACE_IMPACT),
        bit(TERMINAL_IN_WATER_COMPATIBLE),
        pos_x,
        pos_y,
        pos_z,
        ground_z,
        hp,
        time_alive_ms,
        max_lifespan_ms,
        map_width,
        map_height,
        bounds_margin,
    );
    let effect_flags = projectile_terminal_effect_plan_row(
        terminal_flags,
        bit(TERMINAL_IN_TERMINAL_REFLECTOR_HIT),
        bit(TERMINAL_IN_HAS_EXPLOSION),
        bit(TERMINAL_IN_HAS_SUBMUNITIONS),
    );
    (reason as u32) | (terminal_flags << 3) | (effect_flags << 9)
}

/// C1 projectile migration — classify terminal projectile consequences.
///
/// TypeScript still samples terrain/water inputs and applies returned entity,
/// damage, and event diffs. This kernel owns the authoritative branching for
/// timeout, ground/water impact, terminal reflector contacts, HP-zero stops,
/// detonation eligibility, expire FX eligibility, and out-of-bounds removal.
#[wasm_bindgen]
pub fn projectile_terminal_consequence_batch(
    count: u32,
    enabled: &[u8],
    is_projectile_type: &[u8],
    is_armed: &[u8],
    has_exploded: &[u8],
    detonate_on_entity_impact: &[u8],
    detonate_on_ground_contact: &[u8],
    detonate_on_expiry: &[u8],
    detonate_on_destroyed: &[u8],
    detonate_on_reflector_impact: &[u8],
    detonate_on_water_transition: &[u8],
    has_detonation_payload: &[u8],
    direct_hit_this_tick: &[u8],
    reflected_projectile: &[u8],
    hit_shield: &[u8],
    terminal_reflector_hit: &[u8],
    water_at_impact: &[u8],
    water_surface_impact: &[u8],
    water_compatible: &[u8],
    pos_x: &[f64],
    pos_y: &[f64],
    pos_z: &[f64],
    ground_z: &[f64],
    hp: &[f64],
    time_alive_ms: &[f64],
    max_lifespan_ms: &[f64],
    map_width: f64,
    map_height: f64,
    margin: f64,
    out_reason: &mut [u8],
    out_flags: &mut [u32],
    out_z: &mut [f64],
    out_hp: &mut [f64],
) -> u32 {
    let n = count as usize;
    if enabled.len() < n
        || is_projectile_type.len() < n
        || is_armed.len() < n
        || has_exploded.len() < n
        || detonate_on_entity_impact.len() < n
        || detonate_on_ground_contact.len() < n
        || detonate_on_expiry.len() < n
        || detonate_on_destroyed.len() < n
        || detonate_on_reflector_impact.len() < n
        || detonate_on_water_transition.len() < n
        || has_detonation_payload.len() < n
        || direct_hit_this_tick.len() < n
        || reflected_projectile.len() < n
        || hit_shield.len() < n
        || terminal_reflector_hit.len() < n
        || water_at_impact.len() < n
        || water_surface_impact.len() < n
        || water_compatible.len() < n
        || pos_x.len() < n
        || pos_y.len() < n
        || pos_z.len() < n
        || ground_z.len() < n
        || hp.len() < n
        || time_alive_ms.len() < n
        || max_lifespan_ms.len() < n
        || out_reason.len() < n
        || out_flags.len() < n
        || out_z.len() < n
        || out_hp.len() < n
    {
        return 0;
    }

    let bounds_margin = if margin.is_finite() {
        margin.max(0.0)
    } else {
        0.0
    };
    let mut processed = 0_u32;
    for i in 0..n {
        out_reason[i] = PROJECTILE_TERMINAL_REASON_NONE;
        out_flags[i] = 0;
        out_z[i] = pos_z[i];
        out_hp[i] = hp[i];

        if enabled[i] == 0 {
            continue;
        }

        let (reason, flags) = projectile_terminal_consequence_row(
            is_projectile_type[i] != 0,
            is_armed[i] != 0,
            has_exploded[i] != 0,
            detonate_on_entity_impact[i] != 0,
            detonate_on_ground_contact[i] != 0,
            detonate_on_expiry[i] != 0,
            detonate_on_destroyed[i] != 0,
            detonate_on_reflector_impact[i] != 0,
            detonate_on_water_transition[i] != 0,
            has_detonation_payload[i] != 0,
            direct_hit_this_tick[i] != 0,
            reflected_projectile[i] != 0,
            hit_shield[i] != 0,
            terminal_reflector_hit[i] != 0,
            water_at_impact[i] != 0,
            water_surface_impact[i] != 0,
            water_compatible[i] != 0,
            pos_x[i],
            pos_y[i],
            pos_z[i],
            ground_z[i],
            hp[i],
            time_alive_ms[i],
            max_lifespan_ms[i],
            map_width,
            map_height,
            bounds_margin,
        );
        out_reason[i] = reason;
        out_flags[i] = flags;
        // out_z / out_hp are implied by the flags (see the row fn doc).
        if flags & PROJECTILE_TERMINAL_FLAG_CLAMP_Z != 0 {
            out_z[i] = ground_z[i];
        }
        if flags & PROJECTILE_TERMINAL_FLAG_SET_HP_ZERO != 0 {
            out_hp[i] = 0.0;
        }
        if reason != PROJECTILE_TERMINAL_REASON_NONE {
            processed += 1;
        }
    }

    processed
}

/// C1 projectile migration — plan terminal side effects from classified
/// projectile terminal flags and authored payload booleans.
///
/// TypeScript still materializes events, child projectile entities, and JS graph
/// removals, but it no longer re-derives the detonation/splash/submunition/FX
/// consequence shape from a second set of branch conditions. This kernel emits a
/// compact effect bitset for each terminal row.
#[wasm_bindgen]
pub fn projectile_terminal_effect_plan_batch(
    count: u32,
    enabled: &[u8],
    terminal_flags: &[u32],
    terminal_reflector_hit: &[u8],
    has_explosion: &[u8],
    has_submunitions: &[u8],
    out_effect_flags: &mut [u32],
) -> u32 {
    let n = count as usize;
    if enabled.len() < n
        || terminal_flags.len() < n
        || terminal_reflector_hit.len() < n
        || has_explosion.len() < n
        || has_submunitions.len() < n
        || out_effect_flags.len() < n
    {
        return 0;
    }

    let mut processed = 0_u32;
    for i in 0..n {
        out_effect_flags[i] = 0;
        if enabled[i] == 0 {
            continue;
        }
        out_effect_flags[i] = projectile_terminal_effect_plan_row(
            terminal_flags[i],
            terminal_reflector_hit[i] != 0,
            has_explosion[i] != 0,
            has_submunitions[i] != 0,
        );
        processed += 1;
    }

    processed
}

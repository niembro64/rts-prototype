// damage — extracted from lib.rs (pure code motion).

#[allow(unused_imports)]
use crate::*;
#[allow(unused_imports)]
use wasm_bindgen::prelude::*;

pub(crate) const DAMAGE_TARGET_KIND_UNIT: u8 = 1;
pub(crate) const DAMAGE_TARGET_KIND_BUILDING: u8 = 2;
pub(crate) const DAMAGE_TARGET_KIND_PROJECTILE: u8 = 3;

pub(crate) const DAMAGE_APPLY_FLAG_APPLIED: u8 = 1 << 0;
pub(crate) const DAMAGE_APPLY_FLAG_KILLED: u8 = 1 << 1;

pub(crate) const DAMAGE_AREA_FLAG_SLICE_PASS: u8 = 1 << 0;
pub(crate) const DAMAGE_AREA_FLAG_OVERLAP: u8 = 1 << 1;
pub(crate) const DAMAGE_DEATH_EXPLOSION_ROW_FLAG_BODY_HIT: u8 = 1 << 2;
pub(crate) const DAMAGE_SEGMENT_HIT_FLAG_HIT: u8 = 1 << 0;

#[inline]
pub(crate) fn damage_segment_sphere_intersection_t(
    sx: f64,
    sy: f64,
    sz: f64,
    ex: f64,
    ey: f64,
    ez: f64,
    cx: f64,
    cy: f64,
    cz: f64,
    radius: f64,
) -> Option<f64> {
    let dx = ex - sx;
    let dy = ey - sy;
    let dz = ez - sz;
    let fx = sx - cx;
    let fy = sy - cy;
    let fz = sz - cz;

    let a = dx * dx + dy * dy + dz * dz;
    let b = 2.0 * (fx * dx + fy * dy + fz * dz);
    let c = fx * fx + fy * fy + fz * fz - radius * radius;
    if c <= 0.0 {
        return Some(0.0);
    }
    if a == 0.0 {
        return None;
    }

    let discriminant = b * b - 4.0 * a * c;
    if discriminant < 0.0 {
        return None;
    }

    let root = discriminant.sqrt();
    let t1 = (-b - root) / (2.0 * a);
    let t2 = (-b + root) / (2.0 * a);
    if (0.0..=1.0).contains(&t1) {
        Some(t1)
    } else if (0.0..=1.0).contains(&t2) {
        Some(t2)
    } else {
        None
    }
}

#[inline]
pub(crate) fn damage_segment_aabb_intersection_t(
    sx: f64,
    sy: f64,
    sz: f64,
    ex: f64,
    ey: f64,
    ez: f64,
    min_x: f64,
    min_y: f64,
    min_z: f64,
    max_x: f64,
    max_y: f64,
    max_z: f64,
) -> Option<f64> {
    let dx = ex - sx;
    let dy = ey - sy;
    let dz = ez - sz;
    let mut tmin = 0.0;
    let mut tmax = 1.0;

    if dx.abs() > 1e-9 {
        let mut t1 = (min_x - sx) / dx;
        let mut t2 = (max_x - sx) / dx;
        if t1 > t2 {
            core::mem::swap(&mut t1, &mut t2);
        }
        if t1 > tmin {
            tmin = t1;
        }
        if t2 < tmax {
            tmax = t2;
        }
    } else if sx < min_x || sx > max_x {
        return None;
    }
    if tmin > tmax {
        return None;
    }

    if dy.abs() > 1e-9 {
        let mut t1 = (min_y - sy) / dy;
        let mut t2 = (max_y - sy) / dy;
        if t1 > t2 {
            core::mem::swap(&mut t1, &mut t2);
        }
        if t1 > tmin {
            tmin = t1;
        }
        if t2 < tmax {
            tmax = t2;
        }
    } else if sy < min_y || sy > max_y {
        return None;
    }
    if tmin > tmax {
        return None;
    }

    if dz.abs() > 1e-9 {
        let mut t1 = (min_z - sz) / dz;
        let mut t2 = (max_z - sz) / dz;
        if t1 > t2 {
            core::mem::swap(&mut t1, &mut t2);
        }
        if t1 > tmin {
            tmin = t1;
        }
        if t2 < tmax {
            tmax = t2;
        }
    } else if sz < min_z || sz > max_z {
        return None;
    }
    if tmin > tmax || tmax < 0.0 {
        return None;
    }

    Some(tmin.max(0.0))
}

/// C1 damage migration — line/swept segment hit classifier.
///
/// TypeScript still gathers spatial candidates, resolves turret mounts, and
/// applies returned damage/event diffs. Rust owns the 3D segment-vs-sphere and
/// segment-vs-AABB hit tests used by beam endpoint damage and swept projectile
/// damage, returning one parametric hit `t` per packed target row.
#[wasm_bindgen]
pub fn damage_segment_hits_batch(
    count: u32,
    enabled: &[u8],
    target_kind: &[u8],
    start_x: f64,
    start_y: f64,
    start_z: f64,
    end_x: f64,
    end_y: f64,
    end_z: f64,
    target_x: &[f64],
    target_y: &[f64],
    target_z: &[f64],
    target_radius: &[f64],
    box_half_x: &[f64],
    box_half_y: &[f64],
    box_half_z: &[f64],
    out_flags: &mut [u8],
    out_t: &mut [f64],
) -> u32 {
    let n = count as usize;
    if enabled.len() < n
        || target_kind.len() < n
        || target_x.len() < n
        || target_y.len() < n
        || target_z.len() < n
        || target_radius.len() < n
        || box_half_x.len() < n
        || box_half_y.len() < n
        || box_half_z.len() < n
        || out_flags.len() < n
        || out_t.len() < n
    {
        return 0;
    }
    if !(start_x.is_finite()
        && start_y.is_finite()
        && start_z.is_finite()
        && end_x.is_finite()
        && end_y.is_finite()
        && end_z.is_finite())
    {
        return 0;
    }

    let mut processed = 0_u32;
    for i in 0..n {
        out_flags[i] = 0;
        out_t[i] = 0.0;
        if enabled[i] == 0 {
            continue;
        }

        let tx = target_x[i];
        let ty = target_y[i];
        let tz = target_z[i];
        if !(tx.is_finite() && ty.is_finite() && tz.is_finite()) {
            continue;
        }

        let hit_t = match target_kind[i] {
            DAMAGE_TARGET_KIND_UNIT | DAMAGE_TARGET_KIND_PROJECTILE => {
                let radius = target_radius[i].max(0.0);
                if !radius.is_finite() {
                    None
                } else {
                    damage_segment_sphere_intersection_t(
                        start_x, start_y, start_z, end_x, end_y, end_z, tx, ty, tz, radius,
                    )
                }
            }
            DAMAGE_TARGET_KIND_BUILDING => {
                let hx = box_half_x[i].max(0.0);
                let hy = box_half_y[i].max(0.0);
                let hz = box_half_z[i].max(0.0);
                if !(hx.is_finite() && hy.is_finite() && hz.is_finite()) {
                    None
                } else {
                    damage_segment_aabb_intersection_t(
                        start_x,
                        start_y,
                        start_z,
                        end_x,
                        end_y,
                        end_z,
                        tx - hx,
                        ty - hy,
                        tz - hz,
                        tx + hx,
                        ty + hy,
                        tz + hz,
                    )
                }
            }
            _ => None,
        };

        if let Some(t) = hit_t {
            out_flags[i] = DAMAGE_SEGMENT_HIT_FLAG_HIT;
            out_t[i] = t;
        }
        processed += 1;
    }

    processed
}

/// C1 damage migration - slab-driven line/swept candidate classifier.
///
/// Drop-in companion to `damage_segment_hits_batch` that reads each candidate's
/// geometry from the combat-targeting slab instead of TS-packed arrays. A row
/// addresses either an entity body (turret_idx < 0: UNIT sphere via
/// entity_radius_hitbox, SHOT sphere via entity_radius_collision, BUILDING/TOWER
/// AABB via entity_aabb_half_*) or one turret sub-hitbox (turret_idx >= 0:
/// sphere at the slab-computed turret_mount_* with turret_radius_hitbox). The
/// segment-vs-shape math is the shared damage_segment_*_intersection_t helpers,
/// so per-row out_flags/out_t is identical to `damage_segment_hits_batch`; only
/// the geometry source changes. This removes the per-turret
/// resolveWeaponWorldMount calls and the per-candidate geometry marshalling from
/// TypeScript. SHOT rows are accepted for completeness but travelling shots are
/// event-driven bodies whose live position the caller reads directly, so the
/// segment callers leave projectile rows on the array-based kernel.
#[wasm_bindgen]
pub fn damage_segment_candidates_batch(
    count: u32,
    candidate_slots: &[u32],
    turret_idx: &[i32],
    start_x: f64,
    start_y: f64,
    start_z: f64,
    end_x: f64,
    end_y: f64,
    end_z: f64,
    // Per-call inflations the array path pre-adds when packing: beam/swept add
    // sphere_inflation to UNIT/SHOT/turret sphere radii (beam width/2, or swept
    // radius); swept also adds aabb_inflation to BUILDING half-extents (line
    // damage passes 0 here, leaving building boxes raw).
    sphere_inflation: f64,
    aabb_inflation: f64,
    out_flags: &mut [u8],
    out_t: &mut [f64],
) -> u32 {
    let n = count as usize;
    if candidate_slots.len() < n || turret_idx.len() < n || out_flags.len() < n || out_t.len() < n {
        return 0;
    }
    if !(start_x.is_finite()
        && start_y.is_finite()
        && start_z.is_finite()
        && end_x.is_finite()
        && end_y.is_finite()
        && end_z.is_finite()
        && sphere_inflation.is_finite()
        && aabb_inflation.is_finite())
    {
        return 0;
    }

    let pool = combat_targeting_pool();
    let mut processed = 0_u32;
    for i in 0..n {
        out_flags[i] = 0;
        out_t[i] = 0.0;

        let slot = candidate_slots[i] as usize;
        if slot >= pool.entity_id.len() {
            continue;
        }

        let ti = turret_idx[i];
        let hit_t = if ti >= 0 {
            // Turret sub-hitbox: sphere at the slab-computed world mount.
            if (ti as u32) >= COMBAT_TARGETING_MAX_TURRETS_PER_ENTITY {
                None
            } else if slot >= pool.turret_count_per_entity.len()
                || ti as u8 >= pool.turret_count_per_entity[slot]
            {
                None
            } else {
                let gidx = combat_targeting_turret_global_idx(slot as u32, ti as u32);
                if gidx >= pool.turret_mount_x.len() {
                    None
                } else {
                    let (tx, ty, tz) =
                        combat_targeting_resolve_turret_mount_from_slab(pool, slot, ti as usize);
                    let radius = (pool.turret_radius_hitbox[gidx] + sphere_inflation).max(0.0);
                    if !(tx.is_finite() && ty.is_finite() && tz.is_finite() && radius.is_finite()) {
                        None
                    } else {
                        damage_segment_sphere_intersection_t(
                            start_x, start_y, start_z, end_x, end_y, end_z, tx, ty, tz, radius,
                        )
                    }
                }
            }
        } else {
            let tx = pool.entity_pos_x[slot];
            let ty = pool.entity_pos_y[slot];
            let tz = pool.entity_pos_z[slot];
            if !(tx.is_finite() && ty.is_finite() && tz.is_finite()) {
                None
            } else {
                match pool.entity_family[slot] {
                    CT_ENTITY_FAMILY_UNIT => {
                        let radius = (pool.entity_radius_hitbox[slot] + sphere_inflation).max(0.0);
                        if !radius.is_finite() {
                            None
                        } else {
                            damage_segment_sphere_intersection_t(
                                start_x, start_y, start_z, end_x, end_y, end_z, tx, ty, tz, radius,
                            )
                        }
                    }
                    CT_ENTITY_FAMILY_SHOT => {
                        let radius =
                            (pool.entity_radius_collision[slot] + sphere_inflation).max(0.0);
                        if !radius.is_finite() {
                            None
                        } else {
                            damage_segment_sphere_intersection_t(
                                start_x, start_y, start_z, end_x, end_y, end_z, tx, ty, tz, radius,
                            )
                        }
                    }
                    CT_ENTITY_FAMILY_BUILDING | CT_ENTITY_FAMILY_TOWER => {
                        let hx = (pool.entity_aabb_half_x[slot] + aabb_inflation).max(0.0);
                        let hy = (pool.entity_aabb_half_y[slot] + aabb_inflation).max(0.0);
                        let hz = (pool.entity_aabb_half_z[slot] + aabb_inflation).max(0.0);
                        if !(hx.is_finite() && hy.is_finite() && hz.is_finite()) {
                            None
                        } else {
                            damage_segment_aabb_intersection_t(
                                start_x,
                                start_y,
                                start_z,
                                end_x,
                                end_y,
                                end_z,
                                tx - hx,
                                ty - hy,
                                tz - hz,
                                tx + hx,
                                ty + hy,
                                tz + hz,
                            )
                        }
                    }
                    _ => None,
                }
            }
        };

        if let Some(t) = hit_t {
            out_flags[i] = DAMAGE_SEGMENT_HIT_FLAG_HIT;
            out_t[i] = t;
        }
        processed += 1;
    }

    processed
}

#[inline]
pub(crate) fn normalize_angle_pi(mut angle: f64) -> f64 {
    const PI: f64 = core::f64::consts::PI;
    const TWO_PI: f64 = core::f64::consts::PI * 2.0;
    if angle <= PI && angle >= -PI {
        return angle;
    }
    if !angle.is_finite() {
        return 0.0;
    }
    if angle > PI && angle <= PI + TWO_PI {
        return angle - TWO_PI;
    }
    if angle < -PI && angle >= -PI - TWO_PI {
        return angle + TWO_PI;
    }
    angle = (angle + PI).rem_euclid(TWO_PI) - PI;
    angle
}

#[inline]
pub(crate) fn damage_area_slice_pass(
    dx: f64,
    dy: f64,
    distance: f64,
    area_radius: f64,
    target_radius: f64,
    has_slice: bool,
    slice_direction: f64,
    slice_half_angle: f64,
) -> bool {
    if !has_slice {
        return true;
    }
    if distance > area_radius + target_radius {
        return false;
    }

    let angle_to_point = dy.atan2(dx);
    let angle_diff = normalize_angle_pi(angle_to_point - slice_direction);
    let angular_size = if distance > 0.0 {
        target_radius.atan2(distance)
    } else {
        core::f64::consts::PI
    };
    angle_diff.abs() <= slice_half_angle + angular_size
}

/// C1 damage migration — splash/area target-overlap classifier.
///
/// TypeScript still gathers spatial candidates and applies returned HP,
/// knockback, death, and event diffs. Rust owns the authoritative 3D overlap
/// tests for unit/projectile spheres, building AABBs, slice-cone filtering,
/// and normalized knockback directions used by area damage.
#[wasm_bindgen]
pub fn damage_area_overlap_batch(
    count: u32,
    enabled: &[u8],
    target_kind: &[u8],
    center_x: f64,
    center_y: f64,
    center_z: f64,
    radius: f64,
    has_slice: u8,
    slice_direction: f64,
    slice_half_angle: f64,
    target_x: &[f64],
    target_y: &[f64],
    target_z: &[f64],
    target_radius: &[f64],
    box_half_x: &[f64],
    box_half_y: &[f64],
    box_half_z: &[f64],
    out_flags: &mut [u8],
    out_dir_x: &mut [f64],
    out_dir_y: &mut [f64],
    out_dir_z: &mut [f64],
    out_distance: &mut [f64],
) -> u32 {
    let n = count as usize;
    if enabled.len() < n
        || target_kind.len() < n
        || target_x.len() < n
        || target_y.len() < n
        || target_z.len() < n
        || target_radius.len() < n
        || box_half_x.len() < n
        || box_half_y.len() < n
        || box_half_z.len() < n
        || out_flags.len() < n
        || out_dir_x.len() < n
        || out_dir_y.len() < n
        || out_dir_z.len() < n
        || out_distance.len() < n
    {
        return 0;
    }
    if !(center_x.is_finite()
        && center_y.is_finite()
        && center_z.is_finite()
        && radius.is_finite()
        && slice_direction.is_finite()
        && slice_half_angle.is_finite())
    {
        return 0;
    }

    let area_radius = radius.max(0.0);
    let use_slice = has_slice != 0;
    let mut processed = 0_u32;
    for i in 0..n {
        out_flags[i] = 0;
        out_dir_x[i] = 0.0;
        out_dir_y[i] = 0.0;
        out_dir_z[i] = 0.0;
        out_distance[i] = 0.0;

        if enabled[i] == 0 {
            continue;
        }
        let tx = target_x[i];
        let ty = target_y[i];
        let tz = target_z[i];
        let tr = target_radius[i].max(0.0);
        if !(tx.is_finite() && ty.is_finite() && tz.is_finite() && tr.is_finite()) {
            continue;
        }

        let mut flags = 0_u8;
        match target_kind[i] {
            DAMAGE_TARGET_KIND_UNIT | DAMAGE_TARGET_KIND_PROJECTILE => {
                let dx = tx - center_x;
                let dy = ty - center_y;
                let dz = tz - center_z;
                let dist_sq = dx * dx + dy * dy + dz * dz;
                let distance = dist_sq.sqrt();
                if distance > 0.0 {
                    let inv = 1.0 / distance;
                    out_dir_x[i] = dx * inv;
                    out_dir_y[i] = dy * inv;
                    out_dir_z[i] = dz * inv;
                }
                out_distance[i] = distance;

                let slice_pass = target_kind[i] == DAMAGE_TARGET_KIND_PROJECTILE
                    || damage_area_slice_pass(
                        dx,
                        dy,
                        distance,
                        area_radius,
                        tr,
                        use_slice,
                        slice_direction,
                        slice_half_angle,
                    );
                if slice_pass {
                    flags |= DAMAGE_AREA_FLAG_SLICE_PASS;
                }
                let max_dist = area_radius + tr;
                if dist_sq <= max_dist * max_dist {
                    flags |= DAMAGE_AREA_FLAG_OVERLAP;
                }
            }
            DAMAGE_TARGET_KIND_BUILDING => {
                let hx = box_half_x[i].max(0.0);
                let hy = box_half_y[i].max(0.0);
                let hz = box_half_z[i].max(0.0);
                if !(hx.is_finite() && hy.is_finite() && hz.is_finite()) {
                    continue;
                }
                let min_x = tx - hx;
                let max_x = tx + hx;
                let min_y = ty - hy;
                let max_y = ty + hy;
                let min_z = tz - hz;
                let max_z = tz + hz;
                let closest_x = center_x.clamp(min_x, max_x);
                let closest_y = center_y.clamp(min_y, max_y);
                let closest_z = center_z.clamp(min_z, max_z);
                let box_dx = center_x - closest_x;
                let box_dy = center_y - closest_y;
                let box_dz = center_z - closest_z;
                if box_dx * box_dx + box_dy * box_dy + box_dz * box_dz <= area_radius * area_radius
                {
                    flags |= DAMAGE_AREA_FLAG_OVERLAP;
                }

                let hdx = tx - center_x;
                let hdy = ty - center_y;
                let h_dist = (hdx * hdx + hdy * hdy).sqrt();
                if h_dist > 0.0 {
                    let inv = 1.0 / h_dist;
                    out_dir_x[i] = hdx * inv;
                    out_dir_y[i] = hdy * inv;
                }
                out_distance[i] = h_dist;
                if damage_area_slice_pass(
                    hdx,
                    hdy,
                    h_dist,
                    area_radius,
                    tr,
                    use_slice,
                    slice_direction,
                    slice_half_angle,
                ) {
                    flags |= DAMAGE_AREA_FLAG_SLICE_PASS;
                }
            }
            _ => {}
        }
        out_flags[i] = flags;
        processed += 1;
    }

    processed
}

/// C1 damage migration - slab-driven splash/area candidate classifier.
///
/// Drop-in companion to `damage_area_overlap_batch` that reads target
/// geometry from the combat-targeting slab by spatial-grid slot instead of
/// accepting per-row position/radius/box arrays packed in TypeScript. The
/// overlap math, slice-cone filter, and knockback-direction output are
/// identical to `damage_area_overlap_batch` (same expressions, same order),
/// so TypeScript collects one candidate slot per broadphase hit instead of
/// marshalling four geometry columns per candidate; the per-row output stays
/// the contract it already applies.
///
/// Family -> target shape mapping matches what TypeScript used to pack:
///   UNIT            -> sphere, entity_radius_hitbox
///   SHOT            -> sphere, entity_radius_collision (a shot's contact body)
///   BUILDING/TOWER  -> AABB,   entity_radius_hitbox (= targetRadius) + half-extents
/// Rows whose slot is out of range or a non-targetable family are left zeroed
/// (no overlap, no slice pass). HP / exclude / commander filtering stays in
/// TypeScript on the small returned hit set, exactly as before.
#[wasm_bindgen]
pub fn damage_area_candidates_batch(
    count: u32,
    candidate_slots: &[u32],
    center_x: f64,
    center_y: f64,
    center_z: f64,
    radius: f64,
    has_slice: u8,
    slice_direction: f64,
    slice_half_angle: f64,
    out_flags: &mut [u8],
    out_dir_x: &mut [f64],
    out_dir_y: &mut [f64],
    out_dir_z: &mut [f64],
    out_distance: &mut [f64],
) -> u32 {
    let n = count as usize;
    if candidate_slots.len() < n
        || out_flags.len() < n
        || out_dir_x.len() < n
        || out_dir_y.len() < n
        || out_dir_z.len() < n
        || out_distance.len() < n
    {
        return 0;
    }
    if !(center_x.is_finite()
        && center_y.is_finite()
        && center_z.is_finite()
        && radius.is_finite()
        && slice_direction.is_finite()
        && slice_half_angle.is_finite())
    {
        return 0;
    }

    let pool = combat_targeting_pool();
    let area_radius = radius.max(0.0);
    let use_slice = has_slice != 0;
    let mut processed = 0_u32;
    for i in 0..n {
        out_flags[i] = 0;
        out_dir_x[i] = 0.0;
        out_dir_y[i] = 0.0;
        out_dir_z[i] = 0.0;
        out_distance[i] = 0.0;

        let slot = candidate_slots[i] as usize;
        if slot >= pool.entity_id.len() {
            continue;
        }
        // Map the slab family to the same sphere/AABB shape + radius column
        // TypeScript used to pack for this candidate.
        let (target_kind, tr, hx, hy, hz) = match pool.entity_family[slot] {
            CT_ENTITY_FAMILY_UNIT => (
                DAMAGE_TARGET_KIND_UNIT,
                pool.entity_radius_hitbox[slot],
                0.0,
                0.0,
                0.0,
            ),
            CT_ENTITY_FAMILY_SHOT => (
                DAMAGE_TARGET_KIND_PROJECTILE,
                pool.entity_radius_collision[slot],
                0.0,
                0.0,
                0.0,
            ),
            CT_ENTITY_FAMILY_BUILDING | CT_ENTITY_FAMILY_TOWER => (
                DAMAGE_TARGET_KIND_BUILDING,
                pool.entity_radius_hitbox[slot],
                pool.entity_aabb_half_x[slot],
                pool.entity_aabb_half_y[slot],
                pool.entity_aabb_half_z[slot],
            ),
            _ => continue,
        };

        let tx = pool.entity_pos_x[slot];
        let ty = pool.entity_pos_y[slot];
        let tz = pool.entity_pos_z[slot];
        let tr = tr.max(0.0);
        if !(tx.is_finite() && ty.is_finite() && tz.is_finite() && tr.is_finite()) {
            continue;
        }

        let mut flags = 0_u8;
        match target_kind {
            DAMAGE_TARGET_KIND_UNIT | DAMAGE_TARGET_KIND_PROJECTILE => {
                let dx = tx - center_x;
                let dy = ty - center_y;
                let dz = tz - center_z;
                let dist_sq = dx * dx + dy * dy + dz * dz;
                let distance = dist_sq.sqrt();
                if distance > 0.0 {
                    let inv = 1.0 / distance;
                    out_dir_x[i] = dx * inv;
                    out_dir_y[i] = dy * inv;
                    out_dir_z[i] = dz * inv;
                }
                out_distance[i] = distance;

                let slice_pass = target_kind == DAMAGE_TARGET_KIND_PROJECTILE
                    || damage_area_slice_pass(
                        dx,
                        dy,
                        distance,
                        area_radius,
                        tr,
                        use_slice,
                        slice_direction,
                        slice_half_angle,
                    );
                if slice_pass {
                    flags |= DAMAGE_AREA_FLAG_SLICE_PASS;
                }
                let max_dist = area_radius + tr;
                if dist_sq <= max_dist * max_dist {
                    flags |= DAMAGE_AREA_FLAG_OVERLAP;
                }
            }
            DAMAGE_TARGET_KIND_BUILDING => {
                let hx = hx.max(0.0);
                let hy = hy.max(0.0);
                let hz = hz.max(0.0);
                if !(hx.is_finite() && hy.is_finite() && hz.is_finite()) {
                    continue;
                }
                let min_x = tx - hx;
                let max_x = tx + hx;
                let min_y = ty - hy;
                let max_y = ty + hy;
                let min_z = tz - hz;
                let max_z = tz + hz;
                let closest_x = center_x.clamp(min_x, max_x);
                let closest_y = center_y.clamp(min_y, max_y);
                let closest_z = center_z.clamp(min_z, max_z);
                let box_dx = center_x - closest_x;
                let box_dy = center_y - closest_y;
                let box_dz = center_z - closest_z;
                if box_dx * box_dx + box_dy * box_dy + box_dz * box_dz <= area_radius * area_radius
                {
                    flags |= DAMAGE_AREA_FLAG_OVERLAP;
                }

                let hdx = tx - center_x;
                let hdy = ty - center_y;
                let h_dist = (hdx * hdx + hdy * hdy).sqrt();
                if h_dist > 0.0 {
                    let inv = 1.0 / h_dist;
                    out_dir_x[i] = hdx * inv;
                    out_dir_y[i] = hdy * inv;
                }
                out_distance[i] = h_dist;
                if damage_area_slice_pass(
                    hdx,
                    hdy,
                    h_dist,
                    area_radius,
                    tr,
                    use_slice,
                    slice_direction,
                    slice_half_angle,
                ) {
                    flags |= DAMAGE_AREA_FLAG_SLICE_PASS;
                }
            }
            _ => {}
        }
        out_flags[i] = flags;
        processed += 1;
    }

    processed
}

/// C1 damage migration - slab-driven area turret sub-hitbox overlap.
///
/// Companion for applyAreaDamage's legacy fallback: TypeScript already uses
/// damage_area_candidates_batch for the unit body row, and only checks turret
/// sub-hitboxes when that body row did not overlap. This kernel keeps that
/// control flow but reads the turret mount/radius from CombatTargetingPool
/// instead of calling resolveWeaponWorldMount in TypeScript. It intentionally
/// reports only DAMAGE_AREA_FLAG_OVERLAP; the caller preserves the existing
/// body-row slice gate and knockback direction semantics.
#[wasm_bindgen]
pub fn damage_area_turret_candidates_batch(
    count: u32,
    candidate_slots: &[u32],
    turret_idx: &[i32],
    center_x: f64,
    center_y: f64,
    center_z: f64,
    radius: f64,
    out_flags: &mut [u8],
) -> u32 {
    let n = count as usize;
    if candidate_slots.len() < n || turret_idx.len() < n || out_flags.len() < n {
        return 0;
    }
    if !(center_x.is_finite() && center_y.is_finite() && center_z.is_finite() && radius.is_finite())
    {
        return 0;
    }

    let pool = combat_targeting_pool();
    let area_radius = radius.max(0.0);
    let mut processed = 0_u32;
    for i in 0..n {
        out_flags[i] = 0;

        let slot = candidate_slots[i] as usize;
        if slot >= pool.entity_id.len() {
            continue;
        }
        let ti = turret_idx[i];
        if ti < 0 || (ti as u32) >= COMBAT_TARGETING_MAX_TURRETS_PER_ENTITY {
            processed += 1;
            continue;
        }
        if slot >= pool.turret_count_per_entity.len()
            || ti as u8 >= pool.turret_count_per_entity[slot]
        {
            processed += 1;
            continue;
        }

        let gidx = combat_targeting_turret_global_idx(slot as u32, ti as u32);
        if gidx >= pool.turret_mount_x.len() {
            continue;
        }
        let (tx, ty, tz) = combat_targeting_resolve_turret_mount_from_slab(pool, slot, ti as usize);
        let tr = pool.turret_radius_hitbox[gidx].max(0.0);
        if !(tx.is_finite() && ty.is_finite() && tz.is_finite() && tr.is_finite()) {
            processed += 1;
            continue;
        }

        let dx = tx - center_x;
        let dy = ty - center_y;
        let dz = tz - center_z;
        let max_dist = area_radius + tr;
        if dx * dx + dy * dy + dz * dz <= max_dist * max_dist {
            out_flags[i] = DAMAGE_AREA_FLAG_OVERLAP;
        }
        processed += 1;
    }

    processed
}

#[inline]
pub(crate) fn damage_area_classify_slab_body(
    pool: &CombatTargetingPool,
    slot: usize,
    center_x: f64,
    center_y: f64,
    center_z: f64,
    radius: f64,
) -> Option<(u8, u8, f64, f64, f64, f64)> {
    if slot >= pool.entity_id.len() {
        return None;
    }

    let target_kind = match pool.entity_family[slot] {
        CT_ENTITY_FAMILY_UNIT => DAMAGE_TARGET_KIND_UNIT,
        CT_ENTITY_FAMILY_BUILDING | CT_ENTITY_FAMILY_TOWER => DAMAGE_TARGET_KIND_BUILDING,
        _ => return None,
    };
    let tx = pool.entity_pos_x[slot];
    let ty = pool.entity_pos_y[slot];
    let tz = pool.entity_pos_z[slot];
    if !(tx.is_finite() && ty.is_finite() && tz.is_finite()) {
        return None;
    }

    let area_radius = radius.max(0.0);
    let mut flags = DAMAGE_AREA_FLAG_SLICE_PASS;
    let mut dir_x = 0.0;
    let mut dir_y = 0.0;
    let mut dir_z = 0.0;
    let distance;

    match target_kind {
        DAMAGE_TARGET_KIND_UNIT => {
            let tr = pool.entity_radius_hitbox[slot].max(0.0);
            if !tr.is_finite() {
                return None;
            }
            let dx = tx - center_x;
            let dy = ty - center_y;
            let dz = tz - center_z;
            let dist_sq = dx * dx + dy * dy + dz * dz;
            distance = dist_sq.sqrt();
            if distance > 0.0 {
                let inv = 1.0 / distance;
                dir_x = dx * inv;
                dir_y = dy * inv;
                dir_z = dz * inv;
            }
            let max_dist = area_radius + tr;
            if dist_sq <= max_dist * max_dist {
                flags |= DAMAGE_AREA_FLAG_OVERLAP;
            }
        }
        DAMAGE_TARGET_KIND_BUILDING => {
            let hx = pool.entity_aabb_half_x[slot].max(0.0);
            let hy = pool.entity_aabb_half_y[slot].max(0.0);
            let hz = pool.entity_aabb_half_z[slot].max(0.0);
            if !(hx.is_finite() && hy.is_finite() && hz.is_finite()) {
                return None;
            }

            let min_x = tx - hx;
            let max_x = tx + hx;
            let min_y = ty - hy;
            let max_y = ty + hy;
            let min_z = tz - hz;
            let max_z = tz + hz;
            let closest_x = center_x.clamp(min_x, max_x);
            let closest_y = center_y.clamp(min_y, max_y);
            let closest_z = center_z.clamp(min_z, max_z);
            let box_dx = center_x - closest_x;
            let box_dy = center_y - closest_y;
            let box_dz = center_z - closest_z;
            if box_dx * box_dx + box_dy * box_dy + box_dz * box_dz <= area_radius * area_radius {
                flags |= DAMAGE_AREA_FLAG_OVERLAP;
            }

            let hdx = tx - center_x;
            let hdy = ty - center_y;
            let h_dist = (hdx * hdx + hdy * hdy).sqrt();
            if h_dist > 0.0 {
                let inv = 1.0 / h_dist;
                dir_x = hdx * inv;
                dir_y = hdy * inv;
            }
            distance = h_dist;
        }
        _ => return None,
    }

    Some((target_kind, flags, dir_x, dir_y, dir_z, distance))
}

#[inline]
pub(crate) fn damage_death_explosion_turret_overlaps(
    pool: &CombatTargetingPool,
    slot: usize,
    turret_idx: usize,
    center_x: f64,
    center_y: f64,
    center_z: f64,
    radius: f64,
) -> bool {
    if turret_idx as u32 >= COMBAT_TARGETING_MAX_TURRETS_PER_ENTITY {
        return false;
    }
    if slot >= pool.turret_count_per_entity.len()
        || turret_idx as u8 >= pool.turret_count_per_entity[slot]
    {
        return false;
    }
    let gidx = combat_targeting_turret_global_idx(slot as u32, turret_idx as u32);
    if gidx >= pool.turret_entity_id.len() || pool.turret_entity_id[gidx] < 0 {
        return false;
    }
    if (pool.turret_config_flags[gidx] & CT_TURRET_CFG_VISUAL_ONLY) != 0 {
        return false;
    }

    let (tx, ty, tz) = combat_targeting_resolve_turret_mount_from_slab(pool, slot, turret_idx);
    let tr = pool.turret_radius_hitbox[gidx].max(0.0);
    if !(tx.is_finite() && ty.is_finite() && tz.is_finite() && tr.is_finite()) {
        return false;
    }

    let dx = tx - center_x;
    let dy = ty - center_y;
    let dz = tz - center_z;
    let max_dist = radius.max(0.0) + tr;
    dx * dx + dy * dy + dz * dz <= max_dist * max_dist
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn damage_death_explosion_count_slot_rows(
    pool: &CombatTargetingPool,
    slot: usize,
    center_x: f64,
    center_y: f64,
    center_z: f64,
    radius: f64,
) -> usize {
    let Some((target_kind, flags, _, _, _, _)) =
        damage_area_classify_slab_body(pool, slot, center_x, center_y, center_z, radius)
    else {
        return 0;
    };
    if (flags & DAMAGE_AREA_FLAG_SLICE_PASS) == 0 {
        return 0;
    }
    if target_kind == DAMAGE_TARGET_KIND_BUILDING {
        return if (flags & DAMAGE_AREA_FLAG_OVERLAP) != 0 {
            1
        } else {
            0
        };
    }
    if target_kind != DAMAGE_TARGET_KIND_UNIT {
        return 0;
    }
    if (flags & DAMAGE_AREA_FLAG_OVERLAP) != 0 {
        return 1;
    }

    let turret_count = if slot < pool.turret_count_per_entity.len() {
        pool.turret_count_per_entity[slot] as usize
    } else {
        0
    }
    .min(COMBAT_TARGETING_MAX_TURRETS_PER_ENTITY as usize);
    let mut rows = 0_usize;
    for turret_idx in 0..turret_count {
        if damage_death_explosion_turret_overlaps(
            pool, slot, turret_idx, center_x, center_y, center_z, radius,
        ) {
            rows += 1;
        }
    }
    rows
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn damage_death_explosion_write_slot_rows(
    pool: &CombatTargetingPool,
    slot_u32: u32,
    center_x: f64,
    center_y: f64,
    center_z: f64,
    radius: f64,
    out_slots: &mut [u32],
    out_target_kind: &mut [u8],
    out_flags: &mut [u8],
    out_dir_x: &mut [f64],
    out_dir_y: &mut [f64],
    out_dir_z: &mut [f64],
    out_distance: &mut [f64],
    row: &mut usize,
) {
    let slot = slot_u32 as usize;
    let Some((target_kind, flags, dir_x, dir_y, dir_z, distance)) =
        damage_area_classify_slab_body(pool, slot, center_x, center_y, center_z, radius)
    else {
        return;
    };
    if (flags & DAMAGE_AREA_FLAG_SLICE_PASS) == 0 {
        return;
    }

    if target_kind == DAMAGE_TARGET_KIND_BUILDING {
        if (flags & DAMAGE_AREA_FLAG_OVERLAP) == 0 {
            return;
        }
        let i = *row;
        out_slots[i] = slot_u32;
        out_target_kind[i] = target_kind;
        out_flags[i] = flags | DAMAGE_DEATH_EXPLOSION_ROW_FLAG_BODY_HIT;
        out_dir_x[i] = dir_x;
        out_dir_y[i] = dir_y;
        out_dir_z[i] = dir_z;
        out_distance[i] = distance;
        *row += 1;
        return;
    }

    if target_kind != DAMAGE_TARGET_KIND_UNIT {
        return;
    }
    if (flags & DAMAGE_AREA_FLAG_OVERLAP) != 0 {
        let i = *row;
        out_slots[i] = slot_u32;
        out_target_kind[i] = target_kind;
        out_flags[i] = flags | DAMAGE_DEATH_EXPLOSION_ROW_FLAG_BODY_HIT;
        out_dir_x[i] = dir_x;
        out_dir_y[i] = dir_y;
        out_dir_z[i] = dir_z;
        out_distance[i] = distance;
        *row += 1;
        return;
    }

    let turret_count = if slot < pool.turret_count_per_entity.len() {
        pool.turret_count_per_entity[slot] as usize
    } else {
        0
    }
    .min(COMBAT_TARGETING_MAX_TURRETS_PER_ENTITY as usize);
    for turret_idx in 0..turret_count {
        if !damage_death_explosion_turret_overlaps(
            pool, slot, turret_idx, center_x, center_y, center_z, radius,
        ) {
            continue;
        }
        let i = *row;
        out_slots[i] = slot_u32;
        out_target_kind[i] = DAMAGE_TARGET_KIND_UNIT;
        out_flags[i] = DAMAGE_AREA_FLAG_SLICE_PASS | DAMAGE_AREA_FLAG_OVERLAP;
        out_dir_x[i] = dir_x;
        out_dir_y[i] = dir_y;
        out_dir_z[i] = dir_z;
        out_distance[i] = distance;
        *row += 1;
    }
}

/// C1 death-explosion migration — broadphase + slab-backed unit/building
/// candidate classification for one death blast.
///
/// TypeScript still owns chaining, live HP write-back, projectile live-geometry
/// rows, death/audio events, and entity removal. This kernel moves the
/// per-blast unit/building spatial traversal into Rust and returns compact
/// rows addressed by spatial/combat slab slot. Unit body rows and building rows
/// carry DAMAGE_DEATH_EXPLOSION_ROW_FLAG_BODY_HIT; unit turret-fallback rows do
/// not, matching the old TypeScript behavior where turret-only hits damaged the
/// host but did not apply body knockback.
#[wasm_bindgen]
pub fn damage_death_explosion_candidates_batch(
    center_x: f64,
    center_y: f64,
    center_z: f64,
    radius: f64,
    query_radius: f64,
    max_rows: u32,
    out_slots: &mut [u32],
    out_target_kind: &mut [u8],
    out_flags: &mut [u8],
    out_dir_x: &mut [f64],
    out_dir_y: &mut [f64],
    out_dir_z: &mut [f64],
    out_distance: &mut [f64],
    out_count: &mut [u32],
) -> u32 {
    if out_count.is_empty() {
        return 0;
    }
    out_count[0] = 0;
    if !(center_x.is_finite()
        && center_y.is_finite()
        && center_z.is_finite()
        && radius.is_finite()
        && query_radius.is_finite())
    {
        return 0;
    }

    let capacity = (max_rows as usize)
        .min(out_slots.len())
        .min(out_target_kind.len())
        .min(out_flags.len())
        .min(out_dir_x.len())
        .min(out_dir_y.len())
        .min(out_dir_z.len())
        .min(out_distance.len());

    let state = spatial_grid();
    state.scratch_u32.clear();
    state.dedup.clear();
    spatial_collect_cells_in_radius(state, center_x, center_y, center_z, query_radius.max(0.0));
    let query_radius_sq = query_radius.max(0.0) * query_radius.max(0.0);
    let nearby = std::mem::take(&mut state.nearby_cells);
    let mut slots = std::mem::take(&mut state.scratch_u32);
    let mut dedup = std::mem::take(&mut state.dedup);

    for key in &nearby {
        if let Some(bucket) = state.cells.get(key) {
            for &slot in &bucket.units {
                spatial_push_unit_if_in_radius(
                    state,
                    &mut slots,
                    slot,
                    center_x,
                    center_y,
                    center_z,
                    query_radius.max(0.0),
                    query_radius_sq,
                    0,
                    false,
                    false,
                    false,
                );
            }
        }
    }
    for key in &nearby {
        if let Some(bucket) = state.cells.get(key) {
            for &slot in &bucket.buildings {
                spatial_push_building_if_in_radius(
                    state,
                    &mut dedup,
                    &mut slots,
                    slot,
                    center_x,
                    center_y,
                    center_z,
                    query_radius_sq,
                    0,
                    false,
                    false,
                );
            }
        }
    }
    state.nearby_cells = nearby;
    state.dedup = dedup;
    state.scratch_u32 = slots;

    let pool = combat_targeting_pool();
    let mut needed = 0_usize;
    for &slot in &state.scratch_u32 {
        needed += damage_death_explosion_count_slot_rows(
            pool,
            slot as usize,
            center_x,
            center_y,
            center_z,
            radius,
        );
    }
    out_count[0] = needed as u32;
    if needed > capacity {
        return 0;
    }

    let mut row = 0_usize;
    for &slot in &state.scratch_u32 {
        damage_death_explosion_write_slot_rows(
            pool,
            slot,
            center_x,
            center_y,
            center_z,
            radius,
            out_slots,
            out_target_kind,
            out_flags,
            out_dir_x,
            out_dir_y,
            out_dir_z,
            out_distance,
            &mut row,
        );
    }
    row as u32
}

pub(crate) const DEATH_EXPLOSION_WORK_KIND_UNIT: u8 = 1;
pub(crate) const DEATH_EXPLOSION_WORK_KIND_BUILDING: u8 = 2;

#[derive(Default)]
pub(crate) struct DeathExplosionPlanner {
    queue_entity_ids: Vec<i32>,
    queue_kind: Vec<u8>,
    read_index: usize,
    queued_ids: HashSet<i32>,
    detonated_ids: HashSet<i32>,
}

impl DeathExplosionPlanner {
    pub(crate) fn reset(&mut self) {
        self.queue_entity_ids.clear();
        self.queue_kind.clear();
        self.read_index = 0;
        self.queued_ids.clear();
        self.detonated_ids.clear();
    }

    pub(crate) fn enqueue_one(&mut self, entity_id: i32, kind: u8) -> bool {
        if self.detonated_ids.contains(&entity_id) || self.queued_ids.contains(&entity_id) {
            return false;
        }
        self.queued_ids.insert(entity_id);
        self.queue_entity_ids.push(entity_id);
        self.queue_kind.push(kind);
        true
    }

    pub(crate) fn enqueue_many(&mut self, entity_ids: &[i32], kind: u8) -> u32 {
        let mut appended = 0_u32;
        for &entity_id in entity_ids {
            if self.enqueue_one(entity_id, kind) {
                appended += 1;
            }
        }
        appended
    }

    pub(crate) fn next(&mut self, out_entity_ids: &mut [i32], out_kind: &mut [u8]) -> u32 {
        if out_entity_ids.is_empty() || out_kind.is_empty() {
            return 0;
        }
        while self.read_index < self.queue_entity_ids.len() {
            let idx = self.read_index;
            self.read_index += 1;
            let entity_id = self.queue_entity_ids[idx];
            if self.detonated_ids.contains(&entity_id) {
                continue;
            }
            self.detonated_ids.insert(entity_id);
            out_entity_ids[0] = entity_id;
            out_kind[0] = self.queue_kind[idx];
            return 1;
        }
        0
    }
}

pub(crate) struct DeathExplosionPlannerHolder(UnsafeCell<Option<DeathExplosionPlanner>>);
unsafe impl Sync for DeathExplosionPlannerHolder {}
pub(crate) static DEATH_EXPLOSION_PLANNER: DeathExplosionPlannerHolder =
    DeathExplosionPlannerHolder(UnsafeCell::new(None));

pub(crate) fn death_explosion_planner() -> &'static mut DeathExplosionPlanner {
    unsafe {
        let cell = &mut *DEATH_EXPLOSION_PLANNER.0.get();
        if cell.is_none() {
            *cell = Some(DeathExplosionPlanner::default());
        }
        cell.as_mut().unwrap()
    }
}

/// C1 death-explosion chaining planner reset. Called once per combat tick;
/// the planner then persists across collision and cleanup death passes in
/// that tick so an entity death blast can never detonate twice.
#[wasm_bindgen]
pub fn death_explosion_planner_reset() {
    death_explosion_planner().reset();
}

/// Seed the death-explosion planner with the initial deaths for a pass.
/// Unit ids are enqueued before building ids to match the legacy TS queue.
#[wasm_bindgen]
pub fn death_explosion_planner_seed(unit_ids: &[i32], building_ids: &[i32]) -> u32 {
    let planner = death_explosion_planner();
    planner.enqueue_many(unit_ids, DEATH_EXPLOSION_WORK_KIND_UNIT)
        + planner.enqueue_many(building_ids, DEATH_EXPLOSION_WORK_KIND_BUILDING)
}

/// Feed newly killed unit/building ids back into the death-explosion planner
/// after TypeScript has applied one blast's HP diffs. This preserves the
/// previous breadth-first chain order: killed units first, then buildings.
#[wasm_bindgen]
pub fn death_explosion_planner_append_kills(unit_ids: &[i32], building_ids: &[i32]) -> u32 {
    death_explosion_planner_seed(unit_ids, building_ids)
}

/// Return the next compact death-blast work row.
///
/// out_entity_ids[0] = entity id, out_kind[0] = 1 unit / 2 building.
/// Returns 1 when a row was written, 0 when the queue is drained.
#[wasm_bindgen]
pub fn death_explosion_planner_next(out_entity_ids: &mut [i32], out_kind: &mut [u8]) -> u32 {
    death_explosion_planner().next(out_entity_ids, out_kind)
}

/// C1 damage migration — authoritative HP write-back math.
///
/// TypeScript still gathers hit candidates and applies the returned entity
/// diffs, but Rust owns the target-kind damage adjustment, next-HP value, and
/// death classification. This keeps projectile splash, direct hits, and death
/// explosions on one shared write-back contract while the larger ECS migration
/// is still underway.
#[wasm_bindgen]
pub fn damage_apply_batch(
    count: u32,
    enabled: &[u8],
    target_kind: &[u8],
    hp: &[f64],
    damage: &[f64],
    building_fortified: &[u8],
    building_damage_multiplier: f64,
    out_hp: &mut [f64],
    out_effective_damage: &mut [f64],
    out_flags: &mut [u8],
) -> u32 {
    let n = count as usize;
    if enabled.len() < n
        || target_kind.len() < n
        || hp.len() < n
        || damage.len() < n
        || building_fortified.len() < n
        || out_hp.len() < n
        || out_effective_damage.len() < n
        || out_flags.len() < n
    {
        return 0;
    }

    let building_multiplier = if building_damage_multiplier.is_finite() {
        building_damage_multiplier
    } else {
        1.0
    };

    let mut processed = 0_u32;
    for i in 0..n {
        out_hp[i] = hp[i];
        out_effective_damage[i] = 0.0;
        out_flags[i] = 0;

        if enabled[i] == 0 || hp[i] <= 0.0 {
            continue;
        }

        let kind = target_kind[i];
        if kind != DAMAGE_TARGET_KIND_UNIT
            && kind != DAMAGE_TARGET_KIND_BUILDING
            && kind != DAMAGE_TARGET_KIND_PROJECTILE
        {
            continue;
        }

        let multiplier = if kind == DAMAGE_TARGET_KIND_BUILDING && building_fortified[i] != 0 {
            building_multiplier
        } else {
            1.0
        };
        let effective_damage = damage[i] * multiplier;
        let next_hp = hp[i] - effective_damage;

        out_hp[i] = next_hp;
        out_effective_damage[i] = effective_damage;
        let mut flags = DAMAGE_APPLY_FLAG_APPLIED;
        if next_hp <= 0.0 {
            flags |= DAMAGE_APPLY_FLAG_KILLED;
        }
        out_flags[i] = flags;
        processed += 1;
    }

    processed
}

pub(crate) const DEATH_CLEANUP_KIND_UNIT: u8 = 1;
pub(crate) const DEATH_CLEANUP_KIND_BUILDING: u8 = 2;

/// C1 death-cleanup migration — generate compact cleanup-removal diffs from
/// pending HP-change rows.
///
/// TypeScript still drains the pending-id set and applies removal/event side
/// effects to the JS entity graph. Rust owns the authoritative dead/alive
/// decision and the compact dead-id/kind diff generation for safety-cleanup
/// candidates so unit/building HP semantics do not drift from the rest of the
/// C1 damage write-back path.
#[wasm_bindgen]
pub fn death_cleanup_diff_batch(
    count: u32,
    enabled: &[u8],
    entity_ids: &[i32],
    entity_kind: &[u8],
    hp: &[f64],
    unit_materialized: &[u8],
    out_dead_entity_ids: &mut [i32],
    out_dead_kind: &mut [u8],
    out_dead_count: &mut [u32],
) -> u32 {
    let n = count as usize;
    if enabled.len() < n
        || entity_ids.len() < n
        || entity_kind.len() < n
        || hp.len() < n
        || unit_materialized.len() < n
        || out_dead_entity_ids.len() < n
        || out_dead_kind.len() < n
        || out_dead_count.is_empty()
    {
        return 0;
    }

    let mut processed = 0_u32;
    let mut dead_count = 0_usize;
    out_dead_count[0] = 0;
    for i in 0..n {
        if enabled[i] == 0 {
            continue;
        }

        match entity_kind[i] {
            DEATH_CLEANUP_KIND_UNIT => {
                if hp[i] <= 0.0 && unit_materialized[i] != 0 {
                    out_dead_entity_ids[dead_count] = entity_ids[i];
                    out_dead_kind[dead_count] = DEATH_CLEANUP_KIND_UNIT;
                    dead_count += 1;
                }
                processed += 1;
            }
            DEATH_CLEANUP_KIND_BUILDING => {
                if hp[i] <= 0.0 {
                    out_dead_entity_ids[dead_count] = entity_ids[i];
                    out_dead_kind[dead_count] = DEATH_CLEANUP_KIND_BUILDING;
                    dead_count += 1;
                }
                processed += 1;
            }
            _ => {}
        }
    }

    out_dead_count[0] = dead_count as u32;
    processed
}

/// Factory construction-site placement kernel. TypeScript supplies the
/// authored footprint/radius constants and current factory/rally state;
/// Rust owns the direction normalization, footprint-edge projection,
/// construction-radius clamp, and optional map clamp.
///
/// out[0..7] = x, y, local_x, local_y, dir_x, dir_y, offset.
#[wasm_bindgen]
pub fn factory_build_spot(
    factory_x: f64,
    factory_y: f64,
    rally_x: f64,
    rally_y: f64,
    fallback_dir_x: f64,
    fallback_dir_y: f64,
    unit_radius: f64,
    footprint_width: f64,
    footprint_height: f64,
    construction_radius: f64,
    build_clearance: f64,
    build_radius_fraction: f64,
    map_width: f64,
    map_height: f64,
    clamp_radius: f64,
    out: &mut [f64],
) -> u32 {
    if out.len() < 7 {
        return 0;
    }

    let mut dx = rally_x - factory_x;
    let mut dy = rally_y - factory_y;
    let mut len = (dx * dx + dy * dy).sqrt();
    if len < 1.0e-3 {
        dx = fallback_dir_x;
        dy = fallback_dir_y;
        len = 1.0e-3_f64.max((dx * dx + dy * dy).sqrt());
    }

    let dir_x = dx / len;
    let dir_y = dy / len;
    let edge_x = if dir_x.abs() > 1.0e-3 {
        footprint_width * 0.5 / dir_x.abs()
    } else {
        f64::INFINITY
    };
    let edge_y = if dir_y.abs() > 1.0e-3 {
        footprint_height * 0.5 / dir_y.abs()
    } else {
        f64::INFINITY
    };
    let edge_along_dir = js_min(edge_x, edge_y);
    let outside_footprint = edge_along_dir + js_max(0.0, unit_radius) + build_clearance;
    let preferred_offset = construction_radius * build_radius_fraction;
    let offset = js_min(
        construction_radius,
        js_max(outside_footprint, preferred_offset),
    );
    let local_x = dir_x * offset;
    let local_y = dir_y * offset;
    let mut x = factory_x + local_x;
    let mut y = factory_y + local_y;

    if map_width.is_finite() {
        x = js_max(clamp_radius, js_min(map_width - clamp_radius, x));
    }
    if map_height.is_finite() {
        y = js_max(clamp_radius, js_min(map_height - clamp_radius, y));
    }

    out[0] = x;
    out[1] = y;
    out[2] = x - factory_x;
    out[3] = y - factory_y;
    out[4] = dir_x;
    out[5] = dir_y;
    out[6] = offset;
    1
}

/// Factory shell spawn overlap kernel.
///
/// Returns:
/// - 0 when the build spot is clear,
/// - 1 when any packed obstacle overlaps the requested shell radius,
/// - 2 when the buffers are shorter than `count`.
#[wasm_bindgen]
pub fn factory_build_spot_blocked(
    x: f64,
    y: f64,
    radius: f64,
    obstacle_x: &[f64],
    obstacle_y: &[f64],
    obstacle_radius: &[f64],
    count: u32,
) -> u32 {
    let n = count as usize;
    if n > obstacle_x.len() || n > obstacle_y.len() || n > obstacle_radius.len() {
        return 2;
    }

    for i in 0..n {
        let min_dist = radius + obstacle_radius[i];
        let dx = obstacle_x[i] - x;
        let dy = obstacle_y[i] - y;
        if (dx * dx) + (dy * dy) < min_dist * min_dist {
            return 1;
        }
    }

    0
}

pub(crate) const FACTORY_PRODUCTION_SELECTED_NONE_CODE: u8 = 0;
pub(crate) const FACTORY_PRODUCTION_SELECTED_VALID_CODE: u8 = 1;
pub(crate) const FACTORY_PRODUCTION_SELECTED_INVALID_CODE: u8 = 2;
pub(crate) const FACTORY_PRODUCTION_ACTION_NONE_CODE: u8 = 0;
pub(crate) const FACTORY_PRODUCTION_ACTION_RESET_SHELL_CODE: u8 = 1;
pub(crate) const FACTORY_PRODUCTION_ACTION_COMPLETE_SHELL_CODE: u8 = 2;
pub(crate) const FACTORY_PRODUCTION_ACTION_CLEAR_INVALID_SELECTION_CODE: u8 = 3;
pub(crate) const FACTORY_PRODUCTION_ACTION_STOP_PRODUCING_CODE: u8 = 4;
pub(crate) const FACTORY_PRODUCTION_ACTION_SPAWN_SHELL_CODE: u8 = 5;

#[wasm_bindgen]
pub fn factory_plan_production_actions(
    has_shell: &[u8],
    shell_exists: &[u8],
    shell_has_buildable: &[u8],
    shell_buildable_complete: &[u8],
    shell_interrupted: &[u8],
    shell_paid_energy: &[f64],
    shell_paid_metal: &[f64],
    shell_required_energy: &[f64],
    shell_required_metal: &[f64],
    selected_state: &[u8],
    can_build_unit: &[u8],
    is_producing: &[u8],
    count: u32,
    out_action: &mut [u8],
    out_progress: &mut [f64],
) -> u32 {
    let n = count as usize;
    if n > has_shell.len()
        || n > shell_exists.len()
        || n > shell_has_buildable.len()
        || n > shell_buildable_complete.len()
        || n > shell_interrupted.len()
        || n > shell_paid_energy.len()
        || n > shell_paid_metal.len()
        || n > shell_required_energy.len()
        || n > shell_required_metal.len()
        || n > selected_state.len()
        || n > can_build_unit.len()
        || n > is_producing.len()
        || n > out_action.len()
        || n > out_progress.len()
    {
        return 0;
    }

    for i in 0..n {
        out_action[i] = FACTORY_PRODUCTION_ACTION_NONE_CODE;
        out_progress[i] = 0.0;

        if has_shell[i] != 0 {
            if shell_exists[i] == 0 {
                out_action[i] = FACTORY_PRODUCTION_ACTION_RESET_SHELL_CODE;
                continue;
            }

            if shell_has_buildable[i] == 0 || shell_buildable_complete[i] != 0 {
                out_progress[i] = 1.0;
                out_action[i] = FACTORY_PRODUCTION_ACTION_COMPLETE_SHELL_CODE;
                continue;
            }

            out_progress[i] = construction_build_fraction(
                shell_paid_energy[i],
                shell_paid_metal[i],
                shell_required_energy[i],
                shell_required_metal[i],
            );

            if shell_interrupted[i] != 0 {
                out_action[i] = FACTORY_PRODUCTION_ACTION_RESET_SHELL_CODE;
            }
            continue;
        }

        match selected_state[i] {
            FACTORY_PRODUCTION_SELECTED_NONE_CODE => {
                if is_producing[i] != 0 {
                    out_action[i] = FACTORY_PRODUCTION_ACTION_STOP_PRODUCING_CODE;
                }
            }
            FACTORY_PRODUCTION_SELECTED_INVALID_CODE => {
                out_action[i] = FACTORY_PRODUCTION_ACTION_CLEAR_INVALID_SELECTION_CODE;
            }
            FACTORY_PRODUCTION_SELECTED_VALID_CODE => {
                if can_build_unit[i] == 0 {
                    if is_producing[i] != 0 {
                        out_action[i] = FACTORY_PRODUCTION_ACTION_STOP_PRODUCING_CODE;
                    }
                } else {
                    out_action[i] = FACTORY_PRODUCTION_ACTION_SPAWN_SHELL_CODE;
                }
            }
            _ => {
                out_action[i] = FACTORY_PRODUCTION_ACTION_CLEAR_INVALID_SELECTION_CODE;
            }
        }
    }

    1
}

#[wasm_bindgen]
pub fn economy_accumulate_player_rates(
    player_ids: &[u32],
    rates: &[f64],
    count: u32,
    out_rates_by_player: &mut [f64],
) -> u32 {
    for rate in out_rates_by_player.iter_mut() {
        *rate = 0.0;
    }

    let n = count as usize;
    if n > player_ids.len() || n > rates.len() {
        return 0;
    }

    let mut max_exclusive = 0usize;
    for i in 0..n {
        let player_id = player_ids[i] as usize;
        let rate = rates[i];
        if player_id == 0
            || player_id >= out_rates_by_player.len()
            || !rate.is_finite()
            || rate <= 0.0
        {
            continue;
        }
        out_rates_by_player[player_id] += rate;
        max_exclusive = max_exclusive.max(player_id + 1);
    }

    max_exclusive as u32
}

#[wasm_bindgen]
pub fn building_active_state_step_batch(
    open: &mut [u8],
    active: &[u8],
    damage_delay_ms: &mut [f64],
    reopen_delay_ms: &mut [f64],
    count: u32,
    dt_ms: f64,
    reopen_delay_reset_ms: f64,
    out_open_changed: &mut [u8],
) -> u32 {
    let n = count as usize;
    if n > open.len()
        || n > active.len()
        || n > damage_delay_ms.len()
        || n > reopen_delay_ms.len()
        || n > out_open_changed.len()
    {
        return 0;
    }

    let dt = economy_normalized_amount(dt_ms);
    let reopen_reset = economy_normalized_amount(reopen_delay_reset_ms);

    for i in 0..n {
        out_open_changed[i] = 0;

        if active[i] == 0 {
            if open[i] != 0 {
                open[i] = 0;
                out_open_changed[i] = 1;
            }
            continue;
        }

        if open[i] != 0 {
            let current_damage_delay = economy_normalized_amount(damage_delay_ms[i]);
            if current_damage_delay > 0.0 {
                let next_damage_delay = (current_damage_delay - dt).max(0.0);
                damage_delay_ms[i] = next_damage_delay;
                if next_damage_delay <= 0.0 {
                    open[i] = 0;
                    reopen_delay_ms[i] = reopen_reset;
                    out_open_changed[i] = 1;
                }
            } else {
                damage_delay_ms[i] = 0.0;
            }
        } else {
            let next_reopen_delay = (economy_normalized_amount(reopen_delay_ms[i]) - dt).max(0.0);
            reopen_delay_ms[i] = next_reopen_delay;
            if next_reopen_delay <= 0.0 {
                open[i] = 1;
                damage_delay_ms[i] = 0.0;
                out_open_changed[i] = 1;
            }
        }
    }

    1
}

#[inline]
pub(crate) fn economy_normalized_amount(amount: f64) -> f64 {
    if amount.is_finite() {
        amount.max(0.0)
    } else {
        0.0
    }
}

#[inline]
pub(crate) fn economy_normalized_cap(cap: f64) -> f64 {
    if cap.is_nan() || cap <= 0.0 {
        0.0
    } else {
        cap
    }
}

pub(crate) const ECONOMY_RESOURCE_NONE_CODE: u32 = 0;
pub(crate) const ECONOMY_RESOURCE_ENERGY_CODE: u32 = 1;
pub(crate) const ECONOMY_RESOURCE_METAL_CODE: u32 = 2;
pub(crate) const CONSTRUCTION_CONSUMER_BUILD_CODE: u8 = 1;
pub(crate) const CONSTRUCTION_CONSUMER_HEAL_CODE: u8 = 2;
pub(crate) const CONSTRUCTION_CONSUMER_CHANGED_BUILD_CODE: u8 = 1;
pub(crate) const CONSTRUCTION_CONSUMER_CHANGED_HP_CODE: u8 = 2;

#[inline]
pub(crate) fn economy_compute_converter_transfer_value(
    energy_curr: f64,
    _energy_max: f64,
    metal_curr: f64,
    metal_max: f64,
    total_rate_per_sec: f64,
    dt_sec: f64,
    tax: f64,
) -> (f64, f64, u32, u32) {
    if !energy_curr.is_finite()
        || !_energy_max.is_finite()
        || !metal_curr.is_finite()
        || !metal_max.is_finite()
    {
        return (
            0.0,
            0.0,
            ECONOMY_RESOURCE_NONE_CODE,
            ECONOMY_RESOURCE_NONE_CODE,
        );
    }

    let source_target =
        economy_normalized_amount(total_rate_per_sec) * economy_normalized_amount(dt_sec);
    if source_target <= 0.0 {
        return (
            0.0,
            0.0,
            ECONOMY_RESOURCE_NONE_CODE,
            ECONOMY_RESOURCE_NONE_CODE,
        );
    }

    let yield_factor = if tax.is_finite() {
        (1.0 - tax).max(0.0)
    } else {
        0.0
    };
    if yield_factor <= 0.0 {
        return (
            0.0,
            0.0,
            ECONOMY_RESOURCE_NONE_CODE,
            ECONOMY_RESOURCE_NONE_CODE,
        );
    }

    let source_available = source_target.min(energy_curr.max(0.0));
    if source_available <= 0.0 {
        return (
            0.0,
            0.0,
            ECONOMY_RESOURCE_NONE_CODE,
            ECONOMY_RESOURCE_NONE_CODE,
        );
    }

    let headroom = (metal_max - metal_curr).max(0.0);
    if headroom <= 0.0 {
        return (
            0.0,
            0.0,
            ECONOMY_RESOURCE_NONE_CODE,
            ECONOMY_RESOURCE_NONE_CODE,
        );
    }

    let wanted_output = source_available * yield_factor;
    let accepted_output = wanted_output.min(headroom);
    if accepted_output <= 0.0 {
        return (
            0.0,
            0.0,
            ECONOMY_RESOURCE_NONE_CODE,
            ECONOMY_RESOURCE_NONE_CODE,
        );
    }

    (
        source_available * (accepted_output / wanted_output),
        accepted_output,
        ECONOMY_RESOURCE_ENERGY_CODE,
        ECONOMY_RESOURCE_METAL_CODE,
    )
}

#[wasm_bindgen]
pub fn economy_compute_converter_transfer(
    energy_curr: f64,
    energy_max: f64,
    metal_curr: f64,
    metal_max: f64,
    total_rate_per_sec: f64,
    dt_sec: f64,
    tax: f64,
    out: &mut [f64],
) -> u32 {
    if out.len() < 4 {
        return 0;
    }

    out[0] = 0.0; // consumed amount
    out[1] = 0.0; // accepted output amount
    out[2] = ECONOMY_RESOURCE_NONE_CODE as f64; // consumed resource code
    out[3] = ECONOMY_RESOURCE_NONE_CODE as f64; // output resource code

    let (consumed, accepted_output, consumed_resource, output_resource) =
        economy_compute_converter_transfer_value(
            energy_curr,
            energy_max,
            metal_curr,
            metal_max,
            total_rate_per_sec,
            dt_sec,
            tax,
        );
    out[0] = consumed;
    out[1] = accepted_output;
    out[2] = consumed_resource as f64;
    out[3] = output_resource as f64;
    1
}

#[wasm_bindgen]
pub fn economy_credit_stockpile(curr: f64, max: f64, amount: f64, out: &mut [f64]) -> u32 {
    if out.len() < 2 {
        return 0;
    }

    let (accepted, next_curr) = economy_credit_stockpile_value(curr, max, amount);
    out[0] = accepted;
    out[1] = next_curr;
    1
}

#[wasm_bindgen]
pub fn economy_debit_stockpile(curr: f64, amount: f64, out: &mut [f64]) -> u32 {
    if out.len() < 2 {
        return 0;
    }

    let current = if curr.is_finite() { curr.max(0.0) } else { 0.0 };
    let requested = economy_normalized_amount(amount);
    let spent = requested.min(current);
    out[0] = spent;
    out[1] = current - spent;
    1
}

#[wasm_bindgen]
pub fn economy_apply_equal_consumer_debits(
    remaining: &[f64],
    caps: &[f64],
    count: u32,
    participant_count: u32,
    stockpile_curr: f64,
    out_spent: &mut [f64],
    out_totals: &mut [f64],
) -> u32 {
    let n = count as usize;
    if n > remaining.len() || n > caps.len() || n > out_spent.len() || out_totals.len() < 2 {
        return 0;
    }

    for spent in out_spent.iter_mut().take(n) {
        *spent = 0.0;
    }
    out_totals[0] = 0.0;
    out_totals[1] = if stockpile_curr.is_finite() {
        stockpile_curr.max(0.0)
    } else {
        0.0
    };

    if n == 0 || participant_count == 0 {
        return 1;
    }

    let mut current = out_totals[1];
    if current <= 0.0 {
        return 1;
    }

    let equal_share = current / participant_count as f64;
    if !equal_share.is_finite() || equal_share <= 0.0 {
        return 1;
    }

    let mut total_spent = 0.0;
    for i in 0..n {
        if current <= 0.0 {
            break;
        }
        let requested = economy_normalized_amount(remaining[i])
            .min(economy_normalized_cap(caps[i]))
            .min(equal_share);
        if requested <= 0.0 {
            continue;
        }
        let spent = requested.min(current);
        out_spent[i] = spent;
        total_spent += spent;
        current -= spent;
    }

    out_totals[0] = total_spent;
    out_totals[1] = current.max(0.0);
    1
}

#[inline]
pub(crate) fn construction_resource_fill_ratio(paid: f64, required: f64) -> f64 {
    if required <= 0.0 {
        1.0
    } else {
        js_min(1.0, js_max(0.0, paid / required))
    }
}

#[inline]
pub(crate) fn construction_build_fraction(
    paid_energy: f64,
    paid_metal: f64,
    required_energy: f64,
    required_metal: f64,
) -> f64 {
    (construction_resource_fill_ratio(paid_energy, required_energy)
        + construction_resource_fill_ratio(paid_metal, required_metal))
        * 0.5
}

#[inline]
pub(crate) fn construction_initial_hp(max_hp: f64) -> f64 {
    if !max_hp.is_finite() || max_hp <= 0.0 {
        0.0
    } else {
        max_hp.min(1.0)
    }
}

#[inline]
pub(crate) fn construction_advance_piece_hp(
    current_hp: f64,
    max_hp: f64,
    prev_progress: f64,
    next_progress: f64,
    alive: bool,
    starts_at_frame_one: bool,
) -> f64 {
    let current = if current_hp.is_finite() {
        current_hp
    } else {
        0.0
    };
    if !alive {
        return current;
    }

    let max_hp = if max_hp.is_finite() {
        max_hp.max(0.0)
    } else {
        0.0
    };
    let prev = if prev_progress.is_finite() {
        prev_progress.max(0.0).min(1.0)
    } else {
        0.0
    };
    let next = if next_progress.is_finite() {
        next_progress.max(0.0).min(1.0)
    } else {
        0.0
    };
    let progress_delta = (next - prev).max(0.0);

    if current <= 0.0 {
        if starts_at_frame_one || next > 0.0 {
            return max_hp.min(construction_initial_hp(max_hp).max(next * max_hp));
        }
        return 0.0;
    }
    if progress_delta <= 0.0 {
        return current;
    }
    max_hp.min(current + progress_delta * max_hp)
}

#[wasm_bindgen]
pub fn construction_reconcile_and_grow_pieces(
    total_paid_energy: f64,
    total_paid_metal: f64,
    required_energy: &[f64],
    required_metal: &[f64],
    max_hp: &[f64],
    current_hp: &[f64],
    previous_progress: &[f64],
    starts_at_frame_one: &[u8],
    alive: &[u8],
    count: u32,
    out_paid_energy: &mut [f64],
    out_paid_metal: &mut [f64],
    out_complete: &mut [u8],
    out_active: &mut [u8],
    out_hp: &mut [f64],
    out_progress: &mut [f64],
) -> u32 {
    let n = count as usize;
    if n > required_energy.len()
        || n > required_metal.len()
        || n > max_hp.len()
        || n > current_hp.len()
        || n > previous_progress.len()
        || n > starts_at_frame_one.len()
        || n > alive.len()
        || n > out_paid_energy.len()
        || n > out_paid_metal.len()
        || n > out_complete.len()
        || n > out_active.len()
        || n > out_hp.len()
        || n > out_progress.len()
    {
        return 0;
    }

    let mut remaining_energy = economy_normalized_amount(total_paid_energy);
    let mut remaining_metal = economy_normalized_amount(total_paid_metal);
    let mut dependency_satisfied = true;

    for i in 0..n {
        let req_energy = economy_normalized_amount(required_energy[i]);
        let req_metal = economy_normalized_amount(required_metal[i]);
        let paid_energy = req_energy.min(remaining_energy);
        let paid_metal = req_metal.min(remaining_metal);
        remaining_energy = (remaining_energy - paid_energy).max(0.0);
        remaining_metal = (remaining_metal - paid_metal).max(0.0);

        let complete = paid_energy >= req_energy && paid_metal >= req_metal;
        let has_started = paid_energy > 0.0 || paid_metal > 0.0;
        let starts = starts_at_frame_one[i] != 0;
        let active = dependency_satisfied && (starts || has_started || complete);
        let progress = if active {
            construction_build_fraction(paid_energy, paid_metal, req_energy, req_metal)
        } else {
            0.0
        };
        let hp = construction_advance_piece_hp(
            current_hp[i],
            max_hp[i],
            previous_progress[i],
            progress,
            alive[i] != 0,
            starts,
        );

        out_paid_energy[i] = paid_energy;
        out_paid_metal[i] = paid_metal;
        out_complete[i] = if complete { 1 } else { 0 };
        out_active[i] = if active { 1 } else { 0 };
        out_hp[i] = hp;
        out_progress[i] = progress;

        dependency_satisfied = dependency_satisfied && complete;
    }

    1
}

#[wasm_bindgen]
pub fn construction_apply_consumer_spends(
    consumer_types: &[u8],
    paid_energy: &mut [f64],
    paid_metal: &mut [f64],
    required_energy: &[f64],
    required_metal: &[f64],
    hp: &mut [f64],
    max_hp: &[f64],
    spend_energy: &[f64],
    spend_metal: &[f64],
    caps: &[f64],
    count: u32,
    heal_cost_per_hp: f64,
    out_build_progress: &mut [f64],
    out_energy_rate_fraction: &mut [f64],
    out_metal_rate_fraction: &mut [f64],
    out_changed_mask: &mut [u8],
) -> u32 {
    let n = count as usize;
    if n > consumer_types.len()
        || n > paid_energy.len()
        || n > paid_metal.len()
        || n > required_energy.len()
        || n > required_metal.len()
        || n > hp.len()
        || n > max_hp.len()
        || n > spend_energy.len()
        || n > spend_metal.len()
        || n > caps.len()
        || n > out_build_progress.len()
        || n > out_energy_rate_fraction.len()
        || n > out_metal_rate_fraction.len()
        || n > out_changed_mask.len()
    {
        return 0;
    }

    for i in 0..n {
        out_build_progress[i] = 0.0;
        out_energy_rate_fraction[i] = 0.0;
        out_metal_rate_fraction[i] = 0.0;
        out_changed_mask[i] = 0;

        match consumer_types[i] {
            CONSTRUCTION_CONSUMER_BUILD_CODE => {
                let spend_e = economy_normalized_amount(spend_energy[i]);
                let spend_m = economy_normalized_amount(spend_metal[i]);
                let mut changed = 0u8;

                if spend_e > 0.0 {
                    paid_energy[i] += spend_e;
                    changed |= CONSTRUCTION_CONSUMER_CHANGED_BUILD_CODE;
                }
                if spend_m > 0.0 {
                    paid_metal[i] += spend_m;
                    changed |= CONSTRUCTION_CONSUMER_CHANGED_BUILD_CODE;
                }

                out_build_progress[i] = construction_build_fraction(
                    paid_energy[i],
                    paid_metal[i],
                    required_energy[i],
                    required_metal[i],
                );

                let cap = caps[i];
                if cap > 0.0 {
                    out_energy_rate_fraction[i] = spend_e / cap;
                    out_metal_rate_fraction[i] = spend_m / cap;
                }

                out_changed_mask[i] = changed;
            }
            CONSTRUCTION_CONSUMER_HEAL_CODE => {
                let spend_e = economy_normalized_amount(spend_energy[i]);
                if spend_e <= 0.0 || heal_cost_per_hp <= 0.0 || !heal_cost_per_hp.is_finite() {
                    continue;
                }

                let next_hp = js_min(hp[i] + spend_e / heal_cost_per_hp, max_hp[i]);
                if next_hp != hp[i] {
                    hp[i] = next_hp;
                    out_changed_mask[i] = CONSTRUCTION_CONSUMER_CHANGED_HP_CODE;
                }
            }
            _ => {}
        }
    }

    1
}

#[inline]
pub(crate) fn economy_credit_stockpile_value(curr: f64, max: f64, amount: f64) -> (f64, f64) {
    let current = if curr.is_finite() { curr } else { 0.0 };
    let maximum = if max.is_finite() { max } else { current };
    let requested = economy_normalized_amount(amount);
    let accepted = requested.min((maximum - current).max(0.0));
    (accepted, current + accepted)
}

#[wasm_bindgen]
pub fn economy_apply_income_credits(
    player_ids: &[u32],
    resource_codes: &[u32],
    rates_per_sec: &[f64],
    count: u32,
    dt_sec: f64,
    energy_curr_by_player: &mut [f64],
    energy_max_by_player: &[f64],
    metal_curr_by_player: &mut [f64],
    metal_max_by_player: &[f64],
    out_accepted: &mut [f64],
) -> u32 {
    let n = count as usize;
    if n > player_ids.len()
        || n > resource_codes.len()
        || n > rates_per_sec.len()
        || n > out_accepted.len()
    {
        return 0;
    }

    for accepted in out_accepted.iter_mut().take(n) {
        *accepted = 0.0;
    }

    let dt = economy_normalized_amount(dt_sec);
    let mut max_exclusive = 0usize;
    for i in 0..n {
        let player_id = player_ids[i] as usize;
        if player_id == 0 {
            continue;
        }
        let amount = economy_normalized_amount(rates_per_sec[i]) * dt;
        if amount <= 0.0 {
            continue;
        }

        match resource_codes[i] {
            ECONOMY_RESOURCE_ENERGY_CODE => {
                if player_id >= energy_curr_by_player.len()
                    || player_id >= energy_max_by_player.len()
                {
                    continue;
                }
                let (accepted, next_curr) = economy_credit_stockpile_value(
                    energy_curr_by_player[player_id],
                    energy_max_by_player[player_id],
                    amount,
                );
                energy_curr_by_player[player_id] = next_curr;
                out_accepted[i] = accepted;
                max_exclusive = max_exclusive.max(player_id + 1);
            }
            ECONOMY_RESOURCE_METAL_CODE => {
                if player_id >= metal_curr_by_player.len() || player_id >= metal_max_by_player.len()
                {
                    continue;
                }
                let (accepted, next_curr) = economy_credit_stockpile_value(
                    metal_curr_by_player[player_id],
                    metal_max_by_player[player_id],
                    amount,
                );
                metal_curr_by_player[player_id] = next_curr;
                out_accepted[i] = accepted;
                max_exclusive = max_exclusive.max(player_id + 1);
            }
            _ => {}
        }
    }

    max_exclusive as u32
}

#[wasm_bindgen]
pub fn economy_apply_converter_transfers(
    player_ids: &[u32],
    rates_per_sec: &[f64],
    count: u32,
    dt_sec: f64,
    tax: f64,
    energy_curr_by_player: &mut [f64],
    energy_max_by_player: &[f64],
    metal_curr_by_player: &mut [f64],
    metal_max_by_player: &[f64],
    rates_by_player: &mut [f64],
    consumed_by_player: &mut [f64],
    output_by_player: &mut [f64],
    consumed_resource_by_player: &mut [u32],
    output_resource_by_player: &mut [u32],
    out_consumed: &mut [f64],
    out_output: &mut [f64],
    out_consumed_resource: &mut [u32],
    out_output_resource: &mut [u32],
) -> u32 {
    let n = count as usize;
    if n > player_ids.len()
        || n > rates_per_sec.len()
        || n > out_consumed.len()
        || n > out_output.len()
        || n > out_consumed_resource.len()
        || n > out_output_resource.len()
    {
        return 0;
    }

    for i in 0..n {
        out_consumed[i] = 0.0;
        out_output[i] = 0.0;
        out_consumed_resource[i] = ECONOMY_RESOURCE_NONE_CODE;
        out_output_resource[i] = ECONOMY_RESOURCE_NONE_CODE;
    }

    for rate in rates_by_player.iter_mut() {
        *rate = 0.0;
    }
    for amount in consumed_by_player.iter_mut() {
        *amount = 0.0;
    }
    for amount in output_by_player.iter_mut() {
        *amount = 0.0;
    }
    for resource in consumed_resource_by_player.iter_mut() {
        *resource = ECONOMY_RESOURCE_NONE_CODE;
    }
    for resource in output_resource_by_player.iter_mut() {
        *resource = ECONOMY_RESOURCE_NONE_CODE;
    }

    let dt = economy_normalized_amount(dt_sec);
    if dt <= 0.0 {
        return 0;
    }

    let mut max_exclusive = 0usize;
    for i in 0..n {
        let player_id = player_ids[i] as usize;
        if player_id == 0
            || player_id >= rates_by_player.len()
            || player_id >= energy_curr_by_player.len()
            || player_id >= energy_max_by_player.len()
            || player_id >= metal_curr_by_player.len()
            || player_id >= metal_max_by_player.len()
            || player_id >= consumed_by_player.len()
            || player_id >= output_by_player.len()
            || player_id >= consumed_resource_by_player.len()
            || player_id >= output_resource_by_player.len()
        {
            continue;
        }
        let rate = economy_normalized_amount(rates_per_sec[i]);
        if rate <= 0.0 {
            continue;
        }
        rates_by_player[player_id] += rate;
        max_exclusive = max_exclusive.max(player_id + 1);
    }

    for player_id in 1..max_exclusive {
        let total_rate = rates_by_player[player_id];
        if total_rate <= 0.0 {
            continue;
        }
        let (consumed, accepted_output, consumed_resource, output_resource) =
            economy_compute_converter_transfer_value(
                energy_curr_by_player[player_id],
                energy_max_by_player[player_id],
                metal_curr_by_player[player_id],
                metal_max_by_player[player_id],
                total_rate,
                dt,
                tax,
            );
        if consumed <= 0.0 || accepted_output <= 0.0 {
            continue;
        }

        match consumed_resource {
            ECONOMY_RESOURCE_ENERGY_CODE => {
                energy_curr_by_player[player_id] =
                    (energy_curr_by_player[player_id].max(0.0) - consumed).max(0.0);
            }
            ECONOMY_RESOURCE_METAL_CODE => {
                metal_curr_by_player[player_id] =
                    (metal_curr_by_player[player_id].max(0.0) - consumed).max(0.0);
            }
            _ => {}
        }
        match output_resource {
            ECONOMY_RESOURCE_ENERGY_CODE => {
                energy_curr_by_player[player_id] = (energy_curr_by_player[player_id]
                    + accepted_output)
                    .min(energy_max_by_player[player_id]);
            }
            ECONOMY_RESOURCE_METAL_CODE => {
                metal_curr_by_player[player_id] = (metal_curr_by_player[player_id]
                    + accepted_output)
                    .min(metal_max_by_player[player_id]);
            }
            _ => {}
        }

        consumed_by_player[player_id] = consumed;
        output_by_player[player_id] = accepted_output;
        consumed_resource_by_player[player_id] = consumed_resource;
        output_resource_by_player[player_id] = output_resource;
    }

    for i in 0..n {
        let player_id = player_ids[i] as usize;
        if player_id == 0 || player_id >= max_exclusive {
            continue;
        }
        let row_rate = economy_normalized_amount(rates_per_sec[i]);
        let remaining_rate = rates_by_player[player_id];
        if row_rate <= 0.0 || remaining_rate <= 0.0 {
            continue;
        }
        let remaining_consumed = consumed_by_player[player_id];
        let remaining_output = output_by_player[player_id];
        if remaining_consumed <= 0.0 || remaining_output <= 0.0 {
            continue;
        }

        let final_share = remaining_rate <= row_rate;
        let rate_share = if final_share {
            1.0
        } else {
            (row_rate / remaining_rate).min(1.0)
        };
        let consumed_share = if final_share {
            remaining_consumed
        } else {
            (remaining_consumed * rate_share).min(remaining_consumed)
        };
        let output_share = if final_share {
            remaining_output
        } else {
            (remaining_output * rate_share).min(remaining_output)
        };

        if consumed_share <= 0.0 || output_share <= 0.0 {
            continue;
        }

        out_consumed[i] = consumed_share;
        out_output[i] = output_share;
        out_consumed_resource[i] = consumed_resource_by_player[player_id];
        out_output_resource[i] = output_resource_by_player[player_id];
        rates_by_player[player_id] = (remaining_rate - row_rate).max(0.0);
        consumed_by_player[player_id] = (remaining_consumed - consumed_share).max(0.0);
        output_by_player[player_id] = (remaining_output - output_share).max(0.0);
    }

    max_exclusive as u32
}

#[inline]
pub(crate) fn is_in_contact(penetration: f64) -> bool {
    penetration >= -UNIT_GROUND_CONTACT_EPSILON
}

/// Locomotion support deliberately reaches farther than physical collision.
/// A unit may use slope-oriented drive/attitude when its locomotion point is
/// within one collision radius of the sampled support, while the contact
/// spring still waits for `is_in_contact` above.
#[inline]
pub(crate) fn is_in_locomotion_contact(penetration: f64, collision_radius: f64) -> bool {
    let reach = if collision_radius.is_finite() && collision_radius > 0.0 {
        collision_radius
    } else {
        UNIT_GROUND_CONTACT_EPSILON
    };
    penetration >= -reach
}

#[inline]
pub(crate) fn ground_spring_accel(penetration: f64, normal_velocity: f64) -> f64 {
    if !is_in_contact(penetration) {
        return 0.0;
    }
    let compression = penetration.max(0.0);
    if compression <= 0.0 {
        return 0.0;
    }
    let spring = UNIT_GROUND_SPRING_ACCEL_PER_WORLD_UNIT * compression;
    let damped = spring - GROUND_SPRING_DAMPING_ACCEL_PER_SPEED * normal_velocity;
    if damped.is_finite() {
        damped.max(0.0)
    } else {
        0.0
    }
}

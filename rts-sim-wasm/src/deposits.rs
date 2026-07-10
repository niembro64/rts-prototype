// deposits — extracted from lib.rs (pure code motion).

#[allow(unused_imports)]
use crate::*;
#[allow(unused_imports)]
use wasm_bindgen::prelude::*;

// ─────────────────────────────────────────────────────────────────
//  C16 — metal-deposit placement + resource footprint growth
//
//  Replaces the deterministic ring placement and connected-cell grow
//  pass from src/metalDepositConfig.ts. TypeScript still owns config
//  validation and object assembly; Rust owns the numeric oval/ring
//  layout, snapped grid placement, explicit-height derivation,
//  null-height terrain anchoring, candidate layout, seeded frontier
//  weighting, and sorted output cell list.
// ─────────────────────────────────────────────────────────────────

pub(crate) const METAL_DEPOSIT_RING_INPUT_STRIDE: usize = 6;
pub(crate) const METAL_DEPOSIT_PLACEMENT_OUTPUT_STRIDE: usize = 15;
pub(crate) const METAL_DEPOSIT_HEIGHT_INPUT_STRIDE: usize = 3;
pub(crate) const METAL_DEPOSIT_TERRAIN_CONFIG_LEN: usize = 30;
pub(crate) const METAL_DEPOSIT_FLAT_ZONE_INPUT_STRIDE: usize = 5;
pub(crate) const METAL_DEPOSIT_RESOURCE_NEIGHBOR_COUNT: usize = 4;
pub(crate) const METAL_DEPOSIT_FIRST_PLAYER_ANGLE: f64 =
    -std::f64::consts::FRAC_PI_2 + std::f64::consts::FRAC_PI_4;
pub(crate) const METAL_DEPOSIT_D_TERRAIN_NULL: f64 = f64::NAN;

#[derive(Clone, Copy)]
pub(crate) struct MapOvalMetricsRust {
    cx: f64,
    cy: f64,
    min_dim: f64,
    scale_x: f64,
    scale_y: f64,
}

pub(crate) struct MapOvalSampleRust {
    ox: f64,
    oy: f64,
    distance: f64,
    angle: f64,
}

#[derive(Clone, Copy)]
pub(crate) struct MetalDepositTerrainConfigRust {
    center_magnitude: f64,
    dividers_magnitude: f64,
    terrain_d_terrain: f64,
    perimeter_magnitude: f64,
    team_count: u32,
    tile_floor_y: f64,
    perimeter_outer_radius_fraction: f64,
    perimeter_inner_radius_fraction: f64,
    generation_edge_transition_width_fraction: f64,
    plateau_shelf_fraction_of_step: f64,
    plateau_ramp_edge_sharpness: f64,
    plateau_wall_slope_degrees: f64,
    ripple_radius_fraction: f64,
    ripple_phase: f64,
    ripple_wavelengths: [f64; 3],
    ripple_magnitudes: [f64; 3],
    ridge_inner_radius_fraction: f64,
    ridge_outer_radius_fraction: f64,
    ridge_half_width_fraction: f64,
    waters_edge_beach_slope_degrees: f64,
    waters_edge_cliff_height: f64,
    shoreline_beach_fade_radius: f64,
    shoreline_cliff_fade_radius: f64,
    /// Authored order of the three reorderable height-transform stages
    /// (terrainConfig.json `pipeline`): 0 = plateau terracing,
    /// 1 = metal deposit pads, 2 = waters-edge shoreline.
    pipeline_transform_order: [u8; 3],
}

pub(crate) fn metal_deposit_terrain_config_from_slice(
    values: &[f64],
) -> Option<MetalDepositTerrainConfigRust> {
    if values.len() < METAL_DEPOSIT_TERRAIN_CONFIG_LEN {
        return None;
    }
    for value in values.iter().take(METAL_DEPOSIT_TERRAIN_CONFIG_LEN) {
        if !value.is_finite() {
            return None;
        }
    }
    Some(MetalDepositTerrainConfigRust {
        center_magnitude: values[0],
        dividers_magnitude: values[1],
        terrain_d_terrain: values[2],
        perimeter_magnitude: values[3],
        team_count: values[4].max(0.0).floor() as u32,
        tile_floor_y: values[5],
        perimeter_outer_radius_fraction: values[6],
        perimeter_inner_radius_fraction: values[7],
        generation_edge_transition_width_fraction: values[8],
        plateau_shelf_fraction_of_step: values[9],
        plateau_ramp_edge_sharpness: values[10],
        ripple_radius_fraction: values[11],
        ripple_phase: values[12],
        ripple_wavelengths: [values[13], values[15], values[17]],
        ripple_magnitudes: [values[14], values[16], values[18]],
        ridge_inner_radius_fraction: values[19],
        ridge_outer_radius_fraction: values[20],
        ridge_half_width_fraction: values[21],
        plateau_wall_slope_degrees: values[22],
        waters_edge_beach_slope_degrees: values[23],
        waters_edge_cliff_height: values[24],
        shoreline_beach_fade_radius: values[25],
        shoreline_cliff_fade_radius: values[26],
        pipeline_transform_order: {
            let a = values[27] as u8;
            let b = values[28] as u8;
            let c = values[29] as u8;
            let mut seen = [false; 3];
            for code in [a, b, c] {
                if code > 2 || seen[code as usize] {
                    return None;
                }
                seen[code as usize] = true;
            }
            [a, b, c]
        },
    })
}

#[inline]
pub(crate) fn terrain_clamp01(value: f64) -> f64 {
    if value <= 0.0 {
        0.0
    } else if value >= 1.0 {
        1.0
    } else {
        value
    }
}

#[inline]
pub(crate) fn terrain_smootherstep(t: f64) -> f64 {
    t * t * t * (t * (t * 6.0 - 15.0) + 10.0)
}

/// Raised-cosine ramp on [0,1]: 0 at t=0, 1 at t=1, zero slope at both
/// ends. Mirrors `perimeterRampWeight` in terrainHeightGenerator.ts so the
/// TS analytic and Rust baked PERIMETER blend agree.
#[inline]
pub(crate) fn terrain_perimeter_ramp_weight(t: f64) -> f64 {
    (1.0 - (t * std::f64::consts::PI).cos()) * 0.5
}

#[inline]
pub(crate) fn terrain_js_round(value: f64) -> f64 {
    (value + 0.5).floor()
}

pub(crate) fn terrain_make_oval_metrics(
    map_width: f64,
    map_height: f64,
    extent_fraction: f64,
) -> MapOvalMetricsRust {
    let fraction = extent_fraction.clamp(0.01, 1.0);
    let width = (map_width * fraction).max(1.0);
    let height = (map_height * fraction).max(1.0);
    let min_dim = width.min(height).max(1.0);
    MapOvalMetricsRust {
        cx: map_width * 0.5,
        cy: map_height * 0.5,
        min_dim,
        scale_x: width / min_dim,
        scale_y: height / min_dim,
    }
}

#[inline]
pub(crate) fn terrain_sample_map_oval_at(
    metrics: &MapOvalMetricsRust,
    x: f64,
    y: f64,
) -> MapOvalSampleRust {
    let ox = (x - metrics.cx) / metrics.scale_x;
    let oy = (y - metrics.cy) / metrics.scale_y;
    MapOvalSampleRust {
        ox,
        oy,
        distance: (ox * ox + oy * oy).sqrt(),
        angle: oy.atan2(ox),
    }
}

pub(crate) fn terrain_plateau_ramp_curve(t: f64, cfg: &MetalDepositTerrainConfigRust) -> f64 {
    let smooth = terrain_smootherstep(t);
    let sharpness = terrain_clamp01(cfg.plateau_ramp_edge_sharpness);
    smooth + (t - smooth) * sharpness
}

#[inline]
pub(crate) fn terrain_plateau_step(cfg: &MetalDepositTerrainConfigRust) -> f64 {
    cfg.terrain_d_terrain
}

pub(crate) fn terrain_plateau_flat_half_for_gradient(
    gradient_magnitude: f64,
    cfg: &MetalDepositTerrainConfigRust,
) -> f64 {
    let authored_flat_half = (cfg.plateau_shelf_fraction_of_step * 0.5)
        .max(0.0)
        .min(0.49);
    let angle = cfg.plateau_wall_slope_degrees.clamp(1.0, 89.0);
    if angle >= 89.0 {
        return authored_flat_half;
    }

    let gradient = gradient_magnitude.abs().max(0.0);
    let tan_angle = (angle * std::f64::consts::PI / 180.0).tan().max(1e-6);
    let ramp_q_span = (gradient / tan_angle).clamp(0.0, 1.0);
    let angle_flat_half = ((1.0 - ramp_q_span) * 0.5).clamp(0.0, 0.49);
    authored_flat_half.min(angle_flat_half)
}

pub(crate) fn terrain_apply_plateaus(
    height: f64,
    gradient_magnitude: f64,
    cfg: &MetalDepositTerrainConfigRust,
) -> f64 {
    if !height.is_finite() {
        return height;
    }
    let step = cfg.terrain_d_terrain;
    if step <= 0.0 {
        return height;
    }

    let flat_half = terrain_plateau_flat_half_for_gradient(gradient_magnitude, cfg);
    let q = height / step;
    let nearest_level = terrain_js_round(q);
    let signed_from_nearest = q - nearest_level;
    let abs_from_nearest = signed_from_nearest.abs();
    let plateau_level = if abs_from_nearest <= flat_half {
        nearest_level
    } else if signed_from_nearest > 0.0 {
        let ramp_span = (1.0 - flat_half * 2.0).max(1e-6);
        let ramp_t = (signed_from_nearest - flat_half) / ramp_span;
        nearest_level + terrain_plateau_ramp_curve(ramp_t, cfg)
    } else {
        let ramp_span = (1.0 - flat_half * 2.0).max(1e-6);
        let ramp_t = (1.0 + signed_from_nearest - flat_half) / ramp_span;
        nearest_level - 1.0 + terrain_plateau_ramp_curve(ramp_t, cfg)
    };
    plateau_level * step
}

pub(crate) fn terrain_perimeter_outer_radius_for_min_dim(
    min_dim: f64,
    cfg: &MetalDepositTerrainConfigRust,
) -> f64 {
    (min_dim * cfg.perimeter_outer_radius_fraction).max(1.0)
}

pub(crate) fn terrain_perimeter_inner_radius_for_min_dim(
    min_dim: f64,
    outer_radius: f64,
    cfg: &MetalDepositTerrainConfigRust,
) -> f64 {
    let inner = min_dim * cfg.perimeter_inner_radius_fraction.max(0.0);
    inner.max(0.0).min(outer_radius)
}

pub(crate) fn terrain_generation_boundary_fade_for_sample(
    metrics: &MapOvalMetricsRust,
    oval: &MapOvalSampleRust,
    cfg: &MetalDepositTerrainConfigRust,
) -> f64 {
    let end_radius = metrics.min_dim * 0.5;
    let width = (end_radius - 1.0)
        .max(0.0)
        .min(metrics.min_dim * cfg.generation_edge_transition_width_fraction);
    let start_radius = (end_radius - width).max(0.0);
    if oval.distance <= start_radius {
        return 0.0;
    }
    if oval.distance >= end_radius {
        return 1.0;
    }
    terrain_smootherstep(terrain_clamp01(
        (oval.distance - start_radius) / (end_radius - start_radius).max(1e-6),
    ))
}

pub(crate) fn terrain_map_boundary_fade_for_sample(
    metrics: &MapOvalMetricsRust,
    oval: &MapOvalSampleRust,
    cfg: &MetalDepositTerrainConfigRust,
) -> f64 {
    // PERIMETER off (magnitude 0) leaves the natural square map untouched.
    if cfg.perimeter_magnitude == 0.0 {
        return 0.0;
    }
    let outer_radius = terrain_perimeter_outer_radius_for_min_dim(metrics.min_dim, cfg);
    let inner_radius =
        terrain_perimeter_inner_radius_for_min_dim(metrics.min_dim, outer_radius, cfg);
    if oval.distance <= inner_radius {
        return 0.0;
    }
    if oval.distance >= outer_radius {
        return 1.0;
    }
    terrain_perimeter_ramp_weight(terrain_clamp01(
        (oval.distance - inner_radius) / (outer_radius - inner_radius).max(1e-6),
    ))
}

pub(crate) fn terrain_apply_map_boundary_for_sample(
    height: f64,
    metrics: &MapOvalMetricsRust,
    oval: &MapOvalSampleRust,
    cfg: &MetalDepositTerrainConfigRust,
) -> f64 {
    let w = terrain_map_boundary_fade_for_sample(metrics, oval, cfg);
    if w <= 0.0 {
        return height;
    }
    if w >= 1.0 {
        return cfg.perimeter_magnitude;
    }
    height + (cfg.perimeter_magnitude - height) * w
}

pub(crate) fn terrain_shaped_height_before_plateaus(
    x: f64,
    y: f64,
    metrics: &MapOvalMetricsRust,
    cfg: &MetalDepositTerrainConfigRust,
) -> f64 {
    let oval = terrain_sample_map_oval_at(metrics, x, y);
    let natural = terrain_generated_natural_height(metrics, &oval, cfg);
    terrain_apply_map_boundary_for_sample(natural, metrics, &oval, cfg)
}

pub(crate) fn terrain_estimate_shaped_gradient_before_plateaus(
    x: f64,
    y: f64,
    metrics: &MapOvalMetricsRust,
    cfg: &MetalDepositTerrainConfigRust,
) -> f64 {
    if cfg.terrain_d_terrain <= 0.0 || cfg.plateau_wall_slope_degrees >= 89.0 {
        return 0.0;
    }
    terrain_estimate_shaped_gradient(x, y, metrics, cfg)
}

/// Unguarded gradient estimate of the shaped (pre-plateau) surface. The
/// plateau path keeps its historical short-circuit above; the waters-edge
/// pass needs a real gradient even when terracing is disabled.
pub(crate) fn terrain_estimate_shaped_gradient(
    x: f64,
    y: f64,
    metrics: &MapOvalMetricsRust,
    cfg: &MetalDepositTerrainConfigRust,
) -> f64 {
    let step = 8.0;
    let map_width = metrics.cx * 2.0;
    let map_height = metrics.cy * 2.0;
    let x0 = (x - step).max(0.0);
    let x1 = (x + step).min(map_width);
    let y0 = (y - step).max(0.0);
    let y1 = (y + step).min(map_height);
    let dx_span = (x1 - x0).max(1e-6);
    let dy_span = (y1 - y0).max(1e-6);
    let hx0 = terrain_shaped_height_before_plateaus(x0, y, metrics, cfg);
    let hx1 = terrain_shaped_height_before_plateaus(x1, y, metrics, cfg);
    let hy0 = terrain_shaped_height_before_plateaus(x, y0, metrics, cfg);
    let hy1 = terrain_shaped_height_before_plateaus(x, y1, metrics, cfg);
    let gx = (hx1 - hx0) / dx_span;
    let gy = (hy1 - hy0) / dy_span;
    (gx * gx + gy * gy).sqrt()
}

pub(crate) fn terrain_generated_natural_height(
    metrics: &MapOvalMetricsRust,
    oval: &MapOvalSampleRust,
    cfg: &MetalDepositTerrainConfigRust,
) -> f64 {
    let mut ripple = 0.0;
    let max_dist = metrics.min_dim * cfg.ripple_radius_fraction;
    if oval.distance < max_dist && max_dist > 0.0 {
        let fade_t = (oval.distance / max_dist) * (std::f64::consts::PI * 0.5);
        let fade = fade_t.cos();
        let a = (oval.distance / cfg.ripple_wavelengths[0]).cos();
        let b = (oval.distance / cfg.ripple_wavelengths[1] + cfg.ripple_phase).cos();
        let c = ((oval.ox + oval.oy) / cfg.ripple_wavelengths[2]).sin();
        let sum = a * cfg.ripple_magnitudes[0]
            + b * cfg.ripple_magnitudes[1]
            + c * cfg.ripple_magnitudes[2];
        let norm = (sum + 1.0) * 0.5;
        ripple = cfg.center_magnitude * fade * norm;
    }

    let mut ridge = 0.0;
    let team_count = cfg.team_count;
    if team_count > 0 && oval.distance > 0.0 {
        let cycle = std::f64::consts::TAU / team_count as f64;
        let mut pos = (oval.angle + std::f64::consts::FRAC_PI_4) % cycle;
        if pos < 0.0 {
            pos += cycle;
        }
        let barrier_mid = cycle * 0.5;
        let dist_from_barrier_center = (pos - barrier_mid).abs();
        let half_width = metrics.min_dim * cfg.ridge_half_width_fraction;
        let along_dist = oval.distance * dist_from_barrier_center.cos();
        let perp_dist = oval.distance * dist_from_barrier_center.sin();
        if along_dist > 0.0 && perp_dist < half_width {
            let width_t = perp_dist / half_width;
            let ang_falloff = (1.0 + (width_t * std::f64::consts::PI).cos()) * 0.5;
            let inner_r = metrics.min_dim * cfg.ridge_inner_radius_fraction;
            let outer_r = metrics.min_dim * cfg.ridge_outer_radius_fraction;
            let rad_t = if along_dist >= outer_r {
                1.0
            } else if along_dist <= inner_r {
                0.0
            } else {
                let span = outer_r - inner_r;
                if span > 0.0 {
                    (along_dist - inner_r) / span
                } else {
                    1.0
                }
            };
            ridge = cfg.dividers_magnitude * ang_falloff * rad_t;
        }
    }

    let generation_fade = terrain_generation_boundary_fade_for_sample(metrics, oval, cfg);
    (ripple + ridge) * (1.0 - generation_fade)
}

pub(crate) fn metal_deposit_flat_zone_blend_weight(
    x: f64,
    y: f64,
    flat_zones: &[f64],
    base: usize,
) -> Option<f64> {
    let zx = flat_zones[base];
    let zy = flat_zones[base + 1];
    let radius = flat_zones[base + 2];
    let blend_radius = flat_zones[base + 4].max(0.0);
    if blend_radius <= 0.0 {
        return None;
    }
    let dx = x - zx;
    let dy = y - zy;
    let d2 = dx * dx + dy * dy;
    if d2 <= radius * radius {
        return None;
    }
    let d = d2.sqrt();
    if d >= radius + blend_radius {
        return None;
    }
    let t = (d - radius) / blend_radius;
    Some((1.0 + (t * std::f64::consts::PI).cos()) * 0.5)
}

pub(crate) fn metal_deposit_override_from_flat_zone_rows(
    x: f64,
    y: f64,
    flat_zones: &[f64],
) -> (f64, f64) {
    if flat_zones.is_empty() {
        return (1.0, 0.0);
    }

    let mut containing_height = 0.0;
    let mut containing_d2 = f64::INFINITY;
    let zone_count = flat_zones.len() / METAL_DEPOSIT_FLAT_ZONE_INPUT_STRIDE;
    for zone_index in 0..zone_count {
        let base = zone_index * METAL_DEPOSIT_FLAT_ZONE_INPUT_STRIDE;
        let dx = x - flat_zones[base];
        let dy = y - flat_zones[base + 1];
        let radius = flat_zones[base + 2];
        let d2 = dx * dx + dy * dy;
        if d2 <= radius * radius && d2 < containing_d2 {
            containing_height = flat_zones[base + 3];
            containing_d2 = d2;
        }
    }
    if containing_d2.is_finite() {
        return (0.0, containing_height);
    }

    let mut prod_all = 1.0;
    let mut blend_count = 0usize;
    for zone_index in 0..zone_count {
        let base = zone_index * METAL_DEPOSIT_FLAT_ZONE_INPUT_STRIDE;
        if let Some(wz) = metal_deposit_flat_zone_blend_weight(x, y, flat_zones, base) {
            prod_all *= 1.0 - wz;
            blend_count += 1;
        }
    }
    if blend_count == 0 {
        return (1.0, 0.0);
    }

    let mut weighted_height_sum = 0.0;
    let mut effective_sum = 0.0;
    for zone_index in 0..zone_count {
        let base = zone_index * METAL_DEPOSIT_FLAT_ZONE_INPUT_STRIDE;
        let Some(wz) = metal_deposit_flat_zone_blend_weight(x, y, flat_zones, base) else {
            continue;
        };
        let one_minus = 1.0 - wz;
        let ei = if one_minus > 1e-12 {
            wz * (prod_all / one_minus)
        } else {
            let mut prod_excl = 1.0;
            for other_index in 0..zone_count {
                if other_index == zone_index {
                    continue;
                }
                let other_base = other_index * METAL_DEPOSIT_FLAT_ZONE_INPUT_STRIDE;
                if let Some(other_wz) =
                    metal_deposit_flat_zone_blend_weight(x, y, flat_zones, other_base)
                {
                    prod_excl *= 1.0 - other_wz;
                }
            }
            wz * prod_excl
        };
        weighted_height_sum += ei * flat_zones[base + 3];
        effective_sum += ei;
    }

    let total_weight = effective_sum + prod_all;
    if total_weight <= 0.0 || effective_sum <= 0.0 {
        return (1.0, 0.0);
    }
    (prod_all / total_weight, weighted_height_sum / effective_sum)
}

// ─────────────────────────────────────────────────────────────────
//  Waters-edge shoreline pass (beach / cliff slices)
//
//  Runs after plateau terracing and before the deposit flat-pad
//  blend. The waterline is divided into angular slices around the
//  map-oval center; alternating slices are beaches (the terrain
//  gradient is compressed through the waterline so every unit can
//  wade in and out) or cliffs (heights near the waterline snap away
//  from it into a single plateau-style wall, reusing the plateau
//  ramp curve and wall-slope shaping so shoreline cliffs look like
//  every other cliff on the map). Both operators are identity at
//  their band edges, so the pass is continuous with the rest of the
//  heightfield. Mirrored by applyWatersEdge in
//  terrainHeightGenerator.ts.
// ─────────────────────────────────────────────────────────────────

/// Beach slope 0 is a VALID beach — a perfectly flat shelf at the
/// water level, fading out over the beach radius. The operator is
/// disabled only by a non-positive fade radius (or a negative slope).
#[inline]
pub(crate) fn terrain_waters_edge_beach_enabled(cfg: &MetalDepositTerrainConfigRust) -> bool {
    cfg.waters_edge_beach_slope_degrees >= 0.0 && cfg.shoreline_beach_fade_radius > 0.0
}

/// First-order horizontal distance from a point to the waterline
/// contour: how far you must walk down/up the local slope for the
/// shaped surface to reach the water level. Follows the water's curves
/// on both the land and water sides; both shoreline fades key off it.
#[inline]
pub(crate) fn terrain_waters_edge_shore_distance(shaped: f64, gradient: f64) -> f64 {
    (shaped - TERRAIN_WATER_LEVEL).abs() / gradient.abs().max(1e-3)
}

/// Raised-cosine shoreline fade: 1 (full effect) at the waterline,
/// easing to 0 at `radius` world units from the water's edge. The one
/// falloff shape shared by the beach and cliff operators.
#[inline]
pub(crate) fn terrain_waters_edge_fade_weight(shore_distance: f64, radius: f64) -> f64 {
    if radius <= 0.0 {
        return 0.0;
    }
    1.0 - terrain_perimeter_ramp_weight((shore_distance / radius).min(1.0))
}

#[inline]
pub(crate) fn terrain_waters_edge_cliff_enabled(cfg: &MetalDepositTerrainConfigRust) -> bool {
    cfg.waters_edge_cliff_height > 0.0 && cfg.shoreline_cliff_fade_radius > 0.0
}

/// Conservative vertical reach of the CLIFF band around the waterline
/// (the beach is gated by horizontal shore distance instead). Plateau
/// snapping can move a height by up to half a step, so the pre-plateau
/// band gate widens by that much.
pub(crate) fn terrain_waters_edge_band_extent(cfg: &MetalDepositTerrainConfigRust) -> f64 {
    let cliff_half = if terrain_waters_edge_cliff_enabled(cfg) {
        cfg.waters_edge_cliff_height * 0.5
    } else {
        0.0
    };
    let plateau_slack = if cfg.terrain_d_terrain > 0.0 {
        cfg.terrain_d_terrain * 0.5
    } else {
        0.0
    };
    cliff_half + plateau_slack
}

/// Cliffness in [0, 1] for the shoreline at `angle`. The pattern is
/// team-periodic so every player slice gets an IDENTICAL shoreline:
/// each player's slice (2π / teamCount, anchored like ridges and
/// deposit rings at METAL_DEPOSIT_FIRST_PLAYER_ANGLE) is split in
/// half — the beach half centered on the player's spoke, the cliff
/// half centered on the divider ridge between players.
///
/// The beach↔cliff transition is NOT a slow angular fade: it is an
/// end-cap wall. Its arc length is a fixed world-unit width derived
/// from the same wall-slope config every other wall uses (the run
/// needed to drop half a cliff step at that slope), so the cliff face
/// turns the corner at each half boundary as a real radial wall face
/// and the wall strip stays a wall until its shelves converge.
pub(crate) fn terrain_waters_edge_cap_width(cfg: &MetalDepositTerrainConfigRust) -> f64 {
    let angle = cfg.plateau_wall_slope_degrees.clamp(1.0, 89.0);
    let tan_angle = (angle * std::f64::consts::PI / 180.0).tan().max(1e-6);
    ((cfg.waters_edge_cliff_height * 0.5) / tan_angle).max(2.0)
}

pub(crate) fn terrain_waters_edge_slice_cliffness(
    angle: f64,
    distance: f64,
    cfg: &MetalDepositTerrainConfigRust,
) -> f64 {
    let teams = (cfg.team_count.max(1)) as f64;
    let cycle = std::f64::consts::TAU / teams;
    // +0.25 rotates the half boundaries a quarter slice so the beach
    // half straddles the player spoke and the cliff half the divider.
    let rel = (angle - METAL_DEPOSIT_FIRST_PLAYER_ANGLE) / cycle + 0.25;
    let phase = (rel - rel.floor()) * 2.0;
    let k = phase.floor();
    let u = phase - k;
    let current = k; // half 0 = beach (0), half 1 = cliff (1)
    // Cap width in half-slice phase units at this radius: one half
    // spans an arc of distance * cycle / 2 world units.
    let half_arc = distance.max(1.0) * cycle * 0.5;
    let transition = (terrain_waters_edge_cap_width(cfg) / half_arc).min(0.5);
    if u >= transition {
        return current;
    }
    let previous = 1.0 - current;
    previous + (current - previous) * terrain_smootherstep(u / transition)
}

/// Cliffness with the enable-gates applied — the single source both the
/// height operator and the mesh build's zone classification read, so
/// geometry and WALL TRIS regions can never disagree. Beach-only
/// shorelines are 0 everywhere, cliff-only are 1 everywhere.
pub(crate) fn terrain_waters_edge_effective_cliffness(
    angle: f64,
    distance: f64,
    cfg: &MetalDepositTerrainConfigRust,
) -> f64 {
    let beach_enabled = terrain_waters_edge_beach_enabled(cfg);
    let cliff_enabled = terrain_waters_edge_cliff_enabled(cfg);
    if beach_enabled && cliff_enabled {
        terrain_waters_edge_slice_cliffness(angle, distance, cfg)
    } else if cliff_enabled {
        1.0
    } else {
        0.0
    }
}

/// Effective cliffness at a world point (the oval fields are private to
/// this module; the mesh build's region classification calls through
/// here).
pub(crate) fn terrain_waters_edge_slice_cliffness_at(
    metrics: &MapOvalMetricsRust,
    x: f64,
    y: f64,
    cfg: &MetalDepositTerrainConfigRust,
) -> f64 {
    let oval = terrain_sample_map_oval_at(metrics, x, y);
    terrain_waters_edge_effective_cliffness(oval.angle, oval.distance, cfg)
}

/// Beach operator: fade out plateau terracing and compress the height
/// gradient so the surface crosses the waterline at (at most) the
/// authored beach slope. Full effect at the water's edge, raised-cosine
/// fade back to the natural surface over `shoreline_beach_fade_radius`
/// world units of horizontal shore distance on both sides — the same
/// falloff shape and distance metric as the cliff fade.
pub(crate) fn terrain_waters_edge_beach_height(
    terraced: f64,
    shaped: f64,
    gradient: f64,
    cfg: &MetalDepositTerrainConfigRust,
) -> f64 {
    let shore_distance = terrain_waters_edge_shore_distance(shaped, gradient);
    let weight = terrain_waters_edge_fade_weight(shore_distance, cfg.shoreline_beach_fade_radius);
    if weight <= 0.0 {
        return terraced;
    }
    let beach_tan = (cfg.waters_edge_beach_slope_degrees.clamp(0.0, 89.0)
        * std::f64::consts::PI
        / 180.0)
        .tan();
    let gradient_scale = (beach_tan / gradient.max(1e-6)).min(1.0);
    let unterraced = terraced + (shaped - terraced) * weight;
    let scale = gradient_scale + (1.0 - gradient_scale) * (1.0 - weight);
    TERRAIN_WATER_LEVEL + (unterraced - TERRAIN_WATER_LEVEL) * scale
}

/// Cliff operator: heights within half a cliff-height of the waterline
/// snap onto a single plateau-style terrace step centered on the
/// waterline — flat shelves just below and above the water joined by a
/// wall shaped by the same ramp curve and wall-slope config as plateau
/// walls. Identity at the band edges.
///
/// The snap's amplitude fades with horizontal distance to the water's
/// edge over `shoreline_cliff_fade_radius`: the raised dry lip and the
/// dredged bed hug the waterline (the first-order level-set distance
/// |shaped - WL| / |gradient| follows the water's curves on both
/// sides) and relax back to the natural surface beyond the radius.
/// The wall REGION classification is untouched — inland wall loops
/// stay closed in WALL TRIS, their triangles just carry no height
/// change, like any other squished wall. Radius <= 0 disables the
/// cliff operator entirely (same rule as the beach's radius).
pub(crate) fn terrain_waters_edge_cliff_height_at(
    terraced: f64,
    shaped: f64,
    gradient: f64,
    cfg: &MetalDepositTerrainConfigRust,
) -> f64 {
    let step = cfg.waters_edge_cliff_height;
    let half = step * 0.5;
    let d = terraced - TERRAIN_WATER_LEVEL;
    if d.abs() >= half {
        return terraced;
    }
    let t = (d + half) / step;
    let flat_half = terrain_plateau_flat_half_for_gradient(gradient, cfg);
    let ramp = if t <= flat_half {
        0.0
    } else if t >= 1.0 - flat_half {
        1.0
    } else {
        let ramp_span = (1.0 - flat_half * 2.0).max(1e-6);
        terrain_plateau_ramp_curve((t - flat_half) / ramp_span, cfg)
    };
    let snapped = TERRAIN_WATER_LEVEL - half + ramp * step;
    let shore_distance = terrain_waters_edge_shore_distance(shaped, gradient);
    let weight = terrain_waters_edge_fade_weight(shore_distance, cfg.shoreline_cliff_fade_radius);
    terraced + (snapped - terraced) * weight
}

/// Waters-edge cliff wall coordinates for region classification: the
/// dimensionless wall coordinate `t` (0 at the submerged band edge,
/// 1 at the dry band edge — the same coordinate
/// `terrain_waters_edge_cliff_height_at` ramps over) and the shelf
/// flat-half for this point. Replays the pipeline stages that run
/// BEFORE the waters-edge pass (gradient rule, plateaus, deposit
/// pads) so classification seams land exactly where the emitted
/// geometry bends. None when waterfront cliffs are disabled.
pub(crate) fn terrain_waters_edge_cliff_coords(
    x: f64,
    y: f64,
    metrics: &MapOvalMetricsRust,
    cfg: &MetalDepositTerrainConfigRust,
    explicit_flat_zones: &[f64],
) -> Option<(f64, f64)> {
    if !terrain_waters_edge_cliff_enabled(cfg) {
        return None;
    }
    let shaped = terrain_shaped_height_before_plateaus(x, y, metrics, cfg);
    // The pipeline estimates the gradient whenever the waters-edge pass
    // is enabled (the shore-distance fades need it); cliff_enabled here
    // implies enabled, so mirror that unconditionally.
    let gradient = terrain_estimate_shaped_gradient(x, y, metrics, cfg);
    let mut padded = shaped;
    for code in cfg.pipeline_transform_order {
        padded = match code {
            0 => terrain_apply_plateaus(padded, gradient, cfg),
            1 => {
                let (weight, pad_height) =
                    metal_deposit_override_from_flat_zone_rows(x, y, explicit_flat_zones);
                pad_height * (1.0 - weight) + padded * weight
            }
            _ => break,
        };
    }
    let step = cfg.waters_edge_cliff_height;
    let t = (padded - (TERRAIN_WATER_LEVEL - step * 0.5)) / step;
    let flat_half = terrain_plateau_flat_half_for_gradient(gradient, cfg);
    Some((t, flat_half))
}

/// Waters-edge region keys along the height axis: 0 below the cliff
/// band, 1 submerged shelf, 2 wall, 3 dry shelf, 4 above the band.
/// Odd/even parity is irrelevant here — key 2 is the wall.
pub(crate) fn terrain_waters_edge_region_key_for_coords(t: f64, flat_half: f64) -> i32 {
    if t <= 0.0 {
        0
    } else if t <= flat_half {
        1
    } else if t < 1.0 - flat_half {
        2
    } else if t < 1.0 {
        3
    } else {
        4
    }
}

/// Signed boundary function whose zero level-set separates waters-edge
/// region `after_key` from `after_key + 1` (negative on the lower-key
/// side), matching `terrain_plateau_boundary_value_at_world`'s
/// convention so the same polygon clipper drives both region systems.
pub(crate) fn terrain_waters_edge_boundary_value_for_coords(
    t: f64,
    flat_half: f64,
    after_key: i32,
) -> f64 {
    match after_key {
        0 => t,
        1 => t - flat_half,
        2 => t - (1.0 - flat_half),
        _ => t - 1.0,
    }
}

pub(crate) fn terrain_apply_waters_edge(
    terraced: f64,
    shaped: f64,
    gradient: f64,
    angle: f64,
    distance: f64,
    cfg: &MetalDepositTerrainConfigRust,
) -> f64 {
    let beach_enabled = terrain_waters_edge_beach_enabled(cfg);
    let cliff_enabled = terrain_waters_edge_cliff_enabled(cfg);
    if !beach_enabled && !cliff_enabled {
        return terraced;
    }
    let cliffness = terrain_waters_edge_effective_cliffness(angle, distance, cfg);
    let beach = if beach_enabled && cliffness < 1.0 {
        terrain_waters_edge_beach_height(terraced, shaped, gradient, cfg)
    } else {
        terraced
    };
    let cliff = if cliff_enabled && cliffness > 0.0 {
        terrain_waters_edge_cliff_height_at(terraced, shaped, gradient, cfg)
    } else {
        terraced
    };
    beach + (cliff - beach) * cliffness
}

pub(crate) fn metal_deposit_terrain_height_with_explicit_zones(
    x: f64,
    y: f64,
    metrics: &MapOvalMetricsRust,
    cfg: &MetalDepositTerrainConfigRust,
    explicit_flat_zones: &[f64],
) -> f64 {
    let shaped = terrain_shaped_height_before_plateaus(x, y, metrics, cfg);
    let beach_enabled = terrain_waters_edge_beach_enabled(cfg);
    let cliff_enabled = terrain_waters_edge_cliff_enabled(cfg);
    let waters_edge_enabled = beach_enabled || cliff_enabled;
    let plateau_gradient_needed =
        cfg.terrain_d_terrain > 0.0 && cfg.plateau_wall_slope_degrees < 89.0;
    // The shore-distance fades need the gradient wherever the pass is
    // enabled, so the estimate is no longer gated to a vertical band.
    let gradient = if plateau_gradient_needed || waters_edge_enabled {
        terrain_estimate_shaped_gradient(x, y, metrics, cfg)
    } else {
        0.0
    };
    let waters_edge_active = waters_edge_enabled && {
        let shore_distance = terrain_waters_edge_shore_distance(shaped, gradient);
        (beach_enabled && shore_distance < cfg.shoreline_beach_fade_radius)
            || (cliff_enabled
                && (shaped - TERRAIN_WATER_LEVEL).abs() < terrain_waters_edge_band_extent(cfg))
    };
    // The three transform stages run in the order authored in
    // terrainConfig.json `pipeline` (packed as codes 27..29): later
    // stages shape the output of earlier ones, so e.g. waters-edge
    // after deposit pads means the shoreline wins at the water while
    // inland pads keep their flat tops.
    let mut height = shaped;
    for code in cfg.pipeline_transform_order {
        height = match code {
            0 => terrain_apply_plateaus(height, gradient, cfg),
            1 => {
                let (weight, pad_height) =
                    metal_deposit_override_from_flat_zone_rows(x, y, explicit_flat_zones);
                pad_height * (1.0 - weight) + height * weight
            }
            _ => {
                if waters_edge_active {
                    let oval = terrain_sample_map_oval_at(metrics, x, y);
                    terrain_apply_waters_edge(
                        height,
                        shaped,
                        gradient,
                        oval.angle,
                        oval.distance,
                        cfg,
                    )
                } else {
                    height
                }
            }
        };
    }
    height.max(cfg.tile_floor_y)
}

#[inline]
pub(crate) fn metal_deposit_loop_count(limit: f64) -> u32 {
    if !limit.is_finite() || limit <= 0.0 {
        return 0;
    }
    limit.ceil() as u32
}

#[wasm_bindgen]
pub fn metal_deposit_count_placements(player_count: u32, rings: &[f64]) -> u32 {
    if rings.len() % METAL_DEPOSIT_RING_INPUT_STRIDE != 0 {
        return 0;
    }
    let players = player_count.max(1);
    let mut count = 0u32;
    let ring_count = rings.len() / METAL_DEPOSIT_RING_INPUT_STRIDE;
    for ring_index in 0..ring_count {
        let base = ring_index * METAL_DEPOSIT_RING_INPUT_STRIDE;
        let radius_fraction = rings[base];
        if radius_fraction <= 1e-6 {
            count = count.saturating_add(1);
            continue;
        }
        count =
            count.saturating_add(players.saturating_mul(metal_deposit_loop_count(rings[base + 1])));
    }
    count
}

#[allow(clippy::too_many_arguments)]
#[wasm_bindgen]
pub fn metal_deposit_generate_placements(
    map_width: f64,
    map_height: f64,
    player_count: u32,
    extent_fraction: f64,
    edge_margin_px: f64,
    build_grid_cell_size: f64,
    metal_deposit_step: f64,
    resource_cells: u32,
    resource_radius_cells: i32,
    rings: &[f64],
    out_placements: &mut [f64],
) -> u32 {
    if rings.len() % METAL_DEPOSIT_RING_INPUT_STRIDE != 0
        || !map_width.is_finite()
        || !map_height.is_finite()
        || !extent_fraction.is_finite()
        || !edge_margin_px.is_finite()
        || !build_grid_cell_size.is_finite()
        || build_grid_cell_size <= 0.0
        || !metal_deposit_step.is_finite()
        || resource_cells == 0
        || resource_radius_cells <= 0
    {
        return 0;
    }

    let expected = metal_deposit_count_placements(player_count, rings) as usize;
    if out_placements.len() < expected * METAL_DEPOSIT_PLACEMENT_OUTPUT_STRIDE {
        return 0;
    }

    let fraction = extent_fraction.clamp(0.01, 1.0);
    let width = (map_width * fraction).max(1.0);
    let height = (map_height * fraction).max(1.0);
    let min_dim = width.min(height).max(1.0);
    let cx = map_width * 0.5;
    let cy = map_height * 0.5;
    let scale_x = width / min_dim;
    let scale_y = height / min_dim;
    let half_extent = min_dim * 0.5 - edge_margin_px;
    let players = player_count.max(1);
    let players_f64 = players as f64;
    let slice_width = std::f64::consts::TAU / players_f64;
    let resource_cells_f64 = resource_cells as f64;
    let resource_cell_count = resource_cells.saturating_mul(resource_cells);
    let resource_half_size = (resource_cells_f64 * build_grid_cell_size) * 0.5;
    let resource_radius = (resource_radius_cells as f64 + 0.5) * build_grid_cell_size;
    let grid_half_cells = (resource_cells / 2) as i32;

    let mut out_count = 0usize;
    let mut push_placement =
        |raw_x: f64, raw_y: f64, flat_pad_cells: f64, d_terrain_levels: f64, blend_radius: f64| {
            let center_gx = (raw_x / build_grid_cell_size).floor() as i32;
            let center_gy = (raw_y / build_grid_cell_size).floor() as i32;
            let grid_x = center_gx - grid_half_cells;
            let grid_y = center_gy - grid_half_cells;
            let snapped_x = grid_x as f64 * build_grid_cell_size + resource_half_size;
            let snapped_y = grid_y as f64 * build_grid_cell_size + resource_half_size;
            let origin_gx = (snapped_x / build_grid_cell_size).floor() as i32;
            let origin_gy = (snapped_y / build_grid_cell_size).floor() as i32;
            let flat_pad_radius = (flat_pad_cells * build_grid_cell_size) * 0.5;
            let explicit_height = if d_terrain_levels.is_nan() {
                METAL_DEPOSIT_D_TERRAIN_NULL
            } else {
                d_terrain_levels * metal_deposit_step
            };

            let base = out_count * METAL_DEPOSIT_PLACEMENT_OUTPUT_STRIDE;
            out_placements[base] = snapped_x;
            out_placements[base + 1] = snapped_y;
            out_placements[base + 2] = grid_x as f64;
            out_placements[base + 3] = grid_y as f64;
            out_placements[base + 4] = origin_gx as f64;
            out_placements[base + 5] = origin_gy as f64;
            out_placements[base + 6] = resource_cells_f64;
            out_placements[base + 7] = resource_cell_count as f64;
            out_placements[base + 8] = resource_radius_cells as f64;
            out_placements[base + 9] = resource_half_size;
            out_placements[base + 10] = resource_radius;
            out_placements[base + 11] = flat_pad_radius;
            out_placements[base + 12] = d_terrain_levels;
            out_placements[base + 13] = blend_radius;
            out_placements[base + 14] = explicit_height;
            out_count += 1;
        };

    let ring_count = rings.len() / METAL_DEPOSIT_RING_INPUT_STRIDE;
    for ring_index in 0..ring_count {
        let base = ring_index * METAL_DEPOSIT_RING_INPUT_STRIDE;
        let radius_fraction = rings[base];
        let count_per_player_raw = rings[base + 1];
        let count_per_player = metal_deposit_loop_count(count_per_player_raw);
        let slice_offset = rings[base + 2];
        let d_terrain_levels = rings[base + 3];
        let flat_pad_cells = rings[base + 4];
        let blend_radius = rings[base + 5];
        let ring_radius = radius_fraction * half_extent;
        let ring_angular_offset = slice_offset * slice_width;

        if radius_fraction <= 1e-6 {
            push_placement(cx, cy, flat_pad_cells, d_terrain_levels, blend_radius);
            continue;
        }

        for player_index in 0..players {
            let slice_center = (player_index as f64 / players_f64) * std::f64::consts::TAU
                + METAL_DEPOSIT_FIRST_PLAYER_ANGLE;
            for j in 0..count_per_player {
                let t = (j as f64 + 0.5) / count_per_player_raw;
                let angle_in_slice = -slice_width * 0.5 + t * slice_width;
                let angle = slice_center + angle_in_slice + ring_angular_offset;
                let raw_x = cx + angle.cos() * ring_radius * scale_x;
                let raw_y = cy + angle.sin() * ring_radius * scale_y;
                push_placement(raw_x, raw_y, flat_pad_cells, d_terrain_levels, blend_radius);
            }
        }
    }

    out_count as u32
}

#[wasm_bindgen]
pub fn metal_deposit_resolve_terrain_heights(
    map_width: f64,
    map_height: f64,
    extent_fraction: f64,
    terrain_config: &[f64],
    explicit_flat_zones: &[f64],
    height_inputs: &[f64],
    out_heights: &mut [f64],
) -> u32 {
    if !map_width.is_finite()
        || !map_height.is_finite()
        || !extent_fraction.is_finite()
        || height_inputs.len() % METAL_DEPOSIT_HEIGHT_INPUT_STRIDE != 0
        || explicit_flat_zones.len() % METAL_DEPOSIT_FLAT_ZONE_INPUT_STRIDE != 0
    {
        return 0;
    }
    let Some(cfg) = metal_deposit_terrain_config_from_slice(terrain_config) else {
        return 0;
    };
    for value in explicit_flat_zones {
        if !value.is_finite() {
            return 0;
        }
    }

    let count = height_inputs.len() / METAL_DEPOSIT_HEIGHT_INPUT_STRIDE;
    if out_heights.len() < count {
        return 0;
    }
    let metrics = terrain_make_oval_metrics(map_width, map_height, extent_fraction);
    for i in 0..count {
        let base = i * METAL_DEPOSIT_HEIGHT_INPUT_STRIDE;
        let x = height_inputs[base];
        let y = height_inputs[base + 1];
        let explicit_height = height_inputs[base + 2];
        if !x.is_finite() || !y.is_finite() {
            return 0;
        }
        out_heights[i] = if explicit_height.is_nan() {
            metal_deposit_terrain_height_with_explicit_zones(
                x,
                y,
                &metrics,
                &cfg,
                explicit_flat_zones,
            )
        } else if explicit_height.is_finite() {
            explicit_height
        } else {
            return 0;
        };
    }
    count as u32
}

#[wasm_bindgen]
pub fn metal_deposit_count_resource_candidates(radius_cells: i32) -> u32 {
    if radius_cells <= 0 {
        return 0;
    }
    let r2 = radius_cells * radius_cells;
    let mut count = 0u32;
    for dy in -radius_cells..=radius_cells {
        for dx in -radius_cells..=radius_cells {
            if dx * dx + dy * dy <= r2 {
                count += 1;
            }
        }
    }
    count
}

pub(crate) fn metal_deposit_rng_next(seed: &mut u32) -> f64 {
    *seed = seed.wrapping_add(0x6D2B79F5);
    let mut t = *seed;
    t = (t ^ (t >> 15)).wrapping_mul(t | 1);
    t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
    ((t ^ (t >> 14)) as f64) / 4294967296.0
}

pub(crate) fn metal_deposit_lookup_offset(
    offset_to_index: &[i32],
    radius_cells: i32,
    diameter: i32,
    dx: i32,
    dy: i32,
) -> i32 {
    if dx < -radius_cells || dx > radius_cells || dy < -radius_cells || dy > radius_cells {
        return -1;
    }
    offset_to_index[((dy + radius_cells) * diameter + dx + radius_cells) as usize]
}

#[wasm_bindgen]
pub fn metal_deposit_grow_resource_cells(
    origin_gx: i32,
    origin_gy: i32,
    target_cell_count: u32,
    radius_cells: i32,
    seed: u32,
    out_cells: &mut [i32],
) -> u32 {
    if target_cell_count == 0 || radius_cells <= 0 {
        return 0;
    }
    let target = target_cell_count as usize;
    if out_cells.len() < target * 2 {
        return 0;
    }

    let diameter = radius_cells * 2 + 1;
    let mut offset_to_index = vec![-1i32; (diameter * diameter) as usize];
    let mut dx_values: Vec<i32> = Vec::new();
    let mut dy_values: Vec<i32> = Vec::new();
    let mut center_bias: Vec<f64> = Vec::new();
    let r2 = radius_cells * radius_cells;
    let radius_scale = (radius_cells.max(1)) as f64;
    let mut origin_index = -1i32;

    for dy in -radius_cells..=radius_cells {
        for dx in -radius_cells..=radius_cells {
            let distance_squared = dx * dx + dy * dy;
            if distance_squared > r2 {
                continue;
            }
            let index = dx_values.len() as i32;
            offset_to_index[((dy + radius_cells) * diameter + dx + radius_cells) as usize] = index;
            dx_values.push(dx);
            dy_values.push(dy);
            center_bias.push(1.0 - ((distance_squared as f64).sqrt() / radius_scale).min(1.0));
            if dx == 0 && dy == 0 {
                origin_index = index;
            }
        }
    }

    let count = dx_values.len();
    if origin_index < 0 || count < target {
        return 0;
    }

    let mut neighbor_indices = vec![-1i32; count * METAL_DEPOSIT_RESOURCE_NEIGHBOR_COUNT];
    for i in 0..count {
        let dx = dx_values[i];
        let dy = dy_values[i];
        let base = i * METAL_DEPOSIT_RESOURCE_NEIGHBOR_COUNT;
        neighbor_indices[base] =
            metal_deposit_lookup_offset(&offset_to_index, radius_cells, diameter, dx + 1, dy);
        neighbor_indices[base + 1] =
            metal_deposit_lookup_offset(&offset_to_index, radius_cells, diameter, dx - 1, dy);
        neighbor_indices[base + 2] =
            metal_deposit_lookup_offset(&offset_to_index, radius_cells, diameter, dx, dy + 1);
        neighbor_indices[base + 3] =
            metal_deposit_lookup_offset(&offset_to_index, radius_cells, diameter, dx, dy - 1);
    }

    let mut selected = vec![0u8; count];
    let mut frontier = vec![0u8; count];
    let mut neighbor_counts = vec![0u8; count];
    let mut frontier_prev = vec![-1i32; count];
    let mut frontier_next = vec![-1i32; count];
    let mut weights = vec![0.0f64; count];
    let mut selected_indices: Vec<usize> = Vec::with_capacity(target);
    let mut frontier_head = -1i32;
    let mut frontier_tail = -1i32;
    let mut frontier_size = 0usize;

    pub(crate) fn remove_frontier(
        index: usize,
        frontier: &mut [u8],
        frontier_prev: &mut [i32],
        frontier_next: &mut [i32],
        frontier_head: &mut i32,
        frontier_tail: &mut i32,
        frontier_size: &mut usize,
    ) {
        if frontier[index] == 0 {
            return;
        }
        let prev = frontier_prev[index];
        let next = frontier_next[index];
        if prev >= 0 {
            frontier_next[prev as usize] = next;
        } else {
            *frontier_head = next;
        }
        if next >= 0 {
            frontier_prev[next as usize] = prev;
        } else {
            *frontier_tail = prev;
        }
        frontier_prev[index] = -1;
        frontier_next[index] = -1;
        frontier[index] = 0;
        *frontier_size -= 1;
    }

    pub(crate) fn append_frontier(
        index: i32,
        selected: &[u8],
        frontier: &mut [u8],
        frontier_prev: &mut [i32],
        frontier_next: &mut [i32],
        frontier_head: &mut i32,
        frontier_tail: &mut i32,
        frontier_size: &mut usize,
    ) {
        if index < 0 {
            return;
        }
        let i = index as usize;
        if selected[i] != 0 || frontier[i] != 0 {
            return;
        }
        frontier[i] = 1;
        frontier_prev[i] = *frontier_tail;
        frontier_next[i] = -1;
        if *frontier_tail >= 0 {
            frontier_next[*frontier_tail as usize] = index;
        } else {
            *frontier_head = index;
        }
        *frontier_tail = index;
        *frontier_size += 1;
    }

    pub(crate) fn add_selected(
        index: usize,
        selected: &mut [u8],
        frontier: &mut [u8],
        neighbor_counts: &mut [u8],
        frontier_prev: &mut [i32],
        frontier_next: &mut [i32],
        selected_indices: &mut Vec<usize>,
        neighbor_indices: &[i32],
        frontier_head: &mut i32,
        frontier_tail: &mut i32,
        frontier_size: &mut usize,
    ) {
        if selected[index] != 0 {
            return;
        }
        selected[index] = 1;
        selected_indices.push(index);
        remove_frontier(
            index,
            frontier,
            frontier_prev,
            frontier_next,
            frontier_head,
            frontier_tail,
            frontier_size,
        );

        let base = index * METAL_DEPOSIT_RESOURCE_NEIGHBOR_COUNT;
        for i in 0..METAL_DEPOSIT_RESOURCE_NEIGHBOR_COUNT {
            let neighbor_index = neighbor_indices[base + i];
            if neighbor_index >= 0 {
                neighbor_counts[neighbor_index as usize] += 1;
            }
        }
        for i in 0..METAL_DEPOSIT_RESOURCE_NEIGHBOR_COUNT {
            append_frontier(
                neighbor_indices[base + i],
                selected,
                frontier,
                frontier_prev,
                frontier_next,
                frontier_head,
                frontier_tail,
                frontier_size,
            );
        }
    }

    add_selected(
        origin_index as usize,
        &mut selected,
        &mut frontier,
        &mut neighbor_counts,
        &mut frontier_prev,
        &mut frontier_next,
        &mut selected_indices,
        &neighbor_indices,
        &mut frontier_head,
        &mut frontier_tail,
        &mut frontier_size,
    );

    let mut rng_seed = seed;
    while selected_indices.len() < target && frontier_size > 0 {
        let mut total_weight = 0.0;
        let mut last_frontier_index = -1i32;
        let mut index = frontier_head;
        while index >= 0 {
            let i = index as usize;
            let weight = 0.45
                + neighbor_counts[i] as f64 * 1.75
                + center_bias[i] * 2.25
                + metal_deposit_rng_next(&mut rng_seed) * 0.35;
            total_weight += weight;
            weights[i] = weight;
            last_frontier_index = index;
            index = frontier_next[i];
        }

        let mut pick = metal_deposit_rng_next(&mut rng_seed) * total_weight;
        let mut chosen_index = last_frontier_index;
        index = frontier_head;
        while index >= 0 {
            let i = index as usize;
            pick -= weights[i];
            if pick <= 0.0 {
                chosen_index = index;
                break;
            }
            index = frontier_next[i];
        }
        if chosen_index < 0 {
            break;
        }
        add_selected(
            chosen_index as usize,
            &mut selected,
            &mut frontier,
            &mut neighbor_counts,
            &mut frontier_prev,
            &mut frontier_next,
            &mut selected_indices,
            &neighbor_indices,
            &mut frontier_head,
            &mut frontier_tail,
            &mut frontier_size,
        );
    }

    let mut cells: Vec<(i32, i32)> = selected_indices
        .iter()
        .map(|&index| (origin_gx + dx_values[index], origin_gy + dy_values[index]))
        .collect();
    cells.sort_by(|a, b| {
        let by_y = a.1.cmp(&b.1);
        if by_y == std::cmp::Ordering::Equal {
            a.0.cmp(&b.0)
        } else {
            by_y
        }
    });

    for (i, (gx, gy)) in cells.iter().enumerate() {
        let base = i * 2;
        out_cells[base] = *gx;
        out_cells[base + 1] = *gy;
    }
    cells.len() as u32
}

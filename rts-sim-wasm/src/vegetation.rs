// vegetation — deterministic trees / grass / seaweed as reclaimable
// energy deposits.
//
// BAR INHERITANCE. Beyond All Reason models trees as engine features
// with `reclaimable = true`, `energy = 250`, `metal = 0`,
// `reclaimTime = 1500` and `damage = 250` (HP), consumed gradually
// (`modrules.lua` `reclaim.reclaimMethod = 0`) by any constructor's
// build power. We keep those exact semantics: a prop's HP is its work
// pool, build power drains it at `maxHp * rate / reclaimTime` per
// second, and the payout is strictly proportional to the HP removed.
// A builder of build power B therefore consumes a prop in
// `reclaimTime / B` seconds and collects the full authored yield —
// the same arithmetic a BAR feature def describes.
//
// WHY THIS LIVES IN RUST. Vegetation stopped being decoration the
// moment it became a resource: every peer must agree on where each
// prop is, which ones are gone, and how much energy is left in them.
// This module owns the placement kernel, the prop store, the reclaim
// arithmetic, and the removal log, so the local server simulation and
// the client presentation layer read one set of numbers instead of
// two independently-drifting float paths. Placement samples the
// already-installed authoritative terrain mesh, so it inherits that
// mesh's determinism for free.
//
// TypeScript owns config validation, asset identity, and object
// assembly (src/game/sim/vegetation.ts); Rust owns every number.

#[allow(unused_imports)]
use crate::*;
#[allow(unused_imports)]
use wasm_bindgen::prelude::*;

/// Packed per-kind placement rule row. Field order is a wire contract
/// shared with `packVegetationKindRows` in src/game/sim/vegetation.ts.
///   0 targetCount            1 medium (0 land, 1 waterline)
///   2 waterBuffer            3 waterlineRangeFraction
///   4 minSlope               5 maxSlope
///   6 maxTerrainHeight       7 heightScaleMin
///   8 heightScaleMax         9 radiusScaleMin
///  10 radiusScaleMax        11 slopeSinkRadiusFrac
///  12 slopeSinkMaxHeightFrac
///  13 assetRowStart         14 assetRowCount
///  15 reclaimHp             16 reclaimTime
///  17 reclaimEnergy         18 reclaimMetal
pub(crate) const VEGETATION_KIND_ROW_STRIDE: usize = 19;

/// Packed asset option row: 0 weight, 1 defaultHeight, 2 defaultRadius,
/// 3 assetScale (the renderer's per-asset scale multiplier).
pub(crate) const VEGETATION_ASSET_ROW_STRIDE: usize = 4;

/// Packed generated prop row read back by TS/the renderer:
///   0 kind    1 assetSlot    2 x    3 y    4 z (base)
///   5 rotation    6 height    7 radius    8 maxHp    9 energyTotal
pub(crate) const VEGETATION_PROP_OUTPUT_STRIDE: usize = 10;

/// Live per-prop state row: 0 alive, 1 hp, 2 maxHp, 3 energyLeft,
/// 4 metalLeft, 5 reclaimFraction (1 = untouched, 0 = consumed).
pub(crate) const VEGETATION_PROP_STATE_STRIDE: usize = 6;

/// Reclaim tick result row: 0 energyGained, 1 metalGained,
/// 2 hpRemoved, 3 reclaimFraction, 4 completed (1/0).
pub(crate) const VEGETATION_RECLAIM_TICK_STRIDE: usize = 5;

/// Broadphase bucket edge. Grass is the densest kind at roughly one
/// prop per 4000 world units squared on a default map, so this keeps
/// buckets in the low tens of entries while staying comfortably wider
/// than any area-reclaim radius step.
const VEGETATION_GRID_CELL_SIZE: f64 = 400.0;

/// Radial probes used to reject land props that sit too close to
/// water. Matches the WATER_CLEARANCE_SAMPLES ring in terrainSurface.ts.
const VEGETATION_WATER_CLEARANCE_SAMPLES: usize = 8;

/// Random draws consumed per placement attempt, always in this order
/// so the stream stays aligned whether or not the attempt is accepted:
/// asset pick, x, y, height scale, radius scale, rotation, scale jitter.
const VEGETATION_DRAWS_PER_ATTEMPT: usize = 7;

const VEGETATION_MEDIUM_WATERLINE: f64 = 1.0;
/// Canonical main terrain flat. Terrain detail, grass shading, and the
/// authored height bars all use the zero-height plane as this reference.
const VEGETATION_MAIN_TERRAIN_FLAT_Y: f64 = 0.0;

#[derive(Clone, Copy)]
pub(crate) struct VegetationProp {
    pub(crate) kind: u32,
    pub(crate) asset_slot: u32,
    pub(crate) x: f64,
    pub(crate) y: f64,
    /// World height of the prop's base (its root contact point).
    pub(crate) z: f64,
    pub(crate) rotation: f64,
    pub(crate) height: f64,
    pub(crate) radius: f64,
    pub(crate) hp: f64,
    pub(crate) max_hp: f64,
    pub(crate) energy_left: f64,
    pub(crate) metal_left: f64,
    pub(crate) energy_total: f64,
    pub(crate) metal_total: f64,
    pub(crate) reclaim_time: f64,
    pub(crate) alive: bool,
}

pub(crate) struct VegetationStore {
    pub(crate) props: Vec<VegetationProp>,
    /// Append-only log of consumed prop indices. Presentation drains it
    /// with a cursor instead of diffing the whole prop list every frame.
    pub(crate) removed: Vec<u32>,
    /// Uniform bucket grid over prop indices for circle queries and
    /// raycast broadphase.
    cell_starts: Vec<u32>,
    cell_indices: Vec<u32>,
    cols: i32,
    rows: i32,
    map_width: f64,
    map_height: f64,
    /// Widest prop radius in the store. The raycast broadphase pads its
    /// bucket sweep by this so a prop whose center sits outside the
    /// swept band but whose volume reaches into it is still tested.
    max_radius: f64,
}

impl VegetationStore {
    const fn empty() -> Self {
        VegetationStore {
            props: Vec::new(),
            removed: Vec::new(),
            cell_starts: Vec::new(),
            cell_indices: Vec::new(),
            cols: 0,
            rows: 0,
            map_width: 0.0,
            map_height: 0.0,
            max_radius: 0.0,
        }
    }

    fn clear(&mut self) {
        self.props.clear();
        self.removed.clear();
        self.cell_starts.clear();
        self.cell_indices.clear();
        self.cols = 0;
        self.rows = 0;
        self.map_width = 0.0;
        self.map_height = 0.0;
        self.max_radius = 0.0;
    }

    fn cell_of(&self, x: f64, y: f64) -> (i32, i32) {
        let cx = (x / VEGETATION_GRID_CELL_SIZE).floor() as i32;
        let cy = (y / VEGETATION_GRID_CELL_SIZE).floor() as i32;
        (
            cx.clamp(0, (self.cols - 1).max(0)),
            cy.clamp(0, (self.rows - 1).max(0)),
        )
    }

    /// Counting-sort the props into buckets. Rebuilt once after
    /// generation; props never move, and consumed props stay in their
    /// bucket with `alive = false` so the index stays stable.
    fn rebuild_grid(&mut self) {
        self.cols = ((self.map_width / VEGETATION_GRID_CELL_SIZE).ceil() as i32).max(1);
        self.rows = ((self.map_height / VEGETATION_GRID_CELL_SIZE).ceil() as i32).max(1);
        self.max_radius = 0.0;
        for prop in &self.props {
            if prop.radius > self.max_radius {
                self.max_radius = prop.radius;
            }
        }
        let cell_count = (self.cols as usize) * (self.rows as usize);
        self.cell_starts.clear();
        self.cell_starts.resize(cell_count + 1, 0);
        for prop in &self.props {
            let cx = (prop.x / VEGETATION_GRID_CELL_SIZE).floor() as i32;
            let cy = (prop.y / VEGETATION_GRID_CELL_SIZE).floor() as i32;
            let cx = cx.clamp(0, self.cols - 1);
            let cy = cy.clamp(0, self.rows - 1);
            let cell = (cy as usize) * (self.cols as usize) + (cx as usize);
            self.cell_starts[cell + 1] += 1;
        }
        for i in 0..cell_count {
            self.cell_starts[i + 1] += self.cell_starts[i];
        }
        self.cell_indices.clear();
        self.cell_indices.resize(self.props.len(), 0);
        let mut cursor = self.cell_starts.clone();
        for (index, prop) in self.props.iter().enumerate() {
            let cx = (prop.x / VEGETATION_GRID_CELL_SIZE).floor() as i32;
            let cy = (prop.y / VEGETATION_GRID_CELL_SIZE).floor() as i32;
            let cx = cx.clamp(0, self.cols - 1);
            let cy = cy.clamp(0, self.rows - 1);
            let cell = (cy as usize) * (self.cols as usize) + (cx as usize);
            let slot = cursor[cell] as usize;
            self.cell_indices[slot] = index as u32;
            cursor[cell] += 1;
        }
    }

    /// Visit every prop index whose bucket overlaps the (x, y, radius)
    /// disc. Callers still run the exact distance test.
    fn for_each_in_circle(&self, x: f64, y: f64, radius: f64, mut visit: impl FnMut(u32)) {
        if self.props.is_empty() || self.cols <= 0 || self.rows <= 0 {
            return;
        }
        let (min_cx, min_cy) = self.cell_of(x - radius, y - radius);
        let (max_cx, max_cy) = self.cell_of(x + radius, y + radius);
        for cy in min_cy..=max_cy {
            for cx in min_cx..=max_cx {
                let cell = (cy as usize) * (self.cols as usize) + (cx as usize);
                let start = self.cell_starts[cell] as usize;
                let end = self.cell_starts[cell + 1] as usize;
                for slot in start..end {
                    visit(self.cell_indices[slot]);
                }
            }
        }
    }
}

pub(crate) static VEGETATION_STORE: WasmGlobal<VegetationStore> =
    WasmGlobal::new(VegetationStore::empty());

#[inline]
pub(crate) fn vegetation_store() -> &'static mut VegetationStore {
    VEGETATION_STORE.get()
}

/// Mulberry32 — the same generator (and therefore the same stream) the
/// TypeScript placement pass used before this kernel existed, kept so
/// authored counts and densities still read the way they were tuned.
struct Mulberry32 {
    state: u32,
}

impl Mulberry32 {
    fn new(seed: u32) -> Self {
        Mulberry32 { state: seed }
    }

    fn next_f64(&mut self) -> f64 {
        self.state = self.state.wrapping_add(0x6d2b_79f5);
        let t = self.state;
        let mut r = (t ^ (t >> 15)).wrapping_mul(1 | t);
        r ^= r.wrapping_add((r ^ (r >> 7)).wrapping_mul(61 | r));
        f64::from(r ^ (r >> 14)) / 4_294_967_296.0
    }

    fn range(&mut self, min: f64, max: f64) -> f64 {
        min + self.next_f64() * (max - min)
    }
}

fn vegetation_hash_seed(values: &[f64]) -> u32 {
    let mut h: u32 = 2166136261;
    for value in values {
        let scalar = if value.is_finite() {
            value.floor() as i64
        } else {
            0
        };
        h = (h ^ (scalar as u32)).wrapping_mul(16777619);
    }
    h
}

/// Terrain-shader slope metric: 0 flat, 1 vertical.
#[inline]
fn vegetation_slope_from_normal_up(normal_up: f64) -> f64 {
    (1.0 - normal_up.abs().clamp(0.0, 1.0)).clamp(0.0, 1.0)
}

fn vegetation_slope_in_band(slope: f64, min_slope: f64, max_slope: f64) -> bool {
    slope.is_finite() && slope >= min_slope && slope <= max_slope
}

/// Lowers a prop's root by the terrain drop across its base footprint
/// so the downhill side never reveals the asset's underside.
fn vegetation_slope_sink(
    nx: f64,
    ny: f64,
    nz: f64,
    radius: f64,
    height: f64,
    radius_fraction: f64,
    max_height_fraction: f64,
) -> f64 {
    if radius <= 0.0 || height <= 0.0 || radius_fraction <= 0.0 || max_height_fraction <= 0.0 {
        return 0.0;
    }
    let normal_up = nz.abs().max(0.001);
    let horizontal = (nx * nx + ny * ny).sqrt();
    let grade = horizontal / normal_up;
    let footprint = radius * radius_fraction;
    let max_sink = height * max_height_fraction;
    (grade * footprint).clamp(0.0, max_sink)
}

fn vegetation_bed_height(x: f64, y: f64) -> f64 {
    terrain_get_bed_height(x, y)
}

fn vegetation_bed_normal(x: f64, y: f64, out: &mut [f64; 3]) -> bool {
    terrain_get_bed_normal(x, y, out) != 0
}

/// True when the disc of `buffer` around (x, y) never touches water.
/// Mirrors `isFarFromWater` in terrainSurface.ts.
fn vegetation_far_from_water(x: f64, y: f64, buffer: f64) -> bool {
    let here = vegetation_bed_height(x, y);
    if !here.is_finite() {
        return false;
    }
    if !liquid_surface_enabled() {
        return true;
    }
    if here < TERRAIN_WATER_LEVEL {
        return false;
    }
    if buffer <= 0.0 {
        return true;
    }
    for i in 0..VEGETATION_WATER_CLEARANCE_SAMPLES {
        let a = (i as f64 / VEGETATION_WATER_CLEARANCE_SAMPLES as f64) * std::f64::consts::TAU;
        let h = vegetation_bed_height(x + a.cos() * buffer, y + a.sin() * buffer);
        if !h.is_finite() || h < TERRAIN_WATER_LEVEL {
            return false;
        }
    }
    true
}

struct VegetationKindRules {
    target_count: usize,
    uses_waterline_band: bool,
    water_buffer: f64,
    waterline_range_fraction: f64,
    min_slope: f64,
    max_slope: f64,
    max_terrain_height: f64,
    height_scale_min: f64,
    height_scale_max: f64,
    radius_scale_min: f64,
    radius_scale_max: f64,
    slope_sink_radius_fraction: f64,
    slope_sink_max_height_fraction: f64,
    asset_row_start: usize,
    asset_row_count: usize,
    reclaim_hp: f64,
    reclaim_time: f64,
    reclaim_energy: f64,
    reclaim_metal: f64,
}

fn vegetation_read_kind_rules(rows: &[f64], index: usize) -> VegetationKindRules {
    let base = index * VEGETATION_KIND_ROW_STRIDE;
    VegetationKindRules {
        target_count: rows[base].max(0.0) as usize,
        uses_waterline_band: rows[base + 1] == VEGETATION_MEDIUM_WATERLINE,
        water_buffer: rows[base + 2],
        waterline_range_fraction: rows[base + 3],
        min_slope: rows[base + 4],
        max_slope: rows[base + 5],
        max_terrain_height: rows[base + 6],
        height_scale_min: rows[base + 7],
        height_scale_max: rows[base + 8],
        radius_scale_min: rows[base + 9],
        radius_scale_max: rows[base + 10],
        slope_sink_radius_fraction: rows[base + 11],
        slope_sink_max_height_fraction: rows[base + 12],
        asset_row_start: rows[base + 13].max(0.0) as usize,
        asset_row_count: rows[base + 14].max(0.0) as usize,
        reclaim_hp: rows[base + 15],
        reclaim_time: rows[base + 16],
        reclaim_energy: rows[base + 17],
        reclaim_metal: rows[base + 18],
    }
}

/// A waterline fraction travels toward a different terrain reference on
/// each side: the canonical main flat above and the seabed below. At 0.5,
/// the resulting shoreline slice reaches exactly halfway to both.
fn vegetation_waterline_elevation_band(range_fraction: f64) -> (f64, f64) {
    let fraction = range_fraction.clamp(0.0, 1.0);
    let below_range = (TERRAIN_WATER_LEVEL - TERRAIN_TILE_FLOOR_Y).max(0.0) * fraction;
    let above_range = (VEGETATION_MAIN_TERRAIN_FLAT_Y - TERRAIN_WATER_LEVEL).max(0.0) * fraction;
    (
        TERRAIN_WATER_LEVEL - below_range,
        TERRAIN_WATER_LEVEL + above_range,
    )
}

fn vegetation_bed_in_waterline_band(bed: f64, range_fraction: f64) -> bool {
    if !liquid_surface_enabled() || !bed.is_finite() {
        return false;
    }
    let (minimum, maximum) = vegetation_waterline_elevation_band(range_fraction);
    bed >= minimum && bed <= maximum
}

/// Uniform horizontal candidate sampling. Terrain/medium/slope tests are
/// rejection filters only; there are no deposit, spawn, quadrant, ring, or
/// other gameplay-region weights.
fn vegetation_random_xy(rng: &mut Mulberry32, map_width: f64, map_height: f64) -> (f64, f64) {
    (rng.next_f64() * map_width, rng.next_f64() * map_height)
}

fn vegetation_kind_seed(
    map_width: f64,
    map_height: f64,
    config_seed: f64,
    kind_index: usize,
) -> u32 {
    vegetation_hash_seed(&[map_width, map_height, config_seed, kind_index as f64])
}

/// Weighted asset pick over one kind's slice of the asset table.
/// Returns a slot index relative to that slice.
fn vegetation_pick_asset_slot(
    asset_rows: &[f64],
    start: usize,
    count: usize,
    roll: f64,
) -> Option<usize> {
    if count == 0 {
        return None;
    }
    let mut total = 0.0;
    for i in 0..count {
        total += asset_rows[(start + i) * VEGETATION_ASSET_ROW_STRIDE].max(0.0);
    }
    if total <= 0.0 {
        return None;
    }
    let mut target = roll * total;
    let mut fallback = None;
    for i in 0..count {
        fallback = Some(i);
        target -= asset_rows[(start + i) * VEGETATION_ASSET_ROW_STRIDE].max(0.0);
        if target <= 0.0 {
            return Some(i);
        }
    }
    fallback
}

/// Drop every prop and clear the removal log. Called at match teardown
/// and before a fresh generation pass.
#[wasm_bindgen]
pub fn vegetation_clear() {
    vegetation_store().clear();
}

/// Lay out every vegetation kind for one map. Deterministic for a given
/// (map size, seed, config, installed terrain)
/// — every peer runs this and gets a bit-identical prop list, so the
/// layout never has to travel on the wire.
///
/// Requires an installed terrain mesh; returns 0 without one.
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn vegetation_generate(
    map_width: f64,
    map_height: f64,
    config_seed: f64,
    area_scale_min: f64,
    area_scale_max: f64,
    default_map_width: f64,
    default_map_height: f64,
    max_attempts_per_target: f64,
    edge_clearance: f64,
    asset_scale_jitter: f64,
    kind_rows: &[f64],
    asset_rows: &[f64],
) -> u32 {
    let store = vegetation_store();
    store.clear();
    if !terrain_grid().installed || map_width <= 0.0 || map_height <= 0.0 {
        return 0;
    }
    store.map_width = map_width;
    store.map_height = map_height;

    let default_area = (default_map_width * default_map_height).max(1.0);
    let area_scale =
        ((map_width * map_height) / default_area).clamp(area_scale_min, area_scale_max);
    let max_attempts_per_target = max_attempts_per_target.max(1.0) as usize;

    let kind_count = kind_rows.len() / VEGETATION_KIND_ROW_STRIDE;
    let mut normal = [0.0f64; 3];
    for kind_index in 0..kind_count {
        let rules = vegetation_read_kind_rules(kind_rows, kind_index);
        let target_count = (rules.target_count as f64 * area_scale).round() as usize;
        if target_count == 0 || rules.asset_row_count == 0 {
            continue;
        }
        // Each kind owns an independent stream. Retuning tree density or
        // eligibility therefore cannot push grass/seaweed into a different
        // pseudo-region by advancing one shared generator.
        let mut rng = Mulberry32::new(vegetation_kind_seed(
            map_width,
            map_height,
            config_seed,
            kind_index,
        ));
        let max_attempts = target_count.saturating_mul(max_attempts_per_target);
        let mut placed = 0usize;
        let mut attempt = 0usize;
        while placed < target_count && attempt < max_attempts {
            attempt += 1;
            // Every attempt consumes the same draws in the same order so
            // an early reject cannot shift the stream for later attempts.
            debug_assert_eq!(VEGETATION_DRAWS_PER_ATTEMPT, 7);
            let asset_roll = rng.next_f64();
            let (x, y) = vegetation_random_xy(&mut rng, map_width, map_height);
            let height_scale = rng.range(rules.height_scale_min, rules.height_scale_max);
            let radius_scale = rng.range(rules.radius_scale_min, rules.radius_scale_max);
            let rotation = rng.next_f64() * std::f64::consts::TAU;
            let jitter = if asset_scale_jitter > 0.0 {
                rng.range(1.0 - asset_scale_jitter, 1.0 + asset_scale_jitter)
                    .max(0.001)
            } else {
                let _ = rng.next_f64();
                1.0
            };

            let Some(slot) = vegetation_pick_asset_slot(
                asset_rows,
                rules.asset_row_start,
                rules.asset_row_count,
                asset_roll,
            ) else {
                continue;
            };
            let asset_base = (rules.asset_row_start + slot) * VEGETATION_ASSET_ROW_STRIDE;
            let asset_scale = asset_rows[asset_base + 3];
            if !(asset_scale > 0.0) {
                continue;
            }
            let scale = asset_scale * jitter;
            let height = asset_rows[asset_base + 1] * height_scale * scale;
            let radius = asset_rows[asset_base + 2] * radius_scale * scale;
            if !(height > 0.0) || !(radius > 0.0) {
                continue;
            }

            let edge = edge_clearance.max(radius);
            if x < edge || y < edge || x > map_width - edge || y > map_height - edge {
                continue;
            }

            let bed = vegetation_bed_height(x, y);
            if !bed.is_finite() {
                continue;
            }
            if rules.uses_waterline_band {
                if !vegetation_bed_in_waterline_band(bed, rules.waterline_range_fraction) {
                    continue;
                }
            } else {
                if bed < liquid_surface_level() || bed > rules.max_terrain_height {
                    continue;
                }
                if !vegetation_far_from_water(x, y, rules.water_buffer) {
                    continue;
                }
            }

            if !vegetation_bed_normal(x, y, &mut normal) {
                continue;
            }
            let slope = vegetation_slope_from_normal_up(normal[2]);
            if !vegetation_slope_in_band(slope, rules.min_slope, rules.max_slope) {
                continue;
            }

            let sink = vegetation_slope_sink(
                normal[0],
                normal[1],
                normal[2],
                radius,
                height,
                rules.slope_sink_radius_fraction,
                rules.slope_sink_max_height_fraction,
            );
            store.props.push(VegetationProp {
                kind: kind_index as u32,
                asset_slot: slot as u32,
                x,
                y,
                z: bed - sink,
                rotation,
                height,
                radius,
                hp: rules.reclaim_hp,
                max_hp: rules.reclaim_hp,
                energy_left: rules.reclaim_energy,
                metal_left: rules.reclaim_metal,
                energy_total: rules.reclaim_energy,
                metal_total: rules.reclaim_metal,
                reclaim_time: rules.reclaim_time,
                alive: true,
            });
            placed += 1;
        }
    }

    store.rebuild_grid();
    store.props.len() as u32
}

#[wasm_bindgen]
pub fn vegetation_count() -> u32 {
    vegetation_store().props.len() as u32
}

/// Read every generated prop's immutable layout into packed rows
/// (VEGETATION_PROP_OUTPUT_STRIDE each). Both the TS mirror and the
/// renderer build from this one call.
#[wasm_bindgen]
pub fn vegetation_read_props(out: &mut [f64]) -> u32 {
    let store = vegetation_store();
    let count = store.props.len();
    if out.len() < count * VEGETATION_PROP_OUTPUT_STRIDE {
        return 0;
    }
    for (index, prop) in store.props.iter().enumerate() {
        let base = index * VEGETATION_PROP_OUTPUT_STRIDE;
        out[base] = f64::from(prop.kind);
        out[base + 1] = f64::from(prop.asset_slot);
        out[base + 2] = prop.x;
        out[base + 3] = prop.y;
        out[base + 4] = prop.z;
        out[base + 5] = prop.rotation;
        out[base + 6] = prop.height;
        out[base + 7] = prop.radius;
        out[base + 8] = prop.max_hp;
        out[base + 9] = prop.energy_total;
    }
    count as u32
}

/// Live reclaim state for one prop. Returns 0 for an unknown index.
#[wasm_bindgen]
pub fn vegetation_prop_state(index: u32, out: &mut [f64]) -> u32 {
    let store = vegetation_store();
    let Some(prop) = store.props.get(index as usize) else {
        return 0;
    };
    if out.len() < VEGETATION_PROP_STATE_STRIDE {
        return 0;
    }
    out[0] = if prop.alive { 1.0 } else { 0.0 };
    out[1] = prop.hp;
    out[2] = prop.max_hp;
    out[3] = prop.energy_left;
    out[4] = prop.metal_left;
    out[5] = if prop.max_hp > 0.0 {
        prop.hp / prop.max_hp
    } else {
        0.0
    };
    1
}

/// Live prop indices whose center falls inside (x, y, radius), sorted
/// ascending so area commands fan out in a stable order on every peer.
/// `kind_mask` is a bitmask over kind ordinals; 0 accepts every kind.
#[wasm_bindgen]
pub fn vegetation_query_circle(
    x: f64,
    y: f64,
    radius: f64,
    kind_mask: u32,
    out: &mut [u32],
) -> u32 {
    let store: &VegetationStore = vegetation_store();
    if radius <= 0.0 || out.is_empty() {
        return 0;
    }
    let radius_sq = radius * radius;
    let mut written = 0usize;
    let capacity = out.len();
    store.for_each_in_circle(x, y, radius, |index| {
        if written >= capacity {
            return;
        }
        let prop = &store.props[index as usize];
        if !prop.alive {
            return;
        }
        if kind_mask != 0 && (kind_mask & (1u32 << prop.kind)) == 0 {
            return;
        }
        let dx = prop.x - x;
        let dy = prop.y - y;
        if dx * dx + dy * dy > radius_sq {
            return;
        }
        out[written] = index;
        written += 1;
    });
    out[..written].sort_unstable();
    written as u32
}

/// Nearest live prop hit by a world-space ray, tested against the
/// prop's upright cylinder selection volume — the same volume model
/// `raycastEntity` uses for units and buildings. Writes
/// [index, distance] and returns 1 on a hit, 0 otherwise.
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn vegetation_raycast(
    origin_x: f64,
    origin_y: f64,
    origin_z: f64,
    dir_x: f64,
    dir_y: f64,
    dir_z: f64,
    max_distance: f64,
    kind_mask: u32,
    out: &mut [f64],
) -> u32 {
    let store: &VegetationStore = vegetation_store();
    if out.len() < 2 || store.props.is_empty() || max_distance <= 0.0 {
        return 0;
    }
    let dir_len = (dir_x * dir_x + dir_y * dir_y + dir_z * dir_z).sqrt();
    if !(dir_len > 0.0) {
        return 0;
    }
    let dx = dir_x / dir_len;
    let dy = dir_y / dir_len;
    let dz = dir_z / dir_len;

    // March the ray's horizontal footprint through the bucket grid by
    // sampling its bounding disc: the ray is short (a screen pick) and
    // this keeps one code path shared with the circle query.
    let end_x = origin_x + dx * max_distance;
    let end_y = origin_y + dy * max_distance;
    let mid_x = (origin_x + end_x) * 0.5;
    let mid_y = (origin_y + end_y) * 0.5;
    let span = ((end_x - origin_x).powi(2) + (end_y - origin_y).powi(2)).sqrt() * 0.5;

    let mut best_index = u32::MAX;
    let mut best_t = f64::INFINITY;
    store.for_each_in_circle(mid_x, mid_y, span + store.max_radius, |index| {
        let prop = &store.props[index as usize];
        if !prop.alive {
            return;
        }
        if kind_mask != 0 && (kind_mask & (1u32 << prop.kind)) == 0 {
            return;
        }
        if let Some(t) =
            vegetation_ray_cylinder_t(origin_x, origin_y, origin_z, dx, dy, dz, max_distance, prop)
        {
            if t < best_t {
                best_t = t;
                best_index = index;
            }
        }
    });
    if best_index == u32::MAX {
        return 0;
    }
    out[0] = f64::from(best_index);
    out[1] = best_t;
    1
}

/// Ray vs. upright capped cylinder (radius, base z, height). Returns
/// the nearest positive hit distance along a unit-length direction.
#[allow(clippy::too_many_arguments)]
fn vegetation_ray_cylinder_t(
    ox: f64,
    oy: f64,
    oz: f64,
    dx: f64,
    dy: f64,
    dz: f64,
    max_distance: f64,
    prop: &VegetationProp,
) -> Option<f64> {
    let top = prop.z + prop.height;
    let mut t_enter = 0.0f64;
    let mut t_exit = max_distance;

    // Slab test against the cylinder's z caps.
    if dz.abs() < 1e-9 {
        if oz < prop.z || oz > top {
            return None;
        }
    } else {
        let t0 = (prop.z - oz) / dz;
        let t1 = (top - oz) / dz;
        let (lo, hi) = if t0 <= t1 { (t0, t1) } else { (t1, t0) };
        t_enter = t_enter.max(lo);
        t_exit = t_exit.min(hi);
        if t_enter > t_exit {
            return None;
        }
    }

    // Infinite-cylinder test in the horizontal plane.
    let px = ox - prop.x;
    let py = oy - prop.y;
    let a = dx * dx + dy * dy;
    let b = 2.0 * (px * dx + py * dy);
    let c = px * px + py * py - prop.radius * prop.radius;
    if a < 1e-12 {
        if c > 0.0 {
            return None;
        }
    } else {
        let disc = b * b - 4.0 * a * c;
        if disc < 0.0 {
            return None;
        }
        let sqrt_disc = disc.sqrt();
        let t0 = (-b - sqrt_disc) / (2.0 * a);
        let t1 = (-b + sqrt_disc) / (2.0 * a);
        t_enter = t_enter.max(t0.min(t1));
        t_exit = t_exit.min(t0.max(t1));
        if t_enter > t_exit {
            return None;
        }
    }

    if t_exit < 0.0 || t_enter > max_distance {
        return None;
    }
    Some(t_enter.max(0.0))
}

/// BAR gradual reclaim (`modrules.lua` reclaimMethod 0). `build_power`
/// is the builder's construction rate; the prop's HP work pool drains
/// at `maxHp * build_power / reclaimTime` per second and the payout is
/// strictly proportional to the HP removed, so consuming a prop takes
/// `reclaimTime / build_power` seconds and yields the full authored
/// energy. Several builders may work the same prop (BAR multiReclaim);
/// each call drains its own share.
///
/// Writes VEGETATION_RECLAIM_TICK_STRIDE values and returns 1 when the
/// prop was live and workable, 0 otherwise.
#[wasm_bindgen]
pub fn vegetation_apply_reclaim_tick(
    index: u32,
    build_power: f64,
    dt_sec: f64,
    out: &mut [f64],
) -> u32 {
    if out.len() < VEGETATION_RECLAIM_TICK_STRIDE {
        return 0;
    }
    let store = vegetation_store();
    let (energy_gained, metal_gained, hp_removed, reclaim_fraction, completed) = {
        let Some(prop) = store.props.get_mut(index as usize) else {
            return 0;
        };
        if !prop.alive || prop.hp <= 0.0 || prop.max_hp <= 0.0 {
            return 0;
        }
        if !(build_power > 0.0) || !(dt_sec > 0.0) || !(prop.reclaim_time > 0.0) {
            return 0;
        }

        let requested = prop.max_hp * (build_power / prop.reclaim_time) * dt_sec;
        let hp_removed = requested.min(prop.hp);
        if hp_removed <= 0.0 {
            return 0;
        }
        let fraction = hp_removed / prop.max_hp;
        let energy_gained = (prop.energy_total * fraction)
            .min(prop.energy_left)
            .max(0.0);
        let metal_gained = (prop.metal_total * fraction).min(prop.metal_left).max(0.0);

        prop.hp -= hp_removed;
        prop.energy_left -= energy_gained;
        prop.metal_left -= metal_gained;

        let completed = prop.hp <= 1e-9;
        if completed {
            prop.hp = 0.0;
            prop.energy_left = 0.0;
            prop.metal_left = 0.0;
            prop.alive = false;
        }
        (
            energy_gained,
            metal_gained,
            hp_removed,
            prop.hp / prop.max_hp,
            completed,
        )
    };
    if completed {
        store.removed.push(index);
    }

    out[0] = energy_gained;
    out[1] = metal_gained;
    out[2] = hp_removed;
    out[3] = reclaim_fraction;
    out[4] = if completed { 1.0 } else { 0.0 };
    1
}

/// Total entries in the append-only removal log. Presentation keeps a
/// cursor into it rather than diffing the prop list every frame.
#[wasm_bindgen]
pub fn vegetation_removed_count() -> u32 {
    vegetation_store().removed.len() as u32
}

/// Copy removal-log entries from `from` onward. Returns how many were
/// written (bounded by `out`).
#[wasm_bindgen]
pub fn vegetation_read_removed(from: u32, out: &mut [u32]) -> u32 {
    let store = vegetation_store();
    let start = (from as usize).min(store.removed.len());
    let count = (store.removed.len() - start).min(out.len());
    out[..count].copy_from_slice(&store.removed[start..start + count]);
    count as u32
}

/// Order-independent hash of live vegetation state for the canonical
/// state hash / desync report. Props are a resource now, so a peer
/// whose forest diverged must show up as a mismatch.
#[wasm_bindgen]
pub fn vegetation_state_hash() -> u32 {
    let store = vegetation_store();
    let mut h: u32 = 2166136261;
    h = (h ^ (store.props.len() as u32)).wrapping_mul(16777619);
    for (index, prop) in store.props.iter().enumerate() {
        if !prop.alive {
            continue;
        }
        h = (h ^ (index as u32)).wrapping_mul(16777619);
        // Quantize so a benign last-bit difference in a float that no
        // gameplay decision reads cannot spuriously desync a match.
        h = (h ^ ((prop.hp * 1024.0).round() as i64 as u32)).wrapping_mul(16777619);
        h = (h ^ ((prop.energy_left * 1024.0).round() as i64 as u32)).wrapping_mul(16777619);
    }
    h
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn waterline_band_uses_midpoints_to_main_flat_and_seabed() {
        let (underwater_cutoff, above_water_cutoff) = vegetation_waterline_elevation_band(0.5);
        assert!((underwater_cutoff - (-360.0)).abs() < 1.0e-9);
        assert!((above_water_cutoff - (-60.0)).abs() < 1.0e-9);
        assert!(vegetation_bed_in_waterline_band(underwater_cutoff, 0.5));
        assert!(vegetation_bed_in_waterline_band(TERRAIN_WATER_LEVEL, 0.5));
        assert!(vegetation_bed_in_waterline_band(above_water_cutoff, 0.5));
        assert!(!vegetation_bed_in_waterline_band(
            underwater_cutoff - 0.001,
            0.5
        ));
        assert!(!vegetation_bed_in_waterline_band(
            above_water_cutoff + 0.001,
            0.5
        ));
    }

    #[test]
    fn authored_land_vegetation_slope_band_is_inclusive() {
        assert!(!vegetation_slope_in_band(0.099_999, 0.1, 0.3));
        assert!(vegetation_slope_in_band(0.1, 0.1, 0.3));
        assert!(vegetation_slope_in_band(0.2, 0.1, 0.3));
        assert!(vegetation_slope_in_band(0.3, 0.1, 0.3));
        assert!(!vegetation_slope_in_band(0.300_001, 0.1, 0.3));
    }

    #[test]
    fn horizontal_candidates_are_uniform_across_the_map() {
        const SIDE_BINS: usize = 4;
        const SAMPLES: usize = 80_000;
        let mut bins = [0usize; SIDE_BINS * SIDE_BINS];
        let mut rng = Mulberry32::new(vegetation_kind_seed(10_600.0, 10_600.0, 2_147_483_647.0, 2));
        for _ in 0..SAMPLES {
            let _asset_roll = rng.next_f64();
            let (x, y) = vegetation_random_xy(&mut rng, 10_600.0, 10_600.0);
            for _ in 0..4 {
                let _ = rng.next_f64();
            }
            let bx = ((x / 10_600.0) * SIDE_BINS as f64).floor() as usize;
            let by = ((y / 10_600.0) * SIDE_BINS as f64).floor() as usize;
            bins[by.min(SIDE_BINS - 1) * SIDE_BINS + bx.min(SIDE_BINS - 1)] += 1;
        }
        let expected = SAMPLES / bins.len();
        let tolerance = expected * 6 / 100;
        for count in bins {
            assert!(
                count.abs_diff(expected) <= tolerance,
                "uniform candidate bin count {count} drifted beyond {expected} +/- {tolerance}",
            );
        }
    }
}

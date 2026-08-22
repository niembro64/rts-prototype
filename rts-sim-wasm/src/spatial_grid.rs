// spatial_grid — extracted from lib.rs (pure code motion).

#[allow(unused_imports)]
use crate::*;
#[allow(unused_imports)]
use wasm_bindgen::prelude::*;

// ─────────────────────────────────────────────────────────────────
//  Phase 7 — SpatialGrid: 3D voxel hash in WASM linear memory
//
//  Big-bang port of src/game/sim/SpatialGrid.ts (1438 lines, query
//  families and mutation methods). The JS-side
//  SpatialGrid.ts becomes a thin wrapper that delegates here while
//  preserving the existing public surface so callers are unchanged.
//
//  Slot strategy: the Rust grid uses generic u32 slot ids. JS owns
//  the Map<EntityId, slot> side-table and resolves slot ids back to
//  Entity refs on query return. Units, buildings, and projectiles
//  all share the same slot space; the kind tag in `slot_kind`
//  disambiguates.
//
//  Cell key encoding: same 48-bit packed (cx, cy, cz) scheme as
//  pack_contact_cell_key — JS-side packCell produces an identical
//  bit pattern, so a future debugger can cross-reference cell ids.
//
// ─────────────────────────────────────────────────────────────────

pub(crate) const SPATIAL_KIND_UNSET: u8 = 0;
pub(crate) const SPATIAL_KIND_UNIT: u8 = 1;
pub(crate) const SPATIAL_KIND_BUILDING: u8 = 2;
pub(crate) const SPATIAL_KIND_PROJECTILE: u8 = 3;

// Matches MAX_UNIT_SHOT_RADIUS in SpatialGrid.ts — used to pad the
// cell sweep for enemy-entities queries so units near the radius +
// shot-collider boundary aren't culled by cell-level rejection.
pub(crate) const SPATIAL_MAX_UNIT_SHOT_RADIUS: f64 = 45.0;
pub(crate) const SPATIAL_MAX_CIRCLE2D_QUERY_CELLS: i64 = 4096;
pub(crate) const SPATIAL_MAX_LINE_QUERY_CELLS: i64 = 4096;
pub(crate) const SPATIAL_MAX_LINE_QUERY_OCCUPIED_FALLBACK_CELLS: usize = 8192;

// Z-band fallback defaults for ground-plane queries. Terrain height is
// runtime-configurable on the TS side, so combat observation uses stamped
// live-entity bounds instead of relying on these values.
pub(crate) const SPATIAL_TILE_FLOOR_Y: f64 = -1200.0;
pub(crate) const SPATIAL_TERRAIN_MAX_RENDER_Y: f64 = 1600.0; // TERRAIN_SHAPE_MAGNITUDE(800) * 2

#[derive(Default)]
pub(crate) struct SpatialCellBucket {
    pub(crate) units: Vec<u32>,
    pub(crate) buildings: Vec<u32>,
    pub(crate) projectiles: Vec<u32>,
}

impl SpatialCellBucket {
    pub(crate) fn is_empty(&self) -> bool {
        self.units.is_empty() && self.buildings.is_empty() && self.projectiles.is_empty()
    }
    pub(crate) fn clear(&mut self) {
        self.units.clear();
        self.buildings.clear();
        self.projectiles.clear();
    }
}

pub(crate) struct SpatialGridState {
    pub(crate) cell_size: f64,
    pub(crate) half_cell_size: f64,

    pub(crate) cells: HashMap<u64, SpatialCellBucket>,
    pub(crate) cell_pool: Vec<SpatialCellBucket>,

    // Per-slot SoA. slot_kind == SPATIAL_KIND_UNSET means free.
    pub(crate) slot_kind: Vec<u8>,
    pub(crate) slot_entity_id: Vec<i32>,
    pub(crate) slot_owner_player: Vec<u8>,
    pub(crate) slot_x: Vec<f64>,
    pub(crate) slot_y: Vec<f64>,
    pub(crate) slot_z: Vec<f64>,
    pub(crate) slot_radius_collision: Vec<f64>,
    pub(crate) slot_radius_hitbox: Vec<f64>,
    pub(crate) slot_aabb_hx: Vec<f64>,
    pub(crate) slot_aabb_hy: Vec<f64>,
    pub(crate) slot_aabb_hz: Vec<f64>,
    pub(crate) slot_hp_alive: Vec<u8>,
    pub(crate) slot_entity_active: Vec<u8>,
    pub(crate) slot_proj_is_projectile_type: Vec<u8>,
    // Current 3D cube key for units/projectiles. Unused for buildings
    // (their list of cubes is in `building_cells`).
    pub(crate) slot_cube_key: Vec<u64>,

    // Multi-cell building tracking. Empty for non-buildings.
    pub(crate) building_cells: Vec<Vec<u64>>,

    // Free list
    pub(crate) free_slots: Vec<u32>,
    pub(crate) next_slot: u32,

    // Per-query scratch
    pub(crate) nearby_cells: Vec<u64>,
    pub(crate) dedup: HashSet<u32>,
    pub(crate) scratch_u32: Vec<u32>,
}

impl SpatialGridState {
    pub(crate) fn empty() -> Self {
        Self {
            cell_size: 0.0,
            half_cell_size: 0.0,
            cells: HashMap::default(),
            cell_pool: Vec::new(),
            slot_kind: Vec::new(),
            slot_entity_id: Vec::new(),
            slot_owner_player: Vec::new(),
            slot_x: Vec::new(),
            slot_y: Vec::new(),
            slot_z: Vec::new(),
            slot_radius_collision: Vec::new(),
            slot_radius_hitbox: Vec::new(),
            slot_aabb_hx: Vec::new(),
            slot_aabb_hy: Vec::new(),
            slot_aabb_hz: Vec::new(),
            slot_hp_alive: Vec::new(),
            slot_entity_active: Vec::new(),
            slot_proj_is_projectile_type: Vec::new(),
            slot_cube_key: Vec::new(),
            building_cells: Vec::new(),
            free_slots: Vec::new(),
            next_slot: 0,
            nearby_cells: Vec::new(),
            dedup: HashSet::default(),
            scratch_u32: Vec::new(),
        }
    }
}

pub(crate) static SPATIAL_GRID: WasmLazy<SpatialGridState> = WasmLazy::new();

#[inline]
pub(crate) fn spatial_grid() -> &'static mut SpatialGridState {
    // Lazy-initializes on first access so callers don't have to gate
    // on spatial_init having run yet (matches the BodyPool pattern
    // where pool_init is called from initSimWasm's bootstrap chain).
    SPATIAL_GRID.get_or_init(SpatialGridState::empty)
}

#[inline]
pub(crate) fn spatial_cell_xy(v: f64, cs: f64) -> i32 {
    (v / cs).floor() as i32
}

#[inline]
pub(crate) fn spatial_cell_z(v: f64, cs: f64, half: f64) -> i32 {
    ((v + half) / cs).floor() as i32
}

#[inline]
pub(crate) fn spatial_get_cell_key(state: &SpatialGridState, x: f64, y: f64, z: f64) -> u64 {
    let cx = spatial_cell_xy(x, state.cell_size);
    let cy = spatial_cell_xy(y, state.cell_size);
    let cz = spatial_cell_z(z, state.cell_size, state.half_cell_size);
    pack_contact_cell_key(cx, cy, cz)
}

pub(crate) fn spatial_get_or_create_cell<'a>(
    state: &'a mut SpatialGridState,
    key: u64,
) -> &'a mut SpatialCellBucket {
    // Single probe: contains_key + insert + get_mut was three hash
    // lookups on a path that runs for every cross-cell move of every
    // unit and projectile, every tick. Field destructuring lets the
    // pool recycle inside the entry closure without a double borrow.
    let SpatialGridState {
        cells, cell_pool, ..
    } = state;
    cells
        .entry(key)
        .or_insert_with(|| cell_pool.pop().unwrap_or_default())
}

pub(crate) fn spatial_prune_cell_if_empty(state: &mut SpatialGridState, key: u64) {
    // Same single-probe treatment as spatial_get_or_create_cell.
    let SpatialGridState {
        cells, cell_pool, ..
    } = state;
    if let std::collections::hash_map::Entry::Occupied(entry) = cells.entry(key) {
        if entry.get().is_empty() {
            let mut bucket = entry.remove();
            bucket.clear();
            cell_pool.push(bucket);
        }
    }
}

pub(crate) fn spatial_remove_unit_from_cell(
    state: &mut SpatialGridState,
    cell_key: u64,
    slot: u32,
) {
    if let Some(bucket) = state.cells.get_mut(&cell_key) {
        if let Some(idx) = bucket.units.iter().position(|&s| s == slot) {
            let last = bucket.units.len() - 1;
            if idx != last {
                bucket.units.swap(idx, last);
            }
            bucket.units.pop();
        }
    }
    spatial_prune_cell_if_empty(state, cell_key);
}

pub(crate) fn spatial_remove_projectile_from_cell(
    state: &mut SpatialGridState,
    cell_key: u64,
    slot: u32,
) {
    if let Some(bucket) = state.cells.get_mut(&cell_key) {
        if let Some(idx) = bucket.projectiles.iter().position(|&s| s == slot) {
            let last = bucket.projectiles.len() - 1;
            if idx != last {
                bucket.projectiles.swap(idx, last);
            }
            bucket.projectiles.pop();
        }
    }
    spatial_prune_cell_if_empty(state, cell_key);
}

pub(crate) fn spatial_remove_building_from_cell(
    state: &mut SpatialGridState,
    cell_key: u64,
    slot: u32,
) {
    if let Some(bucket) = state.cells.get_mut(&cell_key) {
        if let Some(idx) = bucket.buildings.iter().position(|&s| s == slot) {
            let last = bucket.buildings.len() - 1;
            if idx != last {
                bucket.buildings.swap(idx, last);
            }
            bucket.buildings.pop();
        }
    }
    spatial_prune_cell_if_empty(state, cell_key);
}

#[inline]
pub(crate) fn spatial_dist_sq_to_aabb3(
    bx: f64,
    by: f64,
    bz: f64,
    hx: f64,
    hy: f64,
    hz: f64,
    px: f64,
    py: f64,
    pz: f64,
) -> f64 {
    let min_x = bx - hx;
    let max_x = bx + hx;
    let min_y = by - hy;
    let max_y = by + hy;
    let min_z = bz - hz;
    let max_z = bz + hz;
    let cxp = if px < min_x {
        min_x
    } else if px > max_x {
        max_x
    } else {
        px
    };
    let cyp = if py < min_y {
        min_y
    } else if py > max_y {
        max_y
    } else {
        py
    };
    let czp = if pz < min_z {
        min_z
    } else if pz > max_z {
        max_z
    } else {
        pz
    };
    let dx = cxp - px;
    let dy = cyp - py;
    let dz = czp - pz;
    dx * dx + dy * dy + dz * dz
}

#[inline]
pub(crate) fn spatial_dist_sq_to_aabb2(
    bx: f64,
    by: f64,
    hx: f64,
    hy: f64,
    px: f64,
    py: f64,
) -> f64 {
    let min_x = bx - hx;
    let max_x = bx + hx;
    let min_y = by - hy;
    let max_y = by + hy;
    let cxp = if px < min_x {
        min_x
    } else if px > max_x {
        max_x
    } else {
        px
    };
    let cyp = if py < min_y {
        min_y
    } else if py > max_y {
        max_y
    } else {
        py
    };
    let dx = cxp - px;
    let dy = cyp - py;
    dx * dx + dy * dy
}

// ===================== Lifecycle / slot allocation =====================

#[wasm_bindgen]
pub fn spatial_init(cell_size: f64, initial_slot_capacity: u32) {
    let state = spatial_grid();
    state.cell_size = cell_size;
    state.half_cell_size = cell_size * 0.5;
    state.cells.clear();
    state.cell_pool.clear();
    state.free_slots.clear();
    state.next_slot = 0;
    state.nearby_cells.clear();
    state.dedup.clear();
    state.scratch_u32.clear();
    // Pre-size per-slot arrays.
    let cap = initial_slot_capacity as usize;
    state.slot_kind.clear();
    state.slot_kind.resize(cap, SPATIAL_KIND_UNSET);
    state.slot_entity_id.clear();
    state.slot_entity_id.resize(cap, -1);
    state.slot_owner_player.clear();
    state.slot_owner_player.resize(cap, 0);
    state.slot_x.clear();
    state.slot_x.resize(cap, 0.0);
    state.slot_y.clear();
    state.slot_y.resize(cap, 0.0);
    state.slot_z.clear();
    state.slot_z.resize(cap, 0.0);
    state.slot_radius_collision.clear();
    state.slot_radius_collision.resize(cap, 0.0);
    state.slot_radius_hitbox.clear();
    state.slot_radius_hitbox.resize(cap, 0.0);
    state.slot_aabb_hx.clear();
    state.slot_aabb_hx.resize(cap, 0.0);
    state.slot_aabb_hy.clear();
    state.slot_aabb_hy.resize(cap, 0.0);
    state.slot_aabb_hz.clear();
    state.slot_aabb_hz.resize(cap, 0.0);
    state.slot_hp_alive.clear();
    state.slot_hp_alive.resize(cap, 0);
    state.slot_entity_active.clear();
    state.slot_entity_active.resize(cap, 0);
    state.slot_proj_is_projectile_type.clear();
    state.slot_proj_is_projectile_type.resize(cap, 0);
    state.slot_cube_key.clear();
    state.slot_cube_key.resize(cap, 0);
    state.building_cells.clear();
    state.building_cells.resize_with(cap, Vec::new);
}

#[wasm_bindgen]
pub fn spatial_clear() {
    let state = spatial_grid();
    state.cells.clear();
    state.cell_pool.clear();
    // Reset slot ownership but keep allocations.
    for k in state.slot_kind.iter_mut() {
        *k = SPATIAL_KIND_UNSET;
    }
    for id in state.slot_entity_id.iter_mut() {
        *id = -1;
    }
    for c in state.building_cells.iter_mut() {
        c.clear();
    }
    for cube in state.slot_cube_key.iter_mut() {
        *cube = 0;
    }
    state.free_slots.clear();
    state.next_slot = 0;
}

pub(crate) fn spatial_ensure_slot_capacity(state: &mut SpatialGridState, slot: u32) {
    let needed = (slot as usize) + 1;
    if state.slot_kind.len() >= needed {
        return;
    }
    state.slot_kind.resize(needed, SPATIAL_KIND_UNSET);
    state.slot_entity_id.resize(needed, -1);
    state.slot_owner_player.resize(needed, 0);
    state.slot_x.resize(needed, 0.0);
    state.slot_y.resize(needed, 0.0);
    state.slot_z.resize(needed, 0.0);
    state.slot_radius_collision.resize(needed, 0.0);
    state.slot_radius_hitbox.resize(needed, 0.0);
    state.slot_aabb_hx.resize(needed, 0.0);
    state.slot_aabb_hy.resize(needed, 0.0);
    state.slot_aabb_hz.resize(needed, 0.0);
    state.slot_hp_alive.resize(needed, 0);
    state.slot_entity_active.resize(needed, 0);
    state.slot_proj_is_projectile_type.resize(needed, 0);
    state.slot_cube_key.resize(needed, 0);
    state.building_cells.resize_with(needed, Vec::new);
}

#[wasm_bindgen]
pub fn spatial_alloc_slot() -> u32 {
    let state = spatial_grid();
    if let Some(slot) = state.free_slots.pop() {
        spatial_ensure_slot_capacity(state, slot);
        state.slot_kind[slot as usize] = SPATIAL_KIND_UNSET;
        return slot;
    }
    let slot = state.next_slot;
    state.next_slot = state.next_slot.wrapping_add(1);
    spatial_ensure_slot_capacity(state, slot);
    slot
}

#[wasm_bindgen]
pub fn spatial_set_entity_id(slot: u32, entity_id: i32) {
    let state = spatial_grid();
    let s = slot as usize;
    spatial_ensure_slot_capacity(state, slot);
    state.slot_entity_id[s] = entity_id;
}

#[wasm_bindgen]
pub fn spatial_free_slot(slot: u32) {
    spatial_unset_slot(slot);
    spatial_grid().free_slots.push(slot);
}

// ===================== Mutations =====================

/// Insert or update a unit at slot. owner_player == 0 means "no owner"
/// (matches the JS `entity.ownership?.playerId ?? 0`). hp_alive is the
/// HP > 0 flag — pass 0 to remove the slot.
#[wasm_bindgen]
pub fn spatial_set_unit(
    slot: u32,
    x: f64,
    y: f64,
    z: f64,
    radius_collision: f64,
    radius_hitbox: f64,
    owner_player: u8,
    hp_alive: u8,
) {
    let state = spatial_grid();
    let s = slot as usize;
    spatial_ensure_slot_capacity(state, slot);
    if hp_alive == 0 {
        spatial_unset_slot(slot);
        return;
    }
    let prev_kind = state.slot_kind[s];
    let new_key = spatial_get_cell_key(state, x, y, z);
    state.slot_kind[s] = SPATIAL_KIND_UNIT;
    state.slot_owner_player[s] = owner_player;
    state.slot_hp_alive[s] = hp_alive;
    state.slot_x[s] = x;
    state.slot_y[s] = y;
    state.slot_z[s] = z;
    state.slot_radius_collision[s] = radius_collision;
    state.slot_radius_hitbox[s] = radius_hitbox;
    if prev_kind == SPATIAL_KIND_UNIT {
        let old_key = state.slot_cube_key[s];
        if old_key != new_key {
            spatial_remove_unit_from_cell(state, old_key, slot);
            spatial_get_or_create_cell(state, new_key).units.push(slot);
            state.slot_cube_key[s] = new_key;
        }
    } else {
        spatial_get_or_create_cell(state, new_key).units.push(slot);
        state.slot_cube_key[s] = new_key;
    }
}

#[inline]
pub(crate) fn spatial_set_projectile_inner(
    state: &mut SpatialGridState,
    slot: u32,
    x: f64,
    y: f64,
    z: f64,
    owner_player: u8,
    is_projectile_type: u8,
    radius_collision: f64,
    radius_hitbox: f64,
) {
    let s = slot as usize;
    spatial_ensure_slot_capacity(state, slot);
    let prev_kind = state.slot_kind[s];
    let new_key = spatial_get_cell_key(state, x, y, z);
    state.slot_kind[s] = SPATIAL_KIND_PROJECTILE;
    state.slot_owner_player[s] = owner_player;
    state.slot_x[s] = x;
    state.slot_y[s] = y;
    state.slot_z[s] = z;
    state.slot_proj_is_projectile_type[s] = is_projectile_type;
    state.slot_radius_collision[s] = radius_collision;
    state.slot_radius_hitbox[s] = radius_hitbox;
    if prev_kind == SPATIAL_KIND_PROJECTILE {
        let old_key = state.slot_cube_key[s];
        if old_key != new_key {
            spatial_remove_projectile_from_cell(state, old_key, slot);
            spatial_get_or_create_cell(state, new_key)
                .projectiles
                .push(slot);
            state.slot_cube_key[s] = new_key;
        }
    } else {
        spatial_get_or_create_cell(state, new_key)
            .projectiles
            .push(slot);
        state.slot_cube_key[s] = new_key;
    }
}

#[wasm_bindgen]
pub fn spatial_set_projectile(
    slot: u32,
    x: f64,
    y: f64,
    z: f64,
    owner_player: u8,
    is_projectile_type: u8,
    radius_collision: f64,
    radius_hitbox: f64,
) {
    let state = spatial_grid();
    spatial_set_projectile_inner(
        state,
        slot,
        x,
        y,
        z,
        owner_player,
        is_projectile_type,
        radius_collision,
        radius_hitbox,
    );
}

#[wasm_bindgen]
pub fn spatial_set_projectiles_batch(
    count: u32,
    slots: &[u32],
    xs: &[f64],
    ys: &[f64],
    zs: &[f64],
    owner_players: &[u8],
    projectile_type_flags: &[u8],
    radius_collision: &[f64],
    radius_hitbox: &[f64],
) -> u32 {
    let n = count as usize;
    if slots.len() < n
        || xs.len() < n
        || ys.len() < n
        || zs.len() < n
        || owner_players.len() < n
        || projectile_type_flags.len() < n
        || radius_collision.len() < n
        || radius_hitbox.len() < n
    {
        return 0;
    }

    let state = spatial_grid();
    for i in 0..n {
        spatial_set_projectile_inner(
            state,
            slots[i],
            xs[i],
            ys[i],
            zs[i],
            owner_players[i],
            projectile_type_flags[i],
            radius_collision[i],
            radius_hitbox[i],
        );
    }
    count
}

/// Insert a building (idempotent — second call with the same slot
/// without an unset between is a no-op). Buildings span every cube
/// their (width × height × depth) AABB touches; the spans are
/// recomputed from (x, y, z, hx, hy, hz) on each call.
#[wasm_bindgen]
pub fn spatial_set_building(
    slot: u32,
    x: f64,
    y: f64,
    z: f64,
    hx: f64,
    hy: f64,
    hz: f64,
    owner_player: u8,
    hp_alive: u8,
    entity_active: u8,
) {
    let state = spatial_grid();
    let s = slot as usize;
    spatial_ensure_slot_capacity(state, slot);
    // Re-add semantics: remove old building cells if any, then bucket fresh.
    if state.slot_kind[s] == SPATIAL_KIND_BUILDING {
        let old_cells = std::mem::take(&mut state.building_cells[s]);
        for k in &old_cells {
            spatial_remove_building_from_cell(state, *k, slot);
        }
    }
    state.slot_kind[s] = SPATIAL_KIND_BUILDING;
    state.slot_owner_player[s] = owner_player;
    state.slot_hp_alive[s] = hp_alive;
    state.slot_entity_active[s] = entity_active;
    state.slot_x[s] = x;
    state.slot_y[s] = y;
    state.slot_z[s] = z;
    state.slot_aabb_hx[s] = hx;
    state.slot_aabb_hy[s] = hy;
    state.slot_aabb_hz[s] = hz;

    let cs = state.cell_size;
    let hcs = state.half_cell_size;
    let base_z = z - hz;
    let top_z = z + hz;
    let min_cx = ((x - hx) / cs).floor() as i32;
    let max_cx = ((x + hx) / cs).floor() as i32;
    let min_cy = ((y - hy) / cs).floor() as i32;
    let max_cy = ((y + hy) / cs).floor() as i32;
    let min_cz = ((base_z + hcs) / cs).floor() as i32;
    let max_cz = ((top_z + hcs) / cs).floor() as i32;

    let mut keys: Vec<u64> = Vec::new();
    for cx in min_cx..=max_cx {
        for cy in min_cy..=max_cy {
            for cz in min_cz..=max_cz {
                let key = pack_contact_cell_key(cx, cy, cz);
                spatial_get_or_create_cell(state, key).buildings.push(slot);
                keys.push(key);
            }
        }
    }
    state.building_cells[s] = keys;
}

#[wasm_bindgen]
pub fn spatial_unset_slot(slot: u32) {
    let state = spatial_grid();
    let s = slot as usize;
    if s >= state.slot_kind.len() {
        return;
    }
    match state.slot_kind[s] {
        SPATIAL_KIND_UNIT => {
            let key = state.slot_cube_key[s];
            spatial_remove_unit_from_cell(state, key, slot);
        }
        SPATIAL_KIND_PROJECTILE => {
            let key = state.slot_cube_key[s];
            spatial_remove_projectile_from_cell(state, key, slot);
        }
        SPATIAL_KIND_BUILDING => {
            let old_cells = std::mem::take(&mut state.building_cells[s]);
            for k in &old_cells {
                spatial_remove_building_from_cell(state, *k, slot);
            }
        }
        _ => {}
    }
    state.slot_kind[s] = SPATIAL_KIND_UNSET;
    state.slot_entity_id[s] = -1;
    state.slot_hp_alive[s] = 0;
    state.slot_entity_active[s] = 0;
    state.slot_cube_key[s] = 0;
}

// ===================== Cell-sweep helpers =====================

pub(crate) fn spatial_collect_cells_in_radius(
    state: &mut SpatialGridState,
    x: f64,
    y: f64,
    z: f64,
    radius: f64,
) {
    state.nearby_cells.clear();
    let cs = state.cell_size;
    let hcs = state.half_cell_size;
    let min_cx = ((x - radius) / cs).floor() as i32;
    let max_cx = ((x + radius) / cs).floor() as i32;
    let min_cy = ((y - radius) / cs).floor() as i32;
    let max_cy = ((y + radius) / cs).floor() as i32;
    let min_cz = ((z - radius + hcs) / cs).floor() as i32;
    let max_cz = ((z + radius + hcs) / cs).floor() as i32;
    for cx in min_cx..=max_cx {
        for cy in min_cy..=max_cy {
            for cz in min_cz..=max_cz {
                state.nearby_cells.push(pack_contact_cell_key(cx, cy, cz));
            }
        }
    }
}

pub(crate) fn spatial_collect_cells_in_circle2d(
    state: &mut SpatialGridState,
    x: f64,
    y: f64,
    radius: f64,
    z_min: f64,
    z_max: f64,
) {
    state.nearby_cells.clear();
    if !x.is_finite()
        || !y.is_finite()
        || !radius.is_finite()
        || !z_min.is_finite()
        || !z_max.is_finite()
        || radius < 0.0
    {
        return;
    }
    let cs = state.cell_size;
    let hcs = state.half_cell_size;
    let min_x = x - radius;
    let max_x = x + radius;
    let min_y = y - radius;
    let max_y = y + radius;
    let min_z = z_min.min(z_max);
    let max_z = z_min.max(z_max);
    let min_cx = (min_x / cs).floor() as i32;
    let max_cx = (max_x / cs).floor() as i32;
    let min_cy = (min_y / cs).floor() as i32;
    let max_cy = (max_y / cs).floor() as i32;
    let min_cz = ((min_z + hcs) / cs).floor() as i32;
    let max_cz = ((max_z + hcs) / cs).floor() as i32;
    let cells_x = (max_cx - min_cx + 1) as i64;
    let cells_y = (max_cy - min_cy + 1) as i64;
    let cells_z = (max_cz - min_cz + 1) as i64;
    if cells_x <= 0 || cells_y <= 0 || cells_z <= 0 {
        return;
    }
    let cell_count = cells_x * cells_y * cells_z;
    if cell_count > SPATIAL_MAX_CIRCLE2D_QUERY_CELLS && cell_count as usize > state.cells.len() {
        spatial_fill_occupied_cells_in_bounds(state, min_x, max_x, min_y, max_y, min_z, max_z);
        return;
    }
    for cx in min_cx..=max_cx {
        for cy in min_cy..=max_cy {
            for cz in min_cz..=max_cz {
                state.nearby_cells.push(pack_contact_cell_key(cx, cy, cz));
            }
        }
    }
}

pub(crate) fn spatial_collect_cells_along_line(
    state: &mut SpatialGridState,
    x1: f64,
    y1: f64,
    z1: f64,
    x2: f64,
    y2: f64,
    z2: f64,
    line_width: f64,
) -> bool {
    state.nearby_cells.clear();
    if !x1.is_finite()
        || !y1.is_finite()
        || !z1.is_finite()
        || !x2.is_finite()
        || !y2.is_finite()
        || !z2.is_finite()
        || !line_width.is_finite()
    {
        return false;
    }
    let half_w = line_width * 0.5;
    let min_x = x1.min(x2) - half_w;
    let max_x = x1.max(x2) + half_w;
    let min_y = y1.min(y2) - half_w;
    let max_y = y1.max(y2) + half_w;
    let min_z = z1.min(z2) - half_w;
    let max_z = z1.max(z2) + half_w;
    let cs = state.cell_size;
    let hcs = state.half_cell_size;
    let min_cx = (min_x / cs).floor() as i32;
    let max_cx = (max_x / cs).floor() as i32;
    let min_cy = (min_y / cs).floor() as i32;
    let max_cy = (max_y / cs).floor() as i32;
    let min_cz = ((min_z + hcs) / cs).floor() as i32;
    let max_cz = ((max_z + hcs) / cs).floor() as i32;
    let cells_x = (max_cx - min_cx + 1) as i64;
    let cells_y = (max_cy - min_cy + 1) as i64;
    let cells_z = (max_cz - min_cz + 1) as i64;
    if cells_x <= 0 || cells_y <= 0 || cells_z <= 0 {
        return false;
    }
    let cell_count = cells_x * cells_y * cells_z;
    if cell_count > SPATIAL_MAX_LINE_QUERY_CELLS {
        return spatial_fill_occupied_cells_for_line(
            state, min_x, max_x, min_y, max_y, min_z, max_z,
        );
    }
    for cx in min_cx..=max_cx {
        for cy in min_cy..=max_cy {
            for cz in min_cz..=max_cz {
                state.nearby_cells.push(pack_contact_cell_key(cx, cy, cz));
            }
        }
    }
    true
}

pub(crate) fn spatial_fill_occupied_cells_for_line(
    state: &mut SpatialGridState,
    min_x: f64,
    max_x: f64,
    min_y: f64,
    max_y: f64,
    min_z: f64,
    max_z: f64,
) -> bool {
    state.nearby_cells.clear();
    if state.cells.len() > SPATIAL_MAX_LINE_QUERY_OCCUPIED_FALLBACK_CELLS {
        return false;
    }
    spatial_fill_occupied_cells_in_bounds(state, min_x, max_x, min_y, max_y, min_z, max_z);
    true
}

pub(crate) fn spatial_fill_occupied_cells_in_bounds(
    state: &mut SpatialGridState,
    min_x: f64,
    max_x: f64,
    min_y: f64,
    max_y: f64,
    min_z: f64,
    max_z: f64,
) {
    state.nearby_cells.clear();
    let cs = state.cell_size;
    let hcs = state.half_cell_size;
    let cells = &state.cells;
    let nearby_cells = &mut state.nearby_cells;
    for &key in cells.keys() {
        // Unpack cube key — same layout as pack_contact_cell_key.
        let czb = (key & 0xFFFF) as i64;
        let cyb = ((key >> 16) & 0xFFFF) as i64;
        let cxb = ((key >> 32) & 0xFFFF) as i64;
        let cx = (cxb - CONTACT_CELL_BIAS) as f64;
        let cy = (cyb - CONTACT_CELL_BIAS) as f64;
        let cz = (czb - CONTACT_CELL_BIAS) as f64;
        let cell_min_x = cx * cs;
        let cell_max_x = cell_min_x + cs;
        if cell_max_x < min_x || cell_min_x > max_x {
            continue;
        }
        let cell_min_y = cy * cs;
        let cell_max_y = cell_min_y + cs;
        if cell_max_y < min_y || cell_min_y > max_y {
            continue;
        }
        let cell_min_z = cz * cs - hcs;
        let cell_max_z = cell_min_z + cs;
        if cell_max_z < min_z || cell_min_z > max_z {
            continue;
        }
        nearby_cells.push(key);
    }
}

// ===================== Query result helpers =====================

#[inline]
pub(crate) fn spatial_push_unit_if_in_radius(
    state: &SpatialGridState,
    out: &mut Vec<u32>,
    slot: u32,
    x: f64,
    y: f64,
    z: f64,
    radius: f64,
    radius_sq: f64,
    exclude_player: u8,
    require_alive: bool,
    include_shot_radius: bool,
    ground_plane_only: bool,
) {
    let s = slot as usize;
    if state.slot_kind[s] != SPATIAL_KIND_UNIT {
        return;
    }
    let owner = state.slot_owner_player[s];
    if exclude_player != 0 && owner == exclude_player {
        return;
    }
    if require_alive && state.slot_hp_alive[s] == 0 {
        return;
    }

    let mut check_radius_sq = radius_sq;
    if include_shot_radius {
        let shot = state.slot_radius_hitbox[s];
        // JS path: `if (shotRadius === undefined) return;` We treat
        // 0.0 as "no shot radius" since units always set it positively.
        if shot <= 0.0 {
            return;
        }
        let check_radius = radius + shot;
        check_radius_sq = check_radius * check_radius;
    }
    let dx = state.slot_x[s] - x;
    let dy = state.slot_y[s] - y;
    let dist_sq = if ground_plane_only {
        dx * dx + dy * dy
    } else {
        let dz = state.slot_z[s] - z;
        dx * dx + dy * dy + dz * dz
    };
    if dist_sq <= check_radius_sq {
        out.push(slot);
    }
}

#[inline]
pub(crate) fn spatial_push_enemy_projectile_if_in_radius(
    state: &SpatialGridState,
    out: &mut Vec<u32>,
    slot: u32,
    x: f64,
    y: f64,
    z: f64,
    radius_sq: f64,
    exclude_player: u8,
) {
    let s = slot as usize;
    if state.slot_kind[s] != SPATIAL_KIND_PROJECTILE {
        return;
    }
    if state.slot_proj_is_projectile_type[s] == 0 {
        return;
    }
    let owner = state.slot_owner_player[s];
    if owner == exclude_player {
        return;
    }
    let dx = state.slot_x[s] - x;
    let dy = state.slot_y[s] - y;
    let dz = state.slot_z[s] - z;
    if dx * dx + dy * dy + dz * dz <= radius_sq {
        out.push(slot);
    }
}

#[inline]
pub(crate) fn spatial_push_building_if_in_radius(
    state: &SpatialGridState,
    dedup: &mut HashSet<u32>,
    out: &mut Vec<u32>,
    slot: u32,
    x: f64,
    y: f64,
    z: f64,
    radius_sq: f64,
    exclude_player: u8,
    require_alive: bool,
    ground_plane_only: bool,
) {
    if !dedup.insert(slot) {
        return;
    }
    let s = slot as usize;
    if state.slot_kind[s] != SPATIAL_KIND_BUILDING {
        return;
    }
    let owner = state.slot_owner_player[s];
    if exclude_player != 0 && owner == exclude_player {
        return;
    }
    if require_alive && state.slot_hp_alive[s] == 0 {
        return;
    }

    let dist_sq = if ground_plane_only {
        spatial_dist_sq_to_aabb2(
            state.slot_x[s],
            state.slot_y[s],
            state.slot_aabb_hx[s],
            state.slot_aabb_hy[s],
            x,
            y,
        )
    } else {
        spatial_dist_sq_to_aabb3(
            state.slot_x[s],
            state.slot_y[s],
            state.slot_z[s],
            state.slot_aabb_hx[s],
            state.slot_aabb_hy[s],
            state.slot_aabb_hz[s],
            x,
            y,
            z,
        )
    };
    if dist_sq <= radius_sq {
        out.push(slot);
    }
}

// ===================== Query exports =====================

/// Returns the count of unit slots inside the query sphere. Slot ids
/// are written to `scratch_u32[0..count]`; JS reads via the buffer ptr.
#[wasm_bindgen]
pub fn spatial_query_units_in_radius(
    x: f64,
    y: f64,
    z: f64,
    radius: f64,
    exclude_player: u8,
    require_alive: u8,
) -> u32 {
    let state = spatial_grid();
    state.scratch_u32.clear();
    spatial_collect_cells_in_radius(state, x, y, z, radius);
    let radius_sq = radius * radius;
    let nearby = std::mem::take(&mut state.nearby_cells);
    let mut out = std::mem::take(&mut state.scratch_u32);
    for key in &nearby {
        if let Some(bucket) = state.cells.get(key) {
            for &slot in &bucket.units {
                spatial_push_unit_if_in_radius(
                    state,
                    &mut out,
                    slot,
                    x,
                    y,
                    z,
                    radius,
                    radius_sq,
                    exclude_player,
                    require_alive != 0,
                    false,
                    false,
                );
            }
        }
    }
    state.scratch_u32 = out;
    state.nearby_cells = nearby;
    state.scratch_u32.len() as u32
}

#[wasm_bindgen]
pub fn spatial_query_buildings_in_radius(
    x: f64,
    y: f64,
    z: f64,
    radius: f64,
    exclude_player: u8,
    require_alive: u8,
) -> u32 {
    let state = spatial_grid();
    state.scratch_u32.clear();
    state.dedup.clear();
    spatial_collect_cells_in_radius(state, x, y, z, radius);
    let radius_sq = radius * radius;
    let nearby = std::mem::take(&mut state.nearby_cells);
    let mut out = std::mem::take(&mut state.scratch_u32);
    let mut dedup = std::mem::take(&mut state.dedup);
    for key in &nearby {
        if let Some(bucket) = state.cells.get(key) {
            for &slot in &bucket.buildings {
                spatial_push_building_if_in_radius(
                    state,
                    &mut dedup,
                    &mut out,
                    slot,
                    x,
                    y,
                    z,
                    radius_sq,
                    exclude_player,
                    require_alive != 0,
                    false,
                );
            }
        }
    }
    state.scratch_u32 = out;
    state.nearby_cells = nearby;
    state.dedup = dedup;
    state.scratch_u32.len() as u32
}

/// Combined units + buildings inside a 3D sphere. Output layout:
///   [n_units, n_buildings, unit_slot0..n, building_slot0..m]
/// JS slices the header to get the two counts.
#[wasm_bindgen]
pub fn spatial_query_units_and_buildings_in_radius(x: f64, y: f64, z: f64, radius: f64) -> u32 {
    let state = spatial_grid();
    state.scratch_u32.clear();
    // Reserve header slots [n_units, n_buildings].
    state.scratch_u32.push(0);
    state.scratch_u32.push(0);
    state.dedup.clear();
    spatial_collect_cells_in_radius(state, x, y, z, radius);
    let radius_sq = radius * radius;
    let nearby = std::mem::take(&mut state.nearby_cells);
    let mut buf = std::mem::take(&mut state.scratch_u32);
    let header_n = 2;
    // Two passes so units come first in the buffer, then buildings.
    let unit_start = buf.len();
    for key in &nearby {
        if let Some(bucket) = state.cells.get(key) {
            for &slot in &bucket.units {
                spatial_push_unit_if_in_radius(
                    state, &mut buf, slot, x, y, z, radius, radius_sq, 0, false, false, false,
                );
            }
        }
    }
    let n_units = (buf.len() - unit_start) as u32;
    let mut dedup = std::mem::take(&mut state.dedup);
    let bldg_start = buf.len();
    for key in &nearby {
        if let Some(bucket) = state.cells.get(key) {
            for &slot in &bucket.buildings {
                spatial_push_building_if_in_radius(
                    state, &mut dedup, &mut buf, slot, x, y, z, radius_sq, 0, false, false,
                );
            }
        }
    }
    let n_buildings = (buf.len() - bldg_start) as u32;
    buf[0] = n_units;
    buf[1] = n_buildings;
    state.scratch_u32 = buf;
    state.nearby_cells = nearby;
    state.dedup = dedup;
    (header_n + n_units + n_buildings) as u32
}

#[wasm_bindgen]
pub fn spatial_query_units_and_buildings_in_rect_2d(
    min_x: f64,
    max_x: f64,
    min_y: f64,
    max_y: f64,
) -> u32 {
    let state = spatial_grid();
    state.scratch_u32.clear();
    state.scratch_u32.push(0); // header: n_units
    state.scratch_u32.push(0); // header: n_buildings
    state.dedup.clear();
    let cs = state.cell_size;
    let hcs = state.half_cell_size;
    let min_cx = (min_x / cs).floor() as i32;
    let max_cx = (max_x / cs).floor() as i32;
    let min_cy = (min_y / cs).floor() as i32;
    let max_cy = (max_y / cs).floor() as i32;
    let min_cz = ((SPATIAL_TILE_FLOOR_Y - cs + hcs) / cs).floor() as i32;
    let max_cz = ((SPATIAL_TERRAIN_MAX_RENDER_Y + cs * 2.0 + hcs) / cs).floor() as i32;
    let mut buf = std::mem::take(&mut state.scratch_u32);
    let mut dedup = std::mem::take(&mut state.dedup);
    let unit_start = buf.len();
    // Units bucket to one cell — no dedup needed.
    for cx in min_cx..=max_cx {
        for cy in min_cy..=max_cy {
            for cz in min_cz..=max_cz {
                let key = pack_contact_cell_key(cx, cy, cz);
                if let Some(bucket) = state.cells.get(&key) {
                    for &slot in &bucket.units {
                        buf.push(slot);
                    }
                }
            }
        }
    }
    let n_units = (buf.len() - unit_start) as u32;
    // Buildings span multiple cells — dedup.
    let bldg_start = buf.len();
    for cx in min_cx..=max_cx {
        for cy in min_cy..=max_cy {
            for cz in min_cz..=max_cz {
                let key = pack_contact_cell_key(cx, cy, cz);
                if let Some(bucket) = state.cells.get(&key) {
                    for &slot in &bucket.buildings {
                        if dedup.insert(slot) {
                            buf.push(slot);
                        }
                    }
                }
            }
        }
    }
    let n_buildings = (buf.len() - bldg_start) as u32;
    buf[0] = n_units;
    buf[1] = n_buildings;
    state.scratch_u32 = buf;
    state.dedup = dedup;
    (2 + n_units + n_buildings) as u32
}

#[wasm_bindgen]
pub fn spatial_query_enemy_entities_in_radius(
    x: f64,
    y: f64,
    z: f64,
    radius: f64,
    exclude_player: u8,
) -> u32 {
    let state = spatial_grid();
    state.scratch_u32.clear();
    state.scratch_u32.push(0); // n_units
    state.scratch_u32.push(0); // n_buildings
    state.dedup.clear();
    // Pad cell search by max shot radius — matches JS impl.
    spatial_collect_cells_in_radius(state, x, y, z, radius + SPATIAL_MAX_UNIT_SHOT_RADIUS);
    let radius_sq = radius * radius;
    let nearby = std::mem::take(&mut state.nearby_cells);
    let mut buf = std::mem::take(&mut state.scratch_u32);
    let mut dedup = std::mem::take(&mut state.dedup);
    let unit_start = buf.len();
    for key in &nearby {
        if let Some(bucket) = state.cells.get(key) {
            for &slot in &bucket.units {
                spatial_push_unit_if_in_radius(
                    state,
                    &mut buf,
                    slot,
                    x,
                    y,
                    z,
                    radius,
                    radius_sq,
                    exclude_player,
                    true,
                    true,
                    false,
                );
            }
        }
    }
    let n_units = (buf.len() - unit_start) as u32;
    let bldg_start = buf.len();
    for key in &nearby {
        if let Some(bucket) = state.cells.get(key) {
            for &slot in &bucket.buildings {
                spatial_push_building_if_in_radius(
                    state,
                    &mut dedup,
                    &mut buf,
                    slot,
                    x,
                    y,
                    z,
                    radius_sq,
                    exclude_player,
                    true,
                    false,
                );
            }
        }
    }
    let n_buildings = (buf.len() - bldg_start) as u32;
    buf[0] = n_units;
    buf[1] = n_buildings;
    state.scratch_u32 = buf;
    state.nearby_cells = nearby;
    state.dedup = dedup;
    (2 + n_units + n_buildings) as u32
}

#[wasm_bindgen]
pub fn spatial_query_enemy_entities_in_circle_2d(
    x: f64,
    y: f64,
    radius: f64,
    exclude_player: u8,
    z_min: f64,
    z_max: f64,
) -> u32 {
    let state = spatial_grid();
    state.scratch_u32.clear();
    state.scratch_u32.push(0);
    state.scratch_u32.push(0);
    state.dedup.clear();
    spatial_collect_cells_in_circle2d(
        state,
        x,
        y,
        radius + SPATIAL_MAX_UNIT_SHOT_RADIUS,
        z_min,
        z_max,
    );
    let radius_sq = radius * radius;
    let nearby = std::mem::take(&mut state.nearby_cells);
    let mut buf = std::mem::take(&mut state.scratch_u32);
    let mut dedup = std::mem::take(&mut state.dedup);
    let unit_start = buf.len();
    for key in &nearby {
        if let Some(bucket) = state.cells.get(key) {
            for &slot in &bucket.units {
                spatial_push_unit_if_in_radius(
                    state,
                    &mut buf,
                    slot,
                    x,
                    y,
                    0.0,
                    radius,
                    radius_sq,
                    exclude_player,
                    true,
                    true,
                    true,
                );
            }
        }
    }
    let n_units = (buf.len() - unit_start) as u32;
    let bldg_start = buf.len();
    for key in &nearby {
        if let Some(bucket) = state.cells.get(key) {
            for &slot in &bucket.buildings {
                spatial_push_building_if_in_radius(
                    state,
                    &mut dedup,
                    &mut buf,
                    slot,
                    x,
                    y,
                    0.0,
                    radius_sq,
                    exclude_player,
                    true,
                    true,
                );
            }
        }
    }
    let n_buildings = (buf.len() - bldg_start) as u32;
    buf[0] = n_units;
    buf[1] = n_buildings;
    state.scratch_u32 = buf;
    state.nearby_cells = nearby;
    state.dedup = dedup;
    (2 + n_units + n_buildings) as u32
}

#[wasm_bindgen]
pub fn spatial_query_units_along_line(
    x1: f64,
    y1: f64,
    z1: f64,
    x2: f64,
    y2: f64,
    z2: f64,
    line_width: f64,
) -> u32 {
    let state = spatial_grid();
    state.scratch_u32.clear();
    if !spatial_collect_cells_along_line(state, x1, y1, z1, x2, y2, z2, line_width) {
        return 0;
    }
    state.dedup.clear();
    let nearby = std::mem::take(&mut state.nearby_cells);
    let mut buf = std::mem::take(&mut state.scratch_u32);
    let mut dedup = std::mem::take(&mut state.dedup);
    for key in &nearby {
        if let Some(bucket) = state.cells.get(key) {
            for &slot in &bucket.units {
                if dedup.insert(slot) {
                    buf.push(slot);
                }
            }
        }
    }
    let count = buf.len() as u32;
    state.scratch_u32 = buf;
    state.nearby_cells = nearby;
    state.dedup = dedup;
    count
}

#[wasm_bindgen]
pub fn spatial_query_buildings_along_line(
    x1: f64,
    y1: f64,
    z1: f64,
    x2: f64,
    y2: f64,
    z2: f64,
    line_width: f64,
) -> u32 {
    let state = spatial_grid();
    state.scratch_u32.clear();
    if !spatial_collect_cells_along_line(state, x1, y1, z1, x2, y2, z2, line_width) {
        return 0;
    }
    state.dedup.clear();
    let nearby = std::mem::take(&mut state.nearby_cells);
    let mut buf = std::mem::take(&mut state.scratch_u32);
    let mut dedup = std::mem::take(&mut state.dedup);
    for key in &nearby {
        if let Some(bucket) = state.cells.get(key) {
            for &slot in &bucket.buildings {
                if dedup.insert(slot) {
                    buf.push(slot);
                }
            }
        }
    }
    let count = buf.len() as u32;
    state.scratch_u32 = buf;
    state.nearby_cells = nearby;
    state.dedup = dedup;
    count
}

#[wasm_bindgen]
pub fn spatial_query_projectiles_along_line(
    x1: f64,
    y1: f64,
    z1: f64,
    x2: f64,
    y2: f64,
    z2: f64,
    line_width: f64,
) -> u32 {
    let state = spatial_grid();
    state.scratch_u32.clear();
    if !spatial_collect_cells_along_line(state, x1, y1, z1, x2, y2, z2, line_width) {
        return 0;
    }
    state.dedup.clear();
    let nearby = std::mem::take(&mut state.nearby_cells);
    let mut buf = std::mem::take(&mut state.scratch_u32);
    let mut dedup = std::mem::take(&mut state.dedup);
    for key in &nearby {
        if let Some(bucket) = state.cells.get(key) {
            for &slot in &bucket.projectiles {
                let s = slot as usize;
                if state.slot_proj_is_projectile_type[s] == 0 {
                    continue;
                }
                if dedup.insert(slot) {
                    buf.push(slot);
                }
            }
        }
    }
    let count = buf.len() as u32;
    state.scratch_u32 = buf;
    state.nearby_cells = nearby;
    state.dedup = dedup;
    count
}

#[wasm_bindgen]
pub fn spatial_query_entities_along_line(
    x1: f64,
    y1: f64,
    z1: f64,
    x2: f64,
    y2: f64,
    z2: f64,
    line_width: f64,
) -> u32 {
    let state = spatial_grid();
    state.scratch_u32.clear();
    state.scratch_u32.push(0); // n_units
    state.scratch_u32.push(0); // n_buildings
    if !spatial_collect_cells_along_line(state, x1, y1, z1, x2, y2, z2, line_width) {
        return 2; // headers only, both zero
    }
    state.dedup.clear();
    let nearby = std::mem::take(&mut state.nearby_cells);
    let mut buf = std::mem::take(&mut state.scratch_u32);
    let mut dedup = std::mem::take(&mut state.dedup);
    // Two passes — units first, then buildings. Shared dedup so a
    // slot can only appear once across both arrays. Matches the JS
    // path which writes to two separate result arrays.
    let unit_start = buf.len();
    for key in &nearby {
        if let Some(bucket) = state.cells.get(key) {
            for &slot in &bucket.units {
                if dedup.insert(slot) {
                    buf.push(slot);
                }
            }
        }
    }
    let n_units = (buf.len() - unit_start) as u32;
    let bldg_start = buf.len();
    for key in &nearby {
        if let Some(bucket) = state.cells.get(key) {
            for &slot in &bucket.buildings {
                if dedup.insert(slot) {
                    buf.push(slot);
                }
            }
        }
    }
    let n_buildings = (buf.len() - bldg_start) as u32;
    buf[0] = n_units;
    buf[1] = n_buildings;
    state.scratch_u32 = buf;
    state.nearby_cells = nearby;
    state.dedup = dedup;
    (2 + n_units + n_buildings) as u32
}

pub(crate) const PROJECTILE_SWEEP_HIT_KIND_NONE: u8 = 0;
pub(crate) const PROJECTILE_SWEEP_HIT_KIND_UNIT: u8 = 1;
pub(crate) const PROJECTILE_SWEEP_HIT_KIND_BUILDING: u8 = 2;
pub(crate) const PROJECTILE_SWEEP_HIT_KIND_PROJECTILE: u8 = 3;

#[inline]
pub(crate) fn entity_id_in_slice(ids: &[i32], id: i32) -> bool {
    ids.iter().any(|&v| v == id)
}

#[inline]
pub(crate) fn segment_sphere_intersection_t(
    sx: f64,
    sy: f64,
    sz: f64,
    tx: f64,
    ty: f64,
    tz: f64,
    cx: f64,
    cy: f64,
    cz: f64,
    radius: f64,
) -> Option<f64> {
    let dx = tx - sx;
    let dy = ty - sy;
    let dz = tz - sz;
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
    let disc = b * b - 4.0 * a * c;
    if disc < 0.0 {
        return None;
    }
    let sqrt_disc = disc.sqrt();
    let inv_denom = 1.0 / (2.0 * a);
    let t1 = (-b - sqrt_disc) * inv_denom;
    if (0.0..=1.0).contains(&t1) {
        return Some(t1);
    }
    let t2 = (-b + sqrt_disc) * inv_denom;
    if (0.0..=1.0).contains(&t2) {
        return Some(t2);
    }
    None
}

#[inline]
pub(crate) fn ray_box_intersection_t(
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
            std::mem::swap(&mut t1, &mut t2);
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
            std::mem::swap(&mut t1, &mut t2);
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
            std::mem::swap(&mut t1, &mut t2);
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

#[inline]
pub(crate) fn projectile_sweep_hit_normal(
    hit_x: f64,
    hit_y: f64,
    hit_z: f64,
    center_x: f64,
    center_y: f64,
    center_z: f64,
    segment_dx: f64,
    segment_dy: f64,
    segment_dz: f64,
) -> (f64, f64, f64) {
    let mut nx = hit_x - center_x;
    let mut ny = hit_y - center_y;
    let mut nz = hit_z - center_z;
    let mut len_sq = nx * nx + ny * ny + nz * nz;
    if len_sq <= 1e-9 {
        nx = -segment_dx;
        ny = -segment_dy;
        nz = -segment_dz;
        len_sq = nx * nx + ny * ny + nz * nz;
    }
    if len_sq <= 1e-9 {
        return (0.0, 0.0, 1.0);
    }
    let inv = 1.0 / len_sq.sqrt();
    (nx * inv, ny * inv, nz * inv)
}

// ── Single-sweep staging (ledger [22] slice) ────────────────────────
// The collision handler calls the sweep once PER PROJECTILE per tick
// (count = 1), so the slice-taking batch export paid wasm-bindgen a
// malloc + copy for ~15 arrays per call — ~30k calls/s at a 1k-
// projectile battle. The staged variant takes the eight floats as
// plain scalars (scalars never marshal) and reads exclude ids from /
// writes the hit into WASM-resident staging that JS views directly.
/// O(1) exclude membership for the swept-hitbox kernel. Two epoch-stamped
/// id-indexed arrays replace per-candidate linear scans of the exclude list:
/// the PREFIX (accumulated removal ids, shared by every sweep of the pass,
/// re-stamped only when the removal sets grow) and the TAIL (this sweep's
/// own hit-entity ids, re-stamped per sweep). An id is excluded when either
/// stamp matches its current epoch. Epochs start at 1 so zero-initialized
/// entries never match; on u32 wrap the arrays reset to keep that true.
pub(crate) struct SweepExcludeStamps {
    prefix_stamp_by_id: Vec<u32>,
    tail_stamp_by_id: Vec<u32>,
    prefix_stamp: u32,
    tail_stamp: u32,
}

impl SweepExcludeStamps {
    #[inline]
    pub(crate) fn contains(&self, id: i32) -> bool {
        if id < 0 {
            return false;
        }
        let idx = id as usize;
        (idx < self.prefix_stamp_by_id.len()
            && self.prefix_stamp_by_id[idx] == self.prefix_stamp)
            || (idx < self.tail_stamp_by_id.len()
                && self.tail_stamp_by_id[idx] == self.tail_stamp)
    }

    fn stamp_ids(stamp_by_id: &mut Vec<u32>, stamp: &mut u32, ids: &[i32]) {
        *stamp = stamp.wrapping_add(1);
        if *stamp == 0 {
            stamp_by_id.fill(0);
            *stamp = 1;
        }
        for &id in ids {
            if id < 0 {
                continue;
            }
            let idx = id as usize;
            if idx >= stamp_by_id.len() {
                stamp_by_id.resize(idx + 1, 0);
            }
            stamp_by_id[idx] = *stamp;
        }
    }
}

pub(crate) struct HitboxSweepStaging {
    enabled: Vec<u8>,
    start_x: Vec<f64>,
    start_y: Vec<f64>,
    start_z: Vec<f64>,
    end_x: Vec<f64>,
    end_y: Vec<f64>,
    end_z: Vec<f64>,
    projectile_radius: Vec<f64>,
    exclude_entity_ids: Vec<i32>,
    removed_projectile_entity_ids: Vec<i32>,
    stamps: SweepExcludeStamps,
    prefix_count: u32,
    out_kind: Vec<u8>,
    out_slot: Vec<u32>,
    out_entity_id: Vec<i32>,
    out_t: Vec<f64>,
    out_normal: Vec<f64>,
}

pub(crate) static HITBOX_SWEEP_STAGING: WasmLazy<HitboxSweepStaging> = WasmLazy::new();

fn hitbox_sweep_staging() -> &'static mut HitboxSweepStaging {
    HITBOX_SWEEP_STAGING.get_or_init(|| HitboxSweepStaging {
        enabled: vec![1],
        start_x: vec![0.0],
        start_y: vec![0.0],
        start_z: vec![0.0],
        end_x: vec![0.0],
        end_y: vec![0.0],
        end_z: vec![0.0],
        projectile_radius: vec![0.0],
        exclude_entity_ids: Vec::new(),
        removed_projectile_entity_ids: Vec::new(),
        stamps: SweepExcludeStamps {
            prefix_stamp_by_id: Vec::new(),
            tail_stamp_by_id: Vec::new(),
            prefix_stamp: 0,
            tail_stamp: 0,
        },
        prefix_count: 0,
        out_kind: vec![0],
        out_slot: vec![0],
        out_entity_id: vec![0],
        out_t: vec![0.0],
        out_normal: vec![0.0; 3],
    })
}

/// Commit the accumulated removal-id PREFIX (already written into the
/// exclude staging array by JS) for the sweeps that follow. Called only
/// when the removal sets changed — every subsequent sweep of the pass
/// reuses these stamps for free.
#[wasm_bindgen]
pub fn projectile_hitbox_sweep_prefix_commit(prefix_count: u32) {
    let staging = hitbox_sweep_staging();
    let count = (prefix_count as usize).min(staging.exclude_entity_ids.len());
    staging.prefix_count = count as u32;
    SweepExcludeStamps::stamp_ids(
        &mut staging.stamps.prefix_stamp_by_id,
        &mut staging.stamps.prefix_stamp,
        &staging.exclude_entity_ids[..count],
    );
}

/// Grow (never shrink) the exclude-id staging arrays. Growth may move
/// them — JS re-fetches the pointers afterwards.
#[wasm_bindgen]
pub fn projectile_hitbox_sweep_staging_ensure(exclude_capacity: u32, removed_capacity: u32) {
    let staging = hitbox_sweep_staging();
    let exclude_capacity = exclude_capacity as usize;
    if staging.exclude_entity_ids.len() < exclude_capacity {
        staging.exclude_entity_ids.resize(exclude_capacity, 0);
    }
    let removed_capacity = removed_capacity as usize;
    if staging.removed_projectile_entity_ids.len() < removed_capacity {
        staging
            .removed_projectile_entity_ids
            .resize(removed_capacity, 0);
    }
}

#[wasm_bindgen]
pub fn projectile_hitbox_sweep_exclude_ids_ptr() -> *mut i32 {
    hitbox_sweep_staging().exclude_entity_ids.as_mut_ptr()
}

#[wasm_bindgen]
pub fn projectile_hitbox_sweep_removed_ids_ptr() -> *mut i32 {
    hitbox_sweep_staging().removed_projectile_entity_ids.as_mut_ptr()
}

#[wasm_bindgen]
pub fn projectile_hitbox_sweep_out_kind_ptr() -> *const u8 {
    hitbox_sweep_staging().out_kind.as_ptr()
}

#[wasm_bindgen]
pub fn projectile_hitbox_sweep_out_slot_ptr() -> *const u32 {
    hitbox_sweep_staging().out_slot.as_ptr()
}

#[wasm_bindgen]
pub fn projectile_hitbox_sweep_out_entity_id_ptr() -> *const i32 {
    hitbox_sweep_staging().out_entity_id.as_ptr()
}

#[wasm_bindgen]
pub fn projectile_hitbox_sweep_out_t_ptr() -> *const f64 {
    hitbox_sweep_staging().out_t.as_ptr()
}

#[wasm_bindgen]
pub fn projectile_hitbox_sweep_out_normal_ptr() -> *const f64 {
    hitbox_sweep_staging().out_normal.as_ptr()
}

/// One swept-hitbox query with scalar geometry and staged id lists.
/// The removal-id PREFIX is committed separately (and rarely) via
/// `projectile_hitbox_sweep_prefix_commit`; this call stamps only the
/// sweep's own TAIL ids (written by JS at `prefix_count..prefix_count +
/// tail_count`) and runs the kernel with O(1) stamp membership.
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn projectile_hitbox_sweep_single(
    sx: f64,
    sy: f64,
    sz: f64,
    ex: f64,
    ey: f64,
    ez: f64,
    projectile_radius: f64,
    tail_count: u32,
    removed_count: u32,
    max_targetable_radius: f64,
    query_extra: f64,
    current_tick: i32,
) -> u32 {
    let staging = hitbox_sweep_staging();
    let prefix_count = staging.prefix_count as usize;
    let tail_start = prefix_count.min(staging.exclude_entity_ids.len());
    let tail_end =
        (prefix_count + tail_count as usize).min(staging.exclude_entity_ids.len());
    let removed_count =
        (removed_count as usize).min(staging.removed_projectile_entity_ids.len());
    staging.start_x[0] = sx;
    staging.start_y[0] = sy;
    staging.start_z[0] = sz;
    staging.end_x[0] = ex;
    staging.end_y[0] = ey;
    staging.end_z[0] = ez;
    staging.projectile_radius[0] = projectile_radius;
    let HitboxSweepStaging {
        enabled,
        start_x,
        start_y,
        start_z,
        end_x,
        end_y,
        end_z,
        projectile_radius: radius,
        exclude_entity_ids,
        removed_projectile_entity_ids,
        stamps,
        out_kind,
        out_slot,
        out_entity_id,
        out_t,
        out_normal,
        ..
    } = staging;
    SweepExcludeStamps::stamp_ids(
        &mut stamps.tail_stamp_by_id,
        &mut stamps.tail_stamp,
        &exclude_entity_ids[tail_start..tail_end],
    );
    let (normal_x, rest) = out_normal.split_at_mut(1);
    let (normal_y, normal_z) = rest.split_at_mut(1);
    projectile_hitbox_sweep_kernel(
        1,
        enabled,
        start_x,
        start_y,
        start_z,
        end_x,
        end_y,
        end_z,
        radius,
        stamps,
        &removed_projectile_entity_ids[..removed_count],
        max_targetable_radius,
        query_extra,
        current_tick,
        out_kind,
        out_slot,
        out_entity_id,
        out_t,
        normal_x,
        normal_y,
        normal_z,
    )
}

/// C1 projectile migration — nearest swept hitbox contact for traveling
/// projectile bodies. The kernel reads the WASM spatial slab directly,
/// includes current-tick turret sub-hitboxes from the combat-targeting
/// slab, and writes one nearest hit per input sweep. Exclude membership
/// is the epoch-stamped `SweepExcludeStamps` (O(1) per candidate) rather
/// than a per-row id slice; the removed-projectile list stays a small
/// linear slice (it is a subset only consulted for projectile targets).
#[allow(clippy::too_many_arguments)]
fn projectile_hitbox_sweep_kernel(
    count: u32,
    enabled: &[u8],
    start_x: &[f64],
    start_y: &[f64],
    start_z: &[f64],
    end_x: &[f64],
    end_y: &[f64],
    end_z: &[f64],
    projectile_radius: &[f64],
    excludes: &SweepExcludeStamps,
    removed_projectile_entity_ids: &[i32],
    max_targetable_radius: f64,
    query_extra: f64,
    current_tick: i32,
    out_kind: &mut [u8],
    out_slot: &mut [u32],
    out_entity_id: &mut [i32],
    out_t: &mut [f64],
    out_normal_x: &mut [f64],
    out_normal_y: &mut [f64],
    out_normal_z: &mut [f64],
) -> u32 {
    let n = count as usize;
    if enabled.len() < n
        || start_x.len() < n
        || start_y.len() < n
        || start_z.len() < n
        || end_x.len() < n
        || end_y.len() < n
        || end_z.len() < n
        || projectile_radius.len() < n
        || out_kind.len() < n
        || out_slot.len() < n
        || out_entity_id.len() < n
        || out_t.len() < n
        || out_normal_x.len() < n
        || out_normal_y.len() < n
        || out_normal_z.len() < n
    {
        return 0;
    }

    let state = spatial_grid();
    let targeting = combat_targeting_pool();
    let mut processed = 0u32;

    for i in 0..n {
        out_kind[i] = PROJECTILE_SWEEP_HIT_KIND_NONE;
        out_slot[i] = u32::MAX;
        out_entity_id[i] = -1;
        out_t[i] = f64::INFINITY;
        out_normal_x[i] = 0.0;
        out_normal_y[i] = 0.0;
        out_normal_z[i] = 1.0;

        if enabled[i] == 0 {
            continue;
        }
        let sx = start_x[i];
        let sy = start_y[i];
        let sz = start_z[i];
        let tx = end_x[i];
        let ty = end_y[i];
        let tz = end_z[i];
        if !(sx.is_finite()
            && sy.is_finite()
            && sz.is_finite()
            && tx.is_finite()
            && ty.is_finite()
            && tz.is_finite()
            && projectile_radius[i].is_finite())
        {
            continue;
        }

        let source_radius = projectile_radius[i].max(0.0);
        let query_width =
            (source_radius + max_targetable_radius.max(0.0) + query_extra.max(0.0)) * 2.0;
        if !spatial_collect_cells_along_line(state, sx, sy, sz, tx, ty, tz, query_width) {
            continue;
        }

        let segment_dx = tx - sx;
        let segment_dy = ty - sy;
        let segment_dz = tz - sz;
        state.dedup.clear();
        let nearby = std::mem::take(&mut state.nearby_cells);
        let mut dedup = std::mem::take(&mut state.dedup);
        let mut best_t = f64::INFINITY;
        let mut best_kind = PROJECTILE_SWEEP_HIT_KIND_NONE;
        let mut best_slot = u32::MAX;
        let mut best_entity_id = -1;
        let mut best_normal_x = 0.0;
        let mut best_normal_y = 0.0;
        let mut best_normal_z = 1.0;

        for key in &nearby {
            if let Some(bucket) = state.cells.get(key) {
                for &slot in &bucket.units {
                    if !dedup.insert(slot) {
                        continue;
                    }
                    let s = slot as usize;
                    if s >= state.slot_kind.len()
                        || state.slot_kind[s] != SPATIAL_KIND_UNIT
                        || state.slot_hp_alive[s] == 0
                    {
                        continue;
                    }
                    let entity_id = state.slot_entity_id[s];
                    if excludes.contains(entity_id) {
                        continue;
                    }
                    let radius = source_radius + state.slot_radius_hitbox[s];
                    if let Some(t) = segment_sphere_intersection_t(
                        sx,
                        sy,
                        sz,
                        tx,
                        ty,
                        tz,
                        state.slot_x[s],
                        state.slot_y[s],
                        state.slot_z[s],
                        radius,
                    ) {
                        if t < best_t {
                            let hit_x = sx + t * segment_dx;
                            let hit_y = sy + t * segment_dy;
                            let hit_z = sz + t * segment_dz;
                            let (nx, ny, nz) = projectile_sweep_hit_normal(
                                hit_x,
                                hit_y,
                                hit_z,
                                state.slot_x[s],
                                state.slot_y[s],
                                state.slot_z[s],
                                segment_dx,
                                segment_dy,
                                segment_dz,
                            );
                            best_t = t;
                            best_kind = PROJECTILE_SWEEP_HIT_KIND_UNIT;
                            best_slot = slot;
                            best_entity_id = entity_id;
                            best_normal_x = nx;
                            best_normal_y = ny;
                            best_normal_z = nz;
                        }
                    }
                    if current_tick >= 0
                        && s < targeting.entity_id.len()
                        && targeting.entity_id[s] == entity_id
                        && s < targeting.turret_count_per_entity.len()
                        && s < targeting.entity_flags.len()
                        && (targeting.entity_flags[s] & CT_ENTITY_FLAG_ALIVE) != 0
                    {
                        let turret_count = (targeting.turret_count_per_entity[s] as usize)
                            .min(COMBAT_TARGETING_MAX_TURRETS_PER_ENTITY as usize);
                        let base = s * (COMBAT_TARGETING_MAX_TURRETS_PER_ENTITY as usize);
                        for turret_idx in 0..turret_count {
                            let idx = base + turret_idx;
                            if idx >= targeting.turret_entity_id.len()
                                || idx >= targeting.turret_world_pos_tick.len()
                                || idx >= targeting.turret_config_flags.len()
                                || idx >= targeting.turret_radius_hitbox.len()
                            {
                                break;
                            }
                            let turret_entity_id = targeting.turret_entity_id[idx];
                            if turret_entity_id < 0
                                || targeting.turret_world_pos_tick[idx] != current_tick
                                || (targeting.turret_config_flags[idx]
                                    & CT_TURRET_CFG_NON_ATTACK_EMITTER)
                                    != 0
                                || excludes.contains(turret_entity_id)
                            {
                                continue;
                            }
                            let radius =
                                source_radius + targeting.turret_radius_hitbox[idx].max(0.0);
                            if radius <= 0.0 {
                                continue;
                            }
                            if let Some(t) = segment_sphere_intersection_t(
                                sx,
                                sy,
                                sz,
                                tx,
                                ty,
                                tz,
                                targeting.turret_mount_x[idx],
                                targeting.turret_mount_y[idx],
                                targeting.turret_mount_z[idx],
                                radius,
                            ) {
                                if t < best_t {
                                    let hit_x = sx + t * segment_dx;
                                    let hit_y = sy + t * segment_dy;
                                    let hit_z = sz + t * segment_dz;
                                    let (nx, ny, nz) = projectile_sweep_hit_normal(
                                        hit_x,
                                        hit_y,
                                        hit_z,
                                        targeting.turret_mount_x[idx],
                                        targeting.turret_mount_y[idx],
                                        targeting.turret_mount_z[idx],
                                        segment_dx,
                                        segment_dy,
                                        segment_dz,
                                    );
                                    best_t = t;
                                    best_kind = PROJECTILE_SWEEP_HIT_KIND_UNIT;
                                    best_slot = slot;
                                    best_entity_id = entity_id;
                                    best_normal_x = nx;
                                    best_normal_y = ny;
                                    best_normal_z = nz;
                                }
                            }
                        }
                    }
                }
            }
        }

        for key in &nearby {
            if let Some(bucket) = state.cells.get(key) {
                for &slot in &bucket.buildings {
                    if !dedup.insert(slot) {
                        continue;
                    }
                    let s = slot as usize;
                    if s >= state.slot_kind.len()
                        || state.slot_kind[s] != SPATIAL_KIND_BUILDING
                        || state.slot_hp_alive[s] == 0
                    {
                        continue;
                    }
                    let entity_id = state.slot_entity_id[s];
                    if excludes.contains(entity_id) {
                        continue;
                    }
                    let hx = state.slot_aabb_hx[s] + source_radius;
                    let hy = state.slot_aabb_hy[s] + source_radius;
                    let hz = state.slot_aabb_hz[s] + source_radius;
                    if let Some(t) = ray_box_intersection_t(
                        sx,
                        sy,
                        sz,
                        tx,
                        ty,
                        tz,
                        state.slot_x[s] - hx,
                        state.slot_y[s] - hy,
                        state.slot_z[s] - hz,
                        state.slot_x[s] + hx,
                        state.slot_y[s] + hy,
                        state.slot_z[s] + hz,
                    ) {
                        if t < best_t {
                            let hit_x = sx + t * segment_dx;
                            let hit_y = sy + t * segment_dy;
                            let hit_z = sz + t * segment_dz;
                            let (nx, ny, nz) = projectile_sweep_hit_normal(
                                hit_x,
                                hit_y,
                                hit_z,
                                state.slot_x[s],
                                state.slot_y[s],
                                state.slot_z[s],
                                segment_dx,
                                segment_dy,
                                segment_dz,
                            );
                            best_t = t;
                            best_kind = PROJECTILE_SWEEP_HIT_KIND_BUILDING;
                            best_slot = slot;
                            best_entity_id = entity_id;
                            best_normal_x = nx;
                            best_normal_y = ny;
                            best_normal_z = nz;
                        }
                    }
                }
            }
        }

        for key in &nearby {
            if let Some(bucket) = state.cells.get(key) {
                for &slot in &bucket.projectiles {
                    if !dedup.insert(slot) {
                        continue;
                    }
                    let s = slot as usize;
                    if s >= state.slot_kind.len()
                        || state.slot_kind[s] != SPATIAL_KIND_PROJECTILE
                        || state.slot_proj_is_projectile_type[s] == 0
                    {
                        continue;
                    }
                    let entity_id = state.slot_entity_id[s];
                    if excludes.contains(entity_id)
                        || entity_id_in_slice(removed_projectile_entity_ids, entity_id)
                    {
                        continue;
                    }
                    let radius = source_radius + state.slot_radius_hitbox[s];
                    if radius <= 0.0 {
                        continue;
                    }
                    if let Some(t) = segment_sphere_intersection_t(
                        sx,
                        sy,
                        sz,
                        tx,
                        ty,
                        tz,
                        state.slot_x[s],
                        state.slot_y[s],
                        state.slot_z[s],
                        radius,
                    ) {
                        if t < best_t {
                            let hit_x = sx + t * segment_dx;
                            let hit_y = sy + t * segment_dy;
                            let hit_z = sz + t * segment_dz;
                            let (nx, ny, nz) = projectile_sweep_hit_normal(
                                hit_x,
                                hit_y,
                                hit_z,
                                state.slot_x[s],
                                state.slot_y[s],
                                state.slot_z[s],
                                segment_dx,
                                segment_dy,
                                segment_dz,
                            );
                            best_t = t;
                            best_kind = PROJECTILE_SWEEP_HIT_KIND_PROJECTILE;
                            best_slot = slot;
                            best_entity_id = entity_id;
                            best_normal_x = nx;
                            best_normal_y = ny;
                            best_normal_z = nz;
                        }
                    }
                }
            }
        }

        state.nearby_cells = nearby;
        state.dedup = dedup;

        if best_kind != PROJECTILE_SWEEP_HIT_KIND_NONE {
            out_kind[i] = best_kind;
            out_slot[i] = best_slot;
            out_entity_id[i] = best_entity_id;
            out_t[i] = best_t;
            out_normal_x[i] = best_normal_x;
            out_normal_y[i] = best_normal_y;
            out_normal_z[i] = best_normal_z;
        }
        processed += 1;
    }

    processed
}

#[inline]
pub(crate) fn spatial_slot_is_los_excluded(
    state: &SpatialGridState,
    slot: u32,
    source_entity_id: i32,
    target_entity_id: i32,
) -> bool {
    let s = slot as usize;
    if s >= state.slot_entity_id.len() {
        return false;
    }
    let entity_id = state.slot_entity_id[s];
    entity_id >= 0 && (entity_id == source_entity_id || entity_id == target_entity_id)
}

#[inline]
pub(crate) fn segment_intersects_sphere(
    sx: f64,
    sy: f64,
    sz: f64,
    tx: f64,
    ty: f64,
    tz: f64,
    cx: f64,
    cy: f64,
    cz: f64,
    radius: f64,
) -> bool {
    let dx = tx - sx;
    let dy = ty - sy;
    let dz = tz - sz;
    let fx = sx - cx;
    let fy = sy - cy;
    let fz = sz - cz;
    let a = dx * dx + dy * dy + dz * dz;
    if a == 0.0 {
        return false;
    }
    let b = 2.0 * (fx * dx + fy * dy + fz * dz);
    let c = fx * fx + fy * fy + fz * fz - radius * radius;
    let disc = b * b - 4.0 * a * c;
    if disc < 0.0 {
        return false;
    }
    let sqrt_disc = disc.sqrt();
    let inv_denom = 1.0 / (2.0 * a);
    let t1 = (-b - sqrt_disc) * inv_denom;
    let t2 = (-b + sqrt_disc) * inv_denom;
    (t1 >= 0.0 && t1 <= 1.0) || (t2 >= 0.0 && t2 <= 1.0)
}

#[inline]
pub(crate) fn segment_intersects_aabb(
    sx: f64,
    sy: f64,
    sz: f64,
    tx: f64,
    ty: f64,
    tz: f64,
    min_x: f64,
    min_y: f64,
    min_z: f64,
    max_x: f64,
    max_y: f64,
    max_z: f64,
) -> bool {
    let dx = tx - sx;
    let dy = ty - sy;
    let dz = tz - sz;
    let mut tmin = 0.0;
    let mut tmax = 1.0;

    if dx.abs() > 1e-9 {
        let mut t1 = (min_x - sx) / dx;
        let mut t2 = (max_x - sx) / dx;
        if t1 > t2 {
            std::mem::swap(&mut t1, &mut t2);
        }
        if t1 > tmin {
            tmin = t1;
        }
        if t2 < tmax {
            tmax = t2;
        }
    } else if sx < min_x || sx > max_x {
        return false;
    }
    if tmin > tmax {
        return false;
    }

    if dy.abs() > 1e-9 {
        let mut t1 = (min_y - sy) / dy;
        let mut t2 = (max_y - sy) / dy;
        if t1 > t2 {
            std::mem::swap(&mut t1, &mut t2);
        }
        if t1 > tmin {
            tmin = t1;
        }
        if t2 < tmax {
            tmax = t2;
        }
    } else if sy < min_y || sy > max_y {
        return false;
    }
    if tmin > tmax {
        return false;
    }

    if dz.abs() > 1e-9 {
        let mut t1 = (min_z - sz) / dz;
        let mut t2 = (max_z - sz) / dz;
        if t1 > t2 {
            std::mem::swap(&mut t1, &mut t2);
        }
        if t1 > tmin {
            tmin = t1;
        }
        if t2 < tmax {
            tmax = t2;
        }
    } else if sz < min_z || sz > max_z {
        return false;
    }
    if tmin > tmax {
        return false;
    }

    tmax >= 0.0
}

pub(crate) fn spatial_has_entity_line_of_sight(
    sx: f64,
    sy: f64,
    sz: f64,
    tx: f64,
    ty: f64,
    tz: f64,
    line_width: f64,
    source_entity_id: i32,
    target_entity_id: i32,
) -> bool {
    let state = spatial_grid();
    if !spatial_collect_cells_along_line(state, sx, sy, sz, tx, ty, tz, line_width) {
        return true;
    }

    state.dedup.clear();
    let nearby = std::mem::take(&mut state.nearby_cells);
    let mut dedup = std::mem::take(&mut state.dedup);

    for key in &nearby {
        if let Some(bucket) = state.cells.get(key) {
            for &slot in &bucket.units {
                let s = slot as usize;
                if !dedup.insert(slot) {
                    continue;
                }
                if s >= state.slot_kind.len()
                    || state.slot_kind[s] != SPATIAL_KIND_UNIT
                    || state.slot_hp_alive[s] == 0
                    || spatial_slot_is_los_excluded(state, slot, source_entity_id, target_entity_id)
                {
                    continue;
                }
                if segment_intersects_sphere(
                    sx,
                    sy,
                    sz,
                    tx,
                    ty,
                    tz,
                    state.slot_x[s],
                    state.slot_y[s],
                    state.slot_z[s],
                    state.slot_radius_collision[s],
                ) {
                    state.nearby_cells = nearby;
                    state.dedup = dedup;
                    return false;
                }
            }
        }
    }

    for key in &nearby {
        if let Some(bucket) = state.cells.get(key) {
            for &slot in &bucket.buildings {
                let s = slot as usize;
                if !dedup.insert(slot) {
                    continue;
                }
                if s >= state.slot_kind.len()
                    || state.slot_kind[s] != SPATIAL_KIND_BUILDING
                    || state.slot_hp_alive[s] == 0
                    || spatial_slot_is_los_excluded(state, slot, source_entity_id, target_entity_id)
                {
                    continue;
                }
                let hx = state.slot_aabb_hx[s];
                let hy = state.slot_aabb_hy[s];
                let hz = state.slot_aabb_hz[s];
                if segment_intersects_aabb(
                    sx,
                    sy,
                    sz,
                    tx,
                    ty,
                    tz,
                    state.slot_x[s] - hx,
                    state.slot_y[s] - hy,
                    state.slot_z[s] - hz,
                    state.slot_x[s] + hx,
                    state.slot_y[s] + hy,
                    state.slot_z[s] + hz,
                ) {
                    state.nearby_cells = nearby;
                    state.dedup = dedup;
                    return false;
                }
            }
        }
    }

    state.nearby_cells = nearby;
    state.dedup = dedup;
    true
}

/// AIM-08.LOS — full combat line-of-sight gate. One WASM dispatch
/// checks terrain first, then live unit/building blockers from the
/// spatial slab. Returns 1 when clear and 0 when any terrain sample,
/// unit collision sphere, or building AABB blocks the segment. A missing
/// terrain mesh is treated as terrain-clear; normal server/client
/// boot installs the mesh before combat ticks, and this keeps the
/// kernel usable in low-level tests that only populate blockers.
#[wasm_bindgen]
pub fn combat_has_line_of_sight(
    sx: f64,
    sy: f64,
    sz: f64,
    tx: f64,
    ty: f64,
    tz: f64,
    terrain_step_len: f64,
    entity_line_width: f64,
    source_entity_id: i32,
    target_entity_id: i32,
) -> u32 {
    if terrain_has_line_of_sight(sx, sy, sz, tx, ty, tz, terrain_step_len) == 0 {
        return 0;
    }
    if !spatial_has_entity_line_of_sight(
        sx,
        sy,
        sz,
        tx,
        ty,
        tz,
        entity_line_width,
        source_entity_id,
        target_entity_id,
    ) {
        return 0;
    }
    1
}

#[wasm_bindgen]
pub fn spatial_query_enemy_units_in_radius(
    x: f64,
    y: f64,
    z: f64,
    radius: f64,
    exclude_player: u8,
) -> u32 {
    let state = spatial_grid();
    state.scratch_u32.clear();
    spatial_collect_cells_in_radius(state, x, y, z, radius);
    let radius_sq = radius * radius;
    let nearby = std::mem::take(&mut state.nearby_cells);
    let mut buf = std::mem::take(&mut state.scratch_u32);
    for key in &nearby {
        if let Some(bucket) = state.cells.get(key) {
            for &slot in &bucket.units {
                spatial_push_unit_if_in_radius(
                    state,
                    &mut buf,
                    slot,
                    x,
                    y,
                    z,
                    radius,
                    radius_sq,
                    exclude_player,
                    false,
                    false,
                    false,
                );
            }
        }
    }
    let count = buf.len() as u32;
    state.scratch_u32 = buf;
    state.nearby_cells = nearby;
    count
}

#[wasm_bindgen]
pub fn spatial_query_enemy_projectiles_in_radius(
    x: f64,
    y: f64,
    z: f64,
    radius: f64,
    exclude_player: u8,
) -> u32 {
    let state = spatial_grid();
    state.scratch_u32.clear();
    spatial_collect_cells_in_radius(state, x, y, z, radius);
    let radius_sq = radius * radius;
    let nearby = std::mem::take(&mut state.nearby_cells);
    let mut buf = std::mem::take(&mut state.scratch_u32);
    for key in &nearby {
        if let Some(bucket) = state.cells.get(key) {
            for &slot in &bucket.projectiles {
                spatial_push_enemy_projectile_if_in_radius(
                    state,
                    &mut buf,
                    slot,
                    x,
                    y,
                    z,
                    radius_sq,
                    exclude_player,
                );
            }
        }
    }
    let count = buf.len() as u32;
    state.scratch_u32 = buf;
    state.nearby_cells = nearby;
    count
}

#[wasm_bindgen]
pub fn spatial_query_enemy_units_and_projectiles_in_radius(
    x: f64,
    y: f64,
    z: f64,
    radius: f64,
    exclude_player: u8,
) -> u32 {
    let state = spatial_grid();
    state.scratch_u32.clear();
    state.scratch_u32.push(0); // n_units
    state.scratch_u32.push(0); // n_projectiles
    spatial_collect_cells_in_radius(state, x, y, z, radius);
    let radius_sq = radius * radius;
    let nearby = std::mem::take(&mut state.nearby_cells);
    let mut buf = std::mem::take(&mut state.scratch_u32);
    let unit_start = buf.len();
    for key in &nearby {
        if let Some(bucket) = state.cells.get(key) {
            for &slot in &bucket.units {
                spatial_push_unit_if_in_radius(
                    state,
                    &mut buf,
                    slot,
                    x,
                    y,
                    z,
                    radius,
                    radius_sq,
                    exclude_player,
                    false,
                    false,
                    false,
                );
            }
        }
    }
    let n_units = (buf.len() - unit_start) as u32;
    let proj_start = buf.len();
    for key in &nearby {
        if let Some(bucket) = state.cells.get(key) {
            for &slot in &bucket.projectiles {
                spatial_push_enemy_projectile_if_in_radius(
                    state,
                    &mut buf,
                    slot,
                    x,
                    y,
                    z,
                    radius_sq,
                    exclude_player,
                );
            }
        }
    }
    let n_projectiles = (buf.len() - proj_start) as u32;
    buf[0] = n_units;
    buf[1] = n_projectiles;
    state.scratch_u32 = buf;
    state.nearby_cells = nearby;
    (2 + n_units + n_projectiles) as u32
}

// ===================== Result buffer access =====================

#[wasm_bindgen]
pub fn spatial_scratch_ptr() -> *const u32 {
    spatial_grid().scratch_u32.as_ptr()
}

#[wasm_bindgen]
pub fn spatial_scratch_len() -> u32 {
    spatial_grid().scratch_u32.len() as u32
}

// ===================== Per-slot getters (for the rare in-JS consumer) =====================

#[wasm_bindgen]
pub fn spatial_slot_kind(slot: u32) -> u8 {
    let state = spatial_grid();
    if (slot as usize) >= state.slot_kind.len() {
        return SPATIAL_KIND_UNSET;
    }
    state.slot_kind[slot as usize]
}

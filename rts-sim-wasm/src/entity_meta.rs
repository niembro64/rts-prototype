// entity_meta — extracted from lib.rs (pure code motion).

#[allow(unused_imports)]
use wasm_bindgen::prelude::*;
#[allow(unused_imports)]
use crate::*;

// ─────────────────────────────────────────────────────────────────
//  Phase 10 D.1 — Entity-meta SoA pool + runtime registry
//
//  Per-entity scalar fields the snapshot serializer reads. Position,
//  velocity, orientation, etc. already live in BodyPool / projectile
//  pool / quat orientation views. This pool covers the *snapshot-
//  only* state: HP, ownership tag, combat mode, build progress,
//  suspension kinematics, factory/solar booleans, build target
//  reference.
//
//  The snapshot fields below are cached by SpatialGrid slot for
//  hot-path reads only. Runtime identity lives in the registry rows
//  keyed by EntityId; storage slots are cached metadata and are always
//  validated through the row generation before use.
//
//  This commit ships the data layout + setters + lifecycle. JS-side
//  population (the per-tick capture from WorldState into the pool)
//  lands with D.3 alongside the quantize + delta-encode kernel that
//  reads from these fields.
//
//  Variable-length per-entity arrays (turrets, actions) are NOT in
//  this pool — they'll get their own sub-pool in D.1b when D.3
//  needs them. The fixed-scalar fields below cover everything else.
// ─────────────────────────────────────────────────────────────────

pub(crate) const ENTITY_META_TYPE_UNSET: u8 = 0;
pub(crate) const ENTITY_META_TYPE_UNIT: u8 = 1;
pub(crate) const ENTITY_META_TYPE_BUILDING: u8 = 2;
pub(crate) const ENTITY_META_TYPE_TOWER: u8 = 3;

// Wire-contract value tables mirrored by the JS stamping layer. Kept
// as the canonical reference even where no Rust branch reads a code.
pub const ENTITY_META_KIND_NONE: u8 = 0;
#[allow(dead_code)]
pub const ENTITY_META_KIND_UNIT: u8 = 1;
#[allow(dead_code)]
pub const ENTITY_META_KIND_TOWER: u8 = 2;
#[allow(dead_code)]
pub const ENTITY_META_KIND_BUILDING: u8 = 3;
#[allow(dead_code)]
pub const ENTITY_META_KIND_SHOT: u8 = 4;
#[allow(dead_code)]
pub const ENTITY_META_KIND_TURRET: u8 = 5;

pub const ENTITY_META_BLUEPRINT_KIND_NONE: u8 = 0;
#[allow(dead_code)]
pub const ENTITY_META_BLUEPRINT_KIND_UNIT: u8 = 1;
#[allow(dead_code)]
pub const ENTITY_META_BLUEPRINT_KIND_TOWER: u8 = 2;
#[allow(dead_code)]
pub const ENTITY_META_BLUEPRINT_KIND_BUILDING: u8 = 3;
#[allow(dead_code)]
pub const ENTITY_META_BLUEPRINT_KIND_TURRET: u8 = 4;
#[allow(dead_code)]
pub const ENTITY_META_BLUEPRINT_KIND_SHOT: u8 = 5;

pub const ENTITY_META_STORAGE_NONE: u8 = 0;
#[allow(dead_code)]
pub const ENTITY_META_STORAGE_ENTITIES: u8 = 1;
#[allow(dead_code)]
pub const ENTITY_META_STORAGE_COMBAT_TURRETS: u8 = 2;

pub(crate) const ENTITY_META_NO_ID: i32 = -1;
pub(crate) const ENTITY_META_NO_INDEX: i32 = -1;
pub(crate) const ENTITY_META_BLUEPRINT_CODE_NONE: u32 = u32::MAX;

#[inline]
pub(crate) fn entity_meta_storage_key(storage_pool: u8, storage_slot: u32) -> Option<u64> {
    if storage_pool == ENTITY_META_STORAGE_NONE {
        None
    } else {
        Some(((storage_pool as u64) << 32) | (storage_slot as u64))
    }
}

pub(crate) struct EntityMetaPool {
    // Slot-indexed snapshot scalars.
    pub(crate) entity_type: Vec<u8>,
    pub(crate) player_id: Vec<u8>,
    pub(crate) hp_curr: Vec<f32>,
    pub(crate) hp_max: Vec<f32>,

    // Unit-specific
    pub(crate) combat_mode: Vec<u8>,
    pub(crate) is_commander: Vec<u8>,
    pub(crate) build_complete: Vec<u8>,
    pub(crate) build_paid_energy: Vec<f32>,
    pub(crate) build_paid_metal: Vec<f32>,
    /// -1 sentinel for "no build target"; otherwise the target EntityId.
    pub(crate) build_target_id: Vec<i32>,
    pub(crate) suspension_spring_offset: Vec<f32>,
    pub(crate) suspension_spring_velocity: Vec<f32>,

    // Building-specific
    pub(crate) factory_is_producing: Vec<u8>,
    pub(crate) factory_build_queue_len: Vec<u8>,
    pub(crate) factory_progress: Vec<f32>,
    pub(crate) solar_open: Vec<u8>,
    pub(crate) build_progress: Vec<f32>,

    // EntityId-indexed runtime registry. Row index is an internal dense
    // registry row, not a storage identity.
    pub(crate) registry_entity_id: Vec<i32>,
    pub(crate) registry_kind: Vec<u8>,
    pub(crate) registry_blueprint_kind: Vec<u8>,
    pub(crate) registry_blueprint_code: Vec<u32>,
    pub(crate) registry_owner_player_id: Vec<i32>,
    pub(crate) registry_team_id: Vec<i32>,
    pub(crate) registry_parent_id: Vec<i32>,
    pub(crate) registry_root_host_id: Vec<i32>,
    pub(crate) registry_mount_index: Vec<i32>,
    pub(crate) registry_storage_pool: Vec<u8>,
    pub(crate) registry_storage_slot: Vec<u32>,
    pub(crate) registry_generation: Vec<u32>,
    pub(crate) registry_alive: Vec<u8>,
    pub(crate) registry_targetable: Vec<u8>,
    pub(crate) registry_row_by_entity_id: HashMap<i32, u32>,
    pub(crate) registry_row_by_storage: HashMap<u64, u32>,
    pub(crate) registry_free_rows: Vec<u32>,
}

impl EntityMetaPool {
    pub(crate) fn empty() -> Self {
        Self {
            entity_type: Vec::new(),
            player_id: Vec::new(),
            hp_curr: Vec::new(),
            hp_max: Vec::new(),
            combat_mode: Vec::new(),
            is_commander: Vec::new(),
            build_complete: Vec::new(),
            build_paid_energy: Vec::new(),
            build_paid_metal: Vec::new(),
            build_target_id: Vec::new(),
            suspension_spring_offset: Vec::new(),
            suspension_spring_velocity: Vec::new(),
            factory_is_producing: Vec::new(),
            factory_build_queue_len: Vec::new(),
            factory_progress: Vec::new(),
            solar_open: Vec::new(),
            build_progress: Vec::new(),
            registry_entity_id: Vec::new(),
            registry_kind: Vec::new(),
            registry_blueprint_kind: Vec::new(),
            registry_blueprint_code: Vec::new(),
            registry_owner_player_id: Vec::new(),
            registry_team_id: Vec::new(),
            registry_parent_id: Vec::new(),
            registry_root_host_id: Vec::new(),
            registry_mount_index: Vec::new(),
            registry_storage_pool: Vec::new(),
            registry_storage_slot: Vec::new(),
            registry_generation: Vec::new(),
            registry_alive: Vec::new(),
            registry_targetable: Vec::new(),
            registry_row_by_entity_id: HashMap::new(),
            registry_row_by_storage: HashMap::new(),
            registry_free_rows: Vec::new(),
        }
    }

    pub(crate) fn ensure_capacity(&mut self, slot: u32) {
        let needed = (slot as usize) + 1;
        if self.entity_type.len() >= needed {
            return;
        }
        self.entity_type.resize(needed, ENTITY_META_TYPE_UNSET);
        self.player_id.resize(needed, 0);
        self.hp_curr.resize(needed, 0.0);
        self.hp_max.resize(needed, 0.0);
        self.combat_mode.resize(needed, 0);
        self.is_commander.resize(needed, 0);
        self.build_complete.resize(needed, 0);
        self.build_paid_energy.resize(needed, 0.0);
        self.build_paid_metal.resize(needed, 0.0);
        self.build_target_id.resize(needed, -1);
        self.suspension_spring_offset.resize(needed, 0.0);
        self.suspension_spring_velocity.resize(needed, 0.0);
        self.factory_is_producing.resize(needed, 0);
        self.factory_build_queue_len.resize(needed, 0);
        self.factory_progress.resize(needed, 0.0);
        self.solar_open.resize(needed, 0);
        self.build_progress.resize(needed, 0.0);
    }

    pub(crate) fn ensure_registry_row(&mut self, row: u32) {
        let needed = (row as usize) + 1;
        if self.registry_entity_id.len() >= needed {
            return;
        }
        self.registry_entity_id.resize(needed, ENTITY_META_NO_ID);
        self.registry_kind.resize(needed, ENTITY_META_KIND_NONE);
        self.registry_blueprint_kind
            .resize(needed, ENTITY_META_BLUEPRINT_KIND_NONE);
        self.registry_blueprint_code
            .resize(needed, ENTITY_META_BLUEPRINT_CODE_NONE);
        self.registry_owner_player_id
            .resize(needed, ENTITY_META_NO_ID);
        self.registry_team_id.resize(needed, ENTITY_META_NO_ID);
        self.registry_parent_id.resize(needed, ENTITY_META_NO_ID);
        self.registry_root_host_id.resize(needed, ENTITY_META_NO_ID);
        self.registry_mount_index
            .resize(needed, ENTITY_META_NO_INDEX);
        self.registry_storage_pool
            .resize(needed, ENTITY_META_STORAGE_NONE);
        self.registry_storage_slot.resize(needed, 0);
        self.registry_generation.resize(needed, 0);
        self.registry_alive.resize(needed, 0);
        self.registry_targetable.resize(needed, 0);
    }

    pub(crate) fn unregister_registry_row(&mut self, row: u32) {
        let r = row as usize;
        if r >= self.registry_alive.len() || self.registry_alive[r] == 0 {
            return;
        }
        let old_id = self.registry_entity_id[r];
        if old_id >= 0 {
            self.registry_row_by_entity_id.remove(&old_id);
        }
        if let Some(key) =
            entity_meta_storage_key(self.registry_storage_pool[r], self.registry_storage_slot[r])
        {
            if self.registry_row_by_storage.get(&key) == Some(&row) {
                self.registry_row_by_storage.remove(&key);
            }
        }
        self.registry_alive[r] = 0;
        self.registry_targetable[r] = 0;
        self.registry_entity_id[r] = ENTITY_META_NO_ID;
        self.registry_kind[r] = ENTITY_META_KIND_NONE;
        self.registry_blueprint_kind[r] = ENTITY_META_BLUEPRINT_KIND_NONE;
        self.registry_blueprint_code[r] = ENTITY_META_BLUEPRINT_CODE_NONE;
        self.registry_owner_player_id[r] = ENTITY_META_NO_ID;
        self.registry_team_id[r] = ENTITY_META_NO_ID;
        self.registry_parent_id[r] = ENTITY_META_NO_ID;
        self.registry_root_host_id[r] = ENTITY_META_NO_ID;
        self.registry_mount_index[r] = ENTITY_META_NO_INDEX;
        self.registry_storage_pool[r] = ENTITY_META_STORAGE_NONE;
        self.registry_storage_slot[r] = 0;
        self.registry_free_rows.push(row);
    }

    pub(crate) fn clear_registry(&mut self) {
        for alive in self.registry_alive.iter_mut() {
            *alive = 0;
        }
        for targetable in self.registry_targetable.iter_mut() {
            *targetable = 0;
        }
        self.registry_row_by_entity_id.clear();
        self.registry_row_by_storage.clear();
        self.registry_free_rows.clear();
        for row in 0..self.registry_entity_id.len() {
            self.registry_free_rows.push(row as u32);
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn register(
        &mut self,
        id: i32,
        kind: u8,
        blueprint_kind: u8,
        blueprint_code: u32,
        owner_player_id: i32,
        team_id: i32,
        parent_id: i32,
        root_host_id: i32,
        mount_index: i32,
        storage_pool: u8,
        storage_slot: u32,
        targetable: u8,
    ) -> u32 {
        if id < 0 {
            return 0;
        }

        let storage_key = entity_meta_storage_key(storage_pool, storage_slot);
        if let Some(row) = self.registry_row_by_entity_id.get(&id).copied() {
            let r = row as usize;
            let old_storage_key = entity_meta_storage_key(
                self.registry_storage_pool[r],
                self.registry_storage_slot[r],
            );
            if old_storage_key != storage_key {
                if let Some(key) = old_storage_key {
                    if self.registry_row_by_storage.get(&key) == Some(&row) {
                        self.registry_row_by_storage.remove(&key);
                    }
                }
            }
            if let Some(key) = storage_key {
                if let Some(other_row) = self.registry_row_by_storage.get(&key).copied() {
                    if other_row != row {
                        self.unregister_registry_row(other_row);
                    }
                }
                self.registry_row_by_storage.insert(key, row);
            }
            self.registry_kind[r] = kind;
            self.registry_blueprint_kind[r] = blueprint_kind;
            self.registry_blueprint_code[r] = blueprint_code;
            self.registry_owner_player_id[r] = owner_player_id;
            self.registry_team_id[r] = team_id;
            self.registry_parent_id[r] = parent_id;
            self.registry_root_host_id[r] = root_host_id;
            self.registry_mount_index[r] = mount_index;
            self.registry_storage_pool[r] = storage_pool;
            self.registry_storage_slot[r] = storage_slot;
            self.registry_alive[r] = 1;
            self.registry_targetable[r] = if targetable != 0 { 1 } else { 0 };
            return self.registry_generation[r];
        }

        if let Some(key) = storage_key {
            if let Some(old_row) = self.registry_row_by_storage.get(&key).copied() {
                self.unregister_registry_row(old_row);
            }
        }

        let row = match self.registry_free_rows.pop() {
            Some(row) => row,
            None => self.registry_entity_id.len() as u32,
        };
        self.ensure_registry_row(row);
        let r = row as usize;
        let generation = self.registry_generation[r].wrapping_add(1).max(1);
        self.registry_generation[r] = generation;
        self.registry_entity_id[r] = id;
        self.registry_kind[r] = kind;
        self.registry_blueprint_kind[r] = blueprint_kind;
        self.registry_blueprint_code[r] = blueprint_code;
        self.registry_owner_player_id[r] = owner_player_id;
        self.registry_team_id[r] = team_id;
        self.registry_parent_id[r] = parent_id;
        self.registry_root_host_id[r] = root_host_id;
        self.registry_mount_index[r] = mount_index;
        self.registry_storage_pool[r] = storage_pool;
        self.registry_storage_slot[r] = storage_slot;
        self.registry_alive[r] = 1;
        self.registry_targetable[r] = if targetable != 0 { 1 } else { 0 };
        self.registry_row_by_entity_id.insert(id, row);
        if let Some(key) = storage_key {
            self.registry_row_by_storage.insert(key, row);
        }
        generation
    }

    pub(crate) fn unregister_entity_id(&mut self, id: i32) {
        let Some(row) = self.registry_row_by_entity_id.get(&id).copied() else {
            return;
        };
        self.unregister_registry_row(row);
    }

    pub(crate) fn unregister_root(&mut self, root_id: i32) {
        if root_id < 0 {
            return;
        }
        let rows = self
            .registry_entity_id
            .iter()
            .enumerate()
            .filter_map(|(row, &id)| {
                if self.registry_alive[row] != 0
                    && (id == root_id || self.registry_root_host_id[row] == root_id)
                {
                    Some(row as u32)
                } else {
                    None
                }
            })
            .collect::<Vec<_>>();
        for row in rows {
            self.unregister_registry_row(row);
        }
    }

    pub(crate) fn resolve_row(&self, id: i32, generation: u32) -> i32 {
        if id < 0 || generation == 0 {
            return -1;
        }
        let Some(row) = self.registry_row_by_entity_id.get(&id).copied() else {
            return -1;
        };
        let r = row as usize;
        if r >= self.registry_alive.len()
            || self.registry_alive[r] == 0
            || self.registry_generation[r] != generation
        {
            -1
        } else {
            row as i32
        }
    }

    pub(crate) fn unset_slot(&mut self, slot: u32) {
        let s = slot as usize;
        if s >= self.entity_type.len() {
            return;
        }
        self.entity_type[s] = ENTITY_META_TYPE_UNSET;
        self.player_id[s] = 0;
        self.hp_curr[s] = 0.0;
        self.hp_max[s] = 0.0;
        self.combat_mode[s] = 0;
        self.is_commander[s] = 0;
        self.build_complete[s] = 0;
        self.build_paid_energy[s] = 0.0;
        self.build_paid_metal[s] = 0.0;
        self.build_target_id[s] = -1;
        self.suspension_spring_offset[s] = 0.0;
        self.suspension_spring_velocity[s] = 0.0;
        self.factory_is_producing[s] = 0;
        self.factory_build_queue_len[s] = 0;
        self.factory_progress[s] = 0.0;
        self.solar_open[s] = 0;
        self.build_progress[s] = 0.0;
    }
}

pub(crate) struct EntityMetaHolder(UnsafeCell<Option<EntityMetaPool>>);
unsafe impl Sync for EntityMetaHolder {}
pub(crate) static ENTITY_META: EntityMetaHolder = EntityMetaHolder(UnsafeCell::new(None));

#[inline]
pub(crate) fn entity_meta_pool() -> &'static mut EntityMetaPool {
    unsafe {
        let cell = &mut *ENTITY_META.0.get();
        if cell.is_none() {
            *cell = Some(EntityMetaPool::empty());
        }
        cell.as_mut().unwrap()
    }
}

#[wasm_bindgen]
pub fn entity_meta_init(initial_capacity: u32) {
    let pool = entity_meta_pool();
    pool.ensure_capacity(initial_capacity);
    // Reset slot tags so a re-init drops stale state.
    for k in pool.entity_type.iter_mut() {
        *k = ENTITY_META_TYPE_UNSET;
    }
    pool.clear_registry();
}

#[wasm_bindgen]
pub fn entity_meta_clear() {
    let pool = entity_meta_pool();
    for k in pool.entity_type.iter_mut() {
        *k = ENTITY_META_TYPE_UNSET;
    }
    // Other fields stay at their resize-defaults; tag check gates
    // any future read.
    pool.clear_registry();
}

/// Register or refresh one runtime EntityId metadata row. Null-ish
/// ids use -1 for owner/team/parent/root/mount. Returns the row's
/// generation; callers store (id, generation) for stale-ref checks.
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn entity_meta_register(
    id: i32,
    kind: u8,
    blueprint_kind: u8,
    blueprint_code: u32,
    owner_player_id: i32,
    team_id: i32,
    parent_id: i32,
    root_host_id: i32,
    mount_index: i32,
    storage_pool: u8,
    storage_slot: u32,
    targetable: u8,
) -> u32 {
    entity_meta_pool().register(
        id,
        kind,
        blueprint_kind,
        blueprint_code,
        owner_player_id,
        team_id,
        parent_id,
        root_host_id,
        mount_index,
        storage_pool,
        storage_slot,
        targetable,
    )
}

#[wasm_bindgen]
pub fn entity_meta_unregister(id: i32) {
    entity_meta_pool().unregister_entity_id(id);
}

#[wasm_bindgen]
pub fn entity_meta_unregister_root(root_id: i32) {
    entity_meta_pool().unregister_root(root_id);
}

#[wasm_bindgen]
pub fn entity_meta_resolve_row(id: i32, generation: u32) -> i32 {
    entity_meta_pool().resolve_row(id, generation)
}

#[wasm_bindgen]
pub fn entity_meta_generation(id: i32) -> u32 {
    let pool = entity_meta_pool();
    let Some(row) = pool.registry_row_by_entity_id.get(&id).copied() else {
        return 0;
    };
    let r = row as usize;
    if r >= pool.registry_generation.len() || pool.registry_alive[r] == 0 {
        0
    } else {
        pool.registry_generation[r]
    }
}

#[wasm_bindgen]
pub fn entity_meta_resolve_storage_slot(id: i32, generation: u32) -> i32 {
    let pool = entity_meta_pool();
    let row = pool.resolve_row(id, generation);
    if row < 0 {
        return -1;
    }
    pool.registry_storage_slot[row as usize] as i32
}

/// Bulk per-unit setter. JS calls this once per dirty unit per
/// snapshot tick (D.3 will wire it). All unit-specific scalar
/// fields land in one call to amortise boundary overhead. Building-
/// only fields are left at their previous value; the entity_type
/// tag gates which fields a reader trusts.
#[wasm_bindgen]
pub fn entity_meta_set_unit(
    slot: u32,
    player_id: u8,
    hp_curr: f32,
    hp_max: f32,
    combat_mode: u8,
    is_commander: u8,
    build_complete: u8,
    build_paid_energy: f32,
    build_paid_metal: f32,
    build_target_id: i32,
    suspension_spring_offset: f32,
    suspension_spring_velocity: f32,
    build_progress: f32,
) {
    let pool = entity_meta_pool();
    pool.ensure_capacity(slot);
    let s = slot as usize;
    pool.entity_type[s] = ENTITY_META_TYPE_UNIT;
    pool.player_id[s] = player_id;
    pool.hp_curr[s] = hp_curr;
    pool.hp_max[s] = hp_max;
    pool.combat_mode[s] = combat_mode;
    pool.is_commander[s] = is_commander;
    pool.build_complete[s] = build_complete;
    pool.build_paid_energy[s] = build_paid_energy;
    pool.build_paid_metal[s] = build_paid_metal;
    pool.build_target_id[s] = build_target_id;
    pool.suspension_spring_offset[s] = suspension_spring_offset;
    pool.suspension_spring_velocity[s] = suspension_spring_velocity;
    pool.build_progress[s] = build_progress;
}

/// Shared building/tower setter. Both entity types share the static
/// wire shape (hp + optional combat + optional factory + optional
/// active state), differing only in the EntityType tag. The exported
/// wasm wrappers below stamp the right tag and forward.
#[inline]
pub(crate) fn entity_meta_set_static(
    slot: u32,
    type_tag: u8,
    player_id: u8,
    hp_curr: f32,
    hp_max: f32,
    factory_is_producing: u8,
    factory_build_queue_len: u8,
    factory_progress: f32,
    solar_open: u8,
    build_progress: f32,
) {
    let pool = entity_meta_pool();
    pool.ensure_capacity(slot);
    let s = slot as usize;
    pool.entity_type[s] = type_tag;
    pool.player_id[s] = player_id;
    pool.hp_curr[s] = hp_curr;
    pool.hp_max[s] = hp_max;
    pool.factory_is_producing[s] = factory_is_producing;
    pool.factory_build_queue_len[s] = factory_build_queue_len;
    pool.factory_progress[s] = factory_progress;
    pool.solar_open[s] = solar_open;
    pool.build_progress[s] = build_progress;
}

/// Bulk per-building setter. Building-only fields, plus the shared
/// HP and player_id.
#[wasm_bindgen]
pub fn entity_meta_set_building(
    slot: u32,
    player_id: u8,
    hp_curr: f32,
    hp_max: f32,
    factory_is_producing: u8,
    factory_build_queue_len: u8,
    factory_progress: f32,
    solar_open: u8,
    build_progress: f32,
) {
    entity_meta_set_static(
        slot,
        ENTITY_META_TYPE_BUILDING,
        player_id,
        hp_curr,
        hp_max,
        factory_is_producing,
        factory_build_queue_len,
        factory_progress,
        solar_open,
        build_progress,
    );
}

/// Bulk per-tower setter. Towers share the static wire shape with
/// buildings; the only difference is the EntityType tag. The
/// fabricator's factory progress / queue rides on the same factory_*
/// fields buildings use (fabricator is a tower that mounts a factory
/// component). solar_open is unused for towers and should be passed as
/// 0 / 1 consistently to avoid producing spurious snapshot diffs.
#[wasm_bindgen]
pub fn entity_meta_set_tower(
    slot: u32,
    player_id: u8,
    hp_curr: f32,
    hp_max: f32,
    factory_is_producing: u8,
    factory_build_queue_len: u8,
    factory_progress: f32,
    solar_open: u8,
    build_progress: f32,
) {
    entity_meta_set_static(
        slot,
        ENTITY_META_TYPE_TOWER,
        player_id,
        hp_curr,
        hp_max,
        factory_is_producing,
        factory_build_queue_len,
        factory_progress,
        solar_open,
        build_progress,
    );
}

#[wasm_bindgen]
pub fn entity_meta_unset(slot: u32) {
    entity_meta_pool().unset_slot(slot);
}

#[wasm_bindgen]
pub fn entity_meta_type(slot: u32) -> u8 {
    let pool = entity_meta_pool();
    if (slot as usize) >= pool.entity_type.len() {
        return ENTITY_META_TYPE_UNSET;
    }
    pool.entity_type[slot as usize]
}

// Field-pointer exports — JS builds typed-array views once and reads
// per-slot. Same pattern as BodyPool / ProjectilePool. Per-slot
// access is JIT-fast through the views; bulk reads of N slots are
// O(N) without WASM boundary crossings.

macro_rules! entity_meta_ptr_export {
    ($name:ident, $field:ident, $ty:ty) => {
        #[wasm_bindgen]
        pub fn $name() -> *const $ty {
            entity_meta_pool().$field.as_ptr()
        }
    };
}

entity_meta_ptr_export!(entity_meta_type_ptr, entity_type, u8);
entity_meta_ptr_export!(entity_meta_player_id_ptr, player_id, u8);
entity_meta_ptr_export!(entity_meta_hp_curr_ptr, hp_curr, f32);
entity_meta_ptr_export!(entity_meta_hp_max_ptr, hp_max, f32);
entity_meta_ptr_export!(entity_meta_combat_mode_ptr, combat_mode, u8);
entity_meta_ptr_export!(entity_meta_is_commander_ptr, is_commander, u8);
entity_meta_ptr_export!(entity_meta_build_complete_ptr, build_complete, u8);
entity_meta_ptr_export!(entity_meta_build_paid_energy_ptr, build_paid_energy, f32);
entity_meta_ptr_export!(entity_meta_build_paid_metal_ptr, build_paid_metal, f32);
entity_meta_ptr_export!(entity_meta_build_target_id_ptr, build_target_id, i32);
entity_meta_ptr_export!(
    entity_meta_suspension_spring_offset_ptr,
    suspension_spring_offset,
    f32
);
entity_meta_ptr_export!(
    entity_meta_suspension_spring_velocity_ptr,
    suspension_spring_velocity,
    f32
);
entity_meta_ptr_export!(
    entity_meta_factory_is_producing_ptr,
    factory_is_producing,
    u8
);
entity_meta_ptr_export!(
    entity_meta_factory_build_queue_len_ptr,
    factory_build_queue_len,
    u8
);
entity_meta_ptr_export!(entity_meta_factory_progress_ptr, factory_progress, f32);
entity_meta_ptr_export!(entity_meta_solar_open_ptr, solar_open, u8);
entity_meta_ptr_export!(entity_meta_build_progress_ptr, build_progress, f32);

#[wasm_bindgen]
pub fn entity_meta_capacity() -> u32 {
    entity_meta_pool().entity_type.len() as u32
}

entity_meta_ptr_export!(entity_meta_registry_entity_id_ptr, registry_entity_id, i32);
entity_meta_ptr_export!(entity_meta_registry_kind_ptr, registry_kind, u8);
entity_meta_ptr_export!(
    entity_meta_registry_blueprint_kind_ptr,
    registry_blueprint_kind,
    u8
);
entity_meta_ptr_export!(
    entity_meta_registry_blueprint_code_ptr,
    registry_blueprint_code,
    u32
);
entity_meta_ptr_export!(
    entity_meta_registry_owner_player_id_ptr,
    registry_owner_player_id,
    i32
);
entity_meta_ptr_export!(entity_meta_registry_team_id_ptr, registry_team_id, i32);
entity_meta_ptr_export!(entity_meta_registry_parent_id_ptr, registry_parent_id, i32);
entity_meta_ptr_export!(
    entity_meta_registry_root_host_id_ptr,
    registry_root_host_id,
    i32
);
entity_meta_ptr_export!(
    entity_meta_registry_mount_index_ptr,
    registry_mount_index,
    i32
);
entity_meta_ptr_export!(
    entity_meta_registry_storage_pool_ptr,
    registry_storage_pool,
    u8
);
entity_meta_ptr_export!(
    entity_meta_registry_storage_slot_ptr,
    registry_storage_slot,
    u32
);
entity_meta_ptr_export!(
    entity_meta_registry_generation_ptr,
    registry_generation,
    u32
);
entity_meta_ptr_export!(entity_meta_registry_alive_ptr, registry_alive, u8);
entity_meta_ptr_export!(entity_meta_registry_targetable_ptr, registry_targetable, u8);

#[wasm_bindgen]
pub fn entity_meta_registry_capacity() -> u32 {
    entity_meta_pool().registry_entity_id.len() as u32
}

// ─────────────────────────────────────────────────────────────────
//  Phase 10 D.1b — Turret sub-pool
//
//  Each entity can have up to MAX_TURRETS_PER_ENTITY = 8 turrets
//  (matches MAX_WEAPONS_PER_ENTITY in stateSerializerEntities.ts).
//  Per-turret state lives at index `entity_slot * MAX + turret_idx`
//  in a flat SoA. Per-entity turret count gates which indices are
//  live. Indexes for inactive slots stay at their defaults; consumers
//  only read the first `count` entries for an entity.
//
//  Fields cover the snapshot turret DTO: rotation, angularVelocity,
//  angularAcceleration, pitch, pitchVelocity, pitchAcceleration,
//  shieldRange, plus a target_id reference (-1 = none).
//
//  Variable-length action sub-pool is a follow-up (D.1c) — action
//  ActionType is a JS string enum that needs a stable u8 mapping
//  before it can be ported.
// ─────────────────────────────────────────────────────────────────

pub const TURRET_POOL_MAX_PER_ENTITY: u32 = 8;

pub(crate) struct TurretPool {
    // count_per_entity[i] = number of turrets used by entity slot i.
    pub(crate) count_per_entity: Vec<u8>,
    // Per-turret state, indexed by (entity_slot * MAX + turret_idx).
    pub(crate) entity_id: Vec<i32>,
    pub(crate) parent_id: Vec<i32>,
    pub(crate) root_host_id: Vec<i32>,
    pub(crate) mount_index: Vec<i32>,
    pub(crate) rotation: Vec<f32>,
    pub(crate) angular_velocity: Vec<f32>,
    pub(crate) angular_acceleration: Vec<f32>,
    pub(crate) pitch: Vec<f32>,
    pub(crate) pitch_velocity: Vec<f32>,
    pub(crate) pitch_acceleration: Vec<f32>,
    pub(crate) shield_range: Vec<f32>,
    pub(crate) target_id: Vec<i32>,
}

impl TurretPool {
    pub(crate) fn empty() -> Self {
        Self {
            count_per_entity: Vec::new(),
            entity_id: Vec::new(),
            parent_id: Vec::new(),
            root_host_id: Vec::new(),
            mount_index: Vec::new(),
            rotation: Vec::new(),
            angular_velocity: Vec::new(),
            angular_acceleration: Vec::new(),
            pitch: Vec::new(),
            pitch_velocity: Vec::new(),
            pitch_acceleration: Vec::new(),
            shield_range: Vec::new(),
            target_id: Vec::new(),
        }
    }

    pub(crate) fn ensure_entity_capacity(&mut self, entity_slot: u32) {
        let entity_needed = (entity_slot as usize) + 1;
        if self.count_per_entity.len() < entity_needed {
            self.count_per_entity.resize(entity_needed, 0);
        }
        let turret_needed = entity_needed * (TURRET_POOL_MAX_PER_ENTITY as usize);
        if self.rotation.len() < turret_needed {
            self.entity_id.resize(turret_needed, ENTITY_META_NO_ID);
            self.parent_id.resize(turret_needed, ENTITY_META_NO_ID);
            self.root_host_id.resize(turret_needed, ENTITY_META_NO_ID);
            self.mount_index.resize(turret_needed, ENTITY_META_NO_INDEX);
            self.rotation.resize(turret_needed, 0.0);
            self.angular_velocity.resize(turret_needed, 0.0);
            self.angular_acceleration.resize(turret_needed, 0.0);
            self.pitch.resize(turret_needed, 0.0);
            self.pitch_velocity.resize(turret_needed, 0.0);
            self.pitch_acceleration.resize(turret_needed, 0.0);
            self.shield_range.resize(turret_needed, 0.0);
            self.target_id.resize(turret_needed, -1);
        }
    }

    pub(crate) fn unset_entity(&mut self, entity_slot: u32) {
        let s = entity_slot as usize;
        if s >= self.count_per_entity.len() {
            return;
        }
        self.count_per_entity[s] = 0;
        let base = s * (TURRET_POOL_MAX_PER_ENTITY as usize);
        for t in 0..(TURRET_POOL_MAX_PER_ENTITY as usize) {
            let idx = base + t;
            if idx >= self.entity_id.len() {
                break;
            }
            self.entity_id[idx] = ENTITY_META_NO_ID;
            self.parent_id[idx] = ENTITY_META_NO_ID;
            self.root_host_id[idx] = ENTITY_META_NO_ID;
            self.mount_index[idx] = ENTITY_META_NO_INDEX;
        }
        // Other per-turret fields stay at last value; consumers gate on count.
    }
}

pub(crate) struct TurretPoolHolder(UnsafeCell<Option<TurretPool>>);
unsafe impl Sync for TurretPoolHolder {}
pub(crate) static TURRET_POOL: TurretPoolHolder = TurretPoolHolder(UnsafeCell::new(None));

#[inline]
pub(crate) fn turret_pool() -> &'static mut TurretPool {
    unsafe {
        let cell = &mut *TURRET_POOL.0.get();
        if cell.is_none() {
            *cell = Some(TurretPool::empty());
        }
        cell.as_mut().unwrap()
    }
}

#[wasm_bindgen]
pub fn turret_pool_init(initial_entity_capacity: u32) {
    let pool = turret_pool();
    pool.ensure_entity_capacity(initial_entity_capacity);
    for c in pool.count_per_entity.iter_mut() {
        *c = 0;
    }
}

#[wasm_bindgen]
pub fn turret_pool_clear() {
    let pool = turret_pool();
    for c in pool.count_per_entity.iter_mut() {
        *c = 0;
    }
}

#[wasm_bindgen]
pub fn turret_pool_max_per_entity() -> u32 {
    TURRET_POOL_MAX_PER_ENTITY
}

/// Set the number of live turrets for an entity. Caller is responsible
/// for calling turret_pool_set_turret for each of the first `count`
/// turret indices. Counts past TURRET_POOL_MAX_PER_ENTITY are clamped.
#[wasm_bindgen]
pub fn turret_pool_set_count(entity_slot: u32, count: u8) {
    let pool = turret_pool();
    pool.ensure_entity_capacity(entity_slot);
    let max = TURRET_POOL_MAX_PER_ENTITY as u8;
    let clamped = if count > max { max } else { count };
    let s = entity_slot as usize;
    let previous = pool.count_per_entity[s];
    if clamped < previous {
        let base = s * (TURRET_POOL_MAX_PER_ENTITY as usize);
        for t in (clamped as usize)..(previous as usize) {
            let idx = base + t;
            pool.entity_id[idx] = ENTITY_META_NO_ID;
            pool.parent_id[idx] = ENTITY_META_NO_ID;
            pool.root_host_id[idx] = ENTITY_META_NO_ID;
            pool.mount_index[idx] = ENTITY_META_NO_INDEX;
        }
    }
    pool.count_per_entity[entity_slot as usize] = clamped;
}

/// Bulk per-turret setter. `target_id` of -1 means "no target".
#[wasm_bindgen]
pub fn turret_pool_set_turret(
    entity_slot: u32,
    turret_idx: u32,
    entity_id: i32,
    parent_id: i32,
    root_host_id: i32,
    mount_index: i32,
    rotation: f32,
    angular_velocity: f32,
    angular_acceleration: f32,
    pitch: f32,
    pitch_velocity: f32,
    pitch_acceleration: f32,
    shield_range: f32,
    target_id: i32,
) {
    let pool = turret_pool();
    pool.ensure_entity_capacity(entity_slot);
    debug_assert!(turret_idx < TURRET_POOL_MAX_PER_ENTITY);
    let global_idx =
        (entity_slot as usize) * (TURRET_POOL_MAX_PER_ENTITY as usize) + (turret_idx as usize);
    pool.entity_id[global_idx] = entity_id;
    pool.parent_id[global_idx] = parent_id;
    pool.root_host_id[global_idx] = root_host_id;
    pool.mount_index[global_idx] = mount_index;
    pool.rotation[global_idx] = rotation;
    pool.angular_velocity[global_idx] = angular_velocity;
    pool.angular_acceleration[global_idx] = angular_acceleration;
    pool.pitch[global_idx] = pitch;
    pool.pitch_velocity[global_idx] = pitch_velocity;
    pool.pitch_acceleration[global_idx] = pitch_acceleration;
    pool.shield_range[global_idx] = shield_range;
    pool.target_id[global_idx] = target_id;
}

#[wasm_bindgen]
pub fn turret_pool_unset_entity(entity_slot: u32) {
    turret_pool().unset_entity(entity_slot);
}

#[wasm_bindgen]
pub fn turret_pool_count(entity_slot: u32) -> u8 {
    let pool = turret_pool();
    if (entity_slot as usize) >= pool.count_per_entity.len() {
        return 0;
    }
    pool.count_per_entity[entity_slot as usize]
}

macro_rules! turret_pool_ptr_export {
    ($name:ident, $field:ident, $ty:ty) => {
        #[wasm_bindgen]
        pub fn $name() -> *const $ty {
            turret_pool().$field.as_ptr()
        }
    };
}

turret_pool_ptr_export!(turret_pool_count_per_entity_ptr, count_per_entity, u8);
turret_pool_ptr_export!(turret_pool_entity_id_ptr, entity_id, i32);
turret_pool_ptr_export!(turret_pool_parent_id_ptr, parent_id, i32);
turret_pool_ptr_export!(turret_pool_root_host_id_ptr, root_host_id, i32);
turret_pool_ptr_export!(turret_pool_mount_index_ptr, mount_index, i32);
turret_pool_ptr_export!(turret_pool_rotation_ptr, rotation, f32);
turret_pool_ptr_export!(turret_pool_angular_velocity_ptr, angular_velocity, f32);
turret_pool_ptr_export!(
    turret_pool_angular_acceleration_ptr,
    angular_acceleration,
    f32
);
turret_pool_ptr_export!(turret_pool_pitch_ptr, pitch, f32);
turret_pool_ptr_export!(turret_pool_pitch_velocity_ptr, pitch_velocity, f32);
turret_pool_ptr_export!(turret_pool_pitch_acceleration_ptr, pitch_acceleration, f32);
turret_pool_ptr_export!(turret_pool_shield_range_ptr, shield_range, f32);
turret_pool_ptr_export!(turret_pool_target_id_ptr, target_id, i32);

#[wasm_bindgen]
pub fn turret_pool_entity_capacity() -> u32 {
    turret_pool().count_per_entity.len() as u32
}

